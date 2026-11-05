/**
 * 下行写入与 registry 闭环的测试 —— 全合成数据。
 *
 * 这里覆盖的是整条链路里最容易「看起来成功、实际什么都没发生」的部分：
 *   写盘 → 备份 → 回读验证 → cwd 重写 → workspace 登记 → 可见性回读
 */

import assert from 'node:assert/strict'
import { readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  createSessionSource,
  decodeLogBuffer,
  encodeSessionLog,
  projectKey,
  encodeSegment,
  readSessionDir,
  scanZstdFrames,
  writeSession,
  appendToSession,
  currentLogFilename,
} from '../src/session-store.js'
import {
  canonicalRepoPath,
  checkCwdMatchesRepo,
  ensureWorkspaceAndAttach,
  preflightRepoPath,
  rollbackNewSessions,
} from '../src/registry.js'
import { makeSandbox, fakeSessionId, encodeFrameRawBlock } from './fixtures/synth.js'
import { decodeFramePureJs, probeZstd, isSessionLive } from '../src/session-store.js'

const hasNativeZstd = probeZstd().available
const READ = hasNativeZstd ? {} : { frameDecoder: decodeFramePureJs }

const RM = '/tmp/dsh-sandbox/fixture-repo'

/** 造一个可写入的会话载荷。 */
function makePayload(seed, { cwd = RM, events = 5 } = {}) {
  const sessionId = fakeSessionId(seed)
  const header = {
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt: 1_700_000_000_000,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'cordis',
  }
  return {
    sessionId,
    header,
    events: Array.from({ length: events }, (_, i) => ({
      type: 'assistant/message',
      seq: i,
      time: 1_700_000_000_000 + i * 1000,
      data: { text: `synthetic ${i}` },
    })),
  }
}

/** MinIO 风格的 registry stub：真的会做 cwd 校验与过滤，不是空壳。 */
function makeRegistryStub({ path, realpathValue }) {
  /** @type {Map<string, {id: string, path: string, sessionIds: string[], attachCalls: string[]}>} */
  const entities = new Map()
  const headerCwds = new Map()

  const api = {
    /** 供测试预置「磁盘上这个会话的 header.cwd 是什么」 */
    setSessionCwd(sessionId, cwd) {
      headerCwds.set(sessionId, cwd)
    },
    get entities() {
      return entities
    },
    async resolveByPath(candidate) {
      const canonical = await realpathValue(candidate)
      for (const entity of entities.values()) {
        if (entity.path === canonical) return makeEntity(entity)
      }
      return undefined
    },
    async create(candidate, title) {
      const canonical = await realpathValue(candidate)
      for (const entity of entities.values()) {
        if (entity.path === canonical) return makeEntity(entity) // 幂等
      }
      const record = {
        id: `ws-${entities.size + 1}`,
        path: canonical,
        title: title ?? 'fixture',
        sessionIds: [],
        attachCalls: [],
      }
      entities.set(record.id, record)
      return makeEntity(record)
    },
  }

  function makeEntity(record) {
    return {
      id: record.id,
      get path() {
        return record.path
      },
      // 复刻 DSH 的过滤语义：登记了但 cwd 对不上的会被这个 getter 剔掉
      get sessionIds() {
        return record.sessionIds.filter((id) => headerCwds.get(id) === record.path)
      },
      async attachSession(sessionId) {
        record.attachCalls.push(sessionId)
        const cwd = headerCwds.get(sessionId)
        if (cwd === undefined) {
          throw new Error(`cannot attach session '${sessionId}': its stored header carries no cwd`)
        }
        if (cwd !== record.path) {
          throw new Error(
            `cannot attach session '${sessionId}': its cwd resolves to '${cwd}'`
          )
        }
        if (!record.sessionIds.includes(sessionId)) {
          record.sessionIds.push(sessionId)
        }
      },
      record,
    }
  }

  return api
}

test('encodeSessionLog：header 独占首帧，每事件一帧，可被自读回', async () => {
  const payload = makePayload('encode', { events: 6 })
  const bytes = encodeSessionLog(payload.header, payload.events, {
    frameEncoder: hasNativeZstd ? undefined : encodeFrameRawBlock,
  })

  const { frames } = scanZstdFrames(bytes)
  assert.equal(frames.length, 1 + payload.events.length, '1 帧 header + 每事件 1 帧')

  const decoded = decodeLogBuffer(bytes, READ)
  const lines = decoded.plaintext.split('\n').filter(Boolean)
  assert.equal(lines.length, 1 + payload.events.length)

  const header = JSON.parse(lines[0])
  assert.equal(header.id, payload.sessionId)
  assert.equal(header.cwd, RM)
})

test('encodeSessionLog：seq 不连续必须拒绝', () => {
  const payload = makePayload('badseq', { events: 3 })
  payload.events[1] = { ...payload.events[1], seq: 9 }
  assert.throws(() => encodeSessionLog(payload.header, payload.events), /seq 不连续/)
})

test('writeSession：新会话写入后可被 readSessionDir 读回', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过真实写入用例')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const payload = makePayload('write-new', { events: 7 })
    const backupDir = join(sandbox.home, 'backups')

    const result = await writeSession(payload, {
      sessionsRoot: sandbox.sessionsRoot,
      backupDir,
    })

    assert.equal(result.dryRun, false)
    assert.equal(result.written.length, 1)
    assert.ok(result.contentHash.length === 64)

    const dir = join(sandbox.sessionsRoot, projectKey(RM), encodeSegment(payload.sessionId))
    const record = await readSessionDir(dir)
    assert.equal(record.id, payload.sessionId)
    assert.equal(record.nextSeq, 7)
    assert.equal(record.tornTail, false)

    // 目录结构必须与真实 DSH 会话一致 —— 真实会话 100% 带 session.lock。
    // 缺了它，isSessionLive() 会走「没有 lock → 不可能有活跃写入者」的短路，
    // 于是我们写出的会话 LIVE 检测永久失效，可能覆盖用户正在使用的会话。
    const files = await readdir(dir)
    assert.ok(
      files.includes('session.lock'),
      `写入的会话必须包含 session.lock，实际目录内容：${JSON.stringify(files)}`
    )
    // 必须是 0 字节占位，不能带内容（真实 DSH 的 lock 就是空的）
    assert.equal((await stat(join(dir, 'session.lock'))).size, 0)

    // 首次写入不需要备份
    assert.equal(result.backupPath, null)
  } finally {
    await sandbox.cleanup()
  }
})

test('writeSession：覆盖前必须备份，且备份内容与原文一致', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')
    const payload = makePayload('write-over', { events: 4 })

    // 第一次写入
    await writeSession(payload, { sessionsRoot: sandbox.sessionsRoot, backupDir })
    const dir = join(sandbox.sessionsRoot, projectKey(RM), encodeSegment(payload.sessionId))
    const originalBytes = await readFile(join(dir, currentLogFilename()))

    // 第二次写入（更多事件）→ 必须备份
    const updated = { ...payload, events: payload.events.concat({
      type: 'assistant/message', seq: 4, time: 1, data: { text: 'more' },
    }) }
    const result = await writeSession(updated, { sessionsRoot: sandbox.sessionsRoot, backupDir })

    assert.ok(result.backupPath !== null, '覆盖写入必须产生备份')
    const backupFiles = await readdir(result.backupPath)
    assert.ok(backupFiles.includes(currentLogFilename()), '备份应包含原日志文件')
    const backupBytes = await readFile(join(result.backupPath, currentLogFilename()))
    assert.equal(
      Buffer.compare(backupBytes, originalBytes),
      0,
      '备份内容必须与覆盖前的原文件逐字节一致'
    )

    // 覆盖后的事件数已更新
    const record = await readSessionDir(dir)
    assert.equal(record.nextSeq, 5)
  } finally {
    await sandbox.cleanup()
  }
})

test('writeSession：没有 backupDir 时必须拒绝，绝不无备份写入', async () => {
  const sandbox = await makeSandbox()
  try {
    const payload = makePayload('no-backup')
    await assert.rejects(
      () => writeSession(payload, { sessionsRoot: sandbox.sessionsRoot }),
      /需要 backupDir/
    )
  } finally {
    await sandbox.cleanup()
  }
})

test('writeSession：备份目录不可写时必须中止且本机文件不变', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')
    const payload = makePayload('backup-fail', { events: 3 })
    await writeSession(payload, { sessionsRoot: sandbox.sessionsRoot, backupDir })

    const dir = join(sandbox.sessionsRoot, projectKey(RM), encodeSegment(payload.sessionId))
    const before = await readFile(join(dir, currentLogFilename()))

    // 把 backupDir 变成一个普通文件 → 无法创建备份目录
    await writeFile(backupDir, 'not a directory')

    const updated = { ...payload, events: payload.events.concat({
      type: 'assistant/message', seq: 3, time: 1, data: {},
    }) }
    await assert.rejects(
      () => writeSession(updated, { sessionsRoot: sandbox.sessionsRoot, backupDir }),
      (err) => err.code === 'backup-failed' || /无法备份/.test(err.message)
    )

    const after = await readFile(join(dir, currentLogFilename()))
    assert.equal(Buffer.compare(before, after), 0, '备份失败时本机文件必须一个字节都没变')
  } finally {
    await sandbox.cleanup()
  }
})

test('writeSession：dryRun 不产生任何文件', async () => {
  const sandbox = await makeSandbox()
  try {
    const payload = makePayload('dry', { events: 3 })
    await writeSession(payload, {
      sessionsRoot: sandbox.sessionsRoot,
      backupDir: join(sandbox.home, 'backups'),
      dryRun: true,
    })
    const dir = join(sandbox.sessionsRoot, projectKey(RM), encodeSegment(payload.sessionId))
    await assert.rejects(() => stat(dir), /ENOENT/, 'dry-run 不应创建目录')
  } finally {
    await sandbox.cleanup()
  }
})

test('writeSession：cwdOverride 重写 header 的 cwd', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const sourceCwd = '/tmp/dsh-sandbox/other-machine/repo'
    const targetCwd = RM
    const payload = makePayload('cwd-rewrite', { cwd: sourceCwd, events: 3 })

    const result = await writeSession(payload, {
      sessionsRoot: sandbox.sessionsRoot,
      backupDir: join(sandbox.home, 'backups'),
      cwdOverride: targetCwd,
    })

    // 落点由**重写后**的 cwd 决定
    const expectedDir = join(sandbox.sessionsRoot, projectKey(targetCwd), encodeSegment(payload.sessionId))
    assert.equal(result.written[0], join(expectedDir, currentLogFilename()))

    const record = await readSessionDir(expectedDir)
    assert.equal(record.header.cwd, targetCwd, 'header.cwd 必须被重写成本机路径')
    assert.equal(record.nextSeq, 3, '事件不受 cwd 重写影响')
  } finally {
    await sandbox.cleanup()
  }
})

test('writeSession：缺少 cwd 必须拒绝（否则写进去也看不见）', async () => {
  const sandbox = await makeSandbox()
  try {
    const payload = makePayload('no-cwd')
    delete payload.header.cwd
    await assert.rejects(
      () =>
        writeSession(payload, {
          sessionsRoot: sandbox.sessionsRoot,
          backupDir: join(sandbox.home, 'backups'),
        }),
      /没有 cwd/
    )
  } finally {
    await sandbox.cleanup()
  }
})

test('writeSession：sessionId 穿越与凭据路径一律拒绝', async () => {
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')
    for (const bad of ['../../../etc/passwd', '..', 'a/b']) {
      const payload = makePayload('x')
      payload.sessionId = bad
      payload.header.id = bad
      await assert.rejects(
        () => writeSession(payload, { sessionsRoot: sandbox.sessionsRoot, backupDir }),
        (err) => err.code === 'path-unsafe' || /sessionId/.test(err.message)
      )
    }
  } finally {
    await sandbox.cleanup()
  }
})

test('canonicalRepoPath：解析软链，且路径不存在时报 REPO_PATH_MISSING', async () => {
  const sandbox = await makeSandbox()
  try {
    const real = join(sandbox.home, 'real-repo')
    await writeFile(join(sandbox.home, 'placeholder'), '')
    // 造一个真实目录 + 一个指向它的软链
    const { mkdir } = await import('node:fs/promises')
    await mkdir(real, { recursive: true })
    const link = join(sandbox.home, 'link-repo')
    await symlink(real, link)

    const viaLink = await canonicalRepoPath(link)
    const viaReal = await canonicalRepoPath(real)
    assert.equal(viaLink, viaReal, '软链必须解析成同一个 canonical 路径')

    await assert.rejects(
      () => canonicalRepoPath(join(sandbox.home, 'does-not-exist')),
      (err) => err.code === 'repo-path-missing'
    )

    const pre = await preflightRepoPath(link)
    assert.equal(pre.ok, true)
    assert.equal(pre.canonical, viaReal)
  } finally {
    await sandbox.cleanup()
  }
})

test('checkCwdMatchesRepo：跨机路径不匹配必须被识别', () => {
  const repo = '/tmp/dsh-sandbox/fixture-repo'
  const { matches, mismatches } = checkCwdMatchesRepo(
    [
      { sessionId: 'a', cwd: repo },
      { sessionId: 'b', cwd: join(repo, 'sub') },
      { sessionId: 'c', cwd: '/tmp/dsh-sandbox/other-machine/repo' },
      { sessionId: 'd', cwd: '' },
      { sessionId: 'e' },
    ],
    repo
  )
  assert.deepEqual(matches.sort(), ['a', 'b'])
  assert.deepEqual(mismatches.map((m) => m.sessionId).sort(), ['c', 'd', 'e'])
})

test('ensureWorkspaceAndAttach：真实闭环 —— 会话出现在过滤后的成员里', async () => {
  const sandbox = await makeSandbox()
  try {
    const { mkdir } = await import('node:fs/promises')
    const repo = join(sandbox.home, 'fixture-repo')
    await mkdir(repo, { recursive: true })
    const canonical = await canonicalRepoPath(repo)

    const registry = makeRegistryStub({ path: repo, realpathValue: canonicalRepoPath })
    const id1 = fakeSessionId('reg1')
    const id2 = fakeSessionId('reg2')
    // 模拟已经按 canonical cwd 重写并写入
    registry.setSessionCwd(id1, canonical)
    registry.setSessionCwd(id2, canonical)

    const result = await ensureWorkspaceAndAttach({
      registry,
      repoPath: repo,
      sessionIds: [id1, id2],
    })

    assert.equal(result.ok, true)
    assert.equal(result.canonical, canonical)
    assert.deepEqual(result.attached.sort(), [id1, id2].sort())
    assert.deepEqual(result.failed, [])

    // 关键：回读 entity.sessionIds（就是 DSH 侧栏的可见性来源）
    const entity = await registry.resolveByPath(repo)
    assert.deepEqual(Array.from(entity.sessionIds).sort(), [id1, id2].sort())
  } finally {
    await sandbox.cleanup()
  }
})

test('ensureWorkspaceAndAttach：cwd 不匹配时 attach 失败并被报告（不静默）', async () => {
  const sandbox = await makeSandbox()
  try {
    const { mkdir } = await import('node:fs/promises')
    const repo = join(sandbox.home, 'fixture-repo')
    await mkdir(repo, { recursive: true })
    const canonical = await canonicalRepoPath(repo)

    const registry = makeRegistryStub({ path: repo, realpathValue: canonicalRepoPath })
    const good = fakeSessionId('good')
    const wrongCwd = fakeSessionId('wrong')
    registry.setSessionCwd(good, canonical)
    // 故意留一个别的机器的路径 → attachSession 会抛
    registry.setSessionCwd(wrongCwd, '/tmp/dsh-sandbox/other-machine/repo')

    const result = await ensureWorkspaceAndAttach({
      registry,
      repoPath: repo,
      sessionIds: [good, wrongCwd],
    })

    assert.equal(result.ok, false, '有失败就不能报 ok')
    assert.deepEqual(result.attached, [good])
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].sessionId, wrongCwd)
  } finally {
    await sandbox.cleanup()
  }
})

test('ensureWorkspaceAndAttach：没有 registry 时报 not-implemented 而不是崩', async () => {
  await assert.rejects(
    () => ensureWorkspaceAndAttach({ registry: null, repoPath: RM, sessionIds: ['x'] }),
    (err) => err.code === 'not-implemented'
  )
})

test('createSessionSource：list/read/write 三件套可用', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const source = createSessionSource({ paths: { dshHome: sandbox.home } })

    // write 一个会话
    const payload = makePayload('source', { events: 4 })
    const writeResult = await source.write(payload, {
      backupDir: join(sandbox.home, 'backups'),
      cwdOverride: RM,
    })
    assert.equal(writeResult.sessionId, payload.sessionId)

    // list 应能列出来
    const listed = await source.list({ repoId: 'r1', repoPath: RM })
    assert.equal(listed.length, 1)
    assert.equal(listed[0].sessionId, payload.sessionId)
    assert.equal(listed[0].cwd, RM)
    // list() 走轻量扫描：eventCount 是帧数派生的上界（>= 真实事件数），
    // 而 watermark 必须是 undefined —— 没精确解析就不给水位线，
    // 否则「已同步到第几条」偏大会漏事件。
    assert.ok(listed[0].eventCount >= 4, `eventCount 应是上界，实际 ${listed[0].eventCount}`)
    assert.equal(listed[0].watermark, undefined)

    // read 应能读回完整事件
    const read = await source.read(payload.sessionId, { cwd: RM })
    assert.equal(read.sessionId, payload.sessionId)
    assert.equal(read.eventCount, 4)
    assert.equal(read.events.length, 4)
    assert.equal(read.contentHash, writeResult.contentHash)
  } finally {
    await sandbox.cleanup()
  }
})

test('createSessionSource：list 在没有会话时返回空数组而不是抛错', async () => {
  const sandbox = await makeSandbox()
  try {
    const source = createSessionSource({ paths: { dshHome: sandbox.home } })
    const listed = await source.list({ repoId: 'r1', repoPath: '/tmp/dsh-sandbox/empty-repo' })
    assert.deepEqual(listed, [])
  } finally {
    await sandbox.cleanup()
  }
})

// ─────────────────────────────────────────────────────────────
// LIVE 会话检测
// ─────────────────────────────────────────────────────────────

test('isSessionLive：没有 lock 文件时直接判定不 live', async () => {
  const sandbox = await makeSandbox()
  try {
    const dir = join(sandbox.home, 'no-lock-session')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    const result = await isSessionLive(dir)
    assert.equal(result.live, false)
    assert.equal(result.checked, true)
    assert.equal(result.method, 'no-lock-file')
  } finally {
    await sandbox.cleanup()
  }
})

test('isSessionLive：lsof 报告有持有者 → live=true', async () => {
  const sandbox = await makeSandbox()
  try {
    const dir = join(sandbox.home, 'live-session')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.lock'), '')

    // 调用级注入：不走模块级全局开关（那会在并行测试里污染其他文件）
    const result = await isSessionLive(dir, {
      execFile: async (command) =>
        command === 'lsof'
          ? {
              available: true,
              code: 0,
              stdout:
                'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n' +
                'dsh     4242 gzp    8w   REG   1,2      0  123 /tmp/x/session.lock\n',
              stderr: '',
            }
          : { available: false, code: 127, stdout: '', stderr: '' },
    })
    assert.equal(result.live, true)
    assert.equal(result.checked, true)
    assert.match(result.reason, /打开|使用中/)
    assert.match(result.reason, /dsh/, 'reason 应包含持有者命令名，便于用户定位')
  } finally {
    await sandbox.cleanup()
  }
})

test('isSessionLive：lsof 只有表头 → 判定不 live', async () => {
  const sandbox = await makeSandbox()
  try {
    const dir = join(sandbox.home, 'free-session')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.lock'), '')

    // 有非表头行 → 被持有
    const held = await isSessionLive(dir, {
      execFile: async () => ({
        available: true,
        code: 0,
        stdout:
          'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n' +
          'other   9999 gzp    8w   REG   1,2      0  123 /somewhere/else\n',
        stderr: '',
      }),
    })
    assert.equal(held.live, true, '有非表头行即视为被持有')

    // 只有表头 → 未被持有（表头行不能被当成持有者）
    const free = await isSessionLive(dir, {
      execFile: async () => ({
        available: true,
        code: 0,
        stdout: 'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n',
        stderr: '',
      }),
    })
    assert.equal(free.live, false, '只有表头时应判定未被持有')
  } finally {
    await sandbox.cleanup()
  }
})

test('isSessionLive：lsof/fuser 都不存在 → checked=false（明确表示没查成）', async () => {
  const sandbox = await makeSandbox()
  try {
    const dir = join(sandbox.home, 'unknown-session')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.lock'), '')

    const result = await isSessionLive(dir, {
      execFile: async () => ({ available: false, code: 127, stdout: '', stderr: '' }),
    })
    assert.equal(result.live, false)
    assert.equal(
      result.checked,
      false,
      '查不成时不能假装「不 live」，必须明确暴露这一事实'
    )
    assert.match(String(result.reason), /无法判断/)
  } finally {
    await sandbox.cleanup()
  }
})

test('writeSession：LIVE 会话拒绝写入，且不产生任何副作用', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')
    const payload = makePayload('live-target', { events: 3 })
    await writeSession(payload, { sessionsRoot: sandbox.sessionsRoot, backupDir })

    const dir = join(sandbox.sessionsRoot, projectKey(RM), encodeSegment(payload.sessionId))
    const before = await readFile(join(dir, currentLogFilename()))
    // DSH 在会话被 materialize 后总会留下 lock 文件；没有它，
    // isSessionLive 会走「无锁文件 → 不可能有活写入者」的短路，测不到目标分支。
    await writeFile(join(dir, 'session.lock'), '')

    // 让检测认为「会话正在被使用」—— 直接通过 writeSession 的参数注入
    {
      const updated = {
        ...payload,
        events: payload.events.concat({ type: 'assistant/message', seq: 3, time: 1, data: {} }),
      }
      await assert.rejects(
        () =>
          writeSession(updated, {
            sessionsRoot: sandbox.sessionsRoot,
            backupDir,
            lockProbeRunner: async (command) =>
              command === 'lsof'
                ? {
                    available: true,
                    code: 0,
                    stdout:
                      'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\ndsh 1 gzp 8w REG 1,2 0 1 x\n',
                    stderr: '',
                  }
                : { available: false, code: 127, stdout: '', stderr: '' },
          }),
        (err) => err.code === 'busy',
        'LIVE 会话必须被拒绝'
      )
    }

    const after = await readFile(join(dir, currentLogFilename()))
    assert.equal(Buffer.compare(before, after), 0, '拒绝写入时本机文件必须一字未改')

    // 也不该留下备份（LIVE 检测在备份之前）
    const { readdir: rd } = await import('node:fs/promises')
    const backups = await rd(backupDir).catch(() => [])
    assert.equal(backups.length, 0, 'LIVE 拒绝时不应产生备份目录')
  } finally {
    await sandbox.cleanup()
  }
})

// ─────────────────────────────────────────────────────────────
// 回滚：attach 失败时清理本次新写入的会话
// ─────────────────────────────────────────────────────────────

test('rollbackNewSessions：只删本次新写入的，绝不碰已存在的', async () => {
  const sandbox = await makeSandbox()
  try {
    const { mkdir } = await import('node:fs/promises')
    const newDir = join(sandbox.sessionsRoot, 'p1', 'new-session')
    const existingDir = join(sandbox.sessionsRoot, 'p1', 'existing-session')
    await mkdir(newDir, { recursive: true })
    await mkdir(existingDir, { recursive: true })
    await writeFile(join(newDir, currentLogFilename()), 'x')
    await writeFile(join(existingDir, currentLogFilename()), 'y')

    const result = await rollbackNewSessions({
      sessionsRoot: sandbox.sessionsRoot,
      writtenByThisRun: [{ sessionId: 'new-session', sessionDir: newDir }],
    })

    assert.deepEqual(result.removed, ['new-session'])
    assert.deepEqual(result.failed, [])

    // 新写入的被删了
    await assert.rejects(() => stat(newDir), /ENOENT/)
    // 已存在的必须原样保留
    assert.ok((await stat(existingDir)).isDirectory(), '已存在的会话绝不能被删')
  } finally {
    await sandbox.cleanup()
  }
})

test('rollbackNewSessions：目录不在 sessionsRoot 内时拒绝删除', async () => {
  const sandbox = await makeSandbox()
  try {
    const { mkdir } = await import('node:fs/promises')
    const outside = join(sandbox.home, 'outside-dir')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'important.txt'), 'do not delete')

    const result = await rollbackNewSessions({
      sessionsRoot: sandbox.sessionsRoot,
      writtenByThisRun: [{ sessionId: 'evil', sessionDir: outside }],
    })

    assert.deepEqual(result.removed, [])
    assert.equal(result.failed.length, 1)
    assert.match(result.failed[0].reason, /不在会话根目录内/)
    // 越界目录必须还在
    assert.ok((await stat(outside)).isDirectory())
  } finally {
    await sandbox.cleanup()
  }
})

test('rollbackNewSessions：空输入直接返回，不抛错', async () => {
  const result = await rollbackNewSessions({
    sessionsRoot: '/tmp/dsh-sandbox/whatever',
    writtenByThisRun: [],
  })
  assert.deepEqual(result.removed, [])
})

// ─────────────────────────────────────────────────────────────
// appendToSession：增量追加（红线要求）
// ─────────────────────────────────────────────────────────────

function makeAppendEvents(startSeq, count) {
  return Array.from({ length: count }, (_, i) => ({
    type: 'assistant/message',
    seq: startSeq + i,
    time: 1_700_000_000_000 + (startSeq + i) * 1000,
    data: { text: `appended ${startSeq + i}` },
  }))
}

test('appendToSession：追加后事件完整且可读回', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')
    const payload = makePayload('append-basic', { events: 4 })
    const first = await writeSession(payload, { sessionsRoot: sandbox.sessionsRoot, backupDir })
    const dir = first.sessionDir

    const result = await appendToSession(
      {
        sessionId: payload.sessionId,
        header: payload.header,
        events: makeAppendEvents(4, 3),
      },
      { sessionsRoot: sandbox.sessionsRoot, backupDir }
    )

    assert.equal(result.appended, 3)
    assert.equal(result.nextSeq, 7)
    assert.ok(result.backupPath !== null, '追加前必须有备份')

    const record = await readSessionDir(dir)
    assert.equal(record.nextSeq, 7, '原 4 条 + 追加 3 条')
    assert.equal(record.events[4].seq, 4)
    assert.equal(record.events[6].seq, 6)
    // 前 4 条的字节必须完全没变（append-only 的核心承诺）
    assert.equal(record.events[0].data.text, 'synthetic 0')
  } finally {
    await sandbox.cleanup()
  }
})

test('appendToSession：追加不改动已有事件的字节（真 append-only）', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')
    const payload = makePayload('append-prefix', { events: 3 })
    const first = await writeSession(payload, { sessionsRoot: sandbox.sessionsRoot, backupDir })
    const dir = first.sessionDir
    const logPath = join(dir, currentLogFilename())
    const before = await readFile(logPath)

    await appendToSession(
      { sessionId: payload.sessionId, header: payload.header, events: makeAppendEvents(3, 2) },
      { sessionsRoot: sandbox.sessionsRoot, backupDir }
    )

    const after = await readFile(logPath)
    assert.ok(after.length > before.length, '文件应该变长')
    assert.equal(
      Buffer.compare(after.subarray(0, before.length), before),
      0,
      '原文件必须是新文件的前缀 —— 这就是 append-only'
    )
  } finally {
    await sandbox.cleanup()
  }
})

test('appendToSession：首 seq 与本机 nextSeq 不符必须拒绝（gap/重放）', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')
    const payload = makePayload('append-gap', { events: 4 })
    const first = await writeSession(payload, { sessionsRoot: sandbox.sessionsRoot, backupDir })
    const logPath = join(first.sessionDir, currentLogFilename())
    const before = await readFile(logPath)

    // gap：从 seq 6 开始，但本机 nextSeq 是 4
    await assert.rejects(
      () =>
        appendToSession(
          { sessionId: payload.sessionId, header: payload.header, events: makeAppendEvents(6, 2) },
          { sessionsRoot: sandbox.sessionsRoot, backupDir }
        ),
      (err) => err.code === 'conflict-session'
    )

    // 重放：从 seq 0 开始，本机已经有了
    await assert.rejects(
      () =>
        appendToSession(
          { sessionId: payload.sessionId, header: payload.header, events: makeAppendEvents(0, 2) },
          { sessionsRoot: sandbox.sessionsRoot, backupDir }
        ),
      (err) => err.code === 'conflict-session'
    )

    // 两次拒绝都必须让文件一字节未变
    assert.equal(Buffer.compare(await readFile(logPath), before), 0)
  } finally {
    await sandbox.cleanup()
  }
})

test('appendToSession：自动截掉 torn tail 后再追加', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')
    const payload = makePayload('append-torn', { events: 3 })
    const first = await writeSession(payload, { sessionsRoot: sandbox.sessionsRoot, backupDir })
    const logPath = join(first.sessionDir, currentLogFilename())

    // 模拟崩溃：把文件末尾截断成半个帧。
    // 原文件 3 个事件各一帧，截掉 7 字节会破坏最后一帧（seq=2 那条）。
    const full = await readFile(logPath)
    await writeFile(logPath, full.subarray(0, full.length - 7))

    // 截断后的「完整事件前缀」只剩 seq 0..1，所以本机 nextSeq = 2。
    // 这里有一个必须讲清楚的语义：丢弃 torn tail 之后，**那条事件就等于没写成功**，
    // 因此正确的追加起点是 seq=2（把它重写一遍），而**不是** seq=3。
    // 若从 seq=3 追加就会留下 seq 缺口 —— 实现会拒绝，这是对的。
    await assert.rejects(
      () =>
        appendToSession(
          { sessionId: payload.sessionId, header: payload.header, events: makeAppendEvents(3, 2) },
          { sessionsRoot: sandbox.sessionsRoot, backupDir }
        ),
      (err) => err.code === 'conflict-session',
      'torn tail 丢弃后若从 seq=3 追加会留下缺口，必须拒绝'
    )

    // 正确做法：从 seq=2 重新开始追加（重放被截断掉的那条 + 新增一条）
    const result = await appendToSession(
      { sessionId: payload.sessionId, header: payload.header, events: makeAppendEvents(2, 2) },
      { sessionsRoot: sandbox.sessionsRoot, backupDir }
    )

    assert.ok(result.truncatedTailBytes > 0, '应识别并截掉 torn tail')
    assert.equal(result.nextSeq, 4, '完整前缀 2 条 + 追加 2 条')
    // 追加后半帧被清掉，整个文件必须能正常解码
    const record = await readSessionDir(first.sessionDir)
    assert.equal(record.nextSeq, 4)
    assert.equal(record.tornTail, false, '追加后不应再有 torn tail')
  } finally {
    await sandbox.cleanup()
  }
})

test('appendToSession：会话不存在时明确拒绝（应走 write 而非 append）', async () => {
  const sandbox = await makeSandbox()
  try {
    const payload = makePayload('append-missing', { events: 2 })
    await assert.rejects(
      () =>
        appendToSession(payload, {
          sessionsRoot: sandbox.sessionsRoot,
          backupDir: join(sandbox.home, 'backups'),
        }),
      (err) => err.code === 'repo-path-missing'
    )
  } finally {
    await sandbox.cleanup()
  }
})

test('appendToSession：LIVE 会话拒绝追加', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')
    const payload = makePayload('append-live', { events: 3 })
    const first = await writeSession(payload, { sessionsRoot: sandbox.sessionsRoot, backupDir })
    await writeFile(join(first.sessionDir, 'session.lock'), '')
    const before = await readFile(join(first.sessionDir, currentLogFilename()))

    await assert.rejects(
      () =>
        appendToSession(
          { sessionId: payload.sessionId, header: payload.header, events: makeAppendEvents(3, 1) },
          {
            sessionsRoot: sandbox.sessionsRoot,
            backupDir,
            lockProbeRunner: async () => ({
              available: true,
              code: 0,
              stdout: 'COMMAND PID USER\nnode 1 gzp\n',
              stderr: '',
            }),
          }
        ),
      (err) => err.code === 'busy'
    )

    assert.equal(Buffer.compare(await readFile(join(first.sessionDir, currentLogFilename())), before), 0)
  } finally {
    await sandbox.cleanup()
  }
})

test('appendToSession：dryRun 不写任何字节', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')
    const payload = makePayload('append-dry', { events: 3 })
    const first = await writeSession(payload, { sessionsRoot: sandbox.sessionsRoot, backupDir })
    const logPath = join(first.sessionDir, currentLogFilename())
    const before = await readFile(logPath)

    const result = await appendToSession(
      { sessionId: payload.sessionId, header: payload.header, events: makeAppendEvents(3, 2) },
      { sessionsRoot: sandbox.sessionsRoot, backupDir, dryRun: true }
    )

    assert.equal(result.dryRun, true)
    assert.equal(result.appended, 2)
    assert.equal(result.backupPath, null)
    assert.equal(result.nextSeq, 5)
    assert.equal(Buffer.compare(await readFile(logPath), before), 0, 'dry-run 不得写任何字节')
  } finally {
    await sandbox.cleanup()
  }
})

// ─────────────────────────────────────────────────────────────
// 幂等性：多次跨机往返后结构不持续膨胀
// ─────────────────────────────────────────────────────────────

test('往返幂等：A→B→A 重写 cwd 后帧数与事件数不增长', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')
    const cwdA = '/tmp/dsh-sandbox/machine-a/repo'
    const cwdB = '/tmp/dsh-sandbox/machine-b/work/repo'

    // A 机原始会话
    const payloadA = makePayload('idem', { cwd: cwdA, events: 6 })
    const first = await writeSession(payloadA, {
      sessionsRoot: sandbox.sessionsRoot,
      backupDir,
    })
    const recordA = await readSessionDir(first.sessionDir)
    const framesA = recordA.frames
    const eventsA = recordA.nextSeq

    // B 机：重写 cwd 到 B 的路径
    const recordARaw = await readSessionDir(first.sessionDir)
    const wroteB = await writeSession(
      {
        sessionId: payloadA.sessionId,
        header: recordARaw.header,
        events: recordARaw.events,
      },
      { sessionsRoot: sandbox.sessionsRoot, backupDir, cwdOverride: cwdB }
    )
    const recordB = await readSessionDir(wroteB.sessionDir)

    // A 机：再重写回 A 的路径（模拟会话从 B 回到 A）
    const wroteA2 = await writeSession(
      { sessionId: payloadA.sessionId, header: recordB.header, events: recordB.events },
      { sessionsRoot: sandbox.sessionsRoot, backupDir, cwdOverride: cwdA }
    )
    const recordA2 = await readSessionDir(wroteA2.sessionDir)

    // 核心断言：结构稳定，不因往返而膨胀
    assert.equal(recordA2.nextSeq, eventsA, '事件数必须与最初相同')
    assert.equal(recordA2.frames, framesA, '帧数必须与最初相同（不得逐次增长）')
    assert.equal(recordA2.header.cwd, cwdA, 'cwd 应回到 A 机路径')
    assert.equal(recordB.header.cwd, cwdB)
    // 连续两次写同样的内容，帧数不应变化
    const repeat = await writeSession(
      { sessionId: payloadA.sessionId, header: recordA2.header, events: recordA2.events },
      { sessionsRoot: sandbox.sessionsRoot, backupDir, cwdOverride: cwdA }
    )
    const recordRepeat = await readSessionDir(repeat.sessionDir)
    assert.equal(recordRepeat.frames, recordA2.frames, '重复写入不得让帧数变化')
    assert.equal(recordRepeat.nextSeq, recordA2.nextSeq)
  } finally {
    await sandbox.cleanup()
  }
})

test('【结构性】writeSession 产出的会话 LIVE 检测必须真正生效（不能永久短路）', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')
    const payload = makePayload('live-effective', { events: 3 })
    const written = await writeSession(payload, {
      sessionsRoot: sandbox.sessionsRoot,
      backupDir,
    })

    // ① 目录结构必须与真实 DSH 一致（含 0 字节 lock）
    const files = await readdir(written.sessionDir)
    assert.ok(
      files.includes('session.lock'),
      `结构与真实 DSH 会话不一致，缺 session.lock。实际：${JSON.stringify(files)}`
    )

    // ② 无持有者时：应走到 lsof 探测，而不是「没有 lock 文件」的短路
    const free = await isSessionLive(written.sessionDir, {
      execFile: async (command) =>
        command === 'lsof'
          ? { available: true, code: 1, stdout: '', stderr: '' }
          : { available: false, code: 127, stdout: '', stderr: '' },
    })
    assert.equal(free.live, false)
    assert.equal(
      free.method,
      'lsof',
      '有了 lock 文件后，检测应该真的去问 lsof，而不是短路成 no-lock-file'
    )

    // ③ 有持有者时：必须能检出 live —— 这条是核心
    //    如果目录里没有 lock，这里会拿不到 live=true，保护就形同虚设。
    const held = await isSessionLive(written.sessionDir, {
      execFile: async (command) =>
        command === 'lsof'
          ? {
              available: true,
              code: 0,
              stdout:
                'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n' +
                'dsh 4242 gzp 8w REG 1,2 0 1 session.lock\n',
              stderr: '',
            }
          : { available: false, code: 127, stdout: '', stderr: '' },
    })
    assert.equal(held.live, true, 'writeSession 产出的会话必须能被 LIVE 检测认出正被使用')

    // ④ 真到写入这一步也必须被拦住
    await writeFile(join(written.sessionDir, 'session.lock'), '')
    await assert.rejects(
      () =>
        appendToSession(
          {
            sessionId: payload.sessionId,
            header: payload.header,
            events: [
              { type: 'assistant/message', seq: 3, time: 1, data: {} },
            ],
          },
          {
            sessionsRoot: sandbox.sessionsRoot,
            backupDir,
            lockProbeRunner: async (command) =>
              command === 'lsof'
                ? {
                    available: true,
                    code: 0,
                    stdout:
                      'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\ndsh 1 gzp 8w REG 1,2 0 1 x\n',
                    stderr: '',
                  }
                : { available: false, code: 127, stdout: '', stderr: '' },
          }
        ),
      (err) => err.code === 'busy',
      'LIVE 会话必须拒绝追加'
    )
  } finally {
    await sandbox.cleanup()
  }
})

test('【结构修复】appendToSession 会补齐缺失的 session.lock（老数据兼容）', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')
    const payload = makePayload('lock-repair', { events: 3 })
    const written = await writeSession(payload, {
      sessionsRoot: sandbox.sessionsRoot,
      backupDir,
    })

    // 模拟「老版本 writeSession 写出的会话」：删掉 lock
    const { rm } = await import('node:fs/promises')
    await rm(join(written.sessionDir, 'session.lock'))
    assert.ok(!(await readdir(written.sessionDir)).includes('session.lock'))

    await appendToSession(
      {
        sessionId: payload.sessionId,
        header: payload.header,
        events: [{ type: 'assistant/message', seq: 3, time: 1, data: {} }],
      },
      { sessionsRoot: sandbox.sessionsRoot, backupDir }
    )

    // 追加时应顺手把 lock 补回来，恢复与 DSH 一致的结构
    assert.ok(
      (await readdir(written.sessionDir)).includes('session.lock'),
      'appendToSession 应补齐缺失的 session.lock'
    )
  } finally {
    await sandbox.cleanup()
  }
})
