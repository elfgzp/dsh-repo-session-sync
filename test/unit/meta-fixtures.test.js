/**
 * Meta tests: these guard the *test harness itself*.
 *
 * The single most dangerous bug in a session-sync implementation is a silent
 * one: decoding a multi-frame file with a one-shot zstd call returns only the
 * first frame and reports success. The header is valid JSON, so a naive
 * "did it parse?" assertion goes green while 99% of the conversation is gone.
 *
 * So before testing any product code, we prove that:
 *   1. our fixtures really are multi-frame files,
 *   2. a naive whole-buffer decode really does lose data on them,
 *   3. our decoder agrees with the reference `zstd` CLI.
 *
 * If (2) ever stops failing, the fixtures have silently degenerated and every
 * downstream test becomes worthless — hence the explicit assertion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

import { decodeFrames, decodeSessionEvents, encodeFrame, encodeFrames, hasNativeZstd } from '../lib/zstd-frame.mjs';
import { buildSession, fixtureSessionId, serializeSession, writeSession, makeTempDshHome } from '../lib/fixtures.mjs';

/** @returns {string} a temp dir removed after the test */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qa-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const hasZstdCli = (() => {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('fixture session files are genuinely multi-frame', (t) => {
  const dir = tempDir(t);
  const home = makeTempDshHome(dir);
  t.after(() => home.dispose());

  const { file } = writeSession({
    dshHome: home.root,
    sessionId: fixtureSessionId(1),
    cwd: '/tmp/qa-fixture/repo-a',
    rounds: 3,
  });
  const buf = readFileSync(file);
  const { frames } = decodeFrames(buf);
  assert.ok(frames.length > 1, `expected multiple zstd frames, got ${frames.length}`);
  // The first frame holds only the header line, like real DSH files.
  assert.equal(frames[0].lines.length, 1);
  const header = JSON.parse(frames[0].lines[0]);
  assert.equal(header.type, 'session');
});

test('one-shot whole-buffer decode truncates a multi-frame file', (t) => {
  // The trap this guards: decoding a whole session file in one call returns only
  // the FIRST frame and succeeds silently. The header is valid JSON, so a
  // "did it parse?" assertion goes green while the conversation is gone.
  //
  // We must prove this on every runtime, so we test the framing directly rather
  // than depending on a native API that older Nodes lack:
  //   - the file contains N >= 2 frames
  //   - a single decode can only ever yield frame 0's content
  //   - frame 0 is exactly one line (the header)
  // A runtime with native zstd additionally gets the behavioural proof below.
  const dir = tempDir(t);
  const home = makeTempDshHome(dir);
  t.after(() => home.dispose());

  const { file } = writeSession({
    dshHome: home.root,
    sessionId: fixtureSessionId(1),
    cwd: '/tmp/qa-fixture/repo-a',
    rounds: 3,
  });
  const buf = readFileSync(file);
  const { frames } = decodeFrames(buf);

  assert.ok(frames.length >= 2, `file must be multi-frame, got ${frames.length}`);
  assert.equal(frames[0].lines.length, 1, 'frame 0 holds only the header line');

  const fullEvents = decodeSessionEvents(buf);
  assert.ok(fullEvents.length > 2, 'fixture must contain many events');

  // Only decode frame 0 — this is exactly what a one-shot call can see.
  const frame0Only = decodeFrames(buf.subarray(0, frames[0].end));
  assert.equal(frame0Only.frames.length, 1);
  assert.equal(frame0Only.frames[0].lines.length, 1);
  assert.ok(
    frame0Only.frames[0].lines.length < fullEvents.length,
    `META-GUARD: frame 0 alone must be less than the whole file ` +
      `(frame0=${frame0Only.frames[0].lines.length}, whole=${fullEvents.length})`,
  );

  if (hasNativeZstd()) {
    // Behavioural proof on runtimes that have the naive API.
    const naiveLines = zlib
      .zstdDecompressSync(buf)
      .toString('utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    assert.equal(naiveLines.length, 1, 'one-shot decode yields only the header line');
    assert.doesNotThrow(
      () => JSON.parse(naiveLines[0]),
      'the truncated result is still valid JSON — that is why the bug hides',
    );
  }
});

test('decoding frame-by-frame recovers every event the file contains', (t) => {
  // The positive counterpart: our decoder must not lose anything.
  const dir = tempDir(t);
  const home = makeTempDshHome(dir);
  t.after(() => home.dispose());

  for (const rounds of [0, 1, 4]) {
    const { file } = writeSession({
      dshHome: home.root,
      sessionId: fixtureSessionId(rounds + 1),
      cwd: '/tmp/qa-fixture/repo-a',
      rounds,
    });
    const buf = readFileSync(file);
    const { frames } = decodeFrames(buf);
    const fromFrames = frames.reduce((n, f) => n + f.lines.length, 0);
    const fromEvents = decodeSessionEvents(buf).length;
    assert.equal(fromEvents, fromFrames, 'event count must equal total lines across frames');
    // Header + preamble(4) + rounds*6
    assert.equal(fromEvents, 1 + 4 + rounds * 6, `unexpected event count for ${rounds} rounds`);
  }
});

test('our multi-frame decoder agrees with the reference zstd CLI byte-for-byte', (t) => {
  if (!hasZstdCli) {
    t.skip('zstd CLI not installed');
    return;
  }
  const dir = tempDir(t);
  const home = makeTempDshHome(dir);
  t.after(() => home.dispose());

  const { file } = writeSession({
    dshHome: home.root,
    sessionId: fixtureSessionId(2),
    cwd: '/tmp/qa-fixture/repo-b',
    rounds: 3,
  });

  const cliOut = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 16 * 1024 * 1024 }).toString('utf8');
  const ours = decodeFrames(readFileSync(file))
    .frames.map((f) => f.text)
    .join('');

  assert.equal(ours, cliOut, 'decoder output must match the reference implementation exactly');

  const cliLineCount = cliOut.split('\n').filter((l) => l.length > 0).length;
  assert.equal(decodeSessionEvents(readFileSync(file)).length, cliLineCount);
});

test('decoder rejects a payload that is not valid JSONL', () => {
  // `decodeFrames` validates that每一帧 decodes to JSONL, which is what makes
  // it safe to use on session logs. A frame whose bytes decode to something
  // that is not JSON must not be reported as a session frame.
  const notJsonl = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x02, 0x03]);
  const frame = encodeFrame(notJsonl);
  const { frames } = decodeFrames(frame);
  assert.equal(frames.length, 0, 'non-JSONL payload is not a session frame');
});

test('two adjacent real frames both parse (no boundary confusion)', () => {
  const a = JSON.stringify({ type: 'turn/start', seq: 0 });
  const b = JSON.stringify({ type: 'turn/end', seq: 1 });
  const file = encodeFrames([a + '\n', b + '\n']);
  const { frames } = decodeFrames(file);
  assert.equal(frames.length, 2);
  assert.equal(JSON.parse(frames[0].lines[0]).type, 'turn/start');
  assert.equal(JSON.parse(frames[1].lines[0]).type, 'turn/end');
});

test('a torn tail is tolerated and reported, not thrown', () => {
  const payloads = ['{"type":"a"}', '{"type":"b"}', '{"type":"c"}'];
  const file = encodeFrames(payloads);

  // Chop the last frame in half: the normal state after a crash mid-write.
  const torn = file.subarray(0, file.length - 5);
  const result = decodeFrames(torn);

  assert.equal(result.frames.length, 2, 'complete frames are still recovered');
  assert.ok(result.trailingBytes > 0, 'the incomplete tail is reported as trailing bytes');
  assert.doesNotThrow(() => decodeSessionEvents(torn), 'torn tail must never throw');
  assert.equal(decodeSessionEvents(torn).length, 2);
});

test('fixture sessions keep seq contiguous from 0', (t) => {
  const dir = tempDir(t);
  const home = makeTempDshHome(dir);
  t.after(() => home.dispose());

  for (const rounds of [0, 1, 5]) {
    const { file } = writeSession({
      dshHome: home.root,
      sessionId: fixtureSessionId(rounds + 1),
      cwd: '/tmp/qa-fixture/repo-a',
      rounds,
    });
    const events = decodeSessionEvents(readFileSync(file));
    const seqs = events.filter((e) => typeof e.seq === 'number').map((e) => e.seq);
    // Exactly one line (the header) carries no seq.
    assert.equal(events.length - seqs.length, 1, 'only the header lacks seq');
    seqs.forEach((value, index) => assert.equal(value, index, 'seq is 0-based and contiguous'));
  }
});

test('serializer puts one event batch per frame and header alone in frame 0', () => {
  const session = buildSession({
    sessionId: fixtureSessionId(1),
    cwd: '/tmp/qa-fixture/repo-a',
    rounds: 2,
  });
  // 2 rounds * 6 events + 4 preamble events = 16 body events; 5 per frame -> 4 frames
  const buf = serializeSession(session, { eventsPerFrame: 5 });
  const { frames } = decodeFrames(buf);
  assert.equal(frames[0].lines.length, 1);
  assert.equal(frames.length, 1 + Math.ceil(session.body.length / 5));
  for (const frame of frames.slice(1)) {
    assert.ok(frame.lines.length <= 5, `frame holds at most 5 events, got ${frame.lines.length}`);
  }
});

test('library modules under test/lib have no top-level side effects', async () => {
  // `node --test` (no args) loads every .js/.mjs under test/ as a test file,
  // including our library modules. That is only safe while those modules do
  // nothing at import time. This test pins that contract: importing the library
  // in a clean child process must not create files or directories.
  const { execFileSync } = await import('node:child_process');
  const before = process.cwd();

  const script = `
    import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const sandbox = mkdtempSync(join(tmpdir(), 'dsh-sfx-'));
    process.chdir(sandbox);
    await import(${JSON.stringify(new URL('../lib/fixtures.mjs', import.meta.url).href)});
    await import(${JSON.stringify(new URL('../lib/zstd-frame.mjs', import.meta.url).href)});
    const entries = readdirSync(sandbox);
    process.chdir(${JSON.stringify(before)});
    rmSync(sandbox, { recursive: true, force: true });
    if (entries.length > 0) {
      console.error('SIDE_EFFECTS:' + entries.join(','));
      process.exit(2);
    }
  `;

  let threw = null;
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: before,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    threw = error;
  }
  assert.equal(
    threw,
    null,
    threw ? `library modules must not touch the filesystem on import: ${String(threw.stderr)}` : '',
  );
});
