mod common;

use anyhow::Result;
use depot::cold_tier::accounting::{
	ColdStorageAccounting, ColdStorageAccountingDelta, apply_delta, read,
};

#[tokio::test]
async fn cold_storage_accounting_transitions_are_atomic_and_durable() -> Result<()> {
	let db = common::test_db("depot-cold-storage-accounting-").await?;
	db.txn("test_cold_accounting_publish", |tx| async move {
		apply_delta(
			&tx,
			0,
			ColdStorageAccountingDelta {
				live_bytes: 4096,
				live_objects: 1,
				fdb_metadata_bytes: 128,
				..Default::default()
			},
		);
		Ok(())
	})
	.await?;
	db.txn("test_cold_accounting_retire_and_issue", |tx| async move {
		apply_delta(
			&tx,
			17,
			ColdStorageAccountingDelta {
				live_bytes: -4096,
				live_objects: -1,
				delete_issued_bytes: 4096,
				delete_issued_objects: 1,
				..Default::default()
			},
		);
		Ok(())
	})
	.await?;
	db.txn("test_cold_accounting_delete_complete", |tx| async move {
		apply_delta(
			&tx,
			63,
			ColdStorageAccountingDelta {
				delete_issued_bytes: -4096,
				delete_issued_objects: -1,
				deleted_bytes_total: 4096,
				deleted_objects_total: 1,
				..Default::default()
			},
		);
		Ok(())
	})
	.await?;

	assert_eq!(
		read(&db).await?,
		ColdStorageAccounting {
			deleted_bytes_total: 4096,
			deleted_objects_total: 1,
			fdb_metadata_bytes: 128,
			..Default::default()
		}
	);
	Ok(())
}

#[tokio::test]
async fn negative_current_balance_fails_closed() -> Result<()> {
	let db = common::test_db("depot-cold-storage-accounting-negative-").await?;
	db.txn("test_cold_accounting_underflow", |tx| async move {
		apply_delta(
			&tx,
			0,
			ColdStorageAccountingDelta {
				live_objects: -1,
				..Default::default()
			},
		);
		Ok(())
	})
	.await?;

	let error = read(&db)
		.await
		.expect_err("a negative physical ledger must fail closed");
	assert!(format!("{error:#}").contains("live_objects became negative"));
	Ok(())
}
