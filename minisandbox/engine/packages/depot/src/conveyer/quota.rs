use anyhow::{Context, Error, Result, ensure};
use futures_util::{StreamExt, TryStreamExt, stream};
use universaldb::{
	options::MutationType,
	utils::IsolationLevel::{Serializable, Snapshot},
};

use crate::conveyer::{
	branch,
	error::SqliteStorageError,
	keys,
	types::{BucketId, DatabaseBranchId},
};

/// Target maximum per-branch FDB write debt. Crossing this watermark wakes compaction; it is also
/// the small, stable threshold used to qualify that logical SQLite size is independent of FDB.
///
/// This is deliberately not a logical SQLite size quota. The counter covers authoritative rows
/// that hot compaction and reclaim can remove (commit/VTX/delta/PIDX/page-history metadata). It
/// excludes immutable cold objects and derived hot-shard cache rows, so a branch can retain more
/// logical data in the cold tier than this transient FDB safety budget.
pub const FDB_WRITE_DEBT_TARGET_BYTES: i64 = 10 * 1024 * 1024;
/// Admission retains enough room above the 10 MiB target for one maximum legal 320-page commit
/// plus FDB keys and metadata. Without this headroom, a valid commit can deadlock exactly while
/// compaction is trying to converge a full 10 MiB logical database.
pub const FDB_WRITE_DEBT_COMMIT_HEADROOM_BYTES: i64 = 2 * 1024 * 1024;
pub const FDB_WRITE_DEBT_LIMIT_BYTES: i64 =
	FDB_WRITE_DEBT_TARGET_BYTES + FDB_WRITE_DEBT_COMMIT_HEADROOM_BYTES;
/// Wake compaction well before a branch reaches the write-debt backpressure boundary. This is
/// required when the qualification budget is deliberately small: a few maximum-sized commits can
/// consume 10 MiB before the normal txid-lag trigger reaches its threshold.
pub const FDB_WRITE_DEBT_COMPACTION_PERCENT: i64 = 50;

/// Bottomless Depot has no fixed product-level logical byte limit. SQLite's u32 page-number space
/// remains the physical format boundary, and operators may still close Cell admission based on
/// aggregate capacity/SLO signals.
pub const LOGICAL_STORAGE_LIMIT_BYTES: Option<u64> = None;
/// Mean number of committed deltas retained before hot compaction becomes actionable.
///
/// The exact threshold is deterministically staggered per branch. A fixed threshold makes a
/// cohort of periodically-writing actors reach compaction at the same instant even when cold and
/// reclaim timers are staggered, producing a Cell-wide FDB conflict wave.
pub const COMPACTION_DELTA_THRESHOLD: u64 = 128;
const COMPACTION_DELTA_THRESHOLD_JITTER: u64 = 32;
pub const TRIGGER_THROTTLE_MS: u64 = 500;
pub const TRIGGER_MAX_SILENCE_MS: u64 = 30_000;

const PIDX_COUNT_RADIX_LEVELS: u8 = 5;
const PIDX_COUNT_INDEX_SCHEMA_VERSION: u8 = 1;
const PIDX_COUNT_READ_CONCURRENCY: usize = 32;
const PGNO_SPACE_END: u64 = 1_u64 << 32;

/// Returns the immutable hot-compaction threshold for one branch.
///
/// The inclusive 96..=160 range preserves 128 as the exact population mean while spreading a
/// synchronized ten-second writer cohort across roughly eleven minutes. This changes only when a
/// branch first becomes actionable; persisted compaction generations and wire formats are
/// unaffected.
pub fn compaction_delta_threshold(branch_id: DatabaseBranchId) -> u64 {
	let mut hash = 0xcbf29ce484222325_u64 ^ 0x68;
	for byte in branch_id.as_uuid().as_bytes() {
		hash ^= u64::from(*byte);
		hash = hash.wrapping_mul(0x100000001b3);
	}
	let width = COMPACTION_DELTA_THRESHOLD_JITTER * 2 + 1;
	COMPACTION_DELTA_THRESHOLD - COMPACTION_DELTA_THRESHOLD_JITTER + hash % width
}

#[derive(Debug)]
pub(crate) struct PidxCountSuffixClearPlan {
	pub(crate) removed_rows: i64,
	clear_begin: Vec<u8>,
	clear_end: Vec<u8>,
	boundary_adjustments: Vec<(Vec<u8>, i64)>,
}

#[derive(Debug, Clone, Copy)]
struct PidxCountNode {
	start_pgno: u32,
	level: u8,
	end_exclusive: u64,
}

pub fn atomic_add(tx: &universaldb::Transaction, database_id: &str, delta_bytes: i64) {
	tx.informal().atomic_op(
		&keys::meta_quota_key(database_id),
		&delta_bytes.to_le_bytes(),
		MutationType::Add,
	);
}

pub fn atomic_add_branch(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	delta_bytes: i64,
) {
	tx.informal().atomic_op(
		&keys::branch_meta_quota_key(branch_id),
		&delta_bytes.to_le_bytes(),
		MutationType::Add,
	);
	crate::cold_tier::accounting::apply_delta_for_branch(
		tx,
		branch_id,
		crate::cold_tier::accounting::ColdStorageAccountingDelta {
			fdb_authoritative_bytes: delta_bytes,
			..Default::default()
		},
	);
}

pub(crate) async fn ensure_pidx_count_index_initialized(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
) -> Result<()> {
	let complete_key = keys::branch_pidx_count_index_complete_key(branch_id);
	let value = tx
		.informal()
		.get(&complete_key, Serializable)
		.await?
		.context("sqlite PIDX count index is not initialized")?;
	ensure!(
		value.as_ref() == [PIDX_COUNT_INDEX_SCHEMA_VERSION],
		"sqlite PIDX count index has an unsupported schema version"
	);
	Ok(())
}

pub(crate) fn initialize_pidx_count_index(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
) {
	tx.informal().set(
		&keys::branch_pidx_count_index_complete_key(branch_id),
		&[PIDX_COUNT_INDEX_SCHEMA_VERSION],
	);
}

pub(crate) fn atomic_add_pidx_row_count(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	pgno: u32,
	delta: i64,
) {
	if delta == 0 {
		return;
	}
	for level in 0..PIDX_COUNT_RADIX_LEVELS {
		let span = 1_u64 << (u32::from(level) * 8);
		let start_pgno = (u64::from(pgno) / span) * span;
		let start_pgno = u32::try_from(start_pgno).expect("PIDX node start fits u32");
		tx.informal().atomic_op(
			&keys::branch_pidx_count_node_key(branch_id, start_pgno, level),
			&delta.to_le_bytes(),
			MutationType::Add,
		);
	}
}

pub(crate) async fn plan_pidx_count_suffix_clear(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	first_removed_pgno: u32,
) -> Result<PidxCountSuffixClearPlan> {
	ensure_pidx_count_index_initialized(tx, branch_id).await?;
	let nodes = decompose_pgno_suffix(first_removed_pgno);
	let counts = stream::iter(nodes.iter().copied())
		.map(|node| async move {
			let value = tx
				.informal()
				.get(
					&keys::branch_pidx_count_node_key(branch_id, node.start_pgno, node.level),
					Serializable,
				)
				.await?;
			let count = value
				.map(|value| decode_pidx_count(value.as_ref()))
				.transpose()?
				.unwrap_or(0);
			ensure!(count >= 0, "sqlite PIDX count node became negative");
			Ok::<_, anyhow::Error>((node, count))
		})
		.buffer_unordered(PIDX_COUNT_READ_CONCURRENCY)
		.try_collect::<Vec<_>>()
		.await?;
	let removed_rows = counts.iter().try_fold(0_i64, |total, (_, count)| {
		total
			.checked_add(*count)
			.context("PIDX suffix count overflowed")
	})?;

	let mut boundary_adjustments = Vec::new();
	for level in 1..PIDX_COUNT_RADIX_LEVELS {
		let span = 1_u64 << (u32::from(level) * 8);
		let boundary_start = (u64::from(first_removed_pgno) / span) * span;
		if boundary_start == u64::from(first_removed_pgno) {
			continue;
		}
		let boundary_end = boundary_start + span;
		let removed_inside = counts
			.iter()
			.filter(|(node, _)| node.end_exclusive <= boundary_end)
			.try_fold(0_i64, |total, (_, count)| {
				total
					.checked_add(*count)
					.context("PIDX boundary count overflowed")
			})?;
		if removed_inside != 0 {
			boundary_adjustments.push((
				keys::branch_pidx_count_node_key(
					branch_id,
					u32::try_from(boundary_start).expect("boundary start fits u32"),
					level,
				),
				removed_inside
					.checked_neg()
					.context("PIDX boundary count negation overflowed")?,
			));
		}
	}

	let prefix = keys::branch_pidx_count_node_prefix(branch_id);
	let mut clear_begin = prefix.clone();
	clear_begin.extend_from_slice(&first_removed_pgno.to_be_bytes());
	let clear_end = universaldb::utils::end_of_prefix_range(&prefix);
	Ok(PidxCountSuffixClearPlan {
		removed_rows,
		clear_begin,
		clear_end,
		boundary_adjustments,
	})
}

pub(crate) fn apply_pidx_count_suffix_clear(
	tx: &universaldb::Transaction,
	plan: &PidxCountSuffixClearPlan,
) {
	tx.informal()
		.clear_range(&plan.clear_begin, &plan.clear_end);
	for (key, delta) in &plan.boundary_adjustments {
		tx.informal()
			.atomic_op(key, &delta.to_le_bytes(), MutationType::Add);
	}
}

fn decode_pidx_count(value: &[u8]) -> Result<i64> {
	let bytes: [u8; std::mem::size_of::<i64>()] = value.try_into().map_err(|_| {
		Error::msg(format!(
			"sqlite PIDX count node had {} bytes, expected 8",
			value.len()
		))
	})?;
	Ok(i64::from_le_bytes(bytes))
}

fn decompose_pgno_suffix(first_removed_pgno: u32) -> Vec<PidxCountNode> {
	let mut cursor = u64::from(first_removed_pgno);
	let mut nodes = Vec::new();
	while cursor < PGNO_SPACE_END {
		let mut selected_level = 0_u8;
		for level in (0..PIDX_COUNT_RADIX_LEVELS).rev() {
			let span = 1_u64 << (u32::from(level) * 8);
			if cursor % span == 0 && cursor.saturating_add(span) <= PGNO_SPACE_END {
				selected_level = level;
				break;
			}
		}
		let span = 1_u64 << (u32::from(selected_level) * 8);
		nodes.push(PidxCountNode {
			start_pgno: u32::try_from(cursor).expect("PIDX node start fits u32"),
			level: selected_level,
			end_exclusive: cursor + span,
		});
		cursor += span;
	}
	nodes
}

#[cfg(feature = "test-faults")]
pub async fn seed_pidx_count_index_for_test(
	db: &universaldb::Database,
	branch_id: DatabaseBranchId,
	pgnos: Vec<u32>,
) -> Result<()> {
	db.txn("test_seed_pidx_count_index", move |tx| {
		let pgnos = pgnos.clone();
		async move {
			initialize_pidx_count_index(&tx, branch_id);
			for pgno in pgnos {
				atomic_add_pidx_row_count(&tx, branch_id, pgno, 1);
			}
			Ok(())
		}
	})
	.await
}

#[cfg(feature = "test-faults")]
pub async fn clear_pidx_count_suffix_for_test(
	db: &universaldb::Database,
	branch_id: DatabaseBranchId,
	first_removed_pgno: u32,
) -> Result<i64> {
	db.txn("test_clear_pidx_count_suffix", move |tx| async move {
		let plan = plan_pidx_count_suffix_clear(&tx, branch_id, first_removed_pgno).await?;
		let removed_rows = plan.removed_rows;
		apply_pidx_count_suffix_clear(&tx, &plan);
		Ok(removed_rows)
	})
	.await
}

pub async fn read(tx: &universaldb::Transaction, database_id: &str) -> Result<i64> {
	read_in_bucket(tx, BucketId::nil(), database_id).await
}

pub async fn read_in_bucket(
	tx: &universaldb::Transaction,
	bucket_id: BucketId,
	database_id: &str,
) -> Result<i64> {
	if let Some(branch_id) = branch::resolve_database_branch(tx, bucket_id, database_id, Snapshot)
		.await
		.context("resolve sqlite database branch for quota read")?
	{
		return read_branch(tx, branch_id).await;
	}

	let Some(value) = tx
		.informal()
		.get(&keys::meta_quota_key(database_id), Snapshot)
		.await?
	else {
		return Ok(0);
	};

	let bytes: [u8; std::mem::size_of::<i64>()] =
		Vec::from(value).try_into().map_err(|value: Vec<u8>| {
			Error::msg(format!(
				"sqlite quota counter had {} bytes, expected {}",
				value.len(),
				std::mem::size_of::<i64>()
			))
		})?;

	Ok(i64::from_le_bytes(bytes))
}

pub async fn read_branch(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
) -> Result<i64> {
	let Some(value) = tx
		.informal()
		.get(&keys::branch_meta_quota_key(branch_id), Snapshot)
		.await?
	else {
		return Ok(0);
	};

	let bytes: [u8; std::mem::size_of::<i64>()] =
		Vec::from(value).try_into().map_err(|value: Vec<u8>| {
			Error::msg(format!(
				"sqlite branch quota counter had {} bytes, expected {}",
				value.len(),
				std::mem::size_of::<i64>()
			))
		})?;

	Ok(i64::from_le_bytes(bytes))
}

pub fn logical_size_bytes(db_size_pages: u32) -> u64 {
	u64::from(db_size_pages) * u64::from(keys::PAGE_SIZE)
}

pub fn write_debt_requires_compaction(write_debt_bytes: i64) -> bool {
	write_debt_requires_compaction_with_target(write_debt_bytes, FDB_WRITE_DEBT_TARGET_BYTES)
}

pub fn write_debt_requires_compaction_with_target(
	write_debt_bytes: i64,
	target_bytes: i64,
) -> bool {
	write_debt_bytes >= target_bytes.saturating_mul(FDB_WRITE_DEBT_COMPACTION_PERCENT) / 100
}

pub fn write_debt_check(would_be: i64) -> Result<()> {
	write_debt_check_with_limit(would_be, FDB_WRITE_DEBT_LIMIT_BYTES)
}

pub fn write_debt_check_with_limit(would_be: i64, limit_bytes: i64) -> Result<()> {
	if would_be > limit_bytes {
		return Err(SqliteStorageError::SqliteWriteBackpressure {
			write_debt_bytes: would_be,
			limit_bytes,
			retry_after_ms: TRIGGER_THROTTLE_MS,
		}
		.into());
	}

	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn hot_compaction_threshold_is_stable_bounded_and_branch_staggered() {
		let branch = DatabaseBranchId::from_uuid(uuid::Uuid::from_u128(1));
		assert_eq!(
			compaction_delta_threshold(branch),
			compaction_delta_threshold(branch)
		);

		let mut thresholds = (0..4096_u128)
			.map(|value| {
				compaction_delta_threshold(DatabaseBranchId::from_uuid(uuid::Uuid::from_u128(
					value,
				)))
			})
			.collect::<Vec<_>>();
		assert_eq!(
			thresholds.iter().copied().min(),
			Some(COMPACTION_DELTA_THRESHOLD - COMPACTION_DELTA_THRESHOLD_JITTER)
		);
		assert_eq!(
			thresholds.iter().copied().max(),
			Some(COMPACTION_DELTA_THRESHOLD + COMPACTION_DELTA_THRESHOLD_JITTER)
		);
		let mean = thresholds.iter().copied().sum::<u64>() as f64 / thresholds.len() as f64;
		assert!((mean - COMPACTION_DELTA_THRESHOLD as f64).abs() < 1.0);
		thresholds.sort_unstable();
		thresholds.dedup();
		assert_eq!(
			thresholds.len() as u64,
			COMPACTION_DELTA_THRESHOLD_JITTER * 2 + 1
		);
	}
}
