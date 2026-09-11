# OpenCraft platform architecture

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

- Protocol, content models, session state, restore/replica logic, commands,
  deterministic tests, routing identifiers, and design tokens: 100% shared.
- React subscriptions and feature view-model hooks: share when they remain
  renderer-neutral.
- Product onboarding shares a renderer-neutral account-state projection. In
  particular, an authenticated LightVela account with zero executable Bots is
  `bot-required`, not an authentication or Host transport error. Web renders
  that state through an extension-owned DOM surface and Expo through a native
  screen; both resolve the same region-aware `/dashboard/create` target and
  refresh the account catalog after the application regains focus.
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
- Timeline windowing, restore anchors and latest-Turn follow policy: shared
  algorithms. DOM `ResizeObserver`/scrollTop and RN `onLayout`/contentOffset are
  thin platform adapters; neither platform may introduce another virtualizer
  as window authority.

Trying to share the Codex DOM frame through React Native Web would weaken the
desktop result. Trying to embed the DOM composer in native would create a
WebView boundary and break native input behavior. The reusable unit is the
typed feature contract, not the rendered element tree.

## Fixed navigation entrances

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

There is exactly one Sidecar. It composes a primary application `SidecarPane`, an
optional contextual `SidecarPane`, and one Footer; the panes are not independent
sidebars. Each Pane separates three geometries: Frame contributes live width to
layout, Clip contains all feature ink to that Frame, and Viewport retains stable
content width throughout a gesture. Application and contextual content therefore
never reflow through progressively narrower intermediate widths or paint into a
neighbor. Feature code provides only pane content. It does not own clipping,
opacity, mounting, dividers, Footer placement or numeric stacking levels. The
visual three-column layout is `Sidecar(primary + optional context) + main`; two-
column and immersive layouts are projections of those same slots.

The primary pane has three semantic detents: `expanded`, `compact` and `hidden`.
Expanded width remains a separately persisted preference; compact is
a 72px icon projection, not an overwritten width preference, and hidden only
changes pane visibility; it never clears application/account Pin preferences.
Pointer down creates a Web-owned resize transaction that snapshots the committed
detent and Viewport. Pointer move updates only Frame/Clip preview geometry,
content opacity and an adjacent candidate detent. Pointer up atomically commits
that candidate; cancel restores the snapshot. Dock availability, persistence and
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
Primary expanded width is persisted separately from contextual pane width.
Dedicated resize transaction owners handle the primary three-detent pane and the
contextual two-state pane; the Shell limits primary width against available content
space. Shared projection uses that width for docking pressure, without rewriting
the saved preference when the viewport narrows. Resizing preserves the footer's
left/bottom anchor and square entrance; the account item's trailing edge follows
the live Footer width. Pin transitions interpolate the Sidecar's primary and
contextual pane widths using existing motion values, without remounting items.
Its entrance survives pinned/unpinned transitions within the Sidecar. The primary
and current contextual panes contribute to one aggregate left width consumed by
header, timeline and right-panel geometry. Neither pane
owns Host or conversation runtime lifetime.

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

## Next feature rule

Implement a feature in this order:

1. protocol/domain types;
2. renderer-free runtime command and snapshot projection;
3. first vertical platform adapter;
4. a second physically different adapter that proves the SPI;
5. freeze the smallest contract that both implementations need;
6. remaining platform adapters and cross-platform capability tests.

If a feature starts in either app with networking, timers, persistence, or
business state embedded in a component, it has crossed the boundary too early.
