/**
 * `src/session-store.js` 的单元测试 —— 全部使用**合成数据**。
 *
 * 硬约束：本文件**不含任何真实会话数据、真实 UUID、真实家目录路径**。
 * 所有会话都由 `test/fixtures/synth.js` 现场生成到临时目录。
 *
 * 其中最重要的是「防假绿」元测试：naive 的全缓冲 zstd 解压只会解出第一帧
 * 且静默成功，如果解析器写成那样，普通断言照样会绿。所以这里专门断言
 * 「逐帧解压出来的事件数」必须和帧数/行数对得上。
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import zlib from 'node:zlib'

import {
  assertInside,
  assertNotCredentialPath,
  assertSafeSessionId,
  classifyIncoming,
  currentLogFilename,
  decodeFramePureJs,
  decodeLogBuffer,
  decodeSegment,
  encodeSegment,
  findSessionsForRepo,
  measureLog,
  parseSessionLog,
  probeZstd,
  projectKey,
  readSessionDir,
  scanSessions,
  scanZstdFrames,
  sessionBelongsToRepo,
  sessionsRoot,
  sliceByByteWatermark,
  sliceSinceWatermark,
} from '../src/session-store.js'
import {

  encodeFrameRawBlock,
  makeSandbox,
  makeTurn,
  materializeSessions,
  fakeSessionId,
} from './fixtures/synth.js'

const execFileAsync = promisify(execFile)

const FAKE_CWD = '/tmp/dsh-sandbox/synthetic-repo'
const hasNativeZstd = probeZstd().available

/**
 * 读取层选项：无原生 zstd 时注入纯 JS 解码器。
 *
 * 这正好也验证了 `decodeFramePureJs` 作为主路径的可靠性 —— 它不只服务于
 * 低版本 Node，也是原生实现的交叉校验器。
 */
const READ_OPTIONS = hasNativeZstd ? {} : { frameDecoder: decodeFramePureJs }

/** 建一个带 N 轮对话的合成会话规格。 */
function sessionSpec(seed, { turns = 3, cwd = FAKE_CWD, batches } = {}) {
  const id = fakeSessionId(seed)
  const all = []
  for (let i = 0; i < turns; i++) {
    all.push(...makeTurn(i, i * 2))
  }
  // 默认把每一轮单独成帧，模拟真实 DSH 的「一批 append 一帧」
  const grouped = batches ?? all.map((e) => [e])
  return { id, cwd, batches: grouped }
}

test('projectKey 复刻官方实现（含区分性输入）', async (t) => {
  // 官方实现的独立复刻，用于逐字符比对
  const official = (cwd) => {
    let readable = ''
    let separatorRun = false
    for (let i = 0; i < cwd.length; i++) {
      const code = cwd.charCodeAt(i)
      const ch = String.fromCharCode(code)
      if (ch === '/' || ch === '\\' || ch === ':') {
        if (!separatorRun) readable += '-'
        separatorRun = true
      } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
        readable += ch
        separatorRun = false
      } else {
        readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
        separatorRun = false
      }
    }
    return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
  }

  const cases = [
    '/tmp/dsh-sandbox/synthetic-repo',
    '/tmp/my project',
    '/tmp/中文目录',
    '/tmp/a b/c',
    '/tmp/x+y',
    '/tmp/a//b', // 连续分隔符合并
    '/', // 退化到 root
    'C:\\Users\\x', // Windows 盘符
  ]

  for (const cwd of cases) {
    await t.test(`cwd=${JSON.stringify(cwd)}`, () => {
      assert.equal(projectKey(cwd), official(cwd))
    })
  }

  // 关键性质：这是 lossy 映射，所以**绝不能**提供反解函数
  await t.test('不存在反解函数（反解不可能正确）', async () => {
    const mod = await import('../src/session-store.js')
    assert.equal(typeof mod.decodeProjectKey, 'undefined', 'projectKey 是 lossy 的，不得提供反解')
    // 实证 lossy：两个不同 cwd 映射到同一个目录名
    assert.equal(projectKey('/tmp/a/b'), projectKey('/tmp/a//b'))
  })

  await t.test('非 ASCII / 含空格路径不会写成裸路径', () => {
    // 防止有人「简化」成 replaceAll('/','-')：那会在这些路径上写错目录
    assert.ok(!projectKey('/tmp/my project').includes(' '))
    assert.equal(projectKey('/tmp/my project'), '--tmp-my~0020project--')
    assert.equal(projectKey('/tmp/中文目录'), '--tmp-~4E2D~6587~76EE~5F55--')
  })
})

test('encodeSegment / decodeSegment 往返且防穿越', () => {
  const samples = [
    'session-abc',
    'plain',
    '.',
    '..',
    'a/b',
    'a\\b',
    '~x',
    '日本語',
    'a\0b',
  ]
  for (const raw of samples) {
    const encoded = encodeSegment(raw)
    assert.equal(decodeSegment(encoded), raw, `往返失败：${JSON.stringify(raw)}`)
    assert.ok(!encoded.includes('/'), `编码结果不得含 /：${encoded}`)
    assert.ok(!encoded.includes('\\'), `编码结果不得含 \\：${encoded}`)
  }
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
})

test('assertSafeSessionId：白名单校验，不依赖转义假设', () => {
  assert.equal(assertSafeSessionId('session-00000000-0000-4000-8000-000000000001'), 'session-00000000-0000-4000-8000-000000000001')
  // 两种真实形态都要收
  assert.equal(
    assertSafeSessionId('00000000-0000-4000-8000-000000000001'),
    '00000000-0000-4000-8000-000000000001'
  )

  const bad = [
    '../../../etc/passwd',
    '..',
    '.',
    'a/b',
    'a\\b',
    '',
    'x'.repeat(256),
    'has space',
    'has\0nul',
    '中文',
    'with:colon',
    null,
    42,
  ]
  for (const value of bad) {
    assert.throws(
      () => assertSafeSessionId(value),
      (err) => err.name === 'PathEscapeError' || err.name === 'SyncError',
      `应拒绝：${JSON.stringify(value)}`
    )
  }
})

test('scanZstdFrames：精确帧边界，零假阳性', async () => {
  const sandbox = await makeSandbox()
  try {
    const spec = sessionSpec('frames', { turns: 4 })
    const { dirs } = await materializeSessions(sandbox.sessionsRoot, [spec])
    const raw = await readFile(join(dirs[0], currentLogFilename()))

    const { frames, tornStart } = scanZstdFrames(raw)
    assert.equal(tornStart, undefined, '正常文件不应有 torn tail')
    // 1 个 header 帧 + 每个事件 1 帧
    const expectedEvents = spec.batches.length
    assert.equal(frames.length, 1 + expectedEvents)

    // 帧范围必须首尾相接、覆盖全文件
    assert.equal(frames[0].start, 0)
    assert.equal(frames[frames.length - 1].end, raw.length)
    for (let i = 1; i < frames.length; i++) {
      assert.equal(frames[i].start, frames[i - 1].end, '帧之间不应有缝隙')
    }

    // 每帧都必须真能解出内容 —— 证明没有假阳性
    for (const frame of frames) {
      const decoded = decodeLogBuffer(raw.subarray(frame.start, frame.end), READ_OPTIONS)
      assert.ok(decoded.plaintext.length > 0, '每个帧都应解出内容')
    }
  } finally {
    await sandbox.cleanup()
  }
})

test('decodeLogBuffer：逐帧解压，绝不能被 naive 实现骗过', async (t) => {
  if (!hasNativeZstd) {
    await t.test('跳过：当前 Node 无原生 zstd', () => {
      t.diagnostic(`Node ${process.version} 没有 zlib.zstdDecompressSync，相关用例跳过`)
    })
    return
  }

  const sandbox = await makeSandbox()
  try {
    const spec = sessionSpec('multiframe', { turns: 5 })
    const { dirs } = await materializeSessions(sandbox.sessionsRoot, [spec])
    const raw = await readFile(join(dirs[0], currentLogFilename()))

    // ── 防假绿元测试 ──────────────────────────────────────────
    // naive：对整份 buffer 做一次 one-shot 解压，只会得到第一帧
    const naive = zlib.zstdDecompressSync(raw).toString('utf8')
    const naiveLines = naive.split('\n').filter((l) => l.length > 0).length

    // 正确：逐帧解压
    const { plaintext, frames } = decodeLogBuffer(raw, READ_OPTIONS)
    const correctLines = plaintext.split('\n').filter((l) => l.length > 0).length

    assert.equal(naiveLines, 1, 'naive 解压应只有 1 行（这就是它静默丢数据的表现）')
    assert.ok(
      correctLines > naiveLines,
      `逐帧解压的行数(${correctLines})必须严格大于 naive(${naiveLines})，否则说明走了 naive 路径`
    )
    assert.equal(correctLines, 1 + spec.batches.length, '每个事件都应被解出')
    assert.equal(frames, 1 + spec.batches.length)

    // ── 与真实 zstd CLI 交叉校验（有 CLI 时）───────────────────
    await t.test('与 zstd CLI 的行数/字节数一致', async (sub) => {
      let cliOut
      try {
        const { stdout } = await execFileAsync('zstd', ['-d', '-c', join(dirs[0], currentLogFilename())], {
          encoding: 'buffer',
          maxBuffer: 64 * 1024 * 1024,
        })
        cliOut = stdout
      } catch {
        sub.diagnostic('zstd CLI 不可用，跳过交叉校验')
        return
      }
      assert.equal(
        Buffer.compare(cliOut, Buffer.from(plaintext, 'utf8')),
        0,
        '本模块的逐帧解压结果必须与 zstd CLI 逐字节一致'
      )
      const measured = measureLog(raw, READ_OPTIONS)
      assert.equal(measured.plaintextBytes, cliOut.length)
    })
  } finally {
    await sandbox.cleanup()
  }
})

test('decodeFramePureJs 与原生 zstd 结果一致（交叉校验）', async () => {
  // 零依赖构造的 raw-block 帧：两条路径都必须解出同样的内容
  const payload = Buffer.from(
    JSON.stringify({ type: 'session', version: 4, id: 'session-x' }) + '\n',
    'utf8'
  )
  const frame = encodeFrameRawBlock(payload)

  assert.equal(decodeFramePureJs(frame).toString('utf8'), payload.toString('utf8'))

  if (hasNativeZstd) {
    assert.equal(
      zlib.zstdDecompressSync(frame).toString('utf8'),
      payload.toString('utf8'),
      '原生 zstd 也必须认可我们手工构造的帧'
    )
  }

  // 纯 JS 路径遇到压缩块必须明确报错，不能静默返回半截
  if (hasNativeZstd) {
    // 必须用足够长且高度重复的输入：短或随机的内容会被 zstd 存成 raw block，
    // 那样纯 JS 解码器是能解的，测不出「遇到压缩块要报错」这条分支。
    const compressible = Buffer.from(
      Array.from({ length: 2000 }, (_, i) => `{"type":"assistant/message","seq":${i}}`).join('\n'),
      'utf8'
    )
    const compressed = zlib.zstdCompressSync(compressible)
    assert.ok(compressed.length < compressible.length / 2, '该输入应被真正压缩')

    // 先确认它确实是压缩块（否则用例本身就没测到目标分支）
    const blockTypes = []
    {
      const descriptor = compressed.readUInt8(4)
      const contentSizeFlag = descriptor >>> 6
      const singleSegment = (descriptor & 0b0010_0000) !== 0
      const dictionaryFlag = descriptor & 0b11
      const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
      const contentSizeBytes =
        contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
      let off =
        4 + 1 + (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
      for (;;) {
        const bh = compressed.readUIntLE(off, 3)
        off += 3
        const blockType = (bh >>> 1) & 0b11
        blockTypes.push(blockType)
        off += blockType === 1 ? 1 : bh >>> 3
        if (bh & 1) break
      }
    }
    assert.ok(
      blockTypes.includes(2),
      `该帧应含 Compressed_Block，实际块类型 ${JSON.stringify(blockTypes)}`
    )

    assert.throws(
      () => decodeFramePureJs(compressed),
      /Compressed_Block/,
      '纯 JS 解码器遇到压缩块必须报错而不是静默返回'
    )

    // 对照：原生 zstd 必须能正常解开它
    assert.equal(
      zlib.zstdDecompressSync(compressed).toString('utf8'),
      compressible.toString('utf8')
    )
  }
})

test('parseSessionLog：torn tail 丢弃而不是报错', () => {
  const header = JSON.stringify({
    type: 'session',
    version: 4,
    id: 'session-00000000-0000-4000-8000-000000000009',
    createdAt: 1700000000000,
    cwd: FAKE_CWD,
    isSeeded: false,
    delegationDepth: 0,
  })
  const e0 = JSON.stringify({ type: 'user/message', seq: 0, time: 1, data: {} })
  const e1 = JSON.stringify({ type: 'assistant/message', seq: 1, time: 2, data: {} })

  // 正常
  const ok = parseSessionLog([header, e0, e1].join('\n') + '\n')
  assert.equal(ok.nextSeq, 2)
  assert.equal(ok.tornTail, false)

  // 尾部半截（没有换行）→ 丢弃，不抛错
  const torn = parseSessionLog([header, e0, e1].join('\n') + '\n' + '{"type":"user/mess')
  assert.equal(torn.nextSeq, 2)
  assert.equal(torn.tornTail, true)

  // seq 缺口 → 必须报错
  const gap = JSON.stringify({ type: 'assistant/message', seq: 5, time: 3, data: {} })
  assert.throws(
    () => parseSessionLog([header, e0, gap].join('\n') + '\n'),
    /seq 不连续/,
    'seq 缺口必须被检出'
  )

  // header 非法
  assert.throws(() => parseSessionLog('{"type":"not-a-session"}\n'), /header 非法/)
})

test('readSessionDir：真实格式往返 + 单会话损坏不影响整体扫描', async () => {
  const sandbox = await makeSandbox()
  try {
    const good = sessionSpec('good', { turns: 3 })
    const bad = sessionSpec('bad', { turns: 1 })
    await materializeSessions(sandbox.sessionsRoot, [good, bad])

    const okDir = join(sandbox.sessionsRoot, projectKey(good.cwd), encodeSegment(good.id))
    const record = await readSessionDir(okDir, READ_OPTIONS)
    assert.equal(record.id, good.id)
    assert.equal(record.header.cwd, good.cwd)
    assert.equal(record.nextSeq, good.batches.length)
    assert.equal(record.tornTail, false)
    assert.ok(record.contentHash.length === 64)

    // 把一个会话的日志写坏
    const badDir = join(sandbox.sessionsRoot, projectKey(bad.cwd), encodeSegment(bad.id))
    await writeFile(join(badDir, currentLogFilename()), Buffer.from('not a zstd file at all'))

    const all = await scanSessions(sandbox.sessionsRoot, READ_OPTIONS)
    assert.equal(all.length, 2, '两个会话目录都应被扫到')
    const withError = all.filter((r) => r.error !== undefined)
    assert.equal(withError.length, 1, '坏的会话应被标记为 error，而不是让整次扫描失败')
    assert.equal(all.filter((r) => r.error === undefined).length, 1)
  } finally {
    await sandbox.cleanup()
  }
})

test('按仓库筛会话走 header.cwd，不被目录名欺骗', async () => {
  const sandbox = await makeSandbox()
  try {
    const repoA = '/tmp/dsh-sandbox/repo-a'
    const repoB = '/tmp/dsh-sandbox/repo-b'
    const specs = [
      sessionSpec('a1', { turns: 2, cwd: repoA }),
      sessionSpec('a2', { turns: 1, cwd: join(repoA, 'packages', 'sub') }), // 子目录算同仓库
      sessionSpec('b1', { turns: 2, cwd: repoB }),
    ]
    await materializeSessions(sandbox.sessionsRoot, specs)

    // 攻击：把属于 repo-b 的会话搬到 repo-a 的目录下，内容里写的仍是 repo-b
    const bSpec = specs[2]
    const disguisedDir = join(sandbox.sessionsRoot, projectKey(repoA), encodeSegment(bSpec.id))
    await mkdir(disguisedDir, { recursive: true })
    const realDir = join(sandbox.sessionsRoot, projectKey(repoB), encodeSegment(bSpec.id))
    const logBytes = await readFile(join(realDir, currentLogFilename()))
    await writeFile(join(disguisedDir, currentLogFilename()), logBytes)
    await rm(realDir, { recursive: true, force: true })

    const sessionsA = await findSessionsForRepo(repoA, { ...READ_OPTIONS, root: sandbox.sessionsRoot })
    const ids = sessionsA.map((r) => r.id).sort()
    assert.deepEqual(
      ids,
      [specs[0].id, specs[1].id].sort(),
      '必须按 header.cwd 归类：被搬进 repo-a 目录但 cwd 写 repo-b 的会话不能算进 repo-a'
    )
  } finally {
    await sandbox.cleanup()
  }
})

test('sessionBelongsToRepo / normalizeRepoPath', async () => {
  const mk = (cwd) => ({ header: { cwd } })
  assert.equal(sessionBelongsToRepo(mk('/tmp/r'), '/tmp/r'), true)
  assert.equal(sessionBelongsToRepo(mk('/tmp/r/sub'), '/tmp/r'), true)
  assert.equal(sessionBelongsToRepo(mk('/tmp/other'), '/tmp/r'), false)
  // 前缀相似但不同目录不能误判
  assert.equal(sessionBelongsToRepo(mk('/tmp/r2'), '/tmp/r'), false)
  assert.equal(sessionBelongsToRepo(mk(undefined), '/tmp/r'), false)
  assert.equal(sessionBelongsToRepo(mk(''), '/tmp/r'), false)
})

test('水位线分层：seq 逻辑层 + 字节物理层', async () => {
  const sandbox = await makeSandbox()
  try {
    const spec = sessionSpec('watermark', { turns: 4 })
    const { dirs } = await materializeSessions(sandbox.sessionsRoot, [spec])
    const record = await readSessionDir(dirs[0], READ_OPTIONS)
    const raw = await readFile(join(dirs[0], currentLogFilename()))

    // ── 逻辑层 ──
    const none = sliceSinceWatermark(record, 0)
    assert.equal(none.events.length, record.nextSeq)
    assert.equal(none.hasNew, true)

    const partial = sliceSinceWatermark(record, 3)
    assert.equal(partial.events.length, record.nextSeq - 3)
    assert.equal(partial.events[0].seq, 3)

    const upToDate = sliceSinceWatermark(record, record.nextSeq)
    assert.equal(upToDate.hasNew, false)
    assert.equal(upToDate.events.length, 0)

    assert.throws(() => sliceSinceWatermark(record, record.nextSeq + 1), /超过本机会话事件数/)

    // ── 物理层 ──
    // header 帧之后的位置是合法帧边界
    const { frames } = scanZstdFrames(raw)
    const afterHeader = frames[0].end
    const sliced = sliceByByteWatermark(raw, afterHeader)
    assert.equal(sliced.frameAligned, true)
    assert.equal(sliced.byteOffset, raw.length)
    assert.equal(sliced.frameCount, frames.length - 1)

    // 截出来的尾部必须能独立解成一串事件
    const tailDecoded = decodeLogBuffer(sliced.tail, READ_OPTIONS)
    const tailEvents = tailDecoded.plaintext.split('\n').filter((l) => l.length > 0).map(JSON.parse)
    assert.equal(tailEvents.length, spec.batches.length)
    assert.equal(tailEvents[0].seq, 0)

    // 非帧边界 → 必须拒绝
    const misaligned = sliceByByteWatermark(raw, afterHeader + 1)
    assert.equal(misaligned.frameAligned, false)
    assert.match(misaligned.reason, /不在帧边界/)

    // 水位线超过文件长度 → 文件变短了，必须拒绝
    const tooFar = sliceByByteWatermark(raw, raw.length + 100)
    assert.equal(tooFar.frameAligned, false)

    // 已同步到末尾 → 空尾
    const atEnd = sliceByByteWatermark(raw, raw.length)
    assert.equal(atEnd.frameAligned, true)
    assert.equal(atEnd.tail.length, 0)
  } finally {
    await sandbox.cleanup()
  }
})

test('classifyIncoming：相等→append、小于→up-to-date、大于→gap', () => {
  assert.equal(classifyIncoming({ nextSeq: 5 }, { fromSeq: 5, toSeqExclusive: 8 }).action, 'append')
  assert.equal(classifyIncoming({ nextSeq: 5 }, { fromSeq: 0, toSeqExclusive: 5 }).action, 'up-to-date')
  assert.equal(classifyIncoming({ nextSeq: 5 }, { fromSeq: 5, toSeqExclusive: 5 }).action, 'up-to-date')
  assert.equal(classifyIncoming({ nextSeq: 5 }, { fromSeq: 2, toSeqExclusive: 3 }).action, 'up-to-date')
  assert.equal(classifyIncoming({ nextSeq: 5 }, { fromSeq: 7, toSeqExclusive: 9 }).action, 'gap')
  assert.equal(classifyIncoming({ nextSeq: 5 }, { fromSeq: 8, toSeqExclusive: 7 }).action, 'gap')

  // 远端落后于本机：这是正常情形（本机更全），不能报成 gap。
  // 报成 gap 会让 engine 走冲突路径，产生「假冲突」。
  assert.equal(
    classifyIncoming({ nextSeq: 5 }, { fromSeq: 5, toSeqExclusive: 3 }).action,
    'up-to-date',
    '远端比本机少时应为 up-to-date（本机领先），不是 gap'
  )
})

test('安全：路径穿越与凭据路径一律拒绝', async (t) => {
  await t.test('assertInside 拒绝逃逸', () => {
    assert.throws(() => assertInside('/tmp/base', '../etc/passwd'), /路径越界/)
    assert.throws(() => assertInside('/tmp/base', '/etc/passwd'), /路径越界/)
    assert.equal(assertInside('/tmp/base', 'child/x'), '/tmp/base/child/x')
    assert.equal(assertInside('/tmp/base', '/tmp/base/other'), '/tmp/base/other')
  })

  await t.test('扫描时恶意目录名不会逃逸', async () => {
    const sandbox = await makeSandbox()
    try {
      await mkdir(join(sandbox.sessionsRoot, '..', 'evil-target'), { recursive: true })
      // 正常扫描不应抛错，也不应把外面目录当成会话
      const all = await scanSessions(sandbox.sessionsRoot, READ_OPTIONS)
      assert.equal(all.length, 0)
    } finally {
      await sandbox.cleanup()
    }
  })

  await t.test('assertNotCredentialPath 拒绝凭据文件', () => {
    const banned = [
      '/tmp/x/.credentials.yaml',
      '/tmp/x/id_rsa',
      '/tmp/x/id_ed25519',
      '/tmp/x/key.pem',
      '/tmp/x/.env',
      '/tmp/x/known_hosts',
    ]
    for (const p of banned) {
      assert.throws(() => assertNotCredentialPath(p), /拒绝访问/, `应拒绝 ${p}`)
    }
    assert.doesNotThrow(() => assertNotCredentialPath('/tmp/x/session.v4.jsonl.zstd'))
  })
})

test('sessionsRoot 复用 paths.js，且不硬编码家目录', async () => {
  const fakeHome = '/tmp/dsh-sandbox/fake-home'
  const viaEnv = sessionsRoot(undefined, { env: { DSH_HOME: fakeHome } })
  assert.equal(viaEnv, join(fakeHome, 'sessions'))

  const viaHome = sessionsRoot(fakeHome)
  assert.equal(viaHome, join(fakeHome, 'sessions'))

  // 源码里不得出现写死家目录用户名
  const source = await readFile(new URL('../src/session-store.js', import.meta.url), 'utf8')
  assert.ok(
    !/\/Users\/[a-z0-9_.-]+\/(Documents|Github|Work|\.dsh)/i.test(source),
    'session-store.js 不得硬编码本机家目录路径'
  )
})

test('空会话根 / 不存在的根不会抛错', async () => {
  const sandbox = await makeSandbox()
  try {
    assert.deepEqual(await scanSessions(join(sandbox.home, 'nope')), [])
    await mkdir(sandbox.sessionsRoot, { recursive: true })
    assert.deepEqual(await scanSessions(sandbox.sessionsRoot, READ_OPTIONS), [])
  } finally {
    await sandbox.cleanup()
  }
})
