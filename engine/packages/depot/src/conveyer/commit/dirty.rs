use anyhow::{Context, Result};
use universaldb::utils::IsolationLevel::Serializable;

use crate::{
	conveyer::{
		keys, quota,
		types::{
			CompactionRoot, DatabaseBranchId, SqliteCmpDirty, decode_compaction_root,
			decode_db_head, decode_sqlite_cmp_dirty, encode_sqlite_cmp_dirty,
		},
		udb,
	},
	workflows::compaction::DeltasAvailable,
};

use super::helpers::tx_get_value;

pub(crate) const DIRTY_RECONCILE_INITIAL_DELAY_MS: i64 = 30_000;

fn dirty_reconcile_retry_base_delay_ms(attempt: u8) -> i64 {
	match attempt {
		0 => DIRTY_RECONCILE_INITIAL_DELAY_MS,
		1 => 2 * 60_000,
		2 => 10 * 60_000,
		_ => 60 * 60_000,
	}
}

/// Keep the durable retry queue from turning synchronized Agent writes into a Cell-wide FDB
/// refresh wave. The delay remains bounded to 50%..150% of the policy value, while an immutable
/// branch id and retry level make the phase deterministic across Engine restarts.
pub(crate) fn dirty_reconcile_retry_delay_ms(branch_id: DatabaseBranchId, attempt: u8) -> i64 {
	let base_delay_ms = dirty_reconcile_retry_base_delay_ms(attempt);
	let mut hash = 0xcbf29ce484222325_u64 ^ 0x64 ^ u64::from(attempt);
	for byte in branch_id.as_uuid().as_bytes() {
		hash ^= u64::from(*byte);
		hash = hash.wrapping_mul(0x100000001b3);
	}
	let half = base_delay_ms / 2;
	let width = u64::try_from(base_delay_ms).expect("positive dirty reconcile delay");
	base_delay_ms - half + i64::try_from(hash % width).expect("dirty reconcile delay fits i64")
}

pub(crate) async fn schedule_dirty_reconcile_tx(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	dirty_updated_at_ms: i64,
	due_at_ms: i64,
	attempt: u8,
) -> Result<()> {
	let locator_key = keys::sqlite_cmp_dirty_due_locator_key(branch_id);
	if let Some(previous_due_key) = tx_get_value(tx, &locator_key, Serializable).await? {
		let (_, located_branch_id, _, _) = keys::decode_sqlite_cmp_dirty_due_key(&previous_due_key)
			.context("decode sqlite compaction dirty due locator")?;
		anyhow::ensure!(
			located_branch_id == branch_id,
			"sqlite compaction dirty due locator belongs to another branch"
		);
		// One locator owns one durable retry deadline for the whole dirty epoch. Commits may update
		// the dirty marker while compaction is in flight, but moving this deadline on every write
		// lets a continuously-active branch postpone recovery forever and turns every commit into
		// two extra FDB mutations. The reconciler reads the latest dirty marker when this immutable
		// deadline becomes due.
		return Ok(());
	}
	let due_key =
		keys::sqlite_cmp_dirty_due_key(due_at_ms, branch_id, dirty_updated_at_ms, attempt);
	tx.informal().set(&due_key, &[]);
	tx.informal().set(&locator_key, &due_key);
	Ok(())
}

pub(crate) async fn clear_dirty_reconcile_schedule_tx(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
) -> Result<()> {
	let locator_key = keys::sqlite_cmp_dirty_due_locator_key(branch_id);
	if let Some(due_key) = tx_get_value(tx, &locator_key, Serializable).await? {
		let (_, located_branch_id, _, _) = keys::decode_sqlite_cmp_dirty_due_key(&due_key)
			.context("decode sqlite compaction dirty due locator while clearing")?;
		anyhow::ensure!(
			located_branch_id == branch_id,
			"sqlite compaction dirty due locator belongs to another branch"
		);
		tx.informal().clear(&due_key);
	}
	tx.informal().clear(&locator_key);
	Ok(())
}

pub(super) async fn admit_deltas_available(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	head_txid: u64,
	compaction_root: Option<&CompactionRoot>,
	_fallback_compaction_watermark_txid: u64,
	now_ms: i64,
	write_debt_requires_compaction: bool,
) -> Result<Option<DeltasAvailable>> {
	if !has_actionable_lag(branch_id, head_txid, compaction_root) && !write_debt_requires_compaction
	{
		return Ok(None);
	}

	let dirty_key = keys::sqlite_cmp_dirty_key(branch_id);
	let previous_dirty = tx_get_value(tx, &dirty_key, Serializable)
		.await?
		.as_deref()
		.map(decode_sqlite_cmp_dirty)
		.transpose()
		.context("decode sqlite compaction dirty marker")?;
	let dirty = SqliteCmpDirty {
		observed_head_txid: head_txid,
		updated_at_ms: now_ms,
	};
	let encoded_dirty =
		encode_sqlite_cmp_dirty(dirty.clone()).context("encode sqlite compaction dirty marker")?;
	tx.informal().set(&dirty_key, &encoded_dirty);
	schedule_dirty_reconcile_tx(
		tx,
		branch_id,
		dirty.updated_at_ms,
		now_ms.saturating_add(dirty_reconcile_retry_delay_ms(branch_id, 0)),
		0,
	)
	.await?;

	let first_dirty_writer = previous_dirty.is_none();
	// The foreground path gives a dirty epoch one low-latency wake. It must not emit another
	// durable Gasoline signal for every later SQLite commit: under sustained writes those signals
	// make a slow compactor generate more manager refresh work than it can drain. The branch-local
	// due locator above is the retry owner and remains scheduled while the dirty marker advances.
	if first_dirty_writer {
		Ok(Some(DeltasAvailable {
			database_branch_id: branch_id,
			observed_head_txid: dirty.observed_head_txid,
			dirty_updated_at_ms: dirty.updated_at_ms,
		}))
	} else {
		Ok(None)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn dirty_reconcile_delays_are_stable_bounded_and_branch_staggered() {
		let branch = DatabaseBranchId::from_uuid(uuid::Uuid::from_u128(1));
		for attempt in 0..=4 {
			let base = dirty_reconcile_retry_base_delay_ms(attempt);
			let delay = dirty_reconcile_retry_delay_ms(branch, attempt);
			assert_eq!(delay, dirty_reconcile_retry_delay_ms(branch, attempt));
			assert!((base / 2..base * 3 / 2).contains(&delay));
		}

		let alternate = DatabaseBranchId::from_uuid(uuid::Uuid::from_u128(2));
		assert_ne!(
			dirty_reconcile_retry_delay_ms(branch, 2),
			dirty_reconcile_retry_delay_ms(alternate, 2),
		);

		for attempt in 0..=4 {
			let mut delays = (0..256_u128)
				.map(|value| {
					dirty_reconcile_retry_delay_ms(
						DatabaseBranchId::from_uuid(uuid::Uuid::from_u128(value)),
						attempt,
					)
				})
				.collect::<Vec<_>>();
			delays.sort_unstable();
			delays.dedup();
			assert!(
				delays.len() >= 128,
				"attempt {attempt} collapsed branch phases"
			);
			assert!(
				delays.last().unwrap() - delays.first().unwrap()
					> dirty_reconcile_retry_base_delay_ms(attempt) / 2,
				"attempt {attempt} does not spread retries broadly enough"
			);
		}
	}
}

fn has_actionable_lag(
	branch_id: DatabaseBranchId,
	head_txid: u64,
	compaction_root: Option<&CompactionRoot>,
) -> bool {
	let hot_watermark_txid = compaction_root.map_or(0, |root| root.hot_watermark_txid);
	let hot_lag = head_txid.saturating_sub(hot_watermark_txid);

	hot_lag >= quota::compaction_delta_threshold(branch_id)
}

pub async fn clear_sqlite_cmp_dirty_if_observed_idle(
	db: &universaldb::Database,
	branch_id: DatabaseBranchId,
	observed_dirty: SqliteCmpDirty,
) -> Result<bool> {
	db.txn("depot_clear_compaction_dirty", move |tx| {
		let observed_dirty = observed_dirty.clone();
		async move {
			let dirty_key = keys::sqlite_cmp_dirty_key(branch_id);
			let expected_dirty = encode_sqlite_cmp_dirty(observed_dirty.clone())
				.context("encode observed sqlite compaction dirty marker")?;
			let Some(current_dirty) = tx_get_value(&tx, &dirty_key, Serializable).await? else {
				return Ok(false);
			};
			if current_dirty != expected_dirty {
				return Ok(false);
			}
			if branch_has_actionable_lag(&tx, branch_id).await? {
				return Ok(false);
			}

			udb::compare_and_clear(&tx, &dirty_key, &expected_dirty);
			clear_dirty_reconcile_schedule_tx(&tx, branch_id).await?;
			Ok(true)
		}
	})
	.await
}

async fn branch_has_actionable_lag(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
) -> Result<bool> {
	let head_txid = tx_get_value(tx, &keys::branch_meta_head_key(branch_id), Serializable)
		.await?
		.as_deref()
		.map(decode_db_head)
		.transpose()
		.context("decode sqlite db head for dirty clear")?
		.map_or(0, |head| head.head_txid);
	let compaction_root = tx_get_value(
		tx,
		&keys::branch_compaction_root_key(branch_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_compaction_root)
	.transpose()
	.context("decode sqlite compaction root for dirty clear")?
	.context(
		"sqlite compaction root missing for dirty clear; \
			workflow manager must publish CMP/root before clearing dirty marker",
	)?;
	Ok(has_actionable_lag(
		branch_id,
		head_txid,
		Some(&compaction_root),
	))
}
