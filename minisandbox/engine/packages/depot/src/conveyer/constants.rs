/// Spec section 8 caps database branch ancestry so fork, read, and restore_point walks stay bounded.
pub const MAX_FORK_DEPTH: u8 = 16;

/// Spec section 8.1 caps bucket branch ancestry so bucket resolution stays bounded.
pub const MAX_BUCKET_DEPTH: u8 = 16;

/// Spec section 9 caps restore_points per bucket to bound pin recomputation work.
pub const MAX_RESTORE_POINTS_PER_BUCKET: u32 = 1024;

/// Spec section 12.1 caps FDB shard-version amplification when eviction lags hot compaction.
pub const MAX_SHARD_VERSIONS_PER_SHARD: u32 = 32;

/// Spec section 12.1 keeps hot commit and VTX history for recent restore point resolution.
pub const HOT_RETENTION_FLOOR_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Spec section 12.3 buckets access touches to bound eviction-index churn to about one write per minute.
pub const ACCESS_TOUCH_THROTTLE_MS: i64 = 60_000;

/// Spec section 12.1 keeps an eviction safety margin behind the latest hot pass.
pub const SHARD_RETENTION_MARGIN: u64 = 64;

/// Spec section 13 retains frozen rollback targets by wall-clock age rather than fixed head txid.
pub const FROZEN_BRANCH_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Spec section 12.3 keeps recently accessed hot data resident before eviction can clear it.
pub const HOT_CACHE_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Workflow compaction signal payloads stay below Gasoline's durable signal size budget.
pub const CMP_SIGNAL_PAYLOAD_LIMIT_BYTES: usize = 64 * 1024;

/// Workflow compaction job descriptors stay small enough for durable workflow state.
pub const CMP_JOB_DESCRIPTOR_LIMIT_BYTES: usize = 256 * 1024;

/// Workflow compaction install and reclaim activities cap each FDB transaction by key count.
pub const CMP_FDB_BATCH_MAX_KEYS: usize = 500;

/// Reclaim also clears the immutable per-page history entries for each
/// selected commit. One maximum-size commit can therefore touch roughly two
/// rows per dirty page plus DELTA chunks and metadata. Keep it in one bounded
/// transaction without lowering SQLite commit admission below 320 pages.
pub const CMP_RECLAIM_FDB_BATCH_MAX_KEYS: usize = 1024;

/// Reclaim signals can describe several independent cleanup lanes at once. Limit each lane's
/// logical item count so the combined durable manager state and signal stay below the control-plane
/// payload budget; large backlogs drain through repeated branch-local jobs.
pub const CMP_RECLAIM_CONTROL_MAX_ITEMS_PER_LANE: usize = 32;

/// Workflow compaction install and reclaim activities cap each FDB transaction by value bytes.
pub const CMP_FDB_BATCH_MAX_VALUE_BYTES: usize = 2 * 1024 * 1024;

/// FoundationDB values are limited to 100 KiB. Hot shards can contain 64 SQLite pages (roughly
/// 256 KiB before LTX framing), so both staged and published shard blobs must be split into
/// comfortably smaller values.
pub const HOT_SHARD_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_HOT_SHARD_BLOB_BYTES: usize = 512 * 1024;
/// A healthy materialized shard contains at most 64 SQLite pages plus LTX framing. Keep a
/// generous hard ceiling so a corrupt manifest cannot make readers or cleanup loop billions of
/// times over attacker-controlled `chunk_count` metadata.
pub const MAX_HOT_SHARD_CHUNKS: u32 = 16;

/// A cold pass is bounded by the same key budget as the hot FDB pass which produced it. Cold refs
/// are staged directly in FDB and workflow messages only carry a compact count/digest, so this is
/// no longer constrained by Gasoline's durable signal payload size.
pub const CMP_COLD_MAX_SHARDS_PER_JOB: usize = CMP_FDB_BATCH_MAX_KEYS;

/// Workflow compaction caps each immutable cold object well above the normal 256 KiB shard.
pub const CMP_COLD_OBJECT_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Exact-key COS deletes are deliberately smaller than FDB reclaim batches. This keeps one
/// idempotent DeleteObjects request and its durable workflow payload bounded.
pub const CMP_COLD_DELETE_MAX_OBJECTS: usize = 100;

/// Keep a completed exact-delete tombstone long enough to absorb delayed activity retries, then
/// remove it through the same due index. This bounds retired-object metadata without weakening
/// delete-before-ack idempotency.
pub const CMP_COLD_TOMBSTONE_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// DB manager schedules its next cold pass after hot activity or this periodic deadline.
pub const MANAGER_COLD_COMPACTION_INTERVAL_MS: i64 = 2 * 60 * 1000;

/// SQLite commits must stay comfortably below the compaction input caps so one txid always fits in
/// a hot/reclaim compaction batch. 320 pages leaves room under the 500-key cap for PIDX rows,
/// delta chunk keys, commit metadata, VTX rows, root updates, and future per-commit overhead.
pub const MAX_COMMIT_DIRTY_PAGES: usize = 320;
pub const MAX_COMMIT_RAW_DIRTY_BYTES: usize =
	MAX_COMMIT_DIRTY_PAGES * crate::conveyer::keys::PAGE_SIZE as usize;
/// Commit DELTA rows are chunked at 10KB. This leaves framing headroom above
/// the 320-page raw admission cap while keeping every exact-commit read bounded.
pub const MAX_DELTA_CHUNKS_PER_COMMIT: usize = 256;

/// Workflow compaction splits planned activities expected to exceed this wall time.
pub const CMP_ACTIVITY_TARGET_MS: i64 = 30 * 1000;

/// Environment override for the DB manager's periodic reclaim/GC cadence. Forced reclaim uses the
/// same bounded, proof-checked planner; this value only controls how often the periodic lane wakes.
pub const MANAGER_RECLAIM_INTERVAL_ENV: &str = "RIVET_DEPOT_RECLAIM_INTERVAL_MS";
pub const DEFAULT_MANAGER_RECLAIM_INTERVAL_MS: i64 = 10 * 60 * 1000;
pub const MIN_MANAGER_RECLAIM_INTERVAL_MS: i64 = 1_000;
pub const MAX_MANAGER_RECLAIM_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;

pub fn manager_reclaim_interval_ms() -> anyhow::Result<i64> {
	match std::env::var(MANAGER_RECLAIM_INTERVAL_ENV) {
		Ok(value) => parse_manager_reclaim_interval_ms(&value),
		Err(std::env::VarError::NotPresent) => Ok(DEFAULT_MANAGER_RECLAIM_INTERVAL_MS),
		Err(std::env::VarError::NotUnicode(_)) => anyhow::bail!(
			"{MANAGER_RECLAIM_INTERVAL_ENV} must contain a UTF-8 integer number of milliseconds"
		),
	}
}

fn parse_manager_reclaim_interval_ms(value: &str) -> anyhow::Result<i64> {
	let interval_ms = value.parse::<i64>().map_err(|_| {
		anyhow::anyhow!(
			"{MANAGER_RECLAIM_INTERVAL_ENV} must be an integer number of milliseconds, got {value:?}"
		)
	})?;
	anyhow::ensure!(
		(MIN_MANAGER_RECLAIM_INTERVAL_MS..=MAX_MANAGER_RECLAIM_INTERVAL_MS).contains(&interval_ms),
		"{MANAGER_RECLAIM_INTERVAL_ENV} must be between {MIN_MANAGER_RECLAIM_INTERVAL_MS} and {MAX_MANAGER_RECLAIM_INTERVAL_MS} milliseconds, got {interval_ms}"
	);
	Ok(interval_ms)
}

#[cfg(test)]
mod reclaim_interval_tests {
	use super::*;

	#[test]
	fn reclaim_interval_parser_enforces_operational_bounds() {
		assert_eq!(parse_manager_reclaim_interval_ms("5000").unwrap(), 5_000);
		for invalid in ["999", "86400001", "not-a-number"] {
			assert!(parse_manager_reclaim_interval_ms(invalid).is_err());
		}
	}
}
