#![cfg(feature = "foundationdb")]

use rivet_config::{
	Config,
	config::{Database, Root, db::FoundationDb},
};
use universaldb::utils::IsolationLevel;

#[tokio::test]
async fn creates_pool_and_enforces_physical_cluster_cell_policy() {
	let cluster_file = std::env::var_os("FDB_CLUSTER_FILE").map(Into::into);
	let config_for = |cell: &str, allow_shared_cluster: bool| {
		Config::from_root(Root {
			database: Some(Database::FoundationDb(FoundationDb {
				cluster_file: cluster_file.clone(),
				transaction_retry_limit: 7,
				allow_shared_cluster,
			})),
			runtime: rivet_config::config::Runtime::with_gasoline_cell_namespace(cell.into()),
			..Root::default()
		})
	};

	let pool = rivet_pools::db::udb::setup(&config_for("test-a01", true))
		.await
		.expect("FoundationDB pool setup should succeed")
		.expect("UDB pool should be configured");
	rivet_pools::db::udb::setup(&config_for("test-b01", true))
		.await
		.expect("a second explicitly opted-in test Cell should join")
		.expect("UDB pool should be configured");
	let error = rivet_pools::db::udb::setup(&config_for("test-c01", false))
		.await
		.err()
		.expect("a process that did not acknowledge sharing must fail startup");
	assert!(error.to_string().contains("allow_shared_cluster"));

	pool.txn("foundationdb_pool_smoke", |tx| async move {
		tx.set(b"foundationdb_pool_smoke", b"connected");
		Ok(())
	})
	.await
	.expect("pool write should commit");

	let value = pool
		.txn("foundationdb_pool_smoke_read", |tx| async move {
			tx.get(b"foundationdb_pool_smoke", IsolationLevel::Serializable)
				.await
		})
		.await
		.expect("pool read should succeed");
	assert_eq!(
		value.as_deref().map(Vec::as_slice),
		Some(b"connected".as_slice())
	);
}
