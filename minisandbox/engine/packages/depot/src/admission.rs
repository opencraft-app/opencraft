//! Process-local admission for Depot FDB/COS activities.
//!
//! Gasoline workflow cardinality is not a resource proxy: a dormant database manager is cheap,
//! while one compaction activity can execute many FDB transactions or object requests. Keep the
//! latency-sensitive manager refresh lane independent from background compaction and bound the
//! actual expensive work here.

use std::{collections::HashMap, sync::Arc, time::Instant};

use anyhow::{Result, anyhow};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::metrics;

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
	static ref MANAGER_REFRESH_POOLS: parking_lot::Mutex<HashMap<usize, Arc<Semaphore>>> =
		parking_lot::Mutex::new(HashMap::new());
	static ref COMPACTION_POOLS: parking_lot::Mutex<HashMap<usize, Arc<Semaphore>>> =
		parking_lot::Mutex::new(HashMap::new());
}

pub(crate) struct ActivityPermit {
	class: ActivityClass,
	_permit: OwnedSemaphorePermit,
}

struct WaitingActivity {
	class: ActivityClass,
}

impl Drop for WaitingActivity {
	fn drop(&mut self) {
		metrics::SQLITE_ACTIVITY_ADMISSION_WAITERS
			.with_label_values(&[self.class.label()])
			.dec();
	}
}

impl Drop for ActivityPermit {
	fn drop(&mut self) {
		metrics::SQLITE_ACTIVITY_ADMISSION_INFLIGHT
			.with_label_values(&[self.class.label()])
			.dec();
	}
}

pub(crate) async fn acquire(class: ActivityClass, limit: usize) -> Result<ActivityPermit> {
	let pool = match class {
		ActivityClass::ManagerRefresh => MANAGER_REFRESH_POOLS
			.lock()
			.entry(limit)
			.or_insert_with(|| Arc::new(Semaphore::new(limit)))
			.clone(),
		ActivityClass::Compaction => COMPACTION_POOLS
			.lock()
			.entry(limit)
			.or_insert_with(|| Arc::new(Semaphore::new(limit)))
			.clone(),
	};
	let label = class.label();
	metrics::SQLITE_ACTIVITY_ADMISSION_LIMIT
		.with_label_values(&[label])
		.set(i64::try_from(limit).unwrap_or(i64::MAX));
	metrics::SQLITE_ACTIVITY_ADMISSION_WAITERS
		.with_label_values(&[label])
		.inc();
	let waiting = WaitingActivity { class };
	let started = Instant::now();
	let permit = pool
		.acquire_owned()
		.await
		.map_err(|_| anyhow!("Depot {label} admission semaphore closed"));
	drop(waiting);
	metrics::SQLITE_ACTIVITY_ADMISSION_WAIT_SECONDS
		.with_label_values(&[label])
		.observe(started.elapsed().as_secs_f64());
	let permit = permit?;
	metrics::SQLITE_ACTIVITY_ADMISSION_INFLIGHT
		.with_label_values(&[label])
		.inc();
	Ok(ActivityPermit {
		class,
		_permit: permit,
	})
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use super::*;

	#[tokio::test]
	async fn activity_class_enforces_its_exact_limit() {
		let permits = futures_util::future::try_join_all(
			(0..37).map(|_| acquire(ActivityClass::Compaction, 37)),
		)
		.await
		.unwrap();
		assert!(
			tokio::time::timeout(
				Duration::from_millis(10),
				acquire(ActivityClass::Compaction, 37),
			)
			.await
			.is_err()
		);
		assert_eq!(
			metrics::SQLITE_ACTIVITY_ADMISSION_WAITERS
				.with_label_values(&[ActivityClass::Compaction.label()])
				.get(),
			0,
			"cancelled admission wait must not leak the waiter gauge"
		);
		drop(permits);
		let second = tokio::time::timeout(
			Duration::from_secs(1),
			acquire(ActivityClass::Compaction, 37),
		)
		.await
		.expect("released permit should unblock the next activity")
		.unwrap();
		drop(second);
	}

	#[tokio::test]
	async fn manager_refresh_and_compaction_do_not_share_capacity() {
		let compaction = acquire(ActivityClass::Compaction, 41).await.unwrap();
		let refresh = tokio::time::timeout(
			Duration::from_secs(1),
			acquire(ActivityClass::ManagerRefresh, 41),
		)
		.await
		.expect("refresh lane must not wait behind compaction")
		.unwrap();
		drop((refresh, compaction));
	}
}
