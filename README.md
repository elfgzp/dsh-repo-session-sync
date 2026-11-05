# dsh-repo-session-sync

> Sync DeepSeek Harness **sessions** with **git repositories** across machines.
> 把 DSH 会话与 git 仓库绑定，在多机之间同步会话状态。

## 为什么

换机器时，**代码有 git，对话没有**。

已有的会话同步插件把整个 `~/.dsh` 当成一坨数据搬运，和你项目自己的 git 工作流是
两套并行的真相来源，容易出现「会话说改了 A，git 里没有 A」。

本项目反过来：**以仓库为单位绑定**。

- 代码差异 → 你项目自己的 `git commit` / `git push`（不重复造轮子）
- 会话差异 → 本插件负责，且**知道仓库 HEAD 走到哪了**

## 核心概念

| 概念 | 说明 |
|---|---|
| **repo binding** | 会话 ↔ 仓库的绑定关系。绑定键是**仓库身份**（归一化后的 remote URL + 分支），不是本机路径——所以两台机器上不同路径的同一仓库能对上 |
| **锚点 (anchor)** | 会话里记录的「当时仓库在哪个 commit」，用于判断会话是否已过期 |
| **双向同步** | 上行（本机 → 远端）与下行（远端 → 本机）都支持 |
| **绝不静默覆盖** | 同一会话两端都动过时，保留双份并给出报告，不会悄悄覆盖任何一边 |

## 状态

🚧 **开发中**。插件骨架、配置层、持久化、宿主侧路由、设置页与可见性闸门已完成；
同步引擎（`src/transport.js` / `src/conflict.js`）正在接入。引擎未就绪时，同步操作会
明确返回 `not-implemented` 并把按钮置灰说明原因，**不会假装成功**。

仓库绑定、设置页、可见性判定现在就可以用。

设计见 [docs/design.md](docs/design.md)，文件归属见 [src/README.md](src/README.md)。

## 安装

插件通过 DSH 的 profile bundle 机制安装，**不要**手工改 profile 目录。

### 标准写法

```bash
dsh plugin --profile desktop add github:elfgzp/dsh-repo-session-sync
```

### 若 `dsh` 不在 PATH

DSH Desktop 的 CLI 随 app 一起分发，不在 `PATH` 里。用内置的绝对路径即可：

```bash
# macOS
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add github:elfgzp/dsh-repo-session-sync
```

> 路径里的 `Applications` 是公开的安装位置，不含个人信息。真正需要避免的是把
> 任何用户家目录写进仓库——本仓库的 `scripts/check-private.sh` 会在提交时拦截。

本地开发时可以直接链接工作副本，改完重启 DSH 生效：

```bash
"$DSH" plugin --profile desktop add link:/absolute/path/to/dsh-repo-session-sync
```

安装后插件会自动出现在 profile 的组合里（由 `cordis.patch.yml` 的 `insert:` 行挂载）。
**不要**自己往 profile 的 `cordis.patch.yml` 里粘 `- id:` / `- name:` —— 那样会被
loader 当成「覆盖一个不存在的行」而静默丢弃。

## 使用

**完整步骤见 [docs/usage.md](docs/usage.md)。** 这里是快速版：

1. 打开 **设置 → 仓库会话同步**
2. **添加仓库** → 选你的 git 仓库目录。插件从 `git config` 读 remote 与分支
3. 选同步方向（上行 / 下行 / 双向）
4. 在仓库那一行点 **上行** 或 **下行**

### 三件上手前就该知道的事

**① 先推代码，再推会话。**
```
git commit && git push   →   同步会话（上行）
git pull                 →   同步会话（下行）
```
顺序反了会出现「会话里说改了 A，git 里没有 A」——git 自己解决不了这个错位，
插件也不应该假装能解决。

**② 会话不跟着 `git clone` 过来。**
会话存在仓库的独立引用 `refs/dsh-sessions/v1` 里，`git push --all`、`git clone`、
`force-push`、`gc --prune=now` 都不会碰它（这是刻意的）。新机器第一次同步请用
插件里的「下行」，或者手动：

```bash
git fetch origin 'refs/dsh-sessions/v1:refs/dsh-sessions/v1'
```

**③ 两台机器的仓库路径不一样，是正常的。**
仓库身份由 **remote + 分支**决定，不是由本机路径决定。`~/my-project` 和
`~/work/my-project` 是同一个仓库。会话里记录的 cwd 会在下行时被改写成目标机器的
真实路径——不改写的话会话在界面上看不到，而且继续对话时工具会落在错误的目录里。

### 关于仓库可见性（重要）

**同步 = 把完整对话内容推到远端仓库**，包括你本机的路径、命令输出、代码片段，
以及你在对话里贴过的任何东西。

绑定仓库时插件会检查它是私有还是公开：

| 判定 | 行为 |
|---|---|
| 私有 | 直接放行 |
| **公开** | **默认阻止**；要继续必须**逐字输入仓库名**确认 |
| 查不到 | **默认阻止**（没网 / 非 GitHub / 无权限都是这种情况） |

**「查不到」绝不等于「安全」。** 而且**每次上行前都会重新判定**：仓库今天私有、
明天可能被改成公开，只在绑定时查一次等于装了个只响一次的警报器。

### 不会碰什么

- 不会替你 `commit` / `push` / 改工作区文件——代码始终走你自己的 git
- 不保存任何凭据：认证沿用你已有的 git 配置（钥匙串 / SSH agent / credential helper）
- 默认对 `~/.ssh/config` **一行都不写**
- 不同步设置 / 插件 / skills（那是 `dsh-settings-sync` 的职责）
- 不同步附件（实测只有 2.3% 的会话真正引用附件，为它引入二进制搬运不划算）
- 下行写入前**一定先备份**，备份不会自动删

## 开发

```bash
npm test              # node --test，无需安装 DSH
npm run smoke         # 加载冒烟：临时 DSH_HOME + 临时 profile，隔离验证能否被 DSH 组合
./scripts/check-private.sh   # 提交前的隐私扫描（pre-commit 钩子自动跑）
```

`npm run smoke` 做的事：检查 patch 格式、manifest 契约、Host 导出、`apply()` 装配，
最后用真实的 `dsh --dump-config` 确认 loader 能把插件组合进 profile。全程在
`mktemp -d` 出来的临时目录里，**不碰你真实的 `~/.dsh`**。

## License

MIT
