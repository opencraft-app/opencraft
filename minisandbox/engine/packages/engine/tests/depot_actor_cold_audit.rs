#![cfg(feature = "foundationdb")]

use std::sync::Arc;

use anyhow::{Context, Result, ensure};
use depot::{
	cold_tier::{ColdTier, S3ColdTier, validate_cold_shard_object, validate_cold_shard_ref_key},
	conveyer::{branch, policy},
	keys::{
		branch_compaction_cold_publish_prefix, branch_compaction_cold_shard_prefix,
		branch_pitr_interval_prefix, branch_shard_prefix,
	},
	types::{BucketId, ShardCachePolicy, decode_cold_shard_ref},
};
use futures_util::TryStreamExt;
use gas::prelude::Id;
use serde_json::json;
use universaldb::{
	Database, RangeOption,
	driver::FoundationDbConfig,
	options::StreamingMode,
	utils::{IsolationLevel::Snapshot, end_of_prefix_range},
};

const AUDIT_PREFIX_ROW_LIMIT: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExpectedHotState {
	Any,
	Absent,
	Present,
}

impl ExpectedHotState {
	fn from_env() -> Result<Self> {
		let value = match std::env::var("RIVET_AUDIT_EXPECT_HOT") {
			Err(std::env::VarError::NotPresent) => return Ok(Self::Any),
			Err(error) => return Err(error.into()),
			Ok(value) => value,
		};
		match value.as_str() {
			"any" => Ok(Self::Any),
			"absent" => Ok(Self::Absent),
			"present" => Ok(Self::Present),
			value => anyhow::bail!(
				"RIVET_AUDIT_EXPECT_HOT must be any, absent, or present; got {value:?}"
			),
		}
	}

	fn assert(self, hot_rows: usize) -> Result<()> {
		match self {
			Self::Any => Ok(()),
			Self::Absent => {
				ensure!(hot_rows == 0, "expected the FDB hot shard to be evicted");
				Ok(())
			}
			Self::Present => {
				ensure!(
					hot_rows > 0,
					"expected a cold read to refill the FDB hot shard"
				);
				Ok(())
			}
		}
	}
}

async fn read_prefix(
	db: &Database,
	name: &'static str,
	prefix: Vec<u8>,
) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
	db.txn(name, move |tx| {
		let prefix = prefix.clone();
		async move {
			let end = end_of_prefix_range(&prefix);
			let informal = tx.informal();
			let mut stream = informal.get_ranges_keyvalues(
				RangeOption {
					limit: Some(AUDIT_PREFIX_ROW_LIMIT + 1),
					mode: StreamingMode::Exact,
					..(prefix.as_slice(), end.as_slice()).into()
				},
				Snapshot,
			);
			let mut rows = Vec::new();
			while let Some(entry) = stream.try_next().await? {
				rows.push((entry.key().to_vec(), entry.value().to_vec()));
			}
			ensure!(
				rows.len() <= AUDIT_PREFIX_ROW_LIMIT,
				"{name} exceeded the bounded branch-local audit limit"
			);
			Ok(rows)
		}
	})
	.await
}

/// Opt-in production-cell audit. This never lists COS and never scans a global FDB prefix: the
/// actor is resolved to one database branch first, then every read is branch-local and bounded.
#[tokio::test]
async fn foundationdb_actor_cold_state_uses_exact_cos_keys() -> Result<()> {
	if std::env::var("RIVET_AUDIT_ACTOR_COLD").as_deref() != Ok("1") {
		return Ok(());
	}

	let actor_id_text = std::env::var("RIVET_AUDIT_ACTOR_ID")?;
	let actor_id: Id = actor_id_text
		.parse()
		.context("parse RIVET_AUDIT_ACTOR_ID")?;
	let cluster_file = std::env::var_os("FDB_CLUSTER_FILE").map(Into::into);
	let driver =
		universaldb::driver::FoundationDbDatabaseDriver::new(FoundationDbConfig { cluster_file })?;
	let db = Database::new(Arc::new(driver));
	db.txn_retry_limit(10)?;

	let namespace_id = db
		.txn("audit_actor_namespace", |tx| async move {
			let tx = tx.with_subspace(pegboard::keys::subspace());
			tx.read_opt(
				&pegboard::keys::actor::NamespaceIdKey::new(actor_id),
				Snapshot,
			)
			.await?
			.with_context(|| format!("namespace missing for actor {actor_id}"))
		})
		.await?;
	let database_id = actor_id.to_string();
	let cache_retention_ms = std::env::var("RIVET_AUDIT_SET_CACHE_RETENTION_MS")
		.ok()
		.map(|value| {
			value
				.parse::<i64>()
				.context("parse RIVET_AUDIT_SET_CACHE_RETENTION_MS")
		})
		.transpose()?;
	if let Some(retention_ms) = cache_retention_ms {
		policy::set_database_shard_cache_policy_override(
			&db,
			BucketId::from_gas_id(namespace_id),
			&database_id,
			ShardCachePolicy { retention_ms },
		)
		.await?;
	}
	let branch_id = db
		.txn("audit_actor_branch", |tx| {
			let database_id = database_id.clone();
			async move {
				branch::resolve_database_branch(
					&tx,
					BucketId::from_gas_id(namespace_id),
					&database_id,
					Snapshot,
				)
				.await?
				.context("actor database branch is missing")
			}
		})
		.await?;

	let cold_rows = read_prefix(
		&db,
		"audit_actor_cold_refs",
		branch_compaction_cold_shard_prefix(branch_id),
	)
	.await?;
	let publish_rows = read_prefix(
		&db,
		"audit_actor_cold_publish",
		branch_compaction_cold_publish_prefix(branch_id),
	)
	.await?;
	let hot_rows = read_prefix(
		&db,
		"audit_actor_hot_shards",
		branch_shard_prefix(branch_id),
	)
	.await?;
	let pitr_rows = read_prefix(
		&db,
		"audit_actor_pitr_intervals",
		branch_pitr_interval_prefix(branch_id),
	)
	.await?;
	ensure!(
		!cold_rows.is_empty(),
		"actor has no published cold shard refs"
	);
	ensure!(
		!publish_rows.is_empty(),
		"actor cold refs have no atomic publish marker"
	);
	ensure!(
		!pitr_rows.is_empty(),
		"actor compaction has no PITR interval proof"
	);
	let expected_hot = ExpectedHotState::from_env()?;
	expected_hot.assert(hot_rows.len())?;

	let bucket = std::env::var("RIVET_TEST_S3_BUCKET")?;
	let endpoint = std::env::var("RIVET_TEST_S3_ENDPOINT")?;
	let region = std::env::var("RIVET_TEST_S3_REGION")?;
	let cold_tier = S3ColdTier::from_env(
		bucket.clone(),
		Some(endpoint.clone()),
		region.clone(),
		false,
		4 * 1024 * 1024,
		4,
	)
	.await?;
	let mut refs = Vec::with_capacity(cold_rows.len());
	for (_, encoded) in cold_rows {
		let reference = decode_cold_shard_ref(&encoded)?;
		validate_cold_shard_ref_key(&reference)?;
		let metadata = cold_tier.head_object(&reference.object_key).await?;
		ensure!(
			metadata.size_bytes == reference.size_bytes,
			"COS HEAD size does not match the authoritative FDB ref"
		);
		let bytes = cold_tier.get_object(&reference.object_key).await?;
		validate_cold_shard_object(&reference, &bytes)?;
		refs.push(json!({
			"object_key": reference.object_key,
			"size_bytes": reference.size_bytes,
			"content_sha256": hex::encode(reference.content_hash),
			"shard_id": reference.shard_id,
			"as_of_txid": reference.as_of_txid,
			"publish_generation": reference.publish_generation,
			"cos_etag": metadata.etag,
		}));
	}

	println!(
		"RIVET_ACTOR_COLD_AUDIT {}",
		serde_json::to_string(&json!({
			"actor_id": actor_id_text,
			"database_branch_id": branch_id.as_uuid(),
			"bucket": bucket,
			"endpoint": endpoint,
			"region": region,
			"cold_ref_count": refs.len(),
			"cold_publish_marker_count": publish_rows.len(),
			"hot_shard_row_count": hot_rows.len(),
			"pitr_interval_row_count": pitr_rows.len(),
			"expected_hot_state": format!("{expected_hot:?}").to_lowercase(),
			"configured_cache_retention_ms": cache_retention_ms,
			"refs": refs,
		}))?
	);

	Ok(())
}
