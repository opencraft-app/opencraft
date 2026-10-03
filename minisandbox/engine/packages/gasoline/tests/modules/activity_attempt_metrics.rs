use async_trait::async_trait;
use rivet_test_deps::TestDeps;
use serde::Deserialize;
use serde_json::value::RawValue;
use tokio::sync::Semaphore;

use super::*;
use crate::db::{Database, DatabaseKv, debug::DatabaseDebug};
use crate::history::location::Coordinate;
use crate::registry::Registry;

#[derive(Debug, Serialize, Deserialize)]
enum AttemptInput {
	Succeeded,
	Error,
	Queued,
}

impl ActivityInput for AttemptInput {
	type Activity = AttemptFixture;
}

struct AttemptFixture;

#[async_trait]
impl Activity for AttemptFixture {
	type Input = AttemptInput;
	type Output = u64;
	const NAME: &'static str = "attempt_metrics_fixture";
	const MAX_RETRIES: usize = 3;
	const TIMEOUT: Duration = Duration::from_secs(1);

	async fn run(_ctx: &ActivityCtx, input: &AttemptInput) -> Result<u64> {
		match input {
			AttemptInput::Succeeded => Ok(42),
			AttemptInput::Error => anyhow::bail!("an arbitrary user-controlled error payload"),
			AttemptInput::Queued => {
				// A real semaphore has no capacity. Admission is inside Activity::run, just as in Depot.
				let queue = Semaphore::new(0);
				let _permit = queue.acquire().await?;
				anyhow::bail!("unreachable: no permit was released")
			}
		}
	}
}

async fn attempt_case(input: AttemptInput, workflow_name: &str, expected: &str) -> Result<()> {
	let deps = TestDeps::new().await?;
	let db = DatabaseKv::new(deps.config().clone(), deps.pools().clone()).await?;
	let workflow_id = Id::new_v1(1);
	let raw_input = RawValue::from_string("{}".to_string())?;
	db.dispatch_workflow(
		Id::new_v1(1),
		workflow_id,
		workflow_name,
		None,
		&raw_input,
		false,
	)
	.await?;
	let pulled = db
		.pull_workflows(Id::new_v1(1), 1, &[workflow_name], 1)
		.await?;
	let data = pulled
		.workflows
		.into_iter()
		.next()
		.context("leased workflow")?;
	let cache = rivet_cache::CacheInner::from_env(deps.config(), deps.pools().clone())?;
	let (_stop_tx, stop_rx) = watch::channel(());
	let mut ctx = WorkflowCtx::new(
		Registry::new().handle(),
		db.clone(),
		deps.config().clone(),
		deps.pools().clone(),
		cache,
		data,
		stop_rx,
	)?;
	let labels = ["succeeded", "error", "timeout"];
	let before = labels.map(|result| {
		metrics::ACTIVITY_ATTEMPT_DURATION
			.with_label_values(&[workflow_name, AttemptFixture::NAME, result])
			.get_sample_count()
	});
	let location = Location::new(Box::new([Coordinate::simple(1)]));
	let result = ctx
		.run_activity::<AttemptFixture>(&input, &location, ctx.create_ts())
		.await;
	match expected {
		"succeeded" => assert_eq!(result?, 42),
		"error" => assert!(matches!(
			result,
			Err(WorkflowError::ActivityFailure(_, _, 0))
		)),
		"timeout" => assert!(matches!(result, Err(WorkflowError::ActivityTimeout(_, 0)))),
		_ => unreachable!("fixture result is bounded"),
	}
	for (index, label) in labels.into_iter().enumerate() {
		let after = metrics::ACTIVITY_ATTEMPT_DURATION
			.with_label_values(&[workflow_name, AttemptFixture::NAME, label])
			.get_sample_count();
		assert_eq!(after - before[index], u64::from(label == expected));
	}
	let history = db
		.get_workflow_history(workflow_id, false)
		.await?
		.context("durable history")?;
	assert_eq!(history.events.len(), 1);
	let crate::db::debug::EventData::Activity(event) = &history.events[0].data else {
		anyhow::bail!("expected persisted activity event");
	};
	if expected == "succeeded" {
		assert_eq!(event.output, Some(serde_json::json!(42)));
		assert!(event.errors.is_empty());
		db.commit_workflow(
			workflow_id,
			ctx.lease_id,
			workflow_name,
			true,
			None,
			&[],
			None,
			"",
		)
		.await?;
		let replay_data = db
			.pull_workflows(Id::new_v1(1), 1, &[workflow_name], 1)
			.await?
			.workflows
			.into_iter()
			.next()
			.context("replay lease")?;
		let mut replay = WorkflowCtx::new(
			Registry::new().handle(),
			db.clone(),
			deps.config().clone(),
			deps.pools().clone(),
			ctx.cache.clone(),
			replay_data,
			ctx.stop.clone(),
		)?;
		assert_eq!(replay.activity(AttemptInput::Succeeded).await?, 42);
		assert_eq!(
			metrics::ACTIVITY_ATTEMPT_DURATION
				.with_label_values(&[workflow_name, AttemptFixture::NAME, "succeeded"])
				.get_sample_count(),
			before[0] + 1,
			"replayed output is not another execution attempt"
		);
	} else {
		assert!(event.output.is_none());
		assert_eq!(
			event.errors.iter().map(|error| error.count).sum::<usize>(),
			1
		);
	}
	Ok(())
}

#[tokio::test]
async fn activity_attempt_metrics_record_success_with_durable_output() -> Result<()> {
	attempt_case(
		AttemptInput::Succeeded,
		"attempt_success_fixture",
		"succeeded",
	)
	.await
}

#[tokio::test]
async fn activity_attempt_metrics_bound_error_labels_and_preserve_history() -> Result<()> {
	attempt_case(AttemptInput::Error, "attempt_error_fixture", "error").await
}

#[tokio::test]
async fn activity_attempt_metrics_expose_timeout_while_waiting_for_admission() -> Result<()> {
	attempt_case(AttemptInput::Queued, "attempt_queue_fixture", "timeout").await
}
