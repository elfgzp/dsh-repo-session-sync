/**
 * 锚点 commit —— 记录「这段对话谈的是哪个代码状态」。
 *
 * ## 要解决的问题
 *
 * 会话是长的。用户可能在一个会话里 commit 了 10 次，然后换台机器继续聊。
 * 如果 B 机只拿到对话内容、不知道它当时谈的是哪个代码状态，用户就会对着一份
 * 已经在另一台机器上变化过的代码继续讨论 —— 结论可能完全错。
 *
 * 锚点把「会话」和「git HEAD」绑在一起，让下行时能提示
 * 「此会话记录于 N 个提交之前」。
 *
 * ## 为什么存在同步 ref 的 manifest 里，而不是别处
 *
 * 设计文档 ADR-5 已定，理由（我认同）：
 *
 *   - **不写 `~/.dsh/storages/workspace.json`**：那是 DSH 自己的、带版本号的
 *     状态文件，它自己会迁移。我们写它 = 和 DSH 抢写权，而且它一变我们的数据
 *     就丢了。**只读，绝不写。**
 *   - **不在会话目录旁放 sidecar**：往用户的 `~/.dsh/sessions/` 里塞 DSH 不认识的
 *     文件属于污染用户数据目录；而且 sidecar 本地有效、跨机还得另外同步，等于引入
 *     第三份真相 —— 三份真相必然漂移。
 *   - **放 manifest**：锚点天然随包走、天然有 git 历史可追溯、天然进冲突检测流程。
 *
 * ## 只在 UI 提示，绝不阻断
 *
 * 会话内容本身仍然完全有效。用户可能就是想「接着旧代码状态聊」，所以锚点过期
 * 不是错误，只是信息。**这个模块从不抛错来阻止同步**。
 *
 * @module dsh-repo-session-sync/anchor
 */

import { ERROR_CODES, SyncError } from './errors.js'
import { runGit } from './transport.js'

/** 判断「这个 sha 是不是 HEAD 祖先」等查询用的 git 命令超时。 */
const ANCHOR_GIT_TIMEOUT_MS = 15_000

/** 60 位十六进制 sha 的上限检查（git 目前是 40/64，留余量）。 */
const SHA_RE = /^[0-9a-f]{7,64}$/i

/**
 * 采集当前仓库的锚点。
 *
 * 每次**上行**时采集（不是会话开始时）：因为会话是长的，记录「会话开始时」的
 * commit 会严重过时；记录「最后一次上行时」的 commit 才能表达
 * 「这段对话谈的是这个代码状态」。
 *
 * @param {string} repoPath 仓库工作区路径
 * @param {{runGit?: typeof runGit, subPath?: string, worktree?: string}} [options]
 * @returns {Promise<{
 *   headCommit: string|null, branch: string|null, worktree: string|null,
 *   subPath: string|null, dirtyCount: number, capturedAt: number
 * }>}
 *   `headCommit` 为 null 表示这是一个还没有任何提交的空仓库 —— 不是错误。
 */
export async function captureAnchor(repoPath, options = {}) {
  const git = options.runGit ?? runGit
  const capturedAt = Date.now()

  // 性能考虑：本机实测每次 `git` 进程启动就要 0.25~0.6s，5 次串行调用会让
  // 采集锚点花掉 3 秒 —— 而锚点只是上行时的附加信息，不该主导整个同步耗时。
  // 所以能合并的合并，能并行的并行：下面两条命令并行跑，总共 2 次进程。
  const [headBlock, statusBlock] = await Promise.all([
    // 一次命令取齐：HEAD sha / 分支名 / git-common-dir / toplevel。
    // `--verify -q` 在空仓库时安静失败而不打印错误。
    collect(
      git,
      repoPath,
      [
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
        ['symbolic-ref', '--short', '-q', 'HEAD'],
        ['rev-parse', '--git-common-dir'],
        ['rev-parse', '--show-toplevel'],
      ],
      'capture-anchor:head'
    ),
    // 脏文件数：只用于展示「当时工作区有 N 个未提交改动」，不参与任何判断。
    git(repoPath, ['status', '--porcelain', '--untracked-files=no'], {
      allowFailure: true,
      timeoutMs: ANCHOR_GIT_TIMEOUT_MS,
    }),
  ])

  const headCommit = firstLineOrNull(headBlock[0])
  const branch = firstLineOrNull(headBlock[1])
  const gitCommonDir = firstLineOrNull(headBlock[2])
  const topLevel = firstLineOrNull(headBlock[3])

  // worktree：主语 worktree 的 git-common-dir 指向主仓库；据此判断这不是主工作区。
  // 只做尽力而为的标注，取不到就不标注。
  let worktree = options.worktree ?? null
  if (worktree === null && gitCommonDir !== null && gitCommonDir !== '.git') {
    worktree = topLevel
  }

  let dirtyCount = 0
  if (statusBlock.code === 0) {
    dirtyCount = statusBlock.stdout
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0).length
  }

  return {
    headCommit,
    branch,
    worktree,
    subPath: options.subPath ?? null,
    dirtyCount,
    capturedAt,
  }
}

/**
 * 串行执行一组只读 git 查询，返回各自的结果。
 *
 * 为什么串行而不是并行：这些命令都在同一个仓库上跑，git 会抢 index.lock
 * 之类的锁，并行反而更慢且可能互相干扰。合并的意义是减少**总进程数**。
 *
 * @param {Function} git git 执行器
 * @param {string} repoPath 仓库路径
 * @param {string[][]} commands 命令数组
 * @param {string} tag 日志标记
 * @returns {Promise<Array<{code: number, stdout: Buffer, stderr: string}>>}
 */
async function collect(git, repoPath, commands, tag) {
  const results = []
  for (const args of commands) {
    results.push(
      await git(repoPath, args, { allowFailure: true, timeoutMs: ANCHOR_GIT_TIMEOUT_MS })
    )
  }
  void tag
  return results
}

/** 取输出的第一行；空输出或非零返回码时返回 null。 */
function firstLineOrNull(result) {
  if (!result || result.code !== 0) return null
  const line = result.stdout.toString('utf8').split('\n')[0].trim()
  return line === '' ? null : line
}

/**
 * 比较锚点与当前仓库状态，给出可读的提示。
 *
 * 这个方法**从不抛错**：任何 git 查询失败都降级成一条 `unknown` 提示。
 * 理由：锚点只是提示，不能因为「算不出差了几个提交」就让整个同步失败。
 *
 * @param {string} repoPath 仓库工作区路径
 * @param {{headCommit?: string|null, branch?: string|null}} anchor 锚点
 * @param {{runGit?: typeof runGit}} [options]
 * @returns {Promise<{
 *   status: 'none'|'current'|'behind'|'diverged'|'missing-commit'|'unknown',
 *   commitsBehind: number|null,
 *   shortSha: string|null,
 *   message: string,
 *   advisory: boolean
 * }>}
 */
export async function describeAnchorDrift(repoPath, anchor, options = {}) {
  const git = options.runGit ?? runGit
  const headCommit = anchor?.headCommit

  // ── 没有锚点：老版本上行或空仓库 ──
  if (typeof headCommit !== 'string' || headCommit === '') {
    return {
      status: 'none',
      commitsBehind: null,
      shortSha: null,
      message: '此会话没有记录代码锚点（可能来自较早的同步）。',
      advisory: true,
    }
  }
  if (!SHA_RE.test(headCommit)) {
    // 锚点来自远端，是不可信输入 —— 不合法的 sha 绝不传给 git 命令
    return {
      status: 'unknown',
      commitsBehind: null,
      shortSha: null,
      message: '此会话记录的代码锚点格式不合法，已忽略。',
      advisory: true,
    }
  }

  const shortSha = headCommit.slice(0, 7)

  // ── 本地是否有这个 commit ──
  const hasCommit = await git(repoPath, ['cat-file', '-e', `${headCommit}^{commit}`], {
    allowFailure: true,
    timeoutMs: ANCHOR_GIT_TIMEOUT_MS,
  })
  if (hasCommit.code !== 0) {
    return {
      status: 'missing-commit',
      commitsBehind: null,
      shortSha,
      message: `未找到锚点提交 ${shortSha}，可能需要先 git fetch。`,
      advisory: true,
    }
  }

  // ── 当前 HEAD ──
  const currentHead = await git(repoPath, ['rev-parse', 'HEAD'], {
    allowFailure: true,
    timeoutMs: ANCHOR_GIT_TIMEOUT_MS,
  })
  const head = currentHead.code === 0 ? currentHead.stdout.toString('utf8').trim() : ''

  if (head === headCommit) {
    return {
      status: 'current',
      commitsBehind: 0,
      shortSha,
      message: '此会话记录的代码状态与当前 HEAD 一致。',
      advisory: false,
    }
  }

  // ── 锚点是否是 HEAD 的祖先 ──
  const isAncestor = await git(
    repoPath,
    ['merge-base', '--is-ancestor', headCommit, 'HEAD'],
    { allowFailure: true, timeoutMs: ANCHOR_GIT_TIMEOUT_MS }
  )

  if (isAncestor.code === 0) {
    // 是祖先 → 落后 N 个提交
    const countResult = await git(repoPath, ['rev-list', '--count', `${headCommit}..HEAD`], {
      allowFailure: true,
      timeoutMs: ANCHOR_GIT_TIMEOUT_MS,
    })
    const behind =
      countResult.code === 0 ? Number(countResult.stdout.toString('utf8').trim()) : null
    const commitsBehind = Number.isSafeInteger(behind) && behind >= 0 ? behind : null
    return {
      status: 'behind',
      commitsBehind,
      shortSha,
      message:
        commitsBehind === null
          ? `此会话记录于提交 ${shortSha}，当前代码已向前推进。`
          : `此会话记录于 ${commitsBehind} 个提交之前（${shortSha}）。`,
      advisory: true,
    }
  }

  // ── 不是祖先：rebase / 强推 / 换分支 ──
  return {
    status: 'diverged',
    commitsBehind: null,
    shortSha,
    message: '锚点已不在当前分支历史中（可能做过 rebase 或强推）；代码可能已大幅变动，请核对。',
    advisory: true,
  }
}

/**
 * 把锚点归一化成可写进 manifest 的形状，并做安全校验。
 *
 * 远端内容一律视为不可信输入：这里对来自远端的锚点做严格校验，
 * 任何不合法的字段都被丢弃而不是原样透传（尤其 `headCommit` 会被拼进
 * git 命令参数，必须确保它只是一个 sha）。
 *
 * @param {unknown} anchor 来自 manifest（远端）或本机采集的锚点
 * @returns {{headCommit: string|null, branch: string|null, worktree: string|null,
 *            subPath: string|null, dirtyCount: number|null, capturedAt: number|null} | null}
 */
export function normalizeAnchor(anchor) {
  if (anchor === null || anchor === undefined || typeof anchor !== 'object') return null
  const source = /** @type {Record<string, unknown>} */ (anchor)

  const headCommit =
    typeof source.headCommit === 'string' && SHA_RE.test(source.headCommit)
      ? source.headCommit.toLowerCase()
      : null

  const stringOrNull = (value, maxLength = 512) =>
    typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null

  const dirtyCount =
    Number.isSafeInteger(source.dirtyCount) && source.dirtyCount >= 0
      ? source.dirtyCount
      : null
  const capturedAt =
    Number.isSafeInteger(source.capturedAt) && source.capturedAt > 0
      ? source.capturedAt
      : null

  // 全都不可用就返回 null，别留一个空壳让下游误以为有锚点
  if (headCommit === null && capturedAt === null) return null

  return {
    headCommit,
    branch: stringOrNull(source.branch, 255),
    worktree: stringOrNull(source.worktree),
    subPath: stringOrNull(source.subPath),
    dirtyCount,
    capturedAt,
  }
}

/**
 * 校验 repoPath 可用并采集锚点（供引擎在上行流程里直接调用）。
 *
 * @param {string} repoPath
 * @param {{runGit?: typeof runGit, subPath?: string}} [options]
 * @returns {Promise<object>}
 * @throws {SyncError} 路径为空
 */
export async function anchorForPush(repoPath, options = {}) {
  if (typeof repoPath !== 'string' || repoPath === '') {
    throw new SyncError(ERROR_CODES.NOT_CONFIGURED, '采集锚点需要仓库路径。', {
      hint: '请检查仓库绑定里的本地路径。',
    })
  }
  return captureAnchor(repoPath, options)
}

export default captureAnchor
