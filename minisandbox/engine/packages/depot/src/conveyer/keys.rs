//! Key builders for depot blobs and indexes.

use anyhow::{Context, Result, bail, ensure};
use gas::prelude::Id;
use universaldb::utils::end_of_prefix_range;

use super::types::{BucketBranchId, BucketId, DatabaseBranchId};

pub const SQLITE_SUBSPACE_PREFIX: u8 = 0x02;
pub const DBPTR_PARTITION: u8 = 0x10;
pub const BUCKET_PTR_PARTITION: u8 = 0x11;
pub const BUCKET_CATALOG_PARTITION: u8 = 0x12;
pub const BRANCHES_PARTITION: u8 = 0x20;
pub const BUCKET_BRANCH_PARTITION: u8 = 0x21;
pub const BR_PARTITION: u8 = 0x30;
pub const CTR_PARTITION: u8 = 0x40;
pub const RESTORE_POINT_PARTITION: u8 = 0x50;
pub const CMPC_PARTITION: u8 = 0x60;
pub const DB_PIN_PARTITION: u8 = 0x70;
pub const BUCKET_FORK_PIN_PARTITION: u8 = 0x71;
pub const BUCKET_CHILD_PARTITION: u8 = 0x72;
pub const BUCKET_CATALOG_BY_DB_PARTITION: u8 = 0x73;
pub const BUCKET_PROOF_EPOCH_PARTITION: u8 = 0x74;
pub const SQLITE_CMP_DIRTY_PARTITION: u8 = 0x75;
pub const DB_POLICY_BINDING_PARTITION: u8 = 0x76;
pub const BUCKET_POLICY_PITR_SHARD_PARTITION: u8 = 0x77;
pub const DB_PIN_BY_TXID_PARTITION: u8 = 0x78;
pub const DB_PIN_TXID_COUNT_PARTITION: u8 = 0x79;
pub const COLD_TIER_IDENTITY_PARTITION: u8 = 0x7a;
pub const DB_BRANCH_GC_QUEUE_PARTITION: u8 = 0x7b;
pub const DB_BRANCH_GC_QUEUE_LOCATOR_PARTITION: u8 = 0x7c;
pub const COLD_BACKUP_RECOVERY_FENCE_PARTITION: u8 = 0x7d;
pub const DB_BRANCH_COLD_GC_MANIFEST_PARTITION: u8 = 0x7e;
pub const DB_BRANCH_COLD_GC_OBJECT_PARTITION: u8 = 0x7f;
pub const DB_BRANCH_COLD_GC_QUEUE_PARTITION: u8 = 0x80;
pub const DB_BRANCH_COLD_GC_QUEUE_LOCATOR_PARTITION: u8 = 0x81;
/// Sharded one-row-per-job index of cold uploads that have not reached an atomic publish or exact
/// orphan cleanup. This makes fleet backlog qualification O(backlog) instead of a scan of every
/// database branch.
pub const COLD_UPLOAD_JOB_QUEUE_PARTITION: u8 = 0x82;
/// Sharded one-row-per-job index of durable hot stages that have not been installed or cleaned.
/// The dirty-branch index covers actionable lag before the first stage write; this index covers
/// orphaned/in-flight staged artifacts without scanning every branch's permanent CMP metadata.
pub const HOT_COMPACTION_JOB_QUEUE_PARTITION: u8 = 0x83;
/// Cell-wide durable counters for the physical cold-object lifecycle. Each field is stored in its
/// own key so the metadata transition and its accounting delta can share one FDB transaction
/// without creating a globally contended read/modify/write record.
pub const COLD_STORAGE_ACCOUNTING_PARTITION: u8 = 0x84;
/// Cell-wide, dynamically managed authorization for irreversible exact-key cold deletion.
/// Absence is interpreted as disabled, so a fresh or partially restored Cell fails closed.
pub const COLD_GC_POLICY_PARTITION: u8 = 0x85;
/// Immutable per-object deletion receipts. The exact-key hash bounds key size while the encoded
/// receipt retains the canonical object key for audit and provider reconciliation.
pub const COLD_DELETE_RECEIPT_PARTITION: u8 = 0x86;
/// Best-effort leader lease for the bounded, read-only physical cold-object inventory audit.
/// It prevents every Engine replica from independently listing the same provider bucket.
pub const COLD_INVENTORY_AUDIT_PARTITION: u8 = 0x87;
/// Ordered retry queue for dirty branches whose low-latency Gasoline wake may have been lost.
pub const SQLITE_CMP_DIRTY_DUE_PARTITION: u8 = 0x88;
/// One exact retry-queue locator per dirty branch. This makes rescheduling and clearing O(1).
pub const SQLITE_CMP_DIRTY_DUE_LOCATOR_PARTITION: u8 = 0x89;
/// One-time cursor used to backfill retry locators for dirty rows created by older binaries.
pub const SQLITE_CMP_DIRTY_DUE_BACKFILL_PARTITION: u8 = 0x8a;
pub const DB_BRANCH_GC_QUEUE_SHARD_COUNT: u8 = 64;
pub const DB_BRANCH_COLD_GC_QUEUE_SHARD_COUNT: u8 = 64;
pub const COLD_UPLOAD_JOB_QUEUE_SHARD_COUNT: u8 = 64;
pub const HOT_COMPACTION_JOB_QUEUE_SHARD_COUNT: u8 = 64;
pub const PAGE_SIZE: u32 = 4096;
pub const SHARD_SIZE: u32 = 64;

const META_HEAD_PATH: &[u8] = b"/META/head";
const META_TRUNCATE_TXID_PATH: &[u8] = b"/META/truncate_txid";
const META_HEAD_AT_FORK_PATH: &[u8] = b"/META/head_at_fork";
const META_COMMIT_ATTEMPT_PATH: &[u8] = b"/META/commit_attempt";
const META_COMPACT_PATH: &[u8] = b"/META/compact";
const META_QUOTA_PATH: &[u8] = b"/META/quota";
const META_COMPACTOR_LEASE_PATH: &[u8] = b"/META/compactor_lease";
const META_PAGE_HISTORY_COMPLETE_TXID_PATH: &[u8] = b"/META/page_history_complete_txid";
const META_PIDX_COUNT_INDEX_COMPLETE_PATH: &[u8] = b"/META/pidx_count_index_complete";
const META_PIDX_COUNT_NODE_PATH: &[u8] = b"/META/pidx_count_node/";
const META_COLD_RETIRE_SCAN_CURSOR_PATH: &[u8] = b"/META/cold_retire_scan_cursor";
const META_HOT_EVICT_SCAN_CURSOR_PATH: &[u8] = b"/META/hot_evict_scan_cursor";
const META_GC_DELETING_PATH: &[u8] = b"/META/gc/deleting";
const META_HISTORY_PIN_COUNT_SHARD_PATH: &[u8] = b"/META/history_pin_count_shard/";
const META_BUCKET_PROOF_COMPLETE_PATH: &[u8] = b"/META/bucket_proof/complete";
const META_BUCKET_PROOF_CATALOG_COMPLETE_PATH: &[u8] = b"/META/bucket_proof/catalog_complete";
const META_BUCKET_PROOF_CATALOG_CURSOR_PATH: &[u8] = b"/META/bucket_proof/catalog_cursor";
const META_BUCKET_PROOF_ROOT_PATH: &[u8] = b"/META/bucket_proof/root/";
const META_BUCKET_PROOF_EPOCH_SHARD_PATH: &[u8] = b"/META/bucket_proof/epoch_shard/";
const META_BUCKET_PROOF_QUEUE_PATH: &[u8] = b"/META/bucket_proof/queue/";
const META_BUCKET_PROOF_QUEUE_CURSOR_PATH: &[u8] = b"/META/bucket_proof/queue_cursor/";
const META_BUCKET_PROOF_SEEN_PATH: &[u8] = b"/META/bucket_proof/seen/";
const CMP_ROOT_PATH: &[u8] = b"/CMP/root";
const CMP_HOT_PUBLISH_PATH: &[u8] = b"/CMP/hot_publish/";
const CMP_HOT_GENERATION_PATH: &[u8] = b"/CMP/hot_generation/";
const CMP_HOT_SHARD_COVERAGE_PATH: &[u8] = b"/CMP/hot_shard_coverage/";
const CMP_COLD_SHARD_PATH: &[u8] = b"/CMP/cold_shard/";
const CMP_COLD_PUBLISH_PATH: &[u8] = b"/CMP/cold_publish/";
const CMP_COLD_PUBLISH_REFCOUNT_PATH: &[u8] = b"/CMP/cold_publish_refcount/";
const CMP_COLD_UPLOAD_INTENT_PATH: &[u8] = b"/CMP/cold_upload_intent/";
const CMP_RETIRED_COLD_OBJECT_PATH: &[u8] = b"/CMP/retired_cold_object/";
const CMP_RETIRED_COLD_OBJECT_DUE_PATH: &[u8] = b"/CMP/retired_cold_object_due/";
const CMP_STAGE_PATH: &[u8] = b"/CMP/stage/";
const CMP_STAGE_HOT_SHARD_PATH: &[u8] = b"/hot_shard/";
const CMP_STAGE_HOT_JOB_PATH: &[u8] = b"/CMP/stage_hot_job/";
const CMP_STAGE_HOT_JOB_BY_GENERATION_PATH: &[u8] = b"/CMP/stage_hot_job_by_generation/";
const SHARD_PATH: &[u8] = b"/SHARD/";
const SHARD_CHUNK_PATH: &[u8] = b"/SHARD_CHUNK/";
const DELTA_PATH: &[u8] = b"/DELTA/";
const PIDX_DELTA_PATH: &[u8] = b"/PIDX/delta/";
const BR_PIDX_PATH: &[u8] = b"/PIDX/";
const BR_PAGE_HISTORY_PATH: &[u8] = b"/PAGE_HISTORY/";
const COMMITS_PATH: &[u8] = b"/COMMITS/";
const VTX_PATH: &[u8] = b"/VTX/";
const PITR_INTERVAL_PATH: &[u8] = b"/PITR_INTERVAL/";
const PITR_INTERVAL_BY_TXID_PATH: &[u8] = b"/PITR_INTERVAL_BY_TXID/";
const PITR_INTERVAL_DUE_PATH: &[u8] = b"/PITR_INTERVAL_DUE/";
const CUR_PATH: &[u8] = b"/cur";
const HISTORY_PATH: &[u8] = b"/history/";
const POLICY_PITR_PATH: &[u8] = b"/POLICY/PITR";
const POLICY_SHARD_CACHE_PATH: &[u8] = b"/POLICY/SHARD_CACHE";
const DB_POLICY_PATH: &[u8] = b"/DB_POLICY/";
const PITR_PATH: &[u8] = b"/PITR";
const SHARD_CACHE_PATH: &[u8] = b"/SHARD_CACHE";
const LIST_PATH: &[u8] = b"/list/";
const REFCOUNT_PATH: &[u8] = b"/refcount";
const DESC_PIN_PATH: &[u8] = b"/desc_pin";
const RESTORE_POINT_PIN_PATH: &[u8] = b"/restore_point_pin";
const PIN_COUNT_PATH: &[u8] = b"/pin_count";
const DATABASE_TOMBSTONES_PATH: &[u8] = b"/database_tombstones/";
const MANIFEST_LAST_HOT_PASS_TXID_PATH: &[u8] = b"/META/manifest/last_hot_pass_txid";
const MANIFEST_LAST_ACCESS_TS_MS_PATH: &[u8] = b"/META/manifest/last_access_ts_ms";
const MANIFEST_LAST_ACCESS_BUCKET_PATH: &[u8] = b"/META/manifest/last_access_bucket";
const CTR_QUOTA_GLOBAL_PATH: &[u8] = b"/quota_global";
const CTR_EVICTION_INDEX_PATH: &[u8] = b"/eviction_index/";
const RESTORE_POINT_PATH: &[u8] = b"/";
const DB_PIN_PATH: &[u8] = b"/";
const DB_PIN_BY_TXID_PATH: &[u8] = b"/";
const DB_PIN_TXID_COUNT_PATH: &[u8] = b"/";
const COLD_TIER_IDENTITY_PATH: &[u8] = b"/current";
const COLD_STORAGE_ACCOUNTING_PATH: &[u8] = b"/";
const COLD_GC_POLICY_PATH: &[u8] = b"/current";
const COLD_DELETE_RECEIPT_PATH: &[u8] = b"/";
const COLD_INVENTORY_AUDIT_LEASE_PATH: &[u8] = b"/lease";
const COLD_INVENTORY_AUDIT_STATE_PATH: &[u8] = b"/state";
const DB_BRANCH_GC_QUEUE_PATH: &[u8] = b"/";
const DB_BRANCH_GC_QUEUE_LOCATOR_PATH: &[u8] = b"/";
const COLD_BACKUP_RECOVERY_FENCE_PATH: &[u8] = b"/current";
const COLD_BACKUP_RECOVERY_POLICY_PATH: &[u8] = b"/policy";
const COLD_BACKUP_RECOVERY_CONTROLLER_LEASE_PATH: &[u8] = b"/controller_lease";
const DB_BRANCH_COLD_GC_MANIFEST_PATH: &[u8] = b"/";
const DB_BRANCH_COLD_GC_OBJECT_PATH: &[u8] = b"/";
const DB_BRANCH_COLD_GC_QUEUE_PATH: &[u8] = b"/";
const DB_BRANCH_COLD_GC_QUEUE_LOCATOR_PATH: &[u8] = b"/";
const BUCKET_FORK_PIN_PATH: &[u8] = b"/";
const BUCKET_CHILD_PATH: &[u8] = b"/";
const BUCKET_CATALOG_BY_DB_PATH: &[u8] = b"/";
const BUCKET_PROOF_EPOCH_PATH: &[u8] = b"/";
const BUCKET_PROOF_EPOCH_SHARD_PATH: &[u8] = b"/SHARD/";
const SQLITE_CMP_DIRTY_PATH: &[u8] = b"/";
const SQLITE_CMP_DIRTY_DUE_PATH: &[u8] = b"/";
const SQLITE_CMP_DIRTY_DUE_LOCATOR_PATH: &[u8] = b"/";
const SQLITE_CMP_DIRTY_DUE_BACKFILL_PATH: &[u8] = b"/";
const DB_POLICY_BINDING_PATH: &[u8] = b"/";
const BUCKET_POLICY_PITR_SHARD_PATH: &[u8] = b"/";

fn partition_prefix(partition: u8) -> Vec<u8> {
	vec![SQLITE_SUBSPACE_PREFIX, partition]
}

fn uuid_bytes(uuid: uuid::Uuid) -> [u8; 16] {
	*uuid.as_bytes()
}

fn append_uuid(key: &mut Vec<u8>, uuid: uuid::Uuid) {
	key.extend_from_slice(&uuid_bytes(uuid));
}

fn append_ts_nonce(key: &mut Vec<u8>, ts_ms: i64, nonce: u32) {
	key.extend_from_slice(&ts_ms.to_be_bytes());
	key.extend_from_slice(&nonce.to_be_bytes());
}

fn append_id(key: &mut Vec<u8>, id: Id) {
	key.extend_from_slice(&id.as_bytes());
}

fn append_database_id(key: &mut Vec<u8>, database_id: &str) {
	key.extend_from_slice(database_id.as_bytes());
}

fn branch_record_base(branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut key = partition_prefix(BRANCHES_PARTITION);
	key.extend_from_slice(LIST_PATH);
	append_uuid(&mut key, branch_id.as_uuid());
	key
}

fn bucket_branch_record_base(branch_id: BucketBranchId) -> Vec<u8> {
	let mut key = partition_prefix(BUCKET_BRANCH_PARTITION);
	key.extend_from_slice(LIST_PATH);
	append_uuid(&mut key, branch_id.as_uuid());
	key
}

fn database_branch_base(branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut key = partition_prefix(BR_PARTITION);
	key.push(b'/');
	append_uuid(&mut key, branch_id.as_uuid());
	key
}

fn database_pointer_base(bucket_branch_id: BucketBranchId, database_id: &str) -> Vec<u8> {
	let mut key = partition_prefix(DBPTR_PARTITION);
	key.push(b'/');
	append_uuid(&mut key, bucket_branch_id.as_uuid());
	key.push(b'/');
	append_database_id(&mut key, database_id);
	key
}

fn bucket_pointer_base(bucket_id: BucketId) -> Vec<u8> {
	let mut key = partition_prefix(BUCKET_PTR_PARTITION);
	key.push(b'/');
	append_uuid(&mut key, bucket_id.as_uuid());
	key
}

fn bucket_catalog_base(bucket_branch_id: BucketBranchId) -> Vec<u8> {
	let mut key = partition_prefix(BUCKET_CATALOG_PARTITION);
	key.push(b'/');
	append_uuid(&mut key, bucket_branch_id.as_uuid());
	key.push(b'/');
	key
}

fn with_suffix(mut prefix: Vec<u8>, suffix: &[u8]) -> Vec<u8> {
	prefix.extend_from_slice(suffix);
	prefix
}

/// Build the common database-scoped prefix: `[0x02, database_id_bytes]`.
pub fn database_prefix(database_id: &str) -> Vec<u8> {
	let database_bytes = database_id.as_bytes();
	let mut key = Vec::with_capacity(1 + database_bytes.len());
	key.push(SQLITE_SUBSPACE_PREFIX);
	key.extend_from_slice(database_bytes);
	key
}

pub fn database_range(database_id: &str) -> (Vec<u8>, Vec<u8>) {
	let mut start = database_prefix(database_id);
	start.push(b'/');
	let end = end_of_prefix_range(&start);
	(start, end)
}

pub fn database_pointer_cur_key(bucket_branch_id: BucketBranchId, database_id: &str) -> Vec<u8> {
	with_suffix(
		database_pointer_base(bucket_branch_id, database_id),
		CUR_PATH,
	)
}

pub fn database_pointer_cur_prefix() -> Vec<u8> {
	let mut key = partition_prefix(DBPTR_PARTITION);
	key.push(b'/');
	key
}

pub fn decode_database_pointer_cur_key(key: &[u8]) -> Result<(BucketBranchId, String)> {
	let prefix = database_pointer_cur_prefix();
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("database pointer key did not start with expected prefix")?;
	ensure!(
		suffix.len() > std::mem::size_of::<uuid::Uuid>() + 1 + CUR_PATH.len(),
		"database pointer key suffix is too short"
	);
	let (bucket_branch_bytes, rest) = suffix.split_at(std::mem::size_of::<uuid::Uuid>());
	ensure!(
		rest.first() == Some(&b'/'),
		"database pointer key missing bucket/database separator"
	);
	let database_id_bytes = rest[1..]
		.strip_suffix(CUR_PATH)
		.context("database pointer key did not end with current pointer suffix")?;
	let uuid = uuid::Uuid::from_slice(bucket_branch_bytes)
		.context("decode database pointer bucket branch uuid")?;
	let database_id = String::from_utf8(database_id_bytes.to_vec())
		.context("database pointer database id was not utf-8")?;

	Ok((BucketBranchId::from_uuid(uuid), database_id))
}

pub fn database_pointer_history_key(
	bucket_branch_id: BucketBranchId,
	database_id: &str,
	ts_ms: i64,
	nonce: u32,
) -> Vec<u8> {
	let mut key = database_pointer_history_prefix(bucket_branch_id, database_id);
	append_ts_nonce(&mut key, ts_ms, nonce);
	key
}

pub fn database_pointer_history_prefix(
	bucket_branch_id: BucketBranchId,
	database_id: &str,
) -> Vec<u8> {
	with_suffix(
		database_pointer_base(bucket_branch_id, database_id),
		HISTORY_PATH,
	)
}

pub fn bucket_pointer_cur_key(bucket_id: BucketId) -> Vec<u8> {
	with_suffix(bucket_pointer_base(bucket_id), CUR_PATH)
}

pub fn bucket_pointer_cur_prefix() -> Vec<u8> {
	let mut key = partition_prefix(BUCKET_PTR_PARTITION);
	key.push(b'/');
	key
}

pub fn decode_bucket_pointer_cur_bucket_id(key: &[u8]) -> Result<BucketId> {
	let prefix = bucket_pointer_cur_prefix();
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("bucket pointer key did not start with expected prefix")?;
	let Some(bucket_id_bytes) = suffix.strip_suffix(CUR_PATH) else {
		bail!("bucket pointer key did not end with current pointer suffix");
	};
	ensure!(
		bucket_id_bytes.len() == std::mem::size_of::<uuid::Uuid>(),
		"bucket pointer key bucket id had {} bytes, expected {}",
		bucket_id_bytes.len(),
		std::mem::size_of::<uuid::Uuid>()
	);
	let uuid = uuid::Uuid::from_slice(bucket_id_bytes).context("decode bucket pointer uuid")?;

	Ok(BucketId::from_uuid(uuid))
}

pub fn bucket_pointer_history_key(bucket_id: BucketId, ts_ms: i64, nonce: u32) -> Vec<u8> {
	let mut key = bucket_pointer_history_prefix(bucket_id);
	append_ts_nonce(&mut key, ts_ms, nonce);
	key
}

pub fn bucket_pointer_history_prefix(bucket_id: BucketId) -> Vec<u8> {
	with_suffix(bucket_pointer_base(bucket_id), HISTORY_PATH)
}

pub fn bucket_policy_pitr_key(bucket_id: BucketId) -> Vec<u8> {
	with_suffix(bucket_pointer_base(bucket_id), POLICY_PITR_PATH)
}

pub fn bucket_policy_shard_cache_key(bucket_id: BucketId) -> Vec<u8> {
	with_suffix(bucket_pointer_base(bucket_id), POLICY_SHARD_CACHE_PATH)
}

pub fn database_pitr_policy_key(bucket_id: BucketId, database_id: &str) -> Vec<u8> {
	let mut key = with_suffix(bucket_pointer_base(bucket_id), DB_POLICY_PATH);
	append_database_id(&mut key, database_id);
	key.extend_from_slice(PITR_PATH);
	key
}

/// Immutable reverse lookup from a physical database branch to the logical policy scope that
/// created it. The UUID is directly below the partition so unrelated branches naturally spread
/// across FoundationDB key ranges instead of sharing one globally scanned range.
pub fn database_policy_binding_key(database_branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut key = with_suffix(
		partition_prefix(DB_POLICY_BINDING_PARTITION),
		DB_POLICY_BINDING_PATH,
	);
	append_uuid(&mut key, database_branch_id.as_uuid());
	key
}

/// One of 256 read replicas of a bucket's default PITR policy. The shard byte comes before the
/// bucket UUID so a very large bucket does not force every compactor to read one hot key range.
pub fn bucket_policy_pitr_shard_key(bucket_id: BucketId, shard: u8) -> Vec<u8> {
	let mut key = with_suffix(
		partition_prefix(BUCKET_POLICY_PITR_SHARD_PARTITION),
		BUCKET_POLICY_PITR_SHARD_PATH,
	);
	key.push(shard);
	key.push(b'/');
	append_uuid(&mut key, bucket_id.as_uuid());
	key
}

pub fn database_shard_cache_policy_key(bucket_id: BucketId, database_id: &str) -> Vec<u8> {
	let mut key = with_suffix(bucket_pointer_base(bucket_id), DB_POLICY_PATH);
	append_database_id(&mut key, database_id);
	key.extend_from_slice(SHARD_CACHE_PATH);
	key
}

pub fn branches_list_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	branch_record_base(branch_id)
}

pub fn branches_refcount_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(branch_record_base(branch_id), REFCOUNT_PATH)
}

pub fn branches_desc_pin_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(branch_record_base(branch_id), DESC_PIN_PATH)
}

pub fn branches_restore_point_pin_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(branch_record_base(branch_id), RESTORE_POINT_PIN_PATH)
}

pub fn bucket_branches_list_key(branch_id: BucketBranchId) -> Vec<u8> {
	bucket_branch_record_base(branch_id)
}

pub fn bucket_branches_refcount_key(branch_id: BucketBranchId) -> Vec<u8> {
	with_suffix(bucket_branch_record_base(branch_id), REFCOUNT_PATH)
}

pub fn bucket_branches_desc_pin_key(branch_id: BucketBranchId) -> Vec<u8> {
	with_suffix(bucket_branch_record_base(branch_id), DESC_PIN_PATH)
}

pub fn bucket_branches_restore_point_pin_key(branch_id: BucketBranchId) -> Vec<u8> {
	with_suffix(bucket_branch_record_base(branch_id), RESTORE_POINT_PIN_PATH)
}

pub fn bucket_branches_pin_count_key(branch_id: BucketBranchId) -> Vec<u8> {
	with_suffix(bucket_branch_record_base(branch_id), PIN_COUNT_PATH)
}

pub fn bucket_branches_database_name_tombstone_key(
	branch_id: BucketBranchId,
	database_id: &str,
) -> Vec<u8> {
	let mut key = with_suffix(
		bucket_branch_record_base(branch_id),
		DATABASE_TOMBSTONES_PATH,
	);
	append_database_id(&mut key, database_id);
	key
}

pub fn bucket_branches_database_tombstone_key(
	branch_id: BucketBranchId,
	database_id: DatabaseBranchId,
) -> Vec<u8> {
	let mut key = with_suffix(
		bucket_branch_record_base(branch_id),
		DATABASE_TOMBSTONES_PATH,
	);
	append_uuid(&mut key, database_id.as_uuid());
	key
}

pub fn bucket_branches_database_tombstone_prefix(branch_id: BucketBranchId) -> Vec<u8> {
	with_suffix(
		bucket_branch_record_base(branch_id),
		DATABASE_TOMBSTONES_PATH,
	)
}

pub fn decode_bucket_branches_database_tombstone_id(
	branch_id: BucketBranchId,
	key: &[u8],
) -> Result<DatabaseBranchId> {
	let prefix = bucket_branches_database_tombstone_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("bucket database tombstone key did not start with expected prefix")?;
	ensure!(
		suffix.len() == std::mem::size_of::<uuid::Uuid>(),
		"bucket database tombstone key suffix had {} bytes, expected {}",
		suffix.len(),
		std::mem::size_of::<uuid::Uuid>()
	);
	let uuid = uuid::Uuid::from_slice(suffix).context("decode bucket database tombstone uuid")?;

	Ok(DatabaseBranchId::from_uuid(uuid))
}

pub fn bucket_catalog_key(
	bucket_branch_id: BucketBranchId,
	database_id: DatabaseBranchId,
) -> Vec<u8> {
	let mut key = bucket_catalog_prefix(bucket_branch_id);
	append_uuid(&mut key, database_id.as_uuid());
	key
}

pub fn bucket_catalog_prefix(bucket_branch_id: BucketBranchId) -> Vec<u8> {
	bucket_catalog_base(bucket_branch_id)
}

pub fn decode_bucket_catalog_database_id(
	bucket_branch_id: BucketBranchId,
	key: &[u8],
) -> Result<DatabaseBranchId> {
	let prefix = bucket_catalog_prefix(bucket_branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("bucket catalog key did not start with expected prefix")?;
	ensure!(
		suffix.len() == std::mem::size_of::<uuid::Uuid>(),
		"bucket catalog key suffix had {} bytes, expected {}",
		suffix.len(),
		std::mem::size_of::<uuid::Uuid>()
	);
	let uuid = uuid::Uuid::from_slice(suffix).context("decode bucket catalog database uuid")?;

	Ok(DatabaseBranchId::from_uuid(uuid))
}

pub fn branch_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	database_branch_base(branch_id)
}

pub fn branch_range(branch_id: DatabaseBranchId) -> (Vec<u8>, Vec<u8>) {
	let mut start = branch_prefix(branch_id);
	start.push(b'/');
	let end = end_of_prefix_range(&start);
	(start, end)
}

pub fn branch_meta_head_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), META_HEAD_PATH)
}

/// Zero proves the branch has never truncated. Missing data provides no such proof.
pub fn branch_meta_truncate_txid_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), META_TRUNCATE_TXID_PATH)
}

pub fn branch_meta_head_at_fork_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), META_HEAD_AT_FORK_PATH)
}

/// Latest successful logical commit proof for this branch. The value is overwritten by the next
/// serialized writer, so retry lookup is one exact point read and storage remains O(1) per branch.
pub fn branch_meta_commit_attempt_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), META_COMMIT_ATTEMPT_PATH)
}

pub fn branch_meta_compact_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), META_COMPACT_PATH)
}

pub fn branch_meta_quota_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), META_QUOTA_PATH)
}

pub fn branch_meta_compactor_lease_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), META_COMPACTOR_LEASE_PATH)
}

pub fn branch_gc_deleting_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), META_GC_DELETING_PATH)
}

pub fn branch_manifest_last_hot_pass_txid_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		MANIFEST_LAST_HOT_PASS_TXID_PATH,
	)
}

pub fn branch_manifest_last_access_ts_ms_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		MANIFEST_LAST_ACCESS_TS_MS_PATH,
	)
}

pub fn branch_manifest_last_access_bucket_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		MANIFEST_LAST_ACCESS_BUCKET_PATH,
	)
}

pub fn branch_compaction_root_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), CMP_ROOT_PATH)
}

pub fn branch_bucket_proof_complete_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		META_BUCKET_PROOF_COMPLETE_PATH,
	)
}

pub fn branch_bucket_proof_catalog_complete_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		META_BUCKET_PROOF_CATALOG_COMPLETE_PATH,
	)
}

pub fn branch_bucket_proof_catalog_cursor_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		META_BUCKET_PROOF_CATALOG_CURSOR_PATH,
	)
}

pub fn branch_bucket_proof_root_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), META_BUCKET_PROOF_ROOT_PATH)
}

pub fn branch_bucket_proof_root_key(
	branch_id: DatabaseBranchId,
	root_bucket_branch_id: BucketBranchId,
) -> Vec<u8> {
	let mut key = branch_bucket_proof_root_prefix(branch_id);
	append_uuid(&mut key, root_bucket_branch_id.as_uuid());
	key
}

pub fn decode_branch_bucket_proof_root_key(
	branch_id: DatabaseBranchId,
	key: &[u8],
) -> Result<BucketBranchId> {
	let prefix = branch_bucket_proof_root_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("bucket proof root key escaped branch prefix")?;
	ensure!(
		suffix.len() == 16,
		"bucket proof root key suffix had invalid length"
	);
	Ok(BucketBranchId::from_uuid(uuid::Uuid::from_bytes(
		suffix.try_into().context("decode bucket proof root UUID")?,
	)))
}

pub fn branch_bucket_proof_epoch_shard_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		META_BUCKET_PROOF_EPOCH_SHARD_PATH,
	)
}

pub fn branch_bucket_proof_epoch_shard_key(
	branch_id: DatabaseBranchId,
	epoch_shard: u8,
) -> Vec<u8> {
	let mut key = branch_bucket_proof_epoch_shard_prefix(branch_id);
	key.push(epoch_shard);
	key
}

pub fn decode_branch_bucket_proof_epoch_shard_key(
	branch_id: DatabaseBranchId,
	key: &[u8],
) -> Result<u8> {
	let prefix = branch_bucket_proof_epoch_shard_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("bucket proof epoch-shard key escaped branch prefix")?;
	ensure!(
		suffix.len() == 1,
		"bucket proof epoch-shard key suffix had invalid length"
	);
	Ok(suffix[0])
}

pub fn branch_bucket_proof_queue_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		META_BUCKET_PROOF_QUEUE_PATH,
	)
}

pub fn branch_bucket_proof_queue_key(
	branch_id: DatabaseBranchId,
	source_bucket_branch_id: BucketBranchId,
	catalog_bucket_branch_id: BucketBranchId,
) -> Vec<u8> {
	let mut key = branch_bucket_proof_queue_prefix(branch_id);
	append_uuid(&mut key, source_bucket_branch_id.as_uuid());
	append_uuid(&mut key, catalog_bucket_branch_id.as_uuid());
	key
}

pub fn decode_branch_bucket_proof_queue_key(
	branch_id: DatabaseBranchId,
	key: &[u8],
) -> Result<(BucketBranchId, BucketBranchId)> {
	let prefix = branch_bucket_proof_queue_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("bucket proof queue key escaped branch prefix")?;
	ensure!(
		suffix.len() == 32,
		"bucket proof queue key suffix had invalid length"
	);
	Ok((
		BucketBranchId::from_uuid(uuid::Uuid::from_bytes(
			suffix[..16]
				.try_into()
				.context("decode queue source UUID")?,
		)),
		BucketBranchId::from_uuid(uuid::Uuid::from_bytes(
			suffix[16..]
				.try_into()
				.context("decode queue catalog UUID")?,
		)),
	))
}

pub fn branch_bucket_proof_queue_cursor_key(
	branch_id: DatabaseBranchId,
	source_bucket_branch_id: BucketBranchId,
	catalog_bucket_branch_id: BucketBranchId,
) -> Vec<u8> {
	let mut key = branch_bucket_proof_queue_cursor_prefix(branch_id);
	append_uuid(&mut key, source_bucket_branch_id.as_uuid());
	append_uuid(&mut key, catalog_bucket_branch_id.as_uuid());
	key
}

pub fn branch_bucket_proof_queue_cursor_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		META_BUCKET_PROOF_QUEUE_CURSOR_PATH,
	)
}

pub fn branch_bucket_proof_seen_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), META_BUCKET_PROOF_SEEN_PATH)
}

pub fn branch_bucket_proof_seen_key(
	branch_id: DatabaseBranchId,
	source_bucket_branch_id: BucketBranchId,
	catalog_bucket_branch_id: BucketBranchId,
) -> Vec<u8> {
	let mut key = branch_bucket_proof_seen_prefix(branch_id);
	append_uuid(&mut key, source_bucket_branch_id.as_uuid());
	append_uuid(&mut key, catalog_bucket_branch_id.as_uuid());
	key
}

pub fn branch_compaction_hot_publish_key(
	branch_id: DatabaseBranchId,
	publish_generation: u64,
) -> Vec<u8> {
	let mut key = with_suffix(database_branch_base(branch_id), CMP_HOT_PUBLISH_PATH);
	key.extend_from_slice(&publish_generation.to_be_bytes());
	key
}

pub fn branch_compaction_hot_generation_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), CMP_HOT_GENERATION_PATH)
}

pub fn branch_compaction_hot_generation_key(
	branch_id: DatabaseBranchId,
	as_of_txid: u64,
) -> Vec<u8> {
	let mut key = branch_compaction_hot_generation_prefix(branch_id);
	key.extend_from_slice(&as_of_txid.to_be_bytes());
	key
}

pub fn decode_branch_compaction_hot_generation_txid(
	branch_id: DatabaseBranchId,
	key: &[u8],
) -> Result<u64> {
	let prefix = branch_compaction_hot_generation_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("hot generation key did not start with expected branch prefix")?;
	let bytes: [u8; 8] = suffix
		.try_into()
		.map_err(|_| anyhow::anyhow!("hot generation key suffix had invalid length"))?;
	Ok(u64::from_be_bytes(bytes))
}

pub fn branch_compaction_hot_shard_coverage_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), CMP_HOT_SHARD_COVERAGE_PATH)
}

pub fn branch_compaction_hot_shard_coverage_version_prefix(
	branch_id: DatabaseBranchId,
	shard_id: u32,
) -> Vec<u8> {
	let mut key = branch_compaction_hot_shard_coverage_prefix(branch_id);
	key.extend_from_slice(&shard_id.to_be_bytes());
	key.push(b'/');
	key
}

pub fn branch_compaction_hot_shard_coverage_key(
	branch_id: DatabaseBranchId,
	shard_id: u32,
	as_of_txid: u64,
) -> Vec<u8> {
	let mut key = branch_compaction_hot_shard_coverage_version_prefix(branch_id, shard_id);
	key.extend_from_slice(&as_of_txid.to_be_bytes());
	key
}

pub fn decode_branch_compaction_hot_shard_coverage_key(
	branch_id: DatabaseBranchId,
	key: &[u8],
) -> Result<(u32, u64)> {
	let prefix = branch_compaction_hot_shard_coverage_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("hot shard coverage key did not start with expected branch prefix")?;
	ensure!(
		suffix.len() == std::mem::size_of::<u32>() + 1 + std::mem::size_of::<u64>(),
		"hot shard coverage key suffix had invalid length"
	);
	ensure!(
		suffix[4] == b'/',
		"hot shard coverage key separator is invalid"
	);
	let shard_id = u32::from_be_bytes(suffix[..4].try_into().context("decode coverage shard id")?);
	let as_of_txid = u64::from_be_bytes(suffix[5..].try_into().context("decode coverage txid")?);
	Ok((shard_id, as_of_txid))
}

pub fn branch_compaction_cold_shard_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), CMP_COLD_SHARD_PATH)
}

pub fn branch_compaction_cold_shard_version_prefix(
	branch_id: DatabaseBranchId,
	shard_id: u32,
) -> Vec<u8> {
	let mut key = branch_compaction_cold_shard_prefix(branch_id);
	key.extend_from_slice(&shard_id.to_be_bytes());
	key.push(b'/');
	key
}

pub fn branch_compaction_cold_shard_key(
	branch_id: DatabaseBranchId,
	shard_id: u32,
	as_of_txid: u64,
) -> Vec<u8> {
	let mut key = branch_compaction_cold_shard_version_prefix(branch_id, shard_id);
	key.extend_from_slice(&as_of_txid.to_be_bytes());
	key
}

pub fn decode_branch_compaction_cold_shard_key(
	branch_id: DatabaseBranchId,
	key: &[u8],
) -> Result<(u32, u64)> {
	let prefix = branch_compaction_cold_shard_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("cold shard key did not start with expected branch prefix")?;
	ensure!(
		suffix.len() == std::mem::size_of::<u32>() + 1 + std::mem::size_of::<u64>(),
		"cold shard key suffix had invalid length"
	);
	ensure!(suffix[4] == b'/', "cold shard key separator is invalid");
	let shard_id = u32::from_be_bytes(suffix[..4].try_into().context("decode cold shard id")?);
	let as_of_txid = u64::from_be_bytes(suffix[5..].try_into().context("decode cold shard txid")?);
	Ok((shard_id, as_of_txid))
}

pub fn branch_compaction_cold_publish_key(
	branch_id: DatabaseBranchId,
	publish_generation: u64,
) -> Vec<u8> {
	let mut key = with_suffix(database_branch_base(branch_id), CMP_COLD_PUBLISH_PATH);
	key.extend_from_slice(&publish_generation.to_be_bytes());
	key
}

pub fn branch_compaction_cold_publish_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), CMP_COLD_PUBLISH_PATH)
}

pub fn decode_branch_compaction_cold_publish_generation(
	branch_id: DatabaseBranchId,
	key: &[u8],
) -> Result<u64> {
	let prefix = branch_compaction_cold_publish_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("cold publish key did not start with expected branch prefix")?;
	ensure!(
		suffix.len() == std::mem::size_of::<u64>(),
		"cold publish key suffix had invalid length"
	);
	Ok(u64::from_be_bytes(
		suffix
			.try_into()
			.context("decode cold publish generation")?,
	))
}

pub fn branch_compaction_cold_publish_refcount_key(
	branch_id: DatabaseBranchId,
	publish_generation: u64,
) -> Vec<u8> {
	let mut key = with_suffix(
		database_branch_base(branch_id),
		CMP_COLD_PUBLISH_REFCOUNT_PATH,
	);
	key.extend_from_slice(&publish_generation.to_be_bytes());
	key
}

pub fn branch_compaction_cold_upload_intent_job_prefix(
	branch_id: DatabaseBranchId,
	job_id: Id,
) -> Vec<u8> {
	let mut key = with_suffix(database_branch_base(branch_id), CMP_COLD_UPLOAD_INTENT_PATH);
	append_id(&mut key, job_id);
	key.push(b'/');
	key
}

pub fn branch_compaction_cold_upload_intent_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), CMP_COLD_UPLOAD_INTENT_PATH)
}

pub fn branch_compaction_cold_upload_intent_key(
	branch_id: DatabaseBranchId,
	job_id: Id,
	shard_id: u32,
	as_of_txid: u64,
) -> Vec<u8> {
	let mut key = branch_compaction_cold_upload_intent_job_prefix(branch_id, job_id);
	key.extend_from_slice(&shard_id.to_be_bytes());
	key.push(b'/');
	key.extend_from_slice(&as_of_txid.to_be_bytes());
	key
}

pub fn cold_upload_job_queue_prefix() -> Vec<u8> {
	partition_prefix(COLD_UPLOAD_JOB_QUEUE_PARTITION)
}

pub fn branch_cold_upload_job_queue_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut key = cold_upload_job_queue_prefix();
	key.push(branch_gc_queue_shard(branch_id) % COLD_UPLOAD_JOB_QUEUE_SHARD_COUNT);
	key.push(b'/');
	append_uuid(&mut key, branch_id.as_uuid());
	key.push(b'/');
	key
}

pub fn branch_cold_upload_job_queue_key(branch_id: DatabaseBranchId, job_id: Id) -> Vec<u8> {
	let mut key = branch_cold_upload_job_queue_prefix(branch_id);
	append_id(&mut key, job_id);
	key
}

pub fn hot_compaction_job_queue_prefix() -> Vec<u8> {
	partition_prefix(HOT_COMPACTION_JOB_QUEUE_PARTITION)
}

pub fn branch_hot_compaction_job_queue_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut key = hot_compaction_job_queue_prefix();
	key.push(branch_gc_queue_shard(branch_id) % HOT_COMPACTION_JOB_QUEUE_SHARD_COUNT);
	key.push(b'/');
	append_uuid(&mut key, branch_id.as_uuid());
	key.push(b'/');
	key
}

pub fn branch_hot_compaction_job_queue_key(branch_id: DatabaseBranchId, job_id: Id) -> Vec<u8> {
	let mut key = branch_hot_compaction_job_queue_prefix(branch_id);
	append_id(&mut key, job_id);
	key
}

pub fn decode_branch_compaction_cold_upload_intent_key(
	branch_id: DatabaseBranchId,
	job_id: Id,
	key: &[u8],
) -> Result<(u32, u64)> {
	let prefix = branch_compaction_cold_upload_intent_job_prefix(branch_id, job_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("cold upload intent key did not start with expected job prefix")?;
	ensure!(
		suffix.len() == std::mem::size_of::<u32>() + 1 + std::mem::size_of::<u64>(),
		"cold upload intent key suffix had invalid length"
	);
	ensure!(
		suffix[4] == b'/',
		"cold upload intent key separator is invalid"
	);
	let shard_id = u32::from_be_bytes(
		suffix[..4]
			.try_into()
			.context("decode cold upload intent shard id")?,
	);
	let as_of_txid = u64::from_be_bytes(
		suffix[5..]
			.try_into()
			.context("decode cold upload intent txid")?,
	);
	Ok((shard_id, as_of_txid))
}

pub fn branch_compaction_retired_cold_object_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		CMP_RETIRED_COLD_OBJECT_PATH,
	)
}

pub fn branch_compaction_retired_cold_object_key(
	branch_id: DatabaseBranchId,
	object_key_hash: [u8; 32],
) -> Vec<u8> {
	let mut key = branch_compaction_retired_cold_object_prefix(branch_id);
	key.extend_from_slice(&object_key_hash);
	key
}

pub fn branch_compaction_retired_cold_object_due_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		CMP_RETIRED_COLD_OBJECT_DUE_PATH,
	)
}

pub fn branch_compaction_retired_cold_object_due_key(
	branch_id: DatabaseBranchId,
	delete_after_ms: i64,
	object_key_hash: [u8; 32],
) -> Vec<u8> {
	let mut key = branch_compaction_retired_cold_object_due_prefix(branch_id);
	key.extend_from_slice(&delete_after_ms.to_be_bytes());
	key.extend_from_slice(&object_key_hash);
	key
}

pub fn decode_branch_compaction_retired_cold_object_due_key(
	branch_id: DatabaseBranchId,
	key: &[u8],
) -> Result<(i64, [u8; 32])> {
	let prefix = branch_compaction_retired_cold_object_due_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("retired cold object due key did not start with expected prefix")?;
	ensure!(
		suffix.len() == std::mem::size_of::<i64>() + 32,
		"retired cold object due key suffix had invalid length"
	);
	let delete_after_ms = i64::from_be_bytes(
		suffix[..8]
			.try_into()
			.context("decode retired cold object due timestamp")?,
	);
	let object_key_hash = suffix[8..]
		.try_into()
		.context("decode retired cold object due hash")?;
	Ok((delete_after_ms, object_key_hash))
}

pub fn branch_compaction_stage_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), CMP_STAGE_PATH)
}

pub fn branch_compaction_stage_hot_job_key(branch_id: DatabaseBranchId, job_id: Id) -> Vec<u8> {
	let mut key = with_suffix(database_branch_base(branch_id), CMP_STAGE_HOT_JOB_PATH);
	append_id(&mut key, job_id);
	key
}

pub fn branch_compaction_stage_hot_job_by_generation_prefix(
	branch_id: DatabaseBranchId,
) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		CMP_STAGE_HOT_JOB_BY_GENERATION_PATH,
	)
}

pub fn branch_compaction_stage_hot_job_by_generation_key(
	branch_id: DatabaseBranchId,
	base_manifest_generation: u64,
	job_id: Id,
) -> Vec<u8> {
	let mut key = branch_compaction_stage_hot_job_by_generation_prefix(branch_id);
	key.extend_from_slice(&base_manifest_generation.to_be_bytes());
	append_id(&mut key, job_id);
	key
}

pub fn decode_branch_compaction_stage_hot_job_by_generation_key(
	branch_id: DatabaseBranchId,
	key: &[u8],
) -> Result<(u64, Id)> {
	let prefix = branch_compaction_stage_hot_job_by_generation_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("staged hot job generation key did not start with expected prefix")?;
	ensure!(
		suffix.len() > std::mem::size_of::<u64>(),
		"staged hot job generation key suffix is truncated"
	);
	let base_manifest_generation = u64::from_be_bytes(
		suffix[..8]
			.try_into()
			.context("decode staged hot job base manifest generation")?,
	);
	let job_id =
		Id::from_slice(&suffix[8..]).context("decode staged hot job id from generation index")?;
	Ok((base_manifest_generation, job_id))
}

pub fn branch_compaction_stage_hot_shard_prefix(
	branch_id: DatabaseBranchId,
	job_id: Id,
) -> Vec<u8> {
	let mut key = with_suffix(database_branch_base(branch_id), CMP_STAGE_PATH);
	append_id(&mut key, job_id);
	key.extend_from_slice(CMP_STAGE_HOT_SHARD_PATH);
	key
}

pub fn branch_compaction_stage_hot_shard_version_prefix(
	branch_id: DatabaseBranchId,
	job_id: Id,
	shard_id: u32,
) -> Vec<u8> {
	let mut key = branch_compaction_stage_hot_shard_prefix(branch_id, job_id);
	key.extend_from_slice(&shard_id.to_be_bytes());
	key.push(b'/');
	key
}

pub fn branch_compaction_stage_hot_shard_key(
	branch_id: DatabaseBranchId,
	job_id: Id,
	shard_id: u32,
	as_of_txid: u64,
	chunk_idx: u32,
) -> Vec<u8> {
	let mut key = branch_compaction_stage_hot_shard_version_prefix(branch_id, job_id, shard_id);
	key.extend_from_slice(&as_of_txid.to_be_bytes());
	key.push(b'/');
	key.extend_from_slice(&chunk_idx.to_be_bytes());
	key
}

pub fn decode_branch_compaction_stage_hot_shard_key(
	branch_id: DatabaseBranchId,
	job_id: Id,
	key: &[u8],
) -> Result<(u32, u64, u32)> {
	let prefix = branch_compaction_stage_hot_shard_prefix(branch_id, job_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("staged hot shard key did not start with expected job prefix")?;
	let expected_len = std::mem::size_of::<u32>()
		+ 1 + std::mem::size_of::<u64>()
		+ 1 + std::mem::size_of::<u32>();
	ensure!(
		suffix.len() == expected_len,
		"staged hot shard key suffix had invalid length"
	);
	ensure!(
		suffix[std::mem::size_of::<u32>()] == b'/'
			&& suffix[std::mem::size_of::<u32>() + 1 + std::mem::size_of::<u64>()] == b'/',
		"staged hot shard key separators are invalid"
	);
	let shard_id = u32::from_be_bytes(
		suffix[..4]
			.try_into()
			.context("decode staged hot shard id")?,
	);
	let txid_start = 5;
	let txid_end = txid_start + 8;
	let as_of_txid = u64::from_be_bytes(
		suffix[txid_start..txid_end]
			.try_into()
			.context("decode staged hot shard txid")?,
	);
	let chunk_idx = u32::from_be_bytes(
		suffix[txid_end + 1..]
			.try_into()
			.context("decode staged hot shard chunk index")?,
	);
	Ok((shard_id, as_of_txid, chunk_idx))
}

pub fn branch_commit_key(branch_id: DatabaseBranchId, txid: u64) -> Vec<u8> {
	let mut key = branch_commit_prefix(branch_id);
	key.extend_from_slice(&txid.to_be_bytes());
	key
}

pub fn branch_commit_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), COMMITS_PATH)
}

pub fn branch_vtx_key(branch_id: DatabaseBranchId, versionstamp: [u8; 16]) -> Vec<u8> {
	let mut key = branch_vtx_prefix(branch_id);
	key.extend_from_slice(&versionstamp);
	key
}

pub fn branch_vtx_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), VTX_PATH)
}

pub fn branch_pitr_interval_key(branch_id: DatabaseBranchId, bucket_start_ms: i64) -> Vec<u8> {
	let mut key = branch_pitr_interval_prefix(branch_id);
	key.extend_from_slice(&bucket_start_ms.to_be_bytes());
	key
}

pub fn branch_pitr_interval_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), PITR_INTERVAL_PATH)
}

pub fn branch_pitr_interval_by_txid_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), PITR_INTERVAL_BY_TXID_PATH)
}

pub fn branch_pitr_interval_by_txid_key(
	branch_id: DatabaseBranchId,
	txid: u64,
	bucket_start_ms: i64,
) -> Vec<u8> {
	let mut key = branch_pitr_interval_by_txid_prefix(branch_id);
	key.extend_from_slice(&txid.to_be_bytes());
	key.extend_from_slice(&bucket_start_ms.to_be_bytes());
	key
}

pub fn branch_pitr_interval_by_txid_txid_prefix(branch_id: DatabaseBranchId, txid: u64) -> Vec<u8> {
	let mut key = branch_pitr_interval_by_txid_prefix(branch_id);
	key.extend_from_slice(&txid.to_be_bytes());
	key
}

pub fn decode_branch_pitr_interval_by_txid_key(
	branch_id: DatabaseBranchId,
	key: &[u8],
) -> Result<(u64, i64)> {
	let prefix = branch_pitr_interval_by_txid_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("branch PITR txid-index key did not start with expected prefix")?;
	ensure!(
		suffix.len() == std::mem::size_of::<u64>() + std::mem::size_of::<i64>(),
		"branch PITR txid-index key suffix had invalid length"
	);
	Ok((
		u64::from_be_bytes(suffix[..8].try_into().context("decode PITR index txid")?),
		i64::from_be_bytes(suffix[8..].try_into().context("decode PITR index bucket")?),
	))
}

pub fn branch_pitr_interval_due_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), PITR_INTERVAL_DUE_PATH)
}

pub fn branch_pitr_interval_due_key(
	branch_id: DatabaseBranchId,
	expires_at_ms: i64,
	bucket_start_ms: i64,
) -> Vec<u8> {
	let mut key = branch_pitr_interval_due_prefix(branch_id);
	key.extend_from_slice(&expires_at_ms.to_be_bytes());
	key.extend_from_slice(&bucket_start_ms.to_be_bytes());
	key
}

pub fn decode_branch_pitr_interval_due_key(
	branch_id: DatabaseBranchId,
	key: &[u8],
) -> Result<(i64, i64)> {
	let prefix = branch_pitr_interval_due_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("branch PITR due-index key did not start with expected prefix")?;
	ensure!(
		suffix.len() == std::mem::size_of::<i64>() * 2,
		"branch PITR due-index key suffix had invalid length"
	);
	Ok((
		i64::from_be_bytes(suffix[..8].try_into().context("decode PITR due expiry")?),
		i64::from_be_bytes(suffix[8..].try_into().context("decode PITR due bucket")?),
	))
}

pub fn decode_branch_pitr_interval_bucket(branch_id: DatabaseBranchId, key: &[u8]) -> Result<i64> {
	let prefix = branch_pitr_interval_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("branch PITR interval key did not start with expected prefix")?;
	ensure!(
		suffix.len() == std::mem::size_of::<i64>(),
		"branch PITR interval key suffix had {} bytes, expected {}",
		suffix.len(),
		std::mem::size_of::<i64>()
	);

	Ok(i64::from_be_bytes(suffix.try_into().context(
		"branch PITR interval suffix should decode as i64",
	)?))
}

pub fn branch_pidx_key(branch_id: DatabaseBranchId, pgno: u32) -> Vec<u8> {
	let mut key = with_suffix(database_branch_base(branch_id), BR_PIDX_PATH);
	key.extend_from_slice(&pgno.to_be_bytes());
	key
}

pub fn branch_pidx_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), BR_PIDX_PATH)
}

pub fn decode_branch_pidx_pgno(branch_id: DatabaseBranchId, key: &[u8]) -> Result<u32> {
	let prefix = branch_pidx_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("branch PIDX key did not start with expected prefix")?;
	ensure!(
		suffix.len() == std::mem::size_of::<u32>(),
		"branch PIDX key suffix had invalid length"
	);
	Ok(u32::from_be_bytes(
		suffix
			.try_into()
			.context("decode branch PIDX page number")?,
	))
}

pub fn branch_pidx_count_index_complete_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		META_PIDX_COUNT_INDEX_COMPLETE_PATH,
	)
}

/// Prefix for the radix-256 PIDX cardinality tree. Node keys sort by their first covered page,
/// then by level, so a suffix truncate can clear every fully covered node with one range clear.
pub fn branch_pidx_count_node_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), META_PIDX_COUNT_NODE_PATH)
}

pub fn branch_pidx_count_node_key(
	branch_id: DatabaseBranchId,
	start_pgno: u32,
	level: u8,
) -> Vec<u8> {
	let mut key = branch_pidx_count_node_prefix(branch_id);
	key.extend_from_slice(&start_pgno.to_be_bytes());
	key.push(level);
	key
}

pub fn decode_branch_pidx_count_node_key(
	branch_id: DatabaseBranchId,
	key: &[u8],
) -> Result<(u32, u8)> {
	let prefix = branch_pidx_count_node_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("PIDX count node key did not start with expected prefix")?;
	ensure!(
		suffix.len() == std::mem::size_of::<u32>() + 1,
		"PIDX count node key suffix had invalid length"
	);
	let start_pgno = u32::from_be_bytes(
		suffix[..4]
			.try_into()
			.context("decode PIDX count node start page")?,
	);
	Ok((start_pgno, suffix[4]))
}

/// Highest branch-local txid for which the page-history index is complete. Missing metadata is
/// corruption and callers fail closed instead of falling back to an unbounded DELTA scan.
pub fn branch_page_history_complete_txid_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		META_PAGE_HISTORY_COMPLETE_TXID_PATH,
	)
}

pub fn branch_cold_retire_scan_cursor_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		META_COLD_RETIRE_SCAN_CURSOR_PATH,
	)
}

pub fn branch_hot_evict_scan_cursor_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		META_HOT_EVICT_SCAN_CURSOR_PATH,
	)
}

pub fn branch_page_history_page_prefix(branch_id: DatabaseBranchId, pgno: u32) -> Vec<u8> {
	let mut key = with_suffix(database_branch_base(branch_id), BR_PAGE_HISTORY_PATH);
	key.extend_from_slice(&pgno.to_be_bytes());
	key.push(b'/');
	key
}

pub fn branch_page_history_key(branch_id: DatabaseBranchId, pgno: u32, txid: u64) -> Vec<u8> {
	let mut key = branch_page_history_page_prefix(branch_id, pgno);
	key.extend_from_slice(&txid.to_be_bytes());
	key
}

pub fn decode_branch_page_history_txid(
	branch_id: DatabaseBranchId,
	pgno: u32,
	key: &[u8],
) -> Result<u64> {
	let prefix = branch_page_history_page_prefix(branch_id, pgno);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("branch page-history key did not start with expected prefix")?;
	ensure!(
		suffix.len() == std::mem::size_of::<u64>(),
		"branch page-history key suffix had {} bytes, expected {}",
		suffix.len(),
		std::mem::size_of::<u64>()
	);

	Ok(u64::from_be_bytes(suffix.try_into().context(
		"branch page-history txid suffix should decode as u64",
	)?))
}

pub fn branch_delta_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), DELTA_PATH)
}

pub fn branch_delta_chunk_prefix(branch_id: DatabaseBranchId, txid: u64) -> Vec<u8> {
	let mut key = branch_delta_prefix(branch_id);
	key.extend_from_slice(&txid.to_be_bytes());
	key.push(b'/');
	key
}

pub fn branch_delta_chunk_key(branch_id: DatabaseBranchId, txid: u64, chunk_idx: u32) -> Vec<u8> {
	let mut key = branch_delta_chunk_prefix(branch_id, txid);
	key.extend_from_slice(&chunk_idx.to_be_bytes());
	key
}

pub fn decode_branch_delta_chunk_txid(branch_id: DatabaseBranchId, key: &[u8]) -> Result<u64> {
	let prefix = branch_delta_prefix(branch_id);
	ensure!(
		key.starts_with(&prefix),
		"branch delta key did not start with expected prefix"
	);
	let suffix = &key[prefix.len()..];
	ensure!(
		suffix.len() >= std::mem::size_of::<u64>() + 1,
		"branch delta key suffix had {} bytes, expected at least {}",
		suffix.len(),
		std::mem::size_of::<u64>() + 1
	);
	ensure!(
		suffix[std::mem::size_of::<u64>()] == b'/',
		"branch delta key missing txid/chunk separator"
	);

	Ok(u64::from_be_bytes(
		suffix[..std::mem::size_of::<u64>()]
			.try_into()
			.context("branch delta txid suffix should decode as u64")?,
	))
}

pub fn decode_branch_delta_chunk_idx(
	branch_id: DatabaseBranchId,
	txid: u64,
	key: &[u8],
) -> Result<u32> {
	let prefix = branch_delta_chunk_prefix(branch_id, txid);
	ensure!(
		key.starts_with(&prefix),
		"branch delta chunk key did not start with expected prefix"
	);
	let suffix = &key[prefix.len()..];
	ensure!(
		suffix.len() == std::mem::size_of::<u32>(),
		"branch delta chunk key suffix had {} bytes, expected {}",
		suffix.len(),
		std::mem::size_of::<u32>()
	);

	Ok(u32::from_be_bytes(suffix.try_into().context(
		"branch delta chunk suffix should decode as u32",
	)?))
}

pub fn branch_shard_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), SHARD_PATH)
}

pub fn branch_shard_version_prefix(branch_id: DatabaseBranchId, shard_id: u32) -> Vec<u8> {
	let mut key = branch_shard_prefix(branch_id);
	key.extend_from_slice(&shard_id.to_be_bytes());
	key.push(b'/');
	key
}

pub fn branch_shard_key(branch_id: DatabaseBranchId, shard_id: u32, as_of_txid: u64) -> Vec<u8> {
	let mut key = branch_shard_version_prefix(branch_id, shard_id);
	key.extend_from_slice(&as_of_txid.to_be_bytes());
	key
}

pub fn branch_shard_chunk_prefix(
	branch_id: DatabaseBranchId,
	shard_id: u32,
	as_of_txid: u64,
) -> Vec<u8> {
	let mut key = branch_shard_chunk_shard_prefix(branch_id, shard_id);
	key.extend_from_slice(&as_of_txid.to_be_bytes());
	key.push(b'/');
	key
}

pub fn branch_shard_chunks_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(database_branch_base(branch_id), SHARD_CHUNK_PATH)
}

pub fn branch_shard_chunk_shard_prefix(branch_id: DatabaseBranchId, shard_id: u32) -> Vec<u8> {
	let mut key = branch_shard_chunks_prefix(branch_id);
	key.extend_from_slice(&shard_id.to_be_bytes());
	key.push(b'/');
	key
}

pub fn branch_shard_chunk_key(
	branch_id: DatabaseBranchId,
	shard_id: u32,
	as_of_txid: u64,
	chunk_idx: u32,
) -> Vec<u8> {
	let mut key = branch_shard_chunk_prefix(branch_id, shard_id, as_of_txid);
	key.extend_from_slice(&chunk_idx.to_be_bytes());
	key
}

pub fn decode_branch_shard_key(branch_id: DatabaseBranchId, key: &[u8]) -> Result<(u32, u64)> {
	let prefix = branch_shard_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("sqlite branch shard key had invalid prefix")?;
	ensure!(
		suffix.len() == std::mem::size_of::<u32>() + 1 + std::mem::size_of::<u64>(),
		"sqlite branch shard key had invalid length"
	);
	ensure!(
		suffix[std::mem::size_of::<u32>()] == b'/',
		"sqlite branch shard key had invalid separator"
	);
	let shard_id = u32::from_be_bytes(suffix[..std::mem::size_of::<u32>()].try_into()?);
	let as_of_txid = u64::from_be_bytes(suffix[std::mem::size_of::<u32>() + 1..].try_into()?);
	Ok((shard_id, as_of_txid))
}

pub fn decode_branch_shard_chunk_key(
	branch_id: DatabaseBranchId,
	key: &[u8],
) -> Result<(u32, u64, u32)> {
	let prefix = branch_shard_chunks_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("sqlite branch shard chunk key had invalid prefix")?;
	ensure!(
		suffix.len()
			== std::mem::size_of::<u32>()
				+ 1 + std::mem::size_of::<u64>()
				+ 1 + std::mem::size_of::<u32>(),
		"sqlite branch shard chunk key had invalid length"
	);
	ensure!(
		suffix[std::mem::size_of::<u32>()] == b'/'
			&& suffix[std::mem::size_of::<u32>() + 1 + std::mem::size_of::<u64>()] == b'/',
		"sqlite branch shard chunk key had invalid separator"
	);
	let shard_id = u32::from_be_bytes(suffix[..std::mem::size_of::<u32>()].try_into()?);
	let txid_start = std::mem::size_of::<u32>() + 1;
	let txid_end = txid_start + std::mem::size_of::<u64>();
	let as_of_txid = u64::from_be_bytes(suffix[txid_start..txid_end].try_into()?);
	let chunk_idx = u32::from_be_bytes(suffix[txid_end + 1..].try_into()?);
	Ok((shard_id, as_of_txid, chunk_idx))
}

pub fn ctr_quota_global_key() -> Vec<u8> {
	with_suffix(partition_prefix(CTR_PARTITION), CTR_QUOTA_GLOBAL_PATH)
}

/// Cluster-wide identity of the object store that backs Depot cold refs. This is one exact key,
/// not a discovery index; every Engine validates it before starting storage workers.
pub fn cold_tier_identity_key() -> Vec<u8> {
	with_suffix(
		partition_prefix(COLD_TIER_IDENTITY_PARTITION),
		COLD_TIER_IDENTITY_PATH,
	)
}

/// One little-endian signed i64 counter below the Cell-wide cold-storage accounting subspace.
/// The numeric field id is owned by `cold_tier::accounting` and is intentionally encoded as one
/// byte so adding fields never changes existing keys.
pub fn cold_storage_accounting_prefix() -> Vec<u8> {
	with_suffix(
		partition_prefix(COLD_STORAGE_ACCOUNTING_PARTITION),
		COLD_STORAGE_ACCOUNTING_PATH,
	)
}

pub fn cold_storage_accounting_counter_key(field: u8, shard: u8) -> Vec<u8> {
	let mut key = cold_storage_accounting_prefix();
	key.push(field);
	key.push(b'/');
	key.push(shard);
	key
}

/// One exact Cell-wide policy key. Policy mutation uses a serializable CAS and deletion workers
/// read it in the same transaction that marks an object DeleteIssued.
pub fn cold_gc_policy_key() -> Vec<u8> {
	with_suffix(
		partition_prefix(COLD_GC_POLICY_PARTITION),
		COLD_GC_POLICY_PATH,
	)
}

pub fn cold_delete_receipt_prefix() -> Vec<u8> {
	with_suffix(
		partition_prefix(COLD_DELETE_RECEIPT_PARTITION),
		COLD_DELETE_RECEIPT_PATH,
	)
}

pub fn cold_delete_receipt_key(object_key_hash: [u8; 32]) -> Vec<u8> {
	let mut key = cold_delete_receipt_prefix();
	key.extend_from_slice(&object_key_hash);
	key
}

pub fn cold_inventory_audit_lease_key() -> Vec<u8> {
	with_suffix(
		partition_prefix(COLD_INVENTORY_AUDIT_PARTITION),
		COLD_INVENTORY_AUDIT_LEASE_PATH,
	)
}

pub fn cold_inventory_audit_state_key() -> Vec<u8> {
	with_suffix(
		partition_prefix(COLD_INVENTORY_AUDIT_PARTITION),
		COLD_INVENTORY_AUDIT_STATE_PATH,
	)
}

pub fn decode_cold_storage_accounting_counter_key(key: &[u8]) -> Result<(u8, u8)> {
	let prefix = cold_storage_accounting_prefix();
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("cold storage accounting key had invalid prefix")?;
	ensure!(
		suffix.len() == 3 && suffix[1] == b'/',
		"cold storage accounting key had invalid suffix"
	);
	Ok((suffix[0], suffix[2]))
}

/// Stable queue shard for one physical database branch. Database branch ids are UUIDv4 today, but
/// hashing all UUID bytes keeps distribution independent of the id generator's byte layout.
pub fn branch_gc_queue_shard(branch_id: DatabaseBranchId) -> u8 {
	let mut hash = 0xcbf2_9ce4_8422_2325_u64;
	for byte in branch_id.as_uuid().as_bytes() {
		hash ^= u64::from(*byte);
		hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
	}
	u8::try_from(hash % u64::from(DB_BRANCH_GC_QUEUE_SHARD_COUNT))
		.expect("branch GC queue shard count fits in u8")
}

pub fn branch_gc_queue_shard_prefix(shard: u8) -> Vec<u8> {
	assert!(shard < DB_BRANCH_GC_QUEUE_SHARD_COUNT);
	let mut key = with_suffix(
		partition_prefix(DB_BRANCH_GC_QUEUE_PARTITION),
		DB_BRANCH_GC_QUEUE_PATH,
	);
	key.push(shard);
	key.push(b'/');
	key
}

pub fn branch_gc_queue_key(branch_id: DatabaseBranchId, due_at_ms: i64) -> Vec<u8> {
	let mut key = branch_gc_queue_shard_prefix(branch_gc_queue_shard(branch_id));
	// Flip the sign bit so signed timestamps preserve their numeric order lexicographically.
	key.extend_from_slice(&((due_at_ms as u64) ^ (1_u64 << 63)).to_be_bytes());
	key.push(b'/');
	append_uuid(&mut key, branch_id.as_uuid());
	key
}

pub fn decode_branch_gc_queue_key(key: &[u8]) -> Result<(u8, i64, DatabaseBranchId)> {
	let prefix = with_suffix(
		partition_prefix(DB_BRANCH_GC_QUEUE_PARTITION),
		DB_BRANCH_GC_QUEUE_PATH,
	);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("branch GC queue key did not start with expected prefix")?;
	ensure!(
		suffix.len() == 1 + 1 + 8 + 1 + 16,
		"branch GC queue key had invalid length"
	);
	let shard = suffix[0];
	ensure!(
		shard < DB_BRANCH_GC_QUEUE_SHARD_COUNT && suffix[1] == b'/' && suffix[10] == b'/',
		"branch GC queue key had invalid shard or separators"
	);
	let ordered_timestamp = u64::from_be_bytes(suffix[2..10].try_into()?);
	let due_at_ms = (ordered_timestamp ^ (1_u64 << 63)) as i64;
	let branch_id = DatabaseBranchId::from_uuid(
		uuid::Uuid::from_slice(&suffix[11..]).context("decode branch GC queue branch UUID")?,
	);
	ensure!(
		branch_gc_queue_shard(branch_id) == shard,
		"branch GC queue key used the wrong shard"
	);
	Ok((shard, due_at_ms, branch_id))
}

pub fn branch_gc_queue_locator_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut key = with_suffix(
		partition_prefix(DB_BRANCH_GC_QUEUE_LOCATOR_PARTITION),
		DB_BRANCH_GC_QUEUE_LOCATOR_PATH,
	);
	append_uuid(&mut key, branch_id.as_uuid());
	key
}

/// Cluster-wide certificate written by the backup controller. It certifies both a monotonic
/// restore floor and a short-lived observation time; cold object deletion fails closed without it.
pub fn cold_backup_recovery_fence_key() -> Vec<u8> {
	with_suffix(
		partition_prefix(COLD_BACKUP_RECOVERY_FENCE_PARTITION),
		COLD_BACKUP_RECOVERY_FENCE_PATH,
	)
}

/// Immutable digest of the backup repository and retention policy authorized to certify the
/// recovery fence. A silent repository switch could otherwise hide older supported backups.
pub fn cold_backup_recovery_policy_key() -> Vec<u8> {
	with_suffix(
		partition_prefix(COLD_BACKUP_RECOVERY_FENCE_PARTITION),
		COLD_BACKUP_RECOVERY_POLICY_PATH,
	)
}

pub fn cold_backup_recovery_controller_lease_key() -> Vec<u8> {
	with_suffix(
		partition_prefix(COLD_BACKUP_RECOVERY_FENCE_PARTITION),
		COLD_BACKUP_RECOVERY_CONTROLLER_LEASE_PATH,
	)
}

pub fn branch_cold_gc_manifest_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut key = with_suffix(
		partition_prefix(DB_BRANCH_COLD_GC_MANIFEST_PARTITION),
		DB_BRANCH_COLD_GC_MANIFEST_PATH,
	);
	append_uuid(&mut key, branch_id.as_uuid());
	key
}

pub fn branch_cold_gc_object_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut key = with_suffix(
		partition_prefix(DB_BRANCH_COLD_GC_OBJECT_PARTITION),
		DB_BRANCH_COLD_GC_OBJECT_PATH,
	);
	key.push(branch_gc_queue_shard(branch_id));
	key.push(b'/');
	append_uuid(&mut key, branch_id.as_uuid());
	key.push(b'/');
	key
}

pub fn branch_cold_gc_object_key(
	branch_id: DatabaseBranchId,
	object_key_hash: [u8; 32],
) -> Vec<u8> {
	let mut key = branch_cold_gc_object_prefix(branch_id);
	key.extend_from_slice(&object_key_hash);
	key
}

pub fn branch_cold_gc_queue_shard_prefix(shard: u8) -> Vec<u8> {
	assert!(shard < DB_BRANCH_COLD_GC_QUEUE_SHARD_COUNT);
	let mut key = with_suffix(
		partition_prefix(DB_BRANCH_COLD_GC_QUEUE_PARTITION),
		DB_BRANCH_COLD_GC_QUEUE_PATH,
	);
	key.push(shard);
	key.push(b'/');
	key
}

pub fn branch_cold_gc_queue_key(branch_id: DatabaseBranchId, due_at_ms: i64) -> Vec<u8> {
	let shard = branch_gc_queue_shard(branch_id);
	let mut key = branch_cold_gc_queue_shard_prefix(shard);
	key.extend_from_slice(&((due_at_ms as u64) ^ (1_u64 << 63)).to_be_bytes());
	key.push(b'/');
	append_uuid(&mut key, branch_id.as_uuid());
	key
}

pub fn decode_branch_cold_gc_queue_key(key: &[u8]) -> Result<(u8, i64, DatabaseBranchId)> {
	let prefix = with_suffix(
		partition_prefix(DB_BRANCH_COLD_GC_QUEUE_PARTITION),
		DB_BRANCH_COLD_GC_QUEUE_PATH,
	);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("branch cold GC queue key did not start with expected prefix")?;
	ensure!(
		suffix.len() == 1 + 1 + 8 + 1 + 16,
		"branch cold GC queue key had invalid length"
	);
	let shard = suffix[0];
	ensure!(
		shard < DB_BRANCH_COLD_GC_QUEUE_SHARD_COUNT && suffix[1] == b'/' && suffix[10] == b'/',
		"branch cold GC queue key had invalid shard or separators"
	);
	let ordered_timestamp = u64::from_be_bytes(suffix[2..10].try_into()?);
	let due_at_ms = (ordered_timestamp ^ (1_u64 << 63)) as i64;
	let branch_id = DatabaseBranchId::from_uuid(
		uuid::Uuid::from_slice(&suffix[11..]).context("decode branch cold GC queue UUID")?,
	);
	ensure!(
		branch_gc_queue_shard(branch_id) == shard,
		"branch cold GC queue key used the wrong shard"
	);
	Ok((shard, due_at_ms, branch_id))
}

pub fn branch_cold_gc_queue_locator_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut key = with_suffix(
		partition_prefix(DB_BRANCH_COLD_GC_QUEUE_LOCATOR_PARTITION),
		DB_BRANCH_COLD_GC_QUEUE_LOCATOR_PATH,
	);
	append_uuid(&mut key, branch_id.as_uuid());
	key
}

pub fn ctr_eviction_index_key(last_access_bucket: i64, branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut key = with_suffix(partition_prefix(CTR_PARTITION), CTR_EVICTION_INDEX_PATH);
	key.extend_from_slice(&last_access_bucket.to_be_bytes());
	key.push(b'/');
	append_uuid(&mut key, branch_id.as_uuid());
	key
}

pub fn ctr_eviction_index_prefix() -> Vec<u8> {
	with_suffix(partition_prefix(CTR_PARTITION), CTR_EVICTION_INDEX_PATH)
}

pub fn ctr_eviction_index_range() -> (Vec<u8>, Vec<u8>) {
	universaldb::utils::range_for_prefix(&ctr_eviction_index_prefix())
}

pub fn decode_ctr_eviction_index_key(key: &[u8]) -> Result<(i64, DatabaseBranchId)> {
	let prefix = ctr_eviction_index_prefix();
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("eviction index key did not start with expected prefix")?;
	let expected_len = std::mem::size_of::<i64>() + 1 + std::mem::size_of::<uuid::Uuid>();
	ensure!(
		suffix.len() == expected_len,
		"eviction index key suffix had {} bytes, expected {}",
		suffix.len(),
		expected_len
	);
	let bucket_bytes: [u8; std::mem::size_of::<i64>()] = suffix[..8]
		.try_into()
		.context("decode eviction index bucket")?;
	ensure!(
		suffix[8] == b'/',
		"eviction index key missing branch separator"
	);
	let branch_id =
		uuid::Uuid::from_slice(&suffix[9..]).context("decode eviction index branch id")?;

	Ok((
		i64::from_be_bytes(bucket_bytes),
		DatabaseBranchId::from_uuid(branch_id),
	))
}

pub fn restore_point_prefix(database_id: &str) -> Vec<u8> {
	let mut key = with_suffix(
		partition_prefix(RESTORE_POINT_PARTITION),
		RESTORE_POINT_PATH,
	);
	append_database_id(&mut key, database_id);
	key.push(b'/');
	key
}

pub fn restore_point_key(database_id: &str, restore_point: &str) -> Vec<u8> {
	let mut key = restore_point_prefix(database_id);
	key.extend_from_slice(restore_point.as_bytes());
	key
}

pub fn db_pin_key(branch_id: DatabaseBranchId, pin_id: &[u8]) -> Vec<u8> {
	let mut key = db_pin_prefix(branch_id);
	key.extend_from_slice(pin_id);
	key
}

pub fn db_pin_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut key = with_suffix(partition_prefix(DB_PIN_PARTITION), DB_PIN_PATH);
	append_uuid(&mut key, branch_id.as_uuid());
	key.push(b'/');
	key
}

pub fn branch_history_pin_count_shard_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	with_suffix(
		database_branch_base(branch_id),
		META_HISTORY_PIN_COUNT_SHARD_PATH,
	)
}

pub fn branch_history_pin_count_shard_key(branch_id: DatabaseBranchId, shard: u8) -> Vec<u8> {
	let mut key = branch_history_pin_count_shard_prefix(branch_id);
	key.push(shard);
	key
}

pub fn decode_branch_history_pin_count_shard_key(
	branch_id: DatabaseBranchId,
	key: &[u8],
) -> Result<u8> {
	let prefix = branch_history_pin_count_shard_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("history pin count shard key did not start with expected prefix")?;
	ensure!(
		suffix.len() == 1,
		"history pin count shard key suffix has invalid length"
	);
	Ok(suffix[0])
}

pub fn db_pin_by_txid_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut key = with_suffix(
		partition_prefix(DB_PIN_BY_TXID_PARTITION),
		DB_PIN_BY_TXID_PATH,
	);
	append_uuid(&mut key, branch_id.as_uuid());
	key.push(b'/');
	key
}

pub fn db_pin_by_txid_key(branch_id: DatabaseBranchId, at_txid: u64, pin_id: &[u8]) -> Vec<u8> {
	let mut key = db_pin_by_txid_prefix(branch_id);
	key.extend_from_slice(&at_txid.to_be_bytes());
	key.extend_from_slice(pin_id);
	key
}

pub fn decode_db_pin_by_txid_key(
	branch_id: DatabaseBranchId,
	key: &[u8],
) -> Result<(u64, Vec<u8>)> {
	let prefix = db_pin_by_txid_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("history pin txid index key did not start with expected prefix")?;
	ensure!(
		suffix.len() > std::mem::size_of::<u64>(),
		"history pin txid index key suffix is truncated"
	);
	let at_txid = u64::from_be_bytes(
		suffix[..8]
			.try_into()
			.context("decode history pin txid index txid")?,
	);
	Ok((at_txid, suffix[8..].to_vec()))
}

pub fn db_pin_txid_count_prefix(branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut key = with_suffix(
		partition_prefix(DB_PIN_TXID_COUNT_PARTITION),
		DB_PIN_TXID_COUNT_PATH,
	);
	append_uuid(&mut key, branch_id.as_uuid());
	key.push(b'/');
	key
}

pub fn db_pin_txid_count_key(branch_id: DatabaseBranchId, at_txid: u64) -> Vec<u8> {
	let mut key = db_pin_txid_count_prefix(branch_id);
	key.extend_from_slice(&at_txid.to_be_bytes());
	key
}

pub fn decode_db_pin_txid_count_key(branch_id: DatabaseBranchId, key: &[u8]) -> Result<u64> {
	let prefix = db_pin_txid_count_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("history pin txid count key did not start with expected prefix")?;
	ensure!(
		suffix.len() == std::mem::size_of::<u64>(),
		"history pin txid count key suffix has invalid length"
	);
	Ok(u64::from_be_bytes(
		suffix
			.try_into()
			.context("decode history pin txid count txid")?,
	))
}

pub fn bucket_fork_pin_key(
	source_bucket_branch_id: BucketBranchId,
	fork_versionstamp: [u8; 16],
	target_bucket_branch_id: BucketBranchId,
) -> Vec<u8> {
	let mut key = bucket_fork_pin_prefix(source_bucket_branch_id);
	key.extend_from_slice(&fork_versionstamp);
	key.push(b'/');
	append_uuid(&mut key, target_bucket_branch_id.as_uuid());
	key
}

pub fn bucket_fork_pin_prefix(source_bucket_branch_id: BucketBranchId) -> Vec<u8> {
	let mut key = with_suffix(
		partition_prefix(BUCKET_FORK_PIN_PARTITION),
		BUCKET_FORK_PIN_PATH,
	);
	append_uuid(&mut key, source_bucket_branch_id.as_uuid());
	key.push(b'/');
	key
}

pub fn bucket_child_key(
	source_bucket_branch_id: BucketBranchId,
	fork_versionstamp: [u8; 16],
	target_bucket_branch_id: BucketBranchId,
) -> Vec<u8> {
	let mut key = bucket_child_prefix(source_bucket_branch_id);
	key.extend_from_slice(&fork_versionstamp);
	key.push(b'/');
	append_uuid(&mut key, target_bucket_branch_id.as_uuid());
	key
}

pub fn bucket_child_prefix(source_bucket_branch_id: BucketBranchId) -> Vec<u8> {
	let mut key = with_suffix(partition_prefix(BUCKET_CHILD_PARTITION), BUCKET_CHILD_PATH);
	append_uuid(&mut key, source_bucket_branch_id.as_uuid());
	key.push(b'/');
	key
}

pub fn bucket_catalog_by_db_key(
	database_branch_id: DatabaseBranchId,
	bucket_branch_id: BucketBranchId,
) -> Vec<u8> {
	let mut key = bucket_catalog_by_db_prefix(database_branch_id);
	append_uuid(&mut key, bucket_branch_id.as_uuid());
	key
}

pub fn bucket_catalog_by_db_prefix(database_branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut key = with_suffix(
		partition_prefix(BUCKET_CATALOG_BY_DB_PARTITION),
		BUCKET_CATALOG_BY_DB_PATH,
	);
	append_uuid(&mut key, database_branch_id.as_uuid());
	key.push(b'/');
	key
}

pub fn bucket_proof_epoch_key(root_bucket_branch_id: BucketBranchId) -> Vec<u8> {
	let mut key = with_suffix(
		partition_prefix(BUCKET_PROOF_EPOCH_PARTITION),
		BUCKET_PROOF_EPOCH_PATH,
	);
	append_uuid(&mut key, root_bucket_branch_id.as_uuid());
	key
}

/// Maps independent bucket roots onto a fixed fanout. A fork mutates one global shard epoch;
/// database proofs subscribe only to the shards containing their roots, so final validation is
/// atomic and bounded even when one database is cataloged in arbitrarily many roots.
pub fn bucket_proof_epoch_shard(root_bucket_branch_id: BucketBranchId) -> u8 {
	root_bucket_branch_id.as_uuid().as_bytes()[0]
}

pub fn bucket_proof_epoch_shard_key(epoch_shard: u8) -> Vec<u8> {
	let mut key = with_suffix(
		partition_prefix(BUCKET_PROOF_EPOCH_PARTITION),
		BUCKET_PROOF_EPOCH_SHARD_PATH,
	);
	key.push(epoch_shard);
	key
}

pub fn sqlite_cmp_dirty_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut key = sqlite_cmp_dirty_prefix();
	append_uuid(&mut key, branch_id.as_uuid());
	key
}

pub fn sqlite_cmp_dirty_prefix() -> Vec<u8> {
	with_suffix(
		partition_prefix(SQLITE_CMP_DIRTY_PARTITION),
		SQLITE_CMP_DIRTY_PATH,
	)
}

pub fn decode_sqlite_cmp_dirty_branch_id(key: &[u8]) -> Result<DatabaseBranchId> {
	let prefix = sqlite_cmp_dirty_prefix();
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("sqlite compaction dirty key had invalid prefix")?;
	ensure!(
		suffix.len() == 16,
		"sqlite compaction dirty key branch id had invalid length"
	);
	Ok(DatabaseBranchId::from_uuid(uuid::Uuid::from_slice(suffix)?))
}

pub fn sqlite_cmp_dirty_due_prefix() -> Vec<u8> {
	with_suffix(
		partition_prefix(SQLITE_CMP_DIRTY_DUE_PARTITION),
		SQLITE_CMP_DIRTY_DUE_PATH,
	)
}

pub fn sqlite_cmp_dirty_due_key(
	due_at_ms: i64,
	branch_id: DatabaseBranchId,
	dirty_updated_at_ms: i64,
	attempt: u8,
) -> Vec<u8> {
	let mut key = sqlite_cmp_dirty_due_prefix();
	key.extend_from_slice(&due_at_ms.to_be_bytes());
	append_uuid(&mut key, branch_id.as_uuid());
	key.extend_from_slice(&dirty_updated_at_ms.to_be_bytes());
	key.push(attempt);
	key
}

pub fn decode_sqlite_cmp_dirty_due_key(key: &[u8]) -> Result<(i64, DatabaseBranchId, i64, u8)> {
	let prefix = sqlite_cmp_dirty_due_prefix();
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("sqlite compaction dirty due key had invalid prefix")?;
	ensure!(
		suffix.len() == 8 + 16 + 8 + 1,
		"sqlite compaction dirty due key had invalid length"
	);
	let due_at_ms = i64::from_be_bytes(suffix[..8].try_into()?);
	let branch_id = DatabaseBranchId::from_uuid(uuid::Uuid::from_slice(&suffix[8..24])?);
	let dirty_updated_at_ms = i64::from_be_bytes(suffix[24..32].try_into()?);
	let attempt = suffix[32];
	Ok((due_at_ms, branch_id, dirty_updated_at_ms, attempt))
}

pub fn sqlite_cmp_dirty_due_locator_key(branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut key = with_suffix(
		partition_prefix(SQLITE_CMP_DIRTY_DUE_LOCATOR_PARTITION),
		SQLITE_CMP_DIRTY_DUE_LOCATOR_PATH,
	);
	append_uuid(&mut key, branch_id.as_uuid());
	key
}

pub fn sqlite_cmp_dirty_due_backfill_cursor_key() -> Vec<u8> {
	with_suffix(
		partition_prefix(SQLITE_CMP_DIRTY_DUE_BACKFILL_PARTITION),
		SQLITE_CMP_DIRTY_DUE_BACKFILL_PATH,
	)
}

pub fn sqlite_cmp_dirty_due_backfill_complete_key() -> Vec<u8> {
	let mut key = sqlite_cmp_dirty_due_backfill_cursor_key();
	key.extend_from_slice(b"complete");
	key
}

// Legacy database-scoped keys are v1-only compatibility helpers for pegboard actors.
pub fn meta_head_key(database_id: &str) -> Vec<u8> {
	let prefix = database_prefix(database_id);
	let mut key = Vec::with_capacity(prefix.len() + META_HEAD_PATH.len());
	key.extend_from_slice(&prefix);
	key.extend_from_slice(META_HEAD_PATH);
	key
}

pub fn meta_compact_key(database_id: &str) -> Vec<u8> {
	let prefix = database_prefix(database_id);
	let mut key = Vec::with_capacity(prefix.len() + META_COMPACT_PATH.len());
	key.extend_from_slice(&prefix);
	key.extend_from_slice(META_COMPACT_PATH);
	key
}

pub fn meta_quota_key(database_id: &str) -> Vec<u8> {
	let prefix = database_prefix(database_id);
	let mut key = Vec::with_capacity(prefix.len() + META_QUOTA_PATH.len());
	key.extend_from_slice(&prefix);
	key.extend_from_slice(META_QUOTA_PATH);
	key
}

pub fn meta_compactor_lease_key(database_id: &str) -> Vec<u8> {
	let prefix = database_prefix(database_id);
	let mut key = Vec::with_capacity(prefix.len() + META_COMPACTOR_LEASE_PATH.len());
	key.extend_from_slice(&prefix);
	key.extend_from_slice(META_COMPACTOR_LEASE_PATH);
	key
}

pub fn commit_key(database_id: &str, txid: u64) -> Vec<u8> {
	let mut key = commit_prefix(database_id);
	key.extend_from_slice(&txid.to_be_bytes());
	key
}

pub fn commit_prefix(database_id: &str) -> Vec<u8> {
	let prefix = database_prefix(database_id);
	let mut key = Vec::with_capacity(prefix.len() + COMMITS_PATH.len());
	key.extend_from_slice(&prefix);
	key.extend_from_slice(COMMITS_PATH);
	key
}

pub fn vtx_key(database_id: &str, versionstamp: [u8; 16]) -> Vec<u8> {
	let mut key = vtx_prefix(database_id);
	key.extend_from_slice(&versionstamp);
	key
}

pub fn vtx_prefix(database_id: &str) -> Vec<u8> {
	let prefix = database_prefix(database_id);
	let mut key = Vec::with_capacity(prefix.len() + VTX_PATH.len());
	key.extend_from_slice(&prefix);
	key.extend_from_slice(VTX_PATH);
	key
}

pub fn shard_key(database_id: &str, shard_id: u32) -> Vec<u8> {
	let prefix = database_prefix(database_id);
	let mut key = Vec::with_capacity(prefix.len() + SHARD_PATH.len() + std::mem::size_of::<u32>());
	key.extend_from_slice(&prefix);
	key.extend_from_slice(SHARD_PATH);
	key.extend_from_slice(&shard_id.to_be_bytes());
	key
}

pub fn shard_version_prefix(database_id: &str, shard_id: u32) -> Vec<u8> {
	let mut key = shard_key(database_id, shard_id);
	key.push(b'/');
	key
}

pub fn shard_version_key(database_id: &str, shard_id: u32, as_of_txid: u64) -> Vec<u8> {
	let mut key = shard_version_prefix(database_id, shard_id);
	key.extend_from_slice(&as_of_txid.to_be_bytes());
	key
}

// Legacy database-scoped prefix kept for v1 pegboard actor cleanup.
pub fn shard_prefix(database_id: &str) -> Vec<u8> {
	let prefix = database_prefix(database_id);
	let mut key = Vec::with_capacity(prefix.len() + SHARD_PATH.len());
	key.extend_from_slice(&prefix);
	key.extend_from_slice(SHARD_PATH);
	key
}

// Legacy database-scoped prefix kept for v1 pegboard actor cleanup.
pub fn delta_prefix(database_id: &str) -> Vec<u8> {
	let prefix = database_prefix(database_id);
	let mut key = Vec::with_capacity(prefix.len() + DELTA_PATH.len());
	key.extend_from_slice(&prefix);
	key.extend_from_slice(DELTA_PATH);
	key
}

pub fn delta_chunk_prefix(database_id: &str, txid: u64) -> Vec<u8> {
	let prefix = database_prefix(database_id);
	let mut key =
		Vec::with_capacity(prefix.len() + DELTA_PATH.len() + std::mem::size_of::<u64>() + 1);
	key.extend_from_slice(&prefix);
	key.extend_from_slice(DELTA_PATH);
	key.extend_from_slice(&txid.to_be_bytes());
	key.push(b'/');
	key
}

pub fn delta_chunk_key(database_id: &str, txid: u64, chunk_idx: u32) -> Vec<u8> {
	let prefix = delta_chunk_prefix(database_id, txid);
	let mut key = Vec::with_capacity(prefix.len() + std::mem::size_of::<u32>());
	key.extend_from_slice(&prefix);
	key.extend_from_slice(&chunk_idx.to_be_bytes());
	key
}

pub fn pidx_delta_key(database_id: &str, pgno: u32) -> Vec<u8> {
	let prefix = database_prefix(database_id);
	let mut key =
		Vec::with_capacity(prefix.len() + PIDX_DELTA_PATH.len() + std::mem::size_of::<u32>());
	key.extend_from_slice(&prefix);
	key.extend_from_slice(PIDX_DELTA_PATH);
	key.extend_from_slice(&pgno.to_be_bytes());
	key
}

// Legacy database-scoped prefix kept for v1 pegboard actor cleanup.
pub fn pidx_delta_prefix(database_id: &str) -> Vec<u8> {
	let prefix = database_prefix(database_id);
	let mut key = Vec::with_capacity(prefix.len() + PIDX_DELTA_PATH.len());
	key.extend_from_slice(&prefix);
	key.extend_from_slice(PIDX_DELTA_PATH);
	key
}

pub fn decode_delta_chunk_txid(database_id: &str, key: &[u8]) -> Result<u64> {
	let prefix = delta_prefix(database_id);
	ensure!(
		key.starts_with(&prefix),
		"delta key did not start with expected prefix"
	);
	let suffix = &key[prefix.len()..];
	ensure!(
		suffix.len() >= std::mem::size_of::<u64>() + 1,
		"delta key suffix had {} bytes, expected at least {}",
		suffix.len(),
		std::mem::size_of::<u64>() + 1
	);
	ensure!(
		suffix[std::mem::size_of::<u64>()] == b'/',
		"delta key missing txid/chunk separator"
	);

	Ok(u64::from_be_bytes(
		suffix[..std::mem::size_of::<u64>()]
			.try_into()
			.context("delta txid suffix should decode as u64")?,
	))
}

pub fn decode_delta_chunk_idx(database_id: &str, txid: u64, key: &[u8]) -> Result<u32> {
	let prefix = delta_chunk_prefix(database_id, txid);
	ensure!(
		key.starts_with(&prefix),
		"delta chunk key did not start with expected prefix"
	);
	let suffix = &key[prefix.len()..];
	ensure!(
		suffix.len() == std::mem::size_of::<u32>(),
		"delta chunk key suffix had {} bytes, expected {}",
		suffix.len(),
		std::mem::size_of::<u32>()
	);

	Ok(u32::from_be_bytes(
		suffix
			.try_into()
			.context("delta chunk suffix should decode as u32")?,
	))
}
