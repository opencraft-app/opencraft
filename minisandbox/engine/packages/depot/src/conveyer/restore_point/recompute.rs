use anyhow::{Context, Result, ensure};
use futures_util::TryStreamExt;
use universaldb::RangeOption;
use universaldb::options::StreamingMode;
use universaldb::utils::IsolationLevel::Serializable;

use crate::conveyer::{
	constants::MAX_RESTORE_POINTS_PER_BUCKET,
	keys,
	types::{DatabaseBranchId, decode_restore_point_record},
};

pub(super) async fn recompute_database_branch_restore_point_pin(
	tx: &universaldb::Transaction,
	database_id: &str,
	branch_id: DatabaseBranchId,
	deleted_restore_point_key: &[u8],
) -> Result<Option<[u8; 16]>> {
	let start = keys::restore_point_prefix(database_id);
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Iterator,
			limit: Some(MAX_RESTORE_POINTS_PER_BUCKET as usize + 1),
			..RangeOption::from(universaldb::utils::range_for_prefix(&start))
		},
		Serializable,
	);
	let mut pin = None;
	let mut inspected = 0_usize;

	while let Some(entry) = stream.try_next().await? {
		inspected = inspected.saturating_add(1);
		ensure!(
			inspected <= MAX_RESTORE_POINTS_PER_BUCKET as usize,
			"sqlite restore-point pin recompute exceeded its durable bucket cap"
		);
		if entry.key() == deleted_restore_point_key {
			continue;
		}

		let record = decode_restore_point_record(entry.value())
			.context("decode sqlite restore point record during pin recompute")?;
		if record.database_branch_id == branch_id {
			pin = Some(
				pin.map(|current: [u8; 16]| current.min(record.versionstamp))
					.unwrap_or(record.versionstamp),
			);
		}
	}

	Ok(pin)
}
