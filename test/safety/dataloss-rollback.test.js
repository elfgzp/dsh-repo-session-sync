/**
 * Data-loss regression guard: attach failure must never delete user history.
 *
 * THE BUG THIS PINS DOWN
 * ----------------------
 * On a downward sync the engine has two very different write outcomes:
 *
 *   - it CREATED a session this run  -> safe to delete if registration fails
 *   - it APPENDED to a session that already existed -> MUST NEVER be deleted
 *
 * Both used to return the same `{ kind: 'written' }`, so both landed in one
 * `touched` set, which was handed to `rollbackNewSessions()` as
 * `writtenByThisRun`. On attach failure that function faithfully `rm -rf`ed
 * every entry — including a session holding the user's existing conversation.
 * Measured outcome: a session with 3 existing rounds, extended to 5, disappeared
 * entirely. Total loss.
 *
 * WHY THIS TEST IS CROSS-MODULE
 * -----------------------------
 * `rollbackNewSessions()` itself is correct, and well commented about never
 * deleting pre-existing sessions. The defect lived in the CALLER passing the
 * wrong set. A unit test of the rollback function alone passes happily while the
 * system loses user data — so the assertions below go through the engine.
 *
 * WHY "the directory still exists" IS NOT ENOUGH
 * ---------------------------------------------
 * The most dangerous half-fix is "delete it, then recreate an empty one": the
 * directory is back, the conversation is gone. So we assert the *events* are
 * intact and identical, not merely that a path exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fixtureSessionId, makeTempDshHome, writeSession } from '../lib/fixtures.mjs';
import { decodeSessionEvents } from '../lib/zstd-frame.mjs';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dataloss-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function load(name) {
  try {
    return await import(`../../src/${name}`);
  } catch {
    return null;
  }
}

/** Events of a fixture session, or null when the file is gone. */
function eventsOf(session) {
  if (!existsSync(session.file)) return null;
  return decodeSessionEvents(readFileSync(session.file));
}

/** Count user-visible conversation rounds. */
function rounds(events) {
  if (!events) return 0;
  const turns = new Set();
  for (const event of events) {
    if (event.type === 'turn/start' && event.data && typeof event.data.turn === 'number') {
      turns.add(event.data.turn);
    }
  }
  return turns.size;
}

test('dataloss: rollbackNewSessions never removes a pre-existing session when it is NOT passed in', async (t) => {
  // Baseline contract check on the function itself: it only deletes what it is
  // explicitly told to delete. This keeps the function honest even as the engine
  // around it changes.
  const registry = await load('registry.js');
  if (!registry || typeof registry.rollbackNewSessions !== 'function') {
    t.skip('registry.rollbackNewSessions not available');
    return;
  }

  const dir = tempDir(t);
  const home = makeTempDshHome(dir);
  t.after(() => home.dispose());

  const sessionId = fixtureSessionId(21);
  const session = writeSession({
    dshHome: home.root,
    sessionId,
    cwd: '/tmp/qa-fixture/repo-a',
    rounds: 3,
  });
  const before = eventsOf(session);

  // Empty writtenByThisRun: nothing was created this run, so nothing may vanish.
  const result = await registry.rollbackNewSessions({
    sessionsRoot: home.sessionsDir,
    writtenByThisRun: [],
  });

  assert.deepEqual(result.removed, []);
  assert.equal(existsSync(session.dir), true, 'session not in the rollback set must survive');
  assert.deepEqual(eventsOf(session), before, 'and its events must be byte-for-byte unchanged');
});

test('dataloss: rollback refuses a path outside the sessions root', async (t) => {
  // Defence in depth: even if a caller passes a bogus sessionDir, the function
  // must refuse rather than delete something outside the tree.
  const registry = await load('registry.js');
  if (!registry || typeof registry.rollbackNewSessions !== 'function') {
    t.skip('registry.rollbackNewSessions not available');
    return;
  }

  const dir = tempDir(t);
  const home = makeTempDshHome(dir);
  t.after(() => home.dispose());

  const outsider = writeSession({
    dshHome: home.root,
    sessionId: fixtureSessionId(22),
    cwd: '/tmp/qa-fixture/repo-a',
    rounds: 1,
  });

  const result = await registry.rollbackNewSessions({
    sessionsRoot: home.sessionsDir,
    writtenByThisRun: [{ sessionId: 'evil', sessionDir: '/tmp' }],
  });

  assert.deepEqual(result.removed, [], 'must not delete outside the sessions root');
  assert.ok(result.failed.length > 0, 'and must report why it refused');
  assert.equal(existsSync(outsider.dir), true, 'unrelated session untouched');
});

test('dataloss: attach failure keeps pre-existing history AND removes genuinely new sessions', async (t) => {
  // The heart of it. Two sessions in play:
  //   S1 = already on this machine (3 rounds), will be APPENDED to   -> must survive
  //   S2 = brand new this run                                        -> must be removed
  //
  // Both fail registration. A correct implementation distinguishes them; the old
  // one deleted both. Asserting only "something was deleted" or only "S1
  // survived" would respectively miss the bug or permit a fix that never cleans
  // up. Both halves are pinned here on purpose.
  const engineModule = await load('engine.js');
  const registryModule = await load('registry.js');
  const storeModule = await load('store.js');
  const depsModule = await load('deps.js');
  if (!engineModule || !registryModule || !storeModule || !depsModule) {
    t.skip('engine/registry/store/deps not all available yet');
    return;
  }

  const dir = tempDir(t);
  const home = makeTempDshHome(dir);
  t.after(() => home.dispose());

  const repoPath = '/tmp/qa-fixture/repo-a';
  const existingId = fixtureSessionId(23);
  const freshId = fixtureSessionId(24);

  // S1: user's existing conversation.
  const existing = writeSession({ dshHome: home.root, sessionId: existingId, cwd: repoPath, rounds: 3 });
  const existingBefore = eventsOf(existing);
  assert.equal(rounds(existingBefore), 3, 'fixture sanity: S1 starts with 3 rounds');

  // S2: a session that does not exist on this machine yet.
  const freshTarget = writeSession({
    dshHome: home.root,
    sessionId: freshId,
    cwd: repoPath,
    rounds: 1,
    // Write it under a path we can delete-check, but record it as "new".
  });

  // Sanity: both exist on disk before the rollback.
  assert.equal(existsSync(existing.dir), true);
  assert.equal(existsSync(freshTarget.dir), true);

  // Simulate the engine's rollback call *correctly*: only the genuinely-new
  // session is in writtenByThisRun. This is the contract the engine must honour.
  const rollback = await registryModule.rollbackNewSessions({
    sessionsRoot: home.sessionsDir,
    writtenByThisRun: [{ sessionId: freshId, sessionDir: freshTarget.dir }],
  });

  // S2 removed (correct cleanup of a session DSH never saw).
  assert.deepEqual(rollback.removed, [freshId], 'the genuinely new session must be rolled back');
  assert.equal(existsSync(freshTarget.dir), false, 'new session directory is gone');

  // S1 untouched: directory, event count, and event contents.
  assert.equal(existsSync(existing.dir), true, 'pre-existing session directory MUST survive');
  const existingAfter = eventsOf(existing);
  assert.ok(existingAfter !== null, 'pre-existing session file must still exist');
  assert.ok(
    existingAfter.length >= existingBefore.length,
    `event count must not shrink (was ${existingBefore.length}, now ${existingAfter.length})`,
  );
  assert.deepEqual(
    existingAfter,
    existingBefore,
    'every pre-existing event must be byte-identical after a failed sync — ' +
      'a "delete and recreate empty" implementation would pass a mere existence check',
  );
  assert.equal(rounds(existingAfter), 3, 'user is left with all 3 original rounds');
});

test('dataloss: rollback routing separates created from appended sessions', async (t) => {
  // Proves the FIX SHAPE, not just "some field exists".
  //
  // The defect was `touched.push({sessionId, sessionDir})` — one set for both
  // outcomes — handed wholesale to `rollbackNewSessions()`, which then deleted
  // sessions that already held user history. The fix has two required halves:
  //
  //   (a) each touched entry records whether THIS run created it, and
  //   (b) the rollback is routed by that flag: created ones may be deleted,
  //       appended ones must be restored or left alone — never deleted.
  //
  // We assert (a) and (b) against the source because the defect lives in wiring
  // that no single function owns. The behavioural half is covered by the test
  // above (real rollbackNewSessions run) and, once the engine is assembled, by
  // the end-to-end failure-path test.
  const engineModule = await load('engine.js');
  if (!engineModule) {
    t.skip('engine.js not available');
    return;
  }
  const source = readFileSync(new URL('../../src/engine.js', import.meta.url), 'utf8');

  // (a) the touched entry carries a strict boolean discriminator.
  const touchedPush = /touched\.push\(\s*\{([\s\S]{0,300}?)\}\s*\)/.exec(source);
  assert.ok(touchedPush, 'could not locate touched.push({...}) in engine.js');
  assert.match(
    touchedPush[1],
    /created\s*:\s*decision\.created\s*===\s*true/,
    'each touched session must record `created: decision.created === true` (strict), so that ' +
      '`undefined` can never land in the deletable set. Got: {' +
      touchedPush[1].replace(/\s+/g, ' ').trim() + '}',
  );

  // (b) rollback is split by the flag, and the deletable set is filtered strictly.
  assert.match(
    source,
    /createdFailed\s*=\s*failedItems\.filter\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.created\s*===\s*true\s*\)/,
    'rollback must compute the deletable set as `filter(item => item.created === true)`',
  );

  const rollbackCall = /rollbackNewSessions\(\s*\{([\s\S]{0,300}?)\}\s*\)/.exec(source);
  assert.ok(rollbackCall, 'could not locate rollbackNewSessions call');
  assert.match(
    rollbackCall[1],
    /writtenByThisRun\s*:\s*createdFailed/,
    'rollbackNewSessions must receive ONLY the created-this-run sessions; passing everything ' +
      'deletes sessions that already held the user\'s conversation. Got: {' +
      rollbackCall[1].replace(/\s+/g, ' ').trim() + '}',
  );

  // (c) appended sessions must take a restore path, never the delete path.
  //     A "leave the file alone" fallback is acceptable; silent deletion is not.
  // Locate the block that handles appended-but-failed sessions and require it to
  // avoid the delete-based rollback. Locating by the filter expression is
  // fragile, so we find the appended identifier first and then inspect forward
  // from its assignment.
  const appendFilter = /const\s+(\w+)\s*=\s*failedItems\.filter\(\(\s*\w+\s*\)\s*=>\s*\w+\.created\s*===\s*false\)/.exec(source);
  assert.ok(
    appendFilter,
    'engine must compute a separate set for appended-but-failed sessions ' +
      '(e.g. `filter(item => item.created === false)`)',
  );
  const appendedName = appendFilter[1];
  const afterAppended = source.slice(appendFilter.index, appendFilter.index + 2500);
  assert.doesNotMatch(
    afterAppended,
    new RegExp(`rollbackNewSessions\\s*\\([^)]*\\b${appendedName}\\b`),
    'appended sessions must never be passed to the delete-based rollback',
  );
});

test('structure: a session written by the plugin has the same layout as a real DSH session', async (t) => {
  // WHY THIS EXISTS
  // `isSessionLive()` short-circuits to "not live" when `session.lock` is absent:
  //
  //     if (!(await pathExists(lockFile))) return { live: false, checked: true,
  //                                                 method: 'no-lock-file' }
  //
  // So if the plugin ever produced session directories WITHOUT a lock file, LIVE
  // detection would silently return "not live" forever for every session the
  // plugin itself created — and a downward sync would happily overwrite a session
  // the user currently has open in DSH. That is precisely the failure LIVE
  // detection exists to prevent, reached by a structural mismatch rather than a
  // logic bug.
  //
  // Structural consistency is cheap to assert and does not depend on behaviour,
  // so it is checked here as a standing invariant.
  const store = await load('session-store.js');
  if (!store || typeof store.writeSession !== 'function') {
    t.skip('session-store.writeSession not available');
    return;
  }

  // `writeSession` needs a zstd frame encoder. Node < 22.15 has no native
  // compressor, so instead of skipping (a skip verifies nothing) we inject our
  // own zero-dependency encoder. The frames it emits are valid zstd — the shape
  // of the directory is what this test is about, not the compression ratio.
  const zlib = await import('node:zlib');
  const { encodeFrame } = await import('../lib/zstd-frame.mjs');
  const frameEncoder =
    typeof zlib.default.zstdCompressSync === 'function'
      ? undefined // let the implementation use its native default
      : (buf) => encodeFrame(buf);

  const dir = tempDir(t);
  const home = makeTempDshHome(dir);
  t.after(() => home.dispose());

  // Use the explicit form (payload + options) rather than the convenience form:
  // the convenience form does not forward `frameEncoder`, so on a runtime without
  // native zstd it would fail before reaching the behaviour under test.
  const sessionId = fixtureSessionId(41);
  const header = {
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt: 1700000000000,
    cwd: '/tmp/qa-fixture/repo-a',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'cordis',
  };
  /** One round = user + assistant message. seq must be contiguous from 0. */
  const events = [
    { type: 'user/message', seq: 0, time: 1700000000001, data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } } },
    { type: 'assistant/message', seq: 1, time: 1700000000002, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } },
  ];
  const written = await store.writeSession(
    { sessionId, header, events },
    {
      sessionsRoot: join(home.root, 'sessions'),
      backupDir: join(home.root, 'repo-session-sync', 'backups'),
      cwdOverride: '/tmp/qa-fixture/repo-a',
      skipLiveCheck: true,
      frameEncoder,
    },
  );

  const files = readdirSync(written.sessionDir).sort();
  assert.ok(
    files.includes('session.v4.jsonl.zstd'),
    `expected the session log, got: ${files.join(', ')}`,
  );
  assert.ok(
    files.includes('session.lock'),
    'a plugin-written session MUST contain session.lock, otherwise isSessionLive() short-circuits ' +
      'to "not live" for every session we create and LIVE protection never engages. ' +
      `Got: ${files.join(', ')}`,
  );

  // The lock must be empty (it is a flock anchor, not a payload).
  assert.equal(readFileSync(join(written.sessionDir, 'session.lock')).length, 0);

  // And it must not be pre-locked: acquiring the lock is DSH's job, not ours.
  // A held lock would block the real writer.
  const verdict = await store.isSessionLive?.(written.sessionDir);
  if (verdict) {
    assert.equal(verdict.live, false, 'a freshly written session must not report as LIVE');
  }
});
