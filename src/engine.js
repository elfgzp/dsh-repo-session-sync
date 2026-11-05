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
  const { store, paths, sessions, sessionOps, transport, conflicts, registry, visibility, anchors, log } = dependencies
  const lock = new OperationLock()
  const pluginVersion = meta.pluginVersion ?? '0.0.0'
  const config = meta.config ?? {}

  /**
   * Late-bound accessor for the workspace registry.
   *
   * A getter rather than a captured value because `apply()` resolves the service
   * after the engine is constructed (the plugin may activate before the service
   * publishes), and because a reload can republish it. Returning `undefined` is a
   * legitimate answer — the caller turns that into a hard download failure, never
   * into a silent success.
   *
   * @returns {object|undefined} The live registry service, when available.
   */
  function getRegistry() {
    try {
      return typeof meta.getWorkspaceRegistry === 'function' ? meta.getWorkspaceRegistry() : undefined
    } catch (error) {
      log?.warn?.('读取 workspaceRegistry 失败', error)
      return undefined
    }
  }

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
        return runDirection(binding, 'down', dryRun, { ...request, workspaceRegistry: getRegistry() })
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
          ? await runDirection(binding, 'down', dryRun, { ...request, workspaceRegistry: getRegistry() })
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
    // `force` skips the consent *recording* step for a re-run the user already
    // approved in the same interaction — never skips the visibility check itself.
    const force = request?.force === true

    const state = await store.readState()
    const repoState = state.repos[binding.id] ?? { repoId: binding.id }

    const finish = (payload) => {
      result.finishedAt = Date.now()
      return { ...result, ...payload }
    }

    // ── preflight: the path must exist on THIS machine ──────────────────────
    // Before anything touches the network. A binding created on machine A points
    // at a path machine B may not have cloned yet; writing sessions with a cwd
    // that does not exist produces sessions that attachSession() will reject,
    // which is the "synced successfully but the sidebar is empty" failure.
    const preflight = await registry.preflightRepoPath(binding.repoPath)
    const canonical = preflight?.canonical

    // ── visibility: consent is compared against a RECORD, not a memory ──────
    const gate = await evaluateVisibilityGate(binding, repoState, { force })
    if (gate.blocked) {
      await recordRepoState(binding.id, {
        ...repoState,
        lastResult: gate.code,
        lastError: gate.message,
        lastErrorAt: Date.now(),
      })
      return finish({
        ok: false,
        code: gate.code,
        message: gate.message,
        hint: gate.hint,
        visibility: gate.visibility,
      })
    }

    if (direction === 'up') {
      return runUp(binding, { dryRun, progress, result, finish, repoState, gate, canonical })
    }
    return runDown(binding, {
      dryRun,
      progress,
      result,
      finish,
      repoState,
      gate,
      canonical,
      // The live service, threaded from `apply()` through the engine factory.
      // Passed per-call rather than captured at construction so a plugin reload
      // that republishes the service cannot leave a stale reference behind.
      workspaceRegistry: request?.workspaceRegistry,
    })
  }

  /**
   * Evaluate the remote-visibility gate for one binding.
   *
   * ## Why consent is a stored record and not "what I saw last time"
   *
   * Comparing the current verdict to the previous *observation* makes
   * private → public → private pass silently, because the last observation always
   * equals the last observation. Only a record of what the user explicitly agreed
   * to can answer the question that matters: "is this more visible than when they
   * said yes?"
   *
   * The `previous` passed to `detectRegression` is therefore
   * `repoState.visibility` — the consent record — never a cached detection.
   *
   * @param {object} binding - Binding under test.
   * @param {object} repoState - Persisted state, possibly holding a consent record.
   * @param {{force: boolean}} options - Whether a re-run skips re-recording.
   * @returns {Promise<{blocked: boolean, code?: string, message?: string, hint?: string, visibility?: object}>}
   *   Gate decision.
   */
  async function evaluateVisibilityGate(binding, repoState, options) {
    let check
    try {
      check = await visibility.checkRepoVisibility({ remoteUrl: binding.remoteUrl })
    } catch (error) {
      // "Could not check" is NOT "safe". A network failure must stop the push,
      // because the whole point of the gate is that we do not know.
      return {
        blocked: true,
        code: ERROR_CODES.VISIBILITY_UNCONFIRMED,
        message: '无法检测远端仓库的可见性，本次同步已中止。',
        hint: '查不到不等于安全。请检查网络后重试；确认仓库是私有的再同步。',
      }
    }

    const decision = visibility.detectRegression({
      // The consent record, deliberately not a previous *detection*.
      previous: repoState?.visibility?.verdict,
      current: check?.verdict,
    })

    if (decision.ok !== true) {
      return {
        blocked: true,
        code: decision.regression === true
          ? ERROR_CODES.VISIBILITY_REGRESSION
          : ERROR_CODES.VISIBILITY_UNCONFIRMED,
        message: decision.reason || '仓库可见性未确认，本次同步已中止。',
        hint: check?.hint ?? '',
        visibility: check,
      }
    }

    // `unknown` never binds consent: each run asks again. `detectRegression`
    // already encodes that; this branch only records what may be recorded.
    const verdict = String(check?.verdict ?? 'unknown')
    if (options.force !== true && (verdict === 'private' || verdict === 'public')) {
      const recorded = repoState?.visibility?.verdict
      if (recorded !== verdict) {
        await recordRepoState(binding.id, {
          ...repoState,
          visibility: { verdict, slug: check?.slug ?? '', at: Date.now() },
        })
      }
    }

    return { blocked: false, visibility: check }
  }

  /**
   * Merge and persist one repository's state without clobbering other rows.
   *
   * @param {string} repoId - Binding id.
   * @param {object} next - Complete row for this repository.
   * @returns {Promise<void>} Resolves when written.
   */
  async function recordRepoState(repoId, next) {
    const current = await store.readState()
    current.repos[repoId] = { repoId, ...next }
    current.updatedAt = Date.now()
    await store.writeState(current)
  }

  /**
   * The upward leg: collect sessions, push the bundle, record the anchor.
   *
   * @param {object} binding - Binding.
   * @param {object} context - Run context assembled by `runDirection`.
   * @returns {Promise<object>} Result envelope.
   */
  async function runUp(binding, context) {
    const { dryRun, progress, result, finish, repoState, gate } = context
    const collected = []

    // ── 1) probe first: a push that cannot reach the remote should cost one
    // round trip, not a full session read.
    progress?.({ phase: 'probe' })
    const probe = await transport.probe(binding, {})
    if (probe?.reachable !== true) {
      const code = probe?.error?.code ?? ERROR_CODES.REMOTE_UNREACHABLE
      return finish({
        ok: false,
        code,
        message: probe?.error?.message ?? '远端不可达，本次上行已中止。',
        hint: '检查网络与仓库远端配置后重试。',
        visibility: gate.visibility,
      })
    }

    // ── 2) enumerate sessions for this repository ─────────────────────────
    progress?.({ phase: 'collect' })
    const listed = await sessions.list(binding, {})
    result.sessionCount = listed.length

    // ── 3) read each session fully. `list()` deliberately gives an upper-bound
    // event count and no watermark, so the byte-accurate payload comes from
    // `read()`. The watermark stored here is descriptive only — a later download
    // never uses it to decide where to append (see `runDown`).
    for (const descriptor of listed) {
      progress?.({ phase: 'collect', completed: collected.length, total: listed.length })
      let payload
      try {
        payload = await sessions.read(descriptor.sessionId, { cwd: descriptor.cwd ?? binding.repoPath })
      } catch (error) {
        // One unreadable session must not fail the whole upload; it is skipped
        // and named in the result so the user knows what did not travel.
        result.skipped += 1
        result.skippedSessions = [...(result.skippedSessions ?? []), {
          sessionId: descriptor.sessionId,
          reason: error?.message ?? String(error),
        }]
        continue
      }
      collected.push({
        sessionId: payload.sessionId,
        repoKey: payload.repoKey ?? binding.repoKey,
        eventCount: payload.eventCount,
        watermark: payload.watermark,
        contentHash: payload.contentHash,
        content: payload.content,
        updatedAt: payload.updatedAt,
      })
    }

    // ── 4) capture the anchor, then push ─────────────────────────────────
    // Captured HERE and only here: the anchor answers "what did the code look like
    // when this conversation happened?", which is a fact about the uploading
    // machine at upload time. A download must never overwrite it with its own
    // HEAD, or the two machines would keep erasing each other's anchor.
    //
    // `captureAnchor` costs two git processes (~1.5s on a cold cache), so it runs
    // once per upload rather than per session.
    progress?.({ phase: 'anchor' })
    let anchor = null
    try {
      anchor = await anchors.captureAnchor(binding.repoPath)
    } catch (error) {
      // Advisory only: a repository with no commits, or a non-git directory, must
      // not block the conversation from travelling.
      log?.warn?.('捕获代码锚点失败，本次上行不带锚点', error)
    }

    progress?.({ phase: 'upload', completed: 0, total: collected.length })
    let pushed
    try {
      pushed = await transport.push(binding, { sessions: collected }, { dryRun, anchor })
    } catch (error) {
      const body = toFailureBody(error)
      return finish({
        ok: false,
        code: body.code,
        message: body.message,
        hint: body.hint,
        visibility: gate.visibility,
      })
    }

    result.transferred = Number(pushed?.transferred ?? 0)
    result.skipped += Number(pushed?.skipped ?? 0)
    result.bytes = Number(pushed?.bytes ?? 0)
    result.dryRun = pushed?.dryRun === true

    // ── 5) record the anchor + remote head so the next run can compare ────
    if (result.dryRun !== true) {
      await recordRepoState(binding.id, {
        ...repoState,
        visibility: repoState.visibility,
        lastUpAt: Date.now(),
        lastResult: 'ok',
        remoteHead: pushed?.head ?? repoState.remoteHead,
        localHead: anchor?.headCommit ?? repoState.localHead,
        anchor: anchor ?? repoState.anchor,
        sessionCount: collected.length,
      })
    }

    progress?.({ phase: 'commit', completed: collected.length, total: collected.length })
    return finish({
      ok: true,
      code: result.transferred === 0 ? ERROR_CODES.UP_TO_DATE : undefined,
      message: result.dryRun
        ? `预演：将上传 ${collected.length} 个会话。`
        : `已上传 ${result.transferred} 个会话。`,
      anchor: anchor ?? repoState.anchor ?? null,
      visibility: gate.visibility,
    })
  }

  /**
   * The downward leg: pull, reconcile each session, register, verify visibility.
   *
   * ## The completion test is "visible", not "written"
   *
   * Files on disk that never enter a workspace are invisible in the sidebar, and
   * worse, the next run treats them as already-present and skips them — so the
   * mistake is permanent. This leg therefore ends by asking the registry whether
   * each session is actually a member, and rolls back anything that is not.
   *
   * @param {object} binding - Binding.
   * @param {object} context - Run context assembled by `runDirection`.
   * @returns {Promise<object>} Result envelope.
   */
  async function runDown(binding, context) {
    const { dryRun, progress, result, finish, repoState, gate, canonical, sessionsRoot } = context
    const workspaceRegistry = context.workspaceRegistry

    // Down cannot close its visibility loop without the registry. Degrading to
    // "wrote the files and called it success" is exactly the failure the design
    // forbids, so this is a hard stop.
    if (workspaceRegistry === undefined || workspaceRegistry === null) {
      return finish({
        ok: false,
        code: ERROR_CODES.REGISTRY_UNAVAILABLE,
        message: '当前环境没有 workspace registry，下载的会话不会出现在侧栏，因此已中止。',
        hint: '同步引擎需要在 DSH 宿主内运行；请通过插件入口调用，而不是独立脚本。',
      })
    }

    progress?.({ phase: 'probe' })
    let pulled
    try {
      pulled = await transport.pull(binding, { dryRun })
    } catch (error) {
      const body = toFailureBody(error)
      return finish({ ok: false, code: body.code, message: body.message, hint: body.hint })
    }

    if (pulled === null) {
      return finish({
        ok: true,
        code: ERROR_CODES.UP_TO_DATE,
        message: '远端还没有会话数据。',
      })
    }

    const incoming = Array.isArray(pulled?.sessions) ? pulled.sessions : []
    result.sessionCount = incoming.length

    /** Sessions this run created or extended. The rollback set. */
    const touched = []
    /** Per-session anchor drift. Advisory: reported, never acted on. */
    const anchorsOut = []
    const skippedSessions = []

    for (const remote of incoming) {
      progress?.({ phase: 'download', completed: touched.length, total: incoming.length })
      try {
        const decision = await reconcileOne(binding, remote, {
          dryRun,
          canonical,
          repoState,
        })
        if (decision.kind === 'written') {
          touched.push({
            sessionId: remote.sessionId,
            sessionDir: decision.sessionDir,
            // 严格等于 true：`undefined` 绝不能落进「可删除」集合。
            created: decision.created === true,
            backupPath: decision.backupPath ?? null,
          })
          result.transferred += 1

          // Anchor drift — advisory, never blocking. This answers the question the
          // user actually has ("is this conversation stale?") rather than printing
          // a commit hash. Computed against the anchor that travelled WITH the
          // session, not against anything local, because the interesting delta is
          // between the uploading machine's code state and this one's.
          if (remote.anchor !== null && remote.anchor !== undefined) {
            try {
              const drift = await anchors.describeAnchorDrift(
                binding.repoPath,
                anchors.normalizeAnchor(remote.anchor),
              )
              if (drift !== null && drift !== undefined) {
                anchorsOut.push({ sessionId: remote.sessionId, ...drift })
              }
            } catch (error) {
              log?.warn?.('计算代码锚点漂移失败', error)
            }
          }
        } else if (decision.kind === 'skipped') {
          result.skipped += 1
          if (decision.reason !== 'up-to-date') {
            skippedSessions.push({ sessionId: remote.sessionId, reason: decision.reason })
          }
        } else if (decision.kind === 'conflict') {
          result.conflicts.push({
            sessionId: remote.sessionId,
            kind: decision.decision?.kind ?? 'keep-both',
            reason: decision.decision?.reason ?? 'diverged',
            detail: decision.decision?.detail,
            keptLocalPath: decision.keptLocalPath,
            keptRemotePath: decision.keptRemotePath,
          })
          result.skipped += 1
        }
      } catch (error) {
        const body = toFailureBody(error)
        skippedSessions.push({ sessionId: remote.sessionId, reason: body.code })
        result.skipped += 1
      }
    }

    if (skippedSessions.length > 0) result.skippedSessions = skippedSessions

    // ── registration: the actual completion criterion ─────────────────────
    let reg = { ok: true, attached: [], failed: [], canonical }
    if (touched.length > 0 && dryRun !== true) {
      progress?.({ phase: 'verify' })
      reg = await registry.ensureWorkspaceAndAttach({
        registry: workspaceRegistry,
        repoPath: binding.repoPath,
        sessionIds: touched.map((item) => item.sessionId),
      })
    }

    const failed = Array.isArray(reg?.failed) ? reg.failed : []
    if (failed.length > 0 && dryRun !== true) {
      // Roll back ONLY what this run created. `writtenByThisRun` is an exact set
      // from the write calls — never a guess, never a content comparison, because
      // deletion is irreversible and the evidence must be a fact.
      const failedIds = new Set(failed.map((item) => item.sessionId))
      const failedItems = touched.filter((item) => failedIds.has(item.sessionId))

      // 回滚必须按「本次是新建还是追加」分流，两者语义完全不同：
      //
      //   新建 → 这个会话本来不存在，失败时删掉是安全的（回到操作前）
      //   追加 → 这个会话**本来就有用户的历史对话**，删掉就是数据丢失。
      //          正确做法是用追加前的备份还原，让磁盘回到追加前的状态。
      //
      // 曾经这里只有一个 `touched` 集合，两类混在一起，导致「追加了 2 轮的
      // 5 轮会话」在 attach 失败后整目录被删，用户 5 轮历史全丢。
      const createdFailed = failedItems.filter((item) => item.created === true)
      const appendedFailed = failedItems.filter((item) => item.created === false)

      let rollback = { removed: [], kept: [], failed: [] }
      if (createdFailed.length > 0) {
        try {
          rollback = await registry.rollbackNewSessions({
            sessionsRoot: sessionOps.sessionsRoot(paths.dshHome),
            writtenByThisRun: createdFailed,
          })
        } catch (error) {
          log?.error?.('回滚失败，磁盘上可能残留不可见会话', error)
        }
      }

      // 追加过的会话：从备份还原到追加前，绝不删除。
      const restored = []
      const restoreFailed = []
      for (const item of appendedFailed) {
        if (typeof item.backupPath !== 'string' || item.backupPath === '') {
          // 没有备份就不动它。保留一个「磁盘上有、侧栏看不到」的会话，
          // 远好于删掉用户的历史对话。
          log?.error?.('追加过的会话缺少备份，无法还原；已保留文件不删除', item)
          restoreFailed.push({
            sessionId: item.sessionId,
            reason: 'no-backup-available',
          })
          continue
        }
        try {
          const outcome = await sessionOps.restoreSessionFromBackup({
            sessionDir: item.sessionDir,
            backupPath: item.backupPath,
            backupDir: joinBackupDir(paths.backupDir, binding.id),
            sessionId: item.sessionId,
          })
          restored.push({
            sessionId: item.sessionId,
            eventsBefore: outcome.eventsBefore,
            eventsAfter: outcome.eventsAfter,
          })
        } catch (error) {
          log?.error?.('追加过的会话还原失败；已保留文件不删除', {
            sessionId: item.sessionId,
            message: error?.message ?? String(error),
          })
          restoreFailed.push({
            sessionId: item.sessionId,
            reason: error?.message ?? String(error),
          })
        }
      }

      await recordRepoState(binding.id, {
        ...repoState,
        lastDownAt: Date.now(),
        lastResult: ERROR_CODES.REGISTRY_ATTACH_FAILED,
        lastError: '部分会话写入后未能登记到工作区，已回滚',
        lastErrorAt: Date.now(),
      })

      return finish({
        ok: false,
        code: ERROR_CODES.REGISTRY_ATTACH_FAILED,
        message: `${failed.length} 个会话写入了但没能出现在侧栏，已回滚本次新写入的文件。`,
        hint: '通常是会话记录的仓库路径与本机 clone 路径不一致。请确认两台机器绑定的是同一个仓库。',
        detail: {
          failed,
          // 新建的：目录已删除
          rolledBack: rollback.removed ?? [],
          rollbackFailed: rollback.failed ?? [],
          // 追加的：从备份还原到追加前，用户历史完好
          restoredFromBackup: restored,
          restoreFailed,
        },
      })
    }

    if (result.dryRun !== true) {
      await recordRepoState(binding.id, {
        ...repoState,
        lastDownAt: Date.now(),
        lastResult: result.conflicts.length > 0 ? 'conflict' : 'ok',
        remoteHead: pulled?.head ?? repoState.remoteHead,
        sessionCount: incoming.length,
        backupPath: repoState.backupPath,
      })
    }

    progress?.({ phase: 'commit' })
    return finish({
      ok: true,
      message: result.dryRun
        ? `预演：将写入 ${result.transferred} 个会话。`
        : `已下载 ${result.transferred} 个会话，全部可见。`,
      attached: reg.attached ?? [],
      // Advisory drift reports, shape: { sessionId, status, commitsBehind, shortSha, message }.
      // `status` is one of current / behind / diverged / missing-commit / none / unknown.
      anchorDrift: anchorsOut,
      visibility: gate.visibility,
    })
  }

  /**
   * Decide and apply what to do with one incoming session.
   *
   * @param {object} binding - Binding.
   * @param {object} remote - Pulled payload for one session.
   * @param {{dryRun: boolean, canonical: string, repoState: object}} options - Run facts.
   * @returns {Promise<object>} Outcome describing what happened.
   */
  async function reconcileOne(binding, remote, options) {
    const { dryRun, canonical } = options
    const backupDir = joinBackupDir(paths.backupDir, binding.id)

    // The pulled payload carries the decoded event stream; `sessions.read` needs
    // a cwd to locate a *local* file, so the local side is looked up by session id
    // across the repository's sessions rather than by path.
    const local = await readLocalSession(binding, remote.sessionId)

    if (local === null) {
      // Not present locally: write it. `cwdOverride` is mandatory — without it the
      // header keeps the *other* machine's path and attachSession() will reject it.
      const written = await sessions.write(
        { ...remote },
        { backupDir, cwdOverride: canonical, dryRun },
      )
      // `created: true` 是回滚安全的关键标记。没有它，调用方无法区分
      // 「本次新建的会话」（回滚时应当删除）与「在已有会话上追加的」（绝不能删），
      // 于是会把用户的历史对话一起删掉。
      //
      // `local === null` 只代表「读不到」，不代表「本机没有」——
      // readLocalSession() 会吞掉异常并返回 null（刻意的降级），底层可能是
      // 目录在、日志坏了、或读取暂时失败。那种情况下把 created 设为 true
      // 就等于给了一条「删掉用户历史」的许可。
      //
      // **最可靠的「原本是否已有数据」证据是 backupPath**：
      // `writeSession` 只在目标会话目录已存在时才做备份，所以
      //   backupPath !== null  →  本机原本就有这个会话  → created: false（走还原）
      //   backupPath === null  →  本机本来没有        → created: true （可删）
      // 这是写入过程自己产生的**事实**，不需要额外探测、也不会被
      // `readLocalSession` 的降级行为误导。
      const wasAlreadyPresent = typeof written?.backupPath === 'string' && written.backupPath !== ''
      return {
        kind: 'written',
        created: !wasAlreadyPresent,
        sessionDir: written?.sessionDir ?? null,
        backupPath: wasAlreadyPresent ? written.backupPath : null,
      }
    }

    const decision = conflicts.decide({ local, remote, binding })
    const kind = decision?.kind ?? 'no-conflict'

    if (kind === 'no-conflict') {
      // Local ahead of remote is a NORMAL state, not a conflict: this machine
      // uploaded, and the other machine has not pulled yet. `classifyIncoming`
      // now handles the inverted interval, but deciding the direction here keeps
      // the engine from depending on that defensive branch — and states the
      // intent at the call site, where the next reader looks.
      if (Number(remote.eventCount) < Number(local.eventCount)) {
        return { kind: 'skipped', reason: 'local-ahead' }
      }

      // `fromSeq` describes where the REMOTE's new span begins, which is exactly
      // the number of events the local file already holds. Passing anything else
      // (a stored watermark, the remote's own start) makes contiguous appends look
      // like gaps.
      const verdict = sessionOps.classifyIncoming(
        { nextSeq: local.eventCount },
        { fromSeq: local.eventCount, toSeqExclusive: remote.eventCount },
      )
      if (verdict.action === 'up-to-date') return { kind: 'skipped', reason: 'up-to-date' }
      if (verdict.action === 'gap') {
        return {
          kind: 'conflict',
          decision: { kind: 'refuse', reason: `gap: ${verdict.reason}`, detail: verdict.reason },
        }
      }
      // append: start from the LOCAL nextSeq, never from the stored watermark.
      // A torn tail during a previous crash means the local file holds one fewer
      // event than the watermark claims; appending from the watermark would leave
      // a permanent hole at that seq. Disk is the only authority for where the
      // local stream continues.
      const appended = await sessionOps.appendToSession(
        {
          sessionId: remote.sessionId,
          header: local.header,
          events: sliceEventsAfter(remote, local.eventCount),
        },
        { backupDir, cwdOverride: canonical, dryRun },
      )
      // `created: false` —— 这个会话本来就在本机，本次只是往后追加。
      // 回滚时**绝不能删它**，只能用 `backupPath` 还原到追加前的状态。
      return {
        kind: 'written',
        created: false,
        sessionDir: appended?.sessionDir ?? null,
        backupPath: appended?.backupPath ?? null,
      }
    }

    if (kind === 'remote-wins' || kind === 'local-wins') {
      // The resolver promises never to return these when both sides advanced.
      // If it does, the promise is broken and overwriting would be unsafe — so
      // treat it as a refusal rather than acting on an untrusted verdict.
      return {
        kind: 'conflict',
        decision: { kind: 'refuse', reason: 'unexpected-decision', detail: decision.detail },
      }
    }

    // keep-both / refuse: preserve both sides. Files are not touched here; the
    // report tells the user where each copy lives.
    return { kind: 'conflict', decision }
  }

  /**
   * Read a session that already exists on this machine, if it does.
   *
   * @param {object} binding - Binding.
   * @param {string} sessionId - Session to look for.
   * @returns {Promise<object|null>} Local payload, or null when absent.
   */
  async function readLocalSession(binding, sessionId) {
    try {
      const listed = await sessions.list(binding, {})
      const found = listed.find((item) => item.sessionId === sessionId)
      if (found === undefined) return null
      return await sessions.read(sessionId, { cwd: found.cwd ?? binding.repoPath })
    } catch {
      // An unreadable local session is treated as absent: writing it is a no-op
      // for a session that already matches, and `write()` backs up first anyway.
      return null
    }
  }

  /**
   * Slice the events a remote payload holds beyond a local sequence number.
   *
   * @param {object} remote - Pulled payload.
   * @param {number} fromSeq - First seq the local file is missing.
   * @returns {object[]} Events to append.
   */
  function sliceEventsAfter(remote, fromSeq) {
    const events = Array.isArray(remote?.events) ? remote.events : []
    return events.filter((event) => Number(event?.seq) >= fromSeq)
  }

  /**
   * Per-repository backup directory.
   *
   * One directory per binding so pruning one repository's backups can never
   * remove another's restore point.
   *
   * @param {string} base - Backups root.
   * @param {string} repoId - Binding id.
   * @returns {string} Absolute directory.
   */
  function joinBackupDir(base, repoId) {
    return `${base}/${repoId}`
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
