use std::{
	collections::BTreeMap,
	io::Read,
	path::{Path, PathBuf},
	process::{Child, Command, Stdio},
	sync::atomic::{AtomicUsize, Ordering},
	sync::{Arc, Mutex},
	time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use axum::response::IntoResponse;
use futures_util::future::try_join_all;
use reqwest::{Client, StatusCode};
use rivet_envoy_client::{config::BoxFuture, protocol};
use rivet_workerd_host::{
	HttpWorkerdTransport, StatelessExecutorConfig, WorkerCodeCache, WorkerdActorIdentity,
	WorkerdHost, WorkerdSqliteBackend, WorkerdSqliteBridge, sqlite_bridge_router,
	stateless_executor_router,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::{
	net::TcpListener,
	sync::Semaphore,
	task::JoinHandle,
	time::{sleep, timeout},
};

const TOKEN: &str = "dev-only-change-me";

struct WorkerdProcess {
	child: Child,
	_temp_dir: TempDir,
}

#[derive(Default)]
struct MemoryPageState {
	pages: BTreeMap<u32, Vec<u8>>,
	head_txid: u64,
}

#[derive(Clone)]
struct CommitGate {
	started: Arc<Semaphore>,
	release: Arc<Semaphore>,
}

struct MemoryPageBackend {
	actor_id: String,
	generation: u64,
	state: Arc<Mutex<MemoryPageState>>,
	commit_gate: Mutex<Option<CommitGate>>,
}

impl MemoryPageBackend {
	fn new(actor_id: &str, generation: u64) -> Self {
		Self::with_state(
			actor_id,
			generation,
			Arc::new(Mutex::new(MemoryPageState::default())),
		)
	}

	fn with_state(actor_id: &str, generation: u64, state: Arc<Mutex<MemoryPageState>>) -> Self {
		Self {
			actor_id: actor_id.to_string(),
			generation,
			state,
			commit_gate: Mutex::new(None),
		}
	}

	fn gate_next_commits(&self) -> CommitGate {
		let gate = CommitGate {
			started: Arc::new(Semaphore::new(0)),
			release: Arc::new(Semaphore::new(0)),
		};
		*self.commit_gate.lock().unwrap() = Some(gate.clone());
		gate
	}

	fn validate(&self, actor_id: &str, generation: Option<u64>) -> Result<()> {
		ensure!(actor_id == self.actor_id, "actor id mismatch");
		ensure!(
			generation == Some(self.generation),
			"actor generation mismatch"
		);
		Ok(())
	}
}

impl WorkerdSqliteBackend for MemoryPageBackend {
	fn get_pages(
		&self,
		request: protocol::SqliteGetPagesRequest,
	) -> BoxFuture<Result<protocol::SqliteGetPagesResponse>> {
		let result = (|| {
			self.validate(&request.actor_id, request.expected_generation)?;
			let state = self.state.lock().unwrap();
			Ok(protocol::SqliteGetPagesResponse::SqliteGetPagesOk(
				protocol::SqliteGetPagesOk {
					pages: request
						.pgnos
						.into_iter()
						.map(|pgno| protocol::SqliteFetchedPage {
							pgno,
							bytes: state.pages.get(&pgno).cloned(),
						})
						.collect(),
					head_txid: Some(state.head_txid),
				},
			))
		})();
		Box::pin(async move { result })
	}

	fn commit(
		&self,
		request: protocol::SqliteCommitRequest,
	) -> BoxFuture<Result<protocol::SqliteCommitResponse>> {
		let validation = self.validate(&request.actor_id, request.expected_generation);
		let gate = self.commit_gate.lock().unwrap().clone();
		let state = self.state.clone();
		Box::pin(async move {
			validation?;
			if let Some(gate) = gate {
				gate.started.add_permits(1);
				gate.release.acquire().await?.forget();
			}
			let mut state = state.lock().unwrap();
			state.pages.retain(|pgno, _| *pgno <= request.db_size_pages);
			for page in request.dirty_pages {
				state.pages.insert(page.pgno, page.bytes);
			}
			state.head_txid += 1;
			Ok(protocol::SqliteCommitResponse::SqliteCommitOk(
				protocol::SqliteCommitOk {
					head_txid: Some(state.head_txid),
				},
			))
		})
	}
}

struct BridgeProcess {
	address: std::net::SocketAddr,
	task: JoinHandle<()>,
}

impl Drop for BridgeProcess {
	fn drop(&mut self) {
		self.task.abort();
	}
}

impl Drop for WorkerdProcess {
	fn drop(&mut self) {
		let _ = self.child.kill();
		let _ = self.child.wait();
	}
}

#[tokio::test]
async fn generations_select_distinct_real_workerd_isolates() -> Result<()> {
	let Some(binary) = workerd_binary() else {
		eprintln!("skipping real workerd test: set WORKERD_BIN to a workerd binary");
		return Ok(());
	};
	let config = Path::new(env!("CARGO_MANIFEST_DIR")).join("workerd/config.capnp");
	let port = reserve_port()?;
	let mut process = spawn_workerd(&binary, &config, port, None, None)?;
	let client = Client::new();
	let endpoint = format!("http://127.0.0.1:{port}");
	wait_until_ready(&client, &endpoint, &mut process).await?;

	assert_eq!(
		actor_request(&client, &endpoint, "actor_a", 7, true).await?["count"],
		1
	);
	let generation_7 = actor_request(&client, &endpoint, "actor_a", 7, true).await?;
	assert_eq!(generation_7["generation"], 7);
	assert_eq!(generation_7["count"], 2);

	let generation_8 = actor_request(&client, &endpoint, "actor_a", 8, false).await?;
	assert_eq!(generation_8["generation"], 8);
	assert_eq!(generation_8["count"], 0);

	let generation_7_again = actor_request(&client, &endpoint, "actor_a", 7, false).await?;
	assert_eq!(generation_7_again["count"], 2);

	let evict = client
		.post(format!("{endpoint}/__rivet/evict"))
		.header("x-rivet-workerd-token", TOKEN)
		.header("x-rivet-actor-id", "actor_a")
		.header("x-rivet-actor-generation", "7")
		.send()
		.await?;
	assert_eq!(evict.status(), StatusCode::NO_CONTENT);

	let unauthorized = client
		.get(format!("{endpoint}/__rivet/healthz"))
		.header("x-rivet-workerd-token", "wrong-token-value")
		.send()
		.await?;
	assert_eq!(unauthorized.status(), StatusCode::NOT_FOUND);
	drop(process);
	Ok(())
}

#[tokio::test]
async fn worker_loader_runs_actor_pinned_code_in_distinct_isolates() -> Result<()> {
	let Some(binary) = workerd_binary() else {
		eprintln!("skipping real workerd test: set WORKERD_BIN to a workerd binary");
		return Ok(());
	};
	let code_requests = Arc::new(AtomicUsize::new(0));
	let counter = code_requests.clone();
	let code_router = axum::Router::new().fallback(axum::routing::get(
		move |uri: axum::http::Uri, headers: axum::http::HeaderMap| {
			let counter = counter.clone();
			async move {
				if headers
					.get("x-rivet-workerd-token")
					.and_then(|value| value.to_str().ok())
					!= Some(TOKEN)
				{
					return axum::http::StatusCode::NOT_FOUND.into_response();
				}
				counter.fetch_add(1, Ordering::Relaxed);
				let source = if uri.path().contains("bad_actor") {
					"export default {"
				} else {
					r#"let count = 0;
					export default { async fetch(request, env) {
						const path = new URL(request.url).pathname;
						if (path === '/cpu-limit') { while (true) {} }
						if (path === '/memory-limit') {
							const values = [];
							while (true) values.push(new Array(131072).fill(Math.random()));
						}
						if (path === '/storage-invalid-binding') {
							try {
								await env.RIVET_STORAGE.sql.exec('SELECT ?', [{ forbidden: true }]);
								return Response.json({ rejected: false });
							} catch (error) {
								return Response.json({
									rejected: String(error).includes('SQL bindings support only'),
								});
							}
						}
						count++;
						let storageCount = null;
						if (path === '/storage') {
							await env.RIVET_STORAGE.sql.exec(
								'CREATE TABLE IF NOT EXISTS user_counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)',
							);
							const result = await env.RIVET_STORAGE.sql.exec(
								"INSERT INTO user_counters (name, value) VALUES (?, 1) " +
								"ON CONFLICT (name) DO UPDATE SET value = value + 1 RETURNING value",
								['main'],
							);
							storageCount = result.rows[0].value;
						}
							return Response.json({
								count,
								storageCount,
								url: request.url,
								actorId: request.headers.get('x-rivet-actor-id'),
								leakedToken: request.headers.has('x-rivet-workerd-token'),
								leakedWorker: request.headers.has('x-rivet-worker-version'),
								leakedOriginalUrl: request.headers.has('x-rivet-original-url'),
							leakedActorNamespace: 'ACTOR' in env,
							leakedTokenBinding: 'RIVET_WORKERD_TOKEN' in env,
						});
					} };"#
				};
				let cpu_ms = if uri.path().contains("memory_actor") {
					5_000
				} else {
					50
				};
				axum::Json(serde_json::json!({
					"compatibilityDate": "2025-08-08",
					"compatibilityFlags": [],
					"limits": {
						"cpuMs": cpu_ms,
						"subRequests": 50,
						"memoryBytes": 134217728
					},
					"mainModule": "worker.js",
					"modules": {
						"worker.js": source
					}
				}))
				.into_response()
			}
		},
	));
	let code_listener = TcpListener::bind("127.0.0.1:0").await?;
	let code_address = code_listener.local_addr()?;
	let code_server = tokio::spawn(async move {
		axum::serve(code_listener, code_router).await.unwrap();
	});

	let config = Path::new(env!("CARGO_MANIFEST_DIR")).join("workerd/config.capnp");
	let port = reserve_port()?;
	let mut process = spawn_workerd(&binary, &config, port, Some(code_address), None)?;
	let client = Client::new();
	let endpoint = format!("http://127.0.0.1:{port}");
	wait_until_ready(&client, &endpoint, &mut process).await?;

	let version = format!("v_{}", "a".repeat(64));
	assert_eq!(
		dynamic_prepare(&client, &endpoint, "actor_a", 1, &version).await?,
		StatusCode::NO_CONTENT
	);
	let first = dynamic_actor_request(&client, &endpoint, "actor_a", 1, &version).await?;
	let second = dynamic_actor_request(&client, &endpoint, "actor_a", 1, &version).await?;
	assert_eq!(
		dynamic_prepare(&client, &endpoint, "actor_b", 1, &version).await?,
		StatusCode::NO_CONTENT
	);
	let other = dynamic_actor_request(&client, &endpoint, "actor_b", 1, &version).await?;
	let first_storage =
		dynamic_actor_request_path(&client, &endpoint, "actor_a", 1, &version, "/storage").await?;
	let second_storage =
		dynamic_actor_request_path(&client, &endpoint, "actor_a", 1, &version, "/storage").await?;
	let other_storage =
		dynamic_actor_request_path(&client, &endpoint, "actor_b", 1, &version, "/storage").await?;
	assert_eq!(first["count"], 1);
	assert_eq!(second["count"], 2);
	assert_eq!(other["count"], 1);
	assert_eq!(first_storage["storageCount"], 1);
	assert_eq!(second_storage["storageCount"], 2);
	assert_eq!(other_storage["storageCount"], 1);
	assert_eq!(first["actorId"], "actor_a");
	assert_eq!(first["url"], "https://example.com/");
	assert_eq!(first["leakedToken"], false);
	assert_eq!(first["leakedWorker"], false);
	assert_eq!(first["leakedOriginalUrl"], false);
	assert_eq!(first["leakedActorNamespace"], false);
	assert_eq!(first["leakedTokenBinding"], false);
	let invalid_binding = dynamic_actor_request_path(
		&client,
		&endpoint,
		"actor_a",
		1,
		&version,
		"/storage-invalid-binding",
	)
	.await?;
	assert_eq!(invalid_binding["rejected"], true);
	assert_eq!(code_requests.load(Ordering::Relaxed), 2);

	let evict = client
		.post(format!("{endpoint}/__rivet/evict"))
		.header("x-rivet-workerd-token", TOKEN)
		.header("x-rivet-actor-id", "actor_a")
		.header("x-rivet-actor-generation", 1)
		.send()
		.await?;
	assert_eq!(evict.status(), StatusCode::NO_CONTENT);
	assert_eq!(
		dynamic_prepare(&client, &endpoint, "actor_a", 1, &version).await?,
		StatusCode::NO_CONTENT
	);
	let reloaded = dynamic_actor_request(&client, &endpoint, "actor_a", 1, &version).await?;
	assert_eq!(reloaded["count"], 1);
	let reloaded_storage =
		dynamic_actor_request_path(&client, &endpoint, "actor_a", 1, &version, "/storage").await?;
	assert_eq!(reloaded_storage["storageCount"], 3);
	assert_eq!(code_requests.load(Ordering::Relaxed), 3);

	let bad_status = dynamic_prepare(&client, &endpoint, "bad_actor", 1, &version).await?;
	assert!(!bad_status.is_success());
	ensure_workerd_running(&mut process)?;
	let missing_class = dynamic_prepare_class(
		&client,
		&endpoint,
		"missing_class_actor",
		1,
		&version,
		"MissingCounter",
	)
	.await?;
	assert!(!missing_class.is_success());
	ensure_workerd_running(&mut process)?;

	let cpu_status = timeout(
		Duration::from_secs(3),
		dynamic_actor_status(&client, &endpoint, "cpu_actor", 1, &version, "/cpu-limit"),
	)
	.await??;
	assert!(!cpu_status.is_success());
	ensure_workerd_running(&mut process)?;

	let memory_status = timeout(
		Duration::from_secs(5),
		dynamic_actor_status(
			&client,
			&endpoint,
			"memory_actor",
			1,
			&version,
			"/memory-limit",
		),
	)
	.await??;
	assert!(!memory_status.is_success());
	ensure_workerd_running(&mut process)?;

	drop(process);
	code_server.abort();
	Ok(())
}

#[tokio::test]
async fn stateless_worker_loader_dispatches_immutable_versions_without_actor_identity() -> Result<()>
{
	let Some(binary) = workerd_binary() else {
		eprintln!("skipping real workerd test: set WORKERD_BIN to a workerd binary");
		return Ok(());
	};
	let code_requests = Arc::new(AtomicUsize::new(0));
	let counter = code_requests.clone();
	let code_router =
		axum::Router::new().fallback(axum::routing::get(move |headers: axum::http::HeaderMap| {
			let counter = counter.clone();
			async move {
				if headers
					.get("x-rivet-workerd-token")
					.and_then(|value| value.to_str().ok())
					!= Some(TOKEN)
				{
					return axum::http::StatusCode::NOT_FOUND.into_response();
				}
				counter.fetch_add(1, Ordering::Relaxed);
				axum::Json(serde_json::json!({
					"compatibilityDate": "2025-08-08",
					"compatibilityFlags": [],
					"limits": {
						"cpuMs": 1000,
						"subRequests": 50,
						"memoryBytes": 134217728
					},
					"mainModule": "worker.js",
					"modules": {
						"worker.js": r#"let count = 0;
							export default { fetch(request, env) {
								count++;
								return Response.json({
									count,
									url: request.url,
									actorId: request.headers.get('x-rivet-actor-id'),
									leakedToken: request.headers.has('x-rivet-workerd-token'),
									leakedWorker: request.headers.has('x-rivet-worker-version'),
									leakedOriginalUrl: request.headers.has('x-rivet-original-url'),
								});
							} };"#
					}
				}))
				.into_response()
			}
		}));
	let code_listener = TcpListener::bind("127.0.0.1:0").await?;
	let code_address = code_listener.local_addr()?;
	let code_server = tokio::spawn(async move {
		axum::serve(code_listener, code_router).await.unwrap();
	});

	let config = Path::new(env!("CARGO_MANIFEST_DIR")).join("workerd/config-stateless.capnp");
	let port = reserve_port()?;
	let mut process = spawn_workerd(&binary, &config, port, Some(code_address), None)?;
	let client = Client::new();
	let endpoint = format!("http://127.0.0.1:{port}");
	wait_until_ready(&client, &endpoint, &mut process).await?;
	let version_one = format!("v_{}", "a".repeat(64));
	let version_two = format!("v_{}", "b".repeat(64));

	assert_eq!(
		stateless_prepare(&client, &endpoint, &version_one).await?,
		StatusCode::NO_CONTENT
	);
	let first = match stateless_request(&client, &endpoint, &version_one).await {
		Ok(value) => value,
		Err(error) => {
			ensure_workerd_running(&mut process)?;
			return Err(error);
		}
	};
	let second = stateless_request(&client, &endpoint, &version_one).await?;
	let other = stateless_request(&client, &endpoint, &version_two).await?;
	assert_eq!(first["count"], 1);
	assert_eq!(second["count"], 2);
	assert_eq!(other["count"], 1);
	assert_eq!(first["url"], "https://example.com/stateless?turn=1");
	assert!(first["actorId"].is_null());
	assert_eq!(first["leakedToken"], false);
	assert_eq!(first["leakedWorker"], false);
	assert_eq!(first["leakedOriginalUrl"], false);
	assert_eq!(code_requests.load(Ordering::Relaxed), 2);
	ensure_workerd_running(&mut process)?;

	drop(process);
	code_server.abort();
	Ok(())
}

#[tokio::test]
async fn stateless_executor_injects_capability_bound_durable_object_namespace() -> Result<()> {
	let Some(binary) = workerd_binary() else {
		eprintln!("skipping real workerd test: set WORKERD_BIN to a workerd binary");
		return Ok(());
	};
	let content = serde_json::json!({
		"schema": "rivet-worker-registry/v5",
		"namespace": "default",
		"worker": "counter",
		"main_module": "main.js",
		"modules": {
			"main.js": r#"import {DurableObject} from "cloudflare:workers";
				export default { async fetch(request, env) {
					if (Object.keys(env).join(',') !== 'COUNTER') throw new Error('internal capability leaked');
					const id = env.COUNTER.idFromName('account-42');
					const response = await env.COUNTER.get(id).fetch(request);
					return Response.json({ id: id.toString(), routed: await response.json() });
				} };
				export class Counter extends DurableObject {}"#
		},
		"compatibility_date": "2026-08-14",
		"compatibility_flags": [],
		"bindings": {"COUNTER": {"type": "durable_object", "class_name": "Counter"}},
		"exports": {"Counter": {"type": "durable_object", "storage": "sqlite"}}
	});
	let content_json = serde_json::to_string(&content)?;
	let digest = hex::encode(Sha256::digest(content_json.as_bytes()));
	let version = format!("v_{digest}");
	let registry_body = format!(
		r#"{{"version_id":"{version}","digest":"sha256:{digest}","created_at":"2026-09-23T00:00:00Z","content":{content_json}}}"#
	);
	let registry = axum::Router::new().fallback(axum::routing::get(move || {
		let body = registry_body.clone();
		async move { ([("content-type", "application/json")], body) }
	}));
	let registry_listener = TcpListener::bind("127.0.0.1:0").await?;
	let registry_address = registry_listener.local_addr()?;
	let registry_server = tokio::spawn(async move {
		axum::serve(registry_listener, registry).await.unwrap();
	});

	let namespace_key = format!(
		"do_{}",
		hex::encode(Sha256::digest(b"default\0counter\0Counter"))
	);
	let expected_id = hex::encode(Sha256::digest(
		format!("rivet-do-id/v1\0default\0default\0{namespace_key}\0account-42").as_bytes(),
	));
	let expected_for_router = expected_id.clone();
	let object_router = axum::Router::new().fallback(axum::routing::any(
		move |request: axum::extract::Request| {
			let expected = expected_for_router.clone();
			async move {
				assert_eq!(
					request
						.headers()
						.get("x-rivet-object-router-token")
						.and_then(|value| value.to_str().ok()),
					Some("object-router-token-change-me")
				);
				assert_eq!(
					request
						.headers()
						.get("x-rivet-original-url")
						.and_then(|value| value.to_str().ok()),
					Some("https://example.com/increment?by=1")
				);
				assert_eq!(
					request.uri().path(),
					format!("/internal/v1/workers/counter/objects/Counter/{expected}/fetch")
				);
				let body = axum::body::to_bytes(request.into_body(), 1024)
					.await
					.unwrap();
				axum::Json(serde_json::json!({"body": String::from_utf8_lossy(&body)}))
			}
		},
	));
	let object_router_listener = TcpListener::bind("127.0.0.1:0").await?;
	let object_router_address = object_router_listener.local_addr()?;
	let object_router_server = tokio::spawn(async move {
		axum::serve(object_router_listener, object_router)
			.await
			.unwrap();
	});

	let workerd_port = reserve_port()?;
	let executor_listener = TcpListener::bind("127.0.0.1:0").await?;
	let executor_address = executor_listener.local_addr()?;
	let cache_dir = TempDir::new()?;
	let cache = Arc::new(WorkerCodeCache::new(
		Some(&format!("http://{registry_address}/")),
		"default",
		cache_dir.path(),
	)?);
	let executor = stateless_executor_router(
		StatelessExecutorConfig {
			listen: executor_address,
			workerd_endpoint: format!("http://127.0.0.1:{workerd_port}"),
			executor_token: "stateless-executor-test-token".into(),
			workerd_token: TOKEN.into(),
			max_in_flight: 4,
			max_queued: 8,
			queue_timeout_ms: 1_000,
		},
		cache,
	)?;
	let executor_server = tokio::spawn(async move {
		axum::serve(executor_listener, executor).await.unwrap();
	});
	let config = Path::new(env!("CARGO_MANIFEST_DIR")).join("workerd/config-stateless.capnp");
	let mut process = spawn_workerd(
		&binary,
		&config,
		workerd_port,
		Some(executor_address),
		Some(object_router_address),
	)?;
	let client = Client::new();
	let workerd_endpoint = format!("http://127.0.0.1:{workerd_port}");
	wait_until_ready(&client, &workerd_endpoint, &mut process).await?;

	let response = client
		.post(format!(
			"http://{executor_address}/internal/v1/workers/counter/versions/{version}/dispatch"
		))
		.header(
			"x-rivet-stateless-executor-token",
			"stateless-executor-test-token",
		)
		.header("x-rivet-original-url", "https://example.com/increment?by=1")
		.body("increment")
		.send()
		.await?;
	let status = response.status();
	let body = response.text().await?;
	ensure!(
		status == StatusCode::OK,
		"binding dispatch returned {status}: {body}"
	);
	let value: Value = serde_json::from_str(&body)?;
	assert_eq!(value["id"], expected_id);
	assert_eq!(value["routed"]["body"], "increment");
	ensure_workerd_running(&mut process)?;

	drop(process);
	executor_server.abort();
	object_router_server.abort();
	registry_server.abort();
	Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn depot_vfs_isolates_many_databases_waits_for_ack_and_survives_restart() -> Result<()> {
	let Some(binary) = std::env::var_os("WORKERD_DEPOT_BIN")
		.map(PathBuf::from)
		.filter(|path| path.is_file())
	else {
		eprintln!("skipping Depot workerd test: set WORKERD_DEPOT_BIN to a Depot-enabled binary");
		return Ok(());
	};
	let actor_count = std::env::var("WORKERD_DEPOT_ACTOR_COUNT")
		.ok()
		.and_then(|value| value.parse::<usize>().ok())
		.unwrap_or(64);
	ensure!(
		actor_count >= 2,
		"Depot workerd test requires at least two actors"
	);
	let bridge = Arc::new(WorkerdSqliteBridge::new());
	let mut backends = Vec::with_capacity(actor_count);
	for index in 0..actor_count {
		let actor_id = format!("density_{index:04}");
		let backend = Arc::new(MemoryPageBackend::new(&actor_id, 1));
		bridge.register_actor(WorkerdActorIdentity::new(&actor_id, 1)?, backend.clone())?;
		backends.push(backend);
	}
	let bridge_process = spawn_bridge(bridge.clone()).await?;
	let config = Path::new(env!("CARGO_MANIFEST_DIR")).join("workerd/config-depot.capnp");
	let client = Client::new();

	let port = reserve_port()?;
	let mut process = spawn_depot_workerd(&binary, &config, port, bridge_process.address, None)?;
	let endpoint = format!("http://127.0.0.1:{port}");
	wait_until_ready(&client, &endpoint, &mut process).await?;
	let increments = (0..actor_count).map(|index| {
		let client = client.clone();
		let endpoint = endpoint.clone();
		async move {
			let actor_id = format!("density_{index:04}");
			let response = actor_request(&client, &endpoint, &actor_id, 1, true).await?;
			ensure!(response["count"] == 1, "actor database was not isolated");
			Ok::<_, anyhow::Error>(())
		}
	});
	try_join_all(increments).await?;

	let gate = backends[0].gate_next_commits();
	let gated_client = client.clone();
	let gated_endpoint = endpoint.clone();
	let mut gated_request = tokio::spawn(async move {
		actor_request(&gated_client, &gated_endpoint, "density_0000", 1, true).await
	});
	timeout(Duration::from_secs(5), gate.started.acquire())
		.await??
		.forget();
	assert!(
		timeout(Duration::from_millis(100), &mut gated_request)
			.await
			.is_err(),
		"workerd replied before the Depot commit ACK"
	);
	gate.release.add_permits(1);
	assert_eq!(gated_request.await??["count"], 2);
	*backends[0].commit_gate.lock().unwrap() = None;

	drop(process);
	let restart_port = reserve_port()?;
	let mut restarted =
		spawn_depot_workerd(&binary, &config, restart_port, bridge_process.address, None)?;
	let restarted_endpoint = format!("http://127.0.0.1:{restart_port}");
	wait_until_ready(&client, &restarted_endpoint, &mut restarted).await?;
	for index in 0..actor_count {
		let actor_id = format!("density_{index:04}");
		let response = actor_request(&client, &restarted_endpoint, &actor_id, 1, false).await?;
		let expected = if index == 0 { 2 } else { 1 };
		ensure!(
			response["count"] == expected,
			"remote database did not survive restart"
		);
	}
	let fence_host = Arc::new(WorkerdHost::new(Arc::new(HttpWorkerdTransport::new(
		&restarted_endpoint,
		TOKEN,
	)?)));
	let stale_identity = WorkerdActorIdentity::new("density_0001", 1)?;
	fence_host.start_actor(stale_identity.clone()).await?;
	let (fence_complete_tx, mut fence_complete_rx) = tokio::sync::mpsc::unbounded_channel();
	let weak_fence_host = Arc::downgrade(&fence_host);
	bridge.set_fence_handler(Arc::new(move |identity| {
		let Some(fence_host) = weak_fence_host.upgrade() else {
			return;
		};
		let fence_complete_tx = fence_complete_tx.clone();
		tokio::spawn(async move {
			let result = fence_host.fence_actor(identity.clone()).await;
			let _ = fence_complete_tx.send((identity, result));
		});
	}))?;

	let replacement = Arc::new(MemoryPageBackend::with_state(
		"density_0001",
		2,
		backends[1].state.clone(),
	));
	bridge.register_actor(WorkerdActorIdentity::new("density_0001", 2)?, replacement)?;
	let stale_write = timeout(
		Duration::from_secs(5),
		actor_request(&client, &restarted_endpoint, "density_0001", 1, true),
	)
	.await?;
	assert!(
		stale_write.is_err(),
		"a fenced generation committed a write"
	);
	ensure_workerd_running(&mut restarted)?;
	let (fenced_identity, fence_result) = timeout(Duration::from_secs(5), fence_complete_rx.recv())
		.await?
		.context("local generation mismatch did not invoke the isolate fence handler")?;
	fence_result?;
	assert_eq!(fenced_identity, stale_identity);
	assert_eq!(fence_host.current_generation("density_0001")?, None);
	assert!(
		actor_request(&client, &restarted_endpoint, "density_0001", 1, false,)
			.await
			.is_err(),
		"an evicted stale generation was able to reopen its database"
	);
	let replacement_response =
		actor_request(&client, &restarted_endpoint, "density_0001", 2, true).await?;
	assert_eq!(replacement_response["count"], 2);
	drop(restarted);
	drop(bridge_process);
	Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dynamic_worker_storage_waits_for_depot_ack_and_survives_process_restart() -> Result<()> {
	let Some(binary) = std::env::var_os("WORKERD_DEPOT_BIN")
		.map(PathBuf::from)
		.filter(|path| path.is_file())
	else {
		eprintln!("skipping Depot workerd test: set WORKERD_DEPOT_BIN to a Depot-enabled binary");
		return Ok(());
	};

	let source = r#"export default { async fetch(request, env) {
		await env.RIVET_STORAGE.sql.exec(
			'CREATE TABLE IF NOT EXISTS user_counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)',
		);
		const result = await env.RIVET_STORAGE.sql.exec(
			"INSERT INTO user_counters (name, value) VALUES (?, 1) " +
			"ON CONFLICT (name) DO UPDATE SET value = value + 1 RETURNING value",
			['main'],
		);
		return Response.json({ value: result.rows[0].value });
	} };"#;
	let code_requests = Arc::new(AtomicUsize::new(0));
	let request_count = code_requests.clone();
	let code_router =
		axum::Router::new().fallback(axum::routing::get(move |headers: axum::http::HeaderMap| {
			let request_count = request_count.clone();
			async move {
				if headers
					.get("x-rivet-workerd-token")
					.and_then(|value| value.to_str().ok())
					!= Some(TOKEN)
				{
					return axum::http::StatusCode::NOT_FOUND.into_response();
				}
				request_count.fetch_add(1, Ordering::Relaxed);
				axum::Json(serde_json::json!({
					"compatibilityDate": "2025-08-08",
					"compatibilityFlags": [],
					"limits": {
						"cpuMs": 50,
						"subRequests": 50,
						"memoryBytes": 134217728
					},
					"mainModule": "worker.js",
					"modules": { "worker.js": source }
				}))
				.into_response()
			}
		}));
	let code_listener = TcpListener::bind("127.0.0.1:0").await?;
	let code_address = code_listener.local_addr()?;
	let code_server = tokio::spawn(async move {
		axum::serve(code_listener, code_router).await.unwrap();
	});

	let actor_id = "dynamic_persistent";
	let backend = Arc::new(MemoryPageBackend::new(actor_id, 1));
	let bridge = Arc::new(WorkerdSqliteBridge::new());
	bridge.register_actor(WorkerdActorIdentity::new(actor_id, 1)?, backend.clone())?;
	let bridge_process = spawn_bridge(bridge).await?;
	let config = Path::new(env!("CARGO_MANIFEST_DIR")).join("workerd/config-depot.capnp");
	let client = Client::new();
	let version = format!("v_{}", "b".repeat(64));

	let port = reserve_port()?;
	let mut process = spawn_depot_workerd(
		&binary,
		&config,
		port,
		bridge_process.address,
		Some(code_address),
	)?;
	let endpoint = format!("http://127.0.0.1:{port}");
	wait_until_ready(&client, &endpoint, &mut process).await?;
	assert_eq!(
		dynamic_prepare(&client, &endpoint, actor_id, 1, &version).await?,
		StatusCode::NO_CONTENT
	);
	let first =
		dynamic_actor_request_path(&client, &endpoint, actor_id, 1, &version, "/storage").await?;
	assert_eq!(first["value"], 1);

	let gate = backend.gate_next_commits();
	let gated_client = client.clone();
	let gated_endpoint = endpoint.clone();
	let gated_actor_id = actor_id.to_string();
	let gated_version = version.clone();
	let mut gated_request = tokio::spawn(async move {
		dynamic_actor_request_path(
			&gated_client,
			&gated_endpoint,
			&gated_actor_id,
			1,
			&gated_version,
			"/storage",
		)
		.await
	});
	timeout(Duration::from_secs(5), gate.started.acquire())
		.await??
		.forget();
	assert!(
		timeout(Duration::from_millis(100), &mut gated_request)
			.await
			.is_err(),
		"dynamic Worker replied before the Depot commit ACK"
	);
	gate.release.add_permits(1);
	assert_eq!(gated_request.await??["value"], 2);
	*backend.commit_gate.lock().unwrap() = None;

	drop(process);
	let restart_port = reserve_port()?;
	let mut restarted = spawn_depot_workerd(
		&binary,
		&config,
		restart_port,
		bridge_process.address,
		Some(code_address),
	)?;
	let restarted_endpoint = format!("http://127.0.0.1:{restart_port}");
	wait_until_ready(&client, &restarted_endpoint, &mut restarted).await?;
	assert_eq!(
		dynamic_prepare(&client, &restarted_endpoint, actor_id, 1, &version).await?,
		StatusCode::NO_CONTENT
	);
	let recovered = dynamic_actor_request_path(
		&client,
		&restarted_endpoint,
		actor_id,
		1,
		&version,
		"/storage",
	)
	.await?;
	assert_eq!(recovered["value"], 3);
	assert_eq!(code_requests.load(Ordering::Relaxed), 2);

	drop(restarted);
	drop(bridge_process);
	code_server.abort();
	Ok(())
}

fn ensure_workerd_running(process: &mut WorkerdProcess) -> Result<()> {
	let Some(status) = process.child.try_wait()? else {
		return Ok(());
	};
	let mut stderr = String::new();
	if let Some(mut stream) = process.child.stderr.take() {
		stream.read_to_string(&mut stderr)?;
	}
	bail!("workerd exited unexpectedly: {status}: {stderr}")
}

fn workerd_binary() -> Option<PathBuf> {
	std::env::var_os("WORKERD_BIN")
		.map(PathBuf::from)
		.filter(|path| path.is_file())
}

fn reserve_port() -> Result<u16> {
	let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
	Ok(listener.local_addr()?.port())
}

fn spawn_workerd(
	binary: &Path,
	config: &Path,
	port: u16,
	worker_code_address: Option<std::net::SocketAddr>,
	object_router_address: Option<std::net::SocketAddr>,
) -> Result<WorkerdProcess> {
	let temp_dir = tempfile::tempdir()?;
	std::fs::create_dir_all(temp_dir.path().join("var/rivet-workerd"))?;
	let mut command = Command::new(binary);
	command
		.arg("serve")
		.arg(config)
		.arg("--experimental")
		.arg("--socket-addr")
		.arg(format!("http=127.0.0.1:{port}"));
	if let Some(address) = worker_code_address {
		command
			.arg("--external-addr")
			.arg(format!("worker-code={address}"));
	}
	if let Some(address) = object_router_address {
		command
			.arg("--external-addr")
			.arg(format!("object-router={address}"));
	}
	let stderr = if std::env::var_os("WORKERD_TEST_INHERIT_STDERR").is_some() {
		Stdio::inherit()
	} else {
		Stdio::piped()
	};
	let child = command
		.current_dir(temp_dir.path())
		.env(
			"LD_LIBRARY_PATH",
			binary.parent().unwrap_or_else(|| Path::new(".")),
		)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(stderr)
		.spawn()
		.with_context(|| format!("spawn {}", binary.display()))?;
	Ok(WorkerdProcess {
		child,
		_temp_dir: temp_dir,
	})
}

fn spawn_depot_workerd(
	binary: &Path,
	config: &Path,
	port: u16,
	bridge_address: std::net::SocketAddr,
	worker_code_address: Option<std::net::SocketAddr>,
) -> Result<WorkerdProcess> {
	let temp_dir = tempfile::tempdir()?;
	let stderr = if std::env::var_os("WORKERD_TEST_INHERIT_STDERR").is_some() {
		Stdio::inherit()
	} else {
		Stdio::piped()
	};
	let mut command = Command::new(binary);
	command
		.arg("serve")
		.arg(config)
		.arg("--experimental")
		.arg("--socket-addr")
		.arg(format!("http=127.0.0.1:{port}"));
	if let Some(address) = worker_code_address {
		command
			.arg("--external-addr")
			.arg(format!("worker-code={address}"));
	}
	let child = command
		.current_dir(temp_dir.path())
		.env(
			"LD_LIBRARY_PATH",
			binary.parent().unwrap_or_else(|| Path::new(".")),
		)
		.env("RIVET_DEPOT_BRIDGE_ADDRESS", bridge_address.to_string())
		.env("RIVET_WORKERD_TOKEN", TOKEN)
		.env("RIVET_DEPOT_MAX_BINDINGS", "256")
		.env(
			"RIVET_DEPOT_MAX_VFS_CACHE_BYTES",
			(512 * 1024 * 1024).to_string(),
		)
		.env(
			"RIVET_WORKERD_SQLITE_MAX_MEMORY_BYTES",
			(16 * 1024 * 1024).to_string(),
		)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(stderr)
		.spawn()
		.with_context(|| format!("spawn Depot-enabled {}", binary.display()))?;
	Ok(WorkerdProcess {
		child,
		_temp_dir: temp_dir,
	})
}

async fn spawn_bridge(bridge: Arc<WorkerdSqliteBridge>) -> Result<BridgeProcess> {
	let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
	let address = listener.local_addr()?;
	let router = sqlite_bridge_router(bridge, TOKEN.to_string())?;
	let task = tokio::spawn(async move {
		if let Err(error) = axum::serve(listener, router).await {
			eprintln!("SQLite bridge stopped: {error}");
		}
	});
	Ok(BridgeProcess { address, task })
}

async fn wait_until_ready(
	client: &Client,
	endpoint: &str,
	process: &mut WorkerdProcess,
) -> Result<()> {
	for _ in 0..100 {
		if let Ok(response) = client
			.get(format!("{endpoint}/__rivet/healthz"))
			.header("x-rivet-workerd-token", TOKEN)
			.send()
			.await
		{
			if response.status() == StatusCode::NO_CONTENT {
				return Ok(());
			}
		}
		if let Some(status) = process.child.try_wait()? {
			let mut stderr = String::new();
			if let Some(mut stream) = process.child.stderr.take() {
				stream.read_to_string(&mut stderr)?;
			}
			bail!("workerd exited before becoming ready: {status}: {stderr}");
		}
		sleep(Duration::from_millis(50)).await;
	}
	bail!("workerd did not become ready")
}

async fn actor_request(
	client: &Client,
	endpoint: &str,
	actor_id: &str,
	generation: u32,
	increment: bool,
) -> Result<Value> {
	let path = if increment { "/increment" } else { "/" };
	let method = if increment {
		reqwest::Method::POST
	} else {
		reqwest::Method::GET
	};
	let response = client
		.request(method, format!("{endpoint}{path}"))
		.header("x-rivet-workerd-token", TOKEN)
		.header("x-rivet-actor-id", actor_id)
		.header("x-rivet-actor-generation", generation)
		.send()
		.await?;
	let status = response.status();
	let body = response.text().await?;
	if !status.is_success() {
		bail!("actor request failed with {status}: {body}");
	}
	serde_json::from_str(&body).context("decode actor response")
}

async fn dynamic_actor_request(
	client: &Client,
	endpoint: &str,
	actor_id: &str,
	generation: u32,
	version: &str,
) -> Result<Value> {
	dynamic_actor_request_path(client, endpoint, actor_id, generation, version, "").await
}

async fn dynamic_actor_request_path(
	client: &Client,
	endpoint: &str,
	actor_id: &str,
	generation: u32,
	version: &str,
	path: &str,
) -> Result<Value> {
	let response = client
		.get(format!("{endpoint}{path}"))
		.header("x-rivet-workerd-token", TOKEN)
		.header("x-rivet-actor-id", actor_id)
		.header("x-rivet-actor-generation", generation)
		.header("x-rivet-worker-name", "hello")
		.header("x-rivet-worker-version", version)
		.header("x-rivet-original-url", format!("https://example.com{path}"))
		.send()
		.await?;
	let status = response.status();
	let body = response.text().await?;
	if !status.is_success() {
		bail!("dynamic actor request failed with {status}: {body}");
	}
	serde_json::from_str(&body).context("decode dynamic actor response")
}

async fn dynamic_prepare(
	client: &Client,
	endpoint: &str,
	actor_id: &str,
	generation: u32,
	version: &str,
) -> Result<StatusCode> {
	Ok(client
		.post(format!("{endpoint}/__rivet/prepare"))
		.header("x-rivet-workerd-token", TOKEN)
		.header("x-rivet-actor-id", actor_id)
		.header("x-rivet-actor-generation", generation)
		.header("x-rivet-worker-name", "hello")
		.header("x-rivet-worker-version", version)
		.send()
		.await?
		.status())
}

async fn dynamic_prepare_class(
	client: &Client,
	endpoint: &str,
	actor_id: &str,
	generation: u32,
	version: &str,
	class_name: &str,
) -> Result<StatusCode> {
	Ok(client
		.post(format!("{endpoint}/__rivet/prepare"))
		.header("x-rivet-workerd-token", TOKEN)
		.header("x-rivet-actor-id", actor_id)
		.header("x-rivet-actor-generation", generation)
		.header("x-rivet-worker-name", "hello")
		.header("x-rivet-worker-version", version)
		.header("x-rivet-durable-object-class", class_name)
		.send()
		.await?
		.status())
}

async fn dynamic_actor_status(
	client: &Client,
	endpoint: &str,
	actor_id: &str,
	generation: u32,
	version: &str,
	path: &str,
) -> Result<StatusCode> {
	Ok(client
		.get(format!("{endpoint}{path}"))
		.header("x-rivet-workerd-token", TOKEN)
		.header("x-rivet-actor-id", actor_id)
		.header("x-rivet-actor-generation", generation)
		.header("x-rivet-worker-name", "hello")
		.header("x-rivet-worker-version", version)
		.send()
		.await?
		.status())
}

async fn stateless_prepare(client: &Client, endpoint: &str, version: &str) -> Result<StatusCode> {
	Ok(client
		.post(format!("{endpoint}/__rivet/prepare"))
		.header("x-rivet-workerd-token", TOKEN)
		.header("x-rivet-worker-name", "hello")
		.header("x-rivet-worker-version", version)
		.send()
		.await?
		.status())
}

async fn stateless_request(client: &Client, endpoint: &str, version: &str) -> Result<Value> {
	let response = client
		.post(format!("{endpoint}/"))
		.header("x-rivet-workerd-token", TOKEN)
		.header("x-rivet-worker-name", "hello")
		.header("x-rivet-worker-version", version)
		.header(
			"x-rivet-original-url",
			"https://example.com/stateless?turn=1",
		)
		.body("hello")
		.send()
		.await?;
	let status = response.status();
	let body = response.text().await?;
	if !status.is_success() {
		bail!("stateless request failed with {status}: {body}");
	}
	serde_json::from_str(&body).context("decode stateless response")
}
