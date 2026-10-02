# Minisandbox storage workspace

This directory contains the authoritative finite-state algorithm models and
three executable test refinements: a bounded-queue, single-owner `SQLite` `MetaStore`
actor, a deterministic Tencent COS consistency emulator, and a transport-free
[`block-engine/`](block-engine/) vertical slice connecting typed block
transactions to asynchronous immutable settling. The separate NBD validation
adapter connects the reference engine to ordinary Linux for testing. The same
typed backend is connected directly to PVM virtio-blk, and `fdb-adapter` can
now open its unchanged SQLite transaction repository on the production Depot
VFS. Depot makes FDB the page-commit authority, applies the Pegboard generation
fence in that same transaction, and owns physical COS settlement.

The earlier independent TLA+ algorithm in
[`spec/Storage.tla`](spec/Storage.tla), with requirements in
[`spec/StorageSafety.tla`](spec/StorageSafety.tla), remains the checked
CBS-hot comparison design. It models versioned block contents, two fenced
writers, durable CBS state, content-addressed objects, transient Tencent COS
visibility, asynchronous callbacks, manifest CAS, reclamation, crash, and
recovery. The older Rust state machine under `src/` is retained only as an
executable prototype and is not verification evidence.

The current MetaStore-authoritative design is split into independently
checkable models plus one composition model. MetaStore has strong FDB-style
semantics; local SQLite WAL/FULL remains the hermetic reference backend, while
production uses the same schema and transactions through Depot SQLite on
FDB/COS:

- [`spec/fdb-cos-block/FdbCosBlock.tla`](spec/fdb-cos-block/FdbCosBlock.tla)
  covers hot MetaStore writes, uncertain commit, FLUSH, fencing, Tencent COS
  settling, verification, and safe hot eviction;
- [`spec/metastore/MetaLifecycle.tla`](spec/metastore/MetaLifecycle.tla) covers
  immutable roots, snapshot/fork references, deletion, and the GC outbox.
- [`spec/metastore/SqliteMetaStore.tla`](spec/metastore/SqliteMetaStore.tla)
  checks the single-writer SQLite refinement: linearizable reads and commits,
  CAS, epochs, durable deduplication, retry, disconnect, and recovery.
- [`spec/fdb-cos-block/PackLifecycle.tla`](spec/fdb-cos-block/PackLifecycle.tla)
  covers immutable shared packs, member publication, repacking, and pack GC.
- [`spec/fdb-cos-block/CosReadLifecycle.tla`](spec/fdb-cos-block/CosReadLifecycle.tla)
  separates durable COS storage from transient GET observations and checks
  authenticated retry across the read/repack/delete race;
- [`spec/fdb-cos-block/RootPackLifecycle.tla`](spec/fdb-cos-block/RootPackLifecycle.tla)
  composes multiple immutable roots, snapshots/forks, live-version derivation,
  hot eviction, and shared-pack GC with an independent safety oracle.
- [`spec/fdb-cos-block/FdbTxnLifecycle.tla`](spec/fdb-cos-block/FdbTxnLifecycle.tla)
  refines commit-unknown versus timeout/cancellation, late commits, same-op
  retries, epoch fencing, version identity, and operation-result retirement.
- [`spec/fdb-cos-block/DeltaMapLifecycle.tla`](spec/fdb-cos-block/DeltaMapLifecycle.tla)
  checks the write-scalable metadata shape: exact sharded delta keys are
  updated inside one writer epoch, while snapshot seals a layer, rotates the
  epoch, and fork shares only sealed state.
- [`spec/fdb-cos-block/BatchCommitLifecycle.tla`](spec/fdb-cos-block/BatchCommitLifecycle.tla)
  checks zero-wait same-volume batching, atomic cohort commit, durable replies,
  epoch fencing, FLUSH cuts, and snapshot barriers.
- [`spec/fdb-cos-block/VolumeTxnLifecycle.tla`](spec/fdb-cos-block/VolumeTxnLifecycle.tla)
  composes terminal volume deletion with ordinary FDB reads/conflict ranges,
  commit-unknown retries, incarnation non-reuse, root release, and GC outbox
  derivation.

Their concrete contract, including the 2 GiB sparse writable layer, is in
[`spec/fdb-cos-block/CONTRACT.md`](spec/fdb-cos-block/CONTRACT.md). The older
`Storage.tla` CBS-hot model is retained for comparison rather than silently
being reinterpreted as the current MetaStore design. The concrete first-backend
mapping is in
[`spec/metastore/SQLITE-REFINEMENT.md`](spec/metastore/SQLITE-REFINEMENT.md).

The implemented slice in
[`src/sqlite_metastore.rs`](src/sqlite_metastore.rs) provides namespaces,
writer-epoch fencing, versioned key CAS, durable operation-result deduplication,
linearizable reads, WAL/FULL startup validation, and backend-neutral errors.
That generic key/value actor deliberately does not implement concrete block
roots, snapshots, references, a GC worker, or a COS client.

[`block-engine/`](block-engine/) adds the typed multi-row transaction that the
generic key/value actor deliberately cannot provide. It atomically commits an
aligned 4 KiB--512 KiB request, preserving one immutable version and exact
`(layer, shard, block)` delta head per 4 KiB block. Its actor zero-wait batches
already queued same-volume requests up to 512 KiB without crossing FLUSH,
snapshot, epoch, or volume boundaries. It also implements SQLite-only FLUSH,
fresh recovery epochs, authenticated COS-emulator settling, safe restart
eviction, and O(1) sealed-layer snapshot/fork. It has no NBD frontend: the
intended product frontend is the owned PVM/virtio-blk path.

[`block-backend/`](block-backend/) owns the reusable SQLite + COS-emulator
adapter extracted from NBD. PVM calls it directly after bounded virtio parsing,
so the guest sees `/dev/vda` without a writable image fd/path, NBD, loop,
reflink, or sparse-file copy. At checkpoint it seals the database delta layer;
each PVM clone forks a fresh logical volume and writer epoch in O(1). The local
SQLite database and file-backed COS emulator are reference dependencies, not a
claim that the current implementation has no host files at all.

The vertical slice now implements terminal `delete_volume`: it advances the
writer epoch, closes the old retry window, removes the live root, persists the
idempotent delete result, and derives exact GC work in one SQLite transaction.
PVM template capture consumes and retires its quiesced source volume after the
snapshot root is durable. Every forked clone backend carries ephemeral
ownership and retires its private logical volume when the VM is destroyed;
ordinary persistent PVM/NBD backend disconnect still preserves its volume.
The template snapshot remains pinned until the in-process template is dropped.

Snapshot IDs are durable idempotency identities: the sealed layer and newly
installed source epoch commit atomically, so a lost reply can be retried
without double-pinning or rotating the epoch twice. Fault-enabled tests split
that transaction at all three SQLite commit boundaries, and eight concurrent
parent/child writers verify block-level COW isolation before and after restart.

[`benchmarks/sqlite-block/`](benchmarks/sqlite-block/) drives that exact
repository path in release mode and records durable sequential, random,
same-head, replay, and concurrent-caller baselines. It is a separate binary so
benchmark policy does not leak into the Block Engine.

The Block Engine integration suite also records real invocation/return
histories from six concurrent repository callers. Stateright checks each wave
in-process, while [`verification/porcupine/`](verification/porcupine/) exports
the independently timestamped full history to upstream Porcupine v1.3.0. The
bounded histories mix overlapping 64 KiB writes, versioned DISCARD, READ, and
FLUSH, then reopen SQLite and verify the final value. The Porcupine gate also
changes one read to a value that was never written and requires rejection, so
a vacuous loader/model cannot pass unnoticed. This validates the repository
actor boundary; assigning a global submission cut across future PVM queues
remains frontend work.

Fault-enabled tests stop a real subprocess before, during, and after FLUSH
COMMIT and require one idempotent barrier after recovery. They also stop a real
subprocess at all three exact-key GC
boundaries: before DELETE, after the object-directory fsync, and after SQLite
outbox completion. Recovery must finish the same durable task idempotently and
must never remove or hide the replacement pack still referenced by the volume.

[`nbd-frontend/`](nbd-frontend/) is an isolated Linux validation frontend. It
uses a direct kernel socketpair rather than a network listener, translates
512-byte NBD requests into authenticated 4 KiB reads or bounded RMW writes,
and maps FLUSH/FUA to the durable SQLite barrier. Its destructive guarded smoke
script creates a real 2 GiB ext4 filesystem, disconnects, optionally settles
all hot payload into the COS emulator, reconnects under a fresh epoch, runs
`e2fsck -fn`, and verifies file content and inode identity. NBD is not part of
the PVM product attack surface. The same folder contains a deterministic raw
block oracle and guarded SIGKILL script: it checkpoints per-4 KiB hashes only
after a device FLUSH, kills the complete server without cleanup, reopens the
SQLite WAL under a fresh epoch, and verifies every known block against the
digest-protected oracle state. Guarded adapters also run selected upstream
blktests cases and two-volume ext4 and XFS xfstests slices without adding either
test framework to the PVM or product dependency graph. A separate possible-values
oracle kills the frontend inside one direct write and rejects torn 4 KiB data
or illegal 512 KiB transaction cuts after recovery.

[`fdb-adapter/`](fdb-adapter/) contains the first hermetic FoundationDB
refinement: tuple keyspace, exact sharded delta heads, and native
versionstamped payload/head/result encoding. It deliberately has no live C
client yet; the SQLite baseline comes first, followed by real-cluster conflict
and throughput measurement.

[`cos-emulator/`](cos-emulator/) is an independent crate that stores immutable
provider truth on local files while giving each named access path separate
visibility. It supports path-style PUT, HEAD, single-range GET, DELETE,
scripted weak observations, timeout-before/after-apply, restart persistence,
and append-only JSONL histories. It is a protocol test double, not a production
object store or evidence that real Tencent COS satisfies the modeled provider
obligations.

## Run the checks

Java 11 or newer and `curl` are required. The script downloads the pinned TLA+
Tools 1.7.2 JAR, verifies both its published SHA-1 and the repository-pinned
SHA-256, and keeps it under the ignored `spec/.cache/` directory.

```text
# 1 block, all fault classes, five mutation counterexamples; a few seconds
storage/spec/check.sh ci

# 1 block, 2 values, 2 versions, 2 epochs, 2 CAS generations
storage/spec/check.sh medium

# 2 blocks and the complete checked state space; several minutes
storage/spec/check.sh full

# MetaStore + Tencent COS data, SQLite/CBS refinements, and mutations
storage/spec/fdb-cos-block/check.sh all
```

Set `TLA2TOOLS_JAR=/path/to/tla2tools.jar` to run without downloading it.

The executable refinement has two test modes:

```text
# SQLite actor plus COS emulator core/HTTP tests
cargo test --locked --workspace --manifest-path storage/Cargo.toml

# also compile the non-release crash hooks and SIGKILL before/during/after COMMIT
cargo test --locked --workspace --manifest-path storage/Cargo.toml --all-features

# default and fault-injection builds must both be warning-free
cargo clippy --locked --workspace --manifest-path storage/Cargo.toml \
  --all-targets --all-features -- -D warnings

# run the standalone loopback COS consistency emulator
cargo run --manifest-path storage/Cargo.toml \
  -p minisandbox-cos-emulator -- serve \
  --root /tmp/minisandbox-cos --token local-test-token-1234
```

Fault-injection hooks are disabled by default. The hidden Block Engine
process-stop entry points and the NBD first-WRITE stall wrapper are not present
in a normal release-oriented build.

## What is checked

- every successful FLUSH remains recoverable from durable CBS or a complete
  committed S3 manifest;
- every block reference is an actually issued `(block, version, content)`;
- every verified or manifest-referenced content hash exists in S3;
- CBS head metadata always points to durable CBS data;
- reclamation cannot remove the last durable copy of acknowledged data;
- manifest generation and per-block versions never regress;
- a CAS expectation can succeed at most once;
- stale writers and callbacks from old epochs cannot mutate current state.

PUT success, timeout-before-commit, timeout-after-commit, HEAD present,
transient `NotFound`, corrupt HEAD data, process crash, recovery, delayed old
callbacks, CAS conflicts, and both safe and unsafe reclamation orderings are
explicit transitions.

This is transition-system coverage, not source-code branch coverage. TLC
enumerates every enabled successor in the finite model. Outcomes with the same
safe effect may merge into one successor state—for example, HEAD `NotFound`
and corrupt data both discard the verification attempt. The mutation suite is
the independent adequacy check for the five safety-critical decision points.

## Verification boundary

This is exhaustive finite-state checking of the algorithm configurations, not
an unbounded mathematical theorem and not a proof of a future implementation.
`Values` represent ideal collision-free content hashes. `CbsSync` represents
the algorithm-level durable boundary. A concrete implementation must later
refine these two contracts.

See [`spec/SPECIFICATION.md`](spec/SPECIFICATION.md) for the state model and
assumptions, [`spec/mutations/COUNTEREXAMPLES.md`](spec/mutations/COUNTEREXAMPLES.md)
for deliberately broken algorithms, and [`VERIFICATION.md`](VERIFICATION.md)
for recorded results.
