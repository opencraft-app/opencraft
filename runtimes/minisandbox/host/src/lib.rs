use std::{
	hash::{Hash, Hasher},
	sync::Arc,
};

use anyhow::{Result, anyhow, bail, ensure};
use rivet_envoy_client::{
	config::{
		ActorStopHandle, BoxFuture, EnvoyCallbacks, HttpRequest, HttpResponse, WebSocketHandler,
		WebSocketSender,
	},
	handle::EnvoyHandle,
	protocol,
};
use scc::HashMap;
use tokio::sync::Mutex;

mod backend;
mod http;

pub use backend::{
	LocalSandbox, LocalSandboxFactory, LocalSbxletBackend, MinisandboxRuntimeProfile,
	SandboxCreateRequest, SandboxDestroyReason, SandboxHandle, SbxletBackend,
};

const ACTOR_LOCK_SHARDS: usize = 1_024;
const MAX_ACTOR_ID_BYTES: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MinisandboxActorIdentity {
	pub actor_id: String,
	pub generation: u32,
}

impl MinisandboxActorIdentity {
	pub fn new(actor_id: impl Into<String>, generation: u32) -> Result<Self> {
		let identity = Self {
			actor_id: actor_id.into(),
			generation,
		};
		identity.validate()?;
		Ok(identity)
	}

	pub(crate) fn validate(&self) -> Result<()> {
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

pub struct MinisandboxHost {
	backend: Arc<dyn SbxletBackend>,
	profile: MinisandboxRuntimeProfile,
	actors: HashMap<String, ActorState>,
	actor_locks: Vec<Mutex<()>>,
}

#[derive(Clone, Debug)]
struct ActorState {
	/// Highest generation ever accepted for activation, including an activation
	/// whose teardown or start later failed.
	floor: u32,
	/// Generation that may still own backend resources.
	backend: Option<SandboxHandle>,
	/// Exact generation currently open to request admission.
	admitted: Option<u32>,
}

impl MinisandboxHost {
	pub fn new(backend: Arc<dyn SbxletBackend>, profile: MinisandboxRuntimeProfile) -> Self {
		Self {
			backend,
			profile,
			actors: HashMap::default(),
			actor_locks: (0..ACTOR_LOCK_SHARDS).map(|_| Mutex::new(())).collect(),
		}
	}

	pub async fn start_actor(&self, identity: MinisandboxActorIdentity) -> Result<()> {
		self.start_actor_with_input(identity, None).await
	}

	pub async fn start_actor_with_input(
		&self,
		identity: MinisandboxActorIdentity,
		launch_input: Option<Vec<u8>>,
	) -> Result<()> {
		identity.validate()?;
		let _guard = self.actor_lock(&identity.actor_id).lock().await;
		let mut state = self
			.actors
			.read_sync(&identity.actor_id, |_, state| state.clone())
			.unwrap_or(ActorState {
				floor: 0,
				backend: None,
				admitted: None,
			});

		if identity.generation < state.floor {
			bail!(
				"refusing stale minisandbox activation {}@{}; generation floor is {}",
				identity.actor_id,
				identity.generation,
				state.floor
			);
		}
		if state.admitted == Some(identity.generation) {
			return Ok(());
		}
		state.floor = identity.generation;
		state.admitted = None;
		self.store_state(&identity.actor_id, state.clone());

		if let Some(handle) = state.backend.clone() {
			// Remove admission before teardown. A failed teardown leaves the actor
			// unavailable and preserves both the generation floor and the backend
			// generation so a retry repeats teardown rather than rolling back.
			state.admitted = None;
			self.store_state(&identity.actor_id, state.clone());
			self.backend
				.destroy(handle, SandboxDestroyReason::Replaced)
				.await?;
			state.backend = None;
			self.store_state(&identity.actor_id, state.clone());
		}

		let request = SandboxCreateRequest {
			identity: identity.clone(),
			profile: self.profile.clone(),
			launch_input,
		};
		request.validate()?;
		let handle = self.backend.create(request).await?;
		if handle.identity() != &identity {
			if let Err(error) = self
				.backend
				.destroy(handle, SandboxDestroyReason::GoingAway)
				.await
			{
				tracing::warn!(?error, "failed to destroy invalid sbxlet handle");
			}
			bail!("sbxlet returned a handle for the wrong actor generation");
		}
		state.backend = Some(handle);
		state.admitted = Some(identity.generation);
		self.store_state(&identity.actor_id, state);
		Ok(())
	}

	pub async fn stop_actor(&self, identity: MinisandboxActorIdentity) -> Result<()> {
		self.stop_actor_with_reason(identity, SandboxDestroyReason::StopIntent)
			.await
	}

	pub async fn stop_actor_with_reason(
		&self,
		identity: MinisandboxActorIdentity,
		reason: SandboxDestroyReason,
	) -> Result<()> {
		identity.validate()?;
		let _guard = self.actor_lock(&identity.actor_id).lock().await;
		let Some(mut state) = self
			.actors
			.read_sync(&identity.actor_id, |_, state| state.clone())
		else {
			return Ok(());
		};
		if state.admitted == Some(identity.generation) {
			state.admitted = None;
			self.store_state(&identity.actor_id, state.clone());
		} else if state.admitted.is_some()
			|| state
				.backend
				.as_ref()
				.is_none_or(|handle| handle.identity() != &identity)
		{
			return Ok(());
		}

		let handle = state
			.backend
			.clone()
			.ok_or_else(|| anyhow!("admitted sandbox is missing its sbxlet handle"))?;
		self.backend.destroy(handle, reason).await?;
		state.backend = None;
		self.store_state(&identity.actor_id, state);
		Ok(())
	}

	pub async fn fetch_actor(
		&self,
		identity: MinisandboxActorIdentity,
		request: HttpRequest,
	) -> Result<HttpResponse> {
		identity.validate()?;
		let handle = self
			.actors
			.read_sync(&identity.actor_id, |_, state| {
				(state.admitted == Some(identity.generation))
					.then(|| state.backend.clone())
					.flatten()
			})
			.flatten()
			.ok_or_else(|| anyhow!("actor generation is not active in this minisandbox host"))?;
		let descriptor = self
			.backend
			.open_ingress(handle, self.profile.ingress_port())
			.await?;
		http::forward_http(descriptor, request).await
	}

	pub async fn active_generation(&self, actor_id: &str) -> Option<u32> {
		self.actors
			.read_sync(actor_id, |_, state| state.admitted)
			.flatten()
	}

	pub async fn active_count(&self) -> usize {
		let mut count = 0;
		self.actors.iter_sync(|_, state| {
			count += usize::from(state.admitted.is_some());
			true
		});
		count
	}

	fn store_state(&self, actor_id: &str, state: ActorState) {
		self.actors.upsert_sync(actor_id.to_owned(), state);
	}

	fn actor_lock(&self, actor_id: &str) -> &Mutex<()> {
		let mut hasher = std::collections::hash_map::DefaultHasher::new();
		actor_id.hash(&mut hasher);
		&self.actor_locks[(hasher.finish() as usize) % self.actor_locks.len()]
	}
}

pub struct MinisandboxEnvoyCallbacks {
	host: Arc<MinisandboxHost>,
}

impl MinisandboxEnvoyCallbacks {
	pub fn new(host: Arc<MinisandboxHost>) -> Self {
		Self { host }
	}
}

impl EnvoyCallbacks for MinisandboxEnvoyCallbacks {
	fn on_actor_start(
		&self,
		_handle: EnvoyHandle,
		actor_id: String,
		generation: u32,
		config: protocol::ActorConfig,
		_preloaded_kv: Option<protocol::PreloadedKv>,
	) -> BoxFuture<Result<()>> {
		let host = self.host.clone();
		Box::pin(async move {
			host.start_actor_with_input(
				MinisandboxActorIdentity::new(actor_id, generation)?,
				config.input,
			)
			.await
		})
	}

	fn on_actor_stop_with_completion(
		&self,
		_handle: EnvoyHandle,
		actor_id: String,
		generation: u32,
		reason: protocol::StopActorReason,
		stop_handle: ActorStopHandle,
	) -> BoxFuture<Result<()>> {
		let host = self.host.clone();
		Box::pin(async move {
			let result = match MinisandboxActorIdentity::new(actor_id, generation) {
				Ok(identity) => {
					host.stop_actor_with_reason(identity, destroy_reason(reason))
						.await
				}
				Err(error) => Err(error),
			};
			match result {
				Ok(()) => {
					stop_handle.complete();
					Ok(())
				}
				Err(error) => {
					stop_handle.fail(anyhow!("{error:#}"));
					Err(error)
				}
			}
		})
	}

	fn on_shutdown(&self) {
		// Process teardown closes all local descriptors. The standalone sbxlet
		// protocol will add a bounded drain outside this three-operation ABI.
	}

	fn fetch(
		&self,
		_handle: EnvoyHandle,
		_actor_id: String,
		_gateway_id: protocol::GatewayId,
		_request_id: protocol::RequestId,
		_request: HttpRequest,
	) -> BoxFuture<Result<HttpResponse>> {
		Box::pin(async { bail!("generation-unaware fetch is forbidden for minisandbox") })
	}

	fn fetch_with_generation(
		&self,
		_handle: EnvoyHandle,
		actor_id: String,
		generation: u32,
		_gateway_id: protocol::GatewayId,
		_request_id: protocol::RequestId,
		request: HttpRequest,
	) -> BoxFuture<Result<HttpResponse>> {
		let host = self.host.clone();
		Box::pin(async move {
			host.fetch_actor(
				MinisandboxActorIdentity::new(actor_id, generation)?,
				request,
			)
			.await
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
		_headers: std::collections::HashMap<String, String>,
		_is_hibernatable: bool,
		_is_restoring_hibernatable: bool,
		_sender: WebSocketSender,
	) -> BoxFuture<Result<WebSocketHandler>> {
		Box::pin(async { bail!("minisandbox WebSocket bridge is not enabled yet") })
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

	fn can_hibernate_with_generation(
		&self,
		_actor_id: &str,
		_generation: u32,
		_gateway_id: &protocol::GatewayId,
		_request_id: &protocol::RequestId,
		_request: &HttpRequest,
	) -> BoxFuture<Result<bool>> {
		Box::pin(async { Ok(false) })
	}
}

const fn destroy_reason(reason: protocol::StopActorReason) -> SandboxDestroyReason {
	match reason {
		protocol::StopActorReason::SleepIntent => SandboxDestroyReason::SleepIntent,
		protocol::StopActorReason::StopIntent => SandboxDestroyReason::StopIntent,
		protocol::StopActorReason::Destroy => SandboxDestroyReason::Destroy,
		protocol::StopActorReason::GoingAway => SandboxDestroyReason::GoingAway,
		protocol::StopActorReason::Lost => SandboxDestroyReason::Lost,
	}
}
