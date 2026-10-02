use anyhow::{Context, Result, ensure};
use futures_util::{StreamExt, TryStreamExt};
use sha2::{Digest, Sha256};
use universaldb::{
	RangeOption,
	options::{MutationType, StreamingMode},
	utils::IsolationLevel,
};

use super::{
	keys,
	types::{
		BucketBranchId, DatabaseBranchId, DbHistoryPin, DbHistoryPinKind, RestorePointId,
		decode_db_history_pin, encode_db_history_pin,
	},
};

const DB_HISTORY_PIN_COUNT_SHARDS: u8 = 64;

pub fn database_fork_pin_id(owner_database_branch_id: DatabaseBranchId) -> Vec<u8> {
	let mut pin_id = b"database_fork/".to_vec();
	pin_id.extend_from_slice(owner_database_branch_id.as_uuid().as_bytes());
	pin_id
}

pub fn restore_point_pin_id(restore_point: &RestorePointId) -> Vec<u8> {
	let mut pin_id = b"restore_point/".to_vec();
	pin_id.extend_from_slice(restore_point.as_str().as_bytes());
	pin_id
}

pub fn bucket_fork_pin_id(owner_bucket_branch_id: BucketBranchId) -> Vec<u8> {
	let mut pin_id = b"bucket_fork/".to_vec();
	pin_id.extend_from_slice(owner_bucket_branch_id.as_uuid().as_bytes());
	pin_id
}

pub async fn write_database_fork_pin(
	tx: &universaldb::Transaction,
	source_branch_id: DatabaseBranchId,
	owner_database_branch_id: DatabaseBranchId,
	at_versionstamp: [u8; 16],
	at_txid: u64,
	created_at_ms: i64,
) -> Result<()> {
	write_db_history_pin(
		tx,
		source_branch_id,
		&database_fork_pin_id(owner_database_branch_id),
		DbHistoryPin {
			at_versionstamp,
			at_txid,
			kind: DbHistoryPinKind::DatabaseFork,
			owner_database_branch_id: Some(owner_database_branch_id),
			owner_bucket_branch_id: None,
			owner_restore_point: None,
			created_at_ms,
		},
	)
	.await
}

pub async fn write_restore_point_pin(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	restore_point: RestorePointId,
	at_versionstamp: [u8; 16],
	at_txid: u64,
	created_at_ms: i64,
) -> Result<()> {
	write_db_history_pin(
		tx,
		branch_id,
		&restore_point_pin_id(&restore_point),
		DbHistoryPin {
			at_versionstamp,
			at_txid,
			kind: DbHistoryPinKind::RestorePoint,
			owner_database_branch_id: None,
			owner_bucket_branch_id: None,
			owner_restore_point: Some(restore_point),
			created_at_ms,
		},
	)
	.await
}

pub async fn write_bucket_fork_pin(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	owner_bucket_branch_id: BucketBranchId,
	at_versionstamp: [u8; 16],
	at_txid: u64,
	created_at_ms: i64,
) -> Result<()> {
	write_db_history_pin(
		tx,
		branch_id,
		&bucket_fork_pin_id(owner_bucket_branch_id),
		DbHistoryPin {
			at_versionstamp,
			at_txid,
			kind: DbHistoryPinKind::BucketFork,
			owner_database_branch_id: None,
			owner_bucket_branch_id: Some(owner_bucket_branch_id),
			owner_restore_point: None,
			created_at_ms,
		},
	)
	.await
}

pub async fn write_db_history_pin(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	pin_id: &[u8],
	pin: DbHistoryPin,
) -> Result<()> {
	if tx
		.informal()
		.get(
			&keys::branch_gc_deleting_key(branch_id),
			IsolationLevel::Serializable,
		)
		.await?
		.is_some()
	{
		return Err(crate::conveyer::error::SqliteStorageError::BranchNotWritable.into());
	}
	let primary_key = keys::db_pin_key(branch_id, pin_id);
	let previous = tx
		.informal()
		.get(&primary_key, IsolationLevel::Serializable)
		.await?
		.map(|value| decode_db_history_pin(&value))
		.transpose()
		.context("decode previous sqlite db history pin")?;
	if let Some(previous) = previous.as_ref() {
		let previous_index_key = keys::db_pin_by_txid_key(branch_id, previous.at_txid, pin_id);
		if previous.at_txid != pin.at_txid
			&& tx
				.informal()
				.get(&previous_index_key, IsolationLevel::Serializable)
				.await?
				.is_some()
		{
			adjust_indexed_pin_count(tx, branch_id, pin_id, -1);
			update_txid_presence_before_index_delete(
				tx,
				branch_id,
				previous.at_txid,
				&previous_index_key,
			)
			.await?;
			tx.informal().clear(&previous_index_key);
		}
	}

	let encoded = encode_db_history_pin(pin.clone()).context("encode sqlite db history pin")?;
	tx.informal().set(&primary_key, &encoded);
	let index_key = keys::db_pin_by_txid_key(branch_id, pin.at_txid, pin_id);
	if tx
		.informal()
		.get(&index_key, IsolationLevel::Serializable)
		.await?
		.is_none()
	{
		tx.informal().set(&index_key, &[]);
		adjust_indexed_pin_count(tx, branch_id, pin_id, 1);
	}
	// This is a blind idempotent write. Thousands of concurrent pins at one popular snapshot do
	// not serialize through a read-modify-write counter. The last deleter proves the exact
	// by-txid range empty before clearing it.
	tx.informal()
		.set(&keys::db_pin_txid_count_key(branch_id, pin.at_txid), &[]);

	Ok(())
}

pub async fn delete_restore_point_pin(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	restore_point: &RestorePointId,
) -> Result<()> {
	delete_db_history_pin(tx, branch_id, &restore_point_pin_id(restore_point)).await
}

pub async fn delete_db_history_pin(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	pin_id: &[u8],
) -> Result<()> {
	let primary_key = keys::db_pin_key(branch_id, pin_id);
	let Some(primary_value) = tx
		.informal()
		.get(&primary_key, IsolationLevel::Serializable)
		.await?
	else {
		return Ok(());
	};
	let pin = decode_db_history_pin(&primary_value)
		.context("decode sqlite db history pin before deletion")?;
	let index_key = keys::db_pin_by_txid_key(branch_id, pin.at_txid, pin_id);
	if tx
		.informal()
		.get(&index_key, IsolationLevel::Serializable)
		.await?
		.is_some()
	{
		adjust_indexed_pin_count(tx, branch_id, pin_id, -1);
		update_txid_presence_before_index_delete(tx, branch_id, pin.at_txid, &index_key).await?;
		tx.informal().clear(&index_key);
	}
	tx.informal().clear(&primary_key);
	crate::gc::expedite_branch_gc_if_queued_tx(tx, branch_id, rivet_util::timestamp::now()).await?;
	Ok(())
}

fn adjust_indexed_pin_count(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	pin_id: &[u8],
	delta: i64,
) {
	let shard = Sha256::digest(pin_id)[0] % DB_HISTORY_PIN_COUNT_SHARDS;
	tx.informal().atomic_op(
		&keys::branch_history_pin_count_shard_key(branch_id, shard),
		&delta.to_le_bytes(),
		MutationType::Add,
	);
}

async fn update_txid_presence_before_index_delete(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	at_txid: u64,
	removed_index_key: &[u8],
) -> Result<()> {
	let prefix = keys::db_pin_by_txid_key(branch_id, at_txid, b"");
	let end = universaldb::utils::end_of_prefix_range(&prefix);
	let presence_key = keys::db_pin_txid_count_key(branch_id, at_txid);
	// Deletions at one txid must agree which one is last. Read and then rewrite/clear the presence
	// row so concurrent deleters conflict and retry. Creators still issue only a blind presence set;
	// that write conflicts with this read and prevents a concurrent create from being lost.
	let _observed_presence = tx
		.informal()
		.get(&presence_key, IsolationLevel::Serializable)
		.await?;
	let rows =
		read_range_values_limited(tx, &prefix, &end, 2, IsolationLevel::Serializable).await?;
	let has_other = rows
		.iter()
		.any(|(key, _)| key.as_slice() != removed_index_key);
	if has_other {
		tx.informal().set(&presence_key, &[]);
	} else {
		tx.informal().clear(&presence_key);
	}
	Ok(())
}

fn decode_i64_count(value: &[u8], label: &str) -> Result<i64> {
	ensure!(value.len() == 8, "{label} has invalid encoded length");
	Ok(i64::from_le_bytes(
		value.try_into().context("decode history pin count")?,
	))
}

pub async fn read_indexed_pin_count(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	isolation_level: IsolationLevel,
) -> Result<usize> {
	let shard_prefix = keys::branch_history_pin_count_shard_prefix(branch_id);
	let shard_rows = read_range_values_limited(
		tx,
		&shard_prefix,
		&universaldb::utils::end_of_prefix_range(&shard_prefix),
		usize::from(DB_HISTORY_PIN_COUNT_SHARDS).saturating_add(1),
		isolation_level,
	)
	.await?;
	ensure!(
		shard_rows.len() <= usize::from(DB_HISTORY_PIN_COUNT_SHARDS),
		"history pin count shard index exceeded its fixed cardinality"
	);
	let mut count = 0_i64;
	for (key, value) in shard_rows {
		let shard = keys::decode_branch_history_pin_count_shard_key(branch_id, &key)?;
		ensure!(
			shard < DB_HISTORY_PIN_COUNT_SHARDS,
			"history pin count shard is outside configured range"
		);
		count = count
			.checked_add(decode_i64_count(&value, "history pin count shard")?)
			.context("history pin total count overflow")?;
	}
	ensure!(count >= 0, "history pin total count became negative");
	Ok(usize::try_from(count).unwrap_or(usize::MAX))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryPinTxidPage {
	pub txids: Vec<u64>,
	pub has_more: bool,
}

pub async fn read_history_pin_txids_page(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	min_txid: u64,
	max_txid: u64,
	limit: usize,
	isolation_level: IsolationLevel,
) -> Result<HistoryPinTxidPage> {
	if min_txid > max_txid || limit == 0 {
		return Ok(HistoryPinTxidPage {
			txids: Vec::new(),
			has_more: false,
		});
	}
	let start = keys::db_pin_txid_count_key(branch_id, min_txid);
	let end = max_txid
		.checked_add(1)
		.map(|txid| keys::db_pin_txid_count_key(branch_id, txid))
		.unwrap_or_else(|| {
			universaldb::utils::end_of_prefix_range(&keys::db_pin_txid_count_prefix(branch_id))
		});
	let mut rows =
		read_range_values_limited(tx, &start, &end, limit.saturating_add(1), isolation_level)
			.await?;
	let has_more = rows.len() > limit;
	if has_more {
		rows.pop();
	}
	let txids = rows
		.into_iter()
		.map(|(key, _value)| {
			let txid = keys::decode_db_pin_txid_count_key(branch_id, &key)?;
			Ok(txid)
		})
		.collect::<Result<Vec<_>>>()?;
	Ok(HistoryPinTxidPage { txids, has_more })
}

pub async fn read_earliest_history_pin_txid_at_or_before(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	max_txid: u64,
	isolation_level: IsolationLevel,
) -> Result<Option<u64>> {
	let page = read_history_pin_txids_page(tx, branch_id, 0, max_txid, 1, isolation_level).await?;
	Ok(page.txids.into_iter().next())
}

/// Returns one boolean per input range. Each range is `[start, end)` and uses a server-side
/// `limit=1`, so millions of pins in one interval cost the same as one pin.
pub async fn history_pin_presence_in_ranges(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	ranges: &[(u64, u64)],
	isolation_level: IsolationLevel,
) -> Result<Vec<bool>> {
	let presence = futures_util::stream::iter(ranges.iter().copied())
		.map(|(start_txid, end_txid)| async move {
			if start_txid >= end_txid {
				return Ok::<_, anyhow::Error>(false);
			}
			let start = keys::db_pin_txid_count_key(branch_id, start_txid);
			let end = keys::db_pin_txid_count_key(branch_id, end_txid);
			let rows = read_range_values_limited(tx, &start, &end, 1, isolation_level).await?;
			let Some((key, _value)) = rows.into_iter().next() else {
				return Ok(false);
			};
			let txid = keys::decode_db_pin_txid_count_key(branch_id, &key)?;
			ensure!(
				txid >= start_txid && txid < end_txid,
				"history pin range index returned an invalid row"
			);
			Ok(true)
		})
		.buffer_unordered(32)
		.try_collect::<Vec<_>>()
		.await?;
	Ok(presence)
}

async fn read_range_values_limited(
	tx: &universaldb::Transaction,
	start: &[u8],
	end: &[u8],
	limit: usize,
	isolation_level: IsolationLevel,
) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Exact,
			limit: Some(limit),
			..(start, end).into()
		},
		isolation_level,
	);
	let mut rows = Vec::new();
	while let Some(entry) = stream.try_next().await? {
		rows.push((entry.key().to_vec(), entry.value().to_vec()));
	}
	Ok(rows)
}
