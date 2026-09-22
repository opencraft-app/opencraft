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
├─ AgentRuntimeDirectory
│  └─ HostRuntimeRegistry
│     └─ HostRuntime(hostId)
│        ├─ ProtocolPort (initialized AppServer request boundary)
│        ├─ Runtime readiness / connection generation
│        ├─ Domain resources (Threads, Projects, Files, Catalog, Terminal)
│        ├─ @opencraft/appserver-client
│        │  └─ @opencraft/appserver-protocol ── Codex app-server protocol
│        ├─ Resume / Replica / Thread projections
│        └─ DuplexTransport
│           ├─ WebSocket (browser/RN)
│           ├─ Electron App Host channel → OpenCraft Daemon
│           ├─ Memory server
│           └─ Recording / Replay
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

`AgentRuntimeDirectory` waits for Host readiness; it does not own Host
registration, transport, Thread state, Skills state or model configuration.
Views and domain services never read the raw AppServer client registry.

## Package ownership

### Typography ownership

Typography is a design-system protocol, not feature CSS. The checked-in
`packages/design-system/src/typography/typography.tokens.json` registry is the
single data authority for font-family roles and per-platform semantic metrics.
`typography.shared.ts` projects that registry to TypeScript/Native, while
`scripts/generate-typography.mjs` deterministically creates the Web custom
properties in `_generated.web.scss`. Generated output is checked but never
hand-edited.

The hand-written `typography.web.scss` adapter composes a Typography Role with
an independent TextTone. Platform rasterization remains a root rendering
policy. This keeps font metrics, theme color and macOS/Windows/browser smoothing
orthogonal: selection or disabled state can change tone without creating a new
font role, and platform rendering can change without rewriting every component.
Shell and extension chrome consume the semantic primitive; feature-local raw
metrics are reserved for content systems with a separate owner.

Shared Button and Settings form controls also consume registry roles:
`control/controlSmall/controlLarge/controlCompact`, `input`, and settings
heading/label roles. Native button text metrics are projected from the same
registry; geometry remains in the button contract and is not changed by this
normalization. Web role projection can omit TextTone (`null`) when a control
variant owns its semantic colors. `controls.web.scss` owns state-only focus,
disabled and invalid feedback, including forced-colors focus visibility.
Generic Button loading preserves its label footprint and exposes `aria-busy`;
it cannot widen the button or animate the spinner under reduced motion.

The focused standards test rejects typography literals in these shared
consumers. `scripts/smoke-control-standards.ts` renders actual controls across
light/dark/custom palettes and tests size, focus, invalid, disabled and loading
states; optional isolated Electron execution requires an explicit executable.

### Client voice input ownership

Voice input is a client input service, not an Agent Host tool or chat model.
Following BB's capture/transcription/Composer separation does not imply reusing
its Codex authentication or transcription endpoint. On Mac Electron, Main owns
one physical capture through a bundled Speech/AVAudioEngine/CoreAudio helper.
A trusted top-level preload port exposes semantic probe/start/stop/cancel events,
never executable paths, audio buffers or credentials. Web retains its browser
speech adapter; other Electron platforms explicitly report unsupported input.

The voice extension owns platform selection and a dictation-session result ledger.
Native recognition tasks supply stable utterance IDs, monotonic sequences and
partial/final events. Final results replace only their own ledger entry; hypotheses
never overwrite confirmed history. A task final rotates the native recognition
request while the same AudioEngine keeps capturing; it does not end the user session.
Only explicit stop drains the active request and ends capture. Request routing is
atomic; canceled/stale task callbacks cannot act on a replacement. Recognition
quality and native handoff latency still require real microphone acceptance.

BB-style final-only delivery means recording presents waveform, not editable ASR
hypotheses. Browser recognition uses actual result indices as ledger identities;
it never publishes partial text through the Composer observer. The completed
ordered ledger is delivered once after successful session end. Unexpected end,
unfinished utterances, cancellation or error do not insert partial results.
Draft ownership, session epochs and cancellation fence late results after submission,
route replacement or unmount. Stop finalizes once; cancel invalidates renderer results
immediately, asks the native task to release, and retains physical ownership
until process close (with bounded termination fallback). Main also releases
capture on navigation, renderer death and application shutdown.

Dictation presentation belongs to that same transient input transaction, not an
independent application-wide mode flag. The controller exposes a separate input
interaction subscription; replacing a draft or physical View releases the reserved
insertion transaction and presentation. The recording editor is read-only, retains
its original document and is not fed provisional hypotheses.
A released transaction cannot update a replacement Footer or insert late results.

The recovered Codex path captures a concrete Composer controller, synchronously
`appendText`s to its View, then sends that same controller's `getText`. Dictation
therefore appends trimmed text at the document end, adding a separator only when
the existing text has no trailing whitespace; it does not replace arbitrary old
selection. OpenCraft adopts that policy for dictation while retaining selection
replacement for generic transient producers.

Because OpenCraft separates Store and physical View, its adaptation adds explicit
write acknowledgement. The input record binds Draft ID, concrete View lease and
content epoch. `replace-content`, target/reset and View replacement invalidate the
old record; both before and after a synchronous write the same ownership must
hold. The View acknowledges only an applied transaction whose physical document
matches the expected result. Missing reservation, rejected dispatch or reentrant
replacement yields `false`/`commit-rejected`; recognition text being nonempty is
not sufficient to authorize sending. This boolean port is an OpenCraft adaptation,
not a claimed Codex original interface.
Composer owns the original Footer geometry and controls: its standard action
children remain mounted but inert/aria-hidden while an in-place dictation Footer
owns the region. Editors are not remounted to switch modes. The voice extension
provides semantic status, cancellation and a single completion promise, not a
React replacement toolbar or access to the root controller.

Stop-and-insert completes recognition without submitting. Transcribe-and-send
and Enter wait for final text and revalidate the same draft and physical View
before invoking the existing submission compiler. The read-only editor's Enter
is dispatched by the dictation keyboard owner; Enter on a control remains native
button activation. Send availability while capturing does not depend on publishing
provisional draft content. Cancel, error or owner loss
resolve completion negatively, so late results cannot authorize a send. Repeated
stop requests share one completion. Escape cancels; a Codex-style 150ms hold
separates release-to-insert from the synthesized click. The gesture owns its
pointer-ID release/cancel listener independently of the trigger's inert state;
blur releases a held gesture, while cancellation/unmount removes its ownership.
Native audio levels are
bounded numeric samples at at most approximately 20Hz; they bypass draft snapshots
and feed a View-owned, bounded waveform buffer. No raw audio or second capture
crosses into the renderer; meters without actual samples show a quiet baseline.
See [the dictation interaction plan](../design/dictation-interaction/task_plan.md)
for the recovered-Codex/BB comparison and acceptance evidence.

Input device UID and optional recognition language are client/profile preferences
in Main's private JSON storage, independent of model configuration and DSH.
Device enumeration/probe requests no recording permission. A missing selected
device is an error, not permission to silently switch microphones. System
authorization is requested only by explicit capture start.
`supportsOnDeviceRecognition` is checked for the selected language at capture:
when supported the request requires device recognition; otherwise Apple speech
service may be used. No universal offline guarantee is made. The bundle/helper
carry privacy descriptions and audio-input entitlements. A signed probe and
synthetic desktop test do not prove real microphone permission or recognition;
that acceptance is reported separately in [the native speech plan](../design/native-speech/task_plan.md).

### Thread lifecycle ownership

DSH display recovery uses [JIT history](../design/dsh-jit-history.md): native
message pages retain their original unit and are mapped to requested Turn
windows without a persistent event mirror. Reading a conversation does not
activate its Agent. A read-only native description supplies metadata; execution
acquires the runtime lazily. Older history-index databases are left untouched
and are no longer opened by the local Host.

Current model identity is a Thread configuration binding, not an execution-engine
label or merely the last request's model. Fork returns the acknowledged choice;
Catalog persists it for resume and lazy execution, including never-run children.
Dynamic tool wire declarations are retained separately from normalized engine
descriptors. Preflight precedes native creation; cold display registration accepts
the declaration without mounting an Agent, and activation installs it idempotently.

OpenCraft owns persisted Thread names, archive state and fork/subagent relation
in `opencraft-threads.sqlite` under the Host product data directory. Engine
history remains behind the native execution port; metadata discovery never
overwrites a user name or revives an archived Thread. Temporary metadata,
native event logs and application history indexes remain in memory and are
expired on engine restart. Projection/checkpoint adapters must not persist
temporary content, including late disposal writes.

AppHost stamps a logical client identity at the trusted lease boundary and
routes targeted replies/server requests back to that client. Physical transport
sharing does not merge subscription or execution ownership. `thread/unsubscribe`
detaches one logical subscriber; another subscriber is unaffected. Idle durable
threads unload after a 30-minute no-subscriber activity grace; a temporary thread
releases after its final subscriber. Unload and resume transitions serialize.

Native Fork copies a complete, validated event/context prefix with opaque
provider state, not the currently loaded UI turns. Turn boundaries use logical
to-native generation coordinates. Fork gets a new logical identity; execution
recovery keeps the existing identity. Side Chat adds a canonical inherited-history
boundary before acquiring a view or accepting new work. It inherits the effective
model, roots and permissions without continuing the parent task. Its close
transaction retains cleanup ownership for retry and preserves primary failures.

The SDK fences late unsubscribe responses, retains newly acquired views and
actually reattaches them. Naming uses per-Host/Thread acknowledgement queues and
optimistic-write generations; archive/unarchive modifies durable catalog state,
never deletes a workspace. Catalog notifications invalidate shared queries.
The main sidebar offers only Host-declared operations for active Threads and
does not retain archive-management or transient undo state. Archived browsing
and restore belong to a capability-gated Settings page, scoped to the active
Host and backed by the same catalog query/invalidation owner. All menus and
settings controls reuse the existing Radix and theme primitives. Source and acceptance are tracked in
[the lifecycle plan](../design/thread-lifecycle/task_plan.md).

### Project selection and persistence

OpenCraft owns the local Project catalog and stable IDs. The local Host serves
`project/list` and `project/create` from `projects.json` in the product storage
directory (desktop: `~/.opencraft/projects.json`), using locked atomic writes.
Selecting the same normalized roots reuses the existing Project; the catalog
does not come from DSH `workspace.list`. DSH only receives execution `cwd` and
workspace roots, and can be replaced without losing the product catalog.

Electron Main exposes a narrow, trusted-main-renderer `projects.pickDirectory`
port. It opens a parented directory-only system dialog, validates the selected
absolute directory, and returns a path or null on cancellation. It does not
create a Project. The shared project menu consumes the port only for `local`;
Web/remote Hosts retain their Host-scoped filesystem picker and advertised roots.
Adding a Project requires the selected Host transport to be ready; the menu
explains why it is unavailable while connecting.
An interaction epoch invalidates picker/create results when the draft, Host,
workspace, submission phase or visible route changes. Persisted additions remain
in their original Host catalog, but never retarget a replacement draft.

### Read-only SQLite diagnostics

The decided, not-yet-implemented lifecycle for OpenCraft-owned SQLite and
IndexedDB stores is documented in [storage lifecycle](./sqlite-lifecycle.md)
and [plugin persistence](./plugin-persistence.md). It retains node:sqlite and
does not adopt Drizzle in this phase. Client-local and Host-owned data have
separate authorities; engine-private databases retain their owners.

The first [Host document API](./host-document-storage.md) implementation exposes
versioned capability discovery, read/CAS and content-free invalidation on the
authenticated Local Agent Host. The client borrows a fixed initialized Host
connection and rejects old generations, with no local fallback or implicit
reconnect. This adds API capability, not a Host plugin runtime or multi-tenant
authorization model. SQLite code is shared through document-storage's explicit
Node entry; Web/Expo consume only the pure contract.

Electron internal developer mode exposes a Settings inspector for the four
OpenCraft-owned local Agent SQLite databases under the current desktop profile:
session routing, history index, thread catalog and execution authority. Main
owns the filesystem boundary and opens only those fixed filenames with SQLite
`readOnly` plus `query_only`; Renderer receives database metadata, table schema
and bounded paginated rows. The port accepts neither paths nor SQL and provides
no mutation, import, export or delete operation. Developer-mode visibility is a
presentation gate, not the security boundary. Row values stay on the device;
Blob data is summarized and long cells are bounded for debug rendering.
The Workbench-owned five-Escape gesture toggles internal developer mode for the
current browser session. Plugins, Laboratory and the Electron SQLite inspector
are internal Settings entrances. Disabling the mode removes them
immediately; an active internal-only route returns to Appearance rather than
leaving inaccessible content mounted.

Bot product surfaces are temporarily part of the same internal presentation
audience. Normal mode does not project the Bots application, Bot sidebar
entities, Bot creation command, or Bot conversation views. Enabling developer
mode restores them together; disabling it while a Bot view is active returns
to the ordinary Chat route. The extensions and AppServer capabilities remain
loaded, so this audience flag is a presentation policy rather than an
authorization or persistence boundary.

### UI preference authority

Workbench UI preferences are owned by one asynchronous, typed
`UiPreferencesRuntime`. Every registered key declares a schema, default value
and subject scope (`installation`, `account`, or `workspace`); React never
chooses or calls a physical store. Web installation preferences use a
Renderer-owned IndexedDB adapter. Electron's loopback origin uses a random port
per launch, so its installation authority is a Main-owned profile SQLite table
behind a restricted asynchronous preload bridge; Renderer IndexedDB cannot be
its cross-restart authority. Future account/workspace keys must supply their
own HTTP/AppServer authority adapter with revision/CAS.
Temporary interaction state such as peek, hover, drag projection and animation
never enters the preference store.

Shell Navigation is the first migrated consumer. Applications Pin, Account
Pin, rail detent, last visible detent, navigation-rail width and left context
sidebar width are installation-scoped.
Applications defaults to unpinned. The legacy `applications: true` value is
not migrated because previous releases automatically persisted that product
default and cannot distinguish it from explicit user intent; other valid
legacy geometry is migrated once. IndexedDB and Electron SQLite both carry
monotonically increasing revisions; Web uses BroadcastChannel invalidation and
Electron publishes change events through its preload port.

Cloud Storage uses the standalone management-page hierarchy adapted from
`codex/chat-demo-v2`: the route owns a stable page title and content boundary.
Its View and navigation contribution are internal-audience only: normal mode
hides both, and disabling developer mode exits an already-open storage route.
This is a presentation gate; storage services and data are not removed.
Anonymous state renders the complete LightVela site selection and sign-in
controls in that content area instead of replacing the page with a bare notice.
Authenticated state mounts the existing TAT file manager for the selected Bot.
This page does not invent local-storage semantics. Skills is a separate full
Workbench adapted from `chat-demo-v2`: public catalog discovery is anonymous,
while installed state and mutations belong to an explicit installation target.
Targets are either the local DSH user root (`~/.opencraft/skills`) or a connected
Hermes Profile; local DSH is never represented as a Profile or Bot. Workspace
discovery additionally reads `<cwd>/.opencraft/skills`, while DSH retains its
native project/user `.agents/skills` roots. Local SkillHub artifacts cross the
AppServer boundary as bounded, checksummed files, install atomically below the
managed root, and uninstall moves the exact entry to recoverable local trash.
Hermes Profile mutations continue through the Profile Skills Host protocol.
For Settings layout, edge-to-edge is an inset policy rather than a scroll
ownership transfer. The persistent AppShell Header remains outside the content
viewport; the Settings viewport keeps `min-height: 0`, stable scrollbar gutter
and the sole vertical `auto` overflow, matching Codex's Header-plus-scrollport
topology. Only master-detail pages suppress that outer scroll and delegate it to
their bounded internal panes. Feature content must not add a second page-level
scroll container merely to compensate for Shell clipping.

Task workspace presentation is specified in [the workspace design](../design/README.md).
The right-panel tab strip owns one dropdown immediately after its existing plus
picker. Its first section lists available creation actions; its second section
lists all tabs in the current owner's region, independent of Browser/Terminal
type. Right-side Browser and Terminal icons remain direct creation shortcuts.
Both menus call the same creation actions; existing entries dispatch activate-tab
without creating resources. No type-group metadata or second tab store is needed.
Duplicate titles retain distinct IDs and display an ordinal; Escape does not
create/switch a resource, and selection hands focus off after the Radix menu closes.
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

### Embedded Workbench Shell

`workbench-web` also publishes a native Web Component entry for embedding the
Workbench canvas without an iframe. The embedding product owns its outer
Sidebar, Explore/Chat routing and page history. OpenCraft owns only the right
canvas: the standard Thread/Draft conversation route, Composer and Header.
The embedded projection omits OpenCraft's Right Panel and its toggle; the full
Workbench keeps that panel unchanged. Embedded Chat does not use the Bot
conversation protocol. The outer Bot identity selects a logical Hermes Host
scoped by both physical instance and native Profile; the canvas uses ordinary
AppServer Thread ownership inside that fixed Profile. Thread list, creation,
resume, history, model catalog, rename and delete must never escape it. Physical
Dashboard/session-token reuse remains instance-scoped, while Composer queue and
other logical Host state include the Profile identity.
The embedded entry constructs the same Application runtime as the full
Workbench, but contributes an explicit, ephemeral LightVela Host profile and
never persists that physical instance identity into the normal Host catalog.

These differences are expressed by a typed Workbench Presentation Policy, not
route- or product-name conditionals. The full policy enables Shell navigation,
context Sidebar, Right Panel and Connector launcher. The Embedded Core Chat
policy disables those four optional surfaces and projects an empty allow-list
for extension-contributed Composer actions. The full policy projects all
Composer actions. This keeps unavailable Web Speech or future optional actions
out of embedded products without component-level product checks.

The host keeps legacy AgentChat authoritative until its explicit rollout
`show()` command enables the embedded candidate. Route visibility alone never
loads or adopts OpenCraft. After enablement, legacy remains visible while the
embedded Host connects, activates its ordinary Thread/Draft, hydrates initial
history and paints; the Web Component's own `show()` then grants its write
lease. `hide()` revokes that lease synchronously without disposing the
Application, so returning to the host-owned Explore view cannot lose
conversation state. Only the visible owner may send,
cancel, approve or answer an interaction. The stable
`/__opencraft/embedded-workbench.js` loader points to a content-addressed Vite
entry; deployments using another static origin must provide the required module
CORS policy explicitly.

Web Host loopback preview uses a page-owned broker plus a same-origin Service
Worker. The worker is deployed at
`/__opencraft/opencraft-host-proxy-sw.js` and its scope is limited to
`/__opencraft/host-proxy/`; it must never control the LightVela document root.
Both ordinary Workbench and Embedded builds explicitly emit this asset because
the Embedded target does not copy the public directory. Frontend artifact
staging treats a missing worker as a build failure, and EdgeOne serves the
stable worker URL with `no-cache` so a release can update its routing logic.

`show()` is a browser-origin-scoped persisted toggle, not a one-way component
callback. One shared feature-state controller owns versioned storage, in-page
events, cross-tab storage reconciliation and a ref-counted global command.
Calling `show()` again disables the revealed surfaces and persists that choice;
page components subscribe to the state and never wrap `window.show` themselves.
The underlying persisted-feature primitive is reusable by other internal
feature gates without copying localStorage/error/event lifecycle code.

An embedded canvas owns one explicit Presentation Root inside its Shadow DOM.
The appearance engine projects the complete semantic token set onto that root,
and every menu, dialog, context menu, drag overlay and panel tab portal targets
the same root. Embedded code must not compensate with global CSS, copied menu
styles or arbitrary z-index overrides; those bypass focus, collision geometry
and theme ownership.

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

The standalone Web bootstrap may select that same account authority's regional
Gateway with `VITE_LIGHTVELA_API_BASE_URL` and `VITE_LIGHTVELA_REGION`; it does
not construct a second account client. The API Base is validated as one absolute
HTTP(S) origin before application startup. The browser entry also installs the
minimal `process.env` compatibility object before dynamically loading the
mechanically generated Hermes closure, matching the embedded loader's runtime
contract without copying Node environment values into the browser bundle.

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

The first concrete external-integration slice is the application-owned
`ConnectorRuntime` plus its `ConnectorCapabilityRuntime` projection, documented in [platform connectors](./platform-connectors.md).
Trusted extensions register Providers through the existing internal contribution
transaction. It borrows Authentication session epochs and Host-owned clients;
the ConnectorRuntime owns logical readiness, explicit Thread selections and execution,
not credentials or native MCP transports. The capability projection derives a scoped,
revisioned search view, returns compact paginated summaries, loads exact schema only on
detail and then issues revocable invocation handles. Web/Electron wire stable
search/detail/compatibility/call meta tools; AppServer receives them through standard
`thread/start.dynamicTools` with `deferLoading`. Composer exposes a dedicated Connector panel, backed
by a domain Manager, Host-native MCP OAuth and a one-shot write approval queue.
Configuration/intended selections use a separate CAS store (Web IndexedDB,
Electron Main SQLite); credentials remain with the Host, and restart restores
intent without automatic connection or execution grants. Native OAuth completion
is uncorrelated by operation ID and never grants conversation access by itself.
This implemented vertical slice does not imply the complete Capability Fabric, reuse of the Hermes Settings
prototype, new native methods in DSH/Hermes, or verified third-party accounts.

The Skills capability surface now hosts a platform Connector Library alongside
Skills/packages. `connector-core` owns the directory and DTOs; `connector-host`
owns Host-private SQLite configuration, credentials and bounded OAuth transactions,
plus the MCP SDK/API adapters. The renderer receives only public projection and
authorization progress, never stored tokens. This managed path is independent of
the existing borrowed native-MCP adapter, which retains its original authority.
The Composer remains a per-conversation selector, not the configuration catalog.
The Octop-derived catalog contains 23 recipes; 19 have execution adapters and four
remain guide-only. Isolated validation is not third-party account qualification.

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

### Bot management ownership

Applications exposes a persistent Bots management View. It consumes the
AppServer Bot directory and explicit Host connection command; selecting a
management target does not change the active chat Host. Create/clone/rename/delete
are gated by Host `botManagement` and per-Bot `management` operations. Dialogs
own only user intent and draft text; Radix owns focus, Escape and delete confirmation.
The same creation entry is used from the Bot sidebar and management page.

Hermes transports own one control-plane mutation port per account/instance,
surviving replaceable bridge generations. The port maps blank creation and
template-based cloning to the existing instance Bot API; it never constructs a
native profile from the display name. Root profile deletion is prohibited.
Creation receipts retain success or failure for a command ID; uncertain writes
are not retried automatically. Semantic revisions increase within the Host port;
fresh-read revision checks and serialized writes are not a CTL cross-client CAS.
Deleted Bot events invalidate open conversation snapshots and block later sends.
Only current Host generations may publish mutation receipts into the directory.

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

### Terminal character metrics boundary

TerminalPanel separates visual inset from its measured xterm host, and that host
also isolates inherited application letter spacing, word spacing and text
transforms. xterm owns font/grid metrics and its internal row compensation; CSS
must not override those internal rows. The terminal explicitly requests zero
additional grid letter spacing. Canvas cell measurement and the DOM width cache
must not see different application typography. WSP-21 acceptance measures full
row text advances and the last-column cursor as well as screen/host boxes.
`smoke:terminal-geometry` mounts the real panel and xterm with only the PTY port
replaced, exercises DPR 1/2, hostile body tracking, widths, wide cells, font change
and visibility, and includes the old inheritance as a failing control. Its
rounding budget accounts for pinned xterm's 32-glyph integer-width measurement;
it does not add layout padding or silently remove columns.

### Conversation terminal semantics

The Host remains the sole owner of PTYs and retained process output. The
renderer application projects those resources through one
`ConversationTerminalSessionRegistry` keyed by Conversation Scope. Its ordered
session directory, most recently activated terminal, Host identity, cwd, shell,
phase and bounded readable buffer are application semantics; xterm and panel
tabs are presentations, not a second process or session authority.

The Terminal panel adapter writes active-terminal changes when a terminal tab
is selected. Selecting Browser or another panel type does not erase the most
recent terminal selection. Closing the selected terminal falls back within the
same Conversation Scope, while releasing the Scope removes every association
and observer. Panel owner IDs and Conversation resource owner IDs remain
distinct.

`read_thread_terminal` is a read-only, no-argument dynamic tool. The calling
AppServer Host ID and Thread ID must resolve through `ConversationBindingStore`
to one Conversation Scope before the current terminal can be read. The tool
does not accept a session ID, enumerate other terminals, inspect xterm DOM or
cross Host/Thread boundaries. Its output is decoded from the AppServer terminal
projection and capped to the latest application buffer; the Host replay window
continues to own longer retention and reconnect truncation.

### Application Router authority

`createApplicationNavigation` in `runtime/workbench-navigation.ts` owns a React
Router data router with no loaders/actions. Electron uses `createMemoryRouter`;
Web uses `createBrowserRouter`. The existing Shell consumes its external-store
snapshot. Connected and hostless supervisors use the same implementation; Views
do not call the browser History API or keep a second writable application route.
Legacy v7 browser metadata is read only as migration input.

Application path, Router entry key, conversation identity and route/View scope are
distinct. `openChat` navigates to the entry's remembered conversation (or hostless
Home); it is not a POP. `navigateToHome` presents a new local Draft. Settings and
extension destinations normally PUSH, explicit invalid-route corrections REPLACE,
and only history controls POP. Router keys supply a known-entry projection for
back/forward. Web saves that key projection per browser session and verifies the
current Router key when restoring it; it is not another path authority. Desktop
memory history lasts for the window, not across process restarts.

`WorkbenchNavigationTransaction` fences preparation by intent epoch, commits only
accepted destinations, and restores the complete prior entry after a failed POP.
Changing routes cancels pending readiness without stopping a live turn. A late
Thread lease is released; late success/error cannot take navigation ownership.
POP to a different View of the same conversation must still restore that View.
Thread/Draft stores, composer state, Host connections and background execution
remain resource owners independent of route history. Shell divider hit targets
start below the toolbar, so pane geometry cannot intercept history controls.

Reference boundaries and acceptance evidence are in the
[application navigation plan](../design/application-navigation/task_plan.md).

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
Shell never falls back to an active remote Host. Global Settings always retains
Appearance; internal developer mode adds Plugins and Laboratory, and Electron
also adds the read-only SQLite inspector described above. EnvironmentDirectory, account discovery and
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
transport phase remain separate. Provider-managed entries carry a typed
`MachineResourceLifecycle` with canonical and raw phases plus explicit action
capabilities; configured Local/manual Hosts carry `resource: null`. Resource
actions route only through the owning source, require a caller operation ID and
fail closed when either capability or handler is absent. `provisionHost()` still
persists a connection recipe and never means cloud allocation. LightVela discovery lives in its plugin's
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

Release renderers use one standard Oxc minification pass plus content-hashed
asset names. They do not enable top-level ultra mangling, repeated aggressive
compression, or a second JavaScript-obfuscator pass over Electron Main,
Preload, or Daemon bundles. Runtime correctness and debuggable failure
semantics take precedence over transforming control flow; source maps remain
outside the public published tree.

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
