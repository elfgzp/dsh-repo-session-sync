# `src/` — file ownership

This directory is edited concurrently by several people. **Read this before you
write.** Two people editing one file silently overwrite each other; the runtime
gives no conflict warning, only a lost change.

When you take a file, update the row. When you need a change in someone else's
file, message them instead of editing it.

## Host half

| File | Owner | Responsibility | Status |
|---|---|---|---|
| `index.js` | skeleton (dev-core) | Cordis entry: resolves config, builds the store, exposes the engine through HTTP routes + the `repo_session_sync` tool + a systemPrompt section, owns the auto-sync timer. **Assembly only** — no session parsing, no transport, no conflict logic. | done |
| `config.js` | skeleton (dev-core) | Loader row schema (`Config`), user config document, merge rules, `resolveConfig()`. | done |
| `errors.js` | skeleton (dev-core) | `SyncError` and the stable `ERROR_CODES` enum every surface switches on. | done |
| `paths.js` | skeleton (dev-core) | `DSH_HOME` resolution and path-traversal guards. Any path crossing a trust boundary goes through `resolveInside()` / `assertSafeSegment()`. | done |
| `repo-binding.js` | skeleton (dev-core) | Repository identity (canonical remote URL + branch) and the `BindingTable`. | done |
| `store.js` | skeleton (dev-core) | Atomic persistence for config, bindings, sync state, and the operation log. | done |
| `engine.js` | **skeleton interface** (dev-core) → **implementation** (sync engine) | The engine contract: every public method, its result envelope, the operation lock, and the `ERROR_CODES` it can return. The body of `runDirection()` is the one function the implementation fills in. | interface done, **body stubbed** |
| `deps.js` | skeleton (dev-core) | Assembles the engine's seams. Loads `session-store.js` / `transport.js` / `conflict.js` when present, substitutes a `not-implemented` stub when absent, so a partial build still activates. | done |

## Engine half — **not owned by the skeleton**

| File | Owner | Responsibility | Status |
|---|---|---|---|
| `session-store.js` | sync engine (dev-sync) | Read and decode DSH session logs; write sessions back on download. | done |
| `transport.js` | sync engine (dev-sync) | Push/pull/probe a session bundle over the chosen channel. | **missing** |
| `conflict.js` | sync engine (dev-sync) | Decide what happens when both sides advanced. Must never silently overwrite. | **missing** |
| `anchor.js` | sync engine (dev-sync) | Record and compare the repository commit a session was based on (ADR-5). | done |

### Anchor data path

An anchor says what the repository looked like when a conversation happened. It
crosses three files and the remote, so the wiring is worth stating once:

| Step | Where | What |
|---|---|---|
| capture | `engine.js` `runUp`, via `anchor.js` `captureAnchor()` | once per upload, never per download — a download must not overwrite the recording |
| carry | `transport.js` `push` → manifest `anchor` | travels with the sessions; a locally-kept anchor is useless on the other machine |
| read | `transport.js` `pull` → `session.anchor` | validated with `normalizeAnchor()` because it is untrusted input |
| compare | `engine.js` `runDown`, via `describeAnchorDrift()` | per session, against this machine's HEAD |
| surface | `SyncResult.anchorDrift[]` | `{sessionId, status, commitsBehind, shortSha, message}`, advisory only |

`status` is one of `current` / `behind` / `diverged` / `missing-commit` / `none` /
`unknown`. **No status ever gates a sync** — the anchor is a hint about staleness,
and losing a conversation over a missing hint would be a bad trade.

`deps.js` degrades cleanly while these are absent: sync operations report
`not-implemented`, and binding plus the settings page keep working. That ordering
is deliberate — a plugin whose settings page is unreachable because the engine is
a work in progress cannot be configured, and an unconfigurable plugin cannot be
tested.

## UI half

| File | Owner | Responsibility |
|---|---|---|
| `../client.js` | skeleton (dev-core) | Browser shell: registers the `settings.section` slot, owns the `/status` store and the mutation helpers, mounts the page component. Never touches a credential or the filesystem — it can only ask the Host. |
| `ui/**` | UI (dev-ux) | The settings page itself. Must export `export default function SettingsPage(props)`. |
| `machines.js` | UI (dev-ux) | SSH host config reader used to pick a transport target. |
| `repo-visibility.js` | UI (dev-ux) | Remote-visibility gate for the pushing machine. The engine should call its `detectRegression` rather than reimplementing the rule. |

## The `client.js` ↔ `ui/**` contract

`client.js` supplies the props; `src/ui/settings-page.js` renders them. The shape
is fixed so the UI can be written against it before the engine lands.

```js
export default function SettingsPage(props): ReactElement
```

```js
{
  t: (key: string, vars?: object) => string,   // namespaced translator
  store: {
    getState(): StatusSnapshot,
    subscribe(fn): () => void,
    refresh(opts?: { force?: boolean }): Promise<StatusSnapshot>,
    saveSettings(patch): Promise<Result>,
    bind(input): Promise<Result>,
    unbind(repoId): Promise<Result>,
    updateBinding(patch): Promise<Result>,
    sync({ repoId, action, dryRun }): Promise<Result>,
  },
  snapshot: StatusSnapshot,
  loading: boolean,
  ...slotProps,
}
```

`Result` is `{ ok: true, ...data } | { ok: false, code, message, hint? }`.
`StatusSnapshot` is documented at the top of `client.js`.

The page is resolved lazily: if `ui/settings-page.js` is missing, the section
renders a notice instead of breaking the whole Settings surface.

## Conventions

- **No hardcoded machine paths.** Resolve the DSH home through
  `paths.resolveDshHome()` (service → `DSH_HOME` → `~/…`), never as a literal.
  The repository is public and a personal path in a source file is a leak.
- **No credentials, ever.** Authentication for a remote is whatever the user's
  own `git` already uses. Nothing in this package stores, logs, or forwards one.
- **Every failure carries a `code`** from `errors.js`. A message alone is not a
  contract: the UI branches on the code, not on prose.
- **Never write a session directory without a backup first.** That obligation
  belongs to the engine method being called, not to its caller.
- Pure modules (`paths`, `repo-binding`, `errors`, `store`, `config`) import only
  `node:` built-ins, so they are testable with `node --test` and no DSH install.
  `engine.js` and `deps.js` follow the same rule. Only `index.js` touches Cordis.
