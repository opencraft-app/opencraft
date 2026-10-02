#![cfg(feature = "test-faults")]

use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result, bail};
use depot::{
	conveyer::{
		Db, branch, history_pin,
		policy::{set_bucket_pitr_policy, set_database_pitr_policy_override},
	},
	keys::{
		PAGE_SIZE, branch_commit_key, branch_compaction_hot_publish_key,
		branch_compaction_root_key, branch_compaction_stage_hot_job_by_generation_key,
		branch_compaction_stage_hot_job_key, branch_compaction_stage_hot_shard_key,
		branch_delta_chunk_key, branch_hot_compaction_job_queue_key, branch_page_history_key,
		branch_pidx_count_node_key, branch_pidx_key, branch_pitr_interval_by_txid_key,
		branch_pitr_interval_due_key, branch_pitr_interval_key, branch_shard_key, branch_vtx_key,
		bucket_policy_pitr_key, database_pointer_cur_key, database_policy_binding_key,
		db_pin_txid_count_key, decode_sqlite_cmp_dirty_due_key, sqlite_cmp_dirty_due_key,
		sqlite_cmp_dirty_due_locator_key, sqlite_cmp_dirty_key,
	},
	types::{
		BucketBranchId, BucketId, DEFAULT_PITR_INTERVAL_MS, DatabaseBranchId, DirtyPage,
		HotShardStageProof, HotStageJobRecord, PitrIntervalCoverage, PitrPolicy, SqliteCmpDirty,
		decode_compaction_root, encode_hot_shard_stage_proof, encode_hot_stage_job_record,
		encode_pitr_interval_coverage, encode_sqlite_cmp_dirty,
	},
	workflows::compaction::{
		CompactionJobKind, DATABASE_BRANCH_ID_TAG, DbColdCompacterWorkflow,
		DbCompactionReconcilerInput, DbCompactionReconcilerWorkflow, DbHotCompacterWorkflow,
		DbManagerState, DbManagerWorkflow, DbReclaimerWorkflow, DepotCompactionTestDriver,
		ForceCompactionWork, claim_due_branch_ids_for_test,
		latest_commit_at_or_before_versionstamp_for_test, load_latest_branch_shard_blob_for_test,
		read_effective_pitr_policy_for_test, read_hot_input_plan_for_test,
		read_live_pitr_txids_in_ranges_for_test, read_pitr_reclaim_plan_for_test,
		scan_dirty_branch_ids_for_test,
	},
};
use futures_util::{FutureExt, StreamExt, TryStreamExt, stream};
use gas::{
	db::debug::{DatabaseDebug, EventData},
	prelude::{Id, Registry, TestCtx},
};
use rivet_pools::NodeId;
use uuid::Uuid;

const TEST_DATABASE: &str = "forced-compaction-test-driver";

fn test_bucket() -> Id {
	Id::v1(Uuid::from_u128(0x9abc), 1)
}

fn build_registry() -> Registry {
	let mut registry = Registry::new();
	registry.register_workflow::<DbManagerWorkflow>().unwrap();
	registry
		.register_workflow::<DbHotCompacterWorkflow>()
		.unwrap();
	registry
		.register_workflow::<DbColdCompacterWorkflow>()
		.unwrap();
	registry.register_workflow::<DbReclaimerWorkflow>().unwrap();
	registry
		.register_workflow::<DbCompactionReconcilerWorkflow>()
		.unwrap();
	registry
}

fn dirty_page(pgno: u32, fill: u8) -> DirtyPage {
	DirtyPage {
		pgno,
		bytes: vec![fill; PAGE_SIZE as usize],
	}
}

fn make_db(test_ctx: &TestCtx, database_id: impl Into<String>) -> Result<Db> {
	let udb_pool = test_ctx.pools().udb()?;
	Ok(Db::new(
		Arc::new((*udb_pool).clone()),
		test_bucket(),
		database_id.into(),
		NodeId::new(),
	))
}

async fn read_database_branch_id(
	test_ctx: &TestCtx,
	database_id: &str,
) -> Result<DatabaseBranchId> {
	let db = test_ctx.pools().udb()?;
	let database_id = database_id.to_string();
	db.txn("test_depotforced_compaction_test_driver", move |tx| {
		let database_id = database_id.clone();
		async move {
			branch::resolve_database_branch(
				&tx,
				BucketId::from_gas_id(test_bucket()),
				&database_id,
				universaldb::utils::IsolationLevel::Serializable,
			)
			.await?
			.context("database branch should exist")
		}
	})
	.await
}

async fn read_branch_quota(
	test_ctx: &TestCtx,
	database_branch_id: DatabaseBranchId,
) -> Result<i64> {
	let db = test_ctx.pools().udb()?;
	db.txn("test_read_branch_quota", move |tx| async move {
		depot::quota::read_branch(&tx, database_branch_id).await
	})
	.await
}

async fn latest_manager_state(test_ctx: &TestCtx, workflow_id: Id) -> Result<DbManagerState> {
	let history = DatabaseDebug::get_workflow_history(test_ctx.debug_db(), workflow_id, true)
		.await?
		.context("manager workflow history not found")?;

	for event in history.events.into_iter().rev() {
		if let EventData::Loop(loop_event) = event.data {
			return Ok(serde_json::from_value::<DbManagerState>(loop_event.state)?);
		}
	}

	bail!("manager workflow has no loop state")
}

async fn wait_for_reconciled_hot_compaction(
	test_ctx: &TestCtx,
	database_branch_id: DatabaseBranchId,
	expected_txid: u64,
) -> Result<()> {
	let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
	loop {
		let db = test_ctx.pools().udb()?;
		let hot_watermark_txid = db
			.txn(
				"test_wait_for_reconciled_hot_compaction",
				move |tx| async move {
					let informal = tx.informal();
					let root = informal
						.get(
							&branch_compaction_root_key(database_branch_id),
							universaldb::utils::IsolationLevel::Snapshot,
						)
						.await?
						.map(|value| decode_compaction_root(&value))
						.transpose()?;

					Ok(root.map(|root| root.hot_watermark_txid))
				},
			)
			.await?;
		if hot_watermark_txid.is_some_and(|watermark| watermark >= expected_txid) {
			return Ok(());
		}
		if tokio::time::Instant::now() >= deadline {
			bail!(
				"timed out waiting for reconciler-driven hot compaction; latest watermark: {:?}",
				hot_watermark_txid
			);
		}
		tokio::time::sleep(Duration::from_millis(50)).await;
	}
}

#[tokio::test]
async fn test_driver_forces_noop_without_planning_timers() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let db = make_db(&test_ctx, TEST_DATABASE)?;
	db.commit(vec![dirty_page(1, 0x11)], 2, 1_000).await?;
	let database_branch_id = read_database_branch_id(&test_ctx, TEST_DATABASE).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_workflow_id = driver.start_manager(database_branch_id, None, true).await?;

	let requested_work = ForceCompactionWork {
		hot: false,
		cold: false,
		reclaim: false,
		final_settle: true,
	};
	let result = driver
		.force_compaction(manager_workflow_id, database_branch_id, requested_work)
		.await?;
	let manager_state = latest_manager_state(&test_ctx, manager_workflow_id).await?;

	assert_eq!(result.requested_work, requested_work);
	assert!(result.attempted_job_kinds.is_empty());
	assert!(result.completed_job_ids.is_empty());
	assert!(result.terminal_error.is_none());
	assert!(
		result
			.skipped_noop_reasons
			.contains(&"final-settle:refreshed".to_string())
	);
	assert_eq!(manager_state.next_reclaim_check_at_ms, None);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn test_driver_forces_hot_compaction_and_exposes_result_fields() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "forced-compaction-test-driver-hot";
	let db = make_db(&test_ctx, database_id)?;
	db.commit(vec![dirty_page(1, 0x22)], 2, 1_000).await?;
	let database_branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_workflow_id = driver
		.start_manager(database_branch_id, Some("actor-for-test".to_string()), true)
		.await?;

	let requested_work = ForceCompactionWork {
		hot: true,
		cold: false,
		reclaim: false,
		final_settle: false,
	};
	let result = driver
		.force_compaction(manager_workflow_id, database_branch_id, requested_work)
		.await?;
	let manager_state = latest_manager_state(&test_ctx, manager_workflow_id).await?;

	assert_eq!(result.requested_work, requested_work);
	assert_eq!(result.attempted_job_kinds, vec![CompactionJobKind::Hot]);
	assert_eq!(result.completed_job_ids.len(), 1);
	assert!(result.skipped_noop_reasons.is_empty());
	assert!(result.terminal_error.is_none());
	assert_eq!(manager_state.next_reclaim_check_at_ms, None);

	let tag_value = depot::workflows::compaction::database_branch_tag_value(database_branch_id);
	assert_eq!(
		test_ctx
			.find_workflow::<DbManagerWorkflow>((DATABASE_BRANCH_ID_TAG, &tag_value))
			.await?,
		Some(manager_workflow_id)
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn manager_reclaims_fenced_hot_stage_by_branch_generation_without_global_scan() -> Result<()>
{
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "forced-compaction-fenced-hot-stage";
	let db = make_db(&test_ctx, database_id)?;
	db.commit(vec![dirty_page(1, 0x23)], 2, 1_000).await?;
	let branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let published = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: false,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(published.terminal_error, None);

	let stale_job_id = Id::v1(Uuid::from_u128(2), 1);
	let stale_record = HotStageJobRecord {
		database_branch_id: branch_id,
		job_id: stale_job_id,
		base_lifecycle_generation: 0,
		base_manifest_generation: 0,
		input_fingerprint: [0x31; 32],
	};
	let stale_record_key = branch_compaction_stage_hot_job_key(branch_id, stale_job_id);
	let stale_index_key =
		branch_compaction_stage_hot_job_by_generation_key(branch_id, 0, stale_job_id);
	let stale_global_index_key = branch_hot_compaction_job_queue_key(branch_id, stale_job_id);
	let orphan_job_id = Id::v1(Uuid::from_u128(1), 1);
	let orphan_index_key =
		branch_compaction_stage_hot_job_by_generation_key(branch_id, 0, orphan_job_id);
	let orphan_global_index_key = branch_hot_compaction_job_queue_key(branch_id, orphan_job_id);
	let stale_proof_key = branch_compaction_stage_hot_shard_key(branch_id, stale_job_id, 0, 2, 0);
	let stale_proof = HotShardStageProof {
		database_branch_id: branch_id,
		job_id: stale_job_id,
		shard_id: 0,
		as_of_txid: 2,
		min_txid: 2,
		max_txid: 2,
		size_bytes: 1,
		content_hash: [0x32; 32],
	};
	let unrelated_branch = DatabaseBranchId::from_uuid(Uuid::new_v4());
	let udb = test_ctx.pools().udb()?;
	let seed_record_key = stale_record_key.clone();
	let seed_index_key = stale_index_key.clone();
	let seed_global_index_key = stale_global_index_key.clone();
	let seed_orphan_index_key = orphan_index_key.clone();
	let seed_orphan_global_index_key = orphan_global_index_key.clone();
	let seed_proof_key = stale_proof_key.clone();
	udb.txn("test_seed_partitioned_fenced_hot_stages", move |tx| {
		let stale_record = stale_record.clone();
		let stale_record_key = seed_record_key.clone();
		let stale_index_key = seed_index_key.clone();
		let stale_global_index_key = seed_global_index_key.clone();
		let orphan_index_key = seed_orphan_index_key.clone();
		let orphan_global_index_key = seed_orphan_global_index_key.clone();
		let stale_proof_key = seed_proof_key.clone();
		let stale_proof = stale_proof.clone();
		async move {
			tx.informal().set(
				&stale_record_key,
				&encode_hot_stage_job_record(stale_record)?,
			);
			tx.informal().set(&stale_index_key, &[]);
			tx.informal().set(&stale_global_index_key, &[]);
			// Model an atomic stage primary that was already removed while both secondary
			// indexes survived. Bounded refresh must self-heal both indexes.
			tx.informal().set(&orphan_index_key, &[]);
			tx.informal().set(&orphan_global_index_key, &[]);
			tx.informal().set(
				&stale_proof_key,
				&encode_hot_shard_stage_proof(stale_proof)?,
			);
			for idx in 0..2_048_u128 {
				let poison_job_id = Id::v1(Uuid::from_u128(0x4000_0000 + idx), 1);
				tx.informal().set(
					&branch_compaction_stage_hot_job_by_generation_key(
						unrelated_branch,
						0,
						poison_job_id,
					),
					&[],
				);
			}
			Ok(())
		}
	})
	.await?;

	let settled = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: false,
				final_settle: true,
			},
		)
		.await?;
	assert_eq!(settled.terminal_error, None);
	assert!(read_value(&test_ctx, stale_record_key).await?.is_none());
	assert!(read_value(&test_ctx, stale_index_key).await?.is_none());
	assert!(
		read_value(&test_ctx, stale_global_index_key)
			.await?
			.is_none()
	);
	assert!(read_value(&test_ctx, orphan_index_key).await?.is_none());
	assert!(
		read_value(&test_ctx, orphan_global_index_key)
			.await?
			.is_none()
	);
	assert!(read_value(&test_ctx, stale_proof_key).await?.is_none());
	assert!(
		read_value(
			&test_ctx,
			branch_compaction_stage_hot_job_by_generation_key(
				unrelated_branch,
				0,
				Id::v1(Uuid::from_u128(0x4000_0000 + 2_047), 1),
			),
		)
		.await?
		.is_some(),
		"another branch's 2,048 stage rows must not participate in this branch's cleanup"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn history_pin_index_collapses_massive_same_txid_fanout() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "forced-compaction-massive-pin-fanout";
	let db = make_db(&test_ctx, database_id)?;
	db.commit(vec![dirty_page(1, 0x24)], 2, 1_000).await?;
	let branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let udb = test_ctx.pools().udb()?;
	for batch_start in (0..2_500_u128).step_by(100) {
		udb.txn(
			"test_write_same_txid_history_pin_batch",
			move |tx| async move {
				for offset in 0..100_u128 {
					let owner = DatabaseBranchId::from_uuid(Uuid::from_u128(
						0x5000_0000 + batch_start + offset,
					));
					history_pin::write_database_fork_pin(
						&tx, branch_id, owner, [0x41; 16], 2, 1_000,
					)
					.await?;
				}
				Ok(())
			},
		)
		.await?;
	}
	let (count, page) = udb
		.txn(
			"test_read_massive_history_pin_index",
			move |tx| async move {
				Ok((
					history_pin::read_indexed_pin_count(
						&tx,
						branch_id,
						universaldb::utils::IsolationLevel::Serializable,
					)
					.await?,
					history_pin::read_history_pin_txids_page(
						&tx,
						branch_id,
						0,
						u64::MAX,
						2,
						universaldb::utils::IsolationLevel::Serializable,
					)
					.await?,
				))
			},
		)
		.await?;
	assert_eq!(count, 2_500);
	assert_eq!(page.txids, vec![2]);
	assert!(!page.has_more);
	assert_eq!(
		read_value(&test_ctx, db_pin_txid_count_key(branch_id, 2)).await?,
		Some(Vec::new())
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn history_pin_presence_survives_partial_fanout_delete_and_clears_after_last_pin()
-> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "history-pin-presence-delete";
	let db = make_db(&test_ctx, database_id)?;
	db.commit(vec![dirty_page(1, 0x25)], 2, 1_000).await?;
	let branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let udb = test_ctx.pools().udb()?;
	let owners = [
		DatabaseBranchId::from_uuid(Uuid::from_u128(0x5100_0001)),
		DatabaseBranchId::from_uuid(Uuid::from_u128(0x5100_0002)),
	];
	udb.txn(
		"test_write_two_same_txid_history_pins",
		move |tx| async move {
			for owner in owners {
				history_pin::write_database_fork_pin(&tx, branch_id, owner, [0x41; 16], 2, 1_000)
					.await?;
			}
			Ok(())
		},
	)
	.await?;

	let first_pin_id = history_pin::database_fork_pin_id(owners[0]);
	udb.txn("test_delete_one_same_txid_history_pin", move |tx| {
		let pin_id = first_pin_id.clone();
		async move { history_pin::delete_db_history_pin(&tx, branch_id, &pin_id).await }
	})
	.await?;
	assert_eq!(
		read_value(&test_ctx, db_pin_txid_count_key(branch_id, 2)).await?,
		Some(Vec::new()),
		"one remaining fanout member must retain the txid presence row"
	);

	let second_pin_id = history_pin::database_fork_pin_id(owners[1]);
	udb.txn("test_delete_last_same_txid_history_pin", move |tx| {
		let pin_id = second_pin_id.clone();
		async move { history_pin::delete_db_history_pin(&tx, branch_id, &pin_id).await }
	})
	.await?;
	assert!(
		read_value(&test_ctx, db_pin_txid_count_key(branch_id, 2))
			.await?
			.is_none(),
		"the last deleter must clear the exact txid presence row"
	);
	let total = udb
		.txn(
			"test_read_zero_sharded_history_pin_total",
			move |tx| async move {
				history_pin::read_indexed_pin_count(
					&tx,
					branch_id,
					universaldb::utils::IsolationLevel::Serializable,
				)
				.await
			},
		)
		.await?;
	assert_eq!(total, 0);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn concurrent_history_pin_create_and_last_delete_preserve_exact_presence() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "history-pin-concurrent-presence";
	let db = make_db(&test_ctx, database_id)?;
	db.commit(vec![dirty_page(1, 0x26)], 2, 1_000).await?;
	let branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let udb = Arc::new((*test_ctx.pools().udb()?).clone());
	let owners = (0..32_u128)
		.map(|offset| DatabaseBranchId::from_uuid(Uuid::from_u128(0x5200_0000 + offset)))
		.collect::<Vec<_>>();
	stream::iter(owners.iter().copied())
		.map(|owner| {
			let udb = Arc::clone(&udb);
			async move {
				udb.txn("test_concurrent_history_pin_create", move |tx| async move {
					history_pin::write_database_fork_pin(
						&tx, branch_id, owner, [0x43; 16], 2, 1_000,
					)
					.await
				})
				.await
			}
		})
		.buffer_unordered(16)
		.try_collect::<Vec<_>>()
		.await?;
	let surviving_owner = DatabaseBranchId::from_uuid(Uuid::from_u128(0x5200_1000));
	let delete_futures = owners.into_iter().map(|owner| {
		let udb = Arc::clone(&udb);
		async move {
			let pin_id = history_pin::database_fork_pin_id(owner);
			udb.txn("test_concurrent_history_pin_delete", move |tx| {
				let pin_id = pin_id.clone();
				async move { history_pin::delete_db_history_pin(&tx, branch_id, &pin_id).await }
			})
			.await
		}
	});
	let create_survivor = {
		let udb = Arc::clone(&udb);
		async move {
			udb.txn(
				"test_concurrent_history_pin_survivor",
				move |tx| async move {
					history_pin::write_database_fork_pin(
						&tx,
						branch_id,
						surviving_owner,
						[0x43; 16],
						2,
						1_001,
					)
					.await
				},
			)
			.await
		}
	};
	let delete_all = stream::iter(delete_futures)
		.buffer_unordered(16)
		.try_collect::<Vec<_>>();
	let (_deleted, ()) = tokio::try_join!(delete_all, create_survivor)?;

	assert_eq!(
		read_value(&test_ctx, db_pin_txid_count_key(branch_id, 2)).await?,
		Some(Vec::new()),
		"concurrent last-delete decisions must not erase a racing creator"
	);
	let total = udb
		.txn(
			"test_read_concurrent_history_pin_total",
			move |tx| async move {
				history_pin::read_indexed_pin_count(
					&tx,
					branch_id,
					universaldb::utils::IsolationLevel::Serializable,
				)
				.await
			},
		)
		.await?;
	assert_eq!(total, 1);

	let survivor_pin_id = history_pin::database_fork_pin_id(surviving_owner);
	udb.txn("test_delete_concurrent_history_pin_survivor", move |tx| {
		let pin_id = survivor_pin_id.clone();
		async move { history_pin::delete_db_history_pin(&tx, branch_id, &pin_id).await }
	})
	.await?;
	assert!(
		read_value(&test_ctx, db_pin_txid_count_key(branch_id, 2))
			.await?
			.is_none()
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn hot_compaction_policy_lookup_ignores_global_pointer_cardinality() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "forced-compaction-nondefault-pitr";
	let db = make_db(&test_ctx, database_id)?;
	let now_ms = rivet_util::timestamp::now();
	db.commit(vec![dirty_page(1, 0x31)], 2, now_ms.saturating_sub(2))
		.await?;
	db.commit(vec![dirty_page(2, 0x32)], 2, now_ms.saturating_sub(1))
		.await?;
	let database_branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let udb = test_ctx.pools().udb()?;
	set_database_pitr_policy_override(
		&udb,
		BucketId::from_gas_id(test_bucket()),
		database_id,
		PitrPolicy {
			interval_ms: 1,
			retention_ms: 24 * 60 * 60 * 1000,
		},
	)
	.await?;

	// These keys sort before ordinary random bucket branches and contain deliberately invalid
	// pointer values. The former implementation scanned the entire global pointer partition and
	// would fail on the first row. Branch-local policy ownership must not read any of them, no
	// matter how many unrelated tenants exist.
	udb.txn(
		"test_seed_unrelated_database_pointers",
		move |tx| async move {
			for idx in 0..2_048 {
				tx.informal().set(
					&database_pointer_cur_key(
						BucketBranchId::nil(),
						&format!("unrelated-tenant-{idx:04}"),
					),
					&[0xff],
				);
			}
			Ok(())
		},
	)
	.await?;

	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_workflow_id = driver.start_manager(database_branch_id, None, true).await?;
	let result = driver
		.force_compaction(
			manager_workflow_id,
			database_branch_id,
			ForceCompactionWork {
				hot: true,
				cold: false,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;

	assert_eq!(result.attempted_job_kinds, vec![CompactionJobKind::Hot]);
	assert_eq!(result.completed_job_ids.len(), 1);
	assert!(
		result.terminal_error.is_none(),
		"branch-local lookup should ignore every unrelated global pointer: {:?}",
		result.terminal_error
	);
	let root = read_value(&test_ctx, branch_compaction_root_key(database_branch_id))
		.await?
		.context("hot compaction root was not published")?;
	assert_eq!(decode_compaction_root(&root)?.hot_watermark_txid, 2);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn hot_planner_reads_only_delta_referenced_pidx_keys() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "forced-compaction-exact-pidx";
	let db = make_db(&test_ctx, database_id)?;
	db.commit(vec![dirty_page(1, 0x37)], 2, 1_000).await?;
	let database_branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let udb = test_ctx.pools().udb()?;
	udb.txn("test_seed_unrelated_pidx_rows", move |tx| async move {
		for pgno in 10_000..12_048 {
			tx.informal()
				.set(&branch_pidx_key(database_branch_id, pgno), &[0xff]);
		}
		Ok(())
	})
	.await?;

	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_workflow_id = driver.start_manager(database_branch_id, None, true).await?;
	let result = driver
		.force_compaction(
			manager_workflow_id,
			database_branch_id,
			ForceCompactionWork {
				hot: true,
				cold: false,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert!(
		result.terminal_error.is_none(),
		"unrelated PIDX cardinality must not enter the hot planning transaction: {result:?}"
	);
	let root = read_value(&test_ctx, branch_compaction_root_key(database_branch_id))
		.await?
		.context("hot root should publish with unrelated PIDX rows")?;
	assert_eq!(decode_compaction_root(&root)?.hot_watermark_txid, 1);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn point_page_read_ignores_unrelated_pidx_cardinality() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "point-read-exact-pidx";
	let db = make_db(&test_ctx, database_id)?;
	db.commit(vec![dirty_page(1, 0x3a)], 2, 1_000).await?;
	let database_branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let udb = test_ctx.pools().udb()?;
	udb.txn(
		"test_seed_unrelated_pidx_rows_before_page_read",
		move |tx| async move {
			for pgno in 10_000..12_048 {
				tx.informal()
					.set(&branch_pidx_key(database_branch_id, pgno), &[0xff]);
			}
			Ok(())
		},
	)
	.await?;

	let pages = db.get_pages(vec![1]).await?;
	assert_eq!(pages.len(), 1);
	assert_eq!(pages[0].bytes, Some(vec![0x3a; PAGE_SIZE as usize]));

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn hot_planner_rejects_corrupt_delta_referenced_pidx() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "forced-compaction-corrupt-referenced-pidx";
	let db = make_db(&test_ctx, database_id)?;
	db.commit(vec![dirty_page(1, 0x38)], 2, 1_000).await?;
	let database_branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let udb = test_ctx.pools().udb()?;
	udb.txn("test_corrupt_referenced_pidx_row", move |tx| async move {
		tx.informal()
			.set(&branch_pidx_key(database_branch_id, 1), &[0xff]);
		Ok(())
	})
	.await?;

	let err = read_hot_input_plan_for_test(&udb, database_branch_id, 2_000)
		.await
		.expect_err("referenced PIDX corruption must reject the hot plan");
	assert!(
		err.chain().any(|cause| cause
			.to_string()
			.contains("branch pidx value had invalid length")),
		"a malformed authoritative PIDX row must fail closed: {err:#}"
	);
	assert!(
		read_value(&test_ctx, branch_compaction_root_key(database_branch_id))
			.await?
			.is_none(),
		"failed planning must not publish a hot root"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn missing_branch_policy_binding_fails_closed_instead_of_using_defaults() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "forced-compaction-missing-policy-binding";
	let db = make_db(&test_ctx, database_id)?;
	db.commit(vec![dirty_page(1, 0x39)], 2, 1_000).await?;
	let database_branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let udb = test_ctx.pools().udb()?;
	udb.txn(
		"test_remove_database_policy_binding",
		move |tx| async move {
			tx.informal()
				.clear(&database_policy_binding_key(database_branch_id));
			Ok(())
		},
	)
	.await?;

	let err = read_effective_pitr_policy_for_test(&udb, database_branch_id)
		.await
		.expect_err("missing ownership must stop compaction before retention is selected");
	assert!(
		err.chain().any(|cause| cause
			.to_string()
			.contains("has no policy binding; compaction is stopped")),
		"unexpected error: {err:#}"
	);
	assert!(
		read_value(&test_ctx, branch_compaction_root_key(database_branch_id))
			.await?
			.is_none(),
		"policy lookup must not publish any compaction state"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn hot_compaction_reads_bucket_policy_from_branch_shard_replica() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "forced-compaction-bucket-policy-shard";
	let db = make_db(&test_ctx, database_id)?;
	let now_ms = rivet_util::timestamp::now();
	let default_bucket_start_ms =
		now_ms.div_euclid(DEFAULT_PITR_INTERVAL_MS) * DEFAULT_PITR_INTERVAL_MS;
	let second_wall_clock_ms = default_bucket_start_ms.saturating_sub(1);
	let first_wall_clock_ms = second_wall_clock_ms.saturating_sub(1);
	db.commit(vec![dirty_page(1, 0x41)], 2, first_wall_clock_ms)
		.await?;
	db.commit(vec![dirty_page(2, 0x42)], 2, second_wall_clock_ms)
		.await?;
	let database_branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let bucket_id = BucketId::from_gas_id(test_bucket());
	let udb = test_ctx.pools().udb()?;
	set_bucket_pitr_policy(
		&udb,
		bucket_id,
		PitrPolicy {
			interval_ms: 1,
			retention_ms: 24 * 60 * 60 * 1000,
		},
	)
	.await?;
	// If compaction accidentally falls back to the canonical hot key, this makes the lookup use
	// defaults and only one interval bucket. All 256 branch-hashed replicas remain intact.
	udb.txn(
		"test_remove_canonical_bucket_policy",
		move |tx| async move {
			tx.informal().clear(&bucket_policy_pitr_key(bucket_id));
			Ok(())
		},
	)
	.await?;

	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_workflow_id = driver.start_manager(database_branch_id, None, true).await?;
	let result = driver
		.force_compaction(
			manager_workflow_id,
			database_branch_id,
			ForceCompactionWork {
				hot: true,
				cold: false,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert!(result.terminal_error.is_none(), "{result:?}");
	for bucket_start_ms in [first_wall_clock_ms, second_wall_clock_ms] {
		assert!(
			read_value(
				&test_ctx,
				branch_pitr_interval_key(database_branch_id, bucket_start_ms),
			)
			.await?
			.is_some(),
			"branch-hashed bucket policy should retain interval {bucket_start_ms}"
		);
	}

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn hot_compaction_splits_pitr_generation_amplification_before_stage_limit() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "forced-compaction-pitr-output-budget";
	let db = make_db(&test_ctx, database_id)?;
	let wall_clock_base = rivet_util::timestamp::now().saturating_sub(100);
	let db_size_pages = 32 * depot::keys::SHARD_SIZE + 1;
	for shard_id in 1..=32_u32 {
		let mut pages = vec![dirty_page(
			shard_id * depot::keys::SHARD_SIZE,
			shard_id as u8,
		)];
		if shard_id == 32 {
			// This page belongs to the first candidate commit but its live PIDX owner is the
			// second physical compaction batch. The first batch must leave it in the index.
			pages.push(dirty_page(depot::keys::SHARD_SIZE, 0xee));
		}
		db.commit(
			pages,
			db_size_pages,
			wall_clock_base.saturating_add(i64::from(shard_id)),
		)
		.await?;
	}
	let database_branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let udb = test_ctx.pools().udb()?;
	set_database_pitr_policy_override(
		&udb,
		BucketId::from_gas_id(test_bucket()),
		database_id,
		PitrPolicy {
			interval_ms: 1,
			retention_ms: 24 * 60 * 60 * 1000,
		},
	)
	.await?;
	let first_plan = read_hot_input_plan_for_test(
		&udb,
		database_branch_id,
		wall_clock_base.saturating_add(100),
	)
	.await?;
	assert_eq!(first_plan.selected_max_txid, Some(31));
	assert!(
		!first_plan
			.pidx_entries
			.contains(&(depot::keys::SHARD_SIZE, 32)),
		"the first bounded batch must not clear a page whose authoritative owner is in the next batch"
	);

	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_workflow_id = driver.start_manager(database_branch_id, None, true).await?;
	let work = ForceCompactionWork {
		hot: true,
		cold: false,
		reclaim: false,
		final_settle: false,
	};
	let result = driver
		.force_compaction(manager_workflow_id, database_branch_id, work)
		.await?;
	assert!(result.terminal_error.is_none(), "{result:?}");
	let final_root = read_value(&test_ctx, branch_compaction_root_key(database_branch_id))
		.await?
		.context("second bounded hot root should publish")?;
	let final_root = decode_compaction_root(&final_root)?;
	assert_eq!(final_root.hot_watermark_txid, 32);
	assert_eq!(
		final_root.manifest_generation, 2,
		"31 cumulative generations produce 496 stage rows; adding generation 32 would produce 528, so two physical hot generations must publish"
	);
	assert!(
		read_value(
			&test_ctx,
			branch_compaction_hot_publish_key(database_branch_id, 1),
		)
		.await?
		.is_none(),
		"a later serial publication must retire the previous replay proof"
	);
	assert!(
		read_value(
			&test_ctx,
			branch_compaction_hot_publish_key(database_branch_id, 2),
		)
		.await?
		.is_some(),
		"the newest hot publication must retain its response-loss replay proof"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn test_driver_reclaims_deltas_only_after_hot_shard_publish() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "forced-compaction-test-driver-reclaim";
	let db = make_db(&test_ctx, database_id)?;
	db.commit(vec![dirty_page(1, 0x44)], 2, 1_000).await?;
	let database_branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let quota_before_compaction = read_branch_quota(&test_ctx, database_branch_id).await?;
	let udb = test_ctx.pools().udb()?;
	let commit = commit_row(&udb, database_branch_id, 1).await?;
	udb.txn(
		"test_seed_unrelated_pidx_rows_before_reclaim",
		move |tx| async move {
			for pgno in 10_000..12_048 {
				tx.informal()
					.set(&branch_pidx_key(database_branch_id, pgno), &[0xff]);
			}
			Ok(())
		},
	)
	.await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_workflow_id = driver.start_manager(database_branch_id, None, true).await?;

	let requested_work = ForceCompactionWork {
		hot: true,
		cold: false,
		reclaim: true,
		final_settle: false,
	};
	let result = driver
		.force_compaction(manager_workflow_id, database_branch_id, requested_work)
		.await?;

	assert_eq!(result.requested_work, requested_work);
	assert_eq!(
		result.attempted_job_kinds,
		vec![CompactionJobKind::Hot, CompactionJobKind::Reclaim]
	);
	assert_eq!(result.completed_job_ids.len(), 2);
	assert!(result.skipped_noop_reasons.is_empty());
	assert!(result.terminal_error.is_none());

	assert!(
		read_value(&test_ctx, branch_shard_key(database_branch_id, 0, 1))
			.await?
			.is_some(),
		"hot shard must be published before reclaim can complete"
	);
	assert!(
		read_value(&test_ctx, branch_pidx_key(database_branch_id, 1))
			.await?
			.is_none(),
		"published hot shard must replace the live PIDX reference"
	);
	let pidx_root = read_value(
		&test_ctx,
		branch_pidx_count_node_key(database_branch_id, 0, 4),
	)
	.await?
	.context("PIDX cardinality root should remain after hot clear")?;
	assert_eq!(
		i64::from_le_bytes(
			pidx_root
				.try_into()
				.map_err(|value: Vec<u8>| anyhow::anyhow!("PIDX root had {} bytes", value.len()))?,
		),
		0,
		"hot install must update the same bounded cardinality tree used by truncate"
	);
	assert!(
		read_value(&test_ctx, branch_delta_chunk_key(database_branch_id, 1, 0))
			.await?
			.is_none(),
		"reclaim must delete the covered delta"
	);
	assert!(
		read_value(&test_ctx, branch_page_history_key(database_branch_id, 1, 1))
			.await?
			.is_none(),
		"reclaim must delete the exact page-history row for the covered delta"
	);
	assert!(
		read_value(&test_ctx, branch_commit_key(database_branch_id, 1))
			.await?
			.is_none(),
		"reclaim must delete the covered commit row"
	);
	assert_eq!(
		read_value(&test_ctx, branch_pidx_key(database_branch_id, 10_000)).await?,
		Some(vec![0xff]),
		"reclaim must neither scan nor mutate unrelated live-page index rows"
	);
	assert!(
		read_value(
			&test_ctx,
			branch_vtx_key(database_branch_id, commit.versionstamp)
		)
		.await?
		.is_none(),
		"reclaim must delete the matching VTX row"
	);
	assert!(
		read_branch_quota(&test_ctx, database_branch_id).await? < quota_before_compaction,
		"hot install and reclaim must debit their exact durable rows from the branch quota"
	);
	let pages = db.get_pages(vec![1]).await?;
	assert_eq!(pages.len(), 1);
	assert_eq!(pages[0].bytes, Some(vec![0x44; PAGE_SIZE as usize]));

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn reclaimer_can_process_one_maximum_dirty_page_commit() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "forced-compaction-reclaim-max-commit";
	let db = make_db(&test_ctx, database_id)?;
	let dirty_pages = (1..=u32::try_from(depot::MAX_COMMIT_DIRTY_PAGES)?)
		.map(|pgno| dirty_page(pgno, u8::try_from(pgno % 251).unwrap_or(0)))
		.collect::<Vec<_>>();
	db.commit(
		dirty_pages,
		u32::try_from(depot::MAX_COMMIT_DIRTY_PAGES)?,
		1_000,
	)
	.await?;
	let database_branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_workflow_id = driver.start_manager(database_branch_id, None, true).await?;
	let requested_work = ForceCompactionWork {
		hot: true,
		cold: false,
		reclaim: true,
		final_settle: false,
	};
	let result = driver
		.force_compaction(manager_workflow_id, database_branch_id, requested_work)
		.await?;
	assert!(result.terminal_error.is_none(), "{result:?}");
	assert_eq!(result.completed_job_ids.len(), 2, "{result:?}");
	assert!(
		read_value(&test_ctx, branch_delta_chunk_key(database_branch_id, 1, 0))
			.await?
			.is_none(),
		"maximum legal commit must not be permanently stuck at the reclaim queue head"
	);
	for pgno in [1, u32::try_from(depot::MAX_COMMIT_DIRTY_PAGES)?] {
		assert!(
			read_value(
				&test_ctx,
				branch_page_history_key(database_branch_id, pgno, 1)
			)
			.await?
			.is_none(),
			"reclaim must remove page-history row {pgno}"
		);
	}

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn reverse_vtx_and_shard_lookup_ignore_older_version_cardinality() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "compaction-reverse-version-lookup-scale";
	let db = make_db(&test_ctx, database_id)?;
	db.commit(vec![dirty_page(1, 0x31)], 2, 1_000).await?;
	let database_branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let udb = test_ctx.pools().udb()?;
	let commit = commit_row(&udb, database_branch_id, 1).await?;
	assert_ne!(commit.versionstamp, [0; 16]);

	udb.txn(
		"test_seed_older_vtx_and_shard_versions",
		move |tx| async move {
			for offset in 0..2_048_u64 {
				let mut older_versionstamp = [0_u8; 16];
				older_versionstamp[8..].copy_from_slice(&offset.to_be_bytes());
				assert!(older_versionstamp < commit.versionstamp);
				tx.informal().set(
					&branch_vtx_key(database_branch_id, older_versionstamp),
					&999_u64.to_be_bytes(),
				);
				tx.informal().set(
					&branch_shard_key(database_branch_id, 0, offset + 2),
					&depot::ltx::encode_ltx_v3(
						depot::ltx::LtxHeader::delta(offset + 2, 2, 1_000),
						&[dirty_page(1, 0x99)],
					)?,
				);
			}
			tx.informal().set(
				&branch_shard_key(database_branch_id, 0, 1),
				&depot::ltx::encode_ltx_v3(
					depot::ltx::LtxHeader::delta(1, 2, 1_000),
					&[dirty_page(1, 0x31)],
				)?,
			);
			Ok(())
		},
	)
	.await?;

	let latest = latest_commit_at_or_before_versionstamp_for_test(
		&udb,
		database_branch_id,
		commit.versionstamp,
	)
	.await?
	.context("latest commit should resolve")?;
	assert_eq!(latest.0, 1);
	assert_eq!(latest.1, commit.versionstamp);
	let shard = load_latest_branch_shard_blob_for_test(&udb, database_branch_id, 0, 1)
		.await?
		.context("capped shard should resolve")?;
	let decoded = depot::ltx::decode_ltx_v3(&shard)?;
	assert_eq!(
		decoded.get_page(1),
		Some(vec![0x31; PAGE_SIZE as usize].as_slice())
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn pitr_reclaim_plan_ignores_future_index_cardinality_with_bounded_proof() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "compaction-pitr-index-cardinality";
	let db = make_db(&test_ctx, database_id)?;
	db.commit(vec![dirty_page(1, 0x11)], 1, 1_000).await?;
	let database_branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let udb = test_ctx.pools().udb()?;
	let live = PitrIntervalCoverage {
		txid: 50,
		versionstamp: [50; 16],
		wall_clock_ms: 2_000,
		expires_at_ms: 10_000,
	};
	udb.txn("test_seed_large_future_pitr_index", move |tx| {
		let live = live.clone();
		async move {
			tx.informal().set(
				&branch_pitr_interval_key(database_branch_id, 2_000),
				&encode_pitr_interval_coverage(live.clone())?,
			);
			tx.informal().set(
				&branch_pitr_interval_by_txid_key(database_branch_id, live.txid, 2_000),
				&[],
			);
			tx.informal().set(
				&branch_pitr_interval_due_key(database_branch_id, live.expires_at_ms, 2_000),
				&live.txid.to_be_bytes(),
			);
			for offset in 0..2_048_u64 {
				let txid = 10_000 + offset;
				let bucket = 1_000_000 + i64::try_from(offset)?;
				tx.informal().set(
					&branch_pitr_interval_by_txid_key(database_branch_id, txid, bucket),
					&[],
				);
				tx.informal().set(
					&branch_pitr_interval_due_key(database_branch_id, bucket, bucket),
					&txid.to_be_bytes(),
				);
			}
			Ok(())
		}
	})
	.await?;

	let plan = read_pitr_reclaim_plan_for_test(&udb, database_branch_id, 5_000).await?;
	assert!(plan.proof_complete);
	assert_eq!(plan.retained_txids, vec![50]);
	assert!(plan.expired_bucket_starts_ms.is_empty());
	assert_eq!(
		read_live_pitr_txids_in_ranges_for_test(&udb, database_branch_id, vec![(1, 40)], 5_000,)
			.await?,
		Some(Vec::new())
	);
	assert_eq!(
		read_live_pitr_txids_in_ranges_for_test(&udb, database_branch_id, vec![(40, 60)], 5_000,)
			.await?,
		Some(vec![50])
	);
	assert_eq!(
		read_live_pitr_txids_in_ranges_for_test(
			&udb,
			database_branch_id,
			vec![(1, 20_000)],
			5_000,
		)
		.await?,
		None,
		"an oversized relevant proof must retain history instead of scanning past the limit"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn reclaim_planner_rejects_corrupt_delta_referenced_pidx() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "forced-compaction-reclaim-corrupt-referenced-pidx";
	let db = make_db(&test_ctx, database_id)?;
	db.commit(vec![dirty_page(1, 0x45)], 2, 1_000).await?;
	let database_branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let udb = test_ctx.pools().udb()?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_workflow_id = driver.start_manager(database_branch_id, None, true).await?;
	let hot = driver
		.force_compaction(
			manager_workflow_id,
			database_branch_id,
			ForceCompactionWork {
				hot: true,
				cold: false,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert!(hot.terminal_error.is_none(), "{hot:?}");
	udb.txn(
		"test_corrupt_reclaim_referenced_pidx",
		move |tx| async move {
			tx.informal()
				.set(&branch_pidx_key(database_branch_id, 1), &[0xff]);
			Ok(())
		},
	)
	.await?;

	let err = read_hot_input_plan_for_test(&udb, database_branch_id, rivet_util::timestamp::now())
		.await
		.expect_err("reclaim must reject a malformed PIDX row referenced by its DELTA batch");
	assert!(
		err.chain().any(|cause| cause
			.to_string()
			.contains("branch pidx value had invalid length")),
		"unexpected reclaim planning error: {err:#}"
	);
	assert!(
		read_value(&test_ctx, branch_commit_key(database_branch_id, 1))
			.await?
			.is_some(),
		"failed reclaim planning must preserve the commit and DELTA proof"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn reclaim_planner_rejects_missing_delta_page_history() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "forced-compaction-reclaim-missing-page-history";
	let db = make_db(&test_ctx, database_id)?;
	db.commit(vec![dirty_page(1, 0x46)], 2, 1_000).await?;
	let database_branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let udb = test_ctx.pools().udb()?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_workflow_id = driver.start_manager(database_branch_id, None, true).await?;
	let hot = driver
		.force_compaction(
			manager_workflow_id,
			database_branch_id,
			ForceCompactionWork {
				hot: true,
				cold: false,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert!(hot.terminal_error.is_none(), "{hot:?}");
	udb.txn("test_remove_reclaim_page_history", move |tx| async move {
		tx.informal()
			.clear(&branch_page_history_key(database_branch_id, 1, 1));
		Ok(())
	})
	.await?;

	let err = read_hot_input_plan_for_test(&udb, database_branch_id, rivet_util::timestamp::now())
		.await
		.expect_err("reclaim must reject a missing page-history row referenced by its DELTA batch");
	assert!(
		err.chain().any(|cause| cause
			.to_string()
			.contains("page-history row is missing for reclaim candidate")),
		"unexpected reclaim planning error: {err:#}"
	);
	assert!(
		read_value(&test_ctx, branch_delta_chunk_key(database_branch_id, 1, 0))
			.await?
			.is_some(),
		"failed reclaim planning must preserve the DELTA proof"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn reconciler_recovers_a_lost_post_commit_wakeup() -> Result<()> {
	let mut test_ctx = TestCtx::new(build_registry()).await?;
	let database_id = "compaction-reconciler-lost-wakeup";
	let udb_pool = test_ctx.pools().udb()?;
	let failing_signaler = Arc::new(|_| {
		async move { Err(anyhow::anyhow!("injected post-commit wakeup failure")) }.boxed()
	});
	let db = Db::new_with_compaction_signaler(
		Arc::new((*udb_pool).clone()),
		test_bucket(),
		database_id.to_string(),
		NodeId::new(),
		failing_signaler,
	);

	db.commit(vec![dirty_page(1, 1)], 2, 1_001).await?;
	let database_branch_id = read_database_branch_id(&test_ctx, database_id).await?;
	let compaction_threshold = depot::quota::compaction_delta_threshold(database_branch_id);
	for txid in 2..=compaction_threshold {
		db.commit(
			vec![dirty_page(1, u8::try_from(txid).unwrap_or(u8::MAX))],
			2,
			1_000 + i64::try_from(txid)?,
		)
		.await?;
	}
	assert!(
		read_value(&test_ctx, sqlite_cmp_dirty_key(database_branch_id))
			.await?
			.is_some(),
		"UniversalDB dirty marker must survive the lost wakeup"
	);

	test_ctx
		.workflow(DbCompactionReconcilerInput {})
		.unique()
		.dispatch()
		.await?;
	wait_for_reconciled_hot_compaction(&test_ctx, database_branch_id, compaction_threshold).await?;

	let tag_value = depot::workflows::compaction::database_branch_tag_value(database_branch_id);
	assert!(
		test_ctx
			.find_workflow::<DbManagerWorkflow>((DATABASE_BRANCH_ID_TAG, &tag_value))
			.await?
			.is_some(),
		"reconciler must idempotently create the branch manager"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn reconciler_scans_dirty_branch_whose_uuid_starts_with_ff() -> Result<()> {
	let test_deps = rivet_test_deps::TestDeps::new().await?;
	let database_branch_id = DatabaseBranchId::from_uuid(Uuid::from_bytes([
		0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
	]));
	let dirty_key = sqlite_cmp_dirty_key(database_branch_id);
	let dirty_prefix = depot::keys::sqlite_cmp_dirty_prefix();
	assert_eq!(dirty_key[dirty_prefix.len()], 0xff);

	let udb = test_deps.pools().udb()?;
	let dirty_key_for_seed = dirty_key.clone();
	udb.txn("test_seed_ff_dirty_branch", move |tx| {
		let dirty_key = dirty_key_for_seed.clone();
		async move {
			tx.informal().set(
				&dirty_key,
				&encode_sqlite_cmp_dirty(SqliteCmpDirty {
					observed_head_txid: 1,
					updated_at_ms: 1,
				})?,
			);
			Ok(())
		}
	})
	.await?;

	let found = scan_dirty_branch_ids_for_test(&udb)
		.await?
		.contains(&database_branch_id);
	udb.txn("test_cleanup_ff_dirty_branch", move |tx| {
		let dirty_key = dirty_key.clone();
		async move {
			tx.informal().clear(&dirty_key);
			Ok(())
		}
	})
	.await?;
	assert!(
		found,
		"reconciler omitted dirty branch whose UUID starts with 0xff"
	);

	Ok(())
}

#[tokio::test]
async fn reconciler_claims_due_branch_with_latest_marker_and_persists_backoff() -> Result<()> {
	let test_deps = rivet_test_deps::TestDeps::new().await?;
	let branch_id = DatabaseBranchId::new_v4();
	let scheduled_dirty = SqliteCmpDirty {
		observed_head_txid: 129,
		updated_at_ms: 1_000,
	};
	let latest_dirty = SqliteCmpDirty {
		observed_head_txid: 133,
		updated_at_ms: 2_000,
	};
	let due_key = sqlite_cmp_dirty_due_key(1, branch_id, scheduled_dirty.updated_at_ms, 0);
	let locator_key = sqlite_cmp_dirty_due_locator_key(branch_id);
	let udb = test_deps.pools().udb()?;
	let seed_due_key = due_key.clone();
	let seed_locator_key = locator_key.clone();
	udb.txn("test_seed_due_dirty_branch", move |tx| {
		let dirty = latest_dirty.clone();
		let due_key = seed_due_key.clone();
		let locator_key = seed_locator_key.clone();
		async move {
			tx.informal().set(
				&sqlite_cmp_dirty_key(branch_id),
				&encode_sqlite_cmp_dirty(dirty)?,
			);
			tx.informal().set(&due_key, &[]);
			tx.informal().set(&locator_key, &due_key);
			Ok(())
		}
	})
	.await?;

	assert_eq!(claim_due_branch_ids_for_test(&udb).await?, vec![branch_id]);
	assert!(read_database_value(&udb, due_key).await?.is_none());
	let retry_key = read_database_value(&udb, locator_key)
		.await?
		.context("due claim must persist the retry before returning the signal")?;
	let (retry_at_ms, retry_branch_id, retry_dirty_at_ms, retry_attempt) =
		decode_sqlite_cmp_dirty_due_key(&retry_key)?;
	assert_eq!(retry_branch_id, branch_id);
	assert_eq!(retry_dirty_at_ms, 2_000);
	assert_eq!(retry_attempt, 1);
	assert!(retry_at_ms > rivet_util::timestamp::now());
	assert!(claim_due_branch_ids_for_test(&udb).await?.is_empty());

	Ok(())
}

#[tokio::test]
async fn reconciler_backfills_legacy_dirty_marker_without_immediate_wake_storm() -> Result<()> {
	let test_deps = rivet_test_deps::TestDeps::new().await?;
	let branch_id = DatabaseBranchId::new_v4();
	let dirty = SqliteCmpDirty {
		observed_head_txid: 129,
		updated_at_ms: 2_000,
	};
	let udb = test_deps.pools().udb()?;
	udb.txn("test_seed_legacy_dirty_branch", move |tx| {
		let dirty = dirty.clone();
		async move {
			tx.informal().set(
				&sqlite_cmp_dirty_key(branch_id),
				&encode_sqlite_cmp_dirty(dirty)?,
			);
			Ok(())
		}
	})
	.await?;

	assert!(claim_due_branch_ids_for_test(&udb).await?.is_empty());
	let due_key = read_database_value(&udb, sqlite_cmp_dirty_due_locator_key(branch_id))
		.await?
		.context("legacy dirty marker must receive a retry locator")?;
	let (due_at_ms, due_branch_id, dirty_at_ms, attempt) =
		decode_sqlite_cmp_dirty_due_key(&due_key)?;
	assert_eq!(due_branch_id, branch_id);
	assert_eq!(dirty_at_ms, 2_000);
	assert_eq!(attempt, 0);
	let now_ms = rivet_util::timestamp::now();
	assert!(due_at_ms > now_ms);
	assert!(due_at_ms <= now_ms + 11 * 60 * 1000);

	Ok(())
}

async fn read_value(test_ctx: &TestCtx, key: Vec<u8>) -> Result<Option<Vec<u8>>> {
	let db = test_ctx.pools().udb()?;
	read_database_value(&db, key).await
}

async fn read_database_value(db: &universaldb::Database, key: Vec<u8>) -> Result<Option<Vec<u8>>> {
	db.txn("test_read_value", move |tx| {
		let key = key.clone();
		async move {
			Ok(tx
				.informal()
				.get(&key, universaldb::utils::IsolationLevel::Snapshot)
				.await?
				.map(Vec::<u8>::from))
		}
	})
	.await
}

async fn commit_row(
	db: &universaldb::Database,
	database_branch_id: DatabaseBranchId,
	txid: u64,
) -> Result<depot::types::CommitRow> {
	let value = db
		.txn("test_read_commit_row", move |tx| async move {
			Ok(tx
				.informal()
				.get(
					&branch_commit_key(database_branch_id, txid),
					universaldb::utils::IsolationLevel::Snapshot,
				)
				.await?
				.map(Vec::<u8>::from))
		})
		.await?
		.context("commit row should exist before reclaim")?;

	depot::types::decode_commit_row(&value)
}
