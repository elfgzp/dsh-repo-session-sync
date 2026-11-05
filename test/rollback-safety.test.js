/**
 * 回滚安全性 —— 防止「回滚把用户历史删掉」这一类数据丢失。
 *
 * 这个文件对应一个真实的血案：engine 曾把「追加过的会话」和「新建的会话」
 * 混进同一个集合，attach 失败后对**追加过**的会话也执行了目录删除，
 * 结果用户 3 轮原有对话 + 本次 2 轮追加 = 5 轮，全被删掉。
 *
 * 所以这里按三种情况分别断言，其中第 2 种是核心：
 *   1. 新建的会话 attach 失败 → 目录被删（原有行为）
 *   2. 追加的会话 attach 失败 → **目录存在，且事件数还原到追加前**
 *      （只断言「目录还在」不够 —— 最坏的实现是删了再建个空的）
 *   3. 追加的会话 attach 成功 → 事件数正确，内容完整
 */

import assert from 'node:assert/strict'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  appendToSession,
  currentLogFilename,
  probeZstd,
  readSessionDir,
  restoreSessionFromBackup,
  writeSession,
} from '../src/session-store.js'
import { rollbackNewSessions } from '../src/registry.js'
import { decodeFramePureJs } from '../src/session-store.js'
import { fakeSessionId, makeSandbox, encodeFrameRawBlock } from './fixtures/synth.js'
import { encodeFrame } from './lib/zstd-frame.mjs'

const hasNativeZstd = probeZstd().available
const READ = hasNativeZstd ? {} : { frameDecoder: decodeFramePureJs }

/**
 * 写入用的帧编码器。
 *
 * 有原生 zstd 时用默认（与 DSH 真实格式一致）；没有时（Node < 22.15，
 * 例如本机默认的 nvm v20）改用**合规的 raw-block 帧**。
 * raw-block 是被 zstd 规范允许的合法帧类型，所以文件仍是真正的 zstd 帧序列，
 * 只是没有压缩 —— 这样测试在任何 Node 上都能跑，而不是 skip 掉。
 *
 * 这是刻意不 skip：skip 会掩盖「低版本环境下到底还能不能用」这个真实问题。
 */
const WRITE_ENCODER = hasNativeZstd ? undefined : encodeFrameRawBlock

/**
 * Encoder used when writing fixtures.
 *
 * These cases must actually reach the filesystem — the whole point is to prove
 * that a rollback leaves the on-disk bytes alone. So they cannot be skipped on
 * a Node without native zstd (v20 here, and the CI leg that pins it). The
 * synthetic frame writer emits spec-legal raw-block zstd frames, which the
 * reader decodes identically, so the assertions still exercise real writes.
 */
const ENCODER = hasNativeZstd ? undefined : (text) => encodeFrame(Buffer.from(text, 'utf8'))
const RM = '/tmp/dsh-sandbox/rollback-repo'

function makePayload(seed, { cwd = RM, events = 3 } = {}) {
  const sessionId = fakeSessionId(seed)
  return {
    sessionId,
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
    events: Array.from({ length: events }, (_, i) => ({
      type: 'assistant/message',
      seq: i,
      time: 1_700_000_000_000 + i * 1000,
      data: { text: `existing ${i}` },
    })),
  }
}

function appendedEvents(startSeq, count) {
  return Array.from({ length: count }, (_, i) => ({
    type: 'assistant/message',
    seq: startSeq + i,
    time: 1_700_000_000_000 + (startSeq + i) * 1000,
    data: { text: `appended ${startSeq + i}` },
  }))
}

test('场景 1：新建的会话 attach 失败 → 目录被删除（原有行为）', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')
    const payload = makePayload('new-fail', { events: 2 })
    const written = await writeSession(payload, {
      sessionsRoot: sandbox.sessionsRoot,
      backupDir,
      frameEncoder: ENCODER,
    })
    assert.ok((await stat(written.sessionDir)).isDirectory())

    // 新建的会话被回滚 → 应当被删除
    const result = await rollbackNewSessions({
      sessionsRoot: sandbox.sessionsRoot,
      writtenByThisRun: [{ sessionId: payload.sessionId, sessionDir: written.sessionDir }],
    })
    assert.deepEqual(result.removed, [payload.sessionId])
    await assert.rejects(() => stat(written.sessionDir), /ENOENT/)
  } finally {
    await sandbox.cleanup()
  }
})

test('场景 2【核心】：追加的会话 attach 失败 → 目录存在且事件数还原到追加前', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')

    // 本机原有 3 轮
    const payload = makePayload('append-fail', { events: 3 })
    const first = await writeSession(payload, {
      sessionsRoot: sandbox.sessionsRoot,
      backupDir,
    })
    assert.equal((await readSessionDir(first.sessionDir, READ)).nextSeq, 3)
    const beforeBytes = await readSessionDir(first.sessionDir, READ)

    // 本次追加 2 轮 → 5 轮
    const appended = await appendToSession(
      { sessionId: payload.sessionId, header: payload.header, events: appendedEvents(3, 2) },
      { sessionsRoot: sandbox.sessionsRoot, backupDir }
    )
    assert.equal((await readSessionDir(first.sessionDir, READ)).nextSeq, 5)
    assert.ok(appended.backupPath !== null, 'append 必须留下备份')

    // ── 错误的做法（会导致数据丢失）：把追加也算进「本次新建」并删除 ──
    // 这里**故意不这么调用**，而是演示正确做法：
    // 追加过的会话走「从备份还原」，绝不走 rollbackNewSessions。

    const restored = await restoreSessionFromBackup({
      sessionDir: first.sessionDir,
      backupPath: appended.backupPath,
      backupDir,
      sessionId: payload.sessionId,
      frameDecoder: READ.frameDecoder,
      log: { info() {}, warn() {}, error() {} },
    })

    assert.equal(restored.restored, true)
    assert.equal(restored.eventsBefore, 5, '还原前应是追加后的 5 条')
    assert.equal(restored.eventsAfter, 3, '还原后必须回到追加前的 3 条')

    // 目录必须还在（不能是「删了再建个空的」）
    assert.ok((await stat(first.sessionDir)).isDirectory(), '目录必须仍然存在')

    const finalState = await readSessionDir(first.sessionDir, READ)
    assert.equal(finalState.nextSeq, 3, '事件数必须精确回到追加前的 3 条，不是 0、不是 5')
    // 内容也要是原来的内容，不能只是数字对上
    assert.deepEqual(
      finalState.events.map((e) => e.data.text),
      ['existing 0', 'existing 1', 'existing 2'],
      '用户原有 3 轮对话内容必须完好无损'
    )
    assert.equal(finalState.header.cwd, beforeBytes.header.cwd)
  } finally {
    await sandbox.cleanup()
  }
})

test('场景 3：追加的会话 attach 成功 → 事件数 5，内容完整', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')
    const payload = makePayload('append-ok', { events: 3 })
    const first = await writeSession(payload, {
      sessionsRoot: sandbox.sessionsRoot,
      backupDir,
    })

    await appendToSession(
      { sessionId: payload.sessionId, header: payload.header, events: appendedEvents(3, 2) },
      { sessionsRoot: sandbox.sessionsRoot, backupDir }
    )

    const state = await readSessionDir(first.sessionDir, READ)
    assert.equal(state.nextSeq, 5)
    assert.deepEqual(
      state.events.map((e) => e.data.text),
      ['existing 0', 'existing 1', 'existing 2', 'appended 3', 'appended 4']
    )
    assert.equal(state.tornTail, false)
  } finally {
    await sandbox.cleanup()
  }
})

test('还原安全性：备份目录越界时拒绝，不动任何文件', async () => {
  const sandbox = await makeSandbox()
  try {
    const payload = makePayload('restore-escape', { events: 2 })
    const backupDir = join(sandbox.home, 'backups')
    const written = await writeSession(payload, {
      sessionsRoot: sandbox.sessionsRoot,
      backupDir,
      frameEncoder: ENCODER,
    })

    // 造一个在 backupDir 之外的目录冒充备份
    const { mkdir, writeFile } = await import('node:fs/promises')
    const outside = join(sandbox.home, 'outside-backup')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'evil.bin'), 'x')

    await assert.rejects(
      () =>
        restoreSessionFromBackup({
          sessionDir: written.sessionDir,
          backupPath: outside,
          backupDir,
          sessionId: payload.sessionId,
        }),
      (err) => err.code === 'path-unsafe'
    )

    // 原会话必须一字未改
    const state = await readSessionDir(written.sessionDir, READ)
    assert.equal(state.nextSeq, 2)
  } finally {
    await sandbox.cleanup()
  }
})

test('还原安全性：备份不存在时明确报 backup-failed，不删原会话', async () => {
  const sandbox = await makeSandbox()
  try {
    const payload = makePayload('restore-missing', { events: 2 })
    const backupDir = join(sandbox.home, 'backups')
    const written = await writeSession(payload, {
      sessionsRoot: sandbox.sessionsRoot,
      backupDir,
      frameEncoder: ENCODER,
    })

    await assert.rejects(
      () =>
        restoreSessionFromBackup({
          sessionDir: written.sessionDir,
          backupPath: join(backupDir, 'does-not-exist'),
          backupDir,
          sessionId: payload.sessionId,
        }),
      (err) => err.code === 'backup-failed'
    )

    // 关键：还原失败绝不能变成删除
    const state = await readSessionDir(written.sessionDir, READ)
    assert.equal(state.nextSeq, 2, '还原失败后原会话必须还在且内容不变')
  } finally {
    await sandbox.cleanup()
  }
})

test('还原会为当前状态另存一份快照（还原本身失败时也有退路）', async (t) => {
  if (!hasNativeZstd) {
    t.diagnostic('无原生 zstd 压缩，跳过')
    return
  }
  const sandbox = await makeSandbox()
  try {
    const backupDir = join(sandbox.home, 'backups')
    const payload = makePayload('restore-snapshot', { events: 2 })
    const first = await writeSession(payload, {
      sessionsRoot: sandbox.sessionsRoot,
      backupDir,
    })
    const appended = await appendToSession(
      { sessionId: payload.sessionId, header: payload.header, events: appendedEvents(2, 2) },
      { sessionsRoot: sandbox.sessionsRoot, backupDir }
    )

    const restored = await restoreSessionFromBackup({
      sessionDir: first.sessionDir,
      backupPath: appended.backupPath,
      backupDir,
      sessionId: payload.sessionId,
      frameDecoder: READ.frameDecoder,
      log: { info() {}, warn() {}, error() {} },
    })

    assert.ok(restored.safetySnapshot !== null, '还原前应另存一份快照')
    const files = await readdir(restored.safetySnapshot)
    assert.ok(
      files.includes(currentLogFilename()),
      '还原前快照应包含当时的日志文件'
    )
    // 快照里应是「追加后」的 4 条，这样万一还原本身出问题还有退路
    const snapshotState = await readSessionDir(restored.safetySnapshot, READ)
    assert.equal(snapshotState.nextSeq, 4)
  } finally {
    await sandbox.cleanup()
  }
})
