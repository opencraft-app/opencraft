//! Bounded, process-local admission for Depot FDB/COS activities.
//!
//! Execution slots and FIFO wait slots are independent of Gasoline's workflow limit. Overflow
//! remains durable workflow work, not a failed execution or an unbounded collection of leases.

use std::{
	sync::Arc,
	time::{Duration, Instant},
};

use anyhow::{Result, ensure};
use gas::{activity::ActivityAdmission, ctx::ActivityCtx};
use scc::HashMap;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, TryAcquireError};

use crate::metrics;

const MAX_WAIT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug)]
pub(crate) enum ActivityClass {
	ManagerRefresh,
	Compaction,
}

impl ActivityClass {
	fn label(self) -> &'static str {
		match self {
			Self::ManagerRefresh => "manager_refresh",
			Self::Compaction => "compaction",
		}
	}
}

lazy_static::lazy_static! {
	static ref MANAGER_REFRESH_POOLS: HashMap<usize, Arc<AdmissionPool>> = HashMap::default();
	static ref COMPACTION_POOLS: HashMap<usize, Arc<AdmissionPool>> = HashMap::default();
}

struct AdmissionPool {
	execution: Arc<Semaphore>,
	waiting: Arc<Semaphore>,
}

impl AdmissionPool {
	fn new(limit: usize) -> Self {
		Self {
			execution: Arc::new(Semaphore::new(limit)),
			waiting: Arc::new(Semaphore::new(limit.saturating_mul(8).clamp(8, 64))),
		}
	}

	async fn acquire(
		&self,
		class: ActivityClass,
		max_wait: Duration,
	) -> Result<Option<ActivityPermit>> {
		let permit = match self.execution.clone().try_acquire_owned() {
			Ok(permit) => permit,
			Err(TryAcquireError::Closed) => anyhow::bail!("Depot admission semaphore closed"),
			Err(TryAcquireError::NoPermits) => {
				let _wait_slot = match self.waiting.clone().try_acquire_owned() {
					Ok(slot) => slot,
					Err(TryAcquireError::NoPermits) => return Ok(None),
					Err(TryAcquireError::Closed) => anyhow::bail!("Depot admission queue closed"),
				};
				metrics::SQLITE_ACTIVITY_ADMISSION_WAITERS
					.with_label_values(&[class.label()])
					.inc();
				let _waiting = WaitingActivity {
					class,
					started: Instant::now(),
				};
				match tokio::time::timeout(max_wait, self.execution.clone().acquire_owned()).await {
					Ok(permit) => permit?,
					Err(_) => return Ok(None),
				}
			}
		};
		metrics::SQLITE_ACTIVITY_ADMISSION_INFLIGHT
			.with_label_values(&[class.label()])
			.inc();
		Ok(Some(ActivityPermit {
			class,
			_permit: permit,
		}))
	}
}

pub(crate) struct ActivityPermit {
	class: ActivityClass,
	_permit: OwnedSemaphorePermit,
}

struct WaitingActivity {
	class: ActivityClass,
	started: Instant,
}

impl Drop for WaitingActivity {
	fn drop(&mut self) {
		metrics::SQLITE_ACTIVITY_ADMISSION_WAITERS
			.with_label_values(&[self.class.label()])
			.dec();
		metrics::SQLITE_ACTIVITY_ADMISSION_WAIT_SECONDS
			.with_label_values(&[self.class.label()])
			.observe(self.started.elapsed().as_secs_f64());
	}
}

impl Drop for ActivityPermit {
	fn drop(&mut self) {
		metrics::SQLITE_ACTIVITY_ADMISSION_INFLIGHT
			.with_label_values(&[self.class.label()])
			.dec();
	}
}

async fn admit<T>(
	ctx: &ActivityCtx,
	class: ActivityClass,
	limit: usize,
) -> Result<ActivityAdmission<T>> {
	ensure!(
		limit > 0 && limit <= Semaphore::MAX_PERMITS,
		"invalid Depot admission limit"
	);
	let pools = match class {
		ActivityClass::ManagerRefresh => &*MANAGER_REFRESH_POOLS,
		ActivityClass::Compaction => &*COMPACTION_POOLS,
	};
	let pool = pools
		.entry_sync(limit)
		.or_insert_with(|| Arc::new(AdmissionPool::new(limit)))
		.get()
		.clone();
	metrics::SQLITE_ACTIVITY_ADMISSION_LIMIT
		.with_label_values(&[class.label()])
		.set(i64::try_from(limit).unwrap_or(i64::MAX));
	match pool.acquire(class, MAX_WAIT).await? {
		Some(permit) => Ok(ActivityAdmission::Ready(Box::new(permit))),
		None => {
			// Spread durable wakeups without introducing a per-second retry storm. This is a process
			// capacity delay, not a changed job identity, storage fence, or execution-failure count.
			Ok(ActivityAdmission::deferred(ctx.workflow_id()))
		}
	}
}

pub(crate) async fn manager_refresh<T>(ctx: &ActivityCtx) -> Result<ActivityAdmission<T>> {
	admit(
		ctx,
		ActivityClass::ManagerRefresh,
		ctx.config().runtime.depot_manager_refresh_max_concurrency(),
	)
	.await
}

pub(crate) async fn compaction<T>(ctx: &ActivityCtx) -> Result<ActivityAdmission<T>> {
	admit(
		ctx,
		ActivityClass::Compaction,
		ctx.config().runtime.depot_compaction_max_concurrency(),
	)
	.await
}

#[cfg(test)]
#[path = "../tests/unit/activity_admission.rs"]
mod tests;
