/**
 * `dsh-repo-session-sync` — Host entry point.
 *
 * Sync DeepSeek Harness sessions across machines, keyed by **Git repository
 * identity** rather than by machine. Code already travels by `git push`; this
 * plugin makes the conversation travel with it.
 *
 * ## What this file does, and what it deliberately does not
 *
 * This is the *assembly*: read the Loader config, resolve paths, build the
 * store, instantiate the engine, and expose it through three surfaces —
 *
 *   1. **HTTP routes** under `/repo-session-sync/*`, for the settings page.
 *      Every route sits behind the Host's own connection trust fence, so this is
 *      not a second, weaker authentication surface.
 *   2. **A model-facing tool**, `repo_session_sync`, so the agent can perform a
 *      sync the same way the user can — through the identical engine method.
 *   3. **A system-prompt section**, so the model knows the capability exists and
 *      does not try to shell out to `git` to accomplish it.
 *
 * It contains no session parsing, no transport, and no conflict logic. Those are
 * behind the `src/deps.js` seams and arrive separately; when they are absent the
 * relevant calls report `not-implemented` while binding and settings keep
 * working. That ordering is intentional: a plugin whose settings page is
 * unreachable because the engine is a work in progress cannot be configured,
 * and an unconfigurable plugin cannot be tested.
 *
 * ## Why the Host does the filesystem and git work
 *
 * The browser half has neither a filesystem nor the user's `git` credentials.
 * Doing the work here means authentication stays with whatever `git` already
 * uses — osxkeychain, an SSH agent, a credential helper — so this plugin never
 * stores a token, and there is nothing for it to leak.
 *
 * @module dsh-repo-session-sync
 */

import { createRequire } from 'node:module'

import { createSyncEngine } from './engine.js'
import { assembleDependencies, detectSeams } from './deps.js'
import { StateStore } from './store.js'
import { createConfigSchema, resolveConfig, applyUserConfigPatch } from './config.js'
import { ERROR_CODES, SyncError, toFailureBody } from './errors.js'
import { displayPath } from './paths.js'
import { SYNC_DIRECTIONS, TRANSPORTS } from './repo-binding.js'

/**
 * Cordis hard dependencies.
 *
 * `webServer` and `connection` are declared because the settings page needs
 * them; resolving them through `ctx.get` inside `apply` would be too late —
 * Cordis calls `apply` as soon as the plugin's own dependencies are ready, and
 * on a cold start those two services may not have published yet. Declaring them
 * makes the framework wait instead of activating us into a thrown error.
 *
 * `tools` and `systemPrompt` are optional: a headless deployment may have no
 * prompt registry, and the plugin is still useful without them. They are
 * therefore looked up through `ctx.get`, never declared here.
 */
export const inject = ['webServer', 'connection']

/** Route prefix owned exclusively by this plugin. */
const PREFIX = '/repo-session-sync'

/** Model-facing tool name. Prefixed to stay unambiguous among ~100 tools. */
const TOOL_NAME = 'repo_session_sync'

/** This package's own version, read from the manifest rather than duplicated. */
const VERSION = (() => {
  try {
    const require = createRequire(import.meta.url)
    return String(require('./package.json').version ?? '0.0.0')
  } catch {
    // `package.json` is one directory up from `src/`; a linked install always has
    // it, but a stripped fixture might not, and a version string must never fail
    // activation.
    try {
      const require = createRequire(import.meta.url)
      return String(require('../package.json').version ?? '0.0.0')
    } catch {
      // Not fatal — a version string must never fail activation — but silence
      // here means the About line reads 0.0.0 with no explanation.
      console.warn('[dsh-repo-session-sync] 读不到 package.json 的版本，回退 0.0.0')
      return '0.0.0'
    }
  }
})()

/**
 * Read an optional Cordis service.
 *
 * Reading an undeclared service property throws in Cordis, so every optional
 * dependency goes through `ctx.get` with a guard.
 *
 * @param {unknown} ctx - Plugin context.
 * @param {string} name - Service name.
 * @returns {any} The service, or undefined when absent.
 */
function safeGet(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch (error) {
    // `ctx.get` throws when the read itself is not permitted. Swallowing that
    // would make the plugin behave as if the service were simply absent — a
    // wrong diagnosis that costs a debugging round, so name the service.
    ctx?.logger?.warn?.(
      `repo-session-sync: 读取服务 ${name} 失败，按「不可用」继续`,
      error instanceof Error ? error.message : String(error),
    )
    return undefined
  }
}

/**
 * Write one JSON response with no caching.
 *
 * `no-store` matters: these responses contain live sync state, and a cached
 * "已是最新" would be actively misleading a second later.
 *
 * @param {import('node:http').ServerResponse} res - Response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable payload.
 * @returns {void}
 */
function sendJson(res, status, body) {
  let text
  try {
    text = JSON.stringify(body)
  } catch {
    // A payload that cannot be serialized (a stray BigInt, a cycle) must still
    // produce a valid JSON error rather than an empty 500 from the server.
    text = JSON.stringify({ ok: false, code: ERROR_CODES.INTERNAL, message: '响应序列化失败。' })
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Read a request body with a byte cap.
 *
 * The cap is not a formality: this endpoint accepts a repository path and a
 * remote URL, and an unbounded read is a trivial memory-exhaustion vector on a
 * locally reachable service.
 *
 * @param {import('node:http').IncomingMessage} req - Request.
 * @param {number} [limit] - Maximum bytes.
 * @returns {Promise<string>} Body text.
 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    /** @type {Buffer[]} */
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new SyncError(ERROR_CODES.LIMIT_EXCEEDED, '请求体过大。'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Translate a thrown value into an HTTP status and payload.
 *
 * User-fixable codes are 4xx; anything unexpected is a 500 and deliberately
 * reports no internals.
 *
 * @param {unknown} error - Thrown value.
 * @returns {{ status: number, body: object }} Response description.
 */
function failure(error) {
  const body = toFailureBody(error)
  const userFixable = new Set([
    ERROR_CODES.BAD_REQUEST,
    ERROR_CODES.UNKNOWN_REPO,
    ERROR_CODES.NOT_CONFIGURED,
    ERROR_CODES.DIRECTION_FORBIDDEN,
    ERROR_CODES.NO_REMOTE,
    ERROR_CODES.PATH_UNSAFE,
    ERROR_CODES.LIMIT_EXCEEDED,
    ERROR_CODES.BUSY,
    ERROR_CODES.REPO_PATH_MISSING,
    ERROR_CODES.NOT_A_GIT_REPO,
    ERROR_CODES.CONFLICT_SESSION,
    ERROR_CODES.CONFLICT_BINDING,
    ERROR_CODES.BACKUP_FAILED,
    ERROR_CODES.REFUSED_UNSAFE_TARGET,
  ])
  if (error instanceof SyncError && error.code === ERROR_CODES.NOT_IMPLEMENTED) {
    return { status: 501, body }
  }
  return { status: userFixable.has(body.code) ? 400 : 500, body }
}

/**
 * The model-facing system-prompt section explaining this plugin's capability.
 *
 * Kept short and imperative. Its only jobs are: tell the model the capability
 * exists, tell it not to reimplement the transfer with `git` commands, and state
 * the one safety fact it must not get wrong (a download can overwrite sessions).
 *
 * @returns {string} Prompt text.
 */
function promptText() {
  return `## Repository session sync

This machine can synchronize DeepSeek Harness conversations across machines through \`${TOOL_NAME}\`, keyed by Git repository identity (remote URL + branch), not by filesystem path.

- Call \`${TOOL_NAME}\` with \`action: "status"\` to see bound repositories and their last sync state.
- \`action: "up"\` uploads this machine's sessions for a repository; \`action: "down"\` downloads them; \`action: "both"\` reconciles.
- Always pass \`dryRun: true\` first when the user has not explicitly asked to write, and report what would change.
- Downloading can replace local session logs. Never run a non-dry-run \`down\` or \`both\` without the user having asked for it in this conversation.
- Do not implement this transfer yourself with \`git\`, \`rsync\`, or by copying files: the plugin owns the sequencing, the pre-write backup, and the conflict rules.`
}

/**
 * Register the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 * @param {object} rawConfig - The Loader row config.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const webServer = safeGet(ctx, 'webServer')
  const connection = safeGet(ctx, 'connection')
  if (webServer === undefined || connection === undefined) {
    // A headless deployment has no settings page; failing activation there would
    // remove the tool and the prompt section too, for no benefit.
    ctx.logger?.info?.('repo-session-sync: 没有 webServer/connection，设置页与 HTTP 路由已跳过')
  }

  // ── facts that must come from services, not the environment ──────────────
  // Desktop boots the Host without DSH_HOME in the environment, so an
  // environment-only lookup resolves the wrong directory. `profileContext` is
  // the service that actually knows; see `paths.js` for the full ordering.
  const profileContextService = safeGet(ctx, 'profileContext')
  const profileFacts = profileContextService === undefined
    ? {}
    : {
        dir: typeof profileContextService.dir === 'string' ? profileContextService.dir : undefined,
        home: typeof profileContextService.home === 'string' ? profileContextService.home : undefined,
      }

  const store = new StateStore(
    resolveConfig(rawConfig, {
      version: 1,
      defaultDirection: 'both',
      defaultTransport: 'git-branch',
      autoSync: false,
      autoSyncIntervalMs: 0,
      promptVersion: 0,
      updatedAt: Date.now(),
    }, { profileContext: profileFacts }).paths,
  )

  // The user config is authoritative for the runtime switch, so it is read
  // before the final resolution rather than after.
  /** @type {import('./config.js').UserConfig} */
  let userConfig = {
    version: 1,
    defaultDirection: 'both',
    defaultTransport: 'git-branch',
    autoSync: false,
    autoSyncIntervalMs: 0,
    promptVersion: 0,
    updatedAt: Date.now(),
  }

  const log = {
    info: (/** @type {string} */ message, /** @type {unknown} */ detail) => ctx.logger?.info?.(`repo-session-sync: ${message}`, detail),
    warn: (/** @type {string} */ message, /** @type {unknown} */ detail) => ctx.logger?.warn?.(`repo-session-sync: ${message}`, detail),
    error: (/** @type {string} */ message, /** @type {unknown} */ detail) => ctx.logger?.error?.(`repo-session-sync: ${message}`, detail),
  }

  /** @type {any} */
  let engine = null
  /** @type {any} */
  let resolved = null

  // Wiring is asynchronous (reading the user config, probing for engine seams),
  // but `apply` is synchronous. The promise is stored and every entry point
  // awaits it, so a request that arrives during startup waits instead of racing.
  const ready = (async () => {
    userConfig = await store.readUserConfig().catch(() => userConfig)
    resolved = resolveConfig(rawConfig, userConfig, { profileContext: profileFacts })
    const dependencies = await assembleDependencies({ store, paths: resolved.paths, log })
    engine = createSyncEngine(dependencies, {
      pluginVersion: VERSION,
      config: sanitizeConfigForDisplay(resolved.config, resolved.paths),
    })
    const seams = await detectSeams()
    log.info('已加载', { stateDir: displayPath(resolved.paths.stateDir), seams })
    return { engine, config: resolved.config, paths: resolved.paths, seams }
  })().catch((error) => {
    log.error('初始化失败，插件以只读状态继续', error)
    throw error
  })

  /**
   * Await initialization, converting a startup failure into a stable envelope.
   *
   * @returns {Promise<{ engine: any, config: any, paths: any, seams: any } | { failure: object }>}
   *   Ready context or a failure body.
   */
  async function whenReady() {
    try {
      return await ready
    } catch (error) {
      return { failure: toFailureBody(error) }
    }
  }

  // ── HTTP surface ────────────────────────────────────────────────────────

  /**
   * Register one route with uniform body handling and error translation.
   *
   * @param {string} path - Path under {@link PREFIX}.
   * @param {'GET'|'POST'} method - Allowed method.
   * @param {(input: { url: URL, body: any }) => Promise<object>} handler - Handler returning a response body.
   * @returns {void}
   */
  const route = (path, method, handler) => {
    if (webServer === undefined) return
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: `${PREFIX}${path}`,
      async handler(req, res) {
        // The Host's own trust fence: same Host/Origin checks and browser-session
        // authentication that protect the rest of the UI. A second, hand-rolled
        // check here would be a weaker surface, not a stronger one.
        const rejection = connection.requestRejection({ headers: req.headers })
        if (rejection !== undefined) {
          sendJson(res, rejection, { ok: false, code: 'unauthorized', message: '请求被连接的信任栅栏拒绝。' })
          return
        }
        if (req.method !== method) {
          sendJson(res, 405, { ok: false, code: ERROR_CODES.BAD_REQUEST, message: `需要 ${method}。` })
          return
        }

        let body = {}
        if (method === 'POST') {
          const essence = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
          if (essence !== 'application/json') {
            sendJson(res, 415, {
              ok: false,
              code: ERROR_CODES.BAD_REQUEST,
              message: 'content-type 必须是 application/json。',
            })
            return
          }
          try {
            const text = await readBody(req)
            body = text === '' ? {} : JSON.parse(text)
          } catch (error) {
            sendJson(res, 400, toFailureBody(error))
            return
          }
        }

        try {
          const url = new URL(req.url ?? '/', 'http://dsh.invalid')
          const payload = await handler({ url, body })
          sendJson(res, 200, payload)
        } catch (error) {
          const { status, body: payload } = failure(error)
          sendJson(res, status, payload)
        }
      },
    }), `repo-session-sync: ${method} ${path}`)
  }

  // ── read ────────────────────────────────────────────────────────────────

  route('/status', 'GET', async () => {
    const context = await whenReady()
    if ('failure' in context) throw new SyncError(ERROR_CODES.INTERNAL, '插件初始化未完成。', { detail: context.failure })
    const status = await context.engine.status()
    return {
      ...status,
      settings: sanitizeUserConfig(userConfig),
      // Home-abbreviated on the Host so a screenshot of the page cannot leak a
      // full personal path.
      paths: displayPaths(context.paths),
      seams: context.seams,
      plugin: { name: 'dsh-repo-session-sync', version: VERSION },
    }
  })

  route('/bindings', 'GET', async () => {
    const context = await whenReady()
    if ('failure' in context) throw new SyncError(ERROR_CODES.INTERNAL, '插件初始化未完成。')
    const status = await context.engine.status()
    return { ok: true, repos: status.repos ?? [], dropped: status.dropped ?? [] }
  })

  // ── write ───────────────────────────────────────────────────────────────

  route('/settings', 'POST', async ({ body }) => {
    const context = await whenReady()
    if ('failure' in context) throw new SyncError(ERROR_CODES.INTERNAL, '插件初始化未完成。')
    userConfig = applyUserConfigPatch(userConfig, body)
    userConfig = await store.writeUserConfig(userConfig)
    applyTimer()
    return { ok: true, settings: sanitizeUserConfig(userConfig) }
  })

  route('/bind', 'POST', async ({ body }) => {
    const context = await whenReady()
    if ('failure' in context) throw new SyncError(ERROR_CODES.INTERNAL, '插件初始化未完成。')
    const result = await context.engine.bindRepo({
      repoPath: body?.repoPath,
      remoteUrl: body?.remoteUrl,
      branch: body?.branch,
      direction: body?.direction,
      transport: body?.transport,
      autoSync: body?.autoSync,
    })
    if (result?.ok === false) throw new SyncError(result.code, result.message, { hint: result.hint })
    return result
  })

  route('/unbind', 'POST', async ({ body }) => {
    const context = await whenReady()
    if ('failure' in context) throw new SyncError(ERROR_CODES.INTERNAL, '插件初始化未完成。')
    const result = await context.engine.unbindRepo({ repoId: body?.repoId })
    if (result?.ok === false) throw new SyncError(result.code, result.message, { hint: result.hint })
    return result
  })

  route('/binding', 'POST', async ({ body }) => {
    const context = await whenReady()
    if ('failure' in context) throw new SyncError(ERROR_CODES.INTERNAL, '插件初始化未完成。')
    const result = await context.engine.updateBinding({
      repoId: body?.repoId,
      direction: body?.direction,
      transport: body?.transport,
      autoSync: body?.autoSync,
      enabled: body?.enabled,
    })
    if (result?.ok === false) throw new SyncError(result.code, result.message, { hint: result.hint })
    return result
  })

  route('/sync', 'POST', async ({ body }) => {
    const context = await whenReady()
    if ('failure' in context) throw new SyncError(ERROR_CODES.INTERNAL, '插件初始化未完成。')
    const action = body?.action
    if (action !== 'up' && action !== 'down' && action !== 'both') {
      throw new SyncError(ERROR_CODES.BAD_REQUEST, 'action 必须是 up / down / both。')
    }
    const request = { repoId: body?.repoId, dryRun: body?.dryRun === true, force: body?.force === true }
    const result = action === 'up'
      ? await context.engine.up(request)
      : action === 'down'
        ? await context.engine.down(request)
        : await context.engine.both(request)
    // Engine results carry `ok`, so they are returned as-is rather than thrown:
    // a conflict report is a legitimate 200 with `ok: false` inside, and the UI
    // needs its `conflicts` array to render the resolution dialog.
    return result ?? { ok: false, code: ERROR_CODES.INTERNAL, message: '引擎没有返回结果。' }
  })

  // ── model-facing tool ───────────────────────────────────────────────────

  const toolsService = safeGet(ctx, 'tools')
  if (toolsService !== undefined) {
    const dispose = toolsService.register({
      name: TOOL_NAME,
      description:
        'Synchronize DeepSeek Harness conversations across machines, keyed by Git repository (remote URL + branch). '
        + 'Use action="status" to inspect bindings; "bind" to bind a repository path; "up" to upload this machine\'s '
        + 'sessions; "down" to download remote sessions; "both" to reconcile. '
        + 'Pass dryRun=true to preview. A non-dry-run down/both can replace local session logs, so only run one when '
        + 'the user has explicitly asked; the plugin always backs up first and never silently overwrites diverged sessions.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            required: true,
            enum: ['status', 'bind', 'unbind', 'up', 'down', 'both'],
            description: 'Operation to perform.',
          },
          repoId: {
            type: 'string',
            description: 'Binding id. Required for up/down/both/unbind; omit for status.',
          },
          repoPath: {
            type: 'string',
            description: 'Repository working-tree path. Required for bind.',
          },
          remoteUrl: {
            type: 'string',
            description: 'Git remote URL identifying the repository across machines. Lifts the direction restriction.',
          },
          branch: {
            type: 'string',
            description: 'Branch identity used in the sync key. Defaults to HEAD.',
          },
          direction: {
            type: 'string',
            enum: SYNC_DIRECTIONS,
            description: 'Allowed data flow for this binding.',
          },
          transport: {
            type: 'string',
            enum: TRANSPORTS,
            description: 'Channel that carries the session bundle.',
          },
          dryRun: {
            type: 'boolean',
            description: 'Preview the operation without writing anything. Defaults to false.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderToolResult(value) }],
      },
      async execute(input) {
        const context = await whenReady()
        if ('failure' in context) {
          return { ok: false, code: ERROR_CODES.INTERNAL, message: '插件初始化未完成。' }
        }
        const action = /** @type {string} */ (input?.action)
        try {
          switch (action) {
            case 'status': {
              const status = await context.engine.status()
              return { ok: status?.ok !== false, repos: status?.repos ?? [], paths: displayPaths(context.paths) }
            }
            case 'bind':
              return await context.engine.bindRepo({
                repoPath: input?.repoPath,
                remoteUrl: input?.remoteUrl,
                branch: input?.branch,
                direction: input?.direction,
                transport: input?.transport,
              })
            case 'unbind':
              return await context.engine.unbindRepo({ repoId: input?.repoId })
            case 'up':
              return await context.engine.up({ repoId: input?.repoId, dryRun: input?.dryRun === true })
            case 'down':
              return await context.engine.down({ repoId: input?.repoId, dryRun: input?.dryRun === true })
            case 'both':
              return await context.engine.both({ repoId: input?.repoId, dryRun: input?.dryRun === true })
            default:
              return { ok: false, code: ERROR_CODES.BAD_REQUEST, message: `未知的 action：${String(action)}` }
          }
        } catch (error) {
          return toFailureBody(error)
        }
      },
    })
    ctx.effect(() => dispose, 'repo-session-sync: tool')
  } else {
    log.warn('没有 tools 服务，模型无法直接调用同步工具')
  }

  // ── system prompt ───────────────────────────────────────────────────────

  const systemPromptService = safeGet(ctx, 'systemPrompt')
  const usePrompt = rawConfig?.useSystemPrompt === undefined || rawConfig.useSystemPrompt === true
  if (systemPromptService !== undefined && usePrompt) {
    // 645 places this just after the repository prompt sections and before the
    // agent-team policy at 650, so capability description comes before团队规则.
    ctx.effect(
      () => systemPromptService.section({
        name: 'repo-session-sync',
        order: 645,
        text: promptText(),
      }),
      'repo-session-sync: prompt section',
    )
  }

  // ── automatic sync ──────────────────────────────────────────────────────

  /** @type {NodeJS.Timeout|null} */
  let timer = null
  /** @type {number} */
  let timerMs = -1

  /**
   * Start, restart, or stop the automatic-sync timer.
   *
   * Re-read after every settings write so a changed interval takes effect
   * without a restart, which is what makes the switch feel like a switch.
   *
   * @returns {void}
   */
  function applyTimer() {
    const enabled = userConfig.autoSync === true && userConfig.autoSyncIntervalMs > 0
    const nextMs = enabled ? userConfig.autoSyncIntervalMs : 0
    if (nextMs === timerMs) return
    timerMs = nextMs
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (nextMs <= 0) return
    timer = setInterval(() => {
      void runAutomaticPass()
    }, nextMs)
    // Never keep the Host process alive on behalf of a sync timer.
    timer.unref?.()
  }

  /**
   * One automatic pass.
   *
   * Auto-sync only ever *uploads*, and only for bindings the user marked
   * `autoSync`. It never downloads on its own: a download replaces local session
   * logs, and doing that without a person present is exactly the silent-overwrite
   * failure this plugin exists to prevent.
   *
   * @returns {Promise<void>} Resolves when the pass finishes.
   */
  async function runAutomaticPass() {
    try {
      const context = await whenReady()
      if ('failure' in context) return
      const state = await context.engine.status()
      if (state?.busy === true) return
      for (const repo of state?.repos ?? []) {
        if (repo.autoSync !== true || repo.enabled !== true) continue
        const result = await context.engine.up({ repoId: repo.id, dryRun: false })
        if (result?.ok === false) log.warn(`自动上行 ${repo.id} 未完成：${result.code}`)
      }
    } catch (error) {
      log.warn('自动同步失败', error)
    }
  }

  void ready.then(() => applyTimer()).catch(() => {})

  ctx.effect(() => () => {
    if (timer !== null) clearInterval(timer)
    timer = null
  }, 'repo-session-sync: automatic sync timer')
}

/**
 * Render a tool result as compact text for the model.
 *
 * JSON rather than prose: the tool's contract is a stable envelope, and a model
 * reading prose has to parse it back to answer questions about `code`.
 *
 * @param {unknown} value - Tool result.
 * @returns {string} Text content.
 */
function renderToolResult(value) {
  if (value === null || typeof value !== 'object') return String(value)
  const source = /** @type {Record<string, unknown>} */ (value)
  if (source.ok === false) {
    const parts = [`失败：${String(source.code ?? 'unknown')}`, String(source.message ?? '')]
    if (typeof source.hint === 'string') parts.push(`建议：${source.hint}`)
    return parts.filter((part) => part !== '').join('\n')
  }
  return JSON.stringify(value, null, 2)
}

/**
 * Strip anything from the resolved config that must not reach the browser.
 *
 * Today the resolved config holds no credentials by design; this function exists
 * so that adding a field later cannot accidentally publish it. It is a allowlist,
 * not a denylist.
 *
 * @param {object} config - Resolved config.
 * @param {object} paths - Resolved paths.
 * @returns {object} Display-safe config.
 */
function sanitizeConfigForDisplay(config, paths) {
  return {
    stateDir: displayPath(paths.stateDir),
    gitPath: config?.gitPath ?? '',
    defaultDirection: config?.defaultDirection ?? 'both',
    defaultTransport: config?.defaultTransport ?? 'git-branch',
    syncBranch: config?.syncBranch ?? '',
    autoSync: config?.autoSync === true,
    autoSyncIntervalMs: config?.autoSyncIntervalMs ?? 0,
    maxSessionBytes: config?.maxSessionBytes ?? 0,
    maxBundleBytes: config?.maxBundleBytes ?? 0,
    keepBackups: config?.keepBackups ?? 0,
    useSystemPrompt: config?.useSystemPrompt !== false,
  }
}

/**
 * Project persisted user config onto what the settings page may see.
 *
 * @param {import('./config.js').UserConfig} config - Persisted config.
 * @returns {object} Display-safe user config.
 */
function sanitizeUserConfig(config) {
  return {
    defaultDirection: config.defaultDirection,
    defaultTransport: config.defaultTransport,
    autoSync: config.autoSync,
    autoSyncIntervalMs: config.autoSyncIntervalMs,
    promptVersion: config.promptVersion,
    updatedAt: config.updatedAt,
  }
}

/**
 * Home-abbreviate every path in the resolved path set.
 *
 * @param {object} paths - Resolved paths.
 * @returns {Record<string, string>} Display paths.
 */
function displayPaths(paths) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, value] of Object.entries(paths ?? {})) {
    if (typeof value === 'string' && value !== '') out[key] = displayPath(value)
  }
  return out
}

export { createConfigSchema, VERSION, TOOL_NAME }
