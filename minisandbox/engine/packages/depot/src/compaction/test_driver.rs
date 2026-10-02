use std::time::Duration;

use gas::db::debug::{DatabaseDebug, EventData, SignalState, WorkflowState};

use super::*;

// Real FoundationDB runs deliberately amplified PITR jobs through multiple bounded transactions.
// Five seconds made the test harness fail while the workflow was still making healthy progress.
const DEFAULT_WAIT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HotInputPlanForTest {
	pub selected_max_txid: Option<u64>,
	pub pidx_entries: Vec<(u32, u64)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PitrReclaimPlanForTest {
	pub retained_txids: Vec<u64>,
	pub expired_bucket_starts_ms: Vec<i64>,
	pub proof_complete: bool,
}

pub async fn read_pitr_reclaim_plan_for_test(
	db: &universaldb::Database,
	database_branch_id: DatabaseBranchId,
	now_ms: i64,
) -> Result<PitrReclaimPlanForTest> {
	db.txn("test_read_pitr_reclaim_plan", move |tx| async move {
		let (retained, expired, _, proof_complete) =
			super::shared::read_pitr_interval_reclaim_rows(
				&tx,
				database_branch_id,
				now_ms,
				Serializable,
			)
			.await?;
		Ok(PitrReclaimPlanForTest {
			retained_txids: retained
				.into_iter()
				.map(|selection| selection.coverage.txid)
				.collect(),
			expired_bucket_starts_ms: expired
				.into_iter()
				.map(|(bucket_start_ms, _, _, _)| bucket_start_ms)
				.collect(),
			proof_complete,
		})
	})
	.await
}

pub async fn read_live_pitr_txids_in_ranges_for_test(
	db: &universaldb::Database,
	database_branch_id: DatabaseBranchId,
	ranges: Vec<(u64, u64)>,
	now_ms: i64,
) -> Result<Option<Vec<u64>>> {
	db.txn("test_read_live_pitr_txids_in_ranges", move |tx| {
		let ranges = ranges.clone();
		async move {
			Ok(super::shared::read_live_pitr_txids_in_ranges(
				&tx,
				database_branch_id,
				&ranges,
				now_ms,
				Serializable,
			)
			.await?
			.map(|txids| txids.into_iter().collect()))
		}
	})
	.await
}

pub async fn read_hot_input_plan_for_test(
	db: &universaldb::Database,
	database_branch_id: DatabaseBranchId,
	now_ms: i64,
) -> Result<HotInputPlanForTest> {
	db.txn("test_read_hot_input_plan", move |tx| async move {
		let snapshot =
			super::shared::read_manager_fdb_snapshot(&tx, database_branch_id, false, now_ms)
				.await?;
		let mut pidx_entries = snapshot
			.hot_inputs
			.pidx_entries
			.iter()
			.map(|(key, value)| {
				Ok((
					super::shared::decode_branch_pidx_pgno(database_branch_id, key)?,
					super::shared::decode_pidx_txid(value)?,
				))
			})
			.collect::<Result<Vec<_>>>()?;
		pidx_entries.sort_unstable();

		Ok(HotInputPlanForTest {
			selected_max_txid: snapshot.hot_inputs.selected_max_txid,
			pidx_entries,
		})
	})
	.await
}

pub async fn read_effective_pitr_policy_for_test(
	db: &universaldb::Database,
	database_branch_id: DatabaseBranchId,
) -> Result<PitrPolicy> {
	db.txn("test_read_effective_pitr_policy", move |tx| async move {
		let branch_record = tx
			.informal()
			.get(&keys::branches_list_key(database_branch_id), Serializable)
			.await?
			.as_deref()
			.map(|bytes| decode_database_branch_record(bytes.as_slice()))
			.transpose()
			.context("decode sqlite database branch record in policy test hook")?;

		super::shared::read_effective_pitr_policy_for_branch(&tx, branch_record.as_ref()).await
	})
	.await
}

pub async fn latest_commit_at_or_before_versionstamp_for_test(
	db: &universaldb::Database,
	database_branch_id: DatabaseBranchId,
	versionstamp_cap: [u8; 16],
) -> Result<Option<(u64, [u8; 16], CommitRow)>> {
	db.txn(
		"test_latest_commit_at_or_before_versionstamp",
		move |tx| async move {
			super::shared::latest_commit_at_or_before_versionstamp(
				&tx,
				database_branch_id,
				versionstamp_cap,
			)
			.await
		},
	)
	.await
}

pub async fn load_latest_branch_shard_blob_for_test(
	db: &universaldb::Database,
	database_branch_id: DatabaseBranchId,
	shard_id: u32,
	as_of_txid: u64,
) -> Result<Option<Vec<u8>>> {
	db.txn("test_load_latest_branch_shard_blob", move |tx| async move {
		super::shared::load_latest_branch_shard_blob(&tx, database_branch_id, shard_id, as_of_txid)
			.await
	})
	.await
}

/// Advances at most one bounded page of the durable bucket-fork proof. Returns `true` while
/// reclamation must remain fail-closed and `false` once the complete proof is installed.
pub async fn advance_bucket_fork_proof_for_test(
	db: &universaldb::Database,
	database_branch_id: DatabaseBranchId,
) -> Result<bool> {
	db.txn("test_advance_bucket_fork_proof", move |tx| async move {
		super::shared::resolve_bucket_fork_pins(&tx, database_branch_id).await
	})
	.await
}

pub struct DepotCompactionTestDriver<'a> {
	test_ctx: &'a TestCtx,
	wait_timeout: Duration,
}

impl<'a> DepotCompactionTestDriver<'a> {
	pub fn new(test_ctx: &'a TestCtx) -> Self {
		DepotCompactionTestDriver {
			test_ctx,
			wait_timeout: DEFAULT_WAIT_TIMEOUT,
		}
	}

	pub fn with_wait_timeout(mut self, wait_timeout: Duration) -> Self {
		self.wait_timeout = wait_timeout;
		self
	}

	pub async fn start_manager(
		&self,
		database_branch_id: DatabaseBranchId,
		actor_id: Option<String>,
		disable_planning_timers: bool,
	) -> Result<Id> {
		let input = if disable_planning_timers {
			DbManagerInput::with_planning_timers_disabled(database_branch_id, actor_id)
		} else {
			DbManagerInput::new(database_branch_id, actor_id)
		};

		self.test_ctx
			.workflow(input)
			.tag(
				DATABASE_BRANCH_ID_TAG,
				&database_branch_tag_value(database_branch_id),
			)
			.unique()
			.dispatch()
			.await
	}

	pub async fn force_compaction(
		&self,
		manager_workflow_id: Id,
		database_branch_id: DatabaseBranchId,
		work: ForceCompactionWork,
	) -> Result<ForceCompactionResult> {
		self.force_compaction_with_request_id(
			manager_workflow_id,
			database_branch_id,
			Id::new_v1(self.test_ctx.config().dc_label()),
			work,
		)
		.await
	}

	pub async fn destroy_manager_and_wait(
		&self,
		manager_workflow_id: Id,
		database_branch_id: DatabaseBranchId,
		lifecycle_generation: u64,
	) -> Result<()> {
		let signal_id = self
			.test_ctx
			.signal(DestroyDatabaseBranch {
				database_branch_id,
				lifecycle_generation,
				requested_at_ms: rivet_util::timestamp::now(),
				reason: "test cleanup".to_string(),
			})
			.to_workflow_id(manager_workflow_id)
			.send()
			.await?
			.context("destroy signal should target manager workflow")?;
		self.wait_for_signal_ack(signal_id).await?;

		let tag = (
			DATABASE_BRANCH_ID_TAG.to_string(),
			database_branch_tag_value(database_branch_id),
		);
		self.wait_until("manager and companion workflow cleanup", || async {
			let workflows = DatabaseDebug::find_workflows(
				self.test_ctx.debug_db(),
				std::slice::from_ref(&tag),
				None,
				None,
			)
			.await?;
			if workflows.len() >= 4
				&& workflows
					.iter()
					.all(|workflow| workflow.state == WorkflowState::Complete)
			{
				return Ok(Some(()));
			}
			Ok(None)
		})
		.await
	}

	pub async fn force_compaction_with_request_id(
		&self,
		manager_workflow_id: Id,
		database_branch_id: DatabaseBranchId,
		request_id: Id,
		work: ForceCompactionWork,
	) -> Result<ForceCompactionResult> {
		let signal_id = self
			.test_ctx
			.signal(ForceCompaction {
				database_branch_id,
				request_id,
				requested_work: work,
			})
			.to_workflow_id(manager_workflow_id)
			.send()
			.await?
			.context("force compaction signal should target manager workflow")?;

		self.wait_for_signal_ack(signal_id).await?;
		self.wait_for_force_result(manager_workflow_id, request_id)
			.await
	}

	async fn wait_for_signal_ack(&self, signal_id: Id) -> Result<()> {
		self.wait_until("force compaction signal ack", || async {
			let signal = DatabaseDebug::get_signals(self.test_ctx.debug_db(), vec![signal_id])
				.await?
				.into_iter()
				.next();

			if signal.is_some_and(|signal| signal.state == SignalState::Acked) {
				return Ok(Some(()));
			}

			Ok(None)
		})
		.await
	}

	async fn wait_for_force_result(
		&self,
		manager_workflow_id: Id,
		request_id: Id,
	) -> Result<ForceCompactionResult> {
		self.wait_until("force compaction result", || async {
			let history = DatabaseDebug::get_workflow_history(
				self.test_ctx.debug_db(),
				manager_workflow_id,
				true,
			)
			.await?
			.context("manager workflow history not found")?;

			for event in history.events.into_iter().rev() {
				if let EventData::Loop(loop_event) = event.data {
					let state = serde_json::from_value::<DbManagerState>(loop_event.state)?;
					if let Some(result) = state
						.force_compactions
						.recent_results
						.into_iter()
						.find(|result| result.request_id == request_id)
					{
						return Ok(Some(result));
					}
				}
			}

			Ok(None)
		})
		.await
	}

	async fn wait_until<T, F, Fut>(&self, description: &'static str, mut check: F) -> Result<T>
	where
		F: FnMut() -> Fut,
		Fut: std::future::Future<Output = Result<Option<T>>>,
	{
		let started_at = tokio::time::Instant::now();
		loop {
			if let Some(value) = check().await? {
				return Ok(value);
			}

			if started_at.elapsed() > self.wait_timeout {
				bail!("timed out waiting for {description}");
			}

			// Gasoline debug rows do not expose a waiter for this test-driver observation.
			tokio::time::sleep(Duration::from_millis(25)).await;
		}
	}
}
