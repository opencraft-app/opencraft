mod common;

use std::sync::Arc;

use anyhow::Result;
#[cfg(feature = "test-faults")]
use depot::fault::{CommitFaultPoint, DepotFaultController, DepotFaultPoint, FaultBoundary};
use depot::{
	ACCESS_TOUCH_THROTTLE_MS, MAX_COMMIT_DIRTY_PAGES, MAX_COMMIT_RAW_DIRTY_BYTES,
	conveyer::Db,
	conveyer::{
		commit::{clear_sqlite_cmp_dirty_if_observed_idle, test_hooks},
		db::CompactionSignaler,
		shard_blob::write_branch_shard_blob,
	},
	error::SqliteStorageError,
	keys::{
		PAGE_SIZE, branch_commit_key, branch_compaction_root_key, branch_delta_chunk_key,
		branch_manifest_last_access_bucket_key, branch_manifest_last_access_ts_ms_key,
		branch_meta_commit_attempt_key, branch_meta_compact_key, branch_meta_head_key,
		branch_page_history_complete_txid_key, branch_page_history_key, branch_pidx_count_node_key,
		branch_pidx_key, branch_shard_chunk_key, branch_shard_key, branch_vtx_key,
		branches_list_key, bucket_branches_list_key, bucket_branches_refcount_key,
		bucket_pointer_cur_key, ctr_eviction_index_key, database_pointer_cur_key,
		decode_sqlite_cmp_dirty_due_key, sqlite_cmp_dirty_due_key,
		sqlite_cmp_dirty_due_locator_key, sqlite_cmp_dirty_key,
	},
	ltx::{LtxHeader, encode_ltx_v3},
	quota::{self, FDB_WRITE_DEBT_LIMIT_BYTES},
	types::{
		BucketId, CommitOptions, CompactionRoot, DBHead, DatabaseBranchId, DirtyPage, FetchedPage,
		GetPagesOptions, MetaCompact, SqliteCmpDirty, decode_bucket_branch_record,
		decode_bucket_pointer, decode_commit_attempt_proof, decode_commit_row,
		decode_database_branch_record, decode_database_pointer, decode_db_head,
		decode_hot_shard_manifest, decode_sqlite_cmp_dirty, encode_compaction_root, encode_db_head,
		encode_meta_compact, encode_sqlite_cmp_dirty,
	},
	workflows::compaction::DeltasAvailable,
};
use futures_util::FutureExt;
use gas::prelude::Id;
use parking_lot::Mutex;
use rivet_pools::NodeId;
use sha2::{Digest, Sha256};
use universaldb::utils::IsolationLevel::Snapshot;

const TEST_DATABASE: &str = "test-database";

fn test_bucket() -> Id {
	Id::v1(uuid::Uuid::from_u128(0x1234), 1)
}

fn recording_compaction_signaler(signals: Arc<Mutex<Vec<DeltasAvailable>>>) -> CompactionSignaler {
	Arc::new(move |signal| {
		let signals = Arc::clone(&signals);
		async move {
			signals.lock().push(signal);
			Ok(())
		}
		.boxed()
	})
}

macro_rules! commit_matrix {
	($prefix:expr, |$ctx:ident, $db:ident, $database_db:ident| $body:block) => {
		common::test_matrix($prefix, |_tier, $ctx| {
			Box::pin(async move {
				let $db = $ctx.udb.clone();
				let $database_db = $ctx.make_db(test_bucket(), TEST_DATABASE);
				$body
			})
		})
		.await
	};
}

fn head_with_branch(branch_id: DatabaseBranchId, head_txid: u64, db_size_pages: u32) -> DBHead {
	DBHead {
		head_txid,
		db_size_pages,
		post_apply_checksum: 0,
		branch_id,
	}
}

fn page(pgno: u32, fill: u8) -> DirtyPage {
	DirtyPage {
		pgno,
		bytes: vec![fill; PAGE_SIZE as usize],
	}
}

fn writer_fence_key() -> Vec<u8> {
	b"\x02/test/depot/writer-generation".to_vec()
}

async fn set_writer_generation(
	db: &universaldb::Database,
	key: Vec<u8>,
	generation: u32,
) -> Result<()> {
	seed(db, vec![(key, generation.to_be_bytes().to_vec())]).await
}

fn short_page(pgno: u32) -> DirtyPage {
	DirtyPage {
		pgno,
		bytes: vec![0; 128],
	}
}

fn fetched_page(pgno: u32, fill: u8) -> FetchedPage {
	FetchedPage {
		pgno,
		bytes: Some(vec![fill; PAGE_SIZE as usize]),
	}
}

fn zero_filled_page(pgno: u32) -> FetchedPage {
	FetchedPage {
		pgno,
		bytes: Some(vec![0; PAGE_SIZE as usize]),
	}
}

fn encoded_blob(txid: u64, pages: &[(u32, u8)]) -> Result<Vec<u8>> {
	let pages = pages
		.iter()
		.map(|(pgno, fill)| page(*pgno, *fill))
		.collect::<Vec<_>>();

	encode_ltx_v3(LtxHeader::delta(txid, 1, 999), &pages)
}

fn encoded_shard_blob(txid: u64, first_pgno: u32, last_pgno: u32) -> Result<Vec<u8>> {
	let pages = (first_pgno..=last_pgno)
		.map(|pgno| DirtyPage {
			pgno,
			bytes: incompressible_page(u64::from(pgno)),
		})
		.collect::<Vec<_>>();
	encode_ltx_v3(LtxHeader::delta(txid, last_pgno, 999), &pages)
}

fn incompressible_page(seed: u64) -> Vec<u8> {
	let mut page = Vec::with_capacity(PAGE_SIZE as usize);
	for block in 0_u64..u64::from(PAGE_SIZE) / 32 {
		let mut hash = Sha256::new();
		hash.update(seed.to_be_bytes());
		hash.update(block.to_be_bytes());
		page.extend_from_slice(&hash.finalize());
	}
	page
}

async fn seed_hot_shard_blob(
	db: &universaldb::Database,
	branch_id: DatabaseBranchId,
	shard_id: u32,
	as_of_txid: u64,
	blob: Vec<u8>,
) -> Result<()> {
	db.txn("test_depotconveyer_seed_hot_shard", move |tx| {
		let blob = blob.clone();
		async move { write_branch_shard_blob(&tx, branch_id, shard_id, as_of_txid, &blob) }
	})
	.await
}

async fn seed(db: &universaldb::Database, writes: Vec<(Vec<u8>, Vec<u8>)>) -> Result<()> {
	db.txn("test_depotconveyer_commit", move |tx| {
		let writes = writes.clone();
		async move {
			for (key, value) in writes {
				tx.informal().set(&key, &value);
			}
			Ok(())
		}
	})
	.await
}

async fn read_value(db: &universaldb::Database, key: Vec<u8>) -> Result<Option<Vec<u8>>> {
	db.txn("test_depotconveyer_commit", move |tx| {
		let key = key.clone();
		async move {
			Ok(tx
				.informal()
				.get(&key, Snapshot)
				.await?
				.map(Vec::<u8>::from))
		}
	})
	.await
}

async fn read_i64_le(db: &universaldb::Database, key: Vec<u8>) -> Result<Option<i64>> {
	read_value(db, key)
		.await?
		.map(|value| {
			Ok(i64::from_le_bytes(
				value
					.as_slice()
					.try_into()
					.expect("test value should be i64"),
			))
		})
		.transpose()
}

async fn read_head(db: &universaldb::Database) -> Result<DBHead> {
	let branch_id = read_branch_id(db).await?;
	let bytes = read_value(db, branch_meta_head_key(branch_id))
		.await?
		.expect("head should exist");
	decode_db_head(&bytes)
}

async fn read_dirty_marker(
	db: &universaldb::Database,
	branch_id: DatabaseBranchId,
) -> Result<Option<SqliteCmpDirty>> {
	read_value(db, sqlite_cmp_dirty_key(branch_id))
		.await?
		.map(|value| decode_sqlite_cmp_dirty(&value))
		.transpose()
}

async fn read_branch_id(db: &universaldb::Database) -> Result<DatabaseBranchId> {
	let bucket_id = BucketId::from_gas_id(test_bucket());
	let bucket_pointer_bytes = read_value(db, bucket_pointer_cur_key(bucket_id))
		.await?
		.expect("bucket pointer should exist");
	let bucket_branch = decode_bucket_pointer(&bucket_pointer_bytes)?.current_branch;
	let bytes = read_value(db, database_pointer_cur_key(bucket_branch, TEST_DATABASE))
		.await?
		.expect("database pointer should exist");

	Ok(decode_database_pointer(&bytes)?.current_branch)
}

async fn read_quota(db: &universaldb::Database) -> Result<i64> {
	db.txn("test_depotconveyer_commit", |tx| async move {
		quota::read_in_bucket(&tx, BucketId::from_gas_id(test_bucket()), TEST_DATABASE).await
	})
	.await
}

async fn assert_commit_rejected(
	database_db: &Db,
	dirty_pages: Vec<DirtyPage>,
	expected: &str,
) -> Result<()> {
	let err = database_db
		.commit(dirty_pages, 2, 1_000)
		.await
		.expect_err("commit should reject invalid dirty pages");
	assert!(
		err.to_string().contains(expected),
		"expected error to contain {expected:?}, got {err:?}"
	);

	Ok(())
}

fn error_chain_contains(err: &anyhow::Error, expected: &str) -> bool {
	err.chain()
		.any(|cause| cause.to_string().contains(expected))
}

#[cfg(feature = "test-faults")]
fn faulting_db(db: Arc<universaldb::Database>, controller: DepotFaultController) -> Db {
	Db::new_with_fault_controller_for_test(
		db,
		test_bucket(),
		TEST_DATABASE.to_string(),
		NodeId::new(),
		controller,
	)
}

#[tokio::test]
async fn commit_lazily_initializes_meta_on_first_write() -> Result<()> {
	commit_matrix!("depot-commit-init", |ctx, db, database_db| {
		database_db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
		let branch_id = read_branch_id(&db).await?;

		assert_eq!(read_head(&db).await?, head_with_branch(branch_id, 1, 2));
		let bucket_id = BucketId::from_gas_id(test_bucket());
		let bucket_pointer_bytes = read_value(&db, bucket_pointer_cur_key(bucket_id))
			.await?
			.expect("bucket pointer should exist");
		let bucket_branch = decode_bucket_pointer(&bucket_pointer_bytes)?.current_branch;
		let bucket_record_bytes = read_value(&db, bucket_branches_list_key(bucket_branch))
			.await?
			.expect("bucket branch record should exist");
		let bucket_record = decode_bucket_branch_record(&bucket_record_bytes)?;
		assert_eq!(bucket_record.branch_id, bucket_branch);
		assert_eq!(bucket_record.parent, None);
		assert_eq!(
			read_value(&db, bucket_branches_refcount_key(bucket_branch)).await?,
			Some(1_i64.to_le_bytes().to_vec())
		);
		let branch_record_bytes = read_value(&db, branches_list_key(branch_id))
			.await?
			.expect("branch record should exist");
		let branch_record = decode_database_branch_record(&branch_record_bytes)?;
		assert_eq!(branch_record.branch_id, branch_id);
		assert_eq!(branch_record.bucket_branch, bucket_branch);
		assert_eq!(branch_record.parent, None);
		assert_eq!(
			read_value(&db, branch_pidx_key(branch_id, 1)).await?,
			Some(1_u64.to_be_bytes().to_vec())
		);
		assert_eq!(
			read_value(&db, branch_page_history_key(branch_id, 1, 1)).await?,
			Some(Vec::new())
		);
		assert_eq!(
			read_value(&db, branch_page_history_complete_txid_key(branch_id)).await?,
			Some(1_u64.to_be_bytes().to_vec())
		);
		assert!(
			read_value(&db, branch_delta_chunk_key(branch_id, 1, 0))
				.await?
				.is_some()
		);
		assert!(read_quota(&db).await? > 0);
		assert_eq!(
			database_db.get_pages(vec![1]).await?,
			vec![fetched_page(1, 0x11)]
		);

		Ok(())
	})
}

#[tokio::test]
async fn commit_head_fence_rejects_stale_writer() -> Result<()> {
	commit_matrix!("depot-commit-head-fence-stale", |ctx, db, database_db| {
		let _ = &db;
		let first = database_db
			.commit_with_options(
				vec![page(1, 0x11)],
				1,
				1_000,
				CommitOptions {
					expected_head_txid: Some(0),
					..Default::default()
				},
			)
			.await?;
		assert_eq!(first.head_txid, 1);

		let err = database_db
			.commit_with_options(
				vec![page(1, 0x22)],
				1,
				1_001,
				CommitOptions {
					expected_head_txid: Some(0),
					..Default::default()
				},
			)
			.await
			.expect_err("stale writer should be rejected");
		assert!(
			err.chain()
				.any(|source| source.to_string().contains("head fence mismatch")),
			"unexpected error: {err:#}"
		);
		assert_eq!(
			database_db.get_pages(vec![1]).await?,
			vec![fetched_page(1, 0x11)]
		);

		Ok(())
	})
}

#[tokio::test]
async fn commit_writer_fence_requires_current_generation() -> Result<()> {
	common::test_matrix("depot-commit-writer-fence", |_tier, ctx| {
		Box::pin(async move {
			let udb = ctx.udb.clone();
			let fence_key = writer_fence_key();
			let database_db = ctx
				.make_db(test_bucket(), TEST_DATABASE)
				.with_writer_fence_key(fence_key.clone());
			set_writer_generation(&udb, fence_key.clone(), 7).await?;

			let missing = database_db
				.commit(vec![page(1, 0x11)], 1, 1_000)
				.await
				.expect_err("a fenced database must require an actor generation");
			assert!(
				error_chain_contains(&missing, "writer generation is required"),
				"unexpected missing-generation error: {missing:#}"
			);

			let stale = database_db
				.commit_with_options(
					vec![page(1, 0x22)],
					1,
					1_001,
					CommitOptions {
						expected_head_txid: Some(0),
						expected_writer_generation: Some(6),
						..Default::default()
					},
				)
				.await
				.expect_err("a stale actor generation must be fenced");
			assert!(
				error_chain_contains(&stale, "writer fence mismatch"),
				"unexpected stale-generation error: {stale:#}"
			);
			assert!(
				read_value(
					&udb,
					bucket_pointer_cur_key(BucketId::from_gas_id(test_bucket()))
				)
				.await?
				.is_none(),
				"rejected commits must not initialize database metadata"
			);

			seed(&udb, vec![(fence_key.clone(), vec![7])]).await?;
			let malformed = database_db
				.commit_with_options(
					vec![page(1, 0x23)],
					1,
					1_002,
					CommitOptions {
						expected_head_txid: Some(0),
						expected_writer_generation: Some(7),
						..Default::default()
					},
				)
				.await
				.expect_err("a malformed persisted generation must fail closed");
			assert!(
				error_chain_contains(&malformed, "writer fence mismatch"),
				"unexpected malformed-generation error: {malformed:#}"
			);
			set_writer_generation(&udb, fence_key, 7).await?;

			let committed = database_db
				.commit_with_options(
					vec![page(1, 0x33)],
					1,
					1_003,
					CommitOptions {
						expected_head_txid: Some(0),
						expected_writer_generation: Some(7),
						..Default::default()
					},
				)
				.await?;
			assert_eq!(committed.head_txid, 1);
			assert_eq!(
				database_db.get_pages(vec![1]).await?,
				vec![fetched_page(1, 0x33)]
			);

			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn stale_generation_cannot_replay_a_durable_commit_attempt() -> Result<()> {
	common::test_matrix("depot-commit-writer-fence-replay", |_tier, ctx| {
		Box::pin(async move {
			let udb = ctx.udb.clone();
			let fence_key = writer_fence_key();
			let database_db = ctx
				.make_db(test_bucket(), TEST_DATABASE)
				.with_writer_fence_key(fence_key.clone());
			set_writer_generation(&udb, fence_key.clone(), 1).await?;

			let options = CommitOptions {
				expected_head_txid: Some(0),
				expected_writer_generation: Some(1),
				commit_attempt_id: Some([0x71; 16]),
			};
			let first = database_db
				.commit_with_options(vec![page(1, 0x44)], 1, 1_000, options)
				.await?;
			set_writer_generation(&udb, fence_key, 2).await?;

			let stale_replay = database_db
				.commit_with_options(vec![page(1, 0x44)], 1, 1_000, options)
				.await
				.expect_err("a durable attempt proof must not bypass a newer owner generation");
			assert!(
				error_chain_contains(&stale_replay, "writer fence mismatch"),
				"unexpected stale replay error: {stale_replay:#}"
			);
			assert_eq!(read_head(&udb).await?.head_txid, first.head_txid);

			Ok(())
		})
	})
	.await
}

#[cfg(feature = "test-faults")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn generation_change_fences_an_inflight_commit_after_its_head_check() -> Result<()> {
	let ctx =
		common::build_test_db("depot-commit-writer-fence-race", common::TierMode::Disabled).await?;
	let udb = ctx.udb.clone();
	let fence_key = writer_fence_key();
	set_writer_generation(&udb, fence_key.clone(), 1).await?;

	let controller = DepotFaultController::new();
	let database_db =
		faulting_db(udb.clone(), controller.clone()).with_writer_fence_key(fence_key.clone());
	let first = database_db
		.commit_with_options(
			vec![page(1, 0x51)],
			1,
			1_000,
			CommitOptions {
				expected_head_txid: Some(0),
				expected_writer_generation: Some(1),
				..Default::default()
			},
		)
		.await?;

	let pause = controller.pause_handle("writer-fence-after-head-read");
	controller
		.at(DepotFaultPoint::Commit(CommitFaultPoint::AfterHeadRead))
		.database_id(TEST_DATABASE)
		.once()
		.pause("writer-fence-after-head-read")?;
	let stale_commit = database_db.commit_with_options(
		vec![page(1, 0x52)],
		1,
		1_001,
		CommitOptions {
			expected_head_txid: Some(first.head_txid),
			expected_writer_generation: Some(1),
			commit_attempt_id: Some([0x72; 16]),
		},
	);
	let takeover = async {
		pause.wait_reached().await;
		let result = set_writer_generation(&udb, fence_key, 2).await;
		pause.release();
		result
	};
	let (stale_result, takeover_result) =
		tokio::time::timeout(std::time::Duration::from_secs(10), async {
			tokio::join!(stale_commit, takeover)
		})
		.await
		.expect("writer-fence race should complete");
	takeover_result?;
	let stale_error = stale_result.expect_err("the old generation must lose after takeover");
	assert!(
		error_chain_contains(&stale_error, "writer fence mismatch"),
		"unexpected in-flight stale commit error: {stale_error:#}"
	);
	controller.assert_expected_fired()?;

	let branch_id = read_branch_id(&udb).await?;
	assert_eq!(read_head(&udb).await?.head_txid, first.head_txid);
	assert!(
		read_value(&udb, branch_commit_key(branch_id, first.head_txid + 1))
			.await?
			.is_none(),
		"the fenced transaction must not publish a commit row"
	);
	assert_eq!(
		database_db.get_pages(vec![1]).await?,
		vec![fetched_page(1, 0x51)]
	);

	Ok(())
}

#[tokio::test]
async fn duplicate_commit_attempt_returns_the_original_durable_result() -> Result<()> {
	commit_matrix!("depot-commit-idempotent-attempt", |ctx, db, database_db| {
		let _ = &ctx;
		let attempt_id = [0xa5; 16];
		let options = CommitOptions {
			expected_head_txid: Some(0),
			commit_attempt_id: Some(attempt_id),
			..Default::default()
		};
		let dirty_pages = vec![page(2, 0x22), page(1, 0x11)];
		let first = database_db
			.commit_with_options(dirty_pages.clone(), 2, 1_000, options)
			.await?;
		let branch_id = read_branch_id(&db).await?;
		let quota_after_first = read_quota(&db).await?;

		// Reverse page order to prove that request identity is independent of Vec ordering.
		let replay = database_db
			.commit_with_options(dirty_pages.into_iter().rev().collect(), 2, 1_000, options)
			.await?;

		assert_eq!(first.head_txid, 1);
		assert_eq!(replay, first);
		assert_eq!(read_head(&db).await?, head_with_branch(branch_id, 1, 2));
		assert!(
			read_value(&db, branch_commit_key(branch_id, 1))
				.await?
				.is_some()
		);
		assert!(
			read_value(&db, branch_commit_key(branch_id, 2))
				.await?
				.is_none()
		);
		assert_eq!(read_quota(&db).await?, quota_after_first);

		let proof = decode_commit_attempt_proof(
			&read_value(&db, branch_meta_commit_attempt_key(branch_id))
				.await?
				.expect("commit attempt proof should exist"),
		)?;
		assert_eq!(proof.attempt_id, attempt_id);
		assert_eq!(proof.txid, 1);

		Ok(())
	})
}

#[tokio::test]
async fn duplicate_commit_attempt_rejects_changed_payload() -> Result<()> {
	commit_matrix!(
		"depot-commit-idempotent-mismatch",
		|ctx, db, database_db| {
			let _ = &ctx;
			let options = CommitOptions {
				expected_head_txid: Some(0),
				commit_attempt_id: Some([0x5a; 16]),
				..Default::default()
			};
			database_db
				.commit_with_options(vec![page(1, 0x11)], 1, 1_000, options)
				.await?;
			let branch_id = read_branch_id(&db).await?;

			let err = database_db
				.commit_with_options(vec![page(1, 0x22)], 1, 1_000, options)
				.await
				.expect_err("one attempt id must not authorize a different payload");
			assert!(
				error_chain_contains(
					&err,
					"commit attempt id was reused with a different request"
				),
				"unexpected error: {err:#}"
			);
			assert_eq!(read_head(&db).await?, head_with_branch(branch_id, 1, 1));
			assert!(
				read_value(&db, branch_commit_key(branch_id, 2))
					.await?
					.is_none()
			);

			Ok(())
		}
	)
}

#[tokio::test]
async fn get_pages_head_fence_rejects_stale_reader() -> Result<()> {
	commit_matrix!(
		"depot-get-pages-head-fence-stale",
		|ctx, db, database_db| {
			let _ = &db;
			let first = database_db
				.commit_with_options(
					vec![page(1, 0x11)],
					1,
					1_000,
					CommitOptions {
						expected_head_txid: Some(0),
						..Default::default()
					},
				)
				.await?;
			assert_eq!(first.head_txid, 1);

			let read = database_db
				.get_pages_with_options(
					vec![1],
					GetPagesOptions {
						expected_head_txid: Some(1),
						..Default::default()
					},
				)
				.await?;
			assert_eq!(read.head_txid, 1);
			assert_eq!(read.pages, vec![fetched_page(1, 0x11)]);

			let second = database_db
				.commit_with_options(
					vec![page(1, 0x22)],
					1,
					1_001,
					CommitOptions {
						expected_head_txid: Some(1),
						..Default::default()
					},
				)
				.await?;
			assert_eq!(second.head_txid, 2);

			let err = database_db
				.get_pages_with_options(
					vec![1],
					GetPagesOptions {
						expected_head_txid: Some(1),
						..Default::default()
					},
				)
				.await
				.expect_err("stale reader should be rejected");
			assert!(
				err.chain()
					.any(|source| source.to_string().contains("head fence mismatch")),
				"unexpected error: {err:#}"
			);

			Ok(())
		}
	)
}

#[tokio::test]
async fn commit_rejects_invalid_dirty_pages_before_storage_writes() -> Result<()> {
	commit_matrix!("depot-commit-invalid-dirty", |ctx, db, database_db| {
		assert_commit_rejected(
			&database_db,
			vec![page(0, 0x11)],
			"sqlite commit does not accept page 0",
		)
		.await?;
		assert_commit_rejected(
			&database_db,
			vec![short_page(1)],
			"sqlite commit page 1 had 128 bytes",
		)
		.await?;
		assert_commit_rejected(
			&database_db,
			vec![page(1, 0x11), page(1, 0x22)],
			"sqlite commit duplicated page 1",
		)
		.await?;
		assert_commit_rejected(
			&database_db,
			vec![page(3, 0x33)],
			"sqlite commit page 3 exceeds declared database size 2",
		)
		.await?;
		let oversized_pages = (1..=u32::try_from(MAX_COMMIT_DIRTY_PAGES + 1).unwrap())
			.map(|pgno| page(pgno, 0x33))
			.collect::<Vec<_>>();
		let err = database_db
			.commit(
				oversized_pages,
				u32::try_from(MAX_COMMIT_DIRTY_PAGES + 1).unwrap(),
				1_000,
			)
			.await
			.expect_err("oversized commit should be rejected before storage writes");
		assert_eq!(
			err.downcast_ref::<SqliteStorageError>(),
			Some(&SqliteStorageError::CommitTooLarge {
				actual_size_bytes: u64::try_from(MAX_COMMIT_DIRTY_PAGES + 1).unwrap()
					* u64::from(PAGE_SIZE),
				max_size_bytes: MAX_COMMIT_RAW_DIRTY_BYTES as u64,
			})
		);
		assert_eq!(
			read_value(
				&db,
				bucket_pointer_cur_key(BucketId::from_gas_id(test_bucket()))
			)
			.await?,
			None
		);

		Ok(())
	})
}

#[tokio::test]
async fn maximum_legal_commit_is_durable_and_idempotent_after_reopen() -> Result<()> {
	commit_matrix!("depot-commit-max-boundary", |ctx, db, database_db| {
		let max_pgno = u32::try_from(MAX_COMMIT_DIRTY_PAGES)?;
		let middle_pgno = max_pgno / 2;
		let dirty_pages = (1..=max_pgno)
			.map(|pgno| DirtyPage {
				pgno,
				bytes: incompressible_page(u64::from(pgno)),
			})
			.collect::<Vec<_>>();
		let options = CommitOptions {
			expected_head_txid: Some(0),
			commit_attempt_id: Some([0x32; 16]),
			..Default::default()
		};

		let committed = database_db
			.commit_with_options(dirty_pages.clone(), max_pgno, 1_000, options)
			.await?;
		assert_eq!(committed.head_txid, 1);
		let branch_id = read_branch_id(&db).await?;
		let quota_after_commit = read_quota(&db).await?;
		assert_eq!(
			read_head(&db).await?,
			head_with_branch(branch_id, 1, max_pgno)
		);
		assert!(
			read_value(&db, branch_delta_chunk_key(branch_id, 1, 0))
				.await?
				.is_some(),
			"maximum legal commit should persist its first DELTA chunk"
		);
		for pgno in [1, middle_pgno, max_pgno] {
			assert_eq!(
				read_value(&db, branch_pidx_key(branch_id, pgno)).await?,
				Some(1_u64.to_be_bytes().to_vec()),
				"maximum legal commit should index page {pgno}"
			);
		}

		// A fresh Db handle has no writer's process-local page-index cache. This proves the durable
		// UDB rows alone reconstruct boundary pages.
		let reopened = ctx.make_db(test_bucket(), TEST_DATABASE);
		let sample_pgnos = vec![1, middle_pgno, max_pgno];
		let reopened_pages = reopened.get_pages(sample_pgnos.clone()).await?;
		for (fetched, pgno) in reopened_pages.iter().zip(sample_pgnos.iter().copied()) {
			assert_eq!(fetched.pgno, pgno);
			assert_eq!(fetched.bytes, Some(incompressible_page(u64::from(pgno))));
		}

		// Reversing all 320 pages exercises normalized request hashing at the supported boundary.
		let replayed = reopened
			.commit_with_options(
				dirty_pages.into_iter().rev().collect(),
				max_pgno,
				1_000,
				options,
			)
			.await?;
		assert_eq!(replayed, committed);
		assert_eq!(read_quota(&db).await?, quota_after_commit);
		assert!(
			read_value(&db, branch_commit_key(branch_id, 2))
				.await?
				.is_none(),
			"idempotent boundary replay must not allocate a second txid"
		);
		assert!(
			read_value(&db, branch_delta_chunk_key(branch_id, 2, 0))
				.await?
				.is_none(),
			"idempotent boundary replay must not write a second DELTA"
		);

		Ok(())
	})
}

#[tokio::test]
async fn over_limit_rejection_preserves_every_authoritative_commit_surface() -> Result<()> {
	commit_matrix!("depot-commit-over-limit-atomic", |ctx, db, database_db| {
		let first_options = CommitOptions {
			expected_head_txid: Some(0),
			commit_attempt_id: Some([0x41; 16]),
			..Default::default()
		};
		database_db
			.commit_with_options(vec![page(1, 0x11), page(2, 0x22)], 2, 1_000, first_options)
			.await?;
		let branch_id = read_branch_id(&db).await?;
		let head_before = read_value(&db, branch_meta_head_key(branch_id)).await?;
		let quota_before = read_quota(&db).await?;
		let attempt_before = read_value(&db, branch_meta_commit_attempt_key(branch_id)).await?;
		let commit_before = read_value(&db, branch_commit_key(branch_id, 1)).await?;
		let commit_row_before = decode_commit_row(
			commit_before
				.as_deref()
				.expect("seed commit row should exist before rejection"),
		)?;
		let vtx_before = read_value(
			&db,
			branch_vtx_key(branch_id, commit_row_before.versionstamp),
		)
		.await?;
		let delta_before = read_value(&db, branch_delta_chunk_key(branch_id, 1, 0)).await?;
		let first_pidx_before = read_value(&db, branch_pidx_key(branch_id, 1)).await?;
		let second_pidx_before = read_value(&db, branch_pidx_key(branch_id, 2)).await?;
		let page_history_before =
			read_value(&db, branch_page_history_complete_txid_key(branch_id)).await?;
		let dirty_before = read_dirty_marker(&db, branch_id).await?;

		let rejected_page_count = u32::try_from(MAX_COMMIT_DIRTY_PAGES + 1)?;
		let oversized_pages = (1..=rejected_page_count)
			.map(|pgno| DirtyPage {
				pgno,
				bytes: incompressible_page(10_000 + u64::from(pgno)),
			})
			.collect::<Vec<_>>();
		let error = database_db
			.commit_with_options(
				oversized_pages,
				rejected_page_count,
				2_000,
				CommitOptions {
					expected_head_txid: Some(1),
					commit_attempt_id: Some([0x42; 16]),
					..Default::default()
				},
			)
			.await
			.expect_err("one page above the supported boundary must be rejected");
		assert_eq!(
			error.downcast_ref::<SqliteStorageError>(),
			Some(&SqliteStorageError::CommitTooLarge {
				actual_size_bytes: u64::from(rejected_page_count) * u64::from(PAGE_SIZE),
				max_size_bytes: MAX_COMMIT_RAW_DIRTY_BYTES as u64,
			})
		);

		assert_eq!(
			read_value(&db, branch_meta_head_key(branch_id)).await?,
			head_before
		);
		assert_eq!(read_quota(&db).await?, quota_before);
		assert_eq!(
			read_value(&db, branch_meta_commit_attempt_key(branch_id)).await?,
			attempt_before
		);
		assert_eq!(
			read_value(&db, branch_commit_key(branch_id, 1)).await?,
			commit_before
		);
		assert_eq!(
			read_value(
				&db,
				branch_vtx_key(branch_id, commit_row_before.versionstamp),
			)
			.await?,
			vtx_before
		);
		assert_eq!(
			read_value(&db, branch_delta_chunk_key(branch_id, 1, 0)).await?,
			delta_before
		);
		assert_eq!(
			read_value(&db, branch_pidx_key(branch_id, 1)).await?,
			first_pidx_before
		);
		assert_eq!(
			read_value(&db, branch_pidx_key(branch_id, 2)).await?,
			second_pidx_before
		);
		assert_eq!(
			read_value(&db, branch_page_history_complete_txid_key(branch_id)).await?,
			page_history_before
		);
		assert_eq!(read_dirty_marker(&db, branch_id).await?, dirty_before);
		assert!(
			read_value(&db, branch_commit_key(branch_id, 2))
				.await?
				.is_none()
		);
		assert!(
			read_value(&db, branch_delta_chunk_key(branch_id, 2, 0))
				.await?
				.is_none()
		);
		assert!(
			read_value(&db, branch_pidx_key(branch_id, rejected_page_count))
				.await?
				.is_none()
		);
		assert!(
			read_value(
				&db,
				branch_page_history_key(branch_id, rejected_page_count, 2),
			)
			.await?
			.is_none()
		);

		let reopened = ctx.make_db(test_bucket(), TEST_DATABASE);
		assert_eq!(
			reopened.get_pages(vec![1, 2]).await?,
			vec![fetched_page(1, 0x11), fetched_page(2, 0x22)]
		);

		Ok(())
	})
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn commit_pre_durable_fault_leaves_old_state() -> Result<()> {
	commit_matrix!("depot-commit-fault-pre-durable", |ctx, db, database_db| {
		database_db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
		let branch_id = read_branch_id(&db).await?;

		let controller = DepotFaultController::new();
		controller
			.at(DepotFaultPoint::Commit(CommitFaultPoint::BeforeHeadWrite))
			.database_id(TEST_DATABASE)
			.once()
			.fail("stop before head write")?;
		let faulting_db = faulting_db(db.clone(), controller.clone());
		let err = faulting_db
			.commit(vec![page(2, 0x22)], 3, 2_000)
			.await
			.expect_err("pre-durable fault should fail the commit");

		assert!(
			error_chain_contains(&err, "stop before head write"),
			"expected injected fault error, got {err:?}"
		);
		controller.assert_expected_fired()?;
		assert_eq!(
			controller.replay_log()[0].boundary,
			FaultBoundary::PreDurableCommit
		);
		assert_eq!(read_head(&db).await?, head_with_branch(branch_id, 1, 2));
		assert!(
			read_value(&db, branch_delta_chunk_key(branch_id, 2, 0))
				.await?
				.is_none()
		);
		assert!(
			read_value(&db, branch_pidx_key(branch_id, 2))
				.await?
				.is_none()
		);

		Ok(())
	})
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn commit_after_udb_fault_reports_ambiguous_committed_state() -> Result<()> {
	commit_matrix!("depot-commit-fault-after-udb", |ctx, db, database_db| {
		database_db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
		let branch_id = read_branch_id(&db).await?;
		let options = CommitOptions {
			expected_head_txid: Some(1),
			commit_attempt_id: Some([0xc3; 16]),
			..Default::default()
		};

		let controller = DepotFaultController::new();
		controller
			.at(DepotFaultPoint::Commit(CommitFaultPoint::AfterUdbCommit))
			.database_id(TEST_DATABASE)
			.once()
			.fail("stop after durable commit")?;
		let faulting_db = faulting_db(db.clone(), controller.clone());
		let err = faulting_db
			.commit_with_options(vec![page(2, 0x22)], 3, 2_000, options)
			.await
			.expect_err("post-durable fault should return an ambiguous error");

		assert!(
			error_chain_contains(&err, "stop after durable commit"),
			"expected injected fault error, got {err:?}"
		);
		controller.assert_expected_fired()?;
		assert_eq!(
			controller.replay_log()[0].boundary,
			FaultBoundary::AmbiguousAfterDurableCommit
		);
		assert_eq!(read_head(&db).await?, head_with_branch(branch_id, 2, 3));
		let replay = faulting_db
			.commit_with_options(vec![page(2, 0x22)], 3, 2_000, options)
			.await
			.expect("replaying the same logical attempt should recover the durable result");
		assert_eq!(replay.head_txid, 2);
		assert!(
			read_value(&db, branch_commit_key(branch_id, 3))
				.await?
				.is_none()
		);
		let reader = ctx.make_db(test_bucket(), TEST_DATABASE);
		assert_eq!(
			reader.get_pages(vec![1, 2]).await?,
			vec![fetched_page(1, 0x11), fetched_page(2, 0x22)]
		);

		Ok(())
	})
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn maximum_legal_commit_replays_after_ambiguous_durable_commit() -> Result<()> {
	commit_matrix!(
		"depot-commit-max-fault-after-udb",
		|ctx, db, database_db| {
			database_db.commit(vec![page(1, 0x11)], 1, 1_000).await?;
			let branch_id = read_branch_id(&db).await?;
			let max_pgno = u32::try_from(MAX_COMMIT_DIRTY_PAGES)?;
			let dirty_pages = (1..=max_pgno)
				.map(|pgno| DirtyPage {
					pgno,
					bytes: incompressible_page(20_000 + u64::from(pgno)),
				})
				.collect::<Vec<_>>();
			let options = CommitOptions {
				expected_head_txid: Some(1),
				commit_attempt_id: Some([0xd4; 16]),
				..Default::default()
			};

			let controller = DepotFaultController::new();
			controller
				.at(DepotFaultPoint::Commit(CommitFaultPoint::AfterUdbCommit))
				.database_id(TEST_DATABASE)
				.once()
				.fail("stop after maximum legal commit became durable")?;
			let faulting_db = faulting_db(db.clone(), controller.clone());
			let error = faulting_db
				.commit_with_options(dirty_pages.clone(), max_pgno, 2_000, options)
				.await
				.expect_err("post-durable response loss must be reported as ambiguous");
			assert!(
				error_chain_contains(&error, "stop after maximum legal commit became durable"),
				"expected injected fault error, got {error:?}"
			);
			controller.assert_expected_fired()?;
			assert_eq!(
				controller.replay_log()[0].boundary,
				FaultBoundary::AmbiguousAfterDurableCommit
			);
			assert_eq!(
				read_head(&db).await?,
				head_with_branch(branch_id, 2, max_pgno)
			);
			let quota_after_ambiguous_commit = read_quota(&db).await?;

			// Reopen without the fault controller and reverse page order. The stable attempt identity
			// must recover txid 2, not allocate txid 3 or charge quota twice.
			let reopened = ctx.make_db(test_bucket(), TEST_DATABASE);
			let replay = reopened
				.commit_with_options(
					dirty_pages.into_iter().rev().collect(),
					max_pgno,
					2_000,
					options,
				)
				.await?;
			assert_eq!(replay.head_txid, 2);
			assert_eq!(read_quota(&db).await?, quota_after_ambiguous_commit);
			assert!(
				read_value(&db, branch_commit_key(branch_id, 3))
					.await?
					.is_none()
			);
			assert!(
				read_value(&db, branch_delta_chunk_key(branch_id, 3, 0))
					.await?
					.is_none()
			);

			let sample_pgnos = vec![1, max_pgno / 2, max_pgno];
			let pages = reopened.get_pages(sample_pgnos.clone()).await?;
			for (fetched, pgno) in pages.iter().zip(sample_pgnos) {
				assert_eq!(fetched.pgno, pgno);
				assert_eq!(
					fetched.bytes,
					Some(incompressible_page(20_000 + u64::from(pgno)))
				);
			}

			Ok(())
		}
	)
}

#[cfg(feature = "pidx-cache")]
#[tokio::test]
async fn commit_advances_head_and_updates_warm_cache() -> Result<()> {
	commit_matrix!("depot-commit-advance", |ctx, db, database_db| {
		database_db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
		let branch_id = read_branch_id(&db).await?;
		assert_eq!(
			database_db.get_pages(vec![1]).await?,
			vec![fetched_page(1, 0x11)]
		);

		database_db.commit(vec![page(2, 0x22)], 3, 2_000).await?;

		assert_eq!(read_head(&db).await?, head_with_branch(branch_id, 2, 3));
		assert_eq!(
			read_value(&db, branch_pidx_key(branch_id, 1)).await?,
			Some(1_u64.to_be_bytes().to_vec())
		);
		assert_eq!(
			read_value(&db, branch_pidx_key(branch_id, 2)).await?,
			Some(2_u64.to_be_bytes().to_vec())
		);

		db.txn("test_depotconveyer_commit", |tx| async move {
			tx.informal().clear(&branch_pidx_key(branch_id, 2));
			Ok(())
		})
		.await?;
		assert_eq!(
			database_db.get_pages(vec![1, 2]).await?,
			vec![fetched_page(1, 0x11), fetched_page(2, 0x22)]
		);

		Ok(())
	})
}

#[tokio::test]
async fn commit_writes_commit_row_and_vtx_index() -> Result<()> {
	commit_matrix!("depot-commit-row-vtx", |ctx, db, database_db| {
		database_db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
		database_db.commit(vec![page(2, 0x22)], 3, 2_000).await?;
		let branch_id = read_branch_id(&db).await?;

		let first_row_bytes = read_value(&db, branch_commit_key(branch_id, 1))
			.await?
			.expect("first commit row should exist");
		let first_row = decode_commit_row(&first_row_bytes)?;
		assert_eq!(first_row.wall_clock_ms, 1_000);
		assert_eq!(first_row.db_size_pages, 2);
		assert_eq!(first_row.post_apply_checksum, 0);
		assert_ne!(&first_row.versionstamp[..10], &[0xff; 10]);
		assert_eq!(
			read_value(&db, branch_vtx_key(branch_id, first_row.versionstamp)).await?,
			Some(1_u64.to_be_bytes().to_vec())
		);

		let second_row_bytes = read_value(&db, branch_commit_key(branch_id, 2))
			.await?
			.expect("second commit row should exist");
		let second_row = decode_commit_row(&second_row_bytes)?;
		assert_eq!(second_row.wall_clock_ms, 2_000);
		assert_eq!(second_row.db_size_pages, 3);
		assert_ne!(second_row.versionstamp, first_row.versionstamp);
		assert_eq!(
			read_value(&db, branch_vtx_key(branch_id, second_row.versionstamp)).await?,
			Some(2_u64.to_be_bytes().to_vec())
		);

		Ok(())
	})
}

#[tokio::test]
async fn commit_throttles_access_touch_by_bucket() -> Result<()> {
	commit_matrix!("depot-commit-access-touch", |ctx, db, database_db| {
		database_db.commit(vec![page(1, 0x01)], 1, 1).await?;
		let branch_id = read_branch_id(&db).await?;
		assert_eq!(
			read_i64_le(&db, branch_manifest_last_access_ts_ms_key(branch_id)).await?,
			Some(1)
		);
		assert_eq!(
			read_i64_le(&db, branch_manifest_last_access_bucket_key(branch_id)).await?,
			Some(0)
		);
		assert!(
			read_value(&db, ctr_eviction_index_key(0, branch_id))
				.await?
				.is_none()
		);

		for now_ms in 2..=120 {
			database_db
				.commit(vec![page(1, now_ms as u8)], 1, now_ms)
				.await?;
		}
		assert_eq!(
			read_i64_le(&db, branch_manifest_last_access_ts_ms_key(branch_id)).await?,
			Some(1)
		);
		assert_eq!(
			read_i64_le(&db, branch_manifest_last_access_bucket_key(branch_id)).await?,
			Some(0)
		);
		assert!(
			read_value(&db, ctr_eviction_index_key(0, branch_id))
				.await?
				.is_none()
		);

		database_db
			.commit(vec![page(1, 0xfe)], 1, ACCESS_TOUCH_THROTTLE_MS)
			.await?;
		assert_eq!(
			read_i64_le(&db, branch_manifest_last_access_ts_ms_key(branch_id)).await?,
			Some(ACCESS_TOUCH_THROTTLE_MS)
		);
		assert_eq!(
			read_i64_le(&db, branch_manifest_last_access_bucket_key(branch_id)).await?,
			Some(1)
		);
		assert!(
			read_value(&db, ctr_eviction_index_key(0, branch_id))
				.await?
				.is_none()
		);
		assert!(
			read_value(&db, ctr_eviction_index_key(1, branch_id))
				.await?
				.is_none()
		);

		Ok(())
	})
}

#[tokio::test]
async fn get_pages_does_not_touch_access_bucket_on_delta_read() -> Result<()> {
	commit_matrix!("depot-commit-delta-read-touch", |ctx, db, writer| {
		writer.commit(vec![page(1, 0x11)], 1, 1).await?;
		let branch_id = read_branch_id(&db).await?;

		let reader = ctx.make_db(test_bucket(), TEST_DATABASE);
		assert_eq!(
			reader.get_pages(vec![1]).await?,
			vec![fetched_page(1, 0x11)]
		);

		let last_access_ts_ms =
			read_i64_le(&db, branch_manifest_last_access_ts_ms_key(branch_id)).await?;
		let last_access_bucket =
			read_i64_le(&db, branch_manifest_last_access_bucket_key(branch_id)).await?;
		assert_eq!(last_access_ts_ms, Some(1));
		assert_eq!(last_access_bucket, Some(0));
		assert!(
			read_value(&db, ctr_eviction_index_key(0, branch_id))
				.await?
				.is_none()
		);

		Ok(())
	})
}

#[tokio::test]
async fn delta_read_fails_closed_above_the_per_commit_chunk_bound() -> Result<()> {
	commit_matrix!("depot-read-delta-chunk-bound", |ctx, db, database_db| {
		database_db.commit(vec![page(1, 0x11)], 1, 1_000).await?;
		let branch_id = read_branch_id(&db).await?;
		db.txn(
			"test_seed_oversized_delta_chunk_set",
			move |tx| async move {
				for chunk_idx in 0..=u32::try_from(depot::MAX_DELTA_CHUNKS_PER_COMMIT)? {
					tx.informal().set(
						&branch_delta_chunk_key(branch_id, 1, chunk_idx),
						b"malformed-oversized-delta",
					);
				}
				Ok(())
			},
		)
		.await?;

		let reader = ctx.make_db(test_bucket(), TEST_DATABASE);
		let error = reader
			.get_pages(vec![1])
			.await
			.expect_err("oversized DELTA chunk set must fail closed");
		assert!(
			error
				.chain()
				.any(|cause| cause.to_string().contains("bounded per-commit chunk limit")),
			"unexpected error: {error:?}"
		);

		Ok(())
	})
}

#[tokio::test]
async fn commit_backpressures_fdb_write_debt_before_writes() -> Result<()> {
	commit_matrix!("depot-commit-quota-cap", |ctx, db, database_db| {
		database_db.commit(vec![page(1, 0x11)], 1, 1_000).await?;
		let branch_id = read_branch_id(&db).await?;
		db.txn("test_depotconveyer_commit", |tx| async move {
			quota::atomic_add_branch(&tx, branch_id, FDB_WRITE_DEBT_LIMIT_BYTES);
			Ok(())
		})
		.await?;

		let database_db = ctx.make_db(test_bucket(), TEST_DATABASE);
		let err = database_db
			.commit(vec![page(1, 0x44)], 1, 3_000)
			.await
			.expect_err("commit should exceed the FDB write-debt safety budget");

		assert!(
			err.downcast_ref::<depot::error::SqliteStorageError>()
				.is_some_and(|err| matches!(
					err,
					depot::error::SqliteStorageError::SqliteWriteBackpressure { .. }
				))
		);
		assert_eq!(read_head(&db).await?, head_with_branch(branch_id, 1, 1));
		assert!(
			read_value(&db, branch_delta_chunk_key(branch_id, 2, 0))
				.await?
				.is_none()
		);

		Ok(())
	})
}

#[tokio::test]
async fn truncate_prunes_boundary_shard_pages_above_eof() -> Result<()> {
	commit_matrix!("depot-commit-truncate-boundary", |ctx, db, database_db| {
		database_db.commit(vec![page(1, 0x01)], 130, 1_000).await?;
		let branch_id = read_branch_id(&db).await?;
		seed(
			&db,
			vec![
				(
					branch_meta_head_key(branch_id),
					encode_db_head(head_with_branch(branch_id, 7, 130))?,
				),
				(
					branch_shard_key(branch_id, 1, 7),
					encoded_blob(7, &[(64, 0x64), (65, 0x65)])?,
				),
			],
		)
		.await?;
		db.txn("test_depotconveyer_commit", |tx| async move {
			quota::atomic_add_branch(&tx, branch_id, 50_000);
			Ok(())
		})
		.await?;

		let database_db = ctx.make_db(test_bucket(), TEST_DATABASE);
		database_db.commit(vec![page(1, 0x11)], 64, 4_000).await?;
		assert_eq!(
			database_db.get_pages(vec![64]).await?,
			vec![fetched_page(64, 0x64)]
		);

		database_db.commit(Vec::new(), 65, 5_000).await?;

		assert_eq!(
			database_db.get_pages(vec![65]).await?,
			vec![zero_filled_page(65)]
		);

		Ok(())
	})
}

#[tokio::test]
async fn truncate_boundary_rewrite_ignores_older_cache_generation_cardinality() -> Result<()> {
	commit_matrix!(
		"depot-commit-truncate-boundary-cardinality",
		|ctx, db, database_db| {
			database_db.commit(vec![page(1, 0x01)], 130, 1_000).await?;
			let branch_id = read_branch_id(&db).await?;
			db.txn(
				"test_seed_many_boundary_cache_generations",
				move |tx| async move {
					tx.informal().set(
						&branch_meta_head_key(branch_id),
						&encode_db_head(head_with_branch(branch_id, 10_000, 130))?,
					);
					for txid in 1..=2_048_u64 {
						tx.informal().set(
							&branch_shard_key(branch_id, 1, txid),
							b"malformed-old-derived-cache",
						);
					}
					tx.informal().set(
						&branch_shard_key(branch_id, 1, 10_000),
						&encoded_blob(10_000, &[(64, 0x64), (65, 0x65)])?,
					);
					quota::atomic_add_branch(&tx, branch_id, 100_000);
					Ok(())
				},
			)
			.await?;

			let database_db = ctx.make_db(test_bucket(), TEST_DATABASE);
			database_db.commit(vec![page(1, 0x11)], 64, 4_000).await?;
			let pages = database_db.get_pages(vec![64, 65]).await?;
			assert_eq!(pages.len(), 2);
			assert_eq!(pages[0].pgno, 64);
			assert!(pages[0].bytes.as_ref().is_some_and(|bytes| {
				bytes.len() == PAGE_SIZE as usize && bytes.iter().all(|byte| *byte == 0x64)
			}));
			assert_eq!(pages[1].pgno, 65);
			assert!(pages[1].bytes.is_none());
			assert_eq!(
				read_value(&db, branch_shard_key(branch_id, 1, 1)).await?,
				None
			);

			Ok(())
		}
	)
}

#[tokio::test]
async fn truncate_prunes_chunked_boundary_shard_and_accounts_for_chunks() -> Result<()> {
	commit_matrix!(
		"depot-commit-truncate-chunked-boundary",
		|ctx, db, database_db| {
			database_db.commit(vec![page(1, 0x01)], 130, 1_000).await?;
			let branch_id = read_branch_id(&db).await?;
			seed(
				&db,
				vec![(
					branch_meta_head_key(branch_id),
					encode_db_head(head_with_branch(branch_id, 7, 130))?,
				)],
			)
			.await?;
			seed_hot_shard_blob(&db, branch_id, 1, 7, encoded_shard_blob(7, 64, 127)?).await?;
			db.txn("test_depotconveyer_commit", |tx| async move {
				quota::atomic_add_branch(&tx, branch_id, 500_000);
				Ok(())
			})
			.await?;
			let original_manifest = decode_hot_shard_manifest(
				&read_value(&db, branch_shard_key(branch_id, 1, 7))
					.await?
					.expect("chunked boundary shard should have a canonical manifest"),
			)?;
			assert!(original_manifest.chunk_count > 1);
			let quota_before = read_quota(&db).await?;

			let database_db = ctx.make_db(test_bucket(), TEST_DATABASE);
			database_db.commit(vec![page(1, 0x11)], 100, 4_000).await?;

			assert_eq!(
				database_db.get_pages(vec![64, 100]).await?,
				vec![
					FetchedPage {
						pgno: 64,
						bytes: Some(incompressible_page(64)),
					},
					FetchedPage {
						pgno: 100,
						bytes: Some(incompressible_page(100)),
					},
				]
			);
			let pruned_manifest = decode_hot_shard_manifest(
				&read_value(&db, branch_shard_key(branch_id, 1, 7))
					.await?
					.expect("pruned boundary shard should remain chunked"),
			)?;
			assert!(pruned_manifest.chunk_count < original_manifest.chunk_count);
			for chunk_idx in 0..pruned_manifest.chunk_count {
				assert!(
					read_value(&db, branch_shard_chunk_key(branch_id, 1, 7, chunk_idx),)
						.await?
						.is_some()
				);
			}
			for chunk_idx in pruned_manifest.chunk_count..original_manifest.chunk_count {
				assert!(
					read_value(&db, branch_shard_chunk_key(branch_id, 1, 7, chunk_idx),)
						.await?
						.is_none(),
					"truncate must remove superseded physical chunk {chunk_idx}"
				);
			}
			assert!(
				read_quota(&db).await? > quota_before,
				"derived hot-shard chunks are not charged to authoritative hot quota"
			);

			database_db.commit(Vec::new(), 127, 5_000).await?;
			assert_eq!(
				database_db.get_pages(vec![101]).await?,
				vec![zero_filled_page(101)],
				"regrow must not resurrect a page pruned from the chunked shard"
			);

			Ok(())
		}
	)
}

#[tokio::test]
async fn truncate_debits_sparse_pidx_suffix_via_bounded_cardinality_tree() -> Result<()> {
	commit_matrix!(
		"depot-commit-truncate-pidx-count-tree",
		|ctx, db, database_db| {
			let pages = (1..=MAX_COMMIT_DIRTY_PAGES)
				.map(|pgno| page(u32::try_from(pgno).unwrap(), pgno as u8))
				.collect::<Vec<_>>();
			database_db
				.commit(pages, u32::try_from(MAX_COMMIT_DIRTY_PAGES).unwrap(), 1_000)
				.await?;
			let branch_id = read_branch_id(&db).await?;
			let quota_before = read_quota(&db).await?;

			database_db.commit(vec![page(1, 0x7f)], 1, 2_000).await?;

			assert!(read_quota(&db).await? < quota_before);
			assert!(
				read_value(&db, branch_pidx_key(branch_id, 2))
					.await?
					.is_none()
			);
			assert!(
				read_value(
					&db,
					branch_pidx_key(branch_id, u32::try_from(MAX_COMMIT_DIRTY_PAGES).unwrap()),
				)
				.await?
				.is_none()
			);
			let root_count = read_value(&db, branch_pidx_count_node_key(branch_id, 0, 4))
				.await?
				.expect("PIDX count root should remain");
			assert_eq!(
				i64::from_le_bytes(root_count.try_into().expect("root counter is i64")),
				1
			);

			Ok(())
		}
	)
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn missing_pidx_count_schema_marker_fails_closed() -> Result<()> {
	use depot::keys::branch_pidx_count_index_complete_key;

	commit_matrix!("depot-commit-pidx-count-marker", |ctx, db, database_db| {
		database_db.commit(vec![page(1, 0x01)], 1, 1_000).await?;
		let branch_id = read_branch_id(&db).await?;
		db.txn(
			"test_remove_pidx_count_schema_marker",
			move |tx| async move {
				tx.informal()
					.clear(&branch_pidx_count_index_complete_key(branch_id));
				Ok(())
			},
		)
		.await?;

		let error = database_db
			.commit(vec![page(1, 0x7f)], 1, 2_000)
			.await
			.expect_err("commit must fail closed without the count-index schema marker");
		assert!(
			error
				.chain()
				.any(|cause| cause.to_string().contains("index is not initialized")),
			"unexpected truncate error: {error:?}"
		);

		Ok(())
	})
}

#[tokio::test]
async fn truncate_clears_every_chunk_of_whole_shards_above_eof() -> Result<()> {
	commit_matrix!(
		"depot-commit-truncate-clears-whole-chunked-shard",
		|ctx, db, database_db| {
			database_db.commit(vec![page(1, 0x01)], 191, 1_000).await?;
			let branch_id = read_branch_id(&db).await?;
			seed(
				&db,
				vec![(
					branch_meta_head_key(branch_id),
					encode_db_head(head_with_branch(branch_id, 7, 191))?,
				)],
			)
			.await?;
			seed_hot_shard_blob(&db, branch_id, 2, 7, encoded_shard_blob(7, 128, 191)?).await?;
			let manifest = decode_hot_shard_manifest(
				&read_value(&db, branch_shard_key(branch_id, 2, 7))
					.await?
					.expect("whole shard should be chunked"),
			)?;

			let database_db = ctx.make_db(test_bucket(), TEST_DATABASE);
			database_db.commit(vec![page(1, 0x11)], 63, 4_000).await?;

			assert!(
				read_value(&db, branch_shard_key(branch_id, 2, 7))
					.await?
					.is_none()
			);
			for chunk_idx in 0..manifest.chunk_count {
				assert!(
					read_value(&db, branch_shard_chunk_key(branch_id, 2, 7, chunk_idx),)
						.await?
						.is_none(),
					"whole-shard truncate must clear physical chunk {chunk_idx}"
				);
			}

			Ok(())
		}
	)
}

#[tokio::test]
async fn truncate_does_not_clobber_concurrently_rewritten_boundary_shard() -> Result<()> {
	commit_matrix!("depot-commit-truncate-race", |ctx, db, database_db| {
		database_db.commit(vec![page(1, 0x01)], 130, 1_000).await?;
		let branch_id = read_branch_id(&db).await?;
		let shard_key = branch_shard_key(branch_id, 1, 7);
		seed(
			&db,
			vec![
				(
					branch_meta_head_key(branch_id),
					encode_db_head(head_with_branch(branch_id, 7, 130))?,
				),
				(
					shard_key.clone(),
					encoded_blob(7, &[(64, 0x64), (65, 0x65)])?,
				),
			],
		)
		.await?;
		db.txn("test_depotconveyer_commit", |tx| async move {
			quota::atomic_add_branch(&tx, branch_id, 50_000);
			Ok(())
		})
		.await?;

		let (guard, reached, release) = test_hooks::pause_after_truncate_cleanup(TEST_DATABASE);
		let commit_task = tokio::spawn({
			let database_db = ctx.make_db(test_bucket(), TEST_DATABASE);
			async move { database_db.commit(vec![page(1, 0x11)], 64, 4_000).await }
		});

		reached.notified().await;
		seed(&db, vec![(shard_key, encoded_blob(7, &[(64, 0x99)])?)]).await?;
		release.notify_waiters();
		drop(guard);
		commit_task.await??;

		let database_db = ctx.make_db(test_bucket(), TEST_DATABASE);
		assert_eq!(
			database_db.get_pages(vec![64]).await?,
			vec![fetched_page(64, 0x99)]
		);

		Ok(())
	})
}

#[tokio::test]
async fn shrink_commit_deletes_above_eof_pidx_and_shards() -> Result<()> {
	commit_matrix!("depot-commit-shrink", |ctx, db, database_db| {
		database_db.commit(vec![page(1, 0x01)], 130, 1_000).await?;
		let branch_id = read_branch_id(&db).await?;
		seed(
			&db,
			vec![
				(
					branch_meta_head_key(branch_id),
					encode_db_head(head_with_branch(branch_id, 7, 130))?,
				),
				(
					branch_delta_chunk_key(branch_id, 7, 0),
					encoded_blob(7, &[(64, 0x64), (129, 0x81)])?,
				),
				(branch_pidx_key(branch_id, 64), 7_u64.to_be_bytes().to_vec()),
				(
					branch_pidx_key(branch_id, 129),
					7_u64.to_be_bytes().to_vec(),
				),
				(
					branch_shard_key(branch_id, 1, 7),
					encoded_blob(7, &[(64, 0x64)])?,
				),
				(
					branch_shard_key(branch_id, 2, 7),
					encoded_blob(7, &[(129, 0x81)])?,
				),
			],
		)
		.await?;
		db.txn("test_depotconveyer_commit", |tx| async move {
			quota::atomic_add_branch(&tx, branch_id, 50_000);
			Ok(())
		})
		.await?;

		let database_db = ctx.make_db(test_bucket(), TEST_DATABASE);
		database_db.commit(vec![page(1, 0x11)], 63, 4_000).await?;

		assert_eq!(read_head(&db).await?, head_with_branch(branch_id, 8, 63));
		assert!(
			read_value(&db, branch_pidx_key(branch_id, 64))
				.await?
				.is_none()
		);
		assert!(
			read_value(&db, branch_pidx_key(branch_id, 129))
				.await?
				.is_none()
		);
		assert!(
			read_value(&db, branch_shard_key(branch_id, 1, 7))
				.await?
				.is_none()
		);
		assert!(
			read_value(&db, branch_shard_key(branch_id, 2, 7))
				.await?
				.is_none()
		);
		assert_eq!(
			read_value(&db, branch_pidx_key(branch_id, 1)).await?,
			Some(8_u64.to_be_bytes().to_vec())
		);

		Ok(())
	})
}

#[tokio::test]
async fn commit_writes_dirty_marker_and_sends_first_deltas_available() -> Result<()> {
	common::test_matrix("depot-commit-dirty-first", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let signals = Arc::new(Mutex::new(Vec::new()));
			let database_db = Db::new_with_compaction_signaler(
				db.clone(),
				test_bucket(),
				TEST_DATABASE.to_string(),
				NodeId::new(),
				recording_compaction_signaler(Arc::clone(&signals)),
			);
			database_db.commit(vec![page(1, 0x01)], 1, 1_000).await?;
			let branch_id = read_branch_id(&db).await?;
			let compaction_threshold = quota::compaction_delta_threshold(branch_id);
			seed(
				&db,
				vec![
					(
						branch_meta_head_key(branch_id),
						encode_db_head(head_with_branch(branch_id, compaction_threshold - 1, 1))?,
					),
					(
						branch_meta_compact_key(branch_id),
						encode_meta_compact(MetaCompact {
							materialized_txid: 0,
						})?,
					),
				],
			)
			.await?;
			db.txn("test_depotconveyer_commit", |tx| async move {
				quota::atomic_add_branch(&tx, branch_id, 1_000);
				Ok(())
			})
			.await?;

			database_db.commit(vec![page(1, 0x11)], 1, 5_000).await?;

			let dirty = read_dirty_marker(&db, branch_id)
				.await?
				.expect("dirty marker should exist");
			assert_eq!(dirty.observed_head_txid, compaction_threshold);
			assert_eq!(dirty.updated_at_ms, 5_000);
			let signals = signals.lock().clone();
			assert_eq!(
				signals,
				vec![DeltasAvailable {
					database_branch_id: branch_id,
					observed_head_txid: compaction_threshold,
					dirty_updated_at_ms: 5_000,
				}]
			);

			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn commit_without_compaction_signaler_skips_dirty_marker() -> Result<()> {
	common::test_matrix("depot-commit-dirty-disabled", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let database_db = Db::new(
				db.clone(),
				test_bucket(),
				TEST_DATABASE.to_string(),
				NodeId::new(),
			);
			database_db.commit(vec![page(1, 0x01)], 1, 1_000).await?;
			let branch_id = read_branch_id(&db).await?;
			let compaction_threshold = quota::compaction_delta_threshold(branch_id);
			seed(
				&db,
				vec![(
					branch_meta_head_key(branch_id),
					encode_db_head(head_with_branch(branch_id, compaction_threshold - 1, 1))?,
				)],
			)
			.await?;
			db.txn("test_depotconveyer_commit", |tx| async move {
				quota::atomic_add_branch(&tx, branch_id, 1_000);
				Ok(())
			})
			.await?;

			database_db.commit(vec![page(1, 0x11)], 1, 5_000).await?;

			assert!(read_dirty_marker(&db, branch_id).await?.is_none());
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn commit_refreshes_dirty_marker_without_rearming_or_resignaling() -> Result<()> {
	common::test_matrix("depot-commit-dirty-refresh", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let signals = Arc::new(Mutex::new(Vec::new()));
			let database_db = Db::new_with_compaction_signaler(
				db.clone(),
				test_bucket(),
				TEST_DATABASE.to_string(),
				NodeId::new(),
				recording_compaction_signaler(Arc::clone(&signals)),
			);
			database_db.commit(vec![page(1, 0x01)], 1, 1_000).await?;
			let branch_id = read_branch_id(&db).await?;
			let compaction_threshold = quota::compaction_delta_threshold(branch_id);
			seed(
				&db,
				vec![
					(
						branch_meta_head_key(branch_id),
						encode_db_head(head_with_branch(branch_id, compaction_threshold - 1, 1))?,
					),
					(
						branch_meta_compact_key(branch_id),
						encode_meta_compact(MetaCompact {
							materialized_txid: 0,
						})?,
					),
				],
			)
			.await?;
			db.txn("test_depotconveyer_commit", |tx| async move {
				quota::atomic_add_branch(&tx, branch_id, 1_000);
				Ok(())
			})
			.await?;

			database_db.commit(vec![page(1, 0x11)], 1, 5_000).await?;
			database_db.commit(vec![page(1, 0x22)], 1, 5_100).await?;
			let dirty = read_dirty_marker(&db, branch_id)
				.await?
				.expect("dirty marker should refresh");
			assert_eq!(dirty.observed_head_txid, compaction_threshold + 1);
			assert_eq!(dirty.updated_at_ms, 5_100);
			assert_eq!(signals.lock().len(), 1);

			let signal_due_at_ms =
				5_000 + i64::try_from(quota::TRIGGER_THROTTLE_MS).unwrap_or(i64::MAX);
			database_db
				.commit(vec![page(1, 0x33)], 1, signal_due_at_ms)
				.await?;
			let dirty = read_dirty_marker(&db, branch_id)
				.await?
				.expect("dirty marker should refresh again");
			assert_eq!(dirty.observed_head_txid, compaction_threshold + 2);
			assert_eq!(dirty.updated_at_ms, signal_due_at_ms);
			let due_key = read_value(&db, sqlite_cmp_dirty_due_locator_key(branch_id))
				.await?
				.expect("dirty marker should have an exact retry locator");
			let (due_at_ms, due_branch_id, dirty_updated_at_ms, attempt) =
				decode_sqlite_cmp_dirty_due_key(&due_key)?;
			assert_eq!(due_branch_id, branch_id);
			assert_eq!(dirty_updated_at_ms, 5_000);
			assert_eq!(attempt, 0);
			assert!((5_000 + 15_000..5_000 + 45_000).contains(&due_at_ms));
			let signals = signals.lock().clone();
			assert_eq!(signals.len(), 1);

			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn dirty_marker_clear_rejects_stale_observed_value() -> Result<()> {
	common::test_matrix("depot-commit-dirty-stale-clear", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let branch_id = DatabaseBranchId::new_v4();
			let old_dirty = SqliteCmpDirty {
				observed_head_txid: 40,
				updated_at_ms: 1_000,
			};
			let new_dirty = SqliteCmpDirty {
				observed_head_txid: 41,
				updated_at_ms: 1_100,
			};
			seed(
				&db,
				vec![(
					sqlite_cmp_dirty_key(branch_id),
					encode_sqlite_cmp_dirty(new_dirty.clone())?,
				)],
			)
			.await?;

			assert!(
				!clear_sqlite_cmp_dirty_if_observed_idle(&db, branch_id, old_dirty).await?,
				"stale dirty marker should not clear"
			);
			assert_eq!(read_dirty_marker(&db, branch_id).await?, Some(new_dirty));

			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn dirty_marker_clear_requires_workflow_compaction_root() -> Result<()> {
	common::test_matrix("depot-commit-dirty-root-required", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let branch_id = DatabaseBranchId::new_v4();
			let dirty = SqliteCmpDirty {
				observed_head_txid: 40,
				updated_at_ms: 1_000,
			};
			seed(
				&db,
				vec![
					(
						branch_meta_head_key(branch_id),
						encode_db_head(head_with_branch(branch_id, 40, 1))?,
					),
					(
						branch_meta_compact_key(branch_id),
						encode_meta_compact(MetaCompact {
							materialized_txid: 40,
						})?,
					),
					(
						sqlite_cmp_dirty_key(branch_id),
						encode_sqlite_cmp_dirty(dirty.clone())?,
					),
				],
			)
			.await?;

			let err = clear_sqlite_cmp_dirty_if_observed_idle(&db, branch_id, dirty)
				.await
				.expect_err("dirty clear without workflow compaction root should fail");
			assert!(
				err.chain().any(|cause| cause
					.to_string()
					.contains("sqlite compaction root missing for dirty clear")),
				"unexpected error: {err:?}"
			);
			assert!(read_dirty_marker(&db, branch_id).await?.is_some());

			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn dirty_marker_clear_removes_exact_idle_marker() -> Result<()> {
	common::test_matrix("depot-commit-dirty-clear", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let branch_id = DatabaseBranchId::new_v4();
			let due_key = sqlite_cmp_dirty_due_key(31_000, branch_id, 1_000, 0);
			let dirty = SqliteCmpDirty {
				observed_head_txid: 40,
				updated_at_ms: 1_000,
			};
			seed(
				&db,
				vec![
					(
						branch_meta_head_key(branch_id),
						encode_db_head(head_with_branch(branch_id, 40, 1))?,
					),
					(
						sqlite_cmp_dirty_key(branch_id),
						encode_sqlite_cmp_dirty(dirty.clone())?,
					),
					(
						branch_compaction_root_key(branch_id),
						encode_compaction_root(CompactionRoot {
							schema_version: 1,
							manifest_generation: 7,
							hot_watermark_txid: 40,
							cold_watermark_txid: 40,
							cold_watermark_versionstamp: [0x22; 16],
						})?,
					),
					(due_key.clone(), Vec::new()),
					(sqlite_cmp_dirty_due_locator_key(branch_id), due_key.clone()),
				],
			)
			.await?;

			assert!(
				clear_sqlite_cmp_dirty_if_observed_idle(&db, branch_id, dirty).await?,
				"idle exact marker should clear"
			);
			assert!(read_dirty_marker(&db, branch_id).await?.is_none());
			assert!(read_value(&db, due_key).await?.is_none());
			assert!(
				read_value(&db, sqlite_cmp_dirty_due_locator_key(branch_id))
					.await?
					.is_none()
			);

			Ok(())
		})
	})
	.await
}
