---
id: mr4879-pending-payment-account-scope
type: task
scope: MR !4879 待支付提示按账号隔离。
triggers: ["mr4879 pending payment", "待支付提示跨账号"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-02-mr4879-pending-payment-account-scope.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-10-09
revision: 1.0.0
precedence: task
derived: false
---

# Task Pack：待支付提示账号隔离

## goal
修复 MR !4879 的待支付提示在同一标签页切换账号后可能显示给另一账号的问题。

## non_goals
- 不改变下单、订单查询、权益轮询或支付回跳协议。
- 不清理本轮无功能影响的孤儿 i18n key，不发布或合并 MR。

## requirement_ids / requirement_refs / requirement_excerpt
- [wisp/mono2!4879](https://git.woa.com/wisp/mono2/-/merge_requests/4879) `d1c4290a3` 复审：`sessionStorage` 只保存套餐 ID，退出登录未清除；要求绑定用户 ID 并在读取时校验。

## interface_refs / data_structure_refs
- `frontend/next-site/subscribe-page.tsx`：`lv-pending-payment-plan` 是提示恢复标记，不是支付凭证；权益状态仍以服务端为准。
- `frontend/src/domain/types.ts`：`User.id` 为 string；仅在鉴权就绪、已认证且有用户 ID 时显示或写入提示。

## history_context
- `current_design_refs`：`docs/engineering/journeys/account-to-agent.md` 与 `docs/context/tasks/2026-10-01-pricing-modal-ux-followup.md`。
- `relevant_evolution`：MR 当前 head `d1c4290a3` 保留弹窗关闭后通过 sessionStorage 恢复待支付提示的能力。
- `superseded_refs`：旧的仅存套餐 ID 记录无法归属账号，读取时视为无效。

## acceptance
- 账号 A 的待支付提示在 A 的页面刷新或重开弹窗后可恢复。
- 同一页面实例切换到账号 B，A 的提示立即不可见；退出登录后提示和存储记录被清除。
- 旧格式记录不展示给任何账号；国内与国际订阅页聚焦测试通过。

## affected_paths
- `frontend/next-site/subscribe-page.tsx`
- `frontend/next-site/__tests__/subscribe-page.test.tsx`
- `frontend/next-site/__tests__/subscribe-page.global.test.tsx`
- `docs/context/tasks/2026-10-02-mr4879-pending-payment-account-scope.md`

## required_context
- `site-environment-routing`、`service-frontend`、`subscription-entitlements`、`tapd-gongfeng-delivery`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@user-provided` | 仓库边界 | 确认 Task Pack、验证和提交权限 |
| `frontend/AGENTS.md@d1c4290a3` | 服务规则 | 确认前端门禁 |
| `docs/context/domains/site-environment-routing.md@2.0.0` | 双站边界 | 保留国内、国际共同逻辑 |
| `docs/context/project/services/frontend.md@2.1.0` | 前端服务 | 选择聚焦测试与类型检查 |
| `docs/context/domains/subscription-entitlements.md@2.0.0` | 支付状态权威 | 待支付记录只作提示 |
| `docs/context/flows/tapd-gongfeng-delivery.md@2.0.0` | MR 交付边界 | 不擅自提交或推送 |
| `.agents/skills/gongfeng/SKILL.md@working-tree` | 工蜂入口 | 读取 MR 信息 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 邻接卡 | 检查前端测试和 OpenSpec 邻居 |
| `frontend/openspec/plan.md@d1c4290a3` | 前端规划邻居 | 确认未命中当前支付提示设计 |
| `docs/engineering/journeys/account-to-agent.md@d1c4290a3` | 当前旅程 | 保持权益生效再进入 Agent |
| `docs/context/tasks/2026-10-01-pricing-modal-ux-followup.md@1.2.4` | MR 历史 | 保留弹窗与支付回跳恢复语义 |
| `frontend/src/domain/types.ts@d1c4290a3` | 用户结构 | 使用 User.id 绑定记录 |

## evidence
- MR 页面显示源分支 `codex/prd-pricing-onboarding`，本地拉取 head 为 `d1c4290a35cb7c913c2cb9126df48148739502c9`。
- `git grep` 在该 head 确认待支付记录只存套餐 ID，读写点均在 `subscribe-page.tsx`。
- 同页切换账号和退出登录的测试确认旧提示立即不可见；支付等待弹窗切换账号的测试确认旧支付上下文不会写到新账号。
- 国内、国际订阅页聚焦 Vitest 2 文件 122/122 通过。
- `pnpm check` 通过：六个目标语种完整，类型检查 166 项现有诊断、171 项基线、0 新增。
- `pnpm build:cn` 与 `pnpm build:global` 均通过，分别生成 106 与 623 个静态页面。
- 文档校验 0 错误、0 断链、0 未分类；`git diff --check` 通过。

## risks
- 旧格式提示无法恢复；其归属账号不可验证，安全地忽略。
- 本地回归可覆盖同页账号切换，真实支付仍需有测试账号的端到端联调。

## validation
- `cd frontend && pnpm exec vitest run next-site/__tests__/subscribe-page.test.tsx next-site/__tests__/subscribe-page.global.test.tsx --maxWorkers=2`：122/122 通过。
- `cd frontend && pnpm check`：通过，包含 i18n、生成内容和类型检查；0 新增类型诊断。
- `cd frontend && pnpm build:cn`、`pnpm build:global`：通过。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：通过。
- `git diff --check`：通过。`frontend/package.json` 未定义 lint 脚本，依赖中也无 ESLint/Biome 命令。

## decisions
- 用包含 `userId` 和 `planId` 的记录替换旧格式，渲染时再次校验当前账号，避免切换账号后的单帧误显。
- 鉴权未就绪时不清除记录；确认退出登录后清除。
- 进行中的支付上下文也携带所属账号；账号变化时关闭旧弹窗、停止对应轮询，防止重新写入新账号。

## scan_scope
- `frontend/next-site/subscribe-page.tsx` 及两个订阅页聚焦测试。

## scan_output
- 未扫描其他服务；账号隔离缺口位于订阅页本地提示状态。

## handoff
- 本地修复与验证完成；未做真实跨账号支付实测。用户已确认更新 MR；远端交付状态以 MR 源分支和检查结果为准。
