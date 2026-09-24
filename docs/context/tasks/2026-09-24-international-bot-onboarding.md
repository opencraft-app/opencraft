---
id: international-bot-onboarding-2026-09-24
type: task
scope: 开放国际站 Bot 创建引导与总览，保留国际模板和技能来源。
triggers: ["international bot onboarding", "国际站创建引导", "国际站总览"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - wiki/prd-docs/2026-09-24-international-bot-onboarding.md
  - frontend/src/pages/marketing/agent-onboarding-mark.ts
status: active
reviewed_at: 2026-09-24
review_due: 2026-10-24
revision: 1.0.0
precedence: task
derived: false
---

## goal
开放国际站已有 Bot 创建引导与总览，保留国际站模板来源。

## non_goals
- 不改支付、套餐、后端 API、技能目录、生产或 GitOps；不强制存量 Bot 重新引导。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户确认方案 A、存量用户默认总览，并要求核对已有国际模板后启动。
- `wiki/prd-docs/2026-09-24-international-bot-onboarding.md`。

## interface_refs / data_structure_refs
- `IS_BUDDY_ONBOARDING_ENABLED`、`resolveTemplatesForRegion`、`buildBuddySetupPlan`；技能安装必须定向目标 profile。

## history_context
- current_design_refs：`docs/engineering/domains/site-environment-routing.md`。
- relevant_evolution：master@995687c82 已开放国际多 Bot 创建入口，创建引导仍仅 isCN 开启。
- superseded_refs：历史国际站回落旧弹窗和通道默认页的说明。

## acceptance
- 国际订阅/首个/额外 Bot 引导、目标总览、存量默认总览及模板来源正确，门禁有证据。

## affected_paths
- frontend 创建开关、注释、测试；OpenCraft 机械副本；PRD、正式设计和本 Task Pack。

## required_context
- site-environment-routing、subscription-entitlements、前端服务与生成层边界。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@995687c82` | 根边界 | 授权与门禁 |
| `frontend/AGENTS.md@995687c82` | 前端规范 | check/test/build |
| `docs/context/domains/site-environment-routing.md@995687c82` | 站点范围 | 区分源码与线上 |
| `docs/context/domains/subscription-entitlements.md@995687c82` | 订阅入口 | 保留权益约束 |
| `docs/context/project/services/ctl.md@995687c82` | 先前多 Bot 调研 | 后端不在变更范围 |
| `ctl/AGENTS.md@995687c82` | 先前多 Bot 调研 | 公共网关边界 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@995687c82` | 邻接卡 | 模板、开关和测试邻居 |
| `docs/context/tasks/TASK-TEMPLATE.md@995687c82` | 任务契约 | 状态记录 |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md@995687c82` | 恢复契约 | 交接记录 |
| `docs/engineering/domains/site-environment-routing.md@995687c82` | 正式设计 | 同步区域规则 |
| `opencraft/AGENTS.md@995687c82` | 生成层约束 | 官方同步脚本 |
| `opencraft/MONO2_MIGRATION.md@995687c82` | 生成权威 | frontend 为真源 |
| `docs/context/project/upstream-subtrees.md@995687c82` | 同步边界 | 不做上游历史操作 |
| `.agents/context/change-impact.json@995687c82` | 影响映射 | 正式文档要求 |
| `docs/context/flows/tapd-gongfeng-delivery.md@8ebf501bc` | 本轮 MR 交付 | 授权、鉴权与交付门禁 |
| `AGENTS.md`、`opencraft/AGENTS.md`、`opencraft/MONO2_MIGRATION.md`、`docs/context/project/upstream-subtrees.md` 的 `995687c82..8ebf501bc` 差异 | 合并后复核 | 新增规则不触发镜像发布或运行时变更 |

## evidence
- 最终聚焦测试 10 文件 152 条通过；国际构建环境的模板/安装测试 4 文件 75 条通过。
- pnpm check：171 条 baseline TypeScript 诊断，0 条新增；pnpm build:global 成功。
- 国际站 6 条新组件测试覆盖订阅回跳、首个/额外 Bot、存量总览、额度与目标 profile 的 skills.sh 安装及最终跳转。
- 全量 pnpm test 出现多个失败，剩余 worker 无输出超过两分钟后中止，未取得完整汇总。相关恢复用例单独聚焦重跑通过。
- 在 HEAD@995687c82 的独立 worktree 重现续费测试相同 5 个失败，以及模型配置 84 个失败（共 89 失败/20 通过）；不将所有全量失败都推断为基线。
- 文档验证 0 错误/0 告警，变更影响与 git diff --check 通过。staged 检查为空集，另用显式 changed-file 检查真实源码范围。
- OpenCraft 官方同步与 130 文件漂移检查通过，无生成文件差异。
- Context audit 单测 33 通过；context 单测 26 中 4 失败，catalog 在基线亦失败。新 Task Pack 与 checkpoint 补齐 metadata 后重新检查。
- 初始模板区域、locale、可执行计划与安装命令测试 4 文件 75 条通过。
- 根 native 发现不相关共享 change，未接管；按前端服务范围在 frontend 启动独立 change。

## risks
- 默认总览与国际模板来源须同时验证；真实安装需后续预览/生产实例验证。

## validation
- 聚焦 Vitest；pnpm check/test/build:global；OpenCraft 漂移；context 文档与影响检查。

## decisions
- 用户选择全量复用，保持国际模板；沿用用户指定分支和工作区，保留已有 next-env.d.ts 改动。

## scan_scope
- frontend/src/pages/marketing 创建引导、模板、测试及生成层。

## scan_output
- 国际站 7 个模板；6 个 skills.sh 技能引用、1 个 GitHub 技能引用；国内专属 3 模板过滤。

## handoff
- 本地实现完成；PRD 和验证证据可审阅。全量测试及 context 基线门禁未全绿，保留 verify 状态；未 commit/push/MR/TAPD/发布。

## multilingual_followup
- 用户提供英文总览截图，要求整体走查并消除多语言混杂。
- 原因：useHeroStats 调用未传 locale；总览两条动态标题未被 t 字面量提取器收录。
- 范围：总览日期/动态/资料编辑、创建引导/模板/进度，以及语言切换。模板写入语义保持技能标识不变。
- 用例矩阵及后续 HTML 报告：/tmp/lightvela-intl-i18n-924/。
- 已读 .agents/skills/lightvela-web-validation/SKILL.md 与 .agents/skills/product-skills/lightvela-changelog-update/SKILL.md；复用此前读取的站点 Domain、前端 AGENTS 与邻接卡。

- 本次额外发现：创建头像 aria-label 为中文，资料编辑使用内部形状 id；统一在渲染时获取当前语言名称。
- 新增 11 个词条，覆盖全部 7 个 locale，OpenCraft 词典经官方同步并通过漂移检查。
- 最新验证：4 测试文件 93 条通过，pnpm check 0 新类型错误，build:global 成功；英文真实组件样例浏览器走查截图留存。
- 国际模板英文正文属于现有配置数据，非英文 UI 下仍显示英文。已询问展示/写入策略，未收到选择；保持原配置与技能来源并在报告中标明待决项。
- 额外读取 .agents/skills/fixing-accessibility/SKILL.md，用于修复头像辅助名称；未改动交互结构。

## merge_and_review
- 用户明确授权拉取合并 master、CR 后提交与创建 MR；2026-09-24 已快进合入 origin/master@8ebf501bc，恢复未提交改动无冲突。
- CR 覆盖开关消费者、存量与新增 Bot 路由、profile 隔离、区域模板安装源、日期 locale、动态翻译提取和生成词典同步；未发现本次差异引入的阻断问题。
- 新测试的导入路径按 frontend 规范统一为别名。保留本地 next-env.d.ts 与字体文件改动，不纳入本需求提交。
- 合并后聚焦测试 14 文件 234 条通过；国际环境模板与安装计划 4 文件 74 条通过。前端 check 0 新类型错误，build:global 成功，文档与 OpenCraft 漂移检查通过。
- 既有全量测试/context 失败及非英文模板配置展示边界继续公开记录，不能将聚焦验证表述为全仓门禁通过。

## mr_4655_review_fixes
- 用户授权修复 MR !4655 评论并重新提交。沿用原分支与 MR，不创建重复 MR。
- 评论 1033941608：轮播移除非空断言，越界索引回落首项、空列表不渲染卡片；指示器与展示索引保持一致，所有 hooks 保持无条件执行。
- 评论 1033759400：国内模板查找移除非空断言；找不到带技能的模板时明确失败，不继续访问 skills。
- 评论 1033783095：头像名称改为 switch，未知持久化形状 id 回落到本地化水母名称，与头像绘制默认值一致。
- 新增未知头像名称、轮播末项循环和手动选择暂停回归；本轮 3 测试文件 90 条通过。最新验证日志：/tmp/intl-bot-review-fix-924/。

- 本轮 check 无新增类型错误，国际 build:global 成功，文档检查通过。源码提交后刷新 OpenCraft sourceRevision，并以提交后的漂移检查为准。
