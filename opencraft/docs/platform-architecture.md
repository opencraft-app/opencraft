# OpenCraft platform architecture

Page teardown and owned DSH process recovery follow the
[host lifecycle contract and acceptance matrix](../design/dsh-host-acceptance.md).

OpenCraft is a dual-renderer workbench with one semantic application model. This
does not mean one global dependency-injection container. An explicit
Application Supervisor owns multiple lifecycle-scoped runtimes: Host
connections, browser resources, renderer services, extensions, panels and Query clients.
The Vite renderer is the precision desktop surface used by browsers and
Electron. The Expo Router app owns iOS, Android, and an independent Expo Web
build. Neither renderer is a wrapper around the other.

```text
ApplicationSupervisor
├─ HostRuntimeRegistry
│  └─ HostRuntime(hostId)
│     ├─ @opencraft/appserver-client
│     │  └─ @opencraft/appserver-protocol ── Codex app-server protocol
│     ├─ Resume / Replica / Thread projections
│     └─ DuplexTransport
│        ├─ WebSocket (browser/RN)
│        ├─ Electron App Host channel → OpenCraft Daemon
│        ├─ Memory server
│        └─ Recording / Replay
├─ BrowserRuntime
├─ RendererRuntime
├─ EcosystemSupervisor
│  ├─ ExtensionSupervisor
│  │  ├─ ActivationGraph / ContributionBroker
│  │  ├─ TrustedBuiltinRuntime (Cordis)
│  │  ├─ TrustedExtensionRuntime
│  │  ├─ RestrictedExtensionHost (optional)
│  │  └─ SandboxedUiBroker (optional)
│  └─ AgentCapabilityRuntime
│     ├─ Spec Catalog / Offering Resolver / DisclosureBroker
│     ├─ Policy / LeaseRegistry
│     └─ ExecutionRouter / Journal / DraftLab
└─ QueryClient
        │
        ├───────────────────────────┐
        ▼                           ▼
Vite / React DOM              Expo / React Native
apps/workbench-web            apps/workbench-expo
Codex desktop frame           iOS · Android · Expo Web
        │                           │
Electron bridge               native/web adapters
```

## Package ownership

Task workspace presentation is specified in [the workspace design](../design/README.md).
The product exposes right-side tools only; no bottom outlet or move/reveal controls.
Legacy bottom tabs return to the right without disposing their resources.
The Cordis panel service owns tab state; main-chat overlay consumes
the existing Composer controller and Shell geometry. SideChatService owns explicit
ephemeral forks, not parent navigation. Implementation/verification status and
protocol adaptations are tracked there rather than implied by a successful build.

| Layer | Owns | Platform imports |
| --- | --- | --- |
| `appserver-protocol` | host-aware RPC, restore and replica protocol | none |
| `appserver-client` | JSON-RPC request lifecycle and low-level Cordis registry utility | none |
| `appserver-replica` | V4 authority/client, journal replay, snapshot replacement and Cordis registry | none |
| `appserver-replica-storage-node` | atomic JSON persistence for servers and Lab | Node filesystem |
| `appserver-replica-storage-web` | transactional client cache | IndexedDB |
| `appserver-replica-storage-expo` | transactional native client cache | Expo SQLite |
| `appserver-session` | Codex Desktop Resume/View hydration and V3 compatibility reader adapter | none |
| `appserver-transport-websocket` | browser, React Native and direct daemon WebSocket | WebSocket only |
| `appserver-transport-memory` | deterministic in-process AppServer | none |
| `appserver-transport-replay` | frame recording and deterministic replay | none |
| `app-host-protocol` | host/generation/lease envelopes outside AppServer JSON-RPC | none |
| `app-host-client` | Renderer-side logical App Host channel transport | MessagePort-like port |
| `app-host-server` | daemon-side physical Host lifecycle and cross-window lease multiplexing | injected transports only |
| `daemon-ipc` | authenticated local daemon handshake and framed IPC | Node socket types |
| `chat-core` | host-aware identity and Turn → Frame → Block projection | none |
| `chat-runtime` | Replica-derived Timeline snapshots and command/history ports | none |
| `composer-core` | portable document, target-scoped draft, SubmitIntent and controller | none |
| `composer-appserver` | lossless document compiler and native Codex command port | none |
| `timeline-virtualizer` | Codex Turn window, restore, anchors, follow and spacer policy | none |
| `workbench-runtime` | HostRuntime registry; per-Host client ownership, Thread catalog and Replica/Session orchestration | none |
| `workbench-resources` (proposed) | renderer-neutral resource identity, durable route and presentation contracts | none |
| `extension-contract` (proposed) | versioned manifest, identity, optional access declarations, contributions and RPC | none |
| `extension-runtime` (proposed) | activation graph, owner-aware contribution broker, install/access state and Cordis-backed trusted runtime | none |
| `capability-core` (proposed) | AI-facing Spec, Offering, ModelView, Lease, Invocation and Receipt | none |
| `capability-runtime` (proposed) | catalog, progressive disclosure, resolver, policy, execution router, journal and Draft Lab | none |
| `design-system` | semantic colors, spacing, radii and theme computation | none |
| `codex-composer` | ProseMirror/DOM composer view | DOM only |
| `workbench-web` | Codex frame, SCSS, Electron/browser adapters | React DOM |
| `workbench-expo` | Expo Router routes, native views, Expo Web view | React Native |
| `workbench-electron` | windows, tray, static origin and App Host byte relay | Electron main |
| `opencraft-daemon` | native Host process, physical transports, local Agent and DSH lifecycle | Node only |
| `apps/appserver-lab` | machine-first SDK smoke, recordings and fault injection | Node only |

Shared packages expose data and behavior, never DOM nodes, React Native views,
storage implementations, timers, file handles, or Electron IPC. Hosts inject
those capabilities through typed ports. `npm run check:boundaries` rejects the
most common dependency inversions.

Cordis Contexts are lifecycle scopes, not global application identity or a
third-party security boundary. Multiple scopes are valid when their resources
are independent; the invariant is that a physical connection, Browser instance
or native Surface has exactly one owner and every child scope is disposed by the
Application Supervisor. Renderer extension registries do not need to share a
Context with AppServer Host runtimes.

`ExtensionSupervisor` is the one product-level owner for client extension
activation. A Contribution Broker lets one activation register commands,
views, Chat presenters and Composer providers across otherwise independent
runtimes; every disposer is attached to that activation's Cordis Fiber. Public
extensions never receive the Cordis root Context as part of the supported API.
User-trusted local/workspace extensions may run in-process behind that API;
isolated Web realms, Electron utility processes, remote Hosts and sandboxed UI
are optional Restricted-channel policies rather than a universal prerequisite.
A plain same-origin Web Worker is not advertised as a security boundary. Full
rationale and the migration plan are defined in
[`plugin-architecture.md`](./plugin-architecture.md).

The Web application owns exactly one `LightVelaAccountService`, whose source,
OAuth lifecycle, account View and `platformAccount` contribution belong to
`lightvela.platform`. `lightvela.hermes` and `lightvela.collaboration` borrow
that same account authority; deactivating either consumer must not sign out or
dispose the account. Collaboration uses the account's authenticated raw-request
port for its OpenAPI responses, while Hermes retains the envelope-aware request
path. No consumer creates a second token store or interprets another extension's
resource loading failure as logout.

`lightvela.collaboration` owns one routed Collaboration Workspace and the Human
Tencent IM Web data plane for Server, Channel, private Group and Member surfaces.
Its activation-scoped service obtains a short-lived
session from `POST /v1/me/im/session`, logs in through `@tencentcloud/chat`, and
owns SDK close. View mount/unmount only subscribes to the service snapshot; it
cannot recreate or dispose the IM connection. This conversation state is
separate from AppServer Agent conversations and does not register a
`BotContribution`.

`AgentCapabilityRuntime` is an optional AI-facing consumer of that platform. It exposes
searchable capabilities rather than packages, progressively loads model
context, issues Task/request-series-scoped leases, routes invocations to local/SSH/MCP
providers and records exact receipts. Extension activation never implicitly
adds every contributed Tool or Skill to a model request. The full design is in
[`agent-capability-fabric.md`](./agent-capability-fabric.md).

The settled AppServer ownership model is application `HostRuntimeRegistry` →
one `HostRuntime(hostId)` → one logical `AppServerClient(hostId)`. A shared
Electron MessageChannel or multiplexed WebSocket may live in an optional
`TransportBroker`, but it only routes frames carrying `hostId`; it does not own
Thread, Resume or Replica semantics. The existing low-level
`AppServerClientRegistryService` remains a Lab/compatibility API during
migration and must not become a second product-level lifecycle owner.

Host discovery is dynamic, but ownership is not. `HostConnectionProfileStore`
persists stable Host identities and provider configuration; the Cordis-owned
`HostConnectionProviderRegistry` accepts trusted transport factories;
`HostRuntimeRegistry` lazily creates and exclusively owns complete Host
runtimes. A provider lease is held for the lifetime of every runtime it
created, so plugin reload cannot invalidate a live connection. Web currently
ships `vela.websocket`; Electron and Expo may register platform-specific
providers without changing Host, Thread, Session or Replica semantics.

Adding a Host is `validate provider config → persist profile → register lazy
runtime`. Removing one is `reject active work → detach registry identity →
dispose runtime → delete profile`. The Profile Store is seeded from deployment
configuration only when empty; after that, IndexedDB is the Web authority.

The transport packages are peers. Replay is not a wrapper around WebSocket and
Memory is not a fake method surface: all three carry the same JSON-RPC text
frames through the same `DuplexTransport` contract. `RecordingTransport` is the
only decorator; it can wrap any physical transport and produces Replay input.

## Deliberate reuse boundary

`@lightvela/agent-core` comes from the mono2-neutral
`shared/lightvela-agent-core` package. mono2 Web validates each product behavior
first; OpenCraft injects AppServer/Host adapters only after that contract is
stable. The core never imports either renderer, storage, auth transport, i18n or
analytics. During migration the generated mono2 HTTP repository may resolve the
package for shared Bot identity/lifecycle, but remains a compatibility consumer,
not a second source of product policy.

- Protocol, content models, session state, restore/replica logic, commands,
  deterministic tests, routing identifiers, and design tokens: 100% shared.
- React subscriptions and feature view-model hooks: share when they remain
  renderer-neutral.
- Account authentication and cloud Bot availability do not own the Web/Electron
  conversation surface. Zero cloud Bots, account refresh/errors, and sign-in do
  not replace a usable local or other-Host Workbench with a creation guide.
  Account-level `applicationIntervention` is a deprecated compatibility field
  ignored by the Shell. Only the selected Host's actual connection failure can
  request a matching provider intervention. LightVela no longer contributes an
  automatic `empty-workbench` creation guide; zero-Host startup has a neutral
  no-Agent state with a Settings action. Environment discovery and cloud
  creation services do not create an application-level Environment surface.
  The onboarding `bot-required` projection is retained for explicitly selected
  LightVela configuration, not as a global desktop prerequisite. Native Expo
  account onboarding is a separate adapter and is not changed by this desktop fix.
- Product onboarding shares a renderer-neutral account-state projection. An
  authenticated LightVela account with zero executable Bots can still enter
  Collaboration; `bot-required` belongs only to the Hermes/Codex Host path, not
  to the application account gate. Web and Expo still resolve the same
  region-aware `/dashboard/create` target when a user explicitly enters that
  Agent path, then refresh the account catalog after regaining focus.
- Conversation and composer behavior: shared models/controllers; separate DOM
  and native views.
- Workbench resource identity and durable routes: shared. AppShell geometry,
  right/bottom panel placement, iPad split view, gestures, text editing and
  accessibility: platform implementations with matching semantic APIs.
- Extension manifest, activation identity, install permissions, commands and
  declarative contributions: shared. Arbitrary React DOM/React Native component
  bodies are not a public cross-platform plugin ABI.
- Embedded feature controls share semantic state contracts rather than raw
  renderer markup. Web `Select`/`Option` primitives emit stable state and role
  attributes, while the Host theme adapter owns their colors, focus, selected
  and disabled presentation. Body-portaled controls must choose a named Host
  presentation plane such as `floating-control`; feature code must not invent a
  numeric `z-index` relative to an application modal.
- Modal windows follow the same ownership rule. Feature code supplies content
  plus a renderer-neutral descriptor; the platform owns the controller, the
  single modal Host, the window surface and all modality behavior. Web adapts
  that contract through Radix Dialog for Portal, focus, Escape and outside
  interaction. Expo adapts it through React Native `Modal` today and may map a
  fullscreen presentation to a navigation Stack later. Features must not own a
  scrim, focus loop, Escape listener, Portal or numeric modal `z-index`.
- Announcement windows are a content specialization of that modal contract,
  not another window manager. Trusted JavaScript calls
  `api.window.showAnnouncement()` with a serializable descriptor and awaits a
  data result; `AnnouncementCenter` owns request/extension lifetime, while the
  renderer supplies the themed content recipe through the existing modal Host.
  Campaign eligibility, impression persistence and automatic scheduling stay
  in a separate orchestration layer, matching Codex's announcement model.
  Renderer-owned static assets must be resolved to an absolute HTTP(S) or blob
  URL before entering that descriptor. Relative Vite asset strings are a Web
  adapter concern and must not weaken the renderer-neutral validation contract.
- Timeline windowing, restore anchors and latest-Turn follow policy: shared
  algorithms. DOM `ResizeObserver`/scrollTop and RN `onLayout`/contentOffset are
  thin platform adapters; neither platform may introduce another virtualizer
  as window authority.

Trying to share the Codex DOM frame through React Native Web would weaken the
desktop result. Trying to embed the DOM composer in native would create a
WebView boundary and break native input behavior. The reusable unit is the
typed feature contract, not the rendered element tree.

## Fixed navigation entrances

Chat and Settings are the built-in application routes. Local Model Services is
a normal Settings page using the shared Settings category and master-detail
container; there is no Environment application route, parent context pane,
breadcrumb, overview or connection-management page. Historical `/environments`
URLs normalize to Settings, preserving a concrete contributed settings slug when
one exists and otherwise opening Appearance.

The Built-in Agents extension registers Model Services only for Electron and its
configuration client remains permanently bound to the immutable `local` Host ID.
Moving the View does not make it follow the active conversation Host. Provider
connection identity, provider-scoped model declarations, write-only credential
intents and per-session selection remain separate; see
[Local Agent custom providers](local-agent-custom-providers.md). Model edit drafts
survive View reattachment and must be applied before saving a connection. A
capability-gated draft endpoint probe uses only explicitly entered credentials,
does not mutate the runtime and is not a substitute for full runtime validation.
The page is absent when that extension/platform contribution is unavailable; the
Shell never falls back to an active remote Host. Global Settings retains
Appearance, Plugins and Laboratory. EnvironmentDirectory, account discovery and
persisted Host profiles remain runtime services used by Chat and providers, but
they have no built-in application navigation or creation UI.
Desktop account restoration runs asynchronously after extension activation and
never depends on OS Keychain. A Main-process `PrivateStorage` port persists only
region and session token in `userData/private-storage/lightvela-account.json`.
This is explicitly plaintext protected by directory 0700/file 0600 permissions,
not encryption or protection against same-account processes. Writes use private
temporary files and atomic replacement; keys and file types are validated. The
renderer still has no filesystem port or durable token storage. Legacy
`lightvela-account.encrypted` is not decrypted or migrated: one fresh login is
required. Logout clears new session data and obsolete local ciphertext without
accessing the system keychain. Generation/abort guards prevent cancelled saves
and late restoration from undoing sign-out.

### Authentication ownership

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

LightVela exposes `snapshot.session` (status + auth epoch) separately from its
legacy `phase` (Bot-catalog loading/error compatibility for existing Host consumers)
and `details.phase` (profile/entitlements). Shell identity, login, and environment
discovery consume session truth. A resource 5xx never logs out or invalidates a
successful login. Authoritative 401 is handled centrally with an epoch/abort fence;
old requests cannot clear a newer session. Account changes clear old details before
new data loads, and profile mutations are fenced after their asynchronous boundary.

Account content composes shared utility-window controls: SettingsPanel owns its
header/body/footer tracks; plain SettingsGroup/Row own compact alignment;
editable text uses Radix Popover, while the host Radix Dialog owns modality and
restores focus. Avatar editing, clipboard feedback and the semantic usage meter
are reusable renderer controls. The account feature retains profile mutations,
credit interpretation and regional billing URLs. Utility modal appearance is
theme-owned and content-sized, with no account-specific fixed canvas. Warning,
error, usage-track, utility-shadow and scrim colors are emitted by the theme
engine, not hard-coded in account CSS. Returning from external billing refreshes
account details; model configuration uses the host's settings navigation.

Desktop LightVela login uses the system browser and the registered native OIDC
client/callback. Electron Main owns random state, PKCE, timeout, cancellation,
single-use exchange and OS-encrypted per-profile session storage. Only the trusted
top-level renderer may invoke the narrow preload account port. A callback received
by another profile is forwarded to its live owner through a state-addressed local
socket; the socket carries only the one-time callback and is retired on completion.
Renderer credentials stay in memory; ordinary preferences remain origin-local.
Web retains its browser-navigation PKCE path. Remote login pages never replace the
desktop workbench or receive desktop IPC capabilities. Closing/reloading the
initiating renderer cancels its pending transaction; late callbacks cannot log in.
Authenticated account/control-plane reads and updates use a Main-owned HTTP port,
restricted to the saved session's regional authority and known account, instance
listing, TAT-session and configuration endpoints. Main attaches the credential;
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
transport phase remain separate. LightVela discovery lives in its plugin's
`environment-directory` folder and binds identity to region, account and instance.
It lists non-running states, paginates with generation fences, and clears entries
on sign-out. Explicit saved bindings preserve Host IDs; unbound legacy profiles
are not silently reassigned. Environment and Chat share an ephemeral profile
projection; discovery registers factories without connecting or changing the
active conversation. Passive Chat queries only connected/auto-connect Hosts.
New instance creation refreshes this same source, not a second profile registry.

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
detent. Vela, the shared Sidecar trigger and history controls remain a complete
window-chrome group at every detent. The separator between primary and context
panes begins below that Header and terminates above the Footer; it has no authority
over either fixed region.

`workbench-runtime/shell-navigation` owns the renderer-free reducer and responsive
projection. The initial preference pins applications, not account. Width pressure
temporarily suspends docking with hysteresis without overwriting the preference.
Web owns persistence, measurement, Radix nonmodal surfaces and spring animation.
Primary visibility progress and base resize geometry are separate owners: when
the semantic projection becomes hidden, base Frame/Viewport geometry is retained
until visibility reaches zero. It must not copy the hidden projection's zero into
the base width and erase the exit animation. Outgoing navigation keeps its last
content snapshot mounted until terminal zero, but is immediately inert. Reversal
retargets the existing visibility progress; it does not remount or restart it.
Primary expanded width is persisted separately from contextual pane width.
Applications defaults to 137px (about 25% narrower than the former 182px), with a
126px expanded minimum and 137px content-owned maximum shared by pointer and
keyboard resizing, persisted-value normalization and projection. The pointer
frame stops at that cap while held, not just on release. Context keeps its own
240px minimum and independent maximum. Valid custom widths remain intact; legacy
oversize values read as 137px without clearing other preferences. Double-clicking the
primary divider restores the new default without changing the contextual width.
Dedicated resize transaction owners handle the primary three-detent pane and the
contextual two-state pane; the Shell limits primary width against available content
space. Shared projection uses that width for docking pressure, without rewriting
the saved preference when the viewport narrows. Resizing preserves the footer's
left/bottom anchor and square entrance; the account item's trailing edge follows
the live Footer width. Pin transitions interpolate the Sidecar's primary and
contextual pane widths using existing motion values, without remounting items.
Footer controls participate in normal flow inside their dedicated Sidecar track;
they are not an absolute overlay and do not consume Primary's expanded-width
animation. The track fills the aggregate Sidecar width. One square entrance and
one `minmax(0, 1fr)` account cell share design-system group gap/padding tokens.
Only menu surfaces are positioned overlays. Portal viewport-fill rules exclude
the footer so width and insets cannot overconstrain it. The Applications entrance
reuses the existing `SidebarToggleIcon` used by window chrome, not stacked app
icons. Compact-only presentation stacks the same controls with the same gap.
Its entrance survives pinned/unpinned transitions within the Sidecar. The primary
and current contextual panes contribute to one aggregate left width consumed by
header, timeline and right-panel geometry. Neither pane
owns Host or conversation runtime lifetime.

`workbench-runtime/shell-space` arbitrates the complete window budget, including
both Sidecar panes and the task panel. The desktop main viewport reserves 480px;
ordinary right tools additionally reserve at least 320px. Under pressure, the
application pane becomes compact, then transient; tools are then suspended, and
finally context becomes floating. A 32px restoration margin avoids breakpoint
chatter. Saved widths, pins, and explicit open/close intent are not resize output.
Header controls consume the actual presentation. Explicitly revealing tools when
split mode cannot fit uses the full work area; revealing a suppressed sidebar uses
the existing floating owner, dismissible with Escape or an outside click. No
responsive transition disposes a Host, tab, terminal, or conversation.

Thread-edge header eligibility consumes Shell width minus the live right-panel
width from the layout owner. It must not add a rounded DOM viewport measurement
to the left sidebar's animation value: these can represent different frames and
toggle the divider at the 96rem threshold. Left navigation motion is not an input
to this decision. A real right panel and route presentation remain inputs.
The Home action is rendered as a Vela wordmark; its off-layout measurement clone
must use the same text/geometry, including when a brand font loads. The dedicated
brand font binding is separate from the UI font; final custom font selection is
pending the supplied brand asset, so the current fallback is not a custom-font claim.

Sidecar is a physical layout boundary, not an application hierarchy. Its optional
`leftPanel` slot contains application context: Chat supplies a conversation list,
Settings supplies its index, and current extension pages omit the slot. With no
context, application navigation becomes the single primary sidebar; no empty
context column is reserved. The Sidecar toggle hides all its columns and footer
without changing pin preferences. Returning to Chat restores its contextual layout.
These are renderer-owned slots, not a new extension registration API or an
assumption that every application has a conversation hierarchy.
Device Settings follows this exact contract in both connected and zero-Host
workbenches: its category navigation replaces `leftPanel`, its selected page
replaces main content, and the global navigation/entrances stay mounted. There
is no Settings-only docking ban, hidden global toolbar, width observer or
index/content layout controller. The common Shell owns resizing, collapse and
transient presentation for every contextual sidebar. With navigation expanded
this yields three columns; with it collapsed Settings remains usable in two.
The category view's `sidebar` presentation supplies content, not a Back-to-app
shell. Target/Agent management remains a dialog; it is not device Settings.
Controls reuse the shared quiet-control and menu treatments. Pin preference is
shown by the entrance's pressed state, not repeated pin badges in every heading.
Application rows and the existing sidebar reuse `controls.navigation-control`;
the footer uses its compact `sidebar-entrance` variant with an xs avatar and square
application entry. These are visually sidebar items: transparent at rest, without
borders or shadows. Hover, transient open and persistent `aria-pressed` states
reuse the navigation row's subtle fill; opening a menu does not change the pin
preference. Semantic buttons and keyboard focus outlines remain for accessibility.
The footer layout row, not a raised item surface, prevents overlap with content.
The dock uses secondary typography and subtle separators without introducing
another card around the footer. Content opacity remains independent
of the sidebar material; a low-emphasis appearance must not make text unreadable.

Expo can consume the same state/projection with native layout measurements and
present transient content in its platform container. This change wires the Web
vertical slice; the native visual adapter is not yet integrated and the contract
is not frozen until that second adapter is exercised. It must not import DOM,
Radix, localStorage or CSS geometry into shared state.

## Expo Web's place

Expo Web is a first-class output of `apps/workbench-expo`, not a compatibility
mode hidden inside the Vite app. It is appropriate for mobile-width browsers,
PWA distribution, and validating universal routes. The Vite app remains the
desktop browser/Electron target where precise Codex layout and mature chunk
control matter.

Production routing can send desktop browsers to the Vite deployment and mobile
browsers to the Expo deployment, or expose the Expo build under a stable path.
Both connect to the same app-server and consume the same runtime snapshots.

## Commands

```bash
npm run dev:web          # Vite desktop browser renderer
npm run dev:expo:web     # Expo Router through Metro
npm run dev:expo:ios     # custom native build + iOS Simulator (macOS/Xcode)
npm run lab -- scenario smoke      # real 9988 SDK smoke as NDJSON
npm run lab -- scenario reconnect  # in-flight disconnect + reinitialize proof
npm run build:web        # Vite production build
npm run publish:web      # append-only publish to .runtime/workbench-web
npm run serve:web:static # production static host + /appserver WebSocket gateway
npm run build:expo:web   # Expo Web export
npm run build:expo:ios   # Metro production iOS bundle, works on Linux CI
npm run gate             # boundaries + types + Web builds + iOS bundle
```

## Vite Web release invariant

The browser and Electron renderer may consume the same Vite build, but they do
not assume that every file appears at the same instant. `build:web` emits a
Vite manifest, content-hashed assets and `version.json`. `publish:web` then:

1. verifies the build id and manifest;
2. appends or verifies every hashed asset without deleting an older hash;
3. excludes source maps from the public tree;
4. snapshots the manifest and version under `releases/<buildId>/`;
5. atomically replaces `index.html`, then `version.json`.

`index.html` and `version.json` use `no-store`; manifest-owned hashed assets use
one-year `immutable`; non-hashed public files revalidate even when Vite copies
them below `assets/`. If a lazy import fails, the
bootstrap compares its embedded build id with `version.json`, reloads once only
when a newer release exists, and otherwise renders an explicit recovery view.
This is a renderer delivery rule, not AppServer or Replica state.

The browser production host exposes the same-origin `/appserver` WebSocket gateway and
adds the authenticated HyperNode identity server-side. The current fixed
`OPENCRAFT_HYPERNODE_USER` is suitable for a single-user/debug deployment only; a
multi-user Web deployment must obtain that identity from its authenticated
gateway session and must never accept it from browser JavaScript.

Electron does not use this HTTP gateway. Its loopback server is static-only;
the application-scoped transferred port described in
[`architecture/opencraft-app-host.md`](./architecture/opencraft-app-host.md) is the sole
Renderer-to-native connection boundary.

Local macOS preview builds use a separate product identity, profile directory,
output tree and ad-hoc signing path. This prevents a preview from taking the
release app's single-instance lock, daemon socket, browser session or stored
credentials. The preview hook mutates only the assembled package: it removes
foreign native prebuilds and signs after all packaged resources are final.

## Next feature rule

### Settings-owned local Model Services

Settings owns only the page placement, category navigation and master-detail
viewport. The extension-owned Model Services View keeps its provider directory,
drafts and immutable local Host client across Settings reattachment. Connected and
hostless shells use the same Settings route; neither creates an Environment parent
or a second model settings service. Removing the page from view must not dispose a
Host, alter the active conversation, or rewrite model/provider configuration.

Implement a feature in this order:

1. protocol/domain types;
2. renderer-free runtime command and snapshot projection;
3. first vertical platform adapter;
4. a second physically different adapter that proves the SPI;
5. freeze the smallest contract that both implementations need;
6. remaining platform adapters and cross-platform capability tests.

If a feature starts in either app with networking, timers, persistence, or
business state embedded in a component, it has crossed the boundary too early.
