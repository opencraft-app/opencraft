use anyhow::{Result, bail};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use url::Url;

const DEFAULT_COLD_MAX_OBJECT_SIZE_BYTES: u64 = 4 * 1024 * 1024;
const DEFAULT_COLD_MAX_CONCURRENT_REQUESTS: usize = 16;
const DEFAULT_COLD_MAX_QUEUED_REQUESTS: usize = 64;
const DEFAULT_COLD_QUEUE_TIMEOUT_MS: u64 = 15_000;
const DEFAULT_FDB_WRITE_DEBT_TARGET_BYTES: u64 = 10 * 1024 * 1024;
const DEFAULT_FDB_WRITE_DEBT_LIMIT_BYTES: u64 = 12 * 1024 * 1024;
const MIN_FDB_WRITE_DEBT_TARGET_BYTES: u64 = 64 * 1024;
const MIN_FDB_WRITE_DEBT_HEADROOM_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FDB_WRITE_DEBT_LIMIT_BYTES: u64 = 1024 * 1024 * 1024;
const DEFAULT_COLD_RECOVERY_WINDOW_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const MIN_COLD_RECOVERY_WINDOW_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_COLD_RECOVERY_WINDOW_MS: u64 = 365 * 24 * 60 * 60 * 1000;
const MAX_COLD_OBJECT_SIZE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_COLD_CONCURRENT_REQUESTS: usize = 1024;
const MAX_COLD_QUEUED_REQUESTS: usize = 16_384;
const MAX_COLD_QUEUE_TIMEOUT_MS: u64 = 5 * 60 * 1000;
const MIN_BACKUP_FENCE_POLL_INTERVAL_MS: u64 = 10_000;
const MAX_BACKUP_FENCE_POLL_INTERVAL_MS: u64 = 5 * 60 * 1_000;
const MAX_BACKUP_FENCE_LEASE_VALIDITY_MS: u64 = 15 * 60 * 1_000;
const MAX_BACKUP_FENCE_COMMAND_TIMEOUT_MS: u64 = 10 * 60 * 1_000;
const MAX_BACKUP_GENERATIONS: usize = 1024;

fn default_cold_max_object_size_bytes() -> u64 {
	DEFAULT_COLD_MAX_OBJECT_SIZE_BYTES
}

fn default_cold_max_concurrent_requests() -> usize {
	DEFAULT_COLD_MAX_CONCURRENT_REQUESTS
}

fn default_cold_max_queued_requests() -> usize {
	DEFAULT_COLD_MAX_QUEUED_REQUESTS
}

fn default_cold_queue_timeout_ms() -> u64 {
	DEFAULT_COLD_QUEUE_TIMEOUT_MS
}

fn default_cold_recovery_window_ms() -> u64 {
	DEFAULT_COLD_RECOVERY_WINDOW_MS
}

fn default_s3_region() -> String {
	"us-east-1".to_string()
}

fn default_fdbbackup_binary() -> String {
	"/usr/bin/fdbbackup".to_string()
}

fn default_required_fdbbackup_version() -> String {
	"7.3.79".to_string()
}

fn default_backup_fence_poll_interval_ms() -> u64 {
	60 * 1_000
}

fn default_backup_fence_lease_validity_ms() -> u64 {
	10 * 60 * 1_000
}

fn default_backup_fence_command_timeout_ms() -> u64 {
	2 * 60 * 1_000
}

fn default_backup_fence_leadership_lease_ms() -> u64 {
	5 * 60 * 1_000
}

fn default_max_backup_generations() -> usize {
	128
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Sqlite {
	/// UNSTABLE: disables SQLite hot compaction.
	#[serde(default)]
	pub unstable_disable_compaction: Option<bool>,
	/// Asynchronous exact-key cold storage for workflow-compacted SQLite shards.
	#[serde(default)]
	pub workflow_cold_storage: Option<SqliteWorkflowColdStorage>,
	/// Bounded FDB hot-tail policy. Production defaults are deliberately large enough for normal
	/// commits; E2E deployments may lower the target while retaining the required commit headroom.
	#[serde(default)]
	pub workflow_write_debt: SqliteWorkflowWriteDebt,
	/// Automatically expires every dedicated FoundationDB backup repository, verifies the complete
	/// restore range, and renews the short-lived certificate required for physical cold deletion.
	#[serde(default)]
	pub backup_recovery_fence_controller: Option<SqliteBackupRecoveryFenceController>,
}

impl Sqlite {
	pub fn unstable_disable_compaction(&self) -> bool {
		// TODO: Re-enable compaction by default after thorough testing is complete.
		self.unstable_disable_compaction.unwrap_or(true)
	}

	pub fn workflow_cold_storage(&self) -> Option<&SqliteWorkflowColdStorage> {
		self.workflow_cold_storage.as_ref()
	}

	pub fn workflow_write_debt(&self) -> SqliteWorkflowWriteDebt {
		self.workflow_write_debt
	}

	pub fn backup_recovery_fence_controller(&self) -> Option<&SqliteBackupRecoveryFenceController> {
		self.backup_recovery_fence_controller.as_ref()
	}

	pub fn validate(&self) -> Result<()> {
		if let Some(controller) = &self.backup_recovery_fence_controller {
			controller.validate()?;
		}
		let Some(cold_storage) = &self.workflow_cold_storage else {
			return Ok(());
		};

		if self.unstable_disable_compaction() {
			bail!("sqlite.workflow_cold_storage requires sqlite.unstable_disable_compaction=false");
		}

		self.workflow_write_debt.validate()?;
		cold_storage.validate()?;

		Ok(())
	}
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SqliteWorkflowWriteDebt {
	/// Soft target that wakes compaction before admission is exhausted.
	pub target_bytes: u64,
	/// Hard hot-tail admission boundary. This is not a logical SQLite size quota.
	pub limit_bytes: u64,
}

impl Default for SqliteWorkflowWriteDebt {
	fn default() -> Self {
		Self {
			target_bytes: DEFAULT_FDB_WRITE_DEBT_TARGET_BYTES,
			limit_bytes: DEFAULT_FDB_WRITE_DEBT_LIMIT_BYTES,
		}
	}
}

impl SqliteWorkflowWriteDebt {
	fn validate(&self) -> Result<()> {
		if self.target_bytes < MIN_FDB_WRITE_DEBT_TARGET_BYTES {
			bail!(
				"sqlite.workflow_write_debt.target_bytes must be at least {MIN_FDB_WRITE_DEBT_TARGET_BYTES}"
			);
		}
		if self.limit_bytes > MAX_FDB_WRITE_DEBT_LIMIT_BYTES {
			bail!(
				"sqlite.workflow_write_debt.limit_bytes must not exceed {MAX_FDB_WRITE_DEBT_LIMIT_BYTES}"
			);
		}
		let minimum_limit = self
			.target_bytes
			.checked_add(MIN_FDB_WRITE_DEBT_HEADROOM_BYTES)
			.ok_or_else(|| anyhow::anyhow!("sqlite workflow write-debt policy overflow"))?;
		if self.limit_bytes < minimum_limit {
			bail!(
				"sqlite.workflow_write_debt.limit_bytes must leave at least {MIN_FDB_WRITE_DEBT_HEADROOM_BYTES} bytes above target_bytes"
			);
		}
		Ok(())
	}
}

#[derive(Debug, Serialize, Deserialize, Clone, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SqliteBackupRecoveryFenceController {
	/// Exhaustive set of dedicated fdbbackup base URLs. Every backup listed below every URL is part
	/// of the recovery contract; do not share them with another cluster or retention policy.
	pub backup_base_urls: Vec<String>,
	/// Explicit recovery retention enforced by `fdbbackup expire`. The controller never uses
	/// `--force`, and only certifies the catalog after expiration has completed successfully.
	pub retention_days: u32,
	#[serde(default = "default_fdbbackup_binary")]
	pub fdbbackup_binary: String,
	/// Exact CLI version whose `describe` summary grammar this Engine build accepts.
	#[serde(default = "default_required_fdbbackup_version")]
	pub required_fdbbackup_version: String,
	/// Credential files passed as repeated `--blob-credentials` arguments. Secrets must not be
	/// embedded in `backup_base_urls`.
	#[serde(default)]
	pub blob_credentials: Vec<String>,
	/// Optional CA bundle passed to every `fdbbackup` catalog command. This is required when the
	/// backup endpoint's certificate chain is not trusted by the image's system CA store.
	#[serde(default)]
	pub tls_ca_file: Option<String>,
	#[serde(default = "default_backup_fence_poll_interval_ms")]
	pub poll_interval_ms: u64,
	#[serde(default = "default_backup_fence_lease_validity_ms")]
	pub lease_validity_ms: u64,
	#[serde(default = "default_backup_fence_command_timeout_ms")]
	pub command_timeout_ms: u64,
	/// UDB-backed best-effort leader lease that prevents every Engine replica from inspecting the
	/// backup catalog. It affects cost only; deletion safety still comes from the fence lease.
	#[serde(default = "default_backup_fence_leadership_lease_ms")]
	pub leadership_lease_ms: u64,
	#[serde(default = "default_max_backup_generations")]
	pub max_backup_generations: usize,
}

impl SqliteBackupRecoveryFenceController {
	fn validate(&self) -> Result<()> {
		if self.fdbbackup_binary.trim().is_empty() {
			bail!("sqlite.backup_recovery_fence_controller.fdbbackup_binary must not be empty");
		}
		if self.required_fdbbackup_version.trim().is_empty() {
			bail!(
				"sqlite.backup_recovery_fence_controller.required_fdbbackup_version must not be empty"
			);
		}
		if self.retention_days == 0 {
			bail!("sqlite.backup_recovery_fence_controller.retention_days must be positive");
		}
		if self.backup_base_urls.is_empty() {
			bail!("sqlite.backup_recovery_fence_controller.backup_base_urls must not be empty");
		}
		let mut unique_base_urls = std::collections::BTreeSet::new();
		for configured_url in &self.backup_base_urls {
			let backup_base_url = Url::parse(configured_url).map_err(|error| {
				anyhow::anyhow!(
					"sqlite.backup_recovery_fence_controller.backup_base_urls contains an invalid URL: {error}"
				)
			})?;
			if !matches!(backup_base_url.scheme(), "file" | "blobstore") {
				bail!(
					"sqlite.backup_recovery_fence_controller.backup_base_urls must use file:// or blobstore://"
				);
			}
			if backup_base_url.password().is_some() {
				bail!(
					"sqlite.backup_recovery_fence_controller.backup_base_urls must not embed secrets; use blob_credentials"
				);
			}
			if backup_base_url.scheme() == "blobstore"
				&& !matches!(backup_base_url.path(), "" | "/")
			{
				bail!(
					"sqlite.backup_recovery_fence_controller.backup_base_urls must not contain a backup generation path; fdbbackup list requires the blobstore endpoint root"
				);
			}
			if backup_base_url.fragment().is_some() {
				bail!(
					"sqlite.backup_recovery_fence_controller.backup_base_urls must not contain a fragment"
				);
			}
			if !unique_base_urls.insert(backup_base_url.to_string()) {
				bail!(
					"sqlite.backup_recovery_fence_controller.backup_base_urls must not contain duplicates"
				);
			}
		}
		if !(MIN_BACKUP_FENCE_POLL_INTERVAL_MS..=MAX_BACKUP_FENCE_POLL_INTERVAL_MS)
			.contains(&self.poll_interval_ms)
		{
			bail!(
				"sqlite.backup_recovery_fence_controller.poll_interval_ms must be between {MIN_BACKUP_FENCE_POLL_INTERVAL_MS} and {MAX_BACKUP_FENCE_POLL_INTERVAL_MS}"
			);
		}
		if self.lease_validity_ms > MAX_BACKUP_FENCE_LEASE_VALIDITY_MS {
			bail!(
				"sqlite.backup_recovery_fence_controller.lease_validity_ms must not exceed {MAX_BACKUP_FENCE_LEASE_VALIDITY_MS}"
			);
		}
		if self.command_timeout_ms == 0
			|| self.command_timeout_ms > MAX_BACKUP_FENCE_COMMAND_TIMEOUT_MS
		{
			bail!(
				"sqlite.backup_recovery_fence_controller.command_timeout_ms must be between 1 and {MAX_BACKUP_FENCE_COMMAND_TIMEOUT_MS}"
			);
		}
		if self.leadership_lease_ms < self.poll_interval_ms.saturating_mul(2)
			|| self.leadership_lease_ms > MAX_BACKUP_FENCE_LEASE_VALIDITY_MS
		{
			bail!(
				"sqlite.backup_recovery_fence_controller.leadership_lease_ms must be between two poll intervals and {MAX_BACKUP_FENCE_LEASE_VALIDITY_MS}"
			);
		}
		let minimum_safe_lease_ms = self
			.poll_interval_ms
			.checked_add(self.command_timeout_ms)
			.and_then(|renewal_ms| renewal_ms.checked_mul(2))
			.ok_or_else(|| anyhow::anyhow!("backup fence timing configuration overflow"))?;
		if self.lease_validity_ms < minimum_safe_lease_ms {
			bail!(
				"sqlite.backup_recovery_fence_controller.lease_validity_ms must cover at least two poll plus command-timeout intervals ({minimum_safe_lease_ms} ms)"
			);
		}
		if self.max_backup_generations == 0 || self.max_backup_generations > MAX_BACKUP_GENERATIONS
		{
			bail!(
				"sqlite.backup_recovery_fence_controller.max_backup_generations must be between 1 and {MAX_BACKUP_GENERATIONS}"
			);
		}
		if self
			.blob_credentials
			.iter()
			.any(|credential| credential.trim().is_empty())
		{
			bail!(
				"sqlite.backup_recovery_fence_controller.blob_credentials entries must not be empty"
			);
		}
		if self
			.tls_ca_file
			.as_deref()
			.is_some_and(|path| path.trim().is_empty())
		{
			bail!("sqlite.backup_recovery_fence_controller.tls_ca_file must not be empty");
		}
		Ok(())
	}
}

#[derive(Debug, Serialize, Deserialize, Clone, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SqliteWorkflowColdStorage {
	FileSystem(SqliteWorkflowColdStorageFileSystem),
	S3(SqliteWorkflowColdStorageS3),
}

impl SqliteWorkflowColdStorage {
	pub fn recovery_window_ms(&self) -> u64 {
		match self {
			Self::FileSystem(config) => config.recovery_window_ms,
			Self::S3(config) => config.recovery_window_ms,
		}
	}

	fn validate(&self) -> Result<()> {
		let (
			max_object_size_bytes,
			max_concurrent_requests,
			max_queued_requests,
			queue_timeout_ms,
			recovery_window_ms,
		) = match self {
			SqliteWorkflowColdStorage::FileSystem(config) => {
				if config.root.trim().is_empty() {
					bail!("sqlite.workflow_cold_storage.file_system.root must not be empty");
				}
				(
					config.max_object_size_bytes,
					config.max_concurrent_requests,
					config.max_queued_requests,
					config.queue_timeout_ms,
					config.recovery_window_ms,
				)
			}
			SqliteWorkflowColdStorage::S3(config) => {
				if config.bucket.trim().is_empty() {
					bail!("sqlite.workflow_cold_storage.s3.bucket must not be empty");
				}
				if config.region.trim().is_empty() {
					bail!("sqlite.workflow_cold_storage.s3.region must not be empty");
				}
				(
					config.max_object_size_bytes,
					config.max_concurrent_requests,
					config.max_queued_requests,
					config.queue_timeout_ms,
					config.recovery_window_ms,
				)
			}
		};

		if max_object_size_bytes == 0 {
			bail!("sqlite.workflow_cold_storage.max_object_size_bytes must be positive");
		}
		if max_object_size_bytes > MAX_COLD_OBJECT_SIZE_BYTES {
			bail!(
				"sqlite.workflow_cold_storage.max_object_size_bytes must not exceed {MAX_COLD_OBJECT_SIZE_BYTES}"
			);
		}
		if max_concurrent_requests == 0 {
			bail!("sqlite.workflow_cold_storage.max_concurrent_requests must be positive");
		}
		if max_concurrent_requests > MAX_COLD_CONCURRENT_REQUESTS {
			bail!(
				"sqlite.workflow_cold_storage.max_concurrent_requests must not exceed {MAX_COLD_CONCURRENT_REQUESTS}"
			);
		}
		if max_queued_requests > MAX_COLD_QUEUED_REQUESTS {
			bail!(
				"sqlite.workflow_cold_storage.max_queued_requests must not exceed {MAX_COLD_QUEUED_REQUESTS}"
			);
		}
		if queue_timeout_ms == 0 || queue_timeout_ms > MAX_COLD_QUEUE_TIMEOUT_MS {
			bail!(
				"sqlite.workflow_cold_storage.queue_timeout_ms must be between 1 and {MAX_COLD_QUEUE_TIMEOUT_MS}"
			);
		}
		if !(MIN_COLD_RECOVERY_WINDOW_MS..=MAX_COLD_RECOVERY_WINDOW_MS)
			.contains(&recovery_window_ms)
		{
			bail!(
				"sqlite.workflow_cold_storage.recovery_window_ms must be between {MIN_COLD_RECOVERY_WINDOW_MS} and {MAX_COLD_RECOVERY_WINDOW_MS}"
			);
		}

		Ok(())
	}
}

#[derive(Debug, Serialize, Deserialize, Clone, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SqliteWorkflowColdStorageFileSystem {
	pub root: String,
	/// Minimum time superseded objects remain recoverable for FDB backup/PITR restores.
	#[serde(default = "default_cold_recovery_window_ms")]
	pub recovery_window_ms: u64,
	#[serde(default = "default_cold_max_object_size_bytes")]
	pub max_object_size_bytes: u64,
	#[serde(default = "default_cold_max_concurrent_requests")]
	pub max_concurrent_requests: usize,
	/// Maximum requests allowed to wait behind the active cold-storage requests. Once full, Depot
	/// fails before issuing object-store I/O instead of accumulating an unbounded recovery storm.
	#[serde(default = "default_cold_max_queued_requests")]
	pub max_queued_requests: usize,
	/// Maximum queue wait before a cold request is rejected as retryable overload.
	#[serde(default = "default_cold_queue_timeout_ms")]
	pub queue_timeout_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SqliteWorkflowColdStorageS3 {
	pub bucket: String,
	#[serde(default)]
	pub endpoint: Option<String>,
	#[serde(default = "default_s3_region")]
	pub region: String,
	#[serde(default)]
	pub addressing_style: SqliteWorkflowColdStorageS3AddressingStyle,
	/// Minimum time superseded objects remain recoverable for FDB backup/PITR restores.
	#[serde(default = "default_cold_recovery_window_ms")]
	pub recovery_window_ms: u64,
	#[serde(default = "default_cold_max_object_size_bytes")]
	pub max_object_size_bytes: u64,
	#[serde(default = "default_cold_max_concurrent_requests")]
	pub max_concurrent_requests: usize,
	/// Maximum requests allowed to wait behind the active cold-storage requests.
	#[serde(default = "default_cold_max_queued_requests")]
	pub max_queued_requests: usize,
	/// Maximum queue wait before a cold request is rejected as retryable overload.
	#[serde(default = "default_cold_queue_timeout_ms")]
	pub queue_timeout_ms: u64,
}

#[derive(Debug, Default, Serialize, Deserialize, Clone, Copy, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SqliteWorkflowColdStorageS3AddressingStyle {
	#[default]
	VirtualHosted,
	Path,
}
