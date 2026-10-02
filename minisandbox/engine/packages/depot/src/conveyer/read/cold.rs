use std::{collections::BTreeMap, sync::Arc};

use anyhow::{Context, Result, ensure};
use futures_util::{StreamExt, TryStreamExt, stream};
use rivet_perf::{perf_finish, perf_start};
use universaldb::{Database, utils::IsolationLevel::Serializable};

use crate::{
	cold_tier::{ColdTier, validate_cold_shard_object, validate_cold_shard_ref_key},
	conveyer::{
		error::SqliteStorageError,
		keys, metrics,
		shard_blob::{resolve_branch_shard_value, write_branch_shard_blob},
		types::{
			decode_cold_publish_marker, decode_compaction_root, decode_database_branch_record,
		},
	},
};

use super::{GetPagesTxResult, PAGE_SOURCE_FETCH_CONCURRENCY, shard::ColdShardSource};

pub(super) async fn hydrate_cold_sources(
	udb: &Arc<Database>,
	cold_tier: Option<&Arc<dyn ColdTier>>,
	tx_result: &mut GetPagesTxResult,
	allow_side_effects: bool,
	node_id: &str,
) -> Result<()> {
	if tx_result.cold_sources.is_empty() {
		return Ok(());
	}
	let cold_tier = cold_tier.cloned();
	let udb = Arc::clone(udb);
	let node_id = node_id.to_string();
	let sources = tx_result.cold_sources.values().cloned().collect::<Vec<_>>();
	let source_count = sources.len();
	let phase = "hydrate_total";
	let source_node_id = node_id.clone();
	let measure = perf_start!(
		&metrics::SQLITE_COLD_READ_PHASE_DURATION,
		slow_ms = 1_000,
		"depot_cold_read",
		labels: { node_id = %node_id, phase = %phase },
		fields: {
			source_count = %source_count,
			allow_side_effects = %allow_side_effects,
		},
	);
	let hydrated_result = stream::iter(sources)
		.map(move |source| {
			let cold_tier = cold_tier.clone();
			let udb = Arc::clone(&udb);
			let node_id = source_node_id.clone();
			async move {
				let ltx_bytes = hydrate_cold_source(
					&udb,
					cold_tier.as_ref(),
					&source,
					allow_side_effects,
					&node_id,
				)
				.await?;
				Ok::<_, anyhow::Error>((source.source_key(), ltx_bytes))
			}
		})
		.buffer_unordered(PAGE_SOURCE_FETCH_CONCURRENCY)
		.try_collect::<Vec<_>>()
		.await;
	let outcome = if hydrated_result.is_ok() {
		"ok"
	} else {
		"error"
	};
	perf_finish!(measure, fields: { outcome = %outcome, source_count = %source_count });
	metrics::observe_cold_read_phase_result(&node_id, phase, outcome);
	let hydrated = hydrated_result?;

	tx_result.source_blobs.extend(BTreeMap::from_iter(hydrated));
	Ok(())
}

/// Exact-key cold hydration shared by normal page reads and diagnostic PITR reads. It validates
/// the canonical key before network I/O, validates immutable bytes after the fetch, then rechecks
/// the authoritative FDB ref/marker; a missing tier fails closed instead of manufacturing pages.
pub(crate) async fn hydrate_cold_source(
	udb: &Arc<Database>,
	cold_tier: Option<&Arc<dyn ColdTier>>,
	source: &ColdShardSource,
	allow_side_effects: bool,
	node_id: &str,
) -> Result<Vec<u8>> {
	let object_key = source.reference.object_key.clone();
	validate_cold_shard_ref_key(&source.reference).map_err(|error| {
		tracing::error!(%object_key, ?error, "refusing noncanonical cold shard GET");
		SqliteStorageError::ColdObjectCorrupt {
			object_key: object_key.clone(),
		}
	})?;
	let cold_tier =
		cold_tier
			.cloned()
			.ok_or_else(|| SqliteStorageError::ColdObjectUnavailable {
				object_key: object_key.clone(),
			})?;
	let phase = "exact_get";
	let shard_id = source.reference.shard_id;
	let as_of_txid = source.reference.as_of_txid;
	let measure = perf_start!(
		&metrics::SQLITE_COLD_READ_PHASE_DURATION,
		slow_ms = 1_000,
		"depot_cold_read",
		labels: { node_id = %node_id, phase = %phase },
		fields: {
			object_key = %object_key,
			shard_id = %shard_id,
			as_of_txid = %as_of_txid,
		},
	);
	let get_result = cold_tier.get_object(&object_key).await;
	let outcome = if get_result.is_ok() { "ok" } else { "error" };
	perf_finish!(measure, fields: { outcome = %outcome });
	metrics::observe_cold_read_phase_result(node_id, phase, outcome);
	let bytes = get_result.map_err(|error| {
		tracing::error!(%object_key, ?error, "cold shard exact GET failed");
		SqliteStorageError::ColdObjectUnavailable {
			object_key: object_key.clone(),
		}
	})?;
	let phase = "integrity_validate";
	let size_bytes = bytes.len();
	let measure = perf_start!(
		&metrics::SQLITE_COLD_READ_PHASE_DURATION,
		slow_ms = 100,
		"depot_cold_read",
		labels: { node_id = %node_id, phase = %phase },
		fields: { object_key = %object_key, size_bytes = %size_bytes },
	);
	let validate_result = validate_cold_shard_object(&source.reference, &bytes);
	let outcome = if validate_result.is_ok() {
		"ok"
	} else {
		"error"
	};
	perf_finish!(measure, fields: { outcome = %outcome });
	metrics::observe_cold_read_phase_result(node_id, phase, outcome);
	let (object, _) = validate_result.map_err(|error| {
		tracing::error!(%object_key, ?error, "cold shard integrity validation failed");
		SqliteStorageError::ColdObjectCorrupt {
			object_key: object_key.clone(),
		}
	})?;
	let phase = "revalidate_refill";
	let measure = perf_start!(
		&metrics::SQLITE_COLD_READ_PHASE_DURATION,
		slow_ms = 1_000,
		"depot_cold_read",
		labels: { node_id = %node_id, phase = %phase },
		fields: { object_key = %object_key, allow_side_effects = %allow_side_effects },
	);
	let revalidate_result =
		revalidate_and_maybe_refill(udb, source, &object.ltx_bytes, allow_side_effects).await;
	let outcome = if revalidate_result.is_ok() {
		"ok"
	} else {
		"error"
	};
	perf_finish!(measure, fields: { outcome = %outcome });
	metrics::observe_cold_read_phase_result(node_id, phase, outcome);
	let refill = revalidate_result?;
	metrics::SQLITE_COLD_REFILL_TOTAL
		.with_label_values(&[node_id, refill.as_str()])
		.inc();
	Ok(object.ltx_bytes)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ColdRefillOutcome {
	Disabled,
	HotHit,
	Refilled,
}

impl ColdRefillOutcome {
	fn as_str(self) -> &'static str {
		match self {
			Self::Disabled => "disabled",
			Self::HotHit => "hot_hit",
			Self::Refilled => "refilled",
		}
	}
}

async fn revalidate_and_maybe_refill(
	udb: &Arc<Database>,
	source: &ColdShardSource,
	ltx_bytes: &[u8],
	allow_side_effects: bool,
) -> Result<ColdRefillOutcome> {
	let source = source.clone();
	let ltx_bytes = ltx_bytes.to_vec();
	udb.txn("depot_cold_read_revalidate", move |tx| {
		let source = source.clone();
		let ltx_bytes = ltx_bytes.clone();
		async move {
			let object_key = source.reference.object_key.clone();
			let exact_ref = tx
				.informal()
				.get(&source.ref_key, Serializable)
				.await?
				.map(Vec::<u8>::from);
			if exact_ref.as_deref() != Some(source.encoded_ref.as_slice()) {
				return Err(SqliteStorageError::ColdObjectUnavailable { object_key }.into());
			}

			let root_bytes = tx
				.informal()
				.get(
					&keys::branch_compaction_root_key(source.reference.database_branch_id),
					Serializable,
				)
				.await?
				.map(Vec::<u8>::from)
				.ok_or_else(|| SqliteStorageError::ColdObjectUnavailable {
					object_key: source.reference.object_key.clone(),
				})?;
			let root = decode_compaction_root(&root_bytes)
				.context("decode compaction root while revalidating cold read")?;
			ensure!(
				source.reference.as_of_txid <= root.cold_watermark_txid
					&& source.reference.publish_generation <= root.manifest_generation,
				SqliteStorageError::ColdObjectUnavailable {
					object_key: source.reference.object_key.clone(),
				}
			);
			let marker_bytes = tx
				.informal()
				.get(
					&keys::branch_compaction_cold_publish_key(
						source.reference.database_branch_id,
						source.reference.publish_generation,
					),
					Serializable,
				)
				.await?
				.map(Vec::<u8>::from)
				.ok_or_else(|| SqliteStorageError::ColdObjectUnavailable {
					object_key: source.reference.object_key.clone(),
				})?;
			let marker = decode_cold_publish_marker(&marker_bytes)
				.context("decode cold publication marker while revalidating read")?;
			ensure!(
				marker.matches_ref(&source.reference),
				SqliteStorageError::ColdObjectUnavailable {
					object_key: source.reference.object_key.clone(),
				}
			);

			let branch_bytes = tx
				.informal()
				.get(
					&keys::branches_list_key(source.reference.database_branch_id),
					Serializable,
				)
				.await?
				.map(Vec::<u8>::from)
				.ok_or_else(|| SqliteStorageError::ColdObjectUnavailable {
					object_key: source.reference.object_key.clone(),
				})?;
			let branch = decode_database_branch_record(&branch_bytes)
				.context("decode branch while revalidating cold read")?;
			ensure!(
				branch.branch_id == source.reference.database_branch_id
					&& branch.lifecycle_generation == source.reference.lifecycle_generation,
				SqliteStorageError::ColdObjectUnavailable {
					object_key: source.reference.object_key.clone(),
				}
			);

			if allow_side_effects {
				let hot_key = source.source_key();
				let existing_row = tx
					.informal()
					.get(&hot_key, Serializable)
					.await?
					.map(Vec::<u8>::from);
				let existing = match existing_row.as_deref() {
					Some(row) => Some(
						resolve_branch_shard_value(
							&tx,
							source.reference.database_branch_id,
							source.reference.shard_id,
							source.reference.as_of_txid,
							row,
							Serializable,
						)
						.await
						.context("resolve chunked hot shard during cold cache refill")?,
					),
					None => None,
				};
				let outcome = match existing {
					Some(existing) if existing != ltx_bytes => {
						return Err(SqliteStorageError::ShardCacheCorrupt {
							shard_id: source.reference.shard_id,
							as_of_txid: source.reference.as_of_txid,
						}
						.into());
					}
					Some(_) => ColdRefillOutcome::HotHit,
					None => {
						write_branch_shard_blob(
							&tx,
							source.reference.database_branch_id,
							source.reference.shard_id,
							source.reference.as_of_txid,
							&ltx_bytes,
						)?;
						ColdRefillOutcome::Refilled
					}
				};
				return Ok(outcome);
			}
			Ok(ColdRefillOutcome::Disabled)
		}
	})
	.await
}

impl ColdShardSource {
	fn source_key(&self) -> Vec<u8> {
		keys::branch_shard_key(
			self.reference.database_branch_id,
			self.reference.shard_id,
			self.reference.as_of_txid,
		)
	}
}
