/**
 * 锚点 commit 的测试 —— 用真实临时 git 仓库，不 mock。
 *
 * 锚点的作用只是「提示」，所以这里的重点不是精确性，而是：
 *   - 各种仓库状态下都能给出**可读且不误导**的提示
 *   - 从不因为锚点算不出来而阻断同步（所有失败都降级为 advisory）
 *   - 来自远端的锚点字段不可信，必须校验后才使用
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { captureAnchor, describeAnchorDrift, normalizeAnchor } from '../src/anchor.js'
import { makeSandbox } from './fixtures/synth.js'

const execFileAsync = promisify(execFile)

/** 建一个提交历史可控的临时仓库。 */
async function makeRepo(sandbox, name = 'anchor-repo') {
  const repo = join(sandbox.home, name)
  await mkdir(repo, { recursive: true })
  const git = (args, cwd = repo) => execFileAsync('git', args, { cwd })
  // Pin the initial branch: the assertion below names 'main' explicitly, and
  // a developer whose git has init.defaultBranch=master would otherwise fail
  // here for a reason that has nothing to do with the code under test.
  await git(['init', '--quiet', '--initial-branch=main'])
  await git(['config', 'user.email', 'fixture@example.invalid'])
  await git(['config', 'user.name', 'fixture'])
  await git(['config', 'commit.gpgsign', 'false'])
  return { repo, git }
}

/** 追加一个提交，返回其 sha。 */
async function commit(repo, git, message) {
  await writeFile(join(repo, 'file.txt'), `${message}\n`)
  await git(['add', '.'])
  await git(['commit', '--quiet', '-m', message])
  const { stdout } = await git(['rev-parse', 'HEAD'])
  return stdout.trim()
}

test('captureAnchor：记录 HEAD、分支、脏文件数', async () => {
  const sandbox = await makeSandbox()
  try {
    const { repo, git } = await makeRepo(sandbox)
    const sha = await commit(repo, git, 'first')

    // 制造一个未提交改动
    await writeFile(join(repo, 'file.txt'), 'dirty\n')

    const anchor = await captureAnchor(repo)
    assert.equal(anchor.headCommit, sha)
    // 默认分支名取决于本机 git 的 init.defaultBranch（main / master 都常见），
    // 所以不写死具体名字，只断言「拿到了一个非空分支名且与 HEAD 一致」。
    assert.ok(
      anchor.branch === 'main' || anchor.branch === 'master',
      `分支名应为 main 或 master，实际 ${anchor.branch}`
    )
    assert.equal(anchor.dirtyCount, 1)
    assert.ok(anchor.capturedAt > 0)
  } finally {
    await sandbox.cleanup()
  }
})

test('captureAnchor：空仓库（还没有提交）不抛错，headCommit 为 null', async () => {
  const sandbox = await makeSandbox()
  try {
    const { repo } = await makeRepo(sandbox, 'empty-repo')
    const anchor = await captureAnchor(repo)
    assert.equal(anchor.headCommit, null, '空仓库没有 HEAD，但这不是错误')
    assert.ok(anchor.capturedAt > 0)
  } finally {
    await sandbox.cleanup()
  }
})

test('captureAnchor：非 git 目录不抛“致命”错误，字段为 null', async () => {
  const sandbox = await makeSandbox()
  try {
    const plain = join(sandbox.home, 'plain')
    await mkdir(plain, { recursive: true })
    const anchor = await captureAnchor(plain)
    assert.equal(anchor.headCommit, null)
    assert.equal(anchor.branch, null)
  } finally {
    await sandbox.cleanup()
  }
})

test('describeAnchorDrift：锚点等于 HEAD → current，不提示', async () => {
  const sandbox = await makeSandbox()
  try {
    const { repo, git } = await makeRepo(sandbox)
    const sha = await commit(repo, git, 'only')

    const drift = await describeAnchorDrift(repo, { headCommit: sha })
    assert.equal(drift.status, 'current')
    assert.equal(drift.commitsBehind, 0)
    assert.equal(drift.advisory, false, '一致时不该提示')
  } finally {
    await sandbox.cleanup()
  }
})

test('describeAnchorDrift：锚点是祖先 → behind，给出准确提交数', async () => {
  const sandbox = await makeSandbox()
  try {
    const { repo, git } = await makeRepo(sandbox)
    const first = await commit(repo, git, 'first')
    await commit(repo, git, 'second')
    await commit(repo, git, 'third')

    const drift = await describeAnchorDrift(repo, { headCommit: first })
    assert.equal(drift.status, 'behind')
    assert.equal(drift.commitsBehind, 2, '之后又提交了 2 次')
    assert.equal(drift.shortSha, first.slice(0, 7))
    assert.match(drift.message, /2 个提交之前/)
    assert.equal(drift.advisory, true)
  } finally {
    await sandbox.cleanup()
  }
})

test('describeAnchorDrift：锚点不在当前历史（rebase 过）→ diverged', async () => {
  const sandbox = await makeSandbox()
  try {
    const { repo, git } = await makeRepo(sandbox)
    await commit(repo, git, 'base')
    const orphan = await commit(repo, git, 'will-be-orphaned')

    // 造一个与当前历史无关的提交：换到孤儿分支再重置
    await git(['checkout', '--quiet', '-b', 'tmp'])
    await commit(repo, git, 'other')
    await git(['checkout', '--quiet', 'main'])
    await git(['reset', '--hard', '--quiet', 'HEAD~1'])
    await commit(repo, git, 'replacement')

    const drift = await describeAnchorDrift(repo, { headCommit: orphan })
    assert.ok(
      drift.status === 'diverged' || drift.status === 'missing-commit',
      `应为 diverged 或 missing-commit，实际 ${drift.status}`
    )
  } finally {
    await sandbox.cleanup()
  }
})

test('describeAnchorDrift：本地没有该 commit → missing-commit', async () => {
  const sandbox = await makeSandbox()
  try {
    const { repo, git } = await makeRepo(sandbox)
    await commit(repo, git, 'first')

    // 一个格式合法但本机不存在的 sha
    const fakeSha = '0123456789abcdef0123456789abcdef01234567'
    const drift = await describeAnchorDrift(repo, { headCommit: fakeSha })
    assert.equal(drift.status, 'missing-commit')
    assert.match(drift.message, /git fetch/)
  } finally {
    await sandbox.cleanup()
  }
})

test('describeAnchorDrift：没有锚点时不提示失败', async () => {
  const sandbox = await makeSandbox()
  try {
    const { repo } = await makeRepo(sandbox)
    for (const anchor of [null, undefined, {}, { headCommit: null }]) {
      const drift = await describeAnchorDrift(repo, anchor)
      assert.equal(drift.status, 'none')
      assert.equal(drift.advisory, true)
    }
  } finally {
    await sandbox.cleanup()
  }
})

test('【安全】describeAnchorDrift：非法 sha 绝不传给 git 命令', async () => {
  const sandbox = await makeSandbox()
  try {
    const { repo } = await makeRepo(sandbox)
    const attacks = [
      'HEAD; rm -rf /',
      '$(whoami)',
      '../../etc/passwd',
      'deadbeef --upload-pack=touch /tmp/pwned',
      'not-a-sha',
      '   ',
    ]
    for (const headCommit of attacks) {
      const drift = await describeAnchorDrift(repo, { headCommit })
      assert.equal(drift.status, 'unknown', `${headCommit} 应被拒为 unknown`)
      // 关键：不能让恶意值走到 git 调用里
      assert.equal(drift.shortSha, null)
    }
  } finally {
    await sandbox.cleanup()
  }
})

test('normalizeAnchor：合法锚点被保留，非法字段被丢弃', () => {
  const good = normalizeAnchor({
    headCommit: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
    branch: 'main',
    worktree: '/tmp/wt',
    subPath: 'src',
    dirtyCount: 3,
    capturedAt: 1_700_000_000_000,
  })
  assert.equal(good.headCommit, 'abcdef0123456789abcdef0123456789abcdef01', 'sha 归一成小写')
  assert.equal(good.branch, 'main')
  assert.equal(good.dirtyCount, 3)

  const hostile = normalizeAnchor({
    headCommit: 'HEAD; rm -rf /',
    branch: 'x'.repeat(1000),
    dirtyCount: -5,
    capturedAt: 0,
    subPath: 12345,
  })
  // 全字段非法且没有可用信息 → null，不要留空壳让下游误以为有锚点
  assert.equal(hostile, null)

  // 部分合法：保留合法的部分
  const partial = normalizeAnchor({ headCommit: null, capturedAt: 1_700_000_000_000, branch: 'dev' })
  assert.equal(partial.headCommit, null)
  assert.equal(partial.branch, 'dev')

  for (const bad of [null, undefined, 'string', 42, []]) {
    assert.equal(normalizeAnchor(bad), null)
  }
})

test('锚点链路端到端：采集后经过序列化/反序列化仍可比较', async () => {
  const sandbox = await makeSandbox()
  try {
    const { repo, git } = await makeRepo(sandbox)
    const first = await commit(repo, git, 'first')
    await commit(repo, git, 'second')

    const captured = await captureAnchor(repo)
    // 模拟「写进 manifest → 远端 → 读回来」
    const roundTripped = normalizeAnchor(JSON.parse(JSON.stringify(captured)))

    assert.equal(roundTripped.headCommit, captured.headCommit)
    const drift = await describeAnchorDrift(repo, roundTripped)
    assert.equal(drift.status, 'current')

    // 用旧锚点比较 → behind 1
    const oldDrift = await describeAnchorDrift(repo, { headCommit: first })
    assert.equal(oldDrift.commitsBehind, 1)
  } finally {
    await sandbox.cleanup()
  }
})
