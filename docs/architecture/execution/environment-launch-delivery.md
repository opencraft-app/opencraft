# Execution ENV launch delivery

Status: slices 1, 2, 3, 4, 6 and 7 implemented, slice 8 partially implemented,
with supervisor wiring of the stable issuer key into DSH, Pi and Codex Core.
The receiver takes its expected context from the execution owner's own durable
admission (Decision 1). Slice 4 adds the v2 launch context (Turn, creation and
terminal admissions) to the protocol, the issuer and the receiver; slice 6
makes the Hands terminal owner its first consumer (terminal admissions), and
slice 7 makes Codex receive creation and Turn ENV in the split Codex Core
process that owns `codex app-server`, with the core vault owner as issuer. DSH
in `assets` mode receives Turn ENV through
`EnvironmentLaunchReceiver` when either the identity composition supplies a
vault-owner port or the installation sets `environmentDelivery: 'opaque'`
without such a port, which makes the core vault Worker the issuer and the owner
of ENV metadata (see [Supervisor wiring](#supervisor-wiring)). An
identity composition that owns the vault itself can supply its durable
execution admission and its metadata port with that port, and is then relayed
on the same path (see [Compatibility](#compatibility)). Pi
receives it the same way in the independent engine host when that host's
configuration pins `environmentIssuer`; the independent DSH host takes the same
key. The Hands terminal owner receives it
for every terminal it launches when the core vault owner is configured (see
[Hands terminal](#hands-terminal)). Codex receives creation and Turn ENV in
Codex Core when a vault owner with Codex record readers (the core vault owner,
or an identity port carrying `launch`, `admitCreation` and `git`) and a Codex
Core endpoint are configured (slice 7). The deployment supervisors pin the key
the vault owner publishes into DSH, Pi and Codex Core (see
[Supervisor wiring](#supervisor-wiring)). Every other consumer still reads a
decrypted snapshot from `ExecutionEnvironmentRuntime` synchronously in its own
process.

Related: [account environment variables](../identity/account-environment.md),
[execution control](execution-control-authority.md),
[execution sandbox](execution-sandbox.md),
`packages/execution-environment/src/environment-delivery.ts`.

## Goal

An installation can let one vault owner (for example a dedicated Worker) hold
the account ENV store. Main/Gateway then relays only routing metadata and an
opaque, purpose-bound capsule; it never holds decrypted values, never opens the
vault synchronously on the network event loop, and never signs execution scope
with the vault key. Execution owners open the capsule inside the process that
launches the command.

Installations without a separate vault owner keep the existing synchronous
runtime unchanged until each consumer has migrated.

## Inventory of synchronous ENV consumers

Line numbers refer to `82719ef`. "Values" means the consumer obtains decrypted
variables; "metadata" means it reads or writes vault documents that are not
values (Project binding, creator provenance, project catalog, scope envelopes),
still synchronously on the vault.

| #   | Consumer                 | Location                                                                                                                              | Use                                                                                                                                                        |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Headless composition     | `apps/headless-server/src/headless-application.mjs:812-814`                                                                           | selects DSH `legacy` mode (own vault open) when `identity.executionEnvironment` exists                                                                     |
| 2   | Headless Pi (in-process) | `headless-application.mjs:847`                                                                                                        | passes the runtime to `PiEngine` running inside Main                                                                                                       |
| 3   | Hands terminal           | `headless-application.mjs:931`, `apps/headless-server/src/host-terminal-transport.ts:26`                                              | `snapshot(scope).overlay()` in Main, sent as clear `identity.env` to the terminal owner                                                                    |
| 4   | Terminal scope           | `headless-application.mjs:966`                                                                                                        | `scope(context, …)` derives account/Project (metadata)                                                                                                     |
| 5   | Codex adapter wiring     | `headless-application.mjs:1042`                                                                                                       | passes the runtime to the Codex adapter; with a vault owner (core or identity) and a Codex Core it passes the delivery port instead (slice 7)              |
| 6   | Execution transport      | `headless-application.mjs:1127-1128`, `apps/headless-server/src/execution-environment-transport.ts:20-21,49,57-59,87,106-107,121-123` | `scope`, `bind`, `bindCreator`, `rememberProjects`, `seal` (vault-key scope envelope for ACP creation), and a private `DurableHostProcessService(runtime)` |
| 7   | Local process identity   | `apps/local-agent-host/src/process-identity.ts:28-41` via `process-service.ts:53`, `durable-process-service.ts:126`                   | `snapshot(scope)`, `apply`, `overlay` for PTY spawn                                                                                                        |
| 8   | DSH legacy mode          | `apps/local-agent-host/src/dsh-capability-plugin.mjs:80`, `dsh-execution-environment.mjs:7`                                           | opens a second vault runtime in the DSH process; sync `environment(nativeId)` patched into `dsh-bash-local` and `dsh-terminal-bash`                        |
| 9   | Pi engine                | `plugins/pi-engine/src/session.ts:200-203,236,269`, `shell.ts:43`                                                                     | `runtime.snapshot(runtime.execution(…))` for NodeExecutionEnv and shell workers                                                                            |
| 10  | Pi engine host           | `scripts/server-deployment/engine-host.mjs:84`                                                                                        | opens its own vault runtime in legacy mode                                                                                                                 |
| 11  | ACP engine               | `plugins/acp-engine/src/index.ts:185-186,475-476,494,889-892,954`                                                                     | `open` (scope envelope), `snapshot`, `creation`, `execution`, `rememberCreation`, local `redact`                                                           |
| 12  | ACP host                 | `scripts/server-deployment/acp-host.mjs:50`                                                                                           | opens its own vault runtime                                                                                                                                |
| 13  | Codex adapter            | `apps/opencraft-daemon/src/codex-engine-adapter.ts:761,1405,2012-2015,2544,2580-2582,3578-3580,4790,4848-4854,4943,4989`              | `scope`, `snapshot`, `execution`, `bind`, `bindCreator`, `redact`; values sent to the native Core as `shell_environment_policy.set`. Unchanged without delivery; with it (slice 7) the adapter relays capsules only and loads no synchronous runtime |

Thirteen entries across fourteen source files. Consumers 4, 6 (except the private
terminal service) and the metadata calls in 11 and 13 do not need values but
still require the synchronous vault.

The asynchronous Git handoff (`createRemoteHumanGitExecution`, used by DSH
`assets` mode and the Pi engine host) is not an ENV consumer: in `assets` mode
those owners currently receive no personal ENV at all.

## Target flow

```
execution owner (DSH/Pi/ACP/Codex/terminal process)
  EnvironmentLaunchReceiver(purpose, instance, pinned issuer key)
        │ POST /host-environment {recipient: receiver public key}
        ▼   (same-UID HMAC token, audience "host-environment", bound to serverId/thread/input|turn)
Gateway (Main): derive purpose+instance from the authenticated attachment,
  read the live Actor/lease handoff → context {scope, native}
        │ port.seal(target, context)        (async; no values cross)
        ▼
vault owner: EnvironmentLaunchIssuer.seal(target, context, read, assertCurrent)
        │ opaque capsule
        ▼
Gateway: reread handoff; discard unless unchanged; reply {context, capsule}
        ▼
execution owner: read its own durable admission (Worker), require the relayed
  context to equal it, then receiver.open against the OWNER's context
```

- **Issuer.** The sole vault owner. Its X25519 key is pinned into execution
  owners through trusted composition (process configuration), never from a
  request or browser frame. Headless receives it either from the identity
  composition as `identity.environmentLaunch = { issuer, seal(target, context) }`
  or, with `environmentDelivery: 'opaque'` and no such port, from the core issuer
  (`EnvironmentLaunchOwner`) in the Headless assets Worker, which already is the
  only opener of `employee-git-vault.sqlite`. The core issuer key is sealed in
  that vault and survives vault-owner restarts; it changes only by explicit
  rotation. Execution owners are pinned at launch, so a rotation requires them
  to be relaunched (the embedded DSH is; independent hosts are relaunched by
  their supervisor).
- **Receiver.** Constructed inside the process that spawns commands. `instance`
  is the authenticated capability attachment (`server:<machine>:<engine>`). The
  Gateway derives purpose and instance from that attachment; the request carries
  only the receiver public key.
- **Context.** The existing `GitExecutionHandoff` scope and native identity:
  Actor account and generations, membership revision, lease generation, input
  and execution IDs, Project ID (always `null` from a handoff), native Turn and
  incarnation. The execution owner reconstructs the expected context from its
  own durable admission (`createRemoteEnvironmentLaunch({admission})`); the
  relayed context must equal it field by field, the capsule is opened against
  the owner's context, and the admission is reread before and after decryption.
  A Gateway that reports no admission while the owner holds one, or the
  reverse, is refused. For DSH the admission is the `opencraft-server`
  execution lease and Actor store, read read-only by
  `execution-admission-worker.mjs` in a Worker of the DSH process (the same
  projection its Git broker uses), plus the live process incarnation.
- **Opening.** One capsule per launch preparation. It is opened after the
  owner's own Turn check and before the command is spawned. The resulting
  snapshot lives only in the execution process.
- **Redaction.** Performed where values exist: `ExecutionEnvironmentSnapshot.redact`
  in the execution owner. Main cannot redact values it does not hold; owners
  that forward native stderr or error text must redact locally before
  forwarding, and Main keeps treating native diagnostics as private.
- **Scope signing.** With capsule delivery the issuer authenticates the context
  through AEAD associated data; Main no longer signs scope with the vault key
  (`ExecutionEnvironmentRuntime.seal/open`). Creator provenance and Project
  binding remain non-secret metadata and move to an asynchronous owner port.

## Launch context v2

The v1 context is an admitted native Turn (`{scope, native}`) and stays valid:
v1 capsules (`env1.`) keep opening for the purposes `dsh`, `pi` and `codex`,
byte for byte as before. ACP session creation, Codex `thread/start`/`fork` and
Hands terminals launch before or outside a Turn, so v2 carries a discriminated
admission instead:

```
{ version: 2, admission:
    { kind: "turn",     account, actorGeneration, membershipRevision, hostId,
                        threadId, inputId, executionId, leaseGeneration, turnId, incarnation }
  | { kind: "creation", account, actorGeneration, membershipRevision, hostId,
                        operationId, source /* forked Thread or null */, incarnation }
  | { kind: "terminal", account, actorGeneration, membershipRevision, hostId,
                        threadId /* or null */, resource, operation, incarnation } }
```

- **Wire.** Capsule prefix `env2.`; the AEAD associated data (and the HKDF info
  that hashes it) starts with the label `opencraft.environment-launch.v2`
  instead of `.v1`. Each kind has an exact key set, normalized in a fixed order,
  and the `kind` is part of the authenticated header. The receiver chooses the
  version from the owner's expected context, never from the capsule, so a v1
  capsule cannot open against a v2 expectation (or the reverse) and a capsule of
  one kind cannot open against another kind with overlapping identifiers.
- **No Project.** A v2 context has no `projectId` field at all. Only Human Actor
  accounts (`actor:human://…`) with their generation and membership revision are
  admitted.
- **Purpose and kind.** `dsh` and `pi`: `turn`. `acp` and `codex`: `creation`,
  `turn`. `terminal`: `terminal`. A Codex Turn is staged before its input is
  submitted, so on `local-codex` (and only there) a `turn` admission is the
  pending lease and its `turnId` is `null`; every other Host names the active
  native Turn. Codex targets `local-codex`; DSH, Pi and ACP
  target `opencraft-server`; a terminal may target either. A v1 context is never
  sealed for `acp` or `terminal`. The issuer checks this before reading values;
  the receiver refuses an expectation its purpose cannot carry.
- **One-shot.** Every capsule is consumed once (nonce set). A Turn launches once
  per capsule (one per command). A creation or terminal admission launches once
  per receiver: a second capsule for the same admission is refused even when it
  is fresh. The lasting fence is the durable record leaving its admissible state
  once the launch happens; the receiver's set closes the window before that
  write.

### Durable admission per kind

Decision 1 applies to every kind: both the vault owner (issuer) and the
execution owner (receiver) read core's own durable record, compare the relayed
claim with it field by field and reread it around the value read and the
decryption. A request, a relayed context or a Main-signed scope envelope is
never the authority.

| Kind       | Durable record                                                                                                                                                                                                                                                                                                                                         | Admissible while                                                                                                                                 | Project source (vault owner)                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `turn`     | Execution lease and submission plus the Actor store, as for v1 (`GitExecutionAuthority`). Codex: the pending lease of the input (`turnId: null`).                                                                                                                                                                                                      | the lease is active for that Turn and native incarnation (Codex: pending for that input and native incarnation)                                  | the Thread binding                                             |
| `creation` | A creation reservation keyed by Host and creation `operationId`, written by core when it accepts the authenticated creation request and before the native creation: Actor and epoch at admission, source Thread (fork), Project and the owner incarnation holding it. Implemented as `environment_creation_reservations` in `opencraft-server.sqlite` (v24). | the reservation is pending, unexpired and its Actor still holds the recorded epoch; it stops being admissible once it is launched or abandoned | the reservation (fork: the source Thread binding at admission) |
| `terminal` | The terminal owner's reservation (Host, `resource`, `operation`), written before spawn, together with the Actor epoch it was admitted under and the owner incarnation (terminal journal v2).                                                                                                                                                           | the reservation is held and nothing has been launched for it                                                                                     | the Thread binding; none for a threadless terminal             |

Ports in this slice:

- Issuer: `new EnvironmentLaunchOwner(vault, turnAdmission, { creation?, terminal?, codexTurn? }, { accounts? })`.
  A reader returns `{ admission, project }` from the durable record, or `null`
  (`codexTurn` returns the admission; its Project is the Thread binding). A kind
  without a reader is refused before any value is read. The Headless
  composition passes `terminal` (slice 6), and `creation` and `codexTurn`
  (slice 7). The terminal reader receives the claim, because the reservation
  lives in the terminal owner's journal (see [Hands terminal](#hands-terminal)).
  `launch(target, locator)` reads the record the locator names and seals for
  exactly that admission, or returns `{context: null}` for a Turn without a
  Human owner; it serves Turns and creations, and refuses a terminal locator
  (terminals relay their claim to `seal`). `accounts` is the installation's
  [account partition mapping](#account-partition-mapping); it applies to every
  kind, `launch` included.
- Identity vault owner: `identity.environmentLaunch` may carry the same two
  record readers, `launch(target, locator): Promise<EnvironmentLaunchReply>`
  and `admitCreation(request: EnvironmentCreationRequest):
  Promise<EnvironmentCreationRecord>` (the core Worker's
  `environmentLaunchRecord` and `environmentCreationAdmission`), both or
  neither, plus its personal Git execution owner
  `git: { hosts, authority, grant(locator), reservation(locator) }`, the
  members the core assets Worker offers as `gitHosts`, `gitAuthority`,
  `executionGitGrant` and `executionGitReservation`. Headless builds the Codex
  port (`coreCodexEnvironmentLaunch`) and the Codex adapter's
  `createExecutionGit` (`codexExecutionGit`) from it exactly as from the core
  Worker, and the Gateway Git owner (DSH `hostGit`, the Git status tool) too.
  Core checks that the admitted creation record is the request it sent and
  rechecks the Actor before and after the vault owner answers; the Git owner
  rechecks the Actor and the native process around every grant, as before.
- Public entry points for such an identity composition, so it builds these
  members from core's records instead of copying core code:
  - `@opencraft/headless-server/assets-execution-records`:
    `createHeadlessExecutionRecords({ directory, environmentAccount? })` returns
    `{ execution, environmentRecords, environmentAccounts? }`, exactly what core's
    own assets Worker passes to `createAssetsStorage` (the `GitExecutionResolver`
    and the `codexTurn`/`creation`/`actorEpoch` readers over the data
    directory's execution leases, creation reservations and Actor store).
    Its reads are synchronous SQLite: call it only inside the vault Worker.
  - `@opencraft/headless-server/workspaces/execution-service`:
    `openWorkspaceExecutionService(options)`, the Gateway facade over that
    Worker's public workspace owner. With
    `assistantEnvironmentConfigurationManaged` core opens no assets Worker and
    requires `codexWorkspaceRouting` from the identity; the composition opens
    this facade over its own Worker port and offers the result. It holds no
    vault access; catalogs stay partitioned by `actor:<actorId>`. Its
    `releaseConversation` and `conversationScopes` are registered as the
    conversation resources `workspace` owner (archive/delete cleanup, after
    `browser`) and as archive reconciliation scopes, exactly as for core's own
    routing: any `codexWorkspaceRouting` carrying both is that one owner;
    carrying neither keeps no workspace owner; carrying one is refused. Its
    `admit(context)` and `admitResource(actorId)` return the Human proof
    (`WorkspaceActorAdmission`) the service itself sends, for the composition's
    own calls to its Worker port, which rechecks it. They run on the Gateway
    main thread inside the trusted composition; `admitResource` is for a
    stored grant the caller has already authorized. Actor or membership
    changes and `close()` retire the permits they issued.
  - `@opencraft/headless-server/workspaces/actor-admission`:
    `openActorAdmission({ actors, membership, access })` issues the same Human
    proof without workspace execution (no `socketPath`/`token`), for a
    composition whose vault Worker also serves settings routes, Bot
    environment providers or MCP sessions. It is the one implementation the
    execution service uses. `access` may be a function, for instance policy
    created after the identity; while it is absent nothing is admitted.
    Members: `admit(context)`; `admitPrincipal(principal, { provider? })` for
    an authenticated login principal, resolved by its identity binding and
    valid until its expiry, at most 120 seconds; `admitResource(actorId,
    generation?)` for a durable owner, 30 seconds, refused when a given
    generation is not current; `close()`. The resource permit is shared per
    Actor generation and membership revision and retires as above.
- Receiver: `createEnvironmentLaunchAdmissionReceiver({ purpose, instance,
issuer, admission: { turn?, creation?, terminal? } })` (subpath
  `environment-launch-receiver`). `kinds` lists what it can admit (allowed for
  its purpose and backed by a reader); `open(locator, reply)` reads the record
  the locator names, requires the relayed context to equal it, opens against
  the record and handles `{context: null}` exactly as v1 (an empty launch only
  when neither side holds a Human admission).

## Cancellation, late and duplicate delivery

- A capsule expires after at most 60 s and is consumed once per receiver
  (nonce set); a duplicate or replayed capsule is refused, never reapplied.
- The receiver calls `authorize(expected)` before and after decryption; the
  execution owner's Turn observer and abort signal are checked before the
  request, after the reply and after opening.
- The Gateway rereads the live handoff after sealing and discards the capsule
  if Actor, lease, native incarnation or routing changed.
- A late reply after cancellation, Turn end, process replacement or receiver
  close fails before spawn. Delivery is not retried automatically; the next
  command issues a fresh request against current admission.

## Failure semantics

- Configured delivery fails closed with the opaque `environment_launch_unavailable`.
  It never falls back to an empty environment or to the synchronous runtime.
- An empty environment is returned only when the Gateway affirmatively reports
  no Human admission for that Turn (`{ context: null }`), matching today's
  unowned-Turn behaviour. A capsule without context is malformed.
- Errors, logs and replies carry no values, capsule contents or private keys.
- Main-thread rule: the Gateway relay and the vault-owner port are
  asynchronous. No consumer may add a synchronous vault read as a fallback.

## Core vault-owner issuer

`EnvironmentLaunchOwner` runs inside the Worker that owns the vault. Main's port
is `{ issuer, seal(target, context) }`; `seal` resolves to the opaque capsule and
the Worker serves no method that returns values, Project bindings or keys. For
each seal the owner:

- requires the context to be from a handoff (`projectId: null`) for an
  `opencraft-server` Turn, and to equal the durable admission it reads itself
  (`GitExecutionAuthority`, the same lease and Actor projection as Git grants);
- resolves the Project from the Thread's binding in the vault
  (`environmentThreadProject`, the document the Gateway records from the Host's
  thread metadata), never from the request, handoff or locator;
- rereads admission and binding before reading values, after reading them and
  after encryption, and refuses on any change;
- reads values with `AccountEnvironment.launchEnvironment` and returns only the
  capsule. Errors are the opaque `execution_unavailable`.

Closing the Worker retires the issuer key first, then the admission reader and
the vault; seals accepted before close are drained, later ones are refused. A
Worker that was asked to issue but did not start an issuer fails startup.

The issuer's X25519 private key is a vault document (`platform:environment`,
`document-environment-issuer`), encrypted under the vault key with the vault's
AAD like every other document. `sealedEnvironmentIssuerKey` reads it at start
or creates it once. A configured rotation generation
(`OPENCRAFT_ENVIRONMENT_ISSUER_GENERATION`) that differs from the stored one
replaces the key; no generation keeps the stored key. A stored document that is
not a valid key fails startup instead of being replaced silently. An identity
composition that owns its vault receives the same generation (see
[Supervisor wiring](#supervisor-wiring)) and applies it to its own sealed key.

The same Worker also serves the personal Git seal port
(`PersonalGitSealPort` from `@opencraft/execution-environment/personal-git-seal`,
`{ authority, seal(scope): Promise<string> }`), exposed to Main as
`assetsStorage.personalGitSeal`. Only the grant fields of an admitted scope go
in and only the opaque grant comes back. `PersonalGitSealOwner` seals a scope
only while it equals the Worker's own durable admission (the active Turn, or a
Codex pending reservation), read before and after signing; it serves no key or
credential getter. Grants keep the existing `v2.`/`v3.` envelope and authority,
so the Git runtime verifies them exactly as before. The Worker's
`executionGitGrant` and `executionGitReservation` handoffs already sealed in this
Worker and are unchanged. Close retires the seal owner with the ENV issuer;
seals accepted before close are drained.

In this mode the same Worker also owns the non-secret ENV metadata (slice 8):
Main composes `EnvironmentMetadataTransport` instead of the synchronous
`ExecutionEnvironmentTransport`, and Thread->Project bindings, creator
provenance and the Project catalog are written through the Worker's
asynchronous `EnvironmentMetadataPort`, so new Threads receive their Project
values.

### Account partition mapping

By default the issuer reads the canonical Actor partition (`actor:<id>`). An
installation whose existing vault data is partitioned by a login account can
compile a mapping into its vault-owner Worker entry instead of rewriting data:
`createHeadlessAssetsStorage(directory, providers, workspaces,
{ environmentLaunch: true, environmentAccount })`, where
`environmentAccount: EnvironmentAccountMapping` is
`(owner: { actorId, actorGeneration, bindings }) => string | null`
(`environment-account.ts`). Worker data, requests and configuration cannot
supply or select it.

- `EnvironmentAccountPartitions` reads the owner from the Actor store in the
  Worker (`GitExecutionAuthority.environmentAccountOwner`: an enabled, admitted
  Human Actor and its verified login bindings) and calls the mapping with a
  frozen copy.
- The result must be the owner's canonical partition or the login partition
  (`<provider>:<subject>`, the form core already uses for login accounts) of
  exactly one verified binding, whose provider the Actor holds no other binding
  of. Another Actor's canonical partition, `platform:` documents, `null`, a
  thenable or a throw are refused. Two bindings that spell the same partition,
  or a provider with two logins, are ambiguous and refused.
- The mapping runs synchronously in the vault owner's turn. After it returns
  the owner is reread; the issuer rereads owner and mapping with the admission
  before reading values, after reading them and after encryption, so a binding
  revoked meanwhile, or a changed generation, refuses the capsule.
- `EnvironmentMetadata.admit` applies the same resolver to the submission's
  login account (`forLogin`): the admitted scope, and the creator recorded for a
  new Thread, name the partition its values are read from. Thread->Project
  bindings and the Project catalog are installation documents and are not
  partitioned by account.
- The issuer applies the mapping to every kind it seals: active Turns,
  terminal claims (slice 6), and the Codex pending Turns and creation
  reservations of slice 7, including `launch(target, locator)`, which seals
  through the same check. The durable records keep naming the canonical
  `actor:<id>` account; only the partition the values are read from is mapped,
  and it is rechecked with the record.
- Without a mapping both are unchanged. Personal Git grants still carry the
  canonical Actor account; mapping their partition is not part of this change.

## Supervisor wiring

Independent execution owners (DSH, Pi and the split Codex AppServer) pin the
issuer from their own configuration. The configuration gets the key from the
vault owner's publication only. Delivery and pinning are a deployment setting;
which vault owner publishes is decided by the Gateway's composition alone:

- **Setting.** `OPENCRAFT_ENVIRONMENT_DELIVERY=opaque` (option
  `environmentDelivery: 'opaque'`) turns on ENV delivery and the published
  issuer. It does not name an owner. The earlier value `vault-owner` is still
  accepted with the same meaning and is normalized to `opaque`.
- **Owner selection (Gateway).** `environmentLaunchOwner` picks exactly one
  owner: the identity composition's `identity.environmentLaunch` when it
  supplies one, else, with delivery, core's assets vault Worker. Delivery or
  the port beside the synchronous runtime (`identity.executionEnvironment`) is
  refused with `Execution ENV cannot have two owners`; nothing falls back to
  another owner. With delivery, `createIdentity` receives
  `environmentIssuer: { publish?, generation? }` (frozen; absent without
  delivery): the composition passes it to its vault Worker
  (`createAssetsStorage`'s `environmentIssuer`), so the identity owner
  publishes at the same path and rotates with the same generation as core's
  Worker would. Core cannot observe whether the composition applied the
  generation; it does check the publication: with a publication path, the
  Gateway refuses to start unless the published key equals
  `identity.environmentLaunch.issuer` once `createIdentity` returns.

- **Publication.** With `environmentIssuer.publish` (deployment variable
  `OPENCRAFT_ENVIRONMENT_ISSUER_FILE`), the vault-owner Worker writes
  `{"schemaVersion":1,"issuer":"<public key>"}` to that path: an owner-only
  (0600) regular file in the private data directory, replaced atomically and
  only when its content changes. It never contains the private key. Main does
  not write it. A Headless Gateway with delivery and an independent engine
  host refuses to start without a publication path, before any owner starts.
- **Reading.** `readPublishedEnvironmentIssuer`
  (`@opencraft/execution-environment/environment-issuer-publication`, shared by
  the deployment supervisors and Codex Core) accepts only a regular file (no
  symlink) owned by the same user with no group or other access, exactly the
  two fields and a well-formed key. Anything else is refused. A Gateway reply, a
  Host descriptor, a request or an environment variable never supplies a key.
- **Missing or refused key.** The supervisor pins a freshly generated X25519
  public key whose private half is discarded (`unissuableEnvironmentIssuer`).
  The receivers exist, every capsule for a Human Turn is refused
  (`environment_launch_unavailable`), and unowned Turns stay empty as before.
- **Container (Brain).** `deploymentPaths` reads `OPENCRAFT_ENVIRONMENT_DELIVERY`
  (Assets context only) and fixes the publication at `run/environment-issuer.json`
  in the data directory. Brain has no notion of the owner: it pins whatever key
  is published there. Both services take the same value, so an installation
  whose identity composition owns the vault sets it on both, exactly like one
  that uses core's Worker. The Gateway passes that path to the vault owner. Brain's
  workspace agent (`workspace-agent-roles.mjs`, `brain` role) starts before the
  Gateway's vault owner exists, so only this stable published key (or an
  unissuable one until it is published) can be pinned. The role writes
  `environmentIssuer` into the DSH and Pi host configurations and
  `codex-app-server-environment.json` for the split Codex AppServer
  (`{issuer, instance: "server:<machine>:codex", admissionWorkerFile, directory}`:
  the same key, the machine read from the shared data directory's `machine-id`,
  `runtime/execution-admission-worker.mjs` of the Brain payload and the data
  directory), all three in the agent's container-private run directory
  (`OPENCRAFT_AGENT_RUN_DIR`), passes the last as `--environment-launch-config`,
  then starts them and polls the publication. When a valid key differs from the
  pinned one, the role retires Pi, DSH and the AppServer (its native process
  group included) through the agent supervisor, so none of these stops counts as
  a critical child failure, rewrites all three files and starts the AppServer,
  then DSH and Pi again as ordinary critical children. AppServer replacements
  (this one and a Hands rebinding) run one at a time. Until that completes all
  three keep the previous key and deliveries fail closed. A successor that does
  not become ready, or a failed rewrite, ends the agent (a new Brain incarnation).
  Once the successors are ready the agent's `endpointGeneration` moves, so the
  Gateway's workspace runtime drops the DSH and Pi descriptors it cached for the
  retired owners at its next observation (Gateway health) and reattaches.
  The container packaging checks that the admission Worker is in the payload.
- **systemd.** The engine and DSH host configurations name the publication as
  `environmentIssuerFile`. Each host resolves it once at launch, with the same
  rules, into `environmentIssuer`. The AppServer's launch file
  (`opencraft-codex-appserver-environment.json.example`, passed by the drop-in
  `opencraft-codex-appserver-environment.conf.example`) names it as
  `environmentIssuerFile` too; `app-server-bin` resolves it once at launch into
  `issuer`, and names a pinned payload's `execution-admission-worker.mjs`.
  `opencraft-environment-issuer.path.example` restarts the three units when the
  publication changes.
- **Unchanged path.** Without delivery there is no publication, no watcher, no
  `environmentIssuer` in any host configuration and no AppServer launch file or
  flag.

## Compatibility

- No `identity.environmentLaunch` and no `environmentDelivery`: every path is
  unchanged.
- `identity.environmentLaunch` together with `identity.executionEnvironment` is
  rejected: one installation has one ENV owner. Delivery
  (`environmentDelivery: 'opaque'`) together with `identity.executionEnvironment`
  is rejected at startup (`environmentLaunchOwner`), as is a core issuer
  without the assets vault Worker or without execution admission. Delivery
  together with `identity.environmentLaunch` selects that port as the only
  owner; core's Worker does not issue. Before this, that combination was
  refused, so no running installation changes meaning.
- `environmentLaunch` without an Actor/lease handoff is rejected at startup
  instead of failing every command. The handoff is core's own
  (`humanGitExecution`) or, for an identity composition that owns the vault,
  `identity.environmentLaunch.admission(locator): Promise<{scope, native} | null>`:
  only the durable read of the exact Turn, with no Git authority or capability,
  because the relay seals against nothing else. Core wraps it
  (`createEnvironmentAdmissionHandoff`) with the same live checks as its Git
  handoff: the record must belong to the locator, be a Human Actor account and
  name no Project; the Actor must be current and admitted by Human instance
  authority and the lease active for the live native process, before and after
  every await. A failing read is an error, never an empty launch. Supplying an
  admission where core already owns the handoff is rejected (one admission
  owner), as is one without Human instance authority.
- Such a port may carry `launch`, `admitCreation` and `git` (see
  [Ports](#durable-admission-per-kind)). `validateHeadlessIdentity` refuses
  only one of `launch`/`admitCreation`, a non-function reader, and a `git`
  without non-empty unique lowercase hosts, a 64-hex `authority` or both
  handoffs. A `git` beside core's own assets vault is refused (one Git owner),
  as is one without Human instance authority. With a split Codex Core
  (`codexCoreEndpoint`) any configured vault owner must wire both Codex ENV and
  Git, or startup fails with `Codex environment delivery requires launch,
  creation admission and a personal Git owner`; this applies to the core vault
  owner too, which always has both. Such an installation previously started
  and ran human Codex Turns without personal ENV or Git; it must now supply
  the three members. Without a Codex Core endpoint nothing changes (see
  [Decisions](#decisions)).
- Such a port may carry `metadata: EnvironmentMetadataPort`; core then composes
  `EnvironmentMetadataTransport` for it exactly as in `vault-owner` mode, so new
  Threads record their Project binding and creator. A port with an admission but
  no metadata, or with malformed parts, is rejected by
  `validateHeadlessIdentity` before anything starts. A port without either
  keeps its previous behaviour (core handoff, owner records its own bindings).
- Delivery together with Pi running inside Main (no `engineHostDescriptor`) is
  rejected at startup instead of launching Pi without ENV. An engine host given
  `environmentIssuer` outside the Assets execution context is rejected too.
- Owners that have not migrated keep the synchronous snapshot. A configured
  receiver against a Gateway without the route fails closed.
- Independently installed execution owners must be updated before their
  delivery is effective; installing a Gateway alone does not migrate them.
- Without `OPENCRAFT_ENVIRONMENT_DELIVERY` no issuer is published or pinned and
  the host configurations are unchanged. A key sealed by an earlier delivery
  stays in the vault unused.
- A Hands terminal owner opts in (`environmentLaunch`); an owner that did not
  opt in, or an old one, ignores the declared issuer and a delivery Host
  refuses to spawn on it. An old Host attaching to a new owner declares no
  issuer and spawns as before.
- Personal Git grants. Without a seal port `ExecutionEnvironmentRuntime` signs
  in-process with the vault key, as before (`snapshot` and `prepare` are the
  same). Given `{ gitSeal }` it never uses the vault key for grants: `prepare`
  admits the scope, awaits the port, then rechecks admission and its own close;
  a synchronous `snapshot` of a grant-bearing scope fails with
  `personal_git_async_issuer_required` instead of signing locally. Grant format,
  authority and verification are unchanged, so grants issued before an upgrade
  and the Git runtime keep working. The Codex adapter issues through `prepare`.
  Synchronous-only consumers (in-process Pi's `env` callback, the Hands terminal,
  DSH `legacy`, the ACP host) cannot use a seal port and fail closed with it.

## Slices

Each slice is independently mergeable and leaves unmigrated consumers on the
synchronous runtime.

1. **DSH Turn launch (`assets` mode).** `/host-environment` audience and route,
   `createRemoteEnvironmentLaunch` (receiver side), `createHostEnvironmentLaunch`
   (Gateway relay), identity validation, DSH composition; DSH `prepare` merges
   ENV and Git overlays for `bash` and the persistent terminal. Tests: real
   loopback route, opaque relay, one-shot/replay, lease change while sealing,
   Turn end, abort, process replacement, closed receiver, foreign attachment
   and issuer, audience separation, compatibility. Evidence: package and app
   typechecks, existing DSH/Git/session-capability tests, a pinned-DSH run with
   `OPENCRAFT_DSH_RUNTIME` showing a command reading a vault-only value.
2. **Pi engine host (implemented).** The relay serves purpose `pi`; the
   independent engine host constructs the receiver (`instance`
   `server:<machine>:pi`) with its issuer pinned by its own configuration
   (`environmentIssuer`, Assets execution context only) and reads its durable
   admission by input in the same admission Worker as DSH, additionally
   requiring a Pi Thread of this live process. For each shell launch Pi
   prepares the opaque ENV and its Git grant for the same input and joins them
   with `ExecutionEnvironmentSnapshot.combine` (same owner, no name shadowing a
   Git variable), then rechecks that the input still owns the live run. Shell
   workers are keyed by the combined snapshot. Headless refuses delivery
   together with in-process Pi at startup, and `PiEngine` refuses a receiver
   without its Git port or beside a synchronous runtime. Tests
   (`pi-environment-launch.test.ts`, `environment-launch-owner.test.ts`,
   `independent-engine-host.test.mjs`, `headless-composition.test.mjs`): one
   worker per snapshot, reuse by key, revocation retires the worker and
   interrupts its command, unowned input, no value in any relayed reply,
   combine refusals, in-process refusal, unconfigured compatibility, a durable
   admission read by input, and an engine host booting with a pinned issuer.

   Supervisor wiring (implemented after slice 2, extended to slice 7). The
   deployment supervisors write the vault owner's published key into the DSH
   and Pi host configurations and the split Codex AppServer's launch file, and
   relaunch all three when it changes (see
   [Supervisor wiring](#supervisor-wiring)). The independent DSH host accepts
   the same top-level `environmentIssuer`. Tests
   (`environment-issuer-supervision.test.mjs`, `environment-launch-owner.test.ts`,
   `independent-engine-host.test.mjs`, `headless-composition.test.mjs`): all
   three configurations carry the key, the AppServer's with its attachment,
   admission Worker and data directory, a changed publication relaunches all
   three and an identical one relaunches nothing, the AppServer resolves a
   named publication with the same rules, untrusted publications are refused,
   a missing key pins an unissuable key under which a Human Turn fails closed,
   the sealed key survives a vault-owner restart, explicit rotation, and an
   unconfigured deployment writes the previous configurations.
3. **Core vault-owner Worker issuer (implemented).** `EnvironmentLaunchOwner`
   runs `AccountEnvironment.launchEnvironment` in the Headless assets Worker that
   owns the vault, so core installations can use slices 1-2 without a downstream
   port. Per Decision 2 the Project is resolved from the Thread's vault binding,
   not carried by the handoff. Tests (`environment-launch-owner.test.ts`): no
   decrypted value in any Worker-to-Main message, no decrypted getter, Project
   from Thread metadata, wrong-project and forged contexts refused, one ENV
   owner at startup, close drains and retires the key. A restart originally
   pinned a new key; the key is now sealed in the vault and kept across
   restarts (see Decisions).
   `check-main-thread-sync-io` adds no call.
4. **Protocol change: launch context without a native Turn (implemented).**
   ACP session creation, Codex `thread/start`/`fork` and Hands terminals launch
   before or outside a Turn, which the v1 context cannot express. The v2 header
   carries a discriminated admission (`turn` | `creation` | `terminal`), purposes
   `acp` and `terminal` exist, and v1 capsules keep opening (see
   [Launch context v2](#launch-context-v2)). Protocol, issuer and receiver
   validation only; the Gateway relay still serves `dsh` and no consumer
   changed. Tests (`environment-launch-context-v2.test.ts`): v1/v2 domain
   separation including relabelled bodies, no cross-kind confusion, wrong
   purpose/Host/attachment, replay and one-shot per kind, receiver and issuer
   checks against the durable record (including a record changing during
   decryption), kinds without a reader refused, v1 compatibility.
5. **ACP host.** Replace the scope envelope and the ACP host's own vault open
   with a creation capsule; keep per-session environment and local
   `redactError`. Tests: session reopen, account/Project switch requires a new
   session, revocation.
6. **Hands terminal (implemented).** The terminal owner becomes the receiver;
   the Host's prepare step becomes asynchronous and forwards the capsule instead
   of clear `identity.env`. See [Hands terminal](#hands-terminal). Tests
   (`terminal-environment-launch.test.ts`, `terminal-admission-journal.test.ts`):
   an opaque capsule and no value in any Main-to-owner or Worker-to-Main
   message, the owner opening under its own reservation, the Thread's Project
   and none for a threadless terminal, replay, unheld, abandoned, already
   launched, foreign quota owner, wrong kind, stale epoch, other recipient and
   v1/wrong-purpose capsules refused, held reservations expiring and released
   with their attachment, attach/list/control keeping their scope, capacity,
   managed-name override refusal, the unconfigured path unchanged, a delivery
   Host refusing an owner that cannot receive, the v1 journal upgrade, and the
   released v1 owner refusing a v2 journal.
7. **Codex Core receiver (implemented).** The receiver (purpose `codex`) runs in
   OpenCraft's own Codex Core process that owns `codex app-server` (the split
   AppServer, `startCodexAppServer({ environmentLaunch })`, configured by
   `--environment-launch-config` with the pinned issuer key, its attachment
   `server:<machine>:codex` and the server data directory; the supervisors
   write it, see [Supervisor wiring](#supervisor-wiring)). No native Codex
   release is needed: the native server keeps receiving
   `shell_environment_policy.set`, now from Codex Core.
   - The Codex adapter (Main) relays only opaque capsules and record locators.
     It asks the relay `opencraft/environment/launch` for the receiver key,
     has the vault owner seal for the record (`EnvironmentLaunchOwner.launch`),
     and sends `opencraft/environment/stage {locator, reply}`. Codex Core opens
     the capsule against its own durable admission, read by
     `execution-admission-worker.mjs` in a Worker of that process, and requires
     the admission's incarnation to be its live native child. It keeps the
     values and returns an opaque, per-process HMAC digest of the account and
     values, which the adapter uses only to decide whether a Thread must be
     reloaded.
   - The launch request (`thread/start` or `thread/fork` for `creation`,
     `thread/resume` of the same Thread for `turn`) carries
     `__opencraftEnvironmentLaunch: {locator, key}`. The relay consumes the
     staged delivery once, rereads the admission, checks that the request is
     the launch the record admits (a fork's source, a new Thread, the Turn's own
     Thread) and merges the values into `shell_environment_policy.set` beside
     the adapter's Git variables; a delivered name never shadows one. Any
     failure answers `Execution environment unavailable` (`notSubmitted`), and
     an owner without a receiver refuses the field instead of forwarding it.
   - Creation: before the native call the adapter writes the durable creation
     reservation. The vault owner admits the Actor's current epoch and the
     Project (fork: the source Thread binding; path forks are refused), then
     the Server owner Worker records it `pending` with a five minute expiry.
     When native answers, or the connection is lost, the adapter settles it
     `launched` (or `abandoned` when the relay reports it never submitted); it
     is never retried. Turns: the pending Codex lease of the input, staged in
     the refresh that reconfigures the Thread before `turn/start`.
   - Redaction: Codex Core replaces delivered values in every native error it
     forwards. Main holds no values and does not redact them.
   - Fail closed: delivery refused by the issuer, the receiver or a Core
     without the receiver (combined or routed Core) fails the creation or the
     input with a turn error that says it was not sent. Without delivery
     configured every path is unchanged.
   Tests (`codex-environment-launch.test.ts`, `server-storage.test.ts`): real
   Server owner, Codex lease store, vault Worker and admission Worker against a
   fake native server behind the real relay; values reach native, never a Main
   frame; replay, a second capsule for one reservation, wrong purpose, kind,
   recipient, attachment and native process, a launched reservation, a lease
   that left its pending state and a revoked Actor are refused; native errors
   are redacted; an owner without delivery refuses the field; the adapter
   reserves, relays and settles a Human creation and leaves an unowned one
   empty; reservation upgrade from v23 and checksum refusal.
8. **Metadata owner (partially implemented).** Move `scope`, `bind`,
   `bindCreator`, `rememberProjects`, `creation`, `execution` reads to an
   asynchronous owner port, then retire `identity.executionEnvironment` for
   installations with a separate vault owner. Evidence:
   `check-main-thread-sync-io` count decreases.

   Implemented. `EnvironmentMetadata` (`environment-metadata.ts`) is the one
   implementation of the metadata rules; `ExecutionEnvironmentRuntime` delegates
   to it, so installations without a separate vault owner are unchanged. With
   `environmentDelivery: 'opaque'` and core's Worker as owner, the assets Worker serves it as
   `EnvironmentMetadataPort` (`admit`, `project`, `bind`, `bindCreator`,
   `rememberProjects`): writes run FIFO with every other vault write, `admit` and
   `project` are committed-state reads. Scope admission is split at the process
   boundary: `environmentScopeRequest` checks the authenticated submission in
   Main without IO, `admit` applies the Thread binding and creator provenance in
   the Worker. `EnvironmentMetadataTransport` admits and dispatches requests in
   arrival order and rechecks the submission after each await; it forwards a
   Host response only after its metadata committed, in the Host's order, and
   drops a delayed frame whose native owner was retired. It mints no scope
   envelope (Main no longer signs scope) and never opens the vault; a failed
   owner rejects admission as not submitted and turns an uncommitted creation,
   binding or catalog response into an error. Close drains admitted requests and
   committing responses; the Worker drains accepted writes before it exits, and
   a restarted owner reads every committed document. `identity.executionEnvironment`
   is refused together with delivery (`environmentLaunchOwner`).
   Tests (`environment-metadata-owner.test.ts`): same rules as the synchronous
   runtime, response and request ordering, fail-closed Worker loss, close drain
   and restart, Main timers running while the Worker waits on a held vault lock,
   no port without a separate owner.

   Remaining, and why:
   - Hands terminal scope (consumer 4) stays synchronous. With slice 6 it no
     longer selects values: the vault owner takes the Project from the Thread
     binding. The scope only filters attach, list and control, and keeps the
     requested Project for that, so existing terminals keep their scope.
   - `creation`, `rememberCreation` and `execution` stay on the synchronous
     runtime: their only consumers hold values in their own process. ACP needs
     creation capsules (slices 4 and 5); Codex uses them only without delivery
     (slice 7 replaces them when delivery is configured), and the Pi Harness
     `env` callback and the DSH `legacy`
     `environment(nativeId)` hook are synchronous APIs.
   - An identity `environmentLaunch` port may now carry its own metadata port
     (see [Compatibility](#compatibility)); core composes the same
     `EnvironmentMetadataTransport` for it. A port without one still records
     its own bindings. With an account mapping the metadata owner and the
     issuer share one resolver (see
     [Account partition mapping](#account-partition-mapping)).
   - The `check-main-thread-sync-io` count is unchanged (257 calls, 1017 SQL
     statements), not decreased: the count is per file, and the lease read in
     `ExecutionEnvironmentRuntime.execution` and the vault store's SQL are still
     loaded on the main thread of the processes that run the synchronous
     consumers above. The vault-owner composition adds no call. The count
     drops when the last synchronous consumer of those files migrates.

## Hands terminal

With `environmentDelivery: 'opaque'` and no identity port, the core vault owner offers
`terminalActor(account)` next to `seal`. Headless then composes the Hands
terminal service with it; otherwise `prepare` is the synchronous path as
before. A downstream `identity.environmentLaunch` port without `terminalActor`
leaves terminals on that path (they receive no personal ENV, as before).

`process/spawn` from a delivery Host:

1. Main checks the request scope synchronously (unchanged) and asks the vault
   Worker for the Actor epoch (`terminalActor`). A revoked or unknown Actor
   stops here.
2. Main asks the terminal owner to reserve (`process/environmentReserve`). The
   owner writes the reservation before anything is sealed, with the Actor epoch
   and its own incarnation; the existing capacity limits apply here. It answers
   with the terminal admission and its receiver target.
3. Main has the vault owner seal for that target and admission, then forwards
   `{context, capsule}` with the spawn, plus the requested variables. Main never
   holds a value. A failure abandons the reservation.
4. The owner opens the capsule against its own held reservation (same quota
   owner, account, Host and Thread), refuses a requested name that would
   override a delivered one, runs its adapter, removes the launch admission
   from the journal (the one-shot fence), and only then spawns.

`process/attach`, `list`, `writeStdin`, `resizePty` and `kill` are unchanged and
keep their original scope. An attachment that pinned an issuer spawns only
through a capsule; an attachment without one cannot send a capsule. A Host with
delivery configured refuses to spawn on an owner that did not accept its issuer
(an old or not opted-in owner), instead of launching without ENV. A
reservation held but not launched is released after 90 s, when its attachment
closes, and when the owner restarts.

### Terminal journal v2

`terminal-admission.json` is a JSON journal with one writer (the admission
Worker under the writer lock), so its format changes by version, not by a SQL
migration.

- A v2 row is a v1 row plus `launch: { account, actorGeneration,
membershipRevision, hostId, threadId, incarnation }`, only on a local
  reservation and only while it is held. `incarnation` equals the row's
  `resource`.
- Launching removes `launch` in the same durable write that marks the row
  launched, before spawn. A row carrying `launch` is therefore proof that
  nothing was launched for it.
- The owner writes `version: 2` only while some row carries `launch`, and
  otherwise `version: 1` byte for byte as before. It reads both.
- On open, every row carrying `launch` belongs to an earlier incarnation and was
  never launched, so it is released and the journal is written back as v1.
- An owner without v2 support refuses `version: 2` as an invalid journal and
  does not start. It never drops a reservation it cannot read.

Rollback plan, to an owner without delivery support:

1. Remove `environmentDelivery` (or roll back the Host); new
   spawns stop writing held rows.
2. Stop the terminal owner cleanly. Held rows are released on close; launched
   rows are v1 rows already. The journal is v1.
3. If the owner crashed with a held row, start the current owner once (it
   releases the rows and rewrites v1) and stop it, then install the old one.
   Removing only the rows that carry `launch` by hand is equivalent.

## Decisions

Recorded after the first slice; later slices follow them.

- **Expected context comes from the execution owner's own durable admission.**
  The receiver reconstructs inputId, executionId, generation and Turn from the
  admission it already persisted and compares the capsule against that; a
  Gateway-relayed lease context is never the authority. Implemented for DSH;
  `tests/identity/environment-launch-owner.test.ts` reads a real lease store.
- **Project ENV is resolved by the vault owner from Thread metadata.** Handoffs do
  not carry a Project ID; a caller cannot select another project's values.
  Implemented in `EnvironmentLaunchOwner`; receivers refuse a locator or relayed
  context that names a Project.
- **Codex redaction moves to Codex Core**, which holds the values. It redacts
  every native error it forwards; native stderr is not forwarded. (Originally
  recorded as "the native Core"; slice 7 places the receiver in OpenCraft's own
  Codex Core process instead, so no native release is needed.)
- **A configured vault owner refuses execution owners that do not request a
  capsule** (for example an old DSH runtime), with an explicit upgrade error,
  instead of launching with an empty ENV. Missing delivery must fail closed.
- **A refused delivery retires Pi's delivered-value workers.** Values live
  only in the environment of the shell worker process, so stopping it is the
  only revocation. When a configured delivery is refused for a Pi Thread (lease
  replaced, Actor revoked, process replaced, or the Gateway unreachable), every
  worker holding delivered values for that Thread is stopped and its running
  commands are marked interrupted and are not replayed; a cancelled call does
  not retire anything. Idle workers of an older snapshot are still pruned when
  a new snapshot starts its worker, as before.
- **The independent engine host pins its issuer through its own
  configuration.** It is never learnt from the Gateway or its capability
  descriptor. A composition port with a stable issuer key suits this directly.
  Its supervisor writes the key the vault owner publishes; until a changed key
  is pinned, its deliveries fail closed.
- **The core issuer key is stable: sealed at rest by the vault owner and
  rotated explicitly.** Two options were compared. (a) One key per vault-owner
  Worker lifetime: the supervisor must relaunch DSH and Pi after every Gateway
  restart or update. The independent hosts exist so that Gateway updates do not
  stop running turns, so this would end every running DSH and Pi turn on each
  update. There is also a start-order cycle: the Gateway attaches to running
  hosts, but the hosts would need the Gateway's new key first. (b) A key sealed
  in the vault under the vault key and replaced only when the operator changes
  the rotation generation. Hosts are relaunched only on first enablement and on
  rotation. We chose (b). The guarantees are unchanged: the private key exists
  only inside the sole vault owner and is never sent anywhere, and the vault key
  that protects it already protects the values. Execution owners still pin the
  key through their own trusted configuration, never from the relay. Capsules
  stay purpose-, target- and context-bound, expire after 60 s and are opened
  once. Admission is still reread around every seal and open. The cost: a
  capsule captured in transit stays decryptable with the vault key until the
  key is rotated, also after its values change. Rotation closes that window,
  and Main, which relays capsules, runs in the vault owner's process anyway.
- **Pi's native file-tool environment receives no delivered values.** Only the
  shell worker launches commands with personal ENV; the native
  `NodeExecutionEnv` keeps the base environment, as it already does with the
  Git port alone.
- **The downstream port shape `{issuer, seal(target, context): Promise<string>}` is
  accepted for now**; slice 3 adds a core vault-owner issuer so installations no
  longer need to supply it. Implemented as `environmentDelivery: 'opaque'`
  (originally spelled `'vault-owner'`).
- **Delivery is separate from the choice of vault owner.** Delivery used to
  mean "core's Worker issues", so an identity composition that owns its vault
  could get Brain to pin its published key only by setting the variable on
  Brain and not on the Gateway. Two options were compared: (a) one deployment
  setting that turns on delivery and pinning, with the Gateway choosing the
  owner from its composition; (b) a separate pin-only setting next to the
  owner setting. We chose (a): the owner is already determined by the
  composition (the port is supplied or not), so a second setting would only
  add combinations that must be refused, while the publication path and
  generation are the same for either owner. The value was renamed to the
  neutral `opaque`; `vault-owner` keeps being accepted with the same meaning,
  because the only combination whose behaviour changed (delivery beside an
  identity port) was refused before.
- **v2 is a separate domain, selected by the receiver.** The version label is
  part of the authenticated header and the owner's expected context picks the
  version. v1 stays unchanged so already pinned execution owners keep working;
  new purposes exist only in v2.
- **A v2 context cannot name a Project.** Decision 2 becomes structural: the
  field does not exist. The vault owner takes the Project from the durable
  record of each kind (Thread binding or the creation/terminal reservation).
- **Creation and terminal admissions are one-shot; Turns are per capsule.** A
  reservation authorizes one launch. Durable one-shot is the record's state
  change, which slices 5 and 6 must write before or with the launch.
- **An issuer or receiver without a reader for a kind refuses that kind.** There
  is no fallback from a missing creation or terminal record to a Turn, to the
  relayed claim or to the synchronous runtime.
- **An installation may map the verified owner to its vault partition, only
  among that Actor's own partitions.** The mapping is compiled into the vault
  owner, chooses the canonical partition or the login partition of exactly one
  verified binding, and is reread with every admission check; ambiguity, a
  foreign partition or a revoked binding refuse the launch. It lets existing
  vault data keep its partition and AAD; the default remains the canonical
  Actor partition. Issuer and metadata owner share the resolver.
- **Personal Git grants are signed by the vault owner through an asynchronous
  port.** `PersonalGitSealPort` has the shape of the ENV ports (a public
  `authority` and `seal(scope): Promise<string>`). The core vault-owner Worker
  serves it; an identity composition that owns its own vault passes its own port
  as `new ExecutionEnvironmentRuntime(…, { gitSeal })`. Issuance happens after
  admission and before any launch; the owner checks its durable admission around
  the signature and the caller rechecks after each await. A failed or closed
  owner fails closed; there is no synchronous fallback to the vault key.
- **The durable creation and terminal records are not added in slice 4.**
  Both can be added additively (a new table through an appended migration, or a
  new journal version written only by an upgraded owner); slices 5 and 6 own
  them together with their readers. Slice 6 added the terminal record as
  terminal journal v2; slice 7 added the creation reservation.
- **The terminal owner pins its issuer per attachment.** It outlives Hosts and
  keeps PTYs across their restarts, and the core issuer key changes on
  rotation, so a key in the owner's own configuration would force a
  PTY-killing restart. The Host declares the key from its trusted composition
  in the token-authenticated attach frame; the owner builds one receiver for
  that attachment, and the receiver dies with it. A browser frame or process
  request never carries it.
- **The vault owner checks a terminal claim against core's stores, not the
  journal.** The journal belongs to the terminal owner (another process,
  possibly another container). The issuer reads the Actor epoch from the Actor
  store and the Project from the Thread binding; `resource`, `operation` and
  owner incarnation are authenticated into the capsule and the terminal owner
  checks them against its journal.
- **A threadless terminal gets no Project ENV.** The request never selects a
  Project (Decision 2), and there is no Thread binding to read.
- **A terminal admission is keyed by the process handle.** Clients use a fresh
  handle per spawn. One admission opens at most once per attachment, so a
  handle refused after its capsule opened (for example a managed-name override)
  is not reused; its reservation is released.
- **The Codex receiver lives in Codex Core, not in the native binary.** The
  split AppServer process already owns `codex app-server` and relays every
  adapter request, so it opens capsules and installs values through
  `shell_environment_policy.set` exactly as Main did. Combined and routed Cores
  have no receiver and fail delivery closed; installations keep the synchronous
  path by not configuring delivery.
- **Codex Turn ENV is admitted by the pending lease** (resolves the former
  open question 4). Codex reconfigures a Thread before it submits the input, so
  there is no native Turn yet: the v2 `turn` admission on `local-codex` carries
  `turnId: null` and is admissible only while that input's lease is pending for
  the live native incarnation. The core issuer now serves `local-codex` v2 Turns
  only in this form; v1 Codex contexts and active Codex Turns stay refused.
- **The creation reservation is a Server owner record** (`opencraft-server.sqlite`
  v24, additive). Main never writes it synchronously: the vault owner admits the
  epoch and Project, the Server Worker writes it, and both the vault owner and
  the receiver read it read-only with the current Actor epoch. It exists before
  the native creation, is admissible only while pending, and its state changes
  when native answers; the receiver's one-shot set covers the window before
  that write.
- **A configured vault owner refuses to start a split Codex Core it cannot
  serve.** "Missing delivery must fail closed" is applied at startup: with
  `environmentLaunch` (identity port or core vault owner) and a Codex Core
  endpoint, Headless builds the Codex ENV port and the Git owner before any
  Host exists and fails if either is missing, instead of letting the adapter
  take its unconfigured path. The identity port's Git owner reuses the shape of
  the core assets Worker's members rather than letting the adapter accept a
  `PersonalGitSealPort`: the adapter needs complete handoffs (scope, native
  identity, authority and grant) read from the owner's durable admission for
  both the pending reservation and the active Turn, while a seal port signs a
  scope it is given, so core would have to rebuild the lease reads the vault
  owner already does. The grant format, the shared execution owner and its
  checks stay unchanged. The read-only credential Worker of that execution
  owner still reads the installation's vault in the data directory, as in
  core vault-owner mode; Main's thread never opens it. Combined and routed
  Cores keep refusing at input time. An accounts-only Core (the container
  delivery's `proxy`) owns no runtime: the adapter reads the receiver from the
  runtime owner's health (the workspace AppServer reached through its
  `codex-control` endpoint). With `OPENCRAFT_ENVIRONMENT_DELIVERY=opaque`
  Brain starts that AppServer with the pinned receiver above, whose admission
  Worker reads the Gateway's durable admission read-only from the shared data
  directory, so human Codex creations and Turns are delivered. An identity
  composition's vault owner publishes no issuer Brain could pin; Brain then
  starts the AppServer without a receiver and human Codex creations and Turns
  are refused at input time (see `deploy/docker/README.md`, "Personal execution
  ENV for Codex"). Codex without a Core endpoint has no
  receiver and is outside this rule (open question).
- **The Codex Core issuer key is pinned by deployment configuration: the
  stable published key.** As for DSH and the Pi engine host, the AppServer's
  `--environment-launch-config` carries the key the vault owner publishes (the
  stable-key Decision above), written by its supervisor, never learnt from the
  Gateway or a request. Because the key survives vault-owner restarts, the
  AppServer is relaunched only on first enablement and on rotation; until a
  changed key is pinned, delivery fails closed. A missing or refused
  publication pins an unissuable key (see [Supervisor wiring](#supervisor-wiring)).
