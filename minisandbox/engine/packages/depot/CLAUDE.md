# Depot Package Notes

The per-database Depot engine. FDB is the authoritative store for SQLite state. LTX V3 file format is used throughout commit and compaction payloads.

## Hard Constraints

- **No local SQLite files. Ever.** Not on disk, not on tmpfs, not as a hydrated cache file. The VFS speaks to Depot, and Depot speaks to FDB.
- **Lazy reads only.** Do not bulk pre-load database pages at open. Fetch pages on demand through PIDX/DELTA and FDB SHARD coverage.
- **FDB is the commit authority.** A SQLite commit is acknowledged only after the UniversalDB transaction commits; object storage never participates in the synchronous commit path.
- **Actor ownership is a commit fence.** Actor-owned databases serializably compare Pegboard's generation key in the same UniversalDB transaction that writes DELTA, PIDX, commit proof, and head. Envoy validation alone is not a correctness fence.
- **Ambiguous commits are idempotent.** Every logical commit carries a stable attempt id. Persist the latest attempt proof and exact request hash atomically with `META/head`; an FDB `commit_unknown_result` replay must return that TXID, never allocate the next one.
- **Cold storage is derived and exact-keyed.** PUT immutable objects before atomically publishing their exact refs in FDB, never depend on object-store LIST, and fail closed on missing or corrupt objects.
- **Cold-tier identity is cluster-global.** Every Engine sharing one UniversalDB must verify the exact persisted backend/root or bucket/prefix/endpoint/region/addressing/max-size identity before starting storage workers. Credentials and request concurrency are not identity.
- **Hot eviction requires proof.** Delete an FDB hot shard only after its matching cold ref and atomic publication marker are durable and PITR/fork retention permits it.
- **Unsupported cold config must fail clearly.** Do not silently disable old `workflow_cold_storage` config shapes.
- **Workflow compaction is the only compaction authority.** Do not reintroduce standalone compactor modules or tests.
- **Manager owns publish/delete authority.** Hot and reclaim companions stage or delete only manager-authorized work.
- **Deferred branch GC is queue-sharded.** Keep one exact locator per queued branch and a fixed number of due-prefix reconcilers. Never restore one periodic sleeping workflow per pinned branch or discover deletions through a global pointer scan.

## Read Path

- PIDX/DELTA wins.
- FDB SHARD fallback is next.
- A matching published cold ref is the final fallback and may refill the exact FDB SHARD cache row.
- Valid database gaps are zero-filled.
- Missing or corrupt required hot/cold coverage returns a storage error.
- `debug::read_at` cannot trust PIDX alone; it scans DELTA history up to the target txid before falling through to SHARD rows and zero-fill.

## Workflow Compaction

- Keep one module per workflow: `DbManagerWorkflow`, `DbHotCompacterWorkflow`, `DbColdCompacterWorkflow`, and `DbReclaimerWorkflow`.
- `RefreshManagerOutput` carries concrete hot, cold, and reclaim planned jobs.
- `DbManagerState.active_jobs` stores concrete hot, cold, and reclaim active jobs.
- `ForceCompactionWork` supports hot, cold, reclaim, and final settle work.
- `CompactionRoot` cold watermarks advance only with the atomic FDB cold publication marker.
- Cold job state and signals carry only a count and digest; upload activities reconstruct the bounded exact input list from the immutable FDB hot generation.
- Each reclaim lane has a fixed control-plane item cap and large backlogs drain through repeated branch-local jobs so combined manager state and signals remain bounded.
- Reclaimer planning owns deletion eligibility from current manifest, pins, PIDX, SHARD, and staged hot output.

## Keys And Types

- Conveyer type domains live behind the `conveyer/types.rs` facade.
- Keep branch, restore point, compaction, history-pin, storage, page, and id payloads in focused `conveyer/types/*.rs` files.
- Do not add raw `serde_bare` persisted encodings; use versioned BARE (`vbare`) for persisted/wire-format data.
- Keep commit deduplication O(1) per branch. `META/commit_attempt` is one exact-read, latest-attempt proof, not an append-only token table or scan.
- When changing FDB key layout, branch metadata, or compactor responsibilities, update `docs-internal/engine/sqlite/{storage-structure,components,constraints-and-design-decisions}.md` in the same change.

## Tests

- Put Rust tests under `tests/`, not inline `#[cfg(test)] mod tests` in `src/`, unless private-module access is truly required.
- Keep authoritative metadata fixtures UniversalDB-backed; filesystem cold-tier fixtures are allowed only for exact object-store contract and fault tests.
- Fault tests should use surviving commit, read, hot compaction, and reclaim fault points.

## Reference Docs

- `docs-internal/engine/depot.md`
- `docs-internal/engine/sqlite/storage-structure.md`
- `docs-internal/engine/sqlite/components.md`
- `docs-internal/engine/sqlite/constraints-and-design-decisions.md`
