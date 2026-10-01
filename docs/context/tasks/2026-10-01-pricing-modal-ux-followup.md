---
id: pricing-modal-ux-followup
type: task
scope: MR !4879 的定价弹窗权益展示、多语言与购买前后分流回归。
triggers: ["pricing modal", "定价弹窗", "pricing onboarding"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-01-pricing-modal-ux-followup.md
status: active
reviewed_at: 2026-10-01
review_due: 2026-10-08
revision: 1.2.0
precedence: task
derived: false
---

# Task Pack：定价弹窗体验复核

## goal
在 MR !4879 中统一控制所有套餐的权益展开状态，简化弹窗视觉，并确保公开站的定价入口保留原有购买意图。

## non_goals
- 不调整套餐价格、权益、支付或 Bot 创建接口。
- 不改变顶部导航进入的独立定价页。
- 创建引导以当前 Bot 列表为准，不新增历史创建字段。
- 不部署、合并或变更生产配置。

## requirement_ids / requirement_refs / requirement_excerpt
- `wisp/mono2!4879`：用户反馈“同时展开收起”“框框有点多”“做多语言”，并要求排查定价到首个 Bot 的明显断点。
- `wiki/prd-docs/2026-09-30-pricing-modal-and-first-bot-onboarding.md`：普通转化入口打开精简弹窗；积分包、升级、支付回跳等整页查询意图必须保留。

## interface_refs / data_structure_refs
- `SubscribePage` 的 `embedded` 模式只展示精简套餐，完整页继续展示积分包。
- `/subscribe?section=credits`、`/subscribe?upgrade_pass_id=...` 和支付回跳参数属于独立页语义。
- `useT` 与 `frontend/src/i18n/generated/` 是用户可见文案的翻译入口。

## history_context
- `current_design_refs`：上述 PRD；`frontend/DESIGN.md` 的 View More / Collapse 规范；`docs/engineering/journeys/dual-site-request-routing.md`。
- `relevant_evolution`：MR !4879 的卡内展开状态彼此独立；公开站点击拦截原先只识别 `/subscribe` 路径。
- `superseded_refs`：原 PRD “历史上从未创建过 Bot 才进创建”口径；2026-10-01 用户改为“当前没有 Agent 就进创建”。

## acceptance
- 弹窗内只有一个可键盘操作的“查看全部权益 / 收起权益”入口；全部卡片一起展开、收起。
- 弹窗卡片不在悬停时出现粗黑双描边；完整定价页不受视觉改动影响。
- 弹窗关闭按钮、辅助标题和新增入口使用当前路由 locale；六种目标字典完整。
- 页头“免费试用”也在当前页打开定价弹窗；顶部导航“价格”仍进入独立定价页。
- 带查询参数、锚点、跨站来源或新标签页意图的订阅链接保留原导航行为。
- 登录后权益查询失败或超时时保留原页并提示重试；本次刷新完成前不使用缓存状态分流。
- 未登录时首页静态片段中的「我的智能体」页脚入口在权益与 CTA 改写就绪前隐藏。
- 国际站首页静态 Hero 中的「我的智能体」入口也在鉴权和 CTA 改写前隐藏。
- 从精简弹窗发起的登录，若仍未订阅，回到原页面的定价弹窗继续购买；顶部导航独立定价页仍保留原落点。
- `/agents` 权益加载失败后，用户可在原页重试，不必先返回首页。
- 未购买用户直达 `/agents` 时回首页；购买状态未确认时，首页主按钮、页脚、产品入口及“我的”下拉均不暴露智能体入口，定价页下拉同样遵循此规则。
- 服务端 Bot 列表查完后判断：当前没有 Bot 就打开创建界面，含以前创建后已删光的用户；中途退出后再次进入仍打开。过期老用户可用历史订阅进入管理页。
- 支付回跳已有 BOT 的用户进入正常列表；无法识别回跳套餐时给出订单状态待确认提示和账号页出口。
- 付款等待超时不声称已收到付款，避免用户误以为订单已确认。
- 聚焦测试、i18n 校验、类型检查、文档检查及 diff 检查运行并记录结果。

## affected_paths
- `frontend/next-site/{subscribe-page,pricing-modal,public-site-pricing-modal,public-header-auth-island,international-home-runtime,use-post-login-redirect,app-route-shell}.tsx`
- `frontend/next-site/__tests__/{subscribe-page,public-site-pricing-modal,public-header-auth-island,international-home-rendering,use-post-login-redirect}.test.tsx` 与 `frontend/next-site/app-route-shell.test.tsx`
- `frontend/src/contexts/agent-context.tsx` 与测试、`frontend/src/components/site/user-avatar-menu.tsx` 与测试、`frontend/src/pages/marketing/agent-settings-page.tsx` 与首次创建测试
- `frontend/src/lib/cta-journey.ts` 与测试；移除 `frontend/src/lib/bot-creation-history.ts` 及其测试
- `frontend/src/i18n/generated/*.json`
- `docs/engineering/journeys/dual-site-request-routing.md`
- `wiki/prd-docs/2026-09-30-pricing-modal-and-first-bot-onboarding.md`

## required_context
- `subscription-entitlements`：订阅和支付状态以服务端权益为准。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库边界 | 确认 Task Pack、验证与提交权限 |
| `frontend/AGENTS.md@working-tree` | 前端规则 | 确认 UI、i18n 与测试门禁 |
| `docs/context/domains/subscription-entitlements.md@2.0.0` | 路由命中的 Pack | 避免把弹窗状态当作支付结果 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 邻接卡 | 检查实现、测试和生成字典 |
| `frontend/DESIGN.md@working-tree` | 现行视觉规范 | 选用轻量展开入口 |

## evidence
- `validate_context.py --route 'frontend pricing modal subscription first bot onboarding user flow'` 命中 `subscription-entitlements`。
- 静态路径复核确认：`?section=credits` 和 `?upgrade_pass_id` 原先会误入不含积分包或升级上下文的弹窗。
- 本地 `zh-CN` 预览核对：免费试用在原页打开弹窗，单一入口同时展开/收起两张卡，关闭按钮固定可见，登录表单可聚焦；未触发真实支付。
- 定向 Vitest 7 文件 209 例通过（含国际订阅页和 `/agents` 门禁）；`pnpm check` 通过、0 新增类型错误；i18n 6 个目标语种均完整，结构校验 0 错误。
- 第二轮路径复核：国际站 Hero 静态入口与弹窗登录后的落点均发现主链路断点；支付回跳、门禁错误页也有断点，修复后相关用例通过。
- `pnpm check` 全链通过；文档校验 0 断链、0 未分类、0 警告；`git diff --check` 通过。
- 上一轮补充复核：公开站入口与门禁 4 文件 102 例通过；Bot 状态 26 例通过；首次创建“退出后重进”和“等 Bot 列表”2 例单独通过。服务端 `ListInstances` 测试证明软删除实例不在列表；类型检查 0 新增错误；文档与变更影响校验通过。
- 全量 `pnpm test` 已运行并出现多个改动范围外的失败（智能体设置侧栏、模型配置、渠道文案、诊断面板、首页静态资源脚本）；停止该轮执行。`pnpm build` 在 Next.js 优化编译阶段长时间无诊断输出，停止后构建结果未验证。
- `agent-settings-create-intent.test.tsx` 全文件一起执行时 worker 内存耗尽；新增的重入 2 例与原有的单个渲染用例分开执行通过，整文件结果未验证。
- 用户将创建引导口径改为“当前没有 Agent 就进入创建”后，移除浏览器历史标记；分流与门禁 7 文件 157 例、完整定价页 2 文件 115 例，以及删光 Bot 的支付回跳和创建重入定向用例通过。`pnpm check` 通过，0 新增类型错误。
- 最新路径走查发现页头“免费试用”按钮绕开链接拦截；已接入弹窗事件。10 文件 285 例主链路测试通过，页头、弹窗与通用站点页头 3 文件 49 例通过，空列表自动创建的两条定向测试通过。`pnpm check` 再次通过（0 新增类型错误），文档校验 0 错误。

## risks
- 首页「看全部场景」等指向 `/agents` 的静态链接仍经购买门禁；用户已确认保留拦截，未购买时回首页。
- 支付回跳只携带套餐 ID，没有携带原订单 `deal_name`；前端已有 `getOrderStatus` 接口，但新购回跳尚未用它核对订单。因此套餐信息变化时虽有错误提示，仍不能自动识别并承接原订单。

## validation
- `cd frontend && pnpm exec vitest run next-site/__tests__/{subscribe-page,public-site-pricing-modal,public-header-auth-island,international-home-rendering,use-post-login-redirect}.test.tsx --maxWorkers=2`
- `cd frontend && pnpm i18n:check && pnpm i18n:validate && pnpm i18n:zh-hant:check`
- `cd frontend && pnpm typecheck`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- `git diff --check`

## decisions
- 展开状态放在 `SubscribePage`，避免每张卡独立产生冲突状态。
- 完整定价页保持现状；仅对 `embedded` 卡片减弱装饰。
- 有查询参数或锚点的定价链接走完整页，保留现有深链接语义。
- 用户已确认当前无 Bot 即进入创建界面，删除全部 Bot 后重新进入创建是预期行为；历史订阅单独保护过期用户进入管理页。

## scan_scope
- `frontend/next-site/subscribe-page.tsx`
- `frontend/next-site/public-site-pricing-modal.tsx`
- `frontend/next-site/use-post-login-redirect.ts`
- `frontend/src/lib/cta-journey.ts`

## scan_output
- 弹窗展开状态、查询参数误拦截、页头免费试用跳错页、首页 Hero/页脚短暂暴露、弹窗登录丢失原页面、登录权益错误回退、门禁错误页无重试、支付异常反馈、已有 BOT 错误落点及创建中途退出后的重入均在本次修复；订单级回跳验证仍需后续处理。

## handoff
- 用户已明确授权提交并更新 MR；完成与最新 master 的合并、前端门禁和变更影响校验后推送。整文件测试曾内存耗尽、全量测试曾有改动范围外失败，需按本轮合并后的实际结果记录。
