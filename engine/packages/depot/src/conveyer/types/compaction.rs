use anyhow::{Context, Result, bail, ensure};
use gas::prelude::Id;
use serde::{Deserialize, Serialize};
use vbare::OwnedVersionedData;

use super::ids::{BucketBranchId, DatabaseBranchId};
use super::serialization::SQLITE_STORAGE_META_VERSION;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompactionRoot {
	pub schema_version: u32,
	pub manifest_generation: u64,
	pub hot_watermark_txid: u64,
	pub cold_watermark_txid: u64,
	pub cold_watermark_versionstamp: [u8; 16],
}

/// Atomic proof that a hot install committed. This lets Gasoline replay an activity whose FDB
/// commit succeeded but whose activity response was lost without requiring the staged rows, which
/// are cleared by the successful install transaction.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HotPublishMarker {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub lifecycle_generation: u64,
	pub publish_generation: u64,
	pub input_fingerprint: [u8; 32],
	pub staged_row_count: u32,
	pub staged_rows_hash: [u8; 32],
	pub min_txid: u64,
	pub max_txid: u64,
}

/// Bounded exact index for one hot coverage generation. Cold compaction follows this manifest
/// instead of scanning every historical hot shard in a database branch.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HotGenerationManifest {
	pub database_branch_id: DatabaseBranchId,
	pub as_of_txid: u64,
	pub shards: Vec<HotGenerationShardRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HotGenerationShardRef {
	pub shard_id: u32,
	pub size_bytes: u64,
	pub content_hash: [u8; 32],
}

/// Branch- and shard-local proof that a materialized shard is part of an atomically published hot
/// generation. Reads use the reverse-ordered index for this value to distinguish a genuinely
/// sparse zero page from a missing authoritative hot/cold artifact without scanning manifests.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HotShardCoverage {
	pub database_branch_id: DatabaseBranchId,
	pub shard_id: u32,
	pub as_of_txid: u64,
	pub size_bytes: u64,
	pub content_hash: [u8; 32],
}

/// Durable compact proof for a hot shard that was written to its immutable final key before the
/// small atomic root publication transaction. Keeping only this proof under CMP/stage avoids
/// writing the materialized shard bytes twice.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HotShardStageProof {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub shard_id: u32,
	pub as_of_txid: u64,
	pub min_txid: u64,
	pub max_txid: u64,
	pub size_bytes: u64,
	pub content_hash: [u8; 32],
}

/// Durable identity for a staged hot job. The generation-ordered secondary key lets a manager
/// reclaim jobs that are provably fenced by a newer manifest without scanning the stage keyspace
/// or consulting ephemeral worker state.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HotStageJobRecord {
	pub database_branch_id: DatabaseBranchId,
	pub job_id: Id,
	pub base_lifecycle_generation: u64,
	pub base_manifest_generation: u64,
	pub input_fingerprint: [u8; 32],
}

/// Exact immutable object reference published in UniversalDB after the cold-tier PUT succeeds.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ColdShardRef {
	pub database_branch_id: DatabaseBranchId,
	pub object_key: String,
	pub object_generation_id: Id,
	pub shard_id: u32,
	pub as_of_txid: u64,
	pub min_txid: u64,
	pub max_txid: u64,
	pub min_versionstamp: [u8; 16],
	pub max_versionstamp: [u8; 16],
	/// Length and digest of the inner immutable LTX shard. These bind a published cold object to
	/// the exact FDB hot shard that may later be evicted.
	pub ltx_size_bytes: u64,
	pub ltx_content_hash: [u8; 32],
	pub size_bytes: u64,
	pub content_hash: [u8; 32],
	pub lifecycle_generation: u64,
	pub publish_generation: u64,
}

/// Durable, job-local registry for a cold object which may have been written outside FDB. The
/// row is created before the exact-key PUT. It lets failed and stale jobs clean up without an S3
/// LIST or a branch-wide ref scan, including the ambiguous "PUT succeeded, response was lost"
/// case.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ColdUploadIntent {
	pub reference: ColdShardRef,
	pub delete_authorization: Option<super::ColdDeleteAuthorization>,
}

/// Self-describing immutable payload stored in COS/S3. The ref hash and length cover the encoded
/// envelope, while these fields prevent a valid object from being replayed for another branch,
/// shard, lifecycle, or manifest generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColdShardObject {
	pub database_branch_id: DatabaseBranchId,
	pub object_generation_id: Id,
	pub shard_id: u32,
	pub as_of_txid: u64,
	pub min_txid: u64,
	pub max_txid: u64,
	pub min_versionstamp: [u8; 16],
	pub max_versionstamp: [u8; 16],
	pub ltx_size_bytes: u64,
	pub ltx_content_hash: [u8; 32],
	pub lifecycle_generation: u64,
	pub publish_generation: u64,
	pub ltx_bytes: Vec<u8>,
}

/// Small atomic publication gate for refs written ahead of the root update. A cold ref is not
/// readable or eligible for hot eviction unless this exact marker exists and matches it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColdPublishMarker {
	pub database_branch_id: DatabaseBranchId,
	pub object_generation_id: Id,
	pub lifecycle_generation: u64,
	pub publish_generation: u64,
	pub input_fingerprint: [u8; 32],
	pub output_ref_count: u32,
	pub output_refs_hash: [u8; 32],
	pub min_txid: u64,
	pub max_txid: u64,
	pub min_versionstamp: [u8; 16],
	pub max_versionstamp: [u8; 16],
}

impl ColdPublishMarker {
	pub fn matches_ref(&self, reference: &ColdShardRef) -> bool {
		self.database_branch_id == reference.database_branch_id
			&& self.object_generation_id == reference.object_generation_id
			&& self.lifecycle_generation == reference.lifecycle_generation
			&& self.publish_generation == reference.publish_generation
			&& reference.min_txid >= self.min_txid
			&& reference.max_txid <= self.max_txid
			&& reference.min_versionstamp == self.min_versionstamp
			&& reference.max_versionstamp == self.max_versionstamp
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RetiredColdObjectDeleteState {
	Retired,
	DeleteIssued,
	Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RetiredColdObject {
	pub database_branch_id: DatabaseBranchId,
	pub object_key: String,
	pub object_generation_id: Id,
	pub content_hash: [u8; 32],
	/// Exact encoded object-body bytes. This is copied from the immutable ColdShardRef so retire,
	/// delete issue, and delete completion can update the physical ledger without consulting COS.
	pub size_bytes: u64,
	pub shard_id: u32,
	pub as_of_txid: u64,
	pub publish_generation: u64,
	pub retired_manifest_generation: u64,
	pub retired_at_ms: i64,
	pub retired_versionstamp: [u8; 16],
	pub delete_after_ms: i64,
	pub delete_state: RetiredColdObjectDeleteState,
	pub delete_authorization: Option<super::ColdDeleteAuthorization>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqliteCmpDirty {
	pub observed_head_txid: u64,
	pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PitrIntervalCoverage {
	pub txid: u64,
	pub versionstamp: [u8; 16],
	pub wall_clock_ms: i64,
	pub expires_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BucketForkFact {
	pub source_bucket_branch_id: BucketBranchId,
	pub target_bucket_branch_id: BucketBranchId,
	pub fork_versionstamp: [u8; 16],
	pub parent_cap_versionstamp: [u8; 16],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BucketCatalogDbFact {
	pub database_branch_id: DatabaseBranchId,
	pub bucket_branch_id: BucketBranchId,
	pub catalog_versionstamp: [u8; 16],
	pub tombstone_versionstamp: Option<[u8; 16]>,
}

macro_rules! impl_compaction_versioned_data {
	($versioned:ident, $latest:ty, $name:literal) => {
		impl OwnedVersionedData for $versioned {
			type Latest = $latest;

			fn wrap_latest(latest: Self::Latest) -> Self {
				Self::V1(latest)
			}

			fn unwrap_latest(self) -> Result<Self::Latest> {
				match self {
					Self::V1(data) => Ok(data),
				}
			}

			fn deserialize_version(payload: &[u8], version: u16) -> Result<Self> {
				match version {
					1 => Ok(Self::V1(rivet_util::serde::bare_from_slice!(payload)?)),
					_ => bail!("invalid depot {} version: {version}", $name),
				}
			}

			fn serialize_version(self, _version: u16) -> Result<Vec<u8>> {
				match self {
					Self::V1(data) => rivet_util::serde::bare_to_vec!(&data).map_err(Into::into),
				}
			}
		}
	};
}

enum VersionedCompactionRoot {
	V1(CompactionRoot),
}

enum VersionedHotPublishMarker {
	V1(HotPublishMarker),
}

enum VersionedHotGenerationManifest {
	V1(HotGenerationManifest),
}

enum VersionedHotShardCoverage {
	V1(HotShardCoverage),
}

enum VersionedHotShardStageProof {
	V1(HotShardStageProof),
}

enum VersionedHotStageJobRecord {
	V1(HotStageJobRecord),
}

enum VersionedColdShardRef {
	V1(ColdShardRef),
}

enum VersionedColdUploadIntent {
	V1(ColdUploadIntent),
}

enum VersionedColdShardObject {
	V1(ColdShardObject),
}

enum VersionedColdPublishMarker {
	V1(ColdPublishMarker),
}

enum VersionedRetiredColdObject {
	V1(RetiredColdObject),
}

enum VersionedSqliteCmpDirty {
	V1(SqliteCmpDirty),
}

enum VersionedPitrIntervalCoverage {
	V1(PitrIntervalCoverage),
}

enum VersionedBucketForkFact {
	V1(BucketForkFact),
}

enum VersionedBucketCatalogDbFact {
	V1(BucketCatalogDbFact),
}

impl_compaction_versioned_data!(VersionedCompactionRoot, CompactionRoot, "CompactionRoot");
impl_compaction_versioned_data!(
	VersionedHotPublishMarker,
	HotPublishMarker,
	"HotPublishMarker"
);
impl_compaction_versioned_data!(
	VersionedHotGenerationManifest,
	HotGenerationManifest,
	"HotGenerationManifest"
);
impl_compaction_versioned_data!(
	VersionedHotShardCoverage,
	HotShardCoverage,
	"HotShardCoverage"
);
impl_compaction_versioned_data!(
	VersionedHotShardStageProof,
	HotShardStageProof,
	"HotShardStageProof"
);
impl_compaction_versioned_data!(
	VersionedHotStageJobRecord,
	HotStageJobRecord,
	"HotStageJobRecord"
);
impl_compaction_versioned_data!(VersionedColdShardRef, ColdShardRef, "ColdShardRef");
impl_compaction_versioned_data!(
	VersionedColdUploadIntent,
	ColdUploadIntent,
	"ColdUploadIntent"
);
impl_compaction_versioned_data!(VersionedColdShardObject, ColdShardObject, "ColdShardObject");
impl_compaction_versioned_data!(
	VersionedColdPublishMarker,
	ColdPublishMarker,
	"ColdPublishMarker"
);
impl_compaction_versioned_data!(
	VersionedRetiredColdObject,
	RetiredColdObject,
	"RetiredColdObject"
);
impl_compaction_versioned_data!(VersionedSqliteCmpDirty, SqliteCmpDirty, "SqliteCmpDirty");
impl_compaction_versioned_data!(
	VersionedPitrIntervalCoverage,
	PitrIntervalCoverage,
	"PitrIntervalCoverage"
);
impl_compaction_versioned_data!(VersionedBucketForkFact, BucketForkFact, "BucketForkFact");
impl_compaction_versioned_data!(
	VersionedBucketCatalogDbFact,
	BucketCatalogDbFact,
	"BucketCatalogDbFact"
);

pub fn encode_compaction_root(root: CompactionRoot) -> Result<Vec<u8>> {
	VersionedCompactionRoot::wrap_latest(root)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite compaction root")
}

pub fn decode_compaction_root(payload: &[u8]) -> Result<CompactionRoot> {
	VersionedCompactionRoot::deserialize_with_embedded_version(payload)
		.context("decode sqlite compaction root")
}

pub fn encode_hot_publish_marker(marker: HotPublishMarker) -> Result<Vec<u8>> {
	VersionedHotPublishMarker::wrap_latest(marker)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite hot publish marker")
}

pub fn decode_hot_publish_marker(payload: &[u8]) -> Result<HotPublishMarker> {
	VersionedHotPublishMarker::deserialize_with_embedded_version(payload)
		.context("decode sqlite hot publish marker")
}

pub fn encode_hot_generation_manifest(manifest: HotGenerationManifest) -> Result<Vec<u8>> {
	VersionedHotGenerationManifest::wrap_latest(manifest)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite hot generation manifest")
}

pub fn decode_hot_generation_manifest(payload: &[u8]) -> Result<HotGenerationManifest> {
	VersionedHotGenerationManifest::deserialize_with_embedded_version(payload)
		.context("decode sqlite hot generation manifest")
}

pub fn encode_hot_shard_coverage(coverage: HotShardCoverage) -> Result<Vec<u8>> {
	VersionedHotShardCoverage::wrap_latest(coverage)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite hot shard coverage")
}

pub fn decode_hot_shard_coverage(payload: &[u8]) -> Result<HotShardCoverage> {
	VersionedHotShardCoverage::deserialize_with_embedded_version(payload)
		.context("decode sqlite hot shard coverage")
}

pub fn encode_hot_shard_stage_proof(proof: HotShardStageProof) -> Result<Vec<u8>> {
	VersionedHotShardStageProof::wrap_latest(proof)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite hot shard stage proof")
}

pub fn decode_hot_shard_stage_proof(payload: &[u8]) -> Result<HotShardStageProof> {
	VersionedHotShardStageProof::deserialize_with_embedded_version(payload)
		.context("decode sqlite hot shard stage proof")
}

pub fn encode_hot_stage_job_record(record: HotStageJobRecord) -> Result<Vec<u8>> {
	VersionedHotStageJobRecord::wrap_latest(record)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite hot stage job record")
}

pub fn decode_hot_stage_job_record(payload: &[u8]) -> Result<HotStageJobRecord> {
	VersionedHotStageJobRecord::deserialize_with_embedded_version(payload)
		.context("decode sqlite hot stage job record")
}

pub fn encode_cold_shard_ref(reference: ColdShardRef) -> Result<Vec<u8>> {
	VersionedColdShardRef::wrap_latest(reference)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite cold shard ref")
}

pub fn decode_cold_shard_ref(payload: &[u8]) -> Result<ColdShardRef> {
	VersionedColdShardRef::deserialize_with_embedded_version(payload)
		.context("decode sqlite cold shard ref")
}

pub fn encode_cold_upload_intent(intent: ColdUploadIntent) -> Result<Vec<u8>> {
	VersionedColdUploadIntent::wrap_latest(intent)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite cold upload intent")
}

pub fn decode_cold_upload_intent(payload: &[u8]) -> Result<ColdUploadIntent> {
	VersionedColdUploadIntent::deserialize_with_embedded_version(payload)
		.context("decode sqlite cold upload intent")
}

pub fn encode_cold_shard_object(object: ColdShardObject) -> Result<Vec<u8>> {
	VersionedColdShardObject::wrap_latest(object)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite cold shard object")
}

pub fn decode_cold_shard_object(payload: &[u8]) -> Result<ColdShardObject> {
	VersionedColdShardObject::deserialize_with_embedded_version(payload)
		.context("decode sqlite cold shard object")
}

pub fn encode_cold_publish_marker(marker: ColdPublishMarker) -> Result<Vec<u8>> {
	VersionedColdPublishMarker::wrap_latest(marker)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite cold publish marker")
}

pub fn decode_cold_publish_marker(payload: &[u8]) -> Result<ColdPublishMarker> {
	VersionedColdPublishMarker::deserialize_with_embedded_version(payload)
		.context("decode sqlite cold publish marker")
}

pub fn encode_retired_cold_object(object: RetiredColdObject) -> Result<Vec<u8>> {
	ensure!(
		object.retired_at_ms >= 0 && object.delete_after_ms >= 0,
		"sqlite retired cold object timestamps must be non-negative"
	);
	VersionedRetiredColdObject::wrap_latest(object)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite retired cold object")
}

pub fn decode_retired_cold_object(payload: &[u8]) -> Result<RetiredColdObject> {
	let object = VersionedRetiredColdObject::deserialize_with_embedded_version(payload)
		.context("decode sqlite retired cold object")?;
	ensure!(
		object.retired_at_ms >= 0 && object.delete_after_ms >= 0,
		"sqlite retired cold object timestamps must be non-negative"
	);
	Ok(object)
}

pub fn encode_sqlite_cmp_dirty(dirty: SqliteCmpDirty) -> Result<Vec<u8>> {
	VersionedSqliteCmpDirty::wrap_latest(dirty)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite compaction dirty marker")
}

pub fn decode_sqlite_cmp_dirty(payload: &[u8]) -> Result<SqliteCmpDirty> {
	VersionedSqliteCmpDirty::deserialize_with_embedded_version(payload)
		.context("decode sqlite compaction dirty marker")
}

pub fn encode_pitr_interval_coverage(coverage: PitrIntervalCoverage) -> Result<Vec<u8>> {
	ensure!(
		coverage.wall_clock_ms >= 0 && coverage.expires_at_ms >= 0,
		"sqlite PITR interval timestamps must be non-negative"
	);
	VersionedPitrIntervalCoverage::wrap_latest(coverage)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite PITR interval coverage")
}

pub fn decode_pitr_interval_coverage(payload: &[u8]) -> Result<PitrIntervalCoverage> {
	let coverage = VersionedPitrIntervalCoverage::deserialize_with_embedded_version(payload)
		.context("decode sqlite PITR interval coverage")?;
	ensure!(
		coverage.wall_clock_ms >= 0 && coverage.expires_at_ms >= 0,
		"sqlite PITR interval timestamps must be non-negative"
	);
	Ok(coverage)
}

pub fn encode_bucket_fork_fact(fact: BucketForkFact) -> Result<Vec<u8>> {
	VersionedBucketForkFact::wrap_latest(fact)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite bucket fork fact")
}

pub fn decode_bucket_fork_fact(payload: &[u8]) -> Result<BucketForkFact> {
	VersionedBucketForkFact::deserialize_with_embedded_version(payload)
		.context("decode sqlite bucket fork fact")
}

pub fn encode_bucket_catalog_db_fact(fact: BucketCatalogDbFact) -> Result<Vec<u8>> {
	VersionedBucketCatalogDbFact::wrap_latest(fact)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite bucket catalog db fact")
}

pub fn decode_bucket_catalog_db_fact(payload: &[u8]) -> Result<BucketCatalogDbFact> {
	VersionedBucketCatalogDbFact::deserialize_with_embedded_version(payload)
		.context("decode sqlite bucket catalog db fact")
}
