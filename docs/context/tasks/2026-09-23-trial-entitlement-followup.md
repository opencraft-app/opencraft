---
id: trial-entitlement-followup-2026-09-23
type: task
scope: 补齐免费体验 1 个月权益在事实表和 i18n 资源中的残留口径。
triggers: ["免费体验补漏", "试用权益事实表", "旧试用词条"]
owner: jasminzhao
authority: primary
source_of_truth:
  - wiki/prd-docs/2026-09-23-launch-trial-one-month.md
  - frontend/next-site/subscribe-page.tsx
status: active
reviewed_at: 2026-09-23
review_due: 2026-12-22
revision: 1.0.0
precedence: task
derived: false
---

# 免费体验权益合并后补漏

## goal

在 MR !4522 与 !4523 合入后的 master 上，清理仍指向 14 / 7 天的当前事实与无效 i18n 词条，
并用现有套餐一致性测试约束 Launch / Launch AI 首单免费 1 个月的主事实。

## non_goals

不修改服务端活动配置、套餐价格、积分额度、历史 PRD、GitOps、发布或生产资源；不把源码和文档
一致性视为生产权益已经核验。

## requirement_ids / requirement_refs / requirement_excerpt

- `requirement_ids`：MR !4523 合并后免费体验权益补漏；无 TAPD 需求 ID。
- `requirement_refs`：[MR !4523](https://git.woa.com/wisp/mono2/-/merge_requests/4523)、
  `wiki/prd-docs/2026-09-23-launch-trial-one-month.md`。
- `requirement_excerpt`：用户要求检查免费体验权益更新后的遗漏，并授权修改后创建新的 MR。

## interface_refs / data_structure_refs

- `frontend/next-site/subscribe-page.tsx`：`Bundle.time_span` / `time_unit` 及历史兼容 ID `bundle_free_7d`。
- `frontend/src/repositories/fake-repositories.ts`：开发态 `FAKE_BUNDLES` 镜像。
- `wiki/product-state/geo-fact-table.md`：当前产品事实镜像，不代替服务端活动配置。

## history_context

- `current_design_refs`：`docs/engineering/domains/subscription-entitlements.md`、
  `docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`：MR !4522 补齐订阅页及双站套餐文档；MR !4523 补齐首页、页脚、i18n 与检索摘要。
  合并后的 GEO 事实表仍写 14 天和 Launch AI 6 折；兼容免费 Bundle、本地 fake 数据和 i18n 测试
  仍保留 7 天语义。
- `superseded_refs`：历史 PRD 中的 14 / 7 / 3 天权益是当时决策记录，不纳入当前口径清理。

## acceptance

- GEO 主事实表的国内、国际 Launch / Launch AI 首单权益均为 1 个月。
- 事实表明确区分产品确认口径和未独立核验的生产活动配置。
- 订阅页及生成词典不再保留无效的「免费试用 7天」词条。
- 关闭计费开关时使用的兼容免费 Bundle 与本地 fake 数据使用 1 个月；历史 bundle ID 保持不变。
- 套餐一致性测试能拦截事实表回退到旧试用时长。
- 前端 check、聚焦测试、双站构建与 context 门禁按变更风险完成并记录。

## affected_paths

`frontend/next-site/subscribe-page.tsx`、套餐一致性测试、生成 i18n 词典、GEO 事实表、订阅权益正式设计、
原 PRD 补充说明与本 Task Pack。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md | 仓库边界 | 交付授权与验证门禁 |
| frontend/AGENTS.md | 前端边界 | check/test/build 要求 |
| docs/context/domains/subscription-entitlements.md | 领域路由 | 权益事实与服务端权威边界 |
| docs/context/project/services/subscription.md | 服务上下文 | UI 不作为权益真源 |
| docs/engineering/domains/subscription-entitlements.md | 正式设计 | 补充对外展示与生产配置边界 |
| docs/context/flows/tapd-gongfeng-delivery.md | MR 交付 | 鉴权、远端状态与交付记录 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 邻接检查 | i18n 生成物和前端测试 |
| docs/context/tasks/TASK-TEMPLATE.md | 任务记录 | Task Pack 结构 |
| .agents/context/change-impact.json | 影响规则 | 正式设计同步判断 |
| wiki/prd-docs/2026-09-23-launch-trial-one-month.md | 原需求 | 当前权益口径与非目标 |
| docs/context/tasks/2026-09-23-launch-trial-one-month.md | 历史实现 | 已完成范围与验证基线 |
| wiki/product-state/geo-fact-table.md | 当前事实台账 | 定位仍未更新的镜像事实 |

## risks

- 事实表包含历史分析段落；只更新其当前结论和随结论变化的说明，不批量改写历史 PRD。
- 实际权益由服务端活动配置决定；本次没有生产读取权限和发布授权。

## validation

- rebase 到最新 `origin/master@52c62f661` 后，`pnpm --dir frontend exec vitest run next-site/__tests__/plan-pricing-consistency.test.ts next-site/__tests__/subscribe-page.global.test.tsx next-site/__tests__/subscribe-page.test.tsx src/i18n/__tests__/dictionaries.test.ts`：116 / 116 通过。
- `pnpm --dir frontend check`：通过；i18n、繁简、文档同步和类型基线均无新增错误，171 项 TypeScript baseline 保持不变。
- `pnpm --dir frontend build:cn`：通过，检查 8 条公开 SEO 路由。
- `pnpm --dir frontend build:global`：通过，检查 42 条公开 SEO 路由。
- `validate_documentation.py`：通过，0 个 broken first-party links，0 errors / warnings。
- context 单元测试 26 项中 4 项被既有旧 Task Pack schema、超长指令链和历史 secret-literal 候选阻塞；
  单独运行 `validate_context.py` 后过滤确认，本次新增 Task Pack 无错误，route smoke failures 为 0。
- `validate_change_impact.py --staged`：通过；`frontend/src/repositories` 命中 normal-risk 的站点路由提示，
  本次已更新语义更直接相关的订阅权益正式设计，不改变站点路由责任边界。
- 全量 `pnpm test` 未重复执行；!4523 Task Pack 已记录与本次范围无关的历史失败和停滞，本次用受影响的 4 个测试文件及双站完整构建收口。

## checkpoint

### stage

本地实现和范围内验证完成，准备 staged change-impact 门禁与 Gongfeng 交付。

### verified

合并后源码精确搜索确认订阅页和双站文档已是 1 个月；补齐 GEO 事实表、兼容免费 Bundle、fake 数据、
i18n 资源与测试残留。108 项聚焦测试、前端 check、国内/国际构建和文档门禁通过。

### unverified

远端 MR / CI 状态、生产活动配置与线上展示。

### next_action

同步生成物，完成验证后提交并创建新的 Gongfeng MR。
