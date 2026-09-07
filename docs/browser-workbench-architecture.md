# OpenCraft 跨平台浏览器工作台实施设计

> 状态：Web Vertical Slice + PreviewBridgeAdapter Implemented；Electron/Playwright/Expo Adapter Proposed  
> 目标平台：Vite Web、Electron Desktop、Expo iOS/iPadOS、Expo Web  
> 架构修订：R6（Codex 生命周期、多 Host 与 AI Capability 边界复审）  
> 当前已实现 `browser-core`、Web iframe Runtime、应用级 Presentation Root、右侧多
> Tab 投影、显式关闭、会话恢复、聊天外链接入，以及 OpenVibe 形状的 typed Preview Bridge。
> Authority/Backing owner、Electron
> WebContents 与 Expo Adapter 仍按本文设计继续演进。

## 1. 结论

OpenCraft 共享的是浏览器的身份、行为、能力和恢复语义，不共享物理渲染控件，也不把
Thread 所属 Host、浏览器执行位置和 UI 呈现位置压成一个 `hostId`。

最终模型只有三种产品级公开概念：

1. `BrowserSession`：用户认为“这是同一个浏览器标签”的逻辑资源；
2. `ConversationBrowserLink`：浏览器与某个 Host/Thread 的业务关系；
3. `BrowserViewHandle`：某个 Renderer 对 Session 的呈现投影句柄，并可临时取得
   `BrowserPresentationLease` 显示到 Renderer slot；它不是 Session 或 Backing 的生命
   周期 owner。

Authority、Backing、WebContents、iframe、WebView、远端帧流和 Surface Root 都是
Runtime/Adapter 的实现职责，不进入普通 UI ABI。

OpenCraft 也不采用“整个 Renderer 只能有一个 Cordis Context”的全局单例规则。正确规则是：

> 每个物理资源只有一个生命周期所有者；一个 `ApplicationSupervisor` 显式拥有多个
> 生命周期域，每个域可以使用自己的 Cordis Context/Fiber。

## 2. 第一性原理

### 2.1 身份必须描述不随投影改变的事实

- Thread 的身份是 `(hostId, threadId)`；
- Browser Session 的身份不能因为从 iframe 切换到 Remote Browser 而改变；
- Authority Binding 描述当前在哪里执行，可以改变；
- Panel、iPad split column 和 iPhone route 都只是 View，不是 Browser 身份；
- 物理 Surface 重建不能制造新的逻辑 Browser Session。

### 2.2 状态放在真正改变它的地方

- AppServer/Browser Authority 决定远端执行结果；
- Browser Runtime 决定逻辑 Session 快照；
- Renderer Layout Store 决定 right/bottom/split/sheet/full-screen；
- Surface/Presentation Coordinator 决定物理可见性、焦点与 bounds；
- Replica 只同步适合重放的服务端事实；
- TanStack Query 只缓存查询，不承担实时 Session 状态机。

### 2.3 生命周期通过句柄表达

禁止公开成对的 `retain()/release()` 计数 API。调用者取得一个幂等、可释放的句柄：

```ts
export interface AsyncDisposable {
  dispose(): Promise<void>;
}
```

创建失败必须回滚已经产生的物理资源；释放之后的迟到事件必须被 generation/sequence
拒绝。

句柄必须按职责分型，不能因为都支持 `dispose()` 就混为一种引用：

| 句柄 | 表达的事实 | `dispose()` 的结果 |
| --- | --- | --- |
| `BrowserViewHandle` | 某 Renderer 正在观察/呈现 Session | 释放 View/Presentation claim，不关闭逻辑 Session |
| `BrowserBackingOwnerHandle` | tab、agent-use、capture、handoff 或 restore 正在要求 Backing 存活 | 撤销该 owner，并触发 Backing 驻留策略重算 |
| `BrowserPresentationLease` | 某个具体 slot 正在承载物理 Surface | background/detach Surface，不销毁 Session |

React unmount、逻辑 tab close、Session close、远端 Authority terminate 和物理 Backing
destroy 是五个不同事件。任何 Adapter 都不得通过组件卸载暗中推导后四者。

### 2.4 跨平台共享行为，不共享桌面布局

`right | bottom`、320px、磁力压缩、full-width 和 Codex header slot 都是 Vite/Electron
布局策略。Expo Native 共享 Resource/Session/Command 契约，但使用 split view、stack、
sheet、safe area 和 native gesture。

### 2.5 抽象由第二个实现证明

第一版只冻结最小产品契约。iframe 纵切完成后接入 Electron WebContents，用第二种
物理实现校正 Engine/Presentation SPI；通过两种 Adapter 后才冻结 v1，不预先为所有
未来平台设计十几个空包。

## 3. 参考实现约束

### 3.1 Codex 桌面实现提供的证据

恢复源码显示，参考桌面实现将工作台标签、浏览器标签和物理 WebView 分开：

- `shared/parse-tab-host-view-id-from-window-id-01015.js`：Panel 投影分别保留
  `tabId` 与 `browserTabId`；
- `browser/compute-browser-panel-initial-state-09586.js`：从 conversation browser
  状态生成面板投影；
- `browser/get-or-create-browser-sidebar-webview-root-05632.js`：应用级 fixed
  WebView Root 不跟随 Panel 子树卸载；
- `browser/browser-sidebar-webview-manager-05645.js`：管理 storage mode、mount
  generation、renderer instance 与 conversation transfer；
- 同一 manager 的 `browserUseTabKeys`、`webviews`、`tabCaptureActiveKeys` 和
  `mountStates.claimKeys` 证明 agent 使用、Backing 存活、capture 与 UI mount 是相互独立
  的生命周期事实；`getConversationBrowserTabIds()` 会合并 agent 与 WebView 两条来源；
- `_virtual/safe-url-parse.js`：React 子树只 claim/release mount generation；最后一个
  mount claim 释放后才允许 detach，并不等价于 close tab；
- `_virtual/plan-browser-tab-activation.js`：逻辑 Browser tab 可以迁移所有权；
- `_virtual/navigate-to-chat-home.js`：持久化 `browserTabId`、`browserStorageId`、布局与
  `restoreUrl`，但不持久化 renderer/host/mount generation、adoption lease 或
  WebContentsId；
- `conversations/interrupted-command-ids-subscription-selector-04990.js`、
  `service/app-server-manager-registry-06127.js` 和
  `service/app-server-request-client-module-03167.js`：应用域按 `hostId` 创建一个逻辑
  request client，Manager 校验 client/Host 一致性，Registry 索引 Manager；所有请求再
  经一条携带 `hostId` 的 Host bridge 复用物理通道；
- `browser/iframe-orchestrator-08353.js`：Assistant Visualization 使用独立沙箱协议。

参考源码根目录：

```text
reference://codex/.runtime/source-tree-build-r2030-eager-immediate-compact
```

### 3.2 WorkBuddy 提供的证据

WorkBuddy 的 `BrowserPreview -> LocalWebview | CloudIFrame` 证明平台 Adapter、Host
Bridge、稳定尺寸后导航和 iframe 保活有价值，但单个 `currentUrl` Context 不是多标签
Browser Domain。

参考源码根目录：

```text
/data/wbwell/output/workbuddy-monorepo-v8-source
```

采用其 Bridge/Adapter 经验，不复制单 Preview 状态模型。

## 4. 产品级身份

```ts
export type HostId = string & { readonly __brand: "HostId" };
export type ThreadId = string & { readonly __brand: "ThreadId" };
export type BrowserSessionId = string & {
  readonly __brand: "BrowserSessionId";
};
export type BrowserAuthorityProfileId = string & {
  readonly __brand: "BrowserAuthorityProfileId";
};
export type BrowserAuthorityRuntimeId = string & {
  readonly __brand: "BrowserAuthorityRuntimeId";
};
export type BrowserEngineInstanceId = string & {
  readonly __brand: "BrowserEngineInstanceId";
};
export type BrowserClientId = string & {
  readonly __brand: "BrowserClientId";
};
export type BrowserViewId = string & { readonly __brand: "BrowserViewId" };
export type BrowserSlotId = string & { readonly __brand: "BrowserSlotId" };
export type RendererInstanceId = string & {
  readonly __brand: "RendererInstanceId";
};

export type AuthorityGeneration = number & {
  readonly __brand: "AuthorityGeneration";
};
export type PresentationGeneration = number & {
  readonly __brand: "PresentationGeneration";
};
export type LayoutEpoch = number & { readonly __brand: "LayoutEpoch" };
export type ViewportRevision = number & {
  readonly __brand: "ViewportRevision";
};

export interface ConversationKey {
  readonly hostId: HostId;
  readonly threadId: ThreadId;
}

export interface BrowserAuthorityBinding {
  readonly profileId: BrowserAuthorityProfileId;
  readonly runtimeId: BrowserAuthorityRuntimeId;
  readonly engineInstanceId: BrowserEngineInstanceId;
  readonly generation: AuthorityGeneration;
}

export interface ConversationBrowserLink {
  readonly conversation: ConversationKey;
  readonly browserSessionId: BrowserSessionId;
  readonly relation: "primary" | "referenced";
}
```

`BrowserSessionId` 由 OpenCraft 或支持该语义的远端 Authority 生成全局稳定 ID。服务端原生
Session ID 如果不能满足全局唯一性，只作为 `BrowserAuthorityBinding` 内部映射，不能
直接冒充逻辑 ID。

Authority 身份分四层，不能再用一个含糊的 `authorityId` 同时表示配置、连接和物理实例：

| OpenCraft 字段 | 稳定范围 | Codex 中对应证据 | 是否进入普通 checkpoint |
| --- | --- | --- | --- |
| `profileId` | 用户配置/路由选择稳定，如 `local-electron` 或某 Remote 集群 | Host kind、远端配置与路由 policy | 是 |
| `runtimeId` | 一次 Authority 进程或连接 incarnation | Host connection/host generation 的 fencing 思路 | 否 |
| `engineInstanceId` | 一个实际浏览器 Backing | 私有 WebView/WebContents 映射或远端 instance ref | 否；`browserStorageId` 对应的是下文 opaque restore ref |
| `generation` | 当前 Session 绑定序列，rebind 时单调增加 | host generation / reconnect generation 的 fencing 思路 | 否 |

`hostId` 仍只表示 AppServer 执行/工作区上下文；它可以参与 Authority 路由，但不是
Browser Authority identity。`BrowserRestoreHandleRef` 是稳定且不透明的恢复能力引用，
也不是运行时 `engineInstanceId`。

这允许：

- SSH Host A 的 Thread 使用客户端本地 iframe；
- 本地 Thread 使用 Remote Authority B；
- iframe embed denied 后保持逻辑 ID，替换 Authority Binding；
- Electron Renderer 重载后重新绑定仍存在的 main-process instance；
- Remote Session 被多个客户端观察，但每个客户端拥有独立 View/Presentation。

## 5. 三种公开概念

```text
ConversationKey ── ConversationBrowserLink ── BrowserSessionId
                                                   │
                                            BrowserViewHandle
                                                   │ temporary
                                     BrowserPresentationLease
                                                   │
                                      Renderer slot / Surface
```

### 5.1 BrowserSession

Browser Session 是产品资源，不等于 iframe、WebContents 或远端进程。它保存用户可见
状态和当前 Authority Binding，但不暴露 BackingId、WebContentsId、storage partition
或物理 Surface handle。

### 5.2 ConversationBrowserLink

Link 是关系，不是 Browser 的复合主键。同一个 Browser Session 可以迁移到另一
Conversation，或被允许的只读 View 引用。跨 Host 迁移不要求伪造相同执行实例；结果
必须明确标记为 continued、handed-off 或 restored-copy。

### 5.3 BrowserViewHandle

打开 Panel/Route 时取得 ViewHandle；关闭或卸载 View 时只释放呈现 claim。最后一个 View
消失不构成用户关闭 Session 的意图，也不能直接销毁 Backing。Local 与 Remote 都遵循
同一条规则：“没有 View”只影响可见性；Session close 与远端 Authority terminate 必须
由显式命令表达。

```ts
export interface BrowserViewHandle extends AsyncDisposable {
  readonly viewId: BrowserViewId;
  readonly browserSessionId: BrowserSessionId;
  getSnapshot(): BrowserSessionSnapshot;
  subscribe(listener: () => void): () => void;
  present(input: BrowserPresentationRequest): Promise<BrowserPresentationLease>;
}
```

### 5.4 Backing owner 与关闭语义

Runtime 内部使用有原因、有身份、幂等的 owner handle，不公开整数引用计数：

```ts
export type BrowserBackingOwnerKind =
  | "logical-tab"
  | "agent-use"
  | "capture"
  | "handoff"
  | "restore";

export interface BrowserBackingOwnerHandle extends AsyncDisposable {
  readonly ownerId: string;
  readonly kind: BrowserBackingOwnerKind;
  readonly browserSessionId: BrowserSessionId;
}
```

Session Controller 维护 owner set 与 presentation claim set，但二者含义不同：

- `create()`：原子创建 Session 与内部 `logical-tab` owner；`openView()` 不创建第二个
  Session owner；
- View unmount：释放 presentation claim；
- tab close：Session 原子进入 `closing`、拒绝新 View，并撤销 `logical-tab` owner；仍在运行
  的 agent/capture owner 可以受控排空，不能让 Session 回到 `active`；
- agent/capture 完成：只撤销各自 owner；
- owner set 为空：允许 Runtime 按平台 policy suspend 或销毁本地 Backing，但不伪造远端
  terminate；
- `terminateAuthority()`：在 capability 允许时显式结束远端/独立 Authority instance；
- Backing destroy：Controller 在 fencing 校验后执行的物理清理结果，不是 UI action。

Codex 的 `adoptionLease` 只用于一次 Electron WebContents handoff，不应泛化为上述 owner
模型的通用计数器。

## 6. 状态所有权

| 事实 | 唯一权威 | 其他层如何获得 |
| --- | --- | --- |
| Host 连接与 generation | `HostRuntime` | Host snapshot |
| Thread/Turn/Item | AppServer；客户端为 Session/Replica projection | Conversation snapshot |
| Browser 逻辑状态 | `BrowserSessionController` | Browser snapshot |
| Browser Backing 驻留原因 | `BrowserSessionController` 的 typed owner set | diagnostics/owner events |
| Browser 执行/native history/storage | `BrowserEngineInstance` | Instance event projection |
| Conversation 与 Browser 关系 | `BrowserLinkStore` | link snapshot |
| 桌面 right/bottom/full-width | Web Layout Store | Renderer-local snapshot |
| iPad split/iPhone route | Native Navigation/Layout | Renderer-local snapshot |
| Surface 可见性和焦点 | Presentation Coordinator | Presentation snapshot |
| 高频 bounds | AppShell/Native layout → imperative port | frame command |
| Remote controller lease | Remote Authority | ephemeral control event/query |
| Query cache | QueryClient | query snapshot |

禁止：

- 用 Conversation `hostId` 推导 Browser Authority；
- 用裸 `threadId` 建跨 Host Map；
- 在 UI 同时保存 `currentUrl` 和 Browser snapshot；
- 在 Browser Session 中伪造 native history stack；
- 把 right/bottom/full-width 当作跨平台业务状态；
- 让 ResizeObserver/onLayout 结果反向成为 AppShell 布局权威；
- 用同一个无语义 `generation` 表示连接、Authority、Presentation 和 Layout；
- 用 View 数量推导 Session close 或 Authority terminate；
- 把稳定 Authority profile、运行时 incarnation 和 Engine instance 压成同一个 ID。

## 7. Browser Domain 最小契约

### 7.1 正交状态

```ts
export type BrowserResourceStatus =
  | "creating"
  | "active"
  | "suspended"
  | "closing"
  | "closed"
  | "failed";

export type BrowserConnectivity =
  | "online"
  | "recovering"
  | "offline";

export type BrowserUrl = string & { readonly __brand: "BrowserUrl" };
export type BrowserSafeRestoreUrl = string & {
  readonly __brand: "BrowserSafeRestoreUrl";
};
export type BrowserDisclosedUrl = string & {
  readonly __brand: "BrowserDisclosedUrl";
};

export interface BrowserNavigationSnapshot {
  readonly currentUrl: BrowserUrl | null;
  readonly navigationId: string | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly isLoading: boolean;
}

export interface BrowserSessionSnapshot {
  readonly revision: number;
  readonly id: BrowserSessionId;
  readonly status: BrowserResourceStatus;
  readonly connectivity: BrowserConnectivity;
  readonly navigation: BrowserNavigationSnapshot;
  readonly title: string | null;
  readonly faviconUrl: string | null;
  readonly isAudible: boolean;
  readonly isAudioMuted: boolean;
  readonly capabilities: BrowserEffectiveCapabilities;
  readonly error: BrowserUserFacingError | null;
}
```

`navigating` 不再是资源生命周期；它由 `navigation.isLoading` 表示。Authority generation、
eventSeq、storage profile 和 instance ID 进入内部 diagnostics/controller，不进入普通 UI
snapshot。

完整历史属于 Engine/Authority。Domain v1 只投影 `canGoBack/canGoForward`；书签和访问
历史是独立功能，不能用无法验证的 iframe 观察记录冒充 native history。

### 7.2 URL 必须通过构造器

TypeScript brand 本身不能提供运行时安全。`BrowserUrl` 的构造器是唯一公开入口：

```ts
export interface BrowserUrlPolicy {
  parseForNavigation(input: string): BrowserUrl;
  createSafeRestoreUrl(url: BrowserUrl): BrowserSafeRestoreUrl | null;
  redactForReplica(url: BrowserUrl): BrowserDisclosedUrl | null;
}
```

默认允许 `https:` 和显式开发环境的 `http:`。`javascript:`、`data:`、`file:`、自定义
scheme、popup 和顶层外部跳转由独立 policy 决定。

### 7.3 能力只暴露有效结果

```ts
export interface BrowserEffectiveCapabilities {
  readonly arbitraryOrigins: boolean;
  readonly goBack: boolean;
  readonly goForward: boolean;
  readonly reload: boolean;
  readonly stop: boolean;
  readonly mute: boolean;
  readonly downloads: boolean;
  readonly fileUpload: boolean;
  readonly camera: boolean;
  readonly microphone: boolean;
  readonly capture: boolean;
  readonly devtools: boolean;
  readonly remoteControl: boolean;
  readonly persistentStorage: boolean;
}
```

Backing 的 reparent、detach 和 multiple-viewer 能力是 Runtime SPI，不复制到 UI 快照。

## 8. 命令按责任拆分

### 8.1 Authority 命令

```ts
export type BrowserAuthorityCommand =
  | { readonly type: "navigate"; readonly url: BrowserUrl; readonly navigationId: string }
  | { readonly type: "reload"; readonly bypassCache?: boolean }
  | { readonly type: "stop" }
  | { readonly type: "go-back" }
  | { readonly type: "go-forward" }
  | { readonly type: "set-muted"; readonly muted: boolean };
```

所有命令返回 `Promise` 并接受 `AbortSignal`。Authority event/ack 必须携带当前 binding
ref（至少 `runtimeId + engineInstanceId + generation`）与 `eventSeq`，导航事件还要携带
`navigationId`。只比较 generation 不够：Authority 重启或 Adapter 重建后，另一运行时可能
从相同数值重新计数。

### 8.2 不属于 Authority 的动作

- `focus`：`BrowserPresentationLease.focus()`；
- `open-external`：`ExternalNavigationPort.open()`；
- 关闭 View：`BrowserViewHandle.dispose()`；
- 关闭逻辑 Session：`BrowserSessionService.close()`；
- 结束远端/独立执行实例：`BrowserSessionService.terminateAuthority()`；
- 移动 Panel：Renderer Layout Store action。

这样 UI 操作、Host policy、资源生命周期和网页导航不会落进同一个 command union。

## 9. ApplicationSupervisor 与 Cordis

### 9.1 组合原则

```text
ApplicationSupervisor
├─ HostRuntimeRegistry
│  ├─ HostRuntime(local)
│  ├─ HostRuntime(remote-ssh:a)
│  └─ HostRuntime(durable)
├─ TransportBroker (optional physical multiplexing)
├─ BrowserRuntime
├─ RendererRuntime
│  ├─ Workbench resource registry
│  ├─ Renderer-local layout store
│  ├─ Trusted Chat renderer extension scope
│  └─ Presentation coordinator
├─ EcosystemSupervisor
│  ├─ ExtensionSupervisor
│  │  ├─ Activation graph / Contribution broker
│  │  ├─ trusted local/workspace runtime
│  │  └─ restricted provider/UI hosts (optional)
│  └─ AgentCapabilityRuntime
│     ├─ Catalog / Resolver / Lease
│     └─ Execution router / Journal
└─ QueryClient
```

Supervisor 可以是普通 TypeScript 对象。Cordis 用于每个需要插件发现、依赖注入和 Fiber
清理的生命周期域，不作为 React 状态库、动画总线或身份系统。

`ExtensionSupervisor` 是客户端扩展 Activation 的唯一产品级 owner。它只能借用
Browser Runtime 暴露的 capability/command Port；插件不能取得 BrowserSessionService、
Engine、Presentation Coordinator 或物理 Surface 的直接引用。公共 SDK 不暴露 Cordis
Context；本地可信插件可同进程运行，Restricted channel 才要求真实隔离。普通同源 Worker
只能承担调度/故障隔离，不能被宣传成安全沙箱。完整插件模型见
[`plugin-architecture.md`](./plugin-architecture.md)。

Agent 不直接调用 Extension 或 Browser Adapter。`AgentCapabilityRuntime` 把 Browser 操作投影为
稳定 Capability，经 task-scoped Lease 与 Execution Router 调用；每次导航、交互、截图或
远端控制仍遵守本文的 Session/Authority/Presentation owner 和 generation fencing。完整
AI 原生模型见 [`agent-capability-fabric.md`](./agent-capability-fabric.md)。

### 9.2 允许多个 Context

允许：

- Host Runtime Context；
- Web/Native trusted renderer extension Context；
- Trusted Chat renderer extension Context；
- 隔离测试 Context。

必须满足：

- 同一物理 connection、Engine instance 或 native Surface 只有一个 lifecycle owner；
- 同一个 `profileId` 可以先后或并行产生多个 `runtimeId`，不能用 profile 唯一性代替物理
  owner 校验；
- 子 Runtime 全部由 Supervisor 或其父 Fiber 销毁；
- React Provider 只暴露稳定 Runtime 引用；
- React Strict Mode/HMR 不创建第二条物理连接；
- 跨进程只走 typed IPC/transport，不共享 JavaScript Context。

### 9.3 Host Runtime

当前 `createAppServerWorkbenchRuntime()` 可以渐进演化为一个 HostRuntime，不需要整棵
重写。应用级 Registry 负责多个 Host；每个 HostRuntime 拥有 client、Resume/Replica
projection、Thread bindings 和 reconnect lifecycle。

所有权现已定案：

```text
ApplicationSupervisor
├─ HostRuntimeRegistry               # 索引 HostRuntime，不拥有第二份 client
│  ├─ HostRuntime(hostId=local)
│  │  └─ AppServerClient(hostId=local)
│  └─ HostRuntime(hostId=remote-ssh:a)
│     └─ AppServerClient(hostId=remote-ssh:a)
└─ TransportBroker (optional)
   └─ one physical MessageChannel/WebSocket, frames carry hostId
```

- 每个 `HostRuntime` 直接拥有且销毁一个逻辑 `AppServerClient`；
- `HostRuntimeRegistry` 只负责按 `hostId` 查找、添加和移除完整 HostRuntime；
- 可选 `TransportBroker` 只复用 Electron IPC/MessageChannel/WebSocket 等物理通道，不拥有
  Thread、Resume、Replica 或 Manager 语义；
- 即使多个 Host 复用一条物理通道，它们仍是独立 client lane、请求队列、generation 和
  Resume projection；
- React 只能借用 Supervisor 已创建的 HostRuntime，不能在 Provider/effect 中新建连接。

现有 `@opencraft/appserver-client` 的 Cordis multi-host registry 是可执行基础设施和 Lab API，
但 `createAppServerWorkbenchRuntime()` 为单 Host 再创建一个“一项 registry”的做法属于
迁移期结构。迁移时将低层 registry 降为兼容 factory/test utility，不能让它与
`HostRuntimeRegistry` 同时声称拥有 client 生命周期。

## 10. Browser Runtime 与 provisional Engine SPI

### 10.1 BrowserSessionService

```ts
export interface BrowserSessionService {
  create(input: CreateBrowserSessionInput): Promise<BrowserSessionId>;
  openView(input: OpenBrowserViewInput): Promise<BrowserViewHandle>;
  execute(
    sessionId: BrowserSessionId,
    command: BrowserAuthorityCommand,
    options?: { readonly signal?: AbortSignal },
  ): Promise<BrowserCommandReceipt>;
  handoff(input: BrowserHandoffIntent): Promise<BrowserHandoffResult>;
  close(sessionId: BrowserSessionId): Promise<void>;
  terminateAuthority(sessionId: BrowserSessionId): Promise<void>;
  getSnapshot(sessionId: BrowserSessionId): BrowserSessionSnapshot | null;
  subscribe(sessionId: BrowserSessionId, listener: () => void): () => void;
}
```

每个 Session Controller 拥有 Authority binding、Backing owner set、presentation claim
set、订阅、AbortController、checkpoint writer 和 closing tombstone。ViewHandle 释放失败
进入后台清理队列；相同 Session 在 closing 期间不得被当作 active resource 重新打开。
`close()` 先原子提交 closing tombstone 并禁止新 View，再撤销 `logical-tab` owner；短暂的
agent/capture owner 可以排空，清理失败只进入后台队列，不能把 Session 复活。它不隐式
调用 `terminateAuthority()`。

### 10.2 Engine SPI 尚不冻结

第一阶段使用最小接口：

```ts
export interface BrowserEngineInstance extends AsyncDisposable {
  readonly profileId: BrowserAuthorityProfileId;
  readonly runtimeId: BrowserAuthorityRuntimeId;
  readonly engineInstanceId: BrowserEngineInstanceId;
  readonly generation: AuthorityGeneration;
  getSnapshot(): BrowserEngineSnapshot;
  subscribe(listener: (event: BrowserEngineEvent) => void): () => void;
  execute(
    command: BrowserAuthorityCommand,
    options?: { readonly signal?: AbortSignal },
  ): Promise<BrowserEngineCommandAck>;
  present(input: BrowserEnginePresentationRequest): Promise<BrowserPresentationLease>;
  captureRestoreCandidate(): Promise<BrowserRestoreCandidate | null>;
}
```

这里把 Engine 与 Surface 视为两个职责，但不强迫平台内部必须创建两个物理对象：

- iframe/RN WebView 可以由一个私有 resource 同时完成执行与呈现；
- Electron WebContents 可以在 main process 存活，再附着到 Renderer slot；
- Remote Engine 持有服务端实例，Presentation 消费独立 frame/data plane。

`captureRestoreCandidate()` 只属于 Engine Instance。Presentation 不拥有 Cookie、history
或恢复材料。

### 10.3 Presentation Lease

```ts
export interface BrowserPresentationLease extends AsyncDisposable {
  readonly rendererInstanceId: RendererInstanceId;
  readonly slotId: BrowserSlotId;
  readonly generation: PresentationGeneration;
  stage(): Promise<void>;
  commitFrame(frame: SurfaceLayoutFrame): void;
  reveal(): Promise<void>;
  background(): Promise<void>;
  focus(): Promise<void>;
}

export type SurfaceCoordinateSpace =
  | "visual-viewport-css-px"
  | "window-dip";

export interface SurfaceLayoutFrame {
  readonly coordinateSpace: SurfaceCoordinateSpace;
  readonly rect: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly clipRect: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }> | null;
  readonly deviceScaleFactor: number;
  readonly layoutEpoch: LayoutEpoch;
}
```

高频 frame 通过 imperative port 合并，不进入 React/Cordis snapshot。可见性只有
`staged/revealed/backgrounded/disposed` 一份权威；frame 不携带第二个 `visible`。

同一 Session 的前台 Presentation 限制必须注明作用域：默认是“每个 Renderer
Instance 最多一个”，Remote Browser 可以在多个客户端各有一个 observer presentation。

## 11. Workbench Resource 与平台布局

### 11.1 共享部分

共享包只拥有：

```ts
export interface WorkbenchResourceDescriptor {
  readonly id: string;
  readonly kind: string;
  readonly resourceRef: string;
  readonly durableRoute: DurableResourceRoute | null;
}

export interface WorkbenchResourcePresentation {
  readonly title: string;
  readonly icon: string | null;
  readonly status: "idle" | "loading" | "error";
}
```

Browser resourceRef 只序列化 `BrowserSessionId`。标题、favicon 和 loading 从 Browser
snapshot 动态投影，不持续改写 descriptor。

### 11.2 Renderer-local 部分

Vite/Electron Layout Store 拥有：

- right/bottom region；
- tab order、active、recent；
- width、full-width、magnetic close shelf；
- header slot、响应式阻断和滚动偏移。

Expo Layout/Navigation 拥有：

- iPad primary/secondary split；
- iPhone stack/sheet/full-screen；
- safe area、keyboard、gesture 和 AppState；
- native memory-pressure presentation policy。

这些 Store 可以消费相同 Resource Registry，但不共享 layout snapshot。

### 11.3 关闭与迁移

- `open`：先取得 Resource/ViewHandle，成功后提交 layout action；
- `unmount`：幂等释放 ViewHandle，不关闭逻辑 Session；
- `close resource`：先由 `BrowserSessionService.close()` 原子提交 closing tombstone，再从
  布局移除并释放 ViewHandle；物理清理失败留在可重试后台队列，不回滚 UI，也不能复活
  Session；
- `terminate authority`：单独的危险操作与确认流，不由关闭 Panel/Route 触发；
- closing tombstone 阻止半关闭 Session 被复用；
- 同一 Renderer 内 transfer 是一个 Layout Store 原子 reducer action；
- 跨 Conversation/Host 的 Browser 迁移走 `handoff()`，不是 Panel reducer；
- 折叠或切换只 background Presentation，不释放 ViewHandle。

不引入分布式两阶段 Panel transaction；本地布局原子性与资源最终清理分别由各自 owner
保证。

## 12. 平台策略

### 12.1 Vite Web

Web Presentation Root 固定挂在应用根，与可卸载的 Panel content 是 sibling。iframe
在 Root 中绝对定位并消费 visual viewport CSS px。

| 页面 | 策略 |
| --- | --- |
| OpenCraft 自有可信页面 | iframe + `PreviewBridgeAdapter`；同源自动注入 child runtime |
| Gateway 受控建站页面 | gateway 注入相同 child runtime，以精确 origin 握手 |
| Assistant HTML | 独立 `srcdoc` sandbox + CSP |
| 允许嵌入的公网网页 | sandboxed iframe |
| 拒绝嵌入的网页 | Remote Browser 或外部浏览器 |

不能绕过 `X-Frame-Options`、CSP `frame-ancestors`、跨域 DOM 和第三方 Cookie 限制。

### 12.2 Electron

main process 拥有 WebContents、partition、权限、下载、弹窗和进程生命周期。Renderer
只发送带逻辑 Session、instance generation、presentation generation 的 typed IPC。

WebContentsId 只存在 main adapter 私有映射，不作为业务 ID。

### 12.3 Expo Native

使用 `react-native-webview`。第一版优先 resident pool，不假定 Native View 可以无损
reparent。若内存压力释放 WebView，则逻辑 Session 转为 suspended，通过安全 checkpoint
最佳努力恢复。

Overlay/Surface Root 在成为默认方案前必须验证触摸、VoiceOver、键盘、split view、
back gesture 和内存告警。

### 12.4 Expo Web

Expo Web 使用自己的 iframe Presentation 和移动布局，不复用 Vite DOM/SCSS。共享的是
Browser Domain、Runtime command、URL policy 和 capability fixture。

## 13. Remote Browser

### 13.1 远端实例身份

```ts
export interface RemoteBrowserInstanceRef {
  readonly profileId: BrowserAuthorityProfileId;
  readonly runtimeId: BrowserAuthorityRuntimeId;
  readonly engineInstanceId: BrowserEngineInstanceId;
  readonly generation: AuthorityGeneration;
}
```

协议消息使用 Remote Instance Ref；客户端 Runtime 将其绑定到逻辑 BrowserSessionId。

### 13.2 Observer 与 Controller

```ts
export interface BrowserControlSnapshot {
  readonly instance: RemoteBrowserInstanceRef;
  readonly holderClientId: BrowserClientId | null;
  readonly controlEpoch: number;
  readonly expiresAt: number | null;
}

export interface BrowserControlLease {
  readonly instance: RemoteBrowserInstanceRef;
  readonly holderClientId: BrowserClientId;
  readonly controlEpoch: number;
  readonly expiresAt: number;
}

export interface RemoteViewportDescriptor {
  readonly viewportRevision: ViewportRevision;
  readonly widthCssPx: number;
  readonly heightCssPx: number;
  readonly deviceScaleFactor: number;
}
```

Observer 不持有 lease。所有输入携带完整 instance ref（`runtimeId + engineInstanceId +
generation`）以及 `controlEpoch + inputSeq + viewportRevision`。服务器拒绝错误 runtime/
instance、旧 generation、旧 epoch、非 holder、重复 inputSeq 和旧 viewport。

`expiresAt` 只供显示；客户端不能凭本地时钟自行授予控制权。Authority 重启必须提升
generation，controlEpoch 只要求在同一 generation 内单调。

### 13.3 实时帧是数据面

Remote frame 携带 `frameSeq` 与 viewport descriptor。图片/视频本体走独立 media/data
plane，允许丢旧帧和背压，不进入 Replica、Journal 或持久资源索引。

Remote Presenter 将本地 `SurfaceLayoutFrame` 与当前显示帧 viewport 组合：扣除
clip/letterbox 后换算到 Authority viewport CSS px。显示帧、layoutEpoch 或 Authority
generation 在 pointer down 与发送之间变化时，丢弃输入而不是猜坐标。

## 14. Replica、Checkpoint 与安全

### 14.1 可进入 V4 Replica

- V4-native Remote Authority 的 durable session created/ended 和可重放状态；
- Browser 与 Conversation 的服务端权威关系变化；
- 清洗后的 URL/title/navigation outcome；
- 用户明确保存或工具产出的截图/页面快照资源引用。

Controller lease、presence、loading、音频、Presentation、viewport 和实时 frame 都是
ephemeral state，不进入 durable Replica Journal。

Codex V3 browser-use/tool 事件可以投影为聊天活动、截图和链接，但在没有协议证据时不
假设它提供完整交互式 Browser RPC。

### 14.2 本地 View Checkpoint

```ts
export type BrowserRestoreHandleRef = string & {
  readonly __brand: "BrowserRestoreHandleRef";
};

export interface BrowserCheckpointV1 {
  readonly version: 1;
  readonly browserSessionId: BrowserSessionId;
  readonly authorityProfileId: BrowserAuthorityProfileId | null;
  readonly safeUrl: BrowserSafeRestoreUrl | null;
  readonly restoreHandleRef: BrowserRestoreHandleRef | null;
  readonly capturedAt: number;
}
```

安全材料只存在 Electron main 加密存储、iOS Keychain 或远端 vault。普通
IndexedDB/localStorage 只保存 opaque ref；Web 没有安全 vault 时 ref 必须为 null。
`runtimeId`、`engineInstanceId`、Authority/Presentation generation、adoption lease 和
WebContentsId 永不进入 checkpoint。恢复后创建新 runtime/instance，并通过新的 binding
generation fence 掉旧事件。

### 14.3 永不持久化到普通 View/Replica

- Cookie、localStorage、sessionStorage 内容；
- Bearer token、OAuth code、签名 URL；
- WebContentsId、WindowProxy、DOM node、MessagePort；
- 摄像头/麦克风授权 token；
- 原始恢复材料和注入脚本闭包。

原始 URL 默认敏感。Disclosure policy 决定保存 origin、清洗后的 path、hash 或完全
省略。

## 15. iframe Bridge

握手流程：

1. Host 创建 nonce、embedId 和 MessageChannel；
2. iframe load 后 transfer port；
3. 双方校验协议版本、nonce、embedId、source 和 allowed origin；
4. 业务消息只走 MessagePort；
5. 每个 requestId 只允许响应一次；
6. clipboard、download、popup、camera、microphone 默认拒绝。

Bridge 不发送原始登录 token。可信 iframe 也只能调用最小权限委托 RPC，Host 返回业务
结果或短期、单用途 capability handle。

Assistant HTML 使用独立更严格 CSP，不与通用浏览器共享 Cookie、权限或 Bridge policy。

## 16. TanStack Query

适合：

- Browser/Thread catalog；
- bookmark、下载记录和持久 artifact 元数据；
- capability discovery；
- 冷数据分页查询。

不适合：

- active Browser Session snapshot；
- Presentation visibility/focus；
- pointer/frame stream；
- Panel drag animation；
- Replica cursor 状态机。

Query key 必须包含资源真正的 identity，不能仅用裸 session/thread ID：Host 数据使用
`hostId`；Authority 配置目录使用 `profileId`；只在缓存一次运行时实例结果时才加入
`runtimeId + generation`。持久查询键不得包含短命 `engineInstanceId`。

## 17. 失败与恢复

### 17.1 iframe 拒绝

```text
navigate → embed-denied
  → policy allows remote ? bind replacement Authority runtime/instance
  → otherwise external fallback
```

逻辑 BrowserSessionId 保持不变；Authority Binding generation 提升。

### 17.2 Host/Authority 断线

```text
connectivity = recovering
  → 保留最后可显示 snapshot/frame
  → transport reconnect / replica catch-up
  → allocate new runtimeId/engineInstanceId as needed
  → rebind with new AuthorityGeneration
  → ready or explicit failed
```

### 17.3 Presentation 丢失

```text
presentation lost
  → PresentationGeneration + 1
  → Engine survives detach ? attach replacement
  → otherwise Session suspended → restore Engine instance
  → stage → atomic reveal
```

### 17.4 防 React 更新环

- `getSnapshot()` 无变化时返回相同引用；
- React effect 只订阅，不把 snapshot 无条件写回 Store；
- bounds 使用 epsilon + animation-frame coalescing；
- Surface measurement 不回写 AppShell 宽度；
- plugin registration 不在会反复挂载的内容组件里；
- connection、Authority、Presentation、Layout generation 分别校验；
- View claim/Backing owner 变更必须走幂等 command，不允许订阅回调同步反写同一个 Store。

## 18. 最小包结构

第一阶段：

```text
packages/
  application-supervisor/
  browser-core/
  browser-runtime/
  workbench-resources/

apps/workbench-web/src/browser/
  iframe-engine.ts
  web-presentation-root.tsx
  browser-panel-plugin.tsx
  browser-toolbar.tsx

apps/workbench-desktop/src/browser/
  electron-browser-host.ts
  electron-browser-ipc.ts
```

等第二个 Adapter 证明独立变化原因后，再考虑抽出：

- `browser-presentation-runtime`；
- `browser-bridge`；
- `browser-appserver`；
- `workbench-layout-web`。

包边界按依赖方向和独立发布/测试需求建立，不按概念数量机械拆包。

## 19. 测试不变量

### 19.1 身份与 Runtime

- 同一 Thread ID 在不同 Host 不碰撞；
- BrowserSessionId 不因 Authority replacement、Panel 切换、Renderer 重载而改变；
- `profileId` 可稳定持久化，`runtimeId/engineInstanceId/generation` 不从 checkpoint 复用；
- Conversation host 与 Browser Authority 可以不同；
- Supervisor 逆序销毁全部子 Runtime；
- 多个 Cordis Context 允许存在，但同一物理 connection/instance 只有一个 owner；
- Strict Mode/HMR 不创建重复连接。

### 19.2 Browser Domain

- resource/connectivity/navigation 三条状态轴不互相覆盖；
- 错误 runtimeId/engineInstanceId、旧 AuthorityGeneration、重复 eventSeq 和迟到
  navigationId 被拒绝；
- unsupported capability 不修改 snapshot；
- URL 只能由 policy 构造；
- 不伪造完整 native history；
- closing tombstone 阻止资源复活。

### 19.3 View 与 Presentation

- ViewHandle dispose 幂等；
- collapse/switch 只 background，不释放 ViewHandle；
- React unmount 只释放 View，不能 close Session 或 terminate Authority；
- close logical Session 与 terminate Authority 是两条独立命令；
- agent-use 在 UI unmount 后仍能保持 Backing；UI 在 agent-use 结束后仍可凭 logical-tab
  owner 保持 Backing；
- owner set 清空只触发驻留 policy，不伪造远端 terminate；
- 同 Renderer 一个 Session 最多 reveal 一个前台 Presentation；
- 快速 A → B → A 无白闪、串页和迟到 reveal；
- 高频 bounds 不触发 React snapshot storm；
- hidden Presentation 同时关闭 pointer 与 accessibility exposure。

### 19.4 平台 capability contract

测试按 capability 运行，不要求每个平台假装支持相同功能：

| 能力 | Vite iframe | Electron | Expo Native | Remote |
| --- | --- | --- | --- | --- |
| arbitrary origin | 有条件 | 是 | 是 | 是 |
| survives detach | 否 | 是 | 通常否 | 是 |
| multiple viewers | 否 | 否 | 否 | 是 |
| native history projection | 有限 | 是 | 是 | 是 |
| cross-device same instance | 否 | 否 | 否 | 是 |

### 19.5 Remote 与安全

- observer 不能获得控制权限或发送输入；
- stale generation/controlEpoch/inputSeq/viewportRevision 全部拒绝；
- controller 断线后必须重新 acquire；
- frameSeq 可丢旧帧，慢客户端不阻塞 Authority；
- 实时帧不进入 Replica/Journal；
- 原始 URL secret、Cookie 和 restore candidate 不进入普通 storage；
- iframe origin/source/nonce/requestId 重放测试全覆盖。

### 19.6 AppShell

- `left + main + right == shell`；
- Browser Presentation 不溢出 slot/clip；
- full-width header actions 不重叠；
- 折叠后 reopen action 仍可见；
- 639px 与 iPad split 无页面横向溢出；
- Panel 拖拽不改变聊天时间线宽度权威。

## 20. 实施顺序

### Phase -1：修正现有横切边界

- 引入 `ApplicationSupervisor`，把 Runtime 创建移到 React bootstrap；
- 保留多个 lifecycle Context，建立唯一物理资源 owner 测试；
- 引入应用级 `HostRuntimeRegistry`；每个 HostRuntime 直接拥有一个 AppServerClient；
- 将 `createAppServerWorkbenchRuntime()` 的单项 client registry 降为兼容 factory/test
  utility，避免两层 registry 竞争生命周期；
- Panel key 升级为 `ConversationKey`；
- 将桌面 layout state 从共享 Resource registry 分离；
- 删除 mock panel resource 与真实资源的混用。

完成门：多 Host ID 不碰撞，Strict Mode/HMR 不复制连接，Web 现有功能不回归。

### Phase 0：Vite 单标签纵切

- 最小 browser-core/runtime；
- same-origin iframe Engine；
- Web Presentation Root；
- navigate/back/forward/reload、collapse/reopen；
- URL/Bridge/security fixture。

完成门：一个逻辑 Session 在 Panel 折叠、展开、切换后不丢失，iframe denied 明确降级。

### Phase 1：Electron 第二实现

- main-process WebContents Engine；
- typed IPC、partition、权限和 crash recovery；
- Renderer reload reattach；
- 与 iframe 共用 Domain contract。

完成门：第二 Adapter 暴露的问题已回写 SPI，尚未使用的抽象被删除。

### Phase 2：冻结 v1 与多标签

- 冻结 Engine/Presentation v1；
- 多 Session、多 View、最近标签回退；
- stage/reveal/background；
- checkpoint 与故障恢复；
- 动态 title/favicon presentation。

完成门：快速切换 100 次无白闪、错页、泄漏。

### Phase 3：Remote Browser

- AppServer namespace/capability discovery；
- WebSocket 与 WebSocket over SSH；
- observer/controller lease；
- frame data plane 与坐标换算；
- Remote durable facts 的 V4 projector。

完成门：Web、Electron 可以观察并接管同一 Remote instance，旧输入无法穿透 fencing。

### Phase 4：Expo

- Native WebView Engine/Presentation；
- resident pool 与内存回收恢复；
- iPad split、iPhone route、Expo Web iframe；
- safe area、keyboard、gesture、VoiceOver。

完成门：共享命令/身份/capability fixture 通过；不要求各平台物理 history 完全相等。

### Phase 5：Inline Sandbox 与生产强化

- Assistant HTML 独立 CSP/Bridge；
- artifact/attachment host；
- 下载、权限、审计与遥测；
- capability-based chunk 边界。

## 21. 迁移与删除

通过对应门后逐步删除：

- Panel 组件本地 `currentUrl/history/loading`；
- `display:none` 偶然保活 iframe；
- ResizeObserver 回写 AppShell 主宽度；
- 修按钮重叠的局部 z-index workaround；
- timeout 恢复条件渲染后的 Surface；
- mock Changes/Terminal 占位资源；
- React Provider 内创建物理 Runtime；
- 只用裸 `threadId` 的 Panel Map；
- 把 right/bottom/full-width 暴露给 Native 的共享状态；
- UI 直接终止 Remote Authority；
- 用 View 数量或 React unmount 推导 Session/Backing 生命周期；
- 同时让低层 AppServer client registry 与 HostRuntimeRegistry 拥有同一 client；
- 把 Authority profile、runtime incarnation、Engine instance 和 restore ref 混成一个 ID；
- 把逻辑 Browser ID 与 Conversation Host 强制绑成同一复合主键的错误不变量；
- Surface 上重复的 restore/history ownership。

不做一次性大清理。每类删除前先落地不变量测试。

## 22. 完成定义

1. Conversation identity、Browser logical identity、Authority profile/runtime/Engine binding 和 Presentation identity 完全分离。
2. 一个 Supervisor 管理多个生命周期域；同一物理资源只有一个 owner。
3. 共享 Resource 不含 right/bottom/full-width 等平台布局状态。
4. Browser UI snapshot 不暴露 Backing/WebContents/storage/eventSeq 内部细节。
5. Authority、Presentation、Host policy 和 Session lifecycle 命令不混用。
6. iframe 与 Electron 两种实现共同证明并冻结 Engine/Presentation v1。
7. Local 只承诺共享行为；只有 Remote 承诺跨设备同一运行实例。
8. Remote control 有 generation、lease fencing、input sequence 和 viewport revision。
9. 实时帧、presence 和 control lease 不进入 durable Replica。
10. 原始秘密与恢复材料不进入普通 checkpoint。
11. 高频几何不形成 React/Cordis/AppShell 反馈环。
12. Vite、Electron、Expo 按 capability contract 验收，而不是伪造完全相同的平台能力。
13. React unmount、View dispose、Session close、Authority terminate 与 Backing destroy 有独立命令和测试。
14. 每个 HostRuntime 拥有一个逻辑 AppServerClient；共享物理 transport 时只由 TransportBroker 复用帧通道。
15. 插件只能经 capability Port 请求 Browser 操作；Extension unload 不销毁不归它所有的 Session、Backing 或 Surface。
16. Agent 只看到 Browser Capability，不看到 Extension/Engine/Adapter；每次调用都钉住 Lease、Provider revision 与 Invocation identity。

最终形态不是“一个巨大 Cordis Context 管住五层”，而是：一个稳定语义模型、一个显式
Supervisor、多个有清晰所有权的 Runtime scope，以及可被两种以上实现证明的最小接口。

## 23. R6 复审结论

本轮对照 Codex r2030 与 OpenCraft 当前实现后，以下问题已经定案，不再作为实现阶段的开放
二选一：

1. View 只是 presentation claim；Session、Authority 与 Backing 生命周期不能由 React
   mount 数量推导。
2. Authority 使用稳定 `profileId`、短命 `runtimeId`、物理 `engineInstanceId` 与 binding
   `generation` 四层身份；checkpoint 只保存 profile 与 opaque restore ref。
3. 应用级 Registry 索引完整 `HostRuntime`；每个 HostRuntime 直接拥有一个逻辑
   AppServerClient；物理多路复用下沉到可选 TransportBroker。
4. 逻辑 Session close 与 Authority terminate 分开；close 先提交 tombstone，物理清理最终
   完成，不能回滚成 active。
5. Cordis 是内部生命周期内核，不是社区扩展 ABI 或安全沙箱；跨 Chat/Panel/Browser 的
   插件贡献由 ExtensionSupervisor 原子登记，社区代码只能经过 capability/sandbox 边界。
6. Extension 是 Browser Capability 的实现载体，不是 Agent-facing identity；Resolver、
   Task Lease、Execution Router 与 Receipt Journal 属于 AgentCapabilityRuntime。

当前代码与目标模型之间仍有四项明确迁移工作：

| 当前路径 | 现状 | R6 目标 |
| --- | --- | --- |
| `packages/workbench-runtime/src/appserver-runtime.ts` | 每个单 Host runtime 内创建一项 Cordis client registry | HostRuntime 直接拥有 client，由应用 HostRuntimeRegistry 索引 |
| `apps/workbench-web/src/runtime/appserver-runtime-context.tsx`、`apps/workbench-expo/src/runtime/runtime-context.tsx` | Runtime 仍由 React Provider 构造 | bootstrap 的 ApplicationSupervisor 构造，Provider 只借用稳定引用 |
| Browser packages | 尚未实现本设计的 Session/owner/presentation 分层 | Phase 0 iframe 与 Phase 1 Electron 两个纵切共同校正 SPI |
| Chat/Panel renderer registries | 各自暴露内部 Cordis `install(plugin, unknown)` | 保持内部 API；由 ExtensionSupervisor/Contribution Broker 提供公共扩展入口 |

仍然保持 provisional 的只有物理 Adapter SPI 细节、Native resident pool 策略和 Remote
Browser 协议能力发现；它们必须由第二实现或真实服务证据决定。身份、生命周期与 Host
client 所有权不应再因这些 Adapter 细节反复改动。
