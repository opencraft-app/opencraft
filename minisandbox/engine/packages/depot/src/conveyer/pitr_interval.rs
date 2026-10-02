use anyhow::{Context, Result, ensure};
use futures_util::TryStreamExt;
use universaldb::{RangeOption, options::StreamingMode, utils::IsolationLevel};

use super::{
	keys,
	types::{
		DatabaseBranchId, PitrIntervalCoverage, decode_pitr_interval_coverage,
		encode_pitr_interval_coverage,
	},
};

pub async fn write_pitr_interval_coverage(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	bucket_start_ms: i64,
	coverage: PitrIntervalCoverage,
) -> Result<()> {
	ensure!(
		bucket_start_ms >= 0,
		"sqlite PITR interval bucket must be non-negative"
	);
	let primary_key = keys::branch_pitr_interval_key(branch_id, bucket_start_ms);
	if let Some(previous) = tx
		.informal()
		.get(&primary_key, IsolationLevel::Serializable)
		.await?
	{
		let previous = decode_pitr_interval_coverage(&previous)
			.context("decode previous sqlite PITR interval coverage")?;
		tx.informal().clear(&keys::branch_pitr_interval_by_txid_key(
			branch_id,
			previous.txid,
			bucket_start_ms,
		));
		tx.informal().clear(&keys::branch_pitr_interval_due_key(
			branch_id,
			previous.expires_at_ms,
			bucket_start_ms,
		));
	}
	let coverage_txid = coverage.txid;
	let coverage_expires_at_ms = coverage.expires_at_ms;
	let encoded =
		encode_pitr_interval_coverage(coverage).context("encode sqlite PITR interval coverage")?;
	tx.informal().set(&primary_key, &encoded);
	tx.informal().set(
		&keys::branch_pitr_interval_by_txid_key(branch_id, coverage_txid, bucket_start_ms),
		&[],
	);
	tx.informal().set(
		&keys::branch_pitr_interval_due_key(branch_id, coverage_expires_at_ms, bucket_start_ms),
		&coverage_txid.to_be_bytes(),
	);

	Ok(())
}

pub async fn read_pitr_interval_coverage(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	bucket_start_ms: i64,
	isolation_level: IsolationLevel,
) -> Result<Option<PitrIntervalCoverage>> {
	let key = keys::branch_pitr_interval_key(branch_id, bucket_start_ms);

	tx.informal()
		.get(&key, isolation_level)
		.await?
		.map(|bytes| decode_pitr_interval_coverage(&bytes))
		.transpose()
		.context("decode sqlite PITR interval coverage")
}

pub async fn scan_pitr_interval_coverage(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	isolation_level: IsolationLevel,
) -> Result<Vec<(i64, PitrIntervalCoverage)>> {
	let page =
		scan_pitr_interval_coverage_page(tx, branch_id, None, 1_024, isolation_level).await?;
	ensure!(
		page.next_cursor.is_none(),
		"sqlite PITR interval scan exceeded 1024 rows; use the paginated API"
	);
	Ok(page.rows)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PitrIntervalCoveragePage {
	pub rows: Vec<(i64, PitrIntervalCoverage)>,
	pub next_cursor: Option<i64>,
}

pub async fn scan_pitr_interval_coverage_page(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	cursor: Option<i64>,
	limit: usize,
	isolation_level: IsolationLevel,
) -> Result<PitrIntervalCoveragePage> {
	ensure!(
		(1..=1_024).contains(&limit),
		"PITR page limit must be 1..=1024"
	);
	let prefix = keys::branch_pitr_interval_prefix(branch_id);
	let start = cursor.map_or_else(
		|| prefix.clone(),
		|cursor| {
			let mut key = keys::branch_pitr_interval_key(branch_id, cursor);
			key.push(0);
			key
		},
	);
	let end = universaldb::utils::end_of_prefix_range(&prefix);
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Exact,
			limit: Some(limit.saturating_add(1)),
			..(start.as_slice(), end.as_slice()).into()
		},
		isolation_level,
	);
	let mut rows = Vec::with_capacity(limit.saturating_add(1));
	while let Some(entry) = stream.try_next().await? {
		let bucket_start_ms = keys::decode_branch_pitr_interval_bucket(branch_id, entry.key())?;
		ensure!(
			bucket_start_ms >= 0,
			"sqlite PITR interval bucket is negative"
		);
		let coverage = decode_pitr_interval_coverage(entry.value())
			.context("decode sqlite PITR interval coverage")?;
		rows.push((bucket_start_ms, coverage));
	}
	let has_more = rows.len() > limit;
	if has_more {
		rows.pop();
	}
	let next_cursor = has_more.then(|| rows.last().expect("non-empty full PITR page").0);
	Ok(PitrIntervalCoveragePage { rows, next_cursor })
}

pub async fn read_latest_pitr_interval_coverage_at_or_before(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	timestamp_ms: i64,
	isolation_level: IsolationLevel,
) -> Result<Option<(i64, PitrIntervalCoverage)>> {
	let start = keys::branch_pitr_interval_prefix(branch_id);
	let mut end = keys::branch_pitr_interval_key(branch_id, timestamp_ms);
	end.push(0);
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Iterator,
			reverse: true,
			// At most the current time bucket can contain a latest sample newer
			// than an in-bucket target. The immediately previous bucket is the
			// bounded fallback.
			limit: Some(2),
			..(start.as_slice(), end.as_slice()).into()
		},
		isolation_level,
	);
	while let Some(entry) = stream.try_next().await? {
		let bucket_start_ms = keys::decode_branch_pitr_interval_bucket(branch_id, entry.key())?;
		let coverage = decode_pitr_interval_coverage(entry.value())
			.context("decode sqlite PITR interval coverage")?;
		if bucket_start_ms <= timestamp_ms && coverage.wall_clock_ms <= timestamp_ms {
			return Ok(Some((bucket_start_ms, coverage)));
		}
	}

	Ok(None)
}
