use std::{
	collections::HashMap,
	io::ErrorKind,
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use minisandbox_fdb_adapter::{
	CachedChunkStore, ChunkCache, CosChunkStore, open_foundationdb_metastore,
};
use rivet_envoy_client::{config::EnvoyConfig, envoy::start_envoy};
use rivet_minisandbox_host::{
	LocalSbxletBackend, MinisandboxEnvoyCallbacks, MinisandboxHost, MinisandboxRuntimeProfile,
};
use rivet_sbxlet::{HermesProfileConfig, HermesPvmFactory, NativeActorBlockVolumeProvider};
use tokio::{sync::watch, task::JoinHandle};
use tracing_subscriber::EnvFilter;

const METRICS_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MetaCommand {
	Help,
	Version,
}

#[tokio::main]
async fn main() -> Result<()> {
	match meta_command(std::env::args().nth(1).as_deref()) {
		Some(MetaCommand::Help) => {
			println!(
				"sbxlet {}\n\nPVM minisandbox execution host for Rivet Actors.\n\nUSAGE:\n    sbxlet\n\nREQUIRED ENVIRONMENT:\n    RIVET_MINISANDBOX_KERNEL\n    RIVET_MINISANDBOX_BASE_EROFS\n    RIVET_MINISANDBOX_APP_EROFS\n    RIVET_MINISANDBOX_UPPER\n    RIVET_MINISANDBOX_BLOCK_POOL\n    RIVET_MINISANDBOX_HERMES_API_KEY\n\nOPTIONAL NATIVE ACTOR BLOCK VOLUME:\n    RIVET_MINISANDBOX_ACTOR_VOLUME_MIB\n    RIVET_MINISANDBOX_ACTOR_VOLUME_TEMPLATE\n    RIVET_MINISANDBOX_ACTOR_VOLUME_TEMPLATE_ID\n    RIVET_MINISANDBOX_FDB_CLUSTER_FILE\n    RIVET_MINISANDBOX_COS_BUCKET\n    RIVET_MINISANDBOX_COS_ENDPOINT\n    RIVET_MINISANDBOX_COS_REGION\n    RIVET_MINISANDBOX_BLOCK_CACHE (default /data/minisandbox/block-cache)",
				env!("CARGO_PKG_VERSION")
			);
			return Ok(());
		}
		Some(MetaCommand::Version) => {
			println!("sbxlet {}", env!("CARGO_PKG_VERSION"));
			return Ok(());
		}
		None => {}
	}

	tracing_subscriber::fmt()
		.with_env_filter(EnvFilter::from_default_env())
		.try_init()
		.ok();
	let readiness = ReadinessFile::from_environment()?;

	let profile = MinisandboxRuntimeProfile::new(
		environment("RIVET_MINISANDBOX_PROFILE", "hermes-v1"),
		environment("RIVET_MINISANDBOX_GUEST_PORT", "8642")
			.parse()
			.context("RIVET_MINISANDBOX_GUEST_PORT must be a u16")?,
	)?;
	let actor_volume_provider =
		if let Ok(value) = std::env::var("RIVET_MINISANDBOX_ACTOR_VOLUME_MIB") {
			let size_mib: u64 = value
				.parse()
				.context("RIVET_MINISANDBOX_ACTOR_VOLUME_MIB must be an integer")?;
			let logical_size = mib(size_mib, "RIVET_MINISANDBOX_ACTOR_VOLUME_MIB")?;
			let hot_bytes = mib(
				environment("RIVET_MINISANDBOX_FDB_HOT_MIB", "64").parse()?,
				"RIVET_MINISANDBOX_FDB_HOT_MIB",
			)?;
			let metadata = open_foundationdb_metastore(
				std::env::var_os("RIVET_MINISANDBOX_FDB_CLUSTER_FILE").map(PathBuf::from),
				environment("RIVET_MINISANDBOX_FDB_PREFIX", "minisandbox/block/v1/").into_bytes(),
				hot_bytes,
			)?;
			let cold = Arc::new(
				CosChunkStore::from_env(
					required_environment("RIVET_MINISANDBOX_COS_BUCKET")?,
					std::env::var("RIVET_MINISANDBOX_COS_ENDPOINT").ok(),
					environment("RIVET_MINISANDBOX_COS_REGION", "ap-guangzhou"),
					environment("RIVET_MINISANDBOX_COS_FORCE_PATH_STYLE", "false").parse()?,
				)
				.await?,
			);
			let cache = Arc::new(ChunkCache::open(
				environment(
					"RIVET_MINISANDBOX_BLOCK_CACHE",
					"/data/minisandbox/block-cache",
				),
				mib(
					environment("RIVET_MINISANDBOX_BLOCK_CACHE_RAM_MIB", "256").parse()?,
					"RIVET_MINISANDBOX_BLOCK_CACHE_RAM_MIB",
				)?,
				mib(
					environment("RIVET_MINISANDBOX_BLOCK_CACHE_DISK_MIB", "4096").parse()?,
					"RIVET_MINISANDBOX_BLOCK_CACHE_DISK_MIB",
				)?,
			)?);
			let chunks = Arc::new(CachedChunkStore::new(cold, cache));
			Some(Arc::new(NativeActorBlockVolumeProvider::new(
				tokio::runtime::Handle::current(),
				metadata,
				chunks,
				logical_size,
				required_path("RIVET_MINISANDBOX_ACTOR_VOLUME_TEMPLATE")?,
				required_environment("RIVET_MINISANDBOX_ACTOR_VOLUME_TEMPLATE_ID")?,
			)?))
		} else {
			None
		};
	let memory_mib = environment("RIVET_MINISANDBOX_MEMORY_MIB", "2048")
		.parse()
		.context("RIVET_MINISANDBOX_MEMORY_MIB must be an integer")?;
	let mut factory = HermesPvmFactory::warm(HermesProfileConfig {
		profile: profile.clone(),
		kernel_path: required_path("RIVET_MINISANDBOX_KERNEL")?,
		base_path: required_path("RIVET_MINISANDBOX_BASE_EROFS")?,
		app_path: required_path("RIVET_MINISANDBOX_APP_EROFS")?,
		upper_path: required_path("RIVET_MINISANDBOX_UPPER")?,
		block_pool_path: required_path("RIVET_MINISANDBOX_BLOCK_POOL")?,
		memory_mib,
		api_key: required_environment("RIVET_MINISANDBOX_HERMES_API_KEY")?,
	})?;
	if let Some(provider) = &actor_volume_provider {
		factory = factory.with_actor_block_volume_provider(provider.clone());
	}
	let factory = Arc::new(factory);
	let backend = Arc::new(LocalSbxletBackend::new(factory));
	let host = Arc::new(MinisandboxHost::new(backend, profile.clone()));
	let metrics = MetricsPublisher::start(host.clone(), memory_mib).await?;
	let callbacks = Arc::new(MinisandboxEnvoyCallbacks::new(host));
	let pool_name = environment("RIVET_POOL_NAME", "minisandbox-hermes-v1");
	let handle = start_envoy(EnvoyConfig {
		version: environment("RIVET_ENVOY_VERSION", "1").parse()?,
		endpoint: environment("RIVET_ENDPOINT", "http://127.0.0.1:6420"),
		token: Some(environment("RIVET_TOKEN", "dev")),
		namespace: environment("RIVET_NAMESPACE", "default"),
		pool_name: pool_name.clone(),
		prepopulate_actor_names: HashMap::new(),
		metadata: Some(serde_json::json!({
			"runtime": "minisandbox",
			"profile": profile.profile_id(),
			"guest_port": profile.ingress_port(),
			"backend": "local-sbxlet",
			"actor_block_volume": actor_volume_provider.is_some(),
		})),
		not_global: true,
		debug_latency_ms: None,
		callbacks,
	})
	.await;
	tracing::info!(
		envoy_key = handle.get_envoy_key(),
		%pool_name,
		profile_id = profile.profile_id(),
		"minisandbox Envoy host connected"
	);
	readiness.mark_ready()?;
	shutdown_signal().await?;
	handle.shutdown_and_wait(false).await;
	if let Some(metrics) = metrics {
		metrics.shutdown().await;
	}
	Ok(())
}

struct MetricsPublisher {
	stop: watch::Sender<bool>,
	task: JoinHandle<()>,
}

impl MetricsPublisher {
	async fn start(host: Arc<MinisandboxHost>, memory_mib: usize) -> Result<Option<Self>> {
		let Some(path) = std::env::var_os("RIVET_MINISANDBOX_METRICS_FILE").map(PathBuf::from)
		else {
			return Ok(None);
		};
		publish_metrics(&path, host.active_count().await, memory_mib).await?;
		let (stop, mut stop_rx) = watch::channel(false);
		let task = tokio::spawn(async move {
			let mut interval = tokio::time::interval(METRICS_INTERVAL);
			interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
			loop {
				tokio::select! {
					_ = interval.tick() => {
						if let Err(error) = publish_metrics(&path, host.active_count().await, memory_mib).await {
							tracing::warn!(?error, path = %path.display(), "failed to publish sbxlet metrics");
						}
					}
					result = stop_rx.changed() => {
						if result.is_err() || *stop_rx.borrow() {
							break;
						}
					}
				}
			}
		});
		Ok(Some(Self { stop, task }))
	}

	async fn shutdown(self) {
		let _ = self.stop.send(true);
		if let Err(error) = self.task.await {
			tracing::warn!(?error, "sbxlet metrics publisher did not shut down cleanly");
		}
	}
}

async fn publish_metrics(path: &Path, active_actors: usize, memory_mib: usize) -> Result<()> {
	let timestamp = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.context("system clock predates Unix epoch")?
		.as_secs();
	let contents = render_metrics(active_actors, memory_mib, timestamp);
	let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
	tokio::fs::write(&temporary, contents)
		.await
		.with_context(|| format!("write temporary metrics file {}", temporary.display()))?;
	tokio::fs::rename(&temporary, path)
		.await
		.with_context(|| format!("publish metrics file {}", path.display()))?;
	Ok(())
}

fn render_metrics(active_actors: usize, memory_mib: usize, timestamp: u64) -> String {
	format!(
		"# HELP rivet_minisandbox_active_actors Actor generations currently admitted by this sbxlet.\n\
# TYPE rivet_minisandbox_active_actors gauge\n\
rivet_minisandbox_active_actors {active_actors}\n\
# HELP rivet_minisandbox_memory_mib_per_actor Configured guest virtual memory per active PVM actor.\n\
# TYPE rivet_minisandbox_memory_mib_per_actor gauge\n\
rivet_minisandbox_memory_mib_per_actor {memory_mib}\n\
# HELP rivet_minisandbox_metrics_last_collection_timestamp_seconds Unix timestamp of the latest sbxlet aggregate.\n\
# TYPE rivet_minisandbox_metrics_last_collection_timestamp_seconds gauge\n\
rivet_minisandbox_metrics_last_collection_timestamp_seconds {timestamp}\n"
	)
}

fn mib(value: u64, name: &str) -> Result<u64> {
	value
		.checked_mul(1024 * 1024)
		.with_context(|| format!("{name} overflowed"))
}

struct ReadinessFile {
	path: Option<PathBuf>,
}

impl ReadinessFile {
	fn from_environment() -> Result<Self> {
		let readiness = Self {
			path: std::env::var_os("RIVET_READINESS_FILE").map(PathBuf::from),
		};
		readiness.remove_stale()?;
		Ok(readiness)
	}

	fn mark_ready(&self) -> Result<()> {
		let Some(path) = &self.path else {
			return Ok(());
		};
		if let Some(parent) = path
			.parent()
			.filter(|parent| !parent.as_os_str().is_empty())
		{
			std::fs::create_dir_all(parent)
				.with_context(|| format!("create readiness directory {}", parent.display()))?;
		}
		let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
		std::fs::write(&temporary, b"ready\n")
			.with_context(|| format!("write readiness file {}", temporary.display()))?;
		std::fs::rename(&temporary, path)
			.with_context(|| format!("publish readiness file {}", path.display()))?;
		Ok(())
	}

	fn remove_stale(&self) -> Result<()> {
		let Some(path) = &self.path else {
			return Ok(());
		};
		remove_if_present(path)
	}
}

impl Drop for ReadinessFile {
	fn drop(&mut self) {
		if let Some(path) = &self.path
			&& let Err(error) = remove_if_present(path)
		{
			tracing::warn!(?error, path = %path.display(), "failed to remove sbxlet readiness file");
		}
	}
}

fn remove_if_present(path: &Path) -> Result<()> {
	match std::fs::remove_file(path) {
		Ok(()) => Ok(()),
		Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
		Err(error) => {
			Err(error).with_context(|| format!("remove readiness file {}", path.display()))
		}
	}
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
	std::env::var(name).unwrap_or_else(|_| default.to_owned())
}

fn required_environment(name: &str) -> Result<String> {
	std::env::var(name).with_context(|| format!("{name} is required"))
}

fn required_path(name: &str) -> Result<PathBuf> {
	Ok(PathBuf::from(required_environment(name)?))
}

fn meta_command(argument: Option<&str>) -> Option<MetaCommand> {
	match argument {
		Some("-h" | "--help") => Some(MetaCommand::Help),
		Some("-V" | "--version") => Some(MetaCommand::Version),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::{MetaCommand, ReadinessFile, meta_command, render_metrics};

	#[test]
	fn recognizes_meta_commands_before_pvm_configuration() {
		assert_eq!(meta_command(Some("--help")), Some(MetaCommand::Help));
		assert_eq!(meta_command(Some("-h")), Some(MetaCommand::Help));
		assert_eq!(meta_command(Some("--version")), Some(MetaCommand::Version));
		assert_eq!(meta_command(Some("-V")), Some(MetaCommand::Version));
		assert_eq!(meta_command(None), None);
		assert_eq!(meta_command(Some("--unknown")), None);
	}

	#[test]
	fn metrics_are_bounded_aggregates() {
		let metrics = render_metrics(7, 2048, 42);
		assert!(metrics.contains("rivet_minisandbox_active_actors 7\n"));
		assert!(metrics.contains("rivet_minisandbox_memory_mib_per_actor 2048\n"));
		assert!(
			metrics.contains("rivet_minisandbox_metrics_last_collection_timestamp_seconds 42\n")
		);
		assert!(!metrics.contains("actor_id"));
	}

	#[test]
	fn readiness_file_is_published_and_removed_with_owner() {
		let path = std::env::temp_dir().join(format!(
			"sbxlet-readiness-test-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		));
		let readiness = ReadinessFile {
			path: Some(path.clone()),
		};
		readiness.mark_ready().unwrap();
		assert_eq!(std::fs::read(&path).unwrap(), b"ready\n");
		drop(readiness);
		assert!(!path.exists());
	}
}
