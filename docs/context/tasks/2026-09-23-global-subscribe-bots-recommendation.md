---
id: task-global-subscribe-bots-recommendation-2026-09-23
type: task
scope: 国际订阅页同步国内已确认的 Bot 权益与 AI 推荐标签。
triggers: ["global subscribe bots", "国际订阅推荐", "国际 Bot 数"]
owner: walkercao
authority: primary
source_of_truth:
  - frontend/next-site/subscribe-page.tsx
  - frontend/src/lib/bot-quota.ts
status: active
reviewed_at: 2026-09-23
review_due: 2026-12-22
revision: 1.0.0
precedence: task
derived: false
---

# 国际订阅页 Bot 数与推荐标签

## goal
在新分支将国内已确认的 Bot 数和 AI“推荐”方案覆盖到国际订阅页，提交独立 MR。

## non_goals
不改首页、价格、实际订单权益、活动配置、实例上限及国内显示。首单免费 1 个月和双站文档已在 !4522 合入，不重复实现。

## requirement_ids / requirement_refs / requirement_excerpt
- requirement_ids：!4522 后续国际展示补齐；无 TAPD ID。
- requirement_refs：[!4522](https://git.woa.com/wisp/mono2/merge_requests/4522)；用户当前会话授权新分支，独立需求链接 unknown。
- requirement_excerpt：用户询问国际站“包括 bots 数量、标签、推荐”，获知 Bot 数与推荐尚未覆盖后，要求“新起一个分支覆盖下吧”。

## interface_refs / data_structure_refs
- subscribe-page.tsx：mapBundleToPlan / buildPlaceholderPlans / PlanCard。
- bot-quota.ts：Launch / Launch AI 每实例 5 个 Bot，Cruise / Cruise AI 每实例 10 个 Bot；复用现有固定映射。
- Bundle.agent_quota 和 PlanInfo.maxBots 仍为 Hermes 实例数量上限。

## history_context
- current_design_refs：frontend/DESIGN.md、frontend/openspec/config.yaml、docs/context/domains/subscription-entitlements.md。
- relevant_evolution：!4522 已合入 origin/master@2fc50c1ca，新分支 codex/global-subscribe-bots-recommendation 从该提交创建。
- superseded_refs：docs/context/tasks/2026-09-23-cn-subscribe-free-month.md 中“Bot 与推荐仅国内”的范围由本次授权扩展。

## decisions / plan
- 国际 Bot 数值只显示数量；复用通用“个”会被英/印尼/韩字典翻译成 Agent，故保留国内量词、国际省略量词。
- 沿用已批准设计：AI 积分选项旁的粉色纯文字“推荐”，无新增边框或交互；两站复用现有翻译与 colors.recommendationText。
- 1. 先更新国际测试：匿名/登录、AI/标准档均展示 5/10 Bot，只有 AI 选项带推荐，保留一月活动与价格断言；确认旧实现失败。
- 2. 移除 Bot 展示、占位卡及推荐的国内限定，复用同一映射和组件。
- 3. 运行双站组件、配额、字典检查及 pnpm check / 国际构建，检查 diff，再提交 MR。

## acceptance
国际 Launch / Launch AI 显示 Bot 数 5，Cruise / Cruise AI 显示 10；切换标准档后 AI 选项仍保留推荐，标准档不带推荐。活动角标、价格及实例创建门禁不变。

## affected_paths
frontend/next-site/subscribe-page.tsx、frontend/next-site/__tests__/subscribe-page.global.test.tsx、本 Task Pack。

## required_context
subscription-entitlements、frontend-runtime-openspec-i18n。

## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| AGENTS.md、frontend/AGENTS.md | 开发门禁 | 范围及验证 |
| docs/context/domains/subscription-entitlements.md@2fc50c1ca | 路由 must_read | 区分 Bot 与实例数 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@2fc50c1ca | 相邻测试和字典 | 复用翻译与 Vitest |
| frontend/openspec/config.yaml@2fc50c1ca | 双站共用页面 | 区域行为不扩展到计费 |
| docs/context/tasks/2026-09-23-cn-subscribe-free-month.md@2fc50c1ca | 已确认设计与前次范围 | 仅追加国际展示 |

## evidence / validation
- 测试先行：匿名国际 Bot 数断言在旧实现失败（Agent 行尚未替换）。
- pnpm test 双站 subscribe、agent-context-quota、dictionaries：4 个文件，98 项通过；覆盖登录态四档、7 语言翻译及后端实例上限不受 Bot 展示影响。
- pnpm check：通过；171 个既有 TypeScript 诊断、0 新增；i18n 校验无错误。
- pnpm build:global：通过，664 个静态路由及 HTML / SEO 后处理完成。
- Playwright 浏览器复测：7 种语言 × 320/390/768/1440px 共 28 组均无页面/标签溢出，每页 2 个推荐标签；人工查看 320px 印尼语截图通过。临时证据 /tmp/global-bots-browser.json、/tmp/global-bots-id-id-320.png，不提交生成物。
- 文档链接校验 errors=[]；变更影响校验、git diff --check 通过。
- 构建字体子集差异已恢复。

## risks
首次浏览器检查发现国际推荐长译文在 320px 的等宽选项中溢出；国际选项改为按内容分配宽度并缩小移动端内边距，保留既有文字样式。回滚本次提交即可恢复国际原显示。

## scan_scope / scan_output
订阅页、双站测试、Bot 配额与对应字典；国际当前仍显示 Agent 实例数且 isCN 门禁隐藏推荐。

## handoff
实现与验证完成，进入提交和 MR 交付；沿用独立 worktree cn-subscribe-free-month/mono2，新分支 codex/global-subscribe-bots-recommendation；不合并 MR、不发布。
