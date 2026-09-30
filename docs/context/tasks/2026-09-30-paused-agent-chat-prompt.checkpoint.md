## stage
MR !4872 已提交，待 CI 与评审。

## verified
- Agent 实例暂停时聊天区显示现有暂停文案且隐藏重新连接按钮；Bot 自身暂停不会误触发该提示。
- 两个聚焦测试文件 90/90、`pnpm check` 与收紧状态判定后的 `pnpm build` 均通过。
- 改动路径未命中 change-impact 规则。

## unverified
- 全量测试未通过：`localhost` 解析错误后以 `127.0.0.1` 重试，多个无关测试失败，随后停止。
- 未在真实暂停 Agent 账号上做线上验证。

## discard
- 构建生成的 `frontend/next-env.d.ts` 改动已还原。

## restore
- 独立工作树：`/Users/pablozhong/.codex/worktrees/paused-agent-chat-prompt/lightvela`。
- 只修改聊天承载组件、父页面状态传递、聚焦测试和本 Task Pack。

## next_action
核对 MR source SHA 与远端分支一致，并向用户交接 MR 与 CI 状态。
