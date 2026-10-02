pub(crate) use std::collections::{BTreeMap, BTreeSet};

pub(crate) use anyhow::{Context, Result, bail, ensure};
pub(crate) use futures_util::{FutureExt, StreamExt, TryStreamExt};
pub(crate) use gas::prelude::*;
pub(crate) use serde::{Deserialize, Serialize};
pub(crate) use sha2::{Digest, Sha256};
pub(crate) use universaldb::{
	RangeOption,
	options::StreamingMode,
	utils::{
		IsolationLevel::{Serializable, Snapshot},
		end_of_key_range, end_of_prefix_range,
	},
};

pub(crate) use crate::{
	ACCESS_TOUCH_THROTTLE_MS, CMP_COLD_DELETE_MAX_OBJECTS, CMP_COLD_MAX_SHARDS_PER_JOB,
	CMP_COLD_OBJECT_MAX_BYTES, CMP_FDB_BATCH_MAX_KEYS, CMP_FDB_BATCH_MAX_VALUE_BYTES,
	CMP_RECLAIM_CONTROL_MAX_ITEMS_PER_LANE, CMP_RECLAIM_FDB_BATCH_MAX_KEYS,
	MAX_DELTA_CHUNKS_PER_COMMIT,
	cold_tier::{ColdTier, cold_tier_from_config, materialize_cold_shard},
	conveyer::{
		history_pin, keys,
		ltx::{DecodedLtx, LtxHeader, decode_ltx_v3, encode_ltx_v3},
		policy, quota,
		types::{
			BranchState, BucketCatalogDbFact, BucketForkFact, ColdPublishMarker, ColdShardRef,
			ColdUploadIntent, CommitRow, CompactionRoot, DBHead, DatabaseBranchId,
			DatabaseBranchRecord, DirtyPage, HotGenerationManifest, HotGenerationShardRef,
			HotPublishMarker, HotShardCoverage, HotShardStageProof, HotStageJobRecord,
			PitrIntervalCoverage, PitrPolicy, RetiredColdObject, RetiredColdObjectDeleteState,
			ShardCachePolicy, SqliteCmpDirty, decode_bucket_catalog_db_fact,
			decode_bucket_fork_fact, decode_cold_publish_marker, decode_cold_shard_ref,
			decode_cold_upload_intent, decode_commit_row, decode_compaction_root,
			decode_database_branch_record, decode_database_policy_binding, decode_db_head,
			decode_hot_generation_manifest, decode_hot_publish_marker,
			decode_hot_shard_stage_proof, decode_hot_stage_job_record,
			decode_pitr_interval_coverage, decode_pitr_policy, decode_retired_cold_object,
			decode_sqlite_cmp_dirty, encode_cold_publish_marker, encode_cold_shard_ref,
			encode_cold_upload_intent, encode_compaction_root, encode_hot_generation_manifest,
			encode_hot_publish_marker, encode_hot_shard_coverage, encode_hot_shard_stage_proof,
			encode_hot_stage_job_record, encode_retired_cold_object,
		},
		udb,
	},
};

pub const DATABASE_BRANCH_ID_TAG: &str = "database_branch_id";

pub type CompactionInputFingerprint = [u8; 32];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DbManagerInput {
	pub database_branch_id: DatabaseBranchId,
	#[serde(default)]
	pub actor_id: Option<String>,
	#[cfg(feature = "test-faults")]
	#[serde(default)]
	pub disable_planning_timers: bool,
}

impl DbManagerInput {
	pub fn new(database_branch_id: DatabaseBranchId, actor_id: Option<String>) -> Self {
		DbManagerInput {
			database_branch_id,
			actor_id,
			#[cfg(feature = "test-faults")]
			disable_planning_timers: false,
		}
	}

	#[cfg(feature = "test-faults")]
	pub fn with_planning_timers_disabled(
		database_branch_id: DatabaseBranchId,
		actor_id: Option<String>,
	) -> Self {
		DbManagerInput {
			database_branch_id,
			actor_id,
			disable_planning_timers: true,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DbHotCompacterInput {
	pub database_branch_id: DatabaseBranchId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DbColdCompacterInput {
	pub database_branch_id: DatabaseBranchId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DbReclaimerInput {
	pub database_branch_id: DatabaseBranchId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CompactionJobKind {
	Hot,
	Cold,
	Reclaim,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompactionJobStatus {
	Requested,
	Succeeded,
	/// The job's optimistic plan became stale before execution. The manager must refresh and may
	/// retry it; this is distinct from a permanently invalid request or an execution failure.
	Retryable {
		reason: String,
	},
	Rejected {
		reason: String,
	},
	Failed {
		error: String,
	},
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TxidRange {
	pub min_txid: u64,
	pub max_txid: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HotJobInputRange {
	pub txids: TxidRange,
	pub coverage_txids: Vec<u64>,
	pub max_pages: u32,
	pub max_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ColdJobInputRange {
	pub txids: TxidRange,
	pub min_versionstamp: [u8; 16],
	pub max_versionstamp: [u8; 16],
	pub input_summary: ColdInputSummary,
	pub max_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ColdShardInputRef {
	pub shard_id: u32,
	pub as_of_txid: u64,
	pub size_bytes: u64,
	pub content_hash: [u8; 32],
}

/// Compact proof of the exact ordered hot-shard inputs selected for one cold pass. Upload
/// activities reconstruct the bounded list from the immutable hot generation in FDB instead of
/// copying every ref through manager state, signals, and activity history.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ColdInputSummary {
	pub input_ref_count: u32,
	pub input_refs_hash: [u8; 32],
}

/// Compact proof of the exact ordered set of cold refs staged in FDB. Keeping this in workflow
/// history instead of the refs themselves prevents large databases from exhausting signal limits.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ColdStageSummary {
	pub output_ref_count: u32,
	pub output_refs_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ReclaimJobInputRange {
	pub txids: TxidRange,
	pub txid_refs: Vec<ReclaimTxidRef>,
	#[serde(default)]
	pub cold_objects: Vec<ReclaimColdObjectRef>,
	#[serde(default)]
	pub retired_cold_objects: Vec<RetiredColdObject>,
	#[serde(default)]
	pub hot_shard_evictions: Vec<HotShardEvictionRef>,
	#[serde(default)]
	pub orphan_cold_upload_job_id: Option<Id>,
	pub staged_hot_shards: Vec<StagedHotShardCleanupRef>,
	pub max_keys: u32,
	pub max_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ReclaimTxidRef {
	pub txid: u64,
	pub versionstamp: [u8; 16],
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ReclaimColdObjectRef {
	pub object_key: String,
	pub object_generation_id: Id,
	pub content_hash: [u8; 32],
	pub size_bytes: u64,
	pub publish_generation: u64,
	pub shard_id: u32,
	pub as_of_txid: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HotShardEvictionRef {
	pub shard_id: u32,
	pub as_of_txid: u64,
	pub size_bytes: u64,
	pub content_hash: [u8; 32],
	#[serde(default)]
	pub cold_proof_as_of_txid: Option<u64>,
	pub cold_ref_content_hash: [u8; 32],
	pub cold_publish_generation: u64,
}

impl HotShardEvictionRef {
	pub fn cold_proof_as_of_txid(&self) -> u64 {
		self.cold_proof_as_of_txid.unwrap_or(self.as_of_txid)
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct StagedHotShardCleanupRef {
	pub job_id: Id,
	pub output_ref: HotShardOutputRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HotShardOutputRef {
	pub shard_id: u32,
	pub as_of_txid: u64,
	pub min_txid: u64,
	pub max_txid: u64,
	pub size_bytes: u64,
	pub content_hash: [u8; 32],
}

/// Compact proof of the exact ordered staged hot rows. Large ref vectors stay in FDB instead of
/// Gasoline activity output, signal payloads, and manager workflow history.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HotStageSummary {
	pub staged_row_count: u32,
	pub staged_rows_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReclaimOutputRef {
	pub key_count: u32,
	pub byte_count: u64,
	pub min_txid: u64,
	pub max_txid: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[signal("depot_sqlite_cmp_deltas_available")]
pub struct DeltasAvailable {
	pub database_branch_id: DatabaseBranchId,
	pub observed_head_txid: u64,
	pub dirty_updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[signal("depot_sqlite_cmp_hot_job_finished")]
pub struct HotJobFinished {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub job_kind: CompactionJobKind,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub status: CompactionJobStatus,
	pub output_summary: HotStageSummary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[signal("depot_sqlite_cmp_cold_job_finished")]
pub struct ColdJobFinished {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub job_kind: CompactionJobKind,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub status: CompactionJobStatus,
	pub output_summary: ColdStageSummary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[signal("depot_sqlite_cmp_reclaim_job_finished")]
pub struct ReclaimJobFinished {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub job_kind: CompactionJobKind,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub status: CompactionJobStatus,
	pub output_refs: Vec<ReclaimOutputRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[signal("depot_sqlite_cmp_force_compaction")]
pub struct ForceCompaction {
	pub database_branch_id: DatabaseBranchId,
	pub request_id: Id,
	pub requested_work: ForceCompactionWork,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[signal("depot_sqlite_cmp_destroy_database_branch")]
pub struct DestroyDatabaseBranch {
	pub database_branch_id: DatabaseBranchId,
	pub lifecycle_generation: u64,
	pub requested_at_ms: i64,
	pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[signal("depot_sqlite_cmp_run_hot_job")]
pub struct RunHotJob {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub job_kind: CompactionJobKind,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub status: CompactionJobStatus,
	pub input_range: HotJobInputRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[signal("depot_sqlite_cmp_run_cold_job")]
pub struct RunColdJob {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub job_kind: CompactionJobKind,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub status: CompactionJobStatus,
	pub input_range: ColdJobInputRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[signal("depot_sqlite_cmp_run_reclaim_job")]
pub struct RunReclaimJob {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub job_kind: CompactionJobKind,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub status: CompactionJobStatus,
	pub input_range: ReclaimJobInputRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DbManagerState {
	pub companion_workflow_ids: CompanionWorkflowIds,
	pub active_jobs: ManagerActiveJobs,
	#[serde(default)]
	pub force_compactions: ForceCompactionTracker,
	pub retry_cursors: ManagerRetryCursors,
	#[serde(default)]
	pub next_cold_check_at_ms: Option<i64>,
	#[serde(default)]
	pub next_reclaim_check_at_ms: Option<i64>,
	pub branch_stop_state: BranchStopState,
	pub last_dirty_cursor: Option<DirtyCursor>,
	#[serde(default)]
	pub last_observed_branch_lifecycle_generation: Option<u64>,
}

impl DbManagerState {
	pub fn new(companion_workflow_ids: CompanionWorkflowIds) -> Self {
		DbManagerState {
			companion_workflow_ids,
			active_jobs: ManagerActiveJobs::default(),
			force_compactions: ForceCompactionTracker::default(),
			retry_cursors: ManagerRetryCursors::default(),
			next_cold_check_at_ms: None,
			next_reclaim_check_at_ms: None,
			branch_stop_state: BranchStopState::Running,
			last_dirty_cursor: None,
			last_observed_branch_lifecycle_generation: None,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ManagerActiveJobs {
	pub hot: Option<ActiveHotCompactionJob>,
	pub cold: Option<ActiveColdCompactionJob>,
	pub reclaim: Option<ActiveReclaimCompactionJob>,
}

impl ManagerActiveJobs {
	pub(crate) fn clear(&mut self) {
		*self = Self::default();
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub struct ForceCompactionWork {
	pub hot: bool,
	pub cold: bool,
	pub reclaim: bool,
	pub final_settle: bool,
}

impl ForceCompactionWork {
	pub(crate) fn is_empty(self) -> bool {
		!self.hot && !self.cold && !self.reclaim && !self.final_settle
	}

	pub(crate) fn includes(self, job_kind: CompactionJobKind) -> bool {
		match job_kind {
			CompactionJobKind::Hot => self.hot,
			CompactionJobKind::Cold => self.cold,
			CompactionJobKind::Reclaim => self.reclaim,
		}
	}

	pub(crate) fn union(self, other: Self) -> Self {
		ForceCompactionWork {
			hot: self.hot || other.hot,
			cold: self.cold || other.cold,
			reclaim: self.reclaim || other.reclaim,
			final_settle: self.final_settle || other.final_settle,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForceCompactionTracker {
	pub pending_requests: Vec<PendingForceCompaction>,
	pub recent_results: Vec<ForceCompactionResult>,
}

impl Default for ForceCompactionTracker {
	fn default() -> Self {
		ForceCompactionTracker {
			pending_requests: Vec::new(),
			recent_results: Vec::new(),
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingForceCompaction {
	pub request_id: Id,
	pub requested_work: ForceCompactionWork,
	pub attempted_job_kinds: Vec<CompactionJobKind>,
	pub completed_job_ids: Vec<Id>,
	pub skipped_noop_reasons: Vec<String>,
	#[serde(default)]
	pub retryable_rejections: u32,
	#[serde(default)]
	pub consecutive_retryable_rejections: u32,
	pub terminal_error: Option<String>,
	pub requested_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForceCompactionResult {
	pub request_id: Id,
	pub requested_work: ForceCompactionWork,
	pub attempted_job_kinds: Vec<CompactionJobKind>,
	pub completed_job_ids: Vec<Id>,
	pub skipped_noop_reasons: Vec<String>,
	#[serde(default)]
	pub retryable_rejections: u32,
	pub terminal_error: Option<String>,
	pub completed_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompanionWorkflowIds {
	pub hot_compacter_workflow_id: Id,
	pub cold_compacter_workflow_id: Id,
	pub reclaimer_workflow_id: Id,
}

impl CompanionWorkflowIds {
	pub fn new(
		hot_compacter_workflow_id: Id,
		cold_compacter_workflow_id: Id,
		reclaimer_workflow_id: Id,
	) -> Self {
		CompanionWorkflowIds {
			hot_compacter_workflow_id,
			cold_compacter_workflow_id,
			reclaimer_workflow_id,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlannedHotCompactionJob {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub input_range: HotJobInputRange,
	pub planned_at_ms: i64,
	pub attempt: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlannedColdCompactionJob {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub input_range: ColdJobInputRange,
	pub planned_at_ms: i64,
	pub attempt: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlannedReclaimCompactionJob {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub input_range: ReclaimJobInputRange,
	pub planned_at_ms: i64,
	pub attempt: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveHotCompactionJob {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub input_range: HotJobInputRange,
	pub planned_at_ms: i64,
	pub attempt: u32,
}

impl ActiveHotCompactionJob {
	pub(crate) fn from_planned(planned_job: PlannedHotCompactionJob) -> Self {
		ActiveHotCompactionJob {
			database_branch_id: planned_job.database_branch_id,
			job_id: planned_job.job_id,
			base_lifecycle_generation: planned_job.base_lifecycle_generation,
			base_manifest_generation: planned_job.base_manifest_generation,
			input_fingerprint: planned_job.input_fingerprint,
			input_range: planned_job.input_range,
			planned_at_ms: planned_job.planned_at_ms,
			attempt: planned_job.attempt,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveColdCompactionJob {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub input_range: ColdJobInputRange,
	pub planned_at_ms: i64,
	pub attempt: u32,
}

impl ActiveColdCompactionJob {
	pub(crate) fn from_planned(planned_job: PlannedColdCompactionJob) -> Self {
		ActiveColdCompactionJob {
			database_branch_id: planned_job.database_branch_id,
			job_id: planned_job.job_id,
			base_lifecycle_generation: planned_job.base_lifecycle_generation,
			base_manifest_generation: planned_job.base_manifest_generation,
			input_fingerprint: planned_job.input_fingerprint,
			input_range: planned_job.input_range,
			planned_at_ms: planned_job.planned_at_ms,
			attempt: planned_job.attempt,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveReclaimCompactionJob {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub input_range: ReclaimJobInputRange,
	pub planned_at_ms: i64,
	pub attempt: u32,
}

impl ActiveReclaimCompactionJob {
	pub(crate) fn from_planned(planned_job: PlannedReclaimCompactionJob) -> Self {
		ActiveReclaimCompactionJob {
			database_branch_id: planned_job.database_branch_id,
			job_id: planned_job.job_id,
			base_lifecycle_generation: planned_job.base_lifecycle_generation,
			base_manifest_generation: planned_job.base_manifest_generation,
			input_fingerprint: planned_job.input_fingerprint,
			input_range: planned_job.input_range,
			planned_at_ms: planned_job.planned_at_ms,
			attempt: planned_job.attempt,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagerRetryCursors {
	pub hot: RetryCursor,
	pub cold: RetryCursor,
	pub reclaim: RetryCursor,
}

impl Default for ManagerRetryCursors {
	fn default() -> Self {
		ManagerRetryCursors {
			hot: RetryCursor::default(),
			cold: RetryCursor::default(),
			reclaim: RetryCursor::default(),
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetryCursor {
	pub attempt: u32,
	pub next_attempt_at_ms: Option<i64>,
	pub last_error: Option<String>,
}

impl Default for RetryCursor {
	fn default() -> Self {
		RetryCursor {
			attempt: 0,
			next_attempt_at_ms: None,
			last_error: None,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BranchStopState {
	Running,
	StopRequested {
		lifecycle_generation: u64,
		requested_at_ms: i64,
		reason: ManagerStopReason,
	},
	Stopped {
		stopped_at_ms: i64,
	},
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ManagerStopReason {
	ExplicitDestroy { reason: String },
	BranchNotLive,
}

impl ManagerStopReason {
	pub(crate) fn companion_reason(&self) -> String {
		match self {
			ManagerStopReason::ExplicitDestroy { reason } => reason.clone(),
			ManagerStopReason::BranchNotLive => "database branch is not live".to_string(),
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ManagerStopRequest {
	pub database_branch_id: DatabaseBranchId,
	pub lifecycle_generation: u64,
	pub requested_at_ms: i64,
	pub reason: ManagerStopReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirtyCursor {
	pub observed_head_txid: u64,
	pub dirty_updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompanionWorkflowState {
	Idle,
	Running(CompanionRunningJob),
	Stopping {
		active_job: Option<CompanionRunningJob>,
		lifecycle_generation: u64,
		requested_at_ms: i64,
		reason: String,
	},
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompanionRunningJob {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub job_kind: CompactionJobKind,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub started_at_ms: i64,
	pub attempt: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct StageHotJobInput {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub job_kind: CompactionJobKind,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub input_range: HotJobInputRange,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageHotJobOutput {
	pub status: CompactionJobStatus,
	pub output_summary: HotStageSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct InstallHotJobInput {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub job_kind: CompactionJobKind,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub input_range: HotJobInputRange,
	pub output_summary: HotStageSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallHotJobOutput {
	pub status: CompactionJobStatus,
	pub output_summary: HotStageSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct CleanupStagedHotJobInput {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub output_summary: HotStageSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupStagedHotJobOutput {
	pub status: CompactionJobStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct UploadColdJobInput {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub job_kind: CompactionJobKind,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub input_range: ColdJobInputRange,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadColdJobOutput {
	pub status: CompactionJobStatus,
	pub output_summary: ColdStageSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct CleanupColdUploadJobInput {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupColdUploadJobOutput {
	pub status: CompactionJobStatus,
	pub deleted_object_count: u32,
	pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct PublishColdJobInput {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub job_kind: CompactionJobKind,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub input_range: ColdJobInputRange,
	pub output_summary: ColdStageSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishColdJobOutput {
	pub status: CompactionJobStatus,
	pub output_summary: ColdStageSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct ReclaimFdbJobInput {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub job_kind: CompactionJobKind,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub input_fingerprint: CompactionInputFingerprint,
	pub input_range: ReclaimJobInputRange,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReclaimFdbJobOutput {
	pub status: CompactionJobStatus,
	pub output_refs: Vec<ReclaimOutputRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct RetireColdObjectsInput {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub job_kind: CompactionJobKind,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub cold_objects: Vec<ReclaimColdObjectRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetireColdObjectsOutput {
	pub status: CompactionJobStatus,
	pub retired_object_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct DeleteRetiredColdObjectsInput {
	pub database_branch_id: DatabaseBranchId,
	pub retired_objects: Vec<RetiredColdObject>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteRetiredColdObjectsOutput {
	pub status: CompactionJobStatus,
	pub deleted_object_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct RefreshManagerInput {
	pub database_branch_id: DatabaseBranchId,
	pub force: ForceCompactionWork,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshManagerOutput {
	#[serde(default)]
	pub refreshed_at_ms: i64,
	pub planned_hot_job: Option<PlannedHotCompactionJob>,
	pub planned_cold_job: Option<PlannedColdCompactionJob>,
	pub planned_reclaim_job: Option<PlannedReclaimCompactionJob>,
	pub observed_dirty: Option<SqliteCmpDirty>,
	pub head_txid: Option<u64>,
	pub branch_is_live: bool,
	pub branch_lifecycle_generation: Option<u64>,
	pub db_pin_count: usize,
	#[serde(default)]
	pub reclaim_noop_reason: Option<String>,
	/// Earliest known wall-clock transition which can make reclaim actionable without a new write.
	#[serde(default)]
	pub next_reclaim_at_ms: Option<i64>,
	/// Distinguishes a newly observed `None` deadline from an older serialized activity output
	/// which predates `next_reclaim_at_ms`. Unknown histories retain their fallback timers.
	#[serde(default)]
	pub maintenance_deadline_observed: bool,
}

impl ForceCompactionTracker {
	const MAX_CONSECUTIVE_RETRYABLE_REJECTIONS: u32 = 8;

	pub(crate) fn record_request(
		&mut self,
		signal: ForceCompaction,
		requested_at_ms: i64,
		active_jobs: &ManagerActiveJobs,
	) {
		if signal.requested_work.is_empty()
			|| self
				.pending_requests
				.iter()
				.any(|request| request.request_id == signal.request_id)
			|| self
				.recent_results
				.iter()
				.any(|result| result.request_id == signal.request_id)
		{
			return;
		}

		let mut request = PendingForceCompaction {
			request_id: signal.request_id,
			requested_work: signal.requested_work,
			attempted_job_kinds: Vec::new(),
			completed_job_ids: Vec::new(),
			skipped_noop_reasons: Vec::new(),
			retryable_rejections: 0,
			consecutive_retryable_rejections: 0,
			terminal_error: None,
			requested_at_ms,
		};
		for job_kind in active_jobs.matching_job_kinds(signal.requested_work) {
			Self::push_unique_job_kind(&mut request.attempted_job_kinds, job_kind);
		}
		self.pending_requests.push(request);
	}

	pub(crate) fn pending_work(&self) -> ForceCompactionWork {
		self.pending_requests
			.iter()
			.filter(|request| request.terminal_error.is_none())
			.fold(ForceCompactionWork::default(), |acc, request| {
				acc.union(request.requested_work)
			})
	}

	pub(crate) fn record_job_attempted(&mut self, job_kind: CompactionJobKind) {
		for request in &mut self.pending_requests {
			if request.requested_work.includes(job_kind) {
				Self::push_unique_job_kind(&mut request.attempted_job_kinds, job_kind);
			}
		}
	}

	pub(crate) fn record_job_finished(
		&mut self,
		job_kind: CompactionJobKind,
		job_id: Id,
		status: &CompactionJobStatus,
	) {
		for request in &mut self.pending_requests {
			if request.requested_work.includes(job_kind) {
				Self::push_unique_job_kind(&mut request.attempted_job_kinds, job_kind);
				Self::push_unique_id(&mut request.completed_job_ids, job_id);
				match status {
					CompactionJobStatus::Retryable { reason } => {
						request.retryable_rejections =
							request.retryable_rejections.saturating_add(1);
						request.consecutive_retryable_rejections =
							request.consecutive_retryable_rejections.saturating_add(1);
						if request.consecutive_retryable_rejections
							> Self::MAX_CONSECUTIVE_RETRYABLE_REJECTIONS
						{
							request.terminal_error = Some(format!(
								"compaction plan remained stale after {} retries: {reason}",
								Self::MAX_CONSECUTIVE_RETRYABLE_REJECTIONS
							));
						}
					}
					CompactionJobStatus::Rejected { reason } => {
						request.terminal_error = Some(reason.clone());
					}
					CompactionJobStatus::Failed { error } => {
						request.terminal_error = Some(error.clone());
					}
					CompactionJobStatus::Succeeded => {
						request.consecutive_retryable_rejections = 0;
					}
					CompactionJobStatus::Requested => {}
				}
			}
		}
	}

	pub(crate) fn complete_ready_requests(
		&mut self,
		active_jobs: &ManagerActiveJobs,
		refresh: &RefreshManagerOutput,
		completed_at_ms: i64,
	) {
		let mut remaining_requests = Vec::new();
		let pending_requests = std::mem::take(&mut self.pending_requests);
		for mut request in pending_requests {
			if Self::request_has_active_work(active_jobs, request.requested_work) {
				remaining_requests.push(request);
				continue;
			}

			if request.terminal_error.is_none()
				&& Self::request_has_planned_work(refresh, request.requested_work)
			{
				remaining_requests.push(request);
				continue;
			}

			request
				.skipped_noop_reasons
				.extend(Self::noop_reasons(&request, refresh));
			self.recent_results.push(ForceCompactionResult {
				request_id: request.request_id,
				requested_work: request.requested_work,
				attempted_job_kinds: request.attempted_job_kinds,
				completed_job_ids: request.completed_job_ids,
				skipped_noop_reasons: request.skipped_noop_reasons,
				retryable_rejections: request.retryable_rejections,
				terminal_error: request.terminal_error,
				completed_at_ms,
			});
			if self.recent_results.len() > 16 {
				self.recent_results.remove(0);
			}
		}
		self.pending_requests = remaining_requests;
	}

	fn request_has_active_work(
		active_jobs: &ManagerActiveJobs,
		requested_work: ForceCompactionWork,
	) -> bool {
		(requested_work.hot && active_jobs.hot.is_some())
			|| (requested_work.cold && active_jobs.cold.is_some())
			|| (requested_work.reclaim && active_jobs.reclaim.is_some())
	}

	fn request_has_planned_work(
		refresh: &RefreshManagerOutput,
		requested_work: ForceCompactionWork,
	) -> bool {
		(requested_work.hot && refresh.planned_hot_job.is_some())
			|| (requested_work.cold && refresh.planned_cold_job.is_some())
			|| (requested_work.reclaim && refresh.planned_reclaim_job.is_some())
	}

	fn noop_reasons(
		request: &PendingForceCompaction,
		refresh: &RefreshManagerOutput,
	) -> Vec<String> {
		let mut reasons = Vec::new();
		if !refresh.branch_is_live {
			reasons.push("branch:not-live".to_string());
			return reasons;
		}
		if request.requested_work.hot
			&& !request
				.attempted_job_kinds
				.contains(&CompactionJobKind::Hot)
		{
			reasons.push("hot:no-actionable-lag".to_string());
		}
		if request.requested_work.cold
			&& !request
				.attempted_job_kinds
				.contains(&CompactionJobKind::Cold)
		{
			reasons.push("cold:no-actionable-lag".to_string());
		}
		if request.requested_work.reclaim
			&& !request
				.attempted_job_kinds
				.contains(&CompactionJobKind::Reclaim)
		{
			reasons.push(
				refresh
					.reclaim_noop_reason
					.clone()
					.unwrap_or_else(|| "reclaim:no-actionable-work".to_string()),
			);
		}
		if request.requested_work.final_settle {
			reasons.push("final-settle:refreshed".to_string());
		}
		reasons
	}

	fn push_unique_job_kind(job_kinds: &mut Vec<CompactionJobKind>, job_kind: CompactionJobKind) {
		if !job_kinds.contains(&job_kind) {
			job_kinds.push(job_kind);
		}
	}

	fn push_unique_id(ids: &mut Vec<Id>, id: Id) {
		if !ids.contains(&id) {
			ids.push(id);
		}
	}
}

impl ManagerActiveJobs {
	fn matching_job_kinds(&self, requested_work: ForceCompactionWork) -> Vec<CompactionJobKind> {
		let mut job_kinds = Vec::new();
		if requested_work.hot && self.hot.is_some() {
			job_kinds.push(CompactionJobKind::Hot);
		}
		if requested_work.cold && self.cold.is_some() {
			job_kinds.push(CompactionJobKind::Cold);
		}
		if requested_work.reclaim && self.reclaim.is_some() {
			job_kinds.push(CompactionJobKind::Reclaim);
		}
		job_kinds
	}
}

#[derive(Debug)]
pub(crate) struct ManagerFdbSnapshot {
	pub(crate) cold_storage_enabled: bool,
	pub(crate) branch_record: Option<DatabaseBranchRecord>,
	pub(crate) head: Option<DBHead>,
	pub(crate) root: CompactionRoot,
	pub(crate) dirty: Option<SqliteCmpDirty>,
	pub(crate) db_pin_count: usize,
	pub(crate) hot_inputs: HotInputSnapshot,
	pub(crate) cold_inputs: ColdInputSnapshot,
	pub(crate) reclaim_inputs: ReclaimInputSnapshot,
	pub(crate) orphan_cold_upload_job_id: Option<Id>,
	pub(crate) bucket_proof_blocked_reclaim: bool,
	pub(crate) cleared_dirty: bool,
	pub(crate) cleared_staged_hot_job: bool,
}

#[derive(Debug, Default)]
pub(crate) struct HotInputSnapshot {
	pub(crate) commits: Vec<(u64, CommitRow)>,
	pub(crate) pitr_interval_coverage: Vec<PitrIntervalSelection>,
	pub(crate) delta_chunks: Vec<(Vec<u8>, Vec<u8>)>,
	pub(crate) pidx_entries: Vec<(Vec<u8>, Vec<u8>)>,
	pub(crate) total_value_bytes: u64,
	pub(crate) selected_max_txid: Option<u64>,
	pub(crate) history_pin_txids: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PitrIntervalSelection {
	pub(crate) bucket_start_ms: i64,
	pub(crate) coverage: PitrIntervalCoverage,
}

#[derive(Debug, Default)]
pub(crate) struct ColdInputSnapshot {
	/// Compact immutable hot-shard identities only. The manager must not expand complete shard
	/// bodies in its long-lived FDB planning transaction.
	pub(crate) shard_inputs: Vec<ColdShardInputRef>,
	pub(crate) total_value_bytes: u64,
	pub(crate) min_versionstamp: [u8; 16],
	pub(crate) max_versionstamp: [u8; 16],
	pub(crate) selected_min_txid: Option<u64>,
	pub(crate) selected_max_txid: Option<u64>,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedHotShard {
	pub(crate) shard_id: u32,
	pub(crate) as_of_txid: u64,
	pub(crate) page_updates: Vec<(u32, Vec<u8>)>,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedHotShardOutput {
	pub(crate) output_ref: HotShardOutputRef,
	pub(crate) stage_key: Vec<u8>,
	pub(crate) stage_proof: Vec<u8>,
	pub(crate) blob: Vec<u8>,
}

#[derive(Debug)]
pub(crate) struct StagedHotShardBatch {
	pub(crate) output_refs: Vec<HotShardOutputRef>,
	pub(crate) rows: Vec<(Vec<u8>, Vec<u8>)>,
}

#[derive(Debug, Default)]
pub(crate) struct ReclaimInputSnapshot {
	pub(crate) txid_refs: Vec<ReclaimTxidRef>,
	pub(crate) cold_object_refs: Vec<ReclaimColdObjectRef>,
	pub(crate) retired_cold_objects: Vec<RetiredColdObject>,
	pub(crate) hot_shard_evictions: Vec<HotShardEvictionCandidate>,
	pub(crate) expired_pitr_interval_rows: Vec<(i64, Vec<u8>, Vec<u8>, PitrIntervalCoverage)>,
	pub(crate) expired_pitr_interval_index_keys: Vec<Vec<u8>>,
	pub(crate) pitr_proof_complete: bool,
	pub(crate) commits: Vec<(u64, Vec<u8>, Vec<u8>, CommitRow)>,
	pub(crate) delta_chunks: Vec<(Vec<u8>, Vec<u8>)>,
	pub(crate) page_history_entries: Vec<(u64, Vec<u8>, Vec<u8>)>,
	pub(crate) pidx_entries: Vec<(Vec<u8>, Vec<u8>)>,
	pub(crate) coverage_shards: Vec<(Vec<u8>, Vec<u8>)>,
	pub(crate) required_coverage_shard_count: usize,
	pub(crate) total_value_bytes: u64,
	pub(crate) next_reclaim_at_ms: Option<i64>,
}

#[derive(Debug, Clone)]
pub(crate) struct HotShardEvictionCandidate {
	pub(crate) reference: HotShardEvictionRef,
	pub(crate) shard_key: Vec<u8>,
	pub(crate) shard_row_value: Vec<u8>,
	pub(crate) shard_bytes: Vec<u8>,
	pub(crate) cold_ref_key: Vec<u8>,
	pub(crate) cold_ref_bytes: Vec<u8>,
	pub(crate) physical_row_count: usize,
	pub(crate) physical_value_bytes: u64,
}

gas::prelude::join_signal!(pub DbManagerSignal {
	DeltasAvailable,
	HotJobFinished,
	ColdJobFinished,
	ReclaimJobFinished,
	ForceCompaction,
	DestroyDatabaseBranch,
});

gas::prelude::join_signal!(pub DbHotCompacterSignal {
	RunHotJob,
	DestroyDatabaseBranch,
});

gas::prelude::join_signal!(pub DbColdCompacterSignal {
	RunColdJob,
	DestroyDatabaseBranch,
});

gas::prelude::join_signal!(pub DbReclaimerSignal {
	RunReclaimJob,
	DestroyDatabaseBranch,
});

impl DbManagerSignal {
	pub fn database_branch_id(&self) -> DatabaseBranchId {
		match self {
			DbManagerSignal::DeltasAvailable(signal) => signal.database_branch_id,
			DbManagerSignal::HotJobFinished(signal) => signal.database_branch_id,
			DbManagerSignal::ColdJobFinished(signal) => signal.database_branch_id,
			DbManagerSignal::ReclaimJobFinished(signal) => signal.database_branch_id,
			DbManagerSignal::ForceCompaction(signal) => signal.database_branch_id,
			DbManagerSignal::DestroyDatabaseBranch(signal) => signal.database_branch_id,
		}
	}
}

impl DbColdCompacterSignal {
	pub fn database_branch_id(&self) -> DatabaseBranchId {
		match self {
			DbColdCompacterSignal::RunColdJob(signal) => signal.database_branch_id,
			DbColdCompacterSignal::DestroyDatabaseBranch(signal) => signal.database_branch_id,
		}
	}
}

impl DbHotCompacterSignal {
	pub fn database_branch_id(&self) -> DatabaseBranchId {
		match self {
			DbHotCompacterSignal::RunHotJob(signal) => signal.database_branch_id,
			DbHotCompacterSignal::DestroyDatabaseBranch(signal) => signal.database_branch_id,
		}
	}
}

impl DbReclaimerSignal {
	pub fn database_branch_id(&self) -> DatabaseBranchId {
		match self {
			DbReclaimerSignal::RunReclaimJob(signal) => signal.database_branch_id,
			DbReclaimerSignal::DestroyDatabaseBranch(signal) => signal.database_branch_id,
		}
	}
}

pub fn database_branch_tag_value(database_branch_id: DatabaseBranchId) -> String {
	database_branch_id.as_uuid().to_string()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn reclaim_tracker() -> ForceCompactionTracker {
		let mut tracker = ForceCompactionTracker::default();
		tracker.record_request(
			ForceCompaction {
				database_branch_id: DatabaseBranchId::from_uuid(uuid::Uuid::from_u128(1)),
				request_id: Id::new_v1(1),
				requested_work: ForceCompactionWork {
					hot: false,
					cold: false,
					reclaim: true,
					final_settle: true,
				},
			},
			0,
			&ManagerActiveJobs::default(),
		);
		tracker
	}

	#[test]
	fn retryable_rejection_keeps_force_request_pending_and_success_resets_streak() {
		let mut tracker = reclaim_tracker();
		for _ in 0..ForceCompactionTracker::MAX_CONSECUTIVE_RETRYABLE_REJECTIONS {
			tracker.record_job_finished(
				CompactionJobKind::Reclaim,
				Id::new_v1(1),
				&CompactionJobStatus::Retryable {
					reason: "stale plan".to_string(),
				},
			);
		}

		assert!(tracker.pending_work().reclaim);
		assert!(tracker.pending_requests[0].terminal_error.is_none());
		assert_eq!(
			tracker.pending_requests[0].consecutive_retryable_rejections,
			ForceCompactionTracker::MAX_CONSECUTIVE_RETRYABLE_REJECTIONS
		);

		tracker.record_job_finished(
			CompactionJobKind::Reclaim,
			Id::new_v1(1),
			&CompactionJobStatus::Succeeded,
		);
		assert_eq!(
			tracker.pending_requests[0].consecutive_retryable_rejections,
			0
		);
		assert_eq!(
			tracker.pending_requests[0].retryable_rejections,
			ForceCompactionTracker::MAX_CONSECUTIVE_RETRYABLE_REJECTIONS
		);
	}

	#[test]
	fn retryable_rejection_budget_prevents_infinite_force_request_loop() {
		let mut tracker = reclaim_tracker();
		for _ in 0..=ForceCompactionTracker::MAX_CONSECUTIVE_RETRYABLE_REJECTIONS {
			tracker.record_job_finished(
				CompactionJobKind::Reclaim,
				Id::new_v1(1),
				&CompactionJobStatus::Retryable {
					reason: "stale forever".to_string(),
				},
			);
		}

		assert!(!tracker.pending_work().reclaim);
		assert!(
			tracker.pending_requests[0]
				.terminal_error
				.as_deref()
				.is_some_and(|error| error.contains("remained stale after 8 retries"))
		);
	}
}
