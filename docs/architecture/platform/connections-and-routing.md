# Platform: Connections and routing

[Architecture index](../../platform-architecture.md) · [Documentation index](../../README.md)

### Backend SSH Codex connections

The Node backend can attach to existing Linux or Desktop-compatible HyperNode
AppServers through OpenSSH exec and WebSocket-in-SSH. The existing Codex routing
adapter shares initialize, request isolation, Thread readers and interaction
ownership across local stdio and remote physical transports. Remote mode does not
start a local engine process, account pool or queue dispatcher. With a configured
state directory, OpenCraft owns per-binding Host metadata and attachment display
records in backend SQLite; file staging uses SSH/SFTP against the remote filesystem.
Remote paths are never resolved as local files. Backend SQLite also owns
administrator-managed recipes, pinned trust and encrypted credentials.
Settings drafts are transient; a live read-only profile
overlay never duplicates these recipes in IndexedDB. A separate installation-owner
HttpOnly session gates management and `/ssh-apphost`, with exact Origin and
frame-level revocation checks. Public access requires explicit fixed-HTTPS-origin
or changing-address opt-in; sessions stay bound to their admission Origin.
Default shared installation access bootstraps this session automatically without
an additional key, including after expiry/restart. Every permitted entry visitor
can use saved SSH credentials in this mode; it is not a member ACL. Operators
can require an extra key with `--ssh-require-access-key` or `--ssh-access-file`.
The Application owns bootstrap/renewal and authorization incarnation, not a
Settings mount; known session loss clears old private projections before renewal.
Every private AppHost connection attempt also awaits this owner's coalesced
session check and shared renewal before creating a WebSocket. Recovery does not
depend on foreground discovery timers, and cancelled or disposed attempts cannot
open a socket after a late grant. Access-key mode never bootstraps without a key;
the public AppHost channel does not perform this private admission check.
Legacy servers without the policy declaration still require manual key admission.
Bootstrap never dials SSH or replays connection/execution/file mutations. The
explicit management Connect command uses AppHost's service-owned admission, not
a synthetic Client or separate SSH transport. It grants no execution/answer lease;
connection status remains a projection of the shared physical slot.
The native broker's method-admission policy is independent of SSH framing.
It forwards paginated Turn/Item history as well as native Skills/config writes
and preserves unrelated upstream initialization metadata. The same validated
`opencraft/method-access` extension feeds Runtime resources, submission admission,
command compilation and Composer action resolution. Admission is not upstream
support discovery; unavailable local stores/connection resources remain excluded.
Preferences never manufacture capabilities: an SSH follow-up uses admitted Steer
instead of unsupported Queue, without overwriting the preference; rejection is
before optimistic adoption and cannot consume a draft. Legacy manifest absence
is compatible, while a malformed declaration fails closed.
The application catalog separately consumes authenticated physical readiness to
admit its logical reader through the registry. It does not change the selected
chat target, auto-connect policy or Thread subscriptions. Catalog publication
checks configuration revision and authorization incarnation across async
boundaries; a locked/disabled/removed recipe cannot regain visibility through
a late result. Settings navigation and chat navigation consume this same
application projection rather than issuing menu-local history refreshes. Management
discovery is started and disposed by the Application, not the Settings
View. Visible/online reads are single-flight, completion-scheduled and back off
after transient failures (10/20/30 seconds, capped at 30); successful reads poll
every five seconds. Foreground/online hints probe promptly without dialing a
Server. Authorization changes supersede old reads; command receipts require a
fresh post-command status read rather than joining an earlier poll. A missing
management source due to read failure has its own sidebar retry, even before
there are any SSH Host profiles; unsupported or successfully locked sources are
not errors. Healthy background discovery does not flash a loading indicator.
Chat subscribes to a value signature of catalog rows, availability, authentication,
authorization epoch, errors and discovery phase. Fresh copies of unchanged rows
and healthy poll progress do not invalidate the Chat tree. Connection management
still consumes the controller's complete progress snapshot; authorization and
physical/configuration changes remain immediate, without another writable store.
Runtime
uses the shared read boundary for native indexed SSH discovery, not rollout
reconciliation. Each admitted Host query owns loading/failure and scoped retry;
the sidebar never substitutes an empty success for pending/error or lets one
failed Host erase the others. Reading admission and cached-row visibility are separate: temporary physical
connecting/reconnecting/idle/error states retain already loaded rows in the same
recipe and authorization scope without authorizing new requests or execution.
Lock/logout, removal, disablement and recipe/authorization changes revoke
visibility immediately; scoped query keys prevent reuse across incarnations, and expansion discloses hidden remote rows within the fetched catalog.
The per-Host metadata index uses TanStack infinite-query pages. Each successful
page is committed immediately; navigation projects the available rows and title
search separately tracks directory completeness. Sequential background pagination
continues through every cursor, so older conversations remain discoverable without
resuming Threads or reading messages. Native pin backfill is deduplicated by ID,
with the first page authoritative. Empty intermediate pages are valid; repeated
cursors fail the read. The scoped key distinguishes the paginated cache from
legacy complete-directory response shapes.
Cancellation, retry backoff and later-page failure retain all committed pages.
An ordinary refresh retains its prior snapshot until the refreshed pages succeed.
Status notifications cancel stale reads before patching known cached rows, then
invalidate the directory; paginated data survives this handover. Recipe and
authorization scopes still fence visibility and late results. Directory failure
exposes retry while retaining navigation; search cannot claim an exhaustive empty
result when its metadata index is partial, failed or unavailable. Message search
keeps its own provider/capability/cursor state and does not depend on sidebar row
limits. Goal enrichment and unread catch-up wait for the final metadata page.

The former optional conversation-card overview and its preview readers have been
removed. Overhome is an application route and reads only the extension catalog;
it does not read conversation previews, resume Threads or acknowledge results.
The existing task-board statistics adapter remains independent.

Automatic reconnect uses 500ms/1s/2s/5s/15s/30s/60s delays, capped at 60s.
Connection attempts and inbound server requests have separate owners. A WebSocket
attempt installs its promise and cancellation before publishing `connecting`;
synchronous observers can revoke it before socket allocation. Only that attempt
may clear its promise, and old close callbacks settle before publishing status
that can admit a successor. Abort/close cannot resurrect an already revoked attempt.

An inbound JSON-RPC request owns a delivery receipt and a connection revision.
Its live phases are handling and sending; physical delivery or a matching Host
resolution succeeds the receipt, while connection loss/client disposal rejects
it and aborts queued sends. Both terminal paths remove ownership immediately.
Late handler success/failure cannot send through a successor connection or settle
its receipt. `serverRequest/resolved` only addresses a live request with matching
ID type/value and, when both are known, Thread identity. It leaves no permanent
ID tombstone: a completed request or an earlier connection cannot suppress a
new request after ID reuse. These delivery rules do not replay a mutation or
terminate the underlying server execution.

Connection attempts and inbound server requests have separate owners. A WebSocket
attempt installs its promise and cancellation before publishing `connecting`;
synchronous observers can revoke it before socket allocation. Only that attempt
may clear its promise, and old close callbacks settle before publishing status
that can admit a successor. Abort/close cannot resurrect an already revoked attempt.
Client initialization, deferred transport acquisition and logical Host connection
also install their single owner before notifying synchronous observers. Reentrant
connect calls join that operation. A delayed initializer rechecks close and abort
before acquiring a transport. Outbound request observers can cancel before
encoding or sending; the request must still own its pending entry after each
notification, and a WebSocket checks cancellation before physical delivery.

A Host grant is valid only while its physical transport is open. The server checks
this after activation, before granting and immediately before acknowledging the
claim. The channel retains terminal statuses seen before acknowledgement by their
generation: a matching grant is rejected and released, preserving any manual
failure classification. A different generation neither revokes that grant nor
gives the channel authority. Termination of the shared bridge revokes every
pending channel attempt, including a grant already delivered to its promise.
A late acknowledgement cannot revive a lost Host;
automatic recovery obtains a new claim through the existing retry policy.

An inbound JSON-RPC request owns a delivery receipt and a connection revision.
Its live phases are handling and sending; physical delivery or a matching Host
resolution succeeds the receipt, while connection loss/client disposal rejects
it and aborts queued sends. Both terminal paths remove ownership immediately.
Late handler success/failure cannot send through a successor connection or settle
its receipt. `serverRequest/resolved` only addresses a live request with matching
ID type/value and, when both are known, Thread identity. It leaves no permanent
ID tombstone: a completed request or an earlier connection cannot suppress a
new request after ID reuse. These delivery rules do not replay a mutation or
terminate the underlying server execution.

Default connection and history retry delays use bounded 0.8–1.2 jitter to
spread reconnect bursts. Explicit test clocks or schedules retain exact delays.
Catalog reads rejected by connection preconditions create neither an observed
catalog operation nor query retry backoff. A failure on a later page preserves
the successful first-page observation and already available catalog data.

Short successful connections do not reset retry history: readiness must remain
continuous for 60s. Visible foreground/online recovery hints can advance an
already scheduled retry, at most once per five seconds per Host; they retain
the escalation counter and retain one signal during an active connection attempt.
A successful attempt consumes it; a failed or expired attempt can use it for
one successor validation. Stage/absolute deadlines are rechecked on page wake
and before initialization readiness is cached. Retired Web admission waits
settle locally without releasing physical barriers; late results are fenced.
Production budgets and executable cases are in the [recovery contract](connection-recovery-contract.md). Explicit
user retry remains immediate and manual failures remain blocked.
Protocol incompatibility is a permanent failure for the loaded client. The Web
bridge sends the existing `fatal` envelope with `APP_HOST_PROTOCOL_MISMATCH` and
`retryable: false` before closing a rejected hello; no Host or lease is admitted.
The AppHost client applies the same disposition to an incompatible `ready` and
preserves classified SSH/AppHost errors through both connect rejection and the
terminal event of every attached channel. Runtime cleanup and foreground hints
must not turn this failure into an automatic reconnect. A generic socket close,
including 1008, is insufficient to infer version incompatibility: authorization
expiry has a separate recovery path. Existing loaded clients without this
classification still require an explicit update; the server cannot patch them.
SSH failure diagnostics retain only bounded classification, connection age,
process exit and WebSocket close/error codes; no endpoint, stderr or RPC payload.
SSH reception retains a bounded 100MiB message budget for large Codex history
responses, matching the standard WebSocket receiver budget. Outbound mutations
and backpressure remain bounded at 16MiB; administrator/test overrides remain
backend-only. Frames exceeding the receive budget are a manual compatibility
failure, not an endless link retry.
Transient history read failures (timeout, queue pressure or link unavailability)
use the same bounded three-retry policy for acquisition, reconnect and explicit
revalidation. RPC rejections do not retry automatically. An explicit history
retry wakes delayed work with its current policy and shares an active read;
foreground hints also wake visible non-authoritative conversations. No history
recovery resends a user command or reconnects a healthy Host.
Failed automatic attempts stay in the reconnecting phase, preserving cached
content instead of alternating error/loading UI. Stability timers are generation
fenced and cancelled on disconnect and disposal. Reconnect
awaits the old physical close before admitting a successor, and failed activation
remains observable after cleanup. Anonymous `/apphost` rejects SSH IDs; Renderer IDs and the downstream product login
projections are not administrator authority. Only public fingerprints/configuration
are returned, never saved passwords. Static private key/agent recipes remain a
read-only compatibility source. This is single-installation administrator access,
not member-specific Server sharing. Reset has a physical close/claim barrier.
Closing a page or proxy does not stop the remote daemon, and reconnection does not
replay mutations. Scope, configuration, compatibility gates and limitations are
specified in [SSH Codex Servers](../../ssh-codex-servers.md).

### Hub-owned remote conversation directory

`DurableThreadCatalog` is owned by the existing remote `CodexEngineAdapter` and
shares its per-binding `OpenCraftHostStateDatabase`. It begins only after an explicitly
admitted native connection has initialized. It neither auto-dials an idle Server
nor resumes a Thread. Its lifetime is the server-owned physical slot, independent
of a browser/Sidebar mount; close aborts reads before the DB owner closes.

Canonical `thread/list` requests using updated-at descending order and ordinary
active/archived scope read this durable index with opaque keyset cursors. Cold
reads await the initial successful directory sync; warm reads return saved metadata
immediately while the service revalidates. Advanced filters, native cursors, other
sorts and explicit scan/repair requests retain native protocol semantics. This is
not a replacement for every native query or an offline transport admission path:
a cold browser still requires an admitted initialized route. It does not grant
execution or expose a disabled/revoked recipe's private data.

The service pages metadata-only active/archived native lists, uses an overlap on
updated-at for incremental refreshes every minute, and runs a full reconciliation
at least hourly while connected. Pages stage until a successful scan boundary;
partial/failed scans keep the previous directory and successful watermark. Only a
successful full scan can retire absent rows. Live metadata and deletion events
advance a local revision so a response started earlier cannot resurrect or overwrite
them. Reopen retains the previous successful projection and sync status. An optional
`catalog` response sidecar reports success time and current state; a failed refresh
shows a saved-data notice, not an empty successful directory. Directory completion
broadcasts `opencraft/thread-catalog/changed` to initialized readers; token deltas
never invalidate the catalog. Native bodies and execution stay on the Server.

### Machines, Work in and Agents

The presentation below describes standalone Web/Electron. Downstream embedded
Work in/machine and icon gating remains unfinished; standalone implementation
and earlier upstream validation are not embedded acceptance evidence.

A machine is a presentation group of logical Hosts, not a Host replacement.
The daemon creates a random UUID once in `<resolved daemon dataDirectory>/machine-id`
(desktop: the directory resolver's `dshDataDirectory`) and reports it through
`runtime/machine/read`: `{ machine: { machineId, name, platform }, agent }`.
`platform` is `macos | linux | windows`; `agent` is `OpenCraft | Codex` for the
current daemon adapters. Both daemon Hosts report the same machine object.
`name` defaults to the OS computer name (macOS ComputerName, otherwise hostname);
a deployment may set it with `--machine-name <name>` (trimmed, at most 64
characters, no control characters). The name is display-only and never changes
`machineId`. Headless also accepts `OPENCRAFT_MACHINE_NAME`, with an explicit
`--machine-name` taking precedence. An independently running DSH Host uses its
operator-owned `machineName` configuration; configure both processes consistently.
Server-managed recipe overlays forward local machine observations to the base
metadata store without editing recipe revisions or asserting SSH machine identity.
The extension is declared in the handwritten OpenCraft method map; upstream
Codex-generated types remain upstream-owned. Identity-only App Host leases do
not initialize or start an engine; native initialize remains unchanged for normal
runtime connections. The Local Agent also exposes the identity supplied by its daemon.

The client caches the latest report with its Host profile, including for
activation-owned profiles (metadata persists, the connection recipe does not).
Identity observations do not increment connection-recipe revisions. Missing or
unsupported reports leave each Host in an independent unknown-machine group.
Probes, initialization and reconnects share one observation generation; superseded
reads cannot overwrite a newer report, and transient failures do not erase the
last report. Only reported `machineId` establishes grouping; URLs, names and hostKind never
establish equality. Provider-managed `MachineResourceLifecycle` entries remain
separate cloud resources with their existing lifecycle copy. Host and
`(hostId, threadId)` identities remain unchanged.

The standalone Web/Electron composer always shows **Work in**, even for one machine. Web uses the
reported machine name; Electron's builtin daemon uses **This Mac** on macOS or
**This computer** otherwise. Sidebar provenance uses the same name and hides it
when only one machine is available. Agent models are grouped within the selected
machine; multiple profiles for one reported Agent use the current connection
when available, otherwise the first enabled profile, without merging logical
Hosts or Threads. Inactive engine catalogs load only after the model menu is opened.
Cloud resources remain visible but unselectable while not connectable.
Manage models links are exposed only for the matching registered Settings owner
(`local` Model Services / `local-codex` Codex Accounts).

Changing Host creates a new Host-owned Draft/View through the application Router,
transferring its current document, attachments, context, options and selections
after activation. Inline images and same-machine staged files remain usable;
uncompleted attachment processing and files belonging to another machine remain
visible with a localized unavailable state and prevent submission until replaced.
Attachment removal retains the original staging Host owner. Same-machine Agent
changes preserve cwd and project selection. Machine changes keep a project only
when its workspace directories exist on the target machine. They reuse a matching
target Host project ID without creating records; unmatched catalogs and Hosts without the Project API keep
the verified folder without a fabricated project ID. Missing directories clear
the workspace. The current Agent is retained
when available, otherwise the target machine's first Agent is used. New intents
cancel prior preparation; project retargeting cancels an in-flight placement
change even during its navigation preparation; late connections cannot navigate or apply a model to
the replacement draft. This does not move existing Threads, introduce a remote
server connection flow, or forward model credentials between machines.

### Browser Host-profile upgrade recovery

The Web Host-profile database releases its connection on `versionchange`, so
another page can perform a schema upgrade. An older page that still retains a
connection causes a recoverable startup error on `blocked`; an open request
without a terminal event fails after ten seconds. The startup boundary asks the
user to close the site's other tabs/windows and reload, without displaying raw
storage diagnostics or deleting configuration. Rejected opens abort any delayed
upgrade and close late database handles; failed initial loading also releases its
connection. HTTP and HTTPS are separate browser storage origins, so one can
upgrade while the other is blocked by its own existing tabs.
Vite preload failures also include module-evaluation errors. The preload listener
must leave BrowserStorageError unhandled so the import rejection reaches the
application startup boundary; it must not swallow it or cover that boundary with
a release recovery screen. Before React starts, the HTML recovery surface uses
a storage-specific message without a release-version lookup or automatic reload.
Opening diagnostics record only the store role, opening/upgrading phase, elapsed
time, schema versions and DOMException name. Runtime error reports retain those
fields and add `userAgent`, layout viewport (`innerWidth`×`innerHeight`) and
`sourceRevision` when the current document exposes them. The `url` is origin plus
pathname only. Swallowed Sidebar layout persist failures and thread-catalog load
failures use dedicated `sidebar-layout-persist` and `thread-catalog-load` sources
so they reach the same report path and in-memory diagnostics ring. Reports never
include saved profiles, database contents, endpoints, credentials or query strings.
Timeout is not evidence of an upgrade lock: a request that emitted no events and
a request stalled during migration remain distinguishable. No database deletion
or silent memory-backed configuration saving is used.

A hosted Web installation with an explicitly available server-managed connection
catalog and enabled deployment recipes can continue after a typed storage-open
failure. It exposes only deployment/activation-owned recipes alongside the live
server catalog, reports nonfatal storage diagnostics, and displays a dismissible
notice with reload recovery. Browser-owned recipe edits/deletions are rejected;
unread saved profiles are neither replaced nor migrated into memory. Reload after
the browser recovers reads the original database, including customized recipes.
Standalone clients, hostless deployments, and malformed stored configuration
retain the startup failure boundary. This recovery does not bypass server login,
Host authorization or desktop input grants.



### Configured unknown-machine display names

Managed Web operators may set `OPENCRAFT_MACHINE_DISPLAY_NAMES` to a JSON map
of exact Host IDs to machine display labels. The worker injects the validated
`machineDisplayNames` deployment field before application startup. For a Host
without a reported machine identity, its configured label replaces only the
“Unknown machine” prefix; its connection displayName remains after the separator.
Reported machine names and cloud resource names keep precedence. These aliases
never supply a machineId/platform/Agent or affect grouping, routing or authorization.
The application reads this immutable presentation configuration once; no browser
profile or backend connection recipe is rewritten. Unconfigured Hosts keep the
localized unknown label.


### Local connection diagnostic propagation

TransportFailureDisposition optionally carries immutable, locally generated
connection diagnostic metadata. The browser renewable lease captures its exact
WebSocket port when acquiring the lease, so a successor cannot replace the old
lease's attempt ID/time/cause. Fatal classification, retry permissions and wire
protocol remain owned by existing AppHost/runtime code. Only local connection
metadata reaches recovery presentation; backend errors/payloads are not copied.
See [recovery details](../chat-ui/history-and-recovery.md#recovery-technical-details).

Initialization failure cleanup retires the physical client but retains its local
diagnostic status as a snapshot fallback until the next attempt starts. This is
presentation metadata, separate from automaticReconnectBlock and never read by
the reconnect scheduler; factory cleanup therefore preserves the first failure
ID without creating another retry policy owner.

### Connection conformance and external waits

The proposed [recovery transition contract](connection-recovery-contract.md)
adds executable lifecycle-signal, progress and expiry cases. It is design/test
work, not a change to the current retry policy. Its real-owner TODO assertions
and strict failing mode explicitly track the remaining implementation gaps.

An independent observable specification replays deterministic event traces through
ConnectionLifecycleOwner, Runtime/RPC and Runtime/RPC/AppHost. Compare phase,
error presence and timer ownership after every event, including suspended clocks,
late completions and retired timer callbacks. A seed and event prefix reproduce a
failure. This bounded refinement check does not prove all implementation traces.

Revoked service assembly stops waiting for external acquisition or dial. Failed
bundles detach shared fields and registry claims before async cleanup; each late
acquired resource disposes itself without touching successor fields. Transport
factories must provide independent generations. This does not declare an
uncancelable external operation physically complete.

ReplicaClient storage is a disposable paint cache, separate from source authority.
A configurable five-second storage deadline switches that client instance to
source data without further cache writes and exposes cacheError. Accepted writes
retain their physical serial lane; timeout does not cancel them. A late cache
completion cannot publish or reenable writes. A settled load or commit rejection,
including invalid cached state, takes the same nonfatal source-authority path and
queues one best-effort removal of that client row for a later instance; timed-out
I/O is never raced by repair. clear still rejects when cache health or completion
cannot be established. Source protocol and authority-storage errors remain errors;
this policy never skips an authority transaction or replays a mutation.

Physical AppHost startup, close and reset barriers remain serialized. Their callers
have a twenty-second admission deadline: expiration returns a classified manual
failure instead of an endless reconnect, without releasing the physical barrier
or starting a competing generation. After the dependency actually settles, an
explicit retry can be admitted normally. This is bounded failure, not a claim
that an unavailable external process has recovered.

Connection admission bypasses the per-host frame I/O queue and enters the slot
owner directly, so a hung prior close/send cannot prevent its deadline from
starting. Frame sends retain their ordered queue and revalidate lease identity.
History reads acknowledge admission to their bounded reader without waiting for
the RPC result. Native isolated reads and cached transcript hydration deliver
their replies independently, so slow history cannot retain the ordered frame
lane ahead of Resume or other commands. Cached hydration admits at most 64
outstanding reads and rejects overflow with a retryable history error, without
an unbounded detached queue. Reset/close and logical-client epochs
fence late replies; this does not retry requests or change mutation ordering.
The default twenty-second slot budget precedes the bridge's thirty-second wait
and Runtime's sixty-second attempt budget.

`smoke:connection-process-recovery` exercises the complete built/installed Web UI
with a separate synthetic physical Host process. Three actual child-process
restarts while Chromium is frozen must recover after resume, retain the real
Composer draft, and reconnect on page reload without starting a Thread or Turn.
Set OPENCRAFT_LIFECYCLE_WEB_ROOT to that artifact's web directory. This checks
real process/network/browser composition with synthetic protocol data; it does
not claim live-user, real-model or physical-mobile acceptance.

The Electron Main and Preload bundled together use `opencraft:get-window-fullscreen`, `opencraft:window-fullscreen-changed` and `opencraft:set-window-appearance` for internal window projection. The renderer methods, payloads, admission checks and window lifecycle are unchanged; these channel names do not alter persisted identities or the AppHost transport.

### Remote Host visibility for new conversations

A remote recipe may set `hideFromNewChat` in its existing server-owned JSON
configuration. The remote connection editor saves this Host-level setting with
its normal revision check; older records omit it and remain visible. An older
editor omitting the field preserves a previously saved value. The management
and authenticated catalog projections carry the preference to the live profile
overlay; it is not copied into a second writable browser preference.

New-conversation machine/Agent choices and automatic fallback exclude hidden
Hosts, including a remembered selection with no existing Thread to restore.
Starting a new conversation from a hidden Host chooses an eligible Host and does
not carry the old Host's filesystem/project identity. Existing conversations,
retained drafts, history catalogs, management Connect and execution admission
remain available. Changing only this presentation setting does not reset the
physical connection or interrupt executions. If no eligible target exists, the
client exposes its existing hostless/management surface instead of silently
selecting a hidden Host. Visibility is not an authorization policy.
