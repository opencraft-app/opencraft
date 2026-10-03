mod fork_common;

use anyhow::Result;
use depot::{
	conveyer::branch,
	types::{BucketId, ResolvedVersionstamp, SnapshotSelector},
};
use gas::prelude::Id;

use fork_common::{
	assert_storage_error, common, page, page_bytes, read_commit, read_database_branch_id,
};

async fn fork_at(ctx: &common::TestDb, source: Id, versionstamp: [u8; 16]) -> Result<Id> {
	let bucket = branch::fork_bucket(
		&ctx.udb,
		BucketId::from_gas_id(source),
		ResolvedVersionstamp {
			versionstamp,
			restore_point: None,
		},
	)
	.await?;
	Ok(Id::v1(bucket.as_uuid(), 1))
}

#[tokio::test]
async fn inherited_default_read_keeps_snapshot_after_parent_overwrite() -> Result<()> {
	common::test_matrix("bucket-read-parent-write", |_tier, ctx| {
		Box::pin(async move {
			ctx.db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
			let root = read_database_branch_id(&ctx.udb, ctx.bucket_id, &ctx.database_id).await?;
			let at = read_commit(&ctx.udb, root, 1).await?;
			let child = fork_at(&ctx, ctx.bucket_id, at.versionstamp).await?;
			let reader = ctx.make_db(child, ctx.database_id.clone());
			assert_eq!(
				reader.get_pages(vec![1]).await?[0].bytes,
				Some(page_bytes(0x11))
			);
			ctx.db.commit(vec![page(1, 0x33)], 2, 2_000).await?;
			let result = reader.get_pages_with_metadata(vec![1]).await?;
			assert_eq!(result.head_txid, 1);
			assert_eq!(result.pages[0].bytes, Some(page_bytes(0x11)));
			assert_eq!(
				ctx.db.get_pages(vec![1]).await?[0].bytes,
				Some(page_bytes(0x33))
			);
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn inherited_head_keeps_fork_eof_after_parent_shrink() -> Result<()> {
	common::test_matrix("bucket-read-parent-shrink", |_tier, ctx| {
		Box::pin(async move {
			ctx.db
				.commit(vec![page(1, 0x11), page(2, 0x22)], 2, 1_000)
				.await?;
			let root = read_database_branch_id(&ctx.udb, ctx.bucket_id, &ctx.database_id).await?;
			let at = read_commit(&ctx.udb, root, 1).await?;
			let child = fork_at(&ctx, ctx.bucket_id, at.versionstamp).await?;
			ctx.db.commit(vec![page(1, 0x33)], 1, 2_000).await?;
			let result = ctx
				.make_db(child, ctx.database_id.clone())
				.get_pages_with_metadata(vec![2])
				.await?;
			assert_eq!(result.db_size_pages, 2);
			assert_eq!(result.pages[0].bytes, Some(page_bytes(0x22)));
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn bucket_snapshot_between_database_commits_selects_preceding_commit() -> Result<()> {
	common::test_matrix("bucket-read-global-stamp", |_tier, ctx| {
		Box::pin(async move {
			ctx.db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
			let other = ctx.make_db(ctx.bucket_id, "other");
			other.commit(vec![page(1, 0x22)], 2, 2_000).await?;
			let other_id = read_database_branch_id(&ctx.udb, ctx.bucket_id, "other").await?;
			let at = read_commit(&ctx.udb, other_id, 1).await?;
			let child = fork_at(&ctx, ctx.bucket_id, at.versionstamp).await?;
			ctx.db.commit(vec![page(1, 0x33)], 2, 3_000).await?;
			let result = ctx
				.make_db(child, ctx.database_id.clone())
				.get_pages_with_metadata(vec![1])
				.await?;
			assert_eq!(result.head_txid, 1);
			assert_eq!(result.pages[0].bytes, Some(page_bytes(0x11)));
			assert_eq!(
				ctx.make_db(child, "other").get_pages(vec![1]).await?[0].bytes,
				Some(page_bytes(0x22))
			);
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn first_child_write_does_not_mutate_parent_database() -> Result<()> {
	common::test_matrix("bucket-read-child-write", |_tier, ctx| {
		Box::pin(async move {
			ctx.db
				.commit(vec![page(1, 0x11), page(2, 0x22)], 2, 1_000)
				.await?;
			let root = read_database_branch_id(&ctx.udb, ctx.bucket_id, &ctx.database_id).await?;
			let at = read_commit(&ctx.udb, root, 1).await?;
			let child = fork_at(&ctx, ctx.bucket_id, at.versionstamp).await?;
			let child_db = ctx.make_db(child, ctx.database_id.clone());
			child_db.commit(vec![page(1, 0x44)], 2, 2_000).await?;
			assert_eq!(
				ctx.db.get_pages(vec![1]).await?[0].bytes,
				Some(page_bytes(0x11))
			);
			let child_branch = read_database_branch_id(&ctx.udb, child, &ctx.database_id).await?;
			assert_ne!(child_branch, root);
			assert_eq!(
				child_db.get_pages(vec![1, 2]).await?[0].bytes,
				Some(page_bytes(0x44))
			);
			assert_eq!(
				child_db.get_pages(vec![2]).await?[0].bytes,
				Some(page_bytes(0x22))
			);
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn nested_bucket_caps_cannot_advance_an_older_inherited_snapshot() -> Result<()> {
	common::test_matrix("bucket-read-nested-cap", |_tier, ctx| {
		Box::pin(async move {
			ctx.db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
			let root = read_database_branch_id(&ctx.udb, ctx.bucket_id, &ctx.database_id).await?;
			let first = read_commit(&ctx.udb, root, 1).await?;
			let child = fork_at(&ctx, ctx.bucket_id, first.versionstamp).await?;
			ctx.db.commit(vec![page(1, 0x33)], 2, 2_000).await?;
			let later = read_commit(&ctx.udb, root, 2).await?;
			let grandchild = fork_at(&ctx, child, later.versionstamp).await?;
			assert_eq!(
				ctx.make_db(grandchild, ctx.database_id.clone())
					.get_pages(vec![1])
					.await?[0]
					.bytes,
				Some(page_bytes(0x11))
			);
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn database_created_after_bucket_snapshot_is_not_inherited() -> Result<()> {
	common::test_matrix("bucket-read-late-create", |_tier, ctx| {
		Box::pin(async move {
			ctx.db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
			let root = read_database_branch_id(&ctx.udb, ctx.bucket_id, &ctx.database_id).await?;
			let at = read_commit(&ctx.udb, root, 1).await?;
			let child = fork_at(&ctx, ctx.bucket_id, at.versionstamp).await?;
			ctx.make_db(ctx.bucket_id, "late")
				.commit(vec![page(1, 0x55)], 1, 2_000)
				.await?;
			let error = ctx
				.make_db(child, "late")
				.get_pages(vec![1])
				.await
				.expect_err("late membership must remain invisible");
			assert_storage_error(&error, depot::error::SqliteStorageError::DatabaseNotFound);
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn bucket_inherits_database_fork_before_any_local_database_commit() -> Result<()> {
	common::test_matrix("bucket-read-virtual-head", |_tier, ctx| {
		Box::pin(async move {
			ctx.db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
			let database = branch::fork_database(
				&ctx.udb,
				BucketId::from_gas_id(ctx.bucket_id),
				ctx.database_id.clone(),
				SnapshotSelector::Latest,
				BucketId::from_gas_id(ctx.bucket_id),
			)
			.await?;
			let other = ctx.make_db(ctx.bucket_id, "clock");
			other.commit(vec![page(1, 0x22)], 1, 2_000).await?;
			let other_id = read_database_branch_id(&ctx.udb, ctx.bucket_id, "clock").await?;
			let at = read_commit(&ctx.udb, other_id, 1).await?;
			let child = fork_at(&ctx, ctx.bucket_id, at.versionstamp).await?;
			let inherited = ctx.make_db(child, database.clone());
			assert_eq!(
				inherited.get_pages(vec![1]).await?[0].bytes,
				Some(page_bytes(0x11))
			);
			inherited.commit(vec![page(1, 0x44)], 2, 3_000).await?;
			assert_eq!(
				ctx.make_db(ctx.bucket_id, database)
					.get_pages(vec![1])
					.await?[0]
					.bytes,
				Some(page_bytes(0x11))
			);
			assert_eq!(
				inherited.get_pages(vec![1]).await?[0].bytes,
				Some(page_bytes(0x44))
			);
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn child_first_write_uses_snapshot_not_the_advanced_parent() -> Result<()> {
	common::test_matrix("bucket-read-cow-old-head", |_tier, ctx| {
		Box::pin(async move {
			ctx.db
				.commit(vec![page(1, 0x11), page(2, 0x22)], 2, 1_000)
				.await?;
			let root = read_database_branch_id(&ctx.udb, ctx.bucket_id, &ctx.database_id).await?;
			let at = read_commit(&ctx.udb, root, 1).await?;
			let child = fork_at(&ctx, ctx.bucket_id, at.versionstamp).await?;
			ctx.db
				.commit(vec![page(1, 0x33), page(2, 0x55)], 2, 2_000)
				.await?;
			let writer = ctx.make_db(child, ctx.database_id.clone());
			writer.commit(vec![page(1, 0x44)], 2, 3_000).await?;
			assert_eq!(
				writer.get_pages(vec![2]).await?[0].bytes,
				Some(page_bytes(0x22))
			);
			assert_eq!(
				ctx.db.get_pages(vec![1]).await?[0].bytes,
				Some(page_bytes(0x33))
			);
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn missing_exact_database_fork_index_fails_closed() -> Result<()> {
	common::test_matrix("bucket-read-exact-vtx-gap", |_tier, ctx| {
		Box::pin(async move {
			ctx.db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
			ctx.db.commit(vec![page(1, 0x33)], 2, 2_000).await?;
			let root = read_database_branch_id(&ctx.udb, ctx.bucket_id, &ctx.database_id).await?;
			let at = read_commit(&ctx.udb, root, 2).await?;
			let database = branch::fork_database(
				&ctx.udb,
				BucketId::from_gas_id(ctx.bucket_id),
				ctx.database_id.clone(),
				SnapshotSelector::Latest,
				BucketId::from_gas_id(ctx.bucket_id),
			)
			.await?;
			ctx.udb
				.txn("test_remove_owned_exact_fork_index", move |tx| async move {
					tx.informal()
						.clear(&depot::keys::branch_vtx_key(root, at.versionstamp));
					Ok(())
				})
				.await?;
			let error = ctx
				.make_db(ctx.bucket_id, database)
				.get_pages(vec![1])
				.await
				.expect_err(
					"an exact database fork boundary must not fall back to an earlier commit",
				);
			assert_storage_error(
				&error,
				depot::error::SqliteStorageError::RestoreTargetExpired,
			);
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn missing_retained_commit_fails_closed_instead_of_reading_newer_state() -> Result<()> {
	common::test_matrix("bucket-read-expired-cap", |_tier, ctx| {
		Box::pin(async move {
			ctx.db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
			let root = read_database_branch_id(&ctx.udb, ctx.bucket_id, &ctx.database_id).await?;
			let at = read_commit(&ctx.udb, root, 1).await?;
			let child = fork_at(&ctx, ctx.bucket_id, at.versionstamp).await?;
			ctx.db.commit(vec![page(1, 0x33)], 2, 2_000).await?;
			ctx.udb
				.txn("test_remove_owned_retained_commit", move |tx| async move {
					tx.informal()
						.clear(&depot::keys::branch_commit_key(root, 1));
					Ok(())
				})
				.await?;
			let error = ctx
				.make_db(child, ctx.database_id.clone())
				.get_pages(vec![1])
				.await
				.expect_err("missing history must not select a later commit");
			assert_storage_error(
				&error,
				depot::error::SqliteStorageError::RestoreTargetExpired,
			);
			Ok(())
		})
	})
	.await
}
