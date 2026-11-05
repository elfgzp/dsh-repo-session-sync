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

🚧 **早期开发阶段**。插件骨架、配置层、持久化与宿主侧路由已完成；同步引擎的实现
（`src/transport.js` / `src/conflict.js` / `src/anchor.js`）尚未接入，此时同步操作会
返回 `not-implemented`，但**仓库绑定与设置页可以正常使用**。

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

1. 打开 **Settings → 仓库会话同步**
2. 绑定一个仓库：填本机仓库路径，插件从 `git config` 读取 remote 与分支
3. 选同步方向（上行 / 下行 / 双向）与传输通道
4. 之后可以在设置页点按钮，也可以让 agent 调用 `repo_session_sync` 工具

下行会写本机会话目录，**每次写入前都会先做备份**，备份不会被自动删到零份。

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
