/**
 * Synthetic DSH session fixtures.
 *
 * Every byte produced here is invented. No real `~/.dsh` data, no real machine
 * paths, no real UUIDs are ever copied in. Fixtures use reserved-but-valid
 * values:
 *   - session ids:  session-00000000-0000-4000-8000-0000000000NN (RFC 4122 v4 shape)
 *   - repo paths:   /tmp/qa-fixture/<repo>
 *   - timestamps:   fixed epoch, so runs are reproducible
 *
 * The on-disk layout and event shapes mirror what DSH really writes (verified
 * against real files, see test/README.md), so an implementation that works on
 * these fixtures works on real sessions.
 */

import { mkdirSync, writeFileSync, rmSync, renameSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeFrame } from './zstd-frame.mjs';

/** Fixed base timestamp so fixtures are byte-reproducible across runs. */
export const FIXTURE_EPOCH = 1_700_000_000_000;

/** Synthetic session id generator. `n` is a 1-based index. */
export function fixtureSessionId(n) {
  const suffix = String(n).padStart(12, '0');
  return `session-00000000-0000-4000-8000-${suffix}`;
}

/**
 * Synthetic *bare* uuid (subagent child session directory shape). `n` is a
 * 1-based index, kept distinct from `fixtureSessionId` by a different prefix.
 */
export function bareUuidFor(n) {
  const suffix = String(n).padStart(12, '0');
  return `00000000-0000-4000-9000-${suffix}`;
}

/**
 * Encode a cwd into a DSH `projectKey` directory name.
 *
 * VERIFIED against real session directories on this machine (7/7): the only
 * rewrite at this layer is `/` -> `-`, everything else is kept literally
 * (`.`, `_`, `-` all survive: real dirs contain `.dsh`, `elfguan__dsh`,
 * `gongfeng-mr`). The mapping is LOSSY because a literal `-` in a path is
 * indistinguishable from a separator, so a cwd can never be recovered from the
 * directory name. Implementations must read `cwd` from the session header.
 *
 * (`~XXXX` escaping belongs to the *sessionId segment* layer, see
 * `encodeSegmentName` below — it does NOT apply to projectKey.)
 *
 * @param {string} cwd absolute path
 * @returns {string}
 */
export function projectKeyForCwd(cwd) {
  return `--${String(cwd).replace(/^\//, '').replaceAll('/', '-')}--`;
}

/**
 * Encode a session id into its on-disk directory segment.
 *
 * Two shapes genuinely coexist on disk and are NOT legacy:
 *   - `session-<uuid>` -> top-level session
 *   - bare `<uuid>`    -> subagent child session, carries `parentSession`
 *
 * Verified on 218 real sessions: `header.id` equals the directory name in
 * 218/218 cases, and all 151 bare-uuid sessions carry a `parentSession`.
 * Implementations therefore must NOT strip a `session-` prefix when matching.
 *
 * @param {string} sessionId e.g. `session-00000000-0000-4000-8000-000000000001`
 * @returns {string} on-disk segment (`.`/`..` and unsafe chars escaped)
 */
export function encodeSegmentName(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9_-]/g, (ch) => {
    return '~' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  });
}

/**
 * Event builders. Shapes match real DSH events; payload text is invented.
 * Each helper returns a plain object — `seq`/`time` are assigned by the caller
 * via `buildSessionBody` so ordering stays consistent.
 */
export const events = {
  turnStart: (turn) => ({ type: 'turn/start', data: { turn } }),
  stepStart: (turn, step) => ({ type: 'step/start', data: { turn, step } }),
  stepEnd: (turn, step) => ({ type: 'step/end', data: { turn, step } }),
  turnEnd: (turn, reason = { kind: 'completed' }) => ({ type: 'turn/end', data: { turn, reason } }),

  userMessage: (text, turn = 1, step = 1) => ({
    type: 'user/message',
    data: { turn, step, message: { role: 'user', content: [{ type: 'text', text }] } },
  }),

  assistantMessage: (text, turn = 1, step = 1) => ({
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  }),

  title: (title) => ({
    type: 'session/title',
    data: { title, messageSeqs: [], source: { kind: 'user' } },
  }),

  permissionPreset: (preset = 'workspace-write') => ({
    type: 'permission/preset',
    data: { preset },
  }),
  sandboxMode: (mode = 'workspace-write') => ({ type: 'sandbox/mode', data: { mode } }),
  approvalPolicy: (policy = 'ask') => ({ type: 'approval/policy', data: { policy } }),
};

/**
 * Build the ordered event list for a session with `rounds` user+assistant
 * exchanges, then attach `seq`/`time` the way DSH does (seq from 0, strictly
 * +1; only the header line has no `seq`).
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @param {string|null} options.cwd           null -> an orphan "no cwd" session
 * @param {number} [options.rounds]           number of user/assistant exchanges
 * @param {number} [options.startSeq]         continue numbering (for appends)
 * @param {number} [options.startTime]
 * @param {boolean} [options.headerOnly]      true -> emit only the header line
 * @returns {{header: object, body: object[]}}
 */
export function buildSession({
  sessionId,
  cwd,
  rounds = 0,
  startSeq = 0,
  startTime = FIXTURE_EPOCH,
  headerOnly = false,
  agentPreset = 'cordis',
  parentSession,
  origin,
  delegationDepth = 0,
}) {
  const header = {
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt: startTime,
    cwd,
    isSeeded: false,
    delegationDepth,
    agentPreset,
  };
  // Subagent child sessions carry these two extra fields; real ones always do.
  if (parentSession !== undefined) header.parentSession = parentSession;
  if (origin !== undefined) header.origin = origin;

  const body = [];
  if (!headerOnly) {
    body.push(events.permissionPreset());
    body.push(events.sandboxMode());
    body.push(events.approvalPolicy());
    body.push(events.title(`fixture ${sessionId.slice(-4)}`));

    for (let round = 1; round <= rounds; round++) {
      body.push(events.turnStart(round));
      body.push(events.stepStart(round, 1));
      body.push(events.userMessage(`synthetic user message, round ${round}`, round, 1));
      body.push(events.assistantMessage(`synthetic assistant reply, round ${round}`, round, 1));
      body.push(events.stepEnd(round, 1));
      body.push(events.turnEnd(round));
    }
  }

  let seq = startSeq;
  let time = startTime;
  for (const event of body) {
    event.seq = seq++;
    event.time = ++time;
  }
  return { header, body };
}

/**
 * Serialise a session to the on-disk form: JSONL, one zstd frame per durable
 * append. Frame 0 always holds just the header line (matching real DSH files,
 * whose first frame decodes to exactly one line).
 *
 * @param {{header: object, body: object[]}} session
 * @param {object} [options]
 * @param {number} [options.eventsPerFrame] body events per appended frame
 * @returns {Buffer}
 */
export function serializeSession(session, { eventsPerFrame = 4 } = {}) {
  const frames = [];
  frames.push(encodeFrame(toLine(session.header) + '\n'));

  if (session.body.length === 0) return Buffer.concat(frames);

  for (let i = 0; i < session.body.length; i += eventsPerFrame) {
    const chunk = session.body.slice(i, i + eventsPerFrame);
    frames.push(encodeFrame(chunk.map(toLine).join('\n') + '\n'));
  }
  return Buffer.concat(frames);
}

function toLine(value) {
  return JSON.stringify(value);
}

/**
 * Write a session fixture to disk under `<dshHome>/sessions/<projectKey>/<id>/`.
 *
 * @param {object} options
 * @param {string} options.dshHome       temp DSH_HOME root
 * @param {string} options.sessionId
 * @param {string|null} options.cwd
 * @param {number} [options.rounds]
 * @param {string} [options.projectKeyOverride] force a mismatched dir name
 * @param {Buffer} [options.raw]         write these bytes verbatim instead
 * @returns {{dir: string, projectKey: string, file: string, bytes: number}}
 */
export function writeSession({
  dshHome,
  sessionId,
  cwd,
  rounds = 0,
  projectKeyOverride,
  raw,
  eventsPerFrame = 4,
  headerOnly = false,
  parentSession,
  origin,
  delegationDepth,
  /** Write the directory using a bare-uuid segment (subagent shape). */
  bareUuidDir = false,
}) {
  const projectKey = projectKeyOverride ?? (cwd === null ? '_no-cwd' : projectKeyForCwd(cwd));
  const segment = bareUuidDir ? String(sessionId).replace(/^session-/, '') : encodeSegmentName(sessionId);
  const dir = join(dshHome, 'sessions', projectKey, segment);
  mkdirSync(dir, { recursive: true });

  let bytes;
  if (raw) {
    bytes = raw;
  } else {
    const session = buildSession({
      sessionId,
      cwd,
      rounds,
      headerOnly,
      parentSession,
      origin,
      delegationDepth,
    });
    bytes = serializeSession(session, { eventsPerFrame });
  }

  const file = join(dir, 'session.v4.jsonl.zstd');
  writeFileSync(file, bytes);
  // DSH keeps an empty lock file next to the log.
  writeFileSync(join(dir, 'session.lock'), '');
  return { dir, projectKey, segment, file, bytes: bytes.length, sessionId };
}

/**
 * Append more rounds to an existing fixture session, the way DSH appends
 * frames. Returns the new, longer byte sequence (old bytes stay a prefix).
 *
 * @param {object} options
 * @param {string} options.file          existing session file
 * @param {number} options.fromRound     first new round number (1-based)
 * @param {number} options.nextSeq       seq to continue from
 * @param {number} [options.rounds]      how many rounds to add
 * @returns {{bytes: number, nextSeq: number}}
 */
export function appendRounds({ file, fromRound, nextSeq, rounds = 1, startTime = FIXTURE_EPOCH }) {
  const current = readFileSafe(file);
  const body = [];
  let time = startTime;
  for (let i = 0; i < rounds; i++) {
    const round = fromRound + i;
    body.push(events.turnStart(round));
    body.push(events.stepStart(round, 1));
    body.push(events.userMessage(`synthetic user message, round ${round}`, round, 1));
    body.push(events.assistantMessage(`synthetic assistant reply, round ${round}`, round, 1));
    body.push(events.stepEnd(round, 1));
    body.push(events.turnEnd(round));
  }
  let seq = nextSeq;
  for (const event of body) {
    event.seq = seq++;
    event.time = ++time;
  }
  // One extra frame per append, exactly like a durable DSH write.
  const appended = encodeFrame(body.map(toLine).join('\n') + '\n');
  writeFileSync(file, Buffer.concat([current, appended]));
  return { bytes: current.length + appended.length, nextSeq: seq };
}

function readFileSafe(file) {
  return readFileSync(file);
}

/** A temp DSH_HOME plus helpers, cleaned up by `dispose()`. */
export function makeTempDshHome(baseDir) {
  const root = join(baseDir, `dsh-home-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(root, 'sessions'), { recursive: true });
  mkdirSync(join(root, 'storages'), { recursive: true });
  return {
    root,
    sessionsDir: join(root, 'sessions'),
    /** Create the default workspace registry file. */
    writeWorkspaceRegistry({ workspacePath = '/tmp/qa-fixture/repo-a', sessionIds = [], archivedSessionIds = [] } = {}) {
      const registry = {
        unit: { name: 'workspace', version: 2 },
        global: {
          initialized: true,
          defaultWorkspaceId: '11111111-1111-4111-8111-111111111111',
          workspaceIds: ['11111111-1111-4111-8111-111111111111'],
          archivedSessionIds,
          pinnedSessionIds: [],
        },
        tables: {
          workspaces: {
            '11111111-1111-4111-8111-111111111111': {
              path: workspacePath,
              title: workspacePath.split('/').pop() || 'workspace',
              sessionIds,
              createdAt: new Date(FIXTURE_EPOCH).toISOString(),
              updatedAt: new Date(FIXTURE_EPOCH).toISOString(),
            },
          },
        },
      };
      writeFileSync(join(root, 'storages', 'workspace.json'), JSON.stringify(registry, null, 2));
      return registry;
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Standard scenario used by most tests: two repos, with the edge cases the
 * brief calls for.
 *
 *  repo-a: 2 sessions (one with 3 rounds, one empty/header-only)
 *  repo-b: 1 session (1 round)
 *  plus: archived session, orphan session (cwd deleted), mismatched dir name
 *
 * @param {string} baseDir temp dir owned by the caller
 */
export function buildStandardScenario(baseDir) {
  const home = makeTempDshHome(baseDir);
  const repoA = '/tmp/qa-fixture/repo-a';
  const repoB = '/tmp/qa-fixture/repo-b';

  const sessions = [];
  sessions.push(
    writeSession({ dshHome: home.root, sessionId: fixtureSessionId(1), cwd: repoA, rounds: 3 }),
  );
  sessions.push(
    writeSession({ dshHome: home.root, sessionId: fixtureSessionId(2), cwd: repoA, rounds: 1 }),
  );
  sessions.push(
    writeSession({ dshHome: home.root, sessionId: fixtureSessionId(3), cwd: repoB, rounds: 1 }),
  );
  // Empty session: header line only, no body events.
  sessions.push(
    writeSession({ dshHome: home.root, sessionId: fixtureSessionId(4), cwd: repoA, rounds: 0 }),
  );
  // Orphan: cwd points at a directory that no longer exists.
  sessions.push(
    writeSession({ dshHome: home.root, sessionId: fixtureSessionId(5), cwd: '/tmp/qa-fixture/gone-repo', rounds: 1 }),
  );
  // Session with no cwd at all -> lives under `_no-cwd`.
  sessions.push(
    writeSession({ dshHome: home.root, sessionId: fixtureSessionId(6), cwd: null, rounds: 1 }),
  );
  // Directory name deliberately disagrees with the header cwd. Any code that
  // trusts the directory name will mis-file this session.
  sessions.push(
    writeSession({
      dshHome: home.root,
      sessionId: fixtureSessionId(7),
      cwd: repoA,
      rounds: 1,
      projectKeyOverride: projectKeyForCwd('/tmp/qa-fixture/decoy-repo'),
    }),
  );
  // Subagent child session: bare-uuid directory, carries parentSession pointing
  // at session 1. Real machines have far more of these than top-level sessions
  // (151 vs 67 measured), so a scanner that only looks for `session-` directories
  // misses ~69% of sessions.
  sessions.push(
    writeSession({
      dshHome: home.root,
      sessionId: `${bareUuidFor(8)}`,
      cwd: repoA,
      rounds: 1,
      bareUuidDir: true,
      parentSession: fixtureSessionId(1),
      origin: 'subagent',
      delegationDepth: 1,
    }),
  );
  // A top-level session whose own id is `session-<uuid>` but whose parent is
  // absent — this is the ordinary case and must not be treated as a child.
  sessions.push(writeSession({ dshHome: home.root, sessionId: fixtureSessionId(9), cwd: repoA, rounds: 1 }));

  home.writeWorkspaceRegistry({
    workspacePath: repoA,
    sessionIds: [fixtureSessionId(1), fixtureSessionId(2), fixtureSessionId(4)],
    archivedSessionIds: [fixtureSessionId(2)],
  });

  return { home, repoA, repoB, sessions };
}

/** Recursively list files under `dir` (absolute paths). */
export function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

export { renameSync, rmSync, mkdirSync, writeFileSync, existsSync };
