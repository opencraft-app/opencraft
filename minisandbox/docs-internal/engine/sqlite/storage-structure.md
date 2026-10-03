# SQLite Storage Structure

This is the key-format reference for the branchable Depot layer. Update it whenever FDB layout changes.

## Identity Model

Depot has two external ids:

- `BucketId`: the bucket branch id. There is no separate bucket pointer id.
- `DatabaseId`: the database branch id. There is no separate database pointer id.

Branch records are append-only for ancestry fields. Database branch records also carry mutable lifecycle state and a monotonic lifecycle generation used to reject stale workflow compaction work. Forks allocate a new id and write a parent pointer to the source branch plus the fork versionstamp. Engine-layer rollback is implemented outside this crate by forking a database and changing the engine's database-to-database mapping.

Bucket database membership is stored in `BUCKET_CATALOG`. Bucket forks do not copy catalog entries. Reads walk bucket parents and accept inherited entries only when the entry versionstamp is at or before the walking branch's `parent_versionstamp`.

## FDB Prefixes

All Depot keys live under the crate-owned `[0x02]` prefix. The next byte is the partition.

| Partition | Prefix | Owner | Purpose |
|---|---|---|---|
| `DBPTR` | `[0x02][0x10]` | database pointer APIs | Current and historical database pointer rows by bucket branch and database name. |
| `BUCKET_PTR` | `[0x02][0x11]` | bucket pointer APIs | Current bucket branch pointer rows. |
| `BUCKET_CATALOG` | `[0x02][0x12]` | create/fork/delete database paths | Bucket catalog membership markers. |
| `BRANCHES` | `[0x02][0x20]` | branch operations, GC, workflow compaction | Database branch records plus mutable counters and lifecycle state. |
| `BUCKET_BRANCH` | `[0x02][0x21]` | bucket operations, GC | Immutable bucket branch records plus mutable counters and tombstones. |
| `BR` | `[0x02][0x30]` | conveyer and workflow compaction | Per-database hot data, metadata, workflow state, and staged output. |
| `CTR` | `[0x02][0x40]` | quota | Global counters. |
| `RESTORE_POINT` | `[0x02][0x50]` | restore point APIs | RestorePoint records and restore point state. |
| `DB_PIN` | `[0x02][0x70]` | workflow compaction | Unified database history pins. |
| `BUCKET_FORK_PIN` | `[0x02][0x71]` | bucket fork, workflow compaction | Unresolved bucket fork retention facts. |
| `BUCKET_CHILD` | `[0x02][0x72]` | bucket fork, workflow compaction | Bucket child edges for bounded proof walks. |
| `BUCKET_CATALOG_BY_DB` | `[0x02][0x73]` | bucket catalog, workflow compaction | Reverse bucket membership index by database branch. |
| `BUCKET_PROOF_EPOCH` | `[0x02][0x74]` | bucket fork | Bucket-tree proof invalidation epoch. |
| `SQLITE_CMP_DIRTY` | `[0x02][0x75]` | conveyer, workflow compaction | Coalesced compaction wake marker by database branch. |
| `DB_POLICY_BINDING` | `[0x02][0x76]` | policy APIs, branch GC | Exact database-to-policy binding. |
| `BUCKET_POLICY_PITR_SHARD` | `[0x02][0x77]` | policy APIs, workflow compaction | Sharded PITR policy membership. |
| `DB_PIN_BY_TXID` | `[0x02][0x78]` | history pin APIs, workflow compaction | Branch-local ordered history-pin index. |
| `DB_PIN_TXID_COUNT` | `[0x02][0x79]` | history pin APIs, workflow compaction | Branch-local pin counts by txid. |
| `COLD_TIER_IDENTITY` | `[0x02][0x7a]` | Engine startup | One exact cluster-wide cold-tier identity record. |
| `DB_BRANCH_GC_QUEUE` | `[0x02][0x7b]` | branch deletion, GC reconcilers | 64-shard ordered due index for physical branch deletion. |
| `DB_BRANCH_GC_QUEUE_LOCATOR` | `[0x02][0x7c]` | branch deletion, GC reconcilers | One exact current queue entry per physical branch. |

## Cold-Tier Identity

```text
COLD_TIER_IDENTITY/current
  -> ColdTierIdentity (vbare-versioned)
```

The first Engine that enables cold storage installs this record with a serializable compare-and-set. Every later Engine connected to the same UniversalDB must match its object-layout version, storage backend, bucket/root, normalized endpoint, region, addressing style, and maximum object size before storage workers start. Credentials and local request concurrency are intentionally excluded so they can be rotated or tuned without a metadata migration. Once installed, disabling cold storage fails closed because FDB may contain authoritative refs to that object store.

## COS/S3 Production Object Layout

One production bucket is scoped to exactly one environment, region, and cell. For example:

```text
actor-depot-cold-prod-bj-a01-<APPID>
```

The bucket name is the isolation boundary for IAM, lifecycle policy, failure containment, and cost attribution. There is deliberately no configurable root prefix inside an S3/COS bucket. Supplying the removed `prefix` field is a configuration error, because any common text ahead of the fanout would put sequential writes back into the same byte-ordered object-index range.

Every immutable shard uses this canonical key:

```text
hhhh/cold/v2/<branch_uuid32>/<shard_hex8>/<as_of_txid_hex16>/<generation_id>/<sha256_base64url43>.cold
```

`hhhh` is the lowercase hexadecimal encoding of the first two bytes of the full encoded object's SHA-256 hash. It is placed before the branch and monotonically increasing TXID, so even one hot actor fans writes across a 16-bit space. The complete hash remains in the filename and binds the key to immutable bytes. `ColdShardRef.object_key` must exactly equal the recomputed canonical key during validation; a noncanonical ref fails closed.

Upload, read, refill, retirement, and garbage collection use only the exact key stored in FDB. Correctness never calls COS/S3 LIST. Operational inventory should use provider inventory exports rather than walking all 65,536 fanout prefixes.

## Pointers And Bucket Catalog

```text
DBPTR/{bucket_branch_id_uuid_be:16}/{database_name}/cur
  -> DatabaseBranchId (vbare-versioned)
DBPTR/{bucket_branch_id_uuid_be:16}/{database_name}/history/{ts_ms_be:8}{nonce_be:4}
  -> DatabaseBranchId (vbare-versioned)

BUCKET_PTR/{bucket_id_uuid_be:16}/cur
  -> BucketBranchId (vbare-versioned)
```

Database pointer resolution walks bucket parents when a current bucket branch does not contain a local database pointer. Pointer history supports restore/rollback bookkeeping without changing the branch-local page layout.

```text
BUCKET_CATALOG/{bucket_id_uuid_be:16}/{database_id_uuid_be:16}
  -> 16-byte FDB versionstamp via SetVersionstampedValue
```

The value is the database membership versionstamp. Parent walks use it as the AS-OF cap for `fork_bucket`. Database tombstones on the bucket branch hide matching inherited catalog entries.

Catalog insertion and tombstoning update the reverse `BUCKET_CATALOG_BY_DB` fact and clear the affected database's complete and partial proof state in the same transaction. They do not increment the tree-wide proof epoch: unrelated database memberships cannot change this database's inheritance. A new bucket fork still increments the source tree epoch and its fixed epoch shard because the child may inherit every visible database. Publication and reclamation continue to require a complete, serializably validated proof. This changes invalidation ownership, not the persisted key/value format.

## Branch Records And Pins

```text
BRANCHES/list/{database_id_uuid_be:16}
  -> DatabaseBranchRecord (vbare-versioned)
BRANCHES/list/{database_id_uuid_be:16}/refcount
  -> i64 LE atomic-add
BRANCHES/list/{database_id_uuid_be:16}/desc_pin
  -> 16-byte versionstamp atomic-min
BRANCHES/list/{database_id_uuid_be:16}/restore_point_pin
  -> 16-byte versionstamp atomic-min

BUCKET_BRANCH/list/{bucket_id_uuid_be:16}
  -> BucketBranchRecord (vbare-versioned)
BUCKET_BRANCH/list/{bucket_id_uuid_be:16}/refcount
  -> i64 LE atomic-add
BUCKET_BRANCH/list/{bucket_id_uuid_be:16}/desc_pin
  -> 16-byte versionstamp atomic-min
BUCKET_BRANCH/list/{bucket_id_uuid_be:16}/restore_point_pin
  -> 16-byte versionstamp atomic-min
BUCKET_BRANCH/list/{bucket_id_uuid_be:16}/database_tombstones/{database_id_uuid_be:16}
  -> empty
```

Pins are raw fixed-width bytes, not vbare records. GC computes the branch pin as the minimum of the live refcount root floor, descendant pin, and restore point pin.

## Per-Database Hot Data

```text
BR/{database_id_be:16}/META/head
  -> DBHead (vbare-versioned, commit-owned)
BR/{database_id_be:16}/META/head_at_fork
  -> DBHead (vbare-versioned, fork snapshot until first local commit)
BR/{database_id_be:16}/META/commit_attempt
  -> CommitAttemptProof (vbare-versioned, latest logical attempt id + request hash + result)
BR/{database_id_be:16}/META/truncate_txid
  -> u64 BE simple index, commit-owned; zero certifies no local truncate, positive is latest shrink txid
BR/{database_id_be:16}/META/quota
  -> i64 LE atomic
BR/{database_id_be:16}/META/gc/deleting
  -> BranchGcMarker (vbare-versioned, lifecycle generation + request time)
BR/{database_id_be:16}/COMMITS/{txid_be:8}
  -> CommitRow (vbare-versioned)
BR/{database_id_be:16}/VTX/{versionstamp_be:16}
  -> u64 BE txid
BR/{database_id_be:16}/PIDX/{pgno_be:4}
  -> u64 BE owner_txid
BR/{database_id_be:16}/DELTA/{txid_be:8}/{chunk_be:4}
  -> LTX chunk blob
BR/{database_id_be:16}/SHARD/{shard_id_be:4}/{as_of_txid_be:8}
  -> inline LTX shard blob or HotShardManifest
BR/{database_id_be:16}/SHARD_CHUNK/{shard_id_be:4}/{as_of_txid_be:8}/{chunk_be:4}
  -> chunk of a manifest-backed LTX shard blob
BR/{database_id_be:16}/PITR_INTERVAL/{bucket_start_ms_be:8}
  -> PitrIntervalCoverage (vbare-versioned)
```

`META/commit_attempt` is written in the same FDB transaction as `META/head`. A retry performs one exact read: a matching attempt id and request hash returns the recorded TXID, while a mismatched payload fails closed. Only the latest serialized attempt is retained, so deduplication adds O(1) keys per branch and never needs a token scan.

`META/truncate_txid` is initialized only on the first local commit and updated atomically on each shrink. Growth never clears a positive value and ordinary writes never certify an existing unindexed history. Missing or positive values keep the original head-bound hot-compaction fingerprint; malformed values fail closed. A first shrink invalidates any previously planned prefix even if subsequent growth restores the old size. The key is a fixed-width index, not a versioned record.

`COMMITS` stores commit metadata, including wall-clock time, captured versionstamp, size in pages, and post-apply checksum. `VTX` maps a versionstamp back to txid for restore point resolution and GC. `PIDX` maps a page number to the DELTA txid that currently owns it.

`SHARD` is versioned by `as_of_txid`. Reads choose the largest `as_of_txid <= read_txid`. Hot compaction writes new SHARD versions and does not overwrite older ones.

## Workflow Compaction Metadata

```text
BR/{database_id_be:16}/CMP/root
  -> CompactionRoot (vbare-versioned)
BR/{database_id_be:16}/CMP/stage/{job_id}/hot_shard/{shard_id_be:4}/{as_of_txid_be:8}/{chunk_be:4}
  -> HotShardStageProof (vbare-versioned, chunk index zero)
BR/{database_id_be:16}/CMP/hot_publish/{manifest_generation_be:8}
  -> HotPublishMarker (vbare-versioned)
BR/{database_id_be:16}/CMP/hot_generation/{as_of_txid_be:8}
  -> HotGenerationManifest (vbare-versioned)
BR/{database_id_be:16}/CMP/hot_shard_coverage/{shard_id_be:4}/{as_of_txid_be:8}
  -> HotShardCoverage (vbare-versioned)
BR/{database_id_be:16}/CMP/cold_publish/{manifest_generation_be:8}
  -> ColdPublishMarker (vbare-versioned)
BR/{database_id_be:16}/CMP/cold_publish_refcount/{manifest_generation_be:8}
  -> i64 LE live-ref count
BR/{database_id_be:16}/CMP/cold_shard/{shard_id_be:4}/{as_of_txid_be:8}
  -> ColdShardRef (vbare-versioned)
BR/{database_id_be:16}/CMP/cold_upload_intent/{job_id}/{shard_id_be:4}/{as_of_txid_be:8}
  -> ColdUploadIntent (vbare-versioned)
BR/{database_id_be:16}/CMP/retired_cold_object/{object_key_hash:32}
  -> RetiredColdObject (vbare-versioned)
BR/{database_id_be:16}/CMP/retired_cold_object_due/{delete_after_ms_be:8}/{object_key_hash:32}
  -> empty
```

The DB manager owns published `CMP` metadata. The hot companion prepublishes SHARD bodies and records compact stage proofs. Neither the body alone nor the stage proof makes a generation authoritative to readers. Manager installation validates the active job and full bodies, atomically publishes reader-visible coverage, advances `CMP/root`, and compare-and-clears matching PIDX rows.

Hot job identity binds the committed txid prefix selected within the existing FDB batch budget. Stage and install reread only that prefix's immutable `COMMITS` and `DELTA` rows, together with current history/PITR coverage. For a history certified by `META/truncate_txid = 0`, later commits may advance `META/head` and replace PIDX owners without changing the prefix identity. Truncated or unindexed histories retain the head fence because shrink mutates SHARD caches. Installation still serializably reads the candidate PIDX keys and clears only owners inside the prefix, atomically updating their count and quota. Lifecycle and manifest-generation fences remain independent requirements. The fingerprint domain is `hot-committed-prefix-v2`; unfinished jobs with the previous fingerprint replan without changing versioned record schemas.

Installation validates input identity before staged-body integrity checks and again in the atomic publication transaction. If truncate removes a staged SHARD during preflight, a fresh exact input check must independently prove the plan stale before returning a retry; unchanged input plus missing or corrupt bytes remains a terminal integrity rejection. DELTA folding applies every intervening commit's EOF before later growth, and each historical coverage output uses its own commit size rather than the latest size.

Cold job descriptors, signals, and activity inputs do not embed the generation's shard-ref vector. They carry a fixed-size count and digest, and the upload activity reconstructs the bounded exact list from `CMP/hot_generation` plus its coverage rows in a short FDB transaction. This keeps workflow control-plane storage O(1) in shard count while preserving exact input identity.

Cold upload records an exact job-local intent before each immutable PUT. A cold ref is reader-visible only when its exact publication marker matches and `CompactionRoot` covers its txid and manifest generation. Successful publication clears the job's intent range atomically. Failed uploads and cold GC delete objects from exact FDB keys and never depend on object-store LIST.

Retired cold objects remain tombstoned through a grace period so in-flight reads and activity replay are safe. The ordered due index lets each reclaim job process a fixed-size page independent of total object history.

Reclaim descriptors may combine commit history, cold retirement, cold tombstone GC, and hot eviction work. Each vector is capped at 32 logical items so the worst combined signal remains below the 64 KiB control-plane budget. The manager immediately replans from the same branch-local indexes after completion, so the cap changes per-job work rather than total supported backlog.

## Branch Deletion

Actor deletion tombstones the logical bucket/catalog entry and decrements the physical branch refcount in one idempotent FDB transaction. The returned physical branch id dispatches one uniquely tagged `DbBranchGcWorkflow`; deletion never discovers work by scanning all database pointers.

The same tombstone transaction also installs the durable scheduling pair:

```text
DB_BRANCH_GC_QUEUE/{shard:1}/{due_at_ms_ordered_be:8}/{database_id_uuid_be:16}
  -> BranchGcQueueEntry (vbare-versioned)
DB_BRANCH_GC_QUEUE_LOCATOR/{database_id_uuid_be:16}
  -> the same BranchGcQueueEntry
```

The branch UUID hashes to one of 64 fixed shards. The locator serializes enqueue, lease, defer, and expedite operations for that branch, so replay cannot create duplicate live due rows. Each fixed reconciler reads at most 65 ordered rows from only its shard, dispatches at most 64 due branches per loop, and leases dispatched entries for five minutes. Empty/future shards sleep for at most 30 seconds. This is a dedicated work index, not a database-pointer discovery scan.

The branch GC workflow follows this order:

1. Exact-read the branch refcount and pins. If any remain, move the queue entry to a jittered exponential due time from roughly one minute up to 24 hours and finish the per-branch workflow immediately. When the branch is eligible, atomically clear its queue entry, write `META/gc/deleting`, freeze the branch, increment its lifecycle generation, and clear the exact `SQLITE_CMP_DIRTY/{database_id}` wake key.
2. Stop the branch's DB manager and hot, cold, and reclaim companions, then wait for all four workflows. An in-flight external PUT is allowed to finish before its companion exits.
3. Drain published cold refs, upload intents, and retired-object rows through their three branch-local prefixes. Each transaction handles at most 100 source rows, validates canonical object identities, and atomically copies each unique exact key to `DB_BRANCH_COLD_GC_OBJECT/{shard}/{database_id}/{object_key_hash}` before clearing the source row. Completion installs a sharded due row plus exact locator; it never calls object storage.
4. Drain the `BR/{database_id}` range in transactions of at most 256 keys. The deleting marker survives intermediate pages; the final transaction removes the branch record, counters, pins, policy state, dirty wake key, and marker. The external cold manifest survives independently.
5. One of 64 fixed cold-GC reconcilers dispatches the external manifest only after `delete_after_ms`. Before each physical page, a serializable transaction requires destructive deletion to be enabled and checks the fresh cluster backup fence. Its FDB restore version must be strictly newer than the transaction that wrote the branch tombstone; wall-clock ordering is not accepted as backup proof. The worker then deletes at most 100 exact COS/S3 keys and clears only matching durable tombstones. The final empty-prefix proof atomically removes the queue locator and manifest.

Pin and fork writers serializably exact-read `META/gc/deleting` and reject a deleting branch. The marker is therefore both a writer fence and the durable staging cursor. Object-store LIST and global pointer scans are not part of deletion correctness. A stopped backup controller merely leaves exact tombstones queued; it cannot cause deletion from a stale proof.

Deleting a history pin or releasing a child branch performs an exact locator lookup and moves an already queued parent to the current due time. Normal pin release therefore does not wait for the maximum backoff. The total number of persistent scheduler workflows is fixed at 64; a million pinned deleted branches remain FDB queue rows rather than a million sleeping Gasoline workflows.

## Branch Manifest Subkeys

`BranchManifest` is exposed as one logical struct but stored as owner-specific keys to avoid read-modify-write conflicts.

```text
BR/{database_id}/META/manifest/last_access_ts_ms
  -> i64 LE, database access touch
BR/{database_id}/META/manifest/last_access_bucket
  -> i64 LE, database access touch
```

Workflow compaction publishes live manifest state under `BR/{database_id}/CMP/root` and related `CMP/*` keys. Access-touch manifest subkeys are cache-policy inputs only; they are not deletion authority by themselves.

## Global Keys

```text
CTR/quota_global
  -> i64 LE
RESTORE_POINT/{database_id}/{restore_point_str}
  -> RestorePointRecord (vbare-versioned)

DB_PIN/{database_id_be:16}/{pin_id}
  -> DbHistoryPin (vbare-versioned)
BUCKET_FORK_PIN/{source_bucket_id_be:16}/{fork_versionstamp_be:16}/{target_bucket_id_be:16}
  -> BucketForkFact (vbare-versioned)
BUCKET_CHILD/{source_bucket_id_be:16}/{fork_versionstamp_be:16}/{target_bucket_id_be:16}
  -> BucketForkFact (vbare-versioned)
BUCKET_CATALOG_BY_DB/{database_id_be:16}/{bucket_id_be:16}
  -> BucketCatalogDbFact (vbare-versioned)
BUCKET_PROOF_EPOCH/{root_bucket_id_be:16}
  -> proof invalidation epoch (atomic i64 LE)
SQLITE_CMP_DIRTY/{database_id_be:16}
  -> SqliteCmpDirty (vbare-versioned)
```
