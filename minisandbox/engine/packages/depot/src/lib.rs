mod admission;
pub mod backup_fence;
pub mod burst_mode;
use gas::prelude::*;

pub mod cold_tier;
mod compaction;
pub mod conveyer;
pub mod doctor;
#[cfg(feature = "test-faults")]
pub mod fault;
pub mod gc;
pub mod inspect;
pub mod metrics;
#[cfg(debug_assertions)]
pub mod takeover;
pub mod workflows;

#[cfg(feature = "test-faults")]
pub use compaction::test_hooks::{
	clear_cold_object_delete_grace_for_qualification,
	set_cold_object_delete_grace_for_qualification,
};
pub use conveyer::constants::*;
#[cfg(debug_assertions)]
pub use conveyer::debug;
pub use conveyer::pitr_interval;
pub use conveyer::{constants, error, keys, ltx, page_index, policy, quota, types, udb};

pub fn registry() -> WorkflowResult<Registry> {
	let mut registry = Registry::new();
	registry.register_workflow::<workflows::db_branch_gc::DbBranchGcWorkflow>()?;
	registry.register_workflow::<workflows::db_branch_cold_gc::DbBranchColdGcWorkflow>()?;
	registry
		.register_workflow::<workflows::db_branch_cold_gc_reconciler::DbBranchColdGcReconcilerWorkflow>(
		)?;
	registry
		.register_workflow::<workflows::db_branch_gc_reconciler::DbBranchGcReconcilerWorkflow>()?;
	registry
		.register_workflow::<workflows::db_compaction_reconciler::DbCompactionReconcilerWorkflow>(
		)?;
	registry.register_workflow::<workflows::db_cold_compacter::DbColdCompacterWorkflow>()?;
	registry.register_workflow::<workflows::db_hot_compacter::DbHotCompacterWorkflow>()?;
	registry.register_workflow::<workflows::db_manager::DbManagerWorkflow>()?;
	registry.register_workflow::<workflows::db_reclaimer::DbReclaimerWorkflow>()?;

	Ok(registry)
}
