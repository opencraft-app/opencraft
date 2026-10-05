## stage
国际站 Chat 公开展示改动与聚焦验证完成，待文档影响检查与 MR 交付。

## verified
- MR !5000 已合并；本轮基于 `origin/master@b2a4d7ae0` 的新分支。
- `show()` 的其他隐藏工具保持原有状态订阅，Chat 启用状态改为恒真。
- 聚焦测试 55/55、`pnpm check`、双站构建、OpenCraft 副本与文档链接检查通过。

## unverified
- 真实国际站账号下的发送、会话与移动端交互；全量测试存在无关失败及 Vitest worker 内存耗尽。

## discard
- 先前“国际站 Chat 必须调用 `show()`”的灰度要求已被用户撤销。

## restore
- 工作树 `/Users/pablozhong/.codex/worktrees/international-opencraft-chat/lightvela`，任务记录 `docs/context/tasks/2026-10-05-public-international-opencraft-chat.md`。

## next_action
- 核对文档影响与暂存内容后提交 MR，再验证远端分支和 CI 状态。
