use anyhow::{Context, Result};
use universaldb::options::MutationType;

pub const INCOMPLETE_VERSIONSTAMP: [u8; 16] = [
	0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0,
];

pub fn compare_and_clear(tx: &universaldb::Transaction, key: &[u8], expected_value: &[u8]) {
	tx.informal()
		.atomic_op(key, expected_value, MutationType::CompareAndClear);
}

pub fn append_versionstamp_offset(mut bytes: Vec<u8>, versionstamp: &[u8; 16]) -> Result<Vec<u8>> {
	let offset = bytes
		.windows(versionstamp.len())
		.position(|window| window == versionstamp)
		.context("versionstamp placeholder not found")?;
	let offset = u32::try_from(offset).context("versionstamp offset exceeded u32")?;
	bytes.extend_from_slice(&offset.to_le_bytes());
	Ok(bytes)
}

/// Appends the offset of the last matching placeholder. Use this for versioned value structs whose
/// earlier caller-controlled fields (for example a content hash) may contain the same byte pattern.
/// The dedicated versionstamp field must be the final matching placeholder in the encoded value.
pub fn append_last_versionstamp_offset(
	mut bytes: Vec<u8>,
	versionstamp: &[u8; 16],
) -> Result<Vec<u8>> {
	let offset = bytes
		.windows(versionstamp.len())
		.rposition(|window| window == versionstamp)
		.context("versionstamp placeholder not found")?;
	let offset = u32::try_from(offset).context("versionstamp offset exceeded u32")?;
	bytes.extend_from_slice(&offset.to_le_bytes());
	Ok(bytes)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn last_versionstamp_offset_ignores_caller_controlled_prefix_collision() {
		let mut encoded = INCOMPLETE_VERSIONSTAMP.to_vec();
		encoded.extend_from_slice(b"caller-controlled-value");
		let expected_offset = encoded.len();
		encoded.extend_from_slice(&INCOMPLETE_VERSIONSTAMP);

		let encoded = append_last_versionstamp_offset(encoded, &INCOMPLETE_VERSIONSTAMP)
			.expect("last placeholder should be addressable");
		let offset = u32::from_le_bytes(
			encoded[encoded.len() - 4..]
				.try_into()
				.expect("offset suffix should be four bytes"),
		) as usize;
		assert_eq!(offset, expected_offset);
	}
}
