---
id: account-plans-billing-split-checkpoint
type: task
scope: 账号与套餐费用拆分任务的验证和交接状态
triggers: ["account billing split", "MR 4310", "billing navigation"]
owner: pablozhong
authority: primary
source_of_truth:
  - frontend/src/pages/marketing/account-page.tsx
  - frontend/next-site/subscribe-page.tsx
status: active
reviewed_at: 2026-09-20
review_due: 2026-12-19
revision: 1.1.0
precedence: task
derived: false
---

## stage
MR !4310 已提交；用户确认的 CR 修复已完成本地验证，待追加提交，不合并或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- MR !4310；修复套餐入口迁移遗漏，补齐回归测试与任务元数据，核对本 MR 生成副本。

## interface_refs / data_structure_refs
- frontend/src/lib/agent-routes.ts 的 ACCOUNT_PATH、ACCOUNT_BILLING_PATH；Session、Pass contract 不变。

## history_context
- current_design_refs: docs/engineering/domains/site-environment-routing.md
- relevant_evolution: 51e192cbd 拆分视图后，subscribe-page.tsx 仍保留旧订阅跳转，需纠正。
- superseded_refs: c42acf642 旧预览不可作为当前基线。

## context_receipt
- docs/context/tasks/2026-09-20-account-plans-billing-split.md 中记录本任务完整 context_receipt。
- 本轮读取 frontend/AGENTS.md、frontend service / site-environment-routing packs，以及 opencraft/AGENTS.md、MONO2_MIGRATION.md、upstream-subtrees.md，约束修复与机械同步范围。

## verified
- 基线 origin/master 4debe57e1，独立 worktree lightvela-account-plans-billing。
- /agents 账号入口沿用 variant=sidebar，底部向上弹出两个页面链接。
- check、双站 build、聚焦测试与文档/change-impact 检查通过。
- 本地端口 5176 已从旧工作区切换至新 worktree，NEXT_PUBLIC_AUTH_API_BASE_URL=mock。

## unverified
- 真实登录与支付服务端流程、线上发布时间，不由本次 mock 预览证明。
- 现网 lightvela.com/account 仍为合并布局；本次截图经用户确认使用本地新版演示状态，不代表生产版本或真实订阅状态。

## discard
- c42acf642 旧分支布局及旧工作区预览，不再作为本任务基线。

## restore
- 新工作区 /Users/pablozhong/codex/lightvela-account-plans-billing；原工作区所有未提交内容保留。
- CN dev server 5176、global dev server 5177；routes /agents/、/account/、/account/billing/、/docs/account/（国内）、/docs/plans/。
- 临时构建缓存使用被忽略的 .next/docs-cn 与 .next/docs-global，避免 Tailwind 扫描独立未忽略目录。

## next_action
- 将 CR 修复追加到原 MR !4310，回查远端 SHA、合并性与 CI；合并或发布仍需另行明确授权。

## docs_verified
- 10 篇 Markdown 已更新，国内 4 篇、国际套餐 6 种源语言；slug 与注册表未改。
- docs:sync 同步 534 篇产物；docs-last-updated 与 international-docs-parity 两文件共 64 项测试通过。
- 截图之前逐条检查 76 处本地引用，0 死链（未去重）；新增图片均已生成，docs:sync 成功解析并复制。
- pnpm check 通过，0 new TypeScript diagnostics；同时修正本任务测试中不受 Testing Library 支持的 exact 参数，账号页 32 项测试通过。
- 用户已回复“可以”批准本地演示数据截图；替换国内账号/实名 4 张旧图，新增国内套餐、国际账号与套餐中英文 5 张图。截图没有真实身份、支付信息、浏览器外框或调试面板。
- 浏览器已确认国内 /docs/account/ 显示新版账号图及演示说明，/docs/plans/ 引用新套餐图；国际 /docs/plans/ 正常显示 Account 与 Plans & billing 英文配图。
- 生成物核对：en-us/id-id/es/ja-jp/ko-kr 使用 -en 图片，zh-sg/zh-hant 使用中文图片。实际截图为未订阅/未绑卡状态，文案已说明。
- 截图更新后重跑 docs:sync（534 篇）、64 项文档测试与 pnpm check 全部通过；172 current / 276 baseline / 0 new TypeScript diagnostics。未重跑全量双站构建，前述 build 证据属于产品拆分阶段。
- A 档工具文档保留摘要，新增入口前置、步骤、结果确认与失败提示；仅国内文档包含实名认证，支付卡说明仅写国际站。
- 价格、套餐规则和无关文档历史差异保持原样，不宣称已发布。
- MR 交付前刷新 origin/master，无基线漂移；工蜂鉴权成功，同源分支无 opened MR；重跑账号/菜单/文档 6 个测试文件共 128 项通过。

## cr_followup_verified
- 订阅 PASS_EXPIRED / PASS_ISOLATED 动作改到 /account/billing；五处提示及七语字典已同步；实名跳转仍为 /account。
- 新增实际 PlansBillingPage wrapper、账号 query 不在 billing 消费、账号回调仍生效、认证弹窗不跨视图泄漏的测试；国内两种续费错误目标及国际既有断言均覆盖。
- 最终六个聚焦测试文件 160 项通过，pnpm check 为 172 current / 276 baseline / 0 new；国内、国际完整 build 本轮均通过。
- 两篇任务文件完成 frontmatter 与内容契约；全仓 context errors 1792，本任务 0，恢复报告中的基线。documentation validator 无错误或警告。
- OpenCraft 使用同一同步脚本的临时有界执行版本，仅选择 lib/agent-routes.ts 和 i18n/generated 下八份本 MR 涉及字典，机械生成副本并更新对应 hash。九份输出逐字节一致；字典整文件生成会一并对齐源内既有翻译键。
- OpenCraft 全量 check 仍失败于既有 components/ui/scroll-area.tsx 漂移；全量 scratch 生成还会在既有 automations adapter 上失败。本轮没有修改这些业务文件或适配器，不宣称全量同步门禁通过。
- 曾因磁盘不足中断副本复制，清理本任务废弃临时构建缓存后已重生成并逐字节复核；无截图源或用户文件删除。
