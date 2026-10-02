//! Tencent-COS transport and cache coalescing for immutable BlockVolume chunks.

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use async_trait::async_trait;
use aws_config::Region;
use aws_sdk_s3::{error::SdkError, operation::get_object::GetObjectError, primitives::ByteStream};
use tokio::{
	io::AsyncReadExt,
	sync::{Mutex, OnceCell, OwnedSemaphorePermit, Semaphore, TryAcquireError},
};

use crate::{CHUNK_BYTES, ChunkCache, ChunkHash};

const DEFAULT_MAX_CONCURRENT_REQUESTS: usize = 16;
const DEFAULT_MAX_QUEUED_REQUESTS: usize = 64;
const DEFAULT_QUEUE_TIMEOUT: Duration = Duration::from_secs(15);
const OBJECT_PREFIX: &str = "minisandbox/block-chunks/v2-4m";

/// Bounded immutable chunk transport failure.
#[derive(Clone, Debug, thiserror::Error)]
pub enum ChunkStoreError {
	/// The exact immutable object does not currently exist.
	#[error("BlockVolume chunk does not exist")]
	NotFound,
	/// Returned bytes did not authenticate against their object identity.
	#[error("BlockVolume chunk failed authentication")]
	AuthenticationFailed,
	/// The configured COS request queue is full or timed out.
	#[error("BlockVolume chunk store is overloaded")]
	Overloaded,
	/// COS or the local cache failed explicitly.
	#[error("BlockVolume chunk store unavailable: {0}")]
	Unavailable(Arc<str>),
}

impl ChunkStoreError {
	fn unavailable(error: impl std::fmt::Display) -> Self {
		Self::Unavailable(Arc::from(error.to_string()))
	}
}

/// Async immutable 4 MiB object boundary.
#[async_trait]
pub trait ChunkStore: Send + Sync + 'static {
	/// Stores or confirms the exact content-addressed object.
	async fn put_chunk(&self, hash: ChunkHash, bytes: &[u8]) -> Result<(), ChunkStoreError>;

	/// Reads and authenticates one exact object.
	async fn get_chunk(&self, hash: ChunkHash) -> Result<Arc<[u8]>, ChunkStoreError>;

	/// Bypasses non-authoritative caches and verifies that COS exposes the exact object.
	async fn verify_chunk(&self, hash: ChunkHash) -> Result<Arc<[u8]>, ChunkStoreError> {
		self.get_chunk(hash).await
	}

	/// Deletes one exact unreferenced object during GC.
	async fn delete_chunk(&self, hash: ChunkHash) -> Result<(), ChunkStoreError>;
}

#[derive(Clone, Debug)]
struct RequestGate {
	execution: Arc<Semaphore>,
	admission: Arc<Semaphore>,
	timeout: Duration,
}

impl RequestGate {
	fn new(
		max_concurrent: usize,
		max_queued: usize,
		timeout: Duration,
	) -> Result<Self, ChunkStoreError> {
		if max_concurrent == 0 || timeout.is_zero() {
			return Err(ChunkStoreError::Overloaded);
		}
		let admitted = max_concurrent
			.checked_add(max_queued)
			.ok_or(ChunkStoreError::Overloaded)?;
		Ok(Self {
			execution: Arc::new(Semaphore::new(max_concurrent)),
			admission: Arc::new(Semaphore::new(admitted)),
			timeout,
		})
	}

	async fn acquire(&self) -> Result<RequestPermit, ChunkStoreError> {
		let admission = match self.admission.clone().try_acquire_owned() {
			Ok(permit) => permit,
			Err(TryAcquireError::NoPermits | TryAcquireError::Closed) => {
				return Err(ChunkStoreError::Overloaded);
			}
		};
		let execution = tokio::time::timeout(self.timeout, self.execution.clone().acquire_owned())
			.await
			.map_err(|_| ChunkStoreError::Overloaded)?
			.map_err(|_| ChunkStoreError::Overloaded)?;
		Ok(RequestPermit {
			_admission: admission,
			_execution: execution,
		})
	}
}

struct RequestPermit {
	_admission: OwnedSemaphorePermit,
	_execution: OwnedSemaphorePermit,
}

/// Tencent-COS/S3-compatible immutable chunk transport.
#[derive(Clone)]
pub struct CosChunkStore {
	client: aws_sdk_s3::Client,
	bucket: Arc<str>,
	gate: RequestGate,
}

impl CosChunkStore {
	/// Constructs a transport around an already configured S3-compatible client.
	///
	/// # Errors
	///
	/// Returns an error for an empty bucket or invalid request bounds.
	pub fn new(
		client: aws_sdk_s3::Client,
		bucket: impl Into<String>,
		max_concurrent: usize,
		max_queued: usize,
		queue_timeout: Duration,
	) -> Result<Self, ChunkStoreError> {
		let bucket = bucket.into();
		if bucket.trim().is_empty() {
			return Err(ChunkStoreError::unavailable("COS bucket is empty"));
		}
		Ok(Self {
			client,
			bucket: Arc::from(bucket),
			gate: RequestGate::new(max_concurrent, max_queued, queue_timeout)?,
		})
	}

	/// Loads AWS-compatible credentials from the process environment.
	///
	/// # Errors
	///
	/// Returns an error for invalid configuration.
	pub async fn from_env(
		bucket: impl Into<String>,
		endpoint_url: Option<String>,
		region: impl Into<String>,
		force_path_style: bool,
	) -> Result<Self, ChunkStoreError> {
		let shared = aws_config::defaults(aws_config::BehaviorVersion::latest())
			.region(Region::new(region.into()))
			.load()
			.await;
		let mut config =
			aws_sdk_s3::config::Builder::from(&shared).force_path_style(force_path_style);
		if let Some(endpoint_url) = endpoint_url {
			config = config.endpoint_url(endpoint_url);
		}
		Self::new(
			aws_sdk_s3::Client::from_conf(config.build()),
			bucket,
			DEFAULT_MAX_CONCURRENT_REQUESTS,
			DEFAULT_MAX_QUEUED_REQUESTS,
			DEFAULT_QUEUE_TIMEOUT,
		)
	}

	fn object_key(hash: ChunkHash) -> String {
		format!("{OBJECT_PREFIX}/{}", hash.to_hex())
	}
}

#[async_trait]
impl ChunkStore for CosChunkStore {
	async fn put_chunk(&self, hash: ChunkHash, bytes: &[u8]) -> Result<(), ChunkStoreError> {
		if ChunkHash::for_chunk(bytes).map_err(ChunkStoreError::unavailable)? != hash {
			return Err(ChunkStoreError::AuthenticationFailed);
		}
		let _permit = self.gate.acquire().await?;
		self.client
			.put_object()
			.bucket(self.bucket.as_ref())
			.key(Self::object_key(hash))
			.body(ByteStream::from(bytes.to_vec()))
			.send()
			.await
			.map_err(ChunkStoreError::unavailable)?;
		Ok(())
	}

	async fn get_chunk(&self, hash: ChunkHash) -> Result<Arc<[u8]>, ChunkStoreError> {
		let _permit = self.gate.acquire().await?;
		let output = self
			.client
			.get_object()
			.bucket(self.bucket.as_ref())
			.key(Self::object_key(hash))
			.send()
			.await
			.map_err(|error| {
				if is_not_found(&error) {
					ChunkStoreError::NotFound
				} else {
					ChunkStoreError::unavailable(error)
				}
			})?;
		if output
			.content_length()
			.and_then(|length| usize::try_from(length).ok())
			.is_some_and(|length| length != CHUNK_BYTES)
		{
			return Err(ChunkStoreError::AuthenticationFailed);
		}
		let mut bytes = Vec::with_capacity(CHUNK_BYTES);
		output
			.body
			.into_async_read()
			.take(u64::try_from(CHUNK_BYTES + 1).unwrap())
			.read_to_end(&mut bytes)
			.await
			.map_err(ChunkStoreError::unavailable)?;
		if ChunkHash::for_chunk(&bytes).map_err(|_| ChunkStoreError::AuthenticationFailed)? != hash
		{
			return Err(ChunkStoreError::AuthenticationFailed);
		}
		Ok(bytes.into())
	}

	async fn delete_chunk(&self, hash: ChunkHash) -> Result<(), ChunkStoreError> {
		let _permit = self.gate.acquire().await?;
		self.client
			.delete_object()
			.bucket(self.bucket.as_ref())
			.key(Self::object_key(hash))
			.send()
			.await
			.map_err(ChunkStoreError::unavailable)?;
		Ok(())
	}
}

fn is_not_found<R>(error: &SdkError<GetObjectError, R>) -> bool {
	error
		.as_service_error()
		.is_some_and(GetObjectError::is_no_such_key)
}

type SharedLoad = Arc<OnceCell<Result<Arc<[u8]>, ChunkStoreError>>>;

/// RAM/NVMe-cached chunk transport with per-hash single-flight cold reads.
pub struct CachedChunkStore<S> {
	inner: Arc<S>,
	cache: Arc<ChunkCache>,
	inflight: Mutex<BTreeMap<ChunkHash, SharedLoad>>,
}

impl<S> CachedChunkStore<S> {
	/// Wraps one immutable transport with a shared authenticated cache.
	#[must_use]
	pub fn new(inner: Arc<S>, cache: Arc<ChunkCache>) -> Self {
		Self {
			inner,
			cache,
			inflight: Mutex::new(BTreeMap::new()),
		}
	}
}

#[async_trait]
impl<S: ChunkStore> ChunkStore for CachedChunkStore<S> {
	async fn put_chunk(&self, hash: ChunkHash, bytes: &[u8]) -> Result<(), ChunkStoreError> {
		self.inner.put_chunk(hash, bytes).await?;
		self.cache
			.insert(hash, bytes)
			.map_err(ChunkStoreError::unavailable)
	}

	async fn get_chunk(&self, hash: ChunkHash) -> Result<Arc<[u8]>, ChunkStoreError> {
		if let Some(bytes) = self.cache.get(hash) {
			return Ok(bytes);
		}
		let load = {
			let mut inflight = self.inflight.lock().await;
			inflight.entry(hash).or_default().clone()
		};
		let result = load
			.get_or_init(|| async {
				let bytes = self.inner.get_chunk(hash).await?;
				self.cache
					.insert(hash, &bytes)
					.map_err(ChunkStoreError::unavailable)?;
				Ok(bytes)
			})
			.await
			.clone();
		let mut inflight = self.inflight.lock().await;
		if inflight
			.get(&hash)
			.is_some_and(|current| Arc::ptr_eq(current, &load))
		{
			inflight.remove(&hash);
		}
		result
	}

	async fn verify_chunk(&self, hash: ChunkHash) -> Result<Arc<[u8]>, ChunkStoreError> {
		let bytes = self.inner.verify_chunk(hash).await?;
		self.cache
			.insert(hash, &bytes)
			.map_err(ChunkStoreError::unavailable)?;
		Ok(bytes)
	}

	async fn delete_chunk(&self, hash: ChunkHash) -> Result<(), ChunkStoreError> {
		self.inner.delete_chunk(hash).await?;
		self.cache
			.invalidate(hash)
			.map_err(ChunkStoreError::unavailable)
	}
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicUsize, Ordering};

	use super::*;

	#[test]
	fn object_namespace_encodes_the_four_mib_protocol() {
		let hash = ChunkHash::for_chunk(&vec![0; CHUNK_BYTES]).unwrap();
		assert!(CosChunkStore::object_key(hash).starts_with("minisandbox/block-chunks/v2-4m/"));
	}

	struct CountingStore {
		bytes: Arc<[u8]>,
		reads: AtomicUsize,
	}

	#[async_trait]
	impl ChunkStore for CountingStore {
		async fn put_chunk(&self, _hash: ChunkHash, _bytes: &[u8]) -> Result<(), ChunkStoreError> {
			Ok(())
		}

		async fn get_chunk(&self, _hash: ChunkHash) -> Result<Arc<[u8]>, ChunkStoreError> {
			self.reads.fetch_add(1, Ordering::Relaxed);
			tokio::task::yield_now().await;
			Ok(self.bytes.clone())
		}

		async fn delete_chunk(&self, _hash: ChunkHash) -> Result<(), ChunkStoreError> {
			Ok(())
		}
	}

	#[tokio::test]
	async fn concurrent_misses_issue_one_cold_read() {
		let directory = tempfile::tempdir().unwrap();
		let bytes: Arc<[u8]> = vec![0x71; CHUNK_BYTES].into();
		let hash = ChunkHash::for_chunk(&bytes).unwrap();
		let inner = Arc::new(CountingStore {
			bytes: bytes.clone(),
			reads: AtomicUsize::new(0),
		});
		let cache = Arc::new(
			ChunkCache::open(
				directory.path(),
				u64::try_from(CHUNK_BYTES).unwrap(),
				u64::try_from(CHUNK_BYTES).unwrap(),
			)
			.unwrap(),
		);
		let store = Arc::new(CachedChunkStore::new(inner.clone(), cache));
		let mut tasks = Vec::new();
		for _ in 0..32 {
			let store = store.clone();
			tasks.push(tokio::spawn(
				async move { store.get_chunk(hash).await.unwrap() },
			));
		}
		for task in tasks {
			assert_eq!(task.await.unwrap().as_ref(), bytes.as_ref());
		}
		assert_eq!(inner.reads.load(Ordering::Relaxed), 1);
	}
}
