# 多人（多 Agent）共享工作区协作规约

> 本仓库在开发期由多个 Agent 在**同一个工作目录、同一个 `.git/index`** 上并行工作。
> 这会带来一个结构性风险，必须用纪律对冲。

## 事故记录（真实发生过）

`test/lib/*` 的提交里混进了 `src/session-store.js` 等他人文件：

```
$ git show --name-only --format="" 180a628
src/session-store.js          ← 别人写的
test/README.md                ← 我的
test/fixtures/synth.js        ← 别人写的
test/lib/fixtures.mjs         ← 我的
test/lib/zstd-frame.mjs       ← 我的
test/session-store.test.js    ← 别人写的
test/unit/meta-fixtures.test.js  ← 我的
```

**根因**：`.git/index` 是共享的。A 执行 `git add` 之后、`git commit` 之前，
B 也执行了 `git add`，B 的文件就进了 A 的暂存区，被 A 的 commit 一起带走。

这次运气好内容原样没丢；下次可能就是「半成品被提交」或「别人的改动被覆盖」。

## 规则

### R1 — 提交前必须清空索引并只 add 自己的文件

```bash
git reset          # 清空暂存区，避免顺手带走别人的
git add <仅你的文件>   # 显式列出，不要用 -A / -u / .
git commit -m "..."
```

**禁止** `git add -A`、`git add .`、`git commit -a`。

### R2 — add 与 commit 之间不要插入其它命令

中间任何耗时操作都会放大竞态窗口。

### R3 — 提交前必须跑两道检查

```bash
./scripts/check-private.sh --staged   # 隐私闸门（pre-commit 也会跑）
node --test                           # 测试必须全绿
```

### R4 — 冲突不可解时停下来

如果 `git status` 里出现你不认识的文件被暂存：
1. `git reset` 清空
2. 重新只 add 自己的
3. 如果还不对，**发消息给 lead**，不要强行提交

## 隐私红线（不可协商）

本仓库为 **PUBLIC**。以下内容**任何情况下不得提交**：

- 真实家目录绝对路径（`/Users/<name>/...`、`/home/<name>/...`）
- 凭据形态字符串（`ghp_`、`sk-`、`AKIA`、`PRIVATE KEY`、`xox`、`AIza`）
- 用户真实数据目录（`sessions/`、`attachments/`、`storages/`、`.credentials.*`）
- 真实 session UUID（`test/` 与 `docs/` 之外的地方）
- 真实主机名、内网 IP、SSH 配置内容

`scripts/check-private.sh` 会拦截以上全部，并已通过 `.githooks/pre-commit` 自动执行。

**示例数据一律使用**：`demo-*`、`<repo>`、`user@host`、RFC 5737 文档保留段 `192.0.2.x`。

## 目录归属（避免互相覆盖）

| 范围 | 归属 |
|---|---|
| `src/index.js` `config.js` `deps.js` `engine.js` `paths.js` `repo-binding.js` `store.js` `errors.js` | dev-core |
| `src/session-store.js` `transport.js` `conflict.js` `anchor.js` | dev-sync |
| `src/machines.js` `src/repo-visibility.js` `src/ui/**` | dev-ux |
| `test/lib/**` `test/unit/**` `test/*.e2e.test.js` `test/*.safety.test.js` `.github/workflows/**` | qa-engineer |
| `test/machines.test.js` | dev-ux |
| `docs/design.md` `docs/session-format.md` | arch |
| `docs/prd.md` | product-mvp |
| `docs/usage.md` `README.md` | dev-ux |
| `scripts/**` `docs/CONTRIBUTING-AGENTS.md` `.gitignore` `.githooks/**` | lead |

改别人范围内的文件前必须先在群里说明理由并得到回应。
