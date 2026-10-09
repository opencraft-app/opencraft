---
id: agent-connectors-page-copy
type: task
scope: 双站 Agent 连接器页面标题、说明和解除授权提示。
triggers: ["Agent 连接器文案", "连接器解除授权提示"]
owner: pablozhong
authority: primary
source_of_truth:
  - frontend/src/pages/marketing/agent-connectors-panel.tsx
  - frontend/src/i18n/generated/zh-CN.json
status: active
reviewed_at: 2026-10-09
review_due: 2026-11-09
revision: 1.0.1
precedence: task
derived: false
---

## goal
将连接器页顶部简化为「连接器」标题与一句说明，并移除重复说明及纯占位卡。

## non_goals
- 不改变连接器授权、下发、解除、状态或可见条件。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-09 截图与请求：顶部标题改成「连接器」，下方一句解释用途和好处，不要其他废话和小标题。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-connectors-panel.tsx` 的 `ConnectorsPanel`；保留 `data.builtin` 卡片及操作。
- `AgentSectionHeader` 提供标题与说明。

## history_context
- `current_design_refs`：`frontend/DESIGN.md`；页面结构以当前源码为准。
- `relevant_evolution`：连接器页已有标题、二级标题和占位卡。
- `superseded_refs`：无。

## acceptance
- 页面只有一个「连接器」标题与一句具体说明；不再显示「应用连接」及纯占位卡。
- 卡片和授权操作保持可用；必需语言翻译齐全。

## affected_paths
- `frontend/src/pages/marketing/agent-connectors-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-connectors-panel.test.tsx`
- `frontend/src/i18n/generated/*.json`

## required_context
- `frontend-product-surface`、`service-frontend`、`site-environment-routing`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@origin/master` | 前端服务边界 | 确定验证范围 |
| `docs/context/domains/site-environment-routing.md@origin/master` | 双站与 locale 约束 | 保持现有可见条件 |
| `frontend/AGENTS.md@origin/master` | 前端规则 | 确定门禁 |
| `frontend/DESIGN.md@origin/master` | 页面设计规则 | 复用现有 Header |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@origin/master` | 翻译与测试邻居 | 使用 i18n 生成脚本并检查相邻测试 |
| `frontend/scripts/i18n-apply.mjs@origin/master` | 翻译写入入口 | 为必需语言补全新文案 |

## evidence
- 聚焦连接器与导航测试：20/20 通过。
- `pnpm check`：通过；7 个必需语言零缺口，TypeScript 新增诊断 0。
- `pnpm build`：通过。
- `pnpm i18n:zh-hant`：使繁体译文与项目转换规则一致。
- 用户后续要求进一步精简后，文案改为「连接常用服务，扩展 Agent 的能力，帮你完成更多任务。」；聚焦测试、`pnpm check` 和构建重新通过。
- 用户最终指定原文：「连接常用服务，扩展 Agent 能力边界，帮你完成更多任务」。
- MR 前对齐最新 `origin/master` 后，按新增 `ms-MY` locale 补齐同一文案翻译。
- 此工作树此前全量 `pnpm test` 出现多处无关失败和 4GB worker 内存耗尽；本次改动后未重复全量运行。
- 初次 OpenCraft 检查发现 `sourceRevision` 漂移；真源提交 `fff15e2ad` 后以独立提交 `61bf4fe66` 同步生成副本和清单，复查通过。
- MR !5131 的 CR 修订进一步说明解除授权对当前实例下所有 Bot 的影响，并微调英文说明。
- CR 修订的连接器与导航聚焦测试 20/20、`pnpm check`、`pnpm build`、文档校验均通过；七种必需语言无缺译。

## risks
- 说明保持概括性，具体可用能力仍以连接器卡片和授权状态为准。

## validation
- `pnpm check`、聚焦组件测试、`pnpm build`、`git diff --check`、OpenCraft 同步只读检查。

## decisions
- 删除纯展示的未来连接器占位卡；保留空状态、加载、错误和实际连接器卡片。

## scan_scope
- 连接器面板、现有组件测试、i18n 生成入口。

## scan_output
- 命中面板头部与底部占位卡；无测试依赖旧文案。

## handoff
- 页面文案和结构已提交并推送至 MR !5131；聚焦测试、前端检查、构建与 OpenCraft 同步检查通过。MR 尚未合并或发布。
