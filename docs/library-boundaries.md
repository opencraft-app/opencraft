# OpenCraft library boundaries

Library decisions preserve separate state owners. The following constraints and
proposals do not imply that every proposed adapter is implemented. Current
source, dependency manifests and focused architecture documents remain authoritative.

## State ownership

| 状态类别 | OpenCraft 边界 |
| --- | --- |
| AppServer Thread / Turn / Item 实时状态 | V4 Replica + `useSyncExternalStore`，Query 不复制 Timeline |
| 会话列表、项目、Git、设置、MCP、文件元数据 | `@tanstack/react-query` |
| 输入中的编辑语义 | `@opencraft/composer-editor` 的 ProseMirror 内核 |
| 页面短命 UI 状态 | React local state；跨树状态才建 typed store |
| 拖拽排序 | Web/Electron 使用 dnd-kit；Native 使用平台手势适配器 |
| 会话长列表 | Web 与 iPad 共用 Turn 窗口真值；平台层只适配测量和滚动 |
| 动效 | Web 使用 `motion`，只在布局/出现退出边界使用 |

OpenCraft 不应建立一个万能全局 store，也不应把 Replica 镜像进 Query cache。Query 负责可请求、可失效、可分页的资源；Replica 负责可重放的权威实时日志。

## Query boundaries

- A root QueryClient is scoped to its application/window. Bootstrap data comes
  from actual project/thread APIs rather than demo seeds.
- `threadKeys.list(hostId, filter, cursor)` belongs in Query. Replica thread
  metadata changes precisely update or invalidate the catalog projection.
  The current Thread Timeline directly subscribes to `ReplicaConversationRuntime`.
- Pagination controllers share cache reads, precise invalidation, `setQueryData`
  and stale state between route loaders and React consumers.
- Optimistic mutations cancel related queries, retain previous values, update
  cache, restore on failure and invalidate on settlement.
- Live resource subscriptions retain explicit owner/generation and cancellation;
  they do not replace the ordered Replica journal. Disposed queries release
  subscriptions and AbortControllers.
- Multi-window invalidation is an Electron transport concern; a single-page Web
  client does not require a second global state store.

## Editor and Timeline

OpenCraft 的编辑器只负责 Draft，`composer-appserver` 负责编译为无损 SubmitIntent，不能让 ProseMirror node 直接泄漏进协议层。IME、失效选区和字符计数由现有编辑器路径处理，不引入第二套编辑器状态模型。

共享算法位于 `packages/timeline-virtualizer`：输入只接受按 Turn 聚合后的 Timeline view-model、历史 gap 和稳定 key，输出窗口、geometry、anchor 与 restore state；它不读取 AppServer，也不拥有 Replica。

Expo/iPad 通过 `TurnScrollPort` / `TurnMeasurementPort` 复用倒序坐标、Turn window、`TimelineAnchor`、`VirtualizedTurnRestoreState`、历史 gap 和 `positionTarget` 语义。Native `onLayout` 与 Web `ResizeObserver` 是不同测量驱动。目标使用稳定 `targetKey`，共享层不得接收 DOM 或 Native handle。若使用 `FlatList` / `VirtualizedList`，它只能执行共享 `renderedRange`，不能基于完整 Timeline 另算窗口。

## Interaction and boundary libraries

- dnd-kit 只产生 typed reorder intent，由 command/store 执行；业务排序数组不归 DnD component state。
- Motion 由 design token、reduced motion 和统一的 presence/layout 边界管理；Timeline token streaming 不逐 token 做 layout animation。
- Generated AppServer types 是编译期契约；WebSocket JSON、Replay fixture、持久化 Replica snapshot 和插件消息仍需运行时 validation。Zod 属于不可信边界，不替代内部 TypeScript 类型。
- Thread 数量小时使用简单规范化匹配；多 Host、大量 archive 或 command palette 才评估搜索索引。
- Overlay 通过共享 Popover/Tooltip/Dialog boundary 接入，Web 定位 API 不进入 domain/view-model。


## OpenCraft 依赖决策

| 库 | 决策 | 第一落点 |
| --- | --- | --- |
| `@tanstack/react-query` | 立即采用 | Web root、project/thread/model catalog、列表分页和 mutation |
| ProseMirror packages | 已采用 | Composer Draft 层 |
| `react-virtuoso` | Timeline 不采用；普通非会话列表另行评估 | 普通非会话列表未来单独评估 |
| `@dnd-kit/core/sortable` | 需要重排时采用 | sidebar project/thread、tab strip、attachment chips |
| `motion` | 采用，但受 token/reduced-motion 管理 | shell panel、磁吸、presence |
| `zod` | 协议 runtime validation 阶段采用 | transport/storage/plugin boundary |
| `fuse.js` | 延后 | command palette、多 host/archive 搜索 |
| Floating UI | 封装后采用 | Web overlays，不进入 domain/view-model |
| Zustand / RxJS | 不采用为全局架构 | 现有 typed stores + Cordis 已覆盖生命周期和订阅 |


## Query key 约定

```ts
export const hostKeys = {
  all: ["hosts"] as const,
  detail: (hostId: string) => ["hosts", hostId] as const,
};

export const projectKeys = {
  all: (hostId: string) => ["hosts", hostId, "projects"] as const,
  list: (hostId: string, filter: ProjectListFilter) =>
    ["hosts", hostId, "projects", "list", filter] as const,
};

export const threadKeys = {
  all: (hostId: string) => ["hosts", hostId, "threads"] as const,
  list: (hostId: string, filter: ThreadListFilter) =>
    ["hosts", hostId, "threads", "list", filter] as const,
  metadata: (hostId: string, threadId: string) =>
    ["hosts", hostId, "threads", threadId, "metadata"] as const,
};
```

Timeline 不设 query key。它的 identity 是 `(hostId, threadId, epoch, seq)`，唯一读取源是 Replica。
