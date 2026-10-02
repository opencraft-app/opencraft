use anyhow::{Context, Result};
use futures_util::TryStreamExt;
use universaldb::{RangeOption, options::StreamingMode};

pub(super) fn tracked_entry_size(key: &[u8], value: &[u8]) -> Result<i64> {
	i64::try_from(key.len() + value.len()).context("sqlite tracked entry size exceeded i64")
}

pub(super) async fn tx_get_value(
	tx: &universaldb::Transaction,
	key: &[u8],
	isolation_level: universaldb::utils::IsolationLevel,
) -> Result<Option<Vec<u8>>> {
	Ok(tx
		.informal()
		.get(key, isolation_level)
		.await?
		.map(Vec::<u8>::from))
}

pub(super) async fn tx_read_latest_prefix_value(
	tx: &universaldb::Transaction,
	prefix: &[u8],
) -> Result<Option<(Vec<u8>, Vec<u8>)>> {
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		universaldb::RangeOption {
			mode: StreamingMode::Iterator,
			reverse: true,
			limit: Some(1),
			..RangeOption::from(universaldb::utils::range_for_prefix(prefix))
		},
		universaldb::utils::IsolationLevel::Serializable,
	);
	Ok(stream
		.try_next()
		.await?
		.map(|entry| (entry.key().to_vec(), entry.value().to_vec())))
}
