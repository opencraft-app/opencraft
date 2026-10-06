## stage
用户实测发现后台任务完成后转圈消失但蓝点缺失；宿主已补运行状态边沿兜底并跑聚焦门禁，等待真实登录态浏览器人工复测。

## verified
- Hermes `turn/completed` 的已完成或失败状态通过嵌入事件传到宿主；当前可见会话不会自动加蓝点。
- 前端聚焦测试、OpenCraft 终态过滤和 client 替换测试、类型检查、边界检查、嵌入构建、文档与变更影响检查通过。
- 5174 监听进程位于本工作区的 `frontend/`，嵌入资源 symlink 指向新构建。
- 前端对已加载后台会话的 `running=true → false` 增加兜底，忽略初次加载和刷新中间态；聚焦测试 19 项与 `pnpm check` 通过。

## unverified
- 浏览器安全策略拒绝自动访问本地预览；真实登录态下切换会话并等待实际 Hermes 执行完成的可见结果尚未实测。
- OpenCraft vendored Agent Console 检查因本工作区此前 i18n 生成副本漂移失败，本轮未提交和同步。

## limitation
- 兜底只能确认执行已停止，不能从目录状态区分正常完成与主动中断；主动中断可能出现蓝点。

## restore
- 工作区：`/Users/pablozhong/.codex/worktrees/remove-sidebar-chat-icons/lightvela`，现有 5174 服务。
- 本轮变更文件和验证证据记录在同名 Task Pack。

## next_action
- 用户在 5174 的 `/agents/chat/` 用真实登录态复测“会话 A 执行中 → 切会话 B → A 完成亮蓝点 → 打开 A 清除”。
