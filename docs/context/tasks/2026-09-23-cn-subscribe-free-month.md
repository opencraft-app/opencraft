# 国内订阅套餐活动、Bot 权益与推荐展示

## goal
按用户确认的方案调整国内 `/subscribe` 套餐展示，并创建指向 `master` 的 MR。

## non_goals
不调整价格、活动资格、实际订阅时长、订单接口、运行时配额、国际站展示或发布配置。

## requirement_refs / requirement_excerpt
- Launch / Launch AI 活动角标统一为“首单免费 1 个月”。
- 权益项“Agent”调整为“Bot 数”；按最新 master 定义，在订阅页写死 Launch / Launch AI 为 5，Cruise / Cruise AI 为 10。
- Launch AI / Cruise AI 积分数字旁添加纯文字“推荐”，采用用户确认的粉色小字方案。
- 用户已授权“合并 master，提交 MR”。

## interface_refs / data_structure_refs
- `frontend/next-site/subscribe-page.tsx`：`aiPromoTagText`、`mapBundleToPlan`、`buildPlaceholderPlans`、`PlanCard`。
- `frontend/src/contexts/agent-context.tsx::resolveBotQuotaPerAgent`：Bot 数量依据；本次只读取，不改变运行时配额。
- 保留 Bundle 价格、首单资格、订单请求与国际站分支逻辑。

## history_context
- 从 `origin/master@870d03dcb` 创建 `codex/cn-subscribe-free-month`。
- 2026-09-23 合入最新 `origin/master@0894abe59`，快进合并，无冲突。
- 国际站既有角标为 Launch 14 天、Launch AI 7 天。

## acceptance
- 国内 Launch 标准版及 AI 版均展示首单免费 1 个月。
- 登录前后、AI 与标准版切换时，四种国内套餐展示正确 Bot 数。
- “推荐”只位于国内 AI 积分选项内，切换标准版后仍保留，无额外边框、背景或独立点击区。
- 国际站 Agent 权益及原活动角标保持既有行为。

## affected_paths
- `frontend/next-site/subscribe-page.tsx`
- `frontend/next-site/__tests__/subscribe-page.test.tsx`
- `frontend/next-site/__tests__/subscribe-page.global.test.tsx`
- `frontend/src/i18n/generated/*.json`
- 本 Task Pack。

## context_receipt
- `AGENTS.md`、`frontend/AGENTS.md`：任务边界和验证要求。
- `frontend/openspec/config.yaml`：共用页面和站点分支机制。
- `frontend/openspec/plan.md`、`frontend/openspec/current_state.md`：历史任务状态。
- `.agents/context/change-impact.json`：本次展示、测试和字典路径不命中正式设计文档强制同步规则。
- `docs/context/tasks/TASK-TEMPLATE.md`、`docs/context/tasks/CHECKPOINT-TEMPLATE.md`：任务及交接记录格式。

## decisions / risks
- 国内四个 bundle_id 使用固定 Bot 数映射，其余套餐沿用原数量。未来套餐权益变更时需同步该展示映射。
- 推荐文字采用 #B82E6B、11px、500 字重，复用已有“推荐”翻译。
- 只新增“首单免费 1 个月”和“Bot 数”两个翻译 key，保留提取脚本会清除的既有无关条目。
- 浏览器截图验证未完成：CUA 返回 `Codex auth token is unavailable`。已用组件测试验证登录状态、切换行为及标签归属。
- 回滚本任务提交可撤销展示调整。

## evidence / validation
基于合入 `0894abe59` 后的代码执行：
- `pnpm test next-site/__tests__/subscribe-page.test.tsx next-site/__tests__/subscribe-page.global.test.tsx src/contexts/__tests__/agent-context-quota.test.ts src/contexts/__tests__/runtime-config-context.test.ts src/i18n/__tests__/dictionaries.test.ts`：5 个文件、100 项测试通过。
- `pnpm check`：通过；171 条既有 TypeScript 基线诊断、0 新增；i18n 校验 0 错误，保留既有非阻塞告警。
- `pnpm build:cn`：通过；静态 HTML 与 SEO 后处理完成。
- 独立只读代码审查：未发现可行动问题。
- 构建产生的无关字体子集差异不纳入提交。

## handoff / checkpoint
- stage：实现与合并后验证完成，进入已获授权的提交和 MR 交付。
- verified：国内展示、国际站回归、Bot 定义、运行配置回归、类型/i18n 检查与国内构建。
- unverified：浏览器截图验收。
- restore：使用独立 worktree 与分支 `codex/cn-subscribe-free-month`，保留原工作区改动。
- next_action：提交、推送该分支并创建目标为 `master` 的 MR；不合并 MR 或发布生产。
