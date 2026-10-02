use std::{
	path::PathBuf,
	sync::{
		Arc, Mutex,
		atomic::{AtomicI32, Ordering},
	},
};

use anyhow::{Context, Result, anyhow, bail};
use foundationdb::{FdbError, api::NetworkAutoStop, options::DatabaseOption};

use crate::{
	RetryableTransaction, Transaction,
	driver::{BoxFut, DatabaseDriver, Erased},
	error::DatabaseError,
	transaction::TXN_TIMEOUT,
	utils::{MaybeCommitted, calculate_tx_retry_backoff},
};

use super::transaction::FoundationDbTransactionDriver;

const DEFAULT_MAX_RETRIES: i32 = 10;
// FoundationDB does not include `transaction_timed_out` in its retryable or maybe-committed error
// predicates, even though the API explicitly warns that a timeout raised during commit may have
// committed. UniversalDB must preserve that ambiguity for idempotent callers.
const TRANSACTION_TIMED_OUT_CODE: i32 = 1031;

/// FoundationDB's client network may be booted only once and cannot be restarted in a process.
/// Keep the guard in a static owner so dropping a pool does not stop the network underneath other
/// pools, and so later pools can reuse it (including pools connected to a different cluster file).
static PROCESS_NETWORK: Mutex<Option<Arc<NetworkAutoStop>>> = Mutex::new(None);

#[derive(Clone, Debug, Default)]
pub struct FoundationDbConfig {
	pub cluster_file: Option<PathBuf>,
}

pub struct FoundationDbDatabaseDriver {
	// Drop the database before the network guard. Transactions also retain the guard.
	database: Arc<foundationdb::Database>,
	network: Arc<NetworkAutoStop>,
	max_retries: AtomicI32,
}

impl FoundationDbDatabaseDriver {
	fn process_network() -> Result<Arc<NetworkAutoStop>> {
		let mut process_network = PROCESS_NETWORK
			.lock()
			.map_err(|_| anyhow!("FoundationDB process network lock was poisoned"))?;

		if let Some(network) = process_network.as_ref() {
			return Ok(network.clone());
		}

		let network_builder = foundationdb::api::FdbApiBuilder::default()
			.build()
			.context("failed to select FoundationDB API version")?;
		// SAFETY: The guard is retained by PROCESS_NETWORK for the process lifetime. Drivers and
		// transaction tasks additionally retain an Arc so their intended ownership is explicit.
		let network = Arc::new(
			unsafe { network_builder.boot() }.context("failed to start FoundationDB network")?,
		);
		*process_network = Some(network.clone());

		Ok(network)
	}

	/// Starts the process-wide FoundationDB network and connects to a cluster.
	///
	/// FoundationDB permits its client network to be started only once per process. All Rivet pools
	/// share that network while retaining independent database handles.
	pub fn new(config: FoundationDbConfig) -> Result<Self> {
		let cluster_file = config
			.cluster_file
			.as_deref()
			.map(|path| {
				path.to_str()
					.context("FoundationDB cluster file path is not valid UTF-8")
			})
			.transpose()?;

		let network = Self::process_network()?;
		let database = foundationdb::Database::new(cluster_file)
			.context("failed to open FoundationDB database")?;
		let transaction_timeout_ms = i32::try_from(TXN_TIMEOUT.as_millis())
			.context("UniversalDB transaction timeout does not fit in an i32")?;
		database
			.set_option(DatabaseOption::TransactionTimeout(transaction_timeout_ms))
			.context("failed to set FoundationDB transaction timeout")?;

		Ok(Self {
			database: Arc::new(database),
			network,
			max_retries: AtomicI32::new(DEFAULT_MAX_RETRIES),
		})
	}

	fn create_txn_internal(&self) -> Result<(Transaction, Arc<FoundationDbTransactionDriver>)> {
		let driver = Arc::new(FoundationDbTransactionDriver::new(
			self.database.clone(),
			self.network.clone(),
		)?);
		let tx = Transaction::new(driver.clone());
		Ok((tx, driver))
	}

	async fn prepare_retry(
		&self,
		driver: &FoundationDbTransactionDriver,
		error: FdbError,
	) -> Result<()> {
		driver
			.on_error(error)
			.await
			.context("FoundationDB rejected transaction retry")
	}
}

impl DatabaseDriver for FoundationDbDatabaseDriver {
	fn create_txn(&self) -> Result<Transaction> {
		self.create_txn_internal().map(|(tx, _)| tx)
	}

	fn run<'a>(
		&'a self,
		closure: Box<dyn Fn(RetryableTransaction) -> BoxFut<'a, Result<Erased>> + Send + Sync + 'a>,
	) -> BoxFut<'a, Result<Erased>> {
		Box::pin(async move {
			let mut maybe_committed = MaybeCommitted(false);
			let max_retries = self.max_retries.load(Ordering::SeqCst);
			let (tx, driver) = self.create_txn_internal()?;

			for attempt in 0..max_retries {
				let mut retryable = RetryableTransaction::new(tx.clone());
				retryable.maybe_committed = maybe_committed;

				let error =
					match tokio::time::timeout(TXN_TIMEOUT, closure(retryable.clone())).await {
						Ok(Ok(value)) => match retryable.inner.driver.commit_ref().await {
							Ok(()) => return Ok(value),
							Err(error) => error,
						},
						Ok(Err(error)) => error,
						Err(_) => anyhow!(DatabaseError::TransactionTooOld),
					};

				let fdb_error = {
					error
						.chain()
						.find_map(|source| source.downcast_ref::<FdbError>())
						.copied()
				};
				if let Some(fdb_error) = fdb_error {
					let transaction_timed_out = fdb_error.code() == TRANSACTION_TIMED_OUT_CODE;
					if fdb_error.is_maybe_committed() || transaction_timed_out {
						maybe_committed = MaybeCommitted(true);
					}
					if transaction_timed_out {
						driver.reset_for_retry().await?;
						continue;
					}

					if fdb_error.is_retryable() {
						self.prepare_retry(&driver, fdb_error).await?;
						continue;
					}
				}

				let is_retryable_database_error = {
					error
						.chain()
						.find_map(|source| source.downcast_ref::<DatabaseError>())
						.is_some_and(DatabaseError::is_retryable)
				};
				if is_retryable_database_error {
					driver.reset_for_retry().await?;
					let backoff_ms = calculate_tx_retry_backoff(attempt as usize);
					tokio::time::sleep(tokio::time::Duration::from_millis(backoff_ms)).await;
					continue;
				}

				return Err(error);
			}

			Err(DatabaseError::MaxRetriesReached.into())
		})
	}

	fn txn_retry_limit(&self, limit: i32) -> Result<()> {
		if limit <= 0 {
			bail!("FoundationDB transaction retry limit must be positive");
		}
		self.max_retries.store(limit, Ordering::SeqCst);
		Ok(())
	}
}
