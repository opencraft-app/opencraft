use anyhow::Result;
use gasoline::{
	db::{Database, DatabaseKv},
	prelude::Id,
};

fn config(cell_namespace: &str) -> rivet_config::Config {
	let mut root = rivet_config::config::Root::default();
	root.runtime =
		rivet_config::config::Runtime::with_gasoline_cell_namespace(cell_namespace.to_string());
	rivet_config::Config::from_root(root)
}

#[tokio::test]
async fn same_workflow_id_is_isolated_between_cells_sharing_one_udb() -> Result<()> {
	let test_deps = rivet_test_deps::TestDeps::new().await?;
	let pools = test_deps.pools().clone();
	let beijing = DatabaseKv::new(config("actor-bj-a01"), pools.clone()).await?;
	let shanghai = DatabaseKv::new(config("actor-sh-a01"), pools).await?;
	let workflow_id = Id::new_v1(1);
	let input = serde_json::value::RawValue::from_string("{}".to_string())?;

	beijing
		.dispatch_workflow(
			Id::new_v1(1),
			workflow_id,
			"beijing-workflow",
			None,
			&input,
			false,
		)
		.await?;
	assert_eq!(beijing.get_workflows(vec![workflow_id]).await?.len(), 1);
	assert!(shanghai.get_workflows(vec![workflow_id]).await?.is_empty());

	shanghai
		.dispatch_workflow(
			Id::new_v1(2),
			workflow_id,
			"shanghai-workflow",
			None,
			&input,
			false,
		)
		.await?;
	let beijing_workflow = beijing.get_workflows(vec![workflow_id]).await?.remove(0);
	let shanghai_workflow = shanghai.get_workflows(vec![workflow_id]).await?.remove(0);
	assert_eq!(beijing_workflow.name, "beijing-workflow");
	assert_eq!(shanghai_workflow.name, "shanghai-workflow");

	Ok(())
}
