# OpenCraft In-App Browser 与 Browser Use 行为同构实施参考书

> 状态：DSH/Web v1 与 Preview Bridge v1 已实现；Electron、Playwright、Expo Adapter 为后续契约  
> 面向读者：后续负责实现 OpenCraft 浏览器能力的工程会话  
> 参考基线：Codex Desktop 恢复树 `source-tree-build-r2030-eager-immediate-compact`  
> 目标平台：Vite Web、Electron Desktop、Expo iOS/iPadOS、Expo Web  
> 相关设计：[`browser-workbench-architecture.md`](./browser-workbench-architecture.md)、
> [`platform-architecture.md`](./platform-architecture.md)、
> [`appserver-foundation.md`](./appserver-foundation.md)

## 0. 一句话结论

是的，OpenCraft 应当实现一套与 Codex **产品行为同构**的 In-App Browser 与 Browser Use：

- 用户看见的是 OpenCraft 品牌；
- Agent 使用的是 OpenCraft 工具名；
- AppServer 线协议继续遵循 Codex 最新动态工具协议；
- 生命周期、恢复、上下文注入、页面读取、浏览器控制和 ChatUI 投影遵循 Codex 的思想与不变量；
- 代码、类型和包边界由 OpenCraft 独立实现，不复制 Codex 的 generated runtime，也不依赖其私有模块名。

这里的“100%”是**可测试的行为、协议和安全语义相同**，不是逐字符复制私有源码、类名或
内部资源。不同平台的物理控件能力不同，但共享产品语义不得分叉。

### 0.1 当前已落地基线（2026-09-01）

当前 DSH/Web v1 已经不是设计占位：

- OpenCraft 初始化通过 `capabilities.extensions["vela/browser-use"]` 宣告能力；
- HyperNode 只向拥有当前 DSH Turn 的准确 OpenCraft connection 投影 Skill 和三个工具；
- DSH worker 将 Skill 物化到会话目录，并在能力撤销后清理陈旧文件；
- 调用使用标准 `item/tool/call`，结果异步回注同一个模型工具调用；取消、超时、断连均显式失败；
- `open_in_vela` 能创建或聚焦当前 `(hostId, threadId)` 的右侧浏览器 Tab；
- `get_tab_context` 通过 `BrowserAutomation` 读取受控页面正文、选区和非敏感表单文本，并将页面标记为不可信；
- `browser_use` v1 支持 `list_tabs/navigate/back/forward/reload/stop/inspect/click/fill/press/scroll/wait`；
- 元素 ref 绑定文档 revision；导航或 DOM 变化后旧 ref 失效；密码、token、密钥、OTP、卡号控件拒绝读取或填写；
- `@opencraft/browser-preview-bridge` 已实现精确 origin、source、nonce、generation 握手，以及 request ID、超时和取消；
- 同源开发页由 Web Adapter 自动安装 child runtime；跨源受控页由 service gateway 注入同一 runtime；
- Ambient context 在不可变 SubmitIntent 边界注入，仅携带 Tab 元数据，不污染 Draft 或 Replica。

v1 有意不声明尚未实现的 `bottom`、`screenshot`、`set_viewport`，也不暴露没有权威语义的
Controller Lease。纯 Web 任意跨域 iframe 仍只有呈现能力；只有安装 Preview Bridge 的受控
预览才获得读取和语义交互能力，未握手页面必须明确降级，不能返回伪成功。下文保留完整目标
架构，其中超出这份基线的内容均视为后续阶段契约。

## 1. 本书解决什么，不解决什么

本书冻结以下能力的实施契约：

1. 用户在 OpenCraft 内打开、切换、关闭和恢复多个浏览器 Tab；
2. Agent 通过 `open_in_vela` 请求 UI 打开页面；
3. OpenCraft 向 Agent 注入当前浏览器的轻量环境上下文；
4. Agent 通过 `get_tab_context` 按需读取页面正文、选区和表单可见文本；
5. Agent 通过 `browser_use` 导航、观察和操作受支持页面；
6. Browser Use 调用以标准 `item/tool/call` 往返 AppServer、HyperNode 与当前 OpenCraft 客户端；
7. 工具调用在 ChatUI 中按 Codex 的 Browser Activity 语义呈现；
8. Web、Electron 和 Expo 共享同一套领域模型、命令、恢复与错误语义。

本书不把以下内容伪装成已解决：

- 任意跨域 iframe 在纯 Web 中的 DOM 控制；
- 绕过站点 CSP、X-Frame-Options、浏览器扩展权限或企业策略；
- 在 Expo Native 中直接复用 Electron `WebContents`；
- 用 `open_in_vela` 一个工具代替页面读取和控制工具；
- 把浏览器 UI 状态塞进 AppServer Replica。

## 2. 证据等级

实施时必须区分三类证据，不允许把推测写成 Codex 事实。

### 2.1 官方公开事实

OpenAI 公开材料确认 Codex 能构建并在 live browser 中测试应用，但没有公开 Desktop 内部的
Browser Use 传输协议和生命周期实现。公开入口见
[OpenAI Academy: Codex use cases](https://learn.chatgpt.com/use-cases)。

### 2.2 当前恢复源码事实

本书使用的最新本地参考树是：

```text
reference://codex/.runtime/source-tree-build-r2030-eager-immediate-compact
```

关键证据文件：

```text
browser/browser-sidebar-webview-manager-05645.js
browser/get-or-create-browser-sidebar-webview-root-05632.js
browser/compute-browser-panel-initial-state-09586.js
browser/setup-browser-use-session-tracking-04594.js
browser/dispatch-open-in-browser-message-03050.js
browser/is-valid-browser-context-block-02580.js
browser/check-in-app-browser-open-02581.js
browser/pull-request-merge-conflict-section-header-02543.js
composer/build-context-prompt-02520.js
shared/get-tab-context-tool-definition-03750.js
shared/get-tab-context-with-usage-03754.js
shared/get-chrome-tab-context-03755.js
shared/build-response-map-03779.js
shared/initialize-tool-surface-schemas-04313.js
shared/resolve-computer-use-app-info-04295.js
```

这些文件证明产品行为和状态划分；恢复后的符号名只是研究辅助，不是 OpenCraft 的公共 ABI。

### 2.3 OpenCraft 自己的设计决定

本文中的 `BrowserEngine`、稳定元素引用、OpenCraft 工具 namespace 和跨平台 Adapter 命名，是
OpenCraft 为复现上述行为而制定的独立契约。若某处不是 Codex 的可验证原名，本文会明确写成
“OpenCraft 契约”，不得对外宣称为 Codex 私有协议字段。

## 3. 首先拆开三个经常被混淆的能力

### 3.1 `open_in_vela`：只负责呈现

它表达“请在 OpenCraft 的 UI 中打开或聚焦某个页面”。它不读取 DOM，不点击，不执行脚本。

```text
Agent ── open_in_vela ──> OpenCraft Presentation Intent
                              └─ right / bottom / 当前 Thread
```

这与当前 Codex 的 `open_in_codex` 思路一致：打开 UI 和检查/操作资源是两个能力面。

### 3.2 Ambient browser context：只提供轻量线索

OpenCraft 在下一次用户消息的上下文中告诉模型：

- 当前是否打开了 in-app browser；
- 打开多少个 Tab；
- 当前 URL 或 URL 列表。

它不把正文自动塞入 prompt，也不暗示用户显式选择了这个页面。

### 3.3 Browser tools：按需读取和控制

- `get_tab_context`：低成本、只读、可审计；
- `browser_use`：高能力、可改变页面状态、必须受 Capability 和 Policy 约束。

因此，`open_in_vela` 单独存在并不能完成 Agent 建站预览；完整闭环至少需要：

```text
open_in_vela + ambient context + get_tab_context + browser_use
```

## 4. 产品对象模型

### 4.1 不可混淆的五个对象

| 对象 | 含义 | 生命周期所有者 |
| --- | --- | --- |
| `ThreadKey` | `(hostId, threadId)`，业务会话身份 | AppServer/Host registry |
| `BrowserSession` | 用户认为同一个浏览器 Tab 的逻辑资源 | Browser Runtime |
| `ConversationBrowserLink` | Session 与 Thread 的关联 | Browser Runtime |
| `BrowserBacking` | iframe、WebContents、WKWebView、远端浏览器页 | Platform Engine |
| `BrowserPresentation` | right/bottom/split/fullscreen 中的一次可见投影 | Presentation Coordinator |

严禁以下等同关系：

```text
BrowserSession !== iframe element
BrowserSession !== React component
BrowserSession !== right panel tab
BrowserSession !== Browser Use activity
ThreadId alone !== ThreadKey
```

### 4.2 推荐核心类型

```ts
export type HostId = string & { readonly __brand: "HostId" };
export type ThreadId = string & { readonly __brand: "ThreadId" };
export type BrowserSessionId = string & { readonly __brand: "BrowserSessionId" };
export type BrowserBackingId = string & { readonly __brand: "BrowserBackingId" };

export interface ThreadKey {
  readonly hostId: HostId;
  readonly threadId: ThreadId;
}

export interface ConversationBrowserLink {
  readonly thread: ThreadKey;
  readonly sessionId: BrowserSessionId;
  readonly relation: "opened-by-user" | "opened-by-agent" | "observed-by-agent";
}

export interface BrowserSessionSnapshot {
  readonly id: BrowserSessionId;
  readonly revision: number;
  readonly title: string;
  readonly url: string | null;
  readonly navigation: {
    readonly canGoBack: boolean;
    readonly canGoForward: boolean;
    readonly isLoading: boolean;
  };
  readonly capability: BrowserCapabilitySnapshot;
  readonly error: BrowserDomainError | null;
}
```

现有 `/vela/packages/browser-core/src/model.ts` 只有 `threadId`，实施会话应将其升级为
`ThreadKey`，否则不同 Host 上相同 thread ID 会发生串话。

## 5. 状态应该放在哪里

| 状态 | 位置 | 是否进入 Replica | 是否持久化 |
| --- | --- | --- | --- |
| Thread/Turn/Item 服务端事实 | AppServer Replica | 是 | 由服务端决定 |
| Browser tool call 与结果摘要 | Turn Item / tool surface | 是 | 是 |
| Browser Session ID、URL、标题、历史索引 | Browser Runtime checkpoint | 否 | 小型本地持久化 |
| right/bottom、面板宽度、当前 UI Tab | Renderer layout store | 否 | 可选本地持久化 |
| WebContents/WKWebView/iframe 实例 | Platform Engine | 否 | 否 |
| mount generation、pending measure、cursor | Renderer ephemeral state | 否 | 否 |
| 页面正文、DOM snapshot、截图缓存 | Browser Engine 临时资产 | 否 | 有界、可回收 |
| server request ID 与 owner connection | HyperNode live routing | 否 | 否 |

原则：Replica 记录 Agent 已经做过的事实；浏览器 Runtime 记录如何继续呈现浏览器；物理
控件只存在于当前平台进程。

## 6. Codex 行为中必须保留的不变量

### 6.1 身份与生命周期

1. React unmount 只释放 View claim，不关闭逻辑 Session。
2. 关闭 right panel 只隐藏 Presentation，不等于关闭 Browser Tab。
3. `detach`、`stage`、`reveal`、`finishReveal`、`close` 是不同事件。
4. Browser Use “不活跃”只隐藏 cursor/交互态，不自动销毁 Tab。
5. Browser Use 释放占用后，用户仍打开的 Tab 必须继续存在。
6. 用户真正关闭 Tab 时，才清理历史、viewport、capture、cursor 和 persistence 状态。
7. UI 可见 Tab 与 Browser Use 持有 Tab 是两组集合；两者的并集决定 Backing 是否驻留。
8. 同一 Session 可以先由 Agent 打开，后由用户接管，身份不得改变。
9. 每个物理 Backing 只有一个生命周期 owner；观察者只拿可释放句柄。
10. 所有异步回调携带 `generation`；旧 generation 不得写入新 Backing。

### 6.2 可见性与物理 Surface

11. Surface Root 独立于普通 React panel tree，避免 transform、overflow 和 z-index 污染。
12. Root 固定定位、默认 `pointer-events: none`；只有活动 Surface 接收指针。
13. 隐藏但仍被 Browser Use 使用的 Backing 可以停泊在不可见 capture viewport，而非销毁。
14. `blockInteraction` 和 `restoreInteraction` 是明确事务，不能靠透明遮罩碰运气。
15. 一个 Renderer slot 同时只能持有一个活动 Presentation Lease。
16. 切 Tab 时先 stage 新 Surface，再原子 reveal，不能先卸载旧 Surface 后白屏等待。

### 6.3 路由、Host 与恢复

17. 浏览器关联键必须是 `(hostId, threadId)`，不能只有 `threadId`。
18. Agent 发起的浏览器调用必须回到拥有当前执行的 OpenCraft connection。
19. HyperNode 找不到准确 owner connection 时必须显式失败，不得退回任意第一个连接。
20. Session checkpoint 恢复和 Backing 恢复是两阶段；恢复 Session 不保证物理页已就绪。
21. `ephemeral`、`restore-expected`、`persistent` 是不同存储策略。
22. 切换 Thread 不自动销毁其他 Thread 的 Browser Session。

### 6.4 上下文与安全

23. Ambient context 只列 Tab 数量与 URL，不偷偷注入网页正文。
24. 网页内容永远标记为不可信数据，不能当作系统指令。
25. 密码、token 型输入必须脱敏；不得读取 password value。
26. 被 Policy 阻止的动作必须直接报告，不允许换 raw CDP、脚本注入或其他 surface 绕过。
27. 元素引用在导航或文档 revision 变化后失效，禁止对旧 ref 盲点。
28. 大文本、二进制文档和截图使用临时资产，不把无限内容塞进 JSON-RPC。

## 7. 四层几何模型

当前 UI 反复出现“拖窄后网页不 reflow”“按钮跟着边栏漂移”“内容泄漏”的根因，是把四个
不同矩形压成一个 `width/height`。

```text
┌──────────────── page/layout viewport ────────────────┐
│  ┌──────── AppShell aperture / clip ──────────────┐  │
│  │  ┌──────── presentation slot bounds ────────┐  │  │
│  │  │       visible browser surface            │  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘

capture surface size = Browser Use 截图/坐标空间，可与可见 slot 不同
```

必须分别建模：

```ts
export interface BrowserGeometrySnapshot {
  readonly slotRect: DOMRectReadOnly;
  readonly apertureRect: DOMRectReadOnly;
  readonly layoutViewport: { readonly width: number; readonly height: number };
  readonly captureViewport: { readonly width: number; readonly height: number };
  readonly scale: number;
  readonly generation: number;
}
```

一次 resize 是测量事务：

1. 在 animation frame 读取所有 rect；
2. 计算 slot 与 aperture 的交集；
3. 提交同一个 generation 的完整快照；
4. Engine 先更新 layout viewport，再更新 Surface bounds；
5. 下一帧验证，不允许多个 React effect 分别改 left、width、iframe width。

纯 Web 跨域 iframe 只能改变 iframe viewport，不能强迫一个写死桌面宽度的远端网页响应式。
受控建站预览必须注入 Preview Bridge；Electron 可通过 WebContents/CDP 设置 device metrics；
Expo 使用 WKWebView bridge。

## 8. AppServer 线协议：不要发明第二套 RPC

### 8.1 动态工具注册

OpenCraft 在新建 Thread 时通过现有 Codex 协议字段注册浏览器工具：

```ts
ThreadStartParams.dynamicTools: DynamicToolSpec[]
```

建议注册两个 namespace：

```text
vela_app
  └─ open_in_vela

vela_browser
  ├─ get_tab_context
  └─ browser_use
```

AppServer 调用这些工具时，使用标准 server request：

```text
item/tool/call
```

请求参数已经由 OpenCraft 生成协议定义：

```ts
type DynamicToolCallParams = {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: JsonValue;
};
```

OpenCraft 返回：

```ts
type DynamicToolCallResponse = {
  contentItems: DynamicToolCallOutputContentItem[];
  success: boolean;
};
```

现有 `/vela/packages/appserver-client/src/client.ts` 已提供 `handleServerRequest()` 和
interceptor 链。浏览器 handler 只捕获自己的 namespace/tool；其他动态工具必须 `next()`，
不能截断 Composer option picker 等已有处理器。

### 8.2 为什么不增加 `opencraft/browser/open`

自定义 RPC 会造成：

- Codex AppServer 不认识；
- ReplayTransport 要维护第二套事件；
- HyperNode 要增加不必要的语义代理；
- 工具调用无法自然进入 Turn Item 和 ChatUI tool surface。

标准动态工具已经完整解决“服务端 Agent 请求当前客户端执行 UI 能力”的问题。

### 8.3 Capability 协商

初始化时使用已有扩展槽，不修改生成协议的顶层字段：

```json
{
  "capabilities": {
    "extensions": {
      "vela/browser-use": {
        "version": 1,
        "backends": ["preview-bridge", "iframe-presentation"],
        "actions": ["open", "read-context", "navigate", "inspect", "click", "fill", "press", "scroll", "screenshot"],
        "supportsCaptureViewport": true
      }
    }
  }
}
```

Electron 和 Expo 按真实能力上报 backend/action；禁止 Web iframe 冒充支持 DOM 控制。

### 8.4 Resume 的边界

`dynamicTools` 当前位于 `thread/start`，不在 `thread/resume`。因此：

1. 所有 OpenCraft 新 Thread 必须在 start 时附带浏览器工具；
2. 真实 9988/HyperNode 要增加回归测试，确认 Thread 是否持久化动态工具定义；
3. 若旧 Thread 没有工具，不在客户端伪造；应创建可路由的新 Thread，或以后以明确协议扩展升级；
4. 断线重连只恢复 handler 和 connection，不重复创造 Browser Session。

## 9. 三个公共工具契约

### 9.1 `vela_app.open_in_vela`

输入应与 Codex 的 browser presentation intent 保持同形：

```ts
type OpenInOpenCraftInput = {
  placement?: "right" | "bottom";
  target: {
    type: "browser";
    url?: string;
    tabId?: BrowserSessionId;
  };
  threadId?: string;
};
```

约束：

- `url` 与 `tabId` 至少一个；
- 默认当前调用 Thread；跨 Thread 必须显式 `threadId`，并在同一 Host 中解析；
- URL 经过统一 policy normalization；
- 已存在 `tabId` 时聚焦，不重复创建；
- 成功只表示 UI intent 已接受，不表示页面已加载完成。

返回示例：

```json
{
  "opened": true,
  "tabId": "browser_01...",
  "placement": "right",
  "url": "http://127.0.0.1:5173/"
}
```

### 9.2 `vela_browser.get_tab_context`

```ts
type GetTabContextInput = {
  tabId: BrowserSessionId;
  includeSelection?: boolean;
  maxInlineChars?: number;
};
```

读取优先级：

1. 用户选区；
2. `document.body.innerText`；
3. 可见且非敏感的 text-like form value；
4. 标题、URL 和内容类型；
5. 特殊文档导出或媒体 transcript；
6. 超限内容写入 Thread 临时目录并返回 asset reference。

输出文本采用稳定标签，避免模型把页面正文误解为宿主指令：

```xml
<browser-tab-context trust="untrusted-page-content">
  <url>https://example.test/</url>
  <title>Example</title>
  <selection>...</selection>
  <content>...</content>
</browser-tab-context>
```

密码控件输出：

```xml
<browser__redacted_form_control />
```

### 9.3 `vela_browser.browser_use`

这是 OpenCraft 的公共 action contract；它复现 Codex Browser Use 的产品语义，不声称 action
名称来自 Codex 私有实现。

```ts
type BrowserUseInput =
  | { action: "list_tabs" }
  | { action: "claim"; tabId: BrowserSessionId }
  | { action: "release"; tabId: BrowserSessionId }
  | { action: "navigate"; tabId: BrowserSessionId; url: string }
  | { action: "back" | "forward" | "reload" | "stop"; tabId: BrowserSessionId }
  | { action: "inspect"; tabId: BrowserSessionId; mode?: "accessibility" | "interactive" }
  | { action: "click"; tabId: BrowserSessionId; ref: string; expectedRevision: number }
  | { action: "fill"; tabId: BrowserSessionId; ref: string; value: string; expectedRevision: number }
  | { action: "press"; tabId: BrowserSessionId; key: string }
  | { action: "scroll"; tabId: BrowserSessionId; x?: number; y?: number; ref?: string }
  | { action: "wait"; tabId: BrowserSessionId; condition: BrowserWaitCondition; timeoutMs?: number }
  | { action: "screenshot"; tabId: BrowserSessionId; fullPage?: boolean }
  | { action: "set_viewport"; tabId: BrowserSessionId; width: number; height: number; scale?: number };
```

`inspect` 返回带 revision 的稳定元素引用；导航、DOM replacement 或 revision 更新后，旧 ref
失效并返回 `STALE_ELEMENT_REFERENCE`。v1 不提供任意 JavaScript eval；后续若开放必须是单独
高权限能力，不能暗藏在 `inspect` 中。

## 10. 浏览器状态与提交边界

OpenCraft 的 Browser Runtime 保存页面及 Tab 状态，Browser tool 在需要时通过
`list_tabs`、`inspect` 等操作读取。普通 Composer 提交、Turn steer 与页面重连不从
Browser Runtime 自动构造 `additionalContext`；标签状态不会作为用户输入或可见的
`<external_vela.browser.tabs>` 消息出现。页面恢复只重建 Client attachment 与
Thread 订阅，不创建新 Turn。

如果未来增加显式“附加当前标签”操作，应由用户选择产生独立的上下文引用，并在
提交边界校验来源、页面身份和信任等级；不能把页面存在本身当成用户请求。

## 11. Tool surface 与 ChatUI

为了与 Codex AppServer/ChatUI 恢复协议兼容，线上的结果 metadata 保留原字段：

```json
{
  "codex/toolSurface": {
    "kind": "browserUse",
    "backend": "iab",
    "screenshot": {
      "pageUrl": "http://127.0.0.1:5173/"
    }
  }
}
```

可用 backend：

```text
chrome | iab | cdp
```

OpenCraft 内部可以映射为 `extension`、`in-app`、`electron-cdp`，但不能把 wire key 改成
`opencraft/toolSurface` 后仍声称兼容 Codex。

ChatUI 投影规则：

- 多个低级浏览器 action 聚合为一个 Browser Activity；
- 显示当前 URL、动作摘要、耗时、进行中/成功/阻止/失败；
- 截图作为可展开资产，不默认把大图挤入时间线；
- policy rejection 与普通网络错误视觉不同；
- Browser Use activity 不拥有 Browser Tab 生命周期；
- tool call 的 callId/turnId 用于稳定身份，不能用数组 index。

## 12. Browser Engine SPI

```ts
export interface BrowserEngine {
  readonly kind: "preview-bridge" | "iframe-presentation" | "electron-cdp" | "expo-webview" | "chrome-extension";

  capabilities(): BrowserCapabilitySnapshot;
  createBacking(input: CreateBrowserBackingInput): Promise<BrowserBackingHandle>;
  restoreBacking(input: RestoreBrowserBackingInput): Promise<BrowserBackingHandle>;
  navigate(id: BrowserBackingId, url: string, signal?: AbortSignal): Promise<void>;
  readContext(id: BrowserBackingId, input: ReadContextInput): Promise<BrowserContextResult>;
  inspect(id: BrowserBackingId, input: InspectInput): Promise<BrowserInspection>;
  perform(id: BrowserBackingId, action: BrowserAction, signal?: AbortSignal): Promise<BrowserActionResult>;
  setGeometry(id: BrowserBackingId, geometry: BrowserGeometrySnapshot): Promise<void>;
  capture(id: BrowserBackingId, input: CaptureInput): Promise<BrowserAsset>;
}
```

所有物理句柄必须幂等 `dispose()`。Engine 抛统一 `BrowserDomainError`：

```ts
type BrowserErrorCode =
  | "CAPABILITY_UNAVAILABLE"
  | "POLICY_BLOCKED"
  | "TAB_NOT_FOUND"
  | "STALE_ELEMENT_REFERENCE"
  | "NAVIGATION_FAILED"
  | "TIMEOUT"
  | "BACKING_LOST"
  | "OWNER_CONNECTION_GONE";
```

## 13. 平台能力矩阵

| 平台/Backing | 呈现 | 读取上下文 | 点击/输入 | 截图 | 说明 |
| --- | --- | --- | --- | --- | --- |
| Web + 受控 Preview Bridge | 完整 | 完整 | 语义交互完整 | 尚未实现 | Agent 建站主路径 |
| Web + 任意跨域 iframe | 可能受 CSP 阻止 | 不可保证 | 不可保证 | 不可保证 | 只作 presentation |
| Electron WebContents + CDP | 完整 | 完整 | 完整 | 完整 | 桌面高能力路径 |
| Expo WKWebView + 注入 Bridge | 完整 | 受 policy 控制 | 完整 | 平台适配 | iPad/iPhone 主路径 |
| Chrome Extension | 完整 | 完整 | 完整 | 完整 | 可选外部浏览器路径 |

“跨平台 100%”的含义是：同一命令、同一状态机、同一错误码和同一降级规则。它不意味着
浏览器沙箱允许每个平台做完全相同的物理操作。

## 14. 受控建站 Preview Bridge

OpenCraft 的普通浏览器建站场景不需要先实现 Chrome 扩展。受控预览页由 OpenCraft service gateway
注入一段很小的 bridge，完成 Agent 与 iframe 页面之间的能力握手。

### 14.1 已实现的握手

```text
parent -> child: platform:connect { protocolVersion, previewId, generation, nonce }
child  -> parent: preview:ready { protocolVersion, previewId, generation, nonce, capabilities }
```

验证：

- `event.source` 必须是目标 frame；
- `event.origin` 必须匹配 Preview Binding；
- nonce 一次性且绑定 Session/generation；
- Thread/Host 信息不直接信任 child 回传；
- navigation 后重新握手，旧 generation 立即失效。

### 14.2 v1 已实现的调用面

```text
platform:call(read-context | inspect | click | fill | press | scroll | wait)
platform:cancel
preview:call-result
preview:document-updated
preview:url-changed
preview:error
```

父端实现是 `PreviewBridgeAdapter`，子端实现是 `installPreviewBridgeRuntime`。`BrowserAutomation`
是产品稳定端口；后续 `ElectronCdpAdapter` 与 `PlaywrightAdapter` 实现同一端口，不把 CDP
字段泄漏给 DSH 工具。Preview Bridge 只服务被 OpenCraft gateway 标记的受控站点；外部任意 URL
不注入。console/HMR/network diagnostics 与截图属于下一协议增量。

OpenCraft 的开发服务器与正式静态产物都发布同一个无 hash 注入入口：

```html
<script src="https://OPENCRAFT_ORIGIN/__opencraft/preview-bridge.js"></script>
```

该文件当前约 6.6 KB（gzip 约 2.8 KB）。Gateway 应在返回受控 HTML 时注入它，并仅允许
配置过的 OpenCraft parent origin；普通代理响应与第三方网页不得注入。

### 14.3 Service gateway binding

Binding 是：

```ts
type PreviewBinding = {
  readonly hostId: HostId;
  readonly threadId: ThreadId;
  readonly serviceId: string;
  readonly guestPort: number;
  readonly publicUrl: string;
  readonly trustedOrigins: readonly string[];
  readonly expiresAt: number | null;
};
```

内网透明直连时 `publicUrl` 可以是 `http://host:port`；需要统一域名时由 service gateway
决定子域名或受控 path。Browser Runtime 只消费 binding，不自己猜端口映射。

## 15. HyperNode 路由契约

不需要新增 Controller Lease，也不需要为了第一版建立复杂 Browser Client Registry。

现有 HyperNode 已经有：

- `ThreadExecutionTable` 保存当前执行的 owning connection；
- `TransparentRuntimeLocator.ownerConnection()` 根据 outer thread 定位连接；
- server request ID 关联与 client response 回传链路；
- `item/tool/call` 透明转发基础。

正确路径：

```text
DSH/Codex engine
  -> item/tool/call(namespace=vela_browser)
  -> HyperNode outer thread mapping
  -> exact owner OpenCraft WebSocket connection
  -> OpenCraft BrowserDynamicToolHandler
  -> BrowserRuntime/Engine
  -> DynamicToolCallResponse
  -> HyperNode correlation
  -> engine
```

需要修正的关键点位于：

```text
/data/hypernode/policy/src/services/transparent-backend-outbound.ts
```

当前存在 `owner connection ?? first connection` 的回退。浏览器工具绝不能发给第一个连接；若
owner 不存在或没有 `vela/browser-use` capability，返回 `OWNER_CONNECTION_GONE` 或
`CAPABILITY_UNAVAILABLE`。

手动点击 OpenCraft UI 打开浏览器是本地命令，不经过 HyperNode。只有 Agent 动态工具调用需要
上述往返。

## 16. Cordis 的正确职责

Cordis 用于组装有生命周期的服务，不用于把所有状态做成全局事件总线。

推荐服务：

```text
BrowserRuntimeService
BrowserEngineRegistry
BrowserDynamicToolService
BrowserAmbientContextService
BrowserCheckpointService
BrowserPolicyService
BrowserAssetService
```

每个 `ApplicationSupervisor` 生命周期域安装对应插件。React 通过小型 context 获取稳定服务，
再使用 `getSnapshot/subscribe` 消费状态；不得在 render 中创建 Cordis child context，也不得
用 effect 反复注册同一 server request handler。

适合插件化的 seam：

- 新 `BrowserEngine`；
- 新 Preview Binding resolver；
- 新文档 context extractor；
- 新 policy evaluator；
- 新 ChatUI activity renderer。

不适合插件化的核心：

- BrowserSession 身份；
- ThreadKey；
- lifecycle state machine；
- generation fencing；
- redaction；
- AppServer wire codec。

## 17. 推荐目录

在现有 `browser-core` 的基础上逐步拆出以下边界，不一次创建空包：

```text
packages/
  browser-core/
    src/
      ids.ts
      model.ts
      commands.ts
      errors.ts
      geometry.ts
      context.ts
      capabilities.ts
      engine.ts

  browser-runtime/
    src/
      browser-runtime.ts
      browser-session-state.ts
      engine-registry.ts
      backing-coordinator.ts
      presentation-coordinator.ts
      browser-use-coordinator.ts
      ambient-context.ts
      checkpoint.ts
      assets.ts

  browser-appserver/
    src/
      dynamic-tool-catalog.ts
      dynamic-tool-handler.ts
      dynamic-tool-results.ts
      initialize-capabilities.ts
      tool-surface.ts

apps/
  workbench-web/src/browser/
    engines/
      preview-bridge-engine.ts
      iframe-presentation-engine.ts
    preview/
      preview-bridge-client.ts
      preview-binding-client.ts
    browser-presentation-root.tsx
    browser-panel-plugin.tsx

  workbench-electron/src/browser/
    electron-cdp-engine.ts
    electron-surface-host.ts

  workbench-expo/src/browser/
    expo-webview-engine.ts
    expo-browser-route.tsx
```

现有 `/vela/apps/workbench-web/src/browser/web-browser-runtime.ts` 可以作为迁移输入，但最终
不能同时承担领域 Runtime、localStorage、iframe Engine、geometry 和 UI presentation。

## 18. 状态机

### 18.1 Session

```text
absent
  -> restoring
  -> ready
  -> suspended
  -> closing
  -> closed

restoring/ready/suspended -> failed
failed -> restoring | closing
```

### 18.2 Backing

```text
none
  -> creating
  -> staged
  -> attached-hidden
  -> attached-visible
  -> parked-for-browser-use
  -> destroying
  -> destroyed
```

### 18.3 Browser Use activity

```text
idle
  -> claimed
  -> acting
  -> waiting
  -> claimed
  -> releasing
  -> idle

acting/waiting -> blocked | failed | cancelled
```

任何状态迁移都产出单调递增 revision；异步结果必须同时匹配 session id、backing id、
generation 和 cancellation token。

## 19. 实施顺序

### P0：冻结协议和领域模型

- 将 `BrowserSessionSnapshot.threadId` 升级为 `ThreadKey`；
- 新增 capability/error/geometry/engine 契约；
- 在 `thread/start` 加入三项动态工具；
- 初始化 capability extensions；
- 加入协议 fixture 与 ReplayTransport 测试。

验收：不接 UI 也能让 InMemory AppServer 发 `item/tool/call`，OpenCraft 返回确定性结果。

### P1：`open_in_vela` 与 Presentation

- 将现有多 Tab runtime 接入动态工具；
- 分离 Session close 与 Presentation hide；
- 修正四层 geometry 和 generation fence；
- 支持 right/bottom，恢复当前 Tab。

验收：Agent 可打开/聚焦页面；拖拽、折叠、最大化无白屏、重叠或 z-index 泄漏。

### P2：Ambient context

- 在 Composer context builder 注入严格 block；
- 单 Tab、多 Tab、无 Tab、切换 Thread 测试；
- 页面正文不得混入 ambient block。

验收：下一次发送中能稳定看见 URL 线索，Replay 完全确定。

### P3：受控 Preview Bridge + `get_tab_context`

- service binding；
- 安全握手；
- innerText/selection/form redaction；
- 大内容临时资产；
- 页面错误、console、HMR 事件。

验收：DSH 能打开开发站、读取当前 DOM 文本、识别页面异常，且密码永不泄漏。

### P4：Browser Use

- inspect/revision/ref；
- click/fill/press/scroll/wait/screenshot；
- activity projection；
- stop/cancel/timeout/policy rejection。

验收：Agent 在 Web 受控预览中完成“打开页面—填写表单—点击—验证文本—截图”。

### P5：Electron

- WebContents/CDP Engine；
- prewarm/stage/reveal；
- hidden active Browser Use parking；
- capture viewport 与 visible viewport 分离。

验收：同一 browser-core/browser-runtime 测试套件只替换 Engine fixture 即通过。

### P6：Expo iPad/iPhone

- WKWebView Engine；
- split/stack/sheet presentation；
- safe area、键盘、手势和 app background/foreground 恢复。

验收：产品命令与错误语义不变，只有 Presentation strategy 不同。

### P7：Chrome Extension（可选）

只在需要控制用户外部 Chrome Tab 时实施。页面提示用户下载企业/自托管扩展可以做，但纯
Web 不能静默安装。大陆场景应支持离线包和企业策略，不把 Chrome Web Store 作为唯一入口。

## 20. 必须具备的测试矩阵

### 20.1 协议

- dynamic tool 注册 schema；
- `item/tool/call` 成功、失败、取消、超时；
- 未识别 namespace 继续传给下一个 handler；
- server request ID 重连后不串线；
- Thread start/resume/旧 Thread 的工具可用性；
- WebSocket 与 ReplayTransport 结果一致。

### 20.2 多 Host

- 两个 Host 使用同一个 threadId；
- Agent 调用只到 owner connection；
- owner 断开时显式失败；
- 不允许 first-connection fallback；
- Thread 切换期间的迟到调用被 generation 拒绝。

### 20.3 生命周期

- hide panel 不关闭 Session；
- React remount 不重复创建 Backing；
- Browser Use release 不关闭用户 Tab；
- user close 清理所有状态；
- hidden active Browser Use 仍可完成 action；
- stage/reveal 期间旧 Surface 不白屏；
- checkpoint 恢复但物理 Backing 创建失败时可重试。

### 20.4 几何

- 左/右栏拖拽；
- right/bottom 切换；
- 窄 ChatUI；
- 最大化/退出最大化；
- browser zoom 与 device viewport；
- capture viewport 不受 UI clip 误裁；
- 100 次连续 ResizeObserver 事件无 update-depth loop。

### 20.5 安全与内容

- password、token、hidden input 脱敏；
- iframe 跨域能力正确降级；
- CSP/X-Frame-Options 错误明确；
- prompt injection 页面只作为 untrusted content；
- policy blocked 不尝试备用绕行；
- 大页面写临时资产并按期回收；
- 旧元素 ref 在导航后失败。

### 20.6 Agent 建站端到端

1. 新建可路由 Thread；
2. DSH 启动 Vite 服务；
3. service gateway 创建 Preview Binding；
4. Agent 调 `open_in_vela`；
5. OpenCraft 打开右侧 Browser Tab；
6. Agent 调 `get_tab_context`；
7. Agent inspect/fill/click；
8. HMR 后 revision 更新；
9. Agent 截图并验证；
10. 用户刷新 OpenCraft，Session 与 URL 恢复；
11. WebSocket 断线重连，Thread/Browser 不串 Host。

## 21. 完成定义

不能用“iframe 能打开百度”作为完成标准。v1 完成必须同时满足：

- 三个动态工具通过真实 9988 WebSocket 往返；
- 受控建站预览可被 Agent 读取和操作；
- ChatUI 正确呈现 Browser Activity；
- multi-host owner routing 无错误回退；
- Tab、Presentation、Backing、Browser Use 生命周期分离；
- 四层几何在窄宽、拖拽、折叠和最大化下稳定；
- ambient context 与页面正文严格分离；
- 页面敏感字段脱敏；
- Web 无能力时明确降级，不生成 mock 成功；
- Electron/Expo Adapter 能在不改公共 command 的前提下接入。

## 22. 给实施会话的开工指令

可以将下面这一段原样交给另一个会话：

> 按 `/vela/docs/opencraft-browser-use-reference.md` 实现 OpenCraft In-App Browser 与 Browser Use。
> 先完成 P0，不修改 `/data/mia` 恢复树；`/data/hypernode` 只修改精确 owner routing 和能力
> 协商所需位置。协议必须复用 `thread/start.dynamicTools`、`item/tool/call` 与
> `DynamicToolCallResponse`，不得增加私有 `opencraft/browser/open` RPC。每阶段先补行为测试，再
> 删除被正式状态机替代的 workaround。Web 第一条完整链路使用受控 Preview Bridge；跨域
> iframe 只能声明真实降级。完成 P0 后继续 P1-P4，直到真实 9988 DSH 能打开、读取、操作并
> 验证一个 Vite 页面。

## 23. 还需要用户提供什么

当前开工**不需要额外材料**。代码、最新 Codex 恢复参考、OpenCraft 现有 Runtime、9988 协议和
HyperNode 路由位置都已明确。

只有进入后续平台阶段时才需要产品决策：

1. 外部任意网站控制是否必须在 Web v1 支持；默认答案为“不必须”，Web v1 聚焦受控预览；
2. Chrome Extension 是否进入首发；默认答案为“后置”；
3. Electron 与 Expo 的首发优先级；默认顺序为 Web Preview Bridge → Electron → Expo。

这些决定不阻塞 P0-P4。
