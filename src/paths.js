/**
 * Path resolution and safety for `dsh-repo-session-sync`.
 *
 * Every filesystem location this plugin touches is derived here, never written
 * as a literal. That rule has two reasons:
 *
 *   - **Portability.** A packaged plugin must not assume the author's machine.
 *     `~/.dsh` on macOS, an overridden `DSH_HOME` in CI, and a Windows profile
 *     directory are all the same concept resolved differently.
 *   - **No ambient authority.** A path that arrives from a remote bundle, a
 *     config file, or an HTTP body is *input*, not a destination. Everything
 *     crossing that boundary goes through {@link resolveInside} or
 *     {@link assertSafeSegment} before any `fs` call sees it.
 *
 * This module deliberately has **no imports outside `node:`** so it can be
 * exercised by `node --test` in a plain checkout, without a DSH installation.
 *
 * @module dsh-repo-session-sync/paths
 */

import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Raised when a path would escape the directory it is supposed to live in.
 *
 * Kept separate from {@link SyncError} so that the `paths` module stays free of
 * engine dependencies; `src/errors.js` maps it onto the user-facing code space.
 */
export class PathSafetyError extends Error {
  /**
   * @param {string} message - Human-readable reason.
   * @param {string} [code] - Stable machine code.
   */
  constructor(message, code = 'path-unsafe') {
    super(message)
    this.name = 'PathSafetyError'
    this.code = code
  }
}

/**
 * Whether a string is a safe single path segment.
 *
 * Used for anything that becomes a directory or file name: repository ids,
 * session ids, machine ids. Rejecting `.` / `..` / separators / NUL is the whole
 * defence against a crafted remote bundle writing outside the state directory;
 * it is checked here rather than at each call site so no caller can forget.
 *
 * @param {unknown} value - Candidate segment.
 * @returns {boolean} True when the segment is usable as a single name.
 */
export function isSafeSegment(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 255) return false
  if (value === '.' || value === '..') return false
  // Both separators, unconditionally: a bundle produced on Windows must not be
  // able to name a nested path on a POSIX host either.
  if (value.includes('/') || value.includes('\\')) return false
  if (value.includes('\0')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  return true
}

/**
 * Throw unless a string is a safe single path segment.
 *
 * @param {unknown} value - Candidate segment.
 * @param {string} [what] - What the segment names, for the message.
 * @returns {string} The segment, narrowed to `string`.
 */
export function assertSafeSegment(value, what = '路径片段') {
  if (!isSafeSegment(value)) {
    throw new PathSafetyError(`${what}不合法：${JSON.stringify(value)}`, 'path-unsafe')
  }
  return value
}

/**
 * Join a user-controlled segment onto a trusted base directory.
 *
 * Resolution is performed twice — once lexically and once after removing
 * symlinks is *not* attempted, because the target may not exist yet. The
 * lexical check is the one that matters here: it guarantees the resulting path
 * is inside `base` as a path, so a later `mkdir`/`writeFile` cannot be steered
 * elsewhere by `..` in the segment.
 *
 * @param {string} base - Trusted absolute directory.
 * @param {...string} segments - Untrusted segments, each validated.
 * @returns {string} Absolute path inside `base`.
 */
export function resolveInside(base, ...segments) {
  if (typeof base !== 'string' || !isAbsolute(base)) {
    throw new PathSafetyError(`基准目录必须是绝对路径：${String(base)}`, 'path-unsafe')
  }
  for (const segment of segments) assertSafeSegment(segment)

  const target = resolve(join(base, ...segments))
  const baseResolved = resolve(base)
  const relation = relative(baseResolved, target)
  if (relation === '' ) return target
  if (relation.startsWith('..') || isAbsolute(relation)) {
    throw new PathSafetyError(`目标路径逃逸出基准目录：${target}`, 'path-unsafe')
  }
  return target
}

/**
 * Expand a leading `~` and return an absolute path.
 *
 * A leading `~/` is the only tilde form accepted. `~user` is rejected rather
 * than passed through to the shell convention, because resolving another user's
 * home directory is never something this plugin needs and silently producing a
 * wrong absolute path is worse than refusing.
 *
 * @param {string} input - Possibly tilde-prefixed path.
 * @param {{ home?: string, cwd?: string }} [options] - Overrides for tests.
 * @returns {string} Absolute path.
 */
export function expandHome(input, options = {}) {
  const home = options.home ?? homedir()
  const cwd = options.cwd ?? process.cwd()
  const text = String(input ?? '')
  if (text === '~') return home
  if (text.startsWith('~/')) return join(home, text.slice(2))
  if (text.startsWith('~')) {
    throw new PathSafetyError(
      `不支持 ~user 形式的路径：${text}（只接受 ~ 或 ~/…）`,
      'path-unsupported-tilde',
    )
  }
  return isAbsolute(text) ? text : resolve(cwd, text)
}

/**
 * The DSH home directory — the root of all session and storage data.
 *
 * Resolution order matters and is a real bug source, not a style choice:
 *
 *   1. `profileContext.home` — the service that actually knows. Desktop boots
 *      the Host with **no** `DSH_HOME` in the environment, so an
 *      environment-only lookup silently resolves the wrong directory.
 *   2. `DSH_HOME` — correct for a CLI-launched profile and for our own tests.
 *   3. `~/.dsh` — the documented default.
 *
 * @param {{ profileContext?: { home?: string }, env?: NodeJS.ProcessEnv }} [options]
 *   - Injected for testability.
 * @returns {string} Absolute path to the DSH home.
 */
export function resolveDshHome(options = {}) {
  const env = options.env ?? process.env
  const fromService = options.profileContext?.home
  if (typeof fromService === 'string' && fromService !== '') {
    return expandHome(fromService)
  }
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return expandHome(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * The profile directory of the running Host, when one is known.
 *
 * @param {{ profileContext?: { dir?: string }, env?: NodeJS.ProcessEnv }} [options]
 *   - Injected for testability.
 * @returns {string | undefined} Absolute profile directory, or undefined.
 */
export function resolveProfileDir(options = {}) {
  const env = options.env ?? process.env
  const fromService = options.profileContext?.dir
  if (typeof fromService === 'string' && fromService !== '') {
    return expandHome(fromService)
  }
  const fromEnv = env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv !== '') return expandHome(fromEnv)
  return undefined
}

/**
 * The full set of directories this plugin uses.
 *
 * Everything lives under one `stateDir` so uninstalling is a single `rm -rf`
 * and so a test can point the whole plugin at a temporary directory by
 * overriding one value. Nothing here is ever derived from a remote bundle
 * without going through {@link resolveInside}.
 *
 * @typedef {object} SyncPaths
 * @property {string} dshHome - Root DSH data directory.
 * @property {string} profileDir - Profile directory, when known.
 * @property {string} stateDir - This plugin's state root.
 * @property {string} configFile - The user config document.
 * @property {string} bindingsFile - The repository binding table.
 * @property {string} stateFile - Last-run and per-repository sync state.
 * @property {string} mirrorDir - Parent of per-repository transport clones.
 * @property {string} backupDir - Pre-write snapshots, never auto-deleted.
 * @property {string} logFile - Structured operation log.
 */

/**
 * Resolve every directory this plugin owns.
 *
 * @param {object} [options] - Resolution inputs.
 * @param {string} [options.stateDir] - Explicit override; empty means default.
 * @param {string} [options.dshHome] - Explicit DSH home override.
 * @param {{ home?: string, dir?: string }} [options.profileContext] - Host facts.
 * @param {NodeJS.ProcessEnv} [options.env] - Environment override.
 * @returns {SyncPaths} Resolved paths.
 */
export function resolvePaths(options = {}) {
  const dshHome = options.dshHome ?? resolveDshHome(options)
  const profileDir = resolveProfileDir(options)

  const explicit = typeof options.stateDir === 'string' ? options.stateDir.trim() : ''
  // An empty override means "the default", matching the schema's empty-string
  // default so the settings page can show the effective path without storing it.
  const stateDir = explicit === '' ? join(dshHome, 'repo-session-sync') : expandHome(explicit)

  const mirrorDir = join(stateDir, 'mirrors')
  const backupDir = join(stateDir, 'backups')

  return {
    dshHome,
    profileDir,
    stateDir,
    configFile: join(stateDir, 'config.json'),
    bindingsFile: join(stateDir, 'bindings.json'),
    stateFile: join(stateDir, 'state.json'),
    mirrorDir,
    backupDir,
    logFile: join(stateDir, 'operations.log'),
  }
}

/**
 * Where DSH keeps sessions.
 *
 * Exported so the engine and the UI agree on one definition instead of each
 * spelling out `<dshHome>/sessions`.
 *
 * @param {string} dshHome - Resolved DSH home.
 * @returns {string} Absolute sessions root.
 */
export function sessionsRoot(dshHome) {
  return join(dshHome, 'sessions')
}

/**
 * Where DSH keeps its storage documents, including the workspace registry.
 *
 * @param {string} dshHome - Resolved DSH home.
 * @returns {string} Absolute storages root.
 */
export function storagesRoot(dshHome) {
  return join(dshHome, 'storages')
}

/**
 * Whether `candidate` is inside `parent`, after resolution.
 *
 * @param {string} parent - Directory that must contain the candidate.
 * @param {string} candidate - Path to test.
 * @returns {boolean} True when candidate is parent or below it.
 */
export function isInside(parent, candidate) {
  const relation = relative(resolve(parent), resolve(candidate))
  if (relation === '') return true
  return !relation.startsWith('..') && !isAbsolute(relation) && relation !== `${sep}..`
}

/**
 * Render a path for display without leaking an absolute home directory.
 *
 * The plugin's own UI and logs use this so that a screenshot or a pasted log
 * never contains a full personal path. `/reset/of/home/project` becomes
 * `~/project`; anything outside the home directory is returned untouched.
 *
 * @param {string} target - Absolute path.
 * @param {{ home?: string }} [options] - Home override for tests.
 * @returns {string} Possibly abbreviated path.
 */
export function displayPath(target, options = {}) {
  const home = options.home ?? homedir()
  const absolute = resolve(target)
  if (absolute === home) return '~'
  if (isInside(home, absolute)) {
    const rest = relative(home, absolute)
    return rest === '' ? '~' : `~/${rest.split(sep).join('/')}`
  }
  return absolute
}
