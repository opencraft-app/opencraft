---
id: international-bot-onboarding-checkpoint-2026-09-24
type: task
scope: 国际站创建引导与总览开放任务的验证交接记录。
triggers: ["international onboarding checkpoint", "国际站引导交接", "国际站总览验证"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-24-international-bot-onboarding.md
status: active
reviewed_at: 2026-09-24
review_due: 2026-10-24
revision: 1.0.0
precedence: task
derived: false
---

## stage
本地实现与 CR 完成，处于 verify；用户已授权提交和创建 MR，全量门禁尚未全绿，未发布。

## verified
- 引导与模板聚焦测试合计 14 文件 227 条通过；包括国际模板安装计划和新国际流程组件测试。
- pnpm check 无新增类型错误；国际 pnpm build:global 通过。
- OpenCraft 130 文件一致性检查通过，无生成差异；文档和变更影响检查通过。
- HEAD 独立 worktree 重现续费相同 5 个失败与模型配置 84 个失败。
- Context audit 33 单测通过；context catalog 在基线存在大量既有问题。

## unverified
- 全量 pnpm test 多个失败并出现无输出 worker，已中止；未宣称全部失败都属于基线。
- Context 单测存在 4 个失败；新文档补齐 metadata 后需重新核对新增发现。
- 未执行真实实例安装、TAPD、提交、MR、生产发布。

## discard
- 不恢复根目录 whatsapp-one-bot-per-instance change；本需求在 frontend 内追踪。

## restore
- 分支 jasminzhao-createbot-intl-924，用户原有 next-env.d.ts 改动已按构建前备份恢复。
- PRD：wiki/prd-docs/2026-09-24-international-bot-onboarding.md。
- 原始日志：/tmp/intl-bot-onboarding-*；本地引擎状态：frontend/.workflow/native。

## next_action
MR !4655 已创建；用户授权修复 3 条评审意见并追加提交。完成本轮检查后推送到现有 MR；生产发布不在范围。

## requirement_ids / requirement_refs / requirement_excerpt
- 继承同目录 `2026-09-24-international-bot-onboarding.md` 与关联 PRD：国际站全量开放引导、默认总览，保留国际模板。

## interface_refs / data_structure_refs
- IS_BUDDY_ONBOARDING_ENABLED、resolveTemplatesForRegion、buildBuddySetupPlan；目标 profile 不变量见主 Task Pack。

## history_context
- current_design_refs：docs/engineering/domains/site-environment-routing.md。
- relevant_evolution：master@995687c82 仅国内引导开启，本次开放国际站。
- superseded_refs：国际站使用旧弹窗、默认通道页的历史说明。

## context_receipt
- 已读 context 的逐项路径与用途记录在同目录主 Task Pack 的 context_receipt；本 checkpoint 延续同一任务、无额外 context 输入。

## multilingual_followup
- 修复总览有效期缺少 locale、两条动态标题漏译、创建与编辑头像辅助名称未本地化；新增 11 个词条并补齐 7 种语言。
- 最新相关测试 4 文件 93 条通过（其中新多语言测试 24 条、国际流程测试 7 条）；pnpm check 171 baseline、0 新错误；国际构建成功。
- OpenCraft 翻译词典已通过官方脚本同步，130 文件漂移检查通过。
- 浏览器使用真实组件与样例数据走查，未获得账号登录态，未进行真实创建或写入。英文总览、创建、模板、编辑截图位于 /tmp/lightvela-intl-i18n-924/screenshots/。
- 国际模板正文仍是既有英文配置；非英文界面的模板展示语言与实际写入语言策略问题尚未收到用户回复，不能宣称所有页面所有语言均已消除混杂。
- 本地国际站已恢复运行于 http://localhost:5174，日志 /tmp/lightvela-intl-i18n-924/dev.log。

## delivery_review
- 已合入最新 master@8ebf501bc，无冲突；CR 未发现新增阻断问题。
- 合并后 14 文件 234 条聚焦测试通过，国际模板与安装测试 74 条通过，check 无新增类型错误，build:global 成功；其余最新日志 /tmp/intl-bot-mr-924/。
- next-env.d.ts 与字体文件保持本地状态并排除提交；合并前改动另存 stash 备份。

## review_followup
- MR：https://git.woa.com/wisp/mono2/-/merge_requests/4655；初次交付提交 d8c89f061。
- 已修复索引越界/空动态列表、测试模板缺失及头像名称兜底 3 条评论；3 文件 90 测试通过，check 无新增类型错误，build:global 成功。
- 最新日志 /tmp/intl-bot-review-fix-924/；继续保留并排除 next-env.d.ts 和字体的本地改动。

- 评审修复提交 9df17d567；官方同步脚本已将 OpenCraft sourceRevision 更新为该源码提交，130 文件一致性检查通过。
