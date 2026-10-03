//! Page read path for the stateless depot conveyer.

mod cache;
mod cold;
mod pidx;
mod plan;
mod shard;
mod sqlite_page;
mod tx;

use std::{
	collections::{BTreeMap, BTreeSet},
	time::{Duration, Instant},
};

#[cfg(feature = "test-faults")]
use crate::fault::{
	DepotFaultAction, DepotFaultContext, DepotFaultController, DepotFaultFired, DepotFaultPoint,
	ReadFaultPoint,
};
use anyhow::{Context, Result, ensure};
use futures_util::{StreamExt, TryStreamExt, stream};

use crate::conveyer::{
	Db,
	db::{BranchAncestry, CacheSnapshot, touch_access_if_bucket_advanced},
	error::SqliteStorageError,
	keys::{self, PAGE_SIZE, SHARD_SIZE},
	ltx::LtxBlob,
	metrics,
	page_index::DeltaPageIndex,
	types::{
		DatabaseBranchId, FetchedPage, GetPagesOptions, GetPagesResult, PageSourceCandidate,
		PageSourceCandidateResult, PageSourceKind, PageSourceProvenance, decode_commit_row,
	},
};

use self::{
	pidx::{PageRef, PageRefKind, decode_pidx_txid},
	plan::{ReadSource, StorageScope, resolve_storage_scope},
	shard::{DeltaBlobLoad, ShardBlobLoad, tx_load_delta_blob, tx_load_latest_shard_blob},
	tx::{tx_get_last_key_value, tx_get_value},
};

pub(crate) use self::shard::ShardSource;

#[cfg(debug_assertions)]
pub(crate) use self::{cold::hydrate_cold_source, shard::tx_load_capped_branch_shard_source};

/// Maximum number of concurrent FDB reads issued while prefetching page sources.
const PAGE_SOURCE_FETCH_CONCURRENCY: usize = 32;

impl Db {
	pub async fn get_pages(&self, pgnos: Vec<u32>) -> Result<Vec<FetchedPage>> {
		self.get_pages_with_metadata(pgnos)
			.await
			.map(|result| result.pages)
	}

	pub async fn get_pages_with_metadata(&self, pgnos: Vec<u32>) -> Result<GetPagesResult> {
		self.get_pages_with_options(pgnos, GetPagesOptions::default())
			.await
	}

	pub async fn get_pages_with_options(
		&self,
		pgnos: Vec<u32>,
		options: GetPagesOptions,
	) -> Result<GetPagesResult> {
		let node_id = self.node_id.to_string();
		let labels = &[node_id.as_str()];
		let _timer = metrics::SQLITE_PUMP_GET_PAGES_DURATION
			.with_label_values(labels)
			.start_timer();
		metrics::SQLITE_PUMP_GET_PAGES_PGNO_COUNT
			.with_label_values(labels)
			.observe(pgnos.len() as f64);
		let allow_side_effects = options.mode.allows_side_effects();
		let read_started_at = Instant::now();

		for pgno in &pgnos {
			ensure!(*pgno > 0, "get_pages does not accept page 0");
		}

		let phase_start = Instant::now();
		let cached_snapshot = if allow_side_effects {
			self.cache_snapshot.read().await.clone()
		} else {
			None
		};
		metrics::observe_get_pages_phase(&node_id, "cache_snapshot", phase_start, "ok");
		#[cfg(feature = "pidx-cache")]
		let cached_pidx = cached_snapshot
			.as_ref()
			.and_then(|snapshot| cache::snapshot_pidx_cache(&snapshot.pidx, &pgnos));
		#[cfg(not(feature = "pidx-cache"))]
		let cached_pidx = None::<BTreeMap<u32, Option<u64>>>;
		let cached_branch_id = cached_snapshot.as_ref().map(|snapshot| snapshot.branch_id);
		#[cfg(feature = "pidx-cache")]
		let cached_head_txid = cached_snapshot
			.as_ref()
			.map(|snapshot| snapshot.cache_head_txid);
		let cached_ancestry = cached_snapshot
			.as_ref()
			.map(|snapshot| snapshot.ancestors.clone());
		let cached_access_bucket = cached_snapshot.and_then(|snapshot| snapshot.last_access_bucket);

		let database_id = self.database_id.clone();
		let database_id_for_log = database_id.clone();
		let bucket_id = self.sqlite_bucket_id();
		let pgnos_for_tx = pgnos.clone();
		let now_ms = cache::now_ms()?;
		let expected_head_txid = options.expected_head_txid;
		let read_mode = options.mode;
		let diagnostic_max_txid = options.diagnostic_max_txid;
		let collect_provenance = options.collect_provenance;
		let phase_node_id = node_id.clone();
		let ltx_blob_cache = self.ltx_blob_cache.clone();
		#[cfg(feature = "test-faults")]
		let fault_controller = self.fault_controller.clone();
		let tx_result = self
			.udb
			.txn("depot_get_pages", move |tx| {
				let phase_node_id = phase_node_id.clone();
				let ltx_blob_cache = ltx_blob_cache.clone();
				let database_id = database_id.clone();
				let bucket_id = bucket_id;
				let pgnos = pgnos_for_tx.clone();
				let cached_pidx = cached_pidx.clone();
				let cached_ancestry = cached_ancestry.clone();
				let cached_access_bucket = cached_access_bucket;
				let expected_head_txid = expected_head_txid;
				let read_mode = read_mode;
				let diagnostic_max_txid = diagnostic_max_txid;
				let collect_provenance = collect_provenance;
				#[cfg(feature = "test-faults")]
				let fault_controller = fault_controller.clone();

				async move {
					let mut debug = GetPagesDebug::default();
					debug.pages_requested = pgnos.len();
					debug.requested_pgno_min = pgnos.iter().copied().min().unwrap_or(0);
					debug.requested_pgno_max = pgnos.iter().copied().max().unwrap_or(0);
					#[cfg(feature = "test-faults")]
					maybe_fire_read_fault(
						&fault_controller,
						ReadFaultPoint::BeforeScopeResolve,
						&database_id,
						None,
						None,
						None,
					)
					.await?;
					let phase_start = Instant::now();
					let mut scope = resolve_storage_scope(
						&tx,
						bucket_id,
						&database_id,
						cached_ancestry.as_ref(),
					)
					.await?;
					metrics::observe_get_pages_phase(
						&phase_node_id,
						"resolve_scope",
						phase_start,
						"ok",
					);
					let cache_branch_matches = cached_branch_id == Some(scope.branch_id());
					// A page's content is a pure function of (branch_id, head_txid): content
					// changes only via a commit, which advances the head. Trust the cached PIDX
					// only when the head it was built at still matches the head resolved in this
					// transaction, so a foreign writer advancing the head forces a fresh scan.
					#[cfg(feature = "pidx-cache")]
					let cache_head_matches = {
						let StorageScope::Branch(plan) = &scope;
						cached_head_txid == Some(plan.head.head_txid)
					};
					#[cfg(not(feature = "pidx-cache"))]
					let cache_head_matches = true;
					let cached_pidx = if cache_branch_matches && cache_head_matches {
						cached_pidx
					} else {
						None
					};
					let mut diagnostic_current_source_delta_fallback = false;
					if let Some(max_txid) = diagnostic_max_txid {
						ensure!(
							!read_mode.allows_side_effects(),
							"diagnostic max txid is only valid in no-side-effects mode"
						);
						let StorageScope::Branch(plan) = &mut scope;
						ensure!(
							max_txid <= plan.head.head_txid,
							"diagnostic max txid exceeded current head txid"
						);
						diagnostic_current_source_delta_fallback = max_txid < plan.head.head_txid;
						let commit_bytes = tx_get_value(
							&tx,
							&keys::branch_commit_key(plan.branch_id, max_txid),
						)
						.await?
						.context("diagnostic max txid commit row is missing")?;
						let commit = decode_commit_row(&commit_bytes)
							.context("decode diagnostic max txid commit row")?;
						plan.head.head_txid = max_txid;
						plan.head.db_size_pages = commit.db_size_pages;
						for source in &mut plan.sources {
							let ReadSource::Branch(source) = source;
							source.max_txid = source.max_txid.min(max_txid);
						}
					}
					let StorageScope::Branch(plan) = &scope;
					let head = plan.head.clone();
					#[cfg(feature = "test-faults")]
					maybe_fire_read_fault(
						&fault_controller,
						ReadFaultPoint::AfterScopeResolve,
						&database_id,
						Some(scope.branch_id()),
						None,
						None,
					)
					.await?;
					if let Some(expected_head_txid) = expected_head_txid {
						if expected_head_txid != head.head_txid {
							tracing::error!(
								%database_id,
								branch_id = ?scope.branch_id(),
								expected_head_txid,
								actual_head_txid = head.head_txid,
								"sqlite head fence mismatch while reading; this indicates multiple actor instances are accessing the same sqlite database in parallel, which is incorrect actor lifecycle behavior"
							);
							return Err(SqliteStorageError::HeadFenceMismatch {
								expected_head_txid,
								actual_head_txid: head.head_txid,
							}
							.into());
						}
					}

					let pgnos_in_range = pgnos
						.into_iter()
						.filter(|pgno| *pgno <= head.db_size_pages)
						.collect::<Vec<_>>();
					debug.pages_in_range = pgnos_in_range.len();
					if pgnos_in_range.is_empty() {
						let branch_id = scope.branch_id();
						return Ok(GetPagesTxResult {
							branch_id,
							branch_ancestry: scope.branch_ancestry(),
							access_bucket: None,
							head_txid: head.head_txid,
							db_size_pages: head.db_size_pages,
							loaded_pidx_rows: None,
							page_sources: BTreeMap::new(),
							source_blobs: BTreeMap::new(),
							cold_sources: BTreeMap::new(),
							page_candidates: BTreeMap::new(),
							selected_candidates: BTreeMap::new(),
							shard_cache_read_outcomes: BTreeMap::new(),
							stale_pidx_pgnos: BTreeSet::new(),
							debug,
						});
					}

					let phase_start = Instant::now();
					let mut pidx_by_pgno = BTreeMap::<u32, PageRef>::new();
					let mut loaded_pidx_rows = None;
					{
						let StorageScope::Branch(plan_for_debug) = &scope;
						debug.sources_len = plan_for_debug.sources.len();
						debug.head_source_max_txid = plan_for_debug
							.sources
							.first()
							.map(|source| source.max_txid())
							.unwrap_or(0);
					}
					let cache_source = cache::cache_source_for_scope(&scope);
					if let (Some(cache_source), Some(cached_pidx)) =
						(cache_source, cached_pidx.as_ref())
					{
						debug.pidx_cache_hit = true;
						debug.pidx_cache_rows_used = cached_pidx.len();
						for (pgno, txid) in cached_pidx {
							if let Some(txid) = txid.filter(|txid| *txid <= cache_source.max_txid())
							{
								pidx_by_pgno.insert(
									*pgno,
									PageRef {
										source: cache_source,
										txid,
										kind: PageRefKind::Pidx,
									},
								);
							}
						}
					} else {
						debug.pidx_cache_hit = false;
					}
					let StorageScope::Branch(plan) = &scope;
					// PIDX lookup cost must follow the request, never total database pages. Process
					// ancestry sources in priority order and issue exact point reads only for pages
					// that a newer source (or the head-fenced cache) has not already resolved.
					for source in &plan.sources {
						let unresolved = pgnos_in_range
							.iter()
							.copied()
							.filter(|pgno| !pidx_by_pgno.contains_key(pgno))
							.collect::<Vec<_>>();
						if unresolved.is_empty() {
							break;
						}
						let pidx_tx = &tx;
						let pidx_database_id = &database_id;
						let pidx_source = *source;
						let rows = stream::iter(unresolved)
							.map(move |pgno| async move {
								let value = tx_get_value(
									pidx_tx,
									&pidx_source.pidx_key(pidx_database_id, pgno),
								)
								.await?;
								Result::<(u32, Option<Vec<u8>>)>::Ok((pgno, value))
							})
							.buffer_unordered(PAGE_SOURCE_FETCH_CONCURRENCY)
							.try_collect::<Vec<_>>()
							.await?;
						debug.pidx_sources_scanned += 1;
						debug.pidx_rows_scanned += rows.len();
						let mut decoded_rows = Vec::new();
						for (pgno, value) in rows {
							let Some(value) = value else { continue };
							let txid = decode_pidx_txid(&value)?;
							if debug.scanned_txid_min == 0 || txid < debug.scanned_txid_min {
								debug.scanned_txid_min = txid;
							}
							if txid > debug.scanned_txid_max {
								debug.scanned_txid_max = txid;
							}
							if txid > source.max_txid() {
								debug.pidx_rows_filtered_above_max_txid += 1;
								continue;
							}
							pidx_by_pgno.entry(pgno).or_insert(PageRef {
								source: *source,
								txid,
								kind: PageRefKind::Pidx,
							});
							decoded_rows.push((pgno, txid));
						}
						if plan.sources.len() == 1 {
							loaded_pidx_rows = Some(decoded_rows);
						}
					}
					let historical_delta_sources = if plan.inherited_bucket_cap
						|| (diagnostic_current_source_delta_fallback && !read_mode.allows_side_effects())
					{
						&plan.sources[..]
					} else {
						&plan.sources[1..]
					};
					for (pgno, page_ref) in fill_historical_delta_refs(
						&tx,
						historical_delta_sources,
						&pgnos_in_range,
						&pidx_by_pgno,
						&mut debug,
					)
					.await?
					{
						pidx_by_pgno.entry(pgno).or_insert(page_ref);
					}
					metrics::observe_get_pages_phase(
						&phase_node_id,
						"pidx_lookup",
						phase_start,
						"ok",
					);
					#[cfg(feature = "test-faults")]
					for pgno in &pgnos_in_range {
						maybe_fire_read_fault(
							&fault_controller,
							ReadFaultPoint::AfterPidxScan,
							&database_id,
							Some(scope.branch_id()),
							Some(*pgno),
							Some(*pgno / SHARD_SIZE),
						)
						.await?;
					}

					let mut page_sources = BTreeMap::new();
					let mut source_blobs = BTreeMap::new();
					let mut page_candidates = BTreeMap::<u32, Vec<PageSourceCandidate>>::new();
					let mut selected_candidates = BTreeMap::<u32, PageSourceCandidate>::new();
					let mut missing_delta_prefixes = BTreeSet::new();
					let mut shard_sources = BTreeMap::<u32, Option<ShardSource>>::new();
					let mut cold_sources = BTreeMap::new();
					let mut stale_pidx_pgnos = BTreeSet::new();
					let mut shard_cache_read_outcomes =
						BTreeMap::<u32, ShardCacheReadOutcome>::new();
					let mut touched_cache_backed_page = false;

					let phase_start = Instant::now();

					// Phase 1: prefetch every unique delta blob and shard blob concurrently.
					// The assembly loop below dedups loads per delta prefix and per shard, so
					// we resolve the unique keys here, fetch each exactly once, and let the
					// loop read from these maps instead of awaiting inline.
					let tx_ref = &tx;
					let scope_ref = &scope;
					let ltx_blob_cache_ref = &ltx_blob_cache;
					#[cfg(feature = "test-faults")]
					let database_id_ref = &database_id;
					#[cfg(feature = "test-faults")]
					let fault_controller_ref = &fault_controller;

					// Unique delta prefixes referenced by PIDX, paired with the first page that
					// references them so fault injection stays attributed to the same page as
					// the sequential path.
					let mut delta_prefix_triggers: Vec<(Vec<u8>, u32)> = Vec::new();
					{
						let mut seen = BTreeSet::new();
						for pgno in &pgnos_in_range {
							if let Some(page_ref) = pidx_by_pgno.get(pgno) {
								let prefix = page_ref
									.source
									.delta_chunk_prefix(&database_id, page_ref.txid);
								if seen.insert(prefix.clone()) {
									delta_prefix_triggers.push((prefix, *pgno));
								}
							}
						}
					}

					let delta_blobs: BTreeMap<Vec<u8>, DeltaBlobLoad> =
						stream::iter(delta_prefix_triggers)
							.map(move |(prefix, trigger_pgno)| async move {
								let load =
									tx_load_delta_blob(tx_ref, &prefix, ltx_blob_cache_ref).await?;
								#[cfg(feature = "test-faults")]
								let load = {
									let mut load = load;
									if matches!(
										maybe_fire_read_fault(
											fault_controller_ref,
											if load.blob.is_some() {
												ReadFaultPoint::AfterDeltaBlobLoad
											} else {
												ReadFaultPoint::DeltaBlobMissing
											},
											database_id_ref,
											Some(scope_ref.branch_id()),
											Some(trigger_pgno),
											Some(trigger_pgno / SHARD_SIZE),
										)
										.await?,
										Some(DepotFaultFired {
											action: DepotFaultAction::DropArtifact,
											..
										})
									) {
										load.blob = None;
									}
									load
								};
								#[cfg(not(feature = "test-faults"))]
								let _ = trigger_pgno;
								Result::<(Vec<u8>, DeltaBlobLoad)>::Ok((prefix, load))
							})
							.buffer_unordered(PAGE_SOURCE_FETCH_CONCURRENCY)
							.try_collect()
							.await?;

					// Shards are only consulted for pages whose preferred delta is absent or
					// whose delta blob is missing. Collect the unique shards for those pages,
					// keeping the first referencing page for fault attribution.
					let mut shard_triggers: Vec<(u32, u32)> = Vec::new();
					{
						let mut seen = BTreeSet::new();
						for pgno in &pgnos_in_range {
							let has_present_delta =
								pidx_by_pgno.get(pgno).is_some_and(|page_ref| {
									let prefix = page_ref
										.source
										.delta_chunk_prefix(&database_id, page_ref.txid);
									delta_blobs
										.get(&prefix)
										.and_then(|load| load.blob.as_ref())
										.is_some()
								});
							if has_present_delta {
								continue;
							}
							let shard_id = pgno / SHARD_SIZE;
							if seen.insert(shard_id) {
								shard_triggers.push((shard_id, *pgno));
							}
						}
					}

					let shard_blobs: BTreeMap<u32, ShardBlobLoad> = stream::iter(shard_triggers)
						.map(move |(shard_id, trigger_pgno)| async move {
							let load =
								tx_load_latest_shard_blob(tx_ref, scope_ref, shard_id).await?;
							#[cfg(feature = "test-faults")]
							let load = {
								let mut load = load;
								if matches!(
									maybe_fire_read_fault(
										fault_controller_ref,
										ReadFaultPoint::AfterShardBlobLoad,
										database_id_ref,
										Some(scope_ref.branch_id()),
										Some(trigger_pgno),
										Some(shard_id),
									)
									.await?,
									Some(DepotFaultFired {
										action: DepotFaultAction::DropArtifact,
										..
									})
								) {
									load.source = None;
								}
								load
							};
							#[cfg(not(feature = "test-faults"))]
							let _ = trigger_pgno;
							Result::<(u32, ShardBlobLoad)>::Ok((shard_id, load))
						})
						.buffer_unordered(PAGE_SOURCE_FETCH_CONCURRENCY)
						.try_collect()
						.await?;

					for pgno in &pgnos_in_range {
						let preferred_delta = pidx_by_pgno.get(pgno).copied().map(|page_ref| {
							(
								page_ref
									.source
									.delta_chunk_prefix(&database_id, page_ref.txid),
								page_ref.source,
								page_ref.txid,
								page_ref.kind,
							)
						});

						if preferred_delta
							.as_ref()
							.is_some_and(|(prefix, _, _, _)| missing_delta_prefixes.contains(prefix))
						{
							stale_pidx_pgnos.insert(*pgno);
							if collect_provenance {
								let (_, _, txid, kind) = preferred_delta.as_ref().expect("checked above");
								page_candidates.entry(*pgno).or_default().push(PageSourceCandidate {
									kind: missing_delta_kind(*kind),
									txid: Some(*txid),
									shard_id: None,
									result: PageSourceCandidateResult::Lost,
									reason: Some("delta_blob_missing".to_string()),
								});
							}
						}

						if let Some((delta_prefix, _delta_source, delta_txid, delta_kind)) = preferred_delta
							.as_ref()
							.filter(|(prefix, _, _, _)| !missing_delta_prefixes.contains(prefix))
						{
							if !source_blobs.contains_key(delta_prefix) {
								let delta_load = delta_blobs
									.get(delta_prefix)
									.expect("delta blob prefetched for every PIDX prefix");
								debug.delta_blob_loads += 1;
								debug.delta_chunk_rows_scanned += delta_load.chunk_rows_scanned;
								if let Some(blob) = delta_load.blob.as_ref() {
									debug.delta_blob_bytes += blob.len();
									source_blobs.insert(delta_prefix.clone(), blob.clone());
								} else {
									debug.delta_blob_missing += 1;
									missing_delta_prefixes.insert(delta_prefix.clone());
									stale_pidx_pgnos.insert(*pgno);
									if collect_provenance {
										page_candidates.entry(*pgno).or_default().push(PageSourceCandidate {
											kind: missing_delta_kind(*delta_kind),
											txid: Some(*delta_txid),
											shard_id: None,
											result: PageSourceCandidateResult::Lost,
											reason: Some("delta_blob_missing".to_string()),
										});
									}
								}
							}

							if source_blobs.contains_key(delta_prefix) {
								if collect_provenance {
									let candidate = PageSourceCandidate {
										kind: page_ref_kind_to_source_kind(*delta_kind),
										txid: Some(*delta_txid),
										shard_id: None,
										result: PageSourceCandidateResult::Selected,
										reason: None,
									};
									page_candidates.entry(*pgno).or_default().push(candidate.clone());
									selected_candidates.insert(*pgno, candidate);
								}
								page_sources.insert(*pgno, delta_prefix.clone());
								continue;
							}

							stale_pidx_pgnos.insert(*pgno);
						}

						let shard_id = pgno / SHARD_SIZE;
						if !shard_sources.contains_key(&shard_id) {
							let shard_load = shard_blobs
								.get(&shard_id)
								.expect("shard blob prefetched for every consulted shard");
							debug.hot_shard_range_scans += 1;
							debug.hot_shard_rows_scanned += shard_load.hot_rows_scanned;
							debug.cold_shard_range_scans += 1;
							debug.cold_shard_rows_scanned += shard_load.cold_rows_scanned;
							if shard_load.coverage_missing {
								stale_pidx_pgnos.insert(*pgno);
							}
							let source = shard_load.source.clone();
							match source.as_ref() {
								Some(ShardSource::Hot(source)) => {
									debug.hot_shard_hits += 1;
									debug.hot_shard_bytes += source.blob.len();
								}
								Some(ShardSource::Cold(_)) => {
									debug.hot_shard_misses += 1;
									debug.cold_shard_hits += 1;
								}
								None => {
									debug.hot_shard_misses += 1;
									debug.cold_shard_misses += 1;
								}
							}
							shard_sources.insert(shard_id, source);
						}

						if let Some(source) = shard_sources.get(&shard_id).cloned().flatten() {
							let source_key = source.source_key();
							let source_kind = match &source {
								ShardSource::Hot(source) => {
									source_blobs
										.entry(source_key.clone())
										.or_insert_with(|| source.blob.clone());
									ShardCacheReadOutcome::FdbHit
								}
								ShardSource::Cold(source) => {
									cold_sources
										.entry(source_key.clone())
										.or_insert_with(|| source.clone());
									ShardCacheReadOutcome::ColdHit
								}
							};
							if collect_provenance {
								let candidate = PageSourceCandidate {
									kind: match &source {
										ShardSource::Hot(_) => PageSourceKind::HotShard,
										ShardSource::Cold(_) => PageSourceKind::ColdShard,
									},
									txid: Some(source.as_of_txid()),
									shard_id: Some(source.shard_id()),
									result: PageSourceCandidateResult::Selected,
									reason: None,
								};
								page_candidates.entry(*pgno).or_default().push(candidate.clone());
								selected_candidates.insert(*pgno, candidate);
							}
							page_sources.insert(*pgno, source_key);
							shard_cache_read_outcomes.insert(*pgno, source_kind);
							touched_cache_backed_page = true;
						}
					}
					metrics::observe_get_pages_phase(
						&phase_node_id,
						"source_load",
						phase_start,
						"ok",
					);

					debug.pidx_by_pgno_len = pidx_by_pgno.len();
					debug.page_sources_len = page_sources.len();
					let branch_id = scope.branch_id();
					let access_bucket = if touched_cache_backed_page && read_mode.allows_side_effects() {
						touch_access_if_bucket_advanced(
							&tx,
							branch_id,
							cached_access_bucket,
							now_ms,
						)
						.await?
					} else {
						None
					};

					Ok(GetPagesTxResult {
						branch_id,
						branch_ancestry: scope.branch_ancestry(),
						access_bucket,
						head_txid: head.head_txid,
						db_size_pages: head.db_size_pages,
						loaded_pidx_rows,
						page_sources,
							source_blobs,
							cold_sources,
						page_candidates,
						selected_candidates,
						shard_cache_read_outcomes,
						stale_pidx_pgnos,
						debug,
					})
				}
			})
			.await?;

		let mut tx_result = tx_result;
		cold::hydrate_cold_sources(
			&self.udb,
			self.cold_tier.as_ref(),
			&mut tx_result,
			allow_side_effects,
			&node_id,
		)
		.await?;

		let mut stale_pidx_pgnos = tx_result.stale_pidx_pgnos;

		let mut decoded_blobs = BTreeMap::<Vec<u8>, std::sync::Arc<LtxBlob>>::new();
		let mut pages = Vec::with_capacity(pgnos.len());
		let mut provenance = Vec::new();
		let mut returned_bytes = 0u64;
		tx_result.debug.source_blob_count = tx_result.source_blobs.len();
		tx_result.debug.source_blob_bytes =
			tx_result.source_blobs.values().map(Vec::len).sum::<usize>();

		for pgno in pgnos {
			#[cfg(feature = "test-faults")]
			maybe_fire_read_fault(
				&self.fault_controller,
				ReadFaultPoint::BeforeReturnPages,
				&self.database_id,
				Some(tx_result.branch_id),
				Some(pgno),
				Some(pgno / SHARD_SIZE),
			)
			.await?;
			if pgno > tx_result.db_size_pages {
				if collect_provenance {
					provenance.push(PageSourceProvenance {
						pgno,
						winner_kind: PageSourceKind::OutOfRange,
						winner_txid: None,
						winner_shard_id: None,
						candidates: Vec::new(),
					});
				}
				pages.push(FetchedPage { pgno, bytes: None });
				continue;
			}

			let (bytes, winner_kind, winner_txid, winner_shard_id) = if let Some(source_key) =
				tx_result.page_sources.get(&pgno)
			{
				if !decoded_blobs.contains_key(source_key) {
					// Reuse the immutable blob across reads. The cache holds the parsed
					// page index plus raw bytes; on a miss we parse the index once (no
					// page decompression) and cache it.
					let decoded = if let Some(cached) = self.ltx_blob_cache.get(source_key).await {
						cached
					} else {
						let blob = tx_result
							.source_blobs
							.get(source_key)
							.with_context(|| format!("missing source blob for page {pgno}"))?;
						let decoded = std::sync::Arc::new(
							LtxBlob::decode_index(blob.clone()).with_context(|| {
								let len = blob.len();
								let head_n = len.min(64);
								let tail_start = len.saturating_sub(64);
								format!(
									"decode source blob for page {pgno}; \
									 source_key={}; len={}; head={}; tail={}",
									crate::compaction::shared::hex_lower(source_key),
									len,
									crate::compaction::shared::hex_lower(&blob[..head_n]),
									crate::compaction::shared::hex_lower(&blob[tail_start..]),
								)
							})?,
						);
						tx_result.debug.decoded_source_blobs += 1;
						tx_result.debug.decoded_source_bytes += decoded.bytes().len();
						self.ltx_blob_cache
							.insert(source_key.clone(), decoded.clone())
							.await;
						decoded
					};
					decoded_blobs.insert(source_key.clone(), decoded);
				}

				let mut bytes = decoded_blobs
					.get(source_key)
					.map(|decoded| decoded.get_page(pgno))
					.transpose()?
					.flatten();
				let selected = tx_result.selected_candidates.get(&pgno).cloned();
				let (winner_kind, winner_txid, winner_shard_id) = if bytes.is_some() {
					let selected = selected.unwrap_or(PageSourceCandidate {
						kind: PageSourceKind::ZeroFill,
						txid: None,
						shard_id: None,
						result: PageSourceCandidateResult::Won,
						reason: Some("source_selected_without_candidate".to_string()),
					});
					(selected.kind, selected.txid, selected.shard_id)
				} else if source_key.starts_with(&keys::branch_delta_prefix(tx_result.branch_id)) {
					stale_pidx_pgnos.insert(pgno);
					tx_result.debug.stale_delta_pages += 1;
					(
						PageSourceKind::StaleDelta,
						selected.and_then(|x| x.txid),
						None,
					)
				} else {
					(
						PageSourceKind::ZeroFill,
						None,
						selected.and_then(|x| x.shard_id),
					)
				};
				(
					bytes
						.get_or_insert_with(|| vec![0; PAGE_SIZE as usize])
						.clone(),
					winner_kind,
					winner_txid,
					winner_shard_id,
				)
			} else {
				if stale_pidx_pgnos.contains(&pgno) {
					tx_result.debug.shard_coverage_missing_pages += 1;
					return Err(SqliteStorageError::ShardCoverageMissing { pgno }.into());
				}
				tx_result
					.shard_cache_read_outcomes
					.entry(pgno)
					.or_insert(ShardCacheReadOutcome::Miss);
				(
					vec![0; PAGE_SIZE as usize],
					PageSourceKind::ZeroFill,
					None,
					None,
				)
			};
			tx_result.debug.record_winner(winner_kind);
			if collect_provenance {
				let mut candidates = tx_result.page_candidates.remove(&pgno).unwrap_or_default();
				mark_provenance_winner(&mut candidates, winner_kind, winner_txid, winner_shard_id);
				provenance.push(PageSourceProvenance {
					pgno,
					winner_kind,
					winner_txid,
					winner_shard_id,
					candidates,
				});
			}
			if let Some(outcome) = tx_result.shard_cache_read_outcomes.get(&pgno) {
				metrics::SQLITE_SHARD_CACHE_READ_TOTAL
					.with_label_values(&[outcome.as_label()])
					.inc();
			}

			returned_bytes += bytes.len() as u64;
			pages.push(FetchedPage {
				pgno,
				bytes: Some(bytes),
			});
		}

		// Return overflow pages referenced by the requested leaf pages up front.
		// This runs before taking the cache-snapshot write lock because it issues
		// nested get_pages calls that take the lock themselves. Expansion is a
		// best-effort prefetch: an error here must not fail the base read, whose
		// requested pages are already materialized.
		if options.expand_overflow {
			let max_overflow_pages = options
				.max_overflow_pages
				.unwrap_or(MAX_OVERFLOW_EXPANSION_PAGES)
				.min(MAX_OVERFLOW_EXPANSION_PAGES);
			if max_overflow_pages > 0
				&& let Err(err) = self
					.expand_overflow_pages(
						&mut pages,
						tx_result.db_size_pages,
						tx_result.head_txid,
						max_overflow_pages,
					)
					.await
			{
				tracing::warn!(
					database_id = %self.database_id,
					?err,
					"sqlite overflow prefetch expansion failed; returning base pages",
				);
			}
		}

		if allow_side_effects {
			self.read_bytes_since_rollup
				.fetch_add(returned_bytes, std::sync::atomic::Ordering::Relaxed);
			let mut cache_snapshot = self.cache_snapshot.write().await;
			let current_branch_id = cache_snapshot.as_ref().map(|snapshot| snapshot.branch_id);
			let publish_branch_changed =
				cache::branch_cache_changed(current_branch_id, tx_result.branch_id);
			#[cfg(feature = "pidx-cache")]
			let pidx = if publish_branch_changed {
				std::sync::Arc::new(DeltaPageIndex::new())
			} else {
				cache_snapshot
					.as_ref()
					.map(|snapshot| std::sync::Arc::clone(&snapshot.pidx))
					.unwrap_or_else(|| std::sync::Arc::new(DeltaPageIndex::new()))
			};
			#[cfg(not(feature = "pidx-cache"))]
			let pidx = std::sync::Arc::new(DeltaPageIndex::new());
			#[cfg(not(feature = "pidx-cache"))]
			let _ = publish_branch_changed;
			if let Some(loaded_pidx_rows) = tx_result.loaded_pidx_rows.take() {
				metrics::SQLITE_PUMP_PIDX_FDB_LOAD_TOTAL
					.with_label_values(labels)
					.inc();

				#[cfg(feature = "pidx-cache")]
				cache::store_loaded_pidx_rows(&pidx, loaded_pidx_rows, &stale_pidx_pgnos);
				#[cfg(not(feature = "pidx-cache"))]
				let _ = loaded_pidx_rows;
			}
			#[cfg(feature = "pidx-cache")]
			if !stale_pidx_pgnos.is_empty() {
				cache::clear_stale_pidx_rows(&pidx, stale_pidx_pgnos);
			}
			#[cfg(not(feature = "pidx-cache"))]
			let _ = stale_pidx_pgnos;
			let last_access_bucket = tx_result.access_bucket.or_else(|| {
				cache_snapshot
					.as_ref()
					.filter(|snapshot| snapshot.branch_id == tx_result.branch_id)
					.and_then(|snapshot| snapshot.last_access_bucket)
			});
			*cache_snapshot = Some(CacheSnapshot {
				branch_id: tx_result.branch_id,
				ancestors: tx_result.branch_ancestry,
				last_access_bucket,
				pidx,
				cache_head_txid: tx_result.head_txid,
			});
		}

		let elapsed_ms = read_started_at.elapsed().as_millis();
		if elapsed_ms >= SQLITE_GET_PAGES_DEBUG_SLOW_MS || tx_result.debug.is_expensive() {
			tracing::debug!(
				database_id = %database_id_for_log,
				bucket_id = ?self.sqlite_bucket_id(),
				branch_id = ?tx_result.branch_id,
				head_txid = tx_result.head_txid,
				db_size_pages = tx_result.db_size_pages,
				elapsed_ms,
				pages_requested = tx_result.debug.pages_requested,
				pages_in_range = tx_result.debug.pages_in_range,
				pages_from_delta = tx_result.debug.pages_from_delta,
				pages_from_historical_delta = tx_result.debug.pages_from_historical_delta,
				pages_from_hot_shard = tx_result.debug.pages_from_hot_shard,
				zero_fill_pages = tx_result.debug.zero_fill_pages,
				out_of_range_pages = tx_result.debug.out_of_range_pages,
				stale_delta_pages = tx_result.debug.stale_delta_pages,
				shard_coverage_missing_pages = tx_result.debug.shard_coverage_missing_pages,
				pidx_cache_hit = tx_result.debug.pidx_cache_hit,
				pidx_cache_rows_used = tx_result.debug.pidx_cache_rows_used,
				pidx_sources_scanned = tx_result.debug.pidx_sources_scanned,
				pidx_rows_scanned = tx_result.debug.pidx_rows_scanned,
				sources_len = tx_result.debug.sources_len,
				head_source_max_txid = tx_result.debug.head_source_max_txid,
				requested_pgno_min = tx_result.debug.requested_pgno_min,
				requested_pgno_max = tx_result.debug.requested_pgno_max,
				scanned_txid_min = tx_result.debug.scanned_txid_min,
				scanned_txid_max = tx_result.debug.scanned_txid_max,
				pidx_rows_filtered_above_max_txid = tx_result.debug.pidx_rows_filtered_above_max_txid,
				pidx_by_pgno_len = tx_result.debug.pidx_by_pgno_len,
				page_sources_len = tx_result.debug.page_sources_len,
				historical_delta_chunk_rows_scanned = tx_result.debug.historical_delta_chunk_rows_scanned,
				historical_delta_txids_decoded = tx_result.debug.historical_delta_txids_decoded,
				delta_blob_loads = tx_result.debug.delta_blob_loads,
				delta_blob_missing = tx_result.debug.delta_blob_missing,
				delta_chunk_rows_scanned = tx_result.debug.delta_chunk_rows_scanned,
				delta_blob_bytes = tx_result.debug.delta_blob_bytes,
				hot_shard_range_scans = tx_result.debug.hot_shard_range_scans,
				hot_shard_rows_scanned = tx_result.debug.hot_shard_rows_scanned,
				hot_shard_hits = tx_result.debug.hot_shard_hits,
				hot_shard_misses = tx_result.debug.hot_shard_misses,
				hot_shard_bytes = tx_result.debug.hot_shard_bytes,
				source_blob_count = tx_result.debug.source_blob_count,
				source_blob_bytes = tx_result.debug.source_blob_bytes,
				decoded_source_blobs = tx_result.debug.decoded_source_blobs,
				decoded_source_bytes = tx_result.debug.decoded_source_bytes,
				"sqlite depot get_pages debug"
			);
		}

		Ok(GetPagesResult {
			pages,
			head_txid: tx_result.head_txid,
			db_size_pages: tx_result.db_size_pages,
			provenance,
		})
	}

	/// Append the overflow pages referenced by the already-fetched leaf pages to
	/// `pages`, walking each overflow chain to its end. Overflow pages are loaded
	/// through nested get_pages calls (without further expansion), so the actor
	/// reads them from its local cache instead of round tripping per row.
	async fn expand_overflow_pages(
		&self,
		pages: &mut Vec<FetchedPage>,
		db_size_pages: u32,
		expected_head_txid: u64,
		max_overflow_pages: usize,
	) -> Result<()> {
		let page_size = PAGE_SIZE as usize;
		// The reserved-byte count lives in the database header (page 1). It is
		// zero for Rivet databases; fall back to zero when page 1 is absent.
		let reserved = pages
			.iter()
			.find(|page| page.pgno == 1)
			.and_then(|page| page.bytes.as_deref())
			.and_then(sqlite_page::header_reserved_bytes)
			.unwrap_or(0);

		let mut seen: BTreeSet<u32> = pages.iter().map(|page| page.pgno).collect();
		let mut frontier: Vec<u32> = Vec::new();
		let mut queued = BTreeSet::new();
		for page in pages.iter() {
			let Some(bytes) = page.bytes.as_deref() else {
				continue;
			};
			for head in sqlite_page::overflow_head_pages(
				page.pgno,
				bytes,
				page_size,
				reserved,
				db_size_pages,
			) {
				if !seen.contains(&head) && queued.insert(head) {
					frontier.push(head);
				}
			}
		}
		if frontier.is_empty() {
			return Ok(());
		}

		let node_id = self.node_id.to_string();
		let labels = &[node_id.as_str()];
		let _timer = metrics::SQLITE_OVERFLOW_PREFETCH_DURATION
			.with_label_values(labels)
			.start_timer();

		// Bound the walk in wall-clock time and response size. An overflow page only
		// names its immediate successor, but fetching one page per UDB transaction
		// turns a multi-MiB SQLite value into thousands of serial round trips. Fetch
		// a 4 MiB forward window instead: Depot resolves its 256 KiB storage shards
		// concurrently, then the chain is followed from the materialized pages in
		// memory. Fragmented chains remain correct; a jump outside the window starts
		// another bounded batch.
		let deadline = Instant::now() + OVERFLOW_EXPANSION_TIME_BUDGET;
		let mut budget = max_overflow_pages;
		let mut prefetched = BTreeMap::<u32, Vec<u8>>::new();
		let mut expanded_pages = 0usize;
		while !frontier.is_empty() && budget > 0 {
			if Instant::now() >= deadline {
				break;
			}

			let expanded_before = expanded_pages;
			let batch =
				plan_overflow_prefetch_batch(&frontier, &seen, &prefetched, db_size_pages, budget);
			if !batch.is_empty() {
				metrics::SQLITE_OVERFLOW_PREFETCH_BATCH_PAGES
					.with_label_values(labels)
					.observe(batch.len() as f64);
				// Box the recursive call to keep the async future a finite size.
				let fetched = Box::pin(self.get_pages_with_options(
					batch,
					GetPagesOptions {
						expected_head_txid: Some(expected_head_txid),
						expand_overflow: false,
						..Default::default()
					},
				))
				.await?
				.pages;
				for page in fetched {
					if let Some(bytes) = page.bytes {
						prefetched.insert(page.pgno, bytes);
					}
				}
			}

			let mut next_frontier = Vec::new();
			for head in std::mem::take(&mut frontier) {
				let mut current = head;
				loop {
					if budget == 0 || seen.contains(&current) {
						break;
					}
					let Some(bytes) = prefetched.remove(&current) else {
						next_frontier.push(current);
						break;
					};
					seen.insert(current);
					budget -= 1;
					expanded_pages += 1;
					let next = sqlite_page::overflow_next_page(&bytes, db_size_pages);
					pages.push(FetchedPage {
						pgno: current,
						bytes: Some(bytes),
					});
					let Some(next) = next else { break };
					current = next;
				}
			}
			frontier = next_frontier;
			if expanded_pages == expanded_before {
				break;
			}
		}
		metrics::SQLITE_OVERFLOW_PREFETCH_EXPANDED_PAGES
			.with_label_values(labels)
			.observe(expanded_pages as f64);

		Ok(())
	}
}

fn plan_overflow_prefetch_batch(
	frontier: &[u32],
	seen: &BTreeSet<u32>,
	prefetched: &BTreeMap<u32, Vec<u8>>,
	db_size_pages: u32,
	remaining_budget: usize,
) -> Vec<u32> {
	let capacity = OVERFLOW_PREFETCH_WINDOW_PAGES.min(remaining_budget);
	let mut batch = Vec::with_capacity(capacity);
	let mut selected = BTreeSet::new();
	for head in frontier {
		if batch.len() >= capacity || seen.contains(head) || prefetched.contains_key(head) {
			continue;
		}
		let remaining = capacity - batch.len();
		for pgno in (*head..=db_size_pages).take(remaining) {
			if !seen.contains(&pgno) && !prefetched.contains_key(&pgno) && selected.insert(pgno) {
				batch.push(pgno);
			}
		}
	}
	batch
}

/// Cap on the number of overflow pages a single get_pages call may eagerly
/// return, bounding response size when leaf pages reference long overflow chains.
const MAX_OVERFLOW_EXPANSION_PAGES: usize = 2048;

/// Fetch 4 MiB of adjacent pages per nested request. This matches the physical
/// cold-object ceiling while staying well below FDB's transaction byte limit.
const OVERFLOW_PREFETCH_WINDOW_PAGES: usize = 1024;

/// Wall-clock ceiling on the overflow-chain walk. Overflow prefetch is
/// best-effort, so once this elapses the remaining chain is left for on-demand
/// fetching rather than extending the read latency further.
const OVERFLOW_EXPANSION_TIME_BUDGET: Duration = Duration::from_millis(2500);

#[cfg(test)]
mod overflow_prefetch_tests {
	use super::*;

	#[test]
	fn prefetch_plans_one_bounded_four_mib_window() {
		let batch = plan_overflow_prefetch_batch(
			&[3],
			&BTreeSet::new(),
			&BTreeMap::new(),
			10_000,
			MAX_OVERFLOW_EXPANSION_PAGES,
		);
		assert_eq!(batch.len(), OVERFLOW_PREFETCH_WINDOW_PAGES);
		assert_eq!(batch.first(), Some(&3));
		assert_eq!(batch.last(), Some(&1026));
	}

	#[test]
	fn prefetch_skips_seen_and_materialized_pages() {
		let seen = BTreeSet::from([3, 4]);
		let prefetched = BTreeMap::from([(5, vec![0; PAGE_SIZE as usize])]);
		let batch = plan_overflow_prefetch_batch(&[3, 6], &seen, &prefetched, 8, 2);
		assert_eq!(batch, vec![6, 7]);
	}

	#[test]
	fn prefetch_never_exceeds_database_or_remaining_budget() {
		let batch = plan_overflow_prefetch_batch(&[9], &BTreeSet::new(), &BTreeMap::new(), 10, 64);
		assert_eq!(batch, vec![9, 10]);
	}
}

struct GetPagesTxResult {
	branch_id: DatabaseBranchId,
	branch_ancestry: BranchAncestry,
	access_bucket: Option<i64>,
	head_txid: u64,
	db_size_pages: u32,
	loaded_pidx_rows: Option<Vec<(u32, u64)>>,
	page_sources: BTreeMap<u32, Vec<u8>>,
	source_blobs: BTreeMap<Vec<u8>, Vec<u8>>,
	cold_sources: BTreeMap<Vec<u8>, shard::ColdShardSource>,
	page_candidates: BTreeMap<u32, Vec<PageSourceCandidate>>,
	selected_candidates: BTreeMap<u32, PageSourceCandidate>,
	shard_cache_read_outcomes: BTreeMap<u32, ShardCacheReadOutcome>,
	stale_pidx_pgnos: BTreeSet<u32>,
	debug: GetPagesDebug,
}

const SQLITE_GET_PAGES_DEBUG_SLOW_MS: u128 = 1_000;
const SQLITE_GET_PAGES_DEBUG_EXPENSIVE_ROWS: usize = 256;

#[derive(Default)]
struct GetPagesDebug {
	pages_requested: usize,
	pages_in_range: usize,
	pages_from_delta: usize,
	pages_from_historical_delta: usize,
	pages_from_hot_shard: usize,
	pages_from_cold_shard: usize,
	zero_fill_pages: usize,
	out_of_range_pages: usize,
	stale_delta_pages: usize,
	shard_coverage_missing_pages: usize,
	pidx_cache_hit: bool,
	pidx_cache_rows_used: usize,
	pidx_sources_scanned: usize,
	pidx_rows_scanned: usize,
	sources_len: usize,
	head_source_max_txid: u64,
	requested_pgno_min: u32,
	requested_pgno_max: u32,
	scanned_txid_min: u64,
	scanned_txid_max: u64,
	pidx_rows_filtered_above_max_txid: usize,
	pidx_by_pgno_len: usize,
	page_sources_len: usize,
	historical_delta_chunk_rows_scanned: usize,
	historical_delta_txids_decoded: usize,
	delta_blob_loads: usize,
	delta_blob_missing: usize,
	delta_chunk_rows_scanned: usize,
	delta_blob_bytes: usize,
	hot_shard_range_scans: usize,
	hot_shard_rows_scanned: usize,
	hot_shard_hits: usize,
	hot_shard_misses: usize,
	hot_shard_bytes: usize,
	cold_shard_range_scans: usize,
	cold_shard_rows_scanned: usize,
	cold_shard_hits: usize,
	cold_shard_misses: usize,
	source_blob_count: usize,
	source_blob_bytes: usize,
	decoded_source_blobs: usize,
	decoded_source_bytes: usize,
}

impl GetPagesDebug {
	fn is_expensive(&self) -> bool {
		self.pidx_rows_scanned >= SQLITE_GET_PAGES_DEBUG_EXPENSIVE_ROWS
			|| self.delta_chunk_rows_scanned >= SQLITE_GET_PAGES_DEBUG_EXPENSIVE_ROWS
			|| self.historical_delta_chunk_rows_scanned >= SQLITE_GET_PAGES_DEBUG_EXPENSIVE_ROWS
			|| self.hot_shard_rows_scanned >= SQLITE_GET_PAGES_DEBUG_EXPENSIVE_ROWS
	}

	fn record_winner(&mut self, kind: PageSourceKind) {
		match kind {
			PageSourceKind::PidxDelta => self.pages_from_delta += 1,
			PageSourceKind::HistoricalDelta => self.pages_from_historical_delta += 1,
			PageSourceKind::MissingDelta => self.stale_delta_pages += 1,
			PageSourceKind::StaleDelta => self.stale_delta_pages += 1,
			PageSourceKind::HotShard => self.pages_from_hot_shard += 1,
			PageSourceKind::ColdShard => self.pages_from_cold_shard += 1,
			PageSourceKind::ZeroFill => self.zero_fill_pages += 1,
			PageSourceKind::OutOfRange => self.out_of_range_pages += 1,
		}
	}
}

#[derive(Clone, Copy)]
enum ShardCacheReadOutcome {
	FdbHit,
	ColdHit,
	Miss,
}

impl ShardCacheReadOutcome {
	fn as_label(self) -> &'static str {
		match self {
			ShardCacheReadOutcome::FdbHit => metrics::SHARD_CACHE_READ_FDB_HIT,
			ShardCacheReadOutcome::ColdHit => metrics::SHARD_CACHE_READ_COLD_HIT,
			ShardCacheReadOutcome::Miss => metrics::SHARD_CACHE_READ_MISS,
		}
	}
}

fn page_ref_kind_to_source_kind(kind: PageRefKind) -> PageSourceKind {
	match kind {
		PageRefKind::Pidx => PageSourceKind::PidxDelta,
		PageRefKind::HistoricalDelta => PageSourceKind::HistoricalDelta,
	}
}

fn missing_delta_kind(kind: PageRefKind) -> PageSourceKind {
	match kind {
		PageRefKind::Pidx => PageSourceKind::MissingDelta,
		PageRefKind::HistoricalDelta => PageSourceKind::MissingDelta,
	}
}

fn mark_provenance_winner(
	candidates: &mut Vec<PageSourceCandidate>,
	winner_kind: PageSourceKind,
	winner_txid: Option<u64>,
	winner_shard_id: Option<u32>,
) {
	let mut found_winner = false;
	for candidate in candidates.iter_mut() {
		if candidate.kind == winner_kind
			&& candidate.txid == winner_txid
			&& candidate.shard_id == winner_shard_id
		{
			candidate.result = PageSourceCandidateResult::Won;
			candidate.reason = None;
			found_winner = true;
		} else if candidate.result == PageSourceCandidateResult::Selected {
			candidate.result = PageSourceCandidateResult::Lost;
			if candidate.reason.is_none() {
				candidate.reason = Some(
					match winner_kind {
						PageSourceKind::StaleDelta => "delta_does_not_contain_page",
						PageSourceKind::ZeroFill => "selected_source_did_not_contain_page",
						PageSourceKind::PidxDelta
						| PageSourceKind::HistoricalDelta
						| PageSourceKind::MissingDelta
						| PageSourceKind::HotShard
						| PageSourceKind::ColdShard
						| PageSourceKind::OutOfRange => "superseded",
					}
					.to_string(),
				);
			}
		}
	}
	if !found_winner {
		candidates.push(PageSourceCandidate {
			kind: winner_kind,
			txid: winner_txid,
			shard_id: winner_shard_id,
			result: PageSourceCandidateResult::Won,
			reason: None,
		});
	}
}

async fn fill_historical_delta_refs(
	tx: &universaldb::Transaction,
	capped_sources: &[ReadSource],
	pgnos: &[u32],
	pidx_by_pgno: &BTreeMap<u32, PageRef>,
	debug: &mut GetPagesDebug,
) -> Result<BTreeMap<u32, PageRef>> {
	let mut missing_pgnos = pgnos
		.iter()
		.copied()
		.filter(|pgno| !pidx_by_pgno.contains_key(pgno))
		.collect::<BTreeSet<_>>();
	let mut refs = BTreeMap::new();

	for source in capped_sources {
		if missing_pgnos.is_empty() {
			break;
		}
		let complete_bytes = tx_get_value(tx, &source.page_history_complete_txid_key())
			.await?
			.context("sqlite page-history index is not initialized")?;
		let complete_bytes: [u8; std::mem::size_of::<u64>()] = complete_bytes
			.as_slice()
			.try_into()
			.context("sqlite page-history watermark should be exactly 8 bytes")?;
		let complete_txid = u64::from_be_bytes(complete_bytes);
		ensure!(
			complete_txid >= source.max_txid(),
			"sqlite page-history index is incomplete through capped txid {}; indexed through {}",
			source.max_txid(),
			complete_txid,
		);

		let history_tx = tx;
		let history_source = *source;
		let lookups = stream::iter(missing_pgnos.iter().copied())
			.map(move |pgno| async move {
				let start = history_source.page_history_page_prefix(pgno);
				let mut end = history_source.page_history_key(pgno, history_source.max_txid());
				// Range ends are exclusive. Appending a zero byte includes the exact
				// fixed-width txid key while excluding all later txids.
				end.push(0);
				let row = tx_get_last_key_value(history_tx, &start, &end).await?;
				Result::<(u32, Option<(Vec<u8>, Vec<u8>)>)>::Ok((pgno, row))
			})
			.buffer_unordered(PAGE_SOURCE_FETCH_CONCURRENCY)
			.try_collect::<Vec<_>>()
			.await?;
		debug.historical_delta_chunk_rows_scanned += lookups.len();

		for (pgno, row) in lookups {
			if let Some((key, value)) = row {
				ensure!(
					value.is_empty(),
					"sqlite page-history value should be empty"
				);
				let txid = source.decode_page_history_txid(pgno, &key)?;
				ensure!(
					txid <= source.max_txid(),
					"page-history lookup exceeded source cap"
				);
				refs.insert(
					pgno,
					PageRef {
						source: *source,
						txid,
						kind: PageRefKind::HistoricalDelta,
					},
				);
				missing_pgnos.remove(&pgno);
			}
		}
	}

	Ok(refs)
}

#[cfg(feature = "test-faults")]
pub(super) async fn maybe_fire_read_fault(
	fault_controller: &Option<DepotFaultController>,
	point: ReadFaultPoint,
	database_id: &str,
	database_branch_id: Option<DatabaseBranchId>,
	page_number: Option<u32>,
	shard_id: Option<u32>,
) -> Result<Option<DepotFaultFired>> {
	let Some(controller) = fault_controller else {
		return Ok(None);
	};
	let mut context = DepotFaultContext::new().database_id(database_id);
	if let Some(database_branch_id) = database_branch_id {
		context = context.database_branch_id(database_branch_id);
	}
	if let Some(page_number) = page_number {
		context = context.page_number(page_number);
	}
	if let Some(shard_id) = shard_id {
		context = context.shard_id(shard_id);
	}

	controller
		.maybe_fire(DepotFaultPoint::Read(point), context)
		.await
}
