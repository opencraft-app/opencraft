# Strong transactional MetaStore contract

This directory specifies the small, FDB-style metadata service used by storage
layers. "FDB-style" names the strong transaction semantics; it does not require
the Apple FoundationDB client or wire protocol. The first backend may implement
the contract with SQLite on CBS. A future FoundationDB backend implements the
same typed API.

## Boundary

The metadata service stores lifecycle and hot-tier data:

- immutable root identifiers and persistent block-map nodes;
- monotonically increasing generations and commit versions;
- layer, snapshot, and fork references to exact roots;
- publish operation identifiers;
- transactional GC outbox entries;
- sparse 4 KiB hot block versions and cold-location records.

The initial writable layer has a 2 GiB logical address space, but only written
blocks occupy hot MetaStore values. Immutable packed extents hold cold payload
in Tencent COS; MetaStore remains authoritative for heads, roots, fencing,
references, and operation results. Guest code never receives this generic
key-value API; the trusted control plane exposes typed layer operations
instead.

## Transaction semantics

`MetaStore` exposes bounded typed transactions over ordered byte keys. A
transaction reads one snapshot, validates conditions, buffers mutations, and
either commits atomically at one unique monotonically increasing version or
has no effect. Completed operations have one serial order that respects real
time. Therefore a read invoked after a successful mutation response observes
that mutation or newer state. Conflicts abort and may be retried.

A commit call has backend-neutral client-visible results:

- `Committed(version)`;
- a typed rejection such as condition failed or stale epoch, meaning no domain
  mutation occurred;
- unavailable/unknown, meaning the caller must reconcile by operation ID.

Every externally retried operation has a unique `op_id`. Its result record is
written in the same transaction as the domain mutation. A timeout or transport
disconnect does not cancel queued or executing work. After an unknown result,
the client reads that record or retries the same identity instead of blindly
repeating side effects. SQLite and FoundationDB error codes are private adapter
details and never become this API.

## Root and layer ownership

A root is immutable and never reuses an identifier. It points to an immutable
persistent block map and optionally to one immutable parent root. Its exact
block versions may reside in the MetaStore hot tier, verified immutable COS
extents, or both.
Direct references arise from:

- an active layer head or base;
- a snapshot;
- a child root's parent edge.

The stored reference count must equal those explicit references. Numeric
reference updates and their reference token are one transaction.

Publishing creates a fresh root and atomically moves the active layer pointer.
The old direct pointer becomes the new root's parent edge, so the parent's
reference count does not momentarily drop to zero.

## Snapshot and fork

A snapshot pins an exact immutable root, not a mutable layer name. A fork
creates a new active layer whose base pointer pins the exact source root. Its
first publish creates a child root and replaces the base pointer with a parent
edge; no COS pack is copied.

The storage data path must make every submitted write MetaStore-durable before
the metadata transaction pins the root. COS settling is not on the checkpoint
critical path. For a PVM checkpoint the order is:

1. freeze guest execution;
2. complete the required MetaStore block FLUSH and seal a storage root;
3. transactionally pin that exact root for the snapshot/fork;
4. create fresh child writable layers;
5. resume the parent and children.

Settling a block from the hot MetaStore tier into COS changes its physical
location, not the root's logical identity. The lifecycle model proves metadata
pinning; the guest-memory freeze and block-FLUSH refinement remain separate
specifications.

## Deletion and GC outbox

GC has no authority to infer liveness from COS LIST. A root can enter
`Deleting` only while its reference count is zero. The same transaction creates
the GC outbox entry. Once deleting, new snapshots, forks, and parent edges are
rejected.

The worker resolves exact object keys from authoritative MetaStore metadata,
deletes packs idempotently, and deletes root material last. Completion changes
the root to `Deleted` and releases its parent edge in one metadata transaction.
A failed or lost COS DELETE may leak data and be retried; it cannot authorize
deletion of a live root.

## Backend obligation

The first backend is allowed to be a single-writer SQLite service on a
dedicated CBS metadata volume. It must refine this transaction contract despite
a crash after durable commit but before reply, timeout, retry, checkpoint, and
recovery. The concrete mapping is specified in `SQLITE-REFINEMENT.md`. A
disposable sandbox writable disk cannot be the sole owner of global template,
snapshot, fork, or GC metadata.

`SqliteMetaStore.tla` checks the SQLite service protocol. `CbsTxnLog.tla`
remains a lower-level comparison model for a custom append-only CBS log. When
FoundationDB is used directly, neither storage-engine refinement is part of
that data path.
