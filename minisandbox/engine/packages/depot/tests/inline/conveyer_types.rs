use super::{
	BranchState, BucketBranchId, CommitAttemptProof, DBHead, DatabaseBranchId,
	DatabaseBranchRecord, MetaCompact, SQLITE_STORAGE_META_VERSION, decode_commit_attempt_proof,
	decode_database_branch_record, decode_db_head, decode_hot_shard_coverage, decode_meta_compact,
	encode_commit_attempt_proof, encode_database_branch_record, encode_db_head,
	encode_hot_shard_coverage, encode_meta_compact,
};

#[derive(serde::Serialize)]
struct LegacyDatabaseBranchRecordPayload {
	branch_id: DatabaseBranchId,
	bucket_branch: BucketBranchId,
	parent: Option<DatabaseBranchId>,
	parent_versionstamp: Option<[u8; 16]>,
	root_versionstamp: [u8; 16],
	fork_depth: u8,
	created_at_ms: i64,
	created_from_restore_point: Option<super::RestorePointRef>,
	state: BranchState,
}

#[test]
fn db_head_round_trips_with_embedded_version() {
	let head = DBHead {
		head_txid: 42,
		db_size_pages: 128,
		post_apply_checksum: 9,
		branch_id: super::DatabaseBranchId::nil(),
	};

	let encoded = encode_db_head(head.clone()).expect("db head should encode");
	assert_eq!(
		u16::from_le_bytes([encoded[0], encoded[1]]),
		SQLITE_STORAGE_META_VERSION
	);

	let decoded = decode_db_head(&encoded).expect("db head should decode");
	assert_eq!(decoded, head);
}

#[test]
fn commit_attempt_proof_round_trips_with_embedded_version() {
	let proof = CommitAttemptProof {
		attempt_id: [0xa5; 16],
		request_hash: [0x5a; 32],
		txid: 42,
		db_size_pages: 128,
		deltas_available_at_ms: Some(1_234),
		reset_pidx_cache: true,
	};

	let encoded =
		encode_commit_attempt_proof(proof.clone()).expect("commit attempt proof should encode");
	assert_eq!(
		u16::from_le_bytes([encoded[0], encoded[1]]),
		SQLITE_STORAGE_META_VERSION
	);
	assert_eq!(
		decode_commit_attempt_proof(&encoded).expect("commit attempt proof should decode"),
		proof
	);
}

#[test]
fn database_branch_record_round_trips_current_version() {
	let record = DatabaseBranchRecord {
		branch_id: DatabaseBranchId::nil(),
		bucket_branch: BucketBranchId::nil(),
		parent: None,
		parent_versionstamp: None,
		root_versionstamp: [3; 16],
		fork_depth: 2,
		created_at_ms: 1_000,
		created_from_restore_point: None,
		state: BranchState::Live,
		lifecycle_generation: 9,
	};

	let encoded = encode_database_branch_record(record.clone())
		.expect("database branch record should encode");
	assert_eq!(u16::from_le_bytes([encoded[0], encoded[1]]), 1);

	let decoded =
		decode_database_branch_record(&encoded).expect("database branch record should decode");
	assert_eq!(decoded, record);
}

#[test]
fn database_branch_record_rejects_legacy_v1_without_lifecycle_generation() {
	let legacy_payload = LegacyDatabaseBranchRecordPayload {
		branch_id: DatabaseBranchId::nil(),
		bucket_branch: BucketBranchId::nil(),
		parent: None,
		parent_versionstamp: None,
		root_versionstamp: [3; 16],
		fork_depth: 2,
		created_at_ms: 1_000,
		created_from_restore_point: None,
		state: BranchState::Live,
	};
	let mut encoded = 1_u16.to_le_bytes().to_vec();
	encoded.extend(serde_bare::to_vec(&legacy_payload).expect("legacy bare payload should encode"));

	let err = decode_database_branch_record(&encoded)
		.expect_err("legacy branch record should be rejected");
	assert!(
		err.chain().any(|cause| cause
			.to_string()
			.contains("decode sqlite database branch record")),
		"unexpected error chain: {err:#}"
	);
}

#[test]
fn meta_compact_round_trips_with_embedded_version() {
	let compact = MetaCompact {
		materialized_txid: 24,
	};

	let encoded = encode_meta_compact(compact.clone()).expect("compact meta should encode");
	assert_eq!(
		u16::from_le_bytes([encoded[0], encoded[1]]),
		SQLITE_STORAGE_META_VERSION
	);

	let decoded = decode_meta_compact(&encoded).expect("compact meta should decode");
	assert_eq!(decoded, compact);
}

#[test]
fn hot_shard_coverage_round_trips_with_embedded_version() {
	let coverage = super::HotShardCoverage {
		database_branch_id: DatabaseBranchId::nil(),
		shard_id: 7,
		as_of_txid: 42,
		size_bytes: 4096,
		content_hash: [0xa5; 32],
	};

	let encoded =
		encode_hot_shard_coverage(coverage.clone()).expect("hot shard coverage should encode");
	assert_eq!(
		u16::from_le_bytes([encoded[0], encoded[1]]),
		SQLITE_STORAGE_META_VERSION
	);
	assert_eq!(
		decode_hot_shard_coverage(&encoded).expect("hot shard coverage should decode"),
		coverage
	);
}
