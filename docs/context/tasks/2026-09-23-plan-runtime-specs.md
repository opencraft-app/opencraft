---
id: task-plan-runtime-specs-20260923
type: task
scope: 同步双站套餐云端运行环境规格，并交付 Gongfeng MR。
triggers: ["plan runtime specs", "套餐云端运行环境", "MR 4546"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/content/docs/plans.md
  - wiki/product-state/geo-fact-table.md
status: active
reviewed_at: 2026-09-23
review_due: 2026-10-23
revision: 1.1.0
precedence: task
derived: false
---

## goal
同步更新 LightVela 国内站与国际站套餐文档中的云端独立运行环境规格，并在套餐说明页记录 2026 年 9 月 23 日起生效的规格升级。

## non_goals
- 不修改订阅页、后端套餐配置、计费、价格、存储或 AI 积分逻辑。
- 不执行合并、发布、GitOps 或生产变更。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求：将文档中的 `2 核 4G` 更新为 `2 核 8G`，将 `4 核 8G` 更新为 `4 核 16G`；套餐说明页增加生效日期与权益不变说明；完成后提交 MR。

## interface_refs / data_structure_refs
- `frontend/src/content/docs/**`：国内站与国际站各语言文档真源。
- `frontend/scripts/sync-fumadocs-content.mjs`：文档源到 Fumadocs 渲染产物的同步入口。
- 不变量：CPU 核数、套餐价格、存储容量与 AI 积分权益不变。

## history_context
- `current_design_refs`：`docs/context/domains/subscription-entitlements.md`、`docs/context/domains/site-environment-routing.md`。
- `relevant_evolution`：最新主干已包含国内站和国际站套餐、概览与付费公告的多语言源文件。
- `superseded_refs`：无。

## acceptance
- 所有目标文档不再把 Launch / Launch AI 写成 2 核 4G，或把 Cruise / Cruise AI 写成 4 核 8G。
- 所有套餐说明语言源均包含 2026 年 9 月 23 日生效的规格升级说明，并明确价格、存储和 AI 积分权益不变。
- `pnpm docs:sync`、`pnpm check`、文档链接/图片/区域适配检查与 `git diff --check` 通过。
- 推送 feature branch，创建 Gongfeng MR，并核对远端 SHA、MR 状态与 CI 即时状态。

## affected_paths
- `frontend/src/content/docs/{01-overview.md,plans.md,announcements/public-beta.md}`
- `frontend/src/content/docs/{global,en,id,es,ja,ko}/{01-overview.md,plans.md,announcements/public-beta.md}`
- `wiki/product-state/geo-fact-table.md`
- `docs/context/tasks/2026-09-23-plan-runtime-specs.md`

## required_context
- `subscription-entitlements`
- `site-environment-routing`
- `adjacency-frontend-runtime-openspec-i18n`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@28c01405d` | 仓库交付边界 | 使用独立 worktree、执行门禁并区分 MR 与发布 |
| `frontend/AGENTS.md@28c01405d` | 前端与文档服务门禁 | 选择 `pnpm check` 与文档同步验证 |
| `docs/context/domains/subscription-entitlements.md@2.0.0` | 套餐权益边界 | 仅更新已确认的展示文案，不推断后端状态 |
| `docs/context/domains/site-environment-routing.md@2.0.0` | 双站隔离边界 | 分别更新国内站与国际站源文件 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 多语言与生成物邻接 | 检查源文件、同步脚本和生成产物 |
| `.agents/skills/product-skills/lv-docs/SKILL.md` | 文档站工作流 | 同步多语言源、渲染产物及区域适配检查 |

## evidence
- 基线：`origin/master` / `28c01405d892c62808446b589c97f4c4c84ffee5`。
- `pnpm docs:sync`：通过，同步 548 篇文档。
- `pnpm check`：通过；i18n 错误 0，Fumadocs 生成成功，TypeScript 相对基线新增诊断 0。
- `pnpm vitest run scripts/docs-last-updated.test.ts scripts/international-docs-parity.test.ts`：2 个文件、64 项测试通过。
- `validate_documentation.py`：错误 0、断链 0、警告 0。
- 国内站目标文件相对链接与图片引用：16 项，断链 0；区域关键词与内部信息残留 0。
- `validate_context.py`：本 Task Pack 元数据错误 0；全仓既有 context/catalog 问题不在本 MR 扩展处理。
- `wiki/product-state/geo-fact-table.md`：环境规格事实同步为启航 2C8G+50G、巡游 4C16G+80G。
- `docs-image-assets.test.ts` 与全量 `doc-summary.test.ts` 在主干既有内容上失败：139 个历史大图、16 篇未改动的场景文档缺摘要；失败路径相对 `origin/master` 无 diff。

## risks
- 多语言遗漏会造成同一套餐在不同 locale 展示不同规格；通过全目录旧规格残留扫描和生成产物检查缓解。
- 公告与概览属于公开内容，错误替换可能改变其他权益；使用精确规格替换并复核目标 diff。
- 回滚方式：在 MR 合并前撤销本分支提交；本任务不执行合并或发布。

## validation
- `cd frontend && pnpm docs:sync`
- `cd frontend && pnpm check`
- 源文件与 `.fumadocs-content` 旧规格残留扫描
- 国内站链接、图片与区域关键词检查
- `git diff --check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- 区域为 `both`：用户要求“整体改完”，此前已确认官网文档包含国内站与国际站多语言页面。
- Launch / Launch AI 统一为 2 核 8G；Cruise / Cruise AI 统一为 4 核 16G。
- 升级说明只放在套餐说明页，概览与公告仅同步当前规格，避免重复公告块。

## scan_scope
- `frontend/src/content/docs/**/*.md`
- `frontend/.fumadocs-content/docs/**/*.mdx`

## scan_output
- 21 份手写源文件完成现行规格替换；概览与公告旧规格残留 0。
- 7 份套餐语言源中的旧规格仅保留在“由旧规格升级到新规格”的历史说明中。
- 升级说明覆盖 7 份手写源和 8 个生成 locale（含自动转换的 `zh-hant`）。
- `frontend/.fumadocs-content/docs/**` 仅作为本地生成物重跑 `docs:sync` 并检查，不纳入提交。
- `lightvela-docs-content-categories.md` 中套餐与付费公告的 CN/GLOBAL 状态已为 `✓`，无需改变状态。

## handoff
- 当前状态：实现与本地验证完成，Gongfeng MR !4546 为本任务交付载体。
- 下一步：等待 MR 评审；合并、发布与生产验证均需独立授权和证据。
- 阻塞项：无；两个扩展测试存在已确认与本次 diff 无关的主干存量失败。
