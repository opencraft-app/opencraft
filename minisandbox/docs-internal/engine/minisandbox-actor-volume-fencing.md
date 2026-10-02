# Minisandbox ActorVolume Writer Fencing

This document defines the production ownership protocol between Rivet's authoritative Actor
generation and a writable block volume attached to a PVM sandbox. It is a correctness protocol,
not an optimization and not a local sbxlet implementation detail.

The accompanying TLA+ model is in
[`runtimes/minisandbox/host/spec/actor-volume-fence`](../../runtimes/minisandbox/host/spec/actor-volume-fence/README.md).

## Authorities

There are three deliberately separate tokens:

| Token | Authority | Purpose |
| --- | --- | --- |
| `actor_generation` | Pegboard `GenerationKey(actor_id)` | Globally fences an old Actor placement. |
| `writer_epoch` | ActorVolume metadata in UniversalDB | Fences an old writable mount/session for one volume incarnation. |
| `sandbox_capability` | The local sbxlet process | Prevents stale or forged local handles from opening ingress or destroying another PVM. |

The sbxlet capability is never accepted by Depot or ActorVolume. A volume writer epoch is never
used as proof that Pegboard still owns the Actor generation. Neither token substitutes for the
other.

## Required consistency boundary

The exact Pegboard generation key and ActorVolume writer-fence metadata MUST be readable in the
same serializable UniversalDB transaction that commits volume metadata. Payload bytes may be
stored in a derived immutable COS tier, but COS is never an ownership authority.

An implementation that places ActorVolume metadata in a database which cannot transactionally
read Pegboard's generation key does not implement this protocol. It needs a separately modeled
cross-database consensus protocol; a cached generation, RPC validation performed before the
transaction, lease timeout, or successful sbxlet heartbeat is insufficient.

## Identifiers

A production volume request carries or resolves the following identity:

```text
actor_id
actor_generation
volume_id
volume_incarnation
writer_epoch
operation_id
```

`volume_incarnation` prevents a deleted and recreated logical volume from accepting operations
from its predecessor. `writer_epoch` is monotonically increased within an incarnation.
`operation_id` provides idempotence for an uncertain transaction result. The durable operation
result is checked only after both ownership fences have been checked.

The guest does not choose any of these values. It receives an opaque, bounded volume-session
capability from the trusted runtime. The block frontend resolves that capability to the tuple
above and rejects unknown or revoked sessions before submitting work.

## Activation protocol

For `StartActor(actor_id, generation)`:

1. The Envoy adapter validates the command and refuses a generation below its local admission
   floor. This is a local optimization; it is not the durable fence.
2. The volume service executes `acquire_writer` as one serializable UniversalDB transaction:
   - read the exact Pegboard `GenerationKey(actor_id)`;
   - require it to equal `generation`;
   - read the live `volume_incarnation` and current writer record;
   - increment `writer_epoch`, or return the same epoch for an exact idempotent activation retry;
   - write `{actor_id, generation, volume_incarnation, writer_epoch, activation_id}` and the
     idempotent result atomically.
3. sbxlet creates the PVM and installs only the opaque volume-session capability as one writable
   sparse ext4 virtio-blk backend. Before admission, sbxlet has already reduced the trusted seed to
   a bounded non-zero 4 KiB page set. New volumes atomically commit those pages, dirty markers, and
   versioned `ready` state in FDB; COS is not on the activation path.
4. The guest reaches its profile-specific ready point.
5. Only after steps 2 through 4 succeed may the host admit ingress and complete Actor start.

If any step fails, ingress remains closed. Retrying the same activation returns the same live
writer epoch or acquires a strictly newer one; it never rolls an epoch backwards.

Acquiring a writer epoch before starting the PVM avoids exposing a guest that cannot persist. The
per-commit Pegboard check remains mandatory: there is an intentional interval after Pegboard moves
to a new generation but before the new host acquires its writer epoch. During that interval the
old epoch may still be stored as the volume owner, but the old generation is already unable to
commit.

## WRITE, DISCARD, and FLUSH

Every metadata-changing operation runs as one serializable UniversalDB transaction:

1. Read Pegboard's exact `GenerationKey(actor_id)` and require `actor_generation`.
2. Read the volume incarnation and writer record and require exact
   `(volume_incarnation, writer_epoch, actor_generation)` equality.
3. Check the durable `operation_id` result. A matching result may be replayed; reuse with different
   request bytes fails closed.
4. Apply payload/head, sequence, quota, and operation-result changes atomically.
5. ACK only after the transaction commit is durable.

The generation and epoch reads are serializable reads and therefore conflict with a concurrent
Pegboard takeover or writer acquisition. An old write has exactly two valid outcomes:

- it commits before takeover and is visible to the new generation; or
- takeover wins, the write transaction retries, observes a fence mismatch, and fails closed.

The same ordering applies to DISCARD. FLUSH acknowledges only operations covered by the durable
committed sequence for the same fenced session. An FDB `commit_unknown_result` retry keeps the same
operation ID and rechecks both fences before replaying its durable result.

## Stop, crash, replacement, and destroy

- `SleepIntent`, `StopIntent`, `GoingAway`, `Lost`, and `Replaced` revoke local admission and the
  sbxlet capability, stop the PVM, and preserve the volume.
- A best-effort writer release may advance the volume epoch, but correctness MUST NOT depend on it:
  a crashed or partitioned sbxlet may never send release.
- Pegboard generation advancement immediately fences the old PVM at every volume commit. The next
  successful `acquire_writer` advances the volume epoch as a second fence.
- Stop completion is reported only after the PVM and its local frontend are terminated. A delayed
  stop for generation `g` never acts on an instance for another generation.
- `Destroy` is an Engine/storage lifecycle operation. It first fences the Actor generation and
  writer epoch, then starts the separately modeled volume deletion/GC protocol. Local sbxlet
  teardown does not authorize durable deletion.

sbxlet keeps no recovery database. On process crash all PVMs, descriptors, rings, and local
capabilities disappear. Pegboard expires the Envoy and creates a later generation; durable volume
ownership is recovered from UniversalDB.

## Safety properties

The model checks the following properties:

- a writer acquisition was authorized by the exact Pegboard generation;
- a committed write held both the generation and writer-epoch fence at its linearization point;
- an uncertain-result replay cannot bypass either fence;
- admission carries a successfully acquired current writer session;
- a delayed stop cannot revoke another generation;
- a revoked local capability cannot finish opening ingress;
- a capability is never reused for a later local incarnation;
- stop completion occurs only after teardown.

Physical overlap is allowed. During failover, two PVMs can temporarily execute CPU instructions.
The safety claim is narrower and stronger: at most the transactionally authorized generation and
writer epoch can change durable ActorVolume state.

## Implementation mapping

| Model action | Production boundary |
| --- | --- |
| `AdvanceGeneration` | Pegboard writes `GenerationKey(actor_id)`. |
| `AcquireWriter` | ActorVolume serializable writer-acquisition transaction. |
| `AdmitInstance` | minisandbox host publishes the generation for ingress. |
| `StartWrite` | virtio-blk resolves a bounded opaque volume session. |
| `CommitWrite*` | ActorVolume/FDB transaction commits block metadata and result. |
| `RetryUnknown` | same `operation_id` lookup after ownership revalidation. |
| `StopInstance` | generation-matched sbxlet capability revocation. |
| `FinishTeardown` / `CompleteStop` | PVM join followed by Envoy stop completion. |

The local WAL/FULL SQLite block backend and SQLite-over-Depot adapter remain reference
implementations. The PVM product path instead commits complete 4 KiB hot pages and versioned
metadata directly to FDB. Every initializer, writer recovery, WRITE, DISCARD, and writeback transaction
serializably compares Pegboard's exact `GenerationKey(actor_id)` before inspecting an idempotent
operation result. Normal guest READ is deliberately absent from that list: writer admission performs
one fenced, consistent range scan, after which READ consumes only a disposable local manifest and
materialized RAM/NVMe chunks. A pre-commit RPC or cached generation is not an acceptable substitute
for mutations.

The local read plane is `local-free`: neither the recovery manifest nor materialized chunks are
authoritative or transferred during placement changes. A missing local entry is reconstructed from
the immutable COS base plus FDB hot pages loaded at admission. Dirty materializations are cached
under their content hash without publishing that hash as a cold reference. Only writeback uploads
and verifies COS before atomically replacing exact hot-page sequences. Its final FDB mutation shares
a per-volume coordinator with guest WRITE/DISCARD; object transfer remains outside the critical
section. FDB hot-cap pressure backpressures and retries the same durable operation instead of
weakening the ACK contract.

The current PVM adapter uses the authoritative actor generation as its stored writer fence. A
separate `volume_incarnation` and independently advanced `writer_epoch` remain required before
delete-and-recreate or same-generation writer replacement is admitted. Until those lifecycle
operations exist, the control plane must preserve a volume for the actor ID and must not create two
writable sessions for one generation.

The trusted ext4 template ID is content-immutable. Initialization stores explicit
`initializing/ready` state in FDB; its bounded non-zero 4 KiB pages, dirty index, and `ready` state
commit atomically under the exact generation fence. COS settlement starts only after admission. A
host crash therefore cannot expose a partial template and resumes writeback from the durable dirty
index without using sparse-file metadata. The guest-visible capacity contains no hidden marker
block.

The ext4 journal and FLUSH remain crash-consistency mechanisms above the generation storage fence.
Filesystem discard publishes payload-free zero pages; asynchronous settlement removes the cold
chunk reference when the complete 4 MiB range becomes zero.
