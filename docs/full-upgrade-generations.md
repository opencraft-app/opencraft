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
