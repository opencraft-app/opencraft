# SQLite refinement of the FDB-style MetaStore

SQLite is the first storage engine for `MetaStore`; it does not define the
API. The service exposes a deliberately small, strongly consistent
transaction contract rather than the SQLite API, SQLite error codes, or the
FoundationDB wire/client API. A future FoundationDB backend must implement the
same contract.

## Required observable semantics

For one `MetaStore` deployment, completed operations have one total order that
respects real time:

- a committed mutation is atomic and receives one unique, monotonically
  increasing `commit_version`;
- a read invoked after a mutation reply observes that mutation or a newer
  state;
- a conditional mutation either commits against its expected version or has
  no domain effect;
- a stale writer epoch cannot mutate state;
- all attempts for `(namespace, writer_epoch, op_id)` return one durable result
  and apply the domain mutation at most once;
- no successful reply is sent until the SQLite commit is durable.

This is a strict-serializable typed metadata service. It is not a generic SQL
service, and sandbox guests never receive a database connection.

The public result vocabulary is backend-neutral: committed, condition failed,
stale epoch, invalid request, or unavailable/unknown. Raw `SQLITE_BUSY`,
`SQLITE_IOERR`, FoundationDB error numbers, and retry policy stay inside the
backend adapter.

## First implementation shape

The first implementation uses one service actor and one SQLite writer
connection. Every API call, including a linearizable read, crosses that actor.
This intentionally favors a small proof and attack surface over maximum
metadata read concurrency. Payload reads do not cross this path; they use the
block cache, hot-value lookup, or COS extent reader.

The database lives on a locally attached CBS block device with an ordinary
local filesystem. SQLite database/WAL files are never placed on COS, NFS, a
sandbox writable layer, or a shared filesystem whose locking and flush
semantics have not been validated.

Required connection policy:

```text
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
```

Startup verifies that `journal_mode` actually returned `wal`; inability to
enter the required mode is fatal. SQLite documents that WAL permits only one
writer, that each read transaction fixes its own WAL end mark, and that WAL is
not supported on a network filesystem. `synchronous=FULL` adds a WAL sync at
each transaction commit. See the official
[WAL documentation](https://www.sqlite.org/wal.html) and
[`synchronous` pragma](https://www.sqlite.org/pragma.html#pragma_synchronous).

`busy_timeout`, WAL checkpoint thresholds, page size, and cache size are
performance settings, not correctness mechanisms. The service remains the
only writer even though SQLite also serializes writers.

## Transaction mapping

The complete service will have the following logical keys:

```text
store_state(singleton -> commit_version)
volumes(volume_id -> writer_epoch, current_layer, ...)
op_results(namespace, writer_epoch, op_id -> commit_version, result_blob)
delta_heads(layer, shard, logical_key -> logical_version, location, ...)
delta_layers / snapshots / references / gc_outbox
```

The current executable slice deliberately implements only:

```text
store_state(singleton -> commit_version)
namespaces(namespace -> writer_epoch, updated_commit_version)
kv(namespace, key -> value, key_version)
op_results(namespace, writer_epoch, op_id -> fingerprint, kind, version, outcome)
```

All four tables are `STRICT`; the byte-keyed tables are `WITHOUT ROWID`.
`op_results` stores a domain-separated SHA-256 request fingerprint so reusing
an operation ID with different bytes fails closed. `ConditionFailed` and
`StaleEpoch` are durable outcomes: they consume a commit version and replay
without re-evaluating against later state. This behavior is represented by
`CommitRejectedAttempt` and `opOutcome` in `SqliteMetaStore.tla`.

The separate typed block repository under `../../block-engine/` implements the
larger schema above. Its SQLite `store_state.commit_version` is a serialized
stand-in for a backend commit version. A FoundationDB adapter must use native
versionstamps; it must not copy that row into FDB as a globally updated key.

One mutating request is implemented as:

```text
BEGIN IMMEDIATE
  read volume writer_epoch
  read op_results(namespace, writer_epoch, op_id)
  if result exists: return that result after ending the transaction
  validate writer_epoch and optional expected_version
  allocate store_state.commit_version + 1
  apply all typed domain mutations
  insert the durable op_result
  update store_state.commit_version
COMMIT                         <- mutation linearization point
send successful response       <- only after COMMIT succeeds
```

The operation-result key has a uniqueness constraint. The check, domain
mutation, result insertion, and commit-version update occur in the same SQLite
transaction. A process-local mutex or a preflight `SELECT` is not a substitute
for that durable constraint.

A read uses a fresh, short SQLite transaction scheduled by the same actor. A
read transaction is never retained across API calls: reusing an old WAL
snapshot could return state older than a mutation that already replied and
would violate the service's real-time guarantee.

## Timeout, disconnect, and crash

SQLite return values are not part of the protocol. The relevant boundary is
whether the atomic commit happened:

- failure or crash before SQLite commits has no durable domain effect;
- success after commit is durable and may be acknowledged;
- commit followed by a lost RPC reply leaves an unknown result for the caller;
- a caller timeout/disconnect does not imply cancellation: an already queued
  or executing request may still commit.

Every retry carries the same `(namespace, writer_epoch, op_id)`. It may race
the abandoned attempt; the single writer plus the durable operation-result
constraint ensures only one domain application. Reconciliation reads the
operation result. It never reissues the logical mutation with a new identity.

After process recovery, SQLite recovery is allowed to choose only one of two
states for the interrupted transaction: wholly committed or wholly absent.
The service acquires a newer writer epoch before accepting mutations. Replies
belonging to the dead incarnation are discarded.

## Proof and implementation boundary

`SqliteMetaStore.tla` models concurrent arrival, a single writer, abandoned
requests, late execution, durable operation results, epoch rotation, CAS,
unique commit versions, crash/recovery, and reads ordered after acknowledged
writes. `SqliteMetaStoreSafety.tla` holds the independent safety predicates.
Its finite state space collapses conditional writes onto one protected logical
head. A concrete transaction validates the version of each affected head or
row; it does not turn the global `commit_version` into an unnecessary
whole-database CAS bottleneck.

The model treats an atomic durable SQLite commit as a primitive. It does not
prove SQLite, the filesystem, CBS firmware, Rust FFI bindings, schema byte
encoding, schema creation code, or the actor implementation. It also does not yet
prove that every concrete SQL read/write set refines the typed operations in
`MetaLifecycle.tla`; that is a separate source/trace refinement obligation.
Current implementation evidence:

1. actor enqueue/start maps to `QueueAttempt` / `StartWriter`;
2. the existing-result branch maps to `ReturnExisting`;
3. applied and durable-negative transactions map to `CommitAttempt` and
   `CommitRejectedAttempt`; the successful `transaction.commit()` return is
   the concrete linearization boundary;
4. dropping the reply receiver maps to `AbandonAttempt`, while explicit
   operation lookup maps to `Reconcile`;
5. every read creates and ends a fresh actor-ordered transaction, mapping to
   `BeginRead` / `FinishRead`;
6. integration tests use a real Unix disconnect, 16 concurrent duplicates,
   an independent register-history checker, and subprocess `SIGKILL` before a
   commit, from the SQLite commit hook, and after commit before reply.

The process-stop hook exercises rollback of an open WAL transaction and the
unknown-result boundary. It does not prove arbitrary torn-sector behavior
inside SQLite or the block device.

Remaining obligations:

1. concrete `MetaLifecycle` tables and source/trace composition for roots,
   snapshots, references, and GC outbox;
2. linearizability histories that combine CAS, epoch rotation, restart, and
   multiple namespaces rather than only concurrent reads and puts;
3. WAL corruption, disk-full, short-write, and I/O-error fail-closed tests;
4. CBS filesystem, flush, firmware, and power-loss qualification.

The implemented namespace/versioned-KV slice refines the corresponding
`SqliteMetaStore.tla` transitions under SQLite's atomic-commit assumption. The
full storage service does not yet refine `MetaLifecycle.tla` end to end.
