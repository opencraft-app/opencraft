---
id: agents-bot-switch-firstload-checkpoint
type: task
scope: Recovery state for the separate first-load Bot switching MR.
triggers: ["agents bot switch firstload checkpoint"]
owner: pablozhong
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-08-agents-bot-switch-firstload.md
status: active
reviewed_at: 2026-10-08
review_due: 2026-11-08
revision: 1.0.0
precedence: task
derived: false
---

## stage
独立 `master` 分支修复已移入并验证，待 staged impact、提交、推送和新 MR 核验。

## verified
- `origin/master` 为 `3fa43b017`，新分支 `codex/agents-bot-switch-firstload` 只移入原提交 `388e5a042` 的前端、测试与 PRD 改动。
- 用户在 Chrome 无痕及 Firefox 国内站首次打开时复现头像无法切换、刷新后恢复；修复用未选中头像的原生链接保证首屏导航。
- 定向 35 + 1 条测试通过；侧栏测试全文件另有 1 条当前 master 已有的创建引导断言失败。
- `pnpm check` 0 新增 TypeScript 诊断；国内、国际站构建通过；OpenCraft 同步检查及文档校验通过。

## unverified
- 尚未提交、推送及核验新 MR 的远端状态；上线后首次打开真实浏览器的复测仍待进行。

## discard
- 不把 !5099 的续费、无 Bot 跳转等修改纳入本 MR。

## restore
- 工作树：`/Users/pablozhong/.codex/worktrees/agents-bot-switch-firstload/lightvela`；Task Pack：`docs/context/tasks/2026-10-08-agents-bot-switch-firstload.md`。

## next_action
- 运行 staged change-impact，复核独立 diff 后提交推送并新建 MR。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求：首次打开无法切换 Bot 的修复另建 MR；PRD `wiki/prd-docs/2026-10-08-agents-bot-rail.md`。

## interface_refs / data_structure_refs
- `AgentBotRail` 原生 href；`AgentSettingsPage` URL 驱动的选中态。

## history_context
- `current_design_refs`: `wiki/prd-docs/2026-10-08-agents-bot-rail.md`。
- `relevant_evolution`: !5097 已合入，!5099 独立承载其他回归。
- `superseded_refs`: none。

## context_receipt
- 实际读取清单见同名 Task Pack。
