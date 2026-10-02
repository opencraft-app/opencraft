use std::time::Duration;

use anyhow::{Context, Result, ensure};
use futures_util::TryStreamExt;
use gasoline as gas;
use gasoline::prelude::*;
use universaldb::prelude::{RangeOption, StreamingMode};
use universaldb::utils::{IsolationLevel, Subspace};

const SAMPLE_WORKFLOWS: usize = 32;
const MAX_KEYS_PER_DORMANT_WORKFLOW: usize = 40;
const MAX_RAW_BYTES_PER_DORMANT_WORKFLOW: usize = 16 * 1024;

#[derive(Debug, Serialize, Deserialize)]
struct DormantScaleInput {
	marker: usize,
}

#[workflow(DormantScaleWorkflow)]
async fn dormant_scale_workflow(ctx: &mut WorkflowCtx, _input: &DormantScaleInput) -> Result<()> {
	ctx.listen::<DormantScaleSignal>().await?;
	Ok(())
}

#[signal("dormant_scale_signal")]
#[derive(Debug)]
struct DormantScaleSignal {}

#[derive(Debug, Clone, Copy)]
struct Footprint {
	keys: usize,
	raw_bytes: usize,
}

async fn cell_footprint(test_ctx: &TestCtx) -> Result<Footprint> {
	let subspace = Subspace::new(&(
		0usize,
		1usize,
		2usize,
		test_ctx.config().gasoline_cell_namespace(),
	));
	let values = test_ctx
		.pools()
		.udb()?
		.txn("test_gasoline_cell_footprint", move |tx| {
			let subspace = subspace.clone();
			async move {
				tx.get_ranges_keyvalues(
					RangeOption {
						mode: StreamingMode::WantAll,
						..(&subspace).into()
					},
					IsolationLevel::Snapshot,
				)
				.try_collect::<Vec<_>>()
				.await
			}
		})
		.await?;
	Ok(Footprint {
		keys: values.len(),
		raw_bytes: values
			.iter()
			.map(|value| value.key().len() + value.value().len())
			.sum(),
	})
}

async fn wait_until_sleeping(test_ctx: &TestCtx, workflow_ids: &[Id]) -> Result<()> {
	let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
	loop {
		let workflows = gas::db::debug::DatabaseDebug::get_workflows(
			test_ctx.debug_db(),
			workflow_ids.to_vec(),
		)
		.await?;
		if workflows.len() == workflow_ids.len()
			&& workflows
				.iter()
				.all(|workflow| workflow.state == gas::db::debug::WorkflowState::Sleeping)
		{
			return Ok(());
		}
		ensure!(
			tokio::time::Instant::now() < deadline,
			"workflows did not reach a durable sleeping state"
		);
		tokio::time::sleep(Duration::from_millis(25)).await;
	}
}

#[tokio::test]
async fn dormant_workflow_storage_amplification_stays_bounded() -> Result<()> {
	let mut registry = Registry::new();
	registry.register_workflow::<DormantScaleWorkflow>()?;
	let mut test_ctx = TestCtx::new(registry).await?;

	// Pay fixed Cell, worker, operation-family, and workflow-family overhead before measuring the
	// per-workflow slope.
	let warmup_id = test_ctx
		.workflow(DormantScaleInput { marker: usize::MAX })
		.dispatch()
		.await?;
	wait_until_sleeping(&test_ctx, &[warmup_id]).await?;
	let baseline = cell_footprint(&test_ctx).await?;

	let mut workflow_ids = Vec::with_capacity(SAMPLE_WORKFLOWS);
	for marker in 0..SAMPLE_WORKFLOWS {
		workflow_ids.push(
			test_ctx
				.workflow(DormantScaleInput { marker })
				.dispatch()
				.await?,
		);
	}
	wait_until_sleeping(&test_ctx, &workflow_ids).await?;
	let measured = cell_footprint(&test_ctx).await?;
	let key_delta = measured
		.keys
		.checked_sub(baseline.keys)
		.context("Gasoline Cell key count unexpectedly shrank")?;
	let byte_delta = measured
		.raw_bytes
		.checked_sub(baseline.raw_bytes)
		.context("Gasoline Cell raw byte footprint unexpectedly shrank")?;
	let keys_per_workflow = key_delta.div_ceil(SAMPLE_WORKFLOWS);
	let raw_bytes_per_workflow = byte_delta.div_ceil(SAMPLE_WORKFLOWS);

	println!(
		"dormant Gasoline slope: {keys_per_workflow} keys/workflow, \
		 {raw_bytes_per_workflow} raw key+value bytes/workflow"
	);
	ensure!(
		keys_per_workflow <= MAX_KEYS_PER_DORMANT_WORKFLOW,
		"dormant workflow key amplification regressed: {keys_per_workflow} > \
		 {MAX_KEYS_PER_DORMANT_WORKFLOW}"
	);
	ensure!(
		raw_bytes_per_workflow <= MAX_RAW_BYTES_PER_DORMANT_WORKFLOW,
		"dormant workflow raw byte amplification regressed: {raw_bytes_per_workflow} > \
		 {MAX_RAW_BYTES_PER_DORMANT_WORKFLOW}"
	);

	test_ctx.shutdown().await?;
	Ok(())
}
