## goal
已登录且现有套餐过期或进入隔离期时，首页 CTA 回到已有的 Agent 空间，避免误显示“免费试用”。

## non_goals
- 不改变套餐生命周期、续费开放条件、支付流程或未购买用户的免费试用入口。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-05 截图：国际站首页误显示 Free trial，账号已登录且 Launch 套餐在隔离期。用户曾指定“管理套餐”进入 `/account/billing`，随后指出这一方案仍不合理；当前按截图中已有 Bot 推断应回到 Agents。

## interface_refs / data_structure_refs
- `frontend/src/contexts/agent-context.tsx`: `latestPass` 含未删除的历史套餐，`isSubscribed` 表示当前可用权益。
- `frontend/src/lib/billing-flow.ts`: `getPassStatus` 推断 expired / isolated。
- `frontend/src/lib/agent-routes.ts`: `AGENTS_HOME_PATH`。

## history_context
- current_design_refs: `docs/context/domains/subscription-entitlements.md`、`frontend/openspec/specs/marketing.md`。
- relevant_evolution: 原 CTA 将已登录、未生效套餐一律判为免费试用；现有账户页、控制台和订阅页仍识别 `latestPass`。

## acceptance
- 已过期或隔离期套餐的首页 Hero、中部、页脚 CTA 均显示本地化“我的智能体伙伴”并进入 `/agents`。
- 新用户、当前有效套餐用户维持各自现有入口。
- 在订阅快照加载期间不提前显示 CTA；双站相关测试通过。

## affected_paths
- `frontend/src/lib/cta-journey.ts`
- `frontend/next-site/international-home-runtime.tsx`
- `frontend/src/lib/__tests__/cta-journey.test.ts`
- `frontend/next-site/__tests__/international-home-rendering.test.tsx`

## required_context
- `subscription-entitlements`；前端服务规则。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/subscription-entitlements.md@2.0.0` | 套餐状态边界 | 使用既有状态判断，不另造续费规则 |
| `frontend/AGENTS.md` | 前端门禁 | 执行 lint/type/test/build |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 相邻生成物和测试 | 核对现有词典与聚焦测试 |
| `frontend/openspec/specs/marketing.md` | 营销页设计 | 核对首页入口 |
| `frontend/src/lib/billing-flow.ts` | 套餐状态真源 | 识别 expired / isolated |
| `frontend/src/contexts/agent-context.tsx` | 权益消费状态 | 使用 `latestPass` 与 `isSubscribed` |

## evidence
- 当前“我的智能体伙伴”方案的聚焦首页和 CTA 测试 90 项通过；`pnpm typecheck`、国内与国际构建均在最终改动后通过。`pnpm check` 通过；全量测试遇到其他模块失败和 Node OOM，已中止。

## risks
- `latestPass` 是当前用户 `/v1/passes` 成功返回后的快照；CTA 继续等待权益加载，失败时保持隐藏。回滚可撤回 CTA 状态分流。

## validation
- 聚焦测试、完整前端测试、typecheck、构建和变更影响检查。

## decisions
- 复用 `getPassStatus` 识别 expired / isolated；在用户否定“管理套餐”方案后，以首页主按钮返回已有 Agent 空间为当前工作假设，文案沿用已有“我的智能体伙伴”官方译文。

## scan_scope
- 首页 CTA runtime/helper、Pass context、billing flow、相邻测试和词典。

## scan_output
- 有界源码搜索，无额外扫描产物。

## handoff
- worktree 内尚未提交、推送或发布；若用户选定其他 CTA 文案或落点，继续调整并复验。
