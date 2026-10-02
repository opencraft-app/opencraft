use rivet_metrics::{BUCKETS, MICRO_BUCKETS, REGISTRY, prometheus::*};

lazy_static::lazy_static! {
	pub static ref WORKER_LAST_PING: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"gasoline_worker_last_ping",
		"Last ping of a worker as a unix ts.",
		&["worker_id"],
		*REGISTRY
	).unwrap();
	pub static ref WORKER_LAST_METRICS_PUBLISH: IntGauge = register_int_gauge_with_registry!(
		"gasoline_worker_last_metrics_publish",
		"Last timestamp of metrics publish.",
		*REGISTRY
	).unwrap();
	pub static ref WORKER_BUMPS_PER_TICK: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_worker_bumps_per_tick",
		"Amount of bump messages received in a single worker tick.",
		&["worker_id"],
		vec![1.0, 2.0, 3.0, 4.0, 8.0, 16.0, 32.0, 64.0, 128.0, 256.0, 512.0, 1024.0],
		*REGISTRY
	).unwrap();
	pub static ref WORKER_IMMEDIATE_REPULL_TOTAL: IntCounter = register_int_counter_with_registry!(
		"gasoline_worker_immediate_repull_total",
		"Number of saturated bounded workflow pulls followed immediately instead of waiting for a bump or poll.",
		*REGISTRY
	).unwrap();
	pub static ref WORKER_ADMISSION_SATURATED_TOTAL: IntCounter = register_int_counter_with_registry!(
		"gasoline_worker_admission_saturated_total",
		"Worker ticks which left durable work unleased because the process-local workflow limit was full.",
		*REGISTRY
	).unwrap();
	pub static ref WORKER_WORKFLOW_IN_FLIGHT: IntGauge = register_int_gauge_with_registry!(
		"gasoline_worker_workflow_in_flight",
		"Workflow executions currently held by this Gasoline worker process.",
		*REGISTRY
	).unwrap();
	pub static ref WORKER_WORKFLOW_LIMIT: IntGauge = register_int_gauge_with_registry!(
		"gasoline_worker_workflow_limit",
		"Hard process-local ordinary plus reserved workflow execution limit configured for this Gasoline worker.",
		*REGISTRY
	).unwrap();
	pub static ref WORKER_RESERVED_WORKFLOW_IN_FLIGHT: IntGauge = register_int_gauge_with_registry!(
		"gasoline_worker_reserved_workflow_in_flight",
		"Reserved control-workflow executions currently held by this Gasoline worker process.",
		*REGISTRY
	).unwrap();
	pub static ref WORKER_RESERVED_WORKFLOW_LIMIT: IntGauge = register_int_gauge_with_registry!(
		"gasoline_worker_reserved_workflow_limit",
		"Additional process-local execution slots reserved exclusively for configured control workflows.",
		*REGISTRY
	).unwrap();
	pub static ref WORKER_SECONDARY_FALLBACK_TOTAL: IntCounter = register_int_counter_with_registry!(
		"gasoline_worker_secondary_fallback_total",
		"Workflows leased by a backup owner after the configured primary-owner grace period.",
		*REGISTRY
	).unwrap();
	pub static ref PRUNER_HISTORY_PRUNED_TOTAL: IntCounter = register_int_counter_with_registry!(
		"gasoline_pruner_history_pruned_total",
		"Completed workflow histories removed by the indexed Gasoline pruner.",
		*REGISTRY
	).unwrap();
	pub static ref PRUNER_TERMINAL_PRUNED_TOTAL: IntCounter = register_int_counter_with_registry!(
		"gasoline_pruner_terminal_pruned_total",
		"Terminal workflows removed by the indexed Gasoline pruner.",
		*REGISTRY
	).unwrap();
	pub static ref PRUNER_LAST_SUCCESS_SECONDS: IntGauge = register_int_gauge_with_registry!(
		"gasoline_pruner_last_success_seconds",
		"Unix timestamp of the most recent successful bounded prune chunk.",
		*REGISTRY
	).unwrap();
	pub static ref PRUNER_LAST_HISTORY_PRUNED: IntGauge = register_int_gauge_with_registry!(
		"gasoline_pruner_last_history_pruned",
		"Completed workflow histories removed by the most recent successful bounded prune chunk.",
		*REGISTRY
	).unwrap();
	pub static ref PRUNER_LAST_TERMINAL_PRUNED: IntGauge = register_int_gauge_with_registry!(
		"gasoline_pruner_last_terminal_pruned",
		"Terminal workflows removed by the most recent successful bounded prune chunk.",
		*REGISTRY
	).unwrap();
	pub static ref LAST_PULL_WORKFLOWS_DURATION: GaugeVec = register_gauge_vec_with_registry!(
		"gasoline_last_pull_workflows_duration",
		"Last duration of pulling workflow data.",
		&["worker_id"],
		*REGISTRY
	).unwrap();
	pub static ref LAST_PULL_WORKFLOWS_HISTORY_DURATION: GaugeVec = register_gauge_vec_with_registry!(
		"gasoline_last_pull_workflows_history_duration",
		"Last duration of pulling workflow histories.",
		&["worker_id"],
		*REGISTRY
	).unwrap();
	pub static ref LAST_PULL_WORKFLOWS_FULL_DURATION: GaugeVec = register_gauge_vec_with_registry!(
		"gasoline_last_pull_workflows_full_duration",
		"Last duration of pulling workflow data and history.",
		&["worker_id"],
		*REGISTRY
	).unwrap();
	pub static ref PULL_WORKFLOWS_DURATION: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_pull_workflows_duration",
		"Duration of pulling workflow data.",
		&["worker_id"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();
	pub static ref PULL_WORKFLOWS_HISTORY_DURATION: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_pull_workflows_history_duration",
		"Duration of pulling workflow histories.",
		&["worker_id"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();
	pub static ref PULL_WORKFLOWS_FULL_DURATION: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_pull_workflows_full_duration",
		"Duration of pulling workflow data and history.",
		&["worker_id"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();
	pub static ref WORKER_WORKFLOW_ACTIVE: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"gasoline_worker_workflow_active",
		"Total active workflows in memory for the given worker.",
		&["worker_id", "workflow_name"],
		*REGISTRY
	).unwrap();

	pub static ref FIND_WORKFLOWS_DURATION: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_find_workflows_duration",
		"Duration to find a workflow with a given name and tags.",
		&["workflow_name"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();

	pub static ref FIND_WORKFLOWS_BATCH_DURATION: Histogram = register_histogram_with_registry!(
		"gasoline_find_workflows_batch_duration",
		"Duration to find workflows.",
		*REGISTRY
	).unwrap();

	pub static ref WORKFLOW_TOTAL: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"gasoline_workflow_total",
		"Total workflows.",
		&["workflow_name"],
		*REGISTRY
	).unwrap();
	pub static ref WORKFLOW_ACTIVE: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"gasoline_workflow_active",
		"Total active workflows.",
		&["workflow_name"],
		*REGISTRY
	).unwrap();
	pub static ref WORKFLOW_DEAD: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"gasoline_workflow_dead",
		"Total dead workflows.",
		&["workflow_name", "error"],
		*REGISTRY
	).unwrap();
	pub static ref WORKFLOW_SLEEPING: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"gasoline_workflow_sleeping",
		"Total sleeping workflows.",
		&["workflow_name"],
		*REGISTRY
	).unwrap();
	pub static ref WORKFLOW_ERRORS: IntCounterVec = register_int_counter_vec_with_registry!(
		"gasoline_workflow_errors",
		"All errors made in a workflow.",
		&["workflow_name", "error"],
		*REGISTRY
	).unwrap();
	pub static ref WORKFLOW_WAKE_DELTA_DURATION: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_workflow_wake_delta_duration",
		"Duration from wake condition insertion to pull.",
		&["workflow_name"],
		MICRO_BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();
	pub static ref WORKFLOW_LEASED: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_workflow_leased",
		"Amount of workflows leased per pull.",
		&["workflow_name"],
		vec![1.0, 2.0, 3.0, 4.0, 8.0, 16.0, 30.0, 60.0, 125.0, 250.0, 500.0, 1000.0],
		*REGISTRY
	).unwrap();

	pub static ref COMPLETE_WORKFLOW_DURATION: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_complete_workflow_duration",
		"Duration to complete a workflow with a given name.",
		&["workflow_name"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();
	pub static ref COMMIT_WORKFLOW_DURATION: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_commit_workflow_duration",
		"Duration to commit a workflow with a given name.",
		&["workflow_name"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();

	pub static ref ACTIVITY_DURATION: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_activity_duration",
		"Total duration of an activity.",
		&["workflow_name", "activity_name", "error"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();
	pub static ref ACTIVITY_ERRORS: IntCounterVec = register_int_counter_vec_with_registry!(
		"gasoline_activity_errors",
		"All errors made in an activity.",
		&["workflow_name", "activity_name", "error"],
		*REGISTRY
	).unwrap();

	pub static ref SIGNAL_PENDING: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"gasoline_signal_pending",
		"Total pending signals.",
		&["signal_name"],
		*REGISTRY
	).unwrap();
	pub static ref SIGNAL_RECV_LAG: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_signal_recv_lag",
		"Time between the publish timestamp and the timestamp the signal was received.",
		&["workflow_name", "signal_name"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();
	pub static ref SIGNAL_PUBLISHED: IntCounterVec = register_int_counter_vec_with_registry!(
		"gasoline_signal_published",
		"Total published signals.",
		&["workflow_name", "signal_name"],
		*REGISTRY
	).unwrap();
	pub static ref SIGNAL_SEND_DURATION: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_signal_send_duration",
		"Total duration of a signal send.",
		&["workflow_name", "signal_name"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();
	pub static ref SIGNAL_SEND_DURATION_SECONDS: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_signal_send_duration_seconds",
		"Duration of the database write performed by a signal send. Fire-and-forget bump publish time is not included.",
		&["workflow_name", "signal_name"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();
	pub static ref SIGNAL_WAKEUP_TO_PULL_SECONDS: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_signal_wakeup_to_pull_seconds",
		"Duration from a workflow signal wakeup to the next database pull attempt. Non-zero values under load indicate tokio scheduling pressure on the workflow task.",
		&["workflow_name"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();
	pub static ref SIGNAL_DB_PULL_SECONDS: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_signal_db_pull_seconds",
		"Duration of pulling pending workflow signals from the database.",
		&["workflow_name"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();

	pub static ref MESSAGE_PUBLISHED: IntCounterVec = register_int_counter_vec_with_registry!(
		"gasoline_message_published",
		"Total published messages.",
		&["workflow_name", "message_name"],
		*REGISTRY
	).unwrap();
	pub static ref MESSAGE_SEND_DURATION: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_message_send_duration",
		"Total duration of a message send.",
		&["workflow_name", "message_name"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();

	pub static ref WORKFLOW_DISPATCHED: IntCounterVec = register_int_counter_vec_with_registry!(
		"gasoline_workflow_dispatched",
		"Total dispatched workflows.",
		&["workflow_name", "sub_workflow_name"],
		*REGISTRY
	).unwrap();
	pub static ref WORKFLOW_DISPATCH_DURATION: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_workflow_dispatch_duration",
		"Total duration of a workflow dispatch.",
		&["workflow_name", "sub_workflow_name"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();

	pub static ref LOOP_COMMIT_DURATION: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_loop_commit_duration",
		"Total duration of a single loop commit.",
		&["workflow_name"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();

	pub static ref LOOP_ITERATION_DURATION: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_loop_iteration_duration",
		"Total duration of a single loop iteration.",
		&["workflow_name"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();

	// MARK: Ops
	pub static ref OPERATION_PENDING: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"gasoline_operation_pending",
		"Total number of operation calls in progress.",
		&["operation_name"],
		*REGISTRY
	).unwrap();
	pub static ref OPERATION_TOTAL: IntCounterVec = register_int_counter_vec_with_registry!(
		"gasoline_operation_total",
		"Total number of operation calls.",
		&["operation_name"],
		*REGISTRY
	).unwrap();
	pub static ref OPERATION_DURATION: HistogramVec = register_histogram_vec_with_registry!(
		"gasoline_operation_duration",
		"Total duration of an op call.",
		&["operation_name", "error"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();
	pub static ref OPERATION_ERRORS: IntCounterVec = register_int_counter_vec_with_registry!(
		"gasoline_operation_errors",
		"All errors made by this operation.",
		&["operation_name", "error"],
		*REGISTRY
	).unwrap();

	// MARK: Load Shedding
	pub static ref CPU_USAGE: Histogram = register_histogram_with_registry!(
		"gasoline_cpu_usage",
		"CPU usage (1 per core).",
		vec![0.1, 0.25, 0.5, 1.0, 1.5, 2.0, 4.0, 8.0, 16.0],
		*REGISTRY
	).unwrap();
	pub static ref CPU_USAGE_SMOOTHED: Histogram = register_histogram_with_registry!(
		"gasoline_cpu_usage_smoothed",
		"CPU usage (1 per core) after being smoothed by EMA.",
		vec![0.1, 0.25, 0.5, 1.0, 1.5, 2.0, 4.0, 8.0, 16.0],
		*REGISTRY
	).unwrap();
	pub static ref LOAD_SHEDDING_RATIO: Histogram = register_histogram_with_registry!(
		"gasoline_load_shedding_ratio",
		"Load shedding ratio (0-1) based on CPU usage, determining the fraction of workflows to pull.",
		vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
		*REGISTRY
	).unwrap();

	pub static ref DB_INSTANCE: IntGauge = register_int_gauge_with_registry!(
		"gasoline_db_instance_count",
		"Amount of DB instances currently active.",
		*REGISTRY
	).unwrap();
}

/// Registers the bounded-pruner metric family without claiming that a prune
/// chunk has completed. Every Engine process calls this during bootstrap so
/// metric absence means an old binary or a broken scrape path; the zero-valued
/// last-success gauge continues to mean that this process has not observed a
/// successful chunk yet.
pub fn register_pruner_metrics() {
	let _ = &*PRUNER_HISTORY_PRUNED_TOTAL;
	let _ = &*PRUNER_TERMINAL_PRUNED_TOTAL;
	let _ = &*PRUNER_LAST_SUCCESS_SECONDS;
	let _ = &*PRUNER_LAST_HISTORY_PRUNED;
	let _ = &*PRUNER_LAST_TERMINAL_PRUNED;
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn registers_pruner_metric_family_eagerly() {
		register_pruner_metrics();
		let names = REGISTRY
			.gather()
			.into_iter()
			.map(|family| family.name().to_owned())
			.collect::<std::collections::HashSet<_>>();

		for name in [
			"rivet_gasoline_pruner_history_pruned_total",
			"rivet_gasoline_pruner_terminal_pruned_total",
			"rivet_gasoline_pruner_last_success_seconds",
			"rivet_gasoline_pruner_last_history_pruned",
			"rivet_gasoline_pruner_last_terminal_pruned",
		] {
			assert!(names.contains(name), "missing eager metric family: {name}");
		}
	}
}
