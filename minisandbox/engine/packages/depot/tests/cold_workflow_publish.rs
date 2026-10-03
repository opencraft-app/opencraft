#![cfg(feature = "test-faults")]

use std::{path::Path, sync::Arc, time::Duration};

use anyhow::{Context, Result, ensure};
use aws_config::Region;
use aws_sdk_s3::primitives::ByteStream;
#[cfg(feature = "foundationdb")]
use depot::types::CommitOptions;
use depot::{
	MAX_COMMIT_DIRTY_PAGES,
	cold_tier::{
		accounting::{
			ColdStorageAccountingDelta, apply_delta_for_branch, read as read_cold_accounting,
		},
		cold_tier_from_config, validate_cold_shard_object,
	},
	conveyer::shard_blob::write_branch_shard_blob,
	conveyer::{Db, branch, history_pin, policy},
	error::SqliteStorageError,
	fault::{
		ColdCompactionFaultPoint, DepotFaultController, DepotFaultPoint, HotCompactionFaultPoint,
	},
	keys::{
		PAGE_SIZE, SHARD_SIZE, branch_bucket_proof_complete_key,
		branch_bucket_proof_epoch_shard_prefix, branch_bucket_proof_root_prefix,
		branch_bucket_proof_seen_prefix, branch_cold_upload_job_queue_prefix, branch_commit_key,
		branch_compaction_cold_publish_key, branch_compaction_cold_publish_prefix,
		branch_compaction_cold_publish_refcount_key, branch_compaction_cold_shard_key,
		branch_compaction_cold_shard_prefix, branch_compaction_cold_upload_intent_prefix,
		branch_compaction_hot_generation_key, branch_compaction_hot_publish_key,
		branch_compaction_hot_shard_coverage_key, branch_compaction_retired_cold_object_due_key,
		branch_compaction_retired_cold_object_key, branch_compaction_root_key,
		branch_compaction_stage_hot_shard_prefix, branch_delta_chunk_key,
		branch_manifest_last_access_bucket_key, branch_meta_truncate_txid_key,
		branch_pidx_count_node_key, branch_pidx_key, branch_pidx_prefix, branch_shard_chunk_key,
		branch_shard_key, branches_list_key, bucket_branches_list_key, bucket_catalog_by_db_key,
		hot_compaction_job_queue_prefix,
	},
	ltx::{LtxHeader, encode_ltx_v3},
	types::{
		BranchState, BucketBranchId, BucketBranchRecord, BucketCatalogDbFact, BucketId,
		ColdBackupRecoveryFence, ColdShardRef, DatabaseBranchId, DirtyPage, GetPagesOptions,
		HotShardCoverage, PageSourceKind, PitrPolicy, ResolvedVersionstamp, RestorePointId,
		ShardCachePolicy, SnapshotSelector, decode_cold_publish_marker, decode_cold_shard_ref,
		decode_commit_row, decode_compaction_root, decode_database_branch_record,
		decode_hot_generation_manifest, decode_hot_publish_marker, decode_hot_shard_coverage,
		decode_hot_shard_manifest, decode_retired_cold_object, encode_bucket_branch_record,
		encode_bucket_catalog_db_fact, encode_cold_shard_ref, encode_database_branch_record,
		encode_hot_shard_coverage, encode_retired_cold_object,
	},
	workflows::compaction::{
		CompactionJobKind, DepotCompactionTestDriver, ForceCompactionWork,
		advance_bucket_fork_proof_for_test,
		test_hooks::{
			fail_cold_upload_shard_for_test, max_observed_cold_upload_concurrency_for_test,
			observe_cold_upload_concurrency_for_test, observe_reclaim_control_for_test,
			observed_reclaim_control_for_test, override_cold_object_delete_grace_for_test,
			register_workflow_fault_controller,
		},
	},
};
use futures_util::TryStreamExt;
use gas::prelude::{Id, TestCtx};
use rivet_config::config::{
	Sqlite, SqliteWorkflowColdStorage, SqliteWorkflowColdStorageFileSystem,
	SqliteWorkflowColdStorageS3, SqliteWorkflowColdStorageS3AddressingStyle,
};
use rivet_pools::NodeId;
use rivet_test_deps::TestDeps;
use sha2::{Digest, Sha256};
use tempfile::Builder;
use universaldb::{RangeOption, options::StreamingMode, utils::end_of_prefix_range};
use uuid::Uuid;

fn test_bucket() -> Id {
	Id::v1(Uuid::from_u128(0xc01d), 1)
}

#[cfg(feature = "foundationdb")]
fn lowercase_hex(bytes: &[u8]) -> String {
	const DIGITS: &[u8; 16] = b"0123456789abcdef";
	let mut encoded = String::with_capacity(bytes.len() * 2);
	for byte in bytes {
		encoded.push(char::from(DIGITS[usize::from(byte >> 4)]));
		encoded.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
	}
	encoded
}

fn incompressible_test_page(seed: u64) -> Vec<u8> {
	let mut page = Vec::with_capacity(PAGE_SIZE as usize);
	for block in 0_u64..u64::from(PAGE_SIZE) / 32 {
		let mut hash = Sha256::new();
		hash.update(seed.to_be_bytes());
		hash.update(block.to_be_bytes());
		page.extend_from_slice(&hash.finalize());
	}
	page
}

async fn test_ctx_with_filesystem_cold_tier(root: &std::path::Path) -> Result<TestCtx> {
	test_ctx_with_cold_tier(SqliteWorkflowColdStorage::FileSystem(
		SqliteWorkflowColdStorageFileSystem {
			root: root.display().to_string(),
			recovery_window_ms: 7 * 24 * 60 * 60 * 1000,
			max_object_size_bytes: 4 * 1024 * 1024,
			max_concurrent_requests: 4,
			max_queued_requests: 16,
			queue_timeout_ms: 15_000,
		},
	))
	.await
}

async fn test_ctx_with_cold_tier(
	workflow_cold_storage: SqliteWorkflowColdStorage,
) -> Result<TestCtx> {
	let mut test_deps = TestDeps::new().await?;
	let mut config_root = (**test_deps.config()).clone();
	config_root.sqlite = Some(Sqlite {
		unstable_disable_compaction: Some(false),
		workflow_cold_storage: Some(workflow_cold_storage),
		workflow_write_debt: Default::default(),
		backup_recovery_fence_controller: None,
	});
	test_deps.config = rivet_config::Config::from_root(config_root);
	TestCtx::new_with_deps(depot::registry()?, test_deps).await
}

#[cfg(feature = "foundationdb")]
async fn test_ctx_with_foundationdb_cold_tier(
	workflow_cold_storage: SqliteWorkflowColdStorage,
) -> Result<Option<TestCtx>> {
	let Some(cluster_file) = std::env::var_os("FDB_CLUSTER_FILE") else {
		return Ok(None);
	};
	let mut test_deps = TestDeps::new().await?;
	let mut config_root = (**test_deps.config()).clone();
	config_root.database = Some(rivet_config::config::Database::FoundationDb(
		rivet_config::config::db::FoundationDb {
			cluster_file: Some(cluster_file.into()),
			transaction_retry_limit: 10,
			// The qualification FDB cluster is reused by several isolated test Cells.
			allow_shared_cluster: true,
		},
	));
	config_root.sqlite = Some(Sqlite {
		unstable_disable_compaction: Some(false),
		workflow_cold_storage: Some(workflow_cold_storage),
		workflow_write_debt: Default::default(),
		backup_recovery_fence_controller: None,
	});
	let config = rivet_config::Config::from_root(config_root);
	let pools = rivet_pools::Pools::test(config.clone()).await?;
	test_deps.config = config;
	test_deps.pools = pools;

	Ok(Some(
		TestCtx::new_with_deps(depot::registry()?, test_deps).await?,
	))
}

fn s3_client(
	endpoint: &str,
	region: &str,
) -> impl std::future::Future<Output = aws_sdk_s3::Client> {
	let endpoint = endpoint.to_string();
	let region = region.to_string();
	let force_path_style = !matches!(
		std::env::var("RIVET_TEST_S3_ADDRESSING_STYLE").as_deref(),
		Ok("virtual")
	);
	async move {
		let shared_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
			.region(Region::new(region))
			.load()
			.await;
		aws_sdk_s3::Client::from_conf(
			aws_sdk_s3::config::Builder::from(&shared_config)
				.endpoint_url(endpoint)
				.force_path_style(force_path_style)
				.build(),
		)
	}
}

fn s3_addressing_style() -> SqliteWorkflowColdStorageS3AddressingStyle {
	if matches!(
		std::env::var("RIVET_TEST_S3_ADDRESSING_STYLE").as_deref(),
		Ok("virtual")
	) {
		SqliteWorkflowColdStorageS3AddressingStyle::VirtualHosted
	} else {
		SqliteWorkflowColdStorageS3AddressingStyle::Path
	}
}

async fn make_db(test_ctx: &TestCtx, database_id: &str) -> Result<Db> {
	let udb = test_ctx.pools().udb()?;
	let cold_tier = cold_tier_from_config(test_ctx.config())
		.await?
		.context("test cold tier should be configured")?;
	Ok(Db::new_with_cold_tier(
		Arc::new((*udb).clone()),
		test_bucket(),
		database_id.to_string(),
		NodeId::new(),
		cold_tier,
	))
}

fn make_fdb_only_db(test_ctx: &TestCtx, database_id: &str) -> Result<Db> {
	let udb = test_ctx.pools().udb()?;
	Ok(Db::new(
		Arc::new((*udb).clone()),
		test_bucket(),
		database_id.to_string(),
		NodeId::new(),
	))
}

async fn read_database_branch_id(
	test_ctx: &TestCtx,
	database_id: &str,
) -> Result<DatabaseBranchId> {
	let udb = test_ctx.pools().udb()?;
	let database_id = database_id.to_string();
	udb.txn("test_resolve_cold_workflow_branch", move |tx| {
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

async fn read_value(test_ctx: &TestCtx, key: Vec<u8>) -> Result<Option<Vec<u8>>> {
	let udb = test_ctx.pools().udb()?;
	udb.txn("test_read_cold_workflow_value", move |tx| {
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

async fn clear_value(test_ctx: &TestCtx, key: Vec<u8>) -> Result<()> {
	let udb = test_ctx.pools().udb()?;
	udb.txn("test_clear_cold_workflow_value", move |tx| {
		let key = key.clone();
		async move {
			tx.informal().clear(&key);
			Ok(())
		}
	})
	.await
}

async fn set_value(test_ctx: &TestCtx, key: Vec<u8>, value: Vec<u8>) -> Result<()> {
	let udb = test_ctx.pools().udb()?;
	udb.txn("test_set_cold_workflow_value", move |tx| {
		let key = key.clone();
		let value = value.clone();
		async move {
			tx.informal().set(&key, &value);
			Ok(())
		}
	})
	.await
}

async fn certify_backup_after(
	test_ctx: &TestCtx,
	tombstone_versionstamp: &[u8; 16],
) -> Result<ColdBackupRecoveryFence> {
	assert_ne!(
		*tombstone_versionstamp,
		depot::conveyer::udb::INCOMPLETE_VERSIONSTAMP,
		"retirement transaction must substitute its durable versionstamp"
	);
	let udb = test_ctx.pools().udb()?;
	let verified_at_ms = rivet_util::timestamp::now();
	let fence = depot::backup_fence::certify_cold_backup_recovery_fence(
		&udb,
		[0x42; 32],
		ColdBackupRecoveryFence {
			policy_fingerprint: [0x42; 32],
			minimum_restorable_version: depot::backup_fence::fdb_commit_version(
				tombstone_versionstamp,
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
	Ok(fence)
}

async fn write_hot_shard(
	test_ctx: &TestCtx,
	branch_id: DatabaseBranchId,
	shard_id: u32,
	as_of_txid: u64,
	blob: Vec<u8>,
) -> Result<()> {
	let udb = test_ctx.pools().udb()?;
	udb.txn("test_write_chunked_hot_shard", move |tx| {
		let blob = blob.clone();
		async move { write_branch_shard_blob(&tx, branch_id, shard_id, as_of_txid, &blob) }
	})
	.await
}

async fn read_prefix_values(
	test_ctx: &TestCtx,
	prefix: Vec<u8>,
) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
	const TEST_PREFIX_ROW_LIMIT: usize = 4_096;
	let udb = test_ctx.pools().udb()?;
	udb.txn("test_read_cold_workflow_prefix", move |tx| {
		let prefix = prefix.clone();
		async move {
			let end = end_of_prefix_range(&prefix);
			let informal = tx.informal();
			let mut stream = informal.get_ranges_keyvalues(
				RangeOption {
					limit: Some(TEST_PREFIX_ROW_LIMIT.saturating_add(1)),
					mode: StreamingMode::Exact,
					..(prefix.as_slice(), end.as_slice()).into()
				},
				universaldb::utils::IsolationLevel::Snapshot,
			);
			let mut rows = Vec::new();
			while let Some(entry) = stream.try_next().await? {
				rows.push((entry.key().to_vec(), entry.value().to_vec()));
			}
			ensure!(
				rows.len() <= TEST_PREFIX_ROW_LIMIT,
				"cold workflow fixture exceeded bounded test prefix budget"
			);
			Ok(rows)
		}
	})
	.await
}

async fn setup_evicted_cold_shard(
	prefix: &str,
) -> Result<(
	tempfile::TempDir,
	TestCtx,
	Db,
	DatabaseBranchId,
	ColdShardRef,
)> {
	let (cold_root, test_ctx, db, branch_id, reference, manager_id) =
		setup_published_cold_shard(prefix).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let reclaim = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(reclaim.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"fixture must begin after exact hot eviction"
	);

	Ok((cold_root, test_ctx, db, branch_id, reference))
}

async fn setup_published_cold_shard(
	prefix: &str,
) -> Result<(
	tempfile::TempDir,
	TestCtx,
	Db,
	DatabaseBranchId,
	ColdShardRef,
	Id,
)> {
	let cold_root = Builder::new().prefix(prefix).tempdir()?;
	let test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("cold-workflow-fail-closed-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x5a; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let publish = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(publish.terminal_error, None);
	assert!(
		read_prefix_values(&test_ctx, branch_cold_upload_job_queue_prefix(branch_id),)
			.await?
			.is_empty(),
		"atomic cold publish must drain its durable job backlog row"
	);
	let reference = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.context("exact cold ref should be published")?,
	)?;
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_some(),
		"published fixture must retain its hot shard before reclaim"
	);

	Ok((cold_root, test_ctx, db, branch_id, reference, manager_id))
}

async fn setup_two_published_cold_versions(
	prefix: &str,
) -> Result<(
	tempfile::TempDir,
	TestCtx,
	Db,
	DatabaseBranchId,
	ColdShardRef,
	ColdShardRef,
	Id,
)> {
	let cold_root = Builder::new().prefix(prefix).tempdir()?;
	let test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("cold-workflow-two-versions-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x41; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let first = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(first.terminal_error, None);
	let first_ref = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.context("first cold version should be published")?,
	)?;

	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x42; PAGE_SIZE as usize],
		}],
		2,
		2_000,
	)
	.await?;
	let second = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(second.terminal_error, None);
	let second_ref = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 2))
			.await?
			.context("second cold version should be published")?,
	)?;
	Ok((
		cold_root, test_ctx, db, branch_id, first_ref, second_ref, manager_id,
	))
}

fn contains_storage_error(
	error: &anyhow::Error,
	predicate: impl Fn(&SqliteStorageError) -> bool,
) -> bool {
	error.chain().any(|cause| {
		cause
			.downcast_ref::<SqliteStorageError>()
			.is_some_and(&predicate)
	})
}

fn cold_object_files(root: &Path) -> Result<Vec<std::path::PathBuf>> {
	let mut pending = vec![root.to_path_buf()];
	let mut files = Vec::new();
	while let Some(directory) = pending.pop() {
		for entry in std::fs::read_dir(directory)? {
			let entry = entry?;
			let path = entry.path();
			if path.is_dir() {
				pending.push(path);
			} else if path
				.extension()
				.is_some_and(|extension| extension == "cold")
			{
				files.push(path);
			}
		}
	}
	files.sort();
	Ok(files)
}

async fn publish_one_cold_shard_with_response_loss(
	prefix: &str,
	fault_point: ColdCompactionFaultPoint,
) -> Result<(
	tempfile::TempDir,
	TestCtx,
	Db,
	DatabaseBranchId,
	ColdShardRef,
	Id,
)> {
	let cold_root = Builder::new().prefix(prefix).tempdir()?;
	let test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("cold-workflow-response-loss-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x6d; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let controller = DepotFaultController::new();
	controller
		.at(DepotFaultPoint::ColdCompaction(fault_point))
		.database_branch_id(branch_id)
		.once()
		.fail("simulated lost cold activity response")?;
	let _fault_guard = register_workflow_fault_controller(branch_id, controller.clone());
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let published = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(published.terminal_error, None);
	controller.assert_expected_fired()?;
	let reference = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.context("cold ref should publish after activity response loss")?,
	)?;
	Ok((cold_root, test_ctx, db, branch_id, reference, manager_id))
}

#[tokio::test]
async fn exact_put_precedes_atomic_fdb_publish_and_reclaim() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-cold-workflow-publish-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("cold-workflow-publish-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x5a; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;

	let result = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(
		result.attempted_job_kinds,
		vec![CompactionJobKind::Hot, CompactionJobKind::Cold]
	);
	assert_eq!(result.completed_job_ids.len(), 2);
	assert_eq!(result.terminal_error, None);

	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("compaction root should be published")?,
	)?;
	assert_eq!(root.hot_watermark_txid, 1);
	assert_eq!(root.cold_watermark_txid, 1);
	assert_eq!(root.manifest_generation, 2);

	let reference = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.context("exact cold shard ref should be atomically published")?,
	)?;
	let object_bytes = tokio::fs::read(cold_root.path().join(&reference.object_key)).await?;
	let (_, cold_ltx) = validate_cold_shard_object(&reference, &object_bytes)?;
	assert_eq!(cold_ltx.header.max_txid, 1);
	assert_eq!(cold_ltx.pages[0].bytes, vec![0x5a; PAGE_SIZE as usize]);
	assert!(
		read_value(&test_ctx, branch_commit_key(branch_id, 1))
			.await?
			.is_some(),
		"publishing cold refs must not reclaim commit history in the same transaction"
	);

	let reclaim = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(
		reclaim.attempted_job_kinds,
		vec![CompactionJobKind::Reclaim]
	);
	assert!(
		read_value(&test_ctx, branch_commit_key(branch_id, 1))
			.await?
			.is_none()
	);
	assert!(
		read_value(&test_ctx, branch_delta_chunk_key(branch_id, 1, 0))
			.await?
			.is_none()
	);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"proof-gated reclaim should evict the exact hot shard after cold publication"
	);

	let read = db
		.get_pages_with_options(
			vec![1],
			GetPagesOptions {
				collect_provenance: true,
				..Default::default()
			},
		)
		.await?;
	assert_eq!(read.pages[0].bytes, Some(vec![0x5a; PAGE_SIZE as usize]));
	assert_eq!(read.provenance[0].winner_kind, PageSourceKind::ColdShard);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_some(),
		"a validated cold read should refill the exact FDB hot-cache row"
	);

	let immediate_reclaim = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(immediate_reclaim.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_some(),
		"recent-access retention should protect a freshly refilled hot shard"
	);

	// Prove that the logical database override actually reaches reclaim planning. Move the
	// throttled access bucket two slots into the past: a 1ms policy considers it stale, while the
	// previous hard-coded seven-day default would still retain it.
	let udb = test_ctx.pools().udb()?;
	policy::set_database_shard_cache_policy_override(
		&udb,
		BucketId::from_gas_id(test_bucket()),
		&database_id,
		ShardCachePolicy { retention_ms: 1 },
	)
	.await?;
	udb.txn("test_age_shard_cache_access", move |tx| async move {
		let key = branch_manifest_last_access_bucket_key(branch_id);
		let bytes = tx
			.informal()
			.get(&key, universaldb::utils::IsolationLevel::Serializable)
			.await?
			.context("cold refill should record the branch access bucket")?;
		let bucket = i64::from_le_bytes(
			bytes
				.as_slice()
				.try_into()
				.context("branch access bucket should be exactly 8 bytes")?,
		);
		tx.informal()
			.set(&key, &bucket.saturating_sub(2).to_le_bytes());
		Ok(())
	})
	.await?;
	let short_policy_reclaim = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(short_policy_reclaim.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"database shard-cache policy override must make the stale hot shard evictable"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn cold_disabled_force_is_noop_and_missing_hot_coverage_fails_closed() -> Result<()> {
	let mut test_ctx = TestCtx::new(depot::registry()?).await?;
	let database_id = format!("cold-disabled-{}", Uuid::new_v4());
	let db = make_fdb_only_db(&test_ctx, &database_id)?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x43; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let result = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(result.terminal_error, None);
	assert_eq!(result.attempted_job_kinds, vec![CompactionJobKind::Hot]);
	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("hot-only root should publish when cold storage is disabled")?,
	)?;
	assert_eq!(root.hot_watermark_txid, 1);
	assert_eq!(root.cold_watermark_txid, 0);
	assert!(
		read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.is_none()
	);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_some()
	);

	clear_value(&test_ctx, branch_shard_key(branch_id, 0, 1)).await?;
	let missing = db
		.get_pages(vec![1])
		.await
		.expect_err("missing authoritative FDB shard must not become a zero page");
	assert!(contains_storage_error(&missing, |error| matches!(
		error,
		SqliteStorageError::ShardCoverageMissing { pgno: 1 }
	)));

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn published_hot_coverage_rejects_a_valid_but_different_shard_blob() -> Result<()> {
	let mut test_ctx = TestCtx::new(depot::registry()?).await?;
	let database_id = format!("hot-coverage-corrupt-{}", Uuid::new_v4());
	let db = make_fdb_only_db(&test_ctx, &database_id)?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x43; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let hot = driver
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
	assert_eq!(hot.terminal_error, None);

	// Keep the LTX syntactically valid so this proves the read path verifies the atomic content
	// identity, not merely that a row exists or that its payload parses.
	let replacement = encode_ltx_v3(
		LtxHeader::delta(1, 2, 1_000),
		&[DirtyPage {
			pgno: 1,
			bytes: vec![0x99; PAGE_SIZE as usize],
		}],
	)?;
	set_value(&test_ctx, branch_shard_key(branch_id, 0, 1), replacement).await?;
	let corrupt = db
		.get_pages(vec![1])
		.await
		.expect_err("a different valid shard must not bypass the published coverage proof");
	assert!(contains_storage_error(&corrupt, |error| matches!(
		error,
		SqliteStorageError::ShardCoverageMissing { pgno: 1 }
	)));

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn missing_latest_hot_coverage_does_not_fall_back_to_an_older_shard() -> Result<()> {
	let mut test_ctx = TestCtx::new(depot::registry()?).await?;
	let database_id = format!("hot-coverage-no-stale-fallback-{}", Uuid::new_v4());
	let db = make_fdb_only_db(&test_ctx, &database_id)?;
	let branch_id;
	let manager_id;
	{
		db.commit(
			vec![DirtyPage {
				pgno: 1,
				bytes: vec![0x31; PAGE_SIZE as usize],
			}],
			2,
			1_000,
		)
		.await?;
		branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
		let driver = DepotCompactionTestDriver::new(&test_ctx);
		manager_id = driver.start_manager(branch_id, None, true).await?;
		let first = driver
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
		assert_eq!(first.terminal_error, None);
	}
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x32; PAGE_SIZE as usize],
		}],
		2,
		2_000,
	)
	.await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let second = driver
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
	assert_eq!(second.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_some(),
		"the test requires the older cache generation to remain available"
	);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 2))
			.await?
			.is_some(),
		"the second hot generation should be authoritative before sabotage"
	);

	clear_value(&test_ctx, branch_shard_key(branch_id, 0, 2)).await?;
	let missing = db
		.get_pages(vec![1])
		.await
		.expect_err("the latest proof must prevent fallback to an older, valid shard");
	assert!(contains_storage_error(&missing, |error| matches!(
		error,
		SqliteStorageError::ShardCoverageMissing { pgno: 1 }
	)));

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn cold_upload_backend_failure_keeps_hot_shard_authoritative() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-cold-workflow-upload-failure-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("cold-upload-failure-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x44; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let hot = driver
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
	assert_eq!(hot.terminal_error, None);

	// Make the configured filesystem root a regular file so every exact-key PUT fails.
	// This exercises the real backend error path instead of a workflow-only synthetic fault.
	tokio::fs::remove_dir_all(cold_root.path()).await?;
	tokio::fs::write(cold_root.path(), b"not-a-directory").await?;
	let cold = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert!(
		cold.terminal_error
			.as_deref()
			.is_some_and(|error| error.contains("cold shard upload failed")),
		"unexpected cold upload failure result: {cold:?}"
	);
	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("hot root must survive cold upload failure")?,
	)?;
	assert_eq!(root.hot_watermark_txid, 1);
	assert_eq!(root.cold_watermark_txid, 0);
	assert!(
		read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"failed PUT must not publish an authoritative cold ref"
	);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_some(),
		"failed cold upload must retain the FDB hot shard"
	);
	assert_eq!(
		db.get_pages(vec![1]).await?[0].bytes,
		Some(vec![0x44; PAGE_SIZE as usize])
	);
	assert!(
		!read_prefix_values(
			&test_ctx,
			branch_compaction_cold_upload_intent_prefix(branch_id),
		)
		.await?
		.is_empty(),
		"an unavailable cold tier must leave a durable exact-key cleanup intent"
	);
	assert_eq!(
		read_prefix_values(&test_ctx, branch_cold_upload_job_queue_prefix(branch_id),)
			.await?
			.len(),
		1,
		"one failed cold job must expose one bounded backlog row"
	);

	tokio::fs::remove_file(cold_root.path()).await?;
	tokio::fs::create_dir_all(cold_root.path()).await?;
	let cleanup = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(cleanup.terminal_error, None);
	assert!(
		read_prefix_values(
			&test_ctx,
			branch_compaction_cold_upload_intent_prefix(branch_id),
		)
		.await?
		.is_empty(),
		"the bounded reclaim lane must drain durable upload intents after recovery"
	);
	assert!(
		read_prefix_values(&test_ctx, branch_cold_upload_job_queue_prefix(branch_id),)
			.await?
			.is_empty(),
		"orphan cleanup must drain the cold job backlog row"
	);
	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn partial_cold_upload_failure_drains_paginated_exact_intents_without_list() -> Result<()> {
	// The cleanup activity is capped at 100 exact object keys per invocation. Crossing two full
	// pages proves that workflow replay drains the durable job-local index without COS LIST or an
	// unbounded FDB range read.
	const SHARD_COUNT: u32 = 201;
	const FAILED_SHARD_ID: u32 = 127;
	let cold_root = Builder::new()
		.prefix("depot-cold-workflow-partial-upload-failure-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("cold-partial-upload-failure-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	let pages = (0..SHARD_COUNT)
		.map(|shard_id| DirtyPage {
			pgno: shard_id * SHARD_SIZE + 1,
			bytes: vec![u8::try_from(shard_id + 1).unwrap(); PAGE_SIZE as usize],
		})
		.collect::<Vec<_>>();
	db.commit(pages, (SHARD_COUNT - 1) * SHARD_SIZE + 1, 1_000)
		.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let hot = driver
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
	assert_eq!(hot.terminal_error, None);

	let _failure = fail_cold_upload_shard_for_test(branch_id, FAILED_SHARD_ID);
	let cold = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert!(
		cold.terminal_error
			.as_deref()
			.is_some_and(|error| error.contains(&format!(
				"forced cold shard {FAILED_SHARD_ID} upload failure"
			))),
		"unexpected partial cold upload result: {cold:?}"
	);
	assert!(
		cold_object_files(cold_root.path())?.is_empty(),
		"all successful sibling PUTs must be removed by their durable exact keys"
	);
	assert!(
		read_prefix_values(
			&test_ctx,
			branch_compaction_cold_upload_intent_prefix(branch_id),
		)
		.await?
		.is_empty(),
		"successful exact deletion must compact every job-local upload intent"
	);
	assert!(
		read_prefix_values(&test_ctx, branch_cold_upload_job_queue_prefix(branch_id),)
			.await?
			.is_empty(),
		"paginated exact cleanup must drain the cold job backlog row"
	);
	for shard_id in 0..SHARD_COUNT {
		assert!(
			read_value(
				&test_ctx,
				branch_compaction_cold_shard_key(branch_id, shard_id, 1),
			)
			.await?
			.is_none(),
			"a failed cold generation must not leave a staged ref for shard {shard_id}"
		);
	}
	assert_eq!(
		db.get_pages(vec![1]).await?[0].bytes,
		Some(vec![1; PAGE_SIZE as usize]),
		"the FDB hot generation remains authoritative after partial upload cleanup"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn mismatched_cold_ref_cannot_authorize_hot_eviction() -> Result<()> {
	let (_cold_root, mut test_ctx, db, branch_id, mut reference, manager_id) =
		setup_published_cold_shard("depot-cold-workflow-mismatched-ref-").await?;
	reference.ltx_content_hash[0] ^= 0xff;
	set_value(
		&test_ctx,
		branch_compaction_cold_shard_key(branch_id, 0, 1),
		encode_cold_shard_ref(reference)?,
	)
	.await?;

	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let reclaim = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(reclaim.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_some(),
		"a cold ref whose LTX hash no longer matches the hot shard must not authorize eviction"
	);
	assert_eq!(
		db.get_pages(vec![1]).await?[0].bytes,
		Some(vec![0x5a; PAGE_SIZE as usize])
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn newer_unpinned_cold_generation_evicts_stranded_older_hot_cache_row() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-cold-workflow-superseding-hot-proof-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("cold-superseding-hot-proof-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x41; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	assert_eq!(
		driver
			.force_compaction(
				manager_id,
				branch_id,
				ForceCompactionWork {
					hot: true,
					cold: true,
					reclaim: false,
					final_settle: false,
				},
			)
			.await?
			.terminal_error,
		None
	);
	let old_restore_point = db.create_restore_point(SnapshotSelector::Latest).await?;

	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x42; PAGE_SIZE as usize],
		}],
		2,
		2_000,
	)
	.await?;
	assert_eq!(
		driver
			.force_compaction(
				manager_id,
				branch_id,
				ForceCompactionWork {
					hot: true,
					cold: true,
					reclaim: false,
					final_settle: false,
				},
			)
			.await?
			.terminal_error,
		None
	);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_some()
	);
	assert!(
		read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 2),)
			.await?
			.is_some()
	);

	// Reproduce the production tail: the exact old ref was retired after a newer generation
	// became authoritative, but its obsolete hot cache row remains. No PITR interval or history
	// pin selects the half-open [1, 2) range.
	clear_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1)).await?;
	let pinned_reclaim = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(pinned_reclaim.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_some(),
		"a newer cold generation must not evict an older hot row selected by a history pin"
	);
	db.delete_restore_point(old_restore_point).await?;
	let reclaim = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(reclaim.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"a newer published cold generation should evict an unpinned obsolete hot cache row"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn cold_eviction_still_supports_a_restore_point_created_by_a_later_commit() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-cold-workflow-future-pin-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("cold-future-pin-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x71; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let publish = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(publish.terminal_error, None);
	let reclaim = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(reclaim.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"the old hot shard must be evicted before the later pin exists"
	);

	// The next commit and restore point are created after txid 1 has become cold-only. Reading the
	// latest pinned state must merge page 1 from the exact cold ref with page 2 from the new DELTA.
	db.commit(
		vec![DirtyPage {
			pgno: 2,
			bytes: vec![0x72; PAGE_SIZE as usize],
		}],
		2,
		2_000,
	)
	.await?;
	let restore_point = db.create_restore_point(SnapshotSelector::Latest).await?;
	let read = db
		.get_pages_with_options(
			vec![1, 2],
			GetPagesOptions {
				collect_provenance: true,
				..Default::default()
			},
		)
		.await?;
	assert_eq!(read.pages[0].bytes, Some(vec![0x71; PAGE_SIZE as usize]));
	assert_eq!(read.pages[1].bytes, Some(vec![0x72; PAGE_SIZE as usize]));
	assert_eq!(read.provenance[0].winner_kind, PageSourceKind::ColdShard);
	assert_eq!(read.provenance[1].winner_kind, PageSourceKind::PidxDelta);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_some(),
		"the validated historical cold shard should refill after the future pin read"
	);
	db.delete_restore_point(restore_point).await?;

	test_ctx.shutdown().await?;
	Ok(())
}

async fn assert_head_advance_preserves_hot_prefix(point: HotCompactionFaultPoint) -> Result<()> {
	let cold_root = Builder::new().prefix("depot-hot-head-advance-").tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("hot-head-advance-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x81; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let controller = DepotFaultController::new();
	let pause = controller.pause_handle("hot-head-advance");
	controller
		.at(DepotFaultPoint::HotCompaction(point))
		.database_branch_id(branch_id)
		.once()
		.pause("hot-head-advance")?;
	let next_plan = controller.pause_handle("hot-next-prefix");
	controller
		.at(DepotFaultPoint::HotCompaction(
			HotCompactionFaultPoint::StageBeforeAdmission,
		))
		.database_branch_id(branch_id)
		.nth(2)
		.pause("hot-next-prefix")?;
	let _fault_guard = register_workflow_fault_controller(branch_id, controller.clone());
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let advance = async {
		tokio::time::timeout(Duration::from_secs(30), pause.wait_reached()).await?;
		let result = db
			.commit(
				vec![DirtyPage {
					pgno: 1,
					bytes: vec![0x82; PAGE_SIZE as usize],
				}],
				2,
				2_000,
			)
			.await;
		pause.release();
		result?;
		tokio::time::timeout(Duration::from_secs(30), next_plan.wait_reached()).await?;
		let check = async {
			let root = decode_compaction_root(
				&read_value(&test_ctx, branch_compaction_root_key(branch_id))
					.await?
					.context("first prefix should install before the next plan")?,
			)?;
			assert_eq!(root.hot_watermark_txid, 1);
			assert_eq!(
				read_value(&test_ctx, branch_pidx_key(branch_id, 1)).await?,
				Some(2_u64.to_be_bytes().to_vec()),
				"installing prefix1 must retain the newer page owner"
			);
			assert_eq!(
				read_value(&test_ctx, branch_pidx_count_node_key(branch_id, 1, 0)).await?,
				Some(1_i64.to_le_bytes().to_vec()),
				"newer PIDX owner must remain counted"
			);
			assert_eq!(
				db.get_pages(vec![1]).await?[0].bytes,
				Some(vec![0x82; PAGE_SIZE as usize])
			);
			Ok::<_, anyhow::Error>(())
		}
		.await;
		next_plan.release();
		check
	};
	let force = driver.force_compaction(
		manager_id,
		branch_id,
		ForceCompactionWork {
			hot: true,
			cold: false,
			reclaim: false,
			final_settle: false,
		},
	);
	let (advance_result, hot_result) = tokio::join!(advance, force);
	advance_result?;
	let hot = hot_result?;
	controller.assert_expected_fired()?;
	assert!(
		hot.terminal_error.is_none(),
		"unexpected hot failure: {hot:?}"
	);
	assert_eq!(
		hot.retryable_rejections, 0,
		"a newer head must not invalidate an unchanged committed prefix: {hot:?}"
	);
	assert_eq!(
		hot.completed_job_ids.len(),
		2,
		"both committed prefixes should install successfully: {hot:?}"
	);
	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("replanned job should publish a compaction root")?,
	)?;
	assert_eq!(root.hot_watermark_txid, 2);
	assert!(
		read_value(&test_ctx, branch_pidx_key(branch_id, 1))
			.await?
			.is_none()
	);
	assert_eq!(
		read_value(&test_ctx, branch_pidx_count_node_key(branch_id, 1, 0)).await?,
		Some(0_i64.to_le_bytes().to_vec()),
		"retired latest PIDX owner must be counted exactly once"
	);
	assert_eq!(
		db.get_pages(vec![1]).await?[0].bytes,
		Some(vec![0x82; PAGE_SIZE as usize])
	);
	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn head_advance_before_hot_admission_preserves_prefix_and_latest_write() -> Result<()> {
	assert_head_advance_preserves_hot_prefix(HotCompactionFaultPoint::StageBeforeAdmission).await
}

#[tokio::test]
async fn head_advance_after_hot_stage_preserves_prefix_and_latest_write() -> Result<()> {
	assert_head_advance_preserves_hot_prefix(HotCompactionFaultPoint::AfterStageBeforeFinishSignal)
		.await
}

#[tokio::test]
async fn continuous_head_advance_makes_hot_prefix_progress_without_data_loss() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-hot-plan-starvation-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("hot-plan-starvation-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x90; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let controller = DepotFaultController::new();
	let mut pauses = Vec::new();
	// Each pause represents one distinct queued plan. A real commit advances the head before it
	// enters Stage, so this is an explicit overlapping commit sequence, not a test retry loop.
	for invocation in 1..=9 {
		let checkpoint = format!("hot-plan-starvation-{invocation}");
		pauses.push(controller.pause_handle(checkpoint.clone()));
		controller
			.at(DepotFaultPoint::HotCompaction(
				HotCompactionFaultPoint::StageBeforeAdmission,
			))
			.database_branch_id(branch_id)
			.nth(invocation)
			.pause(checkpoint)?;
	}
	let _fault_guard = register_workflow_fault_controller(branch_id, controller.clone());
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let advance = async {
		for (index, pause) in pauses.iter().enumerate() {
			tokio::time::timeout(Duration::from_secs(30), pause.wait_reached()).await?;
			let result = async {
				if index > 0 {
					let root = decode_compaction_root(
						&read_value(&test_ctx, branch_compaction_root_key(branch_id))
							.await?
							.context("every previous prefix should have progressed")?,
					)?;
					anyhow::ensure!(
						root.hot_watermark_txid == index as u64,
						"previous prefix did not progress"
					);
				}
				db.commit(
					vec![DirtyPage {
						pgno: 1,
						bytes: vec![0x91 + index as u8; PAGE_SIZE as usize],
					}],
					2,
					2_000 + index as i64 * 1_000,
				)
				.await
			}
			.await;
			pause.release();
			result?;
		}
		Ok::<_, anyhow::Error>(())
	};
	let force = driver.force_compaction(
		manager_id,
		branch_id,
		ForceCompactionWork {
			hot: true,
			cold: false,
			reclaim: false,
			final_settle: false,
		},
	);
	let (advance_result, hot_result) = tokio::join!(advance, force);
	advance_result?;
	let hot = hot_result?;
	controller.assert_expected_fired()?;
	assert_eq!(
		hot.retryable_rejections, 0,
		"future commits must not starve prefix progress: {hot:?}"
	);
	assert_eq!(hot.completed_job_ids.len(), 10);
	assert!(
		hot.terminal_error.is_none(),
		"unexpected force result: {hot:?}"
	);
	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("all committed prefixes should install")?,
	)?;
	assert_eq!(root.hot_watermark_txid, 10);
	assert_eq!(
		db.get_pages(vec![1]).await?[0].bytes,
		Some(vec![0x99; PAGE_SIZE as usize])
	);
	test_ctx.shutdown().await?;
	Ok(())
}

async fn assert_hot_prefix_revalidates_history(
	point: HotCompactionFaultPoint,
	add_fork: bool,
) -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-hot-prefix-history-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("hot-prefix-history-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	let udb = test_ctx.pools().udb()?;
	// Both commits are in one recent PITR bucket, so the original plan covers txid 2 only.
	let bucket_ms = PitrPolicy::default().interval_ms;
	let first_ms = (rivet_util::timestamp::now() / bucket_ms - 1) * bucket_ms + 1_000;
	for (index, fill) in [0xa1, 0xa2].into_iter().enumerate() {
		db.commit(
			vec![DirtyPage {
				pgno: 1,
				bytes: vec![fill; PAGE_SIZE as usize],
			}],
			2,
			first_ms + index as i64 * 1_000,
		)
		.await?;
	}
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let controller = DepotFaultController::new();
	let first_commit = decode_commit_row(
		&read_value(&test_ctx, branch_commit_key(branch_id, 1))
			.await?
			.context("first committed version should exist")?,
	)?;
	let pause = controller.pause_handle("hot-prefix-history");
	controller
		.at(DepotFaultPoint::HotCompaction(point))
		.database_branch_id(branch_id)
		.once()
		.pause("hot-prefix-history")?;
	let _fault_guard = register_workflow_fault_controller(branch_id, controller.clone());
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let change_history = async {
		tokio::time::timeout(Duration::from_secs(30), pause.wait_reached()).await?;
		let result = async {
			let fork_id = if add_fork {
				Some(
					branch::fork_database(
						&udb,
						BucketId::from_gas_id(test_bucket()),
						database_id.clone(),
						ResolvedVersionstamp {
							versionstamp: first_commit.versionstamp,
							restore_point: None,
						},
						BucketId::from_gas_id(test_bucket()),
					)
					.await?,
				)
			} else {
				policy::set_database_pitr_policy_override(
					&udb,
					BucketId::from_gas_id(test_bucket()),
					&database_id,
					PitrPolicy {
						interval_ms: 1_000,
						..Default::default()
					},
				)
				.await?;
				None
			};
			if add_fork {
				// The new catalog root invalidates the bucket proof. Finish its bounded pages
				// before releasing Stage so this test isolates changed history coverage.
				let mut complete = false;
				for _ in 0..64 {
					if !advance_bucket_fork_proof_for_test(&udb, branch_id).await? {
						complete = true;
						break;
					}
				}
				ensure!(complete, "new fork catalog proof did not complete");
			}
			db.commit(
				vec![DirtyPage {
					pgno: 1,
					bytes: vec![0xa3; PAGE_SIZE as usize],
				}],
				2,
				first_ms + 2_000,
			)
			.await?;
			Ok::<_, anyhow::Error>(fork_id)
		}
		.await;
		pause.release();
		result
	};
	let force = driver.force_compaction(
		manager_id,
		branch_id,
		ForceCompactionWork {
			hot: true,
			cold: false,
			reclaim: false,
			final_settle: false,
		},
	);
	let (history_result, hot_result) = tokio::join!(change_history, force);
	let fork_id = history_result?;
	let hot = hot_result?;
	controller.assert_expected_fired()?;
	assert_eq!(hot.terminal_error, None);
	assert_eq!(
		hot.retryable_rejections, 1,
		"changed history coverage must invalidate the old proof: {hot:?}"
	);
	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("replanned history prefix should install")?,
	)?;
	assert_eq!(root.hot_watermark_txid, 3);
	assert!(
		read_value(
			&test_ctx,
			branch_compaction_hot_shard_coverage_key(branch_id, 0, 1)
		)
		.await?
		.is_some(),
		"replanned prefix must materialize the newly required historical version"
	);
	if !add_fork {
		assert!(
			read_value(
				&test_ctx,
				branch_compaction_hot_shard_coverage_key(branch_id, 0, 2)
			)
			.await?
			.is_some()
		);
	}
	assert_eq!(
		db.get_pages(vec![1]).await?[0].bytes,
		Some(vec![0xa3; PAGE_SIZE as usize])
	);
	if let Some(fork_id) = fork_id {
		let fork = make_db(&test_ctx, &fork_id).await?;
		assert_eq!(
			fork.get_pages(vec![1]).await?[0].bytes,
			Some(vec![0xa1; PAGE_SIZE as usize])
		);
	}
	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn hot_prefix_new_fork_pin_before_stage_requires_new_coverage() -> Result<()> {
	assert_hot_prefix_revalidates_history(HotCompactionFaultPoint::StageBeforeAdmission, true).await
}

#[tokio::test]
async fn hot_prefix_new_fork_pin_after_stage_requires_new_coverage() -> Result<()> {
	assert_hot_prefix_revalidates_history(
		HotCompactionFaultPoint::AfterStageBeforeFinishSignal,
		true,
	)
	.await
}

#[tokio::test]
async fn hot_prefix_pitr_policy_change_before_stage_requires_new_coverage() -> Result<()> {
	assert_hot_prefix_revalidates_history(HotCompactionFaultPoint::StageBeforeAdmission, false)
		.await
}

#[tokio::test]
async fn hot_prefix_pitr_policy_change_after_stage_requires_new_coverage() -> Result<()> {
	assert_hot_prefix_revalidates_history(
		HotCompactionFaultPoint::AfterStageBeforeFinishSignal,
		false,
	)
	.await
}

async fn assert_truncate_growth_fences_old_hot_prefix(
	point: HotCompactionFaultPoint,
) -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-hot-prefix-truncate-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("hot-prefix-truncate-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 3,
			bytes: vec![0xb1; PAGE_SIZE as usize],
		}],
		4,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let controller = DepotFaultController::new();
	let pause = controller.pause_handle("hot-prefix-truncate");
	controller
		.at(DepotFaultPoint::HotCompaction(point))
		.database_branch_id(branch_id)
		.once()
		.pause("hot-prefix-truncate")?;
	let _fault_guard = register_workflow_fault_controller(branch_id, controller.clone());
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let truncate = async {
		tokio::time::timeout(Duration::from_secs(30), pause.wait_reached()).await?;
		let result = async {
			db.commit(
				vec![DirtyPage {
					pgno: 1,
					bytes: vec![0xb2; PAGE_SIZE as usize],
				}],
				2,
				2_000,
			)
			.await?;
			db.commit(
				vec![DirtyPage {
					pgno: 1,
					bytes: vec![0xb3; PAGE_SIZE as usize],
				}],
				4,
				3_000,
			)
			.await?;
			Ok::<_, anyhow::Error>(())
		}
		.await;
		pause.release();
		result
	};
	let force = driver.force_compaction(
		manager_id,
		branch_id,
		ForceCompactionWork {
			hot: true,
			cold: false,
			reclaim: false,
			final_settle: false,
		},
	);
	let (truncate_result, hot_result) = tokio::join!(truncate, force);
	truncate_result?;
	let hot = hot_result?;
	controller.assert_expected_fired()?;
	assert_eq!(hot.terminal_error, None);
	let fresh = make_db(&test_ctx, &database_id).await?;
	assert_eq!(
		fresh.get_pages(vec![3]).await?[0].bytes,
		Some(vec![0; PAGE_SIZE as usize]),
		"regrowth must not resurrect a truncated page from an old prefix"
	);
	assert_eq!(
		hot.retryable_rejections, 1,
		"truncate must invalidate the old plan: {hot:?}"
	);
	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn hot_prefix_truncate_growth_before_stage_preserves_zero_gap() -> Result<()> {
	assert_truncate_growth_fences_old_hot_prefix(HotCompactionFaultPoint::StageBeforeAdmission)
		.await
}

#[tokio::test]
async fn hot_prefix_truncate_during_stage_batch_replans_without_zero_gap_loss() -> Result<()> {
	assert_truncate_growth_fences_old_hot_prefix(
		HotCompactionFaultPoint::StageAfterShardBatchFdbCommit,
	)
	.await
}

#[tokio::test]
async fn hot_prefix_truncate_after_input_check_revalidates_missing_shard_as_stale() -> Result<()> {
	assert_truncate_growth_fences_old_hot_prefix(
		HotCompactionFaultPoint::InstallAfterInputCheckBeforeShardIntegrity,
	)
	.await
}

#[tokio::test]
async fn hot_prefix_truncate_growth_after_stage_preserves_zero_gap() -> Result<()> {
	assert_truncate_growth_fences_old_hot_prefix(
		HotCompactionFaultPoint::AfterStageBeforeFinishSignal,
	)
	.await
}

async fn assert_unindexed_hot_prefix_keeps_head_fence(
	point: HotCompactionFaultPoint,
) -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-hot-prefix-unindexed-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("hot-prefix-unindexed-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0xc1; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch = read_database_branch_id(&test_ctx, &database_id).await?;
	clear_value(&test_ctx, branch_meta_truncate_txid_key(branch)).await?;
	let controller = DepotFaultController::new();
	let pause = controller.pause_handle("hot-prefix-unindexed");
	controller
		.at(DepotFaultPoint::HotCompaction(point))
		.database_branch_id(branch)
		.once()
		.pause("hot-prefix-unindexed")?;
	let _fault_guard = register_workflow_fault_controller(branch, controller.clone());
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager = driver.start_manager(branch, None, true).await?;
	let advance = async {
		tokio::time::timeout(Duration::from_secs(30), pause.wait_reached()).await?;
		let result = db
			.commit(
				vec![DirtyPage {
					pgno: 1,
					bytes: vec![0xc2; PAGE_SIZE as usize],
				}],
				2,
				2_000,
			)
			.await;
		pause.release();
		result
	};
	let force = driver.force_compaction(
		manager,
		branch,
		ForceCompactionWork {
			hot: true,
			cold: false,
			reclaim: false,
			final_settle: false,
		},
	);
	let (advance_result, force_result) = tokio::join!(advance, force);
	advance_result?;
	let hot = force_result?;
	controller.assert_expected_fired()?;
	assert_eq!(hot.terminal_error, None);
	assert_eq!(
		hot.retryable_rejections, 1,
		"an unknown history must keep the original head fence"
	);
	assert_eq!(
		read_value(&test_ctx, branch_meta_truncate_txid_key(branch)).await?,
		None
	);
	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch))
			.await?
			.context("replanned prefix must publish")?,
	)?;
	assert_eq!(root.hot_watermark_txid, 2);
	assert_eq!(
		db.get_pages(vec![1]).await?[0].bytes,
		Some(vec![0xc2; PAGE_SIZE as usize])
	);
	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn hot_prefix_unindexed_head_change_before_stage_requires_replan() -> Result<()> {
	assert_unindexed_hot_prefix_keeps_head_fence(HotCompactionFaultPoint::StageBeforeAdmission)
		.await
}

#[tokio::test]
async fn hot_prefix_unindexed_head_change_after_stage_requires_replan() -> Result<()> {
	assert_unindexed_hot_prefix_keeps_head_fence(
		HotCompactionFaultPoint::AfterStageBeforeFinishSignal,
	)
	.await
}

#[tokio::test]
async fn hot_prefix_truncate_preserves_pinned_old_eof_but_not_latest_gap() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-hot-prefix-truncate-pin-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("hot-prefix-truncate-pin-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 3,
			bytes: vec![0xd1; PAGE_SIZE as usize],
		}],
		4,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let first = decode_commit_row(
		&read_value(&test_ctx, branch_commit_key(branch_id, 1))
			.await?
			.context("first commit must exist")?,
	)?;
	let udb = test_ctx.pools().udb()?;
	let fork_id = branch::fork_database(
		&udb,
		BucketId::from_gas_id(test_bucket()),
		database_id.clone(),
		ResolvedVersionstamp {
			versionstamp: first.versionstamp,
			restore_point: None,
		},
		BucketId::from_gas_id(test_bucket()),
	)
	.await?;
	let mut complete = false;
	for _ in 0..64 {
		if !advance_bucket_fork_proof_for_test(&udb, branch_id).await? {
			complete = true;
			break;
		}
	}
	ensure!(complete, "fork catalog proof did not complete");
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0xd2; PAGE_SIZE as usize],
		}],
		2,
		2_000,
	)
	.await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0xd3; PAGE_SIZE as usize],
		}],
		3,
		3_000,
	)
	.await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager = driver.start_manager(branch_id, None, true).await?;
	let hot = driver
		.force_compaction(
			manager,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: false,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(hot.terminal_error, None);
	assert!(
		read_value(
			&test_ctx,
			branch_compaction_hot_shard_coverage_key(branch_id, 0, 1)
		)
		.await?
		.is_some()
	);
	let fork = make_db(&test_ctx, &fork_id).await?;
	assert_eq!(
		fork.get_pages(vec![3]).await?[0].bytes,
		Some(vec![0xd1; PAGE_SIZE as usize])
	);
	let fresh = make_db(&test_ctx, &database_id).await?;
	assert_eq!(
		fresh.get_pages(vec![3]).await?[0].bytes,
		Some(vec![0; PAGE_SIZE as usize])
	);
	assert_eq!(fresh.get_pages(vec![4]).await?[0].bytes, None);
	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn lifecycle_change_fences_an_inflight_hot_install() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-hot-workflow-lifecycle-fence-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("hot-lifecycle-fence-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x73; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let pidx_before = read_value(&test_ctx, branch_pidx_key(branch_id, 1)).await?;

	let controller = DepotFaultController::new();
	let pause = controller.pause_handle("hot-lifecycle-fence");
	controller
		.at(DepotFaultPoint::HotCompaction(
			HotCompactionFaultPoint::InstallBeforeRootUpdate,
		))
		.database_branch_id(branch_id)
		.once()
		.pause("hot-lifecycle-fence")?;
	let _fault_guard = register_workflow_fault_controller(branch_id, controller.clone());
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let change_lifecycle = async {
		pause.wait_reached().await;
		let mut record = decode_database_branch_record(
			&read_value(&test_ctx, branches_list_key(branch_id))
				.await?
				.context("live branch record should exist while hot install is paused")?,
		)?;
		record.lifecycle_generation = record.lifecycle_generation.saturating_add(1);
		let result = set_value(
			&test_ctx,
			branches_list_key(branch_id),
			encode_database_branch_record(record)?,
		)
		.await;
		pause.release();
		result
	};
	let force = driver.force_compaction(
		manager_id,
		branch_id,
		ForceCompactionWork {
			hot: true,
			cold: false,
			reclaim: false,
			final_settle: false,
		},
	);
	let (lifecycle_result, hot_result) = tokio::join!(change_lifecycle, force);
	lifecycle_result?;
	let hot = hot_result?;
	assert!(
		hot.terminal_error
			.as_deref()
			.is_some_and(|error| error.contains("database branch lifecycle changed")),
		"unexpected lifecycle fencing result: {hot:?}"
	);
	controller.assert_expected_fired()?;
	assert!(
		read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.is_none(),
		"an install planned against the old lifecycle must not publish a root"
	);
	assert_eq!(
		read_value(&test_ctx, branch_pidx_key(branch_id, 1)).await?,
		pidx_before,
		"the rejected install must leave the authoritative PIDX/DELTA path intact"
	);
	assert_eq!(
		db.get_pages(vec![1]).await?[0].bytes,
		Some(vec![0x73; PAGE_SIZE as usize])
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn chunked_hot_shard_survives_cold_publish_eviction_and_refill() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-cold-workflow-chunked-roundtrip-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("cold-workflow-chunked-roundtrip-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	let dirty_pages = (1..SHARD_SIZE)
		.map(|pgno| DirtyPage {
			pgno,
			bytes: incompressible_test_page(u64::from(pgno)),
		})
		.collect::<Vec<_>>();
	db.commit(dirty_pages, SHARD_SIZE - 1, 1_000).await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let publish = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(publish.terminal_error, None);
	let hot_manifest = decode_hot_shard_manifest(
		&read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.context("full hot shard should use chunk indirection")?,
	)?;
	assert!(hot_manifest.chunk_count > 1);
	let reference = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.context("chunked shard should publish an exact cold ref")?,
	)?;
	let object_bytes = tokio::fs::read(cold_root.path().join(&reference.object_key)).await?;
	let (_, cold_ltx) = validate_cold_shard_object(&reference, &object_bytes)?;
	assert_eq!(cold_ltx.pages.len(), usize::try_from(SHARD_SIZE - 1)?);
	assert_eq!(cold_ltx.pages[0].bytes, incompressible_test_page(1));
	assert_eq!(
		cold_ltx
			.pages
			.last()
			.context("cold shard should have pages")?
			.bytes,
		incompressible_test_page(u64::from(SHARD_SIZE - 1))
	);

	let reclaim = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(reclaim.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_none()
	);
	for chunk_idx in 0..hot_manifest.chunk_count {
		assert!(
			read_value(
				&test_ctx,
				branch_shard_chunk_key(branch_id, 0, 1, chunk_idx),
			)
			.await?
			.is_none(),
			"proof-gated eviction must clear hot chunk {chunk_idx}"
		);
	}

	let read = db
		.get_pages_with_options(
			vec![1, SHARD_SIZE - 1],
			GetPagesOptions {
				collect_provenance: true,
				..Default::default()
			},
		)
		.await?;
	assert_eq!(read.pages[0].bytes, Some(incompressible_test_page(1)));
	assert_eq!(
		read.pages[1].bytes,
		Some(incompressible_test_page(u64::from(SHARD_SIZE - 1)))
	);
	assert!(
		read.provenance
			.iter()
			.all(|row| row.winner_kind == PageSourceKind::ColdShard)
	);
	let refilled_manifest = decode_hot_shard_manifest(
		&read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.context("cold read should refill a chunk manifest")?,
	)?;
	assert_eq!(refilled_manifest, hot_manifest);
	for chunk_idx in 0..refilled_manifest.chunk_count {
		assert!(
			read_value(
				&test_ctx,
				branch_shard_chunk_key(branch_id, 0, 1, chunk_idx),
			)
			.await?
			.is_some(),
			"cold refill must restore hot chunk {chunk_idx}"
		);
	}

	clear_value(
		&test_ctx,
		branch_shard_chunk_key(branch_id, 0, 1, refilled_manifest.chunk_count - 1),
	)
	.await?;
	let missing_chunk = db
		.get_pages(vec![1])
		.await
		.expect_err("a missing refilled chunk must fail closed");
	assert!(
		format!("{missing_chunk:#}").contains("hot shard chunk missing"),
		"unexpected missing-chunk error: {missing_chunk:#}"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn maximum_legal_commit_survives_hot_cold_eviction_and_fresh_handle_refill() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-cold-workflow-max-commit-roundtrip-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("cold-workflow-max-commit-roundtrip-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	let max_pgno = u32::try_from(MAX_COMMIT_DIRTY_PAGES)?;
	let dirty_pages = (1..=max_pgno)
		.map(|pgno| DirtyPage {
			pgno,
			bytes: incompressible_test_page(u64::from(pgno)),
		})
		.collect::<Vec<_>>();
	db.commit(dirty_pages, max_pgno, 1_000).await?;

	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let publish = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(publish.terminal_error, None, "{publish:?}");

	// Depot deliberately maps `pgno / SHARD_SIZE`, so exact multiples start the next shard.
	// Pages 1..=320 therefore span shard ids 0..=5, not five one-based chunks.
	let max_shard_id = max_pgno / SHARD_SIZE;
	for shard_id in 0..=max_shard_id {
		assert!(
			read_value(
				&test_ctx,
				branch_compaction_cold_shard_key(branch_id, shard_id, 1),
			)
			.await?
			.is_some(),
			"maximum legal commit should publish exact cold ref for shard {shard_id}"
		);
	}

	// The 2 MiB reclaim budget is shared by hot-shard eviction and DELTA/history cleanup.
	// With incompressible boundary data those two lanes intentionally drain in separate bounded
	// FDB transactions. Prove repeated branch-local work converges without assuming one giant pass.
	let _reclaim_probe = observe_reclaim_control_for_test(branch_id);
	let mut reclaim_job_count = 0_usize;
	for pass in 0..4 {
		let delta_exists = read_value(&test_ctx, branch_delta_chunk_key(branch_id, 1, 0))
			.await?
			.is_some();
		let mut remaining_hot_shards = 0_usize;
		for shard_id in 0..=max_shard_id {
			remaining_hot_shards += usize::from(
				read_value(&test_ctx, branch_shard_key(branch_id, shard_id, 1))
					.await?
					.is_some(),
			);
		}
		if !delta_exists && remaining_hot_shards == 0 {
			break;
		}

		let reclaim = driver
			.force_compaction(
				manager_id,
				branch_id,
				ForceCompactionWork {
					hot: false,
					cold: false,
					reclaim: true,
					final_settle: false,
				},
			)
			.await?;
		assert_eq!(reclaim.terminal_error, None, "pass {pass}: {reclaim:?}");
		assert_eq!(
			reclaim.attempted_job_kinds,
			vec![CompactionJobKind::Reclaim],
			"pass {pass}: {reclaim:?}"
		);
		reclaim_job_count = reclaim_job_count.saturating_add(reclaim.completed_job_ids.len());
		if pass == 0 {
			assert!(
				read_value(&test_ctx, branch_delta_chunk_key(branch_id, 1, 0))
					.await?
					.is_none(),
				"the first forced reclaim cycle must retire DELTA/history before coverage can disappear"
			);
		}
	}
	assert!(
		read_value(&test_ctx, branch_delta_chunk_key(branch_id, 1, 0))
			.await?
			.is_none(),
		"maximum legal DELTA should drain through bounded reclaim jobs"
	);
	for shard_id in 0..=max_shard_id {
		assert!(
			read_value(&test_ctx, branch_shard_key(branch_id, shard_id, 1))
				.await?
				.is_none(),
			"proof-gated reclaim should evict hot shard {shard_id}"
		);
	}
	let (observed_reclaim_jobs, max_lane_items) = observed_reclaim_control_for_test(branch_id);
	assert_eq!(observed_reclaim_jobs, reclaim_job_count);
	assert!(
		(2..=4).contains(&reclaim_job_count),
		"incompressible boundary data should converge in a small bounded number of jobs, got {reclaim_job_count}"
	);
	assert!(
		max_lane_items
			.into_iter()
			.all(|count| count <= depot::CMP_RECLAIM_CONTROL_MAX_ITEMS_PER_LANE),
		"reclaim control lanes exceeded their cap: {max_lane_items:?}"
	);

	// Use a fresh Db handle so the read cannot win from the writer's process-local PIDX cache.
	let reopened = make_db(&test_ctx, &database_id).await?;
	let sample_pgnos = vec![1, SHARD_SIZE, SHARD_SIZE + 1, max_pgno / 2, max_pgno];
	let read = reopened
		.get_pages_with_options(
			sample_pgnos.clone(),
			GetPagesOptions {
				collect_provenance: true,
				..Default::default()
			},
		)
		.await?;
	for (fetched, pgno) in read.pages.iter().zip(sample_pgnos.iter().copied()) {
		assert_eq!(fetched.pgno, pgno);
		assert_eq!(
			fetched.bytes,
			Some(incompressible_test_page(u64::from(pgno))),
			"cold round trip changed page {pgno}"
		);
	}
	assert!(
		read.provenance
			.iter()
			.all(|row| row.winner_kind == PageSourceKind::ColdShard),
		"every sampled page should come from exact-key cold storage after eviction: {:?}",
		read.provenance
	);
	for pgno in sample_pgnos {
		let shard_id = pgno / SHARD_SIZE;
		assert!(
			read_value(&test_ctx, branch_shard_key(branch_id, shard_id, 1))
				.await?
				.is_some(),
			"validated cold read should refill hot shard {shard_id}"
		);
	}

	driver
		.destroy_manager_and_wait(manager_id, branch_id, 1)
		.await?;
	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn chunked_hot_eviction_drains_across_bounded_reclaim_jobs() -> Result<()> {
	const SHARD_COUNT: u32 = 8;
	const SHARDS_PER_COMMIT: u32 = 4;

	let cold_root = Builder::new()
		.prefix("depot-cold-workflow-bounded-chunk-eviction-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("cold-workflow-bounded-chunk-eviction-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	let mut manager = None;
	for group_start in (0..SHARD_COUNT).step_by(SHARDS_PER_COMMIT as usize) {
		let mut pages = Vec::new();
		for shard_id in group_start..group_start + SHARDS_PER_COMMIT {
			let first_pgno = (shard_id * SHARD_SIZE).max(1);
			let last_pgno = (shard_id + 1) * SHARD_SIZE - 1;
			for pgno in first_pgno..=last_pgno {
				pages.push(DirtyPage {
					pgno,
					bytes: incompressible_test_page(0xe000_0000_0000_0000 | u64::from(pgno)),
				});
			}
		}
		db.commit(
			pages,
			(group_start + SHARDS_PER_COMMIT) * SHARD_SIZE,
			i64::from(group_start + 1) * 1_000,
		)
		.await?;
		let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
		let driver =
			DepotCompactionTestDriver::new(&test_ctx).with_wait_timeout(Duration::from_secs(30));
		let manager_id = match manager {
			Some(manager_id) => manager_id,
			None => {
				let manager_id = driver.start_manager(branch_id, None, true).await?;
				manager = Some(manager_id);
				manager_id
			}
		};
		let hot = driver
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
		assert_eq!(hot.terminal_error, None);
	}

	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let manager_id = manager.context("reclaim manager should be started")?;
	let driver =
		DepotCompactionTestDriver::new(&test_ctx).with_wait_timeout(Duration::from_secs(30));
	for _ in 0..4 {
		let root = decode_compaction_root(
			&read_value(&test_ctx, branch_compaction_root_key(branch_id))
				.await?
				.context("hot root should exist")?,
		)?;
		if root.cold_watermark_txid == 2 {
			break;
		}
		let cold = driver
			.force_compaction(
				manager_id,
				branch_id,
				ForceCompactionWork {
					hot: false,
					cold: true,
					reclaim: false,
					final_settle: false,
				},
			)
			.await?;
		assert_eq!(cold.terminal_error, None);
	}
	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("cold root should exist")?,
	)?;
	assert_eq!(root.cold_watermark_txid, 2);

	let mut manifests = Vec::new();
	for shard_id in 0..SHARD_COUNT {
		let as_of_txid = if shard_id < SHARDS_PER_COMMIT { 1 } else { 2 };
		let manifest = decode_hot_shard_manifest(
			&read_value(&test_ctx, branch_shard_key(branch_id, shard_id, as_of_txid))
				.await?
				.with_context(|| format!("hot shard {shard_id} should be chunked"))?,
		)?;
		manifests.push((shard_id, as_of_txid, manifest));
	}
	let total_physical_bytes = manifests
		.iter()
		.map(|(_, _, manifest)| manifest.encoded_len)
		.sum::<u64>();
	assert!(
		total_physical_bytes > 2 * 1024 * 1024,
		"fixture must exceed one conservative reclaim value budget"
	);

	let first_reclaim = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(first_reclaim.terminal_error, None);
	let mut reclaim_job_count = first_reclaim.completed_job_ids.len();
	let mut remaining = 0;
	for (shard_id, as_of_txid, _) in &manifests {
		remaining += usize::from(
			read_value(
				&test_ctx,
				branch_shard_key(branch_id, *shard_id, *as_of_txid),
			)
			.await?
			.is_some(),
		);
	}
	assert!(
		remaining > 0 || reclaim_job_count >= 2,
		"an over-budget eviction set must not drain through one reclaim transaction"
	);

	for _ in 0..4 {
		if remaining == 0 {
			break;
		}
		let reclaim = driver
			.force_compaction(
				manager_id,
				branch_id,
				ForceCompactionWork {
					hot: false,
					cold: false,
					reclaim: true,
					final_settle: false,
				},
			)
			.await?;
		assert_eq!(reclaim.terminal_error, None);
		reclaim_job_count += reclaim.completed_job_ids.len();
		remaining = 0;
		for (shard_id, as_of_txid, _) in &manifests {
			remaining += usize::from(
				read_value(
					&test_ctx,
					branch_shard_key(branch_id, *shard_id, *as_of_txid),
				)
				.await?
				.is_some(),
			);
		}
	}
	assert_eq!(remaining, 0, "bounded reclaim jobs must drain the backlog");
	assert!(
		reclaim_job_count >= 2,
		"the physical chunk budget must split this fixture across reclaim jobs"
	);
	for (shard_id, as_of_txid, manifest) in manifests {
		for chunk_idx in 0..manifest.chunk_count {
			assert!(
				read_value(
					&test_ctx,
					branch_shard_chunk_key(branch_id, shard_id, as_of_txid, chunk_idx),
				)
				.await?
				.is_none(),
				"drained reclaim backlog must remove shard {shard_id} chunk {chunk_idx}"
			);
		}
	}

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn cold_upload_response_loss_retries_the_same_exact_object_key() -> Result<()> {
	let (cold_root, mut test_ctx, db, _branch_id, reference, _manager_id) =
		publish_one_cold_shard_with_response_loss(
			"depot-cold-workflow-upload-response-loss-",
			ColdCompactionFaultPoint::UploadAfterObjectPut,
		)
		.await?;
	let files = cold_object_files(cold_root.path())?;
	assert_eq!(
		files,
		vec![cold_root.path().join(&reference.object_key)],
		"replaying one durable cold job must overwrite the same content-addressed key, not leak an orphan generation"
	);
	let pages = db.get_pages(vec![1]).await?;
	assert_eq!(pages[0].bytes, Some(vec![0x6d; PAGE_SIZE as usize]));
	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn cold_publish_response_loss_replays_as_idempotent_success() -> Result<()> {
	let (cold_root, mut test_ctx, db, branch_id, reference, manager_id) =
		publish_one_cold_shard_with_response_loss(
			"depot-cold-workflow-publish-response-loss-",
			ColdCompactionFaultPoint::PublishAfterFdbCommit,
		)
		.await?;
	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("atomic cold root should survive publish response loss")?,
	)?;
	let marker = decode_cold_publish_marker(
		&read_value(
			&test_ctx,
			branch_compaction_cold_publish_key(branch_id, reference.publish_generation),
		)
		.await?
		.context("atomic cold marker should survive publish response loss")?,
	)?;
	assert_eq!(root.cold_watermark_txid, 1);
	assert!(marker.matches_ref(&reference));
	assert_eq!(cold_object_files(cold_root.path())?.len(), 1);

	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let reclaimed = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(reclaimed.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"a successfully replayed publish must remain eligible for proof-gated hot eviction"
	);
	let pages = db.get_pages(vec![1]).await?;
	assert_eq!(pages[0].bytes, Some(vec![0x6d; PAGE_SIZE as usize]));
	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn hot_install_response_loss_replays_from_atomic_publish_proof() -> Result<()> {
	let replay_before = depot::metrics::SQLITE_COMPACTION_JOBS_TOTAL
		.with_label_values(&["hot_install", "already_applied"])
		.get();
	let error_before = depot::metrics::SQLITE_COMPACTION_JOBS_TOTAL
		.with_label_values(&["hot_install", "error"])
		.get();
	let cold_root = Builder::new()
		.prefix("depot-hot-workflow-publish-response-loss-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("hot-workflow-response-loss-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x6e; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let controller = DepotFaultController::new();
	controller
		.at(DepotFaultPoint::HotCompaction(
			HotCompactionFaultPoint::InstallAfterFdbCommit,
		))
		.database_branch_id(branch_id)
		.once()
		.fail("simulated lost hot install activity response")?;
	let _fault_guard = register_workflow_fault_controller(branch_id, controller.clone());
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let hot = driver
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
	assert_eq!(hot.terminal_error, None);
	controller.assert_expected_fired()?;
	// Run this test alone for an isolated diagnostic assertion. These process
	// counters are not an exactly-once durable publication ledger: the injected
	// commit-before-response failure is an error exit, and its replay is distinct.
	assert!(
		depot::metrics::SQLITE_COMPACTION_JOBS_TOTAL
			.with_label_values(&["hot_install", "already_applied"])
			.get() > replay_before
	);
	assert!(
		depot::metrics::SQLITE_COMPACTION_JOBS_TOTAL
			.with_label_values(&["hot_install", "error"])
			.get() > error_before
	);

	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("hot root should survive install response loss")?,
	)?;
	assert_eq!(root.hot_watermark_txid, 1);
	let marker = decode_hot_publish_marker(
		&read_value(
			&test_ctx,
			branch_compaction_hot_publish_key(branch_id, root.manifest_generation),
		)
		.await?
		.context("hot publish marker should prove the committed install")?,
	)?;
	assert_eq!(marker.max_txid, 1);
	let manifest = decode_hot_generation_manifest(
		&read_value(
			&test_ctx,
			branch_compaction_hot_generation_key(branch_id, 1),
		)
		.await?
		.context("hot generation manifest should survive install response loss")?,
	)?;
	assert_eq!(manifest.shards.len(), 1);
	let coverage = decode_hot_shard_coverage(
		&read_value(
			&test_ctx,
			branch_compaction_hot_shard_coverage_key(branch_id, 0, 1),
		)
		.await?
		.context("hot shard coverage should commit atomically before response loss")?,
	)?;
	assert_eq!(coverage.database_branch_id, branch_id);
	assert_eq!(coverage.shard_id, 0);
	assert_eq!(coverage.as_of_txid, 1);
	assert_eq!(coverage.size_bytes, manifest.shards[0].size_bytes);
	assert_eq!(coverage.content_hash, manifest.shards[0].content_hash);
	assert!(
		read_prefix_values(
			&test_ctx,
			branch_compaction_stage_hot_shard_prefix(branch_id, marker.job_id),
		)
		.await?
		.is_empty(),
		"the idempotent replay must not depend on already-cleared staged rows"
	);
	assert!(
		read_prefix_values(&test_ctx, hot_compaction_job_queue_prefix())
			.await?
			.is_empty(),
		"atomic hot install replay must clear its global in-flight job row"
	);

	let cold = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(cold.terminal_error, None);
	assert!(
		read_value(
			&test_ctx,
			branch_compaction_hot_generation_key(branch_id, 1)
		)
		.await?
		.is_none(),
		"cold publication should consume the bounded hot backlog manifest atomically"
	);
	let pages = db.get_pages(vec![1]).await?;
	assert_eq!(pages[0].bytes, Some(vec![0x6e; PAGE_SIZE as usize]));
	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn hot_stage_batch_response_loss_replays_chunked_shards_idempotently() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-hot-workflow-stage-batch-response-loss-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("hot-stage-batch-response-loss-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	let pages = (1..(2 * SHARD_SIZE))
		.map(|pgno| DirtyPage {
			pgno,
			bytes: incompressible_test_page(0xb000_0000_0000_0000 | u64::from(pgno)),
		})
		.collect::<Vec<_>>();
	db.commit(pages, 2 * SHARD_SIZE, 1_000).await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let controller = DepotFaultController::new();
	controller
		.at(DepotFaultPoint::HotCompaction(
			HotCompactionFaultPoint::StageAfterShardBatchFdbCommit,
		))
		.database_branch_id(branch_id)
		.once()
		.fail("simulated lost staged shard batch activity response")?;
	let _fault_guard = register_workflow_fault_controller(branch_id, controller.clone());
	let driver =
		DepotCompactionTestDriver::new(&test_ctx).with_wait_timeout(Duration::from_secs(30));
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let hot = driver
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
	assert_eq!(hot.terminal_error, None);
	controller.assert_expected_fired()?;

	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("hot root should publish after staged batch response loss")?,
	)?;
	assert_eq!(root.hot_watermark_txid, 1);
	let marker = decode_hot_publish_marker(
		&read_value(
			&test_ctx,
			branch_compaction_hot_publish_key(branch_id, root.manifest_generation),
		)
		.await?
		.context("hot marker should prove replayed staged batch install")?,
	)?;
	assert!(
		read_prefix_values(
			&test_ctx,
			branch_compaction_stage_hot_shard_prefix(branch_id, marker.job_id),
		)
		.await?
		.is_empty(),
		"successful install must consume all replayed stage proofs"
	);
	for shard_id in 0..2 {
		let row = read_value(&test_ctx, branch_shard_key(branch_id, shard_id, 1))
			.await?
			.context("replayed chunked hot shard should exist")?;
		let manifest = decode_hot_shard_manifest(&row)?;
		assert!(manifest.chunk_count > 1);
		for chunk_idx in 0..manifest.chunk_count {
			assert!(
				read_value(
					&test_ctx,
					branch_shard_chunk_key(branch_id, shard_id, 1, chunk_idx),
				)
				.await?
				.is_some(),
				"every replayed shard chunk must remain present"
			);
		}
	}
	let result = db
		.get_pages(vec![1, SHARD_SIZE, 2 * SHARD_SIZE - 1])
		.await?;
	for page in result {
		assert_eq!(
			page.bytes,
			Some(incompressible_test_page(
				0xb000_0000_0000_0000 | u64::from(page.pgno)
			))
		);
	}

	test_ctx.shutdown().await?;
	Ok(())
}

#[derive(Clone, Copy)]
enum StagedChunkSabotage {
	Missing,
	Corrupt,
}

async fn assert_hot_install_rejects_staged_chunk_sabotage(
	test_name: &str,
	fault_point: HotCompactionFaultPoint,
	sabotage_kind: StagedChunkSabotage,
	expected_error: &str,
) -> Result<()> {
	let cold_root = Builder::new()
		.prefix(&format!("depot-hot-workflow-{test_name}-"))
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("hot-{test_name}-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	let dirty_pages = (1..SHARD_SIZE)
		.map(|pgno| DirtyPage {
			pgno,
			bytes: incompressible_test_page(0xc000_0000_0000_0000 | u64::from(pgno)),
		})
		.collect::<Vec<_>>();
	db.commit(dirty_pages, SHARD_SIZE - 1, 1_000).await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let pidx_before = read_value(&test_ctx, branch_pidx_key(branch_id, 1)).await?;
	assert_eq!(
		pidx_before,
		Some(1_u64.to_be_bytes().to_vec()),
		"the fixture must begin with an authoritative PIDX row"
	);

	let controller = DepotFaultController::new();
	let checkpoint = format!("hot-{test_name}");
	let pause = controller.pause_handle(checkpoint.clone());
	controller
		.at(DepotFaultPoint::HotCompaction(fault_point))
		.database_branch_id(branch_id)
		.once()
		.pause(checkpoint)?;
	let _fault_guard = register_workflow_fault_controller(branch_id, controller.clone());
	let driver =
		DepotCompactionTestDriver::new(&test_ctx).with_wait_timeout(Duration::from_secs(30));
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let sabotage = async {
		pause.wait_reached().await;
		let chunk_key = branch_shard_chunk_key(branch_id, 0, 1, 0);
		let result = match sabotage_kind {
			StagedChunkSabotage::Missing => clear_value(&test_ctx, chunk_key).await,
			StagedChunkSabotage::Corrupt => {
				set_value(
					&test_ctx,
					chunk_key,
					vec![0xa5; depot::HOT_SHARD_CHUNK_BYTES],
				)
				.await
			}
		};
		pause.release();
		result
	};
	let force = driver.force_compaction(
		manager_id,
		branch_id,
		ForceCompactionWork {
			hot: true,
			cold: false,
			reclaim: false,
			final_settle: false,
		},
	);
	let (sabotage_result, hot_result) = tokio::join!(sabotage, force);
	sabotage_result?;
	let hot = hot_result?;
	let terminal_error = hot
		.terminal_error
		.context("staged chunk sabotage must reject the hot install")?;
	assert!(
		terminal_error.contains(expected_error),
		"unexpected hot install rejection: {terminal_error}"
	);
	controller.assert_expected_fired()?;

	assert!(
		read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.is_none(),
		"root publication must not advance past an incomplete staged shard"
	);
	assert_eq!(
		read_value(&test_ctx, branch_pidx_key(branch_id, 1)).await?,
		pidx_before,
		"the rejected install must not clear or change the authoritative PIDX row"
	);
	let canonical = read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
		.await?
		.context("the prepublished canonical chunk manifest should remain inspectable")?;
	assert!(decode_hot_shard_manifest(&canonical)?.chunk_count > 1);
	let sabotaged_chunk = read_value(&test_ctx, branch_shard_chunk_key(branch_id, 0, 1, 0)).await?;
	match sabotage_kind {
		StagedChunkSabotage::Missing => assert!(sabotaged_chunk.is_none()),
		StagedChunkSabotage::Corrupt => {
			assert_eq!(
				sabotaged_chunk,
				Some(vec![0xa5; depot::HOT_SHARD_CHUNK_BYTES])
			)
		}
	}

	// The incomplete prepublication is not authoritative because root did not advance. Reads must
	// continue through the PIDX/DELTA path instead of observing the abandoned SHARD artifact.
	let pages = db.get_pages(vec![1, SHARD_SIZE - 1]).await?;
	for page in pages {
		assert_eq!(
			page.bytes,
			Some(incompressible_test_page(
				0xc000_0000_0000_0000 | u64::from(page.pgno)
			))
		);
	}

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn hot_install_rejects_missing_staged_chunk_before_root_publish() -> Result<()> {
	assert_hot_install_rejects_staged_chunk_sabotage(
		"missing-staged-chunk",
		HotCompactionFaultPoint::InstallBeforeShardIntegrityPreflight,
		StagedChunkSabotage::Missing,
		"hot shard chunk is missing",
	)
	.await
}

#[tokio::test]
async fn hot_install_rechecks_corrupt_chunk_after_publish_transaction_conflict() -> Result<()> {
	assert_hot_install_rejects_staged_chunk_sabotage(
		"corrupt-staged-chunk-after-preflight",
		HotCompactionFaultPoint::InstallBeforeStagedRead,
		StagedChunkSabotage::Corrupt,
		"hot shard chunks are corrupt",
	)
	.await
}

#[tokio::test]
async fn hot_stage_rejects_conflicting_prepublished_immutable_shard() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-hot-workflow-conflicting-prepublish-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("hot-conflicting-prepublish-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	let expected_page = vec![0x91; PAGE_SIZE as usize];
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: expected_page.clone(),
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let conflicting = encode_ltx_v3(
		LtxHeader::delta(1, 2, 777),
		&[DirtyPage {
			pgno: 2,
			bytes: vec![0xcc; PAGE_SIZE as usize],
		}],
	)?;
	set_value(
		&test_ctx,
		branch_shard_key(branch_id, 0, 1),
		conflicting.clone(),
	)
	.await?;

	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let hot = driver
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
	let terminal_error = hot
		.terminal_error
		.context("conflicting immutable shard must fail the hot job")?;
	assert!(
		terminal_error.contains("immutable hot shard key already contains different bytes"),
		"unexpected terminal error: {terminal_error}"
	);
	assert!(
		read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.is_none(),
		"a conflicting prepublish must not advance the authoritative hot root"
	);
	assert_eq!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1)).await?,
		Some(conflicting),
		"fail-closed collision handling must not overwrite the unexpected value"
	);
	assert!(
		read_value(&test_ctx, branch_pidx_key(branch_id, 1))
			.await?
			.is_some(),
		"failed publication must retain PIDX/delta authority"
	);
	let pages = db.get_pages(vec![1]).await?;
	assert_eq!(pages[0].bytes, Some(expected_page));

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn truncate_rewrites_and_clears_chunked_hot_shards() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-truncate-chunked-hot-shards-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("truncate-chunked-hot-shards-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: incompressible_test_page(1),
		}],
		191,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let shard_blob = |first_pgno: u32, last_pgno: u32| {
		let pages = (first_pgno..=last_pgno)
			.map(|pgno| DirtyPage {
				pgno,
				bytes: incompressible_test_page(u64::from(pgno)),
			})
			.collect::<Vec<_>>();
		encode_ltx_v3(LtxHeader::delta(1, 191, 1_000), &pages)
	};
	let boundary_blob = shard_blob(64, 127)?;
	let whole_shard_blob = shard_blob(128, 191)?;
	write_hot_shard(&test_ctx, branch_id, 1, 1, boundary_blob.clone()).await?;
	write_hot_shard(&test_ctx, branch_id, 2, 1, whole_shard_blob.clone()).await?;
	for (shard_id, blob) in [(1, &boundary_blob), (2, &whole_shard_blob)] {
		set_value(
			&test_ctx,
			branch_compaction_hot_shard_coverage_key(branch_id, shard_id, 1),
			encode_hot_shard_coverage(HotShardCoverage {
				database_branch_id: branch_id,
				shard_id,
				as_of_txid: 1,
				size_bytes: u64::try_from(blob.len())?,
				content_hash: Sha256::digest(blob).into(),
			})?,
		)
		.await?;
	}
	let original_boundary_manifest = decode_hot_shard_manifest(
		&read_value(&test_ctx, branch_shard_key(branch_id, 1, 1))
			.await?
			.context("boundary shard should have a chunk manifest")?,
	)?;
	let whole_shard_manifest = decode_hot_shard_manifest(
		&read_value(&test_ctx, branch_shard_key(branch_id, 2, 1))
			.await?
			.context("whole shard should have a chunk manifest")?,
	)?;
	assert!(original_boundary_manifest.chunk_count > 1);
	assert!(whole_shard_manifest.chunk_count > 1);

	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: incompressible_test_page(0x1111),
		}],
		100,
		2_000,
	)
	.await?;

	let pages = db.get_pages(vec![64, 100]).await?;
	assert_eq!(pages[0].bytes, Some(incompressible_test_page(64)));
	assert_eq!(pages[1].bytes, Some(incompressible_test_page(100)));
	let pruned_boundary_manifest = decode_hot_shard_manifest(
		&read_value(&test_ctx, branch_shard_key(branch_id, 1, 1))
			.await?
			.context("pruned boundary shard should remain chunked")?,
	)?;
	assert!(pruned_boundary_manifest.chunk_count < original_boundary_manifest.chunk_count);
	for chunk_idx in pruned_boundary_manifest.chunk_count..original_boundary_manifest.chunk_count {
		assert!(
			read_value(
				&test_ctx,
				branch_shard_chunk_key(branch_id, 1, 1, chunk_idx),
			)
			.await?
			.is_none(),
			"truncate must remove superseded boundary chunk {chunk_idx}"
		);
	}
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 2, 1))
			.await?
			.is_none(),
		"truncate must remove a whole shard above EOF"
	);
	for shard_id in [1, 2] {
		assert!(
			read_value(
				&test_ctx,
				branch_compaction_hot_shard_coverage_key(branch_id, shard_id, 1),
			)
			.await?
			.is_none(),
			"truncate must invalidate stale hot coverage for shard {shard_id} with an O(1) range clear"
		);
	}
	for chunk_idx in 0..whole_shard_manifest.chunk_count {
		assert!(
			read_value(
				&test_ctx,
				branch_shard_chunk_key(branch_id, 2, 1, chunk_idx),
			)
			.await?
			.is_none(),
			"truncate must remove whole-shard chunk {chunk_idx}"
		);
	}

	db.commit(Vec::new(), 191, 3_000).await?;
	let regrown = db.get_pages(vec![101, 128]).await?;
	assert_eq!(regrown[0].bytes, Some(vec![0; PAGE_SIZE as usize]));
	assert_eq!(regrown[1].bytes, Some(vec![0; PAGE_SIZE as usize]));

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn s3_workflow_publishes_reclaims_and_refills_by_exact_key() -> Result<()> {
	let Ok(endpoint) = std::env::var("RIVET_TEST_S3_ENDPOINT") else {
		return Ok(());
	};
	let region = std::env::var("RIVET_TEST_S3_REGION").unwrap_or_else(|_| "us-east-1".to_string());
	let configured_bucket = std::env::var("RIVET_TEST_S3_BUCKET").ok();
	let bucket = configured_bucket
		.clone()
		.unwrap_or_else(|| format!("rivet-depot-workflow-{}", Uuid::new_v4().simple()));
	let client = s3_client(&endpoint, &region).await;
	if configured_bucket.is_none() {
		client.create_bucket().bucket(&bucket).send().await?;
	}

	let mut test_ctx =
		test_ctx_with_cold_tier(SqliteWorkflowColdStorage::S3(SqliteWorkflowColdStorageS3 {
			bucket: bucket.clone(),
			endpoint: Some(endpoint),
			region,
			addressing_style: s3_addressing_style(),
			recovery_window_ms: 7 * 24 * 60 * 60 * 1000,
			max_object_size_bytes: 4 * 1024 * 1024,
			max_concurrent_requests: 4,
			max_queued_requests: 16,
			queue_timeout_ms: 15_000,
		}))
		.await?;
	let database_id = format!("cold-workflow-s3-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x7b; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let publish = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(publish.terminal_error, None);

	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("S3 compaction root should be published")?,
	)?;
	let marker = decode_cold_publish_marker(
		&read_value(
			&test_ctx,
			branch_compaction_cold_publish_key(branch_id, root.manifest_generation),
		)
		.await?
		.context("S3 cold generation should have an atomic publication marker")?,
	)?;
	let reference = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.context("S3 cold ref should be published")?,
	)?;
	assert!(marker.matches_ref(&reference));
	let exact_s3_key = reference.object_key.clone();
	let object_bytes = client
		.get_object()
		.bucket(&bucket)
		.key(&exact_s3_key)
		.send()
		.await?
		.body
		.collect()
		.await?
		.into_bytes();
	let (_, cold_ltx) = validate_cold_shard_object(&reference, &object_bytes)?;
	assert_eq!(cold_ltx.pages[0].bytes, vec![0x7b; PAGE_SIZE as usize]);

	let reclaim = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(reclaim.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"S3 publication proof should permit exact hot eviction"
	);

	let read = db
		.get_pages_with_options(
			vec![1],
			GetPagesOptions {
				collect_provenance: true,
				..Default::default()
			},
		)
		.await?;
	assert_eq!(read.pages[0].bytes, Some(vec![0x7b; PAGE_SIZE as usize]));
	assert_eq!(read.provenance[0].winner_kind, PageSourceKind::ColdShard);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_some(),
		"validated exact S3 GET should refill the FDB hot-cache row"
	);

	// Publish a replacement for the same shard, then drive logical retirement and backup-fenced
	// exact deletion as separate steps against the real S3-compatible API.
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x7c; PAGE_SIZE as usize],
		}],
		2,
		2_000,
	)
	.await?;
	let replacement = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(replacement.terminal_error, None);
	let replacement_ref = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 2))
			.await?
			.context("replacement S3 cold ref should be published")?,
	)?;
	let replacement_s3_key = replacement_ref.object_key.clone();
	let _grace = override_cold_object_delete_grace_for_test(branch_id, 60_000);
	let retired = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(retired.terminal_error, None);
	assert!(
		client
			.head_object()
			.bucket(&bucket)
			.key(&exact_s3_key)
			.send()
			.await
			.is_ok(),
		"logical retirement must preserve the S3 object during its recovery window"
	);
	let retired_hash = Sha256::digest(exact_s3_key.as_bytes()).into();
	let retired_key = branch_compaction_retired_cold_object_key(branch_id, retired_hash);
	let mut retired_row = decode_retired_cold_object(
		&read_value(&test_ctx, retired_key.clone())
			.await?
			.context("S3 retirement tombstone should exist")?,
	)?;
	clear_value(
		&test_ctx,
		branch_compaction_retired_cold_object_due_key(
			branch_id,
			retired_row.delete_after_ms,
			retired_hash,
		),
	)
	.await?;
	retired_row.delete_after_ms = 0;
	certify_backup_after(&test_ctx, &retired_row.retired_versionstamp).await?;
	set_value(
		&test_ctx,
		retired_key,
		encode_retired_cold_object(retired_row)?,
	)
	.await?;
	set_value(
		&test_ctx,
		branch_compaction_retired_cold_object_due_key(branch_id, 0, retired_hash),
		Vec::new(),
	)
	.await?;
	let deleted = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(deleted.terminal_error, None);
	assert!(
		client
			.head_object()
			.bucket(&bucket)
			.key(&exact_s3_key)
			.send()
			.await
			.is_err(),
		"superseded S3 object should be deleted by its exact recorded key"
	);
	let replacement_bytes = client
		.get_object()
		.bucket(&bucket)
		.key(&replacement_s3_key)
		.send()
		.await?
		.body
		.collect()
		.await?
		.into_bytes();
	validate_cold_shard_object(&replacement_ref, &replacement_bytes)?;
	let current = db.get_pages(vec![1]).await?;
	assert_eq!(current[0].bytes, Some(vec![0x7c; PAGE_SIZE as usize]));

	test_ctx.shutdown().await?;
	client
		.delete_object()
		.bucket(&bucket)
		.key(exact_s3_key)
		.send()
		.await?;
	client
		.delete_object()
		.bucket(&bucket)
		.key(replacement_s3_key)
		.send()
		.await?;
	if configured_bucket.is_none() {
		client.delete_bucket().bucket(bucket).send().await?;
	}
	Ok(())
}

#[cfg(feature = "foundationdb")]
#[tokio::test]
async fn foundationdb_s3_workflow_publishes_evicts_and_refills_by_exact_key() -> Result<()> {
	let Ok(endpoint) = std::env::var("RIVET_TEST_S3_ENDPOINT") else {
		return Ok(());
	};
	let region = std::env::var("RIVET_TEST_S3_REGION").unwrap_or_else(|_| "us-east-1".to_string());
	let configured_bucket = std::env::var("RIVET_TEST_S3_BUCKET").ok();
	let addressing_style = s3_addressing_style();
	let keep_object = std::env::var("RIVET_TEST_S3_KEEP_OBJECT").as_deref() == Ok("1");
	let leave_hot_evicted = std::env::var("RIVET_TEST_S3_LEAVE_HOT_EVICTED").as_deref() == Ok("1");
	let evidence_file = std::env::var_os("RIVET_TEST_S3_EVIDENCE_FILE");
	let bucket = configured_bucket
		.clone()
		.unwrap_or_else(|| format!("rivet-depot-fdb-workflow-{}", Uuid::new_v4().simple()));
	let client = s3_client(&endpoint, &region).await;
	if configured_bucket.is_none() {
		client.create_bucket().bucket(&bucket).send().await?;
	}

	let Some(mut test_ctx) = test_ctx_with_foundationdb_cold_tier(SqliteWorkflowColdStorage::S3(
		SqliteWorkflowColdStorageS3 {
			bucket: bucket.clone(),
			endpoint: Some(endpoint.clone()),
			region: region.clone(),
			addressing_style,
			recovery_window_ms: 7 * 24 * 60 * 60 * 1000,
			max_object_size_bytes: 4 * 1024 * 1024,
			max_concurrent_requests: 4,
			max_queued_requests: 16,
			queue_timeout_ms: 15_000,
		},
	))
	.await?
	else {
		if configured_bucket.is_none() {
			client.delete_bucket().bucket(bucket).send().await?;
		}
		return Ok(());
	};
	let database_id = format!("cold-workflow-fdb-s3-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	let dirty_pages = vec![DirtyPage {
		pgno: 1,
		bytes: vec![0x4f; PAGE_SIZE as usize],
	}];
	let commit_options = CommitOptions {
		expected_head_txid: Some(0),
		commit_attempt_id: Some([0xf4; 16]),
		..Default::default()
	};
	let committed = db
		.commit_with_options(dirty_pages.clone(), 2, 1_000, commit_options)
		.await?;
	let replayed = db
		.commit_with_options(dirty_pages, 2, 1_000, commit_options)
		.await?;
	assert_eq!(committed.head_txid, 1);
	assert_eq!(replayed, committed);
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	assert!(
		read_value(&test_ctx, branch_commit_key(branch_id, 2))
			.await?
			.is_none(),
		"real FDB idempotency proof must prevent a second logical TXID"
	);
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let publish = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(publish.terminal_error, None);
	let reference = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.context("FDB-backed workflow should atomically publish the cold ref")?,
	)?;
	let exact_s3_key = reference.object_key.clone();
	let object_bytes = client
		.get_object()
		.bucket(&bucket)
		.key(&exact_s3_key)
		.send()
		.await?
		.body
		.collect()
		.await?
		.into_bytes();
	let (_, cold_ltx) = validate_cold_shard_object(&reference, &object_bytes)?;
	assert_eq!(cold_ltx.pages[0].bytes, vec![0x4f; PAGE_SIZE as usize]);

	let reclaim = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(reclaim.terminal_error, None);
	let hot_evicted = read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
		.await?
		.is_none();
	assert!(
		hot_evicted,
		"atomic FDB publication proof should permit hot eviction"
	);
	let read = db
		.get_pages_with_options(
			vec![1],
			GetPagesOptions {
				collect_provenance: true,
				..Default::default()
			},
		)
		.await?;
	assert_eq!(read.pages[0].bytes, Some(vec![0x4f; PAGE_SIZE as usize]));
	assert_eq!(read.provenance[0].winner_kind, PageSourceKind::ColdShard);
	let cold_read_provenance = read.provenance[0].winner_kind == PageSourceKind::ColdShard;
	let hot_refilled = read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
		.await?
		.is_some();
	assert!(
		hot_refilled,
		"validated exact S3 GET should refill the FDB hot-cache row"
	);
	let head = client
		.head_object()
		.bucket(&bucket)
		.key(&exact_s3_key)
		.send()
		.await?;
	let storage_class = head
		.storage_class()
		.map(|value| value.as_str())
		.unwrap_or("STANDARD");
	let observed_size = head
		.content_length()
		.context("retained S3/COS object HEAD omitted content length")?;
	assert_eq!(u64::try_from(observed_size)?, reference.size_bytes);
	if leave_hot_evicted {
		clear_value(&test_ctx, branch_shard_key(branch_id, 0, 1)).await?;
	}
	let hot_evicted_at_exit = read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
		.await?
		.is_none();

	let evidence = serde_json::json!({
		"schema": "rivet-fdb-cos-cold-tier-evidence/v1",
		"bucket": bucket.clone(),
		"endpoint": endpoint.clone(),
		"region": region.clone(),
		"database_id": database_id.clone(),
		"database_branch_id": branch_id.as_uuid().to_string(),
		"object_key": exact_s3_key.clone(),
		"object_size_bytes": reference.size_bytes,
		"object_sha256": lowercase_hex(&reference.content_hash),
		"cos_storage_class": storage_class,
		"fdb_hot_evicted_before_read": hot_evicted,
		"cold_read_provenance": cold_read_provenance,
		"fdb_hot_refilled_after_read": hot_refilled,
		"fdb_hot_evicted_at_exit": hot_evicted_at_exit,
		"retained": keep_object,
	});
	println!(
		"RIVET_COLD_TIER_EVIDENCE {}",
		serde_json::to_string(&evidence)?
	);
	if let Some(evidence_file) = evidence_file {
		std::fs::write(&evidence_file, serde_json::to_vec_pretty(&evidence)?).with_context(
			|| {
				format!(
					"write cold-tier evidence to {}",
					Path::new(&evidence_file).display()
				)
			},
		)?;
	}

	driver
		.destroy_manager_and_wait(manager_id, branch_id, 1)
		.await?;
	test_ctx.shutdown().await?;
	if !keep_object {
		client
			.delete_object()
			.bucket(&bucket)
			.key(exact_s3_key)
			.send()
			.await?;
	}
	if configured_bucket.is_none() && !keep_object {
		client.delete_bucket().bucket(bucket).send().await?;
	}
	Ok(())
}

#[cfg(feature = "foundationdb")]
#[tokio::test]
async fn foundationdb_branch_gc_retains_s3_object_for_pre_tombstone_backup() -> Result<()> {
	let Ok(database_id) = std::env::var("RIVET_TEST_BRANCH_GC_DATABASE_ID") else {
		return Ok(());
	};
	let endpoint = std::env::var("RIVET_TEST_S3_ENDPOINT")?;
	let region = std::env::var("RIVET_TEST_S3_REGION").unwrap_or_else(|_| "us-east-1".to_string());
	let bucket = std::env::var("RIVET_TEST_S3_BUCKET")?;
	let client = s3_client(&endpoint, &region).await;
	let Some(mut test_ctx) = test_ctx_with_foundationdb_cold_tier(SqliteWorkflowColdStorage::S3(
		SqliteWorkflowColdStorageS3 {
			bucket: bucket.clone(),
			endpoint: Some(endpoint),
			region,
			addressing_style: s3_addressing_style(),
			recovery_window_ms: 7 * 24 * 60 * 60 * 1000,
			max_object_size_bytes: 4 * 1024 * 1024,
			max_concurrent_requests: 4,
			max_queued_requests: 16,
			queue_timeout_ms: 15_000,
		},
	))
	.await?
	else {
		return Ok(());
	};
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let reference = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.context("pre-tombstone backup source should retain its exact cold ref")?,
	)?;
	let object_key = reference.object_key.clone();
	let udb = test_ctx.pools().udb()?;
	branch::delete_database(&udb, BucketId::from_gas_id(test_bucket()), branch_id).await?;
	test_ctx
		.workflow(depot::workflows::db_branch_gc::DbBranchGcInput {
			database_branch_id: branch_id,
		})
		.output()
		.await?;

	assert!(
		read_value(&test_ctx, branches_list_key(branch_id))
			.await?
			.is_none(),
		"logical Branch GC should be free to sweep its branch-local FDB subspace"
	);
	let manifest = depot::types::decode_branch_cold_gc_manifest(
		&read_value(
			&test_ctx,
			depot::keys::branch_cold_gc_manifest_key(branch_id),
		)
		.await?
		.context("Branch GC must leave a branch-external cold tombstone manifest")?,
	)?;
	assert!(manifest.staging_complete);
	assert!(manifest.staged_object_count > 0);
	client
		.head_object()
		.bucket(&bucket)
		.key(&object_key)
		.send()
		.await
		.context("Branch GC must retain the exact S3 object needed by the pre-tombstone backup")?;
	println!(
		"RIVET_FDB_BRANCH_GC_BACKUP_FENCE_OK database_id={database_id} branch_id={branch_id:?} object_key={object_key}"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[cfg(feature = "foundationdb")]
#[tokio::test]
async fn restored_foundationdb_backup_reads_retained_s3_object() -> Result<()> {
	let Ok(database_id) = std::env::var("RIVET_TEST_RESTORE_DATABASE_ID") else {
		return Ok(());
	};
	let endpoint = std::env::var("RIVET_TEST_S3_ENDPOINT")?;
	let region = std::env::var("RIVET_TEST_S3_REGION").unwrap_or_else(|_| "us-east-1".to_string());
	let bucket = std::env::var("RIVET_TEST_S3_BUCKET")?;
	let Some(mut test_ctx) = test_ctx_with_foundationdb_cold_tier(SqliteWorkflowColdStorage::S3(
		SqliteWorkflowColdStorageS3 {
			bucket,
			endpoint: Some(endpoint),
			region,
			addressing_style: s3_addressing_style(),
			recovery_window_ms: 7 * 24 * 60 * 60 * 1000,
			max_object_size_bytes: 4 * 1024 * 1024,
			max_concurrent_requests: 4,
			max_queued_requests: 16,
			queue_timeout_ms: 15_000,
		},
	))
	.await?
	else {
		return Ok(());
	};
	let db = make_db(&test_ctx, &database_id).await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"restored backup must begin without the deliberately evicted FDB hot row"
	);
	assert!(
		read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.is_some(),
		"restored FDB backup must retain the authoritative cold ref"
	);

	let read = db
		.get_pages_with_options(
			vec![1],
			GetPagesOptions {
				collect_provenance: true,
				..Default::default()
			},
		)
		.await?;
	assert_eq!(read.pages[0].bytes, Some(vec![0x4f; PAGE_SIZE as usize]));
	assert_eq!(read.provenance[0].winner_kind, PageSourceKind::ColdShard);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_some(),
		"validated cold read after FDB restore must refill the hot-cache row"
	);
	println!("RIVET_FDB_BACKUP_COLD_RESTORE_OK database_id={database_id} branch_id={branch_id:?}");

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn s3_missing_and_corrupt_cold_objects_fail_closed_without_refill() -> Result<()> {
	let Ok(endpoint) = std::env::var("RIVET_TEST_S3_ENDPOINT") else {
		return Ok(());
	};
	let region = std::env::var("RIVET_TEST_S3_REGION").unwrap_or_else(|_| "us-east-1".to_string());
	let configured_bucket = std::env::var("RIVET_TEST_S3_BUCKET").ok();
	let bucket = configured_bucket
		.clone()
		.unwrap_or_else(|| format!("rivet-depot-fail-closed-{}", Uuid::new_v4().simple()));
	let client = s3_client(&endpoint, &region).await;
	if configured_bucket.is_none() {
		client.create_bucket().bucket(&bucket).send().await?;
	}

	let mut test_ctx =
		test_ctx_with_cold_tier(SqliteWorkflowColdStorage::S3(SqliteWorkflowColdStorageS3 {
			bucket: bucket.clone(),
			endpoint: Some(endpoint),
			region,
			addressing_style: s3_addressing_style(),
			recovery_window_ms: 7 * 24 * 60 * 60 * 1000,
			max_object_size_bytes: 4 * 1024 * 1024,
			max_concurrent_requests: 4,
			max_queued_requests: 16,
			queue_timeout_ms: 15_000,
		}))
		.await?;
	let database_id = format!("cold-workflow-s3-fail-closed-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x7d; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let publish = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(publish.terminal_error, None);
	let reference = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.context("S3 cold ref should be published before fail-closed checks")?,
	)?;
	let exact_s3_key = reference.object_key.clone();
	let object_bytes = client
		.get_object()
		.bucket(&bucket)
		.key(&exact_s3_key)
		.send()
		.await?
		.body
		.collect()
		.await?
		.into_bytes();
	validate_cold_shard_object(&reference, &object_bytes)?;

	let reclaim = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(reclaim.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"fixture must begin after proof-gated hot eviction"
	);

	client
		.delete_object()
		.bucket(&bucket)
		.key(&exact_s3_key)
		.send()
		.await?;
	let missing = db
		.get_pages(vec![1])
		.await
		.expect_err("missing S3 object must fail instead of zero-filling");
	assert!(contains_storage_error(&missing, |error| matches!(
		error,
		SqliteStorageError::ColdObjectUnavailable { .. }
	)));
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"failed exact S3 GET must not create a hot-cache row"
	);

	client
		.put_object()
		.bucket(&bucket)
		.key(&exact_s3_key)
		.body(ByteStream::from(
			object_bytes[..object_bytes.len() / 2].to_vec(),
		))
		.send()
		.await?;
	let corrupt = db
		.get_pages(vec![1])
		.await
		.expect_err("corrupt S3 object must fail instead of zero-filling");
	assert!(contains_storage_error(&corrupt, |error| matches!(
		error,
		SqliteStorageError::ColdObjectCorrupt { .. }
	)));
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"failed S3 integrity validation must not create a hot-cache row"
	);

	client
		.put_object()
		.bucket(&bucket)
		.key(&exact_s3_key)
		.body(ByteStream::from(object_bytes.to_vec()))
		.send()
		.await?;
	let repaired = db.get_pages(vec![1]).await?;
	assert_eq!(repaired[0].bytes, Some(vec![0x7d; PAGE_SIZE as usize]));
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_some(),
		"restoring the exact immutable object must permit a validated hot-cache refill"
	);
	let unchanged = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.context("repair must retain the original published cold ref")?,
	)?;
	assert_eq!(unchanged, reference);

	test_ctx.shutdown().await?;
	client
		.delete_object()
		.bucket(&bucket)
		.key(exact_s3_key)
		.send()
		.await?;
	if configured_bucket.is_none() {
		client.delete_bucket().bucket(bucket).send().await?;
	}
	Ok(())
}

#[tokio::test]
async fn s3_upload_and_publish_response_loss_replay_by_exact_key() -> Result<()> {
	let Ok(endpoint) = std::env::var("RIVET_TEST_S3_ENDPOINT") else {
		return Ok(());
	};
	let region = std::env::var("RIVET_TEST_S3_REGION").unwrap_or_else(|_| "us-east-1".to_string());
	let configured_bucket = std::env::var("RIVET_TEST_S3_BUCKET").ok();
	let bucket = configured_bucket
		.clone()
		.unwrap_or_else(|| format!("rivet-depot-response-loss-{}", Uuid::new_v4().simple()));
	let client = s3_client(&endpoint, &region).await;
	if configured_bucket.is_none() {
		client.create_bucket().bucket(&bucket).send().await?;
	}

	let mut test_ctx =
		test_ctx_with_cold_tier(SqliteWorkflowColdStorage::S3(SqliteWorkflowColdStorageS3 {
			bucket: bucket.clone(),
			endpoint: Some(endpoint),
			region,
			addressing_style: s3_addressing_style(),
			recovery_window_ms: 7 * 24 * 60 * 60 * 1000,
			max_object_size_bytes: 4 * 1024 * 1024,
			max_concurrent_requests: 4,
			max_queued_requests: 16,
			queue_timeout_ms: 15_000,
		}))
		.await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let mut exact_s3_keys = Vec::new();
	for (case, fault_point, byte) in [
		(
			"upload",
			ColdCompactionFaultPoint::UploadAfterObjectPut,
			0x6d,
		),
		(
			"publish",
			ColdCompactionFaultPoint::PublishAfterFdbCommit,
			0x6e,
		),
	] {
		let database_id = format!("cold-workflow-s3-{case}-response-loss-{}", Uuid::new_v4());
		let db = make_db(&test_ctx, &database_id).await?;
		db.commit(
			vec![DirtyPage {
				pgno: 1,
				bytes: vec![byte; PAGE_SIZE as usize],
			}],
			2,
			1_000,
		)
		.await?;
		let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
		let controller = DepotFaultController::new();
		controller
			.at(DepotFaultPoint::ColdCompaction(fault_point))
			.database_branch_id(branch_id)
			.once()
			.fail(format!("simulated lost {case} activity response"))?;
		let _fault_guard = register_workflow_fault_controller(branch_id, controller.clone());
		let manager_id = driver.start_manager(branch_id, None, true).await?;
		let published = driver
			.force_compaction(
				manager_id,
				branch_id,
				ForceCompactionWork {
					hot: true,
					cold: true,
					reclaim: false,
					final_settle: false,
				},
			)
			.await?;
		assert_eq!(published.terminal_error, None);
		controller.assert_expected_fired()?;

		let reference = decode_cold_shard_ref(
			&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
				.await?
				.with_context(|| format!("{case} response loss should replay to a cold ref"))?,
		)?;
		let marker = decode_cold_publish_marker(
			&read_value(
				&test_ctx,
				branch_compaction_cold_publish_key(branch_id, reference.publish_generation),
			)
			.await?
			.with_context(|| format!("{case} response loss should retain atomic publish proof"))?,
		)?;
		assert!(marker.matches_ref(&reference));
		let exact_s3_key = reference.object_key.clone();
		let object_bytes = client
			.get_object()
			.bucket(&bucket)
			.key(&exact_s3_key)
			.send()
			.await?
			.body
			.collect()
			.await?
			.into_bytes();
		let (_, cold_ltx) = validate_cold_shard_object(&reference, &object_bytes)?;
		assert_eq!(cold_ltx.pages[0].bytes, vec![byte; PAGE_SIZE as usize]);
		assert_eq!(
			read_prefix_values(&test_ctx, branch_compaction_cold_shard_prefix(branch_id))
				.await?
				.len(),
			1,
			"response-loss replay must converge to one cold reference"
		);
		assert_eq!(
			read_prefix_values(&test_ctx, branch_compaction_cold_publish_prefix(branch_id))
				.await?
				.len(),
			1,
			"response-loss replay must converge to one publish marker"
		);
		assert!(
			read_prefix_values(
				&test_ctx,
				branch_compaction_cold_upload_intent_prefix(branch_id),
			)
			.await?
			.is_empty(),
			"successful replay must consume its durable upload intent"
		);
		exact_s3_keys.push(exact_s3_key);
	}

	test_ctx.shutdown().await?;
	for exact_s3_key in exact_s3_keys {
		client
			.delete_object()
			.bucket(&bucket)
			.key(exact_s3_key)
			.send()
			.await?;
	}
	if configured_bucket.is_none() {
		client.delete_bucket().bucket(bucket).send().await?;
	}
	Ok(())
}

#[tokio::test]
async fn concurrent_s3_cold_recovery_keeps_actor_branches_isolated() -> Result<()> {
	let Ok(endpoint) = std::env::var("RIVET_TEST_S3_ENDPOINT") else {
		return Ok(());
	};
	let region = std::env::var("RIVET_TEST_S3_REGION").unwrap_or_else(|_| "us-east-1".to_string());
	let configured_bucket = std::env::var("RIVET_TEST_S3_BUCKET").ok();
	let bucket = configured_bucket
		.clone()
		.unwrap_or_else(|| format!("rivet-depot-isolation-{}", Uuid::new_v4().simple()));
	let client = s3_client(&endpoint, &region).await;
	if configured_bucket.is_none() {
		client.create_bucket().bucket(&bucket).send().await?;
	}

	let mut test_ctx =
		test_ctx_with_cold_tier(SqliteWorkflowColdStorage::S3(SqliteWorkflowColdStorageS3 {
			bucket: bucket.clone(),
			endpoint: Some(endpoint),
			region,
			addressing_style: s3_addressing_style(),
			recovery_window_ms: 7 * 24 * 60 * 60 * 1000,
			max_object_size_bytes: 4 * 1024 * 1024,
			max_concurrent_requests: 4,
			max_queued_requests: 16,
			queue_timeout_ms: 15_000,
		}))
		.await?;
	let database_a = format!("isolation-a-{}", Uuid::new_v4());
	let database_b = format!("isolation-b-{}", Uuid::new_v4());
	let db_a = make_db(&test_ctx, &database_a).await?;
	let db_b = make_db(&test_ctx, &database_b).await?;
	for (db, byte) in [(&db_a, 0xa5), (&db_b, 0x5a)] {
		db.commit(
			vec![DirtyPage {
				pgno: 1,
				bytes: vec![byte; PAGE_SIZE as usize],
			}],
			2,
			1_000,
		)
		.await?;
	}
	let branch_a = read_database_branch_id(&test_ctx, &database_a).await?;
	let branch_b = read_database_branch_id(&test_ctx, &database_b).await?;
	assert_ne!(branch_a, branch_b);
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_a = driver.start_manager(branch_a, None, true).await?;
	let manager_b = driver.start_manager(branch_b, None, true).await?;
	let work = ForceCompactionWork {
		hot: true,
		cold: true,
		reclaim: false,
		final_settle: false,
	};
	let (publish_a, publish_b) = tokio::join!(
		driver.force_compaction(manager_a, branch_a, work.clone()),
		driver.force_compaction(manager_b, branch_b, work),
	);
	assert_eq!(publish_a?.terminal_error, None);
	assert_eq!(publish_b?.terminal_error, None);
	let reference_a = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_a, 0, 1))
			.await?
			.context("Actor A cold ref missing")?,
	)?;
	let reference_b = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_b, 0, 1))
			.await?
			.context("Actor B cold ref missing")?,
	)?;
	assert_eq!(reference_a.database_branch_id, branch_a);
	assert_eq!(reference_b.database_branch_id, branch_b);
	assert_ne!(reference_a.object_key, reference_b.object_key);

	let reclaim = ForceCompactionWork {
		hot: false,
		cold: false,
		reclaim: true,
		final_settle: false,
	};
	let (reclaim_a, reclaim_b) = tokio::join!(
		driver.force_compaction(manager_a, branch_a, reclaim.clone()),
		driver.force_compaction(manager_b, branch_b, reclaim),
	);
	assert_eq!(reclaim_a?.terminal_error, None);
	assert_eq!(reclaim_b?.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_a, 0, 1))
			.await?
			.is_none()
	);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_b, 0, 1))
			.await?
			.is_none()
	);

	// Read in reverse order so a cache keyed only by shard coordinates would deterministically fail.
	let (read_b, read_a) = tokio::join!(db_b.get_pages(vec![1]), db_a.get_pages(vec![1]));
	assert_eq!(read_b?[0].bytes, Some(vec![0x5a; PAGE_SIZE as usize]));
	assert_eq!(read_a?[0].bytes, Some(vec![0xa5; PAGE_SIZE as usize]));

	test_ctx.shutdown().await?;
	for key in [reference_a.object_key, reference_b.object_key] {
		client
			.delete_object()
			.bucket(&bucket)
			.key(key)
			.send()
			.await?;
	}
	if configured_bucket.is_none() {
		client.delete_bucket().bucket(bucket).send().await?;
	}
	Ok(())
}

#[tokio::test]
async fn superseded_cold_object_is_retired_then_deleted_by_exact_key() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-cold-workflow-retirement-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("cold-workflow-retirement-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x31; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let first_publish = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(first_publish.terminal_error, None);
	let first_ref = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.context("first cold ref should be published")?,
	)?;
	let first_object_path = cold_root.path().join(&first_ref.object_key);
	assert!(first_object_path.is_file());

	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x32; PAGE_SIZE as usize],
		}],
		2,
		2_000,
	)
	.await?;
	let second_publish = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(second_publish.terminal_error, None);
	let second_ref = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 2))
			.await?
			.context("replacement cold ref should be published")?,
	)?;
	assert_ne!(first_ref.object_key, second_ref.object_key);
	let accounting_udb = test_ctx.pools().udb()?;
	let accounting = read_cold_accounting(&accounting_udb).await?;
	assert_eq!(accounting.live_objects, 2);
	assert_eq!(
		accounting.live_bytes,
		i64::try_from(first_ref.size_bytes + second_ref.size_bytes)?
	);

	let _reclaim_probe = observe_reclaim_control_for_test(branch_id);
	let retire = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(retire.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"retirement must not strand the superseded hot generation"
	);
	let (reclaim_jobs, _) = observed_reclaim_control_for_test(branch_id);
	assert!(
		reclaim_jobs >= 2,
		"hot eviction must commit before the later pass retires its exact cold proof"
	);
	assert!(
		read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"retirement must atomically remove the superseded live ref"
	);
	assert!(
		read_value(
			&test_ctx,
			branch_compaction_cold_publish_key(branch_id, first_ref.publish_generation),
		)
		.await?
		.is_none(),
		"the last live ref retirement must compact its cold publication marker"
	);
	assert!(
		read_value(
			&test_ctx,
			branch_compaction_cold_publish_refcount_key(branch_id, first_ref.publish_generation,),
		)
		.await?
		.is_none(),
		"the last live ref retirement must compact its generation refcount"
	);
	assert!(
		first_object_path.is_file(),
		"retirement only queues the object; deletion runs in a later reclaim pass"
	);
	let retired_key = branch_compaction_retired_cold_object_key(
		branch_id,
		Sha256::digest(first_ref.object_key.as_bytes()).into(),
	);
	let mut retired = decode_retired_cold_object(
		&read_value(&test_ctx, retired_key.clone())
			.await?
			.context("retirement tombstone should be durable")?,
	)?;
	assert_eq!(retired.object_key, first_ref.object_key);
	let accounting = read_cold_accounting(&accounting_udb).await?;
	assert_eq!(accounting.live_objects, 1);
	assert_eq!(accounting.live_bytes, i64::try_from(second_ref.size_bytes)?);
	assert_eq!(accounting.retired_objects, 1);
	assert_eq!(
		accounting.retired_bytes,
		i64::try_from(first_ref.size_bytes)?
	);
	assert_eq!(
		retired.delete_after_ms - retired.retired_at_ms,
		7 * 24 * 60 * 60 * 1000,
		"retirement must honor the configured FDB backup recovery window"
	);
	let retired_hash = Sha256::digest(first_ref.object_key.as_bytes()).into();
	clear_value(
		&test_ctx,
		branch_compaction_retired_cold_object_due_key(
			branch_id,
			retired.delete_after_ms,
			retired_hash,
		),
	)
	.await?;
	retired.delete_after_ms = 0;
	retired.delete_state = depot::types::RetiredColdObjectDeleteState::DeleteIssued;
	let fence = certify_backup_after(&test_ctx, &retired.retired_versionstamp).await?;
	let policy = depot::cold_tier::read_cold_gc_policy(&accounting_udb).await?;
	retired.delete_authorization = Some(depot::types::ColdDeleteAuthorization {
		reason: depot::types::ColdDeleteReason::RetiredReplacement,
		policy_revision: Some(policy.revision),
		backup_policy_fingerprint: policy.backup_policy_fingerprint,
		minimum_restorable_version: Some(fence.minimum_restorable_version),
		fence_verified_at_ms: Some(fence.verified_at_ms),
		fence_valid_until_ms: Some(fence.valid_until_ms),
		tombstone_versionstamp: Some(retired.retired_versionstamp),
		issued_at_ms: fence.verified_at_ms,
	});
	tokio::fs::remove_file(&first_object_path).await?;
	let retired_for_seed = retired.clone();
	let retired_key_for_seed = retired_key.clone();
	accounting_udb
		.txn("test_seed_delete_issued_with_accounting", move |tx| {
			let retired = retired_for_seed.clone();
			let retired_key = retired_key_for_seed.clone();
			async move {
				tx.informal()
					.set(&retired_key, &encode_retired_cold_object(retired.clone())?);
				let bytes = i64::try_from(retired.size_bytes)?;
				apply_delta_for_branch(
					&tx,
					branch_id,
					ColdStorageAccountingDelta {
						retired_bytes: -bytes,
						retired_objects: -1,
						delete_issued_bytes: bytes,
						delete_issued_objects: 1,
						..Default::default()
					},
				);
				Ok(())
			}
		})
		.await?;
	set_value(
		&test_ctx,
		branch_compaction_retired_cold_object_due_key(branch_id, 0, retired_hash),
		Vec::new(),
	)
	.await?;
	let udb = test_ctx.pools().udb()?;
	udb.txn(
		"test_seed_unrelated_future_retired_due_rows",
		move |tx| async move {
			for offset in 0..2_048_u64 {
				let mut hash = [0_u8; 32];
				hash[24..].copy_from_slice(&offset.to_be_bytes());
				tx.informal().set(
					&branch_compaction_retired_cold_object_due_key(
						branch_id,
						i64::MAX - i64::try_from(offset)?,
						hash,
					),
					&[],
				);
			}
			Ok(())
		},
	)
	.await?;

	let delete = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(delete.terminal_error, None);
	assert!(
		!first_object_path.exists(),
		"retry after delete-before-tombstone-complete must remain idempotent"
	);
	let mut deleted = decode_retired_cold_object(
		&read_value(&test_ctx, retired_key.clone())
			.await?
			.context("deleted retirement tombstone should remain durable")?,
	)?;
	assert_eq!(
		deleted.delete_state,
		depot::types::RetiredColdObjectDeleteState::Deleted
	);
	let accounting = read_cold_accounting(&accounting_udb).await?;
	assert_eq!(accounting.delete_issued_objects, 0);
	assert_eq!(accounting.deleted_objects_total, 1);
	assert_eq!(
		accounting.deleted_bytes_total,
		i64::try_from(first_ref.size_bytes)?
	);
	let receipt =
		depot::cold_tier::read_cold_delete_receipt(&accounting_udb, &first_ref.object_key)
			.await?
			.context("exact-key deletion must commit an immutable audit receipt")?;
	assert_eq!(receipt.object_key, first_ref.object_key);
	assert_eq!(receipt.size_bytes, first_ref.size_bytes);
	assert_eq!(
		receipt.authorization.reason,
		depot::types::ColdDeleteReason::RetiredReplacement
	);
	assert_eq!(receipt.authorization.policy_revision, Some(1));
	assert_eq!(
		receipt.authorization.backup_policy_fingerprint,
		Some([0x42; 32])
	);
	assert_eq!(
		receipt.authorization.tombstone_versionstamp,
		Some(retired.retired_versionstamp)
	);
	let completed_due_key = branch_compaction_retired_cold_object_due_key(
		branch_id,
		deleted.delete_after_ms,
		retired_hash,
	);
	clear_value(&test_ctx, completed_due_key).await?;
	deleted.delete_after_ms = 0;
	set_value(
		&test_ctx,
		retired_key.clone(),
		encode_retired_cold_object(deleted)?,
	)
	.await?;
	set_value(
		&test_ctx,
		branch_compaction_retired_cold_object_due_key(branch_id, 0, retired_hash),
		Vec::new(),
	)
	.await?;
	let compact_tombstone = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(compact_tombstone.terminal_error, None);
	assert!(
		read_value(&test_ctx, retired_key).await?.is_none(),
		"expired completed-delete tombstones must be physically compacted"
	);
	assert!(cold_root.path().join(&second_ref.object_key).is_file());

	let read = db.get_pages(vec![1]).await?;
	assert_eq!(read[0].bytes, Some(vec![0x32; PAGE_SIZE as usize]));
	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn reclaim_refresh_tolerates_cold_ref_staged_before_atomic_publish() -> Result<()> {
	let (_cold_root, mut test_ctx, _db, branch_id, reference, manager_id) =
		setup_published_cold_shard("depot-cold-workflow-staged-ref-scan-").await?;
	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("published fixture must have a compaction root")?,
	)?;
	let mut staged = reference;
	staged.as_of_txid = root.cold_watermark_txid.saturating_add(1);
	staged.min_txid = staged.as_of_txid;
	staged.max_txid = staged.as_of_txid;
	staged.publish_generation = root.manifest_generation.saturating_add(1);
	staged.object_key = format!("{}.staged", staged.object_key);
	let staged_key =
		branch_compaction_cold_shard_key(branch_id, staged.shard_id, staged.as_of_txid);
	set_value(
		&test_ctx,
		staged_key.clone(),
		encode_cold_shard_ref(staged.clone())?,
	)
	.await?;

	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let reclaim = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(
		reclaim.terminal_error, None,
		"an unpublished staged ref must pin the retirement scan instead of killing the manager"
	);
	assert_eq!(
		decode_cold_shard_ref(
			&read_value(&test_ctx, staged_key)
				.await?
				.context("staged ref must remain for its atomic publish or repair")?,
		)?,
		staged
	);
	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn retired_cold_object_delete_fails_closed_without_explicit_opt_in() -> Result<()> {
	let (cold_root, mut test_ctx, _db, branch_id, first_ref, second_ref, manager_id) =
		setup_two_published_cold_versions("depot-cold-workflow-delete-disabled-").await?;
	let _grace = override_cold_object_delete_grace_for_test(branch_id, 0);
	let driver = DepotCompactionTestDriver::new(&test_ctx);

	let blocked = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert!(
		blocked
			.terminal_error
			.as_deref()
			.is_some_and(|error| error.contains("disabled by ColdGcPolicy")),
		"unexpected disabled-delete result: {blocked:?}"
	);
	assert!(
		read_value(
			&test_ctx,
			branch_compaction_cold_shard_key(branch_id, first_ref.shard_id, first_ref.as_of_txid),
		)
		.await?
		.is_none(),
		"the logical ref may retire even though physical object deletion is disabled"
	);
	let retired_key = branch_compaction_retired_cold_object_key(
		branch_id,
		Sha256::digest(first_ref.object_key.as_bytes()).into(),
	);
	let retired = decode_retired_cold_object(
		&read_value(&test_ctx, retired_key)
			.await?
			.context("disabled delete must retain its durable retirement tombstone")?,
	)?;
	assert_eq!(
		retired.delete_state,
		depot::types::RetiredColdObjectDeleteState::Retired,
		"the delete intent must not be issued while destructive deletion is disabled"
	);
	assert!(
		cold_root.path().join(&first_ref.object_key).is_file(),
		"disabled destructive GC must retain the retired exact object"
	);
	assert!(cold_root.path().join(&second_ref.object_key).is_file());

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn retired_cold_object_delete_requires_fresh_backup_restore_floor() -> Result<()> {
	let (cold_root, mut test_ctx, _db, branch_id, first_ref, _second_ref, manager_id) =
		setup_two_published_cold_versions("depot-cold-workflow-backup-fence-").await?;
	let _grace = override_cold_object_delete_grace_for_test(branch_id, 60_000);
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let retired = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(retired.terminal_error, None);

	let retired_hash = Sha256::digest(first_ref.object_key.as_bytes()).into();
	let retired_key = branch_compaction_retired_cold_object_key(branch_id, retired_hash);
	let mut row = decode_retired_cold_object(
		&read_value(&test_ctx, retired_key.clone())
			.await?
			.context("retired object should have a durable tombstone")?,
	)?;
	clear_value(
		&test_ctx,
		branch_compaction_retired_cold_object_due_key(branch_id, row.delete_after_ms, retired_hash),
	)
	.await?;
	row.delete_after_ms = 0;
	set_value(
		&test_ctx,
		retired_key.clone(),
		encode_retired_cold_object(row.clone())?,
	)
	.await?;
	set_value(
		&test_ctx,
		branch_compaction_retired_cold_object_due_key(branch_id, 0, retired_hash),
		Vec::new(),
	)
	.await?;
	certify_backup_after(&test_ctx, &row.retired_versionstamp).await?;
	clear_value(&test_ctx, depot::keys::cold_backup_recovery_fence_key()).await?;

	let blocked = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert!(
		blocked
			.terminal_error
			.as_deref()
			.is_some_and(|error| error.contains("cold backup recovery fence is missing")),
		"unexpected missing-fence result: {blocked:?}"
	);
	assert!(cold_root.path().join(&first_ref.object_key).is_file());
	assert_eq!(
		decode_retired_cold_object(
			&read_value(&test_ctx, retired_key.clone())
				.await?
				.context("blocked tombstone must remain")?,
		)?
		.delete_state,
		depot::types::RetiredColdObjectDeleteState::Retired
	);

	certify_backup_after(&test_ctx, &row.retired_versionstamp).await?;
	let deleted = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(deleted.terminal_error, None);
	assert!(!cold_root.path().join(&first_ref.object_key).exists());

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn advancing_global_cold_watermark_does_not_retire_unchanged_shard() -> Result<()> {
	let cold_root = Builder::new()
		.prefix("depot-cold-workflow-unchanged-shard-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("cold-workflow-unchanged-shard-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x51; PAGE_SIZE as usize],
		}],
		2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let published = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(published.terminal_error, None);
	let unchanged_ref = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.context("unchanged shard cold ref should exist")?,
	)?;

	db.commit(
		vec![DirtyPage {
			pgno: SHARD_SIZE + 1,
			bytes: vec![0x52; PAGE_SIZE as usize],
		}],
		SHARD_SIZE + 2,
		2_000,
	)
	.await?;
	let published = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(published.terminal_error, None);
	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("compaction root should exist")?,
	)?;
	assert_eq!(root.cold_watermark_txid, 2);

	let reclaimed = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(reclaimed.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.is_some(),
		"a global watermark cannot retire the only published version of an unchanged shard"
	);
	assert!(cold_root.path().join(&unchanged_ref.object_key).is_file());
	assert!(
		read_value(
			&test_ctx,
			branch_compaction_retired_cold_object_key(
				branch_id,
				Sha256::digest(unchanged_ref.object_key.as_bytes()).into(),
			),
		)
		.await?
		.is_none()
	);

	let pages = db.get_pages(vec![1, SHARD_SIZE + 1]).await?;
	assert_eq!(pages[0].bytes, Some(vec![0x51; PAGE_SIZE as usize]));
	assert_eq!(pages[1].bytes, Some(vec![0x52; PAGE_SIZE as usize]));
	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn history_pin_blocks_cold_retirement_until_released() -> Result<()> {
	let (cold_root, mut test_ctx, _db, branch_id, first_ref, _second_ref, manager_id) =
		setup_two_published_cold_versions("depot-cold-workflow-pin-").await?;
	let owner_branch = DatabaseBranchId::from_uuid(Uuid::new_v4());
	let fork_pin_id = history_pin::database_fork_pin_id(owner_branch);
	let restore_point = RestorePointId::format(2_000, 1)?;
	let restore_pin_id = history_pin::restore_point_pin_id(&restore_point);
	let udb = test_ctx.pools().udb()?;
	udb.txn("test_write_cold_retirement_pins", move |tx| {
		let restore_point = restore_point.clone();
		async move {
			history_pin::write_database_fork_pin(
				&tx,
				branch_id,
				owner_branch,
				first_ref.max_versionstamp,
				first_ref.as_of_txid,
				1_000,
			)
			.await?;
			history_pin::write_restore_point_pin(
				&tx,
				branch_id,
				restore_point,
				first_ref.max_versionstamp,
				first_ref.as_of_txid,
				2_000,
			)
			.await?;
			Ok(())
		}
	})
	.await?;

	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let pinned = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(pinned.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.is_some(),
		"a pin inside the old-to-new coverage interval must retain the old cold ref"
	);
	assert!(cold_root.path().join(&first_ref.object_key).is_file());

	udb.txn("test_delete_cold_retirement_fork_pin", move |tx| {
		let fork_pin_id = fork_pin_id.clone();
		async move { history_pin::delete_db_history_pin(&tx, branch_id, &fork_pin_id).await }
	})
	.await?;
	let still_restore_pinned = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(still_restore_pinned.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.is_some(),
		"releasing the fork pin must not bypass the independent restore-point pin"
	);
	assert!(cold_root.path().join(&first_ref.object_key).is_file());

	udb.txn("test_delete_cold_retirement_restore_pin", move |tx| {
		let restore_pin_id = restore_pin_id.clone();
		async move { history_pin::delete_db_history_pin(&tx, branch_id, &restore_pin_id).await }
	})
	.await?;
	let _grace = override_cold_object_delete_grace_for_test(branch_id, 60_000);
	let unpinned = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(unpinned.terminal_error, None);
	assert!(
		read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"the superseded ref becomes retireable after its pin is released"
	);
	assert!(cold_root.path().join(&first_ref.object_key).is_file());
	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn cold_delete_failure_keeps_delete_issued_tombstone_and_retries() -> Result<()> {
	let (cold_root, mut test_ctx, db, branch_id, first_ref, second_ref, manager_id) =
		setup_two_published_cold_versions("depot-cold-workflow-delete-retry-").await?;
	let _grace = override_cold_object_delete_grace_for_test(branch_id, 60_000);
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let retired = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(retired.terminal_error, None);
	let retired_key = branch_compaction_retired_cold_object_key(
		branch_id,
		Sha256::digest(first_ref.object_key.as_bytes()).into(),
	);
	let mut row = decode_retired_cold_object(
		&read_value(&test_ctx, retired_key.clone())
			.await?
			.context("retired row should exist")?,
	)?;
	let retired_hash = Sha256::digest(first_ref.object_key.as_bytes()).into();
	clear_value(
		&test_ctx,
		branch_compaction_retired_cold_object_due_key(branch_id, row.delete_after_ms, retired_hash),
	)
	.await?;
	row.delete_after_ms = 0;
	certify_backup_after(&test_ctx, &row.retired_versionstamp).await?;
	set_value(
		&test_ctx,
		retired_key.clone(),
		encode_retired_cold_object(row)?,
	)
	.await?;
	set_value(
		&test_ctx,
		branch_compaction_retired_cold_object_due_key(branch_id, 0, retired_hash),
		Vec::new(),
	)
	.await?;

	let object_path = cold_root.path().join(&first_ref.object_key);
	tokio::fs::remove_file(&object_path).await?;
	tokio::fs::create_dir(&object_path).await?;
	let failed = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert!(
		failed
			.terminal_error
			.as_deref()
			.is_some_and(|error| error.contains("retired cold object delete failed")),
		"unexpected delete failure result: {failed:?}"
	);
	let delete_issued = decode_retired_cold_object(
		&read_value(&test_ctx, retired_key.clone())
			.await?
			.context("delete-issued row should remain after COS failure")?,
	)?;
	assert_eq!(
		delete_issued.delete_state,
		depot::types::RetiredColdObjectDeleteState::DeleteIssued
	);
	assert!(cold_root.path().join(&second_ref.object_key).is_file());

	tokio::fs::remove_dir(&object_path).await?;
	let retried = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(retried.terminal_error, None);
	let deleted = decode_retired_cold_object(
		&read_value(&test_ctx, retired_key)
			.await?
			.context("deleted tombstone should remain")?,
	)?;
	assert_eq!(
		deleted.delete_state,
		depot::types::RetiredColdObjectDeleteState::Deleted
	);
	let pages = db.get_pages(vec![1]).await?;
	assert_eq!(pages[0].bytes, Some(vec![0x42; PAGE_SIZE as usize]));
	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn missing_published_replacement_blocks_due_cold_delete_until_repaired() -> Result<()> {
	let (cold_root, mut test_ctx, db, branch_id, first_ref, second_ref, manager_id) =
		setup_two_published_cold_versions("depot-cold-workflow-delete-revalidate-").await?;
	let _grace = override_cold_object_delete_grace_for_test(branch_id, 60_000);
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let retired = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(retired.terminal_error, None);

	let retired_key = branch_compaction_retired_cold_object_key(
		branch_id,
		Sha256::digest(first_ref.object_key.as_bytes()).into(),
	);
	let mut retired_row = decode_retired_cold_object(
		&read_value(&test_ctx, retired_key.clone())
			.await?
			.context("retired row should exist before replacement revalidation")?,
	)?;
	let retired_hash = Sha256::digest(first_ref.object_key.as_bytes()).into();
	clear_value(
		&test_ctx,
		branch_compaction_retired_cold_object_due_key(
			branch_id,
			retired_row.delete_after_ms,
			retired_hash,
		),
	)
	.await?;
	retired_row.delete_after_ms = 0;
	certify_backup_after(&test_ctx, &retired_row.retired_versionstamp).await?;
	set_value(
		&test_ctx,
		retired_key.clone(),
		encode_retired_cold_object(retired_row)?,
	)
	.await?;
	set_value(
		&test_ctx,
		branch_compaction_retired_cold_object_due_key(branch_id, 0, retired_hash),
		Vec::new(),
	)
	.await?;

	let replacement_key =
		branch_compaction_cold_shard_key(branch_id, second_ref.shard_id, second_ref.as_of_txid);
	let replacement_value = read_value(&test_ctx, replacement_key.clone())
		.await?
		.context("replacement ref should exist before fault injection")?;
	clear_value(&test_ctx, replacement_key.clone()).await?;

	let blocked = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert!(
		blocked.terminal_error.as_deref().is_some_and(
			|error| error.contains("newer published cold replacement is missing before delete")
		),
		"unexpected replacement revalidation result: {blocked:?}"
	);
	assert!(
		cold_root.path().join(&first_ref.object_key).is_file(),
		"a missing replacement must fail closed before the exact object delete"
	);
	let still_retired = decode_retired_cold_object(
		&read_value(&test_ctx, retired_key.clone())
			.await?
			.context("retirement tombstone should remain after rejected delete")?,
	)?;
	assert_eq!(
		still_retired.delete_state,
		depot::types::RetiredColdObjectDeleteState::Retired,
		"the delete intent must not be issued until a replacement is re-proven"
	);

	set_value(&test_ctx, replacement_key, replacement_value).await?;
	let repaired = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(repaired.terminal_error, None);
	assert!(!cold_root.path().join(&first_ref.object_key).exists());
	let deleted = decode_retired_cold_object(
		&read_value(&test_ctx, retired_key)
			.await?
			.context("deleted tombstone should remain after replacement repair")?,
	)?;
	assert_eq!(
		deleted.delete_state,
		depot::types::RetiredColdObjectDeleteState::Deleted
	);
	let pages = db.get_pages(vec![1]).await?;
	assert_eq!(pages[0].bytes, Some(vec![0x42; PAGE_SIZE as usize]));

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn noncanonical_retirement_row_cannot_delete_another_cold_object() -> Result<()> {
	let (cold_root, mut test_ctx, _db, branch_id, first_ref, second_ref, manager_id) =
		setup_two_published_cold_versions("depot-cold-workflow-delete-key-fence-").await?;
	let _grace = override_cold_object_delete_grace_for_test(branch_id, 60_000);
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let retired = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(retired.terminal_error, None);

	let original_key_hash = Sha256::digest(first_ref.object_key.as_bytes()).into();
	let original_key = branch_compaction_retired_cold_object_key(branch_id, original_key_hash);
	let mut forged = decode_retired_cold_object(
		&read_value(&test_ctx, original_key)
			.await?
			.context("original retirement row should exist")?,
	)?;
	// Point a syntactically valid tombstone at the replacement object's exact path while keeping
	// the old object's immutable identity. Delete preflight must recompute the canonical key from
	// those fields and stop before touching storage.
	forged.object_key = second_ref.object_key.clone();
	forged.delete_after_ms = 0;
	certify_backup_after(&test_ctx, &forged.retired_versionstamp).await?;
	let forged_key_hash = Sha256::digest(forged.object_key.as_bytes()).into();
	set_value(
		&test_ctx,
		branch_compaction_retired_cold_object_key(branch_id, forged_key_hash),
		encode_retired_cold_object(forged)?,
	)
	.await?;
	set_value(
		&test_ctx,
		branch_compaction_retired_cold_object_due_key(branch_id, 0, forged_key_hash),
		Vec::new(),
	)
	.await?;

	let rejected = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert!(
		rejected
			.terminal_error
			.as_deref()
			.is_some_and(|error| error.contains("noncanonical object key")),
		"unexpected forged-delete result: {rejected:?}"
	);
	assert!(
		cold_root.path().join(&second_ref.object_key).is_file(),
		"a forged FDB tombstone must never delete another canonical cold object"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn unpublished_replacement_cannot_authorize_cold_retirement() -> Result<()> {
	let (cold_root, mut test_ctx, db, branch_id, first_ref, second_ref, manager_id) =
		setup_two_published_cold_versions("depot-cold-workflow-retire-marker-").await?;
	let _grace = override_cold_object_delete_grace_for_test(branch_id, 60_000);
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let marker_key = branch_compaction_cold_publish_key(branch_id, second_ref.publish_generation);
	let marker_value = read_value(&test_ctx, marker_key.clone())
		.await?
		.context("replacement publish marker should exist before fault injection")?;
	clear_value(&test_ctx, marker_key.clone()).await?;

	let skipped = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(skipped.terminal_error, None);
	assert!(
		read_value(
			&test_ctx,
			branch_compaction_cold_shard_key(branch_id, first_ref.shard_id, first_ref.as_of_txid),
		)
		.await?
		.is_some(),
		"a staged replacement without its atomic marker cannot retire the prior version"
	);
	assert!(cold_root.path().join(&first_ref.object_key).is_file());
	let retired_key = branch_compaction_retired_cold_object_key(
		branch_id,
		Sha256::digest(first_ref.object_key.as_bytes()).into(),
	);
	assert!(read_value(&test_ctx, retired_key.clone()).await?.is_none());

	set_value(&test_ctx, marker_key, marker_value).await?;
	let repaired = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(repaired.terminal_error, None);
	assert!(
		read_value(
			&test_ctx,
			branch_compaction_cold_shard_key(branch_id, first_ref.shard_id, first_ref.as_of_txid),
		)
		.await?
		.is_none(),
		"the old ref becomes retireable after the marker is restored"
	);
	let retired = decode_retired_cold_object(
		&read_value(&test_ctx, retired_key)
			.await?
			.context("retirement tombstone should be written after marker repair")?,
	)?;
	assert_eq!(
		retired.delete_state,
		depot::types::RetiredColdObjectDeleteState::Retired
	);
	assert!(cold_root.path().join(&first_ref.object_key).is_file());
	let pages = db.get_pages(vec![1]).await?;
	assert_eq!(pages[0].bytes, Some(vec![0x42; PAGE_SIZE as usize]));

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn cold_publish_stages_more_than_sixty_four_shards_behind_one_atomic_marker() -> Result<()> {
	const SHARD_COUNT: u32 = 65;
	let cold_root = Builder::new()
		.prefix("depot-cold-workflow-wide-publish-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("cold-workflow-wide-publish-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	let pages = (0..SHARD_COUNT)
		.map(|shard_id| DirtyPage {
			pgno: shard_id * SHARD_SIZE + 1,
			bytes: vec![u8::try_from(shard_id).unwrap(); PAGE_SIZE as usize],
		})
		.collect::<Vec<_>>();
	db.commit(pages, (SHARD_COUNT - 1) * SHARD_SIZE + 1, 1_000)
		.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let _upload_probe = observe_cold_upload_concurrency_for_test(branch_id, 25);
	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let result = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: true,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(result.terminal_error, None);

	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("wide cold compaction root should be published")?,
	)?;
	let marker = decode_cold_publish_marker(
		&read_value(
			&test_ctx,
			branch_compaction_cold_publish_key(branch_id, root.manifest_generation),
		)
		.await?
		.context("wide cold generation must have one atomic publication marker")?,
	)?;
	assert_eq!(marker.output_ref_count, SHARD_COUNT);
	assert_eq!(root.cold_watermark_txid, 1);
	assert!(
		max_observed_cold_upload_concurrency_for_test(branch_id) >= 2,
		"cold object publication must overlap independent exact-key PUTs"
	);
	assert!(
		max_observed_cold_upload_concurrency_for_test(branch_id) <= 16,
		"cold object publication concurrency must remain hard bounded"
	);

	for shard_id in 0..SHARD_COUNT {
		let reference = decode_cold_shard_ref(
			&read_value(
				&test_ctx,
				branch_compaction_cold_shard_key(branch_id, shard_id, 1),
			)
			.await?
			.context("all staged refs must be present after marker publication")?,
		)?;
		assert!(marker.matches_ref(&reference));
		assert!(cold_root.path().join(reference.object_key).is_file());
	}

	let count = read_value(
		&test_ctx,
		branch_compaction_cold_publish_refcount_key(branch_id, root.manifest_generation),
	)
	.await?
	.context("cold publication must install its refcount atomically")?;
	assert_eq!(
		i64::from_le_bytes(
			count
				.as_slice()
				.try_into()
				.context("refcount must be i64")?,
		),
		i64::from(SHARD_COUNT)
	);

	// Reclaim control-plane vectors are capped below the workflow signal budget. A wide hot cache
	// therefore drains through deterministic branch-local pages rather than one oversized signal.
	let _reclaim_probe = observe_reclaim_control_for_test(branch_id);
	let reclaim = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(reclaim.terminal_error, None);
	let (job_count, max_lane_items) = observed_reclaim_control_for_test(branch_id);
	assert!(
		job_count >= 3,
		"65 hot evictions should require at least three jobs"
	);
	assert!(
		max_lane_items
			.into_iter()
			.all(|count| count <= depot::CMP_RECLAIM_CONTROL_MAX_ITEMS_PER_LANE),
		"each actual reclaim signal lane must obey the control-plane cap: {max_lane_items:?}"
	);
	for shard_id in 0..SHARD_COUNT {
		assert!(
			read_value(&test_ctx, branch_shard_key(branch_id, shard_id, 1))
				.await?
				.is_none(),
			"manager should keep scheduling bounded jobs until hot shard {shard_id} is evicted"
		);
	}

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn cold_backlog_over_one_job_limit_drains_by_bounded_hot_generation() -> Result<()> {
	const FIRST_GENERATION_SHARDS: u32 = 251;
	const SECOND_GENERATION_SHARDS: u32 = 250;
	const TOTAL_SHARDS: u32 = FIRST_GENERATION_SHARDS + SECOND_GENERATION_SHARDS;
	assert!(TOTAL_SHARDS as usize > depot::CMP_COLD_MAX_SHARDS_PER_JOB);

	let cold_root = Builder::new()
		.prefix("depot-cold-workflow-bounded-backlog-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("cold-workflow-bounded-backlog-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	let first_pages = (0..FIRST_GENERATION_SHARDS)
		.map(|shard_id| DirtyPage {
			pgno: shard_id * SHARD_SIZE + 1,
			bytes: vec![0x71; PAGE_SIZE as usize],
		})
		.collect::<Vec<_>>();
	db.commit(
		first_pages,
		(FIRST_GENERATION_SHARDS - 1) * SHARD_SIZE + 2,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver =
		DepotCompactionTestDriver::new(&test_ctx).with_wait_timeout(Duration::from_secs(30));
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let first_hot = driver
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
	assert_eq!(first_hot.terminal_error, None);
	let first_manifest = decode_hot_generation_manifest(
		&read_value(
			&test_ctx,
			branch_compaction_hot_generation_key(branch_id, 1),
		)
		.await?
		.context("first bounded hot generation should exist")?,
	)?;
	assert_eq!(
		first_manifest.shards.len(),
		FIRST_GENERATION_SHARDS as usize
	);

	let second_pages = (FIRST_GENERATION_SHARDS..TOTAL_SHARDS)
		.map(|shard_id| DirtyPage {
			pgno: shard_id * SHARD_SIZE + 1,
			bytes: vec![0x72; PAGE_SIZE as usize],
		})
		.collect::<Vec<_>>();
	db.commit(second_pages, (TOTAL_SHARDS - 1) * SHARD_SIZE + 2, 2_000)
		.await?;
	let second_hot = driver
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
	assert_eq!(second_hot.terminal_error, None);
	let second_manifest = decode_hot_generation_manifest(
		&read_value(
			&test_ctx,
			branch_compaction_hot_generation_key(branch_id, 2),
		)
		.await?
		.context("second bounded hot generation should exist")?,
	)?;
	assert_eq!(
		second_manifest.shards.len(),
		SECOND_GENERATION_SHARDS as usize
	);

	let drained = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(drained.terminal_error, None);
	assert_eq!(
		drained.attempted_job_kinds,
		vec![CompactionJobKind::Cold],
		"attempted_job_kinds intentionally reports unique job kinds"
	);
	assert_eq!(
		drained.completed_job_ids.len(),
		2,
		"one force request should keep scheduling bounded generations until the backlog converges"
	);
	let root_after_drain = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("root should advance through both bounded cold batches")?,
	)?;
	assert_eq!(root_after_drain.cold_watermark_txid, 2);
	assert!(
		read_value(
			&test_ctx,
			branch_compaction_hot_generation_key(branch_id, 1)
		)
		.await?
		.is_none()
	);
	assert!(
		read_value(
			&test_ctx,
			branch_compaction_hot_generation_key(branch_id, 2),
		)
		.await?
		.is_none()
	);
	assert_eq!(
		cold_object_files(cold_root.path())?.len(),
		TOTAL_SHARDS as usize
	);

	let first_ref = decode_cold_shard_ref(
		&read_value(&test_ctx, branch_compaction_cold_shard_key(branch_id, 0, 1))
			.await?
			.context("first generation cold ref should exist")?,
	)?;
	let last_ref = decode_cold_shard_ref(
		&read_value(
			&test_ctx,
			branch_compaction_cold_shard_key(branch_id, TOTAL_SHARDS - 1, 2),
		)
		.await?
		.context("second generation cold ref should exist")?,
	)?;
	assert!(cold_root.path().join(first_ref.object_key).is_file());
	assert!(cold_root.path().join(last_ref.object_key).is_file());
	let pages = db
		.get_pages(vec![1, (TOTAL_SHARDS - 1) * SHARD_SIZE + 1])
		.await?;
	assert_eq!(pages[0].bytes, Some(vec![0x71; PAGE_SIZE as usize]));
	assert_eq!(pages[1].bytes, Some(vec![0x72; PAGE_SIZE as usize]));

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn hot_batch_budget_accounts_for_pidx_rows_before_advancing_watermark() -> Result<()> {
	const COMMIT_COUNT: u32 = (depot::CMP_FDB_BATCH_MAX_KEYS / 2) as u32;

	let cold_root = Builder::new()
		.prefix("depot-hot-workflow-pidx-budget-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("hot-workflow-pidx-budget-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;
	for txid in 1..=COMMIT_COUNT {
		let pgno = (txid - 1) * SHARD_SIZE + 1;
		db.commit(
			vec![DirtyPage {
				pgno,
				bytes: vec![(txid % 251) as u8; PAGE_SIZE as usize],
			}],
			pgno + 1,
			i64::from(txid) * 1_000,
		)
		.await?;
	}

	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let driver =
		DepotCompactionTestDriver::new(&test_ctx).with_wait_timeout(Duration::from_secs(30));
	let manager_id = driver.start_manager(branch_id, None, true).await?;
	let hot = driver
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
	assert_eq!(hot.terminal_error, None);
	assert!(
		hot.completed_job_ids.len() >= 2,
		"PIDX mutation rows must participate in the FDB key budget, forcing this backlog into multiple bounded jobs"
	);
	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("hot root should converge through all bounded jobs")?,
	)?;
	assert_eq!(root.hot_watermark_txid, u64::from(COMMIT_COUNT));
	assert!(
		read_prefix_values(&test_ctx, branch_pidx_prefix(branch_id))
			.await?
			.is_empty(),
		"hot compaction must not advance past PIDX rows that did not fit its install transaction"
	);
	let last_pgno = (COMMIT_COUNT - 1) * SHARD_SIZE + 1;
	let pages = db.get_pages(vec![1, last_pgno]).await?;
	assert_eq!(pages[0].bytes, Some(vec![1; PAGE_SIZE as usize]));
	assert_eq!(
		pages[1].bytes,
		Some(vec![(COMMIT_COUNT % 251) as u8; PAGE_SIZE as usize])
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn hot_sparse_updates_to_full_shards_do_not_overflow_one_fdb_transaction() -> Result<()> {
	const SHARD_COUNT: u32 = 40;
	const SHARDS_PER_SEED_COMMIT: u32 = 5;

	let cold_root = Builder::new()
		.prefix("depot-hot-workflow-full-shard-budget-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("hot-workflow-full-shard-budget-{}", Uuid::new_v4());
	let db = make_db(&test_ctx, &database_id).await?;

	// Materialize forty almost-full 256 KiB shards using transactions that are
	// individually below the compaction value budget.
	let mut manager = None;
	for group_start in (0..SHARD_COUNT).step_by(SHARDS_PER_SEED_COMMIT as usize) {
		let mut pages = Vec::new();
		for shard_id in group_start..group_start + SHARDS_PER_SEED_COMMIT {
			let first_pgno = (shard_id * SHARD_SIZE).max(1);
			let last_pgno = (shard_id + 1) * SHARD_SIZE - 1;
			for pgno in first_pgno..=last_pgno {
				pages.push(DirtyPage {
					pgno,
					bytes: incompressible_test_page((u64::from(shard_id) << 32) | u64::from(pgno)),
				});
			}
		}
		let db_size_pages = (group_start + SHARDS_PER_SEED_COMMIT) * SHARD_SIZE;
		db.commit(pages, db_size_pages, i64::from(group_start + 1) * 1_000)
			.await?;
		let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
		let driver =
			DepotCompactionTestDriver::new(&test_ctx).with_wait_timeout(Duration::from_secs(30));
		let manager_id = match manager {
			Some(manager_id) => manager_id,
			None => {
				let manager_id = driver.start_manager(branch_id, None, true).await?;
				manager = Some(manager_id);
				manager_id
			}
		};
		let seeded = driver
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
		assert_eq!(seeded.terminal_error, None);
	}

	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;
	let manager_id = manager.context("hot manager should have been started")?;
	let sparse_updates = (0..SHARD_COUNT)
		.map(|shard_id| DirtyPage {
			pgno: (shard_id * SHARD_SIZE).max(1),
			bytes: incompressible_test_page(0xf000_0000_0000_0000 | u64::from(shard_id)),
		})
		.collect::<Vec<_>>();
	db.commit(sparse_updates, SHARD_COUNT * SHARD_SIZE, 100_000)
		.await?;
	let driver =
		DepotCompactionTestDriver::new(&test_ctx).with_wait_timeout(Duration::from_secs(30));
	let hot = driver
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
	assert_eq!(
		hot.terminal_error, None,
		"materialized output expansion must not make one FDB transaction exceed its hard size limit"
	);
	let root = decode_compaction_root(
		&read_value(&test_ctx, branch_compaction_root_key(branch_id))
			.await?
			.context("hot root should publish the sparse update generation")?,
	)?;
	assert_eq!(root.hot_watermark_txid, 9);
	let mut latest_blob_bytes = 0_usize;
	for shard_id in 0..SHARD_COUNT {
		let row = read_value(&test_ctx, branch_shard_key(branch_id, shard_id, 9))
			.await?
			.with_context(|| format!("final hot shard {shard_id} should be published"))?;
		assert!(
			row.len() < 100 * 1024,
			"canonical SHARD row must remain below FoundationDB's single-value limit"
		);
		let manifest = decode_hot_shard_manifest(&row)
			.with_context(|| format!("full hot shard {shard_id} should use chunk indirection"))?;
		let mut chunks = Vec::with_capacity(manifest.chunk_count as usize);
		for chunk_idx in 0..manifest.chunk_count {
			chunks.push(
				read_value(
					&test_ctx,
					branch_shard_chunk_key(branch_id, shard_id, 9, chunk_idx),
				)
				.await?
				.with_context(|| format!("hot shard {shard_id} chunk {chunk_idx} should exist"))?,
			);
		}
		assert!(chunks.iter().all(|chunk| chunk.len() <= 64 * 1024));
		assert_eq!(
			chunks.iter().map(Vec::len).sum::<usize>(),
			manifest.encoded_len as usize
		);
		latest_blob_bytes = latest_blob_bytes.saturating_add(manifest.encoded_len as usize);
	}
	assert!(
		latest_blob_bytes > 10 * 1024 * 1024,
		"the regression fixture must exceed FoundationDB's 10 MiB transaction limit after materialization; got {latest_blob_bytes} bytes"
	);
	let last_pgno = (SHARD_COUNT - 1) * SHARD_SIZE;
	let pages = db.get_pages(vec![1, last_pgno]).await?;
	assert_eq!(
		pages[0].bytes,
		Some(incompressible_test_page(0xf000_0000_0000_0000))
	);
	assert_eq!(
		pages[1].bytes,
		Some(incompressible_test_page(
			0xf000_0000_0000_0000 | u64::from(SHARD_COUNT - 1)
		))
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn bucket_fork_proof_pages_more_than_five_hundred_independent_catalog_roots() -> Result<()> {
	const ROOT_COUNT: u16 = 513;
	let cold_root = Builder::new()
		.prefix("depot-bucket-proof-pages-")
		.tempdir()?;
	let mut test_ctx = test_ctx_with_filesystem_cold_tier(cold_root.path()).await?;
	let database_id = format!("bucket-proof-pages-{}", Uuid::new_v4());
	let db = make_fdb_only_db(&test_ctx, &database_id)?;
	db.commit(
		vec![DirtyPage {
			pgno: 1,
			bytes: vec![0x5a; PAGE_SIZE as usize],
		}],
		1,
		1_000,
	)
	.await?;
	let branch_id = read_database_branch_id(&test_ctx, &database_id).await?;

	let mut rows = Vec::with_capacity(ROOT_COUNT as usize);
	for index in 0..ROOT_COUNT {
		// Exercise all 256 epoch shards while keeping every synthetic bucket root unique.
		let uuid = Uuid::from_u128(
			(u128::from(index % 256) << 120) | 0x00ab_cdef_0000_0000 | u128::from(index),
		);
		let root = BucketBranchId::from_uuid(uuid);
		let record = encode_bucket_branch_record(BucketBranchRecord {
			branch_id: root,
			parent: None,
			parent_versionstamp: None,
			root_versionstamp: [1; 16],
			fork_depth: 0,
			created_at_ms: 1_000,
			created_from_restore_point: None,
			state: BranchState::Live,
		})?;
		let fact = encode_bucket_catalog_db_fact(BucketCatalogDbFact {
			database_branch_id: branch_id,
			bucket_branch_id: root,
			catalog_versionstamp: [1; 16],
			// Historical catalog membership still participates in root-epoch proof, but does not
			// enqueue a pointless child traversal for this catalog-pagination fixture.
			tombstone_versionstamp: Some([2; 16]),
		})?;
		rows.push((root, record, fact));
	}
	let udb = test_ctx.pools().udb()?;
	for chunk in rows.chunks(32) {
		let chunk = chunk.to_vec();
		udb.txn("test_seed_paginated_bucket_proof_roots", move |tx| {
			let chunk = chunk.clone();
			async move {
				for (root, record, fact) in chunk {
					tx.informal().set(&bucket_branches_list_key(root), &record);
					tx.informal()
						.set(&bucket_catalog_by_db_key(branch_id, root), &fact);
				}
				Ok(())
			}
		})
		.await?;
	}

	let mut passes = 0_u32;
	loop {
		passes = passes.saturating_add(1);
		if !advance_bucket_fork_proof_for_test(&udb, branch_id).await? {
			break;
		}
		ensure!(passes < 64, "durable bucket proof did not converge");
	}
	assert!(
		passes > 20,
		"fixture must actually cross the old 500-row and 64-root limits"
	);
	assert!(
		read_value(&test_ctx, branch_bucket_proof_complete_key(branch_id))
			.await?
			.is_some(),
		"proof completion must be durable"
	);
	assert_eq!(
		read_prefix_values(&test_ctx, branch_bucket_proof_epoch_shard_prefix(branch_id))
			.await?
			.len(),
		256,
		"arbitrarily many roots must collapse onto fixed proof epoch fanout"
	);
	assert!(
		read_prefix_values(&test_ctx, branch_bucket_proof_root_prefix(branch_id))
			.await?
			.is_empty(),
		"proof metadata must not retain one durable row per independent root"
	);
	assert!(
		read_prefix_values(&test_ctx, branch_bucket_proof_seen_prefix(branch_id))
			.await?
			.is_empty(),
		"proof-scoped cycle detection rows must be cleared on completion"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn missing_and_corrupt_cold_objects_fail_closed_without_refill() -> Result<()> {
	let (cold_root, mut test_ctx, db, branch_id, reference) =
		setup_evicted_cold_shard("depot-cold-workflow-fail-closed-").await?;
	let object_path = cold_root.path().join(&reference.object_key);
	let object_bytes = tokio::fs::read(&object_path).await?;

	tokio::fs::remove_file(&object_path).await?;
	let missing = db
		.get_pages(vec![1])
		.await
		.expect_err("missing cold object must fail instead of zero-filling");
	assert!(contains_storage_error(&missing, |error| matches!(
		error,
		SqliteStorageError::ColdObjectUnavailable { .. }
	)));
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"failed exact GET must not create a hot-cache row"
	);

	tokio::fs::write(&object_path, &object_bytes[..object_bytes.len() / 2]).await?;
	let corrupt = db
		.get_pages(vec![1])
		.await
		.expect_err("corrupt cold object must fail instead of zero-filling");
	assert!(contains_storage_error(&corrupt, |error| matches!(
		error,
		SqliteStorageError::ColdObjectCorrupt { .. }
	)));
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"failed integrity validation must not create a hot-cache row"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn cold_ref_without_atomic_publish_marker_fails_closed() -> Result<()> {
	let (_cold_root, mut test_ctx, db, branch_id, reference) =
		setup_evicted_cold_shard("depot-cold-workflow-missing-marker-").await?;
	clear_value(
		&test_ctx,
		branch_compaction_cold_publish_key(branch_id, reference.publish_generation),
	)
	.await?;

	let error = db
		.get_pages(vec![1])
		.await
		.expect_err("a staged ref without its atomic marker must never become readable");
	assert!(
		format!("{error:#}").contains("atomic publication marker"),
		"unexpected missing-marker error: {error:#}"
	);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_none(),
		"an unpublished cold ref must never refill the hot cache"
	);

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn missing_cold_object_blocks_hot_eviction() -> Result<()> {
	let (cold_root, mut test_ctx, _db, branch_id, reference, manager_id) =
		setup_published_cold_shard("depot-cold-workflow-eviction-preflight-").await?;
	tokio::fs::remove_file(cold_root.path().join(&reference.object_key)).await?;

	let driver = DepotCompactionTestDriver::new(&test_ctx);
	let reclaim = driver
		.force_compaction(
			manager_id,
			branch_id,
			ForceCompactionWork {
				hot: false,
				cold: false,
				reclaim: true,
				final_settle: false,
			},
		)
		.await?;
	assert_eq!(
		reclaim.attempted_job_kinds,
		vec![CompactionJobKind::Reclaim]
	);
	assert!(
		read_value(&test_ctx, branch_shard_key(branch_id, 0, 1))
			.await?
			.is_some(),
		"reclaimer must retain the hot shard when exact COS preflight fails"
	);

	test_ctx.shutdown().await?;
	Ok(())
}
