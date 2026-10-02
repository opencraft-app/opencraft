mod common;

use std::collections::BTreeSet;

use anyhow::Result;
use depot::{
	conveyer::branch,
	keys::{
		branch_commit_key, branch_meta_head_key, branches_refcount_key, bucket_catalog_key,
		bucket_pointer_cur_key, database_pointer_cur_key,
	},
	types::{
		BucketBranchId, BucketId, CommitRow, DBHead, DatabaseBranchId, DirtyPage,
		ResolvedVersionstamp, decode_bucket_pointer, decode_commit_row, decode_database_pointer,
		decode_db_head,
	},
};
use gas::prelude::Id;
use universaldb::utils::IsolationLevel::Snapshot;

fn test_bucket() -> Id {
	Id::v1(uuid::Uuid::from_u128(0x1234), 1)
}

fn page(pgno: u32, fill: u8) -> DirtyPage {
	DirtyPage {
		pgno,
		bytes: vec![fill; depot::keys::PAGE_SIZE as usize],
	}
}

async fn read_value(db: &universaldb::Database, key: Vec<u8>) -> Result<Option<Vec<u8>>> {
	db.txn("test_depotlist_databases", move |tx| {
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

async fn read_bucket_branch_id(
	db: &universaldb::Database,
	bucket_id: BucketId,
) -> Result<BucketBranchId> {
	let bucket_pointer_bytes = read_value(db, bucket_pointer_cur_key(bucket_id))
		.await?
		.expect("bucket pointer should exist");

	Ok(decode_bucket_pointer(&bucket_pointer_bytes)?.current_branch)
}

async fn read_database_branch_id(
	db: &universaldb::Database,
	bucket_id: BucketId,
	database_id: &str,
) -> Result<DatabaseBranchId> {
	let bucket_branch = read_bucket_branch_id(db, bucket_id).await?;
	let bytes = read_value(db, database_pointer_cur_key(bucket_branch, database_id))
		.await?
		.expect("database pointer should exist");

	Ok(decode_database_pointer(&bytes)?.current_branch)
}

async fn read_head_commit(
	db: &universaldb::Database,
	branch_id: DatabaseBranchId,
) -> Result<CommitRow> {
	let head_bytes = read_value(db, branch_meta_head_key(branch_id))
		.await?
		.expect("branch head should exist");
	let head: DBHead = decode_db_head(&head_bytes)?;
	let commit_bytes = read_value(db, branch_commit_key(branch_id, head.head_txid))
		.await?
		.expect("head commit row should exist");

	decode_commit_row(&commit_bytes)
}

async fn read_refcount(db: &universaldb::Database, branch_id: DatabaseBranchId) -> Result<i64> {
	let bytes = read_value(db, branches_refcount_key(branch_id))
		.await?
		.expect("branch refcount should exist");
	let bytes: [u8; 8] = bytes
		.as_slice()
		.try_into()
		.expect("branch refcount should be i64 LE");

	Ok(i64::from_le_bytes(bytes))
}

#[tokio::test]
async fn paginated_list_kway_merges_large_inherited_catalogs_without_skips() -> Result<()> {
	common::test_matrix("depot-list-paginated-kway", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let bucket = BucketId::from_gas_id(test_bucket());
			let database_name = format!("{}-pagination-anchor", ctx.database_id);
			let database_db = ctx.make_db(test_bucket(), database_name.clone());
			database_db.commit(vec![page(1, 0x10)], 1, 1_000).await?;
			let anchor_id = read_database_branch_id(&db, bucket, &database_name).await?;
			let commit = read_head_commit(&db, anchor_id).await?;
			let child_bucket = branch::fork_bucket(
				&db,
				bucket,
				ResolvedVersionstamp {
					versionstamp: commit.versionstamp,
					restore_point: None,
				},
			)
			.await?;
			let parent_branch = read_bucket_branch_id(&db, bucket).await?;
			let child_branch = read_bucket_branch_id(&db, child_bucket).await?;
			let mut expected = BTreeSet::from([anchor_id]);
			db.txn(
				"test_seed_interleaved_paginated_catalogs",
				move |tx| async move {
					for idx in 0..600_u128 {
						let parent_id = DatabaseBranchId::from_uuid(uuid::Uuid::from_u128(
							0x7000_0000_0000_0000 + idx * 2,
						));
						let child_id = DatabaseBranchId::from_uuid(uuid::Uuid::from_u128(
							0x7000_0000_0000_0000 + idx * 2 + 1,
						));
						tx.informal()
							.set(&bucket_catalog_key(parent_branch, parent_id), &[0; 16]);
						tx.informal()
							.set(&bucket_catalog_key(child_branch, child_id), &[0; 16]);
					}
					Ok(())
				},
			)
			.await?;
			for idx in 0..600_u128 {
				expected.insert(DatabaseBranchId::from_uuid(uuid::Uuid::from_u128(
					0x7000_0000_0000_0000 + idx * 2,
				)));
				expected.insert(DatabaseBranchId::from_uuid(uuid::Uuid::from_u128(
					0x7000_0000_0000_0000 + idx * 2 + 1,
				)));
			}

			let mut cursor = None;
			let mut actual = Vec::new();
			loop {
				let page = branch::list_databases_page(&db, child_bucket, cursor, 13).await?;
				assert!(page.databases.len() <= 13);
				actual.extend(page.databases);
				let Some(next) = page.next_cursor else { break };
				assert!(cursor.is_none_or(|previous| next > previous));
				cursor = Some(next);
			}
			assert_eq!(actual, expected.into_iter().collect::<Vec<_>>());
			assert_eq!(branch::list_databases(&db, child_bucket).await?, actual);

			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn delete_database_in_forked_bucket_hides_in_child_only() -> Result<()> {
	common::test_matrix("depot-list-delete-forked", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let bucket = BucketId::from_gas_id(test_bucket());
			let first_database_name = format!("{}-first", ctx.database_id);
			let database_db = ctx.make_db(test_bucket(), first_database_name.clone());
			database_db.commit(vec![page(1, 0x11)], 1, 1_000).await?;
			let database_id = read_database_branch_id(&db, bucket, &first_database_name).await?;
			let commit = read_head_commit(&db, database_id).await?;
			let forked_bucket = branch::fork_bucket(
				&db,
				bucket,
				ResolvedVersionstamp {
					versionstamp: commit.versionstamp,
					restore_point: None,
				},
			)
			.await?;

			let parent_databases = branch::list_databases(&db, bucket).await?;
			let child_databases = branch::list_databases(&db, forked_bucket).await?;
			assert_eq!(parent_databases, vec![database_id]);
			assert_eq!(child_databases, vec![database_id]);

			branch::delete_database(&db, forked_bucket, database_id).await?;

			assert_eq!(
				branch::list_databases(&db, forked_bucket).await?,
				Vec::new()
			);
			assert_eq!(
				branch::list_databases(&db, bucket).await?,
				vec![database_id]
			);
			assert_eq!(read_refcount(&db, database_id).await?, 0);

			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn delete_database_visibility_check_ignores_unrelated_catalog_cardinality() -> Result<()> {
	common::test_matrix("depot-delete-exact-visibility", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let bucket = BucketId::from_gas_id(test_bucket());
			let database_name = format!("{}-exact", ctx.database_id);
			let database_db = ctx.make_db(test_bucket(), database_name.clone());
			database_db.commit(vec![page(1, 0x11)], 1, 1_000).await?;
			let database_id = read_database_branch_id(&db, bucket, &database_name).await?;
			let bucket_branch = read_bucket_branch_id(&db, bucket).await?;

			db.txn("test_seed_unrelated_bucket_catalog", move |tx| async move {
				for offset in 1..=2_048_u128 {
					let unrelated = DatabaseBranchId::from_uuid(uuid::Uuid::from_u128(
						0x8000_0000_0000_0000_0000_0000_0000_0000 | offset,
					));
					tx.informal()
						.set(&bucket_catalog_key(bucket_branch, unrelated), &[1; 16]);
				}
				Ok(())
			})
			.await?;

			branch::delete_database(&db, bucket, database_id).await?;
			assert_eq!(read_refcount(&db, database_id).await?, 0);

			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn fork_bucket_filters_source_databases_created_after_fork() -> Result<()> {
	common::test_matrix("depot-list-fork-filters", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let bucket = BucketId::from_gas_id(test_bucket());
			let first_database_name = format!("{}-first", ctx.database_id);
			let second_database_name = format!("{}-second", ctx.database_id);
			let first_db = ctx.make_db(test_bucket(), first_database_name.clone());
			first_db.commit(vec![page(1, 0x11)], 1, 1_000).await?;
			let first_database_id =
				read_database_branch_id(&db, bucket, &first_database_name).await?;
			let first_commit = read_head_commit(&db, first_database_id).await?;
			let forked_bucket = branch::fork_bucket(
				&db,
				bucket,
				ResolvedVersionstamp {
					versionstamp: first_commit.versionstamp,
					restore_point: None,
				},
			)
			.await?;

			let second_db = ctx.make_db(test_bucket(), second_database_name.clone());
			second_db.commit(vec![page(1, 0x22)], 1, 2_000).await?;
			let second_database_id =
				read_database_branch_id(&db, bucket, &second_database_name).await?;

			assert_eq!(
				branch::list_databases(&db, bucket)
					.await?
					.into_iter()
					.collect::<BTreeSet<_>>(),
				BTreeSet::from([first_database_id, second_database_id])
			);
			assert_eq!(
				branch::list_databases(&db, forked_bucket).await?,
				vec![first_database_id]
			);

			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn parent_tombstone_visibility_is_capped_across_deep_bucket_chain() -> Result<()> {
	common::test_matrix("depot-list-parent-tombstone", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let bucket = BucketId::from_gas_id(test_bucket());
			let first_database_name = format!("{}-first", ctx.database_id);
			let second_database_name = format!("{}-second", ctx.database_id);
			let first_db = ctx.make_db(test_bucket(), first_database_name.clone());
			first_db.commit(vec![page(1, 0x11)], 1, 1_000).await?;
			let first_database_id =
				read_database_branch_id(&db, bucket, &first_database_name).await?;
			let first_commit = read_head_commit(&db, first_database_id).await?;

			let before_delete_bucket = branch::fork_bucket(
				&db,
				bucket,
				ResolvedVersionstamp {
					versionstamp: first_commit.versionstamp,
					restore_point: None,
				},
			)
			.await?;

			branch::delete_database(&db, bucket, first_database_id).await?;

			let second_db = ctx.make_db(test_bucket(), second_database_name.clone());
			second_db.commit(vec![page(1, 0x22)], 1, 2_000).await?;
			let second_database_id =
				read_database_branch_id(&db, bucket, &second_database_name).await?;
			let second_commit = read_head_commit(&db, second_database_id).await?;

			let after_delete_bucket = branch::fork_bucket(
				&db,
				bucket,
				ResolvedVersionstamp {
					versionstamp: second_commit.versionstamp,
					restore_point: None,
				},
			)
			.await?;
			let deep_after_delete_bucket = branch::fork_bucket(
				&db,
				after_delete_bucket,
				ResolvedVersionstamp {
					versionstamp: second_commit.versionstamp,
					restore_point: None,
				},
			)
			.await?;

			assert_eq!(
				branch::list_databases(&db, before_delete_bucket).await?,
				vec![first_database_id]
			);
			assert_eq!(
				branch::list_databases(&db, bucket).await?,
				vec![second_database_id]
			);
			assert_eq!(
				branch::list_databases(&db, after_delete_bucket).await?,
				vec![second_database_id]
			);
			assert_eq!(
				branch::list_databases(&db, deep_after_delete_bucket).await?,
				vec![second_database_id]
			);

			Ok(())
		})
	})
	.await
}
