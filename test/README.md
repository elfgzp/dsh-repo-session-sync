# 测试指南

本目录是 dsh-repo-session-sync 的测试体系。**所有测试数据都是合成的**：没有任何来自
真实 `~/.dsh` 的会话、路径或 UUID，也没有任何本机专属信息。

## 怎么跑

```bash
# 推荐：显式 glob（package.json 里的 `node --test test/` 在 Node 25 上会被当作模块路径，不可用）
node --test "test/**/*.test.js"

# 只跑某一块
node --test test/unit/
node --test test/e2e/
node --test test/safety/

# 用装了 zstd API 的 Node 跑（本机 nvm 默认 v20 没有）
/opt/homebrew/opt/node@25/bin/node --test "test/**/*.test.js"
```

Node 版本影响：`zlib.zstdDecompressSync` 需要 **Node ≥ 22.15**。在更早的版本上，
依赖它的用例会**显式 skip 并说明原因**，而不是伪装通过。夹具生成不依赖该 API，
所以在任何 Node 上都能造数据。

## 目录结构

| 路径 | 作用 |
|---|---|
| `lib/zstd-frame.mjs` | 零依赖 zstd 帧**编码器** + 多帧**解码器** |
| `lib/fixtures.mjs` | 合成会话夹具（造 DSH_HOME、会话、仓库注册表） |
| `unit/` | 夹具自身与格式的元测试 |
| `e2e/` | 双向同步端到端 |
| `safety/` | 破坏性 / 恶意输入 |
| `guard.test.js` | 回归护栏：断言真实 `~/.dsh` 未被改动 |

## 会话存储格式（实测结论）

这一节是写测试的前提事实。每条都由本仓库作者在本机真实样本上实测，并用 `zstd` v1.5.7
CLI 交叉验证过。**这里是脱敏后的结构描述，不含任何真实会话内容。**

### 物理布局

```
<DSH_HOME>/sessions/<projectKey>/<sessionSegment>/session.v4.jsonl.zstd
<DSH_HOME>/sessions/<projectKey>/<sessionSegment>/session.lock   # 空文件
```

- 文件是**多个独立 zstd 帧的拼接**，不是单个帧。
- 首帧通常只含一行 header；之后每次 durable append 追加一帧。
- 一帧内可以有 **1~7 个事件**（实测最大 9 行），**不能假设 1 帧 = 1 事件**。

### ⚠️ 最常见的致命错误：one-shot 解压会静默丢数据

```js
zlib.zstdDecompressSync(wholeFileBuffer)   // ❌ 只返回第一帧，不报错、不抛异常
```

实测：488,601 字节的真实会话 → 该调用返回 **257 字节 / 1 行**（仅 header），
而 `zstd -d` 解得 **500 行**。**静默丢失 99.8%**。

为什么危险：header 是合法 JSON，所以「解析成功了吗」这类断言会**假绿**。

正确做法：**逐帧切分再分别解压**。`lib/zstd-frame.mjs` 的 `decodeFrames()` 就是这么做的。

### ⚠️ 切帧不能靠搜魔数

zstd 规范**不保证**压缩块内部不出现帧魔数 `28 b5 2f fd`。实测本机 218 个真实会话
共 257,200 帧，魔数假阳性为 **0** —— 但这是「恰好没出现」，不是「保证不出现」。
把它当解析契约就是埋雷。

正确做法：**从帧起始顺序推进** —— 读 frame header → 逐块读 block header、按声明长度跳过
payload。单遍 O(n)，零试解压，读到 EOF 即为 `tornStart`。

`unit/meta-fixtures.test.js` 里有一条用例专门构造「payload 内部含魔数」的帧来钉这件事 ——
这种字节序列无法出现在合法 UTF-8 JSONL 里，所以只靠夹具永远测不出来。

### 迭代与增量

- **append-only**：旧文件恒为新文件的前缀（实测连续采样 7 次，首次差异字节恒为 null）。
- **追加帧对齐**：每次增长的那段 delta，前 4 字节恒为帧魔数，且可**单独**解压出完整 JSON。
  → 字节偏移水位线是安全的，`buf.subarray(watermark)` 不会切半个帧。
- **`seq` 从 0 严格 +1**：无缺口、无重复、严格递增。可作完整性不变量。
- **torn tail 是正常状态**：崩溃中途留下的半帧应**丢弃**，不是报错。

### 目录名不可反解

```
projectKey = '--' + cwd.replace(/^\//, '').replaceAll('/', '-') + '--'
```

这一层**只把 `/` 改写为 `-`**，其余字符（`.` `_` `-`）字面保留。
因为字面 `-` 与分隔符 `-` 无法区分，映射 **lossy 且不可逆**。

→ **判断「会话属于哪个仓库」必须读 header 里的 `cwd` 字段，绝不能反解目录名。**
`test/unit/` 里有用例造了「目录名与 header.cwd 故意不符」的会话来钉这一点。

（`~XXXX` 转义属于 **sessionId 段**那一层，`encodeSegment` / `decodeSegment` 负责，
可逆、防穿越；它**不**适用于 projectKey。）

### 两种会话目录形态并存

| 形态 | 含义 | 实测占比 |
|---|---|---|
| `session-<uuid>` | 顶层会话 | 67 / 218 |
| 裸 `<uuid>` | **subagent 子会话**，header 带 `parentSession` | 151 / 218 |

`header.id` 与目录名**完全相等**（218/218），不要剥 `session-` 前缀再比。
只扫 `session-` 前缀的实现会漏掉 **~69%** 的会话。

### header 形状

```json
{"type":"session","version":4,"id":"session-<uuid>","createdAt":<ms>,
 "cwd":"<abs path>","isSeeded":false,"delegationDepth":0,"agentPreset":"cordis"}
```
子会话额外带 `"parentSession":"session-<uuid>"` 与 `"origin":"subagent"`。

其余事件行：
```json
{"type":"<event>","seq":<int>,"time":<ms>,"data":{...}}
```

## 夹具约定

- session id 固定假值：`session-00000000-0000-4000-8000-0000000000NN`
  子会话裸 uuid：`00000000-0000-4000-9000-0000000000NN`
- 仓库路径固定为 `/tmp/qa-fixture/<repo>`
- 时间戳固定 `1_700_000_000_000`，保证可复现
- 每个用例用 `mkdtemp` 建临时 DSH_HOME，`t.after` 里删掉
- **任何测试都不得读写真实 `~/.dsh`**；`guard.test.js` 会断言其未被改动

## 为什么自己实现 zstd 编码器

不是为了替代 zstd，而是为了让**夹具能在没有 zstd 的运行时上生成**：

1. Node < 22.15 没有 `zlib.zstdCompressSync`
2. CI 镜像不一定装 `zstd` CLI

`encodeFrame()` 输出 **raw block** 帧（RFC 8878 §3.1.1.3），零依赖、合法，可被任何
合规解码器读取。已验证：真实 `zstd` CLI `-t` 通过、`-d` 结果与原字节 `cmp` 完全一致、
多帧文件 `zstd -l` 正确报帧数。
