/**
 * Repository identity and the binding table.
 *
 * The central design decision of this plugin lives in this file: **a session is
 * bound to a repository *identity*, not to a filesystem path.** Paths differ
 * between machines (`~/project` here, `D:/work/project` there); a Git remote
 * plus a branch does not. If the binding key were the path, every clone would
 * be a different repository and nothing would ever line up.
 *
 * So the key is:
 *
 *     repoKey = canonicalRemoteUrl
 *
 * The branch is deliberately **not** part of it (ADR-1). Including it made one
 * repository produce a different key per checked-out branch, so the same clone
 * seen on `main` and on `feature-x` became two bindings in the UI and two
 * independent sync histories. Branch is now a display attribute, like the local
 * path: useful to show, never part of "which repository is this?".
 *
 * The local path is likewise just an attribute of a binding, not part of its
 * identity. That is what makes "same repo on two machines" expressible.
 *
 * @module dsh-repo-session-sync/repo-binding
 */

import { SyncError, ERROR_CODES } from './errors.js'
import { assertSafeSegment, isSafeSegment } from './paths.js'

/**
 * How a binding resolves a session set.
 *
 * @readonly
 * @enum {string}
 */
export const SYNC_DIRECTION = Object.freeze({
  /** This machine only produces sessions; remote never overwrites local. */
  UP: 'up',
  /** This machine only consumes; useful for a read-mostly second machine. */
  DOWN: 'down',
  /** Both. The default, and the one that needs the conflict machinery. */
  BOTH: 'both',
})

/**
 * Supported transport channels.
 *
 * `git-branch` is the MVP: it needs no new infrastructure, reuses the user's
 * existing `git push` credentials, and makes the sync content auditable and
 * revertable with ordinary Git tools. The others are declared so the engine can
 * be written against one interface and the schema does not have to change when
 * one lands.
 *
 * @readonly
 * @enum {string}
 */
export const TRANSPORT = Object.freeze({
  /** An orphan branch in the project's own repository. */
  GIT_BRANCH: 'git-branch',
  /** A separate private repository dedicated to session bundles. */
  GIT_REPO: 'git-repo',
  /** rsync over SSH; requires a host entry the user already configured. */
  RSYNC: 'rsync',
  /** Reuse a dsh-remote machine entry. */
  DSH_REMOTE: 'dsh-remote',
})

/**
 * All accepted direction values.
 *
 * @type {readonly string[]}
 */
export const SYNC_DIRECTIONS = Object.freeze(Object.values(SYNC_DIRECTION))

/**
 * All accepted transport values.
 *
 * @type {readonly string[]}
 */
export const TRANSPORTS = Object.freeze(Object.values(TRANSPORT))

/**
 * Default orphan branch name for `git-branch` transport.
 *
 * A separate branch is not a cosmetic choice: session logs have nothing to do
 * with the code history, and putting them on the project's own branch would
 * pollute every `git log`, interact with every code review, and risk a
 * conflict-shaped merge for binary-ish payloads. An orphan branch has its own
 * unrelated history and can be fetched without being checked out.
 *
 * @type {string}
 */
export const DEFAULT_SYNC_BRANCH = 'refs/heads/dsh-sessions'

/**
 * Canonicalize a Git remote URL so the same remote written two ways compares
 * equal.
 *
 * The same repository reaches a user as `git@github.com:you/repo.git`,
 * `ssh://git@github.com/you/repo.git`, and `https://github.com/you/repo`, and
 * all three must produce one key or a binding made on one machine will not
 * match the clone made on another. Lowercasing the host is safe; lowercasing
 * the whole path is **not**, because GitHub paths are case-insensitive but
 * self-hosted Git is routinely case-sensitive, so the path keeps its case.
 *
 * @param {unknown} remoteUrl - Raw remote URL from `git config`.
 * @returns {{ canonical: string, host: string, path: string, scheme: string } | undefined}
 *   Normalized parts, or undefined when the input is not a recognizable URL.
 */
export function canonicalizeRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string') return undefined
  const raw = remoteUrl.trim()
  if (raw === '') return undefined

  // scp-like syntax: [user@]host:path — the colon is not a port separator here
  // because there is no `//` and, in practice, no slash before it.
  const scpLike = /^(?:([^@/]+)@)?([^:/]+):(?!\/)(.+)$/.exec(raw)
  if (scpLike !== null && !raw.includes('://')) {
    const host = String(scpLike[2]).toLowerCase()
    const path = stripGitSuffix(stripLeadingSlashes(String(scpLike[3])))
    if (host === '' || path === '') return undefined
    return { canonical: `${host}/${path}`, host, path, scheme: 'ssh' }
  }

  let url
  try {
    url = new URL(raw)
  } catch {
    // A bare local path is a valid Git remote for a local-only repository. It is
    // not portable between machines, so it canonicalizes to itself under a
    // distinct scheme; the engine can then warn that such a binding will not
    // match anywhere else.
    const local = raw.replace(/[\\/]+$/, '')
    return local === '' ? undefined : { canonical: `file/${local}`, host: '', path: local, scheme: 'file' }
  }

  const host = url.hostname.toLowerCase()
  const path = stripGitSuffix(stripLeadingSlashes(decodeURIComponentSafe(url.pathname)))
  if (path === '') return undefined
  // Port is significant when non-default: two repositories on one host can live
  // behind different ports. The username is not part of identity, only of
  // authentication.
  const port = url.port === '' ? '' : `:${url.port}`
  const scheme = url.protocol === 'ssh:' ? 'ssh' : url.protocol.replace(':', '')
  return { canonical: `${host}${port}/${path}`, host, path, scheme }
}

/**
 * Remove one trailing `.git`, which is the same repository with and without it.
 *
 * @param {string} path - Path portion.
 * @returns {string} Path without the suffix.
 */
function stripGitSuffix(path) {
  return path.endsWith('.git') ? path.slice(0, -4) : path
}

/**
 * Trim leading slashes from a URL path portion.
 *
 * @param {string} path - Raw path.
 * @returns {string} Path with no leading separators.
 */
function stripLeadingSlashes(path) {
  return path.replace(/^\/+/, '')
}

/**
 * Decode a URI component, tolerating malformed input.
 *
 * `decodeURIComponent` throws on a stray `%`. A remote URL is untrusted input,
 * so a malformed one must produce "not a URL" rather than an exception escaping
 * into config loading.
 *
 * @param {string} value - Possibly percent-encoded text.
 * @returns {string} Decoded text, or the input when decoding fails.
 */
function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Build the canonical identity key for a repository.
 *
 * @param {{ remoteUrl?: string, branch?: string }} binding - Binding facts.
 * @returns {string | undefined} Stable key, or undefined when identity is unknown.
 */
export function repoKeyOf(binding) {
  const remote = canonicalizeRemoteUrl(binding?.remoteUrl)
  if (remote === undefined) return undefined
  // Branch is intentionally absent: see the module header and ADR-1.
  return remote.canonical
}

/**
 * Normalize a filesystem path for comparison across platforms.
 *
 * Trailing separators are removed and `.`/`..` resolved by lexical collapse.
 * Symlinks are deliberately **not** resolved: the binding should match the path
 * the user actually opened, and resolving would make the table depend on the
 * current state of the filesystem.
 *
 * @param {unknown} repoPath - Raw path.
 * @returns {string} Normalized path, or empty string when unusable.
 */
export function normalizeRepoPath(repoPath) {
  if (typeof repoPath !== 'string') return ''
  let text = repoPath.trim()
  if (text === '') return ''
  // Windows separators become forward slashes so `.` and `..` collapse works on
  // a bundle authored elsewhere; the forward slash is valid on every platform
  // Node runs on for the purpose of this comparison.
  text = text.replace(/\\/g, '/')
  const isAbsolute = text.startsWith('/') || /^[A-Za-z]:\//.test(text)
  const parts = []
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!isAbsolute) parts.push('..')
      continue
    }
    parts.push(part)
  }
  const joined = parts.join('/')
  if (isAbsolute) return `/${joined}`.replace(/^\/+/, '/')
  return joined
}

/**
 * One repository binding.
 *
 * @typedef {object} RepoBinding
 * @property {string} id - Stable local id (safe path segment), derived from the key.
 * @property {string} repoKey - Canonical identity; the sync key.
 * @property {string} repoPath - Local working tree path on *this* machine.
 * @property {string} remoteUrl - Remote URL as configured here.
 * @property {string} canonicalRemote - Canonical form of {@link remoteUrl}.
 * @property {string} branch - Branch identity used in the key.
 * @property {string} syncBranch - Branch (or ref) carrying the session bundle.
 * @property {'up'|'down'|'both'} direction - Which way data may flow.
 * @property {'git-branch'|'git-repo'|'rsync'|'dsh-remote'} transport - Channel.
 * @property {boolean} autoSync - Whether the timer may act without the user.
 * @property {number} autoSyncIntervalMs - Timer interval; 0 disables.
 * @property {boolean} enabled - Soft disable without deleting the binding.
 * @property {number} createdAt - Epoch milliseconds.
 * @property {number} updatedAt - Epoch milliseconds.
 * @property {string} [lastSessionId] - Last session seen under this repo.
 * @property {{ commit?: string, at?: number, branch?: string }} [anchor]
 *   The repository commit this binding's sessions were last associated with.
 */

/**
 * Derive a stable, path-safe local id from a repository key.
 *
 * The id appears in directory names under the state directory and in HTTP
 * routes, so it must be a safe segment *and* stable across restarts for the
 * same repository. A short hash of the key gives both. The readable prefix is
 * cosmetic — it makes the settings page legible — and is sanitized separately
 * so a repository named `<script>` cannot inject markup.
 *
 * @param {string} repoKey - Canonical identity key.
 * @returns {string} Safe id such as `repo-1a2b3c4d`.
 */
export function deriveRepoId(repoKey) {
  // `split('\u0000')` is defensive: keys written before ADR-1 carried a branch
  // suffix. Nothing produces that shape any more, but an imported legacy table
  // should still derive a readable prefix instead of throwing.
  const readable = String(repoKey ?? '')
    .split('\u0000')[0]
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40)
  const hash = fnv1a(String(repoKey ?? ''))
  const prefix = readable === '' ? 'repo' : `repo-${readable}`
  return `${prefix}-${hash}`.slice(0, 200)
}

/**
 * 32-bit FNV-1a, rendered as fixed-width hex.
 *
 * Chosen over `crypto` so this module stays dependency-free and synchronous, and
 * over a cryptographic digest because the id is an identifier, never a security
 * boundary — collisions are handled explicitly by {@link upsertBinding}.
 *
 * @param {string} input - Text to hash.
 * @returns {string} Eight lowercase hex characters.
 */
function fnv1a(input) {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Validate and normalize one direction value.
 *
 * @param {unknown} direction - Candidate.
 * @param {string} fallback - Value to use when unusable.
 * @returns {'up'|'down'|'both'} A valid direction.
 */
export function normalizeDirection(direction, fallback = SYNC_DIRECTION.BOTH) {
  const value = typeof direction === 'string' ? direction.trim().toLowerCase() : ''
  return SYNC_DIRECTIONS.includes(value) ? /** @type {any} */ (value) : fallback
}

/**
 * Validate and normalize one transport value.
 *
 * @param {unknown} transport - Candidate.
 * @param {string} fallback - Value to use when unusable.
 * @returns {'git-branch'|'git-repo'|'rsync'|'dsh-remote'} A valid transport.
 */
export function normalizeTransport(transport, fallback = TRANSPORT.GIT_BRANCH) {
  const value = typeof transport === 'string' ? transport.trim().toLowerCase() : ''
  return TRANSPORTS.includes(value) ? /** @type {any} */ (value) : fallback
}

/**
 * Whether a direction permits reading from the remote (downward flow).
 *
 * @param {string} direction - Normalized direction.
 * @returns {boolean} True when `down` is allowed.
 */
export function allowsDown(direction) {
  return direction === SYNC_DIRECTION.DOWN || direction === SYNC_DIRECTION.BOTH
}

/**
 * Whether a direction permits writing to the remote (upward flow).
 *
 * @param {string} direction - Normalized direction.
 * @returns {boolean} True when `up` is allowed.
 */
export function allowsUp(direction) {
  return direction === SYNC_DIRECTION.UP || direction === SYNC_DIRECTION.BOTH
}

/**
 * Build a complete, validated binding from partial user input.
 *
 * Unknown fields are dropped rather than copied through: the binding table is
 * persisted and, for the transport channel, partially reconstructed from remote
 * content, so letting arbitrary keys survive is how a prompt-injection payload
 * or a stale field sneaks into durable state.
 *
 * @param {object} input - Partial binding.
 * @param {object} [options] - Normalization options.
 * @param {number} [options.now] - Clock override for deterministic tests.
 * @param {RepoBinding} [options.existing] - Current binding, for updates.
 * @returns {RepoBinding} Normalized binding.
 * @throws {SyncError} When the input cannot form an identity.
 */
export function createBinding(input = {}, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const existing = options.existing

  const repoPath = normalizeRepoPath(input.repoPath ?? existing?.repoPath)
  const remoteUrl = String(input.remoteUrl ?? existing?.remoteUrl ?? '').trim()
  const canonical = canonicalizeRemoteUrl(remoteUrl)
  if (canonical === undefined) {
    throw new SyncError(
      ERROR_CODES.NO_REMOTE,
      '这个仓库没有可用的 remote，无法在两台机器之间识别为同一个仓库。',
      {
        hint: '先给项目加一个 remote（例如 `git remote add origin <your-repo-url>`），再回来绑定。',
      },
    )
  }

  const branch = String(input.branch ?? existing?.branch ?? 'HEAD').trim() || 'HEAD'
  const repoKey = canonical.canonical

  const repoId = typeof input.id === 'string' && isSafeSegment(input.id)
    ? input.id
    : deriveRepoId(repoKey)

  return {
    id: assertSafeSegment(repoId, '仓库 id'),
    repoKey,
    repoPath,
    remoteUrl,
    canonicalRemote: canonical.canonical,
    branch,
    syncBranch: String(input.syncBranch ?? existing?.syncBranch ?? DEFAULT_SYNC_BRANCH).trim()
      || DEFAULT_SYNC_BRANCH,
    direction: normalizeDirection(input.direction ?? existing?.direction, SYNC_DIRECTION.BOTH),
    transport: normalizeTransport(input.transport ?? existing?.transport, TRANSPORT.GIT_BRANCH),
    autoSync: input.autoSync === undefined
      ? Boolean(existing?.autoSync ?? false)
      : input.autoSync === true,
    autoSyncIntervalMs: normalizeInterval(
      input.autoSyncIntervalMs ?? existing?.autoSyncIntervalMs,
    ),
    enabled: input.enabled === undefined ? Boolean(existing?.enabled ?? true) : input.enabled === true,
    createdAt: typeof existing?.createdAt === 'number' ? existing.createdAt : now,
    updatedAt: now,
  }
}

/**
 * Coerce an interval into an allowed value.
 *
 * @param {unknown} value - Candidate milliseconds.
 * @returns {number} Interval in ms, 0 meaning "off".
 */
function normalizeInterval(value) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  // Five seconds is the floor: anything faster hammers the remote for no gain,
  // and the check costs a network round trip.
  return Math.max(5_000, Math.min(Math.floor(numeric), 24 * 60 * 60_000))
}

/**
 * The binding table, with lookup by identity and by path.
 *
 * This is a pure data structure: it performs no I/O, so the engine, the config
 * layer, and the tests can all manipulate bindings without a filesystem and
 * without racing each other.
 */
export class BindingTable {
  /**
   * @param {RepoBinding[]} [bindings] - Initial rows.
   */
  constructor(bindings = []) {
    /** @type {Map<string, RepoBinding>} Keyed by binding id. */
    this.byId = new Map()
    /** @type {Map<string, RepoBinding>} Keyed by canonical repo key. */
    this.byKey = new Map()
    for (const binding of bindings) this.#index(binding)
  }

  /**
   * Insert one binding into both indexes.
   *
   * @param {RepoBinding} binding - Binding to index.
   * @returns {void}
   */
  #index(binding) {
    this.byId.set(binding.id, binding)
    this.byKey.set(binding.repoKey, binding)
  }

  /**
   * Every binding, in insertion order.
   *
   * @returns {RepoBinding[]} Snapshot list.
   */
  list() {
    return [...this.byId.values()]
  }

  /**
   * Look a binding up by its stable id.
   *
   * @param {string} id - Binding id.
   * @returns {RepoBinding | undefined} The binding, when present.
   */
  get(id) {
    return this.byId.get(id)
  }

  /**
   * Look a binding up by canonical repository identity.
   *
   * @param {string} repoKey - Key from {@link repoKeyOf}.
   * @returns {RepoBinding | undefined} The binding, when present.
   */
  getByKey(repoKey) {
    return this.byKey.get(repoKey)
  }

  /**
   * Find the binding whose local path covers a directory.
   *
   * Longest-prefix wins so that a binding on `~/work` does not swallow
   * `~/work/project` when both are bound. This is what lets a session started in
   * a subdirectory resolve to its repository.
   *
   * @param {string} directory - Directory to resolve.
   * @returns {RepoBinding | undefined} The most specific matching binding.
   */
  findByPath(directory) {
    const target = normalizeRepoPath(directory)
    if (target === '') return undefined
    let best
    let bestLength = -1
    for (const binding of this.byId.values()) {
      if (binding.repoPath === '') continue
      if (target !== binding.repoPath && !target.startsWith(`${binding.repoPath}/`)) continue
      if (binding.repoPath.length > bestLength) {
        best = binding
        bestLength = binding.repoPath.length
      }
    }
    return best
  }

  /**
   * Insert or replace a binding, keyed by repository identity.
   *
   * If a different binding already owns the same identity, this **replaces** it
   * and reports the displaced row, rather than creating a second row for the
   * same repository. Two rows for one identity would make "which one wins?"
   * undefined at sync time, which is exactly the silent-divergence failure this
   * plugin exists to prevent; the caller decides whether to warn the user.
   *
   * @param {RepoBinding} binding - Normalized binding.
   * @returns {{ binding: RepoBinding, previous?: RepoBinding, replaced: boolean }}
   *   Result and what was replaced.
   */
  upsert(binding) {
    const previousByKey = this.byKey.get(binding.repoKey)
    const previousById = this.byId.get(binding.id)
    const displaced = previousById !== undefined && previousById.repoKey !== binding.repoKey
      ? previousById
      : undefined
    const replaced = (previousByKey !== undefined && previousByKey.id !== binding.id)
      || displaced !== undefined

    if (previousByKey !== undefined && previousByKey.id !== binding.id) this.byId.delete(previousByKey.id)
    if (displaced !== undefined) this.byKey.delete(displaced.repoKey)
    if (previousById !== undefined && previousById.repoKey !== binding.repoKey) {
      this.byId.delete(previousById.id)
    }

    this.#index(binding)
    return {
      binding,
      previous: previousByKey ?? displaced ?? previousById,
      replaced,
    }
  }

  /**
   * Remove a binding by id.
   *
   * @param {string} id - Binding id.
   * @returns {boolean} True when a row was removed.
   */
  remove(id) {
    const binding = this.byId.get(id)
    if (binding === undefined) return false
    this.byId.delete(id)
    if (this.byKey.get(binding.repoKey) === binding) this.byKey.delete(binding.repoKey)
    return true
  }

  /**
   * Serialize to the persisted document shape.
   *
   * @returns {{ version: number, bindings: RepoBinding[] }} Plain JSON.
   */
  toJSON() {
    return { version: 1, bindings: this.list() }
  }

  /**
   * Rehydrate from a persisted document, dropping unusable rows.
   *
   * One corrupt row must not cost the user every other binding, so each row is
   * validated independently and failures are collected instead of thrown.
   *
   * @param {unknown} document - Value read from disk.
   * @returns {{ table: BindingTable, dropped: Array<{ index: number, reason: string }> }}
   *   Rebuilt table and the rows that were skipped.
   */
  static fromJSON(document) {
    const dropped = []
    const table = new BindingTable()
    const rows = Array.isArray(document)
      ? document
      : Array.isArray(/** @type {any} */ (document)?.bindings)
        ? /** @type {any} */ (document).bindings
        : []

    rows.forEach((row, index) => {
      try {
        const binding = createBinding(row, {
          now: typeof row?.updatedAt === 'number' ? row.updatedAt : 0,
          existing: /** @type {any} */ (row),
        })
        table.upsert(binding)
      } catch (error) {
        dropped.push({
          index,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    })

    return { table, dropped }
  }
}
