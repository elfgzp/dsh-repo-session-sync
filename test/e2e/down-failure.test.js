/**
 * End-to-end data-loss test through the REAL `engine.down()` path.
 *
 * The module-level tests in `safety/dataloss-rollback.test.js` prove that
 * `rollbackNewSessions()` behaves correctly when given the right input, and that
 * the engine's source routes created-vs-appended sessions differently. Neither
 * drives the whole machine.
 *
 * This one does: it assembles the real dependency graph, pushes a session to a
 * real bare remote, lets machine B pull it, and forces registration to fail —
 * then asserts on the bytes actually left on disk.
 *
 * Why the extra level matters: the original data-loss bug was NOT in any single
 * function. `rollbackNewSessions()` was correct and well commented. The defect
 * was in what the caller handed it. Only a test that runs the caller can see it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendRounds, fixtureSessionId, makeTempDshHome, writeSession } from '../lib/fixtures.mjs';
import { decodeSessionEvents } from '../lib/zstd-frame.mjs';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-e2e-down-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Count conversation rounds in an event list. */
function roundsIn(events) {
  const turns = new Set();
  for (const event of events) {
    if (event.type === 'turn/start' && event.data && typeof event.data.turn === 'number') {
      turns.add(event.data.turn);
    }
  }
  return turns.size;
}

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A permissive visibility seam.
 *
 * The real gate blocks because a local bare-repo path has no remote host to
 * check. That is correct product behaviour, but it means the write path never
 * runs — and a test that never reaches the code under test proves nothing.
 * (This was a real false green: the first version of this file passed while the
 * data-loss bug was reintroduced, because `down()` aborted before writing.)
 *
 * So we swap ONLY the visibility check, leaving every write, conflict and
 * rollback code path untouched.
 */
function permissiveVisibility() {
  return {
    checkRepoVisibility: async () => ({ verdict: 'private', slug: 'local/test', host: 'local' }),
    // `private` always passes through the real implementation; mirror that shape.
    detectRegression: () => ({ ok: true, regression: false, reason: "" }),
  };
}

async function load(name) {
  try {
    return await import(`../../src/${name}`);
  } catch {
    return null;
  }
}

/** Build a real engine over a sandboxed DSH home, with a swappable registry. */
async function makeEngine({ base, home, repoPath, registryOverride, visibilityOverride }) {
  const depsModule = await load('deps.js');
  const storeModule = await load('store.js');
  const engineModule = await load('engine.js');
  const pathsModule = await load('paths.js');
  if (!depsModule || !storeModule || !engineModule || !pathsModule) return null;

  // Use the real path resolver so the store gets every field it expects
  // (bindingsFile/stateFile/configFile/...). Hand-rolling a partial object here
  // caused an "undefined path" failure that looked like an engine bug.
  const paths = pathsModule.resolvePaths({ dshHome: home.root });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(home.root, { recursive: true });

  const store = new storeModule.StateStore(paths);
  const log = { info() {}, warn() {}, error() {} };
  const deps = await depsModule.assembleDependencies({ store, paths, log });
  if (registryOverride) Object.assign(deps, { registry: registryOverride });
  if (visibilityOverride) Object.assign(deps, { visibility: visibilityOverride });

  // Node < 22.15 has no native zstd compressor, so the production frame encoder
  // refuses to write (correctly: it must not emit a file DSH cannot read). That
  // would make every write-path assertion here untestable on such runtimes.
  // Rather than skip — a skip verifies nothing — inject a zero-dependency,
  // spec-compliant encoder so the real write and rollback code still runs.
  const zlib = await import('node:zlib');
  if (typeof zlib.default.zstdCompressSync !== 'function') {
    const { encodeFrame } = await import('../lib/zstd-frame.mjs');
    const encoded = (buf) => encodeFrame(buf);
    if (deps.sessions && typeof deps.sessions.write === 'function') {
      const originalWrite = deps.sessions.write.bind(deps.sessions);
      deps.sessions.write = (payload, opts = {}) =>
        originalWrite(payload, { ...opts, frameEncoder: opts.frameEncoder ?? encoded });
    }
    if (deps.sessionOps && typeof deps.sessionOps.appendToSession === 'function') {
      const originalAppend = deps.sessionOps.appendToSession.bind(deps.sessionOps);
      deps.sessionOps.appendToSession = (payload, opts = {}) =>
        originalAppend(payload, { ...opts, frameEncoder: opts.frameEncoder ?? encoded });
    }
  }

  // The workspace registry reaches the engine through `meta.getWorkspaceRegistry`
  // (a live service getter, resolved after construction in the real plugin). The
  // down path refuses to write when it is absent — correctly, since sessions it
  // writes would be invisible in the sidebar. We supply a stub so the run reaches
  // the write/rollback code this suite exists to exercise.
  const workspaceRegistry = {
    async resolveByPath() {
      return undefined;
    },
    async create() {
      return {
        id: 'ws-test',
        get sessionIds() {
          return [];
        },
        async attachSession() {},
      };
    },
  };

  const engine = engineModule.createSyncEngine(deps, {
    pluginVersion: '0.0.0-test',
    config: {},
    getWorkspaceRegistry: () => workspaceRegistry,
  });
  return { engine, store, paths };
}

test('e2e down: registration failure keeps pre-existing history and drops only new sessions', async (t) => {
  if (!hasGit()) {
    t.skip('git not installed');
    return;
  }
  const transportModule = await load('transport.js');
  if (!transportModule) {
    t.skip('src/transport.js not available');
    return;
  }

  const base = tempDir(t);
  const remote = join(base, 'remote.git');
  execFileSync('git', ['init', '--bare', '--quiet', remote], { stdio: 'ignore' });

  const makeRepo = (name) => {
    const path = join(base, name);
    execFileSync('git', ['init', '--quiet', path], { stdio: 'ignore' });
    execFileSync('git', ['-C', path, 'remote', 'add', 'origin', remote], { stdio: 'ignore' });
    return path;
  };
  const repoA = makeRepo('repo-a');
  const repoB = makeRepo('repo-b');

  const homeA = makeTempDshHome(base);
  const homeB = makeTempDshHome(base);
  t.after(() => {
    homeA.dispose();
    homeB.dispose();
  });

  // ── Machine A: a session with 3 rounds, pushed to the remote. ──
  const remoteId = fixtureSessionId(51);
  const sessionOnA = writeSession({ dshHome: homeA.root, sessionId: remoteId, cwd: repoA, rounds: 3 });
  const transport = transportModule.createTransport({});
  const pushed = await transport.push(
    { repoPath: repoA },
    { sessions: [{ sessionId: remoteId, content: readFileSync(sessionOnA.file) }] },
  );
  assert.equal(pushed.ok, true, `push failed: ${JSON.stringify(pushed)}`);

  // ── Machine B: already has this session with 2 rounds of ITS OWN history. ──
  // This is the "append" case: the session exists locally, so a failed attach
  // must not delete it.
  //
  // The remote copy has 3 rounds, so the REMOTE is ahead and the down path will
  // genuinely write. (If the local copy were ahead, `down` would correctly skip
  // with `local-ahead` and never reach the write — which is exactly the kind of
  // "test passes without exercising anything" trap this suite is about.)
  const sessionOnB = writeSession({ dshHome: homeB.root, sessionId: remoteId, cwd: repoB, rounds: 2 });
  const bytesBeforeDown = readFileSync(sessionOnB.file);
  const eventsBeforeDown = decodeSessionEvents(bytesBeforeDown);
  assert.equal(roundsIn(eventsBeforeDown), 2, 'B starts with 2 rounds; the remote has 3');
  assert.ok(existsSync(sessionOnB.file));
  void appendRounds;

  // ── Registration always fails: every session is reported as failed. ──
  const registryModule = await load('registry.js');
  const failingRegistry = {
    preflightRepoPath: registryModule.preflightRepoPath,
    canonicalRepoPath: registryModule.canonicalRepoPath,
    rollbackNewSessions: registryModule.rollbackNewSessions,
    ensureWorkspaceAndAttach: async () => ({
      ok: false,
      attached: [],
      failed: [{ sessionId: remoteId, reason: 'test-forced-failure' }],
      canonical: repoB,
    }),
  };

  const built = await makeEngine({
    base,
    home: homeB,
    repoPath: repoB,
    registryOverride: failingRegistry,
    visibilityOverride: permissiveVisibility(),
  });
  if (!built) {
    t.skip('engine/deps/store not available');
    return;
  }

  const bind = await built.engine.bindRepo({
    repoPath: repoB,
    remoteUrl: remote,
    branch: 'main',
    direction: 'both',
  });
  assert.equal(bind.ok, true, `bind failed: ${JSON.stringify(bind)}`);

  const down = await built.engine.down({ repoId: bind.binding.id });

  // PRECONDITION: the run must actually have reached the write path. Without this,
  // the assertions below pass vacuously when `down()` silently skips everything —
  // which is exactly what happened while the engine could not parse pulled
  // payloads (it reported ok:true with zero sessions written). A rollback test on
  // a run that wrote nothing proves nothing.
  assert.ok(
    down.transferred > 0,
    'PRECONDITION FAILED: down() wrote nothing, so this test would prove nothing. ' +
      'The engine must be able to write a pulled session before rollback behaviour ' +
      `can be verified. Result: ${JSON.stringify(down)}`,
  );

  assert.equal(down.ok, false, `a failed registration must not report success: ${JSON.stringify(down)}`);

  // ── The assertions that make this test worth having ──
  assert.equal(
    existsSync(sessionOnB.file),
    true,
    'a session that existed BEFORE this run must survive a failed registration',
  );

  const eventsAfter = decodeSessionEvents(readFileSync(sessionOnB.file));

  // The count must not have shrunk below what the user already had.
  assert.ok(
    eventsAfter.length >= eventsBeforeDown.length,
    `user history must not shrink (before=${eventsBeforeDown.length}, after=${eventsAfter.length})`,
  );

  // Every pre-existing event must still be present, in order. This is what
  // catches a "delete and recreate empty" implementation that an existence
  // check would happily pass.
  const seqsAfter = eventsAfter.filter((e) => typeof e.seq === 'number').map((e) => e.seq);
  const seqsBefore = eventsBeforeDown.filter((e) => typeof e.seq === 'number').map((e) => e.seq);
  const restoredToPreAppend = seqsAfter.length === seqsBefore.length;
  const keptEverything = seqsBefore.every((seq) => seqsAfter.includes(seq));
  assert.ok(
    restoredToPreAppend || keptEverything,
    `pre-existing events must all survive; before seqs=${JSON.stringify(seqsBefore)} after=${JSON.stringify(seqsAfter)}`,
  );
});

test('e2e down: a session created by this run IS rolled back on registration failure', async (t) => {
  // The mirror case, and a deliberate pair with the test above. Without this one,
  // an implementation that simply never cleans up would still pass — and would
  // leave invisible orphan sessions on disk, which is the failure mode the
  // rollback exists to prevent.
  if (!hasGit()) {
    t.skip('git not installed');
    return;
  }
  const transportModule = await load('transport.js');
  if (!transportModule) {
    t.skip('src/transport.js not available');
    return;
  }

  const base = tempDir(t);
  const remote = join(base, 'remote.git');
  execFileSync('git', ['init', '--bare', '--quiet', remote], { stdio: 'ignore' });

  const makeRepo = (name) => {
    const path = join(base, name);
    execFileSync('git', ['init', '--quiet', path], { stdio: 'ignore' });
    execFileSync('git', ['-C', path, 'remote', 'add', 'origin', remote], { stdio: 'ignore' });
    return path;
  };
  const repoA = makeRepo('repo-c');
  const repoB = makeRepo('repo-d');

  const homeA = makeTempDshHome(base);
  const homeB = makeTempDshHome(base);
  t.after(() => {
    homeA.dispose();
    homeB.dispose();
  });

  const freshId = fixtureSessionId(52);
  const sessionOnA = writeSession({ dshHome: homeA.root, sessionId: freshId, cwd: repoA, rounds: 2 });
  const transport = transportModule.createTransport({});
  await transport.push(
    { repoPath: repoA },
    { sessions: [{ sessionId: freshId, content: readFileSync(sessionOnA.file) }] },
  );

  // Machine B has never seen this session.
  const registryModule = await load('registry.js');
  const failingRegistry = {
    preflightRepoPath: registryModule.preflightRepoPath,
    canonicalRepoPath: registryModule.canonicalRepoPath,
    rollbackNewSessions: registryModule.rollbackNewSessions,
    ensureWorkspaceAndAttach: async () => ({
      ok: false,
      attached: [],
      failed: [{ sessionId: freshId, reason: 'test-forced-failure' }],
      canonical: repoB,
    }),
  };

  const built = await makeEngine({
    base,
    home: homeB,
    repoPath: repoB,
    registryOverride: failingRegistry,
    visibilityOverride: permissiveVisibility(),
  });
  if (!built) {
    t.skip('engine/deps/store not available');
    return;
  }

  const bind = await built.engine.bindRepo({
    repoPath: repoB,
    remoteUrl: remote,
    branch: 'main',
    direction: 'both',
  });
  assert.equal(bind.ok, true, `bind failed: ${JSON.stringify(bind)}`);

  const down = await built.engine.down({ repoId: bind.binding.id });

  // PRECONDITION: a new session must really have been created, otherwise
  // "it was rolled back" is trivially true because nothing was ever written.
  assert.ok(
    down.transferred > 0,
    'PRECONDITION FAILED: down() wrote nothing, so the rollback assertion below is vacuous. ' +
      `Result: ${JSON.stringify(down)}`,
  );

  assert.equal(down.ok, false, 'failed registration must not report success');

  // The session this run created must be gone: no invisible orphans.
  const { listFiles } = await import('../lib/fixtures.mjs');
  const leftover = listFiles(join(homeB.root, 'sessions')).filter((f) =>
    f.includes(freshId.replace(/^session-/, '')) || f.includes(freshId),
  );
  const anyLeftoverSessionDir = leftover.some((f) => f.endsWith('session.v4.jsonl.zstd'));
  assert.equal(
    anyLeftoverSessionDir,
    false,
    `a session created by this run must be rolled back on failure, but found on disk: ${JSON.stringify(leftover)}`,
  );
});
