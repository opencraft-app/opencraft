---
id: agents-post-merge-regressions
type: task
scope: Repair regressions found after MR !5097 merged.
triggers: ["agents post merge", "bot rail renewal", "agents redirect loop"]
owner: pablozhong
authority: primary
source_of_truth:
  - wiki/prd-docs/2026-10-08-agents-bot-rail.md
status: active
reviewed_at: 2026-10-08
review_due: 2026-11-08
revision: 1.0.0
precedence: task
derived: false
---

## goal
修复 !5097 合入后 `/agents` 的无 Bot 跳转循环与桌面多 Bot 临期续费提示丢失，并恢复受导航迁移影响的回归测试。

## non_goals
- 不清理总览遗留代码，不调整尚未确认的侧栏间距，不变更后端权益与发布配置。
- 不合并或发布跟进 MR。

## requirement_ids / requirement_refs / requirement_excerpt
- MR !5097 合入后复审；PRD `wiki/prd-docs/2026-10-08-agents-bot-rail.md` 要求「套餐到期／续费提示保留现有账户入口」与 Bot 管理操作继续可达。
- 用户授权修复确认的问题并另提 MR。

## interface_refs / data_structure_refs
- `NextAgentEntitlementGate` 对无 Bot、过期但有历史权益用户只允许 `/agents`；页面跳转不得把该状态送入 `/agents/chat`。
- `passExpiryReminder` 与 `renewalAvailable` 沿用原有到期、实名与计费条件；只移动 UI 出口，不改变权益语义。

## history_context
- `current_design_refs`: `wiki/prd-docs/2026-10-08-agents-bot-rail.md`、`docs/engineering/domains/agent-gateway-runtime.md`。
- `relevant_evolution`: !5097 已于 2026-10-08 合入 `master`，merge commit `3fa43b017`。
- `superseded_refs`: none。

## acceptance
- 无 Bot 且过期并有历史权益的用户停在 `/agents`；订阅且无 Bot 的首次创建入口不回归。
- 双站桌面多 Bot 模式显示临期续费提醒；可续费时进入原续费弹窗，不可续费时保留静态提示。
- Bot 管理菜单的删除、重启与请求中保护有有效测试；受影响聚焦测试通过。
- `pnpm check`、双站构建、文档与 OpenCraft 同步门禁通过；提交新 MR 指向 `master`。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx` 及相邻测试。
- `frontend/next-site/app-route-shell.tsx` 的相邻门禁测试。
- PRD 与相关正式设计文档。

## required_context
- `subscription-entitlements`、`site-environment-routing`、`frontend-product-surface`、`service-frontend`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/subscription-entitlements.md@3fa43b017` | 权益与续费边界 | 保留原续费资格及实名规则 |
| `docs/context/domains/site-environment-routing.md@3fa43b017` | 双站行为 | 两站分别验证 |
| `docs/context/project/services/frontend.md@3fa43b017` | 前端服务边界 | 前端变更门禁 |
| `frontend/AGENTS.md@3fa43b017` | 服务规则 | check、测试、双站构建与 OpenCraft 同步 |
| `frontend/DESIGN.md@3fa43b017` | UI 规则 | 复用原有提示与侧栏样式 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@3fa43b017` | 相邻文件 | 检查门禁测试与运行时开关 |

## evidence
- 工蜂 !5097 状态 `merged`，merge commit `3fa43b017`；`origin/master` 当前为该提交。
- 页面无 Bot 时仍导航至 `/agents/chat`，而门禁将过期且无 Bot 的老用户送回 `/agents`。
- 临期续费提醒和重启错误位于桌面多 Bot 时不渲染的旧 Bot 资料卡内。
- 聚焦测试初跑：85 条中 16 条失败；需拆分真实回归、旧断言与测试 mock 缺字段。
- 修复后聚焦测试：6 个文件 96 条通过；国内、国际站最终构建通过；`pnpm check` 报 0 新增 TypeScript 诊断。
- 文档校验、staged change-impact 和 OpenCraft 副本一致性检查通过。Context catalog 全量校验仍被历史 Task Pack 元信息缺项阻塞；本次新 Task Pack 和 checkpoint 的缺项已补齐。

## risks
- 续费入口涉及计费与实名可用性；只复用现有计算结果和弹窗，测试两站可操作与禁用状态。
- 旧卡片重构会影响移动端与单 Bot；仅对桌面多 Bot 添加出口。

## validation
- 前端聚焦测试、`pnpm check`、`pnpm build:cn`、`pnpm build:global`。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged` 与文档校验。
- `npm --prefix opencraft run check:mono2-agent-console`，若漂移按真源提交后同步副本。

## decisions
- 先修复可证明的行为回归，再更新断言；历史总览代码清理另议。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`、相邻测试、`frontend/next-site/app-route-shell.tsx`。

## scan_output
- `/tmp/agents-post-merge-red-tests.log`。

## handoff
- 当前为新分支 `codex/agents-post-merge-fixes`，基于已合入的 `origin/master`；准备提交并向 `master` 创建跟进 MR，未合并或发布。
