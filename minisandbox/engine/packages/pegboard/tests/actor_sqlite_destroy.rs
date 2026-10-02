use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use depot::keys::{
	delta_chunk_key, meta_compact_key, meta_compactor_lease_key, meta_head_key, meta_quota_key,
	pidx_delta_key, shard_key,
};
use depot::{
	conveyer::{Db, branch},
	keys::{
		branch_gc_queue_locator_key, branches_refcount_key, bucket_branches_database_tombstone_key,
		bucket_catalog_key,
	},
	types::{BucketId, DirtyPage},
};
use gas::prelude::Id;
use rivet_pools::NodeId;
use tempfile::Builder;
use universaldb::utils::IsolationLevel::Snapshot;

async fn test_db() -> Result<universaldb::Database> {
	let path = Builder::new()
		.prefix("pegboard-sqlite-destroy-")
		.tempdir()?
		.keep();
	let driver = universaldb::driver::RocksDbDatabaseDriver::new(path).await?;

	Ok(universaldb::Database::new(Arc::new(driver)))
}

fn sqlite_keys(actor_id: Id) -> Vec<Vec<u8>> {
	let actor_id = actor_id.to_string();
	vec![
		meta_head_key(&actor_id),
		meta_compact_key(&actor_id),
		meta_quota_key(&actor_id),
		meta_compactor_lease_key(&actor_id),
		pidx_delta_key(&actor_id, 1),
		delta_chunk_key(&actor_id, 1, 0),
		shard_key(&actor_id, 0),
	]
}

async fn seed(db: &universaldb::Database, keys: &[Vec<u8>]) -> Result<()> {
	let writes = keys
		.iter()
		.cloned()
		.map(|key| (key, b"present".to_vec()))
		.collect::<Vec<_>>();
	db.txn("test_pegboardactor_sqlite_destroy", move |tx| {
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

async fn value_exists(db: &universaldb::Database, key: Vec<u8>) -> Result<bool> {
	db.txn("test_pegboardactor_sqlite_destroy", move |tx| {
		let key = key.clone();
		async move { Ok(tx.informal().get(&key, Snapshot).await?.is_some()) }
	})
	.await
}

#[tokio::test]
async fn actor_destroy_clears_compactor_lease() -> Result<()> {
	let db = test_db().await?;
	let actor_id = Id::new_v1(1);
	let namespace_id = Id::new_v1(1);
	let keys = sqlite_keys(actor_id);
	seed(&db, &keys).await?;

	db.txn("test_pegboardactor_sqlite_destroy", move |tx| async move {
		pegboard::actor_sqlite::clear_v2_storage_for_destroy(&tx, namespace_id, actor_id).await?;
		Ok(())
	})
	.await?;

	for key in keys {
		assert!(!value_exists(&db, key).await?);
	}

	Ok(())
}

#[tokio::test]
async fn actor_destroy_in_one_tx() -> Result<()> {
	let db = test_db().await?;
	let actor_id = Id::new_v1(1);
	let namespace_id = Id::new_v1(1);
	let keys = sqlite_keys(actor_id);
	seed(&db, &keys).await?;

	db.txn("test_pegboardactor_sqlite_destroy", move |tx| async move {
		pegboard::actor_sqlite::clear_v2_storage_for_destroy(&tx, namespace_id, actor_id).await?;
		Err::<(), anyhow::Error>(anyhow!("rollback sqlite destroy"))
	})
	.await
	.expect_err("failed transaction should roll back sqlite clears");

	for key in keys {
		assert!(value_exists(&db, key).await?);
	}

	Ok(())
}

#[tokio::test]
async fn actor_destroy_tombstones_branch_once_and_returns_gc_target() -> Result<()> {
	let db = test_db().await?;
	let actor_id = Id::new_v1(1);
	let namespace_id = Id::new_v1(1);
	let bucket_id = BucketId::from_gas_id(namespace_id);
	let actor_db = Db::new(
		Arc::new(db.clone()),
		namespace_id,
		actor_id.to_string(),
		NodeId::new(),
	);
	actor_db
		.commit(
			vec![DirtyPage {
				pgno: 1,
				bytes: vec![0x44; 4096],
			}],
			1,
			1_000,
		)
		.await?;
	let database_branch_id = db
		.txn("test_actor_destroy_resolve_branch", move |tx| async move {
			branch::resolve_database_branch(
				&tx,
				bucket_id,
				&actor_id.to_string(),
				universaldb::utils::IsolationLevel::Serializable,
			)
			.await?
			.context("Actor database branch should exist")
		})
		.await?;

	for _ in 0..2 {
		let deleted = db
			.txn("test_actor_destroy_tombstone", move |tx| async move {
				pegboard::actor_sqlite::clear_v2_storage_for_destroy(&tx, namespace_id, actor_id)
					.await
			})
			.await?;
		assert_eq!(deleted, Some(database_branch_id));
	}

	let (refcount, tombstoned, gc_queued) = db
		.txn("test_actor_destroy_read_tombstone", move |tx| async move {
			let bucket_branch_id = branch::resolve_bucket_branch(
				&tx,
				bucket_id,
				universaldb::utils::IsolationLevel::Serializable,
			)
			.await?
			.context("Actor bucket branch should exist")?;
			let refcount = tx
				.informal()
				.get(&branches_refcount_key(database_branch_id), Snapshot)
				.await?
				.context("Actor branch refcount should exist")?;
			let refcount = i64::from_le_bytes(refcount.as_slice().try_into()?);
			let tombstoned = tx
				.informal()
				.get(
					&bucket_branches_database_tombstone_key(bucket_branch_id, database_branch_id),
					Snapshot,
				)
				.await?
				.is_some();
			let gc_queued = tx
				.informal()
				.get(&branch_gc_queue_locator_key(database_branch_id), Snapshot)
				.await?
				.is_some();
			Ok((refcount, tombstoned, gc_queued))
		})
		.await?;
	assert_eq!(refcount, 0, "activity replay must not decrement twice");
	assert!(tombstoned);
	assert!(
		gc_queued,
		"Actor tombstone must atomically enqueue branch GC"
	);

	Ok(())
}

#[tokio::test]
async fn actor_destroy_does_not_gc_a_pointer_without_visible_catalog_membership() -> Result<()> {
	let db = test_db().await?;
	let actor_id = Id::new_v1(1);
	let namespace_id = Id::new_v1(1);
	let bucket_id = BucketId::from_gas_id(namespace_id);
	let actor_db = Db::new(
		Arc::new(db.clone()),
		namespace_id,
		actor_id.to_string(),
		NodeId::new(),
	);
	actor_db
		.commit(
			vec![DirtyPage {
				pgno: 1,
				bytes: vec![0x55; 4096],
			}],
			1,
			1_000,
		)
		.await?;
	let (bucket_branch_id, database_branch_id) = db
		.txn(
			"test_actor_destroy_resolve_hidden_branch",
			move |tx| async move {
				let bucket_branch_id = branch::resolve_bucket_branch(
					&tx,
					bucket_id,
					universaldb::utils::IsolationLevel::Serializable,
				)
				.await?
				.context("Actor bucket branch should exist")?;
				let database_branch_id = branch::resolve_database_branch(
					&tx,
					bucket_id,
					&actor_id.to_string(),
					universaldb::utils::IsolationLevel::Serializable,
				)
				.await?
				.context("Actor database branch should exist")?;
				Ok((bucket_branch_id, database_branch_id))
			},
		)
		.await?;

	db.txn(
		"test_actor_destroy_hide_catalog_membership",
		move |tx| async move {
			tx.informal()
				.clear(&bucket_catalog_key(bucket_branch_id, database_branch_id));
			Ok(())
		},
	)
	.await?;
	let deleted = db
		.txn("test_actor_destroy_hidden_branch", move |tx| async move {
			pegboard::actor_sqlite::clear_v2_storage_for_destroy(&tx, namespace_id, actor_id).await
		})
		.await?;
	assert_eq!(
		deleted, None,
		"an invisible pointer is not a safe GC target"
	);

	let refcount = db
		.txn("test_actor_destroy_hidden_refcount", move |tx| async move {
			let value = tx
				.informal()
				.get(&branches_refcount_key(database_branch_id), Snapshot)
				.await?
				.context("Actor branch refcount should exist")?;
			Ok(i64::from_le_bytes(value.as_slice().try_into()?))
		})
		.await?;
	assert_eq!(refcount, 1);
	assert!(
		!value_exists(&db, branch_gc_queue_locator_key(database_branch_id)).await?,
		"an invisible pointer must not enqueue branch GC"
	);
	Ok(())
}
