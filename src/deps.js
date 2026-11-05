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

  const [sessionModule, transportModule, conflictModule] = await Promise.all([
    importIfPresent('./session-store.js'),
    importIfPresent('./transport.js'),
    importIfPresent('./conflict.js'),
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

  return {
    store,
    paths,
    sessions,
    transport,
    conflicts,
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
  const [sessionModule, transportModule, conflictModule] = await Promise.all([
    importIfPresent('./session-store.js'),
    importIfPresent('./transport.js'),
    importIfPresent('./conflict.js'),
  ])
  return {
    sessions: sessionModule !== undefined,
    transport: transportModule !== undefined,
    conflicts: conflictModule !== undefined,
  }
}
