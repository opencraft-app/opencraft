use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use rand::Rng;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const RETRY_INITIAL_BACKOFF: Duration = Duration::from_millis(25);
const RETRY_MAX_BACKOFF: Duration = Duration::from_secs(1);

/// Atomically account for a bounded enqueue. Incrementing before `try_send` prevents a fast
/// receiver from completing and decrementing the item before the producer records it.
pub(crate) fn try_enqueue<T>(
	tx: &mpsc::Sender<T>,
	pending: &AtomicUsize,
	item: T,
) -> Result<(), mpsc::error::TrySendError<T>> {
	pending.fetch_add(1, Ordering::Release);
	match tx.try_send(item) {
		Ok(()) => Ok(()),
		Err(err) => {
			pending.fetch_sub(1, Ordering::AcqRel);
			Err(err)
		}
	}
}

/// Retry an ambiguously delivered operation until it succeeds or its owning connection is
/// cancelled. The callback keeps observability outside this transport-neutral control loop.
pub(crate) async fn retry_until_cancelled<F, Fut, E, OnError>(
	cancellation_token: &CancellationToken,
	mut operation: F,
	mut on_error: OnError,
) -> bool
where
	F: FnMut() -> Fut,
	Fut: Future<Output = Result<(), E>>,
	OnError: FnMut(&E, Duration),
{
	let mut backoff = RETRY_INITIAL_BACKOFF;
	loop {
		let result = tokio::select! {
			_ = cancellation_token.cancelled() => return false,
			result = operation() => result,
		};
		match result {
			Ok(()) => return true,
			Err(err) => on_error(&err, backoff),
		}

		// Add bounded jitter so a Cell-wide FDB interruption does not synchronize every Actor
		// dispatcher into a retry wave against the recovering cluster.
		let jitter =
			Duration::from_millis(rand::thread_rng().gen_range(0..=backoff.as_millis() as u64 / 4));
		tokio::select! {
			_ = cancellation_token.cancelled() => return false,
			_ = tokio::time::sleep(backoff + jitter) => {}
		}
		backoff = (backoff * 2).min(RETRY_MAX_BACKOFF);
	}
}
