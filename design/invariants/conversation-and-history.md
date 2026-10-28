# Workbench invariants: Conversation and history

[Invariant index](../invariants.md) · [Design index](../README.md)

## Optional conversation overview

The former optional conversation-card overview has been removed. Its Appearance
preference and preview readers are retired; stored preference values are ignored.
The Applications entrance now opens [Overhome](../../docs/architecture/platform/shell-and-navigation.md#overhome-and-miniapps).
Chat state and history retain their original owners. The independent task-board
statistics view and its read adapter remain available.

## User message sender display

Web/Electron show each user message's verified employee `loginName` above its
content, with a 20px circular photo beside the small muted label aligned to the end.
The 企业身份 plugin resolves the photo through the trusted identity-avatar contribution;
failed images retain a same-size person icon. Attachment-only messages use
the same label. Unknown or absent senders leave no label. The label consumes
the individual message snapshot, never the current footer account or Turn author,
and is excluded from copied message text and native model input.
For a locally submitted message only, the runtime captures a verified account's
presentation hint before publishing the optimistic message. The immutable hint
is keyed by exact client message ID and survives acknowledgement in that runtime;
explicit server sender (including null) wins. No current-account fallback applies
to restored history. The bounded in-memory hint is neither a command credential
nor persisted provenance.

## Conversation recovery feedback

- Conversation background synchronization uses the shared neutral loading ring in
  its existing overlay slot, with screen-reader-only status text and no badge
  surface. Reconnection/failure copy and retry actions remain visible. Retained
  timeline, scroll and Composer identity do not change. Verified by
  `scripts/smoke/conversation/smoke-thread-loading.ts`.

## Conversation work-status entry motion

Conversation presentation owns entry eligibility. Its initial snapshot, a changed
Host/Thread and paint/sync recovery through the first authoritative live snapshot
are a restored baseline. Existing activity content and work-status dividers are
visible at their final opacity/height on that first commit; DOM mounting does not
mean work just started. Subsequent live insertions and manual disclosure opening
retain their existing entry motion and reduced-motion behavior. This changes no
Turn clocks, provenance, history persistence or execution state.

Activity-group bodies are keyboard-interactive only in their expanded phase.
Opening and closing bodies remain inert and hidden from accessibility navigation;
visual height animation cannot keep invisible tool actions in the Tab order.
The disclosure trigger keeps focus, and expanding restores normal keyboard access.
Verify closing and expanded Tab sequences alongside reflow and interrupted motion
in `scripts/smoke/conversation/smoke-disclosure-reflow.ts`.

## Turn completion reminders

- TURN-NOTIFY-01: Turn completion reminders are a shared OpenCraft platform
  capability, independent of standalone/embedded entry, product brand and engine.
  Only live terminal Turn events can trigger them; history and assistant phases
  cannot. A reminder cannot change execution, queue, draft or navigation until
  the user clicks it.
- TURN-NOTIFY-02: Explicit opt-in and browser permission are separate authorities.
  No automatic permission prompt at startup/completion; disabled, revoked or
  unsupported delivery is harmless. Async completion is fenced by current
  permission, preference and Application lifetime.
- TURN-NOTIFY-03: Clicks focus the originating browser Client and reuse the
  existing conversation navigation. Notifications disclose no answer text.
  Page-open notifications must not be presented as closed-browser Push delivery.
- TURN-NOTIFY-04: Notification display context belongs to the same Host/Thread/Turn.
  It quotes the Thread title and latest accepted user message excerpt, never the
  active View's unrelated text, a draft or a queued future request. Existing live
  traffic/history can supply display context without triggering reminders or
  introducing completion-time reads; hidden attachment instructions stay hidden.

## Conversation loading presentation

会话首次加载只在无可见历史的空槽中显示居中中性圆环，不显示加载文字；辅助技术可读取本地化状态名。Thread runtime 拥有加载/失败事实，视图不添加恢复计时器或第二套 authority。Design System 拥有共享圆环、主题色与减少动态效果规则；Conversation 拥有空槽几何和滚动。后台重连保留历史、输入和 View 身份，失败切换为可操作的重试而非永久转圈。

Bot 的空展示页与历史耗尽分开：仍有更早源记录时，视口可在没有滚动手势的情况下
按一次恢复意图最多推进三页，串行且有界；额度耗尽或失败在原状态槽提供继续／重试，
不呈现新会话欢迎页、不自动排空全历史。重同步保留有持久锚点的已加载前缀及独立
本地提交，不以展示缓存恢复执行权限。协议所有权见
[Hermes message windows](../../docs/architecture/chat-ui/history-and-recovery.md#hermes-message-windows-and-bot-history-continuity)；
`hermes-bot-history-integration.test.ts` 和 `smoke-hermes-bot-history.ts` 验证真实组件与模拟远端端口，
不代表已替换运行预览或实测远端 Hermes。

## 会话生命周期补充（2026-09-15）

文件更改呈现补充（2026-10-06）：Turn 变更汇总是独立资源，不是消息或工作结束边界。Web 实际 Composer 是指定 active Turn 的唯一运行中入口 presenter，主/浮动 mini transcript 按相同身份避免重复；结束卡再进入消息区。资源更新保留数字、展开与 Review 的身份，展开重排由 viewport lease 协调；卡片/悬浮用主题与成熟 Button/Radix，不新增 Host 写权。实现与真实组件验收见 [ChatUI Changed-file review](../../docs/architecture/chat-ui/files-and-resources.md#changed-file-review)，当前不是生产替换或 Native 实机验收。

Interrupt interaction policy is a pure protocol projection: decline/dismiss
legacy blocking requests with fresh payloads; dynamic tools await server resolution.
The conversation runtime owns turn filtering, all-settled cancellation sequencing,
interrupt provenance and failure cleanup. No UI view or response factory grants
permissions or removes pending requests.

Connector 交互不变量：Composer 入口消费应用级 Manager；授权完成、连接、会话选择与写审批分别表达用户意图。面板卸载不销毁已就绪共享连接；审批由共享 Modal/Radix 管理焦点和层级，配置恢复不恢复执行授权。见 [Connector 设计](../../docs/platform-connectors.md) 与 `smoke:connector-controls`。

Connector 目录属于 Skills 能力页的同级 Tab；配置弹窗复用 Settings 原语，不另建页面专属 UI 框架。共享 SettingsListItem 显式投影是否有图标，无图标不能保留空图标列挤压正文；配置弹窗内容按本征高度滚动，检测结果不能压掉必填字段。凭据不出现在会话、Skill 或持久 UI 状态里；第三方服务运行结果与静态目录说明分别呈现。

Connector 目录浏览不套用设置行：采用限宽品牌卡片，已配置实例单独管理，分类/搜索和返回位置不因打开详情丢失。详情的侧边/窄屏呈现由共享 Modal `inspector` variant 持有，业务不能手写 focus trap 或遮罩；正文滚动不带走操作区。不保留旧长列表模式或为测试专设的第二套管理入口。

- 持久 Thread 元数据、引擎上下文、逻辑订阅、View 是独立生命周期；普通退订不等于中断或归档。
- 临时 Side Chat 分支完整原生上下文，继承历史边界在获取 view 前提交；创建/关闭失败保留清理身份，旧失败不得覆盖主要错误。
- 两个 renderer 共享物理 Host 时，订阅和审批仍按逻辑客户端隔离；后台卸载与新订阅序列化，SDK 迟到退订必须重新订阅。
- 顶部会话菜单按 Host archive capability 显示归档（Archive 图标），复用 threadManagement.archive 并刷新该 Host 目录；点击即关闭菜单并由应用通知层持续显示正在归档，确认后替换为成功提示，失败提示结果未确认并允许用户检查后重试；处理中禁用重复及相冲突操作。归档回执不等待目录刷新，成功或失败均后台刷新目录核对；迟到回执不得关闭用户重新打开的菜单，不提前宣称归档成功。归属任务入口使用 ListTodo 图标与同一菜单图标槽。
- 菜单和 Settings 归档页消费唯一 Host 命令及共享 Radix/主题控件；主 Sidebar 只展示活跃会话，不持有归档入口或撤销提示。归档是可恢复目录状态，不删除 workspace。
- Sidebar 会话行的右键菜单触发区与触控“…”下拉入口互不包含；两者共享操作项、各自处理输入事件，但整个 Sidebar 只允许一个按 Host/Thread/入口标识的菜单打开。切换行或入口须关闭旧菜单，旧入口迟到的关闭回调不得关闭新菜单。选择菜单项不能重新触发另一菜单，重命名/删除的后续交互由 Modal 持有。
- 当前证据：聚焦模型/SDK 测试、真实隔离 DSH Fork/边界/落盘审计、归档重启、完整门禁及实际签名桌面菜单/恢复窗口验收通过；不代表发行或生产发布。见 [本轮账本](../thread-lifecycle/progress.md)。

## 会话权限目录（2026-09-26）

- 标准权限档位只能由 Host 根据引擎真实 profile/preset 投影；未验证的自定义 profile 保留为引擎原生选项，不因名字相似归类。
- 目录的 `openCraftMode`/`openCraftLabel` 只在 Host 声明 `opencraft/permission-modes` v1 时有效。缺失能力时，客户端不得自行猜测标准档位。
- DSH 的 Thread 创建、Turn 执行与 Fork 必须先校验所选 preset；新建 Thread 在创建时应用并回读生效值，不能等到首轮 Turn。DSH 的外部沙箱投影只描述运行时文件策略，不表示提供操作系统级隔离。
- 标准档位用稳定的 `opencraft:permission-mode:*` 提交值，Host 在每次提交时解析当前引擎目录并翻译为原生 profile；会话恢复后原生生效 profile 由目录重新映射为产品档位。产品级权限上限与独立的请求值/生效值持久对账尚未建立，不得声称已实现完整的产品级权限策略。

## 会话顺序与展示分段（2026-10-05）

- 一个执行轮次可以有多个有序问答与活动片段；执行所有者唯一，不等于折叠组唯一。问答、追问与交互边界不得被“回答区/活动区”重新分桶。Renderer 只消费共享呈现计划。
- 异步提问的可见文字与原生 phase 不赋予最终回答资格；折叠边界、最终回答资格和执行完成相互独立。折叠只控制连续片段的显隐，不改变消息位置。
- 源消息与边界身份决定显示 key；流式、完成与补历史不按数组索引重建已有回复。历史片段保持结束状态，当前响应最多一个 Thinking owner；总用时与完成信息不因分段而重复。
- 引擎实际返回的思考摘要/文本与 Bash/Read 工具记录是同一连续响应工作容器内的独立 Item 折叠面，不是工具标题的正文，也不是与“用时”平级的工作区。各引擎默认接入且内层初始折叠；无实际内容不暴露空按钮，不切开工作区或制造“历史消息”标题。真实思考仅分开相邻内层工具组，不重建外层身份；有效最终回答授予该连续工作容器一个外层折叠，最终回答保留在外面。只有真实思考、没有工具也属于有内容的工作，完成后可在真实用时下折叠；不得伪造时间。用户输入、异步提问与交互边界保持原顺序，不同已完成响应保留独立折叠。Turn 用时与实时 Thinking 各只有一个 owner，不跨响应回派。流式、完成及外层收起不改内层用户选择；Web View 与 Native 稳定外层组件按 Item 身份保存选择，动画组件只管理过渡。共享 `chat-core` 选择一份非空内容、保留时序和唯一实时 owner，Web/Native 只消费；契约与证据见 [Returned thinking content](../../docs/architecture/chat-ui/activities-and-tools.md#returned-thinking-content)。
- 思考折叠行以脑形轮廓图标区分状态，不用 Bot 图标暗示另一个智能体；短状态文案须完整可读，嵌入式聊天按宿主站点语言本地化，空间不足时由后面的内容预览收缩并省略，不挤压状态文案。实际返回的思考正文保留引擎原文。
- 回归须覆盖同轮次的异步提问→用户回答→工作→回答→多次追问，包含桌面/触控、折叠、刷新、补历史和正在输出期间的 DOM 身份。
- 2026-10-06 折叠资格补充：共享 `AgentActivitySegmentEnd` 只记录时序结束原因；插话、异步问题、审批、图片及 Turn 完成不赋予折叠资格，旧回答也不赋予后续工作段资格。普通任务段须到达自身有效非异步最终回答，才可默认折叠；取消保留正文。资格、默认值、用户选择与临时强制展开独立，显隐结果不得反写选择；禁止收起按钮的呈现必须保留完整有序正文，不丢失/重复 persistent 项。最终回答保留独立槽位，内层分区也不得隐藏有效最终回答。两端消费唯一 reducer，保留既有 ID、时钟与视口 lease。契约/测试见 [Activity closure and disclosure authority](../../docs/architecture/chat-ui/activities-and-tools.md#activity-closure-and-disclosure-authority)。

## 会话顶部信息

手机宽度（不超过 640px）不展示会话标题旁的 Project/工作区附文，标题与操作按钮保留。桌面继续展示附文。已有“…”菜单的会话详情以只读方式展示实际项目名与工作目录：优先当前会话执行信息，目录尚未恢复时可用同一会话的规范 Thread 元数据；未知字段不伪造，不更改执行目录或启动会话。

会话信息使用共享 InformationPanel 两行元数据和 ModalSurface 自适应呈现：可用视口不超过 640px 为贴底 sheet，超过 640px（含 iPad 常规横竖屏和宽分屏）为至多 420px 居中弹窗；不按设备型号或 UA 分支。标题、右上关闭与目录复制均本地化，不保留重复底部关闭栏。长项目名/路径完整换行且可选，目录复制沿用共享控件的成功/失败反馈与非安全上下文回退。Radix 继续拥有模态、焦点、Escape 和遮罩关闭；窄屏仅顶部手柄拥有下拉关闭，短拖/取消回弹，不拦截信息区的选择与滚动，减少动态效果关闭进出动画。下拉手势由Web平台可选AdaptiveSheetHandle持有，与信息内容一起按需加载，通用ModalSurface不将手势实现加入首屏。主题、排版与触控命中尺寸由共享设计系统持有；不更改会话或执行状态。

Application Markdown link scanning is a pure raw-text projection. UTF-16 source
ranges, escape compatibility and later-candidate recovery stay stable; unescaping
and Host-scoped resource admission remain caller responsibilities. Scanner matches
do not open a resource or grant navigation.

Formula delimiter projection preserves application syntax and raw source ranges;
code-fence precedence and structural placement remain compiler responsibilities.
Display line-tail admission and inline LF rejection cannot silently change during
source replacement.

User-message list/block projection preserves the existing newline and fence
compatibility; indented continuations retain list context and empty lines reset
it. Source replacement must not silently adopt another Markdown dialect.

Global streaming segment keys survive Markdown container reparsing through the
shared reconciler: same-position exact/growing text wins before unconsumed global
exact occurrences. Reused text settles, new text enters only while streaming,
and completed text stays visible. This pure projection cannot commit a session,
change syntax identity, schedule animation or own execution.

### Plugin-owned conversation participant badges

- 企业身份 projects verified authors of retained user-message history, not viewers,
  submitted identity bindings, queued input or Turn count. The same distinct set
  supplies the latest-speaker photo and its login-name list. The fixed trailing slot is right-aligned across single-/two-line rows, with no inline names; only the most recent person is pictured, followed by a separate total count when more than one person is known. The count is a20px theme-owned circular badge, capped at99+ with exact tooltip; it does not overlap the photo. The badge fits its20px photo and optional20px count with a4px gap (44px total), with equal photo/count dimensions and vertical centers; no empty count track or trailing spacer. Its right edge stays aligned to the host action lane; photo position may follow count width. Creator
  provenance comes from a successful authenticated start/fork, never inferred
  from first/last participants. Missing historical creator remains unknown.
  The distinct participants array orders each sender by their latest observed message,
  ascending, most recent last (`MAX(rowid)` in presence); history reconciliation inserts
  chronological messages, live messages use arrival order, duplicate Items do not reorder.
  Snapshot-array comparison still drives revisions, including order-only changes.
- Presence is a derived index in the existing Host SQLite file. First-read native
  reconciliation, fork/rollback and live Item fences prevent stale or unused mappings
  from creating participants. Model failure does not remove accepted user input.
  List returns current snapshots without awaiting native history; cold reads reconcile
  in the background with four active jobs and a five-second cancellable history deadline.
  Timed-out/closed reads cannot apply late results. Failure and recovery invalidate
  readers even without a participant-set revision change; first full reconciliation
  always notifies completion, including an unchanged empty result. Unreconciled
  list rows carry optional pending=true (v1); clients keep phase=loading and prior
  data (null initially), never treating provisional empty rows as ready. Watched pending/errors retry
  at 5/15/60 seconds (capped), retain prior metadata and stop when unwatched or disposed.
  Cold pending rows have no client data and remain visible until readiness is known.
- The generic Thread metadata hook and badge slot carry no 企业身份 domain policy. The
  plugin is enabled by deployment and advertised capability, never a client switch.
- Sidebar owns one open Thread overlay. Badge buttons are independent of navigation;
  old close/focus callbacks cannot close or focus away from a newer overlay.
- Optional list modes use the generic `threadListGrouping` contribution: Shell
  owns menus, collapse chrome and navigation; the product owns grouping and order.
  企业身份 groups each loaded Thread only by recorded creator, own employee first,
  other accounts alphabetically and unknown last. Loading/error are distinct;
  collapsed groups keep metadata subscriptions. Group headers alone show avatars.
  Null mode/unload restores taskflow activity. Optional participation filtering
  defaults off, preserves saved explicit choices, keeps rows without snapshot data visible, hides ready empty results,
  omits its descriptor without a display identity and stays plugin-owned. Plugin-local mode/collapse/filter
  preferences are isolated by product/extension/verified account, never credentials
  or shared account authority; they do not change the active conversation.

Composer 编辑区最低高度按 viewport 统一：达到 768px 时为 64px；低于该宽度为 48px，不依赖指针类型。独立与内嵌入口、新会话与已有会话以及窄面板均使用同一规则，内嵌入口不得另设高度覆盖。内容继续自动增高至既有滚动上限。

Sidebar Server 来源以 metadata 项目名前的7px实心圆点呈现，仅 remote 显示，颜色来自 stableIdentityColor(serverOrigin.serverId)；容器保留 role="img"、From {server} 可访问名和至少12px命中区。提示使用可 hover 进入、可选中文案的 Radix Tooltip，通过 Workbench Presentation Root 脱离滚动裁剪；行 title、行高、状态槽和右对齐内容宽度头像槽不变。视觉复用符合 frontend/DESIGN.md 的浅色 Tooltip contract。

## Conversation overview authority

Conversation statistics is a read-only optional Tasks view. Native full catalogs, latest-turn
results, pins and product-supplied participation evidence retain their separate owners.
Missing sources/results/people are unknown, never manufactured successes or zero coverage.
Current state, latest completion date, archive retention and period activity are independent
dimensions. A creator is not automatically a participant. The tab cannot send/resume a turn
or mutate tasks, and source/account lifecycle changes revoke late projections.
See [Conversation overview](../../docs/tasks-model.md#conversation-overview).


### Optional statistics loading

Tasks loads its optional conversation statistics renderer and styles only after
the statistics tab is selected. Suspense uses the existing loading status; it
does not introduce another data owner or relax the startup resource budget.
The read adapter loads on first read and checks cancellation after import.

## Shared Turn follow policy

The renderer-neutral `timeline-virtualizer/src/follow.ts` is the single follow
ownership policy for Web and Native. Static/watch modes preserve reading; only
explicit bottom intent or the permitted watched-content overflow acquires follow.
Completion alone does not acquire ownership. Restore capture projects a saved
checkpoint without mutating the live controller. Placement/spacer thresholds,
public mode/event names and spring data remain compatibility contracts.


## Shared history backfill ownership

One renderer-neutral coordinator serializes history pages across layout epochs.
Repeated current requests share the active Promise; invalidation fences continuation
and replacement work waits for old work to settle. Every successful page finishes
the host layout barrier before ownership, enabled state or explicit stop decides
continuation. Unchanged height ends the fill pass. Error callbacks retain stale
failure reporting; they cannot grant old work a new layout generation. Public
ports, shared load policy and platform geometry ownership remain unchanged.


## Conversation presentation contributions

Optional conversation subtitles share the existing title rail and constrained
width; renaming and ordinary headers retain their controls. Trusted product
contributions before/after Composer cannot replace its draft owner. Visible
history refresh changes durable history without Resume, page reload or Composer
remount. Hidden/retired views stop scheduling reads; cancelled or stale-generation
results cannot update the new conversation. Browser evidence uses the real
Shell/Header/hook with a synthetic lease, alongside actual runtime/protocol tests;
it does not establish external account or channel delivery acceptance.

Trusted local chat renderer extensions belong to the Application render runtime.
They share its resource policies, roll back on startup failure, and release with
the Application; they never mutate the default library fallback or other apps.

### Legacy realtime envelope presentation

The exact lowercase outer realtime envelope still marks protocol data. Inner
input, source and transcript tags retain case-insensitive matching and the first
complete pair. Role markers consume at most one optional separator whitespace;
repeated bare CR or Unicode line separators cannot be swallowed into an assistant
entry. Preserve decoded text, ordinary multiline continuation, input deduplication
and handoff identity in the shared parser; Web and Native consume its typed block.

Generated images reserve their existing gallery placeholder while generation or Host media resolution is pending. Terminal items with no image and no pending load do not retain a progress indicator.

## Conversation interaction continuity

During an actual response in touch density, only the Composer material layer may
breathe slowly within 92–100% opacity. Desktop input material stays fully opaque
both idle and streaming; its queue/goal rail keeps independent glass. Draft text, caret, buttons and geometry remain stable.
Recovery scan owns recovery feedback and suppresses this secondary execution
motion. Idle/settled and reduced motion/transparency/forced colors are static;
no animation callback owns execution or changes draft identity.

- MCP App surfaces are siblings of tool details. Detail collapse never controls App visibility or lifetime; AppSurface retains ownership of viewport suspension and widget state.
- A command output viewport follows appended output while at the bottom. Scrolling up suspends following; returning to the bottom restores it without moving the conversation viewport.
- Automatic review assessments remain independently expandable for read/search activities, even when their semantic presentation has no terminal output body.
- Sidebar selection changes and selected-section visibility changes reveal the selected row in the actual desktop/mobile scroll owner. Pagination and unrelated catalog updates preserve reading position; detached, hidden or inert content cannot scroll.
- Generated images reserve their existing gallery placeholder while generation or Host media resolution is pending. Terminal items with no image and no pending load do not retain a progress indicator.
- The raw tool-result dialog exposes the shared JSON code surface clipboard action; ordinary inline JSON remains quiet. The copied value includes the complete raw result.

- Selected conversation reveal respects the actual scroll viewport’s computed scroll padding so mobile floating actions cannot cover the selected row.

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

- Browser toolbar input-control and keyboard actions use shared self-drawn SVG
  icon slots with localized accessible names and hint titles. State and actions
  remain owned by BrowserSurfaceHost; changing artwork never requests control.

## Conversation references

Copy, paste, @ search and saved links share a stable server/thread codec. Display titles and Host routes cannot replace identity. A reference dialog owns its captured target and pending draft across asynchronous operations; failures preserve the draft and retry key. Core authorization and native history remain authoritative. Delivery uses the existing Host queue independently of page lifetime. See [conversation interoperability](../../docs/architecture/conversation-interoperability.md).


Token usage people filters select an existing human Actor through the authorized, paginated people usage view. Current display names are presentation metadata, never allocation keys. Selecting a person shows their allocated conversation totals under the retained date/model filters; clearing restores the team view. The optional page never asks users to type an internal Actor ID or obtains other people's directory data through a self query. The Shell still owns the route, scroll and keyboard focus.

### Retained-history recovery presentation

With readable history, automatic connection/history recovery and intermediate failures
render no floating notice or spinner. Only terminal/blocked failure or required client
update presents an action row in normal flow above the Composer, with collapsed
copyable technical details. Existing recovery owners, cold-state presentation,
authority, outbox and command replay remain unchanged. The Application keeps its
Composer and transcript mounted. `tests/chat/conversation-recovery.test.tsx` checks
quiet automatic retry and actionable failures.
## Conversation top spacing

The Web conversation surface owns its block-start inset inside the reversed scroll
viewport. The normal reading gap is twelve spacing units; edge-scroll hosts add
their toolbar clearance. Older-history loading uses the same reserved gap,
projecting the current history owner's loading state without changing geometry.
The indicator never overlays message text or controls and respects reduced motion.
Short conversations, restored reading anchors and both scroll policies share this
surface; loading feedback does not introduce a second scroll controller.
AI follow-up begins with its scope/search/Owner controls, without an introductory slogan or sort-order caption; the task count and existing ordering remain.
AI follow-up cards keep title/decision/state/time/Owner static and selectable. A persistent quiet Open chat text action with a directional arrow is the only card action; it opens the exact original conversation or accessible multi-chat menu. No View details action, implicit title/body opening, missing-link placeholder, whole-body hover fill or nested action. Unlinked cards have no action; existing Board/List retain task editing. The shared task-kind badge and MemberAvatar keep their existing identity and theme owners. Lane identity/count/description sit directly above cards without a surrounding column surface or forced empty height. One subtle card outline replaces internal state/action separators; Owner and chat share the bottom row. The shared quiet control owns keyboard focus, hover modality and touch targets. This supersedes the earlier two-button footer presentation only in AI follow-up.

## Touch message footer clocks

User and assistant message footer clocks are visible at rest for touch input through the shared coarse-pointer/no-hover/current-touch policy. Desktop pointer clocks remain hidden at rest and reveal on existing message hover/focus. Keep time metadata, slot geometry, history cache and action-button availability; elapsed work duration is separate.


## Concurrent native history reads

Identical in-flight Host reads share a native cut only within the same logical
client and epoch, including page shape, watch and checkpoint parameters. JSON
object key order does not distinguish otherwise identical parameters. A
completed result is never retained for later readers. The optional read-history
cancellation capability carries an opaque read identity through RPC-id routing;
cancelling one waiter leaves peers active, while the last waiter retires the
operation immediately. Every cancelled RPC settles through intermediate routers.
Disconnect and logical unsubscribe retire the relevant work; a replacement never
joins an aborted flight or receives its late result. Execution is independent.

Live metadata and rollout source authorization prepare outside the projection
lane. Reconciliation, indexed pages, invalidation and final source validation
remain serialized; snapshot-source watermarks are observed inside that lane.
Native authority, cursor epochs and notification-overlap canonical rereads are
unchanged. Read provenance, payload bytes, decode and return timings are bounded
diagnostics, not presentation state or native-internal profiling.
