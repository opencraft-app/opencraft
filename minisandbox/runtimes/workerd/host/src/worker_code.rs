use std::{
	collections::{BTreeMap, BTreeSet},
	path::{Path as FsPath, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::{Duration, Instant, SystemTime},
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use axum::{
	Router,
	extract::{Path, State},
	http::{HeaderMap, StatusCode, header},
	response::{IntoResponse, Response},
	routing::get,
};
use futures_util::StreamExt;
use moka::future::Cache;
use reqwest::{Url, redirect::Policy};
use rivet_envoy_client::protocol::WorkerVersionReference;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, Semaphore};

use crate::{RIVET_WORKERD_TOKEN_HEADER, WorkerdActorIdentity, WorkerdHost};

// Must match infra/cells/internal/workerregistry.Schema. Version content is
// immutable and the Host fails closed before loading code from another schema.
const SCHEMA: &str = "rivet-worker-registry/v5";
const MAX_REGISTRY_RESPONSE_BYTES: usize = 16 << 20;
const MAX_DEPLOYMENT_RESPONSE_BYTES: usize = 64 << 10;
const MAX_MODULES: usize = 64;
const MAX_MODULE_BYTES: usize = 1 << 20;
const MAX_TOTAL_MODULE_BYTES: usize = 2 << 20;
const MAX_COMPATIBILITY_FLAGS: usize = 32;
const MEMORY_CACHE_BYTES: u64 = 64 << 20;
const DISK_CACHE_HIGH_WATERMARK_BYTES: u64 = 384 << 20;
const DISK_CACHE_LOW_WATERMARK_BYTES: u64 = 320 << 20;
const MAX_CONCURRENT_FETCHES: usize = 8;
const INTERNAL_WRAPPER_MODULE: &str = "__rivet_internal_wrapper__.js";
const INTERNAL_BINDING_MODULE: &str = "__rivet_internal_durable_object_binding__.js";
const INTERNAL_BINDING_SOURCE: &str = include_str!("../workerd/durable-object-binding.js");
// Match the current Workers/Durable Objects paid-plan default. The previous
// 50 ms value was the legacy Workers Bundled-plan ceiling and is too small for
// a valid cold SQLite activation: workerd accounts the synchronous SQLite/VFS
// CPU on the isolate thread as part of the invocation budget.
pub const DEFAULT_WORKER_CPU_MS: u32 = 30_000;
pub const DEFAULT_WORKER_MEMORY_BYTES: u32 = 128 << 20;
pub const DEFAULT_WORKER_SUBREQUESTS: u32 = 50;

#[derive(Clone)]
pub struct WorkerCodeCache {
	client: reqwest::Client,
	registry_url: Option<Url>,
	namespace: String,
	cache_dir: PathBuf,
	memory: Cache<String, Arc<WorkerCode>>,
	deployments: Cache<String, DeploymentResolution>,
	deployment_locks: Cache<String, Arc<Mutex<()>>>,
	disk_high_watermark: u64,
	disk_low_watermark: u64,
	disk_maintenance: Arc<Mutex<()>>,
	fetch_permits: Arc<Semaphore>,
	temporary_sequence: Arc<AtomicU64>,
	memory_hits: Arc<AtomicU64>,
	memory_misses: Arc<AtomicU64>,
	disk_hits: Arc<AtomicU64>,
	registry_fetches: Arc<AtomicU64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WorkerCodeCacheStats {
	pub memory_hits: u64,
	pub memory_misses: u64,
	pub disk_hits: u64,
	pub registry_fetches: u64,
	pub memory_entries: u64,
}

#[derive(Debug)]
pub struct WorkerCode {
	loader_json: Arc<Vec<u8>>,
}

#[derive(Clone)]
struct DeploymentResolution {
	deployment: RegistryDeployment,
	checked_at: Instant,
}

impl WorkerCode {
	pub fn loader_json(&self) -> Arc<Vec<u8>> {
		self.loader_json.clone()
	}

	fn loader_json_with_env(&self, env: serde_json::Value) -> Result<Vec<u8>> {
		let mut loader: serde_json::Map<String, serde_json::Value> =
			serde_json::from_slice(&self.loader_json)
				.context("decode cached WorkerLoader source")?;
		loader.insert("env".into(), env);
		serde_json::to_vec(&loader).context("encode actor WorkerLoader source")
	}
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryVersion {
	version_id: String,
	digest: String,
	created_at: String,
	content: Box<RawValue>,
}

#[derive(Debug, Deserialize)]
struct RegistryWorker {
	schema: String,
	namespace: String,
	name: String,
	deployment: RegistryDeployment,
	versions: Vec<RegistryVersionSummary>,
}

#[derive(Clone, Debug, Deserialize)]
struct RegistryDeployment {
	id: String,
	schema: String,
	namespace: String,
	worker: String,
	strategy: String,
	versions: Vec<RegistryDeploymentVersion>,
	deployed_at: String,
}

#[derive(Clone, Debug, Deserialize)]
struct RegistryDeploymentVersion {
	version_id: String,
	percentage: f64,
}

#[derive(Debug, Deserialize)]
struct RegistryVersionSummary {
	version_id: String,
	digest: String,
	created_at: String,
	main_module: String,
	module_count: usize,
	compatibility_date: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct VersionContent {
	schema: String,
	namespace: String,
	worker: String,
	main_module: String,
	modules: BTreeMap<String, String>,
	compatibility_date: String,
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	compatibility_flags: Vec<String>,
	#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
	bindings: BTreeMap<String, VersionBinding>,
	#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
	exports: BTreeMap<String, VersionExport>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct VersionBinding {
	#[serde(rename = "type")]
	kind: String,
	class_name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct VersionExport {
	#[serde(rename = "type")]
	kind: String,
	storage: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoaderCode {
	compatibility_date: String,
	compatibility_flags: Vec<String>,
	main_module: String,
	modules: BTreeMap<String, String>,
	limits: LoaderLimits,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DurableBindingSpecification<'a> {
	tenant: &'static str,
	namespace: &'a str,
	namespace_key: String,
	worker: &'a str,
	class_name: &'a str,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoaderLimits {
	cpu_ms: u32,
	sub_requests: u32,
	memory_bytes: u32,
}

#[derive(Clone)]
struct WorkerCodeHttpState {
	host: Arc<WorkerdHost>,
	cache: Arc<WorkerCodeCache>,
	token: Arc<str>,
}

pub fn worker_code_router(
	host: Arc<WorkerdHost>,
	cache: Arc<WorkerCodeCache>,
	token: String,
) -> Result<Router> {
	ensure!(
		token.len() >= 16,
		"workerd management token must contain at least 16 characters"
	);
	Ok(Router::new()
		.route(
			"/__rivet/worker-code/{actor_id}/{generation}",
			get(get_worker_code),
		)
		.with_state(WorkerCodeHttpState {
			host,
			cache,
			token: Arc::from(token),
		}))
}

async fn get_worker_code(
	State(state): State<WorkerCodeHttpState>,
	Path((actor_id, generation)): Path<(String, u32)>,
	headers: HeaderMap,
) -> Response {
	if !headers
		.get(RIVET_WORKERD_TOKEN_HEADER)
		.and_then(|value| value.to_str().ok())
		.is_some_and(|value| value == state.token.as_ref())
	{
		return StatusCode::NOT_FOUND.into_response();
	}
	let identity = match WorkerdActorIdentity::new(actor_id, generation) {
		Ok(identity) => identity,
		Err(_) => return (StatusCode::BAD_REQUEST, "invalid actor identity").into_response(),
	};
	let reference = match state.host.worker_for_actor(&identity) {
		Ok(Some(reference)) => reference,
		Ok(None) => return StatusCode::NOT_FOUND.into_response(),
		Err(_) => return StatusCode::CONFLICT.into_response(),
	};
	match async {
		let code = state.cache.prepare(&reference).await?;
		let env = state.host.worker_binding_env(&identity)?;
		code.loader_json_with_env(env)
	}
	.await
	{
		Ok(loader_json) => (
			[
				(header::CONTENT_TYPE, "application/json"),
				(header::CACHE_CONTROL, "private, no-store"),
			],
			loader_json,
		)
			.into_response(),
		Err(error) => {
			tracing::error!(?error, actor_id = %identity.actor_id, generation, "serve WorkerLoader code");
			(StatusCode::BAD_GATEWAY, "Worker code unavailable").into_response()
		}
	}
}

impl WorkerCodeCache {
	pub fn new(
		registry_url: Option<&str>,
		namespace: impl Into<String>,
		cache_dir: impl Into<PathBuf>,
	) -> Result<Self> {
		Self::new_with_limits(
			registry_url,
			namespace,
			cache_dir,
			DISK_CACHE_HIGH_WATERMARK_BYTES,
			DISK_CACHE_LOW_WATERMARK_BYTES,
		)
	}

	fn new_with_limits(
		registry_url: Option<&str>,
		namespace: impl Into<String>,
		cache_dir: impl Into<PathBuf>,
		disk_high_watermark: u64,
		disk_low_watermark: u64,
	) -> Result<Self> {
		ensure!(
			disk_low_watermark <= disk_high_watermark,
			"Worker disk cache low watermark exceeds high watermark"
		);
		let registry_url = registry_url
			.map(|raw| {
				let mut url = Url::parse(raw).context("parse Worker registry URL")?;
				ensure!(
					matches!(url.scheme(), "http" | "https"),
					"Worker registry URL must use HTTP or HTTPS"
				);
				ensure!(
					url.username().is_empty(),
					"Worker registry URL must not embed credentials"
				);
				ensure!(
					url.password().is_none(),
					"Worker registry URL must not embed credentials"
				);
				if !url.path().ends_with('/') {
					url.set_path(&format!("{}/", url.path()));
				}
				Ok::<_, anyhow::Error>(url)
			})
			.transpose()?;
		let namespace = namespace.into();
		validate_name(&namespace, "namespace")?;
		let memory = Cache::builder()
			.max_capacity(MEMORY_CACHE_BYTES)
			.weigher(|key: &String, value: &Arc<WorkerCode>| {
				u32::try_from(
					key.len()
						.saturating_add(value.loader_json.len())
						.saturating_add(128),
				)
				.unwrap_or(u32::MAX)
			})
			.build();
		// Deployment pointers are deliberately short-lived. They are control-plane
		// routing state, not immutable code, and an activation after a deploy must
		// converge quickly without turning a cold-start wave into a registry stampede.
		let deployments = Cache::builder().max_capacity(4_096).build();
		let deployment_locks = Cache::builder()
			.max_capacity(4_096)
			.time_to_idle(Duration::from_secs(5 * 60))
			.build();
		let client = reqwest::Client::builder()
			.redirect(Policy::none())
			.connect_timeout(Duration::from_secs(2))
			.timeout(Duration::from_secs(10))
			.build()
			.context("build Worker registry client")?;
		Ok(Self {
			client,
			registry_url,
			namespace,
			cache_dir: cache_dir.into(),
			memory,
			deployments,
			deployment_locks,
			disk_high_watermark,
			disk_low_watermark,
			disk_maintenance: Arc::new(Mutex::new(())),
			fetch_permits: Arc::new(Semaphore::new(MAX_CONCURRENT_FETCHES)),
			temporary_sequence: Arc::new(AtomicU64::new(0)),
			memory_hits: Arc::new(AtomicU64::new(0)),
			memory_misses: Arc::new(AtomicU64::new(0)),
			disk_hits: Arc::new(AtomicU64::new(0)),
			registry_fetches: Arc::new(AtomicU64::new(0)),
		})
	}

	/// Resolves a public Worker reference to the exact immutable version used by
	/// one activation. An empty protocol `version_id` represents the public API's
	/// omitted field and therefore follows the active Deployment.
	pub async fn resolve(
		&self,
		reference: &WorkerVersionReference,
		actor_id: &str,
	) -> Result<WorkerVersionReference> {
		validate_name(&reference.worker, "Worker")?;
		if !reference.version_id.is_empty() {
			validate_reference(reference)?;
			return Ok(reference.clone());
		}

		let worker = reference.worker.clone();
		if let Some(cached) = self.deployments.get(&worker).await {
			if cached.checked_at.elapsed() >= Duration::from_secs(1) {
				self.refresh_deployment_in_background(worker.clone(), cached.clone());
			}
			return self.select_deployment_version(&worker, actor_id, &cached.deployment);
		}

		let refresh_lock = self
			.deployment_locks
			.get_with(worker.clone(), async { Arc::new(Mutex::new(())) })
			.await;
		let _refresh = refresh_lock.lock().await;
		if let Some(cached) = self.deployments.get(&worker).await
			&& cached.checked_at.elapsed() < Duration::from_secs(1)
		{
			return self.select_deployment_version(&worker, actor_id, &cached.deployment);
		}

		let resolved = self.fetch_active_deployment(&worker).await?;
		self.deployments
			.insert(
				worker.clone(),
				DeploymentResolution {
					deployment: resolved.clone(),
					checked_at: Instant::now(),
				},
			)
			.await;
		self.select_deployment_version(&worker, actor_id, &resolved)
	}

	fn refresh_deployment_in_background(&self, worker: String, stale: DeploymentResolution) {
		let this = self.clone();
		tokio::spawn(async move {
			let refresh_lock = this
				.deployment_locks
				.get_with(worker.clone(), async { Arc::new(Mutex::new(())) })
				.await;
			// Do not build an unbounded waiter queue when a hot Worker crosses the
			// refresh boundary. One request owns the refresh; all others keep using
			// the last verified Deployment.
			let Ok(_refresh) = refresh_lock.try_lock_owned() else {
				return;
			};
			if this
				.deployments
				.get(&worker)
				.await
				.is_some_and(|cached| cached.checked_at.elapsed() < Duration::from_secs(1))
			{
				return;
			}
			let resolution = match this.fetch_active_deployment(&worker).await {
				Ok(deployment) => DeploymentResolution {
					deployment,
					checked_at: Instant::now(),
				},
				Err(error) => {
					tracing::warn!(?error, %worker, "using last verified Worker Deployment");
					// A newer refresh may have completed before this task acquired the
					// lock. Never replace that result with the older captured fallback.
					let deployment = this
						.deployments
						.get(&worker)
						.await
						.map_or(stale.deployment, |latest| latest.deployment);
					DeploymentResolution {
						deployment,
						// Back off the next refresh instead of letting every request
						// retry an unavailable control plane.
						checked_at: Instant::now(),
					}
				}
			};
			this.deployments.insert(worker, resolution).await;
		});
	}

	async fn fetch_active_deployment(&self, worker: &str) -> Result<RegistryDeployment> {
		let base = self
			.registry_url
			.as_ref()
			.ok_or_else(|| anyhow!("Worker registry is not configured on this workerd host"))?;
		let path = format!("v1/namespaces/{}/workers/{worker}", self.namespace);
		let url = base
			.join(&path)
			.context("build Worker deployment request URL")?;
		let response = self
			.client
			.get(url)
			.send()
			.await
			.context("resolve active Worker deployment")?;
		ensure!(
			response.status() == StatusCode::OK,
			"Worker registry deployment lookup returned status {}",
			response.status()
		);
		if let Some(length) = response.content_length() {
			ensure!(
				length <= MAX_DEPLOYMENT_RESPONSE_BYTES as u64,
				"Worker deployment response exceeds size limit"
			);
		}
		let encoded = response
			.bytes()
			.await
			.context("read Worker deployment response")?;
		ensure!(
			encoded.len() <= MAX_DEPLOYMENT_RESPONSE_BYTES,
			"Worker deployment response exceeds size limit"
		);
		let active: RegistryWorker =
			serde_json::from_slice(&encoded).context("decode active Worker deployment")?;
		ensure!(active.schema == SCHEMA, "Worker deployment schema mismatch");
		ensure!(
			active.namespace == self.namespace && active.name == worker,
			"Worker deployment identity mismatch"
		);
		ensure!(
			active.deployment.schema == SCHEMA
				&& active.deployment.namespace == self.namespace
				&& active.deployment.worker == worker,
			"Worker deployment pointer is inconsistent"
		);
		ensure!(
			!active.deployment.deployed_at.is_empty()
				&& valid_deployment_id(&active.deployment.id)
				&& active.deployment.strategy == "percentage"
				&& active.deployment.versions.len() == active.versions.len()
				&& matches!(active.deployment.versions.len(), 1 | 2),
			"Worker deployment metadata is incomplete"
		);
		if active.deployment.versions.len() == 2 {
			ensure!(
				active.deployment.versions[0].version_id
					!= active.deployment.versions[1].version_id,
				"Worker deployment contains a duplicate version"
			);
		}
		let mut total_basis_points = 0;
		for (target, summary) in active.deployment.versions.iter().zip(&active.versions) {
			let reference = WorkerVersionReference {
				worker: worker.to_string(),
				version_id: target.version_id.clone(),
			};
			validate_reference(&reference)?;
			ensure!(
				summary.version_id == target.version_id
					&& summary.digest == format!("sha256:{}", &reference.version_id[2..])
					&& !summary.created_at.is_empty()
					&& !summary.main_module.is_empty()
					&& summary.module_count > 0
					&& !summary.compatibility_date.is_empty(),
				"Worker deployment version metadata is inconsistent"
			);
			total_basis_points += percentage_basis_points(target.percentage)?;
		}
		ensure!(
			total_basis_points == 10_000,
			"Worker deployment percentages must sum to 100"
		);
		Ok(active.deployment)
	}

	fn select_deployment_version(
		&self,
		worker: &str,
		actor_id: &str,
		deployment: &RegistryDeployment,
	) -> Result<WorkerVersionReference> {
		// Deployment IDs must not affect the bucket. Ordered cumulative ranges let a
		// promoted version expand without moving Objects already assigned to it.
		let mut digest = Sha256::new();
		for component in [
			"rivet-worker-object-assignment/v1",
			self.namespace.as_str(),
			worker,
			actor_id,
		] {
			digest.update(component.as_bytes());
			digest.update([0]);
		}
		let digest = digest.finalize();
		let bucket = u64::from_be_bytes(digest[..8].try_into().expect("SHA-256 prefix")) % 10_000;
		let mut upper_bound = 0_u64;
		for target in &deployment.versions {
			upper_bound += u64::try_from(percentage_basis_points(target.percentage)?)?;
			if bucket < upper_bound {
				return Ok(WorkerVersionReference {
					worker: worker.to_string(),
					version_id: target.version_id.clone(),
				});
			}
		}
		bail!("Worker deployment percentages do not cover the assignment space")
	}

	pub async fn prepare(&self, reference: &WorkerVersionReference) -> Result<Arc<WorkerCode>> {
		validate_reference(reference)?;
		let key = format!("{}/{}", reference.worker, reference.version_id);
		if let Some(code) = self.memory.get(&key).await {
			self.memory_hits.fetch_add(1, Ordering::Relaxed);
			return Ok(code);
		}
		self.memory_misses.fetch_add(1, Ordering::Relaxed);
		let this = self.clone();
		let reference = reference.clone();
		self.memory
			.try_get_with(key, async move { this.load(&reference).await })
			.await
			.map_err(|error| anyhow!(error.to_string()))
	}

	pub fn stats(&self) -> WorkerCodeCacheStats {
		WorkerCodeCacheStats {
			memory_hits: self.memory_hits.load(Ordering::Relaxed),
			memory_misses: self.memory_misses.load(Ordering::Relaxed),
			disk_hits: self.disk_hits.load(Ordering::Relaxed),
			registry_fetches: self.registry_fetches.load(Ordering::Relaxed),
			memory_entries: self.memory.entry_count(),
		}
	}

	async fn load(&self, reference: &WorkerVersionReference) -> Result<Arc<WorkerCode>> {
		let path = self.disk_path(reference);
		match tokio::fs::read(&path).await {
			Ok(encoded) => match self.verify(reference, &encoded) {
				Ok(code) => {
					self.disk_hits.fetch_add(1, Ordering::Relaxed);
					self.touch_disk_entry(path.clone());
					return Ok(Arc::new(code));
				}
				Err(error) => {
					tracing::warn!(?error, path = %path.display(), "discarding invalid Worker code cache entry");
					let _ = tokio::fs::remove_file(&path).await;
				}
			},
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
			Err(error) => {
				tracing::warn!(?error, path = %path.display(), "could not read disposable Worker code cache");
			}
		}

		let encoded = self.fetch(reference).await?;
		let code = Arc::new(self.verify(reference, &encoded)?);
		if let Err(error) = self.write_disk(reference, &encoded).await {
			// This is a disposable recovery cache. Failure to persist an already-verified immutable
			// version must not make actor startup depend on local disk health.
			tracing::warn!(?error, "could not persist Worker code cache entry");
		}
		Ok(code)
	}

	async fn fetch(&self, reference: &WorkerVersionReference) -> Result<Vec<u8>> {
		self.registry_fetches.fetch_add(1, Ordering::Relaxed);
		let _permit = self
			.fetch_permits
			.acquire()
			.await
			.context("Worker registry fetch limiter closed")?;
		let base = self
			.registry_url
			.as_ref()
			.ok_or_else(|| anyhow!("Worker registry is not configured on this workerd host"))?;
		let path = format!(
			"internal/v1/namespaces/{}/workers/{}/versions/{}",
			self.namespace, reference.worker, reference.version_id
		);
		let url = base
			.join(&path)
			.context("build Worker registry request URL")?;
		let response = self
			.client
			.get(url)
			.send()
			.await
			.context("fetch immutable Worker version")?;
		ensure!(
			response.status() == StatusCode::OK,
			"Worker registry returned status {}",
			response.status()
		);
		if let Some(length) = response.content_length() {
			ensure!(
				length <= MAX_REGISTRY_RESPONSE_BYTES as u64,
				"Worker registry response exceeds size limit"
			);
		}
		let mut encoded = Vec::new();
		let mut stream = response.bytes_stream();
		while let Some(chunk) = stream.next().await {
			let chunk = chunk.context("read Worker registry response")?;
			let next = encoded
				.len()
				.checked_add(chunk.len())
				.ok_or_else(|| anyhow!("Worker registry response length overflow"))?;
			ensure!(
				next <= MAX_REGISTRY_RESPONSE_BYTES,
				"Worker registry response exceeds size limit"
			);
			encoded.extend_from_slice(&chunk);
		}
		Ok(encoded)
	}

	fn verify(&self, reference: &WorkerVersionReference, encoded: &[u8]) -> Result<WorkerCode> {
		ensure!(
			encoded.len() <= MAX_REGISTRY_RESPONSE_BYTES,
			"Worker registry response exceeds size limit"
		);
		let version: RegistryVersion =
			serde_json::from_slice(encoded).context("decode immutable Worker version")?;
		ensure!(
			!version.created_at.is_empty(),
			"Worker version creation timestamp is missing"
		);
		ensure!(
			version.version_id == reference.version_id,
			"Worker version ID mismatch"
		);
		let content: VersionContent = serde_json::from_str(version.content.get())
			.context("decode immutable Worker version content")?;
		ensure!(content.schema == SCHEMA, "Worker version schema mismatch");
		ensure!(
			content.namespace == self.namespace,
			"Worker version namespace mismatch"
		);
		ensure!(
			content.worker == reference.worker,
			"Worker version name mismatch"
		);
		validate_content(&content)?;

		// Hash the exact raw content object emitted by the Go registry. Re-encoding
		// here would subtly disagree on JSON HTML escaping for valid JavaScript
		// sources containing '<', '>' or '&'.
		let digest = hex::encode(Sha256::digest(version.content.get().as_bytes()));
		ensure!(
			version.version_id == format!("v_{digest}"),
			"Worker version digest mismatch"
		);
		ensure!(
			version.digest == format!("sha256:{digest}"),
			"Worker version digest mismatch"
		);

		let mut modules = content.modules.clone();
		let binding_specifications = content
			.bindings
			.iter()
			.map(|(binding, definition)| {
				(
					binding,
					DurableBindingSpecification {
						tenant: "default",
						namespace: &content.namespace,
						namespace_key: durable_namespace_key(
							&content.namespace,
							&content.worker,
							&definition.class_name,
						),
						worker: &content.worker,
						class_name: &definition.class_name,
					},
				)
			})
			.collect::<BTreeMap<_, _>>();
		let specifications = serde_json::to_string(&binding_specifications)
			.context("encode Durable Object binding specifications")?;
		let user_module = serde_json::to_string(&format!("./{}", content.main_module))?;
		let wrapper = format!(
			r#"import user from {user_module};
export * from {user_module};
import {{ createDurableObjectNamespace }} from "./{INTERNAL_BINDING_MODULE}";

if (user === null || typeof user !== "object" || typeof user.fetch !== "function") {{
	throw new TypeError("Worker default export must provide fetch(request, env, ctx)");
}}
const bindingSpecifications = Object.freeze({specifications});

export default {{
	fetch(request, internalEnv, ctx) {{
		const env = {{}};
		if (internalEnv.RIVET_STORAGE !== undefined) env.RIVET_STORAGE = internalEnv.RIVET_STORAGE;
		for (const [name, specification] of Object.entries(bindingSpecifications)) {{
			env[name] = createDurableObjectNamespace(
				internalEnv.__RIVET_OBJECT_ROUTER,
				internalEnv.__RIVET_OBJECT_ROUTER_TOKEN,
				specification,
			);
		}}
		return user.fetch(request, Object.freeze(env), ctx);
	}},
}};
"#
		);
		modules.insert(
			INTERNAL_BINDING_MODULE.into(),
			INTERNAL_BINDING_SOURCE.into(),
		);
		modules.insert(INTERNAL_WRAPPER_MODULE.into(), wrapper);
		let loader_json = serde_json::to_vec(&LoaderCode {
			compatibility_date: content.compatibility_date.clone(),
			compatibility_flags: content.compatibility_flags.clone(),
			main_module: INTERNAL_WRAPPER_MODULE.into(),
			modules,
			limits: LoaderLimits {
				cpu_ms: DEFAULT_WORKER_CPU_MS,
				sub_requests: DEFAULT_WORKER_SUBREQUESTS,
				memory_bytes: DEFAULT_WORKER_MEMORY_BYTES,
			},
		})
		.context("encode WorkerLoader source")?;
		Ok(WorkerCode {
			loader_json: Arc::new(loader_json),
		})
	}

	fn disk_path(&self, reference: &WorkerVersionReference) -> PathBuf {
		self.cache_dir
			.join(&self.namespace)
			.join(&reference.worker)
			.join(format!("{}.json", reference.version_id))
	}

	async fn write_disk(&self, reference: &WorkerVersionReference, encoded: &[u8]) -> Result<()> {
		let _maintenance = self.disk_maintenance.lock().await;
		let path = self.disk_path(reference);
		self.prune_disk_cache(encoded.len() as u64, &path).await?;
		let parent = path.parent().context("Worker cache path has no parent")?;
		tokio::fs::create_dir_all(parent)
			.await
			.context("create Worker code cache directory")?;
		let temporary = parent.join(format!(
			".{}.{}.{}.tmp",
			reference.version_id,
			std::process::id(),
			self.temporary_sequence.fetch_add(1, Ordering::Relaxed)
		));
		tokio::fs::write(&temporary, encoded)
			.await
			.context("write Worker code cache")?;
		if let Err(error) = tokio::fs::rename(&temporary, &path).await {
			let _ = tokio::fs::remove_file(&temporary).await;
			return Err(error).context("publish Worker code cache");
		}
		Ok(())
	}

	async fn prune_disk_cache(&self, incoming_bytes: u64, destination: &FsPath) -> Result<()> {
		let root = self.cache_dir.clone();
		let destination = destination.to_owned();
		let high = self.disk_high_watermark;
		let low = self.disk_low_watermark;
		tokio::task::spawn_blocking(move || -> Result<()> {
			let mut entries = Vec::new();
			collect_cache_entries(&root, &mut entries)?;
			let mut total = entries.iter().map(|entry| entry.bytes).sum::<u64>();
			if total.saturating_add(incoming_bytes) <= high {
				return Ok(());
			}
			entries.sort_by_key(|entry| entry.modified);
			for entry in entries {
				if total.saturating_add(incoming_bytes) <= low {
					break;
				}
				if entry.path == destination {
					continue;
				}
				match std::fs::remove_file(&entry.path) {
					Ok(()) => total = total.saturating_sub(entry.bytes),
					Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
					Err(error) => return Err(error).context("evict Worker code cache entry"),
				}
			}
			ensure!(
				total.saturating_add(incoming_bytes) <= high,
				"Worker code cache entry exceeds disk cache capacity"
			);
			Ok(())
		})
		.await
		.context("join Worker code cache pruning task")??;
		Ok(())
	}

	fn touch_disk_entry(&self, path: PathBuf) {
		tokio::task::spawn_blocking(move || {
			if let Ok(file) = std::fs::OpenOptions::new().write(true).open(path) {
				let _ = file.set_modified(SystemTime::now());
			}
		});
	}
}

struct DiskCacheEntry {
	path: PathBuf,
	bytes: u64,
	modified: SystemTime,
}

fn collect_cache_entries(directory: &FsPath, entries: &mut Vec<DiskCacheEntry>) -> Result<()> {
	let iterator = match std::fs::read_dir(directory) {
		Ok(iterator) => iterator,
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
		Err(error) => return Err(error).context("scan Worker code cache"),
	};
	for entry in iterator {
		let entry = entry.context("read Worker code cache directory entry")?;
		let path = entry.path();
		let metadata = entry.metadata().context("stat Worker code cache entry")?;
		if metadata.is_dir() {
			collect_cache_entries(&path, entries)?;
		} else if path.extension().is_some_and(|extension| extension == "tmp") {
			let _ = std::fs::remove_file(path);
		} else if metadata.is_file() {
			entries.push(DiskCacheEntry {
				path,
				bytes: metadata.len(),
				modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
			});
		}
	}
	Ok(())
}

fn validate_reference(reference: &WorkerVersionReference) -> Result<()> {
	validate_name(&reference.worker, "Worker")?;
	let Some(digest) = reference.version_id.strip_prefix("v_") else {
		bail!("Worker version ID must use v_<sha256>");
	};
	ensure!(
		digest.len() == 64
			&& digest
				.bytes()
				.all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
		"Worker version ID must contain 64 lowercase hexadecimal digits"
	);
	Ok(())
}

fn percentage_basis_points(percentage: f64) -> Result<u16> {
	let scaled = percentage * 100.0;
	let rounded = scaled.round();
	ensure!(
		percentage.is_finite()
			&& (1.0..=10_000.0).contains(&rounded)
			&& (scaled - rounded).abs() <= 1e-9,
		"Worker deployment percentages must use 0.01% precision"
	);
	Ok(rounded as u16)
}

fn valid_deployment_id(deployment_id: &str) -> bool {
	deployment_id.len() == 34
		&& deployment_id.starts_with("d_")
		&& deployment_id[2..]
			.bytes()
			.all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_name(name: &str, kind: &str) -> Result<()> {
	let bytes = name.as_bytes();
	ensure!(
		!bytes.is_empty()
			&& bytes.len() <= 63
			&& bytes[0].is_ascii_lowercase()
			&& bytes
				.iter()
				.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-'),
		"{kind} name is invalid"
	);
	Ok(())
}

fn validate_content(content: &VersionContent) -> Result<()> {
	ensure!(
		(1..=MAX_MODULES).contains(&content.modules.len()),
		"Worker module count is invalid"
	);
	ensure!(
		content.modules.contains_key(&content.main_module),
		"Worker main module is missing"
	);
	let mut total = 0usize;
	for (name, source) in &content.modules {
		ensure!(valid_module_name(name), "Worker module name is invalid");
		ensure!(
			!matches!(
				name.as_str(),
				INTERNAL_WRAPPER_MODULE | INTERNAL_BINDING_MODULE
			),
			"Worker module name uses a reserved runtime name"
		);
		ensure!(
			!source.is_empty() && source.len() <= MAX_MODULE_BYTES,
			"Worker module size is invalid"
		);
		total = total
			.checked_add(source.len())
			.context("Worker module size overflow")?;
	}
	ensure!(
		total <= MAX_TOTAL_MODULE_BYTES,
		"Worker modules exceed total size limit"
	);
	ensure!(
		content.compatibility_flags.len() <= MAX_COMPATIBILITY_FLAGS,
		"too many Worker compatibility flags"
	);
	ensure!(content.bindings.len() <= 64, "too many Worker bindings");
	ensure!(content.exports.len() <= 64, "too many Worker exports");
	let mut referenced_exports = BTreeSet::new();
	for (name, binding) in &content.bindings {
		ensure!(valid_binding_name(name), "Worker binding name is invalid");
		ensure!(
			binding.kind == "durable_object",
			"Worker binding type is invalid"
		);
		ensure!(
			valid_class_name(&binding.class_name),
			"Durable Object class name is invalid"
		);
		let export = content
			.exports
			.get(&binding.class_name)
			.context("Durable Object binding references a missing export")?;
		ensure!(
			export.kind == "durable_object" && export.storage == "sqlite",
			"Durable Object binding references an invalid export"
		);
		referenced_exports.insert(binding.class_name.as_str());
	}
	for (class_name, export) in &content.exports {
		ensure!(
			valid_class_name(class_name),
			"Durable Object export name is invalid"
		);
		ensure!(
			export.kind == "durable_object" && export.storage == "sqlite",
			"Durable Object export is invalid"
		);
		ensure!(
			referenced_exports.contains(class_name.as_str()),
			"Durable Object export has no binding"
		);
	}
	ensure!(
		valid_compatibility_date(&content.compatibility_date),
		"Worker compatibility date is invalid"
	);
	let mut previous: Option<&str> = None;
	for flag in &content.compatibility_flags {
		let bytes = flag.as_bytes();
		ensure!(
			!bytes.is_empty()
				&& bytes.len() <= 64
				&& bytes[0].is_ascii_lowercase()
				&& bytes.iter().all(|byte| byte.is_ascii_lowercase()
					|| byte.is_ascii_digit()
					|| *byte == b'_'),
			"Worker compatibility flag is invalid"
		);
		ensure!(
			previous.is_none_or(|value| value < flag.as_str()),
			"Worker compatibility flags are not canonical"
		);
		previous = Some(flag);
	}
	Ok(())
}

fn durable_namespace_key(namespace: &str, worker: &str, class_name: &str) -> String {
	let mut digest = Sha256::new();
	digest.update(namespace.as_bytes());
	digest.update([0]);
	digest.update(worker.as_bytes());
	digest.update([0]);
	digest.update(class_name.as_bytes());
	format!("do_{}", hex::encode(digest.finalize()))
}

fn valid_binding_name(name: &str) -> bool {
	let bytes = name.as_bytes();
	!bytes.is_empty()
		&& bytes.len() <= 128
		&& bytes[0].is_ascii_uppercase()
		&& bytes
			.iter()
			.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn valid_class_name(name: &str) -> bool {
	let bytes = name.as_bytes();
	!bytes.is_empty()
		&& bytes.len() <= 128
		&& (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_' || bytes[0] == b'$')
		&& bytes
			.iter()
			.all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'$')
}

fn valid_module_name(name: &str) -> bool {
	!name.is_empty()
		&& name.len() <= 256
		&& !name.contains('\\')
		&& !name.contains('\0')
		&& !name.starts_with('/')
		&& name
			.split('/')
			.all(|component| !matches!(component, "" | "." | ".."))
}

fn valid_compatibility_date(value: &str) -> bool {
	let bytes = value.as_bytes();
	if !(bytes.len() == 10
		&& bytes[4] == b'-'
		&& bytes[7] == b'-'
		&& bytes
			.iter()
			.enumerate()
			.all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit()))
	{
		return false;
	}
	let year = value[0..4].parse::<u16>().ok();
	let month = value[5..7].parse::<u8>().ok();
	let day = value[8..10].parse::<u8>().ok();
	let (Some(year), Some(month), Some(day)) = (year, month, day) else {
		return false;
	};
	let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
	let max_day = match month {
		1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
		4 | 6 | 9 | 11 => 30,
		2 if leap => 29,
		2 => 28,
		_ => return false,
	};
	(1..=max_day).contains(&day)
}

#[cfg(test)]
mod tests {
	use std::sync::{
		RwLock as StdRwLock,
		atomic::{AtomicUsize, Ordering},
	};

	use axum::{Router, extract::State, response::IntoResponse, routing::get};
	use tempfile::TempDir;

	use super::*;

	#[derive(Clone)]
	struct RegistryFixture {
		body: Arc<Vec<u8>>,
		requests: Arc<AtomicUsize>,
		delay: Duration,
	}

	async fn serve_version(State(fixture): State<RegistryFixture>) -> Response {
		fixture.requests.fetch_add(1, Ordering::Relaxed);
		if !fixture.delay.is_zero() {
			tokio::time::sleep(fixture.delay).await;
		}
		(
			[(header::CONTENT_TYPE, "application/json")],
			fixture.body.as_ref().clone(),
		)
			.into_response()
	}

	async fn start_registry(
		body: Vec<u8>,
		delay: Duration,
	) -> Result<(String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>)> {
		let requests = Arc::new(AtomicUsize::new(0));
		let fixture = RegistryFixture {
			body: Arc::new(body),
			requests: requests.clone(),
			delay,
		};
		let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
		let address = listener.local_addr()?;
		let server = tokio::spawn(async move {
			axum::serve(
				listener,
				Router::new()
					.fallback(get(serve_version))
					.with_state(fixture),
			)
			.await
			.unwrap();
		});
		Ok((format!("http://{address}/"), requests, server))
	}

	#[derive(Clone)]
	struct MutableRegistryFixture {
		body: Arc<StdRwLock<Vec<u8>>>,
		requests: Arc<AtomicUsize>,
	}

	async fn serve_mutable_deployment(State(fixture): State<MutableRegistryFixture>) -> Response {
		fixture.requests.fetch_add(1, Ordering::Relaxed);
		(
			[(header::CONTENT_TYPE, "application/json")],
			fixture.body.read().unwrap().clone(),
		)
			.into_response()
	}

	async fn start_mutable_registry(
		body: Vec<u8>,
	) -> Result<(
		String,
		Arc<StdRwLock<Vec<u8>>>,
		Arc<AtomicUsize>,
		tokio::task::JoinHandle<()>,
	)> {
		let body = Arc::new(StdRwLock::new(body));
		let requests = Arc::new(AtomicUsize::new(0));
		let fixture = MutableRegistryFixture {
			body: body.clone(),
			requests: requests.clone(),
		};
		let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
		let address = listener.local_addr()?;
		let server = tokio::spawn(async move {
			axum::serve(
				listener,
				Router::new()
					.fallback(get(serve_mutable_deployment))
					.with_state(fixture),
			)
			.await
			.unwrap();
		});
		Ok((format!("http://{address}/"), body, requests, server))
	}

	fn fixture() -> Result<(WorkerVersionReference, Vec<u8>)> {
		let content = VersionContent {
			schema: SCHEMA.into(),
			namespace: "default".into(),
			worker: "hello".into(),
			main_module: "worker.js".into(),
			modules: BTreeMap::from([(
				"worker.js".into(),
				"export default { fetch() { return new Response('<hello>&'); } };".into(),
			)]),
			compatibility_date: "2025-08-08".into(),
			compatibility_flags: Vec::new(),
			bindings: BTreeMap::new(),
			exports: BTreeMap::new(),
		};
		// Go's encoding/json escapes these three characters even inside source
		// strings. The host must verify those exact registry bytes.
		let content_json = serde_json::to_string(&content)?
			.replace('&', "\\u0026")
			.replace('<', "\\u003c")
			.replace('>', "\\u003e");
		let digest = hex::encode(Sha256::digest(content_json.as_bytes()));
		let version_id = format!("v_{digest}");
		let encoded = format!(
			r#"{{"version_id":"{version_id}","digest":"sha256:{digest}","created_at":"2026-08-26T00:00:00Z","content":{content_json}}}"#
		)
		.into_bytes();
		Ok((
			WorkerVersionReference {
				worker: "hello".into(),
				version_id,
			},
			encoded,
		))
	}

	#[test]
	fn durable_object_bindings_require_matching_sqlite_exports() -> Result<()> {
		let mut content = VersionContent {
			schema: SCHEMA.into(),
			namespace: "default".into(),
			worker: "hello".into(),
			main_module: "worker.js".into(),
			modules: BTreeMap::from([("worker.js".into(), "export default {};".into())]),
			compatibility_date: "2026-08-14".into(),
			compatibility_flags: Vec::new(),
			bindings: BTreeMap::from([(
				"COUNTER".into(),
				VersionBinding {
					kind: "durable_object".into(),
					class_name: "Counter".into(),
				},
			)]),
			exports: BTreeMap::new(),
		};
		assert!(validate_content(&content).is_err());
		content.exports.insert(
			"Counter".into(),
			VersionExport {
				kind: "durable_object".into(),
				storage: "sqlite".into(),
			},
		);
		validate_content(&content)?;
		content.exports.get_mut("Counter").unwrap().storage = "memory".into();
		assert!(validate_content(&content).is_err());
		Ok(())
	}

	fn deployment_fixture(reference: &WorkerVersionReference) -> Result<Vec<u8>> {
		let digest = reference
			.version_id
			.strip_prefix("v_")
			.context("fixture version prefix")?;
		Ok(serde_json::to_vec(&serde_json::json!({
			"schema": SCHEMA,
			"namespace": "default",
			"name": reference.worker,
			"deployment": {
				"id": format!("d_{}", &digest[..32]),
				"schema": SCHEMA,
				"namespace": "default",
				"worker": reference.worker,
				"strategy": "percentage",
				"versions": [{
					"version_id": reference.version_id,
					"percentage": 100
				}],
				"deployed_at": "2026-08-31T00:00:00Z"
			},
			"versions": [{
				"version_id": reference.version_id,
				"digest": format!("sha256:{digest}"),
				"created_at": "2026-08-31T00:00:00Z",
				"main_module": "worker.js",
				"module_count": 1,
				"compatibility_date": "2026-08-14"
			}]
		}))?)
	}

	#[tokio::test]
	async fn deployment_reference_resolves_to_active_immutable_version() -> Result<()> {
		let directory = TempDir::new()?;
		let (exact, _) = fixture()?;
		let (url, requests, server) =
			start_registry(deployment_fixture(&exact)?, Duration::ZERO).await?;
		let cache = WorkerCodeCache::new(Some(&url), "default", directory.path())?;
		let deployment = WorkerVersionReference {
			worker: exact.worker.clone(),
			version_id: String::new(),
		};
		assert_eq!(cache.resolve(&deployment, "actor-a").await?, exact);
		assert_eq!(cache.resolve(&deployment, "actor-a").await?, exact);
		assert_eq!(requests.load(Ordering::Relaxed), 1);
		server.abort();
		tokio::time::sleep(Duration::from_millis(1_050)).await;
		// A Hub/control-plane outage must not stop an already activated Cell. New
		// Hosts without a verified resolution still fail closed.
		assert_eq!(cache.resolve(&deployment, "actor-a").await?, exact);
		Ok(())
	}

	#[tokio::test]
	async fn pinned_reference_does_not_resolve_a_deployment() -> Result<()> {
		let directory = TempDir::new()?;
		let (exact, _) = fixture()?;
		let cache = WorkerCodeCache::new(None, "default", directory.path())?;
		assert_eq!(cache.resolve(&exact, "actor-a").await?, exact);
		Ok(())
	}

	#[test]
	fn gradual_deployment_is_stable_across_ids_and_monotonic_when_promoted() -> Result<()> {
		let directory = TempDir::new()?;
		let cache = WorkerCodeCache::new(None, "default", directory.path())?;
		let old = format!("v_{}", "1".repeat(64));
		let new = format!("v_{}", "2".repeat(64));
		let deployment = RegistryDeployment {
			id: format!("d_{}", "a".repeat(32)),
			schema: SCHEMA.into(),
			namespace: "default".into(),
			worker: "hello".into(),
			strategy: "percentage".into(),
			versions: vec![
				RegistryDeploymentVersion {
					version_id: new.clone(),
					percentage: 20.0,
				},
				RegistryDeploymentVersion {
					version_id: old.clone(),
					percentage: 80.0,
				},
			],
			deployed_at: "2026-09-01T00:00:00Z".into(),
		};
		let mut same_weights_new_id = deployment.clone();
		same_weights_new_id.id = format!("d_{}", "b".repeat(32));
		let mut promoted = same_weights_new_id.clone();
		promoted.id = format!("d_{}", "c".repeat(32));
		promoted.versions[0].percentage = 50.0;
		promoted.versions[1].percentage = 50.0;
		let mut initial_new = 0;
		let mut promoted_new = 0;
		let mut advanced = 0;
		for index in 0..10_000 {
			let actor_id = format!("actor-{index}");
			let first = cache.select_deployment_version("hello", &actor_id, &deployment)?;
			let repeated = cache.select_deployment_version("hello", &actor_id, &deployment)?;
			assert_eq!(first, repeated);
			assert_eq!(
				first,
				cache.select_deployment_version("hello", &actor_id, &same_weights_new_id)?,
				"Deployment identity must not reshuffle Durable Objects"
			);
			let after = cache.select_deployment_version("hello", &actor_id, &promoted)?;
			if first.version_id == new {
				initial_new += 1;
				assert_eq!(
					after.version_id, new,
					"an Object assigned to the promoted version must not move backward"
				);
			}
			if after.version_id == new {
				promoted_new += 1;
			}
			if first.version_id == old && after.version_id == new {
				advanced += 1;
			}
		}
		assert!(
			(1_700..=2_300).contains(&initial_new),
			"unexpected 20% spread: {initial_new}"
		);
		assert!(
			(4_500..=5_500).contains(&promoted_new),
			"unexpected 50% spread: {promoted_new}"
		);
		assert!(
			(2_500..=3_500).contains(&advanced),
			"unexpected promotion set: {advanced}"
		);
		Ok(())
	}

	#[tokio::test]
	async fn stale_resolution_serves_immediately_then_refreshes_in_background() -> Result<()> {
		let directory = TempDir::new()?;
		let (v1, _) = fixture()?;
		let v2 = WorkerVersionReference {
			worker: v1.worker.clone(),
			version_id: format!("v_{}", "2".repeat(64)),
		};
		let (url, body, requests, server) =
			start_mutable_registry(deployment_fixture(&v1)?).await?;
		let cache = WorkerCodeCache::new(Some(&url), "default", directory.path())?;
		let deployment = WorkerVersionReference {
			worker: v1.worker.clone(),
			version_id: String::new(),
		};
		assert_eq!(cache.resolve(&deployment, "actor-a").await?, v1);
		*body.write().unwrap() = deployment_fixture(&v2)?;
		tokio::time::sleep(Duration::from_millis(1_050)).await;

		// The first request after expiry does not wait for the Hub.
		assert_eq!(cache.resolve(&deployment, "actor-a").await?, v1);
		let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
		loop {
			if cache.resolve(&deployment, "actor-a").await? == v2 {
				break;
			}
			ensure!(
				tokio::time::Instant::now() < deadline,
				"deployment refresh did not converge"
			);
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
		assert_eq!(requests.load(Ordering::Relaxed), 2);
		server.abort();
		Ok(())
	}

	#[tokio::test]
	async fn fetches_once_then_recovers_from_verified_disk_cache() -> Result<()> {
		let directory = TempDir::new()?;
		let (reference, encoded) = fixture()?;
		let (url, requests, server) = start_registry(encoded, Duration::ZERO).await?;
		let cache = WorkerCodeCache::new(Some(&url), "default", directory.path())?;
		let first = cache.prepare(&reference).await?;
		let loader: serde_json::Value = serde_json::from_slice(first.loader_json().as_ref())?;
		assert_eq!(loader["mainModule"], INTERNAL_WRAPPER_MODULE);
		assert!(loader["modules"]["worker.js"].is_string());
		assert!(loader["modules"][INTERNAL_WRAPPER_MODULE].is_string());
		assert!(loader["modules"][INTERNAL_BINDING_MODULE].is_string());
		assert_eq!(loader["limits"]["cpuMs"], DEFAULT_WORKER_CPU_MS);
		assert_eq!(loader["limits"]["memoryBytes"], DEFAULT_WORKER_MEMORY_BYTES);
		assert_eq!(loader["limits"]["subRequests"], DEFAULT_WORKER_SUBREQUESTS);
		assert_eq!(requests.load(Ordering::Relaxed), 1);
		server.abort();

		let recovered = WorkerCodeCache::new(Some(&url), "default", directory.path())?
			.prepare(&reference)
			.await?;
		assert_eq!(
			first.loader_json().as_ref(),
			recovered.loader_json().as_ref()
		);
		Ok(())
	}

	#[tokio::test]
	async fn concurrent_prepare_is_single_flight() -> Result<()> {
		let directory = TempDir::new()?;
		let (reference, encoded) = fixture()?;
		let (url, requests, server) = start_registry(encoded, Duration::from_millis(50)).await?;
		let cache = Arc::new(WorkerCodeCache::new(
			Some(&url),
			"default",
			directory.path(),
		)?);
		let mut tasks = Vec::new();
		for _ in 0..16 {
			let cache = cache.clone();
			let reference = reference.clone();
			tasks.push(tokio::spawn(async move { cache.prepare(&reference).await }));
		}
		for task in tasks {
			task.await??;
		}
		assert_eq!(requests.load(Ordering::Relaxed), 1);
		server.abort();
		Ok(())
	}

	#[tokio::test]
	async fn digest_mismatch_is_rejected_and_not_cached() -> Result<()> {
		let directory = TempDir::new()?;
		let (reference, encoded) = fixture()?;
		let mut value: serde_json::Value = serde_json::from_slice(&encoded)?;
		value["digest"] = serde_json::Value::String(format!("sha256:{}", "0".repeat(64)));
		let (url, requests, server) =
			start_registry(serde_json::to_vec(&value)?, Duration::ZERO).await?;
		let cache = WorkerCodeCache::new(Some(&url), "default", directory.path())?;
		assert!(cache.prepare(&reference).await.is_err());
		assert!(cache.prepare(&reference).await.is_err());
		assert_eq!(requests.load(Ordering::Relaxed), 2);
		assert!(!cache.disk_path(&reference).exists());
		server.abort();
		Ok(())
	}

	#[tokio::test]
	async fn disk_cache_evicts_oldest_entries_below_low_watermark() -> Result<()> {
		let directory = TempDir::new()?;
		let cache = WorkerCodeCache::new_with_limits(None, "default", directory.path(), 180, 100)?;
		let reference = |worker: &str, digit: char| WorkerVersionReference {
			worker: worker.into(),
			version_id: format!("v_{}", digit.to_string().repeat(64)),
		};
		let first = reference("first", '1');
		let second = reference("second", '2');
		let third = reference("third", '3');
		cache.write_disk(&first, &[1; 80]).await?;
		tokio::time::sleep(Duration::from_millis(10)).await;
		cache.write_disk(&second, &[2; 80]).await?;
		tokio::time::sleep(Duration::from_millis(10)).await;
		cache.write_disk(&third, &[3; 80]).await?;

		assert!(!cache.disk_path(&first).exists());
		assert!(!cache.disk_path(&second).exists());
		assert!(cache.disk_path(&third).exists());
		Ok(())
	}

	#[tokio::test]
	async fn verified_code_starts_when_disk_cache_is_unwritable() -> Result<()> {
		let directory = TempDir::new()?;
		let blocked_path = directory.path().join("not-a-directory");
		tokio::fs::write(&blocked_path, b"occupied").await?;
		let (reference, encoded) = fixture()?;
		let (url, requests, server) = start_registry(encoded, Duration::ZERO).await?;
		let code = WorkerCodeCache::new(Some(&url), "default", &blocked_path)?
			.prepare(&reference)
			.await?;
		assert!(!code.loader_json().is_empty());
		assert_eq!(requests.load(Ordering::Relaxed), 1);
		server.abort();
		Ok(())
	}

	#[test]
	fn module_names_must_be_canonical_relative_paths() {
		assert!(valid_module_name("src/worker.js"));
		assert!(!valid_module_name("src//worker.js"));
		assert!(!valid_module_name("./worker.js"));
		assert!(!valid_module_name("src/../worker.js"));
	}
}
