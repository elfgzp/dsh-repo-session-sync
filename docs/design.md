# dsh-repo-session-sync 技术设计

> 把 DSH 的会话内容，跟着**仓库自己的 git** 在机器之间同步。
> 代码差异由用户自己的 `git commit / push` 解决；本插件只解决**会话**。

## 1. 问题与边界

### 1.1 要解决的

用户有不止一台机器，同一个仓库在两台上交替开工。代码可以 `git push` / `git pull`，
但**AI 对话内容没有任何通道**。结果：在 A 机跟 AI 讨论出的方案，到 B 机上 AI 完全不知道，
用户被迫复述。这是"换机器"场景下最磨人的损耗。

用户原话：

> 「其实我主要的场景是针对带 git 的仓库进行会话同步 这样就算是代码变动其实可以用 git 进行
> commit push 在同步 但是会话内容没法同步这个可能要解决 用 rsync 或者别的方案
> 参考 remote 方式配置好机器 无论是向上同步还是向下同步可能都需要」

### 1.2 明确不解决的（做减法，附理由）

| 不做 | 理由 |
|---|---|
| 同步整个 `~/.dsh` | 里面是**全机器**状态：所有项目、所有会话、凭据、缓存、插件。跨机搬它既巨大（本机语料约 516 MiB）又危险（`.credentials.yaml`），且绝大多数内容与"这个仓库"无关。用户自己也说了只针对带 git 的仓库。 |
| 同步设置 / 插件 / 模型配置 | 已有 `dsh-settings-sync` 之类的工具负责，职责不重叠。混进来会让本插件的失败面扩大到"整个 DSH 配置"。 |
| 非 git 目录的会话 | 没有仓库身份 = 没有跨机对齐的锚点。硬做只能靠路径，而路径在两台机器上几乎必然不同（见 §3）。明确不支持，比"支持了但经常对不上"好。 |
| 附件自动同步 | 本机 `~/.dsh/attachments` 是 218 MB / 883 个文件，且是 SHA-256 内容寻址的。默认不同步，避免把仓库撑大；留开关。 |
| 自动合并冲突的会话 | 见 §7：自动合并等于伪造一段从未发生过的对话历史。绝不做。 |

### 1.3 一句话原则

> **能 `git push` 的仓库，就是能同步的仓库。**

这句话推出三个直接结论：不引入第二套认证、不引入"机器"概念、不要求用户额外配置东西。

---

## 2. 架构总览

```mermaid
flowchart TB
    subgraph local["本机 A"]
        direction TB
        S1["<b>会话发现</b><br/>扫 ~/.dsh/sessions/**<br/>读 header.cwd 匹配仓库"]
        S2["<b>日志读取层</b><br/>顺序扫帧 → 逐帧解码<br/>→ 事件流 seq 连续"]
        S3["<b>水位线</b><br/>物理 byteLen 传输裁剪<br/>逻辑 syncedThroughSeq 校验"]
        S4["<b>分块器</b><br/>按 zstd 帧边界切块<br/>收敛加密 → 内容寻址"]
        S5["<b>锚点采集</b><br/>HEAD + branch + dirty"]
        S6["<b>可见性闸门</b><br/>public → 拒绝"]
    end

    subgraph transport["传输层：用户自己的 git remote"]
        R1["refs/dsh-sessions/v1<br/>独立 ref，永不 checkout"]
        R2["对象库<br/>blob = 加密分块<br/>tree = 会话索引<br/>commit = 一次快照"]
    end

    subgraph remote["另一台机器 B"]
        R3["<b>下行</b><br/>显式 refspec fetch"]
        R4["<b>校验</b><br/>解码 / 连续性 / 路径安全"]
        R5["<b>应用</b><br/>快照 → 追加 或 另存"]
    end

    S1 --> S2 --> S3 --> S4
    S5 --> S4
    S6 --> S4
    S4 -->|"git plumbing"| R2
    R2 --- R1
    R1 -->|"git fetch<br/>refs/dsh-sessions/v1:refs/dsh-sessions/v1"| R3
    R3 --> R4 --> R5
    R5 -.->|"写入"| L2["~/.dsh/sessions/**"]

    classDef store fill:#eef,stroke:#557
    class R1,R2 store
```

### 2.1 数据流（上行）

```mermaid
sequenceDiagram
    participant U as 用户
    participant E as 同步引擎
    participant L as 本机会话日志
    participant G as git
    participant O as 远端 ref

    U->>E: 上行(repo)
    E->>G: 可见性校验（public → 拒绝）
    E->>G: rev-parse HEAD / branch / status
    loop 每个属于该仓库的会话
        E->>L: flock 探测 + 读文件
        E->>E: 顺序扫帧 → 逐帧解码
        E->>E: 对比 syncedThroughSeq 算新增帧
        alt 无新增
            E-->>E: 跳过
        else 有新增
            E->>E: subarray(byteLen) 只取新增帧
            E->>E: 收敛加密 → 内容寻址 blob
        end
    end
    E->>E: 写 manifest（锚点 commit + syncedThroughSeq）
    E->>G: hash-object / mktree / commit-tree
    E->>O: push refs/dsh-sessions/v1
    E-->>U: 报告：N 个会话、M 个分块、锚点 X
```

### 2.2 数据流（下行）

```mermaid
sequenceDiagram
    participant U as 用户
    participant E as 同步引擎
    participant O as 远端 ref
    participant S as 本机 sessions

    U->>E: 下行(repo)
    E->>O: fetch refs/dsh-sessions/v1（显式 refspec）
    E->>E: 读 manifest，逐会话比较
    loop 每个远端会话
        alt 本地不存在
            E->>E: 校验 → 新建
        else 本地 seq 已覆盖
            E-->>E: 已最新，跳过
        else 远端 first seq == 本地 next-seq
            E->>S: 备份 → 追加写入
        else 本地领先
            E-->>E: 跳过 + 报告
        else 有缺口
            E-->>E: 拒绝，包不完整
        else 同 id 内容不同（分叉）
            E->>S: 原会话不动，另存 + 标注来源
        end
    end
    E->>E: 比较锚点与 HEAD → 提示落后 N 个提交
    E-->>U: 报告 + 冲突清单
```

---

## 3. 会话 ↔ 仓库的绑定键

### 3.1 结论

```
repoKey = normalizeRemoteUrl(remoteOriginUrl)
```

**只有 remote URL，不含分支，不含绝对路径。**

会话在本地按 `cwd` 发现（因为 DSH 就是这么存的），但 `cwd` **不进入绑定键**——
它只是"这台机器上这个会话放在哪"的本地属性。

```
绑定记录 = { repoKey, localPath, direction, lastSync? }
```

### 3.2 为什么不含分支

这是本设计里最容易做错、后果最隐蔽的一个决定。

**关键事实**：`cwd` 里**不含任何分支信息**。实测本机 8 个 `cwd` 中，既有 git 仓库根目录，
也有非 git 目录（`default-workspace`、`profiles/desktop`）。DSH 记录的是**会话启动时的工作目录**。

于是：用户在同一份 checkout 上 `git switch` 到另一个分支，**新会话的 `cwd` 完全不变**，
会话里也**根本没有分支字段**。会话的身份（"我在这个项目里跟 AI 聊过的内容"）与分支无关。

后果：**把 branch 放进绑定键，会导致"切了分支之后这个仓库的历史会话全部对不上"**，
而用户的会话对象其实一点没变。

> **ADR-1**：绑定键 = 归一化 remote URL。**分支不进键**，只作为 manifest 里的
> 提示字段（`branch`），用于展示与"锚点过期"判断，不参与身份。

#### 为什么分支不能进身份键（三条独立证据）

> **状态：已修复。** 早期实现的 `repoKeyOf()` 曾返回
> `` `${remote.canonical}\u0000${branch}` ``（连同 JSDoc 一起写着），与 ADR-1 相悖。
> 现已改为只返回 `remote.canonical`，模块头注释、tool description、
> systemPrompt 三处文案同步更正。以下保留论证，供后来者理解为什么不能改回去。

**三条独立证据：**

1. **会话 header 里没有 branch 字段**（实测 219 个真实会话，字段全集只有
   `agentPreset / createdAt / cwd / delegationDepth / id / isSeeded /
   origin / parentSession / type / version`）。用分支做键，等于**给一个不存在于
   数据里的维度建索引**。后果不是"跨分支混在一起"，而是**身份漂移**：

   | 时刻 | 当前分支 | 同一会话文件该算哪个绑定 |
   |---|---|---|
   | T1 建会话 | `main` | binding(main) |
   | T2 切分支继续聊 | `feature-x` | binding(feature-x)？**但磁盘上还是同一个文件** |

2. **发现层与绑定层口径不一致**：会话发现按 `header.cwd` 匹配（不看分支），
   而绑定若按 remote+branch 分键 → 同一批会话被拆到两个 binding，
   出现"会话在发现集合里、却找不到对应 binding"的自相矛盾状态。

3. **与本文 §3.4 直接冲突**：§3.4 规定 **worktree 共享同一个 `repoKey`**，
   而 worktree 的定义就是"同一仓库、不同分支"。键里带分支会直接推翻 §3.4。

> **一句话**：**分支属于展示维度，不属于身份维度。**
> 用户切到 `feature-x` 时看到之前在 `main` 上聊的会话，这是**正确行为**，不是串味。
> 真要区分，在展示层用 manifest 里的 `branch` 提示，而不是在身份层分键。

### 3.3 remote URL 归一化

实测多种写法归一化结果一致（脚本见附录 A1）：

```
git@github.com:Org/Repo.git                    -> github.com/org/repo
https://github.com/Org/Repo.git                -> github.com/org/repo
https://github.com/Org/Repo                    -> github.com/org/repo
ssh://git@github.com/Org/Repo.git              -> github.com/org/repo
git@github.com:Org/Repo/                       -> github.com/org/repo
https://user:token@github.com/Org/Repo.git     -> github.com/org/repo   ← 凭据被剥掉
git@GitHub.com:Org/Repo.git                    -> github.com/org/repo   ← 大小写归一
```

规则（顺序敏感）：

1. 去掉协议前缀（`scheme://`）
2. 去掉 `user[:pass]@` —— **同时满足安全要求：凭据不落盘、不进 manifest**
3. scp 形（`host:path`）的 `:` → `/`
4. 折叠重复 `/`
5. 去掉尾部 `.git` 与尾部 `/`
6. **整体转小写**

> **注意**：GitHub / GitLab 的主机名与 owner/repo **大小写不敏感**，转小写安全。
> 但对大小写敏感的自建 Git 服务（部分 Gitea 配置、裸 git 服务），转小写会
> **把两个不同仓库合并成一个**。
> **ADR-2**：默认转小写；提供 `repoKeyCaseSensitive` 配置项。检测到非
> github.com / gitlab.com 主机时**给出提示但不自动切换**（避免静默改变身份）。

### 3.4 worktree 怎么算

**worktree 不单独成键——它共享同一个 `repoKey`。** 理由：worktree 通常就是"同一仓库的
另一个分支检出"，用户的会话心智是"这个项目"。

实测（同一仓库 + 2 个 worktree）：

```
main-repo : --show-toplevel=<repo>        --git-common-dir=.git
wt-1      : --show-toplevel=<repo>-wt-1   --git-common-dir=<repo>/.git
wt-2      : --show-toplevel=<repo>-wt-2   --git-common-dir=<repo>/.git
三者 remote.origin.url 完全相同
```

- 会话按 `cwd` 发现 → 三个 worktree 各自产生会话，但都归到同一个 `repoKey`。
- **不把 worktree 路径放进键**：否则「主 checkout 上聊的会话」与「worktree 里聊的会话」
  会被当成两个项目，跨机后路径一变全部失配。
- 但 worktree 的**分支不同**，所以 manifest 里要记 `branch` 与 `worktree` 路径，
  用于提示"这个会话来自 `wt-1` 的 `feat-x`"。

### 3.5 子目录启动的会话

若 `cwd` 是仓库的**子目录**（`git rev-parse --show-toplevel` ≠ cwd），
用 `--show-toplevel` 找到仓库根，把 cwd 相对根目录的路径记为 `subPath`。
`subPath` **不进绑定键**，只作展示。

### 3.6 无 remote 的仓库

`git remote get-url origin` 失败时：

- 若仓库有其它 remote，取第一个（按名字排序，保证确定性）
- 若完全没有 remote → **不可同步**，明确报错"该仓库没有远端，无法跨机同步"

绝不回退到"用绝对路径当键"——那会在另一台机器上静默地匹配不上，比直接报错更糟。

---

## 4. 增量识别：水位线

**两层并存，不是二选一**（格式细节见 [`docs/session-format.md`](./session-format.md) §7）。

| 层 | 用什么 | 职责 |
|---|---|---|
| 物理层 | 字节偏移 `syncedByteLen` | 增量**传输裁剪**：`buf.subarray(byteLen)` |
| 逻辑层 | `seq` 即 `syncedThroughSeq` | **完整性校验**、gap 检测、幂等、冲突判定 |

### 4.1 为什么必须两层

- **只用偏移不够**：偏移能说"从哪切"，但不能说"切出来的东西是否齐全"。文件被替换、
  日志代际从 v4 升到 v5、写入方换了压缩参数，偏移仍"看起来合理"但内容是错的。
- **只用 seq 不够**：为了按 seq 截取，几乎必须从头解码整个文件才知道每个 seq 的字节位置。
  对 24 MiB 的会话（本机实测最大单文件 24.1 MiB）而言，每次上行全量解码是浪费。

### 4.2 实测依据

- **偏移安全**：活跃会话采样，`A == B[:len(A)]` 恒为真，inode 不变，frame-0 sha 恒定。
- **seq 连续**：500 事件 gaps=0 / dups=0，严格 +1。
- **按帧切块无损**：260 帧在第 130 帧切开，重组字节完全相同，跨界 seq 连续（239→240）。

### 4.3 一致性守卫

```
若 seq_at(offset) != syncedThroughSeq：
   水位线失效 → 丢弃偏移，退回"顺序扫帧 + 按 seq 定位"，并记一次告警
```

> **ADR-3**：`(syncedThroughSeq, syncedByteLen)` 成对存储、成对校验。
> **seq 是权威，offset 是加速器**；两者不一致时以 seq 为准，绝不盲信 offset。

---

## 5. 传输通道选型

### 5.1 结论

> **在仓库自己的 git remote 里，用独立 ref 命名空间 `refs/dsh-sessions/v1`，
> 载荷是内容寻址的加密分块。用 git plumbing 写对象，永不 checkout。**

不是"orphan 分支"（这词容易让人以为要 `checkout` 出来），**不是**独立仓库，**不是** rsync。

### 5.2 决定性理由：整文件提交会 10 倍膨胀仓库

同一份 20 MiB 逻辑载荷、同样 20 次增量提交：

| 方案 | `.git` 体积 |
|---|---|
| A. 每次提交"累积增长的整体文件" | **210 MB** |
| B. 每次提交"只新增一个不可变分块" | **20 MB** |

差 **10 倍**。原因：zstd 压缩后的会话日志是**高熵二进制**，git 无法增量压缩它，
每次整体重写等于每次存一份全量。而 DSH 的日志恰恰是 **append-only 增长**的，
所以"整文件提交"这个最直观的做法是**灾难性**的。

> 这条如果做错，用户的**代码仓库**会被会话数据撑爆 —— 本设计中唯一
> "宁可牺牲优雅也不能错"的约束。

补充验证：**加密不改变这个结论**。用真实 AES-256-GCM 密文重跑同样的 20 次提交，
`.git` 仍为 20 MB。膨胀的来源是"重复存全量"，不是"加密后不可压缩"。

> ⚠️ **这个 10 倍对比只是「同机多次同步」的数字，不能用来论证跨机去重。**
> 跨机去重在当前格式下**根本不成立**，见 §5.6。

### 5.3 逐项否决其它通道

**A) 独立私有仓库（否）**
把"零配置"变成"N 个仓库、N 次认证"。用户诉求是"跟着这个项目的 git 走"，
另建仓库意味着每个项目手工再配一遍，且容易忘记哪个项目配过。**违背 §1.3 原则。**

**B) rsync over SSH（否）**，三条硬伤：

1. **需要"机器"一等公民** → 撞上 `~/.ssh/config` 所有权问题（见 §8）。
2. **没有共同祖先** → 无法表达"远端比我多 3 条、我也多了 2 条"。只能整目录覆盖，
   违反 §7 的"绝不静默覆盖"。
3. **拿不到内容寻址去重** → 就是 §5.2 的 10 倍问题。

**C) 复用 dsh-remote（否）** —— 独立成节（§8），因为它有独立的失败模型。

### 5.4 ref 方案的安全性 / 失败模式（全部实测）

在 `/tmp` 的裸仓库上逐项验证：

| 用户的动作 | 对 `refs/dsh-sessions/v1` 的影响 |
|---|---|
| `git push -f` / rebase 自己的分支 | **无影响** |
| `git gc --prune=now --aggressive` | **无影响** |
| `git branch -D` 删掉所有特性分支 | **无影响** |
| `git push --all` | **不会被顺带推**（好：不打扰用户） |
| `git push --prune origin` | **不会删掉它** |
| 全新 `git clone` | **不带出来** ← 双刃剑，见下 |
| 误删本地 ref | 可 `git fetch` 重新取回（远端还在） |

**"clone 不带出"是刻意的设计**：好处是绝不污染用户的 clone，代价是**必须显式 fetch**：

```bash
git fetch origin 'refs/dsh-sessions/v1:refs/dsh-sessions/v1'
```

这条要作为**用户可见的硬约定**写进使用文档——否则用户在 B 机 `git clone` 后发现没有会话，
会先怀疑插件坏了。

> **ADR-4**：会话 ref 放在 `refs/dsh-sessions/` 下（不在 `refs/heads/`、不在 `refs/tags/`），
> 全部操作走 `git` plumbing（`hash-object` / `mktree` / `commit-tree` / `update-ref`）。
> **永远不 checkout 这个 ref**，因此它不可能进入用户工作区，不会出现在
> `git log` / `git status` / 代码评审里。

### 5.5 分块策略

```
refs/dsh-sessions/v1 的树结构：
├── manifest.json                      # 全局索引 + 每会话水位线 + 锚点
├── objects/
│   └── ab/cdef…                       # 加密分块，内容寻址（ab = sha256 前 2 位）
└── sessions/
    └── <session-id>/
        └── log.jsonl                  # 引用清单（块 id 顺序），不是内容本身
```

- **分块粒度 = zstd 帧边界**（已验证：帧对齐整行、切块无损可重组）。
- **分块只写一次**：同一内容永远对应同一路径，重复上行不产生新对象 → 天然幂等；此处的幂等是**同机重试**语义，不是跨机命中，见 §5.6。
- **单块大小**：以帧为单位。全语料 258,789 帧实测：中位 **857 B**、p90 **3.1 KB**、
  最大 **156 KiB**。帧普遍很小，直接一帧一块会产生过多小对象，因此**把小帧合并到
  ~64 KB 再加密**（减少对象数量），但**合并必须发生在帧边界上**，绝不切开一帧。
- 大文件场景：本机实测最大会话文件 **24.1 MiB**，切块后约数百个对象，完全可控。


### 5.6 ⚠️ 跨机去重不成立（一条必须写死的负面结论）

**结论：内容寻址去重的收益只体现在「同机多次同步」，跨机去重没有保证。**

原因：DSH 会话是 **zstd 压缩后落盘**的，而 zstd 的输出对**批次边界极其敏感**。
同样的逻辑事件，若两端 append 的批次不同，压缩出的字节流完全不同。

实测（同一批 100 个逻辑事件，只改每帧事件数）：

```
  1 events/frame ->  11438 bytes  sha=733308d7e4c2ab15
  5 events/frame ->   3105 bytes  sha=de294952a45040c5
 10 events/frame ->   1899 bytes  sha=b0c57afdbdfb0491
100 events/frame ->    474 bytes  sha=941a0fcc565674cb

  字节流完全相同: False
  共同前缀: 6 bytes   (= zstd 的 4 字节魔数 + 帧头)
```

即：**逻辑内容相同，压缩后字节流完全不同，共同前缀只有帧头**。

因此：

| 场景 | 内容寻址去重是否有效 | 说明 |
|---|---|---|
| 同机第 2 次…第 N 次同步 | ✅ **有效** | 水位线保证只读新增字节，旧分块不重传（实测复用率 74.5%） |
| 重试 / 断点续传 | ✅ **有效** | 同一字节流重推，块 id 相同 |
| A 机与 B 机**各自独立产生**的会话 | ❌ **无效** | 字节流本质不同，块 id 必然不同 |

> **ADR-11**：**不要**在文档、UI 或实现里承诺"跨机器靠内容寻址省流量"。
> 跨机传输量的优化手段是**块大小选择**（合并小帧、控制对象数量），
> **不是**"期望跨机命中"。

> ⚠️ **术语必须分清，否则实现会被误判违规**：
> - **完整性校验**（允许且必需）：比对「manifest 声明的块 digest」与「实际收到的块字节」。
>   这证明**传输没坏**，与跨机是否命中无关。`transport.js` 就做了这一层，**不违反 ADR-11**。
> - **跨机去重期望**（禁止）：假设「B 机独立产生的块」会与「A 机的块」hash 相同从而省传输。
>   这个假设不成立。
>
> 一句话：**digest 用来证明"没坏"，不能用来期待"命中"。**

**由此推出的一条实现约束（很重要）**：

> **pull 侧的"内容是否正确"必须由逻辑层校验判定**：
> 解压 → 逐帧 → `seq` 连续 → 事件数与声明一致。
> **不能把"块 digest 与本地同名块不一致"当作分叉或异常的依据**——
> 那个比较只对"本次传输的完整性"有意义，对"跨机内容是否同一段对话"无意义。
> 若混淆两者，跨机同步会 100% 失败（因为跨机字节流本来就不该相同）。

### 5.7 CDC（内容定义分块）：为什么 MVP 不用它

MVP 用**固定帧数窗口**切块。不用 CDC 的**真实理由**不是"追加时窗口会漂移"——
那个理由不成立：在 append-only 下前面的字节永远不变，固定窗口工作完全正常（已实测）。

CDC 的真实价值是**抗插入 / 重排**，实测：

```
中间插入 1 个事件：
  固定窗口 64KB     复用 0/2 块，需新传 100%（全废）
  帧边界 CDC        复用 28/58 块，需新传 50.4%
```

> **ADR-12**：MVP 用固定帧数窗口（追加场景足够）。CDC 作为**为将来格式迁移 /
> 历史修复买的鲁棒性保险**预留接口，不在 MVP 实现。
> 论证请写成"防未来"，不要写成"解决追加漂移"——后者是伪问题。

---

## 6. 锚点 commit

### 6.1 记录什么、何时记录

**每次上行**采集并写入 manifest：

```json
{
  "sessionId": "session-<uuid>",
  "syncedThroughSeq": 240,
  "syncedByteLen": 553880,
  "anchor": {
    "headCommit": "<40-hex sha>",
    "branch": "feature-x",
    "worktree": "<repo>-wt-feat",
    "subPath": "src/server",
    "dirtyCount": 3,
    "capturedAt": 1793867121000
  }
}
```

**为什么是"每次上行"而不是"会话开始时"**：会话是长的，用户可能在一个会话里 commit 了
10 次。记录"会话开始时"的 commit 会严重过时；记录"最后一次上行时"的 commit 才能表达
"**这段对话谈的是这个代码状态**"。每次上行追加，历史锚点保留成序列，可追溯。

### 6.2 存在哪：**同步 ref 里的 manifest**

> **ADR-5**：锚点存 `refs/dsh-sessions/v1` 的 `manifest.json`。

否决另两个候选的具体理由：

- **不写 `~/.dsh/storages/workspace.json`** —— 实测它是 DSH 的私有状态：

  ```
  top-level keys: ['unit', 'global', 'tables']
    unit:   {name:'workspace', version:2}
    global: {initialized, defaultWorkspaceId, workspaceIds[], archivedSessionIds[], pinnedSessionIds[]}
    tables: {workspaces: {<id>: {path,title,sessionIds[],createdAt,updatedAt}}}
  ```

  它是**带 version 的、DSH 自己会迁移的状态文件**。我们写它 = 和 DSH 抢写权，
  且它一变我们的数据就丢。**只读，绝不写。**

  顺带一个实测发现（实现必须知道）：`archivedSessionIds` 用的是 **`session-<uuid>`
  前缀形态**，且归档会话**会从 workspace 的 `sessionIds` 里移除**（实测：45 个
  workspace 会话 vs 18 个 archived，交集为 **0**）。
  所以**归档会话只能从 `archivedSessionIds` 找到**——下行时若只扫
  `tables.workspaces[].sessionIds`，会漏掉全部归档会话。

- **不在会话目录旁放 sidecar**（如 `.anchor.json`）—— 往用户的 `~/.dsh/sessions/` 里塞
  DSH 不认识的文件，属于污染用户数据目录；而且它本地有效、跨机还得另外同步，
  等于引入**第三份真相**，三份真相必然漂移。

**放 manifest 的三个好处**：锚点天然随包走；天然有 git 历史可追溯"谁在哪个 commit 说了什么"；
天然进入冲突检测流程，不需要额外协调机制。

### 6.3 "这个会话基于旧 commit"怎么提示

下行时比较 `manifest.anchor.headCommit` 与当前 `HEAD`：

| 情形 | 判定方式 | 提示 |
|---|---|---|
| 锚点是 HEAD 祖先，落后 N 个提交 | `git rev-list --count <anchor>..HEAD` | 「此会话记录于 **N 个提交之前**（`<short-sha>`）」 |
| 正好是 HEAD | 相等 | 不提示 |
| 锚点**不是** HEAD 祖先（rebase / 强推过） | `git merge-base --is-ancestor` 失败 | ⚠️「锚点已不在当前分支历史中；代码可能已大幅变动，请核对」 |
| 本地没有该 commit | `git cat-file -e <sha>` 失败 | 「未找到锚点提交，请先 `git fetch`」 |

**只在 UI 提示，绝不阻断**：会话内容本身仍然有效，用户可能就是想"接着旧代码状态聊"。

---

## 7. 冲突语义：绝不静默覆盖

### 7.1 核心不变量

> **任何情况下都不同时满足以下三条：覆盖本地内容 + 不告知用户 + 不可撤销。**
> 冲突时唯一允许的行为是：**保留双方、明确报告、由人决定**。

### 7.2 下行写入的判定表

设本地会话 `nextSeq = N`（本地已有 seq `0..N-1`），远端包 first seq = `F`。

| 条件 | 判定 | 动作 |
|---|---|---|
| 本地无此会话 | 新建 | 校验后写入，标记来源机器与时间 |
| `F == N` | 本机落后，可追加 | **先备份** → 追加写入 |
| `F < N` 且远端 last seq `< N` | 本机领先 | 跳过，报告中列出 |
| `F < N` 且远端 last seq `>= N` | **分叉** | 见 §7.4 |
| `F > N` | **缺口**（包不完整或本机丢失） | **拒绝**，绝不写入；提示重新拉取 |
| 本地会话 LIVE（flock 探测） | 正在使用 | **拒绝写入**，排队到会话关闭后应用 |

这是 DSH 自己的 append 契约（first seq 必须等于 stored next-seq，gap 直接拒绝）的直接复用。
换句话说，我们不是发明规则，是**站在 DSH 的不变量上**。

### 7.3 为什么是"追加"而不是"整文件替换"

- append-only 是 DSH 的契约；**整文件重写会破坏崩溃安全性**（写到一半崩溃 = 会话全毁）。
- 追加让"已同步过的内容"物理上不可能被改动，天然满足"不覆盖"。
- 崩溃恢复简单：torn tail 丢弃即可（见 session-format §3.3）。

### 7.4 分叉的具体处理（同 session-id 不同内容）

最需要明确的场景。判据：**同 session-id、`F < N`、且共同前缀的内容 hash 不一致**。

处理：**双份保留，原会话物理上不动。**

```
原会话：  session-<uuid>/                      ← 一个字节都不改
远端分叉：session-<uuid>--from-<host>-<ts>/     ← 另存为独立会话
         其 header 追加来源标注：
         {..."isForkOf":"session-<uuid>",
            "forkOrigin":{"host":"<host-label>","syncId":"<id>","at":<ts>}}
```

用户得到一个**可读报告**，而不是被覆盖的会话：

```
⚠️ 会话分叉：session-<uuid> 在两台机器上都产生了新内容
  本机   ：已到 seq 512（最后修改 <time>）
  远端   ：已到 seq 487，来自 <host-b>（<time>）
  两台在 seq 240 之后内容不同，无法自动合并。
  ✅ 已保留两份：
     · 原会话（未改动）：session-<uuid>
     · 远端版本（另存）：session-<uuid>--from-<host-b>-<ts>
  请手动对比后保留你需要的那份。
```

> **ADR-6**：分叉**永不自动合并**。自动合并两个走了不同历史的对话流，
> 等于伪造一段从未发生过的对话——对"AI 会话"这种内容，比丢数据更危险
> （用户会以为 AI 真的说过那些话）。

### 7.5 上行要不要考虑冲突

上行是"把本机新增推到远端"，天然会冲突（两端都 push 同名 ref）。
处理：**`git push` 非 fast-forward 时拒绝并 fetch 重算**，绝不 `--force`。

> **ADR-7**：**任何路径都不允许对 `refs/dsh-sessions/*` 使用 `--force`。**
> 冲突时重新 fetch、重算本次要写的分块（分块是内容寻址的，重算很便宜），再重试。

### 7.6 端到端不变式（供测试）

1. 下行前**必须**对将被修改的会话目录做快照（`cp -R` 到备份区），失败可还原。
2. 任何写入前完成全部校验（解码 / 连续性 / 路径安全 / 会话存在性）。
3. 分叉场景下：原会话目录的 **mtime 与内容 hash 必须保持不变** —— 可断言。
4. 同一包重复下行 = 幂等（第二次应全部走"已是最新"）。

---

## 8. 与 dsh-remote 的关系

### 8.1 结论

> **复用它的"UX 心智"，不复用它的实现。零机器配置；`~/.ssh/config` 不参与所有权竞争。**

用户明确说了"参考 remote 方式配置好机器"。我们采纳的是**意图**（把 A/B 两台机器配好、
让同步能跑起来），而不是它的**机制**（写 ssh config + 机器注册表）。

### 8.2 为什么不能复用它的机器配置（有具体的锁死机制）

dsh-remote 的 `hasUnmanagedConflict()` 判定：某 `Host` 行上方**最近的非空行**
是不是**它自己的**标记 `# dsh-remote: managed`。只认自己的标记。

如果我们也去 `~/.ssh/config` 写自己标记的受管块：

1. 用户用 dsh-remote 加了机器 → 出现 `# dsh-remote: managed` + `Host X`
2. 用户用我们的插件加同一台机器 → 我们看这块标记不是我们的 → 判定"用户手写块"→ **拒绝**
3. 反过来 dsh-remote 看我们的块，同样判定"用户手写"→ **用户此后无法再用 dsh-remote 更新这台机器**

**第一个写入受管块的插件事实上独占了该文件**，而且双方都不报"另一个插件占着"，
只报"用户手写配置已存在，不覆盖"——用户会完全摸不着头脑。

> **ADR-8**：`~/.ssh/config` 的所有权不可共享，本插件**默认不参与所有权竞争**。

### 8.3 为什么我们根本不需要它

dsh-remote 要写 ssh config，是因为它要 SSH 到**任意**机器跑命令，必须有地方存
host/user/port/key。而**我们只需要到达一个 git remote，这个地址已经在仓库的
`.git/config` 里了**。认证直接沿用用户已有的 git 配置（keychain / SSH agent /
credential helper）——与 `dsh-settings-sync` 的定位一致。

| | dsh-remote | 本插件 |
|---|---|---|
| 目标 | 任意机器跑命令 | 到达**一个** git remote |
| 需要机器一等公民 | 是 | **否** |
| 需要存凭据 | 是（故有 `sanitizeMachine()`） | **否**（我们没有可泄露的东西） |
| 写 `~/.ssh/config` | 是（受管块） | **默认不写** |

### 8.4 那"配好机器"到底配什么

答：**什么都不用配。** 只要仓库能 `git push`，它就能同步。用户只需在两端各装一次插件，
在每个仓库上点一次"启用同步"。这就是"参考 remote 方式配置好机器"最省力的实现——
把配置量降到零。

### 8.5 逃生舱（默认关闭，UI 收在"高级"里）

唯一允许写 `~/.ssh/config` 的场景：用户**显式新建一台 ssh 配置里还不存在的机器**。此时必须：

- 用本插件独有标记 `# dsh-repo-session-sync: managed`
- **严格不碰任何无本标记的同名 Host 块**（撞上就 conflict，原文一字不改）
- 只在用户显式操作时触发，不进主流程

保留它是因为没有逃生舱将来要改架构；但它**不是主路径**。

### 8.6 只读用途

`~/.ssh/config` 我们**只读**，且只用于**诊断与文案**：

- 枚举候选主机 → 只读文件抓 `Host` 行，过滤通配符
- 解析单个别名 → `ssh -G <alias>`（不建连接，`Include` / `Match` 天然正确）
- **白名单裁剪**：只取 `hostname` / `user` / `port` / `proxyjump`；
  **`identityfile` 一律不返回、不进日志、不进 UI**（私钥路径属本机隐私）

---

## 9. 安全边界

### 9.1 凭据

- **不读取、不存储、不传输任何凭据。** 认证完全交给用户已有的 git 配置。
- remote URL 归一化时**主动剥离** `user:pass@`（实测：`https://user:token@host/o/r.git`
  → `host/o/r`），确保凭据不会因"记录一下 remote"而落盘。
- 诊断信息输出 remote URL 前，先过同一个剥离函数。

### 9.2 路径穿越

远端包里的所有路径都是**不可信输入**。规则：

1. `session-id` 必须匹配 `^(session-)?<uuid>` 形态，且**经编码后仍为单段**
   （不含 `/`、`\`、`..`）。不匹配直接拒绝。
2. 任何从 manifest 读到的路径，都经 `resolveInside(root, p)` 校验，确保
   `path.resolve` 后仍在目标根目录内。
3. 不使用远端提供的"目标文件名"直接拼路径；**本地路径一律由本地生成**。
4. 大小限制：单块、单会话、总包大小都有上限，防压缩炸弹与磁盘打爆。

### 9.3 远端内容视为不可信

- 文档里的**所有内容**都经过与本地文件相同的解码/校验路径，不走捷径。
- 加密分块**验 tag 失败即拒绝**（AES-GCM 自带认证；实测篡改会被检测到）。
- manifest 是数据结构，**不是指令**：绝不执行 manifest 里的任何字符串
  （例如不把 `worktree` 字段当路径去 `cd`）。
- 锚点 commit 里的 sha 只用于 `git` 只读查询，不做拼接执行。

### 9.4 仓库可见性：public = 拒绝

会话日志是**明文对话**（zstd 只是压缩）。推到公开仓库 = 公开泄露整段对话，
包括用户粘进对话里的任何内容。

> **ADR-9**：**public 远端默认拒绝启用同步**，且**每次上行前重校验**
> （防"今天私有、明天转公开"）。

三态策略：

| 可见性 | 行为 |
|---|---|
| `private` | 放行 |
| `public` | **拒绝**，必须逐字输入仓库全名才能强制覆盖 |
| `unknown`（无 gh / 无网 / 非 GitHub） | **不默认放行**，需显式确认 |

判定优先级：`gh repo view --json visibility` → 无认证 `api.github.com`
（404 视为私有/不存在）。全链路失败 → `unknown`，**"查不到"绝不等于"安全"**。

#### 9.4.1 重校验要判「偏离度」，不是判「是不是 public」

「每次上行前重校验」有一个容易踩的坑：

- ❌ **错误做法**：每次上行都判「当前是不是 `public`」，是就阻断。
  后果：用户对某个 public 仓库做了知情确认后，**每次上行仍被拦**——
  确认变得毫无意义，用户会干脆关掉整个插件。
- ✅ **正确做法**：比对「**本次判定** vs **用户已确认过的判定**」的偏离度。

| 上次确认 | 本次判定 | 行为 |
|---|---|---|
| `private` | `private` | 放行 |
| `private` | `public` | ⚠️ **中止** + 重新要求确认（防"今天私有、明天转公开"） |
| `public`（已逐字确认） | `public` | ✅ 放行（偏离度为零，不重复骚扰） |
| `unknown`（已确认） | `unknown` | ✅ 放行 |
| 任意 | 任意、但偏离已确认值 | ⚠️ 中止并要求重新确认 |

> **ADR-9 补充**：重校验的目的是**发现可见性变化**，不是**每次重新制造摩擦**。
> 存储的是「用户确认时的那个判定」，比较的是**当前判定与它的差异**。
> 实现见 `src/repo-visibility.js` 的 `checkRepoVisibility()` + 偏离度判定一节。

### 9.5 端到端加密（默认开，**随机 nonce 即可**）

**问题**：即使拦住 public，用户仍可能推到一个"以为私有但共享给了队友"的仓库，
或误 push 到 fork。加密把后果从"泄露明文对话"降级为"泄露密文"。

#### 9.5.1 结论：之前担心的"加密 vs 去重"矛盾**不存在**

本设计的早期版本担心：随机 nonce 会让相同明文产生不同密文 → 内容寻址去重失效 →
回到 §5.2 的 10 倍膨胀，因此建议用收敛加密（convergent encryption，确定性 nonce）。

**这个担心基于一个后来被推翻的前提。** §5.6 已实测证明**跨机去重本来就不成立**，
于是"加密损失跨机去重"这件事的代价是 **0**。更关键的是，**同机去重的收益也不依赖
确定性密文**：

- **同机多次同步**：水位线保证**只读新增字节**，旧分块**根本不会被重新加密**。
  加密次数与 nonce 策略无关。
- **重试 / 断点续传**：幂等性来自**块 id（明文的 SHA-256 内容地址）**，不是密文。
  实测：

```
=== 随机 nonce + 内容地址去重的重试幂等性 ===
  push 1 skipped: false
  push 2 skipped: true   (没有写第二个对象)
  push 3 skipped: true
  objects actually written: 1   (expected 1)
  => 幂等性来自内容 hash，不是确定性密文
```

> **ADR-10（已修订）**：**默认开启端到端加密，使用随机 nonce（AES-256-GCM）。**
> 不做收敛加密。
> 代价为零，收益是**消除收敛加密的两类已知弱点**：
> (a) 相同明文→相同密文的**确认攻击**（confirmation attack）；
> (b) 确定性 nonce 的**跨块 nonce 复用风险**——一旦同一 key 下出现 nonce 冲突，
> AES-GCM 会灾难性地失效。

#### 9.5.2 方案

```
key    = KDF(用户口令, salt=repoKey, 强 KDF)        # 32 字节
nonce  = randomBytes(12)                            # 随机，随块存储
blob   = AES-256-GCM(key, nonce, plaintext, AAD="dsh-repo-session-sync/v1")
块 id  = SHA256(plaintext)                          # 内容地址（明文 hash，不是密文 hash）
```

- **块 id 用明文 hash**：这样重试时能在"我是否已推送过这块"上做幂等判断，
  而密文本身每次都可以不同。
- **明文 hash 不泄露内容**：SHA-256 是单向的；且它只暴露"两块明文是否相同"，
  而 §5.6 已证明跨机明文块本来就几乎不同，这个信息量接近 0。
- AAD 绑定协议版本，防止跨协议重放。

#### 9.5.3 密钥从哪来、跨机怎么共享

- 密钥由**用户口令 KDF 派生**（salt 含 `repoKey`，故不同仓库不同钥），
  不生成、不托管、不上传、**不进 git**。
- 本机可缓存到操作系统钥匙串（与 git 凭据同等对待）。
- 跨机共享：B 机首次启用时输入**同一口令**即可解密。
- **口令丢失 = 数据不可恢复。** 这是刻意的取舍：我们不持有任何可用于解密的东西。
- `repoKey` 进 KDF salt 意味着**换仓库要重新输入口令**，这是有意的隔离。

> **ADR-10（密钥部分）**：我们不托管密钥。提供"导出恢复码"作为可选的用户自救手段，
> 但**默认不提示**（避免用户以为我们替他保管了密钥）。

#### 9.5.4 关闭加密

提供开关，但**关闭时必须明确警告**："会话内容将以明文推送到远端仓库"。
关闭后其余流程完全不变（分块、水位线、冲突语义都不受影响）。

#### 9.5.5 加密**不能**替代的事

加密只保护"传输通道与远端存储"。它**不解决**：
- 块大小、会话数量、时间戳等**元数据**仍然可见（manifest 建议也加密，见下）；
- 用户机器被入侵后，本机明文仍然可读。

> **补充决定**：`manifest.json` **也加密**（作为单个 blob 提交），
> 只保留一个明文的最小索引（含 `sessionId` 的 hash、块数、总大小），
> 供"不解密也能看到有哪些会话"的粗粒度展示与冲突检测使用。

---

## 10. 决策摘要（ADR 索引）

| ID | 决策 | 关键理由 |
|---|---|---|
| ADR-1 | 绑定键 = 归一化 remote URL，**不含分支** | 分支切换不应让历史会话失配；cwd 里本就没有分支信息 |
| ADR-2 | URL 转小写为默认；非 GitHub/GitLab 主机提示风险 | 大小写敏感的自建服务可能把两仓库合并 |
| ADR-3 | 水位线 = `(syncedThroughSeq, syncedByteLen)` 双层 | seq 保正确性，offset 保性能；不一致以 seq 为准 |
| ADR-4 | 传输走仓库内 `refs/dsh-sessions/v1`，plumbing 写入，永不 checkout | 零配置、复用 git 认证、不污染工作区 |
| ADR-5 | 锚点存同步 ref 的 manifest | 随包走、有 git 历史；不抢 DSH 的 workspace.json |
| ADR-6 | 分叉绝不自动合并，双份保留 | 自动合并 = 伪造从未发生的对话 |
| ADR-7 | 永不 `--force` 推会话 ref | 防丢别人已同步的历史 |
| ADR-8 | 不参与 `~/.ssh/config` 所有权竞争；零机器配置 | 两插件写受管块会互相锁死 |
| ADR-9 | public 远端默认拒绝 + 每次上行重校验 | 会话是明文对话，推到公开仓库 = 泄露 |
| ADR-10 | 默认端到端加密，**随机 nonce**（不做收敛加密） | 跨机去重本就不成立（§5.6），故加密代价为 0；随机 nonce 消除确认攻击与 nonce 复用风险 |
| ADR-11 | **不承诺跨机内容寻址去重**；pull 校验不依赖块 hash | zstd 对批次敏感，跨机字节流必然不同（§5.6） |
| ADR-12 | MVP 用固定帧数窗口；CDC 作为抗插入的预留 | 固定窗口在 append-only 下工作正常；CDC 是防格式迁移的保险 |
| ADR-13 | 下行成功判据 = DSH 可见，不只看文件落盘 | 外部写入不被收养且会被 cwd 过滤（§11） |
| ADR-14 | attach 失败的回滚由引擎负责，新建可删/追加只可还原 | 混淆二者会删掉用户历史对话（§11.4） |

---

## 附录 A：验证脚本与命令

### A1：URL 归一化

```python
def norm(u):
    u = u.strip()
    u = re.sub(r'^[A-Za-z][A-Za-z0-9+.-]*://', '', u)      # 去 scheme
    u = re.sub(r'^[^@/]+@', '', u)                           # 去 user[:pass]@
    if re.match(r'^[^/]+:', u): u = u.replace(':', '/', 1)   # scp 形
    u = re.sub(r'/+', '/', u)
    u = re.sub(r'\.git$', '', u)
    u = re.sub(r'/+$', '', u)
    return u.lower()
```

### A2：膨胀对比

```bash
# 20 次增量提交，比较两种策略的 .git 体积
# A: 每次提交累积增长的整体文件   -> 210M
# B: 每次提交只新增一个不可变分块 -> 20M
```

### A3：ref 隔离性验证

```bash
git update-ref refs/dsh-sessions/v1 HEAD
git push origin refs/dsh-sessions/v1:refs/dsh-sessions/v1
git push --all --dry-run         # 不会推它
git push --mirror --dry-run      # 也不会
git gc --prune=now --aggressive  # ref 存活
git clone <remote> <new>         # 不带出；需显式 fetch
git fetch origin 'refs/dsh-sessions/v1:refs/dsh-sessions/v1'   # 取回
```

### A4：加密与去重

```javascript
const nonce = createHmac('sha256', NONCE_KEY)
  .update(createHash('sha256').update(plaintext).digest())
  .digest().subarray(0, 12)
// 相同明文 → 相同 nonce → 相同密文 → 去重成立，且 GCM 可检测篡改
```


---

## 11. 下行可见性闭环（写盘 ≠ DSH 可见）

**这是本设计里最容易做出"半截功能"的地方。** 前一版设计默认"文件写进
`~/.dsh/sessions/` 就等于同步完成"——**这个假设是错的**。

### 11.1 事实：绝大多数会话在 DSH 侧是不可见的

实测本机（只读）：

```
on disk        : 218
registered     : 45      ← workspace.json 里登记的
archived       : 20

registered & on-disk : 45
archived   & on-disk : 18
on-disk but NOT registered and NOT archived (ORPHANS): 164
```

**218 个会话文件里，只有 45 个被 `workspace.json` 登记，164 个是孤儿。**
这些孤儿文件在磁盘上完好，但 DSH 的 workspace 列表里看不到它们。*

> \* 大量孤儿的一个合理解释是它们多为 **subagent 子会话**（本机实测子会话约占 69%），
> 子会话本就不该出现在 workspace 列表里。但**这个解释是否成立，需要用 DSH 的
> 读取路径确认**，不能当作免检理由——因为 §11.2 的过滤机制对顶层会话同样生效。

### 11.2 机制：外部写入既不被收养，也会被过滤

来自 DSH 侧的两条约束（由 lead 从 asar 提取 `dsh-workspace` 源码后确认，
**本设计通过其结论，但标注为"待我方独立复核"**）：

1. **不会收养外部写入的会话**：`bootstrap()` 被 `if (!this.state.initialized)` 守卫，
   正常机器上永不再走；registry 的写入点只在 DSH 自己创建会话时触发。
   → **我们往 sessions 目录写文件，不会被自动登记。**
2. **cwd 不匹配的会话会被主动剔除**：有类似
   `canonical cwd '<x>' differs from workspace path '<y>'` 的过滤逻辑。

### 11.3 由此推出的四条硬要求

#### (1) cwd 重写是**必然必需**，且是安全要求

A 机的会话 header 里 `cwd = /Users/<a>/proj`，到了 B 机如果 B 的仓库在
`/Users/<b>/work/proj`，则：

- 不重写 → cwd 不匹配 → **100% 被过滤，会话不可见**；
- 而且即使可见也是**危险的**：DSH 会用 header.cwd 作为工作目录，
  在错误目录执行工具调用可能改错文件。

> **规则**：下行时必须把 `header.cwd` 重写为**本机该仓库的真实路径**。
> 重写只改首帧的 header 行（见 [`docs/session-format.md`](./session-format.md) §7 的
> 实测：改首帧后重新编码该帧、其余帧原样保留，可正常解码）。

**重写后必须重新计算块 id**：header 所在的首帧内容变了，其块 id 也随之变化。
这正是"cwd 重写会使跨机字节流不同"的一个具体来源，与 §5.6 的结论一致。

#### ⚠️ 已知取舍：cwd 重写会重编码整个日志（体积与块数上升）

有两种实现方式，代价不同：

| 方式 | 做法 | 实测（945 KB / 199 帧 / 443 行的真实会话） |
|---|---|---|
| A. **只改首帧** | 解出 header → 改 cwd → 只重编码首帧，其余帧**原样保留** | 945,433 B，199 帧（1.00x） |
| B. **全量重编码** | 解出全部事件 → 逐事件重压成帧 | 1,009,282 B，**443 帧**（1.10x） |

当前实现选了 **B**，理由是：输出**绝对符合 DSH 的规范形态**（header 独占首帧 +
每事件一帧），比"原样保留其余帧"更容易验证正确性，也避免复刻 DSH 的内部分批策略。

**这是可辩护的取舍，但必须记录它的两个代价**：

1. **体积约 +10%**。若 A→B→A 反复往返，每趟都会重编码一次，
   **需要在真实 E2E 中确认体积不会持续累积膨胀**（这是必须测的，不是假设）。
2. **帧数约 2.2 倍**。而每帧是独立 zstd 帧 → 按帧切块时**块数翻倍** → git object 数量翻倍。
   与 §5.2 的膨胀教训同源，**大仓库要关注对象数量**。

> **结论**：保留 B 的正确性优先，但在实现里**record 一个"是否已迁移过"的标记**，
> 避免对同一个会话反复重编码（已重编码且 cwd 已正确的会话，下行时可直接字节复制）。

#### (2) 登记策略：**不写 `workspace.json`**

§6.2 已定红线：`workspace.json` 是 DSH 私有状态（带 `version: 2` 与其自身的迁移逻辑），
我们只读不写。

**但这带来一个真实的功能缺口**：写进去的会话可能不出现在 DSH 的 workspace 列表里。

处理原则（**按顺序尝试，绝不冒险写私有状态**）：

| 优先级 | 手段 | 说明 |
|---|---|---|
| P0 | **通过 DSH 插件的公开接口登记** | 若 DSH 暴露了 "attach session to workspace" 之类的 host 服务/命令，优先用它——这是唯一"合法"的登记方式。**需 dev-core 在插件骨架阶段确认该接口是否存在。** |
| P1 | **让用户从 DSH 内部打开该会话** | 不依赖登记：同步完成后给出一个可点击入口 / 命令，由用户在 DSH 里主动打开一次，走 DSH 自己的登记路径。**这是 MVP 的兜底方案。** |
| ~~P2~~ | ~~只写文件 + 明确告知~~ | **已否决，不作为 MVP 交付**（见 ADR-13）。若 P0/P1 均不可行，属于**范围问题，必须上报**，而不是用 P2 交付一个「写盘不等于可见」的残缺方案。 |
| ❌ | 直接改 `workspace.json` | **禁止**。抢写权 + 版本迁移风险，且 DSH 可能持有内存态覆盖我们的写入。 |

> **ADR-13**：下行"完成"的判据**不是文件写完**，而是 **P0 或 P1 成功**。
> **P2（只写文件 + 告知）已被否决，不作为 MVP 交付**——它与「写盘不等于可见」这条
> 核心结论直接冲突，交付 P2 等于把本设计要解决的问题原样还给了用户。
> 若 P0/P1 均不可行，**必须上报为范围问题**，不得静默降级。
> 具体走哪条，由 dev-core 在确认 DSH 插件接口后填入本节的空白。

#### (3) 目标路径不存在 → **中止，不写入悬空会话**

若 B 机尚未 clone 该仓库（重写后的 cwd 指向的路径不存在）：

- **不要**用 A 机的原始路径写下会话（那会在 B 机产生一条指向不存在目录的会话，
  DSH 打开它会失败或落到错误目录）；
- **不要**用 B 机的"预期路径"硬写（路径可能永远不被创建）；
- **中止本次该会话的下行**，报告：
  「会话 `<id>` 需要仓库在 `<path>`，但该路径不存在。请先 clone 该仓库再重试。」

#### (4) 完成判定：能被 DSH 列出来

```
pull() 的成功标准 = 会话出现在 DSH 的可见集合中
                  （通过 P0 接口确认，或通过 DSH 自己的读取路径验证）
                  而不是"文件已落盘"
```

### 11.4 下行写入顺序（沿用 §7 的不变式）

1. 探测本地会话存在性与 LIVE 状态（flock）
2. 校验远端包（解码 / seq 连续 / 路径安全）
3. **重写 header.cwd** → 重算首帧块 id
4. 备份目标会话目录（若非新建）
5. 写入
6. **可见性登记（P0/P1）**
7. 回读验证：能否被列出

任一步失败 → 从备份还原，并报告失败原因（不静默）。

**回滚归属必须明确**（否则会出现悬空会话）：

| 失败点 | 谁负责回滚 | 回滚内容 |
|---|---|---|
| 步骤 1-4（校验/重写/备份） | 引擎 | 无需回滚（尚未写入） |
| 步骤 5（写入）失败 | 引擎 | 从备份还原被改的会话 |
| **步骤 6（attach）失败** | **引擎** | **删除"本次新建"的会话目录**；对"本次追加"的会话从备份还原 |

> **ADR-14**：`registry.ensureWorkspaceAndAttach()` 只**报告**失败（返回 `failed` 列表），
> **不自行删除文件**——因为它不知道自己写入了什么。
> **回滚由引擎负责**，且必须严格区分两种情形：
> - **本次新建**的会话 → 可以删除（它在本次操作前不存在）
> - **本次追加**的会话 → **只能从备份还原，绝不删除**（它含用户历史）
>
> 混淆这两者是致命的：删掉一个"本次追加过"的会话 = 删掉用户的历史对话。

### 11.5 待办（必须由实现阶段补齐的空格）

> ⚠️ 本节有**两处未定**，实现前必须确认，否则就是"半截功能"：
> 1. DSH 是否有公开的"登记会话到 workspace"接口（决定 P0 可行性）
> 2. DSH 读取会话列表时，是否真的会因 cwd 不匹配而过滤（决定第 (1) 条的严重性）
>
> 这两条**不由本设计猜测**。dev-core 确认后请回填本节，并同步给 qa 做 E2E 断言口径。

---

## 相关文档

- [`docs/session-format.md`](./session-format.md) — 存储格式、帧结构、水位线、并发安全
- 实现若发现本设计不可行，**先停下在群里报**，不要自行改设计。
