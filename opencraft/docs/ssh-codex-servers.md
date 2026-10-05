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
  not construct a local account pool, attachment store or queue database.
- Disconnecting a page revokes its routing/answer lease, not a remote Turn. Closing
  the service closes only its SSH/proxy connection; no `pkill` or remote stop is sent.
- Basic native model/Thread reads, creation/resume, turn/start, native turn/steer,
  interrupt and stateless remote filesystem RPCs are forwarded. Native rejection
  remains a rejection: generated types are not evidence of a server capability.
  Local attachment staging, accounts, queue v2, Goal orchestration, PTY/watch/search
  connection resources are **not exposed** until their remote ownership paths exist.
  The first-turn durability extension is a broker policy for native Codex, not a
  claim that remote storage is transactional.
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
the Renderer or a LightVela account projection. The Settings **远程连接** page
uses a separate administrator access key to obtain an eight-hour HttpOnly,
SameSite=Strict session. This session authorizes the installation's configured
Servers; there is no per-member sharing ACL yet. Management HTTP writes require
an exact Origin matching the session's unlock address. `/ssh-apphost` verifies the same session at upgrade, every frame
and outgoing reply; logout/expiry closes the socket. Anonymous `/apphost` rejects
all SSH IDs, including guessed IDs and forged Renderer names. Local anonymous
features remain separate and usable.

Public SSH requires an explicit opt-in: a fixed HTTPS origin via
`--ssh-public-origin`, or `--ssh-public-access` for operator-approved changing
addresses. The latter accepts HTTP and HTTPS without an installation-wide
domain pin, but still requires the access key and binds each session to the
Origin that unlocked it. Invalid/opaque Origin and cross-site requests are
rejected; credentials do not become anonymous capabilities. Cookies remain
HttpOnly/SameSite=Strict and use Secure when unlocked through HTTPS. Plain HTTP
provides no transport encryption and exposes the access key/session to network
observers; this explicit option is not a secure public multi-user deployment.
Forwarded headers, hiding controls, or putting an anonymous endpoint behind a
reverse proxy do not grant remote authority. A backend restart revokes sessions
but preserves saved connections; users unlock management again. Revoking browser
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
Failed startup remains visible after cleanup instead of reverting to idle.
Reconnect resets and then establishes the successor backend attachment, not the
remote daemon; active clients can reacquire it. The management list continues to
read status while row-local commands run. A reset barrier fences old sends/claims and waits for physical
close before accepting successor claims. Reconnect rechecks authorization and
configuration revision after that barrier, before admitting a successor. Lost mutation receipts are unknown
outcomes, never automatic retries; refresh and inspect before resubmitting.

## Backend configuration

For a loopback deployment, management is enabled by default. Its generated access
key is at `<data-dir>/ssh/access.key` (0600) and is never printed by the service.
Supply `--ssh-access-file /private/access.key` to use an existing high-entropy
private key. It is independent of the remote SSH password. Deliver it only through
a trusted administrator channel. Public deployments choose a fixed HTTPS origin
or explicitly enable changing addresses; neither enables anonymous remote root.

The first management form supports password authentication. Existing backend
key/agent recipes remain compatible through a private (0600), owner-owned JSON
file using `--ssh-servers /absolute/path`. These appear as read-only
configuration-file connections after unlock; they are not silently imported into
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
disable the local Codex extension. A legacy backend's 404 means no remote catalog.

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

Implementation evidence and unverified boundaries are recorded in the
[SSH Task Pack](../../docs/context/tasks/2026-10-04-opencraft-ssh-codex-compatibility.md).
Management evidence is in the [management Task Pack](../../docs/context/tasks/2026-10-05-opencraft-ssh-management.md).
