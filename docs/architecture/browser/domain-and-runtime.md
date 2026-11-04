# Browser: Domain and runtime

[Architecture index](../../browser-workbench-architecture.md) · [Documentation index](../../README.md)

## 7. Browser Domain 最小契约

### Headless 文件目录与原生预留

Headless 远程浏览器由 `RemoteBrowserService` 和 `BrowserStateFile` 单独拥有持久目录；
继续使用 `remote-browser/tabs.json`，不引入数据库。文件的 `pages` 是已提交逻辑 Session，
包含账户 owner、稳定 key/id、聊天 link（或 null）、逻辑 lifecycle、runtime 及操作身份。
`states` 保留旧客户端 tabs/pages/storage/bindings 的兼容投影和按 key 的 CAS 版本/操作回执；
它们的最后一个依赖提交时，把完整关联一并登记为 Session。缺关联的既有记录仍保留在账户目录，
不能从消失的聊天 alias 推导关闭。输入、媒体、Viewer 和控制继续使用既有 owner。

文件提交通过一个同步 reducer 修改隔离草稿，临时文件 fsync、rename 和目录 fsync 后才公布；
checkpoint 只更新已提交 Session 的恢复参数，不从在途 Viewer Map 推断是否创建成功。
Linux 抽象 Unix socket 是该目录的进程级写锁，进程退出由内核释放；所有文件写入共用队列，
native 等待不持有文件队列。受管切换必须等待旧 Gateway 退出/释放 writer，再接管同一目录；暂忙的 load 可重新尝试，
不能把一次 writer 争用永久缓存为初始化失败。损坏文件仍保持 fail closed。

逻辑 Session 为 open/closing/closed；原生状态为 absent/starting/live/stopping/unknown。
Ensure 在同一提交中检查全局64/账户16的原生预留并登记 starting（代次及 operationId），
随后才发送 native create；逻辑保留单独上限为每账户256，不把恢复记录数量当驻留容量。
结果不明保持 unknown 和占用；仅 native ACK 或排空后的独占 owner inventory 可以确认状态。
初始化失败经已确认 close 后回到 absent，逻辑 Session 仍在目录，可重试或显式关闭。
目录读取从不启动原生页面。关闭先提交 tombstone/closing，再排空 create、ACK 原生 close，
最后移除活跃目录记录，永久 retired key 阻止旧请求复活；失败意图在重启后继续收敛。
同 key attachment 队列、native 通道屏障和 Gateway runtime epoch 阻止迟到 ACK 改写替代实例。
当前保留 protocol1 活跃 owner，不声称已有完整跨任意原生进程的 generation ABI。

新 Web 客户端在 open 前等待元数据 flush，并要求服务端验证已提交关联；失败不启动页面。
metadata 使用对象 key 版本隔离无关字段的冲突；操作回执保留256项，GC 后旧请求的原 CAS
版本已过期，不能重新执行。同一操作 ID 携带不同内容会被拒绝。兼容旧全账户 CAS 客户端，
不悄悄合并同一 key 的并发整份替换。元数据失败仍明确要求刷新同步，不冒称自动合并。

浏览器工具栏“Browser resources”读取认证账户的服务端目录，显示未关联/保留/运行/等待确认/关闭中，
并提供显式关闭与未关联资源接回当前聊天。其他聊天的页面保留原 scope，不能借管理列表绕过 Agent
的聊天隔离。资源清单保留最后成功结果，刷新失败原位显示；关闭弹窗不卸载原聊天或输入草稿。
旧 tabs/storage 协议仅作有界迁移兼容，不能把本实现描述为所有平台已切到统一 Session API。

### 7.1 正交状态

```ts
export type BrowserResourceStatus = "open" | "closing" | "closed";
// Logical retention and native residency are independent. Failure belongs to
// the operation, never erases the accepted Session from its owner's catalog.
export type BrowserRuntimeStatus = "absent" | "starting" | "live" | "stopping" | "unknown";

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
  readonly runtimeStatus: BrowserRuntimeStatus;
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

Chat 中的 HTTP(S) 链接先经过 Chat resource policy 得到清洗后的目标，再以
`ChatResourceOpenIntent` 请求 Browser：普通点击默认当前产品选择，Command/Ctrl/中键
只声明 `new-tab` disposition，右键菜单可明确选择 in-app 或 external browser。Chat
Renderer 不创建 `BrowserSession`、不保存 URL，也不把 DOM Event 传入 Browser Domain；
Browser Runtime 继续拥有具体 Session、tab 与 surface。favicon/tooltip 属于 Chat Web
presentation，不是 Browser snapshot 或 history。

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
[`plugin-architecture.md`](../../plugin-architecture.md)。

Agent 不直接调用 Extension 或 Browser Adapter。`AgentCapabilityRuntime` 把 Browser 操作投影为
稳定 Capability，经 task-scoped Lease 与 Execution Router 调用；每次导航、交互、截图或
远端控制仍遵守本文的 Session/Authority/Presentation owner 和 generation fencing。完整
AI 原生模型见 [`agent-capability-fabric.md`](../../agent-capability-fabric.md)。

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

### Browser Host registry contract (2026-10-20)

`BrowserHostRegistry` owns stable storage modes, Host
registration attempts, mount claims, browser-use projection, transfer/prewarm
and cleanup; the existing independent transition continues to own paint handoff.
Current Host reference and registration-attempt identity fence asynchronous
results. A presentation release does not close its logical Page or backing.
The real Web consumer baseline preserves iframe/document/draft identity across
remount, rapid switching, live resize and a device/floating presentation.
Native teardown policy was observed through an explicit synthetic port, not a
new Web Host capability.

### Incremental Conversation binding owner

The binding store offers a per-entity persistence port (`records.load/put/remove`) and
`subscribeScope` alongside the legacy snapshot adapter. Register and promotion only
persist the changed Scope; snapshots enumerate the catalog when explicitly requested.
A canonical Thread Scope can be derived without writing another durable alias. Restored
Draft aliases remain distinct identities even if they target the same Thread, with a
separate preferred Scope index for activation. Removing one alias preserves the others.

React display-key consumers subscribe to their own Scope. Connector lookup resolves an
indexed Scope while retaining the Host check. This is the shared binding foundation;
local and remote resource-record adapter rollout is a separate change. Existing clients
that inject the legacy `save` port still serialize snapshots and do not gain constant
update data size merely by adopting this API.
