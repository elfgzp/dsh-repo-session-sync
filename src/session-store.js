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

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
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
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const ch = String.fromCharCode(cwd.charCodeAt(i))
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
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

  return {
    dir,
    id: header.id,
    header,
    logFile,
    logBytes: raw.length,
    contentHash: createHash('sha256').update(raw).digest('hex'),
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

export { NO_CWD_DIR }
