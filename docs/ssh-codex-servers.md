# SSH Codex Servers

The OpenCraft backend can attach to an existing Codex AppServer through system
OpenSSH. The same exec transport handles ordinary Linux and the Desktop-compatible
HyperNode protocol: eight-byte sentinel, login-shell payload and a WebSocket
upgrade to `/rpc` inside the SSH stream. It does not require TCP forwarding or an
OpenCraft installation on the remote machine.

## Ownership and supported surface

- The administrator binds a stable `ssh:<name>` Server ID to one authorized remote
  principal/namespace. Address, credential rotation and connection generation do
  not create new Thread identities. This is the current single-user direct topology,
  not a multi-tenant Hub implementation.
- AppHostServer owns one physical connection per configured Server. The existing
  CodexEngineAdapter routing implementation is shared by local stdio and remote
  transports: one physical initialize, type-preserving logical request IDs,
  Client incarnations, Thread readers and one interaction owner. Remote mode does
  not start a local engine process, account pool or queue dispatcher. When a
  state directory is configured, OpenCraft keeps per-binding Host metadata and
  attachment display records through `OpenCraftHostStateDatabase` and
  `OpenCraftMessageAttachments`. These backend stores do not own remote execution
  or account credentials; staged file content is transferred over SSH/SFTP.
- Disconnecting a page revokes its routing/answer lease, not a remote Turn. Closing
  the service closes only its SSH/proxy connection; no `pkill` or remote stop is sent.
- Basic native model/Thread reads, creation/resume, turn/start, native turn/steer,
  interrupt and stateless remote filesystem RPCs are forwarded. Native rejection
  remains a rejection: generated types are not evidence of a server capability.
  Configured SSH/SFTP storage enables remote attachment staging. Local accounts,
  queue v2, Goal orchestration and PTY/watch/search connection resources are
  **not exposed** until their remote ownership paths exist.
  The first-turn durability extension is a broker policy for native Codex, not a
  claim that remote storage is transactional.
- SSH framing is transport, not a second definition of native Thread history.
  The shared-native broker surface owns one method-admission list, including
  `thread/turns/list` and `thread/items/list` for paginated recovery, `skills/list`
  and `config/batchWrite`. Its `opencraft/method-access` v1 initialization extension
  projects that same list to Runtime and Composer. This is **bridge admission**,
  not a guarantee that every upstream version implements every native method:
  an upstream rejection remains authoritative. Upstream initialization metadata
  and unrelated extensions are preserved; extensions requiring unavailable local
  stores or connection-handle routing are omitted rather than advertised falsely.
- Runtime refuses unavailable submissions before Conversation adopts a draft or
  creates an optimistic queue item. The command port also checks before compiling
  attachments/context. Queue refreshes, watch/search and configuration controls
  consume the same admission fact, not `hostKind` guesses or successful reads.
  Composer resolves a follow-up preference among admitted actions: native SSH
  currently offers Steer, not OpenCraft queue operations, even when Queue is the
  saved preference. The button and inverse shortcut agree; the preference itself
  is not rewritten. No available follow-up action means the draft stays editable.
  Legacy Servers without a manifest retain existing behavior; malformed manifests
  fail closed. Read-only schema/real-target probes are not mutation or inference
  verification. Regression coverage is in `tests/resources/ssh-native-surface.test.ts` and
  the built Workbench SSH smoke (synthetic SSH exec, real broker/client/UI).
- Initialization expires silent upstreams and bounds logical waiters. The remote
  request ledger is capped at 1,024. Short requests have a 30-second expiry;
  native `thread/fork` preserves Workbench's no-fixed-deadline contract and is
  retained only within that bounded physical generation.
- SSH/server heartbeats and bounded connection/probe deadlines detect half-open
  links. AppHost owns physical replacement on reconnection, with a new generation;
  the Client reinitializes and restores Thread snapshots. No execution/file mutation
  is replayed. A lost write receipt means an unknown outcome, not permission to retry.
  This first version does not add autonomous background dialing without attachments
  or cross-process interaction persistence.
- Host identity reconciliation reads chronological `thread/turns/list` summary
  pages (at most 100 Turns), preserving native message IDs without downloading
  tool bodies. Turn-scoped reconciliation searches recent summaries and stops
  at that Turn. Catalog discovery must not flood the shared SSH connection with
  complete Item histories just to recover participant identities.

## Trust and credentials

Host keys must be verified before connecting and supplied through a known_hosts
file. The transport always uses `StrictHostKeyChecking=yes`, no forwarded agent,
no arbitrary SSH config/ProxyCommand and no automatic enrollment. Unknown/changed
host keys, authentication failure and missing compatible Codex require intervention;
temporary link failures remain retryable. Wire status preserves that distinction.

Key authentication and an explicit backend SSH agent are supported. Password mode
uses a credential resolver plus an owner-only, temporary Unix socket and askpass
helper. The password is never placed in process arguments, environment variables,
protocol stdin, config JSON or diagnostics. A config may reference an existing
owner-only password file; OpenCraft does not create it or copy the credential.
This is OS permission isolation, not encryption against same-user processes.

The default management authority is the backend installation administrator, not
the Renderer or a downstream product's account projection. The Settings **远程连接** page
automatically obtains an eight-hour HttpOnly, SameSite=Strict session in the
default `shared` access mode. Operators can select `access-key` protection with
`--ssh-require-access-key` or `--ssh-access-file`. This session authorizes the installation's configured
Servers; there is no per-member sharing ACL yet. Management HTTP writes require
an exact Origin matching the session's admission address. `/ssh-apphost` verifies the same session at upgrade, every frame
and outgoing reply; logout/expiry closes the socket. Anonymous `/apphost` rejects
all SSH IDs, including guessed IDs and forged Renderer names. Local anonymous
features remain separate and usable.

Public SSH requires an explicit opt-in: a fixed HTTPS origin via
`--ssh-public-origin`, or `--ssh-public-access` for operator-approved changing
addresses. The latter accepts HTTP and HTTPS without an installation-wide
domain pin and binds each session to the admission Origin. In shared mode every
visitor allowed to reach this entry can use the installation's saved SSH connections;
it is not an account-level permission system. Invalid/opaque Origin and cross-site
requests are rejected; possession of a Renderer ID alone grants nothing. Cookies remain
HttpOnly/SameSite=Strict and use Secure when admitted through HTTPS. Plain HTTP
provides no transport encryption and exposes the session (and optional access key) to network
observers; this explicit option is not a secure public multi-user deployment.
Forwarded headers, hiding controls, or putting an anonymous endpoint behind a
reverse proxy do not grant remote authority. A backend restart revokes sessions
but preserves saved connections. A status response identifies the selected grant's
`authenticatedOrigin`, including when the browser omits both Origin and Referer.
Origin-free reads prefer protocol-specific grants before legacy cookies, so an
old or invalid legacy cookie cannot mask a newly issued grant.
The Web application compares that origin with its own address before exposing
private discovery. A mismatch obtains a current-origin grant in shared mode;
access-key mode remains locked until explicitly unlocked. Legacy backends that
omit this metadata retain their existing contract. No forwarded header supplies
authority, and WebSocket admission remains exact-Origin.
Shared clients automatically obtain a new session;
protected clients unlock management again. Session bootstrap is not SSH Connect,
Thread execution, or replay of a lost mutation. Revoking browser
access or deleting a connection does not stop remote work or erase remote files.

Settings-created connections are saved transactionally in
`<data-dir>/ssh/connections.sqlite`. Metadata, pinned host key and encrypted
password share one revision/CAS commit. Passwords are write-only and AES-256-GCM
encrypted; the private `credential.key` is outside the database and is required
for recovery. If that key is lost, recovery fails rather than generating a
replacement that cannot decrypt saved credentials. Back up both using an offline or SQLite-consistent procedure, not
by copying a live `.sqlite` while ignoring WAL. This protects a copied database,
not against a process with the backend owner's permissions or a full-directory
compromise. The database has an immutable schema baseline/checksum ledger; an
unknown or conflicting history is rejected without clearing saved data.

Adding a connection first scans a bounded ED25519 candidate and requires explicit
fingerprint confirmation. Scanning is not trust. The candidate is endpoint/session
scoped and expires. Address, port and remote user are immutable for an existing
Server ID; a different remote identity must be added as a new connection. Editing
name, directory or password preserves identity and requires the current revision.
An omitted password retains the previous secret; it is never prefilled.

The list projects actual transport status. Saving/enabling does not claim a
successful connection: an idle recipe is shown as not connected, not indefinitely
connecting. The explicit Connect action admits a service-owned connection through
the same AppHost physical slot without selecting a chat target, granting a Client
lease, or creating a Thread. Concurrent service/Client activation shares startup.
The Application's sidebar catalog observes the authenticated management
projection. An enabled, revision-matched `open` Server admits a logical catalog
reader through the existing Host registry, without changing the selected chat
target or the saved auto-connect policy. An idle recipe alone never dials the
remote. A selected, already-ready logical connection also admits discovery;
physical status polling can lag that readiness. Every asynchronous catalog read
rechecks recipe presence/enablement/revision and the authorization incarnation
before reading and before publishing. Lock, deletion, disablement or logout/unlock
cannot publish a late response from the old admission. This lists native history;
it does not resume a Thread or claim execution/interaction ownership.
Discovery has Application lifetime: leaving Settings does not stop reading
connection status. One in-flight status read is shared by manual retry and
foreground/online hints, with the next poll scheduled after completion (five
seconds on success, 10/20/30-second capped backoff on temporary failure).
Hidden/offline pages pause polling and probe when active again; disposal removes
timers/listeners and aborts reads. Authorization changes fence and cancel old
reads; no background read races an unresolved unlock/logout receipt. Mutations
still run only explicitly and are never replayed; their status refresh supersedes
pre-command reads. When startup discovery fails before SSH profiles exist, the
sidebar offers a source-level read retry instead of silently treating them as
absent. Healthy status polling is visually quiet, and unsupported/locked success
is not shown as an error. The backend remains the connection/configuration owner.
SSH Runtime catalog reads use native `thread/list` with `useStateDbOnly: true`:
interactive discovery reads the existing index instead of scanning/reconciling
rollout files. This policy is shared by sidebar, selected-Host paging and archive
readers; explicit repair callers may override it, but empty/error results never
silently trigger a scan. Provider/source filters keep their native defaults.
The sidebar owns presentation only: admitted loading shows the shared neutral
spinner, failure has a Host-scoped read retry, and neither is reported as an
empty catalog. A failed refresh retains cached rows from that Host and successful
rows from others. Retry rechecks live admission without connecting an idle
recipe or selecting/resuming a Thread. Revoked readers cannot paint cached rows.
Cache keys include the profile revision and SSH authorization incarnation, so
unlocking again does not reuse results from the prior session. Non-SSH caches
are independent of SSH authorization changes.
The default merged ten-row view explicitly counts hidden remote rows in its
expansion entry. It expands the fetched catalog (currently the first 50 per
Host), not all filesystem history; indexed discovery is not an index repair tool.
Failed startup remains visible after cleanup instead of reverting to idle.
Reconnect resets and then establishes the successor backend attachment, not the
remote daemon; active clients can reacquire it. The management list continues to
read status while row-local commands run. A reset barrier fences old sends/claims and waits for physical
close before accepting successor claims. Reconnect rechecks authorization and
configuration revision after that barrier, before admitting a successor. Lost mutation receipts are unknown
outcomes, never automatic retries; refresh and inspect before resubmitting.

## Backend configuration

For a loopback deployment, management is enabled with shared access by default.
No extra access key is created or read in this mode; existing key files are left
untouched. Set `--ssh-require-access-key` to enable protection and generate/reuse
`<data-dir>/ssh/access.key` (0600), never printed by the service.
Supply `--ssh-access-file /private/access.key` to enable protection using an existing high-entropy
private key. It is independent of the remote SSH password. Deliver it only through
a trusted administrator channel. Public deployments choose a fixed HTTPS origin
or explicitly enable changing addresses. Shared mode intentionally grants every
allowed entry visitor use of saved remote credentials. Choose key protection or
an authenticated private entry when that is not acceptable.

The first management form supports password authentication. Existing backend
key/agent recipes remain compatible through a private (0600), owner-owned JSON
file using `--ssh-servers /absolute/path`. These appear as read-only
configuration-file connections after session admission; they are not silently imported into
the database or copied into browser storage. Example (documentation-only paths):

```json
[
  {
    "serverId": "ssh:development",
    "displayName": "Development",
    "hostname": "192.0.2.40",
    "port": 22,
    "username": "developer",
    "knownHostsFile": "/private/ssh/known_hosts",
    "authentication": { "kind": "key", "identityFile": "/private/ssh/id_ed25519" },
    "workspaceBrowseRoots": ["/workspace"]
  }
]
```

Optional `codexExecutable` and `codexHome` are explicit remote absolute paths;
changing Codex home changes the history/credential namespace and must be intentional.
Optional `socketPath` selects a verified existing native Unix socket using
`codex app-server proxy --sock`; omit it for the default socket and for HyperNode.
No bootstrap/install/upgrade/start strategy is implemented. A server without an
existing compatible proxy target is reported unavailable, never silently converted
to a connection-owned stdio AppServer.

The Application projects authenticated records as a read-only, live overlay on
the existing profile store/provider. Settings mutations update the target list
without a reload; managed recipes are never persisted in IndexedDB. The View
owns only drafts, one mutually exclusive menu and row-level operations. Credentials
are not retained in the controller's snapshot. Full management DTOs include
endpoint, revision and public fingerprint but never credentials. The execution
catalog contains only Server ID, label and remote roots. Removed or locked bindings
do not survive as a second durable browser authority.
Catalog failure omits remote profiles with a sanitized diagnostic; it does not
disable the Server Connections extension or its local Codex Host. A legacy
backend's 404 means no remote catalog.

Directory selection and a persistent Project record are separate operations.
When a Server explicitly rejects the Project method as unsupported, choosing a
directory binds that Server path to the current Draft without inventing a local
Project or claiming it was saved on the Server. Authentication, network failures
and unknown creation outcomes still fail visibly rather than become success.
Draft text survives selection/menu operations within the current Application;
this does not promise persistence across a complete page reload.

## Verification

```bash
npm run test:ssh-codex
npm run smoke:ssh-codex-browser
OPENCRAFT_SSH_UI_WEB_ROOT=/absolute/isolated/headless-web-build npm run smoke:ssh-codex-workbench
OPENCRAFT_SSH_UI_WEB_ROOT=/absolute/isolated/headless-web-build npm run smoke:ssh-management
OPENCRAFT_SSH_UI_WEB_ROOT=/absolute/isolated/headless-web-build OPENCRAFT_SSH_UI_SHARED_ACCESS=true npm run smoke:ssh-management
npx tsx scripts/probe-ssh-codex.ts --host HOST --port PORT --user USER --known-hosts VERIFIED_FILE
```

The probe asks for a password without echo (or accepts `--key PATH`), initializes
the existing service and reads model/Thread lists. It performs no model inference,
Thread creation, file mutation or remote service management. Its report contains
only success flags, not user history or credentials. The isolated local sshd test
skips when the runner lacks its privilege-separation runtime; SSH exec/WebSocket
fixtures and explicitly authorized real-machine probes are separate evidence.
The browser smoke uses the actual browser AppHost/JSON-RPC clients and backend
broker, with only the SSH exec boundary substituted. It verifies two-page
multiplexing, detach and reload, not full Workbench UI or real HyperNode deployment.
The separate Workbench smoke consumes a newly built headless Web release and
exercises the actual desktop/touch Shell, backend catalog, target selection,
remote directory selection and history restoration. Only SSH exec is synthetic;
it performs no real inference or remote mutation. It does not exercise public
attachment authentication or remote administrative configuration. The management
smoke separately uses actual HTTP sessions, SQLite, Settings controls, desktop and
touch layouts, live profile selection and the protected WebSocket channel, with
only remote SSH execution synthesized. API tests cover expiry/logout, slow-body
revocation, trust scoping, CAS, private permissions and database restart/history
checks. These are not real HyperNode or multi-user authorization acceptance.

Management smoke returns through the actual **Home** navigation and selects the
saved profile through **Work in**. Explicit Connect must populate history without
changing that selection; automatic, Retry and online discovery recovery must work
outside Settings without issuing Connect/Reconnect. The native Codex fixture has
no OpenCraft machine identity: its saved descriptor labels an independent unknown
machine group, without inventing a reported machine or merging Host identities.
Run both light/dark schemes (`OPENCRAFT_SSH_UI_COLOR_SCHEME`); each run covers
desktop and touch. Shared-session mode is separate from the access-key run.

Implementation evidence and unverified boundaries are recorded in the
downstream SSH Task Pack (not in this repository).
Management evidence is in the downstream management Task Pack (not in this repository).
