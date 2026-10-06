---
id: 2026-10-06-multi-bot-chat-changelog
type: task
scope: 国内站与国际站 2026 年 10 月多 Bot 网页对话更新日志。
triggers: ["changelog", "multi Bot", "web chat"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - frontend/src/pages/marketing/changelog-page.tsx
  - frontend/src/pages/marketing/agent-settings-page.tsx
status: active
reviewed_at: 2026-10-06
review_due: 2027-01-04
revision: 1.0.0
precedence: task
derived: true
---

## goal
在国内站和国际站更新日志中增加 2026 年 10 月的多 Bot 网页对话条目。

## non_goals
- 不改动网页对话功能、创建 Bot 流程或发布状态。
- 不新增缺乏准确产品画面的配图。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求（2026-10-06）：两站增加 10 月 changelog，说明网页内可直接与主 Bot 之外的其他 Bot 对话。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/changelog-page.tsx` 的 `ChangelogMonthGroup` 静态列表。
- `frontend/src/i18n/generated/` 由 `pnpm i18n:extract` 生成；翻译沿用现有公开站点语言。

## history_context
- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md` 双站控制台 Chat 段落；`frontend/src/pages/marketing/agent-settings-page.tsx`。
- `relevant_evolution`：2026 年 9 月更新日志已介绍创建多个 Bot；10 月条目聚焦其他 Bot 的网页对话入口。
- `superseded_refs`：正式设计文档中“网页对话当前仅开放主 Bot”的旧口径需同步纠正。

## acceptance
- 双站 `/changelog` 首组显示 2026 年 10 月，文案准确描述其他 Bot 网页对话。
- 国际站各公开 locale 可读；国内站显示简体中文。
- 前端 i18n、lint、typecheck 与聚焦 changelog 测试通过。

## affected_paths
- `frontend/src/pages/marketing/changelog-page.tsx`
- `frontend/src/i18n/generated/`
- `docs/engineering/domains/site-environment-routing.md`
- 本 Task Pack。

## required_context
- `site-environment-routing`、`frontend-product-surface`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@e8a3641a2` | 仓库边界 | 确认双站、验证和提交限制 |
| `frontend/AGENTS.md@e8a3641a2` | 服务规则 | 确认前端验证门禁 |
| `docs/context/domains/site-environment-routing.md@e8a3641a2` | 双站边界 | 分别核对两站能力 |
| `docs/context/project/services/frontend.md@e8a3641a2` | 前端上下文 | 确认 i18n 与页面来源 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@e8a3641a2` | 邻接卡 | 检查 i18n 生成入口与相邻测试 |
| `frontend/src/i18n/index.ts@e8a3641a2` | i18n 邻居 | 确认生成字典消费方式 |

## evidence
- 源码 `openCraftChatEnabled = true`，活动 Bot 的 Chat 以其 `profileId` 加载；正式设计文档亦说明两站主 Bot 与其他 Bot 均进入 OpenCraft。
- 国内站与国际站的生产构建均通过；构建产物的 7 个站点/语言 changelog 页面包含 10 月月份和对应标题。
- `pnpm i18n:check`：6 个国际站译文字典均无缺口。

## risks
- 文案提前于线上发布：本任务仅更新源码，线上状态需另行核验。
- 现有 `channel-copy.test.tsx` 的 5 月 Soul 文案断言仍为“新会话”，页面已写“新对话”；聚焦测试全跑时 25/26 通过，此失败与本任务无关。

## validation
- `pnpm i18n:check`：通过，6 种必填译文缺口为 0。
- `pnpm check`：通过，TypeScript 基线 0 个新增诊断；i18n 结构校验 0 个错误。
- `pnpm lint`：`frontend/package.json` 未定义 lint 脚本，无法运行该命令。
- 聚焦 changelog 测试：国际站 12/12 通过；国内站多 Bot 测试 1/1 通过。
- `pnpm build`：国内站通过。
- `NEXT_PUBLIC_REGION=global VITE_REGION=global pnpm build`：国际站通过。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`：通过。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：通过，未发现断链。
- `python3 .agents/context/scripts/validate_context.py --build-catalog`：仓库内其他旧 Task Pack 大量缺元数据与契约字段，整体失败；本 Task Pack 单独按 schema 校验。

## decisions
- 10 月条目与 9 月“创建多个 Bot”分开；不复用旧 AgentChat 图片。

## scan_scope
- `frontend/src/pages/marketing/changelog-page.tsx`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/`
- `frontend/src/i18n/`

## scan_output
- 有界 `rg` 命中静态 changelog 列表、Chat 启用逻辑和本地化测试。

## handoff
- 源码、译文、正式设计文档已更新，主要门禁通过；用户已于 2026-10-06 明确授权提交 MR。合并与发布未授权。
