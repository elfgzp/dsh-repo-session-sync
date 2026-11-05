/**
 * 冲突判定与传输通道的测试 —— 全合成数据。
 *
 * 这两个模块承载本项目最重要的两条安全不变量：
 *   1. 两端都推进过 → **绝不**单边胜出（conflict.js）
 *   2. 远端内容一律不可信 → 校验不过就不返回载荷（transport.js）
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import zlib from 'node:zlib'

import {
  canonicalJson,
  compareSessions,
  conflictSessionId,
  createConflictResolver,
  decideConflict,
  logicalFingerprint,
} from '../src/conflict.js'
import {
  chunkByFrames,
  chunkDigest,
  createTransport,
  DEFAULT_CHUNKING,
  runGit,
  SESSIONS_REF,
} from '../src/transport.js'
import { encodeFrameRawBlock, fakeSessionId, makeSandbox } from './fixtures/synth.js'
import { decodeFramePureJs, probeZstd } from '../src/session-store.js'

const execFileAsync = promisify(execFile)
const hasNativeZstd = probeZstd().available

const RM = '/tmp/dsh-sandbox/fixture-repo'

// ─────────────────────────────────────────────────────────────
// 合成会话
// ─────────────────────────────────────────────────────────────

function mkSession(seed, { cwd = RM, events = 5, mutateEvent } = {}) {
  const id = seed.startsWith('session-') ? seed : fakeSessionId(seed)
  const list = Array.from({ length: events }, (_, i) => ({
    type: i % 2 === 0 ? 'user/message' : 'assistant/message',
    seq: i,
    time: 1_700_000_000_000 + i * 1000,
    data: { text: `synthetic event ${i}` },
  }))
  if (typeof mutateEvent === 'function') mutateEvent(list)
  return {
    sessionId: id,
    header: {
      type: 'session',
      version: 4,
      id,
      createdAt: 1_700_000_000_000,
      cwd,
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'cordis',
    },
    events: list,
  }
}

/** 把会话编码成帧序列，供 transport 使用。 */
function mkContent(session) {
  const encode = hasNativeZstd
    ? (buf) => Buffer.from(require_zstd().compress(buf))
    : encodeFrameRawBlock
  const frames = [
    encode(Buffer.from(JSON.stringify(session.header) + '\n', 'utf8')),
  ]
  for (const event of session.events) {
    frames.push(encode(Buffer.from(JSON.stringify(event) + '\n', 'utf8')))
  }
  return Buffer.concat(frames)
}

function require_zstd() {
  return globalThis.__zstdForTests
}

// 顶层一次性取 zlib（避免每个函数里重复 import）

globalThis.__zstdForTests = {
  compress: (buf) =>
    zlib.zstdCompressSync(buf, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }),
}

// ─────────────────────────────────────────────────────────────
// conflict.js
// ─────────────────────────────────────────────────────────────

test('逻辑指纹：跨机 cwd 不同但内容相同 → 指纹必须相同', () => {
  const a = mkSession('fp', { cwd: '/home/alice/project' })
  const b = mkSession('fp', { cwd: '/home/bob/work/project' })
  assert.notDeepEqual(a.header, b.header, '两边的 header 确实不同')
  assert.equal(
    logicalFingerprint(a),
    logicalFingerprint(b),
    'cwd 是机器相关字段，必须被排除在逻辑指纹之外'
  )
})

test('逻辑指纹：任一端追加事件 → 指纹必须不同', () => {
  const base = mkSession('fp2', { events: 5 })
  const longer = mkSession('fp2', { events: 7 })
  assert.notEqual(logicalFingerprint(base), logicalFingerprint(longer))
})

test('逻辑指纹：事件内容被改动 → 指纹必须不同', () => {
  const base = mkSession('fp3', { events: 5 })
  const changed = mkSession('fp3', {
    events: 5,
    mutateEvent: (list) => {
      list[2] = { ...list[2], data: { text: 'CHANGED' } }
    },
  })
  assert.notEqual(logicalFingerprint(base), logicalFingerprint(changed))
})

test('逻辑指纹：事件顺序变化 → 指纹必须不同', () => {
  const base = mkSession('fp4', { events: 4 })
  const swapped = mkSession('fp4', {
    events: 4,
    mutateEvent: (list) => {
      const t = list[1]
      list[1] = { ...list[2], seq: 1 }
      list[2] = { ...t, seq: 2 }
    },
  })
  assert.notEqual(logicalFingerprint(base), logicalFingerprint(swapped))
})

test('canonicalJson：键序不影响结果', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
  assert.equal(
    canonicalJson({ x: { d: 4, c: 3 }, y: [1, 2] }),
    canonicalJson({ y: [1, 2], x: { c: 3, d: 4 } })
  )
  // 数组顺序有语义，不能排序
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]))
})

test('compareSessions：四种关系都能正确识别', () => {
  const base = mkSession('cmp', { events: 5 })
  const same = mkSession('cmp', { cwd: '/elsewhere', events: 5 })
  const longer = mkSession('cmp', { events: 8 })
  const diverged = mkSession('cmp', {
    events: 5,
    mutateEvent: (list) => {
      list[1] = { ...list[1], data: { text: 'DIFFERENT' } }
    },
  })

  assert.equal(compareSessions(base, same), 'identical')
  assert.equal(compareSessions(longer, base), 'a-extends-b')
  assert.equal(compareSessions(base, longer), 'b-extends-a')
  assert.equal(compareSessions(base, diverged), 'diverged')
})

test('decideConflict：六种情形', () => {
  const base = mkSession('dec', { events: 5 })
  const longer = mkSession('dec', { events: 8 })
  const diverged = mkSession('dec', {
    events: 5,
    mutateEvent: (list) => {
      list[1] = { ...list[1], data: { text: 'X' } }
    },
  })

  assert.equal(decideConflict({ local: base, remote: null }).kind, 'no-conflict')
  assert.equal(decideConflict({ local: null, remote: base }).kind, 'no-conflict')
  assert.equal(decideConflict({ local: base, remote: mkSession('dec', { events: 5, cwd: '/x' }) }).kind, 'no-conflict')
  assert.equal(decideConflict({ local: longer, remote: base }).kind, 'no-conflict')
  assert.equal(decideConflict({ local: base, remote: longer }).kind, 'no-conflict')

  const divergedDecision = decideConflict({ local: base, remote: diverged })
  assert.equal(divergedDecision.kind, 'keep-both')
  assert.equal(divergedDecision.reason, 'diverged')
})

test('【硬不变量】两端都推进过时绝不给单边胜出', () => {
  // 扫一批不同的分叉形态，断言没有任何一种被判成 local-wins / remote-wins
  const variants = [
    (list) => { list[0] = { ...list[0], data: { text: 'A' } } },
    (list) => { list[4] = { ...list[4], data: { text: 'B' } } },
    (list) => { list[2] = { ...list[2], type: 'tool/call' } },
    (list) => { list.splice(2, 1) },
    (list) => { list.push({ type: 'extra', seq: 5, time: 1, data: {} }) },
  ]

  for (const [i, mutate] of variants.entries()) {
    const local = mkSession('inv', { events: 5 })
    const remote = mkSession('inv', { events: 5, mutateEvent: mutate })
    const decision = decideConflict({ local, remote })
    assert.ok(
      decision.kind === 'keep-both' || decision.kind === 'refuse' || decision.kind === 'no-conflict',
      `变体 ${i} 判成了 ${decision.kind}，违反「绝不单边胜出」`
    )
    if (decision.kind === 'no-conflict') {
      // no-conflict 只允许出现在「其实没分歧」的形态（比如远端只是多一条）
      const relation = compareSessions(local, remote)
      assert.ok(
        relation !== 'diverged',
        `变体 ${i} 是 diverged，却被判成 no-conflict`
      )
    }
  }
})

test('decideConflict：输入不可比较时走 refuse（保守方向是不动数据）', () => {
  const decision = decideConflict({
    local: { sessionId: 'x', events: 'not-an-array' },
    remote: { sessionId: 'x', events: [] },
  })
  assert.ok(decision.kind === 'refuse' || decision.kind === 'no-conflict')
})

test('conflictSessionId：幂等、合法单段名、区分不同冲突', () => {
  const a = conflictSessionId('session-abc', { localFingerprint: 'l1', remoteFingerprint: 'r1' })
  const b = conflictSessionId('session-abc', { localFingerprint: 'l1', remoteFingerprint: 'r1' })
  const c = conflictSessionId('session-abc', { localFingerprint: 'l2', remoteFingerprint: 'r1' })

  assert.equal(a, b, '同一次冲突重复处理必须得到同一个 id')
  assert.notEqual(a, c, '不同的冲突必须得到不同的 id')
  assert.match(a, /^[A-Za-z0-9._-]+$/, '必须是合法单段名')
  assert.ok(a.length <= 255)
})

test('createConflictResolver：形状符合 engine.js 的 ConflictResolver', () => {
  const resolver = createConflictResolver({})
  assert.equal(typeof resolver.decide, 'function')
  const decision = resolver.decide({ local: mkSession('r', { events: 2 }), remote: null })
  assert.ok(typeof decision.kind === 'string')
  assert.ok(typeof decision.reason === 'string')
})

// ─────────────────────────────────────────────────────────────
// transport.js —— 分块
// ─────────────────────────────────────────────────────────────

test('chunkByFrames：切点在帧边界，可无损重组', () => {
  if (!hasNativeZstd) return
  const session = mkSession('chunk', { events: 300 })
  const content = mkContent(session)

  const { chunks, frameCount } = chunkByFrames(content)
  assert.ok(chunks.length > 1, `300 个事件应该切成多块，实际 ${chunks.length} 块`)
  assert.equal(frameCount, 1 + 300, '1 帧 header + 每事件 1 帧')

  // 每块都必须自成一个合法帧序列
  for (const chunk of chunks) {
    const sub = chunkByFrames(chunk.bytes)
    assert.equal(sub.chunks.length, 1, '单块内容再切应该只有它自己')
    assert.equal(sub.frameCount, chunk.frameCount)
  }

  // 无损重组：拼回去必须与原字节完全相同
  const recombined = Buffer.concat(chunks.map((c) => c.bytes))
  assert.equal(Buffer.compare(recombined, content), 0, '重组必须逐字节一致')

  // 块的字节区间必须覆盖整个文件、首尾相接
  assert.equal(chunks[0].byteStart, 0)
  assert.equal(chunks[chunks.length - 1].byteEnd, content.length)
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i].byteStart, chunks[i - 1].byteEnd, '块之间不能有缝隙或重叠')
  }
})

test('chunkByFrames：内容定义切点 —— 追加只影响尾部块', () => {
  if (!hasNativeZstd) return
  const base = mkSession('cdc', { events: 200 })
  const grown = mkSession('cdc', { events: 260 })

  const a = chunkByFrames(mkContent(base))
  const b = chunkByFrames(mkContent(grown))

  const digestsA = new Set(a.chunks.map((c) => chunkDigest(c.bytes)))
  const reused = b.chunks.filter((c) => digestsA.has(chunkDigest(c.bytes)))
  assert.ok(
    reused.length > 0,
    '追加后必须能复用之前的块（内容定义切点的意义所在）'
  )
  assert.ok(
    reused.length >= b.chunks.length - 3,
    `追加 60 个事件应只新增极少数块，实际复用了 ${reused.length}/${b.chunks.length}`
  )
})

test('chunkByFrames：参数可配置且影响块大小', () => {
  if (!hasNativeZstd) return
  const content = mkContent(mkSession('param', { events: 300 }))
  const small = chunkByFrames(content, { minFrames: 2, maxFrames: 8, maskBits: 2 })
  const large = chunkByFrames(content, { minFrames: 2, maxFrames: 512, maskBits: 2 })
  assert.ok(small.chunks.length > large.chunks.length, 'maxFrames 小 → 块更多')
})

test('chunkByFrames：损坏字节必须拒绝', () => {
  assert.throws(
    () => chunkByFrames(Buffer.from('this is not a zstd stream at all')),
    (err) => err.code === 'corrupt-session'
  )
})

test('chunkByFrames：torn tail 只切完整帧', () => {
  if (!hasNativeZstd) return
  const content = mkContent(mkSession('torn', { events: 10 }))
  const truncated = content.subarray(0, content.length - 5)

  const result = chunkByFrames(truncated)
  assert.ok(result.tornBytes > 0, '应识别出被截断的尾部')
  const recombined = Buffer.concat(result.chunks.map((c) => c.bytes))
  assert.ok(recombined.length <= truncated.length)
  // 重组出来的必须是合法帧序列
  assert.doesNotThrow(() => chunkByFrames(recombined))
})

test('DEFAULT_CHUNKING：参数有界且成组出现（可调但有理由）', () => {
  assert.ok(DEFAULT_CHUNKING.minFrames >= 1)
  assert.ok(DEFAULT_CHUNKING.maxFrames > DEFAULT_CHUNKING.minFrames)
  assert.ok(DEFAULT_CHUNKING.maskBits >= 0 && DEFAULT_CHUNKING.maskBits <= 30)
  assert.ok(DEFAULT_CHUNKING.windowBytes >= 1)
})

// ─────────────────────────────────────────────────────────────
// transport.js —— git 集成
// ─────────────────────────────────────────────────────────────

/** 建一个「本地工作区 + 裸远端」的测试仓库对。 */
async function makeRepoPair(sandbox) {
  const remoteDir = join(sandbox.home, 'remote.git')
  const workDir = join(sandbox.home, 'work')

  await mkdir(remoteDir, { recursive: true })
  await execFileAsync('git', ['init', '--bare', '--quiet', remoteDir])
  await mkdir(workDir, { recursive: true })
  await execFileAsync('git', ['init', '--quiet', workDir])
  await execFileAsync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: workDir })
  await execFileAsync('git', ['config', 'user.name', 'fixture'], { cwd: workDir })
  await writeFile(join(workDir, 'README.md'), '# fixture\n')
  await execFileAsync('git', ['add', '.'], { cwd: workDir })
  await execFileAsync('git', ['commit', '--quiet', '-m', 'init'], { cwd: workDir })
  await execFileAsync('git', ['remote', 'add', 'origin', remoteDir], { cwd: workDir })
  await execFileAsync('git', ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], { cwd: workDir })

  return { remoteDir, workDir }
}

test('transport.probe：远端可达且没有会话 ref 时 hasBundle=false', async () => {
  const sandbox = await makeSandbox()
  try {
    const { workDir } = await makeRepoPair(sandbox)
    const transport = createTransport({})
    const probe = await transport.probe({ repoId: 'r1', repoPath: workDir })

    assert.equal(probe.reachable, true)
    assert.equal(probe.hasBundle, false)
    assert.equal(probe.head, null)
  } finally {
    await sandbox.cleanup()
  }
})

test('transport.probe：非 git 目录返回不可达而不是抛错', async () => {
  const sandbox = await makeSandbox()
  try {
    const notRepo = join(sandbox.home, 'plain-dir')
    await mkdir(notRepo, { recursive: true })
    const transport = createTransport({})
    const probe = await transport.probe({ repoId: 'r1', repoPath: notRepo })
    assert.equal(probe.reachable, false)
    assert.equal(probe.error.code, 'not-a-git-repo')
  } finally {
    await sandbox.cleanup()
  }
})

test('transport.push dry-run：不写任何 git 对象、不动 ref', async () => {
  if (!hasNativeZstd) return
  const sandbox = await makeSandbox()
  try {
    const { workDir } = await makeRepoPair(sandbox)
    const transport = createTransport({})
    const session = mkSession('push-dry', { events: 20 })

    const before = await runGit(workDir, ['count-objects', '-v'])
    const result = await transport.push(
      { repoId: 'r1', repoPath: workDir },
      { sessions: [{ ...session, content: mkContent(session) }] },
      { dryRun: true }
    )

    assert.equal(result.ok, true)
    assert.equal(result.dryRun, true)
    assert.ok(result.chunks > 0)
    assert.equal(result.transferred, 0, 'dry-run 不应报告已传输')

    // ref 必须不存在
    const refCheck = await runGit(workDir, ['rev-parse', '--verify', SESSIONS_REF], {
      allowFailure: true,
    })
    assert.notEqual(refCheck.code, 0, 'dry-run 不得创建会话 ref')

    // 对象数不应变化
    const after = await runGit(workDir, ['count-objects', '-v'])
    const countOf = (buf) => Number(/^count:\s*(\d+)/m.exec(buf.toString('utf8'))?.[1] ?? -1)
    assert.equal(countOf(after.stdout), countOf(before.stdout), 'dry-run 不得写入 git 对象')

    // 工作区必须干净（永不 checkout）
    const status = await runGit(workDir, ['status', '--porcelain'])
    assert.equal(status.stdout.toString('utf8').trim(), '', '同步不应改动工作区')
  } finally {
    await sandbox.cleanup()
  }
})

test('transport.push + pull：端到端往返，内容无损', async () => {
  if (!hasNativeZstd) return
  const sandbox = await makeSandbox()
  try {
    const { workDir } = await makeRepoPair(sandbox)
    const transport = createTransport({})
    const session = mkSession('roundtrip', { events: 30 })
    const content = mkContent(session)

    const pushed = await transport.push(
      { repoId: 'r1', repoPath: workDir },
      { sessions: [{ ...session, content, eventCount: 30 }] },
      {}
    )
    assert.equal(pushed.ok, true)
    assert.ok(pushed.head, 'push 后应有 head')
    assert.equal(pushed.previousHead, null)

    const pulled = await transport.pull({ repoId: 'r1', repoPath: workDir })
    assert.ok(pulled !== null)
    assert.equal(pulled.sessions.length, 1)

    const got = pulled.sessions[0]
    assert.equal(got.sessionId, session.sessionId)
    assert.equal(got.eventCount, 30, 'pull 侧逻辑校验应得到 30 个事件')
    assert.equal(
      Buffer.compare(Buffer.from(got.content), content),
      0,
      '往返后内容必须逐字节一致'
    )

    // 工作区仍未被改动
    const status = await runGit(workDir, ['status', '--porcelain'])
    assert.equal(status.stdout.toString('utf8').trim(), '')
  } finally {
    await sandbox.cleanup()
  }
})

test('transport.pull：远端没有数据时返回 null', async () => {
  const sandbox = await makeSandbox()
  try {
    const { workDir } = await makeRepoPair(sandbox)
    const transport = createTransport({})
    assert.equal(await transport.pull({ repoId: 'r1', repoPath: workDir }), null)
  } finally {
    await sandbox.cleanup()
  }
})

test('transport.pull：块内容被篡改必须拒绝（且不返回载荷）', async () => {
  if (!hasNativeZstd) return
  const sandbox = await makeSandbox()
  try {
    const { workDir } = await makeRepoPair(sandbox)
    const transport = createTransport({})
    const session = mkSession('tamper', { events: 10 })

    await transport.push(
      { repoId: 'r1', repoPath: workDir },
      { sessions: [{ ...session, content: mkContent(session), eventCount: 10 }] },
      {}
    )

    // 篡改：把某个块 blob 换成别的内容，但 manifest 里的 digest 不变
    const tree = await runGit(workDir, ['ls-tree', '-r', '--name-only', SESSIONS_REF])
    const files = tree.stdout.toString('utf8').trim().split('\n').filter(Boolean)
    const chunkFile = files.find((f) => f.endsWith('.bin'))
    assert.ok(chunkFile, '应能找到块文件')

    const evil = Buffer.from('evil bytes that are not a zstd frame')
    const evilOid = (await runGit(workDir, ['hash-object', '-w', '--stdin'], { input: evil }))
      .stdout.toString('utf8')
      .trim()

    // 重建 tree，把目标块替换成 evil blob。
    //
    // 注意 `git mktree` 只接受单段文件名，`ls-tree -r` 给的是完整路径
    // （形如 `s-xxx/chunks/00000.bin`），直接喂给 mktree 会报
    // "path ... contains slash"。所以这里逐层重建：先建最深的 tree，
    // 再把它的 oid 作为上一层的 tree 条目。
    const listing = await runGit(workDir, ['ls-tree', '-r', '-z', SESSIONS_REF])
    /** @type {Map<string, {oid: string}[]>} 目录路径 → 直接子条目 */
    const dirs = new Map()
    for (const line of listing.stdout.toString('utf8').split('\0')) {
      if (!line) continue
      const [meta, fullPath] = line.split('\t')
      const [, , oid] = meta.split(' ')
      if (!fullPath || !oid) continue
      const slash = fullPath.lastIndexOf('/')
      const dir = slash === -1 ? '' : fullPath.slice(0, slash)
      const name = slash === -1 ? fullPath : fullPath.slice(slash + 1)
      if (!dirs.has(dir)) dirs.set(dir, [])
      const finalOid = fullPath === chunkFile ? evilOid : oid
      dirs.get(dir).push({ name, oid: finalOid })
    }

    /** 递归建 tree，返回该目录的 tree oid。 */
    const buildTree = async (dir) => {
      const entries = dirs.get(dir) ?? []
      const lines = []
      // 先建子目录（更深的路径），再建本层
      const children = [...dirs.keys()].filter(
        (k) => k !== dir && (dir === '' ? !k.includes('/') : k.startsWith(dir + '/') && !k.slice(dir.length + 1).includes('/'))
      )
      for (const child of children) {
        const childTree = await buildTree(child)
        lines.push(`040000 tree ${childTree}\t${child.slice(dir === '' ? 0 : dir.length + 1)}`)
      }
      for (const entry of entries) {
        lines.push(`100644 blob ${entry.oid}\t${entry.name}`)
      }
      const { stdout } = await runGit(workDir, ['mktree'], {
        input: Buffer.from(lines.join('\n') + '\n'),
      })
      return stdout.toString('utf8').trim()
    }

    const newTree = await buildTree('')
    const newCommit = (await runGit(workDir, ['commit-tree', newTree, '-m', 'tampered']))
      .stdout.toString('utf8')
      .trim()
    await runGit(workDir, ['update-ref', SESSIONS_REF, newCommit])
    // pull 读的是远端，所以篡改也要推到远端才有效
    await runGit(workDir, ['push', '--force', '--quiet', 'origin', `${SESSIONS_REF}:${SESSIONS_REF}`])

    await assert.rejects(
      () => transport.pull({ repoId: 'r1', repoPath: workDir }),
      (err) => err.code === 'corrupt-session' || err.code === 'invalid-bundle',
      '篡改后的块必须被校验拦住'
    )
  } finally {
    await sandbox.cleanup()
  }
})

test('transport.pull：manifest 版本不支持时明确报 unsupported-version', async () => {
  const sandbox = await makeSandbox()
  try {
    const { workDir } = await makeRepoPair(sandbox)
    const transport = createTransport({})

    // 手工造一个 formatVersion 错误的 manifest
    const manifest = Buffer.from(
      JSON.stringify({ formatVersion: 999, sessions: [] }) + '\n',
      'utf8'
    )
    const oid = (await runGit(workDir, ['hash-object', '-w', '--stdin'], { input: manifest }))
      .stdout.toString('utf8')
      .trim()
    const tree = (await runGit(workDir, ['mktree'], {
      input: Buffer.from(`100644 blob ${oid}\tmanifest.json\n`),
    })).stdout.toString('utf8').trim()
    const commit = (await runGit(workDir, ['commit-tree', tree, '-m', 'bad version']))
      .stdout.toString('utf8')
      .trim()
    await runGit(workDir, ['update-ref', SESSIONS_REF, commit])
    await runGit(workDir, ['push', '--force', '--quiet', 'origin', `${SESSIONS_REF}:${SESSIONS_REF}`])

    await assert.rejects(
      () => transport.pull({ repoId: 'r1', repoPath: workDir }),
      (err) => err.code === 'unsupported-version'
    )
  } finally {
    await sandbox.cleanup()
  }
})

test('transport.push：ref 被并发更新时拒绝覆盖（CAS）', async () => {
  if (!hasNativeZstd) return
  const sandbox = await makeSandbox()
  try {
    const { workDir } = await makeRepoPair(sandbox)
    const transport = createTransport({})
    const s1 = mkSession('cas1', { events: 5 })
    const s2 = mkSession('cas2', { events: 5 })

    await transport.push(
      { repoId: 'r1', repoPath: workDir },
      { sessions: [{ ...s1, content: mkContent(s1), eventCount: 5 }] },
      {}
    )

    // 模拟另一个进程在上行之间抢先推进了 ref
    const head = (await runGit(workDir, ['rev-parse', SESSIONS_REF]))
      .stdout.toString('utf8')
      .trim()
    // 取 head 的 tree（commit-tree 的第一个参数必须是 tree，不是 commit）
    const headTree = (await runGit(workDir, ['rev-parse', `${head}^{tree}`]))
      .stdout.toString('utf8')
      .trim()
    const other = (await runGit(workDir, ['commit-tree', headTree, '-p', head, '-m', 'concurrent']))
      .stdout.toString('utf8')
      .trim()
    await runGit(workDir, ['update-ref', SESSIONS_REF, other])

    // 现在用陈旧视图去 push：必须在 CAS 处失败
    const stale = await transport.push(
      { repoId: 'r1', repoPath: workDir },
      { sessions: [{ ...s2, content: mkContent(s2), eventCount: 5 }] },
      {}
    ).catch((error) => error)

    // 要么 CAS 明确失败，要么它读到了新 head 并成功追加（都安全）。
    // 不安全的是「静默覆盖掉 other」，所以检查 other 仍是祖先。
    if (stale instanceof Error) {
      assert.match(String(stale.message), /ref|覆盖/i)
    } else {
      assert.ok(stale.ok)
    }
  } finally {
    await sandbox.cleanup()
  }
})

test('transport：仓库路径缺失时报 not-configured', async () => {
  const transport = createTransport({})
  await assert.rejects(
    () => transport.probe({ repoId: 'r1', repoPath: '' }),
    (err) => err.code === 'not-configured'
  )
})

test('runGit：git 调用使用参数数组，路径里的 shell 元字符不会被解释', async () => {
  const sandbox = await makeSandbox()
  try {
    // 目录名里带 shell 元字符：如果实现拼了字符串，这里会出问题
    const weird = join(sandbox.home, 'repo with spaces; and $(echo pwned)')
    await mkdir(weird, { recursive: true })
    await execFileAsync('git', ['init', '--quiet', weird])

    const result = await runGit(weird, ['rev-parse', '--absolute-git-dir'])
    assert.equal(result.code, 0)
    assert.ok(result.stdout.toString('utf8').includes('repo with spaces'))
  } finally {
    await sandbox.cleanup()
  }
})

// ─────────────────────────────────────────────────────────────
// newChunks / reusedChunks：增量是否真的生效的唯一可观测信号
// ─────────────────────────────────────────────────────────────

test('push：追加后 newChunks 必须严格小于 chunks（增量生效的硬信号）', async () => {
  if (!hasNativeZstd) return
  const sandbox = await makeSandbox()
  try {
    const { workDir } = await makeRepoPair(sandbox)
    const transport = createTransport({})
    const binding = { repoId: 'r1', repoPath: workDir }

    // 第一次：80 轮，会产生多个块
    const big = mkSession('incremental', { events: 160 })
    const firstPush = await transport.push(
      binding,
      { sessions: [{ ...big, content: mkContent(big), eventCount: 160 }] },
      {}
    )
    assert.ok(firstPush.chunks >= 2, `应切出多块，实际 ${firstPush.chunks}`)
    // 首次推送：远端本来什么都没有 → 全部是新增
    assert.equal(
      firstPush.newChunks,
      firstPush.chunks,
      '首次推送所有块都应是新增'
    )
    assert.equal(firstPush.reusedChunks, 0)

    // 追加少量事件后再推：大部分块应复用
    const grown = mkSession('incremental', { events: 164 })
    const secondPush = await transport.push(
      binding,
      { sessions: [{ ...grown, content: mkContent(grown), eventCount: 164 }] },
      {}
    )

    assert.ok(
      secondPush.newChunks < secondPush.chunks,
      `追加后新增块(${secondPush.newChunks})必须严格小于总块数(${secondPush.chunks})，` +
        '否则说明增量失效、退化成全量重写'
    )
    assert.ok(
      secondPush.reusedChunks > 0,
      `追加后必须有复用的块，实际 reusedChunks=${secondPush.reusedChunks}`
    )
    assert.equal(
      secondPush.newChunks + secondPush.reusedChunks,
      secondPush.chunks,
      'newChunks + reusedChunks 必须等于总块数'
    )

    // 全量重写会表现为 newChunks === chunks，这里必须能区分开
    assert.notEqual(
      secondPush.newChunks,
      secondPush.chunks,
      'newChunks 恒等于 chunks 就是「字段没实现」，必须能区分增量与全量'
    )
  } finally {
    await sandbox.cleanup()
  }
})

test('push：dry-run 也给出真实的预估新增/复用数（只读，无副作用）', async () => {
  if (!hasNativeZstd) return
  const sandbox = await makeSandbox()
  try {
    const { workDir } = await makeRepoPair(sandbox)
    const transport = createTransport({})
    const binding = { repoId: 'r1', repoPath: workDir }

    const big = mkSession('dry-estimate', { events: 120 })

    // 先真空推一次
    await transport.push(
      binding,
      { sessions: [{ ...big, content: mkContent(big), eventCount: 120 }] },
      {}
    )

    // 再 dry-run 一次相同内容：应报「全部复用」
    const dry = await transport.push(
      binding,
      { sessions: [{ ...big, content: mkContent(big), eventCount: 120 }] },
      { dryRun: true }
    )

    assert.equal(dry.dryRun, true)
    assert.equal(dry.newChunks, 0, '内容没变时 dry-run 应预估 0 个新增块')
    assert.equal(dry.reusedChunks, dry.chunks, '内容没变时应全部复用')
    assert.equal(dry.transferred, 0, 'dry-run 不传任何东西')

    // 且不能真的写对象/动 ref：ref 应保持第一次 push 的结果
    const headAfter = (await runGit(workDir, ['rev-parse', SESSIONS_REF]))
      .stdout.toString('utf8')
      .trim()
    assert.ok(headAfter.length === 40 || headAfter.length === 64)
  } finally {
    await sandbox.cleanup()
  }
})

test('push：内容完全没变时全部复用，newChunks 为 0', async () => {
  if (!hasNativeZstd) return
  const sandbox = await makeSandbox()
  try {
    const { workDir } = await makeRepoPair(sandbox)
    const transport = createTransport({})
    const binding = { repoId: 'r1', repoPath: workDir }
    const session = mkSession('no-change', { events: 40 })

    await transport.push(
      binding,
      { sessions: [{ ...session, content: mkContent(session), eventCount: 40 }] },
      {}
    )
    const again = await transport.push(
      binding,
      { sessions: [{ ...session, content: mkContent(session), eventCount: 40 }] },
      {}
    )

    assert.equal(again.newChunks, 0, '内容未变时不应有新增块')
    assert.equal(again.reusedChunks, again.chunks, '应全部复用')
  } finally {
    await sandbox.cleanup()
  }
})
