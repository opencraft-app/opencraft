use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use gas::prelude::Id;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::conveyer::{
	ltx::{DecodedLtx, decode_ltx_v3},
	types::{
		ColdShardObject, ColdShardRef, DatabaseBranchId, decode_cold_shard_object,
		encode_cold_shard_object,
	},
};

/// Versioned physical layout for immutable cold shards.
///
/// The first four hexadecimal characters are deliberately derived from the immutable object's
/// content hash. COS indexes object keys in byte order, so putting entropy before every semantic
/// component prevents a hot branch or monotonically increasing TXID from concentrating requests
/// in one index partition. Environment, region, and cell isolation belong in the bucket name;
/// production buckets must not prepend a common root prefix ahead of this fanout.
pub const COLD_SHARD_OBJECT_LAYOUT: &str = "cold/v2";

pub fn cold_shard_object_key(
	database_branch_id: DatabaseBranchId,
	object_generation_id: Id,
	shard_id: u32,
	as_of_txid: u64,
	content_hash: [u8; 32],
) -> String {
	format!(
		"{:02x}{:02x}/{COLD_SHARD_OBJECT_LAYOUT}/{}/{shard_id:08x}/{as_of_txid:016x}/{}/{}.cold",
		content_hash[0],
		content_hash[1],
		database_branch_id.as_uuid().simple(),
		object_generation_id,
		URL_SAFE_NO_PAD.encode(content_hash)
	)
}

#[allow(clippy::too_many_arguments)]
pub fn validate_cold_shard_object_key(
	object_key: &str,
	database_branch_id: DatabaseBranchId,
	object_generation_id: Id,
	shard_id: u32,
	as_of_txid: u64,
	content_hash: [u8; 32],
) -> Result<(), ColdShardObjectError> {
	let expected_key = cold_shard_object_key(
		database_branch_id,
		object_generation_id,
		shard_id,
		as_of_txid,
		content_hash,
	);
	if object_key != expected_key {
		return Err(ColdShardObjectError::IdentityMismatch {
			key: object_key.to_string(),
			field: "object_key",
		});
	}
	Ok(())
}

pub fn validate_cold_shard_ref_key(reference: &ColdShardRef) -> Result<(), ColdShardObjectError> {
	validate_cold_shard_object_key(
		&reference.object_key,
		reference.database_branch_id,
		reference.object_generation_id,
		reference.shard_id,
		reference.as_of_txid,
		reference.content_hash,
	)
}

#[derive(Debug, Error)]
pub enum ColdShardObjectError {
	#[error("encode cold shard object: {0}")]
	Encode(#[source] anyhow::Error),
	#[error(
		"cold shard object {key} has invalid encoded length: expected {expected}, got {actual}"
	)]
	SizeMismatch {
		key: String,
		expected: u64,
		actual: u64,
	},
	#[error("cold shard object {key} content hash does not match its published ref")]
	HashMismatch { key: String },
	#[error("decode cold shard object {key}: {source}")]
	Decode {
		key: String,
		#[source]
		source: anyhow::Error,
	},
	#[error("cold shard object {key} identity mismatch: {field}")]
	IdentityMismatch { key: String, field: &'static str },
	#[error("decode LTX payload in cold shard object {key}: {source}")]
	LtxDecode {
		key: String,
		#[source]
		source: anyhow::Error,
	},
}

#[allow(clippy::too_many_arguments)]
pub fn materialize_cold_shard(
	database_branch_id: DatabaseBranchId,
	object_generation_id: Id,
	shard_id: u32,
	as_of_txid: u64,
	min_txid: u64,
	max_txid: u64,
	min_versionstamp: [u8; 16],
	max_versionstamp: [u8; 16],
	lifecycle_generation: u64,
	publish_generation: u64,
	ltx_bytes: Vec<u8>,
) -> Result<(ColdShardRef, Vec<u8>), ColdShardObjectError> {
	let ltx_size_bytes = ltx_bytes.len() as u64;
	let ltx_content_hash: [u8; 32] = Sha256::digest(&ltx_bytes).into();
	let object = ColdShardObject {
		database_branch_id,
		object_generation_id,
		shard_id,
		as_of_txid,
		min_txid,
		max_txid,
		min_versionstamp,
		max_versionstamp,
		ltx_size_bytes,
		ltx_content_hash,
		lifecycle_generation,
		publish_generation,
		ltx_bytes,
	};
	let bytes = encode_cold_shard_object(object).map_err(ColdShardObjectError::Encode)?;
	let content_hash: [u8; 32] = Sha256::digest(&bytes).into();
	let object_key = cold_shard_object_key(
		database_branch_id,
		object_generation_id,
		shard_id,
		as_of_txid,
		content_hash,
	);
	let reference = ColdShardRef {
		database_branch_id,
		object_key,
		object_generation_id,
		shard_id,
		as_of_txid,
		min_txid,
		max_txid,
		min_versionstamp,
		max_versionstamp,
		ltx_size_bytes,
		ltx_content_hash,
		size_bytes: bytes.len() as u64,
		content_hash,
		lifecycle_generation,
		publish_generation,
	};
	Ok((reference, bytes))
}

pub fn validate_cold_shard_object(
	reference: &ColdShardRef,
	bytes: &[u8],
) -> Result<(ColdShardObject, DecodedLtx), ColdShardObjectError> {
	if bytes.len() as u64 != reference.size_bytes {
		return Err(ColdShardObjectError::SizeMismatch {
			key: reference.object_key.clone(),
			expected: reference.size_bytes,
			actual: bytes.len() as u64,
		});
	}
	let actual_hash: [u8; 32] = Sha256::digest(bytes).into();
	if actual_hash != reference.content_hash {
		return Err(ColdShardObjectError::HashMismatch {
			key: reference.object_key.clone(),
		});
	}
	let object =
		decode_cold_shard_object(bytes).map_err(|source| ColdShardObjectError::Decode {
			key: reference.object_key.clone(),
			source,
		})?;

	macro_rules! check {
		($field:ident) => {
			if object.$field != reference.$field {
				return Err(ColdShardObjectError::IdentityMismatch {
					key: reference.object_key.clone(),
					field: stringify!($field),
				});
			}
		};
	}
	check!(database_branch_id);
	check!(object_generation_id);
	check!(shard_id);
	check!(as_of_txid);
	check!(min_txid);
	check!(max_txid);
	check!(min_versionstamp);
	check!(max_versionstamp);
	check!(ltx_size_bytes);
	check!(ltx_content_hash);
	check!(lifecycle_generation);
	check!(publish_generation);

	let ltx =
		decode_ltx_v3(&object.ltx_bytes).map_err(|source| ColdShardObjectError::LtxDecode {
			key: reference.object_key.clone(),
			source,
		})?;
	if object.ltx_bytes.len() as u64 != reference.ltx_size_bytes
		|| <[u8; 32]>::from(Sha256::digest(&object.ltx_bytes)) != reference.ltx_content_hash
	{
		return Err(ColdShardObjectError::IdentityMismatch {
			key: reference.object_key.clone(),
			field: "ltx_content",
		});
	}
	if ltx.header.min_txid != reference.min_txid {
		return Err(ColdShardObjectError::IdentityMismatch {
			key: reference.object_key.clone(),
			field: "ltx.min_txid",
		});
	}
	if ltx.header.max_txid != reference.max_txid || ltx.header.max_txid != reference.as_of_txid {
		return Err(ColdShardObjectError::IdentityMismatch {
			key: reference.object_key.clone(),
			field: "ltx.max_txid",
		});
	}
	validate_cold_shard_object_key(
		&reference.object_key,
		reference.database_branch_id,
		reference.object_generation_id,
		reference.shard_id,
		reference.as_of_txid,
		reference.content_hash,
	)?;

	Ok((object, ltx))
}
