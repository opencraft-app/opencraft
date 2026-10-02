use anyhow::{Result, ensure};
use futures_util::TryStreamExt;
use universaldb::{RangeOption, options::StreamingMode, utils::IsolationLevel::Serializable};

use crate::conveyer::constants::MAX_DELTA_CHUNKS_PER_COMMIT;

pub(super) async fn tx_get_value(
	tx: &universaldb::Transaction,
	key: &[u8],
) -> Result<Option<Vec<u8>>> {
	// TODO: This can probably be made Snapshot again to reduce contention if read
	// side freshness is not worth the cost.
	Ok(tx
		.informal()
		.get(key, Serializable)
		.await?
		.map(Vec::<u8>::from))
}

/// Loads one commit's bounded DELTA chunks. The commit admission cap bounds
/// this prefix independently of database age or page cardinality.
pub(super) async fn tx_scan_prefix_values(
	tx: &universaldb::Transaction,
	prefix: &[u8],
) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Iterator,
			limit: Some(MAX_DELTA_CHUNKS_PER_COMMIT.saturating_add(1)),
			..RangeOption::from(universaldb::utils::range_for_prefix(prefix))
		},
		Serializable,
	);
	let mut rows = Vec::new();
	while let Some(entry) = stream.try_next().await? {
		rows.push((entry.key().to_vec(), entry.value().to_vec()));
	}
	ensure!(
		rows.len() <= MAX_DELTA_CHUNKS_PER_COMMIT,
		"sqlite DELTA exceeded the bounded per-commit chunk limit"
	);
	Ok(rows)
}

pub(super) async fn tx_get_last_key_value(
	tx: &universaldb::Transaction,
	start: &[u8],
	end: &[u8],
) -> Result<Option<(Vec<u8>, Vec<u8>)>> {
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		universaldb::RangeOption {
			mode: StreamingMode::Iterator,
			reverse: true,
			limit: Some(1),
			..RangeOption::from((start, end))
		},
		// TODO: This can probably be made Snapshot again to reduce contention if
		// read side freshness is not worth the cost.
		Serializable,
	);
	Ok(stream
		.try_next()
		.await?
		.map(|entry| (entry.key().to_vec(), entry.value().to_vec())))
}
