# Browser: Platform and presentation

[Architecture index](../../browser-workbench-architecture.md) · [Documentation index](../../README.md)

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

### Newera mobile browser chrome

The touch-density Newera Web presentation uses bottom browser chrome when a
narrow window presents an active full-width browser panel. Desktop, Newera-off
and non-browser panels retain their existing chrome. The installation's density
projection and Shell's actual full-width state select presentation; neither
changes the remote page's shared viewport or device profile.

BrowserPanel owns local address editing and consumes the original Page commands.
RightPanel projects its existing tabs/actions through PanelNavigationContext for
the mobile overview, including non-browser tabs; overview cards display actual
metadata rather than pretending to be live screenshots. Radix ModalSurface owns
focus, dismissal and input exclusion. Opening the overview does not create a
second browser page or close the active logical resource.

The browser renderer and mobile-specific chrome/styles load on demand from the
registered panel type; registering navigation must not eagerly load its UI into
the startup graph. Existing startup resource budgets remain unchanged.

The existing FloatingComposer owner initializes each Newera mobile browser to
on-demand presentation once. Agent reveals the same editor and latest-turn
renderer; hiding, resizing and switching chrome preserve drafts. A direct keyboard
button consumes the existing native editing capability and invokes showKeyboard
synchronously in its local gesture. No remote async notification forces a Web
keyboard, takes control, or guesses an editable target. Device verification of
the actual OS keyboard remains distinct from component/focus verification.

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

Trusted application composition can supply a product navigation policy; the
standalone Web and Electron defaults do not supply a private-site allowlist.
A product allowlist must match parsed HTTP(S) hostnames at DNS label boundaries,
not arbitrary URL text. Its external opener should preserve the containing
conversation and use `noopener,noreferrer` for a new browser tab. This is a
policy for OpenCraft-initiated navigation, not a security boundary for redirects or
navigation initiated inside an inaccessible cross-origin guest.


### Viewport drag geometry replacement (2026-10-20)

The `viewport-resize.js` pure helper owns axis geometry. Device preset facts,
browser manager, toolbar and transition ownership remain with their current
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

### Viewport preset compatibility data (2026-10-20)

The preset module retains the existing ordered 13-entry application catalog,
disabled responsive default and lazy/idempotent public initialization. The
toolbar and manager consume the same six declared exports. Numeric helpers
round and bound width/height without owning capture, persistence or scale.
Unused, undeclared recovery utilities/tokens are removed; device names and
application dimensions are retained. This catalog is not a hardware specification.


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

### Browser toolbar input action artwork (2026-10-22)

The input-control and keyboard actions use the shared hand-drawn SVG family in
`design-system-web/action-icons` and the existing toolbar icon slots. Control uses
a pointer to take control and a crossed pointer to release it; keyboard uses the
shared keyboard artwork. Localized accessible names and hint titles remain on
the buttons. Unavailable controls stay absent, keyboard readiness still determines
disabled state, and actions still call the existing surface owner without changing
lease, focus or keyboard policy.

## Conversation list resource management
Conversation rows expose the logical tabs held by their canonical Host+Thread binding, including tabs retained without a visible presentation. The coordinator owns a stable, per-conversation subscribable metadata projection (tab identity, title and URL); reads do not create a binding, open a panel, prepare a surface or attach to a native page. Title/navigation updates reuse unchanged projections and notify only the affected conversation. Binding promotion also refreshes the directory.

The row resource menu lists tab titles, opens an existing tab in its original scope, and offers explicit close-all for that conversation. It shares the Sidebar's exclusive menu owner. Leaving the conversation or dismissing this menu does not destroy tabs or take input control. Counts describe retained logical tabs, not measured CPU or memory, native liveness or viewer/controller ownership.
