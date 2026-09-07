# Codex / WorkBuddy 前端库使用边界审计

更新日期：2026-08-29

## 审计基线

- Codex 最新语义源码树：`reference://codex/.runtime/source-tree-build-r1316-owner-adoption-abi`
- Codex 最近分区证据：`reference://codex/.runtime/partition-r1309-owner-adoption-v1`
- WorkBuddy 最新固定点源码树：`/data/wbwell/output/workbuddy-monorepo-v8-source-layout183-compound-npm-fixed-point`

本审计只把真实业务调用计入结论。仅存在于 `vendor`、`.generated` 或清单中的包，不视为架构依赖。

## 核心结论

Codex 的关键不是“用了 TanStack Query”，而是把不同状态放进不同系统：

| 状态类别 | Codex 的权威层 | OpenCraft 的对应边界 |
| --- | --- | --- |
| AppServer Thread / Turn / Item 实时状态 | AppServer manager + scoped reactive store；事件增量驱动 | V4 Replica + `useSyncExternalStore`，Query 不复制 Timeline |
| 会话列表、项目、Git、设置、MCP、文件元数据 | TanStack Query Core + 自有 React/atom 适配层 | `@tanstack/react-query` |
| 输入中的编辑语义 | ProseMirror state/view + 插件 | `@opencraft/codex-composer` 的 ProseMirror 内核 |
| 页面短命 UI 状态 | scoped atom/signal 系统 | React local state；跨树状态才建 typed store |
| 拖拽排序 | dnd-kit | Web/Electron 使用 dnd-kit；Native 使用平台手势适配器 |
| 会话长列表 | Codex 自研 Turn Virtualizer；WorkBuddy 用 React Virtuoso | Web 与 iPad 共用 Codex Turn 窗口真值；平台层只适配测量和滚动 |
| 动效 | Framer Motion 内核 + 统一 MotionConfig + reduced motion | Web 使用 `motion`，只在布局/出现退出边界使用 |

这意味着 OpenCraft 不应建立一个“万能全局 store”，也不应把 Replica 镜像进 Query cache。Query 负责可请求、可失效、可分页的资源；Replica 负责可重放的权威实时日志。

## TanStack Query：Codex 到底在哪里、怎么用

### 1. 根节点只创建一次 Client

Codex 在 `lazy/app-initial/n1l.js:27-120` 的 `QueryClientProviderWrapper` 中：

- 通过 lazy `useState(createQueryClientWithSidebarBootstrap)` 保证一个窗口只有一个 client。
- 创建 client 时立即把 Electron main process 提供的 sidebar bootstrap 写入 `initial-sidebar-bootstrap` query key。
- 同一根节点挂载 Git live-query manager 和 Git repo invalidation 订阅。
- Provider 之外只在 dev/internal 构建挂载 Query devtools drawer。

默认策略位于 `lazy/app-initial/is-retryable-http-status.js:62-79`：

- `refetchOnWindowFocus: false`，因为桌面窗口焦点不等于远端资源需要重取。
- 最多重试 3 次。
- HTTP 408、425、429 和 5xx 可重试；明确的其他 HTTP 错误不重试。

OpenCraft 应照这个使用方式建立 `WorkbenchQueryProvider`，但 bootstrap 数据来自 AppServer 的 `project/list`、`thread/list` 等，而不是写死 demo seed。

### 2. 会话列表：Query 是派生快照，不是实时日志

`conversations/use-recent-conversations-query-06144.js:28-173` 展示了最有价值的模式：

- query key 包含列表种类、启用的 host 集合和连接状态。
- `staleTime` 是无限；不会靠定时 refetch 追实时性。
- AppServer manager 的 conversation/meta 事件触发回调。
- 回调从各 host manager 读取当前会话索引，排序后 `setQueryData`。
- 连接 live 时才主动刷新各 host；离线时继续显示本地 manager 的快照。

所以 Query 在这里充当“可观察、可选择、可缓存的列表投影”。Thread 内的 Item 日志仍由会话状态系统维护。

OpenCraft 应采用同一分工：

- `threadKeys.list(hostId, filter, cursor)` 放入 Query。
- Replica 更新 thread metadata 时，catalog bridge 精确更新或失效列表 query。
- 当前 Thread 的 Timeline 仍直接订阅 `ReplicaConversationRuntime`。

### 3. 分页控制器

`routing/create-infinite-query-controller-00809.js:47-182` 把 QueryClient 和 infinite query options 封装成命令式 controller，提供：

- 读取当前缓存；
- 精确 invalidation；
- `setQueryData`；
- 基于 Query entry 计算 stale 状态；
- 给路由 loader 和 React hook 使用同一份分页资源。

这比“页面组件里自己维护 page + loading + result”稳定，正适合 OpenCraft 的 `thread/list`、`project/list` 和 archived list。

### 4. 乐观更新与回滚

Codex 的设置、MCP 和项目 mutation 普遍执行：

1. 取消相关 query；
2. 保存 previous value；
3. `setQueryData` 乐观更新；
4. 失败恢复 previous value；
5. settle 后 invalidate。

例子：

- `service/use-toggle-mcp-server-enabled-03409.js`
- `settings/use-model-settings-06227.js`
- `shared/use-experimental-feature-toggle-mutation-04992.js`
- `workspace/toggle-project-pin-08197.js`

OpenCraft 后续的 pin/archive/rename 也应使用 typed mutation context 实现同样的回滚，不另写临时 React state。

### 5. 实时 Query 不等于 polling

`workspace/create-git-live-query-manager-04807.js:12-249` 把 query cache observer 和后端 Git subscription 联结：

- 只有 Query 有 observer 时才持有 live subscription。
- 后端事件带 `subscriptionId`、`generation`、`phase`。
- 新 generation 覆盖旧结果，完成时清除 fetch 状态。
- 失败时精确 invalidate，并保留 recovery 标记。
- Query 被移除后释放 subscription 和 AbortController。
- 窗口重新聚焦时恢复需要 recovery 的订阅。

这个模式可用于 OpenCraft 的 Git/文件树/运行日志，但不替代 V4 Replica。它解决的是“某一可查询资源的活订阅”，Replica 解决的是“整个会话的有序可重放权威日志”。

### 6. 多窗口失效广播

`terminal/broadcast-query-cache-invalidation-01744.js:235-258` 通过唯一 Electron host bridge 把 query key 发给 main process，再广播给其他 Renderer 窗口。OpenCraft Web 单页初期不需要它；Electron 多窗口阶段应实现 `QueryInvalidationBus`，transport 可以是 Electron IPC 或 BroadcastChannel。

## WorkBuddy 的 Query 现状

WorkBuddy 没有 TanStack Query 的真实调用，也没有依赖声明。

`packages/workbuddy-app/src/session-store/session-query-client.ts:1-83` 是自制的 `SessionQueryClient`：

- 内部只有 `Map<string, { value, updatedAt }>`；
- 5 分钟过期；
- 支持 get/set、前缀删除和 cache-miss fetch；
- 没有 observer、请求去重、AbortSignal、retry、mutation、结构共享或 infinite query。

`packages/workbuddy-app/src/session-store/conversation-query.ts:1-11` 只用它缓存 archived conversations。

主会话列表 `packages/agent-ui/src/components/conversation-list/use-conversation-search.ts:14-270` 仍使用大量 `useState/useRef/useEffect`，自己处理 debounce、分页、append、polling、loading 和合并。它能工作，但这正是 TanStack Query 可以显著收敛的复杂度。

因此：WorkBuddy 可提供业务合并规则参考，不能作为 OpenCraft 的 Query 架构样板。

## 其他真正值得采用的库

### ProseMirror：采用 Codex 的建模

Codex 的 Composer 不是 contenteditable 外壳。`composer/create-composer-rich-text-editor-08732.js:67-300` 创建 ProseMirror EditorView，并组合：

- schema；
- history；
- mention / skill / slash-command suggestion plugin；
- input rules；
- keymap；
- code block highlighting 和语言检测；
- paste 分类（图片、文件、长文本、diff、链接、HTML）；
- plain/rich 模式切换；
- Enter 行为策略和 IME-safe DOM 事件。

`composer/create-composer-editor-module-08745.js:137-300` 再包装成可测试的 imperative `ComposerEditor`，向上暴露持久化文本、mention 提取和变更命令。

OpenCraft 已选择这条路线：编辑器只负责 Draft，`composer-appserver` 负责编译为无损 SubmitIntent，不能让 ProseMirror node 直接泄漏进协议层。

WorkBuddy 的 Slate 实现仍有可取细节：`packages/cb-chat-ui/src/components/chat-input/input.tsx:25-96` 对 stale selection、IME composing 和字符计数做了成熟防御。我们应移植这些行为测试，不应同时引入第二套编辑器状态模型。

### 会话长列表：采用 Codex 自研模型，不采用 React Virtuoso

Codex 的会话 Timeline 没有使用 `react-virtuoso`。它实现了一套针对 Thread / Turn 语义定制的虚拟窗口：

- `lazy/app-initial/thread-virtualizer-D5BSbZuA.js:4-64` 根据稳定 `turnKey`、实测高度、预估高度和 Turn 间距建立完整高度布局，并用倒序的 `distanceFromBottomPx` 二分计算可见区间。
- `lazy/app-initial/open-sources-side-panel-tab-CfgjOF5O.js:139-689` 是实际的 `VirtualizedTurnList` 实现：只渲染窗口切片，默认 overscan 为 2 个 Turn；使用 `ResizeObserver` 回写实测高度；总高度占位 + `marginTop` 放置窗口；布局变化时按已测量 Turn 锚点补偿滚动。
- 同文件 `:693-767` 保存 `turnHeightsByKey` 和 `{ anchorKey, count }`，用于任务切换后的窗口恢复，并支持原版 `scrollToKey` / `getEntryGeometry`。
- `lazy/app-initial/local-conversation-thread-CShhuS2f.js:9159-9163` 将未装载历史表示成带 `estimatedHeightPx` 的 gap，占住正确空间；`:10786-10834` 将窗口恢复状态与距底部位置一起按会话保存。
- `lazy/app-initial/thread-scroll-layout-xQ2_L08y.js:26-399` 另行处理倒序滚动、顶部自动补页、用户滚动意图、ResizeObserver 高度变化、响应跟随和 `content-visibility:auto`。

这不是通用“大列表组件”的用法，而是协议历史窗口、Turn identity、流式尾部跟随和路由恢复共同组成的会话基础设施。OpenCraft 已将共享算法落在 `packages/timeline-virtualizer`：输入只接受按 Turn 聚合后的 Timeline view-model、历史 gap 和稳定 key，输出窗口、geometry、anchor 与 restore state；它不读取 AppServer，也不拥有 Replica。

Expo/iPad 必须通过 `TurnScrollPort` / `TurnMeasurementPort` 复用同一套倒序坐标、Turn window、`TimelineAnchor`、`VirtualizedTurnRestoreState`、历史 gap 和 `positionTarget` 语义；Native `onLayout` 与 Web `ResizeObserver` 只是不同测量驱动。目标使用稳定 `targetKey`，共享层不得接收 DOM 或 Native handle。若使用 `FlatList` / `VirtualizedList`，它只能是执行共享 `renderedRange` 的机械容器，不能再以完整 Timeline 自行计算另一套窗口；最严格的首版可以直接用全高度 Native spacer + 当前 Turn slice。

### React Virtuoso：仅保留 WorkBuddy 参考

WorkBuddy 在 `packages/cb-chat-ui/src/components/message-timeline.tsx:271-320,1301` 使用 Virtuoso：

- 默认 overscan 25；
- viewport 上下各扩 800px；
- 支持 align-to-bottom；
- 流式期间单独维护 follow-output 和滚动到底部；
- 分组后的消息作为虚拟 item；
- 支持顶部加载历史。

它还用于会话列表、文件列表和审计列表。Virtuoso 的 follow-output、顶部加载历史和 IME/流式压力场景测试仍有参考价值，但为了严格对齐 Codex 的会话滚动体验，OpenCraft Timeline 默认不引入它。若未来普通文件列表需要成熟通用虚拟化，可以单独评估，不能反向决定 Chat Timeline 架构。

### dnd-kit：只管理交互，不管理业务排序

Codex 用 dnd-kit 处理 AppShell tab strip 和 sidebar section：

- `terminal/app-shell-tab-strip-05602.js:31-153` 计算稳定 DnD id、droppable viewport 和排序 context；
- `terminal/app-shell-tab-item-05583.js` 处理单 tab 的 sortable transform；
- `modules/ui-islands-v11/use-sidebar-section-drag-drop.js` 处理侧栏 section 重排。

WorkBuddy 用在 Composer phrase block、协作队列、项目计划视图标签和排序条件。代表文件：

- `packages/cb-chat-ui/src/components/chat-input/input.tsx:6-11`
- `packages/agent-ui/src/modules/collab/task-chat/components/collab-queue-panel.tsx`
- `packages/agent-ui/src/modules/collab/project-detail/tabs/plan/toolbar/plan-view-tabs.tsx`

OpenCraft 应让 dnd-kit 只产生 typed reorder intent，再由 command/store 执行；不要把业务数组直接留在 DnD component state。

### Motion：统一动效语义，而不是到处写 spring

Codex 的 MotionConfig 位于 `settings/motion-config-provider-01619.js:9-27`，统一合并父级 transition、reduced motion 和 skip animation。默认视觉曲线位于 `settings/set-motion-config-05610.js:8-22`：

- 快速曲线 `[0.23, 1, 0.32, 1]`；
- 常规过渡 300ms；
- 常规 ease `[0.19, 1, 0.22, 1]`。

OpenCraft 应把这些转成 design token，并仅在 sidebar 磁吸、panel presence、popover 和布局切换使用 `motion`。Timeline token streaming 不应逐 token 做 layout animation。

### Zod：只放在不可信边界

Codex 大量把 Zod 放在 URL、持久化 JSON、WebSocket/MCP、tool result 等边界，而不是拿 schema 替代内部 TypeScript 类型：

- `routing/automation-route-kind-10127.js:13-19` 验证 route param；
- `service/app-server-request-client-module-03167.js:48` 验证 RPC response；
- `conversations/chat-gpt-stream-event-decoder-05738.js` 对每一种 stream event 做 discriminated parse；
- `service/mcp-app-sandbox-renderer-07461.js` 验证跨 iframe 消息。

OpenCraft 的 generated AppServer types 是编译期真值；WebSocket JSON、Replay fixture、持久化 Replica snapshot 和插件消息仍需运行时 validation。Zod 应待协议 validator 层落地时引入，不应让 UI 组件到处 `safeParse`。

### Fuse.js：搜索索引，不是过滤器替身

Codex 在 `lazy/app-initial/data-controls-0FD3T1Y1.js:177-186` 为会话/项目聚合条目构建 Fuse：

- 搜索字段统一收敛到 `searchValues`；
- `ignoreLocation: true`；
- threshold 0.4；
- 空 query 直接返回原始列表。

OpenCraft 在 thread 数量较小时先用简单规范化匹配；达到多 host、大量 archive 或 command palette 后再引入 Fuse。不要为十几个静态菜单项提前增加索引。

### Floating UI：WorkBuddy 的强项，但 OpenCraft 应优先 Headless boundary

WorkBuddy 在 Modal、Drawer、Popover、Tooltip、账户菜单、选择器和 Composer mode/model menu 中广泛使用 Floating UI，真实调用位于 `packages/agent-ui/src/foundation/components/*` 与 `packages/cb-chat-ui/src/components/*`。

它证明 Floating UI 适合复杂锚定与 focus/dismiss 组合。OpenCraft 应封装 `PopoverSurface` / `TooltipSurface` / `DialogSurface`，让 Web 使用 Floating UI，Expo 使用原生 Modal/Popover；业务组件不直接依赖 DOM positioning API。

## OpenCraft 依赖决策

| 库 | 决策 | 第一落点 |
| --- | --- | --- |
| `@tanstack/react-query` | 立即采用 | Web root、project/thread/model catalog、列表分页和 mutation |
| ProseMirror packages | 已采用 | Codex Composer Draft 层 |
| `react-virtuoso` | Timeline 不采用；仅保留 benchmark/fallback 参考 | 普通非会话列表未来单独评估 |
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
