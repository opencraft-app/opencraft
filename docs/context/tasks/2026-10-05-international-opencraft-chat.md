## goal
将国际站控制台 Chat 切换到与国内站相同的 OpenCraft 内嵌会话，让内嵌界面跟随当前语言，并仅在浏览器控制台执行 `show()` 后显示国际站入口。

## non_goals
- 不改变 Agent 运行时、权限或发布环境。
- 不合并、发布或修改生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户本轮请求：国际站不再使用 AgentChat，改用 OpenCraft；多语言和 Chat 功能、交互对齐国内站。动手前同步远端 master。
- 用户后续要求：浏览器 F12 控制台执行 `show()` 后才展示 OpenCraft Chat；按国际站门禁实施，国内站默认展示。
- 用户已授权提交 MR，目标分支为 `master`。

## interface_refs / data_structure_refs
- `AgentChatMigrationSurface` 与 `EmbeddedWorkbenchConfig`；`region` 保持 `cn | intl`，会话事件和操作沿现有 bridge。
- OpenCraft `EmbeddedWorkbenchConfig.localization` 与 `setLocalization`，宿主语言来自 `useCurrentLocale()`。
- `frontend/release-matrix.json` 四个组合均已启用同源 OpenCraft 静态资源。
- `console-show-event.ts` 的持久化开关由 `installOpenClawConsoleHelpers()` 注册为 `window.show()`。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md`、`frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/pages/marketing/opencraft-embedded-workbench.tsx`。
- relevant_evolution: 初始基线 `origin/master@996b23c13` 国内站已启用 OpenCraft；同步后的 `origin/master@ebba1eacf` 新增双站会话分页差异和国内站侧栏状态展示，国际站原本仍由 `!isGlobal` 留在 AgentChat。
- superseded_refs: `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md` 描述旧 AgentChat 侧栏方案。

## acceptance
- 国际站 `show()` 前无 Chat 入口、会话侧栏读取或 OpenCraft 挂载；执行后主 Bot、非主 Bot 均显示 OpenCraft，再次执行后收起。
- 国内站继续默认显示 OpenCraft；两站均不请求 AgentChat launch token。
- 两站共用会话列表、创建、选中、重命名、删除、连接恢复和移动布局。
- 国际站现有语言进入 OpenCraft，并在语言变化时更新而不销毁会话。
- 聚焦测试、前端 check/test/build 与 OpenCraft 生成副本检查通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx`
- `frontend/src/components/site/chat-loading-state.tsx`
- 相邻测试、`docs/engineering/domains/site-environment-routing.md`

## required_context
- `site-environment-routing` Domain Pack；前端服务级 Agent 入口。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@996b23c13` | 双站功能边界 | 双站各自验证 |
| `frontend/AGENTS.md@996b23c13` | 前端门禁 | check/test/build 与生成副本检查 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@996b23c13` | 语言和前端邻接 | 读取 i18n 入口、历史 OpenSpec 和相邻测试 |
| `frontend/src/i18n/t.ts@996b23c13` | 当前路由语言 | 使用 `useCurrentLocale()` |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md@996b23c13` | 旧会话设计 | 识别已过时的 AgentChat 约束 |
| `frontend/src/lib/console-show-event.ts@996b23c13` | 现有控制台命令 | 复用持久化 show 门禁 |
| `frontend/src/lib/opencraft-embedded-connection.tsx@996b23c13` | 资源准备边界 | 国际站门禁关闭前无预连接 |

## evidence
- 初次 `git fetch origin master` 后从 `996b23c13b21144ef779b3df713cafe96f0749b1` 创建隔离工作树；再次拉取并同步到 `origin/master@ebba1eacf903f1dd2b1a98855a27eb69f67c4328`，原检出分支的未提交改动未触碰。
- 同步时 `agent-settings-page.tsx` 的会话分页代码发生一处文本冲突，已保留新版 `master` 的国际站 20 条、国内站 5 条分页规则，同时保留本次 OpenCraft 替换。国内站 Bot 状态与会话加载文案的新改动也已保留。
- 同步后五个相关测试文件 76/76 通过；`pnpm check` 通过，TypeScript 当前 166 个基线内诊断、0 个新增；`pnpm build:global`、`pnpm build:cn`、OpenCraft 生成副本检查和文档链接检查均通过。
- 同步后 `validate_change_impact.py --repo . --staged` 与 `git diff --check` 通过；检查后取消暂存，`git ls-files -u` 为空，工作树 HEAD 与 `origin/master` 均为 `ebba1eacf`。
- `pnpm exec vitest run` 四个 Chat 相关测试文件：72/72 通过，覆盖国际站 `show()` 开关、主 Bot、非主 Bot、语言、双站共用加载态与内嵌会话操作。
- `pnpm check` 通过；TypeScript 基线 166 个当前诊断、0 个新增。
- 首次 `pnpm build` 与 `pnpm build:global` 均通过；同步后两站构建再次通过，国际站静态生成 623/623 页，国内站 106/106 页。
- `npm --prefix opencraft run check:mono2-agent-console` 通过，130 个生成副本无漂移。
- `validate_documentation.py --repo . --format json` 通过，仓库内一方链接无断链。
- `validate_change_impact.py --repo . --staged` 通过；检查后已取消暂存。
- 全量 `pnpm test` 中其他套件出现多处失败并触发 Node 4GB 堆 OOM，已终止；单独重跑的续费提醒等套件仍有旧导航断言与缺少 `useCurrentLocale` mock 的失败。

## risks
- 国际站 OpenCraft 需要真实账号与 Bot 的端到端验证；本地测试不能代替生产验证。
- 现有 OpenCraft 非中英文语言包只覆盖内嵌 Chat 的 companion 文案，通用工作台文字仍回落英文。

## validation
- 聚焦国际站与 OpenCraft 组件测试、`pnpm check`、双站构建、生成副本检查和文档影响检查均已通过。
- 全量 `pnpm test` 未通过，具体失败见 evidence；需要在独立任务中清理旧测试与资源限制。

## decisions
- 复用国内站同一嵌入组件与 bridge；国际站通过 `region=intl` 保持既有环境边界。
- 国际站复用现有 `show()` 持久化开关，关闭时隐藏 Chat 组并撤销内嵌组件；国内站不受该开关影响。
- 用宿主当前语言显式配置内嵌组件，并在切换语言时调用其更新 API。

## scan_scope
- `frontend/src/pages/marketing/`、`frontend/src/i18n/`、`opencraft/apps/workbench-web/src/embedded-chat/`。

## scan_output
- 有界 `rg` 搜索定位分流开关、OpenCraft localization API、相关测试。
- 后续 `validate_context.py --route "international OpenCraft Chat gated by browser console show() visibility and initialization"` 未命中 Pack；记录该失败 query 后仅在前端 Chat 与 `show()` 相关文件进行有界精确搜索。
- 同步时 `validate_context.py --route "sync latest origin/master into international OpenCraft Chat worktree and check conflicts"` 未命中 Pack；随后精确检查 `HEAD..origin/master` 的文件列表和重叠的 `agent-settings-page.tsx` diff。

## handoff
- 实现与门禁结果可供 MR 审查；真实国际站账号/Bot/手机交互尚未验证。MR 不代表合并或发布。
