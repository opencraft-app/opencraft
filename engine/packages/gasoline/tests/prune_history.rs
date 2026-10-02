use std::time::Duration;

use anyhow::Result;
use gas::prelude::*;
use gasoline as gas;

#[derive(Debug, Serialize, Deserialize)]
struct CompletionCutoffInput {}

#[workflow(CompletionCutoffWorkflow)]
async fn completion_cutoff_workflow(
	ctx: &mut WorkflowCtx,
	_input: &CompletionCutoffInput,
) -> Result<()> {
	ctx.listen::<Finish>().await?;
	Ok(())
}

#[signal("prune_history_finish")]
#[derive(Debug)]
struct Finish {}

#[derive(Debug, Serialize, Deserialize)]
struct RetainedStateInput {}

#[workflow(RetainedStateWorkflow)]
#[prune = history]
async fn retained_state_workflow(
	ctx: &mut WorkflowCtx,
	_input: &RetainedStateInput,
) -> Result<u32> {
	ctx.listen::<Finish>().await?;
	Ok(42)
}

#[tokio::test]
async fn history_pruning_uses_completion_time_and_reaches_a_fixed_point() -> Result<()> {
	let mut registry = Registry::new();
	registry.register_workflow::<CompletionCutoffWorkflow>()?;
	let mut test_ctx = TestCtx::new(registry).await?;

	let workflow_id = test_ctx
		.workflow(CompletionCutoffInput {})
		.dispatch()
		.await?;
	tokio::time::sleep(Duration::from_millis(25)).await;
	let between_create_and_complete = rivet_util::timestamp::now();
	tokio::time::sleep(Duration::from_millis(5)).await;
	test_ctx
		.signal(Finish {})
		.to_workflow_id(workflow_id)
		.send()
		.await?;
	tokio::time::timeout(
		Duration::from_secs(5),
		test_ctx
			.workflow::<CompletionCutoffInput>(workflow_id)
			.output(),
	)
	.await??;

	let workflow_name = CompletionCutoffWorkflow::NAME;
	let matched = test_ctx
		.debug_db()
		.prune_complete_workflow_history(&[workflow_name], between_create_and_complete, true, 1)
		.await?;
	assert_eq!(
		matched, 0,
		"a workflow completed after the cutoff must retain its history"
	);

	let after_completion = rivet_util::timestamp::now() + 1_000;
	let pruned = test_ctx
		.debug_db()
		.prune_complete_workflow_history(&[workflow_name], after_completion, false, 1)
		.await?;
	assert_eq!(pruned, 1);
	assert!(
		test_ctx
			.debug_db()
			.get_workflow_history(workflow_id, true)
			.await?
			.is_some_and(|history| history.events.is_empty()),
		"all active and forgotten history must be removed"
	);
	test_ctx
		.workflow::<CompletionCutoffInput>(workflow_id)
		.output()
		.await?;

	let remaining = test_ctx
		.debug_db()
		.prune_complete_workflow_history(&[workflow_name], after_completion, true, 1)
		.await?;
	assert_eq!(remaining, 0, "history pruning must reach a fixed point");

	test_ctx.shutdown().await?;
	Ok(())
}

#[tokio::test]
async fn indexed_history_pruning_precedes_terminal_pruning() -> Result<()> {
	let mut registry = Registry::new();
	registry.register_workflow::<CompletionCutoffWorkflow>()?;
	registry.register_workflow::<RetainedStateWorkflow>()?;
	let mut test_ctx = TestCtx::new(registry).await?;

	let all_id = test_ctx
		.workflow(CompletionCutoffInput {})
		.dispatch()
		.await?;
	let retained_id = test_ctx.workflow(RetainedStateInput {}).dispatch().await?;
	for workflow_id in [all_id, retained_id] {
		test_ctx
			.signal(Finish {})
			.to_workflow_id(workflow_id)
			.send()
			.await?;
	}
	tokio::time::timeout(
		Duration::from_secs(5),
		test_ctx.workflow::<CompletionCutoffInput>(all_id).output(),
	)
	.await??;
	assert_eq!(
		tokio::time::timeout(
			Duration::from_secs(5),
			test_ctx
				.workflow::<RetainedStateInput>(retained_id)
				.output(),
		)
		.await??,
		42
	);

	let cutoff = rivet_util::timestamp::now() + 1_000;
	let mut cursor = None;
	let mut history_pruned = 0;
	loop {
		let (count, next) = test_ctx
			.debug_db()
			.prune_workflow_histories(cutoff, 1, cursor.as_deref())
			.await?;
		history_pruned += count;
		cursor = next;
		if cursor.is_none() {
			break;
		}
	}
	assert_eq!(history_pruned, 2);
	for workflow_id in [all_id, retained_id] {
		assert!(
			test_ctx
				.debug_db()
				.get_workflow_history(workflow_id, true)
				.await?
				.is_some_and(|history| history.events.is_empty()),
			"history should be removed without deleting workflow state/output"
		);
	}
	assert_eq!(
		test_ctx
			.workflow::<RetainedStateInput>(retained_id)
			.output()
			.await?,
		42
	);

	let mut cursor = None;
	let mut terminal_pruned = 0;
	loop {
		let (count, next) = test_ctx
			.debug_db()
			.prune_workflows(cutoff, 1, cursor.as_deref())
			.await?;
		terminal_pruned += count;
		cursor = next;
		if cursor.is_none() {
			break;
		}
	}
	assert_eq!(terminal_pruned, 1, "only prune=all has a terminal index");
	assert!(
		test_ctx
			.debug_db()
			.get_workflow_history(all_id, true)
			.await?
			.is_none(),
		"terminal pruning should remove prune=all workflow data"
	);
	assert_eq!(
		test_ctx
			.workflow::<RetainedStateInput>(retained_id)
			.output()
			.await?,
		42,
		"prune=history workflow output must remain addressable"
	);

	let (history_remaining, history_cursor) = test_ctx
		.debug_db()
		.prune_workflow_histories(cutoff, 100, None)
		.await?;
	let (terminal_remaining, terminal_cursor) = test_ctx
		.debug_db()
		.prune_workflows(cutoff, 100, None)
		.await?;
	assert_eq!((history_remaining, history_cursor), (0, None));
	assert_eq!((terminal_remaining, terminal_cursor), (0, None));

	test_ctx.shutdown().await?;
	Ok(())
}
