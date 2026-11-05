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
        } catch {
          // Fall through to the raw key: a missing locale service must not make
          // the settings page throw.
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
          } catch {
            // One broken subscriber must not stop the others from updating.
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

    /**
     * The settings section body.
     *
     * Deliberately thin: it owns the snapshot lifecycle and error banner, then
     * hands rendering to `src/ui/settings-page.js`. Everything a user reads and
     * clicks lives there, so the UI can be reviewed as one file.
     *
     * @param {object} props - Slot props plus `t` and `store`.
     * @returns {any} React element.
     */
    function RepoSessionSyncSection(props) {
      const { t, store } = props
      const [snapshot, setSnapshot] = React.useState(() => store.getState())
      const [loadError, setLoadError] = React.useState(null)

      React.useEffect(() => store.subscribe(setSnapshot), [store])

      React.useEffect(() => {
        let alive = true
        store.refresh({ force: true }).catch((error) => {
          if (alive) setLoadError(error instanceof Error ? error.message : String(error))
        })
        return () => {
          alive = false
        }
      }, [store])

      const Page = resolveSettingsPage()
      const pageProps = { ...props, t, store, snapshot, loading: snapshot.loaded !== true }

      return h(
        'div',
        { 'data-dsh-plugin': NS, style: { display: 'contents' } },
        loadError !== null
          ? h('p', { role: 'alert', style: { color: 'var(--dsh-color-danger, #d9534f)' } }, loadError)
          : null,
        Page !== null
          ? h(Page, pageProps)
          : h(MissingPageNotice, { t }),
      )
    }

    /**
     * Placeholder shown when the UI module has not been built yet.
     *
     * A missing section would look like the plugin failed to install; naming the
     * missing module makes the actual situation visible to whoever is looking.
     *
     * @param {{ t: Function }} props - Props.
     * @returns {any} React element.
     */
    function MissingPageNotice({ t }) {
      return h(
        'div',
        { style: { padding: '12px 0' } },
        h('h3', { style: { margin: '0 0 8px', fontSize: '1rem' } }, t('section.title')),
        h('p', { style: { margin: 0, opacity: 0.75, fontSize: '0.875rem' } }, t('section.missingUi')),
      )
    }

    /**
     * The registered settings page component, if `src/ui/` has supplied one.
     *
     * Resolved lazily and tolerantly: `src/ui/settings-page.js` is owned by the
     * UI work, and a not-yet-written module must degrade to a notice rather than
     * breaking the whole Settings surface. The module is expected to export a
     * default React component; nothing else about it is assumed here.
     *
     * @returns {Function|null} Component, or null when absent.
     */
    function resolveSettingsPage() {
      try {
        const loaded = require('./src/ui/settings-page.js')
        const component = loaded?.default ?? loaded?.SettingsPage
        return typeof component === 'function' ? component : null
      } catch {
        return null
      }
    }

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
        }, (slotProps) => h(RepoSessionSyncSection, { ...slotProps, t, store })))

        // Kick off the first fetch on activation so the section is populated by
        // the time the user opens it.
        void store.refresh().catch(() => {})
      },
    }
  },
})
