---
id: first-bot-create-dialog-task
type: task
scope: 简化无 Bot 实例的首个 Bot 创建弹窗，并固定为空白创建。
triggers: ["first Bot creation", "首个 Bot 创建", "empty agent Bot dialog"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-10-first-bot-create-dialog.md
status: active
reviewed_at: 2026-09-10
review_due: 2026-09-17
revision: 1.0.0
precedence: task
derived: false
---

# Task Pack：首个 Bot 创建弹窗

## goal
当实例尚无 Bot 时，点击新建先填写 Bot 名称，确认后以空白模式创建首个 Bot。

## non_goals
- 不改变已有 Bot 时的新 Bot 创建弹窗，继续保留创建方式和高级设置。
- 不改变 Bot 创建 API、数量限制、订阅判断或错误处理。
- 不合并 MR 或执行部署。

## requirement_ids / requirement_refs / requirement_excerpt
- `LV-FIRST-BOT-DIALOG`：首次创建去掉“创建方式”和“高级设置”，只保留 Bot 名称和确认创建。

## interface_refs / data_structure_refs
- `activeBot`：创建弹窗打开时用于区分首个 Bot 和额外 Bot。
- `handleConfirmCreate -> createBotAndNavigate`：首个 Bot 必须传 `createMode: "blank"`，且不传来源 Bot 和初始人设。

## history_context
- `current_design_refs`：`wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`。
- `relevant_evolution`：最新 `master` 的首个 Bot 原为点击后直接空白创建；本次在创建前增加名称确认。
- `superseded_refs`：无。

## acceptance
- 无 Bot 时，点击新建打开仅包含标题、Bot 名称、取消和确认创建的弹窗。
- 首个 Bot 固定以空白模式创建，不受创建方式或高级设置状态影响。
- 已有 Bot 时，创建方式、说明和高级设置保持现状。
- 聚焦测试、前端检查、文档检查和 diff 检查通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `docs/context/tasks/2026-09-10-first-bot-create-dialog.md`

## required_context
- 未命中 Domain Pack；按路由器要求执行有界精确搜索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库边界 | 确认 Task Pack、验证和提交权限 |
| `frontend/AGENTS.md@working-tree` | 前端服务规则 | 确认测试和类型约束 |
| `docs/context/project/services/frontend.md@2.1.0` | 前端服务上下文 | 确认前端验证边界 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 邻接卡 | 检查页面实现与测试邻居 |

## evidence
- `validate_context.py --route "frontend first Bot creation empty state dialog creation method advanced settings"`：无匹配，要求有界精确搜索。
- 最新 `origin/master` 已将无 Bot 分支改为直接调用 `createInitialBot()`，因此需同步恢复名称确认弹窗。
- 回归断言在实现前按预期失败；实现后页面聚焦回归 28/28、创建权限回归 10/10 通过。
- `pnpm check` 通过；TypeScript 175 current / 276 baseline / 0 new / 101 resolved。
- 文档检查与 `git diff --check` 通过。

## risks
- 只隐藏控件可能让残留状态触发克隆；提交时按首个 Bot 状态强制空白创建。
- 条件范围过宽可能影响额外 Bot；回归断言同时覆盖首个 Bot 与已有 Bot 两条路径。

## validation
- `pnpm vitest run src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `pnpm check`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- `git diff --check`

## decisions
- 复用 `activeBot` 作为弹窗场景判定，不新增后端字段。
- 仅简化首个 Bot，额外 Bot 的多种创建方式保持不变。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`

## scan_output
- 首个 Bot 和额外 Bot 共用弹窗；渲染与提交均需区分，首个 Bot 入口还需从直接创建改为打开弹窗。

## handoff
- 实现与本地验证完成；用户已授权提交、推送并创建新 MR，不合并、不部署。
