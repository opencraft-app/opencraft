## goal
让 `/subscribe` 套餐卡的促销标签与当前用户资格和实际展示价格一致。

## non_goals
- 不修改后端询价、活动配置、下单或支付逻辑。
- 不修改微信登录需求（OPT-002 排队中）。

## requirement_ids / requirement_refs / requirement_excerpt
- OPT-001，用户 2026-09-29 提出：存在对应折扣时展示免费、折扣或不展示；当前“首月 6 折”等标签不符合预期。

## interface_refs / data_structure_refs
- `frontend/src/domain/types.ts` 的 `Bundle`、`BundlePrice`；`total_cost` 原价，`real_total_cost` 实付，`tax_price` 税额。
- 保持后端询价和资格为权威；`discount` 存在小数与百分数两种口径，不用它认定实际优惠。

## history_context
- `current_design_refs`: `frontend/next-site/subscribe-page.tsx`；`frontend/src/content/docs/plans.md` 说明实时价格与付款页为准。
- `relevant_evolution`: 现有国际站已按真实询价显示促销；国内站仍按档位和 `discount` 写死部分标签。
- `superseded_refs`: `wiki/prd-docs/2026-07-14-subscribe-pricing-optimization.md` 的后端无折扣时写死六折兜底。

## acceptance
- 免费标签仅在新用户、启航月付、展示价零元且有正数原价时出现。
- 折扣标签仅在正数折后价低于原价时出现；首月专属文案需匹配真实折扣率和首购资格。
- 全价、无价格和询价切换中均不显示促销标签。
- 国内与国际站聚焦测试、前端服务门禁通过。

## affected_paths
- `frontend/next-site/subscribe-page.tsx`
- `frontend/next-site/__tests__/subscribe-page.test.tsx`

## required_context
- `site-environment-routing`、`frontend-product-surface`、`service-frontend`、`subscription-entitlements`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 仓库 P0 与 Task Pack 要求 | 确认交付和验证边界 |
| `frontend/AGENTS.md` | 最近服务规则 | 前端实现与门禁 |
| `docs/context/domains/site-environment-routing.md` | 国内国际站差异 | 保证双站一致 |
| `docs/context/project/services/frontend.md` | 前端服务边界 | 后端计费真源 |
| `docs/context/domains/subscription-entitlements.md` | 订阅与权益 | 不改变计费 contract |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 邻接检查 | 检查 OpenSpec 和相邻测试 |
| `docs/context/tasks/TASK-TEMPLATE.md` | 任务记录格式 | 记录实施证据 |

## evidence
- `rg` 定位到国内站 `aiPromoTagText` 无报价六折兜底，以及标准版按 `discount` 字段直接承诺优惠。
- `frontend/next-site/__tests__/subscribe-page.test.tsx` 和 `.global.test.tsx` 提供双站渲染邻居。
- `frontend/openspec/changes/` 精确搜索首月六折、首单免费、促销标签未命中。
- 国内与国际站聚焦测试 106/106 通过；i18n 检查通过；TypeScript diagnostics 166 current、171 baseline、0 new；Next.js 生产构建和构建后 SEO 检查通过。
- 全量 Vitest 运行约 4 分钟，输出大量仓库既有 mock 日志后单 worker 持续占用约 100% CPU 且无结果汇总；停止该进程，不能声明全量测试通过。

## risks
- 静态未登录国内站报价经页面规则换算；判断标签时必须使用最终展示价与对应原价。回滚为本分支代码撤销。

## validation
- 聚焦国内与国际站订阅页测试。
- 前端 `check`、`test`、`build` 门禁；文档与 change impact 检查。

## decisions
- 按用户明确预期，以当前卡片展示的原价和实付价认定优惠；`discount` 只作历史兼容字段，不能单独证明优惠。
- “首单免费”必须校验新用户资格；既有测试要求已订阅用户若真实询价恰为六折，仍展示六折标签。

## scan_scope
- `frontend/next-site/subscribe-page.tsx`、相邻测试与订阅 OpenSpec 文档。

## scan_output
- 有界 `rg` 输出已用于上述证据，无隔离产物。

## handoff
- OPT-001 本地实现和聚焦验证完成；全量测试未得到最终汇总。按新队列交付规则，此项先完成预览、提交前 CR 和 MR 准备，再等待用户确认创建 MR。OPT-002 在此期间保持排队。

## code_review
- 对照 `origin/master` 审查了订阅价格与标签映射、询价切换渲染、回归测试。促销标签只由卡片展示的原价、实付价及首购资格决定；询价切换时渲染层隐藏旧标签。
- 检查新增代码未引入 `any`、密钥、外部依赖或新的网络调用；未发现阻断性问题。
- 仍需预览验证国内和国际站；全量 Vitest 未取得最终汇总，见上方证据。

## checkpoint
### stage
- OPT-001 本地修复和必要聚焦验证完成，正在推进预览交付；OPT-002 等待本项 MR 确认。
### verified
- 双站订阅页聚焦测试 106/106、类型检查 0 new、构建与 i18n 检查通过。
### unverified
- 全量 Vitest 无最终汇总，单 worker 长时间持续占用 CPU；后续若需 Git 交付应明确报告。
### discard
- 国内站按套餐名/后端 `discount` 直接写死六折的旧逻辑。
### restore
- 代码在 `frontsandbox/subscribe-promotion-badge-20260929`；队列记录在 `codex/optimization-queue-20260929`。
### next_action
- 推送预览分支并验证预览地址，准备指向 `master` 的 MR 草稿，等待用户确认后创建 MR。
