use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use vbare::OwnedVersionedData;

use super::{
	ids::{BucketId, DatabaseBranchId},
	serialization::SQLITE_STORAGE_META_VERSION,
};

pub const DEFAULT_PITR_INTERVAL_MS: i64 = 5 * 60 * 1000;
pub const DEFAULT_PITR_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
pub const DEFAULT_SHARD_CACHE_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PitrPolicy {
	pub interval_ms: i64,
	pub retention_ms: i64,
}

impl Default for PitrPolicy {
	fn default() -> Self {
		Self {
			interval_ms: DEFAULT_PITR_INTERVAL_MS,
			retention_ms: DEFAULT_PITR_RETENTION_MS,
		}
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShardCachePolicy {
	pub retention_ms: i64,
}

/// Immutable ownership of a physical database branch's logical policy namespace.
///
/// Database forks and rollbacks create a new physical branch and therefore a new binding. Bucket
/// forks only inherit a pinned historical view of an existing branch, so they do not rewrite its
/// owner. Keeping this binding branch-local makes policy resolution independent of global pointer
/// cardinality and preserves the original scope after a pointer is rolled back or deleted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatabasePolicyBinding {
	pub database_branch_id: DatabaseBranchId,
	pub bucket_id: BucketId,
	pub database_id: String,
}

impl Default for ShardCachePolicy {
	fn default() -> Self {
		Self {
			retention_ms: DEFAULT_SHARD_CACHE_RETENTION_MS,
		}
	}
}

enum VersionedPitrPolicy {
	V1(PitrPolicy),
}

enum VersionedShardCachePolicy {
	V1(ShardCachePolicy),
}

enum VersionedDatabasePolicyBinding {
	V1(DatabasePolicyBinding),
}

impl OwnedVersionedData for VersionedPitrPolicy {
	type Latest = PitrPolicy;

	fn wrap_latest(latest: Self::Latest) -> Self {
		Self::V1(latest)
	}

	fn unwrap_latest(self) -> Result<Self::Latest> {
		match self {
			Self::V1(policy) => Ok(policy),
		}
	}

	fn deserialize_version(payload: &[u8], version: u16) -> Result<Self> {
		match version {
			1 => Ok(Self::V1(rivet_util::serde::bare_from_slice!(payload)?)),
			_ => bail!("invalid depot PitrPolicy version: {version}"),
		}
	}

	fn serialize_version(self, _version: u16) -> Result<Vec<u8>> {
		match self {
			Self::V1(policy) => rivet_util::serde::bare_to_vec!(&policy).map_err(Into::into),
		}
	}
}

impl OwnedVersionedData for VersionedShardCachePolicy {
	type Latest = ShardCachePolicy;

	fn wrap_latest(latest: Self::Latest) -> Self {
		Self::V1(latest)
	}

	fn unwrap_latest(self) -> Result<Self::Latest> {
		match self {
			Self::V1(policy) => Ok(policy),
		}
	}

	fn deserialize_version(payload: &[u8], version: u16) -> Result<Self> {
		match version {
			1 => Ok(Self::V1(rivet_util::serde::bare_from_slice!(payload)?)),
			_ => bail!("invalid depot ShardCachePolicy version: {version}"),
		}
	}

	fn serialize_version(self, _version: u16) -> Result<Vec<u8>> {
		match self {
			Self::V1(policy) => rivet_util::serde::bare_to_vec!(&policy).map_err(Into::into),
		}
	}
}

impl OwnedVersionedData for VersionedDatabasePolicyBinding {
	type Latest = DatabasePolicyBinding;

	fn wrap_latest(latest: Self::Latest) -> Self {
		Self::V1(latest)
	}

	fn unwrap_latest(self) -> Result<Self::Latest> {
		match self {
			Self::V1(binding) => Ok(binding),
		}
	}

	fn deserialize_version(payload: &[u8], version: u16) -> Result<Self> {
		match version {
			1 => Ok(Self::V1(rivet_util::serde::bare_from_slice!(payload)?)),
			_ => bail!("invalid depot DatabasePolicyBinding version: {version}"),
		}
	}

	fn serialize_version(self, _version: u16) -> Result<Vec<u8>> {
		match self {
			Self::V1(binding) => rivet_util::serde::bare_to_vec!(&binding).map_err(Into::into),
		}
	}
}

pub fn encode_pitr_policy(policy: PitrPolicy) -> Result<Vec<u8>> {
	VersionedPitrPolicy::wrap_latest(policy)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite pitr policy")
}

pub fn decode_pitr_policy(payload: &[u8]) -> Result<PitrPolicy> {
	VersionedPitrPolicy::deserialize_with_embedded_version(payload)
		.context("decode sqlite pitr policy")
}

pub fn encode_shard_cache_policy(policy: ShardCachePolicy) -> Result<Vec<u8>> {
	VersionedShardCachePolicy::wrap_latest(policy)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite shard cache policy")
}

pub fn decode_shard_cache_policy(payload: &[u8]) -> Result<ShardCachePolicy> {
	VersionedShardCachePolicy::deserialize_with_embedded_version(payload)
		.context("decode sqlite shard cache policy")
}

pub fn encode_database_policy_binding(binding: DatabasePolicyBinding) -> Result<Vec<u8>> {
	VersionedDatabasePolicyBinding::wrap_latest(binding)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite database policy binding")
}

pub fn decode_database_policy_binding(payload: &[u8]) -> Result<DatabasePolicyBinding> {
	VersionedDatabasePolicyBinding::deserialize_with_embedded_version(payload)
		.context("decode sqlite database policy binding")
}
