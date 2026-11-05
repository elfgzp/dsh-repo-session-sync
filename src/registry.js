/**
 * Workspace registry 接入 —— 让下行写入的会话**真的出现在 DSH 侧栏**。
 *
 * ## 为什么需要这一层
 *
 * 「文件写到磁盘上」和「用户能看到」在 DSH 里是**两件事**。
 *
 * 实测本机：磁盘上 218 个会话文件，`~/.dsh/storages/workspace.json` 只登记了
 * 45 个 —— 173 个是在盘上但不可见的孤儿。原因是会话进入 registry 只有一条
 * 路径：DSH 自己创建会话时调 `attachSession()`。我们外部写文件不会触发它。
 *
 * 而且 `reportFilteredCandidates()` 会**主动把不合格的会话从成员里剔掉**：
 *
 * ```js
 * const reason = this.headers.has(sessionId)
 *   ? `canonical cwd '${path}' differs from workspace path '${record.path}'`
 *   : "session header is missing";
 * this.ctx.logger.warn(`workspace '${entity.id}' filtered session '${sessionId}' from membership: ${reason}`);
 * ```
 *
 * 所以「只写盘不登记」→ 不可见；「登记了但 cwd 不匹配」→ 仍不可见。
 *
 * ## 依赖注入而不是 ctx.get
 *
 * `ctx.workspaceRegistry` 只在 DSH 宿主里存在。本模块把它作为**参数**接收，
 * 于是可以用 stub 在 `node --test` 里完整测试，不需要启动 DSH。
 * 这与 `transport.js` / `session-store.js` 保持纯 Node 模块的做法一致。
 *
 * ## 为什么不用 `super(ctx, "workspaceRegistry")` 里的内部字段
 *
 * 我们只用三个公开方法：
 *   - `registry.resolveByPath(path)`  按 canonical 路径找现有 workspace
 *   - `registry.create(path, title)`  幂等创建（已存在则返回现有实体）
 *   - `entity.attachSession(id)`      登记，内部自动做 cwd 三重校验
 *
 * 全部是 DSH 设计给插件用的接口，不是抢写 `workspace.json`。
 *
 * @module dsh-repo-session-sync/registry
 */

import { realpath, rm, stat } from 'node:fs/promises'

import { isAbsolute, relative, resolve } from 'node:path'

import { ERROR_CODES, SyncError } from './errors.js'

/**
 * 把一个路径解析成 DSH 认可的 canonical 真实路径。
 *
 * DSH 内部用 `realpathNormalize()`，而 macOS 上 `/tmp` 实际是
 * `/private/tmp` 的软链 —— 这是最容易踩的坑：我们若拿原始字符串去比对，
 * 永远匹配不上 `record.path`，会话就静静地不出现。
 *
 * @param {string} path 候选路径
 * @returns {Promise<string>} realpath 后的绝对路径
 * @throws {SyncError} 路径不存在或不是目录
 */
export async function canonicalRepoPath(path) {
  if (typeof path !== 'string' || path === '') {
    throw new SyncError(ERROR_CODES.NOT_CONFIGURED, '仓库路径为空。', {
      hint: '请在设置页把仓库绑定补上本地路径。',
    })
  }

  let resolved
  try {
    resolved = await realpath(path)
  } catch (cause) {
    throw new SyncError(ERROR_CODES.REPO_PATH_MISSING, `仓库路径不存在或不可访问：${path}`, {
      hint: `请先把仓库 clone 到该路径，或修正绑定里的本地路径。`,
      cause,
      detail: { path },
    })
  }

  let info
  try {
    info = await stat(resolved)
  } catch (cause) {
    throw new SyncError(ERROR_CODES.REPO_PATH_MISSING, `无法读取仓库路径：${resolved}`, { cause })
  }
  if (!info.isDirectory()) {
    throw new SyncError(ERROR_CODES.REPO_PATH_MISSING, `仓库路径不是目录：${resolved}`, {
      hint: '绑定里的本地路径应指向仓库根目录。',
    })
  }

  return resolved
}

/**
 * 下行**之前**的预检：目标仓库路径必须存在且是目录。
 *
 * 为什么要在写入之前做：如果 B 机还没 clone 仓库，重写后的 `cwd` 指向一个
 * 不存在的目录，写进去的会话 `attachSession` 必然失败。那时已经写了文件，
 * 就变成「写进去了但看不见」——比直接报错糟得多。所以先检查，不通过就中止。
 *
 * @param {string} repoPath 绑定里的仓库路径
 * @returns {Promise<{ok: true, canonical: string}>}
 * @throws {SyncError} 路径不可用
 */
export async function preflightRepoPath(repoPath) {
  const canonical = await canonicalRepoPath(repoPath)
  return { ok: true, canonical }
}

/**
 * 回滚「本次新写入但登记失败」的会话文件。
 *
 * ## 为什么必须有这一步
 *
 * `ensureWorkspaceAndAttach()` 会返回 `failed` 清单。如果调用方（引擎）不去
 * 处理它，那些会话文件就留在了磁盘上，但它们**不会出现在 DSH 侧栏** ——
 * 这正是设计里明令要防止的「悬空会话」：用户以为同步完成了，实际看不见；
 * 更糟的是下次同步会把它当成「本机已有」而跳过。
 *
 * ## 安全边界：只删本次新写入的
 *
 * **绝不删已存在的会话。** 判断依据是 `writtenByThisRun` 这个由调用方
 * 精确传入的集合（引擎在写入时就知道哪些是本轮新增的）。我们不去猜、
 * 不去比对内容、不按「看起来像」来推断 —— 删除是不可逆操作，判断依据
 * 必须是确定的事实。
 *
 * @param {object} input
 * @param {string} input.sessionsRoot 会话根目录
 * @param {Array<{sessionId: string, sessionDir: string}>} input.writtenByThisRun
 *   本轮新写入的会话（`sessionDir` 由写入方提供，避免我们重新推算路径出错）
 * @param {(detail: object) => void} [input.log]
 * @returns {Promise<{removed: string[], kept: string[], failed: Array<{sessionId: string, reason: string}>}>}
 */
export async function rollbackNewSessions(input) {
  const { sessionsRoot, writtenByThisRun } = input ?? {}
  const log = typeof input?.log === 'function' ? input.log : () => {}

  const removed = []
  const kept = []
  const failed = []

  if (!Array.isArray(writtenByThisRun) || writtenByThisRun.length === 0) {
    return { removed, kept, failed }
  }
  if (typeof sessionsRoot !== 'string' || sessionsRoot === '') {
    throw new SyncError(ERROR_CODES.BAD_REQUEST, 'rollbackNewSessions 需要 sessionsRoot。')
  }

  const root = resolve(sessionsRoot)

  for (const item of writtenByThisRun) {
    const sessionId = item?.sessionId
    const sessionDir = item?.sessionDir
    if (typeof sessionId !== 'string' || typeof sessionDir !== 'string') {
      failed.push({ sessionId: String(sessionId), reason: '缺少 sessionDir，无法安全定位' })
      continue
    }

    // 双保险：目录必须真的在会话根目录之内（防调用方传错路径把别的东西删了）
    let target
    try {
      target = resolve(sessionDir)
      const relation = relative(root, target)
      if (relation === '' || relation.startsWith('..') || isAbsolute(relation)) {
        failed.push({ sessionId, reason: '目录不在会话根目录内，拒绝删除' })
        continue
      }
    } catch (cause) {
      failed.push({ sessionId, reason: `路径解析失败：${cause?.message ?? cause}` })
      continue
    }

    try {
      await rm(target, { recursive: true, force: true })
      removed.push(sessionId)
    } catch (cause) {
      failed.push({ sessionId, reason: String(cause?.message ?? cause) })
    }
  }

  if (removed.length > 0) {
    log({ phase: 'rollback', event: 'removed', sessionIds: removed })
  }
  if (failed.length > 0) {
    log({ phase: 'rollback', event: 'failed', failures: failed })
  }

  return { removed, kept, failed }
}

/**
 * 确保存在对应 workspace，并把会话登记进去，然后**回读验证**。
 *
 * ## 成功判定为什么是「回读 entity.sessionIds」
 *
 * `entity.sessionIds` 的 getter 实现是：
 * ```js
 * get sessionIds() {
 *   return this.record.sessionIds.filter((id) => this.host.candidateMatches(id, this.record.path));
 * }
 * ```
 * 它**已经是过滤后的结果** —— 登记了但 cwd 不匹配的会话会被这个 getter 剔掉。
 * 所以「`sessionIds.includes(id)` 为真」恰好等价于「DSH 的 workspace 认为这个
 * 会话属于它」，也就等价于「用户在侧栏能看到它」。
 *
 * 这是整个下行链路里唯一能证明闭环的地方，所以必须真的检查它，
 * 而不能只看 `attachSession()` 有没有抛错。
 *
 * @param {object} input
 * @param {object} input.registry `ctx.workspaceRegistry`
 * @param {string} input.repoPath 仓库本地路径
 * @param {string[]} input.sessionIds 已写入磁盘的会话 id
 * @param {string} [input.title] 新建 workspace 时用的标题
 * @param {(detail: object) => void} [input.log] 结构化日志
 * @returns {Promise<{ok: boolean, canonical: string, workspaceId: string, attached: string[], failed: Array<{sessionId: string, reason: string}>}>}
 * @throws {SyncError} registry 不可用或预检失败
 */
export async function ensureWorkspaceAndAttach(input) {
  const { registry, repoPath, sessionIds, title } = input ?? {}
  const log = typeof input?.log === 'function' ? input.log : () => {}

  if (registry === null || typeof registry !== 'object') {
    throw new SyncError(
      ERROR_CODES.NOT_IMPLEMENTED,
      '当前环境没有 workspace registry，无法让下载的会话出现在侧栏。',
      { hint: '同步引擎需要在 DSH 宿主内运行；请通过插件入口调用。' }
    )
  }
  for (const method of ['resolveByPath', 'create']) {
    if (typeof registry[method] !== 'function') {
      throw new SyncError(
        ERROR_CODES.NOT_IMPLEMENTED,
        `workspace registry 缺少 ${method}()，当前 DSH 版本可能不兼容。`,
        { hint: '请升级 DSH 到支持 workspaceRegistry 的版本。' }
      )
    }
  }
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return { ok: true, canonical: null, workspaceId: null, attached: [], failed: [] }
  }

  // ① 路径必须是真实存在的目录（并解析软链，见 canonicalRepoPath 注释）
  const canonical = await canonicalRepoPath(repoPath)

  // ② 找到或创建 workspace（create 幂等）
  let entity = await registry.resolveByPath(canonical)
  if (entity === undefined || entity === null) {
    entity = await registry.create(canonical, title ?? undefined)
    log({ phase: 'registry', event: 'workspace-created', canonical })
  }

  // ③ 逐个登记
  const attached = []
  const failed = []
  for (const sessionId of sessionIds) {
    try {
      await entity.attachSession(sessionId)
    } catch (error) {
      // `attachSession` 的 cwd 三重校验没过就会抛。这里**不吞掉**，
      // 但要继续尝试其它会话，最后统一报告，让调用方决定回滚范围。
      failed.push({
        sessionId,
        reason: error?.message ?? String(error),
      })
      continue
    }
    attached.push(sessionId)
  }

  // ④ 回读验证：只有出现在过滤后的 sessionIds 里才算真的可见
  const visible = new Set(
    typeof entity.sessionIds === 'object' && entity.sessionIds !== null
      ? Array.from(entity.sessionIds)
      : []
  )
  const attachedButInvisible = attached.filter((id) => !visible.has(id))

  if (attachedButInvisible.length > 0) {
    log({
      phase: 'registry',
      event: 'attached-but-invisible',
      sessionIds: attachedButInvisible,
    })
    for (const sessionId of attachedButInvisible) {
      failed.push({
        sessionId,
        reason:
          'attachSession 未抛错，但该会话没有出现在 workspace 的过滤后成员列表里' +
          '（通常意味着 header.cwd 与 workspace 的 canonical 路径不一致）',
      })
    }
  }

  const attachedVisible = attached.filter((id) => visible.has(id))

  return {
    ok: failed.length === 0,
    canonical,
    workspaceId: entity?.id ?? null,
    attached: attachedVisible,
    failed,
  }
}

/**
 * 校验一批待写入会话的 cwd 是否都能对上目标仓库。
 *
 * 下行前的第二道预检：如果远端会话的 cwd 与目标仓库毫无关系，说明这批
 * 数据不属于这个仓库（可能是绑定配错了，或远端内容被塞进了别的东西）。
 * 与其写进去再被 registry 剔掉，不如提前拒绝。
 *
 * @param {Array<{sessionId?: string, cwd?: string}>} sessions
 * @param {string} canonicalRepoPath 目标仓库的 canonical 路径
 * @returns {{matches: string[], mismatches: Array<{sessionId: string, cwd: string, reason: string}>}}
 */
export function checkCwdMatchesRepo(sessions, canonicalRepoPath) {
  const matches = []
  const mismatches = []
  const repo = String(canonicalRepoPath)

  for (const session of sessions) {
    const sessionId = session?.sessionId ?? session?.id ?? '?'
    const cwd = session?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      // 没有 cwd 的会话无法被 attach（DSH 也会拒绝），归入不匹配
      mismatches.push({ sessionId, cwd: '', reason: '会话 header 没有 cwd，DSH 无法校验归属' })
      continue
    }
    if (cwd === repo || cwd.startsWith(repo + '/') || cwd.startsWith(repo + '\\')) {
      matches.push(sessionId)
    } else {
      mismatches.push({
        sessionId,
        cwd,
        reason: '会话的 cwd 不在目标仓库目录内',
      })
    }
  }

  return { matches, mismatches }
}

export default ensureWorkspaceAndAttach
