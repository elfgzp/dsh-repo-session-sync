/**
 * 合成会话 fixture 生成器 —— 测试用。
 *
 * 所有内容都是凭空生成的，**不含任何真实会话数据、真实 UUID、真实家目录路径**。
 * 用固定假 UUID + `/tmp/dsh-sandbox/...` 路径，保证可复现、可 diff。
 *
 * 生成的文件格式严格对齐 DSH 的真实物理编码（独立 zstd 帧拼接、XXH64 校验、
 * header 独占首帧、每批 append 一帧），因此可以拿来验证真实读取层。
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

import { encodeSegment, projectKey, probeZstd } from '../../src/session-store.js'

const ZSTD_MAGIC = 0xfd2fb528

/** 生成一个可复现的假 UUID（不是随机，保证测试稳定）。 */
export function fakeUuid(seed) {
  const hash = createHash('sha256').update(`fixture:${seed}`).digest('hex')
  const s = hash.slice(0, 32)
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20, 32)}`
}

/** 合成会话 id（带 session- 前缀，与真实格式一致）。 */
export function fakeSessionId(seed) {
  return `session-${fakeUuid(seed)}`
}

/**
 * 压缩一帧（与 DSH 一致的 checksumFlag=1）。
 *
 * 没有原生 zstd 时降级为**未压缩的合规 raw-block 帧**：文件依然是合法的
 * zstd 帧序列，读取层只要用 `decodeFramePureJs` 就能解，因此 node v20 的 CI
 * 也能跑完整测试。注意这是降级——真实 DSH 文件用的是压缩块。
 *
 * @param {Buffer} input
 * @returns {{frame: Buffer, compressed: boolean}}
 */
function compressFrame(input) {
  const zstd = zlib.zstdCompressSync
  if (typeof zstd !== 'function') {
    return { frame: encodeFrameRawBlockInBlocks(input), compressed: false }
  }
  return {
    frame: zstd(input, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }),
    compressed: true,
  }
}

/**
 * 用 raw block 构造一个（可能多 block 的）合规帧 —— 零依赖。
 *
 * Raw_Block 单块上限 128KB，所以大输入要切块；除最后一块外 lastBlock 位为 0。
 *
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function encodeFrameRawBlockInBlocks(payload) {
  const MAX_BLOCK = 0x20000 // 128KB
  const chunks = []
  const parts = []
  if (payload.length === 0) {
    chunks.push(Buffer.alloc(0))
  } else {
    for (let i = 0; i < payload.length; i += MAX_BLOCK) {
      chunks.push(payload.subarray(i, Math.min(i + MAX_BLOCK, payload.length)))
    }
  }

  // frame header：singleSegment=1, checksum=0, FCS 用 4 字节以容纳任意长度
  const header = Buffer.alloc(4 + 1 + 4)
  header.writeUInt32LE(ZSTD_MAGIC, 0)
  // FCS flag = 0b10 (4 字节)，singleSegment = 1
  header.writeUInt8(0b1010_0000, 4)
  header.writeUInt32LE(payload.length, 5)

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const last = i === chunks.length - 1
    const bh = Buffer.alloc(3)
    bh.writeUIntLE((chunk.length << 3) | (0 << 1) | (last ? 1 : 0), 0, 3)
    parts.push(bh, chunk)
  }
  return Buffer.concat([header, ...parts])
}

/**
 * 零依赖构造一个**合规的 zstd 帧**，用 `Raw_Block`（未压缩块）。
 *
 * 不需要任何 zstd 实现就能生成，且 `zstd -d` / 原生 `zstdDecompressSync` /
 * 本项目的 `decodeFramePureJs` 都能正确解出。CI 与 node v20 环境可用。
 *
 * 帧结构（RFC 8878）：
 *   magic(4) + frameHeaderDescriptor(1) + contentSize(1, singleSegment)
 *   + blockHeader(3) + rawBytes + [checksum(4)]
 *
 * 这里**不写校验和**（checksum 位 = 0），因为无法在无依赖下算出 XXH64；
 * 真实 DSH 文件带校验和，所以测试里两种帧都会被覆盖到。
 *
 * @param {Buffer} payload 明文
 * @returns {Buffer} 完整帧
 */
export function encodeFrameRawBlock(payload) {
  if (payload.length > 0x1fffff - 1) {
    throw new RangeError('Raw_Block 单块上限约 128KB，请分段')
  }
  const descriptor =
    // contentSizeFlag = 0b00，singleSegment = 1，checksum = 0，dict = 0
    0b0010_0000
  const header = Buffer.alloc(4 + 1 + 1)
  header.writeUInt32LE(ZSTD_MAGIC, 0)
  header.writeUInt8(descriptor, 4)
  header.writeUInt8(payload.length, 5) // singleSegment ⇒ 1 字节 contentSize

  const blockHeader = Buffer.alloc(3)
  // lastBlock=1, blockType=0 (Raw), blockSize=payload.length
  blockHeader.writeUIntLE((payload.length << 3) | 0b0000_0001, 0, 3)

  return Buffer.concat([header, blockHeader, payload])
}

/**
 * 把「一批批事件」编码成与 DSH 相同的 zstd 帧拼接布局。
 *
 * @param {object} header header 行对象
 * @param {object[][]} batches 每批事件（一批一帧）
 * @returns {Buffer} 文件字节
 */
export function encodeSessionLog(header, batches) {
  const frames = [compressFrame(Buffer.from(JSON.stringify(header) + '\n', 'utf8')).frame]
  for (const batch of batches) {
    if (batch.length === 0) continue
    const text = batch.map((event) => JSON.stringify(event)).join('\n') + '\n'
    frames.push(compressFrame(Buffer.from(text, 'utf8')).frame)
  }
  return Buffer.concat(frames)
}

/**
 * 构造一串连续 seq 的事件。
 *
 * @param {number} startSeq 起始 seq
 * @param {number} count 事件数
 * @param {(seq: number) => object} [make] 自定义事件体
 * @returns {object[]}
 */
export function makeEvents(startSeq, count, make) {
  const events = []
  for (let i = 0; i < count; i++) {
    const seq = startSeq + i
    events.push(
      make
        ? make(seq)
        : {
            type: 'assistant/message',
            seq,
            time: 1_700_000_000_000 + seq * 1000,
            data: { text: `synthetic message ${seq}` },
          }
    )
  }
  return events
}

/** 轮次助手：造一对 user/assistant 消息（一轮对话）。 */
export function makeTurn(turnIndex, startSeq, { cwd } = {}) {
  const base = startSeq
  const userSeq = base
  const assistantSeq = base + 1
  const events = [
    {
      type: 'user/message',
      seq: userSeq,
      time: 1_700_000_000_000 + userSeq * 1000,
      data: { content: [{ type: 'text', text: `synthetic user turn ${turnIndex}` }] },
    },
    {
      type: 'assistant/message',
      seq: assistantSeq,
      time: 1_700_000_000_000 + assistantSeq * 1000,
      data: { text: `synthetic assistant turn ${turnIndex}` },
    },
  ]
  if (cwd) {
    for (const e of events) e.data.cwd = cwd
  }
  return events
}

/**
 * 单个合成会话的描述。
 *
 * @typedef {object} SessionSpec
 * @property {string} id 会话 id（必须形如 session-<uuid>）
 * @property {string} cwd 会话的工作目录（合成路径）
 * @property {object[][]} batches 事件批次（影响帧布局）
 * @property {object} [headerExtra] 追加到 header 的字段
 * @property {number} [generation] 物理代，默认 4
 * @property {boolean} [raw] 是否写成未压缩的 .jsonl，默认 false
 * @property {Buffer} [corruptBytes] 直接覆盖写到文件末尾的字节（破坏用例）
 */

/**
 * 把一批会话规格写到磁盘上的会话根目录。
 *
 * @param {string} root 会话根目录（会被创建）
 * @param {SessionSpec[]} specs
 * @returns {Promise<{root: string, dirs: string[]}>}
 */
export async function materializeSessions(root, specs) {
  await mkdir(root, { recursive: true })
  const dirs = []

  for (const spec of specs) {
    const generation = spec.generation ?? 4
    const projectDir = spec.cwd ? projectKey(spec.cwd) : '_no-cwd'
    const dir = join(root, projectDir, encodeSegment(spec.id))
    await mkdir(dir, { recursive: true })

    const header = {
      type: 'session',
      version: generation,
      id: spec.id,
      createdAt: 1_700_000_000_000,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'cordis',
      ...(spec.headerExtra ?? {}),
    }

    const filename = `session.v${generation}.jsonl${spec.raw ? '' : '.zstd'}`
    let bytes
    if (spec.raw) {
      const batches = spec.batches.map(
        (b) => b.map((e) => JSON.stringify(e)).join('\n')
      )
      bytes = Buffer.from(
        JSON.stringify(header) + '\n' + (batches.length ? batches.join('\n') + '\n' : ''),
        'utf8'
      )
    } else {
      bytes = encodeSessionLog(header, spec.batches)
    }

    if (spec.corruptBytes) bytes = Buffer.concat([bytes, spec.corruptBytes])
    await writeFile(join(dir, filename), bytes)
    // 真实 DSH 也会留下 lock 文件；造出来让「只挑日志文件」的逻辑被测到
    await writeFile(join(dir, 'session.lock'), '')
    dirs.push(dir)
  }

  return { root, dirs }
}

/**
 * 建一个隔离的临时 DSH_HOME，用完必须 {@link cleanupSandbox}。
 *
 * @returns {Promise<{home: string, sessionsRoot: string, cleanup: () => Promise<void>}>}
 */
export async function makeSandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sync-fixture-'))
  return {
    home,
    sessionsRoot: join(home, 'sessions'),
    cleanup: async () => {
      await rm(home, { recursive: true, force: true })
    },
  }
}

/**
 * fixture 生成永远可用：有 zstd 就产出真实压缩帧，没有就产出合规 raw-block 帧。
 *
 * @returns {{nativeZstd: boolean}} 本次是否使用了真实压缩
 */
export function assertFixtureCapable() {
  return { nativeZstd: probeZstd().available }
}

export { ZSTD_MAGIC }
