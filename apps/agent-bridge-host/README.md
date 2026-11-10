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

Local verification is recorded in [P2a validation](VALIDATION-P2a.md). The built
Workbench smoke uses a synthetic native boundary; it is not real-account steer
proof. No service, default engine or published artifact is switched by this code.

## Execution CLI (P7a)

Optional private `cli` configuration contains absolute `directory` and
`signingKey` paths and the Server's loopback `endpoint` ending in `/thread-cli`.
The key is the existing Server capability signing key, not an Actor credential.
Keep it owned and mode 0600. Server's execution-admission transport signs the
admitted domain input before sending it through daemon to Host; Host checks the
signature, route and live Server admission before publishing an execution-only
launcher. PATH and `OPENCRAFT_THREAD_CLI` contain paths, never bearer values.
The CLI endpoint forwards only while its Host lease is live, and Server rechecks
bounded delegation and resource authorization on each operation.

Codex consumes the shared execution-configuration owner to retire the old native
runtime and restore its permission/approval settings around environment changes.
No permission mode is widened. Providers without an execution environment adapter
remain unavailable for this port; there is no orchestration MCP fallback.
See [P7a validation](VALIDATION-P7a.md) for evidence and remaining acceptance gaps.
