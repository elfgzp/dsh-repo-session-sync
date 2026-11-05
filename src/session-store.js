/**
 * 会话读取层 —— 直接对接 DSH 的磁盘存储格式。
 *
 * 本模块只负责「把磁盘上的东西读成结构化数据」和「算出还剩多少没同步」。
 * 不做任何网络、不做任何写入（写入在 transport/downlink 里，且必须备份）。
 *
 * 格式事实（均在真实样本上实测 + 与 DSH 官方 persistence 包源码交叉验证）：
 *
 *   <DSH_HOME>/sessions/
 *     --<projectKey>--/                可读的 cwd 编码目录；无 cwd 时为 _no-cwd
 *       <encodedSessionId>/
 *         session.v4.jsonl.zstd        当前代的逻辑日志
 *         session.lock                 flock(2) 锁文件（0 字节）
 *
 * 物理编码 = 一帧 header 行 + N 个独立 zstd 帧（每次 durable append 写 1 帧）。
 * 每帧带 XXH64 校验，帧间无分隔。
 *
 * 逻辑记录 = JSONL。首行是 header（无 seq），其余每行
 *   { type, seq, time, data, surfaceOp?, sourceEventSeqs? }
 * 且 seq 从 0 起严格 +1 无缺口 —— 这就是天然的增量水位线。
 *
 * 安全边界：
 *   - 本模块永不写入，只 readFile / readdir / stat
 *   - 远端数据不经过本模块；本模块只处理本机可信路径
 *   - 所有路径拼接前都经过 assertInside()，防穿越
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import zlib from 'node:zlib'

import { ERROR_CODES, SyncError } from './errors.js'
import {
  assertSafeSegment,
  isInside,
  resolveDshHome,
  sessionsRoot as resolveSessionsRoot,
} from './paths.js'

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** Zstandard 帧魔数（小端读出）。 */
export const ZSTD_MAGIC = 0xfd2fb528

/** 当前支持的物理代。磁盘上可能出现 session.jsonl / session.v1.jsonl 等旧代。 */
export const CURRENT_GENERATION = 4

/** 日志文件名正则：捕获物理代版本号。 */
const LOG_FILENAME_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

/** 无 cwd 会话落在该目录。 */
const NO_CWD_DIR = '_no-cwd'

/** DSH 的会话写锁文件名（0 字节的 flock 目标）。 */
const LOCK_FILENAME = 'session.lock'

/**
 * 单个会话日志的大小上限。超过就拒绝读取，避免恶意/损坏文件把内存打爆。
 * 真实最大样本约 1MB 压缩 / 3MB 明文，256MB 是很宽松的上限。
 */
const MAX_LOG_BYTES = 256 * 1024 * 1024

/** 单帧解压后的明文上限。高于此值视为异常帧。 */
const MAX_FRAME_PLAINTEXT_BYTES = 64 * 1024 * 1024

// ─────────────────────────────────────────────────────────────
// 错误类型
// ─────────────────────────────────────────────────────────────

/** 会话日志结构性损坏（不是 torn tail，是真的坏了）。 */
export class SessionCorruptError extends SyncError {
  constructor(message, options = {}) {
    super(ERROR_CODES.CORRUPT_SESSION, message, options)
    this.name = 'SessionCorruptError'
  }
}

/** 路径越界或含不安全片段 —— 拒绝了不安全的路径。 */
export class PathEscapeError extends SyncError {
  constructor(message, options = {}) {
    super(ERROR_CODES.PATH_UNSAFE, message, options)
    this.name = 'PathEscapeError'
  }
}

/** 不支持的格式代。 */
export class UnsupportedGenerationError extends SyncError {
  constructor(message, options = {}) {
    super(ERROR_CODES.UNSUPPORTED_VERSION, message, options)
    this.name = 'UnsupportedGenerationError'
  }
}

// ─────────────────────────────────────────────────────────────
// zstd 能力探测与解码
// ─────────────────────────────────────────────────────────────

/**
 * 探测当前 Node 运行时的原生 zstd 解压能力。
 *
 * Node 20 及更早没有这个 API，用户可能用不同 runtime 跑。所以我们
 * 永远探测、永远不假设。探测结果缓存，避免每次调用都做类型判断。
 *
 * @returns {{available: boolean, decompress: ((buf: Buffer) => Buffer) | null}}
 */
export function probeZstd() {
  const fn =
    typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null
  return { available: fn !== null, decompress: fn }
}

/**
 * 扫出 buffer 里所有完整 zstd 帧的字节范围，不实际解压。
 *
 * 算法对齐 DSH 官方 `scanZstdFrames`：只按 frame header + block header
 * 的长度信息跳过 payload，因此极快（实测 630 帧 / 1MB 约 1ms），
 * 且能在不信任内容的前提下安全地定位边界。
 *
 * @param {Buffer} buffer 当前已有的全部字节
 * @returns {{frames: Array<{start: number, end: number}>, tornStart?: number}}
 *   `tornStart` 存在表示末尾有一帧没写完（崩溃中间态，应丢弃而非报错）。
 * @throws {SessionCorruptError} 完整帧结构非法
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset

    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new SessionCorruptError(`Zstandard 帧魔数非法（字节 ${offset}）`)
    }
    offset += 4

    if (offset === buffer.length) return { frames, tornStart: start }

    const descriptor = buffer.readUInt8(offset)
    offset += 1
    // bit3/bit4 是 reserved，必须为 0
    if ((descriptor & 0b0001_1000) !== 0) {
      throw new SessionCorruptError(`Zstandard 帧头保留位非法（字节 ${offset - 1}）`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0b0010_0000) !== 0
    const checksum = (descriptor & 0b0000_0100) !== 0
    const dictionaryFlag = descriptor & 0b0000_0011
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes =
      (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes

    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0b11
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new SessionCorruptError(`Zstandard 块类型保留值非法（字节 ${offset - 3}）`)
      }
      // RLE 块 payload 恒为 1 字节，不是 blockSize
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }

    frames.push({ start, end: offset })
  }

  return { frames }
}

/**
 * 把整个日志 buffer 解成明文。
 *
 * ⚠️ 关键实现要点（踩过的坑）：
 * 不能对整体做 one-shot 解压 —— `zstdDecompressSync(整个文件)` 只会解出
 * 第一帧就静默返回，实测 1MB 样本只得到 210 字节而不是 3,271,781 字节，
 * **且不报错**。必须扫帧后逐帧解压再拼接。
 *
 * 为此本函数准备了两条路径，两者必须产出一致结果（有测试对比）：
 *   1. 原生路径：逐帧调用 `zlib.zstdDecompressSync`（快，需 Node ≥ 22.15）
 *   2. 纯 JS 路径：不依赖 zstd 时，交给调用方注入的 frameDecoder
 *      （见 decodeSessionLog 的 `frameDecoder` 选项；插件侧可注入
 *       zstd CLI 或 WASM 实现，本模块不绑定具体方案）
 *
 * @param {Buffer} buffer 日志文件的全部字节
 * @param {{frameDecoder?: (frame: Buffer) => Buffer}} [options]
 * @returns {{plaintext: string, frames: number, tornBytes: number}}
 */
export function decodeLogBuffer(buffer, options = {}) {
  if (buffer.length > MAX_LOG_BYTES) {
    throw new SessionCorruptError(
      `会话日志过大（${buffer.length} 字节，上限 ${MAX_LOG_BYTES}）`
    )
  }

  const { frames, tornStart } = scanZstdFrames(buffer)

  if (frames.length === 0) {
    // 全是 torn 数据或空文件
    return { plaintext: '', frames: 0, tornBytes: buffer.length }
  }

  const decoder = options.frameDecoder ?? defaultFrameDecoder
  const chunks = []

  for (const frame of frames) {
    const encoded = buffer.subarray(frame.start, frame.end)
    let decoded
    try {
      decoded = decoder(encoded)
    } catch (cause) {
      throw new SessionCorruptError(
        `Zstandard 帧解压失败（字节 ${frame.start}..${frame.end}）`,
        { cause }
      )
    }
    if (decoded.length > MAX_FRAME_PLAINTEXT_BYTES) {
      throw new SessionCorruptError(
        `Zstandard 帧解压后过大（${decoded.length} 字节，字节 ${frame.start}..${frame.end}）`
      )
    }
    chunks.push(decoded)
  }

  const plaintext = Buffer.concat(chunks).toString('utf8')
  const tornBytes = tornStart === undefined ? 0 : buffer.length - tornStart
  return { plaintext, frames: frames.length, tornBytes }
}

/** 默认帧解码器：原生 zstd 优先；不可用时退到纯 JS（只支持未压缩块）。 */
function defaultFrameDecoder(frame) {
  const probe = probeZstd()
  if (probe.available) return probe.decompress(frame)
  return decodeFramePureJs(frame)
}

/**
 * 纯 JS 帧解码器 —— 不依赖任何原生 zstd。
 *
 * 只支持 `Raw_Block`(0) 与 `RLE_Block`(1) 两种块类型：这两种块的内容本来就
 * 是明文/RLE 展开，不需要熵解码器。遇到 `Compressed_Block`(2) 就明确抛错，
 * 由调用方升级 Node 或注入 frameDecoder，**绝不静默返回半截数据**。
 *
 * 它存在的意义有两条：
 *   1. CI / 低版本 Node 上没有原生 zstd 时，仍能跑通用未压缩块构造的测试夹具
 *   2. 作为原生 zstd 的**交叉校验**实现：同一帧两条路径必须产出完全一致的
 *      结果，这条断言能抓住「解码方式选错」这类静默 bug
 *
 * @param {Buffer} frame 单个完整帧
 * @returns {Buffer} 明文
 * @throws {SessionCorruptError}
 */
export function decodeFramePureJs(frame) {
  if (frame.length < 5) throw new SessionCorruptError('Zstandard 帧过短')
  if (frame.readUInt32LE(0) !== ZSTD_MAGIC) {
    throw new SessionCorruptError('Zstandard 帧魔数非法')
  }

  let offset = 4
  const descriptor = frame.readUInt8(offset)
  offset += 1
  if ((descriptor & 0b0001_1000) !== 0) {
    throw new SessionCorruptError('Zstandard 帧头保留位非法')
  }

  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0b0010_0000) !== 0
  const checksum = (descriptor & 0b0000_0100) !== 0
  const dictionaryFlag = descriptor & 0b0000_0011
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes =
    contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag

  if (frame.length - offset < (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes) {
    throw new SessionCorruptError('Zstandard 帧头被截断')
  }
  offset += (singleSegment ? 0 : 1) + dictionaryBytes

  let contentSize = null
  if (contentSizeBytes > 0) {
    let size = 0n
    for (let i = 0; i < contentSizeBytes; i++) {
      size |= BigInt(frame.readUInt8(offset + i)) << BigInt(8 * i)
    }
    // 规范：FCS 编码为 1 字节时直接取值；2 字节时要 +256；4/8 字节直接取值
    contentSize = contentSizeFlag === 1 ? Number(size) + 256 : Number(size)
    offset += contentSizeBytes
  }

  const chunks = []
  let total = 0
  for (;;) {
    if (frame.length - offset < 3) throw new SessionCorruptError('Zstandard 块头被截断')
    const blockHeader = frame.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 0b11
    const blockSize = blockHeader >>> 3

    if (blockType === 3) throw new SessionCorruptError('Zstandard 块类型保留值非法')

    if (blockType === 0) {
      // Raw_Block：payload 即明文
      if (frame.length - offset < blockSize) {
        throw new SessionCorruptError('Zstandard Raw_Block 被截断')
      }
      chunks.push(frame.subarray(offset, offset + blockSize))
      total += blockSize
      offset += blockSize
    } else if (blockType === 1) {
      // RLE_Block：payload 1 字节，重复 blockSize 次
      if (frame.length - offset < 1) {
        throw new SessionCorruptError('Zstandard RLE_Block 被截断')
      }
      chunks.push(Buffer.alloc(blockSize, frame.readUInt8(offset)))
      total += blockSize
      offset += 1
    } else {
      throw new SessionCorruptError(
        '该帧含压缩块（Compressed_Block），纯 JS 解码器无法处理：' +
          `当前 Node ${process.version} 没有原生 zstd，请升级到 Node ≥ 22.15 或注入 frameDecoder`
      )
    }

    if (lastBlock) break
  }

  if (checksum) {
    // 校验和存在时明文之后有 4 字节；纯 JS 路径不校验它（原生路径会校验）
    if (frame.length - offset < 4) throw new SessionCorruptError('Zstandard 校验和被截断')
    offset += 4
  }

  const result = Buffer.concat(chunks, total)
  if (contentSize !== null && result.length !== contentSize) {
    throw new SessionCorruptError(
      `Zstandard 帧内容长度不符：头部声明 ${contentSize}，实际 ${result.length}`
    )
  }
  return result
}

// ─────────────────────────────────────────────────────────────
// 路径处理
// ─────────────────────────────────────────────────────────────

/**
 * 断言 child 落在 parent 之内，否则抛 PathEscapeError。
 *
 * 复用 `paths.js` 的 {@link isInside}（相对路径 + 绝对路径双重判定），
 * 保证与 UI / 配置层用的是同一套穿越判定。
 *
 * @param {string} parent 基准目录（绝对路径）
 * @param {string} child 待校验路径（绝对或相对 parent 的路径）
 * @returns {string} 规范化后的 child 绝对路径
 */
export function assertInside(parent, child) {
  const root = resolve(parent)
  const target = resolve(root, child)
  if (!isInside(root, target)) {
    throw new PathEscapeError(`路径越界：${child} 不在 ${parent} 之内`)
  }
  return target
}

/**
 * 把 cwd 归一化成「同一目录只有一种写法」的形式。
 *
 * ## 为什么必须有这一步
 *
 * macOS 上 `/tmp`、`/var`、`/etc` 都是符号链接，指向 `/private/...`。
 * 而 `projectKey` 是**逐字符编码**路径字符串的，于是：
 *
 *   /var/folders/x/repo  →  --var-folders-x-repo--
 *   /private/var/folders/x/repo  →  --private-var-folders-x-repo--
 *
 * **这两个路径是同一个目录，却得到两个 projectKey** —— 会话文件会落在两个
 * 不同的目录里，互相看不见。DSH 自己记录 header.cwd 时用哪种写法我们无法
 * 控制，所以我们的每一次「写入」和「查找」都可能落在不同目录。
 *
 * 实测后果（端到端测试暴露）：本机会话按原始路径写入，下行追加时用
 * preflight 出来的 canonical 路径去找 → 找不到 → 报 `repo-path-missing`。
 *
 * ## 为什么用正则而不是 `fs.realpathSync`
 *
 * `realpathSync` 要求路径**存在**。而我们有时要为一个还没 clone 的仓库算
 * 目录名（dry-run、错误预览），那时 realpath 会抛错。用正则处理已知的
 * macOS 软链前缀，不依赖文件系统状态，纯函数、可测、零 IO。
 *
 * 这里只处理「系统级」软链（`/tmp`、`/var`、`/etc`、`/private/etc`）。
 * 用户自建的软链不在此列 —— 那需要真 realpath，由调用方在有 IO 时处理。
 *
 * @param {string} cwd 原始路径
 * @returns {string} 归一化后的路径
 */
export function canonicalizeCwdForProjectKey(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return cwd

  // macOS 的系统软链：这些前缀在 darwin 上恒定指向 /private/...
  // 注意顺序：先匹配更长的前缀，避免 /private/var 被 /var 规则误处理
  const prefixMap = [
    ['/private/var/', '/private/var/'], // 已经是 canonical，保持不变
    ['/private/tmp/', '/private/tmp/'],
    ['/private/etc/', '/private/etc/'],
    ['/var/', '/private/var/'],
    ['/tmp/', '/private/tmp/'],
    ['/etc/', '/private/etc/'],
  ]

  // 只在 darwin 上做这个归一化。Linux 上 /var 和 /tmp 是真实目录，
  // 归一化会把正确的路径改错。
  if (process.platform !== 'darwin') return cwd

  for (const [from, to] of prefixMap) {
    if (cwd === from.slice(0, -1)) return to.slice(0, -1)
    if (cwd.startsWith(from)) return to + cwd.slice(from.length)
  }
  return cwd
}

/**
 * 复刻 DSH 的 projectKey 编码（**仅用于构造路径，不要用它反解 cwd**）。
 *
 * 官方实现在 `projectKey()`：分隔符 `/` `\` `:` 合并成一个 `-`，其它不安全
 * 字符（含 `~`）编码为 `~XXXX`，去掉前导 `-`，截断到 251 字符，首尾包 `--`。
 *
 * 注意该映射是 **lossy** 的（分隔符合并 + 截断），因此一个目录名可能对应
 * 多个 cwd。判断「这个会话属于哪个仓库」必须读 header 里的 `cwd`，见
 * {@link scanSessions}。
 *
 * @param {string} cwd 会话的工作目录
 * @returns {string} 项目目录名（如 `--Users-me-project--`）
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError('projectKey: cwd 必须是非空字符串')
  }
  // ⚠️ 这里**刻意不做任何归一化**：DSH 自己的 `projectKey()` 是逐字符编码，
  // 它不会 realpath，也不会合并 /var 与 /private/var。我们必须与它逐字符一致，
  // 否则写出的目录名 DSH 自己算不出来 → 它找不到我们的会话。
  //
  // 同一目录的多种写法（软链）问题，改由**调用方在边界处统一**解决：
  // 见 `sameCwd()` 与 `findSessionDirsByCwd()`，它们负责「用哪种写法都能找到」。
  const normalized = cwd
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < normalized.length; i++) {
    const ch = String.fromCharCode(normalized.charCodeAt(i))
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + normalized.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const trimmed = readable.replace(/^-+/, '') || 'root'
  return `--${trimmed.slice(0, 251)}--`
}

/**
 * 复刻 DSH 的 session id 段编码（注入式、可逆、无穿越）。
 *
 * 安全字符保持字面；`~` 及一切其它字符编码为 `~XXXX`；特别处理 `.` / `..`
 * 以防整段被当成相对路径。
 *
 * @param {string} raw 原始字符串
 * @returns {string} 单个安全路径段
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new TypeError('encodeSegment: 必须是非空字符串')
  }
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * 解出 {@link encodeSegment} 的原始字符串。用于把磁盘目录名还原成 session id。
 *
 * @param {string} segment 编码后的单段名
 * @returns {string} 原始字符串
 */
export function decodeSegment(segment) {
  if (typeof segment !== 'string' || segment.length === 0) {
    throw new TypeError('decodeSegment: 必须是非空字符串')
  }
  let out = ''
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (ch !== '~') {
      out += ch
      continue
    }
    const hex = segment.slice(i + 1, i + 5)
    if (hex.length !== 4 || !/^[0-9A-Fa-f]{4}$/.test(hex)) {
      throw new SessionCorruptError(`非法的段转义：${segment.slice(i, i + 5)}`)
    }
    out += String.fromCharCode(parseInt(hex, 16))
    i += 4
  }
  return out
}

/**
 * 校验 session id 是安全的单段名 —— **白名单校验，不依赖任何转义假设**。
 *
 * 为什么不用「转义后再拼接」：转义是 DSH 内部的实现细节，可能随版本变化，
 * 也可能在某些代里根本不做（实测磁盘上 `session-<uuid>` 与裸 `<uuid>` 两种
 * 形态并存）。把一个安全边界建立在「我相信上游一定会转义」之上是脆弱的。
 *
 * 白名单则是自足的：只放行 `[A-Za-z0-9._-]`，且排除 `.` / `..`，
 * 于是 `/`、`\`、`:`、NUL、控制字符、Unicode 分隔符全部不可能通过，
 * 无论上游怎么变，拼出来的都是单段名。
 *
 * @param {unknown} value 来自配置文件或远端包的候选 id
 * @param {string} [what] 出错时用于说明是什么字段
 * @returns {string} 校验通过的 id
 * @throws {PathEscapeError}
 */
export function assertSafeSessionId(value, what = 'session id') {
  if (typeof value !== 'string') {
    throw new PathEscapeError(`${what} 必须是字符串，收到 ${typeof value}`)
  }
  if (value.length === 0 || value.length > 255) {
    throw new PathEscapeError(`${what} 长度必须在 1..255 之间，收到 ${value.length}`)
  }
  if (value === '.' || value === '..') {
    throw new PathEscapeError(`${what} 不能是 "." 或 ".."`)
  }
  // 白名单：只允许这些字符，其余（含 / \ : NUL 控制符 Unicode）一律拒绝
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new PathEscapeError(`${what} 含非白名单字符（只允许 A-Z a-z 0-9 . _ -）：${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 给一个 cwd 生成「同一目录的所有可能写法」。
 *
 * ## 为什么需要
 *
 * `projectKey()` 是逐字符编码路径的，**不做任何归一化** —— 这是必须的，
 * 因为 DSH 自己也这么做，我们必须与它逐字符一致，否则写出的目录名 DSH
 * 算不出来、也就找不到我们的会话。
 *
 * 但代价是：同一个目录的两种写法（软链）会得到两个 projectKey。macOS 上
 * `/tmp` → `/private/tmp`、`/var` → `/private/var`、`/etc` → `/private/etc`
 * 是**系统级软链，不是罕见情况**。于是：
 *
 *   本机会话按 `/var/...` 落盘 → 查找时用 canonical `/private/var/...` 算 key
 *   → 目录不存在 → 报「会话不存在」→ 追加静默失效。
 *
 * ## 解法：查找时不猜，把候选都试一遍
 *
 * 写入时用调用方给的字符串（与 DSH 一致）；**读取/查找时列出所有等价写法**，
 * 逐个看目录是否存在。这样：
 *   - 新数据不会分裂（写入仍然只有一个 key）
 *   - 历史数据仍然找得到（查找会试多种写法）
 *   - 不偏离 DSH 的编码规则
 *
 * 只列系统级软链的等价形式。用户自建软链需要真 `realpath`（异步 IO），
 * 由调用方在有 IO 时通过 `options.cwdCandidates` 补充。
 *
 * @param {string} cwd 原始路径
 * @returns {string[]} 去重后的候选路径列表，第一个总是原值
 */
export function cwdCandidates(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return []
  const out = [cwd]
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !out.includes(value)) out.push(value)
  }

  if (process.platform === 'darwin') {
    const forward = [
      ['/var/', '/private/var/'],
      ['/tmp/', '/private/tmp/'],
      ['/etc/', '/private/etc/'],
    ]
    const backward = [
      ['/private/var/', '/var/'],
      ['/private/tmp/', '/tmp/'],
      ['/private/etc/', '/etc/'],
    ]
    for (const [from, to] of forward) {
      if (cwd === from.slice(0, -1)) push(to.slice(0, -1))
      else if (cwd.startsWith(from)) push(to + cwd.slice(from.length))
    }
    for (const [from, to] of backward) {
      if (cwd === from.slice(0, -1)) push(to.slice(0, -1))
      else if (cwd.startsWith(from)) push(to + cwd.slice(from.length))
    }
  }
  return out
}

/**
 * 找出一个会话在本机所有可能的目录（因为 cwd 可能有多种写法）。
 *
 * 按 `cwdCandidates()` 逐个算 projectKey 并探测目录是否存在。
 * 返回值按「第一个存在的」优先，便于调用方直接用 `[0]`。
 *
 * @param {string} sessionsRoot 会话根目录
 * @param {string} sessionId 会话 id
 * @param {string} cwd 会话 header 里的 cwd
 * @param {{cwdCandidates?: string[]}} [options] 额外的候选 cwd（如真 realpath 的结果）
 * @returns {Promise<string[]>} 存在的会话目录绝对路径，按存在性过滤
 */
export async function findSessionDirsByCwd(sessionsRoot, sessionId, cwd, options = {}) {
  const root = resolve(sessionsRoot)
  const idSegment = encodeSegment(assertSafeSessionId(sessionId, 'sessionId'))
  const candidates = [...cwdCandidates(cwd), ...(options.cwdCandidates ?? [])]

  const found = []
  const seen = new Set()
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    let dir
    try {
      dir = join(root, projectKey(candidate), idSegment)
      assertInside(root, dir)
    } catch {
      continue
    }
    if (seen.has(dir)) continue
    seen.add(dir)
    if (await pathExists(dir)) found.push(dir)
  }
  return found
}

/**
 * 解析日志文件名，得到物理代与是否压缩。
 *
 * @param {string} filename 文件名
 * @returns {{generation: number, compressed: boolean} | null} 不匹配时返回 null
 */
export function parseLogFilename(filename) {
  const m = LOG_FILENAME_RE.exec(filename)
  if (!m) return null
  const generation = m[1] === undefined ? 0 : Number(m[1])
  return { generation, compressed: m[2] === '.zstd' }
}

/** 当前代的日志文件名。 */
export function currentLogFilename(compressed = true) {
  return `session.v${CURRENT_GENERATION}.jsonl${compressed ? '.zstd' : ''}`
}

// ─────────────────────────────────────────────────────────────
// 单会话读取
// ─────────────────────────────────────────────────────────────

/**
 * 解析明文日志为 header + 事件数组，并校验 seq 连续性。
 *
 * 尾部若有不完整行（没换行的最后一行），按 torn tail 丢弃。
 *
 * @param {string} plaintext 解压后的完整明文
 * @returns {{header: object, events: object[], nextSeq: number, tornTail: boolean}}
 * @throws {SessionCorruptError} header 缺失/非法，或 seq 不连续
 */
export function parseSessionLog(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('parseSessionLog: 需要字符串')
  }

  let tornTail = false
  let text = plaintext
  if (text.length > 0 && !text.endsWith('\n')) {
    // 最后一行没有换行 → 崩溃留下的半截，丢弃
    const lastBreak = text.lastIndexOf('\n')
    text = lastBreak === -1 ? '' : text.slice(0, lastBreak + 1)
    tornTail = true
  }

  const lines = text.split('\n').filter((line) => line.length > 0)
  if (lines.length === 0) {
    throw new SessionCorruptError('会话日志为空或只有 torn tail，缺少 header 行')
  }

  let header
  try {
    header = JSON.parse(lines[0])
  } catch (cause) {
    throw new SessionCorruptError('会话日志首行不是合法 JSON（header 损坏）', { cause })
  }

  assertValidHeader(header)

  const events = []
  let expected = 0
  for (let i = 1; i < lines.length; i++) {
    let event
    try {
      event = JSON.parse(lines[i])
    } catch (cause) {
      throw new SessionCorruptError(`第 ${i + 1} 行不是合法 JSON`, { cause })
    }
    if (typeof event !== 'object' || event === null) {
      throw new SessionCorruptError(`第 ${i + 1} 行不是 JSON 对象`)
    }
    if (event.seq !== expected) {
      throw new SessionCorruptError(
        `第 ${i + 1} 行 seq 不连续：期望 ${expected}，实际 ${event.seq}`
      )
    }
    events.push(event)
    expected += 1
  }

  return { header, events, nextSeq: expected, tornTail }
}

/**
 * 校验 header 的必备字段与类型。对齐 DSH 的 `isHeaderLine`。
 *
 * @param {unknown} header
 * @throws {SessionCorruptError}
 */
export function assertValidHeader(header) {
  const fail = (why) => {
    throw new SessionCorruptError(`会话 header 非法：${why}`)
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    fail('不是对象')
  }
  if (header.type !== 'session') fail(`type 应为 "session"，实际 ${JSON.stringify(header.type)}`)
  if (typeof header.version !== 'number') fail('缺少数字 version')
  if (typeof header.id !== 'string' || header.id.length === 0) fail('缺少字符串 id')
  if (!Number.isSafeInteger(header.createdAt) || header.createdAt < 0) {
    fail('createdAt 必须是非负安全整数')
  }
  if (!Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0) {
    fail('delegationDepth 必须是非负安全整数')
  }
  if (header.cwd !== undefined && typeof header.cwd !== 'string') fail('cwd 必须是字符串')
  if (header.parentSession !== undefined && typeof header.parentSession !== 'string') {
    fail('parentSession 必须是字符串')
  }
  if (typeof header.isSeeded !== 'boolean') fail('isSeeded 必须是布尔值')
  if (header.origin !== undefined && header.origin !== 'subagent') {
    fail('origin 只允许 "subagent"')
  }
  if (header.agentPreset !== undefined && typeof header.agentPreset !== 'string') {
    fail('agentPreset 必须是字符串')
  }
}

/**
 * 读取一个会话目录，返回完整解析结果。
 *
 * @param {string} sessionDir 会话目录的绝对路径
 * @param {{frameDecoder?: (frame: Buffer) => Buffer, signal?: AbortSignal}} [options]
 * @returns {Promise<{
 *   dir: string, id: string, header: object, events: object[],
 *   nextSeq: number, frames: number, tornTail: boolean, tornBytes: number,
 *   logFile: string, logBytes: number, contentHash: string
 * }>}
 */
export async function readSessionDir(sessionDir, options = {}) {
  const dir = resolve(sessionDir)
  const entries = await readdir(dir, { withFileTypes: true })

  // 选择代版本最高的日志文件（与 DSH 的「选数值最高的 canonical 代」一致）
  const candidates = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const parsed = parseLogFilename(entry.name)
    if (parsed === null) continue
    candidates.push({ name: entry.name, ...parsed })
  }
  if (candidates.length === 0) {
    throw new SessionCorruptError(`会话目录里没有日志文件：${dir}`)
  }
  candidates.sort((a, b) => b.generation - a.generation)
  const chosen = candidates[0]

  const logFile = assertInside(dir, chosen.name)
  const info = await stat(logFile)
  if (!info.isFile()) {
    throw new SessionCorruptError(`日志路径不是普通文件：${logFile}`)
  }
  if (info.size > MAX_LOG_BYTES) {
    throw new SessionCorruptError(`会话日志过大（${info.size} 字节）`)
  }

  const raw = await readFile(logFile, { signal: options.signal })
  const contentHash = createHash('sha256').update(raw).digest('hex')

  let parsed
  if (chosen.compressed) {
    const { plaintext, frames, tornBytes } = decodeLogBuffer(raw, options)
    parsed = { ...parseSessionLog(plaintext), frames, tornBytes }
  } else {
    parsed = { ...parseSessionLog(raw.toString('utf8')), frames: 0, tornBytes: 0 }
  }

  if (chosen.generation !== CURRENT_GENERATION) {
    // 旧代的事件语义可能不同（v0/v1 还有 packed delta 行）。
    // 我们不假装能读，明确报错让上层决定。
    throw new UnsupportedGenerationError(
      `会话 ${parsed.header.id} 是 v${chosen.generation} 格式，本模块只支持 v${CURRENT_GENERATION}`
    )
  }

  return {
    dir,
    id: parsed.header.id,
    header: parsed.header,
    events: parsed.events,
    nextSeq: parsed.nextSeq,
    frames: parsed.frames,
    tornTail: parsed.tornTail,
    tornBytes: parsed.tornBytes,
    logFile,
    logBytes: raw.length,
    contentHash,
  }
}

// ─────────────────────────────────────────────────────────────
// 仓库级扫描
// ─────────────────────────────────────────────────────────────

/**
 * 会话根目录。
 *
 * 复用 `paths.js` 的唯一定义（dev-core 负责），保证引擎与 UI 口径一致。
 * 本模块不自己拼 `<home>/sessions`，也不硬编码任何家目录。
 *
 * @param {string} [dshHome] 已解析的 DSH home；缺省时按 paths.js 的优先级解析
 * @param {{ profileContext?: { home?: string }, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string} 绝对路径
 */
export function sessionsRoot(dshHome, options = {}) {
  if (typeof dshHome === 'string' && dshHome !== '') return resolveSessionsRoot(dshHome)
  return resolveSessionsRoot(resolveDshHome(options))
}

/**
 * 扫描会话根目录下所有会话的**轻量元数据**（只读 header，不解全量事件）。
 *
 * 这个函数是「按仓库筛会话」的唯一入口：因为 projectKey 是 lossy 的，
 * 必须靠 header.cwd 反查。
 *
 * @param {string} root 会话根目录
 * @param {{signal?: AbortSignal, includeEvents?: boolean, frameDecoder?: Function}} [options]
 * @returns {Promise<Array<object>>} 每个会话一条记录
 */
export async function scanSessions(root, options = {}) {
  const base = resolve(root)
  let projectDirs
  try {
    projectDirs = await readdir(base, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }

  const results = []
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue
    const projectPath = assertInside(base, assertSafeSegment(projectDir.name, '项目目录名'))

    let sessionDirs
    try {
      sessionDirs = await readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue
      const dirPath = assertInside(projectPath, assertSafeSegment(sessionDir.name, '会话目录名'))

      try {
        const record = options.includeEvents
          ? await readSessionDir(dirPath, options)
          : await readSessionHeaderOnly(dirPath, options)
        results.push({
          ...record,
          projectDir: projectDir.name,
          sessionDirName: sessionDir.name,
        })
      } catch (error) {
        // 单个会话坏了不应该让整次扫描失败 —— 记下来继续
        results.push({
          dir: dirPath,
          projectDir: projectDir.name,
          sessionDirName: sessionDir.name,
          error: {
            name: error?.name ?? 'Error',
            code: error?.code ?? null,
            message: error?.message ?? String(error),
          },
        })
      }
    }
  }

  return results
}

/**
 * 只读 header 的快速路径：解第一帧就够了（header 独占首帧）。
 *
 * 这样扫 100 个会话不必解压它们的全部事件，对「按仓库筛会话」这种
 * 只需要 cwd 的场景是几百倍的提速。
 *
 * @param {string} sessionDir 会话目录
 * @param {{frameDecoder?: Function, signal?: AbortSignal}} [options]
 * @returns {Promise<object>}
 */
export async function readSessionHeaderOnly(sessionDir, options = {}) {
  const dir = resolve(sessionDir)
  const entries = await readdir(dir, { withFileTypes: true })

  const candidates = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const parsed = parseLogFilename(entry.name)
    if (parsed === null) continue
    candidates.push({ name: entry.name, ...parsed })
  }
  if (candidates.length === 0) {
    throw new SessionCorruptError(`会话目录里没有日志文件：${dir}`)
  }
  candidates.sort((a, b) => b.generation - a.generation)
  const chosen = candidates[0]

  const logFile = assertInside(dir, chosen.name)
  const info = await stat(logFile)
  if (info.size > MAX_LOG_BYTES) {
    throw new SessionCorruptError(`会话日志过大（${info.size} 字节）`)
  }

  const raw = await readFile(logFile, { signal: options.signal })

  let headerText
  if (chosen.compressed) {
    const { frames, tornStart } = scanZstdFrames(raw)
    if (frames.length === 0) {
      throw new SessionCorruptError(
        `会话日志没有完整帧（tornStart=${tornStart}）：${logFile}`
      )
    }
    const decoder = options.frameDecoder ?? defaultFrameDecoder
    headerText = decoder(raw.subarray(frames[0].start, frames[0].end)).toString('utf8')
  } else {
    headerText = raw.toString('utf8')
  }

  const firstLine = headerText.split('\n', 1)[0]
  let header
  try {
    header = JSON.parse(firstLine)
  } catch (cause) {
    throw new SessionCorruptError(`会话日志首行不是合法 JSON：${logFile}`, { cause })
  }
  assertValidHeader(header)

  if (chosen.generation !== CURRENT_GENERATION) {
    throw new UnsupportedGenerationError(
      `会话 ${header.id} 是 v${chosen.generation} 格式，本模块只支持 v${CURRENT_GENERATION}`
    )
  }

  // 顺带扫一次帧边界：DSH 的落盘约定是「每个 durable append 一批写一帧」，
  // header 独占首帧，所以 `帧数 - 1` 是一个**廉价的事件数上界**（真实事件数
  // 只会 >= 它，因为一批可能含多个事件）。这比为了数事件而解压整个文件便宜
  // 得多（扫帧不解压），足够支撑 list() 的展示与「有没有新事件」的粗判断。
  // 精确事件数由 read() 走完整解析得到。
  let frameCount = null
  try {
    const scanned = scanZstdFrames(raw)
    frameCount = scanned.frames.length
  } catch {
    frameCount = null
  }

  return {
    dir,
    id: header.id,
    header,
    logFile,
    logBytes: raw.length,
    contentHash: createHash('sha256').update(raw).digest('hex'),
    frameCount,
    // 帧数 - 1 = 至少这么多批 append；仅作估算，精确值靠 read()
    estimatedEventCount: frameCount === null ? null : Math.max(0, frameCount - 1),
  }
}

/**
 * 把仓库路径归一化成可比较的键。
 *
 * 只做「同一个真实目录」的判定：解析符号链接、去掉尾部分隔符、大小写
 * 在大小写不敏感文件系统上统一。**不做 git remote 归一化**（那是 repo-binding 的活）。
 *
 * @param {string} path 目录路径
 * @returns {string}
 */
export function normalizeRepoPath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('normalizeRepoPath: 需要非空字符串')
  }
  let p = resolve(path)
  // macOS/Windows 常见的大小写不敏感卷
  if (process.platform === 'darwin' || process.platform === 'win32') {
    p = p.toLowerCase()
  }
  return p
}

/**
 * 判断会话是否属于给定仓库。
 *
 * 规则：精确匹配 header.cwd，或者 cwd 位于仓库目录之下（子目录 / worktree）。
 * 用 {@link normalizeRepoPath} 做两侧归一化。
 *
 * @param {{header: {cwd?: string}}} session 会话记录
 * @param {string} repoPath 仓库根目录
 * @returns {boolean}
 */
export function sessionBelongsToRepo(session, repoPath) {
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return false
  const sessionCwd = normalizeRepoPath(cwd)
  const repo = normalizeRepoPath(repoPath)
  if (sessionCwd === repo) return true
  return sessionCwd.startsWith(repo + sep) || sessionCwd.startsWith(repo + '/')
}

/**
 * 把一个会话数组按「父子闭包」分组。
 *
 * ## 为什么需要它
 *
 * 实测 218 个真实会话里有 151 个是子会话（`parentSession` 指向父会话），
 * 占 69%。子会话是父会话推理过程的组成部分 —— 缺了它，用户回到另一台机器
 * 打开父会话时，"这个结论是哪个子代理做出来的"这段信息就丢了。
 * 所以同步的**单元不是单个会话，而是会话闭包**：一个顶层会话加上它全部后代。
 *
 * ## 判定规则（刻意保守）
 *
 * **是子会话 ⟺ header.parentSession 是非空字符串。** 只看这一个字段。
 *
 * 不把 `origin === 'subagent'` 当作必要条件，也不看 `delegationDepth`：
 * `origin` 在 DSH 的 header 校验里是可选字段，`delegationDepth` 是展示用的
 * 深度信息。而 `parentSession` 存在本身就是「我有父」的充分条件 ——
 * 把判定建立在充分条件上，比建立在当前实现的惯例上更抗变化。
 *
 * 也不靠「目录名有没有 session- 前缀」判断：实测 218/218 吻合，但那是观测
 * 不是契约（qa 也独立确认了这一点）。
 *
 * ## 孤儿处理
 *
 * `parentSession` 指向的会话不在传入数组里时，该会话**自成闭包**，
 * 但在结果里用 `orphan: true` 标记，让上层能给出可读警告而不是静默通过。
 * 实测真实数据里孤儿数为 0，所以正常流程不该出现。
 *
 * @param {Array<{id?: string, header?: {id?: string, parentSession?: string}}>} sessions
 *   会话记录数组；每个元素至少要有 `id`（或 `header.id`）与 `header`
 * @returns {Array<{
 *   root: string, members: string[], descendants: string[],
 *   orphan: boolean, missingParent: string | null
 * }>} 闭包列表，每个闭包以顶层（无父）会话为 root
 */
export function groupSessionClosures(sessions) {
  if (!Array.isArray(sessions)) {
    throw new SyncError(ERROR_CODES.BAD_REQUEST, 'groupSessionClosures 需要数组')
  }

  /** id → 记录 */
  const byId = new Map()
  for (const record of sessions) {
    const id = record?.id ?? record?.header?.id
    if (typeof id !== 'string' || id === '') continue
    byId.set(id, record)
  }

  /** 父 id → 子 id 列表 */
  const childrenOf = new Map()
  /** id → 父 id */
  const parentOf = new Map()

  for (const [id, record] of byId) {
    const parent = record?.header?.parentSession
    if (typeof parent === 'string' && parent !== '') {
      parentOf.set(id, parent)
      if (!childrenOf.has(parent)) childrenOf.set(parent, [])
      childrenOf.get(parent).push(id)
    }
  }

  /**
   * 向上追溯到顶层会话。
   *
   * 要防环：虽然 DSH 不会产生环，但这是**不可信输入可能构造的形态**
   * （远端载荷里的 header 是别人写的），沿环走会死循环。
   */
  const resolveRoot = (id) => {
    const seen = new Set()
    let current = id
    for (;;) {
      if (seen.has(current)) {
        // 检测到环：把这个 id 当作顶层，避免挂死
        return { root: id, cycled: true }
      }
      seen.add(current)
      const parent = parentOf.get(current)
      if (parent === undefined) return { root: current, cycled: false }
      // 父不在传入集合里 → 本会话是孤儿，自成顶层
      if (!byId.has(parent)) return { root: current, cycled: false, missingParent: parent }
      current = parent
    }
  }

  /** root id → 闭包 */
  const closures = new Map()
  /** 已被某个闭包收编的 id，避免环导致的重复归属 */
  const claimed = new Set()

  for (const id of byId.keys()) {
    const { root, missingParent } = resolveRoot(id)
    let closure = closures.get(root)
    if (closure === undefined) {
      closure = {
        root,
        members: [],
        descendants: [],
        orphan: false,
        missingParent: null,
      }
      closures.set(root, closure)
    }
    if (!claimed.has(id)) {
      claimed.add(id)
      closure.members.push(id)
      if (id !== root) closure.descendants.push(id)
    }
    if (missingParent !== undefined && missingParent !== null) {
      closure.orphan = true
      closure.missingParent = missingParent
    }
  }

  // 稳定输出：先按 root 名排序，成员也排序，便于测试与 diff
  return [...closures.values()]
    .map((closure) => ({
      ...closure,
      members: [...closure.members].sort(),
      descendants: [...closure.descendants].sort(),
    }))
    .sort((a, b) => a.root.localeCompare(b.root))
}

/**
 * 找出「父会话既不在本机、也不在本批次」的会话。
 *
 * 用于下行后的完整性校验：返回的不是错误而是警告清单 —— 用户可能有意
 * 只同步部分会话，硬失败会让合法操作做不了。
 *
 * @param {Array<{id?: string, header?: {parentSession?: string}}>} incoming 远端来的会话
 * @param {Iterable<string>} presentLocalIds 本机已有的会话 id
 * @returns {Array<{id: string, missingParent: string}>} 需要提示的会话
 */
export function findMissingParents(incoming, presentLocalIds) {
  const local = presentLocalIds instanceof Set ? presentLocalIds : new Set(presentLocalIds)
  const incomingIds = new Set()
  for (const record of incoming) {
    const id = record?.id ?? record?.header?.id
    if (typeof id === 'string' && id !== '') incomingIds.add(id)
  }

  const missing = []
  for (const record of incoming) {
    const id = record?.id ?? record?.header?.id
    const parent = record?.header?.parentSession
    if (typeof id !== 'string' || typeof parent !== 'string' || parent === '') continue
    if (local.has(parent) || incomingIds.has(parent)) continue
    missing.push({ id, missingParent: parent })
  }
  return missing
}

/**
 * 扫描并筛出属于某仓库的所有会话。
 *
 * @param {string} repoPath 仓库根目录
 * @param {{root?: string, env?: NodeJS.ProcessEnv, includeEvents?: boolean, frameDecoder?: Function, signal?: AbortSignal}} [options]
 * @returns {Promise<Array<object>>}
 */
export async function findSessionsForRepo(repoPath, options = {}) {
  const root = options.root ?? sessionsRoot(options.env)
  const all = await scanSessions(root, {
    includeEvents: options.includeEvents ?? false,
    frameDecoder: options.frameDecoder,
    signal: options.signal,
  })
  return all.filter((record) => record.error === undefined && sessionBelongsToRepo(record, repoPath))
}

// ─────────────────────────────────────────────────────────────
// 增量水位线 —— 物理层与逻辑层分开建模
// ─────────────────────────────────────────────────────────────
//
// 这两层不是二选一，而是各管一件事，缺一不可：
//
//   物理层 ByteWatermark：负责「省」，把增量传输做成 O(1) 截取。
//     依据：DSH 的日志是 append-only，旧文件恒为新文件的前缀，
//     且每次 append 都以完整帧为单位落盘，所以任意「已同步到的字节位置」
//     后面切开，切出来的都必然是完整的 zstd 帧序列，可以直接推送。
//     没有它，每次同步都得把整个文件解压一遍 —— 实测本机存在 17MB 会话，
//     长会话同步会变成 O(文件大小) 的重复开销。
//
//   逻辑层 SeqWatermark：负责「对」，做完整性校验与幂等。
//     依据：seq 从 0 严格 +1 无缺口，是 DSH 自己的 committed contiguous
//     prefix 语义。它能回答「有没有缺事件」「这条是不是重复」，
//     而字节偏移回答不了（字节相同不代表事件相同，反过来事件相同也可能
//     因为重新压缩而字节不同）。
//
// 关系：SeqWatermark 是权威事实，ByteWatermark 是它的性能加速器。
// 任何时刻 ByteWatermark 都必须能被 SeqWatermark 校验出「这个字节位置
// 对应到第几条事件」，对不上就丢弃 ByteWatermark 重新从头解。

/**
 * 物理层水位线：本机已同步到日志文件的第几个字节。
 *
 * 该值必须落在**帧边界**上。{@link sliceByByteWatermark} 会校验这一点，
 * 校验不过就拒绝截取（宁可退回全量解压，也不能发出半个帧）。
 *
 * @typedef {object} ByteWatermark
 * @property {number} byteOffset 已经同步出去的字节数（= 下一个待发送帧的起始偏移）
 * @property {string} contentHash 该字节位置处文件内容的 sha256 前缀，用于发现「文件被重写」
 * @property {number} [atSeq] 该字节位置恰好对应到的事件 seq（交叉校验用）
 */

/**
 * 逻辑层水位线：本机已同步到第几条事件。
 *
 * `syncedThroughSeq = N` 表示 seq `0..N-1` 已经同步过，下一个该发的是 seq N。
 *
 * @typedef {object} SeqWatermark
 * @property {number} syncedThroughSeq 已同步的事件条数（= nextSeq - 未同步数）
 * @property {string} [sessionContentHash] 该会话在本机的快照指纹，用于发现远端拿的是旧版本
 */

/**
 * 计算某个会话自水位线以来的新事件切片。
 *
 * 水位线语义：`syncedThroughSeq = N` 表示「seq 0..N-1 已经同步过了」。
 * 因此：
 *   - `N === nextSeq` → 无新事件
 *   - `N <  nextSeq` → 返回 events[N .. nextSeq-1]
 *   - `N >  nextSeq` → 本机反而落后于水位线（本机被回滚/换机）→ 报错，
 *                       绝不静默当作「已同步」，否则会丢事件
 *
 * @param {{events: object[], nextSeq: number}} session
 * @param {number} syncedThroughSeq
 * @returns {{events: object[], fromSeq: number, toSeqExclusive: number, hasNew: boolean}}
 * @throws {SyncError} 水位线越界
 */

/**
 * 计算某个会话自水位线以来的新事件切片。

/**
 * 计算某个会话自水位线以来的新事件切片。
 *
 * 水位线语义：`syncedThroughSeq = N` 表示「seq 0..N-1 已经同步过了」。
 * 因此：
 *   - `N === nextSeq` → 无新事件
 *   - `N <  nextSeq` → 返回 events[N .. nextSeq-1]
 *   - `N >  nextSeq` → 本机反而落后于水位线（本机被回滚/换机）→ 报错，
 *                       绝不静默当作「已同步」，否则会丢事件
 *
 * @param {{events: object[], nextSeq: number}} session
 * @param {number} syncedThroughSeq
 * @returns {{events: object[], fromSeq: number, toSeqExclusive: number, hasNew: boolean}}
 * @throws {RangeError} 水位线越界
 */
export function sliceSinceWatermark(session, syncedThroughSeq) {
  const { events, nextSeq } = session
  if (!Number.isSafeInteger(syncedThroughSeq) || syncedThroughSeq < 0) {
    throw new SyncError(ERROR_CODES.BAD_REQUEST, `水位线必须是非负安全整数，收到 ${syncedThroughSeq}`)
  }
  if (syncedThroughSeq > nextSeq) {
    throw new SyncError(
      ERROR_CODES.CONFLICT_SESSION,
      `水位线 ${syncedThroughSeq} 超过本机会话事件数 ${nextSeq}：` +
        '本机会话比水位线记录的更少（可能被回滚或换了机器），拒绝当作已同步',
      { hint: '请确认本机会话是否被回滚，或清除该仓库的同步水位线后重新全量同步' }
    )
  }
  return {
    events: events.slice(syncedThroughSeq),
    fromSeq: syncedThroughSeq,
    toSeqExclusive: nextSeq,
    hasNew: nextSeq > syncedThroughSeq,
  }
}

/**
 * 按字节水位线截取日志尾部（物理层增量）。
 *
 * 校验该偏移**必须落在帧边界**上：若不是，说明水位线记录的是半帧位置
 * （只可能来自损坏的状态文件或并发写入的竞态），此时拒绝截取并返回
 * `frameAligned: false`，由调用方退回「按 seq 全量解压」的慢路径。
 *
 * 截出来的字节串天然是完整帧序列，可以直接作为上行载荷。
 *
 * @param {Buffer} raw 日志文件当前全部字节
 * @param {number} byteOffset 已同步到的字节位置
 * @returns {{
 *   frameAligned: boolean, tail: Buffer, byteOffset: number,
 *   frameCount: number, reason?: string
 * }}
 */
export function sliceByByteWatermark(raw, byteOffset) {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    return {
      frameAligned: false,
      tail: Buffer.alloc(0),
      byteOffset: raw.length,
      frameCount: 0,
      reason: `字节水位线必须是非负整数，收到 ${byteOffset}`,
    }
  }
  if (byteOffset > raw.length) {
    // 文件比水位线记录的还短 → 文件被替换/截断了，物理水位线不可信
    return {
      frameAligned: false,
      tail: raw,
      byteOffset: raw.length,
      frameCount: 0,
      reason: `字节水位线 ${byteOffset} 超过文件长度 ${raw.length}：文件已变短，需全量重来`,
    }
  }
  if (byteOffset === raw.length) {
    return { frameAligned: true, tail: Buffer.alloc(0), byteOffset, frameCount: 0 }
  }

  // 校验：从该偏移开始必须恰好是一个合法的帧序列起点
  const tail = raw.subarray(byteOffset)
  if (tail.length < 4 || tail.readUInt32LE(0) !== ZSTD_MAGIC) {
    return {
      frameAligned: false,
      tail,
      byteOffset: raw.length,
      frameCount: 0,
      reason: `字节水位线 ${byteOffset} 不在帧边界上（该处不是 zstd 魔数）`,
    }
  }

  try {
    const { frames, tornStart } = scanZstdFrames(tail)
    if (tornStart !== undefined) {
      // 尾部有半帧：只发出完整帧部分，torn 部分留给下次
      const safeEnd = frames.length > 0 ? frames[frames.length - 1].end : 0
      return {
        frameAligned: true,
        tail: tail.subarray(0, safeEnd),
        byteOffset: byteOffset + safeEnd,
        frameCount: frames.length,
        reason: '尾部存在未写完的帧，已截到最后一个完整帧',
      }
    }
    return {
      frameAligned: true,
      tail,
      byteOffset: raw.length,
      frameCount: frames.length,
    }
  } catch (cause) {
    return {
      frameAligned: false,
      tail,
      byteOffset: raw.length,
      frameCount: 0,
      reason: `从字节 ${byteOffset} 起的帧结构损坏：${cause?.message ?? cause}`,
    }
  }
}

/**
 * 统计一份日志里的帧数与总明文长度（不依赖外部 zstd CLI）。
 *
 * 用于自证「逐帧解压」没有被 naive 实现骗过：把它的结果和
 * `zstd -l` / `zstd -d | wc -c` 对比即可。
 *
 * @param {Buffer} raw 日志文件字节
 * @param {{frameDecoder?: (f: Buffer) => Buffer}} [options]
 * @returns {{frameCount: number, plaintextBytes: number, tornBytes: number}}
 */
export function measureLog(raw, options = {}) {
  const { plaintext, frames, tornBytes } = decodeLogBuffer(raw, options)
  return { frameCount: frames, plaintextBytes: Buffer.byteLength(plaintext, 'utf8'), tornBytes }
}

/**
 * 判断远端包能否安全追加到本机会话之后（lead 拍板的语义）。
 *
 * @param {{nextSeq: number}} local 本机会话
 * @param {{fromSeq: number, toSeqExclusive: number}} remote 远端包覆盖的区间
 * @returns {{action: 'append'|'up-to-date'|'gap', reason: string}}
 *   - `append`     远端从本机 nextSeq 开始，可直接追加
 *   - `up-to-date` 远端区间已被本机覆盖，无需动作
 *   - `gap`        远端从更后面开始，中间缺事件 → 必须走冲突路径
 */
export function classifyIncoming(local, remote) {
  const { fromSeq, toSeqExclusive } = remote
  if (!Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(toSeqExclusive)) {
    return { action: 'gap', reason: '远端区间不是合法整数' }
  }
  if (toSeqExclusive < fromSeq) {
    // 区间倒置有两种可能，必须分开：
    //   - 远端比本机少（fromSeq 就是远端自己的长度）→ 本机领先，无需动作
    //   - 真的传错了 → gap
    // 前者是正常情形（远端落后于本机），按 gap 处理会让「本机领先」被误报成
    // 「包不完整」并走冲突路径，属于假冲突。
    if (fromSeq <= local.nextSeq) {
      return {
        action: 'up-to-date',
        reason: `远端只有 ${toSeqExclusive} 条事件、本机有 ${local.nextSeq} 条：本机领先，无需追加`,
      }
    }
    return { action: 'gap', reason: `远端区间倒置：${fromSeq}..${toSeqExclusive}` }
  }
  if (fromSeq === local.nextSeq) {
    return toSeqExclusive === fromSeq
      ? { action: 'up-to-date', reason: '远端包为空' }
      : { action: 'append', reason: `可从 seq ${fromSeq} 接续追加` }
  }
  if (toSeqExclusive <= local.nextSeq) {
    return {
      action: 'up-to-date',
      reason: `远端区间 ${fromSeq}..${toSeqExclusive} 已包含在本机的 0..${local.nextSeq}`,
    }
  }
  return {
    action: 'gap',
    reason:
      `远端从 seq ${fromSeq} 开始，但本机 nextSeq 是 ${local.nextSeq}：` +
      '中间事件缺失，包不完整',
  }
}

// ─────────────────────────────────────────────────────────────
// 凭据防护
// ─────────────────────────────────────────────────────────────

/**
 * 断言路径不落在凭据文件上。
 *
 * 硬约束「凭据不读不写」—— 读取层每次拿到路径都过一遍这个守卫，
 * 防止上层把 `.credentials.yaml` 之类的东西误传进来。
 *
 * @param {string} path
 * @throws {PathEscapeError}
 */
export function assertNotCredentialPath(path) {
  const normalized = resolve(path).toLowerCase()
  const banned = [
    '.credentials.yaml',
    '.credentials.yml',
    'credentials.yaml',
    'credentials.yml',
    '.env',
    'id_rsa',
    'id_ed25519',
    'id_ecdsa',
    '.netrc',
    'known_hosts',
  ]
  const parts = normalized.split(sep)
  for (const segment of parts) {
    if (banned.includes(segment)) {
      throw new PathEscapeError(`拒绝访问凭据路径：${path}`)
    }
  }
  const bannedSuffixes = ['.pem', '.key', '.p12', '.pfx', '.keystore']
  for (const suffix of bannedSuffixes) {
    if (normalized.endsWith(suffix)) {
      throw new PathEscapeError(`拒绝访问密钥文件：${path}`)
    }
  }
}

// ─────────────────────────────────────────────────────────────
// LIVE 会话检测 —— 拒绝写入正在被 DSH 使用的会话
// ─────────────────────────────────────────────────────────────

/**
 * DSH 用 `<会话目录>/session.lock` 上的 `flock(2)` **排他**咨询锁来表示
 * 「这个会话正被某个写入者持有」。语义（读自 DSH 的 persistence 源码）：
 *
 *   - 由内核仲裁，**持有者进程一死锁就自动释放** —— 所以不会因为崩溃而
 *     永久卡住一个会话；
 *   - 读者从不碰这个锁，所以「探测它是否被持有」不会干扰 DSH；
 *   - 锁文件本身**永不删除**（释放时只关 fd），所以文件存在 ≠ 被持有。
 *
 * ## 为什么必须检测
 *
 * 下行写入一个**正在运行**的会话，会让 DSH 内存里的 next-seq 与磁盘不一致，
 * 后续写入要么被拒、要么产生 seq 冲突 —— 这是本项目里唯一会破坏
 * 用户数据一致性的操作。宁可不写，也不能写坏。
 *
 * ## 探测手段（多平台后备）
 *
 * Node 没有内置 flock。按可靠性依次尝试：
 *
 *   1. **`lsof`**（macOS / Linux 都有）：列出持有该文件的进程。
 *      实测在 macOS 上准确：无持有者时无输出，持有期间能列出，
 *      持有者退出后恢复无输出。
 *   2. **`fuser`**（Linux 常见）：同上思路。
 *   3. 都不可用时返回 `live: false, checked: false` —— **明确表示没查成**，
 *      让上层决定是否放行，而不是假装「不 live」。
 *
 * 注意：这里**不去尝试自己 flock**。原因是我们不该去抢 DSH 的锁——
 * 抢不到会阻塞、侥幸抢到反而会把真的写入者挡住。只观察、不干预。
 *
 * @param {string} sessionDir 会话目录
 * @param {{execFile?: Function, timeoutMs?: number}} [options]
 *   `execFile` 是**调用级**注入，不是模块级全局开关 —— 后者在多文件并行
 *   测试下会互相污染（本模块曾有一个 `setLockProbeRunner` 全局设置，
 *   导致无关测试随机失败），这里刻意只走参数。
 * @returns {Promise<{live: boolean, checked: boolean, reason?: string, method?: string}>}
 */
export async function isSessionLive(sessionDir, options = {}) {
  const dir = resolve(sessionDir)
  const lockFile = join(dir, LOCK_FILENAME)

  // 锁文件不存在 → 这个会话从未被 materialize，不可能有活跃写入者
  if (!(await pathExists(lockFile))) {
    return { live: false, checked: true, method: 'no-lock-file' }
  }

  const runner = options.execFile ?? defaultExecFileImpl
  const timeoutMs = options.timeoutMs ?? 5_000

  // ── 1) lsof ──
  const lsof = await runner('lsof', ['--', lockFile], { timeoutMs })
  if (lsof.available) {
    if (lsof.code !== 0) {
      // lsof 的返回码 1 表示「没有进程打开该文件」—— 这是正常的「未被持有」
      return { live: false, checked: true, method: 'lsof' }
    }
    const output = String(lsof.stdout ?? '')
    // lsof 输出：首行表头，之后每行一个持有者（COMMAND PID USER FD TYPE ...）
    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const holders = lines.slice(1)
    if (holders.length === 0) {
      return { live: false, checked: true, method: 'lsof' }
    }
    // 只取命令名与 PID，别把整行 lsof 表格塞进用户提示里
    const summary = holders
      .map((line) => {
        const parts = line.split(/\s+/)
        return parts.length >= 2 ? `${parts[0]}(pid ${parts[1]})` : parts[0]
      })
      .slice(0, 3)
      .join(', ')
    return {
      live: true,
      checked: true,
      method: 'lsof',
      reason: `会话正被其他进程打开（${summary}），写入会导致 DSH 内存状态与磁盘不一致`,
    }
  }

  // ── 2) fuser ──
  const fuser = await runner('fuser', ['--', lockFile], { timeoutMs })
  if (fuser.available) {
    if (fuser.code !== 0) return { live: false, checked: true, method: 'fuser' }
    return {
      live: true,
      checked: true,
      method: 'fuser',
      reason: '会话正被其他进程打开，写入会导致 DSH 内存状态与磁盘不一致',
    }
  }

  // ── 3) 都不可用：明确报告「没查成」 ──
  return {
    live: false,
    checked: false,
    reason: '当前系统既没有 lsof 也没有 fuser，无法判断会话是否正在运行',
  }
}

/**
 * 调用外部命令并区分「命令不存在」与「执行失败」。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{timeoutMs: number}} options
 * @returns {Promise<{available: boolean, code: number, stdout: string, stderr: string}>}
 */
function defaultExecFileImpl(command, args, options) {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error && /** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') {
          resolvePromise({ available: false, code: 127, stdout: '', stderr: '' })
          return
        }
        const code =
          error === null || error === undefined
            ? 0
            : typeof error.code === 'number'
              ? error.code
              : 1
        resolvePromise({
          available: true,
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        })
      }
    )
  })
}

// ─────────────────────────────────────────────────────────────
// 写入：下行落盘
// ─────────────────────────────────────────────────────────────

/**
 * 把一组已解析的事件重新编码成 DSH 的落盘字节。
 *
 * 用途只有一个：**下行时重写 header 的 cwd**。因为 `attachSession()` 会
 * 硬校验 `realpath(header.cwd) === workspace.path`，A 机的路径到 B 机必然
 * 不匹配，不重写就 100% 被 registry 过滤掉（用户看到「同步成功」但侧栏空白
 * —— 这是比报错更糟的结果）。
 *
 * 重写会改变字节，所以**必须重新算 contentHash**；跨机判重不能用字节指纹，
 * 要用 `conflict.js` 的逻辑指纹（它排除 cwd）。
 *
 * 编码方式刻意与 DSH 一致：header 独占首帧，每个事件一帧。
 * 这样本模块自己写出来的文件能被 `readSessionDir()` 原样读回，
 * 也能被 `sliceByByteWatermark()` 按帧边界切分。
 *
 * @param {object} header 原始 header 对象
 * @param {object[]} events 事件数组（seq 必须从 0 连续）
 * @param {{cwdOverride?: string, frameEncoder?: (buf: Buffer) => Buffer}} [options]
 * @returns {Buffer} 可直接落盘的字节
 * @throws {SyncError} 事件 seq 不连续或无法编码
 */
export function encodeSessionLog(header, events, options = {}) {
  assertValidHeader(header)
  if (!Array.isArray(events)) {
    throw new SyncError(ERROR_CODES.BAD_REQUEST, 'encodeSessionLog 需要事件数组。')
  }
  for (const [i, event] of events.entries()) {
    if (event?.seq !== i) {
      throw new SyncError(
        ERROR_CODES.CORRUPT_SESSION,
        `编码前 seq 不连续：第 ${i} 个事件期望 seq=${i}，实际 ${event?.seq}`,
        { hint: '内部错误：事件流在写入前就已经不连续。' }
      )
    }
  }

  const nextHeader = { ...header }
  if (typeof options.cwdOverride === 'string' && options.cwdOverride !== '') {
    nextHeader.cwd = options.cwdOverride
  }

  const encodeFrame = options.frameEncoder ?? defaultFrameEncoder
  const frames = [encodeFrame(Buffer.from(JSON.stringify(nextHeader) + '\n', 'utf8'))]
  for (const event of events) {
    frames.push(encodeFrame(Buffer.from(JSON.stringify(event) + '\n', 'utf8')))
  }
  return Buffer.concat(frames)
}

/**
 * 默认帧编码器：用 Node 原生 zstd 压成带校验和的独立帧（与 DSH 一致）。
 *
 * 没有原生压缩能力时**明确报错**而不是退化 —— 退回未压缩会写出与 DSH
 * 不一致的文件，而这是我们主动写用户真实数据，不能有"差不多"。
 *
 * @param {Buffer} input
 * @returns {Buffer}
 */
function defaultFrameEncoder(input) {
  const compress = zlib.zstdCompressSync
  if (typeof compress !== 'function') {
    // 用 CORRUPT_SESSION 而不是 INTERNAL：对用户来说这不是"程序挂了"，
    // 而是"这个环境写不出符合 DSH 格式的文件"。归到 data 类错误码后，
    // engine 会把它当作系统性失败显式报出来，而不是吞成 internal-error。
    throw new SyncError(
      ERROR_CODES.CORRUPT_SESSION,
      `当前 Node ${process.version} 没有 zstd 压缩能力，无法安全地写出会话文件。`,
      {
        hint:
          '会话文件必须是带校验和的 zstd 帧序列，低版本 Node 无法生成。' +
          '请用 Node ≥ 22.15 运行 DSH；升级前可以先只做上行（读取不需要压缩）。',
        detail: { nodeVersion: process.version },
      }
    )
  }
  return compress(input, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
}

/**
 * 写入一个下载下来的会话。
 *
 * ## 安全顺序（顺序本身就是安全，不能重排）
 *
 *   1. **校验目标路径**：不落在凭据路径、pid 是安全段名
 *   2. **快照**：目标已存在则先整目录复制到备份区，且**回读验证**备份可读
 *   3. 备份失败 → **抛 `backup-failed` 并中止**，一个字节都不写
 *   4. 写临时文件 → 校验能读回 → **原子重命名**到目标
 *   5. 写入后回读验证能解析、seq 连续
 *
 * 第 4 步用「临时文件 + rename」而不是直接覆盖：rename 在同一文件系统上是
 * 原子的，所以中途崩溃不会留下半个日志文件；读取方要么看到旧文件、要么
 * 看到新文件。
 *
 * ## 为什么不是「追加」
 *
 * 追加只适用于「本机已有该会话且远端是它的延续」的情形，那由引擎在
 * 调用本函数**之前**用 `classifyIncoming()` 判定，并且走 `appendToSession()`。
 * 本函数处理的是「本机没有 / 需要整体替换」的情形。
 *
 * @param {object} payload `{sessionId, header, events, ...}`
 * @param {{sessionsRoot: string, backupDir: string, cwdOverride?: string, dryRun?: boolean, frameEncoder?: Function}} options
 * @returns {Promise<{written: string[], skipped: string[], backupPath: string|null, sessionId: string, contentHash: string|null, dryRun: boolean}>}
 */
export async function writeSession(payload, options) {
  // 兼容两种调用形态：
  //   (a) writeSession(payload, { sessionsRoot, backupDir, ... })   ← 主签名，显式
  //   (b) writeSession({ dshHome, sessionId, cwd, rounds, ... })    ← 便捷形态，
  //       测试与工具脚本更愿意用它（不用自己拼 header/events）
  //
  // 便捷形态只在**没有第二个参数**时启用，避免两种形态混杂时产生歧义。
  if (options === undefined && payload !== null && typeof payload === 'object' && payload.dshHome !== undefined) {
    payload = materializeConveniencePayload(payload)
    options = {
      sessionsRoot: join(resolve(payload.dshHome), 'sessions'),
      backupDir: join(resolve(payload.dshHome), 'repo-session-sync', 'backups'),
      lockProbeRunner: payload.lockProbeRunner,
      dryRun: payload.dryRun === true,
      skipLiveCheck: payload.skipLiveCheck === true,
    }
  }

  const { sessionsRoot, backupDir, cwdOverride, dryRun = false } = options ?? {}
  if (typeof sessionsRoot !== 'string' || sessionsRoot === '') {
    throw new SyncError(ERROR_CODES.BAD_REQUEST, 'writeSession 需要 sessionsRoot。')
  }
  if (typeof backupDir !== 'string' || backupDir === '') {
    throw new SyncError(ERROR_CODES.BAD_REQUEST, 'writeSession 需要 backupDir —— 无备份不写入。')
  }

  const sessionId = assertSafeSessionId(payload?.sessionId, '待写入 sessionId')
  assertNotCredentialPath(sessionsRoot)
  assertNotCredentialPath(backupDir)

  const header = payload?.header
  const events = payload?.events
  if (header === null || typeof header !== 'object') {
    throw new SyncError(ERROR_CODES.BAD_REQUEST, `会话 ${sessionId} 缺少 header。`)
  }
  if (!Array.isArray(events)) {
    throw new SyncError(ERROR_CODES.BAD_REQUEST, `会话 ${sessionId} 缺少 events。`)
  }
  if (header.id !== sessionId) {
    throw new SyncError(
      ERROR_CODES.CORRUPT_SESSION,
      `会话 id 不一致：参数是 ${sessionId}，header 里是 ${header.id}。`
    )
  }

  // cwd 是必填的：没有 cwd 的会话 DSH 无法校验归属，写进去也看不见
  const effectiveCwd = typeof cwdOverride === 'string' && cwdOverride !== ''
    ? cwdOverride
    : header.cwd
  if (typeof effectiveCwd !== 'string' || effectiveCwd === '') {
    throw new SyncError(
      ERROR_CODES.CORRUPT_SESSION,
      `会话 ${sessionId} 没有 cwd，写入后无法被 DSH 的 workspace 收录。`,
      { hint: '请确认远端会话带有 cwd，或为本机配置目标仓库路径。' }
    )
  }

  // 落点：<sessionsRoot>/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl.zstd
  const projectDir = join(resolve(sessionsRoot), projectKey(effectiveCwd))
  assertInside(resolve(sessionsRoot), projectDir)
  const sessionDir = join(projectDir, encodeSegment(sessionId))
  assertInside(resolve(sessionsRoot), sessionDir)
  const logFile = join(sessionDir, currentLogFilename(true))

  const existed = await pathExists(sessionDir)

  // ── 关键防线：拒绝写入正在被 DSH 使用的会话 ──
  //
  // 位置很讲究，三重理由：
  //   1. 在**编码之前** —— 编码要压缩全部事件，是最贵的步骤；已经知道不能写
  //      就没必要先花这份开销。
  //   2. 在**备份之前** —— LIVE 拒绝不应产生任何副作用，连备份目录都不该建。
  //   3. 在 dry-run 之前 —— 预演时也要报告「这个会话现在不能写」，
  //      否则用户看到的 dry-run 结果是"一切正常"，实际执行却失败。
  //
  // 为什么这条比备份优先：备份保护的是「写坏了能恢复」，LIVE 检测保护的是
  // 「根本不要写坏」。写入活跃会话会让 DSH 内存与磁盘的 next-seq 分叉，
  // 之后 DSH 自己的写入会被拒或产生 seq 冲突 —— 那是插件不该造成的伤害。
  let liveness = { live: false, checked: false, reason: '未检测' }
  if (options.skipLiveCheck !== true) {
    liveness = await isSessionLive(sessionDir, { execFile: options.lockProbeRunner })
    if (liveness.live && dryRun !== true) {
      throw new SyncError(
        ERROR_CODES.BUSY,
        `会话 ${sessionId} 正在使用中，已跳过写入以免破坏 DSH 的内存状态。`,
        {
          hint: '请先在 DSH 里结束或关闭该会话，再重新同步。',
          detail: { method: liveness.method, reason: liveness.reason },
        }
      )
    }
    // checked=false 表示系统里没有 lsof/fuser，我们**没查成**。
    // 这种情况放行但记录，而不是假装「不 live」（见 isSessionLive 注释）。
    if (liveness.checked === false) {
      options.log?.warn?.('session.live-check-unavailable', {
        sessionId,
        reason: liveness.reason,
      })
    }
  }

  // ── dry-run：在**编码之前**返回 ──
  //
  // dry-run 的承诺是「不产生副作用、不需要真正写入的能力」。如果先编码再判断
  // dryRun，那么在没有 zstd 压缩能力的环境（Node < 22.15）里跑预演会直接抛错，
  // 而预演恰恰是最该在这种环境下可用的 —— 先看看会发生什么，再决定要不要装。
  // 同理，任何编码期错误（数据损坏等）也不该让 dry-run 无法预演。
  //
  // 代价：dry-run 拿不到 contentHash（那需要真实编码）。这不是损失 ——
  // 调用方真正关心的是「会写到哪、会不会覆盖、要不要备份」，
  // 这些都不需要编码就能算准。
  if (dryRun) {
    let wouldBackup = null
    if (existed) {
      wouldBackup = join(resolve(backupDir), `${sessionId}.<timestamp>`)
    }
    return {
      written: [],
      skipped: [],
      backupPath: wouldBackup,
      sessionDir,
      logFile,
      sessionLockPath: join(sessionDir, LOCK_FILENAME),
      wouldWrite: logFile,
      wouldOverwrite: existed,
      sessionId,
      // dry-run 不编码，所以没有内容指纹；用逻辑指纹表达「内容会是什么」
      contentHash: null,
      logicalFingerprint: previewLogicalFingerprint(header, events),
      eventCount: events.length,
      // 预演时把「这个会话现在能不能写」也报出来 —— 这正是 dry-run 的价值
      live: liveness.live,
      liveChecked: liveness.checked,
      liveReason: liveness.reason ?? null,
      dryRun: true,
    }
  }

  const bytes = encodeSessionLog(header, events, { cwdOverride, frameEncoder: options.frameEncoder })
  const contentHash = createHash('sha256').update(bytes).digest('hex')

  // ── 快照：已存在就必须先备份，且验证备份可读 ──
  let backupPath = null
  if (existed) {
    backupPath = await snapshotSessionDir(sessionDir, backupDir, sessionId)
  }

  // ── 创建会话目录 + 锁文件占位 ──
  //
  // 必须创建空的 `session.lock`，让目录结构与真实 DSH 会话完全一致。
  //
  // 为什么重要：`isSessionLive()` 的第一步是「没有 lock 文件 → 不可能有活跃
  // 写入者 → 直接判 not-live」。如果我们写出的会话没有 lock，那么之后对它
  // 的 LIVE 检测**永远短路成「不 live」**，于是用户正在 DSH 里使用它时，
  // 我们仍会往里写 —— 正是 LIVE 检测要防的 DSH 内存态不一致。
  //
  // DSH 侧确认（从 shipped asar 的 `dsh-session-persistence-jsonl` 读到的
  // `SessionWriteLease.acquire`）：它先 `mkdir(dir, {recursive:true})` 再
  // `open(lockPath, 'w')`，而 `open(id,'write')` 分支**无条件**调用
  // `acquireLease()`。所以 DSH 打开任意已有会话时都会把 lock 建出来。
  // 这意味着盲区只持续到用户首次打开 —— 但我们不该依赖对方补建。
  //
  // 注意：**只创建文件，不加锁**。锁是 DSH 运行时的职责；我们抢锁会挡住
  // 真正的写入者（这个判断在 isSessionLive 的注释里也写过）。
  // 顺序上放在写日志之前：即使随后崩溃，目录结构也是合法的。
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, LOCK_FILENAME), '')

  // ── 写临时文件 → 校验 → 原子重命名 ──
  const tmpFile = join(sessionDir, `.session-${process.pid}-${Date.now()}.tmp`)
  try {
    await writeFile(tmpFile, bytes)

    // 校验：**直接解刚写的临时文件**，不是读会话目录。
    //
    // 这里曾经写成读 sessionDir 是个真 bug：覆盖已有会话时，目录里躺着的
    // 是**旧**日志，于是校验通过的是旧内容、新内容从未被验证就被 rename
    // 顶上去了。校验的对象必须是我们写出的那串字节本身。
    const tmpRaw = await readFile(tmpFile)
    const { plaintext: tmpPlain } = decodeLogBuffer(tmpRaw, options)
    const readBack = parseSessionLog(tmpPlain)
    if (readBack.header.id !== sessionId) {
      throw new SyncError(
        ERROR_CODES.CORRUPT_SESSION,
        `写入校验失败：临时文件里的会话 id 是 ${readBack.header.id}，期望 ${sessionId}。`
      )
    }
    if (readBack.nextSeq !== events.length) {
      throw new SyncError(
        ERROR_CODES.CORRUPT_SESSION,
        `写入校验失败：期望 ${events.length} 个事件，读回 ${readBack.nextSeq} 个。`
      )
    }

    await rename(tmpFile, logFile)
  } finally {
    // 无论成败都不要留下临时文件
    await rm(tmpFile, { force: true })
  }

  // ── 写入后回读验证 ──
  // 结构自检：目录里必须有 lock 文件，否则后续 LIVE 检测会永久失效。
  if (!(await pathExists(join(sessionDir, LOCK_FILENAME)))) {
    throw new SyncError(
      ERROR_CODES.CORRUPT_SESSION,
      `写入后的会话目录缺少 ${LOCK_FILENAME}，结构与真实 DSH 会话不一致。`,
      { hint: '这会让后续的「会话是否正在使用」检测失效，属于内部错误。' }
    )
  }

  const verified = await readSessionDir(sessionDir, { frameDecoder: options.frameDecoder })
  if (verified.id !== sessionId) {
    throw new SyncError(
      ERROR_CODES.CORRUPT_SESSION,
      `写入后校验失败：读回的会话 id 是 ${verified.id}，期望 ${sessionId}。`
    )
  }

  return {
    written: [logFile],
    skipped: [],
    backupPath,
    sessionId,
    // 结构化位置信息：回滚、附件写入、以及「这个会话会不会被 DSH 收录」
    // 的判断都需要这些路径。显式返回，避免调用方用 dirname(written[0])
    // 这种脆弱推算（written 将来可能变成多文件）。
    sessionDir,
    logFile,
    sessionLockPath: join(sessionDir, LOCK_FILENAME),
    contentHash,
    eventCount: events.length,
    dryRun: false,
  }
}

/**
 * 把一个会话的**增量**事件追加到已有日志末尾。
 *
 * ## 为什么必须支持追加而不是整文件重写
 *
 * 这是设计里的红线，三条理由：
 *
 *   1. **append-only 是 DSH 的契约**。官方 `append` 要求「首批 seq 必须等于
 *      已存的 next-seq，gap 直接拒绝」。我们照做就等于复用了 DSH 自己的
 *      不变量校验。
 *   2. **崩溃安全**。整文件重写在写一半时崩溃会丢掉整个会话；追加最坏只丢
 *      半帧，而半帧本来就是 DSH 认识的 torn tail，读取时会自动丢弃。
 *   3. **效率**。10MB 的会话每次同步都重写一遍是不可接受的。
 *
 * ## 实现要点
 *
 *   - 新事件先编码成**独立的 zstd 帧**，然后整体追加到文件末尾。
 *     DSH 的文件格式就是「帧拼接」，所以追加帧 == 追加新的一批事件，
 *     与 DSH 自己落盘的方式完全一致。
 *   - 追加前校验 `firstSeq === 本机 nextSeq`，不相等就拒绝（gap 或重放）。
 *   - 追加后 `fsync`，确保落盘后才报成功。
 *   - 追加后回读验证：事件数必须等于追加后的期望值。
 *
 * ## 与 torn tail 的关系
 *
 * 如果现有文件末尾有半帧（上次崩溃留下的），**追加前必须先把它截掉**，
 * 否则新帧会接在半个帧后面，整个文件变成无法解码的垃圾。
 * 这里用 `scanZstdFrames` 找到最后一个完整帧的末尾作为安全追加位置。
 *
 * @param {object} payload `{sessionId, header, events}` —— events 是**要追加的新事件**
 * @param {{sessionsRoot: string, backupDir: string, cwdOverride?: string,
 *          lockProbeRunner?: Function, skipLiveCheck?: boolean, dryRun?: boolean}} options
 * @returns {Promise<{appended: number, appendedBytes: number, backupPath: string|null,
 *                    sessionId: string, sessionDir: string, nextSeq: number,
 *                    truncatedTailBytes: number, dryRun: boolean}>}
 */
export async function appendToSession(payload, options) {
  const { sessionsRoot, backupDir, cwdOverride, dryRun = false } = options ?? {}
  if (typeof sessionsRoot !== 'string' || sessionsRoot === '') {
    throw new SyncError(ERROR_CODES.BAD_REQUEST, 'appendToSession 需要 sessionsRoot。')
  }
  if (typeof backupDir !== 'string' || backupDir === '') {
    throw new SyncError(ERROR_CODES.BACKUP_FAILED, 'appendToSession 需要 backupDir —— 无备份不写入。', {
      hint: '追加前同样会备份，以便回滚。',
    })
  }

  const sessionId = assertSafeSessionId(payload?.sessionId, '待追加 sessionId')
  assertNotCredentialPath(sessionsRoot)
  assertNotCredentialPath(backupDir)

  const header = payload?.header
  const newEvents = payload?.events
  if (!Array.isArray(newEvents) || newEvents.length === 0) {
    throw new SyncError(ERROR_CODES.BAD_REQUEST, `会话 ${sessionId} 没有要追加的事件。`)
  }

  const effectiveCwd =
    typeof cwdOverride === 'string' && cwdOverride !== '' ? cwdOverride : header?.cwd
  if (typeof effectiveCwd !== 'string' || effectiveCwd === '') {
    throw new SyncError(ERROR_CODES.CORRUPT_SESSION, `会话 ${sessionId} 没有 cwd，无法定位。`)
  }

  // 定位已有的会话目录。
  //
  // ⚠️ 关键：**必须用 `header.cwd` 定位，不能用 `cwdOverride`**。
  //
  // `cwdOverride` 的含义是「要把 header 里的 cwd 重写成什么」，用于跨机下行
  // 纠正路径；而追加的前提是「这个会话本机已经有了」，它落在哪里由**它自己
  // header 里记录的 cwd** 决定。
  //
  // 两者在软链路径下会算出不同的 projectKey。macOS 上实测：
  //   header.cwd  = /tmp/x         → --tmp-x--
  //   cwdOverride = /private/tmp/x → --private-tmp-x--
  // 用 cwdOverride 定位就会找不到本该追加的会话并报 repo-path-missing。
  // 这不只是测试环境的怪癖：用户把仓库放在任何软链路径下都会中招。
  const locateCwd =
    typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : effectiveCwd

  // 用候选写法逐个探测真实位置。
  //
  // 为什么不能直接 `projectKey(locateCwd)`：macOS 上 /var 与 /private/var
  // 是同一目录的两种写法，`projectKey` 会给出两个不同的目录名。如果本机会话
  // 当初是按另一种写法落盘的，直接算就会找不到它 —— 表现是「会话不存在，
  // 无法追加」，而实际上是同一个会话。
  //
  // 写入仍然只用一个 key（与 DSH 逐字符一致），只有**查找**才试多种写法。
  const candidates = await findSessionDirsByCwd(
    sessionsRoot,
    sessionId,
    locateCwd,
    { cwdCandidates: options.cwdCandidates },
  )
  if (candidates.length === 0) {
    const dir = join(resolve(sessionsRoot), projectKey(locateCwd), encodeSegment(sessionId))
    assertInside(resolve(sessionsRoot), dir)
    if (!(await pathExists(join(dir, currentLogFilename(true))))) {
    throw new SyncError(
      ERROR_CODES.REPO_PATH_MISSING,
        `会话 ${sessionId} 在本机不存在，无法追加；应改用 writeSession 整体写入。`,
        { hint: '这通常意味着引擎的增量判定与本机状态不一致。' }
      )
    }
  }

  const dir = candidates.length > 0
    ? candidates[0]
    : join(resolve(sessionsRoot), projectKey(locateCwd), encodeSegment(sessionId))
  const logFile = join(dir, currentLogFilename(true))

  // ── LIVE 检查：绝不给运行中的会话追加 ──
  if (options.skipLiveCheck !== true) {
    const liveness = await isSessionLive(dir, { execFile: options.lockProbeRunner })
    if (liveness.live) {
      if (dryRun) {
        return {
          appended: 0,
          appendedBytes: 0,
          backupPath: null,
          sessionId,
          sessionDir: dir,
          nextSeq: null,
          truncatedTailBytes: 0,
          live: true,
          liveReason: liveness.reason ?? null,
          dryRun: true,
        }
      }
      throw new SyncError(
        ERROR_CODES.BUSY,
        `会话 ${sessionId} 正在使用中，已跳过追加以免破坏 DSH 的内存状态。`,
        {
          hint: '请先在 DSH 里结束或关闭该会话，再重新同步。',
          detail: { method: liveness.method, reason: liveness.reason },
        }
      )
    }
  }

  // ── 读现有文件，确定安全追加位置与本机 nextSeq ──
  const existing = await readSessionDir(dir, { frameDecoder: options.frameDecoder })
  if (existing.id !== sessionId) {
    throw new SyncError(
      ERROR_CODES.CORRUPT_SESSION,
      `磁盘上的会话 id（${existing.id}）与要追加的 ${sessionId} 不一致。`
    )
  }

  const firstSeq = newEvents[0]?.seq
  if (firstSeq !== existing.nextSeq) {
    throw new SyncError(
      ERROR_CODES.CONFLICT_SESSION,
      `追加起点不对：本机 nextSeq=${existing.nextSeq}，要追加的首个 seq=${firstSeq}。`,
      {
        hint:
          firstSeq > existing.nextSeq
            ? '远端缺少中间事件，包不完整；请重新上行完整包。'
            : '这些事件本机已经有了，可能重复同步。',
        detail: { localNextSeq: existing.nextSeq, incomingFirstSeq: firstSeq },
      }
    )
  }
  // 追加的 seq 自身也必须连续
  for (let i = 0; i < newEvents.length; i++) {
    if (newEvents[i]?.seq !== firstSeq + i) {
      throw new SyncError(
        ERROR_CODES.CORRUPT_SESSION,
        `追加事件 seq 不连续：第 ${i} 个期望 ${firstSeq + i}，实际 ${newEvents[i]?.seq}。`
      )
    }
  }

  const raw = await readFile(logFile)
  const { frames, tornStart } = scanZstdFrames(raw)
  const safeAppendAt = frames.length > 0 ? frames[frames.length - 1].end : 0
  const truncatedTailBytes = raw.length - safeAppendAt

  // ── 编码新帧 ──
  const encodeFrame = options.frameEncoder ?? defaultFrameEncoder
  const appendedFrames = newEvents.map((event) =>
    encodeFrame(Buffer.from(JSON.stringify(event) + '\n', 'utf8'))
  )
  const appendedBytes = Buffer.concat(appendedFrames)

  if (dryRun) {
    return {
      appended: newEvents.length,
      appendedBytes: appendedBytes.length,
      backupPath: null,
      sessionId,
      sessionDir: dir,
      nextSeq: existing.nextSeq + newEvents.length,
      truncatedTailBytes,
      wouldWrite: logFile,
      dryRun: true,
    }
  }

  // ── 备份（追加同样要能回滚）──
  const backupPath = await snapshotSessionDir(dir, backupDir, sessionId)

  // 补齐 lock 文件：老版本写出的会话（或异常情况）可能没有它。
  // 缺 lock 会让后续 LIVE 检测永久失效，所以这里顺手修复目录结构。
  const lockPath = join(dir, LOCK_FILENAME)
  if (!(await pathExists(lockPath))) {
    await writeFile(lockPath, '')
    options.log?.warn?.('session.append.created-missing-lock', { sessionId })
  }

  // ── 追加：截掉 torn tail → 写新帧 → fsync ──
  const handle = await open(logFile, 'r+')
  try {
    if (truncatedTailBytes > 0) {
      // 上次崩溃留下的半帧必须先去掉，否则新帧接在半帧后面会让整个文件报废
      await handle.truncate(safeAppendAt)
    }
    await handle.write(appendedBytes, 0, appendedBytes.length, safeAppendAt)
    // 落盘后才算成功：append 的语义是「返回即持久」
    await handle.sync()
  } finally {
    await handle.close()
  }

  // ── 回读验证 ──
  const verified = await readSessionDir(dir, { frameDecoder: options.frameDecoder })
  const expected = existing.nextSeq + newEvents.length
  if (verified.nextSeq !== expected) {
    throw new SyncError(
      ERROR_CODES.CORRUPT_SESSION,
      `追加后校验失败：期望 ${expected} 个事件，读回 ${verified.nextSeq} 个。`,
      { hint: `原文件已备份到 ${backupPath}，可据此恢复。` }
    )
  }

  return {
    appended: newEvents.length,
    appendedBytes: appendedBytes.length,
    backupPath,
    sessionId,
    sessionDir: dir,
    logFile,
    sessionLockPath: join(dir, LOCK_FILENAME),
    nextSeq: verified.nextSeq,
    truncatedTailBytes,
    dryRun: false,
  }
}

/**
 * 从备份还原一个会话目录到备份时的状态。
 *
 * ## 为什么需要「还原」而不只是「不删」
 *
 * `appendToSession` 成功写入了字节，但后续步骤（比如 workspace registry 登记）
 * 失败时，磁盘状态会停在「多出 N 条事件」而 DSH 只看到旧的那部分 ——
 * 数据没丢，但**状态不一致**，用户下次打开会看到一半的对话。
 *
 * 对一个**已存在**的会话，正确做法不是删掉它（那会丢掉用户全部历史），
 * 而是把它还原到本次操作之前的样子。备份就是为此存在的。
 *
 * ## 安全边界
 *
 *   - 备份目录必须真的存在且**在 backupDir 之内**（防越界写入）
 *   - 还原前先把「当前状态」另存一份 —— 还原本身也可能出错，
 *     不能让一次失败的还原把唯一剩下的一致状态也毁掉
 *   - 还原后回读验证：事件数必须等于备份时的事件数
 *
 * @param {object} input
 * @param {string} input.sessionDir 要还原的会话目录
 * @param {string} input.backupPath 备份目录（由 writeSession/appendToSession 返回）
 * @param {string} input.backupDir 备份根目录（用于校验 backupPath 在范围内 + 存还原前快照）
 * @param {string} input.sessionId 会话 id（日志与校验用）
 * @param {Function} [input.frameDecoder] 测试注入
 * @returns {Promise<{restored: boolean, sessionId: string, sessionDir: string,
 *                    eventsBefore: number|null, eventsAfter: number,
 *                    safetySnapshot: string|null}>}
 * @throws {SyncError} 备份不存在、越界或还原后校验失败
 */
export async function restoreSessionFromBackup(input) {
  const { sessionDir, backupPath, backupDir, sessionId } = input ?? {}
  const log = input?.log

  if (typeof sessionDir !== 'string' || sessionDir === '') {
    throw new SyncError(ERROR_CODES.BAD_REQUEST, 'restoreSessionFromBackup 需要 sessionDir。')
  }
  if (typeof backupPath !== 'string' || backupPath === '') {
    throw new SyncError(
      ERROR_CODES.BACKUP_FAILED,
      `会话 ${sessionId ?? '?'} 没有可用的备份路径，无法还原。`,
      { hint: '没有备份就不能安全还原；请人工检查该会话目录。' }
    )
  }
  if (typeof backupDir !== 'string' || backupDir === '') {
    throw new SyncError(ERROR_CODES.BAD_REQUEST, 'restoreSessionFromBackup 需要 backupDir。')
  }

  const target = resolve(sessionDir)
  const source = resolve(backupPath)
  const backupRoot = resolve(backupDir)

  // 备份目录必须真的在 backupDir 之内 —— 防调用方传错路径把别处的东西搬进来
  if (!isInside(backupRoot, source)) {
    throw new SyncError(
      ERROR_CODES.PATH_UNSAFE,
      `备份路径不在备份根目录内，拒绝还原：${backupPath}`
    )
  }

  const sourceExists = await pathExists(source)
  if (!sourceExists) {
    throw new SyncError(
      ERROR_CODES.BACKUP_FAILED,
      `备份目录不存在，无法还原会话 ${sessionId ?? '?'}：${backupPath}`,
      { hint: '请人工检查该会话目录；不要删除它，里面可能有用户历史。' }
    )
  }

  // 记录还原前的事件数，便于调用方判断「确实回退了」
  let eventsBefore = null
  try {
    const current = await readSessionDir(target, { frameDecoder: input?.frameDecoder })
    eventsBefore = current.nextSeq
  } catch {
    // 目标不可读（可能已被删/损坏）—— 还原仍然有意义
    eventsBefore = null
  }

  // 还原本身也可能失败，所以先把当前状态另存一份，别把仅剩的一致状态也毁掉
  let safetySnapshot = null
  if (await pathExists(target)) {
    try {
      safetySnapshot = await snapshotSessionDir(
        target,
        backupRoot,
        `${assertSafeSessionId(sessionId ?? path.basename(target), 'sessionId')}.pre-restore`
      )
    } catch (error) {
      log?.warn?.('session.restore.safety-snapshot-failed', {
        sessionId,
        message: error?.message ?? String(error),
      })
    }
  }

  // 用备份覆盖目标：先删再复制整目录（备份里可能有多代日志文件）
  const entries = await readdir(source, { withFileTypes: true })
  await mkdir(target, { recursive: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const from = join(source, entry.name)
    const to = join(target, assertSafeSegment(entry.name, '备份文件名'))
    await writeFile(to, await readFile(from))
  }

  // 回读验证：必须能解析，且事件数与备份一致
  const verified = await readSessionDir(target, { frameDecoder: input?.frameDecoder })
  const expected = await readSessionDir(source, { frameDecoder: input?.frameDecoder }).then(
    (r) => r.nextSeq,
    () => null
  )
  if (expected !== null && verified.nextSeq !== expected) {
    throw new SyncError(
      ERROR_CODES.BACKUP_FAILED,
      `还原后校验失败：备份里有 ${expected} 个事件，还原后读到 ${verified.nextSeq} 个。`,
      { hint: `还原前的状态已另存到 ${safetySnapshot ?? '（未能保存）'}。` }
    )
  }

  log?.info?.('session.restored', {
    sessionId,
    eventsBefore,
    eventsAfter: verified.nextSeq,
    backupPath,
  })

  return {
    restored: true,
    sessionId: sessionId ?? verified.id,
    sessionDir: target,
    eventsBefore,
    eventsAfter: verified.nextSeq,
    safetySnapshot,
  }
}

/**
 * 把整个会话目录复制到备份区，并**回读验证**备份真的可读。
 *
 * 「命令返回 0」不等于「备份可用」—— 磁盘满、权限、部分写入都可能让
 * 一个看起来成功的复制其实是坏的。所以这里逐文件读一遍并比对大小。
 *
 * @param {string} sessionDir 源会话目录
 * @param {string} backupDir 备份根目录
 * @param {string} sessionId 会话 id（用于命名备份子目录）
 * @returns {Promise<string>} 备份目录路径
 * @throws {SyncError} 备份失败（调用方必须中止写入）
 */
export async function snapshotSessionDir(sessionDir, backupDir, sessionId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeId = assertSafeSessionId(sessionId, '备份 sessionId')
  const targetRoot = join(resolve(backupDir), `${safeId}.${stamp}`)
  assertInside(resolve(backupDir), targetRoot)

  try {
    await mkdir(targetRoot, { recursive: true })

    const entries = await readdir(resolve(sessionDir), { withFileTypes: true })
    const copied = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const source = join(resolve(sessionDir), entry.name)
      const destination = join(targetRoot, entry.name)
      const bytes = await readFile(source)
      await writeFile(destination, bytes)
      // 回读验证：备份必须能原样读回同样字节
      const back = await readFile(destination)
      if (Buffer.compare(back, bytes) !== 0 || back.length !== bytes.length) {
        throw new Error(`备份校验失败：${entry.name} 读回内容不一致`)
      }
      copied.push(entry.name)
    }

    if (copied.length === 0) {
      throw new Error('源会话目录里没有可备份的文件')
    }

    return targetRoot
  } catch (cause) {
    // 备份失败必须中止——绝不「备份失败但继续写」
    throw new SyncError(
      ERROR_CODES.BACKUP_FAILED,
      `无法备份会话 ${sessionId}，已中止写入以保护本机数据。`,
      {
        hint: '请检查磁盘空间与目录权限后重试。',
        cause,
        detail: { sessionDir, backupDir },
      }
    )
  }
}

/**
 * dry-run 用的**预览指纹**：不编码、不压缩，只对逻辑内容做稳定摘要。
 *
 * 刻意与 `conflict.js` 的 `logicalFingerprint` 用同一套思路（排除 cwd、
 * 键序无关），但**不 import 它** —— 那会造成 session-store → conflict 的
 * 循环依赖，而且这两个概念将来可能独立演进（一个是预览、一个参与判重）。
 * 需要在判重时一律用 `conflict.js` 的实现。
 *
 * @param {object} header
 * @param {object[]} events
 * @returns {string}
 */
function previewLogicalFingerprint(header, events) {
  const { cwd, ...stableHeader } = header ?? {}
  const normalized = events.map((event) => ({
    type: event?.type ?? null,
    seq: event?.seq ?? null,
    data: event?.data ?? null,
  }))
  return createHash('sha256')
    .update(JSON.stringify({ header: stableHeader, events: normalized }))
    .digest('hex')
}

/**
 * 把便捷形态的调用参数展开成标准的 `{sessionId, header, events}` 载荷。
 *
 * 生成的是**合成会话**：`rounds` 轮，每轮一对 user/assistant 事件，seq 连续。
 * 只用于测试与工具脚本快速造数，不参与产品链路。
 *
 * @param {object} input
 * @returns {object}
 */
function materializeConveniencePayload(input) {
  const sessionId = input.sessionId
  const cwd = input.cwd
  const rounds = Number.isSafeInteger(input.rounds) && input.rounds > 0 ? input.rounds : 1
  const events = []
  for (let r = 0; r < rounds; r++) {
    events.push({
      type: 'user/message',
      seq: events.length,
      time: 1_700_000_000_000 + events.length * 1000,
      data: { content: [{ type: 'text', text: `synthetic user round ${r}` }] },
    })
    events.push({
      type: 'assistant/message',
      seq: events.length,
      time: 1_700_000_000_000 + events.length * 1000,
      data: { text: `synthetic assistant round ${r}` },
    })
  }
  return {
    sessionId,
    dshHome: input.dshHome,
    lockProbeRunner: input.lockProbeRunner,
    dryRun: input.dryRun,
    skipLiveCheck: input.skipLiveCheck,
    header: {
      type: 'session',
      version: 4,
      id: sessionId,
      createdAt: 1_700_000_000_000,
      cwd,
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'cordis',
    },
    events,
  }
}

/** 路径是否存在（不区分文件/目录）。 */
async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

// ─────────────────────────────────────────────────────────────
// 引擎接口（deps.js 期望的 SessionSource）
// ─────────────────────────────────────────────────────────────

/**
 * 构造 `engine.js` 期望的 `SessionSource`，形状：
 * `{ list, read, write }`。
 *
 * 这一层是**适配器**：把本模块那些细粒度的函数，映射成引擎要的三个动作。
 * 保持适配器很薄，是为了让引擎不直接依赖本模块的内部结构。
 *
 * @param {{store?: object, paths?: object, log?: object}} [context]
 * @returns {{list: Function, read: Function, write: Function}}
 */
export function createSessionSource(context = {}) {
  const log = context.log ?? { info() {}, warn() {}, error() {} }
  const resolvedPaths = context.paths ?? null

  const rootOf = (options) => {
    if (typeof options?.sessionsRoot === 'string') return options.sessionsRoot
    const dshHome = resolvedPaths?.dshHome
    if (typeof dshHome === 'string' && dshHome !== '') return sessionsRoot(dshHome)
    return sessionsRoot(undefined, { env: options?.env })
  }

  return {
    /**
     * 列出某仓库的会话（只读 header，不解全事件）。
     *
     * @param {object} binding 仓库绑定
     * @param {{sessionsRoot?: string, env?: object, includeArchived?: boolean, frameDecoder?: Function, signal?: AbortSignal}} [options]
     * @returns {Promise<Array<object>>}
     */
    async list(binding, options = {}) {
      const repoPath = binding?.repoPath
      if (typeof repoPath !== 'string' || repoPath === '') {
        throw new SyncError(ERROR_CODES.NOT_CONFIGURED, '仓库绑定缺少本地路径。')
      }
      const root = rootOf(options)
      const sessions = await findSessionsForRepo(repoPath, {
        root,
        frameDecoder: options.frameDecoder,
        signal: options.signal,
      })

      return sessions.map((record) => ({
        sessionId: record.id,
        repoId: binding.repoId ?? null,
        // 精确事件数要用 read()；list() 只做轻量扫描，给的是帧数派生的上界。
        // 引擎在真正传输前会 read() 拿到精确值，所以这里不会误导决策。
        eventCount: record.nextSeq ?? record.estimatedEventCount ?? 0,
        bytes: record.logBytes ?? 0,
        updatedAt: record.updatedAt ?? record.header?.createdAt ?? 0,
        cwd: record.header?.cwd,
        // 水位线是异构的：物理层给字节，逻辑层给 seq。这里给 seq（权威层），
        // 字节位置由 push 时的切片现场计算，避免状态文件里存易失效的偏移。
        // 水位线只在**精确知道 nextSeq** 时才给出（即走完整解析的路径）。
        // list() 只扫 header，帧数派生的是上界而非真值，拿它当水位线会让
        // 「已同步到第几条」偏大，从而漏掉事件 —— 那是最危险的失败模式。
        // 所以宁可返回 undefined（调用方据此走全量 read），也不给一个错的数。
        watermark: record.nextSeq === undefined ? undefined : String(record.nextSeq),
        parentSession: record.header?.parentSession ?? null,
        archived: undefined,
      }))
    },

    /**
     * 读一个会话的完整事件流。
     *
     * @param {string} sessionId
     * @param {{sessionsRoot?: string, env?: object, cwd?: string, sessionDir?: string, frameDecoder?: Function, signal?: AbortSignal}} [options]
     * @returns {Promise<object>} SessionPayload 形状
     */
    async read(sessionId, options = {}) {
      const safeId = assertSafeSessionId(sessionId, 'sessionId')
      const root = rootOf(options)

      let dir = options.sessionDir
      if (typeof dir !== 'string' || dir === '') {
        // 没有给目录就必须有 cwd —— 否则无法定位（目录名不可反解）
        if (typeof options.cwd !== 'string' || options.cwd === '') {
          throw new SyncError(
            ERROR_CODES.BAD_REQUEST,
            `读取会话 ${safeId} 需要 cwd 或 sessionDir 才能定位文件。`,
            { hint: 'projectKey 是 lossy 编码，无法从目录名反解出 cwd。' }
          )
        }
        dir = join(resolve(root), projectKey(options.cwd), encodeSegment(safeId))
      }

      const record = await readSessionDir(dir, {
        frameDecoder: options.frameDecoder,
        signal: options.signal,
      })
      if (record.id !== safeId) {
        throw new SyncError(
          ERROR_CODES.CORRUPT_SESSION,
          `磁盘上的会话 id（${record.id}）与请求的 ${safeId} 不一致。`
        )
      }

      return {
        version: 1,
        sessionId: record.id,
        repoKey: options.repoKey ?? null,
        eventCount: record.nextSeq,
        watermark: String(record.nextSeq),
        contentHash: record.contentHash,
        content: undefined,
        header: record.header,
        events: record.events,
        updatedAt: record.header?.createdAt ?? 0,
      }
    },

    /**
     * 写入一个下载下来的会话（带备份与回读验证）。
     *
     * @param {object} payload
     * @param {{backupDir: string, sessionsRoot?: string, env?: object, cwdOverride?: string, dryRun?: boolean}} options
     * @returns {Promise<{written: string[], skipped: string[], backupPath: string|null}>}
     */
    async write(payload, options = {}) {
      const root = rootOf(options)
      const result = await writeSession(payload, {
        sessionsRoot: root,
        backupDir: options.backupDir,
        cwdOverride: options.cwdOverride,
        dryRun: options.dryRun,
        frameEncoder: options.frameEncoder,
        frameDecoder: options.frameDecoder,
      })
      log.info?.('session.write', {
        sessionId: result.sessionId,
        backupPath: result.backupPath,
        dryRun: result.dryRun,
      })
      return result
    },
  }
}


export { NO_CWD_DIR }
