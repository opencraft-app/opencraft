# Verification record

## Checked modules

`FdbCosBlock.tla` models one sparse logical block layer with two writers,
versioned FDB values, FLUSH, commit-unknown, crash/recovery, epoch fencing,
stored COS objects, verification, cold publication, and hot-value eviction. It
proves that a durable copy exists; it deliberately does not equate a stored COS
object with successful completion of every later GET. Safety requirements live
separately in `FdbCosBlockSafety.tla`.

The executable mapping of its first write/FLUSH/settle/snapshot/fork slice is
recorded in [`../../block-engine/README.md`](../../block-engine/README.md).
That code and its SIGKILL/COS-emulator tests are refinement evidence, not an
extension of TLC's proof boundary.

`PackLifecycle.tla` separately refines physical packing: multiple logical
versions may share an immutable COS pack, FDB publishes individual locations,
hot values are removed afterward, and fragmented packs can be replaced without
a read gap. This separation keeps the FDB protocol and physical packing state
spaces independently inspectable.

`PackIntentLifecycle.tla` refines the durable settler workflow separately from
physical packing. It fixes exact members before PUT, survives crash/recovery,
fences stale settler generations, and orders verification, publication,
eviction, and completion.

`SettlementRoundLifecycle.tla` refines online high/low-watermark maintenance
outside an individual pack. A round fixes a commit-version cutoff and byte
budget, while candidate choice below that cutoff remains nondeterministic to
represent approximate heat and locality policies. It composes concurrent
writes, snapshot pins, dead-version removal, exact pack intents, and
crash/recovery. Newer writes cannot enter an old round, live data always has a
hot or published cold copy, and a round cannot complete before its budget is
processed or its eligible old set is exhausted.

`DiscardLifecycle.tla` refines payload-free versioned zeroes independently.
It checks operation replay, fresh-version publication, writer fencing,
pre-DISCARD snapshot immutability, and fail-closed reads.

`SnapshotGcLifecycle.tla` composes named snapshot and volume roots with
physical pack reclamation through logical block versions and unique
`cold_locations`. Multiple volumes may resolve to the same version, but they do
not multiply that version's physical pack reference: `pack_records.ref_count`
is exactly the number of cold-location rows naming the pack. Root retirement
only changes logical reachability; a later version collector removes a dead
cold location and releases the physical pack reference once. The model checks
that refinement, transactional GC outbox creation, exact-key idempotent DELETE
under unknown outcomes, no reference resurrection after deletion begins, and
the exclusion of LIST from authority. Each abstract pack denotes a unique
physical key incarnation; the Rust refinement creates a suffixed key instead
of reusing any key recorded in the historical GC outbox.

`CosReadLifecycle.tla` distinguishes durable COS storage from each GET
observation. NotFound and corrupt observations permit FDB location
re-resolution or an explicit fail-closed I/O error. Only authenticated bytes
complete a successful read. It permits deletion of an old pack after
repointing even when a reader has already resolved that old pack, exercising
the read/repack/GC race directly.

`RootPackLifecycle.tla` composes incremental immutable roots with multiple
active layers, forks, simultaneous snapshots, hot values, COS pack locations,
and GC. Deleted layer and snapshot identities remain tombstones and cannot be
reused. Its external oracle derives referenced objects independently from all
active layer and snapshot roots, so a faulty GC live-set cannot redefine the
property being checked.

`FdbTxnLifecycle.tla` refines each logical operation into multiple FDB
transaction attempts. A returned commit-unknown is terminal, while a timed-out
or cancelled attempt remains eligible for a late commit and may race a retry.
The model checks same-op conflict ranges, epoch fencing, `(epoch, sequence)`
version identity, non-regressing heads, acknowledgements, retry-window closure,
epoch retirement, and operation-result GC. Its safety oracle is separate in
`FdbTxnLifecycleSafety.tla`.

`VolumeTxnLifecycle.tla` composes that attempt boundary with volume deletion.
A volume identity is `(volume_id, incarnation)`; an ID may name a fresh later
incarnation, but a retired incarnation never becomes active again. PVM first
stops new submissions, then one MetaStore transaction ordinary-reads the
volume fence and atomically changes `Active -> Retired`, advances the writer
epoch, closes the retired retry epoch, removes the live root, persists the
delete result, and creates the GC outbox record. Attempts that read the old
fence either linearize before deletion or conflict/abort afterward. The model
also covers timeout/cancel late completion, commit-unknown reconciliation,
result retention, delete-result retry, and recreation under a new incarnation.
Its important mutation oracles derive failure from commit order and persisted
state rather than a mutation-owned unsafe flag.

`DeltaMapLifecycle.tla` refines the metadata layout independently of physical
packing. Ordinary writes update one exact block key inside a volume-owned
mutable layer without replacing the volume pointer. Snapshot seals that layer
and rotates the epoch before it can be shared; fork references only sealed
layers and creates a fresh writer. Named active/retired volume and snapshot
sets model durable tombstones. A `Volumes` element denotes an immutable volume
incarnation: retirement fences later writes and forbids incarnation reuse,
while the control plane may reuse a display name only with a fresh incarnation.
Snapshot and volume deletion are explicitly non-cascading in both directions.
The logical-image oracle recursively resolves delta parents and is independent
of the implementation map.

`BatchCommitLifecycle.tla` refines the actor queue and commit boundary. It
groups only queued operations from one epoch, moves a cohort through batched
and in-flight states, and makes commit atomic before independent replies. FLUSH
waits for the submitted cut and snapshot cannot cross pending work. Detailed
per-block COW is deliberately left to `DeltaMapLifecycle.tla`; this model asks
whether grouping changes durability, fencing, or ordering.

`RetentionLifecycle.tla` is the concrete-record retention refinement. It
separates retry-window/epoch closure from physical result deletion, abstracts
all persisted delta/cold/pack/intent references to versions, and distinguishes
active from completed intent/round records. Its four mutation configurations
must expose early result deletion, referenced-version deletion, active-intent
deletion, and active-round deletion.

`../metastore/SqliteMetaStore.tla` is a separate backend refinement, not an
emulation of FoundationDB's client API. It checks that a single-writer SQLite
service exposes the same strong typed MetaStore contract: atomic unique commit
versions, real-time ordered reads, conditional writes, epoch fencing, durable
operation-ID deduplication, unknown replies, retry, and crash recovery. Its
safety oracle is separate in `SqliteMetaStoreSafety.tla`.

`../metastore/MetaLifecycle.tla` independently models immutable roots,
snapshots, forks, exact reference counts, deletion, and the transactional GC
outbox. `../metastore/CbsTxnLog.tla` is an optional refinement obligation for a
custom CBS append-only implementation of the transaction contract. It is not
the SQLite backend and is not needed when FoundationDB itself is the backend.

## Results

Pinned tool: TLA+ Tools 1.7.2.

```text
FdbCosBlockQuick.cfg
  55,631 states generated
   7,474 distinct states
  complete depth 18
  no invariant violation

FdbCosBlockCI.cfg
  222,429,704 states generated
   15,725,614 distinct states
  complete depth 28
  no invariant violation
  two independent fingerprint runs completed
  actual collision estimates 2.2e-6 and 3.7e-5, respectively

MetaLifecycleQuick.cfg
  1,137 states generated
    833 distinct states
  complete depth 7
  no invariant violation

MetaLifecycle.cfg (3 roots, 2 layers)
  28,675 states generated
  19,563 distinct states
  complete depth 9
  no invariant violation

CbsTxnLog.cfg (optional CBS transaction refinement)
  477 states generated
  184 distinct states
  complete depth 15
  no invariant violation

PackLifecycleQuick.cfg
  4,668 states generated
  1,269 distinct states
  complete depth 14
  no invariant violation

PackLifecycleCI.cfg
  17,691 states generated
   4,769 distinct states
  complete depth 14
  no invariant violation

PackIntentLifecycleCI.cfg (2 objects, 2 intents, 2 generations)
  1,584 states generated
    964 distinct states
  complete depth 18
  no invariant violation

SettlementRoundLifecycleCI.cfg (2 blocks, 3 versions, 2 generations)
  548,428 states generated
  185,460 distinct states
  complete depth 31
  no invariant violation

DiscardLifecycleCI.cfg (3 operations, 3 versions, 3 generations)
  49,859 states generated
  11,352 distinct states
  complete depth 13
  no invariant violation

SnapshotGcLifecycleQuick.cfg (2 packs, 2 versions, 1 snapshot, 2 volumes)
  1,332 states generated
    445 distinct states
  complete depth 12
  no invariant violation

SnapshotGcLifecycleCI.cfg (3 packs, 3 versions, 2 snapshots, 2 volumes)
  1,067,813 states generated
    217,108 distinct states
  complete depth 19
  no invariant violation

CosReadLifecycleQuick.cfg
  353 states generated
  124 distinct states
  complete depth 16
  no invariant violation

CosReadLifecycleCI.cfg
  8,575 states generated
  2,388 distinct states
  complete depth 18
  no invariant violation

RootPackLifecycleQuick.cfg
  170,590 states generated
   39,714 distinct states
  complete depth 17
  no invariant violation

RootPackLifecycleCI.cfg (3 roots, 2 layers, 2 snapshots)
  2,220,803 states generated
    447,938 distinct states
  complete depth 20
  no invariant violation
  actual-fingerprint collision estimate 2.4e-9

FdbTxnLifecycleQuick.cfg
  1,400 states generated
    703 distinct states
  complete depth 12
  no invariant violation

FdbTxnLifecycleCI.cfg (2 operations, 3 attempts, 2 epochs)
  410,493 states generated
  141,805 distinct states
  complete depth 19
  no invariant violation
  actual-fingerprint collision estimate 1.9e-9

VolumeTxnLifecycleQuick.cfg
  4,258 states generated
  1,569 distinct states
  complete depth 15
  no invariant violation

VolumeTxnLifecycleCI.cfg (2 incarnations, 2 operations, 3 attempts)
  1,283,483 states generated
    346,144 distinct states
  complete depth 22
  no invariant violation
  actual-fingerprint collision estimate 1.9e-8

DeltaMapLifecycleQuick.cfg
  2,215 states generated
  680 distinct states
  complete depth 9
  no invariant violation

DeltaMapLifecycleCI.cfg (2 volumes, 3 layers, 2 snapshots, 2 blocks)
  25,321,331 states generated
   3,650,656 distinct states
  complete depth 14
  no invariant violation
  two independent fingerprint runs completed
  actual-fingerprint collision estimates 9.5e-6 and 1.3e-6, respectively

BatchCommitLifecycleCI.cfg (3 operations, 2 blocks, 2 epochs)
  94,879 states generated
  36,356 distinct states
  complete depth 18
  no invariant violation

RetentionLifecycleCI.cfg (2 operations, 2 versions, 2 intents, 2 rounds)
  3,313 states generated
    864 distinct states
  complete depth 15
  no invariant violation

SqliteMetaStoreQuick.cfg
  9,695 states generated
  3,150 distinct states
  complete depth 14
  no invariant violation

SqliteMetaStoreCI.cfg (2 operations, 3 attempts, CAS, 2 epochs)
  5,182,559 states generated
  1,200,627 distinct states
  complete depth 20
  no invariant violation
  includes durable ConditionFailed/StaleEpoch operation results
  actual collision estimate 9.7e-8 for the recorded run
```

The data-plane mutation suite requires each deliberately broken algorithm to
produce the named counterexample:

| Mutation | Required violated invariant |
|---|---|
| acknowledge FLUSH early | `AcknowledgedFlushRecoverable` |
| accept stale-epoch commit | `StaleEpochsAreFenced` |
| publish unverified COS object | `NoUnverifiedCosPublication` |
| evict FDB data before a safe replacement | `NoUnsafeHotEviction` |
| evict an overwritten block still pinned by a snapshot | `NoUnsafeHotEviction` |
| blindly retry commit-unknown | `UnknownCommitsAreIdempotent` |
| publish an unverified shared pack | `NoUnverifiedPublication` |
| delete a pack with a published member | `NoReferencedPackDeletion` |
| evict hot data before pack publication | `NoUnsafeHotEviction` |
| rewrite immutable pack membership | `PackMembershipImmutable` |
| remove an old location before repack publication | `RepackIsGapFree` |
| reselect intent members after crash | `IntentMembershipImmutable` |
| publish an intent before verification | `NoUnverifiedPublication` |
| evict intent data before publication | `NoUnsafeHotEviction` |
| let a stale settler generation publish | `StaleGenerationsFenced` |
| complete an intent before eviction | `NoEarlyCompletion` |
| advance a captured round cutoff after crash | `RoundCutoffStable` |
| admit a post-cutoff write to an old round | `PostCutoffWritesExcluded` |
| evict a round member before cold publication | `NoUnsafeHotEviction` |
| complete a round before budget/exhaustion | `NoEarlyRoundCompletion` |
| discard without allocating a durable version | `DiscardCreatesVersion` |
| mutate a pinned root while discarding | `SnapshotRootsImmutable` |
| return zero after a failed physical read | `ZeroReadsAuthorized` |
| let an old writer generation discard | `StaleGenerationsFenced` |
| begin pack GC without a transactional outbox record | `TransactionalGcOutbox` |
| execute DELETE against a different key | `ExactKeyDeletionOnly` |
| complete an unknown DELETE while the object remains | `DeleteCompletionReflectsTruth` |
| add a new reference after deletion begins | `NoReferenceResurrection` |
| authorize deletion from COS LIST/inventory | `ListNeverAuthorizesDeletion` |
| count another logical root as another physical pack reference | `ColdLocationReferenceCountsExact` |
| release a pack reference directly when retrying volume deletion | `ColdLocationReferenceCountsExact` |
| return bytes after a corrupt COS observation | `ReturnedBytesAuthentic` |
| return a zero block after a NotFound observation | `ReturnedBytesAuthentic` |
| omit a fork's root from the GC live set | `AllReferencedRootDataRecoverable` |
| reuse a deleted layer identity | `RetiredLayerIdsNeverReused` |
| reuse a deleted snapshot identity | `RetiredSnapshotIdsNeverReused` |
| omit the `op_id` read conflict | `OperationsApplyAtMostOnce` |
| omit the epoch read conflict | `StaleEpochsAreFenced` |
| blindly overwrite head with an older version | `HeadCoversCommittedVersions` |
| collect an operation result before retry/epoch retirement | `ResultsRetainedUntilSafe` |
| acknowledge before the FDB commit is durable | `AcknowledgementsAreDurable` |
| identify versions by sequence without epoch | `VersionIdentityUnique` |
| let commit-unknown apply after the error returned | `CommitUnknownIsTerminal` |
| omit the ordinary-read volume fence and commit after deletion | `LateCommitsAreFenced` |
| omit the operation-result conflict inside a volume transaction | `OperationsApplyAtMostOnce` |
| retire a volume without advancing its epoch | `DeleteFenceAndRootReleaseAreAtomic` |
| retire a volume without atomically creating its GC outbox | `DeleteFenceAndRootReleaseAreAtomic` |
| acknowledge volume deletion before its transaction commits | `DeleteAcknowledgementsAreDurable` |
| release a retired volume root twice on delete retry | `DeleteFenceAndRootReleaseAreAtomic` |
| close the current retry epoch before installing a fence | `RetryClosureRequiresFence` |
| reactivate an already retired `(volume_id, incarnation)` | `RetiredIncarnationsNeverReactivate` |
| collect an operation result before retry closure or delete fence | `ResultGcRequiresClosedWindow` |
| allocate/repoint a layer on every steady write | `SteadyWritesKeepLayerPointer` |
| expose a mutable layer through snapshot | `SnapshotsImmutable` |
| mutate an already sealed layer | `SnapshotsImmutable` |
| let a stale writer mutate a delta | `StaleEpochsFenced` |
| update a delta key other than the addressed block | `WritesChangeOnlyAddressedDelta` |
| accept an I/O write after volume retirement | `RetiredVolumesAreFenced` |
| fork from a deleted snapshot tombstone | `DeletedSnapshotsCannotFork` |
| reuse a retired volume incarnation | `DeletedVolumeIncarnationsNeverReused` |
| cascade snapshot deletion into existing fork volumes | `SnapshotDeletionPreservesForks` |
| cascade source-volume deletion into its snapshots | `VolumeDeletionPreservesSnapshots` |
| partially commit a selected batch cohort | `BatchResultsAreAtomic` |
| acknowledge a batched operation before COMMIT | `AcknowledgementsAreDurable` |
| apply a selected batch from an old epoch | `StaleEpochsAreFenced` |
| collect a result while its retry window is open | `OpenRetriesKeepResults` |
| collect a version still referenced by any durable owner | `ReferencedVersionsRetained` |
| collect an active pack intent | `ActiveIntentsRetained` |
| collect an active settlement round | `ActiveRoundsRetained` |

The lifecycle and optional CBS-log models have their own mutations for missing
fork pins, deleting referenced roots, missing GC outbox, publishing after
delete, double release, ACK before sync, commit before data, torn recovery, and
duplicate retries. The SQLite refinement adds six required counterexamples:

| SQLite wrapper defect | Required violated invariant |
|---|---|
| reply before SQLite `COMMIT` | `AcknowledgementsAreDurable` |
| omit durable `op_id` deduplication | `OperationsApplyAtMostOnce` |
| omit writer-epoch validation | `StaleEpochsAreFenced` |
| ignore a conditional write's expected version | `ConditionalWritesAreAtomic` |
| reuse a commit version | `CommitVersionsLinear` |
| reuse a stale read transaction after an acknowledged write | `ReadsRespectRealTime` |

## What TLC found while developing the model

The first snapshot-GC refinement represented forks as `forkRefs \subseteq
Packs`. Replacing that set with named roots fixed multiplicity, but initially
introduced the opposite refinement error: it counted every logical root as a
physical pack reference. The SQL schema does not do that. Its triggers count
unique `cold_locations`, so many volumes resolving to the same block version
still contribute one pack reference. The current model explicitly walks
`active roots -> deduplicated versions -> cold locations -> packs`; root
deletion and physical location collection are separate actions. Mutations that
increment on fork or decrement directly on volume deletion now violate the
independently derived cold-location count.

Adding retirement to the primary delta model also made the ownership boundary
explicit. Snapshot IDs and volume incarnations become durable tombstones, normal writes
require an active volume, and neither deletion cascades through the historical
source relationship. Five lifecycle mutations demonstrate that merely proving
immutable snapshots and correct reads was insufficient to prove sandbox
destruction semantics.

The first safety oracle required every acknowledged historical block object to
remain present forever. TLC produced a valid overwrite/reclamation trace that
violated it. The corrected requirement is semantic: the current durable head
must be at least as new as the acknowledged version. This permits reclaiming an
old version without weakening recovery.

We also removed a hidden proof shortcut: hot eviction had consulted
`ackedFlush`, a ghost history variable unavailable to a real implementation.
The algorithm now decides eviction only from persisted/live state, while the
separate invariant checks the historical acknowledgement obligation.

The COS read refinement removed another shortcut: one successful PUT/HEAD is
not modeled as permanent future visibility. A validated successful PUT can
establish storage identity without an extra HEAD round trip, while TLC still
explores later NotFound and corrupt observations through other access nodes,
including deletion of a repacked old location between resolve and fetch.

The root/pack composition uses two live sets on purpose. The implementation
live set drives reclamation, while the oracle independently walks every active
layer and snapshot root. The `IgnoreForkRoot` mutation demonstrates why
separating files alone is insufficient: omitting a child root immediately
produces a referenced-version data-loss counterexample.

The FDB transaction refinement found the important asymmetry in error
handling. A retry may safely race a timed-out attempt only because both attempts
ordinary-read the same durable `op_id` key. Conversely, once
`commit_unknown_result` has returned, allowing that same attempt to apply later
is itself a contract violation even if no duplicate has occurred yet. Result
retention also needs both protocol conditions: retry closure and epoch
retirement.

Composing deletion exposed a second boundary that the standalone transaction
and delta models could not express. A write may ordinary-read an active volume,
time out, and remain eligible to commit while deletion starts. In the composed
model the delete transaction writes that same volume metadata key. Therefore
the write either commits at a lower commit order or its read conflict aborts it;
there is no legal commit after the retired fence. The
`MissingVolumeConflict` mutation deliberately gives the write a snapshot/blind
read and TLC produces the late-commit trace. The model separately records the
execution fence and response-replay watermark, so result GC cannot stand in
for transaction fencing.

The SQLite refinement deliberately serializes requests through one actor. This
does not make the real-time read property automatic: the `StaleRead` mutation
models reusing an older WAL read transaction and produces a counterexample
after an acknowledged commit. Likewise, SQLite's own single-writer rule does
not provide operation idempotency; the `MissingDedupe` mutation commits one
logical operation twice unless the result key is checked and inserted in the
same database transaction as the domain mutation.

Mapping the first Rust implementation back to the model exposed and corrected
one omitted concrete behavior: condition and stale-epoch failures are durable,
idempotently replayable operation results. `CommitRejectedAttempt` now commits
their result and version while leaving `applyCount` unchanged. This is an
example of why model checking alone is insufficient without source mapping.

The delta model was added before changing the concrete schema. Its mutation
suite rejects the old one-layer/root-per-write shape as a performance-contract
violation even though that older shape was functionally correct. The SQLite
refinement then added an executable structural check: three writes spanning
two 4 MiB shard prefixes allocate one mutable layer and two exact head keys;
snapshot seals it, and only the first divergent write allocates a child layer.
SQLite's global commit counter is explicitly a serialized versionstamp model.
It is not permission for a FoundationDB adapter to create a global hot key.

The independent `cos-emulator` crate now provides implementation-level fault
evidence for the COS observation boundary: immutable truth and per-access-path
visibility are separate persisted state; one-shot faults survive restart;
PUT/DELETE distinguish timeout before versus after durable application; and
real loopback HTTP tests cover HEAD, single-range GET, NotFound, corrupt bytes,
stale reads, and append-only history replay. A write-ahead pending event makes
state/script consumption and JSONL history recoverable across either side of
the append boundary. A deterministic cross-product test covers live/deleted
truth × visible/hidden/stale paths × normal/NotFound/stale/corrupt/timeout
observations. Its history oracle is deliberately
separate from the request executor, but both remain finite software artifacts,
not evidence about Tencent COS internals.

The Block Engine fault harness additionally SIGKILLs a real subprocess before
exact-key GC DELETE, after durable object removal but before metadata
completion, and after completion. Reopen must replay the same outbox task,
accept exact NotFound idempotently, or observe an already completed task while
the independently live replacement remains readable.

The retention refinement prevented a tempting age-based implementation. The
concrete SQLite code instead persists writer-epoch and settler-generation
retry-closure watermarks, rejects closed old requests, and deletes only records
below those watermarks. Its independent live-set query covers semantic
current/snapshot heads, while SQL foreign-key ownership covers cold locations,
pack members, and intent members. A real subprocess is SIGKILLed before, from,
and after the compaction COMMIT; recovery observes either the complete old or
complete compacted metadata state and preserves live bytes.

## Claim boundary

These are exhaustive checks of finite configurations, not unbounded theorems.
They prove the modeled state machine, not a future Rust implementation. The
following refinements still require their own model or implementation-level
linearizability/fault tests:

- concrete FDB transaction-size/conflict limits and batching across asynchronous
  FDB attempts (the aligned multi-block and SQLite cohort atomicity are now
  checked separately);
- concrete FDB tuple encoding, versionstamp placement, shard-prefix choice,
  conflict ranges, layer-chain compaction, and transaction sizing (exact-key
  delta semantics and mutable/sealed lifecycle are checked);
- packed extent byte offsets, range reads, and checksum framing (pack
  publication and repacking order are checked abstractly);
- incremental/production-cost accounting for released historical versions
  (the SQLite reference now reclaims them with a bounded root count but still
  performs a recursive semantic live-set pass);
- PVM-frontend multi-queue submission and FLUSH-cut ordering (concurrent
  repository-call histories are checked independently with Stateright and
  Porcupine, but they start below the future multi-queue submission point);
- quotas, encryption, and key rotation;
- Tencent COS SDK/wire conformance and real-provider canaries for the assumed
  PUT durability, visibility, checksum, Range GET, and DELETE behaviors;
- source-level validation that the chosen FDB binding maps concrete error
  codes, cancellation, conflict ranges, and retry loops to the modeled actions;
- broader SQLite fault validation for corrupt WAL, disk-full, short-write, and
  I/O errors (actor/schema mapping and process-kill boundary tests now exist);
- composition evidence that every concrete SQLite query and mutation refines
  the corresponding typed operation and invariant in `MetaLifecycle.tla`;
- guest-memory checkpoint ordering relative to the block frontend.

The checked properties are safety properties. They do not prove that COS
eventually becomes visible, that a retrying read terminates, that settling
finishes, or that GC eventually reclaims every orphan under permanent
failures. Those require explicit fairness and availability assumptions.

COS hashes are ideal collision-free identities in the model. A concrete engine
must use domain-separated SHA-256, verify canonical length/content, and fail
closed on any mismatch.
