mod common;

use anyhow::Result;
use depot::quota::{
	FDB_WRITE_DEBT_LIMIT_BYTES, FDB_WRITE_DEBT_TARGET_BYTES, LOGICAL_STORAGE_LIMIT_BYTES,
	TRIGGER_MAX_SILENCE_MS, TRIGGER_THROTTLE_MS, atomic_add, logical_size_bytes, read,
	write_debt_check, write_debt_requires_compaction,
};
#[cfg(feature = "test-faults")]
use depot::{
	keys::branch_pidx_count_node_key,
	quota::{clear_pidx_count_suffix_for_test, seed_pidx_count_index_for_test},
	types::DatabaseBranchId,
};
#[cfg(feature = "test-faults")]
use universaldb::utils::IsolationLevel::Snapshot;
#[cfg(feature = "test-faults")]
use uuid::Uuid;

#[tokio::test]
async fn quota_defaults_to_zero() -> Result<()> {
	common::test_matrix("depot-quota-defaults", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let database_id = ctx.database_id.clone();

			let storage_used = db
				.txn("test_depotconveyer_quota", move |tx| {
					let database_id = database_id.clone();
					async move { read(&tx, &database_id).await }
				})
				.await?;

			assert_eq!(storage_used, 0);

			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn atomic_add_uses_signed_little_endian_counter() -> Result<()> {
	common::test_matrix("depot-quota-atomic-add", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let database_id = ctx.database_id.clone();

			db.txn("test_depotconveyer_quota", {
				let database_id = database_id.clone();
				move |tx| {
					let database_id = database_id.clone();
					async move {
						atomic_add(&tx, &database_id, 128);
						atomic_add(&tx, &database_id, -8);
						Ok(())
					}
				}
			})
			.await?;

			let storage_used = db
				.txn("test_depotconveyer_quota", move |tx| {
					let database_id = database_id.clone();
					async move { read(&tx, &database_id).await }
				})
				.await?;

			assert_eq!(storage_used, 120);

			Ok(())
		})
	})
	.await
}

#[test]
fn write_debt_check_is_backpressure_not_a_logical_storage_quota() {
	write_debt_check(FDB_WRITE_DEBT_LIMIT_BYTES).expect("limit should be accepted");

	let err = write_debt_check(FDB_WRITE_DEBT_LIMIT_BYTES + 64)
		.expect_err("write debt over the safety limit should be backpressured");
	let storage_err = err
		.downcast_ref::<depot::error::SqliteStorageError>()
		.expect("error should remain typed");

	assert_eq!(
		storage_err,
		&depot::error::SqliteStorageError::SqliteWriteBackpressure {
			write_debt_bytes: FDB_WRITE_DEBT_LIMIT_BYTES + 64,
			limit_bytes: FDB_WRITE_DEBT_LIMIT_BYTES,
			retry_after_ms: TRIGGER_THROTTLE_MS,
		}
	);
	assert_eq!(LOGICAL_STORAGE_LIMIT_BYTES, None);
	assert!(!write_debt_requires_compaction(
		FDB_WRITE_DEBT_TARGET_BYTES / 2 - 1
	));
	assert!(write_debt_requires_compaction(
		FDB_WRITE_DEBT_TARGET_BYTES / 2
	));
	assert!(FDB_WRITE_DEBT_LIMIT_BYTES > FDB_WRITE_DEBT_TARGET_BYTES);
	assert!(
		logical_size_bytes(u32::MAX)
			> u64::try_from(FDB_WRITE_DEBT_LIMIT_BYTES).expect("positive write-debt limit"),
		"SQLite's logical page space must not be capped by the transient FDB write-debt budget"
	);
}

#[test]
fn trigger_throttle_constants_match_spec() {
	assert_eq!(TRIGGER_THROTTLE_MS, 500);
	assert_eq!(TRIGGER_MAX_SILENCE_MS, 30_000);
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn pidx_suffix_tree_crosses_every_radix_boundary_and_can_regrow() -> Result<()> {
	common::test_matrix("depot-quota-pidx-radix-suffix", |_tier, ctx| {
		Box::pin(async move {
			let branch_id = DatabaseBranchId::from_uuid(Uuid::new_v4());
			let pages = vec![
				1,
				255,
				256,
				257,
				65_535,
				65_536,
				65_537,
				u32::MAX - 1,
				u32::MAX,
			];
			seed_pidx_count_index_for_test(&ctx.udb, branch_id, pages).await?;

			assert_eq!(
				clear_pidx_count_suffix_for_test(&ctx.udb, branch_id, 257).await?,
				6
			);
			let root_key = branch_pidx_count_node_key(branch_id, 0, 4);
			let root = ctx
				.udb
				.txn("test_read_pidx_root_count", move |tx| {
					let root_key = root_key.clone();
					async move {
						Ok(tx
							.informal()
							.get(&root_key, Snapshot)
							.await?
							.map(Vec::<u8>::from))
					}
				})
				.await?
				.expect("PIDX count root should remain");
			assert_eq!(i64::from_le_bytes(root.try_into().unwrap()), 3);

			// Reusing a coordinate whose old descendants were range-cleared must not resurrect
			// stale counts from before the truncate.
			seed_pidx_count_index_for_test(&ctx.udb, branch_id, vec![u32::MAX]).await?;
			assert_eq!(
				clear_pidx_count_suffix_for_test(&ctx.udb, branch_id, u32::MAX).await?,
				1
			);
			Ok(())
		})
	})
	.await
}
