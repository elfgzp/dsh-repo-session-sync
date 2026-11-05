/**
 * Durable state: the config document, the binding table, per-repository sync
 * state, and the operation log.
 *
 * All writes are **atomic** (temp file + rename in the same directory), so a
 * crash mid-write leaves either the previous complete document or the new one —
 * never a truncated JSON file that would make the plugin fail to start. Reads
 * tolerate a missing or corrupt file and fall back to defaults, because losing
 * a settings page is far better than failing to boot.
 *
 * This module imports only `node:` built-ins plus sibling pure modules, so the
 * whole persistence layer is testable with `node --test` and no DSH present.
 *
 * @module dsh-repo-session-sync/store
 */

import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { BindingTable, createBinding } from './repo-binding.js'
import { defaultUserConfig, normalizeUserConfig } from './config.js'
import { SyncError, ERROR_CODES } from './errors.js'

/**
 * Write a file atomically.
 *
 * `rename` over an existing path is atomic on POSIX and on Windows for the
 * same-volume case, which is why the temp file is created next to the target
 * rather than in the OS temp directory: a cross-device rename is not atomic and
 * can fail outright.
 *
 * @param {string} filePath - Destination file.
 * @param {string} content - Complete file content.
 * @returns {Promise<void>} Resolves when the rename has been committed.
 */
async function writeFileAtomic(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true })
  const temp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`
  let handle
  try {
    handle = await open(temp, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    // fsync before rename: without it the rename can be durable while the data
    // it points at is not, which on a power loss yields a zero-length document.
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, filePath)
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Read and parse a JSON document, returning `undefined` when it is unusable.
 *
 * A corrupt document is not an error here: the caller decides whether to warn
 * and continue with defaults or to refuse. Throwing from a read would make a
 * single bad byte brick the plugin.
 *
 * @param {string} filePath - File to read.
 * @returns {Promise<unknown | undefined>} Parsed value, or undefined.
 */
async function readJsonQuiet(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Persistence for one plugin installation.
 *
 * The store is the only thing that knows file names; every other module works
 * with plain objects. That keeps the engine free of I/O policy and makes the
 * tests able to use a temporary directory without patching anything.
 */
export class StateStore {
  /**
   * @param {import('./paths.js').SyncPaths} paths - Resolved directories.
   */
  constructor(paths) {
    /** @type {import('./paths.js').SyncPaths} */
    this.paths = paths
    /** Serialized writer, so two concurrent saves cannot interleave renames. */
    this.#writeChain = Promise.resolve()
  }

  /** @type {Promise<unknown>} */
  #writeChain

  /**
   * Serialize an async write behind any in-flight write.
   *
   * @template T
   * @param {() => Promise<T>} operation - Work to serialize.
   * @returns {Promise<T>} The operation's result.
   */
  #serialize(operation) {
    const next = this.#writeChain.then(operation, operation)
    // Keep the chain alive but never let a rejection poison the next writer.
    this.#writeChain = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * Create the state directories if they do not exist.
   *
   * @returns {Promise<void>} Resolves when every directory exists.
   */
  async ensureDirs() {
    await mkdir(this.paths.stateDir, { recursive: true, mode: 0o700 })
    await mkdir(this.paths.mirrorDir, { recursive: true, mode: 0o700 })
    await mkdir(this.paths.backupDir, { recursive: true, mode: 0o700 })
  }

  /**
   * Read the user config, falling back to defaults.
   *
   * @returns {Promise<import('./config.js').UserConfig>} Normalized config.
   */
  async readUserConfig() {
    const document = await readJsonQuiet(this.paths.configFile)
    return normalizeUserConfig(document)
  }

  /**
   * Persist the user config.
   *
   * @param {import('./config.js').UserConfig} config - Complete document.
   * @returns {Promise<import('./config.js').UserConfig>} The written document.
   */
  async writeUserConfig(config) {
    const normalized = normalizeUserConfig(config)
    await this.ensureDirs()
    await this.#serialize(() => writeFileAtomic(this.paths.configFile, `${JSON.stringify(normalized, null, 2)}\n`))
    return normalized
  }

  /**
   * Read the binding table, dropping unusable rows.
   *
   * @returns {Promise<{ table: BindingTable, dropped: Array<{ index: number, reason: string }> }>}
   *   Rebuilt table and any rows that were skipped.
   */
  async readBindings() {
    const document = await readJsonQuiet(this.paths.bindingsFile)
    if (document === undefined) return { table: new BindingTable(), dropped: [] }
    return BindingTable.fromJSON(document)
  }

  /**
   * Persist the binding table atomically.
   *
   * @param {BindingTable} table - Table to write.
   * @returns {Promise<void>} Resolves when committed.
   */
  async writeBindings(table) {
    await this.ensureDirs()
    const document = table.toJSON()
    await this.#serialize(() => writeFileAtomic(this.paths.bindingsFile, `${JSON.stringify(document, null, 2)}\n`))
  }

  /**
   * Read the per-repository sync state document.
   *
   * @returns {Promise<SyncStateDocument>} State, or an empty document.
   */
  async readState() {
    const document = await readJsonQuiet(this.paths.stateFile)
    return normalizeStateDocument(document)
  }

  /**
   * Persist the per-repository sync state document.
   *
   * @param {SyncStateDocument} state - Complete document.
   * @returns {Promise<void>} Resolves when committed.
   */
  async writeState(state) {
    await this.ensureDirs()
    const normalized = normalizeStateDocument(state)
    await this.#serialize(() => writeFileAtomic(this.paths.stateFile, `${JSON.stringify(normalized, null, 2)}\n`))
  }

  /**
   * Append one structured line to the operation log.
   *
   * The log is plain JSON Lines on purpose: it can be `tail`ed, `jq`'d, and
   * attached to a bug report without a parser, and appending cannot corrupt
   * earlier entries. Failures to log are swallowed — logging must never be the
   * reason a sync fails.
   *
   * @param {{ op: string, repoId?: string, result: string, [key: string]: unknown }} entry
   *   Structured record.
   * @returns {Promise<void>} Resolves when written.
   */
  async appendLog(entry) {
    try {
      await mkdir(dirname(this.paths.logFile), { recursive: true })
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
      // `a` mode: concurrent appends of a single line are atomic for writes
      // below PIPE_BUF, which a log line comfortably is.
      const handle = await open(this.paths.logFile, 'a', 0o600)
      try {
        await handle.writeFile(`${line}\n`, 'utf8')
      } finally {
        await handle.close()
      }
    } catch {
      // Intentionally ignored: see the method contract.
    }
  }

  /**
   * Whether the state directory already exists.
   *
   * The settings page uses this to tell a first run from a returning install
   * without creating directories as a side effect of opening the page.
   *
   * @returns {Promise<boolean>} True when the directory exists.
   */
  async exists() {
    try {
      const info = await stat(this.paths.stateDir)
      return info.isDirectory()
    } catch {
      return false
    }
  }
}

/**
 * Persisted per-repository sync state.
 *
 * @typedef {object} RepoSyncState
 * @property {string} repoId - Which binding this belongs to.
 * @property {number} [lastUpAt] - Epoch ms of the last successful upload.
 * @property {number} [lastDownAt] - Epoch ms of the last successful download.
 * @property {string} [lastResult] - Last outcome code, e.g. `up-to-date`.
 * @property {string} [remoteHead] - Last observed remote commit id.
 * @property {string} [localHead] - Local commit id at the last successful sync.
 * @property {number} [sessionCount] - Sessions known for this repository.
 * @property {string} [backupPath] - Most recent backup directory, for recovery.
 */

/**
 * The persisted state document.
 *
 * @typedef {object} SyncStateDocument
 * @property {number} version - Document version.
 * @property {Record<string, RepoSyncState>} repos - Per-binding state, keyed by repo id.
 * @property {number} updatedAt - Epoch milliseconds.
 */

/**
 * Build an empty state document.
 *
 * @returns {SyncStateDocument} Empty document.
 */
export function emptyStateDocument() {
  return { version: 1, repos: {}, updatedAt: Date.now() }
}

/**
 * Normalize a state document, dropping rows that could not be tied to a repo.
 *
 * @param {unknown} document - Value read from disk.
 * @returns {SyncStateDocument} Normalized document.
 */
export function normalizeStateDocument(document) {
  const base = emptyStateDocument()
  if (document === null || typeof document !== 'object') return base
  const source = /** @type {Record<string, unknown>} */ (document)
  /** @type {Record<string, RepoSyncState>} */
  const repos = {}

  const rawRepos = source.repos
  if (rawRepos !== null && typeof rawRepos === 'object' && !Array.isArray(rawRepos)) {
    for (const [repoId, value] of Object.entries(/** @type {Record<string, unknown>} */ (rawRepos))) {
      if (value === null || typeof value !== 'object') continue
      const row = /** @type {Record<string, unknown>} */ (value)
      // The map key is authoritative: a row whose embedded id disagrees with the
      // key is a sign of a hand-edit or a merge, and the key is what lookups use.
      /** @type {RepoSyncState} */
      const normalized = { repoId }
      if (Number.isFinite(Number(row.lastUpAt))) normalized.lastUpAt = Number(row.lastUpAt)
      if (Number.isFinite(Number(row.lastDownAt))) normalized.lastDownAt = Number(row.lastDownAt)
      if (typeof row.lastResult === 'string') normalized.lastResult = row.lastResult
      if (typeof row.remoteHead === 'string') normalized.remoteHead = row.remoteHead
      if (typeof row.localHead === 'string') normalized.localHead = row.localHead
      if (Number.isFinite(Number(row.sessionCount))) normalized.sessionCount = Number(row.sessionCount)
      if (typeof row.backupPath === 'string') normalized.backupPath = row.backupPath
      repos[repoId] = normalized
    }
  }

  return {
    version: 1,
    repos,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : base.updatedAt,
  }
}

/**
 * Read the binding table, tolerating a total absence of state.
 *
 * Used by the tool and the settings routes as a one-liner so neither has to know
 * whether the store has been initialized.
 *
 * @param {StateStore} store - Store to read from.
 * @returns {Promise<BindingTable>} Current table (possibly empty).
 */
export async function loadBindingsOrEmpty(store) {
  try {
    const { table } = await store.readBindings()
    return table
  } catch {
    return new BindingTable()
  }
}

/**
 * Persist a single normalized binding into the table file.
 *
 * @param {StateStore} store - Store to write through.
 * @param {import('./repo-binding.js').RepoBinding} binding - Binding to upsert.
 * @returns {Promise<import('./repo-binding.js').RepoBinding>} The stored binding.
 */
export async function upsertBinding(store, binding) {
  const { table } = await store.readBindings()
  const result = table.upsert(binding)
  await store.writeBindings(table)
  return result.binding
}

/**
 * Add a binding from a repository path and remote facts.
 *
 * @param {StateStore} store - Store to write through.
 * @param {{ repoPath: string, remoteUrl: string, branch?: string, direction?: string, transport?: string }} input
 *   User-supplied binding facts.
 * @param {object} [options] - Forwarded to {@link createBinding}.
 * @returns {Promise<{ binding: import('./repo-binding.js').RepoBinding, replaced: boolean }>}
 *   Stored binding and whether an older row for the same identity was replaced.
 * @throws {SyncError} When the input cannot form an identity.
 */
export async function bindRepository(store, input, options = {}) {
  const { table } = await store.readBindings()
  const binding = createBinding(input, options)
  const result = table.upsert(binding)
  await store.writeBindings(table)
  return { binding: result.binding, replaced: result.replaced }
}

/**
 * Remove a binding.
 *
 * @param {StateStore} store - Store to write through.
 * @param {string} repoId - Binding id.
 * @returns {Promise<boolean>} True when a row was removed.
 * @throws {SyncError} When the id is unknown.
 */
export async function unbindRepository(store, repoId) {
  const { table } = await store.readBindings()
  const removed = table.remove(repoId)
  if (!removed) {
    throw new SyncError(ERROR_CODES.UNKNOWN_REPO, '没有找到这个仓库绑定。', {
      hint: '刷新设置页后重试。',
    })
  }
  await store.writeBindings(table)
  return true
}

export { join as joinPath }
