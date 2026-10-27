# Workbench invariants: Browser and desktop

[Invariant index](../invariants.md) · [Design index](../README.md)

## Browser 生命周期不变量

| ID | 不变量 | 责任/验证 |
|---|---|---|
| BRW-01 | Browser Host registry 唯一管理 backing host、挂载 claim、持久化状态；独立 transition 管画面交接，React 只提供 slot 与测量 | opencraft/browser-manager.js；当前模块行为及实际 Web consumer、opencraft-browser-manager.test.ts |
| BRW-02 | 上一个页面在新页面收到对应代次的 attachment ack、预热完成前继续承载画面；提交后一帧才释放旧画面与新页面交互 | opencraft/presentation-transition.js；确定性调度测试 |
| BRW-03 | 替换/取消 pending handoff 后，旧 ack、timer、frame callback 不得重新显示旧 incoming 或清理新页面 | A→B→C 和迟到回调回归 |
| BRW-04 | Claim release、presentation detach、logical close、backing dispose 相互独立；旧 reference/generation 不撤销新 claim | 独立状态机＋标准 host port；原生多标签回归 |
| BRW-05 | Page storage ID 与 renderer/host/mount generation 分离；管理器拥有 ephemeral→persistent 与 restore-expected 状态，平台负责持久化同一分区 | manager storage tests＋桌面重启 Cookie 回归 |
| BRW-06 | 弹窗请求经 Main 验证并按原 Page Scope 创建标签；不改写原页面、不生成不受管窗口 | native managed popup smoke |
| BRW-07 | 权限按 partition/origin/type 隔离；旧页面与撤销后的迟到授权不得生效 | browser-permissions.test.ts＋原生拒绝/撤销/清除数据回归 |
| BRW-08 | browser-use 与 UI 挂载独立；操作互斥且 finally 释放；隐藏页仍可渲染/截图，无面板激活副作用 | browser-background.test.ts＋原生后台读取/截图/关闭回归 |
| BRW-09 | 恢复未完成不是用户关闭；close 与清除站点数据分离，重启不因 localhost 端口变化丢失归属 | desktop metadata＋native restart smoke |
| BRW-10 | 设备工具栏只投影父层 viewport mode/zoom；聚焦数字草稿独立，范围内编辑即时提交、失焦规范化，预设/旋转不夺取 Page 或持久化所有权 | 独立 toolbar/input；136 静态、64 Web 检查点及两组258边界；手柄/布局保持原owner |
| BRW-11 | 远端帧按外层 visualBounds 宽度等比投影并从顶部裁切；软键盘改变高度时不得把旧帧再次 contain 缩成小整页；触点、菜单和光标共用此投影，固定设备外层居中不变 | RemoteBrowserSurfaceHost；真实 Canvas/MSE H.264 高度变化中间帧负控与命中验证 |
| BRW-12 | 同一远端页的尺寸/解码切换保留最后可读帧，首个完整新帧就绪才原子交接；晚到旧代次与未就绪视频不得覆盖，保帧不冻结远端真实布局或增加空闲刷新 | Canvas 同任务 resize/draw、MSE 首帧 fence；延迟首帧/连续切换/恢复负控与取消测试 |

历史迁移验收：66 项聚焦测试、完整门禁，以及当时最终打包应用的多标签/隐藏保活/分区重启验收通过（/tmp/oc-browser-MGEbk1）。没有新增 bottom-panel UI；非标准 WebContents adoption 不在标准 Electron port 内伪装支持。标准宿主桥接单独验证，不沿用旧原生验收证明 registry 与 toolbar 的后续实现。

模型成立、编译通过、真实控件通过、真实 Host 通过、Mac 产物通过是不同级别。未经相应验证不得提升状态。不得擅自增加未经定义和验证的行为约束；结构互斥、稳定前缀和同步移交本身可构成合法保证。
### Existing native desktop binding

A local desktop tab consumes one operator-installed desktop binding. The binding
is verified against the actual X socket peer, source service invocation and
process identity; neither tab selection nor a request chooses a machine/display.
An additional immutable observation channel never restarts the existing desktop
or VNC. Manual input uses the separate physical exclusive executor; recovery
returns to viewing and cannot reacquire control or affect Chat execution.

The sidebar resize separator keeps its existing themed one-pixel gradient visible at rest as well as hover, keyboard focus and drag. Visibility does not depend on pointer presence; existing header exclusion, hit target, collapsed/transition suppression and resize ownership are unchanged.


### Browser capability compatibility

Core browser flows target the baseline in [build-matrix](../../docs/build-matrix.md#browser-compatibility); optional APIs require detection and a fallback. Plan-step disclosures use the existing Radix Popover and the Workbench presentation-local portal, retaining touch/keyboard activation, Escape/outside dismissal and collision handling without requiring native Popover support.


## Browser presentation handoff leases (2026-10-20)

A view handoff retains the painted predecessor until the incoming attachment is
acknowledged (or its bounded fallback expires), two prewarm frames complete and
the release frame runs. Both views remain interaction-blocked during transfer;
finishing a view cannot clear its separate automation input/focus lock. Owner,
surface, reference and mount generation identify the presentation lease. Hidden
views, close/dispose, route transfer and superseding views revoke pending work;
late callbacks and old references cannot mutate a newer lease. Browser backing,
persistence, permissions and navigation retain their existing manager/Host owners.



Viewport presets remain application compatibility data: device IDs, dimensions
and ordering do not change when implementation provenance is reviewed. The
manager and toolbar share the declared lazy initialization and width/height
bounds; unused recovery utilities do not introduce another padding or token
owner.

### Recessed browser reading plane

AppShell resolves the active appearance shell material with the same catalog and mode as CSS projection. A recessed browser header keeps the reading frame below the toolbar at all widths; frame origin, upper lip and body depth share that boundary. Width eligibility alone must not move conversation content behind recessed chrome. Other materials and native window presentation retain their existing immersive layout. Appearance changes update this single Shell decision without replacing the conversation or editor.



### Cloud desktop product composition

Trusted renderer composition owns desktop availability: `cloudDesktop: null` installs
no desktop panel, toolbar action or Composer shortcut, even for a capable Host.
An omitted option keeps Host capability discovery and an adapter keeps its explicit
backend. This policy never mutates desktop state or grants input authority.


## Remote browser viewing and control

Multiple authorized clients may view one remote tab without recreating it or
claiming input. The remote toolbar offers a quiet Control/Release action beside
the keyboard action, using the existing toolbar target and typography. The
service control grant owns remote viewport and input; local view layout is only
a projection. Losing control retires local composition, keyboard focus, menu and
held contacts without resetting the video. Human gesture acquisition preserves
local synchronous focus for system keyboards. Disconnect and park retain the
tab; explicit logical close retires every viewer and the native page.

### Conversation browser resources

Conversation rows expose retained tab counts and a menu to reopen existing tabs
or explicitly close all tabs owned by that Host/Thread scope. Reading the directory
never initializes a page or surface; counts are logical resources rather than
measured memory or process liveness. Resource menus share the sidebar menu owner
with conversation actions and participant menus. Navigation, title, status and
participant controls retain separate tracks on compact and touch rows. Closing a
menu or leaving a conversation retains tabs; explicit close uses the existing
resource retirement path.

### Browser backing layout and aperture

Browser layout consumes the current content slot, while the Shell aperture clips
painting and hit testing. Visibility motion must not resize the page or encoder.
Local iframe, Electron guest and remote canvas use the same measured clip,
without changing input coordinates or physical-page identity. Ordinary divider
and window resizing remain live; parking preserves the normal viewport.

- Tool maximization/visibility animates the aperture independently of the content layout endpoint. Retain the last layout mode while closed; a new visible intent picks the endpoint immediately. Normal handle/window resizing remains live. Chrome borders follow the content mode so visibility alone cannot resize embedded pages.

- Portaled browser surfaces follow Shell foreground translation after Motion DOM writes, including the terminal frame; unchanged viewport size must not suppress position updates.


- Native control and editor icon paint: reuse the shared SVG artwork through the
  generated native-control masks or JSX, while retaining native input events,
  keyboard/label focus, validation, system pickers and CodeMirror command owners.
  Forced-colors fallbacks remain accessible; retained sidebar/panel artwork and
  collaboration numeral font are unchanged.


- Workspace code search uses the editor's top panel slot so the existing floating
  chat input cannot cover search options or replacement controls on narrow screens.
  Search query, replacement, editor draft and save ownership remain unchanged.

- Notification and native-selection artwork: dependency defaults are mapped to
  shared SVG at the notification owner. Native selects keep their original
  element, attributes and keyboard/popup behavior; multiple/size lists never gain
  a dropdown arrow. Numeric stepper paint is opt-in where hidden spinners already
  serve another control. Forced-colors native paint remains intentional.

- Compact Chat process glyphs share `BrainArtwork`, `TerminalArtwork`,
  `BookArtwork` and `PencilArtwork` in the existing design-system-web owner.
  Static model/terminal/edit controls reuse these contours. One fold/seam or
  prompt supplies recognition at rail size; no second underline or miniature
  page/brain ornament. Artwork changes preserve process/disclosure identity,
  running/reduced-motion semantics, rail metrics and protected layout/gear/font.
