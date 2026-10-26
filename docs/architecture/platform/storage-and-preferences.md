# Platform: Storage and preferences

[Architecture index](../../platform-architecture.md) · [Documentation index](../../README.md)

Shared resource authority, runtime fences and platform adapter boundaries follow the [client resource contract](./client-resource-contract.md).

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
Web/remote Hosts use their Host-scoped `fs/readDirectory` picker. Advertised
`workspaceBrowseRoots` select its starting boundary when present. Without one,
the picker starts at the filesystem root so a connected Web user can add an
existing server folder without rebuilding the Web bundle.
Adding a Project requires the selected Host transport to be ready; the menu
explains why it is unavailable while connecting.
An interaction epoch invalidates picker/create results when the draft, Host,
workspace, submission phase or visible route changes. Persisted additions remain
in their original Host catalog, but never retarget a replacement draft.

### Read-only SQLite diagnostics

The sixteen Node SQLite storage kinds use the shared sqlite-node lifecycle;
physical paths and exclusive owners stay separate. A configured Local Agent opens
its five foundational stores plus the existing Tasks file before listening. Its
failure releases handles and rejects startup. OpenCraft Host state opens queue, sender and
enterprise identity tables through one connection/migration owner; attachments have their own file.
Host-private Tasks remain lazy and validate storage before capability success.
SSH management opens only for the configured feature. Private Host failures cannot
publish that Host open; unused optional owners do not prevent default embedded or
headless operation. Electron Main's resource and extension stores remain lazy; account-pool belongs
to the selected embedded or independent Codex owner. Native engine databases,
reserved-section pins, read-only diagnostics and writer locks are not adopted.
`daemon/ready.storage` retains its original five-name projection for old clients;
optional `storageOutcomes` adds complete scoped outcomes. New clients accept both,
and gateway/Headless health project only actual owner opening results. These are
migration dispositions, not claims that every optional engine is initialized.
See [storage lifecycle](../../sqlite-lifecycle.md) for implemented behavior, manual
recovery and verification limits, and [plugin persistence](../../plugin-persistence.md)
for payload migration. This retains node:sqlite without Drizzle; Web retains
IndexedDB. Known database identity handoffs wait for other windows to release
connections within a bounded deadline; the Sidebar adapter closes on versionchange
and startup rollback owns its handle before loading layout rows. Expired migration
opens retain late-handle cleanup and abort late upgrades. Both bootstrap recovery
surfaces classify identity migration failures as local storage failures, preserve
the original databases and offer closing other windows/restarting the browser;
release cache recovery must not run for these errors.
Client-local and Host-owned data have separate authorities; engine-private
databases retain their owners. Code rollback does not restore database backups
or promise N-1 binary compatibility.

The first [Host document API](../../host-document-storage.md) implementation exposes
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
current browser session. Touch sessions can also open it with `?opencraft-dev=1`
(or close it with `?opencraft-dev=0`) on the page URL, which writes the same
sessionStorage flag and then drops the parameter from the address bar, or by
tapping the Settings page heading seven times within three seconds. Plugins,
Laboratory and the Electron SQLite inspector are internal Settings entrances.
Disabling the mode removes them immediately; an active internal-only route
returns to Appearance rather than leaving inaccessible content mounted.
While the mode is on, Workbench Web shows a diagnostics overlay of in-memory
runtime errors, failed requests, environment facts and CSS.supports probes.
Collection starts at application bootstrap so earlier failures remain visible;
closed mode does not change ordinary UI.

Bot product surfaces are temporarily part of the same internal presentation
audience. Normal mode does not project the Bots application, Bot sidebar
entities, Bot creation command, or Bot conversation views. Enabling developer
mode restores them together; disabling it while a Bot view is active returns
to the ordinary Chat route. The extensions and AppServer capabilities remain
loaded, so this audience flag is a presentation policy rather than an
authorization or persistence boundary.

### UI preference authority

`chat.turnNotifications` is an installation-scoped boolean, defaulting to false.
The Application owns a `TurnCompletionObserver` across all registered Clients;
it accepts only validated live `turn/completed` events with completed, failed or
interrupted status. Host/Thread/Turn identity deduplicates the latest 2048
terminal events across Client replacement. History reads and Item phases cannot
trigger reminders. Observer failures never participate in execution ownership.

Web's `BrowserTurnNotifications` is an Application-owned platform port shared
by standalone and embedded RuntimeProviders, independent of product branding,
Host kind and execution engine (including DSH). Chat settings explicitly request
the browser's origin permission in the user's gesture before persisting the
preference; completion never requests permission. Both preference and current
permission are checked again after asynchronous worker preparation. Revocation,
disabled preference, unsupported/insecure environments and disposed owners
cannot emit a late reminder. Denied/display-failure states are visible in settings.
Browser permission is not stored or inferred from the preference.
An embedded host whose presentation omits Chat settings can call the element's
`setTurnNotifications(enabled)` from its own user settings gesture after
`prepare()`. It returns false if permission is not granted or the Application
is replaced during the request; it reuses the same port and preference authority.

Notifications include the corresponding Thread title, terminal status and a
short excerpt of the latest accepted user message in that exact Turn; they never
include assistant answers, unsent drafts or queued future inputs. The observer
derives bounded, Client-owned display context from existing Thread responses and
live Item events without issuing extra history reads. Historical traffic can
seed context but cannot trigger a notification. Missing context keeps the generic
status/return message. Shared Chat user-message semantics remove hidden attachment
instructions and prompt wrappers; Unicode excerpts are bounded to 80 title and
160 message characters. Replacing/removing a Client or changing its physical connection generation discards
its text projection and pending context metadata; completion identity dedup remains
Application-owned across reconnects.
A dedicated hashed, non-inlined notification worker uses a nested asset scope;
it handles neither fetch nor clients.claim and cannot replace the existing host
proxy worker. A sender Client ID handshake and per-Application nonce bind its
click to the originating page and the existing conversation navigation command.
Desktop constructor notifications provide the same click behavior when worker
registration is unavailable. Worker clicks after page closure may reopen only
the saved same-origin page URL. This is not server Push: a closed/frozen page
cannot receive fresh completion events. Browsers lacking notification support,
including some embedded mobile browsers, do not gain it from this adapter.

Workbench UI preferences are owned by one asynchronous, typed
`UiPreferencesRuntime`. Every registered key declares a schema, default value
and subject scope (`installation`, `account`, or `workspace`); React never
chooses or calls a physical store. Web installation preferences use a
Renderer-owned IndexedDB adapter. Electron's loopback origin uses a random port
per launch, so its installation authority is a Main-owned profile SQLite table
behind a restricted asynchronous preload bridge; Renderer IndexedDB cannot be
its cross-restart authority. Account/workspace keys must supply their
own HTTP/AppServer authority adapter with revision/CAS.
Temporary interaction state such as peek, hover, drag projection and animation
never enters the preference store.

`sidebar.serverFilter` is an installation-scoped presentation preference holding
a stable Server ID and display-only label (empty ID means all Servers). It is
restored before Sidebar rendering and never broadens because that Server has no
currently loaded rows. The label neither discovers nor authorizes a Server.
The Server selection is independent of the enterprise identity account-owned participation
filter. Reload restores both explicit on/off participation choices and the
selected Server, including an explicit return to all Servers. The combined
real-Sidebar browser regression uses the production IndexedDB and plugin
local-preference adapters rather than an in-memory preference fixture.
Cached catalog rows remain visible across transport loss; row navigation and
mutation actions require a ready logical runtime. A stale management `open`
observation cannot admit background reads during logical reconnect/error;
phase transitions update availability, and ready refreshes the catalog without
remounting known rows. Authorization/recipe revocation retains its existing fence.

Trusted extensions may additionally use the optional `api.localPreferences`
presentation-only port. The platform isolates product/extension/account and
activation lifetime; the plugin owns verified account selection and its schema.
The current Web adapter is localStorage with last-write-wins and tab invalidation,
not revision/CAS or account synchronization. React consumes plugin snapshots and
actions rather than selecting a physical store. This does not replace registered
Workbench keys or claim a Native/Electron stable-origin adapter. See
[plugin persistence](../../plugin-persistence.md#8-插件的账号本地呈现偏好).

`chat.defaultFollowUpAction` is an installation-scoped `steer | queue`
preference, defaulting to `queue`. Chat settings and the main conversation
Composer consume the same runtime snapshot. The preference chooses the default
intent only while a response is active; idle sends remain normal Turn starts.
It neither creates a Host capability nor enables atomic queued-message steering.
Temporary Side Chat has no durable queue and retains immediate follow-ups.

`voice.inputProvider` is an installation-scoped `auto | system | hunyuan`
preference. Web's default `auto` chooses Hunyuan only after the backend contract
and local recording capability are available, otherwise the browser adapter.
The choice is read once per capture and is independent of model/Host selection;
it grants neither microphone permission nor paid-service access. No speech
credential enters UI preference storage.

Shell Navigation is the first migrated consumer. Applications Pin, Account
Pin, rail detent, last visible detent, navigation-rail width and left context
sidebar width are installation-scoped.
Applications defaults to unpinned. The legacy `applications: true` value is
not migrated because previous releases automatically persisted that product
default and cannot distinguish it from explicit user intent; other valid
legacy geometry is migrated once. IndexedDB and Electron SQLite both carry
monotonically increasing revisions; Web uses BroadcastChannel invalidation and
Electron publishes change events through its preload port.

Cloud Storage uses a standalone management page: the route owns a stable page
title and content boundary.
Its View and navigation contribution are internal-audience only: normal mode
hides both, and disabling developer mode exits an already-open storage route.
This is a presentation gate; storage services and data are not removed.
Anonymous state renders the complete the downstream product site selection and sign-in
controls in that content area instead of replacing the page with a bare notice.
Authenticated state mounts the existing enterprise service file manager for the selected Bot.
This page does not invent local-storage semantics. Skills is a separate full
Workbench: public catalog discovery is anonymous,
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
and the sole vertical `auto` overflow in the Header-plus-scrollport
topology. Only master-detail pages suppress that outer scroll and delegate it to
their bounded internal panes. Feature content must not add a second page-level
scroll container merely to compensate for Shell clipping.

Task workspace presentation is specified in [the workspace design](../../../design/README.md).
Shell chrome paints only its leading navigation/main region and trailing window
actions. These disjoint paint regions derive from the same live pane geometry as
the main viewport, including full-width transitions; the aperture between them
belongs to the panel toolbar, not an opaque full-window header overlay.
The right-panel toolbar owns fixed plus and tab-list controls outside the
horizontal tab scrollport. Only resource tabs and the drag tail scroll; new-tab
and tab-list entry points stay reachable when tabs overflow. Its dropdown follows
the plus picker. Its first section lists available creation actions; its second section
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
| `appserver-session` | AppServer Resume/View hydration and V3 compatibility reader adapter | none |
| `appserver-transport-websocket` | browser, React Native and direct daemon WebSocket | WebSocket only |
| `appserver-transport-memory` | deterministic in-process AppServer | none |
| `appserver-transport-replay` | frame recording and deterministic replay | none |
| `app-host-protocol` | host/generation/lease envelopes outside AppServer JSON-RPC | none |
| `app-host-client` | Renderer-side logical App Host channel transport | MessagePort-like port |
| `app-host-server` | daemon-side physical Host lifecycle and cross-window lease multiplexing | injected transports only |
| `account-pool-host` | Host-private account metadata/secrets, affinity, quota policy and loopback provider proxy | Node filesystem, SQLite and HTTP |
| `daemon-ipc` | authenticated local daemon handshake and framed IPC | Node socket types |
| `chat-core` | host-aware identity and Turn → Frame → Block projection | none |
| `chat-runtime` | Replica-derived Timeline snapshots and command/history ports | none |
| `composer-core` | portable document, target-scoped draft, SubmitIntent and controller | none |
| `composer-appserver` | lossless document compiler and AppServer command port | none |
| `timeline-virtualizer` | Turn window, restore, anchors, follow and spacer policy | none |
| `workbench-runtime` | HostRuntime registry; per-Host client ownership, Thread catalog and Replica/Session orchestration | none |
| `workbench-resources` (proposed) | renderer-neutral resource identity, durable route and presentation contracts | none |
| `extension-contract` (proposed) | versioned manifest, identity, optional access declarations, contributions and RPC | none |
| `extension-runtime` (proposed) | activation graph, owner-aware contribution broker, install/access state and Cordis-backed trusted runtime | none |
| `capability-core` (proposed) | AI-facing Spec, Offering, ModelView, Lease, Invocation and Receipt | none |
| `capability-runtime` (proposed) | catalog, progressive disclosure, resolver, policy, execution router, journal and Draft Lab | none |
| `design-system` | semantic colors, spacing, radii and theme computation | none |
| `design-system-web` | shared Web/SVG progress projection, document animation phase and motion preference cleanup; consumes renderer-free geometry | React and DOM only |
| `composer-editor` | ProseMirror/DOM composer view | DOM only |
| `workbench-web` | Workbench frame, SCSS, Electron/browser adapters | React DOM |
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

### Client resource authority and offline display

`document-storage/client-resources` is the shared asynchronous resource port for
Web/PWA and Electron. A resource has a product/deployment/account namespace, a
domain name, a stable resource ID, a schema version and an explicit authority.
A remote resource accepts successful observations; it is a disposable display
copy. A local resource requires revision-based adapter-accepted commit before the caller
may discard its input. Conflicts, format downgrade and quota failures remain
visible. Local originals are excluded from remote capacity eviction and namespace
cache cleanup; their owning domain decides explicit removal/export.

Application composition selects IndexedDB for Web/PWA and a separate Main-owned
SQLite file for Electron, behind trusted-main-frame Preload IPC. React components
do not choose storage engines. Opening is asynchronous and does not gate Shell or
Host recovery. The shared owner serializes operations, revokes old scope handles
synchronously and orders remote namespace cleanup after in-flight writes. No
credentials are stored in resource values. Browser storage remains evictable; an IndexedDB transaction is an accepted local write, not a backup or permanent retention guarantee.

The first consumer is the sidebar thread catalog: at most 300 display rows per
Host recipe revision and at most 64 remote resource documents per client store
(each document is bounded to 1 MiB). Titles, project labels, recency, lineage and
pins survive reopening; execution state, capabilities, raw history and requests
do not. Cached rows cannot grant interaction. TanStack remains the sole request,
retry and pagination owner. A failed refresh preserves saved rows; a successful
complete empty response clears them. Partial pages retain unseen saved rows until
the live directory is complete. Existing draft, display continuity and outbox
owners are retained; this foundation does not migrate their persistence yet.

This data layer does not provide an offline navigation shell or an offline model.
Service Worker navigation/static-resource policy is a separate layer; HTTP cache
and a saved catalog alone do not guarantee an airplane-mode cold launch.
