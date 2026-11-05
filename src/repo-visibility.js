/**
 * dsh-repo-session-sync — 仓库可见性判定（前端可见性闸门）。
 *
 * ## 为什么这个模块必须存在
 *
 * 推送会话 = 把**完整对话正文**推到远端仓库。如果那个仓库是 **public**，
 * 任何能看到这个仓库的人都能读到整段对话——包括你本机的路径、命令输出、
 * 代码片段，以及你在对话里贴过的任何东西。
 *
 * 而用户**通常不会意识到**自己的仓库是公开的：克隆下来的时候没人提醒你，
 * 界面上也不总显示。
 *
 * ## 为什么不是"硬拦截"
 *
 * 直觉上"公开仓库一律禁止"最安全，但它有三个问题：
 *
 *   1. **会让用户完全不可用。** 只有一个公开仓库的用户，产品对他关上了门。
 *   2. **会被绕过。** 用户改 `git config`、换 CLI、用别的通道推，插件拦不住，
 *      反而给人"已经被保护了"的错觉。
 *   3. **拦错了地方。** 真正的风险不是"启用同步"这个动作，而是"内容被推上去"。
 *
 * 所以这里做的是**默认安全 + 显式知情**：
 *   - `private` → 直接放行
 *   - `public` → 默认拒绝，但提供一个需要**逐字输入仓库名**的逃生口
 *   - `unknown` → 默认拒绝，同样需要逐字确认（"查不到"绝不等于"安全"）
 *
 * ## 三层防御里的位置
 *
 * 本模块只负责**第一层（启用时判定）**和**第二层所需的判定能力（每次上行前重判）**。
 *
 *   - 第一层：启用仓库绑定时调用 {@link checkRepoVisibility}
 *   - 第二层：**每次上行前**再调一次，用 {@link detectRegression} 对比上次结果，
 *     发现 `private → public` 就中止本次上行。**这是防"今天私有、明天转公开"
 *     的唯一有效手段。**
 *   - 第三层（内容侧加密）不在本模块，归引擎与设计。
 *
 * ## 可测试性
 *
 * 判定器**全部可注入**：本模块的默认实现才会去 spawn `gh` 或发 HTTP，
 * 测试可以传入纯桩函数覆盖全部分支，不碰网络、不碰用户凭据。
 *
 * @module dsh-repo-session-sync/repo-visibility
 */

import { execFile } from 'node:child_process'

// ─────────────────────────────────────────────────────────────────────────────
// 判定值
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 可见性判定结果。
 *
 * 字符串值会出现在 UI、日志与持久化状态里，**不要改名**。
 *
 * @readonly
 * @enum {string}
 */
export const VERDICT = Object.freeze({
  /** 确认是私有仓库。 */
  PRIVATE: 'private',
  /** 确认是公开仓库。 */
  PUBLIC: 'public',
  /** 无法判定（无网 / 非 GitHub / 无权限 / 解析失败）。 */
  UNKNOWN: 'unknown',
})

/** 所有判定值，供 UI 做穷举 switch 与测试遍历。 */
export const VERDICT_LIST = Object.freeze(Object.values(VERDICT))

// ─────────────────────────────────────────────────────────────────────────────
// remote URL 解析
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 git remote URL 里解析出托管平台与 `owner/repo`。
 *
 * 支持的形态（覆盖 GitHub / GitLab / Gitee / 自建 GitLab 的常见写法）：
 *
 * - `git@github.com:owner/repo.git`          （scp 风格）
 * - `https://github.com/owner/repo.git`
 * - `ssh://git@github.com/owner/repo.git`
 * - `git://github.com/owner/repo.git`
 * - `https://gitlab.example.com/group/sub/repo.git`（多级 group）
 *
 * **刻意不接受**本地路径（`/path/to/repo`、`../repo`）——那不是远端仓库。
 *
 * @param {string} url - git remote URL。
 * @returns {{ok: boolean, host?: string, owner?: string, repo?: string, slug?: string,
 *   protocol?: string, reason?: string}}
 *   `slug` 形如 `owner/repo`；失败时 `reason` 是中文原因。
 */
export function parseRemoteUrl(url) {
  const raw = String(url ?? '').trim()
  if (!raw) return { ok: false, reason: '这个仓库还没有配置远端地址（git remote）。' }

  // 本地路径不是远端（POSIX 绝对/相对、家目录、Windows 盘符、UNC）
  if (/^(\.{1,2}\/|\/|~\/|[A-Za-z]:[\\/]|\\\\|\.{1,2}$)/.test(raw)) {
    return { ok: false, reason: '远端地址是本机路径，不是可同步的线上仓库。' }
  }

  let host = ''
  let pathPart = ''
  let protocol = ''

  // scp 风格：user@host:owner/repo.git（冒号后不是 //）
  const scp = raw.match(/^(?:([\w.-]+)@)?([\w.-]+):(?!\/\/)(.+)$/)
  if (scp) {
    host = scp[2]
    pathPart = scp[3]
    protocol = 'ssh'
  } else {
    let parsed
    try {
      parsed = new URL(raw)
    } catch {
      return { ok: false, reason: `看不懂这个远端地址：${redactUrl(raw)}` }
    }
    host = parsed.hostname
    pathPart = parsed.pathname
    protocol = parsed.protocol.replace(':', '')
  }

  if (!host || !pathPart) {
    return { ok: false, reason: `远端地址里没有解析出主机名或仓库路径：${redactUrl(raw)}` }
  }

  const cleaned = pathPart.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  const segments = cleaned.split('/').filter(Boolean)
  if (segments.length < 2) {
    return {
      ok: false,
      reason: '远端地址里没有解析出 owner/repo，请确认这是个仓库地址而不是用户主页。',
    }
  }

  const owner = segments.slice(0, -1).join('/')
  const repo = segments[segments.length - 1]
  return { ok: true, host, owner, repo, slug: `${owner}/${repo}`, protocol }
}

/**
 * 把 URL 里可能存在的凭据抹掉，用于错误文案与日志。
 *
 * `https://user:token@host/...` 这类写法在真实世界里很常见（有人把 token
 * 写进了 remote URL）。**任何进入日志或界面的 URL 都必须先过这个函数。**
 *
 * @param {string} url
 * @returns {string} 抹掉 userinfo 的 URL。
 */
export function redactUrl(url) {
  const raw = String(url ?? '')
  return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, '$1***@')
}

/**
 * 判断主机名是不是 GitHub。
 *
 * 只有 GitHub 有"未认证 404 = 私有"这个可靠语义，所以只有它能自动判定。
 * 其他平台一律归 `unknown` 交给用户确认——**不要猜**。
 *
 * @param {string} host
 * @returns {boolean}
 */
export function isGitHubHost(host) {
  const h = String(host ?? '').toLowerCase().trim()
  return h === 'github.com' || h === 'www.github.com'
}

// ─────────────────────────────────────────────────────────────────────────────
// 远端查询（默认实现；测试请注入）
// ─────────────────────────────────────────────────────────────────────────────

/** 单次查询的超时（毫秒）。网络慢时不要卡住整个设置页。 */
const DEFAULT_TIMEOUT_MS = 8000

/**
 * 通过 GitHub 查询仓库是否公开。
 *
 * 两条路径：
 *   1. `gh repo view` —— 能访问私有仓库，判定最准；
 *   2. 无认证的 REST API —— 只能看到公开仓库，**但这恰好够用**：
 *      未认证能读到 = 全世界都能读到 = 公开。
 *
 * 两条都失败 → `unknown`，交给用户确认。**失败绝不等于放行。**
 *
 * @param {object} input
 * @param {string} input.slug - `owner/repo`。
 * @param {(args: string[]) => Promise<{stdout: string}>} [input.runGh] - 注入的 gh 执行器。
 * @param {(url: string) => Promise<{status: number, body: any}>} [input.fetchJson] - 注入的 HTTP 客户端。
 * @returns {Promise<{verdict: string, source: string, detail: string}>}
 */
export async function queryGitHubVisibility({ slug, runGh, fetchJson, timeoutMs } = {}) {
  const target = String(slug ?? '').trim()
  if (!target) {
    return { verdict: VERDICT.UNKNOWN, source: 'none', detail: '没有仓库标识，无法查询。' }
  }

  // ── 路径 1：gh CLI ──────────────────────────────────────────────────
  const gh = runGh || defaultRunGh
  try {
    const { stdout } = await gh(['repo', 'view', target, '--json', 'visibility'])
    const parsed = JSON.parse(String(stdout ?? '{}'))
    const value = String(parsed?.visibility ?? '').toUpperCase()
    if (value === 'PUBLIC') {
      return { verdict: VERDICT.PUBLIC, source: 'gh', detail: 'gh 报告该仓库是公开的。' }
    }
    if (value === 'PRIVATE') {
      return { verdict: VERDICT.PRIVATE, source: 'gh', detail: 'gh 报告该仓库是私有的。' }
    }
    if (value === 'INTERNAL') {
      // 组织内部可见：不是公开的，但对"泄漏到互联网"这个目标而言是安全的。
      // 仍然按私有处理，只在 detail 里说明，便于界面解释。
      return {
        verdict: VERDICT.PRIVATE,
        source: 'gh',
        detail: '该仓库是组织内部可见（INTERNAL），不是公开仓库。',
      }
    }
    return { verdict: VERDICT.UNKNOWN, source: 'gh', detail: 'gh 没有给出可识别的可见性值。' }
  } catch {
    // gh 未安装 / 未登录 / 无权限 —— 正常降级到下一条路径。
  }

  // ── 路径 2：无认证 REST API ─────────────────────────────────────────
  const client = fetchJson || ((url) => defaultFetchJson(url, timeoutMs))
  try {
    const response = await client(`https://api.github.com/repos/${target}`)

    if (response?.status === 200) {
      if (response.body?.private === true) {
        // 未登录却读到"私有"标记：本不该发生，判定不可信 → 交给人确认。
        return {
          verdict: VERDICT.UNKNOWN,
          source: 'api',
          detail: '接口返回的仓库标记为私有，但未登录状态本不该看到它，判定结果不可信。',
        }
      }
      return {
        verdict: VERDICT.PUBLIC,
        source: 'api',
        detail: '未登录即可访问该仓库，说明它是公开的。',
      }
    }

    if (response?.status === 404) {
      // 未认证看不到 → 私有，或根本不存在。
      // 对"能否被未认证的人看到"这个判定目标而言，两者都应该按安全处理：
      // 不存在的仓库即使被误判为私有，后续 git push 也会立刻失败。
      return {
        verdict: VERDICT.PRIVATE,
        source: 'api',
        detail: '未登录状态看不到该仓库，按私有处理。',
      }
    }

    if (response?.status === 403 || response?.status === 429) {
      return { verdict: VERDICT.UNKNOWN, source: 'api', detail: '接口限流或拒绝访问，无法判定。' }
    }

    return {
      verdict: VERDICT.UNKNOWN,
      source: 'api',
      detail: `接口返回了 ${response?.status}，无法判定。`,
    }
  } catch (error) {
    return {
      verdict: VERDICT.UNKNOWN,
      source: 'api',
      detail: `网络查询失败：${String(error?.message ?? error)}`,
    }
  }
}

/** 默认的 `gh` 执行器。 */
function defaultRunGh(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      { timeout: DEFAULT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(new Error(error.message), { stderr }))
          return
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })
}

/** 默认的 HTTP 客户端（Node 18+ 内置 fetch）。 */
async function defaultFetchJson(url, timeoutMs) {
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), budget)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-repo-session-sync',
      },
    })
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return { status: response.status, body }
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 对外主入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 判定一个仓库远端的可见性，并给出**是否要求用户显式知情确认**。
 *
 * 这是 UI 与引擎都该调用的**唯一判定入口**。它**绝不抛异常**：
 * 任何内部错误都归为 `unknown`（要求确认），因为**判定失败不该导致放行**。
 *
 * @param {object} input
 * @param {string} input.remoteUrl - 仓库的 git remote URL。
 * @param {string} [input.visibilityHint] - 上游已知的可见性（例如引擎缓存的
 *   上次结果）。**只在无法查询时作为弱证据使用**，不覆盖实时查询结果。
 * @param {(args: string[]) => Promise<{stdout: string}>} [input.runGh] - 注入的 gh 执行器。
 * @param {(url: string) => Promise<{status: number, body: any}>} [input.fetchJson] - 注入的 HTTP 客户端。
 * @param {number} [input.timeoutMs] - 查询超时。
 * @returns {Promise<{
 *   verdict: string,
 *   requiresConfirmation: boolean,
 *   requiresTypedConfirmation: boolean,
 *   reason: string,
 *   hint: string,
 *   confirmationPhrase: string,
 *   slug: string,
 *   host: string,
 *   source: string,
 *   detail: string
 * }>}
 */
export async function checkRepoVisibility(input = {}) {
  const { remoteUrl, visibilityHint, runGh, fetchJson, timeoutMs } = input
  const parsed = parseRemoteUrl(remoteUrl)

  // 解析失败：不是"安全"，是"无法判定"。
  if (!parsed.ok) {
    return buildResult({
      verdict: VERDICT.UNKNOWN,
      slug: '',
      host: '',
      source: 'parse',
      detail: parsed.reason,
    })
  }

  // 非 GitHub：没有可靠的自动判定手段，一律交给人确认。
  if (!isGitHubHost(parsed.host)) {
    const hinted = normalizeHint(visibilityHint)
    return buildResult({
      verdict: hinted || VERDICT.UNKNOWN,
      slug: parsed.slug,
      host: parsed.host,
      source: hinted ? 'hint' : 'host',
      detail: hinted
        ? `「${parsed.host}」不是 GitHub，无法实时确认；使用了已知的可见性记录。`
        : `「${parsed.host}」不是 GitHub，本插件无法自动确认它的可见性。`,
    })
  }

  const queried = await queryGitHubVisibility({ slug: parsed.slug, runGh, fetchJson, timeoutMs })
  return buildResult({
    verdict: queried.verdict,
    slug: parsed.slug,
    host: parsed.host,
    source: queried.source,
    detail: queried.detail,
  })
}

/**
 * 把已知的可见性提示规范化成判定值。
 *
 * 提示只是**弱证据**：它不能凭空把 `unknown` 变成 `private`，
 * 只有在"无法查询"时用来避免重复打扰用户。
 *
 * @param {unknown} hint
 * @returns {string|null}
 */
function normalizeHint(hint) {
  const value = String(hint ?? '').toLowerCase().trim()
  if (value === VERDICT.PRIVATE || value === VERDICT.PUBLIC) return value
  return null
}

/**
 * 把判定结果翻译成 UI 可直接用的结构和**中文文案**。
 *
 * 文案是产品的一部分：要说清「发生了什么」「为什么危险」「接下来怎么做」。
 *
 * @param {{verdict: string, slug: string, host: string, source: string, detail: string}} input
 * @returns {object} 完整的判定结果（见 {@link checkRepoVisibility} 的返回值）。
 */
function buildResult({ verdict, slug, host, source, detail }) {
  const base = { verdict, slug, host, source, detail }
  // 逐字确认的短语：让用户不得不**读一遍**他要推送到的仓库名。
  const phrase = slug || host || ''

  if (verdict === VERDICT.PRIVATE) {
    return {
      ...base,
      requiresConfirmation: false,
      requiresTypedConfirmation: false,
      confirmationPhrase: '',
      reason: `已确认「${slug || host}」是私有仓库，可以同步。`,
      hint: '',
    }
  }

  if (verdict === VERDICT.PUBLIC) {
    return {
      ...base,
      requiresConfirmation: true,
      requiresTypedConfirmation: true,
      confirmationPhrase: phrase,
      reason:
        '该仓库远端是公开仓库（public）。同步会话会把完整对话内容推上去，'
        + '任何能看到这个仓库的人都能读到。默认已阻止启用同步。',
      hint:
        '如果这不是你想要的结果：在 GitHub 上把仓库改成私有'
        + '（Settings → General → Danger Zone → Change visibility），然后重新检测。'
        + '如果你确实要推到公开仓库，需要输入下面的仓库名确认你了解风险。',
    }
  }

  // unknown：默认拒绝，同样需要逐字确认。
  return {
    ...base,
    requiresConfirmation: true,
    requiresTypedConfirmation: true,
    confirmationPhrase: phrase,
    reason:
      `无法自动确认「${slug || host || '这个仓库'}」是私有还是公开（${detail}）。`
      + '同步会话会把完整对话内容推到远端——如果这个仓库是公开的，那些对话就公开了。',
    hint:
      '如果这是你自己的 Gitee / GitLab / 自建服务，请先去那个平台上确认仓库可见性。'
      + '确认它是私有的之后，输入仓库名继续。',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 逐字确认
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 校验用户是否已经完成"逐字输入仓库名"的危险操作确认。
 *
 * **为什么是逐字输入而不是勾选框**：勾选框会被肌肉记忆点掉，逐字输入仓库名
 * 强制用户**读一遍**他要推送到的那个仓库。这是 GitHub 删除仓库用的同一手法，
 * 也是我们这里唯一能抵抗"点快了"的机制。
 *
 * @param {object} input
 * @param {object} input.check - {@link checkRepoVisibility} 的返回值。
 * @param {string} input.typed - 用户在确认框里输入的内容。
 * @param {boolean} [input.acknowledged] - 是否勾选"我了解风险"（部分 UI 会两者都要）。
 * @returns {{ok: boolean, reason: string}} `reason` 为中文（ok 时为空串）。
 */
export function verifyTypedConfirmation({ check, typed, acknowledged } = {}) {
  const c = check || {}

  // 私有仓库不需要任何确认。
  if (c.verdict === VERDICT.PRIVATE) return { ok: true, reason: '' }

  if (c.requiresTypedConfirmation !== true) {
    // 判定结果本身没要求确认，却在走确认流程 —— 说明调用方状态不一致，
    // 保守地要求重新检测，而不是放行。
    return { ok: false, reason: '这个仓库的可见性还没有检测过，请先点「检测可见性」。' }
  }

  const expected = String(c.confirmationPhrase ?? '').trim()
  const actual = String(typed ?? '').trim()

  if (!expected) {
    return { ok: false, reason: '这个仓库没有可确认的标识（远端地址可能不完整），请先修正远端地址。' }
  }
  if (actual === '') {
    return { ok: false, reason: `请在输入框里逐字输入「${expected}」以确认。` }
  }
  // 大小写不敏感：仓库名大小写在 URL 里不总是规范，不该因此卡住用户。
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    return { ok: false, reason: `输入的和仓库名不一致。请逐字输入「${expected}」。` }
  }
  if (acknowledged === false) {
    return { ok: false, reason: '请先勾选「我了解这会把对话内容推送到别人可见的地方」。' }
  }
  return { ok: true, reason: '' }
}

// ─────────────────────────────────────────────────────────────────────────────
// 第二层：每次上行前重校验
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对比上次记录的可见性与本次实时判定，判断是否发生了**安全退化**。
 *
 * 这是防"今天私有、明天转公开"的唯一有效手段：**拦截点不能只在启用时**，
 * 每次上行前都要重判一次。
 *
 * @param {object} input
 * @param {string} [input.previous] - 上次记录的 verdict。
 * @param {string} input.current - 本次判定的 verdict。
 * @returns {{ok: boolean, regression: boolean, reason: string}}
 *   `ok: false` 表示**必须中止本次上行**。
 */
export function detectRegression({ previous, current } = {}) {
  const prev = normalizeHint(previous)
  const curr = String(current ?? VERDICT.UNKNOWN)

  if (curr === VERDICT.PRIVATE) return { ok: true, regression: false, reason: '' }

  // 从"确认私有"变成"公开" —— 这是最危险的路径，必须中止。
  if (prev === VERDICT.PRIVATE && curr === VERDICT.PUBLIC) {
    return {
      ok: false,
      regression: true,
      reason:
        '这个仓库以前是私有的，现在检测到它变成了公开仓库。'
        + '为避免把对话内容推到公开仓库，本次同步已中止。'
        + '如果这是误判，请重新检测；如果确实改了可见性，请改回私有或换仓库。',
    }
  }

  if (curr === VERDICT.PUBLIC) {
    return {
      ok: false,
      regression: prev !== VERDICT.PUBLIC,
      reason: '检测到远端仓库是公开的，本次同步已中止。请改用私有仓库。',
    }
  }

  // unknown：如果之前确认过私有而现在判不出来，也中止——**查不到不等于安全**。
  if (prev === VERDICT.PRIVATE) {
    return {
      ok: false,
      regression: true,
      reason:
        '这个仓库以前确认是私有的，但现在无法确认它的可见性（可能是网络问题或权限变化）。'
        + '为了安全，本次同步已中止，请稍后重试或手动确认仓库可见性。',
    }
  }

  return {
    ok: false,
    regression: false,
    reason: '无法确认远端仓库的可见性，本次同步已中止。请先检测可见性并确认。',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 兼容旧调用名的薄封装
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 该判定是否需要用户显式确认才能同步。
 *
 * @param {string} verdict
 * @returns {boolean}
 */
export function requiresConfirmation(verdict) {
  return verdict !== VERDICT.PRIVATE
}

/**
 * 该判定是否**明确**不安全（公开仓库）。
 *
 * 注意：这**不是**"禁止同步"的意思——公开仓库仍可通过逐字确认放行，
 * 这只是给 UI 一个"用红色渲染"的判断依据。
 *
 * @param {string} verdict
 * @returns {boolean}
 */
export function isKnownUnsafe(verdict) {
  return verdict === VERDICT.PUBLIC
}
