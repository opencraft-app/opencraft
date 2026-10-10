#![cfg(feature = "foundationdb")]

use std::{
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
};

use anyhow::{Result, ensure};
use futures_util::{TryStreamExt, future::try_join_all};
use universaldb::{
	Database, KeySelector, RangeOption,
	driver::{FoundationDbConfig, FoundationDbDatabaseDriver},
	utils::{IsolationLevel::Serializable, end_of_key_range, end_of_prefix_range},
};
use uuid::Uuid;

fn live_database() -> Result<Option<Database>> {
	if std::env::var("RIVET_TEST_FDB_POINT_READS").as_deref() != Ok("1") {
		return Ok(None);
	}
	let cluster_file = PathBuf::from(
		std::env::var_os("FDB_CLUSTER_FILE")
			.expect("the live point-read gate must provide an isolated FDB_CLUSTER_FILE"),
	);
	let db = Database::new(Arc::new(FoundationDbDatabaseDriver::new(
		FoundationDbConfig {
			cluster_file: Some(cluster_file),
		},
	)?));
	db.txn_retry_limit(1)?;
	Ok(Some(db))
}

#[tokio::test]
async fn native_parallel_point_reads_exceed_the_flight_bound_and_preserve_values() -> Result<()> {
	let Some(db) = live_database()? else {
		return Ok(());
	};
	let prefix = format!("rivet/test/fdb-point-reads/{}/", Uuid::new_v4()).into_bytes();
	let keys: Vec<_> = (0..64)
		.map(|index| [prefix.as_slice(), format!("{index:04}").as_bytes()].concat())
		.collect();
	db.txn("test_fdb_point_reads_seed", |tx| {
		let keys = keys.clone();
		async move {
			for key in &keys {
				tx.set(key, key);
			}
			Ok(())
		}
	})
	.await?;
	db.txn("test_fdb_point_reads_read", |tx| {
		let keys = keys.clone();
		async move {
			let values = try_join_all(keys.iter().map(|key| tx.get(key, Serializable))).await?;
			for (key, value) in keys.iter().zip(values) {
				ensure!(
					value.as_ref().map(|value| value.as_slice()) == Some(key.as_slice()),
					"point read changed"
				);
			}
			let selector = KeySelector::first_greater_or_equal(keys[0].clone());
			let (key, value) = tokio::try_join!(
				tx.get_key(&selector, Serializable),
				tx.get(&keys[63], Serializable)
			)?;
			ensure!(key.as_slice() == keys[0], "key selector changed");
			ensure!(
				value.as_ref().map(|value| value.as_slice()) == Some(keys[63].as_slice()),
				"mixed read changed"
			);
			let range = RangeOption::from((keys[0].clone(), end_of_key_range(&keys[63])));
			let rows: Vec<_> = tx
				.get_ranges_keyvalues(range, Serializable)
				.try_collect()
				.await?;
			ensure!(rows.len() == 64);
			Ok(())
		}
	})
	.await?;
	db.txn("test_fdb_point_reads_cleanup", |tx| {
		let prefix = prefix.clone();
		async move {
			tx.clear_range(&prefix, &end_of_prefix_range(&prefix));
			let range = RangeOption::from((prefix.clone(), end_of_prefix_range(&prefix)));
			ensure!(
				tx.get_ranges_keyvalues(range, Serializable)
					.try_next()
					.await?
					.is_none()
			);
			Ok(())
		}
	})
	.await?;
	Ok(())
}

#[tokio::test]
async fn native_conflict_retry_drains_reads_before_resetting_the_transaction() -> Result<()> {
	let Some(db) = live_database()? else {
		return Ok(());
	};
	db.txn_retry_limit(2)?;
	let prefix = format!("rivet/test/fdb-point-retry/{}/", Uuid::new_v4()).into_bytes();
	let generation = [prefix.as_slice(), b"generation"].concat();
	let payload = [prefix.as_slice(), b"payload"].concat();
	let attempts = AtomicUsize::new(0);
	db.txn("test_fdb_point_retry", |tx| {
		let generation = generation.clone();
		let payload = payload.clone();
		let db = &db;
		let attempts = &attempts;
		async move {
			let (observed, _) = tokio::try_join!(
				tx.get(&generation, Serializable),
				tx.get(&payload, Serializable)
			)?;
			if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
				ensure!(observed.is_none());
				db.txn("test_fdb_point_retry_takeover", |new_tx| {
					let generation = generation.clone();
					async move {
						new_tx.set(&generation, b"new");
						Ok(())
					}
				})
				.await?;
			} else {
				ensure!(observed.as_ref().map(|value| value.as_slice()) == Some(b"new".as_slice()));
			}
			tx.set(&payload, b"current writer");
			Ok(())
		}
	})
	.await?;
	ensure!(attempts.load(Ordering::SeqCst) == 2);
	db.txn("test_fdb_point_retry_cleanup", |tx| {
		let prefix = prefix.clone();
		let payload = payload.clone();
		async move {
			ensure!(
				tx.get(&payload, Serializable)
					.await?
					.as_ref()
					.map(|v| v.as_slice())
					== Some(b"current writer".as_slice())
			);
			tx.clear_range(&prefix, &end_of_prefix_range(&prefix));
			ensure!(tx.get(&payload, Serializable).await?.is_none());
			Ok(())
		}
	})
	.await?;
	Ok(())
}

#[tokio::test]
async fn native_queued_write_does_not_overtake_an_earlier_point_read() -> Result<()> {
	let Some(db) = live_database()? else {
		return Ok(());
	};
	let key = format!("rivet/test/fdb-point-order/{}", Uuid::new_v4()).into_bytes();
	db.txn("test_fdb_point_order", |tx| {
		let key = key.clone();
		async move {
			tx.set(&key, b"before");
			let before = tx.get(&key, Serializable);
			tokio::pin!(before);
			ensure!(futures_util::poll!(&mut before).is_pending());
			tx.set(&key, b"after");
			let (before, after) = tokio::try_join!(before, tx.get(&key, Serializable))?;
			ensure!(before.as_ref().map(|value| value.as_slice()) == Some(b"before".as_slice()));
			ensure!(after.as_ref().map(|value| value.as_slice()) == Some(b"after".as_slice()));
			tx.clear(&key);
			ensure!(tx.get(&key, Serializable).await?.is_none());
			Ok(())
		}
	})
	.await?;
	Ok(())
}

#[tokio::test]
async fn native_parallel_read_keeps_the_writer_generation_conflict() -> Result<()> {
	let Some(db) = live_database()? else {
		return Ok(());
	};
	let prefix = format!("rivet/test/fdb-point-fence/{}/", Uuid::new_v4()).into_bytes();
	let generation = [prefix.as_slice(), b"generation"].concat();
	let payload = [prefix.as_slice(), b"payload"].concat();
	db.txn("test_fdb_point_fence_seed", |tx| {
		let generation = generation.clone();
		async move {
			tx.set(&generation, b"old");
			Ok(())
		}
	})
	.await?;
	let result = db
		.txn("test_fdb_point_fence_stale", |tx| {
			let generation = generation.clone();
			let payload = payload.clone();
			let db = &db;
			async move {
				let (old, _) = tokio::try_join!(
					tx.get(&generation, Serializable),
					tx.get(&payload, Serializable)
				)?;
				ensure!(old.as_ref().map(|value| value.as_slice()) == Some(b"old".as_slice()));
				db.txn("test_fdb_point_fence_takeover", |new_tx| {
					let generation = generation.clone();
					async move {
						new_tx.set(&generation, b"new");
						Ok(())
					}
				})
				.await?;
				tx.set(&payload, b"stale writer");
				Ok(())
			}
		})
		.await;
	ensure!(
		result.is_err(),
		"stale writer must conflict after parallel reads"
	);
	db.txn("test_fdb_point_fence_verify", |tx| {
		let prefix = prefix.clone();
		let generation = generation.clone();
		let payload = payload.clone();
		async move {
			ensure!(tx.get(&payload, Serializable).await?.is_none());
			ensure!(
				tx.get(&generation, Serializable)
					.await?
					.as_ref()
					.map(|value| value.as_slice())
					== Some(b"new".as_slice())
			);
			tx.clear_range(&prefix, &end_of_prefix_range(&prefix));
			ensure!(tx.get(&generation, Serializable).await?.is_none());
			Ok(())
		}
	})
	.await?;
	Ok(())
}
