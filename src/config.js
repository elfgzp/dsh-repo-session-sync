/**
 * Configuration: the Loader row schema, the user-editable document, and the
 * merge rules between them.
 *
 * There are deliberately **two** configuration layers, because they answer
 * different questions and have different lifetimes:
 *
 *   - **Row config** (`cordis.patch.yml` → `Config`) is deployment policy: where
 *     state lives, what limits apply, which git binary to use. It is edited by
 *     someone who can write YAML and it should survive a settings-page reset.
 *   - **User config** (`<stateDir>/config.json`) is what the settings page
 *     writes at runtime: defaults for new bindings, the auto-sync switch, and
 *     the transport choice. Writing it never requires a restart.
 *
 * {@link resolveConfig} merges them with the row layer winning on conflict, so
 * a deployment pin in YAML cannot be silently overridden from the browser.
 *
 * @module dsh-repo-session-sync/config
 */

import { SyncError, ERROR_CODES } from './errors.js'
import {
  DEFAULT_SYNC_BRANCH,
  SYNC_DIRECTION,
  SYNC_DIRECTIONS,
  TRANSPORT,
  TRANSPORTS,
  normalizeDirection,
  normalizeTransport,
} from './repo-binding.js'
import { resolveDshHome, resolvePaths } from './paths.js'

/**
 * Schema of this plugin's Loader row.
 *
 * Every field has a default so an empty `config:` block is valid — a bundle that
 * fails to activate because the user omitted a field is a self-inflicted wound.
 *
 * The schema is exported as a *factory* rather than as a bare schema object so
 * this module can be imported by `node --test` in a plain checkout (where
 * `@deepseek-ai/schemastery` does not resolve) and only materialized at
 * activation time from `src/index.js`. See {@link createConfigSchema}.
 *
 * @returns {object} A schemastery object schema.
 */
export function createConfigSchema(z) {
  return z.object({
    stateDir: z.string()
      .description(
        '状态目录：仓库绑定表、同步状态、传输镜像与备份都放在这里。留空表示 `$DSH_HOME/repo-session-sync`。',
      )
      .default(''),
    gitPath: z.string()
      .description('git 可执行文件路径。留空表示使用 PATH 里的 `git`。')
      .default(''),
    defaultDirection: z.union(['up', 'down', 'both'])
      .description('新绑定仓库的默认同步方向。')
      .default(SYNC_DIRECTION.BOTH),
    defaultTransport: z.union(['git-branch', 'git-repo', 'rsync', 'dsh-remote'])
      .description(
        '默认传输通道。`git-branch` 在项目自己的仓库里用一个 orphan 分支存放会话包，复用你现有的 git 凭据。',
      )
      .default(TRANSPORT.GIT_BRANCH),
    syncBranch: z.string()
      .description('`git-branch` 通道用来存放会话包的分支名。')
      .default(DEFAULT_SYNC_BRANCH),
    autoSync: z.boolean()
      .description('自动同步开关。关闭时只能从设置页或工具手动触发。')
      .default(false),
    autoSyncIntervalMs: z.number().step(1000).min(0)
      .description('自动同步检查间隔（毫秒）。0 表示不启用定时检查。')
      .default(0),
    maxSessionBytes: z.number().step(1).min(1024)
      .description('单个会话包的大小上限（字节）；超过则拒绝该会话并在报告中点名。')
      .default(8388608),
    maxBundleBytes: z.number().step(1).min(1024)
      .description('单次同步载荷的总字节上限（字节）。')
      .default(67108864),
    keepBackups: z.number().step(1).min(1).max(100)
      .description('保留多少个下行前的备份快照。写入永远先备份，备份不会被自动删除到一个都不剩。')
      .default(10),
    useSystemPrompt: z.boolean()
      .description('是否在系统提示里加入本插件的同步说明，让 agent 知道有这个能力。')
      .default(true),
  })
}

/**
 * The row config, resolved and normalized.
 *
 * @typedef {object} RowConfig
 * @property {string} stateDir - Explicit state directory, or '' for the default.
 * @property {string} gitPath - Explicit git binary, or '' for PATH lookup.
 * @property {'up'|'down'|'both'} defaultDirection - Default for new bindings.
 * @property {'git-branch'|'git-repo'|'rsync'|'dsh-remote'} defaultTransport - Default channel.
 * @property {string} syncBranch - Default bundle-carrying ref.
 * @property {boolean} autoSync - Auto-sync enabled.
 * @property {number} autoSyncIntervalMs - Timer interval in ms, 0 = off.
 * @property {number} maxSessionBytes - Per-session cap.
 * @property {number} maxBundleBytes - Per-operation cap.
 * @property {number} keepBackups - Backup retention count.
 * @property {boolean} useSystemPrompt - Whether to contribute prompt text.
 */

/**
 * The runtime user config, as persisted.
 *
 * @typedef {object} UserConfig
 * @property {number} version - Document version, currently 1.
 * @property {'up'|'down'|'both'} defaultDirection - Default direction for new bindings.
 * @property {'git-branch'|'git-repo'|'rsync'|'dsh-remote'} defaultTransport - Default channel.
 * @property {boolean} autoSync - Auto-sync switch from the settings page.
 * @property {number} autoSyncIntervalMs - Interval in ms, 0 = off.
 * @property {number} promptVersion - Which first-run prompt the user has answered.
 * @property {number} updatedAt - Epoch milliseconds.
 */

/**
 * Default user config.
 *
 * @returns {UserConfig} A fresh default document.
 */
export function defaultUserConfig() {
  const now = Date.now()
  return {
    version: 1,
    defaultDirection: SYNC_DIRECTION.BOTH,
    defaultTransport: TRANSPORT.GIT_BRANCH,
    autoSync: false,
    autoSyncIntervalMs: 0,
    promptVersion: 0,
    updatedAt: now,
  }
}

/**
 * Normalize a persisted user config, tolerating absent or corrupt fields.
 *
 * A hand-edited or partially-written JSON file must degrade to defaults rather
 * than break the settings page, so each field falls back independently.
 *
 * @param {unknown} document - Value read from disk.
 * @returns {UserConfig} Normalized config.
 */
export function normalizeUserConfig(document) {
  const base = defaultUserConfig()
  if (document === null || typeof document !== 'object') return base
  const source = /** @type {Record<string, unknown>} */ (document)

  const direction = normalizeDirection(source.defaultDirection, base.defaultDirection)
  const transport = normalizeTransport(source.defaultTransport, base.defaultTransport)
  const autoSync = source.autoSync === true
  const intervalRaw = typeof source.autoSyncIntervalMs === 'number'
    ? source.autoSyncIntervalMs
    : Number(source.autoSyncIntervalMs)

  return {
    version: 1,
    defaultDirection: direction,
    defaultTransport: transport,
    autoSync,
    autoSyncIntervalMs: Number.isFinite(intervalRaw) && intervalRaw > 0
      ? Math.max(5_000, Math.floor(intervalRaw))
      : 0,
    promptVersion: Number.isFinite(Number(source.promptVersion)) ? Number(source.promptVersion) : 0,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : base.updatedAt,
  }
}

/**
 * Apply a partial settings-page update to a user config.
 *
 * Only known keys are copied; anything else in the request body is ignored, so
 * a crafted request cannot persist arbitrary fields into durable state.
 *
 * @param {UserConfig} current - Current config.
 * @param {unknown} patch - Request body.
 * @returns {UserConfig} Updated config.
 * @throws {SyncError} When the patch is not an object.
 */
export function applyUserConfigPatch(current, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new SyncError(ERROR_CODES.BAD_REQUEST, '设置内容必须是一个对象。')
  }
  const source = /** @type {Record<string, unknown>} */ (patch)
  const next = { ...current }

  if (source.defaultDirection !== undefined) {
    if (!SYNC_DIRECTIONS.includes(/** @type {string} */ (source.defaultDirection))) {
      throw new SyncError(
        ERROR_CODES.BAD_REQUEST,
        `同步方向必须是 ${SYNC_DIRECTIONS.join(' / ')} 之一。`,
        { hint: '刷新设置页后重试。' },
      )
    }
    next.defaultDirection = /** @type {any} */ (source.defaultDirection)
  }

  if (source.defaultTransport !== undefined) {
    if (!TRANSPORTS.includes(/** @type {string} */ (source.defaultTransport))) {
      throw new SyncError(
        ERROR_CODES.BAD_REQUEST,
        `传输通道必须是 ${TRANSPORTS.join(' / ')} 之一。`,
      )
    }
    next.defaultTransport = /** @type {any} */ (source.defaultTransport)
  }

  if (source.autoSync !== undefined) next.autoSync = source.autoSync === true

  if (source.autoSyncIntervalMs !== undefined) {
    const interval = Number(source.autoSyncIntervalMs)
    if (!Number.isFinite(interval) || interval < 0) {
      throw new SyncError(ERROR_CODES.BAD_REQUEST, '自动同步间隔必须是大于等于 0 的数字。')
    }
    next.autoSyncIntervalMs = interval === 0 ? 0 : Math.max(5_000, Math.floor(interval))
  }

  if (source.promptVersion !== undefined) {
    const version = Number(source.promptVersion)
    if (Number.isFinite(version)) next.promptVersion = version
  }

  next.updatedAt = Date.now()
  return next
}

/**
 * Merge row config and user config into the single resolved view the engine uses.
 *
 * The row layer wins wherever it has an opinion. `autoSync` and
 * `autoSyncIntervalMs` are the exception: those are explicitly runtime switches
 * the user owns, so the settings-page value wins and the row merely supplies a
 * default for a fresh install.
 *
 * @param {Partial<RowConfig>} row - Raw row config from the Loader.
 * @param {UserConfig} user - Persisted user config.
 * @param {object} [options] - Resolution inputs.
 * @param {{ home?: string, dir?: string }} [options.profileContext] - Host facts.
 * @param {NodeJS.ProcessEnv} [options.env] - Environment override.
 * @returns {{ config: RowConfig & UserConfig, paths: import('./paths.js').SyncPaths }}
 *   Resolved config plus the paths derived from it.
 */
export function resolveConfig(row = {}, user = defaultUserConfig(), options = {}) {
  const raw = row ?? {}

  const rowConfig = {
    stateDir: typeof raw.stateDir === 'string' ? raw.stateDir.trim() : '',
    gitPath: typeof raw.gitPath === 'string' ? raw.gitPath.trim() : '',
    defaultDirection: normalizeDirection(raw.defaultDirection, SYNC_DIRECTION.BOTH),
    defaultTransport: normalizeTransport(raw.defaultTransport, TRANSPORT.GIT_BRANCH),
    syncBranch: typeof raw.syncBranch === 'string' && raw.syncBranch.trim() !== ''
      ? raw.syncBranch.trim()
      : DEFAULT_SYNC_BRANCH,
    autoSync: raw.autoSync === true,
    autoSyncIntervalMs: normalizeIntervalOrZero(raw.autoSyncIntervalMs),
    maxSessionBytes: normalizePositiveInt(raw.maxSessionBytes, 8388608, 1024),
    maxBundleBytes: normalizePositiveInt(raw.maxBundleBytes, 67108864, 1024),
    keepBackups: Math.min(100, normalizePositiveInt(raw.keepBackups, 10, 1)),
    useSystemPrompt: raw.useSystemPrompt === undefined ? true : raw.useSystemPrompt === true,
  }

  // dshHome is needed before paths can be resolved; the service wins over the
  // environment because Desktop does not export it (see `paths.js`).
  const dshHome = resolveDshHome(options)
  const paths = resolvePaths({
    stateDir: rowConfig.stateDir,
    dshHome,
    profileContext: options.profileContext,
    env: options.env,
  })

  const config = {
    ...rowConfig,
    // The user owns the runtime switch; the row only seeds a fresh install.
    autoSync: user.autoSync,
    autoSyncIntervalMs: user.autoSyncIntervalMs,
    defaultDirection: user.defaultDirection,
    defaultTransport: user.defaultTransport,
    promptVersion: user.promptVersion,
  }

  return { config, paths }
}

/**
 * Coerce a value into a non-negative interval, 0 meaning off.
 *
 * @param {unknown} value - Candidate milliseconds.
 * @returns {number} Normalized interval.
 */
function normalizeIntervalOrZero(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return Math.max(5_000, Math.floor(numeric))
}

/**
 * Coerce a value into a positive integer with a floor.
 *
 * @param {unknown} value - Candidate.
 * @param {number} fallback - Used when the value is unusable.
 * @param {number} floor - Smallest accepted value.
 * @returns {number} Normalized integer.
 */
function normalizePositiveInt(value, fallback, floor) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.max(floor, Math.floor(numeric))
}

/**
 * Whether the plugin should act without the user asking.
 *
 * Both switches must agree: a deployment that enables the timer while the
 * settings page has auto-sync off must stay quiet, and vice versa.
 *
 * @param {{ autoSync: boolean, autoSyncIntervalMs: number }} config - Resolved config.
 * @returns {boolean} True when the timer may run.
 */
export function autoSyncEnabled(config) {
  return config.autoSync === true && config.autoSyncIntervalMs > 0
}
