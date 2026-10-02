//! Read-only Depot inspection helpers for internal API routes.

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, prelude::BASE64_URL_SAFE_NO_PAD};
use futures_util::TryStreamExt;
use rivet_pools::NodeId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use universaldb::{RangeOption, options::StreamingMode, utils::IsolationLevel::Snapshot};
use uuid::Uuid;

use crate::{
	cold_tier::FdbWriteDebtPolicy,
	conveyer::{
		branch, keys, quota,
		types::{
			BucketId, DatabaseBranchId, decode_bucket_branch_record, decode_bucket_pointer,
			decode_commit_row, decode_compaction_root, decode_database_branch_record,
			decode_database_pointer, decode_database_policy_binding, decode_db_head,
			decode_db_history_pin, decode_pitr_interval_coverage, decode_sqlite_cmp_dirty,
		},
	},
	gc,
};

pub const DEFAULT_LIMIT: usize = 100;
pub const MAX_LIMIT: usize = 1000;
pub const DEFAULT_SAMPLE_LIMIT: usize = 20;
const SUMMARY_COUNT_LIMIT: usize = 10_000;
const BOTTOMLESS_STATE_COUNT_LIMIT: usize = 4_096;

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogQuery {
	pub bucket_id: Option<String>,
	pub database_id: Option<String>,
	pub limit: Option<usize>,
	pub cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SampleQuery {
	pub sample_limit: Option<usize>,
	pub include_history: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RowsQuery {
	pub limit: Option<usize>,
	pub cursor: Option<String>,
	pub include_bytes: Option<bool>,
	pub before_txid: Option<u64>,
	pub after_txid: Option<u64>,
	pub from_pgno: Option<u32>,
	pub shard_id: Option<u32>,
	pub state: Option<String>,
	pub kind: Option<String>,
	pub job_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawScanQuery {
	pub prefix: Option<String>,
	pub start_after: Option<String>,
	pub limit: Option<usize>,
	pub decode: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FootprintPageResponse {
	pub node_id: String,
	pub generated_at_ms: i64,
	pub scope: String,
	pub row_count: usize,
	pub key_bytes: usize,
	pub value_bytes: usize,
	pub raw_bytes: usize,
	/// Hash of length-delimited raw keys and values in this page. A qualification scan repeats every
	/// page after writers have stopped and rejects any mismatch instead of treating a moving range as
	/// an exact footprint.
	pub page_sha256: String,
	pub first_key: Option<String>,
	pub last_key: Option<String>,
	pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum DueQueue {
	BranchGc,
	ColdGc,
}

impl DueQueue {
	fn scope(self) -> &'static str {
		match self {
			Self::BranchGc => "branch-gc",
			Self::ColdGc => "cold-gc",
		}
	}

	fn prefix(self) -> Vec<u8> {
		match self {
			Self::BranchGc => vec![
				keys::SQLITE_SUBSPACE_PREFIX,
				keys::DB_BRANCH_GC_QUEUE_PARTITION,
			],
			Self::ColdGc => vec![
				keys::SQLITE_SUBSPACE_PREFIX,
				keys::DB_BRANCH_COLD_GC_QUEUE_PARTITION,
			],
		}
	}

	fn due_at_ms(self, key: &[u8]) -> Result<i64> {
		match self {
			Self::BranchGc => Ok(keys::decode_branch_gc_queue_key(key)?.1),
			Self::ColdGc => Ok(keys::decode_branch_cold_gc_queue_key(key)?.1),
		}
	}
}

#[derive(Debug, Clone, Serialize)]
pub struct DueQueuePageResponse {
	pub node_id: String,
	pub generated_at_ms: i64,
	pub scope: String,
	pub row_count: usize,
	pub due_rows: usize,
	pub future_retained_rows: usize,
	pub oldest_due_at_ms: Option<i64>,
	pub newest_due_at_ms: Option<i64>,
	pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InspectResponse {
	pub node_id: String,
	pub generated_at_ms: i64,
	pub scope: Value,
	#[serde(flatten)]
	pub data: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct PaginatedRowsResponse {
	pub node_id: String,
	pub generated_at_ms: i64,
	pub scope: Value,
	pub rows: Vec<Value>,
	pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogResponse {
	pub node_id: String,
	pub generated_at_ms: i64,
	pub scope: Value,
	pub buckets: Vec<Value>,
	pub databases: Vec<Value>,
	pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum RowFamily {
	Commits,
	Pidx,
	Deltas,
	Shards,
	PitrIntervals,
	Pins,
	StagedHotShards,
	ColdShards,
	ColdPublishMarkers,
	RetiredColdObjects,
}

impl RowFamily {
	pub fn parse(value: &str) -> Result<Self> {
		match value {
			"commits" => Ok(Self::Commits),
			"pidx" => Ok(Self::Pidx),
			"deltas" => Ok(Self::Deltas),
			"shards" => Ok(Self::Shards),
			"pitr-intervals" => Ok(Self::PitrIntervals),
			"pins" => Ok(Self::Pins),
			"staged-hot-shards" => Ok(Self::StagedHotShards),
			"cold-shards" => Ok(Self::ColdShards),
			"cold-publish-markers" => Ok(Self::ColdPublishMarkers),
			"retired-cold-objects" => Ok(Self::RetiredColdObjects),
			_ => bail!("unsupported Depot inspect row family: {value}"),
		}
	}

	fn as_str(self) -> &'static str {
		match self {
			Self::Commits => "commits",
			Self::Pidx => "pidx",
			Self::Deltas => "deltas",
			Self::Shards => "shards",
			Self::PitrIntervals => "pitr-intervals",
			Self::Pins => "pins",
			Self::StagedHotShards => "staged-hot-shards",
			Self::ColdShards => "cold-shards",
			Self::ColdPublishMarkers => "cold-publish-markers",
			Self::RetiredColdObjects => "retired-cold-objects",
		}
	}

	fn scan_prefix(self, branch_id: DatabaseBranchId) -> Vec<u8> {
		match self {
			Self::Commits => keys::branch_commit_prefix(branch_id),
			Self::Pidx => keys::branch_pidx_prefix(branch_id),
			Self::Deltas => keys::branch_delta_prefix(branch_id),
			Self::Shards => keys::branch_shard_prefix(branch_id),
			Self::PitrIntervals => keys::branch_pitr_interval_prefix(branch_id),
			Self::Pins => keys::db_pin_prefix(branch_id),
			Self::StagedHotShards => keys::branch_compaction_stage_prefix(branch_id),
			Self::ColdShards => keys::branch_compaction_cold_shard_prefix(branch_id),
			Self::ColdPublishMarkers => keys::branch_compaction_cold_publish_prefix(branch_id),
			Self::RetiredColdObjects => {
				keys::branch_compaction_retired_cold_object_prefix(branch_id)
			}
		}
	}
}

pub async fn summary(db: &universaldb::Database, node_id: NodeId) -> Result<InspectResponse> {
	let counters = db
		.txn("depot_inspect_summary_counters", |tx| async move {
			Ok(json!({
				"bucket_pointers": count_prefix(&tx, keys::bucket_pointer_cur_prefix()).await?,
				"database_pointers": count_prefix(&tx, keys::database_pointer_cur_prefix()).await?,
				"database_branches": count_prefix(&tx, vec![keys::SQLITE_SUBSPACE_PREFIX, keys::BRANCHES_PARTITION]).await?,
				"database_policy_bindings": count_prefix(&tx, vec![keys::SQLITE_SUBSPACE_PREFIX, keys::DB_POLICY_BINDING_PARTITION]).await?,
				"bucket_branches": count_prefix(&tx, vec![keys::SQLITE_SUBSPACE_PREFIX, keys::BUCKET_BRANCH_PARTITION]).await?,
				"dirty_branches": count_prefix(&tx, vec![keys::SQLITE_SUBSPACE_PREFIX, keys::SQLITE_CMP_DIRTY_PARTITION]).await?,
				"compaction_state_rows": count_prefix(&tx, vec![keys::SQLITE_SUBSPACE_PREFIX, keys::CMPC_PARTITION]).await?,
			}))
		})
		.await?;

	response(
		node_id,
		json!({ "kind": "summary" }),
		json!({
			"counters": counters,
		}),
	)
}

pub async fn catalog(
	db: &universaldb::Database,
	node_id: NodeId,
	query: CatalogQuery,
) -> Result<CatalogResponse> {
	let limit = page_limit(query.limit)?;
	let cursor = decode_optional_key(query.cursor.as_deref())?;
	let bucket_filter = query
		.bucket_id
		.as_deref()
		.map(parse_bucket_id)
		.transpose()?;
	let database_filter = query.database_id.clone();
	let rows = db
		.txn("depot_inspect_catalog", move |tx| {
			let cursor = cursor.clone();
			let database_filter = database_filter.clone();
			async move {
				let bucket_pointer = if let Some(bucket_id) = bucket_filter {
					tx_get_decoded(
						&tx,
						keys::bucket_pointer_cur_key(bucket_id),
						decode_bucket_pointer,
					)
					.await?
					.map(|pointer| (bucket_id, pointer))
				} else {
					None
				};
				let bucket_branch_filter = bucket_pointer
					.as_ref()
					.map(|(_bucket_id, pointer)| pointer.current_branch);
				let scanned = scan_prefix_page(
					&tx,
					keys::database_pointer_cur_prefix(),
					cursor.as_deref(),
					limit,
				)
				.await?;
				let mut rows = Vec::new();
				let mut next_cursor = None;
				for row in scanned.rows {
					let (bucket_branch_id, database_id) =
						keys::decode_database_pointer_cur_key(&row.key)?;
					if bucket_branch_filter.is_some_and(|filter| filter != bucket_branch_id) {
						continue;
					}
					if database_filter
						.as_deref()
						.is_some_and(|filter| filter != database_id)
					{
						continue;
					}
					let pointer = decode_database_pointer(&row.value)?;
					rows.push(json!({
						"key": encode_key(&row.key),
						"bucket_branch_id": bucket_branch_id,
						"database_id": database_id,
						"current_database_branch_id": pointer.current_branch,
						"last_swapped_at_ms": pointer.last_swapped_at_ms,
					}));
				}
				if scanned.has_more {
					next_cursor = scanned.next_cursor;
				}

				let buckets = if let Some((bucket_id, pointer)) = bucket_pointer {
					vec![json!({
						"key": encode_key(&keys::bucket_pointer_cur_key(bucket_id)),
						"bucket_id": bucket_id,
						"current_bucket_branch_id": pointer.current_branch,
						"last_swapped_at_ms": pointer.last_swapped_at_ms,
					})]
				} else {
					let bucket_rows =
						scan_prefix_page(&tx, keys::bucket_pointer_cur_prefix(), None, limit)
							.await?;
					let mut buckets = Vec::new();
					for row in bucket_rows.rows {
						let bucket_id = keys::decode_bucket_pointer_cur_bucket_id(&row.key)?;
						let pointer = decode_bucket_pointer(&row.value)?;
						buckets.push(json!({
							"key": encode_key(&row.key),
							"bucket_id": bucket_id,
							"current_bucket_branch_id": pointer.current_branch,
							"last_swapped_at_ms": pointer.last_swapped_at_ms,
						}));
					}
					buckets
				};

				Ok((buckets, rows, next_cursor))
			}
		})
		.await?;

	Ok(CatalogResponse {
		node_id: node_id.to_string(),
		generated_at_ms: now_ms()?,
		scope: json!({ "kind": "catalog" }),
		buckets: rows.0,
		databases: rows.1,
		next_cursor: rows.2.map(|key| encode_key(&key)),
	})
}

pub async fn bucket(
	db: &universaldb::Database,
	node_id: NodeId,
	bucket_id: BucketId,
	query: SampleQuery,
) -> Result<InspectResponse> {
	let sample_limit = sample_limit(query.sample_limit)?;
	let include_history = query.include_history.unwrap_or(false);
	let data = db
		.txn("depot_inspect_bucket", move |tx| async move {
			let pointer = tx_get_decoded(
				&tx,
				keys::bucket_pointer_cur_key(bucket_id),
				decode_bucket_pointer,
			)
			.await?;
			let current_branch = match &pointer {
				Some(pointer) => Some(pointer.current_branch),
				None => None,
			};
			let branch_record = if let Some(branch_id) = current_branch {
				tx_get_decoded(
					&tx,
					keys::bucket_branches_list_key(branch_id),
					decode_bucket_branch_record,
				)
				.await?
			} else {
				None
			};
			let catalog = if let Some(branch_id) = current_branch {
				summary_for_prefix(&tx, keys::bucket_catalog_prefix(branch_id), sample_limit)
					.await?
			} else {
				empty_summary()
			};
			let tombstones = if let Some(branch_id) = current_branch {
				summary_for_prefix(
					&tx,
					keys::bucket_branches_database_tombstone_prefix(branch_id),
					sample_limit,
				)
				.await?
			} else {
				empty_summary()
			};
			let history = if include_history {
				summary_for_prefix(
					&tx,
					keys::bucket_pointer_history_prefix(bucket_id),
					sample_limit,
				)
				.await?
			} else {
				empty_summary()
			};

			Ok(json!({
				"bucket_id": bucket_id,
				"pointer": pointer,
				"current_branch": branch_record,
				"summaries": {
					"catalog": catalog,
					"tombstones": tombstones,
					"pointer_history": history,
				},
				"links": {
					"catalog": "/depot/inspect/catalog",
				}
			}))
		})
		.await?;

	response(
		node_id,
		json!({ "kind": "bucket", "bucket_id": bucket_id }),
		data,
	)
}

pub async fn database(
	db: &universaldb::Database,
	node_id: NodeId,
	bucket_id: BucketId,
	database_id: String,
	query: SampleQuery,
) -> Result<InspectResponse> {
	let sample_limit = sample_limit(query.sample_limit)?;
	let scope_database_id = database_id.clone();
	let data = db
		.txn("depot_inspect_database", move |tx| {
			let database_id = database_id.clone();
			async move {
				let bucket_pointer = tx_get_decoded(
					&tx,
					keys::bucket_pointer_cur_key(bucket_id),
					decode_bucket_pointer,
				)
				.await?;
				let Some(bucket_pointer) = bucket_pointer else {
					return Ok(
						json!({ "bucket_id": bucket_id, "database_id": database_id, "pointer": null }),
					);
				};
				let pointer = tx_get_decoded(
					&tx,
					keys::database_pointer_cur_key(bucket_pointer.current_branch, &database_id),
					decode_database_pointer,
				)
				.await?;
				let branch = if let Some(pointer) = &pointer {
					branch_blob_in_tx(&tx, pointer.current_branch, sample_limit).await?
				} else {
					json!(null)
				};

				Ok(json!({
					"bucket_id": bucket_id,
					"database_id": database_id,
					"bucket_branch_id": bucket_pointer.current_branch,
					"pointer": pointer,
					"branch": branch,
				}))
			}
		})
		.await?;

	response(
		node_id,
		json!({ "kind": "database", "bucket_id": bucket_id, "database_id": scope_database_id }),
		data,
	)
}

/// Returns exact, bounded evidence for one logical Bottomless database. The logical pointer is
/// resolved before any branch-local range read, and object storage is never listed.
pub async fn bottomless_state(
	db: &universaldb::Database,
	node_id: NodeId,
	bucket_id: BucketId,
	database_id: String,
	write_debt_policy: FdbWriteDebtPolicy,
) -> Result<InspectResponse> {
	let scope_database_id = database_id.clone();
	let data = db
		.txn("depot_inspect_bottomless_state", move |tx| {
			let database_id = database_id.clone();
			async move {
				let Some(branch_id) =
					branch::resolve_database_branch(&tx, bucket_id, &database_id, Snapshot).await?
				else {
					return Ok(json!({
						"found": false,
						"bucket_id": bucket_id,
						"database_id": database_id,
					}));
				};
				let head =
					tx_get_decoded(&tx, keys::branch_meta_head_key(branch_id), decode_db_head)
						.await?;
				let root = tx_get_decoded(
					&tx,
					keys::branch_compaction_root_key(branch_id),
					decode_compaction_root,
				)
				.await?;
				let write_debt_bytes = quota::read_branch(&tx, branch_id).await?;
				let hot_shards = bounded_prefix_count(
					&tx,
					keys::branch_shard_prefix(branch_id),
					BOTTOMLESS_STATE_COUNT_LIMIT,
				)
				.await?;
				let cold_shards = bounded_prefix_count(
					&tx,
					keys::branch_compaction_cold_shard_prefix(branch_id),
					BOTTOMLESS_STATE_COUNT_LIMIT,
				)
				.await?;
				let cold_publish_markers = bounded_prefix_count(
					&tx,
					keys::branch_compaction_cold_publish_prefix(branch_id),
					BOTTOMLESS_STATE_COUNT_LIMIT,
				)
				.await?;
				let staged_hot_shards = bounded_prefix_count(
					&tx,
					keys::branch_compaction_stage_prefix(branch_id),
					BOTTOMLESS_STATE_COUNT_LIMIT,
				)
				.await?;
				let pitr_intervals = bounded_prefix_count(
					&tx,
					keys::branch_pitr_interval_prefix(branch_id),
					BOTTOMLESS_STATE_COUNT_LIMIT,
				)
				.await?;
				let head_txid = head.as_ref().map_or(0, |head| head.head_txid);
				let cold_watermark_txid = root.as_ref().map_or(0, |root| root.cold_watermark_txid);
				let counts_exact = [
					&hot_shards,
					&cold_shards,
					&cold_publish_markers,
					&staged_hot_shards,
					&pitr_intervals,
				]
				.iter()
				.all(|count| !count.truncated);
				let cold_ready = counts_exact
					&& head_txid > 0
					&& cold_watermark_txid >= head_txid
					&& cold_shards.count > 0
					&& cold_publish_markers.count > 0
					&& pitr_intervals.count > 0
					&& staged_hot_shards.count == 0
					&& hot_shards.count == 0;

				Ok(json!({
					"found": true,
					"bottomless_contract_version": 1,
					"bucket_id": bucket_id,
					"database_id": database_id,
					"branch_id": branch_id,
					"head": head,
					"compaction_root": root,
					"logical_size_bytes": head.as_ref().map(|head| quota::logical_size_bytes(head.db_size_pages)),
					"logical_storage_limit_bytes": quota::LOGICAL_STORAGE_LIMIT_BYTES,
					"fdb_write_debt_bytes": write_debt_bytes,
					"fdb_write_debt_target_bytes": write_debt_policy.target_bytes,
					"fdb_write_debt_limit_bytes": write_debt_policy.limit_bytes,
					"counts_exact": counts_exact,
					"cold_ready": cold_ready,
					"row_counts": {
						"hot_shards": hot_shards,
						"cold_shards": cold_shards,
						"cold_publish_markers": cold_publish_markers,
						"staged_hot_shards": staged_hot_shards,
						"pitr_intervals": pitr_intervals,
					},
				}))
			}
		})
		.await?;

	response(
		node_id,
		json!({
			"kind": "bottomless_state",
			"bucket_id": bucket_id,
			"database_id": scope_database_id,
		}),
		data,
	)
}

pub async fn branch(
	db: &universaldb::Database,
	node_id: NodeId,
	branch_id: DatabaseBranchId,
	query: SampleQuery,
) -> Result<InspectResponse> {
	let sample_limit = sample_limit(query.sample_limit)?;
	let data = db
		.txn("depot_inspect_branch", move |tx| async move {
			branch_blob_in_tx(&tx, branch_id, sample_limit).await
		})
		.await?;

	response(
		node_id,
		json!({ "kind": "branch", "branch_id": branch_id }),
		data,
	)
}

pub async fn branch_rows(
	db: &universaldb::Database,
	node_id: NodeId,
	branch_id: DatabaseBranchId,
	family: RowFamily,
	query: RowsQuery,
) -> Result<PaginatedRowsResponse> {
	let limit = page_limit(query.limit)?;
	let cursor = decode_optional_key(query.cursor.as_deref())?;
	let prefix = family.scan_prefix(branch_id);
	let include_bytes = query.include_bytes.unwrap_or(false);
	let scan = db
		.txn("depot_inspect_branch_rows", move |tx| {
			let prefix = prefix.clone();
			let cursor = cursor.clone();
			async move { scan_prefix_page(&tx, prefix, cursor.as_deref(), limit).await }
		})
		.await?;
	let mut rows = Vec::new();
	for row in scan.rows {
		rows.push(decode_row_value(
			branch_id,
			family,
			&row.key,
			&row.value,
			include_bytes,
		));
	}

	Ok(PaginatedRowsResponse {
		node_id: node_id.to_string(),
		generated_at_ms: now_ms()?,
		scope: json!({
			"kind": "branch_rows",
			"branch_id": branch_id,
			"family": family.as_str(),
		}),
		rows,
		next_cursor: scan.next_cursor.map(|key| encode_key(&key)),
	})
}

pub async fn raw_key(
	db: &universaldb::Database,
	node_id: NodeId,
	key: Vec<u8>,
) -> Result<InspectResponse> {
	let value = db
		.txn("depot_inspect_raw_key", {
			let key = key.clone();
			move |tx| {
				let key = key.clone();
				async move {
					Ok(tx
						.informal()
						.get(&key, Snapshot)
						.await?
						.map(Vec::<u8>::from))
				}
			}
		})
		.await?;
	let decoded = best_effort_decode(&key, value.as_deref());

	response(
		node_id,
		json!({ "kind": "raw_key" }),
		json!({
			"key": encode_key(&key),
			"value": value.as_ref().map(|value| encode_key(value)),
			"value_size": value.as_ref().map(Vec::len),
			"decoded": decoded,
		}),
	)
}

pub async fn raw_scan(
	db: &universaldb::Database,
	node_id: NodeId,
	query: RawScanQuery,
) -> Result<PaginatedRowsResponse> {
	let limit = page_limit(query.limit)?;
	let prefix = decode_optional_key(query.prefix.as_deref())?.unwrap_or_default();
	let cursor = decode_optional_key(query.start_after.as_deref())?;
	let decode = query.decode.unwrap_or(true);
	let scan = db
		.txn("depot_inspect_raw_scan", move |tx| {
			let prefix = prefix.clone();
			let cursor = cursor.clone();
			async move { scan_prefix_page(&tx, prefix, cursor.as_deref(), limit).await }
		})
		.await?;
	let rows = scan
		.rows
		.into_iter()
		.map(|row| {
			json!({
				"key": encode_key(&row.key),
				"value_size": row.value.len(),
				"value": encode_key(&row.value),
				"decoded": decode.then(|| best_effort_decode(&row.key, Some(&row.value))),
			})
		})
		.collect();

	Ok(PaginatedRowsResponse {
		node_id: node_id.to_string(),
		generated_at_ms: now_ms()?,
		scope: json!({ "kind": "raw_scan" }),
		rows,
		next_cursor: scan.next_cursor.map(|key| encode_key(&key)),
	})
}

/// Returns one bounded, value-free footprint page for an exact raw prefix.
///
/// This is deliberately a page primitive rather than a server-side full-range aggregate. Even a
/// million-Actor qualification must never turn one FDB transaction into an unbounded global scan.
/// Callers are responsible for stopping writers and repeating the complete scan to prove that the
/// measured keyspace did not move between page transactions.
pub async fn footprint_page(
	db: &universaldb::Database,
	node_id: NodeId,
	scope: String,
	prefix: Vec<u8>,
	start_after: Option<String>,
	limit: Option<usize>,
) -> Result<FootprintPageResponse> {
	let limit = page_limit(limit)?;
	let cursor = decode_optional_key(start_after.as_deref())?;
	let scan = db
		.txn("depot_inspect_footprint_page", move |tx| {
			let prefix = prefix.clone();
			let cursor = cursor.clone();
			async move { scan_prefix_page(&tx, prefix, cursor.as_deref(), limit).await }
		})
		.await?;

	let row_count = scan.rows.len();
	let key_bytes = scan.rows.iter().map(|row| row.key.len()).sum::<usize>();
	let value_bytes = scan.rows.iter().map(|row| row.value.len()).sum::<usize>();
	let mut page_hasher = Sha256::new();
	for row in &scan.rows {
		page_hasher.update((row.key.len() as u64).to_be_bytes());
		page_hasher.update(&row.key);
		page_hasher.update((row.value.len() as u64).to_be_bytes());
		page_hasher.update(&row.value);
	}

	Ok(FootprintPageResponse {
		node_id: node_id.to_string(),
		generated_at_ms: now_ms()?,
		scope,
		row_count,
		key_bytes,
		value_bytes,
		raw_bytes: key_bytes.saturating_add(value_bytes),
		page_sha256: hex::encode(page_hasher.finalize()),
		first_key: scan.rows.first().map(|row| encode_key(&row.key)),
		last_key: scan.rows.last().map(|row| encode_key(&row.key)),
		next_cursor: scan.next_cursor.map(|key| encode_key(&key)),
	})
}

/// Inspect one bounded page of a time-ordered GC queue. Future recovery-window rows are reported
/// separately from actionable backlog and must not be deleted merely to make an operational graph
/// reach zero.
pub async fn due_queue_page(
	db: &universaldb::Database,
	node_id: NodeId,
	queue: DueQueue,
	start_after: Option<String>,
	limit: Option<usize>,
	now_ms: i64,
) -> Result<DueQueuePageResponse> {
	let limit = page_limit(limit)?;
	let cursor = decode_optional_key(start_after.as_deref())?;
	let prefix = queue.prefix();
	let scan = db
		.txn("depot_inspect_due_queue_page", move |tx| {
			let prefix = prefix.clone();
			let cursor = cursor.clone();
			async move { scan_prefix_page(&tx, prefix, cursor.as_deref(), limit).await }
		})
		.await?;
	let due_at = scan
		.rows
		.iter()
		.map(|row| queue.due_at_ms(&row.key))
		.collect::<Result<Vec<_>>>()?;
	let due_rows = due_at.iter().filter(|due| **due <= now_ms).count();

	Ok(DueQueuePageResponse {
		node_id: node_id.to_string(),
		generated_at_ms: now_ms,
		scope: queue.scope().to_string(),
		row_count: scan.rows.len(),
		due_rows,
		future_retained_rows: scan.rows.len().saturating_sub(due_rows),
		oldest_due_at_ms: due_at.iter().copied().min(),
		newest_due_at_ms: due_at.iter().copied().max(),
		next_cursor: scan.next_cursor.map(|key| encode_key(&key)),
	})
}

pub fn decode_key_response(node_id: NodeId, key: Vec<u8>) -> Result<InspectResponse> {
	response(
		node_id,
		json!({ "kind": "raw_decode_key" }),
		json!({
			"key": encode_key(&key),
			"decoded": best_effort_decode(&key, None),
		}),
	)
}

pub async fn page_trace(
	db: &universaldb::Database,
	node_id: NodeId,
	branch_id: DatabaseBranchId,
	pgno: u32,
) -> Result<InspectResponse> {
	let head = db
		.txn("depot_inspect_page_trace", move |tx| async move {
			tx_get_decoded(&tx, keys::branch_meta_head_key(branch_id), decode_db_head).await
		})
		.await?;
	let outcome = if head.as_ref().is_some_and(|head| pgno <= head.db_size_pages) {
		"found"
	} else {
		"above_eof"
	};

	response(
		node_id,
		json!({ "kind": "page", "branch_id": branch_id, "pgno": pgno }),
		json!({
			"read_cap": head,
			"outcome": outcome,
			"source": { "kind": "unknown", "branch_id": branch_id },
			"steps": [],
			"bytes": null,
		}),
	)
}

pub fn decode_path_key(value: &str) -> Result<Vec<u8>> {
	BASE64_URL_SAFE_NO_PAD
		.decode(value)
		.context("decode unpadded base64url Depot inspect key")
}

fn response(node_id: NodeId, scope: Value, data: Value) -> Result<InspectResponse> {
	Ok(InspectResponse {
		node_id: node_id.to_string(),
		generated_at_ms: now_ms()?,
		scope,
		data,
	})
}

fn page_limit(limit: Option<usize>) -> Result<usize> {
	let limit = limit.unwrap_or(DEFAULT_LIMIT);
	ensure!(
		(1..=MAX_LIMIT).contains(&limit),
		"Depot inspect limit must be 1..={MAX_LIMIT} (hard cap)"
	);
	Ok(limit)
}

fn sample_limit(limit: Option<usize>) -> Result<usize> {
	let limit = limit.unwrap_or(DEFAULT_SAMPLE_LIMIT);
	ensure!(
		(1..=MAX_LIMIT).contains(&limit),
		"Depot inspect sample_limit must be 1..={MAX_LIMIT} (hard cap)"
	);
	Ok(limit)
}

fn now_ms() -> Result<i64> {
	let duration = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.context("system clock is before unix epoch")?;
	i64::try_from(duration.as_millis()).context("timestamp exceeds i64")
}

fn encode_key(key: &[u8]) -> String {
	BASE64_URL_SAFE_NO_PAD.encode(key)
}

fn decode_optional_key(value: Option<&str>) -> Result<Option<Vec<u8>>> {
	value.map(decode_path_key).transpose()
}

fn parse_bucket_id(value: &str) -> Result<BucketId> {
	Ok(BucketId::from_uuid(
		Uuid::parse_str(value).context("parse Depot inspect bucket id")?,
	))
}

async fn tx_get_decoded<T, F>(
	tx: &universaldb::Transaction,
	key: Vec<u8>,
	decode: F,
) -> Result<Option<T>>
where
	F: Fn(&[u8]) -> Result<T>,
{
	let Some(value) = tx.informal().get(&key, Snapshot).await? else {
		return Ok(None);
	};

	Ok(Some(decode(&value)?))
}

struct ScannedRow {
	key: Vec<u8>,
	value: Vec<u8>,
}

struct ScanPage {
	rows: Vec<ScannedRow>,
	next_cursor: Option<Vec<u8>>,
	has_more: bool,
}

async fn scan_prefix_page(
	tx: &universaldb::Transaction,
	prefix: Vec<u8>,
	cursor: Option<&[u8]>,
	limit: usize,
) -> Result<ScanPage> {
	if let Some(cursor) = cursor {
		ensure!(
			cursor.starts_with(&prefix),
			"Depot inspect cursor is outside the requested prefix"
		);
	}

	let (range_start, range_end) = inspect_prefix_range(&prefix);
	let begin = cursor
		.map(universaldb::KeySelector::first_greater_than)
		.unwrap_or_else(|| universaldb::KeySelector::first_greater_or_equal(range_start));
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			begin,
			end: universaldb::KeySelector::first_greater_or_equal(range_end),
			limit: Some(limit.saturating_add(1)),
			mode: StreamingMode::Exact,
			..RangeOption::default()
		},
		Snapshot,
	);
	let mut rows = Vec::new();
	while let Some(entry) = stream.try_next().await? {
		rows.push(ScannedRow {
			key: entry.key().to_vec(),
			value: entry.value().to_vec(),
		});
	}

	let has_more = rows.len() > limit;
	let overflow = if has_more { rows.pop() } else { None };
	let next_cursor = if has_more {
		rows.last()
			.map(|row| row.key.clone())
			.or_else(|| overflow.map(|row| row.key))
	} else {
		None
	};

	Ok(ScanPage {
		rows,
		next_cursor,
		has_more,
	})
}

async fn count_prefix(tx: &universaldb::Transaction, prefix: Vec<u8>) -> Result<Value> {
	let (range_start, range_end) = inspect_prefix_range(&prefix);
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			begin: universaldb::KeySelector::first_greater_or_equal(range_start),
			end: universaldb::KeySelector::first_greater_or_equal(range_end),
			limit: Some(SUMMARY_COUNT_LIMIT.saturating_add(1)),
			mode: StreamingMode::Exact,
			..RangeOption::default()
		},
		Snapshot,
	);
	let mut count = 0_usize;
	while stream.try_next().await?.is_some() {
		count = count.saturating_add(1);
	}
	Ok(json!({
		"count": count.min(SUMMARY_COUNT_LIMIT),
		"truncated": count > SUMMARY_COUNT_LIMIT,
	}))
}

/// Raw inspection permits an empty prefix to mean the complete application keyspace. The
/// general-purpose prefix helper rejects that ambiguous input, so spell out FDB's application
/// range here while keeping exact raw-prefix semantics for every non-empty prefix.
fn inspect_prefix_range(prefix: &[u8]) -> (Vec<u8>, Vec<u8>) {
	if prefix.is_empty() {
		(Vec::new(), vec![0xff])
	} else {
		universaldb::utils::range_for_prefix(prefix)
	}
}

async fn summary_for_prefix(
	tx: &universaldb::Transaction,
	prefix: Vec<u8>,
	sample_limit: usize,
) -> Result<Value> {
	let scan = scan_prefix_page(tx, prefix, None, sample_limit).await?;
	Ok(json!({
		"count": scan.rows.len(),
		"truncated": scan.has_more,
		"sample": scan.rows.into_iter().map(|row| {
			json!({
				"key": encode_key(&row.key),
				"value_size": row.value.len(),
				"decoded": best_effort_decode(&row.key, Some(&row.value)),
			})
		}).collect::<Vec<_>>(),
		"next_cursor": scan.next_cursor.map(|key| encode_key(&key)),
	}))
}

fn empty_summary() -> Value {
	json!({
		"count": 0,
		"truncated": false,
		"sample": [],
		"next_cursor": null,
	})
}

async fn branch_blob_in_tx(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	sample_limit: usize,
) -> Result<Value> {
	let record = tx_get_decoded(
		tx,
		keys::branches_list_key(branch_id),
		decode_database_branch_record,
	)
	.await?;
	let head = tx_get_decoded(tx, keys::branch_meta_head_key(branch_id), decode_db_head).await?;
	let head_at_fork = tx_get_decoded(
		tx,
		keys::branch_meta_head_at_fork_key(branch_id),
		decode_db_head,
	)
	.await?;
	let compaction_root = tx_get_decoded(
		tx,
		keys::branch_compaction_root_key(branch_id),
		decode_compaction_root,
	)
	.await?;
	let dirty = tx_get_decoded(
		tx,
		keys::sqlite_cmp_dirty_key(branch_id),
		decode_sqlite_cmp_dirty,
	)
	.await?;
	let gc_pin = gc::read_branch_gc_pin_tx(tx, branch_id).await?;
	let mut row_families = serde_json::Map::new();
	for family in [
		RowFamily::Commits,
		RowFamily::Pidx,
		RowFamily::Deltas,
		RowFamily::Shards,
		RowFamily::PitrIntervals,
		RowFamily::Pins,
		RowFamily::StagedHotShards,
		RowFamily::ColdShards,
		RowFamily::ColdPublishMarkers,
		RowFamily::RetiredColdObjects,
	] {
		row_families.insert(
			family.as_str().to_string(),
			summary_for_prefix(tx, family.scan_prefix(branch_id), sample_limit).await?,
		);
	}

	Ok(json!({
		"branch_id": branch_id,
		"record": record,
		"head": head,
		"head_at_fork": head_at_fork,
		"pins": gc_pin.map(|pin| {
			json!({
				"branch_id": pin.branch_id,
				"refcount": pin.refcount,
				"root_pin": versionstamp_value(&pin.root_pin),
				"desc_pin": versionstamp_value(&pin.desc_pin),
				"restore_point_pin": versionstamp_value(&pin.restore_point_pin),
				"gc_pin": versionstamp_value(&pin.gc_pin),
			})
		}),
		"compaction": {
			"root": compaction_root,
			"dirty": dirty,
			"manifest_access": {
				"last_hot_pass_txid_key": encode_key(&keys::branch_manifest_last_hot_pass_txid_key(branch_id)),
				"last_access_ts_ms_key": encode_key(&keys::branch_manifest_last_access_ts_ms_key(branch_id)),
				"last_access_bucket_key": encode_key(&keys::branch_manifest_last_access_bucket_key(branch_id)),
			}
		},
		"row_families": row_families,
		"links": {
			"self": format!("/depot/inspect/branches/{}", branch_id.as_uuid()),
			"rows": format!("/depot/inspect/branches/{}/rows/{{family}}", branch_id.as_uuid()),
			"page_trace": format!("/depot/inspect/branches/{}/pages/{{pgno}}/trace", branch_id.as_uuid()),
		}
	}))
}

fn best_effort_decode(key: &[u8], value: Option<&[u8]>) -> Value {
	let mut decoded = serde_json::Map::new();
	decoded.insert("key".to_string(), decode_key_metadata(key));
	if let Some(value) = value {
		decoded.insert("value".to_string(), decode_value_by_key(key, value));
	}
	Value::Object(decoded)
}

fn decode_key_metadata(key: &[u8]) -> Value {
	if key.len() < 2 || key[0] != keys::SQLITE_SUBSPACE_PREFIX {
		return json!({ "family": "unknown" });
	}

	json!({
		"partition": key[1],
		"family": match key[1] {
			keys::DBPTR_PARTITION => "database-pointer",
			keys::BUCKET_PTR_PARTITION => "bucket-pointer",
			keys::BUCKET_CATALOG_PARTITION => "bucket-catalog",
			keys::BRANCHES_PARTITION => "database-branch",
			keys::BUCKET_BRANCH_PARTITION => "bucket-branch",
			keys::BR_PARTITION => "branch-row",
			keys::CTR_PARTITION => "counter",
			keys::RESTORE_POINT_PARTITION => "restore-point",
			keys::CMPC_PARTITION => "compactor-state",
			keys::DB_PIN_PARTITION => "database-pin",
			keys::BUCKET_FORK_PIN_PARTITION => "bucket-fork-pin",
			keys::BUCKET_CHILD_PARTITION => "bucket-child",
			keys::BUCKET_CATALOG_BY_DB_PARTITION => "bucket-catalog-by-db",
			keys::BUCKET_PROOF_EPOCH_PARTITION => "bucket-proof-epoch",
			keys::SQLITE_CMP_DIRTY_PARTITION => "sqlite-compaction-dirty",
			keys::DB_POLICY_BINDING_PARTITION => "database-policy-binding",
			keys::BUCKET_POLICY_PITR_SHARD_PARTITION => "bucket-policy-pitr-shard",
			_ => "unknown",
		}
	})
}

fn decode_value_by_key(key: &[u8], value: &[u8]) -> Value {
	let value_size = value.len();
	if key.len() >= 2 {
		match key[1] {
			keys::DBPTR_PARTITION => return value_or_error(decode_database_pointer(value)),
			keys::BUCKET_PTR_PARTITION => return value_or_error(decode_bucket_pointer(value)),
			keys::BRANCHES_PARTITION => {
				return value_or_error(decode_database_branch_record(value));
			}
			keys::BUCKET_BRANCH_PARTITION => {
				return value_or_error(decode_bucket_branch_record(value));
			}
			keys::SQLITE_CMP_DIRTY_PARTITION => {
				return value_or_error(decode_sqlite_cmp_dirty(value));
			}
			keys::DB_PIN_PARTITION => return value_or_error(decode_db_history_pin(value)),
			keys::DB_POLICY_BINDING_PARTITION => {
				return value_or_error(decode_database_policy_binding(value));
			}
			_ => {}
		}
	}

	json!({
		"value_size": value_size,
		"sha256": digest_value(value),
	})
}

fn decode_row_value(
	branch_id: DatabaseBranchId,
	family: RowFamily,
	key: &[u8],
	value: &[u8],
	include_bytes: bool,
) -> Value {
	let decoded = match family {
		RowFamily::Commits => {
			let txid = key
				.strip_prefix(keys::branch_commit_prefix(branch_id).as_slice())
				.and_then(|suffix| suffix.try_into().ok())
				.map(u64::from_be_bytes);
			json!({ "txid": txid, "row": result_to_value(decode_commit_row(value)) })
		}
		RowFamily::Pidx => {
			let pgno = key
				.strip_prefix(keys::branch_pidx_prefix(branch_id).as_slice())
				.and_then(|suffix| suffix.try_into().ok())
				.map(u32::from_be_bytes);
			let owner_txid = <[u8; 8]>::try_from(value).ok().map(u64::from_be_bytes);
			json!({ "pgno": pgno, "owner_txid": owner_txid })
		}
		RowFamily::Deltas => json!({
			"txid": keys::decode_branch_delta_chunk_txid(branch_id, key).ok(),
			"chunk_idx": keys::decode_branch_delta_chunk_txid(branch_id, key)
				.ok()
				.and_then(|txid| keys::decode_branch_delta_chunk_idx(branch_id, txid, key).ok()),
			"value_size": value.len(),
			"sha256": digest_value(value),
		}),
		RowFamily::Shards => json!({
			"value_size": value.len(),
			"sha256": digest_value(value),
		}),
		RowFamily::PitrIntervals => json!({
			"bucket_start_ms": keys::decode_branch_pitr_interval_bucket(branch_id, key).ok(),
			"coverage": result_to_value(decode_pitr_interval_coverage(value)),
		}),
		RowFamily::Pins => value_or_error(decode_db_history_pin(value)),
		RowFamily::StagedHotShards => json!({
			"value_size": value.len(),
			"sha256": digest_value(value),
		}),
		RowFamily::ColdShards | RowFamily::ColdPublishMarkers => json!({
			"value_size": value.len(),
			"sha256": digest_value(value),
		}),
		RowFamily::RetiredColdObjects => {
			value_or_error(crate::types::decode_retired_cold_object(value))
		}
	};

	json!({
		"key": encode_key(key),
		"decoded": decoded,
		"bytes": include_bytes.then(|| encode_key(value)),
	})
}

fn value_or_error<T: Serialize>(result: Result<T>) -> Value {
	result_to_value(result)
}

fn result_to_value<T: Serialize>(result: Result<T>) -> Value {
	match result {
		Ok(value) => serde_json::to_value(value).unwrap_or_else(
			|err| json!({ "decode_error": format!("failed to encode decoded value as JSON: {err}") }),
		),
		Err(err) => json!({ "decode_error": err.to_string() }),
	}
}

fn digest_value(value: &[u8]) -> Value {
	let digest = Sha256::digest(value);
	json!({
		"hex": hex_lower(&digest),
		"base64url": encode_key(&digest),
	})
}

#[derive(Debug, Serialize)]
struct BoundedPrefixCount {
	count: usize,
	truncated: bool,
}

async fn bounded_prefix_count(
	tx: &universaldb::Transaction,
	prefix: Vec<u8>,
	limit: usize,
) -> Result<BoundedPrefixCount> {
	let scan = scan_prefix_page(tx, prefix, None, limit).await?;
	Ok(BoundedPrefixCount {
		count: scan.rows.len(),
		truncated: scan.has_more,
	})
}

fn versionstamp_value(value: &[u8; 16]) -> Value {
	json!({
		"hex": hex_lower(value),
		"base64url": encode_key(value),
	})
}

fn hex_lower(bytes: &[u8]) -> String {
	const HEX: &[u8; 16] = b"0123456789abcdef";
	let mut out = String::with_capacity(bytes.len() * 2);
	for byte in bytes {
		out.push(HEX[(byte >> 4) as usize] as char);
		out.push(HEX[(byte & 0x0f) as usize] as char);
	}
	out
}
