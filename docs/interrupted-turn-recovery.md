# Interrupted execution recovery

The execution Host continues a previously accepted, unfinished turn after its
execution process restarts. Recovery does not require an open browser. A
transport disconnect alone is not execution-loss evidence: the Host first reads
the native execution state and the latest turn. Live or completed work is never
started again. Historical failed turns that the Host did not track are not
retroactively retried.

`@opencraft/host-recovery` owns the common policy and one managed
`interrupted-turn-recovery.sqlite` per engine owner. Its v1 migration and schema
checksum follow the normal SQLite lifecycle. The engine's existing writer lease
protects this store; it stores identities and recovery state, not prompts or
credentials. The storage outcome is included in Host diagnostics.

## Native ports

| Engine | Evidence and continuation |
| --- | --- |
| Codex | Host overlays retain accepted turn IDs. After native initialization, an idle native thread whose last turn is the tracked interrupted/unfinished turn can receive an empty `turn/start`. Active Goal recovery keeps its existing owner and semantics. An independent core connection is restored by the Host even without a browser. |
| DSH | Host execution admission and native history establish the accepted turn. After engine recovery, the normal per-thread serialization, runtime preparation and admission run with the Host's system recovery principal. The continuation prompt asks the model to check existing results before repeating a command. |
| Pi | The existing durable session resumes its unfinished native task with `native.resume()`. The recovery policy wraps this operation; opening history or reconnecting a View does not bypass the recovery limit. |

Recovery keeps the original root turn ID and increments its attempt count
**before** native submission. It permits at most three automatic attempts across
process restarts. Another interruption after the third attempt stops automatic
continuation; Pi also aborts its suspended native task. A new human message
starts a new chain. Ordinary model failures and capacity retries keep their
existing semantics; this policy is for lost execution.

Each attempt durably separates preparation from native dispatch. Preparation
failures, including a restart during preparation, remain retryable within that
same limit. The port changes the attempt to dispatching only at the final send
boundary, after all asynchronous preparation and a fresh user-intent check.
A definite native rejection is retryable; loss of a dispatch acknowledgement
stays unconfirmed. A failed Core initialize discards its physical connection;
the Host remains unavailable until a new connection finishes initialization.
DSH records execution control facts before text presentation pacing, so an
accepted new turn cannot disappear from recovery behind the preceding reply.

If a continuation's acceptance cannot be confirmed, the Host exposes an
unconfirmed notice and does not blindly resend an unknown mutation. Native
completion or a newer native turn found during recovery takes precedence.

New messages, steering, queue submission, explicit stop, archive/delete and
Goal changes revoke pending recovery. Preparation rechecks that revocation
before admission; an in-flight native command may already have been accepted.
Commands interrupted by a crash can run again, so the continuation checks
retained results. This is continuation of a task, not exactly-once shell
execution.

## Provenance and presentation

Automatic attempts originate from the system, with a new Host-owned recovery
input ID. They do not impersonate an employee or inherit the original person's
cost grant. Codex records its accepted automatic input through the existing
usage ledger with `sourceKind: system`, `actorId: null`, `actorKind: session`.
DSH uses its system execution principal; Pi's durable resume has a separate
Host receipt and a non-model `opencraft.systemRecovery` entry in its native
ledger. These receipts do not expand the token dashboard's
declared engine coverage or attribute unobserved usage to a person.

The `opencraft/turn-recovery` v1 capability exposes
`opencraft/turn-recovery/read` and the corresponding `updated` notification.
The read-only notice contains the original/current turn IDs, attempt count,
limit, system source and continued/exhausted/unconfirmed state. The Composer's
existing attached rail displays one short notice. Reconnection rehydrates this
server projection; user input clears it. This adds no second execution owner.
