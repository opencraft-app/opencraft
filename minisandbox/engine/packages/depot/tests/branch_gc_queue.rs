mod common;

use anyhow::Result;
use depot::{
	gc::{
		BRANCH_GC_DISPATCH_LEASE_MS, BRANCH_GC_RETRY_BASE_MS, BRANCH_GC_RETRY_MAX_MS,
		branch_gc_retry_delay_ms, clear_branch_gc_queue_tx, defer_branch_gc_tx,
		enqueue_branch_gc_tx, expedite_branch_gc_if_queued_tx, lease_branch_gc_queue_entry_tx,
		read_branch_gc_queue_entry,
	},
	keys::{
		branch_gc_queue_key, branch_gc_queue_locator_key, branch_gc_queue_shard,
		branch_gc_queue_shard_prefix,
	},
	types::{BranchGcQueueEntry, DatabaseBranchId, encode_branch_gc_queue_entry},
};
use futures_util::TryStreamExt;
use universaldb::{RangeOption, options::StreamingMode, utils::IsolationLevel::Snapshot};

async fn queued_row_count(
	db: &universaldb::Database,
	database_branch_id: DatabaseBranchId,
) -> Result<usize> {
	db.txn("test_count_branch_gc_queue", move |tx| async move {
		let prefix = branch_gc_queue_shard_prefix(branch_gc_queue_shard(database_branch_id));
		let end = universaldb::utils::end_of_prefix_range(&prefix);
		let informal = tx.informal();
		let mut stream = informal.get_ranges_keyvalues(
			RangeOption {
				mode: StreamingMode::Exact,
				..(prefix.as_slice(), end.as_slice()).into()
			},
			Snapshot,
		);
		let mut count = 0;
		while let Some(row) = stream.try_next().await? {
			if depot::keys::decode_branch_gc_queue_key(row.key())?.2 == database_branch_id {
				count += 1;
			}
		}
		Ok(count)
	})
	.await
}

#[tokio::test]
async fn queue_enqueue_lease_defer_expedite_and_clear_are_exact() -> Result<()> {
	let db = common::test_db("depot-branch-gc-queue-state-").await?;
	let branch = DatabaseBranchId::new_v4();
	let initial = db
		.txn("test_enqueue_branch_gc", move |tx| async move {
			let initial = enqueue_branch_gc_tx(&tx, branch, 1_000).await?;
			let replay = enqueue_branch_gc_tx(&tx, branch, 2_000).await?;
			assert_eq!(initial, replay);
			Ok(initial)
		})
		.await?;
	assert_eq!(initial.due_at_ms, 1_000);
	assert_eq!(initial.attempt_count, 0);
	assert_eq!(queued_row_count(&db, branch).await?, 1);

	assert!(
		db.txn("test_lease_branch_gc", move |tx| {
			let initial = initial.clone();
			async move { lease_branch_gc_queue_entry_tx(&tx, &initial, 3_000).await }
		})
		.await?
	);
	let leased = read_branch_gc_queue_entry(&db, branch)
		.await?
		.expect("leased queue entry should exist");
	assert_eq!(leased.due_at_ms, 3_000 + BRANCH_GC_DISPATCH_LEASE_MS);
	assert_eq!(leased.attempt_count, 0);

	let deferred = db
		.txn("test_defer_branch_gc", move |tx| async move {
			defer_branch_gc_tx(&tx, branch, 4_000).await
		})
		.await?;
	assert_eq!(deferred.attempt_count, 1);
	assert_eq!(deferred.requested_at_ms, 1_000);
	assert!(
		deferred.due_at_ms >= 4_000 + BRANCH_GC_RETRY_BASE_MS * 9 / 10
			&& deferred.due_at_ms <= 4_000 + BRANCH_GC_RETRY_BASE_MS * 11 / 10
	);
	assert_eq!(queued_row_count(&db, branch).await?, 1);

	assert!(
		db.txn("test_expedite_branch_gc", move |tx| async move {
			expedite_branch_gc_if_queued_tx(&tx, branch, 5_000).await
		})
		.await?
	);
	assert_eq!(
		read_branch_gc_queue_entry(&db, branch)
			.await?
			.expect("expedited queue entry should exist")
			.due_at_ms,
		5_000
	);

	db.txn("test_clear_branch_gc", move |tx| async move {
		clear_branch_gc_queue_tx(&tx, branch).await
	})
	.await?;
	assert!(read_branch_gc_queue_entry(&db, branch).await?.is_none());
	assert_eq!(queued_row_count(&db, branch).await?, 0);
	Ok(())
}

#[tokio::test]
async fn concurrent_initial_enqueue_installs_one_locator_and_due_row() -> Result<()> {
	let db = common::test_db_arc("depot-branch-gc-queue-race-").await?;
	let branch = DatabaseBranchId::new_v4();
	let (a, b) = tokio::join!(
		db.txn("test_enqueue_branch_gc_a", move |tx| async move {
			enqueue_branch_gc_tx(&tx, branch, 1_000).await
		}),
		db.txn("test_enqueue_branch_gc_b", move |tx| async move {
			enqueue_branch_gc_tx(&tx, branch, 2_000).await
		}),
	);
	assert_eq!(a?, b?);
	assert_eq!(queued_row_count(&db, branch).await?, 1);
	Ok(())
}

#[tokio::test]
async fn missing_due_row_is_repaired_from_exact_locator() -> Result<()> {
	let db = common::test_db("depot-branch-gc-queue-repair-").await?;
	let branch = DatabaseBranchId::new_v4();
	let first = db
		.txn("test_enqueue_branch_gc_for_repair", move |tx| async move {
			enqueue_branch_gc_tx(&tx, branch, 1_000).await
		})
		.await?;
	db.txn("test_remove_branch_gc_due_row", move |tx| async move {
		tx.informal()
			.clear(&branch_gc_queue_key(branch, first.due_at_ms));
		Ok(())
	})
	.await?;

	let repaired = db
		.txn("test_repair_branch_gc_due_row", move |tx| async move {
			enqueue_branch_gc_tx(&tx, branch, 9_000).await
		})
		.await?;
	assert_eq!(repaired.requested_at_ms, 9_000);
	assert_eq!(repaired.due_at_ms, 9_000);
	assert_eq!(queued_row_count(&db, branch).await?, 1);
	Ok(())
}

#[tokio::test]
async fn lease_clears_stale_due_row_without_a_matching_locator() -> Result<()> {
	let db = common::test_db("depot-branch-gc-queue-stale-").await?;
	let branch = DatabaseBranchId::new_v4();
	let stale = BranchGcQueueEntry {
		database_branch_id: branch,
		requested_at_ms: 1_000,
		due_at_ms: 1_000,
		attempt_count: 0,
	};
	let encoded = encode_branch_gc_queue_entry(stale.clone())?;
	let stale_key = branch_gc_queue_key(branch, stale.due_at_ms);
	db.txn("test_seed_stale_branch_gc_due_row", move |tx| {
		let encoded = encoded.clone();
		let stale_key = stale_key.clone();
		async move {
			tx.informal().set(&stale_key, &encoded);
			Ok(())
		}
	})
	.await?;
	let leased = db
		.txn("test_lease_stale_branch_gc_due_row", move |tx| {
			let stale = stale.clone();
			async move { lease_branch_gc_queue_entry_tx(&tx, &stale, 2_000).await }
		})
		.await?;
	assert!(!leased);
	assert_eq!(queued_row_count(&db, branch).await?, 0);
	assert!(
		common::read_value(&db, branch_gc_queue_locator_key(branch))
			.await?
			.is_none()
	);
	Ok(())
}

#[test]
fn retry_backoff_is_bounded_and_deterministic() {
	let branch = DatabaseBranchId::new_v4();
	assert_eq!(
		branch_gc_retry_delay_ms(branch, 3),
		branch_gc_retry_delay_ms(branch, 3)
	);
	for attempt in [1, 2, 3, 10, 100, u16::MAX] {
		let delay = branch_gc_retry_delay_ms(branch, attempt);
		assert!(delay >= BRANCH_GC_RETRY_BASE_MS * 9 / 10);
		assert!(delay <= BRANCH_GC_RETRY_MAX_MS);
	}
}
