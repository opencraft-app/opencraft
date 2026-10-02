use std::sync::Arc;

use anyhow::Result;
use depot::{
	conveyer::Db,
	types::{CommitOptions, DirtyPage},
};
use gas::prelude::Id;
use rivet_pools::NodeId;
use tempfile::Builder;

async fn test_db() -> Result<universaldb::Database> {
	let path = Builder::new()
		.prefix("pegboard-sqlite-writer-fence-")
		.tempdir()?
		.keep();
	let driver = universaldb::driver::RocksDbDatabaseDriver::new(path).await?;

	Ok(universaldb::Database::new(Arc::new(driver)))
}

async fn set_actor_generation(
	db: &universaldb::Database,
	actor_id: Id,
	generation: u32,
) -> Result<()> {
	db.txn(
		"test_pegboardactor_sqlite_writer_fence",
		move |tx| async move {
			let tx = tx.with_subspace(pegboard::keys::subspace());
			tx.write(
				&pegboard::keys::actor::GenerationKey::new(actor_id),
				generation,
			)?;
			Ok(())
		},
	)
	.await
}

fn commit_options(generation: u64, head_txid: u64) -> CommitOptions {
	CommitOptions {
		expected_head_txid: Some(head_txid),
		expected_writer_generation: Some(generation),
		..Default::default()
	}
}

#[tokio::test]
async fn depot_commit_fences_against_the_exact_pegboard_generation_key() -> Result<()> {
	let udb = test_db().await?;
	let actor_id = Id::new_v1(1);
	let namespace_id = Id::new_v1(1);
	set_actor_generation(&udb, actor_id, 7).await?;
	let actor_db = Db::new(
		Arc::new(udb.clone()),
		namespace_id,
		actor_id.to_string(),
		NodeId::new(),
	)
	.with_writer_fence_key(pegboard::actor_sqlite::writer_fence_key(actor_id));

	let first = actor_db
		.commit_with_options(
			vec![DirtyPage {
				pgno: 1,
				bytes: vec![0x71; 4096],
			}],
			1,
			1_000,
			commit_options(7, 0),
		)
		.await?;
	set_actor_generation(&udb, actor_id, 8).await?;

	let stale = actor_db
		.commit_with_options(
			vec![DirtyPage {
				pgno: 1,
				bytes: vec![0x72; 4096],
			}],
			1,
			1_001,
			commit_options(7, first.head_txid),
		)
		.await
		.expect_err("the prior Pegboard generation must lose its Depot writer fence");
	assert!(
		stale
			.chain()
			.any(|source| source.to_string().contains("writer fence mismatch")),
		"unexpected stale generation error: {stale:#}"
	);

	Ok(())
}
