# Reference Block Engine

This crate is the first executable vertical refinement across the checked
block protocol, the typed SQLite-on-CBS MetaStore, and the deterministic
Tencent COS consistency emulator.

It is intentionally transport-independent:

```text
future guest ext4
    -> PVM / virtio-blk frontend
    -> BlockEngine
         -> BlockMetaRepository (SQLite WAL + synchronous FULL)
         -> ObjectStore (Tencent COS adapter or deterministic emulator)
```

NBD is not in the product path. The isolated `../nbd-frontend/` crate exposes a
disposable `fio`, `mkfs`, and `fsck` qualification frontend over the same API.
The PVM hypervisor can call this engine directly or through a bounded local
storage-worker ring without creating `/dev/nbdX` or parsing NBD in production.

## Implemented protocol slice

`commit_write()` uses one `BEGIN IMMEDIATE` transaction to:

1. validate the volume epoch and durable operation identity;
2. insert the exact 4 KiB hot payload and content digest;
3. upsert one exact `(layer, shard, block)` head in the current mutable layer;
4. persist the operation result used to reconcile a lost response.

Each shard covers 1,024 blocks (4 MiB), but a shard is a key prefix rather than
one serialized blob: unrelated writes do not read, rewrite, or conflict on a
whole shard value. Ordinary writes in one writer epoch reuse the same mutable
layer and do not rewrite the volume pointer. Snapshot seals that layer and
rotates the writer epoch; the first later write lazily allocates one mutable
child. Reads walk the sealed/mutable parent chain and select the nearest exact
block delta. Snapshot and fork remain O(1), and no operation copies the 2 GiB
logical address space.

`commit_range_write()` is the block-frontend path for aligned requests. It
accepts 4 KiB--512 KiB payloads whose offset and length are both 4 KiB aligned.
One request commits all of its 4 KiB versions, exact delta heads, and one
durable operation result in one transaction. The operation result records the
contiguous first/last version range, so an uncertain retry cannot expose or
reapply a partial request.

The actor also performs zero-wait group commit. After receiving one range
write, it drains only requests already queued for the same volume and writer
epoch, up to 128 operations or 512 KiB total, and commits the cohort in one
transaction. It never waits to fill a batch. A different volume/epoch, FLUSH,
snapshot, writer rotation, read, or any other command is a hard ordering
barrier and remains queued for the next actor turn. Every 4 KiB block still
gets an independent immutable version and exact delta head: batching changes
the transaction boundary, not the disk COW granularity or snapshot/fork
representation.

The schema marker is version 7. Fresh databases include range-write and
range-discard results, delta layers, immutable pack intents, durable
settlement rounds, explicit writer/settler retry-closure watermarks, and
terminal volume tombstones. Version 6 is migrated transactionally by adding
the lifecycle columns; older reference schemas are rejected rather than
silently running against obsolete constraints.

SQLite allocates `sequence` from its repository-global `commit_version` only
as a deterministic stand-in for a FoundationDB versionstamp. A real FDB
backend must use the native commit version/versionstamp and must not update a
global sequence key on each write. Its steady write set is the epoch fence,
operation-result key, immutable version value, and one exact delta key.

`capture_flush()` persists an actor-ordered barrier only after every captured
sequence has committed under SQLite `synchronous=FULL`. COS is absent from the
WRITE and FLUSH acknowledgement paths. A future multi-queue frontend must
assign the global submitted ordering point before invoking this API.

`acquire_writer()` durably deduplicates recovery acquisition and advances the
fencing epoch. A request from an old epoch persists and returns a stale result
without changing a delta layer.

A watermark crossing first persists a settlement round containing a fixed
commit-version cutoff and fixed byte budget. Later writes cannot enter that
round. Recovery may reselect any eligible old block, allowing cheap approximate
heat/locality policies, but it cannot move the cutoff or budget. The exact
members of an in-flight pack remain immutable. Recursive delta/snapshot
liveness is reconciled once at round start and once at completion, rather than
once per pack.

One bounded pack pass within that round executes:

```text
select unpublished hot versions at/below the round cutoff
    -> persist exact immutable pack intent
    -> immutable content-addressed PUT
    -> exact Range GET and SHA-256 authentication
    -> one SQLite pack/member/location publication transaction
    -> hot payload eviction
```

Every phase (`Prepared`, `Verified`, `Published`, `Complete`) is durable and
settler-generation fenced. Recovery claims the exact same member list; it does
not reselect from current hot rows. SIGKILL tests stop after intent creation,
PUT, verification, publication, and the first eviction. Immutable packs may be
shared by distinct logical versions with identical bytes.

`commit_discard()` publishes one new fenced delta/version whose logical value is
zero and stores no 4 KiB payload. `commit_range_discard()` applies the same
rule atomically to an aligned 4 KiB--512 KiB range with one retry identity and
one result; every internal block retains an independent immutable version. Both
have the same durable operation replay and FLUSH ordering as WRITE, so FUA is
already satisfied by the synchronous mutation boundary. A pinned pre-DISCARD
snapshot still resolves its old data.

Snapshot deletion leaves an idempotent tombstone, recomputes semantic live
versions across every volume and active snapshot layer, and updates physical
pack refcounts through SQLite triggers. A zero-ref pack is changed to deleting
in the same transaction that creates its `gc_outbox` row. `gc_once()` only
issues DELETE for that exact key; success or exact NotFound completes it, while
an indeterminate result remains pending. COS LIST is absent from the API.

`delete_volume()` is the corresponding terminal sandbox operation. One
`BEGIN IMMEDIATE` transaction reads the active incarnation, advances its writer
epoch, closes retries through the old epoch, removes `current_layer_id`, stores
the retry-stable delete result, and derives newly dead pack references/outbox
tasks. The repository `volume_id` itself is the immutable incarnation and is
never reusable. A late data-plane command is therefore rejected as
`VolumeRetired`, while the original delete `op_id` can replay its exact result
after a lost response. Snapshot and sibling-volume roots remain independent.

Physical object keys use a fresh incarnation suffix if identical content was
previously deleted. This prevents an old delayed DELETE from erasing a later
upload with the same SHA-256 while retaining live-pack deduplication.

Retention is explicit rather than time based. After a newer writer epoch has
fenced an old producer, the control plane calls
`close_writer_retry_window(volume, through_epoch)` only when that producer can
no longer retry. A restarted settler similarly acquires a newer generation
before `close_settler_retry_window(through_generation)`. The bounded
`compact_retained_history()` transaction then removes eligible operation
results, FLUSH barriers, semantically shadowed delta heads, unreferenced
versions, and completed retired pack workflows. It resolves the live set from
all current volumes and active snapshots and also honors cold locations,
physical pack members, and active intent members. A closed old request is
rejected with `RetryWindowClosed`; it cannot be treated as a new operation
after its result was reclaimed.

Completed COS GC rows and deleted-snapshot rows remain durable tombstones. The
former prevent physical key reincarnation races and preserve exact DELETE
completion replay; the latter prevent snapshot-ID reuse. Delta-layer chain
checkpointing is also outside this first compactor. These exclusions are
intentional safety boundaries, not accidental leaks hidden by the row counter.

Cold reads authenticate the returned 4 KiB frame against its version digest.
NotFound, timeout, malformed range, and corrupt bytes are explicit errors and
are never converted into a zero block. A block with no version in the root
chain and an authenticated versioned DISCARD are the only sources of a
successful zero read.

## Model-to-code mapping

| Checked contract action | Concrete boundary |
|---|---|
| fenced idempotent hot write | `BlockMetaRepository::commit_write` transaction |
| aligned multi-block/group commit | `BlockMetaRepository::commit_range_write`; one atomic SQLite transaction, 4 KiB--512 KiB |
| retry after unknown response | `(volume_id, writer_epoch, op_id)` in `op_results` |
| lexicographic version | `(source_volume_id, writer_epoch, sequence)` |
| durable head publication | exact `delta_block_heads(layer_id, shard_no, block_no)` upsert; steady writes keep `volumes.current_layer_id` unchanged |
| FLUSH capture and ACK | `flush_barriers` + durable operation result |
| recovery fencing | `BlockMetaRepository::acquire_writer` |
| online settlement round | `settlement_rounds`: fixed cutoff, target bytes, completed bytes, generation |
| immutable pack build | ordered concatenation of selected exact 4 KiB frames |
| provider storage identity | exact GET length/full-pack SHA-256 after PUT |
| cold-index publication | `pack_records`, `pack_members`, and `cold_locations` in one transaction |
| safe hot eviction | `evict_hot_if_published`, which requires the exact cold row |
| sealed-layer snapshot/fork | seal `delta_layers`, rotate source epoch, then share `snapshots.layer_id` with child `volumes.current_layer_id` |
| versioned DISCARD | payload-free block version + exact delta-head update + durable op result |
| aligned range DISCARD | one atomic 4 KiB--512 KiB cohort of payload-free versions + one durable op result |
| snapshot release | idempotent tombstone + semantic live-version reconciliation |
| volume retirement | `delete_volume`: epoch fence + retry closure + root removal + durable delete result + GC derivation in one transaction |
| exact physical references | `cold_locations` triggers maintain pack refcounts |
| transactional GC authorization | pack lifecycle and `gc_outbox` change together |
| exact-key idempotent DELETE | `ObjectStore::delete_exact`; no LIST method exists |
| weak COS observation | `ObjectStoreError`, never implicit zero bytes |
| retry-safe metadata compaction | explicit writer/settler retry closure + bounded `compact_retained_history` transaction |

The raw concatenation format is temporary and internal. The strong MetaStore
stores exact member offsets and per-version hashes. A production pack format
will add a versioned self-describing header without changing publication order.

## Executable evidence

The integration suite checks:

- a sparse 2 GiB volume, including the final 4 KiB block;
- sixteen concurrent retries of one operation apply exactly once;
- reused operation IDs with changed bytes fail closed;
- FLUSH durability and replay without COS;
- real SIGKILL before FLUSH COMMIT, from its SQLite commit hook, and after
  durable COMMIT before reply; retry must recover exactly one barrier;
- fresh recovery epoch and rejection of the old writer;
- real SIGKILL before COMMIT, from the SQLite commit hook, and after COMMIT
  before reply;
- aligned 32-block atomic write/replay, 512 KiB bounds, unchanged 4 KiB COW,
  and real SIGKILL at the same three group-COMMIT boundaries;
- COS timeout-before-PUT, timeout-after-PUT, corrupt GET, retry, and independent
  access-path visibility;
- publication followed by restart before hot eviction;
- restart during an active low-watermark round preserves its cutoff, target,
  round ID, and exact in-flight intent even when the caller supplies a new low
  watermark; a post-cutoff write is excluded until a later round;
- SIGKILL at all five durable pack-intent phase boundaries;
- complete hot settling, process reopen, and authenticated cold reads;
- O(1) snapshot/fork followed by eight concurrent parent/child writers over
  the same 64 logical blocks; every divergent value remains isolated after
  repository restart;
- real SIGKILL before snapshot COMMIT, from its SQLite commit hook, and after
  durable COMMIT before reply; the retry-stable snapshot ID must recover one
  pinned root and one epoch rotation;
- terminal volume retirement, same-op replay, late-write rejection, immutable
  ID non-reuse, shared-root preservation, last-root exact pack GC, and real
  SIGKILL before/during/after the retirement COMMIT;
- multiple steady writes reuse one mutable layer, touch exact sharded delta
  keys, and allocate a child layer only after snapshot sealing;
- physical pack reuse for distinct versions with identical content;
- payload-free DISCARD, replay, FLUSH, and snapshot preservation;
- snapshot-delete refcount release, indeterminate exact DELETE retry, GC
  completion, and safe same-content object reincarnation.
- explicit writer/settler retry closure followed by bounded result, barrier,
  dead-version, and completed-maintenance compaction; snapshot and current
  roots remain readable, closed retries fail, and real SIGKILL before/during/
  after compaction COMMIT is atomic and restartable;
- real SIGKILL before exact DELETE, after the object-directory fsync but before
  metadata completion, and after outbox completion; restart must respectively
  delete, treat exact NotFound as success, or observe no remaining task while
  preserving the live replacement pack.
- twelve independently checked concurrent histories with six callers, mixing
  overlapping 64 KiB writes, versioned DISCARD, READ, and FLUSH; Stateright
  must find a real-time-respecting serialization for every wave, commit
  versions must remain unique, zero-wait group commit must actually occur, and
  the final register value must survive a repository restart. The separate Go
  gate in `../verification/porcupine/` checks the full 96-operation timestamped
  history with upstream Porcupine v1.3.0 and requires an impossible-read
  mutation to be rejected.

Run the default and crash-injection suites with:

```text
cargo test -p minisandbox-block-engine
cargo test -p minisandbox-block-engine --all-features
```

The crash hooks and hidden probe binary do not exist in a default build.

## Deliberate next boundaries

This reference is not yet a production block device. The following remain
explicit work rather than implied behavior:

- multi-queue submission ordering and byte-credit backpressure at the future
  PVM storage ring (the concurrent history test starts at the repository API;
  the current actor queue is command-count bounded);
- self-describing packs, repack, bounded cold-read re-resolution, and read/GC
  grace periods;
- incremental delta-layer/reference accounting (the retention pass recomputes
  semantic liveness from delta chains transactionally);
- sealed-layer chain checkpoint/compaction for production read latency;
- Tencent COS SDK and conformance/canary adapter;
- a narrow storage-worker IPC boundary if direct in-process virtio callbacks
  need fault isolation from the future remote FDB/COS adapters.

No claim is made that these source tests prove the implementation. They are a
traceable refinement and fault suite under the assumptions documented in
`../spec/fdb-cos-block/CONTRACT.md`.
