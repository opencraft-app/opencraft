mod common;

use anyhow::{Context, Result};
use depot::{
	inspect::{self, RowsQuery},
	keys::{PAGE_SIZE, bucket_pointer_cur_key, database_pointer_cur_key},
	types::{
		BucketId, DatabaseBranchId, DirtyPage, decode_bucket_pointer, decode_database_pointer,
	},
};
use rivet_pools::NodeId;

fn page(pgno: u32, fill: u8) -> DirtyPage {
	DirtyPage {
		pgno,
		bytes: vec![fill; PAGE_SIZE as usize],
	}
}

async fn current_branch(ctx: &common::TestDb) -> Result<DatabaseBranchId> {
	let bucket_pointer = common::read_value(
		&ctx.udb,
		bucket_pointer_cur_key(BucketId::from_gas_id(ctx.bucket_id)),
	)
	.await?
	.context("bucket pointer missing")?;
	let bucket_pointer = decode_bucket_pointer(&bucket_pointer)?;
	let database_pointer = common::read_value(
		&ctx.udb,
		database_pointer_cur_key(bucket_pointer.current_branch, &ctx.database_id),
	)
	.await?
	.context("database pointer missing")?;
	let database_pointer = decode_database_pointer(&database_pointer)?;

	Ok(database_pointer.current_branch)
}

fn rows_query(limit: Option<usize>, cursor: Option<String>) -> RowsQuery {
	RowsQuery {
		limit,
		cursor,
		include_bytes: None,
		before_txid: None,
		after_txid: None,
		from_pgno: None,
		shard_id: None,
		state: None,
		kind: None,
		job_id: None,
	}
}

#[tokio::test]
async fn inspect_branch_rows_paginate_commits_with_cursor() -> Result<()> {
	let ctx = common::build_test_db("depot-inspect-commits", common::TierMode::Disabled).await?;
	ctx.db.commit(vec![page(1, 0x11)], 1, 1_000).await?;
	ctx.db.commit(vec![page(2, 0x22)], 2, 2_000).await?;
	let branch_id = current_branch(&ctx).await?;

	let first = inspect::branch_rows(
		&ctx.udb,
		NodeId::new(),
		branch_id,
		inspect::RowFamily::Commits,
		rows_query(Some(1), None),
	)
	.await?;
	assert_eq!(first.rows.len(), 1);
	assert!(first.next_cursor.is_some());
	assert_eq!(first.rows[0]["decoded"]["txid"], 1);

	let second = inspect::branch_rows(
		&ctx.udb,
		NodeId::new(),
		branch_id,
		inspect::RowFamily::Commits,
		rows_query(Some(1), first.next_cursor),
	)
	.await?;
	assert_eq!(second.rows.len(), 1);
	assert_eq!(second.next_cursor, None);
	assert_eq!(second.rows[0]["decoded"]["txid"], 2);

	Ok(())
}

#[tokio::test]
async fn inspect_branch_rows_enforces_limit_cap() -> Result<()> {
	let ctx = common::build_test_db("depot-inspect-limit", common::TierMode::Disabled).await?;
	ctx.db.commit(vec![page(1, 0x11)], 1, 1_000).await?;
	let branch_id = current_branch(&ctx).await?;

	let err = inspect::branch_rows(
		&ctx.udb,
		NodeId::new(),
		branch_id,
		inspect::RowFamily::Commits,
		rows_query(Some(inspect::MAX_LIMIT + 1), None),
	)
	.await
	.unwrap_err();

	assert!(err.to_string().contains("hard cap"));

	let err = inspect::branch_rows(
		&ctx.udb,
		NodeId::new(),
		branch_id,
		inspect::RowFamily::Commits,
		rows_query(Some(0), None),
	)
	.await
	.unwrap_err();
	assert!(err.to_string().contains("1..="));
	Ok(())
}

#[tokio::test]
async fn inspect_branch_rows_decodes_pidx_family() -> Result<()> {
	let ctx = common::build_test_db("depot-inspect-pidx", common::TierMode::Disabled).await?;
	ctx.db.commit(vec![page(7, 0x77)], 8, 1_000).await?;
	let branch_id = current_branch(&ctx).await?;

	let rows = inspect::branch_rows(
		&ctx.udb,
		NodeId::new(),
		branch_id,
		inspect::RowFamily::Pidx,
		rows_query(None, None),
	)
	.await?;

	assert_eq!(rows.rows.len(), 1);
	assert_eq!(rows.rows[0]["decoded"]["pgno"], 7);
	assert_eq!(rows.rows[0]["decoded"]["owner_txid"], 1);
	Ok(())
}

#[tokio::test]
async fn inspect_bottomless_state_separates_logical_size_from_fdb_write_debt() -> Result<()> {
	let ctx = common::build_test_db("depot-inspect-bottomless", common::TierMode::Disabled).await?;
	ctx.db.commit(vec![page(1, 0x11)], 1, 1_000).await?;

	let state = inspect::bottomless_state(
		&ctx.udb,
		NodeId::new(),
		BucketId::from_gas_id(ctx.bucket_id),
		ctx.database_id.clone(),
		depot::cold_tier::FdbWriteDebtPolicy::default(),
	)
	.await?;
	assert_eq!(state.data["found"], true);
	assert_eq!(state.data["bottomless_contract_version"], 1);
	assert_eq!(state.data["logical_size_bytes"], u64::from(PAGE_SIZE));
	assert_eq!(
		state.data["logical_storage_limit_bytes"],
		serde_json::Value::Null
	);
	assert_eq!(
		state.data["fdb_write_debt_target_bytes"],
		depot::quota::FDB_WRITE_DEBT_TARGET_BYTES
	);
	assert_eq!(
		state.data["fdb_write_debt_limit_bytes"],
		depot::quota::FDB_WRITE_DEBT_LIMIT_BYTES
	);
	assert!(
		state.data["fdb_write_debt_bytes"]
			.as_i64()
			.unwrap_or_default()
			> 0
	);
	assert_eq!(state.data["counts_exact"], true);
	assert_eq!(state.data["cold_ready"], false);

	Ok(())
}

#[tokio::test]
async fn inspect_raw_scan_uses_base64url_cursor() -> Result<()> {
	let ctx = common::build_test_db("depot-inspect-raw", common::TierMode::Disabled).await?;
	ctx.db.commit(vec![page(1, 0x11)], 1, 1_000).await?;

	let first = inspect::raw_scan(
		&ctx.udb,
		NodeId::new(),
		inspect::RawScanQuery {
			prefix: None,
			start_after: None,
			limit: Some(1),
			decode: Some(true),
		},
	)
	.await?;
	assert_eq!(first.rows.len(), 1);
	let cursor = first.next_cursor.context("first raw page cursor missing")?;

	let second = inspect::raw_scan(
		&ctx.udb,
		NodeId::new(),
		inspect::RawScanQuery {
			prefix: None,
			start_after: Some(cursor),
			limit: Some(1),
			decode: Some(true),
		},
	)
	.await?;
	assert_eq!(second.rows.len(), 1);

	Ok(())
}

#[tokio::test]
async fn inspect_footprint_is_bounded_and_hashes_raw_rows() -> Result<()> {
	let ctx = common::build_test_db("depot-inspect-footprint", common::TierMode::Disabled).await?;
	ctx.db.commit(vec![page(1, 0x11)], 1, 1_000).await?;

	let first = inspect::footprint_page(
		&ctx.udb,
		NodeId::new(),
		"depot".into(),
		vec![depot::keys::SQLITE_SUBSPACE_PREFIX],
		None,
		Some(1),
	)
	.await?;
	assert_eq!(first.scope, "depot");
	assert_eq!(first.row_count, 1);
	assert_eq!(first.raw_bytes, first.key_bytes + first.value_bytes);
	assert_eq!(first.page_sha256.len(), 64);
	assert_eq!(first.first_key, first.last_key);
	let cursor = first
		.next_cursor
		.context("first footprint cursor missing")?;

	let second = inspect::footprint_page(
		&ctx.udb,
		NodeId::new(),
		"depot".into(),
		vec![depot::keys::SQLITE_SUBSPACE_PREFIX],
		Some(cursor),
		Some(1),
	)
	.await?;
	assert_eq!(second.row_count, 1);
	assert_ne!(first.page_sha256, second.page_sha256);
	Ok(())
}

#[tokio::test]
async fn inspect_due_queue_separates_actionable_from_retained_rows() -> Result<()> {
	let ctx = common::build_test_db("depot-inspect-due-queue", common::TierMode::Disabled).await?;
	ctx.db.commit(vec![page(1, 0x11)], 1, 1_000).await?;
	let branch_id = current_branch(&ctx).await?;
	ctx.udb
		.txn("test_seed_due_queue", move |tx| async move {
			tx.informal()
				.set(&depot::keys::branch_gc_queue_key(branch_id, 999), &[]);
			tx.informal()
				.set(&depot::keys::branch_gc_queue_key(branch_id, 1_001), &[]);
			Ok(())
		})
		.await?;

	let page = inspect::due_queue_page(
		&ctx.udb,
		NodeId::new(),
		inspect::DueQueue::BranchGc,
		None,
		Some(10),
		1_000,
	)
	.await?;
	assert_eq!(page.row_count, 2);
	assert_eq!(page.due_rows, 1);
	assert_eq!(page.future_retained_rows, 1);
	assert_eq!(page.oldest_due_at_ms, Some(999));
	assert_eq!(page.newest_due_at_ms, Some(1_001));
	Ok(())
}
