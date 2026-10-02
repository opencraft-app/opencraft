use std::{collections::BTreeSet, sync::Arc, time::Instant};

use anyhow::{Context, Result, ensure};
use futures_util::{StreamExt, TryStreamExt, stream};
use sha2::{Digest, Sha256};
use universaldb::{
	options::MutationType,
	utils::IsolationLevel::{Serializable, Snapshot},
};

#[cfg(feature = "test-faults")]
use crate::fault::{CommitFaultPoint, DepotFaultContext, DepotFaultController, DepotFaultPoint};
use crate::{
	burst_mode,
	conveyer::{
		Db, branch,
		constants::{MAX_COMMIT_DIRTY_PAGES, MAX_COMMIT_RAW_DIRTY_BYTES},
		db::{
			BranchAncestry, CacheSnapshot, load_branch_ancestry, touch_access_if_bucket_advanced,
		},
		error::SqliteStorageError,
		keys,
		ltx::{LtxHeader, encode_ltx_v3},
		metrics,
		page_index::DeltaPageIndex,
		quota,
		types::{
			BranchState, CommitAttemptProof, CommitOptions, CommitResult, CommitRow, DBHead,
			DatabaseBranchId, DirtyPage, decode_commit_attempt_proof, decode_compaction_root,
			decode_database_branch_record, decode_db_head, encode_commit_attempt_proof,
			encode_commit_row, encode_db_head,
		},
		udb,
	},
	workflows::compaction::DeltasAvailable,
};

use super::{
	branch_init::{resolve_or_allocate_branch, write_root_branch_metadata},
	dirty::admit_deltas_available,
	helpers::{tracked_entry_size, tx_get_value},
	test_hooks,
	truncate::{apply_truncate_shard_cleanup, collect_truncate_cleanup},
};

const DELTA_CHUNK_BYTES: usize = 10_000;

impl Db {
	pub async fn commit(
		&self,
		dirty_pages: Vec<DirtyPage>,
		db_size_pages: u32,
		now_ms: i64,
	) -> Result<()> {
		self.commit_with_options(dirty_pages, db_size_pages, now_ms, CommitOptions::default())
			.await
			.map(|_| ())
	}

	pub async fn commit_with_options(
		&self,
		dirty_pages: Vec<DirtyPage>,
		db_size_pages: u32,
		now_ms: i64,
		options: CommitOptions,
	) -> Result<CommitResult> {
		validate_dirty_pages(&dirty_pages, db_size_pages)?;
		if self.writer_fence_key.is_some() && options.expected_writer_generation.is_none() {
			return Err(SqliteStorageError::WriterFenceRequired.into());
		}
		#[cfg(feature = "test-faults")]
		maybe_fire_commit_fault(
			&self.fault_controller,
			&self.database_id,
			CommitFaultPoint::BeforeTx,
			None,
		)
		.await?;

		let node_id = self.node_id.to_string();
		let labels = &[node_id.as_str()];
		let _timer = metrics::SQLITE_PUMP_COMMIT_DURATION
			.with_label_values(labels)
			.start_timer();
		metrics::SQLITE_PUMP_COMMIT_DIRTY_PAGE_COUNT
			.with_label_values(labels)
			.observe(dirty_pages.len() as f64);

		let phase_start = Instant::now();
		let cached_snapshot = self.cache_snapshot.read().await.clone();
		let cached_ancestry = cached_snapshot
			.as_ref()
			.map(|snapshot| snapshot.ancestors.clone());
		let cached_access_bucket = cached_snapshot
			.as_ref()
			.and_then(|snapshot| snapshot.last_access_bucket);
		let compaction_enabled = self.compaction_signaler.is_some();
		let bottomless_enabled = self.cold_tier.is_some();
		let write_debt_policy = self
			.cold_tier
			.as_ref()
			.map(|cold_tier| cold_tier.fdb_write_debt_policy())
			.unwrap_or_default();
		#[cfg(feature = "pidx-cache")]
		let cache_was_warm = cached_snapshot
			.as_ref()
			.is_some_and(|snapshot| !snapshot.pidx.is_empty());
		#[cfg(not(feature = "pidx-cache"))]
		let cache_was_warm = false;
		metrics::observe_commit_phase(&node_id, "cache_snapshot", phase_start, "ok");
		let database_id = self.database_id.clone();
		let bucket_id = self.sqlite_bucket_id();
		let dirty_pages_for_tx = dirty_pages.clone();
		let expected_head_txid = options.expected_head_txid;
		let expected_writer_generation = options.expected_writer_generation;
		let writer_fence_key = self.writer_fence_key.clone();
		let commit_attempt_id = options
			.commit_attempt_id
			.unwrap_or_else(|| *uuid::Uuid::new_v4().as_bytes());
		let commit_request_hash =
			commit_request_hash(&dirty_pages, db_size_pages, now_ms, expected_head_txid);
		let phase_node_id = node_id.clone();
		#[cfg(feature = "test-faults")]
		let fault_controller = self.fault_controller.clone();

		let result = self
			.udb
			.txn("depot_commit", move |tx| {
				let phase_node_id = phase_node_id.clone();
				let database_id = database_id.clone();
				let bucket_id = bucket_id;
				let dirty_pages = dirty_pages_for_tx.clone();
				let expected_head_txid = expected_head_txid;
				let expected_writer_generation = expected_writer_generation;
				let writer_fence_key = writer_fence_key.clone();
				let cached_ancestry = cached_ancestry.clone();
				let cached_access_bucket = cached_access_bucket;
				let compaction_enabled = compaction_enabled;
				let bottomless_enabled = bottomless_enabled;
				let write_debt_policy = write_debt_policy;
				#[cfg(feature = "test-faults")]
				let fault_controller = fault_controller.clone();

				async move {
					let phase_start = Instant::now();
					if let Some(writer_fence_key) = writer_fence_key.as_deref() {
						let Some(expected_writer_generation) = expected_writer_generation else {
							return Err(SqliteStorageError::WriterFenceRequired.into());
						};
						let writer_generation_bytes = tx_get_value(
							&tx,
							writer_fence_key,
							Serializable,
						)
						.await?;
						let actual_writer_generation = writer_generation_bytes
							.as_deref()
							.and_then(decode_writer_generation)
							.map(u64::from);
						if actual_writer_generation != Some(expected_writer_generation) {
							tracing::error!(
								%database_id,
								expected_writer_generation,
								actual_writer_generation,
								actual_value_len = writer_generation_bytes.as_deref().map(<[u8]>::len),
								"sqlite writer generation lost its storage fence"
							);
							return Err(SqliteStorageError::WriterFenceMismatch {
								expected_generation: expected_writer_generation,
							}
							.into());
						}
					}
					let branch_resolution =
						resolve_or_allocate_branch(&tx, bucket_id, &database_id).await?;
					let branch_id = branch_resolution.branch_id;
					#[cfg(feature = "test-faults")]
					maybe_fire_commit_fault(
						&fault_controller,
						&database_id,
						CommitFaultPoint::AfterBranchResolution,
						Some(branch_id),
					)
					.await?;
					if !branch_resolution.database_initialized {
						let branch_record =
							tx_get_value(&tx, &keys::branches_list_key(branch_id), Serializable)
								.await?
								.as_deref()
								.map(decode_database_branch_record)
								.transpose()
								.context("decode sqlite database branch record for commit")?;
						if !branch_record
							.as_ref()
							.is_some_and(|record| record.state == BranchState::Live)
						{
							return Err(SqliteStorageError::BranchNotWritable.into());
						}
					}
					let branch_ancestry = if branch_resolution.database_initialized {
						BranchAncestry::root(branch_id)
					} else if let Some(cached_ancestry) =
						cached_ancestry.filter(|ancestry| ancestry.root_branch_id == branch_id)
					{
						cached_ancestry
					} else {
						load_branch_ancestry(&tx, branch_id).await?
					};
					metrics::observe_commit_phase(
						&phase_node_id,
						"resolve_branch",
						phase_start,
						"ok",
					);
					let head_key = keys::branch_meta_head_key(branch_id);
					let head_at_fork_key = keys::branch_meta_head_at_fork_key(branch_id);
					let commit_attempt_key = keys::branch_meta_commit_attempt_key(branch_id);
					let phase_start = Instant::now();
					// Compaction and reclaim mutate the durable quota counter outside this
					// actor process. Always point-read it in the commit transaction; a
					// process-local cached value would eventually reject writes after space
					// had already been reclaimed.
					let quota_fut = quota::read_branch(&tx, branch_id);
					let head_fut = tx_get_value(&tx, &head_key, Serializable);
					let head_at_fork_fut = tx_get_value(&tx, &head_at_fork_key, Serializable);
					let commit_attempt_fut =
						tx_get_value(&tx, &commit_attempt_key, Serializable);
					let (head_bytes, head_at_fork_bytes, commit_attempt_bytes, storage_used) =
						tokio::try_join!(
							head_fut,
							head_at_fork_fut,
							commit_attempt_fut,
							quota_fut
						)?;
					metrics::observe_commit_phase(
						&phase_node_id,
						"head_read",
						phase_start,
						"ok",
					);

					let previous_head_bytes = head_bytes.as_ref().or(head_at_fork_bytes.as_ref());
					let previous_head = previous_head_bytes
						.map(|bytes| decode_db_head(bytes.as_slice()))
						.transpose()
						.context("decode current sqlite db head")?;
					let actual_head_txid = previous_head.as_ref().map_or(0, |head| head.head_txid);
					let dirty_pgnos = dirty_pages
						.iter()
						.map(|page| page.pgno)
						.collect::<BTreeSet<_>>();
					let commit_attempt_proof = commit_attempt_bytes
						.as_deref()
						.map(decode_commit_attempt_proof)
						.transpose()
						.context("decode sqlite commit attempt proof")?;
					if let Some(proof) = commit_attempt_proof
						.as_ref()
						.filter(|proof| proof.attempt_id == commit_attempt_id)
					{
						ensure!(
							proof.request_hash == commit_request_hash,
							"sqlite commit attempt id was reused with a different request"
						);
						ensure!(
							previous_head.as_ref().is_some_and(|head| {
								head.head_txid == proof.txid
									&& head.db_size_pages == proof.db_size_pages
							}),
							"sqlite commit attempt proof did not match the current branch head"
						);

						return Ok(CommitTxResult {
							branch_id,
							branch_ancestry,
							access_bucket: None,
							txid: proof.txid,
							deltas_available: proof.deltas_available_at_ms.map(|dirty_updated_at_ms| {
								DeltasAvailable {
									database_branch_id: branch_id,
									observed_head_txid: proof.txid,
									dirty_updated_at_ms,
								}
							}),
							dirty_pgnos,
							reset_pidx_cache: proof.reset_pidx_cache,
							added_bytes: 0,
							storage_used,
						});
					}
					if let Some(expected_head_txid) = expected_head_txid {
						if expected_head_txid != actual_head_txid {
							tracing::error!(
								%database_id,
								?branch_id,
								expected_head_txid,
								actual_head_txid,
								"sqlite head fence mismatch; this indicates multiple actor instances are writing the same sqlite database in parallel, which is incorrect actor lifecycle behavior"
							);
							return Err(SqliteStorageError::HeadFenceMismatch {
								expected_head_txid,
								actual_head_txid,
							}
							.into());
						}
					}
					#[cfg(feature = "test-faults")]
					maybe_fire_commit_fault(
						&fault_controller,
						&database_id,
						CommitFaultPoint::AfterHeadRead,
						Some(branch_id),
					)
					.await?;
					let compaction_root =
						tx_get_value(&tx, &keys::branch_compaction_root_key(branch_id), Snapshot)
							.await?
							.as_deref()
							.map(decode_compaction_root)
							.transpose()
							.context("decode sqlite compaction root for dirty admission")?;
					let previous_db_size_pages = previous_head
						.as_ref()
						.map_or(db_size_pages, |head| head.db_size_pages);
					let txid = match previous_head.as_ref() {
						Some(head) => head
							.head_txid
							.checked_add(1)
							.context("sqlite head txid overflowed")?,
						None => 1,
					};

					let phase_start = Instant::now();
					let truncate_cleanup = collect_truncate_cleanup(
						&tx,
						branch_id,
						previous_db_size_pages,
						db_size_pages,
					)
					.await?;
					metrics::observe_commit_phase(
						&phase_node_id,
						"truncate_cleanup",
						phase_start,
						"ok",
					);
					test_hooks::maybe_pause_after_truncate_cleanup(&database_id).await;
					#[cfg(feature = "test-faults")]
					maybe_fire_commit_fault(
						&fault_controller,
						&database_id,
						CommitFaultPoint::AfterTruncateCleanup,
						Some(branch_id),
					)
					.await?;

					let phase_start = Instant::now();
					let encoded_delta =
						encode_ltx_v3(LtxHeader::delta(txid, db_size_pages, now_ms), &dirty_pages)
							.context("encode commit delta")?;
					let delta_chunks = encoded_delta
						.chunks(DELTA_CHUNK_BYTES)
						.enumerate()
						.map(|(chunk_idx, chunk)| {
							let chunk_idx = u32::try_from(chunk_idx)
								.context("delta chunk index exceeded u32")?;
							Ok((
								keys::branch_delta_chunk_key(branch_id, txid, chunk_idx),
								chunk.to_vec(),
							))
						})
						.collect::<Result<Vec<_>>>()?;
					#[cfg(feature = "test-faults")]
					maybe_fire_commit_fault(
						&fault_controller,
						&database_id,
						CommitFaultPoint::AfterLtxEncode,
						Some(branch_id),
					)
					.await?;

					let new_head = DBHead {
						head_txid: txid,
						db_size_pages,
						post_apply_checksum: previous_head
							.as_ref()
							.map_or(0, |head| head.post_apply_checksum),
						branch_id,
					};
					let encoded_head =
						encode_db_head(new_head.clone()).context("encode new sqlite db head")?;
					let txid_bytes = txid.to_be_bytes();
					let commit_row = CommitRow {
						wall_clock_ms: now_ms,
						versionstamp: udb::INCOMPLETE_VERSIONSTAMP,
						db_size_pages,
						post_apply_checksum: new_head.post_apply_checksum,
					};
					let encoded_commit_row =
						encode_commit_row(commit_row).context("encode sqlite commit row")?;
					let versionstamped_commit_row = udb::append_versionstamp_offset(
						encoded_commit_row.clone(),
						&udb::INCOMPLETE_VERSIONSTAMP,
					)
					.context("prepare versionstamped sqlite commit row")?;
					let commit_key = keys::branch_commit_key(branch_id, txid);
					let vtx_storage_key =
						keys::branch_vtx_key(branch_id, udb::INCOMPLETE_VERSIONSTAMP);
					let versionstamped_vtx_key = udb::append_versionstamp_offset(
						vtx_storage_key.clone(),
						&udb::INCOMPLETE_VERSIONSTAMP,
					)
					.context("prepare versionstamped sqlite vtx key")?;
					let pidx_tx = &tx;
					let previous_pidx_rows = stream::iter(dirty_pgnos.iter().copied())
						.map(move |pgno| async move {
							let key = keys::branch_pidx_key(branch_id, pgno);
							let value = tx_get_value(pidx_tx, &key, Serializable).await?;
							Ok::<_, anyhow::Error>((key, value))
						})
						.buffer_unordered(32)
						.try_collect::<Vec<_>>()
						.await?;
					let newly_indexed_pgnos = previous_pidx_rows
						.iter()
						.filter(|(_, value)| value.is_none())
						.map(|(key, _)| keys::decode_branch_pidx_pgno(branch_id, key))
						.collect::<Result<BTreeSet<_>>>()?;
					let page_history_complete_key =
						keys::branch_page_history_complete_txid_key(branch_id);
					let previous_page_history_complete_bytes = if branch_resolution.database_initialized {
						None
					} else {
						tx_get_value(&tx, &page_history_complete_key, Serializable)
							.await?
					};
					let previous_page_history_complete = if branch_resolution.database_initialized {
						Some(0)
					} else {
						previous_page_history_complete_bytes
							.as_ref()
							.map(|bytes| {
								let bytes: [u8; std::mem::size_of::<u64>()] = bytes
									.as_slice()
									.try_into()
									.context("sqlite page-history watermark should be exactly 8 bytes")?;
								Ok::<u64, anyhow::Error>(u64::from_be_bytes(bytes))
							})
							.transpose()?
					};
					let advance_page_history = previous_page_history_complete == Some(actual_head_txid);
					if branch_resolution.database_initialized {
						quota::initialize_pidx_count_index(&tx, branch_id);
					} else {
						quota::ensure_pidx_count_index_initialized(&tx, branch_id).await?;
					}
					metrics::observe_commit_phase(
						&phase_node_id,
						"encode_delta",
						phase_start,
						"ok",
					);

					let added_bytes_without_attempt_proof =
						tracked_entry_size(&head_key, &encoded_head)?
						+ tracked_entry_size(&commit_key, &encoded_commit_row)?
						+ tracked_entry_size(&vtx_storage_key, &txid_bytes)?
						+ delta_chunks
							.iter()
							.map(|(key, value)| tracked_entry_size(key, value))
							.sum::<Result<i64>>()?
						+ dirty_pgnos
							.iter()
							.map(|pgno| {
								let pidx_bytes = tracked_entry_size(
									&keys::branch_pidx_key(branch_id, *pgno),
									&txid_bytes,
								)?;
								let history_bytes = tracked_entry_size(
									&keys::branch_page_history_key(branch_id, *pgno, txid),
									&[],
								)?;
								pidx_bytes
									.checked_add(history_bytes)
									.context("sqlite page index quota bytes overflowed")
							})
							.sum::<Result<i64>>()?
						+ if advance_page_history {
							tracked_entry_size(&page_history_complete_key, &txid_bytes)?
						} else {
							0
						};
					let removed_bytes_without_attempt_proof = head_bytes
						.as_ref()
						.map_or(Ok(0), |bytes| tracked_entry_size(&head_key, bytes))?
						+ truncate_cleanup.deleted_bytes
						+ previous_pidx_rows
							.iter()
							.filter_map(|(key, value)| value.as_ref().map(|value| (key, value)))
							.map(|(key, value)| tracked_entry_size(key, value))
							.sum::<Result<i64>>()?
						+ if advance_page_history {
							previous_page_history_complete_bytes
								.as_ref()
								.map(|bytes| {
									tracked_entry_size(
									&page_history_complete_key,
									bytes,
								)
								})
								.transpose()?
								.unwrap_or(0)
						} else {
							0
						};
					let burst_signal =
						burst_mode::read_branch_signal_for_head(txid, compaction_root.as_ref());
					let deltas_available = if compaction_enabled {
						admit_deltas_available(
							&tx,
							branch_id,
							txid,
							compaction_root.as_ref(),
							burst_signal.compaction_watermark_txid,
							now_ms,
							quota::write_debt_requires_compaction_with_target(
								storage_used,
								write_debt_policy.target_bytes,
							),
						)
						.await?
					} else {
						None
					};
					let provisional_attempt_proof = CommitAttemptProof {
						attempt_id: commit_attempt_id,
						request_hash: commit_request_hash,
						txid,
						db_size_pages,
						deltas_available_at_ms: deltas_available
							.as_ref()
							.map(|signal| signal.dirty_updated_at_ms),
						reset_pidx_cache: truncate_cleanup.reset_pidx_cache,
					};
					let provisional_attempt_proof_bytes =
						encode_commit_attempt_proof(provisional_attempt_proof.clone())
							.context("encode provisional sqlite commit attempt proof")?;
					let added_bytes = added_bytes_without_attempt_proof
						.checked_add(tracked_entry_size(
							&commit_attempt_key,
							&provisional_attempt_proof_bytes,
						)?)
						.context("sqlite commit added bytes overflowed i64")?;
					let encoded_attempt_proof = encode_commit_attempt_proof(provisional_attempt_proof)
						.context("encode sqlite commit attempt proof")?;
					ensure!(
						encoded_attempt_proof.len() == provisional_attempt_proof_bytes.len(),
						"sqlite commit attempt proof size changed after quota calculation"
					);
					let removed_bytes = removed_bytes_without_attempt_proof
						.checked_add(
							commit_attempt_bytes
								.as_ref()
								.map(|bytes| tracked_entry_size(&commit_attempt_key, bytes))
								.transpose()?
								.unwrap_or(0),
						)
						.context("sqlite commit removed bytes overflowed i64")?;
					let quota_delta = added_bytes
						.checked_sub(removed_bytes)
						.context("sqlite commit quota delta overflowed i64")?;
					let would_be = storage_used
						.checked_add(quota_delta)
						.context("sqlite commit quota check overflowed i64")?;
					let write_debt_limit = burst_mode::adjusted_hot_quota_cap(
						write_debt_policy.limit_bytes,
						burst_signal,
					)?;
					if let Err(error) =
						quota::write_debt_check_with_limit(would_be, write_debt_limit)
					{
						crate::metrics::SQLITE_WRITE_DEBT_BACKPRESSURE_TOTAL.inc();
						tracing::warn!(
							%database_id,
							?branch_id,
							write_debt_bytes = would_be,
							write_debt_limit_bytes = write_debt_limit,
							logical_size_bytes = quota::logical_size_bytes(db_size_pages),
							bottomless_enabled,
							"backpressuring sqlite commit while FDB write debt drains"
						);
						return Err(error);
					}

					#[cfg(feature = "test-faults")]
					maybe_fire_commit_fault(
						&fault_controller,
						&database_id,
						CommitFaultPoint::BeforeDeltaWrites,
						Some(branch_id),
					)
					.await?;
					let phase_start = Instant::now();
					for (key, value) in &delta_chunks {
						tx.informal().set(key, value);
					}
					metrics::observe_commit_phase(
						&phase_node_id,
						"write_delta_chunks",
						phase_start,
						"ok",
					);
					#[cfg(feature = "test-faults")]
					maybe_fire_commit_fault(
						&fault_controller,
						&database_id,
						CommitFaultPoint::BeforePidxWrites,
						Some(branch_id),
					)
					.await?;
					let phase_start = Instant::now();
					for pgno in &dirty_pgnos {
						tx.informal()
							.set(&keys::branch_pidx_key(branch_id, *pgno), &txid_bytes);
						if newly_indexed_pgnos.contains(pgno) {
							quota::atomic_add_pidx_row_count(&tx, branch_id, *pgno, 1);
						}
						tx.informal()
							.set(&keys::branch_page_history_key(branch_id, *pgno, txid), &[]);
					}
					if advance_page_history {
						tx.informal().set(&page_history_complete_key, &txid_bytes);
					}
					apply_truncate_shard_cleanup(&tx, &truncate_cleanup).await?;
					metrics::observe_commit_phase(
						&phase_node_id,
						"write_page_index",
						phase_start,
						"ok",
					);
					#[cfg(feature = "test-faults")]
					maybe_fire_commit_fault(
						&fault_controller,
						&database_id,
						CommitFaultPoint::BeforeHeadWrite,
						Some(branch_id),
					)
					.await?;
					let phase_start = Instant::now();
					tx.informal().set(&head_key, &encoded_head);
					tx.informal()
						.set(&commit_attempt_key, &encoded_attempt_proof);
					if head_at_fork_bytes.is_some() {
						tx.informal().clear(&head_at_fork_key);
					}
					if branch_resolution.bucket_initialized {
						branch::write_root_bucket_metadata(
							&tx,
							bucket_id,
							branch_resolution.bucket_branch_id,
							now_ms,
							&udb::INCOMPLETE_VERSIONSTAMP,
						)?;
					}
					if branch_resolution.database_initialized {
						write_root_branch_metadata(
							&tx,
							branch_id,
							bucket_id,
							branch_resolution.bucket_branch_id,
							&database_id,
							now_ms,
							&udb::INCOMPLETE_VERSIONSTAMP,
							branch_resolution.bucket_initialized,
						)
						.await?;
					}
					#[cfg(feature = "test-faults")]
					maybe_fire_commit_fault(
						&fault_controller,
						&database_id,
						CommitFaultPoint::BeforeCommitRows,
						Some(branch_id),
					)
					.await?;
					tx.informal().atomic_op(
						&commit_key,
						&versionstamped_commit_row,
						MutationType::SetVersionstampedValue,
					);
					tx.informal().atomic_op(
						&versionstamped_vtx_key,
						&txid_bytes,
						MutationType::SetVersionstampedKey,
					);
					#[cfg(feature = "test-faults")]
					maybe_fire_commit_fault(
						&fault_controller,
						&database_id,
						CommitFaultPoint::BeforeQuotaMutation,
						Some(branch_id),
					)
					.await?;
					if quota_delta != 0 {
						quota::atomic_add_branch(&tx, branch_id, quota_delta);
					}
					let access_bucket = touch_access_if_bucket_advanced(
						&tx,
						branch_id,
						cached_access_bucket,
						now_ms,
					)
					.await?;
					metrics::observe_commit_phase(
						&phase_node_id,
						"write_manifest",
						phase_start,
						"ok",
					);

					Ok(CommitTxResult {
						branch_id,
						branch_ancestry,
						access_bucket,
						txid,
						deltas_available,
						dirty_pgnos,
						reset_pidx_cache: truncate_cleanup.reset_pidx_cache,
						added_bytes,
						storage_used: would_be,
					})
				}
			})
			.await?;
		#[cfg(feature = "test-faults")]
		maybe_fire_commit_fault(
			&self.fault_controller,
			&self.database_id,
			CommitFaultPoint::AfterUdbCommit,
			Some(result.branch_id),
		)
		.await?;

		let phase_start = Instant::now();
		*self.storage_used.write().await = Some(result.storage_used);
		self.commit_bytes_since_rollup.fetch_add(
			u64::try_from(result.added_bytes)
				.context("commit added bytes should be non-negative")?,
			std::sync::atomic::Ordering::Relaxed,
		);
		#[cfg(not(feature = "pidx-cache"))]
		let _ = (&result.dirty_pgnos, result.reset_pidx_cache);

		let mut cache_snapshot = self.cache_snapshot.write().await;
		let current_branch_id = cache_snapshot.as_ref().map(|snapshot| snapshot.branch_id);
		let publish_branch_changed =
			current_branch_id.is_some_and(|branch_id| branch_id != result.branch_id);
		#[cfg(feature = "pidx-cache")]
		let pidx = if publish_branch_changed {
			Arc::new(DeltaPageIndex::new())
		} else {
			cache_snapshot
				.as_ref()
				.map(|snapshot| Arc::clone(&snapshot.pidx))
				.unwrap_or_else(|| Arc::new(DeltaPageIndex::new()))
		};
		#[cfg(not(feature = "pidx-cache"))]
		let pidx = Arc::new(DeltaPageIndex::new());
		let pidx_was_warm = !pidx.is_empty();
		#[cfg(feature = "pidx-cache")]
		if cache_was_warm || pidx_was_warm || publish_branch_changed {
			if result.reset_pidx_cache {
				pidx.clear();
			}
			for pgno in result.dirty_pgnos {
				pidx.insert(pgno, result.txid);
			}
		}
		#[cfg(not(feature = "pidx-cache"))]
		let _ = (cache_was_warm, pidx_was_warm, publish_branch_changed);
		let last_access_bucket = result.access_bucket.or_else(|| {
			cache_snapshot
				.as_ref()
				.filter(|snapshot| snapshot.branch_id == result.branch_id)
				.and_then(|snapshot| snapshot.last_access_bucket)
		});
		*cache_snapshot = Some(CacheSnapshot {
			branch_id: result.branch_id,
			ancestors: result.branch_ancestry.clone(),
			last_access_bucket,
			pidx,
			cache_head_txid: result.txid,
		});
		metrics::observe_commit_phase(&node_id, "cache_update", phase_start, "ok");

		self.publish_deltas_available_if_needed(result.deltas_available, result.branch_id)
			.await?;

		Ok(CommitResult {
			head_txid: result.txid,
			db_size_pages,
		})
	}

	async fn publish_deltas_available_if_needed(
		&self,
		signal: Option<DeltasAvailable>,
		branch_id: DatabaseBranchId,
	) -> Result<()> {
		#[cfg(not(feature = "test-faults"))]
		let _ = branch_id;

		let Some(signal) = signal else {
			return Ok(());
		};
		let Some(signaler) = &self.compaction_signaler else {
			return Ok(());
		};

		#[cfg(feature = "test-faults")]
		maybe_fire_commit_fault(
			&self.fault_controller,
			&self.database_id,
			CommitFaultPoint::BeforeCompactionSignal,
			Some(branch_id),
		)
		.await?;
		if let Err(err) = signaler(signal).await {
			tracing::warn!(?err, "failed to send sqlite workflow compaction wakeup");
			return Ok(());
		}
		#[cfg(feature = "test-faults")]
		maybe_fire_commit_fault(
			&self.fault_controller,
			&self.database_id,
			CommitFaultPoint::AfterCompactionSignal,
			Some(branch_id),
		)
		.await?;

		Ok(())
	}
}

#[cfg(feature = "test-faults")]
async fn maybe_fire_commit_fault(
	controller: &Option<DepotFaultController>,
	database_id: &str,
	point: CommitFaultPoint,
	branch_id: Option<DatabaseBranchId>,
) -> Result<()> {
	let Some(controller) = controller else {
		return Ok(());
	};

	let mut context = DepotFaultContext::new().database_id(database_id.to_string());
	if let Some(branch_id) = branch_id {
		context = context.database_branch_id(branch_id);
	}
	controller
		.maybe_fire(DepotFaultPoint::Commit(point), context)
		.await?;
	Ok(())
}

fn validate_dirty_pages(dirty_pages: &[DirtyPage], db_size_pages: u32) -> Result<()> {
	let mut seen = BTreeSet::new();
	let mut actual_size_bytes = 0_u64;
	for page in dirty_pages {
		ensure!(page.pgno > 0, "sqlite commit does not accept page 0");
		ensure!(
			page.pgno <= db_size_pages,
			"sqlite commit page {} exceeds declared database size {}",
			page.pgno,
			db_size_pages
		);
		ensure!(
			page.bytes.len() == keys::PAGE_SIZE as usize,
			"sqlite commit page {} had {} bytes, expected {}",
			page.pgno,
			page.bytes.len(),
			keys::PAGE_SIZE
		);
		ensure!(
			seen.insert(page.pgno),
			"sqlite commit duplicated page {} in a single request",
			page.pgno
		);
		actual_size_bytes =
			actual_size_bytes.saturating_add(u64::try_from(page.bytes.len()).unwrap_or(u64::MAX));
	}

	if dirty_pages.len() > MAX_COMMIT_DIRTY_PAGES
		|| actual_size_bytes > MAX_COMMIT_RAW_DIRTY_BYTES as u64
	{
		tracing::warn!(
			dirty_pages = dirty_pages.len(),
			actual_size_bytes,
			max_dirty_pages = MAX_COMMIT_DIRTY_PAGES,
			max_size_bytes = MAX_COMMIT_RAW_DIRTY_BYTES,
			"sqlite commit exceeds engine-side size cap"
		);
		return Err(SqliteStorageError::CommitTooLarge {
			actual_size_bytes,
			max_size_bytes: MAX_COMMIT_RAW_DIRTY_BYTES as u64,
		}
		.into());
	}

	Ok(())
}

/// Binds an idempotency token to one exact logical SQLite commit. Page order is normalized so
/// equivalent requests do not become different merely because a caller used another Vec order.
fn commit_request_hash(
	dirty_pages: &[DirtyPage],
	db_size_pages: u32,
	now_ms: i64,
	expected_head_txid: Option<u64>,
) -> [u8; 32] {
	let mut hasher = Sha256::new();
	hasher.update(b"rivet.depot.commit_request.v1\0");
	hasher.update(db_size_pages.to_be_bytes());
	hasher.update(now_ms.to_be_bytes());
	match expected_head_txid {
		Some(txid) => {
			hasher.update([1]);
			hasher.update(txid.to_be_bytes());
		}
		None => hasher.update([0]),
	}
	hasher.update((dirty_pages.len() as u64).to_be_bytes());

	let mut ordered_pages = dirty_pages.iter().collect::<Vec<_>>();
	ordered_pages.sort_unstable_by_key(|page| page.pgno);
	for page in ordered_pages {
		hasher.update(page.pgno.to_be_bytes());
		hasher.update((page.bytes.len() as u64).to_be_bytes());
		hasher.update(&page.bytes);
	}

	hasher.finalize().into()
}

fn decode_writer_generation(bytes: &[u8]) -> Option<u32> {
	bytes.try_into().ok().map(u32::from_be_bytes)
}

struct CommitTxResult {
	branch_id: DatabaseBranchId,
	branch_ancestry: BranchAncestry,
	access_bucket: Option<i64>,
	txid: u64,
	deltas_available: Option<DeltasAvailable>,
	dirty_pgnos: BTreeSet<u32>,
	reset_pidx_cache: bool,
	added_bytes: i64,
	storage_used: i64,
}
