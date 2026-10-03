# SQLite Constraints And Design Decisions

This page records the constraints that shape the PITR/forking storage design. These are not incidental implementation details.

## Binding Constraints

- **Single writer per database.** Pegboard chooses the owner, and every actor-owned Depot commit serializably compares that actor's authoritative generation key in the same FDB transaction that writes SQLite state. Routing checks are only an admission optimization.
- **No local SQLite files.** The durable database state is in FDB. Local files would make storage stateful and non-migratable.
- **Lazy reads.** Forks do not copy data. Reads walk branch ancestry and hydrate from FDB DELTA/SHARD rows only when needed.
- **Per-commit granularity.** PITR targets commits/versionstamps, not individual WAL frames inside a commit.
- **FDB is the source of truth.** A commit ACK, workflow wake condition, live cold ref, and publication marker are authoritative only in FDB.
- **Commit ambiguity does not create another TXID.** The latest logical attempt id and request hash commit atomically with the head. A matching retry returns the durable result; token reuse with different bytes fails closed.
- **Object storage is a derived cold tier.** It is outside the commit path and contains only immutable objects reachable through exact FDB refs.
- **One UDB has one cold-tier identity.** Every Engine sharing a UniversalDB must match the persisted correctness-relevant cold storage configuration before starting workers.
- **No object-store LIST for correctness.** Publication, reads, recovery, and garbage collection use exact object keys recorded in FDB.
- **Branches are immutable.** A bucket id is its bucket branch id, and a database id is its database branch id.
- **Rollback is engine-owned.** Storage exposes fork primitives; the engine decides which database id a database currently uses.
- **Persisted wire/storage records use vbare.** Raw fixed-width bytes are reserved for atomic counters and simple indexes such as `VTX`.
- **Branch deletion is partitioned.** Actor destroy supplies the exact physical branch id; GC scans only that branch's bounded prefixes and never scans all pointers or uses object-store LIST.
- **Deferred branch deletion is fixed-workflow and sharded.** Pinned branches live in a 64-way FDB due queue with one exact locator each, not one sleeping workflow per branch.

Commit deduplication is deliberately constant-space per branch, not an unbounded request-id log. It protects the active serialized writer's FDB retry and duplicate Envoy delivery window. The writer-generation fence is checked before replaying a durable attempt proof, so an old actor cannot regain write authority by retrying an earlier request. The next successful logical commit overwrites the proof; a delayed request from the current generation is also rejected by the head fence after another commit advances the database.

## Rough PITR By Default

The design keeps rough PITR cheap by preserving enough FDB history for branch-at-position recovery without writing a full image for every commit. Exact recovery is opt-in through restore points, which write FDB history pins that workflow compaction must preserve.

Compared with Neon's exact-PITR posture, this trades precision for lower steady-state cost. That fits Rivet Database-style workloads where "fork near this point" is usually enough, and exact restore points can be created explicitly for critical moments.

## Pages Are Self-Describing

LTX layers carry page numbers and checksums. That lets the system move bytes between DELTA and SHARD rows without a separate opaque page map. FDB PIDX remains the hot routing index.

The result is an LSM-shaped flow:

- L0: DELTAs in FDB.
- L1: versioned SHARDs in FDB.
- L2: immutable LTX shard objects in S3-compatible storage, referenced and published through FDB.

Cold publication writes the object first, then atomically publishes its exact ref, generation marker, and cold watermark in FDB. Reclaim may evict the matching hot SHARD only after this proof and PITR/fork retention checks succeed. Missing or corrupt cold objects fail closed instead of producing zero pages.

## Why Cold-Tier Identity Is Persisted

Environment configuration alone cannot prove that every Engine sharing one FDB points at the same object store. If one worker publishes a ref into bucket A while a reader uses bucket B, the metadata is internally valid but the object is unreachable. `COLD_TIER_IDENTITY/current` converts that silent split-brain into a startup error.

The identity includes the canonical object-layout version, backend kind, filesystem root or S3 bucket, normalized endpoint, region, addressing style, and maximum accepted object size. These fields affect where bytes live or whether another worker can read them. Credentials and request concurrency are deliberately excluded because they affect access and throughput rather than object identity. S3/COS root prefixes are not configurable: the content-hash fanout must remain the first bytes of every object key.

The first enabled worker installs the record with a serializable transaction; concurrent, different first configurations cannot both commit. The record is immutable through normal startup. Changing object-store identity requires a full writer drain, an explicit object migration with ref verification, and an administrative metadata migration. A rolling config edit is not supported.

## Why Versioned SHARDs

### Why Hot Jobs Bind A Committed Prefix

Continuous writes must not invalidate an unchanged materialization merely because the current head or latest PIDX owner advanced while the job waited for admission. The planner selects a committed prefix under the existing key/byte budget. Stage and install anchor reads to that upper txid. Its fingerprint includes branch identity, root generation/watermark, selected txid, complete COMMIT/DELTA inputs, and current history/PITR coverage, not the mutable latest-owner index.

This is not permission to skip safety checks. A new history pin or changed PITR coverage must invalidate the old proof. Lifecycle and root-generation changes remain fenced. Installation reads candidate PIDX owners serializably and clears only owners covered by the installed prefix, with quota/count adjustments in the same transaction. Later owners remain authoritative in DELTA. Fault tests exercise both admission and post-stage boundaries, verify continuous progress, and require changed fork/PITR coverage to replan while retaining historical reads.

Truncate is not an ordinary overwrite: it removes PIDX rows and can prune or delete base and prepublished SHARD caches. The commit-owned fixed-width `META/truncate_txid` index certifies a never-truncated local history with zero. Every shrink records its TXID atomically, subsequent growth cannot clear it, and missing history is conservative. Only certified histories omit the mutable head from the fingerprint. Truncated or unknown histories retain the head fence; this deliberately trades progress under continuous writes after a shrink for storage safety.

Input identity is checked before integrity preflight as well as in final publication. A concurrently removed staged row can be replanned only after an independent input check proves staleness. Unchanged plans still require full shard and chunk integrity. Folding DELTAs applies each commit's EOF so growth cannot resurrect removed pages, while pinned historical outputs retain their own historical EOF.

Overwriting one SHARD key loses the older materialized image that forks and restore points may still need. Versioned SHARDs keep multiple materializations side by side:

```text
SHARD/{shard_id}/{as_of_txid}
```

Reads choose the largest `as_of_txid <= read_txid`. Reclaim deletes old versions only after descendant/restore-point pins and PITR coverage allow it.

This avoids read-your-writes ambiguity after a fork. A child branch can refer to the parent's state at a specific versionstamp while the parent continues compacting and writing newer SHARD versions.

## Why Immutable Branch Ids

Earlier pointer-based designs needed mutable DBPTR/BUCKET_PTR rows, pointer history, frozen branch state, and cache invalidation when rollback swapped a pointer. The v4 model removes that storage-layer rollback primitive.

Now the external id is the branch id. Forking creates a new immutable branch record with a parent link. Engine-layer rollback is just: fork a new database at the target versionstamp, then update the engine-owned database mapping.

This keeps storage invariants simple:

- A `DatabaseId` never points to a different branch later.
- A `BucketId` never points to a different branch later.
- Branch records are write-once and then removed only by refcount/pin GC.
- Storage does not need pointer-history audit logs or rollback cache invalidation.

## Why Lazy Bucket Catalog Inheritance

Bucket forks must be metadata-only. Eagerly copying every database membership entry would make fork time proportional to bucket size.

`BUCKET_CATALOG` solves this with parent walks. A bucket fork starts with an empty local catalog and inherits parent catalog entries whose versionstamp is at or before the fork's `parent_versionstamp`. Tombstones hide inherited entries only along the relevant bucket path.

## Proof Invalidation Must Match The Dependency

A database's bounded bucket-fork proof depends on its own reverse catalog memberships and on fork edges of the subscribed bucket trees. Catalog insertion or tombstoning atomically clears only that database's complete marker, cursor, roots, epoch subscriptions, queue and seen state. New bucket forks still invalidate the subscribed trees through root and fixed-fanout epochs; an incomplete proof still blocks publication and reclamation.

Incrementing a shared tree epoch for every unrelated database creation couples independent databases: proof reset can reject already staged output, and the manager then replans the same input. Execution permits bound concurrent work but cannot make this feedback useful. Scope invalidation to changed dependencies before increasing maintenance concurrency; measure installed/reclaimed progress separately from activity success. The real RocksDB/UDB `bucket_proof_invalidation` regressions cover completed and paged proofs under unrelated membership churn and retain the real fork-history pin fence.

These tests do not establish all bucket-fork read semantics. A separate counterexample forks a bucket at TXID 1, overwrites its parent at TXID 2, and observes TXID 2 through the child bucket's default `Db` read. The current pointer resolver returns the physical database branch without carrying the inherited bucket versionstamp into the page-read plan. Explicit historical reads and database forks are different paths. Bucket read-cap propagation remains a separate correctness fix; preservation of history alone does not prove the child selects it.

## Why Split Manifest Fields

The branch manifest is stored under separate subkeys:

- Workflow compaction owns current publish/delete decisions through `CMP/root` and manager state.
- Access-touch owns `last_access_ts_ms` and `last_access_bucket`.

Split keys avoid unrelated read-modify-write conflicts.

## Why Branch GC Uses A Durable Fence

Logical deletion, compaction shutdown, cold-object tombstoning, FDB retirement, and eventual physical deletion cannot be one transaction. `META/gc/deleting` makes the branch-local phase replayable and prevents new history pins or forks from appearing after eligibility was proved. GC freezes the branch and increments its lifecycle generation first, then joins all branch compaction workflows before moving exact object identities to branch-external tombstones. This prevents an in-flight compacter from publishing or orphaning an object after the staging pass has already inspected its FDB rows.

Every destructive unit is bounded: at most 100 cold-object rows per external-I/O activity and at most 256 branch keys per FDB sweep transaction. Branches are independent work partitions, so total database count does not increase the cost of deleting one branch and workers can process unrelated branches concurrently.

Eligibility waiting is also bounded. Creating one periodic Gasoline sleep per pinned deleted branch would turn tenant count into timer and workflow-history load. Instead, 64 durable reconcilers each scan only their ordered queue prefix in pages of 64. A per-branch locator makes scheduling changes O(1), a five-minute dispatch lease covers worker loss, and jittered exponential retry tops out at 24 hours for long-lived pins. Pin/reference release moves an existing entry due immediately through that locator. Thus scheduler workflow count and empty polling load are constant, while due work scales horizontally across deterministic UUID shards.

Every Engine worker that can write history pins or create forks must check `META/gc/deleting`. Future releases that change this fence protocol require an explicit cluster-version gate; this initial implementation has no compatibility path for pre-fence data or workflows.

Irreversible object deletion has a separate backup fence. The Engine backup controller lists every generation below an exhaustive set of dedicated `fdbbackup` base URLs, expires each generation with the configured retention while deliberately omitting `--force`, strictly parses the constant-size `fdbbackup describe` restore range, and lists every base again to reject a concurrent rotation. It then certifies the minimum `MinRestorableVersion` across all repositories and generations, a verification timestamp, and a short expiry. It never uses `fdbbackup query -3`: that JSON expands every range/log file and is not scalable for a large backup. Certificates are leases capped at 15 minutes, so a stopped controller or any CLI/catalog/parse error makes deletion fail closed.

The recovery timer alone is not proof: branch and ordinary retired-object deletion both require a fresh certificate whose FDB restore floor is strictly greater than the transaction that wrote the tombstone. Equality is rejected because that restore version can still observe the pre-tombstone state. Wall clock controls only the recovery window and certificate freshness; it never orders backup and deletion commits. A durable SHA-256 binding of the sorted backup-base set plus retention prevents a configuration switch from silently hiding older supported backups. Credential paths and rotated credentials are excluded from that identity. The shipped controller pins the exact `fdbbackup` CLI grammar/version and refuses to expire anything on a version mismatch. Operators can run one observation immediately with `engine depot backup-fence-controller-run-once` and inspect the durable lease with `engine depot backup-fence-show`; no manual command can mint an unverified fence.

Changing the bound backup bases or retention is an explicit recovery-contract migration. Operators must disable physical deletion, retire every restore covered by the old policy, and run `backup-fence-policy-rebind` with the expected old digest and an explicit retirement confirmation. The compare-and-swap clears the controller leadership lease. The old fence remains as a monotonic restore-floor high-water mark but is invalidated by its old policy fingerprint, so no deletion can resume until the new repository has completed a fresh full observation and no migration can extend recovery backwards over already-deleted objects.
