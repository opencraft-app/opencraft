use anyhow::{Context, Result, bail, ensure};
use futures_util::TryStreamExt;
use gas::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use universaldb::{
	RangeOption,
	options::{MutationType, Priority, StreamingMode},
	utils::{IsolationLevel::Serializable, end_of_prefix_range},
};

use crate::{
	CMP_COLD_DELETE_MAX_OBJECTS,
	cold_tier::validate_cold_shard_object_key,
	conveyer::{
		keys,
		types::{
			BranchColdGcManifest, BranchColdObjectAccountingState, BranchColdObjectTombstone,
			BranchGcMarker, BranchState, DatabaseBranchId, RetiredColdObjectDeleteState,
			decode_branch_cold_gc_manifest, decode_branch_cold_object_tombstone,
			decode_branch_gc_marker, decode_cold_shard_ref, decode_cold_upload_intent,
			decode_database_branch_record, decode_retired_cold_object,
			encode_branch_cold_gc_manifest, encode_branch_cold_object_tombstone,
			encode_branch_gc_marker, encode_database_branch_record,
		},
		udb,
	},
	gc::{self, VERSIONSTAMP_INFINITY},
	workflows::compaction::{
		DATABASE_BRANCH_ID_TAG, DbColdCompacterInput, DbHotCompacterInput, DbManagerInput,
		DbReclaimerInput, DestroyDatabaseBranch, database_branch_tag_value,
	},
};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DbBranchGcInput {
	pub database_branch_id: DatabaseBranchId,
}

/// Per-branch deletion workflow. Its work is intrinsically partitioned by database branch: no
/// global pointer scan and no object-store LIST are needed, and each activity has a fixed batch.
#[workflow(DbBranchGcWorkflow)]
pub async fn depot_db_branch_gc(ctx: &mut WorkflowCtx, input: &DbBranchGcInput) -> Result<()> {
	let lifecycle_generation = loop {
		match ctx
			.activity(FenceBranchGcInput {
				database_branch_id: input.database_branch_id,
			})
			.await?
		{
			FenceBranchGcOutput::Gone => return Ok(()),
			FenceBranchGcOutput::Requeued => return Ok(()),
			FenceBranchGcOutput::Ready {
				lifecycle_generation,
			} => break lifecycle_generation,
		}
	};

	stop_compaction_workflows(ctx, input.database_branch_id, lifecycle_generation).await?;

	loop {
		let output = ctx
			.activity(StageBranchColdObjectsInput {
				database_branch_id: input.database_branch_id,
				lifecycle_generation,
			})
			.await?;
		if !output.has_more {
			break;
		}
	}

	loop {
		match ctx
			.activity(SweepBranchFdbInput {
				database_branch_id: input.database_branch_id,
				lifecycle_generation,
			})
			.await?
		{
			SweepBranchFdbOutput::Gone | SweepBranchFdbOutput::Deleted => return Ok(()),
			SweepBranchFdbOutput::More => {}
			SweepBranchFdbOutput::Referenced => {
				bail!("sqlite branch acquired a reference or pin after GC fencing")
			}
		}
	}
}

async fn stop_compaction_workflows(
	ctx: &mut WorkflowCtx,
	database_branch_id: DatabaseBranchId,
	lifecycle_generation: u64,
) -> Result<()> {
	let tag_value = database_branch_tag_value(database_branch_id);
	let manager_id = ctx
		.workflow(DbManagerInput::new(database_branch_id, None))
		.tag(DATABASE_BRANCH_ID_TAG, &tag_value)
		.unique()
		.dispatch()
		.await?;
	let hot_id = ctx
		.workflow(DbHotCompacterInput { database_branch_id })
		.tag(DATABASE_BRANCH_ID_TAG, &tag_value)
		.unique()
		.dispatch()
		.await?;
	let cold_id = ctx
		.workflow(DbColdCompacterInput { database_branch_id })
		.tag(DATABASE_BRANCH_ID_TAG, &tag_value)
		.unique()
		.dispatch()
		.await?;
	let reclaim_id = ctx
		.workflow(DbReclaimerInput { database_branch_id })
		.tag(DATABASE_BRANCH_ID_TAG, &tag_value)
		.unique()
		.dispatch()
		.await?;

	let signal_result = ctx
		.signal(DestroyDatabaseBranch {
			database_branch_id,
			lifecycle_generation,
			requested_at_ms: ctx.create_ts(),
			reason: "branch garbage collection".to_string(),
		})
		.to_workflow_id(manager_id)
		.send()
		.await;
	if let Err(error) = signal_result
		&& !error.chain().any(|cause| {
			matches!(
				cause.downcast_ref::<WorkflowError>(),
				Some(WorkflowError::WorkflowNotFound)
			)
		}) {
		return Err(error);
	}

	ctx.workflow::<DbManagerInput>(manager_id).output().await?;
	ctx.workflow::<DbHotCompacterInput>(hot_id).output().await?;
	ctx.workflow::<DbColdCompacterInput>(cold_id)
		.output()
		.await?;
	ctx.workflow::<DbReclaimerInput>(reclaim_id)
		.output()
		.await?;

	Ok(())
}

#[derive(Debug, Clone, Deserialize, Hash, Serialize)]
struct FenceBranchGcInput {
	database_branch_id: DatabaseBranchId,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
enum FenceBranchGcOutput {
	Gone,
	Requeued,
	Ready { lifecycle_generation: u64 },
}

#[activity(FenceBranchGc)]
async fn fence_branch_gc(
	ctx: &ActivityCtx,
	input: &FenceBranchGcInput,
) -> Result<FenceBranchGcOutput> {
	let database_branch_id = input.database_branch_id;
	let requested_at_ms = ctx.ts();
	let recovery_window_ms = ctx
		.config()
		.sqlite()
		.workflow_cold_storage()
		.map(|config| i64::try_from(config.recovery_window_ms()))
		.transpose()
		.context("sqlite cold recovery window exceeds i64")?
		.unwrap_or(crate::CMP_COLD_TOMBSTONE_RETENTION_MS);
	let udb = ctx.udb()?;
	let policy_grace_ms = i64::try_from(
		crate::cold_tier::read_cold_gc_policy(&udb)
			.await?
			.spec
			.grace_period_ms,
	)
	.context("ColdGcPolicy grace period exceeds signed timestamp range")?;
	let recovery_window_ms = recovery_window_ms.max(policy_grace_ms);
	ctx.udb()?
		.txn("depot_gc_fence_branch", move |tx| async move {
			tx.priority(Priority::Low)?;
			let Some(pin) = gc::read_branch_gc_pin_tx(&tx, database_branch_id).await? else {
				gc::clear_branch_gc_queue_tx(&tx, database_branch_id).await?;
				return Ok(FenceBranchGcOutput::Gone);
			};
			ensure!(
				pin.refcount >= 0,
				"sqlite branch GC refcount became negative"
			);
			if pin.refcount != 0
				|| pin.desc_pin != VERSIONSTAMP_INFINITY
				|| pin.restore_point_pin != VERSIONSTAMP_INFINITY
			{
				gc::defer_branch_gc_tx(&tx, database_branch_id, requested_at_ms).await?;
				return Ok(FenceBranchGcOutput::Requeued);
			}

			let record_key = keys::branches_list_key(database_branch_id);
			let record_value = tx
				.informal()
				.get(&record_key, Serializable)
				.await?
				.context("sqlite branch record disappeared during GC fencing")?;
			let mut record = decode_database_branch_record(&record_value)
				.context("decode sqlite branch record during GC fencing")?;
			let marker_key = keys::branch_gc_deleting_key(database_branch_id);
			if let Some(marker_value) = tx.informal().get(&marker_key, Serializable).await? {
				let marker = decode_branch_gc_marker(&marker_value)
					.context("decode existing sqlite branch GC marker")?;
				ensure!(
					marker.database_branch_id == database_branch_id
						&& marker.lifecycle_generation == record.lifecycle_generation,
					"sqlite branch GC marker does not match branch lifecycle"
				);
				let manifest = tx
					.informal()
					.get(
						&keys::branch_cold_gc_manifest_key(database_branch_id),
						Serializable,
					)
					.await?
					.context("sqlite branch cold GC manifest is missing behind its fence")?;
				let manifest = decode_branch_cold_gc_manifest(&manifest)?;
				ensure!(
					manifest.database_branch_id == database_branch_id
						&& manifest.lifecycle_generation == marker.lifecycle_generation
						&& manifest.tombstoned_at_ms == marker.requested_at_ms,
					"sqlite branch cold GC manifest does not match its fence"
				);
				gc::clear_branch_gc_queue_tx(&tx, database_branch_id).await?;
				return Ok(FenceBranchGcOutput::Ready {
					lifecycle_generation: marker.lifecycle_generation,
				});
			}

			record.state = BranchState::Frozen;
			record.lifecycle_generation = record
				.lifecycle_generation
				.checked_add(1)
				.context("sqlite branch lifecycle generation overflow")?;
			let lifecycle_generation = record.lifecycle_generation;
			gc::clear_branch_gc_queue_tx(&tx, database_branch_id).await?;
			tx.informal().set(
				&record_key,
				&encode_database_branch_record(record)
					.context("encode sqlite branch record during GC fencing")?,
			);
			let encoded_manifest = encode_branch_cold_gc_manifest(BranchColdGcManifest {
				database_branch_id,
				lifecycle_generation,
				tombstoned_at_ms: requested_at_ms,
				tombstone_versionstamp: udb::INCOMPLETE_VERSIONSTAMP,
				delete_after_ms: requested_at_ms.saturating_add(recovery_window_ms),
				staged_object_count: 0,
				staging_complete: false,
			})?;
			let versionstamped_manifest = udb::append_last_versionstamp_offset(
				encoded_manifest,
				&udb::INCOMPLETE_VERSIONSTAMP,
			)
			.context("prepare versionstamped branch cold GC manifest")?;
			tx.informal().atomic_op(
				&keys::branch_cold_gc_manifest_key(database_branch_id),
				&versionstamped_manifest,
				MutationType::SetVersionstampedValue,
			);
			tx.informal().set(
				&marker_key,
				&encode_branch_gc_marker(BranchGcMarker {
					database_branch_id,
					lifecycle_generation,
					requested_at_ms,
				})?,
			);
			tx.informal()
				.clear(&keys::sqlite_cmp_dirty_key(database_branch_id));
			crate::conveyer::commit::clear_dirty_reconcile_schedule_tx(&tx, database_branch_id)
				.await?;

			Ok(FenceBranchGcOutput::Ready {
				lifecycle_generation,
			})
		})
		.await
}

#[derive(Debug, Clone, Deserialize, Hash, Serialize)]
struct StageBranchColdObjectsInput {
	database_branch_id: DatabaseBranchId,
	lifecycle_generation: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct StageBranchColdObjectsOutput {
	staged_object_count: u32,
	has_more: bool,
}

#[derive(Debug, Clone)]
struct PlannedColdRow {
	row_key: Vec<u8>,
	object_key: String,
	object_generation_id: Id,
	content_hash: [u8; 32],
	size_bytes: u64,
	shard_id: u32,
	as_of_txid: u64,
	accounting_state: BranchColdObjectAccountingState,
	accounting_source: ColdRowAccountingSource,
	delete_authorization: Option<crate::types::ColdDeleteAuthorization>,
}

#[derive(Debug, Clone, Copy)]
enum ColdRowAccountingSource {
	Live,
	Retired,
	DeleteIssued,
	Orphan,
	Deleted,
}

/// Moves one bounded page of exact object identities out of the branch-local subspace. The source
/// rows and durable tombstones change atomically, so branch FDB can be swept without losing the
/// only scalable way to find cold objects later.
#[activity(StageBranchColdObjects)]
async fn stage_branch_cold_objects(
	ctx: &ActivityCtx,
	input: &StageBranchColdObjectsInput,
) -> Result<StageBranchColdObjectsOutput> {
	let database_branch_id = input.database_branch_id;
	let lifecycle_generation = input.lifecycle_generation;
	ctx.udb()?
		.txn("depot_gc_stage_cold_objects", move |tx| async move {
			tx.priority(Priority::Low)?;
			ensure!(
				matches!(
					validate_gc_fence(&tx, database_branch_id, lifecycle_generation).await?,
					GcFenceEligibility::Eligible
				),
				"sqlite branch acquired a reference or pin after GC fencing"
			);
			let manifest_key = keys::branch_cold_gc_manifest_key(database_branch_id);
			let encoded_manifest = tx
				.informal()
				.get(&manifest_key, Serializable)
				.await?
				.context("sqlite branch cold GC manifest is missing during staging")?;
			let mut manifest = decode_branch_cold_gc_manifest(&encoded_manifest)?;
			ensure!(
				manifest.database_branch_id == database_branch_id
					&& manifest.lifecycle_generation == lifecycle_generation,
				"sqlite branch cold GC manifest changed during staging"
			);
			if manifest.staging_complete {
				return Ok(StageBranchColdObjectsOutput {
					staged_object_count: 0,
					has_more: false,
				});
			}

			let plan = plan_cold_rows(&tx, database_branch_id).await?;
			let mut staged_object_count = 0_u32;
			for row in plan.rows {
				let object_key_hash = Sha256::digest(row.object_key.as_bytes()).into();
				let tombstone_key =
					keys::branch_cold_gc_object_key(database_branch_id, object_key_hash);
				let tombstone = BranchColdObjectTombstone {
					database_branch_id,
					lifecycle_generation,
					tombstoned_at_ms: manifest.tombstoned_at_ms,
					object_key: row.object_key,
					object_generation_id: row.object_generation_id,
					content_hash: row.content_hash,
					size_bytes: row.size_bytes,
					shard_id: row.shard_id,
					as_of_txid: row.as_of_txid,
					accounting_state: row.accounting_state,
					delete_authorization: row.delete_authorization,
				};
				if let Some(encoded_existing) =
					tx.informal().get(&tombstone_key, Serializable).await?
				{
					let existing = decode_branch_cold_object_tombstone(&encoded_existing)?;
					ensure!(
						existing == tombstone,
						"branch cold GC object hash collided with another identity"
					);
				} else {
					tx.informal().set(
						&tombstone_key,
						&encode_branch_cold_object_tombstone(tombstone)?,
					);
					let bytes = crate::cold_tier::accounting::checked_bytes(row.size_bytes)?;
					let delta = match row.accounting_source {
						ColdRowAccountingSource::Live => {
							crate::cold_tier::accounting::ColdStorageAccountingDelta {
								live_bytes: bytes.saturating_neg(),
								live_objects: -1,
								retired_bytes: bytes,
								retired_objects: 1,
								..Default::default()
							}
						}
						ColdRowAccountingSource::Orphan => {
							crate::cold_tier::accounting::ColdStorageAccountingDelta {
								orphan_bytes: bytes,
								orphan_objects: 1,
								..Default::default()
							}
						}
						ColdRowAccountingSource::Retired
						| ColdRowAccountingSource::DeleteIssued
						| ColdRowAccountingSource::Deleted => Default::default(),
					};
					crate::cold_tier::accounting::apply_delta_for_branch(
						&tx,
						database_branch_id,
						delta,
					);
					manifest.staged_object_count = manifest.staged_object_count.saturating_add(1);
					staged_object_count = staged_object_count.saturating_add(1);
				}
				tx.informal().clear(&row.row_key);
			}

			if !plan.has_more {
				let hot_job_prefix =
					keys::branch_hot_compaction_job_queue_prefix(database_branch_id);
				tx.informal().clear_range(
					&hot_job_prefix,
					&universaldb::utils::end_of_prefix_range(&hot_job_prefix),
				);
				let cold_job_prefix = keys::branch_cold_upload_job_queue_prefix(database_branch_id);
				tx.informal().clear_range(
					&cold_job_prefix,
					&universaldb::utils::end_of_prefix_range(&cold_job_prefix),
				);
				manifest.staging_complete = true;
				if manifest.staged_object_count == 0 {
					tx.informal().clear(&manifest_key);
				} else {
					gc::enqueue_branch_cold_gc_tx(
						&tx,
						database_branch_id,
						manifest.tombstoned_at_ms,
						manifest.tombstone_versionstamp,
						manifest.delete_after_ms,
					)
					.await?;
					tx.informal()
						.set(&manifest_key, &encode_branch_cold_gc_manifest(manifest)?);
				}
			} else {
				tx.informal()
					.set(&manifest_key, &encode_branch_cold_gc_manifest(manifest)?);
			}

			Ok(StageBranchColdObjectsOutput {
				staged_object_count,
				has_more: plan.has_more,
			})
		})
		.await
}

struct ColdRowPlan {
	rows: Vec<PlannedColdRow>,
	has_more: bool,
}

#[derive(Clone, Copy)]
enum ColdRowKind {
	Published,
	UploadIntent,
	Retired,
}

async fn plan_cold_rows(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
) -> Result<ColdRowPlan> {
	let mut rows = Vec::new();
	for (prefix, kind) in [
		(
			keys::branch_compaction_cold_shard_prefix(database_branch_id),
			ColdRowKind::Published,
		),
		(
			keys::branch_compaction_cold_upload_intent_prefix(database_branch_id),
			ColdRowKind::UploadIntent,
		),
		(
			keys::branch_compaction_retired_cold_object_prefix(database_branch_id),
			ColdRowKind::Retired,
		),
	] {
		let remaining = CMP_COLD_DELETE_MAX_OBJECTS
			.saturating_add(1)
			.saturating_sub(rows.len());
		if remaining == 0 {
			break;
		}
		let end = end_of_prefix_range(&prefix);
		let informal = tx.informal();
		let mut stream = informal.get_ranges_keyvalues(
			RangeOption {
				limit: Some(remaining),
				mode: StreamingMode::Exact,
				..(prefix.as_slice(), end.as_slice()).into()
			},
			Serializable,
		);
		while let Some(entry) = stream.try_next().await? {
			let encoded = entry.value();
			let (
				row_branch_id,
				object_key,
				object_generation_id,
				size_bytes,
				shard_id,
				as_of_txid,
				content_hash,
				accounting_state,
				accounting_source,
				delete_authorization,
			) = match kind {
				ColdRowKind::Published => {
					let reference = decode_cold_shard_ref(encoded)
						.context("decode published cold ref during branch GC")?;
					let is_live = crate::compaction::shared::cold_ref_has_atomic_publish_marker(
						tx,
						database_branch_id,
						&reference,
					)
					.await?;
					let delete_authorization = if is_live {
						None
					} else {
						let intent_key = keys::branch_compaction_cold_upload_intent_key(
							database_branch_id,
							reference.object_generation_id,
							reference.shard_id,
							reference.as_of_txid,
						);
						tx.informal()
							.get(&intent_key, Serializable)
							.await?
							.as_ref()
							.map(|bytes| decode_cold_upload_intent(bytes.as_ref()))
							.transpose()
							.context("decode staged cold upload intent during branch GC")?
							.and_then(|intent| intent.delete_authorization)
					};
					let source = if is_live {
						ColdRowAccountingSource::Live
					} else if delete_authorization.is_some() {
						ColdRowAccountingSource::DeleteIssued
					} else {
						ColdRowAccountingSource::Orphan
					};
					let state = if is_live {
						BranchColdObjectAccountingState::Retired
					} else if matches!(source, ColdRowAccountingSource::DeleteIssued) {
						BranchColdObjectAccountingState::OrphanDeleteIssued
					} else {
						BranchColdObjectAccountingState::Orphan
					};
					(
						reference.database_branch_id,
						reference.object_key,
						reference.object_generation_id,
						reference.size_bytes,
						reference.shard_id,
						reference.as_of_txid,
						reference.content_hash,
						state,
						source,
						delete_authorization,
					)
				}
				ColdRowKind::UploadIntent => {
					let intent = decode_cold_upload_intent(encoded)
						.context("decode cold upload intent during branch GC")?;
					let source = if intent.delete_authorization.is_some() {
						ColdRowAccountingSource::DeleteIssued
					} else {
						ColdRowAccountingSource::Orphan
					};
					let state = if intent.delete_authorization.is_some() {
						BranchColdObjectAccountingState::OrphanDeleteIssued
					} else {
						BranchColdObjectAccountingState::Orphan
					};
					let delete_authorization = intent.delete_authorization;
					let reference = intent.reference;
					(
						reference.database_branch_id,
						reference.object_key,
						reference.object_generation_id,
						reference.size_bytes,
						reference.shard_id,
						reference.as_of_txid,
						reference.content_hash,
						state,
						source,
						delete_authorization,
					)
				}
				ColdRowKind::Retired => {
					let retired = decode_retired_cold_object(encoded)
						.context("decode retired cold object during branch GC")?;
					let (state, source) = match retired.delete_state {
						RetiredColdObjectDeleteState::Retired => (
							BranchColdObjectAccountingState::Retired,
							ColdRowAccountingSource::Retired,
						),
						RetiredColdObjectDeleteState::DeleteIssued => (
							BranchColdObjectAccountingState::DeleteIssued,
							ColdRowAccountingSource::DeleteIssued,
						),
						RetiredColdObjectDeleteState::Deleted => (
							BranchColdObjectAccountingState::Deleted,
							ColdRowAccountingSource::Deleted,
						),
					};
					(
						retired.database_branch_id,
						retired.object_key,
						retired.object_generation_id,
						retired.size_bytes,
						retired.shard_id,
						retired.as_of_txid,
						retired.content_hash,
						state,
						source,
						retired.delete_authorization,
					)
				}
			};
			ensure!(
				row_branch_id == database_branch_id,
				"cold object row belongs to a different database branch during branch GC"
			);
			validate_cold_shard_object_key(
				&object_key,
				database_branch_id,
				object_generation_id,
				shard_id,
				as_of_txid,
				content_hash,
			)
			.context("refuse noncanonical cold object key during branch GC")?;
			rows.push(PlannedColdRow {
				row_key: entry.key().to_vec(),
				object_key,
				object_generation_id,
				content_hash,
				size_bytes,
				shard_id,
				as_of_txid,
				accounting_state,
				accounting_source,
				delete_authorization,
			});
		}
	}

	let has_more = rows.len() > CMP_COLD_DELETE_MAX_OBJECTS;
	rows.truncate(CMP_COLD_DELETE_MAX_OBJECTS);
	Ok(ColdRowPlan { rows, has_more })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GcFenceEligibility {
	Eligible,
	Referenced,
}

async fn validate_gc_fence(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
	lifecycle_generation: u64,
) -> Result<GcFenceEligibility> {
	let marker = tx
		.informal()
		.get(
			&keys::branch_gc_deleting_key(database_branch_id),
			Serializable,
		)
		.await?
		.context("sqlite branch GC fence is missing")?;
	let marker = decode_branch_gc_marker(&marker).context("decode sqlite branch GC fence")?;
	ensure!(
		marker.database_branch_id == database_branch_id
			&& marker.lifecycle_generation == lifecycle_generation,
		"sqlite branch GC fence changed"
	);
	let pin = gc::read_branch_gc_pin_tx(tx, database_branch_id)
		.await?
		.context("sqlite branch disappeared before branch GC completed")?;
	if pin.refcount == 0
		&& pin.desc_pin == VERSIONSTAMP_INFINITY
		&& pin.restore_point_pin == VERSIONSTAMP_INFINITY
	{
		Ok(GcFenceEligibility::Eligible)
	} else {
		Ok(GcFenceEligibility::Referenced)
	}
}

#[derive(Debug, Clone, Deserialize, Hash, Serialize)]
struct SweepBranchFdbInput {
	database_branch_id: DatabaseBranchId,
	lifecycle_generation: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
enum SweepBranchFdbOutput {
	Gone,
	Deleted,
	More,
	Referenced,
}

#[activity(SweepBranchFdb)]
async fn sweep_branch_fdb(
	ctx: &ActivityCtx,
	input: &SweepBranchFdbInput,
) -> Result<SweepBranchFdbOutput> {
	let database_branch_id = input.database_branch_id;
	let lifecycle_generation = input.lifecycle_generation;
	let eligibility = ctx
		.udb()?
		.txn("depot_gc_validate_branch_sweep", move |tx| async move {
			validate_gc_fence(&tx, database_branch_id, lifecycle_generation).await
		})
		.await?;
	if matches!(eligibility, GcFenceEligibility::Referenced) {
		return Ok(SweepBranchFdbOutput::Referenced);
	}

	let udb = ctx.udb()?;
	let Some(outcome) = gc::sweep_unreferenced_branch(&udb, database_branch_id).await? else {
		return Ok(SweepBranchFdbOutput::Gone);
	};
	if outcome.branch_deleted {
		Ok(SweepBranchFdbOutput::Deleted)
	} else if outcome.keys_deleted > 0 {
		Ok(SweepBranchFdbOutput::More)
	} else {
		Ok(SweepBranchFdbOutput::Referenced)
	}
}
