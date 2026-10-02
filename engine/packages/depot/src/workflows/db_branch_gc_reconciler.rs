use std::time::Duration;

use anyhow::{Context, Result, ensure};
use futures_util::{FutureExt, TryStreamExt};
use gas::prelude::*;
use universaldb::{RangeOption, options::StreamingMode, utils::IsolationLevel::Snapshot};

use crate::{
	conveyer::{
		keys,
		types::{BranchGcQueueEntry, decode_branch_gc_queue_entry},
	},
	gc,
	workflows::{
		compaction::{DATABASE_BRANCH_ID_TAG, database_branch_tag_value},
		db_branch_gc::DbBranchGcInput,
	},
};

pub const BRANCH_GC_QUEUE_SHARD_TAG: &str = "branch_gc_queue_shard";
const RECONCILE_MAX_SLEEP: Duration = Duration::from_secs(30);
const RECONCILE_PAGE_SIZE: usize = 64;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DbBranchGcReconcilerInput {
	pub shard: u8,
}

/// One of a fixed number of GC schedulers. Each scheduler scans only its durable queue shard and
/// hands due branches to short-lived, uniquely tagged branch workflows. Pinned branches move to an
/// exponential due time instead of retaining one sleeping Gasoline workflow each.
#[workflow(DbBranchGcReconcilerWorkflow)]
pub async fn depot_db_branch_gc_reconciler(
	ctx: &mut WorkflowCtx,
	input: &DbBranchGcReconcilerInput,
) -> Result<()> {
	ensure!(
		input.shard < keys::DB_BRANCH_GC_QUEUE_SHARD_COUNT,
		"invalid branch GC queue shard"
	);
	let shard = input.shard;
	ctx.lupe()
		.commit_interval(1)
		.run(|ctx, _state: &mut ()| {
			async move {
				let page = ctx.activity(ScanDueBranchGcInput { shard }).await?;
				for entry in page.entries {
					let tag_value = database_branch_tag_value(entry.database_branch_id);
					ctx.workflow(DbBranchGcInput {
						database_branch_id: entry.database_branch_id,
					})
					.tag(DATABASE_BRANCH_ID_TAG, &tag_value)
					.unique()
					.dispatch()
					.await?;
					ctx.activity(LeaseBranchGcDispatchInput { expected: entry })
						.await?;
				}

				if !page.has_more_due {
					let max_wake_at_ms = page.observed_at_ms.saturating_add(
						i64::try_from(RECONCILE_MAX_SLEEP.as_millis())
							.expect("branch GC reconcile sleep fits in i64"),
					);
					ctx.sleep_until(
						page.next_due_at_ms
							.map_or(max_wake_at_ms, |due| due.min(max_wake_at_ms)),
					)
					.await?;
				}

				Ok(Loop::<()>::Continue)
			}
			.boxed()
		})
		.await
}

#[derive(Debug, Clone, Deserialize, Hash, Serialize)]
struct ScanDueBranchGcInput {
	shard: u8,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ScanDueBranchGcOutput {
	observed_at_ms: i64,
	entries: Vec<BranchGcQueueEntry>,
	has_more_due: bool,
	next_due_at_ms: Option<i64>,
}

#[activity(ScanDueBranchGc)]
async fn scan_due_branch_gc(
	ctx: &ActivityCtx,
	input: &ScanDueBranchGcInput,
) -> Result<ScanDueBranchGcOutput> {
	let observed_at_ms = ctx.ts();
	let shard = input.shard;
	ensure!(
		shard < keys::DB_BRANCH_GC_QUEUE_SHARD_COUNT,
		"invalid branch GC queue shard"
	);
	ctx.udb()?
		.txn("depot_scan_due_branch_gc", move |tx| async move {
			let prefix = keys::branch_gc_queue_shard_prefix(shard);
			let end = universaldb::utils::end_of_prefix_range(&prefix);
			let informal = tx.informal();
			let mut stream = informal.get_ranges_keyvalues(
				RangeOption {
					limit: Some(RECONCILE_PAGE_SIZE.saturating_add(1)),
					mode: StreamingMode::Exact,
					..(prefix.as_slice(), end.as_slice()).into()
				},
				Snapshot,
			);
			let mut entries = Vec::new();
			let mut has_more_due = false;
			let mut next_due_at_ms = None;
			while let Some(row) = stream.try_next().await? {
				let (row_shard, due_at_ms, database_branch_id) =
					keys::decode_branch_gc_queue_key(row.key())?;
				ensure!(row_shard == shard, "branch GC row escaped its queue shard");
				let entry = decode_branch_gc_queue_entry(row.value())
					.context("decode due sqlite branch GC entry")?;
				ensure!(
					entry.database_branch_id == database_branch_id && entry.due_at_ms == due_at_ms,
					"branch GC due row key and value disagree"
				);
				if due_at_ms > observed_at_ms {
					next_due_at_ms = Some(due_at_ms);
					break;
				}
				if entries.len() == RECONCILE_PAGE_SIZE {
					has_more_due = true;
					break;
				}
				entries.push(entry);
			}

			Ok(ScanDueBranchGcOutput {
				observed_at_ms,
				entries,
				has_more_due,
				next_due_at_ms,
			})
		})
		.await
}

#[derive(Debug, Clone, Deserialize, Hash, Serialize)]
struct LeaseBranchGcDispatchInput {
	expected: BranchGcQueueEntry,
}

#[activity(LeaseBranchGcDispatch)]
async fn lease_branch_gc_dispatch(
	ctx: &ActivityCtx,
	input: &LeaseBranchGcDispatchInput,
) -> Result<bool> {
	let expected = input.expected.clone();
	let now_ms = ctx.ts();
	ctx.udb()?
		.txn("depot_lease_branch_gc_dispatch", move |tx| {
			let expected = expected.clone();
			async move { gc::lease_branch_gc_queue_entry_tx(&tx, &expected, now_ms).await }
		})
		.await
}
