use std::{sync::Arc, time::Duration};

use futures_util::{TryStreamExt, stream};
use tokio::sync::{Mutex, Notify};

use super::{ColdTier, ColdTierResult, policy::ColdGcPolicySpec};

#[derive(Default)]
struct DeleteLimiterState {
	active: usize,
}

lazy_static::lazy_static! {
	static ref DELETE_LIMITER: DeleteLimiter = DeleteLimiter {
		state: Mutex::new(DeleteLimiterState::default()),
		notify: Notify::new(),
	};
}

struct DeleteLimiter {
	state: Mutex<DeleteLimiterState>,
	notify: Notify,
}

struct DeletePermit;

impl DeleteLimiter {
	async fn acquire(&'static self, limit: usize) -> DeletePermit {
		loop {
			let notified = self.notify.notified();
			{
				let mut state = self.state.lock().await;
				if state.active < limit {
					state.active += 1;
					return DeletePermit;
				}
			}
			notified.await;
		}
	}
}

impl Drop for DeletePermit {
	fn drop(&mut self) {
		let Ok(mut state) = DELETE_LIMITER.state.try_lock() else {
			// The mutex is held only for a few instructions. A spawned wake avoids making Drop async.
			tokio::spawn(async {
				let mut state = DELETE_LIMITER.state.lock().await;
				state.active = state.active.saturating_sub(1);
				DELETE_LIMITER.notify.notify_waiters();
			});
			return;
		};
		state.active = state.active.saturating_sub(1);
		DELETE_LIMITER.notify.notify_waiters();
	}
}

/// Deletes immutable exact keys with process-wide bounded concurrency and bounded exponential
/// retry. FDB state remains `DeleteIssued` until every key succeeds, so a crash or lost response
/// re-enters this function and repeats only idempotent exact-key DELETE operations.
pub(crate) async fn delete_objects_with_policy(
	cold_tier: Arc<dyn ColdTier>,
	object_keys: &[String],
	policy: &ColdGcPolicySpec,
) -> ColdTierResult<()> {
	let concurrency = usize::from(policy.max_delete_concurrency);
	stream::iter(
		object_keys
			.iter()
			.cloned()
			.map(Ok::<_, super::ColdTierError>),
	)
	.map_ok(|object_key| {
		let cold_tier = Arc::clone(&cold_tier);
		async move {
			let _permit = DELETE_LIMITER.acquire(concurrency).await;
			let mut backoff_ms = policy.retry_initial_backoff_ms;
			for attempt in 1..=policy.retry_max_attempts {
				match cold_tier
					.delete_objects(std::slice::from_ref(&object_key))
					.await
				{
					Ok(()) => {
						crate::metrics::observe_cold_delete_result("succeeded");
						return Ok(());
					}
					Err(_error) if attempt < policy.retry_max_attempts => {
						crate::metrics::observe_cold_delete_result("retryable");
						tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
						backoff_ms = backoff_ms
							.saturating_mul(2)
							.min(policy.retry_max_backoff_ms);
					}
					Err(error) => {
						crate::metrics::observe_cold_delete_result("failed");
						return Err(error);
					}
				}
			}
			unreachable!("validated retry attempts are positive")
		}
	})
	.try_buffer_unordered(concurrency)
	.try_collect::<Vec<_>>()
	.await
	.map(|_| ())
}

#[cfg(test)]
mod tests {
	use std::sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	};

	use async_trait::async_trait;

	use super::*;
	use crate::cold_tier::{
		ColdTierError, ColdTierInventoryPage, ColdTierObjectMetadata, FdbWriteDebtPolicy,
	};

	struct FlakyDeleteTier {
		failures_left: AtomicUsize,
		attempts: AtomicUsize,
	}

	#[async_trait]
	impl ColdTier for FlakyDeleteTier {
		fn fdb_write_debt_policy(&self) -> FdbWriteDebtPolicy {
			FdbWriteDebtPolicy::default()
		}

		async fn put_object(&self, _key: &str, _bytes: &[u8]) -> ColdTierResult<()> {
			unimplemented!()
		}

		async fn get_object(&self, _key: &str) -> ColdTierResult<Vec<u8>> {
			unimplemented!()
		}

		async fn head_object(&self, _key: &str) -> ColdTierResult<ColdTierObjectMetadata> {
			unimplemented!()
		}

		async fn delete_objects(&self, keys: &[String]) -> ColdTierResult<()> {
			assert_eq!(keys.len(), 1);
			self.attempts.fetch_add(1, Ordering::SeqCst);
			if self
				.failures_left
				.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
					left.checked_sub(1)
				})
				.is_ok()
			{
				return Err(ColdTierError::Backend {
					operation: "delete",
					key: keys[0].clone(),
					source: anyhow::anyhow!("injected 503"),
				});
			}
			Ok(())
		}

		async fn list_inventory_page(
			&self,
			_cursor: Option<&str>,
			_limit: u16,
		) -> ColdTierResult<ColdTierInventoryPage> {
			unimplemented!()
		}
	}

	#[tokio::test]
	async fn delete_retries_are_bounded_and_eventually_succeed() {
		let tier = Arc::new(FlakyDeleteTier {
			failures_left: AtomicUsize::new(2),
			attempts: AtomicUsize::new(0),
		});
		let policy = ColdGcPolicySpec {
			retry_max_attempts: 3,
			retry_initial_backoff_ms: 1,
			retry_max_backoff_ms: 2,
			..Default::default()
		};
		delete_objects_with_policy(tier.clone(), &["exact-key".to_string()], &policy)
			.await
			.unwrap();
		assert_eq!(tier.attempts.load(Ordering::SeqCst), 3);
	}

	#[tokio::test]
	async fn delete_stops_at_the_policy_retry_budget() {
		let tier = Arc::new(FlakyDeleteTier {
			failures_left: AtomicUsize::new(10),
			attempts: AtomicUsize::new(0),
		});
		let policy = ColdGcPolicySpec {
			retry_max_attempts: 2,
			retry_initial_backoff_ms: 1,
			retry_max_backoff_ms: 1,
			..Default::default()
		};
		assert!(
			delete_objects_with_policy(tier.clone(), &["exact-key".to_string()], &policy)
				.await
				.is_err()
		);
		assert_eq!(tier.attempts.load(Ordering::SeqCst), 2);
	}
}
