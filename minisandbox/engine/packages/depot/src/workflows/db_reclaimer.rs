use futures_util::StreamExt;
use std::time::Instant;
use universaldb::prelude::*;

use crate::{
	compaction::{
		companion::{CompanionKind, run_companion_loop},
		shared::*,
		*,
	},
	workflows::db_manager::branch_record_is_live_at_generation,
};
use universaldb::prelude::Priority;

use crate::compaction::test_hooks;
#[cfg(feature = "test-faults")]
use crate::fault::ReclaimFaultPoint;

#[workflow(DbReclaimerWorkflow)]
pub async fn depot_db_reclaimer(ctx: &mut WorkflowCtx, input: &DbReclaimerInput) -> Result<()> {
	run_companion_loop(ctx, input.database_branch_id, CompanionKind::Reclaim).await
}

#[activity(ReclaimFdbJob)]
pub async fn reclaim_fdb_job(
	ctx: &ActivityCtx,
	input: &ReclaimFdbJobInput,
) -> Result<ReclaimFdbJobOutput> {
	let _admission = crate::admission::acquire(
		crate::admission::ActivityClass::Compaction,
		ctx.config().runtime.depot_compaction_max_concurrency(),
	)
	.await?;
	let backlog_items = input
		.input_range
		.txid_refs
		.len()
		.saturating_add(input.input_range.hot_shard_evictions.len())
		.saturating_add(input.input_range.staged_hot_shards.len());
	let activity = crate::metrics::CompactionActivityGuard::new(
		"reclaim_fdb",
		backlog_items,
		input.input_range.max_bytes,
	);
	let result = reclaim_fdb_job_inner(ctx, input).await;
	let (result_label, items, bytes) = match &result {
		Ok(output) => (
			crate::metrics::compaction_status_label(&output.status),
			output
				.output_refs
				.iter()
				.map(|reference| u64::from(reference.key_count))
				.sum(),
			output
				.output_refs
				.iter()
				.map(|reference| reference.byte_count)
				.sum(),
		),
		Err(_) => ("error", 0, 0),
	};
	activity.finish(result_label, items, bytes);
	result
}

async fn reclaim_fdb_job_inner(
	ctx: &ActivityCtx,
	input: &ReclaimFdbJobInput,
) -> Result<ReclaimFdbJobOutput> {
	#[cfg(feature = "test-faults")]
	test_hooks::record_reclaim_control_for_test(input.database_branch_id, &input.input_range);
	let preflight_started = Instant::now();
	let preflight_result = preflight_hot_shard_evictions(ctx, input).await;
	crate::metrics::observe_compaction_phase(
		"reclaim_fdb",
		"preflight_objects",
		preflight_started,
		if preflight_result.is_ok() {
			"succeeded"
		} else {
			"error"
		},
	);
	if let Some(reason) = preflight_result? {
		return Ok(rejected_reclaim_job(reason));
	}
	let input = input.clone();
	let input_for_tx = input.clone();
	let now_ms = ctx.ts();
	let cold_storage_enabled = ctx.config().sqlite().workflow_cold_storage().is_some();

	let reclaim_started = Instant::now();
	let output_result = ctx
		.udb()?
		.txn("depot_reclaim_fdb", move |tx| {
			let input = input_for_tx.clone();
			async move {
				tx.priority(Priority::Low)?;
				reclaim_fdb_job_tx(&tx, &input, cold_storage_enabled, now_ms).await
			}
		})
		.await;
	crate::metrics::observe_compaction_phase(
		"reclaim_fdb",
		"delete_fdb",
		reclaim_started,
		if output_result.is_ok() {
			"succeeded"
		} else {
			"error"
		},
	);
	let output = output_result?;
	Ok(output)
}

async fn preflight_hot_shard_evictions(
	ctx: &ActivityCtx,
	input: &ReclaimFdbJobInput,
) -> Result<Option<String>> {
	if input.input_range.hot_shard_evictions.is_empty() {
		return Ok(None);
	}
	let Some(cold_tier) = cold_tier_from_config(ctx.config()).await? else {
		return Ok(Some(
			"cold tier is not configured for hot shard eviction".to_string(),
		));
	};
	let branch_id = input.database_branch_id;
	let requested = input.input_range.hot_shard_evictions.clone();
	let references = ctx
		.udb()?
		.txn("depot_reclaim_cold_preflight_refs", move |tx| {
			let requested = requested.clone();
			async move {
				let mut references = Vec::with_capacity(requested.len());
				for eviction in requested {
					let proof_as_of_txid = eviction.cold_proof_as_of_txid();
					let key = keys::branch_compaction_cold_shard_key(
						branch_id,
						eviction.shard_id,
						proof_as_of_txid,
					);
					let Some(encoded_ref) = tx_get_value(&tx, &key, Serializable).await? else {
						return Ok(None);
					};
					if content_hash(&encoded_ref) != eviction.cold_ref_content_hash {
						return Ok(None);
					}
					let reference = decode_cold_shard_ref(&encoded_ref)
						.context("decode cold shard ref for eviction preflight")?;
					let marker_key = keys::branch_compaction_cold_publish_key(
						branch_id,
						reference.publish_generation,
					);
					let marker = tx_get_value(&tx, &marker_key, Serializable)
						.await?
						.as_deref()
						.map(decode_cold_publish_marker)
						.transpose()
						.context("decode cold publish marker for eviction preflight")?;
					if reference.database_branch_id != branch_id
						|| reference.shard_id != eviction.shard_id
						|| reference.as_of_txid != proof_as_of_txid
						|| (proof_as_of_txid == eviction.as_of_txid
							&& (reference.ltx_size_bytes != eviction.size_bytes
								|| reference.ltx_content_hash != eviction.content_hash))
						|| !marker
							.as_ref()
							.is_some_and(|marker| marker.matches_ref(&reference))
					{
						return Ok(None);
					}
					references.push(reference);
				}
				Ok(Some(references))
			}
		})
		.await?;
	let Some(references) = references else {
		return Ok(Some(
			"published cold ref is missing or changed before hot eviction".to_string(),
		));
	};

	let checks = futures_util::stream::iter(references)
		.map(|reference| {
			let cold_tier = cold_tier.clone();
			async move {
				let object_key = reference.object_key.clone();
				crate::cold_tier::validate_cold_shard_ref_key(&reference).map_err(|error| {
					tracing::error!(%object_key, ?error, "refusing noncanonical cold object GET before hot eviction");
					object_key.clone()
				})?;
				let bytes = cold_tier.get_object(&object_key).await.map_err(|error| {
					tracing::error!(%object_key, ?error, "cold object unavailable before hot eviction");
					object_key.clone()
				})?;
				crate::cold_tier::validate_cold_shard_object(&reference, &bytes).map_err(
					|error| {
						tracing::error!(%object_key, ?error, "cold object corrupt before hot eviction");
						object_key
					},
				)?;
				Ok::<(), String>(())
			}
		})
		.buffer_unordered(crate::cold_tier::DEFAULT_MAX_CONCURRENT_REQUESTS)
		.collect::<Vec<_>>()
		.await;
	if let Some(object_key) = checks.into_iter().find_map(Result::err) {
		return Ok(Some(format!(
			"cold object unavailable or corrupt before hot eviction: {object_key}"
		)));
	}

	Ok(None)
}

async fn reclaim_fdb_job_tx(
	tx: &universaldb::Transaction,
	input: &ReclaimFdbJobInput,
	cold_storage_enabled: bool,
	now_ms: i64,
) -> Result<ReclaimFdbJobOutput> {
	if input.job_kind != CompactionJobKind::Reclaim {
		return Ok(rejected_reclaim_job("reclaimer received a non-reclaim job"));
	}
	#[cfg(feature = "test-faults")]
	if let Some(output) = reclaim_fdb_fault_output(
		input.database_branch_id,
		ReclaimFaultPoint::PlanBeforeSnapshot,
	)
	.await?
	{
		return Ok(output);
	}
	if input.input_range.txid_refs.is_empty() && !input.input_range.staged_hot_shards.is_empty() {
		return cleanup_repair_fdb_outputs_tx(tx, input).await;
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
	.context("decode sqlite database branch record for FDB reclaim")?;
	if !branch_record_is_live_at_generation(branch_record.as_ref(), input.base_lifecycle_generation)
	{
		return Ok(rejected_reclaim_job("database branch lifecycle changed"));
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
	.context("decode sqlite compaction root for FDB reclaim")?
	.unwrap_or(CompactionRoot {
		schema_version: 1,
		manifest_generation: 0,
		hot_watermark_txid: 0,
		cold_watermark_txid: 0,
		cold_watermark_versionstamp: [0; 16],
	});
	if root.manifest_generation != input.base_manifest_generation {
		return Ok(rejected_reclaim_job("base manifest generation changed"));
	}

	if resolve_bucket_fork_pins(tx, input.database_branch_id).await? {
		return Ok(rejected_reclaim_job("bucket fork proof is ambiguous"));
	}
	let shard_cache_policy =
		read_effective_shard_cache_policy_for_branch(tx, branch_record.as_ref()).await?;
	let snapshot = read_reclaim_input_snapshot(
		tx,
		input.database_branch_id,
		&root,
		branch_record.as_ref(),
		shard_cache_policy,
		Serializable,
		cold_storage_enabled,
		now_ms,
	)
	.await?;
	if !input.input_range.txid_refs.is_empty() && snapshot.txid_refs != input.input_range.txid_refs
	{
		return Ok(rejected_reclaim_job("reclaim txid set changed"));
	}
	if snapshot
		.hot_shard_evictions
		.iter()
		.map(|candidate| candidate.reference.clone())
		.collect::<Vec<_>>()
		!= input.input_range.hot_shard_evictions
	{
		return Ok(rejected_reclaim_job("hot shard eviction set changed"));
	}
	if !input.input_range.txid_refs.is_empty() {
		if !snapshot.pidx_entries.is_empty() {
			return Ok(rejected_reclaim_job("PIDX still references reclaim txids"));
		}
		if !reclaim_coverage_is_complete(&snapshot) {
			return Ok(rejected_reclaim_job(
				"replacement SHARD coverage is missing",
			));
		}
	}

	let input_fingerprint = fingerprint_reclaim_inputs(input.database_branch_id, &root, &snapshot);
	if input_fingerprint != input.input_fingerprint {
		return Ok(retryable_reclaim_job("reclaim input fingerprint changed"));
	}
	#[cfg(feature = "test-faults")]
	if let Some(output) = reclaim_fdb_fault_output(
		input.database_branch_id,
		ReclaimFaultPoint::PlanAfterSnapshot,
	)
	.await?
	{
		return Ok(output);
	}

	let selected_reclaim_txids = input
		.input_range
		.txid_refs
		.iter()
		.map(|txid_ref| txid_ref.txid)
		.collect::<BTreeSet<_>>();
	let mut key_count = 0_u32;
	let mut byte_count = 0_u64;
	let mut quota_removed_bytes = 0_i64;
	#[cfg(feature = "test-faults")]
	if let Some(output) =
		reclaim_fdb_fault_output(input.database_branch_id, ReclaimFaultPoint::BeforeHotDelete)
			.await?
	{
		return Ok(output);
	}
	#[cfg(feature = "test-faults")]
	if let Some(output) = reclaim_fdb_fault_output(
		input.database_branch_id,
		ReclaimFaultPoint::BeforeCleanupRows,
	)
	.await?
	{
		return Ok(output);
	}
	for (txid, key, value, commit) in &snapshot.commits {
		if !selected_reclaim_txids.contains(txid) {
			continue;
		}
		udb::compare_and_clear(tx, key, value);
		key_count = key_count.saturating_add(1);
		byte_count = byte_count.saturating_add(u64::try_from(value.len()).unwrap_or(u64::MAX));
		quota_removed_bytes = quota_removed_bytes
			.checked_add(i64::try_from(key.len().saturating_add(value.len()))?)
			.context("sqlite reclaim quota bytes overflowed")?;

		let vtx_key = keys::branch_vtx_key(input.database_branch_id, commit.versionstamp);
		if let Some(vtx_value) = tx_get_value(tx, &vtx_key, Serializable).await? {
			if vtx_value == txid.to_be_bytes() {
				udb::compare_and_clear(tx, &vtx_key, &vtx_value);
				key_count = key_count.saturating_add(1);
				byte_count =
					byte_count.saturating_add(u64::try_from(vtx_value.len()).unwrap_or(u64::MAX));
				quota_removed_bytes = quota_removed_bytes
					.checked_add(i64::try_from(
						vtx_key.len().saturating_add(vtx_value.len()),
					)?)
					.context("sqlite reclaim VTX quota bytes overflowed")?;
			} else {
				return Ok(rejected_reclaim_job("VTX row changed for reclaim txid"));
			}
		}
	}
	for (key, value) in &snapshot.delta_chunks {
		let txid = keys::decode_branch_delta_chunk_txid(input.database_branch_id, key)?;
		if !selected_reclaim_txids.contains(&txid) {
			continue;
		}
		udb::compare_and_clear(tx, key, value);
		key_count = key_count.saturating_add(1);
		byte_count = byte_count.saturating_add(u64::try_from(value.len()).unwrap_or(u64::MAX));
		quota_removed_bytes = quota_removed_bytes
			.checked_add(i64::try_from(key.len().saturating_add(value.len()))?)
			.context("sqlite reclaim DELTA quota bytes overflowed")?;
	}
	for (txid, key, value) in &snapshot.page_history_entries {
		if !selected_reclaim_txids.contains(txid) {
			continue;
		}
		udb::compare_and_clear(tx, key, value);
		key_count = key_count.saturating_add(1);
		byte_count = byte_count.saturating_add(u64::try_from(value.len()).unwrap_or(u64::MAX));
		quota_removed_bytes = quota_removed_bytes
			.checked_add(i64::try_from(key.len().saturating_add(value.len()))?)
			.context("sqlite reclaim page-history quota bytes overflowed")?;
	}
	for (_, key, value, _) in &snapshot.expired_pitr_interval_rows {
		udb::compare_and_clear(tx, key, value);
		key_count = key_count.saturating_add(1);
		byte_count = byte_count.saturating_add(u64::try_from(value.len()).unwrap_or(u64::MAX));
	}
	for key in &snapshot.expired_pitr_interval_index_keys {
		tx.informal().clear(key);
		key_count = key_count.saturating_add(1);
	}
	for candidate in &snapshot.hot_shard_evictions {
		if !input
			.input_range
			.hot_shard_evictions
			.contains(&candidate.reference)
		{
			continue;
		}
		// The serializable snapshot re-read the exact cold ref and verified it still binds the
		// hot LTX hash. Only that exact hot value is removed; concurrent refill/change conflicts.
		crate::conveyer::shard_blob::clear_branch_shard_chunks(
			tx,
			input.database_branch_id,
			candidate.reference.shard_id,
			candidate.reference.as_of_txid,
			&candidate.shard_row_value,
		)?;
		udb::compare_and_clear(tx, &candidate.shard_key, &candidate.shard_row_value);
		key_count = key_count
			.saturating_add(u32::try_from(candidate.physical_row_count).unwrap_or(u32::MAX));
		byte_count = byte_count.saturating_add(candidate.physical_value_bytes);
	}
	#[cfg(feature = "test-faults")]
	if let Some(output) =
		reclaim_fdb_fault_output(input.database_branch_id, ReclaimFaultPoint::AfterHotDelete)
			.await?
	{
		return Ok(output);
	}
	if quota_removed_bytes != 0 {
		quota::atomic_add_branch(
			tx,
			input.database_branch_id,
			quota_removed_bytes
				.checked_neg()
				.context("sqlite reclaim quota delta overflowed")?,
		);
	}

	Ok(ReclaimFdbJobOutput {
		status: CompactionJobStatus::Succeeded,
		output_refs: vec![ReclaimOutputRef {
			key_count,
			byte_count,
			min_txid: input.input_range.txids.min_txid,
			max_txid: input.input_range.txids.max_txid,
		}],
	})
}

#[activity(RetireColdObjects)]
pub async fn retire_cold_objects(
	ctx: &ActivityCtx,
	input: &RetireColdObjectsInput,
) -> Result<RetireColdObjectsOutput> {
	let _admission = crate::admission::acquire(
		crate::admission::ActivityClass::Compaction,
		ctx.config().runtime.depot_compaction_max_concurrency(),
	)
	.await?;
	let input = input.clone();
	let retired_at_ms = ctx.ts();
	let Some(cold_storage) = ctx.config().sqlite().workflow_cold_storage() else {
		return Ok(rejected_cold_object_retire("cold storage is disabled"));
	};
	let configured_recovery_window_ms = i64::try_from(cold_storage.recovery_window_ms())
		.context("sqlite cold recovery window exceeds signed timestamp range")?;
	let udb = ctx.udb()?;
	let policy_grace_ms = i64::try_from(
		crate::cold_tier::read_cold_gc_policy(&udb)
			.await?
			.spec
			.grace_period_ms,
	)
	.context("ColdGcPolicy grace period exceeds signed timestamp range")?;
	let recovery_window_ms = test_hooks::cold_object_delete_grace_ms(
		input.database_branch_id,
		configured_recovery_window_ms.max(policy_grace_ms),
	)
	.max(0);
	ctx.udb()?
		.txn("depot_reclaim_retire_cold", move |tx| {
			let input = input.clone();
			async move {
				tx.priority(Priority::Low)?;
				retire_cold_objects_tx(&tx, &input, retired_at_ms, recovery_window_ms).await
			}
		})
		.await
}

async fn retire_cold_objects_tx(
	tx: &universaldb::Transaction,
	input: &RetireColdObjectsInput,
	retired_at_ms: i64,
	recovery_window_ms: i64,
) -> Result<RetireColdObjectsOutput> {
	if input.job_kind != CompactionJobKind::Reclaim {
		return Ok(rejected_cold_object_retire(
			"reclaimer received a non-reclaim job",
		));
	}
	if input.cold_objects.is_empty() {
		return Ok(RetireColdObjectsOutput {
			status: CompactionJobStatus::Succeeded,
			retired_object_count: 0,
		});
	}
	if input.cold_objects.len() > CMP_COLD_DELETE_MAX_OBJECTS {
		return Ok(rejected_cold_object_retire(
			"cold retirement batch exceeded the exact-delete limit",
		));
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
	.context("decode sqlite database branch record for cold retirement")?;
	if !branch_record_is_live_at_generation(branch_record.as_ref(), input.base_lifecycle_generation)
	{
		return Ok(rejected_cold_object_retire(
			"database branch lifecycle changed",
		));
	}

	let root = read_reclaim_compaction_root(tx, input.database_branch_id, Serializable).await?;
	let retired_manifest_generation = input.base_manifest_generation.saturating_add(1);
	if root.manifest_generation == retired_manifest_generation
		&& cold_retirement_was_already_applied(tx, input, retired_manifest_generation).await?
	{
		return Ok(RetireColdObjectsOutput {
			status: CompactionJobStatus::Succeeded,
			retired_object_count: input.cold_objects.len() as u32,
		});
	}
	if root.manifest_generation != input.base_manifest_generation {
		return Ok(rejected_cold_object_retire(
			"base manifest generation changed",
		));
	}
	if resolve_bucket_fork_pins(tx, input.database_branch_id).await? {
		return Ok(rejected_cold_object_retire(
			"bucket fork proof is ambiguous",
		));
	}

	let delete_after_ms = retired_at_ms.saturating_add(recovery_window_ms);

	let mut validated = Vec::with_capacity(input.cold_objects.len());
	for cold_object in &input.cold_objects {
		let live_key = keys::branch_compaction_cold_shard_key(
			input.database_branch_id,
			cold_object.shard_id,
			cold_object.as_of_txid,
		);
		let Some(live_value) = tx_get_value(tx, &live_key, Serializable).await? else {
			return Ok(rejected_cold_object_retire(
				"cold shard ref is already absent",
			));
		};
		let live_ref = decode_cold_shard_ref(&live_value)
			.context("decode sqlite cold shard ref for retirement")?;
		if reclaim_cold_object_ref(&live_ref) != *cold_object
			|| !cold_ref_has_atomic_publish_marker(tx, input.database_branch_id, &live_ref).await?
		{
			return Ok(rejected_cold_object_retire(
				"cold shard ref changed or is not atomically published",
			));
		}
		let Some(replacement) = next_published_cold_replacement(
			tx,
			input.database_branch_id,
			cold_object.shard_id,
			cold_object.as_of_txid,
		)
		.await?
		else {
			return Ok(rejected_cold_object_retire(
				"newer published cold replacement is missing",
			));
		};
		let retired_key = keys::branch_compaction_retired_cold_object_key(
			input.database_branch_id,
			content_hash(cold_object.object_key.as_bytes()),
		);
		if tx_get_value(tx, &retired_key, Serializable)
			.await?
			.is_some()
		{
			return Ok(rejected_cold_object_retire(
				"cold object is already retired",
			));
		}
		validated.push((
			cold_object.clone(),
			live_key,
			live_value,
			replacement.as_of_txid,
			retired_key,
		));
	}
	let ranges = validated
		.iter()
		.map(|(cold_object, _, _, replacement_txid, _)| (cold_object.as_of_txid, *replacement_txid))
		.collect::<Vec<_>>();
	let Some(protected_pitr_txids) = read_live_pitr_txids_in_ranges(
		tx,
		input.database_branch_id,
		&ranges,
		retired_at_ms,
		Serializable,
	)
	.await?
	else {
		return Ok(rejected_cold_object_retire(
			"PITR protection index is incomplete or exceeded the bounded proof limit",
		));
	};
	let protected_history_pins = history_pin::history_pin_presence_in_ranges(
		tx,
		input.database_branch_id,
		&ranges,
		Serializable,
	)
	.await?;
	// Revalidate the hot/cold ordering in the same serializable transaction that retires the
	// cold refs. Planning already keeps an exact cold ref while its matching hot shard exists,
	// but an active reader may refill that hot key after planning. Reading every exact key here
	// makes such a refill conflict with this transaction; the cold proof can only retire after the
	// matching hot generation is durably absent.
	for ((cold_object, _, _, replacement_txid, _), pin_protected) in
		validated.iter().zip(protected_history_pins.iter().copied())
	{
		if pin_protected
			|| protected_pitr_txids
				.range(cold_object.as_of_txid..*replacement_txid)
				.next()
				.is_some()
		{
			return Ok(rejected_cold_object_retire(
				"cold object is protected by a PITR or fork pin",
			));
		}
		if tx_get_value(
			tx,
			&keys::branch_shard_key(
				input.database_branch_id,
				cold_object.shard_id,
				cold_object.as_of_txid,
			),
			Serializable,
		)
		.await?
		.is_some()
		{
			return Ok(rejected_cold_object_retire(
				"matching hot shard still requires the exact cold eviction proof",
			));
		}
	}
	let mut retiring_by_publish_generation = BTreeMap::<u64, i64>::new();
	for (cold_object, _, _, _, _) in &validated {
		*retiring_by_publish_generation
			.entry(cold_object.publish_generation)
			.or_default() += 1;
	}
	let mut publish_generation_refcounts = BTreeMap::<u64, Option<i64>>::new();
	for publish_generation in retiring_by_publish_generation.keys().copied() {
		let value = tx_get_value(
			tx,
			&keys::branch_compaction_cold_publish_refcount_key(
				input.database_branch_id,
				publish_generation,
			),
			Serializable,
		)
		.await?;
		let count = value
			.map(|value| {
				let bytes: [u8; 8] = value
					.as_slice()
					.try_into()
					.context("cold publication refcount should be exactly 8 bytes")?;
				Ok::<_, anyhow::Error>(i64::from_le_bytes(bytes))
			})
			.transpose()?;
		publish_generation_refcounts.insert(publish_generation, count);
	}

	let retiring_bytes = validated
		.iter()
		.try_fold(0_i64, |total, (cold_object, ..)| {
			total
				.checked_add(crate::cold_tier::accounting::checked_bytes(
					cold_object.size_bytes,
				)?)
				.context("cold retirement accounting bytes overflowed")
		})?;
	let retiring_objects = crate::cold_tier::accounting::checked_objects(validated.len())?;
	for (cold_object, live_key, live_value, _replacement_txid, retired_key) in validated {
		udb::compare_and_clear(tx, &live_key, &live_value);
		// The same pin/PITR proof that makes this cold generation retireable also makes its
		// shard-major hot coverage proof obsolete. Keeping it would make branch metadata grow with
		// every historical generation even after both hot and cold artifacts are unreachable.
		tx.informal()
			.clear(&keys::branch_compaction_hot_shard_coverage_key(
				input.database_branch_id,
				cold_object.shard_id,
				cold_object.as_of_txid,
			));
		let retired = RetiredColdObject {
			database_branch_id: input.database_branch_id,
			object_key: cold_object.object_key.clone(),
			object_generation_id: cold_object.object_generation_id,
			content_hash: cold_object.content_hash,
			size_bytes: cold_object.size_bytes,
			shard_id: cold_object.shard_id,
			as_of_txid: cold_object.as_of_txid,
			publish_generation: cold_object.publish_generation,
			retired_manifest_generation,
			retired_at_ms,
			retired_versionstamp: udb::INCOMPLETE_VERSIONSTAMP,
			delete_after_ms,
			delete_state: RetiredColdObjectDeleteState::Retired,
			delete_authorization: None,
		};
		let encoded_retired =
			encode_retired_cold_object(retired).context("encode sqlite retired cold object")?;
		let versionstamped_retired =
			udb::append_last_versionstamp_offset(encoded_retired, &udb::INCOMPLETE_VERSIONSTAMP)
				.context("prepare versionstamped sqlite retired cold object")?;
		tx.informal().atomic_op(
			&retired_key,
			&versionstamped_retired,
			MutationType::SetVersionstampedValue,
		);
		tx.informal().set(
			&keys::branch_compaction_retired_cold_object_due_key(
				input.database_branch_id,
				delete_after_ms,
				content_hash(cold_object.object_key.as_bytes()),
			),
			&[],
		);
	}
	crate::cold_tier::accounting::apply_delta_for_branch(
		tx,
		input.database_branch_id,
		crate::cold_tier::accounting::ColdStorageAccountingDelta {
			live_bytes: retiring_bytes.saturating_neg(),
			live_objects: retiring_objects.saturating_neg(),
			retired_bytes: retiring_bytes,
			retired_objects: retiring_objects,
			..Default::default()
		},
	);
	for (publish_generation, retiring_count) in retiring_by_publish_generation {
		let count_key = keys::branch_compaction_cold_publish_refcount_key(
			input.database_branch_id,
			publish_generation,
		);
		match publish_generation_refcounts[&publish_generation] {
			Some(live_count) if live_count == retiring_count => {
				// This transaction removed the last authoritative ref for the generation. The marker
				// is no longer on any read path, so retire it atomically with the refs.
				tx.informal().clear(&count_key);
				tx.informal()
					.clear(&keys::branch_compaction_cold_publish_key(
						input.database_branch_id,
						publish_generation,
					));
			}
			Some(live_count) if live_count > retiring_count => {
				tx.informal().atomic_op(
					&count_key,
					&retiring_count.saturating_neg().to_le_bytes(),
					MutationType::Add,
				);
			}
			Some(_) => {
				return Ok(rejected_cold_object_retire(
					"cold publication refcount is smaller than the retirement batch",
				));
			}
			None => {
				return Ok(rejected_cold_object_retire(
					"cold publication refcount is missing",
				));
			}
		}
	}

	tx.informal().set(
		&keys::branch_compaction_root_key(input.database_branch_id),
		&encode_compaction_root(CompactionRoot {
			schema_version: root.schema_version,
			manifest_generation: retired_manifest_generation,
			hot_watermark_txid: root.hot_watermark_txid,
			cold_watermark_txid: root.cold_watermark_txid,
			cold_watermark_versionstamp: root.cold_watermark_versionstamp,
		})
		.context("encode sqlite compaction root for cold retirement")?,
	);
	tx.informal()
		.clear(&keys::branch_compaction_hot_publish_key(
			input.database_branch_id,
			root.manifest_generation,
		));

	Ok(RetireColdObjectsOutput {
		status: CompactionJobStatus::Succeeded,
		retired_object_count: input.cold_objects.len() as u32,
	})
}

async fn cold_retirement_was_already_applied(
	tx: &universaldb::Transaction,
	input: &RetireColdObjectsInput,
	retired_manifest_generation: u64,
) -> Result<bool> {
	for cold_object in &input.cold_objects {
		if tx_get_value(
			tx,
			&keys::branch_compaction_cold_shard_key(
				input.database_branch_id,
				cold_object.shard_id,
				cold_object.as_of_txid,
			),
			Serializable,
		)
		.await?
		.is_some()
		{
			return Ok(false);
		}
		let Some(retired) = tx_get_value(
			tx,
			&keys::branch_compaction_retired_cold_object_key(
				input.database_branch_id,
				content_hash(cold_object.object_key.as_bytes()),
			),
			Serializable,
		)
		.await?
		.as_deref()
		.map(decode_retired_cold_object)
		.transpose()
		.context("decode idempotent sqlite cold retirement row")?
		else {
			return Ok(false);
		};
		if retired.retired_manifest_generation != retired_manifest_generation
			|| !retired_matches_cold_object(&retired, cold_object)
		{
			return Ok(false);
		}
	}
	Ok(true)
}

fn rejected_cold_object_retire(reason: impl Into<String>) -> RetireColdObjectsOutput {
	RetireColdObjectsOutput {
		status: CompactionJobStatus::Rejected {
			reason: reason.into(),
		},
		retired_object_count: 0,
	}
}

#[activity(DeleteRetiredColdObjects)]
pub async fn delete_retired_cold_objects(
	ctx: &ActivityCtx,
	input: &DeleteRetiredColdObjectsInput,
) -> Result<DeleteRetiredColdObjectsOutput> {
	let _admission = crate::admission::acquire(
		crate::admission::ActivityClass::Compaction,
		ctx.config().runtime.depot_compaction_max_concurrency(),
	)
	.await?;
	if input.retired_objects.is_empty() {
		return Ok(DeleteRetiredColdObjectsOutput {
			status: CompactionJobStatus::Succeeded,
			deleted_object_count: 0,
		});
	}
	let Some(cold_tier) = cold_tier_from_config(ctx.config()).await? else {
		return Ok(rejected_cold_object_delete("cold storage is disabled"));
	};
	let input_for_mark = input.clone();
	let now_ms = ctx.ts();
	#[cfg(feature = "test-faults")]
	crate::compaction::test_hooks::maybe_fire_reclaim_fault(
		input.database_branch_id,
		ReclaimFaultPoint::BeforeColdDeleteIssuedCommit,
	)
	.await?;
	let issued = ctx
		.udb()?
		.txn("depot_reclaim_mark_cold_delete_issued", move |tx| {
			let input = input_for_mark.clone();
			async move {
				tx.priority(Priority::Low)?;
				mark_retired_cold_objects_delete_issued_tx(&tx, &input, now_ms).await
			}
		})
		.await?;
	let issued = match issued {
		Ok(issued) => issued,
		Err(reason) => return Ok(rejected_cold_object_delete(reason)),
	};
	#[cfg(feature = "test-faults")]
	crate::compaction::test_hooks::maybe_fire_reclaim_fault(
		input.database_branch_id,
		ReclaimFaultPoint::AfterColdDeleteIssuedCommit,
	)
	.await?;
	let udb = ctx.udb()?;
	let policy = crate::cold_tier::read_cold_gc_policy(&udb).await?;
	if !policy.spec.deletion_enabled || policy.spec.dry_run {
		return Ok(rejected_cold_object_delete(
			"ColdGcPolicy changed after delete issuance",
		));
	}
	if issued.iter().any(|retired| {
		retired
			.delete_authorization
			.as_ref()
			.and_then(|authorization| authorization.policy_revision)
			!= Some(policy.revision)
	}) {
		return Ok(rejected_cold_object_delete(
			"ColdGcPolicy revision changed after delete issuance",
		));
	}
	let object_keys = issued
		.iter()
		.filter(|retired| retired.delete_state != RetiredColdObjectDeleteState::Deleted)
		.map(|retired| retired.object_key.clone())
		.collect::<Vec<_>>();
	if let Err(error) =
		crate::cold_tier::delete::delete_objects_with_policy(cold_tier, &object_keys, &policy.spec)
			.await
	{
		tracing::warn!(
			?input.database_branch_id,
			object_count = object_keys.len(),
			?error,
			"exact-key deletion of retired sqlite cold objects failed"
		);
		return Ok(DeleteRetiredColdObjectsOutput {
			status: CompactionJobStatus::Failed {
				error: format!("retired cold object delete failed: {error}"),
			},
			deleted_object_count: 0,
		});
	}

	let input_for_complete = input.clone();
	ctx.udb()?
		.txn("depot_reclaim_complete_cold_delete", move |tx| {
			let input = input_for_complete.clone();
			async move {
				tx.priority(Priority::Low)?;
				complete_retired_cold_objects_delete_tx(&tx, &input, now_ms).await
			}
		})
		.await
}

async fn mark_retired_cold_objects_delete_issued_tx(
	tx: &universaldb::Transaction,
	input: &DeleteRetiredColdObjectsInput,
	now_ms: i64,
) -> Result<std::result::Result<Vec<RetiredColdObject>, String>> {
	let policy = match crate::cold_tier::policy::require_cold_gc_deletion_tx(tx).await? {
		Ok(policy) => policy,
		Err(reason) => return Ok(Err(reason)),
	};
	if input.retired_objects.len() > usize::from(policy.spec.max_objects_per_batch) {
		return Ok(Err(
			"retired cold delete batch exceeded the ColdGcPolicy limit".to_string(),
		));
	}
	if resolve_bucket_fork_pins(tx, input.database_branch_id).await? {
		return Ok(Err("bucket fork proof is ambiguous".to_string()));
	}
	let mut issued = Vec::with_capacity(input.retired_objects.len());
	let mut validated = Vec::with_capacity(input.retired_objects.len());

	for expected in &input.retired_objects {
		if expected.database_branch_id != input.database_branch_id {
			return Ok(Err(
				"retired cold object belongs to a different database branch".to_string(),
			));
		}
		if let Err(error) = crate::cold_tier::validate_cold_shard_object_key(
			&expected.object_key,
			input.database_branch_id,
			expected.object_generation_id,
			expected.shard_id,
			expected.as_of_txid,
			expected.content_hash,
		) {
			return Ok(Err(format!(
				"retired cold object has a noncanonical object key: {error}"
			)));
		}
		let retired_key = keys::branch_compaction_retired_cold_object_key(
			input.database_branch_id,
			content_hash(expected.object_key.as_bytes()),
		);
		let Some(retired_value) = tx_get_value(tx, &retired_key, Serializable).await? else {
			// A previous retry may have deleted the object and atomically removed its tombstone, but
			// lost the activity response. Exact object deletion is idempotent and an immutable object
			// key can never be republished behind a newer manifest generation.
			let mut completed = expected.clone();
			completed.delete_state = RetiredColdObjectDeleteState::Deleted;
			issued.push(completed);
			continue;
		};
		let retired = decode_retired_cold_object(&retired_value)
			.context("decode sqlite retired cold object before exact delete")?;
		if !same_retired_cold_object_identity(&retired, expected) {
			return Ok(Err("retired cold object row changed".to_string()));
		}
		if retired.delete_state == RetiredColdObjectDeleteState::Deleted {
			issued.push(retired);
			continue;
		}
		let effective_delete_after_ms = crate::cold_tier::policy::effective_delete_after_ms(
			retired.retired_at_ms,
			retired.delete_after_ms,
			policy.spec.grace_period_ms,
		)?;
		if effective_delete_after_ms > now_ms {
			return Ok(Err(
				"retired cold object is still in its grace window".to_string()
			));
		}
		let backup_eligibility = crate::backup_fence::cold_delete_fence_eligibility_tx(
			tx,
			&retired.retired_versionstamp,
			now_ms,
		)
		.await?;
		if backup_eligibility != crate::backup_fence::ColdDeleteFenceEligibility::Eligible {
			return Ok(Err(backup_eligibility
				.rejection_reason()
				.unwrap_or("cold backup recovery fence rejected deletion")
				.to_string()));
		}
		let authorization = match crate::cold_tier::policy::authorize_cold_gc_deletion_tx(
			tx,
			retired.retired_versionstamp,
			now_ms,
			crate::types::ColdDeleteReason::RetiredReplacement,
		)
		.await?
		{
			Ok(authorization) => authorization,
			Err(reason) => return Ok(Err(reason)),
		};
		if tx_get_value(
			tx,
			&keys::branch_compaction_cold_shard_key(
				input.database_branch_id,
				retired.shard_id,
				retired.as_of_txid,
			),
			Serializable,
		)
		.await?
		.is_some()
		{
			return Ok(Err("live cold ref exists for retired object".to_string()));
		}
		let Some(replacement) = next_published_cold_replacement(
			tx,
			input.database_branch_id,
			retired.shard_id,
			retired.as_of_txid,
		)
		.await?
		else {
			return Ok(Err(
				"newer published cold replacement is missing before delete".to_string(),
			));
		};
		validated.push((retired_key, retired, replacement.as_of_txid, authorization));
	}
	let ranges = validated
		.iter()
		.map(|(_, retired, replacement_txid, _)| (retired.as_of_txid, *replacement_txid))
		.collect::<Vec<_>>();
	let Some(protected_pitr_txids) =
		read_live_pitr_txids_in_ranges(tx, input.database_branch_id, &ranges, now_ms, Serializable)
			.await?
	else {
		return Ok(Err(
			"PITR protection index is incomplete or exceeded the bounded proof limit".to_string(),
		));
	};
	let protected_history_pins = history_pin::history_pin_presence_in_ranges(
		tx,
		input.database_branch_id,
		&ranges,
		Serializable,
	)
	.await?;

	for ((retired_key, mut retired, replacement_txid, authorization), pin_protected) in
		validated.into_iter().zip(protected_history_pins)
	{
		if pin_protected
			|| protected_pitr_txids
				.range(retired.as_of_txid..replacement_txid)
				.next()
				.is_some()
		{
			return Ok(Err(
				"retired cold object became protected before delete".to_string()
			));
		}
		let first_issue = retired.delete_state == RetiredColdObjectDeleteState::Retired;
		let authorization_changed = retired.delete_authorization.as_ref() != Some(&authorization);
		if first_issue || authorization_changed {
			let size_bytes = crate::cold_tier::accounting::checked_bytes(retired.size_bytes)?;
			retired.delete_state = RetiredColdObjectDeleteState::DeleteIssued;
			retired.delete_authorization = Some(authorization);
			tx.informal().set(
				&retired_key,
				&encode_retired_cold_object(retired.clone())
					.context("encode delete-issued sqlite cold object")?,
			);
			if first_issue {
				crate::cold_tier::accounting::apply_delta_for_branch(
					tx,
					input.database_branch_id,
					crate::cold_tier::accounting::ColdStorageAccountingDelta {
						retired_bytes: size_bytes.saturating_neg(),
						retired_objects: -1,
						delete_issued_bytes: size_bytes,
						delete_issued_objects: 1,
						..Default::default()
					},
				);
			}
		}
		issued.push(retired);
	}
	Ok(Ok(issued))
}

async fn complete_retired_cold_objects_delete_tx(
	tx: &universaldb::Transaction,
	input: &DeleteRetiredColdObjectsInput,
	now_ms: i64,
) -> Result<DeleteRetiredColdObjectsOutput> {
	let mut completed = 0_u32;
	for expected in &input.retired_objects {
		let retired_key = keys::branch_compaction_retired_cold_object_key(
			input.database_branch_id,
			content_hash(expected.object_key.as_bytes()),
		);
		let Some(retired_value) = tx_get_value(tx, &retired_key, Serializable).await? else {
			// Idempotent response-loss replay after the primary tombstone was compacted.
			tx.informal()
				.clear(&keys::branch_compaction_retired_cold_object_due_key(
					input.database_branch_id,
					expected.delete_after_ms,
					content_hash(expected.object_key.as_bytes()),
				));
			completed = completed.saturating_add(1);
			continue;
		};
		let mut retired = decode_retired_cold_object(&retired_value)
			.context("decode sqlite retired cold object after exact delete")?;
		if !same_retired_cold_object_identity(&retired, expected) {
			return Ok(rejected_cold_object_delete(
				"retired cold object row changed after delete",
			));
		}
		if retired.delete_state == RetiredColdObjectDeleteState::Deleted {
			// This is the second, metadata-only due pass. The exact object delete completed at least
			// one retention window ago, so the durable replay tombstone can now be compacted.
			tx.informal().clear(&retired_key);
			tx.informal()
				.clear(&keys::branch_compaction_retired_cold_object_due_key(
					input.database_branch_id,
					retired.delete_after_ms,
					content_hash(retired.object_key.as_bytes()),
				));
			completed = completed.saturating_add(1);
			continue;
		}
		if retired.delete_state != RetiredColdObjectDeleteState::DeleteIssued {
			return Ok(rejected_cold_object_delete(
				"retired cold object delete was not issued",
			));
		}
		let Some(delete_authorization) = retired.delete_authorization.clone() else {
			return Ok(rejected_cold_object_delete(
				"delete-issued retired object is missing its authorization",
			));
		};
		crate::cold_tier::audit::write_completed_delete_receipt_tx(
			tx,
			crate::types::ColdDeleteReceipt {
				object_key: retired.object_key.clone(),
				database_branch_id: retired.database_branch_id,
				object_generation_id: retired.object_generation_id,
				shard_id: retired.shard_id,
				as_of_txid: retired.as_of_txid,
				content_hash: retired.content_hash,
				size_bytes: retired.size_bytes,
				authorization: delete_authorization,
				completed_at_ms: now_ms,
			},
		)
		.await?;
		let size_bytes = crate::cold_tier::accounting::checked_bytes(retired.size_bytes)?;
		let due_key = keys::branch_compaction_retired_cold_object_due_key(
			input.database_branch_id,
			retired.delete_after_ms,
			content_hash(retired.object_key.as_bytes()),
		);
		// Preserve an explicit completion record across delayed workflow/activity retries, but put
		// it back on the due index so it is not a permanent one-row-per-object leak.
		retired.delete_state = RetiredColdObjectDeleteState::Deleted;
		retired.delete_after_ms = now_ms.saturating_add(crate::CMP_COLD_TOMBSTONE_RETENTION_MS);
		tx.informal().set(
			&retired_key,
			&encode_retired_cold_object(retired.clone())
				.context("encode completed sqlite cold object tombstone")?,
		);
		tx.informal().clear(&due_key);
		tx.informal().set(
			&keys::branch_compaction_retired_cold_object_due_key(
				input.database_branch_id,
				retired.delete_after_ms,
				content_hash(retired.object_key.as_bytes()),
			),
			&[],
		);
		crate::cold_tier::accounting::apply_delta_for_branch(
			tx,
			input.database_branch_id,
			crate::cold_tier::accounting::ColdStorageAccountingDelta {
				delete_issued_bytes: size_bytes.saturating_neg(),
				delete_issued_objects: -1,
				deleted_bytes_total: size_bytes,
				deleted_objects_total: 1,
				..Default::default()
			},
		);
		completed = completed.saturating_add(1);
	}
	Ok(DeleteRetiredColdObjectsOutput {
		status: CompactionJobStatus::Succeeded,
		deleted_object_count: completed,
	})
}

fn rejected_cold_object_delete(reason: impl Into<String>) -> DeleteRetiredColdObjectsOutput {
	DeleteRetiredColdObjectsOutput {
		status: CompactionJobStatus::Rejected {
			reason: reason.into(),
		},
		deleted_object_count: 0,
	}
}

fn same_retired_cold_object_identity(left: &RetiredColdObject, right: &RetiredColdObject) -> bool {
	left.database_branch_id == right.database_branch_id
		&& left.object_key == right.object_key
		&& left.object_generation_id == right.object_generation_id
		&& left.content_hash == right.content_hash
		&& left.size_bytes == right.size_bytes
		&& left.shard_id == right.shard_id
		&& left.as_of_txid == right.as_of_txid
		&& left.publish_generation == right.publish_generation
		&& left.retired_manifest_generation == right.retired_manifest_generation
		&& left.retired_at_ms == right.retired_at_ms
		&& left.retired_versionstamp == right.retired_versionstamp
		&& left.delete_after_ms == right.delete_after_ms
}

async fn read_reclaim_compaction_root(
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
	.context("decode sqlite compaction root for cold object GC")?
	.unwrap_or(CompactionRoot {
		schema_version: 1,
		manifest_generation: 0,
		hot_watermark_txid: 0,
		cold_watermark_txid: 0,
		cold_watermark_versionstamp: [0; 16],
	}))
}

async fn next_published_cold_replacement(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
	shard_id: u32,
	after_txid: u64,
) -> Result<Option<ColdShardRef>> {
	let prefix = keys::branch_compaction_cold_shard_version_prefix(database_branch_id, shard_id);
	let mut start =
		keys::branch_compaction_cold_shard_key(database_branch_id, shard_id, after_txid);
	start.push(0);
	let end = end_of_prefix_range(&prefix);
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Iterator,
			limit: Some(1),
			..(start.as_slice(), end.as_slice()).into()
		},
		Serializable,
	);
	let Some(entry) = stream.next().await else {
		return Ok(None);
	};
	let entry = entry?;
	let reference = decode_cold_shard_ref(entry.value())
		.context("decode exact newer cold replacement for cold object GC")?;
	ensure!(
		reference.database_branch_id == database_branch_id
			&& reference.shard_id == shard_id
			&& reference.as_of_txid > after_txid,
		"newer cold replacement lookup returned a row outside its exact bounds"
	);
	ensure!(
		cold_ref_has_atomic_publish_marker(tx, database_branch_id, &reference).await?,
		"visible cold replacement is missing its atomic publish marker"
	);
	Ok(Some(reference))
}

pub(super) async fn cleanup_repair_fdb_outputs_tx(
	tx: &universaldb::Transaction,
	input: &ReclaimFdbJobInput,
) -> Result<ReclaimFdbJobOutput> {
	let input_fingerprint =
		fingerprint_repair_reclaim_range(input.database_branch_id, &input.input_range);
	if input_fingerprint != input.input_fingerprint {
		return Ok(rejected_reclaim_job(
			"repair cleanup input fingerprint changed",
		));
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
	.context("decode sqlite database branch record for repair cleanup")?;
	if !branch_record_is_live_at_generation(branch_record.as_ref(), input.base_lifecycle_generation)
	{
		return Ok(rejected_reclaim_job("database branch lifecycle changed"));
	}

	let root = tx_get_value(
		tx,
		&keys::branch_compaction_root_key(input.database_branch_id),
		Snapshot,
	)
	.await?
	.as_deref()
	.map(decode_compaction_root)
	.transpose()
	.context("decode sqlite compaction root for repair cleanup")?;
	let manifest_generation = root
		.as_ref()
		.map(|root| root.manifest_generation)
		.unwrap_or(input.base_manifest_generation);

	let mut key_count = 0_u32;
	let mut byte_count = 0_u64;
	for staged in &input.input_range.staged_hot_shards {
		let stage_key = keys::branch_compaction_stage_hot_shard_key(
			input.database_branch_id,
			staged.job_id,
			staged.output_ref.shard_id,
			staged.output_ref.as_of_txid,
			0,
		);
		let Some(stage_value) = tx_get_value(tx, &stage_key, Serializable).await? else {
			continue;
		};
		let proof = match decode_hot_shard_stage_proof(&stage_value) {
			Ok(proof) => proof,
			Err(err) => {
				tracing::error!(
					?input.database_branch_id,
					manifest_generation,
					?staged.job_id,
					shard_id = staged.output_ref.shard_id,
					as_of_txid = staged.output_ref.as_of_txid,
					?err,
					repair_action = "retain_staged_hot_output",
					"staged hot shard cleanup found an invalid proof"
				);
				return Ok(rejected_reclaim_job(
					"staged hot shard cleanup proof is invalid",
				));
			}
		};
		if proof.database_branch_id != input.database_branch_id
			|| proof.job_id != staged.job_id
			|| proof.shard_id != staged.output_ref.shard_id
			|| proof.as_of_txid != staged.output_ref.as_of_txid
			|| proof.min_txid != staged.output_ref.min_txid
			|| proof.max_txid != staged.output_ref.max_txid
			|| proof.size_bytes != staged.output_ref.size_bytes
			|| proof.content_hash != staged.output_ref.content_hash
		{
			tracing::error!(
				?input.database_branch_id,
				manifest_generation,
				?staged.job_id,
				shard_id = staged.output_ref.shard_id,
				as_of_txid = staged.output_ref.as_of_txid,
				repair_action = "retain_staged_hot_output",
				"staged hot shard cleanup found a mismatched proof"
			);
			return Ok(rejected_reclaim_job(
				"staged hot shard cleanup proof changed",
			));
		}

		tracing::warn!(
			?input.database_branch_id,
			manifest_generation,
			?staged.job_id,
			shard_id = staged.output_ref.shard_id,
			as_of_txid = staged.output_ref.as_of_txid,
			repair_action = "clear_staged_hot_output",
			"clearing orphan staged hot shard proof; immutable derived shard remains cache-safe"
		);
		udb::compare_and_clear(tx, &stage_key, &stage_value);
		key_count = key_count.saturating_add(1);
		byte_count =
			byte_count.saturating_add(u64::try_from(stage_value.len()).unwrap_or(u64::MAX));
	}

	Ok(ReclaimFdbJobOutput {
		status: CompactionJobStatus::Succeeded,
		output_refs: vec![ReclaimOutputRef {
			key_count,
			byte_count,
			min_txid: input.input_range.txids.min_txid,
			max_txid: input.input_range.txids.max_txid,
		}],
	})
}

fn rejected_reclaim_job(reason: impl Into<String>) -> ReclaimFdbJobOutput {
	ReclaimFdbJobOutput {
		status: CompactionJobStatus::Rejected {
			reason: reason.into(),
		},
		output_refs: Vec::new(),
	}
}

fn retryable_reclaim_job(reason: impl Into<String>) -> ReclaimFdbJobOutput {
	ReclaimFdbJobOutput {
		status: CompactionJobStatus::Retryable {
			reason: reason.into(),
		},
		output_refs: Vec::new(),
	}
}

#[cfg(feature = "test-faults")]
async fn reclaim_fdb_fault_output(
	database_branch_id: DatabaseBranchId,
	point: ReclaimFaultPoint,
) -> Result<Option<ReclaimFdbJobOutput>> {
	match test_hooks::maybe_fire_reclaim_fault(database_branch_id, point).await {
		Ok(Some(_)) | Ok(None) => Ok(None),
		Err(err) => Ok(Some(ReclaimFdbJobOutput {
			status: CompactionJobStatus::Failed {
				error: err.to_string(),
			},
			output_refs: Vec::new(),
		})),
	}
}
