/**
 * `src/ui/settings-page.js` 的单元测试。
 *
 * ## 为什么 UI 也要单测
 *
 * 这个文件里**没有 DOM**，全是纯函数与"给定 props 返回元素树"的组件，
 * 所以可以用一个极简的 `h` 桩把整棵树算出来做结构断言——不需要 jsdom、
 * 不需要浏览器、不需要快照测试。
 *
 * 真正要守住的是四类东西：
 *
 *   1. **错误文案覆盖**：`src/errors.js` 每加一个错误码，这里必须有中文文案，
 *      否则用户会看到裸错误码或英文。
 *   2. **危险操作必须二次确认**：下行写入 / 移除绑定不能一点就走。
 *   3. **可见性闸门不能被绕过**：公开仓库必须逐字输入仓库名 + 勾选知情。
 *   4. **降级不崩**：空快照、缺字段、坏数据都必须能渲染出东西。
 *
 * 运行：`node --test test/ui.test.js`
 *
 * @module dsh-repo-session-sync/test/ui
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import SettingsPage, { ERROR_TEXT, buildView, explainFailure } from '../src/ui/settings-page.js'
import { ERROR_CODE_LIST, ERROR_CODES } from '../src/errors.js'

// ─────────────────────────────────────────────────────────────────────────────
// 渲染脚手架
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一个极简的元素工厂，语义与 `React.createElement` 一致。
 *
 * 函数组件**立即求值**（把 children 放进 props 传进去），这样一次调用就能
 * 得到完整的结构树，不需要跑真正的 reconciler。
 */
function makeH() {
  return (type, props, ...children) => {
    const flat = children.flat(Infinity)
    if (typeof type === 'function') {
      return type({ ...(props || {}), children: flat.length <= 1 ? flat[0] : flat })
    }
    return { type, props: props || {}, children: flat }
  }
}

/** 一个够用的 React 桩。钩子返回初始值，副作用不执行。 */
function makeReact(h) {
  return {
    createElement: h,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
  }
}

/** 一个最小的 store 桩。 */
function makeStore(snapshot) {
  return {
    getState: () => snapshot,
    subscribe: () => () => {},
    refresh: async () => ({ ok: true }),
    sync: async () => ({ ok: true }),
    unbind: async () => ({ ok: true }),
    bind: async () => ({ ok: true }),
    saveSettings: async () => ({ ok: true }),
    updateBinding: async () => ({ ok: true }),
  }
}

/** 渲染并返回结构树。 */
function render({ snapshot = null, loading = false } = {}) {
  const h = makeH()
  const React = makeReact(h)
  const store = makeStore(snapshot)
  const tree = SettingsPage({ React, t: (key) => key, store, snapshot, loading })
  return { tree, h, React, store }
}

/** 收集一棵树里所有文本节点。 */
function collectText(node, acc = []) {
  if (node === null || node === undefined || node === false || node === true) return acc
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, acc)
    return acc
  }
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node))
    return acc
  }
  if (typeof node === 'function') return collectText(node({}), acc)
  collectText(node.children, acc)
  return acc
}

/** 收集所有按钮：`{ label, disabled, tone }`。 */
function collectButtons(node, acc = []) {
  if (node === null || node === undefined || node === false || node === true) return acc
  if (Array.isArray(node)) {
    for (const item of node) collectButtons(item, acc)
    return acc
  }
  if (typeof node === 'function') return collectButtons(node({}), acc)
  if (node.type === 'button') {
    const label = collectText(node.children).join('')
    acc.push({
      label,
      disabled: node.props.disabled === true,
      tone: node.props['data-tone'] || 'default',
      title: node.props.title,
    })
  }
  collectButtons(node.children, acc)
  return acc
}

/** 收集所有 input：`{ type, value, placeholder }`。 */
function collectInputs(node, acc = []) {
  if (node === null || node === undefined || node === false || node === true) return acc
  if (Array.isArray(node)) {
    for (const item of node) collectInputs(item, acc)
    return acc
  }
  if (typeof node === 'function') return collectInputs(node({}), acc)
  if (node.type === 'input') acc.push(node.props)
  collectInputs(node.children, acc)
  return acc
}

/** 一个形状完整的仓库，用于复用。 */
function repo(overrides = {}) {
  return {
    id: 'r1',
    repoPath: '/tmp/demo-repo',
    remoteUrl: 'git@github.com:acme/demo-repo.git',
    branch: 'main',
    direction: 'both',
    enabled: true,
    transport: 'git',
    state: { lastUpAt: 1_700_000_000_000, lastResult: 'ok', sessionCount: 12 },
    ...overrides,
  }
}

/** 一个形状完整的快照。 */
function snapshot(overrides = {}) {
  return {
    ok: true,
    repos: [repo()],
    dropped: [],
    settings: { defaultDirection: 'both' },
    paths: { stateDir: '~/.dsh/repo-session-sync' },
    seams: { sessions: false, transport: false, conflicts: false },
    busy: false,
    busyOperation: null,
    plugin: { name: 'dsh-repo-session-sync', version: '0.0.1' },
    loaded: true,
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 错误文案覆盖 —— 最重要的一组
// ─────────────────────────────────────────────────────────────────────────────

describe('错误文案', () => {
  test('⭐ 每个错误码都有中文文案（新增码忘了写会在这里红）', () => {
    const missing = ERROR_CODE_LIST.filter((code) => ERROR_TEXT[code] === undefined)
    assert.deepEqual(
      missing, [],
      `以下错误码缺少中文文案，用户会看到裸错误码：${missing.join(', ')}`,
    )
  })

  test('⭐ 每条文案都同时给出「发生了什么」和「该怎么办」', () => {
    for (const [code, entry] of Object.entries(ERROR_TEXT)) {
      assert.equal(typeof entry.what, 'string', `${code}: what 必须是字符串`)
      assert.equal(typeof entry.how, 'string', `${code}: how 必须是字符串`)
      assert.ok(entry.what.trim() !== '', `${code}: what 不能为空`)
      assert.ok(entry.how.trim() !== '', `${code}: how 不能为空 —— 只说"失败了"对用户没用`)
    }
  })

  test('文案里不出现裸错误码或英文异常', () => {
    for (const [code, entry] of Object.entries(ERROR_TEXT)) {
      const text = `${entry.what}${entry.how}`
      assert.ok(!text.includes(code), `${code}: 文案里不该出现错误码字面量`)
      assert.ok(!/Error:|Error\b|undefined|null|TypeError/.test(text), `${code}: 文案里不该出现英文异常词`)
    }
  })

  test('explainFailure 对已知错误码返回对应文案', () => {
    const explained = explainFailure({ ok: false, code: ERROR_CODES.AUTH_FAILED })
    assert.equal(explained.what, ERROR_TEXT[ERROR_CODES.AUTH_FAILED].what)
    assert.match(explained.how, /git push/, '认证失败要明确指引先手动跑通 git push')
  })

  test('explainFailure 对未知错误码给兜底，不显示码本身', () => {
    const explained = explainFailure({ ok: false, code: 'some-future-code' })
    assert.ok(explained.what !== '')
    assert.ok(!explained.what.includes('some-future-code'), '不能把未知错误码原样显示')
  })

  test('⭐ explainFailure 对英文异常只取第一行并套中文前缀', () => {
    const explained = explainFailure('Error: ECONNREFUSED 127.0.0.1:443\n    at foo (/bar.js:1:1)')
    assert.ok(!explained.what.includes('at foo'), '不能把栈帧显示出来')
    assert.ok(!explained.what.includes('\n'), '不能多行')
    assert.ok(explained.what.trim() !== '')
  })

  test('explainFailure 对 null/undefined/空串安全', () => {
    for (const value of [null, undefined, '', 0, false]) {
      const explained = explainFailure(value)
      assert.equal(typeof explained.what, 'string')
      assert.equal(typeof explained.how, 'string')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 降级与健壮性 —— 坏数据不能让页面崩
// ─────────────────────────────────────────────────────────────────────────────

describe('降级渲染', () => {
  test('没有 React 时返回 null 而不是抛异常', () => {
    assert.equal(SettingsPage({ t: () => '', store: {} }), null)
  })

  test('空快照能渲染出空状态', () => {
    const { tree } = render({ snapshot: null })
    const text = collectText(tree).join(' ')
    assert.match(text, /还没有绑定任何仓库/)
    assert.match(text, /添加仓库/)
  })

  test('repos 为空数组时显示空状态', () => {
    const { tree } = render({ snapshot: snapshot({ repos: [] }) })
    assert.match(collectText(tree).join(' '), /还没有绑定任何仓库/)
  })

  test('仓库缺字段也能渲染（不崩）', () => {
    const { tree } = render({
      snapshot: snapshot({ repos: [{ id: 'x' }, {}, { id: 'y', repoPath: null }] }),
    })
    assert.ok(tree !== null)
    assert.ok(collectText(tree).length > 0)
  })

  test('state 为 null 也能渲染', () => {
    const { tree } = render({ snapshot: snapshot({ repos: [repo({ state: null })] }) })
    assert.ok(tree !== null)
  })

  test('加载中且无数据时显示加载文案', () => {
    const { tree } = render({ snapshot: null, loading: true })
    assert.match(collectText(tree).join(' '), /正在读取绑定状态/)
  })

  test('seams 全 false 时给出解释而不是静默把按钮变灰', () => {
    const { tree } = render({ snapshot: snapshot() })
    const text = collectText(tree).join(' ')
    assert.match(text, /同步引擎还在接入中/)
    assert.match(text, /会话读取/)
    assert.match(text, /传输通道/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 安全：危险操作必须二次确认
// ─────────────────────────────────────────────────────────────────────────────

describe('危险操作的二次确认', () => {
  test('⭐ 下行按钮初始是「下行」，不是「确认拉取」', () => {
    const { tree } = render({ snapshot: snapshot() })
    const labels = collectButtons(tree).map((b) => b.label)
    assert.ok(labels.includes('下行'), '应该有一个「下行」按钮')
    assert.ok(!labels.includes('确认拉取'), '第一步不该直接出现确认态 —— 否则一点就写盘')
  })

  test('⭐ 移除绑定按钮初始是「移除绑定」，不是「确认移除」', () => {
    const { tree } = render({ snapshot: snapshot() })
    const labels = collectButtons(tree).map((b) => b.label)
    assert.ok(labels.includes('移除绑定'))
    assert.ok(!labels.includes('确认移除'), '移除绑定必须两步')
  })

  test('「添加仓库」不破坏性，可以直接点', () => {
    const { tree } = render({ snapshot: null })
    const add = collectButtons(tree).find((b) => b.label === '添加仓库')
    assert.ok(add, '空状态必须有添加按钮')
  })

  test('引擎未就绪时同步按钮置灰并说明原因', () => {
    const { tree } = render({ snapshot: snapshot() })
    const up = collectButtons(tree).find((b) => b.label === '上行')
    assert.ok(up)
    assert.equal(up.disabled, true, 'seams 不全时不该能点同步')
    assert.match(String(up.title ?? ''), /同步引擎接入后启用/)
  })

  test('界面里没有任何密码 / token 输入框', () => {
    const { tree } = render({ snapshot: snapshot() })
    const inputs = collectInputs(tree)
    for (const input of inputs) {
      assert.notEqual(input.type, 'password', '插件不保存凭据，不该出现密码框')
      const placeholder = String(input.placeholder ?? '').toLowerCase()
      assert.ok(!placeholder.includes('token'), '不该有 token 输入框')
      assert.ok(!placeholder.includes('password'), '不该有密码输入框')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. 可见性闸门
// ─────────────────────────────────────────────────────────────────────────────

describe('可见性闸门', () => {
  /**
   * 构造一个"公开仓库、未确认"的渲染。
   *
   * 可见性判定结果来自 `src/repo-visibility.js`，形状在这里手工构造，
   * 避免让 UI 测试耦合到那个模块的内部实现。
   */
  function renderWithVisibility(visibility, consentedIds = []) {
    const h = makeH()
    const React = makeReact(h)
    const snap = snapshot()
    const store = makeStore(snap)
    // 直接构造视图模型，绕开父组件的订阅逻辑
    const view = buildView(snap, { r1: visibility }, new Set(consentedIds))
    return { view, h, React, store }
  }

  test('⭐ 公开仓库会带上 requiresConfirmation 标记', () => {
    const { view } = renderWithVisibility({
      verdict: 'public',
      requiresConfirmation: true,
      requiresTypedConfirmation: true,
      confirmationPhrase: 'acme/demo-repo',
      reason: '公开仓库',
      hint: '改成私有',
    })
    assert.equal(view.repos[0].visibility.verdict, 'public')
    assert.equal(view.repos[0].needsConsent, true, '未确认的公开仓库应要求确认')
  })

  test('⭐ 已确认过的仓库不再要求确认', () => {
    const { view } = renderWithVisibility({
      verdict: 'public',
      requiresConfirmation: true,
      confirmationPhrase: 'acme/demo-repo',
    }, ['r1'])
    assert.equal(view.repos[0].needsConsent, false)
  })

  test('私有仓库不要求确认', () => {
    const { view } = renderWithVisibility({
      verdict: 'private',
      requiresConfirmation: false,
    })
    assert.equal(view.repos[0].needsConsent, false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. 视图模型
// ─────────────────────────────────────────────────────────────────────────────

describe('buildView', () => {
  test('从 repoPath 推出显示名', () => {
    const view = buildView(snapshot({ repos: [repo({ repoPath: '/home/someone/projects/demo-repo' })] }), {}, new Set())
    assert.equal(view.repos[0].name, 'demo-repo')
  })

  test('路径尾部斜杠不影响显示名', () => {
    const view = buildView(snapshot({ repos: [repo({ repoPath: '/tmp/demo-repo/' })] }), {}, new Set())
    assert.equal(view.repos[0].name, 'demo-repo')
  })

  test('lastResult=failed 映射成 failed 状态并带出错误', () => {
    const view = buildView(
      snapshot({ repos: [repo({ state: { lastResult: 'failed', lastError: { code: 'auth-failed' } } })] }),
      {}, new Set(),
    )
    assert.equal(view.repos[0].status, 'failed')
    assert.deepEqual(view.repos[0].lastFailure, { code: 'auth-failed' })
  })

  test('有 conflicts 时状态是 conflict', () => {
    const view = buildView(
      snapshot({ repos: [repo({ state: { lastResult: 'ok', conflicts: [{ sessionId: 's1' }] } })] }),
      {}, new Set(),
    )
    assert.equal(view.repos[0].status, 'conflict')
    assert.equal(view.conflicts.length, 1)
    assert.equal(view.conflicts[0].repoId, 'r1')
  })

  test('backupPath 存在时 canRestore 为 true（可撤销入口）', () => {
    const view = buildView(
      snapshot({ repos: [repo({ state: { backupPath: '/tmp/backup-1' } })] }), {}, new Set(),
    )
    assert.equal(view.repos[0].canRestore, true)
  })

  test('没有 backupPath 时 canRestore 为 false', () => {
    const view = buildView(snapshot({ repos: [repo({ state: {} })] }), {}, new Set())
    assert.equal(view.repos[0].canRestore, false)
  })

  test('非法 direction 兜底成 both', () => {
    const view = buildView(snapshot({ repos: [repo({ direction: 'sideways' })] }), {}, new Set())
    assert.equal(view.repos[0].direction, 'both')
  })

  test('空快照不抛异常', () => {
    const view = buildView(null, {}, new Set())
    assert.deepEqual(view.repos, [])
    assert.deepEqual(view.conflicts, [])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. 渲染完整性
// ─────────────────────────────────────────────────────────────────────────────

describe('完整渲染', () => {
  test('正常快照渲染出仓库信息与全部动作', () => {
    const { tree } = render({ snapshot: snapshot() })
    const text = collectText(tree).join(' ')
    assert.match(text, /仓库同步/)
    assert.match(text, /demo-repo/)
    assert.match(text, /main/)
    assert.match(text, /双向/)

    const labels = collectButtons(tree).map((b) => b.label)
    for (const expected of ['刷新', '添加仓库', '上行', '下行', '移除绑定']) {
      assert.ok(labels.includes(expected), `缺少按钮：${expected}`)
    }
  })

  test('方向为 up 时不显示下行按钮', () => {
    const { tree } = render({ snapshot: snapshot({ repos: [repo({ direction: 'up' })] }) })
    const labels = collectButtons(tree).map((b) => b.label)
    assert.ok(labels.includes('上行'))
    assert.ok(!labels.includes('下行'), '只上行的仓库不该给下游按钮')
  })

  test('方向为 down 时不显示上行按钮', () => {
    const { tree } = render({ snapshot: snapshot({ repos: [repo({ direction: 'down' })] }) })
    const labels = collectButtons(tree).map((b) => b.label)
    assert.ok(labels.includes('下行'))
    assert.ok(!labels.includes('上行'))
  })

  test('失败状态在页面上带出中文原因', () => {
    const { tree } = render({
      snapshot: snapshot({
        repos: [repo({ state: { lastResult: 'failed', lastError: { code: 'repo-path-missing' } } })],
      }),
    })
    const text = collectText(tree).join(' ')
    assert.match(text, /本地目录找不到了/, '应显示该错误码对应的中文文案')
  })

  test('有还原点时显示还原入口', () => {
    const { tree } = render({
      snapshot: snapshot({ repos: [repo({ state: { backupPath: '/tmp/b' } })] }),
    })
    assert.match(collectText(tree).join(' '), /同步前已备份/)
  })

  test('冲突单独成区并给出"没有覆盖任何一边"的安抚', () => {
    const { tree } = render({
      snapshot: snapshot({
        repos: [repo({ state: { lastResult: 'ok', conflicts: [{ sessionId: 'session-0001' }] } })],
      }),
    })
    const text = collectText(tree).join(' ')
    assert.match(text, /两端都被修改过/)
    assert.match(text, /没有覆盖任何一边/)
  })
})
