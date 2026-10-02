use std::{
	io,
	net::SocketAddr,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time::Duration,
};

use anyhow::{Context, Result, ensure};
use axum::{
	Router,
	body::Body,
	extract::{Path, Request, State},
	http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
	response::{IntoResponse, Response},
	routing::{any, get, post},
};
use futures_util::{StreamExt, stream};
use reqwest::{Url, redirect::Policy};
use rivet_envoy_client::protocol::WorkerVersionReference;
use tokio::{
	net::TcpStream,
	time::{Instant, sleep, timeout},
};

use crate::{
	RIVET_WORKER_NAME_HEADER, RIVET_WORKER_VERSION_HEADER, RIVET_WORKERD_TOKEN_HEADER,
	WorkerCodeCache, WorkerdRequestGate,
};

pub const RIVET_STATELESS_EXECUTOR_TOKEN_HEADER: &str = "x-rivet-stateless-executor-token";
const RIVET_ORIGINAL_URL_HEADER: &str = "x-rivet-original-url";
const MAX_REQUEST_BODY_BYTES: u64 = 16 << 20;
const MAX_RESPONSE_BODY_BYTES: u64 = 20 << 20;
const MAX_DRAIN_WAIT: Duration = Duration::from_secs(45);

#[derive(Clone, Debug)]
pub struct StatelessExecutorConfig {
	pub listen: SocketAddr,
	pub workerd_endpoint: String,
	pub executor_token: String,
	pub workerd_token: String,
	pub max_in_flight: usize,
	pub max_queued: usize,
	pub queue_timeout_ms: u64,
}

#[derive(Clone)]
struct StatelessExecutorState {
	client: reqwest::Client,
	workerd_endpoint: Url,
	workerd_address: SocketAddr,
	executor_token: Arc<str>,
	workerd_token: HeaderValue,
	code: Arc<WorkerCodeCache>,
	gate: WorkerdRequestGate,
	metrics: Arc<StatelessMetrics>,
	accepting: Arc<AtomicBool>,
}

#[derive(Default)]
struct StatelessMetrics {
	dispatch_total: AtomicU64,
	prepare_total: AtomicU64,
	transport_failures_total: AtomicU64,
	drain_timeouts_total: AtomicU64,
}

pub async fn run_stateless_executor(
	config: StatelessExecutorConfig,
	code: Arc<WorkerCodeCache>,
) -> Result<()> {
	let listen = config.listen;
	let state = stateless_executor_state(config, code)?;
	let accepting = state.accepting.clone();
	let router = stateless_executor_router_from_state(state);
	let listener = tokio::net::TcpListener::bind(listen)
		.await
		.with_context(|| format!("bind stateless executor at {listen}"))?;
	tracing::info!(%listen, "stateless workerd executor listening");
	axum::serve(listener, router)
		.with_graceful_shutdown(shutdown_signal(accepting))
		.await
		.context("serve stateless workerd executor")
}

pub fn stateless_executor_router(
	config: StatelessExecutorConfig,
	code: Arc<WorkerCodeCache>,
) -> Result<Router> {
	Ok(stateless_executor_router_from_state(
		stateless_executor_state(config, code)?,
	))
}

fn stateless_executor_state(
	config: StatelessExecutorConfig,
	code: Arc<WorkerCodeCache>,
) -> Result<StatelessExecutorState> {
	ensure!(
		config.executor_token.len() >= 16,
		"stateless executor token must contain at least 16 characters"
	);
	ensure!(
		config.workerd_token.len() >= 16,
		"workerd token must contain at least 16 characters"
	);
	let workerd_endpoint = parse_workerd_endpoint(&config.workerd_endpoint)?;
	let workerd_address = workerd_endpoint
		.socket_addrs(|| None)
		.context("resolve stateless workerd endpoint")?
		.into_iter()
		.next()
		.context("stateless workerd endpoint has no socket address")?;
	let workerd_token = HeaderValue::from_str(&config.workerd_token)
		.context("workerd token is not a valid HTTP header value")?;
	let gate = WorkerdRequestGate::new(
		config.max_in_flight,
		config.max_queued,
		config.queue_timeout_ms,
	)?;
	let state = StatelessExecutorState {
		client: reqwest::Client::builder()
			.redirect(Policy::none())
			.connect_timeout(Duration::from_secs(2))
			.pool_max_idle_per_host(config.max_in_flight)
			.build()
			.context("build stateless workerd client")?,
		workerd_endpoint,
		workerd_address,
		executor_token: Arc::from(config.executor_token),
		workerd_token,
		code,
		gate,
		metrics: Arc::new(StatelessMetrics::default()),
		accepting: Arc::new(AtomicBool::new(true)),
	};
	Ok(state)
}

fn stateless_executor_router_from_state(state: StatelessExecutorState) -> Router {
	Router::new()
		.route("/healthz", get(health))
		.route("/readyz", get(ready))
		.route("/metrics", get(metrics))
		.route("/internal/v1/drain", post(drain))
		.route(
			"/internal/v1/workers/{worker}/versions/{version}/dispatch",
			any(dispatch),
		)
		.route(
			"/internal/v1/workers/{worker}/versions/{version}/prepare",
			any(prepare),
		)
		.route(
			"/__rivet/stateless-worker-code/{worker}/{version}",
			get(worker_code),
		)
		.with_state(state)
}

async fn prepare(
	State(state): State<StatelessExecutorState>,
	Path((worker, version)): Path<(String, String)>,
	request: Request,
) -> Response {
	if request.method() != axum::http::Method::POST
		|| !authenticated(
			request.headers(),
			RIVET_STATELESS_EXECUTOR_TOKEN_HEADER,
			&state.executor_token,
		) {
		return StatusCode::NOT_FOUND.into_response();
	}
	if !valid_worker(&worker) || !valid_version(&version) {
		return (StatusCode::BAD_REQUEST, "invalid Worker reference").into_response();
	}
	if !state.accepting.load(Ordering::Acquire) {
		return draining_response();
	}
	state.metrics.prepare_total.fetch_add(1, Ordering::Relaxed);
	let permit = match state.gate.acquire().await {
		Ok(permit) => permit,
		Err(error) => {
			return (
				StatusCode::SERVICE_UNAVAILABLE,
				axum::Json(serde_json::json!({
					"code": "executor_overloaded",
					"reason": error.reason,
					"retry_after_ms": error.retry_after_ms,
				})),
			)
				.into_response();
		}
	};
	if !state.accepting.load(Ordering::Acquire) {
		drop(permit);
		return draining_response();
	}
	let Ok(target) = state.workerd_endpoint.join("/__rivet/prepare") else {
		return StatusCode::BAD_GATEWAY.into_response();
	};
	let response = state
		.client
		.post(target)
		.header(RIVET_WORKERD_TOKEN_HEADER, state.workerd_token)
		.header(RIVET_WORKER_NAME_HEADER, worker)
		.header(RIVET_WORKER_VERSION_HEADER, version)
		.send()
		.await;
	drop(permit);
	match response {
		Ok(response) if response.status() == StatusCode::NO_CONTENT => {
			StatusCode::NO_CONTENT.into_response()
		}
		Ok(response) => {
			tracing::warn!(status = %response.status(), "stateless workerd rejected prepare");
			(StatusCode::UNPROCESSABLE_ENTITY, "Worker prepare failed").into_response()
		}
		Err(error) => {
			tracing::warn!(?error, "stateless workerd prepare failed");
			(StatusCode::BAD_GATEWAY, "Worker prepare unavailable").into_response()
		}
	}
}

async fn health() -> StatusCode {
	// Liveness must only answer whether the executor process can serve probes.
	// Coupling it to user-side workerd traffic creates a destructive feedback
	// loop: saturation makes the probe fail, kubelet restarts the proxy, and all
	// response streams holding admission permits are truncated.
	StatusCode::NO_CONTENT
}

async fn ready(State(state): State<StatelessExecutorState>) -> StatusCode {
	if !state.accepting.load(Ordering::Acquire) {
		return StatusCode::SERVICE_UNAVAILABLE;
	}
	workerd_available(&state).await
}

async fn workerd_available(state: &StatelessExecutorState) -> StatusCode {
	// Readiness needs a process-level signal, not a request through the shared
	// root isolate. A loaded Worker may temporarily delay that isolate even
	// though all existing streams and the executor are healthy. TCP reachability
	// still removes the Pod when workerd exits, without turning load into churn.
	match timeout(
		Duration::from_secs(2),
		TcpStream::connect(state.workerd_address),
	)
	.await
	{
		Ok(Ok(stream)) => {
			drop(stream);
			StatusCode::NO_CONTENT
		}
		_ => StatusCode::SERVICE_UNAVAILABLE,
	}
}

async fn drain(State(state): State<StatelessExecutorState>, headers: HeaderMap) -> Response {
	if !authenticated(
		&headers,
		RIVET_STATELESS_EXECUTOR_TOKEN_HEADER,
		&state.executor_token,
	) {
		return StatusCode::NOT_FOUND.into_response();
	}
	state.accepting.store(false, Ordering::Release);
	let deadline = Instant::now() + MAX_DRAIN_WAIT;
	loop {
		let stats = state.gate.stats();
		if stats.in_flight == 0 && stats.queued == 0 {
			break;
		}
		if Instant::now() >= deadline {
			state
				.metrics
				.drain_timeouts_total
				.fetch_add(1, Ordering::Relaxed);
			break;
		}
		sleep(Duration::from_millis(25)).await;
	}
	StatusCode::NO_CONTENT.into_response()
}

async fn metrics(State(state): State<StatelessExecutorState>) -> Response {
	let admission = state.gate.stats();
	let cache = state.code.stats();
	let body = format!(
		concat!(
			"# TYPE rivet_stateless_accepting gauge\n",
			"rivet_stateless_accepting {}\n",
			"# TYPE rivet_stateless_in_flight gauge\n",
			"rivet_stateless_in_flight {}\n",
			"# TYPE rivet_stateless_queued gauge\n",
			"rivet_stateless_queued {}\n",
			"# TYPE rivet_stateless_dispatch_total counter\n",
			"rivet_stateless_dispatch_total {}\n",
			"# TYPE rivet_stateless_prepare_total counter\n",
			"rivet_stateless_prepare_total {}\n",
			"# TYPE rivet_stateless_rejected_total counter\n",
			"rivet_stateless_rejected_total {}\n",
			"# TYPE rivet_stateless_queue_timeout_total counter\n",
			"rivet_stateless_queue_timeout_total {}\n",
			"# TYPE rivet_stateless_transport_failures_total counter\n",
			"rivet_stateless_transport_failures_total {}\n",
			"# TYPE rivet_stateless_drain_timeouts_total counter\n",
			"rivet_stateless_drain_timeouts_total {}\n",
			"# TYPE rivet_stateless_code_cache_memory_hits_total counter\n",
			"rivet_stateless_code_cache_memory_hits_total {}\n",
			"# TYPE rivet_stateless_code_cache_memory_misses_total counter\n",
			"rivet_stateless_code_cache_memory_misses_total {}\n",
			"# TYPE rivet_stateless_code_cache_disk_hits_total counter\n",
			"rivet_stateless_code_cache_disk_hits_total {}\n",
			"# TYPE rivet_stateless_code_registry_fetches_total counter\n",
			"rivet_stateless_code_registry_fetches_total {}\n",
			"# TYPE rivet_stateless_code_cache_memory_entries gauge\n",
			"rivet_stateless_code_cache_memory_entries {}\n",
		),
		u8::from(state.accepting.load(Ordering::Relaxed)),
		admission.in_flight,
		admission.queued,
		state.metrics.dispatch_total.load(Ordering::Relaxed),
		state.metrics.prepare_total.load(Ordering::Relaxed),
		admission.rejected_total,
		admission.timed_out_total,
		state
			.metrics
			.transport_failures_total
			.load(Ordering::Relaxed),
		state.metrics.drain_timeouts_total.load(Ordering::Relaxed),
		cache.memory_hits,
		cache.memory_misses,
		cache.disk_hits,
		cache.registry_fetches,
		cache.memory_entries,
	);
	(
		[(
			header::CONTENT_TYPE,
			"text/plain; version=0.0.4; charset=utf-8",
		)],
		body,
	)
		.into_response()
}

async fn dispatch(
	State(state): State<StatelessExecutorState>,
	Path((worker, version)): Path<(String, String)>,
	request: Request,
) -> Response {
	if !authenticated(
		request.headers(),
		RIVET_STATELESS_EXECUTOR_TOKEN_HEADER,
		&state.executor_token,
	) {
		return StatusCode::NOT_FOUND.into_response();
	}
	if !valid_worker(&worker) || !valid_version(&version) {
		return (StatusCode::BAD_REQUEST, "invalid Worker reference").into_response();
	}
	if !state.accepting.load(Ordering::Acquire) {
		return draining_response();
	}
	state.metrics.dispatch_total.fetch_add(1, Ordering::Relaxed);
	if request
		.headers()
		.get(header::CONTENT_LENGTH)
		.and_then(|value| value.to_str().ok())
		.and_then(|value| value.parse::<u64>().ok())
		.is_some_and(|length| length > MAX_REQUEST_BODY_BYTES)
	{
		return (StatusCode::PAYLOAD_TOO_LARGE, "request body too large").into_response();
	}
	let original_url_valid = request
		.headers()
		.get(RIVET_ORIGINAL_URL_HEADER)
		.and_then(|value| value.to_str().ok())
		.is_some_and(valid_original_url);
	if !original_url_valid {
		return (StatusCode::BAD_REQUEST, "invalid original URL").into_response();
	}

	let permit = match state.gate.acquire().await {
		Ok(permit) => permit,
		Err(error) => {
			let retry_after = error.retry_after_ms.saturating_add(999) / 1_000;
			return (
				StatusCode::SERVICE_UNAVAILABLE,
				[
					(header::RETRY_AFTER, retry_after.max(1).to_string()),
					(
						HeaderName::from_static("x-rivet-overload-reason"),
						error.reason.to_string(),
					),
				],
				axum::Json(serde_json::json!({
					"code": "executor_overloaded",
					"reason": error.reason,
					"retry_after_ms": error.retry_after_ms,
				})),
			)
				.into_response();
		}
	};
	if !state.accepting.load(Ordering::Acquire) {
		drop(permit);
		return draining_response();
	}

	let (parts, body) = request.into_parts();
	let original_url = parts
		.headers
		.get(RIVET_ORIGINAL_URL_HEADER)
		.expect("validated original URL header")
		.clone();
	let mut headers = parts.headers;
	strip_internal_headers(&mut headers);
	headers.insert(RIVET_WORKERD_TOKEN_HEADER, state.workerd_token.clone());
	headers.insert(
		RIVET_WORKER_NAME_HEADER,
		HeaderValue::from_str(&worker).expect("validated Worker name is an HTTP header value"),
	);
	headers.insert(
		RIVET_WORKER_VERSION_HEADER,
		HeaderValue::from_str(&version).expect("validated Version ID is an HTTP header value"),
	);
	// The original URL is authenticated metadata from the public dispatcher. It
	// was removed with all other x-rivet-* headers and is now reinserted exactly.
	headers.insert(
		HeaderName::from_static(RIVET_ORIGINAL_URL_HEADER),
		original_url,
	);
	let request_stream = body.into_data_stream().scan(0_u64, |seen, item| {
		let result = match item {
			Ok(bytes) => {
				*seen = seen.saturating_add(bytes.len() as u64);
				if *seen <= MAX_REQUEST_BODY_BYTES {
					Ok(bytes)
				} else {
					Err(io::Error::new(
						io::ErrorKind::InvalidData,
						"request body too large",
					))
				}
			}
			Err(error) => Err(io::Error::other(error)),
		};
		std::future::ready(Some(result))
	});
	let target = match state.workerd_endpoint.join("/") {
		Ok(target) => target,
		Err(error) => {
			tracing::error!(?error, "build stateless workerd target");
			return StatusCode::BAD_GATEWAY.into_response();
		}
	};
	let response = match state
		.client
		.request(parts.method, target)
		.headers(headers)
		.body(reqwest::Body::wrap_stream(request_stream))
		.send()
		.await
	{
		Ok(response) => response,
		Err(error) => {
			state
				.metrics
				.transport_failures_total
				.fetch_add(1, Ordering::Relaxed);
			tracing::warn!(?error, %worker, %version, "stateless workerd dispatch failed");
			return (
				StatusCode::BAD_GATEWAY,
				axum::Json(serde_json::json!({"code": "indeterminate_result"})),
			)
				.into_response();
		}
	};
	let status = response.status();
	let mut response_headers = response.headers().clone();
	strip_internal_headers(&mut response_headers);
	response_headers.remove("x-workers-error");
	response_headers.remove(header::CONTENT_LENGTH);
	let body_stream = stream::try_unfold(
		(response.bytes_stream(), permit, 0_u64),
		|(mut body, permit, seen)| async move {
			match body.next().await {
				Some(Ok(bytes)) => {
					let next = seen.saturating_add(bytes.len() as u64);
					if next > MAX_RESPONSE_BODY_BYTES {
						Err(io::Error::new(
							io::ErrorKind::InvalidData,
							"response body too large",
						))
					} else {
						Ok(Some((bytes, (body, permit, next))))
					}
				}
				Some(Err(error)) => Err(io::Error::other(error)),
				None => Ok(None),
			}
		},
	);
	let mut outgoing = Response::new(Body::from_stream(body_stream));
	*outgoing.status_mut() = status;
	*outgoing.headers_mut() = response_headers;
	outgoing
}

async fn worker_code(
	State(state): State<StatelessExecutorState>,
	Path((worker, version)): Path<(String, String)>,
	headers: HeaderMap,
) -> Response {
	if !authenticated(
		&headers,
		RIVET_WORKERD_TOKEN_HEADER,
		state
			.workerd_token
			.to_str()
			.expect("validated workerd token header"),
	) {
		return StatusCode::NOT_FOUND.into_response();
	}
	if !valid_worker(&worker) || !valid_version(&version) {
		return (StatusCode::BAD_REQUEST, "invalid Worker reference").into_response();
	}
	let reference = WorkerVersionReference {
		worker,
		version_id: version,
	};
	match state.code.prepare(&reference).await {
		Ok(code) => (
			[
				(header::CONTENT_TYPE, "application/json"),
				(header::CACHE_CONTROL, "private, no-store"),
			],
			code.loader_json().as_ref().clone(),
		)
			.into_response(),
		Err(error) => {
			tracing::error!(?error, worker = %reference.worker, version = %reference.version_id, "serve stateless Worker code");
			(StatusCode::BAD_GATEWAY, "Worker code unavailable").into_response()
		}
	}
}

fn authenticated(headers: &HeaderMap, name: &str, expected: &str) -> bool {
	headers
		.get(name)
		.and_then(|value| value.to_str().ok())
		.is_some_and(|value| value == expected)
}

fn draining_response() -> Response {
	(
		StatusCode::SERVICE_UNAVAILABLE,
		[(header::RETRY_AFTER, "1")],
		axum::Json(serde_json::json!({"code": "executor_draining"})),
	)
		.into_response()
}

fn strip_internal_headers(headers: &mut HeaderMap) {
	let names = headers
		.keys()
		.filter(|name| name.as_str().starts_with("x-rivet-"))
		.cloned()
		.collect::<Vec<_>>();
	for name in names {
		headers.remove(name);
	}
}

fn parse_workerd_endpoint(raw: &str) -> Result<Url> {
	let mut url = Url::parse(raw).context("parse stateless workerd endpoint")?;
	ensure!(
		matches!(url.scheme(), "http" | "https")
			&& url.host_str().is_some()
			&& url.username().is_empty()
			&& url.password().is_none()
			&& url.query().is_none()
			&& url.fragment().is_none(),
		"invalid stateless workerd endpoint"
	);
	url.set_path("/");
	Ok(url)
}

fn valid_worker(value: &str) -> bool {
	(1..=63).contains(&value.len())
		&& value.as_bytes()[0].is_ascii_lowercase()
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_version(value: &str) -> bool {
	value.len() == 66
		&& value.starts_with("v_")
		&& value[2..]
			.bytes()
			.all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_original_url(value: &str) -> bool {
	if value.len() > 8192 {
		return false;
	}
	Url::parse(value).is_ok_and(|url| {
		matches!(url.scheme(), "http" | "https")
			&& url.host_str().is_some()
			&& url.username().is_empty()
			&& url.password().is_none()
	})
}

async fn shutdown_signal(accepting: Arc<AtomicBool>) {
	#[cfg(unix)]
	{
		let Ok(mut terminate) =
			tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
		else {
			let _ = tokio::signal::ctrl_c().await;
			accepting.store(false, Ordering::Release);
			return;
		};
		tokio::select! {
			_ = tokio::signal::ctrl_c() => {},
			_ = terminate.recv() => {},
		}
		accepting.store(false, Ordering::Release);
	}

	#[cfg(not(unix))]
	{
		let _ = tokio::signal::ctrl_c().await;
		accepting.store(false, Ordering::Release);
	}
}

#[cfg(test)]
mod tests {
	use std::{sync::Arc, time::Duration};

	use anyhow::Result;
	use axum::{
		Router,
		body::to_bytes,
		extract::Request,
		http::StatusCode,
		routing::{any, get},
	};
	use reqwest::Client;
	use tempfile::TempDir;
	use tokio::{
		net::TcpListener,
		sync::Semaphore,
		task::JoinHandle,
		time::{sleep, timeout},
	};

	use super::{StatelessExecutorConfig, stateless_executor_router};
	use crate::WorkerCodeCache;

	const EXECUTOR_TOKEN: &str = "stateless-executor-test-token";
	const WORKERD_TOKEN: &str = "stateless-workerd-test-token";
	const VERSION: &str = "v_1111111111111111111111111111111111111111111111111111111111111111";

	#[tokio::test]
	async fn authenticates_and_streams_without_leaking_internal_headers() -> Result<()> {
		let workerd = Router::new().fallback(any(|request: Request| async move {
			assert_eq!(
				request
					.headers()
					.get("x-rivet-workerd-token")
					.and_then(|value| value.to_str().ok()),
				Some(WORKERD_TOKEN)
			);
			assert_eq!(
				request
					.headers()
					.get("x-rivet-worker-name")
					.and_then(|value| value.to_str().ok()),
				Some("counter")
			);
			assert_eq!(
				request
					.headers()
					.get("x-rivet-worker-version")
					.and_then(|value| value.to_str().ok()),
				Some(VERSION)
			);
			assert!(request.headers().get("x-rivet-user-forged").is_none());
			let body = to_bytes(request.into_body(), 1024).await.unwrap();
			(
				StatusCode::CREATED,
				[
					("x-rivet-private", "must-not-leak"),
					("x-workers-error", "must-not-leak"),
				],
				body,
			)
		}));
		let (workerd_endpoint, workerd_task) = spawn(workerd).await?;
		let cache_dir = TempDir::new()?;
		let code = Arc::new(WorkerCodeCache::new(None, "default", cache_dir.path())?);
		let executor = stateless_executor_router(config(&workerd_endpoint, 4, 8), code)?;
		let (executor_endpoint, executor_task) = spawn(executor).await?;
		let client = Client::new();
		let path =
			format!("{executor_endpoint}/internal/v1/workers/counter/versions/{VERSION}/dispatch");
		let unauthorized = client
			.post(&path)
			.header("x-rivet-original-url", "https://example.com/test")
			.send()
			.await?;
		assert_eq!(unauthorized.status(), StatusCode::NOT_FOUND);

		let response = client
			.post(path)
			.header("x-rivet-stateless-executor-token", EXECUTOR_TOKEN)
			.header("x-rivet-original-url", "https://example.com/test")
			.header("x-rivet-user-forged", "untrusted")
			.body("streamed-body")
			.send()
			.await?;
		assert_eq!(response.status(), StatusCode::CREATED);
		assert!(response.headers().get("x-rivet-private").is_none());
		assert!(response.headers().get("x-workers-error").is_none());
		assert_eq!(response.text().await?, "streamed-body");
		let metrics = client
			.get(format!("{executor_endpoint}/metrics"))
			.send()
			.await?
			.text()
			.await?;
		assert!(metrics.contains("rivet_stateless_dispatch_total 1\n"));
		assert!(metrics.contains("rivet_stateless_in_flight 0\n"));
		assert!(metrics.contains("rivet_stateless_queued 0\n"));

		executor_task.abort();
		workerd_task.abort();
		Ok(())
	}

	#[tokio::test]
	async fn rejects_when_bounded_admission_is_full() -> Result<()> {
		let started = Arc::new(Semaphore::new(0));
		let release = Arc::new(Semaphore::new(0));
		let workerd = Router::new().fallback(any({
			let started = started.clone();
			let release = release.clone();
			move |_request: Request| {
				let started = started.clone();
				let release = release.clone();
				async move {
					started.add_permits(1);
					release.acquire().await.unwrap().forget();
					StatusCode::NO_CONTENT
				}
			}
		}));
		let (workerd_endpoint, workerd_task) = spawn(workerd).await?;
		let cache_dir = TempDir::new()?;
		let code = Arc::new(WorkerCodeCache::new(None, "default", cache_dir.path())?);
		let executor = stateless_executor_router(config(&workerd_endpoint, 1, 0), code)?;
		let (executor_endpoint, executor_task) = spawn(executor).await?;
		let client = Client::new();
		let path =
			format!("{executor_endpoint}/internal/v1/workers/counter/versions/{VERSION}/dispatch");
		let send = || {
			client
				.post(path.clone())
				.header("x-rivet-stateless-executor-token", EXECUTOR_TOKEN)
				.header("x-rivet-original-url", "https://example.com/test")
				.send()
		};
		let first = tokio::spawn(send());
		started.acquire().await?.forget();
		let rejected = send().await?;
		assert_eq!(rejected.status(), StatusCode::SERVICE_UNAVAILABLE);
		assert_eq!(
			rejected
				.headers()
				.get("x-rivet-overload-reason")
				.and_then(|value| value.to_str().ok()),
			Some("queue_full")
		);
		release.add_permits(1);
		assert_eq!(first.await??.status(), StatusCode::NO_CONTENT);

		executor_task.abort();
		workerd_task.abort();
		Ok(())
	}

	#[tokio::test]
	async fn authenticated_drain_removes_readiness_and_rejects_new_work() -> Result<()> {
		let workerd = Router::new()
			.route("/__rivet/healthz", get(|| async { StatusCode::NO_CONTENT }))
			.fallback(any(|| async { StatusCode::NO_CONTENT }));
		let (workerd_endpoint, workerd_task) = spawn(workerd).await?;
		let cache_dir = TempDir::new()?;
		let code = Arc::new(WorkerCodeCache::new(None, "default", cache_dir.path())?);
		let executor = stateless_executor_router(config(&workerd_endpoint, 4, 8), code)?;
		let (executor_endpoint, executor_task) = spawn(executor).await?;
		let client = Client::new();

		assert_eq!(
			client
				.get(format!("{executor_endpoint}/readyz"))
				.send()
				.await?
				.status(),
			StatusCode::NO_CONTENT
		);
		assert_eq!(
			client
				.post(format!("{executor_endpoint}/internal/v1/drain"))
				.send()
				.await?
				.status(),
			StatusCode::NOT_FOUND
		);
		assert_eq!(
			client
				.post(format!("{executor_endpoint}/internal/v1/drain"))
				.header("x-rivet-stateless-executor-token", EXECUTOR_TOKEN)
				.send()
				.await?
				.status(),
			StatusCode::NO_CONTENT
		);
		assert_eq!(
			client
				.get(format!("{executor_endpoint}/readyz"))
				.send()
				.await?
				.status(),
			StatusCode::SERVICE_UNAVAILABLE
		);
		assert_eq!(
			client
				.get(format!("{executor_endpoint}/healthz"))
				.send()
				.await?
				.status(),
			StatusCode::NO_CONTENT
		);

		let response = client
			.post(format!(
				"{executor_endpoint}/internal/v1/workers/counter/versions/{VERSION}/dispatch"
			))
			.header("x-rivet-stateless-executor-token", EXECUTOR_TOKEN)
			.header("x-rivet-original-url", "https://example.com/test")
			.send()
			.await?;
		assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
		assert_eq!(
			response
				.headers()
				.get("retry-after")
				.and_then(|value| value.to_str().ok()),
			Some("1")
		);
		assert!(response.text().await?.contains("executor_draining"));
		let metrics = client
			.get(format!("{executor_endpoint}/metrics"))
			.send()
			.await?
			.text()
			.await?;
		assert!(metrics.contains("rivet_stateless_accepting 0\n"));

		executor_task.abort();
		workerd_task.abort();
		Ok(())
	}

	#[tokio::test]
	async fn probes_do_not_treat_busy_workerd_as_a_dead_executor() -> Result<()> {
		let workerd = Router::new().fallback(any(|| async { StatusCode::SERVICE_UNAVAILABLE }));
		let (workerd_endpoint, workerd_task) = spawn(workerd).await?;
		let cache_dir = TempDir::new()?;
		let code = Arc::new(WorkerCodeCache::new(None, "default", cache_dir.path())?);
		let executor = stateless_executor_router(config(&workerd_endpoint, 4, 8), code)?;
		let (executor_endpoint, executor_task) = spawn(executor).await?;
		let client = Client::new();

		for path in ["healthz", "readyz"] {
			assert_eq!(
				client
					.get(format!("{executor_endpoint}/{path}"))
					.send()
					.await?
					.status(),
				StatusCode::NO_CONTENT
			);
		}
		workerd_task.abort();
		let _ = workerd_task.await;
		assert_eq!(
			client
				.get(format!("{executor_endpoint}/readyz"))
				.send()
				.await?
				.status(),
			StatusCode::SERVICE_UNAVAILABLE
		);
		assert_eq!(
			client
				.get(format!("{executor_endpoint}/healthz"))
				.send()
				.await?
				.status(),
			StatusCode::NO_CONTENT
		);

		executor_task.abort();
		Ok(())
	}

	#[tokio::test]
	async fn authenticated_drain_waits_for_in_flight_response_release() -> Result<()> {
		let started = Arc::new(Semaphore::new(0));
		let release = Arc::new(Semaphore::new(0));
		let workerd = Router::new().fallback(any({
			let started = started.clone();
			let release = release.clone();
			move |_request: Request| {
				let started = started.clone();
				let release = release.clone();
				async move {
					started.add_permits(1);
					release.acquire().await.unwrap().forget();
					StatusCode::NO_CONTENT
				}
			}
		}));
		let (workerd_endpoint, workerd_task) = spawn(workerd).await?;
		let cache_dir = TempDir::new()?;
		let code = Arc::new(WorkerCodeCache::new(None, "default", cache_dir.path())?);
		let executor = stateless_executor_router(config(&workerd_endpoint, 4, 8), code)?;
		let (executor_endpoint, executor_task) = spawn(executor).await?;
		let client = Client::new();
		let dispatch_path =
			format!("{executor_endpoint}/internal/v1/workers/counter/versions/{VERSION}/dispatch");
		let dispatch_client = client.clone();
		let dispatch = tokio::spawn(async move {
			let response = dispatch_client
				.post(dispatch_path)
				.header("x-rivet-stateless-executor-token", EXECUTOR_TOKEN)
				.header("x-rivet-original-url", "https://example.com/test")
				.send()
				.await?;
			let status = response.status();
			drop(response);
			Ok::<_, reqwest::Error>(status)
		});
		started.acquire().await?.forget();

		let drain_client = client.clone();
		let drain_endpoint = executor_endpoint.clone();
		let drain = tokio::spawn(async move {
			drain_client
				.post(format!("{drain_endpoint}/internal/v1/drain"))
				.header("x-rivet-stateless-executor-token", EXECUTOR_TOKEN)
				.send()
				.await
		});
		sleep(Duration::from_millis(75)).await;
		assert!(
			!drain.is_finished(),
			"drain returned while a request permit was active"
		);
		release.add_permits(1);
		assert_eq!(dispatch.await??, StatusCode::NO_CONTENT);
		assert_eq!(
			timeout(Duration::from_secs(1), drain).await???.status(),
			StatusCode::NO_CONTENT
		);

		executor_task.abort();
		workerd_task.abort();
		Ok(())
	}

	fn config(endpoint: &str, max_in_flight: usize, max_queued: usize) -> StatelessExecutorConfig {
		StatelessExecutorConfig {
			listen: "127.0.0.1:0".parse().unwrap(),
			workerd_endpoint: endpoint.to_string(),
			executor_token: EXECUTOR_TOKEN.to_string(),
			workerd_token: WORKERD_TOKEN.to_string(),
			max_in_flight,
			max_queued,
			queue_timeout_ms: 1_000,
		}
	}

	async fn spawn(router: Router) -> Result<(String, JoinHandle<()>)> {
		let listener = TcpListener::bind("127.0.0.1:0").await?;
		let address = listener.local_addr()?;
		let task = tokio::spawn(async move {
			axum::serve(listener, router).await.unwrap();
		});
		Ok((format!("http://{address}"), task))
	}
}
