use anyhow::{Context, Result, ensure};
use universaldb::{error::DatabaseError, utils::IsolationLevel::Serializable};

use crate::conveyer::{
	constants::{MAX_HOT_SHARD_BLOB_BYTES, MAX_HOT_SHARD_CHUNKS},
	keys::{self, SHARD_SIZE},
	ltx::{decode_ltx_v3, encode_ltx_v3},
	quota::{self, PidxCountSuffixClearPlan},
	shard_blob::{branch_shard_blob_rows, resolve_branch_shard_value},
	types::{DatabaseBranchId, decode_hot_shard_manifest},
};

use super::helpers::{tracked_entry_size, tx_get_value, tx_read_latest_prefix_value};

#[derive(Default)]
pub(super) struct TruncateCleanup {
	pub(super) reset_pidx_cache: bool,
	clear_ranges: Vec<(Vec<u8>, Vec<u8>)>,
	shard_clears: Vec<ObservedShardRow>,
	shard_writes: Vec<(ObservedShardRow, Vec<(Vec<u8>, Vec<u8>)>)>,
	pidx_count_suffix_clear: Option<PidxCountSuffixClearPlan>,
	pub(super) deleted_bytes: i64,
}

pub(super) struct ObservedCleanupRow {
	pub(super) key: Vec<u8>,
	value: Vec<u8>,
}

struct ObservedShardRow {
	canonical: ObservedCleanupRow,
	chunks: Vec<ObservedCleanupRow>,
}

pub(super) async fn collect_truncate_cleanup(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	previous_db_size_pages: u32,
	new_db_size_pages: u32,
) -> Result<TruncateCleanup> {
	if new_db_size_pages >= previous_db_size_pages {
		return Ok(TruncateCleanup::default());
	}

	let mut cleanup = TruncateCleanup {
		reset_pidx_cache: true,
		..TruncateCleanup::default()
	};
	let first_removed_pgno = new_db_size_pages
		.checked_add(1)
		.context("sqlite truncate page number overflowed")?;
	let pidx_count_suffix_clear =
		quota::plan_pidx_count_suffix_clear(tx, branch_id, first_removed_pgno).await?;
	let pidx_row_size = tracked_entry_size(
		&keys::branch_pidx_key(branch_id, first_removed_pgno),
		&0_u64.to_be_bytes(),
	)?;
	cleanup.deleted_bytes = pidx_count_suffix_clear
		.removed_rows
		.checked_mul(pidx_row_size)
		.context("sqlite truncate PIDX quota bytes overflowed")?;
	cleanup.pidx_count_suffix_clear = Some(pidx_count_suffix_clear);

	let pidx_prefix = keys::branch_pidx_prefix(branch_id);
	cleanup.clear_ranges.push((
		keys::branch_pidx_key(branch_id, first_removed_pgno),
		prefix_range_end(&pidx_prefix),
	));

	let boundary_shard_id = new_db_size_pages / SHARD_SIZE;
	let first_removed_shard_id = boundary_shard_id
		.checked_add(1)
		.context("sqlite truncate shard id overflowed")?;
	let shard_prefix = keys::branch_shard_prefix(branch_id);
	cleanup.clear_ranges.push((
		keys::branch_shard_version_prefix(branch_id, first_removed_shard_id),
		prefix_range_end(&shard_prefix),
	));
	let shard_chunks_prefix = keys::branch_shard_chunks_prefix(branch_id);
	cleanup.clear_ranges.push((
		keys::branch_shard_chunk_shard_prefix(branch_id, first_removed_shard_id),
		prefix_range_end(&shard_chunks_prefix),
	));

	// A coverage proof is valid only while the corresponding materialized shard remains a valid
	// cache image. Invalidate the boundary shard and the contiguous suffix with two range clears;
	// this remains O(1) even when a truncate removes billions of pages. Historical correctness is
	// still provided by DELTA/cold generations, as with the SHARD cache rows cleared above.
	let boundary_coverage =
		keys::branch_compaction_hot_shard_coverage_version_prefix(branch_id, boundary_shard_id);
	cleanup.clear_ranges.push((
		boundary_coverage.clone(),
		prefix_range_end(&boundary_coverage),
	));
	let coverage_prefix = keys::branch_compaction_hot_shard_coverage_prefix(branch_id);
	cleanup.clear_ranges.push((
		keys::branch_compaction_hot_shard_coverage_version_prefix(
			branch_id,
			first_removed_shard_id,
		),
		prefix_range_end(&coverage_prefix),
	));

	if let Some((key, value)) = tx_read_latest_prefix_value(
		tx,
		&keys::branch_shard_version_prefix(branch_id, boundary_shard_id),
	)
	.await?
	{
		let (shard_id, as_of_txid) = keys::decode_branch_shard_key(branch_id, &key)?;
		ensure!(
			shard_id == boundary_shard_id,
			"sqlite truncate boundary scan returned a different shard"
		);
		let observed =
			collect_observed_shard_row(tx, branch_id, shard_id, as_of_txid, key, value).await?;
		let resolved = resolve_branch_shard_value(
			tx,
			branch_id,
			shard_id,
			as_of_txid,
			&observed.canonical.value,
			universaldb::utils::IsolationLevel::Snapshot,
		)
		.await
		.context("resolve chunked sqlite boundary shard after truncate")?;
		let pruned_value = prune_truncated_shard_value(&resolved, new_db_size_pages)
			.context("prune sqlite boundary shard after truncate")?;
		if let Some(pruned_value) = pruned_value {
			// SHARD rows are derived cache artifacts. Replace only the latest
			// authoritative cache image and discard older boundary-shard cache
			// generations with two O(1) FDB range clears. Historical reads remain
			// backed by retained DELTA/cold generations and their pins.
			let boundary_versions = keys::branch_shard_version_prefix(branch_id, boundary_shard_id);
			cleanup.clear_ranges.push((
				boundary_versions.clone(),
				prefix_range_end(&boundary_versions),
			));
			let boundary_chunks =
				keys::branch_shard_chunk_shard_prefix(branch_id, boundary_shard_id);
			cleanup
				.clear_ranges
				.push((boundary_chunks.clone(), prefix_range_end(&boundary_chunks)));
			if !pruned_value.is_empty() {
				let rows = branch_shard_blob_rows(branch_id, shard_id, as_of_txid, &pruned_value)?;
				cleanup.shard_writes.push((observed, rows));
			} else {
				cleanup.shard_clears.push(observed);
			}
		}
	}

	Ok(cleanup)
}

fn prefix_range_end(prefix: &[u8]) -> Vec<u8> {
	universaldb::utils::end_of_prefix_range(prefix)
}

async fn collect_observed_shard_row(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	shard_id: u32,
	as_of_txid: u64,
	key: Vec<u8>,
	value: Vec<u8>,
) -> Result<ObservedShardRow> {
	let mut chunks = Vec::new();
	if let Ok(manifest) = decode_hot_shard_manifest(&value) {
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
			let chunk_key =
				keys::branch_shard_chunk_key(branch_id, shard_id, as_of_txid, chunk_idx);
			let chunk_value = tx_get_value(
				tx,
				&chunk_key,
				universaldb::utils::IsolationLevel::Snapshot,
			)
			.await?
			.with_context(|| {
				format!(
					"sqlite hot shard chunk missing during truncate for shard {shard_id} txid {as_of_txid} chunk {chunk_idx}"
				)
			})?;
			chunks.push(ObservedCleanupRow {
				key: chunk_key,
				value: chunk_value,
			});
		}
	}

	Ok(ObservedShardRow {
		canonical: ObservedCleanupRow { key, value },
		chunks,
	})
}

pub(super) async fn fence_truncate_cleanup_row(
	tx: &universaldb::Transaction,
	row: &ObservedCleanupRow,
) -> Result<()> {
	let current = tx_get_value(tx, &row.key, Serializable).await?;
	if current.as_deref() != Some(row.value.as_slice()) {
		return Err(DatabaseError::NotCommitted.into());
	}

	Ok(())
}

async fn fence_truncate_shard_row(
	tx: &universaldb::Transaction,
	row: &ObservedShardRow,
) -> Result<()> {
	fence_truncate_cleanup_row(tx, &row.canonical).await?;
	for chunk in &row.chunks {
		fence_truncate_cleanup_row(tx, chunk).await?;
	}
	Ok(())
}

pub(super) async fn apply_truncate_shard_cleanup(
	tx: &universaldb::Transaction,
	cleanup: &TruncateCleanup,
) -> Result<()> {
	if let Some(plan) = &cleanup.pidx_count_suffix_clear {
		quota::apply_pidx_count_suffix_clear(tx, plan);
	}
	// Fence every materialized row before issuing a boundary range clear. This
	// preserves the retry-on-concurrent-rewrite behavior without reading our own
	// clear through FDB's read-your-writes view.
	for row in &cleanup.shard_clears {
		fence_truncate_shard_row(tx, row).await?;
	}
	for (row, _) in &cleanup.shard_writes {
		fence_truncate_shard_row(tx, row).await?;
	}
	for (begin, end) in &cleanup.clear_ranges {
		tx.informal().clear_range(begin, end);
	}
	for row in &cleanup.shard_clears {
		for chunk in &row.chunks {
			tx.informal().clear(&chunk.key);
		}
		tx.informal().clear(&row.canonical.key);
	}
	for (row, replacement_rows) in &cleanup.shard_writes {
		for chunk in &row.chunks {
			tx.informal().clear(&chunk.key);
		}
		for (key, value) in replacement_rows {
			tx.informal().set(key, value);
		}
	}
	Ok(())
}

fn prune_truncated_shard_value(value: &[u8], new_db_size_pages: u32) -> Result<Option<Vec<u8>>> {
	let decoded = decode_ltx_v3(value).context("decode sqlite boundary shard")?;
	let original_page_count = decoded.pages.len();
	let live_pages = decoded
		.pages
		.into_iter()
		.filter(|page| page.pgno <= new_db_size_pages)
		.collect::<Vec<_>>();
	if live_pages.len() == original_page_count {
		return Ok(None);
	}
	if live_pages.is_empty() {
		return Ok(Some(Vec::new()));
	}

	encode_ltx_v3(decoded.header, &live_pages)
		.context("encode pruned sqlite boundary shard")
		.map(Some)
}
