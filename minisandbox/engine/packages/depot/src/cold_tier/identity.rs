use anyhow::{Context, Result, bail};
use rivet_config::config::{SqliteWorkflowColdStorage, SqliteWorkflowColdStorageS3AddressingStyle};
use serde::{Deserialize, Serialize};
use universaldb::utils::IsolationLevel::Serializable;
use vbare::OwnedVersionedData;

use super::COLD_SHARD_OBJECT_LAYOUT;
use crate::conveyer::{keys, types::SQLITE_STORAGE_META_VERSION};

/// Non-secret, correctness-relevant identity of the cold tier shared by every Engine connected to
/// one UniversalDB. Credentials and request concurrency are deliberately excluded so they can be
/// rotated or tuned independently.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum ColdTierIdentity {
	FileSystem {
		object_layout: String,
		root: String,
		recovery_window_ms: u64,
		max_object_size_bytes: u64,
	},
	S3 {
		object_layout: String,
		bucket: String,
		endpoint: Option<String>,
		region: String,
		force_path_style: bool,
		recovery_window_ms: u64,
		max_object_size_bytes: u64,
	},
}

enum VersionedColdTierIdentity {
	V1(ColdTierIdentity),
}

impl OwnedVersionedData for VersionedColdTierIdentity {
	type Latest = ColdTierIdentity;

	fn wrap_latest(latest: Self::Latest) -> Self {
		Self::V1(latest)
	}

	fn unwrap_latest(self) -> Result<Self::Latest> {
		match self {
			Self::V1(identity) => Ok(identity),
		}
	}

	fn deserialize_version(payload: &[u8], version: u16) -> Result<Self> {
		match version {
			1 => Ok(Self::V1(rivet_util::serde::bare_from_slice!(payload)?)),
			_ => bail!("invalid Depot cold-tier identity version: {version}"),
		}
	}

	fn serialize_version(self, _version: u16) -> Result<Vec<u8>> {
		match self {
			Self::V1(identity) => rivet_util::serde::bare_to_vec!(&identity).map_err(Into::into),
		}
	}
}

/// Installs the first enabled cold-tier identity and rejects every subsequent Engine whose
/// correctness-relevant configuration differs. Disabling an already-installed tier also fails
/// closed because FDB may contain authoritative refs to objects in that tier.
pub async fn ensure_cold_tier_identity(
	config: &rivet_config::Config,
	udb: &universaldb::Database,
) -> Result<()> {
	let configured = configured_identity(config);
	let key = keys::cold_tier_identity_key();
	udb.txn("depot_ensure_cold_tier_identity", move |tx| {
		let configured = configured.clone();
		let key = key.clone();
		async move {
			let existing = tx
				.informal()
				.get(&key, Serializable)
				.await?
				.map(|bytes| decode_identity(&bytes))
				.transpose()
				.context("decode persisted Depot cold-tier identity")?;

			match (existing, configured) {
				(None, None) => Ok(()),
				(None, Some(configured)) => {
					tx.informal().set(&key, &encode_identity(configured)?);
					Ok(())
				}
				(Some(existing), Some(configured)) if existing == configured => Ok(()),
				(Some(existing), Some(configured)) => bail!(
					"Depot cold-tier identity mismatch: FDB has {existing:?}, this Engine has {configured:?}"
				),
				(Some(existing), None) => {
					bail!("Depot cold storage cannot be disabled: FDB is bound to {existing:?}")
				}
			}
		}
	})
	.await
}

fn configured_identity(config: &rivet_config::Config) -> Option<ColdTierIdentity> {
	match config.sqlite().workflow_cold_storage()? {
		SqliteWorkflowColdStorage::FileSystem(file_system) => Some(ColdTierIdentity::FileSystem {
			object_layout: COLD_SHARD_OBJECT_LAYOUT.to_string(),
			root: file_system.root.clone(),
			recovery_window_ms: file_system.recovery_window_ms,
			max_object_size_bytes: file_system.max_object_size_bytes,
		}),
		SqliteWorkflowColdStorage::S3(s3) => Some(ColdTierIdentity::S3 {
			object_layout: COLD_SHARD_OBJECT_LAYOUT.to_string(),
			bucket: s3.bucket.clone(),
			endpoint: s3.endpoint.clone().map(normalize_endpoint),
			region: s3.region.clone(),
			force_path_style: matches!(
				s3.addressing_style,
				SqliteWorkflowColdStorageS3AddressingStyle::Path
			),
			recovery_window_ms: s3.recovery_window_ms,
			max_object_size_bytes: s3.max_object_size_bytes,
		}),
	}
}

fn normalize_endpoint(endpoint: String) -> String {
	endpoint.trim_end_matches('/').to_string()
}

fn encode_identity(identity: ColdTierIdentity) -> Result<Vec<u8>> {
	VersionedColdTierIdentity::wrap_latest(identity)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode Depot cold-tier identity")
}

fn decode_identity(payload: &[u8]) -> Result<ColdTierIdentity> {
	VersionedColdTierIdentity::deserialize_with_embedded_version(payload)
		.context("decode Depot cold-tier identity")
}
