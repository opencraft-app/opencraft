use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use universaldb::utils::IsolationLevel::Serializable;

use crate::conveyer::{
	keys,
	types::{
		BranchGcQueueEntry, DatabaseBranchId, decode_branch_gc_queue_entry,
		encode_branch_gc_queue_entry,
	},
};

pub const BRANCH_GC_RETRY_BASE_MS: i64 = 60_000;
pub const BRANCH_GC_RETRY_MAX_MS: i64 = 24 * 60 * 60 * 1_000;
pub const BRANCH_GC_DISPATCH_LEASE_MS: i64 = 5 * 60 * 1_000;

pub async fn enqueue_branch_gc_tx(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
	requested_at_ms: i64,
) -> Result<BranchGcQueueEntry> {
	if let Some(existing) = read_locator_tx(tx, database_branch_id).await? {
		let row = tx
			.informal()
			.get(
				&keys::branch_gc_queue_key(database_branch_id, existing.due_at_ms),
				Serializable,
			)
			.await?
			.map(|value| decode_branch_gc_queue_entry(&value))
			.transpose()
			.context("decode existing sqlite branch GC due row")?;
		if row.as_ref() == Some(&existing) {
			return Ok(existing);
		}
		// A locator without its matching due row cannot make progress. Repair it through the same
		// serializable transaction instead of requiring a global orphan scan.
		tx.informal()
			.clear(&keys::branch_gc_queue_locator_key(database_branch_id));
	}

	let entry = BranchGcQueueEntry {
		database_branch_id,
		requested_at_ms,
		due_at_ms: requested_at_ms,
		attempt_count: 0,
	};
	write_entry(tx, &entry)?;
	Ok(entry)
}

pub async fn clear_branch_gc_queue_tx(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
) -> Result<()> {
	let Some(existing) = read_locator_tx(tx, database_branch_id).await? else {
		return Ok(());
	};
	tx.informal().clear(&keys::branch_gc_queue_key(
		database_branch_id,
		existing.due_at_ms,
	));
	tx.informal()
		.clear(&keys::branch_gc_queue_locator_key(database_branch_id));
	Ok(())
}

pub async fn defer_branch_gc_tx(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
	now_ms: i64,
) -> Result<BranchGcQueueEntry> {
	let existing = read_locator_tx(tx, database_branch_id).await?;
	if let Some(existing) = existing.as_ref() {
		tx.informal().clear(&keys::branch_gc_queue_key(
			database_branch_id,
			existing.due_at_ms,
		));
	}
	let attempt_count = existing
		.as_ref()
		.map_or(1, |entry| entry.attempt_count.saturating_add(1));
	let requested_at_ms = existing
		.as_ref()
		.map_or(now_ms, |entry| entry.requested_at_ms);
	let delay_ms = branch_gc_retry_delay_ms(database_branch_id, attempt_count);
	let entry = BranchGcQueueEntry {
		database_branch_id,
		requested_at_ms,
		due_at_ms: now_ms.saturating_add(delay_ms),
		attempt_count,
	};
	write_entry(tx, &entry)?;
	Ok(entry)
}

/// Moves a dispatched entry out of the due window. The branch workflow either clears the locator
/// while installing its deletion fence or replaces it with an exponentially backed-off entry.
/// If the workflow never runs, the lease expiry makes the durable request visible again.
pub async fn lease_branch_gc_queue_entry_tx(
	tx: &universaldb::Transaction,
	expected: &BranchGcQueueEntry,
	now_ms: i64,
) -> Result<bool> {
	let row_key = keys::branch_gc_queue_key(expected.database_branch_id, expected.due_at_ms);
	let Some(row_value) = tx.informal().get(&row_key, Serializable).await? else {
		return Ok(false);
	};
	let row = decode_branch_gc_queue_entry(&row_value)
		.context("decode sqlite branch GC due row before lease")?;
	if row != *expected {
		return Ok(false);
	}
	let locator = read_locator_tx(tx, expected.database_branch_id).await?;
	if locator.as_ref() != Some(expected) {
		// This row lost ownership to a newer locator. Clear only the exact stale value that was
		// scanned; concurrent changes conflict with the serializable read above.
		tx.informal().clear(&row_key);
		return Ok(false);
	}

	let mut leased = expected.clone();
	leased.due_at_ms = now_ms.saturating_add(BRANCH_GC_DISPATCH_LEASE_MS);
	tx.informal().clear(&row_key);
	write_entry(tx, &leased)?;
	Ok(true)
}

/// Makes a queued branch immediately visible after a pin or parent reference is released. This is
/// an exact locator update, not a scan, so long exponential backoff does not delay normal cleanup.
pub async fn expedite_branch_gc_if_queued_tx(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
	now_ms: i64,
) -> Result<bool> {
	let Some(mut existing) = read_locator_tx(tx, database_branch_id).await? else {
		return Ok(false);
	};
	if existing.due_at_ms <= now_ms {
		return Ok(false);
	}
	tx.informal().clear(&keys::branch_gc_queue_key(
		database_branch_id,
		existing.due_at_ms,
	));
	existing.due_at_ms = now_ms;
	write_entry(tx, &existing)?;
	Ok(true)
}

pub async fn read_branch_gc_queue_entry(
	db: &universaldb::Database,
	database_branch_id: DatabaseBranchId,
) -> Result<Option<BranchGcQueueEntry>> {
	db.txn("depot_read_branch_gc_queue_entry", move |tx| async move {
		read_locator_tx(&tx, database_branch_id).await
	})
	.await
}

pub fn branch_gc_retry_delay_ms(database_branch_id: DatabaseBranchId, attempt_count: u16) -> i64 {
	let exponent = u32::from(attempt_count.saturating_sub(1).min(20));
	let base = BRANCH_GC_RETRY_BASE_MS
		.saturating_mul(1_i64.checked_shl(exponent).unwrap_or(i64::MAX))
		.min(BRANCH_GC_RETRY_MAX_MS);
	let mut hasher = Sha256::new();
	hasher.update(database_branch_id.as_uuid().as_bytes());
	hasher.update(attempt_count.to_be_bytes());
	let digest = hasher.finalize();
	let jitter_percent = 90 + i64::from(u16::from_be_bytes([digest[0], digest[1]]) % 21);
	base.saturating_mul(jitter_percent)
		.saturating_div(100)
		.min(BRANCH_GC_RETRY_MAX_MS)
}

async fn read_locator_tx(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
) -> Result<Option<BranchGcQueueEntry>> {
	let entry = tx
		.informal()
		.get(
			&keys::branch_gc_queue_locator_key(database_branch_id),
			Serializable,
		)
		.await?
		.map(|value| decode_branch_gc_queue_entry(&value))
		.transpose()
		.context("decode sqlite branch GC queue locator")?;
	if let Some(entry) = entry.as_ref() {
		ensure!(
			entry.database_branch_id == database_branch_id,
			"sqlite branch GC queue locator points to another branch"
		);
	}
	Ok(entry)
}

fn write_entry(tx: &universaldb::Transaction, entry: &BranchGcQueueEntry) -> Result<()> {
	let encoded = encode_branch_gc_queue_entry(entry.clone())?;
	tx.informal().set(
		&keys::branch_gc_queue_key(entry.database_branch_id, entry.due_at_ms),
		&encoded,
	);
	tx.informal().set(
		&keys::branch_gc_queue_locator_key(entry.database_branch_id),
		&encoded,
	);
	Ok(())
}
