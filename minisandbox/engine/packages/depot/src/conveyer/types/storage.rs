use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use vbare::OwnedVersionedData;

use super::ids::DatabaseBranchId;
use super::serialization::SQLITE_STORAGE_META_VERSION;

const HOT_SHARD_MANIFEST_MAGIC: &[u8] = b"rivet.depot.hot_shard_manifest.v1\0";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchManifest {
	pub cold_drained_txid: u64,
	pub last_hot_pass_txid: u64,
	pub last_access_ts_ms: i64,
	pub last_access_bucket: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitRow {
	pub wall_clock_ms: i64,
	pub versionstamp: [u8; 16],
	pub db_size_pages: u32,
	pub post_apply_checksum: u64,
}

/// O(1) per-branch idempotency proof for the latest successful logical SQLite commit.
///
/// FoundationDB can report `commit_unknown_result` after the transaction became durable. Retrying
/// the UniversalDB closure must recognize that exact commit rather than allocate another TXID.
/// The same proof also makes duplicate delivery of one Envoy request safe while actor lifecycle
/// keeps commits serialized.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitAttemptProof {
	pub attempt_id: [u8; 16],
	pub request_hash: [u8; 32],
	pub txid: u64,
	pub db_size_pages: u32,
	pub deltas_available_at_ms: Option<i64>,
	pub reset_pidx_cache: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DBHead {
	pub head_txid: u64,
	pub db_size_pages: u32,
	pub post_apply_checksum: u64,
	pub branch_id: DatabaseBranchId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetaCompact {
	pub materialized_txid: u64,
}

/// Indirection stored in the canonical SHARD row when the LTX blob is too large for one FDB
/// value. Legacy rows continue to contain the LTX bytes directly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HotShardManifest {
	pub shard_id: u32,
	pub as_of_txid: u64,
	pub chunk_count: u32,
	pub encoded_len: u64,
	pub content_hash: [u8; 32],
}

enum VersionedDBHead {
	V1(DBHead),
}

impl OwnedVersionedData for VersionedDBHead {
	type Latest = DBHead;

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
			_ => bail!("invalid depot DBHead version: {version}"),
		}
	}

	fn serialize_version(self, _version: u16) -> Result<Vec<u8>> {
		match self {
			Self::V1(data) => rivet_util::serde::bare_to_vec!(&data).map_err(Into::into),
		}
	}
}

enum VersionedCommitRow {
	V1(CommitRow),
}

enum VersionedCommitAttemptProof {
	V1(CommitAttemptProof),
}

impl OwnedVersionedData for VersionedCommitRow {
	type Latest = CommitRow;

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
			_ => bail!("invalid depot CommitRow version: {version}"),
		}
	}

	fn serialize_version(self, _version: u16) -> Result<Vec<u8>> {
		match self {
			Self::V1(data) => rivet_util::serde::bare_to_vec!(&data).map_err(Into::into),
		}
	}
}

impl OwnedVersionedData for VersionedCommitAttemptProof {
	type Latest = CommitAttemptProof;

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
			_ => bail!("invalid depot CommitAttemptProof version: {version}"),
		}
	}

	fn serialize_version(self, _version: u16) -> Result<Vec<u8>> {
		match self {
			Self::V1(data) => rivet_util::serde::bare_to_vec!(&data).map_err(Into::into),
		}
	}
}

enum VersionedMetaCompact {
	V1(MetaCompact),
}

enum VersionedHotShardManifest {
	V1(HotShardManifest),
}

impl OwnedVersionedData for VersionedHotShardManifest {
	type Latest = HotShardManifest;

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
			_ => bail!("invalid depot HotShardManifest version: {version}"),
		}
	}

	fn serialize_version(self, _version: u16) -> Result<Vec<u8>> {
		match self {
			Self::V1(data) => rivet_util::serde::bare_to_vec!(&data).map_err(Into::into),
		}
	}
}

impl OwnedVersionedData for VersionedMetaCompact {
	type Latest = MetaCompact;

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
			_ => bail!("invalid depot MetaCompact version: {version}"),
		}
	}

	fn serialize_version(self, _version: u16) -> Result<Vec<u8>> {
		match self {
			Self::V1(data) => rivet_util::serde::bare_to_vec!(&data).map_err(Into::into),
		}
	}
}

pub fn encode_db_head(head: DBHead) -> Result<Vec<u8>> {
	VersionedDBHead::wrap_latest(head)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite db head")
}

pub fn decode_db_head(payload: &[u8]) -> Result<DBHead> {
	VersionedDBHead::deserialize_with_embedded_version(payload).context("decode sqlite db head")
}

pub fn encode_commit_row(row: CommitRow) -> Result<Vec<u8>> {
	VersionedCommitRow::wrap_latest(row)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite commit row")
}

pub fn decode_commit_row(payload: &[u8]) -> Result<CommitRow> {
	VersionedCommitRow::deserialize_with_embedded_version(payload)
		.context("decode sqlite commit row")
}

pub fn encode_commit_attempt_proof(proof: CommitAttemptProof) -> Result<Vec<u8>> {
	VersionedCommitAttemptProof::wrap_latest(proof)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite commit attempt proof")
}

pub fn decode_commit_attempt_proof(payload: &[u8]) -> Result<CommitAttemptProof> {
	VersionedCommitAttemptProof::deserialize_with_embedded_version(payload)
		.context("decode sqlite commit attempt proof")
}

pub fn encode_meta_compact(compact: MetaCompact) -> Result<Vec<u8>> {
	VersionedMetaCompact::wrap_latest(compact)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode sqlite compact meta")
}

pub fn decode_meta_compact(payload: &[u8]) -> Result<MetaCompact> {
	VersionedMetaCompact::deserialize_with_embedded_version(payload)
		.context("decode sqlite compact meta")
}

pub fn encode_hot_shard_manifest(manifest: HotShardManifest) -> Result<Vec<u8>> {
	let mut bytes = HOT_SHARD_MANIFEST_MAGIC.to_vec();
	bytes.extend(
		VersionedHotShardManifest::wrap_latest(manifest)
			.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
			.context("encode sqlite hot shard manifest")?,
	);
	Ok(bytes)
}

pub fn decode_hot_shard_manifest(payload: &[u8]) -> Result<HotShardManifest> {
	let payload = payload
		.strip_prefix(HOT_SHARD_MANIFEST_MAGIC)
		.context("sqlite hot shard value is not a manifest")?;
	VersionedHotShardManifest::deserialize_with_embedded_version(payload)
		.context("decode sqlite hot shard manifest")
}
