# dsh-repo-session-sync

> Sync DeepSeek Harness **sessions** with **git repositories** across machines.
> 把 DSH 会话与 git 仓库绑定，在多机之间同步会话状态。

## 为什么

换机器时，**代码有 git，对话没有**。

现有的会话同步插件（`dsh-session-sync`、`dsh-chatsync`）把整个 `~/.dsh` 当成一坨数据搬运，
和你项目自己的 git 工作流是两套并行的真相来源，容易出现「会话说改了 A，git 里没有 A」。

本项目反过来：**以仓库为单位绑定**。

- 代码差异 → 你项目自己的 `git commit` / `git push`（不重复造轮子）
- 会话差异 → 本插件负责，且**知道仓库 HEAD 走到哪了**

## 核心概念

| 概念 | 说明 |
|---|---|
| **repo binding** | 会话 ↔ 仓库路径的绑定关系，随仓库身份（remote URL + 分支）同步 |
| **锚点 (anchor)** | 会话里记录的「当时仓库在哪个 commit」，用于判断会话是否已过期 |
| **双向同步** | 上行（本机 → 远端 git 分支）与下行（远端 → 本机）都要支持 |

## 状态

🚧 早期设计阶段，见 [docs/design.md](docs/design.md)。

## 安装

```bash
dsh plugin --profile desktop add github:elfgzp/dsh-repo-session-sync
```

## License

MIT
