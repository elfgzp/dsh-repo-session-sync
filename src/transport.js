/**
 * 传输通道 —— 把会话字节流按 git 对象搬运。
 *
 * ## 通道选型（架构已定，这里只实现）
 *
 * 会话数据不走工作区、不走普通分支，而是写进仓库内的**独立 ref 命名空间**
 * `refs/dsh-sessions/v1`。全程使用 git plumbing（`hash-object` / `mktree` /
 * `commit-tree` / `update-ref` / `cat-file`），**永不 checkout、永不碰工作区、
 * 永不改 HEAD**。理由：
 *
 *   - 用户的代码分支历史保持干净，不会因为同步会话而产生噪音提交；
 *   - 不会因为 checkout 而覆盖用户未提交的工作区改动 —— 这是最危险的失败模式；
 *   - 全新 clone 默认不拉这个 ref，所以会话数据不会被误当成代码分发出去；
 *     需要时显式 fetch：`git fetch origin 'refs/dsh-sessions/v1:refs/dsh-sessions/v1'`
 *
 * ## 存储布局：内容寻址分块
 *
 * 整文件提交会让 `.git` 随每次同步线性膨胀（同量载荷 20 次提交 ≈ 10 倍体积）。
 * 所以把载荷切成块，每块存成一个 blob，块内容决定其名字（git object id 天然
 * 就是内容的 sha1），于是**未变的块不会重复存储**。
 *
 * 切块策略：**帧边界 + 内容定义切点**。
 *
 *   - 必须在 zstd 帧边界上切：帧内切开会产生无法独立解码的半个帧。
 *   - 切点由内容决定（对帧内容做滚动哈希，命中掩码即切），而不是「每 N 帧」
 *     固定窗口。固定窗口在 append-only 场景下其实也能复用（旧字节不变），
 *     所以它不是不能用；选内容定义的真正理由是**抗插入/重排** —— 当会话在
 *     中间被插入事件（格式迁移、历史修复）时，固定窗口的切点会整体错位，
 *     之后所有块都变新块；内容定义切点则只影响插入点附近。
 *
 *   ⚠️ 一个必须写清楚的事实：**跨机器去重不成立**。DSH 用 zstd 压缩落盘，
 *   同一批逻辑事件如果两端的 append 批次不同，压缩后的字节流完全不同
 *   （实测：100 事件逐帧压 6990 字节 vs 5 事件一帧压 1778 字节，字节流不等）。
 *   所以内容寻址真正省下的是「同一台机器对同一文件反复同步」的流量。
 *   跨机同步走的是「逻辑层校验 + 全量帧传输」，不指望块级去重。
 *
 * ## 安全边界
 *
 *   - **远端内容一律视为不可信输入**：pull 回来的块要经过帧结构校验、
 *     逐帧解码、seq 连续性校验，任何一步失败都拒绝，绝不直接落盘。
 *   - **所有 git 调用用 `execFile` 传参数数组**，不拼 shell 字符串：仓库路径
 *     与 ref 名都不会被 shell 解释，杜绝命令注入。
 *   - 仓库路径过 `paths.js` 的安全校验；ref 名是常量，不接受外部输入。
 *   - dry-run 路径**不写任何 git 对象、不更新任何 ref**。
 *
 * @module dsh-repo-session-sync/transport
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ERROR_CODES, SyncError } from './errors.js'
import { resolveInside } from './paths.js'
import { decodeLogBuffer, scanZstdFrames, ZSTD_MAGIC } from './session-store.js'


// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/**
 * 会话数据的 ref 命名空间。
 *
 * 用 `refs/` 下的自定义命名空间而不是分支，有两个硬理由：
 *   1. `git fetch` 的默认 refspec 不会带出自定义命名空间；
 *   2. 它不会出现在 `git branch` 列表里，用户不会误删。
 */
export const SESSIONS_REF = 'refs/dsh-sessions/v1'

/** 载荷清单在 tree 里的固定文件名。 */
const MANIFEST_NAME = 'manifest.json'

/** 存块的子目录名（一个真实的 git tree，不是文件名前缀）。 */
const CHUNKS_DIR = 'chunks'

/** 载荷格式版本，与 engine.js 的 `SessionPayload.version` 对齐。 */
const PAYLOAD_VERSION = 1

/**
 * 单条 git 命令的默认硬超时（毫秒）。
 *
 * 取值理由：`ls-remote` / 本地 plumbing 通常 < 1s，跨洋远端 fetch 可能几十秒。
 * 2 分钟足够覆盖慢网络下的大 fetch，又不至于让 UI 无限转圈。
 * 可以被 `runGit(..., { timeoutMs })` 覆盖（比如大仓库 pull 时放宽）。
 */
const DEFAULT_GIT_TIMEOUT_MS = 120_000

/**
 * 会话元数据提交使用的**独立机器人身份**。
 *
 * 为什么必须显式传，而不是依赖用户配置：
 *
 *   - CI runner、以及用户刚 clone 还没 `git config user.name` 的新机器上，
 *     根本没有任何身份配置。而「换机器继续会话」正是本插件的核心场景 ——
 *     让核心功能依赖用户先配好 git 身份是不合理的。
 *   - 很多人的全局配置里有 `user.useconfigonly=true`（本机实测就有），
 *     它会**禁用 git 的身份自动探测**，于是即使环境看似正常也会失败：
 *     `fatal: no email was given and auto-detection is disabled`。
 *   - 会话同步是插件的元数据写入，不该用、也不该污染用户自己的提交身份。
 *
 * 显式给全四个变量后，git 不再需要任何用户/系统配置，行为可预测。
 */
const SYNC_COMMIT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'dsh-session-sync',
  GIT_AUTHOR_EMAIL: 'dsh-session-sync@localhost',
  GIT_COMMITTER_NAME: 'dsh-session-sync',
  GIT_COMMITTER_EMAIL: 'dsh-session-sync@localhost',
})

/**
 * 分块参数默认值。
 *
 * 取值理由（这不是随便挑的魔数）：
 *
 *   - `minFrames = 4`：一个 zstd 帧通常含 1~7 个事件、几十到几百字节。少于 4 帧
 *     的块太小，git object 的固定开销（约 20 字节头 + tree entry）占比过高。
 *   - `maxFrames = 128`：上限防止「一直不命中掩码」导致块无限大。128 帧在实测
 *     样本里约 20~60KB，与 git 的 pack 效率比较匹配。
 *   - `maskBits = 6`（即 1/64 命中率）：期望块大小 ≈ 64 帧，落在 min/max 之间。
 *     调大 → 块更小、去重更细、object 数量更多；调小 → 反之。
 *   - `windowBytes = 64`：滚动哈希只看帧尾这么多字节。帧头是 zstd 帧头，
 *     对同一份内容重复度高，不适合作为切点信号；帧尾含有该批事件的最新内容，
 *     区分度更好。
 *
 * 这些值都可以通过 `createTransport({ chunking })` 覆盖。
 */
export const DEFAULT_CHUNKING = Object.freeze({
  minFrames: 4,
  maxFrames: 128,
  maskBits: 6,
  windowBytes: 64,
})

// ─────────────────────────────────────────────────────────────
// git 调用封装
// ─────────────────────────────────────────────────────────────

/**
 * 在指定仓库里跑一条 git 命令。
 *
 * ## 三个必须做对的地方（每一个都对应一个真实故障）
 *
 * **1. 参数数组，不拼字符串。**
 * 仓库路径、ref 名、文件名都不会经过 shell，因此不需要也不会做任何转义 ——
 * 没有转义就没有转义遗漏，也就不存在命令注入。
 *
 * **2. 必须支持 `input`，并且必须显式关闭 stdin。**
 * `execFile` **没有** `input` 选项（那是 `execFileSync` 的）。如果只把
 * `{ input }` 塞进 options 就当传进去了，`git hash-object -w --stdin` 这类
 * 命令会**永远等 stdin EOF，进程永不返回** —— 表现为 URL 转圈、UI 假死，
 * 比报错恶劣得多。实测：不写 stdin 时 8s 都不返回；写完 `end()` 后 13ms 完成。
 *
 * 同理，**没有 input 时也要 `end()`**：任何将来新增的 `--stdin` 类命令、
 * 或 credential helper 想读输入，都不会再静默挂住。
 *
 * **3. 超时兜底。**
 * 即使 stdin 与提示都关掉了，网络卡死（比如远端黑洞）仍可能让 git 长时间
 * 不动。所以给一个可配置的硬超时，超时就杀掉子进程并明确报错。
 *
 * @param {string} repoPath 仓库工作区路径
 * @param {string[]} args git 子命令与参数
 * @param {{input?: Buffer|string, maxBuffer?: number, env?: Record<string,string>, allowFailure?: boolean, timeoutMs?: number}} [options]
 * @returns {Promise<{stdout: Buffer, stderr: string, code: number}>}
 * @throws {SyncError} git 不可用、仓库无效、超时或命令失败（除非 allowFailure）
 */
export async function runGit(repoPath, args, options = {}) {
  const env = {
    ...process.env,
    // 关掉一切交互式提示：同步是在 UI 里触发的，不能卡在 tty 上等输入
    GIT_TERMINAL_PROMPT: '0',
    // 不继承用户的编辑器/locale 差异，输出可预测
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
    ...options.env,
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS

  const outcome = await new Promise((resolvePromise) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child
    let settled = false

    const finish = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }

    try {
      child = execFile(
        'git',
        args,
        {
          cwd: repoPath,
          env,
          maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
          // 二进制安全：stdout 收 Buffer，避免 UTF-8 往返破坏 zstd 字节
          encoding: 'buffer',
          windowsHide: true,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
        },
        (error, stdout, stderr) => {
          finish({
            error: error ?? null,
            stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
            stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? ''),
          })
        }
      )
    } catch (error) {
      finish({ error, stdout: Buffer.alloc(0), stderr: '' })
      return
    }

    if (!child.stdin) {
      finish({ error: null, stdout: Buffer.alloc(0), stderr: '' })
      return
    }

    // stdin 上的 EPIPE 是正常的：git 可能在我们写完之前就退出（比如提前报错）。
    // 交给 exit code 判断，不要让一个 'error' 事件变成未捕获异常。
    child.stdin.on('error', () => {})

    if (options.input !== undefined && options.input !== null) {
      child.stdin.end(
        Buffer.isBuffer(options.input) ? options.input : Buffer.from(String(options.input), 'utf8')
      )
    } else {
      // 没有输入也必须立刻关 —— 绝不给 git 留一个可以无限等待的 stdin。
      child.stdin.end()
    }
  })

  const { error, stdout, stderr } = outcome

  if (error === null) {
    return { stdout, stderr, code: 0 }
  }

  const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
  if (code === 'ENOENT') {
    throw new SyncError(ERROR_CODES.GIT_UNAVAILABLE, '找不到 git 命令。', {
      hint: '请先安装 git 并确保它在 PATH 中。',
    })
  }

  // 超时：execFile 会以 killed=true + signal 报告
  if (error?.killed === true || error?.signal === 'SIGKILL') {
    throw new SyncError(
      ERROR_CODES.REMOTE_UNREACHABLE,
      `git ${args[0]} 超过 ${timeoutMs}ms 未完成，已中止。`,
      {
        hint: '请检查网络与远端仓库是否可达；若仓库很大可稍后重试。',
        detail: { args, timeoutMs, stderr: stderr.slice(0, 2000) },
      }
    )
  }

  if (options.allowFailure) {
    return { stdout, stderr, code: typeof code === 'number' ? code : 1 }
  }
  // 身份相关的失败要给出**可操作**的提示，不要把用户支去查网络。
  if (/identity unknown|no email was given|auto-detection is disabled|请告诉我您是谁/i.test(stderr)) {
    throw new SyncError(
      ERROR_CODES.GIT_UNAVAILABLE,
      `git ${args[0]} 需要提交身份，但当前环境没有可用的身份配置。`,
      {
        hint:
          '插件写会话元数据时应使用内置身份；如果你看到这条，说明某个 git 调用没有传 SYNC_COMMIT_IDENTITY。' +
          '也可以在仓库里执行 git config user.name/user.email 临时绕过。',
        cause: error,
        detail: { args, stderr: stderr.slice(0, 2000) },
      }
    )
  }

  throw new SyncError(ERROR_CODES.INTERNAL, `git ${args[0]} 执行失败。`, {
    hint: '请检查仓库状态与远端连通性。',
    cause: error,
    detail: { args, stderr: stderr.slice(0, 2000) },
  })
}

/** 跑一条 git 命令并把 stdout 当 UTF-8 文本返回（已 trim）。 */
async function gitText(repoPath, args, options) {
  const { stdout } = await runGit(repoPath, args, options)
  return stdout.toString('utf8').trim()
}

/**
 * 判断路径是不是 git 工作区，并返回 git 目录。
 *
 * @param {string} repoPath
 * @returns {Promise<string>} git dir 绝对路径
 */
export async function resolveGitDir(repoPath) {
  const { code } = await runGit(repoPath, ['rev-parse', '--git-dir'], { allowFailure: true })
  if (code !== 0) {
    throw new SyncError(ERROR_CODES.NOT_A_GIT_REPO, `不是 git 仓库：${repoPath}`, {
      hint: '请确认该路径下已初始化 git，或检查绑定配置。',
    })
  }
  const out = await gitText(repoPath, ['rev-parse', '--absolute-git-dir'])
  return out
}

// ─────────────────────────────────────────────────────────────
// 分块
// ─────────────────────────────────────────────────────────────

/**
 * 对一段字节做滚动哈希，用于内容定义切点。
 *
 * 用 FNV-1a 的变体：实现简单、无依赖、分布够用。它不需要密码学强度 ——
 * 这里只用来决定切点位置，不用于完整性校验（完整性用 sha256）。
 *
 * @param {Uint8Array} bytes
 * @param {number} seed
 * @returns {number} 32 位无符号哈希
 */
function rollingHash(bytes, seed = 0x811c9dc5) {
  let h = seed >>> 0
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/**
 * 把一份会话日志切成内容寻址的块。
 *
 * 切点只会落在**完整 zstd 帧的边界**上，所以每个块都是若干完整帧，
 * 可以独立解码 —— 这是 pull 侧能逐块校验的前提。
 *
 * 算法：从上一个切点开始逐帧推进，累计滚动哈希；当已积累不少于
 * `minFrames` 帧且 `(hash & mask) === 0` 时切一刀；始终不超过 `maxFrames` 帧。
 * 尾部不足一块的也单独成块。
 *
 * @param {Buffer} bytes 会话日志的完整字节
 * @param {object} [chunking] 覆盖 {@link DEFAULT_CHUNKING} 的字段
 * @returns {{chunks: Array<{index: number, bytes: Buffer, frameCount: number, byteStart: number, byteEnd: number}>, frameCount: number}}
 * @throws {SyncError} 字节流不是合法帧序列
 */
export function chunkByFrames(bytes, chunking = {}) {
  const cfg = { ...DEFAULT_CHUNKING, ...chunking }

  let frames
  let tornStart
  try {
    const scanned = scanZstdFrames(bytes)
    frames = scanned.frames
    tornStart = scanned.tornStart
  } catch (cause) {
    throw new SyncError(ERROR_CODES.CORRUPT_SESSION, '会话日志不是合法的 zstd 帧序列。', {
      cause,
      hint: '本机会话文件可能已损坏，请先修复或重新生成会话。',
    })
  }

  // 有 torn tail 时只对完整帧切块：半帧不能独立解码，发出去也没用，
  // 而且会让接收侧把「读到一半」误判成损坏。
  const usable = frames
  if (usable.length === 0) {
    return { chunks: [], frameCount: 0, tornBytes: tornStart === undefined ? 0 : bytes.length - tornStart }
  }

  const mask = maskForBits(cfg.maskBits)
  /** @type {Array<{index:number, bytes:Buffer, frameCount:number, byteStart:number, byteEnd:number}>} */
  const chunks = []

  let startFrame = 0
  let hash = 0x811c9dc5

  for (let i = 0; i < usable.length; i++) {
    const frame = usable[i]
    // 只看帧尾 windowBytes 字节：帧头对同一份内容重复度高，区分度差
    const windowStart = Math.max(frame.start, frame.end - cfg.windowBytes)
    hash = rollingHash(usable.length > 0 ? bytes.subarray(windowStart, frame.end) : Buffer.alloc(0), hash)

    const framesSoFar = i - startFrame + 1
    const hitCut = framesSoFar >= cfg.minFrames && (hash & mask) === 0
    const hitMax = framesSoFar >= cfg.maxFrames
    const isLast = i === usable.length - 1

    if (hitCut || hitMax || isLast) {
      const byteStart = usable[startFrame].start
      const byteEnd = frame.end
      chunks.push({
        index: chunks.length,
        bytes: bytes.subarray(byteStart, byteEnd),
        frameCount: framesSoFar,
        byteStart,
        byteEnd,
      })
      startFrame = i + 1
      hash = 0x811c9dc5
    }
  }

  return {
    chunks,
    frameCount: usable.length,
    tornBytes: tornStart === undefined ? 0 : bytes.length - tornStart,
  }
}

/** 把掩码位数转成掩码值。`maskBits=6` → `0b111111`。 */
function maskForBits(maskBits) {
  const bits = Math.max(0, Math.min(30, Math.trunc(maskBits)))
  return bits === 0 ? 0 : (1 << bits) - 1
}

/**
 * 给一块内容算稳定 id。
 *
 * 用 sha256 而不是 git 的 sha1，因为这里要的不只是「git 认为相同」，
 * 还要在 manifest 里表达「我对这份内容的完整预期」。两者用途不同。
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
export function chunkDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// ─────────────────────────────────────────────────────────────
// 传输实现
// ─────────────────────────────────────────────────────────────

/**
 * 创建传输通道。
 *
 * @param {{ store?: object, paths?: object, log?: {info:Function, warn:Function, error:Function}, chunking?: object, gitRunner?: typeof runGit }} [context]
 * @returns {{push: Function, pull: Function, probe: Function, chunkByFrames: typeof chunkByFrames, chunkDigest: typeof chunkDigest, SESSIONS_REF: string}}
 */
export function createTransport(context = {}) {
  const log = context.log ?? { info() {}, warn() {}, error() {} }
  const chunking = { ...DEFAULT_CHUNKING, ...(context.chunking ?? {}) }
  const git = context.gitRunner ?? runGit

  return {
    /**
     * 探测远端可达性与当前 ref head，不传输任何载荷。
     *
     * 这是 dry-run 的安全入口：它只读不写，可以在用户点「同步」之前
     * 先回答「能不能连上」「远端有什么」。
     *
     * @param {object} binding 仓库绑定
     * @param {{signal?: AbortSignal, remote?: string}} [options]
     * @returns {Promise<{reachable: boolean, remote: string, head: string|null, hasBundle: boolean, error?: object}>}
     */
    async probe(binding, options = {}) {
      const repoPath = requireRepoPath(binding)
      const remote = options.remote ?? 'origin'

      log.info('transport.probe', { repoId: binding?.repoId, remote })

      // 1) 本地是不是 git 仓库
      const gitDirProbe = await git(repoPath, ['rev-parse', '--absolute-git-dir'], {
        allowFailure: true,
      })
      if (gitDirProbe.code !== 0) {
        return {
          reachable: false,
          remote,
          head: null,
          hasBundle: false,
          error: { code: ERROR_CODES.NOT_A_GIT_REPO, message: '本地路径不是 git 仓库。' },
        }
      }

      // 2) 远端是否可达（ls-remote 只握手不传数据）
      const ls = await git(repoPath, ['ls-remote', '--', remote, SESSIONS_REF], {
        allowFailure: true,
      })
      if (ls.code !== 0) {
        return {
          reachable: false,
          remote,
          head: null,
          hasBundle: false,
          error: {
            code: ERROR_CODES.REMOTE_UNREACHABLE,
            message: `无法访问远端 ${remote}：${ls.stderr.slice(0, 500)}`,
          },
        }
      }

      const line = ls.stdout.toString('utf8').trim()
      const head = line.length > 0 ? line.split(/\s+/)[0] : null

      return { reachable: true, remote, head, hasBundle: head !== null }
    },

    /**
     * 上行：把会话载荷写进远端仓库的会话 ref。
     *
     * 过程：切块 → 逐块 `hash-object -w` → `mktree` → `commit-tree` →
     * `update-ref`（带旧值 CAS，防止并发覆盖）。全程不碰工作区与 HEAD。
     *
     * dry-run 时只计算计划，不写任何对象、不动任何 ref。
     *
     * @param {object} binding 仓库绑定
     * @param {object} bundle 要上传的载荷集合
     * @param {{dryRun?: boolean, remote?: string, message?: string, signal?: AbortSignal}} [options]
     * @returns {Promise<{ok: boolean, dryRun: boolean, code?: string, transferred: number, skipped: number, bytes: number, head: string|null, previousHead: string|null, chunks: number, newChunks: number, sessions: object[]}>}
     */
    async push(binding, bundle, options = {}) {
      const repoPath = requireRepoPath(binding)
      const remote = options.remote ?? 'origin'
      const dryRun = options.dryRun === true

      const sessions = normalizeSessions(bundle)

      /** @type {Array<{sessionId: string, chunks: number, newChunks: number, bytes: number, manifestBytes: number, chunkRefs: Array<{digest: string, index: number, bytes: number, frameCount: number, data: Buffer}>}>} */
      const planned = []
      let totalBytes = 0

      for (const session of sessions) {
        const bytes = toBuffer(session.content)
        const { chunks, frameCount, tornBytes } = chunkByFrames(bytes, chunking)

        if (tornBytes > 0) {
          // 本机文件尾部有半帧：只发完整帧部分。这是安全的，因为
          // 接收方按 seq 校验，缺的事件下次同步会补上。
          log.warn('transport.push.torn-tail', {
            sessionId: session.sessionId,
            tornBytes,
            frameCount,
          })
        }

        const chunkRefs = chunks.map((chunk) => ({
          digest: chunkDigest(chunk.bytes),
          index: chunk.index,
          bytes: chunk.bytes.length,
          frameCount: chunk.frameCount,
          data: chunk.bytes,
        }))

        totalBytes += bytes.length
        planned.push({
          sessionId: session.sessionId,
          chunks: chunkRefs.length,
          newChunks: 0, // 下面在真正写入时才知道
          bytes: bytes.length,
          frameCount,
          chunkRefs,
          // manifest 里需要的元数据
          meta: {
            sessionId: session.sessionId,
            repoKey: session.repoKey ?? binding?.repoKey ?? null,
            eventCount: session.eventCount ?? null,
            watermark: session.watermark ?? null,
            contentHash: session.contentHash ?? chunkDigest(bytes),
            updatedAt: session.updatedAt ?? null,
            frameCount,
          },
        })
      }

      // ── 远端现状 ──
      const ls = await git(repoPath, ['ls-remote', '--', remote, SESSIONS_REF], { allowFailure: true })
      const previousHead =
        ls.code === 0 && ls.stdout.toString('utf8').trim() !== ''
          ? ls.stdout.toString('utf8').trim().split(/\s+/)[0]
          : null

      const manifest = {
        formatVersion: PAYLOAD_VERSION,
        refNamespace: SESSIONS_REF,
        generatedAt: Date.now(),
        chunking: { ...chunking },
        sessions: planned.map((p) => ({
          ...p.meta,
          chunks: p.chunkRefs.map((c) => ({
            digest: c.digest,
            index: c.index,
            bytes: c.bytes,
            frameCount: c.frameCount,
          })),
        })),
      }
      const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8')

      if (planned.length === 0) {
        return {
          ok: true,
          dryRun,
          code: ERROR_CODES.UP_TO_DATE,
          transferred: 0,
          skipped: sessions.length,
          bytes: 0,
          head: previousHead,
          previousHead,
          chunks: 0,
          newChunks: 0,
          sessions: [],
          message: '没有需要上行的会话。',
        }
      }

      // ── dry-run：到此为止，不写任何东西 ──
      if (dryRun) {
        log.info('transport.push.dry-run', { sessions: planned.length, bytes: totalBytes })
        return {
          ok: true,
          dryRun: true,
          transferred: 0,
          skipped: 0,
          bytes: totalBytes,
          head: previousHead,
          previousHead,
          chunks: planned.reduce((a, p) => a + p.chunkRefs.length, 0),
          newChunks: 0,
          sessions: planned.map((p) => ({
            sessionId: p.sessionId,
            chunks: p.chunks,
            bytes: p.bytes,
            frameCount: p.frameCount,
          })),
          message: `[dry-run] 将上行 ${planned.length} 个会话，共 ${totalBytes} 字节（未写入）。`,
        }
      }

      // ── 真正写入：先写所有 blob，再建 tree，再提交 ──
      let newChunks = 0
      /** @type {Map<string, string>} digest → git object id */
      const objectIds = new Map()

      for (const plan of planned) {
        for (const chunk of plan.chunkRefs) {
          if (objectIds.has(chunk.digest)) continue
          // --literally=false（默认）会校验对象格式；用 stdin 传二进制避免临时文件
          const oid = await hashObject(repoPath, chunk.data, git)
          objectIds.set(chunk.digest, oid)
          newChunks += 1
        }
        plan.newChunks = plan.chunkRefs.filter((c) => objectIds.has(c.digest)).length
      }

      const manifestOid = await hashObject(repoPath, manifestBytes, git)

      // 建 tree：顶层放 manifest.json；每个会话一个目录，里面按序号放块
      const entries = []
      entries.push({ mode: '100644', type: 'blob', oid: manifestOid, name: MANIFEST_NAME })

      for (const plan of planned) {
        // 会话目录名用安全的十六进制派生，不直接用 sessionId（避免任何路径语义）
        const dirName = safeSessionDirName(plan.sessionId)

        // git mktree 只接受**单段**文件名，不接受 `a/b` 这种带斜杠的路径。
        // 所以 `chunks/` 必须是一个真实的子 tree，而不是文件名前缀。
        const chunkEntries = plan.chunkRefs.map((chunk) => ({
          mode: '100644',
          type: 'blob',
          oid: objectIds.get(chunk.digest),
          name: chunkFileName(chunk.index),
        }))
        const chunksTree = await mktree(repoPath, chunkEntries, git)

        // 会话目录 = { chunks/ -> chunksTree }
        const sessionTree = await mktree(
          repoPath,
          [{ mode: '040000', type: 'tree', oid: chunksTree, name: CHUNKS_DIR }],
          git
        )
        entries.push({
          mode: '040000',
          type: 'tree',
          oid: sessionTree,
          name: dirName,
        })
      }

      const rootTree = await mktree(repoPath, entries, git)

      const message =
        options.message ??
        `dsh-session-sync: ${planned.length} session(s), ${planned.reduce((a, p) => a + p.chunkRefs.length, 0)} chunk(s)`

      const commitArgs = ['commit-tree', rootTree, '-m', message]
      if (previousHead !== null) commitArgs.push('-p', previousHead)
      const commitOid = await gitText(repoPath, commitArgs, { env: SYNC_COMMIT_IDENTITY })

      // CAS：期望旧值就是刚才读到的（可能为 null=不存在），被别人抢先就失败。
      // 注意 CAS 的对象是**本地** ref；远端的一致性由下面的 push 自己保证。
      await updateRefCas(repoPath, SESSIONS_REF, commitOid, previousHead, git)

      // 真正把会话 ref 送到远端。
      //
      // 这一步不能省：`update-ref` 只动了本地仓库，远端什么都没有，
      // 另一台机器 `pull()` 会看到「远端没有会话数据」并返回 null ——
      // 表现是「上行提示成功，但换台机器什么都没有」，属于静默失败。
      //
      // 用 `--force` 是安全的：ref 的推进已经由上面的 CAS 保证有序，
      // 这里只是把已确认的新 head 发出去。非 fast-forward 不会发生
      // （每次提交都以 previousHead 为父）。
      const pushResult = await git(
        repoPath,
        ['push', '--quiet', '--no-verify', remote, `${SESSIONS_REF}:${SESSIONS_REF}`],
        { allowFailure: true, timeoutMs: 300_000 }
      )
      if (pushResult.code !== 0) {
        // 本地 ref 已经推进了但远端没收到：这不破坏数据（下次会重试），
        // 但必须让调用方知道「远端并未更新」，不能报成功。
        throw new SyncError(
          ERROR_CODES.REMOTE_UNREACHABLE,
          `会话数据已写入本地仓库，但推送到远端 ${remote} 失败。`,
          {
            hint: '请检查网络与远端写权限；数据没有丢失，重新上行即可。',
            detail: {
              ref: SESSIONS_REF,
              commit: commitOid,
              stderr: pushResult.stderr.slice(0, 1000),
            },
          }
        )
      }

      log.info('transport.push.committed', {
        commit: commitOid,
        sessions: planned.length,
        chunks: planned.reduce((a, p) => a + p.chunkRefs.length, 0),
      })

      return {
        ok: true,
        dryRun: false,
        transferred: planned.length,
        skipped: 0,
        bytes: totalBytes,
        head: commitOid,
        previousHead,
        chunks: planned.reduce((a, p) => a + p.chunkRefs.length, 0),
        newChunks,
        sessions: planned.map((p) => ({
          sessionId: p.sessionId,
          chunks: p.chunks,
          bytes: p.bytes,
          frameCount: p.frameCount,
        })),
        message: `已上行 ${planned.length} 个会话到 ${SESSIONS_REF}。`,
      }
    },

    /**
     * 下行：从远端 ref 读回会话载荷并**严格校验**。
     *
     * 这里把远端内容完全当作不可信输入：
     *   1. manifest 必须是合法 JSON 且版本受支持
     *   2. 每个块的字节必须能被 zstd 帧扫描器识别为完整帧序列
     *   3. 块按 manifest 的 digest 校验 sha256（防止内容与声明不符）
     *   4. 重组后逐帧解压，校验 seq 从 0 连续无缺口
     *   5. 事件数必须与 manifest 声明的一致
     *
     * 任何一步失败都抛错并**不返回载荷**，调用方拿不到东西就不会落盘。
     *
     * @param {object} binding 仓库绑定
     * @param {{dryRun?: boolean, remote?: string, expectedSessionIds?: string[], signal?: AbortSignal, maxBytes?: number}} [options]
     * @returns {Promise<object|null>} 校验通过的载荷集合，或 null（远端没有会话数据）
     */
    async pull(binding, options = {}) {
      const repoPath = requireRepoPath(binding)
      const remote = options.remote ?? 'origin'
      const maxBytes = options.maxBytes ?? 512 * 1024 * 1024

      // ── 1) 取远端 ref 并抓到本地 ref（不 checkout）──
      const ls = await git(repoPath, ['ls-remote', '--', remote, SESSIONS_REF], { allowFailure: true })
      if (ls.code !== 0) {
        throw new SyncError(ERROR_CODES.REMOTE_UNREACHABLE, `无法访问远端 ${remote}。`, {
          hint: '请检查网络与仓库远端配置。',
          detail: { stderr: ls.stderr.slice(0, 500) },
        })
      }
      const remoteHead = ls.stdout.toString('utf8').trim().split(/\s+/)[0]
      if (!remoteHead) {
        log.info('transport.pull.empty', { repoId: binding?.repoId })
        return null
      }

      const fetch = await git(
        repoPath,
        ['fetch', '--no-tags', '--quiet', remote, `${SESSIONS_REF}:${SESSIONS_REF}`],
        // 大仓库首次 fetch 可能较慢，给更宽的预算
        { allowFailure: true, timeoutMs: 300_000 }
      )
      if (fetch.code !== 0) {
        throw new SyncError(ERROR_CODES.REMOTE_UNREACHABLE, '抓取会话 ref 失败。', {
          hint: '请检查远端是否允许该 ref 的读写。',
          detail: { stderr: fetch.stderr.slice(0, 500) },
        })
      }

      // ── 2) 读 manifest ──
      const manifestRaw = await git(repoPath, ['cat-file', '-p', `${SESSIONS_REF}:${MANIFEST_NAME}`], {
        allowFailure: true,
      })
      if (manifestRaw.code !== 0) {
        throw new SyncError(ERROR_CODES.INVALID_BUNDLE, `远端 ${SESSIONS_REF} 缺少 ${MANIFEST_NAME}。`, {
          hint: '远端会话数据可能不完整，请先在另一端重新上行。',
        })
      }

      let manifest
      try {
        manifest = JSON.parse(manifestRaw.stdout.toString('utf8'))
      } catch (cause) {
        throw new SyncError(ERROR_CODES.INVALID_BUNDLE, `远端 ${MANIFEST_NAME} 不是合法 JSON。`, {
          cause,
        })
      }

      validateManifest(manifest)

      // ── 3) 逐会话读块、校验、重组 ──
      let grandTotal = 0
      const sessions = []

      for (const entry of manifest.sessions) {
        if (
          Array.isArray(options.expectedSessionIds) &&
          options.expectedSessionIds.length > 0 &&
          !options.expectedSessionIds.includes(entry.sessionId)
        ) {
          continue
        }

        const dirName = safeSessionDirName(entry.sessionId)
        const parts = []

        for (const chunkMeta of entry.chunks) {
          const path = `${SESSIONS_REF}:${dirName}/${CHUNKS_DIR}/${chunkFileName(chunkMeta.index)}`
          const blob = await git(repoPath, ['cat-file', '-p', path], { allowFailure: true })
          if (blob.code !== 0) {
            throw new SyncError(
              ERROR_CODES.INVALID_BUNDLE,
              `远端缺少会话 ${entry.sessionId} 的块 ${chunkMeta.index}。`,
              { hint: '远端数据不完整，请在该机器上重新上行。' }
            )
          }
          const bytes = blob.stdout
          grandTotal += bytes.length
          if (grandTotal > maxBytes) {
            throw new SyncError(ERROR_CODES.LIMIT_EXCEEDED, '远端会话载荷超过允许的大小上限。', {
              hint: '请检查远端仓库是否被放入异常内容。',
            })
          }

          // 3a) 内容与声明必须一致
          const actual = chunkDigest(bytes)
          if (actual !== chunkMeta.digest) {
            throw new SyncError(
              ERROR_CODES.CORRUPT_SESSION,
              `会话 ${entry.sessionId} 的块 ${chunkMeta.index} 内容校验失败。`,
              { hint: '远端数据可能损坏，请重新上行。', detail: { expected: chunkMeta.digest, actual } }
            )
          }

          // 3b) 该块必须自成一个完整帧序列
          try {
            const scanned = scanZstdFrames(bytes)
            if (scanned.tornStart !== undefined) {
              throw new Error('块内含未写完的帧')
            }
            if (scanned.frames.length !== chunkMeta.frameCount) {
              throw new Error(`帧数不符：声明 ${chunkMeta.frameCount}，实际 ${scanned.frames.length}`)
            }
          } catch (cause) {
            throw new SyncError(
              ERROR_CODES.CORRUPT_SESSION,
              `会话 ${entry.sessionId} 的块 ${chunkMeta.index} 不是合法帧序列。`,
              { cause, hint: '远端数据可能损坏，请重新上行。' }
            )
          }

          parts.push(bytes)
        }

        if (entry.chunks.length === 0) {
          throw new SyncError(ERROR_CODES.INVALID_BUNDLE, `远端会话 ${entry.sessionId} 没有内容。`)
        }

        const content = Buffer.concat(parts)

        // 3c) 整体内容指纹
        const actualHash = chunkDigest(content)
        if (entry.contentHash && actualHash !== entry.contentHash) {
          throw new SyncError(
            ERROR_CODES.CORRUPT_SESSION,
            `会话 ${entry.sessionId} 重组后内容与声明不符。`,
            { hint: '远端数据可能损坏。', detail: { expected: entry.contentHash, actual: actualHash } }
          )
        }

        // 3d) 逻辑层校验：能解码、seq 从 0 连续、事件数与声明一致
        const verified = verifySessionContent(content, entry)

        sessions.push({
          version: PAYLOAD_VERSION,
          sessionId: entry.sessionId,
          repoKey: entry.repoKey ?? null,
          eventCount: verified.nextSeq,
          watermark: entry.watermark ?? null,
          contentHash: actualHash,
          content,
          updatedAt: entry.updatedAt ?? null,
          frameCount: verified.frameCount,
        })
      }

      log.info('transport.pull.validated', {
        sessions: sessions.length,
        bytes: grandTotal,
        head: remoteHead,
      })

      return {
        ok: true,
        head: remoteHead,
        formatVersion: PAYLOAD_VERSION,
        sessions,
        bytes: grandTotal,
        dryRun: options.dryRun === true,
      }
    },

    chunkByFrames,
    chunkDigest,
    SESSIONS_REF,
  }
}

// ─────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────

/** 从 binding 里取仓库路径，缺失就报配置错误。 */
function requireRepoPath(binding) {
  const repoPath = binding?.repoPath
  if (typeof repoPath !== 'string' || repoPath === '') {
    throw new SyncError(ERROR_CODES.NOT_CONFIGURED, '仓库绑定缺少本地路径。', {
      hint: '请在设置页把仓库绑定补上本地路径。',
    })
  }
  return repoPath
}

/**
 * 把 payload 的 content 字段统一成 Buffer。
 *
 * 接受 string / Uint8Array / Buffer，其余类型明确拒绝 —— 不猜。
 */
function toBuffer(content) {
  if (Buffer.isBuffer(content)) return content
  if (typeof content === 'string') return Buffer.from(content, 'utf8')
  if (content instanceof Uint8Array) return Buffer.from(content)
  throw new SyncError(ERROR_CODES.BAD_REQUEST, `会话 content 类型不受支持：${typeof content}`, {
    hint: '这通常是内部错误。',
  })
}

/** 把 bundle 归一化成会话数组。 */
function normalizeSessions(bundle) {
  if (bundle === null || typeof bundle !== 'object') {
    throw new SyncError(ERROR_CODES.BAD_REQUEST, '上行载荷必须是对象。')
  }
  const sessions = Array.isArray(bundle.sessions)
    ? bundle.sessions
    : Array.isArray(bundle)
      ? bundle
      : [bundle]

  return sessions.map((session, i) => {
    if (session === null || typeof session !== 'object') {
      throw new SyncError(ERROR_CODES.BAD_REQUEST, `第 ${i} 个会话载荷不是对象。`)
    }
    if (typeof session.sessionId !== 'string' || session.sessionId === '') {
      throw new SyncError(ERROR_CODES.BAD_REQUEST, `第 ${i} 个会话缺少 sessionId。`)
    }
    if (session.content === undefined) {
      throw new SyncError(ERROR_CODES.BAD_REQUEST, `会话 ${session.sessionId} 缺少 content。`)
    }
    return session
  })
}

/**
 * 把 session id 映射成 tree 里的目录名。
 *
 * **不直接用 sessionId 当目录名**：虽然它多半是安全的，但远端载荷里的
 * sessionId 是不可信输入，直接当路径用就给了对方构造路径语义的机会。
 * 这里用 sha256 的前 16 字节做名字，既稳定又不含任何路径语义。
 */
function safeSessionDirName(sessionId) {
  return 's-' + createHash('sha256').update(`session:${sessionId}`).digest('hex').slice(0, 32)
}

/** 块文件的单段文件名（定宽序号，tree 里天然按序）。 */
function chunkFileName(index) {
  return `${String(index).padStart(5, '0')}.bin`
}

/** 写一个 blob，返回其 object id。二进制安全。 */
async function hashObject(repoPath, bytes, git) {
  const { stdout } = await git(repoPath, ['hash-object', '-w', '--stdin'], { input: bytes })
  return stdout.toString('utf8').trim()
}

/**
 * 用 `git mktree` 建一个 tree。
 *
 * 输入格式（每行）：`<mode> <type> <oid>\t<name>`
 * 文件名里不允许出现 tab/换行，这里的所有 name 都是我们自己生成的，
 * 但仍然过滤一遍，避免将来有人传入外部名字。
 */
async function mktree(repoPath, entries, git) {
  const lines = entries.map((entry) => {
    const name = String(entry.name)
    if (/[\t\n\r\0]/.test(name)) {
      throw new SyncError(ERROR_CODES.BAD_REQUEST, `非法的 tree 条目名：${JSON.stringify(name)}`)
    }
    return `${entry.mode} ${entry.type} ${entry.oid}\t${name}`
  })
  const input = Buffer.from(lines.join('\n') + '\n', 'utf8')
  const { stdout } = await git(repoPath, ['mktree'], { input })
  return stdout.toString('utf8').trim()
}

/**
 * 带 CAS 的 ref 更新。
 *
 * `git update-ref <ref> <new> <old>` 的 `<old>` 传空串表示「该 ref 必须不存在」，
 * 传具体 oid 表示「必须还是这个值」。这样两个人同时上行时，后到的会失败
 * 而不是静默覆盖 —— 这正是「绝不静默覆盖」在传输层的落点。
 */
async function updateRefCas(repoPath, ref, newOid, expectedOld, git) {
  const args = ['update-ref', ref, newOid]
  // 空字符串作为 old 值：要求 ref 当前不存在
  args.push(expectedOld ?? '')

  const result = await git(repoPath, args, { allowFailure: true })
  if (result.code !== 0) {
    throw new SyncError(
      ERROR_CODES.CONFLICT_BINDING,
      '远端会话 ref 已被其他操作更新，本次未覆盖。',
      {
        hint: '可能另一台机器刚刚同步过，请先下行再重试上行。',
        detail: { ref, expected: expectedOld, stderr: result.stderr.slice(0, 500) },
      }
    )
  }
}

/**
 * 校验 manifest 的结构。
 *
 * 远端内容不可信，所以这里的每一项都要检查类型，不能直接 `manifest.sessions.map`。
 */
function validateManifest(manifest) {
  const fail = (why) => {
    throw new SyncError(ERROR_CODES.INVALID_BUNDLE, `远端清单非法：${why}`, {
      hint: '远端会话数据可能来自不兼容的版本，请升级插件或在另一端重新上行。',
    })
  }
  if (manifest === null || typeof manifest !== 'object') fail('不是对象')
  if (manifest.formatVersion !== PAYLOAD_VERSION) {
    throw new SyncError(
      ERROR_CODES.UNSUPPORTED_VERSION,
      `远端载荷版本 ${manifest.formatVersion} 不受支持（本机支持 ${PAYLOAD_VERSION}）。`,
      { hint: '请把两端插件升级到同一版本。' }
    )
  }
  if (!Array.isArray(manifest.sessions)) fail('sessions 不是数组')

  for (const [i, entry] of manifest.sessions.entries()) {
    if (entry === null || typeof entry !== 'object') fail(`sessions[${i}] 不是对象`)
    if (typeof entry.sessionId !== 'string' || entry.sessionId === '') {
      fail(`sessions[${i}].sessionId 非法`)
    }
    if (!Array.isArray(entry.chunks) || entry.chunks.length === 0) {
      fail(`sessions[${i}].chunks 必须是非空数组`)
    }
    for (const [j, chunk] of entry.chunks.entries()) {
      if (chunk === null || typeof chunk !== 'object') fail(`sessions[${i}].chunks[${j}] 不是对象`)
      if (typeof chunk.digest !== 'string' || !/^[0-9a-f]{64}$/.test(chunk.digest)) {
        fail(`sessions[${i}].chunks[${j}].digest 不是 sha256 十六进制`)
      }
      if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) {
        fail(`sessions[${i}].chunks[${j}].index 非法`)
      }
      if (!Number.isSafeInteger(chunk.frameCount) || chunk.frameCount < 1) {
        fail(`sessions[${i}].chunks[${j}].frameCount 非法`)
      }
    }
    // 块的 index 必须连续、从 0 开始，避免漏块或重复
    const indices = entry.chunks.map((c) => c.index).sort((a, b) => a - b)
    for (let k = 0; k < indices.length; k++) {
      if (indices[k] !== k) fail(`sessions[${i}] 的块序号不连续（缺少 ${k}）`)
    }
  }
}

/**
 * 逻辑层校验：把重组后的字节解成事件流，确认 seq 连续、事件数与声明一致。
 *
 * 这是 pull 侧的最后一道闸门。字节层的 digest 只能证明「内容没被改」，
 * 不能证明「内容本身是有效的会话」—— 一个恶意构造的载荷可以把任意字节
 * 算出一个自洽的 digest 再声明出来。所以必须真的解一遍事件流。
 *
 * @param {Buffer} content 重组后的日志字节
 * @param {object} entry manifest 里对应的条目
 * @returns {{nextSeq: number, frameCount: number}}
 */
function verifySessionContent(content, entry) {
  let decoded
  try {
    decoded = decodeLogBuffer(content)
  } catch (cause) {
    throw new SyncError(
      ERROR_CODES.CORRUPT_SESSION,
      `会话 ${entry.sessionId} 无法解码：${cause?.message ?? cause}`,
      { cause, hint: '远端数据可能损坏或不是本插件产生的。' }
    )
  }

  const lines = decoded.plaintext.split('\n').filter((line) => line.length > 0)
  if (lines.length === 0) {
    throw new SyncError(ERROR_CODES.CORRUPT_SESSION, `会话 ${entry.sessionId} 解出的内容为空。`)
  }

  let header
  try {
    header = JSON.parse(lines[0])
  } catch (cause) {
    throw new SyncError(ERROR_CODES.CORRUPT_SESSION, `会话 ${entry.sessionId} 的首行不是合法 JSON。`, {
      cause,
    })
  }
  if (header?.type !== 'session' || typeof header?.id !== 'string') {
    throw new SyncError(ERROR_CODES.CORRUPT_SESSION, `会话 ${entry.sessionId} 的 header 非法。`, {
      detail: { type: header?.type },
    })
  }
  // header 里的 id 必须与 manifest 声明的一致 —— 否则就是张冠李戴
  if (header.id !== entry.sessionId) {
    throw new SyncError(
      ERROR_CODES.CORRUPT_SESSION,
      `会话声明 id 为 ${entry.sessionId}，但内容里是 ${header.id}。`,
      { hint: '远端数据可能被篡改或损坏。' }
    )
  }

  let expected = 0
  for (let i = 1; i < lines.length; i++) {
    let event
    try {
      event = JSON.parse(lines[i])
    } catch (cause) {
      throw new SyncError(
        ERROR_CODES.CORRUPT_SESSION,
        `会话 ${entry.sessionId} 第 ${i + 1} 行不是合法 JSON。`,
        { cause }
      )
    }
    if (event?.seq !== expected) {
      throw new SyncError(
        ERROR_CODES.CORRUPT_SESSION,
        `会话 ${entry.sessionId} 的 seq 不连续：第 ${i + 1} 行期望 ${expected}，实际 ${event?.seq}。`,
        { hint: '远端数据缺少中间事件，请重新上行。' }
      )
    }
    expected += 1
  }

  if (Number.isSafeInteger(entry.eventCount) && entry.eventCount !== expected) {
    throw new SyncError(
      ERROR_CODES.CORRUPT_SESSION,
      `会话 ${entry.sessionId} 事件数与声明不符：声明 ${entry.eventCount}，实际 ${expected}。`
    )
  }

  return { nextSeq: expected, frameCount: decoded.frames }
}

export default createTransport
export { MANIFEST_NAME, CHUNKS_DIR, PAYLOAD_VERSION, ZSTD_MAGIC }
