use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use vbare::OwnedVersionedData;

use gas::prelude::Id;

use super::{ids::DatabaseBranchId, serialization::SQLITE_STORAGE_META_VERSION};

/// Durable branch-local fence installed before asynchronous FDB and cold-object deletion.
/// Pin writers read this marker serializably, so a branch cannot acquire a new fork or restore
/// point pin after garbage collection proves it unreferenced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchGcMarker {
	pub database_branch_id: DatabaseBranchId,
	pub lifecycle_generation: u64,
	pub requested_at_ms: i64,
}

/// Durable branch GC scheduling record. One copy is stored in the sharded due index and another
/// at the exact per-branch locator key so enqueue, lease, defer, and wake operations are O(1).
#[derive(Debug, Clone, Hash, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchGcQueueEntry {
	pub database_branch_id: DatabaseBranchId,
	pub requested_at_ms: i64,
	pub due_at_ms: i64,
	pub attempt_count: u16,
}

/// A certificate asserted by the backup controller after it has verified the backup catalog and
/// retention policy. `minimum_restorable_version` is the oldest FDB read version exposed by the
/// supported restore set and is monotonic. `valid_until_ms` makes deletion fail closed when
/// verification stops. Wall clock is deliberately not used to order backup and tombstone commits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColdBackupRecoveryFence {
	pub policy_fingerprint: [u8; 32],
	pub minimum_restorable_version: u64,
	pub verified_at_ms: i64,
	pub valid_until_ms: i64,
}

/// Branch-external logical tombstone. It survives deletion of the branch-local FDB subspace and
/// owns a bounded, exact-key object manifest until physical cold deletion completes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchColdGcManifest {
	pub database_branch_id: DatabaseBranchId,
	pub lifecycle_generation: u64,
	pub tombstoned_at_ms: i64,
	pub tombstone_versionstamp: [u8; 16],
	pub delete_after_ms: i64,
	pub staged_object_count: u64,
	pub staging_complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchColdObjectTombstone {
	pub database_branch_id: DatabaseBranchId,
	pub lifecycle_generation: u64,
	pub tombstoned_at_ms: i64,
	pub object_key: String,
	pub object_generation_id: Id,
	pub content_hash: [u8; 32],
	pub size_bytes: u64,
	pub shard_id: u32,
	pub as_of_txid: u64,
	/// Accounting class owned by this external tombstone after branch-local metadata is swept.
	pub accounting_state: BranchColdObjectAccountingState,
	pub delete_authorization: Option<super::ColdDeleteAuthorization>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BranchColdObjectAccountingState {
	Retired,
	DeleteIssued,
	Orphan,
	OrphanDeleteIssued,
	Deleted,
}

/// One copy is in a 64-way due index and one at an exact locator. Workers never scan manifests or
/// object storage to discover work.
#[derive(Debug, Clone, Hash, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchColdGcQueueEntry {
	pub database_branch_id: DatabaseBranchId,
	pub tombstoned_at_ms: i64,
	pub tombstone_versionstamp: [u8; 16],
	pub due_at_ms: i64,
	pub attempt_count: u16,
}

enum VersionedBranchGcMarker {
	V1(BranchGcMarker),
}

enum VersionedBranchGcQueueEntry {
	V1(BranchGcQueueEntry),
}

enum VersionedColdBackupRecoveryFence {
	V1(ColdBackupRecoveryFence),
}

enum VersionedBranchColdGcManifest {
	V1(BranchColdGcManifest),
}

enum VersionedBranchColdObjectTombstone {
	V1(BranchColdObjectTombstone),
}

enum VersionedBranchColdGcQueueEntry {
	V1(BranchColdGcQueueEntry),
}

impl OwnedVersionedData for VersionedBranchGcMarker {
	type Latest = BranchGcMarker;

	fn wrap_latest(latest: Self::Latest) -> Self {
		Self::V1(latest)
	}

	fn unwrap_latest(self) -> Result<Self::Latest> {
		match self {
			Self::V1(marker) => Ok(marker),
		}
	}

	fn deserialize_version(payload: &[u8], version: u16) -> Result<Self> {
		match version {
			1 => Ok(Self::V1(rivet_util::serde::bare_from_slice!(payload)?)),
			_ => bail!("invalid depot BranchGcMarker version: {version}"),
		}
	}

	fn serialize_version(self, _version: u16) -> Result<Vec<u8>> {
		match self {
			Self::V1(marker) => rivet_util::serde::bare_to_vec!(&marker).map_err(Into::into),
		}
	}
}

impl OwnedVersionedData for VersionedBranchGcQueueEntry {
	type Latest = BranchGcQueueEntry;

	fn wrap_latest(latest: Self::Latest) -> Self {
		Self::V1(latest)
	}

	fn unwrap_latest(self) -> Result<Self::Latest> {
		match self {
			Self::V1(entry) => Ok(entry),
		}
	}

	fn deserialize_version(payload: &[u8], version: u16) -> Result<Self> {
		match version {
			1 => Ok(Self::V1(rivet_util::serde::bare_from_slice!(payload)?)),
			_ => bail!("invalid depot BranchGcQueueEntry version: {version}"),
		}
	}

	fn serialize_version(self, _version: u16) -> Result<Vec<u8>> {
		match self {
			Self::V1(entry) => rivet_util::serde::bare_to_vec!(&entry).map_err(Into::into),
		}
	}
}

macro_rules! impl_gc_versioned_data {
	($versioned:ident, $latest:ty, $name:literal) => {
		impl OwnedVersionedData for $versioned {
			type Latest = $latest;

			fn wrap_latest(latest: Self::Latest) -> Self {
				Self::V1(latest)
			}

			fn unwrap_latest(self) -> Result<Self::Latest> {
				match self {
					Self::V1(value) => Ok(value),
				}
			}

			fn deserialize_version(payload: &[u8], version: u16) -> Result<Self> {
				match version {
					1 => Ok(Self::V1(rivet_util::serde::bare_from_slice!(payload)?)),
					_ => bail!(concat!("invalid depot ", $name, " version: {version}")),
				}
			}

			fn serialize_version(self, _version: u16) -> Result<Vec<u8>> {
				match self {
					Self::V1(value) => rivet_util::serde::bare_to_vec!(&value).map_err(Into::into),
				}
			}
		}
	};
}

impl_gc_versioned_data!(
	VersionedColdBackupRecoveryFence,
	ColdBackupRecoveryFence,
	"ColdBackupRecoveryFence"
);
impl_gc_versioned_data!(
	VersionedBranchColdGcManifest,
	BranchColdGcManifest,
	"BranchColdGcManifest"
);
impl_gc_versioned_data!(
	VersionedBranchColdObjectTombstone,
	BranchColdObjectTombstone,
	"BranchColdObjectTombstone"
);
impl_gc_versioned_data!(
	VersionedBranchColdGcQueueEntry,
	BranchColdGcQueueEntry,
	"BranchColdGcQueueEntry"
);

pub fn encode_branch_gc_marker(marker: BranchGcMarker) -> Result<Vec<u8>> {
	VersionedBranchGcMarker::wrap_latest(marker)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite branch GC marker")
}

pub fn decode_branch_gc_marker(payload: &[u8]) -> Result<BranchGcMarker> {
	VersionedBranchGcMarker::deserialize_with_embedded_version(payload)
		.context("decode sqlite branch GC marker")
}

pub fn encode_branch_gc_queue_entry(entry: BranchGcQueueEntry) -> Result<Vec<u8>> {
	VersionedBranchGcQueueEntry::wrap_latest(entry)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite branch GC queue entry")
}

pub fn decode_branch_gc_queue_entry(payload: &[u8]) -> Result<BranchGcQueueEntry> {
	VersionedBranchGcQueueEntry::deserialize_with_embedded_version(payload)
		.context("decode sqlite branch GC queue entry")
}

macro_rules! gc_codec {
	($encode:ident, $decode:ident, $versioned:ident, $latest:ty, $context:literal) => {
		pub fn $encode(value: $latest) -> Result<Vec<u8>> {
			$versioned::wrap_latest(value)
				.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
				.context(concat!("encode ", $context))
		}

		pub fn $decode(payload: &[u8]) -> Result<$latest> {
			$versioned::deserialize_with_embedded_version(payload)
				.context(concat!("decode ", $context))
		}
	};
}

gc_codec!(
	encode_cold_backup_recovery_fence,
	decode_cold_backup_recovery_fence,
	VersionedColdBackupRecoveryFence,
	ColdBackupRecoveryFence,
	"sqlite cold backup recovery fence"
);
gc_codec!(
	encode_branch_cold_gc_manifest,
	decode_branch_cold_gc_manifest,
	VersionedBranchColdGcManifest,
	BranchColdGcManifest,
	"sqlite branch cold GC manifest"
);
gc_codec!(
	encode_branch_cold_object_tombstone,
	decode_branch_cold_object_tombstone,
	VersionedBranchColdObjectTombstone,
	BranchColdObjectTombstone,
	"sqlite branch cold object tombstone"
);
gc_codec!(
	encode_branch_cold_gc_queue_entry,
	decode_branch_cold_gc_queue_entry,
	VersionedBranchColdGcQueueEntry,
	BranchColdGcQueueEntry,
	"sqlite branch cold GC queue entry"
);
