use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, ensure};
use futures_util::TryStreamExt;
use universaldb::{RangeOption, options::StreamingMode, utils::IsolationLevel::Serializable};

use crate::conveyer::{
	constants::MAX_FORK_DEPTH,
	error::SqliteStorageError,
	keys,
	types::{
		BucketBranchId, BucketBranchRecord, CommitRow, DBHead, DatabaseBranchId,
		DatabaseBranchRecord, decode_bucket_branch_record, decode_commit_row,
		decode_database_branch_record, decode_db_head,
	},
};

pub(super) fn decode_versionstamp_value(bytes: &[u8]) -> Result<[u8; 16]> {
	bytes
		.try_into()
		.context("sqlite versionstamp value should be exactly 16 bytes")
}

pub(in crate::conveyer) async fn read_database_branch_record(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
) -> Result<DatabaseBranchRecord> {
	let bytes = tx
		.informal()
		.get(&keys::branches_list_key(branch_id), Serializable)
		.await?
		.context("sqlite database branch record is missing")?;

	decode_database_branch_record(&bytes).context("decode sqlite database branch record")
}

pub(super) async fn read_bucket_branch_record(
	tx: &universaldb::Transaction,
	branch_id: BucketBranchId,
) -> Result<BucketBranchRecord> {
	let bytes = tx
		.informal()
		.get(&keys::bucket_branches_list_key(branch_id), Serializable)
		.await?
		.context("sqlite bucket branch record is missing")?;

	decode_bucket_branch_record(&bytes).context("decode sqlite bucket branch record")
}

pub(super) async fn read_versionstamp_pin(
	tx: &universaldb::Transaction,
	key: &[u8],
) -> Result<[u8; 16]> {
	let Some(bytes) = tx.informal().get(key, Serializable).await? else {
		return Ok([0; 16]);
	};
	let bytes = Vec::<u8>::from(bytes);
	bytes
		.as_slice()
		.try_into()
		.context("sqlite branch pin should be exactly 16 bytes")
}

pub(in crate::conveyer) async fn lookup_txid_at_versionstamp(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	versionstamp: [u8; 16],
) -> Result<u64> {
	let bytes = tx
		.informal()
		.get(&keys::branch_vtx_key(branch_id, versionstamp), Serializable)
		.await?;
	let Some(bytes) = bytes else {
		if let Some((_, fork_stamp, head)) = read_virtual_head(tx, branch_id).await?
			&& fork_stamp == versionstamp
		{
			return Ok(head.head_txid);
		}
		return Err(SqliteStorageError::RestoreTargetExpired.into());
	};
	let bytes = Vec::<u8>::from(bytes);
	let bytes: [u8; 8] = bytes
		.as_slice()
		.try_into()
		.context("sqlite VTX entry should be exactly 8 bytes")?;

	Ok(u64::from_be_bytes(bytes))
}

pub(in crate::conveyer) async fn read_commit_row(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	txid: u64,
) -> Result<CommitRow> {
	let mut current = branch_id;
	let mut cap = [0xff; 16];
	let mut expected_heads: Vec<DBHead> = Vec::new();
	for depth in 0..=MAX_FORK_DEPTH {
		if let Some(bytes) = tx
			.informal()
			.get(&keys::branch_commit_key(current, txid), Serializable)
			.await?
		{
			let commit = decode_commit_row(&bytes).context("decode sqlite commit row")?;
			ensure!(
				commit.versionstamp <= cap,
				"inherited commit exceeded its fork cap"
			);
			for head in expected_heads {
				ensure!(
					head.db_size_pages == commit.db_size_pages
						&& head.post_apply_checksum == commit.post_apply_checksum,
					"virtual sqlite fork head did not match its inherited commit"
				);
			}
			return Ok(commit);
		}
		let Some((parent, fork_stamp, head)) = read_virtual_head(tx, current).await? else {
			return Err(SqliteStorageError::RestoreTargetExpired.into());
		};
		ensure!(
			head.head_txid == txid,
			"missing local commit is not the virtual fork head"
		);
		if depth == MAX_FORK_DEPTH {
			return Err(SqliteStorageError::ForkChainTooDeep.into());
		}
		cap = cap.min(fork_stamp);
		expected_heads.push(head);
		current = parent;
	}
	Err(SqliteStorageError::ForkChainTooDeep.into())
}

async fn read_virtual_head(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
) -> Result<Option<(DatabaseBranchId, [u8; 16], DBHead)>> {
	let Some(bytes) = tx
		.informal()
		.get(&keys::branch_meta_head_at_fork_key(branch_id), Serializable)
		.await?
	else {
		return Ok(None);
	};
	let head = decode_db_head(&bytes)?;
	ensure!(
		head.branch_id == branch_id,
		"virtual sqlite fork head has a different branch identity"
	);
	let record = read_database_branch_record(tx, branch_id).await?;
	let parent = record
		.parent
		.context("virtual sqlite fork head has no parent")?;
	let stamp = record
		.parent_versionstamp
		.context("virtual sqlite fork head has no versionstamp")?;
	Ok(Some((parent, stamp, head)))
}

pub(in crate::conveyer) async fn lookup_commit_position_at_or_before(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	cap: [u8; 16],
) -> Result<([u8; 16], u64)> {
	let prefix = keys::branch_vtx_prefix(branch_id);
	let mut end = keys::branch_vtx_key(branch_id, cap);
	end.push(0);
	let informal = tx.informal();
	let mut rows = informal.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Iterator,
			reverse: true,
			limit: Some(1),
			..RangeOption::from((prefix.as_slice(), end.as_slice()))
		},
		Serializable,
	);
	let row = rows.try_next().await?;
	drop(rows);
	let Some(row) = row else {
		if let Some((_, stamp, head)) = read_virtual_head(tx, branch_id).await?
			&& stamp <= cap
		{
			return Ok((stamp, head.head_txid));
		}
		return Err(SqliteStorageError::RestoreTargetExpired.into());
	};
	let suffix = row
		.key()
		.strip_prefix(prefix.as_slice())
		.context("sqlite VTX lookup returned a different branch")?;
	let versionstamp = decode_versionstamp_value(suffix)?;
	ensure!(
		versionstamp <= cap,
		"sqlite VTX lookup exceeded inherited cap"
	);
	let txid: [u8; 8] = row
		.value()
		.try_into()
		.context("sqlite VTX entry should be exactly 8 bytes")?;
	Ok((versionstamp, u64::from_be_bytes(txid)))
}

pub(super) fn now_ms() -> Result<i64> {
	let millis = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.context("system clock is before unix epoch")?
		.as_millis();
	i64::try_from(millis).context("current timestamp exceeded i64 milliseconds")
}
