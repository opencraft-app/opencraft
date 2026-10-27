# Workbench invariants: Tasks and follow-up

[Invariant index](../invariants.md) · [Design index](../README.md)

## Tasks V1 editor continuity

One activation-scoped TasksEditorSession owns dirty task, inline-create and
progress drafts. Quick editing, full details and conversation navigation consume
that owner; a clean task reopened after a remote update reads current content.
Content CAS conflicts remain visible, and posting progress never rebases or
overwrites a content draft. A retained progress eventId is reconciled by exact
read across lost acknowledgements before any retry.

Radix owns quick-edit focus/dismissal and full-detail modality. Detail close
uses the same accessible X icon at every width, with a localized hover title
and shared icon-button hit target; closing and busy-state behavior stay Radix-owned. Wide details
place activity beside content; narrow containers switch the same mounted inputs
with content/activity tabs. Metadata uses labels above controls on phones.
Column creation captures only a title in place, respects IME composition, and
keeps its stable ID until the authority confirms creation. Card summaries show
only available metadata and the latest explicit progress; conversation activity
never changes the business status.

## Tasks View

- 概览只保留标题与任务操作，不展示标语或全局统计行（包括手机筛选展开时）；状态列计数与负责人/项目/逾期筛选保留。

- TSK-01：任务属于插件 View，Sidebar 与应用 Router 拥有呈现和会话导航。列表与看板读取同一批任务；任务/关系表为 tasks/task_conversations，v2的task_members仅为责任目录；没有独立卡片/列权威。
- TSK-02：六个业务状态由用户维护；原生会话活动单独读取，未知不等于空闲，空闲不等于完成。拖拽不触发执行或中断。
- TSK-03：固定工作台后端拥有 SQLite；聊天 Host 切换不改变数据库。多会话关系引用稳定 Server/Thread，允许跨 Server 与多个任务共享会话。旧卡片不迁移、不删除。
- TSK-04：插件激活拥有控制器和草稿，View 消失清理观察者，返回保留草稿。迟到读取不能覆盖写入；事务 revision 防止并发覆盖，冲突保留输入，明确载入最新内容。
- TSK-05：容器宽度不超过 600px 时展示共享 SegmentedControl 与单列；宽屏七列。状态和视图按钮沿用共享 toolbar 外观，触摸区扩展至 44px。各列滚动位置保留；看板整卡可启动拖动，动作按钮独立，触屏普通滑动保留滚动、长按激活；列表保留手柄启动，两者保留键盘手柄。拖动预览不被列裁切，跨列落下以起始revision提交状态/邻居，取消不写入。宽屏列与吸顶标题使用主题拥有的不透明 surface，滚过的卡片不得透字；窄屏继续隐藏重复列标题。真实长列遮挡与主题/断点连续性由 `scripts/smoke/tasks/smoke-tasks-column-scroll.ts` 验证。
- TSK-06：详情是采用共享模态视觉契约的 Radix 弹窗卡片；宽容器显示属性栏，窄容器堆叠同一组字段并在顶部保存，宽度变化保持输入节点。进入聚焦标题而不唤起手机键盘，点击外部、Esc 或关闭按钮收起，保留各任务未保存草稿与原 revision。模态背景不可交互；关闭恢复概览原节点/滚动及仍有效的入口焦点；不添加另一套浏览器历史。看板仅显示标题、活动摘要和一个会话捷径，列表使用独立紧凑行。写入期间禁用编辑和关闭，异步会话验证在 View 关闭后不能关联到新草稿。
- TSK-07：任务进入原生聊天只准备草稿，用户发送才创建会话和执行；同 Server 项目进入执行位置，跨 Server 不复用项目/目录。确认 Thread 回执后关联，首次 Turn 失败不丢关系；关联未知结果只核对和重试关系，不能重新执行。客户端交接记录按产品/账号隔离，SQLite 始终拥有任务和关联；账号撤销、销毁或新导航隔离迟到工作。
- 执行连接行的宽屏动作与下拉控件底边对齐；窄屏沿同组控件堆叠、按钮靠起始边，保留共享触控尺寸与原 DOM，布局不改变新建会话语义。真实几何和换宽连续性由 `scripts/smoke/tasks/smoke-tasks-team.ts` 验证。
- 看板的一条会话捷径将图标、标题、已知原生活动和进入箭头合并为一行，不重复数量/Unknown文本；长标题单行截断，完整标题保留提示及可访问名称。缺少标题或读取回退的Thread ID显示本地化打开会话，未知活动仍保持未知。多关联仅补充其余数量和查看全部入口，由现有详情拥有关系管理；直接行仍消费原Server/Thread导航，不触发卡片详情或写入。共享按钮、metadata排版和主题token拥有外观与键盘焦点，触屏目标至少44px。
- 看板卡片负责人仅为底部左侧头像，位于会话摘要/入口之后；姓名通过提示和图像可访问名称呈现，列表/详情继续显示姓名。头像复用现有照片/缩写/未分配回退，不改变分配、登录、权限或个人筛选。
- TSK-10：负责人/优先级/截止日期由任务事务保存，成员标识显式维护、不等于授权。旧客户端省略属性仍保留，Agent CLI与UI复用唯一authority与CAS。Skill仅摘要常驻、正文按需，CLI分页摘要不把整库注入上下文。
- 验证入口：`tests/tasks-*.test.ts`、`scripts/smoke/tasks/smoke-tasks-workbench.ts`。实际产物与平台验证状态见 Task Pack。
- TSK-08：已有会话的顶部“…”位于右面板按钮左侧，通过固定任务 authority 设定多个归属任务；使用稳定 Server/Thread 身份，不把当前聊天 Host 当任务库。每个关联行单独反馈写入，冲突或未知结果重新读取而不重放。草稿不显示入口，切会话/账号关闭旧选择器，解除关系不改变会话执行。
- TSK-09：会话顶部菜单的重命名与置顶操作消费已有 ThreadTitleWriter 和原生 thread management port，与侧栏共享持久状态。只显示 Host 支持的动作；不依赖 Tasks 插件可用性来授权会话管理。重命名使用共享 ModalSurface，失败保留输入、处理中禁用重复提交；置顶失败留在菜单可重试，不伪造已成功状态。菜单/编辑会话按账号、Host、Thread 隔离，切换撤销旧 UI。


## Tasks type badge continuity

Type labels consume one foreground/background pair from the design-system theme
engine. Every known or unknown type keeps a visible badge and its text in light,
dark, extension and forced-color themes; no database type or workflow state is
changed by choosing a presentation tone.

Web user-message navigation rail is inset 36px from the conversation viewport. Desktop Web conversation titles consume that same leading axis. The existing 36px hit target requires 72px content clearance, derived from the shared inset; insufficient space suppresses the rail rather than covering prose. Narrow headers retain measured control spacing and Electron retains its native title geometry and platform-specific 16px rail inset. Browser navigation without branding or actions contributes zero measured width; restoring content restores its physical measurement. Header alignment consumes Shell host identity inside both document and ShadowRoot presentations, rather than relying on an outer html attribute.


## Tasks action hierarchy and recycle continuity

Tasks owns one browse draft for Board/List, query and assignee/type/project/date
filters. My tasks and assignee selection must stay synchronized. New task is the
heading's primary action, while More owns management actions. The recycle view
has explicit back/refresh controls and hides irrelevant browse/create actions;
returning preserves the mounted active view and editor session. Manual refresh
is read-only, prevents duplicate clicks while awaiting its result, and leaves
query, filters, scroll and drafts intact. Desktop and compact layout consume the
same actions; compact My tasks remains directly reachable. Linked conversation
opening remains local to the card/detail. Validate real keyboard/touch menus,
filter synchronization, recycle round trips and refresh with held requests.


## Demand pool columns

Board splits backlog into Product backlog and Technical backlog, followed by the
existing workflow columns. This is one projection of the task status and kind:
engineering, harness, research, documentation and operations backlog tasks use
the technical pool; all other or missing kinds use the product pool. Filtering,
counts, compact selection, loading geometry and scroll/draft keys use the same
column identity. Existing statuses, ordering and task data are preserved.
Inline creation defaults to feature in the product pool and engineering in the
technical pool; compatible kind filters are inherited, incompatible filters do
not override the chosen pool and a hidden-result notice explains the filter.

## Tasks board card width

The seven-column board uses one Tasks-owned minimum column width token of 340px,
with equal flexible tracks above that minimum. Cards fill the column content
width. The board scrollport owns horizontal overflow; the page does not expand.
At task-container widths of 600px or less, the existing selected single-column
layout continues to fill available space without applying the desktop minimum.
Sticky headers, card actions, and list/detail layouts keep their existing owners.

## Tasks whole-card activation

The board card's passive surface (padding, kind, conversation summary, progress and owner)
opens the existing detail editor. The native title button retains keyboard
activation and receives focus for a surface click's close/return path. Nested
buttons, links, form controls, quick-edit menus and conversation actions keep
their own handlers; selected text is not a detail activation.
Surface activation also requires a press begun on that passive surface; control
presses retargeted to the card ancestor and cancelled pointers cannot activate
it. Portal targets outside the physical card are excluded.
Board/list offer no drag gesture, sorting handle or drag preview. Description
and acceptance presence icons are absent; their full content remains in detail.
Explicit status selection still persists through TASKS.move/CAS, preserving old
ordering and schema. Real interaction smoke covers passive clicks, selected text,
action isolation, absent pointer/touch reordering and explicit status persistence.

## Tasks card action visibility

Card tools reveal on hover, keyboard `:focus-visible` outside pointer-origin mode, or
the card's Radix menu trigger `data-state="open"`. Ordinary pointer focus may
remain for detail return without pinning the tools. Menu portals must retain
their card's visible anchor until closed; no forced blur or hover timer is used.
Existing compact/coarse-pointer always-visible rules and keyboard access remain.

## Tasks archive retention

Archive is an independent persistent timestamp, not a workflow column or an
expiring deletion. It removes tasks from active views but retains IDs, content,
properties, original status, history and conversation references indefinitely.
The same authority enforces CAS and read-only archived records; restore appends
to the original column and checks active capacity. Search uses bounded server
pages and discards late queries. UI/CLI require the actual archive capability.
Archive never executes or terminates a linked conversation and upgrades never
rewrite old columns or migration history. Rollback uses the strict declared-v5
reader and retains subsequent data. See docs/tasks-model.md.

The Simplified Chinese Sidebar conversation-list heading is “协同对话”, scoped to sidebar.conversations; list grouping, filters and other conversation terminology are unaffected.


## Tasks first snapshot boundary

Only a successful authority snapshot permits task counts and empty states.
Cold capability/list reads show static geometry in the current Board/List mode;
cold failure exposes retry in the same content region. Cached refreshes keep
existing cards and references, including a successfully loaded empty list.
See [Tasks initial loading](../../docs/workbench-design-language.md#tasks-initial-loading).


## Tasks first-round research disposition

AI research triage is a task property independent of workflow, assignment and
conversation execution. One authority event projection feeds card/list summaries,
filters and the existing editor draft. An unassessed default is distinct from
missing context or a pending human decision. Assessment changes never create a
conversation, claim a research result or start decision-wait timing. Capability
absence hides unsupported controls; saved rationale and disposition survive
legacy edits and view changes. See docs/tasks-model.md.


## Tasks morning overview

Morning overview is a read-only projection of the task controller snapshot, with explicit metric and waiting-time placeholders. Browse filters cannot silently narrow its whole-board triage counts. Terminal tasks are excluded from current attention groups; eligibility, workflow state and idle conversations cannot substitute for completed work or a decision-ready handoff. The entry/back controls preserve mounted browse state, scroll, editor drafts and focus. Existing detail/refresh commands retain their owners; no additional task store, mutation or scheduling is introduced.

- Morning research overview excludes context requests/unassessed items. Only an
  explicit decision-ready research report in the current review round starts the
  human wait clock; strict >72h highlights are ordered longest first. Ordinary
  progress, triage and task timestamps cannot establish/reset that clock. Leaving
  review ends the round; unknown history stays unknown. The morning view is read-only.

### AI follow-up cards and Morning separation

AI follow-up is a peer of Board and List with Todo / Working / Needs you / In review / Ready to merge. All active tasks participate; Owner and local scope/search consistently filter every lane/count and survive route remounts within the authority/account activation. Todo is not started, Working requires an explicit execution report to claim AI activity; old business statuses stay visibly unverified. Needs you requires ready material and a specific round request. Assigned Todo/Needs you/Ready to merge show current visible-lane dwell from server activity, bounded by an optional fixed product rollout floor; Needs sorts by that same origin. Working/In review/unassigned cards show no clock. Comments/reassignment/repeated same-lane reports/new decision rounds do not reset lane dwell; state re-entry and lifecycle boundaries do. Stale/failed/incomplete history has no inferred clock. Original decision-round timestamps remain separate. Judge and Owner are distinct. Ready requires a compatible explicit recorded fact and never implies merged/deployed. Cards provide readable titles, a bounded decision/material summary, state/time, Owner and exact conversation navigation. Full content stays in original task activity/conversation. Semantic theme tokens, shared controls, profile avatars and Radix menus own presentation/interaction; five columns remain in one row inside a dedicated horizontal board scrollport. No simulation, synthetic task, approval/scheduling or separate writable execution state is introduced. Morning remains the separate future risk/key-exploration surface.

Cards contain no business metrics; full research output, next steps and rationale stay in the original task activity/conversation rather than card disclosures. Ordinary board browsing filters remain independent. Missing links are explicit; multiple links use the existing accessible menu. Navigation never approves or starts work. Cards use shared typography, semantic paired colors and Settings controls within the Tasks container. The Morning decision-round waiting authority and strict >72-hour threshold remain separate from card lane dwell.

## Scheduled task workbench entry

Scheduled tasks use the existing workbench tool-page declaration, Router and
shared settings controls. The application catalog projects Host summaries rather
than filtering the currently paginated conversation rows. Opening a task uses its
Host/thread identity; management reuses the existing per-conversation editor.
The catalog owns neither execution timers nor a separate draft or mutation model.

The editor retains unsaved text across polling and errors. A changed revision or
unfinished run blocks stale saves until the user cancels and reviews current Host
state; it never advances the draft revision or recreates a deleted task silently.
Expired or minute-truncated run times receive a future default when editing starts.
Known validation/conflict rejections remain distinct from unconfirmed transport results.

## Conversation task linking entrance

Existing conversations with Tasks authority expose a rounded, outlined secondary
Link tasks action immediately before overflow on desktop. Mobile Shell presents
the same action inside overflow instead; both use the original picker and fixed
conversation identity. Dismissal returns focus to the available initiating action,
including after a layout change. Shell's inert sizing and lazy fallback follow
the same mobile presentation, without reserving a hidden label slot. No Tasks
authority means no task-link entrance.

### Scheduled task creation

The catalog creates a new durable conversation without starting a Turn. A shared
utility modal owns transient draft/focus; Host schedule state and recurrence
remain authoritative. Submission disables closing and duplicate actions. A known
thread identity is reused after name/save errors; an unknown creation result is
shown for manual reconciliation, never retried automatically. Server switching
clears server-specific skills and permissions. The shared modal body scrolls while
primary and cancel actions remain reachable in short and narrow viewports.

### Board navigation copy
The Tasks application uses “看板” (English: “Board”) for its navigation label,
collapsed rail tooltip and main page heading. Board, list and follow-up remain
views within the same application; task actions keep their task terminology.

### Conversation task summary

The optional `thread-summary` trusted plugin owns a read-only projection of structured plans,
file changes and agent/command activity. `ConversationSummaryService` owns one revocable
contribution, while the Workbench owns placement, focus, modality and semantic navigation.
Unloading the plugin never ends execution, releases a conversation lease or changes history.
The existing project/working-directory information dialog remains a separate action.

The measured conversation container budgets the theme's reading width, summary width,
gap and edge inset. With a full spare gutter the card occupies that gutter without moving
the conversation; with room for both columns it reserves only the inspector's footprint;
otherwise its toolbar action opens a Radix popover. Input capability and the shared touch
preference own hit targets and modality, independently of these three space budgets.
The same compact card owns its title and grouped plan/files/background activity rows.
Its raised surface and content inset share the design-system utility-card contract with
pending MCP prompts; feature styles do not duplicate the card's radius, border or shadow.
Horizontal entry/exit and the reserved reading inset use one motion implementation,
retaining outgoing paint inertly, respecting reduced motion and interrupting on reversal.
Switching presentation preserves section disclosure/scroll state and never reparents the
conversation, composer or file viewer. View state resets on account/Host/thread scope changes.
Cached history remains readable, but cannot authorize resource or agent navigation. The panel
labels its history coverage; a completed spawn tool is never treated as agent completion.

Task summary navigation requires a real receiver/agent/state thread identity; presentation fallback IDs do not become thread links. Renamed file entries point to their new Host path.
