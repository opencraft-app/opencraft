use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use thiserror::Error;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, TryAcquireError};

pub mod accounting;
pub(crate) mod audit;
mod config;
pub(crate) mod delete;
mod filesystem;
mod identity;
mod inventory;
mod object;
pub(crate) mod policy;
mod s3;

pub use audit::read_cold_delete_receipt;
pub use config::cold_tier_from_config;
pub use filesystem::FilesystemColdTier;
pub use identity::ensure_cold_tier_identity;
pub use inventory::{
	COLD_INVENTORY_AUDIT_MAX_LEASE_MS, ColdInventoryAuditState, ColdInventoryAuditSummary,
	ColdInventoryDisposition, ColdInventoryPageReport, ColdInventoryRecord, audit_cold_inventory,
	complete_cold_inventory_audit, read_cold_inventory_audit_state,
	release_cold_inventory_audit_lease, scan_cold_inventory_page,
	try_acquire_cold_inventory_audit_lease,
};
pub use object::{
	COLD_SHARD_OBJECT_LAYOUT, ColdShardObjectError, cold_shard_object_key, materialize_cold_shard,
	validate_cold_shard_object, validate_cold_shard_object_key, validate_cold_shard_ref_key,
};
pub use policy::{
	ColdGcPolicy, ColdGcPolicySpec, DEFAULT_COLD_GC_GRACE_PERIOD_MS,
	DEFAULT_COLD_GC_MAX_DELETE_CONCURRENCY, DEFAULT_COLD_GC_MAX_OBJECTS_PER_BATCH,
	DEFAULT_COLD_GC_RETRY_INITIAL_BACKOFF_MS, DEFAULT_COLD_GC_RETRY_MAX_ATTEMPTS,
	DEFAULT_COLD_GC_RETRY_MAX_BACKOFF_MS, read_cold_gc_policy, set_cold_gc_policy,
};
pub use s3::S3ColdTier;

pub const DEFAULT_MAX_OBJECT_SIZE_BYTES: u64 = 4 * 1024 * 1024;
pub const DEFAULT_MAX_CONCURRENT_REQUESTS: usize = 16;
pub const DEFAULT_MAX_QUEUED_REQUESTS: usize = 64;
pub const DEFAULT_QUEUE_TIMEOUT_MS: u64 = 15_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FdbWriteDebtPolicy {
	pub target_bytes: i64,
	pub limit_bytes: i64,
}

impl Default for FdbWriteDebtPolicy {
	fn default() -> Self {
		Self {
			target_bytes: crate::conveyer::quota::FDB_WRITE_DEBT_TARGET_BYTES,
			limit_bytes: crate::conveyer::quota::FDB_WRITE_DEBT_LIMIT_BYTES,
		}
	}
}

impl FdbWriteDebtPolicy {
	pub fn new(target_bytes: u64, limit_bytes: u64) -> anyhow::Result<Self> {
		let target_bytes = i64::try_from(target_bytes)
			.map_err(|_| anyhow::anyhow!("FDB write-debt target exceeds i64"))?;
		let limit_bytes = i64::try_from(limit_bytes)
			.map_err(|_| anyhow::anyhow!("FDB write-debt limit exceeds i64"))?;
		anyhow::ensure!(target_bytes > 0, "FDB write-debt target must be positive");
		anyhow::ensure!(
			limit_bytes > target_bytes,
			"FDB write-debt limit must exceed target"
		);
		Ok(Self {
			target_bytes,
			limit_bytes,
		})
	}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColdTierObjectMetadata {
	pub size_bytes: u64,
	pub etag: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColdTierInventoryObject {
	pub key: String,
	pub size_bytes: u64,
	pub etag: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColdTierInventoryPage {
	pub objects: Vec<ColdTierInventoryObject>,
	pub next_cursor: Option<String>,
}

#[derive(Debug, Error)]
pub enum ColdTierError {
	#[error("invalid cold-tier object key {key:?}: {reason}")]
	InvalidKey { key: String, reason: &'static str },
	#[error("cold-tier object not found: {key}")]
	NotFound { key: String },
	#[error("cold-tier object {key} is {actual_bytes} bytes, above the {max_bytes}-byte limit")]
	TooLarge {
		key: String,
		actual_bytes: u64,
		max_bytes: u64,
	},
	#[error(
		"cold-tier object {key} size mismatch: metadata declared {declared_bytes} bytes but received {actual_bytes} bytes"
	)]
	SizeMismatch {
		key: String,
		declared_bytes: u64,
		actual_bytes: u64,
	},
	#[error(
		"cold-tier {operation} overloaded for {key}: {reason}; retry after {retry_after_ms} ms"
	)]
	Overloaded {
		operation: &'static str,
		key: String,
		reason: &'static str,
		retry_after_ms: u64,
	},
	#[error("cold-tier {operation} failed for {key}")]
	Backend {
		operation: &'static str,
		key: String,
		#[source]
		source: anyhow::Error,
	},
}

pub type ColdTierResult<T> = Result<T, ColdTierError>;

impl ColdTierError {
	pub fn is_not_found(&self) -> bool {
		matches!(self, ColdTierError::NotFound { .. })
	}

	pub fn is_overloaded(&self) -> bool {
		matches!(self, ColdTierError::Overloaded { .. })
	}
}

#[derive(Debug, Clone)]
pub(super) struct ColdTierRequestGate {
	execution_permits: Arc<Semaphore>,
	admission_permits: Arc<Semaphore>,
	queue_timeout: Duration,
}

impl ColdTierRequestGate {
	pub(super) fn new(
		max_concurrent_requests: usize,
		max_queued_requests: usize,
		queue_timeout_ms: u64,
	) -> anyhow::Result<Self> {
		anyhow::ensure!(
			max_concurrent_requests > 0,
			"max concurrent requests must be positive"
		);
		anyhow::ensure!(queue_timeout_ms > 0, "queue timeout must be positive");
		let max_admitted_requests = max_concurrent_requests
			.checked_add(max_queued_requests)
			.ok_or_else(|| anyhow::anyhow!("cold-tier admission capacity overflow"))?;
		Ok(Self {
			execution_permits: Arc::new(Semaphore::new(max_concurrent_requests)),
			admission_permits: Arc::new(Semaphore::new(max_admitted_requests)),
			queue_timeout: Duration::from_millis(queue_timeout_ms),
		})
	}

	pub(super) async fn acquire(
		&self,
		operation: &'static str,
		key: &str,
	) -> ColdTierResult<ColdTierRequestPermit> {
		let started = std::time::Instant::now();
		let admission = match self.admission_permits.clone().try_acquire_owned() {
			Ok(permit) => permit,
			Err(TryAcquireError::NoPermits) => {
				crate::conveyer::metrics::observe_cold_tier_queue(operation, started, "full");
				return Err(ColdTierError::Overloaded {
					operation,
					key: key.to_string(),
					reason: "queue_full",
					retry_after_ms: u64::try_from(self.queue_timeout.as_millis())
						.unwrap_or(u64::MAX),
				});
			}
			Err(TryAcquireError::Closed) => {
				crate::conveyer::metrics::observe_cold_tier_queue(operation, started, "closed");
				return Err(ColdTierError::Overloaded {
					operation,
					key: key.to_string(),
					reason: "admission_closed",
					retry_after_ms: u64::try_from(self.queue_timeout.as_millis())
						.unwrap_or(u64::MAX),
				});
			}
		};
		let queued = crate::conveyer::metrics::ColdTierQueueGuard::new(operation);
		let execution = match tokio::time::timeout(
			self.queue_timeout,
			self.execution_permits.clone().acquire_owned(),
		)
		.await
		{
			Ok(Ok(permit)) => permit,
			Ok(Err(_)) => {
				crate::conveyer::metrics::observe_cold_tier_queue(operation, started, "closed");
				return Err(ColdTierError::Overloaded {
					operation,
					key: key.to_string(),
					reason: "execution_closed",
					retry_after_ms: u64::try_from(self.queue_timeout.as_millis())
						.unwrap_or(u64::MAX),
				});
			}
			Err(_) => {
				crate::conveyer::metrics::observe_cold_tier_queue(operation, started, "timeout");
				return Err(ColdTierError::Overloaded {
					operation,
					key: key.to_string(),
					reason: "queue_timeout",
					retry_after_ms: u64::try_from(self.queue_timeout.as_millis())
						.unwrap_or(u64::MAX),
				});
			}
		};
		drop(queued);
		crate::conveyer::metrics::observe_cold_tier_queue(operation, started, "admitted");
		crate::conveyer::metrics::cold_tier_request_started(operation);
		Ok(ColdTierRequestPermit {
			_admission: admission,
			_execution: execution,
			operation,
		})
	}
}

#[derive(Debug)]
pub(super) struct ColdTierRequestPermit {
	_admission: OwnedSemaphorePermit,
	_execution: OwnedSemaphorePermit,
	operation: &'static str,
}

impl Drop for ColdTierRequestPermit {
	fn drop(&mut self) {
		crate::conveyer::metrics::cold_tier_request_finished(self.operation);
	}
}

#[async_trait]
pub trait ColdTier: Send + Sync + 'static {
	fn fdb_write_debt_policy(&self) -> FdbWriteDebtPolicy {
		FdbWriteDebtPolicy::default()
	}

	async fn put_object(&self, key: &str, bytes: &[u8]) -> ColdTierResult<()>;

	async fn get_object(&self, key: &str) -> ColdTierResult<Vec<u8>>;

	async fn head_object(&self, key: &str) -> ColdTierResult<ColdTierObjectMetadata>;

	async fn delete_objects(&self, keys: &[String]) -> ColdTierResult<()>;

	/// Read-only physical inventory. The opaque cursor belongs to the backing store and callers
	/// must persist it only as scan progress, never as object ownership proof.
	async fn list_inventory_page(
		&self,
		cursor: Option<&str>,
		limit: u16,
	) -> ColdTierResult<ColdTierInventoryPage>;
}

#[async_trait]
impl<T> ColdTier for Arc<T>
where
	T: ColdTier + ?Sized,
{
	fn fdb_write_debt_policy(&self) -> FdbWriteDebtPolicy {
		self.as_ref().fdb_write_debt_policy()
	}

	async fn put_object(&self, key: &str, bytes: &[u8]) -> ColdTierResult<()> {
		self.as_ref().put_object(key, bytes).await
	}

	async fn get_object(&self, key: &str) -> ColdTierResult<Vec<u8>> {
		self.as_ref().get_object(key).await
	}

	async fn head_object(&self, key: &str) -> ColdTierResult<ColdTierObjectMetadata> {
		self.as_ref().head_object(key).await
	}

	async fn delete_objects(&self, keys: &[String]) -> ColdTierResult<()> {
		self.as_ref().delete_objects(keys).await
	}

	async fn list_inventory_page(
		&self,
		cursor: Option<&str>,
		limit: u16,
	) -> ColdTierResult<ColdTierInventoryPage> {
		self.as_ref().list_inventory_page(cursor, limit).await
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[tokio::test]
	async fn request_gate_rejects_full_and_expired_recovery_queues() {
		let no_queue = ColdTierRequestGate::new(1, 0, 1_000).unwrap();
		let active = no_queue.acquire("get", "active").await.unwrap();
		let full = no_queue.acquire("get", "full").await.unwrap_err();
		assert!(matches!(
			full,
			ColdTierError::Overloaded {
				reason: "queue_full",
				..
			}
		));
		drop(active);

		let expiring_queue = ColdTierRequestGate::new(1, 1, 1).unwrap();
		let active = expiring_queue.acquire("get", "active").await.unwrap();
		let expired = expiring_queue.acquire("get", "expired").await.unwrap_err();
		assert!(matches!(
			expired,
			ColdTierError::Overloaded {
				reason: "queue_timeout",
				..
			}
		));
		drop(active);
	}
}
