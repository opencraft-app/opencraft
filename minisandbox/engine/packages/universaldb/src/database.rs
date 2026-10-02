use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use std::{
	future::Future,
	sync::atomic::{AtomicUsize, Ordering},
};

use anyhow::{Context, Result, anyhow};
use futures_util::FutureExt;
use rivet_metrics::prometheus::IntGauge;
use rivet_tracing_utils::CustomInstrumentExt;

use crate::{
	driver::{DatabaseDriverHandle, Erased},
	metrics,
	transaction::{RetryableTransaction, Transaction},
};

/// Returns the simulated latency duration read from UDB_SIMULATED_LATENCY_MS at startup.
fn simulated_latency() -> Option<Duration> {
	static LATENCY: OnceLock<Option<Duration>> = OnceLock::new();
	*LATENCY.get_or_init(|| {
		let ms: u64 = std::env::var("UDB_SIMULATED_LATENCY_MS")
			.ok()?
			.parse()
			.ok()?;
		if ms == 0 {
			return None;
		}
		tracing::debug!(latency_ms = ms, "udb simulated latency enabled");
		Some(Duration::from_millis(ms))
	})
}

#[derive(Clone)]
pub struct Database {
	driver: DatabaseDriverHandle,
	default_transaction_tag: Option<Arc<str>>,
}

/// Keeps the pending-transaction gauge balanced when the transaction future is cancelled.
///
/// Callers may drop `Database::txn()` at any await point (for example when an HTTP request is
/// cancelled). A decrement after the driver await therefore leaks the gauge. Owning the metric in
/// this guard makes cancellation and ordinary completion share the same cleanup path.
struct PendingTransactionGuard {
	gauge: IntGauge,
}

impl PendingTransactionGuard {
	fn new(name: &'static str) -> Self {
		let gauge = metrics::TRANSACTION_PENDING.with_label_values(&[name]);
		gauge.inc();
		Self { gauge }
	}
}

impl Drop for PendingTransactionGuard {
	fn drop(&mut self) {
		self.gauge.dec();
	}
}

impl Database {
	pub fn new(driver: DatabaseDriverHandle) -> Self {
		Database {
			driver,
			default_transaction_tag: None,
		}
	}

	/// Attaches one bounded deployment/Cell tag to every transaction in addition to operation tags.
	/// FoundationDB can then attribute and throttle a noisy Cell without changing key semantics.
	pub fn with_default_transaction_tag(mut self, tag: impl Into<Arc<str>>) -> Self {
		self.default_transaction_tag = Some(tag.into());
		self
	}

	/// Run a closure with automatic retry logic and a name.
	#[tracing::instrument(skip_all)]
	pub async fn txn<'a, F, Fut, T>(&'a self, name: &'static str, closure: F) -> Result<T>
	where
		F: Fn(RetryableTransaction) -> Fut + Send + Sync,
		Fut: Future<Output = Result<T>> + Send,
		T: Send + 'a + 'static,
	{
		if let Some(delay) = simulated_latency() {
			tokio::time::sleep(delay).await;
		}

		let start = Instant::now();
		let attempts = Arc::new(AtomicUsize::new(0));
		let attempts_for_run = attempts.clone();
		metrics::TRANSACTION_TOTAL.with_label_values(&[name]).inc();
		let _pending_transaction = PendingTransactionGuard::new(name);

		let closure = &closure;
		let default_transaction_tag = self.default_transaction_tag.clone();
		let res = self
			.driver
			.run(Box::new(move |tx| {
				attempts_for_run.fetch_add(1, Ordering::AcqRel);
				let tx = tx.with_name(name);
				let default_transaction_tag = default_transaction_tag.clone();
				async move {
					if let Some(tag) = default_transaction_tag {
						tx.tag(&tag)?;
					}
					closure(tx).await.map(|value| Box::new(value) as Erased)
				}
				.custom_instrument(tracing::info_span!("txn_attempt"))
				.boxed()
			}))
			.await
			.and_then(|res| {
				res.downcast::<T>()
					.map(|x| *x)
					.map_err(|_| anyhow!("failed to downcast `run` return type"))
			})
			.context("transaction failed");

		let final_attempts = attempts.load(Ordering::Acquire);
		let duration = start.elapsed();
		metrics::TRANSACTION_ATTEMPTS
			.with_label_values(&[name])
			.observe(final_attempts as f64);
		metrics::TRANSACTION_DURATION
			.with_label_values(&[name])
			.observe(duration.as_secs_f64());

		res
	}

	/// Creates a new txn instance.
	pub fn create_txn(&self) -> Result<Transaction> {
		let tx = self.driver.create_txn()?;
		if let Some(tag) = &self.default_transaction_tag {
			tx.tag(tag)?;
		}
		Ok(tx)
	}

	pub fn txn_retry_limit(&self, limit: i32) -> Result<()> {
		self.driver.txn_retry_limit(limit)
	}

	/// Create a consistent point-in-time snapshot of the database at the given path.
	pub fn checkpoint(&self, path: &Path) -> Result<()> {
		self.driver.checkpoint(path)
	}

	/// Gracefully release process-wide driver resources before shutdown.
	pub async fn shutdown(&self) {
		self.driver.shutdown().await;
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[tokio::test]
	async fn pending_transaction_gauge_is_released_after_cancellation() {
		const NAME: &str = "pending_transaction_gauge_is_released_after_cancellation";
		let gauge = metrics::TRANSACTION_PENDING.with_label_values(&[NAME]);
		let initial = gauge.get();
		let directory = tempfile::tempdir().unwrap();
		let driver = crate::driver::RocksDbDatabaseDriver::new(directory.path().to_path_buf())
			.await
			.unwrap();
		let db = Database::new(Arc::new(driver));
		let entered = Arc::new(tokio::sync::Notify::new());
		let task_db = db.clone();
		let task_entered = entered.clone();
		let task = tokio::spawn(async move {
			task_db
				.txn(NAME, move |_| {
					task_entered.notify_one();
					std::future::pending::<Result<()>>()
				})
				.await
		});
		tokio::time::timeout(Duration::from_secs(5), entered.notified())
			.await
			.unwrap();
		assert_eq!(gauge.get(), initial + 1);

		task.abort();
		assert!(task.await.unwrap_err().is_cancelled());
		assert_eq!(gauge.get(), initial);

		db.txn(NAME, |_| async { Ok(()) }).await.unwrap();
		assert_eq!(gauge.get(), initial);
		assert!(
			db.txn(NAME, |_| async { Err::<(), _>(anyhow!("test failure")) })
				.await
				.is_err()
		);
		assert_eq!(gauge.get(), initial);
	}
}
