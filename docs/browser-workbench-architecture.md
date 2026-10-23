# OpenCraft 跨平台浏览器工作台实施设计

> 状态：Web iframe、Electron webview 与 Linux Server H.264 Surface；各平台验收分别记录，Playwright/Expo Adapter Proposed
> 目标平台：Vite Web、Electron Desktop、Expo iOS/iPadOS、Expo Web  
> 架构修订：R6（浏览器生命周期、多 Host 与 AI Capability 边界复审）
> 当前已实现 `browser-core`、Web iframe Runtime、应用级 Presentation Root、右侧多
> Tab 投影、显式关闭、会话恢复、聊天外链接入，以及 OpenVibe 形状的 typed Preview Bridge。
> Authority/Backing owner、Electron
> WebContents 与 Expo Adapter 仍按本文设计继续演进。

## 1. 结论

Shell 几何：Viewport 用 flex
表达可见范围并裁切，Frame 独立消费 F=max(0,W-min(R,A))，且 min-width:100%；
聊天容器查询归 Frame，而不是动画 aperture。显隐和全宽是两个 MotionValue，
同一个 Shell 事务 owner 停止旧写入者并提交新目标，模式切换先消除半关闭状态，
scope/reduced-motion 使用端点。退出期间保存同 scope 的布局描述；普通窗口/分隔线
resize 不冻结内容。原生 guest 上方的临时 resize 捕获层只在拖动事务存续期间存在，
松手/取消/失焦结束，避免 guest 吞掉主页面 pointermove。

ApplicationSupervisor
创建的 BrowserPresentationCoordinator 经原薄 adapter 实例化独立 Host registry 与
PagePresentationTransition。管理器仍拥有 backing host、存储身份和挂载代次；ElectronBrowserSurfaceHost 仅提供
独立 body root、标准 guest、导航及持久化端口。面板仅申领挂载并提交几何，park/unmount 不销毁页面，
显式 close 才销毁。逻辑 Page、持久化 browserStorageId、rendererInstanceId、
host generation 与 mount generation 分离。存储分区采用标准 Electron partition。

原生导航事件是桌面 URL、title、Back/Forward 的真源。主进程校验 guest URL/partition，
强制 sandbox/contextIsolation、禁用 Node/任意 preload 与嵌套 webview。

桌面宿主补齐（2026-09-14）：window.open/target=_blank 经 Main 验证后发送
guest identity，由原页面所属 Scope 创建受管理的新标签，不能改写原页面。后台创建
使用 visible=false，不挂载面板；DOM 操作及截图取得互斥 browser-use claim，
结束/失败均释放并恢复用户交互。页面内容仍为不可信输入，语义输入不是 trusted input。
截图仅桌面支持，动态工具用 inputImage 返回，不通过文本伪装图片。

权限决定保存在 Main 私有存储，按分区、顶层网站 origin、权限类型隔离。仅通知、
位置、摄像头、麦克风可请求用户许可；未知权限默认拒绝，跨来源 iframe 不继承顶层授权。
导航或撤销期间的迟到确认不能持久化授权。网站权限入口可撤销并重载；清除网站数据
为独立确认操作，作用于当前标签的隔离分区，不影响其他标签。普通 close 只删除逻辑
标签/页面/索引与 backing，不隐式清除 Cookie。
边界：受管新标签不是原生 popup WindowProxy，不模拟 window.opener/postMessage
弹窗登录协议，也不接管已有 WebContents；依赖这类协议的网站流程应使用系统浏览器。
权限设备能力仅验证主进程策略与隔离/撤销链路，测试没有调用真实摄像头、麦克风或位置服务。
关闭后的分区 ID 移入 retired inventory；“清理已关闭标签数据”再次确认后清除其
Cookie/缓存/网站数据及权限记录，并跳过重新成为 active 的分区。截图和权限请求
分别检查文档代次；Agent claim 的释放不能解除源 handoff 尚未释放的交互锁。

标签恢复遇到尚未恢复的 Scope 保留为 dormant，不当成关闭命令。
标签恢复属于工作台启动路径，不能依赖旧版 Safari（包括 iPadOS 16.7.2）缺少的
Iterator helpers（如 `Map.values().map()`）。需要映射时先用标准数组收集；
空状态也必须可恢复，既有有效页面保留、孤立页面清理规则保持。
兼容回归通过移除迭代器辅助方法验证此能力边界，不能冒称对应 iPad 实机验收。桌面 Scope 绑定、
标签、页面及 storage ID 元数据通过主进程存储，不能依赖启动时变化的 localhost origin。
空白 backing 交由源管理器 prewarm 所有权管理；首次加载前已设置分区与 sandbox。
崩溃恢复通过标准 guest reload 重建 renderer，保持 logical page 和 partition。
设备预设保留应用兼容数据，数值helper与拖动计算已分别有界替换；尺寸变化消费现有registry与工具栏投影，持久化仍由标签偏好owner负责。

设备工具栏呈现（2026-09-14）：按源 DeviceToolbar/数字输入的布局和编辑语义迁移，
地址栏只保留设备模式开关；设备模式显示 34px 单行工具栏（预设、宽 × 高、旋转、
缩放、关闭）。数字输入 72×24、浅主题背景/透明边框，焦点态可见；小于600px隐藏
缩放，小于460px隐藏 Dimensions 标签。宽高输入保留编辑草稿，合法数值即时应用，
失焦/Enter 时规范化。拖动来自左右/底边/两个底角的真实视口边界，而非文字按钮；
pointer capture、取消与键盘操作属于控件，页面尺寸仍由共享 viewport layout 计算。
父层mode/zoom与本地聚焦草稿分开；预设选择重置受支持zoom，旋转保留模式身份，Enter阻止默认提交后失焦，Escape只失焦。相邻手柄与共享样式未改。
浏览器内的 PreviewBridge 复用现有敏感字段策略与语义输入，不声称 trusted input/CDP。


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

### 原生远程编辑运行时

自有 Electron 源码定义与补丁由 [vendor/electron](../vendor/electron/README.md)
持有。首个补丁恢复 OSR 的 Chromium 文本状态管线，并提供只读原生选区、组合范围和
光标几何查询；它不是原子快照，不包含输入授权或跨文档唯一编辑身份，当前发行包
尚未消费此 fork。缺失的几何保持不可用，不由 DOM 或控件边缘推测。

第二个补丁是测试用途的原生目标绑定实验：通过每 frame 的 Mojo 通道取得单次
context token，在 renderer 内校验文档、焦点代次、组合代次和原生编辑快照，再调用
Chromium 的组合/提交/取消。Blink 编辑路径中的 scoped guard 在网站同步事件回调后
复核原始焦点和编辑根；取消还要求属于本轮创建的组合会话。不把已发生的网站脚本
副作用描述为可回滚，不将 renderer 断连后的未知结果自动重试。详见 vendor README
和 `probe-target-ime.cjs`；源码重放、原生编译与探针实测分别记录。

后续输入桥接保持远端原生编辑器为正文唯一写入者，本地系统输入法拥有候选会话。
严格目标绑定、焦点/文档代次、迟到提交/取消、原生客户端上下文、触摸及 DevTools
共存需要独立运行验证；不能用源码重放成功替代真实编辑体验或权限验证。

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

`right | bottom`、320px、磁力压缩、full-width 和 Workbench header slot 都是 Vite/Electron
布局策略。Expo Native 共享 Resource/Session/Command 契约，但使用 split view、stack、
sheet、safe area 和 native gesture。

### 2.5 抽象由第二个实现证明

第一版只冻结最小产品契约。iframe 纵切完成后接入 Electron WebContents，用第二种
物理实现校正 Engine/Presentation SPI；通过两种 Adapter 后才冻结 v1，不预先为所有
未来平台设计十几个空包。

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

| OpenCraft 字段 | 稳定范围 | 边界职责 | 是否进入普通 checkpoint |
| --- | --- | --- | --- |
| `profileId` | 用户配置/路由选择稳定，如 `local-electron` 或某 Remote 集群 | Host kind、远端配置与路由 policy | 是 |
| `runtimeId` | 一次 Authority 进程或连接 incarnation | 连接代次隔离迟到结果 | 否 |
| `engineInstanceId` | 一个实际浏览器 Backing | 私有 WebView/WebContents 映射或远端 instance ref | 否；`browserStorageId` 对应的是下文 opaque restore ref |
| `generation` | 当前 Session 绑定序列，rebind 时单调增加 | 重绑代次隔离迟到结果 | 否 |

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

一次 Electron WebContents handoff 的租约不应泛化为上述 owner 模型的通用计数器。

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

浏览器 Dynamic Tools 的 schema 随 Electron/Web Renderer 构建，执行 handler
也由该 Renderer 的 Browser Runtime 持有；它们不是 Daemon 打包开关。每次物理
AppServer 连接恢复后，Workbench 必须建立一个 connection-owned Thread capability
lease，并核对 Host/DSH 实际注册数量与声明数量完全相等，之后 Thread 才能进入
resident/executable。零个或部分注册是 readiness failure，不能让模型进入一个
“看见浏览器说明、实际只能得到 UNKNOWN_TOOL”的半连接状态。

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
native 等待不持有文件队列。受管切换必须等待旧 Gateway 退出/释放 writer，再接管同一目录。

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

以下所有权与生命周期规则已经定案，不再作为实现阶段的开放二选一：

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

### Embedded preview projection

The domestic console's hidden Chat projection exposes browser tabs and read-only
conversation file previews. Browser pages, tabs and bindings use application-local
metadata storage. The outer console disposes that application on Bot/account
changes; physical filesystem or cookie isolation is not implied.

Web iframe bounds are measured in window coordinates, then translated by the
Presentation Root's client rect before positioning an absolute physical surface.
This keeps the same page aligned inside a contained Shadow DOM host and in the
standalone viewport, including panel resize. The new-tab placeholder follows the
Workbench locale without changing a navigated page's content.

## Web product navigation

The application composition root may supply a `BrowserNavigationPolicy`. The browser
coordinator routes an external destination before creating a Page, logical Tab or
panel. Address-bar navigation uses the same policy before changing Page history;
an external destination leaves the existing Page and panel intact. New-window
requests forwarded to the coordinator follow the same route. Tools report external
routing without claiming that an external tab is controlled or inspectable.

the downstream product's embedded composition and the standalone browser-hosted Web bootstrap
supply the same allowlist of `lightvela.ai` and
`lightvela.com`, including subdomains. Matching uses a parsed HTTP(S) hostname and a
DNS label boundary, not arbitrary URL text. Other destinations open with
`_blank` and `noopener,noreferrer`, preserving the containing conversation. The full
Electron workbench supplies no policy and retains its native browsing behavior. This is a
policy for OpenCraft-initiated navigation, not a security boundary for redirects or
navigation initiated inside an inaccessible cross-origin guest.


### Viewport drag geometry replacement (2026-10-20)

The `viewport-resize.js` pure helper owns axis geometry. Device preset facts,
source manager, toolbar and transition ownership remain with their current
owners.
Horizontal handles resize around a fixed center, bottom handles alter height,
and the captured scale maps pointer movement into bounded viewport dimensions.
Pointer capture, cancellation, keyboard and persistence remain in their current
owners.


### Browser presentation transition ownership (2026-10-20)

The manager continues to own backing hosts, storage and mount claims. Its
presentation transition module now independently implements owner/surface leases:
a pending incoming view retains the painted outgoing view, blocks both during
handoff, accepts a current attachment ack or bounded deadline, then prewarms for
two frames and releases on the next frame. Registration only updates stacking.
Removal, route transfer, hidden sync and rapid replacement revoke scheduled work;
old callbacks cannot reclaim a newer reference or generation. Surface moves retire
the previous presentation claim. Automation input/focus locks remain on the Host.



### Replaced host registration completion (2026-10-21)

When a selected host is replaced before it has registered or painted, the
transition retires that host's current presentation reference before showing its
replacement. A later registration may finish preparing the retained backing but
must keep its old presentation parked. The selected tab, visible page and input
recipient must agree; logical pages and drafts remain alive until explicitly
closed. Current owner, reference and generation fences also apply to this early
replacement path.

### Browser Host registry contract (2026-10-20)

The explicitly copied manager class is independently expressed from frozen
consumer contracts and opaque execution. It owns stable storage modes, Host
registration attempts, mount claims, browser-use projection, transfer/prewarm
and cleanup; the existing independent transition continues to own paint handoff.
Current Host reference and registration-attempt identity fence asynchronous
results. A presentation release does not close its logical Page or backing.
The real Web consumer baseline preserves iframe/document/draft identity across
remount, rapid switching, live resize and a device/floating presentation.
Historical hashes and the current module lock remain separate. Native teardown
policy was observed through an explicit synthetic port, not a new Web Host
capability.

### Viewport preset compatibility data (2026-10-20)

The preset module retains the existing ordered 13-entry application catalog,
disabled responsive default and lazy/idempotent public initialization. The
toolbar and manager consume the same six declared exports. Numeric helpers
round and bound width/height without owning capture, persistence or scale.
Unused, undeclared recovery utilities/tokens are removed; device names and
application dimensions are retained. This catalog is not a hardware specification.


## Linux Server 远程网页 Surface（2026-10-21）

Headless 包内置同版本 Electron，Gateway 的 RemoteBrowserService 惰性启动独立进程；不渲染工作台 UI、不公开 CDP。支持 H.264 的客户端使用 RemoteBrowserSurfaceHost（安全上下文优先 WebCodecs，HTTP/其他客户端使用原生 MSE），现有 Tab、Page、Presentation manager、BrowserDynamicToolHost 与线程归属检查保持；普通 Web iframe 与桌面原生 guest 继续使用原适配。渲染地点固定为所连 Server，不因 Thread 的执行 Host 或 SSH Host 改变。远程网页直接访问该 Server 的网络；不把 SSH loopback 代理 URL 交给另一个执行地点。

Headless CPU rendering keeps hardware acceleration disabled and explicitly selects
ANGLE SwiftShader for software WebGL. This lets pages obtain a real WebGL context
on GPU-less servers, including mobile device detection that assumes the context
exists. Chromium requires the explicit `--enable-unsafe-swiftshader` opt-in for
this software backend; it increases the graphics implementation exposed to
untrusted pages. The dynamic browser UID, Chromium sandbox, permission defaults,
and lack of a public debugging port remain unchanged. WebGL workloads consume
server CPU and memory; this does not promise hardware-level 3D performance or
change DPR, device identity, H.264 encoding, or idle frame suppression.

远程网页跟随 Presentation 的 `viewportSize`（CSS 宽高）；responsive 模式使用内容区实时尺寸，设备尺寸预设使用其逻辑视口，不取客户端 devicePixelRatio，远端默认 DPR=1。尚无 View 时回退1280×720。`open.input.viewport` 和同连接 `viewport` 请求传宽高，尺寸归一为偶数、最小64、最长边4096，并以H.264 level 4的8192个16×16宏块（约2百万像素）限制软件渲染资源；超限按比例收缩。worker返回并先发布实际 `viewport` 配置，再输出该代关键帧；调整同一WebContents内容尺寸，不导航或重建DOM。客户端100ms合并尺寸、至多一个请求进行中及一个最新待处理，拖动期间持续更新；编码器按新尺寸重建、旧代结果失效，WebCodecs/MSE及输入坐标使用已生效尺寸。设备预设由共享BrowserViewportMode派生deviceProfile并随同几何传递；手机/平板使用worker内部私有Chromium仿真同步一致的移动UA/Client Hints（含iOS profile）、viewport meta语义、screen方向及触屏，DPR固定1。移动/触控profile将有界鼠标按下/移动/抬起串行转为Chromium真实touch序列，指针取消/捕获丢失与设备切换撤销未完成手势。桌面预设恢复桌面UA、metrics和鼠标，关闭设备栏则恢复跟随客户端；自定义调宽与旋转保留所选profile，同尺寸profile变更也必须应用。能力声明deviceEmulation=full仅表示该Chromium仿真链路，iOS标签不表示Safari/WebKit内核。首次直接以移动profile建立Page时先初始化本地about:blank renderer，再应用设备身份，之后才允许目标导航；设备切换不刷新、不重建DOM；按UA生成的服务端正文在后续导航或用户刷新时应用。worker串行化设备重配，并在导航/输入前等待已提交的设备变更，客户端不暴露任意CDP/UA/JS。软件 H.264 text hint、实时编码、Annex B；30fps 是活动上限，1.2秒后10fps，再2.8秒后2fps。静态去重不编码；非交互小更新固定150ms合并；仅一帧编码中和一帧最新待处理。全服务共享一个可信编码 renderer，各页面编码器在隐藏时释放。队列丢弃发生在编码前；编码后的预测帧保序，慢客户端断开后请求新关键帧，显示端只留最新解码帧。WebCodecs 无周期性关键帧；MSE 按缓冲回收水位请求关键帧，只在实际编码媒体积累时触发，静态不产生额外帧。鼠标形状同步，位置使用客户端系统光标。

同源 WebSocket 复用 admission、actor身份、到期和撤权；每个连接只持有 actor+随机持久化 storage lease 的页面。服务器生成物理分区 ID；Page、storage ID 与瞬时连接分离。View park 只停视频；显式 close 释放页面，保留 Cookie 分区。观看连接断开或 Application dispose 仅取消活动输入并停流，远端 Tab 不因断线计时销毁；每 owner 最多16页、全服务最多64页，不静默淘汰驻留页面。重新挂接存活 WebContents 时同步原生 URL/title/导航状态，禁止初始客户端导航覆盖原 DOM/JS。Tab、分区恢复身份、Scope/Thread 关联与工具栏元数据由同源认证的 Server 持有，客户端同步投影启动时加载，写入按 owner 版本比较拒绝旧客户端覆盖，并以同一 mutation ID 处理丢失确认；既有本地元数据只在远端全空时晋升，原本地记录保留且不作为权限凭据。恢复文件在私有目录以600权限原子替换，损坏拒绝读取而不清空。服务端进程退出保留 URL、有效尺寸/设备语义、zoom 及原隔离登录分区，下一次挂接重新加载；这与运行中重连有明确 resumed/restored 区别，不声称恢复任意 DOM/JS/表单/内存历史。明确 close/discard 删除恢复记录并释放页面，Cookie 分区仍遵循原保留策略。所有操作继续按当前 owner 校验，元数据同步不授予页面操作权限。预览桥在目标文档内运行，只暴露已有类型化操作，敏感字段拒绝及 revision/ref 校验复用原实现，语义输入不声称 trustedInput。远程手动坐标输入作用于同一目标 WebContents。

站点权限默认拒绝、下载默认阻止、popup 转为当前 scope 的受管标签。远程站点权限设置、下载管理、音频、跨后端运行中状态迁移、原生设备模拟尚未提供。登录态保留在服务端隔离分区，不发送到客户端。


### Remote tab state and viewer lifecycle

Responsive remote tabs follow the viewing client's normalized device identity:
iPhone, iPad (including desktop-style iPad UA), Android phone/tablet or a desktop
with/without touch. This does not forward arbitrary UA strings, browser brands
or physical DPR. The remote worker retains DPR=1 and uses the measured content
aperture in CSS pixels. Explicit device/desktop presets remain authoritative;
closing the device toolbar returns to following the client rather than forcing
desktop mode. A new unmeasured tab receives the bounded default identity before
its first navigation, while an existing tab keeps its stored configuration until
presentation supplies a measured layout. Device changes preserve the live DOM;
server-generated UA-dependent markup updates on later navigation/reload.

Pointer input carries its actual device type. A hybrid desktop's mouse remains
a mouse and its finger produces native touch; mobile presets still support
mouse-driven touch emulation. Pending moves cannot coalesce across pointer types.
A worker advertising `multiTouch` accepts complete active-contact snapshots with
up to ten stable IDs, bounded geometry/radii/pressure and an explicit start,
move, end or cancel phase. The viewer merges movement into one complete snapshot
per animation frame, flushes it before contact changes and captures every finger.
The ordered worker queue coalesces only adjacent moves with the same contact set;
partial release and new contacts are never coalesced. Older workers/clients retain
the single-contact mouse-emulation path.

Viewer pointer IDs are opaque local capture identities, not native protocol IDs.
Each active finger receives a free wire slot from 0 through 9; it retains that
slot until release/cancellation, and a remaining finger never changes slots when
another is lifted. This includes iOS WebKit's random unsigned 32-bit IDs, which
can exceed the private Chromium protocol's signed integer range. Reset retires
both identities together; the worker continues to reject invalid wire IDs.

The private native adapter selects Chromium's per-contact DevTools dispatcher
(`SyntheticPointerActions` disabled in this dedicated runtime). Start/end send
only changed native contacts; releasing one finger never releases/represses its
peers. This is verified on the pinned owned runtime, rather than relying on the
protocol summary's different all-contact release wording. The target renderer
receives trusted native touch and decides page scrolling, pinch zoom and custom
multi-contact behavior. Target viewport meta/touch-action and OS-reserved gestures
remain authoritative; there is no local CSS/video zoom substitute. Remote DPR
stays one even when the target's visual viewport is pinched.

Touch coordinates on the wire identify the rendered widget, after the viewer's
object-fit inverse mapping. The private CDP touch injector instead accepts CSS
coordinates and multiplies them by native page scale and browser zoom. The
worker reads native layout metrics at each ordered dispatch and divides the
widget coordinates by that scale exactly once, including mid-pinch and partial
release. Scroll/visual viewport offsets are not added: Chromium owns that
projection. Contact radii stay in widget units in this dispatcher. Empty release
and cancellation need no geometry query. There is no DOM scale inference, stale
viewer-scale cache, local predicted page zoom or public CDP command surface.

Blur, capture loss, parking, hiding, viewport/device changes, navigation and
transport detach cancel owned contacts. A late move/release or an added contact
from a retired gesture cannot recreate it. Native failure cancels the owned set
and rejects the operation; no press is retried into another document. Resize
clears local pointers without discarding the IME transaction. Native input is
validated at the worker boundary; arbitrary CDP commands are never forwarded.

Each owner-scoped remote tab supports up to 16 concurrent viewing sockets.
Modern clients opt into `open.multiView`; opening/reconnecting only attaches a
viewer and snapshots the existing native configuration. It cannot navigate an
existing document, resize it or claim input. An initial URL is accepted only
when creating a new logical tab. Bootstrap remains serialized per owner+lease.
Different owners remain isolated even when their lease strings match.

| Resource | Authority and lifetime |
| --- | --- |
| Tab, WebContents, partition, recovery checkpoint | Server; detach/park keeps the live document, explicit owner close/discard destroys the page and all viewing attachments |
| Encoded H.264 output | One encoder per tab, fanout to visible viewers; paint while any viewer is visible, suspend when none are visible |
| Socket, decoder, local geometry and keyboard candidate UI | Each viewer; a short output backlog recovers independently at a new keyframe, sustained overload disconnects only that viewer |
| Remote viewport, zoom, mouse, keys, touch and composition | Current control lease; observers scale the shared frame and cannot change remote geometry |
| DOM result, focus, selection, native editor identity | Remote renderer; private IME/context-menu/new-window events go to the current controller |
| Browser-use authority and read inspection | Existing actor/thread/tool authorization; a viewing attachment grants no additional rights |

An actual human interaction or the toolbar Control action requests an explicit
human lease. Merely joining, measuring layout, hovering, reconnecting or viewing
never requests control. Human input may take control from another client or an
Agent. Release, hide and disconnect relinquish human control; Agent writes
request a transient agent lease and release it in finally, and fail retryably
with CONTROL_BUSY while another controller owns the page. Read inspection and
capture do not acquire control. Agent operations remain semantic preview-bridge
operations with the existing sensitive-field and document-ref restrictions.

Each grant has a monotonic epoch and a private random token. The service checks
viewer membership, current authorization and token at admission. The ordered
native input queue checks the token again at dispatch; queued old input cannot
cross a completed handoff. Pressed keys/buttons, touches, context menus and IME
transactions retire before the replacement grant. Clients drop input queued
under an obsolete connection/control generation. Viewer dimensions do not
reconfigure an existing tab; only a human controller submits its chosen viewport,
after the active touch gesture finishes.

Legacy viewers retain single-socket takeover only among legacy attachments;
code 4009 still stops a displaced legacy client's retries. A legacy attachment
cannot evict modern viewers and is asked to refresh. This is same-account
multi-view support, not a cross-account sharing or collaborative-editing ACL.

A remote tab outlives its display socket. Its renderer is authoritative for page
content and editing; local presentation owns video decoding, client geometry
and system input. Disconnect suspends that viewer and releases its owned pressed
keys, buttons and touch contacts; video production continues for other viewers without navigating or destroying the page.

Managed Linux gateways running with root service management attach to a separate
DynamicUser browser owner over a private mode-0600 Unix socket. The owner holds
Electron and its bounded native stderr pipe in memory; it has no public listener,
CDP endpoint or persisted stderr. A Gateway deployment closes its viewing
connections with retryable 1012, but does not stop this owner. The next Gateway
uses a versioned handshake, adopts only native IDs already authorized by its
durable logical-tab records, and destroys orphan native pages. Owner handoff
drains previously accepted commands once, revokes all old input tokens and
pressed/composition state, and pauses video before returning native snapshots.
It never replays unknown writes or navigates an adopted document. Native DOM,
forms, scroll, history and effective viewport/zoom remain in the same process.
Immutable runtime files are retained outside release cleanup. Existing tabs
keep their pinned runtime; incompatible owner protocol is rejected without
replacing the live process. The initial migration from a pipe-owned worker
requires one replacement. Unmanaged/direct process adapters and actual owner
failure retain checkpoint recovery, which does not promise live-DOM survival.

Viewer output above 128KiB enters a bounded prediction-gap state rather than
immediately disconnecting. That viewer skips video until its output falls below
64KiB and a new keyframe arrives; control/authorization messages still flow.
Keyframe refreshes are bounded, other viewers continue the original stream,
and no stale video queue is retained. An unrecovered gap after ten seconds or
output above 4MiB closes only that connection with retryable 1013 and a two-second
close-frame drain deadline. Per-event bounded diagnostics distinguish paused,
resumed, stalled, owner detach, shutdown and numeric peer close codes without
URLs, input payloads or arbitrary native stderr.

Input/control boundaries are ordered in the worker; moves are flushed before
release and local compositions are discarded across a connection change.
Continuous touch/drag movement keeps the active paint cadence. The worker
coalesces only adjacent pointer positions that have not reached Chromium;
all merged requests settle with that dispatch. Press/release/cancel, editing,
viewport changes and modifier changes remain ordering boundaries. A dispatched
native event is never replaced, and navigation/stop retain their independent
control path. Idle paint throttling must not accumulate stale gesture input. Clients negotiate `inputAcknowledgements` at open; opted-in input receives its
result only after native dispatch, while older viewers retain quiet input. The
local ordered input queue keeps at most two input requests in flight. Unsent
adjacent positions replace each other; wheel deltas add only at the same hit
point, with the same modifiers and direction, without exceeding native bounds.
Press/release/cancel, changed contacts, wheel reversals, editing/copy/capture and
viewport operations remain ordered barriers. Pending grants use the same bounded
queue rather than a separate wheel replay array. Cancellation, document/control
replacement and detach retire unsent input; a late ACK cannot advance the new
queue generation. This bounds transport/native work rather than increasing the
server overload limit or replaying stale input. Line/page wheel units are
normalized at the local presentation; the native phased CDP wheel path remains
unchanged.
This is still final-text input, not the complete native IME bridge described
above. Multi-contact touch is an independent native input path.

Durable metadata uses the existing authenticated WebSocket admission. Browser
records and conversation aliases are scoped to the gateway owner; their IDs
never grant access. Concurrent stale metadata writes fail with STATE_CONFLICT
and require synchronization rather than silently replacing another client's
tabs. Ordinary client cleanup detaches; explicit tab close deletes its remote
recovery record. A worker restart recreates the tab from the saved URL and
configuration using its persistent partition. In-memory selection, scroll,
forms, navigation history and JavaScript heap are preserved only while that
WebContents remains alive.

### Local menus and remote selection boundary

Remote selection and editing remain Chromium-owned. Context menus belong to
the client presentation: an Electron client may use a native Menu, while a
Web client renders its own local menu. A video surface does not supply the
mobile OS text-selection menu. Menu availability comes from the remote native
context, and commands must validate their page, document and target generation
again when executed. Opening a local menu must not blur or reset the remote
editor. Clipboard results must be scoped to the requesting browser session,
then written to the client clipboard under its user-gesture contract; the
server's global OS clipboard is not a remote clipboard transport.

Each offscreen page initializes a local blank renderer and a private native
page-focus context before remote navigation. Ozone headless OS-window focus and
injected mouse clicks alone do not focus its renderer. Chromium's existing
focus emulation lets independent page viewers retain their own native focused
element; it does not refocus an old editor when Copy executes. Parking video
does not toggle page focus or dispatch an extra editor blur. Cross-site iframe
renderers have separate focus contexts. A private, recursive iframe-target
attachment initializes each one before resuming its script; initialization
failure or detach always resumes a waiting target and cannot leave it paused.

The remote worker now exposes a narrowly typed copy-back operation and native
context-menu notifications. A client right-click or keyboard-menu intent must
still own the current presentation when the notification arrives. The local
Electron Menu or Web Radix menu offers Copy and, for HTTP(S) links, Copy link
address. Ctrl/Cmd+C uses the same copy-back operation. Opening a local menu
preserves the remote focus and selection. Website-owned menus remain in the
remote page when its context-menu event prevents the native menu.

Copy requires the owned Electron fork's target-bound clipboard capability;
stock runtimes advertise it as unavailable. The renderer issues a single-use
native document/focus/selection token. Executing Copy validates that token,
dispatches Chromium's real editor command, and captures the final ClipboardHost
text/HTML writes on the same ordered Mojo pipe, including website copy handlers
and existing policy callbacks. ClipboardHost does not flush these writes to the
server OS clipboard. A moved target, navigation, unsupported format, nested copy
or missing data rejects the result. Rejection after dispatch does not roll back
website event-handler side effects. The initial result limit is 65,536 UTF-16
code units across text and HTML; images/custom formats, cut and native paste
transactions are outside this capability.

Page/session permission checks and current presentation/connection generations
fence the result again before a local user intent can write the client
clipboard. Async Clipboard API clients create promised text/HTML items during
the local gesture; plain-only results receive an equivalent inert HTML
alternative. LAN HTTP uses the browser clipboard command and reports refusal.
Retiring the view rejects pending data. A final check immediately before the
desktop port call or promised Blob fulfillment also fences retirement between
remote-result validation and the next Promise reaction. No protocol can revoke a clipboard
write already accepted by the local OS/browser. Client clipboard permission and
activation rules still apply.

The fork source, worker, client menu and artifact-selection paths are connected.
Source integration alone does not enable native copy: a complete owned binary
must pass the native clipboard probe and be selected during packaging. Native
runtime adoption and physical desktop/mobile validation must be recorded
separately. This does not complete native IME or multitouch, and a video surface
still cannot provide the mobile OS's native text-selection handles.

### Remote surface keyboard activation

The presentation canvas is not an editor. A real local input receives native
composition events and stages only the current transaction; it never mirrors
remote text. Native Chromium metadata identifies text, search, password, email,
URL, telephone, number, textarea and contenteditable fields, their inputmode,
enter-key hint and virtual-keyboard policy. Number staging uses text plus the
native inputmode so local number validation cannot rewrite the remote edit.
Sensitive fields (including Chromium's previously-password flags) use a local
password input. Staging clears on commit, cancellation and field changes.

Ordinary tab, canvas and menu focus use inputmode none and manual keyboard
policy. A single small touch may promote the already-focused receiver only
after a different native editor is confirmed, within the short-lived tap intent.
Movement, multiple contacts, capture loss and blur disarm this intent. It never
asynchronously focuses a local field or steals focus from the local address bar.
The existing Keyboard action synchronously focuses the receiver in a local
trusted gesture, using the remote keyboard traits. Explicit Keyboard can override
inputmode none; automatic activation respects it and manual native policy.
Updating inputmode on an already-focused receiver is a best-effort mobile
WebView path; physical WeChat/iOS/Android popup behavior needs device validation.

The worker emits an opaque editor observation id and bounded caret geometry,
never field contents, native target identity or write capabilities. Begin binds
the observed id to the exact native document/node and input type. Each operation
uses a single-use native document/focus/selection capability; changed focus,
type, document or native context cancels rather than retargets delayed input.
Preedit, commit and cancellation follow Chromium's editor and website handlers.
The client keeps the original editor id throughout a composition, coalesces
preedit and queues terminal edits in order. Local blur, park, navigation,
disconnect and disposal retire the transaction.

Physical keyboard keydown/keyup/character events remain available on non-editable
pages, including arrows, Tab, Escape and shortcuts. Enter forwards the native
Return character as well as key edges so native form submission and textarea
line breaks can run; a non-editable page keeps the manual local key receiver. Composition/Process/229
keystrokes are excluded to avoid inserting both a key character and IME commit.
Browser/OS-reserved shortcuts, layout-specific dead keys and Bluetooth keyboard
behavior need platform validation; remote handlers can reject edits. Rejection
after dispatch cannot undo website side effects. Stock runtimes without the
native bridge advertise it unavailable.

This text bridge does not implement remote surrounding-text reconversion,
editor mirroring, mobile selection handles, native date/color/file/select pickers,
password-manager/autofill/passkey origin delegation or arbitrary EditContext
editors. Those are separate capabilities, not implied by password text entry.

### Empty remote tab recovery

The worker bootstrap `about:blank` is represented as a null recovery URL, including
when reading older checkpoints. Reopening an empty tab never sends that sentinel
through the external HTTP(S) navigation command. A restored empty document does
not suppress the viewer's pending initial target URL; a resumed or restored
nonempty remote page remains authoritative and is not navigated again. Explicit
blank navigation still uses null, and external URL restrictions remain intact.


### Navigation acceptance and loading

Remote `navigate` acknowledges Chromium accepting a validated HTTP(S) target;
it does not wait for all resources or the native loadURL Promise. Native
navigation/loading/failure events remain authoritative. A stalled subresource
must not prevent video attachment, stop, replacement navigation or reconnect.
During process recovery, the saved remote URL remains authoritative before the
first document commits; a viewer's stale initial target cannot replace it.
The WebSocket handshake deadline ends at transport open. The separate open RPC
allows bounded worker startup and creation; timeout messages identify the
operation without exposing the target URL or page content.

The private, typed automation bridge executes against the captured native main
frame, without WebContents' global did-stop-loading gate. Native document
generation checks still reject stale results. This permits browser inspection
and interaction in a committed document while a subresource is stalled; no
client JavaScript evaluator or CDP endpoint is exposed.

Temporary network, deployment and worker transport outages keep retrying with
exponential backoff capped at five seconds; they do not exhaust a five-attempt
budget. Worker transport/startup failures and RPC deadlines carry retryable
errors. Generic clean WebSocket closure is not a logical Tab retirement. The
explicit `1000 / Browser tab closed` reason, authorization `1008`, legacy transfer
`4009` and permanent open/admission errors stop retries. The permanent error
remains visible rather than being overwritten by a generic close message.
Late retry timers belong to their connection generation. Recovery opens only the
same lease, never navigates, replays input or acquires control; an authoritative
non-loading snapshot emits loaded; the shared page runtime clears its previous
error on that successful acknowledgement, including blank tabs whose navigation
does not create a history entry. A later failure remains visible.

Native per-page renderer termination is a different boundary from a viewer
transport outage. The worker destroys that dead WebContents and retires its
ordered command epoch before emitting `renderer-gone`. The gateway invalidates
that page's native requests and input grant, closes its viewers with retryable
`1011`, and retains the logical lease, saved URL and device/zoom configuration.
Reattachment recreates only that renderer and restores its saved navigation;
other live Tabs and the Electron worker stay intact. Lost renderer memory and
unsaved edits cannot be restored, and control/input are never replayed. Queued
commands from the dead epoch cannot reach the replacement, including old
control grants. Explicit logical close still takes precedence over recovery.

A gateway request backlog uses temporary `1013`, not policy `1008`. Its cap
continues to bound outstanding work; malformed binary requests and expired
admission still stop recovery. Terminal banners distinguish rejected requests,
expired authorization and explicit close instead of hiding them behind a generic
disconnection message. Diagnostics contain owned reason enums and exit codes,
never page content, URLs or raw native stderr.

A failed open or terminally disconnected transport does not make the tab's
ready promise reusable. Explicit reload or replacement navigation establishes
a new connection generation using the same persisted storage lease and current
server admission. It retires the old transport, pending RPCs, input and media
before connecting; late old results/closures cannot clear the new connection.
Healthy reload keeps its existing transport. Policy closure does not trigger
automatic retries; an explicit retry still requires server authorization.
Explicit navigation intent has its own sequence, so synchronizing the remote
URL during reconnect cannot drop a newer user navigation or revive an older one.
When reload recreates a physical page, its recovery navigation is already the
reload operation. Do not immediately reload that new WebContents: before the
first commit this would reload about:blank and cancel the intended navigation.
Reloading a resumed live page still issues the native reload command.


### Atomic native offscreen resize

CPU offscreen rendering publishes viewport size and the matching LocalSurfaceId
as one native visual-properties update. Screen-info notification during resize
must not send the new dimensions with the previous surface ID: Chromium rejects
that combination and terminates the renderer. The owned Electron view defers
intermediate synchronization until root/delegated surfaces are ready, then uses
the normal final synchronization and acknowledgement path. The same WebContents,
DOM, focus, input selection and profile survive keyboard height changes, panel
resizing and rotation; no page recreation or fixed viewport is used as a remedy.
The native resize probe covers active CPU painting and preserved editor state;
remote H264 and physical mobile input require their separate acceptance evidence.

Remote browser timeout/renderer-exit diagnostics retain only a fixed event, a
whitelisted command name and pending-request count, capped at twenty per service.
They contain no URL, page/actor identity, input, arbitrary exception or native stderr.
They identify a later timeout without making absence of events proof of health.

### Accepted remote tab closure

Explicit close/discard belongs to the server tab owner. Native destruction,
quota release and durable catalog deletion complete independently of the
viewer's socket lifetime; a disconnected reply cannot skip that work. Concurrent
retirement shares one operation and blocks reattachment. Discard during native
creation waits for creation before retiring the resulting page, rather than
acknowledging while an orphan WebContents can still appear. Native close is
idempotent so an uncertain acknowledgement can safely be retried. Cookie
partitions retain the existing policy. Ordinary detach/park still preserves the
live document. This fix does not introduce LRU or change tab limits.

### Browser layout and visibility aperture (2026-10-22)

The presentation slot supplies the live content layout viewport. The intersection
with the Shell aperture and window supplies only stageBounds for painting and
hit-test clipping. Responsive and fixed-device layout both use the slot before
clipping. Remote H.264, local iframe and Electron guest adapters project that
clip independently of backing dimensions. Hiding/revealing a panel therefore
keeps the page at its content width; it does not send animated near-zero widths
to the renderer or rebuild the encoder for visibility alone. Actual window or
divider resize still changes the live slot and viewport during held drags.

The reported keyboard recognition without automatic popup remains a separate
activation limit: ime-state arrives asynchronously, and updateKeyboard only
changes inputmode on an already focused receiver. It does not create a new
trusted focus gesture. Manual Keyboard performs synchronous blur/policy/focus
in the local event; first-touch automatic popup on physical WeChat is unverified
and was reported unsuccessful. Do not equate editor recognition, focus, or an
inputmode change with visible OS keyboard approval.

### Shell mode transitions and browser layout

The Shell tool surface uses the destination split/full-width layout, while its outer aside animates the visibility aperture. Closing retains the last content mode until a new visible intent selects a destination. Full-width interpolation is never sent as an intermediate browser viewport: H.264 frames can arrive after the container expands and otherwise produce centered gutters and repeated reflow. Ordinary split-handle and window resizing still update live content width; there is no viewport freeze or delayed reveal timer. Surface border treatment follows the retained content mode as well, so hiding cannot introduce a one-pixel viewport change.

The Shell layout signal includes mobile foreground translation, not just pane dimensions. Portaled surfaces measure in Motion postRender after ancestor transforms commit; ResizeObserver alone does not observe positional changes. Cancel scheduled reads with the presentation lifecycle.

### Durable close intent and acknowledgement

A remote surface sends explicit closure over an independent discard connection,
validates its matching successful result and retries lost/error replies while the
application is alive. Disposing a presentation still detaches only. Removing an
existing lease from the authenticated, revisioned storage mapping is a second
explicit close signal; server metadata acceptance persists closing work before
acknowledging, then retires native resources independently. Failed destruction
is retried and pending work resumes after server restart. A persisted owner/lease
fence also prevents an open waiting on process startup from creating a page after
its discard already succeeded. Cookie partitions and ordinary parked tabs stay
under the existing policy. This does not infer closure from absence of a viewer,
from a missing/malformed historical mapping or from a resource limit. Old orphan
records without a known close intent are not swept. A client killed before any
close signal reaches the server still has no durable offline close guarantee.

### Remote frame presentation during viewport resize

The layout owner fits and centers fixed-device previews in visualBounds. The
remote adapter then projects each received frame at that rectangle's width,
anchored at the top left, and clips overflow at the live slot. It must not
contain-fit the old frame again against a newly shortened slot: during software
keyboard animation the native viewport and H.264 epoch arrive later, and this
second fit would temporarily shrink the entire page and add horizontal gutters.
Canvas uses its received intrinsic aspect ratio; MSE video uses the same epoch's
explicit aspect ratio, including before metadata arrives. Both remain undistorted.
A growing slot can expose unpainted space until its new frame arrives; it never
stretches old pixels vertically or predicts remote layout. Real viewport changes
continue through the existing bounded resize queue without a reveal delay.

Mouse/touch positions, contact radii, local menus and IME caret positioning use
the same width-derived frame projection. The invisible keyboard receiver is
clamped to the visible container. Native page zoom remains remote authority;
this is frame presentation, not an additional page-scale or DPR transformation.
Fixed-device preview padding and outer centering remain layout-owned.

### First-frame handoff within a remote page

A viewport notification updates the native input/decoder dimensions, not the
currently displayed bitmap. Canvas dimensions change only in the same render
task that draws the first complete replacement frame. Reset cancels queued
frames and retires their decoder identity; old callbacks cannot repaint a newer
epoch. Real native resizing continues while the last readable picture is held.

The MSE path copies its currently presented video into the existing canvas once
before disposing the old media source. An incoming video stays transparent above
the canvas until requestVideoFrameCallback confirms its first presented frame;
then the current video identity is checked, the canvas cover is updated and the
video is revealed. Older browsers use readable data, completed seek and one RAF
as the fallback fence. Cancelling a replacement removes callbacks/listeners.
An unready video never replaces the existing cover during a second reset.
Temporary snapshot storage is released immediately; a failed video read leaves
the earlier readable cover intact. There is no retained second decoder, permanent
video-to-canvas copy loop, frame-rate increase or new idle polling. Recovery
uses the same handoff; closing a page releases media and callback ownership.

This avoids the decoder-reset white interval, not legitimate white webpage
content or the new area exposed when a viewport grows. The held picture can be
stale until the remote page paints again; no local layout prediction is applied.

### Browser process transport failure isolation

The Gateway owns the worker process and its pipe/IPC generation. A worker exit
or stdin/stdout/stderr error retires that generation once, rejects its pending
requests and disconnects its page sockets so ordinary recovery can recreate the
worker. The persisted tab catalog is retained. Bootstrap pipe failure also
rejects startup immediately; a late failure from an old startup cannot clear a
new startup. Late process messages or errors cannot mutate a replacement.

Node Writable write callbacks do not consume a separate stream error event.
Listeners therefore remain for the transport lifetime, including after ready
and shutdown. This contains browser failures within their resource owner; it
does not establish the cause of a native Electron abort or promise DOM recovery
after that abort. Diagnostics expose only owned event enums and counters, never
visited URLs, page text or arbitrary Chromium stderr.

### Native touch identities and private crash diagnostics

Wire touch IDs are arbitrary validated identities, not Chromium pointer slots. The widget CDP adapter allocates at most ten stable slots, commits allocation/release only after native ACK, preserves held fingers across partial release/reorder, and clears slots after cancellation even when cancellation fails. Browser-provided pointer IDs never reach VelocityTracker directly.

The Gateway consumes the browser stderr pipe with a bounded private in-memory parser. It retains only the most recent fatal code location, up to 24 argument-free stack symbols and counters, associated with the retired process and its exit code/signal. `lastBrowserFailure` is process-owner memory, not a client endpoint: no raw stderr/messages, console forwarding, file/checkpoint writes or page socket disclosure. Replacement workers cannot be retired by old pipe events. This evidence does not establish a cause for an unobserved native abort.

### Offscreen wheel injection

Remote wheel input uses the worker's private Chromium `Input.dispatchMouseEvent`
wheel injector. The pinned Electron OSR `sendInputEvent(mouseWheel)` path mutates
a phase-bearing copy but forwards the original event, violating Chromium's
wheel queue invariant and aborting the whole browser process. The CDP injector
provides native begin/end phases and frame hit testing. Viewer widget positions
are converted using current pinch scale and browser zoom; wheel deltas retain
their physical magnitude and convert from Electron to web direction. Native
modifier semantics, sandboxing, page leases and memory-only stderr remain intact.
No public debugger endpoint or arbitrary input command surface is added.

Media epochs are opaque, non-reused identities across renderer recreation, resize and parking. Encoder callbacks belong to their exact encoder instance; a late output/error cannot emit into, clear or release a replacement encoder for the same logical Tab. Worker accepts packets and failures only for the current media epoch.

### Browser toolbar input action artwork (2026-10-22)

The input-control and keyboard actions use the shared hand-drawn SVG family in
`design-system-web/action-icons` and the existing toolbar icon slots. Control uses
a pointer to take control and a crossed pointer to release it; keyboard uses the
shared keyboard artwork. Localized accessible names and hint titles remain on
the buttons. Unavailable controls stay absent, keyboard readiness still determines
disabled state, and actions still call the existing surface owner without changing
lease, focus or keyboard policy.

### Remote input document and interaction fences

Raw input and text operations now carry the remote document identity, distinct
from the controller token and media epoch. The worker captures that identity at
admission for older peers, checks it again when queued commands dispatch, and
rechecks after viewport/reset/editing waits. Touch and wheel injection also check
after their asynchronous native metrics read. New viewers negotiate document
input and preserve the identity from event production through local coalescing,
transport and native execution; missing or obsolete identities are rejected.
Main-document replacement emits an input reset with its new identity, retires
local queues/composition, and releases pressed native state before new input.
Subresource loading alone cannot reset a document-aware viewer's editing state.
Already dispatched native events cannot be retracted; rejected edits are never
retried against another document.

Human control requests capture the viewer's visibility generation. Hiding a
viewer invalidates pending human requests even if it becomes visible before the
native grant completes. The service rechecks that generation before and after
the native acknowledgement; canceled grants clear their native token. This is
independent of Agent control, which can operate without a visible viewer.

IME navigation retirement follows the owned frame: main-document replacement
or replacement of the frame holding the editor retires it; unrelated iframe
and same-document navigation do not. Native target/document/focus checks remain
authoritative, including destroyed descendant frames.

The local input adapter interprets deletion and line-break intent by inputType
on both cancelable beforeinput and noncancelable input paths. It suppresses a
matching input after an already handled beforeinput, and commits fallback text
only when it remains in the staging receiver, preventing duplicate composition
commits. It does not mirror remote text or implement local autocorrection of
remote selections. A failed input acknowledgement retires pending interaction
work, cancels native pressed state and reports one current failure; obsolete
connection/control/document errors stay retired, and no input is replayed.
Transient owner attachment failures, including a still-attached prior Gateway,
are retryable browser-unavailable errors. Protocol incompatibility remains
terminal without replacing live tabs. Rejected private sockets drain their short
status reply and then close, without retaining unread attachment data.

### Native state acknowledgements and client backgrounding

Visibility and viewport setters distinguish desired, in-flight and acknowledged state.
A failed or unknown result never advances acknowledged state. Setters serialize and
coalesce to the latest target, retry transient failures with bounded backoff, and
retire results with their connection/native generation. This mechanism never replays
clicks, keys or composition. Exhausted recovery remains actionable and can resume on
a new connection, control grant or presentation intent.

Remote viewing requires both Shell presentation and a foreground client document.
Hiding retires local gestures, composition, menus and pending human grants, releases
human control and stops viewing; it neither destroys the logical Tab nor revokes an
Agent's independent background use. Foregrounding resumes observation without
claiming control. Open/reconnect consumes current effective visibility.

Resize preserves the previous complete bitmap. Pointer injection waits for the
replacement geometry and its first complete frame; focused keyboard/IME editing
keeps its native target contract during the geometry handoff.

Clipboard capability invalidation follows its owning frame/document. Unrelated
subframe or same-document navigation does not globally cancel a menu's copy. Top-level
document replacement, owning-frame replacement, renderer loss and native token
rejection continue to fail closed, including while capture or Copy is in flight.

A live managed owner keeps its immutable runtime until its Tabs are explicitly
closed. On attachment, differing public scripts/assets can replace an empty owner
under its exclusive transport; active inventory always preserves the process. The
last explicit close releases a stale idle transport so the next open can upgrade.
An unknown script identity preserves the owner. This is not native binary hot swap:
existing live Tabs adopt native helper fixes after draining, not through DOM reload.

## Conversation list resource management
Conversation rows expose the logical tabs held by their canonical Host+Thread binding, including tabs retained without a visible presentation. The coordinator owns a stable, per-conversation subscribable metadata projection (tab identity, title and URL); reads do not create a binding, open a panel, prepare a surface or attach to a native page. Title/navigation updates reuse unchanged projections and notify only the affected conversation. Binding promotion also refreshes the directory.

The row resource menu lists tab titles, opens an existing tab in its original scope, and offers explicit close-all for that conversation. It shares the Sidebar's exclusive menu owner. Leaving the conversation or dismissing this menu does not destroy tabs or take input control. Counts describe retained logical tabs, not measured CPU or memory, native liveness or viewer/controller ownership.
