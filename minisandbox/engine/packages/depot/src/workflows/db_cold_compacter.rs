use universaldb::prelude::*;
use universaldb::utils::end_of_prefix_range;

use std::time::Instant;

use crate::{
	compaction::{
		companion::{CompanionKind, run_companion_loop},
		shared::*,
		*,
	},
	workflows::db_manager::branch_record_is_live_at_generation,
};

/// S3/COS requests and their one-shard FDB preparation transactions are independent. Keep enough
/// concurrency to hide network latency without allowing one database to create an unbounded burst.
const COLD_IO_CONCURRENCY: usize = 16;

#[cfg(feature = "test-faults")]
use crate::{compaction::test_hooks, fault::ColdCompactionFaultPoint};

#[workflow(DbColdCompacterWorkflow)]
pub async fn depot_db_cold_compacter(
	ctx: &mut WorkflowCtx,
	input: &DbColdCompacterInput,
) -> Result<()> {
	run_companion_loop(ctx, input.database_branch_id, CompanionKind::Cold).await
}

#[activity(UploadColdJob)]
#[admission = crate::admission::compaction(ctx)]
pub async fn upload_cold_job(
	ctx: &ActivityCtx,
	input: &UploadColdJobInput,
) -> Result<UploadColdJobOutput> {
	let activity = crate::metrics::CompactionActivityGuard::new(
		"cold_upload",
		usize::try_from(input.input_range.input_summary.input_ref_count).unwrap_or(usize::MAX),
		input.input_range.max_bytes,
	);
	let result = upload_cold_job_inner(ctx, input).await;
	let (result_label, objects, bytes) = match &result {
		Ok(output) => {
			let result_label = crate::metrics::compaction_status_label(&output.status);
			let succeeded = matches!(output.status, CompactionJobStatus::Succeeded);
			(
				result_label,
				u64::from(output.output_summary.output_ref_count),
				if succeeded {
					input.input_range.max_bytes
				} else {
					0
				},
			)
		}
		Err(_) => ("error", 0, 0),
	};
	activity.finish(result_label, objects, bytes);
	result
}

async fn upload_cold_job_inner(
	ctx: &ActivityCtx,
	input: &UploadColdJobInput,
) -> Result<UploadColdJobOutput> {
	let udb = ctx.udb()?;
	let input_for_tx = input.clone();
	let prepare_started = Instant::now();
	let prepared_plan_result = udb
		.txn("depot_cold_compact_prepare_upload", move |tx| {
			let input = input_for_tx.clone();
			async move {
				tx.priority(Priority::Low)?;
				validate_cold_upload_plan_tx(&tx, &input).await
			}
		})
		.await;
	crate::metrics::observe_compaction_phase(
		"cold_upload",
		"prepare_fdb",
		prepare_started,
		if prepared_plan_result.is_ok() {
			"succeeded"
		} else {
			"error"
		},
	);
	let prepared_plan = prepared_plan_result?;
	let shard_inputs = match prepared_plan {
		ValidatedColdUploadPlan::Ready(shard_inputs) => shard_inputs,
		ValidatedColdUploadPlan::Rejected(status) => {
			return Ok(UploadColdJobOutput {
				status,
				output_summary: ColdStageSummary::default(),
			});
		}
	};
	let Some(cold_tier) = cold_tier_from_config(ctx.config()).await? else {
		return Ok(rejected_cold_upload_output("cold storage is disabled"));
	};

	let upload_started = Instant::now();
	let uploaded_result = futures_util::stream::iter(shard_inputs)
		.map(|shard_input| {
			let udb = udb.clone();
			let input = input.clone();
			let cold_tier = cold_tier.clone();
			async move {
				let input_for_tx = input.clone();
				let prepared = udb
					.txn("depot_cold_compact_prepare_shard", move |tx| {
						let input = input_for_tx.clone();
						let shard_input = shard_input.clone();
						async move {
							tx.priority(Priority::Low)?;
							prepare_cold_upload_shard_tx(&tx, &input, &shard_input).await
						}
					})
					.await?;
				let object = match prepared {
					PreparedColdShardUpload::Ready(object) => object,
					PreparedColdShardUpload::Output(status) => {
						return Ok::<_, anyhow::Error>(Err(status));
					}
				};
				if let Err(error) = crate::cold_tier::validate_cold_shard_ref_key(&object.reference)
				{
					return Ok(Err(CompactionJobStatus::Failed {
						error: format!("refusing noncanonical cold object upload: {error}"),
					}));
				}
				#[cfg(feature = "test-faults")]
				let _upload_probe = test_hooks::enter_cold_upload_probe(input.database_branch_id).await;
				#[cfg(feature = "test-faults")]
				if test_hooks::should_fail_cold_upload_shard(
					input.database_branch_id,
					object.reference.shard_id,
				) {
					return Ok(Err(CompactionJobStatus::Failed {
						error: format!(
							"forced cold shard {} upload failure",
							object.reference.shard_id
						),
					}));
				}
				if let Err(err) = cold_tier
					.put_object(&object.reference.object_key, &object.bytes)
					.await
				{
					tracing::warn!(
						?input.database_branch_id,
						?input.job_id,
						object_key = object.reference.object_key,
						error = ?err,
						"sqlite cold shard exact-key upload failed"
					);
					return Ok(Err(CompactionJobStatus::Failed {
						error: format!("cold shard upload failed: {err}"),
					}));
				}
				#[cfg(feature = "test-faults")]
				test_hooks::maybe_fire_cold_compaction_fault(
					input.database_branch_id,
					ColdCompactionFaultPoint::UploadAfterObjectPut,
				)
				.await?;
				Ok(Ok(object.reference))
			}
		})
		.buffer_unordered(COLD_IO_CONCURRENCY)
		.try_collect::<Vec<_>>()
		.await;
	crate::metrics::observe_compaction_phase(
		"cold_upload",
		"put_objects",
		upload_started,
		if uploaded_result.is_ok() {
			"succeeded"
		} else {
			"error"
		},
	);
	let uploaded = uploaded_result?;
	let mut output_refs = Vec::with_capacity(uploaded.len());
	for result in uploaded {
		match result {
			Ok(reference) => output_refs.push(reference),
			Err(status) => {
				return Ok(UploadColdJobOutput {
					status,
					output_summary: ColdStageSummary::default(),
				});
			}
		}
	}
	output_refs.sort_by_key(|reference| (reference.shard_id, reference.as_of_txid));
	let stage_started = Instant::now();
	let stage_result = stage_cold_output_refs(ctx, input, &output_refs).await;
	crate::metrics::observe_compaction_phase(
		"cold_upload",
		"stage_refs_fdb",
		stage_started,
		if stage_result.is_ok() {
			"succeeded"
		} else {
			"error"
		},
	);
	if let Some(status) = stage_result? {
		return Ok(UploadColdJobOutput {
			status,
			output_summary: ColdStageSummary::default(),
		});
	}

	Ok(UploadColdJobOutput {
		status: CompactionJobStatus::Succeeded,
		output_summary: summarize_cold_output_refs(&output_refs)?,
	})
}

/// Write refs in bounded, retry-safe FDB transactions before publication. They remain invisible
/// until PublishColdJob atomically installs the matching generation marker with the root update.
async fn stage_cold_output_refs(
	ctx: &ActivityCtx,
	input: &UploadColdJobInput,
	output_refs: &[ColdShardRef],
) -> Result<Option<CompactionJobStatus>> {
	for chunk in output_refs.chunks(CMP_COLD_MAX_SHARDS_PER_JOB.min(64)) {
		let input = input.clone();
		let chunk = chunk.to_vec();
		let status = ctx
			.udb()?
			.txn("depot_cold_compact_stage_refs", move |tx| {
				let input = input.clone();
				let chunk = chunk.clone();
				async move {
					tx.priority(Priority::Low)?;
					stage_cold_output_refs_tx(&tx, &input, &chunk).await
				}
			})
			.await?;
		if status.is_some() {
			return Ok(status);
		}
	}
	Ok(None)
}

async fn stage_cold_output_refs_tx(
	tx: &universaldb::Transaction,
	input: &UploadColdJobInput,
	output_refs: &[ColdShardRef],
) -> Result<Option<CompactionJobStatus>> {
	let branch_record = tx_get_value(
		tx,
		&keys::branches_list_key(input.database_branch_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_database_branch_record)
	.transpose()
	.context("decode sqlite database branch record while staging cold refs")?;
	if !branch_record_is_live_at_generation(branch_record.as_ref(), input.base_lifecycle_generation)
	{
		return Ok(Some(CompactionJobStatus::Rejected {
			reason: "database branch lifecycle changed while staging cold refs".to_string(),
		}));
	}
	let root = read_compaction_root(tx, input.database_branch_id, Serializable).await?;
	if root.manifest_generation != input.base_manifest_generation {
		return Ok(Some(CompactionJobStatus::Rejected {
			reason: "base manifest generation changed while staging cold refs".to_string(),
		}));
	}

	for reference in output_refs {
		if reference.database_branch_id != input.database_branch_id
			|| reference.object_generation_id != input.job_id
			|| reference.lifecycle_generation != input.base_lifecycle_generation
			|| reference.publish_generation != input.base_manifest_generation.saturating_add(1)
		{
			return Ok(Some(CompactionJobStatus::Rejected {
				reason: "cold staged ref identity changed".to_string(),
			}));
		}
		let retired_key = keys::branch_compaction_retired_cold_object_key(
			input.database_branch_id,
			content_hash(reference.object_key.as_bytes()),
		);
		if tx_get_value(tx, &retired_key, Serializable)
			.await?
			.is_some()
		{
			return Ok(Some(CompactionJobStatus::Rejected {
				reason: "cold object was already retired".to_string(),
			}));
		}
		let intent_key = keys::branch_compaction_cold_upload_intent_key(
			input.database_branch_id,
			input.job_id,
			reference.shard_id,
			reference.as_of_txid,
		);
		let intent = tx_get_value(tx, &intent_key, Serializable)
			.await?
			.as_deref()
			.map(decode_cold_upload_intent)
			.transpose()
			.context("decode sqlite cold upload intent while staging ref")?;
		if !intent.as_ref().is_some_and(|intent| {
			intent.delete_authorization.is_none() && intent.reference == *reference
		}) {
			return Ok(Some(CompactionJobStatus::Rejected {
				reason: "cold upload intent is missing, changed, or being deleted".to_string(),
			}));
		}
		let key = keys::branch_compaction_cold_shard_key(
			input.database_branch_id,
			reference.shard_id,
			reference.as_of_txid,
		);
		tx.informal().set(
			&key,
			&encode_cold_shard_ref(reference.clone())
				.context("encode sqlite staged cold shard ref")?,
		);
	}
	Ok(None)
}

#[derive(Debug)]
enum PreparedColdShardUpload {
	Output(CompactionJobStatus),
	Ready(ColdUploadObject),
}

#[derive(Debug)]
struct ColdUploadObject {
	reference: ColdShardRef,
	bytes: Vec<u8>,
}

async fn validate_cold_upload_plan_tx(
	tx: &universaldb::Transaction,
	input: &UploadColdJobInput,
) -> Result<ValidatedColdUploadPlan> {
	if input.job_kind != CompactionJobKind::Cold {
		return Ok(ValidatedColdUploadPlan::Rejected(rejected_cold_status(
			"cold compacter received a non-cold job",
		)));
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
	.context("decode sqlite database branch record for cold upload")?;
	if !branch_record_is_live_at_generation(branch_record.as_ref(), input.base_lifecycle_generation)
	{
		return Ok(ValidatedColdUploadPlan::Rejected(rejected_cold_status(
			"database branch lifecycle changed",
		)));
	}

	let root = read_compaction_root(tx, input.database_branch_id, Serializable).await?;
	if root.manifest_generation != input.base_manifest_generation {
		return Ok(ValidatedColdUploadPlan::Rejected(retryable_cold_status(
			"base manifest generation changed",
		)));
	}

	let cold_inputs =
		read_cold_input_snapshot(tx, input.database_branch_id, &root, Serializable).await?;
	if cold_inputs.shard_inputs.is_empty() {
		return Ok(ValidatedColdUploadPlan::Rejected(retryable_cold_status(
			"no cold shard input is available",
		)));
	}
	if cold_inputs.selected_min_txid != Some(input.input_range.txids.min_txid)
		|| cold_inputs.selected_max_txid != Some(input.input_range.txids.max_txid)
	{
		return Ok(ValidatedColdUploadPlan::Rejected(retryable_cold_status(
			"cold compaction selected txid range changed",
		)));
	}
	if cold_inputs.min_versionstamp != input.input_range.min_versionstamp
		|| cold_inputs.max_versionstamp != input.input_range.max_versionstamp
	{
		return Ok(ValidatedColdUploadPlan::Rejected(retryable_cold_status(
			"cold compaction versionstamp bounds changed",
		)));
	}
	if summarize_cold_input_refs(&cold_inputs.shard_inputs) != input.input_range.input_summary {
		return Ok(ValidatedColdUploadPlan::Rejected(retryable_cold_status(
			"cold shard input set changed",
		)));
	}
	if cold_inputs.total_value_bytes != input.input_range.max_bytes {
		return Ok(ValidatedColdUploadPlan::Rejected(retryable_cold_status(
			"cold shard input byte count changed",
		)));
	}
	if fingerprint_cold_inputs(input.database_branch_id, &root, &cold_inputs)
		!= input.input_fingerprint
	{
		return Ok(ValidatedColdUploadPlan::Rejected(retryable_cold_status(
			"cold compaction input fingerprint changed",
		)));
	}

	Ok(ValidatedColdUploadPlan::Ready(cold_shard_input_refs(
		&cold_inputs,
	)))
}

enum ValidatedColdUploadPlan {
	Ready(Vec<ColdShardInputRef>),
	Rejected(CompactionJobStatus),
}

/// Loads and expands exactly one hot shard. The root and exact coverage proof are read in the same
/// transaction as the body, so publication races retry or reject this shard without ever holding
/// the rest of the generation in the transaction.
async fn prepare_cold_upload_shard_tx(
	tx: &universaldb::Transaction,
	input: &UploadColdJobInput,
	shard_input: &ColdShardInputRef,
) -> Result<PreparedColdShardUpload> {
	let branch_record = tx_get_value(
		tx,
		&keys::branches_list_key(input.database_branch_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_database_branch_record)
	.transpose()
	.context("decode sqlite database branch record for cold shard upload")?;
	if !branch_record_is_live_at_generation(branch_record.as_ref(), input.base_lifecycle_generation)
	{
		return Ok(PreparedColdShardUpload::Output(rejected_cold_status(
			"database branch lifecycle changed",
		)));
	}
	let root = read_compaction_root(tx, input.database_branch_id, Serializable).await?;
	if root.manifest_generation != input.base_manifest_generation {
		return Ok(PreparedColdShardUpload::Output(retryable_cold_status(
			"base manifest generation changed",
		)));
	}
	if shard_input.as_of_txid != input.input_range.txids.max_txid {
		return Ok(PreparedColdShardUpload::Output(rejected_cold_status(
			"cold shard input is outside the planned generation",
		)));
	}

	let coverage_key = keys::branch_compaction_hot_shard_coverage_key(
		input.database_branch_id,
		shard_input.shard_id,
		shard_input.as_of_txid,
	);
	let coverage = tx_get_value(tx, &coverage_key, Serializable)
		.await?
		.as_deref()
		.map(crate::types::decode_hot_shard_coverage)
		.transpose()
		.context("decode exact hot shard coverage for cold upload")?;
	if !coverage.as_ref().is_some_and(|coverage| {
		coverage.database_branch_id == input.database_branch_id
			&& coverage.shard_id == shard_input.shard_id
			&& coverage.as_of_txid == shard_input.as_of_txid
			&& coverage.size_bytes == shard_input.size_bytes
			&& coverage.content_hash == shard_input.content_hash
	}) {
		return Ok(PreparedColdShardUpload::Output(rejected_cold_status(
			"hot shard coverage changed before cold upload",
		)));
	}

	let shard_key = keys::branch_shard_key(
		input.database_branch_id,
		shard_input.shard_id,
		shard_input.as_of_txid,
	);
	let Some(row) = tx_get_value(tx, &shard_key, Serializable).await? else {
		return Ok(PreparedColdShardUpload::Output(rejected_cold_status(
			"hot shard body is missing before cold upload",
		)));
	};
	let bytes = crate::conveyer::shard_blob::resolve_branch_shard_value(
		tx,
		input.database_branch_id,
		shard_input.shard_id,
		shard_input.as_of_txid,
		&row,
		Serializable,
	)
	.await
	.context("resolve one chunked hot shard for cold upload")?;
	if u64::try_from(bytes.len()).unwrap_or(u64::MAX) != shard_input.size_bytes
		|| content_hash(&bytes) != shard_input.content_hash
	{
		return Ok(PreparedColdShardUpload::Output(rejected_cold_status(
			"hot shard body changed before cold upload",
		)));
	}
	let ltx = decode_ltx_v3(&bytes).context("decode hot shard before cold upload")?;
	if ltx.header.max_txid != shard_input.as_of_txid {
		return Ok(PreparedColdShardUpload::Output(rejected_cold_status(
			"hot shard LTX txid does not match its key",
		)));
	}
	let (reference, bytes) = materialize_cold_shard(
		input.database_branch_id,
		input.job_id,
		shard_input.shard_id,
		shard_input.as_of_txid,
		ltx.header.min_txid,
		ltx.header.max_txid,
		input.input_range.min_versionstamp,
		input.input_range.max_versionstamp,
		input.base_lifecycle_generation,
		root.manifest_generation.saturating_add(1),
		bytes,
	)
	.context("materialize immutable cold shard object")?;
	ensure!(
		bytes.len() <= CMP_COLD_OBJECT_MAX_BYTES,
		"cold shard object exceeded the workflow object limit"
	);
	let intent_key = keys::branch_compaction_cold_upload_intent_key(
		input.database_branch_id,
		input.job_id,
		reference.shard_id,
		reference.as_of_txid,
	);
	if let Some(existing) = tx_get_value(tx, &intent_key, Serializable).await? {
		let intent = decode_cold_upload_intent(&existing)
			.context("decode existing sqlite cold upload intent")?;
		if intent.reference != reference || intent.delete_authorization.is_some() {
			return Ok(PreparedColdShardUpload::Output(rejected_cold_status(
				"cold upload intent changed or cleanup was already issued",
			)));
		}
	} else {
		tx.informal().set(
			&intent_key,
			&encode_cold_upload_intent(ColdUploadIntent {
				reference: reference.clone(),
				delete_authorization: None,
			})
			.context("encode sqlite cold upload intent")?,
		);
	}
	// One idempotent row per cold job gives operations a bounded backlog index. It is written in
	// the same FDB transaction as every intent, so the index can never under-report an upload that
	// still needs publish or exact orphan cleanup.
	tx.informal().set(
		&keys::branch_cold_upload_job_queue_key(input.database_branch_id, input.job_id),
		&[],
	);
	Ok(PreparedColdShardUpload::Ready(ColdUploadObject {
		reference,
		bytes,
	}))
}

fn rejected_cold_status(reason: impl Into<String>) -> CompactionJobStatus {
	CompactionJobStatus::Rejected {
		reason: reason.into(),
	}
}

fn retryable_cold_status(reason: impl Into<String>) -> CompactionJobStatus {
	CompactionJobStatus::Retryable {
		reason: reason.into(),
	}
}

fn rejected_cold_upload_output(reason: impl Into<String>) -> UploadColdJobOutput {
	UploadColdJobOutput {
		status: CompactionJobStatus::Rejected {
			reason: reason.into(),
		},
		output_summary: ColdStageSummary::default(),
	}
}

#[derive(Debug)]
struct ColdUploadCleanupPlan {
	references: Vec<ColdShardRef>,
	has_more: bool,
}

/// Clean one bounded page of a failed/stale cold job. Every candidate comes from the durable
/// job-local intent index. No COS LIST and no branch-wide cold-ref scan is used.
#[activity(CleanupColdUploadJob)]
pub async fn cleanup_cold_upload_job(
	ctx: &ActivityCtx,
	input: &CleanupColdUploadJobInput,
) -> Result<CleanupColdUploadJobOutput> {
	let now_ms = ctx.ts();
	let input_for_plan = input.clone();
	let planned = ctx
		.udb()?
		.txn("depot_cold_cleanup_plan", move |tx| {
			let input = input_for_plan.clone();
			async move {
				tx.priority(Priority::Low)?;
				plan_cold_upload_cleanup_tx(&tx, &input, now_ms).await
			}
		})
		.await?;
	let plan = match planned {
		Ok(plan) => plan,
		Err(reason) => return Ok(rejected_cold_upload_cleanup(reason)),
	};
	if plan.references.is_empty() {
		return Ok(CleanupColdUploadJobOutput {
			status: CompactionJobStatus::Succeeded,
			deleted_object_count: 0,
			has_more: plan.has_more,
		});
	}
	let Some(cold_tier) = cold_tier_from_config(ctx.config()).await? else {
		return Ok(rejected_cold_upload_cleanup("cold storage is disabled"));
	};
	let udb = ctx.udb()?;
	let policy = crate::cold_tier::read_cold_gc_policy(&udb).await?;
	let object_keys = plan
		.references
		.iter()
		.map(|reference| reference.object_key.clone())
		.collect::<Vec<_>>();
	if let Err(error) =
		crate::cold_tier::delete::delete_objects_with_policy(cold_tier, &object_keys, &policy.spec)
			.await
	{
		tracing::warn!(
			?input.database_branch_id,
			?input.job_id,
			object_count = object_keys.len(),
			?error,
			"exact-key deletion of orphan sqlite cold objects failed"
		);
		return Ok(CleanupColdUploadJobOutput {
			status: CompactionJobStatus::Failed {
				error: format!("orphan cold object delete failed: {error}"),
			},
			deleted_object_count: 0,
			has_more: true,
		});
	}

	let input_for_complete = input.clone();
	let references = plan.references.clone();
	ctx.udb()?
		.txn("depot_cold_cleanup_complete", move |tx| {
			let input = input_for_complete.clone();
			let references = references.clone();
			async move {
				tx.priority(Priority::Low)?;
				complete_cold_upload_cleanup_tx(&tx, &input, &references, now_ms).await
			}
		})
		.await?;

	Ok(CleanupColdUploadJobOutput {
		status: CompactionJobStatus::Succeeded,
		deleted_object_count: u32::try_from(plan.references.len()).unwrap_or(u32::MAX),
		has_more: plan.has_more,
	})
}

async fn plan_cold_upload_cleanup_tx(
	tx: &universaldb::Transaction,
	input: &CleanupColdUploadJobInput,
	now_ms: i64,
) -> Result<std::result::Result<ColdUploadCleanupPlan, String>> {
	// Failed, never-published uploads are not recovery roots. They are always cleaned, including
	// while retired-object GC is disabled or in dry-run, but share the same bounded I/O tuning.
	let policy = crate::cold_tier::policy::read_cold_gc_policy_tx(tx).await?;
	let batch_limit = usize::from(policy.spec.max_objects_per_batch);
	let prefix = keys::branch_compaction_cold_upload_intent_job_prefix(
		input.database_branch_id,
		input.job_id,
	);
	let rows = tx_scan_range_values_limited(
		tx,
		&prefix,
		&end_of_prefix_range(&prefix),
		batch_limit.saturating_add(1),
		Serializable,
	)
	.await?;
	let has_more = rows.len() > batch_limit;
	if rows.is_empty() {
		tx.informal().clear(&keys::branch_cold_upload_job_queue_key(
			input.database_branch_id,
			input.job_id,
		));
	}
	let mut clear_intents = Vec::new();
	let mut delete_intents = Vec::new();

	for (intent_key, encoded_intent) in rows.into_iter().take(batch_limit) {
		let (shard_id, as_of_txid) = keys::decode_branch_compaction_cold_upload_intent_key(
			input.database_branch_id,
			input.job_id,
			&intent_key,
		)?;
		let intent = decode_cold_upload_intent(&encoded_intent)
			.context("decode sqlite cold upload intent during cleanup")?;
		let reference = &intent.reference;
		if reference.database_branch_id != input.database_branch_id
			|| reference.object_generation_id != input.job_id
			|| reference.shard_id != shard_id
			|| reference.as_of_txid != as_of_txid
		{
			return Ok(Err("cold upload intent identity changed".to_string()));
		}
		if let Err(error) = crate::cold_tier::validate_cold_shard_object_key(
			&reference.object_key,
			reference.database_branch_id,
			reference.object_generation_id,
			reference.shard_id,
			reference.as_of_txid,
			reference.content_hash,
		) {
			return Ok(Err(format!(
				"cold upload intent has a noncanonical object key: {error}"
			)));
		}

		let marker = tx_get_value(
			tx,
			&keys::branch_compaction_cold_publish_key(
				input.database_branch_id,
				reference.publish_generation,
			),
			Serializable,
		)
		.await?
		.as_deref()
		.map(decode_cold_publish_marker)
		.transpose()
		.context("decode cold publication marker during orphan cleanup")?;
		if marker
			.as_ref()
			.is_some_and(|marker| marker.matches_ref(reference))
		{
			clear_intents.push(intent_key);
			continue;
		}
		if marker
			.as_ref()
			.is_some_and(|marker| marker.object_generation_id == input.job_id)
		{
			return Ok(Err(
				"cold upload marker for this job does not match its intent".to_string(),
			));
		}

		let retired_key = keys::branch_compaction_retired_cold_object_key(
			input.database_branch_id,
			content_hash(reference.object_key.as_bytes()),
		);
		if let Some(encoded_retired) = tx_get_value(tx, &retired_key, Serializable).await? {
			let retired = decode_retired_cold_object(&encoded_retired)
				.context("decode retired cold object during orphan cleanup")?;
			if retired.database_branch_id != input.database_branch_id
				|| retired.object_key != reference.object_key
				|| retired.object_generation_id != reference.object_generation_id
				|| retired.content_hash != reference.content_hash
				|| retired.shard_id != reference.shard_id
				|| retired.as_of_txid != reference.as_of_txid
				|| retired.publish_generation != reference.publish_generation
			{
				return Ok(Err(
					"cold upload intent conflicts with a different retirement tombstone"
						.to_string(),
				));
			}
			// The retirement lane owns the exact delete and its grace/PITR proof.
			clear_intents.push(intent_key);
			continue;
		}

		let live_key = keys::branch_compaction_cold_shard_key(
			input.database_branch_id,
			reference.shard_id,
			reference.as_of_txid,
		);
		let clear_live_ref = match tx_get_value(tx, &live_key, Serializable).await? {
			Some(encoded_live_ref) => {
				let live_ref = decode_cold_shard_ref(&encoded_live_ref)
					.context("decode exact cold ref during orphan cleanup")?;
				live_ref == *reference
			}
			None => false,
		};
		delete_intents.push((intent_key, intent, live_key, clear_live_ref));
	}

	for intent_key in clear_intents {
		tx.informal().clear(&intent_key);
	}
	let mut references = Vec::with_capacity(delete_intents.len());
	for (intent_key, mut intent, live_key, clear_live_ref) in delete_intents {
		if clear_live_ref {
			tx.informal().clear(&live_key);
		}
		let first_issue = intent.delete_authorization.is_none();
		if first_issue {
			intent.delete_authorization =
				Some(crate::types::ColdDeleteAuthorization::unpublished_upload_cleanup(now_ms));
		}
		tx.informal().set(
			&intent_key,
			&encode_cold_upload_intent(intent.clone())
				.context("encode delete-issued sqlite cold upload intent")?,
		);
		if first_issue {
			crate::cold_tier::accounting::apply_delta_for_branch(
				tx,
				input.database_branch_id,
				crate::cold_tier::accounting::ColdStorageAccountingDelta {
					delete_issued_bytes: crate::cold_tier::accounting::checked_bytes(
						intent.reference.size_bytes,
					)?,
					delete_issued_objects: 1,
					orphan_bytes: crate::cold_tier::accounting::checked_bytes(
						intent.reference.size_bytes,
					)?,
					orphan_objects: 1,
					..Default::default()
				},
			);
		}
		references.push(intent.reference);
	}
	if !has_more && references.is_empty() {
		tx.informal().clear(&keys::branch_cold_upload_job_queue_key(
			input.database_branch_id,
			input.job_id,
		));
	}
	Ok(Ok(ColdUploadCleanupPlan {
		references,
		has_more,
	}))
}

async fn complete_cold_upload_cleanup_tx(
	tx: &universaldb::Transaction,
	input: &CleanupColdUploadJobInput,
	references: &[ColdShardRef],
	completed_at_ms: i64,
) -> Result<()> {
	ensure!(
		references.len() <= CMP_COLD_DELETE_MAX_OBJECTS,
		"cold upload cleanup completion exceeded the exact-delete limit"
	);
	for reference in references {
		let intent_key = keys::branch_compaction_cold_upload_intent_key(
			input.database_branch_id,
			input.job_id,
			reference.shard_id,
			reference.as_of_txid,
		);
		let Some(encoded_intent) = tx_get_value(tx, &intent_key, Serializable).await? else {
			// Idempotent replay after the delete and completion transaction committed.
			continue;
		};
		let intent = decode_cold_upload_intent(&encoded_intent)
			.context("decode delete-issued sqlite cold upload intent")?;
		ensure!(
			intent.delete_authorization.is_some() && intent.reference == *reference,
			"cold upload intent changed after exact object delete"
		);
		crate::cold_tier::audit::write_completed_delete_receipt_tx(
			tx,
			crate::types::ColdDeleteReceipt {
				object_key: reference.object_key.clone(),
				database_branch_id: reference.database_branch_id,
				object_generation_id: reference.object_generation_id,
				shard_id: reference.shard_id,
				as_of_txid: reference.as_of_txid,
				content_hash: reference.content_hash,
				size_bytes: reference.size_bytes,
				authorization: intent
					.delete_authorization
					.clone()
					.expect("checked orphan delete authorization"),
				completed_at_ms,
			},
		)
		.await?;
		let size_bytes = crate::cold_tier::accounting::checked_bytes(reference.size_bytes)?;
		crate::cold_tier::accounting::apply_delta_for_branch(
			tx,
			input.database_branch_id,
			crate::cold_tier::accounting::ColdStorageAccountingDelta {
				delete_issued_bytes: size_bytes.saturating_neg(),
				delete_issued_objects: -1,
				orphan_bytes: size_bytes.saturating_neg(),
				orphan_objects: -1,
				deleted_bytes_total: size_bytes,
				deleted_objects_total: 1,
				..Default::default()
			},
		);
		tx.informal().clear(&intent_key);
	}
	let intent_prefix = keys::branch_compaction_cold_upload_intent_job_prefix(
		input.database_branch_id,
		input.job_id,
	);
	if tx_scan_range_values_limited(
		tx,
		&intent_prefix,
		&end_of_prefix_range(&intent_prefix),
		1,
		Serializable,
	)
	.await?
	.is_empty()
	{
		tx.informal().clear(&keys::branch_cold_upload_job_queue_key(
			input.database_branch_id,
			input.job_id,
		));
	}
	Ok(())
}

fn rejected_cold_upload_cleanup(reason: impl Into<String>) -> CleanupColdUploadJobOutput {
	CleanupColdUploadJobOutput {
		status: CompactionJobStatus::Rejected {
			reason: reason.into(),
		},
		deleted_object_count: 0,
		has_more: false,
	}
}

#[activity(PublishColdJob)]
#[admission = crate::admission::compaction(ctx)]
pub async fn publish_cold_job(
	ctx: &ActivityCtx,
	input: &PublishColdJobInput,
) -> Result<PublishColdJobOutput> {
	let activity = crate::metrics::CompactionActivityGuard::new(
		"cold_publish",
		usize::try_from(input.output_summary.output_ref_count).unwrap_or(usize::MAX),
		input.input_range.max_bytes,
	);
	let result = publish_cold_job_inner(ctx, input).await;
	let (result_label, objects, bytes) = match &result {
		Ok(output) => {
			let result_label = crate::metrics::compaction_status_label(&output.status);
			let succeeded = matches!(output.status, CompactionJobStatus::Succeeded);
			(
				result_label,
				u64::from(output.output_summary.output_ref_count),
				if succeeded {
					input.input_range.max_bytes
				} else {
					0
				},
			)
		}
		Err(_) => ("error", 0, 0),
	};
	activity.finish(result_label, objects, bytes);
	result
}

async fn publish_cold_job_inner(
	ctx: &ActivityCtx,
	input: &PublishColdJobInput,
) -> Result<PublishColdJobOutput> {
	if input.job_kind != CompactionJobKind::Cold {
		return Ok(rejected_cold_publish("manager received a non-cold job"));
	}
	let Some(cold_tier) = cold_tier_from_config(ctx.config()).await? else {
		return Ok(rejected_cold_publish("cold storage is disabled"));
	};
	let input_for_read = input.clone();
	let read_started = Instant::now();
	let staged_refs_result = ctx
		.udb()?
		.txn("depot_cold_compact_read_staged_refs", move |tx| {
			let input = input_for_read.clone();
			async move {
				tx.priority(Priority::Low)?;
				validate_cold_publish_inputs_tx(&tx, &input).await
			}
		})
		.await;
	crate::metrics::observe_compaction_phase(
		"cold_publish",
		"read_staged_refs_fdb",
		read_started,
		if staged_refs_result.is_ok() {
			"succeeded"
		} else {
			"error"
		},
	);
	let staged_refs = staged_refs_result?;
	let staged_refs = match staged_refs {
		Ok(ValidatedColdPublishInputs::AlreadyPublished) => {
			return Ok(PublishColdJobOutput {
				status: CompactionJobStatus::Succeeded,
				output_summary: input.output_summary,
			});
		}
		Ok(ValidatedColdPublishInputs::Pending(staged_refs)) => staged_refs,
		Err(reason) => return Ok(rejected_cold_publish(reason)),
	};

	// Exact GET each immutable object before publication. No LIST operation participates in
	// correctness, and missing/corrupt objects fail closed before an FDB ref can become visible.
	for reference in &staged_refs {
		if reference.database_branch_id != input.database_branch_id
			|| reference.object_generation_id != input.job_id
			|| reference.lifecycle_generation != input.base_lifecycle_generation
			|| reference.publish_generation != input.base_manifest_generation.saturating_add(1)
		{
			return Ok(rejected_cold_publish("cold output ref identity changed"));
		}
	}
	let verify_started = Instant::now();
	let verified = futures_util::stream::iter(staged_refs.iter().cloned())
		.map(|reference| {
			let cold_tier = cold_tier.clone();
			async move {
				if let Err(err) = crate::cold_tier::validate_cold_shard_ref_key(&reference) {
					return Err(PublishColdJobOutput {
						status: CompactionJobStatus::Failed {
							error: format!("refusing noncanonical cold object verification: {err}"),
						},
						output_summary: ColdStageSummary::default(),
					});
				}
				let bytes = match cold_tier.get_object(&reference.object_key).await {
					Ok(bytes) => bytes,
					Err(err) => {
						return Err(PublishColdJobOutput {
							status: CompactionJobStatus::Failed {
								error: format!("cold object verification failed: {err}"),
							},
							output_summary: ColdStageSummary::default(),
						});
					}
				};
				crate::cold_tier::validate_cold_shard_object(&reference, &bytes).map_err(
					|err| PublishColdJobOutput {
						status: CompactionJobStatus::Failed {
							error: format!("cold object verification failed: {err}"),
						},
						output_summary: ColdStageSummary::default(),
					},
				)?;
				Ok::<_, PublishColdJobOutput>(())
			}
		})
		.buffer_unordered(COLD_IO_CONCURRENCY)
		.collect::<Vec<_>>()
		.await;
	let verification_error = verified.into_iter().find_map(Result::err);
	crate::metrics::observe_compaction_phase(
		"cold_publish",
		"verify_objects",
		verify_started,
		if verification_error.is_none() {
			"succeeded"
		} else {
			"failed"
		},
	);
	if let Some(output) = verification_error {
		return Ok(output);
	}

	let input_for_publish = input.clone();
	let publish_started = Instant::now();
	let output_result = ctx
		.udb()?
		.txn("depot_cold_compact_publish", move |tx| {
			let input = input_for_publish.clone();
			async move {
				tx.priority(Priority::Low)?;
				publish_cold_job_tx(&tx, &input).await
			}
		})
		.await;
	crate::metrics::observe_compaction_phase(
		"cold_publish",
		"publish_marker_fdb",
		publish_started,
		if output_result.is_ok() {
			"succeeded"
		} else {
			"error"
		},
	);
	let output = output_result?;
	#[cfg(feature = "test-faults")]
	test_hooks::maybe_fire_cold_compaction_fault(
		input.database_branch_id,
		ColdCompactionFaultPoint::PublishAfterFdbCommit,
	)
	.await?;
	Ok(output)
}

async fn publish_cold_job_tx(
	tx: &universaldb::Transaction,
	input: &PublishColdJobInput,
) -> Result<PublishColdJobOutput> {
	let staged_refs = match validate_cold_publish_inputs_tx(tx, input).await? {
		Ok(ValidatedColdPublishInputs::AlreadyPublished) => {
			return Ok(PublishColdJobOutput {
				status: CompactionJobStatus::Succeeded,
				output_summary: input.output_summary,
			});
		}
		Ok(ValidatedColdPublishInputs::Pending(staged_refs)) => staged_refs,
		Err(reason) => return Ok(rejected_cold_publish(reason)),
	};
	let root = read_compaction_root(tx, input.database_branch_id, Serializable).await?;
	let publish_generation = root.manifest_generation.saturating_add(1);
	let published_bytes = staged_refs.iter().try_fold(0_i64, |total, reference| {
		total
			.checked_add(crate::cold_tier::accounting::checked_bytes(
				reference.size_bytes,
			)?)
			.context("cold publish accounting bytes overflowed")
	})?;
	let published_objects = crate::cold_tier::accounting::checked_objects(staged_refs.len())?;
	let marker = ColdPublishMarker {
		database_branch_id: input.database_branch_id,
		object_generation_id: input.job_id,
		lifecycle_generation: input.base_lifecycle_generation,
		publish_generation,
		input_fingerprint: input.input_fingerprint,
		output_ref_count: input.output_summary.output_ref_count,
		output_refs_hash: input.output_summary.output_refs_hash,
		min_txid: input.input_range.txids.min_txid,
		max_txid: input.input_range.txids.max_txid,
		min_versionstamp: input.input_range.min_versionstamp,
		max_versionstamp: input.input_range.max_versionstamp,
	};

	// Refs were written in bounded transactions but remain invisible without this marker. The
	// marker and root watermark are only two small writes and become visible atomically.
	tx.informal().set(
		&keys::branch_compaction_cold_publish_key(input.database_branch_id, publish_generation),
		&encode_cold_publish_marker(marker)
			.context("encode sqlite cold publish generation marker")?,
	);
	tx.informal().set(
		&keys::branch_compaction_cold_publish_refcount_key(
			input.database_branch_id,
			publish_generation,
		),
		&i64::from(input.output_summary.output_ref_count).to_le_bytes(),
	);
	let intent_prefix = keys::branch_compaction_cold_upload_intent_job_prefix(
		input.database_branch_id,
		input.job_id,
	);
	tx.informal()
		.clear_range(&intent_prefix, &end_of_prefix_range(&intent_prefix));
	tx.informal().clear(&keys::branch_cold_upload_job_queue_key(
		input.database_branch_id,
		input.job_id,
	));
	crate::cold_tier::accounting::apply_delta_for_branch(
		tx,
		input.database_branch_id,
		crate::cold_tier::accounting::ColdStorageAccountingDelta {
			live_bytes: published_bytes,
			live_objects: published_objects,
			..Default::default()
		},
	);
	let next_root = CompactionRoot {
		schema_version: root.schema_version,
		manifest_generation: publish_generation,
		hot_watermark_txid: root.hot_watermark_txid,
		cold_watermark_txid: input.input_range.txids.max_txid,
		cold_watermark_versionstamp: input.input_range.max_versionstamp,
	};
	tx.informal().set(
		&keys::branch_compaction_root_key(input.database_branch_id),
		&encode_compaction_root(next_root)
			.context("encode sqlite compaction root for cold publish")?,
	);
	// Once a later root generation is about to commit, any response-loss replay for the previous
	// hot publication has already been observed by the serial per-database manager. Retain only
	// the newest hot idempotency marker instead of one row for the lifetime of the database.
	tx.informal()
		.clear(&keys::branch_compaction_hot_publish_key(
			input.database_branch_id,
			root.manifest_generation,
		));
	// The exact generation was re-read serializably above and is now represented by immutable
	// cold refs behind the marker. Remove the bounded hot backlog index in the same transaction so
	// long-lived databases do not accumulate one planning row per hot pass.
	tx.informal()
		.clear(&keys::branch_compaction_hot_generation_key(
			input.database_branch_id,
			input.input_range.txids.max_txid,
		));

	Ok(PublishColdJobOutput {
		status: CompactionJobStatus::Succeeded,
		output_summary: summarize_cold_output_refs(&staged_refs)?,
	})
}

enum ValidatedColdPublishInputs {
	Pending(Vec<ColdShardRef>),
	AlreadyPublished,
}

async fn validate_cold_publish_inputs_tx(
	tx: &universaldb::Transaction,
	input: &PublishColdJobInput,
) -> Result<std::result::Result<ValidatedColdPublishInputs, String>> {
	if cold_publish_was_already_applied(tx, input).await? {
		return Ok(Ok(ValidatedColdPublishInputs::AlreadyPublished));
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
	.context("decode sqlite database branch record for cold publish")?;
	if !branch_record_is_live_at_generation(branch_record.as_ref(), input.base_lifecycle_generation)
	{
		return Ok(Err("database branch lifecycle changed".to_string()));
	}

	let root = read_compaction_root(tx, input.database_branch_id, Serializable).await?;
	if root.manifest_generation != input.base_manifest_generation {
		return Ok(Err("base manifest generation changed".to_string()));
	}
	if tx_get_value(
		tx,
		&keys::branch_compaction_cold_publish_key(
			input.database_branch_id,
			input.base_manifest_generation.saturating_add(1),
		),
		Serializable,
	)
	.await?
	.is_some()
	{
		return Ok(Err(
			"cold publish generation marker already exists with different proof".to_string(),
		));
	}
	let cold_inputs =
		read_cold_input_snapshot(tx, input.database_branch_id, &root, Serializable).await?;
	if cold_inputs.selected_min_txid != Some(input.input_range.txids.min_txid)
		|| cold_inputs.selected_max_txid != Some(input.input_range.txids.max_txid)
		|| cold_inputs.min_versionstamp != input.input_range.min_versionstamp
		|| cold_inputs.max_versionstamp != input.input_range.max_versionstamp
		|| summarize_cold_input_refs(&cold_inputs.shard_inputs) != input.input_range.input_summary
		|| cold_inputs.total_value_bytes != input.input_range.max_bytes
		|| fingerprint_cold_inputs(input.database_branch_id, &root, &cold_inputs)
			!= input.input_fingerprint
	{
		return Ok(Err("cold compaction input changed".to_string()));
	}

	let publish_generation = input.base_manifest_generation.saturating_add(1);
	let mut expected = Vec::with_capacity(cold_inputs.shard_inputs.len());
	let mut seen = BTreeSet::new();
	for shard_input in &cold_inputs.shard_inputs {
		let key = keys::branch_compaction_cold_shard_key(
			input.database_branch_id,
			shard_input.shard_id,
			shard_input.as_of_txid,
		);
		let Some(encoded_ref) = tx_get_value(tx, &key, Serializable).await? else {
			return Ok(Err("staged cold shard ref is missing".to_string()));
		};
		let reference = decode_cold_shard_ref(&encoded_ref)
			.context("decode staged cold shard ref for atomic publish")?;
		if reference.database_branch_id != input.database_branch_id
			|| reference.object_generation_id != input.job_id
			|| reference.lifecycle_generation != input.base_lifecycle_generation
			|| reference.publish_generation != publish_generation
			|| reference.shard_id != shard_input.shard_id
			|| reference.as_of_txid != shard_input.as_of_txid
			|| reference.max_txid != shard_input.as_of_txid
			|| reference.min_versionstamp != input.input_range.min_versionstamp
			|| reference.max_versionstamp != input.input_range.max_versionstamp
			|| reference.ltx_size_bytes != shard_input.size_bytes
			|| reference.ltx_content_hash != shard_input.content_hash
		{
			return Ok(Err("staged cold shard ref identity changed".to_string()));
		}
		if !seen.insert((reference.shard_id, reference.as_of_txid)) {
			return Ok(Err("duplicate cold shard output ref".to_string()));
		}
		if tx_get_value(
			tx,
			&keys::branch_compaction_retired_cold_object_key(
				input.database_branch_id,
				content_hash(reference.object_key.as_bytes()),
			),
			Serializable,
		)
		.await?
		.is_some()
		{
			return Ok(Err("cold object was already retired".to_string()));
		}
		expected.push(reference);
	}
	if summarize_cold_output_refs(&expected)? != input.output_summary {
		return Ok(Err(
			"cold output summary does not match the staged refs".to_string()
		));
	}

	Ok(Ok(ValidatedColdPublishInputs::Pending(expected)))
}

async fn cold_publish_was_already_applied(
	tx: &universaldb::Transaction,
	input: &PublishColdJobInput,
) -> Result<bool> {
	let publish_generation = input.base_manifest_generation.saturating_add(1);
	let Some(marker) = tx_get_value(
		tx,
		&keys::branch_compaction_cold_publish_key(input.database_branch_id, publish_generation),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_cold_publish_marker)
	.transpose()
	.context("decode idempotent sqlite cold publish marker")?
	else {
		return Ok(false);
	};
	if !cold_publish_marker_matches_input(&marker, input) {
		return Ok(false);
	}

	let root = read_compaction_root(tx, input.database_branch_id, Serializable).await?;
	ensure!(
		root.manifest_generation >= publish_generation
			&& root.cold_watermark_txid >= input.input_range.txids.max_txid
			&& root.cold_watermark_versionstamp >= input.input_range.max_versionstamp,
		"cold publish marker exists without its atomic root update"
	);
	Ok(true)
}

fn cold_publish_marker_matches_input(
	marker: &ColdPublishMarker,
	input: &PublishColdJobInput,
) -> bool {
	marker.database_branch_id == input.database_branch_id
		&& marker.object_generation_id == input.job_id
		&& marker.lifecycle_generation == input.base_lifecycle_generation
		&& marker.publish_generation == input.base_manifest_generation.saturating_add(1)
		&& marker.input_fingerprint == input.input_fingerprint
		&& marker.output_ref_count == input.output_summary.output_ref_count
		&& marker.output_refs_hash == input.output_summary.output_refs_hash
		&& marker.min_txid == input.input_range.txids.min_txid
		&& marker.max_txid == input.input_range.txids.max_txid
		&& marker.min_versionstamp == input.input_range.min_versionstamp
		&& marker.max_versionstamp == input.input_range.max_versionstamp
}

async fn read_compaction_root(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
	isolation_level: universaldb::utils::IsolationLevel,
) -> Result<CompactionRoot> {
	Ok(tx_get_value(
		tx,
		&keys::branch_compaction_root_key(database_branch_id),
		isolation_level,
	)
	.await?
	.as_deref()
	.map(decode_compaction_root)
	.transpose()
	.context("decode sqlite compaction root for cold compaction")?
	.unwrap_or(CompactionRoot {
		schema_version: 1,
		manifest_generation: 0,
		hot_watermark_txid: 0,
		cold_watermark_txid: 0,
		cold_watermark_versionstamp: [0; 16],
	}))
}

fn rejected_cold_publish(reason: impl Into<String>) -> PublishColdJobOutput {
	PublishColdJobOutput {
		status: CompactionJobStatus::Rejected {
			reason: reason.into(),
		},
		output_summary: ColdStageSummary::default(),
	}
}
