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
- Timeline windowing, restore anchors and latest-Turn follow policy: shared
  algorithms. DOM `ResizeObserver`/scrollTop and RN `onLayout`/contentOffset are
  thin platform adapters; neither platform may introduce another virtualizer
  as window authority.

Trying to share the Codex DOM frame through React Native Web would weaken the
desktop result. Trying to embed the DOM composer in native would create a
WebView boundary and break native input behavior. The reusable unit is the
typed feature contract, not the rendered element tree.

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

`index.html` and `version.json` use `no-store`; hashed assets use one-year
`immutable`; non-hashed public files revalidate. If a lazy import fails, the
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
