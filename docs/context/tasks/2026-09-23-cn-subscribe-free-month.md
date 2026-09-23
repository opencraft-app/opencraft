---
id: task-subscribe-free-month-2026-09-23
type: task
scope: 双站订阅首月免费文案、国内 Bot 权益展示及多语言文档的 CR 修正。
triggers: ["subscribe free month", "首单免费一个月", "Bot 数权益"]
owner: walkercao
authority: primary
source_of_truth:
  - frontend/next-site/subscribe-page.tsx
  - frontend/src/lib/bot-quota.ts
  - frontend/src/content/docs/plans.md
  - frontend/src/content/docs/global/plans.md
status: active
reviewed_at: 2026-09-23
review_due: 2026-12-22
revision: 2.0.0
precedence: task
derived: false
---

# 双站订阅首月免费与 Bot 权益 CR 修正

## goal
处理原订阅页改动的 CR，统一双站 Launch / Launch AI 首单免费 1 个月文案及现有多语言文档，复用 Bot 配额定义，提交后续 MR。

## non_goals
- 不改变价格、活动资格、订单接口、实际发放时长或运行时配额，不查询或修改生产数据库。
- 用户明确选择“本轮只处理订阅页与文档”：首页旧活动文案留待后续处理。
- 不合并 MR、不部署。

## requirement_ids / requirement_refs / requirement_excerpt
- `requirement_ids`：MR !4513 后续 CR；无 TAPD 需求 ID。
- `requirement_refs`：[原 MR !4513](https://git.woa.com/wisp/mono2/merge_requests/4513)。本轮补充来自当前会话，独立需求链接 `unknown`。
- `requirement_excerpt`：用户确认“目前国内站、国际站免费已经确认为1个月”；追加“文档也得补齐国际的”。
- 原确认方案：国内 Launch / Launch AI 的 Bot 数为 5，Cruise / Cruise AI 为 10；AI 积分选项旁保留粉色纯文字“推荐”，不增加边框。
- 用户此前已授权合并 master、提交 MR；原 MR 已合并，本轮使用后续分支。

## interface_refs / data_structure_refs
- `frontend/next-site/subscribe-page.tsx`：`aiPromoTagText`、`mapBundleToPlan`、`buildPlaceholderPlans`、`PlanCard`。
- `frontend/src/lib/bot-quota.ts`：四个 bundle_id 的每实例 Bot 上限，供订阅页与 `agent-context.tsx` 创建门禁共用；未知套餐运行时 fallback 仍为 1。
- `bundle.agent_quota` / `PlanInfo.maxBots`：Hermes 实例数量上限。国内已知套餐展示的 Bot 数是每个实例内的 Bot 上限，不覆盖实例创建限制；国际站仍显示 Agent 数。未知套餐展示保留既有 fallback。
- `trade/internal/logic/placeorder/service.go`：`Mapping.TimeSpanUnit` 经 `parseDianshiTimeSpanUnit` 决定零元订单有效期，与询价周期分离。

## history_context
- `current_design_refs`：`docs/engineering/domains/subscription-entitlements.md`、`docs/context/domains/subscription-entitlements.md`、`frontend/DESIGN.md`、`frontend/openspec/config.yaml`。
- `relevant_evolution`：原实现 d44367416 经 !4513 合入 master（9984ddfbe）。本轮从 origin/master@52c8231d7 创建 codex/cn-subscribe-free-month-cr-fix；交付前快进合入 c3f88f8a6（仅 OpenCraft 发布记录变更）。
- `superseded_refs`：`docs/plans/2026-09-01-domestic-ai-launch-trial-design.md` 描述旧 3 天方案；历史 seed/test/migration 不作为当前生产活动证据，也不在本轮改写。

## acceptance
- 双站 Launch / Launch AI 符合既有零元首购条件时展示首单免费 1 个月；季付、非零询价与已订阅门禁保持原行为。
- 国内四套餐 Bot 数与创建门禁复用一份定义，占位卡不再硬写 10；实例配额语义不变。
- 国内 7 份、国际 global/en/id/es/ja/ko 各 6 份源文档同步；繁体由 global 自动生成。14 天数据保留、3 个工作日退款等非试用规则不变。
- 删除不再使用的 3/7/14 天角标字典 key；组件测试使用卡片可访问名称定位。
- pnpm check、聚焦测试、国内与国际构建、文档链接及变更影响检查。

## affected_paths
- frontend/next-site/subscribe-page.tsx、相关组件及价格一致性测试。
- frontend/src/lib/bot-quota.ts、frontend/src/contexts/agent-context.tsx。
- frontend/src/content/docs/、frontend/scripts/sync-fumadocs-content.mjs。
- frontend/src/i18n/generated/、frontend/docs/frontend-domestic-billing-flow.md。
- wiki/growth-state/lightvela-docs-content-categories.md、本 Task Pack。

## required_context
subscription-entitlements、service-frontend、frontend-runtime-openspec-i18n。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md、frontend/AGENTS.md@52c8231d7 | 服务入口 | 范围及验证门禁 |
| docs/context/domains/subscription-entitlements.md@52c8231d7 | 路由 must_read | 计费与权益权威边界 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@52c8231d7 | 相邻文档与测试 | i18n / 组件回归 |
| frontend/openspec/config.yaml@52c8231d7 | 双站前端设计 | 共用页面及区域分支 |
| .agents/skills/product-skills/lv-docs/SKILL.md@52c8231d7 | 双站文档维护 | 国际各语言源、繁体生成、日期和注册源检查 |
| .agents/skills/gongfeng/SKILL.md@52c8231d7 | MR 交付 | mcporter-internal 调用与鉴权 |
| docs/context/tasks/TASK-TEMPLATE.md@52c8231d7 | 修复 Task Pack | frontmatter 与契约字段 |
| .agents/context/change-impact.json@52c8231d7 | 变更门禁 | 检查正式设计同步范围 |

## evidence
- 活动时长依据为用户在本次 CR 会话的明确确认：国内站、国际站均已是 1 个月。
- 本轮未取得目标环境 SQL 查询结果或真实零元订单有效期证据，不把用户确认写成数据库核验结果；真实发放仍以服务端活动配置为准。
- 国际文档保留各区域独立内容，不将国内实名认证要求带入国际站。

## risks
- 将来活动变更必须同时同步服务端配置、订阅文案和文档。前端标签不控制发放时长。
- 首页仍保留旧活动文案，用户明确排除本轮范围。
- 回滚本次提交可撤销展示和文档修正；配额值及订单行为未改变。

## validation
- `pnpm check`：通过；171 个既有 TypeScript 诊断，0 新增；i18n 校验 0 错误、50 个既有警告。
- `pnpm test next-site/__tests__/subscribe-page.test.tsx next-site/__tests__/subscribe-page.global.test.tsx next-site/__tests__/plan-pricing-consistency.test.ts src/contexts/__tests__/agent-context-quota.test.ts src/contexts/__tests__/agent-context-source.test.ts src/i18n/__tests__/dictionaries.test.ts scripts/international-docs-parity.test.ts scripts/docs-last-updated.test.ts`：8 个文件，183 项通过。
- 初轮 2 个失败为旧测试预期（切回标准版移除标签、Launch AI 首购 6 折）；按已确认的首月免费事实修正后通过。文档日期测试同步前失败，同步后通过。
- 43 份源文档链接与图片目标未变；国内及国际 8 个路由语言目录共 49 个对应生成页包含 1 个月文案及 2026-09-23 日期。
- `pnpm build:cn` / `pnpm build:global`：均通过，静态 HTML 与 SEO 后处理完成；无关字体子集差异已恢复。
- `validate_documentation.py --repo . --format json`：通过，errors=[]。
- `validate_context.py --format json`：全仓 2439 个历史 Context 错误，本 Task Pack errors=[]；未改动无关治理文件。
- `validate_change_impact.py --changed-file ...`：通过，无强制设计同步命中。
- `git diff --check`：通过。
- 人工逐项复核 diff：未发现新增行为问题；独立审查任务因工具未传递任务内容而未执行，不计作独立审查通过。

## decisions
- 复用纯模块中的固定 Bot 数映射，保留 agent-context 原导出以兼容现有调用。
- 推荐文字 #B82E6B 收入页面 colors.recommendationText；不引入新的共享视觉模式。
- 提取字典后仅保留本轮废弃的三组 key 删除，避免清理无关历史条目。
- 国际站同步首月角标；推荐 Label 和 Bot 行重命名仍只适用于国内站。

## scan_scope
订阅页及其测试、Bot 配额模块、双站 docs 源与生成内容、活动时长处理入口。

## scan_output
受影响源文档 43 份；旧试用天数已清理，数据保留规则保留。

## handoff
- stage：CR 修正与验证完成，提交和 MR 交付。
- verified：双站订阅和配额回归、8 语言路由文档生成、字典、类型检查、双站构建、文档链接、变更影响检查。
- unverified：线上数据库 / 真实下单时长；浏览器截图（先前 CUA 鉴权不可用）。
- restore：独立 worktree cn-subscribe-free-month/mono2；分支 codex/cn-subscribe-free-month-cr-fix。
- next_action：完成验证，提交、推送并创建指向 master 的后续 MR。
