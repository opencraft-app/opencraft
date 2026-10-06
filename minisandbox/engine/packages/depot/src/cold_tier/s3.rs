use anyhow::{Context, anyhow};
use async_trait::async_trait;
use aws_config::Region;
use aws_sdk_s3::{
	error::SdkError,
	operation::{get_object::GetObjectError, head_object::HeadObjectError},
	primitives::ByteStream,
};
use tokio::io::AsyncReadExt;

use super::{
	ColdTier, ColdTierError, ColdTierInventoryObject, ColdTierInventoryPage,
	ColdTierObjectMetadata, ColdTierRequestGate, ColdTierRequestPermit, ColdTierResult,
	DEFAULT_MAX_QUEUED_REQUESTS, DEFAULT_QUEUE_TIMEOUT_MS, FdbWriteDebtPolicy,
	filesystem::validate_object_key,
};

#[derive(Debug, Clone)]
pub struct S3ColdTier {
	client: aws_sdk_s3::Client,
	bucket: String,
	max_object_size_bytes: u64,
	request_gate: ColdTierRequestGate,
	write_debt_policy: FdbWriteDebtPolicy,
}

impl S3ColdTier {
	pub fn new(
		client: aws_sdk_s3::Client,
		bucket: impl Into<String>,
		max_object_size_bytes: u64,
		max_concurrent_requests: usize,
	) -> anyhow::Result<Self> {
		Self::new_with_admission(
			client,
			bucket,
			max_object_size_bytes,
			max_concurrent_requests,
			DEFAULT_MAX_QUEUED_REQUESTS,
			DEFAULT_QUEUE_TIMEOUT_MS,
		)
	}

	pub fn new_with_admission(
		client: aws_sdk_s3::Client,
		bucket: impl Into<String>,
		max_object_size_bytes: u64,
		max_concurrent_requests: usize,
		max_queued_requests: usize,
		queue_timeout_ms: u64,
	) -> anyhow::Result<Self> {
		Self::new_with_admission_and_write_debt(
			client,
			bucket,
			max_object_size_bytes,
			max_concurrent_requests,
			max_queued_requests,
			queue_timeout_ms,
			FdbWriteDebtPolicy::default(),
		)
	}

	#[allow(clippy::too_many_arguments)]
	pub fn new_with_admission_and_write_debt(
		client: aws_sdk_s3::Client,
		bucket: impl Into<String>,
		max_object_size_bytes: u64,
		max_concurrent_requests: usize,
		max_queued_requests: usize,
		queue_timeout_ms: u64,
		write_debt_policy: FdbWriteDebtPolicy,
	) -> anyhow::Result<Self> {
		let bucket = bucket.into();
		anyhow::ensure!(!bucket.trim().is_empty(), "S3 bucket must not be empty");
		anyhow::ensure!(
			max_object_size_bytes > 0,
			"max object size must be positive"
		);
		Ok(Self {
			client,
			bucket,
			max_object_size_bytes,
			request_gate: ColdTierRequestGate::new(
				max_concurrent_requests,
				max_queued_requests,
				queue_timeout_ms,
			)?,
			write_debt_policy,
		})
	}

	#[allow(clippy::too_many_arguments)]
	pub async fn from_env(
		bucket: impl Into<String>,
		endpoint_url: Option<String>,
		region: impl Into<String>,
		force_path_style: bool,
		max_object_size_bytes: u64,
		max_concurrent_requests: usize,
	) -> anyhow::Result<Self> {
		Self::from_env_with_admission(
			bucket,
			endpoint_url,
			region,
			force_path_style,
			max_object_size_bytes,
			max_concurrent_requests,
			DEFAULT_MAX_QUEUED_REQUESTS,
			DEFAULT_QUEUE_TIMEOUT_MS,
		)
		.await
	}

	#[allow(clippy::too_many_arguments)]
	pub async fn from_env_with_admission(
		bucket: impl Into<String>,
		endpoint_url: Option<String>,
		region: impl Into<String>,
		force_path_style: bool,
		max_object_size_bytes: u64,
		max_concurrent_requests: usize,
		max_queued_requests: usize,
		queue_timeout_ms: u64,
	) -> anyhow::Result<Self> {
		Self::from_env_with_admission_and_write_debt(
			bucket,
			endpoint_url,
			region,
			force_path_style,
			max_object_size_bytes,
			max_concurrent_requests,
			max_queued_requests,
			queue_timeout_ms,
			FdbWriteDebtPolicy::default(),
		)
		.await
	}

	#[allow(clippy::too_many_arguments)]
	pub async fn from_env_with_admission_and_write_debt(
		bucket: impl Into<String>,
		endpoint_url: Option<String>,
		region: impl Into<String>,
		force_path_style: bool,
		max_object_size_bytes: u64,
		max_concurrent_requests: usize,
		max_queued_requests: usize,
		queue_timeout_ms: u64,
		write_debt_policy: FdbWriteDebtPolicy,
	) -> anyhow::Result<Self> {
        let mut config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(Region::new(region.into()));
        if let Some(path) = std::env::var_os("ACTOR_COLD_STORAGE_SESSION_FILE") {
            config = config.credentials_provider(ProjectedStorageSession { path: path.into() });
        }
        let shared_config = config.load().await;
		let mut s3_config =
			aws_sdk_s3::config::Builder::from(&shared_config).force_path_style(force_path_style);
		if let Some(endpoint_url) = endpoint_url {
			s3_config = s3_config.endpoint_url(endpoint_url);
		}
		Self::new_with_admission_and_write_debt(
			aws_sdk_s3::Client::from_conf(s3_config.build()),
			bucket,
			max_object_size_bytes,
			max_concurrent_requests,
			max_queued_requests,
			queue_timeout_ms,
			write_debt_policy,
		)
	}

	fn s3_key<'a>(&self, key: &'a str) -> ColdTierResult<&'a str> {
		validate_object_key(key)?;
		Ok(key)
	}

	fn validate_size(&self, key: &str, size_bytes: u64) -> ColdTierResult<()> {
		if size_bytes > self.max_object_size_bytes {
			return Err(ColdTierError::TooLarge {
				key: key.to_string(),
				actual_bytes: size_bytes,
				max_bytes: self.max_object_size_bytes,
			});
		}
		Ok(())
	}

	async fn permit(
		&self,
		operation: &'static str,
		key: &str,
	) -> ColdTierResult<ColdTierRequestPermit> {
		self.request_gate.acquire(operation, key).await
	}
}

#[async_trait]
impl ColdTier for S3ColdTier {
	fn fdb_write_debt_policy(&self) -> FdbWriteDebtPolicy {
		self.write_debt_policy
	}

	async fn put_object(&self, key: &str, bytes: &[u8]) -> ColdTierResult<()> {
		self.validate_size(key, bytes.len() as u64)?;
		let s3_key = self.s3_key(key)?;
		let _permit = self.permit("put", key).await?;
		self.client
			.put_object()
			.bucket(&self.bucket)
			.key(s3_key)
			.body(ByteStream::from(bytes.to_vec()))
			.send()
			.await
			.map_err(|err| backend("put object", key, anyhow!(err)))?;
		Ok(())
	}

	async fn get_object(&self, key: &str) -> ColdTierResult<Vec<u8>> {
		let s3_key = self.s3_key(key)?;
		let _permit = self.permit("get", key).await?;
		let output = match self
			.client
			.get_object()
			.bucket(&self.bucket)
			.key(s3_key)
			.send()
			.await
		{
			Ok(output) => output,
			Err(err) if is_get_not_found(&err) => {
				return Err(ColdTierError::NotFound {
					key: key.to_string(),
				});
			}
			Err(err) => return Err(backend("get object", key, anyhow!(err))),
		};

		let declared_bytes = output
			.content_length()
			.and_then(|value| value.try_into().ok());
		if let Some(declared_bytes) = declared_bytes {
			self.validate_size(key, declared_bytes)?;
		}
		let mut bytes = Vec::with_capacity(
			declared_bytes
				.unwrap_or_default()
				.min(self.max_object_size_bytes) as usize,
		);
		output
			.body
			.into_async_read()
			.take(self.max_object_size_bytes + 1)
			.read_to_end(&mut bytes)
			.await
			.map_err(|err| backend("read object body", key, anyhow!(err)))?;
		self.validate_size(key, bytes.len() as u64)?;
		if let Some(declared_bytes) = declared_bytes
			&& declared_bytes != bytes.len() as u64
		{
			return Err(ColdTierError::SizeMismatch {
				key: key.to_string(),
				declared_bytes,
				actual_bytes: bytes.len() as u64,
			});
		}
		Ok(bytes)
	}

	async fn head_object(&self, key: &str) -> ColdTierResult<ColdTierObjectMetadata> {
		let s3_key = self.s3_key(key)?;
		let _permit = self.permit("head", key).await?;
		let output = match self
			.client
			.head_object()
			.bucket(&self.bucket)
			.key(s3_key)
			.send()
			.await
		{
			Ok(output) => output,
			Err(err) if is_head_not_found(&err) => {
				return Err(ColdTierError::NotFound {
					key: key.to_string(),
				});
			}
			Err(err) => return Err(backend("head object", key, anyhow!(err))),
		};
		let size_bytes = output
			.content_length()
			.context("S3 HEAD response omitted content length")
			.map_err(|err| backend("head object", key, err))?
			.try_into()
			.context("S3 HEAD response had negative content length")
			.map_err(|err| backend("head object", key, err))?;
		self.validate_size(key, size_bytes)?;
		Ok(ColdTierObjectMetadata {
			size_bytes,
			etag: output.e_tag().map(str::to_string),
		})
	}

	async fn delete_objects(&self, keys: &[String]) -> ColdTierResult<()> {
		// Tencent COS requires Content-MD5 on the S3 multi-object delete body, but the
		// aws-sdk-s3 DeleteObjects model does not expose that header. Exact single-key
		// deletes are portable across COS, S3, and MinIO. GC is outside the SQLite
		// commit path, so prefer bounded, retryable correctness over an incompatible
		// batch optimization.
		for key in keys {
			let s3_key = self.s3_key(key)?;
			let _permit = self.permit("delete", key).await?;
			self.client
				.delete_object()
				.bucket(&self.bucket)
				.key(s3_key)
				.send()
				.await
				.map_err(|err| backend("delete object", key, anyhow!(err)))?;
		}
		Ok(())
	}

	async fn list_inventory_page(
		&self,
		cursor: Option<&str>,
		limit: u16,
	) -> ColdTierResult<ColdTierInventoryPage> {
		if limit == 0 || limit > 1_000 {
			return Err(ColdTierError::InvalidKey {
				key: "<inventory-limit>".to_string(),
				reason: "inventory page limit must be between 1 and 1000",
			});
		}
		let _permit = self.permit("list", cursor.unwrap_or("<start>")).await?;
		let mut request = self
			.client
			.list_objects_v2()
			.bucket(&self.bucket)
			.max_keys(i32::from(limit));
		if let Some(cursor) = cursor {
			request = request.continuation_token(cursor);
		}
		let output = request
			.send()
			.await
			.map_err(|err| backend("list objects", cursor.unwrap_or("<start>"), anyhow!(err)))?;
		let mut objects = Vec::with_capacity(output.contents().len());
		for object in output.contents() {
			let key = object
				.key()
				.context("S3 LIST object omitted key")
				.map_err(|err| backend("list objects", cursor.unwrap_or("<start>"), err))?;
			let size_bytes = object
				.size()
				.context("S3 LIST object omitted size")
				.and_then(|size| u64::try_from(size).context("S3 LIST object had negative size"))
				.map_err(|err| backend("list objects", key, err))?;
			objects.push(ColdTierInventoryObject {
				key: key.to_string(),
				size_bytes,
				etag: object.e_tag().map(str::to_string),
			});
		}
		let next_cursor = if output.is_truncated().unwrap_or(false) {
			Some(
				output
					.next_continuation_token()
					.context("truncated S3 LIST response omitted continuation token")
					.map_err(|err| backend("list objects", cursor.unwrap_or("<start>"), err))?
					.to_string(),
			)
		} else {
			None
		};
		Ok(ColdTierInventoryPage {
			objects,
			next_cursor,
		})
	}
}

fn is_get_not_found<R>(err: &SdkError<GetObjectError, R>) -> bool {
	err.as_service_error()
		.is_some_and(GetObjectError::is_no_such_key)
}

fn is_head_not_found<R>(err: &SdkError<HeadObjectError, R>) -> bool {
	err.as_service_error()
		.is_some_and(HeadObjectError::is_not_found)
}

fn backend(operation: &'static str, key: &str, source: anyhow::Error) -> ColdTierError {
	ColdTierError::Backend {
		operation,
		key: key.to_string(),
		source,
	}
}

// Explicit provider bypasses static environment credentials when enabled.
#[derive(Debug)]
struct ProjectedStorageSession { path: std::path::PathBuf }
#[derive(serde::Deserialize)]
struct StorageSession {
    access_key_id: String,
    secret_access_key: String,
    session_token: String,
    expires_at: u64,
}
impl aws_credential_types::provider::ProvideCredentials for ProjectedStorageSession {
    fn provide_credentials<'a>(&'a self) -> aws_credential_types::provider::future::ProvideCredentials<'a> where Self: 'a {
        use aws_credential_types::{Credentials, provider::{future, error::CredentialsError}};
        future::ProvideCredentials::new(async move {
            let failure = || CredentialsError::provider_error("projected storage session unavailable, invalid or expiring");
            let file = tokio::fs::File::open(&self.path).await.map_err(|_| failure())?;
            let mut bytes = Vec::new();
            file.take(16385).read_to_end(&mut bytes).await.map_err(|_| failure())?;
            if bytes.len() > 16384 { return Err(failure()); }
            let session: StorageSession = serde_json::from_slice(&bytes).map_err(|_| failure())?;
            let expiry = std::time::UNIX_EPOCH.checked_add(std::time::Duration::from_secs(session.expires_at)).ok_or_else(failure)?;
            if session.access_key_id.is_empty() || session.secret_access_key.is_empty() || session.session_token.is_empty()
                || expiry.duration_since(std::time::SystemTime::now()).map_err(|_| failure())? < std::time::Duration::from_secs(30) {
                return Err(failure());
            }
            Ok(Credentials::new(session.access_key_id, session.secret_access_key,
                Some(session.session_token), Some(expiry), "KRProjectedStorageSession"))
        })
    }
}
