## stage
MR !5052 的 CR 后续修复已完成，等待最终变更检查和推送。

## verified
- Header 头像链接当前指向 `/account`；菜单内有独立“账号”入口。
- `/agents` 有独立权益门禁。
- 菜单组件聚焦测试 4/4、静态导航测试 3/3 通过。
- `pnpm check`、国内站与国际站构建、OpenCraft 同步只读检查通过。
- 文档检查通过，0 断链、0 警告。
- 无资格或资格未确认时头像进入 `/account`，有资格时进入 `/agents`；国内与国际侧栏测试各 15/15，通过头像与菜单聚焦测试 10/10。
- CR 后的 `pnpm check`、双站构建、OpenCraft 同步和文档检查通过。

## unverified
- CR 后的 change-impact 门禁；线上效果需发布后验证。

## discard
- 无。

## restore
- 工作树：`/Users/pablozhong/.codex/worktrees/homepage-agent-entry-loading/lightvela`，与前几项改动一并提交 MR。

## next_action
- 运行 change-impact 检查，推送 MR !5052 的修复提交。
