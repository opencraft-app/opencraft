use std::{mem, time::Duration};

use uuid::Uuid;

const SENTRY_URL: &str = "https://7602663e43cb9dee8c42d1e5e70293f8@o4504307129188352.ingest.us.sentry.io/4509962797252608";
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Owns the Sentry initialization guard without ever blocking an unwind or an implicit drop.
///
/// Sentry's transport first applies its configured flush timeout, but then synchronously joins
/// its network thread during `ClientInitGuard::drop`. A stuck HTTP request can therefore make the
/// drop unbounded. Call [`TelemetryGuard::shutdown`] on the normal return path to drain it with an
/// explicit upper bound. On an abnormal return, leaking this process-lifetime guard is preferable
/// to hanging shutdown; the operating system reclaims it when the process exits.
pub struct TelemetryGuard(Option<sentry::ClientInitGuard>);

impl TelemetryGuard {
	pub async fn shutdown(mut self) {
		let Some(guard) = self.0.take() else {
			return;
		};

		if !drop_with_timeout(guard, SHUTDOWN_TIMEOUT).await {
			tracing::warn!(
				timeout_secs = SHUTDOWN_TIMEOUT.as_secs(),
				"timed out shutting down telemetry; abandoning the transport until process exit"
			);
		}
	}
}

impl Drop for TelemetryGuard {
	fn drop(&mut self) {
		if let Some(guard) = self.0.take() {
			mem::forget(guard);
		}
	}
}

async fn drop_with_timeout<T: Send + 'static>(value: T, timeout: Duration) -> bool {
	let drop_task = tokio::task::spawn_blocking(move || drop(value));
	matches!(tokio::time::timeout(timeout, drop_task).await, Ok(Ok(())))
}

// We use synchronous main for Sentry. Read more: https://docs.sentry.io/platforms/rust/#async-main-function
pub fn init(config: &rivet_config::Config) -> TelemetryGuard {
	if !config.telemetry.enabled {
		return TelemetryGuard(None);
	}

	let guard = sentry::init((
		SENTRY_URL,
		sentry::ClientOptions {
			release: sentry::release_name!(),
			..Default::default()
		},
	));

	sentry::configure_scope(|scope| {
		if let Ok(db) = serde_json::to_string(config.database()) {
			scope.set_tag("database", db);
		}
		if let Ok(ps) = serde_json::to_string(config.pubsub()) {
			scope.set_tag("pubsub", ps);
		}
		if let Ok(cache) = serde_json::to_string(config.cache()) {
			scope.set_tag("cache", cache);
		}
		if let Ok(topo) = serde_json::to_string(config.topology()) {
			scope.set_tag("topology", topo);
		}
	});

	TelemetryGuard(Some(guard))
}

pub fn capture_error(err: &anyhow::Error) -> Uuid {
	sentry::integrations::anyhow::capture_anyhow(err)
}

#[cfg(test)]
mod tests {
	use std::{
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
		},
		thread,
		time::{Duration, Instant},
	};

	use super::drop_with_timeout;

	struct SlowDrop {
		dropped: Arc<AtomicBool>,
	}

	impl Drop for SlowDrop {
		fn drop(&mut self) {
			thread::sleep(Duration::from_millis(250));
			self.dropped.store(true, Ordering::SeqCst);
		}
	}

	#[tokio::test]
	async fn slow_transport_drop_does_not_block_past_deadline() {
		let dropped = Arc::new(AtomicBool::new(false));
		let started = Instant::now();
		let completed = drop_with_timeout(
			SlowDrop {
				dropped: dropped.clone(),
			},
			Duration::from_millis(10),
		)
		.await;

		assert!(!completed, "slow drop should exceed its deadline");
		assert!(
			started.elapsed() < Duration::from_millis(200),
			"caller waited for the slow drop instead of observing the deadline"
		);
		assert!(
			!dropped.load(Ordering::SeqCst),
			"the slow drop unexpectedly completed before the deadline"
		);
	}

	#[tokio::test]
	async fn completed_transport_drop_is_reported() {
		assert!(drop_with_timeout((), Duration::from_secs(1)).await);
	}
}
