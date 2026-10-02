use anyhow::{Context, Result, ensure};
use universaldb::utils::IsolationLevel::{Serializable, Snapshot};

use super::{
	error::SqliteStorageError,
	keys,
	types::{
		BucketId, DatabaseBranchId, DatabasePolicyBinding, PitrPolicy, ShardCachePolicy,
		decode_database_policy_binding, decode_pitr_policy, decode_shard_cache_policy,
		encode_database_policy_binding, encode_pitr_policy, encode_shard_cache_policy,
	},
};

/// Read replicas for a bucket-wide default policy. Policy changes are rare and update every
/// replica atomically; compaction reads select one replica from the physical branch UUID.
pub const BUCKET_PITR_POLICY_READ_SHARDS: u16 = 256;

pub async fn set_bucket_pitr_policy(
	udb: &universaldb::Database,
	bucket_id: BucketId,
	policy: PitrPolicy,
) -> Result<()> {
	validate_pitr_policy(policy)?;
	let encoded = encode_pitr_policy(policy).context("encode sqlite bucket pitr policy")?;
	let key = keys::bucket_policy_pitr_key(bucket_id);

	udb.txn("depot_policy_write", move |tx| {
		let key = key.clone();
		let encoded = encoded.clone();

		async move {
			tx.informal().set(&key, &encoded);
			for shard in 0..BUCKET_PITR_POLICY_READ_SHARDS {
				tx.informal().set(
					&keys::bucket_policy_pitr_shard_key(bucket_id, shard as u8),
					&encoded,
				);
			}
			Ok(())
		}
	})
	.await
}

pub(crate) fn bucket_pitr_policy_read_shard(branch_id: DatabaseBranchId) -> u8 {
	branch_id.as_uuid().as_bytes()[0]
}

/// Writes the immutable branch -> logical policy namespace reverse index in the same transaction
/// that creates the branch and its forward pointer.
pub(crate) async fn write_database_policy_binding(
	tx: &universaldb::Transaction,
	binding: DatabasePolicyBinding,
) -> Result<()> {
	let key = keys::database_policy_binding_key(binding.database_branch_id);
	if let Some(existing) = tx.informal().get(&key, Serializable).await? {
		let existing = decode_database_policy_binding(&existing)
			.context("decode existing sqlite database policy binding")?;
		ensure!(
			existing == binding,
			"attempted to rebind sqlite database branch {} from bucket {} database {:?} to bucket {} database {:?}",
			binding.database_branch_id.as_uuid(),
			existing.bucket_id.as_uuid(),
			existing.database_id,
			binding.bucket_id.as_uuid(),
			binding.database_id,
		);
		return Ok(());
	}

	let encoded =
		encode_database_policy_binding(binding).context("encode sqlite database policy binding")?;
	tx.informal().set(&key, &encoded);
	Ok(())
}

pub async fn get_bucket_pitr_policy(
	udb: &universaldb::Database,
	bucket_id: BucketId,
) -> Result<PitrPolicy> {
	let key = keys::bucket_policy_pitr_key(bucket_id);

	Ok(read_pitr_policy(udb, key).await?.unwrap_or_default())
}

pub async fn set_database_pitr_policy_override(
	udb: &universaldb::Database,
	bucket_id: BucketId,
	database_id: &str,
	policy: PitrPolicy,
) -> Result<()> {
	validate_pitr_policy(policy)?;
	let encoded = encode_pitr_policy(policy).context("encode sqlite database pitr policy")?;
	let key = keys::database_pitr_policy_key(bucket_id, database_id);

	set_policy_value(udb, key, encoded).await
}

pub async fn get_database_pitr_policy_override(
	udb: &universaldb::Database,
	bucket_id: BucketId,
	database_id: &str,
) -> Result<Option<PitrPolicy>> {
	read_pitr_policy(udb, keys::database_pitr_policy_key(bucket_id, database_id)).await
}

pub async fn clear_database_pitr_policy_override(
	udb: &universaldb::Database,
	bucket_id: BucketId,
	database_id: &str,
) -> Result<()> {
	clear_policy_value(udb, keys::database_pitr_policy_key(bucket_id, database_id)).await
}

pub async fn get_effective_pitr_policy(
	udb: &universaldb::Database,
	bucket_id: BucketId,
	database_id: &str,
) -> Result<PitrPolicy> {
	if let Some(policy) = get_database_pitr_policy_override(udb, bucket_id, database_id).await? {
		return Ok(policy);
	}

	get_bucket_pitr_policy(udb, bucket_id).await
}

pub async fn set_bucket_shard_cache_policy(
	udb: &universaldb::Database,
	bucket_id: BucketId,
	policy: ShardCachePolicy,
) -> Result<()> {
	validate_shard_cache_policy(policy)?;
	let encoded =
		encode_shard_cache_policy(policy).context("encode sqlite bucket shard cache policy")?;
	let key = keys::bucket_policy_shard_cache_key(bucket_id);

	set_policy_value(udb, key, encoded).await
}

pub async fn get_bucket_shard_cache_policy(
	udb: &universaldb::Database,
	bucket_id: BucketId,
) -> Result<ShardCachePolicy> {
	let key = keys::bucket_policy_shard_cache_key(bucket_id);

	Ok(read_shard_cache_policy(udb, key).await?.unwrap_or_default())
}

pub async fn set_database_shard_cache_policy_override(
	udb: &universaldb::Database,
	bucket_id: BucketId,
	database_id: &str,
	policy: ShardCachePolicy,
) -> Result<()> {
	validate_shard_cache_policy(policy)?;
	let encoded =
		encode_shard_cache_policy(policy).context("encode sqlite database shard cache policy")?;
	let key = keys::database_shard_cache_policy_key(bucket_id, database_id);

	set_policy_value(udb, key, encoded).await
}

pub async fn get_database_shard_cache_policy_override(
	udb: &universaldb::Database,
	bucket_id: BucketId,
	database_id: &str,
) -> Result<Option<ShardCachePolicy>> {
	read_shard_cache_policy(
		udb,
		keys::database_shard_cache_policy_key(bucket_id, database_id),
	)
	.await
}

pub async fn clear_database_shard_cache_policy_override(
	udb: &universaldb::Database,
	bucket_id: BucketId,
	database_id: &str,
) -> Result<()> {
	clear_policy_value(
		udb,
		keys::database_shard_cache_policy_key(bucket_id, database_id),
	)
	.await
}

pub async fn get_effective_shard_cache_policy(
	udb: &universaldb::Database,
	bucket_id: BucketId,
	database_id: &str,
) -> Result<ShardCachePolicy> {
	if let Some(policy) =
		get_database_shard_cache_policy_override(udb, bucket_id, database_id).await?
	{
		return Ok(policy);
	}

	get_bucket_shard_cache_policy(udb, bucket_id).await
}

fn validate_pitr_policy(policy: PitrPolicy) -> Result<()> {
	ensure_positive("pitr", "interval_ms", policy.interval_ms)?;
	ensure_positive("pitr", "retention_ms", policy.retention_ms)
}

fn validate_shard_cache_policy(policy: ShardCachePolicy) -> Result<()> {
	ensure_positive("shard_cache", "retention_ms", policy.retention_ms)
}

fn ensure_positive(policy: &'static str, field: &'static str, value: i64) -> Result<()> {
	if value <= 0 {
		return Err(SqliteStorageError::InvalidPolicyValue {
			policy,
			field,
			value,
		}
		.into());
	}

	Ok(())
}

async fn set_policy_value(
	udb: &universaldb::Database,
	key: Vec<u8>,
	encoded: Vec<u8>,
) -> Result<()> {
	udb.txn("depot_policy_write", move |tx| {
		let key = key.clone();
		let encoded = encoded.clone();

		async move {
			tx.informal().set(&key, &encoded);
			Ok(())
		}
	})
	.await
}

async fn clear_policy_value(udb: &universaldb::Database, key: Vec<u8>) -> Result<()> {
	udb.txn("depot_policy_write", move |tx| {
		let key = key.clone();

		async move {
			tx.informal().clear(&key);
			Ok(())
		}
	})
	.await
}

async fn read_pitr_policy(udb: &universaldb::Database, key: Vec<u8>) -> Result<Option<PitrPolicy>> {
	udb.txn("depot_policy_read", move |tx| {
		let key = key.clone();

		async move {
			tx.informal()
				.get(&key, Snapshot)
				.await?
				.map(|bytes| decode_pitr_policy(&bytes).context("decode sqlite pitr policy"))
				.transpose()
		}
	})
	.await
}

async fn read_shard_cache_policy(
	udb: &universaldb::Database,
	key: Vec<u8>,
) -> Result<Option<ShardCachePolicy>> {
	udb.txn("depot_policy_read", move |tx| {
		let key = key.clone();

		async move {
			tx.informal()
				.get(&key, Snapshot)
				.await?
				.map(|bytes| {
					decode_shard_cache_policy(&bytes).context("decode sqlite shard cache policy")
				})
				.transpose()
		}
	})
	.await
}
