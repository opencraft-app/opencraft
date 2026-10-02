use anyhow::{Context, Result, bail, ensure};
use futures_util::TryStreamExt;
use gas::prelude::*;
use serde::{Deserialize, Serialize};
use universaldb::{
	RangeOption,
	options::{Priority, StreamingMode},
	utils::{IsolationLevel::Serializable, end_of_prefix_range},
};

use crate::{
	cold_tier::{cold_tier_from_config, validate_cold_shard_object_key},
	gc, keys,
	types::{
		BranchColdGcManifest, BranchColdObjectTombstone, DatabaseBranchId,
		decode_branch_cold_gc_manifest, decode_branch_cold_object_tombstone,
	},
};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DbBranchColdGcInput {
	pub database_branch_id: DatabaseBranchId,
}

/// Short-lived physical deletion worker. It is dispatched from a fixed sharded queue only after
/// both the recovery timer and backup restore-floor certificate permit deletion.
#[workflow(DbBranchColdGcWorkflow)]
pub async fn depot_db_branch_cold_gc(
	ctx: &mut WorkflowCtx,
	input: &DbBranchColdGcInput,
) -> Result<()> {
	loop {
		match ctx
			.activity(DeleteBranchColdGcPageInput {
				database_branch_id: input.database_branch_id,
			})
			.await?
		{
			DeleteBranchColdGcPageOutput::More => {}
			DeleteBranchColdGcPageOutput::Complete => return Ok(()),
			DeleteBranchColdGcPageOutput::Deferred { reason } => {
				tracing::debug!(
					?input.database_branch_id,
					%reason,
					"deferred branch cold object deletion"
				);
				ctx.activity(DeferBranchColdGcInput {
					database_branch_id: input.database_branch_id,
				})
				.await?;
				return Ok(());
			}
		}
	}
}

#[derive(Debug, Clone, Deserialize, Hash, Serialize)]
struct DeleteBranchColdGcPageInput {
	database_branch_id: DatabaseBranchId,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
enum DeleteBranchColdGcPageOutput {
	More,
	Complete,
	Deferred { reason: String },
}

#[derive(Debug, Clone)]
struct PlannedObject {
	row_key: Vec<u8>,
	tombstone: BranchColdObjectTombstone,
}

enum DeletePlan {
	Complete,
	Deferred(String),
	Objects {
		manifest: BranchColdGcManifest,
		objects: Vec<PlannedObject>,
		has_more: bool,
	},
}

#[activity(DeleteBranchColdGcPage)]
async fn delete_branch_cold_gc_page(
	ctx: &ActivityCtx,
	input: &DeleteBranchColdGcPageInput,
) -> Result<DeleteBranchColdGcPageOutput> {
	let database_branch_id = input.database_branch_id;
	let now_ms = ctx.ts();
	let plan = ctx
		.udb()?
		.txn("depot_plan_branch_cold_gc_page", move |tx| async move {
			tx.priority(Priority::Low)?;
			plan_delete_page_tx(&tx, database_branch_id, now_ms).await
		})
		.await?;
	let (manifest, objects, has_more) = match plan {
		DeletePlan::Complete => return Ok(DeleteBranchColdGcPageOutput::Complete),
		DeletePlan::Deferred(reason) => {
			return Ok(DeleteBranchColdGcPageOutput::Deferred { reason });
		}
		DeletePlan::Objects {
			manifest,
			objects,
			has_more,
		} => (manifest, objects, has_more),
	};

	let Some(cold_tier) = cold_tier_from_config(ctx.config()).await? else {
		bail!("branch cold GC has durable objects but cold storage is disabled");
	};
	let object_keys = objects
		.iter()
		.map(|object| object.tombstone.object_key.clone())
		.collect::<Vec<_>>();
	let udb = ctx.udb()?;
	let policy = crate::cold_tier::read_cold_gc_policy(&udb).await?;
	ensure!(
		policy.spec.deletion_enabled && !policy.spec.dry_run,
		"ColdGcPolicy changed after branch delete issuance"
	);
	ensure!(
		objects.iter().all(|object| object
			.tombstone
			.delete_authorization
			.as_ref()
			.and_then(|authorization| authorization.policy_revision)
			== Some(policy.revision)),
		"ColdGcPolicy revision changed after branch delete issuance"
	);
	crate::cold_tier::delete::delete_objects_with_policy(cold_tier, &object_keys, &policy.spec)
		.await
		.context("delete exact tombstoned branch cold objects")?;
	#[cfg(feature = "test-faults")]
	crate::compaction::test_hooks::maybe_fire_branch_gc_fault(
		database_branch_id,
		crate::fault::BranchGcFaultPoint::AfterColdObjectDelete,
	)
	.await?;

	ctx.udb()?
		.txn("depot_complete_branch_cold_gc_page", move |tx| {
			let manifest = manifest.clone();
			let objects = objects.clone();
			async move {
				tx.priority(Priority::Low)?;
				let encoded_manifest = tx
					.informal()
					.get(
						&keys::branch_cold_gc_manifest_key(database_branch_id),
						Serializable,
					)
					.await?
					.context("branch cold GC manifest disappeared after object delete")?;
				ensure!(
					decode_branch_cold_gc_manifest(&encoded_manifest)? == manifest,
					"branch cold GC manifest changed after object delete"
				);
				for object in objects {
					let Some(encoded) = tx.informal().get(&object.row_key, Serializable).await?
					else {
						continue;
					};
					ensure!(
						decode_branch_cold_object_tombstone(&encoded)? == object.tombstone,
						"branch cold object tombstone changed after exact delete"
					);
					let authorization = object
						.tombstone
						.delete_authorization
						.clone()
						.context("delete-issued branch object is missing its authorization")?;
					crate::cold_tier::audit::write_completed_delete_receipt_tx(
						&tx,
						crate::types::ColdDeleteReceipt {
							object_key: object.tombstone.object_key.clone(),
							database_branch_id: object.tombstone.database_branch_id,
							object_generation_id: object.tombstone.object_generation_id,
							shard_id: object.tombstone.shard_id,
							as_of_txid: object.tombstone.as_of_txid,
							content_hash: object.tombstone.content_hash,
							size_bytes: object.tombstone.size_bytes,
							authorization,
							completed_at_ms: now_ms,
						},
					)
					.await?;
					if matches!(
						object.tombstone.accounting_state,
						crate::types::BranchColdObjectAccountingState::DeleteIssued
							| crate::types::BranchColdObjectAccountingState::OrphanDeleteIssued
					) {
						let size_bytes = crate::cold_tier::accounting::checked_bytes(
							object.tombstone.size_bytes,
						)?;
						let (orphan_bytes, orphan_objects) = if object.tombstone.accounting_state
							== crate::types::BranchColdObjectAccountingState::OrphanDeleteIssued
						{
							(size_bytes.saturating_neg(), -1)
						} else {
							(0, 0)
						};
						crate::cold_tier::accounting::apply_delta_for_branch(
							&tx,
							database_branch_id,
							crate::cold_tier::accounting::ColdStorageAccountingDelta {
								delete_issued_bytes: size_bytes.saturating_neg(),
								delete_issued_objects: -1,
								orphan_bytes,
								orphan_objects,
								deleted_bytes_total: size_bytes,
								deleted_objects_total: 1,
								..Default::default()
							},
						);
					}
					tx.informal().clear(&object.row_key);
				}
				Ok(())
			}
		})
		.await?;

	Ok(if has_more {
		DeleteBranchColdGcPageOutput::More
	} else {
		// Run one final proof transaction. It sees an empty prefix and atomically removes the queue
		// locator and manifest; response-loss replay is therefore harmless.
		DeleteBranchColdGcPageOutput::More
	})
}

async fn plan_delete_page_tx(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
	now_ms: i64,
) -> Result<DeletePlan> {
	let manifest_key = keys::branch_cold_gc_manifest_key(database_branch_id);
	let Some(encoded_manifest) = tx.informal().get(&manifest_key, Serializable).await? else {
		gc::clear_branch_cold_gc_queue_tx(tx, database_branch_id).await?;
		return Ok(DeletePlan::Complete);
	};
	let manifest = decode_branch_cold_gc_manifest(&encoded_manifest)?;
	ensure!(
		manifest.database_branch_id == database_branch_id && manifest.staging_complete,
		"branch cold GC manifest is incomplete or belongs to another branch"
	);
	let policy = crate::cold_tier::policy::read_cold_gc_policy_tx(tx).await?;
	let effective_delete_after_ms = crate::cold_tier::policy::effective_delete_after_ms(
		manifest.tombstoned_at_ms,
		manifest.delete_after_ms,
		policy.spec.grace_period_ms,
	)?;
	if effective_delete_after_ms > now_ms {
		return Ok(DeletePlan::Deferred(
			"branch cold object is still in its recovery window".to_string(),
		));
	}
	let authorization = match crate::cold_tier::policy::authorize_cold_gc_deletion_tx(
		tx,
		manifest.tombstone_versionstamp,
		now_ms,
		crate::types::ColdDeleteReason::BranchGarbageCollection,
	)
	.await?
	{
		Ok(authorization) => authorization,
		Err(reason) => return Ok(DeletePlan::Deferred(reason)),
	};

	ensure!(
		authorization.policy_revision == Some(policy.revision),
		"ColdGcPolicy changed while planning branch deletion"
	);
	let batch_limit = usize::from(policy.spec.max_objects_per_batch);
	let prefix = keys::branch_cold_gc_object_prefix(database_branch_id);
	let end = end_of_prefix_range(&prefix);
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			limit: Some(batch_limit.saturating_add(1)),
			mode: StreamingMode::Exact,
			..(prefix.as_slice(), end.as_slice()).into()
		},
		Serializable,
	);
	let mut objects = Vec::new();
	while let Some(row) = stream.try_next().await? {
		let tombstone = decode_branch_cold_object_tombstone(row.value())?;
		ensure!(
			tombstone.database_branch_id == database_branch_id
				&& tombstone.lifecycle_generation == manifest.lifecycle_generation
				&& tombstone.tombstoned_at_ms == manifest.tombstoned_at_ms,
			"branch cold object tombstone does not match its manifest"
		);
		validate_cold_shard_object_key(
			&tombstone.object_key,
			tombstone.database_branch_id,
			tombstone.object_generation_id,
			tombstone.shard_id,
			tombstone.as_of_txid,
			tombstone.content_hash,
		)
		.context("refuse noncanonical branch cold object tombstone")?;
		objects.push(PlannedObject {
			row_key: row.key().to_vec(),
			tombstone,
		});
	}
	let has_more = objects.len() > batch_limit;
	objects.truncate(batch_limit);
	if objects.is_empty() {
		gc::clear_branch_cold_gc_queue_tx(tx, database_branch_id).await?;
		tx.informal().clear(&manifest_key);
		return Ok(DeletePlan::Complete);
	}
	for object in &mut objects {
		use crate::types::BranchColdObjectAccountingState;
		let size_bytes = crate::cold_tier::accounting::checked_bytes(object.tombstone.size_bytes)?;
		let authorization_changed =
			object.tombstone.delete_authorization.as_ref() != Some(&authorization);
		let delta = match object.tombstone.accounting_state {
			BranchColdObjectAccountingState::Retired => {
				object.tombstone.accounting_state = BranchColdObjectAccountingState::DeleteIssued;
				object.tombstone.delete_authorization = Some(authorization.clone());
				crate::cold_tier::accounting::ColdStorageAccountingDelta {
					retired_bytes: size_bytes.saturating_neg(),
					retired_objects: -1,
					delete_issued_bytes: size_bytes,
					delete_issued_objects: 1,
					..Default::default()
				}
			}
			BranchColdObjectAccountingState::Orphan => {
				object.tombstone.accounting_state =
					BranchColdObjectAccountingState::OrphanDeleteIssued;
				object.tombstone.delete_authorization = Some(authorization.clone());
				crate::cold_tier::accounting::ColdStorageAccountingDelta {
					delete_issued_bytes: size_bytes,
					delete_issued_objects: 1,
					..Default::default()
				}
			}
			BranchColdObjectAccountingState::DeleteIssued
			| BranchColdObjectAccountingState::OrphanDeleteIssued => {
				object.tombstone.delete_authorization = Some(authorization.clone());
				Default::default()
			}
			BranchColdObjectAccountingState::Deleted => Default::default(),
		};
		if delta != Default::default() || authorization_changed {
			tx.informal().set(
				&object.row_key,
				&crate::types::encode_branch_cold_object_tombstone(object.tombstone.clone())?,
			);
			crate::cold_tier::accounting::apply_delta_for_branch(tx, database_branch_id, delta);
		}
	}

	Ok(DeletePlan::Objects {
		manifest,
		objects,
		has_more,
	})
}

#[derive(Debug, Clone, Deserialize, Hash, Serialize)]
struct DeferBranchColdGcInput {
	database_branch_id: DatabaseBranchId,
}

#[activity(DeferBranchColdGc)]
async fn defer_branch_cold_gc(ctx: &ActivityCtx, input: &DeferBranchColdGcInput) -> Result<()> {
	let database_branch_id = input.database_branch_id;
	let now_ms = ctx.ts();
	ctx.udb()?
		.txn("depot_defer_branch_cold_gc", move |tx| async move {
			gc::defer_branch_cold_gc_tx(&tx, database_branch_id, now_ms).await?;
			Ok(())
		})
		.await
}
