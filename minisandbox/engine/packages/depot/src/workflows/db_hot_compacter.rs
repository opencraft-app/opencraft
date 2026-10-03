use universaldb::prelude::*;

use std::sync::{
	Arc,
	atomic::{AtomicBool, Ordering},
};

use thiserror::Error;

use crate::compaction::{
	companion::{CompanionKind, run_companion_loop},
	shared::*,
	*,
};
use crate::workflows::db_manager::branch_record_is_live_at_generation;

#[cfg(feature = "test-faults")]
use crate::compaction::test_hooks;
#[cfg(feature = "test-faults")]
use crate::fault::{DepotFaultAction, HotCompactionFaultPoint};

#[workflow(DbHotCompacterWorkflow)]
pub async fn depot_db_hot_compacter(
	ctx: &mut WorkflowCtx,
	input: &DbHotCompacterInput,
) -> Result<()> {
	run_companion_loop(ctx, input.database_branch_id, CompanionKind::Hot).await
}

#[activity(StageHotJob)]
#[admission = stage_hot_admission(ctx, input)]
pub async fn stage_hot_job(
	ctx: &ActivityCtx,
	input: &StageHotJobInput,
) -> Result<StageHotJobOutput> {
	let input_for_prepare = input.clone();
	let now_ms = ctx.ts();
	let prepared = ctx
		.udb()?
		.txn("depot_hot_compact_stage", move |tx| {
			let input = input_for_prepare.clone();
			async move {
				tx.priority(Priority::Low)?;
				prepare_hot_job_tx(&tx, &input, now_ms).await
			}
		})
		.await?;
	let prepared = match prepared {
		PreparedHotJob::Output(output) => return Ok(output),
		PreparedHotJob::Ready(prepared) => prepared,
	};

	let PreparedHotWork {
		base_hot_watermark_txid,
		shards,
	} = prepared;
	let mut staged_rows = Vec::with_capacity(shards.len());
	for prepared_shard in shards {
		let input_for_batch = input.clone();
		let batch = match ctx
			.udb()?
			.txn("depot_hot_compact_publish_shard_batch", move |tx| {
				let input = input_for_batch.clone();
				let prepared_shard = prepared_shard.clone();
				async move {
					tx.priority(Priority::Low)?;
					let output = materialize_prepared_hot_shard(
						&tx,
						&input,
						prepared_shard,
						base_hot_watermark_txid,
					)
					.await?;
					let published = publish_hot_shard_batch_tx(
						&tx,
						&input,
						&output.output_ref,
						&output.blob,
						&output.stage_key,
						&output.stage_proof,
					)
					.await?;
					Ok((published, output.stage_key, output.stage_proof))
				}
			})
			.await
		{
			Ok(published) => published,
			Err(err) => return Ok(failed_hot_job(err)),
		};
		if !batch.0 {
			clear_staged_hot_proofs(ctx, input, &staged_rows).await?;
			return Ok(rejected_hot_job(
				"database branch lifecycle or compaction generation changed during staged publish",
			));
		}
		staged_rows.push((batch.1, batch.2));
		#[cfg(feature = "test-faults")]
		test_hooks::maybe_fire_hot_compaction_fault(
			input.database_branch_id,
			HotCompactionFaultPoint::StageAfterShardBatchFdbCommit,
		)
		.await?;
	}

	let output_summary = summarize_staged_hot_rows(&staged_rows);
	#[cfg(feature = "test-faults")]
	if let Some(output) =
		hot_stage_after_shard_write_fault_output(ctx, input, &staged_rows, output_summary).await?
	{
		return Ok(output);
	}

	Ok(StageHotJobOutput {
		status: CompactionJobStatus::Succeeded,
		output_summary,
	})
}

enum PreparedHotJob {
	Output(StageHotJobOutput),
	Ready(PreparedHotWork),
}

struct PreparedHotWork {
	base_hot_watermark_txid: u64,
	shards: Vec<PreparedHotShard>,
}

async fn prepare_hot_job_tx(
	tx: &universaldb::Transaction,
	input: &StageHotJobInput,
	now_ms: i64,
) -> Result<PreparedHotJob> {
	if input.job_kind != CompactionJobKind::Hot {
		return Ok(PreparedHotJob::Output(rejected_hot_job(
			"hot compacter received a non-hot job",
		)));
	}
	#[cfg(feature = "test-faults")]
	if let Some(output) = hot_stage_fault_output(
		input.database_branch_id,
		HotCompactionFaultPoint::StageBeforeInputRead,
	)
	.await?
	{
		return Ok(PreparedHotJob::Output(output));
	}

	let branch_record = tx_get_value(
		tx,
		&keys::branches_list_key(input.database_branch_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_database_branch_record)
	.transpose()
	.context("decode sqlite database branch record for hot compaction")?;
	if !branch_record_is_live_at_generation(branch_record.as_ref(), input.base_lifecycle_generation)
	{
		return Ok(PreparedHotJob::Output(rejected_hot_job(
			"database branch lifecycle changed",
		)));
	}

	let root = tx_get_value(
		tx,
		&keys::branch_compaction_root_key(input.database_branch_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_compaction_root)
	.transpose()
	.context("decode sqlite compaction root for hot compaction")?
	.unwrap_or(CompactionRoot {
		schema_version: 1,
		manifest_generation: 0,
		hot_watermark_txid: 0,
		cold_watermark_txid: 0,
		cold_watermark_versionstamp: [0; 16],
	});
	if root.manifest_generation != input.base_manifest_generation {
		return Ok(PreparedHotJob::Output(retryable_hot_job(
			"base manifest generation changed",
		)));
	}

	let Some(head) = tx_get_value(
		tx,
		&keys::branch_meta_head_key(input.database_branch_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_db_head)
	.transpose()
	.context("decode sqlite head for hot compaction")?
	else {
		return Ok(PreparedHotJob::Output(rejected_hot_job(
			"database branch head is missing",
		)));
	};

	let pitr_policy = read_effective_pitr_policy_for_branch(tx, branch_record.as_ref()).await?;
	if input.input_range.txids.min_txid != root.hot_watermark_txid.saturating_add(1)
		|| input.input_range.txids.max_txid < input.input_range.txids.min_txid
		|| input.input_range.txids.max_txid > head.head_txid
	{
		return Ok(PreparedHotJob::Output(rejected_hot_job(
			"invalid committed hot prefix range",
		)));
	}
	let hot_inputs = read_hot_input_snapshot(
		tx,
		input.database_branch_id,
		Some(input.input_range.txids.max_txid),
		&root,
		Snapshot,
		pitr_policy,
		now_ms,
	)
	.await?;
	if hot_inputs.selected_max_txid != Some(input.input_range.txids.max_txid) {
		return Ok(PreparedHotJob::Output(retryable_hot_job(
			"hot compaction selected txid changed",
		)));
	}
	let coverage_txids = selected_hot_coverage_txids(
		&root,
		input.input_range.txids.max_txid,
		&hot_inputs.history_pin_txids,
		&hot_inputs.pitr_interval_coverage,
	);
	if coverage_txids != input.input_range.coverage_txids {
		return Ok(PreparedHotJob::Output(retryable_hot_job(
			"hot compaction coverage targets changed",
		)));
	}
	let input_fingerprint = fingerprint_hot_inputs(
		input.database_branch_id,
		&root,
		&coverage_txids,
		&hot_inputs,
	);
	if input_fingerprint != input.input_fingerprint {
		return Ok(PreparedHotJob::Output(retryable_hot_job(
			"hot compaction input fingerprint changed",
		)));
	}
	#[cfg(feature = "test-faults")]
	if let Some(output) = hot_stage_fault_output(
		input.database_branch_id,
		HotCompactionFaultPoint::StageAfterInputRead,
	)
	.await?
	{
		return Ok(PreparedHotJob::Output(output));
	}

	let shards = plan_staged_hot_shards(input, &hot_inputs)?;
	Ok(PreparedHotJob::Ready(PreparedHotWork {
		base_hot_watermark_txid: root.hot_watermark_txid,
		shards,
	}))
}

/// Writes one immutable materialized shard and its compact stage proof in one bounded FDB
/// transaction. Root publication remains separate and atomic; until then the shard is merely a
/// valid derived cache row. Replays compare the complete resolved bytes and converge.
async fn publish_hot_shard_batch_tx(
	tx: &universaldb::Transaction,
	input: &StageHotJobInput,
	output_ref: &HotShardOutputRef,
	blob: &[u8],
	stage_key: &[u8],
	stage_proof: &[u8],
) -> Result<bool> {
	let branch_record = tx_get_value(
		tx,
		&keys::branches_list_key(input.database_branch_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_database_branch_record)
	.transpose()
	.context("decode sqlite branch while publishing staged hot shard")?;
	if !branch_record_is_live_at_generation(branch_record.as_ref(), input.base_lifecycle_generation)
	{
		return Ok(false);
	}
	let manifest_generation = tx_get_value(
		tx,
		&keys::branch_compaction_root_key(input.database_branch_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_compaction_root)
	.transpose()
	.context("decode sqlite root while publishing staged hot shard")?
	.map_or(0, |root| root.manifest_generation);
	if manifest_generation != input.base_manifest_generation {
		return Ok(false);
	}

	ensure!(
		output_ref.size_bytes == u64::try_from(blob.len()).unwrap_or(u64::MAX)
			&& output_ref.content_hash == content_hash(blob),
		"prepared hot shard bytes do not match their output ref"
	);
	let expected_stage_key = keys::branch_compaction_stage_hot_shard_key(
		input.database_branch_id,
		input.job_id,
		output_ref.shard_id,
		output_ref.as_of_txid,
		0,
	);
	ensure!(
		stage_key == expected_stage_key,
		"prepared hot stage key does not match output ref"
	);
	let decoded_proof = decode_hot_shard_stage_proof(stage_proof)
		.context("decode prepared hot shard stage proof")?;
	ensure!(
		decoded_proof.database_branch_id == input.database_branch_id
			&& decoded_proof.job_id == input.job_id
			&& decoded_proof.shard_id == output_ref.shard_id
			&& decoded_proof.as_of_txid == output_ref.as_of_txid
			&& decoded_proof.min_txid == output_ref.min_txid
			&& decoded_proof.max_txid == output_ref.max_txid
			&& decoded_proof.size_bytes == output_ref.size_bytes
			&& decoded_proof.content_hash == output_ref.content_hash,
		"prepared hot stage proof does not match output ref"
	);
	let stage_job = HotStageJobRecord {
		database_branch_id: input.database_branch_id,
		job_id: input.job_id,
		base_lifecycle_generation: input.base_lifecycle_generation,
		base_manifest_generation: input.base_manifest_generation,
		input_fingerprint: input.input_fingerprint,
	};
	let stage_job_bytes = encode_hot_stage_job_record(stage_job.clone())?;
	let stage_job_key =
		keys::branch_compaction_stage_hot_job_key(input.database_branch_id, input.job_id);
	match tx_get_value(tx, &stage_job_key, Serializable).await? {
		Some(existing) => ensure!(
			existing == stage_job_bytes,
			"staged hot job record already contains different bytes"
		),
		None => tx.informal().set(&stage_job_key, &stage_job_bytes),
	}
	tx.informal().set(
		&keys::branch_hot_compaction_job_queue_key(input.database_branch_id, input.job_id),
		&[],
	);
	let generation_key = keys::branch_compaction_stage_hot_job_by_generation_key(
		input.database_branch_id,
		input.base_manifest_generation,
		input.job_id,
	);
	match tx_get_value(tx, &generation_key, Serializable).await? {
		Some(existing) => ensure!(
			existing.is_empty(),
			"staged hot job generation index value is corrupt"
		),
		None => tx.informal().set(&generation_key, &[]),
	}

	let shard_key = keys::branch_shard_key(
		input.database_branch_id,
		output_ref.shard_id,
		output_ref.as_of_txid,
	);
	match tx_get_value(tx, &shard_key, Serializable).await? {
		Some(existing_row) => {
			let existing = crate::conveyer::shard_blob::resolve_branch_shard_value(
				tx,
				input.database_branch_id,
				output_ref.shard_id,
				output_ref.as_of_txid,
				&existing_row,
				Serializable,
			)
			.await
			.context("resolve existing immutable hot shard during staged publish")?;
			ensure!(
				existing == blob,
				"immutable hot shard key already contains different bytes"
			);
		}
		None => crate::conveyer::shard_blob::write_branch_shard_blob(
			tx,
			input.database_branch_id,
			output_ref.shard_id,
			output_ref.as_of_txid,
			blob,
		)?,
	}

	match tx_get_value(tx, stage_key, Serializable).await? {
		Some(existing) => ensure!(
			existing == stage_proof,
			"staged hot shard proof key already contains different bytes"
		),
		None => tx.informal().set(stage_key, stage_proof),
	}
	Ok(true)
}

async fn clear_staged_hot_proofs(
	ctx: &ActivityCtx,
	input: &StageHotJobInput,
	rows: &[(Vec<u8>, Vec<u8>)],
) -> Result<()> {
	let rows = rows.to_vec();
	let input = input.clone();
	ctx.udb()?
		.txn("depot_hot_compact_clear_stage_proofs", move |tx| {
			let rows = rows.clone();
			let input = input.clone();
			async move {
				tx.priority(Priority::Low)?;
				for (key, value) in rows {
					let (shard_id, as_of_txid, chunk_idx) =
						keys::decode_branch_compaction_stage_hot_shard_key(
							input.database_branch_id,
							input.job_id,
							&key,
						)?;
					ensure!(chunk_idx == 0);
					let proof = decode_hot_shard_stage_proof(&value)?;
					ensure!(proof.shard_id == shard_id && proof.as_of_txid == as_of_txid);
					udb::compare_and_clear(&tx, &key, &value);
				}
				clear_hot_stage_job_record_tx(&tx, input.database_branch_id, input.job_id).await?;
				Ok(())
			}
		})
		.await
}

fn rejected_hot_job(reason: impl Into<String>) -> StageHotJobOutput {
	StageHotJobOutput {
		status: CompactionJobStatus::Rejected {
			reason: reason.into(),
		},
		output_summary: HotStageSummary::default(),
	}
}

fn retryable_hot_job(reason: impl Into<String>) -> StageHotJobOutput {
	StageHotJobOutput {
		status: CompactionJobStatus::Retryable {
			reason: reason.into(),
		},
		output_summary: HotStageSummary::default(),
	}
}

#[cfg(feature = "test-faults")]
async fn hot_stage_fault_output(
	database_branch_id: DatabaseBranchId,
	point: HotCompactionFaultPoint,
) -> Result<Option<StageHotJobOutput>> {
	match test_hooks::maybe_fire_hot_compaction_fault(database_branch_id, point).await {
		Ok(Some(_)) | Ok(None) => Ok(None),
		Err(err) => Ok(Some(failed_hot_job(err))),
	}
}

#[cfg(feature = "test-faults")]
async fn hot_stage_after_shard_write_fault_output(
	ctx: &ActivityCtx,
	input: &StageHotJobInput,
	rows: &[(Vec<u8>, Vec<u8>)],
	output_summary: HotStageSummary,
) -> Result<Option<StageHotJobOutput>> {
	match test_hooks::maybe_fire_hot_compaction_fault(
		input.database_branch_id,
		HotCompactionFaultPoint::StageAfterShardWrite,
	)
	.await
	{
		Ok(Some(fired)) if fired.action == DepotFaultAction::DropArtifact => {
			clear_staged_hot_proofs(ctx, input, rows).await?;
			Ok(Some(StageHotJobOutput {
				status: CompactionJobStatus::Succeeded,
				output_summary,
			}))
		}
		Ok(Some(_)) | Ok(None) => Ok(None),
		Err(err) => Ok(Some(failed_hot_job(err))),
	}
}

fn failed_hot_job(err: anyhow::Error) -> StageHotJobOutput {
	StageHotJobOutput {
		status: CompactionJobStatus::Failed {
			error: format!("{err:#}"),
		},
		output_summary: HotStageSummary::default(),
	}
}

async fn stage_hot_admission(
	ctx: &ActivityCtx,
	_input: &StageHotJobInput,
) -> Result<gas::activity::ActivityAdmission<StageHotJobOutput>> {
	#[cfg(feature = "test-faults")]
	if let Some(output) = hot_stage_fault_output(
		_input.database_branch_id,
		HotCompactionFaultPoint::StageBeforeAdmission,
	)
	.await?
	{
		return Ok(gas::activity::ActivityAdmission::Complete(output));
	}
	crate::admission::compaction(ctx).await
}

#[activity(InstallHotJob)]
#[admission = crate::admission::compaction(ctx)]
pub async fn install_hot_job(
	ctx: &ActivityCtx,
	input: &InstallHotJobInput,
) -> Result<InstallHotJobOutput> {
	// A conflict in the final publish transaction means its automatic retry would otherwise trust
	// a preflight from an older read version. Escape the driver's retry closure, repeat every
	// bounded integrity read, and only then attempt the compact atomic publish again.
	for _ in 0..3 {
		#[cfg(feature = "test-faults")]
		if let Some(output) = hot_install_fault_output(
			input.database_branch_id,
			HotCompactionFaultPoint::InstallBeforeShardIntegrityPreflight,
		)
		.await?
		{
			return Ok(output);
		}

		let integrity_refs = match read_hot_install_integrity_refs(ctx, input).await? {
			HotInstallIntegrityPlan::Output(output) => return Ok(output),
			HotInstallIntegrityPlan::Refs(refs) => refs,
		};
		#[cfg(feature = "test-faults")]
		if let Some(output) = hot_install_fault_output(
			input.database_branch_id,
			HotCompactionFaultPoint::InstallAfterInputCheckBeforeShardIntegrity,
		)
		.await?
		{
			return Ok(output);
		}
		let integrity_batches = match hot_install_integrity_batches(integrity_refs) {
			Ok(batches) => batches,
			Err(err) => {
				return Ok(rejected_hot_install(format!(
					"invalid staged hot shard integrity plan: {err:#}"
				)));
			}
		};
		for batch in integrity_batches {
			let input_for_verify = input.clone();
			let rejection = ctx
				.udb()?
				.txn("depot_hot_compact_verify_shard_batch", move |tx| {
					let input = input_for_verify.clone();
					let batch = batch.clone();
					async move {
						tx.priority(Priority::Low)?;
						verify_hot_install_shard_batch_tx(&tx, &input, &batch).await
					}
				})
				.await?;
			if let Some(reason) = rejection {
				// Truncate may remove a prepublished row after the initial input check. Only an
				// independently proven stale plan can turn this integrity failure into a retry.
				if let HotInstallIntegrityPlan::Output(output) =
					read_hot_install_integrity_refs(ctx, input).await?
				{
					return Ok(output);
				}
				return Ok(rejected_hot_install(reason));
			}
		}

		let input_for_tx = input.clone();
		let now_ms = ctx.ts();
		let first_driver_attempt = Arc::new(AtomicBool::new(true));
		let output = ctx
			.udb()?
			.txn("depot_hot_compact_install", move |tx| {
				let input = input_for_tx.clone();
				let first_driver_attempt = Arc::clone(&first_driver_attempt);
				async move {
					if !first_driver_attempt.swap(false, Ordering::SeqCst) {
						return Err(HotInstallIntegrityRecheckRequired.into());
					}
					tx.priority(Priority::Low)?;
					install_hot_job_tx(&tx, &input, now_ms).await
				}
			})
			.await;
		match output {
			Ok(output) => {
				#[cfg(feature = "test-faults")]
				test_hooks::maybe_fire_hot_compaction_fault(
					input.database_branch_id,
					HotCompactionFaultPoint::InstallAfterFdbCommit,
				)
				.await?;
				return Ok(output);
			}
			Err(err) if hot_install_integrity_recheck_required(&err) => continue,
			Err(err) => return Err(err),
		}
	}

	bail!("hot install exhausted integrity rechecks after repeated publish conflicts")
}

#[derive(Debug, Error)]
#[error("hot install publish transaction retried after integrity preflight")]
struct HotInstallIntegrityRecheckRequired;

fn hot_install_integrity_recheck_required(err: &anyhow::Error) -> bool {
	err.chain()
		.any(|cause| cause.is::<HotInstallIntegrityRecheckRequired>())
}

enum HotInstallIntegrityPlan {
	Output(InstallHotJobOutput),
	Refs(Vec<HotShardOutputRef>),
}

/// Validate bounded input identity before reading compact stage proofs. Shard bodies are verified
/// separately so one large generation cannot load every body into the publication transaction.
/// The exact publication marker also resolves response-loss replay before reading retired inputs.
async fn read_hot_install_integrity_refs(
	ctx: &ActivityCtx,
	input: &InstallHotJobInput,
) -> Result<HotInstallIntegrityPlan> {
	let input_for_tx = input.clone();
	let now_ms = ctx.ts();
	ctx.udb()?
		.txn("depot_hot_compact_read_integrity_proofs", move |tx| {
			let input = input_for_tx.clone();
			async move {
				tx.priority(Priority::Low)?;
				if let HotInstallInputCheck::Output(output) =
					validate_hot_install_inputs_tx(&tx, &input, now_ms).await?
				{
					return Ok(HotInstallIntegrityPlan::Output(output));
				}
				let staged = read_staged_hot_shard_batch(&tx, &input, Serializable).await?;
				if summarize_staged_hot_rows(&staged.rows) != input.output_summary {
					// Let the atomic install path return its existing precise rejection or
					// idempotent response-loss result.
					return Ok(HotInstallIntegrityPlan::Refs(Vec::new()));
				}
				Ok(HotInstallIntegrityPlan::Refs(staged.output_refs))
			}
		})
		.await
}

/// Partitions integrity reads by both physical key count and value bytes. The extra per-shard
/// allowance covers the compact stage proof and canonical manifest rows without relying on their
/// current encoding size.
fn hot_install_integrity_batches(
	output_refs: Vec<HotShardOutputRef>,
) -> Result<Vec<Vec<HotShardOutputRef>>> {
	const METADATA_VALUE_BYTES_PER_SHARD: u64 = 1024;
	let mut batches = Vec::new();
	let mut batch = Vec::new();
	let mut batch_key_count = 0_usize;
	let mut batch_value_bytes = 0_u64;

	for output_ref in output_refs {
		ensure!(
			output_ref.size_bytes
				<= u64::try_from(crate::MAX_HOT_SHARD_BLOB_BYTES).unwrap_or(u64::MAX),
			"staged hot shard {} txid {} exceeds the maximum encoded length",
			output_ref.shard_id,
			output_ref.as_of_txid
		);
		let chunk_count = output_ref
			.size_bytes
			.saturating_add(u64::try_from(crate::HOT_SHARD_CHUNK_BYTES).unwrap_or(u64::MAX) - 1)
			/ u64::try_from(crate::HOT_SHARD_CHUNK_BYTES).unwrap_or(1);
		let physical_key_count = usize::try_from(chunk_count)
			.unwrap_or(usize::MAX)
			.saturating_add(2); // stage proof + canonical SHARD row
		let physical_value_bytes = output_ref
			.size_bytes
			.saturating_add(METADATA_VALUE_BYTES_PER_SHARD);
		ensure!(
			physical_key_count <= crate::CMP_FDB_BATCH_MAX_KEYS
				&& physical_value_bytes
					<= u64::try_from(crate::CMP_FDB_BATCH_MAX_VALUE_BYTES).unwrap_or(u64::MAX),
			"one staged hot shard cannot fit the integrity verification budget"
		);

		if !batch.is_empty()
			&& (batch_key_count.saturating_add(physical_key_count) > crate::CMP_FDB_BATCH_MAX_KEYS
				|| batch_value_bytes.saturating_add(physical_value_bytes)
					> u64::try_from(crate::CMP_FDB_BATCH_MAX_VALUE_BYTES).unwrap_or(u64::MAX))
		{
			batches.push(std::mem::take(&mut batch));
			batch_key_count = 0;
			batch_value_bytes = 0;
		}
		batch_key_count = batch_key_count.saturating_add(physical_key_count);
		batch_value_bytes = batch_value_bytes.saturating_add(physical_value_bytes);
		batch.push(output_ref);
	}
	if !batch.is_empty() {
		batches.push(batch);
	}
	Ok(batches)
}

async fn verify_hot_install_shard_batch_tx(
	tx: &universaldb::Transaction,
	input: &InstallHotJobInput,
	output_refs: &[HotShardOutputRef],
) -> Result<Option<String>> {
	for output_ref in output_refs {
		let stage_key = keys::branch_compaction_stage_hot_shard_key(
			input.database_branch_id,
			input.job_id,
			output_ref.shard_id,
			output_ref.as_of_txid,
			0,
		);
		let Some(stage_value) = tx_get_value(tx, &stage_key, Serializable).await? else {
			return Ok(Some(format!(
				"staged hot shard proof is missing for shard {} txid {}",
				output_ref.shard_id, output_ref.as_of_txid
			)));
		};
		let proof = match decode_hot_shard_stage_proof(&stage_value) {
			Ok(proof) => proof,
			Err(err) => {
				return Ok(Some(format!(
					"staged hot shard proof is corrupt for shard {} txid {}: {err:#}",
					output_ref.shard_id, output_ref.as_of_txid
				)));
			}
		};
		if proof.database_branch_id != input.database_branch_id
			|| proof.job_id != input.job_id
			|| proof.shard_id != output_ref.shard_id
			|| proof.as_of_txid != output_ref.as_of_txid
			|| proof.min_txid != output_ref.min_txid
			|| proof.max_txid != output_ref.max_txid
			|| proof.size_bytes != output_ref.size_bytes
			|| proof.content_hash != output_ref.content_hash
		{
			return Ok(Some(format!(
				"staged hot shard proof changed for shard {} txid {}",
				output_ref.shard_id, output_ref.as_of_txid
			)));
		}

		let shard_key = keys::branch_shard_key(
			input.database_branch_id,
			output_ref.shard_id,
			output_ref.as_of_txid,
		);
		let Some(shard_row) = tx_get_value(tx, &shard_key, Serializable).await? else {
			return Ok(Some(format!(
				"prepublished immutable hot shard is missing for shard {} txid {}",
				output_ref.shard_id, output_ref.as_of_txid
			)));
		};
		if !crate::conveyer::shard_blob::shard_row_matches_proof(
			&shard_row,
			output_ref.shard_id,
			output_ref.as_of_txid,
			output_ref.size_bytes,
			output_ref.content_hash,
		) {
			return Ok(Some(format!(
				"prepublished immutable hot shard proof mismatch for shard {} txid {}",
				output_ref.shard_id, output_ref.as_of_txid
			)));
		}

		let Ok(manifest) = crate::types::decode_hot_shard_manifest(&shard_row) else {
			// Inline shards were fully hashed by `shard_row_matches_proof` above.
			continue;
		};
		let mut chunks = Vec::with_capacity(usize::try_from(manifest.chunk_count).unwrap_or(0));
		for chunk_idx in 0..manifest.chunk_count {
			let chunk_key = keys::branch_shard_chunk_key(
				input.database_branch_id,
				output_ref.shard_id,
				output_ref.as_of_txid,
				chunk_idx,
			);
			let Some(chunk) = tx_get_value(tx, &chunk_key, Serializable).await? else {
				return Ok(Some(format!(
					"prepublished immutable hot shard chunk is missing for shard {} txid {} chunk {}",
					output_ref.shard_id, output_ref.as_of_txid, chunk_idx
				)));
			};
			chunks.push((chunk_idx, chunk));
		}
		let blob = match crate::conveyer::shard_blob::resolve_branch_shard_chunks(
			output_ref.shard_id,
			output_ref.as_of_txid,
			&shard_row,
			&chunks,
		) {
			Ok(blob) => blob,
			Err(err) => {
				return Ok(Some(format!(
					"prepublished immutable hot shard chunks are corrupt for shard {} txid {}: {err:#}",
					output_ref.shard_id, output_ref.as_of_txid
				)));
			}
		};
		if u64::try_from(blob.len()).unwrap_or(u64::MAX) != output_ref.size_bytes
			|| content_hash(&blob) != output_ref.content_hash
		{
			return Ok(Some(format!(
				"prepublished immutable hot shard content changed for shard {} txid {}",
				output_ref.shard_id, output_ref.as_of_txid
			)));
		}
	}
	Ok(None)
}

enum HotInstallInputCheck {
	Output(InstallHotJobOutput),
	Valid {
		root: CompactionRoot,
		hot_inputs: HotInputSnapshot,
	},
}

/// Validate the same bounded input identity before body preflight and inside root publication.
/// A stale truncate fence must be recognized before its removed cache rows are called corrupt.
async fn validate_hot_install_inputs_tx(
	tx: &universaldb::Transaction,
	input: &InstallHotJobInput,
	now_ms: i64,
) -> Result<HotInstallInputCheck> {
	if input.job_kind != CompactionJobKind::Hot {
		return Ok(HotInstallInputCheck::Output(rejected_hot_install(
			"manager received a non-hot job",
		)));
	}
	if hot_install_was_already_applied(tx, input).await? {
		return Ok(HotInstallInputCheck::Output(InstallHotJobOutput {
			status: CompactionJobStatus::Succeeded,
			output_summary: input.output_summary,
		}));
	}

	let branch_record = tx_get_value(
		tx,
		&keys::branches_list_key(input.database_branch_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_database_branch_record)
	.transpose()
	.context("decode sqlite database branch record for hot install")?;
	if !branch_record_is_live_at_generation(branch_record.as_ref(), input.base_lifecycle_generation)
	{
		return Ok(HotInstallInputCheck::Output(rejected_hot_install(
			"database branch lifecycle changed",
		)));
	}

	let root = tx_get_value(
		tx,
		&keys::branch_compaction_root_key(input.database_branch_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_compaction_root)
	.transpose()
	.context("decode sqlite compaction root for hot install")?
	.unwrap_or(CompactionRoot {
		schema_version: 1,
		manifest_generation: 0,
		hot_watermark_txid: 0,
		cold_watermark_txid: 0,
		cold_watermark_versionstamp: [0; 16],
	});
	if root.manifest_generation != input.base_manifest_generation {
		return Ok(HotInstallInputCheck::Output(retryable_hot_install(
			"base manifest generation changed",
		)));
	}
	let publish_generation = input.base_manifest_generation.saturating_add(1);
	if tx_get_value(
		tx,
		&keys::branch_compaction_hot_publish_key(input.database_branch_id, publish_generation),
		Serializable,
	)
	.await?
	.is_some()
	{
		return Ok(HotInstallInputCheck::Output(rejected_hot_install(
			"hot publish generation marker already exists with different proof",
		)));
	}

	let Some(head) = tx_get_value(
		tx,
		&keys::branch_meta_head_key(input.database_branch_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_db_head)
	.transpose()
	.context("decode sqlite head for hot install")?
	else {
		return Ok(HotInstallInputCheck::Output(rejected_hot_install(
			"database branch head is missing",
		)));
	};

	if resolve_bucket_fork_pins(tx, input.database_branch_id).await? {
		return Ok(HotInstallInputCheck::Output(rejected_hot_install(
			"bucket fork proof is ambiguous",
		)));
	}
	let pitr_policy = read_effective_pitr_policy_for_branch(tx, branch_record.as_ref()).await?;
	if input.input_range.txids.min_txid != root.hot_watermark_txid.saturating_add(1)
		|| input.input_range.txids.max_txid < input.input_range.txids.min_txid
		|| input.input_range.txids.max_txid > head.head_txid
	{
		return Ok(HotInstallInputCheck::Output(rejected_hot_install(
			"invalid committed hot prefix range",
		)));
	}
	let hot_inputs = read_hot_input_snapshot(
		tx,
		input.database_branch_id,
		Some(input.input_range.txids.max_txid),
		&root,
		Serializable,
		pitr_policy,
		now_ms,
	)
	.await?;
	if hot_inputs.selected_max_txid != Some(input.input_range.txids.max_txid) {
		return Ok(HotInstallInputCheck::Output(retryable_hot_install(
			"hot compaction selected txid changed",
		)));
	}
	let coverage_txids = selected_hot_coverage_txids(
		&root,
		input.input_range.txids.max_txid,
		&hot_inputs.history_pin_txids,
		&hot_inputs.pitr_interval_coverage,
	);
	if coverage_txids != input.input_range.coverage_txids {
		return Ok(HotInstallInputCheck::Output(retryable_hot_install(
			"hot compaction coverage targets changed",
		)));
	}
	let input_fingerprint = fingerprint_hot_inputs(
		input.database_branch_id,
		&root,
		&coverage_txids,
		&hot_inputs,
	);
	if input_fingerprint != input.input_fingerprint {
		return Ok(HotInstallInputCheck::Output(retryable_hot_install(
			"hot compaction input fingerprint changed",
		)));
	}
	Ok(HotInstallInputCheck::Valid { root, hot_inputs })
}

async fn install_hot_job_tx(
	tx: &universaldb::Transaction,
	input: &InstallHotJobInput,
	now_ms: i64,
) -> Result<InstallHotJobOutput> {
	let (root, hot_inputs) = match validate_hot_install_inputs_tx(tx, input, now_ms).await? {
		HotInstallInputCheck::Output(output) => return Ok(output),
		HotInstallInputCheck::Valid { root, hot_inputs } => (root, hot_inputs),
	};
	let publish_generation = input.base_manifest_generation.saturating_add(1);

	let mut staged_output_refs = Vec::with_capacity(input.output_summary.staged_row_count as usize);
	let mut staged_outputs = BTreeSet::new();
	let mut latest_staged_shards = BTreeSet::new();
	let coverage_txids = input
		.input_range
		.coverage_txids
		.iter()
		.copied()
		.collect::<BTreeSet<_>>();
	#[cfg(feature = "test-faults")]
	if let Some(output) = hot_install_before_staged_read_fault_output(tx, input).await? {
		return Ok(output);
	}
	let staged = read_staged_hot_shard_batch(tx, input, Serializable).await?;
	if summarize_staged_hot_rows(&staged.rows) != input.output_summary {
		return Ok(rejected_hot_install(
			"staged hot shard summary is missing or changed",
		));
	}
	for output_ref in &staged.output_refs {
		if !coverage_txids.contains(&output_ref.as_of_txid)
			|| output_ref.min_txid != input.input_range.txids.min_txid
			|| output_ref.max_txid != output_ref.as_of_txid
		{
			return Ok(rejected_hot_install(
				"hot output ref does not match planned txid range",
			));
		}
		if !staged_outputs.insert((output_ref.shard_id, output_ref.as_of_txid)) {
			return Ok(rejected_hot_install(
				"duplicate staged hot shard output ref",
			));
		}
		if output_ref.as_of_txid == input.input_range.txids.max_txid
			&& !latest_staged_shards.insert(output_ref.shard_id)
		{
			return Ok(rejected_hot_install(
				"duplicate latest hot shard output ref",
			));
		}

		let shard_key = keys::branch_shard_key(
			input.database_branch_id,
			output_ref.shard_id,
			output_ref.as_of_txid,
		);
		let Some(shard_row) = tx_get_value(tx, &shard_key, Serializable).await? else {
			return Ok(rejected_hot_install(
				"prepublished immutable hot shard is missing",
			));
		};
		if !crate::conveyer::shard_blob::shard_row_matches_proof(
			&shard_row,
			output_ref.shard_id,
			output_ref.as_of_txid,
			output_ref.size_bytes,
			output_ref.content_hash,
		) {
			return Ok(rejected_hot_install(
				"prepublished immutable hot shard proof mismatch",
			));
		}
		if crate::types::decode_hot_shard_manifest(&shard_row).is_ok() {
			// Body verification happened in a bounded preflight transaction. Protect its exact
			// chunk subspace until this root publication commits without loading the bodies into
			// this transaction. Any conflict forces the activity to repeat the full preflight.
			let chunk_prefix = keys::branch_shard_chunk_prefix(
				input.database_branch_id,
				output_ref.shard_id,
				output_ref.as_of_txid,
			);
			tx.add_conflict_range(
				&chunk_prefix,
				&end_of_prefix_range(&chunk_prefix),
				ConflictRangeType::Read,
			)?;
		}
		staged_output_refs.push(output_ref.clone());
	}
	#[cfg(feature = "test-faults")]
	if let Some(output) = hot_install_fault_output(
		input.database_branch_id,
		HotCompactionFaultPoint::InstallAfterStagedRead,
	)
	.await?
	{
		return Ok(output);
	}

	#[cfg(feature = "test-faults")]
	if let Some(output) = hot_install_fault_output(
		input.database_branch_id,
		HotCompactionFaultPoint::InstallBeforeShardPublish,
	)
	.await?
	{
		return Ok(output);
	}
	let hot_generation_manifests =
		hot_generation_manifests(input.database_branch_id, &staged_output_refs)?;
	for manifest in &hot_generation_manifests {
		let key = keys::branch_compaction_hot_generation_key(
			input.database_branch_id,
			manifest.as_of_txid,
		);
		if tx_get_value(tx, &key, Serializable).await?.is_some() {
			return Ok(rejected_hot_install(
				"hot generation manifest already exists",
			));
		}
		tx.informal().set(
			&key,
			&encode_hot_generation_manifest(manifest.clone())
				.context("encode sqlite hot generation manifest for install")?,
		);
	}
	// Publish one shard-major proof per materialized output in the same transaction as the root
	// and PIDX retirement. This is the bounded read-side authority used to distinguish a missing
	// shard from a legitimately sparse page; prepublished SHARD rows alone are not authoritative.
	for output_ref in &staged_output_refs {
		let key = keys::branch_compaction_hot_shard_coverage_key(
			input.database_branch_id,
			output_ref.shard_id,
			output_ref.as_of_txid,
		);
		if tx_get_value(tx, &key, Serializable).await?.is_some() {
			return Ok(rejected_hot_install(
				"hot shard coverage proof already exists",
			));
		}
		tx.informal().set(
			&key,
			&encode_hot_shard_coverage(HotShardCoverage {
				database_branch_id: input.database_branch_id,
				shard_id: output_ref.shard_id,
				as_of_txid: output_ref.as_of_txid,
				size_bytes: output_ref.size_bytes,
				content_hash: output_ref.content_hash,
			})
			.context("encode sqlite hot shard coverage for install")?,
		);
	}
	#[cfg(feature = "test-faults")]
	if let Some(output) = hot_install_fault_output(
		input.database_branch_id,
		HotCompactionFaultPoint::InstallAfterShardPublishBeforePidxClear,
	)
	.await?
	{
		return Ok(output);
	}

	for (key, value) in &hot_inputs.pidx_entries {
		let pgno = decode_branch_pidx_pgno(input.database_branch_id, key)?;
		let shard_id = pgno / keys::SHARD_SIZE;
		if !latest_staged_shards.contains(&shard_id) {
			return Ok(rejected_hot_install(
				"missing staged hot shard for PIDX row",
			));
		}
		decode_pidx_txid(value)?;
	}
	quota::ensure_pidx_count_index_initialized(tx, input.database_branch_id).await?;

	for (key, value) in &hot_inputs.pidx_entries {
		let pgno = decode_branch_pidx_pgno(input.database_branch_id, key)?;
		udb::compare_and_clear(tx, key, value);
		quota::atomic_add_pidx_row_count(tx, input.database_branch_id, pgno, -1);
	}
	let removed_pidx_bytes =
		hot_inputs
			.pidx_entries
			.iter()
			.try_fold(0_i64, |total, (key, value)| {
				let row_bytes = i64::try_from(key.len().saturating_add(value.len()))
					.context("sqlite PIDX tracked size exceeded i64 during hot install")?;
				total
					.checked_add(row_bytes)
					.context("sqlite PIDX reclaim quota bytes overflowed")
			})?;
	if removed_pidx_bytes != 0 {
		quota::atomic_add_branch(
			tx,
			input.database_branch_id,
			removed_pidx_bytes
				.checked_neg()
				.context("sqlite PIDX reclaim quota delta overflowed")?,
		);
	}

	for selection in &hot_inputs.pitr_interval_coverage {
		crate::conveyer::pitr_interval::write_pitr_interval_coverage(
			tx,
			input.database_branch_id,
			selection.bucket_start_ms,
			selection.coverage.clone(),
		)
		.await?;
	}

	#[cfg(feature = "test-faults")]
	if let Some(output) = hot_install_fault_output(
		input.database_branch_id,
		HotCompactionFaultPoint::InstallBeforeRootUpdate,
	)
	.await?
	{
		return Ok(output);
	}
	let next_root = CompactionRoot {
		schema_version: root.schema_version,
		manifest_generation: root.manifest_generation.saturating_add(1),
		hot_watermark_txid: root
			.hot_watermark_txid
			.max(input.input_range.txids.max_txid),
		cold_watermark_txid: root.cold_watermark_txid,
		cold_watermark_versionstamp: root.cold_watermark_versionstamp,
	};
	tx.informal().set(
		&keys::branch_compaction_hot_publish_key(input.database_branch_id, publish_generation),
		&encode_hot_publish_marker(HotPublishMarker {
			database_branch_id: input.database_branch_id,
			job_id: input.job_id,
			lifecycle_generation: input.base_lifecycle_generation,
			publish_generation,
			input_fingerprint: input.input_fingerprint,
			staged_row_count: input.output_summary.staged_row_count,
			staged_rows_hash: input.output_summary.staged_rows_hash,
			min_txid: input.input_range.txids.min_txid,
			max_txid: input.input_range.txids.max_txid,
		})
		.context("encode sqlite hot publish marker")?,
	);
	tx.informal().set(
		&keys::branch_compaction_root_key(input.database_branch_id),
		&encode_compaction_root(next_root)
			.context("encode sqlite compaction root for hot install")?,
	);
	tx.informal()
		.clear(&keys::branch_compaction_hot_publish_key(
			input.database_branch_id,
			root.manifest_generation,
		));
	#[cfg(feature = "test-faults")]
	if let Some(output) = hot_install_fault_output(
		input.database_branch_id,
		HotCompactionFaultPoint::InstallAfterRootUpdate,
	)
	.await?
	{
		return Ok(output);
	}
	for (key, value) in &staged.rows {
		udb::compare_and_clear(tx, key, value);
	}
	clear_hot_stage_job_record_tx(tx, input.database_branch_id, input.job_id).await?;

	Ok(InstallHotJobOutput {
		status: CompactionJobStatus::Succeeded,
		output_summary: input.output_summary,
	})
}

fn hot_generation_manifests(
	database_branch_id: DatabaseBranchId,
	staged_output_refs: &[HotShardOutputRef],
) -> Result<Vec<HotGenerationManifest>> {
	let mut by_txid = BTreeMap::<u64, Vec<HotGenerationShardRef>>::new();
	for output_ref in staged_output_refs {
		by_txid
			.entry(output_ref.as_of_txid)
			.or_default()
			.push(HotGenerationShardRef {
				shard_id: output_ref.shard_id,
				size_bytes: output_ref.size_bytes,
				content_hash: output_ref.content_hash,
			});
	}

	by_txid
		.into_iter()
		.map(|(as_of_txid, mut shards)| {
			shards.sort_by_key(|reference| reference.shard_id);
			ensure!(
				shards.len() <= CMP_COLD_MAX_SHARDS_PER_JOB,
				"hot generation {as_of_txid} exceeded {CMP_COLD_MAX_SHARDS_PER_JOB} shards"
			);
			ensure!(
				shards
					.windows(2)
					.all(|pair| pair[0].shard_id < pair[1].shard_id),
				"hot generation {as_of_txid} contains duplicate shard refs"
			);
			Ok(HotGenerationManifest {
				database_branch_id,
				as_of_txid,
				shards,
			})
		})
		.collect()
}

async fn hot_install_was_already_applied(
	tx: &universaldb::Transaction,
	input: &InstallHotJobInput,
) -> Result<bool> {
	let publish_generation = input.base_manifest_generation.saturating_add(1);
	let Some(marker) = tx_get_value(
		tx,
		&keys::branch_compaction_hot_publish_key(input.database_branch_id, publish_generation),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_hot_publish_marker)
	.transpose()
	.context("decode idempotent sqlite hot publish marker")?
	else {
		return Ok(false);
	};
	if marker.database_branch_id != input.database_branch_id
		|| marker.job_id != input.job_id
		|| marker.lifecycle_generation != input.base_lifecycle_generation
		|| marker.publish_generation != publish_generation
		|| marker.input_fingerprint != input.input_fingerprint
		|| marker.staged_row_count != input.output_summary.staged_row_count
		|| marker.staged_rows_hash != input.output_summary.staged_rows_hash
		|| marker.min_txid != input.input_range.txids.min_txid
		|| marker.max_txid != input.input_range.txids.max_txid
	{
		return Ok(false);
	}

	let root = tx_get_value(
		tx,
		&keys::branch_compaction_root_key(input.database_branch_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_compaction_root)
	.transpose()
	.context("decode sqlite compaction root for idempotent hot install")?;
	ensure!(
		root.as_ref().is_some_and(|root| {
			root.manifest_generation >= publish_generation
				&& root.hot_watermark_txid >= input.input_range.txids.max_txid
		}),
		"hot publish marker exists without its atomic root update"
	);
	Ok(true)
}

#[activity(CleanupStagedHotJob)]
pub async fn cleanup_staged_hot_job(
	ctx: &ActivityCtx,
	input: &CleanupStagedHotJobInput,
) -> Result<CleanupStagedHotJobOutput> {
	let input = input.clone();
	ctx.udb()?
		.txn("depot_hot_compact_cleanup_stale_stage", move |tx| {
			let input = input.clone();
			async move {
				tx.priority(Priority::Low)?;
				let rows = tx_scan_prefix_values_limited(
					&tx,
					&keys::branch_compaction_stage_hot_shard_prefix(
						input.database_branch_id,
						input.job_id,
					),
					CMP_FDB_BATCH_MAX_KEYS.saturating_add(1),
					Serializable,
				)
				.await?;
				ensure!(
					rows.len() <= CMP_FDB_BATCH_MAX_KEYS,
					"stale staged hot cleanup exceeded the bounded FDB row limit"
				);
				if rows.is_empty() {
					clear_hot_stage_job_record_tx(&tx, input.database_branch_id, input.job_id)
						.await?;
					return Ok(CleanupStagedHotJobOutput {
						status: CompactionJobStatus::Succeeded,
					});
				}
				if summarize_staged_hot_rows(&rows) != input.output_summary {
					return Ok(CleanupStagedHotJobOutput {
						status: CompactionJobStatus::Rejected {
							reason: "stale staged hot rows changed before cleanup".to_string(),
						},
					});
				}
				for (key, value) in rows {
					udb::compare_and_clear(&tx, &key, &value);
				}
				clear_hot_stage_job_record_tx(&tx, input.database_branch_id, input.job_id).await?;
				Ok(CleanupStagedHotJobOutput {
					status: CompactionJobStatus::Succeeded,
				})
			}
		})
		.await
}

async fn clear_hot_stage_job_record_tx(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
	job_id: Id,
) -> Result<()> {
	let queue_key = keys::branch_hot_compaction_job_queue_key(database_branch_id, job_id);
	let record_key = keys::branch_compaction_stage_hot_job_key(database_branch_id, job_id);
	let Some(record_bytes) = tx_get_value(tx, &record_key, Serializable).await? else {
		// Cleanup is idempotent: a completed retry can observe an already-removed record.
		tx.informal().clear(&queue_key);
		return Ok(());
	};
	let record = decode_hot_stage_job_record(&record_bytes)?;
	ensure!(
		record.database_branch_id == database_branch_id && record.job_id == job_id,
		"staged hot job record identity does not match its key"
	);
	udb::compare_and_clear(tx, &record_key, &record_bytes);
	tx.informal()
		.clear(&keys::branch_compaction_stage_hot_job_by_generation_key(
			database_branch_id,
			record.base_manifest_generation,
			job_id,
		));
	tx.informal().clear(&queue_key);
	Ok(())
}

fn rejected_hot_install(reason: impl Into<String>) -> InstallHotJobOutput {
	InstallHotJobOutput {
		status: CompactionJobStatus::Rejected {
			reason: reason.into(),
		},
		output_summary: HotStageSummary::default(),
	}
}

fn retryable_hot_install(reason: impl Into<String>) -> InstallHotJobOutput {
	InstallHotJobOutput {
		status: CompactionJobStatus::Retryable {
			reason: reason.into(),
		},
		output_summary: HotStageSummary::default(),
	}
}

#[cfg(feature = "test-faults")]
async fn hot_install_before_staged_read_fault_output(
	tx: &universaldb::Transaction,
	input: &InstallHotJobInput,
) -> Result<Option<InstallHotJobOutput>> {
	match test_hooks::maybe_fire_hot_compaction_fault(
		input.database_branch_id,
		HotCompactionFaultPoint::InstallBeforeStagedRead,
	)
	.await
	{
		Ok(Some(fired)) if fired.action == DepotFaultAction::DropArtifact => {
			let prefix = keys::branch_compaction_stage_hot_shard_prefix(
				input.database_branch_id,
				input.job_id,
			);
			tx.informal()
				.clear_range(&prefix, &end_of_prefix_range(&prefix));
			Ok(None)
		}
		Ok(Some(_)) | Ok(None) => Ok(None),
		Err(err) => Ok(Some(failed_hot_install(err))),
	}
}

#[cfg(feature = "test-faults")]
async fn hot_install_fault_output(
	database_branch_id: DatabaseBranchId,
	point: HotCompactionFaultPoint,
) -> Result<Option<InstallHotJobOutput>> {
	match test_hooks::maybe_fire_hot_compaction_fault(database_branch_id, point).await {
		Ok(Some(_)) | Ok(None) => Ok(None),
		Err(err) => Ok(Some(failed_hot_install(err))),
	}
}

#[cfg(feature = "test-faults")]
fn failed_hot_install(err: anyhow::Error) -> InstallHotJobOutput {
	InstallHotJobOutput {
		status: CompactionJobStatus::Failed {
			error: format!("{err:#}"),
		},
		output_summary: HotStageSummary::default(),
	}
}
