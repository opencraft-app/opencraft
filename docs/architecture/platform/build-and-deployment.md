# Platform: Build and deployment

[Architecture index](../../platform-architecture.md) · [Documentation index](../../README.md)

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

The independent headless Linux server archive is a separate deployment of the
existing Local Agent Host, not a new Thread authority. Its Node launcher starts
the DSH-backed Host and serves a packaged Web Workbench from one HTTP server,
bound to loopback by default. The renderer's bundled Host profile resolves `/appserver` against the
actual browser origin at runtime; neither the browser nor the static host owns
the DSH process or its credentials. When employee verification is configured,
`/appserver` also applies the shared Hub identity overlay, advertises the same enterprise identity
metadata capability as Codex/SSH, and verifies the captured submission context at
native admission. Client identity fields cannot establish provenance. Request IDs
and logical-client epochs fence late replies across disconnect/reinitialize;
confirmed creation results keep the original employee even after the client leaves.
A separate `/apphost` WebSocket attaches
browser Clients to the existing Codex Engine Adapter through AppHostServer's
lease/generation contract; Codex's stdio process and account pool remain
Server-owned. The headless service retains that physical Host when the last
browser WebSocket leaves, so mobile sleep does not terminate an admitted Turn;
shutdown of the headless service releases it. The artifact is single-user, with a distinct private data root
and a single-writer lock. Explicit `--host 0.0.0.0` plus the dangerous-mode
acknowledgement allows unauthenticated HTTP on one port for static WebUI and
both WebSockets. Public mode does not check HTTP or WebSocket Origin, so an
HTTPS-terminating reverse proxy can forward to the same listener without
special forwarded-header handling; the explicit unauthenticated-public flag
is the only exposure gate. The
installer defaults to port 80 and grants only `CAP_NET_BIND_SERVICE` for
privileged ports. It adds persistent systemd supervision, not another proxy or
access policy. This direct public mode is not a secure multi-user service and
does not change the private default. The Web entry derives UUID v4 from
`getRandomValues` if `crypto.randomUUID` is unavailable on an HTTP origin;
this does not enable browser APIs that require HTTPS. It does not turn the
typed Client/Hub/Server topology into a multi-tenant Hub or expose native
Electron Preload features. The Web build registers the existing Model Services
View against DSH and Codex Accounts View against the Codex Host, so
configuration remains Host-owned rather than duplicated in browser storage.
The packaged Linux Web Host advertises `/` as the remote browse root for its
DSH and Codex nodes. The browser folder picker reads the Server filesystem via
`fs/readDirectory` and registers the chosen path with that node's Project
catalog; it never opens a macOS folder picker or uploads a client directory.
The root is a navigation hint, not a filesystem permission grant: the systemd
service's OS permissions still decide which directories can be read or used.
An older browser profile seeded with an empty root is updated only when it
still matches the bundled WebSocket endpoint; a custom non-empty root and
unrelated profile fields remain untouched.
The browser Workbench retains one AppServer transport object per Host; if its
`/apphost` WebSocket closes, reconnect replaces the invalid AppHost client and
lease inside that object. Existing Workbench listeners stay attached, while
the new lease reinitializes the logical client. If the service and physical Host
remain healthy, it keeps the same Host generation; service restart or physical
failure produces a new generation. Thread state is re-read from AppServer. The
Web host uses protocol Ping/Pong to terminate a half-open socket, and the browser
bounds the initial AppHost handshake; both mechanisms convert an otherwise
indefinite mobile-network stall into the same retryable transport failure. The
Codex Host logs payload-free logical initialize and Thread resume lifecycle
events so reconnect failures can be separated from history projection failures.
For each browser `/apphost` attempt, the Web client sends a new random diagnostic
ID in the WebSocket query. The headless server logs that ID with upgrade,
hello, Host-connect acknowledgement, heartbeat timeout and close stages; a
legacy client without the query receives a server-generated ID. If the browser
fails before it can read a WebSocket response, it posts only that ID, its
connection phase, readyState, elapsed time and optional close code to the
same-origin diagnostic endpoint. The endpoint rejects unknown fields and never
records the page URL, Thread ID, messages, credentials, IP address, Origin,
raw exception or close reason. These events locate the failing layer; a
browser WebSocket `error` cannot itself reveal an HTTP upgrade status. No
diagnostic event changes Host or Thread ownership or retries.
Both public `/apphost` and private `/ssh-apphost` attempts carry the same random
attempt ID and a public/private channel classification. Upgrade rejection logs
distinguish unavailable SSH management, origin rejection and missing/invalid
session admission without echoing cookies, headers or identities. Frame rejection
logs use allowlisted reasons (binary, JSON, protocol version, renderer/request/
host/lease ID, generation, message type or frame type), an allowlisted message
kind, frame sequence and pre/post-hello phase. Hello diagnostics include only
numeric received and server protocol versions; invalid version values become a
fixed sentinel. Neither malformed field values nor raw frames enter the log.
The diagnostic classifier is the admission validator, so adding observability
cannot silently relax the existing protocol checks. Logging callbacks are guarded
and cannot interrupt normal connections. The socket regression entry is
`tests/shell/apphost-frame-diagnostics.test.mjs`.


Weak-network recovery separates shared connection reachability, per-Host protocol
readiness and per-resource restoration. Web foreground, pageshow and online hints
are coalesced by the shared AppHost socket owner. A negotiated `connectionProbe`
capability enables a bounded, correlated `connection/probe` exchange; old peers
receive no unknown probe message. The server answers probes outside its business
queues. Probe success proves bridge reachability, not engine or Thread readiness.
Hidden pages cancel probe deadlines; old sockets and cancelled probe replies
cannot affect successor connections. The server's protocol Ping/Pong remains a
fallback for detecting half-open connections. Failed probes revoke only Client
attachments, never service-owned execution.

AppHost ready and Host claim waits have finite control deadlines. Timed-out claim
acknowledgements release their original lease; each subsequent attempt uses a new
lease.

Expired claim records still count toward the shared request budget because
late grants retain cleanup ownership. If they saturate that budget alongside
pending requests, the client retires the bridge with retryable
`APP_HOST_REQUEST_LIMIT`; its socket owner then replaces the connection and
all affected Host attachments can recover. Detaching the bridge releases its
claims without stopping service-owned execution. Ordinary in-flight backpressure
without expired claims rejects only the excess request and keeps the bridge.
The generic WebSocket transport settles unfinished connect callers on explicit
close even when no platform close event arrives. Delayed close cleanup and
asynchronous decode failures are fenced to their original socket; neither can
close or fail a successor connection.

Closing one logical channel cancels its own ready/claim wait without
closing the shared client or cancelling service-owned startup. A grant already
in flight is released against its original lease and generation; its completion
cannot overwrite that channel's terminal closed status. Deterministic coverage
exercises close before ready, during shared startup and between grant delivery
and its promise callback (`tests/shell/app-host.test.ts`); the browser origin smoke
also checks late release while a peer remains open on the same real socket.
Closing one logical channel cancels its own ready/claim wait without
closing the shared client or cancelling service-owned startup. A grant already
in flight is released against its original lease and generation; its completion
cannot overwrite that channel's terminal closed status. Deterministic coverage
exercises close before ready, during shared startup and between grant delivery
and its promise callback (`tests/shell/app-host.test.ts`); the browser origin smoke
also checks late release while a peer remains open on the same real socket.

Expired claim records still count toward the shared request budget because
late grants retain cleanup ownership. If they saturate that budget alongside
pending requests, the client retires the bridge with retryable
`APP_HOST_REQUEST_LIMIT`; its socket owner then replaces the connection and
all affected Host attachments can recover. Detaching the bridge releases its
claims without stopping service-owned execution. Ordinary in-flight backpressure
without expired claims rejects only the excess request and keeps the bridge.
The generic WebSocket transport settles unfinished connect callers on explicit
close even when no platform close event arrives. Delayed close cleanup and
asynchronous decode failures are fenced to their original socket; neither can
close or fail a successor connection.

Business envelopes serialize per Host, allowing another Host on the same
socket and connection probes to progress during a slow activation. Local send
cancellation releases its pending acknowledgement without cancelling or replaying
remote execution. AppServer initialization rejects results from a revoked transport.

Workbench Host readiness ends at lease acquisition plus AppServer initialize.
`workbench-runtime/connection-lifecycle.ts` is the single connection owner for
cold start, reconnect and implicit Thread acquisition. It registers attempts and
promises before notifying observers, bounds each attempt, and owns retry tickets,
foreground admission and stability timers. Revocation synchronously invalidates
child sources before publishing connection loss. Readiness commits require the
current client, initialized protocol, open transport, connection revision and
assembled local services. A late initializer cannot cancel a successor retry.
`workbench-runtime/recovery-policy.ts` retains observation and demand-prioritized
conversation recovery; it has no connection timer or writable readiness authority.
Both owners remain scoped to the existing Runtime connection domain. Explicit visible leases recover first; explicit
open leases, running work and unresolved interactions recover in the background
with concurrency one and at most three transient retries. Cache residency and DOM
subscription counts alone do not create recovery demand. A reserved foreground
slot permits a newly visible conversation to start while hidden work is pending.
Making one lease visible schedules or promotes only that binding's existing
recovery task. It does not revalidate peer Threads or restore Host terminals and
file watches. Connection recovery still restores all demanded bindings; explicit
Thread retry retains forced same-connection revalidation.
Semantic Thread failure stays local. Same-connection revalidation forces a real
Resume instead of reusing its previously resumed fast path. A stable 60-second
connection is still required to reset connection retry escalation; cancelled
callbacks are fenced, and manual failures cancel automatic retries. PTY and file
watch recovery do not gate Host readiness. The application binds Host readiness to
host-scoped read-query cancellation and invalidation: active queries refresh,
inactive queries become stale, and existing data remains visible. Stable resource
query keys are retained across connections. This coordination is independent of
menu mounting; late cancelled reads cannot overwrite recovered catalog data.
Execution requests keep their existing admission and reconciliation policies and
are not replayed by connection or cache recovery.

Replica source operations register their generation before the first preparation
await. Disconnect settles synchronization callers immediately; late preparation,
pages, mutations and live-event failures cannot adopt or change a successor source.
Storage writes and clears use one queue across source generations for the same
client/cache key. Accepted external writes may finish after revocation, but cannot
overtake a newer write, and publication rechecks source ownership after storage.
The V3 ThreadView projection remains volatile. Negotiated history and queue
capabilities are read from the current initialized client, not a cold-start copy.
Logical AppHost claim removal precedes remote disconnect notification; notification
failure cannot retain local authorization or close a peer's service-owned Host.
The raw and logical-client Core adapters share a socket owner that revokes before
close and checks its identity after health and socket-open waits. RPC encoding,
synchronous send throws and asynchronous send failures settle the same receipt.

The app-like iPhone Web surface requests a fixed viewport scale for embedded
browsers and keeps focused editable text at a 16px minimum on coarse-pointer
phone viewports. This avoids WebKit focus zoom without changing desktop
Composer density or blocking keyboard focus. Page pinch zoom is intentionally
disabled for this product surface; actual WeChat and WeCom WKWebView handling
must be checked on device because an embedding browser may interpret viewport
scale limits differently.

Electron does not use this HTTP gateway. Its loopback server is static-only;
the application-scoped transferred port described in
[`architecture/opencraft-app-host.md`](../opencraft-app-host.md) is the sole
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

## Managed Web deployment

The public npm release `@opencraft-app/opencraft` owns the website installation,
not the execution lifecycle. A stable HTTP/WebSocket entry process owns update
credentials, npm metadata, the serialized update job and the durable current /
previous release pointer. Compatible versioned Web workers own static delivery
and the external AppServer proxy. A candidate must pass health and build identity
checks before new requests switch; existing sockets lease their original worker
until disconnect. DSH/Codex belong to independently managed execution services.

`@opencraft/web-update-protocol` owns the status and worker compatibility boundary.
The Settings UI reads server status, submits authenticated update intent, and never
holds registry credentials or controls an execution process. Publishing a package,
installing a server version and refreshing a browser are separate actions. See the
[Web installation and update runbook](../../web-deployment.md) for setup, failure recovery
and the stable entry maintenance limitation.

## Managed server updates

The Web bootstrap owns the durable release pointer and update authorization. In explicitly configured server deployments, its execution adapter switches the same release's gateway/daemon through a dedicated systemd unit and checks daemon IPC readiness, release identity and unchanged external core PIDs before committing. A failed activation restores the prior execution release. Startup reconciles interrupted execution pointers against committed deployment state; cleanup retains every execution-referenced release. Runtime cwd, machine identity, credentials and DSH installation remain deployment-owned. Codex core/CLI are never replaced by this adapter. See [deployment contract](../../web-deployment.md#服务器执行端更新).

### Server-owned conversation schedules

Conversation-local scheduling is a Host service with a durable occurrence ledger
and a narrow engine execution port. Views only manage plans and read results;
engines retain admission and execution authority. See [conversation schedules](../../execution-ownership.md#conversation-schedules)
for capability, restart, uncertain delivery, timing and shared-Host authorization
boundaries. Codex and DSH consume `@opencraft/host-schedules` through separate
execution ports; queue support alone does not imply an adapter for other engines.

Schedule presence in the shared Sidebar is a Host catalog projection, independent
of conversation execution status. The multi-Host reader uses capability-gated,
profile/authorization-scoped summary queries and Host invalidation subscriptions;
row components receive semantic summary data only. See the [schedule catalog
contract](../../execution-ownership.md#schedule-catalog-projection).

## Retired implementation audit (2026-10-16)

Private account/environment presentation and its product-facing fixtures are
owned by downstream composition. Removed forwarding wrappers and prototype
connection hooks are not public APIs. Product compatibility exports and stored
account/region identifiers remain with their actual downstream owner; their
presence does not create another core account authority.

The current Embedded Workbench uses Host readiness, binding and Conversation
capabilities. Its old standalone Bot Chat write-lease class had no production
caller; its self-only test and the unconfigured optional presentation gate have
been removed. Bot Chat still enforces the Conversation's read-only descriptor.
Real embedding admission/recovery and product-isolation browser checks, rather
than a detached lease fixture, cover the current composition.

The old demo seed/package subpath, unused identity-color projection, one-way
legacy Composer writer and unused query/convenience exports are retired. The
legacy Composer reader remains because stored drafts still use it. Syntax theme
regressions target the shared React theme implementation directly. Static
no-inbound/unused results are candidates, not deletion proof: executable package
exports, Vite/Metro platform files, workers, generated/shared upstream snapshots
and inline browser-fixture imports are checked separately. In particular, React
imports can be required by the test runner's classic JSX transform even when
TypeScript's automatic JSX analysis reports them unused.


Old navigation source assertions for exact component spelling, toolbar sizes,
header padding and an extracted DSH composition are retired where actual browser
or native provider regressions cover the behavior. The DSH discovery test uses
isolated real files and the installed native registry to check project switching,
shared user Skills and source attribution; omitting project roots fails it.
Authentication, account clipboard/focus and Bot-management fixtures consume the
current platform contract and actual services. Attachment tests reflect the
existing 1 GiB chunked capability and verify transport assembly through both
Codex adapter and local Host; no commercial wire limit is changed here.
Trusted platform Views receive optional `PlatformViewHost.currentUser` from the selected account contribution's authenticated `identity` projection: provider ID, stable subject ID and explicit handle. Display-only names, retained metadata and anonymous/loading/error snapshots cannot supply that identity. The provider owns authentication and revocation; this projection supplies no credentials or resource grants. enterprise identity maps verified staffId/loginName into this shared contract. Tasks uses an exact registered member handle or a client-selected viewing preference; it does not import enterprise identity or infer identity from a name.
