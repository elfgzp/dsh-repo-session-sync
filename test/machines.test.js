/**
 * `src/machines.js` 的单元测试。
 *
 * 三条铁律：
 *   1. **只用临时目录**（`os.tmpdir()`），全程不碰真实的 `~/.ssh/config`。
 *   2. **只用合成数据**：主机名一律用文档保留段 `192.0.2.x`（RFC 5737），
 *      别名用 `demo-*`，不出现任何真实机器名。
 *   3. 每个测试结束时清理，不留垃圾。
 *
 * 运行：`node --test test/machines.test.js`
 *
 * @module dsh-repo-session-sync/test/machines
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  MANAGED_MARK,
  addMachine,
  buildMachineOverview,
  createMachineId,
  createMachineInSshConfig,
  explainSshFailure,
  hostBlockMatches,
  isConcreteAlias,
  joinContinuations,
  listHostAliases,
  loadExpandedConfigText,
  normalizeMachineRecord,
  parseHostBlocks,
  parseMachineRegistry,
  parseSshGOutput,
  probeSshAlias,
  readRawSshConfig,
  removeMachine,
  removeMachineFromSshConfig,
  removeManagedHostBlock,
  resolveSshAlias,
  serializeMachineRegistry,
  splitValue,
  updateMachine,
  upsertManagedHostBlock,
  validateAlias,
  writeSshConfig,
} from '../src/machines.js'

// ─────────────────────────────────────────────────────────────────────────────
// 测试脚手架
// ─────────────────────────────────────────────────────────────────────────────

/** 建一个临时目录，测试结束自动删。 */
function withTmpDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rss-machines-'))
  t.after(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 已删 */ }
  })
  return dir
}

/**
 * 一段合成的、形状接近真实世界的 ssh 配置。
 *
 * 覆盖：普通块、多别名块、通配符块、否定模式、行续接、注释、重复参数。
 * **所有主机地址都是文档保留段，不是真实 IP。**
 */
const SAMPLE_CONFIG = `# 合成测试配置 —— 所有地址来自 RFC 5737 文档保留段

Host demo-alpha
  HostName 192.0.2.10
  User alice
  IdentityFile ~/.ssh/id_ed25519

Host demo-beta demo-beta-alias
  HostName 192.0.2.11
  User bob
  Port 2222

Host *.wild.example
  User wildcard

Host !excluded.example *.partial.example
  User partial

Host demo-gamma
  HostName 192.0.2.12
  User carol
  ForwardAgent yes
  # 用户自己的注释

Host *
  ServerAliveInterval 60
`

const TMP_LABEL = 'demo-repo'

// ─────────────────────────────────────────────────────────────────────────────
// 1. 文本工具
// ─────────────────────────────────────────────────────────────────────────────

describe('文本工具', () => {
  test('splitValue 保留引号内的空格', () => {
    assert.deepEqual(splitValue('alpha "beta gamma" delta'), ['alpha', 'beta gamma', 'delta'])
    assert.deepEqual(splitValue("'single quoted' plain"), ['single quoted', 'plain'])
    assert.deepEqual(splitValue('   '), [])
    assert.deepEqual(splitValue(''), [])
  })

  test('joinContinuations 合并反斜杠续行', () => {
    const text = 'Host demo\n  ProxyCommand ssh \\\n    -W %h:%p jump\n  User alice'
    const lines = joinContinuations(text)
    assert.equal(lines.length, 3)
    assert.ok(lines[1].includes('-W %h:%p'), '续行应被合并到上一行')
  })

  test('joinContinuations 不把转义的反斜杠当续行', () => {
    const lines = joinContinuations('a \\\\\nb')
    assert.equal(lines.length, 2, '行尾两个反斜杠是字面反斜杠，不是续行')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 解析
// ─────────────────────────────────────────────────────────────────────────────

describe('解析 Host 块', () => {
  test('parseHostBlocks 抓出块与参数', () => {
    const blocks = parseHostBlocks(SAMPLE_CONFIG)
    const alpha = blocks.find((b) => b.patterns.includes('demo-alpha'))
    assert.ok(alpha, '应找到 demo-alpha 块')
    assert.equal(alpha.values.hostname, '192.0.2.10')
    assert.equal(alpha.values.user, 'alice')
  })

  test('一个 Host 行可以点名多个别名', () => {
    const blocks = parseHostBlocks(SAMPLE_CONFIG)
    const beta = blocks.find((b) => b.patterns.includes('demo-beta'))
    assert.deepEqual(beta.patterns, ['demo-beta', 'demo-beta-alias'])
  })

  test('重复参数按"第一个生效"（OpenSSH 语义）', () => {
    const blocks = parseHostBlocks('Host demo\n  User first\n  User second\n')
    assert.equal(blocks[0].values.user, 'first')
  })

  test('端口解析成数字', () => {
    const blocks = parseHostBlocks('Host demo\n  Port 2222\n')
    assert.equal(blocks[0].values.port, 2222)
  })

  test('注释与空行被跳过', () => {
    const blocks = parseHostBlocks('# 注释\n\nHost demo\n  # 块内注释\n  User x\n')
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].values.user, 'x')
  })
})

describe('listHostAliases —— 只要具体的机器名', () => {
  test('只列出具体别名，排除通配与否定模式', () => {
    const aliases = listHostAliases(SAMPLE_CONFIG)
    assert.ok(aliases.includes('demo-alpha'))
    assert.ok(aliases.includes('demo-beta'))
    assert.ok(aliases.includes('demo-beta-alias'))
    assert.ok(aliases.includes('demo-gamma'))
    assert.ok(!aliases.includes('*'), '星号通配不应出现')
    assert.ok(!aliases.includes('*.wild.example'), '通配模式不应出现')
    assert.ok(!aliases.includes('*.partial.example'), '通配模式不应出现')
    // `Host !x *.y` 里的 `!x` 是「排除条件」，不是一台机器。
    assert.ok(!aliases.includes('!excluded.example'), '否定模式不是机器定义')
    assert.ok(!aliases.includes('excluded.example'), '否定模式拆开后也不该被当成机器')
  })

  test('结果去重且有序', () => {
    const aliases = listHostAliases('Host b a\nHost a\n')
    assert.deepEqual(aliases, ['a', 'b'])
  })

  test('空文本返回空数组', () => {
    assert.deepEqual(listHostAliases(''), [])
    assert.deepEqual(listHostAliases(undefined), [])
  })
})

describe('isConcreteAlias', () => {
  test('普通名字是具体别名', () => {
    assert.equal(isConcreteAlias('demo-alpha'), true)
    assert.equal(isConcreteAlias('192.0.2.10'), true)
  })

  test('通配/否定/多选都不是具体别名', () => {
    for (const bad of ['*', '*.example.com', '!excluded', 'a,b', 'has space', '']) {
      assert.equal(isConcreteAlias(bad), false, `${bad} 不应被当成具体机器名`)
    }
  })
})

describe('hostBlockMatches —— OpenSSH 模式语义', () => {
  test('通配匹配', () => {
    assert.equal(hostBlockMatches(['*.example.com'], 'host.example.com'), true)
    assert.equal(hostBlockMatches(['*.example.com'], 'host.other.com'), false)
  })

  test('问号匹配单个字符', () => {
    assert.equal(hostBlockMatches(['demo-?'], 'demo-a'), true)
    assert.equal(hostBlockMatches(['demo-?'], 'demo-ab'), false)
  })

  test('否定模式排除', () => {
    assert.equal(hostBlockMatches(['*', '!bad.example'], 'good.example'), true)
    assert.equal(hostBlockMatches(['*', '!bad.example'], 'bad.example'), false)
  })

  test('匹配大小写不敏感', () => {
    assert.equal(hostBlockMatches(['Demo-Alpha'], 'demo-alpha'), true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Include 展开
// ─────────────────────────────────────────────────────────────────────────────

describe('Include 展开', () => {
  test('展开相对的 Include 文件', (t) => {
    const dir = withTmpDir(t)
    const sub = path.join(dir, 'conf.d')
    mkdirSync(sub, { recursive: true })
    writeFileSync(path.join(sub, 'extra.conf'), 'Host demo-from-include\n  User ivan\n')
    const main = path.join(dir, 'config')
    writeFileSync(main, 'Host demo-main\n  User mainuser\n\nInclude conf.d/*.conf\n')

    const text = loadExpandedConfigText(main)
    assert.ok(text.includes('demo-main'))
    assert.ok(text.includes('demo-from-include'), 'Include 的内容应被展开进来')
  })

  test('缺失的 Include 被跳过，不影响其余配置', (t) => {
    const dir = withTmpDir(t)
    const main = path.join(dir, 'config')
    writeFileSync(main, 'Include does-not-exist.conf\nHost demo-kept\n  User u\n')
    const text = loadExpandedConfigText(main)
    assert.ok(text.includes('demo-kept'), '一行坏配置不该让整份文件失效')
  })

  test('文件不存在时返回空串（不抛异常）', () => {
    assert.equal(loadExpandedConfigText('/nonexistent/path/to/config'), '')
  })

  test('循环 Include 不会无限递归', (t) => {
    const dir = withTmpDir(t)
    const a = path.join(dir, 'a.conf')
    const b = path.join(dir, 'b.conf')
    writeFileSync(a, 'Include b.conf\nHost demo-a\n  User x\n')
    writeFileSync(b, 'Include a.conf\nHost demo-b\n  User y\n')
    const text = loadExpandedConfigText(a)
    assert.ok(text.includes('demo-a'))
    assert.ok(text.length < 10000, '应有深度限制，不会爆炸')
  })
})

/** 测试辅助：建目录（递归）。 */
// ─────────────────────────────────────────────────────────────────────────────
// 4. ssh -G 解析
// ─────────────────────────────────────────────────────────────────────────────

describe('parseSshGOutput', () => {
  test('抓出白名单字段', () => {
    const stdout = [
      'host demo-alpha',
      'hostname 192.0.2.10',
      'user alice',
      'port 22',
      'proxyjump none',
      'identityfile ~/.ssh/id_ed25519',
      'forwardagent no',
    ].join('\n')
    const parsed = parseSshGOutput(stdout)
    assert.equal(parsed.hostName, '192.0.2.10')
    assert.equal(parsed.user, 'alice')
    assert.equal(parsed.port, 22)
    assert.equal(parsed.proxyJump, '', '"none" 应归一成空串')
  })

  test('identityfile 不在返回结果里（本机隐私）', () => {
    const parsed = parseSshGOutput('identityfile ~/.ssh/id_ed25519\n')
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'identityFile'), false)
    assert.ok(!JSON.stringify(parsed).includes('id_ed25519'), '私钥路径不得出现在解析结果里')
  })

  test('空输出返回空字段', () => {
    const parsed = parseSshGOutput('')
    assert.equal(parsed.hostName, '')
    assert.equal(parsed.user, '')
    assert.equal(parsed.port, 0)
  })
})

describe('resolveSshAlias —— 注入执行器，不真的连网', () => {
  test('成功解析', async () => {
    const result = await resolveSshAlias('demo-alpha', {
      run: async () => ({ stdout: 'hostname 192.0.2.10\nuser alice\nport 22\n', stderr: '' }),
    })
    assert.equal(result.ok, true)
    assert.equal(result.hostName, '192.0.2.10')
    assert.equal(result.user, 'alice')
    assert.equal(result.alias, 'demo-alpha')
  })

  test('空别名给出中文提示', async () => {
    const result = await resolveSshAlias('')
    assert.equal(result.ok, false)
    assert.match(result.error, /别名是空的/)
  })

  test('通配模式被拒绝并给出中文提示', async () => {
    const result = await resolveSshAlias('*.example.com')
    assert.equal(result.ok, false)
    assert.match(result.error, /通配模式/)
  })

  test('执行失败时返回 ok:false 而不是抛异常', async () => {
    const result = await resolveSshAlias('demo-alpha', {
      run: async () => { throw Object.assign(new Error('boom'), { stderr: 'Could not resolve hostname' }) },
    })
    assert.equal(result.ok, false)
    assert.ok(result.error.length > 0)
  })
})

describe('probeSshAlias —— 注入执行器，不真的连网', () => {
  test('成功时给中文成功提示', async () => {
    const result = await probeSshAlias('demo-alpha', { run: async () => {} })
    assert.equal(result.ok, true)
    assert.match(result.message, /成功/)
  })

  test('失败时给可操作的中文提示', async () => {
    const result = await probeSshAlias('demo-alpha', {
      run: async () => { throw Object.assign(new Error('x'), { stderr: 'Permission denied (publickey).' }) },
    })
    assert.equal(result.ok, false)
    assert.match(result.message, /公钥认证/)
    assert.doesNotMatch(result.message, /Permission denied/, '不应把裸英文抛给用户')
  })

  test('探测参数用 BatchMode，不会卡在密码提示', async () => {
    let seenArgs = null
    await probeSshAlias('demo-alpha', { run: async (args) => { seenArgs = args } })
    assert.ok(seenArgs.includes('BatchMode=yes'), '必须用 BatchMode 避免卡住等密码')
    assert.ok(seenArgs.includes('demo-alpha'))
    assert.equal(seenArgs[seenArgs.length - 1], 'true', '远端只跑空操作 true')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. 错误文案
// ─────────────────────────────────────────────────────────────────────────────

describe('explainSshFailure —— 把英文报错翻成可操作中文', () => {
  const cases = [
    ['Permission denied (publickey).', /公钥认证/, /authorized_keys/],
    ['Host key verification failed.', /主机指纹/, /ssh demo-box/],
    ['Could not resolve hostname foo', /主机名解析不了/, /HostName/],
    ['Connection timed out', /网络不通/, /VPN|跳板机/],
    ['ssh: not found', /找不到 ssh 命令/, /OpenSSH/],
  ]

  for (const [raw, expected, actionable] of cases) {
    test(`${raw} → 中文提示`, () => {
      const message = explainSshFailure('demo-box', raw)
      assert.match(message, expected)
      assert.match(message, actionable, '提示里要给出下一步怎么做')
    })
  }

  test('未知错误兜底也不抛裸栈', () => {
    const message = explainSshFailure('demo-box', 'some weird failure\nsecond line')
    assert.match(message, /连不上「demo-box」/)
    assert.match(message, /second line/, '取最后一行有用信息')
  })

  test('空输入也能给出可读提示', () => {
    const message = explainSshFailure('demo-box', '')
    assert.equal(typeof message, 'string')
    assert.ok(message.length > 0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. 别名校验
// ─────────────────────────────────────────────────────────────────────────────

describe('validateAlias', () => {
  test('合法别名通过', () => {
    for (const good of ['demo-alpha', '192.0.2.10', 'demo_box', 'Demo.Box']) {
      assert.equal(validateAlias(good).ok, true, `${good} 应该合法`)
    }
  })

  test('非法别名被拒绝并给中文原因', () => {
    const bad = {
      '': /不能为空/,
      'has space': /空格/,
      'wild*card': /通配/,
      'exclaim!': /通配/,
      '-startsWithDash': /不能以 - 开头/,
    }
    for (const [value, pattern] of Object.entries(bad)) {
      const result = validateAlias(value)
      assert.equal(result.ok, false, `${value} 应被拒绝`)
      assert.match(result.reason, pattern)
    }
  })

  test('超长别名被拒绝', () => {
    assert.equal(validateAlias('a'.repeat(256)).ok, false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. 受管块写入 —— 本模块最重要的部分
// ─────────────────────────────────────────────────────────────────────────────

describe('upsertManagedHostBlock —— 写自己标记的块', () => {
  test('空文件里追加新块', () => {
    const result = upsertManagedHostBlock('', {
      alias: 'demo-new', hostName: '192.0.2.20', user: 'alice', port: 2222,
    })
    assert.equal(result.status, 'appended')
    assert.ok(result.text.includes(MANAGED_MARK))
    assert.ok(result.text.includes('Host demo-new'))
    assert.ok(result.text.includes('HostName 192.0.2.20'))
    assert.ok(result.text.includes('User alice'))
    assert.ok(result.text.includes('Port 2222'))
  })

  test('不写默认值噪音：Port 22 与和别名相同的 HostName 被省略', () => {
    const result = upsertManagedHostBlock('', { alias: 'demo-x', hostName: 'demo-x', port: 22 })
    assert.equal(result.status, 'appended')
    assert.ok(!result.text.includes('HostName'), 'HostName 与别名相同时应省略')
    assert.ok(!result.text.includes('Port'), 'Port 22 是默认值，应省略')
  })

  test('更新已存在的受管块', () => {
    const first = upsertManagedHostBlock('', { alias: 'demo-x', hostName: '192.0.2.20', user: 'alice' })
    const second = upsertManagedHostBlock(first.text, { alias: 'demo-x', hostName: '192.0.2.99', user: 'alice' })
    assert.equal(second.status, 'updated')
    assert.ok(second.text.includes('192.0.2.99'))
    assert.ok(!second.text.includes('192.0.2.20'))
    // 只有一个块，不能重复追加
    assert.equal(second.text.split(MANAGED_MARK).length - 1, 1)
  })

  test('内容没变时不改写（避免无谓的 mtime 变化）', () => {
    const first = upsertManagedHostBlock('', { alias: 'demo-x', hostName: '192.0.2.20', user: 'alice' })
    const second = upsertManagedHostBlock(first.text, { alias: 'demo-x', hostName: '192.0.2.20', user: 'alice' })
    assert.equal(second.status, 'unchanged')
    assert.equal(second.text, first.text)
  })

  test('⭐ 用户手写的同名块 → conflict，原文一字不改', () => {
    const userConfig = 'Host demo-x\n  HostName 192.0.2.30\n  User mine\n  ForwardAgent yes\n'
    const result = upsertManagedHostBlock(userConfig, { alias: 'demo-x', hostName: '192.0.2.99' })
    assert.equal(result.status, 'conflict')
    assert.equal(result.text, userConfig, '用户手写的配置必须原样保留')
    assert.match(result.reason, /手写/)
  })

  test('⭐⭐ 别的插件的受管块（dsh-remote）也不能被我们覆盖', () => {
    // 这是真实存在的共存风险：dsh-remote 用的标记是 `# dsh-remote: managed`，
    // 与我们的 `# dsh-repo-session-sync: managed` 不同。它的冲突判定只认自己的
    // 标记，所以我们写的块在它眼里是"用户手写的"；同理它的块在我们眼里也是。
    //
    // 结论：两个插件都会拒绝更新对方管理的机器 —— 这是**刻意的**安全行为，
    // 而不是 bug。抢所有权会让双方互相锁死，所以谁都不许动别人的块。
    const remoteManaged = [
      '# dsh-remote: managed',
      'Host demo-x',
      '  HostName 192.0.2.30',
      '  User theirs',
      '  IdentityFile ~/.ssh/id_remote',
      '',
    ].join('\n')

    const result = upsertManagedHostBlock(remoteManaged, {
      alias: 'demo-x', hostName: '192.0.2.99', user: 'mine',
    })

    assert.equal(result.status, 'conflict', '别的插件的受管块必须被当作不可动')
    assert.equal(result.text, remoteManaged, '必须原文一字不改，连空行都不能动')
    assert.match(result.reason, /手写/, '文案要解释"这看起来是别人管的配置"')
  })

  test('⭐⭐ 我们已有的块不会被误认成别人的，可以正常更新', () => {
    // 对照组：同一个别名，但标记是我们自己的 → 应该正常 updated。
    // 这条和上一条一起，证明区分确实只依赖标记，而不是"有标记就拒绝"。
    const ours = upsertManagedHostBlock('', { alias: 'demo-x', hostName: '192.0.2.30' }).text
    assert.ok(ours.includes(MANAGED_MARK))

    const updated = upsertManagedHostBlock(ours, { alias: 'demo-x', hostName: '192.0.2.99' })
    assert.equal(updated.status, 'updated')
    assert.ok(updated.text.includes('192.0.2.99'))
  })

  test('⭐ 别的插件的块不会被我们的 remove 删掉', () => {
    const remoteManaged = '# dsh-remote: managed\nHost demo-x\n  HostName 192.0.2.30\n'
    const result = removeManagedHostBlock(remoteManaged, 'demo-x')
    assert.equal(result.status, 'absent', '不是我们的块，不能删')
    assert.equal(result.text, remoteManaged)
  })

  test('⭐ 块内用户自己加的行在更新后保留', () => {
    // 从空文件开始 —— 只有这样才会生成**带我们标记**的受管块。
    // （从用户手写的块出发会正确地得到 conflict，见上一个用例。）
    const withMark = upsertManagedHostBlock('', {
      alias: 'demo-x', hostName: '192.0.2.20', user: 'alice',
    }).text
    // 用户在我们拥有标记的块里手加一行
    const userEdited = withMark.replace('  HostName 192.0.2.20', '  HostName 192.0.2.20\n  ForwardAgent yes')
    const updated = upsertManagedHostBlock(userEdited, { alias: 'demo-x', hostName: '192.0.2.21', user: 'alice' })
    assert.equal(updated.status, 'updated')
    assert.ok(updated.text.includes('ForwardAgent yes'), '用户加的行不该被吃掉')
    assert.ok(updated.text.includes('192.0.2.21'), '我们拥有的参数应该被更新')
    assert.ok(!updated.text.includes('192.0.2.20'), '旧值应该被替换掉')
  })

  test('不影响文件里其他块', () => {
    const result = upsertManagedHostBlock(SAMPLE_CONFIG, { alias: 'demo-new', hostName: '192.0.2.20' })
    for (const keep of ['demo-alpha', 'demo-beta', 'demo-gamma', 'Host *']) {
      assert.ok(result.text.includes(keep), `${keep} 不该被破坏`)
    }
  })

  test('非法别名返回 invalid 且不改原文', () => {
    const result = upsertManagedHostBlock('Host demo-a\n  User x\n', { alias: 'bad alias' })
    assert.equal(result.status, 'invalid')
    assert.equal(result.text, 'Host demo-a\n  User x\n')
  })

  test('生成的配置能被自己的解析器读回来（往返一致）', () => {
    const result = upsertManagedHostBlock('', {
      alias: 'demo-rt', hostName: '192.0.2.40', user: 'roundtrip', port: 2200,
    })
    const blocks = parseHostBlocks(result.text)
    const rt = blocks.find((b) => b.patterns.includes('demo-rt'))
    assert.ok(rt)
    assert.equal(rt.values.hostname, '192.0.2.40')
    assert.equal(rt.values.user, 'roundtrip')
    assert.equal(rt.values.port, 2200)
  })
})

describe('removeManagedHostBlock —— 只删自己的块', () => {
  test('删除自己的受管块', () => {
    const withBlock = upsertManagedHostBlock('', { alias: 'demo-x', hostName: '192.0.2.20' }).text
    const result = removeManagedHostBlock(withBlock, 'demo-x')
    assert.equal(result.status, 'removed')
    assert.ok(!result.text.includes('demo-x'))
  })

  test('⭐ 用户手写的块永远不会被删', () => {
    const userConfig = 'Host demo-x\n  HostName 192.0.2.30\n'
    const result = removeManagedHostBlock(userConfig, 'demo-x')
    assert.equal(result.status, 'absent')
    assert.equal(result.text, userConfig, '用户手写的 ssh 配置是他们的资产，不是我们的状态')
  })

  test('删除只影响目标块', () => {
    const a = upsertManagedHostBlock('', { alias: 'demo-a', hostName: '192.0.2.1' }).text
    const ab = upsertManagedHostBlock(a, { alias: 'demo-b', hostName: '192.0.2.2' }).text
    const result = removeManagedHostBlock(ab, 'demo-a')
    assert.equal(result.status, 'removed')
    assert.ok(!result.text.includes('Host demo-a'))
    assert.ok(result.text.includes('Host demo-b'), '别的受管块不该被连带删掉')
  })

  test('不存在的块返回 absent', () => {
    assert.equal(removeManagedHostBlock('Host demo-a\n  User x\n', 'nope').status, 'absent')
  })

  test('空别名返回 absent 且不改动', () => {
    const text = 'Host demo-a\n'
    assert.equal(removeManagedHostBlock(text, '').status, 'absent')
    assert.equal(removeManagedHostBlock(text, '').text, text)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. 文件写入
// ─────────────────────────────────────────────────────────────────────────────

describe('writeSshConfig / readRawSshConfig', () => {
  test('写入后能读回，且目录与文件权限是 OpenSSH 期望的 0700/0600', (t) => {
    const dir = withTmpDir(t)
    const file = path.join(dir, 'sshconf', 'config')
    writeSshConfig('Host demo-a\n  User x\n', file)

    assert.equal(readRawSshConfig(file), 'Host demo-a\n  User x\n')
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600, '配置文件必须 0600')
      assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700, '目录必须 0700')
    }
  })

  test('读不存在的文件返回空串而不抛异常', () => {
    assert.equal(readRawSshConfig('/nonexistent/definitely/not/here'), '')
  })

  test('readRawSshConfig 刻意不展开 Include', (t) => {
    const dir = withTmpDir(t)
    const sub = path.join(dir, 'sub.conf')
    writeFileSync(sub, 'Host demo-inside\n  User x\n')
    const main = path.join(dir, 'config')
    writeFileSync(main, 'Include sub.conf\n')

    const raw = readRawSshConfig(main)
    assert.ok(!raw.includes('demo-inside'), '写盘目标是单个文件，不能展开 Include')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. 注册表
// ─────────────────────────────────────────────────────────────────────────────

describe('机器注册表', () => {
  test('normalizeMachineRecord 补默认 label', () => {
    const result = normalizeMachineRecord({ alias: 'demo-a' })
    assert.equal(result.ok, true)
    assert.equal(result.record.label, 'demo-a')
    assert.ok(result.record.id)
  })

  test('normalizeMachineRecord 拒绝非法别名', () => {
    assert.equal(normalizeMachineRecord({ alias: 'bad alias' }).ok, false)
    assert.equal(normalizeMachineRecord({}).ok, false)
  })

  test('⭐ 记录里只有 id/alias/label 三个字段（不存凭据与连接信息）', () => {
    const record = normalizeMachineRecord({
      alias: 'demo-a',
      // 即使传进来，也不该被保留
      hostName: '192.0.2.10', user: 'alice', password: 'secret', privateKeyPath: '/x/id_rsa',
    }).record
    assert.deepEqual(Object.keys(record).sort(), ['alias', 'id', 'label'])
    assert.ok(!JSON.stringify(record).includes('secret'), '凭据绝不能进注册表')
    assert.ok(!JSON.stringify(record).includes('id_rsa'))
  })

  test('createMachineId 生成不同的 id', () => {
    const ids = new Set()
    for (let i = 0; i < 50; i += 1) ids.add(createMachineId())
    assert.equal(ids.size, 50, 'id 应该唯一')
  })

  test('序列化与解析往返一致', () => {
    const machines = [{ id: 'm_1', alias: 'demo-a', label: 'A' }]
    const parsed = parseMachineRegistry(serializeMachineRegistry(machines))
    assert.deepEqual(parsed.machines, machines)
    assert.equal(parsed.dropped, 0)
  })

  test('坏 JSON 返回空列表而不抛异常', () => {
    assert.deepEqual(parseMachineRegistry('{not json').machines, [])
    assert.deepEqual(parseMachineRegistry('').machines, [])
    assert.deepEqual(parseMachineRegistry('null').machines, [])
  })

  test('坏记录被丢弃并计数', () => {
    const text = JSON.stringify({
      version: 1,
      machines: [
        { id: 'm_1', alias: 'demo-good', label: 'OK' },
        { id: 'm_2', alias: 'bad alias' },   // 非法
        { alias: 'demo-good' },               // 别名重复
        { id: 'm_1', alias: 'demo-dup-id' },  // id 重复
      ],
    })
    const parsed = parseMachineRegistry(text)
    assert.equal(parsed.machines.length, 1)
    assert.equal(parsed.machines[0].alias, 'demo-good')
    assert.equal(parsed.dropped, 3)
  })

  test('addMachine 拒绝别名重复并给中文原因', () => {
    const first = addMachine([], { alias: 'demo-a' })
    assert.equal(first.ok, true)
    const second = addMachine(first.machines, { alias: 'demo-a' })
    assert.equal(second.ok, false)
    assert.match(second.reason, /已经在机器列表里/)
  })

  test('updateMachine 只改 label，不允许改 alias', () => {
    const machines = [{ id: 'm_1', alias: 'demo-a', label: 'demo-a' }]
    const ok = updateMachine(machines, 'm_1', { label: '我的台式机' })
    assert.equal(ok.ok, true)
    assert.equal(ok.machines[0].label, '我的台式机')
    assert.equal(ok.machines[0].alias, 'demo-a', '别名不能变')

    const rejected = updateMachine(machines, 'm_1', { alias: 'other' })
    assert.equal(rejected.ok, false)
    assert.match(rejected.reason, /不能直接改/)
  })

  test('removeMachine 删除并返回被删记录', () => {
    const machines = [
      { id: 'm_1', alias: 'demo-a', label: 'A' },
      { id: 'm_2', alias: 'demo-b', label: 'B' },
    ]
    const result = removeMachine(machines, 'm_1')
    assert.equal(result.ok, true)
    assert.equal(result.machines.length, 1)
    assert.equal(result.removed.alias, 'demo-a')
  })

  test('removeMachine 找不到时给中文原因', () => {
    const result = removeMachine([], 'nope')
    assert.equal(result.ok, false)
    assert.match(result.reason, /找不到这台机器/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10. 面向 UI 的高层动作
// ─────────────────────────────────────────────────────────────────────────────

describe('buildMachineOverview', () => {
  test('标出哪些别名已被使用', () => {
    const overview = buildMachineOverview({
      configText: SAMPLE_CONFIG,
      machines: [{ id: 'm_1', alias: 'demo-alpha', label: 'A' }],
    })
    assert.equal(overview.configFound, true)
    const alpha = overview.available.find((a) => a.alias === 'demo-alpha')
    assert.equal(alpha.inUse, true)
    const beta = overview.available.find((a) => a.alias === 'demo-beta')
    assert.equal(beta.inUse, false)
  })

  test('空配置时 configFound 为 false', () => {
    const overview = buildMachineOverview({ configText: '', machines: [] })
    assert.equal(overview.configFound, false)
    assert.deepEqual(overview.available, [])
  })
})

describe('createMachineInSshConfig —— 唯一会写文件的高层入口', () => {
  test('成功追加受管块并落盘', (t) => {
    const dir = withTmpDir(t)
    const file = path.join(dir, 'config')
    writeFileSync(file, 'Host demo-existing\n  User x\n')

    const result = createMachineInSshConfig({
      fields: { alias: 'demo-new', hostName: '192.0.2.50', user: 'alice' },
      filePath: file,
    })
    assert.equal(result.ok, true)
    assert.equal(result.status, 'appended')

    const onDisk = readFileSync(file, 'utf8')
    assert.ok(onDisk.includes('Host demo-existing'), '原有配置必须保留')
    assert.ok(onDisk.includes('Host demo-new'))
    assert.ok(onDisk.includes(MANAGED_MARK))
  })

  test('冲突时文件保持不变', (t) => {
    const dir = withTmpDir(t)
    const file = path.join(dir, 'config')
    const original = 'Host demo-taken\n  HostName 192.0.2.60\n  User theirs\n'
    writeFileSync(file, original)

    const result = createMachineInSshConfig({
      fields: { alias: 'demo-taken', hostName: '192.0.2.99' },
      filePath: file,
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 'conflict')
    assert.equal(readFileSync(file, 'utf8'), original, '冲突时绝不能改动用户的文件')
  })

  test('文件不存在时创建它', (t) => {
    const dir = withTmpDir(t)
    const file = path.join(dir, 'brand-new-config')
    const result = createMachineInSshConfig({
      fields: { alias: 'demo-first', hostName: '192.0.2.70' },
      filePath: file,
    })
    assert.equal(result.ok, true)
    assert.ok(existsSync(file))
  })

  test('非法别名不写文件', (t) => {
    const dir = withTmpDir(t)
    const file = path.join(dir, 'config')
    const result = createMachineInSshConfig({ fields: { alias: 'bad name' }, filePath: file })
    assert.equal(result.ok, false)
    assert.equal(existsSync(file), false, '非法输入不该创建文件')
  })

  test('写失败时给中文提示而不抛异常', () => {
    const result = createMachineInSshConfig({
      fields: { alias: 'demo-x', hostName: '192.0.2.10' },
      filePath: '/nonexistent/deep/path/config',
      io: { read: () => '', write: () => { throw new Error('EACCES') } },
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 'write-failed')
    assert.match(result.message, /写 ssh 配置文件失败/)
  })
})

describe('removeMachineFromSshConfig', () => {
  test('删除受管块', (t) => {
    const dir = withTmpDir(t)
    const file = path.join(dir, 'config')
    createMachineInSshConfig({ fields: { alias: 'demo-gone', hostName: '192.0.2.80' }, filePath: file })

    const result = removeMachineFromSshConfig({ alias: 'demo-gone', filePath: file })
    assert.equal(result.ok, true)
    assert.equal(result.status, 'removed')
    assert.ok(!readFileSync(file, 'utf8').includes('demo-gone'))
  })

  test('用户手写块不会被误删，并明确告知', (t) => {
    const dir = withTmpDir(t)
    const file = path.join(dir, 'config')
    const original = 'Host demo-mine\n  HostName 192.0.2.90\n'
    writeFileSync(file, original)

    const result = removeMachineFromSshConfig({ alias: 'demo-mine', filePath: file })
    assert.equal(result.ok, true)
    assert.equal(result.status, 'absent')
    assert.match(result.message, /手写的块我们不会动/)
    assert.equal(readFileSync(file, 'utf8'), original)
  })

  test('空别名被拒绝', () => {
    const result = removeMachineFromSshConfig({ alias: '' })
    assert.equal(result.ok, false)
    assert.match(result.message, /空的/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 11. 隐私护栏 —— 这些是硬约束，不是可选项
// ─────────────────────────────────────────────────────────────────────────────

describe('隐私与安全护栏', () => {
  test('整个模块没有硬编码的家目录路径', () => {
    const source = readFileSync(new URL('../src/machines.js', import.meta.url), 'utf8')
    assert.ok(!/\/Users\/[a-z0-9_.-]+\//i.test(source), '不得出现 /Users/<名字>/ 这类真实家目录路径')
    assert.ok(!/\/home\/[a-z0-9_.-]+\//i.test(source), '不得出现 /home/<名字>/ 这类真实家目录路径')
  })

  test('家目录只通过 os.homedir() 获取', () => {
    const source = readFileSync(new URL('../src/machines.js', import.meta.url), 'utf8')
    assert.ok(source.includes("from 'node:os'"), '应使用 node:os')
    assert.ok(source.includes('homedir()'), '应使用 homedir() 而不是硬编码')
  })

  test('测试文件本身不含真实家目录路径', () => {
    const source = readFileSync(new URL('./machines.test.js', import.meta.url), 'utf8')
    assert.ok(!/\/Users\/[a-z0-9_.-]+\//i.test(source))
  })

  test('测试全程使用临时目录，不写真实 ssh 配置', () => {
    const source = readFileSync(new URL('./machines.test.js', import.meta.url), 'utf8')
    // 所有写文件调用都必须落在 tmp 目录下的路径上
    assert.ok(source.includes('mkdtempSync'), '必须用 mkdtempSync 建临时目录')
    assert.ok(source.includes("tmpdir()"), '必须基于 os.tmpdir()')
    assert.ok(!/sshConfigPath\(\)\s*,/.test(source), '测试不应把默认路径当写目标')
  })
})
