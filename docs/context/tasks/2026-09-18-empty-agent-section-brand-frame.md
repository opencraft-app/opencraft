## goal
让无 Bot 的 `/agents/channels/` 页面左上角 LightVela 品牌区域不再显示右边框和底边框。

## non_goals
- 不改变 `/agents` 根页面、已有 Bot 页面、品牌文字、导航和创建行为。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-09-18 截图：`/agents/channels/` 无 Bot 空状态左上角仍有边框；上一版已处理相似问题。

## interface_refs / data_structure_refs
- `AgentsPageClient` 在具名路由传入 `initialSectionSlug`，根路由不传。
- `AgentSettingsPage` 的无 Bot 空状态由 `!isModifying && !passesLoading && !isCreating && !botsLoading && visibleBots.length === 0` 控制。

## history_context
- `current_design_refs`：`frontend/DESIGN.md`；`docs/context/tasks/2026-09-17-empty-persona-brand-copy.md`。
- `relevant_evolution`：前次修复只对 `activeSection === "buddy"` 添加无边框样式，因此不覆盖截图中的 `channels` 路由。
- `superseded_refs`：无。

## acceptance
- 具名 Agent 页面进入无 Bot 空状态时移除品牌区域右、下边框；`/agents` 根路由和已有 Bot 页面保留原有样式。
- 聚焦测试、前端检查和构建通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/styles.css`
- `frontend/src/pages/marketing/__tests__/agent-settings-empty-persona.test.ts`

## required_context
- 路由器无匹配 Pack，已在相关路径有界精确搜索；参照前端邻接卡检查现有测试及历史设计。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@origin/master` | 服务门禁 | 确定验证命令 |
| `frontend/DESIGN.md@origin/master` | UI 约束 | 保留现有页面结构 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@origin/master` | 邻接关系 | 检查相关测试与路由 |
| `docs/context/tasks/2026-09-17-empty-persona-brand-copy.md@origin/master` | 上次需求范围 | 保留 `/agents` 根路由样式 |
| `docs/context/flows/tapd-gongfeng-delivery.md@origin/master` | MR 交付门禁 | 核对授权与远端状态 |
| `docs/context/flows/change-delivery.md@origin/master` | Task Pack 交接 | 记录最终验证与范围 |

## evidence
- 最新 `origin/master` 的无边框 CSS 仅匹配 `.lv-agent-empty-persona-page`；该 class 只在 `activeSection === "buddy"` 时出现。
- `/agents/channels/` 传入 `initialSectionSlug="channels"`，无 Bot 时使用相同空状态 UI。
- 聚焦测试 2 文件、9 项全部通过；`pnpm check` 通过，TypeScript 0 个新增诊断；`pnpm build:cn` 通过，生成 103 个静态页面。
- 本地 5174 国内站预览 `/agents/channels/` 返回 HTTP 200。Chrome 的 `127.0.0.1:5174` 页面使用 `/_next/static/` 开发资源；当前登录态有 Bot，右、下边框保持显示，无法在该账号直接验证无 Bot 截图状态。`lightvela.com` 页面加载版本化 `__releases` 资源，不作为本地验证证据。
- 全套 `pnpm test` 在模型配置、支付、文档等其他模块出现多项失败，一个 worker 高 CPU 且不再推进，已中止；不能视为全套通过。
- 文档校验通过，首方链接错误 0；`git diff --check` 通过。

## risks
- 多个具名页面共用 header；通过已有无 Bot 守卫限制覆盖，已有 Bot 时继续显示边框。

## validation
- `agent-settings-empty-persona.test.ts` 聚焦测试。
- `pnpm check`、`pnpm test`、`pnpm build:cn`；仓库没有独立 lint 命令。

## decisions
- 使用具名路由标识配合原有无 Bot 守卫，覆盖同类空状态，并保留之前明确要求不变的 `/agents` 根路由。

## scan_scope
- Agent 页面、头部样式、路由和相关测试。

## scan_output
- 精确搜索命中 `isEmptyPersonaPage`、CSS `:has` 选择器和相邻回归测试。

## handoff
- 用户已授权将本轮 UI 修复提交 MR。无 Bot 浏览器视觉确认仍待可用账号；本地源码与聚焦测试验证通过。MR 不代表已合并或发布。
