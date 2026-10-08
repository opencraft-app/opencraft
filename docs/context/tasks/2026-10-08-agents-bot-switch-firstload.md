---
id: agents-bot-switch-firstload
type: task
scope: Separate post-merge fix for first-load Bot switching in the Agents console.
triggers: ["agents bot switch first load", "incognito bot switch"]
owner: pablozhong
authority: primary
source_of_truth:
  - wiki/prd-docs/2026-10-08-agents-bot-rail.md
status: active
reviewed_at: 2026-10-08
review_due: 2026-11-08
revision: 1.0.0
precedence: task
derived: false
---

## goal
将 Chrome 无痕首次打开 `/agents/chat` 时 Bot 头像无法切换的修复，从 !5099 拆为以 `master` 为目标的独立 MR。

## non_goals
- 不包含 !5099 的无 Bot 跳转、续费提醒和管理菜单修复；不合并、发布或改 GitOps。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户反馈首次打开 Chrome 无痕窗口时点击其他 Bot 头像，URL 不变；刷新后恢复。随后 Firefox 国内站首次打开也复现相同现象。要求新建 MR。
- `wiki/prd-docs/2026-10-08-agents-bot-rail.md`：头像切换进入目标 Bot 新建会话，重复点击当前头像不导航。

## interface_refs / data_structure_refs
- `AgentBotRail` 未选中头像 href 指向 `/agents/chat/?bot=<id>`；选中态由 `AgentSettingsPage` 读取 URL 的有效 Bot ID 决定。

## history_context
- `current_design_refs`: `wiki/prd-docs/2026-10-08-agents-bot-rail.md`。
- `relevant_evolution`: !5097 已合入 `master`；!5099 含其他独立修复，本 MR 仅承载 Bot 切换修复。
- `superseded_refs`: none。

## acceptance
- 未选中头像首次显示即为可导航链接；目标 URL 变化后选中态同步；当前头像不导航；国内与国际测试通过。
- 前端 `pnpm check`、聚焦测试、双站构建、OpenCraft 副本检查与文档门禁通过；新 MR 指向 `master`。

## affected_paths
- `frontend/src/pages/marketing/agent-bot-rail.tsx`、`agent-settings-page.tsx`、相邻测试、`frontend/src/styles.css`、对应 PRD。

## required_context
- `tapd-gongfeng-delivery`、`frontend-product-surface`；`frontend/AGENTS.md`、`frontend/DESIGN.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/flows/tapd-gongfeng-delivery.md@3fa43b017` | MR 交付边界 | 新分支与远端核验 |
| `docs/context/project/services/frontend.md@3fa43b017` | 前端服务边界 | 双站验证 |
| `frontend/AGENTS.md@3fa43b017` | 前端门禁 | check/test/build 与 OpenCraft 同步 |
| `frontend/DESIGN.md@3fa43b017` | 交互约束 | 头像链接与焦点样式 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@3fa43b017` | 相邻验证 | 检查相邻测试和 OpenSpec |
| `.agents/skills/gongfeng/SKILL.md@3fa43b017` | 工蜂工具契约 | 使用已配置连接，不暴露凭证 |

## evidence
- `origin/master` 为 `3fa43b017`；原修复提交 `388e5a042` 的前端与 PRD 差异已独立移入新分支，未包含 !5099 的其他改动。
- 相关行为测试：2 个文件 35 条通过；侧栏切换的定向断言 1 条通过。侧栏测试文件全跑为 1 红、74 绿，失败的创建引导计数断言在当前 `master` 同样存在，本次未改该逻辑。
- 独立依赖安装后 `pnpm check` 通过，TypeScript 诊断 166 current / 171 baseline / 0 new；国内与国际站构建通过；OpenCraft 同步检查、文档校验通过。

## risks
- 原生链接会完整加载目标对话页；上线后需分别用 Chrome 无痕窗口和 Firefox 首次打开国内站复验首次点击。

## validation
- 聚焦测试、`pnpm check`、`pnpm build:cn`、`pnpm build:global`、OpenCraft 同步检查、文档验证、staged change-impact。

## decisions
- 用原生 href 保证客户端路由未就绪时也可切换；修复仅限 Bot 头像路径。

## scan_scope
- `frontend/src/pages/marketing/agent-bot-rail.tsx`、`agent-settings-page.tsx` 及其相邻测试。

## scan_output
- bounded `rg` 显示头像点击、URL 同步与相邻双站测试位置。

## handoff
- 独立分支待 staged impact 检查、提交和创建 MR；未合并或发布。
