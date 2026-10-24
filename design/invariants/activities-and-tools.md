# Workbench invariants: Activities and tools

[Invariant index](../invariants.md) · [Design index](../README.md)

### Asynchronous operation feedback

Workbench asynchronous action failures use `AsyncNoticesProvider/useAsyncNotices`
in a top-right nonmodal overlay. Features must not append error blocks to menus,
list rows, dialogs or nearby content and change their geometry. Pending feedback
stays in the existing action slot. Header rename/pin/archive/fork, task membership,
sidebar conversation actions and archived-conversation restore share the channel.
Messages are localized user-safe copy, optionally identified by conversation/task
name, with no raw RPC error text. Unknown mutation results are never auto-replayed.
The provider owns stable operation/entity IDs, default five-second dismissible
notifications, and a maximum three visible notices. Sonner owns focus-preserving
announcement, keyboard/swipe and pause/expiry behavior. Full and embedded roots
have independent channels; the latter portals into its styled presentation root.
Provider disposal dismisses its notifications and invalidates late publishers.
Input validation may use a fixed reserved field slot; cold-read errors replace the
existing content state rather than appending a second feedback region.

Toast management additionally exposes `info/success/warning/error`, scoped
`dismiss(key)` and `dismissAll()`. Presentation dismissal and history deletion
are different operations. Desktop and touch Shell headers do not expose a bell
or reserve a notification-center action slot. Transient Toast feedback remains
independent of any history consumer. The provider retains bounded history, which is
in-memory per Workbench instance and cleared by disposal/reload; it is neither
a cross-device inbox nor the approval/failure task-attention model. Details and
consumer contract: [Toast notifications](../../docs/toast-notifications.md).

## Reasoning presentation work

Thinking ownership is resolved before Markdown header compilation. Reading a
live todo never materializes the transcript. A mounted Turn may retain bounded
plain reasoning presentations by Item, selected source and active grammar mode;
reprojection reuses unchanged history while edits and completion invalidate the
affected Item. The full canonical body, disclosure identity, explicit user
choices, drafts, focus and scroll ownership remain unchanged. No process-global
private-text cache or truncation is introduced. See [ChatUI reasoning](../../docs/chat-ui-architecture.md).

## Activity icon rendering

Conversation process summaries, including active/completed compaction, share body typography (14px/20px, regular weight) through ActivityDisclosure/ActivitySummaryRow. ActivityIcon and the scoped conversation-activity stylesheet own the centered rail and optical SVG calibration; feature renderers supply unchanged glyphs without local metrics. Reading preferences affect expanded content, not process labels. See [activity visual ownership and checks](../ui/activity-icons.md); existing glyph identity, disclosure state and list spacing remain independent.
Composer输入辅助菜单焦点策略独立于模型/权限业务和Radix基础设施：仅触控/笔且编辑器正在聚焦时保留其焦点lease及原生选区，取消自动focus转移；键盘/AT或非编辑入口仍由Radix导航。触控期间继续输入/Escape可关闭、ArrowUp/Down显式进入菜单；外部关闭/卸载不得迟到抢焦点。该策略按props可插拔，不冻结视口、不伪造光标、不承诺控制系统软键盘。

附属rail背景在结构tuck之外仅覆盖1px材料接缝（coverage-composer-material-seam），到输入框边框下方，避免两份伪元素背景的外/内缘留下亚像素未覆盖带。验收测材料绘制边界，不能只比容器bbox；独立材质与无缝约束保持，结构tuck按完整对称圆弧计算。

非空附属rail与shell连接处不重复绘制shell顶部边框/内侧高光；空rail恢复独立输入框完整边界。用户确认本轮对象为静止时中间横缝。

Conversation search keeps result identity as Host/Thread. Moving the active result may reuse unchanged row presentation, while query/catalog/content-source/locale changes refresh the projection, disabled state and callbacks. The dialog retains input focus, active-descendant navigation and selection/abort ownership; rendering reuse must not truncate results or defer search. Unrelated App snapshot updates keep the searched-thread callback stable for the same Host catalog, and the search wrapper keeps close stable for the same open-state owner. Search selection subscribes only to the existing sidebar-dismiss action rather than unrelated Shell geometry. Owner replacement still refreshes callbacks; result reuse never captures obsolete navigation, close or locate behavior.

## Activity disclosure layout identity

An activity row keeps its layout role when opened, closed, streaming or settled.
The list owns external item gaps; the shared disclosure owns summary/detail
geometry and internal reading space. Only the active detail region and its
ancestors may grow. Sibling margins, unrelated dimensions, order and identity
remain stable throughout animation and streaming; closing restores geometry.
The list must not classify a row from a deep descendant's disclosure state.
Content/prose boundaries are based on stable content roles, not open state.
See [spacing ownership](../../docs/architecture/chat-ui/activities-and-tools.md#activity-disclosure-spacing-ownership)
and `scripts/smoke/conversation/smoke-activity-spacing.ts` for real Conversation frame sampling.

### MCP App 客户端宿主

- Web/Electron 的 MCP App 是显式可执行资源边界，独立于静态 HTML 只读预览；不得因此放宽后者的去脚本/禁导航契约。
- `appResourceUri` 对应 `ui://` HTML 在 `sandbox=allow-scripts` 的 opaque-origin iframe 中执行；不授予 same-origin、顶层导航、弹窗、下载、设备权限。默认 CSP 不联网，仅接受资源声明的规范化源，禁止 frame/worker/base/form。Host 的账户凭据和任意 AppServer RPC 永不进入 iframe。
- 标准 MCP Apps 2026-01-26 与 Hypernode `window.openai` 共用固定 Host/thread/server、连接代际和权威租约检查。App 工具调用必须存在于所属 server 的可见工具目录，model-only 工具不可调用；资源读取限本 App URI，私有 `_meta` 仅传 View。
- 关闭/切换/后台及不可见区域释放 iframe 和监听；迟到结果不得跨 owner 写入，无自动重试工具副作用。普通工具输出不加载 App 宿主。App 上下文和 widgetState 只在内存保留，上下文经既有 SubmitIntent 作为 untrusted additionalContext 投递，不新增 canonical 历史库、不改用户草稿。
- 能力协商只声明实际实现项；首版 inline 模式，文本消息/上下文、工具与当前资源读取、外链、尺寸/主题/输入输出可用，不声明 fullscreen、采样、资源订阅、下载或设备权限。

- MCP App 自动尺寸区分真实内容失效和纯高度视口响应；`100vh + margin` 不得把宿主刚应用的高度循环当作新增内容。真实内容/媒体/字体/宽度变化继续测量，显式尺寸消息沿用既有桥。容器宽度来自 iframe 实际布局，合帧去重通知，不轮询、不重读资源、不重放工具、不重建 iframe；observer 与待执行帧随 View 清理。

### DSH Goal execution projection

Goal durable phase and native live activation are distinct. An active/disarmed Goal presents paused with explicit Resume, including cold restore/fork; a read never arms continuation. Hosts declaring `usageAccounting:false` omit elapsed/token metrics, while older capabilities retain existing accounting. Goal mutations/driver stay server-owned; shared Composer UI does not schedule rounds.

## Activity group disclosure replacement (2026-10-19)

The complete group disclosure component and four-phase reducer are independently
reimplemented after frozen requirements. The viewport remains the only scroll
writer; the existing reflow lease and height projection ports own integration.
Open content keeps natural height and DOM identity during streaming and reversals;
summary key changes are separately cadenced.
The reflow smoke fixture now supplies current activity-unit metadata and inner
choice callbacks without weakening its geometry/cancellation assertions. This
replaces only this module's implementation disposition, not the consuming activity
renderer, shared hooks, native platform or historical rights status.


## Command and review presentation replacement (2026-10-20)

The complete command/review module owns only Item presentation and mounted View
choice: reasoning content selection comes from shared core, existing document
ports own Markdown/resources, ActivityDisclosure owns reflow, and timeline/core
retain chronology and single Thinking ownership. Commands initially fold, retain
choice across completion, delegate semantic read/search/skill policy and expose
reported output/result state without executing text. Review disclosures grant no
permissions; a generic licensed shield/terminal replaces historical custom artwork.
Copy delegates to shared clipboard ports with action-scoped 1500ms feedback and
cleanup.
No new tests/harness are added; existing actual Conversation, spacing, type and
boundary checks remain acceptance evidence. Shared ports and historical rights
remain independent unresolved matters; native hardware is not claimed verified.


## Tool, image and subagent presentation replacement (2026-10-20)

The six tool/image/subagent exports remain presentation consumers of core summaries,
typed content, group state and reported handoff steps. Product-owned content may
claim null; fallback is only for undefined. Nested WebMCP disclosure choice is
independent of its parent. Images use the existing Host media loader and resource
port, with Host/conversation/cwd/document/source identity invalidating old previews.
View expansion does not grant tool approval, execute output or own thread state.
Subagent grouping uses current core-derived agent state; individual instructions
remain available without repeating stale historical prompts in grouped rows. Each
expanded row uses that agent’s latest matching operation and instruction, while
its identity and status remain core-derived. A one-operation group retains its
input, reasoning effort and agent path details.
Activity rails, fonts, modal focus and viewport reflow retain their shared owners.



### Thinking tool-group restoration

A folded lazy tool group mounts collapsed on its first DOM commit, including an
in-progress Turn restored by session switching. It must not manufacture an
expanded frame and then animate it away. Explicit saved expansion, manual toggles
and live content updates retain their existing ownership and transitions.
Evidence: `scripts/smoke/conversation/smoke-conversation-entry-motion.ts` samples real Conversation
group phase and body height on the first commit and subsequent animation frames.


### Activity detail motion

Chat process motion follows actual row running state. The shared SVG base stays
intact while a loop/page/nib detail or command cursor moves. Collapsed groups
animate their shared header glyph; expanded groups hand motion to visible running
rows. Summary-only exploration keeps header motion when its body has no active row.
Completion, interruption, failure and reduced motion leave static artwork. All live
process summaries also use the shared cadenced text sweep, alongside the glyph detail.
Disclosure rows, summary-only rows, active group summaries and agent tool rows
compose ActivityRowContent, the single glyph/summary paint owner. Running state
stays outside deferred summary snapshots; callers never nest process sweeps. Settled summaries have no sweep, and reduced motion suppresses
it through the shared stylesheet. Text/rail geometry, disclosure
interaction and user drafts remain owned by the existing Conversation and Shell. Static controls share
the base artwork without activity overlays.


### Async operation feedback

Every user operation distinguishes admission, pending, acknowledged success and
failure. `SettingsButton loading` owns the visible indicator, aria-busy and disabled
state; the caller owns the operation and translated progress label. A disabled
control alone is not feedback. Rename and delete settle at write acknowledgement,
with catalog refresh continuing separately. Stop progress does not claim the Turn
has completed; repeated pending stops share the same Thread-owned command.
Conversation menus opening a modal do not hold a second modal pointer lock.
Real mouse/touch regressions must cover menu → dialog → cancel/confirm → another
click, including delayed/rejected requests. Static lint cannot prove timing,
feedback visibility, focus release or failure recovery; do not add a blanket ban
on async handlers, void expressions, disabled controls or awaited refreshes.

## Persistent activity content and response feedback

- Activity disclosure has one keyed content list for persistent surfaces: a transcript or MCP App appears once, keeps its chronological expanded position, and a visible App retains the same iframe and input across detail toggles. A realtime handoff starts a fresh response feedback scope, so earlier running work cannot suppress its Thinking placeholder.
