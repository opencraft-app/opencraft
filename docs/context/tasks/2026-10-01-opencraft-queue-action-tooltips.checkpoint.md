## stage
本地修复与验证完成；用户已明确授权提交 MR。

## verified
- 根因是队列行的正文 `title` 被缺少自身 `title` 的子按钮继承。
- 排序、插入、编辑、取消编辑、删除与丢弃入口已有各自操作提示；队列行仍显示正文或状态。
- 9/9 队列组件测试、Composer 和 Workbench Web 类型检查、i18n 检查、文档校验、变更影响校验通过。

## unverified
- 未在运行中的 OpenCraft 桌面端手动 hover；未发布。

## discard
- 旧主检出不含当前 OpenCraft 目录，已转到独立 worktree。

## restore
- 工作区：`/Users/pablozhong/.codex/worktrees/chat-action-tooltips/lightvela`。
- Task Pack：`docs/context/tasks/2026-10-01-opencraft-queue-action-tooltips.md`。

## next_action
- 提交、推送并核验用户已授权的 MR；合并和发布另行处理。
