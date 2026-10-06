## stage
会话侧栏与后台任务未读提示已提交 Gongfeng MR !5039；源分支基于最新 `master`，等待 CI 与评审。

## verified
- Hermes `turn/completed` 的已完成或失败状态通过嵌入事件传到宿主；当前可见会话不会自动加蓝点。
- 前端聚焦测试 57 项、`pnpm check`（0 新增 TypeScript 诊断）、OpenCraft 完成事件测试 2 项、Workbench 类型检查、边界检查、嵌入构建、文档与变更影响检查通过。
- OpenCraft Agent Console 的 130 个生成文件已按已提交真源同步，漂移检查通过。
- MR !5039 的远端 source commit 与本地 HEAD 一致，`merge_status=can_be_merged`。

## unverified
- 浏览器安全策略拒绝自动访问本地预览；真实登录态下切换会话并等待实际 Hermes 执行完成的可见结果尚未实测。
- MR 创建时 CI 为 pending 且阻塞合并；不宣称已经合并或发布。

## limitation
- 兜底只能确认执行已停止，不能从目录状态区分正常完成与主动中断；主动中断可能出现蓝点。

## restore
- 工作区：`/Users/pablozhong/.codex/worktrees/remove-sidebar-chat-icons/lightvela`，分支 `codex/agent-chat-sidebar-unread`。
- 本轮变更文件和验证证据记录在同名 Task Pack。

## next_action
- 评审 MR !5039；用真实登录态复测“会话 A 执行中 → 切会话 B → A 完成亮蓝点 → 打开 A 清除”。
