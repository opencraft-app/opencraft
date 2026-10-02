use anyhow::*;
use rivet_service_manager::{RunConfigData, Service, ServiceKind};

pub fn config(rivet_config: rivet_config::Config) -> Result<RunConfigData> {
	let mut services = vec![
		Service::new(
			"api_peer",
			ServiceKind::ApiPeer,
			|config, pools| Box::pin(rivet_api_peer::start(config, pools)),
			false,
		),
		Service::new(
			"guard",
			ServiceKind::ApiPublic,
			|config, pools| Box::pin(rivet_guard::start(config, pools)),
			true,
		),
		Service::new(
			"workflow_worker",
			ServiceKind::Standalone,
			|config, pools| Box::pin(rivet_workflow_worker::start(config, pools)),
			true,
		),
		Service::new(
			"pegboard_outbound",
			ServiceKind::Standalone,
			|config, pools| Box::pin(pegboard_outbound::start(config, pools)),
			true,
		),
		Service::new(
			"bootstrap",
			ServiceKind::Oneshot,
			|config, pools| Box::pin(rivet_bootstrap::start(config, pools)),
			false,
		),
		// Core services
		Service::new(
			"tracing_reconfigure",
			ServiceKind::Core,
			|config, pools| Box::pin(rivet_tracing_reconfigure::start(config, pools)),
			false,
		),
		Service::new(
			"cache_purge",
			ServiceKind::Core,
			|config, pools| Box::pin(rivet_cache_purge::start(config, pools)),
			false,
		),
		Service::new(
			"ups_broadcast",
			ServiceKind::Core,
			|config, pools| Box::pin(rivet_ups_broadcast::start(config, pools)),
			false,
		),
		Service::new(
			"profiling",
			ServiceKind::Core,
			|config, pools| Box::pin(rivet_profiling::start(config, pools)),
			false,
		),
	];

	if rivet_config
		.sqlite()
		.backup_recovery_fence_controller()
		.is_some()
	{
		services.push(Service::new(
			"backup_fence_controller",
			ServiceKind::Singleton,
			|config, pools| Box::pin(crate::backup_fence_controller::start(config, pools)),
			false,
		));
	}

	Ok(RunConfigData { services })
}
