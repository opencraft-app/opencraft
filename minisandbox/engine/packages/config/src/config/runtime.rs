use std::time::Duration;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Runtime {
	/// Stable Gasoline scheduling Cell shared by all Engine processes that may execute the same
	/// workflows. Distinct Cells sharing one database must use distinct values.
	gasoline_cell_namespace: Option<String>,
	/// Durable fallback poll interval for workflow wake conditions. Pubsub bumps are the fast path;
	/// this bounds wake latency when a best-effort bump races a workflow lease transition.
	gasoline_worker_poll_interval_ms: Option<u64>,
	/// Maximum workflows leased and materialized by one Gasoline pull. A bounded batch keeps FDB
	/// lease/history transactions short; a saturated pull is immediately continued by the worker.
	gasoline_worker_pull_batch_size: Option<usize>,
	/// Maximum workflow executions held concurrently by one Gasoline worker process. Work above
	/// this limit stays in the durable wake queue instead of amplifying a synchronized wakeup into
	/// unbounded process and FoundationDB concurrency.
	gasoline_worker_max_active_workflows: Option<usize>,
	/// Additional process-local slots which can only lease the named control workflows after the
	/// ordinary execution pool is full. This prevents user workflow pressure from starving bounded
	/// maintenance without reopening the ordinary admission limit.
	gasoline_worker_reserved_workflow_slots: Option<usize>,
	gasoline_worker_reserved_workflow_names: Option<Vec<String>>,
	/// Maximum concurrent Depot manager refresh activities per Engine process. Manager refresh is
	/// latency-sensitive for Actor readiness, but still performs bounded FDB reads and cleanup.
	depot_manager_refresh_max_concurrency: Option<usize>,
	/// Maximum concurrent Depot compaction/reclaim activities per Engine process. This is separate
	/// from workflow admission so dormant managers cannot consume the Actor readiness lane.
	depot_compaction_max_concurrency: Option<usize>,
	/// Time before the adjacent backup worker may compete for a workflow assigned to its primary
	/// owner. This keeps the healthy path single-owner while bounding failover under overload.
	gasoline_worker_secondary_grace_ms: Option<u64>,

	/// Adjusts worker curve around this value (in millecores, i.e. 1000 = 1 core). Is not a hard limit. When
	/// unset, uses /sys/fs/cgroup/cpu.max, and if that is unset uses total host cpu.
	pub worker_cpu_max: Option<usize>,
	/// Determine load shedding ratio based on linear mapping on cpu usage. We will gradually
	/// pull less workflows as the cpu usage increases. Units are in (permille overall cpu usage, permille)
	/// Default:
	///       |     .   .
	///  100% | _____   .
	///       |     .\  .
	/// % wfs |     . \ .
	///       |     .  \.
	///    5% |     .   \_____
	///       |_____.___.______
	///       0    70% 90%
	///         avg cpu usage
	worker_load_shedding_curve: Option<[(u64, u64); 2]>,
	/// Exponential moving average beta term. Defaults to 0.95.
	worker_load_shedding_beta: Option<f32>,
	/// Time (in seconds) to allow for the gasoline worker engine to stop gracefully after receiving SIGTERM.
	/// Defaults to 30 seconds.
	worker_shutdown_duration: Option<u32>,
	/// Time (in seconds) to allow for guard to wait for pending requests after receiving SIGTERM. Defaults
	/// to 10 minutes.
	guard_shutdown_duration: Option<u32>,
	/// Time (in seconds) after which the engine process will forcibly exit after receiving SIGTERM.
	/// Must be greater than or equal to both worker_shutdown_duration and guard_shutdown_duration.
	/// Defaults to 10 minutes.
	force_shutdown_duration: Option<u32>,
	/// Whether or not to allow running the engine when the previous version that was run is higher than
	/// the current version.
	allow_version_rollback: Option<bool>,
	/// Time (in seconds) after completion before considering a workflow eligible for pruning. Defaults to 7
	/// days. This is the terminal state/output retention window. Set to 0 to never prune terminal workflow data.
	gasoline_prune_eligibility_duration: Option<u64>,
	/// Time (in seconds) after completion before pruning replay history while retaining workflow
	/// state and output. Defaults to 15 minutes. Set to 0 to disable early history pruning.
	gasoline_history_prune_eligibility_duration: Option<u64>,
	/// Time (in seconds) to periodically check for workflows to prune. Defaults to 12 hours.
	gasoline_prune_interval_duration: Option<u64>,
}

impl Runtime {
	pub fn with_gasoline_cell_namespace(cell_namespace: String) -> Self {
		Self {
			gasoline_cell_namespace: Some(cell_namespace),
			..Default::default()
		}
	}

	pub fn gasoline_cell_namespace(&self) -> &str {
		self.gasoline_cell_namespace.as_deref().unwrap_or("local")
	}

	pub fn has_explicit_gasoline_cell_namespace(&self) -> bool {
		self.gasoline_cell_namespace.is_some()
	}

	pub fn gasoline_worker_poll_interval(&self) -> Duration {
		Duration::from_millis(self.gasoline_worker_poll_interval_ms.unwrap_or(16_000))
	}

	pub fn gasoline_worker_pull_batch_size(&self) -> usize {
		self.gasoline_worker_pull_batch_size.unwrap_or(256)
	}

	pub fn gasoline_worker_max_active_workflows(&self) -> usize {
		self.gasoline_worker_max_active_workflows.unwrap_or(256)
	}

	pub fn gasoline_worker_reserved_workflow_slots(&self) -> usize {
		self.gasoline_worker_reserved_workflow_slots.unwrap_or(0)
	}

	pub fn gasoline_worker_reserved_workflow_names(&self) -> &[String] {
		self.gasoline_worker_reserved_workflow_names
			.as_deref()
			.unwrap_or_default()
	}

	pub fn depot_manager_refresh_max_concurrency(&self) -> usize {
		self.depot_manager_refresh_max_concurrency.unwrap_or(8)
	}

	pub fn depot_compaction_max_concurrency(&self) -> usize {
		self.depot_compaction_max_concurrency.unwrap_or(2)
	}

	pub fn gasoline_worker_secondary_grace(&self) -> Duration {
		Duration::from_millis(self.gasoline_worker_secondary_grace_ms.unwrap_or(1_000))
	}

	pub fn validate(&self) -> anyhow::Result<()> {
		let cell_namespace = self.gasoline_cell_namespace();
		if cell_namespace.is_empty()
			|| cell_namespace.len() > 16
			|| !cell_namespace.bytes().enumerate().all(|(index, byte)| {
				byte.is_ascii_lowercase()
					|| byte.is_ascii_digit()
					|| (index > 0 && matches!(byte, b'-' | b'_'))
			}) {
			anyhow::bail!(
				"runtime.gasoline_cell_namespace must be 1-16 lowercase ASCII letters, digits, '-' or '_', and start with a letter or digit"
			);
		}
		if let Some(interval_ms) = self.gasoline_worker_poll_interval_ms
			&& !(100..=60_000).contains(&interval_ms)
		{
			anyhow::bail!("runtime.gasoline_worker_poll_interval_ms must be between 100 and 60000");
		}
		if let Some(batch_size) = self.gasoline_worker_pull_batch_size
			&& !(1..=1000).contains(&batch_size)
		{
			anyhow::bail!("runtime.gasoline_worker_pull_batch_size must be between 1 and 1000");
		}
		if let Some(max_active) = self.gasoline_worker_max_active_workflows
			&& !(1..=10_000).contains(&max_active)
		{
			anyhow::bail!(
				"runtime.gasoline_worker_max_active_workflows must be between 1 and 10000"
			);
		}
		let reserved_slots = self.gasoline_worker_reserved_workflow_slots();
		let reserved_names = self.gasoline_worker_reserved_workflow_names();
		if reserved_slots > 64 {
			anyhow::bail!("runtime.gasoline_worker_reserved_workflow_slots must not exceed 64");
		}
		if (reserved_slots == 0) != reserved_names.is_empty() {
			anyhow::bail!(
				"runtime gasoline reserved workflow slots and names must be configured together"
			);
		}
		for (name, value) in [
			(
				"runtime.depot_manager_refresh_max_concurrency",
				self.depot_manager_refresh_max_concurrency,
			),
			(
				"runtime.depot_compaction_max_concurrency",
				self.depot_compaction_max_concurrency,
			),
		] {
			if let Some(value) = value
				&& !(1..=4096).contains(&value)
			{
				anyhow::bail!("{name} must be between 1 and 4096");
			}
		}
		if reserved_names.len() > 64
			|| reserved_names.iter().any(|name| {
				name.is_empty()
					|| name.len() > 128
					|| !name.bytes().all(|byte| {
						byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
					})
			}) || reserved_names.windows(2).any(|pair| pair[0] >= pair[1])
		{
			anyhow::bail!(
				"runtime.gasoline_worker_reserved_workflow_names must be a sorted unique list of 1-128 lowercase ASCII letters, digits, or '_'"
			);
		}
		if let Some(grace_ms) = self.gasoline_worker_secondary_grace_ms
			&& grace_ms > 60_000
		{
			anyhow::bail!("runtime.gasoline_worker_secondary_grace_ms must not exceed 60000");
		}
		if let (Some(history), Some(terminal)) = (
			self.gasoline_history_prune_eligibility_duration(),
			self.gasoline_prune_eligibility_duration(),
		) && history > terminal
		{
			anyhow::bail!(
				"runtime.gasoline_history_prune_eligibility_duration must not exceed gasoline_prune_eligibility_duration"
			);
		}
		Ok(())
	}

	pub fn worker_load_shedding_curve(&self) -> [(u64, u64); 2] {
		self.worker_load_shedding_curve
			.unwrap_or([(700, 1000), (900, 50)])
	}

	pub fn worker_load_shedding_beta(&self) -> f32 {
		self.worker_load_shedding_beta.unwrap_or(0.95)
	}

	pub fn worker_shutdown_duration(&self) -> Duration {
		Duration::from_secs(self.worker_shutdown_duration.unwrap_or(30) as u64)
	}

	pub fn guard_shutdown_duration(&self) -> Duration {
		Duration::from_secs(self.guard_shutdown_duration.unwrap_or(10 * 60) as u64)
	}

	/// Returns the force shutdown duration, defaulting to 10 minutes.
	pub fn force_shutdown_duration(&self) -> Duration {
		Duration::from_secs(self.force_shutdown_duration.unwrap_or(10 * 60) as u64)
	}

	pub fn allow_version_rollback(&self) -> bool {
		self.allow_version_rollback.unwrap_or_default()
	}

	pub fn gasoline_prune_eligibility_duration(&self) -> Option<Duration> {
		if let Some(prune_eligibility_duration) = self.gasoline_prune_eligibility_duration {
			if prune_eligibility_duration == 0 {
				None
			} else {
				Some(Duration::from_secs(prune_eligibility_duration))
			}
		} else {
			Some(Duration::from_secs(60 * 60 * 24 * 7))
		}
	}

	pub fn gasoline_history_prune_eligibility_duration(&self) -> Option<Duration> {
		if let Some(duration) = self.gasoline_history_prune_eligibility_duration {
			(duration != 0).then(|| Duration::from_secs(duration))
		} else {
			Some(Duration::from_secs(15 * 60))
		}
	}

	pub fn gasoline_prune_interval_duration(&self) -> Duration {
		Duration::from_secs(
			self.gasoline_prune_interval_duration
				.unwrap_or(60 * 60 * 12),
		)
	}
}
