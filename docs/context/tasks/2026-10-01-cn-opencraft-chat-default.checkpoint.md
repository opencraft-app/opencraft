## stage
国内默认 OpenCraft 的实现已完成，进入交接前复核。

## verified
- `origin/master@ca0908ec1` 的门禁是 `!isGlobal && showHiddenAgentTools`；现已改为仅按国内区域启用。
- 国内 Chat 跳过旧 AgentChat launch-token 请求；国际站保留原路径。
- 聚焦测试、发布制品测试、`pnpm check`、`pnpm typecheck`、国内构建通过。
- 最终文档校验、变更影响检查及 staged diff 检查通过。

## unverified
- 真实登录后的线上 Chat 流程及生产发布未执行。
- 完整前端测试出现多项无关失败及 worker 终止超时，需由对应 owner 排查基线。
- 前端包没有 `pnpm lint` script。

## discard
- 初次单独 typecheck 因尚未运行 Fumadocs 生成步骤而缺少 `collections/server`；`pnpm check` 生成后复核通过。

## restore
- 工作树：`/Users/pablozhong/.codex/worktrees/cn-opencraft-default/lightvela`，分支 `codex/cn-opencraft-default`。
- 主检出有大量未提交改动，本任务没有修改它。
- Task Pack：`docs/context/tasks/2026-10-01-cn-opencraft-chat-default.md`。

## next_action
- 向用户交接可审阅分支与验证结果，并按根 `AGENTS.md` 的 Git/发布确认要求等待下一步。
