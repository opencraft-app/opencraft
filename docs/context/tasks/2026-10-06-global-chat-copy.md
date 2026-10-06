## goal
统一国际站 Agent Chat 入口、列表、删除弹窗及相关设置说明的英文用户文案，聊天列表分组标题使用 “Chats”。

## non_goals
- 不改变会话创建、删除、确认行为或 API。
- 不重写登录会话、运行时 session、统计成就及其他语种文案。
- 不合并 MR、发布或更改生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 本轮用户请求：确定使用 “New chat”，并将弹窗及其他相关页面统一。
- 后续用户确认：左导航红框内的分组标题由 “Chat” 改为 “Chats”。
- 后续用户授权：提交合并请求。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-settings-page.tsx`：Chat 导航、列表状态及删除确认弹窗。
- `frontend/src/pages/marketing/agent-common-settings-panel.tsx`：会话操作确认设置及弹窗。
- `frontend/src/i18n/generated/zh-to-key.json`、`en-US.json`：中文 key 到英文用户文案。
- `opencraft/scripts/sync-mono2-agent-console.mjs`：嵌入式 Chat 的前端字典同步。
- `opencraft/apps/workbench-web/src/app.tsx`：嵌入式 Composer 的 `/new` 命令说明。

## history_context
- `current_design_refs`：`frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md`。
- `relevant_evolution`：左导航已有 `Default chat`，工作台新建按钮已有 `New chat`；英文词典仍混用 conversation/session。
- `superseded_refs`：无。

## acceptance
- Chat 加号和 Bot 卡片新建入口均显示或朗读 `New chat`。
- 左导航 Chat 分组英文标题显示 `Chats`，单个条目保留 `Default chat`。
- 嵌入式 Composer 的 `/new` 命令说明显示 `New chat`。
- Chat 列表、删除弹窗、相关设置的英文文案统一使用 chat，保留 `{{name}}` 等占位符。
- 变更通过 i18n、同步、类型、构建及相关聚焦测试；全量测试异常按 evidence 记录。

## affected_paths
- `frontend/src/i18n/generated/en-US.json`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/i18n/generated/en-US.json`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json`
- `opencraft/apps/workbench-web/src/app.tsx`
- `docs/engineering/domains/agent-gateway-runtime.md`
- 本 Task Pack。

## required_context
- `frontend-product-surface`、`identity-access`、`site-environment-routing`、`agent-gateway-runtime`、`upstream-subtrees`、`service-opencraft`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@working-tree` | 前端边界与门禁 | 确认 i18n 真源和验证要求 |
| `docs/context/domains/identity-access.md@working-tree` | 路由器命中 session | 区分登录会话和 Chat 文案 |
| `docs/context/domains/site-environment-routing.md@working-tree` | 国际站 locale 边界 | 限定英文词典范围 |
| `frontend/AGENTS.md@working-tree` | 最近服务规则 | 确认前端门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | i18n 邻接 | 检查生成入口与测试邻居 |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md@working-tree` | 既有设计 | 核对 New chat 既有口径 |
| `frontend/src/i18n/index.ts@working-tree` | 字典加载方式 | 确认 en-US 用于国际站 |
| `frontend/scripts/i18n-extract.mjs@working-tree` | 生成流程 | 保持中文 key 稳定 |
| `frontend/scripts/i18n-apply.mjs@working-tree` | 翻译写入 | 使用脚本更新英文译文 |
| `frontend/src/pages/marketing/__tests__/agent-fleet-overview.test.tsx@working-tree` | 相邻测试 | 核对 Bot 卡片新建入口 |
| `docs/context/domains/agent-gateway-runtime.md@working-tree` | OpenCraft 路由 | 识别嵌入式 Chat 边界 |
| `docs/context/project/upstream-subtrees.md@working-tree` | 上游边界 | 仅在 mono2 修改 OpenCraft |
| `docs/context/project/services/opencraft.md@working-tree` | 服务门禁 | 确认 OpenCraft 验证 |
| `opencraft/AGENTS.md@working-tree` | 最近服务规则 | 确认生成层与 Renderer 规则 |
| `opencraft/docs/README.md@working-tree` | 正式文档入口 | 确认独立服务责任 |
| `docs/engineering/domains/agent-gateway-runtime.md@working-tree` | 正式设计 | 记录跨前端与 OpenCraft 的用户文案约定 |
| `opencraft/apps/workbench-web/src/embedded-chat/embedded-chat-root.tsx@working-tree` | 实际调用链 | 确认嵌入式 Chat 复用 App |

## evidence
- `pnpm check`：通过；i18n、繁简字典、文档同步及类型检查均通过（类型诊断 0 new）。
- 聚焦前端测试：4 个文件、123 个测试通过，覆盖词典、Bot 卡片、Chat 侧栏及设置。
- `Chats` 调整后再次运行 `pnpm check`、`pnpm build:global`、OpenCraft 同步/i18n 检查，均通过；额外加入的 Labs 导航测试文件触发 Vitest worker OOM，其余 4 个文件、123 个测试通过。
- `pnpm build:global`：通过，含 Next.js 编译、静态页面及 EdgeOne 产物检查。
- `npm run check:mono2-agent-console`、`npm run check:i18n`、`npm run test:i18n`、`npm run typecheck --workspace @opencraft/workbench-web`：通过。
- OpenCraft 聚焦测试：`conversation-recovery` 和 `embedded-companion-locales` 共 3 个测试通过。
- `npm run build:embedded-workbench:release`：通过。
- `validate_change_impact.py --repo . --staged`：通过，命中并更新 `agent-gateway-runtime` 正式设计文档；`validate_documentation.py --repo . --format json`：通过，无断链或告警。
- `pnpm test`：全量运行中多个其他模块失败并触发 Node 约 4 GB heap OOM，随后中断；本次关联的聚焦测试独立通过。

## risks
- 同一中文 key 可能用于多个 Chat 表面；修改前检查引用，修改后核对生成副本。可回滚英文词典改动。

## validation
- 前端运行 `pnpm check`、聚焦测试、`pnpm test`、`pnpm build:global`；`frontend/package.json` 无独立 lint script。
- OpenCraft 运行同步与 i18n 检查、i18n/聚焦测试、受影响 workspace 的 typecheck、嵌入式构建。
- 曾暂存当前变更运行 `validate_change_impact.py --repo . --staged`，检查通过后已还原为未暂存工作区状态。

## decisions
- owner：用户选择 `New chat`，随后选择左导航分组标题 `Chats`。本轮只统一与 Agent Chat 对象直接相关的英文用户文案。
- `t("对话")` 在当前源码仅用于 Agent 页的 Chat 导航分组、折叠导航与移动端标签；同一英文 key 改为 `Chats`，中文及其他语种不变。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-common-settings-panel.tsx`
- `frontend/src/pages/marketing/agent-fleet-overview.tsx`
- `frontend/src/i18n/generated/`
- `opencraft/apps/workbench-web/src/app.tsx`

## scan_output
- 英文词典中的 UI 文案 key 清单见本轮命令输出；无独立扫描产物。

## handoff
- 源码与构建完成；用户已授权提交 MR，尚未授权合并或发布。登录态浏览器实页未验证。
