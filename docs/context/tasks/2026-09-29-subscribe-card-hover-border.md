# OPT-003：订阅页套餐卡外框随 Hover 变化

## goal
让 `/subscribe/` 套餐卡的强调外框随鼠标移入的卡片移动，鼠标移出后恢复中性边框。

## non_goals
- 不改变卡片选择、价格、订阅或升级逻辑。

## requirement_ids / requirement_refs / requirement_excerpt
- TAPD `1070234090138685610`；用户截图和要求：外框应随 Hover 事件变化，不固定在某张卡。

## interface_refs / data_structure_refs
- `frontend/next-site/subscribe-page.tsx` 中 `PlanCard` 的 `MotionCard` 边框与 transform。
- `frontend/src/components/ui/card.tsx` 的 `pricing` 变体。

## history_context
- `current_design_refs`：用户截图与本 Task Pack。
- `relevant_evolution`：当前 master 两张卡初始均为灰色边框，需为交互补足明确的高亮态。
- `superseded_refs`：无。

## acceptance
- 鼠标移入任一卡片时仅该卡显示黑色强调边框，移出全部后两卡恢复灰色；键盘聚焦卡内控件时保持可见强调，触屏不遗留 Hover 高亮。
- 双站聚焦测试、`pnpm check`、`pnpm build` 通过；推送预览、CR、MR 草稿并等用户确认。

## affected_paths
- `frontend/next-site/subscribe-page.tsx`、`frontend/next-site/__tests__/subscribe-page.test.tsx`。

## required_context
- `frontend/AGENTS.md`、`docs/context/project/services/frontend.md`、`docs/context/domains/site-environment-routing.md`、`docs/context/domains/subscription-entitlements.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/next-site/subscribe-page.tsx` | 套餐卡实现 | 边框交互入口 |
| `frontend/src/components/ui/card.tsx` | 卡片变体 | 保留圆角与基础样式 |
| `frontend/next-site/__tests__/subscribe-page.test.tsx` | 现有卡片断言 | 补充鼠标、键盘和触屏验证 |

## evidence
- 套餐页聚焦测试 44/44、`pnpm check`（0 新增 TypeScript 诊断）、国内 `pnpm build` 与国际 `pnpm build:global` 均通过。
- 提交前 CR：核对黑色外框仅由当前卡真实鼠标 Hover 或卡内键盘焦点触发，离开后恢复中性；保持 1px 边框和内阴影，避免布局抖动。未发现阻断项。
- 待补：预览地址与最终提交。

## risks
- 边框宽度变化会引发布局抖动：保持 1px 边框并用内阴影增厚视觉。
- 触摸屏可能合成鼠标 Hover：仅响应真实 mouse pointer。

## validation
- 聚焦组件测试、`pnpm check`、双站构建、`git diff --check`、change-impact 检查。

## decisions
- 用局部 Hover 与 focus-within 状态控制边框；保持卡片选择和购买状态不参与高亮。

## scan_scope
- 套餐卡组件、基础 Card 变体与订阅页测试。

## scan_output
- 当前 master 的 `PlanCard` 外框初始为灰色，无动态强调；组件现有 transform 只随鼠标移入变化。

## handoff
- 代码与双站验证完成；推送预览并核对后移入看板待确认，等待用户确认创建 MR。

## MR 草稿
- 标题：`fix(subscribe): move plan-card emphasis with hover`
- 源：`frontsandbox/subscribe-card-hover-border`；目标：`master`。
- 描述：套餐卡默认中性边框；真实鼠标 Hover 和卡内键盘聚焦强调当前卡，移出/失焦恢复；触屏不遗留高亮。附聚焦测试、双站构建与预览证据。
