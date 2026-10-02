use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use universaldb::utils::IsolationLevel::Serializable;

use crate::{
	keys,
	types::{ColdDeleteReceipt, decode_cold_delete_receipt, encode_cold_delete_receipt},
};

fn receipt_key(object_key: &str) -> Vec<u8> {
	keys::cold_delete_receipt_key(Sha256::digest(object_key.as_bytes()).into())
}

/// Writes the first immutable completion receipt. A response-loss replay may supply a different
/// completion clock, so identity and authorization must match while the original timestamp wins.
pub(crate) async fn write_completed_delete_receipt_tx(
	tx: &universaldb::Transaction,
	receipt: ColdDeleteReceipt,
) -> Result<ColdDeleteReceipt> {
	let key = receipt_key(&receipt.object_key);
	if let Some(encoded) = tx.informal().get(&key, Serializable).await? {
		let existing =
			decode_cold_delete_receipt(&encoded).context("decode existing cold delete receipt")?;
		let mut replay = receipt;
		replay.completed_at_ms = existing.completed_at_ms;
		ensure!(
			existing == replay,
			"cold delete receipt identity changed for an exact object key"
		);
		return Ok(existing);
	}
	tx.informal()
		.set(&key, &encode_cold_delete_receipt(receipt.clone())?);
	Ok(receipt)
}

pub async fn read_cold_delete_receipt(
	db: &universaldb::Database,
	object_key: &str,
) -> Result<Option<ColdDeleteReceipt>> {
	let key = receipt_key(object_key);
	db.txn("depot_read_cold_delete_receipt", move |tx| {
		let key = key.clone();
		async move {
			tx.informal()
				.get(&key, Serializable)
				.await?
				.map(|encoded| decode_cold_delete_receipt(&encoded))
				.transpose()
		}
	})
	.await
}
