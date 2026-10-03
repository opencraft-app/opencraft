use futures_util::poll;
use rivet_test_deps::TestDeps;
use serde::Deserialize;
use serde_json::value::RawValue;
use tokio::sync::Semaphore;

use super::*;
use crate as gas;
use crate::db::{
	Database, DatabaseKv,
	debug::{DatabaseDebug, EventData, WorkflowState},
};
use crate::history::location::Coordinate;
use crate::registry::Registry;
use async_trait::async_trait;
use gasoline_macros::{activity, workflow};

static FIXTURE_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Clone, Debug, Default)]
enum Mode {
	#[default]
	Defer,
	Execute,
	Timeout,
	Complete,
}

fn new_gate() -> Arc<Semaphore> {
	Arc::new(Semaphore::new(0))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Input {
	job_id: Id,
	payload: String,
	#[serde(skip)]
	mode: Mode,
	#[serde(skip, default = "new_gate")]
	gate: Arc<Semaphore>,
}

async fn fixture_admit(input: &Input) -> Result<ActivityAdmission<String>> {
	match input.mode {
		Mode::Defer => Ok(ActivityAdmission::Deferred(Duration::from_secs(60))),
		Mode::Complete => Ok(ActivityAdmission::Complete("preflight output".into())),
		Mode::Execute | Mode::Timeout => Ok(ActivityAdmission::Ready(Box::new(
			input.gate.clone().acquire_owned().await?,
		))),
	}
}

#[activity(AdmissionFixture)]
#[timeout = 1]
#[max_retries = 1]
#[admission = fixture_admit(input)]
async fn admission_fixture(_ctx: &ActivityCtx, input: &Input) -> Result<String> {
	match input.mode {
		Mode::Execute => Ok(format!("{}:{}", input.job_id, input.payload)),
		Mode::Timeout => {
			tokio::time::sleep(Duration::from_secs(2)).await;
			anyhow::bail!("unreachable after execution timeout")
		}
		Mode::Defer | Mode::Complete => {
			anyhow::bail!("non-executing admission result must not execute")
		}
	}
}

#[workflow(AdmissionWorkflow)]
async fn admission_ownership_fixture(ctx: &mut WorkflowCtx, input: &Input) -> Result<String> {
	ctx.activity(input.clone()).await
}

struct Fixture {
	deps: TestDeps,
	db: Arc<DatabaseKv>,
	registry: RegistryHandle,
	workflow_id: Id,
	input: Input,
	stop_tx: watch::Sender<()>,
	stop_rx: watch::Receiver<()>,
}

impl Fixture {
	async fn new() -> Result<Self> {
		let deps = TestDeps::new().await?;
		let db = DatabaseKv::new(deps.config().clone(), deps.pools().clone()).await?;
		let input = Input {
			job_id: Id::new_v1(1),
			payload: "exact durable input".into(),
			mode: Mode::Defer,
			gate: new_gate(),
		};
		let mut registry = Registry::new();
		registry.register_workflow::<AdmissionWorkflow>()?;
		let workflow_id = Id::new_v1(1);
		db.dispatch_workflow(
			Id::new_v1(1),
			workflow_id,
			AdmissionWorkflow::NAME,
			None,
			&RawValue::from_string(serde_json::to_string(&input)?)?,
			false,
		)
		.await?;
		let (stop_tx, stop_rx) = watch::channel(());
		Ok(Self {
			deps,
			db,
			registry: registry.handle(),
			workflow_id,
			input,
			stop_tx,
			stop_rx,
		})
	}

	async fn lease(&self) -> Result<WorkflowCtx> {
		let data = self
			.db
			.pull_workflows(Id::new_v1(1), 1, &[AdmissionWorkflow::NAME], 1)
			.await?
			.workflows
			.into_iter()
			.next()
			.context("exact workflow lease")?;
		assert_eq!(data.workflow_id, self.workflow_id);
		let cache =
			rivet_cache::CacheInner::from_env(self.deps.config(), self.deps.pools().clone())?;
		WorkflowCtx::new(
			self.registry.clone(),
			self.db.clone(),
			self.deps.config().clone(),
			self.deps.pools().clone(),
			cache,
			data,
			self.stop_rx.clone(),
		)
	}

	async fn history(&self) -> Result<crate::db::debug::HistoryData> {
		self.db
			.get_workflow_history(self.workflow_id, false)
			.await?
			.context("durable history")
	}
}

#[tokio::test]
async fn admission_wait_does_not_consume_execution_budget_and_output_replays() -> Result<()> {
	let _lock = FIXTURE_LOCK.lock().await;
	let fixture = Fixture::new().await?;
	let mut ctx = fixture.lease().await?;
	let mut input = fixture.input.clone();
	input.mode = Mode::Execute;
	let mut run = Box::pin(ctx.activity(input.clone()));
	assert!(poll!(run.as_mut()).is_pending());
	// Cross the original execution deadline before releasing capacity, then prove it is still queued.
	tokio::time::sleep(AdmissionFixture::TIMEOUT + Duration::from_millis(10)).await;
	assert!(poll!(run.as_mut()).is_pending());
	input.gate.add_permits(1);
	let expected = format!("{}:{}", input.job_id, input.payload);
	assert_eq!(run.await?, expected);
	assert_eq!(
		input.gate.available_permits(),
		1,
		"execution guard must be released"
	);
	fixture
		.db
		.commit_workflow(
			fixture.workflow_id,
			ctx.lease_id,
			AdmissionWorkflow::NAME,
			true,
			None,
			&[],
			None,
			"",
		)
		.await?;
	let samples = metrics::ACTIVITY_ADMISSION_DURATION
		.with_label_values(&[AdmissionWorkflow::NAME, AdmissionFixture::NAME, "ready"])
		.get_sample_count();
	let mut replay = fixture.lease().await?;
	// Default input would defer, so cached output must bypass both admission and execution.
	assert_eq!(replay.activity(fixture.input.clone()).await?, expected);
	assert_eq!(
		metrics::ACTIVITY_ADMISSION_DURATION
			.with_label_values(&[AdmissionWorkflow::NAME, AdmissionFixture::NAME, "ready"])
			.get_sample_count(),
		samples
	);
	let history = fixture.history().await?;
	let EventData::Activity(event) = &history.events[0].data else {
		anyhow::bail!("activity event")
	};
	assert!(event.errors.is_empty());
	assert_eq!(event.input, serde_json::to_value(&fixture.input)?);
	Ok(())
}

#[tokio::test]
async fn deferred_work_releases_exact_lease_and_survives_restart_without_failures() -> Result<()> {
	let _lock = FIXTURE_LOCK.lock().await;
	let fixture = Fixture::new().await?;
	let mut leases = Vec::new();
	for _ in 0..3 {
		let ctx = fixture.lease().await?;
		assert!(
			!leases.contains(&ctx.lease_id),
			"restart must acquire a new lease"
		);
		leases.push(ctx.lease_id);
		// Use the production workflow error handler, not a hand-written commit of its result.
		ctx.run(SpanContext::empty_context()).await?;
		let history = fixture.history().await?;
		assert!(
			history.events.is_empty(),
			"no durable execution-failure event while deferred"
		);
		assert_eq!(history.wf.state, WorkflowState::Sleeping);
		assert_eq!(history.wf.input, serde_json::to_value(&fixture.input)?);
		assert!(
			fixture
				.db
				.pull_workflows(Id::new_v1(1), 1, &[AdmissionWorkflow::NAME], 1)
				.await?
				.workflows
				.is_empty(),
			"deferred lease is not immediately re-leased"
		);
		// Explicit diagnostic wake advances the fixture without waiting for the production 60s deadline.
		fixture.db.wake_workflows(vec![fixture.workflow_id]).await?;
	}
	let mut resumed = fixture.lease().await?;
	let mut input = fixture.input.clone();
	input.mode = Mode::Execute;
	input.gate.add_permits(1);
	assert_eq!(
		resumed.activity(input.clone()).await?,
		format!("{}:{}", input.job_id, input.payload)
	);
	assert_eq!(fixture.history().await?.events.len(), 1);
	Ok(())
}

#[tokio::test]
async fn stop_while_queued_is_not_an_execution_failure() -> Result<()> {
	let _lock = FIXTURE_LOCK.lock().await;
	let fixture = Fixture::new().await?;
	let mut ctx = fixture.lease().await?;
	let mut input = fixture.input.clone();
	input.mode = Mode::Execute;
	let location = Location::new(Box::new([Coordinate::simple(1)]));
	let create_ts = ctx.create_ts();
	let mut run = Box::pin(ctx.run_activity::<AdmissionFixture>(&input, &location, create_ts));
	assert!(poll!(run.as_mut()).is_pending());
	fixture.stop_tx.send(())?;
	assert!(matches!(run.await, Err(WorkflowError::WorkflowEvicted)));
	assert!(fixture.history().await?.events.is_empty());
	input.gate.add_permits(1);
	assert_eq!(
		input.gate.available_permits(),
		1,
		"cancelled waiter must not steal later capacity"
	);
	Ok(())
}

#[tokio::test]
async fn admitted_execution_timeout_still_persists_failure_and_releases_permit() -> Result<()> {
	let _lock = FIXTURE_LOCK.lock().await;
	let fixture = Fixture::new().await?;
	let mut ctx = fixture.lease().await?;
	let mut input = fixture.input.clone();
	input.mode = Mode::Timeout;
	input.gate.add_permits(1);
	let create_ts = ctx.create_ts();
	let location = Location::new(Box::new([Coordinate::simple(1)]));
	assert!(matches!(
		ctx.run_activity::<AdmissionFixture>(&input, &location, create_ts)
			.await,
		Err(WorkflowError::ActivityTimeout(_, 0))
	));
	assert_eq!(input.gate.available_permits(), 1);
	let history = fixture.history().await?;
	let EventData::Activity(event) = &history.events[0].data else {
		anyhow::bail!("activity event")
	};
	assert_eq!(
		event.errors.iter().map(|error| error.count).sum::<usize>(),
		1
	);
	assert!(event.output.is_none());
	Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
struct BudgetInput;

impl ActivityInput for BudgetInput {
	type Activity = BudgetFixture;
}

struct BudgetFixture;

#[async_trait]
impl Activity for BudgetFixture {
	type Input = BudgetInput;
	type Output = u64;
	const NAME: &'static str = "admission_budget_fixture";
	const MAX_RETRIES: usize = 1;
	const TIMEOUT: Duration = Duration::from_secs(1);
	const HAS_ADMISSION: bool = true;
	const ADMISSION_TIMEOUT: Duration = Duration::ZERO;

	async fn admit(_ctx: &ActivityCtx, _input: &BudgetInput) -> Result<ActivityAdmission<u64>> {
		let queue = Semaphore::new(0);
		let _permit = queue.acquire().await?;
		anyhow::bail!("unreachable admission")
	}

	async fn run(_ctx: &ActivityCtx, _input: &BudgetInput) -> Result<u64> {
		anyhow::bail!("a bounded admission timeout must never execute")
	}
}

#[tokio::test]
async fn admission_deadline_is_a_bounded_deferral_not_an_execution_timeout() -> Result<()> {
	let _lock = FIXTURE_LOCK.lock().await;
	let fixture = Fixture::new().await?;
	let mut ctx = fixture.lease().await?;
	let create_ts = ctx.create_ts();
	let location = Location::new(Box::new([Coordinate::simple(1)]));
	let started = rivet_util::timestamp::now();
	let error = ctx
		.run_activity::<BudgetFixture>(&BudgetInput, &location, create_ts)
		.await
		.expect_err("admission deadline");
	assert!(error.is_recoverable());
	assert!(!error.is_retryable());
	let WorkflowError::ActivityAdmissionDeferred(name, deadline) = error else {
		anyhow::bail!("expected resource deferral");
	};
	assert_eq!(name, BudgetFixture::NAME);
	assert!(deadline >= started + 60_000 && deadline <= rivet_util::timestamp::now() + 120_000);
	assert!(fixture.history().await?.events.is_empty());
	for label in ["succeeded", "error", "timeout"] {
		assert_eq!(
			metrics::ACTIVITY_ATTEMPT_DURATION
				.with_label_values(&[AdmissionWorkflow::NAME, BudgetFixture::NAME, label])
				.get_sample_count(),
			0
		);
	}
	Ok(())
}

#[tokio::test]
async fn pre_admission_output_is_durable_without_running_the_body() -> Result<()> {
	let _lock = FIXTURE_LOCK.lock().await;
	let fixture = Fixture::new().await?;
	let mut ctx = fixture.lease().await?;
	let mut input = fixture.input.clone();
	input.mode = Mode::Complete;
	assert_eq!(ctx.activity(input).await?, "preflight output");
	let history = fixture.history().await?;
	let EventData::Activity(event) = &history.events[0].data else {
		anyhow::bail!("activity event")
	};
	assert!(event.errors.is_empty());
	assert_eq!(event.output, Some(serde_json::json!("preflight output")));
	Ok(())
}

#[tokio::test]
async fn direct_macro_run_cannot_bypass_admission() -> Result<()> {
	let _lock = FIXTURE_LOCK.lock().await;
	let fixture = Fixture::new().await?;
	let ctx = ActivityCtx::new(
		fixture.workflow_id,
		RawValue::from_string("{}".into())?,
		fixture.db.clone(),
		fixture.deps.config(),
		fixture.deps.pools(),
		&rivet_cache::CacheInner::from_env(fixture.deps.config(), fixture.deps.pools().clone())?,
		rivet_util::timestamp::now(),
		Id::new_v1(1),
		AdmissionFixture::NAME,
		false,
	)?;
	let mut input = fixture.input.clone();
	input.mode = Mode::Execute;
	let mut run = Box::pin(AdmissionFixture::run(&ctx, &input));
	assert!(poll!(run.as_mut()).is_pending());
	input.gate.add_permits(1);
	assert_eq!(run.await?, format!("{}:{}", input.job_id, input.payload));
	assert_eq!(input.gate.available_permits(), 1);
	Ok(())
}

#[tokio::test]
async fn stale_deferred_owner_cannot_release_its_successors_lease() -> Result<()> {
	let _lock = FIXTURE_LOCK.lock().await;
	let fixture = Fixture::new().await?;
	let stale = fixture.lease().await?;
	fixture
		.db
		.commit_workflow(
			fixture.workflow_id,
			stale.lease_id,
			AdmissionWorkflow::NAME,
			true,
			None,
			&[],
			None,
			"",
		)
		.await?;
	let successor = fixture.lease().await?;
	assert_ne!(stale.lease_id, successor.lease_id);
	assert!(stale.run(SpanContext::empty_context()).await.is_err());
	assert_eq!(fixture.history().await?.wf.state, WorkflowState::Running);
	assert!(
		fixture
			.db
			.pull_workflows(Id::new_v1(1), 1, &[AdmissionWorkflow::NAME], 1)
			.await?
			.workflows
			.is_empty(),
		"stale deferral cannot add a new wake or clear the live lease"
	);
	// The exact current owner can still commit its deferral normally.
	successor.run(SpanContext::empty_context()).await?;
	assert_eq!(fixture.history().await?.wf.state, WorkflowState::Sleeping);
	assert!(fixture.history().await?.events.is_empty());
	Ok(())
}
