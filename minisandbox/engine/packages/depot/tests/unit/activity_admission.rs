use futures_util::{FutureExt, poll};

use super::*;

#[tokio::test]
async fn queue_overflow_is_immediate_and_wait_slots_are_bounded() -> Result<()> {
	let pool = AdmissionPool::new(1);
	let permit = pool
		.acquire(ActivityClass::Compaction, MAX_WAIT)
		.await?
		.unwrap();
	let mut waits = (0..8)
		.map(|_| Box::pin(pool.acquire(ActivityClass::Compaction, MAX_WAIT)))
		.collect::<Vec<_>>();
	for waiting in &mut waits {
		assert!(poll!(waiting.as_mut()).is_pending());
	}
	assert_eq!(pool.waiting.available_permits(), 0);
	for _ in 0..10_000 {
		assert!(
			pool.acquire(ActivityClass::Compaction, MAX_WAIT)
				.now_or_never()
				.expect("overflow must never wait")?
				.is_none()
		);
	}
	drop(waits);
	assert_eq!(
		pool.waiting.available_permits(),
		8,
		"cancelled wait slots return"
	);
	drop(permit);
	assert_eq!(pool.execution.available_permits(), 1);
	Ok(())
}

#[tokio::test]
async fn accepted_waiters_are_fifo_and_cancellation_releases_capacity() -> Result<()> {
	let pool = AdmissionPool::new(1);
	let permit = pool
		.acquire(ActivityClass::Compaction, MAX_WAIT)
		.await?
		.unwrap();
	let mut first = Box::pin(pool.acquire(ActivityClass::Compaction, MAX_WAIT));
	let mut second = Box::pin(pool.acquire(ActivityClass::Compaction, MAX_WAIT));
	assert!(poll!(first.as_mut()).is_pending());
	assert!(poll!(second.as_mut()).is_pending());
	drop(permit);
	assert!(
		poll!(second.as_mut()).is_pending(),
		"a later waiter cannot bypass the first"
	);
	let first_permit = first.await?.unwrap();
	assert!(poll!(second.as_mut()).is_pending());
	drop(second);
	drop(first_permit);
	assert_eq!(pool.waiting.available_permits(), 8);
	assert_eq!(pool.execution.available_permits(), 1);
	Ok(())
}

#[tokio::test]
async fn expired_queue_wait_defers_without_leaking_capacity() -> Result<()> {
	let pool = AdmissionPool::new(1);
	let permit = pool
		.acquire(ActivityClass::Compaction, MAX_WAIT)
		.await?
		.unwrap();
	assert!(
		pool.acquire(ActivityClass::Compaction, Duration::ZERO)
			.await?
			.is_none()
	);
	assert_eq!(pool.waiting.available_permits(), 8);
	drop(permit);
	assert!(
		pool.acquire(ActivityClass::Compaction, MAX_WAIT)
			.await?
			.is_some()
	);
	Ok(())
}

#[tokio::test]
async fn manager_and_compaction_lanes_do_not_share_capacity() -> Result<()> {
	let compaction = AdmissionPool::new(1);
	let manager = AdmissionPool::new(1);
	let permit = compaction
		.acquire(ActivityClass::Compaction, MAX_WAIT)
		.await?
		.unwrap();
	assert!(
		manager
			.acquire(ActivityClass::ManagerRefresh, MAX_WAIT)
			.now_or_never()
			.expect("independent manager admission")?
			.is_some()
	);
	drop(permit);
	Ok(())
}
