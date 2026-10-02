//! Debug-only diagnostics for PITR and branch state.

use std::collections::BTreeMap;

use anyhow::{Context, Result, ensure};
use futures_util::{StreamExt, TryStreamExt, stream};
use universaldb::{RangeOption, options::StreamingMode, utils::IsolationLevel::Snapshot};

use crate::{
	conveyer::{
		Db, branch,
		constants::{MAX_DELTA_CHUNKS_PER_COMMIT, MAX_RESTORE_POINTS_PER_BUCKET},
		db::load_branch_ancestry,
		keys,
		ltx::{DecodedLtx, decode_ltx_v3},
		read::{ShardSource, hydrate_cold_source, tx_load_capped_branch_shard_source},
		types::{
			CommitRow, DatabaseBranchId, FetchedPage, RestorePointIndexEntry,
			SQLITE_STORAGE_COLD_SCHEMA_VERSION, decode_commit_row, decode_restore_point_record,
		},
	},
	gc,
};

/// A debug full-state read still returns every page to its caller, but each FDB transaction is
/// bounded independently of database size and age. Four worst-case 320-page DELTAs stay below
/// FoundationDB's 10 MiB transaction-size limit with room for keys and metadata.
const DEBUG_READ_PAGE_BATCH_SIZE: u32 = 4;
const DEBUG_POINT_READ_CONCURRENCY: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchPins {
	pub branch_id: DatabaseBranchId,
	pub refcount: i64,
	pub desc_pin: [u8; 16],
	pub restore_point_pin: [u8; 16],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageState {
	pub branch_id: DatabaseBranchId,
	pub txid: u64,
	pub versionstamp: [u8; 16],
	pub db_size_pages: u32,
	pub pages: Vec<FetchedPage>,
}

#[derive(Debug, Clone, Copy)]
struct DebugReadSource {
	branch_id: DatabaseBranchId,
	max_txid: u64,
}

pub async fn dump_database_ancestry(db: &Db) -> Result<Vec<(DatabaseBranchId, Option<[u8; 16]>)>> {
	let branch_id = resolve_current_branch(db).await?;
	let ancestry = db
		.udb
		.txn("depot_debug_dump_ancestry", move |tx| async move {
			load_branch_ancestry(&tx, branch_id).await
		})
		.await?;

	Ok(ancestry
		.ancestors
		.into_iter()
		.map(|ancestor| (ancestor.branch_id, ancestor.parent_versionstamp_cap))
		.collect())
}

pub async fn dump_branch_pins(db: &Db) -> Result<BranchPins> {
	let branch_id = resolve_current_branch(db).await?;
	let pin = gc::estimate_branch_gc_pin(&db.udb, branch_id)
		.await?
		.context("sqlite branch was missing while dumping pins")?;

	Ok(BranchPins {
		branch_id,
		refcount: pin.refcount,
		desc_pin: pin.desc_pin,
		restore_point_pin: pin.restore_point_pin,
	})
}

pub async fn list_restore_points(db: &Db) -> Result<Vec<RestorePointIndexEntry>> {
	let database_id = db.database_id.clone();

	db.udb
		.txn("depot_debug_list_restore_points", move |tx| {
			let database_id = database_id.clone();

			async move {
				let mut entries = Vec::new();
				for (_key, value) in scan_prefix_limited(
					&tx,
					&keys::restore_point_prefix(&database_id),
					MAX_RESTORE_POINTS_PER_BUCKET as usize,
					"restore points",
				)
				.await?
				{
					let record = decode_restore_point_record(&value)
						.context("decode sqlite restore point record for debug listing")?;
					entries.push(RestorePointIndexEntry {
						schema_version: SQLITE_STORAGE_COLD_SCHEMA_VERSION,
						restore_point_id: record.restore_point_id,
						pin_object_key: record.pin_object_key,
						pin_status: record.status,
						created_at_ms: record.created_at_ms,
					});
				}
				entries.sort_by(|a, b| a.restore_point_id.cmp(&b.restore_point_id));

				Ok(entries)
			}
		})
		.await
}

pub async fn estimate_gc_pin(db: &Db) -> Result<[u8; 16]> {
	let branch_id = resolve_current_branch(db).await?;
	Ok(gc::estimate_branch_gc_pin(&db.udb, branch_id)
		.await?
		.context("sqlite branch was missing while estimating GC pin")?
		.gc_pin)
}

pub async fn read_at(db: &Db, versionstamp: [u8; 16]) -> Result<PageState> {
	let root_branch_id = resolve_current_branch(db).await?;
	let branch_id_for_tx = root_branch_id;
	let read_plan = db
		.udb
		.txn("depot_debug_read_at", move |tx| async move {
			let ancestry = load_branch_ancestry(&tx, branch_id_for_tx).await?;
			let mut target = None;
			for (idx, ancestor) in ancestry.ancestors.iter().enumerate() {
				if ancestor
					.parent_versionstamp_cap
					.is_some_and(|cap| versionstamp > cap)
				{
					continue;
				}
				let Some(txid) = lookup_vtx_txid(&tx, ancestor.branch_id, versionstamp).await?
				else {
					continue;
				};
				target = Some((idx, *ancestor, txid));
				break;
			}
			let (target_idx, target_ancestor, target_txid) =
				target.context("sqlite versionstamp was not reachable from database branch")?;
			let commit = read_commit_row(&tx, target_ancestor.branch_id, target_txid)
				.await?
				.context("sqlite commit row was missing for debug read_at")?;

			let mut sources = Vec::new();
			for (idx, ancestor) in ancestry.ancestors[target_idx..].iter().enumerate() {
				let max_txid = if idx == 0 {
					target_txid
				} else {
					let cap = ancestor
						.parent_versionstamp_cap
						.context("sqlite ancestor cap is missing")?;
					lookup_vtx_txid(&tx, ancestor.branch_id, cap)
						.await?
						.context("sqlite ancestor cap VTX row is missing")?
				};
				sources.push(DebugReadSource {
					branch_id: ancestor.branch_id,
					max_txid,
				});
			}

			Ok(DebugReadPlan {
				branch_id: target_ancestor.branch_id,
				txid: target_txid,
				versionstamp,
				db_size_pages: commit.db_size_pages,
				sources,
			})
		})
		.await?;

	let mut pages = Vec::with_capacity(
		usize::try_from(read_plan.db_size_pages).context("debug page count exceeded usize")?,
	);
	// Page batches are deliberately tiny for FDB transaction safety, but a shard spans many
	// batches. Retain only the last immutable shard so sequential full-state reads perform one COS
	// GET/decode per shard without growing an unbounded second copy of the database in memory.
	let mut last_shard = None::<(Vec<u8>, DecodedLtx)>;
	let mut first_pgno = 1_u32;
	while first_pgno <= read_plan.db_size_pages {
		let last_pgno = first_pgno
			.saturating_add(DEBUG_READ_PAGE_BATCH_SIZE - 1)
			.min(read_plan.db_size_pages);
		let pgnos = (first_pgno..=last_pgno).collect::<Vec<_>>();
		let pgnos_for_tx = pgnos.clone();
		let sources = read_plan.sources.clone();
		let mut loaded = db
			.udb
			.txn("depot_debug_read_at_page_batch", move |tx| {
				let pgnos = pgnos_for_tx.clone();
				let sources = sources.clone();
				async move { load_page_sources(&tx, &pgnos, &sources).await }
			})
			.await?;
		hydrate_debug_shards(db, &mut loaded, &mut last_shard).await?;
		pages.extend(fill_missing_pages(&pgnos, loaded.pages));
		if last_pgno == u32::MAX {
			break;
		}
		first_pgno = last_pgno + 1;
	}

	Ok(PageState {
		branch_id: read_plan.branch_id,
		txid: read_plan.txid,
		versionstamp: read_plan.versionstamp,
		db_size_pages: read_plan.db_size_pages,
		pages,
	})
}

struct DebugReadPlan {
	branch_id: DatabaseBranchId,
	txid: u64,
	versionstamp: [u8; 16],
	db_size_pages: u32,
	sources: Vec<DebugReadSource>,
}

async fn resolve_current_branch(db: &Db) -> Result<DatabaseBranchId> {
	let bucket_id = db.sqlite_bucket_id();
	let database_id = db.database_id.clone();
	db.udb
		.txn("depot_debug_resolve_current_branch", move |tx| {
			let database_id = database_id.clone();

			async move {
				branch::resolve_database_branch(&tx, bucket_id, &database_id, Snapshot)
					.await?
					.context("sqlite database branch is missing")
			}
		})
		.await
}

struct DebugPageBatchLoad {
	pages: BTreeMap<u32, Option<Vec<u8>>>,
	shards: Vec<(Vec<u32>, ShardSource)>,
}

async fn load_page_sources(
	tx: &universaldb::Transaction,
	pgnos: &[u32],
	sources: &[DebugReadSource],
) -> Result<DebugPageBatchLoad> {
	let mut pages = pgnos
		.iter()
		.copied()
		.map(|pgno| (pgno, None))
		.collect::<BTreeMap<_, _>>();

	for source in sources {
		let unresolved = pgnos
			.iter()
			.copied()
			.filter(|pgno| !pages.get(pgno).is_some_and(Option::is_some))
			.collect::<Vec<_>>();
		for (pgno, bytes) in tx_load_latest_delta_pages(tx, *source, &unresolved).await? {
			pages.insert(pgno, Some(bytes));
		}
	}

	let mut pgnos_by_shard = BTreeMap::<u32, Vec<u32>>::new();
	for pgno in pgnos.iter().copied() {
		if !pages.get(&pgno).is_some_and(Option::is_some) {
			pgnos_by_shard
				.entry(pgno / keys::SHARD_SIZE)
				.or_default()
				.push(pgno);
		}
	}
	let mut shards = Vec::with_capacity(pgnos_by_shard.len());
	for (shard_id, shard_pgnos) in pgnos_by_shard {
		if let Some(source) = tx_load_latest_shard_source(tx, sources, shard_id).await? {
			shards.push((shard_pgnos, source));
		}
	}

	Ok(DebugPageBatchLoad { pages, shards })
}

async fn hydrate_debug_shards(
	db: &Db,
	loaded: &mut DebugPageBatchLoad,
	last_shard: &mut Option<(Vec<u8>, DecodedLtx)>,
) -> Result<()> {
	for (pgnos, source) in loaded.shards.drain(..) {
		let source_key = source.source_key();
		if !last_shard
			.as_ref()
			.is_some_and(|(cached_key, _)| cached_key == &source_key)
		{
			let shard_id = match &source {
				ShardSource::Hot(source) => source.shard_id,
				ShardSource::Cold(source) => source.reference.shard_id,
			};
			let blob = match source {
				ShardSource::Hot(source) => source.blob,
				ShardSource::Cold(source) => {
					hydrate_cold_source(
						&db.udb,
						db.cold_tier.as_ref(),
						&source,
						false,
						&db.node_id.to_string(),
					)
					.await?
				}
			};
			let decoded = decode_ltx_v3(&blob)
				.with_context(|| format!("decode sqlite debug shard {shard_id}"))?;
			*last_shard = Some((source_key.clone(), decoded));
		}
		let decoded = &last_shard
			.as_ref()
			.context("debug shard cache should contain selected source")?
			.1;
		for pgno in pgnos {
			if let Some(bytes) = decoded.get_page(pgno) {
				loaded.pages.insert(pgno, Some(bytes.to_vec()));
			}
		}
	}
	Ok(())
}

fn fill_missing_pages(
	pgnos: &[u32],
	mut pages: BTreeMap<u32, Option<Vec<u8>>>,
) -> Vec<FetchedPage> {
	pgnos
		.iter()
		.copied()
		.map(|pgno| FetchedPage {
			pgno,
			bytes: Some(
				pages
					.remove(&pgno)
					.flatten()
					.unwrap_or_else(|| vec![0; keys::PAGE_SIZE as usize]),
			),
		})
		.collect()
}

async fn read_commit_row(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	txid: u64,
) -> Result<Option<CommitRow>> {
	let Some(bytes) = tx_get_value(tx, &keys::branch_commit_key(branch_id, txid)).await? else {
		return Ok(None);
	};

	Ok(Some(
		decode_commit_row(&bytes).context("decode sqlite commit row for debug read")?,
	))
}

async fn lookup_vtx_txid(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	versionstamp: [u8; 16],
) -> Result<Option<u64>> {
	let Some(bytes) = tx_get_value(tx, &keys::branch_vtx_key(branch_id, versionstamp)).await?
	else {
		return Ok(None);
	};
	let bytes: [u8; std::mem::size_of::<u64>()] = bytes
		.as_slice()
		.try_into()
		.context("sqlite VTX entry should be exactly 8 bytes")?;

	Ok(Some(u64::from_be_bytes(bytes)))
}

async fn tx_get_value(tx: &universaldb::Transaction, key: &[u8]) -> Result<Option<Vec<u8>>> {
	Ok(tx.informal().get(key, Snapshot).await?.map(Vec::<u8>::from))
}

async fn scan_prefix_limited(
	tx: &universaldb::Transaction,
	prefix: &[u8],
	limit: usize,
	label: &str,
) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Exact,
			limit: Some(limit.saturating_add(1)),
			..RangeOption::from(universaldb::utils::range_for_prefix(prefix))
		},
		Snapshot,
	);
	let mut rows = Vec::new();

	while let Some(entry) = stream.try_next().await? {
		rows.push((entry.key().to_vec(), entry.value().to_vec()));
	}
	ensure!(
		rows.len() <= limit,
		"sqlite debug {label} scan exceeded its {limit}-row safety cap"
	);

	Ok(rows)
}

async fn tx_load_latest_delta_pages(
	tx: &universaldb::Transaction,
	source: DebugReadSource,
	pgnos: &[u32],
) -> Result<BTreeMap<u32, Vec<u8>>> {
	if pgnos.is_empty() {
		return Ok(BTreeMap::new());
	}
	let complete_bytes = tx_get_value(
		tx,
		&keys::branch_page_history_complete_txid_key(source.branch_id),
	)
	.await?
	.context("sqlite debug page-history index is not initialized")?;
	let complete_bytes: [u8; std::mem::size_of::<u64>()] = complete_bytes
		.as_slice()
		.try_into()
		.context("sqlite debug page-history watermark should be exactly 8 bytes")?;
	let complete_txid = u64::from_be_bytes(complete_bytes);
	ensure!(
		complete_txid >= source.max_txid,
		"sqlite debug page-history index is incomplete through capped txid {}; indexed through {}",
		source.max_txid,
		complete_txid,
	);

	let lookups = stream::iter(pgnos.iter().copied())
		.map(|pgno| async move {
			let prefix = keys::branch_page_history_page_prefix(source.branch_id, pgno);
			let mut end = keys::branch_page_history_key(source.branch_id, pgno, source.max_txid);
			end.push(0);
			let informal = tx.informal();
			let mut rows = informal.get_ranges_keyvalues(
				RangeOption {
					mode: StreamingMode::Iterator,
					reverse: true,
					limit: Some(1),
					..(prefix.as_slice(), end.as_slice()).into()
				},
				Snapshot,
			);
			let txid = rows
				.try_next()
				.await?
				.map(|row| keys::decode_branch_page_history_txid(source.branch_id, pgno, row.key()))
				.transpose()?;
			Ok::<_, anyhow::Error>((pgno, txid))
		})
		.buffer_unordered(DEBUG_POINT_READ_CONCURRENCY)
		.try_collect::<Vec<_>>()
		.await?;

	let mut pgnos_by_txid = BTreeMap::<u64, Vec<u32>>::new();
	for (pgno, txid) in lookups {
		if let Some(txid) = txid {
			ensure!(
				txid <= source.max_txid,
				"debug page-history lookup exceeded cap"
			);
			pgnos_by_txid.entry(txid).or_default().push(pgno);
		}
	}

	let mut pages = BTreeMap::new();
	for (txid, txid_pgnos) in pgnos_by_txid {
		let prefix = keys::branch_delta_chunk_prefix(source.branch_id, txid);
		let chunks = scan_prefix_limited(
			tx,
			&prefix,
			MAX_DELTA_CHUNKS_PER_COMMIT,
			"exact DELTA chunks",
		)
		.await?;
		ensure!(
			!chunks.is_empty(),
			"sqlite debug page-history row points at a missing DELTA"
		);
		let mut blob = Vec::new();
		for (expected_idx, (key, chunk)) in chunks.into_iter().enumerate() {
			let chunk_idx = keys::decode_branch_delta_chunk_idx(source.branch_id, txid, &key)?;
			ensure!(
				chunk_idx == u32::try_from(expected_idx).unwrap_or(u32::MAX),
				"sqlite debug DELTA chunks are not contiguous from zero"
			);
			blob.extend_from_slice(&chunk);
		}
		let decoded = decode_ltx_v3(&blob).with_context(|| {
			format!(
				"decode exact sqlite debug DELTA for branch {:?} txid {txid}",
				source.branch_id
			)
		})?;
		for pgno in txid_pgnos {
			let bytes = decoded.get_page(pgno).with_context(|| {
				format!("sqlite page-history row points at DELTA without page {pgno}")
			})?;
			pages.insert(pgno, bytes.to_vec());
		}
	}

	Ok(pages)
}

async fn tx_load_latest_shard_source(
	tx: &universaldb::Transaction,
	sources: &[DebugReadSource],
	shard_id: u32,
) -> Result<Option<ShardSource>> {
	for source in sources {
		if let Some(source) =
			tx_load_capped_branch_shard_source(tx, source.branch_id, source.max_txid, shard_id)
				.await?
		{
			return Ok(Some(source));
		}
	}

	Ok(None)
}
