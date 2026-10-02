#[cfg(any(debug_assertions, feature = "test-faults"))]
use std::sync::Arc;

#[cfg(any(debug_assertions, feature = "test-faults"))]
use parking_lot::Mutex;
#[cfg(debug_assertions)]
use tokio::sync::Notify;

use super::*;

#[cfg(feature = "test-faults")]
use crate::fault::{
	BranchGcFaultPoint, ColdCompactionFaultPoint, DepotFaultContext, DepotFaultController,
	DepotFaultFired, DepotFaultPoint, HotCompactionFaultPoint, ReclaimFaultPoint,
};

#[cfg(debug_assertions)]
static PAUSE_AFTER_HOT_STAGE: Mutex<Option<(DatabaseBranchId, Arc<Notify>, Arc<Notify>)>> =
	Mutex::new(None);

#[cfg(debug_assertions)]
pub struct PauseGuard {
	slot: &'static Mutex<Option<(DatabaseBranchId, Arc<Notify>, Arc<Notify>)>>,
}

#[cfg(debug_assertions)]
pub fn pause_after_hot_stage(
	database_branch_id: DatabaseBranchId,
) -> (PauseGuard, Arc<Notify>, Arc<Notify>) {
	let reached = Arc::new(Notify::new());
	let release = Arc::new(Notify::new());
	*PAUSE_AFTER_HOT_STAGE.lock() = Some((
		database_branch_id,
		Arc::clone(&reached),
		Arc::clone(&release),
	));

	(
		PauseGuard {
			slot: &PAUSE_AFTER_HOT_STAGE,
		},
		reached,
		release,
	)
}

#[cfg(debug_assertions)]
pub(super) async fn maybe_pause_after_hot_stage(database_branch_id: DatabaseBranchId) {
	let hook = PAUSE_AFTER_HOT_STAGE
		.lock()
		.as_ref()
		.filter(|(hook_branch_id, _, _)| *hook_branch_id == database_branch_id)
		.map(|(_, reached, release)| (Arc::clone(reached), Arc::clone(release)));

	if let Some((reached, release)) = hook {
		reached.notify_one();
		release.notified().await;
	}
}

#[cfg(not(debug_assertions))]
pub(super) async fn maybe_pause_after_hot_stage(_database_branch_id: DatabaseBranchId) {}

#[cfg(feature = "test-faults")]
static WORKFLOW_FAULT_CONTROLLERS: Mutex<Vec<(DatabaseBranchId, DepotFaultController)>> =
	Mutex::new(Vec::new());

#[cfg(feature = "test-faults")]
static COLD_OBJECT_DELETE_GRACE_OVERRIDES: Mutex<Vec<(DatabaseBranchId, i64)>> =
	Mutex::new(Vec::new());

#[cfg(feature = "test-faults")]
#[derive(Debug)]
struct ColdUploadProbeState {
	database_branch_id: DatabaseBranchId,
	delay_ms: u64,
	active: usize,
	max_active: usize,
}

#[cfg(feature = "test-faults")]
static COLD_UPLOAD_PROBES: Mutex<Vec<ColdUploadProbeState>> = Mutex::new(Vec::new());

#[cfg(feature = "test-faults")]
static COLD_UPLOAD_FORCED_FAILURES: Mutex<Vec<(DatabaseBranchId, u32)>> = Mutex::new(Vec::new());

#[cfg(feature = "test-faults")]
#[derive(Debug)]
struct ReclaimControlProbeState {
	database_branch_id: DatabaseBranchId,
	job_count: usize,
	max_lane_items: [usize; 5],
}

#[cfg(feature = "test-faults")]
static RECLAIM_CONTROL_PROBES: Mutex<Vec<ReclaimControlProbeState>> = Mutex::new(Vec::new());

#[cfg(feature = "test-faults")]
pub struct WorkflowFaultControllerGuard {
	database_branch_id: DatabaseBranchId,
}

#[cfg(feature = "test-faults")]
pub struct ColdObjectDeleteGraceGuard {
	database_branch_id: DatabaseBranchId,
}

#[cfg(feature = "test-faults")]
pub struct ColdUploadProbeGuard {
	database_branch_id: DatabaseBranchId,
}

#[cfg(feature = "test-faults")]
pub struct ColdUploadForcedFailureGuard {
	database_branch_id: DatabaseBranchId,
	shard_id: u32,
}

#[cfg(feature = "test-faults")]
pub struct ReclaimControlProbeGuard {
	database_branch_id: DatabaseBranchId,
}

#[cfg(feature = "test-faults")]
pub(crate) struct ColdUploadProbePermit {
	database_branch_id: Option<DatabaseBranchId>,
}

#[cfg(feature = "test-faults")]
pub fn observe_cold_upload_concurrency_for_test(
	database_branch_id: DatabaseBranchId,
	delay_ms: u64,
) -> ColdUploadProbeGuard {
	let mut probes = COLD_UPLOAD_PROBES.lock();
	probes.retain(|probe| probe.database_branch_id != database_branch_id);
	probes.push(ColdUploadProbeState {
		database_branch_id,
		delay_ms,
		active: 0,
		max_active: 0,
	});
	ColdUploadProbeGuard { database_branch_id }
}

#[cfg(feature = "test-faults")]
pub fn max_observed_cold_upload_concurrency_for_test(
	database_branch_id: DatabaseBranchId,
) -> usize {
	COLD_UPLOAD_PROBES
		.lock()
		.iter()
		.find(|probe| probe.database_branch_id == database_branch_id)
		.map_or(0, |probe| probe.max_active)
}

#[cfg(feature = "test-faults")]
pub fn observe_reclaim_control_for_test(
	database_branch_id: DatabaseBranchId,
) -> ReclaimControlProbeGuard {
	let mut probes = RECLAIM_CONTROL_PROBES.lock();
	probes.retain(|probe| probe.database_branch_id != database_branch_id);
	probes.push(ReclaimControlProbeState {
		database_branch_id,
		job_count: 0,
		max_lane_items: [0; 5],
	});
	ReclaimControlProbeGuard { database_branch_id }
}

#[cfg(feature = "test-faults")]
pub fn observed_reclaim_control_for_test(
	database_branch_id: DatabaseBranchId,
) -> (usize, [usize; 5]) {
	RECLAIM_CONTROL_PROBES
		.lock()
		.iter()
		.find(|probe| probe.database_branch_id == database_branch_id)
		.map_or((0, [0; 5]), |probe| (probe.job_count, probe.max_lane_items))
}

#[cfg(feature = "test-faults")]
pub(crate) fn record_reclaim_control_for_test(
	database_branch_id: DatabaseBranchId,
	input_range: &ReclaimJobInputRange,
) {
	if let Some(probe) = RECLAIM_CONTROL_PROBES
		.lock()
		.iter_mut()
		.find(|probe| probe.database_branch_id == database_branch_id)
	{
		probe.job_count = probe.job_count.saturating_add(1);
		for (slot, observed) in probe.max_lane_items.iter_mut().zip([
			input_range.txid_refs.len(),
			input_range.cold_objects.len(),
			input_range.retired_cold_objects.len(),
			input_range.hot_shard_evictions.len(),
			input_range.staged_hot_shards.len(),
		]) {
			*slot = (*slot).max(observed);
		}
	}
}

#[cfg(feature = "test-faults")]
pub fn fail_cold_upload_shard_for_test(
	database_branch_id: DatabaseBranchId,
	shard_id: u32,
) -> ColdUploadForcedFailureGuard {
	let mut failures = COLD_UPLOAD_FORCED_FAILURES.lock();
	failures.retain(|(branch_id, existing_shard_id)| {
		*branch_id != database_branch_id || *existing_shard_id != shard_id
	});
	failures.push((database_branch_id, shard_id));
	ColdUploadForcedFailureGuard {
		database_branch_id,
		shard_id,
	}
}

#[cfg(feature = "test-faults")]
pub(crate) fn should_fail_cold_upload_shard(
	database_branch_id: DatabaseBranchId,
	shard_id: u32,
) -> bool {
	COLD_UPLOAD_FORCED_FAILURES
		.lock()
		.iter()
		.any(|(branch_id, failure_shard_id)| {
			*branch_id == database_branch_id && *failure_shard_id == shard_id
		})
}

#[cfg(feature = "test-faults")]
pub(crate) async fn enter_cold_upload_probe(
	database_branch_id: DatabaseBranchId,
) -> ColdUploadProbePermit {
	let delay_ms = {
		let mut probes = COLD_UPLOAD_PROBES.lock();
		let Some(probe) = probes
			.iter_mut()
			.find(|probe| probe.database_branch_id == database_branch_id)
		else {
			return ColdUploadProbePermit {
				database_branch_id: None,
			};
		};
		probe.active = probe.active.saturating_add(1);
		probe.max_active = probe.max_active.max(probe.active);
		probe.delay_ms
	};
	if delay_ms > 0 {
		tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
	}
	ColdUploadProbePermit {
		database_branch_id: Some(database_branch_id),
	}
}

#[cfg(feature = "test-faults")]
pub fn override_cold_object_delete_grace_for_test(
	database_branch_id: DatabaseBranchId,
	grace_ms: i64,
) -> ColdObjectDeleteGraceGuard {
	set_cold_object_delete_grace_for_qualification(database_branch_id, grace_ms);
	ColdObjectDeleteGraceGuard { database_branch_id }
}

/// Installs a process-local delete grace override for a deployed qualification Engine.
/// This symbol is absent from production builds and must only be exposed by a test-faults API.
#[cfg(feature = "test-faults")]
pub fn set_cold_object_delete_grace_for_qualification(
	database_branch_id: DatabaseBranchId,
	grace_ms: i64,
) {
	let mut overrides = COLD_OBJECT_DELETE_GRACE_OVERRIDES.lock();
	if let Some((_, existing)) = overrides
		.iter_mut()
		.find(|(branch_id, _)| *branch_id == database_branch_id)
	{
		*existing = grace_ms;
	} else {
		overrides.push((database_branch_id, grace_ms));
	}
}

#[cfg(feature = "test-faults")]
pub fn clear_cold_object_delete_grace_for_qualification(database_branch_id: DatabaseBranchId) {
	COLD_OBJECT_DELETE_GRACE_OVERRIDES
		.lock()
		.retain(|(branch_id, _)| *branch_id != database_branch_id);
}

#[cfg(feature = "test-faults")]
pub(crate) fn cold_object_delete_grace_ms(
	database_branch_id: DatabaseBranchId,
	configured_recovery_window_ms: i64,
) -> i64 {
	COLD_OBJECT_DELETE_GRACE_OVERRIDES
		.lock()
		.iter()
		.find(|(branch_id, _)| *branch_id == database_branch_id)
		.map(|(_, grace_ms)| *grace_ms)
		.unwrap_or(configured_recovery_window_ms)
}

#[cfg(not(feature = "test-faults"))]
pub(crate) fn cold_object_delete_grace_ms(
	_database_branch_id: DatabaseBranchId,
	configured_recovery_window_ms: i64,
) -> i64 {
	configured_recovery_window_ms
}

#[cfg(feature = "test-faults")]
pub fn register_workflow_fault_controller(
	database_branch_id: DatabaseBranchId,
	controller: DepotFaultController,
) -> WorkflowFaultControllerGuard {
	let mut controllers = WORKFLOW_FAULT_CONTROLLERS.lock();
	if let Some((_, existing)) = controllers
		.iter_mut()
		.find(|(branch_id, _)| *branch_id == database_branch_id)
	{
		*existing = controller;
	} else {
		controllers.push((database_branch_id, controller));
	}

	WorkflowFaultControllerGuard { database_branch_id }
}

#[cfg(feature = "test-faults")]
pub(crate) async fn maybe_fire_hot_compaction_fault(
	database_branch_id: DatabaseBranchId,
	point: HotCompactionFaultPoint,
) -> Result<Option<DepotFaultFired>> {
	maybe_fire_workflow_fault(database_branch_id, DepotFaultPoint::HotCompaction(point)).await
}

#[cfg(feature = "test-faults")]
pub(crate) async fn maybe_fire_cold_compaction_fault(
	database_branch_id: DatabaseBranchId,
	point: ColdCompactionFaultPoint,
) -> Result<Option<DepotFaultFired>> {
	maybe_fire_workflow_fault(database_branch_id, DepotFaultPoint::ColdCompaction(point)).await
}

#[cfg(feature = "test-faults")]
pub(crate) async fn maybe_fire_reclaim_fault(
	database_branch_id: DatabaseBranchId,
	point: ReclaimFaultPoint,
) -> Result<Option<DepotFaultFired>> {
	maybe_fire_workflow_fault(database_branch_id, DepotFaultPoint::Reclaim(point)).await
}

#[cfg(feature = "test-faults")]
pub(crate) async fn maybe_fire_branch_gc_fault(
	database_branch_id: DatabaseBranchId,
	point: BranchGcFaultPoint,
) -> Result<Option<DepotFaultFired>> {
	maybe_fire_workflow_fault(database_branch_id, DepotFaultPoint::BranchGc(point)).await
}

#[cfg(feature = "test-faults")]
async fn maybe_fire_workflow_fault(
	database_branch_id: DatabaseBranchId,
	point: DepotFaultPoint,
) -> Result<Option<DepotFaultFired>> {
	let controller = WORKFLOW_FAULT_CONTROLLERS
		.lock()
		.iter()
		.find(|(branch_id, _)| *branch_id == database_branch_id)
		.map(|(_, controller)| controller.clone());

	let Some(controller) = controller else {
		return Ok(None);
	};

	controller
		.maybe_fire(
			point,
			DepotFaultContext::new().database_branch_id(database_branch_id),
		)
		.await
}

#[cfg(debug_assertions)]
impl Drop for PauseGuard {
	fn drop(&mut self) {
		*self.slot.lock() = None;
	}
}

#[cfg(feature = "test-faults")]
impl Drop for WorkflowFaultControllerGuard {
	fn drop(&mut self) {
		let mut controllers = WORKFLOW_FAULT_CONTROLLERS.lock();
		controllers.retain(|(branch_id, _)| *branch_id != self.database_branch_id);
	}
}

#[cfg(feature = "test-faults")]
impl Drop for ColdObjectDeleteGraceGuard {
	fn drop(&mut self) {
		COLD_OBJECT_DELETE_GRACE_OVERRIDES
			.lock()
			.retain(|(branch_id, _)| *branch_id != self.database_branch_id);
	}
}

#[cfg(feature = "test-faults")]
impl Drop for ColdUploadProbeGuard {
	fn drop(&mut self) {
		COLD_UPLOAD_PROBES
			.lock()
			.retain(|probe| probe.database_branch_id != self.database_branch_id);
	}
}

#[cfg(feature = "test-faults")]
impl Drop for ColdUploadForcedFailureGuard {
	fn drop(&mut self) {
		COLD_UPLOAD_FORCED_FAILURES
			.lock()
			.retain(|(branch_id, shard_id)| {
				*branch_id != self.database_branch_id || *shard_id != self.shard_id
			});
	}
}

#[cfg(feature = "test-faults")]
impl Drop for ReclaimControlProbeGuard {
	fn drop(&mut self) {
		RECLAIM_CONTROL_PROBES
			.lock()
			.retain(|probe| probe.database_branch_id != self.database_branch_id);
	}
}

#[cfg(feature = "test-faults")]
impl Drop for ColdUploadProbePermit {
	fn drop(&mut self) {
		let Some(database_branch_id) = self.database_branch_id else {
			return;
		};
		if let Some(probe) = COLD_UPLOAD_PROBES
			.lock()
			.iter_mut()
			.find(|probe| probe.database_branch_id == database_branch_id)
		{
			probe.active = probe.active.saturating_sub(1);
		}
	}
}
