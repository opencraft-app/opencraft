## stage
暂停 Bot 侧栏会话占位修复完成，交接前检查。

## verified
- 无缓存 Bot 在 `useAgentSidebarSessionList` 中会先得到 `loading: true`。
- 侧栏此前仅依据会话 loading/空列表展示 Loading sessions，未考虑 Bot 暂停。
- 暂停且无会话现在不显示加载或默认对话占位；已缓存会话仍显示。
- 暂停时不主动预加载侧栏会话；恢复运行后重启预加载条件。
- 42 项聚焦测试、`pnpm check`、双站构建通过。

## unverified
- 未在生产账号中验证暂停到恢复的真实服务端响应；本地测试覆盖状态分流。

## discard
- 旧空列表 JSX 结构的测试断言已随新状态分流更新。

## restore
- 工作目录为 `/Users/pablozhong/.codex/worktrees/homepage-heading-typography/lightvela`，与先前首页相关未提交改动共存。
- 不要覆盖先前首页字体和 CTA 改动。

## next_action
- 交接本地改动；如需提交、推送或发布，等待用户明确指令。
