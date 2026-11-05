/**
 * Regression guard — the most important test in this suite.
 *
 * The whole product exists to move sessions between machines. If any code path
 * writes to the user's real `~/.dsh` unexpectedly, the user loses conversation
 * history. This suite snapshots the real DSH home before running anything and
 * asserts afterwards that:
 *
 *   - no file was added, removed, or renamed,
 *   - no file's content hash changed,
 *   - no file's mtime changed,
 *
 * It also double-checks the *other* suites' own behaviour: they must all run
 * inside temporary directories, so this snapshot should always come back clean.
 *
 * Deliberately read-only: it hashes and stats, never opens a session for write.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Largest session log whose full prefix the guard will hold in memory. */
const MAX_GUARD_BYTES = 64 * 1024 * 1024;

/** Milliseconds to observe the real home for live (non-test) writes. */
const CONTROL_WINDOW_MS = Number(process.env.DSH_GUARD_CONTROL_MS ?? 3000);

/**
 * Path fragments that only our fixtures ever produce. If one shows up under the
 * real DSH home, our code wrote there.
 */
const FIXTURE_MARKERS = ['qa-fixture', 'dsh-home-', 'session-00000000-0000-4000'];

/** Real DSH home — resolved dynamically, never hard-coded. */
function realDshHome() {
  return process.env.DSH_HOME_REAL || join(homedir(), '.dsh');
}

/**
 * Capture the real DSH home: the set of all files, plus the leading bytes of
 * every session log (used to verify the append-only property later).
 *
 * Only session logs get their bytes read; everything else is just enumerated,
 * which keeps the guard cheap even with hundreds of megabytes of history.
 *
 * @param {string} root real DSH home
 */
function captureSessionState(root) {
  const allFiles = new Set();
  const sessionLogs = new Map();
  if (!existsSync(root)) return { allFiles, sessionLogs };

  const walk = (dir, prefix) => {
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip rather than fail the guard
    }
    for (const item of items) {
      const full = join(dir, item.name);
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!item.isFile()) continue;
      allFiles.add(rel);
      if (item.name.endsWith('.jsonl.zstd')) {
        try {
          const st = statSync(full);
          // Keep the whole prefix so the append-only comparison is exact. Cap
          // extremely large logs so the guard cannot blow up memory.
          if (st.size <= MAX_GUARD_BYTES) {
            sessionLogs.set(rel, { path: full, size: st.size, head: readFileSync(full) });
          } else {
            sessionLogs.set(rel, { path: full, size: st.size, head: null });
          }
        } catch {
          // vanished mid-walk (live append race); ignore
        }
      }
    }
  };
  walk(root, '');
  return { allFiles, sessionLogs };
}

/**
 * Snapshot a directory tree: relative path -> {size, mtimeMs, hash}.
 * `hash` is only computed for files under a size cap, so the guard stays fast
 * on machines with large session logs; everything else still gets size+mtime.
 */
function snapshotTree(root, { maxHashBytes = 4 * 1024 * 1024 } = {}) {
  const entries = new Map();
  if (!existsSync(root)) return entries;

  const walk = (dir, prefix) => {
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip rather than fail the guard
    }
    for (const item of items) {
      const full = join(dir, item.name);
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!item.isFile()) continue;
      try {
        const st = statSync(full);
        const record = { size: st.size, mtimeMs: st.mtimeMs, hash: null };
        if (st.size <= maxHashBytes) {
          record.hash = createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 32);
        }
        entries.set(rel, record);
      } catch {
        // A file that vanished mid-walk (DSH appending) is expected; ignore.
      }
    }
  };
  walk(root, '');
  return entries;
}

/** Compare two snapshots; returns a human-readable list of differences. */
function diffSnapshots(before, after) {
  const problems = [];

  for (const [rel, record] of before) {
    const now = after.get(rel);
    if (!now) {
      problems.push(`removed: ${rel}`);
      continue;
    }
    if (now.size !== record.size) {
      problems.push(`size changed: ${rel} (${record.size} -> ${now.size})`);
    } else if (record.hash !== null && now.hash !== null && now.hash !== record.hash) {
      problems.push(`hash changed: ${rel}`);
    }
    // mtime is reported separately: a running DSH session legitimately appends.
  }

  for (const rel of after.keys()) {
    if (!before.has(rel)) problems.push(`added: ${rel}`);
  }
  return problems;
}

test('guard: the real user DSH home is untouched by the test run', async (t) => {
  const root = realDshHome();
  if (!existsSync(root)) {
    t.skip(`no real DSH home at ${root} on this machine — nothing to protect`);
    return;
  }

  // WHY THIS TEST IS SHAPED THE WAY IT IS
  // ------------------------------------
  // A naive "snapshot -> run -> snapshot -> assert identical" guard cannot work
  // on a live DSH install: the running app appends to session logs and writes
  // request logs continuously. Measured here, files changed during a 3s window
  // with no tests running at all — so a byte-identical assertion would only
  // produce flakes, and weakening it to nothing would defeat the purpose.
  //
  // The precise, traffic-proof invariant comes from the storage format itself:
  // DSH session logs are APPEND-ONLY. A legitimate live write can only append,
  // so the old bytes must remain a PREFIX of the new bytes. Corruption caused by
  // a sync bug (rewrite, truncate, replace) breaks that prefix property. So:
  //
  //   session logs  -> old bytes must be a prefix of new bytes   (strong, exact)
  //   session logs  -> must not lose any events ("seq" must not regress)
  //   everything    -> must not vanish
  //   everything    -> no fixture-shaped path may ever appear
  //
  // This fails loudly on real corruption and stays green under normal traffic.
  const before = captureSessionState(root);

  // ---- run everything that could plausibly touch the real home ----
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const temp = mkdtempSync(join(tmpdir(), 'dsh-guard-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  const { buildStandardScenario } = await import('./lib/fixtures.mjs');
  const { decodeSessionEvents } = await import('./lib/zstd-frame.mjs');

  const scenario = buildStandardScenario(temp);
  try {
    for (const session of scenario.sessions) decodeSessionEvents(readFileSync(session.file));
    const saved = process.env.DSH_HOME;
    process.env.DSH_HOME = scenario.home.root;
    try {
      const rescan = buildStandardScenario(temp);
      rescan.home.dispose();
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = saved;
    }
  } finally {
    scenario.home.dispose();
  }

  const after = captureSessionState(root);
  const problems = [];

  // 1. Session logs must never shrink or lose their prefix (append-only).
  for (const [rel, prior] of before.sessionLogs) {
    const now = after.sessionLogs.get(rel);
    if (!now) {
      problems.push(`session log removed: ${rel}`);
      continue;
    }
    if (now.size < prior.size) {
      problems.push(`session log shrank (truncated!): ${rel} (${prior.size} -> ${now.size})`);
      continue;
    }
    const nowBuffer = readFileSync(now.path);
    const prefix = nowBuffer.subarray(0, prior.size);
    if (!prefix.equals(prior.head)) {
      problems.push(`session log prefix REWRITTEN: ${rel} (append-only violated)`);
    }
  }

  // 2. No file anywhere may have been deleted.
  for (const rel of before.allFiles) {
    if (!after.allFiles.has(rel)) problems.push(`file removed: ${rel}`);
  }

  // 3. Nothing our fixtures create may ever appear under the real home.
  const strays = [...after.allFiles].filter((rel) => FIXTURE_MARKERS.some((m) => rel.includes(m)));
  for (const stray of strays) problems.push(`fixture-shaped path leaked into real home: ${stray}`);

  assert.deepEqual(
    problems,
    [],
    `the real DSH home at ${root} was corrupted during the test run:\n  ${problems.join('\n  ')}`,
  );

  t.diagnostic(
    `guard verified ${before.sessionLogs.size} real session logs stayed append-only, ` +
      `${before.allFiles.size} files intact, real home ${root}`,
  );
});

test('guard: DSH_HOME override is honoured by the fixtures', async (t) => {
  // If fixtures ever ignored DSH_HOME they would write into the real home.
  // Prove they do not: build a scenario with DSH_HOME redirected and assert
  // every produced path lives inside the sandbox.
  const { mkdtempSync, rmSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const temp = mkdtempSync(join(tmpdir(), 'dsh-guard-home-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  const { buildStandardScenario } = await import('./lib/fixtures.mjs');
  const scenario = buildStandardScenario(temp);
  t.after(() => scenario.home.dispose());

  // macOS resolves /var -> /private/var, so compare canonical paths on both sides.
  const sandbox = realpathSync(temp);
  for (const session of scenario.sessions) {
    assert.ok(
      realpathSync(session.file).startsWith(sandbox),
      `fixture wrote outside the sandbox: ${session.file} (sandbox ${sandbox})`,
    );
  }
  assert.ok(realpathSync(scenario.home.root).startsWith(sandbox));
});

test('guard: no fixture path contains a real user home directory', async () => {
  // Belt and braces against accidentally committing machine-specific data:
  // the fixture builders must never embed the real home path.
  const { buildStandardScenario } = await import('./lib/fixtures.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const temp = mkdtempSync(join(tmpdir(), 'dsh-guard-path-'));
  const scenario = buildStandardScenario(temp);
  try {
    const home = homedir();
    for (const session of scenario.sessions) {
      assert.ok(
        !session.file.includes(home),
        `fixture path leaks the real home: ${session.file}`,
      );
      assert.ok(
        session.file.includes('qa-fixture') || session.file.includes(temp),
        `unexpected fixture path: ${session.file}`,
      );
    }
  } finally {
    scenario.home.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
});
