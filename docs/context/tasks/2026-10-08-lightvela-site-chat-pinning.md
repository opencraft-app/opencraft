---
id: lightvela-site-chat-pinning-20261008
type: task
scope: 在 LightVela 双站的 Agent 会话侧栏接入 OpenCraft 原生置顶能力。
triggers: ["LightVela 双站会话置顶", "OpenCraft pin Chat", "Agent 侧栏置顶"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/pages/marketing/agent-settings-page.tsx
  - opencraft/apps/workbench-web/src/embedded-chat/embedded-workbench-element.tsx
status: active
reviewed_at: 2026-10-08
review_due: 2026-11-08
revision: 1.0.0
precedence: task
derived: false
---

## goal
让 LightVela 用户在 Agent 侧栏置顶、取消置顶对话；状态由 OpenCraft 原生 Host 持久化，置顶会话显示在近期列表之上。

## non_goals
- 不增加浏览器本地置顶存储、第二套后端置顶数据库或无关的聊天改版。
- 不能把源码合入或本地产物构建等同于生产发布完成。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户于 2026-10-08 要求“在lightvela站点上线这个”，指 OpenCraft MR !5064 已合入的 Chat 置顶能力。
- 用户明确要求同时覆盖国内站 `lightvela.com` 和国际站 `lightvela.ai`。

## interface_refs / data_structure_refs
- `opencraft/apps/workbench-web/src/app.tsx`：嵌入态会话投影与 Host 会话管理。
- `opencraft/apps/workbench-web/src/embedded-chat/embedded-workbench-element.tsx`：站点使用的自定义元素。
- `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx`：自定义元素桥接。
- `frontend/src/pages/marketing/agent-settings-page.tsx`：站点持有的侧栏。
- 原生 Host 能力发现决定菜单能否显示，Server 元数据持有持久化状态。

## history_context
- current_design_refs：`opencraft/docs/platform-architecture.md#thread-lifecycle-ownership`、`opencraft/design/invariants.md`、`docs/engineering/domains/release-gitops.md`。
- relevant_evolution：OpenCraft 原生置顶由 MR !5064 进入 `master`；LightVela 站点在嵌入式 Workbench 外绘制自己的侧栏。
- superseded_refs：无。

## acceptance
- 支持置顶的 Host 在站点会话菜单展示置顶/取消置顶；不支持的 Host 隐藏操作。
- 置顶会话始终排在近期会话前，不占近期分页名额；刷新后状态保留且不重复。
- 国内站、国际站的本地化、产物和各自正式发布路径分别验证。

## affected_paths
- `opencraft/apps/workbench-web/src/embedded-chat/`、`opencraft/apps/workbench-web/src/app.tsx`、`frontend/src/pages/marketing/`，以及相关测试与设计文档。

## required_context
- `release-gitops`, `site-environment-routing`, `service-frontend`, `agent-gateway-runtime`, `service-opencraft`, `upstream-subtrees`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/release-gitops.md@a7f604f2a` | 发布边界 | 区分源码、产物、GitOps 和线上状态 |
| `docs/context/domains/site-environment-routing.md@a7f604f2a` | 双站交付 | 国内与国际生产目标独立发布 |
| `docs/context/project/services/frontend.md@a7f604f2a` | 站点服务 | 前端源码及验证责任 |
| `docs/context/domains/agent-gateway-runtime.md@a7f604f2a` | 运行时 | 原生后端仍是置顶权威 |
| `docs/context/project/services/opencraft.md@a7f604f2a` | OpenCraft 服务 | 嵌入协议责任 |
| `docs/context/project/upstream-subtrees.md@a7f604f2a` | OpenCraft 来源 | mono2 保持唯一写入真源 |
| `frontend/AGENTS.md@a7f604f2a` | 前端规则 | 站点 UI、检查、构建与同步门禁 |
| `opencraft/AGENTS.md@a7f604f2a` | OpenCraft 规则 | 能力守门与运行时验证 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@a7f604f2a` | 邻接 | 检查分页测试与发布产物投影 |

## evidence
- 任务起点的 `master` 与 `origin/master` 均为 `a7f604f2a`；隔离 worktree 后已平移到新的 `origin/master`。
- 站点的 `openCraftChatEnabled` 为真，但原侧栏只有重命名、未读、删除，嵌入会话也未投影 `pinned`。
- 新基线 `e32b6e8e9` 上前端 `pnpm check`、聚焦测试 110 项、`pnpm build` 均通过；国内与国际 EdgeOne 生产配置本地产物构建均通过。

## risks
- 若所连 Host 未声明置顶能力，应等能力发现确认后再显示操作。
- 站点产物与原生 Hermes API 可能处于不同版本，发布前后需核对实际目标并保留回滚 revision。

## validation
- 运行 OpenCraft 聚焦测试、受影响工作区类型检查与边界检查；运行前端聚焦测试、check 和 build；检查生成副本、发布产物投影和上线后的生产状态。

## decisions
- 沿用现有原生置顶资源，只向站点暴露能力、会话状态和操作的窄桥接。

## scan_scope
- 限定在 `frontend/src/pages/marketing/`、`opencraft/apps/workbench-web/src/embedded-chat/` 及相关运行时、发布文档。

## scan_output
- 有界精确检索记录在本任务对话中，没有进行全仓生成物扫描。

## handoff
- 站点桥接与本地验证完成；仍需完成生成副本同步、源码交付、两个正式站发布及线上验收。
