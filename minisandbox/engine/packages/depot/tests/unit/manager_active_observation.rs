use std::sync::Arc;

use gas::db::{DatabaseKv, debug::DatabaseDebug};
use rivet_pools::NodeId;
use rivet_test_deps::TestDeps;
use serde_json::value::RawValue;
use tokio::sync::{Mutex, mpsc, watch};

use super::*;
use crate::conveyer::{Db, branch, types::BucketId};

// The assertions compare process-wide production transaction counters. Serialize these fixtures.
static FIXTURE_LOCK: Mutex<()> = Mutex::const_new(());
const WORKFLOW_NAME: &str = "manager_active_observation_fixture";
const FORCE_HOT: ForceCompactionWork = ForceCompactionWork {
	hot: true,
	cold: false,
	reclaim: false,
	final_settle: false,
};

struct Fixture {
	deps: TestDeps,
	gas_db: Arc<DatabaseKv>,
	workflow_id: Id,
	lease_id: Id,
	stop_tx: watch::Sender<()>,
	ctx: WorkflowCtx,
	input: DbManagerInput,
	state: DbManagerState,
}

impl Fixture {
	async fn new() -> Result<Self> {
		let deps = TestDeps::new().await?;
		let udb = deps.pools().udb()?;
		let bucket_id = Id::new_v1(1);
		let (signal_tx, mut signal_rx) = mpsc::channel(1);
		let stored = Db::new_with_compaction_signaler(
			Arc::new((*udb).clone()),
			bucket_id,
			"counter".into(),
			NodeId::new(),
			Arc::new(move |signal| {
				let signal_tx = signal_tx.clone();
				async move { signal_tx.try_send(signal).context("record commit wake") }.boxed()
			}),
		);
		for txid in 1..=160_u64 {
			let page = DirtyPage {
				pgno: 1,
				bytes: (0..128_u64)
					.flat_map(|block| {
						Sha256::digest([txid.to_be_bytes(), block.to_be_bytes()].concat())
					})
					.collect(),
			};
			stored.commit(vec![page], 1, i64::try_from(txid)?).await?;
		}
		let wake = signal_rx
			.try_recv()
			.context("commits generated a dirty wake")?;
		let branch_id = udb
			.txn("test_manager_observation_branch", move |tx| async move {
				branch::resolve_database_branch(
					&tx,
					BucketId::from_gas_id(bucket_id),
					"counter",
					Serializable,
				)
				.await
			})
			.await?
			.context("counter branch")?;
		assert_eq!(wake.database_branch_id, branch_id);
		let now_ms = util::timestamp::now();
		let plan = udb
			.txn("test_manager_observation_plan", move |tx| async move {
				let snapshot = read_manager_fdb_snapshot(&tx, branch_id, false, now_ms).await?;
				plan_hot_job(branch_id, &snapshot, Id::new_v1(1), now_ms, true)
					.context("real committed hot prefix")
			})
			.await?;
		let gas_db = DatabaseKv::new(deps.config().clone(), deps.pools().clone()).await?;
		let workflow_id = Id::new_v1(1);
		gas_db
			.dispatch_workflow(
				Id::new_v1(1),
				workflow_id,
				WORKFLOW_NAME,
				None,
				&RawValue::from_string("{}".into())?,
				false,
			)
			.await?;
		let (stop_tx, stop_rx) = watch::channel(());
		let (ctx, lease_id) = Self::lease_context(&deps, &gas_db, stop_rx).await?;
		let mut state = DbManagerState::new(CompanionWorkflowIds::new(
			Id::new_v1(1),
			Id::new_v1(1),
			Id::new_v1(1),
		));
		state.active_jobs.hot = Some(ActiveHotCompactionJob::from_planned(plan));
		Ok(Self {
			deps,
			gas_db,
			workflow_id,
			lease_id,
			stop_tx,
			ctx,
			input: DbManagerInput::new(branch_id, None),
			state,
		})
	}

	async fn lease_context(
		deps: &TestDeps,
		db: &Arc<DatabaseKv>,
		stop: watch::Receiver<()>,
	) -> Result<(WorkflowCtx, Id)> {
		let data = db
			.pull_workflows(Id::new_v1(1), 1, &[WORKFLOW_NAME], 1)
			.await?
			.workflows
			.into_iter()
			.next()
			.context("exact workflow lease")?;
		let lease_id = data.lease_id;
		let cache = rivet_cache::CacheInner::from_env(deps.config(), deps.pools().clone())?;
		let ctx = WorkflowCtx::new(
			Registry::new().handle(),
			db.clone(),
			deps.config().clone(),
			deps.pools().clone(),
			cache,
			data,
			stop,
		)?;
		Ok((ctx, lease_id))
	}

	async fn replay(&mut self) -> Result<()> {
		self.gas_db
			.commit_workflow(
				self.workflow_id,
				self.lease_id,
				WORKFLOW_NAME,
				true,
				None,
				&[],
				None,
				"",
			)
			.await?;
		(self.ctx, self.lease_id) =
			Self::lease_context(&self.deps, &self.gas_db, self.stop_tx.subscribe()).await?;
		Ok(())
	}

	async fn refresh(&mut self) -> Result<RefreshManagerOutput> {
		execute_refresh_effect(&mut self.ctx, &mut self.state, &self.input, FORCE_HOT).await
	}
}

fn read_bytes(name: &str) -> f64 {
	rivet_metrics::REGISTRY
		.gather()
		.iter()
		.filter(|family| family.name().ends_with("udb_transaction_read_bytes"))
		.flat_map(|family| family.get_metric())
		.filter(|metric| {
			metric
				.get_label()
				.iter()
				.any(|label| label.name() == "name" && label.value() == name)
		})
		.filter_map(|metric| metric.get_counter().as_ref().map(|counter| counter.value()))
		.sum()
}

#[tokio::test]
async fn active_job_uses_bounded_observation_then_resumes_full_planning() -> Result<()> {
	let _lock = FIXTURE_LOCK.lock().await;
	let mut fixture = Fixture::new().await?;
	let before = read_bytes("depot_manager_observe_active");
	let observed = fixture.refresh().await?;
	let observation_bytes = read_bytes("depot_manager_observe_active") - before;
	assert!(observed.planning_deferred);
	assert_eq!(observed.head_txid, Some(160));
	assert!(observed.observed_dirty.is_some());
	assert!(!observed.maintenance_deadline_observed);
	assert!(observed.planned_hot_job.is_none());
	assert!(observation_bytes > 0.0 && observation_bytes < 4096.0);

	let before = read_bytes("depot_manager_refresh");
	fixture.state.active_jobs.clear();
	let planned = fixture.refresh().await?;
	let planning_bytes = read_bytes("depot_manager_refresh") - before;
	assert!(!planned.planning_deferred);
	assert!(planned.planned_hot_job.is_some());
	assert!(planned.maintenance_deadline_observed);
	assert!(planning_bytes > observation_bytes * 100.0);
	tracing::info!(
		observation_bytes,
		planning_bytes,
		"manager fixture read costs"
	);
	Ok(())
}

#[tokio::test]
async fn idle_planning_keeps_the_original_single_activity_sequence() -> Result<()> {
	let _lock = FIXTURE_LOCK.lock().await;
	let mut fixture = Fixture::new().await?;
	fixture.state.active_jobs.clear();
	let planned = fixture.refresh().await?;
	assert!(!planned.planning_deferred);
	assert!(planned.planned_hot_job.is_some());
	let history = fixture
		.gas_db
		.get_workflow_history(fixture.workflow_id, false)
		.await?
		.context("persisted idle planning")?;
	assert_eq!(history.events.len(), 1);
	assert!(matches!(
		&history.events[0].data,
		gas::db::debug::EventData::Activity(_)
	));
	Ok(())
}

#[tokio::test]
async fn durable_observation_replays_without_another_storage_read() -> Result<()> {
	let _lock = FIXTURE_LOCK.lock().await;
	let mut fixture = Fixture::new().await?;
	let observed = fixture.refresh().await?;
	let before = read_bytes("depot_manager_observe_active");
	fixture.replay().await?;
	let replayed = fixture.refresh().await?;
	assert_eq!(replayed.head_txid, observed.head_txid);
	assert!(replayed.planning_deferred);
	assert_eq!(read_bytes("depot_manager_observe_active"), before);
	let history = fixture
		.gas_db
		.get_workflow_history(fixture.workflow_id, false)
		.await?
		.context("persisted observation history")?;
	assert_eq!(history.events.len(), 2);
	Ok(())
}

#[tokio::test]
async fn recorded_full_refresh_replays_before_using_new_observation() -> Result<()> {
	let _lock = FIXTURE_LOCK.lock().await;
	let mut fixture = Fixture::new().await?;
	let original = fixture
		.ctx
		.activity(RefreshManagerInput {
			database_branch_id: fixture.input.database_branch_id,
			force: FORCE_HOT,
		})
		.await?;
	let before = read_bytes("depot_manager_refresh");
	fixture.replay().await?;
	let replayed = fixture.refresh().await?;
	assert!(!replayed.planning_deferred);
	assert_eq!(replayed.planned_hot_job, original.planned_hot_job);
	assert_eq!(read_bytes("depot_manager_refresh"), before);
	assert!(fixture.refresh().await?.planning_deferred);
	Ok(())
}

#[tokio::test]
async fn deferred_plans_cannot_complete_force_work_or_quiesce_timers() -> Result<()> {
	let _lock = FIXTURE_LOCK.lock().await;
	let mut fixture = Fixture::new().await?;
	let observed = fixture.refresh().await?;
	fixture.state.force_compactions.record_request(
		ForceCompaction {
			database_branch_id: fixture.input.database_branch_id,
			request_id: Id::new_v1(1),
			requested_work: ForceCompactionWork {
				hot: false,
				cold: true,
				reclaim: false,
				final_settle: false,
			},
		},
		observed.refreshed_at_ms,
		&fixture.state.active_jobs,
	);
	assert!(
		manager_effects_after_refresh(
			&fixture.state,
			&fixture.input,
			&observed,
			observed.refreshed_at_ms,
			WakeTriggers {
				hot: true,
				cold: true,
				reclaim: true
			},
		)
		.is_empty()
	);
	assert_eq!(fixture.state.force_compactions.pending_requests.len(), 1);
	assert!(fixture.state.force_compactions.recent_results.is_empty());
	fixture.state.next_cold_check_at_ms = Some(3000);
	fixture.state.next_reclaim_check_at_ms = Some(5000);
	schedule_next_wake(
		&mut fixture.state,
		&fixture.input,
		&observed,
		2000,
		false,
		WakeTriggers::default(),
	)?;
	assert_eq!(fixture.state.next_cold_check_at_ms, Some(3000));
	assert_eq!(fixture.state.next_reclaim_check_at_ms, Some(5000));
	schedule_next_wake(
		&mut fixture.state,
		&fixture.input,
		&observed,
		6000,
		false,
		WakeTriggers {
			hot: false,
			cold: true,
			reclaim: true,
		},
	)?;
	assert!(
		fixture
			.state
			.next_cold_check_at_ms
			.is_some_and(|deadline| deadline > 6000)
	);
	assert!(
		fixture
			.state
			.next_reclaim_check_at_ms
			.is_some_and(|deadline| deadline > 6000)
	);
	Ok(())
}

#[tokio::test]
async fn malformed_active_metadata_fails_closed() -> Result<()> {
	let _lock = FIXTURE_LOCK.lock().await;
	let mut fixture = Fixture::new().await?;
	let branch_id = fixture.input.database_branch_id;
	fixture
		.deps
		.pools()
		.udb()?
		.txn("test_manager_corrupt_branch", move |tx| async move {
			tx.informal()
				.set(&keys::branches_list_key(branch_id), &[0xff]);
			Ok(())
		})
		.await?;
	assert!(fixture.refresh().await.is_err());
	let history = fixture
		.gas_db
		.get_workflow_history(fixture.workflow_id, false)
		.await?
		.context("persisted failed observation")?;
	let errors = history
		.events
		.iter()
		.filter_map(|event| {
			if let gas::db::debug::EventData::Activity(activity) = &event.data {
				assert!(activity.output.is_none());
				Some(
					activity
						.errors
						.iter()
						.map(|error| error.count)
						.sum::<usize>(),
				)
			} else {
				None
			}
		})
		.sum::<usize>();
	assert_eq!(errors, 1);
	Ok(())
}

#[tokio::test]
async fn active_observation_still_stops_a_deleted_branch() -> Result<()> {
	let _lock = FIXTURE_LOCK.lock().await;
	let mut fixture = Fixture::new().await?;
	let branch_id = fixture.input.database_branch_id;
	fixture
		.deps
		.pools()
		.udb()?
		.txn("test_manager_delete_branch", move |tx| async move {
			tx.informal().clear(&keys::branches_list_key(branch_id));
			Ok(())
		})
		.await?;
	let observed = fixture.refresh().await?;
	assert!(!observed.branch_is_live);
	assert!(matches!(
		manager_effects_after_refresh(
			&fixture.state,
			&fixture.input,
			&observed,
			observed.refreshed_at_ms,
			WakeTriggers::default(),
		)
		.as_slice(),
		[ManagerEffect::StopCompanions { .. }]
	));
	Ok(())
}
