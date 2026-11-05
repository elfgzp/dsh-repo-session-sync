/**
 * Dependency assembly for the synchronization engine.
 *
 * `src/engine.js` declares *what* it needs; this file decides *where those come
 * from*. Keeping that decision here means the entry point never imports an
 * unfinished module directly, so a half-built engine degrades into clean
 * `not-implemented` results instead of a boot failure that would disable the
 * whole plugin (and, with it, the settings page the user needs to fix things).
 *
 * ## The seam
 *
 * Each implementation lives in its own module, owned separately:
 *
 * | Module                  | Responsibility                     | Owner        |
 * |-------------------------|------------------------------------|--------------|
 * | `src/session-store.js`  | read/write DSH session logs        | sync engine  |
 * | `src/transport.js`      | up/down over a transport channel   | sync engine  |
 * | `src/conflict.js`       | never-silently-overwrite decisions | sync engine  |
 *
 * A module is loaded only when it exists and can be imported. When it is absent,
 * the corresponding stub is used and every operation that needs it reports
 * `not-implemented` with a specific message, rather than throwing something
 * opaque.
 *
 * This is deliberately *not* a plugin registry: there is exactly one
 * implementation of each seam in this package, and a registry would make it
 * possible to bind a different one by configuration — a capability this plugin
 * must not hand to a config file.
 *
 * @module dsh-repo-session-sync/deps
 */

import { SyncError, ERROR_CODES } from './errors.js'

/**
 * Import a sibling module that may not exist yet.
 *
 * A static `import` of a missing file is a hard boot failure, which is why this
 * uses a dynamic import. Only `ERR_MODULE_NOT_FOUND` is swallowed; a module that
 * exists but throws on evaluation is a real defect and must surface.
 *
 * @param {string} specifier - Relative module specifier.
 * @returns {Promise<Record<string, unknown> | undefined>} Module namespace, or undefined when absent.
 */
async function importIfPresent(specifier) {
  try {
    return await import(specifier)
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return undefined
    throw error
  }
}

/**
 * Build a stub that reports a missing implementation precisely.
 *
 * @param {string} seam - Which seam, for the message.
 * @param {string} moduleName - The module that is expected to provide it.
 * @param {string[]} methods - Method names the seam must expose.
 * @returns {Record<string, Function>} Stub object.
 */
function missingSeam(seam, moduleName, methods) {
  /** @type {Record<string, Function>} */
  const stub = {}
  for (const method of methods) {
    stub[method] = async () => {
      throw new SyncError(
        ERROR_CODES.NOT_IMPLEMENTED,
        `同步引擎的「${seam}」尚未接入（缺少 ${moduleName}）。`,
        {
          hint: '仓库绑定与设置已经可用；同步功能由引擎实现接入后启用。',
          detail: { seam, module: moduleName, method },
        },
      )
    }
  }
  return stub
}

/**
 * Assemble the engine dependencies.
 *
 * @param {object} context - Wiring context.
 * @param {object} context.store - Persistence layer.
 * @param {object} context.paths - Resolved directories.
 * @param {{ info?: Function, warn?: Function, error?: Function }} context.log - Logger.
 * @returns {Promise<import('./engine.js').EngineDependencies>} Dependencies for `createSyncEngine`.
 */
export async function assembleDependencies(context) {
  const { store, paths, log } = context

  const [
    sessionModule,
    transportModule,
    conflictModule,
    registryModule,
    visibilityModule,
  ] = await Promise.all([
    importIfPresent('./session-store.js'),
    importIfPresent('./transport.js'),
    importIfPresent('./conflict.js'),
    importIfPresent('./registry.js'),
    importIfPresent('./repo-visibility.js'),
  ])

  const sessions = sessionModule?.createSessionSource !== undefined
    ? sessionModule.createSessionSource({ store, paths, log })
    : sessionModule?.default !== undefined
      ? sessionModule.default({ store, paths, log })
      : missingSeam('会话读取层', 'src/session-store.js', ['list', 'read', 'write'])

  const transport = transportModule?.createTransport !== undefined
    ? transportModule.createTransport({ store, paths, log })
    : transportModule?.default !== undefined
      ? transportModule.default({ store, paths, log })
      : missingSeam('传输通道', 'src/transport.js', ['push', 'pull', 'probe'])

  const conflicts = conflictModule?.createConflictResolver !== undefined
    ? conflictModule.createConflictResolver({ store, paths, log })
    : conflictModule?.default !== undefined
      ? conflictModule.default({ store, paths, log })
      : missingSeam('冲突处理', 'src/conflict.js', ['decide'])

  // The registry seam is a *function set*, not a stateful object: every helper
  // takes the live `ctx.workspaceRegistry` as a parameter. That signature is what
  // keeps `registry.js` unit-testable without a DSH host — a closure over the
  // service here would make it untestable and tempt the engine to call a
  // half-wired object.
  const registry = registryModule !== undefined
    ? {
        preflightRepoPath: registryModule.preflightRepoPath,
        ensureWorkspaceAndAttach: registryModule.ensureWorkspaceAndAttach,
        rollbackNewSessions: registryModule.rollbackNewSessions,
        canonicalRepoPath: registryModule.canonicalRepoPath,
      }
    : missingSeam('工作区登记', 'src/registry.js', [
        'preflightRepoPath',
        'ensureWorkspaceAndAttach',
        'rollbackNewSessions',
      ])

  const visibility = visibilityModule !== undefined
    ? {
        checkRepoVisibility: visibilityModule.checkRepoVisibility,
        detectRegression: visibilityModule.detectRegression,
        requiresConfirmation: visibilityModule.requiresConfirmation,
      }
    : missingSeam('可见性判定', 'src/repo-visibility.js', ['checkRepoVisibility', 'detectRegression'])

  // Session helpers the engine needs beyond the `list/read/write` triple. Kept
  // separate from `sessions` so a missing module degrades one operation at a
  // time instead of disabling the whole surface.
  const sessionOps = sessionModule !== undefined
    ? {
        appendToSession: sessionModule.appendToSession,
        classifyIncoming: sessionModule.classifyIncoming,
        parseSessionLog: sessionModule.parseSessionLog,
        decodeLogBuffer: sessionModule.decodeLogBuffer,
        isSessionLive: sessionModule.isSessionLive,
        sessionsRoot: sessionModule.sessionsRoot,
        // 回滚用：把「追加过的会话」还原到追加前，而不是删掉它。
        // 缺了它，append 失败时就只能选择「删」或「留下不一致状态」。
        restoreSessionFromBackup: sessionModule.restoreSessionFromBackup,
        // 判定「写入前本机是否已有该会话」需要这两个路径工具：
        // created 标记错了就会删掉用户历史，所以判定不依赖解析是否成功。
        projectKey: sessionModule.projectKey,
        encodeSegment: sessionModule.encodeSegment,
      }
    : missingSeam('会话增量写入', 'src/session-store.js', ['appendToSession', 'classifyIncoming'])

  return {
    store,
    paths,
    sessions,
    sessionOps,
    transport,
    conflicts,
    registry,
    visibility,
    log: {
      info: (/** @type {string} */ message, /** @type {unknown} */ detail) => log?.info?.(message, detail),
      warn: (/** @type {string} */ message, /** @type {unknown} */ detail) => log?.warn?.(message, detail),
      error: (/** @type {string} */ message, /** @type {unknown} */ detail) => log?.error?.(message, detail),
    },
  }
}

/**
 * Report which seams are currently implemented, for diagnostics and tests.
 *
 * The settings page renders this in its About block so a user on a半成品 build can
 * see why sync is disabled instead of assuming the plugin is broken.
 *
 * @returns {Promise<{ sessions: boolean, transport: boolean, conflicts: boolean }>}
 *   Availability of each seam.
 */
export async function detectSeams() {
  const [
    sessionModule,
    transportModule,
    conflictModule,
    registryModule,
    visibilityModule,
  ] = await Promise.all([
    importIfPresent('./session-store.js'),
    importIfPresent('./transport.js'),
    importIfPresent('./conflict.js'),
    importIfPresent('./registry.js'),
    importIfPresent('./repo-visibility.js'),
  ])
  return {
    sessions: sessionModule !== undefined,
    transport: transportModule !== undefined,
    conflicts: conflictModule !== undefined,
    registry: registryModule !== undefined,
    visibility: visibilityModule !== undefined,
  }
}
