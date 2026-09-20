---
id: account-plans-billing-split
type: task
scope: 账号与套餐费用页面拆分及双站文档更新
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

## goal
基于最新 master 拆分账号与套餐费用页面，保留 /agents 左侧导航底部的账号菜单位置。

## docs_followup
- 用户要求同步更新 lightvela.com/docs 与 lightvela.ai/docs 的内容和截图。
- 范围：国内账号、快速开始、套餐、首次开通文档；国际套餐中文、英文、印尼语、西班牙语、日语、韩语源，以及生成的繁体与各语言产物。
- 保留现有文档 slug，不修改套餐定价与支付规则，不发布。
- 已通过浏览器确认现网账号页仍为合并版本；用户回复“可以”，确认采用本地新版界面与演示数据截图。替换国内账号/实名 4 张旧图，新增国内套餐与国际双页面中英文 5 张图片，文档明确标注演示状态，不宣称线上已更新。

## non_goals
- 不改付款、实名、区域门禁或 Agent 布局；不发布。

## requirement_ids / requirement_refs / requirement_excerpt
- MR !4310；用户在本任务明确要求拆分账号/套餐费用，并确认修复 CR 意见。
- 用户截图 2 与本任务：左侧导航底部 hover 菜单提供“账号”和“套餐与费用”。

## interface_refs / data_structure_refs
- frontend/src/lib/agent-routes.ts；现有 Session、Pass、支付方式 contract 不变。

## history_context
- current_design_refs: docs/engineering/domains/site-environment-routing.md
- relevant_evolution: 最新 origin/master 4debe57e1 已有 UserAvatarMenu variant=sidebar；旧预览 c42acf642 缺少 832 个主干提交。
- superseded_refs: 原 lightvela 工作区的旧版本预览，不能作为布局基线。

## acceptance
- /agents 底部菜单包含两个链接；账号与费用内容分离；CN/global checks 与浏览器验证。

## affected_paths
- frontend/src/components/site/user-avatar-menu.tsx
- frontend/src/pages/marketing/account-page.tsx
- frontend/next-site/account-page-client.tsx
- frontend/src/app/(site)/account/
- frontend/src/lib/agent-routes.ts、seo-data*.ts、i18n/generated/

## required_context
- frontend-product-surface、service-frontend、site-environment-routing

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md | 仓库规则 | 隔离与验证 |
| frontend/AGENTS.md | 服务规则 | check/test/build |
| frontend/DESIGN.md | UI 规则 | 复用现有菜单 |
| docs/context/project/services/frontend.md | 服务路由 | UI 边界 |
| docs/context/domains/site-environment-routing.md | 区域路由 | 双站验证 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 相邻测试与生成物 | i18n 生成 |
| docs/engineering/domains/site-environment-routing.md | 当前正式设计 | 同步页面边界 |
| .agents/skills/product-skills/lv-docs/SKILL.md | 文档维护规则 | 双站、语言与截图边界 |
| .agents/skills/product-skills/lv-docs/references/docs-rules.md | 文档生成与图片规则 | 注册、链接与截图核对 |
| docs/context/flows/tapd-gongfeng-delivery.md | 用户授权提交 MR | 交付权限与远端状态确认 |
| .agents/skills/gongfeng/SKILL.md | 工蜂操作规则 | 鉴权、创建 MR 与状态回查 |

## evidence
- git fetch origin master；独立工作区 codex/account-plans-billing-split。
- 无匹配 query: frontend account billing split agents sidebar user menu；精确文件路由成功。

## risks
- 旧目录混有其他任务改动，保留原目录，仅在新工作区重做本任务范围。

## validation
- 聚焦账号/侧栏测试、pnpm check、双站构建、5176 浏览器验证。

## decisions
- 路由仍为 /account 和 /account/billing；沿用主干侧栏布局、支付方式默认可见规则。
- 订阅异常的套餐管理/续费入口迁到 billing，创建前实名与邮箱回调留在 account。RenewPassModal 自带实名子流程，不依赖账号资料卡。
- OpenCraft 仅机械同步本 MR 触及的路由、八份翻译字典及对应 manifest hashes；其余已有漂移不纳入本 MR，全量同步检查仍单列失败边界。

## scan_scope
- frontend/src/components/site、frontend/src/pages/marketing、frontend/next-site、frontend/src/lib。

## scan_output
- 最新主干侧栏已有 variant=sidebar；只更新菜单内容，不迁移旧版布局代码。

## handoff
- 已基于 master 4debe57e1 完成；用户已授权提交 MR，不包含合并或发布。
- 104 项账号/菜单/SEO 测试通过；第二组 81 项页面拆分与侧栏回归通过（部分与第一组重叠）。
- pnpm check 通过：0 new TypeScript diagnostics；国内、国际 build 均成功。
- 文档检查、change-impact 与 diff check 通过。
- 本地 CN mock 预览运行在 5176；已确认 1440x1000 桌面侧栏底部账号菜单，账号页不显示订阅。
- 交付前刷新 origin/master，与本分支基线一致；工蜂鉴权成功，同源分支无 opened MR。重跑 6 个账号/菜单/文档测试文件，128 项通过。
