use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use universaldb::utils::IsolationLevel::Serializable;

use crate::{
	keys,
	types::{
		BranchColdGcQueueEntry, DatabaseBranchId, decode_branch_cold_gc_queue_entry,
		encode_branch_cold_gc_queue_entry,
	},
};

pub const BRANCH_COLD_GC_RETRY_BASE_MS: i64 = 60_000;
pub const BRANCH_COLD_GC_RETRY_MAX_MS: i64 = 24 * 60 * 60 * 1_000;
pub const BRANCH_COLD_GC_DISPATCH_LEASE_MS: i64 = 5 * 60 * 1_000;

pub async fn enqueue_branch_cold_gc_tx(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
	tombstoned_at_ms: i64,
	tombstone_versionstamp: [u8; 16],
	due_at_ms: i64,
) -> Result<BranchColdGcQueueEntry> {
	if let Some(existing) = read_locator_tx(tx, database_branch_id).await? {
		ensure!(
			existing.tombstoned_at_ms == tombstoned_at_ms
				&& existing.tombstone_versionstamp == tombstone_versionstamp,
			"branch cold GC tombstone identity changed"
		);
		let row = tx
			.informal()
			.get(
				&keys::branch_cold_gc_queue_key(database_branch_id, existing.due_at_ms),
				Serializable,
			)
			.await?
			.map(|value| decode_branch_cold_gc_queue_entry(&value))
			.transpose()
			.context("decode existing branch cold GC due row")?;
		if row.as_ref() == Some(&existing) {
			return Ok(existing);
		}
		tx.informal()
			.clear(&keys::branch_cold_gc_queue_locator_key(database_branch_id));
	}

	let entry = BranchColdGcQueueEntry {
		database_branch_id,
		tombstoned_at_ms,
		tombstone_versionstamp,
		due_at_ms,
		attempt_count: 0,
	};
	write_entry(tx, &entry)?;
	Ok(entry)
}

pub async fn clear_branch_cold_gc_queue_tx(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
) -> Result<()> {
	let Some(existing) = read_locator_tx(tx, database_branch_id).await? else {
		return Ok(());
	};
	tx.informal().clear(&keys::branch_cold_gc_queue_key(
		database_branch_id,
		existing.due_at_ms,
	));
	tx.informal()
		.clear(&keys::branch_cold_gc_queue_locator_key(database_branch_id));
	Ok(())
}

pub async fn defer_branch_cold_gc_tx(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
	now_ms: i64,
) -> Result<Option<BranchColdGcQueueEntry>> {
	let Some(existing) = read_locator_tx(tx, database_branch_id).await? else {
		return Ok(None);
	};
	tx.informal().clear(&keys::branch_cold_gc_queue_key(
		database_branch_id,
		existing.due_at_ms,
	));
	let attempt_count = existing.attempt_count.saturating_add(1);
	let entry = BranchColdGcQueueEntry {
		database_branch_id,
		tombstoned_at_ms: existing.tombstoned_at_ms,
		tombstone_versionstamp: existing.tombstone_versionstamp,
		due_at_ms: now_ms.saturating_add(branch_cold_gc_retry_delay_ms(
			database_branch_id,
			attempt_count,
		)),
		attempt_count,
	};
	write_entry(tx, &entry)?;
	Ok(Some(entry))
}

pub async fn lease_branch_cold_gc_queue_entry_tx(
	tx: &universaldb::Transaction,
	expected: &BranchColdGcQueueEntry,
	now_ms: i64,
) -> Result<bool> {
	let row_key = keys::branch_cold_gc_queue_key(expected.database_branch_id, expected.due_at_ms);
	let Some(row_value) = tx.informal().get(&row_key, Serializable).await? else {
		return Ok(false);
	};
	let row = decode_branch_cold_gc_queue_entry(&row_value)
		.context("decode branch cold GC due row before lease")?;
	if row != *expected {
		return Ok(false);
	}
	if read_locator_tx(tx, expected.database_branch_id)
		.await?
		.as_ref()
		!= Some(expected)
	{
		tx.informal().clear(&row_key);
		return Ok(false);
	}

	let mut leased = expected.clone();
	leased.due_at_ms = now_ms.saturating_add(BRANCH_COLD_GC_DISPATCH_LEASE_MS);
	tx.informal().clear(&row_key);
	write_entry(tx, &leased)?;
	Ok(true)
}

pub async fn read_branch_cold_gc_queue_entry(
	db: &universaldb::Database,
	database_branch_id: DatabaseBranchId,
) -> Result<Option<BranchColdGcQueueEntry>> {
	db.txn(
		"depot_read_branch_cold_gc_queue_entry",
		move |tx| async move { read_locator_tx(&tx, database_branch_id).await },
	)
	.await
}

pub fn branch_cold_gc_retry_delay_ms(
	database_branch_id: DatabaseBranchId,
	attempt_count: u16,
) -> i64 {
	let exponent = u32::from(attempt_count.saturating_sub(1).min(20));
	let base = BRANCH_COLD_GC_RETRY_BASE_MS
		.saturating_mul(1_i64.checked_shl(exponent).unwrap_or(i64::MAX))
		.min(BRANCH_COLD_GC_RETRY_MAX_MS);
	let mut hasher = Sha256::new();
	hasher.update(database_branch_id.as_uuid().as_bytes());
	hasher.update(attempt_count.to_be_bytes());
	let digest = hasher.finalize();
	let jitter_percent = 90 + i64::from(u16::from_be_bytes([digest[0], digest[1]]) % 21);
	base.saturating_mul(jitter_percent)
		.saturating_div(100)
		.min(BRANCH_COLD_GC_RETRY_MAX_MS)
}

async fn read_locator_tx(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
) -> Result<Option<BranchColdGcQueueEntry>> {
	let entry = tx
		.informal()
		.get(
			&keys::branch_cold_gc_queue_locator_key(database_branch_id),
			Serializable,
		)
		.await?
		.map(|value| decode_branch_cold_gc_queue_entry(&value))
		.transpose()
		.context("decode branch cold GC queue locator")?;
	if let Some(entry) = entry.as_ref() {
		ensure!(
			entry.database_branch_id == database_branch_id,
			"branch cold GC queue locator points to another branch"
		);
	}
	Ok(entry)
}

fn write_entry(tx: &universaldb::Transaction, entry: &BranchColdGcQueueEntry) -> Result<()> {
	let encoded = encode_branch_cold_gc_queue_entry(entry.clone())?;
	tx.informal().set(
		&keys::branch_cold_gc_queue_key(entry.database_branch_id, entry.due_at_ms),
		&encoded,
	);
	tx.informal().set(
		&keys::branch_cold_gc_queue_locator_key(entry.database_branch_id),
		&encoded,
	);
	Ok(())
}
