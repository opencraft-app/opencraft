use foundationdb_tuple::{PackError, Subspace, Versionstamp, pack, unpack};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Fixed guest block size used by the reference engine.
pub const BLOCK_SIZE: usize = 4096;
/// Exact block heads grouped under one 4 MiB tuple prefix.
pub const DELTA_SHARD_BLOCKS: u64 = 1024;
const MAX_IDENTIFIER_BYTES: usize = 128;
const VERSION_USER_ORDER: u16 = 0;
type StoredAppliedResult = (Vec<u8>, String, Vec<u8>, u64, (String, u64, Versionstamp));

/// Stable, externally allocated 128-bit delta-layer identity.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct LayerId([u8; 16]);

impl LayerId {
	/// Creates an ID from its canonical bytes.
	#[must_use]
	pub const fn from_bytes(bytes: [u8; 16]) -> Self {
		Self(bytes)
	}

	/// Returns the canonical bytes.
	#[must_use]
	pub const fn as_bytes(&self) -> &[u8; 16] {
		&self.0
	}

	/// Parses a tuple byte string as a layer ID.
	///
	/// # Errors
	///
	/// Returns [`KeyLayoutError::InvalidLayerId`] unless the value is exactly
	/// 16 bytes.
	pub fn from_slice(bytes: &[u8]) -> Result<Self, KeyLayoutError> {
		let bytes = <[u8; 16]>::try_from(bytes).map_err(|_| KeyLayoutError::InvalidLayerId)?;
		Ok(Self(bytes))
	}
}

/// A logical immutable block-version pointer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VersionReference {
	/// Volume that issued the payload version.
	pub source_volume_id: String,
	/// Writer fencing epoch at issuance.
	pub writer_epoch: u64,
	/// Native 12-byte tuple-layer versionstamp.
	pub versionstamp: Versionstamp,
}

/// Validated inputs for one aligned full-block write.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WriteInput {
	/// Logical volume identifier.
	pub volume_id: String,
	/// Current writer fencing epoch.
	pub writer_epoch: u64,
	/// Idempotency identity, reused across uncertain retries.
	pub op_id: String,
	/// Logical block number.
	pub block_no: u64,
	/// Exactly one block of bytes.
	pub bytes: Vec<u8>,
}

/// Fully encoded keys and versionstamped mutations for a write transaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedWrite {
	/// Ordinary-read fencing key.
	pub epoch_key: Vec<u8>,
	/// Ordinary-read current-layer key.
	pub layer_key: Vec<u8>,
	/// Ordinary-read and versionstamped-write deduplication key.
	pub op_result_key: Vec<u8>,
	/// Incomplete-versionstamp immutable payload key.
	pub block_version_key: Vec<u8>,
	/// Immutable payload value.
	pub block_version_value: Vec<u8>,
	/// Exact mutable `(layer, shard, block)` head key.
	pub delta_head_key: Vec<u8>,
	/// Incomplete-versionstamp pointer value for the delta head.
	pub delta_head_value: Vec<u8>,
	/// Incomplete-versionstamp durable result value.
	pub op_result_value: Vec<u8>,
	/// Request fingerprint stored with the durable result.
	pub request_fingerprint: [u8; 32],
}

/// Tuple-layout validation or decoding failure.
#[derive(Debug, Error)]
pub enum KeyLayoutError {
	/// An identifier is empty or exceeds the contract bound.
	#[error("{field} must contain 1..={MAX_IDENTIFIER_BYTES} bytes")]
	InvalidIdentifier {
		/// Name of the invalid field.
		field: &'static str,
	},
	/// Writer epochs are one-based fencing tokens.
	#[error("writer epoch must be non-zero")]
	InvalidEpoch,
	/// Payload is not one full aligned block.
	#[error("write payload must be exactly {BLOCK_SIZE} bytes")]
	InvalidPayload,
	/// Layer identifiers are exactly 128 bits.
	#[error("layer identifier must be exactly 16 bytes")]
	InvalidLayerId,
	/// A stored tuple does not match the current layout.
	#[error("invalid stored tuple")]
	InvalidTuple(#[from] PackError),
	/// A well-formed tuple violates the adapter's value contract.
	#[error("invalid stored value")]
	InvalidStoredValue,
}

/// Versioned `FoundationDB` keyspace rooted at an already allocated raw prefix.
///
/// Prefix allocation is deliberately external to the hot path. Production may
/// use the Directory Layer once during provisioning, then persist and reuse the
/// returned raw prefix.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeyLayout {
	root: Subspace,
}

impl KeyLayout {
	/// Creates a layout under an opaque, deployment-owned raw prefix.
	#[must_use]
	pub fn new(root_prefix: impl Into<Vec<u8>>) -> Self {
		Self {
			root: Subspace::from_bytes(root_prefix),
		}
	}

	/// Returns the namespace prefix.
	#[must_use]
	pub fn prefix(&self) -> &[u8] {
		self.root.bytes()
	}

	/// Returns the complete namespace range for setup or benchmark cleanup.
	#[must_use]
	pub fn range(&self) -> (Vec<u8>, Vec<u8>) {
		self.root.range()
	}

	/// Current schema marker key.
	#[must_use]
	pub fn schema_key(&self) -> Vec<u8> {
		self.root.pack(&("m", "schema"))
	}

	/// Volume writer-epoch key. Normal writes ordinary-read but never update it.
	///
	/// # Errors
	///
	/// Returns an error for an invalid volume identifier.
	pub fn volume_epoch_key(&self, volume_id: &str) -> Result<Vec<u8>, KeyLayoutError> {
		validate_identifier("volume_id", volume_id)?;
		Ok(self.root.pack(&("v", volume_id, "epoch")))
	}

	/// Current delta-layer pointer key. Steady writes ordinary-read it.
	///
	/// # Errors
	///
	/// Returns an error for an invalid volume identifier.
	pub fn volume_layer_key(&self, volume_id: &str) -> Result<Vec<u8>, KeyLayoutError> {
		validate_identifier("volume_id", volume_id)?;
		Ok(self.root.pack(&("v", volume_id, "layer")))
	}

	/// Durable per-writer operation-result key.
	///
	/// # Errors
	///
	/// Returns an error for an invalid identifier or zero epoch.
	pub fn op_result_key(
		&self,
		volume_id: &str,
		writer_epoch: u64,
		op_id: &str,
	) -> Result<Vec<u8>, KeyLayoutError> {
		validate_write_identity(volume_id, writer_epoch, op_id)?;
		Ok(self.root.pack(&("o", volume_id, writer_epoch, op_id)))
	}

	/// Exact delta-head key. Sharding changes the prefix, never the value shape.
	#[must_use]
	pub fn delta_head_key(&self, layer_id: LayerId, block_no: u64) -> Vec<u8> {
		self.root.pack(&(
			"d",
			layer_id.as_bytes().as_slice(),
			block_no / DELTA_SHARD_BLOCKS,
			block_no,
		))
	}

	/// Incomplete-versionstamp immutable payload key for `SET_VERSIONSTAMPED_KEY`.
	///
	/// # Errors
	///
	/// Returns an error for an invalid volume identifier or zero epoch.
	pub fn block_version_key(
		&self,
		volume_id: &str,
		writer_epoch: u64,
	) -> Result<Vec<u8>, KeyLayoutError> {
		self.block_version_key_at(volume_id, writer_epoch, VERSION_USER_ORDER)
	}

	/// Incomplete-versionstamp immutable payload key at a batch-local ordinal.
	///
	/// The ordinal becomes the tuple versionstamp's two-byte user version, so
	/// multiple 4 KiB payloads in one FDB transaction remain distinct while
	/// sharing its native ten-byte transaction version.
	///
	/// # Errors
	///
	/// Returns an error for an invalid volume identifier or zero epoch.
	pub fn block_version_key_at(
		&self,
		volume_id: &str,
		writer_epoch: u64,
		user_version: u16,
	) -> Result<Vec<u8>, KeyLayoutError> {
		validate_identifier("volume_id", volume_id)?;
		if writer_epoch == 0 {
			return Err(KeyLayoutError::InvalidEpoch);
		}
		Ok(self.root.pack_with_versionstamp(&(
			"b",
			volume_id,
			writer_epoch,
			Versionstamp::incomplete(user_version),
		)))
	}

	/// Encodes a complete reference for reads and test oracles.
	#[must_use]
	pub fn encode_version_reference(reference: &VersionReference) -> Vec<u8> {
		pack(&(
			reference.source_volume_id.as_str(),
			reference.writer_epoch,
			&reference.versionstamp,
		))
	}

	/// Decodes a complete version reference.
	///
	/// # Errors
	///
	/// Returns an error for malformed bytes or an incomplete versionstamp.
	pub fn decode_version_reference(bytes: &[u8]) -> Result<VersionReference, KeyLayoutError> {
		let (source_volume_id, writer_epoch, versionstamp): (String, u64, Versionstamp) =
			unpack(bytes)?;
		if !versionstamp.is_complete() {
			return Err(KeyLayoutError::InvalidStoredValue);
		}
		Ok(VersionReference {
			source_volume_id,
			writer_epoch,
			versionstamp,
		})
	}

	/// Encodes a current epoch value.
	#[must_use]
	pub fn encode_epoch(writer_epoch: u64) -> Vec<u8> {
		pack(&writer_epoch)
	}

	/// Decodes a current epoch value.
	///
	/// # Errors
	///
	/// Returns an error for a malformed or zero epoch.
	pub fn decode_epoch(bytes: &[u8]) -> Result<u64, KeyLayoutError> {
		let epoch = unpack(bytes)?;
		if epoch == 0 {
			return Err(KeyLayoutError::InvalidEpoch);
		}
		Ok(epoch)
	}

	/// Encodes a layer pointer value.
	#[must_use]
	pub fn encode_layer(layer_id: LayerId) -> Vec<u8> {
		pack(&layer_id.as_bytes().as_slice())
	}

	/// Decodes a layer pointer value.
	///
	/// # Errors
	///
	/// Returns an error unless the tuple contains exactly 16 bytes.
	pub fn decode_layer(bytes: &[u8]) -> Result<LayerId, KeyLayoutError> {
		let raw: Vec<u8> = unpack(bytes)?;
		LayerId::from_slice(&raw)
	}

	/// Validates and prepares all write mutations after the transaction has
	/// ordinary-read the current epoch, operation result, and current layer.
	///
	/// # Errors
	///
	/// Returns an error for an invalid identity, epoch, or payload size.
	pub fn prepare_write(
		&self,
		input: &WriteInput,
		current_layer: LayerId,
	) -> Result<PreparedWrite, KeyLayoutError> {
		self.prepare_write_at(input, current_layer, VERSION_USER_ORDER)
	}

	/// Prepares one internal 4 KiB mutation at a batch-local version ordinal.
	///
	/// # Errors
	///
	/// Returns an error for an invalid identity, epoch, or payload size.
	pub fn prepare_write_at(
		&self,
		input: &WriteInput,
		current_layer: LayerId,
		user_version: u16,
	) -> Result<PreparedWrite, KeyLayoutError> {
		validate_write_identity(&input.volume_id, input.writer_epoch, &input.op_id)?;
		if input.bytes.len() != BLOCK_SIZE {
			return Err(KeyLayoutError::InvalidPayload);
		}

		let request_fingerprint = write_fingerprint(input);
		let incomplete = Versionstamp::incomplete(user_version);
		let reference = (input.volume_id.as_str(), input.writer_epoch, &incomplete);
		let delta_head_value = foundationdb_tuple::pack_with_versionstamp(&reference);
		let op_result_value = foundationdb_tuple::pack_with_versionstamp(&(
			request_fingerprint.as_slice(),
			"applied",
			current_layer.as_bytes().as_slice(),
			input.block_no,
			reference,
		));
		let content_sha256 = Sha256::digest(&input.bytes);
		let block_version_value = pack(&(
			input.block_no,
			content_sha256.as_slice(),
			input.bytes.as_slice(),
		));

		Ok(PreparedWrite {
			epoch_key: self.volume_epoch_key(&input.volume_id)?,
			layer_key: self.volume_layer_key(&input.volume_id)?,
			op_result_key: self.op_result_key(
				&input.volume_id,
				input.writer_epoch,
				&input.op_id,
			)?,
			block_version_key: self.block_version_key_at(
				&input.volume_id,
				input.writer_epoch,
				user_version,
			)?,
			block_version_value,
			delta_head_key: self.delta_head_key(current_layer, input.block_no),
			delta_head_value,
			op_result_value,
			request_fingerprint,
		})
	}

	/// Decodes and validates an applied operation result.
	///
	/// # Errors
	///
	/// Returns an error for malformed bytes, a request mismatch, or an
	/// incomplete versionstamp.
	pub fn decode_applied_result(
		bytes: &[u8],
		expected_fingerprint: &[u8; 32],
	) -> Result<(LayerId, u64, VersionReference), KeyLayoutError> {
		let (fingerprint, kind, layer, block_no, reference): StoredAppliedResult = unpack(bytes)?;
		if fingerprint.as_slice() != expected_fingerprint || kind != "applied" {
			return Err(KeyLayoutError::InvalidStoredValue);
		}
		let layer = LayerId::from_slice(&layer)?;
		let reference = VersionReference {
			source_volume_id: reference.0,
			writer_epoch: reference.1,
			versionstamp: reference.2,
		};
		if !reference.versionstamp.is_complete() {
			return Err(KeyLayoutError::InvalidStoredValue);
		}
		Ok((layer, block_no, reference))
	}
}

fn validate_write_identity(
	volume_id: &str,
	writer_epoch: u64,
	op_id: &str,
) -> Result<(), KeyLayoutError> {
	validate_identifier("volume_id", volume_id)?;
	validate_identifier("op_id", op_id)?;
	if writer_epoch == 0 {
		return Err(KeyLayoutError::InvalidEpoch);
	}
	Ok(())
}

fn validate_identifier(field: &'static str, value: &str) -> Result<(), KeyLayoutError> {
	if value.is_empty() || value.len() > MAX_IDENTIFIER_BYTES {
		return Err(KeyLayoutError::InvalidIdentifier { field });
	}
	Ok(())
}

fn write_fingerprint(input: &WriteInput) -> [u8; 32] {
	let mut hash = Sha256::new();
	hash.update(b"minisandbox/fdb/write/v1\0");
	hash.update((input.volume_id.len() as u64).to_be_bytes());
	hash.update(input.volume_id.as_bytes());
	hash.update(input.writer_epoch.to_be_bytes());
	hash.update((input.op_id.len() as u64).to_be_bytes());
	hash.update(input.op_id.as_bytes());
	hash.update(input.block_no.to_be_bytes());
	hash.update((input.bytes.len() as u64).to_be_bytes());
	hash.update(&input.bytes);
	hash.finalize().into()
}

#[cfg(test)]
mod tests {
	use super::*;

	const PREFIX: &[u8] = b"\x02minisandbox-test/fdb/v1/";

	fn input(block_no: u64) -> WriteInput {
		WriteInput {
			volume_id: "volume-a".to_owned(),
			writer_epoch: 7,
			op_id: format!("write-{block_no}"),
			block_no,
			bytes: vec![0x5a; BLOCK_SIZE],
		}
	}

	fn complete_versionstamped(mut bytes: Vec<u8>, transaction_version: [u8; 10]) -> Vec<u8> {
		let suffix = bytes.split_off(bytes.len() - 4);
		let offset = u32::from_le_bytes(suffix.try_into().expect("four-byte offset")) as usize;
		bytes[offset..offset + 10].copy_from_slice(&transaction_version);
		bytes
	}

	#[test]
	fn delta_heads_are_exact_keys_under_four_mib_shards() {
		let layout = KeyLayout::new(PREFIX);
		let layer = LayerId::from_bytes([7; 16]);
		let first = layout.delta_head_key(layer, 0);
		let last = layout.delta_head_key(layer, 1023);
		let next = layout.delta_head_key(layer, 1024);

		assert_ne!(first, last);
		assert_ne!(last, next);
		assert!(first < last && last < next);
		let (_, _, first_shard, first_block): (String, Vec<u8>, u64, u64) =
			layout.root.unpack(&first).expect("first tuple");
		let (_, _, next_shard, next_block): (String, Vec<u8>, u64, u64) =
			layout.root.unpack(&next).expect("next tuple");
		assert_eq!((first_shard, first_block), (0, 0));
		assert_eq!((next_shard, next_block), (1, 1024));
	}

	#[test]
	fn write_uses_native_versionstamp_for_payload_head_and_result() {
		let layout = KeyLayout::new(PREFIX);
		let layer = LayerId::from_bytes([9; 16]);
		let prepared = layout.prepare_write(&input(19), layer).expect("prepare");
		let transaction_version = [0x31; 10];

		let version_key =
			complete_versionstamped(prepared.block_version_key.clone(), transaction_version);
		let (_, volume, epoch, versionstamp): (String, String, u64, Versionstamp) =
			layout.root.unpack(&version_key).expect("version key");
		assert_eq!((volume.as_str(), epoch), ("volume-a", 7));
		assert_eq!(versionstamp.transaction_version(), &transaction_version);

		let delta = complete_versionstamped(prepared.delta_head_value, transaction_version);
		let (volume, epoch, versionstamp): (String, u64, Versionstamp) =
			unpack(&delta).expect("delta value");
		assert_eq!((volume.as_str(), epoch), ("volume-a", 7));
		assert_eq!(versionstamp.transaction_version(), &transaction_version);

		let result = complete_versionstamped(prepared.op_result_value, transaction_version);
		let (result_layer, block_no, reference) =
			KeyLayout::decode_applied_result(&result, &prepared.request_fingerprint)
				.expect("result value");
		assert_eq!((result_layer, block_no), (layer, 19));
		assert_eq!(
			reference.versionstamp.transaction_version(),
			&transaction_version
		);
	}

	#[test]
	fn batch_ordinals_make_same_transaction_versions_distinct() {
		let layout = KeyLayout::new(PREFIX);
		let layer = LayerId::from_bytes([8; 16]);
		let first = layout
			.prepare_write_at(&input(40), layer, 0)
			.expect("first ordinal");
		let second = layout
			.prepare_write_at(&input(41), layer, 1)
			.expect("second ordinal");
		let transaction_version = [0x44; 10];
		let first_key = complete_versionstamped(first.block_version_key, transaction_version);
		let second_key = complete_versionstamped(second.block_version_key, transaction_version);
		assert_ne!(first_key, second_key);
		let (_, _, _, first_stamp): (String, String, u64, Versionstamp) =
			layout.root.unpack(&first_key).expect("first key");
		let (_, _, _, second_stamp): (String, String, u64, Versionstamp) =
			layout.root.unpack(&second_key).expect("second key");
		assert_eq!(first_stamp.transaction_version(), &transaction_version);
		assert_eq!(second_stamp.transaction_version(), &transaction_version);
		assert_eq!(
			(first_stamp.user_version(), second_stamp.user_version()),
			(0, 1)
		);
	}

	#[test]
	fn request_fingerprint_rejects_op_id_reuse_with_different_payload() {
		let layout = KeyLayout::new(PREFIX);
		let layer = LayerId::from_bytes([3; 16]);
		let first = layout.prepare_write(&input(1), layer).expect("first");
		let mut changed = input(1);
		changed.bytes[0] ^= 1;
		let second = layout.prepare_write(&changed, layer).expect("second");
		assert_ne!(first.request_fingerprint, second.request_fingerprint);
	}

	#[test]
	fn invalid_inputs_fail_before_a_transaction() {
		let layout = KeyLayout::new(PREFIX);
		let layer = LayerId::from_bytes([1; 16]);
		let mut invalid = input(1);
		invalid.writer_epoch = 0;
		assert!(matches!(
			layout.prepare_write(&invalid, layer),
			Err(KeyLayoutError::InvalidEpoch)
		));
		invalid.writer_epoch = 1;
		invalid.bytes.pop();
		assert!(matches!(
			layout.prepare_write(&invalid, layer),
			Err(KeyLayoutError::InvalidPayload)
		));
	}
}
