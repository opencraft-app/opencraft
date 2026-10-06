## goal
统一国内站与国际站 Agents 侧栏 Bot 卡片呈现：国际站沿用头像角标状态，并将两站卡片高度略微缩小。

## non_goals
- 不改变 Bot 状态判定、后端状态或国内站状态显示。
- 不合并 MR、不发布或部署。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-06 提供国内站与国际站截图，要求国际站红框内状态显示参考国内站新版。
- 用户随后要求两站 Bot 框稍矮，并在改完后提交 MR。

## interface_refs / data_structure_refs
- `OpenClawBot.status`、`getBotStatusColor`、`getBotStatusLabel`：沿用现有状态与文案映射。

## history_context
- `current_design_refs`：`docs/context/domains/site-environment-routing.md`；当前 `agent-settings-page.tsx` 与 `styles.css`。
- `relevant_evolution`：`frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md` 是旧版侧栏定位参考，行号与当前源码不同。国内站已有 `.lv-agent-avatar--status` 和 `.lv-agent-avatar-status`，国际站仍显示名称下的在线行。
- `superseded_refs`：无。

## acceptance
- 国际站运行中 Bot 的状态点位于头像右下角，名称下无 Online 行。
- 国际站非运行中 Bot 仍有状态文字，头像点与状态一致；国内站现有结构保持。
- 两站桌面 Bot 卡片上下内边距各减少 2px，折叠侧栏的专用尺寸不变。
- 聚焦测试、前端检查与差异检查通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `frontend/src/styles.css`
- `frontend/src/pages/marketing/__tests__/agent-settings-nav-spacing.test.ts`

## required_context
- `site-environment-routing` Pack；前端服务入口；前端运行时邻接卡。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@2.0.0` | 双站行为边界 | 只调整国际站可见呈现，分别验证 |
| `frontend/AGENTS.md@working-tree` | 服务门禁 | 运行聚焦测试及前端检查 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 测试邻接 | 检查现有侧栏测试与 OpenSpec |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md@working-tree` | 侧栏历史设计 | 定位 profile 块，避免改动导航 |

## evidence
- 源码定位：同一 profile JSX 中，国内站启用头像状态点，国际站显示第二行状态。
- `pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`：37/37 通过。
- 页面挂载测试首次触及 4 GB Node 堆上限；仅选两个新增用例、16 GB 堆上限重试时内存继续增长至约 9 GB，未进入断言，已停止。
- 未完成断言的页面挂载用例未纳入提交；改为既有轻量侧栏测试中的头像状态结构守卫。
- `pnpm check`：通过，TypeScript 当前 166、基线 171、新增 0。
- `pnpm build:global`、`pnpm build:cn`：均通过；构建生成的 `frontend/next-env.d.ts` 噪声已恢复。
- 本地 `pnpm dev:global` 监听 5174，`/agents/chat/` 返回 HTTP 200；Chrome 实际显示“请先登录”，无法验收已登录侧栏。预览服务已停止并释放端口。
- `validate_documentation.py --repo . --format json`：退出码 0，首方链接断裂 0、未分类文档 0。
- 双站共用的桌面 profile 卡片为 44px 最小内容高度加上下各 6px padding 与边框；本轮把 padding 改为上下各 4px。
- 本轮 `agent-settings-nav-spacing.test.ts` 与 `agent-settings-sidebar-tabs.test.ts`：45/45 通过；`pnpm check`：通过、新增类型诊断 0；`pnpm build:global` 与 `pnpm build:cn`：均通过。
- `npm --prefix opencraft run check:mono2-agent-console`：130 个同步文件校验通过，无需生成副本。
- 本轮文档验证：首方链接断裂 0、未分类文档 0。

## risks
- 已暂停、创建中或重启状态可能丢失文字；保留原有非运行中条件并用侧栏结构守卫检查。

## validation
- 页面挂载测试因内存异常未能完成，故未纳入提交；已用既有轻量侧栏测试守住头像角标和在线态不显示副标题。
- 本轮侧栏源码守卫、`pnpm check`、双站构建、OpenCraft 同步检查、文档检查与 `git diff --check` 已通过。

## decisions
- 复用国内站现有头像状态点与样式，不增加新的区域分支或样式。
- 两站共用同一高度规则；只压缩外层卡片垂直 padding，不改头像或状态行排版。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/styles.css`、相邻测试与 `frontend/openspec/changes/`。

## scan_output
- 有界 `rg` 定位见本任务执行记录。

## handoff
- 用户已授权 commit、push 和提交 MR；本轮本地验证完成，待远端核验。国际站已登录页面的浏览器视觉验收待执行；本地地址仅出现登录门禁。
