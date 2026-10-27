# ChatUI: Navigation and catalog

[Architecture index](../../chat-ui-architecture.md) · [Documentation index](../../README.md)

## Sidebar Goal reads on multi-engine Hosts

The catalog's Goal scheduler and activity projection check the capability for
each Thread, in addition to Host readiness and admission. A Host-level capability
does not grant every engine that feature. Unsupported Threads remain idle and
consume no read slot; they never enter the completion pump. This prevents a
no-op refresh from scheduling itself through resolved promises and starving
the browser event loop. Supported Threads retain the shared three-read limit,
connection-reset recovery and metadata-only behavior.

### Thread goals

Goal menus, dialogs, statuses, action errors and elapsed-time units consume the
existing application Intl provider and locale catalogs. Automatic mode and manual
overrides keep their current authority; switching language updates mounted
controls without resetting the objective draft. User objectives remain unchanged.


Existing Goals occupy a quiet row in the Composer's existing attached rail,
sharing its perimeter/material with the queue. The independent live file pill sits above the rail. Desktop capacity
shows status, truncated objective, compact localized elapsed time, pause/resume,
edit and an actions menu. A narrow Composer container hides the objective and
inline edit action; the same actions remain available in the menu and touch
controls retain the shared 44px minimum. A completed Goal retires from the rail immediately; its server-owned record
is retained. The Composer add menu offers a read-only completed-goal detail
(with explicit removal on writable Hosts) and, on writable Hosts, setting a new
goal. New-goal submission uses the shared resource's explicit create operation:
a fresh native read rejects an unfinished Goal, and a completed Goal is cleared
and confirmed absent before set(active, tokenBudget:null). Native set alone edits
the existing Goal and retains its usage, so it cannot create a fresh accounting
period. Pause/resume and edits continue to use set and preserve their counters.
Cancellation does not mutate the old Goal. If replacement fails after clearing,
the resource retains the last observed completion as a read-only summary, not as
current server state; the editor draft remains retryable. Explicit removal clears
that summary. It is bounded to this resource/connection, not a durable Goal history.
No completion observer clears a Goal in the background or performs writes from
sidebar hydration. Connection replacement fences the remaining create steps.
Ordinary messages and editing never implicitly reactivate a completed Goal. An
edit draft open at completion stays available but cannot save over the completed
Goal. Paused/blocked/limited Goals remain actionable in the rail.
Radix owns detail placement, outside/Escape dismissal and focus restoration;
editing retains ModalSurface and shared Buttons. Resizing/language changes do
not remount the Composer or reset an objective draft. There is no independent
floating primary-colored Goal capsule, and no-Goal consumes no rail space.
The pursuing Goal's leading Target shares the Design System's 3.2-second,
65–100% mask shimmer with the Sidebar Target. Only the glyph animates; labels,
controls and layout stay fixed. Other Goal states remain static. Reduced motion
renders the full static glyph; hidden/inert presentation pauses its animation.

Goal elapsed time decomposes full 24-hour periods into days, then remaining
hours and minutes (316 hours 36 minutes becomes `13 天 4 小时 36 分钟`).
The detail view retains full localized units; the row uses localized narrow units
for space. This changes only presentation, never the AppServer usage counter.

Sidebar Thread menus contain Thread-scoped mutations only. Creating a new task
and opening Host settings remain ordinary application navigation; neither is
advertised as a Thread menu action.

A Goal is durable Thread state owned by the execution engine. The Host declares
the supported read/write methods and usage accounting; shared UI follows those
capabilities rather than treating a Composer draft or Web timer as Goal state.

For Codex, the AppServer owns objective, status, and usage counters. Its Host
keeps a replaceable index of active Threads and owns continuation after Turn
completion, including when no browser is connected. Queued user input has
priority over autonomous continuation; continuation is serialized with other
per-Thread Host operations.

The DSH Host advertises writes only when its native Goal port is available;
otherwise it remains read-only. The native service owns mutation and durability,
and its Goal-round driver owns continuation. It declares `usageAccounting:false`,
so shared UI omits token/time metrics rather than inventing accounting. See the
[DSH Goal boundary](../../dsh-appserver-boundaries.md) for activation, restore,
and supported mutation semantics.

For SSH Codex, Goals remain native remote Thread state. The shared broker
preserves an explicit upstream Goal capability, or discovers enabled Goals
through the native feature catalog during physical initialization. It exposes
the corresponding native get/set/clear methods, retains read-only declarations,
and omits the capability when discovery fails or Goals are disabled. Reading an
existing Goal does not create, activate, or resume it. The remote Codex owns
autonomous continuation; the SSH bridge never schedules an additional Goal Turn.

Workbench Runtime owns a per-Thread Goal resource: get-on-view activation,
notification projection, revision-fenced reads, reconnect invalidation, and
single-flight writes followed by a confirming read. A failed confirmation is
not reported as success. Web owns only disclosure and an unsaved editor draft;
its card cannot schedule a Turn or become a second authority for Goal state.

The sidebar observes that same Host-scoped resource through a catalog subscription.
It hydrates at most 50 admitted catalog Threads with three concurrent metadata
reads per Host, without selecting/resuming Threads, connecting idle Hosts, polling
or mutating Goals. Runtime replacement, profile revision and authorization
changes stop queued reads. Connection reset discards every cached Goal and
rehydrates observers; native updated/cleared notifications change the icon live.
Usage-counter updates alone do not repaint rows. Failed reads preserve ordinary
activity feedback and wait for connection reset rather than retrying in a loop.
An active Goal uses the existing neutral Target glyph in the fixed activity slot,
including gaps between Turns. Navigation opening, backend waiting and errors
retain their existing indicators. Other Goal statuses and removal restore normal
feedback; this presentation does not alter unread receipts or activity grouping.
The grey Target has a low-contrast mask sweep over 3.2 seconds, retaining at least
65% opacity. It stays still in reduced motion and pauses inside hidden/inert hosts.

When a writable Thread has no goal, or a new conversation Draft targets a writable Goal Host, its creation entry is a standard item in
the Composer's Add menu, not a separate capsule above the editor. The Goal
surface supplies this action to the existing menu and retains ownership of
the editor draft and dialog. Existing goals keep their status and progress
surface. Confirming a new Draft Goal uses native `thread/start` followed by
`thread/goal/set` with active status, without a preliminary user Turn. Application
commands retain the created Thread receipt across confirmation/navigation failures;
retries first read the durable Goal and never reactivate an already completed Goal.
The ordinary Composer input stays in its original Draft. Cancel allocates nothing.
Host/workspace/account/navigation changes revoke late creation and navigation;
confirmation of an already accepted Goal cannot pull the user back to its page.
Read-only or unavailable Hosts do not advertise creation; switching
Threads resets the local editor without remounting the Composer. Menu actions
can supply a scope-fenced continuation to the Add menu's close callback: Radix
finishes its focus cleanup before a target dialog opens, rather than racing two
focus scopes or relying on an arbitrary delay.


## Product Thread badge slot

The Shell offers one trusted `threadBadge` contribution. Its React contract supplies
Host/Thread identity, portal root and controlled Popover state; enterprise identity owns the circular
participant badge and data reads. The badge is a sibling of the Thread navigation
button. Sidebar owns exclusivity across participant Popovers and existing context/
dropdown menus, clears state on selection/hidden-row/unload, and prevents a retired
Popover from restoring focus into a newer one. Escape retains normal focus return.
No enterprise identity-specific query, count, identity or badge styling belongs to Sidebar.

Chinese emphasis uses the standard Marked tokenizer first. If it rejects an asterisk delimiter at a Han/punctuation boundary, the compiler retries with a length-preserving delimiter mask and a relaxed Han opener boundary. This preserves canonical source, code/escape masking and standard English/underscore behavior.


Mobile Web Composer ordinary Return inserts a paragraph on coarse primary-pointer devices, including iOS native paragraph changes routed back through ProseMirror Enter. Suggestion, code and list commands keep their own precedence. Desktop Enter and explicit Ctrl/Cmd+Enter submissions remain available. Standalone and the downstream product embedded Composer consume the same placeholder message IDs: new conversations use `chat.companionPlaceholder`, and follow-ups use `chat.companionFollowupPlaceholder`.

Standalone and embedded Web entry points share one minimum Composer editing height: 64px for desktop viewports (at least 768px), and 48px below that breakpoint regardless of pointer type. This applies to new-thread and narrower panel containers; embedded styles do not override the height. Document growth and the scroll cap retain their existing behavior.

Sidebar omits inline Server-origin marks; the Server filter and complete row tooltip retain provenance. Project names use independent complete badges.

## Sidebar catalog lifecycle and row metadata

A transport-successful catalog can still report a failed refresh through
`cachedAt`, while retaining the last successful directory. Sidebar keeps those
rows and presents its existing saved-conversations message and Host-scoped Retry
for ready or failed reads. An in-flight refresh stays quiet, including when it
retains that metadata; successful authoritative refresh removes the failure.
Retry never selects a Thread, broadens the Server filter or replaces row owners.

The application subscribes to native Thread lifecycle events per client lease.
Catalog notifications cancel older catalog reads, including an unresolved first
fetch, before updating existing rows with `thread/status/changed` or `turn/started`.
Both paged and sidebar caches receive the same status, scoped to their Host.
The shared Thread query prefix is heterogeneous: archived settings hold a bare
array, not a catalog page. The notification owner patches only page-shaped
projections and preserves other cache values/identities for ordinary invalidation;
a non-page projection cannot throw and poison subsequent notification ordering.
A fresh invalidation then reconciles metadata; it does not serialize subsequent
events behind network latency. Disposal fences queued callbacks. Neither unknown
rows nor selected-route execution state are invented to force a group placement.
Running precedes attention, pins and recent in the existing task-flow projection.

The row container paints one continuous selected/hover background across title,
project, status, participants and actions. Server marks are omitted; provenance
continues to own server filters and tooltips. A leading project badge reserves its natural width before title ellipsis, capped
at 35% of the row and 112px. Labels never wrap; exceptionally long names ellipsize,
with complete project text retained in the row tooltip. The server filter reuses the display-mode radio indicator column. Unread receipts remain participant-only, rendered as a muted 5px gray dot; running/wait/error indicators remain visible. Account-bound receipts use the fixed server authority described in [platform architecture](../platform/identity-and-access.md#account-read-receipt-authority); local storage is a cache/outbox and migration source. Account changes fence stale receipts; reading one exact Turn does not acknowledge later replies. Foreground devices converge on focus/online/visible recovery or the15-second refresh, including fresh browsers.

`smoke:thread-management` mounts the actual Sidebar and verifies that rename
draft/focus and held fork state survive task-flow regrouping. Its desktop/touch
and light/dark matrix covers independent menu hit targets, capability filtering,
navigation/current-row semantics, stable status geometry and input-specific hover
behavior. Action RPCs are synthetic. These observable checks replace JSX/SCSS
spelling assertions in `tests/shell/sidebar-activity.test.ts`; pure grouping, metadata
and stale-menu-close behavior remain covered by that unit suite.


## Navigation preview author

Conversation navigation previews carry optional MessageSender provenance from the exact projected user message. A Turn marker continues to address its first prompt; another participant steering that Turn does not replace its author. The Web hover/focus card resolves this identity through IdentityAvatarContext and renders AvatarImage in a fixed 20px slot before the prompt. Missing photos use the shared fallback; absent provenance omits the slot. No viewer/Turn-owner inference or separate identity request is introduced; lazy hydration and generation fences retain ownership.

### Sidebar directory track bounds

The directory and nested groups own a bounded single grid column. A long project
name or saved-directory failure message cannot enlarge the track past the actual
Sidebar viewport or clip its Retry button. Existing truncation and action slots
remain responsible for content; this does not change Shell width, mobile drawer
preferences, selection, grouping or refresh semantics.


### Sidebar action target lifetime

Sidebar owns rename/delete modal lifetime against the complete authoritative
Host/Thread directory. When that exact pair disappears, dismiss the modal without
submitting an action. Another Host with the same Thread ID does not retain it.
Filtering, pagination and task-flow regrouping only change row presentation and
retain valid modal drafts/focus; cached refresh rows remain authoritative inputs
until the directory actually replaces them. Action state stays above row owners.

### Conversation group heading continuity

Creator-group headings retain the existing avatar slot and generic person fallback
when their contribution has no photo. Loading, unknown or unavailable creator
metadata therefore preserves label alignment with known creators. Ordinary task
flow headings retain their text-only layout. Both disclosure presentations bind
aria-controls to their own stable list element and keep aria-expanded and hidden
in step with the existing collapse owner; metadata updates do not replace rows.

### Conversation list display context

Right-clicking the conversation group heading or list background, and a touch
long press in that area, open the existing display-mode menu. This entrance
uses the original Radix context-menu behavior and existing mode contribution.
It shares the Sidebar's exclusive overlay owner with Filters, row actions and
participant popovers, while subscribing only to its own menu channel. Row
context events remain row actions; a late close from any previous entrance
cannot dismiss its replacement. Opening a menu changes neither grouping nor
selection and must not rebuild the catalog or turn a long press into collapse.

The list context entrance retains the original modal Radix behavior: a touch
release after long press cannot activate the underlying group disclosure.
Outside controls resume after dismissal; explicit menu handoffs keep the
existing single owner and scoped close callbacks.

The nearest sidebar row context trigger owns its pointer gesture, so the enclosing list trigger cannot arm a competing long press. When a touch context menu is open, its trigger consumes the release click before it reaches a disclosure or conversation selection. Ordinary taps, keyboard activation and existing desktop menu modality remain unchanged. Native held/released row and heading gestures are covered by the complete sidebar menu regression.

The row context menu uses Radix modal behavior for a touch gesture so releasing
the original row cannot dismiss its menu or select the conversation underneath.
The pointer modality is captured by the existing row trigger; mouse context menus
retain nonmodal behavior and the same scoped close/focus ownership.

User and assistant message footer clocks are visible at rest for touch input through the shared coarse-pointer/no-hover/current-touch policy. Desktop pointer clocks remain hidden at rest and reveal on existing message hover/focus. Keep time metadata, slot geometry, history cache and action-button availability; elapsed work duration is separate.


### Personal header ToolbarDock

Feature action descriptors own stable identity, label, availability and the one business handler. Shell measures available context space and reserves title/mandatory controls before selecting capacity, including tablet touch density; phone presentation always uses overflow. ToolbarDock owns icon projection, overflow and personal drag customization, using UiPreferencesRuntime scoped to account and dock identity. The inert header twin uses the same projection; available-space changes do not erase personal intent or remount business dialogs. Failed persistence is reported. Dialog return focus falls back to visible overflow if the invoking icon has folded away.

Customization drag keeps the source slot in layout and paints a noninteractive, unscaled DragOverlay in the presentation root outside modal transforms/clipping. The active source never uses another list's sortable transform. Pointer hit testing first selects a zone, then its rows; nonempty parent zones do not compete with their children. Keyboard targets rows or empty zones. Draft membership changes only on drop, cancellation leaves it unchanged, and release has no source-return animation.


## Optional conversation summary

`packages/workbench-panels-react` provides `ConversationSummaryService`, a single trusted
renderer contribution with fiber-scoped registration/disposal. The built-in
`plugins/thread-summary` consumes its public readonly context rather than application internals.
`createWebWorkbenchApplication({threadSummary: false})` omits this module and its entry point.
The host projects the displayed timeline and the existing goal resource, scopes view state by
account/Host/thread, and supplies guarded semantic open-resource/open-thread callbacks.
It owns actual-container layout, the toolbar and existing Radix ModalSurface; the plugin owns
section content and typography. No additional subscription, summary model service, execution
owner, persistence store or inference request is introduced. History may be partial; only
structured plan/file records and explicit agent states contribute. Terminal completion never
implies completion of a background process. Desktop and narrow presentation reuse the same
controlled disclosure/scroll state while the conversation DOM stays mounted.

The summary is a compact utility list. File rows use shared document/code glyphs,
single-line names with a retained extension, and quiet A/M/D markers only when
structured history supplies a known change kind. A shared directory is shown once;
remaining relative directories distinguish equal names. Full original paths remain
in tooltips and resource callbacks. The presentation does not resolve filesystem
paths or infer a workspace root. Keyboard focus and touch targets remain available
in the floating panel and adaptive sheet, including read-only history.
