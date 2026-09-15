# Hypernode

Hypernode is a durable SSH observation node for studying how Codex and other automated clients
probe and use an SSH host. It exposes a real SSH endpoint, but does not grant a host shell.

The wire-level transport, key exchange, encryption, and SSH framing use Go's audited
`x/crypto/ssh` implementation. QuickJS-NG owns the programmable application policy: authentication,
command responses, request decisions, and long-lived JavaScript state. Go exposes narrowly scoped
cryptographic helpers (`crypto.sha256`, `crypto.randomBytes`, `crypto.timingSafeEqual`) and a
constant-time password verifier. A narrow SQLite-backed `policyStore` provides durable namespaced
string values. A Durable Object-style synchronous SQLite API is also exposed to Cordis services as
`ctx.storage`; the JS VM still has no filesystem, subprocess, or network APIs.

Every connection, authentication attempt, global request, channel, PTY/window request, command,
and simulated output is appended to SQLite in WAL mode. Passwords are never stored; only a SHA-256
fingerprint is recorded so repeated credentials can be correlated during a controlled experiment.

## Run

```bash
CGO_ENABLED=0 go build -o bin/hypernode ./cmd/hypernode
./bin/hypernode serve \
  --listen 0.0.0.0:9988 \
  --db .runtime/hypernode.sqlite \
  --policy policy/default.js \
  --auth-mode debug \
  --localhost-root /home/deploy \
  --codex-bin codex
```

The SQLite database is the authority for the SSH Ed25519 host identity. On the first upgraded
start, `--host-key` is only a legacy seed path: an existing key is imported into the
`node_identities` table, or a new key is generated when the path is absent. Later starts ignore
changes to that file and load the private host identity from SQLite, so the client-visible SHA256
fingerprint survives working-directory changes and ordinary restarts. Because the database now
contains private identity material, the database and its WAL/SHM sidecars are forced to mode 0600.

Debug mode is the development default. It keeps SSH `none` authentication enabled and does not
issue or require a user key, even if an earlier bootstrap key remains recorded. Use
`--auth-mode bootstrap` to enable the enrollment flow described below.

In bootstrap mode, an empty user directory enables SSH `none` authentication exactly once. That
connection is projected onto the durable `node:root` administrator principal regardless of its
supplied SSH username. Connect initially with any username (the transport trace still records it):

```bash
ssh -p 9988 codex@HOST pwd
```

On app-server initialization in bootstrap mode Hypernode generates an Ed25519 client key, stores only its public key
and SHA256 fingerprint in `do_users`, and delivers the private key once through a sensitive
AllThread message. Issuing the key immediately disables new `none` authentication. Subsequent SSH
connections must use the issued key and username `root`; its fingerprint resolves the durable user
identity. The private key is absent from thread persistence, the user table, and binary event
payloads. This is the administrator bootstrap rule; organization and delegated enrollment are not
implemented yet.

Inspect the durable trace:

```bash
./bin/hypernode events --db .runtime/hypernode.sqlite --limit 100
```

Workspace execution always uses the persistent Workspace v2 runc plane backed by a sparse Btrfs
image. There is no in-memory or Docker runtime fallback. The storage and attachment model is
documented in [`docs/workspace-runtime-v2.md`](docs/workspace-runtime-v2.md).

## Virtual protocol stack

Codex Desktop can reach the same AppServer protocol through either `codex app-server proxy` on a
long-lived SSH exec channel or a direct WebSocket on the multiplexed listener. Hypernode treats
both as generic duplex byte streams and hands them to one pure-JavaScript virtual server:

```text
SSH session stdin/stdout ─┐
                         ├─> VirtualWebSocketServer (/rpc)
direct ws://host:9988/rpc┘
                              -> AppServerVService (JSON-RPC)
```

`VirtualWebSocketServer` implements the HTTP upgrade, client masking, extended payload lengths,
fragmentation, UTF-8 text frames, close, ping, and pong in QuickJS. It has no TCP listener or host
socket. Application behavior is programmed against the virtual socket's `message` event and
`send()` method, so adding a mocked app-server method does not require a Go change.

The direct transport uses the standard HTTP Upgrade handshake and the exact same frame parser,
connection lifecycle, backpressure queue, and JSON-RPC dispatcher as the SSH path. In debug mode,
clients may select the SSH identity with `X-HyperNode-User`; it defaults to `root`. Outside debug
mode, direct WebSocket identity must not be asserted by an untrusted header, so the endpoint
returns `401` until an authenticated admission provider is configured.

The policy currently answers `initialize` and `getAuthStatus` using shapes observed from the local
Codex runtime. Unknown requests receive JSON-RPC error `-32601` and their raw frames remain in the
durable event trace.

## Localhost and transparent Codex threads

`/localhost` is an identity-scoped app-server mount. After SSH authentication it projects the
current Hypernode user's durable home directory; the fallback deployment identity uses the host
directory selected by `--localhost-root`. The Cordis `VirtualFilesystemService` owns this mapping
for file preview, task cwd, and streamed terminal commands. Go uses `os.Root`, rejects parent
traversal, and keeps each operation beneath the selected root. The Renderer therefore always sees
`/localhost`, while the local process and file-preview service resolve the same per-user physical
directory. Opening or executing in a task cwd materializes that directory idempotently with the
virtual user's UID/GID, so Files and PTY cannot disagree about whether the workspace exists.

Every conversation created under `/localhost` is an L7 jump host to the installed Codex runtime.
The Cordis service lazily launches one dedicated `codex app-server --listen stdio://` per active
outer thread (while retaining a pooled per-user control runtime), initializes it,
creates or resumes an inner Codex thread, and stores the outer-to-inner thread binding. Client
requests, app-server notifications, server requests, and client responses are forwarded as JSON-RPC.
Thread IDs and paths are rewritten at the boundary, so the Renderer continues to use the stable
outer thread ID and `/localhost` namespace. A 25 ms SSH stream pump carries asynchronous app-server
events even while the client is not writing. Older databases may contain a pre-created
`Codex 透明 Thread`; startup removes that obsolete system entry and its legacy binding keys.
The user capability plane is transparent too: `model/list`, `collaborationMode/list`, `config/read`,
and `configRequirements/read` come from that user's Codex process. Desktop initialization
extensions are preserved when the inner connection is created; Hypernode keeps its own complete
notification stream so projection and multi-client fanout cannot be disabled by one frontend.
`collaborationMode/list` responses preserve backend ordering, nullability, and unknown fields, with
the Codex 0.148 Plan/Default catalog used only when an older backend returns JSON-RPC `-32601`.
Per-turn `model`, `effort`, `collaborationMode`, and `serviceTier` values pass through unchanged, so
the desktop model, planning mode, reasoning-depth, and speed controls govern the real inner turn
rather than a Hypernode mock.

Direct SSH shells use a Cordis `SshInteractiveTerminalService`. The JavaScript vSSH stack owns `pty-req`,
`shell`, `window-change`, input, flow control, and session lifetime; Go exposes only a narrow PTY
byte/resize primitive. Terminals start in the authenticated user's home and share the same
identity boundary as `/localhost`.

Desktop terminal tabs use the official streaming `command/exec` protocol against the same
per-user Codex backend. Hypernode namespaces client-supplied process IDs per frontend connection,
routes `command/exec/outputDelta` only to the owning connection, forwards write and resize calls,
and terminates remaining PTYs when that frontend disconnects. Two clients may therefore both use
the same local process ID without colliding or seeing one another's terminal output.

The Go host-process ABI intentionally exposes only the configured Codex executable, stdin writes,
stdout/stderr drains, exit status, and kill. Process routing and protocol ownership remain in the
Cordis service. Do not expose a sensitive home directory with `--auth-mode debug` on an untrusted
network; use bootstrap/key authentication before widening `--localhost-root`.

`LocalEnvironmentService` overlays `.codex/environments` as a separate Cordis domain instead of
materializing configuration files in a user's physical home. The filesystem adapter exposes the
same environment through `fs/*`, while the process adapter serves Desktop's argv-based
`process/spawn(["cat", configPath])` read path with the official output and exit notifications.
The initial probe environment at `/localhost/polaris/.codex/environments/environment.toml`
contains one `Echo aaa` action. It is deliberately a protocol smoke fixture; per-user edits are
isolated in the service model but remain in-memory until the durable environment repository is
added.

## Workspace VFS

In the default test profile, `/workspace` is a pure-JavaScript `MemoryVFS`; it is not mounted,
mirrored, or delegated to the host filesystem. It supports absolute-path normalization, recursive directories, file bytes,
metadata, direct-child listings, recursive removal, file/directory copies, and connection-scoped
watch notifications. The app-server adapter exposes the official `fs/readFile`, `fs/writeFile`,
`fs/createDirectory`, `fs/getMetadata`, `fs/readDirectory`, `fs/remove`, `fs/copy`, `fs/watch`, and
`fs/unwatch` methods over the virtual WebSocket.

With `--workspace-runtime runc`, `WorkspaceFilesystemService` takes ownership of the same
protocol paths and routes them through its Workspace v2 attachment. Every conversation sees one
complete logical filesystem rooted at `/workspace`, with projects anchored at
`/workspace/projects`; physical Btrfs catalog paths never enter the Desktop, terminal, or Agent
namespace. A durable fork mounts its O(1) snapshot at the same logical `/workspace` path.
Files, interactive PTYs, `command/exec`, and the per-user Codex app-server therefore share both the
same paths and the same view lifecycle. Workspace `fs/watch` subscriptions are backed by recursive host-side inotify,
so writes made directly by Agent processes, Git, or terminals emit the same official `fs/changed`
notification as writes made through the app-server API. See
[`docs/workspace-runtime-v2.md`](docs/workspace-runtime-v2.md).

Task titles are shared domain state rather than preformatted strings.
`ThreadTitleService` stores the raw user title, revision, actor, and fork
lineage; the cloud badge and current writer are projected per frontend through
the official `thread/name/updated` notification. The contract and migration
rules are documented in [`docs/THREAD_TITLES.md`](docs/THREAD_TITLES.md).

Each Workspace v2 attachment starts the bounded `workspace-stdio` transport inside its runc
namespace. Metadata, directory, read, write, copy, remove, watch, process, and terminal requests
are authorized by the opaque attachment capability and remain scoped to that workspace; no Docker
runtime or host filesystem helper is involved.

The QuickJS bootstrap provides the Workers-compatible global `atob()` and `btoa()` APIs plus the
Node-compatible `Buffer.from(...).toString("base64")` path used by current Cloudflare Workers.
Large file responses retain the official single `fs/readFile` JSON-RPC response, while the virtual
WebSocket drains its wire frame in bounded 512 KiB chunks. This avoids the JavaScript-to-Go 8 MiB export
boundary without requiring a Renderer-specific file protocol.

Go is intended to remain stable after the transport ABI is established. WebSocket, VFS, and
app-server behavior are JavaScript policy changes and require only a policy reload or process
restart, not a Go rebuild.

## Durable policy KV

Go exposes four synchronous operations to QuickJS: `policyStore.get(namespace, key)`,
`set(namespace, key, value)`, `delete(namespace, key)`, and atomic
`getOrInsert(namespace, key, candidate)`. Values are strings up to 1 MiB; namespaces and keys are
limited to 256 bytes. They are stored in the existing SQLite database's `policy_kv` table.

`DeviceIdentityService` uses `getOrInsert` to reproduce Codex's installation identity behavior:
generate a UUIDv4 once, retain it across process restarts, and project the value into the in-memory
VFS at `/workspace/.codex/installation_id`. The KV API is a persistence primitive only; domain
ownership and serialization remain in Cordis services.

For relational state, Go exposes `durableStorage.sql.exec(query, ...bindings)` plus
`durableStorage.transactionSync(callback)`. `DurableStorageService` projects the same native
capability into Cordis as `ctx.storage`. Query results implement `next()`, `toArray()`, `one()`,
`raw()`, `[Symbol.iterator]`, `columnNames`, `rowsRead`, and `rowsWritten`. See
[`docs/DURABLE_STORAGE.md`](docs/DURABLE_STORAGE.md) for the supported contract and limits.

## Principal and thread ownership

`PrincipalService` durably claims the prototype's single administrator as `node:root`.
`RootThreadService` creates exactly one durable, non-archivable management thread for that
principal. It is the session equivalent of PID 0: a control-plane entry point for listing and
managing sessions, not the parent or owner of ordinary conversations. Ordinary `thread/start`
calls create independent private conversations owned directly by the principal, while
`thread/resume` restores a persisted conversation and its turns. The catalog and management-thread
identifier live in `policyStore`, so browser refreshes, multiple clients, and Hypernode restarts
observe the same thread namespace.

`AllThreadService` creates a second non-archivable system thread named `All`. It is the node-wide
group conversation and is independent of the RootThread control plane. System announcements such
as login welcomes are stored as ordinary agent turns in AllThread; the prototype intentionally
does not attach sender identity yet.

`UserDirectoryService` owns the relational `do_users` table. The current schema records a stable
principal ID, username, administrator role, authentication method, creation and last-login times,
login count, SSH public key, key fingerprint, Codex binding state, auth mode, account email, plan,
credential-file reference, binding/verification times, and a durable onboarding marker; it deliberately
contains neither raw Codex tokens nor an organization hierarchy. A newly registered user receives one
welcome turn in AllThread. It points to `☁️ 管理员` and its `Add Codex Account` action when the
user still needs a private Codex credential. Existing users are backfilled as already onboarded during
schema migration, so reconnects—including debug-mode passwordless reconnects—do not emit another welcome.
The bootstrap completion may additionally contain the one-time SSH private key.

The management thread is interactive through the ordinary `turn/start` lifecycle. Its command
dispatcher uses `VirtualSkillService` as a registry, and the same registry is exposed through the
official `skills/list` API so the desktop client's Skills UI doubles as the management menu. The
initial synthetic `hypernode` menu skill is also materialized in the in-memory VFS. The dispatcher
understands the desktop client's Markdown skill mention, direct skill paths, `$hypernode`, and the
legacy `help` alias. `Codex Account` is the per-user account control: invoking it checks the current
SSH user's real Codex backend and starts `chatgptDeviceCode` only when no account is present.
`Codex Accounts` lists account ownership, safe account metadata and Remote Control state. An
administrator sees the node-wide catalog; members see only their own entry. `Add Codex Account`
always binds the current SSH user and never assigns or copies another user's credentials.

## Cordis services and protocol schema

The QuickJS policy is authored as Cordis services under `policy/src/` and bundled to the single
`policy/default.js` file consumed by Go. Services are grouped by protocol domain instead of by
individual RPC method. The checked-in Codex app-server JSON Schema snapshot under
`protocol/upstream/` is projected into a deterministic method manifest during `npm run
check:policy`; packet traces establish call ordering and reveal version-specific extensions.

The master Remote Control ingress is also a Cordis service and connects to OpenAI without a child
Codex app-server in front of it. Its transport ownership and verification contract are documented
in [docs/REMOTE_CONTROL.md](docs/REMOTE_CONTROL.md).

## Per-user Codex devices

Every SSH username receives a stable installation ID, private home directory, private `CODEX_HOME`,
its own Remote Control channel, and its own pooled `codex app-server` process. Both Remote Control
and the transparent thread service use that user's private ChatGPT login; they never read or copy
the deployment user's credentials. The transparent thread service
forwards `account/read`, `account/login/start`, `account/login/cancel`, and `account/logout` to that
process, so `chatgptDeviceCode` authorization is performed by the real Codex implementation and its
credentials remain in the user's own `.codex` directory.

Binding is intentionally initiated from the `☁️ 管理员` thread through the `Codex Account`
skill, rather than during SSH transport login. The one-time verification URL and code are delivered
only to the invoking connection as a sensitive notification; durable thread history contains a
redacted marker. On success Codex writes `auth.json` with user-only permissions, while `do_users`
stores only safe account metadata and the credential-file reference. A later invocation first calls
`account/read`, silently reuses the existing account, and does not start another login.

An unbound user may create or resume a `/localhost` thread, but `turn/start` is rejected locally
with JSON-RPC error `-32051` and `data.kind = "codexAccountNotBound"`. This prevents an unauthenticated
request from reaching the Responses API and gives the client a deterministic signal to start device
login. Successful `account/login/completed` and `account/updated` notifications promote that user's
binding state; logout demotes only that user. Hypernode never copies the administrator's credentials
into a child device.
