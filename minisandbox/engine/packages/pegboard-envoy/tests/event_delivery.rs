use std::future::pending as pending_future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[path = "../src/event_delivery.rs"]
mod event_delivery;

use event_delivery::{retry_until_cancelled, try_enqueue};

#[test]
fn bounded_queue_preserves_the_accepted_event_and_reports_pressure() {
	let (tx, mut rx) = mpsc::channel(1);
	let pending = AtomicUsize::new(0);

	try_enqueue(&tx, &pending, 1).expect("first event must be accepted");
	let err = try_enqueue(&tx, &pending, 2).expect_err("queue must be bounded");

	assert!(matches!(err, mpsc::error::TrySendError::Full(2)));
	assert_eq!(pending.load(Ordering::Acquire), 1);
	assert_eq!(rx.try_recv().expect("accepted event must remain queued"), 1);
}

#[tokio::test]
async fn transient_dispatch_failures_retry_the_same_batch() {
	let cancellation_token = CancellationToken::new();
	let attempts = AtomicUsize::new(0);
	let observed_errors = AtomicUsize::new(0);
	let delivered = retry_until_cancelled(
		&cancellation_token,
		|| async {
			if attempts.fetch_add(1, Ordering::SeqCst) < 2 {
				anyhow::bail!("transient dispatch failure");
			}
			Ok(())
		},
		|_, _| {
			observed_errors.fetch_add(1, Ordering::SeqCst);
		},
	)
	.await;

	assert!(delivered);
	assert_eq!(attempts.load(Ordering::SeqCst), 3);
	assert_eq!(observed_errors.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn cancellation_interrupts_a_stuck_dispatch_attempt() {
	let cancellation_token = CancellationToken::new();
	let cancel = cancellation_token.clone();
	tokio::spawn(async move {
		tokio::time::sleep(Duration::from_millis(10)).await;
		cancel.cancel();
	});

	let delivered = tokio::time::timeout(
		Duration::from_millis(100),
		retry_until_cancelled(
			&cancellation_token,
			|| pending_future::<anyhow::Result<()>>(),
			|_, _| {},
		),
	)
	.await
	.expect("cancellation must not hang shutdown");

	assert!(!delivered);
}
