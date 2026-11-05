/**
 * The browser half of `dsh-repo-session-sync`.
 *
 * ## Division of responsibility
 *
 * This file is the **shell**. It owns the three things that must exist before any
 * component can render, and nothing else:
 *
 *   1. **Slot registration** — `settings.section`, so the plugin appears in
 *      Settings. The id/order/locale live here because the Host's manifest and
 *      the loader both key off them.
 *   2. **The data store** — one `StatusSnapshot` fetched from the Host's
 *      `/repo-session-sync/*` routes, with subscribe/refresh and the mutation
 *      helpers. Components never call `fetch` themselves.
 *   3. **Component mounting** — `src/ui/settings-page.js` supplies
 *      `export default function SettingsPage(props)`; this file passes it `t` and
 *      `store` and hands it to the slot.
 *
 * The page's markup, styling and interaction live in `src/ui/**`. That split
 * exists so the UI can be written and reviewed against a stable props contract
 * while the engine is still being built, and so this file stays small enough to
 * audit for one question: does it ever touch a credential or a filesystem? (It
 * does not — it can only ask the Host, and the Host's answer is the only truth
 * it renders.)
 *
 * ## Why no credential ever appears here
 *
 * Nothing in this file reads, stores, or forwards a token. Authentication for the
 * remote is whatever the user's own `git` already uses, and it happens entirely
 * in the Host process. The browser can request a sync; it can never perform one.
 *
 * @module dsh-repo-session-sync/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-repo-session-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * Report a degraded path once per key, with context.
     *
     * Degrading silently is the most expensive failure mode this plugin has: the
     * panel renders, nothing errors, and the reason is invisible. A single
     * rate-limited warning turns that into something diagnosable without letting
     * a render loop flood the console.
     *
     * @param {string} key - Stable dedupe key.
     * @param {string} message - What went wrong and what the user will see.
     * @param {unknown} [error] - Original error, for its message and stack.
     * @returns {void}
     */
    function warnOnce(key, message, error) {
      if (warnOnce.seen.has(key)) return
      warnOnce.seen.add(key)
      console.warn(`[dsh-repo-session-sync] ${message}`, error instanceof Error ? error.message : (error ?? ''))
    }
    warnOnce.seen = new Set()

    /** Locale namespace; matches `locale/*.json` and the package name. */
    const NS = 'dsh-repo-session-sync'

    /** Route prefix owned by the Host half. */
    const PREFIX = '/repo-session-sync'

    /** Slot id. Also used as the nav entry id. */
    const SECTION_ID = 'repo-session-sync'

    /**
     * Slot order. `dsh-settings-sync` occupies 16, so this sits right after the
     * plugin it is most likely to be confused with.
     */
    const SECTION_ORDER = 17

    /** How long a `/status` snapshot is reused before a refetch (ms). */
    const STATUS_FRESH_MS = 1500

    /** Deadline for one `/status` request, so a wedged Host can be retried (ms). */
    const STATUS_TIMEOUT_MS = 20_000

    /**
     * Call one Host route.
     *
     * Always resolves — never rejects — with the plugin's result envelope, so a
     * component can render a failure without a `try`/`catch` around every click.
     * A network failure is normalized into the same `{ ok: false, code, … }` shape
     * the Host uses; `network-error` is client-only and never produced server-side.
     *
     * @param {string} path - Path below {@link PREFIX}.
     * @param {{ method?: 'GET'|'POST', body?: unknown, signal?: AbortSignal }} [options]
     *   Request options.
     * @returns {Promise<{ ok: boolean, code?: string, message?: string, [key: string]: unknown }>}
     *   Result envelope.
     */
    async function call(path, options = {}) {
      const method = options.method ?? 'GET'
      const init = { method, headers: {}, credentials: 'same-origin' }
      if (options.signal !== undefined) init.signal = options.signal
      if (method === 'POST') {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body ?? {})
      }

      let response
      try {
        response = await fetch(`${PREFIX}${path}`, init)
      } catch (error) {
        if (error?.name === 'AbortError') {
          return { ok: false, code: 'aborted', message: '请求已取消。' }
        }
        return {
          ok: false,
          code: 'network-error',
          message: '连不上本地 DSH 宿主。',
          hint: '确认 DSH 还在运行，然后刷新页面重试。',
        }
      }

      let payload
      try {
        payload = await response.json()
      } catch {
        return {
          ok: false,
          code: 'bad-response',
          message: `宿主返回了无法解析的响应（HTTP ${response.status}）。`,
        }
      }

      if (payload === null || typeof payload !== 'object') {
        return { ok: false, code: 'bad-response', message: '宿主返回了意外的响应。' }
      }
      // The Host already encodes success/failure in the body; a 200 with
      // `ok: false` is legitimate here (a conflict report is a normal outcome),
      // so the HTTP status alone is not used to decide.
      return payload
    }

    /**
     * Build the translation function for the components.
     *
     * The fallback chain is `en` → `zh` → the key itself. Returning the key rather
     * than an empty string makes a missing translation visible in the UI instead
     * of silently rendering a blank control.
     *
     * @param {any} ctx - Client plugin context.
     * @returns {(key: string, vars?: Record<string, unknown>) => string} Translator.
     */
    function makeT(ctx) {
      return (key, vars) => {
        try {
          const text = typeof ctx?.locale?.t === 'function' ? ctx.locale.t(NS, key, vars) : undefined
          if (typeof text === 'string' && text !== '' && text !== key) return text
        } catch (error) {
          // Fall through to the raw key so the page still renders, but say so:
          // every label silently showing a raw key is otherwise undebuggable.
          warnOnce('locale-lookup', 'locale 服务不可用，设置页文案会退化为 key', error)
        }
        if (vars !== undefined && typeof vars === 'object') {
          return Object.entries(vars).reduce(
            (acc, [name, value]) => acc.split(`{${name}}`).join(String(value)),
            key,
          )
        }
        return key
      }
    }

    /**
     * One shared status snapshot, with subscribers.
     *
     * A store rather than per-component state because the section and any future
     * overlay must agree on one answer: two independent fetches would let a
     * background sync and a manual refresh disagree about whether the engine is
     * busy, and the UI would show contradictory buttons.
     *
     * @returns {{ getState: Function, subscribe: Function, refresh: Function, saveSettings: Function, bind: Function, unbind: Function, updateBinding: Function, sync: Function, dispose: Function }}
     *   The store.
     */
    function createStatusStore() {
      let snapshot = emptySnapshot()
      let fetchedAt = 0
      let inflight = null
      let disposed = false
      const listeners = new Set()

      function emit() {
        if (disposed) return
        for (const listener of [...listeners]) {
          try {
            listener(snapshot)
          } catch (error) {
            // One broken subscriber must not stop the others from updating, but a
            // throw here means a panel is not repainting — log it once.
            warnOnce('store-subscriber', '一个状态订阅者抛错，它的面板可能不再更新', error)
          }
        }
      }

      function setSnapshot(next) {
        snapshot = next
        emit()
      }

      /**
       * Fetch `/status`, coalescing concurrent callers onto one request.
       *
       * @param {{ force?: boolean }} [options] - Refresh options.
       * @returns {Promise<object>} The new snapshot.
       */
      async function refresh(options = {}) {
        const fresh = Date.now() - fetchedAt < STATUS_FRESH_MS && options.force !== true
        if (fresh) return snapshot
        if (inflight !== null) return inflight

        inflight = (async () => {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS)
          try {
            const result = await call('/status', { signal: controller.signal })
            fetchedAt = Date.now()
            setSnapshot(normalizeStatus(result))
            return snapshot
          } finally {
            clearTimeout(timer)
            inflight = null
          }
        })()

        return inflight
      }

      /**
       * Run a mutation and then refresh, so the UI never shows stale state.
       *
       * @param {() => Promise<object>} mutate - Host call.
       * @returns {Promise<object>} The mutation result.
       */
      async function mutateThenRefresh(mutate) {
        const result = await mutate()
        fetchedAt = 0
        // Refresh even after a failure: a failed bind may still have changed the
        // table (a replaced row), and showing the old table would be a lie.
        await refresh({ force: true }).catch(() => {})
        return result
      }

      return {
        /** @returns {object} Current snapshot. */
        getState: () => snapshot,
        /**
         * @param {(snapshot: object) => void} listener - Called on every change.
         * @returns {() => void} Unsubscribe.
         */
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        refresh,
        /**
         * @param {object} patch - Settings fields.
         * @returns {Promise<object>} Host result.
         */
        saveSettings: (patch) => mutateThenRefresh(() => call('/settings', { method: 'POST', body: patch })),
        /**
         * @param {object} input - Binding facts.
         * @returns {Promise<object>} Host result.
         */
        bind: (input) => mutateThenRefresh(() => call('/bind', { method: 'POST', body: input })),
        /**
         * @param {string} repoId - Binding id.
         * @returns {Promise<object>} Host result.
         */
        unbind: (repoId) => mutateThenRefresh(() => call('/unbind', { method: 'POST', body: { repoId } })),
        /**
         * @param {object} patch - Binding fields plus `repoId`.
         * @returns {Promise<object>} Host result.
         */
        updateBinding: (patch) => mutateThenRefresh(() => call('/binding', { method: 'POST', body: patch })),
        /**
         * @param {{ repoId: string, action: 'up'|'down'|'both', dryRun?: boolean }} request
         *   Sync request.
         * @returns {Promise<object>} Host result.
         */
        sync: (request) => mutateThenRefresh(() => call('/sync', { method: 'POST', body: request })),
        dispose() {
          disposed = true
          listeners.clear()
        },
      }
    }

    /**
     * An empty snapshot, so a component can render before the first fetch.
     *
     * Every field the contract promises is present: a component must never have
     * to guard for `undefined` on a top-level key.
     *
     * @returns {object} Empty snapshot.
     */
    function emptySnapshot() {
      return {
        ok: true,
        repos: [],
        dropped: [],
        settings: {
          defaultDirection: 'both',
          defaultTransport: 'git-branch',
          autoSync: false,
          autoSyncIntervalMs: 0,
          promptVersion: 0,
          updatedAt: 0,
        },
        paths: {},
        seams: { sessions: false, transport: false, conflicts: false },
        busy: false,
        busyOperation: null,
        plugin: { name: 'dsh-repo-session-sync', version: '0.0.0' },
        loaded: false,
      }
    }

    /**
     * Coerce a Host response into the snapshot shape the UI is promised.
     *
     * A malformed field becomes its safe default rather than reaching a component
     * as `undefined`. This is the one place that decides what a missing value
     * means, so components stay simple.
     *
     * @param {any} result - Raw `/status` response.
     * @returns {object} Normalized snapshot.
     */
    function normalizeStatus(result) {
      const base = emptySnapshot()
      if (result === null || typeof result !== 'object') {
        return {
          ...base,
          ok: false,
          code: 'bad-response',
          message: '宿主返回了意外的状态。',
        }
      }

      const repos = Array.isArray(result.repos)
        ? result.repos.filter((row) => row !== null && typeof row === 'object').map(normalizeRepo)
        : []
      const settings = result.settings !== null && typeof result.settings === 'object'
        ? { ...base.settings, ...result.settings }
        : base.settings
      const seams = result.seams !== null && typeof result.seams === 'object'
        ? {
            sessions: result.seams.sessions === true,
            transport: result.seams.transport === true,
            conflicts: result.seams.conflicts === true,
          }
        : base.seams

      return {
        ...base,
        ...(result.ok === false ? { ok: false } : { ok: true }),
        repos,
        dropped: Array.isArray(result.dropped) ? result.dropped : [],
        settings,
        paths: result.paths !== null && typeof result.paths === 'object' ? result.paths : {},
        seams,
        busy: result.busy === true,
        busyOperation: typeof result.busyOperation === 'string' ? result.busyOperation : null,
        plugin: result.plugin !== null && typeof result.plugin === 'object'
          ? { ...base.plugin, ...result.plugin }
          : base.plugin,
        error: result.ok === false
          ? { code: String(result.code ?? 'internal-error'), message: String(result.message ?? '') }
          : undefined,
        loaded: true,
      }
    }

    /**
     * Normalize one repository row.
     *
     * @param {any} row - Raw row from the Host.
     * @returns {object} Row with every promised field present.
     */
    function normalizeRepo(row) {
      const direction = row.direction === 'up' || row.direction === 'down' ? row.direction : 'both'
      return {
        id: String(row.id ?? ''),
        repoPath: String(row.repoPath ?? ''),
        remoteUrl: String(row.remoteUrl ?? ''),
        canonicalRemote: String(row.canonicalRemote ?? ''),
        branch: String(row.branch ?? ''),
        syncBranch: String(row.syncBranch ?? ''),
        direction,
        transport: String(row.transport ?? 'git-branch'),
        enabled: row.enabled !== false,
        autoSync: row.autoSync === true,
        autoSyncIntervalMs: Number(row.autoSyncIntervalMs ?? 0),
        state: row.state !== null && typeof row.state === 'object' ? row.state : null,
      }
    }

    // ── BEGIN GENERATED: src/ui/settings-page.js ────────────────────────────
    // ─────────────────────────────────────────────────────────────────────
    // Settings page UI — inlined from `src/ui/settings-page.js`.
    //
    // Do not edit this block by hand. The client module table has a single
    // entry point per package and its synchronous `require` resolves only
    // platform seeds (`react`, `@deepseek-ai/dsh-client-*`) and already
    // registered factories — it does not resolve relative paths at all:
    //
    //     require('./src/ui/settings-page.js')
    //     -> Error: require("./src/ui/settings-page.js") missed the module table
    //
    // `require.async('./x')` accepts a relative path, but only for a file named
    // `client.<name>.js` that registers itself through
    // `__ModuleLoader__.load({ chunk: ... })`, and only after an extra request.
    // Neither is worth it for one panel.
    //
    // Edit `src/ui/settings-page.js`, then run `npm run build:client`.
    // `npm run smoke` fails when the two drift.
    // ─────────────────────────────────────────────────────────────────────

    /**
     * 设置页入口 —— `client.js` 通过 `require('./src/ui/settings-page.js')` 加载本模块，
     * 并取 `default` 导出作为 React 组件。**不要在这里注册 slot**，那归 `client.js`。
     *
     * ## 数据从哪来
     *
     * 本模块**不 fetch**。它只消费 `client.js` 传进来的两个 prop：
     *
     *   - `store`：`getState()` / `subscribe(fn)` / `refresh()` / `sync()` / `bind()` / `unbind()` …
     *   - `t`：带插件 namespace 的翻译函数
     *
     * 这样拆的理由是：**数据层可以独立演进，而页面只需要一个稳定的 props 形状。**
     * 引擎还没交付时，`client.js` 会给出 `seams: { sessions:false, … }`，
     * 页面据此把「同步」按钮置灰并给出解释，而不是假装能用然后报错。
     *
     * ## 中文文案的落点
     *
     * 用户明确要求「所有失败路径给可操作的中文提示，不要抛裸英文栈」。所以：
     *
     *   - **错误码 → 中文**的映射集中在 {@link ERROR_TEXT}，一个都不漏
     *   - 每条都同时给「发生了什么」和「该怎么办」
     *   - 未知错误有兜底文案，绝不把 `stack` 或英文异常抛到界面上
     *
     * ## 安全约束
     *
     *   - 界面上**不出现任何凭据**（没有密码框、没有 token 字段、不回显 remote 凭据）
     *   - 危险操作（下行写入 / 移除绑定）走**两步确认**
     *   - 公开/未知仓库的放行走**逐字输入仓库名**
     *
     * @module dsh-repo-session-sync/ui/settings-page
     */

    // ─────────────────────────────────────────────────────────────────────────────
    // 内联说明（重要，改这个文件前必读）
    // ─────────────────────────────────────────────────────────────────────────────
    //
    // **本文件不 `import` 任何东西，也不 `require` 任何东西。**
    //
    // 这不是风格偏好，是 DSH 客户端模块系统的硬约束：插件的浏览器半只有
    // `client.js` 一个入口，模块系统的 `require` 只认平台 seed（`react` 等）
    // 和已注册模块，**不解析相对路径**；`require.async('./x')` 又要求文件名
    // 匹配 `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/` 并自行注册 chunk。
    // 详见 `@deepseek-ai/dsh-client-modules/lib/client.js` 的 `makeRequire`。
    //
    // 所以：**这个文件是运行时内联进 `client.js` 的源码组织形态。**
    // 它保持可读、可 review、可单测，但真正执行的是内联后的副本。
    //
    // ⚠️ 修改时必须同步两处：这里的 `src/ui/settings-page.js`，以及
    // `client.js` 里对应的「UI 实现」段。只改一处会出现"源码对了但页面没变"。
    //
    // 迁移到 `client.js` 时的三条机械变换：
    //   1. 删掉本注释块
    //   2. `export default function SettingsPage` → `function SettingsPage`
    //   3. 其余 `export function` / `export const` → 去掉 `export`
    // 其余代码一行都不用动。

    // ─────────────────────────────────────────────────────────────────────────────
    // 错误码 → 中文
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * 错误码到中文提示的映射。
     *
     * 键来自 `src/errors.js` 的 `ERROR_CODES`。**这个表必须覆盖全部已知错误码**——
     * 有一条元测试（`test/ui/error-text.test.js`）会拿 `ERROR_CODE_LIST` 逐个校验，
     * 漏一个就会红。这样"新增错误码忘了写文案"不会静默溜过去。
     *
     * 每一条都要回答两个问题：发生了什么（`what`）、我该怎么办（`how`）。
     *
     * @type {Record<string, {what: string, how: string}>}
     */
    const ERROR_TEXT = Object.freeze({
      // ── 可见性闸门（ADR-9）──
      'visibility-unconfirmed': {
        what: '这个仓库是公开的（或无法确认可见性），同步会把完整对话推上去，所以默认没有执行。',
        how: '点「检测可见性」看清状态；如果确实要同步到这个仓库，逐字输入仓库名确认。'
          + '更稳妥的做法是在 GitHub 上把仓库改成私有。',
      },
      'visibility-regression': {
        what: '这个仓库以前是私有的，现在检测到它变成公开了，本次同步已中止。',
        how: '如果这是误判，点「重新检测」；如果确实改了可见性，请改回私有或换一个仓库。'
          + '已确认过的旧授权在可见性变化时自动失效，需要重新确认。',
      },
      // ── 可见性闭环（下行）──
      'registry-attach-failed': {
        what: '会话已经写进磁盘，但没能登记到 DSH 的工作区，所以侧栏里看不到它。',
        how: '这不是数据丢失——文件还在。请先确认目标仓库路径存在且是同一个仓库，'
          + '然后重新点一次「下行」；仍然失败请把这一项报给开发者。',
      },
      'registry-unavailable': {
        what: '当前 DSH 没有提供工作区登记能力，无法确认会话会不会出现在侧栏里。',
        how: '本次没有把它当作成功。请重启 DSH 后重试；如果一直这样，说明这个版本的 DSH 不支持该接口。',
      },

      'not-configured': {
        what: '还没有绑定任何仓库，没有东西可以同步。',
        how: '先点「添加仓库」选一个 git 仓库。',
      },
      'bad-request': {
        what: '这次请求的参数不对，操作没有执行。',
        how: '刷新页面后重试。如果反复出现，请把日志一起反馈。',
      },
      'unknown-repo': {
        what: '这个仓库已经不在绑定列表里了。',
        how: '刷新一下页面；如果它确实被删了，重新添加即可。',
      },
      'direction-forbidden': {
        what: '这个仓库的同步方向不允许当前操作。',
        how: '到仓库那一行把「同步方向」改成需要的方向（上行 / 下行 / 双向）后再试。',
      },
      'repo-path-missing': {
        what: '这个仓库的本地目录找不到了。',
        how: '确认目录没有被移动或删除。挪过位置的话，移除绑定后重新添加新路径。',
      },
      'not-a-git-repo': {
        what: '这个目录不是一个 git 仓库。',
        how: '确认选的是仓库根目录（里面有 .git），而不是它的某个子目录。',
      },
      'no-remote': {
        what: '这个仓库没有配置远端地址（git remote）。',
        how: '先在终端里给它加一个远端：git remote add origin <仓库地址>。',
      },
      'remote-mismatch': {
        what: '这个目录的 git remote 和绑定记录对不上。',
        how: '仓库可能换过地址。移除绑定后重新添加，系统会按新地址记录。',
      },
      'git-unavailable': {
        what: '找不到 git 命令。',
        how: '确认本机装了 git，并且在当前用户的 PATH 里（终端里跑 git --version 试试）。',
      },
      'remote-unreachable': {
        what: '连不上远端仓库。',
        how: '检查网络、是否需要 VPN，以及远端地址是否还有效。也可以先在终端里跑一次 git fetch 验证。',
      },
      'auth-failed': {
        what: '远端仓库拒绝了认证。',
        how: '这台机器还没有配置好访问权限。先在终端里成功执行一次 git push，再回来同步——插件沿用你自己的 git 凭据，不另外保存。',
      },
      'aborted': {
        what: '操作被取消了。',
        how: '没有写入任何东西。需要的话重新点一次。',
      },
      'busy': {
        what: '已经有一个同步在跑了。',
        how: '等它结束再操作。同一时间只跑一个同步，是为了避免两次写入互相踩踏。',
      },
      'invalid-bundle': {
        what: '远端的数据格式不认识，可能是别的工具写进去的。',
        how: '为了安全没有写入任何东西。确认远端那个分支/引用没有被别的程序占用。',
      },
      'unsupported-version': {
        what: '远端数据的版本比当前插件新。',
        how: '把两台机器的插件都升级到同一版本，再试一次。',
      },
      'corrupt-session': {
        what: '会话数据校验没通过。',
        how: '没有写入任何东西。可能是传输过程中出错了，重试一次；反复失败请附上日志反馈。',
      },
      'limit-exceeded': {
        what: '这次要同步的内容超过了大小上限。',
        how: '先同步一部分（减少改动量）再试；如果确实需要更大的上限，在插件设置里调整。',
      },
      'up-to-date': {
        what: '本机和远端已经一致，没有需要同步的内容。',
        how: '不用做什么——这就是最新状态。',
      },
      'conflict-session': {
        what: '有会话在两台机器上都被修改过。',
        how: '为了避免丢内容，两边都完整保留了，没有覆盖任何一边。到「冲突」区域挑你想保留的那份。',
      },
      'conflict-binding': {
        what: '同一个远端仓库在这台机器上对应了不同的本地路径。',
        how: '确认你要绑的是哪个目录。两个都留着会让同步目标不明确。',
      },
      'path-unsafe': {
        what: '路径看着不对劲，已经拒绝操作。',
        how: '完全没有写入任何文件。如果这是正常的目录，请把它的完整路径反馈给我们。',
      },
      'backup-failed': {
        what: '同步前的备份没做成，所以这次操作被拒绝了。',
        how: '这是刻意的保护：没有备份就不覆盖。检查磁盘空间和目录权限后重试。',
      },
      'refused-unsafe-target': {
        what: '目标目录被判定为不安全的写入位置，已拒绝。',
        how: '没有任何数据被改动。这通常意味着同步试图写到你的真实 DSH 数据之外的地方。',
      },
      'not-implemented': {
        what: '这个功能还没接上。',
        how: '当前版本还在开发中。等同步引擎接入后这里就会可用。',
      },
      'internal-error': {
        what: '插件内部出错了，操作已中止。',
        how: '没有写入任何文件。详情已记录在插件日志里；如果反复出现，请附上日志反馈。',
      },
    })

    /**
     * 未知错误码的兜底文案。
     *
     * 存在是必须的：Host 可能比页面新（插件升级了但页面没刷新），
     * 这时会收到表里没有的 code。**兜底也不能显示英文 code 本身。**
     */
    const FALLBACK_TEXT = Object.freeze({
      what: '出了点问题，操作已中止。',
      how: '没有写入任何文件。刷新页面后重试；如果反复出现，请附上插件日志反馈。',
    })

    /**
     * 把失败结果翻译成可渲染的两行中文。
     *
     * @param {unknown} result - Host 返回的失败体 `{ ok: false, code, message, hint }`，
     *   或任意抛出的值。
     * @returns {{what: string, how: string, code: string}}
     */
    function explainFailure(result) {
      if (result === null || result === undefined) {
        return { what: '', how: '', code: '' }
      }

      const code = typeof result === 'object' && typeof result.code === 'string' ? result.code : ''
      const known = ERROR_TEXT[code]

      if (known) {
        return { what: known.what, how: known.how, code }
      }

      // Host 给了自述文案（可能比我们的表更具体），优先用它，但仍要配上"怎么办"。
      if (typeof result === 'object' && typeof result.message === 'string' && result.message !== '') {
        return {
          what: result.message,
          how: typeof result.hint === 'string' && result.hint !== '' ? result.hint : FALLBACK_TEXT.how,
          code,
        }
      }

      if (typeof result === 'string' && result.trim() !== '') {
        // 字符串可能是英文异常。只取第一行，并套上中文前缀 —— 绝不整段抛出。
        const firstLine = result.split('\n')[0].trim()
        return {
          what: `${FALLBACK_TEXT.what}（${firstLine}）`,
          how: FALLBACK_TEXT.how,
          code,
        }
      }

      return { ...FALLBACK_TEXT, code }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // 小工具（内联，不依赖外部模块）
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * 把时间戳格式化成中文相对时间。
     *
     * 未来的时间戳（两台机器时钟漂移）按「刚刚」处理 —— 显示「3 分钟后」
     * 会让用户怀疑数据坏了。
     *
     * @param {number|string|Date|null|undefined} value - 时间戳。
     * @param {number} [now] - 当前时间（测试可注入）。
     * @returns {string}
     */
    function formatWhen(value, now = Date.now()) {
      if (value === null || value === undefined || value === '') return '还没同步过'
      const ms = value instanceof Date ? value.getTime() : Number(value)
      if (!Number.isFinite(ms) || ms <= 0) return '还没同步过'

      const delta = now - ms
      if (delta < 0) return '刚刚'
      const minute = 60_000
      const hour = 60 * minute
      const day = 24 * hour

      if (delta < minute) return '刚刚'
      if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`
      if (delta < day) return `${Math.floor(delta / hour)} 小时前`
      if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`

      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * 待同步数量的中文描述。
     *
     * 0 是一个**好**状态，显示成「0 条待同步」会让用户以为坏了。
     *
     * @param {{upEvents?: number, downEvents?: number}|undefined} pending
     * @param {string} direction - `up` / `down` / `both`
     * @returns {string}
     */
    function formatPending(pending, direction) {
      const up = Number(pending?.upEvents) || 0
      const down = Number(pending?.downEvents) || 0
      const total = direction === 'up' ? up : direction === 'down' ? down : up + down
      if (!Number.isFinite(total) || total <= 0) return '已是最新'
      return `${total} 条待同步`
    }

    /**
     * 锚点提示：这段会话基于多少个 commit 之前。
     *
     * 用户真正想知道的是「我这段对话是不是已经过时了」，而不是 HEAD 的哈希值。
     *
     * @param {{anchor?: {behind?: number}, behind?: number}|undefined} state
     * @returns {string} 空串表示不需要显示。
     */
    function formatAnchorText(state) {
      const behind = Number(state?.anchor?.behind ?? state?.behind) || 0
      if (behind <= 0) return ''
      return `会话基于 ${behind} 个 commit 之前`
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // React 引用与钩子
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * 模块级的 React 引用。
     *
     * ## 为什么必须有这个
     *
     * 子组件（`ConfirmButton`、`VisibilityGate`）也要用 `useState`，但它们在
     * **模块作用域**，拿不到 `SettingsPage` 内部解构出来的钩子。踩过一次真实的坑：
     * 在子组件里直接写 `useState(...)` 会抛
     * `ReferenceError: useState is not defined`，而且**只有真正渲染到那个子组件时
     * 才会炸** —— 顶层渲染是好的，所以很容易漏测。
     *
     * 这里保存一份由 {@link SettingsPage} 在渲染前设置的 React 引用，
     * 子组件通过 {@link reactHooks} 取。
     *
     * 注意：这只在"渲染期间同步取用"的场景成立（React 的钩子本来就只能在
     * 函数组件渲染时调用），不存在并发或时序问题。
     *
     * @type {any}
     */
    let REACT_REF = null

    /**
     * 取当前渲染可用的钩子集合。
     *
     * @returns {{useState: Function, useEffect: Function}}
     * @throws {Error} 在 React 尚未设置时调用 —— 这是编程错误，不该静默降级。
     */
    function reactHooks() {
      if (REACT_REF === null || typeof REACT_REF.useState !== 'function') {
        throw new Error('repo-session-sync: React 尚未初始化，钩子只能在渲染期间调用')
      }
      return REACT_REF
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // 主组件
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * 设置页组件。
     *
     * @param {object} props
     * @param {(key: string, vars?: object) => string} [props.t] - 翻译函数（可缺省，回退到中文常量）。
     * @param {object} props.store - 数据层（见 client.js 的 createStatusStore）。
     * @returns {any} React 元素。
     */
    function SettingsPage(props) {
      // `React` comes from the enclosing factory scope (top of this file), not
      // from props: the module table seeds exactly one React instance, and
      // threading a second reference through props invites a duplicate.
      // 让模块作用域的子组件也能拿到 React（见文件内 `REACT_REF` 的说明）。
      REACT_REF = React

      const h = React.createElement
      const { useState, useEffect, useCallback, useMemo, useRef } = React

      const store = props.store || {}
      /**
       * 数据来源优先级：`props.snapshot` > `store.getState()`。
       *
       * `client.js` 两者都会传（`snapshot` 是它 normalize 过的版本）。优先用 props，
       * 因为它保证每个字段都存在；没有传时才回退到 store，这样组件在只有 store
       * 的最小环境里也能渲染（便于单测）。
       */
      const [snapshot, setSnapshot] = useState(() => (
        props.snapshot !== undefined && props.snapshot !== null
          ? props.snapshot
          : safeGetState(store)
      ))
      const [busy, setBusy] = useState(null)
      const [failure, setFailure] = useState(null)
      /** 每个仓库的可见性判定结果：`{ [repoId]: checkRepoVisibility 的返回值 }` */
      const [visibility, setVisibility] = useState({})
      /** 已经逐字确认过、允许同步的仓库 id 集合。 */
      const [consented, setConsented] = useState(() => new Set())
      const mountedRef = useRef(true)

      // ── 订阅数据层 ────────────────────────────────────────────────────────────
      useEffect(() => {
        mountedRef.current = true
        if (typeof store.subscribe !== 'function') return undefined
        const unsubscribe = store.subscribe((next) => {
          if (mountedRef.current) setSnapshot(next)
        })
        return () => {
          mountedRef.current = false
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [store])

      // ── 首次加载 ──────────────────────────────────────────────────────────────
      useEffect(() => {
        if (typeof store.refresh === 'function') {
          void store.refresh().catch(() => {})
        }
      }, [store])

      // ── 样式 ──────────────────────────────────────────────────────────────────
      useEffect(() => installStyles(), [])

      // ── 动作包装：统一处理 busy / 失败展示 ────────────────────────────────────
      const runAction = useCallback(async (key, fn) => {
        setBusy(key)
        setFailure(null)
        try {
          const result = await fn()
          if (result && result.ok === false) {
            setFailure(result)
          }
          return result
        } catch (error) {
          setFailure(error)
          return { ok: false }
        } finally {
          if (mountedRef.current) setBusy(null)
        }
      }, [])

      const onRefresh = useCallback(() => runAction('refresh', () => (
        typeof store.refresh === 'function' ? store.refresh() : Promise.resolve({ ok: true })
      )), [runAction, store])

      /**
       * 触发同步。
       *
       * **每次 `up` 之前都要重判可见性**（`detectRegression` 语义）：一个仓库
       * 今天私有、明天可能被改成公开，只在"启用时"查一次挡不住这件事。
       */
      const onSync = useCallback((repoId, action) => runAction(`${repoId}:${action}`, async () => {
        const repo = findRepo(snapshot, repoId)

        // 上行前的可见性重校验。判定器由 client.js 侧注入（`store.checkVisibility`）；
        // 没有注入时跳过——引擎侧仍会做二次校验，不会因为这里缺失就放行。
        if (action === 'up' && typeof store.checkVisibility === 'function' && repo) {
          const check = await store.checkVisibility(repo.remoteUrl, {
            previous: repo?.state?.visibility,
          })
          if (check && check.ok === false) {
            setFailure(check)
            return check
          }
          if (check) {
            setVisibility((current) => ({ ...current, [repoId]: check }))
            // 需要确认而用户还没确认过 → 不发起同步，把闸门显示出来。
            if (check.requiresConfirmation === true && !consented.has(repoId)) {
              setFailure({
                ok: false,
                code: 'visibility-confirm',
                message: check.reason,
                hint: check.hint,
              })
              return { ok: false, code: 'visibility-confirm' }
            }
          }
        }

        if (typeof store.sync !== 'function') {
          return { ok: false, code: 'not-implemented' }
        }
        return store.sync({ repoId, action })
      }), [runAction, snapshot, consented, store])

      const onDown = useCallback((repoId) => onSync(repoId, 'down'), [onSync])
      const onUp = useCallback((repoId) => onSync(repoId, 'up'), [onSync])
      const onRemove = useCallback((repoId) => runAction(`${repoId}:remove`, () => (
        typeof store.unbind === 'function' ? store.unbind(repoId) : Promise.resolve({ ok: true })
      )), [runAction, store])
      const onRestore = useCallback((repoId) => runAction(`${repoId}:restore`, () => (
        typeof store.restore === 'function' ? store.restore(repoId) : Promise.resolve({ ok: false, code: 'not-implemented' })
      )), [runAction, store])

      /**
       * 用户完成了逐字确认。
       *
       * 记入 `consented` 后立刻重试一次上行 —— 用户刚确认完还要再点一次按钮，
       * 会让他以为没生效。
       */
      const onConsent = useCallback((repoId, payload) => {
        setConsented((current) => {
          const next = new Set(current)
          next.add(repoId)
          return next
        })
        setFailure(null)
        void onSync(repoId, 'up')
      }, [onSync])

      const onAdd = useCallback(() => runAction('add', async () => {
        if (typeof store.bind !== 'function') return { ok: false, code: 'not-implemented' }
        setFailure({
          ok: false,
          code: 'internal-error',
          message: '请在弹出的对话框里选择仓库目录。',
          hint: '如果没看到对话框，说明这一版还没有接入目录选择，请稍后重试。',
        })
        return { ok: true }
      }), [runAction, store])

      // ── 渲染 ──────────────────────────────────────────────────────────────────
      const view = useMemo(() => buildView(snapshot, visibility, consented), [snapshot, visibility, consented])
      const seams = snapshot?.seams || {}
      const engineReady = seams.sessions === true && seams.transport === true

      return h('div', { className: 'rss-root' },
        h(Header, {
          h, view, busy, engineReady, seamSummary: seams,
          onRefresh, onAdd, refreshing: busy === 'refresh',
        }),
        failure === null ? null : h(FailureNote, { h, failure, onRetry: onRefresh }),
        busy === null ? null : h('div', { className: 'rss-progress', role: 'status' }, progressText(busy)),
        view.repos.length === 0
          // 只有"还没拿到任何快照"才算加载中。拿到了快照但仓库是空的，
          // 是真正的空状态 —— 显示"正在读取"会让用户以为卡住了。
          ? h(EmptyState, {
            h,
            onAdd,
            loading: snapshot === null && props.loading !== false,
          })
          : h('div', { className: 'rss-repo-list' },
            view.repos.map((repo) => h(RepoRow, {
              key: repo.id || repo.repoPath,
              h,
              repo,
              busy,
              engineReady,
              onUp,
              onDown,
              onRemove,
              onRestore,
              onConsent,
              visibility: visibility[repo.id] || null,
              consented: consented.has(repo.id),
            }))),
        view.conflicts.length === 0 ? null : h(ConflictSection, { h, conflicts: view.conflicts }),
        h(Footer, { h, plugin: snapshot?.plugin, paths: snapshot?.paths }))
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // 子组件
    // ─────────────────────────────────────────────────────────────────────────────

    /** 顶部：标题、说明、刷新与添加。 */
    function Header({ h, view, busy, engineReady, seamSummary, onRefresh, onAdd, refreshing }) {
      const anyBusy = busy !== null
      return h('section', { className: 'rss-section' },
        h('div', { className: 'rss-section-head' },
          h('h3', { className: 'rss-section-title' }, '仓库同步'),
          h('div', { className: 'rss-head-actions' },
            h(ActionButton, { h, tone: 'ghost', busy: refreshing, disabled: anyBusy, onClick: onRefresh }, '刷新'),
            h(ActionButton, { h, tone: 'primary', disabled: anyBusy, onClick: onAdd }, '添加仓库'))),
        h('p', { className: 'rss-section-hint' },
          '把带 git 的仓库和它的会话绑定，在多台机器之间同步对话。代码仍然走你自己的 git——插件不替你 commit，也不碰你的工作区。'),
        engineReady ? null : h('div', { className: 'rss-notice', role: 'note' },
          h('div', { className: 'rss-notice-title' }, '同步引擎还在接入中'),
          h('div', { className: 'rss-notice-body' }, seamText(seamSummary))))
    }

    /** 进度提示：正在做什么。 */
    function progressText(busyKey) {
      if (typeof busyKey !== 'string') return '处理中…'
      if (busyKey === 'refresh') return '正在刷新状态…'
      if (busyKey === 'add') return '正在添加仓库…'
      if (busyKey.endsWith(':up')) return '正在把本机会话推上去…'
      if (busyKey.endsWith(':down')) return '正在把远端会话拉下来（会先备份）…'
      if (busyKey.endsWith(':remove')) return '正在移除绑定…'
      if (busyKey.endsWith(':restore')) return '正在还原到同步前的状态…'
      return '处理中…'
    }

    /** 引擎接缝状态的解释 —— 让用户知道"为什么按钮是灰的"。 */
    function seamText(seams) {
      const missing = []
      if (seams?.sessions !== true) missing.push('会话读取')
      if (seams?.transport !== true) missing.push('传输通道')
      if (seams?.conflicts !== true) missing.push('冲突处理')
      if (missing.length === 0) return ''
      return `${missing.join('、')}还没有接上。现在可以绑定仓库和查看状态，同步按钮会在引擎接入后启用。`
    }

    /**
     * 失败提示。
     *
     * 永远两行：发生了什么 + 该怎么办。视觉上用 `danger` 而不是红色背景铺满，
     * 因为大多数失败（未绑定、引擎没接上）都不严重，铺满会让用户以为出大事了。
     */
    function FailureNote({ h, failure, onRetry }) {
      const explained = explainFailure(failure)
      if (explained.what === '') return null
      return h('div', { className: 'rss-error', role: 'alert' },
        h('div', { className: 'rss-error-msg' }, explained.what),
        explained.how === '' ? null : h('div', { className: 'rss-error-hint' }, explained.how),
        typeof onRetry === 'function'
          ? h('div', { className: 'rss-error-actions' },
            h(ActionButton, { h, tone: 'ghost', onClick: onRetry }, '重试'))
          : null)
    }

    /** 空状态：必须给出下一步动作。 */
    function EmptyState({ h, onAdd, loading }) {
      if (loading === true) {
        return h('div', { className: 'rss-loading' }, '正在读取绑定状态…')
      }
      return h('div', { className: 'rss-empty' },
        h('div', { className: 'rss-empty-title' }, '还没有绑定任何仓库'),
        h('p', { className: 'rss-empty-hint' },
          '选择一个 git 仓库开始。绑定之后，这个仓库下的对话就能同步到别的机器——只要那台机器也绑定同一个远端仓库，路径不一样也没关系。'),
        h(ActionButton, { h, tone: 'primary', onClick: onAdd }, '添加仓库'))
    }

    /**
     * 单个仓库一行。
     *
     * 一行里必须能回答三个问题：这是哪个仓库（身份）、有没有东西要同步（`pending`）、
     * 上次成不成功（`lastResult`）。
     */
    function RepoRow({ h, repo, busy, engineReady, onUp, onDown, onRemove, onRestore, onConsent, visibility, consented }) {
      const isBusy = typeof busy === 'string' && busy.startsWith(`${repo.id}:`)
      const anyBusy = busy !== null
      const needsConfirm = visibility?.requiresConfirmation === true && consented !== true

      return h('div', { className: 'rss-repo', 'data-status': repo.status },
        // 身份
        h('div', { className: 'rss-repo-head' },
          h('div', { className: 'rss-repo-title' },
            h('span', { className: 'rss-repo-name' }, repo.name),
            repo.visibility?.verdict === 'private'
              ? h(Badge, { h, tone: 'good' }, '私有仓库')
              : repo.visibility?.verdict === 'public'
                ? h(Badge, { h, tone: 'danger' }, '公开仓库')
                : repo.visibility?.verdict === 'unknown'
                  ? h(Badge, { h, tone: 'warn' }, '可见性未知')
                  : null,
            h(Badge, { h, tone: statusTone(repo.status) }, statusLabel(repo.status))),
          h('div', { className: 'rss-repo-path', title: repo.repoPath }, repo.repoPath)),

        // 状态摘要
        h('div', { className: 'rss-repo-meta' },
          h('span', { className: 'rss-meta-item' }, `分支 ${repo.branch || '未知'}`),
          h('span', { className: 'rss-meta-item' }, `方向 ${directionLabel(repo.direction)}`),
          h('span', { className: 'rss-meta-item rss-pending' }, pendingText(repo)),
          h('span', { className: 'rss-meta-item' }, `上次同步 ${formatWhen(repo.lastRunAt)}`),
          repo.anchorText === '' ? null : h('span', { className: 'rss-meta-item rss-anchor' }, repo.anchorText),
          repo.conflictCount > 0
            ? h(Badge, { h, tone: 'warn' }, `${repo.conflictCount} 个冲突待处理`)
            : null),

        // 最近一次失败原因
        repo.lastFailure === null ? null : h(FailureNoteInline, { h, failure: repo.lastFailure }),

        // 可还原入口
        repo.canRestore
          ? h('div', { className: 'rss-repo-backup' },
            h('span', { className: 'rss-meta-item' }, '同步前已备份，可还原'),
            h(ConfirmButton, {
              h,
              disabled: anyBusy,
              busy: busy === `${repo.id}:restore`,
              confirmChildren: busy === `${repo.id}:restore` ? '正在还原…' : '确认还原',
              hint: '还原会把本机会话恢复到上次同步之前的状态。这一步只影响本机。',
              onConfirm: () => onRestore(repo.id),
            }, '还原到同步前'))
          : null,

        // 可见性闸门
        needsConfirm ? h(VisibilityGate, {
          h, visibility, consented, onConsent: (payload) => onConsent(repo.id, payload),
        }) : null,

        // 动作
        h('div', { className: 'rss-repo-actions' },
          repo.direction !== 'down'
            ? h(ActionButton, {
              h,
              tone: 'primary',
              disabled: anyBusy || !engineReady || needsConfirm,
              busy: busy === `${repo.id}:up`,
              title: !engineReady ? '同步引擎接入后启用' : (needsConfirm ? '请先确认仓库可见性' : undefined),
              onClick: () => onUp(repo.id),
            }, busy === `${repo.id}:up` ? '正在上传…' : '上行')
            : null,

          repo.direction !== 'up'
            // 下行会写本机会话目录 —— 必须两步确认。
            ? h(ConfirmButton, {
              h,
              disabled: anyBusy || !engineReady,
              busy: busy === `${repo.id}:down`,
              confirmChildren: busy === `${repo.id}:down` ? '正在拉取…' : '确认拉取',
              hint: '这次拉取会写入本机会话目录。我们已经先做了一份快照，出问题可以用「还原」退回去，但这仍会改变本机数据。',
              onConfirm: () => onDown(repo.id),
            }, '下行')
            : null,

          // 移除绑定：也走两步确认（虽然它不删数据，但会让人以为同步关系丢了）
          h(ConfirmButton, {
            h,
            disabled: anyBusy,
            busy: busy === `${repo.id}:remove`,
            confirmChildren: busy === `${repo.id}:remove` ? '正在移除…' : '确认移除',
            hint: '只会移除绑定，不会删除任何会话，也不会动你的 git 仓库。以后可以重新绑定。',
            onConfirm: () => onRemove(repo.id),
          }, '移除绑定')))
    }

    /** 行内失败提示（更紧凑，用于仓库行里）。 */
    function FailureNoteInline({ h, failure }) {
      const explained = explainFailure(failure)
      if (explained.what === '') return null
      return h('div', { className: 'rss-error rss-error-inline', role: 'alert' },
        h('div', { className: 'rss-error-msg' }, explained.what),
        explained.how === '' ? null : h('div', { className: 'rss-error-hint' }, explained.how))
    }

    /**
     * 可见性闸门 —— 公开/未知仓库放行的唯一入口。
     *
     * 逐字输入仓库名 + 勾选知情，两者都满足才能放行。**没有别的绕过方式。**
     */
    function VisibilityGate({ h, visibility, onConsent }) {
      const { useState: useLocalState } = reactHooks()
      const [typed, setTyped] = useLocalState('')
      const [acknowledged, setAcknowledged] = useLocalState(false)

      const verdict = String(visibility?.verdict ?? '')
      const isPublic = verdict === 'public'
      const phrase = String(visibility?.confirmationPhrase ?? '')
      const expected = phrase !== '' ? phrase : (visibility?.slug || '')
      const typedValue = String(typed ?? '')
      const matches = expected !== '' && typedValue.trim().toLowerCase() === expected.toLowerCase()
      const ready = matches && acknowledged === true

      return h('div', {
        className: 'rss-vis-gate',
        'data-tone': isPublic ? 'danger' : 'warn',
        role: 'alert',
      },
      h('div', { className: 'rss-vis-title' }, isPublic ? '这个仓库是公开的' : '无法确认这个仓库的可见性'),
      h('p', { className: 'rss-vis-reason' }, visibility?.reason || ''),
      visibility?.hint ? h('p', { className: 'rss-vis-hint' }, visibility.hint) : null,

      h('label', { className: 'rss-typing-label' }, '请输入仓库名以确认：'),
      h('input', {
        type: 'text',
        className: 'rss-input rss-typing-input',
        value: typedValue,
        placeholder: expected,
        autoComplete: 'off',
        spellCheck: false,
        'aria-invalid': typedValue !== '' && !matches ? 'true' : undefined,
        onChange: (event) => setTyped(event?.target?.value ?? ''),
      }),
      typedValue !== '' && !matches
        ? h('div', { className: 'rss-typing-mismatch' }, '输入的和仓库名不一致。')
        : null,
      h('label', { className: 'rss-checkbox' },
        h('input', {
          type: 'checkbox',
          checked: acknowledged,
          onChange: (event) => setAcknowledged(event?.target?.checked === true),
        }),
        h('span', null, '我了解这会把对话内容推送到别人可见的地方')),
      h('div', { className: 'rss-typing-actions' },
        h(ActionButton, {
          h,
          tone: 'danger',
          disabled: !ready,
          onClick: () => {
            if (!ready) return
            onConsent({ typed: typedValue, acknowledged })
          },
        }, '确认并同步')))
    }

    /** 冲突区域。 */
    function ConflictSection({ h, conflicts }) {
      return h('section', { className: 'rss-section' },
        h('h3', { className: 'rss-section-title' }, '有会话在两端都被修改过'),
        h('p', { className: 'rss-section-hint' },
          '为了避免丢内容，我们保留了所有版本，没有覆盖任何一边。请选择你想保留的处理方式。'),
        h('ul', { className: 'rss-conflict-list' },
          conflicts.map((item, index) => h('li', {
            key: String(item?.sessionId ?? index),
            className: 'rss-conflict-item',
          },
          h('div', { className: 'rss-conflict-name' }, String(item?.sessionId ?? '未知会话')),
          typeof item?.summary === 'string'
            ? h('div', { className: 'rss-conflict-summary' }, item.summary)
            : null))))
    }

    /** 页脚：版本与路径（路径已由 Host 侧缩略）。 */
    function Footer({ h, plugin, paths }) {
      if (!plugin && !paths) return null
      return h('div', { className: 'rss-footer' },
        plugin?.name
          ? h('span', { className: 'rss-meta-item' }, `${plugin.name} ${plugin.version || ''}`.trim())
          : null,
        paths?.stateDir
          ? h('span', { className: 'rss-meta-item' }, `状态目录 ${paths.stateDir}`)
          : null)
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // 通用元件
    // ─────────────────────────────────────────────────────────────────────────────

    /** 徽章。`tone`: neutral / good / warn / danger。 */
    function Badge({ h, children, tone }) {
      return h('span', { className: 'rss-badge', 'data-tone': tone || 'neutral' }, children)
    }

    /** 按钮。`tone`: default / primary / danger / ghost。 */
    function ActionButton({ h, children, onClick, disabled, busy, tone, title }) {
      const isBusy = busy === true
      return h('button', {
        type: 'button',
        className: 'rss-btn',
        'data-tone': tone || 'default',
        'aria-busy': isBusy ? 'true' : undefined,
        title: title === undefined ? undefined : title,
        disabled: disabled === true || isBusy,
        onClick: typeof onClick === 'function' ? onClick : undefined,
      }, isBusy ? h('span', { className: 'rss-btn-spinner', 'aria-hidden': 'true' }, '⋯') : null, children)
    }

    /**
     * 两步确认按钮：第一次点击变成「确认」，第二次才执行。
     *
     * **不用弹窗**：弹窗要管焦点、要拦 ESC、要防误触背景，都是额外的失败面。
     * 就地两步确认把误点代价降到零——点错了不点第二次就行。
     *
     * 确认态是组件本地状态，任何重渲染都不会让它悄悄变成已确认。
     */
    function ConfirmButton({ h, children, confirmChildren, onConfirm, disabled, busy, hint }) {
      const { useState: useLocalState } = reactHooks()
      const [armed, setArmed] = useLocalState(false)

      if (armed !== true) {
        return h(ActionButton, {
          h,
          onClick: () => setArmed(true),
          disabled: disabled === true,
          busy: busy === true,
        }, children)
      }

      return h('span', { className: 'rss-confirm-group' },
        h(ActionButton, {
          h,
          tone: 'danger',
          busy: busy === true,
          onClick: () => {
            setArmed(false)
            if (typeof onConfirm === 'function') onConfirm()
          },
        }, confirmChildren === undefined ? '确认' : confirmChildren),
        h(ActionButton, {
          h,
          tone: 'ghost',
          disabled: busy === true,
          onClick: () => setArmed(false),
        }, '取消'),
        hint === undefined || hint === null
          ? null
          : h('span', { className: 'rss-confirm-hint' }, hint))
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // 视图模型
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * 把 `/status` 快照整理成渲染用的视图模型。
     *
     * 全部字段都做兜底：Host 可能比页面旧/新，字段缺失时必须能渲染，
     * 而不是让整页崩掉。
     *
     * @param {object|null} snapshot - `/status` 的返回。
     * @param {Record<string, object>} visibilityMap - 各仓库的可见性判定。
     * @param {Set<string>} consented - 已确认的仓库 id。
     * @returns {{repos: object[], conflicts: object[]}}
     */
    function buildView(snapshot, visibilityMap, consented) {
      const rawRepos = Array.isArray(snapshot?.repos) ? snapshot.repos : []
      const vis = visibilityMap || {}
      const ok = consented instanceof Set ? consented : new Set()

      const repos = rawRepos.map((repo) => {
        const state = repo?.state || {}
        const repoId = String(repo?.id ?? '')
        const repoPath = String(repo?.repoPath ?? '')
        const check = vis[repoId] || null

        const conflicts = Array.isArray(state?.conflicts) ? state.conflicts : []
        const lastResult = state?.lastResult
        const status =
          lastResult === 'failed' ? 'failed'
            : conflicts.length > 0 ? 'conflict'
              : lastResult === 'ok' ? 'ok'
                : 'idle'

        return {
          id: repoId,
          repoPath,
          name: baseName(repoPath) || repoId || '未知仓库',
          remoteUrl: String(repo?.remoteUrl ?? ''),
          branch: String(repo?.branch ?? ''),
          direction: ['up', 'down', 'both'].includes(repo?.direction) ? repo.direction : 'both',
          status,
          lastRunAt: state?.lastUpAt ?? state?.lastDownAt ?? null,
          lastFailure: lastResult === 'failed' && state?.lastError
            ? state.lastError
            : null,
          conflictCount: conflicts.length,
          conflicts,
          canRestore: typeof state?.backupPath === 'string' && state.backupPath !== '',
          anchorText: formatAnchorText(state),
          sessionCount: Number(state?.sessionCount) || 0,
          visibility: check,
          needsConsent: check?.requiresConfirmation === true && !ok.has(repoId),
          pending: { upEvents: 0, downEvents: 0 },
        }
      })

      const conflicts = repos.flatMap((repo) => (
        repo.conflicts.map((item) => ({ ...item, repoId: repo.id, repoName: repo.name }))
      ))

      return { repos, conflicts }
    }

    /** 路径最后一段（仅用于显示，不用于身份判定）。 */
    function baseName(p) {
      const value = String(p ?? '').replace(/[\\/]+$/, '')
      if (value === '') return ''
      const parts = value.split(/[\\/]/)
      return parts[parts.length - 1] || ''
    }

    /** 方向中文名。 */
    function directionLabel(direction) {
      if (direction === 'up') return '上行'
      if (direction === 'down') return '下行'
      return '双向'
    }

    /** 状态中文名。 */
    function statusLabel(status) {
      if (status === 'ok') return '成功'
      if (status === 'failed') return '失败'
      if (status === 'conflict') return '有冲突'
      return '空闲'
    }

    /** 状态徽章色调。 */
    function statusTone(status) {
      if (status === 'ok') return 'good'
      if (status === 'failed') return 'danger'
      if (status === 'conflict') return 'warn'
      return 'neutral'
    }

    /** 待同步文案。 */
    function pendingText(repo) {
      const pending = formatPending(repo.pending, repo.direction)
      return pending
    }

    /** 安全读取 store 初始状态（store 可能不完整）。 */
    function safeGetState(store) {
      try {
        const state = typeof store?.getState === 'function' ? store.getState() : null
        return state === undefined ? null : state
      } catch (error) {
        // A throwing getState would otherwise render as "no repositories bound",
        // which is a wrong answer rather than a degraded one. Say so — silently
        // degrading is what made an earlier defect take a full round to find.
        console.warn(
          '[dsh-repo-session-sync] 读取插件状态失败，界面可能显示为空',
          error instanceof Error ? error.message : String(error),
        )
        return null
      }
    }

    /** 找到快照里的某个仓库。 */
    function findRepo(snapshot, repoId) {
      const list = Array.isArray(snapshot?.repos) ? snapshot.repos : []
      return list.find((r) => String(r?.id) === String(repoId)) || null
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // 样式
    // ─────────────────────────────────────────────────────────────────────────────

    /** 把样式表注入 `<head>`，返回移除函数。 */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const id = 'dsh-repo-session-sync-style'
      document.getElementById(id)?.remove()
      const style = document.createElement('style')
      style.id = id
      style.dataset.plugin = 'dsh-repo-session-sync'
      style.textContent = PANEL_CSS
      document.head.appendChild(style)
      return () => {
        document.getElementById(id)?.remove()
      }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // 样式表
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * 面板样式。
     *
     * 全部用 `rss-` 前缀 —— 插件与宿主、其他插件共享同一个 DOM，
     * 类名撞车会导致样式互相污染，这类 bug 极难定位。
     *
     * 颜色尽量用 `currentColor` 与半透明灰，让面板跟随宿主的明/暗主题，
     * 而不是硬编码一套配色在暗色主题下变成白底。
     */
    const PANEL_CSS = `
    .rss-root { display: flex; flex-direction: column; gap: 20px; padding: 4px 0; }
    .rss-section { display: flex; flex-direction: column; gap: 12px; }
    .rss-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .rss-section-title { margin: 0; font-size: 15px; font-weight: 600; }
    .rss-section-hint { margin: 0; font-size: 13px; opacity: 0.72; line-height: 1.6; }
    .rss-head-actions { display: flex; gap: 8px; }

    .rss-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 14px; border-radius: 8px; border: 1px solid rgba(127,127,127,0.32);
      background: transparent; color: inherit; font-size: 13px; cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;
    }
    .rss-btn:hover:not(:disabled) { background: rgba(127,127,127,0.12); }
    .rss-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .rss-btn[data-tone="primary"] { border-color: transparent; background: #3b6cf6; color: #fff; }
    .rss-btn[data-tone="primary"]:hover:not(:disabled) { background: #2f5ce0; }
    .rss-btn[data-tone="danger"] { border-color: transparent; background: #dc3d43; color: #fff; }
    .rss-btn[data-tone="danger"]:hover:not(:disabled) { background: #c22f36; }
    .rss-btn[data-tone="ghost"] { border-color: transparent; }
    .rss-btn-spinner { font-size: 12px; opacity: 0.8; }

    .rss-badge {
      display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
      font-size: 12px; line-height: 1.6; border: 1px solid rgba(127,127,127,0.3); white-space: nowrap;
    }
    .rss-badge[data-tone="good"] { border-color: rgba(46,160,67,0.5); color: #2ea043; }
    .rss-badge[data-tone="warn"] { border-color: rgba(210,153,34,0.55); color: #b07d1a; }
    .rss-badge[data-tone="danger"] { border-color: rgba(220,61,67,0.55); color: #dc3d43; }

    .rss-repo {
      display: flex; flex-direction: column; gap: 10px; padding: 14px 16px;
      border: 1px solid rgba(127,127,127,0.22); border-radius: 12px;
    }
    .rss-repo[data-status="failed"] { border-color: rgba(220,61,67,0.4); }
    .rss-repo[data-status="conflict"] { border-color: rgba(210,153,34,0.4); }
    .rss-repo-head { display: flex; flex-direction: column; gap: 4px; }
    .rss-repo-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .rss-repo-name { font-size: 14px; font-weight: 600; }
    .rss-repo-path { font-size: 12px; opacity: 0.62; word-break: break-all; }
    .rss-repo-meta { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 12px; opacity: 0.85; }
    .rss-meta-item { white-space: nowrap; }
    .rss-pending { font-weight: 500; }
    .rss-anchor { opacity: 0.75; }
    .rss-repo-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .rss-repo-list { display: flex; flex-direction: column; gap: 10px; }
    .rss-repo-backup { display: flex; align-items: center; gap: 10px; font-size: 12px; opacity: 0.8; flex-wrap: wrap; }

    .rss-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 28px 0; }
    .rss-empty-title { font-size: 14px; font-weight: 600; }
    .rss-empty-hint { margin: 0; font-size: 13px; opacity: 0.72; line-height: 1.6; max-width: 46em; }
    .rss-loading { padding: 24px 0; font-size: 13px; opacity: 0.7; }

    .rss-notice {
      display: flex; flex-direction: column; gap: 4px; padding: 10px 14px; border-radius: 10px;
      border: 1px solid rgba(127,127,127,0.3); background: rgba(127,127,127,0.06);
    }
    .rss-notice-title { font-size: 13px; font-weight: 600; }
    .rss-notice-body { font-size: 12px; opacity: 0.8; line-height: 1.6; }

    .rss-progress { font-size: 12px; opacity: 0.8; padding: 2px 0; }

    .rss-confirm-group { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .rss-confirm-hint { font-size: 12px; opacity: 0.7; max-width: 42em; line-height: 1.5; }

    .rss-error {
      display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: 10px;
      border: 1px solid rgba(220,61,67,0.4); background: rgba(220,61,67,0.07);
    }
    .rss-error-inline { padding: 8px 10px; }
    .rss-error-msg { font-size: 13px; font-weight: 500; }
    .rss-error-hint { font-size: 12px; opacity: 0.8; line-height: 1.6; }
    .rss-error-actions { display: flex; gap: 8px; }

    .rss-vis-gate {
      display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border-radius: 12px;
      border: 1px solid rgba(210,153,34,0.45); background: rgba(210,153,34,0.06);
    }
    .rss-vis-gate[data-tone="danger"] { border-color: rgba(220,61,67,0.5); background: rgba(220,61,67,0.07); }
    .rss-vis-title { font-size: 13px; font-weight: 600; }
    .rss-vis-reason { margin: 0; font-size: 13px; line-height: 1.65; }
    .rss-vis-hint { margin: 0; font-size: 12px; opacity: 0.78; line-height: 1.6; }

    .rss-typing-label { font-size: 12px; opacity: 0.85; }
    .rss-input {
      padding: 7px 10px; border-radius: 8px; font-size: 13px; font-family: inherit;
      border: 1px solid rgba(127,127,127,0.35); background: transparent; color: inherit;
    }
    .rss-input:focus { outline: 2px solid rgba(59,108,246,0.45); outline-offset: 1px; }
    .rss-typing-input { max-width: 340px; }
    .rss-typing-input[aria-invalid="true"] { border-color: rgba(220,61,67,0.7); }
    .rss-typing-mismatch { font-size: 12px; color: #dc3d43; }
    .rss-checkbox { display: inline-flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.55; cursor: pointer; }
    .rss-typing-actions { display: flex; gap: 8px; }

    .rss-conflict-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .rss-conflict-item { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(210,153,34,0.38); }
    .rss-conflict-name { font-size: 13px; font-weight: 500; }
    .rss-conflict-summary { font-size: 12px; opacity: 0.78; }

    .rss-footer { display: flex; flex-wrap: wrap; gap: 16px; font-size: 11px; opacity: 0.55; padding-top: 4px; }
    `

    // ── END GENERATED ───────────────────────────────────────────────────────

    return {
      // `slots` is required for registration; `locale` for the nav label.
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = makeT(ctx)
        const store = createStatusStore()

        ctx.effect(() => () => store.dispose(), 'repo-session-sync: status store')

        // `label` is a thunk so the nav entry follows a locale switch without
        // re-registering the slot.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: SECTION_ORDER,
          label: () => t('nav.label'),
          locale: NS,
        }, (slotProps) => h(SettingsPage, { ...slotProps, t, store })))

        // Kick off the first fetch on activation so the section is populated by
        // the time the user opens it.
        void store.refresh().catch(() => {})
      },
    }
  },
})
