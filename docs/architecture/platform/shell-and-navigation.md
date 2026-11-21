# Platform: Shell and navigation

[Architecture index](../README.md) · [Documentation index](../../README.md)

### Overview scene handoff

Conversation routing and panel selection remain semantic owners. Overview motion
uses a local `SceneTransitionOwner` to lease the Shell's temporary allocation;
it does not own a second tab directory, chat runtime or terminal process.
Each lease identifies the owner, target and transition, and progresses through
preparing, ready, committing and committed (or cancelled).

Preparation requires both a measured nonempty home allocation and content
readiness. The mounted primary chat acknowledges content with its allocation,
without waiting for authoritative history. Tools acknowledge through their
renderer when required, otherwise through their mounted layout. A readiness
promise resolving does not make a lease permanent: its cancellation signal and
owner identity remain valid through the eventual selection commit.

The Shell derives staged foreground and panel content from the lease while
selection remains unchanged. Pane animation suppresses independent motion while
the lease owns allocation, including its final release; no handoff revision
counter is used. Responsive space still controls single-pane versus split
presentation and never changes resource ownership or persisted selection.

The same handoff contract applies to primary chat (including a new-thread draft),
Side Chat, terminal, files and browser raster covers. Shell owns the final home
rectangle and semantic safe-area context. A selected retained source prepares
its existing DOM at that allocation before expansion, not at the thumbnail's
aperture; the flight owns only projection, clipping and compositing. After
readiness, motion reads the prepared destination again rather than trusting a
parked pane's old rectangle. Window, safe-area and renderer/dock allocation
changes rebase that same flight through the active lease; layout notifications stop on cancel/commit. Handback
synchronously rechecks that home and prepares a borrowed source before painting
the endpoint, so a resize delivered after readiness cannot wait until release.
It releases the projection and input exclusion, not a second content layout.
Allocation flags and dock reservations apply during preparation, even though
controls remain noninteractive; lazy toolbar loading does not define capacity.
A retained preview is a live cover only after its source is physically borrowed,
not merely because its wrapper exists.

Borrowing cannot remove the home reading allocation. The content owner declares
`primaryReading`; Shell retains and projects that semantic independently of DOM
placement. A draft must not acquire transcript-only bottom bleed, including when
a resident Side Chat has its own reader. The generic retained source does not
detect conversations or manage Shell reading flags. Insets consumed inside a
retained view follow its inherited layout context, not a physical Shell ancestor.
This does not move chat/terminal/file resource ownership into the scene owner.

The existing Motion driver performs geometry and clipping. Its completion must
commit through the same lease. Physical frame cleanup, selection and modal
dismissal execute within that handoff; cleanup aborts cannot revoke allocation
halfway through a successful commit. Superseding selection, owner release,
missing targets and cancellation revoke preparation and prevent late commits.
Acquisition validates the caller before revoking another lease; already aborted
or obsolete owners cannot cancel a current preparation. It then reserves its
intent before cancelling the previous lease. Cancellation
notifies synchronous consumers, which may issue a newer request or dismiss the
overview. When the interrupted acquisition resumes, it must not overwrite that
newer intent, even if no lease is currently published.
Retiring visual flights may finish returning to their cards but own no selection.
The retained DOM registry still owns attachment, scroll and selection restoration;
the provider still carries the same animation's chrome tail across modal unmount.

Evidence: `tests/shell/scene-transition.test.ts` and the motion/lease modes of
`scripts/smoke/shell/smoke-tab-overview.ts`. They test interrupted preparation,
post-ready owner replacement, responsive retargeting and actual retained views.
`smoke-overview-scene-handoff.ts` compares the real flight endpoint, home,
retained DOM and global content coordinates across synchronous handback and later
frames (including draft, cancellation and viewport changes before/during flight).
`smoke-overview-tool-handoff.ts` covers actual tool destinations, renderer readiness
and resource continuity. These contracts do not claim every animation on every
physical device is verified.

### Workspace file Explorer ownership

The resource tab identifies a browser session by its stable entry resource. Its
current location is a separate navigation receipt in durableRoute.params.location;
title and recovery location are updated together without changing the logical
resource or releasing the tab. Reopening the entry preserves this receipt and
any dirty/preview guard. Tree, search and Markdown links use one open-location
intent. Source locations reach the editor. Breadcrumbs and copying paths use
Host paths, never client-local directory access.

WorkspaceSessions belongs to the built-in panel plugin. Browser state is scoped by
Conversation owner, Host and tab: location, query, tree visibility, expansion,
keyboard activity, scroll and per-file editing mode. All file previews start
with the tree collapsed; explicit toggles survive navigation. Hiding/searching
keeps the tree mounted. Embedded read-only previews own a private session, remain
tree-free and expose no search, watches or writes.

Documents are shared by owner/Host/path, independently of connection generation.
A document owns its observed baseline, draft, save transaction and conflict state.
Views never write files directly. Switching files preserves drafts; each browser
retains up to 16 recently used CodeMirror states, including selection, scroll and
undo history. Inactive clean document baselines are bounded to 16 per scope;
dirty, saving and currently viewed documents are never evicted by that bound.
Closing a browser with dirty or saving documents is disabled and its preview tab
is pinned. The Unsaved action opens the list of affected files; save or discard
re-enables closing. Browser unload warns when drafts exist. Logical owner release
is final teardown; drafts are memory-only and are not claimed to survive a process
restart. Late completions cannot recreate a released owner.

Saving captures the file identity and submitted text. A preflight read refuses
an already changed disk baseline; edits made while saving remain dirty against
the acknowledged text. A connection generation change during preflight rejects
the write. The current fs/writeFile protocol has no revision precondition:
preflight is not atomic compare-and-swap and an external write can still race it.
Write acknowledgement and cache refresh are separate outcomes. Save failures keep
the draft; cached read failures keep the viewer mounted and offer retry.

Query remains the only directory/read-snapshot cache. Both directory and content
queries include the runtime/Host/connection read scope already used by Blob
resources. Watches are reference-counted within the QueryClient owner, released
by their final consumer (including late acquisitions), and invalidate only the
matching generation's affected resource, parent listing or changed subtree.
Manual refresh remains available when watches are unsupported or fail.

A pure tree model sorts each data revision and projects expanded directories into
flat rows. Only visible rows, overscan and the accessibility descendant mount.
Row height is measured from the shared density hit-target token and used by both
row placement and viewport calculations. Search uses a cancellable lease per
query intent, so late results/completion from A -> B -> A cannot overwrite the
current search. Opening results retains the query; clear-search restores the tree.
Search and directory failures have explicit retry paths.

Blob URL ownership, read-only download, Markdown/HTML isolation and the existing
Office/PDF/media renderers remain at their established owners. Download exports
the original file, never an unsaved draft. No new filesystem mutation or conditional
write capability is advertised by this client refactor.

Evidence: tests/shell/workspace-sessions.test.ts, workbench-panels.test.ts,
workbench-resource-readonly.test.mjs and scripts/smoke/resources/smoke-workspace-file-tree.ts.
Chromium smoke covers real AppShell/panel/editor components with a synthetic file
port, desktop and touch contexts, light/dark themes and 5,004 directory entries.
It is not physical-device or deployed-Host verification.

### Embedded Workbench Shell

`workbench-web` also publishes a native Web Component entry for embedding the
Workbench canvas without an iframe. The embedding product owns its outer
Sidebar, Explore/Chat routing and page history. OpenCraft owns only the right
canvas: the standard Thread/Draft conversation route, Composer and Header.
The embedded projection exposes an initially collapsed Right Panel for webpage
and conversation file previews. Its action allow-list contains only the browser
launcher; its resource renderer is read-only and omits filesystem browsing, search,
watches and editing. Full Workbench capabilities remain unchanged. Embedded Chat does not use the Bot
conversation protocol. The outer Bot identity selects a logical Hermes Host
scoped by both physical instance and native Profile; the canvas uses ordinary
AppServer Thread ownership inside that fixed Profile. Thread list, creation,
resume, history, model catalog, rename and delete must never escape it. Physical
Dashboard/session-token reuse remains instance-scoped, while Composer queue and
other logical Host state include the Profile identity.
The embedded entry constructs the same Application runtime as the full
Workbench, but contributes an explicit, ephemeral the downstream product Host profile and
never opens or writes the normal Host catalog. Its fixed profile store is an
Application-local adapter, including machine identity observations; connection
recipes and the execution target remain owned by the embedding product.
On startup it restores only a Thread remembered for that exact Host identity;
Thread memory additionally uses the current account/region authority. Unbound
legacy selection keys remain untouched and cannot select a conversation for a
different account or Profile; native history is retained.

These differences are expressed by a typed Workbench Presentation Policy, not
route- or product-name conditionals. The full policy enables Shell navigation,
context Sidebar, Right Panel and Connector launcher. The Embedded Core Chat
policy disables Shell navigation, context Sidebar and Connector launcher, while
restricting Right Panel renderers to browser and read-only resource previews and
Composer actions to voice input. `executionSelection=fixed`,
`machineManagement=false` and `runtimeHostConfiguration=false` also prevent Work in,
Agent/machine/settings entry points and reject configuration/retarget actions
before effects. Host-default Composer catalog writers explicitly do not write
runtime model configuration, including after submission or reconnection. The
existing Router remains the sole navigation authority. The full policy projects all
Composer actions. This keeps unavailable Web Speech or future optional actions
out of embedded products without component-level product checks.

The domestic console uses embedded OpenCraft Chat by default. The
international console retains AgentChat. The host passes an in-process session
accessor to the component; credentials are never HTML attributes or copied to
OpenCraft localStorage. Account metadata stays in memory. The console remains
the login/logout owner, and embedded startup never consumes its OAuth callback.
Vendored RepositoryContext requires injected account-bound repositories and has
no module-level default initialization that could consume a host OAuth URL.
Session replacement or logout synchronously revokes the old accessor and hides
and disposes its component before another instance can borrow the new session. Entering the domestic Chat route
loads OpenCraft; a neutral loading surface replaces legacy (which is not
mounted) while the embedded Host connects, activates its ordinary Thread/Draft, hydrates initial
history and paints. Connection failures retain the same Application and Host so its
automatic recovery can complete; they never silently restore legacy. The host projects
`opencraft-connection` phases and offers `reconnect()` without remounting a painted
canvas. A module/application startup failure before adoption offers a fresh startup retry. The Web Component's own `show()` then grants its write
lease. `hide()` revokes that lease synchronously without disposing the
Application, so returning to the host-owned Explore view cannot lose
conversation state. Only the visible owner may send,
cancel, approve or answer an interaction. The stable
`/__opencraft/embedded-workbench.js` loader points to a content-addressed Vite
entry; deployments using another static origin must provide the required module
CORS policy explicitly.
For the downstream Pages release, the Embedded Workbench remains an independent
Vite target and is staged under the same-origin `/__opencraft/` subtree beside
the Next export. It is not imported by the Next application bundle and is only
requested when domestic Chat is active. The release build fails closed when the
reviewed Embedded artifact is unavailable, so legacy fallback cannot disguise
an incomplete production artifact.

Resource preparation starts at the domestic host Chat route after authentication,
before the Next entitlement/Bot gate and lazy settings page, alongside Bot
discovery, through the same lightweight deduplicated loader used by the migration
surface. The actual domestic rollout authority, not hidden-tool preferences,
enables both paths. Loading code never bypasses the entitlement gate for content.
It registers the component but creates no Application or Host; the confirmed
instance/Profile binding still gates the single canvas owner. Failed speculative
loads are retryable by the surface. Optional Host Proxy startup runs independently
of chat readiness. Remote loopback Browser navigation instead waits for its own
proxy registration to activate; it never falls back to client-local localhost.
Embedded Vite `assets/a-[hash][extname]` resources have immutable one-year cache
headers in the Pages artifact. Stable loaders, version files and Service Workers
remain revalidated; publishing must continue retaining old content-hash closures.

The authenticated domestic Chat route may also prepare a physical enterprise service connection
from the intermediate result of its existing instance-list read, independently
of the slower per-instance Profile catalogs. A sole discovered instance that is Running or an
explicit verified root-instance selection is required; a named Bot among several
machines is not enough to guess its physical target. The enterprise service API retains ownership,
Running-state and active-Pass checks. No extra Application/account service is
created, and the preparation sends only enterprise service handshake: no PTY, Dashboard
bootstrap, loopback health probe, Profile tools or AppServer RPC.

This in-process preparation capability is owned by the route/session discovery
generation and is bounded to 15 seconds while unclaimed. Navigation, discovery
replacement and credential changes revoke it; late HTTP/socket results cannot
revive it. The confirmed Profile's normal provider/preflight and fresh instance
validation still run. Only a matching account, region, instance and API base can
claim the same multiplexer exactly once. Adoption enables the formal transport's
ordinary health probing and transfers disposal responsibility to that transport;
the preparation binding and multiplexer configuration are owner-held snapshots,
not borrowed mutable caller options. Health configuration must succeed before
the transfer commits, so failures still leave a resource that can be disposed;
the route's old preparation owner cannot close an adopted Host. Failed, expired,
lost or already-consumed preparations use the ordinary connection path. The
capability is not stored in profiles, HTML, browser storage or a global pool.
Older independently deployed Embedded artifacts without the static preparation
API keep their original startup path. Dashboard ensure remains a post-adoption
Host operation because it can start or replace an owned remote backend.

The Embedded Application owns one deferred startup lane for Voice,
Collaboration, Bot Chat/Management presentation and the Terminal panel module.
The element releases that lane after its first visible `show()` handoff has
painted; repeated `show()` calls do not activate a second copy. The required
account/instance/Profile validation, WebSocket and Hermes providers remain in
bootstrap, as do Terminal session/tool services needed by protocol capabilities.
Only optional presentation modules move behind chat readiness. They activate in
dependency order through the existing ExtensionSupervisor/Panel runtime; failure
does not revoke an already usable chat. Full Workbench defaults to its existing
eager startup policy. This is an Application startup plan, not a second
Application, speculative Host, or general extension activation-event dispatcher.

Retirement aborts pending optional module scopes before factories can acquire
resources. An in-flight activation is drained before borrowed services,
registries or the Host are disposed; its own Supervisor owns activation and
rollback deadlines. Module waits are bounded, and late imports after timeout or
retirement cannot install into the retired Application. A hidden/disposed element
cannot release a stale paint callback's startup lane.

ExtensionSupervisor closes admission synchronously at its first disposal call and
revokes pending activation APIs before waiting. All disposal callers share the
same completion or cleanup failure. Already admitted activation/deactivation
operations drain before active extensions unwind in reverse order, so rollback
can still borrow its providers. Factory and internal-commit results transfer
resource ownership before checking retirement. Late optional module results
cannot activate or rewrite the retired Supervisor's diagnostics. Existing
activation/cleanup deadlines still bound trusted asynchronous work; this does
not forcibly terminate arbitrary plugin code.


`show()` is a browser-origin-scoped persisted toggle, not a one-way component
callback. One shared feature-state controller owns versioned storage, in-page
events, cross-tab storage reconciliation and a ref-counted global command.
Calling `show()` again disables the other revealed surfaces and persists that choice;
page components subscribe to the state and never wrap `window.show` themselves.
This command does not change the domestic Chat owner.
The underlying persisted-feature primitive is reusable by other internal
feature gates without copying localStorage/error/event lifecycle code.

Trusted build composition selects an explicit, immutable presentation policy
(`WorkbenchWebBuildFeatures.presentation`), independently of product identity.
The build validates and serializes icon style, default theme ID and hidden builtin
theme IDs; the renderer reads it synchronously before its first appearance snapshot.
Public defaults use the standard icon adapter and Neutral theme. A custom identity
alone never changes artwork, palette defaults or the catalog. Existing async client
product entries keep their account/engine lifecycle and need no additional export.
Saved theme intent and existing storage/theme IDs retain their previous authority;
an unavailable selection uses the configured fallback without overwriting storage.
Presentation is not permission, routing or account authority.

The downstream product's embedded and standalone Web entries keep the pre-backport
glyphs and their consumer-specific scales; core keeps the new artwork. Shared metrics and the
semantic Web icon adapter own sizes/strokes. The classic adapter retains the
existing glyphs; `workbenchIconMetrics.classic` names their scale without
dispatching on a product ID. Tokens are projected onto each
Presentation Root; the downstream product does not globally override explicit consumer-owned strokes.
A color palette such as `opencraft.core.canvas` never grants product capabilities or selects
an icon family.

Standalone core rail density scopes its icon dimensions to the rail navigation
and footer, not the common sidebar column that also contains Settings. Its compact
desktop rail remains 16px while core Settings retain the 14px navigation role.
the downstream product keeps explicit legacy consumer dimensions (15px navigation, 16px
Settings); a core rail token must not shadow its Presentation Root policy.
The existing product presentation adapter projects the optional consumer-size
override; Shell consumes that override with its own density as fallback, without
selecting a commercial product by ID. A root returning to standard clears the override. Shadow composition supplies
the same explicit policy to its React presentation context and root-token adapter.
The full product-isolation browser checks the selected **Settings** action against
the fixed legacy Settings reference and retains Palette/SunMoon family assertions.
Home/New chat replaces the previous Start/Chats split, so the first current-page
glyph cannot serve as a Write oracle.
Draft preservation, machine/model changes, palette independence, embedded owner
lifetimes and mixed-root checks remain separate assertions in the same fixture.

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
[`plugin-architecture.md`](../extensions/plugin-architecture.md).

Trusted product composition owns its account service, identity-provider adapters
and private service clients. Optional engine/UI consumers borrow that authority;
retiring a consumer does not sign out or dispose the account. Core owns the
Application lifetime and invokes the product lifecycle through
`ClientWorkbenchProduct`. Public builds do not instantiate a product account.

Account changes invalidate product credential/cache scopes and retire old
consumer work. Late reads or mutations cannot update a replacement scope.
Resource-loading failures are not evidence of logout, and independent consumers
do not create another token store. Private service endpoints, IM channels and
product business policies are documented with their downstream implementation,
not as core platform capabilities. Retired product features do not establish an
implemented core collaboration channel. Core Actor/Hub collaboration remains
subject to the implementation limits in the charter above.

`AgentCapabilityRuntime` is an optional AI-facing consumer of that platform. It exposes
searchable capabilities rather than packages, progressively loads model
context, issues Task/request-series-scoped leases, routes invocations to local/SSH/MCP
providers and records exact receipts. Extension activation never implicitly
adds every contributed Tool or Skill to a model request. The full design is in
[`agent-capability-fabric.md`](../execution/agent-capability-fabric.md).

The first concrete external-integration slice is the application-owned
`ConnectorRuntime` plus its `ConnectorCapabilityRuntime` projection, documented in [platform connectors](../extensions/platform-connectors.md).
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
This implemented vertical slice does not imply the complete Capability Fabric, new native methods in DSH/Hermes, or verified third-party accounts.

The Skills capability surface now hosts a platform Connector Library alongside
Skills/packages. `connector-core` owns the directory and DTOs; `connector-host`
owns Host-private SQLite configuration, credentials and bounded OAuth transactions,
plus the MCP SDK/API adapters. The renderer receives only public projection and
authorization progress, never stored tokens. This managed path is independent of
the existing borrowed native-MCP adapter, which retains its original authority.
The Composer remains a per-conversation selector, not the configuration catalog.
The connector catalog contains 23 recipes; 19 have execution adapters and four
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
`HostConnectionProviderRegistry` accepts trusted transport factories and optional
Composer command adapters (see below);
`HostRuntimeRegistry` lazily creates and exclusively owns complete Host
runtimes. A provider lease is held for the lifetime of every runtime it
created, so plugin reload cannot invalidate a live connection. Web currently
ships `opencraft.websocket`; Electron and Expo may register platform-specific
providers without changing Host, Thread, Session or Replica semantics.

Adding a Host is `validate provider config → persist profile → register lazy
runtime`. Removing one is `reject active work → detach registry identity →
dispose runtime → delete profile`. The Profile Store is seeded from deployment
configuration only when empty; after that, IndexedDB is the Web authority.

## Fixed navigation entrances

The related contracts are grouped in the [architecture index](../README.md).

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

History contains resource references, not evidence that a Draft still exists.
At Web bootstrap, the URL/current Router entry is resolved before choosing a
global last-used conversation, and the Router and initial activation consume the
same effective target. Host profiles validate Host availability, ScopeRegistry
validates retained Drafts, and BindingStore resolves durable promotion aliases
to canonical Threads. An expired unsubmitted Draft is not recreated under its
old ID. Global last-used preferences (including changes from another tab) cannot
override a valid current-entry target. Explicit embedded memory navigation starts
at Home and never reads or writes the containing page's conversation history.

The same resource projection validates later restored entries. Invalid references
fall back to the actual retained View, keeping its Composer; promoted aliases may
retain their original View. A View already bound to another Scope must not be
reused. Only the Router REPLACEs corrected entry metadata, preserving the current
Settings/Extension destination. The transaction consumes these corrections as
restoration events even when a POP is normalized into REPLACE.

`WorkbenchNavigationTransaction` fences preparation by intent epoch, commits only
accepted destinations, and restores the complete prior entry after a failed POP.
Changing routes cancels pending readiness without stopping a live turn. A late
Thread lease is released; late success/error cannot take navigation ownership.
POP to a different View of the same conversation must still restore that View.
Returning to the already retained View, by Chat or POP, presents it locally and
resumes readiness in the background; a newer intent or disposal fences and
releases late preparations. Selecting the current sidebar conversation from
Settings uses this same return operation, not a new View or a network-gated
selection. Submission ownership guards remain in force.
Navigation intent, committed route and physical activation readiness are separate
projections. `getPendingLocation`/`subscribePendingLocation` publish the accepted
target before asynchronous View lookup; Sidebar selection consumes that target,
then the committed route identity, never the connection coordinator's pending
resource. Failure, leaving and account reset clear only the current intent.
Confirmed retained Views can return locally from a different conversation;
preferred-history membership alone cannot authorize that fast path.

Navigation publishes an attempt identity, destination and preparing/committed/
presented/failed/cancelled phase. Destination identity is not request identity;
a stale result or paint callback cannot advance a newer attempt, even when both
point to the same conversation. Legacy pending-location projection remains for
row selection only; its disappearance is not proof of visible content.

Shell starts the existing 500ms mobile drawer travel with accepted intent. It
registers one optional departure driver using the shared Motion engine: the
existing content and its page overlays consume actual mobile drawer progress,
reaching zero alpha when the drawer closes. Docked layouts use a visual-only fade.
As soon as target preparation completes, departure is interrupted and commit
proceeds without waiting for any animation duration. Matching target paint starts
an arrival from the outgoing opacity, with duration proportional to the remaining
alpha (up to 80ms); a fully visible cached handoff is already complete. The
ready-to-visible target is 100ms including final paint: 20ms is reserved for
ordinary frame scheduling, not added as a delay. This is a presentation budget,
not a guarantee against browser/OS long tasks or a wait for data readiness. This
visual feedback does not block input. Motion-owned body and page overlays disable
CSS transitions in every phase, so global reduced-motion duration overrides
cannot add a second opacity transition at handback. Preparation latency
and animation clocks are independent; no minimum dwell is imposed. No loading cover, DOM clone, new
resource owner or independent content slide is used. Committed target content
stays transparent/inert until a matching View/attempt visible-content callback;
empty/error and local Draft states acknowledge their own rendered presentation.
The acknowledgement remains functional if telemetry observation was aborted
in the background. Hidden documents and reduced motion do not wait for a visual
animation; detaching the presentation driver releases its outstanding gate.

A failed attempt fades the retained original view back in and shows an inline
retry notice. Cancellation and newer attempts revoke old callbacks. Reopening
a mobile drawer during the same preparation does not make a stale completion
close it. Docked desktop/tablet sidebars stay open; no editor focus is requested.
Focus routing includes the Shell page-overlay host as well as root/sidebar hosts.

History traversal consumes the same explicit retention-owner proof as selection:
restore a retained View locally, then acquire physical readiness in the background.
Router alone owns POP indices and rollback; local restoration never pushes a new
history entry. Cold/invalid targets still prepare and fail with the existing
ownership fences. Evidence: navigation-presentation.test.ts,
sidebar-navigation-intent.test.ts, workbench-navigation-router.test.ts and
smoke-sidebar-selection-handoff.ts cover concurrent preparation/departure, matching
paint, failures, history traversal, supersession, touch/desktop, reduced motion,
real opacity frames and manual reopen.

Sidebar and other selection adapters express only `selectConversation`; they do
not decide whether a Thread is already selected, whether pending hydration should
be deduplicated, or whether Settings requires Chat return. The transaction owns
that decision: reuse the remembered entry's View (or the actual retained View),
coalesce an in-flight destination only when its View also matches, and no-op only for the presented View with no
competing destination. `navigate` remains a distinct explicit-open operation, so
different history Views of one Thread keep independent Composer documents.
For a completed sidebar A→B→A cycle, the transaction remembers the last
successfully presented View per canonical conversation in a bounded preferred
map. It validates that input slot against its account-bound draft owner, not
just the 20-View presentation cache. Failed or superseded preparations never
publish a preferred View; POP updates it only after acceptance. Draft eviction
forgets the slot, and account revocation clears the map and fences pending work.
`ConversationDraftOwnerRegistry` owns at most 50 nonempty input slots and their
original Controllers independently of View/Scope resource caching. It does not
retain Thread or Host leases. Physical editing/submission protects input;
unprotected slots are evicted in last-used order, releasing attachment resources
and deleting document continuity. Empty editors are not content slots. Scope
promotion updates all retained slots, including ones with no cached View.
Unsubmitted New-chat Scope metadata also queries that input ownership: its
20-empty-record budget cannot evict a Scope with retained input. Empty history
records remain bounded separately and confer no retained-content authority.
All preparations use one intent/lifetime/Router-revision eligibility check and
one accept-or-release path, including local Draft readiness and promotion. A
promotion must originate from the still-active Draft and capture its View before
awaiting; an inactive Draft cannot supersede a newer navigation. Last-used
preferences are written only for still-current accepted command results, never
used as a second selected-conversation or route authority.
Thread/Draft stores, composer state, Host connections and background execution
remain resource owners independent of route history. Shell divider hit targets
start below the toolbar, so pane geometry cannot intercept history controls.

Reference boundaries and acceptance evidence are in the
[application navigation plan](../../../design/application-navigation/task_plan.md).

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
[Local Agent custom providers](../execution/local-agent-custom-providers.md). Model edit drafts
survive View reattachment and must be applied before saving a connection. A
capability-gated draft endpoint probe uses only explicitly entered credentials,
does not mutate the runtime and is not a substitute for full runtime validation.
The page is absent when that extension/platform contribution is unavailable; the
Shell never falls back to an active remote Host. Global Settings always retains
Appearance; internal developer mode adds Plugins and Laboratory, and Electron
also adds the read-only SQLite inspector described above. EnvironmentDirectory, account discovery and
persisted Host profiles remain runtime services used by Chat and providers, but
they have no built-in application navigation or creation UI.
Downstream desktop account restoration runs asynchronously after extension
activation. The product session adapter chooses its account storage key and
owns its token format, former session cleanup and fresh-login policy; the public
desktop does not create a private product account. The Main-process
`PrivateStorage` port uses plaintext files protected by directory 0700/file 0600
permissions, not encryption or protection against same-account processes.
Writes use private temporary files and atomic replacement; keys and file types
are validated. The renderer has no filesystem port or durable token storage.
Product session cleanup must preserve generation/abort guards so cancelled
saves and late restoration cannot undo sign-out. Core source naming changes do
not rename private account files or decrypt former product sessions.

## 会话顶部信息

手机宽度（不超过 640px）不展示会话标题旁的 Project/工作区附文，标题与操作按钮保留。桌面继续展示附文。已有“…”菜单的会话详情以只读方式展示实际项目名与工作目录：优先当前会话执行信息，目录尚未恢复时可用同一会话的规范 Thread 元数据；未知字段不伪造，不更改执行目录或启动会话。

会话信息使用共享 InformationPanel 两行元数据和 ModalSurface 自适应呈现：可用视口不超过 640px 为贴底 sheet，超过 640px（含 iPad 常规横竖屏和宽分屏）为至多 420px 居中弹窗；不按设备型号或 UA 分支。标题、右上关闭与目录复制均本地化，不保留重复底部关闭栏。长项目名/路径完整换行且可选，目录复制沿用共享控件的成功/失败反馈与非安全上下文回退。Radix 继续拥有模态、焦点、Escape 和遮罩关闭；窄屏仅顶部手柄拥有下拉关闭，短拖/取消回弹，不拦截信息区的选择与滚动，减少动态效果关闭进出动画。下拉手势由Web平台可选AdaptiveSheetHandle持有，与信息内容一起按需加载，通用ModalSurface不将手势实现加入首屏。主题、排版与触控命中尺寸由共享设计系统持有；不更改会话或执行状态。

### File browser launcher

The built-in resource panel contributes `workspace.files.open` through WorkbenchPanelService toolbar actions. Both the empty right panel and new-tab picker project this same action. It opens the current toolbar context cwd as a retained resource tab (not a replaceable preview), reusing WorkspaceResourcePanel tree, Host filesystem and file preview. Repeated launches reuse the directory tab. Missing cwd omits the action; no client filesystem or guessed root is substituted. Embedded core chat retains its explicit action allowlist and read-only renderer.

### Shell content-plane shape ownership (2026-10-22)

The theme supplies `contentCornerRadius`; Shell projects it through the shared
`data-app-shell-content-plane` role on both the main reading Frame and the
RightPanel body. A conversation, browser, file viewer or empty launcher does not
choose its own pane shape. The tab strip/header stays outside that content plane.
Existing overflow on each plane clips child paint and pointer hit testing at the
same rounded border, and the preview upper-lip shadow follows that border.

A content plane is distinct from the animated reveal aperture and the tool's
layout viewport. Its shape never changes the viewport dimensions, surface
identity, scroll owner or control lease. Main/preview and regular/maximized modes
consume the same theme token; themes without that capability keep zero radius.

### Overhome and miniapps

The legacy `/overhome` route remains a stable URL for the registered
`opencraft.overhome.view` extension view. The existing Application Router owns its
history and retained Chat return reference. Opening the desktop or a miniapp
hides Chat presentation without recreating its draft, Host or execution owner.
Mobile projects the same action before sidebar search and dismisses the drawer
on launch. It does not depend on the former overview preference.

A miniapp is a trusted extension's declarative navigation contribution with
`surface: "applications"`. `MiniAppContribution` has a stable extension-owned ID,
name/localized name, semantic icon, order, platform/audience and a View or Settings
target. Extensions register through `api.navigation.register`; the existing
activation transaction, immutable registry and owner disposal govern publication
and withdrawal. Overhome projects only currently registered, renderable targets
for its platform and audience; a catalog entry grants no Host/data permission.
A command is not a miniapp launch target. Missing renderers/targets are omitted,
and an empty catalog has a real empty state rather than fabricated apps.

Overhome owns the icon grid, labels, focus and scroll. Miniapps own their content,
data and lifecycle through existing Views/Settings. This first version registers
Scheduled tasks as the single built-in miniapp, opening its existing Host-scoped
catalog and editor. It neither creates a sample schedule nor introduces another
scheduler, install/download service, remote-code runtime, or app permission model.
The miniapp surface describes launch, not a sandbox ABI; existing MCP Apps keep
their independent iframe/security lifecycle until explicitly adapted.

Future miniapps use the same registration instead of adding desktop branches.
The Shell's normal navigation retains other contributed destinations; a Settings
page explicitly registered as a miniapp is launched from Overhome instead of
being duplicated in the primary tool list. Backend authorization and existing
Settings deep links remain unchanged.

#### Desktop presentation and launch motion

The application desktop is a wallpaper-backed launcher, with white app labels,
raised squircle artwork and a glass Dock. Its search filters the live miniapp
projection; Dock shortcuts use existing Chat, app search and Appearance actions.
The document page's large title/description is not part of this presentation.
The Design System owns desktop artwork, material/accessibility fallbacks, icon
geometry and spring parameters. Shell's `surface` projects that backdrop into
both desktop chrome and the moving mobile page; one paint plane spans safe
areas and content. Document themes remain authoritative inside app windows.

`ApplicationDesktopProvider` owns only the most recent launch target and measured
icon/aperture geometry. It invokes the existing Router immediately and performs
no delayed navigation. `ApplicationRouteMotion` observes committed routes in both
Host and zero-Host shells. A launched app expands from its actual icon; returning
to Overhome contracts it to that origin. Reversing a transition retargets the same
spring. Resized apertures use a fade instead of stale geometry. Exiting surfaces
are inert and hidden from assistive technology; the retained Chat subtree and
its execution/draft owners stay outside this transition plane. Focus returns to
the launcher only when the desktop is still current and no other control took it.
Reduced motion removes zoom/stagger/press movement; reduced transparency and
forced colors use the shared opaque material. Animation never supplies permission,
changes a catalog entry, creates a task or writes another history implementation.

## Unified bottom navigation density

The unified desktop-layout footer consumes shared density tokens rather than a
fixed desktop enlargement. Compact mode uses the existing 36px application
control role, 20px footer glyphs, 4px block padding and 4px action gaps. Touch mode
keeps a 44px hit floor, 24px footer glyphs, 12px padding and 8px gaps. The footer's
icon and block-padding roles do not resize adjacent Settings or labeled mobile
navigation. Avatar canvases follow the footer glyph plus one spacing unit.

The installation touch-friendly preference and coarse-pointer default remain
the single density owner. Explicit compact mode works on touch-capable hardware;
clicks, taps and mouse movement never replace that choice. Shell retains route,
portal, list-scroll and draft ownership across preference changes. The real
AppShell probe is `scripts/smoke/shell/smoke-footer-density.ts`.

### Applications in the context sidebar

Application pages that otherwise leave the context sidebar empty expose the live
miniapp catalog as flat icon-and-name navigation rows. Miniapp Settings targets
keep this same list instead of switching to general Settings navigation. Chat
retains its conversation list and general Settings retains its section list.
The sidebar and desktop consume `projectMiniApps`, including platform, audience,
renderer availability, ordering and extension retirement. Selection follows the
Router; launch invokes the existing View/Settings host and dismisses a transient
sidebar through the Shell. Long labels truncate with their full accessible name;
the list scrolls within the existing context pane and has a real empty state.

The normal Applications entrance now lives at the top of the left context pane
and toggles its inline catalog without navigating away. The catalog is also
available above Chat and general Settings context, so it never requires opening
the wallpaper desktop first. Board is an application contribution; products
register their own applications through the same extension contract. The global
right header, floating drawer header and footer do not duplicate this entrance.

### File search index lifetime

Opening a file browser acquires only a local search handle. The shared AppServer
controller starts remote indexing on its first non-empty query, stops the native
session when the query is cleared, and starts it again only for a later query.
Controller disposal stops every owned native session, including starts acknowledged
after disposal. Late query failures cannot recreate a released session.

File searches require a project directory. The controller rejects filesystem roots,
broad machine storage roots and Linux kernel/device trees before submitting an RPC.
This lexical check is a client resource guard, not server-side canonical path
confinement or a bound on the upstream index size. Normal project paths and the
older one-shot AppServer protocol remain supported.
