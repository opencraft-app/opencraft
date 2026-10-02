use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use universaldb::utils::IsolationLevel;

use super::{
	constants::{HOT_SHARD_CHUNK_BYTES, MAX_HOT_SHARD_BLOB_BYTES, MAX_HOT_SHARD_CHUNKS},
	keys,
	types::{
		DatabaseBranchId, HotShardManifest, decode_hot_shard_manifest, encode_hot_shard_manifest,
	},
};

/// Writes a hot shard using an inline legacy-compatible row when it fits, or a small manifest
/// plus fixed-size chunk rows otherwise. The caller must keep the enclosing transaction within
/// its aggregate mutation budget.
pub fn write_branch_shard_blob(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	shard_id: u32,
	as_of_txid: u64,
	blob: &[u8],
) -> Result<()> {
	for (key, value) in branch_shard_blob_rows(branch_id, shard_id, as_of_txid, blob)? {
		tx.informal().set(&key, &value);
	}
	Ok(())
}

/// Encodes the exact canonical and chunk rows for a hot shard. This is also used by quota-aware
/// mutation paths so accounting covers the physical representation rather than only its manifest.
pub(crate) fn branch_shard_blob_rows(
	branch_id: DatabaseBranchId,
	shard_id: u32,
	as_of_txid: u64,
	blob: &[u8],
) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
	ensure!(
		blob.len() <= MAX_HOT_SHARD_BLOB_BYTES,
		"sqlite hot shard exceeds maximum encoded length"
	);
	let shard_key = keys::branch_shard_key(branch_id, shard_id, as_of_txid);
	if blob.len() <= HOT_SHARD_CHUNK_BYTES {
		return Ok(vec![(shard_key, blob.to_vec())]);
	}

	let chunks = blob
		.chunks(HOT_SHARD_CHUNK_BYTES)
		.enumerate()
		.map(|(chunk_idx, chunk)| {
			Ok((
				u32::try_from(chunk_idx).context("sqlite hot shard chunk index exceeded u32")?,
				chunk,
			))
		})
		.collect::<Result<Vec<_>>>()?;
	ensure!(
		u32::try_from(chunks.len()).unwrap_or(u32::MAX) <= MAX_HOT_SHARD_CHUNKS,
		"sqlite hot shard exceeds maximum chunk count"
	);
	let manifest = HotShardManifest {
		shard_id,
		as_of_txid,
		chunk_count: u32::try_from(chunks.len())
			.context("sqlite hot shard chunk count exceeded u32")?,
		encoded_len: u64::try_from(blob.len()).unwrap_or(u64::MAX),
		content_hash: content_hash(blob),
	};
	let mut rows = Vec::with_capacity(chunks.len() + 1);
	rows.push((shard_key, encode_hot_shard_manifest(manifest)?));
	for (chunk_idx, chunk) in chunks {
		rows.push((
			keys::branch_shard_chunk_key(branch_id, shard_id, as_of_txid, chunk_idx),
			chunk.to_vec(),
		));
	}
	Ok(rows)
}

/// Resolves either a legacy inline SHARD value or the new chunked representation and validates
/// every byte before exposing it to compaction/read/cold-tier code.
pub async fn resolve_branch_shard_value(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	shard_id: u32,
	as_of_txid: u64,
	value: &[u8],
	isolation_level: IsolationLevel,
) -> Result<Vec<u8>> {
	let Ok(manifest) = decode_hot_shard_manifest(value) else {
		return Ok(value.to_vec());
	};
	validate_manifest_identity(&manifest, shard_id, as_of_txid)?;
	let mut chunks = Vec::with_capacity(usize::try_from(manifest.chunk_count).unwrap_or(0));
	for chunk_idx in 0..manifest.chunk_count {
		let chunk_key = keys::branch_shard_chunk_key(branch_id, shard_id, as_of_txid, chunk_idx);
		let chunk = tx
			.informal()
			.get(&chunk_key, isolation_level)
			.await?
			.with_context(|| {
				format!(
					"sqlite hot shard chunk missing for shard {shard_id} txid {as_of_txid} chunk {chunk_idx}"
				)
			})?;
		chunks.push((chunk_idx, chunk.to_vec()));
	}
	resolve_branch_shard_chunks(shard_id, as_of_txid, value, &chunks)
}

/// Reassembles an already-scanned chunked shard. Doctor/offline inspection uses this to apply the
/// same identity, contiguity, length, and hash checks as the live transaction read path.
pub fn resolve_branch_shard_chunks(
	shard_id: u32,
	as_of_txid: u64,
	manifest_value: &[u8],
	chunks: &[(u32, Vec<u8>)],
) -> Result<Vec<u8>> {
	let manifest = decode_hot_shard_manifest(manifest_value)
		.context("sqlite hot shard value is not a chunk manifest")?;
	validate_manifest_identity(&manifest, shard_id, as_of_txid)?;
	ensure!(
		chunks.len() == usize::try_from(manifest.chunk_count).unwrap_or(usize::MAX),
		"sqlite hot shard chunk count mismatch"
	);
	let mut blob = Vec::with_capacity(usize::try_from(manifest.encoded_len).unwrap_or(0));
	for (expected_idx, (chunk_idx, chunk)) in chunks.iter().enumerate() {
		ensure!(
			*chunk_idx == u32::try_from(expected_idx).unwrap_or(u32::MAX),
			"sqlite hot shard chunks must be contiguous from chunk 0"
		);
		ensure!(
			!chunk.is_empty() && chunk.len() <= HOT_SHARD_CHUNK_BYTES,
			"sqlite hot shard chunk has invalid length"
		);
		if *chunk_idx + 1 < manifest.chunk_count {
			ensure!(
				chunk.len() == HOT_SHARD_CHUNK_BYTES,
				"sqlite hot shard non-final chunk has invalid length"
			);
		}
		blob.extend_from_slice(chunk);
	}
	ensure!(
		manifest.encoded_len == u64::try_from(blob.len()).unwrap_or(u64::MAX),
		"sqlite hot shard chunk length mismatch"
	);
	ensure!(
		manifest.content_hash == content_hash(&blob),
		"sqlite hot shard chunk hash mismatch"
	);
	Ok(blob)
}

fn validate_manifest_identity(
	manifest: &HotShardManifest,
	shard_id: u32,
	as_of_txid: u64,
) -> Result<()> {
	ensure!(
		manifest.shard_id == shard_id && manifest.as_of_txid == as_of_txid,
		"sqlite hot shard manifest key did not match row key"
	);
	ensure!(
		manifest.chunk_count > 0 && manifest.chunk_count <= MAX_HOT_SHARD_CHUNKS,
		"sqlite hot shard manifest has invalid chunk count"
	);
	ensure!(
		manifest.encoded_len <= u64::try_from(MAX_HOT_SHARD_BLOB_BYTES).unwrap_or(u64::MAX),
		"sqlite hot shard manifest exceeds maximum encoded length"
	);
	Ok(())
}

pub fn clear_branch_shard_chunks(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	shard_id: u32,
	as_of_txid: u64,
	row_value: &[u8],
) -> Result<()> {
	let Ok(manifest) = decode_hot_shard_manifest(row_value) else {
		return Ok(());
	};
	ensure!(
		manifest.shard_id == shard_id && manifest.as_of_txid == as_of_txid,
		"sqlite hot shard manifest key did not match row key"
	);
	ensure!(
		manifest.chunk_count > 0 && manifest.chunk_count <= MAX_HOT_SHARD_CHUNKS,
		"sqlite hot shard manifest has invalid chunk count"
	);
	ensure!(
		manifest.encoded_len <= u64::try_from(MAX_HOT_SHARD_BLOB_BYTES).unwrap_or(u64::MAX),
		"sqlite hot shard manifest exceeds maximum encoded length"
	);
	for chunk_idx in 0..manifest.chunk_count {
		tx.informal().clear(&keys::branch_shard_chunk_key(
			branch_id, shard_id, as_of_txid, chunk_idx,
		));
	}
	Ok(())
}

/// Returns the physical value rows and bytes represented by a canonical SHARD row. Callers that
/// already resolved the chunks can use this to budget deletes without loading them a second time.
pub fn branch_shard_physical_stats(
	shard_id: u32,
	as_of_txid: u64,
	row_value: &[u8],
) -> Result<(usize, u64)> {
	let Ok(manifest) = decode_hot_shard_manifest(row_value) else {
		return Ok((1, u64::try_from(row_value.len()).unwrap_or(u64::MAX)));
	};
	validate_manifest_identity(&manifest, shard_id, as_of_txid)?;
	Ok((
		usize::try_from(manifest.chunk_count)
			.unwrap_or(usize::MAX)
			.saturating_add(1),
		manifest
			.encoded_len
			.saturating_add(u64::try_from(row_value.len()).unwrap_or(u64::MAX)),
	))
}

/// Validates the compact canonical SHARD row against an already-durable content proof without
/// loading chunk bodies into the root publication transaction.
pub fn shard_row_matches_proof(
	row_value: &[u8],
	shard_id: u32,
	as_of_txid: u64,
	size_bytes: u64,
	expected_hash: [u8; 32],
) -> bool {
	match decode_hot_shard_manifest(row_value) {
		Ok(manifest) => {
			manifest.shard_id == shard_id
				&& manifest.as_of_txid == as_of_txid
				&& manifest.chunk_count > 0
				&& manifest.chunk_count <= MAX_HOT_SHARD_CHUNKS
				&& manifest.encoded_len
					<= u64::try_from(MAX_HOT_SHARD_BLOB_BYTES).unwrap_or(u64::MAX)
				&& manifest.encoded_len == size_bytes
				&& manifest.content_hash == expected_hash
		}
		Err(_) => {
			u64::try_from(row_value.len()).unwrap_or(u64::MAX) == size_bytes
				&& content_hash(row_value) == expected_hash
		}
	}
}

fn content_hash(bytes: &[u8]) -> [u8; 32] {
	let digest = Sha256::digest(bytes);
	let mut hash = [0_u8; 32];
	hash.copy_from_slice(&digest);
	hash
}
