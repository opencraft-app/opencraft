//! Typed `SQLite` transaction repository for block metadata and hot payloads.

use std::{
	fmt,
	ops::{Deref, DerefMut},
	path::PathBuf,
	sync::{
		Arc, Mutex,
		atomic::{AtomicU64, Ordering},
		mpsc::{self, Receiver, SyncSender, TryRecvError},
	},
	thread::{self, JoinHandle},
	time::Duration,
};

#[cfg(feature = "fault-injection")]
use std::{fs::File, io::Write, path::Path};

use rusqlite::{
	Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Fixed logical and hot-tier block size used by the reference engine.
pub const BLOCK_SIZE: u64 = 4 * 1024;
const SCHEMA_VERSION: i64 = 7;
const OP_WRITE: i64 = 1;
const OP_FLUSH: i64 = 2;
const OP_ACQUIRE_WRITER: i64 = 3;
const OP_DISCARD: i64 = 4;
const OP_RANGE_WRITE: i64 = 5;
const OP_RANGE_DISCARD: i64 = 6;
const VALUE_DATA: i64 = 1;
const VALUE_DISCARD: i64 = 2;
const OUTCOME_APPLIED: i64 = 1;
const OUTCOME_STALE_EPOCH: i64 = 2;
const OUTCOME_EPOCH_ROTATED: i64 = 3;
const MAX_IDENTIFIER_BYTES: usize = 128;
const SHA256_BYTES: usize = 32;
const BLOCK_SIZE_USIZE: usize = 4 * 1024;
const DELTA_SHARD_BLOCKS: u64 = 1024;
/// Maximum bytes accepted by one aligned write operation.
pub const MAX_WRITE_BYTES: usize = 512 * 1024;
/// Maximum independent operations combined into one same-volume transaction.
pub const MAX_BATCH_OPERATIONS: usize = 128;
const MAX_BATCH_BYTES: usize = 512 * 1024;
const LAYER_MUTABLE: i64 = 1;
const LAYER_SEALED: i64 = 2;
const VOLUME_ACTIVE: i64 = 1;
const VOLUME_RETIRED: i64 = 2;
/// Maximum root records removed by one bounded compaction transaction.
pub const MAX_COMPACTION_ROWS: u64 = 16_384;
const LIVE_VERSIONS_CTE: &str = "WITH RECURSIVE
     layer_refs(anchor_layer) AS (
       SELECT current_layer_id FROM volumes
        WHERE state = 1 AND current_layer_id IS NOT NULL
       UNION
       SELECT layer_id FROM snapshots WHERE state = 1 AND layer_id IS NOT NULL
     ),
     chain(anchor_layer, layer_id, depth) AS (
       SELECT anchor_layer, anchor_layer, 0 FROM layer_refs
       UNION ALL
       SELECT chain.anchor_layer, delta_layers.parent_layer_id, chain.depth + 1
         FROM chain JOIN delta_layers
           ON delta_layers.layer_id = chain.layer_id
        WHERE delta_layers.parent_layer_id IS NOT NULL
     ),
     ranked(source_volume_id, writer_epoch, sequence, rank) AS (
       SELECT h.source_volume_id, h.writer_epoch, h.sequence,
              row_number() OVER (
                PARTITION BY chain.anchor_layer, h.block_no
                ORDER BY chain.depth ASC)
         FROM chain JOIN delta_block_heads h ON h.layer_id = chain.layer_id
     ),
     live_versions(source_volume_id, writer_epoch, sequence) AS (
       SELECT source_volume_id, writer_epoch, sequence
         FROM ranked WHERE rank = 1
     ) ";

/// Fail-closed repository errors.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum BlockRepositoryError {
	/// `SQLite` or the underlying durable filesystem is unavailable.
	#[error("block repository unavailable")]
	Unavailable,
	/// A bounded or structural request invariant was violated.
	#[error("invalid block repository request: {0}")]
	InvalidArgument(&'static str),
	/// The requested volume does not exist.
	#[error("volume does not exist")]
	VolumeNotFound,
	/// The immutable volume incarnation was already terminally retired.
	#[error("volume is retired")]
	VolumeRetired,
	/// The requested snapshot does not exist.
	#[error("snapshot does not exist")]
	SnapshotNotFound,
	/// A volume or snapshot identifier is already allocated.
	#[error("identifier already exists")]
	AlreadyExists,
	/// One operation identity was reused for different request bytes.
	#[error("operation ID was reused for a different request")]
	OperationIdMismatch,
	/// Persistent rows violate the typed protocol contract.
	#[error("block repository durable state is corrupt")]
	CorruptState,
	/// The bounded repository actor has stopped.
	#[error("block repository actor stopped")]
	ActorStopped,
	/// A durable monotonic counter can no longer be represented.
	#[error("block repository sequence space exhausted")]
	SequenceExhausted,
	/// The requested hot version is absent or no longer has hot bytes.
	#[error("hot block version does not exist")]
	HotVersionNotFound,
	/// A cold location conflicts with already published immutable metadata.
	#[error("cold location conflicts with durable metadata")]
	ColdLocationConflict,
	/// The control plane already closed retries for this writer epoch.
	#[error("writer retry window is closed")]
	RetryWindowClosed,
}

/// Configuration for one single-owner repository actor.
#[derive(Clone, Debug)]
pub struct BlockRepositoryConfig {
	path: PathBuf,
	queue_capacity: usize,
	busy_timeout: Duration,
	#[cfg(feature = "fault-injection")]
	crash_probe: Option<CrashProbe>,
}

/// An already-open SQLite connection whose VFS provides atomic durable commits.
///
/// This is the production integration boundary for Depot-backed SQLite. The
/// owner keeps the VFS registration and its transport alive for at least as
/// long as the non-owning [`Connection`] wrapper. The caller must only use a
/// VFS where a successful SQLite commit means the remote transaction is
/// durable; ordinary filesystem connections must use [`BlockRepositoryConfig`]
/// instead.
pub struct AtomicVfsBlockRepositoryConnection {
	connection: Connection,
	// Fields are dropped in declaration order. Drop the non-owning rusqlite
	// wrapper before the VFS owner closes the underlying sqlite3 handle.
	_owner: Box<dyn Send>,
}

impl fmt::Debug for AtomicVfsBlockRepositoryConnection {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("AtomicVfsBlockRepositoryConnection")
			.finish_non_exhaustive()
	}
}

impl AtomicVfsBlockRepositoryConnection {
	/// Couples a non-owning SQLite wrapper to the object that owns its handle.
	#[must_use]
	pub fn new(connection: Connection, owner: impl Send + 'static) -> Self {
		Self {
			connection,
			_owner: Box::new(owner),
		}
	}
}

impl Deref for AtomicVfsBlockRepositoryConnection {
	type Target = Connection;

	fn deref(&self) -> &Self::Target {
		&self.connection
	}
}

impl DerefMut for AtomicVfsBlockRepositoryConnection {
	fn deref_mut(&mut self) -> &mut Self::Target {
		&mut self.connection
	}
}

impl BlockRepositoryConfig {
	/// Creates a repository configuration for one `SQLite` database file.
	#[must_use]
	pub fn new(path: impl Into<PathBuf>) -> Self {
		Self {
			path: path.into(),
			queue_capacity: 256,
			busy_timeout: Duration::from_secs(5),
			#[cfg(feature = "fault-injection")]
			crash_probe: None,
		}
	}

	/// Sets the bounded actor queue capacity.
	#[must_use]
	pub const fn with_queue_capacity(mut self, queue_capacity: usize) -> Self {
		self.queue_capacity = queue_capacity;
		self
	}

	/// Installs a deterministic process-stop probe for crash tests.
	///
	/// This method is absent from default and release-oriented builds.
	#[cfg(feature = "fault-injection")]
	#[doc(hidden)]
	#[must_use]
	pub fn with_crash_probe(mut self, point: CrashPoint, marker: impl Into<PathBuf>) -> Self {
		self.crash_probe = Some(CrashProbe {
			point,
			marker: marker.into(),
		});
		self
	}
}

/// Deterministic `SQLite` transaction boundaries used by the SIGKILL harness.
#[cfg(feature = "fault-injection")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CrashPoint {
	/// Stop before invoking `SQLite` COMMIT.
	BeforeWriteCommit,
	/// Stop from the `SQLite` commit hook.
	DuringWriteCommit,
	/// Stop after durable COMMIT but before replying to the caller.
	AfterWriteCommit,
	/// Stop before committing one aligned multi-block/group transaction.
	BeforeRangeCommit,
	/// Stop from the aligned multi-block/group transaction commit hook.
	DuringRangeCommit,
	/// Stop after the aligned multi-block/group commit but before replies.
	AfterRangeCommit,
	/// Stop before committing one FLUSH barrier and its idempotency result.
	BeforeFlushCommit,
	/// Stop from the FLUSH barrier `SQLite` commit hook.
	DuringFlushCommit,
	/// Stop after the FLUSH barrier is durable but before replying.
	AfterFlushCommit,
	/// Stop before committing one snapshot root switch and epoch rotation.
	BeforeSnapshotCommit,
	/// Stop from the snapshot root-switch `SQLite` commit hook.
	DuringSnapshotCommit,
	/// Stop after the snapshot root switch is durable but before replying.
	AfterSnapshotCommit,
	/// Stop before committing one terminal volume retirement.
	BeforeDeleteVolumeCommit,
	/// Stop from the terminal volume retirement `SQLite` commit hook.
	DuringDeleteVolumeCommit,
	/// Stop after volume retirement is durable but before replying.
	AfterDeleteVolumeCommit,
	/// Stop before committing one bounded retention transaction.
	BeforeRetentionCommit,
	/// Stop from the bounded retention transaction commit hook.
	DuringRetentionCommit,
	/// Stop after bounded retention COMMIT but before replying.
	AfterRetentionCommit,
}

#[cfg(feature = "fault-injection")]
impl CrashPoint {
	/// Parses the hidden crash-probe command-line value.
	///
	/// # Errors
	///
	/// Returns an invalid-argument error for an unknown value.
	pub fn parse(value: &str) -> Result<Self, BlockRepositoryError> {
		match value {
			"before-write-commit" => Ok(Self::BeforeWriteCommit),
			"during-write-commit" => Ok(Self::DuringWriteCommit),
			"after-write-commit" => Ok(Self::AfterWriteCommit),
			"before-range-commit" => Ok(Self::BeforeRangeCommit),
			"during-range-commit" => Ok(Self::DuringRangeCommit),
			"after-range-commit" => Ok(Self::AfterRangeCommit),
			"before-flush-commit" => Ok(Self::BeforeFlushCommit),
			"during-flush-commit" => Ok(Self::DuringFlushCommit),
			"after-flush-commit" => Ok(Self::AfterFlushCommit),
			"before-snapshot-commit" => Ok(Self::BeforeSnapshotCommit),
			"during-snapshot-commit" => Ok(Self::DuringSnapshotCommit),
			"after-snapshot-commit" => Ok(Self::AfterSnapshotCommit),
			"before-delete-volume-commit" => Ok(Self::BeforeDeleteVolumeCommit),
			"during-delete-volume-commit" => Ok(Self::DuringDeleteVolumeCommit),
			"after-delete-volume-commit" => Ok(Self::AfterDeleteVolumeCommit),
			"before-retention-commit" => Ok(Self::BeforeRetentionCommit),
			"during-retention-commit" => Ok(Self::DuringRetentionCommit),
			"after-retention-commit" => Ok(Self::AfterRetentionCommit),
			_ => Err(BlockRepositoryError::InvalidArgument("unknown crash point")),
		}
	}
}

#[cfg(feature = "fault-injection")]
#[derive(Clone, Debug)]
struct CrashProbe {
	point: CrashPoint,
	marker: PathBuf,
}

/// Version identity scoped by the volume that originally issued the write.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct BlockVersion {
	/// Writer fencing epoch.
	pub epoch: u64,
	/// Sequence allocated within the writer epoch.
	pub sequence: u64,
}

/// Current durable control state for one logical volume.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VolumeState {
	/// Stable logical volume identifier.
	pub volume_id: String,
	/// Sparse logical size in bytes.
	pub logical_size: u64,
	/// Current fencing epoch.
	pub writer_epoch: u64,
	/// Highest versionstamp-like sequence durably committed in this epoch.
	pub committed_sequence: u64,
	/// Current delta layer, or zero for an all-zero image.
	pub layer_id: u64,
}

/// Idempotent request to fence a previous writer and acquire a fresh epoch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcquireWriterRequest {
	/// Target logical volume.
	pub volume_id: String,
	/// Epoch the control plane observed before acquisition.
	pub expected_epoch: u64,
	/// Retry-stable operation identifier.
	pub op_id: String,
}

/// Durable writer-acquisition outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcquireWriterOutcome {
	/// The request installed a fresh monotonically increasing epoch.
	Acquired {
		/// Newly installed epoch.
		new_epoch: u64,
	},
	/// Another acquisition already changed the observed epoch.
	StaleEpoch {
		/// Current durable epoch.
		current_epoch: u64,
	},
}

/// Stable result returned to an original writer acquisition or any retry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcquireWriterResult {
	/// Repository-global durable commit version.
	pub commit_version: u64,
	/// Whether this result was loaded from durable deduplication state.
	pub replayed: bool,
	/// Typed durable acquisition outcome.
	pub outcome: AcquireWriterOutcome,
}

/// Exact sealed delta-layer image pinned by a snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SnapshotState {
	/// Stable snapshot identifier.
	pub snapshot_id: String,
	/// Sparse logical size inherited from its source volume.
	pub logical_size: u64,
	/// Pinned sealed layer, or zero for an all-zero image.
	pub layer_id: u64,
	/// Fresh source-volume epoch installed while sealing this snapshot.
	pub source_writer_epoch: u64,
}

/// Idempotent result of releasing one pinned snapshot layer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SnapshotDeleteResult {
	/// Stable snapshot identifier that can never be reused.
	pub snapshot_id: String,
	/// Layer released by the deletion, or zero for an all-zero snapshot.
	pub layer_id: u64,
	/// Durable commit version of the first deletion.
	pub commit_version: u64,
	/// Whether this call observed an already deleted snapshot tombstone.
	pub replayed: bool,
}

/// Stable identity for one terminal volume-retirement request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeleteVolumeRequest {
	/// Immutable logical-volume incarnation. Repository IDs are never reused.
	pub volume_id: String,
	/// Retry-stable control-plane operation identifier.
	pub op_id: String,
}

/// Durable result of removing one active volume root and fencing its writer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeleteVolumeResult {
	/// Immutable logical-volume incarnation that was retired.
	pub volume_id: String,
	/// Last epoch in which data-plane operations could execute.
	pub retired_writer_epoch: u64,
	/// Terminal epoch installed to fence every old writer.
	pub fenced_writer_epoch: u64,
	/// Former live layer root, or zero for an all-zero volume.
	pub layer_id: u64,
	/// Commit version of the first successful retirement.
	pub commit_version: u64,
	/// Whether this call replayed the durable terminal result.
	pub replayed: bool,
}

/// Request for one idempotent 4 KiB write.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitWriteRequest {
	/// Target logical volume.
	pub volume_id: String,
	/// Current writer fencing epoch.
	pub writer_epoch: u64,
	/// Retry-stable operation identifier.
	pub op_id: String,
	/// Zero-based logical block number.
	pub block_no: u64,
	/// Exactly [`BLOCK_SIZE`] bytes.
	pub bytes: Vec<u8>,
}

/// Durable outcome of a write attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WriteOutcome {
	/// The write published this immutable version in the current delta layer.
	Applied {
		/// New block version.
		version: BlockVersion,
		/// Mutable delta layer containing the addressed block head.
		layer_id: u64,
	},
	/// The request carried a superseded fencing epoch.
	StaleEpoch {
		/// Current durable epoch.
		current_epoch: u64,
	},
}

/// Stable result returned to an original write or any retry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitWriteResult {
	/// Repository-global durable commit version.
	pub commit_version: u64,
	/// Whether the result was loaded from the durable deduplication table.
	pub replayed: bool,
	/// Typed durable write outcome.
	pub outcome: WriteOutcome,
}

/// Request for one idempotent, aligned multi-block write.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitRangeWriteRequest {
	/// Target logical volume.
	pub volume_id: String,
	/// Current writer fencing epoch.
	pub writer_epoch: u64,
	/// Retry-stable identity for the complete range operation.
	pub op_id: String,
	/// Byte offset, aligned to [`BLOCK_SIZE`].
	pub offset: u64,
	/// Between 4 KiB and 512 KiB, aligned to [`BLOCK_SIZE`].
	pub bytes: Vec<u8>,
}

/// Durable outcome of an aligned multi-block write.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RangeWriteOutcome {
	/// Every addressed 4 KiB version and exact delta head committed atomically.
	Applied {
		/// First version allocated to the operation.
		first_version: BlockVersion,
		/// Last version allocated to the operation and its FLUSH watermark.
		last_version: BlockVersion,
		/// Number of consecutive 4 KiB blocks written.
		block_count: u64,
		/// Mutable delta layer containing every addressed head.
		layer_id: u64,
	},
	/// The request carried a superseded fencing epoch and changed no block.
	StaleEpoch {
		/// Current durable epoch.
		current_epoch: u64,
	},
}

/// Stable result for an original range write or any retry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitRangeWriteResult {
	/// Last repository-global sequence allocated by this logical operation.
	pub commit_version: u64,
	/// Whether the durable operation result already existed.
	pub replayed: bool,
	/// Typed durable range outcome.
	pub outcome: RangeWriteOutcome,
}

/// Request for one idempotent versioned zero/discard mutation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscardRequest {
	/// Target logical volume.
	pub volume_id: String,
	/// Current writer fencing epoch.
	pub writer_epoch: u64,
	/// Retry-stable operation identifier.
	pub op_id: String,
	/// Zero-based logical block number to become logically zero.
	pub block_no: u64,
}

/// Stable result returned to an original DISCARD or any retry.
pub type DiscardResult = CommitWriteResult;

/// Request for one idempotent aligned multi-block versioned discard.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscardRangeRequest {
	/// Target logical volume.
	pub volume_id: String,
	/// Current writer fencing epoch.
	pub writer_epoch: u64,
	/// Retry-stable identity for the complete range operation.
	pub op_id: String,
	/// Byte offset, aligned to [`BLOCK_SIZE`].
	pub offset: u64,
	/// Byte length, between 4 KiB and 512 KiB and aligned to [`BLOCK_SIZE`].
	pub length: u64,
}

/// Stable result returned to an original range DISCARD or any retry.
pub type DiscardRangeResult = CommitRangeWriteResult;

/// Request for an idempotent durable FLUSH barrier.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FlushRequest {
	/// Target logical volume.
	pub volume_id: String,
	/// Current writer fencing epoch.
	pub writer_epoch: u64,
	/// Retry-stable operation identifier.
	pub op_id: String,
	/// Highest frontend sequence submitted before the barrier.
	pub submitted_sequence: u64,
}

/// Durable result of a FLUSH barrier.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FlushResult {
	/// Repository-global durable commit version.
	pub commit_version: u64,
	/// Whether a prior durable result satisfied this retry.
	pub replayed: bool,
	/// Sequence covered by the barrier, or zero for a stale request.
	pub captured_sequence: u64,
	/// Current epoch when the request was stale.
	pub stale_current_epoch: Option<u64>,
}

/// One verified immutable COS range.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ColdLocation {
	/// Content-addressed pack key.
	pub object_key: String,
	/// Byte offset within the immutable pack.
	pub offset: u64,
	/// Byte length within the immutable pack.
	pub length: u64,
	/// SHA-256 of the full immutable pack.
	pub pack_sha256: [u8; SHA256_BYTES],
}

/// Resolved logical block contents.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BlockData {
	/// No version exists in the sealed/mutable delta-layer chain.
	Zero,
	/// A versioned discard explicitly makes this block logically zero.
	Discarded {
		/// Volume that originally issued this discard version.
		source_volume_id: String,
		/// Version allocated by the source volume.
		version: BlockVersion,
		/// Logical block number encoded by the version.
		block_no: u64,
	},
	/// A concrete version, with at least one durable location.
	Version {
		/// Volume that originally issued this version.
		source_volume_id: String,
		/// Version allocated by the source volume.
		version: BlockVersion,
		/// Logical block number encoded by the version.
		block_no: u64,
		/// SHA-256 of the uncompressed 4 KiB bytes.
		content_sha256: [u8; SHA256_BYTES],
		/// Hot `SQLite` bytes, absent after safe eviction.
		hot_bytes: Option<Vec<u8>>,
		/// Verified immutable cold range, when published.
		cold: Option<ColdLocation>,
	},
}

/// One hot version selected for an immutable pack.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HotBlock {
	/// Volume that originally issued this version.
	pub source_volume_id: String,
	/// Version allocated by the source volume.
	pub version: BlockVersion,
	/// Logical block number encoded by the version.
	pub block_no: u64,
	/// SHA-256 of the 4 KiB bytes.
	pub content_sha256: [u8; SHA256_BYTES],
	/// Hot bytes to place in a canonical immutable pack.
	pub bytes: Vec<u8>,
}

/// Durable phase of one immutable pack workflow.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PackIntentState {
	/// Exact members and object identity are durable; PUT may not have run.
	Prepared,
	/// An exact GET authenticated the immutable provider object.
	Verified,
	/// All member cold locations are atomically published.
	Published,
	/// Every member hot payload has been safely evicted.
	Complete,
}

/// Exact immutable member reserved by a durable pack intent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackIntentMember {
	/// Volume that originally issued this version.
	pub source_volume_id: String,
	/// Version allocated by the source volume.
	pub version: BlockVersion,
	/// Logical block number encoded by the version.
	pub block_no: u64,
	/// SHA-256 of the logical 4 KiB bytes.
	pub content_sha256: [u8; SHA256_BYTES],
	/// Exact physical byte offset inside the immutable pack.
	pub offset: u64,
	/// Hot bytes, absent only after a published member was evicted.
	pub hot_bytes: Option<Vec<u8>>,
}

/// One durable, generation-fenced immutable pack workflow.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackIntent {
	/// SQLite-assigned durable intent identity.
	pub intent_id: u64,
	/// Durable settlement round whose fixed cutoff admitted these members.
	pub round_id: u64,
	/// Settler generation currently allowed to advance this intent.
	pub generation: u64,
	/// Durable workflow phase.
	pub state: PackIntentState,
	/// Content-addressed exact COS object key.
	pub object_key: String,
	/// SHA-256 of the complete immutable pack bytes.
	pub pack_sha256: [u8; SHA256_BYTES],
	/// Complete immutable pack length.
	pub pack_length: u64,
	/// Exact immutable membership fixed before PUT.
	pub members: Vec<PackIntentMember>,
}

/// Exact immutable object deletion authorized by the durable GC outbox.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GcTask {
	/// Exact object key; prefix scans and COS LIST are never used.
	pub object_key: String,
	/// Expected immutable pack identity.
	pub pack_sha256: [u8; SHA256_BYTES],
}

/// Bounded result from one retry-safe metadata compaction transaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RetentionCompactionResult {
	/// Durable operation results removed from closed writer epochs.
	pub operation_results: u64,
	/// FLUSH barrier rows removed from closed writer epochs.
	pub flush_barriers: u64,
	/// Semantically shadowed delta heads removed after live-set resolution.
	pub delta_heads: u64,
	/// Immutable versions removed after all concrete references disappeared.
	pub versions: u64,
	/// Completed, retired pack intents removed with their member rows.
	pub pack_intents: u64,
	/// Completed, retired settlement rounds with no remaining intents removed.
	pub settlement_rounds: u64,
}

/// Result of an O(1) fork from a pinned sealed delta layer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForkResult {
	/// Newly created child volume.
	pub volume: VolumeState,
	/// Exact sealed layer shared with the snapshot.
	pub inherited_layer_id: u64,
}

/// Observable repository counts used by acceptance and recovery tests.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepositoryStats {
	/// Number of active logical-volume incarnations.
	pub volumes: u64,
	/// Number of terminal tombstones retained for fencing and replay.
	pub retired_volumes: u64,
	/// Number of pinned snapshots.
	pub snapshots: u64,
	/// Number of immutable block versions.
	pub versions: u64,
	/// Number of allocated delta layers, sealed and mutable.
	pub delta_layers: u64,
	/// Number of mutable layers; at most one may belong to each volume.
	pub mutable_delta_layers: u64,
	/// Number of exact `(layer, shard, block)` head keys.
	pub delta_heads: u64,
	/// Bytes still held in the synchronous hot tier.
	pub hot_payload_bytes: u64,
	/// Number of published cold locations.
	pub cold_locations: u64,
	/// Number of immutable packs known to the `MetaStore`.
	pub packs: u64,
	/// Durable pack workflows not yet complete.
	pub active_pack_intents: u64,
	/// Durable pack workflows that completed publication and eviction.
	pub completed_pack_intents: u64,
	/// Durable hot-to-cold rounds that may still prepare bounded packs.
	pub active_settlement_rounds: u64,
	/// Durable rounds whose fixed byte budget was completed or exhausted.
	pub completed_settlement_rounds: u64,
	/// Exact-key deletions waiting in the durable GC outbox.
	pub pending_gc_tasks: u64,
	/// Exact-key deletions durably completed.
	pub completed_gc_tasks: u64,
	/// Durable idempotency results still inside an open retry window.
	pub operation_results: u64,
	/// Durable FLUSH barriers still inside an open retry window.
	pub flush_barriers: u64,
}

/// Process-local observations of successful aligned-write transactions.
///
/// These counters are benchmark telemetry rather than durable protocol state;
/// they reset when the repository is reopened.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RepositoryRuntimeStats {
	/// Number of successful `SQLite` transactions serving range writes.
	pub range_transactions: u64,
	/// Number of original range operations contained by those transactions.
	pub range_operations: u64,
	/// Number of internal 4 KiB blocks contained by those transactions.
	pub range_blocks: u64,
	/// Largest observed number of operations in one transaction.
	pub max_range_operations: u64,
	/// Largest observed number of 4 KiB blocks in one transaction.
	pub max_range_blocks: u64,
}

#[derive(Debug, Default)]
struct RuntimeCounters {
	range_transactions: AtomicU64,
	range_operations: AtomicU64,
	range_blocks: AtomicU64,
	max_range_operations: AtomicU64,
	max_range_blocks: AtomicU64,
}

impl RuntimeCounters {
	fn record_range_transaction(&self, operations: usize, blocks: usize) {
		let operations = u64::try_from(operations).unwrap_or(u64::MAX);
		let blocks = u64::try_from(blocks).unwrap_or(u64::MAX);
		self.range_transactions.fetch_add(1, Ordering::Relaxed);
		self.range_operations
			.fetch_add(operations, Ordering::Relaxed);
		self.range_blocks.fetch_add(blocks, Ordering::Relaxed);
		self.max_range_operations
			.fetch_max(operations, Ordering::Relaxed);
		self.max_range_blocks.fetch_max(blocks, Ordering::Relaxed);
	}

	fn snapshot(&self) -> RepositoryRuntimeStats {
		RepositoryRuntimeStats {
			range_transactions: self.range_transactions.load(Ordering::Relaxed),
			range_operations: self.range_operations.load(Ordering::Relaxed),
			range_blocks: self.range_blocks.load(Ordering::Relaxed),
			max_range_operations: self.max_range_operations.load(Ordering::Relaxed),
			max_range_blocks: self.max_range_blocks.load(Ordering::Relaxed),
		}
	}
}

/// Cloneable handle to one single-owner typed `SQLite` repository actor.
#[derive(Clone, Debug)]
pub struct BlockMetaRepository {
	inner: Arc<RepositoryActor>,
}

#[derive(Debug)]
struct RepositoryActor {
	sender: SyncSender<Command>,
	actor: Mutex<Option<JoinHandle<()>>>,
	runtime: Arc<RuntimeCounters>,
}

impl BlockMetaRepository {
	/// Opens a repository, creates the current schema if empty, and validates it.
	///
	/// # Errors
	///
	/// Returns a configuration, durability, schema, or actor-startup error.
	pub fn open(config: BlockRepositoryConfig) -> Result<Self, BlockRepositoryError> {
		Self::spawn(config, None)
	}

	/// Opens a repository on an already configured atomic remote SQLite VFS.
	///
	/// Depot uses DELETE journaling plus SQLite batch-atomic writes. Its VFS
	/// acknowledges `xSync` only after the UniversalDB transaction commits, so
	/// this path deliberately does not require local WAL/FULL pragmas.
	///
	/// # Errors
	///
	/// Returns a configuration, durability, schema, or actor-startup error.
	pub fn open_atomic_vfs(
		connection: AtomicVfsBlockRepositoryConnection,
		queue_capacity: usize,
	) -> Result<Self, BlockRepositoryError> {
		Self::spawn(
			BlockRepositoryConfig::new(PathBuf::new()).with_queue_capacity(queue_capacity),
			Some(connection),
		)
	}

	fn spawn(
		config: BlockRepositoryConfig,
		connection: Option<AtomicVfsBlockRepositoryConnection>,
	) -> Result<Self, BlockRepositoryError> {
		if config.queue_capacity == 0 {
			return Err(BlockRepositoryError::InvalidArgument(
				"queue capacity must be non-zero",
			));
		}
		let (sender, receiver) = mpsc::sync_channel(config.queue_capacity);
		let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
		let runtime = Arc::new(RuntimeCounters::default());
		let actor_runtime = Arc::clone(&runtime);
		let actor = thread::Builder::new()
			.name("minisandbox-block-repository".to_owned())
			.spawn(move || {
				run_actor(
					&config,
					connection,
					&receiver,
					&ready_sender,
					&actor_runtime,
				);
			})
			.map_err(|_| BlockRepositoryError::Unavailable)?;
		match ready_receiver.recv() {
			Ok(Ok(())) => Ok(Self {
				inner: Arc::new(RepositoryActor {
					sender,
					actor: Mutex::new(Some(actor)),
					runtime,
				}),
			}),
			Ok(Err(error)) => {
				let _ = actor.join();
				Err(error)
			}
			Err(_) => {
				let _ = actor.join();
				Err(BlockRepositoryError::Unavailable)
			}
		}
	}

	/// Creates an all-zero sparse volume.
	///
	/// # Errors
	///
	/// Returns an error for invalid geometry, duplicate ID, or durability loss.
	pub fn create_volume(
		&self,
		volume_id: impl Into<String>,
		logical_size: u64,
	) -> Result<VolumeState, BlockRepositoryError> {
		self.call(|reply| Command::CreateVolume {
			volume_id: volume_id.into(),
			logical_size,
			reply,
		})
	}

	/// Returns the current linearizable volume state.
	///
	/// # Errors
	///
	/// Returns an error when the volume is absent or the repository fails.
	pub fn volume_state(
		&self,
		volume_id: impl Into<String>,
	) -> Result<VolumeState, BlockRepositoryError> {
		self.call(|reply| Command::VolumeState {
			volume_id: volume_id.into(),
			reply,
		})
	}

	/// Atomically fences the observed writer and installs a fresh epoch.
	///
	/// # Errors
	///
	/// Returns a validation, deduplication, durability, or actor error.
	pub fn acquire_writer(
		&self,
		request: AcquireWriterRequest,
	) -> Result<AcquireWriterResult, BlockRepositoryError> {
		self.call(|reply| Command::AcquireWriter { request, reply })
	}

	/// Atomically writes hot bytes, updates one exact delta key, and stores the result.
	///
	/// # Errors
	///
	/// Returns a validation, fencing, deduplication, or durability error.
	pub fn commit_write(
		&self,
		request: CommitWriteRequest,
	) -> Result<CommitWriteResult, BlockRepositoryError> {
		self.call(|reply| Command::CommitWrite { request, reply })
	}

	/// Atomically writes an aligned 4 KiB--512 KiB range.
	///
	/// Every internal 4 KiB block receives an immutable version and exact
	/// delta head. The operation has one durable idempotency result and one
	/// final sequence suitable for a later FLUSH watermark.
	///
	/// # Errors
	///
	/// Returns a validation, fencing, deduplication, or durability error.
	pub fn commit_range_write(
		&self,
		request: CommitRangeWriteRequest,
	) -> Result<CommitRangeWriteResult, BlockRepositoryError> {
		self.call(|reply| Command::CommitRangeWrite { request, reply })
	}

	/// Atomically publishes a payload-free versioned zero and stores op result.
	///
	/// # Errors
	///
	/// Returns a validation, fencing, deduplication, or durability error.
	pub fn commit_discard(
		&self,
		request: DiscardRequest,
	) -> Result<DiscardResult, BlockRepositoryError> {
		self.call(|reply| Command::CommitDiscard { request, reply })
	}

	/// Atomically publishes payload-free versioned zeroes over an aligned range.
	///
	/// Every 4 KiB block receives an immutable discard version and exact delta
	/// head. One durable operation result covers the complete range.
	///
	/// # Errors
	///
	/// Returns a validation, fencing, deduplication, or durability error.
	pub fn commit_range_discard(
		&self,
		request: DiscardRangeRequest,
	) -> Result<DiscardRangeResult, BlockRepositoryError> {
		self.call(|reply| Command::CommitRangeDiscard { request, reply })
	}

	/// Resolves one block through the current mutable/sealed delta-layer chain.
	///
	/// # Errors
	///
	/// Returns an error for invalid address, missing volume, or corrupt state.
	pub fn read_block_head(
		&self,
		volume_id: impl Into<String>,
		block_no: u64,
	) -> Result<BlockData, BlockRepositoryError> {
		self.call(|reply| Command::ReadBlock {
			volume_id: volume_id.into(),
			block_no,
			reply,
		})
	}

	/// Persists a FLUSH ordering point without involving COS.
	///
	/// # Errors
	///
	/// Returns a validation, fencing, deduplication, or durability error.
	pub fn capture_flush(
		&self,
		request: FlushRequest,
	) -> Result<FlushResult, BlockRepositoryError> {
		self.call(|reply| Command::CaptureFlush { request, reply })
	}

	/// Acquires a fresh generation for one restarted settler.
	///
	/// Generation gaps after a lost reply are harmless; equality fencing, not
	/// contiguity, is the safety requirement.
	///
	/// # Errors
	///
	/// Returns a durability, overflow, or actor error.
	pub fn acquire_settler(&self) -> Result<u64, BlockRepositoryError> {
		self.call(Command::AcquireSettler)
	}

	/// Claims an incomplete intent or atomically prepares exact new members.
	///
	/// # Errors
	///
	/// Returns an error for a stale generation, invalid bound, corrupt hot
	/// bytes, or durability failure.
	pub fn resume_or_prepare_pack(
		&self,
		generation: u64,
		max_bytes: u64,
	) -> Result<Option<PackIntent>, BlockRepositoryError> {
		self.resume_or_prepare_pack_to_low(generation, max_bytes, 0)
	}

	/// Claims an incomplete pack or advances one durable cutoff round toward
	/// a fixed low-watermark target.
	///
	/// A newly created round captures the repository commit version and the
	/// exact number of old hot bytes to evict. Later writes have larger commit
	/// versions and cannot enter that round. Recovery may choose different
	/// old blocks, but it cannot move the cutoff or byte budget.
	///
	/// # Errors
	///
	/// Returns an error for a stale generation, invalid bounds, corrupt hot
	/// bytes, or durability failure.
	pub fn resume_or_prepare_pack_to_low(
		&self,
		generation: u64,
		max_bytes: u64,
		low_watermark_bytes: u64,
	) -> Result<Option<PackIntent>, BlockRepositoryError> {
		self.call(|reply| Command::ResumeOrPreparePack {
			generation,
			max_bytes,
			low_watermark_bytes,
			reply,
		})
	}

	/// Persists that the exact immutable object was authenticated.
	///
	/// # Errors
	///
	/// Returns an error for stale generation, wrong phase, or durability loss.
	pub fn verify_pack_intent(
		&self,
		generation: u64,
		intent_id: u64,
	) -> Result<(), BlockRepositoryError> {
		self.call(|reply| Command::VerifyPackIntent {
			generation,
			intent_id,
			reply,
		})
	}

	/// Atomically publishes every verified member cold location.
	///
	/// # Errors
	///
	/// Returns an error for stale generation, wrong phase, conflict, or failure.
	pub fn publish_pack_intent(
		&self,
		generation: u64,
		intent_id: u64,
	) -> Result<(), BlockRepositoryError> {
		self.call(|reply| Command::PublishPackIntent {
			generation,
			intent_id,
			reply,
		})
	}

	/// Safely evicts one published intent member's hot bytes.
	///
	/// # Errors
	///
	/// Returns an error for stale generation, wrong phase, or missing location.
	pub fn evict_pack_intent_member(
		&self,
		generation: u64,
		intent_id: u64,
		member: PackIntentMember,
	) -> Result<bool, BlockRepositoryError> {
		self.call(|reply| Command::EvictPackIntentMember {
			generation,
			intent_id,
			member,
			reply,
		})
	}

	/// Evicts every published member in one durable `SQLite` transaction.
	///
	/// Publication already made every exact cold location durable, so an
	/// all-or-nothing hot eviction is both crash-safe and avoids one fsync per
	/// 4 KiB member on the normal online-settlement path.
	///
	/// # Errors
	///
	/// Returns an error for a stale generation, wrong phase, conflicting
	/// member identity, or durability loss.
	pub fn evict_pack_intent_members(
		&self,
		generation: u64,
		intent_id: u64,
		members: Vec<PackIntentMember>,
	) -> Result<u64, BlockRepositoryError> {
		self.call(|reply| Command::EvictPackIntentMembers {
			generation,
			intent_id,
			members,
			reply,
		})
	}

	/// Marks a published intent complete only after every hot payload is gone.
	///
	/// # Errors
	///
	/// Returns an error for stale generation, wrong phase, remaining hot bytes,
	/// or durability loss.
	pub fn complete_pack_intent(
		&self,
		generation: u64,
		intent_id: u64,
	) -> Result<(), BlockRepositoryError> {
		self.call(|reply| Command::CompletePackIntent {
			generation,
			intent_id,
			reply,
		})
	}

	/// Selects unpublished hot versions up to a bounded byte budget.
	///
	/// # Errors
	///
	/// Returns an error if the budget is invalid or durable rows are corrupt.
	pub fn select_hot_blocks(&self, max_bytes: u64) -> Result<Vec<HotBlock>, BlockRepositoryError> {
		self.call(|reply| Command::SelectHot { max_bytes, reply })
	}

	/// Selects hot payloads whose verified cold locations are already durable.
	///
	/// This is the restart path for a crash after publication and before hot
	/// eviction.
	///
	/// # Errors
	///
	/// Returns an error if the bound is invalid or durable rows are corrupt.
	pub fn select_evictable_hot_blocks(
		&self,
		limit: u64,
	) -> Result<Vec<HotBlock>, BlockRepositoryError> {
		self.call(|reply| Command::SelectEvictable { limit, reply })
	}

	/// Atomically publishes one verified immutable pack and all member ranges.
	///
	/// # Errors
	///
	/// Returns an error if any member changed, vanished, or conflicts.
	pub fn publish_cold_location(
		&self,
		object_key: impl Into<String>,
		pack_sha256: [u8; SHA256_BYTES],
		pack_length: u64,
		members: Vec<(HotBlock, u64)>,
	) -> Result<(), BlockRepositoryError> {
		self.call(|reply| Command::PublishCold {
			object_key: object_key.into(),
			pack_sha256,
			pack_length,
			members,
			reply,
		})
	}

	/// Deletes one hot payload only when its verified cold location exists.
	///
	/// # Errors
	///
	/// Returns an error if the version is absent, unpublished, or corrupt.
	pub fn evict_hot_if_published(&self, block: HotBlock) -> Result<bool, BlockRepositoryError> {
		self.call(|reply| Command::EvictHot { block, reply })
	}

	/// Seals and pins the current volume delta layer in O(1).
	///
	/// # Errors
	///
	/// Returns an error for an absent volume, duplicate snapshot, or failure.
	pub fn create_snapshot(
		&self,
		volume_id: impl Into<String>,
		snapshot_id: impl Into<String>,
	) -> Result<SnapshotState, BlockRepositoryError> {
		self.call(|reply| Command::CreateSnapshot {
			volume_id: volume_id.into(),
			snapshot_id: snapshot_id.into(),
			reply,
		})
	}

	/// Creates a new volume pointing at an exact pinned layer in O(1).
	///
	/// # Errors
	///
	/// Returns an error for an absent snapshot, duplicate volume, or failure.
	pub fn fork_snapshot(
		&self,
		snapshot_id: impl Into<String>,
		child_volume_id: impl Into<String>,
	) -> Result<ForkResult, BlockRepositoryError> {
		self.call(|reply| Command::ForkSnapshot {
			snapshot_id: snapshot_id.into(),
			child_volume_id: child_volume_id.into(),
			reply,
		})
	}

	/// Releases one snapshot pin and atomically derives newly dead packs.
	///
	/// The snapshot ID remains as a tombstone, so retries are idempotent and
	/// the identifier can never silently refer to another layer.
	///
	/// # Errors
	///
	/// Returns an error for an invalid/missing snapshot or durability failure.
	pub fn delete_snapshot(
		&self,
		snapshot_id: impl Into<String>,
	) -> Result<SnapshotDeleteResult, BlockRepositoryError> {
		self.call(|reply| Command::DeleteSnapshot {
			snapshot_id: snapshot_id.into(),
			reply,
		})
	}

	/// Terminally fences a volume incarnation and removes its live layer root.
	///
	/// The row remains as a durable tombstone: its `volume_id` can never be
	/// reused, and retrying the same `op_id` returns the original result. The
	/// caller must stop submitting new device requests before invoking this
	/// control-plane operation.
	///
	/// # Errors
	///
	/// Returns an error for invalid identity, a different delete operation on
	/// an already retired volume, corrupt state, or durability failure.
	pub fn delete_volume(
		&self,
		request: DeleteVolumeRequest,
	) -> Result<DeleteVolumeResult, BlockRepositoryError> {
		self.call(|reply| Command::DeleteVolume { request, reply })
	}

	/// Returns one pending exact-key deletion without changing its state.
	///
	/// # Errors
	///
	/// Returns an error for corrupt state or repository failure.
	pub fn next_gc_task(&self) -> Result<Option<GcTask>, BlockRepositoryError> {
		self.call(Command::NextGcTask)
	}

	/// Completes one exact outbox task after DELETE success or exact `NotFound`.
	///
	/// # Errors
	///
	/// Returns an error if identity/refcount/state changed or durability fails.
	pub fn complete_gc_task(&self, task: GcTask) -> Result<(), BlockRepositoryError> {
		self.call(|reply| Command::CompleteGcTask { task, reply })
	}

	/// Closes retry eligibility through one already fenced writer epoch.
	///
	/// This is a control-plane assertion: every producer for the selected
	/// epochs must have stopped issuing retries. The repository additionally
	/// requires a newer writer epoch, so an old in-flight transaction conflicts
	/// with the durable epoch fence instead of applying after compaction.
	///
	/// # Errors
	///
	/// Returns an error for an absent volume, the current/future epoch, or a
	/// durability failure.
	pub fn close_writer_retry_window(
		&self,
		volume_id: impl Into<String>,
		through_epoch: u64,
	) -> Result<u64, BlockRepositoryError> {
		self.call(|reply| Command::CloseWriterRetryWindow {
			volume_id: volume_id.into(),
			through_epoch,
			reply,
		})
	}

	/// Closes retries through one already fenced settler generation.
	///
	/// # Errors
	///
	/// Returns an error for the current/future generation or durability loss.
	pub fn close_settler_retry_window(
		&self,
		through_generation: u64,
	) -> Result<u64, BlockRepositoryError> {
		self.call(|reply| Command::CloseSettlerRetryWindow {
			through_generation,
			reply,
		})
	}

	/// Removes at most `max_rows` roots from each safe retention class.
	///
	/// Operation results and barriers are eligible only after explicit retry
	/// closure. Versions are eligible only after semantic live-set resolution
	/// and removal of every concrete delta, cold, pack, and intent reference.
	/// Completed COS GC rows and snapshot tombstones are deliberately retained.
	///
	/// # Errors
	///
	/// Returns an error for an invalid bound, corrupt state, or durability loss.
	pub fn compact_retained_history(
		&self,
		max_rows: u64,
	) -> Result<RetentionCompactionResult, BlockRepositoryError> {
		self.call(|reply| Command::CompactRetainedHistory { max_rows, reply })
	}

	/// Returns durable row and hot-byte counts.
	///
	/// # Errors
	///
	/// Returns an error if the repository is unavailable or corrupt.
	pub fn stats(&self) -> Result<RepositoryStats, BlockRepositoryError> {
		self.call(Command::Stats)
	}

	/// Returns process-local aligned-write batching telemetry.
	#[must_use]
	pub fn runtime_stats(&self) -> RepositoryRuntimeStats {
		self.inner.runtime.snapshot()
	}

	fn call<T>(
		&self,
		build: impl FnOnce(SyncSender<Result<T, BlockRepositoryError>>) -> Command,
	) -> Result<T, BlockRepositoryError> {
		let (reply, receiver) = mpsc::sync_channel(1);
		self.inner
			.sender
			.send(build(reply))
			.map_err(|_| BlockRepositoryError::ActorStopped)?;
		receiver
			.recv()
			.map_err(|_| BlockRepositoryError::ActorStopped)?
	}
}

impl Drop for RepositoryActor {
	fn drop(&mut self) {
		let _ = self.sender.send(Command::Shutdown);
		let actor = self
			.actor
			.get_mut()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		if let Some(actor) = actor.take() {
			let _ = actor.join();
		}
	}
}

#[derive(Debug)]
enum Command {
	CreateVolume {
		volume_id: String,
		logical_size: u64,
		reply: SyncSender<Result<VolumeState, BlockRepositoryError>>,
	},
	VolumeState {
		volume_id: String,
		reply: SyncSender<Result<VolumeState, BlockRepositoryError>>,
	},
	AcquireWriter {
		request: AcquireWriterRequest,
		reply: SyncSender<Result<AcquireWriterResult, BlockRepositoryError>>,
	},
	CommitWrite {
		request: CommitWriteRequest,
		reply: SyncSender<Result<CommitWriteResult, BlockRepositoryError>>,
	},
	CommitRangeWrite {
		request: CommitRangeWriteRequest,
		reply: SyncSender<Result<CommitRangeWriteResult, BlockRepositoryError>>,
	},
	CommitDiscard {
		request: DiscardRequest,
		reply: SyncSender<Result<DiscardResult, BlockRepositoryError>>,
	},
	CommitRangeDiscard {
		request: DiscardRangeRequest,
		reply: SyncSender<Result<DiscardRangeResult, BlockRepositoryError>>,
	},
	ReadBlock {
		volume_id: String,
		block_no: u64,
		reply: SyncSender<Result<BlockData, BlockRepositoryError>>,
	},
	CaptureFlush {
		request: FlushRequest,
		reply: SyncSender<Result<FlushResult, BlockRepositoryError>>,
	},
	AcquireSettler(SyncSender<Result<u64, BlockRepositoryError>>),
	ResumeOrPreparePack {
		generation: u64,
		max_bytes: u64,
		low_watermark_bytes: u64,
		reply: SyncSender<Result<Option<PackIntent>, BlockRepositoryError>>,
	},
	VerifyPackIntent {
		generation: u64,
		intent_id: u64,
		reply: SyncSender<Result<(), BlockRepositoryError>>,
	},
	PublishPackIntent {
		generation: u64,
		intent_id: u64,
		reply: SyncSender<Result<(), BlockRepositoryError>>,
	},
	EvictPackIntentMember {
		generation: u64,
		intent_id: u64,
		member: PackIntentMember,
		reply: SyncSender<Result<bool, BlockRepositoryError>>,
	},
	EvictPackIntentMembers {
		generation: u64,
		intent_id: u64,
		members: Vec<PackIntentMember>,
		reply: SyncSender<Result<u64, BlockRepositoryError>>,
	},
	CompletePackIntent {
		generation: u64,
		intent_id: u64,
		reply: SyncSender<Result<(), BlockRepositoryError>>,
	},
	SelectHot {
		max_bytes: u64,
		reply: SyncSender<Result<Vec<HotBlock>, BlockRepositoryError>>,
	},
	SelectEvictable {
		limit: u64,
		reply: SyncSender<Result<Vec<HotBlock>, BlockRepositoryError>>,
	},
	PublishCold {
		object_key: String,
		pack_sha256: [u8; SHA256_BYTES],
		pack_length: u64,
		members: Vec<(HotBlock, u64)>,
		reply: SyncSender<Result<(), BlockRepositoryError>>,
	},
	EvictHot {
		block: HotBlock,
		reply: SyncSender<Result<bool, BlockRepositoryError>>,
	},
	CreateSnapshot {
		volume_id: String,
		snapshot_id: String,
		reply: SyncSender<Result<SnapshotState, BlockRepositoryError>>,
	},
	ForkSnapshot {
		snapshot_id: String,
		child_volume_id: String,
		reply: SyncSender<Result<ForkResult, BlockRepositoryError>>,
	},
	DeleteSnapshot {
		snapshot_id: String,
		reply: SyncSender<Result<SnapshotDeleteResult, BlockRepositoryError>>,
	},
	DeleteVolume {
		request: DeleteVolumeRequest,
		reply: SyncSender<Result<DeleteVolumeResult, BlockRepositoryError>>,
	},
	NextGcTask(SyncSender<Result<Option<GcTask>, BlockRepositoryError>>),
	CompleteGcTask {
		task: GcTask,
		reply: SyncSender<Result<(), BlockRepositoryError>>,
	},
	CloseWriterRetryWindow {
		volume_id: String,
		through_epoch: u64,
		reply: SyncSender<Result<u64, BlockRepositoryError>>,
	},
	CloseSettlerRetryWindow {
		through_generation: u64,
		reply: SyncSender<Result<u64, BlockRepositoryError>>,
	},
	CompactRetainedHistory {
		max_rows: u64,
		reply: SyncSender<Result<RetentionCompactionResult, BlockRepositoryError>>,
	},
	Stats(SyncSender<Result<RepositoryStats, BlockRepositoryError>>),
	Shutdown,
}

#[allow(clippy::too_many_lines)]
fn run_actor(
	config: &BlockRepositoryConfig,
	supplied_connection: Option<AtomicVfsBlockRepositoryConnection>,
	receiver: &Receiver<Command>,
	ready: &SyncSender<Result<(), BlockRepositoryError>>,
	runtime: &RuntimeCounters,
) {
	let mut connection = match supplied_connection
		.map_or_else(|| open_connection(config), configure_atomic_vfs_connection)
	{
		Ok(connection) => {
			let _ = ready.send(Ok(()));
			connection
		}
		Err(error) => {
			let _ = ready.send(Err(error));
			return;
		}
	};
	let mut pending = None;
	loop {
		let command = match pending.take() {
			Some(command) => command,
			None => match receiver.recv() {
				Ok(command) => command,
				Err(_) => break,
			},
		};
		let command = match command {
			Command::CommitRangeWrite { request, reply } => {
				let mut batch = vec![(request, reply)];
				let mut batch_bytes = batch[0].0.bytes.len();
				while batch.len() < MAX_BATCH_OPERATIONS && batch_bytes < MAX_BATCH_BYTES {
					let next = match receiver.try_recv() {
						Ok(command) => command,
						Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
					};
					match next {
						Command::CommitRangeWrite { request, reply } => {
							let first = &batch[0].0;
							let compatible = request.volume_id == first.volume_id
								&& request.writer_epoch == first.writer_epoch
								&& batch_bytes
									.checked_add(request.bytes.len())
									.is_some_and(|bytes| bytes <= MAX_BATCH_BYTES)
								&& validate_range_write(&request).is_ok()
								&& !batch
									.iter()
									.any(|(queued, _)| queued.op_id == request.op_id);
							if compatible {
								batch_bytes += request.bytes.len();
								batch.push((request, reply));
							} else {
								pending = Some(Command::CommitRangeWrite { request, reply });
								break;
							}
						}
						barrier => {
							pending = Some(barrier);
							break;
						}
					}
				}
				let requests: Vec<_> = batch.iter().map(|(request, _)| request).collect();
				match commit_range_write_batch(
					&mut connection,
					&requests,
					#[cfg(feature = "fault-injection")]
					config.crash_probe.as_ref(),
				) {
					Ok(results) if results.len() == batch.len() => {
						runtime
							.record_range_transaction(batch.len(), batch_bytes / BLOCK_SIZE_USIZE);
						for ((_, reply), result) in batch.into_iter().zip(results) {
							let _ = reply.send(Ok(result));
						}
					}
					Ok(_) => {
						for (_, reply) in batch {
							let _ = reply.send(Err(BlockRepositoryError::CorruptState));
						}
					}
					Err(error) => {
						for (_, reply) in batch {
							let _ = reply.send(Err(error.clone()));
						}
					}
				}
				continue;
			}
			other => other,
		};
		match command {
			Command::CreateVolume {
				volume_id,
				logical_size,
				reply,
			} => {
				let _ = reply.send(create_volume(&mut connection, &volume_id, logical_size));
			}
			Command::VolumeState { volume_id, reply } => {
				let _ = reply.send(load_volume(&connection, &volume_id));
			}
			Command::AcquireWriter { request, reply } => {
				let _ = reply.send(acquire_writer(&mut connection, &request));
			}
			Command::CommitWrite { request, reply } => {
				let _ = reply.send(commit_write(
					&mut connection,
					&request,
					#[cfg(feature = "fault-injection")]
					config.crash_probe.as_ref(),
				));
			}
			Command::CommitRangeWrite { request, reply } => {
				let _ = reply.send(commit_range_write(&mut connection, &request));
			}
			Command::CommitDiscard { request, reply } => {
				let _ = reply.send(commit_discard(&mut connection, &request));
			}
			Command::CommitRangeDiscard { request, reply } => {
				let _ = reply.send(commit_range_discard(&mut connection, &request));
			}
			Command::ReadBlock {
				volume_id,
				block_no,
				reply,
			} => {
				let _ = reply.send(read_block(&connection, &volume_id, block_no));
			}
			Command::CaptureFlush { request, reply } => {
				let _ = reply.send(capture_flush(
					&mut connection,
					&request,
					#[cfg(feature = "fault-injection")]
					config.crash_probe.as_ref(),
				));
			}
			Command::AcquireSettler(reply) => {
				let _ = reply.send(acquire_settler(&mut connection));
			}
			Command::ResumeOrPreparePack {
				generation,
				max_bytes,
				low_watermark_bytes,
				reply,
			} => {
				let _ = reply.send(resume_or_prepare_pack(
					&mut connection,
					generation,
					max_bytes,
					low_watermark_bytes,
				));
			}
			Command::VerifyPackIntent {
				generation,
				intent_id,
				reply,
			} => {
				let _ = reply.send(verify_pack_intent(&mut connection, generation, intent_id));
			}
			Command::PublishPackIntent {
				generation,
				intent_id,
				reply,
			} => {
				let _ = reply.send(publish_pack_intent(&mut connection, generation, intent_id));
			}
			Command::EvictPackIntentMember {
				generation,
				intent_id,
				member,
				reply,
			} => {
				let _ = reply.send(evict_pack_intent_member(
					&mut connection,
					generation,
					intent_id,
					&member,
				));
			}
			Command::EvictPackIntentMembers {
				generation,
				intent_id,
				members,
				reply,
			} => {
				let _ = reply.send(evict_pack_intent_members(
					&mut connection,
					generation,
					intent_id,
					&members,
				));
			}
			Command::CompletePackIntent {
				generation,
				intent_id,
				reply,
			} => {
				let _ = reply.send(complete_pack_intent(&mut connection, generation, intent_id));
			}
			Command::SelectHot { max_bytes, reply } => {
				let _ = reply.send(select_hot(&connection, max_bytes));
			}
			Command::SelectEvictable { limit, reply } => {
				let _ = reply.send(select_evictable(&connection, limit));
			}
			Command::PublishCold {
				object_key,
				pack_sha256,
				pack_length,
				members,
				reply,
			} => {
				let _ = reply.send(publish_cold(
					&mut connection,
					&object_key,
					&pack_sha256,
					pack_length,
					&members,
				));
			}
			Command::EvictHot { block, reply } => {
				let _ = reply.send(evict_hot(&mut connection, &block));
			}
			Command::CreateSnapshot {
				volume_id,
				snapshot_id,
				reply,
			} => {
				let _ = reply.send(create_snapshot(
					&mut connection,
					&volume_id,
					&snapshot_id,
					#[cfg(feature = "fault-injection")]
					config.crash_probe.as_ref(),
				));
			}
			Command::ForkSnapshot {
				snapshot_id,
				child_volume_id,
				reply,
			} => {
				let _ = reply.send(fork_snapshot(
					&mut connection,
					&snapshot_id,
					&child_volume_id,
				));
			}
			Command::DeleteSnapshot { snapshot_id, reply } => {
				let _ = reply.send(delete_snapshot(&mut connection, &snapshot_id));
			}
			Command::DeleteVolume { request, reply } => {
				let _ = reply.send(delete_volume(
					&mut connection,
					&request,
					#[cfg(feature = "fault-injection")]
					config.crash_probe.as_ref(),
				));
			}
			Command::NextGcTask(reply) => {
				let _ = reply.send(next_gc_task(&connection));
			}
			Command::CompleteGcTask { task, reply } => {
				let _ = reply.send(complete_gc_task(&mut connection, &task));
			}
			Command::CloseWriterRetryWindow {
				volume_id,
				through_epoch,
				reply,
			} => {
				let _ = reply.send(close_writer_retry_window(
					&mut connection,
					&volume_id,
					through_epoch,
				));
			}
			Command::CloseSettlerRetryWindow {
				through_generation,
				reply,
			} => {
				let _ = reply.send(close_settler_retry_window(
					&mut connection,
					through_generation,
				));
			}
			Command::CompactRetainedHistory { max_rows, reply } => {
				let _ = reply.send(compact_retained_history(
					&mut connection,
					max_rows,
					#[cfg(feature = "fault-injection")]
					config.crash_probe.as_ref(),
				));
			}
			Command::Stats(reply) => {
				let _ = reply.send(stats(&connection));
			}
			Command::Shutdown => break,
		}
	}
}

fn open_connection(
	config: &BlockRepositoryConfig,
) -> Result<AtomicVfsBlockRepositoryConnection, BlockRepositoryError> {
	let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
		| OpenFlags::SQLITE_OPEN_CREATE
		| OpenFlags::SQLITE_OPEN_NO_MUTEX;
	let mut connection = sql(Connection::open_with_flags(&config.path, flags))?;
	sql(connection.busy_timeout(config.busy_timeout))?;
	sql(connection.pragma_update(None, "foreign_keys", "ON"))?;
	sql(connection.pragma_update(None, "trusted_schema", "OFF"))?;
	let journal: String =
		sql(connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0)))?;
	if !journal.eq_ignore_ascii_case("wal") {
		return Err(BlockRepositoryError::Unavailable);
	}
	sql(connection.pragma_update(None, "synchronous", "FULL"))?;
	sql(connection.pragma_update(None, "temp_store", "MEMORY"))?;
	initialize_schema(&mut connection)?;
	validate_connection(&connection, 2)?;
	Ok(AtomicVfsBlockRepositoryConnection::new(connection, ()))
}

fn configure_atomic_vfs_connection(
	mut connection: AtomicVfsBlockRepositoryConnection,
) -> Result<AtomicVfsBlockRepositoryConnection, BlockRepositoryError> {
	sql(connection.pragma_update(None, "foreign_keys", "ON"))?;
	sql(connection.pragma_update(None, "trusted_schema", "OFF"))?;
	let page_size: i64 = sql(connection.query_row("PRAGMA page_size", [], |row| row.get(0)))?;
	let journal: String = sql(connection.query_row("PRAGMA journal_mode", [], |row| row.get(0)))?;
	let synchronous: i64 = sql(connection.query_row("PRAGMA synchronous", [], |row| row.get(0)))?;
	if page_size != BLOCK_SIZE as i64 || !journal.eq_ignore_ascii_case("delete") || synchronous != 1
	{
		return Err(BlockRepositoryError::Unavailable);
	}
	initialize_schema(&mut connection)?;
	validate_connection(&connection, 1)?;
	Ok(connection)
}

#[allow(clippy::too_many_lines)]
fn initialize_schema(connection: &mut Connection) -> Result<(), BlockRepositoryError> {
	let version: i64 = sql(connection.query_row("PRAGMA user_version", [], |row| row.get(0)))?;
	match version {
		0 => sql(connection.execute_batch(
			"BEGIN EXCLUSIVE;
             CREATE TABLE store_state (
                 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                 commit_version INTEGER NOT NULL CHECK (commit_version >= 0),
                 settler_generation INTEGER NOT NULL CHECK (settler_generation >= 0),
                 closed_settler_generation INTEGER NOT NULL DEFAULT 0
                   CHECK (closed_settler_generation >= 0
                          AND closed_settler_generation <= settler_generation)
             ) STRICT;
             INSERT INTO store_state(
               singleton, commit_version, settler_generation,
               closed_settler_generation
             ) VALUES (1, 0, 0, 0);

             CREATE TABLE delta_layers (
                 layer_id INTEGER PRIMARY KEY AUTOINCREMENT,
                 parent_layer_id INTEGER REFERENCES delta_layers(layer_id),
                 state INTEGER NOT NULL CHECK (state IN (1, 2)),
                 owner_volume_id TEXT REFERENCES volumes(volume_id),
                 created_commit_version INTEGER NOT NULL CHECK (created_commit_version > 0),
                 sealed_commit_version INTEGER CHECK (sealed_commit_version > 0),
                 CHECK ((state = 1 AND owner_volume_id IS NOT NULL
                                      AND sealed_commit_version IS NULL) OR
                        (state = 2 AND sealed_commit_version IS NOT NULL))
             ) STRICT;

             CREATE TABLE volumes (
                 volume_id TEXT PRIMARY KEY,
                 logical_size INTEGER NOT NULL CHECK (logical_size > 0),
                 block_size INTEGER NOT NULL CHECK (block_size = 4096),
                 state INTEGER NOT NULL DEFAULT 1 CHECK (state IN (1, 2)),
                 writer_epoch INTEGER NOT NULL CHECK (writer_epoch > 0),
                 next_sequence INTEGER NOT NULL CHECK (next_sequence > 0),
                 committed_sequence INTEGER NOT NULL CHECK (committed_sequence >= 0),
                 current_layer_id INTEGER REFERENCES delta_layers(layer_id),
                 retired_layer_id INTEGER,
                 created_commit_version INTEGER NOT NULL CHECK (created_commit_version > 0),
                 closed_retry_epoch INTEGER NOT NULL DEFAULT 0
                   CHECK (closed_retry_epoch >= 0
                          AND closed_retry_epoch < writer_epoch),
                 retired_from_epoch INTEGER CHECK (retired_from_epoch > 0),
                 delete_op_id TEXT,
                 deleted_commit_version INTEGER CHECK (deleted_commit_version > 0),
                 CHECK (
                   (state = 1 AND retired_layer_id IS NULL
                              AND retired_from_epoch IS NULL
                              AND delete_op_id IS NULL
                              AND deleted_commit_version IS NULL) OR
                   (state = 2 AND current_layer_id IS NULL
                              AND retired_from_epoch IS NOT NULL
                              AND delete_op_id IS NOT NULL
                              AND deleted_commit_version IS NOT NULL
                              AND writer_epoch = retired_from_epoch + 1
                              AND closed_retry_epoch = retired_from_epoch)
                 )
             ) STRICT;

             CREATE TABLE hot_block_versions (
                 source_volume_id TEXT NOT NULL REFERENCES volumes(volume_id),
                 writer_epoch INTEGER NOT NULL CHECK (writer_epoch > 0),
                 sequence INTEGER NOT NULL CHECK (sequence > 0),
                 block_no INTEGER NOT NULL CHECK (block_no >= 0),
                 value_kind INTEGER NOT NULL CHECK (value_kind IN (1, 2)),
                 content_sha256 BLOB NOT NULL CHECK (length(content_sha256) = 32),
                 hot_payload BLOB CHECK (hot_payload IS NULL OR length(hot_payload) = 4096),
                 created_commit_version INTEGER NOT NULL CHECK (created_commit_version > 0),
                 CHECK (value_kind = 1 OR hot_payload IS NULL),
                 PRIMARY KEY(source_volume_id, writer_epoch, sequence)
             ) WITHOUT ROWID, STRICT;
             CREATE INDEX hot_versions_settlement
               ON hot_block_versions(
                    created_commit_version, source_volume_id,
                    writer_epoch, sequence)
              WHERE value_kind = 1 AND hot_payload IS NOT NULL;

             CREATE TABLE delta_block_heads (
                 layer_id INTEGER NOT NULL REFERENCES delta_layers(layer_id) ON DELETE CASCADE,
                 shard_no INTEGER NOT NULL CHECK (shard_no >= 0),
                 block_no INTEGER NOT NULL CHECK (block_no >= 0),
                 source_volume_id TEXT NOT NULL,
                 writer_epoch INTEGER NOT NULL,
                 sequence INTEGER NOT NULL,
                 PRIMARY KEY(layer_id, shard_no, block_no),
                 CHECK (shard_no = block_no / 1024),
                 FOREIGN KEY(source_volume_id, writer_epoch, sequence)
                   REFERENCES hot_block_versions(source_volume_id, writer_epoch, sequence)
             ) WITHOUT ROWID, STRICT;
             CREATE INDEX delta_block_heads_block
               ON delta_block_heads(block_no, layer_id);

             CREATE TABLE pack_records (
                 pack_sha256 BLOB PRIMARY KEY CHECK (length(pack_sha256) = 32),
                 object_key TEXT NOT NULL UNIQUE,
                 pack_length INTEGER NOT NULL CHECK (pack_length > 0),
                 verified INTEGER NOT NULL CHECK (verified = 1),
                 lifecycle_state INTEGER NOT NULL CHECK (lifecycle_state IN (1, 2)),
                 ref_count INTEGER NOT NULL CHECK (ref_count >= 0),
                 published_commit_version INTEGER NOT NULL CHECK (published_commit_version > 0)
             ) WITHOUT ROWID, STRICT;

             CREATE TABLE cold_locations (
                 source_volume_id TEXT NOT NULL,
                 writer_epoch INTEGER NOT NULL,
                 sequence INTEGER NOT NULL,
                 pack_sha256 BLOB NOT NULL REFERENCES pack_records(pack_sha256),
                 byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
                 byte_length INTEGER NOT NULL CHECK (byte_length = 4096),
                 PRIMARY KEY(source_volume_id, writer_epoch, sequence),
                 FOREIGN KEY(source_volume_id, writer_epoch, sequence)
                   REFERENCES hot_block_versions(source_volume_id, writer_epoch, sequence)
             ) WITHOUT ROWID, STRICT;

             CREATE TRIGGER cold_location_ref_insert
             AFTER INSERT ON cold_locations
             BEGIN
               UPDATE pack_records SET ref_count = ref_count + 1
                WHERE pack_sha256 = NEW.pack_sha256 AND lifecycle_state = 1;
               SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'pack not live') END;
             END;

             CREATE TRIGGER cold_location_ref_delete
             AFTER DELETE ON cold_locations
             BEGIN
               UPDATE pack_records SET ref_count = ref_count - 1
                WHERE pack_sha256 = OLD.pack_sha256 AND ref_count > 0;
               SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'pack ref underflow') END;
             END;

             CREATE TABLE pack_members (
                 pack_sha256 BLOB NOT NULL REFERENCES pack_records(pack_sha256),
                 source_volume_id TEXT NOT NULL,
                 writer_epoch INTEGER NOT NULL,
                 sequence INTEGER NOT NULL,
                 byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
                 byte_length INTEGER NOT NULL CHECK (byte_length = 4096),
                 PRIMARY KEY(pack_sha256, source_volume_id, writer_epoch, sequence),
                 FOREIGN KEY(source_volume_id, writer_epoch, sequence)
                   REFERENCES hot_block_versions(source_volume_id, writer_epoch, sequence)
             ) WITHOUT ROWID, STRICT;

             CREATE TABLE settlement_rounds (
                 round_id INTEGER PRIMARY KEY AUTOINCREMENT,
                 generation INTEGER NOT NULL CHECK (generation > 0),
                 state INTEGER NOT NULL CHECK (state IN (1, 2)),
                 cutoff_commit_version INTEGER NOT NULL
                   CHECK (cutoff_commit_version > 0),
                 target_payload_bytes INTEGER NOT NULL
                   CHECK (target_payload_bytes > 0
                          AND target_payload_bytes % 4096 = 0),
                 settled_payload_bytes INTEGER NOT NULL
                   CHECK (settled_payload_bytes >= 0
                          AND settled_payload_bytes % 4096 = 0
                          AND settled_payload_bytes <= target_payload_bytes),
                 created_commit_version INTEGER NOT NULL
                   CHECK (created_commit_version > 0),
                 completed_commit_version INTEGER
                   CHECK (completed_commit_version > 0),
                 CHECK ((state = 1 AND completed_commit_version IS NULL) OR
                        (state = 2 AND completed_commit_version IS NOT NULL))
             ) STRICT;
             CREATE UNIQUE INDEX one_active_settlement_round
               ON settlement_rounds(state) WHERE state = 1;

             CREATE TABLE pack_intents (
                 intent_id INTEGER PRIMARY KEY AUTOINCREMENT,
                 round_id INTEGER NOT NULL REFERENCES settlement_rounds(round_id),
                 generation INTEGER NOT NULL CHECK (generation > 0),
                 state INTEGER NOT NULL CHECK (state IN (1, 2, 3, 4)),
                 object_key TEXT NOT NULL,
                 pack_sha256 BLOB NOT NULL CHECK (length(pack_sha256) = 32),
                 pack_length INTEGER NOT NULL
                   CHECK (pack_length > 0 AND pack_length <= 8388608),
                 created_commit_version INTEGER NOT NULL CHECK (created_commit_version > 0),
                 updated_commit_version INTEGER NOT NULL CHECK (updated_commit_version > 0)
             ) STRICT;
             CREATE INDEX completed_pack_intents_retention
               ON pack_intents(generation, intent_id) WHERE state = 4;

             CREATE TABLE pack_intent_members (
                 intent_id INTEGER NOT NULL REFERENCES pack_intents(intent_id),
                 source_volume_id TEXT NOT NULL,
                 writer_epoch INTEGER NOT NULL,
                 sequence INTEGER NOT NULL,
                 block_no INTEGER NOT NULL CHECK (block_no >= 0),
                 content_sha256 BLOB NOT NULL CHECK (length(content_sha256) = 32),
                 byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
                 byte_length INTEGER NOT NULL CHECK (byte_length = 4096),
                 PRIMARY KEY(intent_id, source_volume_id, writer_epoch, sequence),
                 UNIQUE(source_volume_id, writer_epoch, sequence),
                 UNIQUE(intent_id, byte_offset),
                 FOREIGN KEY(source_volume_id, writer_epoch, sequence)
                   REFERENCES hot_block_versions(source_volume_id, writer_epoch, sequence)
             ) WITHOUT ROWID, STRICT;

             CREATE TABLE snapshots (
                 snapshot_id TEXT PRIMARY KEY,
                 source_volume_id TEXT NOT NULL REFERENCES volumes(volume_id),
                 layer_id INTEGER REFERENCES delta_layers(layer_id),
                 logical_size INTEGER NOT NULL CHECK (logical_size > 0),
                 source_writer_epoch INTEGER NOT NULL CHECK (source_writer_epoch > 0),
                 state INTEGER NOT NULL CHECK (state IN (1, 2)),
                 created_commit_version INTEGER NOT NULL CHECK (created_commit_version > 0),
                 deleted_commit_version INTEGER CHECK (deleted_commit_version > 0),
                 CHECK ((state = 1 AND deleted_commit_version IS NULL) OR
                        (state = 2 AND deleted_commit_version IS NOT NULL))
             ) STRICT;

             CREATE TABLE flush_barriers (
                 volume_id TEXT NOT NULL REFERENCES volumes(volume_id),
                 writer_epoch INTEGER NOT NULL,
                 op_id TEXT NOT NULL,
                 captured_sequence INTEGER NOT NULL CHECK (captured_sequence >= 0),
                 commit_version INTEGER NOT NULL UNIQUE CHECK (commit_version > 0),
                 PRIMARY KEY(volume_id, writer_epoch, op_id)
             ) WITHOUT ROWID, STRICT;

             CREATE TABLE op_results (
                 volume_id TEXT NOT NULL REFERENCES volumes(volume_id),
                 writer_epoch INTEGER NOT NULL CHECK (writer_epoch > 0),
                 op_id TEXT NOT NULL,
                 request_fingerprint BLOB NOT NULL CHECK (length(request_fingerprint) = 32),
                 operation_kind INTEGER NOT NULL CHECK (operation_kind IN (1, 2, 3, 4, 5, 6)),
                 outcome_kind INTEGER NOT NULL CHECK (outcome_kind IN (1, 2, 3)),
                 commit_version INTEGER NOT NULL UNIQUE CHECK (commit_version > 0),
                 sequence INTEGER NOT NULL CHECK (sequence >= 0),
                 layer_id INTEGER,
                 result_epoch INTEGER NOT NULL CHECK (result_epoch >= 0),
                 PRIMARY KEY(volume_id, writer_epoch, op_id),
                 CHECK (
                   (outcome_kind = 1 AND result_epoch = 0) OR
                   (outcome_kind IN (2, 3) AND sequence = 0 AND layer_id IS NULL
                     AND result_epoch > 0)
                 )
             ) WITHOUT ROWID, STRICT;
             CREATE INDEX op_results_retention
               ON op_results(volume_id, writer_epoch, commit_version);

             CREATE TABLE gc_outbox (
                 object_key TEXT PRIMARY KEY,
                 pack_sha256 BLOB NOT NULL CHECK (length(pack_sha256) = 32),
                 state INTEGER NOT NULL CHECK (state IN (1, 2)),
                 created_commit_version INTEGER NOT NULL CHECK (created_commit_version > 0),
                 completed_commit_version INTEGER CHECK (completed_commit_version > 0),
                 CHECK ((state = 1 AND completed_commit_version IS NULL) OR
                        (state = 2 AND completed_commit_version IS NOT NULL))
             ) WITHOUT ROWID, STRICT;

             PRAGMA user_version = 7;
             COMMIT;",
		)),
		6 => sql(connection.execute_batch(
			"BEGIN EXCLUSIVE;
             ALTER TABLE volumes ADD COLUMN state INTEGER NOT NULL DEFAULT 1
               CHECK (state IN (1, 2));
             ALTER TABLE volumes ADD COLUMN retired_layer_id INTEGER;
             ALTER TABLE volumes ADD COLUMN retired_from_epoch INTEGER
               CHECK (retired_from_epoch > 0);
             ALTER TABLE volumes ADD COLUMN delete_op_id TEXT;
             ALTER TABLE volumes ADD COLUMN deleted_commit_version INTEGER
               CHECK (deleted_commit_version > 0);
             PRAGMA user_version = 7;
             COMMIT;",
		)),
		SCHEMA_VERSION => Ok(()),
		_ => Err(BlockRepositoryError::CorruptState),
	}
}

fn validate_connection(
	connection: &Connection,
	expected_synchronous: i64,
) -> Result<(), BlockRepositoryError> {
	let foreign_keys: i64 = sql(connection.query_row("PRAGMA foreign_keys", [], |row| row.get(0)))?;
	let synchronous: i64 = sql(connection.query_row("PRAGMA synchronous", [], |row| row.get(0)))?;
	let state_rows: i64 = sql(connection.query_row(
		"SELECT count(*) FROM store_state WHERE singleton = 1",
		[],
		|row| row.get(0),
	))?;
	let foreign_key_errors: i64 = sql(connection.query_row(
		"SELECT count(*) FROM pragma_foreign_key_check",
		[],
		|row| row.get(0),
	))?;
	let bad_pack_refs: i64 = sql(connection.query_row(
		"SELECT count(*) FROM pack_records p
          WHERE p.ref_count != (SELECT count(*) FROM cold_locations c
                                 WHERE c.pack_sha256 = p.pack_sha256)",
		[],
		|row| row.get(0),
	))?;
	let bad_settlement_rounds: i64 = sql(connection.query_row(
		"SELECT count(*) FROM settlement_rounds r
          WHERE r.settled_payload_bytes != coalesce((
                  SELECT sum(pi.pack_length) FROM pack_intents pi
                   WHERE pi.round_id = r.round_id AND pi.state = 4), 0)
             OR (r.state = 1 AND r.settled_payload_bytes >= r.target_payload_bytes)
             OR (r.state = 2 AND EXISTS (
                  SELECT 1 FROM pack_intents pi
                   WHERE pi.round_id = r.round_id AND pi.state < 4))",
		[],
		|row| row.get(0),
	))?;
	let bad_settlement_members: i64 = sql(connection.query_row(
		"SELECT count(*)
           FROM pack_intent_members im
           JOIN pack_intents pi ON pi.intent_id = im.intent_id
           JOIN settlement_rounds r ON r.round_id = pi.round_id
           JOIN hot_block_versions v
             ON v.source_volume_id = im.source_volume_id
            AND v.writer_epoch = im.writer_epoch AND v.sequence = im.sequence
          WHERE v.created_commit_version > r.cutoff_commit_version",
		[],
		|row| row.get(0),
	))?;
	let bad_volume_lifecycle: i64 = sql(connection.query_row(
		"SELECT count(*) FROM volumes
          WHERE NOT (
            (state = 1 AND retired_layer_id IS NULL
                       AND retired_from_epoch IS NULL
                       AND delete_op_id IS NULL
                       AND deleted_commit_version IS NULL) OR
            (state = 2 AND current_layer_id IS NULL
                       AND retired_from_epoch IS NOT NULL
                       AND delete_op_id IS NOT NULL
                       AND deleted_commit_version IS NOT NULL
                       AND writer_epoch = retired_from_epoch + 1
                       AND closed_retry_epoch = retired_from_epoch)
          )",
		[],
		|row| row.get(0),
	))?;
	if foreign_keys != 1
		|| synchronous != expected_synchronous
		|| state_rows != 1
		|| foreign_key_errors != 0
		|| bad_pack_refs != 0
		|| bad_settlement_rounds != 0
		|| bad_settlement_members != 0
		|| bad_volume_lifecycle != 0
	{
		return Err(BlockRepositoryError::CorruptState);
	}
	Ok(())
}

fn create_volume(
	connection: &mut Connection,
	volume_id: &str,
	logical_size: u64,
) -> Result<VolumeState, BlockRepositoryError> {
	validate_id(volume_id, "invalid volume ID")?;
	validate_geometry(logical_size)?;
	let transaction = immediate(connection)?;
	if exists(
		&transaction,
		"SELECT 1 FROM volumes WHERE volume_id = ?1",
		volume_id,
	)? {
		return Err(BlockRepositoryError::AlreadyExists);
	}
	let commit_version = allocate_commit(&transaction)?;
	sql(transaction.execute(
		"INSERT INTO volumes(
           volume_id, logical_size, block_size, writer_epoch, next_sequence,
           committed_sequence, current_layer_id, created_commit_version
         ) VALUES (?1, ?2, 4096, 1, 1, 0, NULL, ?3)",
		params![volume_id, sql_u64(logical_size)?, sql_u64(commit_version)?],
	))?;
	commit(transaction)?;
	Ok(VolumeState {
		volume_id: volume_id.to_owned(),
		logical_size,
		writer_epoch: 1,
		committed_sequence: 0,
		layer_id: 0,
	})
}

fn load_volume(
	connection: &Connection,
	volume_id: &str,
) -> Result<VolumeState, BlockRepositoryError> {
	validate_id(volume_id, "invalid volume ID")?;
	let row = sql(connection
		.query_row(
			"SELECT logical_size, writer_epoch,
                    coalesce((SELECT max(sequence) FROM op_results o
                               WHERE o.volume_id = volumes.volume_id
                                 AND o.writer_epoch = volumes.writer_epoch
                                 AND o.outcome_kind = 1
                                 AND o.operation_kind IN (1, 4, 5, 6)), 0),
                    coalesce(current_layer_id, 0), state
             FROM volumes WHERE volume_id = ?1",
			[volume_id],
			|row| {
				Ok((
					row.get::<_, i64>(0)?,
					row.get::<_, i64>(1)?,
					row.get::<_, i64>(2)?,
					row.get::<_, i64>(3)?,
					row.get::<_, i64>(4)?,
				))
			},
		)
		.optional())?
	.ok_or(BlockRepositoryError::VolumeNotFound)?;
	if row.4 == VOLUME_RETIRED {
		return Err(BlockRepositoryError::VolumeRetired);
	}
	if row.4 != VOLUME_ACTIVE {
		return Err(BlockRepositoryError::CorruptState);
	}
	Ok(VolumeState {
		volume_id: volume_id.to_owned(),
		logical_size: positive_u64(row.0)?,
		writer_epoch: positive_u64(row.1)?,
		committed_sequence: nonnegative_u64(row.2)?,
		layer_id: nonnegative_u64(row.3)?,
	})
}

fn acquire_writer(
	connection: &mut Connection,
	request: &AcquireWriterRequest,
) -> Result<AcquireWriterResult, BlockRepositoryError> {
	validate_id(&request.volume_id, "invalid volume ID")?;
	validate_id(&request.op_id, "invalid operation ID")?;
	if request.expected_epoch == 0 {
		return Err(BlockRepositoryError::InvalidArgument(
			"expected epoch must be non-zero",
		));
	}
	let fingerprint = acquire_writer_fingerprint(request);
	let transaction = immediate(connection)?;
	let volume = load_volume_tx(&transaction, &request.volume_id)?;
	ensure_retry_window_open(&volume, request.expected_epoch)?;
	if let Some(stored) = load_stored_result(
		&transaction,
		&request.volume_id,
		request.expected_epoch,
		&request.op_id,
	)? {
		if stored.kind != OP_ACQUIRE_WRITER || stored.fingerprint != fingerprint {
			return Err(BlockRepositoryError::OperationIdMismatch);
		}
		let result = decode_acquire_writer_result(&stored, true)?;
		commit(transaction)?;
		return Ok(result);
	}
	let commit_version = allocate_commit(&transaction)?;
	let outcome = if request.expected_epoch == volume.writer_epoch {
		let new_epoch = volume
			.writer_epoch
			.checked_add(1)
			.ok_or(BlockRepositoryError::SequenceExhausted)?;
		sql(transaction.execute(
			"UPDATE volumes SET writer_epoch = ?2, next_sequence = 1,
                                committed_sequence = 0
              WHERE volume_id = ?1",
			params![request.volume_id, sql_u64(new_epoch)?],
		))?;
		AcquireWriterOutcome::Acquired { new_epoch }
	} else {
		AcquireWriterOutcome::StaleEpoch {
			current_epoch: volume.writer_epoch,
		}
	};
	let (outcome_kind, result_epoch) = match outcome {
		AcquireWriterOutcome::Acquired { new_epoch } => (OUTCOME_EPOCH_ROTATED, new_epoch),
		AcquireWriterOutcome::StaleEpoch { current_epoch } => (OUTCOME_STALE_EPOCH, current_epoch),
	};
	sql(transaction.execute(
		"INSERT INTO op_results(
           volume_id, writer_epoch, op_id, request_fingerprint,
           operation_kind, outcome_kind, commit_version, sequence,
           layer_id, result_epoch
         ) VALUES (?1, ?2, ?3, ?4, 3, ?5, ?6, 0, NULL, ?7)",
		params![
			request.volume_id,
			sql_u64(request.expected_epoch)?,
			request.op_id,
			fingerprint.as_slice(),
			outcome_kind,
			sql_u64(commit_version)?,
			sql_u64(result_epoch)?
		],
	))?;
	commit(transaction)?;
	Ok(AcquireWriterResult {
		commit_version,
		replayed: false,
		outcome,
	})
}

fn commit_write(
	connection: &mut Connection,
	request: &CommitWriteRequest,
	#[cfg(feature = "fault-injection")] crash_probe: Option<&CrashProbe>,
) -> Result<CommitWriteResult, BlockRepositoryError> {
	#[cfg(feature = "fault-injection")]
	let during_probe = crash_probe.filter(|probe| probe.point == CrashPoint::DuringWriteCommit);
	#[cfg(feature = "fault-injection")]
	if let Some(probe) = during_probe {
		let marker = probe.marker.clone();
		connection.commit_hook(Some(move || {
			stop_for_crash_probe(&marker, CrashPoint::DuringWriteCommit);
			false
		}));
	}
	let result = commit_write_transaction(
		connection,
		request,
		#[cfg(feature = "fault-injection")]
		crash_probe,
	);
	#[cfg(feature = "fault-injection")]
	if during_probe.is_some() {
		connection.commit_hook(None::<fn() -> bool>);
	}
	result
}

#[allow(clippy::if_not_else, clippy::too_many_lines)]
fn commit_range_write(
	connection: &mut Connection,
	request: &CommitRangeWriteRequest,
) -> Result<CommitRangeWriteResult, BlockRepositoryError> {
	let mut results = commit_range_write_batch(
		connection,
		&[request],
		#[cfg(feature = "fault-injection")]
		None,
	)?;
	results.pop().ok_or(BlockRepositoryError::CorruptState)
}

#[allow(clippy::if_not_else, clippy::too_many_lines)]
fn commit_range_write_batch(
	connection: &mut Connection,
	requests: &[&CommitRangeWriteRequest],
	#[cfg(feature = "fault-injection")] crash_probe: Option<&CrashProbe>,
) -> Result<Vec<CommitRangeWriteResult>, BlockRepositoryError> {
	#[cfg(feature = "fault-injection")]
	let during_probe = crash_probe.filter(|probe| probe.point == CrashPoint::DuringRangeCommit);
	#[cfg(feature = "fault-injection")]
	if let Some(probe) = during_probe {
		let marker = probe.marker.clone();
		connection.commit_hook(Some(move || {
			stop_for_crash_probe(&marker, CrashPoint::DuringRangeCommit);
			false
		}));
	}
	let result = commit_range_write_batch_transaction(
		connection,
		requests,
		#[cfg(feature = "fault-injection")]
		crash_probe,
	);
	#[cfg(feature = "fault-injection")]
	if during_probe.is_some() {
		connection.commit_hook(None::<fn() -> bool>);
	}
	result
}

#[allow(clippy::if_not_else, clippy::too_many_lines)]
fn commit_range_write_batch_transaction(
	connection: &mut Connection,
	requests: &[&CommitRangeWriteRequest],
	#[cfg(feature = "fault-injection")] crash_probe: Option<&CrashProbe>,
) -> Result<Vec<CommitRangeWriteResult>, BlockRepositoryError> {
	let first = requests
		.first()
		.ok_or(BlockRepositoryError::InvalidArgument("empty write batch"))?;
	for request in requests {
		validate_range_write(request)?;
		if request.volume_id != first.volume_id || request.writer_epoch != first.writer_epoch {
			return Err(BlockRepositoryError::InvalidArgument(
				"write batch crossed a volume or epoch boundary",
			));
		}
	}

	let transaction = immediate(connection)?;
	let volume = load_volume_tx(&transaction, &first.volume_id)?;
	ensure_retry_window_open(&volume, first.writer_epoch)?;
	for request in requests {
		validate_write_range(volume.logical_size, request.offset, request.bytes.len())?;
	}
	let mut writable_layer = None;
	let mut results = Vec::with_capacity(requests.len());
	for request in requests {
		let fingerprint = range_write_fingerprint(request);
		if let Some(stored) = load_stored_result(
			&transaction,
			&request.volume_id,
			request.writer_epoch,
			&request.op_id,
		)? {
			if stored.kind != OP_RANGE_WRITE || stored.fingerprint != fingerprint {
				return Err(BlockRepositoryError::OperationIdMismatch);
			}
			results.push(CommitRangeWriteResult {
				commit_version: stored.commit_version,
				replayed: true,
				outcome: decode_range_write_outcome(&stored, request)?,
			});
			continue;
		}

		let block_count = u64::try_from(request.bytes.len() / BLOCK_SIZE_USIZE)
			.map_err(|_| BlockRepositoryError::InvalidArgument("write range is too large"))?;
		let outcome = if volume.writer_epoch != request.writer_epoch {
			RangeWriteOutcome::StaleEpoch {
				current_epoch: volume.writer_epoch,
			}
		} else {
			let first_block = request.offset / BLOCK_SIZE;
			let (first_sequence, last_sequence) = allocate_commit_range(&transaction, block_count)?;
			let mut first_version = None;
			let mut last_version = None;
			for (block_offset, bytes) in request.bytes.chunks_exact(BLOCK_SIZE_USIZE).enumerate() {
				let sequence = first_sequence
					.checked_add(u64::try_from(block_offset).map_err(|_| {
						BlockRepositoryError::InvalidArgument("write range is too large")
					})?)
					.ok_or(BlockRepositoryError::SequenceExhausted)?;
				let version = BlockVersion {
					epoch: request.writer_epoch,
					sequence,
				};
				let layer_id = if let Some(layer_id) = writable_layer {
					layer_id
				} else {
					let layer_id = ensure_mutable_layer(
						&transaction,
						&request.volume_id,
						volume.layer_id,
						sequence,
					)?;
					writable_layer = Some(layer_id);
					layer_id
				};
				let block_no = first_block
					.checked_add(u64::try_from(block_offset).map_err(|_| {
						BlockRepositoryError::InvalidArgument("write range is too large")
					})?)
					.ok_or(BlockRepositoryError::InvalidArgument(
						"write range exceeds the volume",
					))?;
				insert_data_version(
					&transaction,
					&request.volume_id,
					version,
					block_no,
					bytes,
					layer_id,
				)?;
				first_version.get_or_insert(version);
				last_version = Some(version);
			}
			if last_version.is_none_or(|version| version.sequence != last_sequence) {
				return Err(BlockRepositoryError::CorruptState);
			}
			RangeWriteOutcome::Applied {
				first_version: first_version.ok_or(BlockRepositoryError::CorruptState)?,
				last_version: last_version.ok_or(BlockRepositoryError::CorruptState)?,
				block_count,
				layer_id: writable_layer.ok_or(BlockRepositoryError::CorruptState)?,
			}
		};
		let commit_version = match &outcome {
			RangeWriteOutcome::Applied { last_version, .. } => last_version.sequence,
			RangeWriteOutcome::StaleEpoch { .. } => allocate_commit(&transaction)?,
		};
		insert_range_write_result(
			&transaction,
			request,
			&fingerprint,
			commit_version,
			&outcome,
		)?;
		results.push(CommitRangeWriteResult {
			commit_version,
			replayed: false,
			outcome,
		});
	}
	#[cfg(feature = "fault-injection")]
	if crash_probe.is_some_and(|probe| probe.point == CrashPoint::BeforeRangeCommit) {
		let probe = crash_probe.expect("probe checked above");
		stop_for_crash_probe(&probe.marker, CrashPoint::BeforeRangeCommit);
	}
	commit(transaction)?;
	#[cfg(feature = "fault-injection")]
	if crash_probe.is_some_and(|probe| probe.point == CrashPoint::AfterRangeCommit) {
		let probe = crash_probe.expect("probe checked above");
		stop_for_crash_probe(&probe.marker, CrashPoint::AfterRangeCommit);
	}
	Ok(results)
}

fn insert_data_version(
	transaction: &Transaction<'_>,
	source_volume_id: &str,
	version: BlockVersion,
	block_no: u64,
	bytes: &[u8],
	layer_id: u64,
) -> Result<(), BlockRepositoryError> {
	let hash = Sha256::digest(bytes);
	sql(transaction.execute(
		"INSERT INTO hot_block_versions(
           source_volume_id, writer_epoch, sequence, block_no,
           value_kind, content_sha256, hot_payload, created_commit_version
         ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7)",
		params![
			source_volume_id,
			sql_u64(version.epoch)?,
			sql_u64(version.sequence)?,
			sql_u64(block_no)?,
			hash.as_slice(),
			bytes,
			sql_u64(version.sequence)?
		],
	))?;
	sql(transaction.execute(
		"INSERT INTO delta_block_heads(
           layer_id, shard_no, block_no, source_volume_id, writer_epoch, sequence
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(layer_id, shard_no, block_no) DO UPDATE SET
           source_volume_id = excluded.source_volume_id,
           writer_epoch = excluded.writer_epoch,
           sequence = excluded.sequence",
		params![
			sql_u64(layer_id)?,
			sql_u64(block_no / DELTA_SHARD_BLOCKS)?,
			sql_u64(block_no)?,
			source_volume_id,
			sql_u64(version.epoch)?,
			sql_u64(version.sequence)?
		],
	))?;
	Ok(())
}

fn ensure_mutable_layer(
	transaction: &Transaction<'_>,
	volume_id: &str,
	current_layer_id: u64,
	commit_version: u64,
) -> Result<u64, BlockRepositoryError> {
	if current_layer_id != 0 {
		let layer = sql(transaction
			.query_row(
				"SELECT state, owner_volume_id FROM delta_layers WHERE layer_id = ?1",
				[sql_u64(current_layer_id)?],
				|row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
			)
			.optional())?
		.ok_or(BlockRepositoryError::CorruptState)?;
		match layer {
			(LAYER_MUTABLE, Some(owner)) if owner == volume_id => return Ok(current_layer_id),
			(LAYER_SEALED, _) => {}
			_ => return Err(BlockRepositoryError::CorruptState),
		}
	}
	sql(transaction.execute(
		"INSERT INTO delta_layers(
           parent_layer_id, state, owner_volume_id, created_commit_version,
           sealed_commit_version
         ) VALUES (?1, 1, ?2, ?3, NULL)",
		params![
			optional_sql_u64(current_layer_id)?,
			volume_id,
			sql_u64(commit_version)?
		],
	))?;
	let layer_id = positive_u64(transaction.last_insert_rowid())?;
	if sql(transaction.execute(
		"UPDATE volumes SET current_layer_id = ?2 WHERE volume_id = ?1",
		params![volume_id, sql_u64(layer_id)?],
	))? != 1
	{
		return Err(BlockRepositoryError::CorruptState);
	}
	Ok(layer_id)
}

#[allow(clippy::if_not_else, clippy::too_many_lines)]
fn commit_write_transaction(
	connection: &mut Connection,
	request: &CommitWriteRequest,
	#[cfg(feature = "fault-injection")] crash_probe: Option<&CrashProbe>,
) -> Result<CommitWriteResult, BlockRepositoryError> {
	validate_write(request)?;
	let fingerprint = write_fingerprint(request);
	let transaction = immediate(connection)?;
	let volume = load_volume_tx(&transaction, &request.volume_id)?;
	ensure_retry_window_open(&volume, request.writer_epoch)?;
	if let Some(stored) = load_stored_result(
		&transaction,
		&request.volume_id,
		request.writer_epoch,
		&request.op_id,
	)? {
		if stored.kind != OP_WRITE || stored.fingerprint != fingerprint {
			return Err(BlockRepositoryError::OperationIdMismatch);
		}
		let outcome = decode_write_outcome(&stored, request.writer_epoch)?;
		commit(transaction)?;
		return Ok(CommitWriteResult {
			commit_version: stored.commit_version,
			replayed: true,
			outcome,
		});
	}
	validate_block_no(volume.logical_size, request.block_no)?;
	let commit_version = allocate_commit(&transaction)?;
	let outcome = if volume.writer_epoch != request.writer_epoch {
		WriteOutcome::StaleEpoch {
			current_epoch: volume.writer_epoch,
		}
	} else {
		let sequence = commit_version;
		let version = BlockVersion {
			epoch: request.writer_epoch,
			sequence,
		};
		let layer_id = ensure_mutable_layer(
			&transaction,
			&request.volume_id,
			volume.layer_id,
			commit_version,
		)?;
		let hash = Sha256::digest(&request.bytes);
		sql(transaction.execute(
			"INSERT INTO hot_block_versions(
               source_volume_id, writer_epoch, sequence, block_no,
               value_kind, content_sha256, hot_payload, created_commit_version
             ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7)",
			params![
				request.volume_id,
				sql_u64(version.epoch)?,
				sql_u64(version.sequence)?,
				sql_u64(request.block_no)?,
				hash.as_slice(),
				request.bytes,
				sql_u64(commit_version)?
			],
		))?;
		sql(transaction.execute(
			"INSERT INTO delta_block_heads(
               layer_id, shard_no, block_no, source_volume_id, writer_epoch, sequence
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(layer_id, shard_no, block_no) DO UPDATE SET
               source_volume_id = excluded.source_volume_id,
               writer_epoch = excluded.writer_epoch,
               sequence = excluded.sequence",
			params![
				sql_u64(layer_id)?,
				sql_u64(request.block_no / DELTA_SHARD_BLOCKS)?,
				sql_u64(request.block_no)?,
				request.volume_id,
				sql_u64(version.epoch)?,
				sql_u64(version.sequence)?
			],
		))?;
		WriteOutcome::Applied { version, layer_id }
	};
	insert_write_result(
		&transaction,
		request,
		&fingerprint,
		commit_version,
		&outcome,
	)?;
	#[cfg(feature = "fault-injection")]
	if crash_probe.is_some_and(|probe| probe.point == CrashPoint::BeforeWriteCommit) {
		let probe = crash_probe.expect("probe checked above");
		stop_for_crash_probe(&probe.marker, CrashPoint::BeforeWriteCommit);
	}
	commit(transaction)?;
	#[cfg(feature = "fault-injection")]
	if crash_probe.is_some_and(|probe| probe.point == CrashPoint::AfterWriteCommit) {
		let probe = crash_probe.expect("probe checked above");
		stop_for_crash_probe(&probe.marker, CrashPoint::AfterWriteCommit);
	}
	Ok(CommitWriteResult {
		commit_version,
		replayed: false,
		outcome,
	})
}

#[allow(clippy::if_not_else, clippy::too_many_lines)]
fn commit_discard(
	connection: &mut Connection,
	request: &DiscardRequest,
) -> Result<DiscardResult, BlockRepositoryError> {
	validate_discard(request)?;
	let fingerprint = discard_fingerprint(request);
	let transaction = immediate(connection)?;
	let volume = load_volume_tx(&transaction, &request.volume_id)?;
	ensure_retry_window_open(&volume, request.writer_epoch)?;
	if let Some(stored) = load_stored_result(
		&transaction,
		&request.volume_id,
		request.writer_epoch,
		&request.op_id,
	)? {
		if stored.kind != OP_DISCARD || stored.fingerprint != fingerprint {
			return Err(BlockRepositoryError::OperationIdMismatch);
		}
		let outcome = decode_write_outcome(&stored, request.writer_epoch)?;
		commit(transaction)?;
		return Ok(DiscardResult {
			commit_version: stored.commit_version,
			replayed: true,
			outcome,
		});
	}
	validate_block_no(volume.logical_size, request.block_no)?;
	let commit_version = allocate_commit(&transaction)?;
	let outcome = if volume.writer_epoch != request.writer_epoch {
		WriteOutcome::StaleEpoch {
			current_epoch: volume.writer_epoch,
		}
	} else {
		let sequence = commit_version;
		let version = BlockVersion {
			epoch: request.writer_epoch,
			sequence,
		};
		let layer_id = ensure_mutable_layer(
			&transaction,
			&request.volume_id,
			volume.layer_id,
			commit_version,
		)?;
		insert_discard_version(
			&transaction,
			&request.volume_id,
			version,
			request.block_no,
			layer_id,
		)?;
		WriteOutcome::Applied { version, layer_id }
	};
	insert_discard_result(
		&transaction,
		request,
		&fingerprint,
		commit_version,
		&outcome,
	)?;
	reconcile_dead_versions_and_packs(&transaction, commit_version)?;
	commit(transaction)?;
	Ok(DiscardResult {
		commit_version,
		replayed: false,
		outcome,
	})
}

#[allow(clippy::if_not_else, clippy::too_many_lines)]
fn commit_range_discard(
	connection: &mut Connection,
	request: &DiscardRangeRequest,
) -> Result<DiscardRangeResult, BlockRepositoryError> {
	validate_range_discard(request)?;
	let fingerprint = range_discard_fingerprint(request);
	let transaction = immediate(connection)?;
	let volume = load_volume_tx(&transaction, &request.volume_id)?;
	ensure_retry_window_open(&volume, request.writer_epoch)?;
	if let Some(stored) = load_stored_result(
		&transaction,
		&request.volume_id,
		request.writer_epoch,
		&request.op_id,
	)? {
		if stored.kind != OP_RANGE_DISCARD || stored.fingerprint != fingerprint {
			return Err(BlockRepositoryError::OperationIdMismatch);
		}
		let outcome = decode_range_discard_outcome(&stored, request)?;
		commit(transaction)?;
		return Ok(DiscardRangeResult {
			commit_version: stored.commit_version,
			replayed: true,
			outcome,
		});
	}

	validate_discard_range(volume.logical_size, request.offset, request.length)?;
	let block_count = request.length / BLOCK_SIZE;
	let outcome = if volume.writer_epoch != request.writer_epoch {
		RangeWriteOutcome::StaleEpoch {
			current_epoch: volume.writer_epoch,
		}
	} else {
		let first_block = request.offset / BLOCK_SIZE;
		let visible_data_blocks = load_visible_data_blocks_in_range(
			&transaction,
			&request.volume_id,
			first_block,
			block_count,
		)?;
		let (first_sequence, last_sequence) = allocate_commit_range(&transaction, block_count)?;
		let layer_id = ensure_mutable_layer(
			&transaction,
			&request.volume_id,
			volume.layer_id,
			first_sequence,
		)?;
		for block_no in visible_data_blocks {
			let block_offset = block_no
				.checked_sub(first_block)
				.ok_or(BlockRepositoryError::CorruptState)?;
			let sequence = first_sequence
				.checked_add(block_offset)
				.ok_or(BlockRepositoryError::SequenceExhausted)?;
			insert_discard_version(
				&transaction,
				&request.volume_id,
				BlockVersion {
					epoch: request.writer_epoch,
					sequence,
				},
				block_no,
				layer_id,
			)?;
		}
		RangeWriteOutcome::Applied {
			first_version: BlockVersion {
				epoch: request.writer_epoch,
				sequence: first_sequence,
			},
			last_version: BlockVersion {
				epoch: request.writer_epoch,
				sequence: last_sequence,
			},
			block_count,
			layer_id,
		}
	};
	let commit_version = match &outcome {
		RangeWriteOutcome::Applied { last_version, .. } => last_version.sequence,
		RangeWriteOutcome::StaleEpoch { .. } => allocate_commit(&transaction)?,
	};
	insert_range_discard_result(
		&transaction,
		request,
		&fingerprint,
		commit_version,
		&outcome,
	)?;
	reconcile_dead_versions_and_packs(&transaction, commit_version)?;
	commit(transaction)?;
	Ok(DiscardRangeResult {
		commit_version,
		replayed: false,
		outcome,
	})
}

fn load_visible_data_blocks_in_range(
	transaction: &Transaction<'_>,
	volume_id: &str,
	first_block: u64,
	block_count: u64,
) -> Result<Vec<u64>, BlockRepositoryError> {
	let end_block =
		first_block
			.checked_add(block_count)
			.ok_or(BlockRepositoryError::InvalidArgument(
				"discard range exceeds the volume",
			))?;
	let last_block = end_block
		.checked_sub(1)
		.ok_or(BlockRepositoryError::CorruptState)?;
	let mut statement = sql(transaction.prepare(
		"WITH RECURSIVE chain(layer_id, depth) AS (
           SELECT current_layer_id, 0 FROM volumes
             WHERE volume_id = ?1 AND current_layer_id IS NOT NULL
           UNION ALL
           SELECT delta_layers.parent_layer_id, chain.depth + 1
             FROM delta_layers JOIN chain
               ON delta_layers.layer_id = chain.layer_id
            WHERE delta_layers.parent_layer_id IS NOT NULL
         ),
         ranked(block_no, value_kind, rank) AS (
           SELECT h.block_no, v.value_kind,
                  row_number() OVER (
                    PARTITION BY h.block_no ORDER BY chain.depth ASC)
             FROM chain
             JOIN delta_block_heads h ON h.layer_id = chain.layer_id
             JOIN hot_block_versions v
               ON v.source_volume_id = h.source_volume_id
              AND v.writer_epoch = h.writer_epoch AND v.sequence = h.sequence
            WHERE h.shard_no BETWEEN ?2 AND ?3
              AND h.block_no >= ?4 AND h.block_no < ?5
         )
         SELECT block_no, value_kind FROM ranked WHERE rank = 1 ORDER BY block_no",
	))?;
	let rows = sql(statement.query_map(
		params![
			volume_id,
			sql_u64(first_block / DELTA_SHARD_BLOCKS)?,
			sql_u64(last_block / DELTA_SHARD_BLOCKS)?,
			sql_u64(first_block)?,
			sql_u64(end_block)?
		],
		|row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
	))?;
	let mut data_blocks = Vec::new();
	let mut previous = None;
	for row in rows {
		let (block_no, value_kind) = sql(row)?;
		let block_no = nonnegative_u64(block_no)?;
		if block_no < first_block
			|| block_no >= end_block
			|| previous.is_some_and(|previous| block_no <= previous)
			|| !matches!(value_kind, VALUE_DATA | VALUE_DISCARD)
		{
			return Err(BlockRepositoryError::CorruptState);
		}
		previous = Some(block_no);
		if value_kind == VALUE_DATA {
			data_blocks.push(block_no);
		}
	}
	Ok(data_blocks)
}

fn insert_discard_version(
	transaction: &Transaction<'_>,
	source_volume_id: &str,
	version: BlockVersion,
	block_no: u64,
	layer_id: u64,
) -> Result<(), BlockRepositoryError> {
	let zero_sha256 = Sha256::digest([0_u8; BLOCK_SIZE_USIZE]);
	sql(transaction.execute(
		"INSERT INTO hot_block_versions(
           source_volume_id, writer_epoch, sequence, block_no,
           value_kind, content_sha256, hot_payload, created_commit_version
         ) VALUES (?1, ?2, ?3, ?4, 2, ?5, NULL, ?6)",
		params![
			source_volume_id,
			sql_u64(version.epoch)?,
			sql_u64(version.sequence)?,
			sql_u64(block_no)?,
			zero_sha256.as_slice(),
			sql_u64(version.sequence)?
		],
	))?;
	sql(transaction.execute(
		"INSERT INTO delta_block_heads(
           layer_id, shard_no, block_no, source_volume_id, writer_epoch, sequence
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(layer_id, shard_no, block_no) DO UPDATE SET
           source_volume_id = excluded.source_volume_id,
           writer_epoch = excluded.writer_epoch,
           sequence = excluded.sequence",
		params![
			sql_u64(layer_id)?,
			sql_u64(block_no / DELTA_SHARD_BLOCKS)?,
			sql_u64(block_no)?,
			source_volume_id,
			sql_u64(version.epoch)?,
			sql_u64(version.sequence)?
		],
	))?;
	Ok(())
}

fn read_block(
	connection: &Connection,
	volume_id: &str,
	block_no: u64,
) -> Result<BlockData, BlockRepositoryError> {
	let volume = load_volume(connection, volume_id)?;
	validate_block_no(volume.logical_size, block_no)?;
	let mut statement = sql(connection.prepare(
		"WITH RECURSIVE chain(layer_id, depth) AS (
           SELECT current_layer_id, 0 FROM volumes
             WHERE volume_id = ?1 AND current_layer_id IS NOT NULL
           UNION ALL
           SELECT delta_layers.parent_layer_id, chain.depth + 1
             FROM delta_layers JOIN chain
               ON delta_layers.layer_id = chain.layer_id
             WHERE delta_layers.parent_layer_id IS NOT NULL
         )
         SELECT h.source_volume_id, h.writer_epoch, h.sequence, h.block_no,
                v.value_kind, v.content_sha256, v.hot_payload,
                p.object_key, c.byte_offset, c.byte_length, c.pack_sha256,
                p.pack_length
           FROM chain
           JOIN delta_block_heads h ON h.layer_id = chain.layer_id
           JOIN hot_block_versions v
             ON v.source_volume_id = h.source_volume_id
            AND v.writer_epoch = h.writer_epoch AND v.sequence = h.sequence
           LEFT JOIN cold_locations c
             ON c.source_volume_id = h.source_volume_id
            AND c.writer_epoch = h.writer_epoch AND c.sequence = h.sequence
           LEFT JOIN pack_records p ON p.pack_sha256 = c.pack_sha256
          WHERE h.block_no = ?2 AND h.shard_no = ?3
          ORDER BY chain.depth ASC LIMIT 1",
	))?;
	let row = sql(statement
		.query_row(
			params![
				volume_id,
				sql_u64(block_no)?,
				sql_u64(block_no / DELTA_SHARD_BLOCKS)?
			],
			|row| {
				Ok((
					row.get::<_, String>(0)?,
					row.get::<_, i64>(1)?,
					row.get::<_, i64>(2)?,
					row.get::<_, i64>(3)?,
					row.get::<_, i64>(4)?,
					row.get::<_, Vec<u8>>(5)?,
					row.get::<_, Option<Vec<u8>>>(6)?,
					row.get::<_, Option<String>>(7)?,
					row.get::<_, Option<i64>>(8)?,
					row.get::<_, Option<i64>>(9)?,
					row.get::<_, Option<Vec<u8>>>(10)?,
					row.get::<_, Option<i64>>(11)?,
				))
			},
		)
		.optional())?;
	let Some(row) = row else {
		return Ok(BlockData::Zero);
	};
	let content_sha256 = hash_array(&row.5)?;
	if row.6.as_ref().is_some_and(|bytes| {
		bytes.len() != BLOCK_SIZE_USIZE || Sha256::digest(bytes).as_slice() != content_sha256
	}) {
		return Err(BlockRepositoryError::CorruptState);
	}
	let cold = decode_cold(row.7, row.8, row.9, row.10, row.11)?;
	if row.4 == VALUE_DISCARD {
		let zero_sha256: [u8; SHA256_BYTES] = Sha256::digest([0_u8; BLOCK_SIZE_USIZE]).into();
		if row.6.is_some() || cold.is_some() || content_sha256 != zero_sha256 {
			return Err(BlockRepositoryError::CorruptState);
		}
		return Ok(BlockData::Discarded {
			source_volume_id: row.0,
			version: BlockVersion {
				epoch: positive_u64(row.1)?,
				sequence: positive_u64(row.2)?,
			},
			block_no: nonnegative_u64(row.3)?,
		});
	}
	if row.4 != VALUE_DATA || row.6.is_none() && cold.is_none() {
		return Err(BlockRepositoryError::CorruptState);
	}
	Ok(BlockData::Version {
		source_volume_id: row.0,
		version: BlockVersion {
			epoch: positive_u64(row.1)?,
			sequence: positive_u64(row.2)?,
		},
		block_no: nonnegative_u64(row.3)?,
		content_sha256,
		hot_bytes: row.6,
		cold,
	})
}

fn capture_flush(
	connection: &mut Connection,
	request: &FlushRequest,
	#[cfg(feature = "fault-injection")] crash_probe: Option<&CrashProbe>,
) -> Result<FlushResult, BlockRepositoryError> {
	#[cfg(feature = "fault-injection")]
	let during_probe = crash_probe.filter(|probe| probe.point == CrashPoint::DuringFlushCommit);
	#[cfg(feature = "fault-injection")]
	if let Some(probe) = during_probe {
		let marker = probe.marker.clone();
		connection.commit_hook(Some(move || {
			stop_for_crash_probe(&marker, CrashPoint::DuringFlushCommit);
			false
		}));
	}
	let result = capture_flush_transaction(
		connection,
		request,
		#[cfg(feature = "fault-injection")]
		crash_probe,
	);
	#[cfg(feature = "fault-injection")]
	if during_probe.is_some() {
		connection.commit_hook(None::<fn() -> bool>);
	}
	result
}

fn capture_flush_transaction(
	connection: &mut Connection,
	request: &FlushRequest,
	#[cfg(feature = "fault-injection")] crash_probe: Option<&CrashProbe>,
) -> Result<FlushResult, BlockRepositoryError> {
	validate_id(&request.volume_id, "invalid volume ID")?;
	validate_id(&request.op_id, "invalid operation ID")?;
	if request.writer_epoch == 0 {
		return Err(BlockRepositoryError::InvalidArgument(
			"writer epoch must be non-zero",
		));
	}
	let fingerprint = flush_fingerprint(request);
	let transaction = immediate(connection)?;
	let volume = load_volume_tx(&transaction, &request.volume_id)?;
	ensure_retry_window_open(&volume, request.writer_epoch)?;
	if let Some(stored) = load_stored_result(
		&transaction,
		&request.volume_id,
		request.writer_epoch,
		&request.op_id,
	)? {
		if stored.kind != OP_FLUSH || stored.fingerprint != fingerprint {
			return Err(BlockRepositoryError::OperationIdMismatch);
		}
		let result = decode_flush_result(&stored, true)?;
		commit(transaction)?;
		return Ok(result);
	}
	if request.writer_epoch == volume.writer_epoch && request.submitted_sequence != 0 {
		let covered = sql(transaction.query_row(
			"SELECT EXISTS(
               SELECT 1 FROM op_results
                WHERE volume_id = ?1 AND writer_epoch = ?2
                  AND sequence = ?3 AND outcome_kind = 1
                  AND operation_kind IN (1, 4, 5, 6))",
			params![
				request.volume_id,
				sql_u64(request.writer_epoch)?,
				sql_u64(request.submitted_sequence)?
			],
			|row| row.get::<_, bool>(0),
		))?;
		if !covered {
			return Err(BlockRepositoryError::InvalidArgument(
				"flush boundary version has not committed",
			));
		}
	}
	let commit_version = allocate_commit(&transaction)?;
	let (outcome, captured, result_epoch) = if request.writer_epoch == volume.writer_epoch {
		sql(transaction.execute(
			"INSERT INTO flush_barriers(
               volume_id, writer_epoch, op_id, captured_sequence, commit_version
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
			params![
				request.volume_id,
				sql_u64(request.writer_epoch)?,
				request.op_id,
				sql_u64(request.submitted_sequence)?,
				sql_u64(commit_version)?
			],
		))?;
		(OUTCOME_APPLIED, request.submitted_sequence, 0)
	} else {
		(OUTCOME_STALE_EPOCH, 0, volume.writer_epoch)
	};
	sql(transaction.execute(
		"INSERT INTO op_results(
           volume_id, writer_epoch, op_id, request_fingerprint,
           operation_kind, outcome_kind, commit_version, sequence,
           layer_id, result_epoch
         ) VALUES (?1, ?2, ?3, ?4, 2, ?5, ?6, ?7, NULL, ?8)",
		params![
			request.volume_id,
			sql_u64(request.writer_epoch)?,
			request.op_id,
			fingerprint.as_slice(),
			outcome,
			sql_u64(commit_version)?,
			sql_u64(captured)?,
			sql_u64(result_epoch)?
		],
	))?;
	#[cfg(feature = "fault-injection")]
	if crash_probe.is_some_and(|probe| probe.point == CrashPoint::BeforeFlushCommit) {
		let probe = crash_probe.expect("probe checked above");
		stop_for_crash_probe(&probe.marker, CrashPoint::BeforeFlushCommit);
	}
	commit(transaction)?;
	#[cfg(feature = "fault-injection")]
	if crash_probe.is_some_and(|probe| probe.point == CrashPoint::AfterFlushCommit) {
		let probe = crash_probe.expect("probe checked above");
		stop_for_crash_probe(&probe.marker, CrashPoint::AfterFlushCommit);
	}
	Ok(FlushResult {
		commit_version,
		replayed: false,
		captured_sequence: captured,
		stale_current_epoch: (result_epoch != 0).then_some(result_epoch),
	})
}

fn acquire_settler(connection: &mut Connection) -> Result<u64, BlockRepositoryError> {
	let transaction = immediate(connection)?;
	let current: i64 = sql(transaction.query_row(
		"SELECT settler_generation FROM store_state WHERE singleton = 1",
		[],
		|row| row.get(0),
	))?;
	let generation = nonnegative_u64(current)?
		.checked_add(1)
		.ok_or(BlockRepositoryError::SequenceExhausted)?;
	let _commit_version = allocate_commit(&transaction)?;
	sql(transaction.execute(
		"UPDATE store_state SET settler_generation = ?1 WHERE singleton = 1",
		[sql_u64(generation)?],
	))?;
	commit(transaction)?;
	Ok(generation)
}

#[allow(clippy::too_many_lines)]
fn resume_or_prepare_pack(
	connection: &mut Connection,
	generation: u64,
	max_bytes: u64,
	low_watermark_bytes: u64,
) -> Result<Option<PackIntent>, BlockRepositoryError> {
	validate_pack_budget(max_bytes)?;
	if !low_watermark_bytes.is_multiple_of(BLOCK_SIZE) {
		return Err(BlockRepositoryError::InvalidArgument(
			"settlement low watermark must be 4 KiB aligned",
		));
	}
	let transaction = immediate(connection)?;
	require_settler_generation(&transaction, generation)?;
	let existing = sql(transaction
		.query_row(
			"SELECT pi.intent_id, pi.round_id
               FROM pack_intents pi
               JOIN settlement_rounds r ON r.round_id = pi.round_id
              WHERE pi.state < 4 AND r.state = 1
              ORDER BY pi.intent_id LIMIT 1",
			[],
			|row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
		)
		.optional())?;
	if let Some((intent_id, round_id)) = existing {
		let intent_id = positive_u64(intent_id)?;
		let round_id = positive_u64(round_id)?;
		let commit_version = allocate_commit(&transaction)?;
		if sql(transaction.execute(
			"UPDATE settlement_rounds SET generation = ?2
              WHERE round_id = ?1 AND state = 1",
			params![sql_u64(round_id)?, sql_u64(generation)?],
		))? != 1
		{
			return Err(BlockRepositoryError::CorruptState);
		}
		sql(transaction.execute(
			"UPDATE pack_intents SET generation = ?2, updated_commit_version = ?3
             WHERE intent_id = ?1",
			params![
				sql_u64(intent_id)?,
				sql_u64(generation)?,
				sql_u64(commit_version)?
			],
		))?;
		let intent = load_pack_intent(&transaction, intent_id)?;
		commit(transaction)?;
		return Ok(Some(intent));
	}

	let active_round = sql(transaction
		.query_row(
			"SELECT round_id, generation, cutoff_commit_version,
                    target_payload_bytes, settled_payload_bytes
               FROM settlement_rounds WHERE state = 1",
			[],
			|row| {
				Ok((
					row.get::<_, i64>(0)?,
					row.get::<_, i64>(1)?,
					row.get::<_, i64>(2)?,
					row.get::<_, i64>(3)?,
					row.get::<_, i64>(4)?,
				))
			},
		)
		.optional())?;
	let (round_id, cutoff_commit_version, target_payload_bytes, settled_payload_bytes) =
		if let Some(round) = active_round {
			let round_id = positive_u64(round.0)?;
			let round_generation = positive_u64(round.1)?;
			if round_generation != generation {
				let _claim_commit_version = allocate_commit(&transaction)?;
				if sql(transaction.execute(
					"UPDATE settlement_rounds SET generation = ?2
                      WHERE round_id = ?1 AND state = 1",
					params![sql_u64(round_id)?, sql_u64(generation)?],
				))? != 1
				{
					return Err(BlockRepositoryError::CorruptState);
				}
			}
			(
				round_id,
				positive_u64(round.2)?,
				positive_u64(round.3)?,
				nonnegative_u64(round.4)?,
			)
		} else {
			// This is the only recursive live-set reconciliation in the
			// beginning of a round. Every later pack uses the fixed cutoff and
			// a bounded ordered range, so pack size does not hide repeated
			// whole-image scans.
			let reconcile_commit_version = allocate_commit(&transaction)?;
			reconcile_dead_versions_and_packs(&transaction, reconcile_commit_version)?;
			let hot_payload_bytes: i64 = sql(transaction.query_row(
				"SELECT coalesce(sum(length(v.hot_payload)), 0)
                   FROM hot_block_versions v
                   LEFT JOIN cold_locations c
                     ON c.source_volume_id = v.source_volume_id
                    AND c.writer_epoch = v.writer_epoch
                    AND c.sequence = v.sequence
                  WHERE v.value_kind = 1 AND v.hot_payload IS NOT NULL
                    AND c.source_volume_id IS NULL",
				[],
				|row| row.get(0),
			))?;
			let hot_payload_bytes = nonnegative_u64(hot_payload_bytes)?;
			if hot_payload_bytes <= low_watermark_bytes {
				commit(transaction)?;
				return Ok(None);
			}
			let cutoff_commit_version = current_commit_version(&transaction)?;
			let target_payload_bytes = hot_payload_bytes
				.checked_sub(low_watermark_bytes)
				.ok_or(BlockRepositoryError::CorruptState)?;
			let created_commit_version = allocate_commit(&transaction)?;
			sql(transaction.execute(
				"INSERT INTO settlement_rounds(
                   generation, state, cutoff_commit_version,
                   target_payload_bytes, settled_payload_bytes,
                   created_commit_version, completed_commit_version
                 ) VALUES (?1, 1, ?2, ?3, 0, ?4, NULL)",
				params![
					sql_u64(generation)?,
					sql_u64(cutoff_commit_version)?,
					sql_u64(target_payload_bytes)?,
					sql_u64(created_commit_version)?
				],
			))?;
			(
				positive_u64(transaction.last_insert_rowid())?,
				cutoff_commit_version,
				target_payload_bytes,
				0,
			)
		};

	let remaining_payload_bytes = target_payload_bytes
		.checked_sub(settled_payload_bytes)
		.ok_or(BlockRepositoryError::CorruptState)?;
	if remaining_payload_bytes == 0 {
		finish_settlement_round(&transaction, round_id, generation)?;
		commit(transaction)?;
		return Ok(None);
	}

	let limit = max_bytes.min(remaining_payload_bytes) / BLOCK_SIZE;
	let mut statement = sql(transaction.prepare(
		"SELECT v.source_volume_id, v.writer_epoch, v.sequence, v.block_no,
                v.content_sha256, v.hot_payload
           FROM hot_block_versions v
           LEFT JOIN cold_locations c
             ON c.source_volume_id = v.source_volume_id
            AND c.writer_epoch = v.writer_epoch AND c.sequence = v.sequence
           LEFT JOIN pack_intent_members im
             ON im.source_volume_id = v.source_volume_id
            AND im.writer_epoch = v.writer_epoch AND im.sequence = v.sequence
          WHERE v.value_kind = 1 AND v.hot_payload IS NOT NULL
            AND c.source_volume_id IS NULL
            AND im.source_volume_id IS NULL
            AND v.created_commit_version <= ?1
          ORDER BY v.created_commit_version, v.source_volume_id,
                   v.writer_epoch, v.sequence
          LIMIT ?2",
	))?;
	let rows = sql(statement.query_map(
		params![sql_u64(cutoff_commit_version)?, sql_u64(limit)?],
		|row| {
			Ok((
				row.get::<_, String>(0)?,
				row.get::<_, i64>(1)?,
				row.get::<_, i64>(2)?,
				row.get::<_, i64>(3)?,
				row.get::<_, Vec<u8>>(4)?,
				row.get::<_, Vec<u8>>(5)?,
			))
		},
	))?;
	let mut members = Vec::new();
	for row in rows {
		let row = sql(row)?;
		let content_sha256 = hash_array(&row.4)?;
		if row.5.len() != BLOCK_SIZE_USIZE || Sha256::digest(&row.5).as_slice() != content_sha256 {
			return Err(BlockRepositoryError::CorruptState);
		}
		members.push(PackIntentMember {
			source_volume_id: row.0,
			version: BlockVersion {
				epoch: positive_u64(row.1)?,
				sequence: positive_u64(row.2)?,
			},
			block_no: nonnegative_u64(row.3)?,
			content_sha256,
			offset: u64::try_from(members.len())
				.map_err(|_| BlockRepositoryError::SequenceExhausted)?
				.checked_mul(BLOCK_SIZE)
				.ok_or(BlockRepositoryError::SequenceExhausted)?,
			hot_bytes: Some(row.5),
		});
	}
	drop(statement);
	if members.is_empty() {
		finish_settlement_round(&transaction, round_id, generation)?;
		commit(transaction)?;
		return Ok(None);
	}
	let pack = pack_bytes(&members)?;
	let pack_sha256: [u8; SHA256_BYTES] = Sha256::digest(&pack).into();
	let base_object_key = format!("extent/sha256/{}", hex(&pack_sha256));
	let existing_lifecycle: Option<i64> = sql(transaction
		.query_row(
			"SELECT lifecycle_state FROM pack_records WHERE pack_sha256 = ?1",
			[pack_sha256.as_slice()],
			|row| row.get(0),
		)
		.optional())?;
	if existing_lifecycle.is_some_and(|state| state != 1) {
		return Err(BlockRepositoryError::Unavailable);
	}
	let commit_version = allocate_commit(&transaction)?;
	let has_prior_incarnation = sql(transaction
		.query_row(
			"SELECT 1 FROM gc_outbox WHERE pack_sha256 = ?1 LIMIT 1",
			[pack_sha256.as_slice()],
			|_| Ok(()),
		)
		.optional())?
	.is_some();
	let object_key = if has_prior_incarnation {
		format!("{base_object_key}/r{commit_version}")
	} else {
		base_object_key
	};
	let pack_length =
		u64::try_from(pack.len()).map_err(|_| BlockRepositoryError::SequenceExhausted)?;
	sql(transaction.execute(
		"INSERT INTO pack_intents(
           round_id, generation, state, object_key, pack_sha256, pack_length,
           created_commit_version, updated_commit_version
         ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?6)",
		params![
			sql_u64(round_id)?,
			sql_u64(generation)?,
			object_key,
			pack_sha256.as_slice(),
			sql_u64(pack_length)?,
			sql_u64(commit_version)?
		],
	))?;
	let intent_id = positive_u64(transaction.last_insert_rowid())?;
	for member in &members {
		sql(transaction.execute(
			"INSERT INTO pack_intent_members(
               intent_id, source_volume_id, writer_epoch, sequence, block_no,
               content_sha256, byte_offset, byte_length
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 4096)",
			params![
				sql_u64(intent_id)?,
				member.source_volume_id,
				sql_u64(member.version.epoch)?,
				sql_u64(member.version.sequence)?,
				sql_u64(member.block_no)?,
				member.content_sha256.as_slice(),
				sql_u64(member.offset)?
			],
		))?;
	}
	let intent = load_pack_intent(&transaction, intent_id)?;
	commit(transaction)?;
	Ok(Some(intent))
}

fn finish_settlement_round(
	transaction: &Transaction<'_>,
	round_id: u64,
	generation: u64,
) -> Result<(), BlockRepositoryError> {
	let commit_version = allocate_commit(transaction)?;
	if sql(transaction.execute(
		"UPDATE settlement_rounds
            SET state = 2, completed_commit_version = ?3
          WHERE round_id = ?1 AND generation = ?2 AND state = 1",
		params![
			sql_u64(round_id)?,
			sql_u64(generation)?,
			sql_u64(commit_version)?
		],
	))? != 1
	{
		return Err(BlockRepositoryError::CorruptState);
	}
	// End-of-round reconciliation removes versions that became unreachable
	// after the cutoff and derives exact-key GC tasks once, not once per pack.
	reconcile_dead_versions_and_packs(transaction, commit_version)
}

fn verify_pack_intent(
	connection: &mut Connection,
	generation: u64,
	intent_id: u64,
) -> Result<(), BlockRepositoryError> {
	let transaction = immediate(connection)?;
	require_settler_generation(&transaction, generation)?;
	let state = intent_state_and_generation(&transaction, intent_id, generation)?;
	if state == PackIntentState::Verified {
		commit(transaction)?;
		return Ok(());
	}
	if state != PackIntentState::Prepared {
		return Err(BlockRepositoryError::InvalidArgument(
			"pack intent is not prepared",
		));
	}
	let commit_version = allocate_commit(&transaction)?;
	sql(transaction.execute(
		"UPDATE pack_intents SET state = 2, updated_commit_version = ?2
         WHERE intent_id = ?1",
		params![sql_u64(intent_id)?, sql_u64(commit_version)?],
	))?;
	commit(transaction)
}

#[allow(clippy::too_many_lines)]
fn publish_pack_intent(
	connection: &mut Connection,
	generation: u64,
	intent_id: u64,
) -> Result<(), BlockRepositoryError> {
	let transaction = immediate(connection)?;
	require_settler_generation(&transaction, generation)?;
	let state = intent_state_and_generation(&transaction, intent_id, generation)?;
	if state == PackIntentState::Published {
		commit(transaction)?;
		return Ok(());
	}
	if state != PackIntentState::Verified {
		return Err(BlockRepositoryError::InvalidArgument(
			"pack intent is not verified",
		));
	}
	let intent = load_pack_intent(&transaction, intent_id)?;
	let commit_version = allocate_commit(&transaction)?;
	sql(transaction.execute(
		"INSERT INTO pack_records(
           pack_sha256, object_key, pack_length, verified, lifecycle_state,
           ref_count, published_commit_version
         ) VALUES (?1, ?2, ?3, 1, 1, 0, ?4)
         ON CONFLICT(pack_sha256) DO NOTHING",
		params![
			intent.pack_sha256.as_slice(),
			intent.object_key,
			sql_u64(intent.pack_length)?,
			sql_u64(commit_version)?
		],
	))?;
	let stored_pack = sql(transaction.query_row(
		"SELECT object_key, pack_length, lifecycle_state
           FROM pack_records WHERE pack_sha256 = ?1",
		[intent.pack_sha256.as_slice()],
		|row| {
			Ok((
				row.get::<_, String>(0)?,
				row.get::<_, i64>(1)?,
				row.get::<_, i64>(2)?,
			))
		},
	))?;
	if stored_pack.0 != intent.object_key
		|| positive_u64(stored_pack.1)? != intent.pack_length
		|| stored_pack.2 != 1
	{
		return Err(BlockRepositoryError::ColdLocationConflict);
	}
	for member in &intent.members {
		sql(transaction.execute(
			"INSERT INTO cold_locations(
               source_volume_id, writer_epoch, sequence, pack_sha256,
               byte_offset, byte_length
             ) VALUES (?1, ?2, ?3, ?4, ?5, 4096)
             ON CONFLICT(source_volume_id, writer_epoch, sequence) DO NOTHING",
			params![
				member.source_volume_id,
				sql_u64(member.version.epoch)?,
				sql_u64(member.version.sequence)?,
				intent.pack_sha256.as_slice(),
				sql_u64(member.offset)?
			],
		))?;
		let location = sql(transaction.query_row(
			"SELECT pack_sha256, byte_offset FROM cold_locations
             WHERE source_volume_id = ?1 AND writer_epoch = ?2 AND sequence = ?3",
			params![
				member.source_volume_id,
				sql_u64(member.version.epoch)?,
				sql_u64(member.version.sequence)?
			],
			|row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, i64>(1)?)),
		))?;
		if hash_array(&location.0)? != intent.pack_sha256
			|| nonnegative_u64(location.1)? != member.offset
		{
			return Err(BlockRepositoryError::ColdLocationConflict);
		}
		sql(transaction.execute(
			"INSERT INTO pack_members(
               pack_sha256, source_volume_id, writer_epoch, sequence,
               byte_offset, byte_length
             ) VALUES (?1, ?2, ?3, ?4, ?5, 4096)
             ON CONFLICT(pack_sha256, source_volume_id, writer_epoch, sequence)
             DO NOTHING",
			params![
				intent.pack_sha256.as_slice(),
				member.source_volume_id,
				sql_u64(member.version.epoch)?,
				sql_u64(member.version.sequence)?,
				sql_u64(member.offset)?
			],
		))?;
	}
	sql(transaction.execute(
		"UPDATE pack_intents SET state = 3, updated_commit_version = ?2
         WHERE intent_id = ?1",
		params![sql_u64(intent_id)?, sql_u64(commit_version)?],
	))?;
	commit(transaction)
}

fn evict_pack_intent_member(
	connection: &mut Connection,
	generation: u64,
	intent_id: u64,
	member: &PackIntentMember,
) -> Result<bool, BlockRepositoryError> {
	Ok(evict_pack_intent_members(
		connection,
		generation,
		intent_id,
		std::slice::from_ref(member),
	)? == 1)
}

fn evict_pack_intent_members(
	connection: &mut Connection,
	generation: u64,
	intent_id: u64,
	members: &[PackIntentMember],
) -> Result<u64, BlockRepositoryError> {
	if members.is_empty() {
		return Err(BlockRepositoryError::InvalidArgument(
			"pack eviction needs at least one member",
		));
	}
	let transaction = immediate(connection)?;
	require_settler_generation(&transaction, generation)?;
	if intent_state_and_generation(&transaction, intent_id, generation)?
		!= PackIntentState::Published
	{
		return Err(BlockRepositoryError::InvalidArgument(
			"pack intent is not published",
		));
	}
	let mut changed = 0_u64;
	for member in members {
		let valid: Option<i64> = sql(transaction
			.query_row(
				"SELECT 1 FROM pack_intent_members im
                 JOIN cold_locations c
                   ON c.source_volume_id = im.source_volume_id
                  AND c.writer_epoch = im.writer_epoch AND c.sequence = im.sequence
                 WHERE im.intent_id = ?1 AND im.source_volume_id = ?2
                   AND im.writer_epoch = ?3 AND im.sequence = ?4
                   AND im.content_sha256 = ?5",
				params![
					sql_u64(intent_id)?,
					member.source_volume_id,
					sql_u64(member.version.epoch)?,
					sql_u64(member.version.sequence)?,
					member.content_sha256.as_slice()
				],
				|row| row.get(0),
			)
			.optional())?;
		if valid.is_none() {
			return Err(BlockRepositoryError::ColdLocationConflict);
		}
		changed = changed
			.checked_add(
				u64::try_from(sql(transaction.execute(
					"UPDATE hot_block_versions SET hot_payload = NULL
                 WHERE source_volume_id = ?1 AND writer_epoch = ?2 AND sequence = ?3
                   AND hot_payload IS NOT NULL",
					params![
						member.source_volume_id,
						sql_u64(member.version.epoch)?,
						sql_u64(member.version.sequence)?
					],
				))?)
				.map_err(|_| BlockRepositoryError::SequenceExhausted)?,
			)
			.ok_or(BlockRepositoryError::SequenceExhausted)?;
	}
	commit(transaction)?;
	Ok(changed)
}

fn complete_pack_intent(
	connection: &mut Connection,
	generation: u64,
	intent_id: u64,
) -> Result<(), BlockRepositoryError> {
	let transaction = immediate(connection)?;
	require_settler_generation(&transaction, generation)?;
	let state = intent_state_and_generation(&transaction, intent_id, generation)?;
	if state == PackIntentState::Complete {
		commit(transaction)?;
		return Ok(());
	}
	if state != PackIntentState::Published {
		return Err(BlockRepositoryError::InvalidArgument(
			"pack intent is not published",
		));
	}
	let remaining: i64 = sql(transaction.query_row(
		"SELECT count(*) FROM pack_intent_members im
         JOIN hot_block_versions v
           ON v.source_volume_id = im.source_volume_id
          AND v.writer_epoch = im.writer_epoch AND v.sequence = im.sequence
         WHERE im.intent_id = ?1 AND v.hot_payload IS NOT NULL",
		[sql_u64(intent_id)?],
		|row| row.get(0),
	))?;
	if remaining != 0 {
		return Err(BlockRepositoryError::InvalidArgument(
			"pack intent still has hot payloads",
		));
	}
	let round = sql(transaction.query_row(
		"SELECT round_id, pack_length FROM pack_intents WHERE intent_id = ?1",
		[sql_u64(intent_id)?],
		|row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
	))?;
	let round_id = positive_u64(round.0)?;
	let pack_length = positive_u64(round.1)?;
	let commit_version = allocate_commit(&transaction)?;
	if sql(transaction.execute(
		"UPDATE pack_intents SET state = 4, updated_commit_version = ?2
         WHERE intent_id = ?1 AND state = 3",
		params![sql_u64(intent_id)?, sql_u64(commit_version)?],
	))? != 1
	{
		return Err(BlockRepositoryError::CorruptState);
	}
	if sql(transaction.execute(
		"UPDATE settlement_rounds
            SET settled_payload_bytes = settled_payload_bytes + ?3
          WHERE round_id = ?1 AND generation = ?2 AND state = 1
            AND settled_payload_bytes + ?3 <= target_payload_bytes",
		params![
			sql_u64(round_id)?,
			sql_u64(generation)?,
			sql_u64(pack_length)?
		],
	))? != 1
	{
		return Err(BlockRepositoryError::CorruptState);
	}
	let round_progress = sql(transaction.query_row(
		"SELECT settled_payload_bytes, target_payload_bytes
           FROM settlement_rounds WHERE round_id = ?1 AND state = 1",
		[sql_u64(round_id)?],
		|row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
	))?;
	if nonnegative_u64(round_progress.0)? == positive_u64(round_progress.1)? {
		finish_settlement_round(&transaction, round_id, generation)?;
	}
	commit(transaction)
}

fn load_pack_intent(
	transaction: &Transaction<'_>,
	intent_id: u64,
) -> Result<PackIntent, BlockRepositoryError> {
	let header = sql(transaction
		.query_row(
			"SELECT round_id, generation, state, object_key, pack_sha256, pack_length
             FROM pack_intents WHERE intent_id = ?1",
			[sql_u64(intent_id)?],
			|row| {
				Ok((
					row.get::<_, i64>(0)?,
					row.get::<_, i64>(1)?,
					row.get::<_, i64>(2)?,
					row.get::<_, String>(3)?,
					row.get::<_, Vec<u8>>(4)?,
					row.get::<_, i64>(5)?,
				))
			},
		)
		.optional())?
	.ok_or(BlockRepositoryError::CorruptState)?;
	let state = decode_pack_intent_state(header.2)?;
	let mut statement = sql(transaction.prepare(
		"SELECT im.source_volume_id, im.writer_epoch, im.sequence, im.block_no,
                im.content_sha256, im.byte_offset, v.hot_payload
         FROM pack_intent_members im
         JOIN hot_block_versions v
           ON v.source_volume_id = im.source_volume_id
          AND v.writer_epoch = im.writer_epoch AND v.sequence = im.sequence
         WHERE im.intent_id = ?1 ORDER BY im.byte_offset",
	))?;
	let rows = sql(statement.query_map([sql_u64(intent_id)?], |row| {
		Ok((
			row.get::<_, String>(0)?,
			row.get::<_, i64>(1)?,
			row.get::<_, i64>(2)?,
			row.get::<_, i64>(3)?,
			row.get::<_, Vec<u8>>(4)?,
			row.get::<_, i64>(5)?,
			row.get::<_, Option<Vec<u8>>>(6)?,
		))
	}))?;
	let mut members = Vec::new();
	for row in rows {
		let row = sql(row)?;
		let content_sha256 = hash_array(&row.4)?;
		if row.6.as_ref().is_some_and(|bytes| {
			bytes.len() != BLOCK_SIZE_USIZE || Sha256::digest(bytes).as_slice() != content_sha256
		}) {
			return Err(BlockRepositoryError::CorruptState);
		}
		members.push(PackIntentMember {
			source_volume_id: row.0,
			version: BlockVersion {
				epoch: positive_u64(row.1)?,
				sequence: positive_u64(row.2)?,
			},
			block_no: nonnegative_u64(row.3)?,
			content_sha256,
			offset: nonnegative_u64(row.5)?,
			hot_bytes: row.6,
		});
	}
	let pack_length = positive_u64(header.5)?;
	if members.is_empty()
		|| members.iter().enumerate().any(|(index, member)| {
			member.offset != u64::try_from(index).unwrap_or(u64::MAX) * BLOCK_SIZE
		}) || u64::try_from(members.len())
		.ok()
		.and_then(|count| count.checked_mul(BLOCK_SIZE))
		!= Some(pack_length)
		|| matches!(state, PackIntentState::Prepared | PackIntentState::Verified)
			&& members.iter().any(|member| member.hot_bytes.is_none())
	{
		return Err(BlockRepositoryError::CorruptState);
	}
	if members.iter().all(|member| member.hot_bytes.is_some()) {
		let bytes = pack_bytes(&members)?;
		if Sha256::digest(&bytes).as_slice() != header.4 {
			return Err(BlockRepositoryError::CorruptState);
		}
	}
	Ok(PackIntent {
		intent_id,
		round_id: positive_u64(header.0)?,
		generation: positive_u64(header.1)?,
		state,
		object_key: header.3,
		pack_sha256: hash_array(&header.4)?,
		pack_length,
		members,
	})
}

fn require_settler_generation(
	transaction: &Transaction<'_>,
	generation: u64,
) -> Result<(), BlockRepositoryError> {
	if generation == 0 {
		return Err(BlockRepositoryError::InvalidArgument(
			"settler generation must be non-zero",
		));
	}
	let current: i64 = sql(transaction.query_row(
		"SELECT settler_generation FROM store_state WHERE singleton = 1",
		[],
		|row| row.get(0),
	))?;
	if positive_u64(current)? != generation {
		return Err(BlockRepositoryError::InvalidArgument(
			"stale settler generation",
		));
	}
	Ok(())
}

fn intent_state_and_generation(
	transaction: &Transaction<'_>,
	intent_id: u64,
	generation: u64,
) -> Result<PackIntentState, BlockRepositoryError> {
	let row = sql(transaction
		.query_row(
			"SELECT pi.state, pi.generation, r.state, r.generation
               FROM pack_intents pi
               JOIN settlement_rounds r ON r.round_id = pi.round_id
              WHERE pi.intent_id = ?1",
			[sql_u64(intent_id)?],
			|row| {
				Ok((
					row.get::<_, i64>(0)?,
					row.get::<_, i64>(1)?,
					row.get::<_, i64>(2)?,
					row.get::<_, i64>(3)?,
				))
			},
		)
		.optional())?
	.ok_or(BlockRepositoryError::InvalidArgument(
		"pack intent does not exist",
	))?;
	let state = decode_pack_intent_state(row.0)?;
	if positive_u64(row.1)? != generation
		|| (state != PackIntentState::Complete
			&& (row.2 != 1 || positive_u64(row.3)? != generation))
	{
		return Err(BlockRepositoryError::InvalidArgument(
			"stale pack intent generation",
		));
	}
	Ok(state)
}

fn decode_pack_intent_state(value: i64) -> Result<PackIntentState, BlockRepositoryError> {
	match value {
		1 => Ok(PackIntentState::Prepared),
		2 => Ok(PackIntentState::Verified),
		3 => Ok(PackIntentState::Published),
		4 => Ok(PackIntentState::Complete),
		_ => Err(BlockRepositoryError::CorruptState),
	}
}

fn validate_pack_budget(max_bytes: u64) -> Result<(), BlockRepositoryError> {
	if !(BLOCK_SIZE..=8 * 1024 * 1024).contains(&max_bytes) || !max_bytes.is_multiple_of(BLOCK_SIZE)
	{
		return Err(BlockRepositoryError::InvalidArgument(
			"pack byte budget is outside aligned 4 KiB..8 MiB",
		));
	}
	Ok(())
}

fn pack_bytes(members: &[PackIntentMember]) -> Result<Vec<u8>, BlockRepositoryError> {
	let capacity = members
		.len()
		.checked_mul(BLOCK_SIZE_USIZE)
		.ok_or(BlockRepositoryError::SequenceExhausted)?;
	let mut bytes = Vec::with_capacity(capacity);
	for member in members {
		let hot = member
			.hot_bytes
			.as_ref()
			.ok_or(BlockRepositoryError::HotVersionNotFound)?;
		bytes.extend_from_slice(hot);
	}
	Ok(bytes)
}

fn select_hot(
	connection: &Connection,
	max_bytes: u64,
) -> Result<Vec<HotBlock>, BlockRepositoryError> {
	if !(BLOCK_SIZE..=8 * 1024 * 1024).contains(&max_bytes) {
		return Err(BlockRepositoryError::InvalidArgument(
			"pack byte budget is outside 4 KiB..8 MiB",
		));
	}
	let limit = max_bytes / BLOCK_SIZE;
	let mut statement = sql(connection.prepare(
		"SELECT v.source_volume_id, v.writer_epoch, v.sequence, v.block_no,
                v.content_sha256, v.hot_payload
           FROM hot_block_versions v
           LEFT JOIN cold_locations c
             ON c.source_volume_id = v.source_volume_id
            AND c.writer_epoch = v.writer_epoch AND c.sequence = v.sequence
          WHERE v.value_kind = 1 AND v.hot_payload IS NOT NULL
            AND c.source_volume_id IS NULL
          ORDER BY v.created_commit_version, v.source_volume_id, v.writer_epoch, v.sequence
          LIMIT ?1",
	))?;
	let rows = sql(statement.query_map([sql_u64(limit)?], |row| {
		Ok((
			row.get::<_, String>(0)?,
			row.get::<_, i64>(1)?,
			row.get::<_, i64>(2)?,
			row.get::<_, i64>(3)?,
			row.get::<_, Vec<u8>>(4)?,
			row.get::<_, Vec<u8>>(5)?,
		))
	}))?;
	let mut blocks = Vec::new();
	for row in rows {
		let row = sql(row)?;
		let hash = hash_array(&row.4)?;
		if row.5.len() != BLOCK_SIZE_USIZE || Sha256::digest(&row.5).as_slice() != hash {
			return Err(BlockRepositoryError::CorruptState);
		}
		blocks.push(HotBlock {
			source_volume_id: row.0,
			version: BlockVersion {
				epoch: positive_u64(row.1)?,
				sequence: positive_u64(row.2)?,
			},
			block_no: nonnegative_u64(row.3)?,
			content_sha256: hash,
			bytes: row.5,
		});
	}
	Ok(blocks)
}

fn select_evictable(
	connection: &Connection,
	limit: u64,
) -> Result<Vec<HotBlock>, BlockRepositoryError> {
	if limit == 0 || limit > 2_048 {
		return Err(BlockRepositoryError::InvalidArgument(
			"eviction batch is outside 1..2048",
		));
	}
	let mut statement = sql(connection.prepare(
		"SELECT v.source_volume_id, v.writer_epoch, v.sequence, v.block_no,
                v.content_sha256, v.hot_payload
           FROM hot_block_versions v
           JOIN cold_locations c
             ON c.source_volume_id = v.source_volume_id
            AND c.writer_epoch = v.writer_epoch AND c.sequence = v.sequence
          WHERE v.value_kind = 1 AND v.hot_payload IS NOT NULL
          ORDER BY v.created_commit_version, v.source_volume_id, v.writer_epoch, v.sequence
          LIMIT ?1",
	))?;
	let rows = sql(statement.query_map([sql_u64(limit)?], |row| {
		Ok((
			row.get::<_, String>(0)?,
			row.get::<_, i64>(1)?,
			row.get::<_, i64>(2)?,
			row.get::<_, i64>(3)?,
			row.get::<_, Vec<u8>>(4)?,
			row.get::<_, Vec<u8>>(5)?,
		))
	}))?;
	let mut blocks = Vec::new();
	for row in rows {
		let row = sql(row)?;
		let content_sha256 = hash_array(&row.4)?;
		if row.5.len() != BLOCK_SIZE_USIZE || Sha256::digest(&row.5).as_slice() != content_sha256 {
			return Err(BlockRepositoryError::CorruptState);
		}
		blocks.push(HotBlock {
			source_volume_id: row.0,
			version: BlockVersion {
				epoch: positive_u64(row.1)?,
				sequence: positive_u64(row.2)?,
			},
			block_no: nonnegative_u64(row.3)?,
			content_sha256,
			bytes: row.5,
		});
	}
	Ok(blocks)
}

#[allow(clippy::too_many_lines)]
fn publish_cold(
	connection: &mut Connection,
	object_key: &str,
	pack_sha256: &[u8; SHA256_BYTES],
	pack_length: u64,
	members: &[(HotBlock, u64)],
) -> Result<(), BlockRepositoryError> {
	validate_object_key(object_key)?;
	if pack_length == 0
		|| pack_length > 8 * 1024 * 1024
		|| !pack_length.is_multiple_of(BLOCK_SIZE)
		|| members.is_empty()
	{
		return Err(BlockRepositoryError::InvalidArgument("invalid pack"));
	}
	let transaction = immediate(connection)?;
	let commit_version = allocate_commit(&transaction)?;
	let existing = sql(transaction
		.query_row(
			"SELECT object_key, pack_length, lifecycle_state
               FROM pack_records WHERE pack_sha256 = ?1",
			[pack_sha256.as_slice()],
			|row| {
				Ok((
					row.get::<_, String>(0)?,
					row.get::<_, i64>(1)?,
					row.get::<_, i64>(2)?,
				))
			},
		)
		.optional())?;
	if let Some((existing_key, existing_length, lifecycle_state)) = existing {
		if existing_key != object_key
			|| positive_u64(existing_length)? != pack_length
			|| lifecycle_state != 1
		{
			return Err(BlockRepositoryError::ColdLocationConflict);
		}
	} else {
		sql(transaction.execute(
			"INSERT INTO pack_records(
               pack_sha256, object_key, pack_length, verified, lifecycle_state,
               ref_count, published_commit_version
             ) VALUES (?1, ?2, ?3, 1, 1, 0, ?4)",
			params![
				pack_sha256.as_slice(),
				object_key,
				sql_u64(pack_length)?,
				sql_u64(commit_version)?
			],
		))?;
	}
	for (block, offset) in members {
		if block.bytes.len() != BLOCK_SIZE_USIZE
			|| Sha256::digest(&block.bytes).as_slice() != block.content_sha256
			|| !offset.is_multiple_of(BLOCK_SIZE)
			|| offset
				.checked_add(BLOCK_SIZE)
				.is_none_or(|end| end > pack_length)
		{
			return Err(BlockRepositoryError::InvalidArgument("invalid pack member"));
		}
		let durable = sql(transaction
			.query_row(
				"SELECT block_no, content_sha256, value_kind FROM hot_block_versions
                  WHERE source_volume_id = ?1 AND writer_epoch = ?2 AND sequence = ?3",
				params![
					block.source_volume_id,
					sql_u64(block.version.epoch)?,
					sql_u64(block.version.sequence)?
				],
				|row| {
					Ok((
						row.get::<_, i64>(0)?,
						row.get::<_, Vec<u8>>(1)?,
						row.get::<_, i64>(2)?,
					))
				},
			)
			.optional())?
		.ok_or(BlockRepositoryError::HotVersionNotFound)?;
		if nonnegative_u64(durable.0)? != block.block_no
			|| hash_array(&durable.1)? != block.content_sha256
			|| durable.2 != VALUE_DATA
		{
			return Err(BlockRepositoryError::ColdLocationConflict);
		}
		let mut aliases = sql(transaction.prepare(
			"SELECT v.content_sha256
               FROM pack_members m
               JOIN hot_block_versions v
                 ON v.source_volume_id = m.source_volume_id
                AND v.writer_epoch = m.writer_epoch AND v.sequence = m.sequence
              WHERE m.pack_sha256 = ?1 AND m.byte_offset = ?2",
		))?;
		let alias_hashes = sql(aliases
			.query_map(params![pack_sha256.as_slice(), sql_u64(*offset)?], |row| {
				row.get::<_, Vec<u8>>(0)
			}))?;
		for alias_hash in alias_hashes {
			if hash_array(&sql(alias_hash)?)? != block.content_sha256 {
				return Err(BlockRepositoryError::ColdLocationConflict);
			}
		}
		let existing_location = sql(transaction
			.query_row(
				"SELECT pack_sha256, byte_offset, byte_length FROM cold_locations
                  WHERE source_volume_id = ?1 AND writer_epoch = ?2 AND sequence = ?3",
				params![
					block.source_volume_id,
					sql_u64(block.version.epoch)?,
					sql_u64(block.version.sequence)?
				],
				|row| {
					Ok((
						row.get::<_, Vec<u8>>(0)?,
						row.get::<_, i64>(1)?,
						row.get::<_, i64>(2)?,
					))
				},
			)
			.optional())?;
		if let Some((existing_pack, existing_offset, existing_length)) = existing_location {
			if hash_array(&existing_pack)? != *pack_sha256
				|| nonnegative_u64(existing_offset)? != *offset
				|| positive_u64(existing_length)? != BLOCK_SIZE
			{
				return Err(BlockRepositoryError::ColdLocationConflict);
			}
			continue;
		}
		sql(transaction.execute(
			"INSERT INTO cold_locations(
               source_volume_id, writer_epoch, sequence, pack_sha256,
               byte_offset, byte_length
             ) VALUES (?1, ?2, ?3, ?4, ?5, 4096)",
			params![
				block.source_volume_id,
				sql_u64(block.version.epoch)?,
				sql_u64(block.version.sequence)?,
				pack_sha256.as_slice(),
				sql_u64(*offset)?
			],
		))?;
		sql(transaction.execute(
			"INSERT INTO pack_members(
               pack_sha256, source_volume_id, writer_epoch, sequence,
               byte_offset, byte_length
             ) VALUES (?1, ?2, ?3, ?4, ?5, 4096)",
			params![
				pack_sha256.as_slice(),
				block.source_volume_id,
				sql_u64(block.version.epoch)?,
				sql_u64(block.version.sequence)?,
				sql_u64(*offset)?
			],
		))?;
	}
	commit(transaction)
}

fn evict_hot(connection: &mut Connection, block: &HotBlock) -> Result<bool, BlockRepositoryError> {
	let transaction = immediate(connection)?;
	let row = sql(transaction
		.query_row(
			"SELECT v.content_sha256, v.hot_payload IS NOT NULL,
                    c.source_volume_id IS NOT NULL
               FROM hot_block_versions v
               LEFT JOIN cold_locations c
                 ON c.source_volume_id = v.source_volume_id
                AND c.writer_epoch = v.writer_epoch AND c.sequence = v.sequence
              WHERE v.source_volume_id = ?1 AND v.writer_epoch = ?2 AND v.sequence = ?3",
			params![
				block.source_volume_id,
				sql_u64(block.version.epoch)?,
				sql_u64(block.version.sequence)?
			],
			|row| {
				Ok((
					row.get::<_, Vec<u8>>(0)?,
					row.get::<_, bool>(1)?,
					row.get::<_, bool>(2)?,
				))
			},
		)
		.optional())?
	.ok_or(BlockRepositoryError::HotVersionNotFound)?;
	if hash_array(&row.0)? != block.content_sha256 || !row.2 {
		return Err(BlockRepositoryError::ColdLocationConflict);
	}
	if row.1 {
		sql(transaction.execute(
			"UPDATE hot_block_versions SET hot_payload = NULL
              WHERE source_volume_id = ?1 AND writer_epoch = ?2 AND sequence = ?3",
			params![
				block.source_volume_id,
				sql_u64(block.version.epoch)?,
				sql_u64(block.version.sequence)?
			],
		))?;
	}
	commit(transaction)?;
	Ok(row.1)
}

fn create_snapshot(
	connection: &mut Connection,
	volume_id: &str,
	snapshot_id: &str,
	#[cfg(feature = "fault-injection")] crash_probe: Option<&CrashProbe>,
) -> Result<SnapshotState, BlockRepositoryError> {
	#[cfg(feature = "fault-injection")]
	let during_probe = crash_probe.filter(|probe| probe.point == CrashPoint::DuringSnapshotCommit);
	#[cfg(feature = "fault-injection")]
	if let Some(probe) = during_probe {
		let marker = probe.marker.clone();
		connection.commit_hook(Some(move || {
			stop_for_crash_probe(&marker, CrashPoint::DuringSnapshotCommit);
			false
		}));
	}
	let result = create_snapshot_transaction(
		connection,
		volume_id,
		snapshot_id,
		#[cfg(feature = "fault-injection")]
		crash_probe,
	);
	#[cfg(feature = "fault-injection")]
	if during_probe.is_some() {
		connection.commit_hook(None::<fn() -> bool>);
	}
	result
}

fn create_snapshot_transaction(
	connection: &mut Connection,
	volume_id: &str,
	snapshot_id: &str,
	#[cfg(feature = "fault-injection")] crash_probe: Option<&CrashProbe>,
) -> Result<SnapshotState, BlockRepositoryError> {
	validate_id(snapshot_id, "invalid snapshot ID")?;
	let transaction = immediate(connection)?;
	let volume = load_volume_tx(&transaction, volume_id)?;
	if let Some(existing) = load_snapshot_retry(&transaction, volume_id, snapshot_id)? {
		return Ok(existing);
	}
	let commit_version = allocate_commit(&transaction)?;
	let new_writer_epoch = volume
		.writer_epoch
		.checked_add(1)
		.ok_or(BlockRepositoryError::SequenceExhausted)?;
	if volume.layer_id != 0 {
		let layer = sql(transaction.query_row(
			"SELECT state, owner_volume_id FROM delta_layers WHERE layer_id = ?1",
			[sql_u64(volume.layer_id)?],
			|row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
		))?;
		match layer {
			(LAYER_MUTABLE, Some(owner)) if owner == volume_id => {
				if sql(transaction.execute(
					"UPDATE delta_layers
                        SET state = 2, sealed_commit_version = ?2
                      WHERE layer_id = ?1 AND state = 1 AND owner_volume_id = ?3",
					params![
						sql_u64(volume.layer_id)?,
						sql_u64(commit_version)?,
						volume_id
					],
				))? != 1
				{
					return Err(BlockRepositoryError::CorruptState);
				}
			}
			(LAYER_SEALED, _) => {}
			_ => return Err(BlockRepositoryError::CorruptState),
		}
	}
	sql(transaction.execute(
		"UPDATE volumes SET writer_epoch = ?2, next_sequence = 1,
                            committed_sequence = 0
          WHERE volume_id = ?1 AND writer_epoch = ?3",
		params![
			volume_id,
			sql_u64(new_writer_epoch)?,
			sql_u64(volume.writer_epoch)?
		],
	))?;
	sql(transaction.execute(
		"INSERT INTO snapshots(
           snapshot_id, source_volume_id, layer_id, logical_size,
           source_writer_epoch, state, created_commit_version,
           deleted_commit_version
         ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, NULL)",
		params![
			snapshot_id,
			volume_id,
			optional_sql_u64(volume.layer_id)?,
			sql_u64(volume.logical_size)?,
			sql_u64(new_writer_epoch)?,
			sql_u64(commit_version)?
		],
	))?;
	#[cfg(feature = "fault-injection")]
	if crash_probe.is_some_and(|probe| probe.point == CrashPoint::BeforeSnapshotCommit) {
		let probe = crash_probe.expect("probe checked above");
		stop_for_crash_probe(&probe.marker, CrashPoint::BeforeSnapshotCommit);
	}
	commit(transaction)?;
	#[cfg(feature = "fault-injection")]
	if crash_probe.is_some_and(|probe| probe.point == CrashPoint::AfterSnapshotCommit) {
		let probe = crash_probe.expect("probe checked above");
		stop_for_crash_probe(&probe.marker, CrashPoint::AfterSnapshotCommit);
	}
	Ok(SnapshotState {
		snapshot_id: snapshot_id.to_owned(),
		logical_size: volume.logical_size,
		layer_id: volume.layer_id,
		source_writer_epoch: new_writer_epoch,
	})
}

fn load_snapshot_retry(
	transaction: &Transaction<'_>,
	volume_id: &str,
	snapshot_id: &str,
) -> Result<Option<SnapshotState>, BlockRepositoryError> {
	let existing = sql(transaction
		.query_row(
			"SELECT source_volume_id, coalesce(layer_id, 0), logical_size,
                    source_writer_epoch, state
               FROM snapshots WHERE snapshot_id = ?1",
			[snapshot_id],
			|row| {
				Ok((
					row.get::<_, String>(0)?,
					row.get::<_, i64>(1)?,
					row.get::<_, i64>(2)?,
					row.get::<_, i64>(3)?,
					row.get::<_, i64>(4)?,
				))
			},
		)
		.optional())?;
	let Some(existing) = existing else {
		return Ok(None);
	};
	if existing.0 != volume_id || existing.4 != 1 {
		return Err(BlockRepositoryError::AlreadyExists);
	}
	Ok(Some(SnapshotState {
		snapshot_id: snapshot_id.to_owned(),
		logical_size: positive_u64(existing.2)?,
		layer_id: nonnegative_u64(existing.1)?,
		source_writer_epoch: positive_u64(existing.3)?,
	}))
}

fn fork_snapshot(
	connection: &mut Connection,
	snapshot_id: &str,
	child_volume_id: &str,
) -> Result<ForkResult, BlockRepositoryError> {
	validate_id(snapshot_id, "invalid snapshot ID")?;
	validate_id(child_volume_id, "invalid volume ID")?;
	let transaction = immediate(connection)?;
	if exists(
		&transaction,
		"SELECT 1 FROM volumes WHERE volume_id = ?1",
		child_volume_id,
	)? {
		return Err(BlockRepositoryError::AlreadyExists);
	}
	let snapshot = sql(transaction
		.query_row(
			"SELECT logical_size, coalesce(layer_id, 0) FROM snapshots
              WHERE snapshot_id = ?1 AND state = 1",
			[snapshot_id],
			|row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
		)
		.optional())?
	.ok_or(BlockRepositoryError::SnapshotNotFound)?;
	let logical_size = positive_u64(snapshot.0)?;
	let layer_id = nonnegative_u64(snapshot.1)?;
	let commit_version = allocate_commit(&transaction)?;
	sql(transaction.execute(
		"INSERT INTO volumes(
           volume_id, logical_size, block_size, writer_epoch, next_sequence,
           committed_sequence, current_layer_id, created_commit_version
         ) VALUES (?1, ?2, 4096, 1, 1, 0, ?3, ?4)",
		params![
			child_volume_id,
			sql_u64(logical_size)?,
			optional_sql_u64(layer_id)?,
			sql_u64(commit_version)?
		],
	))?;
	commit(transaction)?;
	Ok(ForkResult {
		volume: VolumeState {
			volume_id: child_volume_id.to_owned(),
			logical_size,
			writer_epoch: 1,
			committed_sequence: 0,
			layer_id,
		},
		inherited_layer_id: layer_id,
	})
}

fn delete_snapshot(
	connection: &mut Connection,
	snapshot_id: &str,
) -> Result<SnapshotDeleteResult, BlockRepositoryError> {
	validate_id(snapshot_id, "invalid snapshot ID")?;
	let transaction = immediate(connection)?;
	let row = sql(transaction
		.query_row(
			"SELECT coalesce(layer_id, 0), state, deleted_commit_version
               FROM snapshots WHERE snapshot_id = ?1",
			[snapshot_id],
			|row| {
				Ok((
					row.get::<_, i64>(0)?,
					row.get::<_, i64>(1)?,
					row.get::<_, Option<i64>>(2)?,
				))
			},
		)
		.optional())?
	.ok_or(BlockRepositoryError::SnapshotNotFound)?;
	let layer_id = nonnegative_u64(row.0)?;
	if row.1 == 2 {
		let commit_version = positive_u64(row.2.ok_or(BlockRepositoryError::CorruptState)?)?;
		commit(transaction)?;
		return Ok(SnapshotDeleteResult {
			snapshot_id: snapshot_id.to_owned(),
			layer_id,
			commit_version,
			replayed: true,
		});
	}
	if row.1 != 1 || row.2.is_some() {
		return Err(BlockRepositoryError::CorruptState);
	}
	let commit_version = allocate_commit(&transaction)?;
	sql(transaction.execute(
		"UPDATE snapshots SET state = 2, deleted_commit_version = ?2
          WHERE snapshot_id = ?1 AND state = 1",
		params![snapshot_id, sql_u64(commit_version)?],
	))?;
	reconcile_dead_versions_and_packs(&transaction, commit_version)?;
	commit(transaction)?;
	Ok(SnapshotDeleteResult {
		snapshot_id: snapshot_id.to_owned(),
		layer_id,
		commit_version,
		replayed: false,
	})
}

fn delete_volume(
	connection: &mut Connection,
	request: &DeleteVolumeRequest,
	#[cfg(feature = "fault-injection")] crash_probe: Option<&CrashProbe>,
) -> Result<DeleteVolumeResult, BlockRepositoryError> {
	#[cfg(feature = "fault-injection")]
	let during_probe = crash_probe.filter(|probe| probe.point == CrashPoint::DuringDeleteVolumeCommit);
	#[cfg(feature = "fault-injection")]
	if let Some(probe) = during_probe {
		let marker = probe.marker.clone();
		connection.commit_hook(Some(move || {
			stop_for_crash_probe(&marker, CrashPoint::DuringDeleteVolumeCommit);
			false
		}));
	}
	let result = delete_volume_transaction(
		connection,
		request,
		#[cfg(feature = "fault-injection")]
		crash_probe,
	);
	#[cfg(feature = "fault-injection")]
	if during_probe.is_some() {
		connection.commit_hook(None::<fn() -> bool>);
	}
	result
}

#[allow(clippy::too_many_lines)]
fn delete_volume_transaction(
	connection: &mut Connection,
	request: &DeleteVolumeRequest,
	#[cfg(feature = "fault-injection")] crash_probe: Option<&CrashProbe>,
) -> Result<DeleteVolumeResult, BlockRepositoryError> {
	validate_id(&request.volume_id, "invalid volume ID")?;
	validate_id(&request.op_id, "invalid operation ID")?;
	let transaction = immediate(connection)?;
	let row = sql(transaction
		.query_row(
			"SELECT state, writer_epoch, coalesce(current_layer_id, 0),
                    coalesce(retired_layer_id, 0), retired_from_epoch,
                    delete_op_id, deleted_commit_version, closed_retry_epoch
               FROM volumes WHERE volume_id = ?1",
			[&request.volume_id],
			|row| {
				Ok((
					row.get::<_, i64>(0)?,
					row.get::<_, i64>(1)?,
					row.get::<_, i64>(2)?,
					row.get::<_, i64>(3)?,
					row.get::<_, Option<i64>>(4)?,
					row.get::<_, Option<String>>(5)?,
					row.get::<_, Option<i64>>(6)?,
					row.get::<_, i64>(7)?,
				))
			},
		)
		.optional())?
	.ok_or(BlockRepositoryError::VolumeNotFound)?;
	let writer_epoch = positive_u64(row.1)?;
	if row.0 == VOLUME_RETIRED {
		let retired_writer_epoch = positive_u64(row.4.ok_or(BlockRepositoryError::CorruptState)?)?;
		let stored_op_id = row.5.ok_or(BlockRepositoryError::CorruptState)?;
		let commit_version = positive_u64(row.6.ok_or(BlockRepositoryError::CorruptState)?)?;
		let layer_id = nonnegative_u64(row.3)?;
		if stored_op_id != request.op_id {
			return Err(BlockRepositoryError::VolumeRetired);
		}
		let expected_fenced_epoch = retired_writer_epoch
			.checked_add(1)
			.ok_or(BlockRepositoryError::CorruptState)?;
		if writer_epoch != expected_fenced_epoch
			|| nonnegative_u64(row.7)? != retired_writer_epoch
			|| row.2 != 0
		{
			return Err(BlockRepositoryError::CorruptState);
		}
		commit(transaction)?;
		return Ok(DeleteVolumeResult {
			volume_id: request.volume_id.clone(),
			retired_writer_epoch,
			fenced_writer_epoch: writer_epoch,
			layer_id,
			commit_version,
			replayed: true,
		});
	}
	if row.0 != VOLUME_ACTIVE || row.3 != 0 || row.4.is_some() || row.5.is_some() || row.6.is_some()
	{
		return Err(BlockRepositoryError::CorruptState);
	}
	let layer_id = nonnegative_u64(row.2)?;
	let fenced_writer_epoch = writer_epoch
		.checked_add(1)
		.ok_or(BlockRepositoryError::SequenceExhausted)?;
	let commit_version = allocate_commit(&transaction)?;
	if layer_id != 0 {
		let layer = sql(transaction.query_row(
			"SELECT state, owner_volume_id FROM delta_layers WHERE layer_id = ?1",
			[sql_u64(layer_id)?],
			|row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
		))?;
		match layer {
			(LAYER_MUTABLE, Some(owner)) if owner == request.volume_id => {
				if sql(transaction.execute(
					"UPDATE delta_layers
                        SET state = 2, sealed_commit_version = ?2
                      WHERE layer_id = ?1 AND state = 1 AND owner_volume_id = ?3",
					params![
						sql_u64(layer_id)?,
						sql_u64(commit_version)?,
						request.volume_id
					],
				))? != 1
				{
					return Err(BlockRepositoryError::CorruptState);
				}
			}
			(LAYER_SEALED, _) => {}
			_ => return Err(BlockRepositoryError::CorruptState),
		}
	}
	if sql(transaction.execute(
		"UPDATE volumes
            SET state = 2, writer_epoch = ?2, next_sequence = 1,
                committed_sequence = 0, current_layer_id = NULL,
                retired_layer_id = ?3, closed_retry_epoch = ?4,
                retired_from_epoch = ?4, delete_op_id = ?5,
                deleted_commit_version = ?6
          WHERE volume_id = ?1 AND state = 1 AND writer_epoch = ?4",
		params![
			request.volume_id,
			sql_u64(fenced_writer_epoch)?,
			optional_sql_u64(layer_id)?,
			sql_u64(writer_epoch)?,
			request.op_id,
			sql_u64(commit_version)?
		],
	))? != 1
	{
		return Err(BlockRepositoryError::CorruptState);
	}
	reconcile_dead_versions_and_packs(&transaction, commit_version)?;
	#[cfg(feature = "fault-injection")]
	if crash_probe.is_some_and(|probe| probe.point == CrashPoint::BeforeDeleteVolumeCommit) {
		let probe = crash_probe.expect("probe checked above");
		stop_for_crash_probe(&probe.marker, CrashPoint::BeforeDeleteVolumeCommit);
	}
	commit(transaction)?;
	#[cfg(feature = "fault-injection")]
	if crash_probe.is_some_and(|probe| probe.point == CrashPoint::AfterDeleteVolumeCommit) {
		let probe = crash_probe.expect("probe checked above");
		stop_for_crash_probe(&probe.marker, CrashPoint::AfterDeleteVolumeCommit);
	}
	Ok(DeleteVolumeResult {
		volume_id: request.volume_id.clone(),
		retired_writer_epoch: writer_epoch,
		fenced_writer_epoch,
		layer_id,
		commit_version,
		replayed: false,
	})
}

fn close_writer_retry_window(
	connection: &mut Connection,
	volume_id: &str,
	through_epoch: u64,
) -> Result<u64, BlockRepositoryError> {
	validate_id(volume_id, "invalid volume ID")?;
	let transaction = immediate(connection)?;
	let volume = load_volume_tx(&transaction, volume_id)?;
	if through_epoch >= volume.writer_epoch {
		return Err(BlockRepositoryError::InvalidArgument(
			"retry closure must be below the current writer epoch",
		));
	}
	if through_epoch <= volume.closed_retry_epoch {
		commit(transaction)?;
		return Ok(volume.closed_retry_epoch);
	}
	let _commit_version = allocate_commit(&transaction)?;
	if sql(transaction.execute(
		"UPDATE volumes SET closed_retry_epoch = ?2
          WHERE volume_id = ?1 AND closed_retry_epoch < ?2 AND writer_epoch > ?2",
		params![volume_id, sql_u64(through_epoch)?],
	))? != 1
	{
		return Err(BlockRepositoryError::CorruptState);
	}
	commit(transaction)?;
	Ok(through_epoch)
}

fn close_settler_retry_window(
	connection: &mut Connection,
	through_generation: u64,
) -> Result<u64, BlockRepositoryError> {
	let transaction = immediate(connection)?;
	let state = sql(transaction.query_row(
		"SELECT settler_generation, closed_settler_generation
           FROM store_state WHERE singleton = 1",
		[],
		|row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
	))?;
	let current = nonnegative_u64(state.0)?;
	let closed = nonnegative_u64(state.1)?;
	if through_generation >= current && through_generation != 0 {
		return Err(BlockRepositoryError::InvalidArgument(
			"retry closure must be below the current settler generation",
		));
	}
	if through_generation <= closed {
		commit(transaction)?;
		return Ok(closed);
	}
	let _commit_version = allocate_commit(&transaction)?;
	if sql(transaction.execute(
		"UPDATE store_state SET closed_settler_generation = ?1
          WHERE singleton = 1 AND closed_settler_generation < ?1
            AND settler_generation > ?1",
		[sql_u64(through_generation)?],
	))? != 1
	{
		return Err(BlockRepositoryError::CorruptState);
	}
	commit(transaction)?;
	Ok(through_generation)
}

#[allow(clippy::too_many_lines)]
fn compact_retained_history(
	connection: &mut Connection,
	max_rows: u64,
	#[cfg(feature = "fault-injection")] crash_probe: Option<&CrashProbe>,
) -> Result<RetentionCompactionResult, BlockRepositoryError> {
	#[cfg(feature = "fault-injection")]
	let during_probe = crash_probe.filter(|probe| probe.point == CrashPoint::DuringRetentionCommit);
	#[cfg(feature = "fault-injection")]
	if let Some(probe) = during_probe {
		let marker = probe.marker.clone();
		connection.commit_hook(Some(move || {
			stop_for_crash_probe(&marker, CrashPoint::DuringRetentionCommit);
			false
		}));
	}
	let result = compact_retained_history_transaction(
		connection,
		max_rows,
		#[cfg(feature = "fault-injection")]
		crash_probe,
	);
	#[cfg(feature = "fault-injection")]
	if during_probe.is_some() {
		connection.commit_hook(None::<fn() -> bool>);
	}
	result
}

#[allow(clippy::too_many_lines)]
fn compact_retained_history_transaction(
	connection: &mut Connection,
	max_rows: u64,
	#[cfg(feature = "fault-injection")] crash_probe: Option<&CrashProbe>,
) -> Result<RetentionCompactionResult, BlockRepositoryError> {
	if max_rows == 0 || max_rows > MAX_COMPACTION_ROWS {
		return Err(BlockRepositoryError::InvalidArgument(
			"compaction row bound is invalid",
		));
	}
	let limit = sql_u64(max_rows)?;
	let transaction = immediate(connection)?;
	let commit_version = allocate_commit(&transaction)?;

	let operation_results = deleted_rows(sql(transaction.execute(
		"DELETE FROM op_results
          WHERE (volume_id, writer_epoch, op_id) IN (
            SELECT o.volume_id, o.writer_epoch, o.op_id
              FROM op_results o JOIN volumes v ON v.volume_id = o.volume_id
             WHERE o.writer_epoch <= v.closed_retry_epoch
             ORDER BY o.commit_version LIMIT ?1)",
		[limit],
	))?)?;
	let flush_barriers = deleted_rows(sql(transaction.execute(
		"DELETE FROM flush_barriers
          WHERE (volume_id, writer_epoch, op_id) IN (
            SELECT b.volume_id, b.writer_epoch, b.op_id
              FROM flush_barriers b JOIN volumes v ON v.volume_id = b.volume_id
             WHERE b.writer_epoch <= v.closed_retry_epoch
             ORDER BY b.commit_version LIMIT ?1)",
		[limit],
	))?)?;

	let closed_settler: i64 = sql(transaction.query_row(
		"SELECT closed_settler_generation FROM store_state WHERE singleton = 1",
		[],
		|row| row.get(0),
	))?;
	let mut intent_statement = sql(transaction.prepare(
		"SELECT intent_id FROM pack_intents
          WHERE state = 4 AND generation <= ?1
          ORDER BY updated_commit_version, intent_id LIMIT ?2",
	))?;
	let intent_rows = sql(
		intent_statement.query_map(params![closed_settler, limit], |row| row.get::<_, i64>(0))
	)?;
	let mut intent_ids = Vec::new();
	for row in intent_rows {
		intent_ids.push(positive_u64(sql(row)?)?);
	}
	drop(intent_statement);
	for intent_id in &intent_ids {
		sql(transaction.execute(
			"DELETE FROM pack_intent_members WHERE intent_id = ?1",
			[sql_u64(*intent_id)?],
		))?;
		if sql(transaction.execute(
			"DELETE FROM pack_intents
              WHERE intent_id = ?1 AND state = 4 AND generation <= ?2",
			params![sql_u64(*intent_id)?, closed_settler],
		))? != 1
		{
			return Err(BlockRepositoryError::CorruptState);
		}
	}
	let pack_intents =
		u64::try_from(intent_ids.len()).map_err(|_| BlockRepositoryError::SequenceExhausted)?;

	let settlement_rounds = deleted_rows(sql(transaction.execute(
		"DELETE FROM settlement_rounds
          WHERE round_id IN (
            SELECT r.round_id FROM settlement_rounds r
             WHERE r.state = 2 AND r.generation <= ?1
               AND NOT EXISTS (
                 SELECT 1 FROM pack_intents pi WHERE pi.round_id = r.round_id)
             ORDER BY r.completed_commit_version, r.round_id LIMIT ?2)",
		params![closed_settler, limit],
	))?)?;

	reconcile_dead_versions_and_packs(&transaction, commit_version)?;
	let dead_heads_query = format!(
		"{LIVE_VERSIONS_CTE}
         SELECT h.layer_id, h.shard_no, h.block_no
           FROM delta_block_heads h
          WHERE NOT EXISTS (
             SELECT 1 FROM live_versions live
              WHERE live.source_volume_id = h.source_volume_id
                AND live.writer_epoch = h.writer_epoch
                AND live.sequence = h.sequence)
            AND NOT EXISTS (
             SELECT 1 FROM pack_intent_members im
             JOIN pack_intents pi ON pi.intent_id = im.intent_id
              WHERE pi.state < 4
                AND im.source_volume_id = h.source_volume_id
                AND im.writer_epoch = h.writer_epoch
                AND im.sequence = h.sequence)
          ORDER BY h.layer_id, h.shard_no, h.block_no LIMIT ?1"
	);
	let mut head_statement = sql(transaction.prepare(&dead_heads_query))?;
	let head_rows = sql(head_statement.query_map([limit], |row| {
		Ok((
			row.get::<_, i64>(0)?,
			row.get::<_, i64>(1)?,
			row.get::<_, i64>(2)?,
		))
	}))?;
	let mut head_ids = Vec::new();
	for row in head_rows {
		head_ids.push(sql(row)?);
	}
	drop(head_statement);
	for (layer_id, shard_no, block_no) in &head_ids {
		if sql(transaction.execute(
			"DELETE FROM delta_block_heads
              WHERE layer_id = ?1 AND shard_no = ?2 AND block_no = ?3",
			params![layer_id, shard_no, block_no],
		))? != 1
		{
			return Err(BlockRepositoryError::CorruptState);
		}
	}
	let delta_heads =
		u64::try_from(head_ids.len()).map_err(|_| BlockRepositoryError::SequenceExhausted)?;

	let mut version_statement = sql(transaction.prepare(
		"SELECT v.source_volume_id, v.writer_epoch, v.sequence
           FROM hot_block_versions v
          WHERE NOT EXISTS (
             SELECT 1 FROM delta_block_heads h
              WHERE h.source_volume_id = v.source_volume_id
                AND h.writer_epoch = v.writer_epoch AND h.sequence = v.sequence)
            AND NOT EXISTS (
             SELECT 1 FROM cold_locations c
              WHERE c.source_volume_id = v.source_volume_id
                AND c.writer_epoch = v.writer_epoch AND c.sequence = v.sequence)
            AND NOT EXISTS (
             SELECT 1 FROM pack_members pm
              WHERE pm.source_volume_id = v.source_volume_id
                AND pm.writer_epoch = v.writer_epoch AND pm.sequence = v.sequence)
            AND NOT EXISTS (
             SELECT 1 FROM pack_intent_members im
              WHERE im.source_volume_id = v.source_volume_id
                AND im.writer_epoch = v.writer_epoch AND im.sequence = v.sequence)
          ORDER BY v.created_commit_version, v.source_volume_id,
                   v.writer_epoch, v.sequence LIMIT ?1",
	))?;
	let version_rows = sql(version_statement.query_map([limit], |row| {
		Ok((
			row.get::<_, String>(0)?,
			row.get::<_, i64>(1)?,
			row.get::<_, i64>(2)?,
		))
	}))?;
	let mut version_ids = Vec::new();
	for row in version_rows {
		version_ids.push(sql(row)?);
	}
	drop(version_statement);
	for (source_volume_id, writer_epoch, sequence) in &version_ids {
		if sql(transaction.execute(
			"DELETE FROM hot_block_versions
              WHERE source_volume_id = ?1 AND writer_epoch = ?2 AND sequence = ?3",
			params![source_volume_id, writer_epoch, sequence],
		))? != 1
		{
			return Err(BlockRepositoryError::CorruptState);
		}
	}
	let versions =
		u64::try_from(version_ids.len()).map_err(|_| BlockRepositoryError::SequenceExhausted)?;

	#[cfg(feature = "fault-injection")]
	if crash_probe.is_some_and(|probe| probe.point == CrashPoint::BeforeRetentionCommit) {
		let probe = crash_probe.expect("probe checked above");
		stop_for_crash_probe(&probe.marker, CrashPoint::BeforeRetentionCommit);
	}
	commit(transaction)?;
	#[cfg(feature = "fault-injection")]
	if crash_probe.is_some_and(|probe| probe.point == CrashPoint::AfterRetentionCommit) {
		let probe = crash_probe.expect("probe checked above");
		stop_for_crash_probe(&probe.marker, CrashPoint::AfterRetentionCommit);
	}
	Ok(RetentionCompactionResult {
		operation_results,
		flush_barriers,
		delta_heads,
		versions,
		pack_intents,
		settlement_rounds,
	})
}

fn deleted_rows(rows: usize) -> Result<u64, BlockRepositoryError> {
	u64::try_from(rows).map_err(|_| BlockRepositoryError::SequenceExhausted)
}

fn next_gc_task(connection: &Connection) -> Result<Option<GcTask>, BlockRepositoryError> {
	let row = sql(connection
		.query_row(
			"SELECT g.object_key, g.pack_sha256
               FROM gc_outbox g
               JOIN pack_records p ON p.pack_sha256 = g.pack_sha256
              WHERE g.state = 1 AND p.lifecycle_state = 2 AND p.ref_count = 0
                AND p.object_key = g.object_key
              ORDER BY g.created_commit_version, g.object_key LIMIT 1",
			[],
			|row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
		)
		.optional())?;
	row.map(|(object_key, hash)| {
		Ok(GcTask {
			object_key,
			pack_sha256: hash_array(&hash)?,
		})
	})
	.transpose()
}

fn complete_gc_task(
	connection: &mut Connection,
	task: &GcTask,
) -> Result<(), BlockRepositoryError> {
	validate_object_key(&task.object_key)?;
	let transaction = immediate(connection)?;
	let outbox = sql(transaction
		.query_row(
			"SELECT pack_sha256, state FROM gc_outbox WHERE object_key = ?1",
			[&task.object_key],
			|row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, i64>(1)?)),
		)
		.optional())?
	.ok_or(BlockRepositoryError::InvalidArgument(
		"GC task does not exist",
	))?;
	if hash_array(&outbox.0)? != task.pack_sha256 {
		return Err(BlockRepositoryError::ColdLocationConflict);
	}
	if outbox.1 == 2 {
		commit(transaction)?;
		return Ok(());
	}
	if outbox.1 != 1 {
		return Err(BlockRepositoryError::CorruptState);
	}
	let pack = sql(transaction
		.query_row(
			"SELECT object_key, lifecycle_state, ref_count FROM pack_records
              WHERE pack_sha256 = ?1",
			[task.pack_sha256.as_slice()],
			|row| {
				Ok((
					row.get::<_, String>(0)?,
					row.get::<_, i64>(1)?,
					row.get::<_, i64>(2)?,
				))
			},
		)
		.optional())?
	.ok_or(BlockRepositoryError::CorruptState)?;
	if pack.0 != task.object_key || pack.1 != 2 || pack.2 != 0 {
		return Err(BlockRepositoryError::ColdLocationConflict);
	}
	let commit_version = allocate_commit(&transaction)?;
	sql(transaction.execute(
		"DELETE FROM pack_members WHERE pack_sha256 = ?1",
		[task.pack_sha256.as_slice()],
	))?;
	if sql(transaction.execute(
		"DELETE FROM pack_records
          WHERE pack_sha256 = ?1 AND lifecycle_state = 2 AND ref_count = 0",
		[task.pack_sha256.as_slice()],
	))? != 1
	{
		return Err(BlockRepositoryError::ColdLocationConflict);
	}
	sql(transaction.execute(
		"UPDATE gc_outbox SET state = 2, completed_commit_version = ?2
          WHERE object_key = ?1 AND state = 1",
		params![task.object_key, sql_u64(commit_version)?],
	))?;
	commit(transaction)
}

#[allow(clippy::too_many_lines)]
fn reconcile_dead_versions_and_packs(
	transaction: &Transaction<'_>,
	commit_version: u64,
) -> Result<(), BlockRepositoryError> {
	let active_intent_guard = "NOT EXISTS (
           SELECT 1 FROM pack_intent_members im
           JOIN pack_intents pi ON pi.intent_id = im.intent_id
            WHERE pi.state < 4
              AND im.source_volume_id = hot_block_versions.source_volume_id
              AND im.writer_epoch = hot_block_versions.writer_epoch
              AND im.sequence = hot_block_versions.sequence
         )";
	let update_hot = format!(
		"{LIVE_VERSIONS_CTE}
         UPDATE hot_block_versions SET hot_payload = NULL
          WHERE hot_payload IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM live_versions live
               WHERE live.source_volume_id = hot_block_versions.source_volume_id
                 AND live.writer_epoch = hot_block_versions.writer_epoch
                 AND live.sequence = hot_block_versions.sequence)
            AND {active_intent_guard}"
	);
	sql(transaction.execute(&update_hot, []))?;
	let delete_locations = format!(
		"{LIVE_VERSIONS_CTE}
         DELETE FROM cold_locations
          WHERE NOT EXISTS (
              SELECT 1 FROM live_versions live
               WHERE live.source_volume_id = cold_locations.source_volume_id
                 AND live.writer_epoch = cold_locations.writer_epoch
                 AND live.sequence = cold_locations.sequence)
            AND NOT EXISTS (
              SELECT 1 FROM pack_intent_members im
              JOIN pack_intents pi ON pi.intent_id = im.intent_id
               WHERE pi.state < 4
                 AND im.source_volume_id = cold_locations.source_volume_id
                 AND im.writer_epoch = cold_locations.writer_epoch
                 AND im.sequence = cold_locations.sequence)"
	);
	sql(transaction.execute(&delete_locations, []))?;

	let mut statement = sql(transaction.prepare(
		"SELECT p.pack_sha256, p.object_key
           FROM pack_records p
          WHERE p.lifecycle_state = 1 AND p.ref_count = 0
            AND NOT EXISTS (
              SELECT 1 FROM pack_intents pi
               WHERE pi.pack_sha256 = p.pack_sha256 AND pi.state < 4)
          ORDER BY p.published_commit_version, p.object_key",
	))?;
	let rows = sql(statement.query_map([], |row| {
		Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, String>(1)?))
	}))?;
	let mut candidates = Vec::new();
	for row in rows {
		candidates.push(sql(row)?);
	}
	drop(statement);
	for (hash, object_key) in candidates {
		if sql(transaction.execute(
			"UPDATE pack_records SET lifecycle_state = 2
              WHERE pack_sha256 = ?1 AND lifecycle_state = 1 AND ref_count = 0",
			[&hash],
		))? != 1
		{
			return Err(BlockRepositoryError::CorruptState);
		}
		sql(transaction.execute(
			"INSERT INTO gc_outbox(
               object_key, pack_sha256, state, created_commit_version,
               completed_commit_version
             ) VALUES (?1, ?2, 1, ?3, NULL)",
			params![object_key, hash, sql_u64(commit_version)?],
		))?;
	}
	Ok(())
}

fn stats(connection: &Connection) -> Result<RepositoryStats, BlockRepositoryError> {
	let row = sql(connection.query_row(
		"SELECT
           (SELECT count(*) FROM volumes WHERE state = 1),
           (SELECT count(*) FROM volumes WHERE state = 2),
           (SELECT count(*) FROM snapshots WHERE state = 1),
           (SELECT count(*) FROM hot_block_versions),
           (SELECT count(*) FROM delta_layers),
           (SELECT count(*) FROM delta_layers WHERE state = 1),
           (SELECT count(*) FROM delta_block_heads),
           (SELECT coalesce(sum(length(hot_payload)), 0) FROM hot_block_versions),
           (SELECT count(*) FROM cold_locations),
           (SELECT count(*) FROM pack_records),
           (SELECT count(*) FROM pack_intents WHERE state < 4),
           (SELECT count(*) FROM pack_intents WHERE state = 4),
           (SELECT count(*) FROM settlement_rounds WHERE state = 1),
           (SELECT count(*) FROM settlement_rounds WHERE state = 2),
           (SELECT count(*) FROM gc_outbox WHERE state = 1),
           (SELECT count(*) FROM gc_outbox WHERE state = 2)",
		[],
		|row| {
			Ok((
				row.get::<_, i64>(0)?,
				row.get::<_, i64>(1)?,
				row.get::<_, i64>(2)?,
				row.get::<_, i64>(3)?,
				row.get::<_, i64>(4)?,
				row.get::<_, i64>(5)?,
				row.get::<_, i64>(6)?,
				row.get::<_, i64>(7)?,
				row.get::<_, i64>(8)?,
				row.get::<_, i64>(9)?,
				row.get::<_, i64>(10)?,
				row.get::<_, i64>(11)?,
				row.get::<_, i64>(12)?,
				row.get::<_, i64>(13)?,
				row.get::<_, i64>(14)?,
				row.get::<_, i64>(15)?,
			))
		},
	))?;
	let operation_results: i64 =
		sql(connection.query_row("SELECT count(*) FROM op_results", [], |row| row.get(0)))?;
	let flush_barriers: i64 =
		sql(connection.query_row("SELECT count(*) FROM flush_barriers", [], |row| row.get(0)))?;
	Ok(RepositoryStats {
		volumes: nonnegative_u64(row.0)?,
		retired_volumes: nonnegative_u64(row.1)?,
		snapshots: nonnegative_u64(row.2)?,
		versions: nonnegative_u64(row.3)?,
		delta_layers: nonnegative_u64(row.4)?,
		mutable_delta_layers: nonnegative_u64(row.5)?,
		delta_heads: nonnegative_u64(row.6)?,
		hot_payload_bytes: nonnegative_u64(row.7)?,
		cold_locations: nonnegative_u64(row.8)?,
		packs: nonnegative_u64(row.9)?,
		active_pack_intents: nonnegative_u64(row.10)?,
		completed_pack_intents: nonnegative_u64(row.11)?,
		active_settlement_rounds: nonnegative_u64(row.12)?,
		completed_settlement_rounds: nonnegative_u64(row.13)?,
		pending_gc_tasks: nonnegative_u64(row.14)?,
		completed_gc_tasks: nonnegative_u64(row.15)?,
		operation_results: nonnegative_u64(operation_results)?,
		flush_barriers: nonnegative_u64(flush_barriers)?,
	})
}

#[derive(Debug)]
struct TxVolume {
	logical_size: u64,
	writer_epoch: u64,
	layer_id: u64,
	closed_retry_epoch: u64,
}

fn load_volume_tx(
	transaction: &Transaction<'_>,
	volume_id: &str,
) -> Result<TxVolume, BlockRepositoryError> {
	validate_id(volume_id, "invalid volume ID")?;
	let row = sql(transaction
		.query_row(
			"SELECT logical_size, writer_epoch, coalesce(current_layer_id, 0),
                    closed_retry_epoch, state
             FROM volumes WHERE volume_id = ?1",
			[volume_id],
			|row| {
				Ok((
					row.get::<_, i64>(0)?,
					row.get::<_, i64>(1)?,
					row.get::<_, i64>(2)?,
					row.get::<_, i64>(3)?,
					row.get::<_, i64>(4)?,
				))
			},
		)
		.optional())?
	.ok_or(BlockRepositoryError::VolumeNotFound)?;
	if row.4 == VOLUME_RETIRED {
		return Err(BlockRepositoryError::VolumeRetired);
	}
	if row.4 != VOLUME_ACTIVE {
		return Err(BlockRepositoryError::CorruptState);
	}
	Ok(TxVolume {
		logical_size: positive_u64(row.0)?,
		writer_epoch: positive_u64(row.1)?,
		layer_id: nonnegative_u64(row.2)?,
		closed_retry_epoch: nonnegative_u64(row.3)?,
	})
}

fn ensure_retry_window_open(
	volume: &TxVolume,
	request_epoch: u64,
) -> Result<(), BlockRepositoryError> {
	if request_epoch <= volume.closed_retry_epoch {
		return Err(BlockRepositoryError::RetryWindowClosed);
	}
	Ok(())
}

#[derive(Debug)]
struct StoredResult {
	fingerprint: [u8; SHA256_BYTES],
	kind: i64,
	outcome: i64,
	commit_version: u64,
	sequence: u64,
	layer_id: u64,
	result_epoch: u64,
}

fn load_stored_result(
	transaction: &Transaction<'_>,
	volume_id: &str,
	writer_epoch: u64,
	op_id: &str,
) -> Result<Option<StoredResult>, BlockRepositoryError> {
	let row = sql(transaction
		.query_row(
			"SELECT request_fingerprint, operation_kind, outcome_kind,
                    commit_version, sequence, coalesce(layer_id, 0), result_epoch
             FROM op_results
             WHERE volume_id = ?1 AND writer_epoch = ?2 AND op_id = ?3",
			params![volume_id, sql_u64(writer_epoch)?, op_id],
			|row| {
				Ok((
					row.get::<_, Vec<u8>>(0)?,
					row.get::<_, i64>(1)?,
					row.get::<_, i64>(2)?,
					row.get::<_, i64>(3)?,
					row.get::<_, i64>(4)?,
					row.get::<_, i64>(5)?,
					row.get::<_, i64>(6)?,
				))
			},
		)
		.optional())?;
	row.map(|row| {
		Ok(StoredResult {
			fingerprint: hash_array(&row.0)?,
			kind: row.1,
			outcome: row.2,
			commit_version: positive_u64(row.3)?,
			sequence: nonnegative_u64(row.4)?,
			layer_id: nonnegative_u64(row.5)?,
			result_epoch: nonnegative_u64(row.6)?,
		})
	})
	.transpose()
}

fn decode_write_outcome(
	stored: &StoredResult,
	writer_epoch: u64,
) -> Result<WriteOutcome, BlockRepositoryError> {
	match stored.outcome {
		OUTCOME_APPLIED
			if stored.sequence > 0 && stored.layer_id > 0 && stored.result_epoch == 0 =>
		{
			Ok(WriteOutcome::Applied {
				version: BlockVersion {
					epoch: writer_epoch,
					sequence: stored.sequence,
				},
				layer_id: stored.layer_id,
			})
		}
		OUTCOME_STALE_EPOCH
			if stored.sequence == 0 && stored.layer_id == 0 && stored.result_epoch > 0 =>
		{
			Ok(WriteOutcome::StaleEpoch {
				current_epoch: stored.result_epoch,
			})
		}
		_ => Err(BlockRepositoryError::CorruptState),
	}
}

fn decode_range_write_outcome(
	stored: &StoredResult,
	request: &CommitRangeWriteRequest,
) -> Result<RangeWriteOutcome, BlockRepositoryError> {
	match stored.outcome {
		OUTCOME_APPLIED
			if stored.sequence > 0 && stored.layer_id > 0 && stored.result_epoch == 0 =>
		{
			let block_count = u64::try_from(request.bytes.len() / BLOCK_SIZE_USIZE)
				.map_err(|_| BlockRepositoryError::CorruptState)?;
			let first_sequence = stored
				.sequence
				.checked_sub(block_count.saturating_sub(1))
				.filter(|sequence| *sequence > 0)
				.ok_or(BlockRepositoryError::CorruptState)?;
			Ok(RangeWriteOutcome::Applied {
				first_version: BlockVersion {
					epoch: request.writer_epoch,
					sequence: first_sequence,
				},
				last_version: BlockVersion {
					epoch: request.writer_epoch,
					sequence: stored.sequence,
				},
				block_count,
				layer_id: stored.layer_id,
			})
		}
		OUTCOME_STALE_EPOCH
			if stored.sequence == 0 && stored.layer_id == 0 && stored.result_epoch > 0 =>
		{
			Ok(RangeWriteOutcome::StaleEpoch {
				current_epoch: stored.result_epoch,
			})
		}
		_ => Err(BlockRepositoryError::CorruptState),
	}
}

fn decode_range_discard_outcome(
	stored: &StoredResult,
	request: &DiscardRangeRequest,
) -> Result<RangeWriteOutcome, BlockRepositoryError> {
	let block_count = request.length / BLOCK_SIZE;
	match stored.outcome {
		OUTCOME_APPLIED
			if stored.sequence > 0 && stored.layer_id > 0 && stored.result_epoch == 0 =>
		{
			let first_sequence = stored
				.sequence
				.checked_sub(block_count.saturating_sub(1))
				.filter(|sequence| *sequence > 0)
				.ok_or(BlockRepositoryError::CorruptState)?;
			Ok(RangeWriteOutcome::Applied {
				first_version: BlockVersion {
					epoch: request.writer_epoch,
					sequence: first_sequence,
				},
				last_version: BlockVersion {
					epoch: request.writer_epoch,
					sequence: stored.sequence,
				},
				block_count,
				layer_id: stored.layer_id,
			})
		}
		OUTCOME_STALE_EPOCH
			if stored.sequence == 0 && stored.layer_id == 0 && stored.result_epoch > 0 =>
		{
			Ok(RangeWriteOutcome::StaleEpoch {
				current_epoch: stored.result_epoch,
			})
		}
		_ => Err(BlockRepositoryError::CorruptState),
	}
}

fn decode_flush_result(
	stored: &StoredResult,
	replayed: bool,
) -> Result<FlushResult, BlockRepositoryError> {
	match stored.outcome {
		OUTCOME_APPLIED if stored.layer_id == 0 && stored.result_epoch == 0 => Ok(FlushResult {
			commit_version: stored.commit_version,
			replayed,
			captured_sequence: stored.sequence,
			stale_current_epoch: None,
		}),
		OUTCOME_STALE_EPOCH
			if stored.sequence == 0 && stored.layer_id == 0 && stored.result_epoch > 0 =>
		{
			Ok(FlushResult {
				commit_version: stored.commit_version,
				replayed,
				captured_sequence: 0,
				stale_current_epoch: Some(stored.result_epoch),
			})
		}
		_ => Err(BlockRepositoryError::CorruptState),
	}
}

fn decode_acquire_writer_result(
	stored: &StoredResult,
	replayed: bool,
) -> Result<AcquireWriterResult, BlockRepositoryError> {
	let outcome = match stored.outcome {
		OUTCOME_EPOCH_ROTATED
			if stored.sequence == 0 && stored.layer_id == 0 && stored.result_epoch > 0 =>
		{
			AcquireWriterOutcome::Acquired {
				new_epoch: stored.result_epoch,
			}
		}
		OUTCOME_STALE_EPOCH
			if stored.sequence == 0 && stored.layer_id == 0 && stored.result_epoch > 0 =>
		{
			AcquireWriterOutcome::StaleEpoch {
				current_epoch: stored.result_epoch,
			}
		}
		_ => return Err(BlockRepositoryError::CorruptState),
	};
	Ok(AcquireWriterResult {
		commit_version: stored.commit_version,
		replayed,
		outcome,
	})
}

fn insert_write_result(
	transaction: &Transaction<'_>,
	request: &CommitWriteRequest,
	fingerprint: &[u8; SHA256_BYTES],
	commit_version: u64,
	outcome: &WriteOutcome,
) -> Result<(), BlockRepositoryError> {
	let (outcome_kind, sequence, layer_id, result_epoch) = match outcome {
		WriteOutcome::Applied { version, layer_id } => {
			(OUTCOME_APPLIED, version.sequence, *layer_id, 0)
		}
		WriteOutcome::StaleEpoch { current_epoch } => (OUTCOME_STALE_EPOCH, 0, 0, *current_epoch),
	};
	sql(transaction.execute(
		"INSERT INTO op_results(
           volume_id, writer_epoch, op_id, request_fingerprint,
           operation_kind, outcome_kind, commit_version, sequence,
           layer_id, result_epoch
         ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?9)",
		params![
			request.volume_id,
			sql_u64(request.writer_epoch)?,
			request.op_id,
			fingerprint.as_slice(),
			outcome_kind,
			sql_u64(commit_version)?,
			sql_u64(sequence)?,
			optional_sql_u64(layer_id)?,
			sql_u64(result_epoch)?
		],
	))?;
	Ok(())
}

fn insert_range_write_result(
	transaction: &Transaction<'_>,
	request: &CommitRangeWriteRequest,
	fingerprint: &[u8; SHA256_BYTES],
	commit_version: u64,
	outcome: &RangeWriteOutcome,
) -> Result<(), BlockRepositoryError> {
	let (outcome_kind, sequence, layer_id, result_epoch) = match outcome {
		RangeWriteOutcome::Applied {
			last_version,
			layer_id,
			..
		} => (OUTCOME_APPLIED, last_version.sequence, *layer_id, 0),
		RangeWriteOutcome::StaleEpoch { current_epoch } => {
			(OUTCOME_STALE_EPOCH, 0, 0, *current_epoch)
		}
	};
	sql(transaction.execute(
		"INSERT INTO op_results(
           volume_id, writer_epoch, op_id, request_fingerprint,
           operation_kind, outcome_kind, commit_version, sequence,
           layer_id, result_epoch
         ) VALUES (?1, ?2, ?3, ?4, 5, ?5, ?6, ?7, ?8, ?9)",
		params![
			request.volume_id,
			sql_u64(request.writer_epoch)?,
			request.op_id,
			fingerprint.as_slice(),
			outcome_kind,
			sql_u64(commit_version)?,
			sql_u64(sequence)?,
			optional_sql_u64(layer_id)?,
			sql_u64(result_epoch)?
		],
	))?;
	Ok(())
}

fn insert_discard_result(
	transaction: &Transaction<'_>,
	request: &DiscardRequest,
	fingerprint: &[u8; SHA256_BYTES],
	commit_version: u64,
	outcome: &WriteOutcome,
) -> Result<(), BlockRepositoryError> {
	let (outcome_kind, sequence, layer_id, result_epoch) = match outcome {
		WriteOutcome::Applied { version, layer_id } => {
			(OUTCOME_APPLIED, version.sequence, *layer_id, 0)
		}
		WriteOutcome::StaleEpoch { current_epoch } => (OUTCOME_STALE_EPOCH, 0, 0, *current_epoch),
	};
	sql(transaction.execute(
		"INSERT INTO op_results(
           volume_id, writer_epoch, op_id, request_fingerprint,
           operation_kind, outcome_kind, commit_version, sequence,
           layer_id, result_epoch
         ) VALUES (?1, ?2, ?3, ?4, 4, ?5, ?6, ?7, ?8, ?9)",
		params![
			request.volume_id,
			sql_u64(request.writer_epoch)?,
			request.op_id,
			fingerprint.as_slice(),
			outcome_kind,
			sql_u64(commit_version)?,
			sql_u64(sequence)?,
			optional_sql_u64(layer_id)?,
			sql_u64(result_epoch)?
		],
	))?;
	Ok(())
}

fn insert_range_discard_result(
	transaction: &Transaction<'_>,
	request: &DiscardRangeRequest,
	fingerprint: &[u8; SHA256_BYTES],
	commit_version: u64,
	outcome: &RangeWriteOutcome,
) -> Result<(), BlockRepositoryError> {
	let (outcome_kind, sequence, layer_id, result_epoch) = match outcome {
		RangeWriteOutcome::Applied {
			last_version,
			layer_id,
			..
		} => (OUTCOME_APPLIED, last_version.sequence, *layer_id, 0),
		RangeWriteOutcome::StaleEpoch { current_epoch } => {
			(OUTCOME_STALE_EPOCH, 0, 0, *current_epoch)
		}
	};
	sql(transaction.execute(
		"INSERT INTO op_results(
           volume_id, writer_epoch, op_id, request_fingerprint,
           operation_kind, outcome_kind, commit_version, sequence,
           layer_id, result_epoch
         ) VALUES (?1, ?2, ?3, ?4, 6, ?5, ?6, ?7, ?8, ?9)",
		params![
			request.volume_id,
			sql_u64(request.writer_epoch)?,
			request.op_id,
			fingerprint.as_slice(),
			outcome_kind,
			sql_u64(commit_version)?,
			sql_u64(sequence)?,
			optional_sql_u64(layer_id)?,
			sql_u64(result_epoch)?
		],
	))?;
	Ok(())
}

fn decode_cold(
	key: Option<String>,
	offset: Option<i64>,
	length: Option<i64>,
	hash: Option<Vec<u8>>,
	pack_length: Option<i64>,
) -> Result<Option<ColdLocation>, BlockRepositoryError> {
	match (key, offset, length, hash, pack_length) {
		(None, None, None, None, None) => Ok(None),
		(Some(object_key), Some(offset), Some(length), Some(hash), Some(pack_length)) => {
			let offset = nonnegative_u64(offset)?;
			let length = positive_u64(length)?;
			let pack_length = positive_u64(pack_length)?;
			if length != BLOCK_SIZE
				|| offset
					.checked_add(length)
					.is_none_or(|end| end > pack_length)
			{
				return Err(BlockRepositoryError::CorruptState);
			}
			Ok(Some(ColdLocation {
				object_key,
				offset,
				length,
				pack_sha256: hash_array(&hash)?,
			}))
		}
		_ => Err(BlockRepositoryError::CorruptState),
	}
}

fn validate_write(request: &CommitWriteRequest) -> Result<(), BlockRepositoryError> {
	validate_id(&request.volume_id, "invalid volume ID")?;
	validate_id(&request.op_id, "invalid operation ID")?;
	if request.writer_epoch == 0 {
		return Err(BlockRepositoryError::InvalidArgument(
			"writer epoch must be non-zero",
		));
	}
	if request.bytes.len() != BLOCK_SIZE_USIZE {
		return Err(BlockRepositoryError::InvalidArgument(
			"write must contain exactly 4 KiB",
		));
	}
	Ok(())
}

fn validate_range_write(request: &CommitRangeWriteRequest) -> Result<(), BlockRepositoryError> {
	validate_id(&request.volume_id, "invalid volume ID")?;
	validate_id(&request.op_id, "invalid operation ID")?;
	if request.writer_epoch == 0 {
		return Err(BlockRepositoryError::InvalidArgument(
			"writer epoch must be non-zero",
		));
	}
	if !request.offset.is_multiple_of(BLOCK_SIZE) {
		return Err(BlockRepositoryError::InvalidArgument(
			"write offset must be 4 KiB aligned",
		));
	}
	if request.bytes.is_empty()
		|| request.bytes.len() > MAX_WRITE_BYTES
		|| !request.bytes.len().is_multiple_of(BLOCK_SIZE_USIZE)
	{
		return Err(BlockRepositoryError::InvalidArgument(
			"write length must be an aligned 4 KiB through 512 KiB",
		));
	}
	Ok(())
}

fn validate_discard(request: &DiscardRequest) -> Result<(), BlockRepositoryError> {
	validate_id(&request.volume_id, "invalid volume ID")?;
	validate_id(&request.op_id, "invalid operation ID")?;
	if request.writer_epoch == 0 {
		return Err(BlockRepositoryError::InvalidArgument(
			"writer epoch must be non-zero",
		));
	}
	Ok(())
}

fn validate_range_discard(request: &DiscardRangeRequest) -> Result<(), BlockRepositoryError> {
	validate_id(&request.volume_id, "invalid volume ID")?;
	validate_id(&request.op_id, "invalid operation ID")?;
	if request.writer_epoch == 0 {
		return Err(BlockRepositoryError::InvalidArgument(
			"writer epoch must be non-zero",
		));
	}
	if !request.offset.is_multiple_of(BLOCK_SIZE)
		|| request.length < BLOCK_SIZE
		|| request.length > u64::try_from(MAX_WRITE_BYTES).unwrap_or(u64::MAX)
		|| !request.length.is_multiple_of(BLOCK_SIZE)
	{
		return Err(BlockRepositoryError::InvalidArgument(
			"discard range must be aligned 4 KiB through 512 KiB",
		));
	}
	Ok(())
}

fn validate_discard_range(
	logical_size: u64,
	offset: u64,
	length: u64,
) -> Result<(), BlockRepositoryError> {
	if offset
		.checked_add(length)
		.is_none_or(|end| end > logical_size)
	{
		return Err(BlockRepositoryError::InvalidArgument(
			"discard range exceeds the volume",
		));
	}
	Ok(())
}

fn validate_geometry(logical_size: u64) -> Result<(), BlockRepositoryError> {
	if logical_size == 0
		|| !logical_size.is_multiple_of(BLOCK_SIZE)
		|| logical_size > i64::MAX as u64
	{
		return Err(BlockRepositoryError::InvalidArgument(
			"logical size must be a positive aligned SQLite integer",
		));
	}
	Ok(())
}

fn validate_block_no(logical_size: u64, block_no: u64) -> Result<(), BlockRepositoryError> {
	if block_no >= logical_size / BLOCK_SIZE {
		return Err(BlockRepositoryError::InvalidArgument(
			"block number is outside the sparse volume",
		));
	}
	Ok(())
}

fn validate_write_range(
	logical_size: u64,
	offset: u64,
	length: usize,
) -> Result<(), BlockRepositoryError> {
	let length = u64::try_from(length)
		.map_err(|_| BlockRepositoryError::InvalidArgument("write range exceeds the volume"))?;
	if offset
		.checked_add(length)
		.is_none_or(|end| end > logical_size)
	{
		return Err(BlockRepositoryError::InvalidArgument(
			"write range exceeds the volume",
		));
	}
	Ok(())
}

fn validate_id(value: &str, message: &'static str) -> Result<(), BlockRepositoryError> {
	if value.is_empty()
		|| value.len() > MAX_IDENTIFIER_BYTES
		|| !value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
	{
		return Err(BlockRepositoryError::InvalidArgument(message));
	}
	Ok(())
}

fn validate_object_key(value: &str) -> Result<(), BlockRepositoryError> {
	if value.is_empty() || value.len() > 4_096 || value.as_bytes().contains(&0) {
		return Err(BlockRepositoryError::InvalidArgument(
			"invalid immutable object key",
		));
	}
	Ok(())
}

fn write_fingerprint(request: &CommitWriteRequest) -> [u8; SHA256_BYTES] {
	let mut digest = Sha256::new();
	digest.update(b"minisandbox.block.write.v1\0");
	hash_part(&mut digest, request.volume_id.as_bytes());
	digest.update(request.writer_epoch.to_be_bytes());
	hash_part(&mut digest, request.op_id.as_bytes());
	digest.update(request.block_no.to_be_bytes());
	hash_part(&mut digest, &request.bytes);
	digest.finalize().into()
}

fn range_write_fingerprint(request: &CommitRangeWriteRequest) -> [u8; SHA256_BYTES] {
	let mut digest = Sha256::new();
	digest.update(b"minisandbox.block.range-write.v1\0");
	hash_part(&mut digest, request.volume_id.as_bytes());
	digest.update(request.writer_epoch.to_be_bytes());
	hash_part(&mut digest, request.op_id.as_bytes());
	digest.update(request.offset.to_be_bytes());
	hash_part(&mut digest, &request.bytes);
	digest.finalize().into()
}

fn discard_fingerprint(request: &DiscardRequest) -> [u8; SHA256_BYTES] {
	let mut digest = Sha256::new();
	digest.update(b"minisandbox.block.discard.v1\0");
	hash_part(&mut digest, request.volume_id.as_bytes());
	digest.update(request.writer_epoch.to_be_bytes());
	hash_part(&mut digest, request.op_id.as_bytes());
	digest.update(request.block_no.to_be_bytes());
	digest.finalize().into()
}

fn range_discard_fingerprint(request: &DiscardRangeRequest) -> [u8; SHA256_BYTES] {
	let mut digest = Sha256::new();
	digest.update(b"minisandbox.block.range-discard.v1\0");
	hash_part(&mut digest, request.volume_id.as_bytes());
	digest.update(request.writer_epoch.to_be_bytes());
	hash_part(&mut digest, request.op_id.as_bytes());
	digest.update(request.offset.to_be_bytes());
	digest.update(request.length.to_be_bytes());
	digest.finalize().into()
}

fn flush_fingerprint(request: &FlushRequest) -> [u8; SHA256_BYTES] {
	let mut digest = Sha256::new();
	digest.update(b"minisandbox.block.flush.v1\0");
	hash_part(&mut digest, request.volume_id.as_bytes());
	digest.update(request.writer_epoch.to_be_bytes());
	hash_part(&mut digest, request.op_id.as_bytes());
	digest.update(request.submitted_sequence.to_be_bytes());
	digest.finalize().into()
}

fn acquire_writer_fingerprint(request: &AcquireWriterRequest) -> [u8; SHA256_BYTES] {
	let mut digest = Sha256::new();
	digest.update(b"minisandbox.block.acquire-writer.v1\0");
	hash_part(&mut digest, request.volume_id.as_bytes());
	digest.update(request.expected_epoch.to_be_bytes());
	hash_part(&mut digest, request.op_id.as_bytes());
	digest.finalize().into()
}

fn hash_part(digest: &mut Sha256, bytes: &[u8]) {
	digest.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
	digest.update(bytes);
}

fn hex(bytes: &[u8]) -> String {
	const HEX: &[u8; 16] = b"0123456789abcdef";
	let mut output = String::with_capacity(bytes.len() * 2);
	for byte in bytes {
		output.push(char::from(HEX[usize::from(byte >> 4)]));
		output.push(char::from(HEX[usize::from(byte & 0x0f)]));
	}
	output
}

fn hash_array(bytes: &[u8]) -> Result<[u8; SHA256_BYTES], BlockRepositoryError> {
	bytes
		.try_into()
		.map_err(|_| BlockRepositoryError::CorruptState)
}

fn immediate(connection: &mut Connection) -> Result<Transaction<'_>, BlockRepositoryError> {
	sql(connection.transaction_with_behavior(TransactionBehavior::Immediate))
}

fn allocate_commit(transaction: &Transaction<'_>) -> Result<u64, BlockRepositoryError> {
	let (_, last) = allocate_commit_range(transaction, 1)?;
	Ok(last)
}

fn current_commit_version(transaction: &Transaction<'_>) -> Result<u64, BlockRepositoryError> {
	let current: i64 = sql(transaction.query_row(
		"SELECT commit_version FROM store_state WHERE singleton = 1",
		[],
		|row| row.get(0),
	))?;
	nonnegative_u64(current)
}

fn allocate_commit_range(
	transaction: &Transaction<'_>,
	count: u64,
) -> Result<(u64, u64), BlockRepositoryError> {
	if count == 0 {
		return Err(BlockRepositoryError::InvalidArgument(
			"commit range must be non-zero",
		));
	}
	let current: i64 = sql(transaction.query_row(
		"SELECT commit_version FROM store_state WHERE singleton = 1",
		[],
		|row| row.get(0),
	))?;
	let current = nonnegative_u64(current)?;
	let first = current
		.checked_add(1)
		.ok_or(BlockRepositoryError::SequenceExhausted)?;
	let last = current
		.checked_add(count)
		.ok_or(BlockRepositoryError::SequenceExhausted)?;
	sql(transaction.execute(
		"UPDATE store_state SET commit_version = ?1 WHERE singleton = 1",
		[sql_u64(last)?],
	))?;
	Ok((first, last))
}

fn commit(transaction: Transaction<'_>) -> Result<(), BlockRepositoryError> {
	sql(transaction.commit())
}

fn exists(
	transaction: &Transaction<'_>,
	query: &str,
	value: &str,
) -> Result<bool, BlockRepositoryError> {
	Ok(sql(transaction.query_row(query, [value], |_| Ok(())).optional())?.is_some())
}

fn sql<T>(result: rusqlite::Result<T>) -> Result<T, BlockRepositoryError> {
	result.map_err(|_| BlockRepositoryError::Unavailable)
}

fn sql_u64(value: u64) -> Result<i64, BlockRepositoryError> {
	i64::try_from(value).map_err(|_| BlockRepositoryError::SequenceExhausted)
}

fn optional_sql_u64(value: u64) -> Result<Option<i64>, BlockRepositoryError> {
	if value == 0 {
		Ok(None)
	} else {
		Ok(Some(sql_u64(value)?))
	}
}

fn positive_u64(value: i64) -> Result<u64, BlockRepositoryError> {
	let value = u64::try_from(value).map_err(|_| BlockRepositoryError::CorruptState)?;
	if value == 0 {
		return Err(BlockRepositoryError::CorruptState);
	}
	Ok(value)
}

fn nonnegative_u64(value: i64) -> Result<u64, BlockRepositoryError> {
	u64::try_from(value).map_err(|_| BlockRepositoryError::CorruptState)
}

#[cfg(feature = "fault-injection")]
fn stop_for_crash_probe(marker: &Path, point: CrashPoint) {
	let mut file = File::create(marker).expect("create block crash marker");
	writeln!(file, "{point:?}").expect("write block crash marker");
	file.sync_all().expect("sync block crash marker");
	#[cfg(unix)]
	{
		// SAFETY: raising SIGSTOP for the current process has no memory-safety
		// preconditions. The external harness immediately follows with SIGKILL.
		let status = unsafe { libc::raise(libc::SIGSTOP) };
		assert_eq!(status, 0, "raise SIGSTOP");
	}
	panic!("block crash probe resumed unexpectedly");
}

/// Runs the hidden subprocess write probe used by SIGKILL integration tests.
///
/// # Errors
///
/// Returns an opening or write error when the process is not stopped first.
#[cfg(feature = "fault-injection")]
#[doc(hidden)]
pub fn run_write_crash_probe(
	database: &Path,
	marker: &Path,
	point: CrashPoint,
) -> Result<(), BlockRepositoryError> {
	let repository = BlockMetaRepository::open(
		BlockRepositoryConfig::new(database).with_crash_probe(point, marker),
	)?;
	match point {
		CrashPoint::BeforeWriteCommit
		| CrashPoint::DuringWriteCommit
		| CrashPoint::AfterWriteCommit => {
			let _result = repository.commit_write(CommitWriteRequest {
				volume_id: "crash-volume".to_owned(),
				writer_epoch: 1,
				op_id: "crash-write".to_owned(),
				block_no: 13,
				bytes: vec![0x9a; BLOCK_SIZE_USIZE],
			})?;
		}
		CrashPoint::BeforeRangeCommit
		| CrashPoint::DuringRangeCommit
		| CrashPoint::AfterRangeCommit => {
			let _result = repository.commit_range_write(CommitRangeWriteRequest {
				volume_id: "crash-volume".to_owned(),
				writer_epoch: 1,
				op_id: "crash-range-write".to_owned(),
				offset: 13 * BLOCK_SIZE,
				bytes: vec![0x9a; 32 * BLOCK_SIZE_USIZE],
			})?;
		}
		CrashPoint::BeforeFlushCommit
		| CrashPoint::DuringFlushCommit
		| CrashPoint::AfterFlushCommit => {
			let _result = repository.capture_flush(FlushRequest {
				volume_id: "crash-volume".to_owned(),
				writer_epoch: 1,
				op_id: "crash-flush".to_owned(),
				submitted_sequence: 0,
			})?;
		}
		CrashPoint::BeforeSnapshotCommit
		| CrashPoint::DuringSnapshotCommit
		| CrashPoint::AfterSnapshotCommit => {
			let _result = repository.create_snapshot("crash-volume", "crash-snapshot")?;
		}
		CrashPoint::BeforeDeleteVolumeCommit
		| CrashPoint::DuringDeleteVolumeCommit
		| CrashPoint::AfterDeleteVolumeCommit => {
			let _result = repository.delete_volume(DeleteVolumeRequest {
				volume_id: "crash-volume".to_owned(),
				op_id: "crash-delete-volume".to_owned(),
			})?;
		}
		CrashPoint::BeforeRetentionCommit
		| CrashPoint::DuringRetentionCommit
		| CrashPoint::AfterRetentionCommit => {
			let _result = repository.compact_retained_history(128)?;
		}
	}
	Ok(())
}
