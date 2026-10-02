use anyhow::{Context, Result};
#[cfg(feature = "test-faults")]
use depot::{
	cold_tier::accounting::read as read_cold_accounting,
	conveyer::{Db, branch},
	fault::{BranchGcFaultPoint, DepotFaultController, DepotFaultPoint},
	keys::branch_compaction_cold_upload_intent_prefix,
	types::{BucketId, DirtyPage, decode_cold_upload_intent},
	workflows::compaction::{
		DepotCompactionTestDriver, ForceCompactionWork,
		test_hooks::register_workflow_fault_controller,
	},
};
use depot::{
	cold_tier::{ColdTier, cold_shard_object_key, cold_tier_from_config},
	conveyer::history_pin,
	error::SqliteStorageError,
	keys::{
		branch_cold_gc_manifest_key, branch_cold_gc_object_prefix,
		branch_compaction_cold_shard_key, branch_gc_deleting_key, branch_gc_queue_shard,
		branch_pidx_key, branch_prefix, branches_desc_pin_key, branches_list_key,
		branches_refcount_key, branches_restore_point_pin_key, sqlite_cmp_dirty_key,
	},
	types::{
		BranchColdGcManifest, BranchGcMarker, BranchState, BucketBranchId, ColdBackupRecoveryFence,
		ColdShardRef, DatabaseBranchId, DatabaseBranchRecord, RestorePointId,
		decode_branch_cold_gc_manifest, decode_branch_gc_marker, encode_branch_cold_gc_manifest,
		encode_branch_gc_marker, encode_cold_shard_ref, encode_database_branch_record,
	},
	workflows::{
		compaction::{DATABASE_BRANCH_ID_TAG, database_branch_tag_value},
		db_branch_cold_gc::DbBranchColdGcInput,
		db_branch_cold_gc_reconciler::DbBranchColdGcReconcilerInput,
		db_branch_gc::DbBranchGcInput,
		db_branch_gc_reconciler::DbBranchGcReconcilerInput,
	},
};
use futures_util::TryStreamExt;
use gas::prelude::{Id, TestCtx};
use rivet_config::config::{
	Sqlite, SqliteWorkflowColdStorage, SqliteWorkflowColdStorageFileSystem,
};
#[cfg(feature = "test-faults")]
use rivet_pools::NodeId;
use rivet_test_deps::TestDeps;
use tempfile::Builder;
use universaldb::{RangeOption, options::StreamingMode, utils::IsolationLevel::Snapshot};

#[tokio::test]
async fn pinned_branch_gc_requeues_without_a_sleeping_per_branch_workflow() -> Result<()> {
	let cold_root = Builder::new().prefix("depot-branch-gc-defer-").tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let branch_id = DatabaseBranchId::new_v4();
	let owner_branch = DatabaseBranchId::new_v4();
	let fork_pin_id = history_pin::database_fork_pin_id(owner_branch);
	let restore_point = RestorePointId::format(1_000, 1)?;
	let restore_pin_id = history_pin::restore_point_pin_id(&restore_point);
	let requested_at_ms = rivet_util::timestamp::now();
	let udb = test_ctx.pools().udb()?;
	udb.txn("test_seed_pinned_branch_gc", move |tx| {
		let restore_point = restore_point.clone();
		async move {
			tx.informal().set(
				&branches_list_key(branch_id),
				&encode_database_branch_record(branch_record(branch_id))?,
			);
			tx.informal()
				.set(&branches_refcount_key(branch_id), &0_i64.to_le_bytes());
			history_pin::write_database_fork_pin(
				&tx,
				branch_id,
				owner_branch,
				[1; 16],
				1,
				requested_at_ms,
			)
			.await?;
			history_pin::write_restore_point_pin(
				&tx,
				branch_id,
				restore_point,
				[1; 16],
				1,
				requested_at_ms,
			)
			.await?;
			// The branch GC fence consumes these aggregate minima. Production fork and
			// restore-point reducers maintain them alongside the durable pin records.
			tx.informal()
				.set(&branches_desc_pin_key(branch_id), &[1; 16]);
			tx.informal()
				.set(&branches_restore_point_pin_key(branch_id), &[1; 16]);
			depot::gc::enqueue_branch_gc_tx(&tx, branch_id, requested_at_ms).await?;
			Ok(())
		}
	})
	.await?;

	let tag_value = database_branch_tag_value(branch_id);
	let first_gc_id = test_ctx
		.workflow(DbBranchGcInput {
			database_branch_id: branch_id,
		})
		.tag(DATABASE_BRANCH_ID_TAG, &tag_value)
		.unique()
		.dispatch()
		.await?;
	tokio::time::timeout(
		std::time::Duration::from_secs(2),
		test_ctx.workflow::<DbBranchGcInput>(first_gc_id).output(),
	)
	.await
	.context("pinned branch GC should requeue and finish instead of sleeping")??;
	let queued = depot::gc::read_branch_gc_queue_entry(&udb, branch_id)
		.await?
		.context("pinned branch should remain in the durable GC queue")?;
	assert_eq!(queued.attempt_count, 1);
	assert!(queued.due_at_ms > requested_at_ms);
	assert!(
		udb.txn("test_read_requeued_branch_gc", move |tx| async move {
			Ok(tx
				.informal()
				.get(&branches_list_key(branch_id), Snapshot)
				.await?
				.is_some())
		})
		.await?
	);

	// Releasing the fork must not bypass the independent restore-point pin.
	udb.txn("test_release_branch_gc_fork_pin", move |tx| {
		let fork_pin_id = fork_pin_id.clone();
		async move {
			history_pin::delete_db_history_pin(&tx, branch_id, &fork_pin_id).await?;
			tx.informal().clear(&branches_desc_pin_key(branch_id));
			Ok(())
		}
	})
	.await?;
	let second_gc_id = test_ctx
		.workflow(DbBranchGcInput {
			database_branch_id: branch_id,
		})
		.tag(DATABASE_BRANCH_ID_TAG, &tag_value)
		.unique()
		.dispatch()
		.await?;
	tokio::time::timeout(
		std::time::Duration::from_secs(2),
		test_ctx.workflow::<DbBranchGcInput>(second_gc_id).output(),
	)
	.await
	.context("restore-point-pinned branch GC should requeue without sleeping")??;
	let queued = depot::gc::read_branch_gc_queue_entry(&udb, branch_id)
		.await?
		.context("restore-point pin should retain the branch in the GC queue")?;
	assert_eq!(queued.attempt_count, 2);
	assert!(
		udb.txn("test_read_restore_pinned_branch_gc", move |tx| async move {
			Ok(tx
				.informal()
				.get(&branches_list_key(branch_id), Snapshot)
				.await?
				.is_some())
		})
		.await?
	);

	// Only after the final independent pin is released may the reconciler delete the branch.
	udb.txn("test_release_branch_gc_restore_pin", move |tx| {
		let restore_pin_id = restore_pin_id.clone();
		async move {
			history_pin::delete_db_history_pin(&tx, branch_id, &restore_pin_id).await?;
			tx.informal()
				.clear(&branches_restore_point_pin_key(branch_id));
			Ok(())
		}
	})
	.await?;
	let final_gc_id = test_ctx
		.workflow(DbBranchGcInput {
			database_branch_id: branch_id,
		})
		.tag(DATABASE_BRANCH_ID_TAG, &tag_value)
		.unique()
		.dispatch()
		.await?;
	tokio::time::timeout(
		std::time::Duration::from_secs(2),
		test_ctx.workflow::<DbBranchGcInput>(final_gc_id).output(),
	)
	.await
	.context("unpinned branch GC should complete without sleeping")??;
	tokio::time::timeout(std::time::Duration::from_secs(10), async {
		loop {
			let branch_exists = udb
				.txn("test_wait_requeued_branch_gc", move |tx| async move {
					Ok(tx
						.informal()
						.get(&branches_list_key(branch_id), Snapshot)
						.await?
						.is_some())
				})
				.await?;
			if !branch_exists {
				break Ok::<_, anyhow::Error>(());
			}
			tokio::time::sleep(std::time::Duration::from_millis(25)).await;
		}
	})
	.await
	.context("reconciler should redispatch requeued branch after its pin is released")??;
	assert!(
		depot::gc::read_branch_gc_queue_entry(&udb, branch_id)
			.await?
			.is_none()
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn sharded_gc_reconciler_dispatches_only_due_branch_work() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-branch-gc-reconciler-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let branch_id = DatabaseBranchId::new_v4();
	let udb = test_ctx.pools().udb()?;
	udb.txn("test_seed_due_branch_gc", move |tx| async move {
		tx.informal().set(
			&branches_list_key(branch_id),
			&encode_database_branch_record(branch_record(branch_id))?,
		);
		tx.informal()
			.set(&branches_refcount_key(branch_id), &0_i64.to_le_bytes());
		depot::gc::enqueue_branch_gc_tx(
			&tx,
			branch_id,
			rivet_util::timestamp::now().saturating_sub(1),
		)
		.await?;
		Ok(())
	})
	.await?;
	test_ctx
		.workflow(DbBranchGcReconcilerInput {
			shard: branch_gc_queue_shard(branch_id),
		})
		.dispatch()
		.await?;

	tokio::time::timeout(std::time::Duration::from_secs(10), async {
		loop {
			let exists = udb
				.txn("test_wait_reconciled_branch_gc", move |tx| async move {
					Ok(tx
						.informal()
						.get(&branches_list_key(branch_id), Snapshot)
						.await?
						.is_some())
				})
				.await?;
			if !exists {
				break Ok::<_, anyhow::Error>(());
			}
			tokio::time::sleep(std::time::Duration::from_millis(25)).await;
		}
	})
	.await
	.context("sharded reconciler should dispatch due branch GC")??;
	assert!(
		depot::gc::read_branch_gc_queue_entry(&udb, branch_id)
			.await?
			.is_none()
	);

	test_ctx.shutdown().await?;
	Ok(())
}

async fn test_ctx_with_filesystem_cold_tier(root: &std::path::Path) -> Result<TestCtx> {
	let mut test_deps = TestDeps::new().await?;
	let mut config_root = (**test_deps.config()).clone();
	config_root.sqlite = Some(Sqlite {
		unstable_disable_compaction: Some(false),
		workflow_cold_storage: Some(SqliteWorkflowColdStorage::FileSystem(
			SqliteWorkflowColdStorageFileSystem {
				root: root.display().to_string(),
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
	test_deps.config = rivet_config::Config::from_root(config_root);
	TestCtx::new_with_deps(depot::registry()?, test_deps).await
}

fn branch_record(branch_id: DatabaseBranchId) -> DatabaseBranchRecord {
	DatabaseBranchRecord {
		branch_id,
		bucket_branch: BucketBranchId::new_v4(),
		parent: None,
		parent_versionstamp: None,
		root_versionstamp: [1; 16],
		fork_depth: 0,
		created_at_ms: 1_000,
		created_from_restore_point: None,
		state: BranchState::Live,
		lifecycle_generation: 0,
	}
}

fn cold_ref(branch_id: DatabaseBranchId, shard_id: u32) -> ColdShardRef {
	let object_generation_id = Id::new_v1(1);
	let content_hash = [3; 32];
	ColdShardRef {
		database_branch_id: branch_id,
		object_key: cold_shard_object_key(
			branch_id,
			object_generation_id,
			shard_id,
			1,
			content_hash,
		),
		object_generation_id,
		shard_id,
		as_of_txid: 1,
		min_txid: 1,
		max_txid: 1,
		min_versionstamp: [1; 16],
		max_versionstamp: [1; 16],
		ltx_size_bytes: 1,
		ltx_content_hash: [2; 32],
		size_bytes: 1,
		content_hash,
		lifecycle_generation: 0,
		publish_generation: 1,
	}
}

async fn read_branch_cold_manifest(
	test_ctx: &TestCtx,
	branch_id: DatabaseBranchId,
) -> Result<BranchColdGcManifest> {
	let udb = test_ctx.pools().udb()?;
	udb.txn("test_read_branch_cold_gc_manifest", move |tx| async move {
		let encoded = tx
			.informal()
			.get(&branch_cold_gc_manifest_key(branch_id), Snapshot)
			.await?
			.context("branch cold GC manifest should exist")?;
		let manifest = decode_branch_cold_gc_manifest(&encoded)?;
		assert_ne!(
			manifest.tombstone_versionstamp,
			depot::conveyer::udb::INCOMPLETE_VERSIONSTAMP,
			"committed branch tombstone must contain an authoritative UDB/FDB versionstamp"
		);
		Ok(manifest)
	})
	.await
}

async fn make_branch_cold_gc_due(
	test_ctx: &TestCtx,
	branch_id: DatabaseBranchId,
) -> Result<BranchColdGcManifest> {
	let mut manifest = read_branch_cold_manifest(test_ctx, branch_id).await?;
	gc_clear_and_requeue_branch_cold(test_ctx, &mut manifest).await?;
	Ok(manifest)
}

#[tokio::test]
async fn branch_cold_gc_fails_closed_without_backup_fence_then_resumes() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-branch-cold-fence-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let cold_tier = cold_tier_from_config(test_ctx.config())
		.await?
		.context("test cold tier should be configured")?;
	let branch_id = DatabaseBranchId::new_v4();
	let reference = cold_ref(branch_id, 9);
	let object_key = reference.object_key.clone();
	cold_tier.put_object(&object_key, &[0x91]).await?;
	let encoded_ref = encode_cold_shard_ref(reference)?;
	let udb = test_ctx.pools().udb()?;
	udb.txn("test_seed_branch_cold_fence", move |tx| {
		let encoded_ref = encoded_ref.clone();
		async move {
			tx.informal().set(
				&branches_list_key(branch_id),
				&encode_database_branch_record(branch_record(branch_id))?,
			);
			tx.informal()
				.set(&branches_refcount_key(branch_id), &0_i64.to_le_bytes());
			tx.informal().set(
				&branch_compaction_cold_shard_key(branch_id, 9, 1),
				&encoded_ref,
			);
			Ok(())
		}
	})
	.await?;

	test_ctx
		.workflow(DbBranchGcInput {
			database_branch_id: branch_id,
		})
		.output()
		.await?;
	let manifest = make_branch_cold_gc_due(&test_ctx, branch_id).await?;
	run_branch_cold_gc(&test_ctx, branch_id).await?;
	assert!(!cold_tier.get_object(&object_key).await?.is_empty());
	let deferred = depot::gc::read_branch_cold_gc_queue_entry(&udb, branch_id)
		.await?
		.context("missing backup fence must retain queued deletion")?;
	assert_eq!(deferred.attempt_count, 1);

	certify_branch_backup_fence(&test_ctx, &manifest).await?;
	let mut due_manifest = manifest.clone();
	gc_clear_and_requeue_branch_cold(&test_ctx, &mut due_manifest).await?;
	test_ctx
		.workflow(DbBranchColdGcReconcilerInput {
			shard: branch_gc_queue_shard(branch_id),
		})
		.dispatch()
		.await?;
	tokio::time::timeout(std::time::Duration::from_secs(10), async {
		loop {
			if cold_tier
				.get_object(&object_key)
				.await
				.is_err_and(|error| error.is_not_found())
			{
				break Ok::<_, anyhow::Error>(());
			}
			tokio::time::sleep(std::time::Duration::from_millis(25)).await;
		}
	})
	.await
	.context("backup-eligible sharded reconciler should dispatch exact physical deletion")??;
	assert!(
		cold_tier
			.get_object(&object_key)
			.await
			.is_err_and(|error| error.is_not_found())
	);
	assert!(
		read_branch_cold_manifest(&test_ctx, branch_id)
			.await
			.is_err()
	);

	test_ctx.shutdown().await?;
	Ok(())
}

async fn gc_clear_and_requeue_branch_cold(
	test_ctx: &TestCtx,
	manifest: &mut BranchColdGcManifest,
) -> Result<()> {
	let udb = test_ctx.pools().udb()?;
	manifest.delete_after_ms = 0;
	let manifest_for_tx = manifest.clone();
	udb.txn("test_make_branch_cold_gc_due", move |tx| {
		let manifest = manifest_for_tx.clone();
		async move {
			depot::gc::clear_branch_cold_gc_queue_tx(&tx, manifest.database_branch_id).await?;
			depot::gc::enqueue_branch_cold_gc_tx(
				&tx,
				manifest.database_branch_id,
				manifest.tombstoned_at_ms,
				manifest.tombstone_versionstamp,
				0,
			)
			.await?;
			tx.informal().set(
				&branch_cold_gc_manifest_key(manifest.database_branch_id),
				&encode_branch_cold_gc_manifest(manifest)?,
			);
			Ok(())
		}
	})
	.await
}

async fn certify_branch_backup_fence(
	test_ctx: &TestCtx,
	manifest: &BranchColdGcManifest,
) -> Result<()> {
	let udb = test_ctx.pools().udb()?;
	let mut verified_at_ms = rivet_util::timestamp::now();
	while verified_at_ms <= manifest.tombstoned_at_ms {
		tokio::time::sleep(std::time::Duration::from_millis(1)).await;
		verified_at_ms = rivet_util::timestamp::now();
	}
	depot::backup_fence::certify_cold_backup_recovery_fence(
		&udb,
		[0x42; 32],
		ColdBackupRecoveryFence {
			policy_fingerprint: [0x42; 32],
			minimum_restorable_version: depot::backup_fence::fdb_commit_version(
				&manifest.tombstone_versionstamp,
			)
			.saturating_add(1),
			verified_at_ms,
			valid_until_ms: verified_at_ms.saturating_add(60_000),
		},
	)
	.await?;
	let current = depot::cold_tier::read_cold_gc_policy(&udb).await?;
	if !current.spec.deletion_enabled {
		let spec = depot::cold_tier::ColdGcPolicySpec {
			deletion_enabled: true,
			grace_period_ms: 1,
			dry_run: false,
			..Default::default()
		};
		depot::cold_tier::set_cold_gc_policy(&udb, current.revision, spec, verified_at_ms).await?;
	}
	Ok(())
}

async fn run_branch_cold_gc(test_ctx: &TestCtx, branch_id: DatabaseBranchId) -> Result<()> {
	test_ctx
		.workflow(DbBranchColdGcInput {
			database_branch_id: branch_id,
		})
		.output()
		.await
}

async fn count_rows_with_prefix(udb: &universaldb::Database, prefix: Vec<u8>) -> Result<usize> {
	udb.txn("test_count_branch_cold_gc_rows", move |tx| {
		let prefix = prefix.clone();
		async move {
			let end = universaldb::utils::end_of_prefix_range(&prefix);
			let informal = tx.informal();
			let mut rows = informal.get_ranges_keyvalues(
				RangeOption {
					mode: StreamingMode::WantAll,
					..(prefix.as_slice(), end.as_slice()).into()
				},
				Snapshot,
			);
			let mut count = 0;
			while rows.try_next().await?.is_some() {
				count += 1;
			}
			Ok(count)
		}
	})
	.await
}

#[tokio::test]
async fn branch_gc_drains_multiple_bounded_cold_and_fdb_pages() -> Result<()> {
	const OBJECT_COUNT: u32 = 205;
	const FDB_PADDING_ROWS: u32 = 300;

	let cold_root = Builder::new().prefix("depot-branch-gc-").tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let cold_tier = cold_tier_from_config(test_ctx.config())
		.await?
		.context("test cold tier should be configured")?;
	let branch_id = DatabaseBranchId::new_v4();
	let mut cold_rows = Vec::with_capacity(OBJECT_COUNT as usize);
	let mut object_keys = Vec::with_capacity(OBJECT_COUNT as usize);
	for shard_id in 0..OBJECT_COUNT {
		let reference = cold_ref(branch_id, shard_id);
		let object_key = reference.object_key.clone();
		cold_tier.put_object(&object_key, &[0x44]).await?;
		cold_rows.push((
			branch_compaction_cold_shard_key(branch_id, shard_id, 1),
			encode_cold_shard_ref(reference)?,
		));
		object_keys.push(object_key);
	}

	let udb = test_ctx.pools().udb()?;
	udb.txn("test_seed_branch_gc", move |tx| {
		let cold_rows = cold_rows.clone();
		async move {
			tx.informal().set(
				&branches_list_key(branch_id),
				&encode_database_branch_record(branch_record(branch_id))?,
			);
			tx.informal()
				.set(&branches_refcount_key(branch_id), &0_i64.to_le_bytes());
			tx.informal()
				.set(&sqlite_cmp_dirty_key(branch_id), b"dirty");
			for (key, value) in cold_rows {
				tx.informal().set(&key, &value);
			}
			for pgno in 1..=FDB_PADDING_ROWS {
				tx.informal()
					.set(&branch_pidx_key(branch_id, pgno), &1_u64.to_be_bytes());
			}
			Ok(())
		}
	})
	.await?;

	test_ctx
		.workflow(DbBranchGcInput {
			database_branch_id: branch_id,
		})
		.output()
		.await?;

	let (branch_record, dirty, branch_row_count) = udb
		.txn("test_read_branch_gc_result", move |tx| async move {
			let branch_record = tx
				.informal()
				.get(&branches_list_key(branch_id), Snapshot)
				.await?;
			let dirty = tx
				.informal()
				.get(&sqlite_cmp_dirty_key(branch_id), Snapshot)
				.await?;
			let prefix = branch_prefix(branch_id);
			let end = universaldb::utils::end_of_prefix_range(&prefix);
			let informal = tx.informal();
			let mut stream = informal.get_ranges_keyvalues(
				RangeOption {
					limit: Some(1),
					mode: StreamingMode::Exact,
					..(prefix.as_slice(), end.as_slice()).into()
				},
				Snapshot,
			);
			let branch_row_count = usize::from(stream.try_next().await?.is_some());
			Ok((branch_record, dirty, branch_row_count))
		})
		.await?;
	assert!(branch_record.is_none());
	assert!(dirty.is_none());
	assert_eq!(branch_row_count, 0);
	let manifest = read_branch_cold_manifest(&test_ctx, branch_id).await?;
	assert!(manifest.staging_complete);
	assert_eq!(manifest.staged_object_count, u64::from(OBJECT_COUNT));
	assert!(
		depot::gc::read_branch_cold_gc_queue_entry(&udb, branch_id)
			.await?
			.is_some(),
		"physical deletion must remain durably queued outside the deleted branch"
	);
	for object_key in &object_keys {
		assert!(
			!cold_tier.get_object(object_key).await?.is_empty(),
			"logical branch GC must retain recoverable object {object_key}"
		);
	}

	certify_branch_backup_fence(&test_ctx, &manifest).await?;
	run_branch_cold_gc(&test_ctx, branch_id).await?;
	for object_key in &object_keys {
		assert!(
			!cold_tier.get_object(object_key).await?.is_empty(),
			"backup freshness alone must not bypass the branch recovery window for {object_key}"
		);
	}

	let manifest = make_branch_cold_gc_due(&test_ctx, branch_id).await?;
	certify_branch_backup_fence(&test_ctx, &manifest).await?;
	run_branch_cold_gc(&test_ctx, branch_id).await?;
	assert!(
		depot::gc::read_branch_cold_gc_queue_entry(&udb, branch_id)
			.await?
			.is_none()
	);
	assert!(
		count_rows_with_prefix(&udb, branch_cold_gc_object_prefix(branch_id)).await? == 0,
		"completed physical GC must drain its branch-partitioned exact manifest"
	);
	for object_key in object_keys {
		assert!(
			cold_tier
				.get_object(&object_key)
				.await
				.is_err_and(|error| error.is_not_found()),
			"branch GC should delete exact object {object_key}"
		);
	}

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn branch_gc_marker_blocks_new_history_pins() -> Result<()> {
	let cold_root = Builder::new().prefix("depot-branch-gc-pin-").tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let branch_id = DatabaseBranchId::new_v4();
	let marker = BranchGcMarker {
		database_branch_id: branch_id,
		lifecycle_generation: 1,
		requested_at_ms: 1_000,
	};
	let udb = test_ctx.pools().udb()?;
	udb.txn("test_seed_branch_gc_pin_fence", move |tx| {
		let marker = marker.clone();
		async move {
			let mut record = branch_record(branch_id);
			record.state = BranchState::Frozen;
			record.lifecycle_generation = 1;
			tx.informal().set(
				&branches_list_key(branch_id),
				&encode_database_branch_record(record)?,
			);
			tx.informal()
				.set(&branches_refcount_key(branch_id), &0_i64.to_le_bytes());
			tx.informal().set(
				&branch_gc_deleting_key(branch_id),
				&encode_branch_gc_marker(marker)?,
			);
			Ok(())
		}
	})
	.await?;

	let restore_point = RestorePointId::format(1_000, 1)?;
	let error = udb
		.txn("test_branch_gc_reject_pin", move |tx| {
			let restore_point = restore_point.clone();
			async move {
				history_pin::write_restore_point_pin(
					&tx,
					branch_id,
					restore_point,
					[1; 16],
					1,
					1_001,
				)
				.await
			}
		})
		.await
		.expect_err("deleting branch must reject a new restore-point pin");
	assert!(error.chain().any(|cause| matches!(
		cause.downcast_ref::<SqliteStorageError>(),
		Some(SqliteStorageError::BranchNotWritable)
	)));

	let encoded_marker = udb
		.txn("test_read_branch_gc_pin_fence", move |tx| async move {
			tx.informal()
				.get(&branch_gc_deleting_key(branch_id), Snapshot)
				.await?
				.context("GC marker should remain durable")
		})
		.await?;
	assert_eq!(
		decode_branch_gc_marker(&encoded_marker)?.lifecycle_generation,
		1
	);

	// Avoid leaving a sleeping workflow in this fixture; the marker encoding and pin fence are the
	// behavior under test.
	test_ctx.shutdown().await?;
	Ok(())
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn branch_gc_replays_after_exact_object_delete_response_loss() -> Result<()> {
	let cold_root = Builder::new().prefix("depot-branch-gc-replay-").tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let cold_tier = cold_tier_from_config(test_ctx.config())
		.await?
		.context("test cold tier should be configured")?;
	let branch_id = DatabaseBranchId::new_v4();
	let reference = cold_ref(branch_id, 1);
	let object_key = reference.object_key.clone();
	cold_tier.put_object(&object_key, &[0x55]).await?;
	let encoded_ref = encode_cold_shard_ref(reference)?;
	let udb = test_ctx.pools().udb()?;
	udb.txn("test_seed_branch_gc_replay", move |tx| {
		let encoded_ref = encoded_ref.clone();
		async move {
			tx.informal().set(
				&branches_list_key(branch_id),
				&encode_database_branch_record(branch_record(branch_id))?,
			);
			tx.informal()
				.set(&branches_refcount_key(branch_id), &0_i64.to_le_bytes());
			tx.informal().set(
				&branch_compaction_cold_shard_key(branch_id, 1, 1),
				&encoded_ref,
			);
			Ok(())
		}
	})
	.await?;

	let controller = DepotFaultController::new();
	controller
		.at(DepotFaultPoint::BranchGc(
			BranchGcFaultPoint::AfterColdObjectDelete,
		))
		.database_branch_id(branch_id)
		.once()
		.fail("simulated lost branch GC activity response")?;
	let _fault_guard = register_workflow_fault_controller(branch_id, controller.clone());
	test_ctx
		.workflow(DbBranchGcInput {
			database_branch_id: branch_id,
		})
		.output()
		.await?;
	let manifest = make_branch_cold_gc_due(&test_ctx, branch_id).await?;
	certify_branch_backup_fence(&test_ctx, &manifest).await?;
	run_branch_cold_gc(&test_ctx, branch_id).await?;
	controller.assert_expected_fired()?;

	assert!(
		cold_tier
			.get_object(&object_key)
			.await
			.is_err_and(|error| error.is_not_found())
	);
	let record = udb
		.txn("test_read_branch_gc_replay", move |tx| async move {
			tx.informal()
				.get(&branches_list_key(branch_id), Snapshot)
				.await
		})
		.await?;
	assert!(record.is_none());
	let accounting = read_cold_accounting(&udb).await?;
	assert_eq!(accounting.orphan_objects, 0);
	assert_eq!(accounting.delete_issued_objects, 0);
	assert_eq!(accounting.deleted_objects_total, 1);
	assert_eq!(accounting.deleted_bytes_total, 1);
	let receipt = depot::cold_tier::read_cold_delete_receipt(&udb, &object_key)
		.await?
		.context("branch GC must leave an exact-key deletion audit receipt")?;
	assert_eq!(
		receipt.authorization.reason,
		depot::types::ColdDeleteReason::BranchGarbageCollection
	);
	assert_eq!(receipt.authorization.policy_revision, Some(1));

	test_ctx.shutdown().await?;
	Ok(())
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn branch_gc_waits_for_inflight_cold_put_before_deleting_branch() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-branch-gc-inflight-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let cold_tier = cold_tier_from_config(test_ctx.config())
		.await?
		.context("test cold tier should be configured")?;
	let bucket = Id::new_v1(1);
	let database_id = format!("branch-gc-inflight-{}", uuid::Uuid::new_v4());
	let db = Db::new_with_cold_tier(
		std::sync::Arc::new((*test_ctx.pools().udb()?).clone()),
		bucket,
		database_id.clone(),
		NodeId::new(),
		cold_tier.clone(),
	);
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x66; 4096],
		}],
		1,
		1_000,
	)
	.await?;
	let bucket_id = BucketId::from_gas_id(bucket);
	let udb = test_ctx.pools().udb()?;
	let database_id_for_resolve = database_id.clone();
	let branch_id = udb
		.txn("test_resolve_branch_gc_inflight", move |tx| {
			let database_id = database_id_for_resolve.clone();
			async move {
				branch::resolve_database_branch(
					&tx,
					bucket_id,
					&database_id,
					universaldb::utils::IsolationLevel::Serializable,
				)
				.await?
				.context("in-flight GC branch should exist")
			}
		})
		.await?;

	let controller = DepotFaultController::new();
	let pause = controller.pause_handle("branch-gc-inflight-cold-put");
	controller
		.at(DepotFaultPoint::ColdCompaction(
			depot::fault::ColdCompactionFaultPoint::UploadAfterObjectPut,
		))
		.database_branch_id(branch_id)
		.once()
		.pause("branch-gc-inflight-cold-put")?;
	let _fault_guard = register_workflow_fault_controller(branch_id, controller.clone());
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;

	let force = driver.force_compaction(
		manager_id,
		branch_id,
		ForceCompactionWork {
			hot: true,
			cold: true,
			reclaim: false,
			final_settle: false,
		},
	);
	let gc = async {
		pause.wait_reached().await;
		let object_key = udb
			.txn("test_read_inflight_cold_intent", move |tx| async move {
				let prefix = branch_compaction_cold_upload_intent_prefix(branch_id);
				let end = universaldb::utils::end_of_prefix_range(&prefix);
				let informal = tx.informal();
				let mut stream = informal.get_ranges_keyvalues(
					RangeOption {
						limit: Some(1),
						mode: StreamingMode::Exact,
						..(prefix.as_slice(), end.as_slice()).into()
					},
					Snapshot,
				);
				let row = stream
					.try_next()
					.await?
					.context("cold PUT should have a durable upload intent")?;
				Ok(decode_cold_upload_intent(row.value())?.reference.object_key)
			})
			.await?;
		assert!(!cold_tier.get_object(&object_key).await?.is_empty());

		branch::delete_database(&udb, bucket_id, branch_id).await?;
		let gc_workflow_id = test_ctx
			.workflow(DbBranchGcInput {
				database_branch_id: branch_id,
			})
			.dispatch()
			.await?;
		let mut gc_output = Box::pin(
			test_ctx
				.workflow::<DbBranchGcInput>(gc_workflow_id)
				.output(),
		);
		assert!(
			tokio::time::timeout(std::time::Duration::from_millis(200), &mut gc_output)
				.await
				.is_err(),
			"branch GC must wait for the paused cold activity and companion shutdown"
		);
		assert!(
			udb.txn("test_branch_gc_inflight_record", move |tx| async move {
				Ok(tx
					.informal()
					.get(&branches_list_key(branch_id), Snapshot)
					.await?
					.is_some())
			})
			.await?
		);

		pause.release();
		gc_output.await?;
		Ok::<_, anyhow::Error>(object_key)
	};
	let object_key = tokio::time::timeout(std::time::Duration::from_secs(20), async {
		tokio::select! {
			gc_result = gc => gc_result,
			force_result = force => {
				force_result.context("forced compaction ended before branch GC")?;
				anyhow::bail!("forced compaction unexpectedly settled before branch GC")
			}
		}
	})
	.await
	.context("in-flight cold activity and branch GC should settle")??;
	controller.assert_expected_fired()?;
	assert!(
		cold_tier
			.get_object(&object_key)
			.await
			.is_err_and(|error| error.is_not_found()),
		"the joined cold compacter may exact-delete an upload that never became backup-visible"
	);
	let branch_record = udb
		.txn(
			"test_read_inflight_branch_gc_result",
			move |tx| async move {
				tx.informal()
					.get(&branches_list_key(branch_id), Snapshot)
					.await
			},
		)
		.await?;
	assert!(branch_record.is_none());

	test_ctx.shutdown().await?;
	Ok(())
}
