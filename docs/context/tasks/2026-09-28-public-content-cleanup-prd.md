---
id: public-content-cleanup-2026-09-28
type: task
scope: 双站公开内容清理与临时下线的实现、验证记录。
triggers: ["双站内容清理", "文档暂时下线", "Blog 入口隐藏"]
owner: jasminzhao
authority: primary
source_of_truth:
  - wiki/prd-docs/2026-09-28-public-content-cleanup.md
status: active
reviewed_at: 2026-09-28
review_due: 2026-12-27
revision: 1.0.0
precedence: task
derived: false
---

# 双站公开内容清理：实现与交付

## goal
按已确认 PRD 实现双站 Blog 入口隐藏、文档过期口径清理、指定文章下线及国内套餐 Markdown 修复，并完成本地验证、代码审查、远程提交与 MR 交付。

## non_goals
- 不发布、不合并 MR、不创建外部需求单，不修改套餐或计费规则。
- 不处理已有 next-env.d.ts 和 coffee-warmup 任务文件改动。

## requirement_ids / requirement_refs / requirement_excerpt
- 来源：本任务用户 2026-09-28 的四项需求及站点范围回复。
- R1：国内站、国际站均隐藏 Blog 入口（已确认）。
- R2：国际文档站整体排查过期内测、公测和 2026-08-18 未来计费口径；双站隐藏付费版本公告，双站概览清理测试期口径。
- R3：隐藏国际站安全边界、拟人对话、Skill 场景、WhatsApp 24/7 客服四篇文章。
- R4：修复国内站管理套餐月付、季付说明中的 Markdown 渲染问题。
- 已确认 PRD：wiki/prd-docs/2026-09-28-public-content-cleanup.md。

## interface_refs / data_structure_refs
- frontend/src/config/docs-sidebar.ts：双站侧栏及 slug 映射。
- frontend/scripts/sync-fumadocs-content.mjs：区域注册、描述与各语言生成入口。
- frontend/next-site/docs-route-manifest.ts：当前生成的语言和路由。
- 隐藏导航与取消页面访问是不同产品行为，须先明确。

## history_context
- current_design_refs：frontend/openspec/specs/blog.md、docs/engineering/domains/site-environment-routing.md。
- relevant_evolution：当前分支基于 e704ced30941ac3f7fb03eca61cbcbd34c8b2cc2；国内概览已无公测、内测关键词。
- superseded_refs：无。

## acceptance
- 已确认 PRD 的行为验收在本地通过：双站入口、下线、文案、索引、反链与时长渲染；AC8 的 check/build 通过，完整 test 门禁仍受下述基线失败和运行错误限制。
- 必须运行 check、test、双站 build；如基线门禁未通过，记录对照证据，不宣称全部通过。

## affected_paths
- 预期产品稿：wiki/prd-docs/。
- 后续实现候选：frontend/src/components/site/lightvela-footer.tsx、frontend/src/content/docs/、frontend/src/config/docs-sidebar.ts、frontend/scripts/sync-fumadocs-content.mjs。

## required_context
- subscription-entitlements、frontend-product-surface；frontend/AGENTS.md。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md（用户提供） | 根边界 | 授权、路由与任务状态 |
| docs/context/domains/subscription-entitlements.md@2.0.0 | 路由 must_read | 仅修文案，不改变权益 |
| docs/context/project/services/frontend.md@2.1.0 | 路由 must_read | 文档真源与验证边界 |
| docs/context/flows/tapd-gongfeng-delivery.md@2.0.0 | MR 路由 must_read | 鉴权、授权和交付门禁 |
| frontend/AGENTS.md@e704ced30 | 服务入口 | 后续 check/test/build 要求 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0 | 邻接检查 | 核对 Footer 实现及其相邻测试 |
| frontend/openspec/specs/blog.md@e704ced30 | 现有设计 | Blog 路由与入口事实 |
| docs/context/tasks/TASK-TEMPLATE.md@2.1.0 | 任务模板 | 记录调研与决策 |
| docs/context/tasks/CHECKPOINT-TEMPLATE.md@2.0.0 | 检查点模板 | 保存下一步 |
| docs/engineering/domains/site-environment-routing.md@e704ced30 | 路由影响映射 | 同步文档下线与 Blog 入口策略 |

## evidence
- 已运行 validate_context.py --route，读取全部 must_read。
- 有界 rg 命中四篇文章的国际站侧栏、slug 映射及同步注册。
- 国际站过期口径命中 overview、quickstart、create-first-hermes、who-is-lightvela-for、contact-us、公告与生成描述；英文也存在。
- 国内 plans.md:57 存在用户指出的相邻加粗标记写法，尚未做视觉复现。
- 已检查 lightvela-footer.tsx 及其 __tests__/lightvela-footer.test.tsx；当前共享产品栏包含 Blog。

## risks
- 仅隐藏侧栏仍可能通过旧链接、搜索与正文交叉链接访问内容。
- 国际站需检查当前实际发布语言；不能只改中文源。
- 过期测试期文案与当前有效试用权益需区分，不能推断取消现行活动。

## validation
- pnpm check 通过；类型诊断 171 条均属于既有基线，无新增。
- 112 项聚焦测试通过，覆盖文档下线、六种国际源语言的结构与链接一致性、页面片段、共享 Footer、SEO 及国内时长的实际 Markdown 渲染。
- pnpm build:cn 与 pnpm build:global 通过。导出分别检查 214 / 1256 份 HTML：无下线页面或链接、搜索与 sitemap/llms 无下线目标、非 Blog 页无 Blog 导航、Blog 直接访问产物保留。
- 国际静态导出 HTTP 验证：40 个下线 URL 返回 404，概览与 Blog 返回 200。国内套餐实际 HTML 含两个正确 strong 元素。
- 44 份修改源稿共 327 处相对引用检查，缺失目标 0。
- 完整 pnpm test 未通过：3920 通过、121 失败、13 跳过；22 个文件失败、2 项运行错误。一个 CPU 持续占用且数分钟无进展的 worker 已终止后才输出汇总；不能宣称完整运行正常结束。
- 在 HEAD e704ced30 的隔离 worktree 中复核：20 个失败文件与当前分支独立运行均为 120 项失败，失败名称集合完全一致；另外两个套件加载错误（node:test bundling、readLocaleFromPath mock）同样复现。onboarding 恢复用例在独立运行时两边均通过。
- 本轮 PRD 已落盘；validate_documentation.py 返回 errors=[]、warnings=[]、broken=[]；PRD 结构和格式自检通过，git diff --check 通过。
- Context audit 的 33 项单元测试通过；Context 契约 26 项中 4 项失败在未修改基线同样复现。build-catalog 仍报已有历史文档错误，当前两份 Task 文件已补齐 schema，最终输出无本任务错误；审计脚本正常执行。
- validate_change_impact.py --changed-files-file（本次实际变更清单）通过，命中 site-environment-routing 且已同步正式设计；--staged 也已执行但暂无暂存文件，不作为变更集证据。

## decisions
- 输入状态：想法输入；三个关联交付组：Blog 入口、文档内容与公告、指定文章和格式修复。
- R1 站点为双站，入口隐藏不自动扩大为 Blog 页面下线。
- 已比较暂时下线与仅隐藏入口两种方案；用户选择暂时下线：指定文档入口、站内搜索、索引及正文引用均移除，旧链接返回 404，保留源稿。

## scan_scope
- frontend/src/content/docs、frontend/src/config/docs-sidebar.ts、frontend/scripts/sync-fumadocs-content.mjs、frontend/src/components/site、frontend/next-site、frontend/openspec/specs。

## scan_output
- 使用 rg 输出定位，未产生独立扫描文件；摘要见 evidence。

## handoff
- 用户明确要求直接按 PRD 启动修改，跳过外部建单；当前在既有 jasminzhao-optimization-0928 分支实施。
- 已移除目标文档三类注册及 Blog 入口，清理六种国际源语言的旧口径与公开反链，修复国内套餐 Markdown 并同步文档。
- 本地实现、聚焦验收与双站构建完成；全量测试限制如上。首轮验证时尚未提交、推送、建 MR 或发布；后续交付见 review_and_delivery。
- 台账标为待下线，不把本地实现当作生产发布。原有 next-env.d.ts 已按备份恢复；构建产生的字体变化在基线也完全一致，已去除该无关变更。
- 详细日志与导出证据位于 /tmp/lightvela-content-cleanup/；用户后续已授权评审、提交、推送与 MR；生产发布需单独授权。

## review_and_delivery
- 用户已明确授权 CR、commit、push 和创建 MR。目标为 master，保留原分支名。
- CR 发现快速开始和开通指南仍有未来计费标题、中文概览表格也有遗漏；已补充回归断言。最新 origin/master@cd7b64cc4 的 !4687 已修复该类口径，采用其六语种概览、快速开始、开通指南、适用人群及印尼套餐文案，避免覆盖已合入成果。
- 保留本次指定文档下线策略；公告源稿保留，但不再保留公开路由。
- 合并 cd7b64cc4 并解决注册、元数据与正文冲突后，pnpm check、112 项聚焦测试、双站完整 build 再次通过；214 / 1256 份导出 HTML、搜索及公开索引检查通过，40 个国际旧 URL 再次返回 404。合并结果无待解决 CR 问题；全量测试限制仍如 validation 所述。
