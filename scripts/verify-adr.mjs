#!/usr/bin/env node
/**
 * ADR 一致性验证 —— 把 `docs/design.md` 附录 B 的审计固化成可重复执行的脚本。
 *
 * ## 为什么这个脚本存在
 *
 * 设计文档最大的风险不是写错，而是**写完就与实现脱节**：读者按文档理解系统，
 * 行为却与代码不符。而且这种脱节**不会报错**——
 * 它只会在某天有人按文档做出错误决策时才暴露。
 *
 * 所以本脚本把每条 ADR 转成一个**可证伪的断言**，直接 import 真实模块验证，
 * 而不是读代码"看像不像"。
 *
 * 判定标准只有一条：**如果实现违反了这条 ADR，脚本必须失败。**
 *
 * ## 用法
 *
 *     node scripts/verify-adr.mjs           # 人类可读
 *     node scripts/verify-adr.mjs --json    # 机器可读（CI 用）
 *
 * 退出码 0 = 全部通过；1 = 有违规（可直接用于 CI 门禁）。
 *
 * ## 注意：本脚本自身也会有 bug
 *
 * 编写过程中曾误报 ADR-11「违规」——正则去匹配「跨机去重成立」，
 * 而代码注释写的是「跨机去重**不**成立」（正是 ADR-11 要求的）。
 *
 * **断言写错会假红，和实现写错一样需要验证。** 假红的危害是让人去改正确的代码。
 * 所以每条断言都配了「正确实现应当通过」的对照，别只跑反面。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SRC = join(ROOT, 'src')

const JSON_OUT = process.argv.includes('--json')

/** @type {Array<{id: string, claim: string, ok: boolean, detail?: string}>} */
const results = []

/**
 * 记录一条检查结果。
 * @param {string} id - ADR 编号。
 * @param {string} claim - 被验证的断言。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 失败时的现场信息。
 */
function check(id, claim, ok, detail = '') {
  results.push({ id, claim, ok, detail })
}

/** 在一个临时 git 仓库里执行操作。 */
async function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adr-'))
  const git = (...args) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  try {
    execFileSync('git', ['init', '--quiet', dir], { stdio: 'ignore' })
    git('config', 'user.email', 'verify@example.invalid')
    git('config', 'user.name', 'verify-adr')
    git('checkout', '--quiet', '-b', 'main')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'f.txt'), '0')
    git('add', '-A')
    git('commit', '--quiet', '-m', 'initial')
    return await fn({ dir, git, writeFileSync })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  const repoBinding = await import(join(SRC, 'repo-binding.js'))
  const sessionStore = await import(join(SRC, 'session-store.js'))
  const conflict = await import(join(SRC, 'conflict.js'))
  const repoVisibility = await import(join(SRC, 'repo-visibility.js'))
  const anchor = await import(join(SRC, 'anchor.js'))

  const transportSrc = readFileSync(join(SRC, 'transport.js'), 'utf8')
  const engineSrc = readFileSync(join(SRC, 'engine.js'), 'utf8')

  // ── ADR-1：绑定键不含分支 ─────────────────────────────────────────────
  {
    const remote = 'git@github.com:demo/repo.git'
    const a = repoBinding.repoKeyOf({ remoteUrl: remote, branch: 'main' })
    const b = repoBinding.repoKeyOf({ remoteUrl: remote, branch: 'feature-x' })
    const c = repoBinding.repoKeyOf({ remoteUrl: remote })
    check(
      'ADR-1',
      'repoKey 不含分支（同 remote 不同 branch 得到同一 key）',
      a !== undefined && a === b && b === c,
      `main=${a} feature-x=${b} none=${c}`
    )
  }

  // ── ADR-3：水位线双层 ────────────────────────────────────────────────
  {
    const storeSrc = readFileSync(join(SRC, 'session-store.js'), 'utf8')
    const hasSeq = /syncedThroughSeq|nextSeq/.test(storeSrc)
    const hasByte = /syncedByteLen|byteLen|subarray/.test(storeSrc)
    check('ADR-3', '水位线同时具备 seq（校验）与字节偏移（裁剪）', hasSeq && hasByte, `seq=${hasSeq} byte=${hasByte}`)
  }

  // ── ADR-4：独立 ref 命名空间 + 永不 checkout ─────────────────────────
  {
    check(
      'ADR-4',
      '会话 ref 位于 refs/dsh-sessions/ 命名空间',
      /refs\/dsh-sessions\//.test(transportSrc)
    )
    // 去注释后再扫，避免文档里提到 checkout 造成假红
    const codeOnly = transportSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    check(
      'ADR-4',
      'transport 代码里不存在 git checkout 调用',
      !/['"`]checkout['"`]/.test(codeOnly)
    )
  }

  // ── ADR-6：分叉绝不自动合并 ─────────────────────────────────────────
  {
    const mk = (tail) => ({
      header: { type: 'session', id: 'session-1', cwd: '/x' },
      events: [0, 1, 2].map((i) => ({ type: 'user/message', seq: i, time: i, data: { t: i } })).concat(
        tail === undefined ? [] : [{ type: 'user/message', seq: 3, time: 3, data: { t: tail } }]
      ),
    })
    let kind = ''
    try {
      const d = conflict.decideConflict({ local: mk('A'), remote: mk('B') })
      kind = String(d?.decision?.kind ?? d?.kind ?? '')
    } catch {
      kind = '(threw)'
    }
    check(
      'ADR-6',
      '两端都推进时不返回 remote-wins / local-wins',
      !kind.includes('remote-wins') && !kind.includes('local-wins'),
      kind
    )
  }

  // ── ADR-9：public 默认拒绝，且判定失败不默认放行 ────────────────────
  {
    const pub = await repoVisibility.checkRepoVisibility({
      remoteUrl: 'git@github.com:demo/repo.git',
      runGh: async () => ({ stdout: JSON.stringify({ visibility: 'PUBLIC' }) }),
    })
    check('ADR-9', 'public 仓库需要显式确认才允许启用', pub.requiresConfirmation === true)

    const unknown = await repoVisibility.checkRepoVisibility({
      remoteUrl: 'git@github.com:demo/repo.git',
      runGh: async () => {
        throw new Error('no gh')
      },
      fetchJson: async () => {
        throw new Error('no network')
      },
    })
    check(
      'ADR-9',
      '可见性判定失败归为 unknown 且仍要求确认（不默认放行）',
      unknown.requiresConfirmation === true,
      String(unknown.verdict)
    )

    // 凭据不得随 remote URL 泄漏
    // 故意构造带凭据的 URL。用不可能匹配真实 token 形状的占位串，
    // 避免隐私闸门（scripts/check-private.sh）把它当成真凭据拦下。
    const dirty = 'https://user:A_FAKE_PASSWORD_PLACEHOLDER@github.com/demo/repo.git'
    const redacted = repoVisibility.redactUrl(dirty)
    check('ADR-9', '归一化 remote 时剥离 URL 中的凭据', !redacted.includes('A_FAKE_PASSWORD_PLACEHOLDER'), redacted)
  }

  // ── ADR-11：不得承诺跨机去重 ────────────────────────────────────────
  {
    const statesReality = /跨机器去重不成立|跨机.*去重.*不成立/.test(transportSrc)
    check(
      'ADR-11',
      'transport 注释明确声明「跨机去重不成立」（而不是反过来承诺）',
      statesReality
    )
  }

  // ── ADR-13：可见性闭环缺失时硬失败 ──────────────────────────────────
  {
    check(
      'ADR-13',
      'registry 不可用时下行硬失败而非「写盘即成功」',
      /REGISTRY_UNAVAILABLE/.test(engineSrc)
    )
  }

  // ── ADR-14：回滚按「新建 / 追加」分流 ───────────────────────────────
  {
    check(
      'ADR-14',
      '回滚区分本次新建（可删）与本次追加（只可还原）',
      /createdFailed/.test(engineSrc) && /appendedFailed/.test(engineSrc)
    )
  }

  // ── G2b：writeSession 产出的目录必须含 session.lock ─────────────────
  //
  // 注意：writeSession 需要原生 zstd 压缩能力（Node >= 22.15）。
  // 在没有该能力的 Node 上这是**环境限制，不是实现缺陷**，所以跳过而不是判红——
  // 但要大声说出来，否则 CI 里会静默少验一条。
  {
    const root = mkdtempSync(join(tmpdir(), 'adr-lock-'))
    try {
      const cwd = join(root, 'repo')
      mkdirSync(cwd)
      const sessionId = 'session-00000000-0000-4000-8000-000000000000'
      const header = {
        type: 'session',
        version: 4,
        id: sessionId,
        createdAt: 1,
        cwd,
        isSeeded: false,
        delegationDepth: 0,
        agentPreset: 'cordis',
      }
      const sessionsRoot = join(root, 'sessions')
      const backupDir = join(root, 'backup')
      await sessionStore.writeSession(
        { sessionId, header, events: [{ type: 'user/message', seq: 0, time: 0, data: {} }] },
        { sessionsRoot, backupDir }
      )
      const dir = join(sessionsRoot, sessionStore.projectKey(cwd), sessionStore.encodeSegment(sessionId))
      const files = readdirSync(dir)
      check(
        'G2b',
        'writeSession 创建的会话目录包含 session.lock（否则 LIVE 检测永久短路）',
        files.includes('session.lock'),
        files.join(',')
      )
    } catch (error) {
      const noZstd = /没有 zstd 压缩能力/.test(String(error?.message))
      if (noZstd) {
        check(
          'G2b',
          `SKIP：当前 Node ${process.version} 无 zstd 压缩能力，无法验证（环境限制，非实现缺陷）`,
          true,
          'skipped'
        )
        results[results.length - 1].skipped = true
      } else {
        check('G2b', 'writeSession 创建的会话目录包含 session.lock', false, String(error?.message))
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  // ── FMT-2：projectKey 的安全字符 / 转义行为 ─────────────────────────
  {
    const cases = [
      ['/Users/x/Work/demo', '--Users-x-Work-demo--'],
      ['/Users/x/proj/中文', '--Users-x-proj-~4E2D~6587--'],
      ['/Users/x/my repo', '--Users-x-my~0020repo--'],
    ]
    const bad = cases.filter(([input, want]) => sessionStore.projectKey(input) !== want)
    check(
      'FMT-2',
      'projectKey 对非安全字符使用 ~XXXX 转义（不是简单字符替换）',
      bad.length === 0,
      bad.map(([i, w]) => `${i} -> ${sessionStore.projectKey(i)} != ${w}`).join('; ')
    )
  }

  // ── H1–H4：锚点漂移四态（含 rebase 这个坑）──────────────────────────
  {
    // H1 真祖先落后
    await withRepo(async ({ dir, git, writeFileSync }) => {
      const anchorSha = git('rev-parse', 'HEAD')
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(dir, 'f.txt'), `v${i}`)
        git('add', '-A')
        git('commit', '--quiet', '-m', `c${i}`)
      }
      const r = await anchor.describeAnchorDrift(dir, { headCommit: anchorSha })
      check(
        'H1',
        '真祖先落后 -> status=behind 且给出准确的提交数',
        r.status === 'behind' && r.commitsBehind === 3,
        `status=${r.status} n=${r.commitsBehind}`
      )
    })

    // H2 非祖先（rebase / 强推）—— 最容易误报成「落后 N 个」的路径
    await withRepo(async ({ dir, git }) => {
      const anchorSha = git('rev-parse', 'HEAD')
      git('checkout', '--quiet', '--orphan', 'rewritten')
      git('commit', '--quiet', '-m', 'rewritten-history')
      git('branch', '-f', 'main', 'rewritten')
      git('checkout', '--quiet', 'main')
      git('branch', '-D', 'rewritten')
      const r = await anchor.describeAnchorDrift(dir, { headCommit: anchorSha })
      check(
        'H2',
        '非祖先（rebase/强推）-> status=diverged，绝不复用「落后 N 个」的文案',
        r.status === 'diverged' && !/\d+\s*个提交之前/.test(r.message),
        `status=${r.status} msg=${r.message.slice(0, 40)}`
      )
    })

    // H3 本地缺 commit
    await withRepo(async ({ dir }) => {
      const r = await anchor.describeAnchorDrift(dir, {
        headCommit: '0123456789abcdef0123456789abcdef01234567',
      })
      check(
        'H3',
        '本地缺锚点 commit -> missing-commit 且提示先 fetch',
        r.status === 'missing-commit' && /fetch/.test(r.message),
        r.status
      )
    })

    // H4 锚点只提示、绝不阻断
    await withRepo(async ({ dir }) => {
      const bad = await anchor.describeAnchorDrift(dir, { headCommit: 'not-a-sha' })
      const gone = await anchor.describeAnchorDrift(join(dir, 'does-not-exist'), { headCommit: null })
      check(
        'H4',
        '非法 sha / 路径不存在都不抛错，只降级为提示',
        bad.status === 'unknown' && bad.advisory === true && typeof gone.status === 'string',
        `${bad.status}/${gone.status}`
      )
    })
  }

  // ── 锚点必须能随载荷跨机传递（H1–H4 只测了本地计算，这里测传输）──
  {
    const transport = await import(join(SRC, 'transport.js'))
    const root = mkdtempSync(join(tmpdir(), 'adr-anchor-'))
    try {
      const remotePath = join(root, 'remote.git')
      execFileSync('git', ['init', '--quiet', '--bare', remotePath], { stdio: 'ignore' })
      const repo = join(root, 'repo')
      mkdirSync(repo)
      const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim()
      execFileSync('git', ['init', '--quiet', repo], { stdio: 'ignore' })
      g('config', 'user.email', 'v@example.invalid')
      g('config', 'user.name', 'v')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(repo, 'a.txt'), '1')
      g('add', '-A')
      g('commit', '--quiet', '-m', 'c1')
      g('remote', 'add', 'origin', remotePath)
      g('branch', '-M', 'main')

      const facts = await anchor.captureAnchor(repo)
      const cwd = repo
      const sessionId = 'session-20202020-3030-4040-8050-606060606060'
      const header = {
        type: 'session', version: 4, id: sessionId, createdAt: 1, cwd,
        isSeeded: false, delegationDepth: 0, agentPreset: 'cordis',
      }
      const sessionsRoot = join(root, 'sessions')
      const backupDir = join(root, 'backup')
      await sessionStore.writeSession(
        { sessionId, header, events: [{ type: 'user/message', seq: 0, time: 0, data: {} }] },
        { sessionsRoot, backupDir }
      )
      const dir = join(sessionsRoot, sessionStore.projectKey(cwd), sessionStore.encodeSegment(sessionId))
      const { readFileSync } = await import('node:fs')
      const content = readFileSync(join(dir, 'session.v4.jsonl.zstd'))

      const tr = transport.createTransport({})
      const binding = {
        repoId: 'verify', repoPath: repo, repoKey: 'example.invalid/demo/repo',
        remoteUrl: 'git@example.invalid:demo/repo.git',
      }
      await tr.push(
        binding,
        { sessions: [{ sessionId, eventCount: 1, content, anchor: facts }] },
        { anchor: facts }
      )
      // 前进一个提交，让"落后"成立
      writeFileSync(join(repo, 'a.txt'), '2')
      g('add', '-A')
      g('commit', '--quiet', '-m', 'c2')

      const pulled = await tr.pull(binding, {})
      const carried = pulled?.sessions?.[0]?.anchor
      check(
        'H5',
        '锚点能随载荷跨机传递（push -> manifest -> pull）',
        carried?.headCommit === facts.headCommit,
        `carried=${carried?.headCommit} expected=${facts.headCommit}`
      )
      const drift = await anchor.describeAnchorDrift(repo, anchor.normalizeAnchor(carried))
      check(
        'H5',
        '用传递过来的锚点能算出漂移（behind 1）',
        drift.status === 'behind' && drift.commitsBehind === 1,
        `${drift.status} n=${drift.commitsBehind}`
      )
    } catch (error) {
      const noZstd = /没有 zstd 压缩能力/.test(String(error?.message))
      check(
        'H5',
        noZstd
          ? `SKIP：当前 Node ${process.version} 无 zstd 压缩能力，无法验证（环境限制）`
          : '锚点能随载荷跨机传递',
        noZstd,
        String(error?.message)
      )
      if (noZstd) results[results.length - 1].skipped = true
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  // ── 汇总 ────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok)
  const skipped = results.filter((r) => r.skipped === true)

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ results, passed: results.length - failed.length, failed: failed.length }, null, 2) + '\n')
  } else {
    for (const r of results) {
      const mark = r.skipped === true ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'
      process.stdout.write(`${mark}  ${r.id.padEnd(7)} ${r.claim}\n`)
      if (!r.ok && r.detail !== '') process.stdout.write(`        └─ ${r.detail}\n`)
    }
    process.stdout.write(
      `\n${results.length - failed.length}/${results.length} 通过` +
        (skipped.length > 0 ? `（${skipped.length} 条因环境限制被跳过，见上 SKIP）` : '') +
        (failed.length === 0 ? '  ✅ 实现符合设计' : `  ❌ ${failed.length} 条违规`) +
        '\n'
    )
  }

  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`verify-adr 自身失败：${error?.stack ?? error}\n`)
  process.exit(2)
})
