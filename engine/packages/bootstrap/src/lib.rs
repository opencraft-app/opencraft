use gas::prelude::*;

mod backfill;

pub async fn start(config: rivet_config::Config, pools: rivet_pools::Pools) -> Result<()> {
	let cache = rivet_cache::CacheInner::from_env(&config, pools.clone())?;
	let ctx = StandaloneCtx::new(
		db::DatabaseKv::new(config.clone(), pools.clone()).await?,
		config.clone(),
		pools,
		cache,
		"bootstrap",
		Id::new_v1(config.dc_label()),
		Id::new_v1(config.dc_label()),
	)?;

	tokio::try_join!(
		async {
			// Replicas must exist before coordinator
			setup_epoxy_replica(&ctx).await?;
			setup_epoxy_coordinator(&ctx).await
		},
		create_default_namespace(&ctx),
		backfill::run(&ctx),
		setup_depot_compaction_reconciler(&ctx),
		setup_depot_branch_gc_reconcilers(&ctx),
		setup_depot_branch_cold_gc_reconcilers(&ctx),
		setup_pegboard_metrics_aggregator(&ctx),
		setup_gas_pruner(&ctx),
		setup_datacenter_ping(&ctx),
	)?;

	Ok(())
}

async fn setup_depot_branch_cold_gc_reconcilers(ctx: &StandaloneCtx) -> Result<()> {
	for shard in 0..depot::keys::DB_BRANCH_COLD_GC_QUEUE_SHARD_COUNT {
		let workflow_id = ctx
			.workflow(
				depot::workflows::db_branch_cold_gc_reconciler::DbBranchColdGcReconcilerInput {
					shard,
				},
			)
			.tag(
				depot::workflows::db_branch_cold_gc_reconciler::BRANCH_COLD_GC_QUEUE_SHARD_TAG,
				shard,
			)
			.unique()
			.dispatch()
			.await?;
		tracing::debug!(%workflow_id, shard, "created Depot branch cold GC reconciler");
	}
	Ok(())
}

async fn setup_depot_branch_gc_reconcilers(ctx: &StandaloneCtx) -> Result<()> {
	for shard in 0..depot::keys::DB_BRANCH_GC_QUEUE_SHARD_COUNT {
		let workflow_id = ctx
			.workflow(
				depot::workflows::db_branch_gc_reconciler::DbBranchGcReconcilerInput { shard },
			)
			.tag(
				depot::workflows::db_branch_gc_reconciler::BRANCH_GC_QUEUE_SHARD_TAG,
				shard,
			)
			.unique()
			.dispatch()
			.await?;
		tracing::debug!(%workflow_id, shard, "created Depot branch GC reconciler");
	}
	Ok(())
}

async fn setup_depot_compaction_reconciler(ctx: &StandaloneCtx) -> Result<()> {
	let workflow_id = ctx
		.workflow(depot::workflows::compaction::DbCompactionReconcilerInput {})
		.unique()
		.dispatch()
		.await?;
	tracing::debug!(%workflow_id, "created Depot compaction reconciler");

	Ok(())
}

async fn setup_epoxy_coordinator(ctx: &StandaloneCtx) -> Result<()> {
	if !ctx.config().is_leader() {
		tracing::debug!("is not leader, skipping creating epoxy coordinator");
		return Ok(());
	}

	// Create coordinator if does not exist
	let workflow_id = ctx
		.workflow(epoxy::workflows::coordinator::Input {})
		.tag("replica", ctx.config().epoxy_replica_id())
		.unique()
		.dispatch()
		.await?;
	tracing::debug!(%workflow_id, "created epoxy coordinator");

	ctx.signal(epoxy::workflows::coordinator::Reconfigure {})
		.to_workflow_id(workflow_id)
		.send()
		.await?;
	tracing::debug!(%workflow_id, "sent reconfigure message to epoxy coordinator");

	Ok(())
}

async fn setup_epoxy_replica(ctx: &StandaloneCtx) -> Result<()> {
	// Create replica if does not exist
	let workflow_id = ctx
		.workflow(epoxy::workflows::replica::Input {})
		.tag("replica", ctx.config().epoxy_replica_id())
		.unique()
		.dispatch()
		.await?;
	tracing::debug!(%workflow_id, "created epoxy replica");

	Ok(())
}

async fn create_default_namespace(ctx: &StandaloneCtx) -> Result<()> {
	if !ctx.config().is_leader() {
		tracing::debug!("is not leader, skipping creating default namespace");
		return Ok(());
	}

	// Check if default namespace already exists
	let existing_namespace = ctx
		.op(namespace::ops::resolve_for_name_local::Input {
			name: "default".to_string(),
		})
		.await
		.context("failed resolving default name")?;

	if existing_namespace.is_none() {
		// Create namespace
		let namespace_id = Id::new_v1(ctx.config().dc_label());
		let workflow_id = ctx
			.workflow(namespace::workflows::namespace::Input {
				namespace_id,
				name: "default".to_string(),
				display_name: "Default".to_string(),
			})
			.tag("namespace_id", namespace_id)
			.dispatch()
			.await?;
		tracing::info!(%workflow_id, %namespace_id, "created default namespace");
	} else {
		tracing::debug!("default namespace already exists");
	}

	Ok(())
}

async fn setup_pegboard_metrics_aggregator(ctx: &StandaloneCtx) -> Result<()> {
	// Create metrics aggregator if does not exist
	let workflow_id = ctx
		.workflow(pegboard::workflows::metrics_aggregator::Input {})
		.unique()
		.dispatch()
		.await?;
	tracing::debug!(%workflow_id, "created pegboard metrics aggregator");

	Ok(())
}

async fn setup_gas_pruner(ctx: &StandaloneCtx) -> Result<()> {
	// Register the pruner metric family on every Engine replica before the
	// unique durable workflow is dispatched. The gauges deliberately remain at
	// zero until a real prune activity succeeds.
	gas::metrics::register_pruner_metrics();

	// Create gas pruner if does not exist
	let workflow_id = ctx
		.workflow(gasoline_runtime::workflows::pruner::Input {})
		.unique()
		.dispatch()
		.await?;
	tracing::debug!(%workflow_id, "created gasoline pruner");

	Ok(())
}

async fn setup_datacenter_ping(ctx: &StandaloneCtx) -> Result<()> {
	// Create datacenter ping wf if does not exist
	let workflow_id = ctx
		.workflow(datacenter::workflows::ping::Input {})
		.unique()
		.dispatch()
		.await?;
	tracing::debug!(%workflow_id, "created datacenter ping");

	Ok(())
}
