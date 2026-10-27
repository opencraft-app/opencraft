# Platform: Identity and access

[Architecture index](../../platform-architecture.md) · [Documentation index](../../README.md)

### Shared-origin relay server context

An optional relay entry selects an independently authorized installation and
encodes its stable instance ID in the URL. The relay owns discovery and verified
identity handoff; each target core owns membership and administrator decisions.
The browser deployment context owns the target URL prefix, Router basename and
installation storage namespace. HTTP/WS ports consume it explicitly; plugins
receive a fetch port and contain no relay-path or company deployment assumptions.
Changing the browser choice creates a new page lifetime, without transferring
permissions or cancelling server execution. Per-identity remembered selection is
a navigation preference, never an authorization credential. See
[shared entry selection](../../relay-deployment.md#shared-entry-server-selection) for
configuration, cookie handling, rollout and the shared-origin trust boundary.

### Account read receipt authority

Read state is account data, not an installation UI preference. `ThreadAttention`
tracks exact Host/Thread/Turn receipts: reading an old Turn never reads a newer
result. `PlatformAccountContribution.readReceipts` optionally binds the verified
account to an append/union persistence port. The fixed installation backend owns
the database independently of selected execution Host, engine and browser.

For enterprise identity, each read/write request verifies the gateway identity; the server derives
the account key. `x-opencraft-read-scope` only rejects account-switch races and
cannot select another account. JSON-only same-origin writes reject foreign
origins, cross-site requests, malformed tuples and oversized bodies. The service
stores bounded exact receipts with existing managed SQLite document migrations
and CAS union, never client whole-document replacement. Future formats fail closed.

`BrowserThreadAttention` owns hydration, optimistic acknowledgements, legacy local
receipt union import and a scoped cache/outbox. Browser persistence is not the
account authority. Unchanged receipt unions neither write storage nor publish a
new snapshot; failed storage writes remain retryable. Visible 15-second remote
synchronization is retained for cross-device read-state freshness, not presented
as eliminated network work. Confirmed remote receipts merge without clearing concurrent
local reads. Failed/unknown writes remain retryable across browser reload; a later
read recognizes already-committed writes. Account/provider replacement and disposal
abort/fence late results. Initial hydration avoids flashing cached unread dots;
a failed first read retains local/offline behavior and subsequent retries.
Foreground accounts synchronize every15 seconds and immediately on focus, online
and visible recovery; background pages catch up on return. This is bounded polling,
not server Push. Clients without an account persistence contribution retain their
local adapter; no remote capability is implied for those products.

### Authentication ownership

Trusted product assembly can contribute an external identity provider and an
account entrance without changing core Actor, membership or resource authority.
A branding-only client product can omit `ClientProductSession.persistenceScope`;
the application then owns `LocalClientPersistenceScope`, using the active account
contribution to partition caches and revoke old writes on identity changes.
Products with credential-incarnation semantics can still supply their own port.
Account contributions have explicit presentation precedence (`entrancePriority`,
default 0); equal priorities remain exclusive, and unloading a contribution
restores the next eligible entrance. A provider omits `signOut` when its gateway
has no logout operation. It owns credential verification and expiry; browser
projections are memory-only and generation-fenced. Recognition does not authorize
shared resources. Verified message provenance is owned by the Hub, not the Turn
or Renderer. Codex, SSH and the built-in DSH path share `ThreadIdentity`, the
immutable sender store, message projection and bounded native-history reader. The Web gateway derives a trusted connection context from signed
WebSocket handshake headers; AppHost passes it through an in-process submission
port. Each user message is keyed by stable Host + Thread + client message ID.
Only the English login name is persisted. Codex/SSH retain the existing Host queue
SQLite and transaction owner; queue admission and provenance share a transaction.
For DSH, the Headless `/appserver` identity overlay owns a separate managed
`thread-identities/opencraft-server/thread-identity.sqlite` v1 under the Hub data
root. It records attribution and derived provider metadata, never message bodies or
execution state, and does not open the independent Host stores. Native messages
remain the evidence for participation; queued or rejected submissions do not count.
The shared identity reader traverses at most 100 Turn summaries per page to
recover native user-message IDs, excluding tool bodies. Full reconciliation
preserves chronological order; a Turn-scoped read searches recent summaries and
stops at that Turn. Background catalog reconciliation must not download full
Item histories onto the same transport used by interactive sessions.
The overlay resolves the current native address for its read-only history client;
retiring browser clients or the Hub does not stop the independent DSH Host. Queue dispatch never reattributes
the original submitter. History/live/shared Chat projection carry hidden sender
metadata; the native model input remains free of employee provenance.
Forked history preserves immutable author attribution separately from membership:
the Host records inherited message origins atomically with cloned sender bindings,
and exposes an optional inherited-message query to its metadata provider. A product
participant projection can exclude inherited messages. Origin records survive restart and nested
forks in the same Host-state database (additive migration v4).
See [external identity and provenance](../../enterprise-authentication.md).

The hostless and configured-Host Application supervisors share one explicit
service-disposal plan, including the client extension persistence backend and
account draft-scope subscription. Mode-specific navigation/conversation/Host
consumers retire before that shared plan; Host registry leases return before
extension provider cleanup, and owned AppHost transports close after services
using them. The outer Web Application and Supervisor both share one disposal
completion/failure among concurrent or later callers. Every cleanup step runs
even when an earlier disposer fails. Closing the IndexedDB connection and its
BroadcastChannel preserves document data for the next Application.

Startup rollback remains a reverse list of resources actually acquired; it is
not the complete-graph shutdown plan. Automatic reverse-construction cleanup
cannot replace the explicit normal consumer/provider order. Actual browser
coverage in `smoke:application:lifetime` checks both modes, held/failing extension
cleanup, retained data with stale old handles, and storage failure during startup.
It covers default public startup and an explicitly supplied local product, checking
that product teardown waits for its extensions and cache subscribers. The public
`smoke:extensions:builtin` and `smoke:plugin-settings` probes use that same synthetic
composition through `ClientWorkbenchProduct`, without a private account service or
product package. They exercise real extension management, navigation, persisted
enablement, protected bundled sources and Settings in Chromium.
Its configured Host wire deliberately rejects requests; this is not a connected
external Host or native-client acceptance result.

`smoke:hub-network` separately packages a local gateway with the trusted Relay
identity composition port. Its test-only credential adapter is not selected by
the public Relay entry. A second Relay runs the ordinary public artifact without
an identity provider. Real Chromium exercises login handoff across two TLS Hub
hops, anonymous rejection, target membership and revocation; private identity
services are not prerequisites. Run `build:relay` before this transport probe.

The application supervisor installs two renderer-neutral Cordis services before
activating extensions, and disposes them with the application (including startup
rollback). They are not per-Host, per-Conversation or per-React-View state:

- `authentication` registers provider-owned session/operation ports by activation
  owner through `authenticationProvider`. It validates explicit completion against
  the current session epoch and serializes cancellation before a replacement login.
  Providers retain credential storage, OAuth exchange, restore, logout and expiry.
  Neither this service nor the public View capability receives tokens.
- `authenticationFlows` owns the active interactive flow ID, feature lease, reason,
  presentation, pending/error state and result. Identity/profile changes are not
  login completion; a same-account reauthentication still has its own completion.
  Restore never opens a flow. Close/cancel retires its transaction; route departure
  or inline View disposal abandons only continuation. A valid late callback may
  update session truth but cannot close newer UI, navigate, or invoke feature writes.

The anonymous footer projects provider-owned `signInOptions` as one Radix menu,
using the shared menu theme and keyboard/focus primitives. Selecting an option
closes the menu and directly submits a `presentation: menu` flow; no intermediate
login dialog is mounted. Only the provider interprets/validates its opaque
`optionId` and selects a region, after any prior native cancellation has retired.
The footer reflects pending/error state; reopening its menu exposes retry/cancel.
Closing just the menu never cancels an already selected browser login. The same
content works in fixed/floating Sidecars, with its portal inside its owning footer.

For explicit reauthentication/other contributed surfaces the shared Shell projection
can render `signInViewId` separately from `viewId` (Account).
Matching login success dismisses only its own prompt; Account remains an explicitly
opened utility view. Views receive only `AuthenticationFlowPort`, not Cordis Context.
Inline environment login is owned by its form lease: authentication allows the
form to recheck prerequisites, and creation still requires explicit confirmation.
No flow persists callbacks, arbitrary URLs or privileged continuation commands.

the downstream product exposes `snapshot.session` (status + auth epoch) separately from its
legacy `phase` (Bot-catalog loading/error compatibility for existing Host consumers)
and `details.phase` (profile/entitlements). Shell identity, login, and environment
discovery consume session truth. A resource 5xx never logs out or invalidates a
successful login. Authoritative 401 is handled centrally with an epoch/abort fence;
old requests cannot clear a newer session. Account changes clear old details before
new data loads, and profile mutations are fenced after their asynchronous boundary.

Downstream Hermes diagnostic/reset commands belong to the engine command service,
not the product account service. The Hermes extension creates that command service and
borrows the Application's account plus its exact-bound AppServer registry. Each
activation owns a fresh command lifetime: unloading Hermes revokes its commands
without closing a borrowed account. A standalone definition creates its owned
account/cache and associated views inside activation, so re-enabling never reuses
closed resources. The account issues revocable request scopes without exposing tokens; JSON/native
account transport and browser command HTTP retain their existing platform paths.
An explicit sign-out rejects new command scopes, a current HTTP 401 retires the
shared session, and an old 401 cannot clear a replacement epoch. Stream and native
output callbacks stop when the borrowed scope is revoked, including transports
that ignore cancellation. This does not prove the remote command has terminated.
Native acceptance still forbids HTTP replay on failure. Existing HTTP business
failure details and SSE terminal/output semantics remain Hermes-owned. Unused
account WhatsApp wrappers and the duplicate runtime command port are removed;
actual WhatsApp features continue to use their Host protocol service.

Account content composes shared utility-window controls: SettingsPanel owns its
header/body/footer tracks; plain SettingsGroup/Row own compact alignment;
editable text uses Radix Popover, while the host Radix Dialog owns modality and
restores focus. Avatar editing, clipboard feedback and the semantic usage meter
are reusable renderer controls. The account feature retains profile mutations,
credit interpretation and regional billing URLs. Subscription management and
entitlement recovery open `/account/billing` on the signed-in region’s public
site, as selected by that product's account configuration; the legacy
`/account?tab=billing` URL is not used. Utility modal appearance is
theme-owned and content-sized, with no account-specific fixed canvas. Warning,
error, usage-track, utility-shadow and scrim colors are emitted by the theme
engine, not hard-coded in account CSS. Returning from external billing refreshes
account details; model configuration uses the host's settings navigation.

Downstream desktop login is selected through paired trusted local Main/Preload
entries; the public desktop does not create a private account. Core owns profile,
window, protocol and IPC admission. The product owns random state, PKCE, timeout,
cancellation, single-use exchange and its per-profile application-owned private
file session storage (not OS encryption). See [desktop product composition](../../desktop-product-composition.md).
Only the trusted
top-level renderer may invoke the narrow preload account port. A callback received
by another profile is forwarded to its live owner through a state-addressed local
socket; the socket carries only the one-time callback and is retired on completion.
Renderer credentials stay in memory; ordinary preferences remain origin-local.
Web retains its browser-navigation PKCE path. Remote login pages never replace the
desktop workbench or receive desktop IPC capabilities. Closing/reloading the
initiating renderer cancels its pending transaction; late callbacks cannot log in.
Authenticated account/control-plane reads and updates use a Main-owned HTTP port,
restricted to the saved session's regional authority and known account, instance
listing, enterprise service-session and configuration endpoints. Main attaches the credential;
renderer-supplied destinations cannot turn it into a general proxy. This avoids
depending on production Web CORS rules for random desktop loopback origins.

The Shell's Sidecar owns the application/account split entrance as its footer,
not as a window-wide bottom bar. Pinning changes content placement, never the
entrance's parent or local anchor while its owner remains visible. Closing all
Sidecar columns hides the footer too; a transient sidebar supplies its own footer.
The footer owns a non-shrinking layout row below the flexing pane viewport; it is
not a zero-height absolute overlay. Scrollable navigation is constrained above
that row even with docked DevTools or long lists. Floating sidebars use the same
content/footer ownership split. The entrance is locally anchored within this row.
Sidecar paints one continuous material plane behind both panes and the footer.
There is no edge gradient. Header projects the main surface's upper lip from
the same live primary/context frames and context visibility progress, moving
left across the compact rail without waiting for the context owner to unmount.
Its horizontal hairline and Sidecar's vertical divider share the same paint
progress. No independent CSS animation or terminal boolean controls painting.
Content lifetime still belongs to the physical pane exit owner.
Expanded/context materials remain unchanged. The adjacent main surface keeps
its theme-owned stroke/elevation, including soft and flat variants; titlebar
paint must not override it. Floating overlays keep their own elevation.
This is paint-only: pane geometry, resize targets, content identity and focus
ownership do not change. See `docs/workbench-design-language.md`.
Those children do not paint additional backgrounds or stack backdrop filters:
this avoids both a white entrance strip and exposed gray window material under
the neighboring context pane. Floating footer rows inherit their owner's surface.
The compact left square opens application navigation;
the right entrance fills the remaining first-rail width and opens account content.
The group uses coordinates anchored to the Sidecar's left/bottom origin. Compact,
hidden and pane-divider transitions never change either entrance's parent, left
column origin, vertical position or square application frame; only the account
entrance's trailing space may flex. Each content surface has an independent
pin preference, while at most one transient surface is open. Application
navigation is a vertical list of existing contributions; overlapping icons are
only an entrance preview, not a second navigation model.

The application entrance directly toggles its dock on wide screens. It never
opens an intermediate application menu or asks the user to keep it in the sidebar.
On compact screens the same action toggles a Sidecar-shaped drawer, preserving the
wide-screen preference. Account retains its independent menu and optional pin.
`aria-expanded`/pressed feedback for applications reflects current presentation,
not a suspended wide-screen pin. Radix still owns drawer dismissal and focus.

Environment discovery lives in `workbench-runtime/src/environment-directory`,
owned by the Cordis `environmentDirectory` service. Configured local/manual
profiles and trusted provider sources feed one directory. Entries are lazy
connection recipes, not connected Hosts: cloud lifecycle, source freshness and
transport phase remain separate. Provider-managed entries carry a typed
`MachineResourceLifecycle` with canonical and raw phases plus explicit action
capabilities; configured Local/manual Hosts carry `resource: null`. Resource
actions route only through the owning source, require a caller operation ID and
fail closed when either capability or handler is absent. `provisionHost()` still
persists a connection recipe and never means cloud allocation. the downstream product discovery lives in its plugin's
`environment-directory` folder and binds identity to region, account and instance.
It lists non-running states, paginates with generation fences, and clears entries
on sign-out. Explicit saved bindings preserve Host IDs; unbound legacy profiles
are not silently reassigned. Environment and Chat share an ephemeral profile
projection; discovery registers factories without connecting or changing the
active conversation. Passive Chat queries only connected/auto-connect Hosts.
New instance creation refreshes this same source, not a second profile registry.
The new-thread Host dot observes the selected Host runtime connection directly;
View/task activation errors never recolor it. Cloud resource phases
appear as secondary machine copy and cannot replace connection status.

There is exactly one Sidecar. It composes a primary application `SidecarPane`, an
optional contextual `SidecarPane`, and one Footer; the panes are not independent
sidebars. Each Pane separates layout from visibility: normal pointer resizing
changes the live layout width in both directions, and Frame and Viewport consume
that same width. Clip is only ink containment for explicit visibility/detent
transitions, not a way to freeze content during ordinary contraction.
Feature code provides only pane content. It does not own clipping,
opacity, mounting, dividers, Footer placement or numeric stacking levels. The
visual three-column layout is `Sidecar(primary + optional context) + main`; two-
column and immersive layouts are projections of those same slots.

`useContextPaneGeometry` owns one live MotionValue, shared by contextual frame
and viewport (not two independently writable values). Its projection enforces
`viewport = frame = live layout width` during normal drag, including contraction
and reversal. The committed width is only a persistence/rollback value. Release
updates that preference without deferred reflow. Explicit visibility progress
may clip the live layout on open/close without becoming its width authority.
AppShell dispatches preview/settle/synchronize operations. External preference synchronization runs
after dock and floating readers subscribe, so transforms cannot miss the write.
Floating presentation consumes the same viewport with its window-space cap.
Validation samples held-pointer frames, actual environment control containment,
contraction/reversal, no-jump release and cancellation/capture loss. A test that
accepts a wider frozen viewport during contraction encodes the wrong contract.

Docked and floating presentations share the same `SharedSidebarContent` owner:
primary navigation, context and footer each have one stable React portal and DOM
container. The presentation surfaces supply mount slots only. Reparenting retains
component state, scroll receipts and eligible keyboard focus instead of recreating
the conversation/settings tree. The floating surface budgets primary plus context
against its own viewport rectangle; it can project compact icons without losing
application actions or overwriting saved widths. Its Applications entrance changes
the in-overlay rail (or opens the existing drawer on very narrow widths), never
implicitly docks the entire Sidecar. Docking remains a separate header action.
Escape/outside dismissal retires both explicit peek and pointer-hover intent.
While floating, AppShell owns a transparent outside hit surface behind the
sidebar and above the conversation. Its pointer hit testing explicitly overrides
the non-interactive overlay host so blank-space taps reach it. A tap dismisses the transient presentation
without dispatching the same activation to the covered conversation; it does
not change the saved dock intent. Because this hit surface covers the viewport,
its touch highlight must remain transparent rather than flashing the whole
screen. Touch movement does not acquire hover intent.
Dismissal changes the requested presentation first, but the floating panel
continues to own its shared content, navigation projection and outside hit
surface until its exit animation completes. Only then may those portals move
back to the docked slots. Docking is a separate transaction and transfers the
owner immediately because the floating presence owner itself is removed.

The primary pane has three semantic detents: `expanded`, `compact` and `hidden`.
Expanded width remains a separately persisted preference; compact is
a 52px icon projection, not an overwritten width preference, and hidden only
changes pane visibility; it never clears application/account Pin preferences.
Pointer down creates a Web-owned resize transaction that snapshots the semantic
detent and live physical width, including takeover of a running settle animation.
The old animation must be stopped before reading that origin: stop can flush its
final value, so capturing first can leave a stale pointer baseline.
Pointer move directly updates live geometry and an adjacent candidate detent;
there is no spring chase of the pointer. Primary viewport is derived from that
frame: it equals the frame in the expanded range and uses only the expanded
minimum as a layout floor in the compact/hidden transition. One frame animation
drives detent settlement; viewport has no independent animation/writer.
Pointer up commits the candidate; cancel restores the saved target. Lost pointer
capture cancels once and foreign pointer events cannot drive the transaction.
Dock availability, persistence and
the renderer-free reducer cannot observe intermediate pointer positions. Keyboard
actions traverse the same adjacent state machine.

`SidecarPane` also defines the content-sizing contract: its direct feature child
stretches to the complete Viewport width. Settings, conversations and
extension navigation provide content only; they may not retain an intrinsic
route-era width inside a wider platform pane. This is why Settings replaces the
context slot without leaving an unowned blank strip.

The global Header is not a Sidecar pane child and never consumes the primary
detent. The shared Sidecar trigger and history controls remain a complete
window-chrome group at every detent; when the Sidebar is collapsed, the
persistent Header also shows Write. The separator between primary and context
panes begins below that Header and terminates above the Footer; it has no authority
over either fixed region.

`workbenchWindowMetrics` is the shared native/renderer window-size authority.
The primary desktop window may shrink to 480px, matching the main content
reserve and the shared Workbench window contract. At that width the Shell
uses its immersive fallback: application navigation, context and right tools
are temporarily hidden without changing their saved open/Pin/width intent.
Electron Main must consume this metric rather than maintaining a larger
platform-local minimum. The 760px value used by Settings is a content maximum,
not a minimum window width.

The main Web/Electron Workbench uses a unified sidebar topology. One physical
left pane contains a 60px desktop icon rail for Start/conversation/extension destinations,
the current application context in the adjacent list column, and Settings/account
at the bottom of that rail in normal flow. Chat supplies the conversation list; device Settings supplies its
category index; extension pages may omit context without adding a second
navigation column. These destinations use the actual application router and
extension projection. Start invokes the shared new-task action; there is no
second Start row in the conversation list.

`ShellNavigationConfig.layout=unified` selects this presentation in App. The
shared `shell-navigation` projection excludes the former application rail from
its geometry and docking decisions. Old application/account pins and compact
rail preferences do not resurrect it and are not rewritten. There is no
Applications drawer, rail Pin action or separate application resize handle in
the main Workbench. Other explicit renderer presentations retain their existing
contracts; an embedded shell without global navigation is unaffected.

The unified sidebar has one saved width (default 335px, minimum 300px, maximum 520px) and
one open/closed intent. Frame tokens add the 60px rail to the former 275px default
and 240px minimum list budget; legacy stored widths clamp to the new minimum.
Unsaved preferences use the new default, while non-unified presentations retain
their former widths. Its existing context resize transaction owns live frame
and viewport width; all nested destination/context slots follow the same value
while the pointer is held. Visibility clipping is separate and retains content
through exit. Header, main and right-tool geometry consume that single animated
left width. Neither the sidebar nor its presentation owns Host/Thread lifetimes.
Built-in contribution IDs select localized full names and compact rail labels;
the label projection does not create another navigation authority. Thread row
menus and the enterprise identity anonymous entrance use the same Intl runtime. The existing
four locale catalogs carry this sidebar copy without expanding standalone
language selection. Mode radio/checkbox menus share a reserved indicator column.
Touch row density uses the existing control hit minimum: single-line rows are
max(32px, hit minimum), two-line rows at least max(48px, hit minimum + 12px).

`shell-space` arbitrates the complete window budget: the desktop main reserves
480px, and ordinary right tools reserve at least 320px. Under pressure the tools
are suspended, then the whole sidebar becomes floating; there is no independent
compact application rail. The existing 32px restoration margin avoids breakpoint
chatter for automatic resize recovery. Explicit expand clears that resize history,
so a user's restore command works inside the 32px band. Saved width and visibility
intent are not resize output. Unified Shell has two explicit interaction modes:
desktop dock open/closed, or small-screen drawer open/closed. Mouse hover on the
closed entrance or window edge never acquires a unified sidebar. One Shell command
resolver handles button and Cmd/Ctrl+B; App does not register a competing sidebar
shortcut. Header and drawer controls consume that owner. The small-screen drawer
uses the existing floating owner, dismissible with Escape or an outside click.
In narrow browsers the sidebar is the stationary rear layer: the same gesture
progress moves the foreground page and restores sidebar scale/opacity in place.
Reduced motion keeps the rear layer at full size and opacity; no second timer,
blur or conversation clone participates in the depth effect.
An explicitly opened drawer transfers to the desktop dock when capacity returns;
its transient request cannot keep a desktop floating presentation alive. Choosing a global destination or Settings from
the floating sidebar dismisses it. Revealing suppressed tools uses full width.

Fixed and floating sidebars provide rail/list-column destination/context
slots for the same `SharedSidebarContent` portals. Moving these slots preserves
the DOM, filter, expanded sections, scroll and necessary focus. The footer occupies
the rail column, with square Settings and account entrances;
account menus remain Radix surfaces. In the existing mobile drawer presentation
(`AppShell.mobileSidebarEnabled`), the same portal slots share a full-width native
scrollport for application destinations and conversation context. Only Start is
sticky; other destinations, search and participation/server filters scroll away.
Settings and the named account occupy a separate fixed bottom track. The mobile
stylesheet owns that projection; desktop retains its quiet vertical icon rail
and fixed list controls. Existing portal/action/filter owners survive resizing.
No new breakpoint, action/state model, saved width or dock/resize policy is
introduced. Controls consume shared navigation and sidebar-entrance treatments. Anonymous use and account-provider behavior remain unchanged.

Mobile page-stack motion keeps per-frame progress in MotionValues. The foreground
edge directly consumes derived logical corner radii with the theme radius token;
an inherited animated CSS progress variable must not invalidate unrelated
conversation descendants. Both translated edges still share the same progress,
and this paint boundary does not change gesture, DOM or scroll ownership.

Desktop destination buttons show icons only; accessible labels and Radix tooltips
retain their names. The common Header owns the standalone managed site mascot/wordmark
and trailing sidebar toggle on conversation, task, settings and collapsed routes.
The measured brand region uses the default sidebar width capped by viewport
space; it is independent of whether a route supplies context. History arrows
are omitted from browser/Electron policies while router history remains intact.
A rounded content corner starts below the toolbar on the context column, or on
the main frame for a context-free route. Management views own their page titles,
so the shared Header omits duplicate management titles.

The browser Header does not reserve a separate Home button. The sidebar's global
Start owns new tasks while expanded; collapsed persistent Headers show Write
after the sidebar trigger. The off-layout Header clone measures the same action
count and geometry as the visible rail. Thread-edge header eligibility consumes
Shell width minus live right-panel width; left animation is not its input.

The single `leftPanelSlot` topology integrates the existing router, extensions,
space budget and account providers without another sidebar business model. Expo
keeps its existing native shell; this Web/Electron renderer change does not
establish native parity.

### Authenticated application manifest

Application branding owns both the initial Vite HTML and runtime document links.
A manifest link sets `crossorigin="use-credentials"` before insertion, including
for same-origin assets, so cookie-authenticated deployments can retrieve their
install metadata without a login redirect. Other brand links retain their own
fetch semantics; validated same-origin asset URLs remain mandatory.

Manifest publication is opt-in through the product descriptor's `manifestUrl`.
The managed site currently omits it: both initial HTML and runtime branding emit no manifest
link, while title, favicon, touch icon and public share metadata remain active.
Legacy static manifest/icon files remain available for existing pages; absence
of a link does not clear browser data, unregister workers or uninstall an app.
The platform's optional credentialed-manifest support remains available to
other product descriptors. This opt-out is independent of browser storage
failure recovery and is not evidence that a manifest caused a storage timeout.

Conversation headers expose capability-gated rename in standalone as well as embedded layouts. The same Host/Thread title writer owns persistence; Escape cancels, Enter saves, and failures use shared nonblocking notices. The pencil remains reachable for touch.
Sidebar pending/running/Goal/review/error/unread activities share the single trailing action lane. Content has body and participant tracks only, releasing the former18px status track and4px gap. One activity renderer supplies accessible state and the menu description; error/review/unread dots use the same5px neutral gray. Desktop shows activity until menu hover/focus/open; touch keeps activity beside actionable dots inside the existing44px target, including while open. Existing Radix owns actions; rows without actions keep activity in that lane without new permissions. Title and avatar geometry stays stable across states and capabilities.

### Account model defaults authority

Personal Composer model/effort defaults are account data, separate from installation UI preferences. `PlatformAccountContribution.modelDefaults` exposes `AccountModelDefaultsPort`; enterprise OA implements authenticated same-origin HTTP backed by `account-model-defaults.sqlite`. Records are isolated by verified staff identity and Host, with revision CAS and no browser persistence. Renderer query memory is a disposable projection. Account/activation changes fence writes and late responses; HTTP validates the current identity and scope for every operation. Failures surface through Composer model errors and never fall back to legacy browser account records or write shared Host config. Without an account port standalone installation memory remains supported. See [model configuration](../../../design/model-configuration.md#personal-defaults-on-shared-servers).


### 单 Hub 主体协作

Headless 将 `access-control/collaboration` 作为 ActorStore / ActorAccess 后的协作权威，拥有独立托管 SQLite 中的私聊消息、投递、运行绑定与执行交接记录。`scripts/conversation-execution.mjs` 是有限的进程内 AppHost 适配；OpenCraftHostQueue 仍唯一拥有执行领取，并在领取前调用当前 Actor 授权校验。Wire 字段不构成可信调用上下文。契约及未隔离边界见[主体协作接口](../../actor-collaboration-api.md)。

[会话引用、读取与投递](../conversation-interoperability.md)将Actor和Conversation资源分开，统一Collaboration接纳与交接，目标Host继续拥有执行队列。Headless本地Codex已接通稳定引用、按需历史、原始输入委托的服务端工具；其他引擎与跨Server投递须有实际适配，不因协议类型而自动可用。
