# Execution ENV launch delivery

Status: slice 1 implemented. DSH in `assets` mode receives Turn ENV through
`EnvironmentLaunchReceiver` when the identity composition supplies a vault-owner
port; every other consumer still reads a decrypted snapshot from
`ExecutionEnvironmentRuntime` synchronously in its own process.

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
execution owner: check context against its own Turn observer, then receiver.open
```

- **Issuer.** The sole vault owner. Its X25519 key is pinned into execution
  owners through trusted composition (process configuration), never from a
  request or browser frame. Headless receives it from the identity composition
  as `identity.environmentLaunch = { issuer, seal(target, context) }`.
- **Receiver.** Constructed inside the process that spawns commands. `instance`
  is the authenticated capability attachment (`server:<machine>:<engine>`). The
  Gateway derives purpose and instance from that attachment; the request carries
  only the receiver public key.
- **Context.** The existing `GitExecutionHandoff` scope and native identity:
  Actor account and generations, membership revision, lease generation, input
  and execution IDs, Project ID, native Turn and incarnation. The receiver
  compares the sealed context with the Gateway reply, and the execution owner
  compares the reply with its own observer (Thread, Turn, process incarnation).
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

## Compatibility

- No `identity.environmentLaunch`: every path is unchanged.
- `identity.environmentLaunch` together with `identity.executionEnvironment` is
  rejected: one installation has one ENV owner.
- `environmentLaunch` without the Actor/lease handoff (`humanGitExecution`) is
  rejected at startup instead of failing every command.
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
2. **Pi engine host.** Enable purpose `pi` in the relay; Pi receives ENV beside
   its Git port and combines both into one snapshot (values plus Git grant).
   In-process Pi inside Main cannot host a receiver; `environmentLaunch`
   requires the independent engine host. Tests: Pi shell worker per snapshot,
   worker reuse keyed by snapshot, revocation. Evidence: engine-host smoke.
3. **Core vault-owner Worker issuer.** A reference `EnvironmentLaunchIssuerPort`
   that runs `AccountEnvironment.launchEnvironment` in a Worker owning the
   vault, so core installations can use slices 1-2 without a downstream port.
   Project ENV requires the handoff to carry the Thread's Project ID (today the
   remote Git reply requires `projectId: null`). Tests: main-thread SQL guard,
   Worker failure does not fall back, shutdown drain.
4. **Protocol change: launch context without a native Turn.** ACP session
   creation, Codex `thread/start`/`fork` and Hands terminals launch before or
   outside a Turn, which the v1 context cannot express. Add a v2 header with a
   discriminated admission (`turn` | `creation` | `terminal`), purposes `acp`
   and `terminal`, while v1 capsules keep opening. Tests: v1/v2 domain
   separation, no cross-kind confusion, compatibility.
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
  Gateway-relayed lease context is never the authority. Slice 1 still uses the
  relayed context and is corrected in the next slice that touches the receiver.
- **Project ENV is resolved by the vault owner from Thread metadata.** Handoffs do
  not carry a Project ID; a caller cannot select another project's values.
- **Codex redaction moves to the native Core**, which holds the values. Until a
  native release can redact, native diagnostics are not forwarded when delivery
  is configured.
- **A configured vault owner refuses execution owners that do not request a
  capsule** (for example an old DSH runtime), with an explicit upgrade error,
  instead of launching with an empty ENV. Missing delivery must fail closed.
- **The downstream port shape `{issuer, seal(target, context): Promise<string>}` is
  accepted for now**; slice 3 adds a core vault-owner issuer so installations no
  longer need to supply it.
