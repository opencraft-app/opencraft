use depot::types::{
	BucketBranchId, BucketCatalogDbFact, BucketForkFact, ColdDeleteAuthorization, ColdDeleteReason,
	ColdDeleteReceipt, ColdShardRef, ColdUploadIntent, CompactionRoot, DatabaseBranchId,
	DbHistoryPin, DbHistoryPinKind, HotGenerationManifest, HotGenerationShardRef, HotPublishMarker,
	PitrIntervalCoverage, RestorePointId, RetiredColdObject, RetiredColdObjectDeleteState,
	SQLITE_STORAGE_META_VERSION, SqliteCmpDirty, decode_bucket_catalog_db_fact,
	decode_bucket_fork_fact, decode_cold_delete_receipt, decode_cold_shard_ref,
	decode_cold_upload_intent, decode_compaction_root, decode_db_history_pin,
	decode_hot_generation_manifest, decode_hot_publish_marker, decode_pitr_interval_coverage,
	decode_retired_cold_object, decode_sqlite_cmp_dirty, encode_bucket_catalog_db_fact,
	encode_bucket_fork_fact, encode_cold_delete_receipt, encode_cold_shard_ref,
	encode_cold_upload_intent, encode_compaction_root, encode_db_history_pin,
	encode_hot_generation_manifest, encode_hot_publish_marker, encode_pitr_interval_coverage,
	encode_retired_cold_object, encode_sqlite_cmp_dirty,
};
use depot::{
	CMP_JOB_DESCRIPTOR_LIMIT_BYTES, CMP_RECLAIM_CONTROL_MAX_ITEMS_PER_LANE,
	CMP_SIGNAL_PAYLOAD_LIMIT_BYTES,
	cold_tier::cold_shard_object_key,
	workflows::compaction::{
		ColdInputSummary, ColdJobInputRange, CompactionJobKind, CompactionJobStatus,
		HotShardEvictionRef, PlannedColdCompactionJob, PlannedReclaimCompactionJob,
		ReclaimColdObjectRef, ReclaimJobInputRange, ReclaimTxidRef, RunColdJob, RunReclaimJob,
		TxidRange,
	},
};
use gas::prelude::Id;
use uuid::Uuid;

fn database_branch_id(value: u128) -> DatabaseBranchId {
	DatabaseBranchId::from_uuid(Uuid::from_u128(value))
}

fn bucket_branch_id(value: u128) -> BucketBranchId {
	BucketBranchId::from_uuid(Uuid::from_u128(value))
}

fn assert_embedded_version(encoded: &[u8]) {
	assert_eq!(
		u16::from_le_bytes([encoded[0], encoded[1]]),
		SQLITE_STORAGE_META_VERSION
	);
}

#[test]
fn cold_job_control_plane_payload_is_constant_size() {
	let database_branch_id = database_branch_id(0xaaaa_bbbb_cccc_dddd_eeee_ffff_0000_3333);
	let job_id = Id::v1(
		Uuid::from_u128(0x1234_5678_90ab_cdef_1234_5678_90ab_cdef),
		7,
	);
	let input_range = ColdJobInputRange {
		txids: TxidRange {
			min_txid: 1,
			max_txid: u64::MAX,
		},
		min_versionstamp: [255; 16],
		max_versionstamp: [255; 16],
		input_summary: ColdInputSummary {
			input_ref_count: u32::MAX,
			input_refs_hash: [255; 32],
		},
		max_bytes: u64::MAX,
	};
	let signal = RunColdJob {
		database_branch_id,
		job_id,
		job_kind: CompactionJobKind::Cold,
		base_lifecycle_generation: u64::MAX,
		base_manifest_generation: u64::MAX,
		input_fingerprint: [255; 32],
		status: CompactionJobStatus::Requested,
		input_range: input_range.clone(),
	};
	let signal_json = serde_json::to_vec(&signal).expect("cold signal should serialize");
	assert!(
		signal_json.len() <= CMP_SIGNAL_PAYLOAD_LIMIT_BYTES,
		"cold signal was {} bytes, over the {} byte limit",
		signal_json.len(),
		CMP_SIGNAL_PAYLOAD_LIMIT_BYTES,
	);

	let descriptor = PlannedColdCompactionJob {
		database_branch_id,
		job_id,
		base_lifecycle_generation: u64::MAX,
		base_manifest_generation: u64::MAX,
		input_fingerprint: [255; 32],
		input_range,
		planned_at_ms: i64::MAX,
		attempt: u32::MAX,
	};
	let descriptor_json =
		serde_json::to_vec(&descriptor).expect("cold descriptor should serialize");
	assert!(
		descriptor_json.len() <= CMP_JOB_DESCRIPTOR_LIMIT_BYTES,
		"cold descriptor was {} bytes, over the {} byte limit",
		descriptor_json.len(),
		CMP_JOB_DESCRIPTOR_LIMIT_BYTES,
	);
}

#[test]
fn maximal_reclaim_control_plane_payload_stays_bounded() {
	let database_branch_id = database_branch_id(0xaaaa_bbbb_cccc_dddd_eeee_ffff_0000_4444);
	let job_id = Id::v1(
		Uuid::from_u128(0x1234_5678_90ab_cdef_1234_5678_90ab_cdef),
		7,
	);
	let items = CMP_RECLAIM_CONTROL_MAX_ITEMS_PER_LANE;
	let txid_refs = (0..items)
		.map(|idx| ReclaimTxidRef {
			txid: u64::MAX - idx as u64,
			versionstamp: [255; 16],
		})
		.collect();
	let cold_objects = (0..items)
		.map(|idx| ReclaimColdObjectRef {
			object_key: format!(
				"ffff/cold/v2/ffffffffffffffffffffffffffffffff/{idx:08x}/ffffffffffffffff/job-id/__________________________________________8.cold"
			),
			object_generation_id: job_id,
			content_hash: [255; 32],
			size_bytes: u64::MAX,
			publish_generation: u64::MAX,
			shard_id: u32::MAX - idx as u32,
			as_of_txid: u64::MAX - idx as u64,
		})
		.collect::<Vec<_>>();
	let retired_cold_objects = cold_objects
		.iter()
		.map(|reference| RetiredColdObject {
			database_branch_id,
			object_key: reference.object_key.clone(),
			object_generation_id: reference.object_generation_id,
			content_hash: reference.content_hash,
			size_bytes: reference.size_bytes,
			shard_id: reference.shard_id,
			as_of_txid: reference.as_of_txid,
			publish_generation: reference.publish_generation,
			retired_manifest_generation: u64::MAX,
			retired_at_ms: i64::MAX,
			retired_versionstamp: [255; 16],
			delete_after_ms: i64::MAX,
			delete_state: RetiredColdObjectDeleteState::DeleteIssued,
			delete_authorization: None,
		})
		.collect();
	let hot_shard_evictions = (0..items)
		.map(|idx| HotShardEvictionRef {
			shard_id: u32::MAX - idx as u32,
			as_of_txid: u64::MAX - idx as u64,
			size_bytes: u64::MAX,
			content_hash: [255; 32],
			cold_proof_as_of_txid: None,
			cold_ref_content_hash: [255; 32],
			cold_publish_generation: u64::MAX,
		})
		.collect();
	let input_range = ReclaimJobInputRange {
		txids: TxidRange {
			min_txid: 1,
			max_txid: u64::MAX,
		},
		txid_refs,
		cold_objects,
		retired_cold_objects,
		hot_shard_evictions,
		orphan_cold_upload_job_id: Some(job_id),
		staged_hot_shards: Vec::new(),
		max_keys: u32::MAX,
		max_bytes: u64::MAX,
	};
	let signal = RunReclaimJob {
		database_branch_id,
		job_id,
		job_kind: CompactionJobKind::Reclaim,
		base_lifecycle_generation: u64::MAX,
		base_manifest_generation: u64::MAX,
		input_fingerprint: [255; 32],
		status: CompactionJobStatus::Requested,
		input_range: input_range.clone(),
	};
	let signal_json = serde_json::to_vec(&signal).expect("reclaim signal should serialize");
	assert!(
		signal_json.len() <= CMP_SIGNAL_PAYLOAD_LIMIT_BYTES,
		"maximal reclaim signal was {} bytes, over the {} byte limit",
		signal_json.len(),
		CMP_SIGNAL_PAYLOAD_LIMIT_BYTES,
	);

	let descriptor = PlannedReclaimCompactionJob {
		database_branch_id,
		job_id,
		base_lifecycle_generation: u64::MAX,
		base_manifest_generation: u64::MAX,
		input_fingerprint: [255; 32],
		input_range,
		planned_at_ms: i64::MAX,
		attempt: u32::MAX,
	};
	let descriptor_json =
		serde_json::to_vec(&descriptor).expect("reclaim descriptor should serialize");
	assert!(
		descriptor_json.len() <= CMP_JOB_DESCRIPTOR_LIMIT_BYTES,
		"maximal reclaim descriptor was {} bytes, over the {} byte limit",
		descriptor_json.len(),
		CMP_JOB_DESCRIPTOR_LIMIT_BYTES,
	);
}

#[test]
fn compaction_root_round_trips_with_embedded_version() {
	let root = CompactionRoot {
		schema_version: 1,
		manifest_generation: 42,
		hot_watermark_txid: 100,
		cold_watermark_txid: 80,
		cold_watermark_versionstamp: [7; 16],
	};

	let encoded = encode_compaction_root(root.clone()).expect("root should encode");
	assert_embedded_version(&encoded);

	let decoded = decode_compaction_root(&encoded).expect("root should decode");
	assert_eq!(decoded, root);
}

#[test]
fn bounded_hot_generation_and_publish_proofs_round_trip() {
	let database_branch_id = database_branch_id(0xaaaa_bbbb_cccc_dddd_eeee_ffff_0000_2222);
	let marker = HotPublishMarker {
		database_branch_id,
		job_id: Id::v1(Uuid::from_u128(0x1234), 9),
		lifecycle_generation: 7,
		publish_generation: 11,
		input_fingerprint: [3; 32],
		staged_row_count: 2,
		staged_rows_hash: [4; 32],
		min_txid: 40,
		max_txid: 42,
	};
	let encoded = encode_hot_publish_marker(marker.clone()).expect("hot marker should encode");
	assert_embedded_version(&encoded);
	assert_eq!(
		decode_hot_publish_marker(&encoded).expect("hot marker should decode"),
		marker
	);

	let manifest = HotGenerationManifest {
		database_branch_id,
		as_of_txid: 42,
		shards: vec![
			HotGenerationShardRef {
				shard_id: 1,
				size_bytes: 4096,
				content_hash: [5; 32],
			},
			HotGenerationShardRef {
				shard_id: 9,
				size_bytes: 8192,
				content_hash: [6; 32],
			},
		],
	};
	let encoded =
		encode_hot_generation_manifest(manifest.clone()).expect("hot manifest should encode");
	assert_embedded_version(&encoded);
	assert_eq!(
		decode_hot_generation_manifest(&encoded).expect("hot manifest should decode"),
		manifest
	);
}

#[test]
fn exact_cold_refs_and_retirement_rows_round_trip_with_embedded_version() {
	let database_branch_id = database_branch_id(0xaaaa_bbbb_cccc_dddd_eeee_ffff_0000_1111);
	let object_generation_id = Id::v1(
		Uuid::from_u128(0x1234_5678_90ab_cdef_1234_5678_90ab_cdef),
		7,
	);
	let content_hash = [3; 32];
	let reference = ColdShardRef {
		database_branch_id,
		object_key: cold_shard_object_key(
			database_branch_id,
			object_generation_id,
			1,
			42,
			content_hash,
		),
		object_generation_id,
		shard_id: 1,
		as_of_txid: 42,
		min_txid: 1,
		max_txid: 42,
		min_versionstamp: [1; 16],
		max_versionstamp: [2; 16],
		ltx_size_bytes: 262_000,
		ltx_content_hash: [4; 32],
		size_bytes: 262_144,
		content_hash,
		lifecycle_generation: 5,
		publish_generation: 9,
	};
	let encoded = encode_cold_shard_ref(reference.clone()).expect("cold ref should encode");
	assert_embedded_version(&encoded);
	assert_eq!(
		decode_cold_shard_ref(&encoded).expect("cold ref should decode"),
		reference
	);
	let intent = ColdUploadIntent {
		reference: reference.clone(),
		delete_authorization: None,
	};
	let encoded = encode_cold_upload_intent(intent.clone()).expect("upload intent should encode");
	assert_embedded_version(&encoded);
	assert_eq!(
		decode_cold_upload_intent(&encoded).expect("upload intent should decode"),
		intent
	);

	let retired = RetiredColdObject {
		database_branch_id,
		object_key: reference.object_key,
		object_generation_id,
		content_hash: reference.content_hash,
		size_bytes: reference.size_bytes,
		shard_id: reference.shard_id,
		as_of_txid: reference.as_of_txid,
		publish_generation: reference.publish_generation,
		retired_manifest_generation: 10,
		retired_at_ms: 1_700_000_000_000,
		retired_versionstamp: [10; 16],
		delete_after_ms: 1_700_003_600_000,
		delete_state: RetiredColdObjectDeleteState::Retired,
		delete_authorization: None,
	};
	let encoded =
		encode_retired_cold_object(retired.clone()).expect("retirement row should encode");
	assert_embedded_version(&encoded);
	assert_eq!(
		decode_retired_cold_object(&encoded).expect("retirement row should decode"),
		retired
	);
}

#[test]
fn cold_delete_receipt_round_trips_with_embedded_version() {
	let receipt = ColdDeleteReceipt {
		object_key: "5a5a/cold/v2/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/00000007/000000000000000b/generation-id/WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo.cold".into(),
		database_branch_id: database_branch_id(
			0xaaaa_bbbb_cccc_dddd_eeee_eeee_eeee_eeee,
		),
		object_generation_id: Id::v1(
			Uuid::from_u128(0x1234_5678_90ab_cdef_1234_5678_90ab_cdef),
			7,
		),
		shard_id: 7,
		as_of_txid: 11,
		content_hash: [0x5a; 32],
		size_bytes: 4 * 1024 * 1024,
		authorization: ColdDeleteAuthorization {
			reason: ColdDeleteReason::RetiredReplacement,
			policy_revision: Some(3),
			backup_policy_fingerprint: Some([0x6b; 32]),
			minimum_restorable_version: Some(42),
			fence_verified_at_ms: Some(1_700_000_000_000),
			fence_valid_until_ms: Some(1_700_003_600_000),
			tombstone_versionstamp: Some([0x7c; 16]),
			issued_at_ms: 1_700_000_100_000,
		},
		completed_at_ms: 1_700_000_100_100,
	};

	let encoded = encode_cold_delete_receipt(receipt.clone()).expect("receipt should encode");
	assert_embedded_version(&encoded);
	assert_eq!(
		decode_cold_delete_receipt(&encoded).expect("receipt should decode"),
		receipt
	);
}

#[test]
fn sqlite_cmp_dirty_round_trips_with_embedded_version() {
	let dirty = SqliteCmpDirty {
		observed_head_txid: 123,
		updated_at_ms: 1_714_000_000_000,
	};

	let encoded = encode_sqlite_cmp_dirty(dirty.clone()).expect("dirty marker should encode");
	assert_embedded_version(&encoded);

	let decoded = decode_sqlite_cmp_dirty(&encoded).expect("dirty marker should decode");
	assert_eq!(decoded, dirty);
}

#[test]
fn pitr_interval_coverage_round_trips_with_embedded_version() {
	let coverage = PitrIntervalCoverage {
		txid: 42,
		versionstamp: [8; 16],
		wall_clock_ms: 1_700_000_123_456,
		expires_at_ms: 1_700_604_923_456,
	};

	let encoded = encode_pitr_interval_coverage(coverage.clone())
		.expect("PITR interval coverage should encode");
	assert_embedded_version(&encoded);

	let decoded =
		decode_pitr_interval_coverage(&encoded).expect("PITR interval coverage should decode");
	assert_eq!(decoded, coverage);
}

#[test]
fn db_history_pin_round_trips_each_kind_with_embedded_version() {
	let cases = [
		DbHistoryPin {
			at_versionstamp: [5; 16],
			at_txid: 50,
			kind: DbHistoryPinKind::DatabaseFork,
			owner_database_branch_id: Some(database_branch_id(
				0x1111_2222_3333_4444_5555_6666_7777_8888,
			)),
			owner_bucket_branch_id: None,
			owner_restore_point: None,
			created_at_ms: 1_714_000_000_001,
		},
		DbHistoryPin {
			at_versionstamp: [6; 16],
			at_txid: 60,
			kind: DbHistoryPinKind::BucketFork,
			owner_database_branch_id: None,
			owner_bucket_branch_id: Some(bucket_branch_id(
				0x9999_aaaa_bbbb_cccc_dddd_eeee_ffff_0000,
			)),
			owner_restore_point: None,
			created_at_ms: 1_714_000_000_002,
		},
		DbHistoryPin {
			at_versionstamp: [7; 16],
			at_txid: 70,
			kind: DbHistoryPinKind::RestorePoint,
			owner_database_branch_id: None,
			owner_bucket_branch_id: None,
			owner_restore_point: Some(
				RestorePointId::new("0000018bcfe56800-0000000000000046")
					.expect("restore_point should be valid"),
			),
			created_at_ms: 1_714_000_000_003,
		},
	];

	for pin in cases {
		let encoded = encode_db_history_pin(pin.clone()).expect("history pin should encode");
		assert_embedded_version(&encoded);

		let decoded = decode_db_history_pin(&encoded).expect("history pin should decode");
		assert_eq!(decoded, pin);
	}
}

#[test]
fn bucket_proof_facts_round_trip_with_embedded_version() {
	let source_bucket_branch_id = bucket_branch_id(0x1111_2222_3333_4444_5555_6666_7777_8888);
	let target_bucket_branch_id = bucket_branch_id(0x9999_aaaa_bbbb_cccc_dddd_eeee_ffff_0000);
	let fork_fact = BucketForkFact {
		source_bucket_branch_id,
		target_bucket_branch_id,
		fork_versionstamp: [8; 16],
		parent_cap_versionstamp: [8; 16],
	};
	let catalog_fact = BucketCatalogDbFact {
		database_branch_id: database_branch_id(0x1234_5678_90ab_cdef_1111_2222_3333_4444),
		bucket_branch_id: source_bucket_branch_id,
		catalog_versionstamp: [7; 16],
		tombstone_versionstamp: Some([9; 16]),
	};

	let encoded_fork =
		encode_bucket_fork_fact(fork_fact.clone()).expect("bucket fork fact should encode");
	assert_embedded_version(&encoded_fork);
	assert_eq!(
		decode_bucket_fork_fact(&encoded_fork).expect("bucket fork fact should decode"),
		fork_fact
	);

	let encoded_catalog = encode_bucket_catalog_db_fact(catalog_fact.clone())
		.expect("bucket catalog fact should encode");
	assert_embedded_version(&encoded_catalog);
	assert_eq!(
		decode_bucket_catalog_db_fact(&encoded_catalog).expect("bucket catalog fact should decode"),
		catalog_fact
	);
}
