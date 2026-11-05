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

#
## R1 升级（2026-11 修订）— 用 `--only` 彻底绕开共享索引

R1 的 `git reset` + 显式 `git add` **仍然有竞态窗口**：`reset` 与 `add` 之间
任何其他 agent 执行 `git add`，其文件都会落进同一暂存区。

**实测复现（真实发生过）**：arch 按 R1 做了 `git reset` + `git add`，中间
`docs/prd.md` 被别人暂存进来，`git diff --cached` 才看到多了一个文件。

**正解：`git commit --only`，直接绕开暂存区。**

```bash
git commit -m "your message" --only -- <file1> <file2>
```

实测验证（`/tmp` 隔离仓库）：

```
场景：索引里有 a.txt（我的）和 b.txt（模拟别人的竞态文件）
$ git commit -m "only a.txt" --only -- a.txt
实际提交: a.txt
索引剩余: b.txt        ← 别人的原样保留
✅ b.txt 未被提交（隔离成功）
```

`--only` 的语义是「忽略暂存区，只提交命令行点名的路径」。它与别人的
`git add` 完全无关，因此**竞态窗口消失**。

注意 `--only` 后面必须用 `--` 分隔路径，否则 `-m` 的值会被当作 pathspec。

### 保留 R1 的理由
先 `git add` 仍有价值：`pre-commit` 钩子读的是暂存区，而
`scripts/check-private.sh --staged` 依赖它。所以推荐流程是：

```bash
git add <仅你的文件>
./scripts/check-private.sh --staged      # 隐私闸门读数
node --test                              # 测试
git commit -m "..." --only -- <相同文件>  # 提交仍以 --only 为准
```

**即使 `git add` 阶段混进了别人的文件，`--only` 也会把它们排除。**

## R2 — add 与 commit 之间不要插入其它命令

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

## R5 — 提交后验证 **committed blob**，不是工作区

`git add` 与 `git commit` 之间，别人改了同一个文件时，**你的 commit 里是那个中间态**，
而你的工作区和测试结果都还是对的。

**真实事故**：一次提交混进了别人变异测试的残留行
```js
// MUTATION: cwdOverride removed
```
等于删掉了 `cwdOverride: canonical` —— 每次全新下载的会话都保留上传机的 cwd，
`attachSession` 必然拒绝，**写入的文件永远不出现在侧栏**。正是我们整轮在防的失败模式。
发现时工作区是对的、测试是绿的，**只有提交进去的 blob 是坏的**。

**要求**：敏感改动提交后，直接查 commit 内容而不是工作区：

```bash
git show HEAD:src/engine.js | grep -c 'cwdOverride: canonical'   # 期望 1
git show HEAD:src/engine.js | grep -c 'MUTATION'                 # 期望 0
```

同类检查：任何「某关键字必须存在/必须不存在」的改动，都应对 `git show HEAD:<file>` 做断言。

### 变异测试的提交纪律

做变异测试（故意改坏代码验证断言会红）时：
- **在独立目录或 git stash 之外做**，不要直接改工作区里别人正在提交的文件
- 做完**立刻恢复**，并在恢复后用 `git diff` 确认
- 如果必须改工作区，先在群里声明「我在 X 文件上做变异，N 分钟后恢复」

## 不要 skip，要注入

被测代码依赖某个环境能力（原生 zstd / 网络 / 时钟）时，正确做法是
**注入一个最小可用的替代实现让测试真跑完**，而不是 `t.skip()`。

**skip 是假绿的一种形式**：它诚实地说了自己在跳过，但**保护力是零，统计上却算作"通过"**。
本项目的做法：无原生 zstd 时注入符合 RFC 8878 的 raw-block 帧编码器，
于是 `writeSession` 在任何 Node 上都能真跑，两份实现各自独立、都验证产出可解码。

## 隐私红线（不可协商）

本仓库为 **PUBLIC**。以下内容**任何情况下不得提交**：

- 真实家目录绝对路径（`/Users/<name>/...`、`/home/<name>/...`）
- 凭据形态字符串（`ghp_`、`sk-`、`AKIA`、`PRIVATE KEY`、`xox`、`AIza`）
- 用户真实数据目录（`sessions/`、`attachments/`、`storages/`、`.credentials.*`）
- 真实 session UUID（`test/` 与 `docs/` 之外的地方）
- 真实主机名、内网 IP、SSH 配置内容

`scripts/check-private.sh` 会拦截以上全部，并已通过 `.githooks/pre-commit` 自动执行。

**示例数据一律使用**：`demo-*`、`<repo>`、`user@host`、RFC 5737 文档保留段 `192.0.2.x`。


## 测试断言的四条铁律（本项目血泪）

### 1. 每条断言先问：「如果实现错了，它会不会红？」

不会红的断言不是断言，是装饰。**必须配反向对照**：故意做出错误行为，确认它真的红。

> 实例：曾提议用「第二次 push 的 git 对象数量 < 第一次的比例」证明增量。
> 实测 `count-objects` 受 gc 打包与未引用对象不传输影响，delta 可为 0 —— **永远绿**。
> 改为比对 `refs/dsh-sessions/v1` 树的 `{path→blob oid}` 集合变化（内容哈希，与打包无关），
> 正反两面验证后才有保护力。

### 2. 先验证断言本身，再相信断言

已实测证伪的写法（禁止使用）：

| 反模式 | 为什么会假绿 | 实测证据 |
|---|---|---|
| `zstdDecompressSync(整文件)` 后断言"能解析" | 只解第一帧，静默丢 99.99%；header 是合法 JSON 所以绿 | 757,118 B → 273 B（真值 3,080,613 B） |
| 用 git 对象总数证明增量传输 | git 打包、未引用对象不传 | 连续 push，count-objects delta = 0 |
| 断言文件字节完全相同证明同步正确 | cwd 重写必然改字节 | — |
| 断言 `~/.dsh` 前后 hash 不变 | DSH 运行时持续 append | 20 秒内 hash 必变 |
| `attachSession()` 没抛错就算成功 | 可能不抛错但被 cwd 过滤，静默不可见 | — |
| 断言目录「还存在」证明回滚安全 | 可能是删了重建空目录 | 事件数必须另行断言 |

### 3. 选「能稳定区分对错」的维度，不是「看起来最严格」的维度

同一个 PRD 里两条验收标准正好踩了这个坑的两端：
- AC-11 选 hash → **太强，必然误报**（DSH 一直在写）
- AC-7 选 mtime → **太弱，会漏报**（1 秒粒度，变化未跨秒即通过）

### 4. 硬编码的数字必须标注采样时点

`~/.dsh` 是活的（项目期间语料 218 → 219 个会话）。写「218 个会话」会过期，
应写「约 218（采样时点快照）」或改用比例。

### 5. 新写的断言，必须在「有 bug 的代码」上验证过它会红

**没在 bug 上红过的断言，不算写完。**

> 实例：为「engine 把追加和新建混在一起」写回归测试，第一版断言是
> 「两个 return 字面量不同」+「全文件 grep 有没有 `created`」。
> **在 bug 代码上它通过了** —— 两个 literal 只因局部变量名不同，
> 而 `created` 这个词在注释里出现过。
> 如果直接报"已覆盖"，就是在 318 全绿之上再加一层假保障，比没有测试更糟。
>
> 修正后要求：两个分支都显式带 boolean 标志、且 `rollbackSet` 构造表达式里
> 必须出现该标志——严格版在 bug 上正确变红。

操作方法：先让测试在**未修复的代码**上跑一次，确认它红；再修代码，确认转绿。跳过第一步就等于没测。

### 7. 断言说「实现错了」时也有两种可能：实现真错，或断言写错

前面几条讲的都是**假绿**（该红没红）。这条讲**假红**：断言变红了，于是去"修"代码，
结果把**正确的实现改坏**。

> 实测案例：审计 ADR-11 时，正则匹配到注释里的「跨机去重**成立**」并判为违规。
> 但注释原文是「跨机去重**不**成立」—— **正是 ADR-11 要求的内容**。
> 差点把一个正确的警告注释改成含糊表述。
>
> 另一例：C1 断言用 `replace(/refs\/dsh-sessions\/\S+\n?/g,'')` 清理 ref 列表，
> 正则没匹配干净，被误判为「用户 ref 变了」。

**操作要求**：断言变红时，先确认「我断言的对象/方式是我想的那个」，
再去看被测代码。尤其是**正则匹配源码**、**字符串比较**、**路径清理**这三类断言。

### 8. 当缺陷可能被下游兜底时，上游测试必须伪造下游的旧行为

> 实例：为「本机领先被误报为假冲突」写回归测试，第一版没抓住缺陷——
> 因为下游 `classifyIncoming` 已经兜底处理了，删掉上游 guard 测试照样绿。
> 必须让测试**复现下游修复前的行为**，才真正测到上游的保护逻辑。

否则你测的是下游，不是上游；而且会误以为上游 guard 是死代码。

### 9. 端到端测试必须验证「副作用真的发生了」

只断言「函数返回 ok」是不够的：**返回 `ok:true` 但磁盘没有任何变化，是一种测试抓不到的失败。**

> 实测案例：366 个测试全绿、0 skip 的状态下，**「下行同步」核心功能完全不可用**。
> 根因：`transport.pull()` 返回的是 zstd 字节（`content`），而引擎直接把这条记录
> 传给 `writeSession()`——后者要求 `header` + `events`，于是每个会话都抛 `bad-request`。
>
> 为什么没被发现（两层遮蔽）：
> 1. `engine-assembly` 测试用的是 **stub 的 sessionOps**，stub 的 write 不校验入参 → 永远绿
> 2. 真实路径抛的错被 `catch` **降级成 `skippedSessions`** → `down` 仍返回 `ok:true`
>
> 正确做法：断言**可观测的世界状态**——B 机磁盘上确实有文件、事件数正确、内容与 A 机一致。
> 而不是断言「返回值说它做了」。

**假绿的三种形态（本项目都实际发生过）**：
1. 断言太弱 —— 从没在 bug 上红过（铁律 5）
2. 被测对象有盲区 —— 断言没走到真正的判断分支（`session.lock` 缺失导致 LIVE 检测短路）
3. **只验证返回值，不验证副作用** —— 本条

### 10. 函数级的正确不能推出系统级的正确

> 实例：`rollbackNewSessions()` 的注释与实现都严格正确（"绝不删已存在的会话"），
> 但**调用方把「追加」也塞进了「本次新建」集合**，导致 attach 失败时
> `rm -rf` 删掉了用户 3 轮历史对话。
> **审查时必须看调用点，不能只审被调函数。**

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
