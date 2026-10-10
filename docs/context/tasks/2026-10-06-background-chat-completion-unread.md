## goal
在 LightVela 国内站嵌入式 Agent Chat 中，非当前可见会话完成任务后显示未读蓝点，打开会话后清除。

## non_goals
- 不加入系统通知、跨设备未读同步或生产发布。
- 不改变 Hermes 执行状态与手动“标记为未读”的语义。

## requirement_ids / requirement_refs / requirement_excerpt
- 本次用户请求：切换到其他会话后，原会话任务完成时像 Codex 一样显示蓝点。

## interface_refs / data_structure_refs
- Hermes `message.complete` 经 OpenCraft 转为 AppServer `turn/completed`；嵌入实例通过 DOM 自定义事件将完成会话 ID 告知宿主。
- 宿主现有 `useAgentSidebarUnreadSessions` 按账户和 Bot 存储未读会话 ID，打开会话清除。

## history_context
- current_design_refs: `docs/engineering/journeys/agent-request-streaming.md`；`opencraft/docs/platform-architecture.md`。
- relevant_evolution: 当前工作区已有手动“标记为未读”和执行中转圈功能，均为未提交改动。

## acceptance
- 后台会话收到终态 `turn/completed` 后显示蓝点；正在看的会话不显示；打开后台会话清除。
- 初始历史加载、单纯 `running=false` 不产生新蓝点；已观察到的后台会话从 `running=true` 转为 `false` 时补蓝点。
- 聚焦测试、前端与 OpenCraft 类型检查和本地预览验证通过。

## affected_paths
- `opencraft/apps/workbench-web/src/embedded-chat/embedded-workbench-element.tsx`
- `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- 相邻测试与 `docs/engineering/journeys/agent-request-streaming.md`

## required_context
- `site-environment-routing`, `service-frontend`, `service-opencraft`, `agent-gateway-runtime`, `upstream-subtrees`, `identity-access`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md` | 国内站边界 | 限定本地预览与双站语义 |
| `docs/context/project/services/frontend.md` | 前端验收 | 确定类型与测试门禁 |
| `docs/context/project/services/opencraft.md` | 嵌入运行时 | 确定服务门禁 |
| `docs/context/domains/agent-gateway-runtime.md` | 事件归属 | 避免将 UI 状态写入网关 |
| `docs/context/project/upstream-subtrees.md` | OpenCraft 真源 | 仅改 mono2 真源 |
| `docs/context/domains/identity-access.md` | 账户隔离 | 保持现有 per-account 未读键 |
| `frontend/AGENTS.md` | 前端规则 | 最小验证与生成文件边界 |
| `opencraft/AGENTS.md` | OpenCraft 规则 | 嵌入事件与客户端验证 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 邻接检查 | 核对相邻测试与文档 |

## evidence
- 当前嵌入侧栏会收到 `running`，蓝点只由手动操作写入 `localStorage`。
- OpenCraft 的 `turn/completed` 带 `threadId` 和终态 `turn`。
- 嵌入实例通过 Host client registry 在重连替换 client 后重绑终态事件，宿主仅在会话不可见时设置既有未读状态。用户实测发现后台执行结束时转圈消失，但未收到终态事件；宿主增加已加载会话列表的运行状态边沿兜底。

## risks
- 重连可能更换 AppServer client；监听须在 client 替换时重新绑定。
- 运行状态边沿只能证明执行停止，不能区分正常完成与主动中断；后者可能显示蓝点。若要严格区分，需让后台 Hermes 终态直接进入会话目录契约。

## validation
- `pnpm check` 通过（166 条当前 TypeScript 诊断均在 171 条 baseline 内，0 新增）。
- 前端聚焦测试 2 个文件、19 项通过；本机 `localhost` DNS 失效，用临时 Node preload 将测试启动解析指向 `127.0.0.1`，未改仓库配置。
- `npx tsx --test tests/embedded-turn-completion.test.ts` 的 2 项通过，覆盖终态过滤及 client 替换/释放；OpenCraft Workbench typecheck、`npm run check:boundaries` 通过。
- `npm run build:embedded-workbench:release` 通过；5174 已有服务位于本工作区，`frontend/public/__opencraft` 指向新构建输出。
- 显式变更文件的 `validate_change_impact.py` 与 `git diff --check` 通过；`--staged` 因未暂存任何文件，报告空变更集。
- `validate_documentation.py` 通过：一方链接无损坏，文档分类无遗漏。
- `check:mono2-agent-console` 因工作区此前未提交的生成 i18n 真源与 OpenCraft vendored 副本漂移而失败；本轮未同步或提交副本。
- 浏览器自动访问本地预览遭当前浏览器安全策略拒绝；真实账号中的任务完成蓝点尚未浏览器实测。
- 用户复测发现仅订阅 `turn/completed` 时漏报；增加 `running=true → false` 兜底后，前端聚焦测试 2 个文件、19 项通过，`pnpm check` 通过（166 条当前 TypeScript 诊断均在 171 条 baseline 内，0 新增）。

## decisions
- 只把完成事件传给宿主，未读状态继续由宿主现有 hook 持有。

## handoff
- 源码和本地嵌入构建已更新；交接用户在 5174 登录态下手动复测。未提交、未推送、未发布。
