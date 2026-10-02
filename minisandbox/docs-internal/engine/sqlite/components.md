# SQLite Storage Components

Depot is split into the conveyer hot path plus workflow compaction. Workflow compaction is the only compaction publish/delete authority.

Before any Engine services start, startup serializably installs or verifies the one exact `COLD_TIER_IDENTITY/current` record in UniversalDB. A worker with a different object-layout version, bucket, root, normalized endpoint, region, addressing style, or maximum object size refuses to start. Credentials and request concurrency remain node-local operational settings. S3/COS has no root-prefix setting so the canonical hash fanout is always the first key component.

## Conveyer

The conveyer is the request path used by the SQLite VFS.

Responsibilities:

- Resolve bucket/database branch ancestry for reads.
- Serializably compare the actor's Pegboard generation key in the same FDB transaction as every actor-owned commit.
- Commit dirty pages as LTX DELTA chunks under `BR/{database_id}/DELTA/{txid}/{chunk}`.
- Write PIDX owner rows for dirty pages.
- Write `COMMITS/{txid}` and `VTX/{versionstamp}` in the same commit transaction.
- Maintain `META/head`, the latest `META/commit_attempt` idempotency proof, quota counters, and access-touch manifest fields.
- Initialize the exact `META/truncate_txid` index on the first local commit and atomically record each shrink. Never clear the fence on growth or certify an existing unindexed history.
- Recover FDB `commit_unknown_result` and duplicate Envoy delivery by exact-reading the attempt proof and returning the original TXID when its request hash matches.
- Update `SQLITE_CMP_DIRTY/{database_branch_id}` and send throttled `DeltasAvailable` workflow wakeups when hot lag crosses compaction thresholds.
- Create buckets, create databases, fork buckets, fork databases, and write branch records/catalog markers.
- Create and resolve restore points. Pinned restore points write FDB pins directly and start as `PinStatus::Ready`.

Lease ownership: none. Pegboard chooses the live owner, while the conveyer enforces its generation as a storage-layer FDB transaction fence. The conveyer must not take compactor leases.

## Workflow Compaction

The workflow compaction path uses one persistent DB manager plus hot, cold, and reclaim companion workflows per database branch.

Responsibilities:

- Coalesce commit wakeups through `SQLITE_CMP_DIRTY/{database_branch_id}` and `DeltasAvailable` signals.
- Plan bounded committed hot prefixes from current FDB state instead of trusting signal payloads. Stage and install retain the planned upper txid while revalidating current history/PITR coverage.
- Use prefix-only identity only for histories certified never truncated. Keep head identity for truncated or unindexed histories, apply every DELTA's EOF, and materialize historical coverage at its own commit size.
- Validate input identity before shard-body preflight and inside atomic publication. A removed staged cache row is retryable only when a fresh input check independently proves the plan stale; real corruption remains an error.
- Carry the branch lifecycle generation through planned jobs and reject stale stage, publish, or reclaim work after branch deletion or recreation.
- Have the hot companion prepublish SHARD bodies and write compact stage proofs under `CMP/stage/{job_id}/hot_shard`. Bodies are not authoritative without published coverage.
- Install validated hot output by publishing its reader-visible coverage and advancing `CMP/root`. Serializably read current PIDX owners and compare-and-clear only those inside the prefix, preserving future owners and atomically updating quota/counts.
- Have the cold companion upload immutable LTX shard objects to S3-compatible storage, stage exact refs in FDB, and atomically publish the refs with the cold watermark.
- Keep cold job control-plane payloads constant-size by carrying only an input count and digest; the upload activity reconstructs the bounded exact list from the immutable FDB hot generation.
- Record a durable job-local intent before every object PUT so failed partial uploads are deleted by exact key without object-store LIST.
- Refill an evicted exact `SHARD` cache row only after validating the cold object and revalidating its live FDB ref and publication marker.
- Have the reclaimer delete only manager-authorized FDB rows and stale staged output.
- Bound each reclaim lane independently and keep scheduling branch-local jobs until large eviction, retirement, PITR cleanup, or commit-history backlogs drain.
- Retire cold refs before exact object deletion, retain delete tombstones for replay safety, and garbage-collect tombstones through a bounded due index.
- Keep automatic PITR interval coverage and retained restore point pins live until reclaim can prove they are no longer needed.
- Stop the manager and companion workflows through `DestroyDatabaseBranch` when a database branch is no longer live.

Lease ownership: none. Gasoline workflow uniqueness uses only the database branch id tag.

## Branch Garbage Collection

Actor destroy resolves and tombstones its logical database name in the same FDB transaction that decrements the branch refcount. It then dispatches one durable, uniquely tagged branch GC workflow for that exact physical branch. The workflow:

- Atomically enqueues the exact physical branch in a 64-shard due index with one per-branch locator.
- Finishes immediately when the exact branch refcount or a descendant/restore-point pin is live, moving the request through jittered exponential backoff instead of retaining a sleeping per-branch workflow.
- Writes a lifecycle-generation deletion fence before any destructive work; history-pin and fork writers reject that fence.
- Stops and joins the manager plus all three companions before staging cold-object tombstones, including when an object PUT is already in flight.
- Atomically moves exact object identities from branch-local refs to a branch-external durable manifest in batches of at most 100. It then sweeps branch-local FDB immediately; no object is physically deleted on this path.
- Sweeps FDB state in branch-local pages of at most 256 keys while retaining the fence until the final page.
- Clears the exact global dirty wake key in the fence/final transactions; it does not scan the global dirty or pointer partitions.

Physical cold deletion has a second 64-shard due queue. Its fixed reconcilers dispatch only after the configured recovery window and a fresh cluster-wide backup certificate proves that the oldest supported FDB restore is strictly newer than the branch tombstone. Workers delete at most 100 exact keys per activity. Missing, stale, or regressed proof fails closed; no workflow sleeps for the recovery window and no branch-local hot data is retained merely to remember COS keys.

This makes deletion work proportional to one branch's retained data and independently schedulable across branches. Crash replay is safe across object deletion because exact object DELETE is idempotent and branch-external tombstones are cleared only after identity revalidation.

Sixty-four fixed `DbBranchGcReconcilerWorkflow`s provide the durable dispatch fallback. Each owns one queue prefix, handles bounded pages, and gives a dispatched row a five-minute lease. A lost scheduler/worker does not lose the request: lease expiry makes it due again, while unique branch workflow tags collapse duplicate dispatch. Pin and parent-reference release use the exact locator to wake a backed-off branch immediately.

## Ownership Summary

| Component | Main writes | Lease |
|---|---|---|
| Conveyer | `META/head`, `META/commit_attempt`, `META/truncate_txid`, `COMMITS`, `VTX`, `PIDX`, `DELTA`, branch records, restore points | None |
| Workflow DB manager | `CMP/root`, live `SHARD`, cold publication refs, `PITR_INTERVAL`, matching PIDX clears | None |
| Workflow companions | Staged hot output, immutable cold objects, and manager-authorized FDB/object cleanup | None |
| Branch GC workflow | `META/gc/deleting`, exact branch cold-object deletion, branch-local FDB retirement | None |
| 64 branch GC reconcilers | Sharded due rows and exact per-branch queue locators | None |
| Engine startup identity guard | `COLD_TIER_IDENTITY/current` on first cold-tier enable | None |

The components share branch metadata and pin counters, but each mutable manifest field has one owner.
