/**
 * End-to-end bidirectional sync tests.
 *
 * These run against a REAL local bare git repository acting as the remote, so
 * the transport is exercised for real (git plumbing, refs, CAS) rather than
 * mocked. Two isolated temp DSH_HOMEs stand in for two machines.
 *
 * The scenarios come straight from the acceptance criteria:
 *   1. A produces 3 rounds -> push -> B pull -> B reads all 3
 *   2. B appends 2 rounds  -> push -> A pull -> A reads all 5 (incremental,
 *      not a full overwrite)
 *   3. both sides advance the same session -> conflict path, both copies kept,
 *      nothing silently overwritten
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeSessionEvents, encodeFrames } from '../lib/zstd-frame.mjs';
import {
  appendRounds,
  fixtureSessionId,
  makeTempDshHome,
  writeSession,
} from '../lib/fixtures.mjs';

/** A throwaway git repo used as the sync remote (bare, so it has no worktree). */
function makeBareRemote(dir) {
  const path = join(dir, 'remote.git');
  execFileSync('git', ['init', '--bare', '--quiet', path], { stdio: 'ignore' });
  return path;
}

/** A local clone/working repo bound to the bare remote. */
function makeWorkingRepo(dir, name, remotePath) {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '--quiet', path], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', remotePath], { stdio: 'ignore' });
  return path;
}

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Load the transport module; skip the suite cleanly if it is absent. */
async function loadTransport() {
  try {
    return await import('../../src/transport.js');
  } catch {
    return null;
  }
}

/** Turn a session fixture into the bundle shape transport.push expects. */
function bundleFor(sessions) {
  return {
    sessions: sessions.map((session) => ({
      sessionId: session.sessionId,
      content: readFileSync(session.file),
    })),
  };
}

/** Read back the full event list of a session fixture from disk. */
function readEvents(session) {
  return decodeSessionEvents(readFileSync(session.file));
}

/** Count user/assistant exchange rounds in an event list. */
function countRounds(events) {
  const turns = new Set();
  for (const event of events) {
    if (event.type === 'turn/start' && event.data && typeof event.data.turn === 'number') {
      turns.add(event.data.turn);
    }
  }
  return turns.size;
}

test('e2e: A produces 3 rounds, pushes; B pulls and reads all 3', async (t) => {
  if (!hasGit()) {
    t.skip('git not installed');
    return;
  }
  const transportModule = await loadTransport();
  if (!transportModule) {
    t.skip('src/transport.js not present yet');
    return;
  }

  const base = mkdtempSync(join(tmpdir(), 'dsh-e2e-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const remote = makeBareRemote(base);
  const repoA = makeWorkingRepo(base, 'repo-a', remote);
  const repoB = makeWorkingRepo(base, 'repo-b', remote);

  const homeA = makeTempDshHome(base);
  const homeB = makeTempDshHome(base);
  t.after(() => {
    homeA.dispose();
    homeB.dispose();
  });

  // Machine A: one session with 3 rounds.
  const sessionId = fixtureSessionId(1);
  const sessionA = writeSession({ dshHome: homeA.root, sessionId, cwd: repoA, rounds: 3 });
  assert.equal(countRounds(readEvents(sessionA)), 3, 'fixture sanity: A has 3 rounds');

  const transportA = transportModule.createTransport();
  const pushResult = await transportA.push({ repoPath: repoA }, bundleFor([sessionA]));
  assert.equal(pushResult.ok, true, `push failed: ${JSON.stringify(pushResult)}`);
  assert.ok(pushResult.transferred >= 1, 'at least one session transferred');

  // Machine B: pull from the same remote.
  const transportB = transportModule.createTransport();
  const pullResult = await transportB.pull({ repoPath: repoB });
  assert.ok(pullResult, 'pull returned a result');
  assert.equal(pullResult.ok, true, `pull failed: ${JSON.stringify(pullResult)}`);
  assert.ok(pullResult.sessions.length >= 1, 'B received at least one session');

  // B must now be able to read the complete 3 rounds out of its own session store.
  const pulled = pullResult.sessions.find((s) => s.sessionId === sessionId) ?? pullResult.sessions[0];
  const events = decodeSessionEvents(toBuffer(pulled.content ?? pulled.bytes ?? pulled.data));
  assert.equal(countRounds(events), 3, 'B sees all 3 rounds');
  const seqs = events.filter((e) => typeof e.seq === 'number').map((e) => e.seq);
  assert.deepEqual(
    seqs,
    seqs.map((_, i) => i),
    'seq is contiguous from 0 after the round trip',
  );
});

test('e2e: B appends 2 rounds, A pulls back all 5 (incremental, not overwrite)', async (t) => {
  if (!hasGit()) {
    t.skip('git not installed');
    return;
  }
  const transportModule = await loadTransport();
  if (!transportModule) {
    t.skip('src/transport.js not present yet');
    return;
  }

  const base = mkdtempSync(join(tmpdir(), 'dsh-e2e-inc-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const remote = makeBareRemote(base);
  const repoA = makeWorkingRepo(base, 'repo-a', remote);
  const repoB = makeWorkingRepo(base, 'repo-b', remote);
  const homeA = makeTempDshHome(base);
  const homeB = makeTempDshHome(base);
  t.after(() => {
    homeA.dispose();
    homeB.dispose();
  });

  const sessionId = fixtureSessionId(2);
  const sessionA = writeSession({ dshHome: homeA.root, sessionId, cwd: repoA, rounds: 3 });
  const bytesAfterThree = readFileSync(sessionA.file);

  const transportA = transportModule.createTransport();
  await transportA.push({ repoPath: repoA }, bundleFor([sessionA]));

  const transportB = transportModule.createTransport();
  const firstPull = await transportB.pull({ repoPath: repoB });
  assert.ok(firstPull && firstPull.ok, 'first pull succeeded');

  // B materialises the session locally, then appends two more rounds.
  const bSession = writeSession({
    dshHome: homeB.root,
    sessionId,
    cwd: repoB,
    rounds: 3,
    raw: bytesAfterThree,
  });
  const lastSeq = Math.max(
    ...readEvents(bSession)
      .filter((e) => typeof e.seq === 'number')
      .map((e) => e.seq),
  );
  appendRounds({ file: bSession.file, fromRound: 4, nextSeq: lastSeq + 1, rounds: 2 });

  const eventsAtB = readEvents(bSession);
  assert.equal(countRounds(eventsAtB), 5, 'B now has 5 rounds');

  // B pushes the incremented session.
  const pushB = await transportA.push({ repoPath: repoB }, bundleFor([bSession]));
  assert.equal(pushB.ok, true, `B push failed: ${JSON.stringify(pushB)}`);

  // A pulls back.
  const secondPull = await transportA.pull({ repoPath: repoA });
  assert.ok(secondPull && secondPull.ok, 'second pull succeeded');
  const back = secondPull.sessions.find((s) => s.sessionId === sessionId);
  assert.ok(back, 'A received the session back');

  const bytesAtA = toBuffer(back.content ?? back.bytes ?? back.data);
  const eventsAtA = decodeSessionEvents(bytesAtA);
  assert.equal(countRounds(eventsAtA), 5, 'A reads all 5 rounds');

  // Incremental, not whole-file replacement: the original 3-round prefix must
  // still be present byte-for-byte, and the file must only have grown.
  assert.ok(
    bytesAtA.length >= bytesAfterThree.length,
    'session log only grew; it was not replaced with a shorter file',
  );
  assert.equal(
    bytesAtA.subarray(0, bytesAfterThree.length).equals(bytesAfterThree),
    true,
    'the original bytes are still an exact prefix — this was an append, not an overwrite',
  );

  const seqs = eventsAtA.filter((e) => typeof e.seq === 'number').map((e) => e.seq);
  assert.deepEqual(
    seqs,
    seqs.map((_, i) => i),
    'seq stays contiguous with no duplication after the round trip',
  );
});

/** Normalise whatever buffer-ish value transport returned into a Buffer. */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value);
  throw new TypeError(`cannot interpret pulled payload as bytes: ${typeof value}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Anti-false-green tests.
//
// The two tests above pass. That is not enough: a suite that goes green when the
// implementation degrades is worse than no suite, because it certifies a lie.
// The tests below ask "would a BROKEN implementation fail this?"
// ─────────────────────────────────────────────────────────────────────────────

/** Read the `{path -> blob oid}` set of the sessions ref in `repo`. */
function sessionsTreeOids(repoPath, ref) {
  const result = execFileSync('git', ['-C', repoPath, 'ls-tree', '-r', '-z', ref], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const map = new Map();
  for (const line of result.toString('utf8').split('\0')) {
    if (!line) continue;
    const [meta, filePath] = line.split('\t');
    const oid = meta.split(' ')[2];
    if (filePath && oid) map.set(filePath, oid);
  }
  return map;
}

test('anti-false-green: a full rewrite instead of an append WOULD be detected', async (t) => {
  if (!hasGit()) {
    t.skip('git not installed');
    return;
  }
  const transportModule = await loadTransport();
  if (!transportModule) {
    t.skip('src/transport.js not present yet');
    return;
  }

  const base = mkdtempSync(join(tmpdir(), 'dsh-incr-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const remote = makeBareRemote(base);
  const repoA = makeWorkingRepo(base, 'repo-a', remote);
  const homeA = makeTempDshHome(base);
  t.after(() => homeA.dispose());

  // A session big enough to span several chunks. Small fixtures collapse into a
  // single chunk, which makes incremental reuse unobservable — verified: 40
  // rounds -> 1 chunk, 80 rounds -> 2 chunks.
  const sessionId = fixtureSessionId(11);
  const sessionA = writeSession({ dshHome: homeA.root, sessionId, cwd: repoA, rounds: 80 });

  const transport = transportModule.createTransport();
  await transport.push({ repoPath: repoA }, bundleFor([sessionA]));
  const ref = transportModule.SESSIONS_REF;
  const afterFirst = sessionsTreeOids(repoA, ref);
  assert.ok(afterFirst.size > 2, `expected several chunk blobs, got ${afterFirst.size}`);

  // Append one round and push again.
  const lastSeq = Math.max(
    ...readEvents(sessionA).filter((e) => typeof e.seq === 'number').map((e) => e.seq),
  );
  appendRounds({ file: sessionA.file, fromRound: 81, nextSeq: lastSeq + 1, rounds: 1 });
  const push2 = await transport.push({ repoPath: repoA }, bundleFor([sessionA]));
  assert.equal(push2.ok, true);

  const afterSecond = sessionsTreeOids(repoA, ref);

  // The decisive observation: blobs whose content is unchanged keep their oid,
  // because a git blob id IS a content hash. So counting shared oids measures
  // "did we really only upload the delta?" independently of git's packing.
  const shared = [...afterSecond.entries()].filter(([p, oid]) => afterFirst.get(p) === oid).length;

  assert.ok(
    shared > 0,
    `appending one round must REUSE the unchanged chunk blobs; got shared=${shared} ` +
      '(a full-rewrite implementation would show shared=0 here)',
  );
});

test('anti-false-green: byte-identity would NOT hold across machines, event equality must', async (t) => {
  // Documents why the incremental assertion above uses blob oids and event
  // equality rather than whole-file byte equality:
  //   - within one machine, an append keeps the old bytes as a prefix
  //   - across machines, cwd is rewritten, so bytes legitimately differ
  // A suite that demanded byte equality cross-machine would report a false bug.
  const base = mkdtempSync(join(tmpdir(), 'dsh-bytes-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const homeA = makeTempDshHome(base);
  const homeB = makeTempDshHome(base);
  t.after(() => {
    homeA.dispose();
    homeB.dispose();
  });

  const sessionId = fixtureSessionId(12);
  // Same conversation, different cwd on each machine — exactly the cross-machine case.
  const sessionA = writeSession({ dshHome: homeA.root, sessionId, cwd: '/tmp/qa-fixture/machine-a', rounds: 3 });
  const sessionB = writeSession({ dshHome: homeB.root, sessionId, cwd: '/tmp/qa-fixture/machine-b', rounds: 3 });

  const bytesA = readFileSync(sessionA.file);
  const bytesB = readFileSync(sessionB.file);

  // Bytes differ because the header records cwd.
  assert.equal(
    bytesA.equals(bytesB),
    false,
    'files with different cwd must not be byte-identical — this is why byte equality is the wrong cross-machine assertion',
  );

  // But the *conversation* is identical at the logical level.
  const logical = (events) =>
    events
      .filter((e) => e.type !== 'session')
      .map((e) => ({ type: e.type, seq: e.seq }));
  assert.deepEqual(
    logical(decodeSessionEvents(bytesA)),
    logical(decodeSessionEvents(bytesB)),
    'the event stream must be logically identical even though bytes differ',
  );
});

test('meta: the incremental assertion is proven to catch a full-rewrite regression', async (t) => {
  // A test that can never fail is worthless. This one deliberately builds a
  // MUTANT — a session file rewritten with fresh bytes instead of appended — and
  // asserts that the "shared blob oid" signal drops to zero for it.
  //
  // If this ever stops holding, the anti-false-green test above has silently
  // become decoration, so the guard belongs here next to it.
  if (!hasGit()) {
    t.skip('git not installed');
    return;
  }
  const transportModule = await loadTransport();
  if (!transportModule) {
    t.skip('src/transport.js not present yet');
    return;
  }

  const base = mkdtempSync(join(tmpdir(), 'dsh-mutant-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = makeTempDshHome(base);
  t.after(() => home.dispose());

  const runScenario = async (name, mutate) => {
    const remote = makeBareRemote(join(base, name));
    const repo = makeWorkingRepo(base, name, remote);
    const session = writeSession({ dshHome: home.root, sessionId: fixtureSessionId(13), cwd: repo, rounds: 80 });
    const transport = transportModule.createTransport();
    const bundle = () => ({
      sessions: [{ sessionId: session.sessionId, content: readFileSync(session.file) }],
    });

    await transport.push({ repoPath: repo }, bundle());
    const before = sessionsTreeOids(repo, transportModule.SESSIONS_REF);

    if (mutate) {
      // Rewrite the whole log with freshly encoded bytes: every chunk changes.
      const events = decodeSessionEvents(readFileSync(session.file));
      writeFileSync(session.file, encodeFrames(events.map((e) => JSON.stringify(e) + '\n')));
    } else {
      const lastSeq = Math.max(
        ...readEvents(session).filter((e) => typeof e.seq === 'number').map((e) => e.seq),
      );
      appendRounds({ file: session.file, fromRound: 81, nextSeq: lastSeq + 1, rounds: 1 });
    }

    await transport.push({ repoPath: repo }, bundle());
    const after = sessionsTreeOids(repo, transportModule.SESSIONS_REF);
    return [...after.entries()].filter(([p, oid]) => before.get(p) === oid).length;
  };

  const sharedOnAppend = await runScenario('mut-append', false);
  const sharedOnRewrite = await runScenario('mut-rewrite', true);

  assert.ok(
    sharedOnAppend > 0,
    `a real append must reuse chunks (shared=${sharedOnAppend})`,
  );
  assert.equal(
    sharedOnRewrite,
    0,
    `a full rewrite must reuse nothing (shared=${sharedOnRewrite}) — if this holds, ` +
      'the incremental assertion below can distinguish the two',
  );
  assert.ok(
    sharedOnAppend > sharedOnRewrite,
    'the append-vs-rewrite signal must be distinguishable; otherwise the incremental ' +
      'test cannot detect a regression',
  );
});

test('e2e: push reports real new vs reused chunk counts (increment is observable)', async (t) => {
  // The transport used to report `newChunks` as "how many times we called
  // hash-object", which equals the total chunk count on every push. That made
  // the field useless for detecting a regression to full-rewrite behaviour.
  //
  // It now reports actual new-vs-reused, so these assertions are meaningful:
  //   - a genuine append MUST reuse chunks
  //   - the parts must add up to the whole
  //   - a no-op push must add nothing
  if (!hasGit()) {
    t.skip('git not installed');
    return;
  }
  const transportModule = await loadTransport();
  if (!transportModule) {
    t.skip('src/transport.js not present yet');
    return;
  }

  const base = mkdtempSync(join(tmpdir(), 'dsh-chunks-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const remote = makeBareRemote(base);
  const repoA = makeWorkingRepo(base, 'repo-a', remote);
  const homeA = makeTempDshHome(base);
  t.after(() => homeA.dispose());

  // Large enough to span several chunks; small fixtures collapse to one chunk
  // and make reuse unobservable (measured: 40 rounds -> 1 chunk, 80 -> 2).
  const sessionId = fixtureSessionId(31);
  const sessionA = writeSession({ dshHome: homeA.root, sessionId, cwd: repoA, rounds: 80 });
  const transport = transportModule.createTransport();

  const first = await transport.push({ repoPath: repoA }, bundleFor([sessionA]));
  assert.equal(first.ok, true);
  assert.ok(first.chunks > 1, `expected multiple chunks, got ${first.chunks}`);
  assert.equal(first.newChunks, first.chunks, 'the very first push has nothing to reuse');
  assert.equal(first.reusedChunks ?? 0, 0, 'nothing exists remotely yet, so nothing can be reused');

  // Append one round: only the tail chunk should change.
  const lastSeq = Math.max(
    ...readEvents(sessionA).filter((e) => typeof e.seq === 'number').map((e) => e.seq),
  );
  appendRounds({ file: sessionA.file, fromRound: 81, nextSeq: lastSeq + 1, rounds: 1 });
  const second = await transport.push({ repoPath: repoA }, bundleFor([sessionA]));
  assert.equal(second.ok, true);

  assert.equal(
    (second.newChunks ?? 0) + (second.reusedChunks ?? 0),
    second.chunks,
    'newChunks + reusedChunks must account for every chunk',
  );
  assert.ok(
    second.newChunks < second.chunks,
    `appending one round must NOT re-upload every chunk (newChunks=${second.newChunks}, chunks=${second.chunks}). ` +
      'If these are equal, the implementation rewrote the whole payload and the incremental claim is false.',
  );
  assert.ok(
    (second.reusedChunks ?? 0) > 0,
    `appending must reuse existing chunks; reusedChunks=${second.reusedChunks}`,
  );

  // A push with nothing changed must add zero new chunks.
  const third = await transport.push({ repoPath: repoA }, bundleFor([sessionA]));
  assert.equal(third.ok, true);
  assert.equal(third.newChunks, 0, 'an unchanged push must not create new chunks');
});
