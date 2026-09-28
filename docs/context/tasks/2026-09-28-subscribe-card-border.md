---
id: 2026-09-28-subscribe-card-border
type: task
scope: Remove the misleading featured border from public subscribe plan cards.
status: active
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - frontend/next-site/subscribe-page.tsx
reviewed_at: 2026-09-28
revision: 1.0.0
precedence: task
derived: true
---

## goal

在国内订阅页去除首张套餐卡片看似“已选中”的黑色边框；各卡的“立即订阅”仍是唯一的购买入口。

## non_goals

- 不改变套餐、价格、下单、支付、登录或实名逻辑。
- 不增加卡片点击选择、键盘选择或新的选中状态。
- 不修改国际站文案或生成的 i18n 资源。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户反馈（2026-09-28）：首张卡片的黑色边框像已选中，第二张卡不能通过点击卡片选中；用户应直接点击卡内“立即订阅”。

## interface_refs / data_structure_refs

- `PlanCard.onSubscribe(planId)`：仅由卡内 CTA 调用，必须继续传递当前档位的 `plan.id`。
- `PlanCard` 仅展示套餐，不能新增卡片级选择状态。

## history_context

- `current_design_refs`：`frontend/openspec/specs/plan.md` 将 `/subscribe` 定义为套餐卡片展示及支付入口。
- `relevant_evolution`：无。
- `superseded_refs`：无。

## acceptance

- 套餐卡使用一致的中性边框和圆角，不以首张卡表达选中状态。
- 点击卡内 CTA 仍进入该卡对应的订阅流程。
- 聚焦组件测试覆盖卡片不再有 featured 边框，且 CTA 保持独立入口。

## affected_paths

- `frontend/next-site/subscribe-page.tsx`
- `frontend/next-site/__tests__/subscribe-page.test.tsx`

## required_context

- 路由查询未匹配 Pack；已记录 failed query：`Remove misleading selected state from domestic subscribe plan cards; each card purchase CTA remains independent`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@master` | 前端服务边界与验证要求 | 确定需提供组件测试或页面截图。 |
| `frontend/openspec/specs/plan.md@master` | 订阅页面与下单职责 | 保持 CTA 是套餐购买入口。 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@master` | 前端页面与测试邻接 | 检查 OpenSpec 和相邻测试，不修改 i18n。 |
| `frontend/next-site/subscribe-page.tsx@master` | 当前卡片实现 | 定位首张卡独有的 `isFeatured` 边框与圆角。 |
| `frontend/next-site/__tests__/subscribe-page.test.tsx@master` | 相邻验证 | 扩展套餐卡视觉/CTA 契约。 |

## evidence

- `pnpm exec vitest run --api.host 127.0.0.1 next-site/__tests__/subscribe-page.test.tsx src/components/ui/__tests__/card.test.tsx`：46/46 通过。
- `pnpm exec vitest run --api.host 127.0.0.1 next-site/__tests__/subscribe-page.global.test.tsx`：61/61 通过。
- `pnpm check`：退出码 0；TypeScript 171 current / 171 baseline / 0 new。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：0 error、0 broken first-party links。
- 本地国内站预览 `http://127.0.0.1:5175/subscribe/`：两张套餐卡均显示中性细边框；当前账号已有套餐，CTA 按既有规则禁用。

## risks

- 误删 CTA 或改变 `onSubscribe` 会影响下单；用组件测试验证按钮仍按卡片档位工作。

## validation

- `pnpm exec vitest run --api.host 127.0.0.1 next-site/__tests__/subscribe-page.test.tsx`
- `pnpm check`
- `git diff --check`

## decisions

- 移除首张卡的视觉特权，而不是实现卡片点击选中；这符合用户要求的直接卡内订阅模式。

## scan_scope

- `frontend/next-site/`、`frontend/openspec/`。

## scan_output

- 有界搜索定位 `PlanCard` 的 `isFeatured` 仅用于视觉边框/圆角和 hover 豁免；CTA 独立调用 `onSubscribe(plan.id)`。

## handoff

- 已完成本地实现与验证；未执行 commit、push、MR、发布或生产操作。
