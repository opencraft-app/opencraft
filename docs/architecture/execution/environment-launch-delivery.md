# Execution ENV launch delivery

Status: slices 1, 2, 3 and 4 implemented, with the receiver taking its expected
context from the execution owner's own durable admission (Decision 1). Slice 4
adds the v2 launch context (Turn, creation and terminal admissions) to the
protocol, the issuer and the receiver only; no consumer uses it yet. DSH in
`assets` mode receives Turn ENV through `EnvironmentLaunchReceiver` when either
the identity composition supplies a vault-owner port or the installation sets
`environmentDelivery: 'vault-owner'`, which makes the core vault Worker the
issuer. Pi receives it the same way in the independent engine host when that
host's configuration pins `environmentIssuer`. Every other consumer still reads
a decrypted snapshot from `ExecutionEnvironmentRuntime` synchronously in its
own process.

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
| 5   | Codex adapter wiring     | `headless-application.mjs:1042`                                                                                                       | passes the runtime to the Codex adapter                                                                                                                    |
| 6   | Execution transport      | `headless-application.mjs:1127-1128`, `apps/headless-server/src/execution-environment-transport.ts:20-21,49,57-59,87,106-107,121-123` | `scope`, `bind`, `bindCreator`, `rememberProjects`, `seal` (vault-key scope envelope for ACP creation), and a private `DurableHostProcessService(runtime)` |
| 7   | Local process identity   | `apps/local-agent-host/src/process-identity.ts:28-41` via `process-service.ts:53`, `durable-process-service.ts:126`                   | `snapshot(scope)`, `apply`, `overlay` for PTY spawn                                                                                                        |
| 8   | DSH legacy mode          | `apps/local-agent-host/src/dsh-capability-plugin.mjs:80`, `dsh-execution-environment.mjs:7`                                           | opens a second vault runtime in the DSH process; sync `environment(nativeId)` patched into `dsh-bash-local` and `dsh-terminal-bash`                        |
| 9   | Pi engine                | `plugins/pi-engine/src/session.ts:200-203,236,269`, `shell.ts:43`                                                                     | `runtime.snapshot(runtime.execution(…))` for NodeExecutionEnv and shell workers                                                                            |
| 10  | Pi engine host           | `scripts/server-deployment/engine-host.mjs:84`                                                                                        | opens its own vault runtime in legacy mode                                                                                                                 |
| 11  | ACP engine               | `plugins/acp-engine/src/index.ts:185-186,475-476,494,889-892,954`                                                                     | `open` (scope envelope), `snapshot`, `creation`, `execution`, `rememberCreation`, local `redact`                                                           |
| 12  | ACP host                 | `scripts/server-deployment/acp-host.mjs:50`                                                                                           | opens its own vault runtime                                                                                                                                |
| 13  | Codex adapter            | `apps/opencraft-daemon/src/codex-engine-adapter.ts:761,1405,2012-2015,2544,2580-2582,3578-3580,4790,4848-4854,4943,4989`              | `scope`, `snapshot`, `execution`, `bind`, `bindCreator`, `redact`; values sent to the native Core as `shell_environment_policy.set`                        |

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
  or, with `environmentDelivery: 'vault-owner'`, from the core issuer
  (`EnvironmentLaunchOwner`) in the Headless assets Worker, which already is the
  only opener of `employee-git-vault.sqlite`. The core issuer key lives for one
  Worker lifetime; execution owners are pinned at launch, so a restarted vault
  owner requires its execution owners to be relaunched (the embedded DSH is).
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
  `turn`. `terminal`: `terminal`. Codex targets `local-codex`; DSH, Pi and ACP
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

| Kind       | Durable record                                                                                                                                                                                                                                                        | Admissible while                                                      | Project source (vault owner)                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `turn`     | Execution lease and submission plus the Actor store, as for v1 (`GitExecutionAuthority`).                                                                                                                                                                             | the lease is active for that Turn and native incarnation              | the Thread binding                                               |
| `creation` | A creation reservation keyed by Host and creation `operationId`, written by core when it accepts the authenticated creation request and before the native creation: Actor and epoch at admission, source Thread (fork), Project and the owner incarnation holding it. | the reservation is pending; it stops being admissible once it commits | the reservation (fork: the source Thread binding at admission)   |
| `terminal` | The terminal owner's reservation (Host, `resource`, `operation`), written before spawn, together with the Actor epoch it was admitted under and the owner incarnation.                                                                                                | the reservation is held and nothing has been launched for it          | the Thread binding, or the reservation for a threadless terminal |

Ports in this slice:

- Issuer: `new EnvironmentLaunchOwner(vault, turnAdmission, { creation?, terminal? })`.
  A reader returns `{ admission, project }` from the durable record, or `null`.
  A kind without a reader is refused before any value is read; the Headless
  composition passes none, so it issues only Turns.
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

In this mode nothing in Main writes Thread->Project bindings (the synchronous
`ExecutionEnvironmentTransport.bind` writer is not composed); bindings recorded
earlier keep applying and new Threads receive personal values only until the
metadata owner (slice 8) moves `bind` to an asynchronous owner port.

## Compatibility

- No `identity.environmentLaunch` and no `environmentDelivery`: every path is
  unchanged.
- `identity.environmentLaunch` together with `identity.executionEnvironment` is
  rejected: one installation has one ENV owner. The core issuer
  (`environmentDelivery: 'vault-owner'`) together with either of them is
  rejected at startup (`validateEnvironmentDelivery`), as is a core issuer
  without the assets vault Worker or without execution admission.
- `environmentLaunch` without the Actor/lease handoff (`humanGitExecution`) is
  rejected at startup instead of failing every command.
- Delivery together with Pi running inside Main (no `engineHostDescriptor`) is
  rejected at startup instead of launching Pi without ENV. An engine host given
  `environmentIssuer` outside the Assets execution context is rejected too.
- Owners that have not migrated keep the synchronous snapshot. A configured
  receiver against a Gateway without the route fails closed.
- Independently installed execution owners must be updated before their
  delivery is effective; installing a Gateway alone does not migrate them.

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
3. **Core vault-owner Worker issuer (implemented).** `EnvironmentLaunchOwner`
   runs `AccountEnvironment.launchEnvironment` in the Headless assets Worker that
   owns the vault, so core installations can use slices 1-2 without a downstream
   port. Per Decision 2 the Project is resolved from the Thread's vault binding,
   not carried by the handoff. Tests (`environment-launch-owner.test.ts`): no
   decrypted value in any Worker-to-Main message, no decrypted getter, Project
   from Thread metadata, wrong-project and forged contexts refused, one ENV
   owner at startup, close drains and retires the key, restart pins a new key.
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
6. **Hands terminal.** The terminal owner becomes the receiver; the Host's
   prepare step becomes asynchronous and forwards the capsule instead of clear
   `identity.env`. Tests: attach/list/control keep original scope, capacity,
   managed-name override refusal.
7. **Codex native Core.** Receiver inside the native Core (purpose `codex`),
   advertised through `opencraft/environment/capability`; the adapter forwards
   capsules instead of `shell_environment_policy.set` values and stops
   redacting in Main. Requires a native Core release.
8. **Metadata owner.** Move `scope`, `bind`, `bindCreator`, `rememberProjects`,
   `creation`, `execution` reads to an asynchronous owner port, then retire
   `identity.executionEnvironment` for installations with a separate vault
   owner. Evidence: `check-main-thread-sync-io` count decreases.

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
- **Codex redaction moves to the native Core**, which holds the values. Until a
  native release can redact, native diagnostics are not forwarded when delivery
  is configured.
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
  The core vault-owner issuer's key lives for one Worker lifetime, so with it
  the engine host must be relaunched with the new key after the vault owner
  restarts; until then its deliveries fail closed. Supervisor wiring that
  writes the key into the engine host configuration is not part of slice 2.
- **Pi's native file-tool environment receives no delivered values.** Only the
  shell worker launches commands with personal ENV; the native
  `NodeExecutionEnv` keeps the base environment, as it already does with the
  Git port alone.
- **The downstream port shape `{issuer, seal(target, context): Promise<string>}` is
  accepted for now**; slice 3 adds a core vault-owner issuer so installations no
  longer need to supply it. Implemented as `environmentDelivery: 'vault-owner'`.
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
- **The durable creation and terminal records are not added in this slice.**
  Both can be added additively (a new table through an appended migration, or a
  new journal version written only by an upgraded owner); slices 5 and 6 own
  them together with their readers.
