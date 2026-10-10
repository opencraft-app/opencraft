use depot::conveyer::keys::{
	BR_PARTITION, BRANCHES_PARTITION, BUCKET_BRANCH_PARTITION, BUCKET_CATALOG_BY_DB_PARTITION,
	BUCKET_CHILD_PARTITION, BUCKET_FORK_PIN_PARTITION, BUCKET_POLICY_PITR_SHARD_PARTITION,
	BUCKET_PROOF_EPOCH_PARTITION, BUCKET_PTR_PARTITION, COLD_TIER_IDENTITY_PARTITION,
	CTR_PARTITION, DB_BRANCH_GC_QUEUE_LOCATOR_PARTITION, DB_BRANCH_GC_QUEUE_PARTITION,
	DB_BRANCH_GC_QUEUE_SHARD_COUNT, DB_PIN_BY_TXID_PARTITION, DB_PIN_PARTITION,
	DB_PIN_TXID_COUNT_PARTITION, DB_POLICY_BINDING_PARTITION, DBPTR_PARTITION, PAGE_SIZE,
	RESTORE_POINT_PARTITION, SHARD_SIZE, SQLITE_CMP_DIRTY_DUE_LOCATOR_PARTITION,
	SQLITE_CMP_DIRTY_DUE_PARTITION, SQLITE_CMP_DIRTY_PARTITION, SQLITE_SUBSPACE_PREFIX,
	branch_bucket_proof_epoch_shard_key, branch_bucket_proof_epoch_shard_prefix,
	branch_cold_upload_job_queue_key, branch_cold_upload_job_queue_prefix, branch_commit_key,
	branch_compaction_cold_shard_key, branch_compaction_cold_shard_prefix,
	branch_compaction_cold_shard_version_prefix, branch_compaction_cold_upload_intent_job_prefix,
	branch_compaction_cold_upload_intent_key, branch_compaction_cold_upload_intent_prefix,
	branch_compaction_hot_generation_key, branch_compaction_hot_generation_prefix,
	branch_compaction_hot_publish_key, branch_compaction_hot_shard_coverage_key,
	branch_compaction_hot_shard_coverage_prefix,
	branch_compaction_hot_shard_coverage_version_prefix,
	branch_compaction_retired_cold_object_due_key,
	branch_compaction_retired_cold_object_due_prefix, branch_compaction_retired_cold_object_key,
	branch_compaction_retired_cold_object_prefix, branch_compaction_root_key,
	branch_compaction_stage_hot_job_by_generation_key,
	branch_compaction_stage_hot_job_by_generation_prefix, branch_compaction_stage_hot_shard_key,
	branch_compaction_stage_hot_shard_version_prefix, branch_delta_chunk_key, branch_gc_queue_key,
	branch_gc_queue_locator_key, branch_gc_queue_shard, branch_gc_queue_shard_prefix,
	branch_history_pin_count_shard_key, branch_history_pin_count_shard_prefix,
	branch_hot_compaction_job_queue_key, branch_hot_compaction_job_queue_prefix,
	branch_manifest_last_access_bucket_key, branch_manifest_last_access_ts_ms_key,
	branch_manifest_last_hot_pass_txid_key, branch_meta_compact_key,
	branch_meta_compactor_lease_key, branch_meta_head_at_fork_key, branch_meta_head_key,
	branch_meta_quota_key, branch_meta_truncate_txid_key, branch_page_history_complete_txid_key,
	branch_page_history_key, branch_page_history_page_prefix, branch_pidx_count_node_key,
	branch_pidx_count_node_prefix, branch_pidx_key, branch_pitr_interval_key,
	branch_pitr_interval_prefix, branch_prefix, branch_range, branch_shard_key,
	branch_shard_version_prefix, branch_vtx_key, branches_desc_pin_key, branches_list_key,
	branches_refcount_key, branches_restore_point_pin_key,
	bucket_branches_database_name_tombstone_key, bucket_branches_desc_pin_key,
	bucket_branches_list_key, bucket_branches_refcount_key, bucket_branches_restore_point_pin_key,
	bucket_catalog_by_db_key, bucket_catalog_by_db_prefix, bucket_child_key, bucket_child_prefix,
	bucket_fork_pin_key, bucket_fork_pin_prefix, bucket_pointer_cur_key,
	bucket_pointer_history_key, bucket_policy_pitr_key, bucket_policy_pitr_shard_key,
	bucket_policy_shard_cache_key, bucket_proof_epoch_key, bucket_proof_epoch_shard,
	bucket_proof_epoch_shard_key, cold_tier_identity_key, cold_upload_job_queue_prefix, commit_key,
	ctr_eviction_index_key, ctr_eviction_index_range, ctr_quota_global_key,
	database_pitr_policy_key, database_pointer_cur_key, database_pointer_history_key,
	database_policy_binding_key, database_prefix, database_range, database_shard_cache_policy_key,
	db_pin_by_txid_key, db_pin_by_txid_prefix, db_pin_key, db_pin_prefix, db_pin_txid_count_key,
	db_pin_txid_count_prefix, decode_branch_compaction_cold_upload_intent_key,
	decode_branch_compaction_hot_generation_txid, decode_branch_compaction_hot_shard_coverage_key,
	decode_branch_compaction_stage_hot_job_by_generation_key, decode_branch_gc_queue_key,
	decode_branch_history_pin_count_shard_key, decode_branch_pidx_count_node_key,
	decode_branch_pidx_pgno, decode_ctr_eviction_index_key, decode_db_pin_by_txid_key,
	decode_db_pin_txid_count_key, decode_sqlite_cmp_dirty_branch_id,
	decode_sqlite_cmp_dirty_due_key, delta_chunk_key, delta_chunk_prefix, delta_prefix,
	hot_compaction_job_queue_prefix, meta_compact_key, meta_compactor_lease_key, meta_head_key,
	meta_quota_key, pidx_delta_key, pidx_delta_prefix, restore_point_key, restore_point_prefix,
	shard_key, shard_prefix, shard_version_key, shard_version_prefix, sqlite_cmp_dirty_due_key,
	sqlite_cmp_dirty_due_locator_key, sqlite_cmp_dirty_due_prefix, sqlite_cmp_dirty_key,
	sqlite_cmp_dirty_prefix, vtx_key,
};
use depot::conveyer::types::{BucketBranchId, BucketId, DatabaseBranchId};
use gas::prelude::Id;
use uuid::Uuid;

const TEST_DATABASE: &str = "test-database";
const TEST_RESTORE_POINT: &str = "0000018bcfe56800-0000000000000007";

fn database_branch_id() -> DatabaseBranchId {
	DatabaseBranchId::from_uuid(Uuid::from_u128(0x0011_2233_4455_6677_8899_aabb_ccdd_eeff))
}

#[test]
fn truncate_txid_is_one_exact_branch_local_metadata_key() {
	let branch = database_branch_id();
	let mut expected = branch_prefix(branch);
	expected.extend_from_slice(b"/META/truncate_txid");
	assert_eq!(branch_meta_truncate_txid_key(branch), expected);
	assert_ne!(
		branch_meta_truncate_txid_key(branch),
		branch_meta_head_key(branch)
	);
	assert_ne!(
		branch_meta_truncate_txid_key(branch),
		branch_meta_truncate_txid_key(DatabaseBranchId::from_uuid(Uuid::from_u128(7)))
	);
}

#[test]
fn cold_tier_identity_uses_one_reserved_exact_key() {
	assert_eq!(
		cold_tier_identity_key(),
		[
			SQLITE_SUBSPACE_PREFIX,
			COLD_TIER_IDENTITY_PARTITION,
			b'/',
			b'c',
			b'u',
			b'r',
			b'r',
			b'e',
			b'n',
			b't',
		]
	);
}

#[test]
fn branch_gc_queue_keys_are_sharded_ordered_and_decodable() {
	let branch = database_branch_id();
	let shard = branch_gc_queue_shard(branch);
	assert!(shard < DB_BRANCH_GC_QUEUE_SHARD_COUNT);
	let earlier = branch_gc_queue_key(branch, -1);
	let later = branch_gc_queue_key(branch, 1_700_000_000_000);
	assert!(earlier < later);
	assert!(earlier.starts_with(&branch_gc_queue_shard_prefix(shard)));
	assert_eq!(
		decode_branch_gc_queue_key(&earlier).unwrap(),
		(shard, -1, branch)
	);
	assert_eq!(
		decode_branch_gc_queue_key(&later).unwrap(),
		(shard, 1_700_000_000_000, branch)
	);
	assert_eq!(
		&earlier[..2],
		&[SQLITE_SUBSPACE_PREFIX, DB_BRANCH_GC_QUEUE_PARTITION]
	);
	assert_eq!(
		&branch_gc_queue_locator_key(branch)[..2],
		&[SQLITE_SUBSPACE_PREFIX, DB_BRANCH_GC_QUEUE_LOCATOR_PARTITION,]
	);
	assert!(decode_branch_gc_queue_key(&branch_gc_queue_shard_prefix(shard)).is_err());
}

#[test]
fn branch_cold_gc_keys_are_sharded_branch_local_and_decodable() {
	let branch = database_branch_id();
	let shard = branch_gc_queue_shard(branch);
	let earlier = depot::keys::branch_cold_gc_queue_key(branch, -1);
	let later = depot::keys::branch_cold_gc_queue_key(branch, 1_700_000_000_000);
	assert!(earlier < later);
	assert!(earlier.starts_with(&depot::keys::branch_cold_gc_queue_shard_prefix(shard)));
	assert_eq!(
		depot::keys::decode_branch_cold_gc_queue_key(&later).unwrap(),
		(shard, 1_700_000_000_000, branch)
	);
	assert_eq!(
		&earlier[..2],
		&[
			SQLITE_SUBSPACE_PREFIX,
			depot::keys::DB_BRANCH_COLD_GC_QUEUE_PARTITION,
		]
	);
	let object_hash = [0x5a; 32];
	let object_prefix = depot::keys::branch_cold_gc_object_prefix(branch);
	let object_key = depot::keys::branch_cold_gc_object_key(branch, object_hash);
	assert!(object_key.starts_with(&object_prefix));
	assert_eq!(&object_key[object_prefix.len()..], &object_hash);
	assert_ne!(
		object_prefix,
		depot::keys::branch_cold_gc_object_prefix(DatabaseBranchId::new_v4()),
		"one branch's physical GC must not scan another branch's tombstones"
	);
}

fn bucket_branch_id() -> BucketBranchId {
	BucketBranchId::from_uuid(Uuid::from_u128(0xffee_ddcc_bbaa_9988_7766_5544_3322_1100))
}

fn bucket_id() -> BucketId {
	BucketId::from_uuid(Uuid::from_u128(0x1020_3040_5060_7080_90a0_b0c0_d0e0_f000))
}

fn compaction_job_id() -> Id {
	Id::v1(
		Uuid::from_u128(0x1234_5678_9abc_def0_1122_3344_5566_7788),
		42,
	)
}

fn uuid_bytes(uuid: Uuid) -> Vec<u8> {
	uuid.as_bytes().to_vec()
}

#[test]
fn meta_subkeys_use_database_prefix_and_expected_suffixes() {
	let database_prefix = database_prefix(TEST_DATABASE);

	let cases = [
		(meta_head_key(TEST_DATABASE), b"/META/head".as_slice()),
		(meta_compact_key(TEST_DATABASE), b"/META/compact".as_slice()),
		(meta_quota_key(TEST_DATABASE), b"/META/quota".as_slice()),
		(
			meta_compactor_lease_key(TEST_DATABASE),
			b"/META/compactor_lease".as_slice(),
		),
	];

	for (key, suffix) in cases {
		assert!(key.starts_with(&database_prefix));
		assert_eq!(&key[database_prefix.len()..], suffix);
	}

	assert_eq!(PAGE_SIZE, 4096);
	assert_eq!(SHARD_SIZE, 64);
}

#[test]
fn pidx_keys_sort_by_big_endian_page_number() {
	let mut keys = vec![
		pidx_delta_key(TEST_DATABASE, 9000),
		pidx_delta_key(TEST_DATABASE, 2),
		pidx_delta_key(TEST_DATABASE, 17),
		pidx_delta_key(TEST_DATABASE, 256),
	];

	keys.sort();

	assert_eq!(
		keys,
		vec![
			pidx_delta_key(TEST_DATABASE, 2),
			pidx_delta_key(TEST_DATABASE, 17),
			pidx_delta_key(TEST_DATABASE, 256),
			pidx_delta_key(TEST_DATABASE, 9000),
		]
	);
	assert!(pidx_delta_key(TEST_DATABASE, 7).starts_with(&pidx_delta_prefix(TEST_DATABASE)));
	assert_eq!(pidx_delta_key(TEST_DATABASE, 7)[0], SQLITE_SUBSPACE_PREFIX);
}

#[test]
fn pidx_count_tree_keys_sort_by_coordinate_before_level() {
	let branch = database_branch_id();
	let mut nodes = vec![
		branch_pidx_count_node_key(branch, 65_536, 2),
		branch_pidx_count_node_key(branch, 256, 1),
		branch_pidx_count_node_key(branch, 256, 0),
		branch_pidx_count_node_key(branch, 257, 0),
	];
	nodes.sort();
	assert_eq!(
		nodes,
		vec![
			branch_pidx_count_node_key(branch, 256, 0),
			branch_pidx_count_node_key(branch, 256, 1),
			branch_pidx_count_node_key(branch, 257, 0),
			branch_pidx_count_node_key(branch, 65_536, 2),
		]
	);
	for key in nodes {
		assert!(key.starts_with(&branch_pidx_count_node_prefix(branch)));
		let (start, level) = decode_branch_pidx_count_node_key(branch, &key).unwrap();
		assert_eq!(key, branch_pidx_count_node_key(branch, start, level));
	}
	assert_eq!(
		decode_branch_pidx_pgno(branch, &branch_pidx_key(branch, u32::MAX)).unwrap(),
		u32::MAX
	);
}

#[test]
fn database_scoped_keys_do_not_collide() {
	let database_a = "database-a";
	let database_b = "database-aa";

	assert_ne!(meta_head_key(database_a), meta_head_key(database_b));
	assert_ne!(meta_compact_key(database_a), meta_compact_key(database_b));
	assert_ne!(meta_quota_key(database_a), meta_quota_key(database_b));
	assert_ne!(
		meta_compactor_lease_key(database_a),
		meta_compactor_lease_key(database_b)
	);
	assert_ne!(pidx_delta_key(database_a, 7), pidx_delta_key(database_b, 7));
	assert_ne!(
		delta_chunk_key(database_a, 1, 0),
		delta_chunk_key(database_b, 1, 0)
	);
	assert_ne!(shard_key(database_a, 3), shard_key(database_b, 3));

	let (start, end) = database_range(database_a);
	let mut expected_start = database_prefix(database_a);
	expected_start.push(b'/');
	assert_eq!(start, expected_start);
	assert_eq!(end, universaldb::utils::end_of_prefix_range(&start));
	assert!(meta_head_key(database_a) >= start && meta_head_key(database_a) < end);
	assert!(meta_head_key(database_b) < start || meta_head_key(database_b) >= end);
	assert!(shard_key(database_a, 3).starts_with(&database_prefix(database_a)));
	assert!(shard_key(database_b, 3).starts_with(&database_prefix(database_b)));
	assert_ne!(commit_key(database_a, 7), commit_key(database_b, 7));
	assert_ne!(vtx_key(database_a, [3; 16]), vtx_key(database_b, [3; 16]));
}

#[test]
fn data_prefixes_match_full_keys() {
	assert!(delta_chunk_key(TEST_DATABASE, 7, 1).starts_with(&delta_prefix(TEST_DATABASE)));
	assert!(
		delta_chunk_key(TEST_DATABASE, 0x0102_0304_0506_0708, 0x090a_0b0c)
			.starts_with(&delta_chunk_prefix(TEST_DATABASE, 0x0102_0304_0506_0708))
	);
	assert!(shard_key(TEST_DATABASE, 3).starts_with(&shard_prefix(TEST_DATABASE)));
	assert!(
		shard_version_key(TEST_DATABASE, 3, 7).starts_with(&shard_version_prefix(TEST_DATABASE, 3))
	);
	assert!(shard_version_key(TEST_DATABASE, 3, 8) > shard_version_key(TEST_DATABASE, 3, 7));
	assert!(commit_key(TEST_DATABASE, 8) > commit_key(TEST_DATABASE, 7));
}

#[test]
fn pitr_partition_prefixes_use_reserved_bytes() {
	let database_branch = database_branch_id();
	let bucket_branch = bucket_branch_id();
	let bucket = bucket_id();

	assert_eq!(
		&database_pointer_cur_key(bucket_branch, TEST_DATABASE)[..3],
		&[SQLITE_SUBSPACE_PREFIX, DBPTR_PARTITION, b'/']
	);
	assert_eq!(
		&bucket_pointer_cur_key(bucket)[..3],
		&[SQLITE_SUBSPACE_PREFIX, BUCKET_PTR_PARTITION, b'/']
	);
	assert_eq!(
		&branches_list_key(database_branch)[..2],
		&[SQLITE_SUBSPACE_PREFIX, BRANCHES_PARTITION]
	);
	assert_eq!(
		&bucket_branches_list_key(bucket_branch)[..2],
		&[SQLITE_SUBSPACE_PREFIX, BUCKET_BRANCH_PARTITION]
	);
	assert_eq!(
		&branch_meta_head_key(database_branch)[..3],
		&[SQLITE_SUBSPACE_PREFIX, BR_PARTITION, b'/']
	);
	assert_eq!(
		&ctr_quota_global_key()[..2],
		&[SQLITE_SUBSPACE_PREFIX, CTR_PARTITION]
	);
	assert_eq!(
		&restore_point_key(TEST_DATABASE, TEST_RESTORE_POINT)[..2],
		&[SQLITE_SUBSPACE_PREFIX, RESTORE_POINT_PARTITION]
	);
}

#[test]
fn hot_generation_keys_sort_by_txid_and_decode_exactly() {
	let branch_id = database_branch_id();
	let prefix = branch_compaction_hot_generation_prefix(branch_id);
	let first = branch_compaction_hot_generation_key(branch_id, 7);
	let second = branch_compaction_hot_generation_key(branch_id, 8);
	assert!(first.starts_with(&prefix));
	assert!(first < second);
	assert_eq!(
		decode_branch_compaction_hot_generation_txid(branch_id, &second)
			.expect("hot generation key should decode"),
		8
	);
	assert!(
		branch_compaction_hot_publish_key(branch_id, 9)
			> branch_compaction_hot_publish_key(branch_id, 8)
	);
	assert_ne!(
		branch_compaction_hot_publish_key(branch_id, 9),
		branch_compaction_root_key(branch_id)
	);
}

#[test]
fn hot_shard_coverage_keys_are_shard_major_and_decode_exactly() {
	let branch_id = database_branch_id();
	let branch_prefix = branch_compaction_hot_shard_coverage_prefix(branch_id);
	let shard_prefix = branch_compaction_hot_shard_coverage_version_prefix(branch_id, 7);
	let older = branch_compaction_hot_shard_coverage_key(branch_id, 7, 41);
	let newer = branch_compaction_hot_shard_coverage_key(branch_id, 7, 42);
	let next_shard = branch_compaction_hot_shard_coverage_key(branch_id, 8, 1);

	assert!(shard_prefix.starts_with(&branch_prefix));
	assert!(older.starts_with(&shard_prefix));
	assert!(older < newer);
	assert!(newer < next_shard);
	assert_eq!(
		decode_branch_compaction_hot_shard_coverage_key(branch_id, &newer)
			.expect("hot shard coverage key should decode"),
		(7, 42)
	);
	assert!(
		decode_branch_compaction_hot_shard_coverage_key(branch_id, &newer[..newer.len() - 1])
			.is_err(),
		"truncated coverage keys must fail closed"
	);
}

#[test]
fn pointer_keys_include_current_and_history_paths() {
	let bucket_branch = bucket_branch_id();
	let bucket = bucket_id();
	let mut expected_database = vec![SQLITE_SUBSPACE_PREFIX, DBPTR_PARTITION, b'/'];
	expected_database.extend_from_slice(&uuid_bytes(bucket_branch.as_uuid()));
	expected_database.extend_from_slice(b"/test-database/cur");
	assert_eq!(
		database_pointer_cur_key(bucket_branch, TEST_DATABASE),
		expected_database
	);

	let mut expected_database_history = vec![SQLITE_SUBSPACE_PREFIX, DBPTR_PARTITION, b'/'];
	expected_database_history.extend_from_slice(&uuid_bytes(bucket_branch.as_uuid()));
	expected_database_history.extend_from_slice(b"/test-database/history/");
	expected_database_history.extend_from_slice(&123_i64.to_be_bytes());
	expected_database_history.extend_from_slice(&9_u32.to_be_bytes());
	assert_eq!(
		database_pointer_history_key(bucket_branch, TEST_DATABASE, 123, 9),
		expected_database_history
	);

	let mut expected_bucket = vec![SQLITE_SUBSPACE_PREFIX, BUCKET_PTR_PARTITION, b'/'];
	expected_bucket.extend_from_slice(&uuid_bytes(bucket.as_uuid()));
	expected_bucket.extend_from_slice(b"/cur");
	assert_eq!(bucket_pointer_cur_key(bucket), expected_bucket);

	assert!(bucket_pointer_history_key(bucket, 123, 9) > bucket_pointer_cur_key(bucket));
}

#[test]
fn bucket_policy_keys_use_bucket_scope_and_database_overrides() {
	let bucket = bucket_id();
	let mut bucket_base = vec![SQLITE_SUBSPACE_PREFIX, BUCKET_PTR_PARTITION, b'/'];
	bucket_base.extend_from_slice(&uuid_bytes(bucket.as_uuid()));

	assert_eq!(
		bucket_policy_pitr_key(bucket),
		[bucket_base.as_slice(), b"/POLICY/PITR"].concat()
	);
	assert_eq!(
		bucket_policy_shard_cache_key(bucket),
		[bucket_base.as_slice(), b"/POLICY/SHARD_CACHE"].concat()
	);
	assert_eq!(
		database_pitr_policy_key(bucket, TEST_DATABASE),
		[bucket_base.as_slice(), b"/DB_POLICY/test-database/PITR"].concat()
	);
	assert_eq!(
		database_shard_cache_policy_key(bucket, TEST_DATABASE),
		[
			bucket_base.as_slice(),
			b"/DB_POLICY/test-database/SHARD_CACHE"
		]
		.concat()
	);

	let binding_key = database_policy_binding_key(database_branch_id());
	assert_eq!(
		&binding_key[..3],
		&[SQLITE_SUBSPACE_PREFIX, DB_POLICY_BINDING_PARTITION, b'/']
	);
	assert_eq!(&binding_key[3..], database_branch_id().as_uuid().as_bytes());

	let shard_key = bucket_policy_pitr_shard_key(bucket, 0xa5);
	assert_eq!(
		&shard_key[..4],
		&[
			SQLITE_SUBSPACE_PREFIX,
			BUCKET_POLICY_PITR_SHARD_PARTITION,
			b'/',
			0xa5,
		]
	);
	assert_eq!(shard_key[4], b'/');
	assert_eq!(&shard_key[5..], bucket.as_uuid().as_bytes());
}

#[test]
fn branch_record_keys_include_counter_and_pin_subkeys() {
	let database_branch = database_branch_id();
	let bucket_branch = bucket_branch_id();

	let mut database_base = vec![SQLITE_SUBSPACE_PREFIX, BRANCHES_PARTITION];
	database_base.extend_from_slice(b"/list/");
	database_base.extend_from_slice(&uuid_bytes(database_branch.as_uuid()));
	assert_eq!(branches_list_key(database_branch), database_base);
	assert_eq!(
		branches_refcount_key(database_branch),
		[database_base.as_slice(), b"/refcount"].concat()
	);
	assert_eq!(
		branches_desc_pin_key(database_branch),
		[database_base.as_slice(), b"/desc_pin"].concat()
	);
	assert_eq!(
		branches_restore_point_pin_key(database_branch),
		[database_base.as_slice(), b"/restore_point_pin"].concat()
	);

	let mut bucket_base = vec![SQLITE_SUBSPACE_PREFIX, BUCKET_BRANCH_PARTITION];
	bucket_base.extend_from_slice(b"/list/");
	bucket_base.extend_from_slice(&uuid_bytes(bucket_branch.as_uuid()));
	assert_eq!(bucket_branches_list_key(bucket_branch), bucket_base);
	assert_eq!(
		bucket_branches_refcount_key(bucket_branch),
		[bucket_base.as_slice(), b"/refcount"].concat()
	);
	assert_eq!(
		bucket_branches_desc_pin_key(bucket_branch),
		[bucket_base.as_slice(), b"/desc_pin"].concat()
	);
	assert_eq!(
		bucket_branches_restore_point_pin_key(bucket_branch),
		[bucket_base.as_slice(), b"/restore_point_pin"].concat()
	);
	assert_eq!(
		bucket_branches_database_name_tombstone_key(bucket_branch, TEST_DATABASE),
		[
			bucket_base.as_slice(),
			b"/database_tombstones/test-database"
		]
		.concat()
	);
}

#[test]
fn database_branch_data_keys_live_under_br_partition() {
	let branch = database_branch_id();
	let prefix = branch_prefix(branch);
	let (start, end) = branch_range(branch);

	let mut expected_start = prefix.clone();
	expected_start.push(b'/');
	assert_eq!(start, expected_start);
	assert_eq!(end, universaldb::utils::end_of_prefix_range(&start));

	for key in [
		branch_meta_head_key(branch),
		branch_meta_head_at_fork_key(branch),
		branch_meta_compact_key(branch),
		branch_meta_quota_key(branch),
		branch_meta_compactor_lease_key(branch),
		branch_manifest_last_hot_pass_txid_key(branch),
		branch_manifest_last_access_ts_ms_key(branch),
		branch_manifest_last_access_bucket_key(branch),
		branch_compaction_root_key(branch),
		branch_compaction_stage_hot_shard_key(branch, compaction_job_id(), 4, 7, 2),
		branch_commit_key(branch, 7),
		branch_vtx_key(branch, [3; 16]),
		branch_pitr_interval_key(branch, 1_700_000_000_000),
		branch_pidx_key(branch, 9),
		branch_page_history_complete_txid_key(branch),
		branch_page_history_key(branch, 9, 7),
		branch_delta_chunk_key(branch, 7, 2),
		branch_shard_key(branch, 4, 7),
	] {
		assert!(key.starts_with(&branch_prefix(branch)));
	}

	assert_eq!(
		&branch_meta_head_at_fork_key(branch)[branch_prefix(branch).len()..],
		b"/META/head_at_fork"
	);
	assert_eq!(
		&branch_compaction_root_key(branch)[branch_prefix(branch).len()..],
		b"/CMP/root"
	);
	assert!(branch_shard_key(branch, 4, 7).starts_with(&branch_shard_version_prefix(branch, 4)));
	assert!(
		branch_compaction_stage_hot_shard_key(branch, compaction_job_id(), 4, 7, 2).starts_with(
			&branch_compaction_stage_hot_shard_version_prefix(branch, compaction_job_id(), 4)
		)
	);
	assert!(
		branch_pitr_interval_key(branch, 1_700_000_000_000)
			.starts_with(&branch_pitr_interval_prefix(branch))
	);
	assert!(branch_commit_key(branch, 8) > branch_commit_key(branch, 7));
	assert!(branch_page_history_key(branch, 9, 8) > branch_page_history_key(branch, 9, 7));
	assert!(
		branch_page_history_key(branch, 9, 7)
			.starts_with(&branch_page_history_page_prefix(branch, 9))
	);
}

#[test]
fn global_restore_point_and_compactor_keys_match_expected_suffixes() {
	let branch = database_branch_id();

	let eviction = ctr_eviction_index_key(42, branch);
	assert!(eviction.starts_with(&[SQLITE_SUBSPACE_PREFIX, CTR_PARTITION]));
	assert!(eviction.ends_with(database_branch_id().as_uuid().as_bytes()));
	assert_eq!(
		decode_ctr_eviction_index_key(&eviction).unwrap(),
		(42, branch)
	);
	let (eviction_start, eviction_end) = ctr_eviction_index_range();
	assert!(eviction >= eviction_start);
	assert!(eviction < eviction_end);

	assert_eq!(
		restore_point_key(TEST_DATABASE, TEST_RESTORE_POINT),
		[
			restore_point_prefix(TEST_DATABASE).as_slice(),
			TEST_RESTORE_POINT.as_bytes()
		]
		.concat()
	);
}

#[test]
fn workflow_compaction_key_partitions_are_reserved() {
	let branch = database_branch_id();
	let bucket_branch = bucket_branch_id();

	assert_eq!(
		&db_pin_key(branch, b"restore_point/test")[..2],
		&[SQLITE_SUBSPACE_PREFIX, DB_PIN_PARTITION]
	);
	assert_eq!(
		&bucket_fork_pin_key(bucket_branch, [1; 16], bucket_branch)[..2],
		&[SQLITE_SUBSPACE_PREFIX, BUCKET_FORK_PIN_PARTITION]
	);
	assert_eq!(
		&bucket_child_key(bucket_branch, [1; 16], bucket_branch)[..2],
		&[SQLITE_SUBSPACE_PREFIX, BUCKET_CHILD_PARTITION]
	);
	assert_eq!(
		&bucket_catalog_by_db_key(branch, bucket_branch)[..2],
		&[SQLITE_SUBSPACE_PREFIX, BUCKET_CATALOG_BY_DB_PARTITION]
	);
	assert_eq!(
		&bucket_proof_epoch_key(bucket_branch)[..2],
		&[SQLITE_SUBSPACE_PREFIX, BUCKET_PROOF_EPOCH_PARTITION]
	);
	assert_eq!(
		&sqlite_cmp_dirty_key(branch)[..2],
		&[SQLITE_SUBSPACE_PREFIX, SQLITE_CMP_DIRTY_PARTITION]
	);
	assert_eq!(
		decode_sqlite_cmp_dirty_branch_id(&sqlite_cmp_dirty_key(branch)).unwrap(),
		branch
	);
	assert!(sqlite_cmp_dirty_key(branch).starts_with(&sqlite_cmp_dirty_prefix()));
	assert!(decode_sqlite_cmp_dirty_branch_id(&sqlite_cmp_dirty_prefix()).is_err());
	let due_key = sqlite_cmp_dirty_due_key(1_700_000_000_000, branch, 1_699_999_999_000, 3);
	assert_eq!(
		&due_key[..2],
		&[SQLITE_SUBSPACE_PREFIX, SQLITE_CMP_DIRTY_DUE_PARTITION]
	);
	assert!(due_key.starts_with(&sqlite_cmp_dirty_due_prefix()));
	assert_eq!(
		decode_sqlite_cmp_dirty_due_key(&due_key).unwrap(),
		(1_700_000_000_000, branch, 1_699_999_999_000, 3)
	);
	assert_eq!(
		&sqlite_cmp_dirty_due_locator_key(branch)[..2],
		&[
			SQLITE_SUBSPACE_PREFIX,
			SQLITE_CMP_DIRTY_DUE_LOCATOR_PARTITION,
		]
	);
}

#[test]
fn workflow_compaction_branch_keys_sort_by_big_endian_components() {
	let branch = database_branch_id();
	let job = compaction_job_id();

	let mut staged_hot_shards = vec![
		branch_compaction_stage_hot_shard_key(branch, job, 2, 10, 1),
		branch_compaction_stage_hot_shard_key(branch, job, 1, 50, 1),
		branch_compaction_stage_hot_shard_key(branch, job, 1, 7, 2),
		branch_compaction_stage_hot_shard_key(branch, job, 1, 7, 1),
	];
	staged_hot_shards.sort();
	assert_eq!(
		staged_hot_shards,
		vec![
			branch_compaction_stage_hot_shard_key(branch, job, 1, 7, 1),
			branch_compaction_stage_hot_shard_key(branch, job, 1, 7, 2),
			branch_compaction_stage_hot_shard_key(branch, job, 1, 50, 1),
			branch_compaction_stage_hot_shard_key(branch, job, 2, 10, 1),
		]
	);
}

#[test]
fn staged_hot_job_generation_index_round_trips_and_sorts() {
	let branch = database_branch_id();
	let job = compaction_job_id();
	let key = branch_compaction_stage_hot_job_by_generation_key(branch, 42, job);
	assert!(
		key.starts_with(&branch_compaction_stage_hot_job_by_generation_prefix(
			branch
		))
	);
	assert_eq!(
		decode_branch_compaction_stage_hot_job_by_generation_key(branch, &key).unwrap(),
		(42, job)
	);
	assert!(
		branch_compaction_stage_hot_job_by_generation_key(branch, 41, job)
			< branch_compaction_stage_hot_job_by_generation_key(branch, 42, job)
	);
	assert!(
		decode_branch_compaction_stage_hot_job_by_generation_key(
			branch,
			&branch_compaction_stage_hot_job_by_generation_prefix(branch),
		)
		.is_err()
	);
}

#[test]
fn history_pin_txid_indexes_are_branch_scoped_ordered_and_decodable() {
	let branch = database_branch_id();
	let other_branch = DatabaseBranchId::from_uuid(Uuid::from_u128(1));
	let pin_id = b"fork/child-a";
	let by_txid = db_pin_by_txid_key(branch, 42, pin_id);
	assert!(by_txid.starts_with(&db_pin_by_txid_prefix(branch)));
	assert_eq!(
		decode_db_pin_by_txid_key(branch, &by_txid).unwrap(),
		(42, pin_id.to_vec())
	);
	assert_ne!(by_txid, db_pin_by_txid_key(other_branch, 42, pin_id));
	assert!(db_pin_by_txid_key(branch, 41, b"z") < db_pin_by_txid_key(branch, 42, b"a"));
	assert_eq!(
		&by_txid[..2],
		&[SQLITE_SUBSPACE_PREFIX, DB_PIN_BY_TXID_PARTITION]
	);

	let count = db_pin_txid_count_key(branch, 42);
	assert!(count.starts_with(&db_pin_txid_count_prefix(branch)));
	assert_eq!(decode_db_pin_txid_count_key(branch, &count).unwrap(), 42);
	assert!(db_pin_txid_count_key(branch, 41) < count);
	assert_eq!(
		&count[..2],
		&[SQLITE_SUBSPACE_PREFIX, DB_PIN_TXID_COUNT_PARTITION]
	);
	assert!(decode_db_pin_by_txid_key(branch, &db_pin_by_txid_prefix(branch)).is_err());
	assert!(decode_db_pin_txid_count_key(branch, &db_pin_txid_count_prefix(branch)).is_err());

	let count_shard = branch_history_pin_count_shard_key(branch, 63);
	assert!(count_shard.starts_with(&branch_history_pin_count_shard_prefix(branch)));
	assert_eq!(
		decode_branch_history_pin_count_shard_key(branch, &count_shard).unwrap(),
		63
	);
	assert!(
		decode_branch_history_pin_count_shard_key(
			branch,
			&branch_history_pin_count_shard_prefix(branch)
		)
		.is_err()
	);
}

#[test]
fn cold_ref_and_retirement_keys_are_exact_and_branch_scoped() {
	let branch = database_branch_id();
	let other_branch = DatabaseBranchId::from_uuid(Uuid::from_u128(1));
	let cold_key = branch_compaction_cold_shard_key(branch, 7, 42);
	assert!(cold_key.starts_with(&branch_compaction_cold_shard_prefix(branch)));
	assert!(cold_key.starts_with(&branch_compaction_cold_shard_version_prefix(branch, 7)));
	assert!(
		branch_compaction_cold_shard_key(branch, 7, 43)
			> branch_compaction_cold_shard_key(branch, 7, 42)
	);
	assert_ne!(
		cold_key,
		branch_compaction_cold_shard_key(other_branch, 7, 42)
	);

	let retired = branch_compaction_retired_cold_object_key(branch, [9; 32]);
	assert!(retired.starts_with(&branch_compaction_retired_cold_object_prefix(branch)));
	assert_ne!(
		retired,
		branch_compaction_retired_cold_object_key(other_branch, [9; 32])
	);
	let due = branch_compaction_retired_cold_object_due_key(branch, 1_700_000_000_000, [9; 32]);
	assert!(due.starts_with(&branch_compaction_retired_cold_object_due_prefix(branch)));
	assert_eq!(
		depot::keys::decode_branch_compaction_retired_cold_object_due_key(branch, &due).unwrap(),
		(1_700_000_000_000, [9; 32])
	);
}

#[test]
fn cold_upload_intent_keys_are_job_local_ordered_and_decodable() {
	let branch = database_branch_id();
	let other_branch = DatabaseBranchId::from_uuid(Uuid::from_u128(1));
	let job = compaction_job_id();
	let key = branch_compaction_cold_upload_intent_key(branch, job, 7, 42);

	assert!(key.starts_with(&branch_compaction_cold_upload_intent_prefix(branch)));
	assert!(
		key.starts_with(&branch_compaction_cold_upload_intent_job_prefix(
			branch, job
		))
	);
	assert_eq!(
		decode_branch_compaction_cold_upload_intent_key(branch, job, &key).unwrap(),
		(7, 42)
	);
	assert!(
		branch_compaction_cold_upload_intent_key(branch, job, 7, 41)
			< branch_compaction_cold_upload_intent_key(branch, job, 7, 42)
	);
	assert!(
		branch_compaction_cold_upload_intent_key(branch, job, 7, 42)
			< branch_compaction_cold_upload_intent_key(branch, job, 8, 1)
	);
	assert_ne!(
		key,
		branch_compaction_cold_upload_intent_key(other_branch, job, 7, 42)
	);
	assert!(
		decode_branch_compaction_cold_upload_intent_key(
			branch,
			job,
			&branch_compaction_cold_upload_intent_job_prefix(branch, job),
		)
		.is_err()
	);
}

#[test]
fn cold_upload_job_backlog_is_sharded_and_branch_clearable() {
	let branch = database_branch_id();
	let other_branch = DatabaseBranchId::from_uuid(Uuid::from_u128(1));
	let job = compaction_job_id();
	let key = branch_cold_upload_job_queue_key(branch, job);

	assert!(key.starts_with(&cold_upload_job_queue_prefix()));
	assert!(key.starts_with(&branch_cold_upload_job_queue_prefix(branch)));
	assert_ne!(key, branch_cold_upload_job_queue_key(other_branch, job));
	assert_ne!(
		branch_cold_upload_job_queue_prefix(branch),
		branch_cold_upload_job_queue_prefix(other_branch)
	);
}

#[test]
fn hot_compaction_job_backlog_is_sharded_and_branch_clearable() {
	let branch = database_branch_id();
	let other_branch = DatabaseBranchId::from_uuid(Uuid::from_u128(1));
	let job = compaction_job_id();
	let key = branch_hot_compaction_job_queue_key(branch, job);

	assert!(key.starts_with(&hot_compaction_job_queue_prefix()));
	assert!(key.starts_with(&branch_hot_compaction_job_queue_prefix(branch)));
	assert_ne!(key, branch_hot_compaction_job_queue_key(other_branch, job));
	assert_ne!(
		branch_hot_compaction_job_queue_prefix(branch),
		branch_hot_compaction_job_queue_prefix(other_branch)
	);
}

#[test]
fn workflow_compaction_global_keys_sort_by_big_endian_components() {
	let branch = database_branch_id();
	let source_bucket = bucket_branch_id();
	let target_a =
		BucketBranchId::from_uuid(Uuid::from_u128(0x0000_0000_0000_0000_0000_0000_0000_0001));
	let target_b =
		BucketBranchId::from_uuid(Uuid::from_u128(0x0000_0000_0000_0000_0000_0000_0000_0002));

	assert!(db_pin_key(branch, b"restore_point/a").starts_with(&db_pin_prefix(branch)));
	assert!(
		bucket_catalog_by_db_key(branch, source_bucket)
			.starts_with(&bucket_catalog_by_db_prefix(branch))
	);
	assert!(
		bucket_fork_pin_key(source_bucket, [1; 16], target_a)
			.starts_with(&bucket_fork_pin_prefix(source_bucket))
	);
	assert!(
		bucket_child_key(source_bucket, [1; 16], target_a)
			.starts_with(&bucket_child_prefix(source_bucket))
	);
	let epoch_shard = bucket_proof_epoch_shard(source_bucket);
	assert!(
		branch_bucket_proof_epoch_shard_key(branch, epoch_shard)
			.starts_with(&branch_bucket_proof_epoch_shard_prefix(branch))
	);
	assert_eq!(
		depot::keys::decode_branch_bucket_proof_epoch_shard_key(
			branch,
			&branch_bucket_proof_epoch_shard_key(branch, epoch_shard),
		)
		.unwrap(),
		epoch_shard
	);
	assert_ne!(
		bucket_proof_epoch_shard_key(epoch_shard),
		bucket_proof_epoch_key(source_bucket),
	);

	let mut fork_pins = vec![
		bucket_fork_pin_key(source_bucket, [2; 16], target_a),
		bucket_fork_pin_key(source_bucket, [1; 16], target_b),
		bucket_fork_pin_key(source_bucket, [1; 16], target_a),
	];
	fork_pins.sort();
	assert_eq!(
		fork_pins,
		vec![
			bucket_fork_pin_key(source_bucket, [1; 16], target_a),
			bucket_fork_pin_key(source_bucket, [1; 16], target_b),
			bucket_fork_pin_key(source_bucket, [2; 16], target_a),
		]
	);

	let mut child_edges = vec![
		bucket_child_key(source_bucket, [2; 16], target_a),
		bucket_child_key(source_bucket, [1; 16], target_b),
		bucket_child_key(source_bucket, [1; 16], target_a),
	];
	child_edges.sort();
	assert_eq!(
		child_edges,
		vec![
			bucket_child_key(source_bucket, [1; 16], target_a),
			bucket_child_key(source_bucket, [1; 16], target_b),
			bucket_child_key(source_bucket, [2; 16], target_a),
		]
	);

	let mut pitr_intervals = vec![
		branch_pitr_interval_key(branch, 1_700_000_600_000),
		branch_pitr_interval_key(branch, 1_700_000_000_000),
		branch_pitr_interval_key(branch, 1_700_000_300_000),
	];
	pitr_intervals.sort();
	assert_eq!(
		pitr_intervals,
		vec![
			branch_pitr_interval_key(branch, 1_700_000_000_000),
			branch_pitr_interval_key(branch, 1_700_000_300_000),
			branch_pitr_interval_key(branch, 1_700_000_600_000),
		]
	);
}
