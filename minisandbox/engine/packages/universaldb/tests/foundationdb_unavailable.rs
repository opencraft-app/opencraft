#![cfg(feature = "foundationdb")]

use std::{sync::Arc, time::Duration};

use universaldb::{Database, TXN_TIMEOUT, driver::FoundationDbConfig};
use uuid::Uuid;

#[test]
fn foundationdb_native_predicates_do_not_cover_transaction_timeout() {
	let timeout = foundationdb::FdbError::from_code(1031);
	assert!(!timeout.is_retryable());
	assert!(!timeout.is_maybe_committed());
}

/// This is an opt-in failure test because it requires a configured FoundationDB cluster that has
/// already lost coordinator quorum. The deployment qualification wrapper provides that topology.
#[tokio::test]
async fn foundationdb_quorum_loss_has_bounded_transaction_latency() {
	if std::env::var("RIVET_TEST_FDB_UNAVAILABLE").as_deref() != Ok("1") {
		return;
	}

	let cluster_file = std::env::var_os("FDB_CLUSTER_FILE").map(Into::into);
	let driver =
		universaldb::driver::FoundationDbDatabaseDriver::new(FoundationDbConfig { cluster_file })
			.unwrap();
	let db = Database::new(Arc::new(driver));
	db.txn_retry_limit(1).unwrap();

	let key = format!("rivet/test/fdb-unavailable/{}", Uuid::new_v4());
	let deadline = TXN_TIMEOUT + Duration::from_secs(5);
	let started = std::time::Instant::now();
	let result = tokio::time::timeout(
		deadline,
		db.txn("foundationdb_quorum_loss", |tx| {
			let key = key.clone();
			async move {
				tx.set(key.as_bytes(), b"must-not-ack-without-quorum");
				Ok(())
			}
		}),
	)
	.await
	.expect("FoundationDB transaction exceeded the configured timeout plus grace");

	assert!(
		result.is_err(),
		"FoundationDB transaction unexpectedly committed without coordinator quorum"
	);
	assert!(started.elapsed() <= deadline);
}
