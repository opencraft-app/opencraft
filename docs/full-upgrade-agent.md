# Persistent upgrade control (P2b)

P2b supplies a Linux/systemd agent, a narrow helper and an independent handoff
watchdog. It does not implement Codex/ACP generation activation, owner admission
fences or the update page. A P2a inspection is still read-only and blocked. No
real owner adapter is registered; the internal executor is exercised with
synthetic owners. Official Web installation remains a separate existing owner.

## Processes and authority

`runtime/upgrade-agent.mjs` runs as the existing deployment user. Its private
journal is `/var/lib/opencraft-upgrade-agent/agent`. Root-only control journals
are under `/var/lib/opencraft-upgrade-control/{helper,watchdog}`. Each process
holds its own lifetime `flock` writer guard. Durable directories are separate so
an unprivileged agent cannot replace helper journals or artifact pointers.

Each role has a Unix socket at `/run/opencraft-upgrade-ROLE/control.sock`.
The agent socket is 0600; root helper/watchdog sockets are 0660 in root-owned
0750 runtime directories with the deployment user's group. The root-provisioned
config is `/etc/opencraft-upgrade/config.json` (0640). A stable root-provisioned
`trust.json` beside it is re-read on every artifact check, including after trust
rotation; a resident watchdog never caches a prior checkout's trust keys. There is no TCP listener,
new HTTP route, credential copy or UI text. Root and that configured deployment
group are the local control authority, not ordinary chat users.

The helper accepts only `status`, `request-ci` in the CI profile, and `handoff`
for agent/helper artifacts already approved by the root installer. It does not
accept unit names, shell commands, paths, environment variables or trust keys
from IPC. Product composition supplies one fixed CI wake-up command in the
protected config. A CI request acknowledgement means the existing service was
requested, never that a release or a full upgrade completed. The CI candidate,
actual Web child job and delivery receipts remain authority. Unknown delivery
is not retried automatically.

Main CI retains its original deployment lock and official update path. It
provisions the control processes from its authenticated official current package
with the same inherited, kernel-locked file descriptor; it does not reacquire the
lock. Subsequent self-handoffs wait until CI releases the lock. On a local
server the provisioner and watchdog use the configured existing local activation
lock; Web updates continue through the official local updater. The agent has no
alternate installer or remote deployment operation.

## Installation and self-handoff

The explicit root provisioner `runtime/upgrade-install.mjs --options FILE`
requires an already activated official current package, its committed manifest
identity, an independently provisioned root-owned trust file, current replay and
revocation state, and complete signed file-list verification under the acquired host lock. It does not trust
keys supplied by the downloaded package. Options name the exact Node binary,
existing deployment user, profile, official state and lock; unsafe paths fail.

Only the control entrypoints and signed metadata are durably copied to
`/opt/opencraft-upgrade/ARTIFACT_ID`. The ID covers manifest and all control
entrypoint bytes, preserving provenance even when executable bytes coincide.
Root-owned installation receipts fix the manifest and per-entry digests. These
independent artifacts are outside Web GC; old code and journals are retained.
No data restoration, destructive GC, OS/Node upgrade or owner restart is offered.

Stable systemd units reference `current-agent`, `current-helper` and
`current-watchdog` artifact pointers. The watchdog runs in its own unit and owns
agent/helper handoff journals. Before mutation it fixes old/new artifact IDs
(the exact ExecStart artifact references), operation ID, epoch and fence. It
re-verifies both artifacts against the provisioned trust/revocations, probes
old/new protocol 1 compatibility, switches a pointer durably, restarts only the
fixed role unit, and confirms its live entry digest, boot and protocol over IPC.
A lost reply is reconciled from that journal. If the candidate does not become
ready it restores the compatible old pointer and verifies it. Rollback failure
stays `recovery-required`; it never relaxes trust or restores databases.

The independently pinned protocol-1 watchdog supervises helper self-upgrade.
Replacing the watchdog itself or breaking protocol 1 is a future explicit
bootstrap migration, not a recursive self-restart. Root provisioning may leave
a desired artifact; the watchdog consumes it after the host lock is available.
A queued handoff with no durable intent can start after CI releases its lock.
An attempted handoff with uncertain results is reconciled instead. Repeated
failed handoffs do not restart candidates or rollbacks in a loop.

## Durable operations and owner interface

The journal is a bounded schema containing IDs, digests, operation/step/owner,
boot, revision, state, epoch/fence, intent, projected receipt, child job ID,
counts, health and opaque evidence IDs. No raw command, error, owner response,
secret or decrypted payload is persisted. Writes use a private exclusive
no-follow temporary file, file fsync, atomic rename and directory fsync. Any
persistence failure poisons that writer; it cannot run another mutation.

`journal.mjs` writes intent before `apply`, then receipt. On restart, an intent
without a receipt only calls authoritative `observe`. An applied observation
must identify the exact operation/epoch/fence. Unknown, not-applied, unavailable
or conflicting observations require recovery and are never automatically
resubmitted. A child success whose parent receipt was lost can be reconciled
without a duplicate child. Kernel writer locks are recovered before journals
are read. A full host reboot does not imply that native work survived.

The private internal adapter contract is [owner-contract.d.ts](../scripts/full-upgrade/owner-contract.d.ts).
P3 must implement authority CAS, complete lease/fence/drain coverage, boot and
incarnation-bound cold readiness, storage ownership and consistent backups.
All inventory database owners must be covered; cross-store backup requires one
unified write-stop fence, checked migration ledgers and isolated reads. A
per-store online backup cannot stand in for that proof. Automatic snapshot
restore is always false. Only explicitly verified signed old/new and rollback
combinations may pass the executor's validation boundary; unknown is blocked.

`active-draining` releases the host write lock. Resuming reacquires the lock and
revalidates the target, trust/revocations, inventory, resources, compatibility,
storage and owner CAS; it preserves old references and cannot force idle by
cancelling user work. There is no public path to inject validation callbacks,
synthetic adapters or an execution plan through IPC.

## Verification boundaries

Focused tests cover real kernel lock contention, process SIGKILL and fresh
journal recovery, disk-full/permission/I/O and directory-fsync failures, epoch
conflict, idempotency conflicts, unknown-result non-replay, child success with
lost parent receipt, draining lock release, helper handoff and rollback, and
reconciliation without repeated systemctl mutation. Power-loss persistence is
modeled at fsync/rename boundaries; it does not claim a physical machine power
cut. Synthetic owners do not prove P3 production fences or full upgrade safety.
