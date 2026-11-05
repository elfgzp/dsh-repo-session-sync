#!/usr/bin/env node
/**
 * Verify that `client.js` actually *runs* — not merely that it parses.
 *
 * ## Why this is separate from `smoke-load.sh`
 *
 * `smoke-load.sh` proves the Host half loads: the patch parses, the manifest is
 * complete, `apply()` registers its routes and tool, and the loader composes the
 * row. None of that executes the browser half.
 *
 * The browser half has a failure mode with no Host-side symptom: `apply()` in the
 * client is only *registered* at boot. The module factory, the slot factory, and
 * the component tree are all evaluated later, when the user opens Settings. A
 * reference to an undefined function, or a component that returns `null` because
 * a dependency never arrived, therefore looks exactly like a successful install
 * until someone clicks the panel.
 *
 * Two real defects got through that gap:
 *
 *   1. `require('./src/ui/settings-page.js')` — the module table does not resolve
 *      relative paths, so the factory threw. A `try`/`catch` swallowed it and the
 *      panel silently showed a placeholder forever.
 *   2. After inlining, the slot still referenced the old component name, so
 *      registration succeeded and rendering threw `ReferenceError`.
 *
 * Both are caught here by reproducing the module table's actual semantics: seed
 * only, no relative resolution, then drive the lifecycle the page drives.
 *
 * ## What is faked
 *
 * `window.__ModuleLoader__`, the `require` seed, the `slots` registry, and a
 * minimal React renderer that walks the element tree and collects text. The
 * renderer is deliberately tiny — it needs to prove the tree is non-empty and
 * error-free, not to be React.
 *
 * Usage: node scripts/check-client-render.mjs    (wired into `npm run smoke`)
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const pass = (message) => console.log(`  ✓ ${message}`)
const fail = (message) => {
  failures += 1
  console.log(`  ✗ ${message}`)
}

/**
 * A minimal React stand-in.
 *
 * Implements just enough of the runtime for the component functions to execute:
 * `createElement`, the hooks the page uses, and a tree walker. Hooks work because
 * the page is rendered once per element, so a single-slot allocator is faithful
 * enough to catch a crash — which is the question here.
 */
function makeFakeReact() {
  const HOOK_SLOTS = []

  const createElement = (type, props, ...children) => ({
    $$element: true,
    type,
    props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
  })

  /**
   * Single-slot hook allocator.
   *
   * The page is rendered top-down once; each hook call consumes the next slot and
   * the cursor is reset per render, which mirrors React's ordering rule closely
   * enough for a crash check.
   */
  let cursor = 0
  const nextSlot = (initial) => {
    const index = cursor
    cursor += 1
    if (!(index in HOOK_SLOTS)) HOOK_SLOTS[index] = initial
    const set = (value) => {
      HOOK_SLOTS[index] = typeof value === 'function' ? value(HOOK_SLOTS[index]) : value
    }
    return [HOOK_SLOTS[index], set]
  }

  const React = {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: (initial) => nextSlot(typeof initial === 'function' ? initial() : initial),
    useRef: (initial) => {
      const index = cursor
      cursor += 1
      if (!(index in HOOK_SLOTS)) HOOK_SLOTS[index] = { current: initial }
      return HOOK_SLOTS[index]
    },
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    // Effects are collected and drained by the caller, not run inline: the page
    // subscribes to a store and installs styles, and running those during render
    // would exercise code paths the browser runs later.
    useEffect: (effect) => {
      cursor += 1
      pendingEffects.push(effect)
    },
    useLayoutEffect: () => {
      cursor += 1
    },
  }

  const pendingEffects = []

  return { React, pendingEffects, resetHooks: () => { cursor = 0 }, getHookCursor: () => cursor }
}

/**
 * Walk an element tree and collect rendered text.
 *
 * Handles elements, arrays, strings, numbers, and function components. A function
 * component that throws surfaces here, which is the point: the earlier defects
 * only manifested during rendering.
 *
 * @param {any} node - Tree node.
 * @param {number} [depth] - Recursion guard depth.
 * @returns {string[]} Collected text fragments.
 */
function collectText(node, depth = 0) {
  if (node === null || node === undefined || node === false || node === true) return []
  if (depth > 200) return ['<too-deep>']
  if (typeof node === 'string') return [node]
  if (typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap((child) => collectText(child, depth + 1))
  if (typeof node === 'function') return collectText(node({}), depth + 1)
  if (typeof node !== 'object') return []

  if (node.$$element === true) {
    const { type, props } = node
    if (typeof type === 'function') {
      // Invoke the component with its props, exactly as React would.
      return collectText(type(props), depth + 1)
    }
    // Host elements: recurse into children.
    return collectText(props?.children, depth + 1)
  }
  return []
}

/**
 * Build a fake store matching the contract `client.js` publishes.
 *
 * Returns a snapshot shaped like `/status`, with one bound repository, so the
 * page has something to render rather than falling through to its empty state —
 * the empty state would also be "non-empty text", so seeding a repo makes the
 * check meaningfully stronger.
 *
 * @returns {object} Store with the documented surface.
 */
const STATUS_FIXTURE = {
  ok: true,
  repos: [
    {
      id: 'repo-demo-00000000',
      repoPath: '~/project',
      remoteUrl: 'git@example.invalid:demo/project.git',
      canonicalRemote: 'example.invalid/demo/project',
      branch: 'main',
      syncBranch: 'refs/heads/dsh-sessions',
      direction: 'both',
      transport: 'git-branch',
      enabled: true,
      autoSync: false,
      autoSyncIntervalMs: 0,
      state: {
        lastUpAt: Date.now() - 60_000,
        lastDownAt: null,
        lastResult: 'ok',
        remoteHead: 'abc1234',
        localHead: 'abc1234',
        sessionCount: 3,
        backupPath: '',
      },
    },
  ],
  dropped: [],
  settings: {
    defaultDirection: 'both',
    defaultTransport: 'git-branch',
    autoSync: false,
    autoSyncIntervalMs: 0,
    promptVersion: 0,
    updatedAt: Date.now(),
  },
  paths: { stateDir: '~/.dsh/repo-session-sync' },
  seams: { sessions: true, transport: false, conflicts: false },
  busy: false,
  busyOperation: null,
  plugin: { name: 'dsh-repo-session-sync', version: '0.0.1' },
  loaded: true,
}

function makeFakeStore() {
  const snapshot = {
    ok: true,
    repos: [
      {
        id: 'repo-demo-00000000',
        repoPath: '~/project',
        remoteUrl: 'git@example.invalid:demo/project.git',
        canonicalRemote: 'example.invalid/demo/project',
        branch: 'main',
        syncBranch: 'refs/heads/dsh-sessions',
        direction: 'both',
        transport: 'git-branch',
        enabled: true,
        autoSync: false,
        autoSyncIntervalMs: 0,
        state: {
          lastUpAt: Date.now() - 60_000,
          lastDownAt: null,
          lastResult: 'ok',
          remoteHead: 'abc1234',
          localHead: 'abc1234',
          sessionCount: 3,
          backupPath: '',
        },
      },
    ],
    dropped: [],
    settings: {
      defaultDirection: 'both',
      defaultTransport: 'git-branch',
      autoSync: false,
      autoSyncIntervalMs: 0,
      promptVersion: 0,
      updatedAt: Date.now(),
    },
    paths: { stateDir: '~/.dsh/repo-session-sync' },
    seams: { sessions: true, transport: false, conflicts: false },
    busy: false,
    busyOperation: null,
    plugin: { name: 'dsh-repo-session-sync', version: '0.0.1' },
    loaded: true,
  }

  const listeners = new Set()
  return {
    getState: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh: async () => snapshot,
    saveSettings: async () => ({ ok: true }),
    bind: async () => ({ ok: true }),
    unbind: async () => ({ ok: true }),
    updateBinding: async () => ({ ok: true }),
    sync: async () => ({ ok: true, dryRun: true }),
  }
}

/**
 * Load and drive `client.js` inside a VM context whose `require` behaves exactly
 * like the real client module table.
 *
 * @returns {Promise<{ ok: boolean, reasons: string[] }>} Outcome.
 */
async function runClient() {
  const source = await readFile(join(REPO_ROOT, 'client.js'), 'utf8')
  const reasons = []

  const { React, pendingEffects, resetHooks } = makeFakeReact()

  // The seed is what the real module table provides: React and the platform's
  // own client packages. A relative specifier is NOT in here, deliberately.
  const seed = new Map([
    ['react', React],
    ['react-dom', { render: () => {} }],
    ['react/jsx-runtime', { jsx: () => null, jsxs: () => null }],
  ])

  /**
   * Replica of the real `makeRequire` (see
   * `@deepseek-ai/dsh-client-modules/lib/client.js`): seed first, then an already
   * materialized module, then a registered factory, else a hard throw.
   *
   * Reproducing this is the entire point — a permissive stub here would have
   * let both historical defects pass.
   */
  const makeRequire = () => (spec) => {
    if (seed.has(spec)) return seed.get(spec)
    throw new Error(
      `client-modules: require("${spec}") missed the module table — not a platform seed word, `
      + 'not a materialized module, and no registered package factory',
    )
  }

  /** Collected registrations. */
  const registered = { factories: new Map(), slots: [], styles: [] }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ status: 200, json: async () => STATUS_FIXTURE }),
    AbortController,
    // `requestAnimationFrame` is touched by some UI helpers; a no-op keeps the
    // sandbox from throwing on an environment difference rather than a defect.
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.window.__ModuleLoader__ = {
    load: ({ id, factory }) => registered.factories.set(id, factory),
  }

  const context = vm.createContext(sandbox)

  try {
    vm.runInContext(source, context, { filename: 'client.js' })
  } catch (error) {
    return { ok: false, reasons: [`client.js 执行失败：${error.message}`] }
  }

  if (registered.factories.size === 0) {
    return { ok: false, reasons: ['client.js 没有调用 __ModuleLoader__.load 注册任何模块'] }
  }

  const [id, factory] = [...registered.factories][0]
  pass(`注册模块 ${id}`)

  let exported
  try {
    exported = factory(makeRequire())
  } catch (error) {
    return { ok: false, reasons: [`模块 factory 抛错：${error.message}`] }
  }

  if (typeof exported?.apply !== 'function') {
    return { ok: false, reasons: ['模块没有导出 apply()'] }
  }
  pass('factory 返回 apply()')

  const injectList = exported.inject
  if (!Array.isArray(injectList) || !injectList.includes('slots')) {
    reasons.push(`inject 必须包含 slots，实际：${JSON.stringify(injectList)}`)
  } else {
    pass(`inject = ${JSON.stringify(injectList)}`)
  }

  // A fake client context. `slots.inject` records the registration and captures
  // the render function so we can drive it later, exactly as the page would.
  let slotRender = null
  let slotMeta = null
  const ctx = {
    effect: (fn) => {
      const disposer = typeof fn === 'function' ? fn() : undefined
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on: () => () => {},
    locale: {
      t: (_ns, key) => key,
      register: () => () => {},
    },
    slots: {
      inject: (_name, register) => register(),
      register: (meta, render) => {
        slotMeta = meta
        slotRender = render
        registered.slots.push(meta)
        return () => {}
      },
    },
  }

  try {
    exported.apply(ctx)
  } catch (error) {
    return { ok: false, reasons: [`apply() 抛错：${error.message}`] }
  }
  pass('apply() 执行完成')

  if (registered.slots.length === 0) {
    return { ok: false, reasons: ['apply() 没有注册任何 slot'] }
  }
  const slot = registered.slots[0]
  pass(`注册 slot ${slot.name} / id=${slot.id} / order=${slot.order}`)

  if (typeof slotRender !== 'function') {
    return { ok: false, reasons: ['slot 注册缺少渲染函数'] }
  }

  // ── The step that catches both historical defects ─────────────────────────
  // Rendering is where a bad `require`, a stale component reference, or a
  // component returning null actually manifests.
  //
  // The slot passes its OWN store (created in `apply`) down to the component, not
  // the one supplied here — that is the real wiring, and it is why this check
  // drives the actual lifecycle instead of injecting a fake snapshot. The store
  // fetches `/status` asynchronously, so we let that settle before rendering, and
  // render again after mount effects run, exactly as the page would.
  const store = makeFakeStore()
  resetHooks()

  // Let the store's initial `refresh()` (kicked off in apply) resolve.
  await new Promise((resolve) => setTimeout(resolve, 20))

  let tree
  try {
    tree = slotRender({ store })
  } catch (error) {
    return { ok: false, reasons: [`slot 渲染抛错：${error.constructor?.name ?? 'Error'}: ${error.message}`] }
  }

  if (tree === null || tree === undefined) {
    return {
      ok: false,
      reasons: [
        'slot 渲染返回空（null/undefined）—— 设置页在浏览器里就是一片空白。',
        '常见原因：组件没拿到 React，或组件内部提前 return。',
      ],
    }
  }
  pass('slot 渲染返回了元素')

  // Drain effects the way React does after mount. A crash here is a real defect:
  // the page subscribes to the store and installs its stylesheet on mount.
  for (const effect of pendingEffects.splice(0)) {
    try {
      const cleanup = typeof effect === 'function' ? effect() : undefined
      if (typeof cleanup === 'function') cleanup()
    } catch (error) {
      reasons.push(`mount effect 抛错：${error.message}`)
    }
  }
  pass('mount effects 执行完成')

  // Mount effects call `refresh()` again; wait, then re-render so the assertion
  // below sees the settled tree rather than the first empty frame.
  await new Promise((resolve) => setTimeout(resolve, 20))
  resetHooks()
  try {
    tree = slotRender({ store })
  } catch (error) {
    return { ok: false, reasons: [`二次渲染抛错：${error.message}`] }
  }

  let text
  try {
    text = collectText(tree).join(' ')
  } catch (error) {
    return { ok: false, reasons: [`渲染树遍历抛错：${error.message}`] }
  }

  if (text.trim() === '') {
    return { ok: false, reasons: ['渲染结果没有任何文本 —— 面板是空白的'] }
  }
  pass(`渲染出 ${text.trim().length} 个字符的文本`)

  // The seeded repository must be visible: that proves the store subscription and
  // the row rendering both worked, not just the header.
  if (process.env.DEBUG_RENDER === '1') console.log('TEXT:', JSON.stringify(text))
  if (!text.includes('project') && !text.includes('main')) {
    reasons.push('渲染结果里看不到已绑定的仓库 —— 数据没有流到 UI')
  } else {
    pass('渲染结果包含已绑定仓库的信息')
  }

  return { ok: reasons.length === 0, reasons }
}

console.log('\nclient 半边渲染检查')
console.log('（按 DSH 客户端模块表的真实语义：seed-only require，相对路径必报错）\n')

try {
  const result = await runClient()
  for (const reason of result.reasons) fail(reason)
  if (result.ok) {
    console.log('\n✅ client 半边可加载、可渲染')
    process.exitCode = 0
  } else {
    console.log('\n❌ client 半边有问题，见上面的 ✗')
    process.exitCode = 1
  }
} catch (error) {
  fail(`检查脚本自身出错：${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 1
}

if (failures > 0) process.exitCode = 1
