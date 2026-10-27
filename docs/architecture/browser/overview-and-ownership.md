# Browser: Overview and ownership

[Architecture index](../../browser-workbench-architecture.md) · [Documentation index](../../README.md)


> 状态：Web iframe、Electron webview 与 Linux Server H.264 Surface；各平台验收分别记录，Playwright/Expo Adapter Proposed
> 目标平台：Vite Web、Electron Desktop、Expo iOS/iPadOS、Expo Web\
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
