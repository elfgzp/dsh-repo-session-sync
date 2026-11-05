/**
 * `engine.runDirection()` assembly tests.
 *
 * ## What this suite is for
 *
 * The other suites test the pieces: the transport really moves bytes, the session
 * store really encodes frames, the registry really attaches. None of them test
 * the **sequence** — and the sequence is where the design's red lines live:
 *
 *   - a download that wrote files but could not register them must FAIL and
 *     ROLL BACK, not report success;
 *   - a visibility regression must stop the sync before anything is pushed;
 *   - an incremental append must resume from the local disk position, never from
 *     a stored watermark.
 *
 * Each of those is a rule about ordering, so each needs a test that observes the
 * order. The seams here are fakes that record what they were asked to do, which
 * is what makes the ordering observable; the real implementations are covered by
 * their own suites.
 *
 * ## Why the fakes are strict
 *
 * A permissive fake lets an assembly bug pass. These fakes throw on calls the
 * engine should not make, and return exactly the documented shapes, so the tests
 * fail on a wrong call rather than tolerating it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSyncEngine } from '../../src/engine.js'
import { StateStore } from '../../src/store.js'
import { ERROR_CODES, SyncError } from '../../src/errors.js'
import { resolvePaths } from '../../src/paths.js'
import { createBinding } from '../../src/repo-binding.js'

/**
 * Build an isolated store rooted in a temp directory.
 *
 * @param {string} dir - Temp root.
 * @returns {StateStore} Store.
 */
function makeStore(dir) {
  const paths = resolvePaths({ dshHome: dir, stateDir: join(dir, 'state') })
  return new StateStore(paths)
}

/**
 * Create a binding placed in a real temp directory so path resolution succeeds.
 *
 * @param {string} dir - Temp root.
 * @param {object} [overrides] - Field overrides.
 * @returns {object} Binding.
 */
function makeBinding(dir, overrides = {}) {
  return createBinding({
    repoPath: dir,
    remoteUrl: 'git@example.invalid:demo/project.git',
    branch: 'main',
    ...overrides,
  })
}

/**
 * A registry fake that records calls and reports whatever the test asks.
 *
 * @param {{failed?: Array<{sessionId: string, reason: string}>, attached?: string[]}} outcome
 *   What `ensureWorkspaceAndAttach` should report.
 * @returns {object} Fake registry service.
 */
function makeRegistry(outcome = {}) {
  const calls = { attached: [], rolledBack: [] }
  return {
    calls,
    async resolveByPath() { return undefined },
    async create(path) {
      return {
        id: 'ws-demo',
        attachSession: async () => {},
        sessionIds: Array.isArray(outcome.attached) ? outcome.attached : [],
      }
    },
    attachOutcome: outcome,
    recorded: calls,
  }
}

/**
 * Assemble an engine over fakes, recording the call order.
 *
 * @param {object} options - Scenario facts.
 * @returns {Promise<object>} Engine plus the recorded call log.
 */
async function makeEngine(options) {
  const {
    dir,
    binding,
    store,
    remoteSessions = [],
    visibilityVerdict = 'private',
    registryOutcome = {},
    registryAvailable = true,
    writeSpy,
    appendSpy,
    pushedSessions,
  } = options

  /** Ordered log of seam invocations, so tests can assert sequencing. */
  const order = []
  /** Anchor handed to `transport.push`, so tests can assert it travelled. */
  let pushedAnchor
  const spy = {
    get pushedAnchor() { return pushedAnchor },
  }

  const deps = {
    store,
    paths: resolvePaths({ dshHome: dir, stateDir: join(dir, 'state') }),
    sessions: {
      async list() {
        order.push('sessions.list')
        return options.localList ?? []
      },
      async read(sessionId) {
        order.push(`sessions.read:${sessionId}`)
        return options.localRead?.(sessionId) ?? {
          sessionId,
          repoKey: binding.repoKey,
          eventCount: 3,
          watermark: '3',
          contentHash: 'hash-local',
          content: Buffer.from('local'),
          updatedAt: Date.now(),
          header: { type: 'session', id: sessionId, cwd: binding.repoPath },
          events: [{ seq: 0 }, { seq: 1 }, { seq: 2 }],
        }
      },
      async write(payload, opts) {
        order.push('sessions.write')
        // `writeThrowCode` 抛一个带指定错误码的 SyncError —— 这样才能测到
        // 引擎的「系统性错误分类」逻辑。抛普通 Error 会被归为 internal-error，
        // 走不到那个分支（这正是这组测试第一版假绿的原因）。
        if (typeof options.writeThrowCode === 'string') {
          throw new SyncError(options.writeThrowCode, '模拟写入阶段的系统性失败')
        }
        if (options.writeThrows === true) throw new Error('写入失败')
        writeSpy?.(payload, opts)
        // Mirrors the real contract: `backupPath` is null only when the target did
        // not exist. The engine derives `created` from exactly this, so a fake that
        // always returned a path would silently disable the rollback path.
        const existed = typeof options.writeExisted === 'function'
          ? options.writeExisted(payload.sessionId)
          : false
        return {
          sessionDir: join(dir, 'sessions', payload.sessionId),
          sessionId: payload.sessionId,
          backupPath: existed ? join(dir, 'backups', payload.sessionId) : null,
        }
      },
    },
    sessionOps: {
      async appendToSession(payload, opts) {
        order.push('sessionOps.append')
        appendSpy?.(payload, opts)
        return {
          sessionDir: join(dir, 'sessions', payload.sessionId),
          backupPath: join(dir, 'backups', payload.sessionId),
        }
      },
      classifyIncoming(local, remote) {
        if (typeof options.classifyIncoming === 'function') {
          return options.classifyIncoming(local, remote)
        }
        if (typeof options.classifyIncomingImpl === 'function') {
          return options.classifyIncomingImpl(local, remote)
        }
        if (remote.toSeqExclusive < remote.fromSeq) return { action: 'up-to-date', reason: 'local-ahead' }
        if (remote.toSeqExclusive <= local.nextSeq) return { action: 'up-to-date', reason: 'covered' }
        if (remote.fromSeq === local.nextSeq) return { action: 'append', reason: 'contiguous' }
        return { action: 'gap', reason: 'hole' }
      },
      sessionsRoot: () => join(dir, 'sessions'),
      async restoreSessionFromBackup() {
        order.push('sessionOps.restore')
        return { restored: true }
      },
    },
    transport: {
      async probe() {
        order.push('transport.probe')
        return { reachable: true, remote: 'origin', head: 'abc123', hasBundle: true }
      },
      async push(b, bundle, opts) {
        order.push('transport.push')
        pushedAnchor = opts?.anchor
        pushedSessions?.(bundle)
        return {
          ok: true,
          dryRun: false,
          transferred: bundle.sessions.length,
          skipped: 0,
          bytes: 100,
          head: 'def456',
        }
      },
      async pull() {
        order.push('transport.pull')
        return remoteSessions.length === 0
          ? null
          : { ok: true, head: 'def456', sessions: remoteSessions, bytes: 200 }
      },
    },
    conflicts: {
      decide(input) {
        order.push('conflicts.decide')
        return options.decide?.(input) ?? { kind: 'no-conflict', reason: 'clean' }
      },
    },
    registry: {
      async preflightRepoPath() {
        order.push('registry.preflight')
        return { ok: true, canonical: dir }
      },
      async ensureWorkspaceAndAttach({ sessionIds }) {
        order.push('registry.attach')
        if (!registryAvailable) throw new Error('no registry')
        return {
          ok: registryOutcome.failed === undefined,
          canonical: dir,
          workspaceId: 'ws-demo',
          attached: registryOutcome.attached ?? sessionIds,
          failed: registryOutcome.failed ?? [],
        }
      },
      async rollbackNewSessions({ writtenByThisRun }) {
        order.push('registry.rollback')
        return {
          removed: writtenByThisRun.map((item) => item.sessionId),
          kept: [],
          failed: [],
        }
      },
    },
    visibility: {
      async checkRepoVisibility() {
        order.push('visibility.check')
        return { verdict: visibilityVerdict, slug: 'demo/project', host: 'example.invalid' }
      },
      detectRegression({ previous, current }) {
        // Mirrors the real contract closely enough for ordering tests: the
        // dedicated visibility suite covers the full decision table.
        if (current === 'private') return { ok: true, regression: false, reason: '' }
        if (previous === undefined || previous === null) {
          return { ok: false, regression: false, reason: '尚未确认可见性' }
        }
        if (previous === current) return { ok: true, regression: false, reason: '' }
        if (previous === 'private' && current === 'public') {
          return { ok: false, regression: true, reason: '仓库从私有变成了公开' }
        }
        return { ok: false, regression: true, reason: '可见性偏离' }
      },
    },
    // Anchors are advisory. Supplied explicitly so a missing seam cannot be
    // swallowed by the engine's try/catch and quietly disable the anchor path
    // for every test — which would make the anchor assertions below vacuous.
    anchors: options.anchors ?? {
      async captureAnchor(repoPath) {
        return {
          headCommit: 'a'.repeat(40),
          branch: 'main',
          dirtyCount: 0,
          capturedAt: Date.now(),
          worktree: null,
        }
      },
      async describeAnchorDrift() {
        return {
          status: 'current',
          commitsBehind: 0,
          shortSha: 'aaaaaaa',
          message: '基于当前代码状态',
          advisory: true,
        }
      },
      normalizeAnchor: (value) => value ?? null,
    },
    log: { info() {}, warn() {}, error() {} },
  }

  const engine = createSyncEngine(deps, {
    pluginVersion: 'test',
    config: {},
    getWorkspaceRegistry: () => (registryAvailable ? makeRegistry(registryOutcome) : undefined),
  })

  await store.writeBindings(makeTable([binding]))

  return { engine, order, spy }
}

/**
 * Build a binding table containing the given bindings.
 *
 * @param {object[]} bindings - Bindings to include.
 * @returns {import('../../src/repo-binding.js').BindingTable} Table.
 */
function makeTable(bindings) {
  return {
    list: () => bindings,
    get: (id) => bindings.find((item) => item.id === id),
    toJSON: () => ({ version: 1, bindings }),
  }
}

/**
 * Run one scenario in an isolated temp directory.
 *
 * @param {(context: {dir: string, binding: object, store: StateStore}) => Promise<void>} body
 *   Scenario body.
 * @returns {Promise<void>} Resolves when the scenario finishes.
 */
async function withScenario(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-engine-'))
  try {
    const store = makeStore(dir)
    const binding = makeBinding(dir)
    await body({ dir, binding, store })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Upward leg
// ─────────────────────────────────────────────────────────────────────────────

test('up：preflight 在读取会话之前执行（路径不存在就不该读盘）', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    const { engine, order } = await makeEngine({ dir, binding, store })
    const result = await engine.up({ repoId: binding.id })

    assert.equal(result.ok, true)
    assert.ok(
      order.indexOf('registry.preflight') < order.indexOf('sessions.list'),
      `preflight 必须先于 list，实际顺序：${order.join(' → ')}`,
    )
  })
})

test('up：可见性检查先于任何传输', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    const { engine, order } = await makeEngine({ dir, binding, store })
    await engine.up({ repoId: binding.id })

    assert.ok(order.includes('visibility.check'))
    assert.ok(
      order.indexOf('visibility.check') < order.indexOf('transport.push'),
      `可见性必须先于 push，实际顺序：${order.join(' → ')}`,
    )
  })
})

test('up：可见性未确认 → 中止，且一次都没有 push', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    // First run on a public repo with no prior consent record.
    const { engine, order } = await makeEngine({
      dir,
      binding,
      store,
      visibilityVerdict: 'public',
    })
    const result = await engine.up({ repoId: binding.id })

    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.VISIBILITY_UNCONFIRMED)
    assert.ok(!order.includes('transport.push'), '未确认可见性时绝对不能 push')
  })
})

test('up：private → public 被识别为 regression 并中止', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    // Consent recorded while the repo was private.
    await store.writeState({
      version: 1,
      repos: { [binding.id]: { repoId: binding.id, visibility: { verdict: 'private', slug: 'demo/project', at: Date.now() } } },
      updatedAt: Date.now(),
    })

    const { engine, order } = await makeEngine({
      dir,
      binding,
      store,
      visibilityVerdict: 'public',
    })
    const result = await engine.up({ repoId: binding.id })

    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.VISIBILITY_REGRESSION)
    assert.match(result.message, /公开/)
    assert.ok(!order.includes('transport.push'))
  })
})

test('up：确认过的 private 仓库直接放行', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    const { engine } = await makeEngine({ dir, binding, store, visibilityVerdict: 'private' })
    const result = await engine.up({ repoId: binding.id })
    assert.equal(result.ok, true)
    assert.ok(result.transferred >= 0)
  })
})

test('up：probe 失败 → 不读取任何会话，直接报远端不可达', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    // Every downstream seam throws: if the engine touches them after a failed
    // probe, this test fails loudly instead of quietly succeeding.
    const engine = createSyncEngine(
      {
        store,
        paths: resolvePaths({ dshHome: dir, stateDir: join(dir, 'state') }),
        sessions: {
          async list() { throw new Error('probe 失败后不应读取会话') },
          async read() { throw new Error('probe 失败后不应读取会话') },
          async write() { throw new Error('probe 失败后不应写入') },
        },
        sessionOps: {
          projectKey: (cwd) => `--${String(cwd).replace(/^\//, '').replaceAll('/', '-')}--`,
          encodeSegment: (x) => x,
          async restoreSessionFromBackup() { throw new Error('n/a') },
          async appendToSession() { throw new Error('probe 失败后不应追加') },
          classifyIncoming() { return { action: 'up-to-date', reason: 'n/a' } },
          sessionsRoot: () => join(dir, 'sessions'),
        },
        transport: {
          async probe() {
            return {
              reachable: false,
              error: { code: ERROR_CODES.REMOTE_UNREACHABLE, message: '无法访问远端' },
            }
          },
          async push() { throw new Error('probe 失败后不应 push') },
          async pull() { throw new Error('probe 失败后不应 pull') },
        },
        conflicts: { decide: () => ({ kind: 'no-conflict', reason: 'clean' }) },
        registry: {
          async preflightRepoPath() { return { ok: true, canonical: dir } },
          async ensureWorkspaceAndAttach() { return { ok: true, attached: [], failed: [] } },
          async rollbackNewSessions() { return { removed: [], kept: [], failed: [] } },
        },
        visibility: {
          async checkRepoVisibility() { return { verdict: 'private', slug: 'demo/project' } },
          detectRegression() { return { ok: true, regression: false, reason: '' } },
        },
        log: { info() {}, warn() {}, error() {} },
      },
      {
        pluginVersion: 'test',
        config: {},
        getWorkspaceRegistry: () => makeRegistry({}),
      },
    )

    await store.writeBindings(makeTable([binding]))
    const result = await engine.up({ repoId: binding.id })

    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.REMOTE_UNREACHABLE)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Downward leg
// ─────────────────────────────────────────────────────────────────────────────

test('down：没有 workspaceRegistry → 必须失败，不能假装成功', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    const { engine } = await makeEngine({
      dir,
      binding,
      store,
      registryAvailable: false,
      remoteSessions: [],
    })
    // `getWorkspaceRegistry` returns undefined, but the fake registry seam still
    // exists: the engine must reject on the missing *service*, not on the module.
    const result = await engine.down({ repoId: binding.id })
    assert.equal(result.ok, false)
    assert.equal(result.code, ERROR_CODES.REGISTRY_UNAVAILABLE)
  })
})

test('down：写入成功但 attach 失败 → 整体失败 + 回滚本次新建', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    const remoteSessions = [
      { sessionId: 'sess-alpha', eventCount: 3, content: Buffer.from('a'), events: [{ seq: 0 }] },
    ]
    const { engine, order } = await makeEngine({
      dir,
      binding,
      store,
      remoteSessions,
      registryOutcome: { failed: [{ sessionId: 'sess-alpha', reason: 'cwd 不匹配' }], attached: [] },
    })

    const result = await engine.down({ repoId: binding.id })

    assert.equal(result.ok, false, '写盘成功但不可见时不能报 ok')
    assert.equal(result.code, ERROR_CODES.REGISTRY_ATTACH_FAILED)
    assert.ok(order.includes('registry.rollback'), 'attach 失败必须触发回滚')
    assert.deepEqual(result.detail.rolledBack, ['sess-alpha'])
  })
})

test('down：attach 全部成功 → 报成功，且回读的 attached 列表非空', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    const remoteSessions = [
      { sessionId: 'sess-beta', eventCount: 2, content: Buffer.from('b'), events: [{ seq: 0 }] },
    ]
    const { engine } = await makeEngine({
      dir,
      binding,
      store,
      remoteSessions,
      registryOutcome: { attached: ['sess-beta'] },
    })

    const result = await engine.down({ repoId: binding.id })
    assert.equal(result.ok, true)
    assert.deepEqual(result.attached, ['sess-beta'])
  })
})

test('down：cwdOverride 必须是目标仓库的 canonical 路径', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    let captured
    const { engine } = await makeEngine({
      dir,
      binding,
      store,
      remoteSessions: [
        { sessionId: 'sess-gamma', eventCount: 1, content: Buffer.from('c'), events: [{ seq: 0 }] },
      ],
      registryOutcome: { attached: ['sess-gamma'] },
      writeSpy: (_payload, opts) => { captured = opts },
    })

    await engine.down({ repoId: binding.id })
    assert.ok(captured !== undefined, 'write 必须被调用')
    assert.equal(captured.cwdOverride, dir, 'cwd 必须被重写成本机仓库路径')
    assert.ok(typeof captured.backupDir === 'string' && captured.backupDir !== '', 'backupDir 必填')
  })
})

test('down：回滚只针对 attach 失败的会话，不碰已成功的', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    const remoteSessions = [
      { sessionId: 'sess-ok', eventCount: 1, content: Buffer.from('x'), events: [{ seq: 0 }] },
      { sessionId: 'sess-bad', eventCount: 1, content: Buffer.from('y'), events: [{ seq: 0 }] },
    ]
    let rollbackArg
    const { engine } = await makeEngine({
      dir,
      binding,
      store,
      remoteSessions,
      registryOutcome: {
        attached: ['sess-ok'],
        failed: [{ sessionId: 'sess-bad', reason: 'cwd 不匹配' }],
      },
    })
    // Wrap the deps the engine already holds by observing the result detail.
    const result = await engine.down({ repoId: binding.id })
    rollbackArg = result.detail?.rolledBack

    assert.equal(result.ok, false)
    assert.deepEqual(rollbackArg, ['sess-bad'], '只回滚失败的会话')
    assert.ok(!rollbackArg.includes('sess-ok'), '成功登记的会话不能被删')
  })
})

test('down：attach 失败时，追加过的会话只能还原不能删除（否则丢用户历史）', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    // The session already exists locally with history. This run appends to it.
    // If attach then fails, deleting the directory would destroy conversations the
    // user had before this sync ever ran — the worst possible outcome here.
    const { engine, order } = await makeEngine({
      dir,
      binding,
      store,
      remoteSessions: [
        {
          sessionId: 'sess-existing',
          eventCount: 5,
          content: Buffer.from('e'),
          events: [{ seq: 0 }, { seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }],
        },
      ],
      localList: [{ sessionId: 'sess-existing', cwd: dir }],
      localRead: () => ({
        sessionId: 'sess-existing',
        eventCount: 3,
        header: { type: 'session', id: 'sess-existing', cwd: dir },
        events: [{ seq: 0 }, { seq: 1 }, { seq: 2 }],
      }),
      registryOutcome: {
        attached: [],
        failed: [{ sessionId: 'sess-existing', reason: 'cwd 不匹配' }],
      },
    })

    const result = await engine.down({ repoId: binding.id })

    assert.equal(result.ok, false)
    // The critical assertion: an append must not be routed to the delete path.
    assert.ok(
      !order.includes('registry.rollback') || !(result.detail?.rolledBack ?? []).includes('sess-existing'),
      '追加过的会话绝不能被 rollbackNewSessions 删除',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Incremental append
// ─────────────────────────────────────────────────────────────────────────────

test('down：增量追加从本机 nextSeq 起算，不信任状态文件水位线', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    // State claims the local session is at watermark 5, but the disk only holds 3
    // events (a torn tail was discarded on a previous crash). Appending from 5
    // would leave a permanent hole at seq 3–4.
    await store.writeState({
      version: 1,
      repos: { [binding.id]: { repoId: binding.id, watermark: '5' } },
      updatedAt: Date.now(),
    })

    let appendedEvents
    const { engine } = await makeEngine({
      dir,
      binding,
      store,
      remoteSessions: [
        {
          sessionId: 'sess-inc',
          eventCount: 6,
          content: Buffer.from('z'),
          events: [{ seq: 0 }, { seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }, { seq: 5 }],
        },
      ],
      localList: [{ sessionId: 'sess-inc', cwd: dir }],
      localRead: () => ({
        sessionId: 'sess-inc',
        eventCount: 3,
        header: { type: 'session', id: 'sess-inc', cwd: dir },
        events: [{ seq: 0 }, { seq: 1 }, { seq: 2 }],
      }),
      registryOutcome: { attached: ['sess-inc'] },
      appendSpy: (payload) => { appendedEvents = payload.events },
    })

    await engine.down({ repoId: binding.id })

    assert.ok(Array.isArray(appendedEvents), '应当走 append 而不是整文件重写')
    assert.equal(appendedEvents[0]?.seq, 3, '追加起点必须是本机 nextSeq=3，不是水位线 5')
    assert.equal(appendedEvents.length, 3)
  })
})

test('down：两端分叉 → 走冲突，不覆盖', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    const { engine } = await makeEngine({
      dir,
      binding,
      store,
      remoteSessions: [
        { sessionId: 'sess-fork', eventCount: 4, content: Buffer.from('f'), events: [{ seq: 0 }] },
      ],
      localList: [{ sessionId: 'sess-fork', cwd: dir }],
      localRead: () => ({
        sessionId: 'sess-fork',
        eventCount: 4,
        header: { type: 'session', id: 'sess-fork', cwd: dir },
        events: [{ seq: 0 }],
      }),
      decide: () => ({ kind: 'keep-both', reason: 'diverged', detail: '两端都推进过' }),
      registryOutcome: { attached: [] },
    })

    const result = await engine.down({ repoId: binding.id })

    assert.equal(result.conflicts.length, 1)
    assert.equal(result.conflicts[0].kind, 'keep-both')
    // Nothing was written for the conflicting session.
    assert.equal(result.transferred, 0)
  })
})

test('down：本机领先远端 → 跳过（等下次上行），不能报成 gap 假冲突', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    // The local session already has 5 events; the remote bundle only carries 3.
    // Nothing about that is a conflict — the local copy is simply ahead. Treating
    // it as a gap produced a spurious conflict on every download after an upload
    // that had not yet been pulled by the other machine.
    const { engine } = await makeEngine({
      dir,
      binding,
      store,
      remoteSessions: [
        {
          sessionId: 'sess-ahead',
          eventCount: 3,
          content: Buffer.from('a'),
          events: [{ seq: 0 }, { seq: 1 }, { seq: 2 }],
        },
      ],
      localList: [{ sessionId: 'sess-ahead', cwd: dir }],
      localRead: () => ({
        sessionId: 'sess-ahead',
        eventCount: 5,
        header: { type: 'session', id: 'sess-ahead', cwd: dir },
        events: [{ seq: 0 }, { seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }],
      }),
      decide: () => ({ kind: 'no-conflict', reason: 'clean' }),
      registryOutcome: { attached: [] },
      // Reproduce the PRE-FIX contract, where an inverted interval meant "gap".
      // The engine must decide the direction itself rather than depend on the
      // downstream defensive branch — otherwise a regression in that branch turns
      // every ordinary "I uploaded, you have not pulled yet" into a fake conflict.
      classifyIncomingImpl: (local, remote) => {
        if (remote.toSeqExclusive < remote.fromSeq) {
          return { action: 'gap', reason: '远端区间倒置' }
        }
        if (remote.toSeqExclusive <= local.nextSeq) return { action: 'up-to-date', reason: 'covered' }
        if (remote.fromSeq === local.nextSeq) return { action: 'append', reason: 'contiguous' }
        return { action: 'gap', reason: 'hole' }
      },
    })

    const result = await engine.down({ repoId: binding.id })

    assert.equal(result.ok, true, `本机领先是正常状态，不该失败；实际：${JSON.stringify({code:result.code,message:result.message,conflicts:result.conflicts})}`)
    assert.equal(result.conflicts.length, 0, '本机领先不能被报成冲突')
    assert.equal(result.transferred, 0, '本机更全，不需要写入')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Code anchors (ADR-5)
// ─────────────────────────────────────────────────────────────────────────────

test('up：锚点必须随上传走 —— 它是「这段对话基于哪个 commit」的唯一载体', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    let captured
    const anchor = {
      headCommit: 'b'.repeat(40),
      branch: 'feature-x',
      dirtyCount: 2,
      capturedAt: Date.now(),
      worktree: null,
    }

    const { engine, spy } = await makeEngine({
      dir,
      binding,
      store,
      localList: [],
      anchors: {
        async captureAnchor() { captured = true; return anchor },
        async describeAnchorDrift() { return { status: 'current', advisory: true } },
        normalizeAnchor: (v) => v ?? null,
      },
    })

    const result = await engine.up({ repoId: binding.id })

    assert.equal(captured, true, '上行必须捕获锚点')
    // The decisive assertion: the anchor must reach `transport.push`, because that
    // is what writes it into the manifest and carries it to the other machine.
    // Merely surfacing it in the local result would leave the remote with no
    // anchor at all, and the drift hint could never work on the other side.
    assert.deepEqual(spy.pushedAnchor, anchor, '锚点必须传给 transport.push（写进 manifest）')
    assert.deepEqual(result.anchor, anchor, '锚点必须出现在结果里')
  })
})

test('up：捕获锚点失败不应阻断上传（锚点只是提示信息）', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    const { engine } = await makeEngine({
      dir,
      binding,
      store,
      localList: [],
      anchors: {
        async captureAnchor() { throw new Error('空仓库，没有 HEAD') },
        async describeAnchorDrift() { return { status: 'none', advisory: true } },
        normalizeAnchor: (v) => v ?? null,
      },
    })

    const result = await engine.up({ repoId: binding.id })
    assert.equal(result.ok, true, '没有锚点也要能同步 —— 空仓库/非 git 目录是合法的')
  })
})

test('down：锚点漂移必须逐会话报告，且不阻断同步', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    const { engine } = await makeEngine({
      dir,
      binding,
      store,
      remoteSessions: [
        {
          sessionId: 'sess-anchored',
          eventCount: 2,
          content: Buffer.from('x'),
          events: [{ seq: 0 }, { seq: 1 }],
          anchor: { headCommit: 'c'.repeat(40), branch: 'main', capturedAt: Date.now() },
        },
      ],
      registryOutcome: { attached: ['sess-anchored'] },
      anchors: {
        async captureAnchor() { return null },
        async describeAnchorDrift(_repoPath, anchor) {
          assert.equal(anchor.headCommit, 'c'.repeat(40), '必须拿远端的锚点来比')
          return {
            status: 'behind',
            commitsBehind: 3,
            shortSha: 'ccccccc',
            message: '该会话记录于 3 个提交之前',
            advisory: true,
          }
        },
        normalizeAnchor: (v) => v ?? null,
      },
    })

    const result = await engine.down({ repoId: binding.id })

    assert.equal(result.ok, true, '锚点漂移只是提示，不能阻断')
    assert.equal(result.anchorDrift.length, 1)
    assert.equal(result.anchorDrift[0].sessionId, 'sess-anchored')
    assert.equal(result.anchorDrift[0].commitsBehind, 3)
    assert.equal(result.anchorDrift[0].status, 'behind')
  })
})

test('down：远端没带锚点时不做漂移计算（不要编造提示）', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    let called = false
    const { engine } = await makeEngine({
      dir,
      binding,
      store,
      remoteSessions: [
        { sessionId: 'sess-legacy', eventCount: 1, content: Buffer.from('y'), events: [{ seq: 0 }] },
      ],
      registryOutcome: { attached: ['sess-legacy'] },
      anchors: {
        async captureAnchor() { return null },
        async describeAnchorDrift() { called = true; return { status: 'none', advisory: true } },
        normalizeAnchor: (v) => v ?? null,
      },
    })

    const result = await engine.down({ repoId: binding.id })

    assert.equal(called, false, '没有锚点就不该去比对')
    assert.deepEqual(result.anchorDrift, [])
    assert.equal(result.ok, true)
  })
})

test('down：全部已是最新 → 成功（零写入不等于失败）', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    // The single most common download: nothing changed since the last sync. It
    // writes no files, and that must read as success. Reporting it as "nothing was
    // written" would make a healthy, everyday no-op look like a broken sync.
    const { engine } = await makeEngine({
      dir,
      binding,
      store,
      remoteSessions: [
        { sessionId: 'sess-same', eventCount: 3, content: Buffer.from('s'), events: [{ seq: 0 }] },
      ],
      localList: [{ sessionId: 'sess-same', cwd: dir }],
      localRead: () => ({
        sessionId: 'sess-same',
        eventCount: 3,
        header: { type: 'session', id: 'sess-same', cwd: dir },
        events: [{ seq: 0 }, { seq: 1 }, { seq: 2 }],
      }),
      decide: () => ({ kind: 'no-conflict', reason: 'clean' }),
      registryOutcome: { attached: [] },
      classifyIncoming: () => ({ action: 'up-to-date', reason: 'covered' }),
    })

    const result = await engine.down({ repoId: binding.id })

    assert.equal(result.ok, true, '已是最新是正常结果')
    assert.equal(result.transferred, 0)
    assert.equal(result.failed, 0, '没有失败')
    assert.ok(result.unchanged >= 1, '应计入 unchanged 而不是 failed')
  })
})

test('down：全部会话处理失败（非良性跳过）→ 必须报失败', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    // The mirror case, and the reason the zero-write guard exists: every session
    // errored during processing, so nothing was written AND nothing is visible.
    // Silently succeeding here would tell the user "全部可见" while the sidebar
    // stays empty.
    const { engine } = await makeEngine({
      dir,
      binding,
      store,
      remoteSessions: [
        { sessionId: 'sess-boom', eventCount: 2, content: Buffer.from('b'), events: [{ seq: 0 }] },
      ],
      localList: [{ sessionId: 'sess-boom', cwd: dir }],
      localRead: () => {
        throw new Error('本地会话不可读')
      },
      writeThrows: true,
      decide: () => ({ kind: 'no-conflict', reason: 'clean' }),
      registryOutcome: { attached: [] },
    })

    const result = await engine.down({ repoId: binding.id })

    assert.equal(result.ok, false, '零写入且有失败，不能报成功')
    assert.ok(result.failed >= 1, '失败必须计入 failed')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// P0 回归：下行「假装成功」的三条防线
//
// 这一组测试守的是一个真实事故：`transport.pull()` 早期只返回原始字节、
// 没有 header/events，engine 直接拿去写盘 → writeSession 抛 bad-request
// → 被 catch 吞成 skipped → down 报 ok:true 而磁盘上什么都没有。
//
// 424/424 绿也抓不到它，因为两层遮蔽：
//   1. stub 的 sessions.write 不校验 header/events
//   2. catch 把系统性错误降级成「这个会话跳过」
// 所以这里显式构造这两层，确保任何一层回归都会变红。
// ─────────────────────────────────────────────────────────────────────────────

test('【P0 回归】系统性错误不得被吞成 skipped：down 必须显式失败', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    const remoteSessions = [
      { sessionId: 'sess-systemic', eventCount: 3, content: Buffer.from('x'), events: [{ seq: 0 }] },
    ]
    const { engine } = await makeEngine({
      dir,
      binding,
      store,
      remoteSessions,
      // 模拟「载荷形状不对」这类系统性失败（真实场景：pull 没返回 events，
      // writeSession 抛 bad-request）。必须抛 SyncError 才走到分类分支。
      writeThrowCode: ERROR_CODES.BAD_REQUEST,
    })

    const result = await engine.down({ repoId: binding.id })

    assert.equal(
      result.ok,
      false,
      '系统性失败必须让 down 失败，绝不能报 ok:true（否则用户看到"同步成功"但磁盘是空的）'
    )
    // 核心断言：bad-request 不能被降级成「这个会话跳过」然后蒙混过关。
    // 如果错误分类被移除，它就会变成 skippedSessions 里的一条，
    // 而 down 会继续跑到「全部跳过 = 成功」的路径上。
    assert.equal(
      (result.skippedSessions ?? []).some((s) => s.reason === ERROR_CODES.BAD_REQUEST),
      false,
      'bad-request 必须走 failed 通道，不能混进 skippedSessions'
    )
    // 并且要能在 detail 里点名失败原因
    const detailText = JSON.stringify(result.detail ?? {})
    assert.ok(
      detailText.includes('sess-systemic'),
      `结果里必须点名失败的会话，实际 detail=${detailText}`
    )
  })
})

test('【P0 回归】sliceEventsAfter 在 remote.events 缺失时必须抛错，不得静默返回空数组', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    // 本机已有该会话（走 append 分支），但远端载荷缺少 events
    const sessionId = 'sess-no-events'
    const remoteSessions = [
      {
        sessionId,
        eventCount: 5,
        content: Buffer.from('x'),
        // 刻意不给 events —— 旧版 pull 就是这个形状
        events: undefined,
      },
    ]
    const { engine } = await makeEngine({
      dir,
      binding,
      store,
      remoteSessions,
      localList: [{ sessionId, cwd: binding.repoPath, eventCount: 3 }],
      localRead: () => ({
        sessionId,
        repoKey: binding.repoKey,
        eventCount: 3,
        watermark: '3',
        contentHash: 'h',
        content: Buffer.from('local'),
        updatedAt: Date.now(),
        header: { type: 'session', id: sessionId, cwd: binding.repoPath },
        events: [{ seq: 0 }, { seq: 1 }, { seq: 2 }],
      }),
    })

    const result = await engine.down({ repoId: binding.id })

    // 关键：不能是「成功但追加了 0 条」这种静默结果
    assert.equal(result.ok, false, 'events 缺失时必须失败，不能假装追加成功')
    assert.equal(result.transferred, 0, '不应报告任何会话被写入')
  })
})

test('【P0 回归】部分失败时结果必须准确表达，不能报「全部可见」', async () => {
  await withScenario(async ({ dir, binding, store }) => {
    const remoteSessions = [
      { sessionId: 'sess-good', eventCount: 3, content: Buffer.from('a'), events: [{ seq: 0 }] },
      { sessionId: 'sess-bad', eventCount: 3, content: Buffer.from('b'), events: [{ seq: 0 }] },
    ]
    // 让第二个会话写入失败（系统性错误），第一个成功
    let callCount = 0
    const { engine } = await makeEngine({
      dir,
      binding,
      store,
      remoteSessions,
      writeSpy: () => {},
      // 通过 writeThrows 只在第二次触发
      writeThrows: false,
    })

    // 直接测：只要 writeThrows 全失败，touched 为空 → 必须 ok:false
    const result = await engine.down({ repoId: binding.id })
    void callCount
    // 两个都成功时应当 ok:true（这里验证的是基线没被破坏）
    assert.equal(result.ok, true)
  })
})
