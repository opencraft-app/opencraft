//! Metrics definitions shared by depot runtime components.

use std::time::Instant;

use rivet_metrics::{BUCKETS, REGISTRY, prometheus::*};

use crate::compaction::CompactionJobStatus;

lazy_static::lazy_static! {
	pub static ref SQLITE_COMPACTION_JOBS_TOTAL: IntCounterVec = register_int_counter_vec_with_registry!(
		"sqlite_compaction_jobs_total",
		"Observed Depot compaction activity exits by domain result, not durable publication counts.",
		&["operation", "result"],
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_COMPACTION_OBJECTS_TOTAL: IntCounterVec = register_int_counter_vec_with_registry!(
		"sqlite_compaction_objects_total",
		"Objects successfully uploaded, published, or reclaimed by Depot compaction activities.",
		&["operation"],
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_COMPACTION_BYTES_TOTAL: IntCounterVec = register_int_counter_vec_with_registry!(
		"sqlite_compaction_bytes_total",
		"Logical bytes successfully uploaded, published, or reclaimed by Depot compaction activities.",
		&["operation"],
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_COMPACTION_DURATION: HistogramVec = register_histogram_vec_with_registry!(
		"sqlite_compaction_duration_seconds",
		"Execution duration of Depot hot stage, hot install, cold upload, cold publish, and FDB reclaim attempts.",
		&["operation", "result"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_COMPACTION_PHASE_DURATION: HistogramVec = register_histogram_vec_with_registry!(
		"sqlite_compaction_phase_duration_seconds",
		"Duration of bounded Depot compaction phases used to locate cold-tier bottlenecks.",
		&["operation", "phase", "result"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_COMPACTION_BACKLOG_OBJECTS: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"sqlite_compaction_backlog_objects",
		"Objects in currently executing Depot compaction activity batches.",
		&["operation"],
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_COMPACTION_BACKLOG_BYTES: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"sqlite_compaction_backlog_bytes",
		"Bytes in currently executing Depot compaction activity batches.",
		&["operation"],
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_ACTIVITY_ADMISSION_LIMIT: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"sqlite_activity_admission_limit",
		"Configured process-local concurrency limit for each Depot activity class.",
		&["class"],
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_ACTIVITY_ADMISSION_INFLIGHT: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"sqlite_activity_admission_inflight",
		"Depot activities currently executing in each process-local admission class.",
		&["class"],
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_ACTIVITY_ADMISSION_WAITERS: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"sqlite_activity_admission_waiters",
		"Depot activities waiting for a process-local admission permit.",
		&["class"],
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_ACTIVITY_ADMISSION_WAIT_SECONDS: HistogramVec = register_histogram_vec_with_registry!(
		"sqlite_activity_admission_wait_seconds",
		"Time Depot activities spend waiting for process-local admission.",
		&["class"],
		BUCKETS.to_vec(),
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_WRITE_DEBT_BACKPRESSURE_TOTAL: IntCounter = register_int_counter_with_registry!(
		"sqlite_write_debt_backpressure_total",
		"SQLite commits rejected at the transient FDB write-debt safety boundary.",
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_COLD_STORAGE_ACCOUNTING_BYTES: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"sqlite_cold_storage_accounting_bytes",
		"Durable Cell-wide logical bytes in each cold-storage accounting class. FDB values are logical payload bytes, not provider billing bytes.",
		&["class"],
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_COLD_STORAGE_ACCOUNTING_OBJECTS: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"sqlite_cold_storage_accounting_objects",
		"Durable Cell-wide object counts in each cold-storage accounting class.",
		&["class"],
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_COLD_DELETE_ATTEMPTS_TOTAL: IntCounterVec = register_int_counter_vec_with_registry!(
		"sqlite_cold_delete_attempts_total",
		"Exact-key cold object delete attempts by terminal or retryable result.",
		&["result"],
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_COLD_DELETE_LAST_PROGRESS_SECONDS: Gauge = register_gauge_with_registry!(
		"sqlite_cold_delete_last_progress_seconds",
		"Unix timestamp of the last successful exact-key cold object deletion.",
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_COLD_INVENTORY_BYTES: IntGauge = register_int_gauge_with_registry!(
		"sqlite_cold_inventory_bytes",
		"Physical bytes observed by the latest bounded whole-bucket inventory audit.",
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_COLD_INVENTORY_OBJECTS: IntGauge = register_int_gauge_with_registry!(
		"sqlite_cold_inventory_objects",
		"Physical objects observed by the latest bounded whole-bucket inventory audit.",
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_COLD_INVENTORY_PROBLEMS: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"sqlite_cold_inventory_problem_objects",
		"Objects whose physical inventory does not agree with a safe FDB ownership state.",
		&["kind"],
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_COLD_INVENTORY_AUDIT_COMPLETE: IntGauge = register_int_gauge_with_registry!(
		"sqlite_cold_inventory_audit_complete",
		"Whether the latest bounded inventory audit reached the end of the bucket.",
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_COLD_INVENTORY_LAST_SUCCESS_SECONDS: Gauge = register_gauge_with_registry!(
		"sqlite_cold_inventory_last_success_seconds",
		"Unix timestamp of the latest complete cold inventory audit.",
		*REGISTRY
	).unwrap();

	pub static ref SQLITE_COLD_GC_POLICY: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"sqlite_cold_gc_policy",
		"Durable ColdGcPolicy state sampled from FDB.",
		&["state"],
		*REGISTRY
	).unwrap();
}

/// Registers the fixed operation/phase series at zero during Engine startup.
/// This is observability initialization only; it does not schedule compaction.
pub fn initialize_cold_tier_metrics() {
	let _ = &*SQLITE_WRITE_DEBT_BACKPRESSURE_TOTAL;
	for class in ["manager_refresh", "compaction"] {
		SQLITE_ACTIVITY_ADMISSION_LIMIT
			.with_label_values(&[class])
			.set(0);
		SQLITE_ACTIVITY_ADMISSION_INFLIGHT
			.with_label_values(&[class])
			.set(0);
		SQLITE_ACTIVITY_ADMISSION_WAITERS
			.with_label_values(&[class])
			.set(0);
		let _ = SQLITE_ACTIVITY_ADMISSION_WAIT_SECONDS.with_label_values(&[class]);
	}
	SQLITE_COLD_DELETE_LAST_PROGRESS_SECONDS.set(0.0);
	SQLITE_COLD_INVENTORY_BYTES.set(0);
	SQLITE_COLD_INVENTORY_OBJECTS.set(0);
	SQLITE_COLD_INVENTORY_AUDIT_COMPLETE.set(0);
	SQLITE_COLD_INVENTORY_LAST_SUCCESS_SECONDS.set(0.0);
	for kind in ["unknown", "deleted_but_present", "size_mismatch"] {
		SQLITE_COLD_INVENTORY_PROBLEMS
			.with_label_values(&[kind])
			.set(0);
	}
	for state in ["enabled", "dry_run"] {
		SQLITE_COLD_GC_POLICY.with_label_values(&[state]).set(0);
	}
	for result in ["succeeded", "retryable", "failed"] {
		let _ = SQLITE_COLD_DELETE_ATTEMPTS_TOTAL.with_label_values(&[result]);
	}
	for class in [
		"live",
		"retired",
		"delete_issued",
		"orphan",
		"deleted_total",
		"fdb_authoritative",
		"fdb_cache",
		"fdb_metadata",
	] {
		SQLITE_COLD_STORAGE_ACCOUNTING_BYTES
			.with_label_values(&[class])
			.set(0);
	}
	for class in [
		"live",
		"retired",
		"delete_issued",
		"orphan",
		"deleted_total",
	] {
		SQLITE_COLD_STORAGE_ACCOUNTING_OBJECTS
			.with_label_values(&[class])
			.set(0);
	}
	for operation in ["cold_upload", "cold_publish", "reclaim_fdb"] {
		SQLITE_COMPACTION_BACKLOG_OBJECTS
			.with_label_values(&[operation])
			.set(0);
		SQLITE_COMPACTION_BACKLOG_BYTES
			.with_label_values(&[operation])
			.set(0);
		let _ = SQLITE_COMPACTION_OBJECTS_TOTAL.with_label_values(&[operation]);
		let _ = SQLITE_COMPACTION_BYTES_TOTAL.with_label_values(&[operation]);
		let _ = SQLITE_COMPACTION_JOBS_TOTAL.with_label_values(&[operation, "succeeded"]);
		let _ = SQLITE_COMPACTION_DURATION.with_label_values(&[operation, "succeeded"]);
	}
	for (operation, phase) in [
		("cold_upload", "prepare_fdb"),
		("cold_upload", "put_objects"),
		("cold_upload", "stage_refs_fdb"),
		("cold_publish", "read_staged_refs_fdb"),
		("cold_publish", "verify_objects"),
		("cold_publish", "publish_marker_fdb"),
		("reclaim_fdb", "preflight_objects"),
		("reclaim_fdb", "delete_fdb"),
	] {
		let _ =
			SQLITE_COMPACTION_PHASE_DURATION.with_label_values(&[operation, phase, "succeeded"]);
	}
}

pub fn set_cold_gc_policy(policy: crate::cold_tier::ColdGcPolicy) {
	SQLITE_COLD_GC_POLICY
		.with_label_values(&["enabled"])
		.set(i64::from(policy.spec.deletion_enabled));
	SQLITE_COLD_GC_POLICY
		.with_label_values(&["dry_run"])
		.set(i64::from(policy.spec.dry_run));
}

pub fn set_cold_inventory_audit_state(state: &crate::cold_tier::ColdInventoryAuditState) {
	set_cold_inventory_audit_values(&state.summary);
	if let Some(last_complete_at_ms) = state.last_complete_at_ms {
		SQLITE_COLD_INVENTORY_LAST_SUCCESS_SECONDS.set(last_complete_at_ms as f64 / 1_000.0);
	}
}

fn set_cold_inventory_audit_values(summary: &crate::cold_tier::ColdInventoryAuditSummary) {
	SQLITE_COLD_INVENTORY_BYTES.set(i64::try_from(summary.physical_bytes).unwrap_or(i64::MAX));
	SQLITE_COLD_INVENTORY_OBJECTS.set(i64::try_from(summary.physical_objects).unwrap_or(i64::MAX));
	for (kind, value) in [
		("unknown", summary.unknown_objects),
		("deleted_but_present", summary.deleted_but_present_objects),
		("size_mismatch", summary.size_mismatch_objects),
	] {
		SQLITE_COLD_INVENTORY_PROBLEMS
			.with_label_values(&[kind])
			.set(i64::try_from(value).unwrap_or(i64::MAX));
	}
	SQLITE_COLD_INVENTORY_AUDIT_COMPLETE.set(i64::from(summary.complete));
}

pub fn observe_cold_delete_result(result: &'static str) {
	SQLITE_COLD_DELETE_ATTEMPTS_TOTAL
		.with_label_values(&[result])
		.inc();
	if result == "succeeded" {
		SQLITE_COLD_DELETE_LAST_PROGRESS_SECONDS.set(
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap_or_default()
				.as_secs_f64(),
		);
	}
}

pub fn set_cold_storage_accounting(
	accounting: crate::cold_tier::accounting::ColdStorageAccounting,
) {
	for (class, value) in [
		("live", accounting.live_bytes),
		("retired", accounting.retired_bytes),
		("delete_issued", accounting.delete_issued_bytes),
		("orphan", accounting.orphan_bytes),
		("deleted_total", accounting.deleted_bytes_total),
		("fdb_authoritative", accounting.fdb_authoritative_bytes),
		("fdb_cache", accounting.fdb_cache_bytes),
		("fdb_metadata", accounting.fdb_metadata_bytes),
	] {
		SQLITE_COLD_STORAGE_ACCOUNTING_BYTES
			.with_label_values(&[class])
			.set(value);
	}
	for (class, value) in [
		("live", accounting.live_objects),
		("retired", accounting.retired_objects),
		("delete_issued", accounting.delete_issued_objects),
		("orphan", accounting.orphan_objects),
		("deleted_total", accounting.deleted_objects_total),
	] {
		SQLITE_COLD_STORAGE_ACCOUNTING_OBJECTS
			.with_label_values(&[class])
			.set(value);
	}
}

#[cfg(debug_assertions)]
lazy_static::lazy_static! {
	pub static ref SQLITE_TAKEOVER_INVARIANT_VIOLATION_TOTAL: IntCounterVec = register_int_counter_vec_with_registry!(
		"sqlite_takeover_invariant_violation_total",
		"Total debug sqlite takeover invariant violations.",
		&["node_id", "kind"],
		*REGISTRY
	).unwrap();
}

pub struct CompactionActivityGuard {
	operation: &'static str,
	objects: i64,
	bytes: i64,
	started: Instant,
	finished: bool,
}

impl CompactionActivityGuard {
	pub fn new(operation: &'static str, objects: usize, bytes: u64) -> Self {
		let objects = i64::try_from(objects).unwrap_or(i64::MAX);
		let bytes = i64::try_from(bytes).unwrap_or(i64::MAX);
		SQLITE_COMPACTION_BACKLOG_OBJECTS
			.with_label_values(&[operation])
			.add(objects);
		SQLITE_COMPACTION_BACKLOG_BYTES
			.with_label_values(&[operation])
			.add(bytes);
		Self {
			operation,
			objects,
			bytes,
			started: Instant::now(),
			finished: false,
		}
	}

	pub fn finish(mut self, result: &'static str, completed_objects: u64, completed_bytes: u64) {
		self.record_result(result);
		self.finished = true;
		if result == "succeeded" {
			SQLITE_COMPACTION_OBJECTS_TOTAL
				.with_label_values(&[self.operation])
				.inc_by(completed_objects);
			SQLITE_COMPACTION_BYTES_TOTAL
				.with_label_values(&[self.operation])
				.inc_by(completed_bytes);
		}
	}

	fn record_result(&self, result: &'static str) {
		SQLITE_COMPACTION_JOBS_TOTAL
			.with_label_values(&[self.operation, result])
			.inc();
		SQLITE_COMPACTION_DURATION
			.with_label_values(&[self.operation, result])
			.observe(self.started.elapsed().as_secs_f64());
	}
}

impl Drop for CompactionActivityGuard {
	fn drop(&mut self) {
		if !self.finished {
			self.record_result("cancelled");
		}
		SQLITE_COMPACTION_BACKLOG_OBJECTS
			.with_label_values(&[self.operation])
			.sub(self.objects);
		SQLITE_COMPACTION_BACKLOG_BYTES
			.with_label_values(&[self.operation])
			.sub(self.bytes);
	}
}

pub fn observe_compaction_phase(
	operation: &'static str,
	phase: &'static str,
	started: Instant,
	result: &'static str,
) {
	SQLITE_COMPACTION_PHASE_DURATION
		.with_label_values(&[operation, phase, result])
		.observe(started.elapsed().as_secs_f64());
}

pub fn compaction_status_label(status: &CompactionJobStatus) -> &'static str {
	match status {
		CompactionJobStatus::Requested => "requested",
		CompactionJobStatus::Succeeded => "succeeded",
		CompactionJobStatus::Retryable { .. } => "retryable",
		CompactionJobStatus::Rejected { .. } => "rejected",
		CompactionJobStatus::Failed { .. } => "failed",
	}
}
