use std::time::Duration;

use anyhow::Result;
use futures_util::{FutureExt, TryStreamExt, future::try_join_all};
use gas::prelude::*;
use universaldb::{
	RangeOption,
	options::StreamingMode,
	utils::IsolationLevel::{Serializable, Snapshot},
};

use crate::{
	conveyer::{
		commit::dirty_reconcile_retry_delay_ms,
		keys,
		types::{DatabaseBranchId, SqliteCmpDirty, decode_sqlite_cmp_dirty},
	},
	workflows::compaction::{
		DATABASE_BRANCH_ID_TAG, DbManagerInput, DeltasAvailable, database_branch_tag_value,
	},
};

const RECONCILE_INTERVAL: Duration = Duration::from_secs(30);
const RECONCILE_PAGE_SIZE: usize = 128;
const BACKFILL_SPREAD_MS: i64 = 10 * 60 * 1000;
const BACKFILL_RESCAN_INTERVAL_MS: i64 = 60 * 60 * 1000;

#[derive(Debug, Deserialize, Serialize)]
pub struct DbCompactionReconcilerInput {}

/// Reconciles UniversalDB's durable, time-ordered dirty retry queue with Gasoline manager
/// workflows.
///
/// The normal commit path sends a best-effort low-latency wake after the FDB transaction commits.
/// This workflow is the correctness fallback for a failed dispatch, a failed durable signal write,
/// or a process crash in between those operations. Each dirty branch has one exact locator and a
/// bounded exponential retry deadline, so dormant databases do not create O(database_count)
/// polling traffic. It never participates in the SQLite commit ACK.
#[workflow(DbCompactionReconcilerWorkflow)]
pub async fn depot_db_compaction_reconciler(
	ctx: &mut WorkflowCtx,
	_input: &DbCompactionReconcilerInput,
) -> Result<()> {
	ctx.lupe()
		.commit_interval(1)
		.with_state(DbCompactionReconcilerState::default())
		.run(|ctx, state| {
			async move {
				let page = ctx
					.activity(ScanDirtyBranchesInput {
						cursor: state.cursor.clone(),
					})
					.await?;

				for branch in page.branches {
					let tag_value = database_branch_tag_value(branch.database_branch_id);
					let workflow_id = ctx
						.workflow(DbManagerInput::new(branch.database_branch_id, None))
						.tag(DATABASE_BRANCH_ID_TAG, &tag_value)
						.unique()
						.dispatch()
						.await?;
					ctx.signal(DeltasAvailable {
						database_branch_id: branch.database_branch_id,
						observed_head_txid: branch.dirty.observed_head_txid,
						dirty_updated_at_ms: branch.dirty.updated_at_ms,
					})
					.to_workflow_id(workflow_id)
					.send()
					.await?;
				}

				state.cursor = page.next_cursor;
				if state.cursor.is_none() {
					ctx.sleep(RECONCILE_INTERVAL).await?;
				}

				Ok(Loop::<()>::Continue)
			}
			.boxed()
		})
		.await
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
struct DbCompactionReconcilerState {
	cursor: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Deserialize, Hash, Serialize)]
struct ScanDirtyBranchesInput {
	cursor: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ScanDirtyBranchesOutput {
	branches: Vec<DirtyBranch>,
	next_cursor: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct DirtyBranch {
	database_branch_id: DatabaseBranchId,
	dirty: SqliteCmpDirty,
}

#[activity(ScanDirtyBranches)]
async fn scan_dirty_branches(
	ctx: &ActivityCtx,
	input: &ScanDirtyBranchesInput,
) -> Result<ScanDirtyBranchesOutput> {
	let udb = ctx.udb()?;
	scan_dirty_branches_page(&udb, input.cursor.clone()).await
}

async fn scan_dirty_branches_page(
	db: &universaldb::Database,
	_cursor: Option<Vec<u8>>,
) -> Result<ScanDirtyBranchesOutput> {
	db.txn(
		"depot_claim_due_compaction_branches",
		move |tx| async move {
			let now_ms = rivet_util::timestamp::now();
			let due_prefix = keys::sqlite_cmp_dirty_due_prefix();
			let mut due_end = due_prefix.clone();
			due_end.extend_from_slice(&now_ms.to_be_bytes());
			due_end.push(u8::MAX);
			let informal = tx.informal();
			let mut due_stream = informal.get_ranges_keyvalues(
				RangeOption {
					begin: universaldb::KeySelector::first_greater_or_equal(due_prefix),
					end: universaldb::KeySelector::first_greater_or_equal(due_end),
					limit: Some(RECONCILE_PAGE_SIZE.saturating_add(1)),
					mode: StreamingMode::Exact,
					..RangeOption::default()
				},
				Snapshot,
			);
			let mut due_keys = Vec::new();
			while let Some(entry) = due_stream.try_next().await? {
				due_keys.push(entry.key().to_vec());
			}

			let due_has_more = due_keys.len() > RECONCILE_PAGE_SIZE;
			if due_has_more {
				due_keys.pop();
			}
			let due_rows = try_join_all(due_keys.into_iter().map(|due_key| {
				let informal = &informal;
				async move {
					let (_, branch_id, dirty_updated_at_ms, attempt) =
						keys::decode_sqlite_cmp_dirty_due_key(&due_key)?;
					let locator_key = keys::sqlite_cmp_dirty_due_locator_key(branch_id);
					let (locator, dirty_value) = futures_util::try_join!(
						informal.get(&locator_key, Serializable),
						informal.get(&keys::sqlite_cmp_dirty_key(branch_id), Serializable),
					)?;
					let dirty = dirty_value
						.as_ref()
						.map(|value| decode_sqlite_cmp_dirty(value.as_slice()))
						.transpose()?;
					Ok::<_, anyhow::Error>((
						due_key,
						branch_id,
						dirty_updated_at_ms,
						attempt,
						locator_key,
						locator,
						dirty,
					))
				}
			}))
			.await?;
			let mut branches = Vec::with_capacity(due_rows.len());
			for (due_key, branch_id, _dirty_updated_at_ms, attempt, locator_key, locator, dirty) in
				due_rows
			{
				let locator_matches = locator
					.as_ref()
					.is_some_and(|value| value.as_slice() == due_key.as_slice());
				// The locator, rather than the dirty timestamp embedded in its immutable due key,
				// fences ownership. Foreground commits deliberately leave one deadline in place while
				// updating the marker. At expiry the reconciler wakes the manager with the newest head
				// and installs the next exact retry. A cleared marker or a replaced locator still makes
				// this row stale, so an old dirty epoch cannot be resurrected.
				let is_current = locator_matches && dirty.is_some();
				if is_current {
					let dirty = dirty.expect("current due row has a dirty marker");
					let next_attempt = attempt.saturating_add(1);
					let next_due_key = keys::sqlite_cmp_dirty_due_key(
						now_ms.saturating_add(dirty_reconcile_retry_delay_ms(
							branch_id,
							next_attempt,
						)),
						branch_id,
						dirty.updated_at_ms,
						next_attempt,
					);
					informal.clear(&due_key);
					informal.set(&next_due_key, &[]);
					informal.set(&locator_key, &next_due_key);
					branches.push(DirtyBranch {
						database_branch_id: branch_id,
						dirty,
					});
				} else {
					informal.clear(&due_key);
					if locator_matches {
						informal.clear(&locator_key);
					}
				}
			}

			let backfill_has_more = if due_has_more {
				false
			} else {
				backfill_legacy_dirty_page(&tx, now_ms).await?
			};

			Ok(ScanDirtyBranchesOutput {
				branches,
				next_cursor: (due_has_more || backfill_has_more).then(Vec::new),
			})
		},
	)
	.await
}

async fn backfill_legacy_dirty_page(tx: &universaldb::Transaction, now_ms: i64) -> Result<bool> {
	let informal = tx.informal();
	let complete_key = keys::sqlite_cmp_dirty_due_backfill_complete_key();
	if let Some(completed_at) = informal.get(&complete_key, Serializable).await? {
		anyhow::ensure!(
			completed_at.len() == 8,
			"sqlite compaction dirty due backfill timestamp has invalid length"
		);
		let completed_at_ms = i64::from_be_bytes(completed_at.as_slice().try_into()?);
		if now_ms.saturating_sub(completed_at_ms) < BACKFILL_RESCAN_INTERVAL_MS {
			return Ok(false);
		}
		informal.clear(&complete_key);
	}

	let cursor_key = keys::sqlite_cmp_dirty_due_backfill_cursor_key();
	let cursor = informal.get(&cursor_key, Serializable).await?;
	let prefix = keys::sqlite_cmp_dirty_prefix();
	let (range_start, range_end) = universaldb::utils::range_for_prefix(&prefix);
	let begin = cursor
		.as_deref()
		.map(universaldb::KeySelector::first_greater_than)
		.unwrap_or_else(|| universaldb::KeySelector::first_greater_or_equal(range_start));
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			begin,
			end: universaldb::KeySelector::first_greater_or_equal(range_end),
			limit: Some(RECONCILE_PAGE_SIZE.saturating_add(1)),
			mode: StreamingMode::Exact,
			..RangeOption::default()
		},
		Snapshot,
	);
	let mut rows = Vec::new();
	while let Some(entry) = stream.try_next().await? {
		rows.push((entry.key().to_vec(), entry.value().to_vec()));
	}
	let has_more = rows.len() > RECONCILE_PAGE_SIZE;
	if has_more {
		rows.pop();
	}
	let backfill_rows = try_join_all(rows.iter().map(|(dirty_key, dirty_value)| {
		let informal = &informal;
		async move {
			let branch_id = keys::decode_sqlite_cmp_dirty_branch_id(dirty_key)?;
			let dirty = decode_sqlite_cmp_dirty(dirty_value)?;
			let locator_key = keys::sqlite_cmp_dirty_due_locator_key(branch_id);
			let (locator, current_dirty) = futures_util::try_join!(
				informal.get(&locator_key, Serializable),
				informal.get(&keys::sqlite_cmp_dirty_key(branch_id), Serializable),
			)?;
			Ok::<_, anyhow::Error>((
				branch_id,
				dirty,
				dirty_value.clone(),
				locator_key,
				locator,
				current_dirty,
			))
		}
	}))
	.await?;
	for (branch_id, dirty, scanned_dirty, locator_key, locator, current_dirty) in backfill_rows {
		if locator.is_none()
			&& current_dirty
				.as_ref()
				.is_some_and(|value| value.as_slice() == scanned_dirty.as_slice())
		{
			let branch_uuid = branch_id.as_uuid();
			let hash_bytes = branch_uuid.as_bytes();
			let jitter_seed = u32::from_be_bytes(hash_bytes[..4].try_into()?);
			let jitter_ms = i64::from(jitter_seed) % BACKFILL_SPREAD_MS;
			let due_key = keys::sqlite_cmp_dirty_due_key(
				now_ms.saturating_add(RECONCILE_INTERVAL.as_millis() as i64 + jitter_ms),
				branch_id,
				dirty.updated_at_ms,
				0,
			);
			informal.set(&due_key, &[]);
			informal.set(&locator_key, &due_key);
		}
	}
	if has_more {
		let last_key = &rows.last().expect("full backfill page is non-empty").0;
		informal.set(&cursor_key, last_key);
	} else {
		informal.clear(&cursor_key);
		informal.set(&complete_key, &now_ms.to_be_bytes());
	}
	Ok(has_more)
}

#[cfg(feature = "test-faults")]
pub async fn scan_dirty_branch_ids_for_test(
	db: &universaldb::Database,
) -> Result<Vec<DatabaseBranchId>> {
	let prefix = keys::sqlite_cmp_dirty_prefix();
	db.txn("test_scan_dirty_compaction_branches", move |tx| {
		let prefix = prefix.clone();
		async move {
			let (range_start, range_end) = universaldb::utils::range_for_prefix(&prefix);
			let informal = tx.informal();
			let mut stream = informal.get_ranges_keyvalues(
				RangeOption {
					begin: universaldb::KeySelector::first_greater_or_equal(range_start),
					end: universaldb::KeySelector::first_greater_or_equal(range_end),
					mode: StreamingMode::WantAll,
					..RangeOption::default()
				},
				Snapshot,
			);
			let mut branches = Vec::new();
			while let Some(entry) = stream.try_next().await? {
				branches.push(keys::decode_sqlite_cmp_dirty_branch_id(entry.key())?);
			}
			Ok(branches)
		}
	})
	.await
}

#[cfg(feature = "test-faults")]
pub async fn claim_due_branch_ids_for_test(
	db: &universaldb::Database,
) -> Result<Vec<DatabaseBranchId>> {
	Ok(scan_dirty_branches_page(db, None)
		.await?
		.branches
		.into_iter()
		.map(|branch| branch.database_branch_id)
		.collect())
}
