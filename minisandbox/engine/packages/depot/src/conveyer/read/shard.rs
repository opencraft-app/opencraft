use anyhow::{Context, Result, ensure};
use futures_util::{TryStreamExt, future::try_join_all, try_join};
use universaldb::{
	RangeOption,
	options::StreamingMode,
	utils::{IsolationLevel::Serializable, end_of_key_range},
};

use crate::conveyer::{
	db::LtxBlobCache,
	keys,
	shard_blob::resolve_branch_shard_value,
	types::{
		ColdShardRef, HotShardCoverage, decode_cold_publish_marker, decode_cold_shard_ref,
		decode_compaction_root, decode_hot_shard_coverage,
	},
};

#[cfg(debug_assertions)]
use super::plan::BranchSource;
use super::plan::{ReadSource, StorageScope};

/// Resolve one branch-local shard at a capped txid using the same hot-vs-cold publication rules as
/// the production page path. Debug/PITR callers use this instead of growing a second selector that
/// can silently diverge after hot eviction.
#[cfg(debug_assertions)]
pub(crate) async fn tx_load_capped_branch_shard_source(
	tx: &universaldb::Transaction,
	branch_id: crate::conveyer::types::DatabaseBranchId,
	max_txid: u64,
	shard_id: u32,
) -> Result<Option<ShardSource>> {
	let load = tx_load_source_shard_blob(
		tx,
		ReadSource::Branch(BranchSource {
			branch_id,
			max_txid,
		}),
		shard_id,
	)
	.await?;
	ensure!(
		!load.coverage_missing,
		"published sqlite shard coverage is missing for branch {branch_id:?} shard {shard_id}"
	);
	Ok(load.source)
}

pub(super) async fn tx_load_delta_blob(
	tx: &universaldb::Transaction,
	delta_prefix: &[u8],
	cache: &LtxBlobCache,
) -> Result<DeltaBlobLoad> {
	// Serve immutable delta blobs from the per-database cache without re-fetching
	// from FDB. The delta prefix includes the owning txid, so the key uniquely
	// identifies immutable content.
	if let Some(cached) = cache.get(delta_prefix).await {
		return Ok(DeltaBlobLoad {
			blob: Some(cached.bytes().to_vec()),
			chunk_rows_scanned: 0,
		});
	}

	let delta_chunks = super::tx::tx_scan_prefix_values(tx, delta_prefix).await?;
	if delta_chunks.is_empty() {
		return Ok(DeltaBlobLoad {
			blob: None,
			chunk_rows_scanned: 0,
		});
	}
	let chunk_rows_scanned = delta_chunks.len();

	// FDB returns rows in key order, and the chunk index is the big-endian u32
	// key suffix, so the natural scan order already matches chunk order. The
	// contiguity check below relies on that order without re-sorting.
	let mut delta_blob = Vec::new();
	for (expected_idx, (key, chunk)) in delta_chunks.into_iter().enumerate() {
		let chunk_idx = decode_delta_chunk_idx(delta_prefix, &key)?;
		ensure!(
			chunk_idx == u32::try_from(expected_idx).unwrap_or(u32::MAX),
			"sqlite delta chunks must be contiguous from chunk 0"
		);
		delta_blob.extend_from_slice(&chunk);
	}

	Ok(DeltaBlobLoad {
		blob: Some(delta_blob),
		chunk_rows_scanned,
	})
}

pub(super) struct DeltaBlobLoad {
	pub(super) blob: Option<Vec<u8>>,
	pub(super) chunk_rows_scanned: usize,
}

fn decode_delta_chunk_idx(delta_prefix: &[u8], key: &[u8]) -> Result<u32> {
	let suffix = key
		.strip_prefix(delta_prefix)
		.context("sqlite delta chunk key did not start with expected prefix")?;
	ensure!(
		suffix.len() == std::mem::size_of::<u32>(),
		"sqlite delta chunk key suffix had {} bytes, expected {}",
		suffix.len(),
		std::mem::size_of::<u32>()
	);

	Ok(u32::from_be_bytes(suffix.try_into().context(
		"sqlite delta chunk suffix should decode as u32",
	)?))
}

pub(super) async fn tx_load_latest_shard_blob(
	tx: &universaldb::Transaction,
	scope: &StorageScope,
	shard_id: u32,
) -> Result<ShardBlobLoad> {
	let StorageScope::Branch(plan) = scope;

	// Scan every source's latest shard version concurrently. Each scan is a
	// reverse range limited to one row, so it reads only the newest version at or
	// below the source's cap instead of streaming every historical version.
	let per_source = try_join_all(
		plan.sources
			.iter()
			.map(|source| tx_load_source_shard_blob(tx, *source, shard_id)),
	)
	.await?;

	// Sources are ordered most specific first, so the first source with a hit
	// wins, matching the sequential fallback order.
	let mut hot_rows_scanned = 0usize;
	let mut cold_rows_scanned = 0usize;
	let mut latest = None;
	let mut coverage_missing = false;
	let mut resolved = false;
	for load in per_source {
		hot_rows_scanned += load.hot_rows_scanned;
		cold_rows_scanned += load.cold_rows_scanned;
		if !resolved && (load.source.is_some() || load.coverage_missing) {
			latest = load.source;
			coverage_missing = load.coverage_missing;
			resolved = true;
		}
	}

	Ok(ShardBlobLoad {
		source: latest,
		coverage_missing,
		hot_rows_scanned,
		cold_rows_scanned,
	})
}

async fn tx_load_source_shard_blob(
	tx: &universaldb::Transaction,
	source: ReadSource,
	shard_id: u32,
) -> Result<SourceShardBlobLoad> {
	let ReadSource::Branch(source) = source;
	let coverage =
		tx_load_source_hot_shard_coverage(tx, source.branch_id, source.max_txid, shard_id).await?;
	// A proof is the atomic authority, while SHARD rows are prepublished derived artifacts. Cap
	// both backing-tier lookups at the proof so an orphan row from a rejected job cannot win.
	let artifact_max_txid = coverage
		.as_ref()
		.map(|coverage| coverage.as_of_txid)
		.unwrap_or(source.max_txid);
	let (hot, cold) = try_join!(
		tx_load_source_hot_shard_blob(tx, source.branch_id, artifact_max_txid, shard_id),
		tx_load_source_cold_shard_ref(tx, source.branch_id, artifact_max_txid, shard_id),
	)?;
	let mut selected = match (hot.source, cold.source) {
		(Some(hot), Some(cold)) if cold.reference.as_of_txid > hot.as_of_txid => {
			Some(ShardSource::Cold(cold))
		}
		(Some(hot), _) => Some(ShardSource::Hot(hot)),
		(None, Some(cold)) => Some(ShardSource::Cold(cold)),
		(None, None) => None,
	};
	let coverage_missing = coverage.as_ref().is_some_and(|coverage| {
		!selected
			.as_ref()
			.is_some_and(|source| source_matches_hot_coverage(source, coverage))
	});
	if coverage_missing {
		selected = None;
	}

	Ok(SourceShardBlobLoad {
		source: selected,
		coverage_missing,
		hot_rows_scanned: hot.rows_scanned,
		cold_rows_scanned: cold.rows_scanned,
	})
}

fn source_matches_hot_coverage(source: &ShardSource, coverage: &HotShardCoverage) -> bool {
	if source.shard_id() != coverage.shard_id || source.as_of_txid() != coverage.as_of_txid {
		return false;
	}
	match source {
		ShardSource::Hot(source) => {
			u64::try_from(source.blob.len()).ok() == Some(coverage.size_bytes)
				&& crate::compaction::shared::content_hash(&source.blob) == coverage.content_hash
		}
		ShardSource::Cold(source) => {
			source.reference.ltx_size_bytes == coverage.size_bytes
				&& source.reference.ltx_content_hash == coverage.content_hash
		}
	}
}

async fn tx_load_source_hot_shard_coverage(
	tx: &universaldb::Transaction,
	branch_id: crate::conveyer::types::DatabaseBranchId,
	max_txid: u64,
	shard_id: u32,
) -> Result<Option<HotShardCoverage>> {
	let prefix = keys::branch_compaction_hot_shard_coverage_version_prefix(branch_id, shard_id);
	let end_key = keys::branch_compaction_hot_shard_coverage_key(branch_id, shard_id, max_txid);
	let end = end_of_key_range(&end_key);
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Iterator,
			reverse: true,
			limit: Some(1),
			..(prefix.as_slice(), end.as_slice()).into()
		},
		Serializable,
	);

	let Some(entry) = stream.try_next().await? else {
		return Ok(None);
	};
	let key = entry.key().to_vec();
	let (decoded_shard_id, as_of_txid) =
		keys::decode_branch_compaction_hot_shard_coverage_key(branch_id, &key)?;
	let coverage = decode_hot_shard_coverage(entry.value())
		.context("decode sqlite hot shard coverage selected for read")?;
	ensure!(
		decoded_shard_id == shard_id
			&& coverage.database_branch_id == branch_id
			&& coverage.shard_id == shard_id
			&& coverage.as_of_txid == as_of_txid
			&& coverage.as_of_txid <= max_txid,
		"sqlite hot shard coverage identity is outside requested source bounds"
	);
	Ok(Some(coverage))
}

async fn tx_load_source_hot_shard_blob(
	tx: &universaldb::Transaction,
	branch_id: crate::conveyer::types::DatabaseBranchId,
	max_txid: u64,
	shard_id: u32,
) -> Result<HotShardBlobLoad> {
	let prefix = keys::branch_shard_version_prefix(branch_id, shard_id);
	let end_key = keys::branch_shard_key(branch_id, shard_id, max_txid);
	let end = end_of_key_range(&end_key);

	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Iterator,
			reverse: true,
			limit: Some(1),
			..(prefix.as_slice(), end.as_slice()).into()
		},
		// TODO: This can probably be made Snapshot again to reduce contention if
		// read side freshness is not worth the cost.
		Serializable,
	);

	let mut rows_scanned = 0usize;
	let mut latest = None;
	while let Some(entry) = stream.try_next().await? {
		rows_scanned += 1;
		let key = entry.key().to_vec();
		let (decoded_shard_id, as_of_txid) = keys::decode_branch_shard_key(branch_id, &key)?;
		ensure!(
			decoded_shard_id == shard_id && as_of_txid <= max_txid,
			"sqlite hot shard row is outside requested source bounds"
		);
		latest = Some(HotShardSource {
			shard_id,
			as_of_txid,
			key,
			blob: resolve_branch_shard_value(
				tx,
				branch_id,
				shard_id,
				as_of_txid,
				entry.value(),
				Serializable,
			)
			.await
			.context("resolve chunked sqlite hot shard")?,
		});
	}

	Ok(HotShardBlobLoad {
		source: latest,
		rows_scanned,
	})
}

async fn tx_load_source_cold_shard_ref(
	tx: &universaldb::Transaction,
	branch_id: crate::conveyer::types::DatabaseBranchId,
	max_txid: u64,
	shard_id: u32,
) -> Result<ColdShardRefLoad> {
	let Some(root_bytes) =
		super::tx::tx_get_value(tx, &keys::branch_compaction_root_key(branch_id)).await?
	else {
		return Ok(ColdShardRefLoad::default());
	};
	let root = decode_compaction_root(&root_bytes).context("decode cold-read compaction root")?;
	let max_txid = max_txid.min(root.cold_watermark_txid);
	if max_txid == 0 {
		return Ok(ColdShardRefLoad::default());
	}

	let prefix = keys::branch_compaction_cold_shard_version_prefix(branch_id, shard_id);
	let end_key = keys::branch_compaction_cold_shard_key(branch_id, shard_id, max_txid);
	let end = end_of_key_range(&end_key);
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Iterator,
			reverse: true,
			limit: Some(1),
			..(prefix.as_slice(), end.as_slice()).into()
		},
		Serializable,
	);

	let mut rows_scanned = 0usize;
	let mut latest = None;
	while let Some(entry) = stream.try_next().await? {
		rows_scanned += 1;
		let ref_key = entry.key().to_vec();
		let encoded_ref = entry.value().to_vec();
		let reference = decode_cold_shard_ref(&encoded_ref)
			.context("decode exact cold shard ref selected for read")?;
		ensure!(
			reference.database_branch_id == branch_id,
			"cold shard ref branch identity mismatch"
		);
		ensure!(
			reference.shard_id == shard_id,
			"cold shard ref shard identity mismatch"
		);
		ensure!(
			reference.as_of_txid <= max_txid && reference.as_of_txid <= root.cold_watermark_txid,
			"cold shard ref exceeds read or published watermark"
		);
		ensure!(
			reference.max_txid == reference.as_of_txid,
			"cold shard ref max txid does not match as-of txid"
		);
		ensure!(
			reference.publish_generation <= root.manifest_generation,
			"cold shard ref publish generation exceeds manifest"
		);
		let marker_key =
			keys::branch_compaction_cold_publish_key(branch_id, reference.publish_generation);
		let marker_bytes = super::tx::tx_get_value(tx, &marker_key)
			.await?
			.context("cold shard ref is missing its atomic publication marker")?;
		let marker = decode_cold_publish_marker(&marker_bytes)
			.context("decode atomic cold publication marker")?;
		ensure!(
			marker.matches_ref(&reference),
			"cold shard ref does not match its atomic publication marker"
		);
		ensure!(
			ref_key
				== keys::branch_compaction_cold_shard_key(
					branch_id,
					shard_id,
					reference.as_of_txid,
				),
			"cold shard ref key does not match its encoded identity"
		);
		latest = Some(ColdShardSource {
			ref_key,
			encoded_ref,
			reference,
		});
	}

	Ok(ColdShardRefLoad {
		source: latest,
		rows_scanned,
	})
}

struct SourceShardBlobLoad {
	source: Option<ShardSource>,
	coverage_missing: bool,
	hot_rows_scanned: usize,
	cold_rows_scanned: usize,
}

struct HotShardBlobLoad {
	source: Option<HotShardSource>,
	rows_scanned: usize,
}

#[derive(Default)]
struct ColdShardRefLoad {
	source: Option<ColdShardSource>,
	rows_scanned: usize,
}

#[derive(Clone)]
pub(crate) enum ShardSource {
	Hot(HotShardSource),
	Cold(ColdShardSource),
}

impl ShardSource {
	pub(super) fn shard_id(&self) -> u32 {
		match self {
			Self::Hot(source) => source.shard_id,
			Self::Cold(source) => source.reference.shard_id,
		}
	}

	pub(super) fn as_of_txid(&self) -> u64 {
		match self {
			Self::Hot(source) => source.as_of_txid,
			Self::Cold(source) => source.reference.as_of_txid,
		}
	}

	pub(crate) fn source_key(&self) -> Vec<u8> {
		match self {
			Self::Hot(source) => source.key.clone(),
			Self::Cold(source) => keys::branch_shard_key(
				source.reference.database_branch_id,
				source.reference.shard_id,
				source.reference.as_of_txid,
			),
		}
	}
}

#[derive(Clone)]
pub(crate) struct HotShardSource {
	pub(crate) shard_id: u32,
	pub(crate) as_of_txid: u64,
	pub(crate) key: Vec<u8>,
	pub(crate) blob: Vec<u8>,
}

#[derive(Clone)]
pub(crate) struct ColdShardSource {
	pub(crate) ref_key: Vec<u8>,
	pub(crate) encoded_ref: Vec<u8>,
	pub(crate) reference: ColdShardRef,
}

pub(super) struct ShardBlobLoad {
	pub(super) source: Option<ShardSource>,
	pub(super) coverage_missing: bool,
	pub(super) hot_rows_scanned: usize,
	pub(super) cold_rows_scanned: usize,
}
