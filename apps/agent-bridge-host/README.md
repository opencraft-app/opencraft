# Independent Agent Bridge Host (P1b)

Opt-in Node execution owner; no existing engine route imports this application.
P1a owns the protocol, grammar, assembler and AppServer projection. This application
owns the sandbox pool, pinned generations, command custody and durable delivery.

Start independently of the gateway (do not spawn it as a gateway child):

```sh
npm run start --workspace @opencraft/agent-bridge-host -- /absolute/private/host.json
```

The private configuration supplies `database` (absolute), `token` (at least 32
bytes), optional loopback `port`, `backend: "linux-systemd"`, `backendOptions`
(the existing sandbox-node systemd options), and explicit sandbox `policy`.
Default sandbox resources remain 4 vCPU / 8 GiB. There is no automatic local
fallback. SIGTERM/SIGINT drain the HTTP listener, clean the sandbox pool and its
whole descendant groups, settle outstanding RPC as unknown, then close storage.
Deployment supervision of the owner itself remains an operator responsibility.
No service is installed or restarted by this application.

## Private attachment

All routes require `Authorization: Bearer <token>` and reject browser Origin.
The gateway is trusted ingress: Actor/lease authorization stays with Server; the
Host never derives it from the command, cwd or process. No public engine route
or new user-facing capability is registered.

- `POST /generation/add`: immutable `{id, digest, artifact, provider, launch}`.
  `artifact` is the absolute, self-contained bridge bundle path. `digest` is its
  SHA-256; the Host verifies bytes before sandbox spawn. `launch` uses the shared
  sandbox command contract and must include that bundle path. Packaging all
  provider code into that pinned artifact is the provider's responsibility.
- `POST /generation/activate`: `{id, expected}`. Sandbox startup and P1a initialize
  must succeed before committing the new default. A configuration change needs
  a new generation ID. Only new `session/create` routes use the new default.
- `POST /command`: `{commandId, serverId, threadId, method, params}`. First commit
  command ID, deterministic SHA-256 of the complete command, original execution
  epoch, route and state; then return the durable `registered` admission receipt.
  Query `GET /command?id=...` for native outcome. Reusing an ID with changed input
  is rejected. Repeating the same ID returns custody and never sends again.
- `GET /events?cursor=N`: up to 256 ordered, durable canonical/callback events.
  `POST /ack` with `{cursor}` deletes only the acknowledged prefix. A cursor
  below retention or beyond the produced high watermark is rejected.
- `POST /thread/release`: `{serverId,threadId}` requires native close, no live
  Turn/items, pending input/interaction/command custody or unfinished text streams, or unacknowledged events.
- `POST /generation/retire`: `{id}` requires a noncurrent generation with no
  retained bindings or outbox. Only then is its sandbox destroyed.
  Release is terminal: a durable tombstone prevents that Thread identity from
  being rebound to another generation; it is not an idle suspend/resume action.
- `GET /health` exposes Host PID/incarnation without storage IO; `/snapshot`
  exposes the managed database outcome and durable generation/routing state.

`(serverId,threadId)` is encoded as a collision-free JSON pair for internal bridge
session scope; callbacks and their deltas must use that exact scope. The Server
projection restores the public thread ID. Commands, queued native work,
interactions and callbacks never migrate to a successor generation.

## Failure and persistence

Only the dedicated Worker opens SQLite or performs synchronous filesystem IO.
It acquires the existing kernel-backed process writer fence, uses
`openManagedDatabase`, exposes the database outcome, and applies append-only
migrations. Each command transition and each callback checkpoint/outbox batch
commits before its receipt. An IO/SQL/Worker failure fences storage; no main-thread
fallback exists. Storage loss stops the owned sandbox groups; cleanup failures
remain observable on close and never release pool capacity. Close drains accepted Worker messages before releasing the writer.

Before any native request write, the command is durably `dispatching`. A process
crash converts it to `unknown`; EOF, timeout and ambiguous failure also stay unknown.
Late responses cannot erase uncertainty. No recovery path resends mutations.
`accepted` records a native RPC success, never model-context evidence. Only an
explicit native rejection is recorded `rejected`; steer evidence remains P1a's
separate facets. Native request/session proof reconciliation belongs to each P2/P3
provider; until then unknown custody blocks release. A restarted Host refuses to
replace any generation with retained bindings automatically, since surviving
native processes cannot yet be attested or resumed by this foundation.

EOF and close drain callbacks already received even if their acknowledgements
can no longer be sent.

Callbacks sent as requests use their stable bridge request ID for transactional
dedup and receive an ack only after commit. Repeated IDs with changed bodies are
refused. Notifications receive a stream-incarnation ID; there is no native-side
notification replay promise. Only Host outbox delivery replays across gateway
connections. All semantic deltas use P1a validation and assembly; checkpoints and
the resulting event batch share one SQLite transaction. Runtime timestamps use
wall time with a persisted monotonic floor, rather than fixture clock seeds.
Native session identity/restorability has its own durable projection and remains
queryable after the identity event is acknowledged. Non-delta callbacks
(identity, interactions, recovery) retain their original typed payload and route.

The default spool admission threshold is 64 MiB (`HostOptions.maxSpoolBytes`).
At/above it new create/start/steer admissions stop; ongoing native output continues
to persist, as do stop, close and interaction responses. It is an admission
threshold, not permission to discard active events or a hard disk quota.

`GatewayInbox` is a separately owned Server-side SQLite projection log. It commits
an ordered page, dedup record, existing AppServer projection and cursor in one
transaction before acking Host. Duplicate pages do not project again; crashes
between commit and ack resume at the durable cursor. Consumers rebuild from the
persisted projection log, never from an external side effect between commit and
ack. Base AppServer notifications use P1a's existing projection; additive steer
extensions are not advertised here. Existing Server/client consumers remain on
their current path. Multi-server replication, production provider recovery and
provider-specific request validation are outside P1b.

## Local acceptance

```sh
npm run typecheck --workspace @opencraft/agent-bridge-host
npm run test:agent-bridge
npm run test:sandbox
npm run test:sqlite-node
npm run check:boundaries
```

`tests/agent-bridge/host.test.ts` runs independent Host/gateway/bridge processes
with a fake native provider and a test-only process-group sandbox backend. It
covers a long Turn across gateway SIGKILL/restart, cursor replay without duplicate
projection, Host SIGKILL during native send without resend, immutable generation
routing/draining, lock-wait heartbeats/timers, active spool retention, v1→v2 data
preservation/checksum refusal, main-thread runtime IO/SQL guards, backend rejection
and whole descendant cleanup. Fake resources do not prove kernel constraints;
the existing opt-in Linux sandbox smoke checks those separately.

## Codex provider (P2a)

Build the pinned provider with `npm run build:codex --workspace
@opencraft/agent-bridge-host`. Register the resulting self-contained `dist/codex.cjs`
artifact and SHA-256 with a new Host generation. Its sandbox launch vector is
`[node, absoluteArtifact, absolutePrivateCoreConfig]`; the Core configuration is
an owned, mode-0600 JSON file containing `endpoint` (existing Core control socket)
and `token`. It attaches the Core's existing Unix WebSocket listener. It never
starts Codex or opens CODEX_HOME. Minimum source-checked native version is
0.162.1; older or unidentifiable versions refuse attachment.

Core remains the account-pool proxy and account-refresh owner. The bridge reads
only Core's synthetic broker authentication via the existing private `/launch`
port and answers native `account/chatgptAuthTokens/refresh` on its own connection;
it neither acquires upstream OAuth credentials nor starts a login/refresh job.
The selected Core execution environment and native permission policies remain
in force. The bridge process separately consumes the Host's selected sandbox.

Daemon composition is explicit: pass `--codex-agent-bridge-config` with an owned
private JSON file `{url, token, serverId, inboxPath}` and keep the existing
`--codex-core-endpoint`. `url` must be loopback HTTP; `inboxPath` must be absolute.
The daemon attaches this independently started Host; it does not launch it.
Each gateway database has one consumer. No existing route changes without this
configuration. A new thread opts in with
`thread/start {agentBridge: {threadId: stableSeed, clientRequestId: stableKey}, ...}`.
The returned public ID has the `bridge:codex:` namespace. Subsequent mutations
use that returned ID and stable `clientUserMessageId`. Old threads stay native.
Direct native IDs for retained bridge sessions and unknown bridge IDs cannot
fall through to the old writer path. Client engine declarations disable queue,
fork, rename, archive and other unsupported actions for bridge threads.

The bridge maps native turn, message, shell/tool, usage and approval facts into
P1a semantic deltas. Host assembly/inbox projection owns the public item and turn
IDs; native history bodies remain authoritative and receive the same ID mapping.
Native `turn/steer` always carries `expectedTurnId`; a stale target rejects without
redirecting to a newer turn. Its reply is admission only. A separate native
`userMessage.clientId` event can join that input and upgrade its evidence. Text
matching, an RPC success, or a model's answer never establishes context evidence.
An input without such evidence remains unconfirmed; withdrawal is unsupported.

The shared Workbench runtime opts into the typed evidence extension, queries it
on attachment, and merges facets by version. Its existing message status row
separately presents admission and native context confirmation. An older client
that cannot represent these facets cannot invoke native steer on bridge threads.
Unknown outcomes never queue, interrupt or resend automatically. Gateway reconnect
rebuilds ID joins from its durable inbox before consuming new outbox events;
closing the gateway does not close the bridge or Core. Host/bridge replacement
with retained sessions still requires explicit reconciliation, as in P1b.

The built Workbench smoke uses a synthetic native boundary; it is not real-account steer
proof. No service, default engine or published artifact is switched by this code.

## Resident-service registration and per-engine routing

The private Host configuration may include `generations` (the same immutable
registration bodies as `POST /generation/add`) and `activate`. Startup registers
each generation and activates the configured one only after its sandbox and
bridge negotiation succeed; a restart therefore never silently replaces a
generation that still owns native work.

New-Thread routing is a Server-side composition choice, not a Host default. The
daemon/engine-host accepts an optional private per-engine bridge configuration;
without it every engine keeps its current path. Claude Code maps new connected
agent Threads to `session/create`; Pi and DSH enter the independent Engine Host
as pinned bridge providers (`pi_bridge_` and `dsh_acp_` prefixes). Existing
Thread identities keep their original provider because routing is selected by
thread prefix, never by adoption. `BridgeEngineProvider` projects bridge
callbacks into the existing AppServer notifications and carries turn/steer
evidence; it does not add a second client protocol.

## Execution CLI (P7a)

Optional private `cli` configuration contains absolute `directory` and
`signingKey` paths and the Server's loopback `endpoint` ending in `/thread-cli`.
The key is the existing Server capability signing key, not an Actor credential.
Keep it owned and mode 0600. Configure the Server headless entry with
`--codex-agent-bridge-config` alongside its existing Core attachment. Its admission
transport wraps only the selected ProviderBridge and signs the admitted domain
input with a dedicated CLI audience before sending it to Host. Host checks the
signature, route and live Server admission before publishing an execution-only
launcher. PATH and `OPENCRAFT_THREAD_CLI` contain paths, never bearer values.
The CLI endpoint forwards only while its Host lease is live, and Server rechecks
bounded delegation and resource authorization on each operation.

Codex consumes the shared execution-configuration owner to retire the old native
runtime and restore its permission/approval settings around environment changes.
No permission mode is widened. Providers without an execution environment adapter
remain unavailable for this port while ordinary turns continue. There is no
orchestration MCP fallback. General platform MCP configuration, including IM,
continues separately through the shared configuration owner. Bridge preparation
is bounded to ten seconds and half the Host RPC timeout. Legacy configuration
refresh retains its original timing.
Decisions and remaining gaps are listed under [Design decisions and known limits](#design-decisions-and-known-limits).

## Project automations (P7b)

Server control-plane automation uses the existing asynchronous orchestration
Worker and Broker. The optional Host `automation` configuration declares exact
`hostId` and `environment` identities for scripts using the selected sandbox
pool. The CLI, human grants, private script routes and failure policies are described
under [Design decisions and known limits](#design-decisions-and-known-limits).

## Design decisions and known limits

Carried over from the retired validation ledgers; evidence runs and review logs live in Git history.

### P1b: Implementation decisions

- Each Host and Server inbox has its own managed SQLite file and dedicated
  Worker. Native session identity remains durable after outbox acknowledgement.
- 64 MiB is the default spool admission threshold, not an active-output truncation
  limit. Stop, close and interaction replies remain admissible while full.
- Bridge code is a self-contained SHA-256-pinned bundle in an immutable generation.
  Terminal release keeps a Thread identity tombstone; idle suspension is not
  represented as terminal release.
- After Host crash, generations with retained Thread bindings stay fenced until
  a provider can prove native recovery. P1b never starts a replacement native
  writer for those bindings or replays an uncertain mutation.

Native provider-specific proof reconciliation, production provider smoke and
existing client consumption belong to subsequent opt-in integration phases.
This foundation does not claim those paths are implemented or deployed.

### P2a: Ownership and deliberate decisions

The opt-in daemon adapter reuses the P1a protocol/assembler and P1b Host/inbox.
It attaches the existing Core AppServer, preserving Core account-pool routing,
authentication refresh, native execution environment and permission policies.
It does not launch another Codex writer or own a CODEX_HOME.

Public thread IDs use `bridge:codex:`. Native IDs of bound sessions cannot bypass
the bridge through the legacy adapter. One input lacking native correlation
blocks another steer across turns, avoiding ambiguous attribution. Native
`userMessage.clientId` correlation is context-path evidence, not evidence that
the model understood the instruction. Admission alone never upgrades it.
Unknown mutation outcomes retain their command ID and are not automatically
resent. Clients without the typed evidence extension cannot steer these threads.
The initial capability is text input; unsupported queue/fork/archive/rename and
withdrawal paths remain unavailable. Core's synthetic broker credentials answer
native auth requests; upstream account credentials remain with Core.

### P7a: Implementation decisions

- Server admission signs a dedicated execution-CLI audience after domain admission.
  Host verifies that signature and exact Server/Thread pair, and rechecks current
  Server admission before publishing a private execution launcher. The extra
  admission lookup runs in the existing orchestration Worker.
- CLI descriptors point to a Host forwarding endpoint. Only live Host leases
  forward using the Server execution bearer retained only in Host; descriptors contain a distinct opaque Host bearer. Copying them cannot bypass Host revocation by calling Server directly. Terminal callbacks, stop and owner loss
  revoke forwarding. Server retains per-call delegation/resource checks and owns
  the sender identity, write budget and durable operation receipts.
- Codex configuration refresh has one shared owner. The legacy path keeps its
  existing permission capture, runtime retirement and settings restoration order;
  the bridge consumes the same owner for execution environment changes.
- `thread input status` takes an operation ID, keeping lookup restricted to the
  calling delegation and checking target read access before reading delivery.
- `tell --delivery native` maps to the existing native steer path and requires an
  expected Turn. Queue uses the existing durable input path. Interrupt is explicitly
  unsupported by the current Broker authority; it never silently becomes queue.

### P7a: Remaining provider scope

The configured independent Codex Host path consumes the new execution CLI port.
Other providers have no new execution environment adapter in this change and must
not advertise CLI execution merely because they support a shell. A configured
Host skips issuance for undeclared providers and permits their ordinary turns.
A declared CLI provider without valid admission fails closed with `cliUnavailable`.

### P7a: Decisions introduced

- Reserve an unprivileged first-execution namespace before native creation and
  bind it once after admission. Retain the native and canonical Thread identities;
  never synthesize a rollout, send a seed model Turn or recreate the session.
- New opt-in Codex bridge creations with a reserved CLI environment default to
  legacy history unless the caller explicitly chooses a history contract. The
  attached minimum native exposes an unambiguous unmaterialized-history refusal
  for that contract. An unsupported explicit contract fails closed; default
  legacy-engine creation and existing Thread history contracts are untouched.
- Keep the new MCP reservation in memory for the Server owner lifetime. It is not
  durable execution authority or a promise of automatic recovery after Server
  owner loss. No new main-thread SQLite path or migration is introduced.
- Use the requested `gpt-5.6-luna`, low reasoning, without claiming a newly checked
  absolute price ranking. The real chain selects its issued launcher through
  `OPENCRAFT_THREAD_CLI` and native tell; queue follow-up stays a stated limit.
- Use an isolated dependency view with workspace packages resolved to this
  checkout. The removed reference worktree's SDK dependency was replaced by a
  temporary install of the lockfile's exact SDK version; temporary transitive
  dependencies are not claimed byte-for-byte identical to the lockfile. No
  package metadata or lockfile changed; temporary dependency files are removed.

### P7b: Operation and authorization

The execution-bound launcher supports `automation list/show/create/update/pause/
resume/delete/run/runs`. Each command accepts `--help` and `--json`. List and runs
have cursor/limit pagination. Mutations require an explicit idempotency key. Run
also requires occurrence ID and the complete `automationId:revision:occurrenceId`
key. Changed input under an existing key conflicts. Updates require the current
revision. Results are bounded, and oversized run output is explicitly truncated
in the catalog response.

Human authorization is separate from the execution launcher. The authenticated,
same-origin collaboration HTTP surface exposes `automation-grants` with create
and revoke, and `automations` with the same automation commands. A grant records
an exact target, project, Actor generation and permission snapshot. It stores no
login token or execution bearer. CLI create references this grant. Every trigger
rechecks Actor admission, project membership, resource access and the effective
permission snapshot before issuing a bounded execution delegation. Derived
execution can read automation catalogs but cannot mutate automations or delegate
additional thread work.

The human `automation-reconcile` endpoint inspects native evidence for an owned
unknown run. Background reconciliation also inspects unknown runs. Neither path
replays an execution. The HTTP body uses `command`, `arguments` and
`idempotencyKey`, as on the existing CLI surface. Reconciliation reads provider
proof and may settle a previously unknown outcome.

A minute cron expression supports numeric lists, ranges and steps with an IANA
zone. Missing wall times have no matching instant. Repeated wall minutes select
the earliest UTC instant. Only the current minute is eligible. Once has a
60-second admission window. Restart does not replay an admitted/running mutation,
and unknown retains its result binding for native inspection. Each automation
has one active execution across revisions. Overlap records skipped. Three
consecutive definite failures pause the definition.

Host private configuration optionally declares `automation` with `hostId` and
`environment`. The permission profile is `sandbox-policy:<selected-policy-id>`.
Private `/script/capabilities`, `/script/run` and `/script/show` routes share the
existing authenticated gateway. Scripts have durable idempotent custody and
bounded stdout/stderr, exit status and a truncation indicator. Failed cleanup
keeps the outcome unknown. Script grant creation additionally requires the
installation's explicit existing Actor management grant.

### P7b: Decisions introduced in this batch

- Human grants authorize exact target and permission snapshots. Updating a plan
  changes its schedule. Changing target or permissions requires a new grant and
  definition. This avoids widening the original authorization.
- Script permission identity is the configured sandbox policy ID. The deployment
  owner must change that ID when changing the underlying security policy.
- Derived executions have no automation mutation or further thread mutation
  capability. This batch exposes no administrative recursive-creation exception.
- Existing legacy schedules are checked before cron grant creation and every
  trigger. Active or paused legacy schedules reject the new trigger. Import is
  unavailable in this batch. No old schedule table or legacy migration changes.
  Cross-owner atomic import remains unimplemented.
- Dispatch delegation expires after one hour. Inspection uses a freshly checked
  grant context, allowing completed work to settle after that bound. Pending
  input renews its delegation only when expiry is within fifteen minutes, after
  checking the current grant. Restart restores the durable delegation projection
  before starting the input pump. Only live runs enter that indexed projection.
- Run catalogs cap page bytes and truncate large inline output. This batch does
  not introduce an artifact store or a separate output command.
