use std::{
	collections::HashMap,
	time::{Duration, Instant},
};

use anyhow::{Context, Result};
use futures_util::{StreamExt, stream::FuturesUnordered};
use opentelemetry::trace::TraceContextExt;
use rivet_runtime::TermSignal;
use rivet_util::Id;
use tokio::{sync::watch, task::JoinHandle};
use tracing::Instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;

use crate::{
	ctx::WorkflowCtx,
	db::{BumpSubSubject, DatabaseHandle},
	error::WorkflowError,
	metrics,
	registry::RegistryHandle,
};

/// How often to run gc and update ping.
pub(crate) const PING_INTERVAL: Duration = Duration::from_secs(10);
/// How often to publish metrics.
const METRICS_INTERVAL: Duration = Duration::from_secs(20);
// How long the pull workflows function can take before shutting down the runtime.
const PULL_WORKFLOWS_TIMEOUT: Duration = Duration::from_secs(10);
const SHUTDOWN_PROGRESS_INTERVAL: Duration = Duration::from_secs(7);
const SATURATED_REPULL_DELAY: Duration = Duration::from_millis(10);

/// Used to spawn a new thread that indefinitely polls the database for new workflows. Only pulls workflows
/// that are registered in its registry. After pulling, the workflows are ran and their state is written to
/// the database.
pub struct Worker {
	worker_id: Id,
	version: i64,

	registry: RegistryHandle,
	db: DatabaseHandle,

	config: rivet_config::Config,
	pools: rivet_pools::Pools,

	running_workflows: HashMap<Id, WorkflowHandle>,
}

impl Worker {
	pub fn new(
		registry: RegistryHandle,
		db: DatabaseHandle,
		config: rivet_config::Config,
		pools: rivet_pools::Pools,
	) -> Self {
		Worker {
			worker_id: Id::new_v1(config.dc_label()),
			version: chrono::DateTime::parse_from_rfc3339(rivet_util::build_meta::BUILD_TIMESTAMP)
				.map(|x| x.timestamp_millis())
				.unwrap_or_default(),

			registry,
			db,

			config,
			pools,

			running_workflows: HashMap::new(),
		}
	}

	/// Polls the database periodically or wakes immediately when `Database::bump_sub` finishes.
	/// Provide a shutdown_rx to allow shutting down without triggering SIGTERM.
	#[tracing::instrument(skip_all, fields(worker_id=%self.worker_id))]
	pub async fn start(mut self, mut shutdown_rx: Option<watch::Receiver<()>>) -> Result<()> {
		tracing::debug!(
			registered_workflows = ?self.registry.size(),
			"started worker",
		);

		let cache = rivet_cache::CacheInner::from_env(&self.config, self.pools.clone())?;

		// We use ready_chunks because multiple bumps in a row should be processed as 1 bump
		let mut bump_sub = self
			.db
			.bump_sub(BumpSubSubject::Worker)
			.await?
			.ready_chunks(1024);

		let mut tick_interval = tokio::time::interval(self.db.worker_poll_interval());
		tick_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

		let mut term_signal = TermSignal::get();
		let mut repull_immediately = false;

		// Update ping at least once before doing anything else
		self.db
			.update_worker_ping(self.worker_id, self.version, true)
			.await
			.context("failed updating worker ping")?;

		// Create handles for bg tasks
		let mut gc_handle = self.gc();
		let mut metrics_handle = self.publish_metrics();

		let res = loop {
			let shutdown_fut = async {
				if let Some(shutdown_rx) = &mut shutdown_rx {
					shutdown_rx.changed().await
				} else {
					std::future::pending().await
				}
			};

			tokio::select! {
				_ = tokio::task::yield_now(), if repull_immediately => {},
				_ = tick_interval.tick() => {},
				res = bump_sub.next() => {
					match res {
						Some(bumps) => {
							// TODO: Temporarily don't record worker id to reduce metrics cardinality
							// let worker_id_str = self.worker_id.to_string();
							let worker_id_str = "worker".to_string();
							metrics::WORKER_BUMPS_PER_TICK
								.with_label_values(&[worker_id_str.as_str()])
								.observe(bumps.len() as f64);
						}
						None => break Err(WorkflowError::SubscriptionUnsubscribed.into()),
					}

					tick_interval.reset();
				},

				res = &mut gc_handle => {
					tracing::error!(?res, "metrics task unexpectedly stopped");
					break Ok(());
				}
				res = &mut metrics_handle => {
					tracing::error!(?res, "metrics task unexpectedly stopped");
					break Ok(());
				},
				res = shutdown_fut => {
					if res.is_err() {
						tracing::debug!("shutdown channel dropped, ignoring");
						shutdown_rx = None;
					} else {
						break Ok(());
					}
				}
				_ = term_signal.recv() => break Ok(()),
			}

			repull_immediately = match self.tick(&cache).await {
				Ok(has_more) => has_more,
				Err(err) => break Err(err),
			};
			if repull_immediately {
				metrics::WORKER_IMMEDIATE_REPULL_TOTAL.inc();
			}
		};

		// Cancel background tasks
		metrics_handle.abort();
		gc_handle.abort();

		if let Err(err) = &res {
			tracing::error!(?err, "worker errored, attempting graceful shutdown");
		}

		self.shutdown(term_signal).await;

		res
	}

	/// Query the database for new workflows and run them.
	#[tracing::instrument(skip_all)]
	async fn tick(&mut self, cache: &rivet_cache::Cache) -> Result<bool> {
		// Finished workflows no longer consume a local execution slot. Do this before pulling so a
		// burst of durable wakeups cannot stack another full batch on top of slow in-flight work.
		self.running_workflows
			.retain(|_, wf| !wf.handle.is_finished());
		let max_active = self.config.runtime.gasoline_worker_max_active_workflows();
		let reserved_slots = self
			.config
			.runtime
			.gasoline_worker_reserved_workflow_slots();
		let reserved_names = self
			.config
			.runtime
			.gasoline_worker_reserved_workflow_names();
		let reserved_running = self
			.running_workflows
			.values()
			.filter(|workflow| reserved_names.binary_search(&workflow.name).is_ok())
			.count();
		metrics::WORKER_WORKFLOW_LIMIT
			.set(i64::try_from(max_active.saturating_add(reserved_slots)).unwrap_or(i64::MAX));
		metrics::WORKER_WORKFLOW_IN_FLIGHT
			.set(i64::try_from(self.running_workflows.len()).unwrap_or(i64::MAX));
		metrics::WORKER_RESERVED_WORKFLOW_LIMIT
			.set(i64::try_from(reserved_slots).unwrap_or(i64::MAX));
		metrics::WORKER_RESERVED_WORKFLOW_IN_FLIGHT
			.set(i64::try_from(reserved_running).unwrap_or(i64::MAX));
		let admission = workflow_admission_plan(
			max_active,
			self.running_workflows.len(),
			reserved_slots,
			reserved_running,
		);
		let available = admission.available;
		if available == 0 {
			// Keep draining the durable queue promptly without spinning or acquiring leases which this
			// process cannot execute yet. Workflow ownership remains in FDB until a slot is available.
			metrics::WORKER_ADMISSION_SATURATED_TOTAL.inc();
			tokio::time::sleep(SATURATED_REPULL_DELAY).await;
			return Ok(true);
		}

		// Create filter from registered workflow names
		let filter = if admission.reserved_only {
			reserved_names
				.iter()
				.filter(|name| self.registry.workflows.contains_key(name.as_str()))
				.map(String::as_str)
				.collect::<Vec<_>>()
		} else {
			self.registry
				.workflows
				.keys()
				.map(|name| name.as_str())
				.collect::<Vec<_>>()
		};

		// Query awake workflows
		let pulled = tokio::time::timeout(
			PULL_WORKFLOWS_TIMEOUT,
			self.db
				.pull_workflows(self.worker_id, self.version, &filter, available),
		)
		.await
		.context("took too long pulling workflows, worker cannot continue")??;

		for workflow in pulled.workflows {
			let workflow_id = workflow.workflow_id;

			if let Some(previous) = self.running_workflows.remove(&workflow_id) {
				await_committed_predecessor(workflow_id, previous).await;
			}

			let (stop_tx, stop_rx) = watch::channel(());
			let name = workflow.workflow_name.clone();

			let ctx = WorkflowCtx::new(
				self.registry.clone(),
				self.db.clone(),
				self.config.clone(),
				self.pools.clone(),
				cache.clone(),
				workflow,
				stop_rx,
			)?;

			let current_span_ctx = tracing::Span::current()
				.context()
				.span()
				.span_context()
				.clone();

			let handle = tokio::spawn(
				// NOTE: No .in_current_span() because we want this to be a separate trace
				async move {
					if let Err(err) = ctx.run(current_span_ctx).await {
						tracing::error!(?err, ?workflow_id, "unhandled workflow error");
					}
				},
			);

			self.running_workflows.insert(
				workflow_id,
				WorkflowHandle {
					name,
					stop: stop_tx,
					handle,
				},
			);
		}
		metrics::WORKER_WORKFLOW_IN_FLIGHT
			.set(i64::try_from(self.running_workflows.len()).unwrap_or(i64::MAX));

		// TODO: Temporarily don't record worker id to reduce metrics cardinality
		// let worker_id_str = self.worker_id.to_string();
		let worker_id_str = "worker".to_string();

		metrics::WORKER_WORKFLOW_ACTIVE.reset();
		for (_, wf) in &self.running_workflows {
			metrics::WORKER_WORKFLOW_ACTIVE
				.with_label_values(&[worker_id_str.as_str(), wf.name.as_str()])
				.inc();
		}

		Ok(pulled.has_more)
	}

	fn gc(&self) -> JoinHandle<()> {
		let db = self.db.clone();
		let worker_id = self.worker_id;
		let version = self.version;

		tokio::spawn(
			async move {
				let mut ping_interval = tokio::time::interval(PING_INTERVAL);
				ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

				loop {
					ping_interval.tick().await;

					if let Err(err) = db.update_worker_ping(worker_id, version, true).await {
						tracing::error!(?err, "unhandled update ping error");
					}

					if let Err(err) = db.clear_expired_leases(worker_id).await {
						tracing::error!(?err, "unhandled gc error");
					}
				}
			}
			.instrument(tracing::info_span!("worker_gc_task")),
		)
	}

	fn publish_metrics(&self) -> JoinHandle<()> {
		let db = self.db.clone();
		let worker_id = self.worker_id;

		tokio::spawn(
			async move {
				let mut metrics_interval = tokio::time::interval(METRICS_INTERVAL);
				metrics_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

				loop {
					metrics_interval.tick().await;

					if let Err(err) = db.publish_metrics(worker_id).await {
						tracing::error!(?err, "unhandled metrics error");
					}
				}
			}
			.instrument(tracing::info_span!("worker_metrics_task")),
		)
	}

	fn shutdown_ping(&self) -> JoinHandle<()> {
		let db = self.db.clone();
		let worker_id = self.worker_id;
		let version = self.version;

		tokio::spawn(
			async move {
				let mut ping_interval = tokio::time::interval(PING_INTERVAL);
				ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

				loop {
					ping_interval.tick().await;

					if let Err(err) = db.update_worker_ping(worker_id, version, false).await {
						tracing::error!(?err, "unhandled update ping error");
					}
				}
			}
			.instrument(tracing::info_span!("worker_shutdown_ping_task")),
		)
	}

	#[tracing::instrument(skip_all)]
	async fn shutdown(mut self, mut term_signal: TermSignal) {
		let shutdown_duration = self.config.runtime.worker_shutdown_duration();

		// Spawn a special ping task to continue updating ping but not the active worker idx
		let ping_handle = self.shutdown_ping();

		tracing::info!(
			duration=?shutdown_duration,
			remaining_workflows=?self.running_workflows.len(),
			"starting worker shutdown"
		);

		if let Err(err) = self.db.mark_worker_inactive(self.worker_id).await {
			tracing::error!(?err, worker_id=?self.worker_id, "failed to mark worker as inactive");
		}

		// Send stop signal to all running workflows
		for (workflow_id, wf) in &self.running_workflows {
			if wf.stop.send(()).is_err() {
				tracing::debug!(
					?workflow_id,
					"stop channel closed, workflow likely already stopped"
				);
			}
		}

		// Collect all workflow tasks
		let mut wf_futs = self
			.running_workflows
			.iter_mut()
			.map(|(_, wf)| &mut wf.handle)
			.collect::<FuturesUnordered<_>>();

		let mut progress_interval = tokio::time::interval(SHUTDOWN_PROGRESS_INTERVAL);
		progress_interval.tick().await;

		let shutdown_start = Instant::now();
		loop {
			// Future will resolve once all workflow tasks complete
			let complete_fut = async { while let Some(_) = wf_futs.next().await {} };

			tokio::select! {
				_ = complete_fut => {
					break;
				}
				_ = progress_interval.tick() => {
					tracing::info!(remaining_workflows=%wf_futs.len(), "worker still shutting down");
				}
				abort = term_signal.recv() => {
					if abort {
						tracing::warn!("aborting worker shutdown");
						break;
					}
				}
				_ = tokio::time::sleep(shutdown_duration.saturating_sub(shutdown_start.elapsed())) => {
					tracing::warn!("worker shutdown timed out");
					break;
				}
			}
		}

		// Stop updating ping
		ping_handle.abort();

		metrics::WORKER_WORKFLOW_ACTIVE.reset();

		let remaining_workflows = wf_futs.into_iter().count();
		if remaining_workflows == 0 {
			tracing::info!("all workflows evicted");
		} else {
			tracing::warn!(?remaining_workflows, "not all workflows evicted");

			for (workflow_id, handle) in self.running_workflows.iter() {
				tracing::warn!(?workflow_id, name=?handle.name, "not evicted");
			}
		}

		tracing::info!("worker shutdown complete");
	}
}

#[derive(Debug, PartialEq, Eq)]
struct WorkflowAdmissionPlan {
	available: usize,
	reserved_only: bool,
}

fn workflow_admission_plan(
	max_active: usize,
	running: usize,
	reserved_slots: usize,
	reserved_running: usize,
) -> WorkflowAdmissionPlan {
	let ordinary_available = max_active.saturating_sub(running);
	if ordinary_available > 0 {
		return WorkflowAdmissionPlan {
			available: ordinary_available,
			reserved_only: false,
		};
	}

	WorkflowAdmissionPlan {
		available: reserved_slots.saturating_sub(reserved_running),
		reserved_only: true,
	}
}

#[cfg(test)]
mod tests {
	use std::sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	};

	use tokio::sync::{oneshot, watch};

	use super::{
		WorkflowAdmissionPlan, WorkflowHandle, await_committed_predecessor, workflow_admission_plan,
	};
	use rivet_util::Id;

	#[test]
	fn ordinary_workflow_slots_never_exceed_the_base_limit() {
		assert_eq!(
			workflow_admission_plan(64, 0, 1, 0),
			WorkflowAdmissionPlan {
				available: 64,
				reserved_only: false,
			}
		);
		assert_eq!(
			workflow_admission_plan(64, 17, 1, 0),
			WorkflowAdmissionPlan {
				available: 47,
				reserved_only: false,
			}
		);
	}

	#[test]
	fn saturated_ordinary_pool_can_only_use_the_reserved_lane() {
		assert_eq!(
			workflow_admission_plan(64, 64, 1, 0),
			WorkflowAdmissionPlan {
				available: 1,
				reserved_only: true,
			}
		);
		assert_eq!(
			workflow_admission_plan(64, 65, 1, 1),
			WorkflowAdmissionPlan {
				available: 0,
				reserved_only: true,
			}
		);
	}

	#[tokio::test]
	async fn acquired_successor_waits_for_committed_predecessor_instead_of_being_dropped() {
		let workflow_id = Id::new_v1(1);
		let (release_tx, release_rx) = oneshot::channel();
		let (stop, _) = watch::channel(());
		let previous = WorkflowHandle {
			name: "test".to_string(),
			stop,
			handle: tokio::spawn(async move {
				let _ = release_rx.await;
			}),
		};
		let successor_started = Arc::new(AtomicBool::new(false));
		let successor_started2 = successor_started.clone();
		let successor = tokio::spawn(async move {
			await_committed_predecessor(workflow_id, previous).await;
			successor_started2.store(true, Ordering::SeqCst);
		});

		tokio::task::yield_now().await;
		assert!(!successor_started.load(Ordering::SeqCst));
		release_tx.send(()).expect("predecessor should still exist");
		successor.await.expect("successor task should finish");
		assert!(successor_started.load(Ordering::SeqCst));
	}
}

struct WorkflowHandle {
	name: String,
	stop: watch::Sender<()>,
	handle: JoinHandle<()>,
}

/// A workflow commit clears its durable lease before the spawned task returns. A pull can therefore
/// acquire the workflow's next lease in the small window between those two events. Dropping the newly
/// pulled workflow would strand that lease on this otherwise healthy worker: the wake condition has
/// already been consumed and expired-worker cleanup will never release it.
///
/// The previous execution has necessarily released its lease before the pull could acquire the next
/// one, so only its local epilogue remains. Join it before installing the successor. This preserves
/// single execution while ensuring every acquired lease has an executor.
async fn await_committed_predecessor(workflow_id: Id, previous: WorkflowHandle) {
	tracing::debug!(?workflow_id, "waiting for committed workflow predecessor");
	if let Err(err) = previous.handle.await {
		tracing::error!(?err, ?workflow_id, "workflow predecessor task failed");
	}
}
