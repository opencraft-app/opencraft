# Generation upgrade transactions

The persistent upgrade agent supports an explicitly provisioned generation-only
recipe through private `generation-inspect` and `generation-apply` operations.
No Web UI or full-stack completion is implied. Other owner adapters remain
unavailable, so a full-stack plan remains blocked.

A recipe is a root-owned local JSON file selected by `generationRecipePath` in
the fixed agent configuration. It declares `schemaVersion: 1`, `kind` (`codex`
or `acp`), `targetId`, `definition`, `matrixPath` and `signaturePath`. Codex also
requires its fixed `endpoint`, `tokenFile` and `registryDirectory`; ACP uses its
private `descriptorPath` and `definition.configPath`. These paths, commands and
credentials cannot be supplied through IPC. Official upgrades preserve this
local recipe reference. `releaseRoot` may fix a signed retained package; otherwise
the current official package supplies the verified closure. The agent metadata
artifact alone does not contain executable payload. Credentials never enter the journal.
Codex executable, bundle and Node must be within the verified signed target
closure. ACP configuration bytes and actual command/script content are additionally
pinned in the signed combination and policy digest. Initial ACP support requires
an absolute command and absolute script arguments within the signed closure;
only the tested `--expose-internals` flag is accepted. External executables,
relative script arguments, standard loader-injection environment keys and
product launch rewrites are blocked.

The compatibility matrix has `schemaVersion: 1`,
`kind: opencraft.generation-compatibility`, exact `manifestSha256`, integer
`expiresAt` (Unix milliseconds), and `combinations`. Each allowlisted row has
`status: verified`, `forward: true`, `rollback: true`, `retainBindings: true` and
an exact `combination`: `ownerId`, `targetId`, `from` (live owner snapshot hash),
`to` (definition and private configuration hash), `profile`, `platform`, `arch`. It uses the existing
Ed25519 detached envelope and the deployment trust root. No SemVer range,
untested origin, unsigned matrix or inferred rollback is accepted. A fresh
owner incarnation needs a new attestation; packages cannot supply trusted keys.

The accepted plan binds the signed manifest, inventory fingerprint, fixed local
policy/configuration and matrix digests. Under the host deployment lock the
agent re-verifies live release/revocation policy and inventory before preparing
and before activation. The second comparison permits only this operation's new
candidate unit, HOME stores and registry entry; existing owner identities,
defaults, bindings, schemas and deployment pointers remain in the comparison.
Any other drift requires replanning. The original owner snapshot is checked
again after preparation; native preparation receipts enforce the final owner CAS. Preparation and activation
carry the plan expected owner/Host identity, so a replacement owner cannot mint
a new receipt on behalf of the old plan.

Every mutation has a durable intent followed by a bounded receipt. Journal
persistence failure stops mutation and compensation. After restart an uncertain
intent requires reconciliation and is never replayed. Normal activation ends in
`active-draining`: old work and history stay with their existing owner. It does
not automatically cancel tasks, migrate HOME, reclaim artifacts or declare
full-stack success.

Native activation persists the operation key, generation, owner and admission
epoch with the default update. A failed activation can retract only this operation's exact new default and
admission epoch under the same owner/Host incarnation and with this exact native operation
receipt. An intent alone does not prove who performed the CAS. A prepare/add
without a confirmed completion stays `recovery-required`; temporary absence
cannot rule out a still-running request. Compensation uses another
fresh preparation receipt and owner CAS. Later writers or restarted owners
produce `recovery-required`. A successful compensation ends in `rolled-back`,
retains any newly admitted history and records cleanup as `discarded`, `retired`,
`dormant` or `retained`. Native occupancy remains authoritative; unknown/busy
cleanup does not imply an empty generation. Repeated operation IDs return the
existing job and cannot retarget it.

Focused tests: `node --test tests/server/web-deployment-generation-upgrade.test.mjs`
and `node --import tsx --test tests/execution/full-upgrade-generation.test.ts`.
Native continuity uses `scripts/smoke/execution/smoke-codex-generations.ts` with
two explicit CLI vendor binaries, isolated accounts and a loopback synthetic
model. The fixture supports separately bundled entries through
`OPENCRAFT_DRILL_SOURCE_ROOT` and `OPENCRAFT_DRILL_CORE_ENTRY`; neither changes
the production owner or invokes a paid model.


## Router owner handoff

The router is the sole registry writer. Its private authenticated `/owner-handoff`
endpoint supports `fence`, `inspect`, `release`, `cold-ready`, `resume` and source-only
`abort`, using the owner expectation and exact proof contract. It owns neither
account storage nor native HOME. A durable fence closes routing sockets and all
ordinary control paths, including creation, Resume, generation lifecycle and Host
usage writes. Accepted RPCs and pending connection establishment remain counted
until completion; stopping a consumer does not erase accepted work. Connection
PTY/tool loss or unconfirmed mutation delivery blocks release. Every native
server request retains a durable router admission until its original consumer
reply and native resolution. Matching replies to existing requests can complete
behind the source fence; new methods remain closed. Native cancellation before
a consumer reply cannot prove an external tool had no effect and remains unknown.
Dynamic tools can confirm resolution through the native terminal `item/completed`
receipt, matched by connection, thread, turn and call identity; the router does
not require a separate server-request notification that these CLIs do not emit. Unresolved creation
claims and native callback/admission counters also block release; missing counters
or changed native identity produce unknown coverage.

Maintenance shuts down execution consumers before replacing the router. An idle
subscription still prevents release until it disconnects. Native APP processes are
independently supervised and remain alive, retaining their turns, questions,
approvals, goals and histories. The router does not answer, arm or replay them.
An older APP with unsplit callback counters may block handoff on a human wait;
that starting combination has no proof of safe handoff and must remain fenced or
abort normally, without manufacturing idle.

Release requires a current, unexpired exact zero proof and seals a full logical
registry read: schema, migration checksums, generation definitions, admission,
thread routes, creation receipts and all metadata. A successor must acquire the
existing SQLite OS writer lock, read the same current registry and configuration,
verify fixed CLI/APP/Node artifacts and surviving native identities, initialize
fresh read-only native connections, and read each durable historical binding.
It does not Resume during cold validation. Its readiness binds boot, incarnation,
bundle, configuration, Node/ABI and native identities; readiness from a crashed
candidate cannot reopen admission. Recovery stops the candidate, starts a
compatible retained router on current data, obtains new readiness and resumes;
no database snapshot is restored. A fenced source that crashes before confirmed
release stays recovery-required. The retirement monitor and bootstrap recovery
cannot mutate a fenced successor before the resume decision.

The deployment supervisor holds its deployment lock throughout this transaction,
then starts consumers and verifies a fresh initialize plus thread/list and native
resubscription. The single-initialize rule per socket remains unchanged. A failed
handshake must retire that socket before retry; raw router restart is not a fence.
The full-stack parent plan remains blocked pending other owners and compatibility
combinations. Router-specific verification extends the existing isolated real-CLI
drill with `OPENCRAFT_DRILL_ROUTER_HANDOFF=1`.

Packaged CLIs that retain a Node launcher declare `nativeLauncher` with the fixed
JavaScript entrypoint and native executable. Adoption verifies the APP's configured
CLI, launcher Node and arguments, exactly one native child, UID/GID, process start
identities and artifact digests. These artifacts join the cold configuration proof.
A missing, replaced or additional child fails closed; retirement also checks that
both the launcher and native child have exited. Direct executable generations keep
their existing identity path.

The final source zero inspection also runs the Native historical reader, and
release rechecks it. An unreadable binding yields unknown coverage while the
original writer can still abort; it cannot first be discovered after release,
when a compatible old payload may fail the same cold read. No binding is removed
or reclassified to force a successful handoff.

### Exact retained historical failures

A durable binding that was already unreadable through the source production
router may be retained without deleting, reclassifying or resuming its Thread.
The operator supplies `--native-history-failures-file`, a private version-1 JSON
manifest with `failures` entries containing `generationId`, `threadId` and exactly
two `reads`, ordered by `includeTurns: false`, then `true`. Each read records the
native JSON-RPC `code` and SHA256 of its complete error object (`errorSha256`).
Establish this evidence through the old router before authorizing it; a candidate
must never generate its own exception list.

The manifest contents participate in the router configuration seal. Source
inspection/release and successor cold-ready/resume run the same reader: every
other durable binding must read successfully, and each retained binding must
remain unloaded and reproduce both exact errors. A missing binding, additional
failure, changed error, or newly readable listed binding rejects the operation.
The result retains the complete failure list in the cold proof; it is still a
historical failure and never becomes a successful read.

For Account Core, an operator can supply `historicalUnknown` to the fence action,
containing the exact existing `{id, route}` list. Only this explicit list can be
carried unchanged across release/cold readiness. In-flight account/proxy/OAuth
work still counts and blocks zero; a new uncertainty after the list was captured
invalidates the proof. Omitted or mismatched lists cannot waive unknown delivery.
The carried list remains durable and unknown after resume, with its digest bound
to both release and cold readiness. This also applies when bridging a Core from a
direct APP endpoint to a router; endpoint changes are recorded as topology
maintenance, separately from a compatible protocol handoff.

### Explicit APP-only payload

The private generation control operation `app-payload` accepts exactly `id`, `bundle`, `bundleSha256`, `expectedIncarnation`, `expectedEpoch`, `expectedOwner` and `expectedHost`. It applies only to a non-default ready, draining or retired generation. Select before retirement: the durable choice takes precedence over automatic adoption of the default generation's payload, including after routing-owner replacement. The CLI executable/version/digest, Node, packaged launcher, HOME, CWD and execution identity stay fixed; selecting another CLI is not supported by this operation.

A ready target becomes draining. Normal P2c Host/Native retirement must finish before cold validation can copy the HOME and launch the selected APP. The original HOME stays in place; an isolated copy is mounted at its original absolute path for read-only Native validation. Receipts expose `timings.copyMs` and `timings.validationMs`, with individual copy, ownership, integrity and Native validation durations. The new APP must report callback protocol 1 and zero pending callbacks/mutations before admission.

A failed explicit candidate can be reselected only after its never-admitted owned unit is confirmed stopped. Selecting the exact original APP bundle and digest restores that source's compatibility level while preserving current HOME data and the fixed CLI. This recovery does not confer callback capability on a legacy APP: router handoff still rejects missing admission observations. No database rollback or default-payload fallback is performed.


## Managed generation retention and historical cold validation

The private generation operation `retention` requires exactly `id`, `retained`, `expectedOwner`, `expectedHost`, `expectedEpoch` and `expectedIncarnation`. The registry writer stores the selection durably. A retained generation keeps serving its pinned history after a default switch or router replacement; both automatic and explicit retirement refuse to stop it. Retention is a policy, not evidence that accepted work is zero, and does not exempt any RPC, callback, Host or Native admission check. Changing it during lifecycle work, with stale identities or while the router is fenced is rejected.

Before stopping a draining Native, the source reads its durable history under the per-generation admission barrier. An explicitly retained historical failure requires the cold reader to declare the identical policy before the source can stop. The source rechecks the same Host lease and acknowledged fence after the last asynchronous check; replacement or stale acknowledgement requires a fresh retirement attempt. The cold HOME copy uses the same reader and generation identity: both approved read modes must reproduce the exact code and full error digest, every other binding must succeed, and a repaired or loaded exception is rejected. Failed validation retains the original current HOME and stops only the validation process. No resume, replay, deletion or retention reclassification manufactures readiness.

The existing APP-only operation still excludes the active/default generation. Maintaining that APP in place would require a separate durable admission and lifecycle recovery protocol; retention does not grant such a transition or change the default by itself.

## Router responsibility evidence

The registry writer atomically couples each accepted RPC, native callback, and connection tool lease to `routing_metadata` records named `router-lease:<UUID>`. Records contain only protocol identity: method, connection, parent lease, generation/incarnation and routing/admission epoch, Thread/Turn/call identity when present, protocol-specific RPC/native request IDs and process handles. The router owner, boot, process incarnation and PID identify the observer. Request bodies, inputs, environment values, command text, tool output and exception messages are never copied. Missing identity remains missing; a threadless command does not acquire a guessed Thread.

`acceptedAt` precedes dispatch. `sentAt` records the persisted send intent before touching the relevant socket, not acknowledgement of execution or delivery. `releasedAt` only releases the local responsibility counter. Native loss, consumer loss, replacement, unconfirmed mutating RPC results and native terminal events without a matching reply persist fixed reason codes with first/last observation time and count. Native tool leases point back to their RPC lease; HTTP IDs in another owner are not these JSON-RPC IDs. Cross-owner correlation requires actual protocol evidence.

Known released records retain the latest 32 IDs under `router-lease-recent`; unknown records never enter this expiry list. Late or repeated uncertainty remains unknown even after a local release. Evidence uses the existing metadata table, with one transaction for admission state and evidence; no new SQLite migration or second writer exists. A failed write closes admission before a Native side effect. Evidence is part of the full cold registry snapshot. Older compatible writers leave these metadata records intact.

This adds diagnosis only. Existing anonymous pending IDs are not assigned invented scope or timestamps, historical unknown is not changed to success, and startup/release still reject pending or uncertain work. A legacy maintenance import requires a separately reviewed protocol and explicit approval; recording future evidence does not authorize restarting an already uncertain router.


## Explicit router maintenance with retained unknown responsibility

A legacy router that cannot release because delivery is unknown requires a separate, explicit maintenance receipt. Ordinary startup and release never infer success from an idle Native or a dead process. The read-only `--router-maintenance-inspect OUTPUT` mode validates the existing migration ledger and reads the current logical registry without taking the writer role or copying an online database. It checks every possible generation, current Native execution and child processes, APP callbacks, actual Core proxy work, and the same approved historical read policy. Independent Core account work and Native persistent goal records remain owned by those services.

`--router-maintenance-file RECEIPT` is accepted only from a private operator file. Its short-lived receipt binds the live deployment-lock controller, exact stopped source identity, allowed successor payloads, configuration, logical registry, raw source state, stopped consumers and Native proof. A fenced source retains its original unknown proof and zero real activity counters; a crashed source is explicitly classified separately. The importer rechecks the live controller and consumers, source artifacts and current data, then atomically archives the entire receipt and source handoff under a content digest before sealing a cold successor. No old pending ID or unknown flag is removed or changed to success. The compatibility recovery payload must understand this protocol and stay outside rotating application release directories.

The new epoch reports current activity separately from immutable historical responsibility. The global unknown flag and original pending IDs remain visible. Every later protocol action must supply the exact `historicalUnknownSha256`. New uncertainty remains a restart/release blocker; historical import does not unblock generation retirement. A candidate or controller crash cannot reuse an old incarnation's cold-ready proof; recovery rereads current data and repeats readiness. Each successful open records its process identity in `router-live-owner`, allowing recovery to identify a later crashed successor without pretending the original legacy process was still the source. Missing legacy provenance is a blocker, not a reason to invent identity.

Before stopping subscribed consumers in a later historical handoff, inspection must prove Native and Core proxy work quiet while those subscriptions remain connected. A busy or unavailable proof keeps coverage unknown and leaves consumers receiving; idle subscriptions alone cannot bypass that check. The source repeats inspection after consumer shutdown and before release.

A loaded Thread with `systemError` may be quiet without being reclassified as successful. The reader must obtain its complete nonempty Turn history, require every Turn to be completed, failed or interrupted and every execution item to be terminal, while APP callback/mutation counts, Native child processes and Core proxy activity are zero. Unavailable history, missing items, pending server requests or changing evidence reject maintenance. The proof records only Thread/Turn/item identities and terminal states, repeats the loaded-state check after reading durable history, and never answers, resumes, unloads or closes the Thread. The same proof must be supported by the prepared recovery payload.
