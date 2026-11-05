/**
 * The error code space shared by the engine, the HTTP routes, the agent tool,
 * and the settings page.
 *
 * A plain message is not a contract: the UI cannot branch on prose, and prose
 * drifts the moment someone rewords it. Every failure this plugin can report
 * therefore carries a **stable `code`** from {@link ERROR_CODES}, and the UI
 * renders a localized hint per code instead of echoing an English stack trace.
 *
 * Adding a code is a compatible change; renaming or removing one is not, because
 * the browser half and any external automation switch on these strings.
 *
 * @module dsh-repo-session-sync/errors
 */

/**
 * Stable, machine-readable failure codes.
 *
 * Grouped by the question the user has to answer:
 *
 *   - **config** — "what do I need to fill in?"
 *   - **repo** — "is this repository usable?"
 *   - **transport** — "can we reach the other side?"
 *   - **data** — "is the payload sane?"
 *   - **conflict** — "both sides moved, you must decide"
 *   - **safety** — "this was refused on purpose"
 *   - **runtime** — "something broke"
 *
 * @readonly
 * @enum {string}
 */
export const ERROR_CODES = Object.freeze({
  // ── config ────────────────────────────────────────────────────────────────
  /** No repository is bound yet, so there is nothing to sync. */
  NOT_CONFIGURED: 'not-configured',
  /** A required field is missing or malformed. */
  BAD_REQUEST: 'bad-request',
  /** The named repository id is not in the binding table. */
  UNKNOWN_REPO: 'unknown-repo',
  /** The configured sync direction forbids this operation. */
  DIRECTION_FORBIDDEN: 'direction-forbidden',

  // ── repo ──────────────────────────────────────────────────────────────────
  /** The bound path no longer exists on this machine. */
  REPO_PATH_MISSING: 'repo-path-missing',
  /** The path exists but is not a Git working tree. */
  NOT_A_GIT_REPO: 'not-a-git-repo',
  /** The repository has no remote configured. */
  NO_REMOTE: 'no-remote',
  /** The remote URL does not match the binding's recorded identity. */
  REMOTE_MISMATCH: 'remote-mismatch',
  /** `git` itself is missing or not executable. */
  GIT_UNAVAILABLE: 'git-unavailable',

  // ── transport ─────────────────────────────────────────────────────────────
  /** The remote could not be reached (network, auth, DNS). */
  REMOTE_UNREACHABLE: 'remote-unreachable',
  /** Authentication to the remote was refused. */
  AUTH_FAILED: 'auth-failed',
  /** The operation was cancelled by the caller. */
  ABORTED: 'aborted',
  /** A mutex is already held by another operation. */
  BUSY: 'busy',

  // ── data ──────────────────────────────────────────────────────────────────
  /** The remote bundle is not something this plugin produced. */
  INVALID_BUNDLE: 'invalid-bundle',
  /** The bundle advertises a format version this build does not understand. */
  UNSUPPORTED_VERSION: 'unsupported-version',
  /** A session payload failed integrity checks. */
  CORRUPT_SESSION: 'corrupt-session',
  /** The payload exceeds a configured size or count cap. */
  LIMIT_EXCEEDED: 'limit-exceeded',
  /** Nothing to do: local and remote already agree. */
  UP_TO_DATE: 'up-to-date',

  // ── conflict ──────────────────────────────────────────────────────────────
  /** The same session id advanced differently on both sides. */
  CONFLICT_SESSION: 'conflict-session',
  /** The same repository identity maps to different local paths. */
  CONFLICT_BINDING: 'conflict-binding',

  // ── safety ────────────────────────────────────────────────────────────────
  /** A path failed traversal validation; refused before any write. */
  PATH_UNSAFE: 'path-unsafe',
  /** Refused because no backup could be written first. */
  BACKUP_FAILED: 'backup-failed',
  /** Refused because the target is the user's live data outside a test home. */
  REFUSED_UNSAFE_TARGET: 'refused-unsafe-target',

  // ── runtime ───────────────────────────────────────────────────────────────
  /** Implemented later by the engine owner; the skeleton reports this. */
  NOT_IMPLEMENTED: 'not-implemented',
  /** Unexpected internal failure. */
  INTERNAL: 'internal-error',
})

/**
 * Every code as a flat list, for tests and for the UI's exhaustive switch.
 *
 * @type {readonly string[]}
 */
export const ERROR_CODE_LIST = Object.freeze(Object.values(ERROR_CODES))

/**
 * A failure that is safe to show to a user and meaningful to a program.
 *
 * Anything thrown that is *not* a `SyncError` is treated as an internal defect
 * and reported with {@link ERROR_CODES.INTERNAL} plus a generic message, so an
 * unexpected exception can never leak a stack trace into the UI.
 */
export class SyncError extends Error {
  /**
   * @param {string} code - One of {@link ERROR_CODES}.
   * @param {string} message - Human-readable explanation.
   * @param {object} [options] - Extra structured detail.
   * @param {string} [options.hint] - What the user can do next.
   * @param {string} [options.repoId] - Repository the failure relates to.
   * @param {unknown} [options.cause] - Original error, kept for the log only.
   * @param {Record<string, unknown>} [options.detail] - Extra machine fields.
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SyncError'
    this.code = typeof code === 'string' && code !== '' ? code : ERROR_CODES.INTERNAL
    this.hint = options.hint
    this.repoId = options.repoId
    this.detail = options.detail
  }

  /**
   * Serialize for an HTTP response or a tool result.
   *
   * Deliberately excludes `cause`: an underlying error message may contain a
   * path or a remote URL with a credential in it, and this shape crosses the
   * trust fence into the browser.
   *
   * @param {string} [fallbackMessage] - Message used for non-SyncError input.
   * @returns {{ ok: false, code: string, message: string, hint?: string, repoId?: string, detail?: Record<string, unknown> }}
   *   A transport-safe failure body.
   */
  toJSON() {
    /** @type {{ ok: false, code: string, message: string, hint?: string, repoId?: string, detail?: Record<string, unknown> }} */
    const body = { ok: false, code: this.code, message: this.message }
    if (this.hint !== undefined) body.hint = this.hint
    if (this.repoId !== undefined) body.repoId = this.repoId
    if (this.detail !== undefined) body.detail = this.detail
    return body
  }
}

/**
 * Normalize any thrown value into a transport-safe failure body.
 *
 * @param {unknown} error - Whatever was thrown.
 * @returns {{ ok: false, code: string, message: string, hint?: string, repoId?: string, detail?: Record<string, unknown> }} A failure body.
 */
export function toFailureBody(error) {
  if (error instanceof SyncError) return error.toJSON()
  if (error instanceof Error && error.name === 'PathSafetyError') {
    return {
      ok: false,
      code: ERROR_CODES.PATH_UNSAFE,
      message: error.message,
      hint: '这个路径看起来不对劲，已拒绝操作；没有写入任何文件。',
    }
  }
  return {
    ok: false,
    code: ERROR_CODES.INTERNAL,
    message: '插件内部错误，操作已中止。',
    hint: '详情已写入插件日志；如果反复出现，请附上日志反馈。',
  }
}

/**
 * Build a successful envelope around payload data.
 *
 * Every engine method returns this shape so callers never have to distinguish
 * "returned undefined" from "failed silently".
 *
 * @template T
 * @param {T} data - Payload to return.
 * @returns {{ ok: true } & T} Success envelope.
 */
export function ok(data = /** @type {any} */ ({})) {
  return { ok: true, ...data }
}

/**
 * Build a failed envelope without throwing.
 *
 * @param {string} code - One of {@link ERROR_CODES}.
 * @param {string} message - Human-readable explanation.
 * @param {object} [options] - Forwarded to {@link SyncError}.
 * @returns {{ ok: false, code: string, message: string }} Failure envelope.
 */
export function fail(code, message, options = {}) {
  return new SyncError(code, message, options).toJSON()
}
