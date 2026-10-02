use anyhow::{Context, Result, bail};
use gas::prelude::Id;
use serde::{Deserialize, Serialize};
use vbare::OwnedVersionedData;

use super::{DatabaseBranchId, serialization::SQLITE_STORAGE_META_VERSION};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ColdDeleteReason {
	RetiredReplacement,
	BranchGarbageCollection,
	UnpublishedUploadCleanup,
}

/// Durable proof captured before external object-store deletion is issued.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ColdDeleteAuthorization {
	pub reason: ColdDeleteReason,
	pub policy_revision: Option<u64>,
	pub backup_policy_fingerprint: Option<[u8; 32]>,
	pub minimum_restorable_version: Option<u64>,
	pub fence_verified_at_ms: Option<i64>,
	pub fence_valid_until_ms: Option<i64>,
	pub tombstone_versionstamp: Option<[u8; 16]>,
	pub issued_at_ms: i64,
}

impl ColdDeleteAuthorization {
	pub fn unpublished_upload_cleanup(issued_at_ms: i64) -> Self {
		Self {
			reason: ColdDeleteReason::UnpublishedUploadCleanup,
			policy_revision: None,
			backup_policy_fingerprint: None,
			minimum_restorable_version: None,
			fence_verified_at_ms: None,
			fence_valid_until_ms: None,
			tombstone_versionstamp: None,
			issued_at_ms,
		}
	}
}

/// Immutable exact-key record written in the same FDB transaction that moves accounting from
/// `delete_issued` to `deleted_total`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ColdDeleteReceipt {
	pub object_key: String,
	pub database_branch_id: DatabaseBranchId,
	pub object_generation_id: Id,
	pub shard_id: u32,
	pub as_of_txid: u64,
	pub content_hash: [u8; 32],
	pub size_bytes: u64,
	pub authorization: ColdDeleteAuthorization,
	pub completed_at_ms: i64,
}

enum VersionedColdDeleteReceipt {
	V1(ColdDeleteReceipt),
}

impl OwnedVersionedData for VersionedColdDeleteReceipt {
	type Latest = ColdDeleteReceipt;

	fn wrap_latest(latest: Self::Latest) -> Self {
		Self::V1(latest)
	}

	fn unwrap_latest(self) -> Result<Self::Latest> {
		match self {
			Self::V1(receipt) => Ok(receipt),
		}
	}

	fn deserialize_version(payload: &[u8], version: u16) -> Result<Self> {
		match version {
			1 => Ok(Self::V1(rivet_util::serde::bare_from_slice!(payload)?)),
			_ => bail!("invalid depot ColdDeleteReceipt version: {version}"),
		}
	}

	fn serialize_version(self, _version: u16) -> Result<Vec<u8>> {
		match self {
			Self::V1(receipt) => rivet_util::serde::bare_to_vec!(&receipt).map_err(Into::into),
		}
	}
}

pub fn encode_cold_delete_receipt(receipt: ColdDeleteReceipt) -> Result<Vec<u8>> {
	VersionedColdDeleteReceipt::wrap_latest(receipt)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite cold delete receipt")
}

pub fn decode_cold_delete_receipt(payload: &[u8]) -> Result<ColdDeleteReceipt> {
	VersionedColdDeleteReceipt::deserialize_with_embedded_version(payload)
		.context("decode sqlite cold delete receipt")
}
