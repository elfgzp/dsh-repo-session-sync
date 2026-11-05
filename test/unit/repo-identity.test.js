/**
 * Repository *identity* tests.
 *
 * ## Why this file exists
 *
 * A binding's identity decides which sessions belong to which repository across
 * machines. Getting it wrong is not a cosmetic bug: an identity that varies when
 * it should not produces duplicate bindings, two independent sync histories for
 * one repository, and conversations that never line up between machines.
 *
 * The specific defect these tests pin down: `repoKey` used to be
 * `canonicalRemoteUrl \0 branch`. One clone therefore produced a different key per
 * checked-out branch, so the same repository appeared as two rows in the settings
 * page the moment someone switched branches (ADR-1).
 *
 * Identity must depend on what the repository *is*, never on transient working
 * state — not the branch, not the local path, not the current commit.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BindingTable,
  canonicalizeRemoteUrl,
  createBinding,
  deriveRepoId,
  repoKeyOf,
} from '../../src/repo-binding.js'

/**
 * Build a binding for one repository on a given branch.
 *
 * @param {string} branch - Branch name.
 * @param {object} [overrides] - Field overrides.
 * @returns {object} Binding.
 */
function bindingOn(branch, overrides = {}) {
  return createBinding({
    repoPath: '/tmp/demo',
    remoteUrl: 'git@example.invalid:demo/project.git',
    branch,
    ...overrides,
  })
}

test('repoKey：同一仓库的不同分支必须产生同一个身份（ADR-1）', () => {
  const main = bindingOn('main')
  const feature = bindingOn('feature-x')
  const detached = bindingOn('HEAD')

  assert.equal(main.repoKey, feature.repoKey, 'main 与 feature-x 必须是同一个仓库身份')
  assert.equal(main.repoKey, detached.repoKey, '分离 HEAD 也必须是同一个仓库身份')
})

test('repoKey：同一仓库的不同分支必须产生同一个 repoId（否则 UI 会出现两行）', () => {
  const main = bindingOn('main')
  const feature = bindingOn('feature-x')
  assert.equal(main.id, feature.id, 'repoId 由 repoKey 派生，所以也必须相同')
})

test('repoKey：branch 仍然保留为展示字段，只是不参与身份', () => {
  const feature = bindingOn('feature-x')
  assert.equal(feature.branch, 'feature-x', 'branch 仍要记录，供 UI 显示')
  assert.ok(!feature.repoKey.includes('feature-x'), 'branch 不得出现在身份键里')
  assert.ok(!feature.repoKey.includes('\u0000'), '身份键里不应再有分隔符')
})

test('repoKey：不同仓库必须产生不同身份', () => {
  const a = createBinding({ repoPath: '/tmp/a', remoteUrl: 'git@example.invalid:demo/alpha.git' })
  const b = createBinding({ repoPath: '/tmp/b', remoteUrl: 'git@example.invalid:demo/beta.git' })
  assert.notEqual(a.repoKey, b.repoKey)
  assert.notEqual(a.id, b.id)
})

test('repoKey：同一远端的不同写法必须归一化成同一个身份', () => {
  const forms = [
    'git@example.invalid:demo/project.git',
    'git@example.invalid:demo/project',
    'ssh://git@example.invalid/demo/project.git',
    'https://example.invalid/demo/project',
    'https://example.invalid/demo/project.git',
  ]
  const keys = forms.map((remoteUrl) => {
    const parsed = canonicalizeRemoteUrl(remoteUrl)
    assert.ok(parsed !== undefined, `无法解析：${remoteUrl}`)
    return parsed.canonical
  })
  for (const key of keys) {
    assert.equal(key, keys[0], `归一化结果不一致：${keys.join(' | ')}`)
  }
})

test('repoKey：身份与本地路径无关（两台机器路径不同也要对上）', () => {
  const onA = createBinding({
    repoPath: '/Users/demo/work/project',
    remoteUrl: 'git@example.invalid:demo/project.git',
  })
  const onB = createBinding({
    repoPath: 'D:/work/project',
    remoteUrl: 'git@example.invalid:demo/project.git',
  })
  assert.equal(onA.repoKey, onB.repoKey, '同一仓库在不同机器的路径不会改变身份')
  assert.equal(onA.id, onB.id, 'repoId 也必须一致，否则两台机器各建一条绑定')
})

test('repoKeyOf：与 createBinding 使用同一套身份规则', () => {
  const binding = bindingOn('main')
  assert.equal(repoKeyOf(binding), binding.repoKey)
  assert.equal(repoKeyOf({ remoteUrl: binding.remoteUrl, branch: 'other' }), binding.repoKey)
})

test('BindingTable：同一仓库换分支不会新增绑定行', () => {
  const table = new BindingTable()
  table.upsert(bindingOn('main'))
  assert.equal(table.list().length, 1)

  // Switching branch and rebinding must land on the SAME row. This is an in-place
  // update of one identity, not a replacement of a different one, so `replaced`
  // is false — what matters is that the row count does not grow.
  const second = table.upsert(bindingOn('feature-x'))
  assert.equal(second.replaced, false, '同一身份是更新而不是替换')
  assert.equal(table.list().length, 1, '一个仓库只能有一条绑定')
  assert.equal(table.getByKey(bindingOn('main').repoKey)?.branch, 'feature-x', 'branch 应被更新')
})

test('BindingTable：换分支后按身份查询仍能命中同一条绑定', () => {
  const table = new BindingTable()
  table.upsert(bindingOn('main'))
  table.upsert(bindingOn('feature-x'))

  const found = table.getByKey('example.invalid/demo/project')
  assert.ok(found !== undefined, '按归一化身份必须能查到绑定')
  assert.equal(table.list().length, 1)
})

test('deriveRepoId：对旧形态的 key 仍能派生可读前缀（防御性）', () => {
  // Keys written before ADR-1 carried a `\0branch` suffix. Nothing produces that
  // shape now, but an imported legacy table must not produce a garbage id.
  const legacyKey = 'example.invalid/demo/project\u0000main'
  const id = deriveRepoId(legacyKey)
  assert.match(id, /^repo-example-invalid-demo-project-[0-9a-f]{8}$/)
})

test('deriveRepoId：稳定 —— 同样输入永远同样输出', () => {
  const key = 'example.invalid/demo/project'
  assert.equal(deriveRepoId(key), deriveRepoId(key))
  assert.notEqual(deriveRepoId(key), deriveRepoId('example.invalid/demo/other'))
})
