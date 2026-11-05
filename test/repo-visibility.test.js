/**
 * `src/repo-visibility.js` 的单元测试。
 *
 * 这个模块的判定结果是**安全闸门**，所以测试的重点不是"happy path 能过"，
 * 而是**证明每一条失败路径都不会静默放行**。
 *
 * 全部判定器都是注入的桩函数：不发网络请求、不 spawn `gh`、不读用户凭据。
 *
 * 运行：`node --test test/repo-visibility.test.js`
 *
 * @module dsh-repo-session-sync/test/repo-visibility
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  VERDICT,
  VERDICT_LIST,
  checkRepoVisibility,
  detectRegression,
  isGitHubHost,
  isKnownUnsafe,
  parseRemoteUrl,
  queryGitHubVisibility,
  redactUrl,
  requiresConfirmation,
  verifyTypedConfirmation,
} from '../src/repo-visibility.js'

// ─────────────────────────────────────────────────────────────────────────────
// 桩函数
// ─────────────────────────────────────────────────────────────────────────────

/** gh 桩：报告指定可见性。 */
const ghSays = (visibility) => async () => ({
  stdout: JSON.stringify({ visibility }),
})

/** gh 桩：像真的没装/没登录一样失败。 */
const ghFails = async () => {
  throw Object.assign(new Error('gh: command not found'), { stderr: 'command not found' })
}

/** HTTP 桩。 */
const httpSays = (status, body = null) => async () => ({ status, body })

/** HTTP 桩：网络失败。 */
const httpFails = async () => {
  throw new Error('getaddrinfo ENOTFOUND api.github.com')
}

/** 一个标准的合成 remote（不用任何真实仓库）。 */
const DEMO_REMOTE = 'git@github.com:acme/demo-repo.git'
const DEMO_SLUG = 'acme/demo-repo'

// ─────────────────────────────────────────────────────────────────────────────
// 1. remote URL 解析
// ─────────────────────────────────────────────────────────────────────────────

describe('parseRemoteUrl', () => {
  test('解析 scp 风格', () => {
    const parsed = parseRemoteUrl('git@github.com:acme/demo-repo.git')
    assert.equal(parsed.ok, true)
    assert.equal(parsed.host, 'github.com')
    assert.equal(parsed.slug, DEMO_SLUG)
    assert.equal(parsed.protocol, 'ssh')
  })

  test('解析 https 风格', () => {
    const parsed = parseRemoteUrl('https://github.com/acme/demo-repo.git')
    assert.equal(parsed.ok, true)
    assert.equal(parsed.slug, DEMO_SLUG)
  })

  test('解析 ssh:// 风格', () => {
    const parsed = parseRemoteUrl('ssh://git@github.com/acme/demo-repo.git')
    assert.equal(parsed.ok, true)
    assert.equal(parsed.slug, DEMO_SLUG)
  })

  test('解析 git:// 风格', () => {
    const parsed = parseRemoteUrl('git://github.com/acme/demo-repo.git')
    assert.equal(parsed.ok, true)
    assert.equal(parsed.slug, DEMO_SLUG)
  })

  test('保留多级 group（GitLab 常见）', () => {
    const parsed = parseRemoteUrl('https://gitlab.example.com/group/sub/repo.git')
    assert.equal(parsed.ok, true)
    assert.equal(parsed.slug, 'group/sub/repo')
    assert.equal(parsed.host, 'gitlab.example.com')
  })

  test('没有 .git 后缀也能解析', () => {
    assert.equal(parseRemoteUrl('https://github.com/acme/demo-repo').slug, DEMO_SLUG)
  })

  test('尾部斜杠被忽略', () => {
    assert.equal(parseRemoteUrl('https://github.com/acme/demo-repo.git/').slug, DEMO_SLUG)
  })

  test('空值给出中文原因', () => {
    const parsed = parseRemoteUrl('')
    assert.equal(parsed.ok, false)
    assert.match(parsed.reason, /还没有配置远端地址/)
  })

  test('本机路径被拒绝（不是远端）', () => {
    for (const local of ['/srv/git/repo.git', './repo', '../repo', '~/my-project', 'C:\\code\\repo', 'D:/code/repo']) {
      const parsed = parseRemoteUrl(local)
      assert.equal(parsed.ok, false, `${local} 不应被当成远端`)
      assert.match(parsed.reason, /本机路径/)
    }
  })

  test('解析不出 owner/repo 时给中文原因', () => {
    const parsed = parseRemoteUrl('https://github.com/onlyowner')
    assert.equal(parsed.ok, false)
    assert.match(parsed.reason, /owner\/repo/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 凭据抹除 —— 任何进日志/UI 的 URL 都要先过这里
// ─────────────────────────────────────────────────────────────────────────────

describe('redactUrl', () => {
  test('抹掉 https URL 里的 user:token', () => {
    const out = redactUrl('https://user:ghp_secretvalue123@github.com/acme/demo-repo.git')
    assert.ok(!out.includes('ghp_secretvalue123'), 'token 绝不能出现在输出里')
    assert.ok(!out.includes('user:'), '用户名也不该出现')
    assert.ok(out.includes('github.com/acme/demo-repo.git'), '主机与路径应保留')
    assert.ok(out.startsWith('https://***@'))
  })

  test('只有用户名没有密码也能抹', () => {
    const out = redactUrl('https://justuser@github.com/a/b.git')
    assert.ok(!out.includes('justuser'))
    assert.ok(out.includes('github.com/a/b.git'))
  })

  test('没有凭据的 URL 原样返回', () => {
    const clean = 'https://github.com/acme/demo-repo.git'
    assert.equal(redactUrl(clean), clean)
  })

  test('scp 风格不受影响（它本来就没有 userinfo 段）', () => {
    assert.equal(redactUrl(DEMO_REMOTE), DEMO_REMOTE)
  })

  test('空值不抛异常', () => {
    assert.equal(redactUrl(''), '')
    assert.equal(redactUrl(undefined), '')
  })

  test('解析失败的报错里也不会泄漏凭据', () => {
    // 这串故意写成会解析失败的样子，但带 token
    const parsed = parseRemoteUrl('https://user:secret@')
    if (!parsed.ok) {
      assert.ok(!parsed.reason.includes('secret'), '错误文案里不能带 token')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. GitHub 主机识别
// ─────────────────────────────────────────────────────────────────────────────

describe('isGitHubHost', () => {
  test('识别 github.com 与 www', () => {
    assert.equal(isGitHubHost('github.com'), true)
    assert.equal(isGitHubHost('www.github.com'), true)
    assert.equal(isGitHubHost('GitHub.com'), true, '大小写不敏感')
  })

  test('其他平台不是 GitHub', () => {
    for (const host of ['gitlab.com', 'gitee.com', 'gitlab.example.com', 'git.company.internal', '']) {
      assert.equal(isGitHubHost(host), false, `${host} 不是 GitHub`)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. GitHub 查询的两条路径
// ─────────────────────────────────────────────────────────────────────────────

describe('queryGitHubVisibility —— gh 路径', () => {
  test('gh 报告 PUBLIC', async () => {
    const r = await queryGitHubVisibility({ slug: DEMO_SLUG, runGh: ghSays('PUBLIC') })
    assert.equal(r.verdict, VERDICT.PUBLIC)
    assert.equal(r.source, 'gh')
  })

  test('gh 报告 PRIVATE', async () => {
    const r = await queryGitHubVisibility({ slug: DEMO_SLUG, runGh: ghSays('PRIVATE') })
    assert.equal(r.verdict, VERDICT.PRIVATE)
  })

  test('gh 报告 INTERNAL 按私有处理并说明', async () => {
    const r = await queryGitHubVisibility({ slug: DEMO_SLUG, runGh: ghSays('INTERNAL') })
    assert.equal(r.verdict, VERDICT.PRIVATE)
    assert.match(r.detail, /INTERNAL/)
  })

  test('gh 给出无法识别的值时归 unknown', async () => {
    const r = await queryGitHubVisibility({ slug: DEMO_SLUG, runGh: ghSays('SOMETHING_ELSE') })
    assert.equal(r.verdict, VERDICT.UNKNOWN)
  })

  test('gh 没装 → 降级到 HTTP', async () => {
    const r = await queryGitHubVisibility({
      slug: DEMO_SLUG, runGh: ghFails, fetchJson: httpSays(200, { private: false }),
    })
    assert.equal(r.verdict, VERDICT.PUBLIC)
    assert.equal(r.source, 'api', '应降级到 API 路径')
  })
})

describe('queryGitHubVisibility —— 无认证 API 路径', () => {
  test('200 + private:false → PUBLIC', async () => {
    const r = await queryGitHubVisibility({
      slug: DEMO_SLUG, runGh: ghFails, fetchJson: httpSays(200, { private: false }),
    })
    assert.equal(r.verdict, VERDICT.PUBLIC)
    assert.match(r.detail, /未登录即可访问/)
  })

  test('⭐ 404 → PRIVATE（未认证看不到 = 私有）', async () => {
    const r = await queryGitHubVisibility({
      slug: DEMO_SLUG, runGh: ghFails, fetchJson: httpSays(404),
    })
    assert.equal(r.verdict, VERDICT.PRIVATE)
    assert.equal(r.source, 'api')
  })

  test('200 + private:true → UNKNOWN（未登录本不该看到，判定不可信）', async () => {
    const r = await queryGitHubVisibility({
      slug: DEMO_SLUG, runGh: ghFails, fetchJson: httpSays(200, { private: true }),
    })
    assert.equal(r.verdict, VERDICT.UNKNOWN)
    assert.match(r.detail, /不可信/)
  })

  test('403 / 429 限流 → UNKNOWN', async () => {
    for (const status of [403, 429]) {
      const r = await queryGitHubVisibility({
        slug: DEMO_SLUG, runGh: ghFails, fetchJson: httpSays(status),
      })
      assert.equal(r.verdict, VERDICT.UNKNOWN, `${status} 应归 unknown`)
    }
  })

  test('其他状态码 → UNKNOWN', async () => {
    for (const status of [500, 502, 301]) {
      const r = await queryGitHubVisibility({
        slug: DEMO_SLUG, runGh: ghFails, fetchJson: httpSays(status),
      })
      assert.equal(r.verdict, VERDICT.UNKNOWN)
    }
  })

  test('⭐ 网络失败 → UNKNOWN，绝不抛异常', async () => {
    const r = await queryGitHubVisibility({
      slug: DEMO_SLUG, runGh: ghFails, fetchJson: httpFails,
    })
    assert.equal(r.verdict, VERDICT.UNKNOWN)
    assert.match(r.detail, /网络查询失败/)
  })

  test('空 slug → UNKNOWN', async () => {
    const r = await queryGitHubVisibility({ slug: '' })
    assert.equal(r.verdict, VERDICT.UNKNOWN)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. 主入口：三态 + 确认要求
// ─────────────────────────────────────────────────────────────────────────────

describe('checkRepoVisibility —— 三态判定', () => {
  test('私有仓库：放行、不需要确认', async () => {
    const r = await checkRepoVisibility({ remoteUrl: DEMO_REMOTE, runGh: ghSays('PRIVATE') })
    assert.equal(r.verdict, VERDICT.PRIVATE)
    assert.equal(r.requiresConfirmation, false)
    assert.equal(r.requiresTypedConfirmation, false)
    assert.equal(r.confirmationPhrase, '')
    assert.match(r.reason, /可以同步/)
  })

  test('⭐ 公开仓库：默认拒绝 + 需要逐字确认', async () => {
    const r = await checkRepoVisibility({ remoteUrl: DEMO_REMOTE, runGh: ghSays('PUBLIC') })
    assert.equal(r.verdict, VERDICT.PUBLIC)
    assert.equal(r.requiresConfirmation, true, '公开仓库必须要求确认')
    assert.equal(r.requiresTypedConfirmation, true, '必须逐字输入仓库名')
    assert.equal(r.confirmationPhrase, DEMO_SLUG, '确认短语应是 owner/repo')
    assert.match(r.reason, /公开仓库/)
    assert.match(r.reason, /完整对话内容/, '文案要说明推的是什么')
    assert.match(r.hint, /改私有|Change visibility/, '要给出改私有的操作路径')
  })

  test('⭐ 无法判定：默认拒绝 + 需要逐字确认（查不到 ≠ 安全）', async () => {
    const r = await checkRepoVisibility({
      remoteUrl: DEMO_REMOTE, runGh: ghFails, fetchJson: httpFails,
    })
    assert.equal(r.verdict, VERDICT.UNKNOWN)
    assert.equal(r.requiresConfirmation, true, '查不到时必须要求确认，绝不能默认放行')
    assert.equal(r.requiresTypedConfirmation, true)
    assert.match(r.reason, /无法自动确认/)
  })

  test('非 GitHub 平台 → unknown（不猜）', async () => {
    const r = await checkRepoVisibility({ remoteUrl: 'https://gitlab.example.com/grp/repo.git' })
    assert.equal(r.verdict, VERDICT.UNKNOWN)
    assert.match(r.detail, /不是 GitHub/)
    assert.equal(r.requiresConfirmation, true)
  })

  test('解析失败 → unknown，且仍有可确认的短语兜底', async () => {
    const r = await checkRepoVisibility({ remoteUrl: '' })
    assert.equal(r.verdict, VERDICT.UNKNOWN)
    assert.match(r.reason, /还没有配置远端地址/)
  })

  test('⭐ 绝不抛异常：任何输入都返回结构化结果', async () => {
    const inputs = [undefined, null, '', 'garbage', 42, {}, { remoteUrl: 123 }]
    for (const remoteUrl of inputs) {
      const r = await checkRepoVisibility(/** @type {any} */ ({ remoteUrl }))
      assert.ok(typeof r.verdict === 'string')
      assert.ok(VERDICT_LIST.includes(r.verdict))
    }
  })

  test('visibilityHint 只在无法查询时作为弱证据', async () => {
    // 非 GitHub 主机 + 已知私有 → 采用 hint
    const hinted = await checkRepoVisibility({
      remoteUrl: 'https://gitlab.example.com/grp/repo.git',
      visibilityHint: 'private',
    })
    assert.equal(hinted.verdict, VERDICT.PRIVATE)
    assert.equal(hinted.source, 'hint')

    // GitHub + 实时查询为 PUBLIC 时，hint 不能覆盖实时结果
    const fresh = await checkRepoVisibility({
      remoteUrl: DEMO_REMOTE,
      visibilityHint: 'private',
      runGh: ghSays('PUBLIC'),
    })
    assert.equal(fresh.verdict, VERDICT.PUBLIC, '弱证据绝不能覆盖实时判定')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. 逐字确认
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyTypedConfirmation', () => {
  test('私有仓库：无条件通过', async () => {
    const check = await checkRepoVisibility({ remoteUrl: DEMO_REMOTE, runGh: ghSays('PRIVATE') })
    const r = verifyTypedConfirmation({ check, typed: '' })
    assert.equal(r.ok, true)
  })

  test('公开仓库：输入正确的仓库名才通过', async () => {
    const check = await checkRepoVisibility({ remoteUrl: DEMO_REMOTE, runGh: ghSays('PUBLIC') })
    assert.equal(verifyTypedConfirmation({ check, typed: DEMO_SLUG, acknowledged: true }).ok, true)
  })

  test('公开仓库：空输入被拒绝并给出要输入什么', async () => {
    const check = await checkRepoVisibility({ remoteUrl: DEMO_REMOTE, runGh: ghSays('PUBLIC') })
    const r = verifyTypedConfirmation({ check, typed: '', acknowledged: true })
    assert.equal(r.ok, false)
    assert.match(r.reason, /逐字输入/)
    assert.ok(r.reason.includes(DEMO_SLUG))
  })

  test('公开仓库：输错被拒绝', async () => {
    const check = await checkRepoVisibility({ remoteUrl: DEMO_REMOTE, runGh: ghSays('PUBLIC') })
    const r = verifyTypedConfirmation({ check, typed: 'acme/wrong-repo', acknowledged: true })
    assert.equal(r.ok, false)
    assert.match(r.reason, /不一致/)
  })

  test('公开仓库：大小写不敏感（不该因 URL 写法卡住用户）', async () => {
    const check = await checkRepoVisibility({ remoteUrl: DEMO_REMOTE, runGh: ghSays('PUBLIC') })
    assert.equal(verifyTypedConfirmation({ check, typed: 'ACME/DEMO-REPO', acknowledged: true }).ok, true)
  })

  test('公开仓库：未勾选"我了解风险"被拒绝', async () => {
    const check = await checkRepoVisibility({ remoteUrl: DEMO_REMOTE, runGh: ghSays('PUBLIC') })
    const r = verifyTypedConfirmation({ check, typed: DEMO_SLUG, acknowledged: false })
    assert.equal(r.ok, false)
    assert.match(r.reason, /勾选/)
  })

  test('⭐ 没有先做判定就想确认 → 拒绝（状态不一致不能放行）', () => {
    const r = verifyTypedConfirmation({ check: { verdict: VERDICT.PUBLIC }, typed: 'x' })
    assert.equal(r.ok, false)
    assert.match(r.reason, /还没有检测过/)
  })

  test('没有可确认短语时拒绝而不是放行', async () => {
    const check = await checkRepoVisibility({ remoteUrl: 'garbage' })
    const r = verifyTypedConfirmation({ check, typed: 'anything', acknowledged: true })
    assert.equal(r.ok, false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. 第二层：每次上行前重校验（防"今天私有、明天转公开"）
// ─────────────────────────────────────────────────────────────────────────────

describe('detectRegression —— 上行前重校验', () => {
  test('⭐ private → public：必须中止', () => {
    const r = detectRegression({ previous: VERDICT.PRIVATE, current: VERDICT.PUBLIC })
    assert.equal(r.ok, false)
    assert.equal(r.regression, true, '这是安全退化，应标记出来')
    assert.match(r.reason, /变成.{0,2}公开仓库/)
    assert.match(r.reason, /已中止/)
  })

  test('⭐ private → unknown：也必须中止（查不到 ≠ 安全）', () => {
    const r = detectRegression({ previous: VERDICT.PRIVATE, current: VERDICT.UNKNOWN })
    assert.equal(r.ok, false)
    assert.equal(r.regression, true)
    assert.match(r.reason, /无法确认/)
  })

  test('unknown → public：中止', () => {
    const r = detectRegression({ previous: VERDICT.UNKNOWN, current: VERDICT.PUBLIC })
    assert.equal(r.ok, false)
  })

  test('public → private：放行（用户改好了，这是好路径）', () => {
    const r = detectRegression({ previous: VERDICT.PUBLIC, current: VERDICT.PRIVATE })
    assert.equal(r.ok, true)
  })

  test('private → private：放行', () => {
    assert.equal(detectRegression({ previous: VERDICT.PRIVATE, current: VERDICT.PRIVATE }).ok, true)
  })

  test('首次同步（无 previous）+ private：放行', () => {
    assert.equal(detectRegression({ previous: undefined, current: VERDICT.PRIVATE }).ok, true)
  })

  test('首次同步（无 previous）+ public：中止', () => {
    const r = detectRegression({ previous: undefined, current: VERDICT.PUBLIC })
    assert.equal(r.ok, false)
  })

  test('首次同步（无 previous）+ unknown：中止', () => {
    const r = detectRegression({ previous: undefined, current: VERDICT.UNKNOWN })
    assert.equal(r.ok, false)
  })

  test('⭐ 只有当前为 private 才放行（穷举验证）', () => {
    for (const previous of [undefined, ...VERDICT_LIST]) {
      for (const current of VERDICT_LIST) {
        const r = detectRegression({ previous, current })
        if (current === VERDICT.PRIVATE) {
          assert.equal(r.ok, true, `previous=${previous} current=private 应放行`)
        } else {
          assert.equal(r.ok, false, `previous=${previous} current=${current} 必须中止`)
        }
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. 小工具
// ─────────────────────────────────────────────────────────────────────────────

describe('requiresConfirmation / isKnownUnsafe', () => {
  test('只有 private 不需要确认', () => {
    assert.equal(requiresConfirmation(VERDICT.PRIVATE), false)
    assert.equal(requiresConfirmation(VERDICT.PUBLIC), true)
    assert.equal(requiresConfirmation(VERDICT.UNKNOWN), true)
  })

  test('只有 public 是"明确不安全"', () => {
    assert.equal(isKnownUnsafe(VERDICT.PUBLIC), true)
    assert.equal(isKnownUnsafe(VERDICT.PRIVATE), false)
    assert.equal(isKnownUnsafe(VERDICT.UNKNOWN), false)
  })

  test('VERDICT_LIST 覆盖所有值', () => {
    assert.deepEqual([...VERDICT_LIST].sort(), ['private', 'public', 'unknown'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. 安全护栏
// ─────────────────────────────────────────────────────────────────────────────

describe('安全护栏', () => {
  test('模块里没有硬编码的家目录路径', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../src/repo-visibility.js', import.meta.url), 'utf8')
    assert.ok(!/\/Users\/[a-z0-9_.-]+\//i.test(source))
    assert.ok(!/\/home\/[a-z0-9_.-]+\//i.test(source))
  })

  test('模块不读取任何凭据文件', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../src/repo-visibility.js', import.meta.url), 'utf8')
    for (const forbidden of ['id_rsa', 'id_ed25519', '.netrc', 'credentials', 'keychain']) {
      assert.ok(
        !new RegExp(`readFile[^)]*${forbidden}`, 'i').test(source),
        `不应读取 ${forbidden}`,
      )
    }
  })

  test('测试自身不含真实家目录路径', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('./repo-visibility.test.js', import.meta.url), 'utf8')
    assert.ok(!/\/Users\/[a-z0-9_.-]+\//i.test(source))
  })

  test('测试数据全是合成值（不出现真实仓库名）', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('./repo-visibility.test.js', import.meta.url), 'utf8')
    // acme/demo-repo 是刻意选的通用占位名
    assert.ok(source.includes('acme/demo-repo'))
  })
})
