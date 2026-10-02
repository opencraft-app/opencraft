use crate::compaction::{companion::cleanup_cold_upload_intents, shared::*, *};

#[cfg(feature = "test-faults")]
use crate::compaction::test_hooks;
#[cfg(feature = "test-faults")]
use crate::fault::ReclaimFaultPoint;

#[workflow(DbManagerWorkflow)]
pub async fn depot_db_manager(ctx: &mut WorkflowCtx, input: &DbManagerInput) -> Result<()> {
	let companion_workflow_ids =
		dispatch_companion_workflows(ctx, input.database_branch_id).await?;
	let initial_state = DbManagerState::new(companion_workflow_ids);

	ctx.lupe()
		.commit_interval(1)
		.with_state(initial_state)
		.run(|ctx, state| {
			let input = input.clone();
			async move { run_manager_iteration(ctx, state, &input).await }.boxed()
		})
		.await
}

#[derive(Copy, Clone, Debug, Default)]
pub(super) struct WakeTriggers {
	pub hot: bool,
	pub cold: bool,
	pub reclaim: bool,
}

async fn run_manager_iteration(
	ctx: &mut WorkflowCtx,
	state: &mut DbManagerState,
	input: &DbManagerInput,
) -> Result<Loop<()>> {
	let signals = listen_for_manager_signals(ctx, input, state).await?;
	let signal_received = !signals.is_empty();
	// A successful reclaim pass is deliberately bounded by FDB transaction limits. If the refreshed
	// snapshot still contains safe work, schedule the next bounded pass immediately instead of
	// charging another full periodic interval for every batch. Only the completion of the exact
	// active job grants this follow-up; stale, failed, or rejected completions continue to rely on the
	// normal timer and therefore cannot create a retry loop.
	let reclaim_succeeded = active_reclaim_succeeded(state, input, &signals);
	// The reconciler deliberately redelivers a durable dirty marker until the marker is cleared.
	// Treating an identical redelivery as new activity postpones the cold and reclaim deadlines on
	// every reconciliation pass, so a permanently dirty branch can starve both jobs forever.
	let planning_clock_advanced = signals_advance_planning_clock(state, &signals);

	let effects = manager_effects_for_signals(state, input, signals, ctx.create_ts());
	execute_manager_effects(ctx, state, input, effects).await?;

	if let Some(effect) = manager_effect_for_requested_stop(state, input) {
		execute_manager_effects(ctx, state, input, vec![effect]).await?;
		return Ok(Loop::Break(()));
	}

	let forced_work = state.force_compactions.pending_work();
	let refresh = execute_manager_refresh(ctx, state, input, forced_work).await?;
	let now_ms = refresh.refreshed_at_ms;

	let triggers = WakeTriggers {
		hot: signal_received,
		cold: state.next_cold_check_at_ms.is_some_and(|d| now_ms >= d) || forced_work.cold,
		reclaim: state.next_reclaim_check_at_ms.is_some_and(|d| now_ms >= d)
			|| forced_work.reclaim
			|| reclaim_succeeded,
	};

	let effects = manager_effects_after_refresh(state, input, &refresh, now_ms, triggers);
	let should_stop = effects
		.iter()
		.any(|effect| matches!(effect, ManagerEffect::StopCompanions { .. }));
	execute_manager_effects(ctx, state, input, effects).await?;
	if should_stop {
		return Ok(Loop::Break(()));
	}

	schedule_next_wake(
		state,
		input,
		&refresh,
		now_ms,
		planning_clock_advanced,
		triggers,
	)?;

	Ok(Loop::Continue)
}

fn schedule_next_wake(
	state: &mut DbManagerState,
	input: &DbManagerInput,
	refresh: &RefreshManagerOutput,
	now_ms: i64,
	planning_clock_advanced: bool,
	triggers: WakeTriggers,
) -> Result<()> {
	use crate::conveyer::constants::{
		MANAGER_COLD_COMPACTION_INTERVAL_MS, manager_reclaim_interval_ms,
	};

	if manager_planning_timers_disabled(input) || manager_is_quiescent(state, refresh) {
		state.next_cold_check_at_ms = None;
		state.next_reclaim_check_at_ms = None;
		return Ok(());
	}
	// A branch can be clean at this instant while retained PITR coverage still protects hot
	// shards. Wake at the exact earliest expiry instead of polling every reclaim interval. This
	// preserves time-based reclaim without making dormant Object cardinality periodic load.
	if refresh.observed_dirty.is_none()
		&& refresh.planned_hot_job.is_none()
		&& refresh.planned_cold_job.is_none()
		&& refresh.planned_reclaim_job.is_none()
		&& state.active_jobs.hot.is_none()
		&& state.active_jobs.cold.is_none()
		&& state.active_jobs.reclaim.is_none()
		&& state.force_compactions.pending_work().is_empty()
		&& let Some(next_reclaim_at_ms) = refresh.next_reclaim_at_ms
	{
		state.next_cold_check_at_ms = None;
		state.next_reclaim_check_at_ms = Some(next_reclaim_at_ms.max(now_ms));
		return Ok(());
	}

	if triggers.cold || planning_clock_advanced {
		state.next_cold_check_at_ms = Some(
			now_ms
				+ staggered_manager_interval_ms(
					input.database_branch_id,
					MANAGER_COLD_COMPACTION_INTERVAL_MS,
					0x63,
				),
		);
	}
	if triggers.reclaim || planning_clock_advanced {
		state.next_reclaim_check_at_ms = Some(
			now_ms
				+ staggered_manager_interval_ms(
					input.database_branch_id,
					manager_reclaim_interval_ms()?,
					0x72,
				),
		);
	}
	Ok(())
}

/// A clean branch does not need one permanent timer-owning workflow wake every few minutes.
/// Future commits recreate the durable dirty locator and signal this unique manager; delayed cold
/// object deletion is owned by the sharded GC queues. Active/planned work retains its fallback
/// timers, so quiescing changes load, not correctness ownership.
fn manager_is_quiescent(state: &DbManagerState, refresh: &RefreshManagerOutput) -> bool {
	refresh.maintenance_deadline_observed
		&& refresh.next_reclaim_at_ms.is_none()
		&& refresh.observed_dirty.is_none()
		&& refresh.planned_hot_job.is_none()
		&& refresh.planned_cold_job.is_none()
		&& refresh.planned_reclaim_job.is_none()
		&& state.active_jobs.hot.is_none()
		&& state.active_jobs.cold.is_none()
		&& state.active_jobs.reclaim.is_none()
		&& state.force_compactions.pending_work().is_empty()
}

/// Workflow signals are pulled in batches, so thousands of database managers can observe the
/// same planning clock even when their writes arrived gradually. A fixed periodic deadline then
/// creates a Cell-wide compaction wave every two minutes. Keep the configured interval as the
/// mean while assigning each immutable branch a stable phase in the 50%..150% range. The separate
/// domain byte prevents cold compaction and reclaim from becoming correlated for one branch.
fn staggered_manager_interval_ms(
	database_branch_id: DatabaseBranchId,
	base_interval_ms: i64,
	domain: u8,
) -> i64 {
	debug_assert!(base_interval_ms > 1);
	let mut hash = 0xcbf29ce484222325_u64 ^ u64::from(domain);
	for byte in database_branch_id.as_uuid().as_bytes() {
		hash ^= u64::from(*byte);
		hash = hash.wrapping_mul(0x100000001b3);
	}
	let half = base_interval_ms / 2;
	let width = u64::try_from(base_interval_ms).expect("positive manager interval");
	base_interval_ms - half + i64::try_from(hash % width).expect("interval fits i64")
}

fn signals_advance_planning_clock(state: &DbManagerState, signals: &[DbManagerSignal]) -> bool {
	signals.iter().any(|signal| match signal {
		DbManagerSignal::DeltasAvailable(signal) => deltas_available_advances_cursor(state, signal),
		_ => true,
	})
}

fn active_reclaim_succeeded(
	state: &DbManagerState,
	input: &DbManagerInput,
	signals: &[DbManagerSignal],
) -> bool {
	let Some(active_job) = state.active_jobs.reclaim.as_ref() else {
		return false;
	};

	signals.iter().any(|signal| {
		let DbManagerSignal::ReclaimJobFinished(signal) = signal else {
			return false;
		};
		signal.database_branch_id == input.database_branch_id
			&& matches!(&signal.status, CompactionJobStatus::Succeeded)
			&& reclaim_job_finished_matches_active(signal, active_job)
	})
}

fn deltas_available_advances_cursor(state: &DbManagerState, signal: &DeltasAvailable) -> bool {
	state.last_dirty_cursor.as_ref().is_none_or(|current| {
		(signal.observed_head_txid, signal.dirty_updated_at_ms)
			> (current.observed_head_txid, current.dirty_updated_at_ms)
	})
}

#[derive(Debug)]
pub(super) enum ManagerEffect {
	Refresh {
		force: ForceCompactionWork,
	},
	InstallHotOutput {
		signal: HotJobFinished,
		active_job: ActiveHotCompactionJob,
	},
	PublishColdOutput {
		signal: ColdJobFinished,
		active_job: ActiveColdCompactionJob,
	},
	FinishHotJob {
		job_id: Id,
		status: CompactionJobStatus,
	},
	FinishColdJob {
		job_id: Id,
		status: CompactionJobStatus,
	},
	FinishReclaimJob {
		job_id: Id,
		status: CompactionJobStatus,
	},
	ScheduleStaleHotOutputCleanup {
		signal: HotJobFinished,
		actor_id: Option<String>,
	},
	ScheduleStaleColdOutputCleanup {
		signal: ColdJobFinished,
	},
	RunHotJob {
		active_job: PlannedHotCompactionJob,
	},
	RunColdJob {
		active_job: PlannedColdCompactionJob,
	},
	RunReclaimJob {
		active_job: PlannedReclaimCompactionJob,
	},
	StopCompanions {
		request: ManagerStopRequest,
	},
	CompleteReadyForceCompactions {
		refresh: RefreshManagerOutput,
	},
}

pub(super) fn manager_effects_for_signals(
	state: &mut DbManagerState,
	input: &DbManagerInput,
	signals: Vec<DbManagerSignal>,
	now_ms: i64,
) -> Vec<ManagerEffect> {
	let mut effects = Vec::new();
	for signal in signals {
		if signal.database_branch_id() != input.database_branch_id {
			continue;
		}

		match signal {
			DbManagerSignal::DeltasAvailable(signal) => {
				record_deltas_available(state, signal);
			}
			DbManagerSignal::ForceCompaction(signal) => {
				state
					.force_compactions
					.record_request(signal, now_ms, &state.active_jobs);
			}
			DbManagerSignal::HotJobFinished(signal) => {
				effects.extend(manager_effects_for_hot_job_finished(state, input, signal));
			}
			DbManagerSignal::ColdJobFinished(signal) => {
				effects.extend(manager_effects_for_cold_job_finished(state, signal));
			}
			DbManagerSignal::ReclaimJobFinished(signal) => {
				effects.extend(manager_effects_for_reclaim_job_finished(state, signal));
			}
			DbManagerSignal::DestroyDatabaseBranch(signal) => {
				record_destroy_database_branch(state, signal);
			}
		}
	}

	effects
}

fn record_deltas_available(state: &mut DbManagerState, signal: DeltasAvailable) {
	if !deltas_available_advances_cursor(state, &signal) {
		return;
	}
	state.last_dirty_cursor = Some(DirtyCursor {
		observed_head_txid: signal.observed_head_txid,
		dirty_updated_at_ms: signal.dirty_updated_at_ms,
	});
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::conveyer::constants::{
		DEFAULT_MANAGER_RECLAIM_INTERVAL_MS, MANAGER_COLD_COMPACTION_INTERVAL_MS,
	};

	fn manager_state() -> DbManagerState {
		DbManagerState::new(CompanionWorkflowIds::new(
			Id::new_v1(1),
			Id::new_v1(1),
			Id::new_v1(1),
		))
	}

	fn deltas(head_txid: u64, updated_at_ms: i64) -> DeltasAvailable {
		DeltasAvailable {
			database_branch_id: DatabaseBranchId::new_v4(),
			observed_head_txid: head_txid,
			dirty_updated_at_ms: updated_at_ms,
		}
	}

	fn refresh_with_dirty(head_txid: u64, updated_at_ms: i64) -> RefreshManagerOutput {
		RefreshManagerOutput {
			refreshed_at_ms: updated_at_ms,
			planned_hot_job: None,
			planned_cold_job: None,
			planned_reclaim_job: None,
			observed_dirty: Some(SqliteCmpDirty {
				observed_head_txid: head_txid,
				updated_at_ms,
			}),
			head_txid: Some(head_txid),
			branch_is_live: true,
			branch_lifecycle_generation: Some(1),
			db_pin_count: 0,
			reclaim_noop_reason: None,
			next_reclaim_at_ms: None,
			maintenance_deadline_observed: true,
		}
	}

	fn active_reclaim_fixture(
		database_branch_id: DatabaseBranchId,
	) -> (ActiveReclaimCompactionJob, ReclaimJobFinished) {
		let planned = PlannedReclaimCompactionJob {
			database_branch_id,
			job_id: Id::new_v1(1),
			base_lifecycle_generation: 7,
			base_manifest_generation: 11,
			input_fingerprint: [3; 32],
			input_range: ReclaimJobInputRange {
				txids: TxidRange {
					min_txid: 1,
					max_txid: 32,
				},
				txid_refs: Vec::new(),
				cold_objects: Vec::new(),
				retired_cold_objects: Vec::new(),
				hot_shard_evictions: Vec::new(),
				orphan_cold_upload_job_id: None,
				staged_hot_shards: Vec::new(),
				max_keys: 500,
				max_bytes: 2 * 1024 * 1024,
			},
			planned_at_ms: 1_000,
			attempt: 0,
		};
		let active = ActiveReclaimCompactionJob::from_planned(planned);
		let signal = ReclaimJobFinished {
			database_branch_id,
			job_id: active.job_id,
			job_kind: CompactionJobKind::Reclaim,
			base_manifest_generation: active.base_manifest_generation,
			input_fingerprint: active.input_fingerprint,
			status: CompactionJobStatus::Succeeded,
			output_refs: Vec::new(),
		};
		(active, signal)
	}

	#[test]
	fn duplicate_dirty_redelivery_does_not_postpone_periodic_deadlines() {
		let mut state = manager_state();
		state.last_dirty_cursor = Some(DirtyCursor {
			observed_head_txid: 128,
			dirty_updated_at_ms: 1_000,
		});
		state.next_cold_check_at_ms = Some(3_000);
		state.next_reclaim_check_at_ms = Some(5_000);
		let duplicate = deltas(128, 1_000);

		assert!(!signals_advance_planning_clock(
			&state,
			&[DbManagerSignal::DeltasAvailable(duplicate.clone())]
		));
		record_deltas_available(&mut state, duplicate);
		schedule_next_wake(
			&mut state,
			&DbManagerInput::new(DatabaseBranchId::new_v4(), None),
			&refresh_with_dirty(128, 1_000),
			2_000,
			false,
			WakeTriggers::default(),
		)
		.unwrap();

		assert_eq!(state.next_cold_check_at_ms, Some(3_000));
		assert_eq!(state.next_reclaim_check_at_ms, Some(5_000));
		assert_eq!(state.last_dirty_cursor.unwrap().observed_head_txid, 128);
	}

	#[test]
	fn newer_dirty_signal_advances_cursor_and_rearms_periodic_deadlines() {
		let mut state = manager_state();
		let database_branch_id = DatabaseBranchId::new_v4();
		state.last_dirty_cursor = Some(DirtyCursor {
			observed_head_txid: 128,
			dirty_updated_at_ms: 1_000,
		});
		state.next_cold_check_at_ms = Some(3_000);
		state.next_reclaim_check_at_ms = Some(5_000);
		let newer = deltas(129, 2_000);

		assert!(signals_advance_planning_clock(
			&state,
			&[DbManagerSignal::DeltasAvailable(newer.clone())]
		));
		record_deltas_available(&mut state, newer);
		schedule_next_wake(
			&mut state,
			&DbManagerInput::new(database_branch_id, None),
			&refresh_with_dirty(129, 2_000),
			2_500,
			true,
			WakeTriggers::default(),
		)
		.unwrap();

		assert_eq!(
			state.next_cold_check_at_ms,
			Some(
				2_500
					+ staggered_manager_interval_ms(
						database_branch_id,
						MANAGER_COLD_COMPACTION_INTERVAL_MS,
						0x63,
					)
			)
		);
		assert_eq!(
			state.next_reclaim_check_at_ms,
			Some(
				2_500
					+ staggered_manager_interval_ms(
						database_branch_id,
						DEFAULT_MANAGER_RECLAIM_INTERVAL_MS,
						0x72,
					)
			)
		);
		assert_eq!(state.last_dirty_cursor.unwrap().observed_head_txid, 129);
	}

	#[test]
	fn clean_idle_manager_disarms_periodic_wakes() {
		let mut state = manager_state();
		state.next_cold_check_at_ms = Some(3_000);
		state.next_reclaim_check_at_ms = Some(5_000);
		let mut refresh = refresh_with_dirty(12, 1_000);
		refresh.observed_dirty = None;

		schedule_next_wake(
			&mut state,
			&DbManagerInput::new(DatabaseBranchId::new_v4(), None),
			&refresh,
			2_000,
			false,
			WakeTriggers::default(),
		)
		.unwrap();

		assert_eq!(state.next_cold_check_at_ms, None);
		assert_eq!(state.next_reclaim_check_at_ms, None);
	}

	#[test]
	fn clean_manager_sleeps_until_exact_future_reclaim_deadline() {
		let mut state = manager_state();
		state.next_cold_check_at_ms = Some(3_000);
		state.next_reclaim_check_at_ms = Some(5_000);
		let mut refresh = refresh_with_dirty(12, 1_000);
		refresh.observed_dirty = None;
		refresh.next_reclaim_at_ms = Some(42_000);

		schedule_next_wake(
			&mut state,
			&DbManagerInput::new(DatabaseBranchId::new_v4(), None),
			&refresh,
			2_000,
			false,
			WakeTriggers::default(),
		)
		.unwrap();

		assert_eq!(state.next_cold_check_at_ms, None);
		assert_eq!(state.next_reclaim_check_at_ms, Some(42_000));
	}

	#[test]
	fn old_refresh_output_cannot_quiesce_without_deadline_proof() {
		let mut state = manager_state();
		state.next_cold_check_at_ms = Some(3_000);
		state.next_reclaim_check_at_ms = Some(5_000);
		let mut refresh = refresh_with_dirty(12, 1_000);
		refresh.observed_dirty = None;
		refresh.maintenance_deadline_observed = false;

		schedule_next_wake(
			&mut state,
			&DbManagerInput::new(DatabaseBranchId::new_v4(), None),
			&refresh,
			2_000,
			false,
			WakeTriggers::default(),
		)
		.unwrap();

		assert_eq!(state.next_cold_check_at_ms, Some(3_000));
		assert_eq!(state.next_reclaim_check_at_ms, Some(5_000));
	}

	#[test]
	fn periodic_manager_work_is_stably_staggered_across_branches() {
		let branch = DatabaseBranchId::new_v4();
		let cold = staggered_manager_interval_ms(branch, MANAGER_COLD_COMPACTION_INTERVAL_MS, 0x63);
		let reclaim =
			staggered_manager_interval_ms(branch, DEFAULT_MANAGER_RECLAIM_INTERVAL_MS, 0x72);
		assert_eq!(
			cold,
			staggered_manager_interval_ms(branch, MANAGER_COLD_COMPACTION_INTERVAL_MS, 0x63,)
		);
		assert!(
			(MANAGER_COLD_COMPACTION_INTERVAL_MS / 2..MANAGER_COLD_COMPACTION_INTERVAL_MS * 3 / 2)
				.contains(&cold)
		);
		assert!(
			(DEFAULT_MANAGER_RECLAIM_INTERVAL_MS / 2..DEFAULT_MANAGER_RECLAIM_INTERVAL_MS * 3 / 2)
				.contains(&reclaim)
		);
		let alternate_cold = staggered_manager_interval_ms(
			DatabaseBranchId::from_uuid(uuid::Uuid::from_u128(1)),
			MANAGER_COLD_COMPACTION_INTERVAL_MS,
			0x63,
		);
		let alternate_reclaim = staggered_manager_interval_ms(
			DatabaseBranchId::from_uuid(uuid::Uuid::from_u128(1)),
			MANAGER_COLD_COMPACTION_INTERVAL_MS,
			0x72,
		);
		assert_ne!(alternate_cold, alternate_reclaim);
	}

	#[test]
	fn stale_dirty_signal_cannot_regress_manager_cursor() {
		let mut state = manager_state();
		state.last_dirty_cursor = Some(DirtyCursor {
			observed_head_txid: 200,
			dirty_updated_at_ms: 5_000,
		});

		record_deltas_available(&mut state, deltas(199, 6_000));

		assert_eq!(
			state.last_dirty_cursor,
			Some(DirtyCursor {
				observed_head_txid: 200,
				dirty_updated_at_ms: 5_000,
			})
		);
	}

	#[test]
	fn successful_active_reclaim_requests_an_immediate_bounded_follow_up() {
		let database_branch_id = DatabaseBranchId::new_v4();
		let input = DbManagerInput::new(database_branch_id, None);
		let mut state = manager_state();
		let (active, signal) = active_reclaim_fixture(database_branch_id);
		state.active_jobs.reclaim = Some(active);

		assert!(active_reclaim_succeeded(
			&state,
			&input,
			&[DbManagerSignal::ReclaimJobFinished(signal.clone())]
		));

		let mut failed = signal.clone();
		failed.status = CompactionJobStatus::Failed {
			error: "injected".into(),
		};
		assert!(!active_reclaim_succeeded(
			&state,
			&input,
			&[DbManagerSignal::ReclaimJobFinished(failed)]
		));

		let mut stale = signal;
		stale.job_id = Id::new_v1(2);
		assert!(!active_reclaim_succeeded(
			&state,
			&input,
			&[DbManagerSignal::ReclaimJobFinished(stale)]
		));
	}
}

fn record_destroy_database_branch(state: &mut DbManagerState, signal: DestroyDatabaseBranch) {
	state.branch_stop_state = BranchStopState::StopRequested {
		lifecycle_generation: signal.lifecycle_generation,
		requested_at_ms: signal.requested_at_ms,
		reason: ManagerStopReason::ExplicitDestroy {
			reason: signal.reason,
		},
	};
}

pub(super) fn manager_effects_for_hot_job_finished(
	state: &mut DbManagerState,
	input: &DbManagerInput,
	signal: HotJobFinished,
) -> Vec<ManagerEffect> {
	let active_job = state.active_jobs.hot.clone();
	if let Some(active_job) = active_job.as_ref()
		&& hot_job_finished_matches_active(&signal, active_job)
	{
		return match &signal.status {
			CompactionJobStatus::Requested => Vec::new(),
			CompactionJobStatus::Succeeded => vec![ManagerEffect::InstallHotOutput {
				signal,
				active_job: active_job.clone(),
			}],
			CompactionJobStatus::Retryable { .. }
			| CompactionJobStatus::Rejected { .. }
			| CompactionJobStatus::Failed { .. } => {
				vec![ManagerEffect::FinishHotJob {
					job_id: signal.job_id,
					status: signal.status.clone(),
				}]
			}
		};
	}

	vec![ManagerEffect::ScheduleStaleHotOutputCleanup {
		signal,
		actor_id: input.actor_id.clone(),
	}]
}

pub(super) fn manager_effects_for_cold_job_finished(
	state: &mut DbManagerState,
	signal: ColdJobFinished,
) -> Vec<ManagerEffect> {
	let active_job = state.active_jobs.cold.clone();
	if let Some(active_job) = active_job.as_ref()
		&& cold_job_finished_matches_active(&signal, active_job)
	{
		return match &signal.status {
			CompactionJobStatus::Requested => Vec::new(),
			CompactionJobStatus::Succeeded => vec![ManagerEffect::PublishColdOutput {
				signal,
				active_job: active_job.clone(),
			}],
			CompactionJobStatus::Retryable { .. }
			| CompactionJobStatus::Rejected { .. }
			| CompactionJobStatus::Failed { .. } => {
				vec![ManagerEffect::FinishColdJob {
					job_id: signal.job_id,
					status: signal.status.clone(),
				}]
			}
		};
	}

	vec![ManagerEffect::ScheduleStaleColdOutputCleanup { signal }]
}

pub(super) fn manager_effects_for_reclaim_job_finished(
	state: &mut DbManagerState,
	signal: ReclaimJobFinished,
) -> Vec<ManagerEffect> {
	if let Some(active_job) = state.active_jobs.reclaim.as_ref()
		&& reclaim_job_finished_matches_active(&signal, active_job)
	{
		return match signal.status {
			CompactionJobStatus::Requested => Vec::new(),
			CompactionJobStatus::Succeeded
			| CompactionJobStatus::Retryable { .. }
			| CompactionJobStatus::Rejected { .. }
			| CompactionJobStatus::Failed { .. } => {
				vec![ManagerEffect::FinishReclaimJob {
					job_id: signal.job_id,
					status: signal.status,
				}]
			}
		};
	}

	Vec::new()
}

async fn execute_manager_refresh(
	ctx: &mut WorkflowCtx,
	state: &mut DbManagerState,
	input: &DbManagerInput,
	force: ForceCompactionWork,
) -> Result<RefreshManagerOutput> {
	let executions =
		execute_manager_effects(ctx, state, input, vec![ManagerEffect::Refresh { force }]).await?;
	let [ManagerExecution::Refresh(refresh)] = executions.as_slice() else {
		bail!("refresh effect did not return refresh output");
	};

	Ok(refresh.clone())
}

#[derive(Debug)]
enum ManagerExecution {
	Refresh(RefreshManagerOutput),
}

async fn execute_manager_effects(
	ctx: &mut WorkflowCtx,
	state: &mut DbManagerState,
	input: &DbManagerInput,
	effects: Vec<ManagerEffect>,
) -> Result<Vec<ManagerExecution>> {
	let mut executions = Vec::new();
	for effect in effects {
		match effect {
			ManagerEffect::Refresh { force } => {
				let refresh = execute_refresh_effect(ctx, state, input, force).await?;
				executions.push(ManagerExecution::Refresh(refresh));
			}
			ManagerEffect::InstallHotOutput { signal, active_job } => {
				execute_install_hot_output_effect(ctx, state, signal, active_job).await?;
			}
			ManagerEffect::PublishColdOutput { signal, active_job } => {
				execute_publish_cold_output_effect(ctx, state, signal, active_job).await?;
			}
			ManagerEffect::FinishHotJob { job_id, status } => {
				state.force_compactions.record_job_finished(
					CompactionJobKind::Hot,
					job_id,
					&status,
				);
				state.active_jobs.hot = None;
			}
			ManagerEffect::FinishColdJob { job_id, status } => {
				state.force_compactions.record_job_finished(
					CompactionJobKind::Cold,
					job_id,
					&status,
				);
				state.active_jobs.cold = None;
			}
			ManagerEffect::FinishReclaimJob { job_id, status } => {
				state.force_compactions.record_job_finished(
					CompactionJobKind::Reclaim,
					job_id,
					&status,
				);
				state.active_jobs.reclaim = None;
			}
			ManagerEffect::ScheduleStaleHotOutputCleanup { signal, actor_id } => {
				schedule_stale_hot_output_cleanup(ctx, state, &signal, actor_id.as_deref()).await?;
			}
			ManagerEffect::ScheduleStaleColdOutputCleanup { signal } => {
				let _ = cleanup_cold_upload_intents(ctx, signal.database_branch_id, signal.job_id)
					.await?;
			}
			ManagerEffect::RunHotJob { active_job } => {
				execute_run_hot_job_effect(ctx, state, active_job).await?;
			}
			ManagerEffect::RunColdJob { active_job } => {
				execute_run_cold_job_effect(ctx, state, active_job).await?;
			}
			ManagerEffect::RunReclaimJob { active_job } => {
				execute_run_reclaim_job_effect(ctx, state, active_job).await?;
			}
			ManagerEffect::StopCompanions { request } => {
				signal_companions_destroy(ctx, &state.companion_workflow_ids, &request).await?;
				state.active_jobs.clear();
				state.branch_stop_state = BranchStopState::Stopped {
					stopped_at_ms: ctx.create_ts(),
				};
			}
			ManagerEffect::CompleteReadyForceCompactions { refresh } => {
				state.force_compactions.complete_ready_requests(
					&state.active_jobs,
					&refresh,
					ctx.create_ts(),
				);
			}
		}
	}

	Ok(executions)
}

async fn execute_refresh_effect(
	ctx: &mut WorkflowCtx,
	state: &mut DbManagerState,
	input: &DbManagerInput,
	force: ForceCompactionWork,
) -> Result<RefreshManagerOutput> {
	let refresh = ctx
		.activity(RefreshManagerInput {
			database_branch_id: input.database_branch_id,
			force,
		})
		.await?;

	state.last_observed_branch_lifecycle_generation = refresh.branch_lifecycle_generation;
	if state.last_dirty_cursor.is_none()
		&& let Some(dirty) = refresh.observed_dirty.as_ref()
	{
		state.last_dirty_cursor = Some(DirtyCursor {
			observed_head_txid: dirty.observed_head_txid,
			dirty_updated_at_ms: dirty.updated_at_ms,
		});
	}

	Ok(refresh)
}

async fn execute_install_hot_output_effect(
	ctx: &mut WorkflowCtx,
	state: &mut DbManagerState,
	signal: HotJobFinished,
	active_job: ActiveHotCompactionJob,
) -> Result<()> {
	let install = ctx
		.activity(InstallHotJobInput {
			database_branch_id: signal.database_branch_id,
			job_id: signal.job_id,
			job_kind: signal.job_kind,
			base_lifecycle_generation: active_job.base_lifecycle_generation,
			base_manifest_generation: signal.base_manifest_generation,
			input_fingerprint: signal.input_fingerprint,
			input_range: active_job.input_range,
			output_summary: signal.output_summary,
		})
		.await?;
	match install.status {
		CompactionJobStatus::Requested => {}
		CompactionJobStatus::Succeeded
		| CompactionJobStatus::Retryable { .. }
		| CompactionJobStatus::Rejected { .. }
		| CompactionJobStatus::Failed { .. } => {
			state.force_compactions.record_job_finished(
				CompactionJobKind::Hot,
				signal.job_id,
				&install.status,
			);
			state.active_jobs.hot = None;
		}
	}

	Ok(())
}

async fn execute_publish_cold_output_effect(
	ctx: &mut WorkflowCtx,
	state: &mut DbManagerState,
	signal: ColdJobFinished,
	active_job: ActiveColdCompactionJob,
) -> Result<()> {
	let publish = ctx
		.activity(PublishColdJobInput {
			database_branch_id: signal.database_branch_id,
			job_id: signal.job_id,
			job_kind: signal.job_kind,
			base_lifecycle_generation: active_job.base_lifecycle_generation,
			base_manifest_generation: signal.base_manifest_generation,
			input_fingerprint: signal.input_fingerprint,
			input_range: active_job.input_range,
			output_summary: signal.output_summary,
		})
		.await?;
	if !matches!(publish.status, CompactionJobStatus::Succeeded) {
		let _ = cleanup_cold_upload_intents(ctx, signal.database_branch_id, signal.job_id).await?;
	}
	if !matches!(publish.status, CompactionJobStatus::Requested) {
		state.force_compactions.record_job_finished(
			CompactionJobKind::Cold,
			signal.job_id,
			&publish.status,
		);
		state.active_jobs.cold = None;
	}
	Ok(())
}

async fn execute_run_hot_job_effect(
	ctx: &mut WorkflowCtx,
	state: &mut DbManagerState,
	active_job: PlannedHotCompactionJob,
) -> Result<()> {
	ctx.signal(RunHotJob {
		database_branch_id: active_job.database_branch_id,
		job_id: active_job.job_id,
		job_kind: CompactionJobKind::Hot,
		base_lifecycle_generation: active_job.base_lifecycle_generation,
		base_manifest_generation: active_job.base_manifest_generation,
		input_fingerprint: active_job.input_fingerprint,
		status: CompactionJobStatus::Requested,
		input_range: active_job.input_range.clone(),
	})
	.to_workflow_id(state.companion_workflow_ids.hot_compacter_workflow_id)
	.send()
	.await?;

	state
		.force_compactions
		.record_job_attempted(CompactionJobKind::Hot);
	state.active_jobs.hot = Some(ActiveHotCompactionJob::from_planned(active_job));

	Ok(())
}

async fn execute_run_cold_job_effect(
	ctx: &mut WorkflowCtx,
	state: &mut DbManagerState,
	active_job: PlannedColdCompactionJob,
) -> Result<()> {
	ctx.signal(RunColdJob {
		database_branch_id: active_job.database_branch_id,
		job_id: active_job.job_id,
		job_kind: CompactionJobKind::Cold,
		base_lifecycle_generation: active_job.base_lifecycle_generation,
		base_manifest_generation: active_job.base_manifest_generation,
		input_fingerprint: active_job.input_fingerprint,
		status: CompactionJobStatus::Requested,
		input_range: active_job.input_range.clone(),
	})
	.to_workflow_id(state.companion_workflow_ids.cold_compacter_workflow_id)
	.send()
	.await?;

	state
		.force_compactions
		.record_job_attempted(CompactionJobKind::Cold);
	state.active_jobs.cold = Some(ActiveColdCompactionJob::from_planned(active_job));
	Ok(())
}

async fn execute_run_reclaim_job_effect(
	ctx: &mut WorkflowCtx,
	state: &mut DbManagerState,
	active_job: PlannedReclaimCompactionJob,
) -> Result<()> {
	ctx.signal(RunReclaimJob {
		database_branch_id: active_job.database_branch_id,
		job_id: active_job.job_id,
		job_kind: CompactionJobKind::Reclaim,
		base_lifecycle_generation: active_job.base_lifecycle_generation,
		base_manifest_generation: active_job.base_manifest_generation,
		input_fingerprint: active_job.input_fingerprint,
		status: CompactionJobStatus::Requested,
		input_range: active_job.input_range.clone(),
	})
	.to_workflow_id(state.companion_workflow_ids.reclaimer_workflow_id)
	.send()
	.await?;

	state
		.force_compactions
		.record_job_attempted(CompactionJobKind::Reclaim);
	state.active_jobs.reclaim = Some(ActiveReclaimCompactionJob::from_planned(active_job));

	Ok(())
}

pub(super) fn manager_effect_for_requested_stop(
	state: &DbManagerState,
	input: &DbManagerInput,
) -> Option<ManagerEffect> {
	if let BranchStopState::StopRequested {
		lifecycle_generation,
		requested_at_ms,
		reason,
	} = state.branch_stop_state.clone()
	{
		return Some(stop_companions_effect(ManagerStopRequest {
			database_branch_id: input.database_branch_id,
			lifecycle_generation,
			requested_at_ms,
			reason,
		}));
	}

	None
}

pub(super) fn manager_effects_after_refresh(
	state: &DbManagerState,
	input: &DbManagerInput,
	refresh: &RefreshManagerOutput,
	now_ms: i64,
	triggers: WakeTriggers,
) -> Vec<ManagerEffect> {
	if !refresh.branch_is_live && matches!(state.branch_stop_state, BranchStopState::Running) {
		return vec![stop_companions_effect(ManagerStopRequest {
			database_branch_id: input.database_branch_id,
			lifecycle_generation: refresh.branch_lifecycle_generation.unwrap_or_default(),
			requested_at_ms: now_ms,
			reason: ManagerStopReason::BranchNotLive,
		})];
	}

	let mut effects = Vec::new();
	if matches!(state.branch_stop_state, BranchStopState::Running) {
		// A refresh can make all three lanes look runnable, but their plans share the same root
		// generation. Building the complete effect list before executing it used to dispatch hot
		// and cold work concurrently because `state.active_jobs` was still empty for both checks.
		// The first publisher then advanced the manifest and made the other plan stale. Keep the
		// documented per-branch ordering explicit while constructing the batch: hot, then cold,
		// then reclaim on a later refresh.
		let mut scheduled_hot = false;
		let mut scheduled_cold = false;
		if triggers.hot
			&& state.active_jobs.hot.is_none()
			&& let Some(active_job) = refresh.planned_hot_job.clone()
		{
			effects.push(ManagerEffect::RunHotJob { active_job });
			scheduled_hot = true;
		}
		if !scheduled_hot
			&& triggers.cold
			&& state.active_jobs.cold.is_none()
			&& state.active_jobs.hot.is_none()
			&& let Some(active_job) = refresh.planned_cold_job.clone()
		{
			effects.push(ManagerEffect::RunColdJob { active_job });
			scheduled_cold = true;
		}
		if !scheduled_hot
			&& !scheduled_cold
			&& triggers.reclaim
			&& state.active_jobs.reclaim.is_none()
			&& state.active_jobs.hot.is_none()
			&& state.active_jobs.cold.is_none()
			&& let Some(active_job) = refresh.planned_reclaim_job.clone()
			&& (refresh.planned_cold_job.is_none()
				|| active_job.input_range.orphan_cold_upload_job_id.is_some())
		{
			effects.push(ManagerEffect::RunReclaimJob { active_job });
		}
	}
	effects.push(ManagerEffect::CompleteReadyForceCompactions {
		refresh: refresh.clone(),
	});
	effects
}

fn stop_companions_effect(request: ManagerStopRequest) -> ManagerEffect {
	ManagerEffect::StopCompanions { request }
}
async fn dispatch_companion_workflows(
	ctx: &mut WorkflowCtx,
	database_branch_id: DatabaseBranchId,
) -> Result<CompanionWorkflowIds> {
	let tag_value = database_branch_tag_value(database_branch_id);

	let hot_compacter_workflow_id = ctx
		.workflow(DbHotCompacterInput { database_branch_id })
		.tag(DATABASE_BRANCH_ID_TAG, &tag_value)
		.unique()
		.dispatch()
		.await?;
	let cold_compacter_workflow_id = ctx
		.workflow(DbColdCompacterInput { database_branch_id })
		.tag(DATABASE_BRANCH_ID_TAG, &tag_value)
		.unique()
		.dispatch()
		.await?;
	let reclaimer_workflow_id = ctx
		.workflow(DbReclaimerInput { database_branch_id })
		.tag(DATABASE_BRANCH_ID_TAG, &tag_value)
		.unique()
		.dispatch()
		.await?;

	Ok(CompanionWorkflowIds::new(
		hot_compacter_workflow_id,
		cold_compacter_workflow_id,
		reclaimer_workflow_id,
	))
}

async fn signal_companions_destroy(
	ctx: &mut WorkflowCtx,
	companion_workflow_ids: &CompanionWorkflowIds,
	request: &ManagerStopRequest,
) -> Result<()> {
	let destroy = DestroyDatabaseBranch {
		database_branch_id: request.database_branch_id,
		lifecycle_generation: request.lifecycle_generation,
		requested_at_ms: request.requested_at_ms,
		reason: request.reason.companion_reason(),
	};

	ctx.signal(destroy.clone())
		.to_workflow_id(companion_workflow_ids.hot_compacter_workflow_id)
		.send()
		.await?;

	ctx.signal(destroy.clone())
		.to_workflow_id(companion_workflow_ids.cold_compacter_workflow_id)
		.send()
		.await?;

	ctx.signal(destroy)
		.to_workflow_id(companion_workflow_ids.reclaimer_workflow_id)
		.send()
		.await?;

	Ok(())
}

async fn listen_for_manager_signals(
	ctx: &mut WorkflowCtx,
	input: &DbManagerInput,
	state: &DbManagerState,
) -> Result<Vec<DbManagerSignal>> {
	let planning_deadlines = if manager_planning_timers_disabled(input) {
		[None, None]
	} else {
		[state.next_cold_check_at_ms, state.next_reclaim_check_at_ms]
	};
	let deadline = planning_deadlines.into_iter().flatten().min();

	if let Some(deadline) = deadline {
		ctx.listen_n_until::<DbManagerSignal>(deadline, 256).await
	} else {
		ctx.listen_n::<DbManagerSignal>(256).await
	}
}

#[cfg(feature = "test-faults")]
fn manager_planning_timers_disabled(input: &DbManagerInput) -> bool {
	input.disable_planning_timers
}

#[cfg(not(feature = "test-faults"))]
fn manager_planning_timers_disabled(_input: &DbManagerInput) -> bool {
	false
}

#[activity(RefreshManager)]
pub async fn refresh_manager(
	ctx: &ActivityCtx,
	input: &RefreshManagerInput,
) -> Result<RefreshManagerOutput> {
	let _admission = crate::admission::acquire(
		crate::admission::ActivityClass::ManagerRefresh,
		ctx.config().runtime.depot_manager_refresh_max_concurrency(),
	)
	.await?;
	let now_ms = ctx.ts();
	let database_branch_id = input.database_branch_id;
	let cold_storage_enabled = ctx.config().sqlite().workflow_cold_storage().is_some();
	#[cfg(feature = "test-faults")]
	test_hooks::maybe_fire_reclaim_fault(database_branch_id, ReclaimFaultPoint::PlanBeforeSnapshot)
		.await?;
	let db = ctx.udb()?;
	let snapshot = refresh_with_stage_cleanup(|| async {
		let snapshot = db
			.txn("depot_manager_refresh", move |tx| async move {
				read_manager_fdb_snapshot(&tx, database_branch_id, cold_storage_enabled, now_ms)
					.await
			})
			.await?;
		let progress = snapshot.cleared_staged_hot_job;
		Ok((snapshot, progress))
	})
	.await?;
	#[cfg(feature = "test-faults")]
	test_hooks::maybe_fire_reclaim_fault(database_branch_id, ReclaimFaultPoint::PlanAfterSnapshot)
		.await?;
	let branch_is_live = snapshot
		.branch_record
		.as_ref()
		.is_some_and(|record| record.state == BranchState::Live);
	let branch_lifecycle_generation = snapshot
		.branch_record
		.as_ref()
		.map(|record| record.lifecycle_generation);
	let head_txid = snapshot.head.as_ref().map(|head| head.head_txid);
	let planned_hot_job = if branch_is_live {
		plan_hot_job(
			database_branch_id,
			&snapshot,
			Id::new_v1(ctx.config().dc_label()),
			now_ms,
			input.force.hot,
		)
	} else {
		None
	};
	let planned_cold_job = if branch_is_live && cold_storage_enabled {
		plan_cold_job(
			database_branch_id,
			&snapshot,
			Id::new_v1(ctx.config().dc_label()),
			now_ms,
			input.force.cold,
		)
	} else {
		None
	};
	let planned_reclaim_job = if branch_is_live {
		plan_reclaim_job(
			database_branch_id,
			&snapshot,
			Id::new_v1(ctx.config().dc_label()),
			now_ms,
		)
	} else {
		None
	};
	let reclaim_noop_reason = if branch_is_live {
		Some(reclaim_noop_reason(&snapshot).to_string())
	} else {
		None
	};

	Ok(RefreshManagerOutput {
		refreshed_at_ms: now_ms,
		planned_hot_job,
		planned_cold_job,
		planned_reclaim_job,
		observed_dirty: if snapshot.cleared_dirty {
			None
		} else {
			snapshot.dirty
		},
		head_txid,
		branch_is_live,
		branch_lifecycle_generation,
		db_pin_count: snapshot.db_pin_count,
		reclaim_noop_reason,
		next_reclaim_at_ms: snapshot.reclaim_inputs.next_reclaim_at_ms,
		maintenance_deadline_observed: true,
	})
}

// Bound the work inside one activity, not the number of keys in one transaction.
// Every pass commits independently with the existing generation fences and budgets.
// No workflow event or serialized activity output changes, so recorded histories
// retain their existing replay path and an older binary can still consume the output.
async fn refresh_with_stage_cleanup<T, F, Fut>(mut refresh: F) -> Result<T>
where
	F: FnMut() -> Fut,
	Fut: std::future::Future<Output = Result<(T, bool)>>,
{
	const MAX_PASSES: usize = 4;
	for pass in 1..=MAX_PASSES {
		let (snapshot, made_progress) = refresh().await?;
		if !made_progress || pass == MAX_PASSES {
			return Ok(snapshot);
		}
	}
	unreachable!("the bounded final pass always returns")
}

#[cfg(test)]
#[path = "../../tests/unit/manager_stage_cleanup.rs"]
mod stage_cleanup_tests;

fn cold_job_finished_matches_active(
	signal: &ColdJobFinished,
	active_job: &ActiveColdCompactionJob,
) -> bool {
	signal.job_id == active_job.job_id
		&& signal.job_kind == CompactionJobKind::Cold
		&& signal.base_manifest_generation == active_job.base_manifest_generation
		&& signal.input_fingerprint == active_job.input_fingerprint
}

fn hot_job_finished_matches_active(
	signal: &HotJobFinished,
	active_job: &ActiveHotCompactionJob,
) -> bool {
	signal.job_id == active_job.job_id
		&& signal.job_kind == CompactionJobKind::Hot
		&& signal.base_manifest_generation == active_job.base_manifest_generation
		&& signal.input_fingerprint == active_job.input_fingerprint
}

fn reclaim_job_finished_matches_active(
	signal: &ReclaimJobFinished,
	active_job: &ActiveReclaimCompactionJob,
) -> bool {
	signal.job_id == active_job.job_id
		&& signal.job_kind == CompactionJobKind::Reclaim
		&& signal.base_manifest_generation == active_job.base_manifest_generation
		&& signal.input_fingerprint == active_job.input_fingerprint
}

fn log_actor_id(actor_id: Option<&str>) -> &str {
	actor_id.unwrap_or("unknown")
}

async fn schedule_stale_hot_output_cleanup(
	ctx: &mut WorkflowCtx,
	_state: &mut DbManagerState,
	signal: &HotJobFinished,
	actor_id: Option<&str>,
) -> Result<()> {
	if !matches!(signal.status, CompactionJobStatus::Succeeded)
		|| signal.output_summary.staged_row_count == 0
	{
		return Ok(());
	}
	let cleanup = ctx
		.activity(CleanupStagedHotJobInput {
			database_branch_id: signal.database_branch_id,
			job_id: signal.job_id,
			output_summary: signal.output_summary,
		})
		.await?;
	if !matches!(cleanup.status, CompactionJobStatus::Succeeded) {
		tracing::warn!(
			actor_id = log_actor_id(actor_id),
			?signal.database_branch_id,
			manifest_generation = signal.base_manifest_generation,
			?signal.job_id,
			?cleanup.status,
			repair_action = "retain_stale_hot_output",
			"stale hot output cleanup did not prove the exact staged row set"
		);
	}
	Ok(())
}

pub(crate) fn branch_record_is_live_at_generation(
	branch_record: Option<&DatabaseBranchRecord>,
	lifecycle_generation: u64,
) -> bool {
	branch_record.is_some_and(|record| {
		record.state == BranchState::Live && record.lifecycle_generation == lifecycle_generation
	})
}
