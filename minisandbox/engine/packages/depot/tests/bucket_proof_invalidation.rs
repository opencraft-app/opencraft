#![cfg(feature = "test-faults")]

mod fork_common;

use anyhow::{Result, ensure};
use depot::{
	conveyer::{branch, history_pin, udb},
	keys::{
		branch_bucket_proof_catalog_complete_key, branch_bucket_proof_complete_key,
		bucket_proof_epoch_key, bucket_proof_epoch_shard,
	},
	types::{
		BucketBranchId, BucketId, DatabaseBranchId, DepotReadMode, GetPagesOptions,
		ResolvedVersionstamp,
	},
	workflows::compaction::advance_bucket_fork_proof_for_test,
};
use gas::prelude::Id;
use universaldb::utils::IsolationLevel::Serializable;

use fork_common::{
	common, page, page_bytes, read_bucket_branch_id_for, read_commit, read_database_branch_id,
	read_value,
};

async fn finish_proof(udb: &universaldb::Database, branch_id: DatabaseBranchId) -> Result<()> {
	// Each call advances one durable, bounded page, not a timed retry of a flaky operation.
	for _ in 0..64 {
		if !advance_bucket_fork_proof_for_test(udb, branch_id).await? {
			return Ok(());
		}
	}
	anyhow::bail!("bounded proof fixture did not converge")
}

#[tokio::test]
async fn unrelated_catalog_creates_preserve_completed_proof() -> Result<()> {
	common::test_matrix("depot-proof-unrelated-create", |_tier, ctx| {
		Box::pin(async move {
			ctx.db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
			let branch_id =
				read_database_branch_id(&ctx.udb, ctx.bucket_id, &ctx.database_id).await?;
			let bucket_branch = read_bucket_branch_id_for(&ctx.udb, ctx.bucket_id).await?;
			finish_proof(&ctx.udb, branch_id).await?;
			let epoch = read_value(&ctx.udb, bucket_proof_epoch_key(bucket_branch)).await?;

			for index in 0..32 {
				ctx.make_db(ctx.bucket_id, format!("unrelated-{index}"))
					.commit(vec![page(1, 0x22)], 2, 2_000 + index)
					.await?;
				assert!(
					!advance_bucket_fork_proof_for_test(&ctx.udb, branch_id).await?,
					"creating another database must not reset an unchanged fork proof"
				);
				assert_eq!(
					read_value(&ctx.udb, bucket_proof_epoch_key(bucket_branch)).await?,
					epoch,
					"database membership must not mutate the bucket-tree fork epoch"
				);
			}
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn catalog_create_in_an_independent_colliding_root_preserves_proof() -> Result<()> {
	common::test_matrix("depot-proof-root-collision", |_tier, ctx| {
		Box::pin(async move {
			ctx.db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
			let branch_id =
				read_database_branch_id(&ctx.udb, ctx.bucket_id, &ctx.database_id).await?;
			let source_root = read_bucket_branch_id_for(&ctx.udb, ctx.bucket_id).await?;
			finish_proof(&ctx.udb, branch_id).await?;
			let mut bytes = *source_root.as_uuid().as_bytes();
			bytes[15] ^= 1;
			let other_root = BucketBranchId::from_uuid(uuid::Uuid::from_bytes(bytes));
			let other_bucket = BucketId::new_v4();
			assert_ne!(source_root, other_root);
			assert_eq!(
				bucket_proof_epoch_shard(source_root),
				bucket_proof_epoch_shard(other_root)
			);
			// Force a shard collision without relying on probabilistic UUID allocation. All
			// metadata and the following membership commit use the real production writers.
			ctx.udb
				.txn("test_initialize_colliding_bucket", move |tx| async move {
					branch::write_root_bucket_metadata(
						&tx,
						other_bucket,
						other_root,
						2_000,
						&udb::INCOMPLETE_VERSIONSTAMP,
					)
				})
				.await?;
			ctx.make_db(Id::v1(other_bucket.as_uuid(), 1), "unrelated")
				.commit(vec![page(1, 0x22)], 2, 3_000)
				.await?;
			assert!(
				!advance_bucket_fork_proof_for_test(&ctx.udb, branch_id).await?,
				"independent catalog changes must not invalidate a colliding shard subscription"
			);
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn tombstone_invalidates_only_the_affected_database_proof() -> Result<()> {
	common::test_matrix("depot-proof-unrelated-delete", |_tier, ctx| {
		Box::pin(async move {
			ctx.db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
			let unrelated = ctx.make_db(ctx.bucket_id, "unrelated");
			unrelated.commit(vec![page(1, 0x22)], 2, 2_000).await?;
			let source_id =
				read_database_branch_id(&ctx.udb, ctx.bucket_id, &ctx.database_id).await?;
			let unrelated_id =
				read_database_branch_id(&ctx.udb, ctx.bucket_id, "unrelated").await?;
			finish_proof(&ctx.udb, source_id).await?;
			finish_proof(&ctx.udb, unrelated_id).await?;
			branch::delete_database(&ctx.udb, BucketId::from_gas_id(ctx.bucket_id), unrelated_id)
				.await?;
			assert!(
				read_value(&ctx.udb, branch_bucket_proof_complete_key(unrelated_id))
					.await?
					.is_none(),
				"membership changes must still invalidate the affected database atomically"
			);
			assert!(
				!advance_bucket_fork_proof_for_test(&ctx.udb, source_id).await?,
				"another database's tombstone must not reset the source proof"
			);
			assert_eq!(
				ctx.db.get_pages(vec![1]).await?[0].bytes,
				Some(page_bytes(0x11))
			);
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn affected_tombstone_clears_an_incomplete_proof() -> Result<()> {
	common::test_matrix("depot-proof-paged-delete", |_tier, ctx| {
		Box::pin(async move {
			ctx.db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
			let branch_id =
				read_database_branch_id(&ctx.udb, ctx.bucket_id, &ctx.database_id).await?;
			assert!(advance_bucket_fork_proof_for_test(&ctx.udb, branch_id).await?);
			assert!(
				read_value(
					&ctx.udb,
					branch_bucket_proof_catalog_complete_key(branch_id)
				)
				.await?
				.is_some(),
				"fixture must have durable partial progress before the mutation"
			);
			assert!(
				read_value(&ctx.udb, branch_bucket_proof_complete_key(branch_id))
					.await?
					.is_none()
			);
			branch::delete_database(&ctx.udb, BucketId::from_gas_id(ctx.bucket_id), branch_id)
				.await?;
			assert!(
				read_value(
					&ctx.udb,
					branch_bucket_proof_catalog_complete_key(branch_id)
				)
				.await?
				.is_none(),
				"affected membership must clear partial progress in its tombstone transaction"
			);
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn unrelated_create_between_proof_pages_does_not_erase_progress() -> Result<()> {
	common::test_matrix("depot-proof-paged-create", |_tier, ctx| {
		Box::pin(async move {
			ctx.db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
			let branch_id =
				read_database_branch_id(&ctx.udb, ctx.bucket_id, &ctx.database_id).await?;
			ensure!(
				advance_bucket_fork_proof_for_test(&ctx.udb, branch_id).await?,
				"fixture must stop at an incomplete durable proof page"
			);
			ctx.make_db(ctx.bucket_id, "unrelated")
				.commit(vec![page(1, 0x22)], 2, 2_000)
				.await?;
			assert!(
				!advance_bucket_fork_proof_for_test(&ctx.udb, branch_id).await?,
				"the next proof page must converge despite unrelated catalog churn"
			);
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn new_bucket_fork_still_invalidates_proof_and_preserves_history() -> Result<()> {
	common::test_matrix("depot-proof-new-bucket-fork", |_tier, ctx| {
		Box::pin(async move {
			ctx.db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
			let branch_id =
				read_database_branch_id(&ctx.udb, ctx.bucket_id, &ctx.database_id).await?;
			let commit = read_commit(&ctx.udb, branch_id, 1).await?;
			let bucket_branch = read_bucket_branch_id_for(&ctx.udb, ctx.bucket_id).await?;
			finish_proof(&ctx.udb, branch_id).await?;
			let epoch = read_value(&ctx.udb, bucket_proof_epoch_key(bucket_branch)).await?;
			let child_bucket = branch::fork_bucket(
				&ctx.udb,
				BucketId::from_gas_id(ctx.bucket_id),
				ResolvedVersionstamp {
					versionstamp: commit.versionstamp,
					restore_point: None,
				},
			)
			.await?;
			assert_ne!(child_bucket, BucketId::from_gas_id(ctx.bucket_id));
			assert_ne!(
				read_value(&ctx.udb, bucket_proof_epoch_key(bucket_branch)).await?,
				epoch
			);
			assert!(
				advance_bucket_fork_proof_for_test(&ctx.udb, branch_id).await?,
				"a real bucket fork must keep publication/reclamation fail-closed"
			);
			finish_proof(&ctx.udb, branch_id).await?;
			let retained = ctx
				.udb
				.txn("test_read_bucket_fork_pin", move |tx| async move {
					history_pin::read_earliest_history_pin_txid_at_or_before(
						&tx,
						branch_id,
						1,
						Serializable,
					)
					.await
				})
				.await?;
			assert_eq!(
				retained,
				Some(1),
				"the completed proof must materialize the fork history pin"
			);
			ctx.db.commit(vec![page(1, 0x33)], 2, 3_000).await?;
			let historical = ctx
				.db
				.get_pages_with_options(
					vec![1],
					GetPagesOptions {
						mode: DepotReadMode::DiagnosticNoSideEffects,
						diagnostic_max_txid: Some(1),
						..Default::default()
					},
				)
				.await?;
			assert_eq!(historical.pages[0].bytes, Some(page_bytes(0x11)));
			assert_eq!(
				ctx.db.get_pages(vec![1]).await?[0].bytes,
				Some(page_bytes(0x33))
			);
			Ok(())
		})
	})
	.await
}
