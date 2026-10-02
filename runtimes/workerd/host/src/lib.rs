use std::{
	collections::HashMap,
	hash::{Hash, Hasher},
	io,
	sync::{
		Arc, OnceLock, RwLock,
		atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
	},
	time::Duration,
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use base64::{Engine, prelude::BASE64_STANDARD};
use futures_util::{StreamExt, stream};
use reqwest::{Method, Url, header::HeaderMap};
use rivet_envoy_client::{
	config::{
		BoxFuture, EnvoyCallbacks, HttpRequest, HttpResponse, WebSocketHandler, WebSocketSender,
	},
	handle::EnvoyHandle,
	protocol,
};
use tokio::sync::{Mutex, OwnedSemaphorePermit, RwLock as AsyncRwLock, Semaphore, TryAcquireError};
use tokio_stream::wrappers::UnboundedReceiverStream;

mod sqlite_bridge;
mod stateless;
mod worker_code;

pub use sqlite_bridge::{
	WorkerdSqliteBackend, WorkerdSqliteBridge, sqlite_bridge_router,
	sqlite_bridge_router_with_host, workerd_management_router,
};
pub use stateless::{
	RIVET_STATELESS_EXECUTOR_TOKEN_HEADER, StatelessExecutorConfig, run_stateless_executor,
	stateless_executor_router,
};
pub use worker_code::{WorkerCodeCache, worker_code_router};

pub const RIVET_ACTOR_ID_HEADER: &str = "x-rivet-actor-id";
pub const RIVET_ACTOR_GENERATION_HEADER: &str = "x-rivet-actor-generation";
pub const RIVET_WORKERD_TOKEN_HEADER: &str = "x-rivet-workerd-token";
pub const RIVET_WORKER_NAME_HEADER: &str = "x-rivet-worker-name";
pub const RIVET_WORKER_VERSION_HEADER: &str = "x-rivet-worker-version";
pub const RIVET_DURABLE_OBJECT_CLASS_HEADER: &str = "x-rivet-durable-object-class";
pub const RIVET_WORKERD_MANAGEMENT_PREFIX: &str = "/__rivet/";
pub const RIVET_WORKERD_EVICT_PATH: &str = "/__rivet/evict";
pub const RIVET_WORKERD_HEALTH_PATH: &str = "/__rivet/healthz";
pub const RIVET_WORKERD_PREPARE_PATH: &str = "/__rivet/prepare";

const ACTOR_LOCK_SHARDS: usize = 1_024;
const MAX_ACTOR_ID_BYTES: usize = 128;
const MAX_RESPONSE_BODY_BYTES: usize = 20 * 1024 * 1024;
pub const DEFAULT_WORKERD_MAX_IN_FLIGHT: usize = 16;
pub const DEFAULT_WORKERD_MAX_QUEUED: usize = 64;
pub const DEFAULT_WORKERD_QUEUE_TIMEOUT_MS: u64 = 15_000;
pub const DEFAULT_WORKERD_IDLE_SLEEP_MS: u64 = 30_000;
// These are loopback management calls, not user fetches. Leaving one
// unbounded can strand an Envoy stop callback forever and prevent Pegboard
// from completing a terminal Actor destroy.
const WORKERD_CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const IDLE_SLEEP_INTENT_RETRY_INTERVAL: Duration = Duration::from_secs(5);
pub const MAX_WORKERD_ACTIVE_ACTORS: usize = 1_000_000;
pub const MAX_WORKERD_IDLE_SLEEP_MS: u64 = 24 * 60 * 60 * 1_000;
const DURABLE_OBJECT_ACTOR_INPUT_SCHEMA: &str = "minisandbox-durable-object/v1";
const MAX_WORKERD_MAX_IN_FLIGHT: usize = 4_096;
const MAX_WORKERD_MAX_QUEUED: usize = 16_384;
const MAX_WORKERD_QUEUE_TIMEOUT_MS: u64 = 5 * 60 * 1_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct WorkerdAdmissionStats {
	pub in_flight: usize,
	pub queued: usize,
	pub peak_in_flight: usize,
	pub peak_queued: usize,
	pub queued_total: u64,
	pub rejected_total: u64,
	pub timed_out_total: u64,
	pub max_in_flight: usize,
	pub max_queued: usize,
	pub queue_timeout_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct WorkerdActorIdentity {
	pub actor_id: String,
	pub generation: u32,
}

impl WorkerdActorIdentity {
	pub fn new(actor_id: impl Into<String>, generation: u32) -> Result<Self> {
		let identity = Self {
			actor_id: actor_id.into(),
			generation,
		};
		identity.validate()?;
		Ok(identity)
	}

	pub fn isolate_name(&self) -> String {
		format!("rivet-v1:{}:{}", self.generation, self.actor_id)
	}

	fn validate(&self) -> Result<()> {
		ensure!(
			!self.actor_id.is_empty()
				&& self.actor_id.len() <= MAX_ACTOR_ID_BYTES
				&& self
					.actor_id
					.bytes()
					.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')),
			"actor_id must be a non-empty, bounded Rivet ID"
		);
		ensure!(self.generation > 0, "generation must be a non-zero u32");
		Ok(())
	}
}

pub trait WorkerdTransport: Send + Sync + 'static {
	fn health(&self) -> BoxFuture<Result<()>>;
	fn prepare(
		&self,
		_identity: WorkerdActorIdentity,
		_worker: protocol::WorkerVersionReference,
		_durable_object_class: Option<String>,
	) -> BoxFuture<Result<()>> {
		Box::pin(async { bail!("dynamic Worker preparation is not implemented") })
	}
	fn evict(&self, identity: WorkerdActorIdentity) -> BoxFuture<Result<()>>;
	fn admission_stats(&self) -> Option<WorkerdAdmissionStats> {
		None
	}
	fn fetch(
		&self,
		identity: WorkerdActorIdentity,
		request: HttpRequest,
	) -> BoxFuture<Result<HttpResponse>>;
}

pub struct WorkerdHost {
	transport: Arc<dyn WorkerdTransport>,
	active: RwLock<HashMap<String, ActiveActor>>,
	actor_locks: Vec<AsyncRwLock<()>>,
	max_active_actors: Option<usize>,
	accepting_actors: AtomicBool,
	draining: AtomicBool,
	drain_control_lock: Mutex<()>,
	envoy_control: OnceLock<WorkerdEnvoyControl>,
}

#[derive(Clone)]
struct ActiveActor {
	generation: u32,
	/// Monotonic host-local request epoch. A delayed idle candidate may only act
	/// while both this epoch and the Pegboard generation still match.
	activity_epoch: u64,
	idle_sleep_task: Option<tokio::task::AbortHandle>,
	/// Public reference received from Pegboard. An empty version means follow the
	/// active Deployment and is intentionally retained across resolution.
	worker_request: Option<protocol::WorkerVersionReference>,
	/// Exact immutable version loaded for the current activation.
	worker: Option<protocol::WorkerVersionReference>,
	durable_object_class: Option<String>,
	binding_env: serde_json::Value,
}

struct WorkerdEnvoyControl {
	handle: EnvoyHandle,
	ready_metadata: serde_json::Value,
	draining_metadata: serde_json::Value,
}

impl WorkerdHost {
	pub fn new(transport: Arc<dyn WorkerdTransport>) -> Self {
		Self::new_with_max_active_actors(transport, None)
	}

	pub fn new_with_max_active_actors(
		transport: Arc<dyn WorkerdTransport>,
		max_active_actors: Option<usize>,
	) -> Self {
		debug_assert!(
			max_active_actors
				.is_none_or(|capacity| { (1..=MAX_WORKERD_ACTIVE_ACTORS).contains(&capacity) }),
			"workerd actor capacity must be validated at the configuration boundary"
		);
		Self {
			transport,
			active: RwLock::new(HashMap::new()),
			actor_locks: (0..ACTOR_LOCK_SHARDS)
				.map(|_| AsyncRwLock::new(()))
				.collect(),
			max_active_actors,
			accepting_actors: AtomicBool::new(true),
			draining: AtomicBool::new(false),
			drain_control_lock: Mutex::new(()),
			envoy_control: OnceLock::new(),
		}
	}

	pub fn configure_envoy_control(
		&self,
		handle: EnvoyHandle,
		ready_metadata: serde_json::Value,
		draining_metadata: serde_json::Value,
	) -> Result<()> {
		ensure!(
			self.max_active_actors.is_some(),
			"dynamic Host drain requires a configured actor capacity"
		);
		self.envoy_control
			.set(WorkerdEnvoyControl {
				handle,
				ready_metadata,
				draining_metadata,
			})
			.map_err(|_| anyhow!("workerd Envoy drain control already configured"))
	}

	/// Atomically fences local activation before advertising zero placement
	/// capacity. Restoring reverses the order so a disconnected metadata update
	/// remains latched for replay before local admission reopens.
	pub async fn set_draining(&self, draining: bool) -> Result<bool> {
		let _guard = self.drain_control_lock.lock().await;
		let control = self
			.envoy_control
			.get()
			.ok_or_else(|| anyhow!("workerd Envoy drain control is not configured"))?;
		if draining {
			self.accepting_actors.store(false, Ordering::Release);
			self.draining.store(true, Ordering::Release);
			let metadata_sent = control
				.handle
				.update_metadata(Some(control.draining_metadata.clone()))
				.await;
			// The zero-capacity metadata is the sole owner of planned Host drain.
			// Pegboard observes it and sends GoingAway so live Actors are moved to
			// another Host. Sending ActorIntent::Sleep here races that transition:
			// actor2 deliberately turns GoingAway + Sleep into SleepIntent, leaving
			// the Actor asleep until its next request. With many active Actors that
			// makes rollout latency proportional to the request revisit interval.
			// Repeated drain calls still replay the idempotent metadata update; if
			// the Engine cannot observe it, preStop never sees quiescence and fails
			// closed instead of inventing a second lifecycle owner.
			Ok(metadata_sent)
		} else {
			let sent = control
				.handle
				.update_metadata(Some(control.ready_metadata.clone()))
				.await;
			self.draining.store(false, Ordering::Release);
			self.accepting_actors.store(true, Ordering::Release);
			Ok(sent)
		}
	}

	pub async fn health(&self) -> Result<()> {
		self.transport.health().await
	}

	pub async fn start_actor(&self, identity: WorkerdActorIdentity) -> Result<()> {
		self.start_actor_with_worker(identity, None).await
	}

	pub async fn start_actor_with_worker(
		&self,
		identity: WorkerdActorIdentity,
		worker: Option<protocol::WorkerVersionReference>,
	) -> Result<()> {
		self.start_actor_with_bindings(
			identity,
			worker.clone(),
			worker,
			None,
			serde_json::json!({}),
		)
		.await
	}

	pub async fn start_actor_with_config(
		&self,
		identity: WorkerdActorIdentity,
		config: protocol::ActorConfig,
	) -> Result<()> {
		let worker_request = config.worker.clone();
		self.start_actor_with_resolved_config(identity, config, worker_request)
			.await
	}

	pub async fn start_actor_with_resolved_config(
		&self,
		identity: WorkerdActorIdentity,
		config: protocol::ActorConfig,
		worker_request: Option<protocol::WorkerVersionReference>,
	) -> Result<()> {
		let durable_object_class = durable_object_class_from_input(config.input.as_deref())?;
		ensure!(
			durable_object_class.is_none() || config.worker.is_some(),
			"Durable Object class activation requires a Worker reference"
		);
		let mut actor_env = serde_json::json!({
			"id": identity.actor_id,
			"generation": identity.generation,
			"name": config.name,
			"key": config.key,
			"inputBase64": config.input.map(|input| BASE64_STANDARD.encode(input)),
		});
		if let Some(class_name) = &durable_object_class {
			actor_env["durableObjectClass"] = serde_json::json!(class_name);
		}
		let binding_env = serde_json::json!({ "RIVET_ACTOR": actor_env });
		self.start_actor_with_bindings(
			identity,
			worker_request,
			config.worker,
			durable_object_class,
			binding_env,
		)
		.await
	}

	async fn start_actor_with_bindings(
		&self,
		identity: WorkerdActorIdentity,
		worker_request: Option<protocol::WorkerVersionReference>,
		worker: Option<protocol::WorkerVersionReference>,
		durable_object_class: Option<String>,
		binding_env: serde_json::Value,
	) -> Result<()> {
		identity.validate()?;
		let _guard = self.actor_lock(&identity.actor_id).write().await;
		let current = self.active_actor(&identity.actor_id)?;
		let current_generation = current.as_ref().map(|actor| actor.generation);
		if current_generation == Some(identity.generation) {
			ensure!(
				current
					.as_ref()
					.and_then(|actor| actor.worker_request.as_ref())
					== worker_request.as_ref(),
				"actor generation was started with a different Worker reference"
			);
			ensure!(
				current.as_ref().and_then(|actor| actor.worker.as_ref()) == worker.as_ref(),
				"actor generation was started with a different Worker version"
			);
			ensure!(
				current.as_ref().map(|actor| &actor.binding_env) == Some(&binding_env),
				"actor generation was started with different bindings"
			);
			return Ok(());
		}
		if current_generation.is_some_and(|generation| generation > identity.generation) {
			bail!(
				"refusing stale workerd activation {}@{}; current generation is {}",
				identity.actor_id,
				identity.generation,
				current_generation.unwrap_or_default()
			);
		}
		if let Some(generation) = current_generation {
			self.transport
				.evict(WorkerdActorIdentity {
					actor_id: identity.actor_id.clone(),
					generation,
				})
				.await?;
			if let Some(task) = current.and_then(|actor| actor.idle_sleep_task) {
				task.abort();
			}
		}
		{
			let mut active = self
				.active
				.write()
				.map_err(|_| anyhow!("workerd actor registry poisoned"))?;
			ensure!(
				(active.contains_key(&identity.actor_id)
					|| self
						.max_active_actors
						.is_none_or(|capacity| active.len() < capacity))
					&& self.accepting_actors.load(Ordering::Acquire),
				"workerd Host is draining or active actor capacity was reached"
			);
			active.insert(
				identity.actor_id.clone(),
				ActiveActor {
					generation: identity.generation,
					activity_epoch: 0,
					idle_sleep_task: None,
					worker_request,
					worker: worker.clone(),
					durable_object_class: durable_object_class.clone(),
					binding_env,
				},
			);
		}
		if let Some(worker) = worker
			&& let Err(error) = self
				.transport
				.prepare(identity.clone(), worker, durable_object_class)
				.await
		{
			let mut active = self
				.active
				.write()
				.map_err(|_| anyhow!("workerd actor registry poisoned"))?;
			if active
				.get(&identity.actor_id)
				.is_some_and(|actor| actor.generation == identity.generation)
			{
				active.remove(&identity.actor_id);
			}
			return Err(error).context("prepare dynamic Worker isolate");
		}
		Ok(())
	}

	/// Atomically replaces the code isolate for a deployment-bound actor without
	/// changing its durable actor identity or SQLite database. Removal from the
	/// active map on preparation failure is the fail-closed fence.
	pub async fn replace_worker_version(
		&self,
		identity: WorkerdActorIdentity,
		worker_request: protocol::WorkerVersionReference,
		resolved: protocol::WorkerVersionReference,
	) -> Result<()> {
		identity.validate()?;
		let _guard = self.actor_lock(&identity.actor_id).write().await;
		let current = self
			.active_actor(&identity.actor_id)?
			.ok_or_else(|| anyhow!("actor generation is not active in this workerd host"))?;
		ensure!(
			current.generation == identity.generation
				&& current.worker_request.as_ref() == Some(&worker_request),
			"actor Worker reference changed while resolving its Deployment"
		);
		if current.worker.as_ref() == Some(&resolved) {
			return Ok(());
		}

		self.transport.evict(identity.clone()).await?;
		{
			let mut active = self
				.active
				.write()
				.map_err(|_| anyhow!("workerd actor registry poisoned"))?;
			let actor = active
				.get_mut(&identity.actor_id)
				.ok_or_else(|| anyhow!("actor generation disappeared during code replacement"))?;
			ensure!(
				actor.generation == identity.generation
					&& actor.worker_request.as_ref() == Some(&worker_request),
				"actor Worker reference changed during code replacement"
			);
			actor.worker = Some(resolved.clone());
		}
		if let Err(error) = self
			.transport
			.prepare(
				identity.clone(),
				resolved,
				current.durable_object_class.clone(),
			)
			.await
		{
			let mut active = self
				.active
				.write()
				.map_err(|_| anyhow!("workerd actor registry poisoned"))?;
			if active
				.get(&identity.actor_id)
				.is_some_and(|actor| actor.generation == identity.generation)
			{
				active.remove(&identity.actor_id);
			}
			return Err(error).context("prepare replacement Worker isolate");
		}
		Ok(())
	}

	pub async fn stop_actor(&self, identity: WorkerdActorIdentity) -> Result<()> {
		identity.validate()?;
		let _guard = self.actor_lock(&identity.actor_id).write().await;
		if self.current_generation(&identity.actor_id)? != Some(identity.generation) {
			return Ok(());
		}
		self.transport.evict(identity.clone()).await?;
		let mut active = self
			.active
			.write()
			.map_err(|_| anyhow!("workerd actor registry poisoned"))?;
		if active
			.get(&identity.actor_id)
			.is_some_and(|actor| actor.generation == identity.generation)
			&& let Some(actor) = active.remove(&identity.actor_id)
			&& let Some(task) = actor.idle_sleep_task
		{
			task.abort();
		}
		Ok(())
	}

	/// Fail closed before attempting best-effort isolate eviction.
	///
	/// The registry removal is the host-side admission fence. It deliberately
	/// happens before the workerd management request so an unavailable workerd
	/// cannot leave a fenced generation dispatchable.
	pub async fn fence_actor(&self, identity: WorkerdActorIdentity) -> Result<()> {
		identity.validate()?;
		let _guard = self.actor_lock(&identity.actor_id).write().await;
		{
			let mut active = self
				.active
				.write()
				.map_err(|_| anyhow!("workerd actor registry poisoned"))?;
			if !active
				.get(&identity.actor_id)
				.is_some_and(|actor| actor.generation == identity.generation)
			{
				return Ok(());
			}
			if let Some(actor) = active.remove(&identity.actor_id)
				&& let Some(task) = actor.idle_sleep_task
			{
				task.abort();
			}
		}
		self.transport.evict(identity).await
	}

	/// Invalidates the previous idle candidate before request preparation or
	/// execution starts. The returned epoch belongs to this exact request wave.
	fn begin_actor_activity(&self, identity: &WorkerdActorIdentity) -> Result<u64> {
		identity.validate()?;
		let mut active = self
			.active
			.write()
			.map_err(|_| anyhow!("workerd actor registry poisoned"))?;
		let actor = active
			.get_mut(&identity.actor_id)
			.ok_or_else(|| anyhow!("actor generation is not active in this workerd host"))?;
		ensure!(
			actor.generation == identity.generation,
			"actor generation is not active in this workerd host"
		);
		if let Some(task) = actor.idle_sleep_task.take() {
			task.abort();
		}
		actor.activity_epoch = actor
			.activity_epoch
			.checked_add(1)
			.ok_or_else(|| anyhow!("workerd actor activity epoch overflow"))?;
		Ok(actor.activity_epoch)
	}

	fn current_activity_epoch(&self, identity: &WorkerdActorIdentity) -> Result<u64> {
		identity.validate()?;
		let actor = self
			.active_actor(&identity.actor_id)?
			.ok_or_else(|| anyhow!("actor generation is not active in this workerd host"))?;
		ensure!(
			actor.generation == identity.generation,
			"actor generation is not active in this workerd host"
		);
		Ok(actor.activity_epoch)
	}

	/// Arms at most one timer per admitted Actor. The timer can only propose a
	/// generation-scoped sleep to Pegboard; it never evicts workerd or releases a
	/// placement slot itself.
	fn arm_actor_idle_sleep(
		self: &Arc<Self>,
		identity: WorkerdActorIdentity,
		activity_epoch: u64,
		handle: EnvoyHandle,
		delay: Duration,
	) -> Result<()> {
		self.arm_actor_idle_sleep_with_retry_interval(
			identity,
			activity_epoch,
			handle,
			delay,
			IDLE_SLEEP_INTENT_RETRY_INTERVAL,
		)
	}

	fn arm_actor_idle_sleep_with_retry_interval(
		self: &Arc<Self>,
		identity: WorkerdActorIdentity,
		activity_epoch: u64,
		handle: EnvoyHandle,
		delay: Duration,
		retry_interval: Duration,
	) -> Result<()> {
		ensure!(
			!retry_interval.is_zero(),
			"idle sleep retry interval must be positive"
		);
		let weak_host = Arc::downgrade(self);
		let task_identity = identity.clone();
		let (start_tx, start_rx) = tokio::sync::oneshot::channel();
		let task = tokio::spawn(async move {
			if start_rx.await.is_err() {
				return;
			}
			tokio::time::sleep(delay).await;
			loop {
				let Some(host) = weak_host.upgrade() else {
					return;
				};
				if !host
					.request_sleep_if_still_idle(
						task_identity.clone(),
						activity_epoch,
						handle.clone(),
					)
					.await
				{
					return;
				}
				tokio::time::sleep(retry_interval).await;
			}
		});
		let abort_handle = task.abort_handle();
		drop(task);

		let installed = {
			let mut active = self
				.active
				.write()
				.map_err(|_| anyhow!("workerd actor registry poisoned"))?;
			if let Some(actor) = active.get_mut(&identity.actor_id)
				&& actor.generation == identity.generation
				&& actor.activity_epoch == activity_epoch
			{
				if let Some(previous) = actor.idle_sleep_task.replace(abort_handle.clone()) {
					previous.abort();
				}
				true
			} else {
				false
			}
		};
		if installed {
			let _ = start_tx.send(());
		} else {
			abort_handle.abort();
		}
		Ok(())
	}

	async fn request_sleep_if_still_idle(
		&self,
		identity: WorkerdActorIdentity,
		activity_epoch: u64,
		handle: EnvoyHandle,
	) -> bool {
		let matches_lease = || -> Result<bool> {
			Ok(self.active_actor(&identity.actor_id)?.is_some_and(|actor| {
				actor.generation == identity.generation && actor.activity_epoch == activity_epoch
			}))
		};
		if !matches!(matches_lease(), Ok(true)) {
			return false;
		}
		if handle
			.get_active_http_request_count(&identity.actor_id, Some(identity.generation))
			.await != Some(0)
		{
			return matches!(matches_lease(), Ok(true));
		}

		// Recheck after observing the Envoy request counter. A request racing after
		// this point is still safe: Pegboard first makes the Actor non-connectable,
		// and Host stop takes the write side of the same per-Actor lock as fetch.
		let should_sleep = self
			.active
			.read()
			.ok()
			.and_then(|active| active.get(&identity.actor_id).cloned())
			.is_some_and(|actor| {
				actor.generation == identity.generation
					&& actor.activity_epoch == activity_epoch
					&& actor.idle_sleep_task.is_some()
			});
		if should_sleep {
			handle.sleep_actor(identity.actor_id, Some(identity.generation));
		}
		should_sleep
	}

	pub async fn fetch_actor(
		&self,
		identity: WorkerdActorIdentity,
		mut request: HttpRequest,
	) -> Result<HttpResponse> {
		identity.validate()?;
		// Activations, stops, fences, and code replacements take the write side.
		// Requests remain concurrent with each other, but cannot observe a
		// half-prepared Worker version or race an isolate eviction.
		let _guard = self.actor_lock(&identity.actor_id).read().await;
		ensure!(
			self.current_generation(&identity.actor_id)? == Some(identity.generation),
			"actor generation is not active in this workerd host"
		);
		let path = request.path.split('?').next().unwrap_or_default();
		ensure!(
			!path.starts_with(RIVET_WORKERD_MANAGEMENT_PREFIX),
			"workerd management path is reserved"
		);
		request.headers.remove(RIVET_WORKER_NAME_HEADER);
		request.headers.remove(RIVET_WORKER_VERSION_HEADER);
		request.headers.remove(RIVET_DURABLE_OBJECT_CLASS_HEADER);
		if let Some(worker) = self.worker_for_actor(&identity)? {
			request
				.headers
				.insert(RIVET_WORKER_NAME_HEADER.into(), worker.worker);
			request
				.headers
				.insert(RIVET_WORKER_VERSION_HEADER.into(), worker.version_id);
		}
		if let Some(class_name) = self.durable_object_class_for_actor(&identity)? {
			request
				.headers
				.insert(RIVET_DURABLE_OBJECT_CLASS_HEADER.into(), class_name);
		}
		self.transport.fetch(identity, request).await
	}

	pub fn current_generation(&self, actor_id: &str) -> Result<Option<u32>> {
		Ok(self.active_actor(actor_id)?.map(|actor| actor.generation))
	}

	pub fn worker_for_actor(
		&self,
		identity: &WorkerdActorIdentity,
	) -> Result<Option<protocol::WorkerVersionReference>> {
		identity.validate()?;
		let actor = self
			.active_actor(&identity.actor_id)?
			.ok_or_else(|| anyhow!("actor generation is not active in this workerd host"))?;
		ensure!(
			actor.generation == identity.generation,
			"actor generation is not active in this workerd host"
		);
		Ok(actor.worker)
	}

	fn durable_object_class_for_actor(
		&self,
		identity: &WorkerdActorIdentity,
	) -> Result<Option<String>> {
		identity.validate()?;
		let actor = self
			.active_actor(&identity.actor_id)?
			.ok_or_else(|| anyhow!("actor generation is not active in this workerd host"))?;
		ensure!(
			actor.generation == identity.generation,
			"actor generation is not active in this workerd host"
		);
		Ok(actor.durable_object_class)
	}

	pub fn worker_request_for_actor(
		&self,
		identity: &WorkerdActorIdentity,
	) -> Result<Option<protocol::WorkerVersionReference>> {
		identity.validate()?;
		let actor = self
			.active_actor(&identity.actor_id)?
			.ok_or_else(|| anyhow!("actor generation is not active in this workerd host"))?;
		ensure!(
			actor.generation == identity.generation,
			"actor generation is not active in this workerd host"
		);
		Ok(actor.worker_request)
	}

	pub fn worker_binding_env(&self, identity: &WorkerdActorIdentity) -> Result<serde_json::Value> {
		identity.validate()?;
		let actor = self
			.active_actor(&identity.actor_id)?
			.ok_or_else(|| anyhow!("actor generation is not active in this workerd host"))?;
		ensure!(
			actor.generation == identity.generation && actor.worker.is_some(),
			"actor generation has no active dynamic Worker"
		);
		Ok(actor.binding_env)
	}

	/// Number of Actor generations currently admitted by this host.
	///
	/// This deliberately exposes only a bounded aggregate. Scale qualification
	/// must be able to prove that a sleep wave returns to the pre-test baseline
	/// without listing unbounded Actor IDs or creating high-cardinality metrics.
	pub fn active_actor_count(&self) -> Result<usize> {
		Ok(self
			.active
			.read()
			.map_err(|_| anyhow!("workerd actor registry poisoned"))?
			.len())
	}

	pub fn max_active_actors(&self) -> Option<usize> {
		self.max_active_actors
	}

	pub fn is_draining(&self) -> bool {
		self.draining.load(Ordering::Acquire)
	}

	pub fn is_accepting_actors(&self) -> bool {
		self.accepting_actors.load(Ordering::Acquire)
	}

	pub fn admission_stats(&self) -> Option<WorkerdAdmissionStats> {
		self.transport.admission_stats()
	}

	fn actor_lock(&self, actor_id: &str) -> &AsyncRwLock<()> {
		let mut hasher = std::collections::hash_map::DefaultHasher::new();
		actor_id.hash(&mut hasher);
		&self.actor_locks[(hasher.finish() as usize) % self.actor_locks.len()]
	}

	fn active_actor(&self, actor_id: &str) -> Result<Option<ActiveActor>> {
		Ok(self
			.active
			.read()
			.map_err(|_| anyhow!("workerd actor registry poisoned"))?
			.get(actor_id)
			.cloned())
	}
}

fn durable_object_class_from_input(input: Option<&[u8]>) -> Result<Option<String>> {
	let Some(input) = input else {
		return Ok(None);
	};
	let Ok(value) = serde_json::from_slice::<serde_json::Value>(input) else {
		return Ok(None);
	};
	if value.get("schema").and_then(serde_json::Value::as_str)
		!= Some(DURABLE_OBJECT_ACTOR_INPUT_SCHEMA)
	{
		return Ok(None);
	}
	let class_name = value
		.get("class_name")
		.and_then(serde_json::Value::as_str)
		.ok_or_else(|| anyhow!("Durable Object actor input is missing class_name"))?;
	let mut bytes = class_name.bytes();
	let first = bytes
		.next()
		.ok_or_else(|| anyhow!("Durable Object class name must not be empty"))?;
	ensure!(
		class_name.len() <= 128
			&& (first.is_ascii_alphabetic() || matches!(first, b'_' | b'$'))
			&& bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$')),
		"Durable Object class name must be a bounded JavaScript identifier"
	);
	Ok(Some(class_name.to_owned()))
}

/// Keep the loopback bridge alive while workerd is starting or restarting.
///
/// Startup ordering must not be a correctness dependency: production service
/// managers are allowed to start the host before workerd, and workerd may take
/// longer to become healthy after an upgrade.
pub async fn wait_for_workerd_ready(host: &WorkerdHost, retry_delay: Duration) {
	loop {
		match host.health().await {
			Ok(()) => return,
			Err(error) => {
				tracing::warn!(?error, "waiting for workerd health endpoint");
				tokio::time::sleep(retry_delay).await;
			}
		}
	}
}

#[derive(Debug)]
struct WorkerdAdmissionError {
	reason: &'static str,
	retry_after_ms: u64,
}

impl std::fmt::Display for WorkerdAdmissionError {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(
			formatter,
			"workerd request admission failed: {}; retry after {} ms",
			self.reason, self.retry_after_ms
		)
	}
}

impl std::error::Error for WorkerdAdmissionError {}

#[derive(Debug)]
struct WorkerdRequestGateState {
	in_flight: AtomicUsize,
	queued: AtomicUsize,
	peak_in_flight: AtomicUsize,
	peak_queued: AtomicUsize,
	queued_total: AtomicU64,
	rejected_total: AtomicU64,
	timed_out_total: AtomicU64,
}

#[derive(Clone, Debug)]
struct WorkerdRequestGate {
	execution_permits: Arc<Semaphore>,
	admission_permits: Arc<Semaphore>,
	queue_timeout: Duration,
	max_in_flight: usize,
	max_queued: usize,
	state: Arc<WorkerdRequestGateState>,
}

impl WorkerdRequestGate {
	fn new(max_in_flight: usize, max_queued: usize, queue_timeout_ms: u64) -> Result<Self> {
		ensure!(
			(1..=MAX_WORKERD_MAX_IN_FLIGHT).contains(&max_in_flight),
			"workerd max in-flight requests must be between 1 and {MAX_WORKERD_MAX_IN_FLIGHT}"
		);
		ensure!(
			max_queued <= MAX_WORKERD_MAX_QUEUED,
			"workerd max queued requests must not exceed {MAX_WORKERD_MAX_QUEUED}"
		);
		ensure!(
			(1..=MAX_WORKERD_QUEUE_TIMEOUT_MS).contains(&queue_timeout_ms),
			"workerd queue timeout must be between 1 and {MAX_WORKERD_QUEUE_TIMEOUT_MS} ms"
		);
		let max_admitted = max_in_flight
			.checked_add(max_queued)
			.context("workerd admission capacity overflow")?;
		Ok(Self {
			execution_permits: Arc::new(Semaphore::new(max_in_flight)),
			admission_permits: Arc::new(Semaphore::new(max_admitted)),
			queue_timeout: Duration::from_millis(queue_timeout_ms),
			max_in_flight,
			max_queued,
			state: Arc::new(WorkerdRequestGateState {
				in_flight: AtomicUsize::new(0),
				queued: AtomicUsize::new(0),
				peak_in_flight: AtomicUsize::new(0),
				peak_queued: AtomicUsize::new(0),
				queued_total: AtomicU64::new(0),
				rejected_total: AtomicU64::new(0),
				timed_out_total: AtomicU64::new(0),
			}),
		})
	}

	async fn acquire(&self) -> std::result::Result<WorkerdRequestPermit, WorkerdAdmissionError> {
		let admission = match self.admission_permits.clone().try_acquire_owned() {
			Ok(permit) => permit,
			Err(TryAcquireError::NoPermits) => {
				self.state.rejected_total.fetch_add(1, Ordering::Relaxed);
				return Err(self.error("queue_full"));
			}
			Err(TryAcquireError::Closed) => return Err(self.error("admission_closed")),
		};
		let execution = match self.execution_permits.clone().try_acquire_owned() {
			Ok(permit) => permit,
			Err(TryAcquireError::Closed) => return Err(self.error("execution_closed")),
			Err(TryAcquireError::NoPermits) => {
				let _queued = WorkerdQueuedGuard::new(self.state.clone());
				match tokio::time::timeout(
					self.queue_timeout,
					self.execution_permits.clone().acquire_owned(),
				)
				.await
				{
					Ok(Ok(permit)) => permit,
					Ok(Err(_)) => return Err(self.error("execution_closed")),
					Err(_) => {
						self.state.timed_out_total.fetch_add(1, Ordering::Relaxed);
						return Err(self.error("queue_timeout"));
					}
				}
			}
		};
		let in_flight = self.state.in_flight.fetch_add(1, Ordering::Relaxed) + 1;
		self.state
			.peak_in_flight
			.fetch_max(in_flight, Ordering::Relaxed);
		Ok(WorkerdRequestPermit {
			_admission: admission,
			_execution: execution,
			state: self.state.clone(),
		})
	}

	fn error(&self, reason: &'static str) -> WorkerdAdmissionError {
		WorkerdAdmissionError {
			reason,
			retry_after_ms: u64::try_from(self.queue_timeout.as_millis()).unwrap_or(u64::MAX),
		}
	}

	fn stats(&self) -> WorkerdAdmissionStats {
		WorkerdAdmissionStats {
			in_flight: self.state.in_flight.load(Ordering::Relaxed),
			queued: self.state.queued.load(Ordering::Relaxed),
			peak_in_flight: self.state.peak_in_flight.load(Ordering::Relaxed),
			peak_queued: self.state.peak_queued.load(Ordering::Relaxed),
			queued_total: self.state.queued_total.load(Ordering::Relaxed),
			rejected_total: self.state.rejected_total.load(Ordering::Relaxed),
			timed_out_total: self.state.timed_out_total.load(Ordering::Relaxed),
			max_in_flight: self.max_in_flight,
			max_queued: self.max_queued,
			queue_timeout_ms: u64::try_from(self.queue_timeout.as_millis()).unwrap_or(u64::MAX),
		}
	}
}

struct WorkerdQueuedGuard {
	state: Arc<WorkerdRequestGateState>,
}

impl WorkerdQueuedGuard {
	fn new(state: Arc<WorkerdRequestGateState>) -> Self {
		let queued = state.queued.fetch_add(1, Ordering::Relaxed) + 1;
		state.queued_total.fetch_add(1, Ordering::Relaxed);
		state.peak_queued.fetch_max(queued, Ordering::Relaxed);
		Self { state }
	}
}

impl Drop for WorkerdQueuedGuard {
	fn drop(&mut self) {
		self.state.queued.fetch_sub(1, Ordering::Relaxed);
	}
}

struct WorkerdRequestPermit {
	_admission: OwnedSemaphorePermit,
	_execution: OwnedSemaphorePermit,
	state: Arc<WorkerdRequestGateState>,
}

impl Drop for WorkerdRequestPermit {
	fn drop(&mut self) {
		self.state.in_flight.fetch_sub(1, Ordering::Relaxed);
	}
}

pub struct HttpWorkerdTransport {
	client: reqwest::Client,
	endpoints: Vec<Url>,
	token: reqwest::header::HeaderValue,
	request_gate: WorkerdRequestGate,
	control_request_timeout: Duration,
}

impl HttpWorkerdTransport {
	pub fn new(endpoint: &str, token: &str) -> Result<Self> {
		Self::new_with_max_in_flight(endpoint, token, DEFAULT_WORKERD_MAX_IN_FLIGHT)
	}

	pub fn new_with_max_in_flight(
		endpoint: &str,
		token: &str,
		max_in_flight: usize,
	) -> Result<Self> {
		Self::new_with_admission_limits(
			endpoint,
			token,
			max_in_flight,
			DEFAULT_WORKERD_MAX_QUEUED,
			DEFAULT_WORKERD_QUEUE_TIMEOUT_MS,
		)
	}

	pub fn new_with_admission_limits(
		endpoint: &str,
		token: &str,
		max_in_flight: usize,
		max_queued: usize,
		queue_timeout_ms: u64,
	) -> Result<Self> {
		Self::new_with_admission_limits_for_endpoints(
			&[endpoint.to_string()],
			token,
			max_in_flight,
			max_queued,
			queue_timeout_ms,
		)
	}

	pub fn new_with_admission_limits_for_endpoints(
		endpoints: &[String],
		token: &str,
		max_in_flight: usize,
		max_queued: usize,
		queue_timeout_ms: u64,
	) -> Result<Self> {
		Self::new_with_control_timeout(
			endpoints,
			token,
			max_in_flight,
			max_queued,
			queue_timeout_ms,
			WORKERD_CONTROL_REQUEST_TIMEOUT,
		)
	}

	fn new_with_control_timeout(
		endpoints: &[String],
		token: &str,
		max_in_flight: usize,
		max_queued: usize,
		queue_timeout_ms: u64,
		control_request_timeout: Duration,
	) -> Result<Self> {
		ensure!(
			!endpoints.is_empty(),
			"at least one workerd endpoint is required"
		);
		ensure!(
			!control_request_timeout.is_zero(),
			"workerd control request timeout must be positive"
		);
		let endpoints = endpoints
			.iter()
			.map(|endpoint| validate_endpoint(endpoint))
			.collect::<Result<Vec<_>>>()?;
		ensure!(
			endpoints
				.iter()
				.collect::<std::collections::HashSet<_>>()
				.len() == endpoints.len(),
			"workerd endpoints must be unique"
		);
		ensure!(
			token.len() >= 16,
			"workerd token must contain at least 16 characters"
		);
		let request_gate = WorkerdRequestGate::new(max_in_flight, max_queued, queue_timeout_ms)?;
		let token = reqwest::header::HeaderValue::from_str(token)
			.context("workerd token is not a valid HTTP header value")?;
		Ok(Self {
			// workerd and reqwest have independent keep-alive lifetimes. Reusing a
			// loopback connection while workerd is closing it can reset a POST after
			// admission, and blindly retrying a SQLite mutation would be unsafe. A
			// fresh bounded connection per request avoids that ambiguous retry window.
			client: reqwest::Client::builder()
				.pool_max_idle_per_host(0)
				.build()
				.context("build workerd HTTP client")?,
			endpoints,
			token,
			request_gate,
			control_request_timeout,
		})
	}

	fn endpoint_for(&self, identity: &WorkerdActorIdentity) -> &Url {
		// Stable FNV-1a is sufficient here: this is deterministic local sharding,
		// not a security boundary. Actor generation deliberately does not affect
		// the shard so a wake reuses the same process-local cache when available.
		let hash = identity
			.actor_id
			.as_bytes()
			.iter()
			.fold(0xcbf29ce484222325u64, |hash, byte| {
				(hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
			});
		&self.endpoints[hash as usize % self.endpoints.len()]
	}

	fn target(endpoint: &Url, path: &str) -> Result<Url> {
		ensure!(
			path.starts_with('/') && !path.starts_with("//"),
			"invalid workerd request path"
		);
		let target = endpoint.join(path).context("build workerd request URL")?;
		ensure!(
			target.scheme() == endpoint.scheme()
				&& target.host_str() == endpoint.host_str()
				&& target.port_or_known_default() == endpoint.port_or_known_default(),
			"workerd request path changed endpoint authority"
		);
		Ok(target)
	}

	fn identity_headers(&self, identity: &WorkerdActorIdentity) -> Result<HeaderMap> {
		identity.validate()?;
		let mut headers = HeaderMap::new();
		headers.insert(
			RIVET_ACTOR_ID_HEADER,
			reqwest::header::HeaderValue::from_str(&identity.actor_id)?,
		);
		headers.insert(
			RIVET_ACTOR_GENERATION_HEADER,
			reqwest::header::HeaderValue::from_str(&identity.generation.to_string())?,
		);
		headers.insert(RIVET_WORKERD_TOKEN_HEADER, self.token.clone());
		Ok(headers)
	}
}

impl WorkerdTransport for HttpWorkerdTransport {
	fn admission_stats(&self) -> Option<WorkerdAdmissionStats> {
		Some(self.request_gate.stats())
	}

	fn health(&self) -> BoxFuture<Result<()>> {
		let client = self.client.clone();
		let endpoints = self.endpoints.clone();
		let token = self.token.clone();
		let request_gate = self.request_gate.clone();
		let control_request_timeout = self.control_request_timeout;
		Box::pin(async move {
			for endpoint in endpoints {
				let _permit = request_gate.acquire().await?;
				let response = client
					.get(Self::target(&endpoint, RIVET_WORKERD_HEALTH_PATH)?)
					.header(RIVET_WORKERD_TOKEN_HEADER, token.clone())
					.timeout(control_request_timeout)
					.send()
					.await
					.with_context(|| format!("send workerd health request to {endpoint}"))?;
				ensure!(
					response.status() == 204,
					"workerd health at {endpoint} returned {}",
					response.status()
				);
			}
			Ok(())
		})
	}

	fn prepare(
		&self,
		identity: WorkerdActorIdentity,
		worker: protocol::WorkerVersionReference,
		durable_object_class: Option<String>,
	) -> BoxFuture<Result<()>> {
		let client = self.client.clone();
		let target = Self::target(self.endpoint_for(&identity), RIVET_WORKERD_PREPARE_PATH);
		let headers = self.identity_headers(&identity).and_then(|mut headers| {
			headers.insert(
				RIVET_WORKER_NAME_HEADER,
				reqwest::header::HeaderValue::from_str(&worker.worker)?,
			);
			headers.insert(
				RIVET_WORKER_VERSION_HEADER,
				reqwest::header::HeaderValue::from_str(&worker.version_id)?,
			);
			if let Some(class_name) = durable_object_class {
				headers.insert(
					RIVET_DURABLE_OBJECT_CLASS_HEADER,
					reqwest::header::HeaderValue::from_str(&class_name)?,
				);
			}
			Ok(headers)
		});
		let request_gate = self.request_gate.clone();
		let control_request_timeout = self.control_request_timeout;
		Box::pin(async move {
			let _permit = request_gate.acquire().await?;
			let response = client
				.post(target?)
				.headers(headers?)
				.timeout(control_request_timeout)
				.send()
				.await
				.with_context(|| format!("prepare dynamic Worker {}", identity.isolate_name()))?;
			let status = response.status();
			if status != 204 {
				let body = response.text().await.unwrap_or_default();
				bail!(
					"workerd refused dynamic Worker preparation for {}: HTTP {status}: {body}",
					identity.isolate_name()
				);
			}
			Ok(())
		})
	}

	fn evict(&self, identity: WorkerdActorIdentity) -> BoxFuture<Result<()>> {
		let client = self.client.clone();
		let target = Self::target(self.endpoint_for(&identity), RIVET_WORKERD_EVICT_PATH);
		let headers = self.identity_headers(&identity);
		let request_gate = self.request_gate.clone();
		let control_request_timeout = self.control_request_timeout;
		Box::pin(async move {
			let _permit = request_gate.acquire().await?;
			let response = client
				.post(target?)
				.headers(headers?)
				.timeout(control_request_timeout)
				.send()
				.await
				.with_context(|| format!("evict workerd isolate {}", identity.isolate_name()))?;
			let status = response.status();
			if status != 204 {
				let body = response.text().await.unwrap_or_default();
				bail!(
					"workerd refused eviction for {}: HTTP {status}: {body}",
					identity.isolate_name()
				);
			}
			Ok(())
		})
	}

	fn fetch(
		&self,
		identity: WorkerdActorIdentity,
		request: HttpRequest,
	) -> BoxFuture<Result<HttpResponse>> {
		let client = self.client.clone();
		let target = Self::target(self.endpoint_for(&identity), &request.path);
		let identity_headers = self.identity_headers(&identity);
		let request_gate = self.request_gate.clone();
		Box::pin(async move {
			let _permit = match request_gate.acquire().await {
				Ok(permit) => permit,
				Err(error) => {
					tracing::warn!(
						reason = error.reason,
						retry_after_ms = error.retry_after_ms,
						%identity.actor_id,
						identity.generation,
						"rejecting workerd request before dispatch"
					);
					return Ok(workerd_overload_response(&error));
				}
			};
			let method =
				Method::from_bytes(request.method.as_bytes()).context("invalid HTTP method")?;
			let mut headers = HeaderMap::new();
			for (name, value) in request.headers {
				let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())?;
				let value = reqwest::header::HeaderValue::from_str(&value)?;
				headers.insert(name, value);
			}
			for (name, value) in identity_headers? {
				if let Some(name) = name {
					headers.insert(name, value);
				}
			}

			let mut builder = client.request(method, target?).headers(headers);
			if let Some(body_stream) = request.body_stream {
				let initial = stream::iter(request.body.into_iter().map(Ok::<_, io::Error>));
				let remainder = UnboundedReceiverStream::new(body_stream).map(Ok::<_, io::Error>);
				builder = builder.body(reqwest::Body::wrap_stream(initial.chain(remainder)));
			} else if let Some(body) = request.body {
				builder = builder.body(body);
			}

			let response = builder
				.send()
				.await
				.with_context(|| format!("forward request to {}", identity.isolate_name()))?;
			let status = response.status().as_u16();
			let headers = response
				.headers()
				.iter()
				.filter_map(|(name, value)| {
					value
						.to_str()
						.ok()
						.map(|value| (name.to_string(), value.to_string()))
				})
				.collect();
			ensure!(
				response
					.content_length()
					.is_none_or(|length| length <= MAX_RESPONSE_BODY_BYTES as u64),
				"workerd response body exceeds {MAX_RESPONSE_BODY_BYTES} bytes"
			);
			let mut body = Vec::new();
			let mut body_stream = response.bytes_stream();
			while let Some(chunk) = body_stream.next().await {
				let chunk = chunk.context("read workerd response body")?;
				append_bounded(&mut body, &chunk, MAX_RESPONSE_BODY_BYTES)?;
			}

			Ok(HttpResponse {
				status,
				headers,
				body: Some(body),
				body_stream: None,
			})
		})
	}
}

fn workerd_overload_response(error: &WorkerdAdmissionError) -> HttpResponse {
	let retry_after_seconds = error.retry_after_ms.saturating_add(999) / 1_000;
	HttpResponse {
		status: 503,
		headers: HashMap::from([
			("retry-after".into(), retry_after_seconds.max(1).to_string()),
			("x-rivet-overload-reason".into(), error.reason.into()),
		]),
		body: Some(
			serde_json::to_vec(&serde_json::json!({
				"code": "workerd_overloaded",
				"reason": error.reason,
				"retry_after_ms": error.retry_after_ms,
			}))
			.expect("static workerd overload response must serialize"),
		),
		body_stream: None,
	}
}

fn append_bounded(buffer: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<()> {
	let new_len = buffer
		.len()
		.checked_add(chunk.len())
		.ok_or_else(|| anyhow!("workerd response body length overflow"))?;
	ensure!(
		new_len <= limit,
		"workerd response body exceeds {limit} bytes"
	);
	buffer.extend_from_slice(chunk);
	Ok(())
}

pub struct WorkerdEnvoyCallbacks {
	host: Arc<WorkerdHost>,
	sqlite_bridge: Arc<WorkerdSqliteBridge>,
	worker_code: Arc<WorkerCodeCache>,
	idle_sleep_after: Option<Duration>,
}

impl WorkerdEnvoyCallbacks {
	pub fn new(
		host: Arc<WorkerdHost>,
		sqlite_bridge: Arc<WorkerdSqliteBridge>,
		worker_code: Arc<WorkerCodeCache>,
	) -> Self {
		Self::new_with_idle_sleep(host, sqlite_bridge, worker_code, None)
	}

	pub fn new_with_idle_sleep(
		host: Arc<WorkerdHost>,
		sqlite_bridge: Arc<WorkerdSqliteBridge>,
		worker_code: Arc<WorkerCodeCache>,
		idle_sleep_after: Option<Duration>,
	) -> Self {
		Self {
			host,
			sqlite_bridge,
			worker_code,
			idle_sleep_after,
		}
	}
}

async fn stop_actor_generation_fail_closed(
	host: &WorkerdHost,
	sqlite_bridge: &WorkerdSqliteBridge,
	identity: WorkerdActorIdentity,
) -> Result<()> {
	match host.stop_actor(identity.clone()).await {
		Ok(()) => sqlite_bridge.unregister_actor(&identity),
		Err(stop_error) => {
			// Stop failure must still fail closed. Remove the storage capability
			// and local admission before Pegboard can advance the owner generation.
			sqlite_bridge.unregister_actor(&identity)?;
			if let Err(fence_error) = host.fence_actor(identity).await {
				tracing::error!(
					?fence_error,
					"failed best-effort workerd eviction after stop failure"
				);
			}
			Err(stop_error)
		}
	}
}

impl EnvoyCallbacks for WorkerdEnvoyCallbacks {
	fn on_actor_start(
		&self,
		handle: EnvoyHandle,
		actor_id: String,
		generation: u32,
		config: protocol::ActorConfig,
		_preloaded_kv: Option<protocol::PreloadedKv>,
	) -> BoxFuture<Result<()>> {
		let host = self.host.clone();
		let sqlite_bridge = self.sqlite_bridge.clone();
		let worker_code = self.worker_code.clone();
		let idle_sleep_after = self.idle_sleep_after;
		Box::pin(async move {
			let identity = WorkerdActorIdentity::new(actor_id, generation)?;
			let mut config = config;
			let worker_request = config.worker.clone();
			if let Some(worker) = &config.worker {
				let resolved = worker_code.resolve(worker, &identity.actor_id).await?;
				worker_code.prepare(&resolved).await?;
				config.worker = Some(resolved);
			}
			host.start_actor_with_resolved_config(identity.clone(), config, worker_request)
				.await?;
			if let Err(error) = sqlite_bridge.register_envoy_actor(identity.clone(), handle.clone())
			{
				// A Host activation without its exact storage capability must never
				// become dispatchable. Fence admission before surfacing start failure.
				let _ = host.fence_actor(identity).await;
				return Err(error).context("register generation-fenced SQLite bridge");
			}
			if let Some(delay) = idle_sleep_after {
				let epoch = host.current_activity_epoch(&identity)?;
				host.arm_actor_idle_sleep(identity, epoch, handle, delay)?;
			}
			Ok(())
		})
	}

	fn on_actor_stop(
		&self,
		_handle: EnvoyHandle,
		actor_id: String,
		generation: u32,
		_reason: protocol::StopActorReason,
	) -> BoxFuture<Result<()>> {
		let host = self.host.clone();
		let sqlite_bridge = self.sqlite_bridge.clone();
		Box::pin(async move {
			let identity = WorkerdActorIdentity::new(actor_id, generation)?;
			stop_actor_generation_fail_closed(&host, &sqlite_bridge, identity).await
		})
	}

	fn on_shutdown(&self) {}

	fn fetch(
		&self,
		_handle: EnvoyHandle,
		_actor_id: String,
		_gateway_id: protocol::GatewayId,
		_request_id: protocol::RequestId,
		_request: HttpRequest,
	) -> BoxFuture<Result<HttpResponse>> {
		Box::pin(async { bail!("generation-unaware fetch is forbidden for workerd") })
	}

	fn fetch_with_generation(
		&self,
		handle: EnvoyHandle,
		actor_id: String,
		generation: u32,
		_gateway_id: protocol::GatewayId,
		_request_id: protocol::RequestId,
		request: HttpRequest,
	) -> BoxFuture<Result<HttpResponse>> {
		let host = self.host.clone();
		let worker_code = self.worker_code.clone();
		let idle_sleep_after = self.idle_sleep_after;
		Box::pin(async move {
			let identity = WorkerdActorIdentity::new(actor_id, generation)?;
			let activity_epoch = host.begin_actor_activity(&identity)?;
			let result = async {
				if let Some(requested) = host.worker_request_for_actor(&identity)?
					&& requested.version_id.is_empty()
				{
					let resolved = worker_code.resolve(&requested, &identity.actor_id).await?;
					if host.worker_for_actor(&identity)?.as_ref() != Some(&resolved) {
						// Verify and cache immutable code before fencing the old isolate.
						worker_code.prepare(&resolved).await?;
						host.replace_worker_version(identity.clone(), requested, resolved)
							.await?;
					}
				}
				host.fetch_actor(identity.clone(), request).await
			}
			.await;
			if let Some(delay) = idle_sleep_after
				&& host.current_generation(&identity.actor_id)? == Some(identity.generation)
			{
				host.arm_actor_idle_sleep(identity, activity_epoch, handle, delay)?;
			}
			result
		})
	}

	fn websocket(
		&self,
		_handle: EnvoyHandle,
		_actor_id: String,
		_gateway_id: protocol::GatewayId,
		_request_id: protocol::RequestId,
		_request: HttpRequest,
		_path: String,
		_headers: HashMap<String, String>,
		_is_hibernatable: bool,
		_is_restoring_hibernatable: bool,
		_sender: WebSocketSender,
	) -> BoxFuture<Result<WebSocketHandler>> {
		Box::pin(async { bail!("workerd WebSocket bridge is not enabled yet") })
	}

	fn can_hibernate(
		&self,
		_actor_id: &str,
		_gateway_id: &protocol::GatewayId,
		_request_id: &protocol::RequestId,
		_request: &HttpRequest,
	) -> BoxFuture<Result<bool>> {
		Box::pin(async { Ok(false) })
	}
}

fn validate_endpoint(endpoint: &str) -> Result<Url> {
	let url = Url::parse(endpoint).context("parse workerd endpoint")?;
	ensure!(url.scheme() == "http", "workerd endpoint must use HTTP");
	ensure!(
		matches!(url.host_str(), Some("127.0.0.1" | "::1")),
		"workerd endpoint must use numeric loopback"
	);
	ensure!(
		url.username().is_empty()
			&& url.password().is_none()
			&& url.path() == "/"
			&& url.query().is_none()
			&& url.fragment().is_none(),
		"workerd endpoint must not contain credentials, path, query, or fragment"
	);
	Ok(url)
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::sync::{
		Mutex as StdMutex,
		atomic::{AtomicUsize, Ordering},
	};

	use axum::{Router, http::StatusCode, response::IntoResponse, routing::any};

	#[derive(Default)]
	struct RecordingTransport {
		evictions: StdMutex<Vec<WorkerdActorIdentity>>,
		preparations: StdMutex<
			Vec<(
				WorkerdActorIdentity,
				protocol::WorkerVersionReference,
				Option<String>,
			)>,
		>,
		requests: StdMutex<Vec<(WorkerdActorIdentity, HashMap<String, String>)>>,
	}

	struct FailingEvictionTransport;
	struct FailingPreparationTransport;
	struct BlockingFetchTransport {
		started: Arc<tokio::sync::Notify>,
		release: Arc<tokio::sync::Notify>,
	}

	struct UnusedSqliteBackend;
	struct NoopEnvoyCallbacks;

	struct EventuallyHealthyTransport {
		failed_attempts: usize,
		attempts: AtomicUsize,
	}

	impl WorkerdTransport for EventuallyHealthyTransport {
		fn health(&self) -> BoxFuture<Result<()>> {
			let attempt = self.attempts.fetch_add(1, Ordering::SeqCst);
			let result = if attempt < self.failed_attempts {
				Err(anyhow!("workerd is still starting"))
			} else {
				Ok(())
			};
			Box::pin(async move { result })
		}

		fn evict(&self, _identity: WorkerdActorIdentity) -> BoxFuture<Result<()>> {
			Box::pin(async { bail!("not used") })
		}

		fn fetch(
			&self,
			_identity: WorkerdActorIdentity,
			_request: HttpRequest,
		) -> BoxFuture<Result<HttpResponse>> {
			Box::pin(async { bail!("not used") })
		}
	}

	impl WorkerdTransport for FailingEvictionTransport {
		fn health(&self) -> BoxFuture<Result<()>> {
			Box::pin(async { Ok(()) })
		}

		fn evict(&self, _identity: WorkerdActorIdentity) -> BoxFuture<Result<()>> {
			Box::pin(async { bail!("workerd management endpoint unavailable") })
		}

		fn fetch(
			&self,
			_identity: WorkerdActorIdentity,
			_request: HttpRequest,
		) -> BoxFuture<Result<HttpResponse>> {
			Box::pin(async { bail!("not used") })
		}
	}

	impl WorkerdTransport for BlockingFetchTransport {
		fn health(&self) -> BoxFuture<Result<()>> {
			Box::pin(async { Ok(()) })
		}

		fn evict(&self, _identity: WorkerdActorIdentity) -> BoxFuture<Result<()>> {
			Box::pin(async { Ok(()) })
		}

		fn fetch(
			&self,
			_identity: WorkerdActorIdentity,
			_request: HttpRequest,
		) -> BoxFuture<Result<HttpResponse>> {
			let started = self.started.clone();
			let release = self.release.clone();
			Box::pin(async move {
				started.notify_one();
				release.notified().await;
				Ok(HttpResponse {
					status: 204,
					headers: HashMap::new(),
					body: None,
					body_stream: None,
				})
			})
		}
	}

	impl WorkerdSqliteBackend for UnusedSqliteBackend {
		fn get_pages(
			&self,
			_request: protocol::SqliteGetPagesRequest,
		) -> BoxFuture<Result<protocol::SqliteGetPagesResponse>> {
			Box::pin(async { bail!("not used") })
		}

		fn commit(
			&self,
			_request: protocol::SqliteCommitRequest,
		) -> BoxFuture<Result<protocol::SqliteCommitResponse>> {
			Box::pin(async { bail!("not used") })
		}
	}

	impl EnvoyCallbacks for NoopEnvoyCallbacks {
		fn on_actor_start(
			&self,
			_handle: EnvoyHandle,
			_actor_id: String,
			_generation: u32,
			_config: protocol::ActorConfig,
			_preloaded_kv: Option<protocol::PreloadedKv>,
		) -> BoxFuture<Result<()>> {
			Box::pin(async { Ok(()) })
		}

		fn on_shutdown(&self) {}

		fn fetch(
			&self,
			_handle: EnvoyHandle,
			_actor_id: String,
			_gateway_id: protocol::GatewayId,
			_request_id: protocol::RequestId,
			_request: HttpRequest,
		) -> BoxFuture<Result<HttpResponse>> {
			Box::pin(async { bail!("not used") })
		}

		fn websocket(
			&self,
			_handle: EnvoyHandle,
			_actor_id: String,
			_gateway_id: protocol::GatewayId,
			_request_id: protocol::RequestId,
			_request: HttpRequest,
			_path: String,
			_headers: HashMap<String, String>,
			_is_hibernatable: bool,
			_is_restoring_hibernatable: bool,
			_sender: WebSocketSender,
		) -> BoxFuture<Result<WebSocketHandler>> {
			Box::pin(async { bail!("not used") })
		}

		fn can_hibernate(
			&self,
			_actor_id: &str,
			_gateway_id: &protocol::GatewayId,
			_request_id: &protocol::RequestId,
			_request: &HttpRequest,
		) -> BoxFuture<Result<bool>> {
			Box::pin(async { Ok(false) })
		}
	}

	fn test_envoy_handle(
		identity: &WorkerdActorIdentity,
	) -> (
		EnvoyHandle,
		tokio::sync::mpsc::UnboundedReceiver<rivet_envoy_client::envoy::ToEnvoyMessage>,
	) {
		use rivet_envoy_client::{
			async_counter::AsyncCounter,
			config::EnvoyConfig,
			context::{SharedActorEntry, SharedContext, WsTxMessage},
		};

		let (envoy_tx, envoy_rx) = tokio::sync::mpsc::unbounded_channel();
		let (actor_tx, _actor_rx) = tokio::sync::mpsc::unbounded_channel();
		let mut generations = HashMap::new();
		generations.insert(
			identity.generation,
			SharedActorEntry {
				handle: actor_tx,
				active_http_request_count: Arc::new(AsyncCounter::new()),
			},
		);
		let mut actors = HashMap::new();
		actors.insert(identity.actor_id.clone(), generations);
		let shared = Arc::new(SharedContext {
			config: EnvoyConfig {
				version: 1,
				endpoint: "http://127.0.0.1:1".into(),
				token: None,
				namespace: "test".into(),
				pool_name: "workerd".into(),
				prepopulate_actor_names: HashMap::new(),
				metadata: None,
				not_global: true,
				debug_latency_ms: None,
				callbacks: Arc::new(NoopEnvoyCallbacks),
			},
			envoy_key: "test-envoy".into(),
			envoy_tx,
			actors: Arc::new(std::sync::Mutex::new(actors)),
			actors_notify: Arc::new(tokio::sync::Notify::new()),
			live_tunnel_requests: Arc::new(std::sync::Mutex::new(HashMap::new())),
			pending_hibernation_restores: Arc::new(std::sync::Mutex::new(HashMap::new())),
			ws_tx: Arc::new(tokio::sync::Mutex::new(
				None::<tokio::sync::mpsc::UnboundedSender<WsTxMessage>>,
			)),
			connection_session: AtomicU64::new(0),
			next_connection_session: AtomicU64::new(0),
			connection_session_tx: tokio::sync::watch::channel(0).0,
			protocol_metadata: Arc::new(tokio::sync::Mutex::new(None)),
			advertised_metadata: Arc::new(tokio::sync::Mutex::new(None)),
			shutting_down: AtomicBool::new(false),
			last_ping_ts: std::sync::atomic::AtomicI64::new(0),
			stopped_tx: tokio::sync::watch::channel(false).0,
		});
		(EnvoyHandle::from_shared(shared), envoy_rx)
	}

	impl WorkerdTransport for FailingPreparationTransport {
		fn health(&self) -> BoxFuture<Result<()>> {
			Box::pin(async { Ok(()) })
		}

		fn prepare(
			&self,
			_identity: WorkerdActorIdentity,
			_worker: protocol::WorkerVersionReference,
			_durable_object_class: Option<String>,
		) -> BoxFuture<Result<()>> {
			Box::pin(async { bail!("Worker compilation failed") })
		}

		fn evict(&self, _identity: WorkerdActorIdentity) -> BoxFuture<Result<()>> {
			Box::pin(async { Ok(()) })
		}

		fn fetch(
			&self,
			_identity: WorkerdActorIdentity,
			_request: HttpRequest,
		) -> BoxFuture<Result<HttpResponse>> {
			Box::pin(async { bail!("not used") })
		}
	}

	impl WorkerdTransport for RecordingTransport {
		fn health(&self) -> BoxFuture<Result<()>> {
			Box::pin(async { Ok(()) })
		}

		fn evict(&self, identity: WorkerdActorIdentity) -> BoxFuture<Result<()>> {
			self.evictions.lock().unwrap().push(identity);
			Box::pin(async { Ok(()) })
		}

		fn prepare(
			&self,
			identity: WorkerdActorIdentity,
			worker: protocol::WorkerVersionReference,
			durable_object_class: Option<String>,
		) -> BoxFuture<Result<()>> {
			self.preparations
				.lock()
				.unwrap()
				.push((identity, worker, durable_object_class));
			Box::pin(async { Ok(()) })
		}

		fn fetch(
			&self,
			identity: WorkerdActorIdentity,
			request: HttpRequest,
		) -> BoxFuture<Result<HttpResponse>> {
			self.requests
				.lock()
				.unwrap()
				.push((identity, request.headers));
			Box::pin(async {
				Ok(HttpResponse {
					status: 204,
					headers: HashMap::new(),
					body: None,
					body_stream: None,
				})
			})
		}
	}

	#[tokio::test]
	async fn replacement_and_delayed_stop_are_generation_safe() -> Result<()> {
		let transport = Arc::new(RecordingTransport::default());
		let host = WorkerdHost::new(transport.clone());
		host.start_actor(WorkerdActorIdentity::new("actor_a", 7)?)
			.await?;
		host.start_actor(WorkerdActorIdentity::new("actor_a", 8)?)
			.await?;
		host.stop_actor(WorkerdActorIdentity::new("actor_a", 7)?)
			.await?;

		assert_eq!(host.current_generation("actor_a")?, Some(8));
		assert_eq!(
			transport.evictions.lock().unwrap().as_slice(),
			&[WorkerdActorIdentity::new("actor_a", 7)?]
		);
		Ok(())
	}

	#[tokio::test]
	async fn dynamic_activation_waits_for_prepare_and_exposes_actor_bindings() -> Result<()> {
		let transport = Arc::new(RecordingTransport::default());
		let host = WorkerdHost::new(transport.clone());
		let identity = WorkerdActorIdentity::new("actor_dynamic", 4)?;
		let worker = protocol::WorkerVersionReference {
			worker: "hello".into(),
			version_id: format!("v_{}", "1".repeat(64)),
		};
		host.start_actor_with_config(
			identity.clone(),
			protocol::ActorConfig {
				name: "assistant".into(),
				key: Some("tenant-7".into()),
				create_ts: 123,
				input: Some(b"hello".to_vec()),
				worker: Some(worker.clone()),
			},
		)
		.await?;

		assert_eq!(
			transport.preparations.lock().unwrap().as_slice(),
			&[(identity.clone(), worker, None)]
		);
		assert_eq!(
			host.worker_binding_env(&identity)?,
			serde_json::json!({
				"RIVET_ACTOR": {
					"id": "actor_dynamic",
					"generation": 4,
					"name": "assistant",
					"key": "tenant-7",
					"inputBase64": "aGVsbG8=",
				}
			})
		);
		Ok(())
	}

	#[tokio::test]
	async fn durable_object_class_is_validated_and_forwarded_as_a_host_capability() -> Result<()> {
		let transport = Arc::new(RecordingTransport::default());
		let host = WorkerdHost::new(transport.clone());
		let identity = WorkerdActorIdentity::new("actor_counter", 4)?;
		let worker = protocol::WorkerVersionReference {
			worker: "counter".into(),
			version_id: format!("v_{}", "1".repeat(64)),
		};
		host.start_actor_with_config(
			identity.clone(),
			protocol::ActorConfig {
				name: "counter".into(),
				key: Some("alice".into()),
				create_ts: 123,
				input: Some(serde_json::to_vec(&serde_json::json!({
					"schema": DURABLE_OBJECT_ACTOR_INPUT_SCHEMA,
					"binding": "COUNTER",
					"class_name": "Counter",
				}))?),
				worker: Some(worker.clone()),
			},
		)
		.await?;
		assert_eq!(
			transport.preparations.lock().unwrap().as_slice(),
			&[(identity.clone(), worker, Some("Counter".into()))]
		);

		let mut headers = HashMap::new();
		headers.insert(RIVET_DURABLE_OBJECT_CLASS_HEADER.into(), "Injected".into());
		host.fetch_actor(
			identity.clone(),
			HttpRequest {
				method: "POST".into(),
				path: "/increment".into(),
				headers,
				body: None,
				body_stream: None,
			},
		)
		.await?;

		assert_eq!(
			host.worker_binding_env(&identity)?["RIVET_ACTOR"]["durableObjectClass"],
			"Counter"
		);
		let requests = transport.requests.lock().unwrap();
		assert_eq!(requests.len(), 1);
		assert_eq!(
			requests[0].1.get(RIVET_DURABLE_OBJECT_CLASS_HEADER),
			Some(&"Counter".to_string())
		);

		let missing_worker = WorkerdActorIdentity::new("actor_missing_worker", 1)?;
		let result = host
			.start_actor_with_config(
				missing_worker.clone(),
				protocol::ActorConfig {
					name: "counter".into(),
					key: Some("bob".into()),
					create_ts: 124,
					input: Some(serde_json::to_vec(&serde_json::json!({
						"schema": DURABLE_OBJECT_ACTOR_INPUT_SCHEMA,
						"class_name": "Counter",
					}))?),
					worker: None,
				},
			)
			.await;
		assert!(result.is_err());
		assert_eq!(host.current_generation(&missing_worker.actor_id)?, None);
		Ok(())
	}

	#[test]
	fn durable_object_class_input_fails_closed_only_for_its_reserved_schema() -> Result<()> {
		assert_eq!(
			durable_object_class_from_input(Some(b"ordinary input"))?,
			None
		);
		assert_eq!(
			durable_object_class_from_input(Some(br#"{"schema":"application/v1"}"#))?,
			None
		);
		assert!(
			durable_object_class_from_input(Some(
				br#"{"schema":"minisandbox-durable-object/v1","class_name":"bad-name"}"#,
			))
			.is_err()
		);
		Ok(())
	}

	#[tokio::test]
	async fn deployment_update_replaces_code_without_changing_actor_generation() -> Result<()> {
		let transport = Arc::new(RecordingTransport::default());
		let host = WorkerdHost::new(transport.clone());
		let identity = WorkerdActorIdentity::new("durable_object", 9)?;
		let requested = protocol::WorkerVersionReference {
			worker: "counter".into(),
			version_id: String::new(),
		};
		let v1 = protocol::WorkerVersionReference {
			worker: "counter".into(),
			version_id: format!("v_{}", "1".repeat(64)),
		};
		let v2 = protocol::WorkerVersionReference {
			worker: "counter".into(),
			version_id: format!("v_{}", "2".repeat(64)),
		};
		host.start_actor_with_resolved_config(
			identity.clone(),
			protocol::ActorConfig {
				name: "counter".into(),
				key: Some("customer-7".into()),
				create_ts: 123,
				input: None,
				worker: Some(v1.clone()),
			},
			Some(requested.clone()),
		)
		.await?;

		host.replace_worker_version(identity.clone(), requested.clone(), v2.clone())
			.await?;

		assert_eq!(host.current_generation(&identity.actor_id)?, Some(9));
		assert_eq!(host.worker_request_for_actor(&identity)?, Some(requested));
		assert_eq!(host.worker_for_actor(&identity)?, Some(v2.clone()));
		assert_eq!(
			transport.evictions.lock().unwrap().as_slice(),
			&[identity.clone()]
		);
		assert_eq!(
			transport.preparations.lock().unwrap().as_slice(),
			&[(identity.clone(), v1, None), (identity, v2, None)]
		);
		Ok(())
	}

	#[tokio::test]
	async fn deployment_update_does_not_reset_an_unchanged_object_assignment() -> Result<()> {
		let transport = Arc::new(RecordingTransport::default());
		let host = WorkerdHost::new(transport.clone());
		let identity = WorkerdActorIdentity::new("durable_object_sticky", 10)?;
		let requested = protocol::WorkerVersionReference {
			worker: "counter".into(),
			version_id: String::new(),
		};
		let resolved = protocol::WorkerVersionReference {
			worker: "counter".into(),
			version_id: format!("v_{}", "1".repeat(64)),
		};
		host.start_actor_with_resolved_config(
			identity.clone(),
			protocol::ActorConfig {
				name: "counter".into(),
				key: Some("customer-sticky".into()),
				create_ts: 124,
				input: None,
				worker: Some(resolved.clone()),
			},
			Some(requested.clone()),
		)
		.await?;

		host.replace_worker_version(identity.clone(), requested, resolved.clone())
			.await?;

		assert_eq!(host.current_generation(&identity.actor_id)?, Some(10));
		assert_eq!(host.worker_for_actor(&identity)?, Some(resolved));
		assert!(transport.evictions.lock().unwrap().is_empty());
		assert_eq!(transport.preparations.lock().unwrap().len(), 1);
		Ok(())
	}

	#[tokio::test]
	async fn failed_dynamic_prepare_rolls_back_actor_admission() -> Result<()> {
		let host = WorkerdHost::new(Arc::new(FailingPreparationTransport));
		let identity = WorkerdActorIdentity::new("actor_dynamic", 4)?;
		let result = host
			.start_actor_with_worker(
				identity.clone(),
				Some(protocol::WorkerVersionReference {
					worker: "hello".into(),
					version_id: format!("v_{}", "1".repeat(64)),
				}),
			)
			.await;
		assert!(result.is_err());
		assert_eq!(host.current_generation(&identity.actor_id)?, None);
		Ok(())
	}

	#[tokio::test]
	async fn active_actor_capacity_is_hard_and_released_on_stop() -> Result<()> {
		let host = WorkerdHost::new_with_max_active_actors(
			Arc::new(RecordingTransport::default()),
			Some(1),
		);
		let first = WorkerdActorIdentity::new("actor_a", 1)?;
		host.start_actor(first.clone()).await?;
		assert!(
			host.start_actor(WorkerdActorIdentity::new("actor_b", 1)?)
				.await
				.is_err()
		);

		// Replacing a generation does not consume another capacity unit.
		host.start_actor(WorkerdActorIdentity::new("actor_a", 2)?)
			.await?;
		host.stop_actor(WorkerdActorIdentity::new("actor_a", 2)?)
			.await?;
		host.start_actor(WorkerdActorIdentity::new("actor_b", 1)?)
			.await?;
		assert_eq!(host.active_actor_count()?, 1);
		Ok(())
	}

	#[tokio::test]
	async fn drain_fences_admission_and_leaves_relocation_to_pegboard() -> Result<()> {
		let host = WorkerdHost::new_with_max_active_actors(
			Arc::new(RecordingTransport::default()),
			Some(4),
		);
		let actor_a = WorkerdActorIdentity::new("actor_a", 2)?;
		let actor_b = WorkerdActorIdentity::new("actor_b", 7)?;
		host.start_actor(actor_b.clone()).await?;
		host.start_actor(actor_a.clone()).await?;

		let (handle, mut envoy_rx) = test_envoy_handle(&actor_a);
		host.configure_envoy_control(
			handle,
			serde_json::json!({"remaining_slots": 4}),
			serde_json::json!({"remaining_slots": 0}),
		)?;

		// The test Envoy has no live WebSocket, so metadata is latched rather
		// than sent. Local activation must still close immediately. Host drain
		// must not emit ActorIntent::Sleep: zero-capacity metadata makes Pegboard
		// the sole owner of generation-fenced GoingAway relocation.
		assert!(!host.set_draining(true).await?);
		assert!(
			host.start_actor(WorkerdActorIdentity::new("actor_c", 1)?)
				.await
				.is_err()
		);

		assert!(
			tokio::time::timeout(Duration::from_millis(20), envoy_rx.recv())
				.await
				.is_err()
		);

		// A repeated drain request remains idempotent and still cannot become a
		// competing lifecycle writer.
		assert!(!host.set_draining(true).await?);
		assert!(
			tokio::time::timeout(Duration::from_millis(20), envoy_rx.recv())
				.await
				.is_err()
		);

		assert!(!host.set_draining(false).await?);
		host.start_actor(WorkerdActorIdentity::new("actor_c", 1)?)
			.await?;
		Ok(())
	}

	#[tokio::test]
	async fn concurrent_actor_admission_cannot_oversubscribe_capacity() -> Result<()> {
		const CAPACITY: usize = 8;
		const ATTEMPTS: usize = 64;

		let host = Arc::new(WorkerdHost::new_with_max_active_actors(
			Arc::new(RecordingTransport::default()),
			Some(CAPACITY),
		));
		let barrier = Arc::new(tokio::sync::Barrier::new(ATTEMPTS + 1));
		let mut admissions = Vec::with_capacity(ATTEMPTS);
		for index in 0..ATTEMPTS {
			let host = host.clone();
			let barrier = barrier.clone();
			admissions.push(tokio::spawn(async move {
				barrier.wait().await;
				host.start_actor(WorkerdActorIdentity::new(format!("actor_{index}"), 1)?)
					.await
			}));
		}
		barrier.wait().await;

		let mut admitted = 0;
		for admission in admissions {
			if admission.await?.is_ok() {
				admitted += 1;
			}
		}
		assert_eq!(admitted, CAPACITY);
		assert_eq!(host.active_actor_count()?, CAPACITY);
		Ok(())
	}

	#[tokio::test]
	async fn concurrent_activation_cannot_regress_generation() -> Result<()> {
		let host = Arc::new(WorkerdHost::new(Arc::new(RecordingTransport::default())));
		host.start_actor(WorkerdActorIdentity::new("actor_a", 1)?)
			.await?;
		let newer = {
			let host = host.clone();
			tokio::spawn(async move {
				host.start_actor(WorkerdActorIdentity::new("actor_a", 3)?)
					.await
			})
		};
		let stale = {
			let host = host.clone();
			tokio::spawn(async move {
				tokio::task::yield_now().await;
				host.start_actor(WorkerdActorIdentity::new("actor_a", 2)?)
					.await
			})
		};
		newer.await??;
		assert!(stale.await?.is_err());
		assert_eq!(host.current_generation("actor_a")?, Some(3));
		Ok(())
	}

	#[tokio::test]
	async fn fence_removes_admission_even_when_isolate_eviction_fails() -> Result<()> {
		let host = WorkerdHost::new(Arc::new(FailingEvictionTransport));
		let identity = WorkerdActorIdentity::new("actor_a", 7)?;
		host.start_actor(identity.clone()).await?;

		assert!(host.fence_actor(identity).await.is_err());
		assert_eq!(host.current_generation("actor_a")?, None);
		Ok(())
	}

	#[tokio::test]
	async fn stop_keeps_storage_capability_until_inflight_fetch_drains() -> Result<()> {
		let started = Arc::new(tokio::sync::Notify::new());
		let release = Arc::new(tokio::sync::Notify::new());
		let transport = Arc::new(BlockingFetchTransport {
			started: started.clone(),
			release: release.clone(),
		});
		let host = Arc::new(WorkerdHost::new(transport));
		let bridge = Arc::new(WorkerdSqliteBridge::new());
		let identity = WorkerdActorIdentity::new("actor_drain", 3)?;
		host.start_actor(identity.clone()).await?;
		bridge.register_actor(identity.clone(), Arc::new(UnusedSqliteBackend))?;

		let fetch = {
			let host = host.clone();
			let identity = identity.clone();
			tokio::spawn(async move {
				host.fetch_actor(
					identity,
					HttpRequest {
						method: "POST".into(),
						path: "/slow".into(),
						headers: HashMap::new(),
						body: None,
						body_stream: None,
					},
				)
				.await
			})
		};
		started.notified().await;

		let stop = {
			let host = host.clone();
			let bridge = bridge.clone();
			let identity = identity.clone();
			tokio::spawn(async move {
				stop_actor_generation_fail_closed(&host, &bridge, identity).await
			})
		};
		tokio::task::yield_now().await;
		assert_eq!(bridge.current_generation(&identity.actor_id)?, Some(3));
		assert!(!stop.is_finished());

		release.notify_one();
		fetch.await??;
		stop.await??;
		assert_eq!(bridge.current_generation(&identity.actor_id)?, None);
		assert_eq!(host.current_generation(&identity.actor_id)?, None);
		Ok(())
	}

	#[tokio::test]
	async fn stop_failure_fences_host_and_storage_capability() -> Result<()> {
		let host = WorkerdHost::new(Arc::new(FailingEvictionTransport));
		let bridge = WorkerdSqliteBridge::new();
		let identity = WorkerdActorIdentity::new("actor_failed_stop", 4)?;
		host.start_actor(identity.clone()).await?;
		bridge.register_actor(identity.clone(), Arc::new(UnusedSqliteBackend))?;

		assert!(
			stop_actor_generation_fail_closed(&host, &bridge, identity.clone())
				.await
				.is_err()
		);
		assert_eq!(host.current_generation(&identity.actor_id)?, None);
		assert_eq!(bridge.current_generation(&identity.actor_id)?, None);
		Ok(())
	}

	#[tokio::test]
	async fn new_activity_invalidates_the_previous_idle_epoch_and_timer() -> Result<()> {
		let host = WorkerdHost::new(Arc::new(RecordingTransport::default()));
		let identity = WorkerdActorIdentity::new("actor_idle", 2)?;
		host.start_actor(identity.clone()).await?;

		let timer = tokio::spawn(std::future::pending::<()>());
		let timer_abort = timer.abort_handle();
		{
			let mut active = host.active.write().unwrap();
			active
				.get_mut(&identity.actor_id)
				.expect("actor must be active")
				.idle_sleep_task = Some(timer_abort.clone());
		}

		assert_eq!(host.begin_actor_activity(&identity)?, 1);
		tokio::task::yield_now().await;
		assert!(timer_abort.is_finished());
		assert_eq!(host.current_activity_epoch(&identity)?, 1);
		Ok(())
	}

	#[tokio::test]
	async fn idle_timer_emits_only_a_generation_scoped_pegboard_intent() -> Result<()> {
		use rivet_envoy_client::envoy::ToEnvoyMessage;

		let host = Arc::new(WorkerdHost::new(Arc::new(RecordingTransport::default())));
		let identity = WorkerdActorIdentity::new("actor_sleep", 7)?;
		host.start_actor(identity.clone()).await?;
		let (handle, mut envoy_rx) = test_envoy_handle(&identity);

		host.arm_actor_idle_sleep(
			identity.clone(),
			0,
			handle.clone(),
			Duration::from_millis(30),
		)?;
		tokio::time::sleep(Duration::from_millis(5)).await;
		let current_epoch = host.begin_actor_activity(&identity)?;
		assert_eq!(current_epoch, 1);
		assert!(
			tokio::time::timeout(Duration::from_millis(50), envoy_rx.recv())
				.await
				.is_err(),
			"a stale idle epoch emitted a sleep intent"
		);

		host.arm_actor_idle_sleep(
			identity.clone(),
			current_epoch,
			handle,
			Duration::from_millis(5),
		)?;
		let message = tokio::time::timeout(Duration::from_secs(1), envoy_rx.recv())
			.await?
			.context("idle timer did not emit an intent")?;
		assert!(matches!(
			message,
			ToEnvoyMessage::ActorIntent {
				actor_id,
				generation: Some(7),
				intent: protocol::ActorIntent::ActorIntentSleep,
				error: None,
			} if actor_id == identity.actor_id
		));
		assert_eq!(host.current_generation(&identity.actor_id)?, Some(7));
		assert_eq!(host.active_actor_count()?, 1);
		Ok(())
	}

	#[tokio::test]
	async fn idle_sleep_intent_retries_until_new_activity_invalidates_lease() -> Result<()> {
		use rivet_envoy_client::envoy::ToEnvoyMessage;

		let host = Arc::new(WorkerdHost::new(Arc::new(RecordingTransport::default())));
		let identity = WorkerdActorIdentity::new("actor_sleep_retry", 9)?;
		host.start_actor(identity.clone()).await?;
		let (handle, mut envoy_rx) = test_envoy_handle(&identity);

		host.arm_actor_idle_sleep_with_retry_interval(
			identity.clone(),
			0,
			handle.clone(),
			Duration::from_millis(5),
			Duration::from_millis(10),
		)?;
		for _ in 0..2 {
			let message = tokio::time::timeout(Duration::from_secs(1), envoy_rx.recv())
				.await?
				.context("idle timer did not retry its sleep intent")?;
			assert!(matches!(
				message,
				ToEnvoyMessage::ActorIntent {
					actor_id,
					generation: Some(9),
					intent: protocol::ActorIntent::ActorIntentSleep,
					error: None,
				} if actor_id == identity.actor_id
			));
		}

		assert_eq!(host.begin_actor_activity(&identity)?, 1);
		// One retry may already have been queued concurrently with the activity
		// fence. It is generation-scoped and therefore harmless; drain it before
		// proving that the invalidated lease cannot produce any later intents.
		tokio::task::yield_now().await;
		while envoy_rx.try_recv().is_ok() {}
		assert!(
			tokio::time::timeout(Duration::from_millis(40), envoy_rx.recv())
				.await
				.is_err(),
			"a superseded idle lease continued retrying sleep intents"
		);
		Ok(())
	}

	#[tokio::test]
	async fn startup_waits_for_workerd_instead_of_failing_the_host() {
		let transport = Arc::new(EventuallyHealthyTransport {
			failed_attempts: 3,
			attempts: AtomicUsize::new(0),
		});
		let host = WorkerdHost::new(transport.clone());

		wait_for_workerd_ready(&host, Duration::ZERO).await;

		assert_eq!(transport.attempts.load(Ordering::SeqCst), 4);
	}

	#[test]
	fn identity_and_endpoint_validation_fail_closed() {
		assert!(WorkerdActorIdentity::new("actor:a", 1).is_err());
		assert!(WorkerdActorIdentity::new("actor_a", 0).is_err());
		assert!(HttpWorkerdTransport::new("http://0.0.0.0:8080", "0123456789abcdef").is_err());
		assert!(
			HttpWorkerdTransport::new("http://127.0.0.1:8080/path", "0123456789abcdef").is_err()
		);
		assert!(
			HttpWorkerdTransport::new_with_max_in_flight(
				"http://127.0.0.1:8080",
				"0123456789abcdef",
				0,
			)
			.is_err()
		);
		assert!(
			HttpWorkerdTransport::new_with_admission_limits_for_endpoints(
				&[],
				"0123456789abcdef",
				1,
				1,
				1,
			)
			.is_err()
		);
		assert!(
			HttpWorkerdTransport::new_with_admission_limits_for_endpoints(
				&[
					"http://127.0.0.1:8080".into(),
					"http://127.0.0.1:8080".into(),
				],
				"0123456789abcdef",
				1,
				1,
				1,
			)
			.is_err()
		);
	}

	#[test]
	fn actor_endpoint_sharding_is_stable_and_generation_independent() -> Result<()> {
		let transport = HttpWorkerdTransport::new_with_admission_limits_for_endpoints(
			&(0..16)
				.map(|index| format!("http://127.0.0.1:{}", 18080 + index))
				.collect::<Vec<_>>(),
			"0123456789abcdef",
			16,
			64,
			15_000,
		)?;
		let first = WorkerdActorIdentity::new("actor_a", 1)?;
		let replacement = WorkerdActorIdentity::new("actor_a", 99)?;
		assert_eq!(
			transport.endpoint_for(&first),
			transport.endpoint_for(&replacement)
		);

		let used = (0..128)
			.map(|index| WorkerdActorIdentity::new(format!("actor_{index}"), 1))
			.collect::<Result<Vec<_>>>()?
			.into_iter()
			.map(|identity| transport.endpoint_for(&identity).clone())
			.collect::<std::collections::HashSet<_>>();
		assert_eq!(used.len(), 16);
		Ok(())
	}

	#[tokio::test]
	async fn http_transport_bounds_in_flight_workerd_requests() -> Result<()> {
		let active = Arc::new(AtomicUsize::new(0));
		let peak = Arc::new(AtomicUsize::new(0));
		let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
		let address = listener.local_addr()?;
		let server = {
			let active = active.clone();
			let peak = peak.clone();
			tokio::spawn(async move {
				axum::serve(
					listener,
					Router::new().route(
						"/{*path}",
						any(move || {
							let active = active.clone();
							let peak = peak.clone();
							async move {
								let now = active.fetch_add(1, Ordering::SeqCst) + 1;
								peak.fetch_max(now, Ordering::SeqCst);
								tokio::time::sleep(Duration::from_millis(25)).await;
								active.fetch_sub(1, Ordering::SeqCst);
								StatusCode::NO_CONTENT
							}
						}),
					),
				)
				.await
			})
		};
		let transport = Arc::new(HttpWorkerdTransport::new_with_max_in_flight(
			&format!("http://{address}"),
			"0123456789abcdef",
			2,
		)?);
		let mut requests = Vec::new();
		for index in 0..12 {
			let transport = transport.clone();
			requests.push(tokio::spawn(async move {
				transport
					.fetch(
						WorkerdActorIdentity::new(format!("actor_{index}"), 1)?,
						HttpRequest {
							method: "POST".into(),
							path: "/counter".into(),
							headers: HashMap::new(),
							body: None,
							body_stream: None,
						},
					)
					.await
			}))
		}
		for request in requests {
			request.await??;
		}

		assert_eq!(peak.load(Ordering::SeqCst), 2);
		server.abort();
		Ok(())
	}

	#[tokio::test]
	async fn http_transport_bounds_waiters_and_returns_retryable_overload() -> Result<()> {
		let started = Arc::new(tokio::sync::Notify::new());
		let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
		let address = listener.local_addr()?;
		let server = {
			let started = started.clone();
			tokio::spawn(async move {
				axum::serve(
					listener,
					Router::new().route(
						"/{*path}",
						any(move || {
							let started = started.clone();
							async move {
								started.notify_waiters();
								tokio::time::sleep(Duration::from_millis(100)).await;
								StatusCode::NO_CONTENT
							}
						}),
					),
				)
				.await
			})
		};
		let transport = Arc::new(HttpWorkerdTransport::new_with_admission_limits(
			&format!("http://{address}"),
			"0123456789abcdef",
			1,
			1,
			20,
		)?);
		let fetch = |transport: Arc<HttpWorkerdTransport>, actor_id: &'static str| {
			tokio::spawn(async move {
				transport
					.fetch(
						WorkerdActorIdentity::new(actor_id, 1)?,
						HttpRequest {
							method: "GET".into(),
							path: "/counter".into(),
							headers: HashMap::new(),
							body: None,
							body_stream: None,
						},
					)
					.await
			})
		};

		let first_started = started.notified();
		let first = fetch(transport.clone(), "actor_first");
		tokio::time::timeout(Duration::from_secs(1), first_started).await?;
		let queued = fetch(transport.clone(), "actor_queued");
		tokio::time::timeout(Duration::from_secs(1), async {
			while transport.request_gate.stats().queued != 1 {
				tokio::task::yield_now().await;
			}
		})
		.await?;
		let full = fetch(transport.clone(), "actor_full").await??;
		let timed_out = queued.await??;
		let completed = first.await??;

		assert_eq!(completed.status, StatusCode::NO_CONTENT.as_u16());
		assert_eq!(full.status, StatusCode::SERVICE_UNAVAILABLE.as_u16());
		assert_eq!(full.headers["x-rivet-overload-reason"], "queue_full");
		assert_eq!(full.headers["retry-after"], "1");
		assert_eq!(timed_out.status, StatusCode::SERVICE_UNAVAILABLE.as_u16());
		assert_eq!(
			timed_out.headers["x-rivet-overload-reason"],
			"queue_timeout"
		);
		let stats = transport.request_gate.stats();
		assert_eq!(stats.in_flight, 0);
		assert_eq!(stats.queued, 0);
		assert_eq!(stats.peak_in_flight, 1);
		assert_eq!(stats.peak_queued, 1);
		assert_eq!(stats.queued_total, 1);
		assert_eq!(stats.rejected_total, 1);
		assert_eq!(stats.timed_out_total, 1);
		server.abort();
		Ok(())
	}

	#[tokio::test]
	async fn http_transport_does_not_reuse_workerd_connections() -> Result<()> {
		use tokio::io::{AsyncReadExt, AsyncWriteExt};

		let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
		let address = listener.local_addr()?;
		let accepted = Arc::new(AtomicUsize::new(0));
		let server = {
			let accepted = accepted.clone();
			tokio::spawn(async move {
				let mut open_connections = Vec::new();
				for _ in 0..2 {
					let (mut stream, _) = listener.accept().await?;
					accepted.fetch_add(1, Ordering::SeqCst);
					let mut request = Vec::new();
					loop {
						let mut byte = [0_u8; 1];
						stream.read_exact(&mut byte).await?;
						request.push(byte[0]);
						if request.ends_with(b"\r\n\r\n") {
							break;
						}
					}
					stream
						.write_all(
							b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n",
						)
						.await?;
					open_connections.push(stream);
				}
				Ok::<_, anyhow::Error>(open_connections)
			})
		};
		let transport = HttpWorkerdTransport::new_with_max_in_flight(
			&format!("http://{address}"),
			"0123456789abcdef",
			1,
		)?;

		transport.health().await?;
		tokio::time::timeout(Duration::from_secs(1), transport.health()).await??;

		assert_eq!(accepted.load(Ordering::SeqCst), 2);
		server.await??;
		Ok(())
	}

	#[tokio::test]
	async fn http_transport_bounds_stuck_control_requests() -> Result<()> {
		let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
		let address = listener.local_addr()?;
		let server = tokio::spawn(async move {
			axum::serve(
				listener,
				Router::new().route(
					"/{*path}",
					any(|| async { std::future::pending::<StatusCode>().await }),
				),
			)
			.await
		});
		let transport = HttpWorkerdTransport::new_with_control_timeout(
			&[format!("http://{address}")],
			"0123456789abcdef",
			1,
			1,
			1_000,
			Duration::from_millis(20),
		)?;

		let result = tokio::time::timeout(
			Duration::from_secs(1),
			transport.evict(WorkerdActorIdentity::new("actor_a", 7)?),
		)
		.await
		.expect("control request exceeded its outer test deadline");
		let error = result.expect_err("stuck eviction unexpectedly succeeded");
		assert!(
			format!("{error:#}").contains("evict workerd isolate"),
			"unexpected eviction error: {error:#}"
		);
		server.abort();
		Ok(())
	}

	#[tokio::test]
	async fn http_transport_inlines_workerd_response_for_gateway2() -> Result<()> {
		let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
		let address = listener.local_addr()?;
		let server = tokio::spawn(async move {
			axum::serve(
				listener,
				Router::new().route(
					"/{*path}",
					any(|headers: axum::http::HeaderMap| async move {
						assert_eq!(headers[RIVET_ACTOR_ID_HEADER], "actor_a");
						assert_eq!(headers[RIVET_ACTOR_GENERATION_HEADER], "7");
						(StatusCode::CREATED, "durable response").into_response()
					}),
				),
			)
			.await
		});
		let transport =
			HttpWorkerdTransport::new(&format!("http://{address}"), "0123456789abcdef")?;
		let response = transport
			.fetch(
				WorkerdActorIdentity::new("actor_a", 7)?,
				HttpRequest {
					method: "GET".into(),
					path: "/counter".into(),
					headers: HashMap::new(),
					body: None,
					body_stream: None,
				},
			)
			.await?;

		assert_eq!(response.status, StatusCode::CREATED.as_u16());
		assert_eq!(
			response.body.as_deref(),
			Some(b"durable response".as_slice())
		);
		assert!(response.body_stream.is_none());
		server.abort();
		Ok(())
	}

	#[test]
	fn bounded_response_body_rejects_the_first_overflowing_chunk() {
		let mut body = b"1234".to_vec();
		assert!(append_bounded(&mut body, b"5", 4).is_err());
		assert_eq!(body, b"1234");
	}
}
