use std::{collections::HashMap, sync::Arc};

use anyhow::{Result, anyhow, ensure};
use axum::{
	Router,
	body::Bytes,
	extract::{DefaultBodyLimit, State},
	http::{HeaderMap, StatusCode},
	response::{IntoResponse, Response},
	routing::{get, post},
};
use depot_client_types::is_fence_mismatch;
use rivet_envoy_client::{config::BoxFuture, handle::EnvoyHandle, protocol};
use serde::{Deserialize, Serialize};

use crate::{
	RIVET_ACTOR_GENERATION_HEADER, RIVET_ACTOR_ID_HEADER, RIVET_WORKERD_TOKEN_HEADER,
	WorkerdActorIdentity, WorkerdAdmissionStats, WorkerdHost,
};

const GET_PAGES_PATH: &str = "/v1/sqlite/get-pages";
const COMMIT_PATH: &str = "/v1/sqlite/commit";
const HEALTH_PATH: &str = "/v1/sqlite/healthz";
const STATS_PATH: &str = "/v1/sqlite/stats";
const DRAIN_PATH: &str = "/v1/sqlite/drain";
const REGISTRY_LOOKUP_PATH: &str = "/v1/sqlite/registry-lookup";
const REGISTRY_RESOLVE_PATH: &str = "/v1/sqlite/registry-resolve";
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_REGISTRY_LOOKUP_ACTORS: usize = 4_096;

pub trait WorkerdSqliteBackend: Send + Sync + 'static {
	fn get_pages(
		&self,
		request: protocol::SqliteGetPagesRequest,
	) -> BoxFuture<Result<protocol::SqliteGetPagesResponse>>;

	fn commit(
		&self,
		request: protocol::SqliteCommitRequest,
	) -> BoxFuture<Result<protocol::SqliteCommitResponse>>;
}

struct EnvoySqliteBackend {
	handle: EnvoyHandle,
}

impl WorkerdSqliteBackend for EnvoySqliteBackend {
	fn get_pages(
		&self,
		request: protocol::SqliteGetPagesRequest,
	) -> BoxFuture<Result<protocol::SqliteGetPagesResponse>> {
		let handle = self.handle.clone();
		Box::pin(async move { handle.sqlite_get_pages(request).await })
	}

	fn commit(
		&self,
		request: protocol::SqliteCommitRequest,
	) -> BoxFuture<Result<protocol::SqliteCommitResponse>> {
		let handle = self.handle.clone();
		Box::pin(async move { handle.sqlite_commit(request).await })
	}
}

struct ActiveActor {
	generation: u32,
	backend: Arc<dyn WorkerdSqliteBackend>,
}

type FenceHandler = Arc<dyn Fn(WorkerdActorIdentity) + Send + Sync>;

#[derive(Default)]
pub struct WorkerdSqliteBridge {
	active: std::sync::RwLock<HashMap<String, ActiveActor>>,
	fence_handler: std::sync::RwLock<Option<FenceHandler>>,
}

impl WorkerdSqliteBridge {
	pub fn new() -> Self {
		Self::default()
	}

	pub fn set_fence_handler(&self, handler: FenceHandler) -> Result<()> {
		let mut current = self
			.fence_handler
			.write()
			.map_err(|_| anyhow!("workerd sqlite bridge fence handler poisoned"))?;
		ensure!(
			current.is_none(),
			"workerd sqlite bridge fence handler already set"
		);
		*current = Some(handler);
		Ok(())
	}

	pub fn register_envoy_actor(
		&self,
		identity: WorkerdActorIdentity,
		handle: EnvoyHandle,
	) -> Result<()> {
		self.register_actor(identity, Arc::new(EnvoySqliteBackend { handle }))
	}

	pub fn register_actor(
		&self,
		identity: WorkerdActorIdentity,
		backend: Arc<dyn WorkerdSqliteBackend>,
	) -> Result<()> {
		let mut active = self
			.active
			.write()
			.map_err(|_| anyhow!("workerd sqlite bridge registry poisoned"))?;
		if let Some(current) = active.get(&identity.actor_id) {
			ensure!(
				identity.generation >= current.generation,
				"refusing stale sqlite bridge registration"
			);
		}
		active.insert(
			identity.actor_id,
			ActiveActor {
				generation: identity.generation,
				backend,
			},
		);
		Ok(())
	}

	pub fn unregister_actor(&self, identity: &WorkerdActorIdentity) -> Result<()> {
		let mut active = self
			.active
			.write()
			.map_err(|_| anyhow!("workerd sqlite bridge registry poisoned"))?;
		if active
			.get(&identity.actor_id)
			.is_some_and(|current| current.generation == identity.generation)
		{
			active.remove(&identity.actor_id);
		}
		Ok(())
	}

	pub fn active_actor_count(&self) -> Result<usize> {
		Ok(self
			.active
			.read()
			.map_err(|_| anyhow!("workerd sqlite bridge registry poisoned"))?
			.len())
	}

	pub fn current_generation(&self, actor_id: &str) -> Result<Option<u32>> {
		Ok(self
			.active
			.read()
			.map_err(|_| anyhow!("workerd sqlite bridge registry poisoned"))?
			.get(actor_id)
			.map(|actor| actor.generation))
	}

	fn fence_actor(&self, identity: WorkerdActorIdentity) -> Result<()> {
		self.unregister_actor(&identity)?;
		let handler = self
			.fence_handler
			.read()
			.map_err(|_| anyhow!("workerd sqlite bridge fence handler poisoned"))?
			.clone();
		if let Some(handler) = handler {
			handler(identity);
		}
		Ok(())
	}

	fn backend(&self, identity: &WorkerdActorIdentity) -> Result<Arc<dyn WorkerdSqliteBackend>> {
		let active = self
			.active
			.read()
			.map_err(|_| anyhow!("workerd sqlite bridge registry poisoned"))?;
		let current = active
			.get(&identity.actor_id)
			.ok_or_else(|| anyhow!("actor is not active in sqlite bridge"))?;
		ensure!(
			current.generation == identity.generation,
			"actor generation is not active in sqlite bridge"
		);
		Ok(current.backend.clone())
	}

	async fn get_pages(
		&self,
		identity: WorkerdActorIdentity,
		mut request: protocol::SqliteGetPagesRequest,
	) -> Result<protocol::SqliteGetPagesResponse> {
		if let Err(error) =
			validate_request_identity(&identity, &request.actor_id, request.expected_generation)
		{
			if is_generation_error(&error) {
				self.fence_actor(identity)?;
			}
			return Err(error);
		}
		request.expected_generation = Some(u64::from(identity.generation));
		let backend = match self.backend(&identity) {
			Ok(backend) => backend,
			Err(error) => {
				if is_generation_error(&error) {
					self.fence_actor(identity)?;
				}
				return Err(error);
			}
		};
		let response = backend.get_pages(request).await?;
		if let protocol::SqliteGetPagesResponse::SqliteErrorResponse(error) = &response
			&& is_fence_mismatch(&error.group, &error.code)
		{
			self.fence_actor(identity)?;
		}
		Ok(response)
	}

	async fn commit(
		&self,
		identity: WorkerdActorIdentity,
		mut request: protocol::SqliteCommitRequest,
	) -> Result<protocol::SqliteCommitResponse> {
		if let Err(error) =
			validate_request_identity(&identity, &request.actor_id, request.expected_generation)
		{
			if is_generation_error(&error) {
				self.fence_actor(identity)?;
			}
			return Err(error);
		}
		request.expected_generation = Some(u64::from(identity.generation));
		let backend = match self.backend(&identity) {
			Ok(backend) => backend,
			Err(error) => {
				if is_generation_error(&error) {
					self.fence_actor(identity)?;
				}
				return Err(error);
			}
		};
		let response = backend.commit(request).await?;
		if let protocol::SqliteCommitResponse::SqliteErrorResponse(error) = &response
			&& is_fence_mismatch(&error.group, &error.code)
		{
			self.fence_actor(identity)?;
		}
		Ok(response)
	}
}

fn validate_request_identity(
	identity: &WorkerdActorIdentity,
	actor_id: &str,
	expected_generation: Option<u64>,
) -> Result<()> {
	ensure!(
		actor_id == identity.actor_id,
		"sqlite request actor_id mismatch"
	);
	if let Some(generation) = expected_generation {
		ensure!(
			generation == u64::from(identity.generation),
			"sqlite request generation mismatch"
		);
	}
	Ok(())
}

#[derive(Clone)]
struct HttpState {
	bridge: Arc<WorkerdSqliteBridge>,
	host: Option<Arc<WorkerdHost>>,
	token: Arc<str>,
}

pub fn sqlite_bridge_router(bridge: Arc<WorkerdSqliteBridge>, token: String) -> Result<Router> {
	sqlite_bridge_router_inner(bridge, None, token)
}

pub fn sqlite_bridge_router_with_host(
	bridge: Arc<WorkerdSqliteBridge>,
	host: Arc<WorkerdHost>,
	token: String,
) -> Result<Router> {
	sqlite_bridge_router_inner(bridge, Some(host), token)
}

/// Narrow cluster-local management surface used by the Cell drain controller.
/// SQLite page and commit routes remain exclusive to the loopback router.
pub fn workerd_management_router(
	bridge: Arc<WorkerdSqliteBridge>,
	host: Arc<WorkerdHost>,
	token: String,
) -> Result<Router> {
	ensure!(
		token.len() >= 16,
		"workerd management token must contain at least 16 characters"
	);
	let state = HttpState {
		bridge,
		host: Some(host),
		token: Arc::from(token),
	};
	Ok(Router::new()
		.route(HEALTH_PATH, get(health))
		.route(STATS_PATH, get(stats))
		.route(DRAIN_PATH, post(set_drain))
		.layer(DefaultBodyLimit::max(1_024))
		.with_state(state))
}

fn sqlite_bridge_router_inner(
	bridge: Arc<WorkerdSqliteBridge>,
	host: Option<Arc<WorkerdHost>>,
	token: String,
) -> Result<Router> {
	ensure!(
		token.len() >= 16,
		"sqlite bridge token must contain at least 16 characters"
	);
	let state = HttpState {
		bridge,
		host,
		token: Arc::from(token),
	};
	Ok(Router::new()
		.route(HEALTH_PATH, get(health))
		.route(STATS_PATH, get(stats))
		.route(DRAIN_PATH, post(set_drain))
		.route(REGISTRY_LOOKUP_PATH, post(registry_lookup))
		.route(REGISTRY_RESOLVE_PATH, post(registry_resolve))
		.route(GET_PAGES_PATH, post(get_pages))
		.route(COMMIT_PATH, post(commit))
		.layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
		.with_state(state))
}

#[derive(Serialize)]
struct RuntimeStats {
	host_active_actors: Option<usize>,
	host_max_active_actors: Option<usize>,
	host_draining: Option<bool>,
	host_accepting_actors: Option<bool>,
	bridge_active_actors: usize,
	quiescent: bool,
	workerd_admission: Option<WorkerdAdmissionStats>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetDrainRequest {
	draining: bool,
}

#[derive(Serialize)]
struct SetDrainResponse {
	metadata_sent: bool,
	stats: RuntimeStats,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryLookupRequest {
	actors: Vec<RegistryLookupIdentity>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryLookupIdentity {
	actor_id: String,
	generation: u32,
}

#[derive(Serialize)]
struct RegistryLookupEntry {
	actor_id: String,
	generation: u32,
	host_active: Option<bool>,
	bridge_active: bool,
}

#[derive(Serialize)]
struct RegistryLookupResponse {
	actors: Vec<RegistryLookupEntry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryResolveRequest {
	actor_ids: Vec<String>,
}

#[derive(Serialize)]
struct RegistryResolveEntry {
	actor_id: String,
	host_generation: Option<u32>,
	bridge_generation: Option<u32>,
}

#[derive(Serialize)]
struct RegistryResolveResponse {
	actors: Vec<RegistryResolveEntry>,
}

async fn stats(State(state): State<HttpState>, headers: HeaderMap) -> Response {
	if !authenticated(&state, &headers) {
		return StatusCode::NOT_FOUND.into_response();
	}
	match runtime_stats(&state) {
		Ok(stats) => axum::Json(stats).into_response(),
		Err(error) => bridge_error(error),
	}
}

async fn set_drain(
	State(state): State<HttpState>,
	headers: HeaderMap,
	axum::Json(request): axum::Json<SetDrainRequest>,
) -> Response {
	if !authenticated(&state, &headers) {
		return StatusCode::NOT_FOUND.into_response();
	}
	let Some(host) = state.host.as_ref() else {
		return (
			StatusCode::NOT_IMPLEMENTED,
			"Host drain control is unavailable",
		)
			.into_response();
	};
	let metadata_sent = match host.set_draining(request.draining).await {
		Ok(sent) => sent,
		Err(error) => return bridge_error(error),
	};
	match runtime_stats(&state) {
		Ok(stats) => axum::Json(SetDrainResponse {
			metadata_sent,
			stats,
		})
		.into_response(),
		Err(error) => bridge_error(error),
	}
}

fn runtime_stats(state: &HttpState) -> Result<RuntimeStats> {
	let bridge_active_actors = match state.bridge.active_actor_count() {
		Ok(value) => value,
		Err(error) => return Err(error),
	};
	let host_active_actors = match state.host.as_ref() {
		Some(host) => match host.active_actor_count() {
			Ok(value) => Some(value),
			Err(error) => return Err(error),
		},
		None => None,
	};
	let quiescent = bridge_active_actors == 0 && host_active_actors.is_none_or(|value| value == 0);
	let workerd_admission = state.host.as_ref().and_then(|host| host.admission_stats());
	let host_max_active_actors = state
		.host
		.as_ref()
		.and_then(|host| host.max_active_actors());
	Ok(RuntimeStats {
		host_active_actors,
		host_max_active_actors,
		host_draining: state.host.as_ref().map(|host| host.is_draining()),
		host_accepting_actors: state.host.as_ref().map(|host| host.is_accepting_actors()),
		bridge_active_actors,
		quiescent,
		workerd_admission,
	})
}

/// Looks up only identities supplied by the caller. This deliberately has no list-all mode:
/// qualification and recovery tools can diagnose an exact manifest in O(manifest size) without
/// turning the runtime registry into a global high-cardinality scan surface.
async fn registry_lookup(
	State(state): State<HttpState>,
	headers: HeaderMap,
	axum::Json(request): axum::Json<RegistryLookupRequest>,
) -> Response {
	if !authenticated(&state, &headers) {
		return StatusCode::NOT_FOUND.into_response();
	}
	if request.actors.len() > MAX_REGISTRY_LOOKUP_ACTORS {
		return (
			StatusCode::PAYLOAD_TOO_LARGE,
			"registry lookup actor limit exceeded",
		)
			.into_response();
	}

	let mut actors = Vec::with_capacity(request.actors.len());
	for requested in request.actors {
		let identity = match WorkerdActorIdentity::new(requested.actor_id, requested.generation) {
			Ok(identity) => identity,
			Err(_) => return (StatusCode::BAD_REQUEST, "invalid actor identity").into_response(),
		};
		let bridge_generation = match state.bridge.current_generation(&identity.actor_id) {
			Ok(generation) => generation,
			Err(error) => return bridge_error(error),
		};
		let host_active = match state.host.as_ref() {
			Some(host) => match host.current_generation(&identity.actor_id) {
				Ok(generation) => Some(generation == Some(identity.generation)),
				Err(error) => return bridge_error(error),
			},
			None => None,
		};
		actors.push(RegistryLookupEntry {
			actor_id: identity.actor_id,
			generation: identity.generation,
			host_active,
			bridge_active: bridge_generation == Some(identity.generation),
		});
	}

	axum::Json(RegistryLookupResponse { actors }).into_response()
}

/// Resolves only caller-supplied Actor IDs to this Host's current generations.
/// It is authenticated and bounded exactly like registry_lookup; there is no
/// list-all mode and no application-facing route. Qualification uses this to
/// bind a public ObjectRef to one exact live generation without exposing the
/// internal Actor identity through the public Workers API.
async fn registry_resolve(
	State(state): State<HttpState>,
	headers: HeaderMap,
	axum::Json(request): axum::Json<RegistryResolveRequest>,
) -> Response {
	if !authenticated(&state, &headers) {
		return StatusCode::NOT_FOUND.into_response();
	}
	if request.actor_ids.len() > MAX_REGISTRY_LOOKUP_ACTORS {
		return (
			StatusCode::PAYLOAD_TOO_LARGE,
			"registry resolve actor limit exceeded",
		)
			.into_response();
	}

	let mut seen = std::collections::HashSet::with_capacity(request.actor_ids.len());
	let mut actors = Vec::with_capacity(request.actor_ids.len());
	for actor_id in request.actor_ids {
		if !seen.insert(actor_id.clone()) || WorkerdActorIdentity::new(actor_id.clone(), 1).is_err()
		{
			return (
				StatusCode::BAD_REQUEST,
				"invalid or duplicate actor identity",
			)
				.into_response();
		}
		let bridge_generation = match state.bridge.current_generation(&actor_id) {
			Ok(generation) => generation,
			Err(error) => return bridge_error(error),
		};
		let host_generation = match state.host.as_ref() {
			Some(host) => match host.current_generation(&actor_id) {
				Ok(generation) => generation,
				Err(error) => return bridge_error(error),
			},
			None => None,
		};
		actors.push(RegistryResolveEntry {
			actor_id,
			host_generation,
			bridge_generation,
		});
	}

	axum::Json(RegistryResolveResponse { actors }).into_response()
}

async fn health(State(state): State<HttpState>, headers: HeaderMap) -> Response {
	if !authenticated(&state, &headers) {
		return StatusCode::NOT_FOUND.into_response();
	}
	StatusCode::NO_CONTENT.into_response()
}

async fn get_pages(State(state): State<HttpState>, headers: HeaderMap, body: Bytes) -> Response {
	let identity = match authenticated_identity(&state, &headers) {
		Ok(identity) => identity,
		Err(response) => return response,
	};
	let request = match serde_bare::from_slice(&body) {
		Ok(request) => request,
		Err(_) => return (StatusCode::BAD_REQUEST, "invalid sqlite request").into_response(),
	};
	match state.bridge.get_pages(identity, request).await {
		Ok(response) => encode_response(response),
		Err(error) if is_generation_error(&error) => encode_response(
			protocol::SqliteGetPagesResponse::SqliteErrorResponse(generation_error()),
		),
		Err(error) => bridge_error(error),
	}
}

async fn commit(State(state): State<HttpState>, headers: HeaderMap, body: Bytes) -> Response {
	let identity = match authenticated_identity(&state, &headers) {
		Ok(identity) => identity,
		Err(response) => return response,
	};
	let request = match serde_bare::from_slice(&body) {
		Ok(request) => request,
		Err(_) => return (StatusCode::BAD_REQUEST, "invalid sqlite request").into_response(),
	};
	match state.bridge.commit(identity, request).await {
		Ok(response) => encode_response(response),
		Err(error) if is_generation_error(&error) => encode_response(
			protocol::SqliteCommitResponse::SqliteErrorResponse(generation_error()),
		),
		Err(error) => bridge_error(error),
	}
}

fn authenticated(state: &HttpState, headers: &HeaderMap) -> bool {
	headers
		.get(RIVET_WORKERD_TOKEN_HEADER)
		.and_then(|value| value.to_str().ok())
		.is_some_and(|value| value == state.token.as_ref())
}

fn authenticated_identity(
	state: &HttpState,
	headers: &HeaderMap,
) -> std::result::Result<WorkerdActorIdentity, Response> {
	if !authenticated(state, headers) {
		return Err(StatusCode::NOT_FOUND.into_response());
	}
	let actor_id = headers
		.get(RIVET_ACTOR_ID_HEADER)
		.and_then(|value| value.to_str().ok())
		.ok_or_else(|| (StatusCode::BAD_REQUEST, "invalid actor identity").into_response())?;
	let generation = headers
		.get(RIVET_ACTOR_GENERATION_HEADER)
		.and_then(|value| value.to_str().ok())
		.and_then(|value| value.parse::<u32>().ok())
		.ok_or_else(|| (StatusCode::BAD_REQUEST, "invalid actor identity").into_response())?;
	WorkerdActorIdentity::new(actor_id, generation)
		.map_err(|_| (StatusCode::BAD_REQUEST, "invalid actor identity").into_response())
}

fn encode_response<T: serde::Serialize>(response: T) -> Response {
	match serde_bare::to_vec(&response) {
		Ok(body) => (StatusCode::OK, body).into_response(),
		Err(error) => bridge_error(error.into()),
	}
}

fn bridge_error(error: anyhow::Error) -> Response {
	tracing::error!(?error, "workerd sqlite bridge request failed");
	(StatusCode::BAD_GATEWAY, "sqlite bridge request failed").into_response()
}

fn is_generation_error(error: &anyhow::Error) -> bool {
	let message = error.to_string();
	message.contains("not active") || message.contains("generation") || message.contains("mismatch")
}

fn generation_error() -> protocol::SqliteErrorResponse {
	protocol::SqliteErrorResponse {
		group: "depot".to_string(),
		code: "writer_fence_mismatch".to_string(),
		message: "actor generation is not active in the workerd SQLite bridge".to_string(),
	}
}

#[cfg(test)]
mod tests {
	use std::sync::Mutex;

	use axum::body::to_bytes;
	use axum::http::HeaderValue;

	use super::*;

	#[derive(Default)]
	struct RecordingBackend {
		generations: Mutex<Vec<Option<u64>>>,
	}

	struct FenceBackend;
	struct NoopTransport;

	impl crate::WorkerdTransport for NoopTransport {
		fn health(&self) -> BoxFuture<Result<()>> {
			Box::pin(async { Ok(()) })
		}

		fn evict(&self, _identity: WorkerdActorIdentity) -> BoxFuture<Result<()>> {
			Box::pin(async { Ok(()) })
		}

		fn fetch(
			&self,
			_identity: WorkerdActorIdentity,
			_request: rivet_envoy_client::config::HttpRequest,
		) -> BoxFuture<Result<rivet_envoy_client::config::HttpResponse>> {
			Box::pin(async { anyhow::bail!("not used by runtime stats test") })
		}
	}

	impl WorkerdSqliteBackend for FenceBackend {
		fn get_pages(
			&self,
			_request: protocol::SqliteGetPagesRequest,
		) -> BoxFuture<Result<protocol::SqliteGetPagesResponse>> {
			Box::pin(async {
				Ok(protocol::SqliteGetPagesResponse::SqliteErrorResponse(
					generation_error(),
				))
			})
		}

		fn commit(
			&self,
			_request: protocol::SqliteCommitRequest,
		) -> BoxFuture<Result<protocol::SqliteCommitResponse>> {
			Box::pin(async {
				Ok(protocol::SqliteCommitResponse::SqliteErrorResponse(
					generation_error(),
				))
			})
		}
	}

	impl WorkerdSqliteBackend for RecordingBackend {
		fn get_pages(
			&self,
			request: protocol::SqliteGetPagesRequest,
		) -> BoxFuture<Result<protocol::SqliteGetPagesResponse>> {
			self.generations
				.lock()
				.unwrap()
				.push(request.expected_generation);
			Box::pin(async move {
				Ok(protocol::SqliteGetPagesResponse::SqliteGetPagesOk(
					protocol::SqliteGetPagesOk {
						pages: Vec::new(),
						head_txid: Some(0),
					},
				))
			})
		}

		fn commit(
			&self,
			request: protocol::SqliteCommitRequest,
		) -> BoxFuture<Result<protocol::SqliteCommitResponse>> {
			self.generations
				.lock()
				.unwrap()
				.push(request.expected_generation);
			Box::pin(async move {
				Ok(protocol::SqliteCommitResponse::SqliteCommitOk(
					protocol::SqliteCommitOk { head_txid: Some(1) },
				))
			})
		}
	}

	#[tokio::test]
	async fn delayed_unregister_cannot_remove_new_generation() -> Result<()> {
		let bridge = WorkerdSqliteBridge::new();
		let backend = Arc::new(RecordingBackend::default());
		bridge.register_actor(WorkerdActorIdentity::new("actor_a", 7)?, backend.clone())?;
		bridge.register_actor(WorkerdActorIdentity::new("actor_a", 8)?, backend.clone())?;
		bridge.unregister_actor(&WorkerdActorIdentity::new("actor_a", 7)?)?;

		bridge
			.get_pages(
				WorkerdActorIdentity::new("actor_a", 8)?,
				protocol::SqliteGetPagesRequest {
					actor_id: "actor_a".to_string(),
					pgnos: vec![1],
					expected_generation: None,
					expected_head_txid: None,
				},
			)
			.await?;
		assert_eq!(backend.generations.lock().unwrap().as_slice(), &[Some(8)]);
		Ok(())
	}

	#[tokio::test]
	async fn request_identity_mismatch_fails_before_backend() -> Result<()> {
		let bridge = WorkerdSqliteBridge::new();
		let backend = Arc::new(RecordingBackend::default());
		bridge.register_actor(WorkerdActorIdentity::new("actor_a", 8)?, backend.clone())?;

		let result = bridge
			.get_pages(
				WorkerdActorIdentity::new("actor_a", 8)?,
				protocol::SqliteGetPagesRequest {
					actor_id: "actor_b".to_string(),
					pgnos: vec![1],
					expected_generation: None,
					expected_head_txid: None,
				},
			)
			.await;
		assert!(result.is_err());
		assert!(backend.generations.lock().unwrap().is_empty());
		Ok(())
	}

	#[tokio::test]
	async fn inactive_generation_is_a_protocol_fence_error_not_a_transport_error() -> Result<()> {
		let bridge = Arc::new(WorkerdSqliteBridge::new());
		let backend = Arc::new(RecordingBackend::default());
		let fenced = Arc::new(Mutex::new(Vec::new()));
		let fenced_for_handler = fenced.clone();
		bridge.set_fence_handler(Arc::new(move |identity| {
			fenced_for_handler.lock().unwrap().push(identity);
		}))?;
		bridge.register_actor(WorkerdActorIdentity::new("actor_a", 8)?, backend.clone())?;
		let state = HttpState {
			bridge: bridge.clone(),
			host: None,
			token: Arc::from("0123456789abcdef"),
		};
		let mut headers = HeaderMap::new();
		headers.insert(
			RIVET_WORKERD_TOKEN_HEADER,
			HeaderValue::from_static("0123456789abcdef"),
		);
		headers.insert(RIVET_ACTOR_ID_HEADER, HeaderValue::from_static("actor_a"));
		headers.insert(RIVET_ACTOR_GENERATION_HEADER, HeaderValue::from_static("7"));
		let body = serde_bare::to_vec(&protocol::SqliteGetPagesRequest {
			actor_id: "actor_a".to_string(),
			pgnos: vec![1],
			expected_generation: Some(7),
			expected_head_txid: None,
		})?;

		let response = get_pages(State(state), headers, Bytes::from(body)).await;
		assert_eq!(response.status(), StatusCode::OK);
		let body = to_bytes(response.into_body(), MAX_BODY_BYTES).await?;
		let response: protocol::SqliteGetPagesResponse = serde_bare::from_slice(&body)?;
		let protocol::SqliteGetPagesResponse::SqliteErrorResponse(error) = response else {
			panic!("expected a writer fence error");
		};
		assert_eq!(error.group, "depot");
		assert_eq!(error.code, "writer_fence_mismatch");
		assert!(backend.generations.lock().unwrap().is_empty());
		assert_eq!(
			fenced.lock().unwrap().as_slice(),
			&[WorkerdActorIdentity::new("actor_a", 7)?]
		);
		assert!(
			bridge
				.backend(&WorkerdActorIdentity::new("actor_a", 8)?)
				.is_ok(),
			"fencing a stale generation removed the active replacement"
		);
		Ok(())
	}

	#[tokio::test]
	async fn structured_fence_response_unregisters_actor_and_notifies_host() -> Result<()> {
		let bridge = WorkerdSqliteBridge::new();
		let identity = WorkerdActorIdentity::new("actor_a", 8)?;
		let fenced = Arc::new(Mutex::new(Vec::new()));
		let fenced_for_handler = fenced.clone();
		bridge.set_fence_handler(Arc::new(move |identity| {
			fenced_for_handler.lock().unwrap().push(identity);
		}))?;
		bridge.register_actor(identity.clone(), Arc::new(FenceBackend))?;

		let response = bridge
			.commit(
				identity.clone(),
				protocol::SqliteCommitRequest {
					actor_id: identity.actor_id.clone(),
					dirty_pages: Vec::new(),
					db_size_pages: 0,
					now_ms: 0,
					expected_generation: Some(u64::from(identity.generation)),
					expected_head_txid: None,
				},
			)
			.await?;
		assert!(matches!(
			response,
			protocol::SqliteCommitResponse::SqliteErrorResponse(_)
		));
		assert_eq!(fenced.lock().unwrap().as_slice(), &[identity.clone()]);
		assert!(bridge.backend(&identity).is_err());
		Ok(())
	}

	#[tokio::test]
	async fn authenticated_stats_prove_actor_registries_return_to_quiescence() -> Result<()> {
		let identity = WorkerdActorIdentity::new("actor_a", 8)?;
		let bridge = Arc::new(WorkerdSqliteBridge::new());
		let host = Arc::new(WorkerdHost::new(Arc::new(NoopTransport)));
		host.start_actor(identity.clone()).await?;
		bridge.register_actor(identity.clone(), Arc::new(RecordingBackend::default()))?;
		let state = HttpState {
			bridge: bridge.clone(),
			host: Some(host.clone()),
			token: Arc::from("0123456789abcdef"),
		};

		let unauthenticated = stats(State(state.clone()), HeaderMap::new()).await;
		assert_eq!(unauthenticated.status(), StatusCode::NOT_FOUND);

		let mut headers = HeaderMap::new();
		headers.insert(
			RIVET_WORKERD_TOKEN_HEADER,
			HeaderValue::from_static("0123456789abcdef"),
		);
		let active = stats(State(state.clone()), headers.clone()).await;
		let body = to_bytes(active.into_body(), MAX_BODY_BYTES).await?;
		let active: serde_json::Value = serde_json::from_slice(&body)?;
		assert_eq!(active["host_active_actors"], 1);
		assert_eq!(active["host_max_active_actors"], serde_json::Value::Null);
		assert_eq!(active["bridge_active_actors"], 1);
		assert_eq!(active["quiescent"], false);

		bridge.unregister_actor(&identity)?;
		host.stop_actor(identity).await?;
		let quiescent = stats(State(state), headers).await;
		let body = to_bytes(quiescent.into_body(), MAX_BODY_BYTES).await?;
		let quiescent: serde_json::Value = serde_json::from_slice(&body)?;
		assert_eq!(quiescent["host_active_actors"], 0);
		assert_eq!(quiescent["bridge_active_actors"], 0);
		assert_eq!(quiescent["quiescent"], true);
		Ok(())
	}

	#[tokio::test]
	async fn registry_lookup_is_authenticated_exact_and_generation_aware() -> Result<()> {
		let identity = WorkerdActorIdentity::new("actor_a", 8)?;
		let bridge = Arc::new(WorkerdSqliteBridge::new());
		let host = Arc::new(WorkerdHost::new(Arc::new(NoopTransport)));
		host.start_actor(identity.clone()).await?;
		bridge.register_actor(identity.clone(), Arc::new(RecordingBackend::default()))?;
		let state = HttpState {
			bridge,
			host: Some(host),
			token: Arc::from("0123456789abcdef"),
		};
		let request = || RegistryLookupRequest {
			actors: vec![
				RegistryLookupIdentity {
					actor_id: "actor_a".to_string(),
					generation: 8,
				},
				RegistryLookupIdentity {
					actor_id: "actor_a".to_string(),
					generation: 7,
				},
				RegistryLookupIdentity {
					actor_id: "actor_b".to_string(),
					generation: 1,
				},
			],
		};

		let unauthenticated = registry_lookup(
			State(state.clone()),
			HeaderMap::new(),
			axum::Json(request()),
		)
		.await;
		assert_eq!(unauthenticated.status(), StatusCode::NOT_FOUND);

		let mut headers = HeaderMap::new();
		headers.insert(
			RIVET_WORKERD_TOKEN_HEADER,
			HeaderValue::from_static("0123456789abcdef"),
		);
		let response = registry_lookup(State(state), headers, axum::Json(request())).await;
		assert_eq!(response.status(), StatusCode::OK);
		let body = to_bytes(response.into_body(), MAX_BODY_BYTES).await?;
		let response: serde_json::Value = serde_json::from_slice(&body)?;
		assert_eq!(response["actors"][0]["host_active"], true);
		assert_eq!(response["actors"][0]["bridge_active"], true);
		assert_eq!(response["actors"][1]["host_active"], false);
		assert_eq!(response["actors"][1]["bridge_active"], false);
		assert_eq!(response["actors"][2]["host_active"], false);
		assert_eq!(response["actors"][2]["bridge_active"], false);
		Ok(())
	}

	#[tokio::test]
	async fn registry_resolve_is_authenticated_bounded_and_current() -> Result<()> {
		let identity = WorkerdActorIdentity::new("actor_a", 8)?;
		let bridge = Arc::new(WorkerdSqliteBridge::new());
		let host = Arc::new(WorkerdHost::new(Arc::new(NoopTransport)));
		host.start_actor(identity.clone()).await?;
		bridge.register_actor(identity, Arc::new(RecordingBackend::default()))?;
		let state = HttpState {
			bridge,
			host: Some(host),
			token: Arc::from("0123456789abcdef"),
		};
		let request = || RegistryResolveRequest {
			actor_ids: vec!["actor_a".to_string(), "actor_b".to_string()],
		};

		let unauthenticated = registry_resolve(
			State(state.clone()),
			HeaderMap::new(),
			axum::Json(request()),
		)
		.await;
		assert_eq!(unauthenticated.status(), StatusCode::NOT_FOUND);

		let mut headers = HeaderMap::new();
		headers.insert(
			RIVET_WORKERD_TOKEN_HEADER,
			HeaderValue::from_static("0123456789abcdef"),
		);
		let response =
			registry_resolve(State(state.clone()), headers.clone(), axum::Json(request())).await;
		assert_eq!(response.status(), StatusCode::OK);
		let body = to_bytes(response.into_body(), MAX_BODY_BYTES).await?;
		let response: serde_json::Value = serde_json::from_slice(&body)?;
		assert_eq!(response["actors"][0]["actor_id"], "actor_a");
		assert_eq!(response["actors"][0]["host_generation"], 8);
		assert_eq!(response["actors"][0]["bridge_generation"], 8);
		assert!(response["actors"][1]["host_generation"].is_null());
		assert!(response["actors"][1]["bridge_generation"].is_null());

		let duplicate = registry_resolve(
			State(state),
			headers,
			axum::Json(RegistryResolveRequest {
				actor_ids: vec!["actor_a".to_string(), "actor_a".to_string()],
			}),
		)
		.await;
		assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);
		Ok(())
	}

	#[tokio::test]
	async fn registry_lookup_rejects_unbounded_manifests() -> Result<()> {
		let state = HttpState {
			bridge: Arc::new(WorkerdSqliteBridge::new()),
			host: None,
			token: Arc::from("0123456789abcdef"),
		};
		let mut headers = HeaderMap::new();
		headers.insert(
			RIVET_WORKERD_TOKEN_HEADER,
			HeaderValue::from_static("0123456789abcdef"),
		);
		let actors = (0..=MAX_REGISTRY_LOOKUP_ACTORS)
			.map(|index| RegistryLookupIdentity {
				actor_id: format!("actor_{index}"),
				generation: 1,
			})
			.collect();
		let response = registry_lookup(
			State(state),
			headers,
			axum::Json(RegistryLookupRequest { actors }),
		)
		.await;
		assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
		Ok(())
	}
}
