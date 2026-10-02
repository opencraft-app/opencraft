use depot::{
	cold_tier::{
		COLD_SHARD_OBJECT_LAYOUT, ColdShardObjectError, cold_shard_object_key,
		materialize_cold_shard, validate_cold_shard_object, validate_cold_shard_ref_key,
	},
	ltx::{LtxHeader, encode_ltx_v3},
	types::{DatabaseBranchId, DirtyPage},
};
use gas::prelude::Id;
use uuid::Uuid;

fn fixture_branch() -> DatabaseBranchId {
	DatabaseBranchId::from_uuid(Uuid::from_u128(0x1111_2222_3333_4444_5555_6666_7777_8888))
}

fn fixture_generation() -> Id {
	Id::v1(
		Uuid::from_u128(0xaaaa_bbbb_cccc_dddd_eeee_ffff_0000_1111),
		9,
	)
}

fn materialize() -> (depot::types::ColdShardRef, Vec<u8>) {
	let branch = fixture_branch();
	let generation = fixture_generation();
	let mut header = LtxHeader::delta(5, 1, 1_700_000_000_000);
	header.min_txid = 1;
	let ltx = encode_ltx_v3(
		header,
		&[DirtyPage {
			pgno: 1,
			bytes: vec![0x5a; 4096],
		}],
	)
	.unwrap();
	materialize_cold_shard(branch, generation, 3, 5, 1, 5, [1; 16], [5; 16], 2, 7, ltx).unwrap()
}

#[test]
fn immutable_cold_object_round_trips_and_binds_every_identity_field() {
	let (reference, bytes) = materialize();
	assert_eq!(COLD_SHARD_OBJECT_LAYOUT, "cold/v2");
	assert_eq!(
		&reference.object_key[..4],
		format!(
			"{:02x}{:02x}",
			reference.content_hash[0], reference.content_hash[1]
		)
	);
	assert!(reference.object_key[4..].starts_with("/cold/v2/"));
	assert!(reference.object_key.ends_with(".cold"));
	let (object, ltx) = validate_cold_shard_object(&reference, &bytes).unwrap();
	assert_eq!(object.database_branch_id, reference.database_branch_id);
	assert_eq!(object.publish_generation, reference.publish_generation);
	assert_eq!(ltx.get_page(1), Some(vec![0x5a; 4096].as_slice()));

	let mut wrong_ref = reference.clone();
	wrong_ref.shard_id += 1;
	assert!(matches!(
		validate_cold_shard_object(&wrong_ref, &bytes).unwrap_err(),
		ColdShardObjectError::IdentityMismatch {
			field: "shard_id",
			..
		}
	));
}

#[test]
fn cold_object_key_has_a_stable_golden_layout() {
	let (reference, _) = materialize();
	assert_eq!(
		reference.object_key,
		"a29c/cold/v2/11112222333344445555666677778888/00000003/0000000000000005/5fqx25vt2mf6bvzu012h3b5s4slb50/opwCCOPOMoIC71KHtfGF6I342hfF8YiD5daqQ0aXBCA.cold"
	);
}

#[test]
fn cold_object_key_fanout_covers_every_two_byte_prefix() {
	let branch = fixture_branch();
	let generation = fixture_generation();
	let mut prefixes = std::collections::HashSet::with_capacity(1 << 16);
	for prefix in 0_u32..=u16::MAX as u32 {
		let mut content_hash = [0_u8; 32];
		content_hash[..2].copy_from_slice(&(prefix as u16).to_be_bytes());
		let key = cold_shard_object_key(branch, generation, 3, 5, content_hash);
		assert_eq!(&key[..4], format!("{prefix:04x}"));
		assert!(prefixes.insert(key[..4].to_string()));
	}
	assert_eq!(prefixes.len(), 1 << 16);
}

#[test]
fn one_hot_branch_with_sequential_txids_is_distributed_before_semantic_path() {
	const SAMPLES: u64 = 4096;
	let mut nibble_counts = [0_usize; 16];
	let mut byte_prefixes = std::collections::HashSet::new();
	let mut two_byte_prefixes = std::collections::HashSet::new();

	for txid in 1..=SAMPLES {
		let page_byte = (txid ^ (txid >> 8)) as u8;
		let ltx = encode_ltx_v3(
			LtxHeader::delta(txid, 1, 1_700_000_000_000 + txid as i64),
			&[DirtyPage {
				pgno: 1,
				bytes: vec![page_byte; 4096],
			}],
		)
		.unwrap();
		let (reference, _) = materialize_cold_shard(
			fixture_branch(),
			fixture_generation(),
			0,
			txid,
			txid,
			txid,
			[0; 16],
			[0xff; 16],
			1,
			txid,
			ltx,
		)
		.unwrap();

		nibble_counts[(reference.content_hash[0] >> 4) as usize] += 1;
		byte_prefixes.insert(reference.content_hash[0]);
		two_byte_prefixes.insert([reference.content_hash[0], reference.content_hash[1]]);
		assert_eq!(
			&reference.object_key[..4],
			format!(
				"{:02x}{:02x}",
				reference.content_hash[0], reference.content_hash[1]
			)
		);
	}

	// These broad deterministic bounds catch regressions back to branch/TXID-leading keys while
	// avoiding probabilistic flakes. The exact sequence is frozen by the object codec and SHA-256.
	assert!(
		nibble_counts
			.iter()
			.all(|count| (192..=320).contains(count)),
		"first-nibble distribution is skewed: {nibble_counts:?}"
	);
	assert!(
		byte_prefixes.len() >= 240,
		"only {} of 256 first-byte partitions used",
		byte_prefixes.len()
	);
	assert!(
		two_byte_prefixes.len() >= 3_800,
		"only {} two-byte partitions used by {SAMPLES} objects",
		two_byte_prefixes.len()
	);
}

#[test]
fn canonical_key_is_deterministic_bounded_and_cos_safe() {
	let (reference, bytes) = materialize();
	let (replayed, replayed_bytes) = materialize();
	assert_eq!(replayed.object_key, reference.object_key);
	assert_eq!(replayed_bytes, bytes);
	assert!(reference.object_key.len() < 256);
	assert!(
		reference
			.object_key
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.'))
	);
}

#[test]
fn noncanonical_exact_key_fails_closed() {
	let (mut reference, bytes) = materialize();
	reference.object_key = format!("ffff/{}", &reference.object_key[5..]);
	assert!(matches!(
		validate_cold_shard_ref_key(&reference).unwrap_err(),
		ColdShardObjectError::IdentityMismatch {
			field: "object_key",
			..
		}
	));
	assert!(matches!(
		validate_cold_shard_object(&reference, &bytes).unwrap_err(),
		ColdShardObjectError::IdentityMismatch {
			field: "object_key",
			..
		}
	));
}

#[test]
fn immutable_cold_object_rejects_truncation_and_bit_flips() {
	let (reference, mut bytes) = materialize();
	bytes.pop();
	assert!(matches!(
		validate_cold_shard_object(&reference, &bytes).unwrap_err(),
		ColdShardObjectError::SizeMismatch { .. }
	));

	let (reference, mut bytes) = materialize();
	let last = bytes.len() - 1;
	bytes[last] ^= 0xff;
	assert!(matches!(
		validate_cold_shard_object(&reference, &bytes).unwrap_err(),
		ColdShardObjectError::HashMismatch { .. }
	));
}
