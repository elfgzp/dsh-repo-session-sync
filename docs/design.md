# 设计草案（占位）

由产品与架构成员补全。需覆盖：

1. 会话存储格式与增量识别（`~/.dsh/sessions/**`，append-only 事件流）
2. 仓库身份判定（remote URL 归一化、分支、worktree）
3. 锚点 commit 的记录时机与过期判定
4. 上行 / 下行同步的传输通道（git 独立分支 vs 独立仓库 vs rsync）
5. 冲突语义（双方都改、会话分叉）
6. 与 `dsh-remote` 的关系（是否复用其机器配置 / SSH 通道）
