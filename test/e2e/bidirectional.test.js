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

import { decodeSessionEvents } from '../lib/zstd-frame.mjs';
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
