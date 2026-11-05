/**
 * The definitive "did the download actually work?" test.
 *
 * This is the assertion set the lead asked for, and it exists because of a real
 * P0: `engine.down()` used to return `ok: true` having written nothing at all.
 * The engine handed `transport.pull()`'s record straight to `sessions.write()`,
 * but that record carries only raw `content` — no `header`, no `events` — so the
 * write failed with `bad-request` and the failure was swallowed into
 * `skippedSessions`.
 *
 * Every assertion below is about an OBSERVABLE SIDE EFFECT on B's disk, not about
 * a return value. That distinction is the whole point:
 *
 *   "returned ok" is not "worked".
 *
 * Covered:
 *   1. a session pulled for the first time really lands on B, with the same
 *      logical conversation as A
 *   2. the append path: B has 2 rounds, A has 3 -> B ends up with exactly 3
 *      (not 2 = nothing happened, not 5 = duplicated)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fixtureSessionId, listFiles, makeTempDshHome, writeSession } from '../lib/fixtures.mjs';
import { decodeSessionEvents } from '../lib/zstd-frame.mjs';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function load(name) {
  try {
    return await import(`../../src/${name}`);
  } catch {
    return null;
  }
}

/** A workspace registry stub that reports the session as successfully attached. */
function attachedRegistry(sessionIds) {
  return {
    async resolveByPath() {
      return undefined;
    },
    async create() {
      return {
        id: 'ws-evidence',
        get sessionIds() {
          return sessionIds;
        },
        async attachSession() {},
      };
    },
  };
}

/** A permissive visibility seam — a local bare repo has no host to check. */
function permissiveVisibility() {
  return {
    checkRepoVisibility: async () => ({ verdict: 'private', slug: 'local/test', host: 'local' }),
    detectRegression: () => ({ ok: true, regression: false, reason: '' }),
  };
}

/** Build a real engine bound to a sandboxed DSH home. */
async function buildEngine({ home, registrySessionIds }) {
  const [pathsMod, storeMod, depsMod, engineMod] = await Promise.all([
    load('paths.js'),
    load('store.js'),
    load('deps.js'),
    load('engine.js'),
  ]);
  if (!pathsMod || !storeMod || !depsMod || !engineMod) return null;

  const paths = pathsMod.resolvePaths({ dshHome: home.root });
  mkdirSync(paths.stateDir, { recursive: true });
  const store = new storeMod.StateStore(paths);
  const log = { info() {}, warn() {}, error() {} };
  const deps = await depsMod.assembleDependencies({ store, paths, log });
  deps.visibility = permissiveVisibility();

  const engine = engineMod.createSyncEngine(deps, {
    pluginVersion: '0.0.0-test',
    config: {},
    getWorkspaceRegistry: () => attachedRegistry(registrySessionIds),
  });
  return { engine, store, paths };
}

/** Find a session file on disk by id, without relying on the directory encoding. */
function findSessionFile(home, sessionId) {
  const needle = sessionId.replace(/^session-/, '');
  return listFiles(join(home.root, 'sessions')).find(
    (file) => file.endsWith('session.v4.jsonl.zstd') && file.includes(needle),
  );
}

/** Logical view of a conversation: event types and seqs, ignoring machine-local cwd. */
function logicalEvents(events) {
  return events
    .filter((event) => event.type !== 'session')
    .map((event) => ({ type: event.type, seq: event.seq }));
}

function roundsIn(events) {
  const turns = new Set();
  for (const event of events) {
    if (event.type === 'turn/start' && event.data && typeof event.data.turn === 'number') {
      turns.add(event.data.turn);
    }
  }
  return turns.size;
}

test('evidence: a first-time pull really writes the session to disk with A\'s conversation', async (t) => {
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

  // A: a session with 3 rounds, pushed to the remote.
  const sessionId = fixtureSessionId(61);
  const sessionOnA = writeSession({ dshHome: homeA.root, sessionId, cwd: repoA, rounds: 3 });
  const eventsOnA = decodeSessionEvents(readFileSync(sessionOnA.file));
  assert.equal(roundsIn(eventsOnA), 3, 'fixture sanity: A has 3 rounds');

  const transport = transportModule.createTransport({});
  const pushed = await transport.push(
    { repoPath: repoA },
    { sessions: [{ sessionId, content: readFileSync(sessionOnA.file) }] },
  );
  assert.equal(pushed.ok, true, `push failed: ${JSON.stringify(pushed)}`);

  // B: completely empty for this session.
  assert.deepEqual(listFiles(join(homeB.root, 'sessions')), [], 'B starts with no sessions at all');

  const built = await buildEngine({ home: homeB, registrySessionIds: [sessionId] });
  if (!built) {
    t.skip('engine deps not available');
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
  assert.equal(down.ok, true, `down failed: ${JSON.stringify(down)}`);

  // ── EVIDENCE 1: a file actually exists on B's disk ──
  const fileOnB = findSessionFile(homeB, sessionId);
  assert.ok(
    fileOnB !== undefined,
    'EVIDENCE FAILED: down() reported success but no session file was written to B. ' +
      `Files under B's sessions root: ${JSON.stringify(listFiles(join(homeB.root, 'sessions')))}`,
  );
  assert.ok(existsSync(fileOnB), `session file should exist: ${fileOnB}`);

  // ── EVIDENCE 2: it contains A's full conversation ──
  const eventsOnB = decodeSessionEvents(readFileSync(fileOnB));
  assert.equal(roundsIn(eventsOnB), 3, 'B must see all 3 of A\'s rounds');

  // ── EVIDENCE 3: the logical conversation matches A exactly ──
  assert.deepEqual(
    logicalEvents(eventsOnB),
    logicalEvents(eventsOnA),
    'the conversation on B must be logically identical to A (cwd legitimately differs)',
  );

  // And the header must have been rewritten to B's repo path, not A's.
  const headerOnB = eventsOnB.find((event) => event.type === 'session');
  // Compare canonical paths: macOS resolves /var -> /private/var, so a raw string
  // comparison reports a false failure on an otherwise correct implementation.
  const { realpathSync } = await import('node:fs');
  assert.equal(
    realpathSync(headerOnB.cwd),
    realpathSync(repoB),
    "the header cwd must be rewritten to B's repo path; otherwise DSH cannot see the session",
  );
});

test('evidence: appending pulls only the missing rounds (2 rounds + 1 new = 3, not 5)', async (t) => {
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
  const repoA = makeRepo('repo-append-a');
  const repoB = makeRepo('repo-append-b');

  const homeA = makeTempDshHome(base);
  const homeB = makeTempDshHome(base);
  t.after(() => {
    homeA.dispose();
    homeB.dispose();
  });

  const sessionId = fixtureSessionId(62);

  // B already has 2 rounds of its own.
  const sessionOnB = writeSession({ dshHome: homeB.root, sessionId, cwd: repoB, rounds: 2 });
  assert.equal(roundsIn(decodeSessionEvents(readFileSync(sessionOnB.file))), 2);

  // A has 3 rounds: one more than B.
  const sessionOnA = writeSession({ dshHome: homeA.root, sessionId, cwd: repoA, rounds: 3 });
  const transport = transportModule.createTransport({});
  const pushed = await transport.push(
    { repoPath: repoA },
    { sessions: [{ sessionId, content: readFileSync(sessionOnA.file) }] },
  );
  assert.equal(pushed.ok, true, `push failed: ${JSON.stringify(pushed)}`);

  const built = await buildEngine({ home: homeB, registrySessionIds: [sessionId] });
  if (!built) {
    t.skip('engine deps not available');
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
  assert.equal(
    down.ok,
    true,
    `down failed: ${JSON.stringify(down)}. ` +
      'A local session file alone is not enough for the engine to consider the repo usable; ' +
      'the failure reason is in skippedSessions.',
  );

  const fileOnB = findSessionFile(homeB, sessionId);
  assert.ok(fileOnB !== undefined, 'B must still have its session file');

  const eventsAfter = decodeSessionEvents(readFileSync(fileOnB));

  // ── EVIDENCE 4: exactly 3 rounds ──
  // 2 would mean nothing was appended (the run did nothing);
  // 5 would mean the payload was applied on top of itself (duplicated).
  assert.equal(
    roundsIn(eventsAfter),
    3,
    `after pulling A's 3 rounds onto B's 2, B must have exactly 3 rounds ` +
      `(2 = append did nothing, 5 = duplicated). Got ${roundsIn(eventsAfter)}. ` +
      `events=${eventsAfter.length}`,
  );

  // seq must remain contiguous — a duplicated or gapped append breaks this.
  const seqs = eventsAfter.filter((e) => typeof e.seq === 'number').map((e) => e.seq);
  assert.deepEqual(
    seqs,
    seqs.map((_, i) => i),
    'seq must stay contiguous from 0 after an append-style pull',
  );
});
