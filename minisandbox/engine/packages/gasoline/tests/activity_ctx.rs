use std::time::Duration;

use gas::prelude::*;
use gasoline as gas;

mod workflows;
use workflows::properties_test::*;
use workflows::state_test::*;

#[tokio::test]
async fn test_activity_state() {
	let mut reg = Registry::new();
	reg.register_workflow::<StateTestWorkflow>().unwrap();
	let test_ctx = TestCtx::new(reg).await.unwrap();

	let workflow_id = test_ctx
		.workflow(StateTestInput { initial_value: 42 })
		.dispatch()
		.await
		.unwrap();

	// Wait for workflow to complete with timeout
	let res = tokio::time::timeout(
		Duration::from_secs(5),
		test_ctx.workflow::<StateTestInput>(workflow_id).output(),
	)
	.await
	.unwrap()
	.unwrap();
	assert_eq!(res, 42);
}

#[tokio::test]
async fn test_activity_ctx_properties() {
	let mut reg = Registry::new();
	reg.register_workflow::<PropertiesTestWorkflow>().unwrap();
	let test_ctx = TestCtx::new(reg).await.unwrap();

	let workflow_id = test_ctx
		.workflow(PropertiesTestInput {})
		.dispatch()
		.await
		.unwrap();

	// Wait for workflow to complete with timeout
	tokio::time::timeout(
		Duration::from_secs(5),
		test_ctx
			.workflow::<PropertiesTestInput>(workflow_id)
			.output(),
	)
	.await
	.unwrap()
	.unwrap();
	// All property checks passed if we got here
}
