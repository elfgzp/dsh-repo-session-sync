#!/usr/bin/env node
/**
 * Splice `src/ui/settings-page.js` into `client.js`.
 *
 * ## Why this exists at all
 *
 * The client module table gives each package exactly **one** browser entry point
 * and its synchronous `require` resolves only platform seeds and already
 * registered factories:
 *
 *     require('./src/ui/settings-page.js')
 *     -> Error: require("./src/ui/settings-page.js") missed the module table
 *
 * `require.async('./x')` accepts a relative path, but only for a file named
 * `client.<name>.js` that self-registers through `__ModuleLoader__.load({chunk})`,
 * and only after an extra request. For a single settings panel that is a network
 * round trip and a build step for no benefit — so the UI is inlined instead,
 * which is also what every comparable plugin does (`dsh-settings-sync` ships one
 * 80 KB `client.js`, `dsh-branch-worktree` one 36 KB file).
 *
 * ## Why a script rather than a manual paste
 *
 * 1000+ lines copied by hand is a transcription risk with no upside: a dropped
 * line is a runtime `ReferenceError` inside the module factory, which surfaces as
 * a blank settings page. Generating the block means the splice is deterministic
 * and can be verified.
 *
 * ## Contract
 *
 * - **Source of truth:** `src/ui/settings-page.js`. Edit that, never the block.
 * - `scripts/build-client.mjs --check` verifies the block matches the source and
 *   is wired into `npm run smoke`, so drift fails a check instead of shipping.
 * - The source must stay dependency-free (no `import`, no `require`): it runs
 *   inside the factory scope with `React` and `h` already bound.
 *
 * Usage:
 *   node scripts/build-client.mjs           # regenerate the block in client.js
 *   node scripts/build-client.mjs --check   # verify it is up to date (exit 1 if not)
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UI_SOURCE = join(REPO_ROOT, 'src', 'ui', 'settings-page.js')
const CLIENT_FILE = join(REPO_ROOT, 'client.js')

/** Marker opening the generated region. */
const BEGIN = '    // ── BEGIN GENERATED: src/ui/settings-page.js ────────────────────────────'

/** Marker closing the generated region. */
const END = '    // ── END GENERATED ───────────────────────────────────────────────────────'

/**
 * The fixed preamble explaining the inlining to the next reader.
 *
 * Stated here rather than in the source file because it is a fact about *this*
 * file's constraints, and it must survive regeneration.
 */
const PREAMBLE = `    // ─────────────────────────────────────────────────────────────────────
    // Settings page UI — inlined from \`src/ui/settings-page.js\`.
    //
    // Do not edit this block by hand. The client module table has a single
    // entry point per package and its synchronous \`require\` resolves only
    // platform seeds (\`react\`, \`@deepseek-ai/dsh-client-*\`) and already
    // registered factories — it does not resolve relative paths at all:
    //
    //     require('./src/ui/settings-page.js')
    //     -> Error: require("./src/ui/settings-page.js") missed the module table
    //
    // \`require.async('./x')\` accepts a relative path, but only for a file named
    // \`client.<name>.js\` that registers itself through
    // \`__ModuleLoader__.load({ chunk: ... })\`, and only after an extra request.
    // Neither is worth it for one panel.
    //
    // Edit \`src/ui/settings-page.js\`, then run \`npm run build:client\`.
    // \`npm run smoke\` fails when the two drift.
    // ─────────────────────────────────────────────────────────────────────`

/**
 * Read the UI source and strip module syntax so it can live in a factory scope.
 *
 * Only leading `export` keywords and the React-from-props shim are transformed;
 * everything else is copied byte for byte, so a reviewer diffing the source
 * against the generated block sees no surprises.
 *
 * @returns {Promise<string>} The indented, dependency-free block body.
 */
async function buildBlockBody() {
  const raw = await readFile(UI_SOURCE, 'utf8')

  let body = raw
    .replace('export default function SettingsPage(', 'function SettingsPage(')
    .replace(/^export const /gm, 'const ')
    .replace(/^export function /gm, 'function ')
    .replace(/^export \{.*?\}\s*$/gm, '')

  // Verify rather than assume: a stray import would throw inside the factory at
  // load time, which shows up as a blank panel with no useful stack.
  const codeLines = body.split('\n')
  const strayExport = codeLines.filter((line) => /^export\b/.test(line))
  if (strayExport.length > 0) {
    throw new Error(`${UI_SOURCE} still has module exports on code lines:\n${strayExport.join('\n')}`)
  }
  const strayImport = codeLines.filter((line) => /^import\b/.test(line))
  if (strayImport.length > 0) {
    throw new Error(`${UI_SOURCE} must not import anything; found:\n${strayImport.join('\n')}`)
  }
  // Strip comments before looking for `require(`: the source legitimately
  // *mentions* `require('./src/ui/settings-page.js')` in its header to explain
  // why that call cannot exist, and a naive scan flags the explanation.
  const withoutComments = codeLines
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  if (/\brequire\s*\(/.test(withoutComments)) {
    throw new Error(`${UI_SOURCE} must not call require() — it runs inside the factory scope`)
  }

  // The UI reads React from props. Inside the factory React is already in scope,
  // and a second React instance would break hooks silently.
  const shim = "  const React = props.React || globalThis.__RSS_REACT__\n  if (!React || typeof React.createElement !== 'function') {\n    // 没有 React 时返回一个可读的降级节点，而不是让整个设置页白屏。\n    return null\n  }\n\n"
  if (!body.includes(shim)) {
    throw new Error(
      `${UI_SOURCE} no longer contains the expected React-from-props shim. `
      + 'Update scripts/build-client.mjs to match before regenerating.',
    )
  }
  body = body.replace(
    shim,
    '  // `React` comes from the enclosing factory scope (top of this file), not\n'
    + '  // from props: the module table seeds exactly one React instance, and\n'
    + '  // threading a second reference through props invites a duplicate.\n',
  )

  return body
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `    ${line}`))
    .join('\n')
}

/**
 * Compose the complete generated region.
 *
 * @returns {Promise<string>} The region text, markers included.
 */
async function renderRegion() {
  const body = await buildBlockBody()
  return `${BEGIN}\n${PREAMBLE}\n\n${body}\n${END}`
}

/**
 * Locate the generated region in the current `client.js`.
 *
 * @param {string} text - Current client source.
 * @returns {{ start: number, end: number }} Character offsets of the region.
 */
function locateRegion(text) {
  const start = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (start < 0 || end < 0) {
    throw new Error(
      `Markers not found in client.js. Expected:\n${BEGIN}\n...\n${END}\n`
      + 'Restore them from git history before regenerating.',
    )
  }
  if (end < start) throw new Error('client.js has the END marker before the BEGIN marker.')
  return { start, end: end + END.length }
}

/**
 * Entry point.
 *
 * @returns {Promise<number>} Process exit code.
 */
async function main() {
  const checkOnly = process.argv.includes('--check')
  const region = await renderRegion()
  const client = await readFile(CLIENT_FILE, 'utf8')
  const { start, end } = locateRegion(client)
  const current = client.slice(start, end)

  if (checkOnly) {
    if (current === region) {
      console.log('✅ client.js 的生成区块与 src/ui/settings-page.js 一致')
      return 0
    }
    console.error('❌ client.js 的生成区块与 src/ui/settings-page.js 不一致')
    console.error('   运行 `npm run build:client` 重新生成，然后重跑检查。')
    // Report the first differing line: a whole-block dump is unreadable.
    const a = current.split('\n')
    const b = region.split('\n')
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        console.error(`   首个差异在第 ${i + 1} 行:`)
        console.error(`     client.js: ${a[i] ?? '(缺失)'}`)
        console.error(`     生成结果:  ${b[i] ?? '(缺失)'}`)
        break
      }
    }
    return 1
  }

  if (current === region) {
    console.log('✅ 已是最新，无需改动')
    return 0
  }

  const next = client.slice(0, start) + region + client.slice(end)
  await writeFile(CLIENT_FILE, next, 'utf8')
  console.log('✅ 已重新生成 client.js 的 UI 区块')
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
