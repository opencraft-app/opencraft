---
id: account-plan-status-hierarchy
type: task
scope: 套餐管理页当前套餐名称与状态的信息层级调整
triggers: ["account billing plan status", "current plan", "套餐状态"]
owner: pablozhong
authority: primary
source_of_truth:
  - frontend/src/pages/marketing/account-page.tsx
status: complete
reviewed_at: 2026-09-20
review_due: 2026-12-19
revision: 1.0.0
precedence: task
derived: false
---

## goal
按用户标注截图调整套餐管理页的信息层级：标题显示“当前套餐”，副标题显示具体套餐名，右侧标签显示套餐真实状态，并提供套餐说明文档入口。

## non_goals
- 不改变订阅、续费、升级、支付、Pass 状态推断或区域门禁逻辑。
- 不提交、推送、更新 MR、合并或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-09-20 标注截图：`Current plan` 作为左侧标题，具体套餐名替换 `Currently active`，右侧标签显示 `Active` 等实际状态。

## interface_refs / data_structure_refs
- `frontend/src/domain/types.ts` 的 `SubscriptionStatus`。
- `frontend/src/lib/billing-flow.ts` 的 `PassStatus` 与 `getPassStatus`；本次只消费既有状态，不重定义状态语义。

## history_context
- `current_design_refs`：`frontend/DESIGN.md`、`docs/context/tasks/2026-09-20-account-plans-billing-split.md`。
- `relevant_evolution`：MR !4310 已将套餐内容拆到 `/account/billing`；当前页面主实现为 `SubscriptionSection`。
- `superseded_refs`：无。

## acceptance
- 活跃套餐显示“当前套餐 / 具体套餐名 / 生效中”，英文对应 `Current plan / <plan name> / Active`。
- 具体套餐名与到期日期使用相同字号和文字颜色；“当前套餐”后提供无下划线、右侧带小箭头的“套餐说明”链接，按站点与语言打开 `/docs/plans`。
- 过期、隔离、待支付和取消状态不被误标为当前套餐；升级中与升级失败仍显示原状态。
- 续费、升级、销毁和支付行为不变。

## affected_paths
- `frontend/src/pages/marketing/account-page.tsx`
- `frontend/src/pages/marketing/__tests__/account-page-name-audit.test.tsx`
- `frontend/src/pages/marketing/__tests__/account-page-renewal.global.test.tsx`
- `frontend/src/i18n/generated/*.json`

## required_context
- `frontend-product-surface`、`subscription-entitlements`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@a5753241a` | 前端门禁与 UI 规则 | 约束测试、check、build 和视觉证据 |
| `frontend/DESIGN.md@a5753241a` | 页面视觉与组件规范 | 保留现有标签样式，只调整信息层级 |
| `docs/context/project/services/frontend.md@a5753241a` | 前端服务边界 | 不把 UI 状态当作后端门禁 |
| `docs/context/domains/subscription-entitlements.md@a5753241a` | 订阅状态权威边界 | 复用后端 contract 和既有 Pass 推断 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@a5753241a` | i18n 与测试邻接 | 检查生成字典与相邻测试 |
| `docs/context/tasks/2026-09-20-account-plans-billing-split.md@a5753241a` | 套餐管理页当前设计历史 | 确认 `/account/billing` 为目标页面 |

## evidence
- 精确搜索定位 `SubscriptionSection` 中现有 `displayName`、`当前生效` 与 `当前套餐` 标签。
- `PassStatus` 已覆盖 active / expired / isolated；旧 `SubscriptionStatus` 还覆盖 pending_payment / cancelled。
- 聚焦 Vitest 3 个文件、56 项测试通过，覆盖活跃、过期、隔离、升级中状态及套餐说明链接。
- i18n 六个目标语种均 2943/2943，结构错误 0；新增“待支付”“隔离期”“套餐说明”翻译。
- `pnpm check` 通过：TypeScript 新增诊断 0；`pnpm build:global` 通过并生成 650 个静态页面。
- 本地 global mock 预览在 `/account/billing/?state=realname-done&passState=expiring` 验证“当前套餐 / 套餐说明 / 启航 Launch / 生效中”的信息层级；点击套餐说明后 `/zh-sg/docs/plans/` 返回 200。该预览不代表真实账号或生产状态。

## risks
- 将标签固定为 Active 会掩盖过期或隔离状态；因此从既有 Pass / Subscription contract 派生显示文案。
- 修改展示层级可能回归升级中提示；保留升级中、升级失败标签及 `role=status`。

## validation
- 聚焦套餐管理页测试。
- `pnpm check`、国际站构建、`git diff --check`、context/documentation 门禁。
- 本地视觉预览；无法复现真实账号时明确演示数据边界。

## decisions
- 保持现有卡片布局，将套餐名的字号与颜色对齐订阅有效期，并增加官网套餐说明入口。
- 套餐状态直接消费既有业务状态，避免把所有套餐误标为 Active。

## scan_scope
- `frontend/src/pages/marketing/account-page.tsx`、相邻测试、billing/pass 状态 helper 与 i18n 生成入口。

## scan_output
- 无匹配 OpenSpec；当前实现和相邻测试已定位，生成字典由 `i18n-extract.mjs` 维护。

## handoff
- 实现与验证完成；交付到现有 `codex/upgrade-plan-polish` 分支后需回查 MR !4321 的源 SHA、CI 与可合并状态。
