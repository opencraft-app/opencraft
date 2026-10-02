#![cfg(feature = "foundationdb")]

use std::{path::PathBuf, sync::Arc};

#[test]
fn classifies_foundationdb_transaction_too_large() {
	let error = anyhow::Error::new(foundationdb::FdbError::from_code(2101));
	assert!(universaldb::utils::error_is_transaction_too_large(&error));

	let other = anyhow::Error::new(foundationdb::FdbError::from_code(1020));
	assert!(!universaldb::utils::error_is_transaction_too_large(&other));
}

#[cfg(unix)]
#[test]
fn rejects_non_utf8_cluster_file_before_starting_network() {
	use std::{ffi::OsString, os::unix::ffi::OsStringExt, path::PathBuf};

	let error = universaldb::driver::FoundationDbDatabaseDriver::new(
		universaldb::driver::FoundationDbConfig {
			cluster_file: Some(PathBuf::from(OsString::from_vec(vec![0xff]))),
		},
	)
	.err()
	.expect("non-UTF-8 cluster file must be rejected");
	assert!(
		error
			.to_string()
			.contains("cluster file path is not valid UTF-8")
	);
}

#[tokio::test]
async fn reuses_process_network_across_sequential_drivers() {
	let Some(cluster_file) = std::env::var_os("FDB_CLUSTER_FILE").map(PathBuf::from) else {
		eprintln!("skipping live FoundationDB network reuse test: FDB_CLUSTER_FILE is not set");
		return;
	};
	let key = format!("universaldb/network-reuse/{}", uuid::Uuid::new_v4()).into_bytes();

	let first = universaldb::Database::new(Arc::new(
		universaldb::driver::FoundationDbDatabaseDriver::new(
			universaldb::driver::FoundationDbConfig {
				cluster_file: Some(cluster_file.clone()),
			},
		)
		.expect("first FoundationDB driver should start the process network"),
	));
	first
		.txn("test_foundationdb_network_reuse_first", {
			let key = key.clone();
			move |tx| {
				let key = key.clone();
				async move {
					tx.set(&key, b"first");
					Ok(())
				}
			}
		})
		.await
		.expect("first driver should commit");
	drop(first);

	let second = universaldb::Database::new(Arc::new(
		universaldb::driver::FoundationDbDatabaseDriver::new(
			universaldb::driver::FoundationDbConfig {
				cluster_file: Some(cluster_file),
			},
		)
		.expect("second FoundationDB driver should reuse the process network"),
	));
	let value = second
		.txn("test_foundationdb_network_reuse_second", {
			let key = key.clone();
			move |tx| {
				let key = key.clone();
				async move {
					let value = tx
						.get(&key, universaldb::utils::IsolationLevel::Serializable)
						.await?;
					tx.clear(&key);
					Ok(value.map(Vec::<u8>::from))
				}
			}
		})
		.await
		.expect("second driver should read and commit");

	assert_eq!(value.as_deref(), Some(b"first".as_slice()));
}
