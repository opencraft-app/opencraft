use std::{
	fs::{self, OpenOptions},
	os::fd::OwnedFd,
	path::PathBuf,
	sync::{
		Arc, Condvar, Mutex,
		atomic::{AtomicBool, Ordering},
	},
	thread::JoinHandle,
	time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use minisandbox_core::{
	control::CommandSpec,
	engine::{
		Engine, PvmBlockPool, PvmLinuxInstance, PvmLinuxTemplate, PvmReadOnlyImage, RunOptions,
		RunOutcome,
	},
	pvm_linux::{MAX_PVM_LINUX_MEMORY_SIZE, READ_ONLY_APP_GPA, READ_ONLY_ROOTFS_GPA},
};
use minisandbox_pvm_sys::{
	PVM_VIRTIO_BLK_DATA_IRQ_GSI, PVM_VIRTIO_BLK_DATA_MMIO_BASE, PVM_VIRTIO_BLK_IRQ_GSI,
	PVM_VIRTIO_BLK_MMIO_BASE, PvmRunCanceller,
};
use pvm_socket_service::SocketIngressHandle;
use rivet_envoy_client::config::BoxFuture;
use rivet_minisandbox_host::{
	LocalSandbox, LocalSandboxFactory, MinisandboxRuntimeProfile, SandboxCreateRequest,
	SandboxDestroyReason,
};

mod actor_volume;
mod native_actor_volume;

pub use actor_volume::{ActorBlockVolumeAttachment, ActorBlockVolumeProvider};
pub use native_actor_volume::NativeActorBlockVolumeProvider;

const COMMON_COMMAND_LINE: &str = "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 acpi=off pci=off noapic clocksource=tsc tsc=reliable quiet loglevel=3";
const DEFAULT_SHM_MIB: usize = 1024;
const WARM_TIMEOUT: Duration = Duration::from_secs(180);
const CONTROL_READY_TIMEOUT: Duration = Duration::from_secs(10);
const GATEWAY_READY_TIMEOUT: Duration = Duration::from_secs(100);
const GUEST_SHUTDOWN_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const GUEST_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const RUN_SLICE: Duration = Duration::from_secs(30 * 60);
const HERMES_WARM_MARKER: &[u8] = b"MINISANDBOX_HERMES_WARM_READY";
const HERMES_GATEWAY_MARKER: &[u8] = b"MINISANDBOX_HERMES_GATEWAY_READY";
type PvmRunner = JoinHandle<Result<(), String>>;
type SharedPvmRunner = Arc<Mutex<Option<PvmRunner>>>;

#[derive(Default)]
struct PvmRunnerCompletion {
	finished: Mutex<bool>,
	changed: Condvar,
}

impl PvmRunnerCompletion {
	fn finish(&self) {
		*self
			.finished
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner) = true;
		self.changed.notify_all();
	}

	fn wait(&self, timeout: Duration) -> bool {
		let finished = self
			.finished
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner);
		let (finished, _) = self
			.changed
			.wait_timeout_while(finished, timeout, |finished| !*finished)
			.unwrap_or_else(std::sync::PoisonError::into_inner);
		*finished
	}
}

#[derive(Clone, Debug)]
pub struct HermesProfileConfig {
	pub profile: MinisandboxRuntimeProfile,
	pub kernel_path: PathBuf,
	pub base_path: PathBuf,
	pub app_path: PathBuf,
	pub upper_path: PathBuf,
	pub block_pool_path: PathBuf,
	pub memory_mib: usize,
	pub api_key: String,
}

pub struct HermesPvmFactory {
	profile: MinisandboxRuntimeProfile,
	api_key: Arc<str>,
	engine: Arc<Engine>,
	template: Arc<PvmLinuxTemplate>,
	actor_volumes: Option<actor_volume::SharedActorBlockVolumeProvider>,
}

impl HermesPvmFactory {
	pub fn warm(config: HermesProfileConfig) -> Result<Self> {
		ensure!(
			!config.api_key.is_empty()
				&& config.api_key.len() <= 4096
				&& !config.api_key.as_bytes().contains(&0),
			"Hermes API key must contain between 1 and 4096 non-NUL bytes"
		);
		ensure!(config.memory_mib > 0, "Hermes memory must be non-zero");
		let memory_size = config
			.memory_mib
			.checked_mul(1024 * 1024)
			.context("Hermes memory size overflowed")?;
		ensure!(
			memory_size <= MAX_PVM_LINUX_MEMORY_SIZE,
			"Hermes memory exceeds the PVM Linux maximum"
		);
		let kernel = fs::read(&config.kernel_path)
			.with_context(|| format!("read PVM Linux kernel {}", config.kernel_path.display()))?;
		let base = open_read_only_image(&config.base_path, "base EROFS")?;
		let app = open_read_only_image(&config.app_path, "Hermes EROFS")?;
		let upper = OpenOptions::new()
			.read(true)
			.write(true)
			.open(&config.upper_path)
			.with_context(|| format!("open writable layer {}", config.upper_path.display()))?;
		fs::create_dir_all(&config.block_pool_path).with_context(|| {
			format!(
				"create block pool directory {}",
				config.block_pool_path.display()
			)
		})?;
		let pool_directory = fs::File::open(&config.block_pool_path).with_context(|| {
			format!(
				"open block pool directory {}",
				config.block_pool_path.display()
			)
		})?;
		let pool = PvmBlockPool::from_directory(pool_directory)
			.map_err(|error| anyhow::anyhow!("create PVM block pool: {error}"))?;
		let shm_mib = DEFAULT_SHM_MIB.min(config.memory_mib / 2).max(32);
		let command_line = format!(
			"{COMMON_COMMAND_LINE} memmap={:#x}!{READ_ONLY_ROOTFS_GPA:#x} \
			 memmap={:#x}!{READ_ONLY_APP_GPA:#x} \
			 root=/dev/pmem0 rootfstype=erofs rootflags=dax=always ro \
			 init=/sbin/minisandbox-init minisandbox.overlay=1 minisandbox.app_layer=1 \
			 minisandbox.shm_mib={shm_mib} \
			 virtio_mmio.device=4K@{PVM_VIRTIO_BLK_MMIO_BASE:#x}:{PVM_VIRTIO_BLK_IRQ_GSI} \
			 virtio_mmio.device=4K@{PVM_VIRTIO_BLK_DATA_MMIO_BASE:#x}:{PVM_VIRTIO_BLK_DATA_IRQ_GSI}",
			base.len(),
			app.len()
		);
		let engine =
			Arc::new(Engine::open().map_err(|error| {
				anyhow::anyhow!("open PVM provider for Hermes profile: {error:?}")
			})?);
		let template = engine
			.warm_pvm_linux_template_with_layered_storage(
				&kernel,
				&[],
				command_line.as_bytes(),
				memory_size,
				&base,
				&app,
				upper,
				&pool,
				RunOptions {
					timeout: WARM_TIMEOUT,
				},
			)
			.map_err(|error| anyhow::anyhow!("warm Hermes PVM template: {error:?}"))?;
		ensure!(
			contains(template.warm_output(), HERMES_WARM_MARKER),
			"Hermes template did not publish its warm-ready marker"
		);
		tracing::info!(
			profile_id = config.profile.profile_id(),
			memory_mib = config.memory_mib,
			warm_ms = template.warmup_latency().as_secs_f64() * 1_000.0,
			snapshot_ms = template.snapshot_latency().as_secs_f64() * 1_000.0,
			"warmed minisandbox profile"
		);
		Ok(Self {
			profile: config.profile,
			api_key: Arc::from(config.api_key),
			engine,
			template: Arc::new(template),
			actor_volumes: None,
		})
	}

	/// Installs the trusted ActorBlockVolume writer-session bridge.
	#[must_use]
	pub fn with_actor_block_volume_provider(
		mut self,
		provider: Arc<dyn ActorBlockVolumeProvider>,
	) -> Self {
		self.actor_volumes = Some(provider);
		self
	}
}

impl LocalSandboxFactory for HermesPvmFactory {
	fn create(&self, request: SandboxCreateRequest) -> BoxFuture<Result<Arc<dyn LocalSandbox>>> {
		let profile = self.profile.clone();
		let api_key = self.api_key.clone();
		let engine = self.engine.clone();
		let template = self.template.clone();
		let actor_volumes = self.actor_volumes.clone();
		Box::pin(async move {
			ensure!(
				request.profile == profile,
				"requested minisandbox profile is not registered in this sbxlet"
			);
			ensure!(
				request.launch_input.as_ref().is_none_or(Vec::is_empty),
				"Hermes launch input requires a typed profile schema"
			);
			let identity = request.identity;
			tokio::task::spawn_blocking(move || {
				let has_actor_volume = actor_volumes.is_some();
				let instance = if let Some(provider) = actor_volumes {
					let attachment = provider.open_writer(&identity).with_context(|| {
						format!(
							"acquire ActorBlockVolume writer for {}@{}",
							identity.actor_id, identity.generation
						)
					})?;
					engine
						.clone_pvm_linux_template_with_actor_volume_backend(
							&template,
							attachment.volume,
						)
						.map_err(|error| anyhow::anyhow!("clone Hermes PVM template: {error:?}"))?
				} else {
					engine
						.clone_pvm_linux_template(&template)
						.map_err(|error| anyhow::anyhow!("clone Hermes PVM template: {error:?}"))?
				};
				let sandbox = Arc::new(PvmLocalSandbox::start(instance)?);
				if has_actor_volume && let Err(error) = actor_volume::mount(&sandbox.control) {
					if let Err(cleanup_error) = sandbox.cancel_and_join() {
						tracing::warn!(?cleanup_error, "failed to clean up unmounted PVM sandbox");
					}
					return Err(error).with_context(|| {
						format!(
							"mount ActorBlockVolume for {}@{}",
							identity.actor_id, identity.generation
						)
					});
				}
				if let Err(error) =
					launch_hermes_gateway(&sandbox.control, &api_key, profile.ingress_port())
				{
					if let Err(cleanup_error) = sandbox.cancel_and_join() {
						tracing::warn!(?cleanup_error, "failed to clean up rejected PVM sandbox");
					}
					return Err(error).with_context(|| {
						format!(
							"launch Hermes for {}@{}",
							identity.actor_id, identity.generation
						)
					});
				}
				Ok(sandbox as Arc<dyn LocalSandbox>)
			})
			.await
			.context("Hermes PVM create worker panicked")?
		})
	}
}

struct PvmLocalSandbox {
	control: minisandbox_core::control::SandboxControl,
	ingress: SocketIngressHandle,
	canceller: PvmRunCanceller,
	runner: SharedPvmRunner,
	completion: Arc<PvmRunnerCompletion>,
	shutdown_requested: Arc<AtomicBool>,
	teardown_started: Arc<AtomicBool>,
}

impl PvmLocalSandbox {
	fn start(mut instance: PvmLinuxInstance) -> Result<Self> {
		let control = instance.sandbox_control();
		let ingress = instance.socket_ingress();
		let canceller = instance.run_canceller();
		let completion = Arc::new(PvmRunnerCompletion::default());
		let runner_completion = completion.clone();
		let shutdown_requested = Arc::new(AtomicBool::new(false));
		let runner_shutdown_requested = shutdown_requested.clone();
		let runner = std::thread::Builder::new()
			.name("minisandbox-pvm".to_owned())
			.spawn(move || {
				let result = run_instance(&mut instance, &runner_shutdown_requested);
				// Closing the instance stops both block workers and drops the fenced
				// ActorVolume writer before teardown waiters observe completion.
				drop(instance);
				runner_completion.finish();
				result
			})
			.context("spawn PVM runner thread")?;
		let sandbox = Self {
			control,
			ingress,
			canceller,
			runner: Arc::new(Mutex::new(Some(runner))),
			completion,
			shutdown_requested,
			teardown_started: Arc::new(AtomicBool::new(false)),
		};
		if let Err(error) = wait_for_control(&sandbox.control) {
			if let Err(cleanup_error) = sandbox.cancel_and_join() {
				tracing::warn!(?cleanup_error, "failed to clean up unready PVM sandbox");
			}
			return Err(error);
		}
		Ok(sandbox)
	}

	fn cancel_and_join(&self) -> Result<()> {
		self.canceller.cancel().context("cancel PVM runner")?;
		let runner = self
			.runner
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner)
			.take();
		if let Some(runner) = runner {
			runner
				.join()
				.map_err(|_| anyhow::anyhow!("PVM runner thread panicked"))?
				.map_err(anyhow::Error::msg)?;
		}
		Ok(())
	}
}

impl Drop for PvmLocalSandbox {
	fn drop(&mut self) {
		let _ = self.canceller.cancel();
	}
}

impl LocalSandbox for PvmLocalSandbox {
	fn open_ingress(&self, guest_port: u16) -> BoxFuture<Result<OwnedFd>> {
		let ingress = self.ingress.clone();
		Box::pin(async move {
			let stream = ingress
				.connect_tcp_with_timeout_async(guest_port, Duration::from_secs(5))
				.await
				.map_err(|error| anyhow::anyhow!("open PVM guest ingress: {error}"))?;
			Ok(stream.into())
		})
	}

	fn destroy(&self, reason: SandboxDestroyReason) -> BoxFuture<Result<()>> {
		let control = self.control.clone();
		let canceller = self.canceller.clone();
		let runner = self.runner.clone();
		let completion = self.completion.clone();
		let shutdown_requested = self.shutdown_requested.clone();
		let teardown_started = self.teardown_started.clone();
		Box::pin(async move {
			tokio::task::spawn_blocking(move || {
				let first = teardown_started
					.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
					.is_ok();
				if first && should_attempt_graceful_shutdown(reason) {
					shutdown_requested.store(true, Ordering::Release);
					if let Err(error) = request_guest_shutdown(&control) {
						// SIGTERM can close the control agent after delivery but before
						// its command reply reaches the host. Wait for guest completion
						// even on this error; timeout fallback remains fenced and safe.
						tracing::warn!(?error, ?reason, "PVM graceful shutdown request failed");
					}
				}

				if (first && !should_attempt_graceful_shutdown(reason))
					|| !completion.wait(GUEST_SHUTDOWN_TIMEOUT)
				{
					canceller.cancel().context("cancel PVM runner")?;
				}
				let join = runner
					.lock()
					.unwrap_or_else(std::sync::PoisonError::into_inner)
					.take();
				if let Some(join) = join {
					join.join()
						.map_err(|_| anyhow::anyhow!("PVM runner thread panicked"))?
						.map_err(anyhow::Error::msg)?;
				}
				Ok(())
			})
			.await
			.context("PVM destroy worker panicked")?
		})
	}
}

fn should_attempt_graceful_shutdown(reason: SandboxDestroyReason) -> bool {
	!matches!(reason, SandboxDestroyReason::Lost)
}

fn request_guest_shutdown(control: &minisandbox_core::control::SandboxControl) -> Result<()> {
	let output = control
		.execute(&guest_shutdown_command(), GUEST_SHUTDOWN_REQUEST_TIMEOUT)
		.context("request guest PID 1 shutdown")?;
	ensure!(
		output.exit_code == 0,
		"guest PID 1 shutdown command failed with exit code {}",
		output.exit_code
	);
	Ok(())
}

fn guest_shutdown_command() -> CommandSpec {
	CommandSpec::new("/usr/bin/kill").args(["-TERM", "1"])
}

fn run_instance(
	instance: &mut PvmLinuxInstance,
	shutdown_requested: &AtomicBool,
) -> Result<(), String> {
	loop {
		let result = instance
			.run_for(RunOptions { timeout: RUN_SLICE })
			.map_err(|error| format!("PVM runner failed: {error:?}"))?;
		if !result.output.is_empty() {
			tracing::debug!(
				output_bytes = result.output.len(),
				"guest emitted console output"
			);
		}
		match result.outcome {
			RunOutcome::TimedOut => {}
			RunOutcome::Cancelled => return Ok(()),
			RunOutcome::Exited { code } if shutdown_requested.load(Ordering::Acquire) => {
				tracing::debug!(code, "PVM guest completed graceful shutdown");
				return Ok(());
			}
			outcome => return Err(format!("PVM guest stopped unexpectedly: {outcome:?}")),
		}
	}
}

fn wait_for_control(control: &minisandbox_core::control::SandboxControl) -> Result<()> {
	let deadline = Instant::now() + CONTROL_READY_TIMEOUT;
	loop {
		match control.ping(Duration::from_secs(1)) {
			Ok(()) => return Ok(()),
			Err(error) if Instant::now() < deadline => {
				tracing::debug!(?error, "waiting for restored guest control agent");
				std::thread::sleep(Duration::from_millis(10));
			}
			Err(error) => return Err(error).context("restored guest control agent is not ready"),
		}
	}
}

fn launch_hermes_gateway(
	control: &minisandbox_core::control::SandboxControl,
	api_key: &str,
	guest_port: u16,
) -> Result<()> {
	let command = CommandSpec::new("/opt/hermes/.venv/bin/python")
		.args([
			"/opt/minisandbox/hermes-launch.py",
			"--timeout",
			"90",
			"--env",
			"API_SERVER_ENABLED",
			"--env",
			"API_SERVER_HOST",
			"--env",
			"API_SERVER_PORT",
			"--env",
			"API_SERVER_KEY",
		])
		.env("API_SERVER_ENABLED", "true")
		.env("API_SERVER_HOST", "127.0.0.1")
		.env("API_SERVER_PORT", guest_port.to_string())
		.env("API_SERVER_KEY", api_key);
	let output = control
		.execute(&command, GATEWAY_READY_TIMEOUT)
		.context("execute Hermes gateway launcher")?;
	ensure!(
		output.exit_code == 0 && contains(&output.stdout, HERMES_GATEWAY_MARKER),
		"Hermes gateway launcher failed with exit code {} and {} stderr bytes",
		output.exit_code,
		output.stderr.len()
	);
	Ok(())
}

fn open_read_only_image(path: &std::path::Path, label: &str) -> Result<PvmReadOnlyImage> {
	let file = fs::File::open(path).with_context(|| format!("open {label} {}", path.display()))?;
	PvmReadOnlyImage::from_file(file)
		.map_err(|error| anyhow::anyhow!("map {label} {}: {error}", path.display()))
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
	haystack
		.windows(needle.len())
		.any(|window| window == needle)
}

#[cfg(test)]
mod tests {
	use std::{ffi::OsStr, time::Duration};

	use rivet_minisandbox_host::SandboxDestroyReason;

	use super::{PvmRunnerCompletion, guest_shutdown_command, should_attempt_graceful_shutdown};

	#[test]
	fn only_lost_sandbox_skips_guest_shutdown() {
		for reason in [
			SandboxDestroyReason::SleepIntent,
			SandboxDestroyReason::StopIntent,
			SandboxDestroyReason::Destroy,
			SandboxDestroyReason::GoingAway,
			SandboxDestroyReason::Lost,
			SandboxDestroyReason::Replaced,
		] {
			assert_eq!(
				should_attempt_graceful_shutdown(reason),
				reason != SandboxDestroyReason::Lost
			);
		}
	}

	#[test]
	fn graceful_shutdown_uses_a_fixed_direct_executable() {
		assert_eq!(
			guest_shutdown_command().program(),
			OsStr::new("/usr/bin/kill")
		);
	}

	#[test]
	fn runner_completion_wait_is_event_driven() {
		let completion = PvmRunnerCompletion::default();
		assert!(!completion.wait(Duration::ZERO));
		completion.finish();
		assert!(completion.wait(Duration::ZERO));
	}
}
