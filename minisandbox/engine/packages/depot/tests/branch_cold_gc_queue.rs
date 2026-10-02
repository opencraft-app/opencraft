mod common;

use anyhow::Result;
use depot::{
	gc::{
		clear_branch_cold_gc_queue_tx, defer_branch_cold_gc_tx, enqueue_branch_cold_gc_tx,
		lease_branch_cold_gc_queue_entry_tx, read_branch_cold_gc_queue_entry,
	},
	keys::{
		branch_cold_gc_queue_key, branch_cold_gc_queue_locator_key,
		branch_cold_gc_queue_shard_prefix, branch_gc_queue_shard,
	},
	types::DatabaseBranchId,
};

#[tokio::test]
async fn branch_cold_gc_queue_is_exact_sharded_leased_and_repairable() -> Result<()> {
	let db = common::test_db("depot-branch-cold-queue-").await?;
	let branch = DatabaseBranchId::new_v4();
	let tombstoned_at_ms = 1_000;
	let tombstone_versionstamp = [7_u8; 16];
	let initial = db
		.txn("test_enqueue_branch_cold_gc", move |tx| async move {
			enqueue_branch_cold_gc_tx(&tx, branch, tombstoned_at_ms, tombstone_versionstamp, 2_000)
				.await
		})
		.await?;
	assert_eq!(
		read_branch_cold_gc_queue_entry(&db, branch).await?,
		Some(initial.clone())
	);
	assert!(
		branch_cold_gc_queue_key(branch, initial.due_at_ms).starts_with(
			&branch_cold_gc_queue_shard_prefix(branch_gc_queue_shard(branch))
		)
	);
	let mismatch = db
		.txn(
			"test_reject_changed_branch_cold_tombstone",
			move |tx| async move {
				enqueue_branch_cold_gc_tx(&tx, branch, tombstoned_at_ms, [8_u8; 16], 2_000).await
			},
		)
		.await
		.expect_err("one branch queue locator must not change its backup boundary");
	assert!(format!("{mismatch:#}").contains("tombstone identity changed"));

	let leased = db
		.txn("test_lease_branch_cold_gc", {
			let initial = initial.clone();
			move |tx| {
				let initial = initial.clone();
				async move { lease_branch_cold_gc_queue_entry_tx(&tx, &initial, 3_000).await }
			}
		})
		.await?;
	assert!(leased);
	let lease = read_branch_cold_gc_queue_entry(&db, branch)
		.await?
		.expect("leased locator should remain durable");
	assert!(lease.due_at_ms > 3_000);

	let deferred = db
		.txn("test_defer_branch_cold_gc", move |tx| async move {
			defer_branch_cold_gc_tx(&tx, branch, 4_000).await
		})
		.await?
		.expect("defer should retain queue ownership");
	assert_eq!(deferred.attempt_count, 1);
	assert!(deferred.due_at_ms > 4_000);

	db.txn("test_clear_branch_cold_gc", move |tx| async move {
		clear_branch_cold_gc_queue_tx(&tx, branch).await
	})
	.await?;
	assert!(
		read_branch_cold_gc_queue_entry(&db, branch)
			.await?
			.is_none()
	);
	assert!(
		common::read_value(&db, branch_cold_gc_queue_locator_key(branch))
			.await?
			.is_none()
	);
	Ok(())
}

#[tokio::test]
async fn enqueue_repairs_locator_whose_due_row_was_lost() -> Result<()> {
	let db = common::test_db("depot-branch-cold-queue-repair-").await?;
	let branch = DatabaseBranchId::new_v4();
	let first = db
		.txn("test_seed_branch_cold_queue_repair", move |tx| async move {
			enqueue_branch_cold_gc_tx(&tx, branch, 1_000, [9_u8; 16], 2_000).await
		})
		.await?;
	db.txn("test_break_branch_cold_queue_due", move |tx| async move {
		tx.informal()
			.clear(&branch_cold_gc_queue_key(branch, first.due_at_ms));
		Ok(())
	})
	.await?;
	let repaired = db
		.txn("test_repair_branch_cold_queue_due", move |tx| async move {
			enqueue_branch_cold_gc_tx(&tx, branch, 1_000, [9_u8; 16], 9_000).await
		})
		.await?;
	assert_eq!(repaired.due_at_ms, 9_000);
	assert_eq!(
		read_branch_cold_gc_queue_entry(&db, branch).await?,
		Some(repaired)
	);
	Ok(())
}
