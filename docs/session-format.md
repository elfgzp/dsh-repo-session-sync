# DSH 会话存储格式

本文描述 DeepSeek Harness（下称 DSH）会话日志在磁盘上的真实格式，以及本插件读取它时
必须遵守的规则。**每一条结论都附有实测命令与真实输出片段**；凡不是实测得出的，都显式
标注了来源（官方源码 / 推理），请勿把不同来源的结论混用。

> **脱敏约定**：本文所有路径、用户名、会话 ID、仓库名均已替换为占位符。
> - `~` 代表当前用户家目录
> - `--Users-<you>-<proj>--` 代表 projectKey 编码后的目录名
> - `session-<uuid>` / `<uuid>` 代表真实 UUID 的位置
>
> 实测在真实的 `~/.dsh` 上**只读**进行；任何需要写入的实验都在 `cp -R` 到 `/tmp` 的副本上完成。

## 目录

1. [磁盘布局](#1-磁盘布局)
2. [projectKey：cwd 的不可逆编码](#2-projectkeycwd-的不可逆编码)
3. [物理编码：独立 zstd 帧的拼接](#3-物理编码独立-zstd-帧的拼接)
4. [逻辑结构：header + 事件流](#4-逻辑结构header--事件流)
5. [两个反直觉的行为（会导致 bug）](#5-两个反直觉的行为会导致-bug)
6. [读取规则（实现必须遵守）](#6-读取规则实现必须遵守)
7. [水位线：物理层与逻辑层并存](#7-水位线物理层与逻辑层并存)
8. [会话活跃状态与并发安全](#8-会话活跃状态与并发安全)
9. [附录：实测环境与完整证据](#9-附录实测环境与完整证据)

---

## 1. 磁盘布局

```
~/.dsh/sessions/
├── --Users-<you>-<proj-a>--/          # projectKey，由 cwd 编码而来
│   ├── session-<uuid-1>/              # 一个会话 = 一个目录
│   │   ├── session.v4.jsonl.zstd      # 当前代（v4）的压缩事件日志
│   │   └── session.lock               # 0 字节，flock(2) 咨询锁
│   └── <uuid-2>/                      # 注意：没有 session- 前缀，见下
│       └── session.v4.jsonl.zstd
└── _no-cwd/                           # 没有 cwd 的会话（如纯设置类会话）
    └── <uuid>/session.v4.jsonl.zstd
```

### 1.1 两种目录命名形态，且**不是**历史遗留

实测取样时点的约 218 个会话目录，发现两种形态并存，且与**会话语义**严格对应
（绝对数量随 DSH 运行变化，比例稳定）：

```bash
# 逐个读取每个会话首行的 header，与目录名对照
$ python3 - <<'PY'
# ...（完整脚本见附录 A1）
PY
  naming=sub (bare uuid)    origin=subagent   has_parent=True   n=151
  naming=session-<uuid>     origin=(none)     has_parent=False  n=67
```

- **`session-<uuid>`**：顶层会话（用户发起的），约 67 个。
- **裸 `<uuid>`**：**subagent 子会话**，约 151 个，**全部**带 `parentSession` 字段，
  且采样中 151/151 的 `parentSession` 都能解析到一个存在的 `session-<uuid>` 父会话目录
  （未解析到父级 = 0）。

进一步实测 `header.id` 与目录名的关系：

```
$ （见附录 A2）
  ('sub', 'id_bare',     'dir==id')  n=151
  ('top', 'id_has_prefix','dir==id') n=67

sample top-level : dir=session-<uuid-top>  id =session-<uuid-top>
sample subagent  : dir=<uuid-sub>         id =<uuid-sub>   parent=session-<uuid-parent>
```

> **结论（重要）**：`header.id` 与目录名**逐字符相等**，采样 218/218 全中。
> 不存在"id 去掉 `session-` 前缀才对得上目录名"这种规则。
> 实现者若假设"目录名 = session- + id"，会把 69%（151/218）的子会话全部漏掉。

### 1.2 为什么必须两种都处理

子会话约占本机语料的 **69%**（151/218）。任何"按仓库筛会话"的实现如果只认 `session-*`，
会静默丢掉三分之二的会话，而用户看到的症状是"有些对话没同步过去"——很难排查。

---

## 2. projectKey：cwd 的不可逆编码

### 2.1 权威编码规则（依据 DSH 官方实现）

```js
// 逐字符处理；这是权威算法（来自 DSH persistence 包的 projectKey 实现）
let readable = '', separatorRun = false
for (const ch of cwd) {
  if (ch === '/' || ch === '\\' || ch === ':') {
    if (!separatorRun) readable += '-'
    separatorRun = true                        // 连续分隔符只产出一个 '-'
  } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
    readable += ch                             // 安全字符原样保留
    separatorRun = false
  } else {
    readable += '~' + codePoint.toString(16).toUpperCase().padStart(4, '0')  // ~XXXX
    separatorRun = false
  }
}
projectKey = '--' + (readable.replace(/^-+/, '') || 'root').slice(0, 251) + '--'
```

`cwd` 为空或缺省时目录名为 `_no-cwd`。

**已实测的实例**（全是纯 ASCII 路径，两种算法结果一致，故仅能证明"安全字符原样保留"）：

```
cwd                                              实际目录名
/Users/<you>/.dsh/profiles/desktop               --Users-<you>-.dsh-profiles-desktop--
/Users/<you>/Documents/<proj-b>                  --Users-<you>-Documents-<proj-b>--
/Users/<you>/Work/<proj-c>                       --Users-<you>-Work-<proj-c>--
/Users/<you>/.dsh/gongfeng-mr/repos/o__r/x__y    --Users-<you>-.dsh-gongfeng-mr-repos-o__r-x__y--
...                                              ALL MATCH (7/7)
```

### 2.2 ⚠️ 一个必须记录的踩坑：样本全是纯 ASCII 时会得出错误规则

早期版本的本文档写的是简化规则：

```js
// ❌ 不完整 —— 只对纯 ASCII 且无特殊字符的路径成立
projectKey(cwd) = '--' + cwd.replace(/^\//, '').replaceAll('/', '-') + '--'
```

这条规则在本机 7 个 cwd 上也是 **7/7 全中**，因此看起来"已验证"。但它与权威实现
在以下输入上**分歧**（实测）：

```
cwd                        权威实现                        简化规则（错）
/Users/x/项目/repo          --Users-x-~9879~76EE-repo--     --Users-x-项目-repo--
/Users/x/my repo            --Users-x-my~0020repo--         --Users-x-my repo--
/Users/x/a~b                --Users-x-a~007Eb--             --Users-x-a~b--
/Users/x/a//b               --Users-x-a-b--                 --Users-x-a--b--
```

**教训（对本项目有普遍意义）**：本机全部路径恰好是 `[A-Za-z0-9._-]`，
于是"安全字符原样保留"这一条被样本证实，而"不安全字符怎么处理"这一条
**根本没被覆盖到**——用这样的样本去反推完整算法，必然把规则写窄。
任何"7/7 全中"的结论都要先问：**样本是否覆盖了算法的每个分支？**

因此：

- **权威实现以 DSH 源码为准**（本文档的 2.1 节）；
- 本机实测只能作为"该实现在此样本上行为一致"的佐证，**不能替代源码**；
- 中文/空格/`~`/连续分隔符等路径在实现里**必须有自己的测试用例**。

### 2.2b 不可逆的三重原因

**注意：不是"字符塌缩"**。`.`、`_`、`-` 都是原样保留的（实测见 2.1）。

真正的不可逆性来自三处：

1. **分隔符与字面 `-` 有歧义**：`/` 被改写成 `-`，于是"一个 `-`"到底是路径分隔符、
   还是目录名里本来就有的连字符，无法区分。
2. **`separatorRun` 合并**：连续分隔符折叠成一个 `-` → `/Users/a/b` 与 `/Users/a//b` 撞同一 key。
3. **截断**：`slice(0, 251)` → 超长路径被截断后，不同 cwd 可能撞车。

### 2.3 由此得到的硬规则

> **绝不要从目录名反解 cwd。** 按仓库筛选会话的唯一正确做法是：
> 遍历 `sessions/*/*/session.v4.jsonl.zstd` → 解出首行 header → 读 `header.cwd` → 用真实路径匹配。

---

## 3. 物理编码：独立 zstd 帧的拼接

### 3.1 它是一个"帧的容器"，不是一个 zstd 流

```bash
$ file session.v4.jsonl.zstd
Zstandard compressed data (v0.8+), Dictionary ID: None

$ zstd --list session.v4.jsonl.zstd
Frames  Skips  Compressed  Uncompressed  Ratio  Check  Filename
   260      0     739 KiB                        XXH64  session.v4.jsonl.zstd
```

**260 个帧**，帧与帧之间**没有任何分隔符**，每帧独立可解码、各带自己的 XXH64 校验。

用规范级解析器走一遍（逐帧读 frame header → block header → payload），可以精确验证
文件被帧完整覆盖、无残留字节：

```
file_size: 757118
frames_parsed: 260
err: None
bytes_covered: 757118  (residual: 0)
```

### 3.2 帧边界对齐整行 JSONL

这是**增量传输能按帧切块**的根本原因。逐帧解压并数换行：

```
frames: 260
lines_per_frame distribution: {1: 90, 2: 130, 3: 14, 4: 25, 9: 1}
error frames: 0
```

合计 `1×90 + 2×130 + 3×14 + 4×25 + 9×1 = 501` 行，与整文件解压的 501 行**完全一致**，
且**没有任何一帧在行中间断裂**。

> **规则**：一条 JSONL 事件**永不跨帧**。因此"按帧边界切块"对事件流是无损的。
> 但**一帧可以包含多个事件**（本样本最多 9 个），所以**帧序号 ≠ seq**。

### 3.3 torn tail 是正常状态

进程崩溃时最后一帧可能只写了一半。正确的处理是：顺序推进扫帧，遇到文件提前结束
即视为 `tornStart`，**丢弃该尾部**，而不是报"文件损坏"。

只有"完整帧的校验/解压失败"才算真损坏——已有整帧的边界足以判断帧是否完整。

---

## 4. 逻辑结构：header + 事件流

### 4.1 首行是 header（没有 `seq`）

```json
{"type":"session","version":4,"id":"session-<uuid>","createdAt":1793845475313,
 "cwd":"/Users/<you>/Work/<proj>","isSeeded":false,"delegationDepth":0,"agentPreset":"cordis"}
```

可选字段：`parentSession`（子会话才有）、`origin:"subagent"`。

### 4.2 其余行是事件（有 `seq`）

```json
{"type":"tool/call","seq":20,"time":1793845475323,"data":{...}}
```

实测 501 行中：header 1 行、带 `seq` 的事件 500 行，`seq` 范围 **0–499**，
**严格 +1、无缺口、无重复**（gaps/dups = 0）。

事件类型分布（真实样本）：

```
step/start: 83      assistant/message: 83    step/end: 83
tool/call: 82       tool/result: 82          job/registered: 32
job/settled: 32     user/message: 6          todo/write: 3
agent/inbox/spliced: 2   request/header: 2   session: 1
（其余 10 种各 1）
```

### 4.3 各类事件的实际体积（决定同步体积与加密收益）

对同一真实会话按类型统计 JSON 编码后的字节数：

```
type                              bytes   share     n
tool/result                   1,623,740   50.7%    82
request/header                  783,288   24.4%     2
assistant/message               541,332   16.9%    83
user/message                     88,475    2.8%     6
tool/call                        68,859    2.1%    82
...
TOTAL                         3,204,880
```

两个关键观察：

- **`tool/result` 占一半以上**，是命令输出/文件内容，**敏感信息最可能出现在这里**。
- **`request/header` 只占 2 条事件却占 24.4%**（每条约 330KB）。实测其内容是
  完整的工具定义与系统提示词（`{"config":{...},"tools":[...]}`），
  **是同构的模板文本、不含对话内容**，也因此 compress 得极好。

---

## 5. 两个反直觉的行为（会导致 bug）

### 5.1 ⚠️ 用 one-shot API 解整个文件 = 静默丢 99.99% 数据

Node 的 `zlib.zstdDecompressSync(整个文件 buffer)` **只解第一帧就返回，不报错、不抛异常**。

```javascript
// ❌ 错误写法：静默截断
import { zstdDecompressSync } from 'node:zlib'
const lines = zstdDecompressSync(readFileSync(f))   // 只有第一帧！
```

实测复现（同一文件）：

```
$ node oneshot.mjs session.v4.jsonl.zstd
compressed: 757118 decompressed_one_shot: 273

$ zstd -dc session.v4.jsonl.zstd | wc -c
  3080613
```

**只解出 273 字节，真值是 3,080,613 字节。**

致命之处在于：**第一帧恰好就是 header 行，而 header 是合法 JSON**。于是
"能解析出会话头"的断言会**通过**，测试假绿，而对话内容一条都没读到。

> **硬规则 1**：禁止对整文件调用 `zstdDecompressSync`。**必须逐帧解码。**

### 5.2 ⚠️ 不能靠"搜索魔数"切帧

zstd 帧以魔数 `28 b5 2f fd` 开头，很自然会想"全文件搜这个四字节来切帧"。
本机语料上这个做法**看起来能用**，但这正是它危险的地方：

```bash
# 全部 218 个真实会话文件：严格顺序扫帧 vs 全文件搜魔数
$ python3 fpcheck.py ~/.dsh/sessions
files scanned: 218
total real frames:            257,200
total raw-magic candidates:   257,200
total FALSE POSITIVES:        0   （采样快照；另一轮复跑为 257,485 / 257,485 / 0）
```

**实测假阳性为 0。** 也就是说在本机语料上，搜魔数确实切得对。

但这**仍然不能作为实现依据**，理由不是统计而是契约：

1. zstd 规范**不保证**压缩块内部不出现该字节序列。这是"恰好没出现"，不是"保证不出现"。
   换压缩器版本、换参数、换数据内容都可能改变。
2. 用的是"观测到的分布"当"解析契约"，属于埋雷：本机测试永远绿，
   用户机器上偶发把帧切成两半，表现为 JSON 解析错误或静默丢事件。

```bash
# 规范级顺序解析器（推荐做法）：单遍 O(n)，零解压、零试错
# 读 frame header descriptor → 算 header 长度 → 循环读 block header 跳过 payload → 最后跳 checksum
$ python3 zframes.py session.v4.jsonl.zstd
frames_parsed: 260
err: None
bytes_covered: 757118  (residual: 0)
```

> **硬规则 2**：用**顺序推进**解析帧（按帧头 + 块头长度精确跳过），不要全文件搜魔数。
> 顺带说明：既然顺序解析器已能精确得到帧边界，"候选起点 → 试解压 → 成功才认"这种
> 更贵的做法在正常路径上并不需要；试解压只在**校验**阶段（确认内容可读）才用。

---

## 6. 读取规则（实现必须遵守）

按重要性排序：

| # | 规则 | 违反后果 |
|---|---|---|
| 1 | 逐帧解码，禁止 one-shot 解整文件 | 静默丢 99.99% 数据，测试假绿 |
| 2 | 顺序推进解析帧，不搜魔数切分 | 换环境后偶发切碎帧 |
| 3 | 读 `header.cwd` 判定仓库，不反解目录名 | 跨机/跨路径永远匹配不上 |
| 4 | 两种目录名形态都要扫（`session-<uuid>` 与裸 `<uuid>`） | 漏掉 69% 的子会话 |
| 5 | 一帧可含多个事件，帧序号 ≠ seq | 水位线错位 |
| 6 | torn tail 静默丢弃，不报错 | 把正常崩溃态误报成数据损坏 |
| 7 | 以 `seq` 判定"是否有新事件" | 重放/漏传 |
| 8 | 对 `session.lock` 做 flock 探测判断活跃（见 §8） | 向正在写入的会话追加导致冲突 |

### 6.1 能力探测与降级

`zlib.zstdDecompressSync` 并非所有 Node 都有。本机实测：

| Node | `zlib.zstdDecompressSync` |
|---|---|
| v20.20.1（nvm 默认） | **不存在**（`undefined`） |
| v25.6.1（homebrew） | 存在 |
| Electron 内置 v24.21 | 存在 |

> **规则**：运行时探测能力，不存在时降级到纯 JS 扫帧 + 外部 `zstd` CLI，
> 或直接报可读错误。**不要假设 API 一定在**，否则 CI（跑 v20）与用户机器行为不一致。

---

## 7. 水位线：物理层与逻辑层并存

**这不是二选一。** 两层解决不同的问题，缺一不可。

| 层 | 用什么 | 职责 | 为什么必须是它 |
|---|---|---|---|
| **物理层** | 字节偏移 | 增量**传输**截取：`buf.subarray(watermarkByte)` | 传输的是压缩字节；只有偏移能避免重传历史 |
| **逻辑层** | `seq` | **完整性校验**、gap 检测、幂等重放、冲突判定 | 偏移无法判断"事件是否齐全"，seq 可以 |

### 7.1 物理层：字节偏移安全性的实测依据

对**正在被写入**的活跃会话反复采样，验证 append-only：

```
=== prefix check: is snapA a byte-prefix of snapB? ===
lenA 235780 lenB 236527
A is prefix of B: True
```

同时在写入期间采样（inode 不变）：

```
inode=1143237939 size=248633 → 262604 → 262698
frame0_sha=<sha>（全程恒定）
```

即：**文件只在尾部增长，历史字节永不改写**。因此"已同步到第 N 字节"是安全水位线，
增量部分 `subarray(watermark)` 天然从帧边界开始（因为写入以整帧为单位）。

### 7.2 逻辑层：seq 是 DSH 自己的不变量

DSH 的 append 契约要求新事件的 first seq 必须等于已存的 next-seq，**gap 直接拒绝**。
我们复用这个不变量，等于免费获得正确性校验：

- `nextSeq > syncedThroughSeq` → 有新事件
- 远端包 first seq == 本地 next-seq → 可追加
- 远端包 first seq > 本地 next-seq → **有缺口，包不完整，拒绝**
- 远端包 first seq < 本地 next-seq → 本地领先，跳过

### 7.3 两者如何配合

```
水位线记录（manifest 内）：{ syncedThroughSeq: 240, syncedByteLen: 553880 }
上行：
  1. 读 lastSyncedByteLen，取 buf.subarray(byteLen) → 即新增帧（物理层）
  2. 解析这些帧，确认 first seq == syncedThroughSeq（逻辑层校验）
  3. 不匹配 → 水位线失效，回退到"用 seq 二分定位"，绝不盲发
```

> **硬规则 3**：字节偏移用于**传输裁剪**，`seq` 用于**正确性校验**。
> **永远不要只信偏移**——如果偏移与 seq 不一致（例如文件被替换、日志代际升级），
> 必须以 seq 为准重新定位。

---

## 8. 会话活跃状态与并发安全

`session.lock` 是一个 0 字节文件，DSH 对它持有 `flock`。这给了我们一个**可靠的
"会话是否正在运行"信号**，且**只需只读探测**。

实测（对正在运行当前对话的会话 vs 6 个历史会话）：

```
probe1: LIVE      # 当前对话所在会话
probe2: LIVE      # 15 秒后再次探测，仍 LIVE，且文件仍在增长

<uuid-1>       lock_age=  66min  IDLE
<uuid-2>       lock_age=  68min  IDLE
<uuid-3>       lock_age=  70min  IDLE
session-<uuid-3>  lock_age=1605min  IDLE
session-<uuid-4>  lock_age=2889min  IDLE
session-<uuid-5>  lock_age=2959min  IDLE
```

探测方法（非阻塞、不修改文件、不阻塞 DSH）：

```bash
# 能拿到 LOCK_EX|LOCK_NB 说明没人持有 → 会话空闲
# 拿不到（EWOULDBLOCK）说明 DSH 正持有 → 会话活跃
perl -e 'use Fcntl qw(:flock);
         open(my $fh,"+<",$ARGV[0]) or exit 2;
         print(flock($fh, LOCK_EX|LOCK_NB) ? "IDLE" : "LIVE");' session.lock
```

> **并发规则**：
> - **上行（读）**：活跃会话也可安全读——append-only 保证已写部分稳定；
>   只需在读取前后各取一次 size，若在中间变化则重读该尾帧。
> - **下行（写）**：**必须拒绝写入 LIVE 的会话**。DSH 正持有该会话并缓存了自己的
>   next-seq，外部追加会让它的内存状态与磁盘不一致。
>   LIVE 时改为"排队到该会话关闭后应用"，或写入独立会话（见 design.md 冲突语义）。

---

## 9. 附录：实测环境与完整证据

### 9.1 环境

```
macOS，zstd CLI 1.5.7
node: v25.6.1（homebrew）/ v20.20.1（nvm，无 zstd API）
语料: 约 218 个真实会话文件（采样时点快照，随 DSH 运行持续增长），
      共约 516 MiB，约 25.7 万个 zstd 帧
```

规模分布（用于说明为什么必须做增量、也说明为什么附件默认不同步）：

```
total sessions: 218   total bytes: 541,547,491 (516.5 MiB)
kinds: {'top': 67, 'subagent': 151}

per projectKey (count, MiB):
  --Users-<you>-Documents-<proj-b>--      n= 77    202.3 MiB
  --Users-<you>-Work-<proj-c>--           n= 75    157.3 MiB
  --Users-<you>-Github-<proj-d>--         n= 35     95.3 MiB
  --Users-<you>-Work-<proj-e>--           n= 10     57.2 MiB
  --Users-<you>-.dsh-profiles-desktop--   n=  9      2.7 MiB
  _no-cwd                                 n=  7      0.2 MiB
  （另有 2 个小目录）
distinct cwd values: 8
```

### 9.2 A1：目录形态与 header 的关系

```python
# 读取每个会话首帧 → 解析 header → 与目录名对照
import os, json, struct, subprocess
# …（完整实现见仓库内验证脚本）
# 输出：
#   naming=bare      origin=subagent   has_parent=True   n=151
#   naming=session-  origin=(none)     has_parent=False  n=67
#   parents NOT found as top-level dir: 0
```

### 9.3 A2：header.id 与目录名的相等性

```python
c = collections.Counter()
for dirname, hid, par in rows:
    kind = 'top' if dirname.startswith('session-') else 'sub'
    c[(kind, 'id_has_prefix' if hid.startswith('session-') else 'id_bare',
       'dir==id' if dirname == hid else 'other')] += 1
# ('sub','id_bare','dir==id') 151
# ('top','id_has_prefix','dir==id') 67
```

### 9.4 A3：按帧切块的无损性与 seq 连续性

把 260 帧的文件在第 130 帧处切分，验证重组与原文件一致：

```
total bytes: 757118 frames: 260 torn: None
simulated split at frame 130: part1=553880B part2=203238B
reassembly identical to original: True
part1 frames: 130 covering seq 0.. 239
part2 frames: 130 covering seq 240 .. 499
watermark check: part1 last seq: 239  part2 first seq: 240 -> contiguous: True
```

这是**按帧切块做跨机增量传输**的正确性前提：切块无损、可重组、跨块 seq 连续。

### 9.5 已知未验证项

- `request/header` 内部结构未逐字段分析（只确认了体积与"模板 + 工具定义"的性质）。
- 帧内 block 的压缩策略（是否用 long-distance matching）未深入；
  对读取层无影响（顺序解析不需要它）。
- Windows 路径编码（`C:\…` → projectKey）**未实测**。按官方源码 `\` 与 `:` 同样走
  分隔符处理，但本机无法验证；实现时应对 Windows 路径单独加测试。

---

## 相关文档

- [`docs/design.md`](./design.md) — 整体技术设计与关键决策（ADR）
- 会话格式的任何变更（`session.v5` 等）都应先更新本文，再改实现。
