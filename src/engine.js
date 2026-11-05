/**
 * The synchronization engine interface.
 *
 * This file is the **contract** between the plugin skeleton (entry point, tool,
 * settings routes) and the synchronization implementation. It deliberately
 * contains no session parsing, no transport, and no conflict resolution: those
 * live behind the five seams named in {@link EngineDependencies}, so the
 * implementation can land module by module without the entry point changing.
 *
 * ## Why an interface instead of direct calls
 *
 * The entry point must be written and reviewed *before* the engine exists,
 * because the tool schema, the HTTP routes, and the settings page all depend on
 * the shape of engine results. Freezing the result envelope now means the UI can
 * be built against stable data and the engine can be verified against the same
 * envelope, instead of both sides guessing.
 *
 * ## The result envelope contract
 *
 * Every public method resolves — it never rejects — with one of:
 *
 *     { ok: true,  ...payload }
 *     { ok: false, code: <ERROR_CODES>, message: string, hint?, repoId?, detail? }
 *
 * `code` is the part the UI switches on. A method that throws is a contract
 * violation, not a user-visible condition: the caller still normalizes it, but
 * the failure renders as `internal-error` with no actionable hint.
 *
 * @module dsh-repo-session-sync/engine
 */

import { ERROR_CODES, SyncError, ok, toFailureBody } from './errors.js'
import { allowsDown, allowsUp } from './repo-binding.js'

/**
 * The seams the engine implementation fills in.
 *
 * Each is a plain object of async methods so it can be replaced with a fake in
 * tests without a module loader, a filesystem, or a network.
 *
 * @typedef {object} EngineDependencies
 * @property {object} store - Persistence; see `src/store.js`.
 * @property {object} paths - Resolved directories; see `src/paths.js`.
 * @property {SessionSource} sessions - Reads and writes DSH sessions.
 * @property {TransportChannel} transport - Moves bundles to and from the remote.
 * @property {ConflictResolver} conflicts - Decides what to do when both sides moved.
 * @property {{ info: Function, warn: Function, error: Function }} log - Structured logger.
 */

/**
 * Reads DSH sessions for a repository and writes them back on download.
 *
 * Implemented in `src/session-store.js`.
 *
 * @typedef {object} SessionSource
 * @property {(binding: object, options?: object) => Promise<SessionDescriptor[]>} list
 *   Enumerate sessions belonging to a repository. Must return `[]` rather than
 *   throwing when the repository has no sessions yet.
 * @property {(sessionId: string) => Promise<SessionPayload>} read
 *   Read one session's full append-only event stream. Must validate that the
 *   session id is a safe segment before touching the filesystem.
 * @property {(payload: SessionPayload, options: { backupDir: string }) => Promise<{ written: string[], skipped: string[], backupPath: string }>} write
 *   Write a downloaded session. **Must snapshot the destination before
 *   modifying it** and must report where that snapshot went. A write that
 *   cannot produce a backup must fail with `backup-failed` instead of writing.
 */

/**
 * One session belonging to a bound repository, as the engine sees it.
 *
 * @typedef {object} SessionDescriptor
 * @property {string} sessionId - DSH session id (safe path segment).
 * @property {string} repoId - Owning binding.
 * @property {number} eventCount - How many events the log currently holds.
 * @property {number} bytes - Size of the session log on disk.
 * @property {number} updatedAt - Last modification time, epoch ms.
 * @property {string} [cwd] - Working directory the session was started in.
 * @property {string} [watermark] - Opaque incremental cursor for this session.
 * @property {boolean} [archived] - Whether DSH has archived it.
 */

/**
 * A session plus the watermark needed to resume an incremental transfer.
 *
 * @typedef {object} SessionPayload
 * @property {number} version - Payload format version, currently 1.
 * @property {string} sessionId - DSH session id.
 * @property {string} repoKey - Canonical repository identity.
 * @property {number} eventCount - Total events in the stream.
 * @property {string} watermark - Cursor a later incremental read can resume from.
 * @property {string} contentHash - Digest of the content, for conflict detection.
 * @property {Buffer|Uint8Array|string} content - The encoded event stream.
 * @property {number} updatedAt - Epoch ms of the newest event.
 */

/**
 * Moves session bundles to and from the remote.
 *
 * Implemented in `src/transport.js`.
 *
 * @typedef {object} TransportChannel
 * @property {(binding: object, bundle: object, options: object) => Promise<object>} push
 *   Upload a bundle. Must be a no-op reporting `up-to-date` when the remote
 *   already holds the same content.
 * @property {(binding: object, options: object) => Promise<object|null>} pull
 *   Fetch the remote bundle, or `null` when the remote holds nothing yet.
 * @property {(binding: object, options: object) => Promise<object>} probe
 *   Report reachability and the remote head without transferring payloads.
 */

/**
 * Decides the outcome when local and remote disagree.
 *
 * Implemented in `src/conflict.js`.
 *
 * @typedef {object} ConflictResolver
 * @property {(input: { local: object, remote: object, binding: object }) => ConflictDecision} decide
 *   Classify the pair. Must **never** return `overwrite` for a session that
 *   advanced on both sides; the safe outcomes are `keep-both` and `refuse`.
 */

/**
 * What to do about one conflicting session.
 *
 * @typedef {object} ConflictDecision
 * @property {'local-wins'|'remote-wins'|'keep-both'|'refuse'|'no-conflict'} kind
 *   Chosen outcome.
 * @property {string} reason - Stable short reason for the report and the log.
 * @property {string} [detail] - Human-readable explanation for the UI.
 */

/**
 * Progress event emitted during a long operation.
 *
 * @typedef {object} SyncProgress
 * @property {string} phase - `probe` | `upload` | `download` | `verify` | `commit`.
 * @property {number} [completed] - Units finished in this phase.
 * @property {number} [total] - Units expected in this phase.
 * @property {string} [message] - Human-readable progress note.
 */

/**
 * The result of one sync operation.
 *
 * @typedef {object} SyncResult
 * @property {boolean} ok - Whether the operation completed without a blocking failure.
 * @property {string} [code] - Outcome code when not ok, from `ERROR_CODES`.
 * @property {string} repoId - Repository the operation ran for.
 * @property {'up'|'down'|'both'} direction - Direction that was requested.
 * @property {boolean} dryRun - Whether anything was actually written.
 * @property {number} sessionCount - Sessions considered.
 * @property {number} transferred - Sessions actually moved.
 * @property {number} skipped - Sessions deliberately left alone.
 * @property {number} bytes - Payload bytes transferred.
 * @property {ConflictReportEntry[]} conflicts - Conflicts encountered.
 * @property {string} [backupPath] - Where the pre-write backup went, if one was made.
 * @property {string} [message] - Human-readable summary.
 * @property {number} startedAt - Epoch ms.
 * @property {number} finishedAt - Epoch ms.
 */

/**
 * One entry of a conflict report.
 *
 * @typedef {object} ConflictReportEntry
 * @property {string} sessionId - Which session conflicted.
 * @property {'local-wins'|'remote-wins'|'keep-both'|'refuse'} kind - Outcome applied.
 * @property {string} reason - Stable reason for the log.
 * @property {string} [detail] - Human-readable explanation.
 * @property {string} [keptLocalPath] - Where the local copy was preserved.
 * @property {string} [keptRemotePath] - Where the remote copy was preserved.
 */

/**
 * Engine status snapshot for the settings page and the tool.
 *
 * @typedef {object} EngineStatus
 * @property {object} config - Resolved configuration, minus anything secret.
 * @property {object} paths - Resolved directories, home-abbreviated for display.
 * @property {object[]} repos - One row per binding with its last-run state.
 * @property {boolean} busy - Whether an operation currently holds the mutex.
 * @property {string|null} busyOperation - Which operation holds it.
 * @property {string} pluginVersion - This package's version.
 */

/**
 * A mutex that refuses concurrent mutations instead of queueing them.
 *
 * Queueing would be worse for this plugin: a user who double-clicks "sync" would
 * get two sequential network operations and no feedback about the second. A
 * refusal with `busy` is honest and immediately actionable.
 */
export class OperationLock {
  constructor() {
    /** @type {string|null} */
    this.operation = null
  }

  /**
   * Whether an operation is in flight.
   *
   * @returns {boolean} True when locked.
   */
  get busy() {
    return this.operation !== null
  }

  /**
   * Run a function under the lock.
   *
   * @template T
   * @param {string} name - Operation name, surfaced in `status()`.
   * @param {() => Promise<T>} work - Critical section.
   * @returns {Promise<T>} The work's result.
   * @throws {SyncError} With `busy` when another operation holds the lock.
   */
  async run(name, work) {
    if (this.operation !== null) {
      throw new SyncError(
        ERROR_CODES.BUSY,
        `正在执行「${this.operation}」，请等它结束。`,
        { hint: '如果它卡住了，刷新页面后再试一次。' },
      )
    }
    this.operation = name
    try {
      return await work()
    } finally {
      this.operation = null
    }
  }
}

/**
 * Build the engine facade.
 *
 * Every method is wrapped so that a thrown value — including a contract
 * violation from a not-yet-implemented dependency — becomes a normalized
 * failure envelope. Callers therefore never need a `try`/`catch`, which is what
 * keeps the tool and the HTTP routes small and uniform.
 *
 * @param {EngineDependencies} dependencies - Implementation seams.
 * @param {{ pluginVersion?: string, config?: object }} [meta] - Facts for `status()`.
 * @returns {SyncEngineFacade} The engine.
 */
export function createSyncEngine(dependencies, meta = {}) {
  const { store, paths, sessions, transport, conflicts, log } = dependencies
  const lock = new OperationLock()
  const pluginVersion = meta.pluginVersion ?? '0.0.0'
  const config = meta.config ?? {}

  /**
   * Wrap one operation: lock it, normalize failures, and always log the outcome.
   *
   * @param {string} name - Operation name for the lock and the log.
   * @param {() => Promise<object>} work - Operation body.
   * @returns {Promise<object>} A result envelope.
   */
  async function guard(name, work) {
    try {
      const result = await lock.run(name, work)
      await store.appendLog({ op: name, result: result?.ok === false ? 'failed' : 'ok', ...loggable(result) })
      return result
    } catch (error) {
      const body = toFailureBody(error)
      // Log the real error, including its cause; only the sanitized body crosses
      // the trust fence into the browser.
      log?.error?.(`${name} 失败`, error)
      await store.appendLog({ op: name, result: 'failed', code: body.code })
      return body
    }
  }

  /**
   * Project a result onto the fields worth keeping in the operation log.
   *
   * @param {unknown} result - Operation result.
   * @returns {Record<string, unknown>} Log-safe subset.
   */
  function loggable(result) {
    if (result === null || typeof result !== 'object') return {}
    const source = /** @type {Record<string, unknown>} */ (result)
    /** @type {Record<string, unknown>} */
    const picked = {}
    for (const key of ['repoId', 'direction', 'transferred', 'skipped', 'bytes', 'dryRun']) {
      if (source[key] !== undefined) picked[key] = source[key]
    }
    if (Array.isArray(source.conflicts) && source.conflicts.length > 0) {
      picked.conflicts = source.conflicts.length
    }
    return picked
  }

  /**
   * Resolve a binding by id, failing with a user-fixable code when absent.
   *
   * @param {string} repoId - Binding id.
   * @returns {Promise<import('./repo-binding.js').RepoBinding>} The binding.
   * @throws {SyncError} With `unknown-repo`.
   */
  async function requireBinding(repoId) {
    if (typeof repoId !== 'string' || repoId === '') {
      throw new SyncError(ERROR_CODES.BAD_REQUEST, '需要指定要操作的仓库。', {
        hint: '在设置页里选一个已绑定的仓库，或先绑定一个。',
      })
    }
    const { table } = await store.readBindings()
    const binding = table.get(repoId)
    if (binding === undefined) {
      throw new SyncError(ERROR_CODES.UNKNOWN_REPO, '没有找到这个仓库绑定。', {
        hint: '刷新设置页后重试，或重新绑定这个仓库。',
        repoId,
      })
    }
    return binding
  }

  /**
   * Start a result skeleton so every path fills the same fields.
   *
   * @param {object} binding - Binding being operated on.
   * @param {'up'|'down'|'both'} direction - Requested direction.
   * @param {boolean} dryRun - Whether writes are suppressed.
   * @returns {SyncResult} A zeroed result.
   */
  function blankResult(binding, direction, dryRun) {
    return {
      ok: true,
      repoId: binding?.id ?? '',
      direction,
      dryRun,
      sessionCount: 0,
      transferred: 0,
      skipped: 0,
      bytes: 0,
      conflicts: [],
      startedAt: Date.now(),
      finishedAt: Date.now(),
    }
  }

  /** @type {SyncEngineFacade} */
  const engine = {
    /**
     * Report configuration, bindings, and per-repository state.
     *
     * Never touches the network: a settings page must render on a plane.
     *
     * @returns {Promise<object>} `{ ok: true, ...EngineStatus }`.
     */
    async status() {
      return guard('status', async () => {
        const { table, dropped } = await store.readBindings()
        const state = await store.readState()
        const repos = table.list().map((binding) => ({
          ...binding,
          state: state.repos[binding.id] ?? null,
          // `ready` is what the UI colours its row by; it is derived here so the
          // browser never has to reimplement the rule.
          ready: binding.enabled && allowsUp(binding.direction) !== allowsDown(binding.direction)
            ? binding.enabled
            : binding.enabled,
        }))
        return ok({
          repos,
          dropped,
          busy: lock.busy,
          busyOperation: lock.operation,
          pluginVersion,
          config,
          paths,
          state: state.repos,
        })
      })
    },

    /**
     * Upload this machine's sessions for one repository.
     *
     * @param {{ repoId: string, dryRun?: boolean, onProgress?: (event: SyncProgress) => void }} [request]
     *   Request options.
     * @returns {Promise<object>} `{ ok: true, ...SyncResult }` or a failure envelope.
     */
    async up(request = {}) {
      const repoId = String(request?.repoId ?? '')
      const dryRun = request?.dryRun === true
      return guard('up', async () => {
        const binding = await requireBinding(repoId)
        if (!allowsUp(binding.direction)) {
          throw new SyncError(
            ERROR_CODES.DIRECTION_FORBIDDEN,
            '这个仓库被配置为只向下同步，不会上传。',
            { hint: '在上行或双向模式下才能上传。', repoId },
          )
        }
        return runDirection(binding, 'up', dryRun, request)
      })
    },

    /**
     * Download remote sessions for one repository.
     *
     * **Safety contract:** with `dryRun: false` this method is responsible for
     * producing its own backup before it writes anything. It must not delegate
     * that obligation to the caller, and a failure to back up is a hard stop
     * reported as `backup-failed`, never a "best effort" write. A crash mid-write
     * must leave the previous state recoverable from that backup.
     *
     * @param {{ repoId: string, dryRun?: boolean, force?: boolean, onProgress?: (event: SyncProgress) => void }} [request]
     *   Request options.
     * @returns {Promise<object>} `{ ok: true, ...SyncResult }` or a failure envelope.
     */
    async down(request = {}) {
      const repoId = String(request?.repoId ?? '')
      const dryRun = request?.dryRun === true
      return guard('down', async () => {
        const binding = await requireBinding(repoId)
        if (!allowsDown(binding.direction)) {
          throw new SyncError(
            ERROR_CODES.DIRECTION_FORBIDDEN,
            '这个仓库被配置为只向上同步，不会下载。',
            { hint: '在下行或双向模式下才能下载。', repoId },
          )
        }
        return runDirection(binding, 'down', dryRun, request)
      })
    },

    /**
     * Reconcile in both directions.
     *
     * Runs down-then-up rather than up-then-down so that a remote advancement
     * discovered during the download is not published back as if it were local
     * work.
     *
     * @param {{ repoId: string, dryRun?: boolean, onProgress?: (event: SyncProgress) => void }} [request]
     *   Request options.
     * @returns {Promise<object>} `{ ok: true, ...SyncResult }` or a failure envelope.
     */
    async both(request = {}) {
      const repoId = String(request?.repoId ?? '')
      const dryRun = request?.dryRun === true
      return guard('both', async () => {
        const binding = await requireBinding(repoId)
        const downResult = allowsDown(binding.direction)
          ? await runDirection(binding, 'down', dryRun, request)
          : null
        const upResult = allowsUp(binding.direction)
          ? await runDirection(binding, 'up', dryRun, request)
          : null
        return mergeDirectionResults(binding, dryRun, downResult, upResult)
      })
    },

    /**
     * Bind a repository path.
     *
     * @param {{ repoPath?: string, remoteUrl?: string, branch?: string, direction?: string, transport?: string, autoSync?: boolean }} [request]
     *   Binding facts. `remoteUrl`/`branch` may be omitted when `remoteUrl` is
     *   discoverable from the path by the caller.
     * @returns {Promise<object>} `{ ok: true, binding, replaced }` or a failure envelope.
     */
    async bindRepo(request = {}) {
      return guard('bind-repo', async () => {
        const { createBinding } = await import('./repo-binding.js')
        const binding = createBinding({
          repoPath: request?.repoPath,
          remoteUrl: request?.remoteUrl,
          branch: request?.branch,
          direction: request?.direction,
          transport: request?.transport,
          autoSync: request?.autoSync,
        })
        const { table } = await store.readBindings()
        const result = table.upsert(binding)
        await store.writeBindings(table)
        return ok({ binding: result.binding, replaced: result.replaced })
      })
    },

    /**
     * Remove a binding. Never deletes sessions or backups.
     *
     * @param {{ repoId: string }} request - Which binding.
     * @returns {Promise<object>} `{ ok: true, removed: true }` or a failure envelope.
     */
    async unbindRepo(request = {}) {
      return guard('unbind-repo', async () => {
        const binding = await requireBinding(String(request?.repoId ?? ''))
        const { table } = await store.readBindings()
        table.remove(binding.id)
        await store.writeBindings(table)
        return ok({ removed: true, repoId: binding.id })
      })
    },

    /**
     * Change one binding's direction, transport, or auto-sync flag.
     *
     * @param {{ repoId: string, direction?: string, transport?: string, autoSync?: boolean, enabled?: boolean }} [request]
     *   Fields to change.
     * @returns {Promise<object>} `{ ok: true, binding }` or a failure envelope.
     */
    async updateBinding(request = {}) {
      return guard('update-binding', async () => {
        const { createBinding } = await import('./repo-binding.js')
        const existing = await requireBinding(String(request?.repoId ?? ''))
        const next = createBinding(
          {
            direction: request?.direction,
            transport: request?.transport,
            autoSync: request?.autoSync,
            enabled: request?.enabled,
          },
          { existing },
        )
        const { table } = await store.readBindings()
        table.upsert(next)
        await store.writeBindings(table)
        return ok({ binding: next })
      })
    },

    /**
     * Probe the remote for one binding without transferring payloads.
     *
     * @param {{ repoId: string }} request - Which binding.
     * @returns {Promise<object>} `{ ok: true, probe }` or a failure envelope.
     */
    async probe(request = {}) {
      return guard('probe', async () => {
        const binding = await requireBinding(String(request?.repoId ?? ''))
        const probe = await transport.probe(binding, {})
        return ok({ probe })
      })
    },

    /**
     * Currently held lock, for the UI's busy indicator.
     *
     * @returns {{ busy: boolean, operation: string|null }} Lock state.
     */
    lockState() {
      return { busy: lock.busy, operation: lock.operation }
    },
  }

  /**
   * Run one direction for one binding.
   *
   * Kept private so `up`, `down`, and `both` share exactly one code path for
   * conflict reporting, backup sequencing, and state persistence.
   *
   * @param {object} binding - Binding to operate on.
   * @param {'up'|'down'} direction - Direction to run.
   * @param {boolean} dryRun - Whether writes are suppressed.
   * @param {object} request - Original request, for `onProgress`.
   * @returns {Promise<SyncResult>} The result.
   */
  async function runDirection(binding, direction, dryRun, request) {
    const result = blankResult(binding, direction, dryRun)
    const progress = typeof request?.onProgress === 'function' ? request.onProgress : undefined

    // TODO(sync-engine): the implementation lands here. The sequence is fixed by
    // the interface and must not be reordered:
    //
    //   up:   sessions.list → read each → transport.push(dryRun) → writeState
    //   down: transport.pull → verify → BACKUP → conflicts.decide per session
    //         → sessions.write(backupDir) → writeState
    //
    // The backup step is not optional and not the caller's job: if it fails, the
    // method must return `backup-failed` before any session is written.
    void sessions
    void transport
    void conflicts
    void progress

    result.finishedAt = Date.now()
    return ok({
      ...result,
      // The skeleton reports honestly instead of pretending success: a UI that
      // shows "已同步" for an unimplemented engine would be a lie the user acts on.
      ok: false,
      code: ERROR_CODES.NOT_IMPLEMENTED,
      message: '同步引擎尚未接入（骨架阶段）。',
      hint: '仓库绑定与设置已经可用；同步功能由引擎实现接入后启用。',
    })
  }

  /**
   * Combine a down result and an up result into one `both` result.
   *
   * @param {object} binding - Binding operated on.
   * @param {boolean} dryRun - Whether writes were suppressed.
   * @param {SyncResult|null} downResult - Downward leg, when permitted.
   * @param {SyncResult|null} upResult - Upward leg, when permitted.
   * @returns {object} Combined result envelope.
   */
  function mergeDirectionResults(binding, dryRun, downResult, upResult) {
    const combined = blankResult(binding, 'both', dryRun)
    let ok0 = true
    let code
    let message
    let hint

    for (const leg of [downResult, upResult]) {
      if (leg === null) continue
      if (leg?.ok === false) {
        ok0 = false
        code = code ?? leg.code
        message = message ?? leg.message
        hint = hint ?? leg.hint
      }
      combined.sessionCount += Number(leg?.sessionCount ?? 0)
      combined.transferred += Number(leg?.transferred ?? 0)
      combined.skipped += Number(leg?.skipped ?? 0)
      combined.bytes += Number(leg?.bytes ?? 0)
      if (Array.isArray(leg?.conflicts)) combined.conflicts.push(...leg.conflicts)
      if (typeof leg?.backupPath === 'string') combined.backupPath = leg.backupPath
    }

    combined.finishedAt = Date.now()
    if (!ok0) return { ok: false, code: code ?? ERROR_CODES.INTERNAL, message: message ?? '双向同步未完成。', hint }
    return ok({ ...combined })
  }

  return engine
}

/**
 * @typedef {object} SyncEngineFacade
 * @property {() => Promise<object>} status
 * @property {(request?: object) => Promise<object>} up
 * @property {(request?: object) => Promise<object>} down
 * @property {(request?: object) => Promise<object>} both
 * @property {(request?: object) => Promise<object>} bindRepo
 * @property {(request?: object) => Promise<object>} unbindRepo
 * @property {(request?: object) => Promise<object>} updateBinding
 * @property {(request?: object) => Promise<object>} probe
 * @property {() => { busy: boolean, operation: string|null }} lockState
 */
