use std::{collections::HashMap, net::SocketAddr, str::FromStr, sync::Arc};

use anyhow::{Context, Result, ensure};
use rivet_envoy_client::{config::EnvoyConfig, envoy::start_envoy};
use rivet_workerd_host::{
	DEFAULT_WORKERD_IDLE_SLEEP_MS, DEFAULT_WORKERD_MAX_IN_FLIGHT, DEFAULT_WORKERD_MAX_QUEUED,
	DEFAULT_WORKERD_QUEUE_TIMEOUT_MS, HttpWorkerdTransport, MAX_WORKERD_ACTIVE_ACTORS,
	MAX_WORKERD_IDLE_SLEEP_MS, StatelessExecutorConfig, WorkerCodeCache, WorkerdEnvoyCallbacks,
	WorkerdHost, WorkerdSqliteBridge, run_stateless_executor, sqlite_bridge_router_with_host,
	wait_for_workerd_ready, worker_code_router, workerd_management_router,
};
use tracing_subscriber::EnvFilter;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MetaCommand {
	Help,
	Version,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RuntimeMode {
	Durable,
	Stateless,
}

#[tokio::main]
async fn main() -> Result<()> {
	let first_argument = std::env::args().nth(1);
	match meta_command(first_argument.as_deref()) {
		Some(MetaCommand::Help) => {
			println!(
				"rivet-workerd-host {}\n\nShared workerd runtime host.\n\nUSAGE:\n    rivet-workerd-host\n    rivet-workerd-host --mode=stateless\n\nENVIRONMENT:\n    RIVET_WORKERD_TOKEN    Authentication token shared with workerd (required)\n    RIVET_STATELESS_EXECUTOR_TOKEN  Dispatcher capability token (stateless mode)",
				env!("CARGO_PKG_VERSION")
			);
			return Ok(());
		}
		Some(MetaCommand::Version) => {
			println!("rivet-workerd-host {}", env!("CARGO_PKG_VERSION"));
			return Ok(());
		}
		None => {}
	}

	tracing_subscriber::fmt()
		.with_env_filter(EnvFilter::from_default_env())
		.try_init()
		.ok();
	let mode = runtime_mode(first_argument.as_deref())?;
	if mode == RuntimeMode::Stateless {
		return stateless_main().await;
	}

	let token = required_environment("RIVET_WORKERD_TOKEN")?;
	let namespace = environment("RIVET_NAMESPACE", "default");
	let worker_registry_url = std::env::var("RIVET_WORKER_REGISTRY_URL").ok();
	let worker_code = Arc::new(WorkerCodeCache::new(
		worker_registry_url.as_deref(),
		namespace.clone(),
		environment("RIVET_WORKER_CODE_CACHE_DIR", "/tmp/rivet-worker-code"),
	)?);
	let max_in_flight = environment(
		"RIVET_WORKERD_MAX_IN_FLIGHT",
		&DEFAULT_WORKERD_MAX_IN_FLIGHT.to_string(),
	)
	.parse()
	.context("RIVET_WORKERD_MAX_IN_FLIGHT must be an integer")?;
	let max_queued = environment(
		"RIVET_WORKERD_MAX_QUEUED",
		&DEFAULT_WORKERD_MAX_QUEUED.to_string(),
	)
	.parse()
	.context("RIVET_WORKERD_MAX_QUEUED must be an integer")?;
	let queue_timeout_ms = environment(
		"RIVET_WORKERD_QUEUE_TIMEOUT_MS",
		&DEFAULT_WORKERD_QUEUE_TIMEOUT_MS.to_string(),
	)
	.parse()
	.context("RIVET_WORKERD_QUEUE_TIMEOUT_MS must be an integer")?;
	let max_active_actors = optional_positive_environment(
		"RIVET_WORKERD_MAX_ACTIVE_ACTORS",
		MAX_WORKERD_ACTIVE_ACTORS,
	)?;
	let idle_sleep_ms = environment(
		"RIVET_WORKERD_IDLE_SLEEP_MS",
		&DEFAULT_WORKERD_IDLE_SLEEP_MS.to_string(),
	)
	.parse::<u64>()
	.context("RIVET_WORKERD_IDLE_SLEEP_MS must be an integer")?;
	ensure!(
		idle_sleep_ms <= MAX_WORKERD_IDLE_SLEEP_MS,
		"RIVET_WORKERD_IDLE_SLEEP_MS must be 0 or at most {MAX_WORKERD_IDLE_SLEEP_MS}"
	);
	let idle_sleep_after =
		(idle_sleep_ms > 0).then(|| std::time::Duration::from_millis(idle_sleep_ms));
	let endpoints = environment(
		"RIVET_WORKERD_ENDPOINTS",
		&environment("RIVET_WORKERD_ENDPOINT", "http://127.0.0.1:8080"),
	)
	.split(',')
	.map(str::trim)
	.filter(|endpoint| !endpoint.is_empty())
	.map(str::to_string)
	.collect::<Vec<_>>();
	let transport = Arc::new(
		HttpWorkerdTransport::new_with_admission_limits_for_endpoints(
			&endpoints,
			&token,
			max_in_flight,
			max_queued,
			queue_timeout_ms,
		)?,
	);
	let host = Arc::new(WorkerdHost::new_with_max_active_actors(
		transport,
		max_active_actors,
	));
	let sqlite_bridge = Arc::new(WorkerdSqliteBridge::new());
	let weak_host = Arc::downgrade(&host);
	sqlite_bridge.set_fence_handler(Arc::new(move |identity| {
		let Some(host) = weak_host.upgrade() else {
			return;
		};
		tokio::spawn(async move {
			let isolate_name = identity.isolate_name();
			if let Err(error) = host.fence_actor(identity).await {
				tracing::error!(?error, %isolate_name, "failed to evict fenced workerd isolate");
			}
		});
	}))?;
	let callbacks = Arc::new(WorkerdEnvoyCallbacks::new_with_idle_sleep(
		host.clone(),
		sqlite_bridge.clone(),
		worker_code.clone(),
		idle_sleep_after,
	));
	let sqlite_bind =
		SocketAddr::from_str(&environment("RIVET_WORKERD_SQLITE_BIND", "127.0.0.1:8081"))?;
	ensure!(
		sqlite_bind.ip().is_loopback(),
		"workerd sqlite bridge must bind numeric loopback"
	);
	let sqlite_listener = tokio::net::TcpListener::bind(sqlite_bind).await?;
	let sqlite_router =
		sqlite_bridge_router_with_host(sqlite_bridge.clone(), host.clone(), token.clone())?;
	let sqlite_server =
		tokio::spawn(async move { axum::serve(sqlite_listener, sqlite_router).await });
	let management_bind = SocketAddr::from_str(&environment(
		"RIVET_WORKERD_MANAGEMENT_BIND",
		"127.0.0.1:19083",
	))?;
	let management_listener = tokio::net::TcpListener::bind(management_bind).await?;
	let management_router = workerd_management_router(sqlite_bridge, host.clone(), token.clone())?
		.merge(worker_code_router(host.clone(), worker_code, token)?);
	let management_server =
		tokio::spawn(async move { axum::serve(management_listener, management_router).await });
	wait_for_workerd_ready(&host, std::time::Duration::from_secs(1)).await;
	let mut metadata = serde_json::json!({
		"runtime": "workerd",
		"identity_schema": "rivet-v1",
	});
	if let Some(max_active_actors) = max_active_actors {
		metadata["placement"] = serde_json::json!({
			"strategy": "binpack",
			"max_active_actors": max_active_actors,
		});
	}
	let mut draining_metadata = metadata.clone();
	if max_active_actors.is_some() {
		draining_metadata["placement"] = serde_json::json!({
			"strategy": "binpack",
			"max_active_actors": 0,
			"draining": true,
		});
	}
	let handle = start_envoy(EnvoyConfig {
		version: environment("RIVET_ENVOY_VERSION", "1").parse()?,
		endpoint: environment("RIVET_ENDPOINT", "http://127.0.0.1:6420"),
		token: Some(environment("RIVET_TOKEN", "dev")),
		namespace,
		pool_name: environment("RIVET_POOL_NAME", "workerd"),
		prepopulate_actor_names: HashMap::new(),
		metadata: Some(metadata.clone()),
		not_global: true,
		debug_latency_ms: None,
		callbacks,
	})
	.await;
	host.configure_envoy_control(handle.clone(), metadata, draining_metadata)?;

	tracing::info!(
		envoy_key = handle.get_envoy_key(),
		"workerd envoy host connected"
	);
	tokio::select! {
		result = shutdown_signal() => result?,
		result = sqlite_server => {
			result.context("sqlite bridge task failed")??;
			anyhow::bail!("sqlite bridge stopped unexpectedly");
		}
		result = management_server => {
			result.context("workerd management task failed")??;
			anyhow::bail!("workerd management server stopped unexpectedly");
		}
	}
	handle.shutdown_and_wait(false).await;
	Ok(())
}

async fn stateless_main() -> Result<()> {
	let namespace = environment("RIVET_NAMESPACE", "default");
	let registry_url = required_environment("RIVET_WORKER_REGISTRY_URL")?;
	let code = Arc::new(WorkerCodeCache::new(
		Some(&registry_url),
		namespace,
		environment(
			"RIVET_WORKER_CODE_CACHE_DIR",
			"/tmp/rivet-stateless-worker-code",
		),
	)?);
	let config = StatelessExecutorConfig {
		listen: environment("RIVET_STATELESS_LISTEN", "0.0.0.0:19084")
			.parse()
			.context("RIVET_STATELESS_LISTEN must be a numeric socket address")?,
		workerd_endpoint: environment("RIVET_WORKERD_ENDPOINT", "http://127.0.0.1:18090"),
		executor_token: required_environment("RIVET_STATELESS_EXECUTOR_TOKEN")?,
		workerd_token: required_environment("RIVET_WORKERD_TOKEN")?,
		max_in_flight: environment(
			"RIVET_WORKERD_MAX_IN_FLIGHT",
			&DEFAULT_WORKERD_MAX_IN_FLIGHT.to_string(),
		)
		.parse()
		.context("RIVET_WORKERD_MAX_IN_FLIGHT must be an integer")?,
		max_queued: environment(
			"RIVET_WORKERD_MAX_QUEUED",
			&DEFAULT_WORKERD_MAX_QUEUED.to_string(),
		)
		.parse()
		.context("RIVET_WORKERD_MAX_QUEUED must be an integer")?,
		queue_timeout_ms: environment(
			"RIVET_WORKERD_QUEUE_TIMEOUT_MS",
			&DEFAULT_WORKERD_QUEUE_TIMEOUT_MS.to_string(),
		)
		.parse()
		.context("RIVET_WORKERD_QUEUE_TIMEOUT_MS must be an integer")?,
	};
	run_stateless_executor(config, code).await
}

async fn shutdown_signal() -> Result<()> {
	#[cfg(unix)]
	{
		let mut terminate =
			tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
				.context("install SIGTERM handler")?;
		tokio::select! {
			result = tokio::signal::ctrl_c() => result.context("listen for SIGINT")?,
			_ = terminate.recv() => {}
		}
	}

	#[cfg(not(unix))]
	tokio::signal::ctrl_c()
		.await
		.context("listen for shutdown signal")?;

	Ok(())
}

fn environment(name: &str, default: &str) -> String {
	std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn required_environment(name: &str) -> Result<String> {
	std::env::var(name).with_context(|| format!("{name} is required"))
}

fn optional_positive_environment(name: &str, maximum: usize) -> Result<Option<usize>> {
	let Some(raw) = std::env::var_os(name) else {
		return Ok(None);
	};
	let value = raw
		.to_str()
		.with_context(|| format!("{name} must be valid UTF-8"))?
		.parse::<usize>()
		.with_context(|| format!("{name} must be an integer"))?;
	ensure!(
		(1..=maximum).contains(&value),
		"{name} must be between 1 and {maximum}"
	);
	Ok(Some(value))
}

fn meta_command(argument: Option<&str>) -> Option<MetaCommand> {
	match argument {
		Some("-h" | "--help") => Some(MetaCommand::Help),
		Some("-V" | "--version") => Some(MetaCommand::Version),
		_ => None,
	}
}

fn runtime_mode(argument: Option<&str>) -> Result<RuntimeMode> {
	match argument {
		None => Ok(RuntimeMode::Durable),
		Some("--mode=stateless") => Ok(RuntimeMode::Stateless),
		Some(value) => anyhow::bail!("unknown argument {value:?}; use --help"),
	}
}

#[cfg(test)]
mod tests {
	use super::{MetaCommand, RuntimeMode, meta_command, runtime_mode};

	#[test]
	fn recognizes_meta_commands_before_runtime_configuration() {
		assert_eq!(meta_command(Some("--help")), Some(MetaCommand::Help));
		assert_eq!(meta_command(Some("-h")), Some(MetaCommand::Help));
		assert_eq!(meta_command(Some("--version")), Some(MetaCommand::Version));
		assert_eq!(meta_command(Some("-V")), Some(MetaCommand::Version));
		assert_eq!(meta_command(None), None);
		assert_eq!(meta_command(Some("--unknown")), None);
	}

	#[test]
	fn selects_explicit_stateless_mode() {
		assert_eq!(runtime_mode(None).unwrap(), RuntimeMode::Durable);
		assert_eq!(
			runtime_mode(Some("--mode=stateless")).unwrap(),
			RuntimeMode::Stateless
		);
		assert!(runtime_mode(Some("--mode=unknown")).is_err());
	}
}
