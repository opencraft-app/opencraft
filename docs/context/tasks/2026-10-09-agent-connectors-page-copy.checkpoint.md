---
id: agent-connectors-page-copy-checkpoint
type: task
scope: Agent 连接器页面文案任务的续接与交接状态。
triggers: ["Agent 连接器文案续接", "连接器页面 checkpoint"]
owner: pablozhong
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-09-agent-connectors-page-copy.md
status: active
reviewed_at: 2026-10-09
review_due: 2026-11-09
revision: 1.0.1
precedence: task
derived: false
---

## stage
连接器页面文案与结构已提交至 MR !5131；当前补充解除授权作用范围与英文文案的 CR 修订。

## verified
- 顶部标题为「连接器」，下方仅一句说明。
- 说明文案为「连接常用服务，扩展 Agent 能力边界，帮你完成更多任务」。
- 已移除「应用连接」小标题、重复说明和未来连接器占位卡；实际卡片及授权操作保留。
- 七种必需语言翻译齐全；聚焦测试 20/20、`pnpm check` 和 `pnpm build` 通过。
- 真源提交 `fff15e2ad`、OpenCraft 同步提交 `61bf4fe66` 已推送；同步检查通过。
- CR 修订的聚焦测试 20/20、`pnpm check`、`pnpm build` 与文档校验通过；新弹窗文案覆盖七种必需语言。

## unverified
- 全量 Vitest 在此前运行中有大量无关失败并触及 4GB worker 堆上限。

## discard
- 构建生成的字体和 `next-env.d.ts` 改动已还原。

## restore
- 工作树：`/Users/pablozhong/.codex/worktrees/agent-connector-nav/lightvela`。
- 同一工作树包含上一轮导航顺序改动。

## next_action
- 验证 CR 修订并更新 MR，核对远端提交与 CI 状态。
