## stage
实现与本地预览已完成；待运行中的多 Bot 账号实测新会话创建。

## verified
- 最新 `master` 基线 `e08b0db87`；5174 服务 cwd 是 `cn-chat-welcome-mascot/lightvela/frontend`。
- 总览卡片触发对应 Bot 的新聊天导航；菜单保留修改资料，公用弹窗标题使用现有多语言键。
- `pnpm check`、`pnpm build:cn`、聚焦测试、文档与 change-impact 检查通过。
- Chrome 本地页从卡片进入带该 Bot ID 的 `/agents/chat/`；当前账号 Bot 暂停，显示暂停提示。

## unverified
- 运行中的多 Bot 账号上，新会话命令是否成功创建并选中新会话。
- 全量测试未完成：多个无关失败后出现 Node heap OOM。

## discard
- 旧主工作区未含总览的误判；它落后于最新 `master`。

## restore
- 预览工作区：`/Users/pablozhong/.codex/worktrees/cn-chat-welcome-mascot/lightvela`，5174 仍在运行；本轮源文件变更已同步至此。
- 独立验证工作区：`/Users/pablozhong/.codex/worktrees/bot-card-chat-navigation/lightvela`，相同前端改动及构建验证。

## next_action
- 如获得运行中多 Bot 的本地预览会话，验证点第二张卡片后 URL Bot ID 与新会话选中状态。
