mod common;

use anyhow::Result;
use depot::cold_tier::{
	ColdInventoryAuditSummary, ColdInventoryDisposition, ColdTier, FilesystemColdTier,
	cold_shard_object_key, complete_cold_inventory_audit, read_cold_inventory_audit_state,
	release_cold_inventory_audit_lease, scan_cold_inventory_page,
	try_acquire_cold_inventory_audit_lease,
};
use gas::prelude::Id;
use rivet_config::{
	Config,
	config::{Root, Sqlite, SqliteWorkflowColdStorage, SqliteWorkflowColdStorageFileSystem},
};

fn filesystem_config(root_path: &std::path::Path) -> Config {
	let mut root = Root::default();
	root.sqlite = Some(Sqlite {
		unstable_disable_compaction: Some(false),
		workflow_cold_storage: Some(SqliteWorkflowColdStorage::FileSystem(
			SqliteWorkflowColdStorageFileSystem {
				root: root_path.display().to_string(),
				recovery_window_ms: 7 * 24 * 60 * 60 * 1000,
				max_object_size_bytes: 4 * 1024 * 1024,
				max_concurrent_requests: 4,
				max_queued_requests: 16,
				queue_timeout_ms: 15_000,
			},
		)),
		workflow_write_debt: Default::default(),
		backup_recovery_fence_controller: None,
	});
	Config::from_root(root)
}

#[tokio::test]
async fn inventory_audit_lease_is_single_holder_and_expires() -> Result<()> {
	let db = common::test_db("depot-cold-inventory-lease-").await?;
	let holder_a = [0x0a; 16];
	let holder_b = [0x0b; 16];

	assert!(try_acquire_cold_inventory_audit_lease(&db, holder_a, 1_000, 100).await?);
	assert!(!try_acquire_cold_inventory_audit_lease(&db, holder_b, 1_050, 100).await?);
	assert!(try_acquire_cold_inventory_audit_lease(&db, holder_a, 1_075, 100).await?);
	assert!(!try_acquire_cold_inventory_audit_lease(&db, holder_b, 1_150, 100).await?);
	assert!(try_acquire_cold_inventory_audit_lease(&db, holder_b, 1_176, 100).await?);
	assert!(!release_cold_inventory_audit_lease(&db, holder_a).await?);
	assert!(release_cold_inventory_audit_lease(&db, holder_b).await?);
	assert!(try_acquire_cold_inventory_audit_lease(&db, holder_a, 1_177, 100).await?);
	Ok(())
}

#[tokio::test]
async fn completed_inventory_is_durable_and_atomically_releases_its_lease() -> Result<()> {
	let db = common::test_db("depot-cold-inventory-state-").await?;
	let holder_a = [0x0a; 16];
	let holder_b = [0x0b; 16];
	assert!(try_acquire_cold_inventory_audit_lease(&db, holder_a, 1_000, 100).await?);

	let complete = ColdInventoryAuditSummary {
		physical_bytes: 123,
		physical_objects: 4,
		complete: true,
		..Default::default()
	};
	let state = complete_cold_inventory_audit(&db, holder_a, complete.clone(), 1_050).await?;
	assert_eq!(state.summary, complete);
	assert_eq!(state.observed_at_ms, 1_050);
	assert_eq!(state.last_complete_at_ms, Some(1_050));
	assert_eq!(read_cold_inventory_audit_state(&db).await?, Some(state));
	assert!(try_acquire_cold_inventory_audit_lease(&db, holder_b, 1_051, 100).await?);
	let stale_error = complete_cold_inventory_audit(&db, holder_a, complete, 1_052)
		.await
		.expect_err("a stale auditor must not overwrite the replacement holder");
	assert!(format!("{stale_error:#}").contains("changed owner"));

	let incomplete = ColdInventoryAuditSummary {
		physical_bytes: 456,
		physical_objects: 100_000,
		complete: false,
		..Default::default()
	};
	let state = complete_cold_inventory_audit(&db, holder_b, incomplete.clone(), 1_075).await?;
	assert_eq!(state.summary, incomplete);
	assert_eq!(state.observed_at_ms, 1_075);
	assert_eq!(state.last_complete_at_ms, Some(1_050));
	Ok(())
}

#[tokio::test]
async fn inventory_reports_unowned_objects_without_mutating_them() -> Result<()> {
	let root = tempfile::tempdir()?;
	let tier = FilesystemColdTier::new(root.path());
	let canonical_key = cold_shard_object_key(
		depot::types::DatabaseBranchId::new_v4(),
		Id::new_v1(1),
		7,
		11,
		[0x5a; 32],
	);
	let invalid_key = "foreign/object.bin";
	tier.put_object(&canonical_key, b"canonical but unowned")
		.await?;
	tier.put_object(invalid_key, b"foreign").await?;

	let db = common::test_db("depot-cold-inventory-read-only-").await?;
	let report = scan_cold_inventory_page(&filesystem_config(root.path()), &db, None, 100).await?;

	assert!(!report.mutates_storage);
	assert_eq!(report.physical_objects, 2);
	assert_eq!(report.unknown_objects, 2);
	assert_eq!(report.deleted_but_present_objects, 0);
	assert_eq!(
		report
			.records
			.iter()
			.find(|record| record.object_key == canonical_key)
			.expect("canonical object record")
			.disposition,
		ColdInventoryDisposition::Unknown
	);
	assert_eq!(
		report
			.records
			.iter()
			.find(|record| record.object_key == invalid_key)
			.expect("invalid object record")
			.disposition,
		ColdInventoryDisposition::InvalidKey
	);
	assert_eq!(
		tier.get_object(&canonical_key).await?,
		b"canonical but unowned"
	);
	assert_eq!(tier.get_object(invalid_key).await?, b"foreign");
	Ok(())
}
