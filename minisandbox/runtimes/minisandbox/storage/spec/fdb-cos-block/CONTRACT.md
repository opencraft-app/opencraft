# FDB-style MetaStore + Tencent COS writable block-layer contract

This is the algorithm boundary for a sparse writable layer whose logical size
is initially 2 GiB. A strongly consistent MetaStore is the authoritative
synchronous hot tier; Tencent Cloud Object Storage (COS) is an asynchronous
immutable cold tier. Neither COS nor a local NVMe cache participates in write
acknowledgement.

"FDB-style" describes the required transaction semantics, not an Apple
FoundationDB deployment dependency. The first MetaStore backend may be SQLite
on CBS as specified by `../metastore/SQLITE-REFINEMENT.md`. FoundationDB can be
added later behind the same typed contract.

```text
guest virtio-blk / PVM block ABI
              |
       Block Engine (trusted)
        /                 \
MetaStore: hot 4 KiB versions   COS: immutable packed extents
delta heads, epochs, op results content-addressed cold payload
sealed layers, refs, GC outbox
```

The 2 GiB size is an address-space limit, not a 2 GiB database allocation.
Only written blocks, exact delta keys, and lifecycle metadata consume space.

## Acknowledgement and ordering

Each externally retryable write has
`(volume_id, incarnation, writer_epoch, op_id)` and one or more logical block
versions `(writer_epoch, commit_version)`. `volume_id` is a user/control-plane
name; `incarnation` is an immutable allocation identity and is present in every
fence, operation-result, root, and capability key. The frontend
accepts 4 KiB-aligned requests from 4 KiB through 512 KiB. A single request is
atomic: either every addressed 4 KiB block and its exact delta head commits, or
none does. In FoundationDB,
`commit_version` is supplied by its native versionstamp facility; a normal
write must not read or update a global sequence key. The serialized SQLite
reference engine uses its service-wide `commit_version` counter to refine that
ordering, not as the intended FDB key layout. One MetaStore transaction reads
the current epoch, `op_id` result, and current layer identity, then atomically
writes:

- every new 4 KiB versioned block value in the request;
- one exact `(layer_id, shard_no, block_no)` delta head per block;
- the durable result for `op_id`.

`shard_no = block_no / 1024`, so one prefix covers 4 MiB at the fixed 4 KiB
block size. The shard is not a serialized `DirtyMap` value: updating block A
does not read or rewrite other heads in that shard. In an FDB layout the block
number remains part of the key, allowing normal key-range distribution and
conflict tracking to provide the partitioning.

The serialized SQLite backend may combine already queued operations for one
volume and epoch into one transaction. It does not wait for a timer: the batch
contains only work immediately available when the actor drains its queue, and
is bounded to 128 operations and 512 KiB. A different volume/epoch or any
FLUSH, snapshot, writer rotation, or non-write command terminates the batch.
All operation results in a selected cohort commit with the domain mutations;
one invalid/mismatched request aborts that cohort without partial publication.
This is a batching failure domain, not a disk-COW failure domain: storage
versions, heads, reads, snapshot layers, settling, and GC remain 4 KiB based.
`BatchCommitLifecycle.tla` checks this queue/batch/in-flight boundary
independently of the detailed COW layout in `DeltaMapLifecycle.tla`.

The logical result classes are deliberately not collapsed:

- known committed may be acknowledged immediately;
- known not committed may retry the same `op_id`;
- a terminal unknown means the attempt either committed or will never commit;
  read the `op_id` result, then retry the same key only if absent;
- timeout, cancellation, or abandoning a request during process failure does
  **not** carry that terminal guarantee. The old attempt may commit later and
  race a retry. Both attempts use the same durable `op_id`; the backend must
  make the check and domain mutation one serializable transaction so at most
  one can commit.

Blindly issuing the logical mutation under a new operation identity is
forbidden. A FoundationDB backend maps terminal unknown to its documented
[`commit_unknown_result`, distinct from timeout/cancellation][fdb-unknown].
The SQLite backend uses a single writer and a durable unique operation-result
key. It does not emulate or expose FDB error codes.

The durable operation result remains until all attempts are terminal, the
client closes its retry window, and the writer epoch is retired. Removing the
result earlier can let a late retry apply the mutation again. Head publication
uses the maximum lexicographic `(epoch, commit_version)` and cannot regress if an
older attempt commits after a newer operation.

The concrete control plane records retry closure as a monotonic per-volume
epoch watermark, and records an equivalent retired settler-generation
watermark. It may advance a writer watermark only below the current fenced
epoch and only after the old producer has stopped retrying. Requests at or
below a closed watermark fail with `RetryWindowClosed`, including a request
whose prior result has not yet been physically compacted. Retention is bounded
and transactional; elapsed wall time is never evidence that a retry is dead.

Execution fencing and response-result retention are separate windows. Closing
or collecting an operation result never proves that a transaction can no
longer commit. That proof comes from the ordinary read of the volume metadata
key: a transaction attempting WRITE, DISCARD, FLUSH publication, or snapshot
must read and validate `Active`, `incarnation`, and `writer_epoch` without
snapshot-read semantics. A concurrent delete writes that same key, so FDB
orders the mutation before deletion or rejects it with a conflict afterward.

A FLUSH captures the submitted image at its ordering point and waits until a
durable MetaStore head of at least that version covers every captured block. A
newer durable version is valid coverage; an overwritten historical value need
not be retained forever. FUA is a write followed by the same barrier before
reply. If the frontend later has multiple queues, one FLUSH covers writes
submitted on all queues before the barrier.

DISCARD is represented as another versioned value whose logical content is
zero. Compaction can omit its payload, but it follows the same fencing,
ordering, snapshot, and retry rules as a write.
`DiscardLifecycle.tla` checks that refinement independently: a DISCARD creates
a fresh durable version, cannot mutate a pinned pre-DISCARD snapshot, cannot
commit from a stale writer generation, and cannot turn an I/O failure into an
apparently successful zero read.

An aligned range DISCARD is one externally retryable operation over 4 KiB--512
KiB. It atomically publishes one payload-free version per addressed 4 KiB
block and one durable range result. Larger frontend requests may be split at
512 KiB boundaries and have the same legal committed-prefix behavior as a
split large WRITE. Unaligned NBD edge sectors are zeroed through ordinary RMW
writes because the MetaStore COW granularity remains 4 KiB.

## Writer fencing and crash

Only the holder of the volume's current monotonically increasing epoch may
publish a new head. Every mutating MetaStore transaction validates that epoch
inside its atomic commit. Recovery acquires a fresh epoch before serving I/O.

Crashing a client does not cancel a MetaStore request already in flight. That
transaction may still commit while the client is down; until its outcome is
reconciled or a new epoch fences it, it is modeled like timeout/cancellation,
not like a terminal unknown. A reply from the dead client is never treated as
an acknowledgement. Delayed work from an older epoch may leave an unreferenced
COS object, but cannot mutate the current MetaStore head.

## Tencent COS contract

The design deliberately assumes only a weak COS interface:

- PUT can succeed, fail before storing, or store the object while its reply is
  lost;
- a validated successful PUT establishes an immutable committed object, while
  different COS access nodes may still transiently disagree about visibility;
- exact HEAD/GET can transiently report not found or return data that fails
  verification;
- LIST and inventory can be delayed and are never correctness inputs;
- DELETE is idempotent and may be delayed or retried.

Every payload key is immutable and content-addressed, for example
`extent/sha256/<digest>`. A digest is never deliberately overwritten with
different bytes. Upload sends `Content-MD5` and records COS CRC64 when present,
but the storage identity remains the engine's SHA-256 over the canonical object
bytes. Before MetaStore publishes a cold location, an exact-key HEAD/GET must
verify the expected length and digest when the PUT result was unknown or its
response could not authenticate the upload. A known-success PUT with validated
request `Content-MD5`, returned CRC64 when available, canonical local length,
and SHA-256 may establish storage identity directly. Until identity is
established, the MetaStore hot copy remains readable.
Tencent documents PUT/overwrite and version-ID behavior in
[PUT Object](https://cloud.tencent.com/document/product/436/7749), and the
transport checksum fields in
[CRC64 verification](https://cloud.tencent.com/document/product/436/62133).

This is intentionally more conservative than relying on any advertised COS
read-after-write behavior. A successful PUT or later reconciliation proves
storage identity, not monotonic visibility of every later GET through another
COS access node. COS availability affects settling and cold reads, not
acknowledged-write durability while the MetaStore hot copy exists.

Cold reads first resolve the current MetaStore location, fetch and authenticate
the requested frame, and return bytes only after the engine digest matches. A
NotFound, timeout, malformed range, or checksum mismatch never becomes a zero
block or user data. The reader re-resolves the MetaStore location because
repacking may have moved the frame after the first resolution; if the location
is unchanged it retries with bounded backoff or eventually returns an explicit
I/O error. This separates durable COS storage from one request's eventually
consistent observation.

In the models, `cosObjects`/`cosStored` represent that committed provider
truth, not the cache state of any COS access node. Every read observation is
still nondeterministic after commit. If a successful PUT did not carry the
provider obligation that the object eventually remains retrievable, no client
protocol could safely settle the last MetaStore hot copy; that obligation is an
explicit storage-provider assumption, not something a follow-up HEAD can
manufacture.

## Settling and packing

Crossing a hot-tier watermark first creates a durable settlement round. The
round stores a fixed MetaStore commit-version cutoff and a fixed byte budget
derived from `hot_bytes - low_watermark`. Pack size is only an execution bound;
it neither defines liveness nor advances the cutoff. Writes serialized after
round creation have a larger commit version and are left for a later round.

Candidate order is deliberately approximate. A worker may use write age,
shard/LBA locality, CLOCK bits, or another bounded heuristic to choose any hot
version at or below the cutoff. Read heat need not be persisted. Recovery may
choose different eligible old versions, but it resumes the same cutoff and
remaining byte budget. Only a prepared pack's exact immutable members are
fixed across crash. This distinction avoids both an exact-LRU write hotspot and
a materialized whole-volume candidate table.

At round start and completion, the reference implementation reconciles the
semantic live set once. Each intermediate pack is then selected by a bounded
ordered range below the cutoff; it does not repeat the recursive live-set scan.
An object that becomes dead during the round may temporarily be an orphan and
is reclaimed by the completion reconciliation and exact-key GC outbox.

Background workers combine selected blocks into immutable bounded extent
objects. Publication is ordered as follows:

1. build the canonical extent and its digest;
2. PUT it to an immutable COS key;
3. verify content identity from the successful PUT response, or reconcile an
   unknown result using exact-key HEAD/GET;
4. in one fenced MetaStore transaction, publish block-to-extent locations only
   for versions that are still live;
5. delete hot payload values only after the cold locations are durable.

The concrete settler persists an immutable pack intent before step 2. The
intent records the exact member versions, offsets, digests, object key, and
settler generation. Recovery claims that same intent under a fresh generation;
it never reselects members based on a COS LIST result. Its checked crash and
generation refinement is `PackIntentLifecycle.tla`.
`SettlementRoundLifecycle.tla` separately checks the outer cutoff/budget
protocol, concurrent writes and snapshot pins, crash/recovery, approximate
candidate reselection, and composition with one exact pack intent.

If a block has already been overwritten, its old MetaStore value can be dropped
even without cold publication once no active FLUSH or sealed layer references
it. The implementation cannot consult specification-history variables to
decide this; all liveness evidence must be persisted layers, heads, and active
barrier state.

The SQLite refinement compactor independently checks every concrete reference:
semantic current/snapshot delta heads, cold locations, physical pack members,
and durable pack-intent members. Completed pack intents and rounds are removed
only after their settler generation's retry window closes. Completed COS
deletion rows and deleted-snapshot rows remain tombstones because key/ID reuse
and completion replay are separate safety obligations. COS LIST is not used by
retention or GC.

"100% settled" means every live payload byte has a verified COS location and
the corresponding MetaStore hot value has been removed. MetaStore still retains
metadata, delta heads/layers, operation results within their retention
window, epochs, references, and the GC outbox. With permanent COS failure there
is no bounded time guarantee for reaching a fully settled state.

## Snapshot and fork composition

Snapshot/fork use the lifecycle protocol in `../metastore/MetaLifecycle.tla`,
refined by `DeltaMapLifecycle.tla`. A sealed layer chain addresses exact
logical block versions. A physical version may currently live in MetaStore,
COS, or both; settling changes only its location, not the logical image.

The writable image is a chain of coarse lifecycle layers containing fine,
sharded block keys. Steady writes update the current mutable layer and leave
the volume's layer pointer unchanged. Snapshot atomically seals that layer,
increments the writer epoch, and pins it. The first subsequent parent or child
write lazily creates one mutable child layer. Fork simply points a fresh volume
and epoch at the sealed layer. Neither operation copies all 524,288 entries of
a 2 GiB logical disk.

The epoch rotation is part of sealing: a writer that began before snapshot
cannot later mutate the pinned layer. A mutable layer has exactly one owning
volume and is never snapshot-visible. `DeltaMapLifecycle.tla` checks these
rules and the steady-write pointer property. `RootPackLifecycle.tla` remains
the semantic composition of referenced images with physical hot/COS locations;
its abstract root corresponds to a sealed resolved layer image, not one root
allocation per write.

`snapshot_id` is also the retry-stable operation identity. The atomic
MetaStore transaction stores the exact sealed layer, logical size, and newly
installed source writer epoch with that ID. Repeating the same ID for the same
source returns that stored result without adding a second pin or rotating the
epoch again; reuse for another source or after deletion fails closed. Thus a
crash before snapshot COMMIT leaves the old mutable root and epoch, while a
crash after COMMIT leaves the complete pinned root and new epoch even if the
reply was lost. `MetaLifecycle.tla` models the single durable snapshot identity
and reference; response-loss retry is an observational no-op over that state.

The PVM checkpoint order is:

1. freeze guest vCPUs and block new I/O submission;
2. complete the MetaStore FLUSH barrier;
3. seal the current delta layer, rotate the source writer epoch, and pin it;
4. create children that reference that exact sealed layer with fresh epochs;
5. resume parent and children.

Checkpoint does **not** wait for all payload to reach COS. Fork is metadata-only
and copies neither extent objects nor the parent writable layer. The lifecycle
model separately checks exact references, generation order, snapshot/fork
pinning, and transactional GC outbox creation.

### Independent snapshot and volume retirement

A snapshot and a forked volume are independent MetaStore roots. Fork adds a
fresh named volume root; it does not transfer or consume the snapshot pin.
Deleting a snapshot prevents future forks from that ID but never retires an
already-created volume. Deleting a volume retires exactly that sandbox's
mutable root but never deletes its source snapshot or a sibling volume. A
published snapshot therefore may outlive its staging/source volume, and a
forked volume may outlive deletion of its source snapshot.

Volume retirement is a durable `Active -> Retired` transition, not deletion of
an untyped row. PVM first stops new block submissions and may bounded-drain its
frontend, but drain is not the correctness boundary. One MetaStore transaction
ordinary-reads the volume metadata and stable `delete_op_id`, then atomically:

- records `state = Retired` for the immutable `(volume_id, incarnation)`;
- advances `writer_epoch` and records the retired/closed retry epoch;
- removes exactly that volume root from the live-root set;
- stores the idempotent delete result; and
- appends the exact root/version reclamation task to the GC outbox.

An old in-flight mutation that read the pre-delete metadata either commits
before this transaction or conflicts afterward. Correctness does not rely on
vCPU drain, cancellation, timeout, or deletion of an operation result. A lost
delete reply is reconciled by reading the same `delete_op_id`; it never releases
the root again. The user-facing `volume_id` may later name a new volume only
with a fresh incarnation. A retired incarnation is never reused, so an old RPC
or capability cannot target the replacement. Detailed tombstones may later be
compacted behind the retry horizon, but a non-reusable incarnation/graveyard
identity remains.

Snapshot deletion follows the same ID-tombstone rule. The linearization rules
for races are:

- fork before snapshot deletion creates a durable independent volume root;
- snapshot deletion before fork makes fork fail closed;
- snapshot before source-volume retirement creates a durable independent
  snapshot root;
- source-volume retirement before snapshot creation makes snapshot fail
  closed.

`DeltaMapLifecycle.tla` is authoritative for these logical root transitions,
including stale writes, forbidden incarnation reuse, and both non-cascade
directions.
`VolumeTxnLifecycle.tla` composes deletion with in-flight attempts, FDB read
conflicts, commit-unknown, retry-result retention, incarnation replacement,
and atomic root/outbox release. `SnapshotGcLifecycle.tla` then refines logical
roots through deduplicated block versions and unique cold locations into
physical pack references. The Rust SQLite repository now implements this
contract with an immutable repository `volume_id` as the first incarnation
representation; a future user-facing display name may map to a new immutable
ID instead of reactivating a tombstone.

## Garbage collection

Reachability comes exclusively from MetaStore layers and references, never COS
LIST. A transaction changes an unreachable object/layer to deleting and creates
an idempotent GC outbox entry. Workers delete exact known keys. Manifests or
layer nodes are removed last; completion releases parent references atomically.
`SnapshotGcLifecycle.tla` checks the physical-pack refinement. A logical root
does not directly own a pack reference. Active volume and snapshot roots first
resolve to a deduplicated set of live block versions; each version has at most
one `cold_locations` row; `pack_records.ref_count` is exactly the number of
those rows naming the pack. Deleting a root only changes reachability. A later
version collector deletes the now-dead cold-location row and releases the pack
once. The model also checks transactional outbox creation, unknown DELETE retry
against the same exact key, no reference resurrection, and the rule that
LIST/inventory never authorizes deletion.

Each modeled `Pack` is one physical key incarnation. A content digest may be
deduplicated while its pack is live, but a key that entered deletion is never
reused: re-uploading identical bytes receives a fresh incarnation suffix. This
prevents a delayed DELETE with an unknown prior outcome from deleting a newer
object that happens to have identical content.

Uncertain PUTs may create orphan objects. A later mark/sweep audit may use COS
inventory only to find leak candidates; every candidate must be revalidated
against a MetaStore GC epoch before deletion. A stale or incomplete listing may
leak space, but must never authorize deletion of live data.

Repack publishes every replacement location before the old pack becomes a
delete candidate. Because a reader can have resolved the old location just
before that switch, deletion also uses a conservative in-flight/grace horizon;
a racing NotFound is handled by location re-resolution. The safety argument
does not require COS deletion to be immediate.

The production bucket must either disable COS versioning for immutable pack
keys, or persist every returned `versionId` and delete exact versions. Deleting
an unversioned key in a versioned bucket merely creates a delete marker and is
not sufficient for physical reclamation; see Tencent's
[DELETE Object](https://cloud.tencent.com/document/product/436/7743).

## Reference projects and non-goals

The reviewed references are:

- `foundationdb-block-device` at `746fcef535acbe98c2b60d2afa7023ad595a1e7f`
  for direct FDB-backed block mapping, aligned/unaligned requests, transaction
  batching, ownership tokens, and an NBD frontend;
- ZeroFS at `cdc06766a07f873233732ffe40ced5827368fefd`
  for durable FLUSH/FUA, TRIM accounting, immutable packed extents, exact
  extent pointers, and repack/GC structure.

They are design evidence, not dependencies. The first lacks the COS cold tier
and production crash protocol. ZeroFS has a broader filesystem/LSM design and
does not provide this MetaStore-authoritative snapshot/fork contract. This
model also does not claim local-NVMe latency, an unbounded proof, or
implementation-source coverage.

`PackLifecycle.tla` is the separate refinement for the ZeroFS-inspired shared
pack boundary. It checks immutable membership, verified publication, safe hot
eviction, zero-reference pack deletion, and gap-free repacking without making
the MetaStore write/FLUSH model combinatorially depend on physical pack layout.

`CosReadLifecycle.tla` separately checks eventually inconsistent GET
observations, authentication, location re-resolution, and the read-versus-GC
race. `RootPackLifecycle.tla` is the composition check for incremental roots,
multiple snapshots/forks, durable root-ID tombstones, live-version derivation,
packing, and reclamation.
`FdbTxnLifecycle.tla` refines the FoundationDB attempt boundary: commit-unknown,
timeout/cancel late completion, same-op retries, epoch/read conflicts,
lexicographic versions, acknowledgement, and operation-result retirement.
`VolumeTxnLifecycle.tla` composes that boundary with PVM submission stop,
atomic volume fencing/deletion, stable delete-result retry, root release, GC
outbox creation, and fresh incarnations.
`DeltaMapLifecycle.tla` separately checks that steady writes retain their
mutable layer, change only the addressed delta key, snapshot seals before
sharing, stale epochs cannot mutate, and forks never share mutable state.
`BatchCommitLifecycle.tla` checks that batching several queued operations never
partially publishes a cohort, acknowledges before durability, crosses an epoch
fence, lets FLUSH pass pending work, or lets snapshot interleave with a batch.
`../metastore/SqliteMetaStore.tla` independently checks that a serialized
SQLite service can provide the same strong observable MetaStore semantics
without copying FoundationDB's API or error vocabulary.

## COS consistency emulator mapping

`../../cos-emulator/` is the executable test double for the weak observation
boundary above. Its durable local payload records represent `cosStored` /
`cosObjects`; these are intentionally separate from each access path's
visibility:

| Emulator observation | Model action |
|---|---|
| successful immutable PUT | `PutPack` / provider truth established |
| visible authenticated GET | `FetchCorrect` |
| path-local hidden or scripted NotFound | `FetchNotFound` |
| scripted corrupt bytes/metadata | `FetchCorrupt` |
| stale bytes retained after DELETE | old-location read/delete race |
| timeout before apply | no provider-state transition |
| timeout after PUT/DELETE apply | provider transition with lost/failed reply |

Fault queues, visibility, immutable tombstones, and the sequence in
`history.jsonl` survive process restart. The independent history checker
replays provider truth and rejects changed immutable hashes, impossible reads,
and forged corrupt observations. The emulator retains deleted payload bytes so
it can generate stale observations; it is not a physical COS GC implementation.

MinIO is reserved for SDK, signature, ETag/header, and S3-wire compatibility
tests. Its stronger consistency is not used as the correctness oracle. Neither
the emulator nor MinIO replaces a conformance/canary suite against Tencent COS.

[fdb-unknown]: https://apple.github.io/foundationdb/developer-guide.html#the-commit-unknown-result-error
