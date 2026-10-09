---
id: agent-connector-navigation-order-checkpoint
type: task
scope: Agent 连接器导航顺序任务的续接与交接状态。
triggers: ["Agent 连接器导航续接", "连接器导航 checkpoint"]
owner: pablozhong
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-09-agent-connector-navigation-order.md
status: active
reviewed_at: 2026-10-09
review_due: 2026-11-09
revision: 1.0.1
precedence: task
derived: false
---

## stage
导航顺序已提交至 MR !5131；当前补充 CR 意见，等待更新后的 MR 检查。

## verified
- `settingsGroups` 的日常顺序为通道、技能、连接器、定时任务。
- 导航顺序测试 8/8 通过；`pnpm check` 和 `pnpm build` 通过。
- `git diff --check` 通过。
- 真源提交 `fff15e2ad`、OpenCraft 同步提交 `61bf4fe66` 已推送；同步检查通过。

## unverified
- 全量 Vitest 未通过：多处无关失败，worker 达到 Node 4GB 堆上限后中止。
- sidebar tabs 组件测试启动时 `localhost` DNS `ENOTFOUND`。

## discard
- 主检出区在旧分支且有大量无关未提交变更；本轮改动位于独立工作树。

## restore
- 工作树：`/Users/pablozhong/.codex/worktrees/agent-connector-nav/lightvela`，基于 `origin/master`。
- 任务记录：`docs/context/tasks/2026-10-09-agent-connector-navigation-order.md`。

## next_action
- 完成 CR 修订后复查测试与 MR 的远端提交、CI 状态。
