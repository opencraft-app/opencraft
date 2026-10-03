use super::*;

pub(crate) fn reclaim_cold_object_ref(reference: &ColdShardRef) -> ReclaimColdObjectRef {
	ReclaimColdObjectRef {
		object_key: reference.object_key.clone(),
		object_generation_id: reference.object_generation_id,
		content_hash: reference.content_hash,
		size_bytes: reference.size_bytes,
		publish_generation: reference.publish_generation,
		shard_id: reference.shard_id,
		as_of_txid: reference.as_of_txid,
	}
}

pub(crate) fn retired_matches_cold_object(
	retired: &RetiredColdObject,
	cold_object: &ReclaimColdObjectRef,
) -> bool {
	retired.object_key == cold_object.object_key
		&& retired.object_generation_id == cold_object.object_generation_id
		&& retired.content_hash == cold_object.content_hash
		&& retired.size_bytes == cold_object.size_bytes
		&& retired.publish_generation == cold_object.publish_generation
		&& retired.shard_id == cold_object.shard_id
		&& retired.as_of_txid == cold_object.as_of_txid
}

pub(crate) async fn cold_ref_has_atomic_publish_marker(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
	reference: &ColdShardRef,
) -> Result<bool> {
	let marker = tx_get_value(
		tx,
		&keys::branch_compaction_cold_publish_key(database_branch_id, reference.publish_generation),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_cold_publish_marker)
	.transpose()
	.context("decode cold publication marker for exact ref proof")?;
	Ok(reference.database_branch_id == database_branch_id
		&& marker
			.as_ref()
			.is_some_and(|marker| marker.matches_ref(reference)))
}

pub(crate) async fn read_manager_fdb_snapshot(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	cold_storage_enabled: bool,
	now_ms: i64,
) -> Result<ManagerFdbSnapshot> {
	let branch_record = tx_get_value(tx, &keys::branches_list_key(branch_id), Serializable)
		.await?
		.as_deref()
		.map(decode_database_branch_record)
		.transpose()
		.context("decode sqlite database branch record for compaction manager")?;
	let head = tx_get_value(tx, &keys::branch_meta_head_key(branch_id), Serializable)
		.await?
		.as_deref()
		.map(decode_db_head)
		.transpose()
		.context("decode sqlite head for compaction manager")?;
	let root = tx_get_value(
		tx,
		&keys::branch_compaction_root_key(branch_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_compaction_root)
	.transpose()
	.context("decode sqlite compaction root for manager refresh")?
	.unwrap_or(CompactionRoot {
		schema_version: 1,
		manifest_generation: 0,
		hot_watermark_txid: 0,
		cold_watermark_txid: 0,
		cold_watermark_versionstamp: [0; 16],
	});
	let cleared_staged_hot_job =
		cleanup_one_fenced_hot_stage_job(tx, branch_id, branch_record.as_ref(), &root).await?;
	if branch_record.is_some() {
		crate::conveyer::quota::ensure_pidx_count_index_initialized(tx, branch_id).await?;
	}
	let orphan_cold_upload_job_id = if cold_storage_enabled {
		let intent_prefix = keys::branch_compaction_cold_upload_intent_prefix(branch_id);
		let intent_rows = tx_scan_range_values_limited(
			tx,
			&intent_prefix,
			&end_of_prefix_range(&intent_prefix),
			1,
			Serializable,
		)
		.await?;
		intent_rows
			.first()
			.map(|(key, value)| {
				let intent = decode_cold_upload_intent(value)
					.context("decode sqlite cold upload intent during manager refresh")?;
				ensure!(
					intent.reference.database_branch_id == branch_id,
					"cold upload intent belongs to another database branch"
				);
				let (shard_id, as_of_txid) = keys::decode_branch_compaction_cold_upload_intent_key(
					branch_id,
					intent.reference.object_generation_id,
					key,
				)
				.context("decode sqlite cold upload intent key during manager refresh")?;
				ensure!(
					intent.reference.shard_id == shard_id
						&& intent.reference.as_of_txid == as_of_txid,
					"cold upload intent key does not match its value"
				);
				Ok(intent.reference.object_generation_id)
			})
			.transpose()?
	} else {
		None
	};
	let dirty_key = keys::sqlite_cmp_dirty_key(branch_id);
	let dirty_bytes = tx_get_value(tx, &dirty_key, Serializable).await?;
	let dirty = dirty_bytes
		.as_deref()
		.map(decode_sqlite_cmp_dirty)
		.transpose()
		.context("decode sqlite dirty marker for compaction manager")?;
	let bucket_proof_blocked_reclaim = resolve_bucket_fork_pins(tx, branch_id).await?;
	let db_pin_count = history_pin::read_indexed_pin_count(tx, branch_id, Serializable).await?;
	// Planning, staging, and installation must resolve the same effective policy. Falling back to
	// the default only in the manager can produce a durable job descriptor that every hot worker
	// rejects when a bucket or database override selects additional PITR coverage generations.
	let pitr_policy = read_effective_pitr_policy_for_branch(tx, branch_record.as_ref()).await?;
	let hot_inputs = read_hot_input_snapshot(
		tx,
		branch_id,
		head.as_ref().map(|head| head.head_txid),
		&root,
		Snapshot,
		pitr_policy,
		now_ms,
	)
	.await?;
	let cold_inputs = if cold_storage_enabled {
		read_cold_input_snapshot(tx, branch_id, &root, Snapshot).await?
	} else {
		ColdInputSnapshot::default()
	};
	let shard_cache_policy =
		read_effective_shard_cache_policy_for_branch(tx, branch_record.as_ref()).await?;
	let reclaim_inputs = read_reclaim_input_snapshot(
		tx,
		branch_id,
		&root,
		branch_record.as_ref(),
		shard_cache_policy,
		Snapshot,
		cold_storage_enabled,
		now_ms,
	)
	.await?;
	let hot_lag = head.as_ref().map_or(0, |head| {
		head.head_txid.saturating_sub(root.hot_watermark_txid)
	});
	let has_actionable_lag = hot_lag >= quota::compaction_delta_threshold(branch_id)
		|| reclaim_coverage_is_complete(&reclaim_inputs);
	let cleared_dirty = if !has_actionable_lag {
		if let Some(expected_dirty) = dirty_bytes {
			udb::compare_and_clear(tx, &dirty_key, &expected_dirty);
			crate::conveyer::commit::clear_dirty_reconcile_schedule_tx(tx, branch_id).await?;
			true
		} else {
			false
		}
	} else {
		false
	};

	Ok(ManagerFdbSnapshot {
		cold_storage_enabled,
		branch_record,
		head,
		root,
		dirty,
		db_pin_count,
		hot_inputs,
		cold_inputs,
		reclaim_inputs,
		orphan_cold_upload_job_id,
		bucket_proof_blocked_reclaim,
		cleared_dirty,
		cleared_staged_hot_job,
	})
}

/// Reclaim at most one hot stage job per manager refresh. The ordered index is partitioned by
/// database branch and base manifest generation, so work is independent of the number of actors,
/// databases, or historical jobs in the installation. A job is eligible only after the current
/// manifest has advanced past the exact generation its publisher requires; therefore a paused
/// Gasoline workflow can never be collected while it is still publishable.
pub(crate) async fn cleanup_one_fenced_hot_stage_job(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	branch_record: Option<&DatabaseBranchRecord>,
	root: &CompactionRoot,
) -> Result<bool> {
	if root.manifest_generation == 0 {
		return Ok(false);
	}
	let prefix = keys::branch_compaction_stage_hot_job_by_generation_prefix(branch_id);
	let mut end = prefix.clone();
	end.extend_from_slice(&root.manifest_generation.to_be_bytes());
	// Read a small metadata page so missing/stale secondary rows cannot hide the next valid job.
	let index_rows = tx_scan_range_values_limited(tx, &prefix, &end, 32, Serializable).await?;
	for (index_key, index_value) in index_rows {
		let (base_manifest_generation, job_id) =
			match keys::decode_branch_compaction_stage_hot_job_by_generation_key(
				branch_id, &index_key,
			) {
				Ok(decoded) => decoded,
				Err(err) => {
					tracing::error!(
						?branch_id,
						?err,
						repair_action = "drop_corrupt_stage_secondary",
						"staged hot job generation index key is corrupt"
					);
					tx.informal().clear(&index_key);
					continue;
				}
			};
		if !index_value.is_empty() {
			tracing::error!(
				?branch_id,
				?job_id,
				index_key = ?index_key,
				repair_action = "normalize_corrupt_stage_secondary_value",
				"staged hot job generation index value is corrupt"
			);
			// The secondary value has no semantics. Repair it in place so a corrupt value cannot
			// permanently hide an otherwise valid primary job from the next bounded refresh.
			tx.informal().set(&index_key, &[]);
			continue;
		}
		let record_key = keys::branch_compaction_stage_hot_job_key(branch_id, job_id);
		let Some(record_bytes) = tx_get_value(tx, &record_key, Serializable).await? else {
			tx.informal().clear(&index_key);
			tx.informal()
				.clear(&keys::branch_hot_compaction_job_queue_key(
					branch_id, job_id,
				));
			continue;
		};
		let record = match decode_hot_stage_job_record(&record_bytes) {
			Ok(record) => record,
			Err(err) => {
				tracing::error!(
					?branch_id,
					?job_id,
					?err,
					repair_action = "retain_corrupt_stage_primary",
					"staged hot job primary record is corrupt"
				);
				// The secondary is not authoritative and would otherwise poison every page.
				tx.informal().clear(&index_key);
				continue;
			}
		};
		if record.database_branch_id != branch_id
			|| record.job_id != job_id
			|| record.base_manifest_generation != base_manifest_generation
		{
			tracing::error!(
				?branch_id,
				?job_id,
				repair_action = "retain_mismatched_stage_primary",
				"staged hot job primary does not match its generation index"
			);
			tx.informal().clear(&index_key);
			continue;
		}
		let generation_fenced = root.manifest_generation > record.base_manifest_generation;
		let lifecycle_fenced = !branch_record.is_some_and(|branch| {
			branch.state == BranchState::Live
				&& branch.lifecycle_generation == record.base_lifecycle_generation
		});
		if !generation_fenced && !lifecycle_fenced {
			continue;
		}

		let stage_prefix = keys::branch_compaction_stage_hot_shard_prefix(branch_id, job_id);
		let rows = tx_scan_prefix_values_limited(
			tx,
			&stage_prefix,
			CMP_FDB_BATCH_MAX_KEYS.saturating_add(1),
			Serializable,
		)
		.await?;
		ensure!(
			rows.len() <= CMP_FDB_BATCH_MAX_KEYS,
			"fenced staged hot job exceeded the bounded FDB row limit"
		);
		for (key, value) in &rows {
			let (shard_id, as_of_txid, chunk_idx) =
				keys::decode_branch_compaction_stage_hot_shard_key(branch_id, job_id, key)?;
			let proof = decode_hot_shard_stage_proof(value)
				.context("decode fenced staged hot shard proof")?;
			ensure!(
				chunk_idx == 0
					&& proof.database_branch_id == branch_id
					&& proof.job_id == job_id
					&& proof.shard_id == shard_id
					&& proof.as_of_txid == as_of_txid,
				"fenced staged hot shard proof identity changed"
			);
		}
		for (key, value) in rows {
			udb::compare_and_clear(tx, &key, &value);
		}
		udb::compare_and_clear(tx, &record_key, &record_bytes);
		tx.informal().clear(&index_key);
		tx.informal()
			.clear(&keys::branch_hot_compaction_job_queue_key(
				branch_id, job_id,
			));
		return Ok(true);
	}

	Ok(false)
}

pub(crate) async fn read_cold_input_snapshot(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	root: &CompactionRoot,
	isolation_level: universaldb::utils::IsolationLevel,
) -> Result<ColdInputSnapshot> {
	if root.hot_watermark_txid <= root.cold_watermark_txid {
		return Ok(ColdInputSnapshot::default());
	}

	let min_txid = root.cold_watermark_txid.saturating_add(1);
	let hot_generation_scan_end = root
		.hot_watermark_txid
		.checked_add(1)
		.map(|txid| keys::branch_compaction_hot_generation_key(branch_id, txid))
		.unwrap_or_else(|| {
			end_of_prefix_range(&keys::branch_compaction_hot_generation_prefix(branch_id))
		});
	let generation_rows = tx_scan_range_values_limited(
		tx,
		&keys::branch_compaction_hot_generation_key(branch_id, min_txid),
		&hot_generation_scan_end,
		1,
		isolation_level,
	)
	.await?;
	let [(generation_key, generation_value)] = generation_rows.as_slice() else {
		bail!(
			"hot watermark {} is ahead of cold watermark {}, but no bounded hot generation manifest exists",
			root.hot_watermark_txid,
			root.cold_watermark_txid
		);
	};
	let selected_max_txid =
		keys::decode_branch_compaction_hot_generation_txid(branch_id, generation_key)?;
	let manifest = decode_hot_generation_manifest(generation_value)
		.context("decode sqlite hot generation manifest for cold planning")?;
	ensure!(
		manifest.database_branch_id == branch_id
			&& manifest.as_of_txid == selected_max_txid
			&& selected_max_txid >= min_txid
			&& selected_max_txid <= root.hot_watermark_txid,
		"hot generation manifest identity changed"
	);
	ensure!(
		!manifest.shards.is_empty(),
		"hot generation {selected_max_txid} has an empty shard manifest"
	);
	ensure!(
		manifest.shards.len() <= CMP_COLD_MAX_SHARDS_PER_JOB,
		"hot generation {selected_max_txid} exceeded {CMP_COLD_MAX_SHARDS_PER_JOB} shards"
	);
	ensure!(
		manifest
			.shards
			.windows(2)
			.all(|pair| pair[0].shard_id < pair[1].shard_id),
		"hot generation {selected_max_txid} shard manifest is not strictly ordered"
	);

	let commit_scan_start = keys::branch_commit_key(branch_id, min_txid);
	let commit_scan_end = selected_max_txid
		.checked_add(1)
		.map(|next_txid| keys::branch_commit_key(branch_id, next_txid))
		.unwrap_or_else(|| end_of_prefix_range(&keys::branch_commit_prefix(branch_id)));
	let commits = tx_scan_range_values_limited(
		tx,
		&commit_scan_start,
		&commit_scan_end,
		CMP_FDB_BATCH_MAX_KEYS.saturating_add(1),
		isolation_level,
	)
	.await?;
	ensure!(
		commits.len() <= CMP_FDB_BATCH_MAX_KEYS,
		"cold input commit range exceeded the bounded hot generation"
	);
	let mut min_versionstamp = [0; 16];
	let mut max_versionstamp = [0; 16];
	let mut selected_min_txid = None;
	let mut observed_max_txid = None;
	for (key, value) in commits {
		let txid = decode_branch_commit_txid(branch_id, &key)?;
		let commit =
			decode_commit_row(&value).context("decode sqlite commit row for cold planning")?;
		if selected_min_txid.is_none() {
			selected_min_txid = Some(txid);
			min_versionstamp = commit.versionstamp;
		}
		observed_max_txid = Some(txid);
		max_versionstamp = commit.versionstamp;
	}
	ensure!(
		observed_max_txid == Some(selected_max_txid),
		"hot generation {selected_max_txid} is missing its exact commit row"
	);

	// The manifest is the compact atomic identity of this cold input. A sparse update can expand
	// these refs into hundreds of MiB of full shard bodies, so manager planning deliberately does
	// not resolve SHARD/SHARD_CHUNK values. Upload workers re-read and hash one exact body per short
	// transaction before putting it in the cold tier.
	let shard_inputs = manifest
		.shards
		.iter()
		.map(|reference| ColdShardInputRef {
			shard_id: reference.shard_id,
			as_of_txid: selected_max_txid,
			size_bytes: reference.size_bytes,
			content_hash: reference.content_hash,
		})
		.collect::<Vec<_>>();
	ensure!(
		shard_inputs.len() <= CMP_COLD_MAX_SHARDS_PER_JOB,
		"cold generation {selected_max_txid} exceeded {CMP_COLD_MAX_SHARDS_PER_JOB} shards"
	);
	let total_value_bytes = shard_inputs
		.iter()
		.fold(0_u64, |total, input| total.saturating_add(input.size_bytes));

	Ok(ColdInputSnapshot {
		shard_inputs,
		total_value_bytes,
		min_versionstamp,
		max_versionstamp,
		selected_min_txid,
		selected_max_txid: observed_max_txid,
	})
}

pub(crate) fn cold_shard_input_refs(cold_inputs: &ColdInputSnapshot) -> Vec<ColdShardInputRef> {
	cold_inputs.shard_inputs.clone()
}

pub(crate) fn summarize_cold_input_refs(input_refs: &[ColdShardInputRef]) -> ColdInputSummary {
	let mut fingerprint = Sha256::new();
	for input in input_refs {
		update_fingerprint(&mut fingerprint, &input.shard_id.to_be_bytes());
		update_fingerprint(&mut fingerprint, &input.as_of_txid.to_be_bytes());
		update_fingerprint(&mut fingerprint, &input.size_bytes.to_be_bytes());
		update_fingerprint(&mut fingerprint, &input.content_hash);
	}
	ColdInputSummary {
		input_ref_count: u32::try_from(input_refs.len()).unwrap_or(u32::MAX),
		input_refs_hash: finish_fingerprint(fingerprint),
	}
}

pub(crate) fn summarize_cold_output_refs(output_refs: &[ColdShardRef]) -> Result<ColdStageSummary> {
	let mut fingerprint = Sha256::new();
	for reference in output_refs {
		let key = keys::branch_compaction_cold_shard_key(
			reference.database_branch_id,
			reference.shard_id,
			reference.as_of_txid,
		);
		let encoded = encode_cold_shard_ref(reference.clone())?;
		update_fingerprint(&mut fingerprint, &key);
		update_fingerprint(&mut fingerprint, &encoded);
	}
	Ok(ColdStageSummary {
		output_ref_count: u32::try_from(output_refs.len()).unwrap_or(u32::MAX),
		output_refs_hash: finish_fingerprint(fingerprint),
	})
}

pub(crate) fn summarize_staged_hot_rows(rows: &[(Vec<u8>, Vec<u8>)]) -> HotStageSummary {
	let mut ordered = rows.iter().collect::<Vec<_>>();
	ordered.sort_by(|left, right| left.0.cmp(&right.0));
	let mut fingerprint = Sha256::new();
	for (key, value) in ordered {
		update_fingerprint(&mut fingerprint, key);
		update_fingerprint(&mut fingerprint, value);
	}
	HotStageSummary {
		staged_row_count: u32::try_from(rows.len()).unwrap_or(u32::MAX),
		staged_rows_hash: finish_fingerprint(fingerprint),
	}
}

pub(crate) async fn read_staged_hot_shard_batch(
	tx: &universaldb::Transaction,
	input: &InstallHotJobInput,
	isolation_level: universaldb::utils::IsolationLevel,
) -> Result<StagedHotShardBatch> {
	let rows = tx_scan_prefix_values_limited(
		tx,
		&keys::branch_compaction_stage_hot_shard_prefix(input.database_branch_id, input.job_id),
		CMP_FDB_BATCH_MAX_KEYS.saturating_add(1),
		isolation_level,
	)
	.await?;
	ensure!(
		rows.len() <= CMP_FDB_BATCH_MAX_KEYS,
		"staged hot shard row count exceeded the FDB batch limit"
	);
	let mut output_refs = Vec::with_capacity(rows.len());
	for (key, value) in &rows {
		let (shard_id, as_of_txid, chunk_idx) = keys::decode_branch_compaction_stage_hot_shard_key(
			input.database_branch_id,
			input.job_id,
			key,
		)?;
		ensure!(
			chunk_idx == 0,
			"staged hot shard has an unexpected chunk index"
		);
		let proof = decode_hot_shard_stage_proof(value)
			.context("decode staged hot shard publication proof")?;
		ensure!(
			proof.database_branch_id == input.database_branch_id
				&& proof.job_id == input.job_id
				&& proof.shard_id == shard_id
				&& proof.as_of_txid == as_of_txid,
			"staged hot shard proof identity does not match its key"
		);
		output_refs.push(HotShardOutputRef {
			shard_id: proof.shard_id,
			as_of_txid: proof.as_of_txid,
			min_txid: proof.min_txid,
			max_txid: proof.max_txid,
			size_bytes: proof.size_bytes,
			content_hash: proof.content_hash,
		});
	}
	Ok(StagedHotShardBatch { output_refs, rows })
}

pub(crate) async fn resolve_bucket_fork_pins(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
) -> Result<bool> {
	const CATALOG_PROOF_PAGE_SIZE: usize = 24;
	const CHILD_PROOF_PAGE_SIZE: usize = 64;

	// A complete proof is cheap in steady state: compare at most 256 epoch shards. Independent
	// roots hash onto these shards, so this remains an atomic bounded proof even if one database is
	// cataloged in arbitrarily many bucket roots. A collision causes conservative revalidation, not
	// an unsafe false negative.
	let complete_key = keys::branch_bucket_proof_complete_key(branch_id);
	if tx_get_value(tx, &complete_key, Serializable)
		.await?
		.is_some()
	{
		let epoch_rows = tx_scan_prefix_values_limited(
			tx,
			&keys::branch_bucket_proof_epoch_shard_prefix(branch_id),
			257,
			Serializable,
		)
		.await?;
		ensure!(
			epoch_rows.len() <= 256,
			"bucket proof epoch shard fanout exceeded 256"
		);
		let mut changed = false;
		for (epoch_key, expected_epoch) in epoch_rows {
			let epoch_shard =
				keys::decode_branch_bucket_proof_epoch_shard_key(branch_id, &epoch_key)?;
			let current_epoch = tx_get_value(
				tx,
				&keys::bucket_proof_epoch_shard_key(epoch_shard),
				Serializable,
			)
			.await?
			.unwrap_or_else(|| 0_i64.to_le_bytes().to_vec());
			if current_epoch != expected_epoch {
				changed = true;
				break;
			}
		}
		if !changed {
			return Ok(false);
		}
		reset_bucket_fork_proof(tx, branch_id);
	}

	let catalog_complete_key = keys::branch_bucket_proof_catalog_complete_key(branch_id);
	if tx_get_value(tx, &catalog_complete_key, Serializable)
		.await?
		.is_none()
	{
		let prefix = keys::bucket_catalog_by_db_prefix(branch_id);
		let cursor_key = keys::branch_bucket_proof_catalog_cursor_key(branch_id);
		let cursor = tx_get_value(tx, &cursor_key, Serializable).await?;
		let start = cursor.map_or_else(
			|| prefix.clone(),
			|mut cursor| {
				cursor.push(0);
				cursor
			},
		);
		let mut rows = tx_scan_range_values_limited(
			tx,
			&start,
			&end_of_prefix_range(&prefix),
			CATALOG_PROOF_PAGE_SIZE.saturating_add(1),
			Serializable,
		)
		.await?;
		let has_more = rows.len() > CATALOG_PROOF_PAGE_SIZE;
		if has_more {
			rows.pop();
		}
		for (_, value) in &rows {
			let catalog_fact = decode_bucket_catalog_db_fact(value)
				.context("decode sqlite bucket catalog proof fact")?;
			ensure!(
				catalog_fact.database_branch_id == branch_id,
				"sqlite bucket catalog proof has the wrong database branch"
			);
			let root_bucket_branch_id = crate::conveyer::branch::read_bucket_root_branch_id(
				tx,
				catalog_fact.bucket_branch_id,
			)
			.await?;
			let epoch_shard = keys::bucket_proof_epoch_shard(root_bucket_branch_id);
			let epoch = tx_get_value(
				tx,
				&keys::bucket_proof_epoch_shard_key(epoch_shard),
				Serializable,
			)
			.await?
			.unwrap_or_else(|| 0_i64.to_le_bytes().to_vec());
			tx.informal().set(
				&keys::branch_bucket_proof_epoch_shard_key(branch_id, epoch_shard),
				&epoch,
			);
			if catalog_fact.tombstone_versionstamp.is_none() {
				tx.informal().set(
					&keys::branch_bucket_proof_seen_key(
						branch_id,
						catalog_fact.bucket_branch_id,
						catalog_fact.bucket_branch_id,
					),
					&[],
				);
				tx.informal().set(
					&keys::branch_bucket_proof_queue_key(
						branch_id,
						catalog_fact.bucket_branch_id,
						catalog_fact.bucket_branch_id,
					),
					value,
				);
			}
		}
		if has_more {
			let last_key = rows
				.last()
				.context("full bucket catalog proof page had no cursor row")?
				.0
				.clone();
			tx.informal().set(&cursor_key, &last_key);
			return Ok(true);
		}
		tx.informal().clear(&cursor_key);
		tx.informal().set(&catalog_complete_key, &[]);
	}

	let queue_prefix = keys::branch_bucket_proof_queue_prefix(branch_id);
	// One source x 64 child facts leaves headroom below the 500-key FDB budget because each child
	// can require a fork-fact read, a version lookup, and history-pin index reads.
	let queue_rows = tx_scan_prefix_values_limited(tx, &queue_prefix, 1, Serializable).await?;
	if queue_rows.is_empty() {
		let epoch_rows = tx_scan_prefix_values_limited(
			tx,
			&keys::branch_bucket_proof_epoch_shard_prefix(branch_id),
			257,
			Serializable,
		)
		.await?;
		ensure!(
			epoch_rows.len() <= 256,
			"bucket proof epoch shard fanout exceeded 256"
		);
		for (epoch_key, expected_epoch) in epoch_rows {
			let epoch_shard =
				keys::decode_branch_bucket_proof_epoch_shard_key(branch_id, &epoch_key)?;
			let current_epoch = tx_get_value(
				tx,
				&keys::bucket_proof_epoch_shard_key(epoch_shard),
				Serializable,
			)
			.await?
			.unwrap_or_else(|| 0_i64.to_le_bytes().to_vec());
			if current_epoch != expected_epoch {
				reset_bucket_fork_proof(tx, branch_id);
				return Ok(true);
			}
		}
		let seen_prefix = keys::branch_bucket_proof_seen_prefix(branch_id);
		tx.informal()
			.clear_range(&seen_prefix, &end_of_prefix_range(&seen_prefix));
		tx.informal().set(&complete_key, &[]);
		return Ok(false);
	}
	for (queue_key, catalog_value) in queue_rows {
		let (source_bucket_branch_id, catalog_bucket_branch_id) =
			keys::decode_branch_bucket_proof_queue_key(branch_id, &queue_key)?;
		let catalog_fact = decode_bucket_catalog_db_fact(&catalog_value)
			.context("decode durable bucket proof queue item")?;
		ensure!(
			catalog_fact.database_branch_id == branch_id
				&& catalog_fact.bucket_branch_id == catalog_bucket_branch_id,
			"durable bucket proof queue identity changed"
		);
		let child_prefix = keys::bucket_child_prefix(source_bucket_branch_id);
		let child_cursor_key = keys::branch_bucket_proof_queue_cursor_key(
			branch_id,
			source_bucket_branch_id,
			catalog_bucket_branch_id,
		);
		let child_cursor = tx_get_value(tx, &child_cursor_key, Serializable).await?;
		let child_start = child_cursor.map_or_else(
			|| child_prefix.clone(),
			|mut cursor| {
				cursor.push(0);
				cursor
			},
		);
		let mut child_rows = tx_scan_range_values_limited(
			tx,
			&child_start,
			&end_of_prefix_range(&child_prefix),
			CHILD_PROOF_PAGE_SIZE.saturating_add(1),
			Serializable,
		)
		.await?;
		let child_has_more = child_rows.len() > CHILD_PROOF_PAGE_SIZE;
		if child_has_more {
			child_rows.pop();
		}
		for (_, value) in &child_rows {
			let child_fact =
				decode_bucket_fork_fact(value).context("decode sqlite bucket child fact")?;
			ensure!(
				child_fact.source_bucket_branch_id == source_bucket_branch_id,
				"sqlite bucket child fact has the wrong source"
			);
			if !bucket_fork_can_inherit_database(&child_fact, &catalog_fact) {
				continue;
			}
			if bucket_fork_pin_fact_is_missing_or_changed(tx, &child_fact).await?
				|| materialize_bucket_fork_pin(tx, branch_id, &child_fact).await?
			{
				return Ok(true);
			}
			let seen_key = keys::branch_bucket_proof_seen_key(
				branch_id,
				child_fact.target_bucket_branch_id,
				catalog_bucket_branch_id,
			);
			if tx_get_value(tx, &seen_key, Serializable).await?.is_none() {
				tx.informal().set(&seen_key, &[]);
				tx.informal().set(
					&keys::branch_bucket_proof_queue_key(
						branch_id,
						child_fact.target_bucket_branch_id,
						catalog_bucket_branch_id,
					),
					&catalog_value,
				);
			}
		}
		if child_has_more {
			let last_key = child_rows
				.last()
				.context("full bucket child proof page had no cursor row")?
				.0
				.clone();
			tx.informal().set(&child_cursor_key, &last_key);
		} else {
			tx.informal().clear(&queue_key);
			tx.informal().clear(&child_cursor_key);
		}
	}

	Ok(true)
}

fn reset_bucket_fork_proof(tx: &universaldb::Transaction, branch_id: DatabaseBranchId) {
	for key in [
		keys::branch_bucket_proof_complete_key(branch_id),
		keys::branch_bucket_proof_catalog_complete_key(branch_id),
		keys::branch_bucket_proof_catalog_cursor_key(branch_id),
	] {
		tx.informal().clear(&key);
	}
	for prefix in [
		keys::branch_bucket_proof_root_prefix(branch_id),
		keys::branch_bucket_proof_epoch_shard_prefix(branch_id),
		keys::branch_bucket_proof_queue_prefix(branch_id),
		keys::branch_bucket_proof_queue_cursor_prefix(branch_id),
		keys::branch_bucket_proof_seen_prefix(branch_id),
	] {
		tx.informal()
			.clear_range(&prefix, &end_of_prefix_range(&prefix));
	}
}

pub(crate) fn bucket_fork_can_inherit_database(
	fork_fact: &BucketForkFact,
	catalog_fact: &BucketCatalogDbFact,
) -> bool {
	fork_fact.fork_versionstamp >= catalog_fact.catalog_versionstamp
		&& catalog_fact
			.tombstone_versionstamp
			.map_or(true, |tombstone_versionstamp| {
				fork_fact.fork_versionstamp < tombstone_versionstamp
			})
}

pub(crate) async fn bucket_fork_pin_fact_is_missing_or_changed(
	tx: &universaldb::Transaction,
	child_fact: &BucketForkFact,
) -> Result<bool> {
	let Some(fork_pin_bytes) = tx_get_value(
		tx,
		&keys::bucket_fork_pin_key(
			child_fact.source_bucket_branch_id,
			child_fact.fork_versionstamp,
			child_fact.target_bucket_branch_id,
		),
		Serializable,
	)
	.await?
	else {
		return Ok(true);
	};
	let fork_pin_fact =
		decode_bucket_fork_fact(&fork_pin_bytes).context("decode sqlite bucket fork fact")?;

	Ok(fork_pin_fact != *child_fact)
}

pub(crate) async fn materialize_bucket_fork_pin(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	fork_fact: &BucketForkFact,
) -> Result<bool> {
	let Some((at_txid, at_versionstamp, commit)) =
		latest_commit_at_or_before_versionstamp(tx, branch_id, fork_fact.fork_versionstamp).await?
	else {
		tracing::warn!(
			?branch_id,
			?fork_fact,
			"retaining sqlite history because bucket fork versionstamp could not be resolved"
		);
		return Ok(true);
	};

	history_pin::write_bucket_fork_pin(
		tx,
		branch_id,
		fork_fact.target_bucket_branch_id,
		at_versionstamp,
		at_txid,
		commit.wall_clock_ms,
	)
	.await?;
	Ok(false)
}

pub(crate) async fn read_effective_pitr_policy_for_branch(
	tx: &universaldb::Transaction,
	branch_record: Option<&DatabaseBranchRecord>,
) -> Result<PitrPolicy> {
	let Some(branch_record) = branch_record else {
		return Ok(PitrPolicy::default());
	};
	let binding_key = keys::database_policy_binding_key(branch_record.branch_id);
	let binding_bytes = tx_get_value(tx, &binding_key, Serializable)
		.await?
		.with_context(|| {
			format!(
				"sqlite database branch {} has no policy binding; compaction is stopped to avoid applying an unsafe default retention policy",
				branch_record.branch_id.as_uuid()
			)
		})?;
	let binding = decode_database_policy_binding(&binding_bytes)
		.context("decode sqlite database policy binding for compaction manager")?;
	ensure!(
		binding.database_branch_id == branch_record.branch_id,
		"sqlite database policy binding identity does not match branch {}",
		branch_record.branch_id.as_uuid()
	);

	if let Some(policy) = tx_get_value(
		tx,
		&keys::database_pitr_policy_key(binding.bucket_id, &binding.database_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_pitr_policy)
	.transpose()
	.context("decode sqlite database PITR policy for compaction manager")?
	{
		return Ok(policy);
	}

	let shard = policy::bucket_pitr_policy_read_shard(branch_record.branch_id);
	if let Some(policy) = tx_get_value(
		tx,
		&keys::bucket_policy_pitr_shard_key(binding.bucket_id, shard),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_pitr_policy)
	.transpose()
	.context("decode sharded sqlite bucket PITR policy for compaction manager")?
	{
		return Ok(policy);
	}

	// Compatibility path for buckets whose policy predates sharded read replicas. This is still an
	// exact read scoped to one bucket, never a global pointer scan. The next policy write fills all
	// replicas atomically.
	tx_get_value(
		tx,
		&keys::bucket_policy_pitr_key(binding.bucket_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(decode_pitr_policy)
	.transpose()
	.context("decode sqlite bucket PITR policy for compaction manager")
	.map(|policy| policy.unwrap_or_default())
}

pub(crate) async fn read_effective_shard_cache_policy_for_branch(
	tx: &universaldb::Transaction,
	branch_record: Option<&DatabaseBranchRecord>,
) -> Result<ShardCachePolicy> {
	let Some(branch_record) = branch_record else {
		return Ok(ShardCachePolicy::default());
	};
	let binding_bytes = tx_get_value(
		tx,
		&keys::database_policy_binding_key(branch_record.branch_id),
		Serializable,
	)
	.await?
	.with_context(|| {
		format!(
			"sqlite database branch {} has no policy binding; reclaim is stopped to avoid applying an unsafe default shard-cache retention policy",
			branch_record.branch_id.as_uuid()
		)
	})?;
	let binding = decode_database_policy_binding(&binding_bytes)
		.context("decode sqlite database policy binding for shard-cache reclaim")?;
	ensure!(
		binding.database_branch_id == branch_record.branch_id,
		"sqlite database policy binding identity does not match branch {}",
		branch_record.branch_id.as_uuid()
	);

	if let Some(policy) = tx_get_value(
		tx,
		&keys::database_shard_cache_policy_key(binding.bucket_id, &binding.database_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(crate::types::decode_shard_cache_policy)
	.transpose()
	.context("decode sqlite database shard-cache policy for reclaim")?
	{
		return Ok(policy);
	}

	tx_get_value(
		tx,
		&keys::bucket_policy_shard_cache_key(binding.bucket_id),
		Serializable,
	)
	.await?
	.as_deref()
	.map(crate::types::decode_shard_cache_policy)
	.transpose()
	.context("decode sqlite bucket shard-cache policy for reclaim")
	.map(|policy| policy.unwrap_or_default())
}

pub(crate) async fn latest_commit_at_or_before_versionstamp(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	versionstamp_cap: [u8; 16],
) -> Result<Option<(u64, [u8; 16], CommitRow)>> {
	let start = keys::branch_vtx_prefix(branch_id);
	let mut end = keys::branch_vtx_key(branch_id, versionstamp_cap);
	end.push(0);
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Iterator,
			reverse: true,
			limit: Some(1),
			..(start.as_slice(), end.as_slice()).into()
		},
		Serializable,
	);
	let Some(entry) = stream.try_next().await? else {
		return Ok(None);
	};
	let versionstamp = decode_branch_vtx_versionstamp(branch_id, entry.key())?;
	ensure!(
		versionstamp <= versionstamp_cap,
		"reverse VTX lookup exceeded cap"
	);
	let txid = decode_txid_value(entry.value())?;
	let Some(commit_bytes) =
		tx_get_value(tx, &keys::branch_commit_key(branch_id, txid), Serializable).await?
	else {
		return Ok(None);
	};
	let commit = decode_commit_row(&commit_bytes).context("decode sqlite bucket pin commit row")?;

	Ok(Some((txid, versionstamp, commit)))
}

pub(crate) fn decode_branch_vtx_versionstamp(
	branch_id: DatabaseBranchId,
	key: &[u8],
) -> Result<[u8; 16]> {
	let prefix = keys::branch_vtx_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("branch VTX key did not start with expected prefix")?;
	ensure!(
		suffix.len() == 16,
		"branch VTX versionstamp suffix had {} bytes, expected 16",
		suffix.len()
	);

	suffix
		.try_into()
		.context("branch VTX versionstamp suffix should decode as 16 bytes")
}

pub(crate) fn decode_txid_value(value: &[u8]) -> Result<u64> {
	let bytes = <[u8; 8]>::try_from(value)
		.map_err(|_| anyhow::anyhow!("txid value had {} bytes, expected 8", value.len()))?;

	Ok(u64::from_be_bytes(bytes))
}

#[derive(Debug, Clone, Copy)]
struct CompactionBatchBudget {
	max_keys: usize,
	max_value_bytes: u64,
	key_count: usize,
	value_bytes: u64,
}

impl CompactionBatchBudget {
	fn fdb() -> Self {
		CompactionBatchBudget {
			max_keys: CMP_FDB_BATCH_MAX_KEYS,
			max_value_bytes: CMP_FDB_BATCH_MAX_VALUE_BYTES as u64,
			key_count: 0,
			value_bytes: 0,
		}
	}

	fn reclaim() -> Self {
		CompactionBatchBudget {
			max_keys: CMP_RECLAIM_FDB_BATCH_MAX_KEYS,
			max_value_bytes: CMP_FDB_BATCH_MAX_VALUE_BYTES as u64,
			key_count: 0,
			value_bytes: 0,
		}
	}

	fn can_add(&self, row_count: usize, value_bytes: u64) -> bool {
		self.key_count.saturating_add(row_count) <= self.max_keys
			&& self.value_bytes.saturating_add(value_bytes) <= self.max_value_bytes
	}

	fn add(&mut self, row_count: usize, value_bytes: u64) {
		self.key_count = self.key_count.saturating_add(row_count);
		self.value_bytes = self.value_bytes.saturating_add(value_bytes);
	}

	fn value_bytes(&self) -> u64 {
		self.value_bytes
	}
}

fn select_hot_shard_evictions_within_budget(
	candidates: Vec<HotShardEvictionCandidate>,
	budget: &mut CompactionBatchBudget,
) -> Vec<HotShardEvictionCandidate> {
	let mut selected = Vec::new();
	for candidate in candidates {
		if !budget.can_add(candidate.physical_row_count, candidate.physical_value_bytes) {
			break;
		}
		budget.add(candidate.physical_row_count, candidate.physical_value_bytes);
		selected.push(candidate);
	}
	selected
}

pub(crate) async fn read_hot_input_snapshot(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	committed_max_txid: Option<u64>,
	root: &CompactionRoot,
	isolation_level: universaldb::utils::IsolationLevel,
	pitr_policy: PitrPolicy,
	now_ms: i64,
) -> Result<HotInputSnapshot> {
	let Some(mut max_txid) = committed_max_txid else {
		return Ok(HotInputSnapshot::default());
	};
	if max_txid <= root.hot_watermark_txid {
		return Ok(HotInputSnapshot::default());
	}

	let min_txid = root.hot_watermark_txid.saturating_add(1);
	let mut snapshot = HotInputSnapshot::default();
	let truncate_txid = tx_get_value(
		tx,
		&keys::branch_meta_truncate_txid_key(branch_id),
		isolation_level,
	)
	.await?
	.map(|value| {
		let bytes: [u8; 8] = value
			.as_slice()
			.try_into()
			.context("truncate txid index must contain exactly eight bytes")?;
		Ok::<_, anyhow::Error>(u64::from_be_bytes(bytes))
	})
	.transpose()?;
	if truncate_txid != Some(0) {
		// Truncate mutates base SHARD caches as well as PIDX. Unknown and truncated histories
		// retain the original head fence rather than treating those mutations as ordinary writes.
		let head = decode_db_head(
			&tx_get_value(tx, &keys::branch_meta_head_key(branch_id), isolation_level)
				.await?
				.context("head-fenced hot prefix requires a current head")?,
		)?;
		ensure!(
			max_txid <= head.head_txid,
			"hot prefix exceeds the current head"
		);
		ensure!(
			truncate_txid.is_none_or(|txid| txid <= head.head_txid),
			"truncate txid exceeds the current head"
		);
		snapshot.mutable_head_fence = Some(head.head_txid);
	}
	let pin_page = history_pin::read_history_pin_txids_page(
		tx,
		branch_id,
		min_txid,
		max_txid,
		CMP_FDB_BATCH_MAX_KEYS,
		isolation_level,
	)
	.await?;
	if pin_page.has_more {
		max_txid = pin_page
			.txids
			.last()
			.copied()
			.context("history pin page reported more rows without a boundary txid")?;
	}
	snapshot.history_pin_txids = pin_page.txids;
	let mut budget = CompactionBatchBudget::fdb();
	// Do not scan the branch's complete page index. It grows with database size and would make a
	// single compaction transaction depend on every page ever dirtied. Delta pages give us the
	// exact candidate page numbers; read only those PIDX keys and retain the read budget even when
	// their current owner is a later commit.
	let mut inspected_pidx = BTreeMap::<u32, Option<(Vec<u8>, Vec<u8>)>>::new();
	let mut touched_shards_by_txid = BTreeMap::<u64, BTreeSet<u32>>::new();

	let commit_scan_start = keys::branch_commit_key(branch_id, min_txid);
	let commit_scan_end = max_txid
		.checked_add(1)
		.map(|next_txid| keys::branch_commit_key(branch_id, next_txid))
		.unwrap_or_else(|| end_of_prefix_range(&keys::branch_commit_prefix(branch_id)));
	for (key, value) in tx_scan_range_values_limited(
		tx,
		&commit_scan_start,
		&commit_scan_end,
		CMP_FDB_BATCH_MAX_KEYS.saturating_add(1),
		isolation_level,
	)
	.await?
	{
		let txid = decode_branch_commit_txid(branch_id, &key)?;
		if txid > max_txid {
			break;
		}
		let commit =
			decode_commit_row(&value).context("decode sqlite commit row for hot planning")?;
		let delta_chunks = tx_scan_prefix_values(
			tx,
			&keys::branch_delta_chunk_prefix(branch_id, txid),
			isolation_level,
		)
		.await?;
		let txid_value_bytes = u64::try_from(value.len())
			.unwrap_or(u64::MAX)
			.saturating_add(
				delta_chunks
					.iter()
					.map(|(_, value)| u64::try_from(value.len()).unwrap_or(u64::MAX))
					.fold(0_u64, u64::saturating_add),
			);
		let decoded = decode_hot_delta_chunks(branch_id, &delta_chunks)?;
		ensure!(
			decoded.len() == 1 && decoded.contains_key(&txid),
			"hot candidate delta set did not decode to exact txid {txid}"
		);
		let candidate_pages = decoded[&txid]
			.pages
			.iter()
			.map(|page| page.pgno)
			.collect::<BTreeSet<_>>();
		let candidate_shards = candidate_pages
			.iter()
			.map(|pgno| *pgno / keys::SHARD_SIZE)
			.collect::<BTreeSet<_>>();
		let unseen_pages = candidate_pages
			.into_iter()
			.filter(|pgno| !inspected_pidx.contains_key(pgno))
			.collect::<Vec<_>>();
		let new_pidx_reads = futures_util::stream::iter(unseen_pages)
			.map(|pgno| async move {
				let pidx_key = keys::branch_pidx_key(branch_id, pgno);
				let pidx_value = tx_get_value(tx, &pidx_key, isolation_level).await?;
				Ok::<_, anyhow::Error>((pgno, pidx_value.map(|value| (pidx_key, value))))
			})
			.buffer_unordered(32)
			.try_collect::<Vec<_>>()
			.await?;
		let pidx_value_bytes = new_pidx_reads
			.iter()
			.filter_map(|(_, row)| row.as_ref().map(|(_, value)| value))
			.map(|value| u64::try_from(value.len()).unwrap_or(u64::MAX))
			.fold(0_u64, u64::saturating_add);
		let txid_row_count = 1_usize
			.saturating_add(delta_chunks.len())
			.saturating_add(new_pidx_reads.len());
		let txid_value_bytes = txid_value_bytes.saturating_add(pidx_value_bytes);

		if !budget.can_add(txid_row_count, txid_value_bytes) {
			break;
		}

		let mut proposed_touched_shards = touched_shards_by_txid.clone();
		proposed_touched_shards.insert(txid, candidate_shards.clone());
		let mut proposed_commits = snapshot.commits.clone();
		proposed_commits.push((txid, commit.clone()));
		let proposed_pitr_coverage =
			select_pitr_interval_coverage(&pitr_policy, &proposed_commits, now_ms)?;
		let proposed_coverage_txids = selected_hot_coverage_txids(
			root,
			txid,
			&snapshot.history_pin_txids,
			&proposed_pitr_coverage,
		);
		let proposed_stage_rows =
			estimate_staged_hot_shard_rows(&proposed_coverage_txids, &proposed_touched_shards);
		if proposed_stage_rows > CMP_FDB_BATCH_MAX_KEYS {
			ensure!(
				snapshot.selected_max_txid.is_some(),
				"one sqlite commit requires {proposed_stage_rows} staged hot shard rows, exceeding the {CMP_FDB_BATCH_MAX_KEYS}-row FDB job limit"
			);
			break;
		}

		budget.add(txid_row_count, txid_value_bytes);
		snapshot.commits.push((txid, commit));
		snapshot.delta_chunks.extend(delta_chunks);
		for (pgno, row) in new_pidx_reads {
			inspected_pidx.insert(pgno, row);
		}
		let mut selected_pidx_entries = Vec::new();
		for (key, value) in inspected_pidx.values().filter_map(|row| row.as_ref()) {
			let owner_txid =
				decode_pidx_txid(value).context("decode exact sqlite PIDX row for hot planning")?;
			if owner_txid >= min_txid && owner_txid <= txid {
				selected_pidx_entries.push((key.clone(), value.clone()));
			}
		}
		snapshot.pidx_entries = selected_pidx_entries;
		touched_shards_by_txid.insert(txid, candidate_shards);
		snapshot.pitr_interval_coverage = proposed_pitr_coverage;
		snapshot.selected_max_txid = Some(txid);
	}

	if snapshot.selected_max_txid.is_none() {
		return Ok(snapshot);
	}

	snapshot.total_value_bytes = budget.value_bytes();

	Ok(snapshot)
}

pub(crate) fn estimate_staged_hot_shard_rows(
	coverage_txids: &[u64],
	touched_shards_by_txid: &BTreeMap<u64, BTreeSet<u32>>,
) -> usize {
	let mut cumulative_shards = BTreeSet::new();
	let mut touched = touched_shards_by_txid.iter().peekable();
	let mut row_count = 0_usize;

	for coverage_txid in coverage_txids {
		while touched
			.peek()
			.is_some_and(|(txid, _)| **txid <= *coverage_txid)
		{
			let (_, shard_ids) = touched.next().expect("peeked touched shard row exists");
			cumulative_shards.extend(shard_ids.iter().copied());
		}
		row_count = row_count.saturating_add(cumulative_shards.len());
	}

	row_count
}

pub(crate) fn select_pitr_interval_coverage(
	policy: &PitrPolicy,
	commits: &[(u64, CommitRow)],
	now_ms: i64,
) -> Result<Vec<PitrIntervalSelection>> {
	ensure!(
		policy.interval_ms > 0,
		"sqlite PITR interval policy must be positive"
	);
	ensure!(
		policy.retention_ms > 0,
		"sqlite PITR retention policy must be positive"
	);

	let retention_floor_ms = now_ms.saturating_sub(policy.retention_ms);
	let mut selected_by_bucket = BTreeMap::<i64, PitrIntervalSelection>::new();
	for (txid, commit) in commits {
		if commit.wall_clock_ms < retention_floor_ms || commit.wall_clock_ms > now_ms {
			continue;
		}
		let bucket_start_ms =
			commit.wall_clock_ms.div_euclid(policy.interval_ms) * policy.interval_ms;
		let coverage = PitrIntervalCoverage {
			txid: *txid,
			versionstamp: commit.versionstamp,
			wall_clock_ms: commit.wall_clock_ms,
			expires_at_ms: commit.wall_clock_ms.saturating_add(policy.retention_ms),
		};
		let replace = selected_by_bucket
			.get(&bucket_start_ms)
			.map_or(true, |existing| {
				coverage.wall_clock_ms > existing.coverage.wall_clock_ms
					|| (coverage.wall_clock_ms == existing.coverage.wall_clock_ms
						&& coverage.txid > existing.coverage.txid)
			});
		if replace {
			selected_by_bucket.insert(
				bucket_start_ms,
				PitrIntervalSelection {
					bucket_start_ms,
					coverage,
				},
			);
		}
	}

	Ok(selected_by_bucket.into_values().collect())
}

pub(crate) async fn read_reclaim_input_snapshot(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	root: &CompactionRoot,
	branch_record: Option<&DatabaseBranchRecord>,
	shard_cache_policy: ShardCachePolicy,
	isolation_level: universaldb::utils::IsolationLevel,
	cold_storage_enabled: bool,
	now_ms: i64,
) -> Result<ReclaimInputSnapshot> {
	let earliest_history_pin_txid = history_pin::read_earliest_history_pin_txid_at_or_before(
		tx,
		branch_id,
		root.hot_watermark_txid,
		isolation_level,
	)
	.await?;
	let (pitr_interval_retention, expired_pitr_interval_rows, _, pitr_proof_complete) =
		read_pitr_interval_reclaim_rows(tx, branch_id, now_ms, isolation_level).await?;
	let next_pitr_expiry_ms = pitr_interval_retention
		.iter()
		.map(|selection| selection.coverage.expires_at_ms)
		.min();
	let cold_object_refs = if cold_storage_enabled && pitr_proof_complete {
		read_reclaim_cold_object_refs(tx, branch_id, root, isolation_level, now_ms).await?
	} else {
		Vec::new()
	};
	let retired_cold_objects = if cold_storage_enabled && pitr_proof_complete {
		let policy = crate::cold_tier::policy::read_cold_gc_policy_tx(tx).await?;
		read_due_retired_cold_objects(
			tx,
			branch_id,
			now_ms,
			isolation_level,
			usize::from(policy.spec.max_objects_per_batch)
				.min(CMP_RECLAIM_CONTROL_MAX_ITEMS_PER_LANE),
		)
		.await?
	} else {
		Vec::new()
	};
	let (hot_shard_eviction_candidates, next_hot_shard_eviction_ms) = if cold_storage_enabled {
		read_hot_shard_eviction_candidates(
			tx,
			branch_id,
			root,
			branch_record,
			shard_cache_policy,
			isolation_level,
			now_ms,
		)
		.await?
	} else {
		(Vec::new(), None)
	};
	let next_reclaim_at_ms = match (next_pitr_expiry_ms, next_hot_shard_eviction_ms) {
		(Some(left), Some(right)) => Some(left.min(right)),
		(value @ Some(_), None) | (None, value @ Some(_)) => value,
		(None, None) => None,
	};
	// Hot shard manifests hide several physical chunk rows. Share one conservative transaction
	// budget across eviction, expired PITR cleanup, and commit/delta cleanup so independently safe
	// candidate lists cannot combine into one oversized FDB transaction. Commit/delta retirement
	// gets first use of that budget because its coverage proof is the still-present hot shard. If
	// eviction consumed the budget first, an incompressible maximum-size commit could evict its
	// proof in one pass and then remain permanently unreclaimable in every later pass.
	let mut budget = CompactionBatchBudget::reclaim();
	let mut selected_expired_pitr_interval_rows = Vec::new();
	let mut selected_expired_pitr_interval_index_keys = Vec::new();
	for row in expired_pitr_interval_rows {
		if selected_expired_pitr_interval_rows.len() >= CMP_RECLAIM_CONTROL_MAX_ITEMS_PER_LANE {
			break;
		}
		let value_bytes = u64::try_from(row.2.len()).unwrap_or(u64::MAX);
		// One primary and its two exact secondary-index rows are cleared together.
		// Never detach an interval from either index merely because the shared FDB
		// transaction budget admitted only a prefix of the due page.
		if !budget.can_add(3, value_bytes) {
			break;
		}
		budget.add(3, value_bytes);
		selected_expired_pitr_interval_index_keys.push(keys::branch_pitr_interval_by_txid_key(
			branch_id, row.3.txid, row.0,
		));
		selected_expired_pitr_interval_index_keys.push(keys::branch_pitr_interval_due_key(
			branch_id,
			row.3.expires_at_ms,
			row.0,
		));
		selected_expired_pitr_interval_rows.push(row);
	}
	let Some(max_reclaim_txid) = pitr_proof_complete
		.then(|| {
			reclaim_delete_upper_bound(root, earliest_history_pin_txid, &pitr_interval_retention)
		})
		.flatten()
	else {
		let hot_shard_evictions =
			select_hot_shard_evictions_within_budget(hot_shard_eviction_candidates, &mut budget);
		return Ok(ReclaimInputSnapshot {
			cold_object_refs,
			retired_cold_objects,
			hot_shard_evictions,
			expired_pitr_interval_rows: selected_expired_pitr_interval_rows,
			expired_pitr_interval_index_keys: selected_expired_pitr_interval_index_keys,
			pitr_proof_complete,
			next_reclaim_at_ms,
			total_value_bytes: budget.value_bytes(),
			..ReclaimInputSnapshot::default()
		});
	};

	let mut snapshot = ReclaimInputSnapshot {
		cold_object_refs,
		retired_cold_objects,
		expired_pitr_interval_rows: selected_expired_pitr_interval_rows,
		expired_pitr_interval_index_keys: selected_expired_pitr_interval_index_keys,
		pitr_proof_complete,
		next_reclaim_at_ms,
		..ReclaimInputSnapshot::default()
	};
	// Reclaim must scale with the bounded DELTA batch, not with the database's complete live page
	// index. Derive the exact candidate page numbers from each selected DELTA and point-read only
	// those PIDX rows. A page whose current owner is a later, unreclaimed transaction stays live.
	let mut inspected_pidx = BTreeMap::<u32, Option<(Vec<u8>, Vec<u8>)>>::new();
	let commit_scan_start = keys::branch_commit_key(branch_id, 0);
	let commit_scan_end = max_reclaim_txid
		.checked_add(1)
		.map(|next_txid| keys::branch_commit_key(branch_id, next_txid))
		.unwrap_or_else(|| end_of_prefix_range(&keys::branch_commit_prefix(branch_id)));
	for (key, value) in tx_scan_range_values_limited(
		tx,
		&commit_scan_start,
		&commit_scan_end,
		CMP_RECLAIM_FDB_BATCH_MAX_KEYS.saturating_add(1),
		isolation_level,
	)
	.await?
	{
		if snapshot.txid_refs.len() >= CMP_RECLAIM_CONTROL_MAX_ITEMS_PER_LANE {
			break;
		}
		let txid = decode_branch_commit_txid(branch_id, &key)?;
		if txid > max_reclaim_txid {
			break;
		}
		let commit = decode_commit_row(&value).context("decode sqlite commit row for reclaim")?;
		let delta_chunks = tx_scan_prefix_values(
			tx,
			&keys::branch_delta_chunk_prefix(branch_id, txid),
			isolation_level,
		)
		.await?;
		let txid_value_bytes = u64::try_from(value.len())
			.unwrap_or(u64::MAX)
			.saturating_add(
				delta_chunks
					.iter()
					.map(|(_, value)| u64::try_from(value.len()).unwrap_or(u64::MAX))
					.fold(0_u64, u64::saturating_add),
			);
		let decoded = decode_hot_delta_chunks(branch_id, &delta_chunks)?;
		ensure!(
			decoded.len() == 1 && decoded.contains_key(&txid),
			"reclaim candidate delta set did not decode to exact txid {txid}"
		);
		let candidate_pages = decoded[&txid]
			.pages
			.iter()
			.map(|page| page.pgno)
			.collect::<BTreeSet<_>>();
		let candidate_pages = candidate_pages.into_iter().collect::<Vec<_>>();
		let page_history_entries = futures_util::stream::iter(candidate_pages.iter().copied())
			.map(|pgno| async move {
				let history_key = keys::branch_page_history_key(branch_id, pgno, txid);
				let history_value = tx_get_value(tx, &history_key, isolation_level)
					.await?
					.with_context(|| {
						format!(
							"sqlite page-history row is missing for reclaim candidate txid {txid}, page {pgno}"
						)
					})?;
				ensure!(
					history_value.is_empty(),
					"sqlite page-history row is corrupt for reclaim candidate txid {txid}, page {pgno}"
				);
				Ok::<_, anyhow::Error>((txid, history_key, history_value))
			})
			.buffer_unordered(32)
			.try_collect::<Vec<_>>()
			.await?;
		let unseen_pages = candidate_pages
			.into_iter()
			.filter(|pgno| !inspected_pidx.contains_key(pgno))
			.collect::<Vec<_>>();
		let new_pidx_reads = futures_util::stream::iter(unseen_pages)
			.map(|pgno| async move {
				let pidx_key = keys::branch_pidx_key(branch_id, pgno);
				let pidx_value = tx_get_value(tx, &pidx_key, isolation_level).await?;
				Ok::<_, anyhow::Error>((pgno, pidx_value.map(|value| (pidx_key, value))))
			})
			.buffer_unordered(32)
			.try_collect::<Vec<_>>()
			.await?;
		let pidx_value_bytes = new_pidx_reads
			.iter()
			.filter_map(|(_, row)| row.as_ref().map(|(_, value)| value))
			.map(|value| u64::try_from(value.len()).unwrap_or(u64::MAX))
			.fold(0_u64, u64::saturating_add);
		let row_count = 1_usize
			.saturating_add(delta_chunks.len())
			.saturating_add(page_history_entries.len())
			.saturating_add(new_pidx_reads.len());
		let txid_value_bytes = txid_value_bytes.saturating_add(pidx_value_bytes);
		if !budget.can_add(row_count, txid_value_bytes) {
			break;
		}
		budget.add(row_count, txid_value_bytes);
		snapshot.txid_refs.push(ReclaimTxidRef {
			txid,
			versionstamp: commit.versionstamp,
		});
		snapshot.commits.push((txid, key, value, commit));
		snapshot.delta_chunks.extend(delta_chunks);
		snapshot.page_history_entries.extend(page_history_entries);
		for (pgno, row) in new_pidx_reads {
			inspected_pidx.insert(pgno, row);
		}
		let selected_txids = snapshot
			.txid_refs
			.iter()
			.map(|txid_ref| txid_ref.txid)
			.collect::<BTreeSet<_>>();
		let mut selected_pidx_entries = Vec::new();
		for (key, value) in inspected_pidx.values().filter_map(|row| row.as_ref()) {
			let owner_txid = decode_pidx_txid(value)
				.context("decode exact sqlite PIDX row for reclaim planning")?;
			if selected_txids.contains(&owner_txid) {
				selected_pidx_entries.push((key.clone(), value.clone()));
			}
		}
		snapshot.pidx_entries = selected_pidx_entries;
	}
	if snapshot.txid_refs.is_empty() {
		snapshot.hot_shard_evictions =
			select_hot_shard_evictions_within_budget(hot_shard_eviction_candidates, &mut budget);
		snapshot.total_value_bytes = budget.value_bytes();
		return Ok(snapshot);
	}

	let shard_ids = reclaim_delta_shard_ids(branch_id, &snapshot.delta_chunks)?;
	snapshot.required_coverage_shard_count = shard_ids.len();
	snapshot.coverage_shards = futures_util::stream::iter(shard_ids)
		.map(|shard_id| async move {
			let key = keys::branch_shard_key(branch_id, shard_id, root.hot_watermark_txid);
			Ok::<_, anyhow::Error>(
				tx_get_value(tx, &key, isolation_level)
					.await?
					.map(|value| (key, value)),
			)
		})
		.buffer_unordered(32)
		.try_filter_map(|row| async move { Ok(row) })
		.try_collect()
		.await?;

	if !snapshot.pidx_entries.is_empty() || !reclaim_coverage_is_complete(&snapshot) {
		// The commit lane is not actionable, so it will not contribute mutations to this job. Let
		// bounded hot eviction make progress using a budget that contains only the interval lane.
		budget = CompactionBatchBudget::reclaim();
		for (_, _, value, _) in &snapshot.expired_pitr_interval_rows {
			budget.add(3, u64::try_from(value.len()).unwrap_or(u64::MAX));
		}
	}
	snapshot.hot_shard_evictions =
		select_hot_shard_evictions_within_budget(hot_shard_eviction_candidates, &mut budget);
	snapshot.total_value_bytes = budget.value_bytes();

	Ok(snapshot)
}

pub(crate) async fn read_reclaim_cold_object_refs(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	root: &CompactionRoot,
	isolation_level: universaldb::utils::IsolationLevel,
	now_ms: i64,
) -> Result<Vec<ReclaimColdObjectRef>> {
	let mut marker_cache = BTreeMap::<u64, Option<ColdPublishMarker>>::new();
	let prefix = keys::branch_compaction_cold_shard_prefix(branch_id);
	let cursor_key = keys::branch_cold_retire_scan_cursor_key(branch_id);
	let cursor = tx_get_value(tx, &cursor_key, isolation_level).await?;
	let start = cursor.clone().unwrap_or_else(|| prefix.clone());
	ensure!(
		start == prefix || start.starts_with(&prefix),
		"cold retirement cursor escaped branch cold-ref prefix"
	);
	let scan_limit = CMP_COLD_DELETE_MAX_OBJECTS.saturating_add(2);
	let rows = tx_scan_range_values_limited(
		tx,
		&start,
		&end_of_prefix_range(&prefix),
		scan_limit,
		isolation_level,
	)
	.await?;
	let mut refs = Vec::with_capacity(rows.len());
	for (key, value) in &rows {
		let reference = decode_cold_shard_ref(&value)
			.context("decode sqlite cold shard ref for retirement planning")?;
		let (key_shard_id, key_txid) =
			keys::decode_branch_compaction_cold_shard_key(branch_id, key)?;
		if reference.database_branch_id != branch_id
			|| reference.shard_id != key_shard_id
			|| reference.as_of_txid != key_txid
		{
			bail!("cold retirement scan found a ref outside its key identity");
		}
		let marker = if let Some(marker) = marker_cache.get(&reference.publish_generation) {
			marker.clone()
		} else {
			let marker = tx_get_value(
				tx,
				&keys::branch_compaction_cold_publish_key(branch_id, reference.publish_generation),
				isolation_level,
			)
			.await?
			.as_deref()
			.map(decode_cold_publish_marker)
			.transpose()
			.context("decode cold publication marker for retirement planning")?;
			marker_cache.insert(reference.publish_generation, marker.clone());
			marker
		};
		if !marker
			.as_ref()
			.is_some_and(|marker| marker.matches_ref(&reference))
		{
			// Cold refs are staged in bounded transactions before the publication marker and root
			// advance become visible atomically. A ref without its matching marker is therefore an
			// expected in-flight publish (or manually damaged metadata), not yet published proof.
			// Keep this scan window pinned so the later atomic publish or repair can be observed.
			return Ok(Vec::new());
		}
		if reference.publish_generation > root.manifest_generation
			|| reference.as_of_txid > root.cold_watermark_txid
		{
			bail!("cold retirement scan found a published ref outside root bounds");
		}
		refs.push(reference);
	}

	let mut candidates = Vec::new();
	let pitr_ranges = refs
		.windows(2)
		.filter_map(|pair| {
			let [older, newer] = pair else { return None };
			(older.shard_id == newer.shard_id).then_some((older.as_of_txid, newer.as_of_txid))
		})
		.collect::<Vec<_>>();
	let Some(protected_pitr_txids) =
		read_live_pitr_txids_in_ranges(tx, branch_id, &pitr_ranges, now_ms, isolation_level)
			.await?
	else {
		// An incomplete or oversized proof retains cold history; it never falls
		// back to a full interval scan.
		return Ok(Vec::new());
	};
	let history_pin_presence =
		history_pin::history_pin_presence_in_ranges(tx, branch_id, &pitr_ranges, isolation_level)
			.await?;
	let mut history_pin_presence = history_pin_presence.into_iter();
	for pair in refs.windows(2) {
		let [older, newer] = pair else { continue };
		if older.shard_id != newer.shard_id {
			continue;
		}
		let pin_protected = history_pin_presence
			.next()
			.context("history pin range proof count changed")?;
		if pin_protected
			|| protected_pitr_txids
				.range(older.as_of_txid..newer.as_of_txid)
				.next()
				.is_some()
		{
			continue;
		}
		// The live cold ref is also the exact proof used by hot-shard eviction. Retiring it in
		// the same manager snapshot that merely *plans* the eviction creates an ordering hole:
		// a bounded reclaim pass may retire this ref without selecting the corresponding hot row,
		// after which the exact-key eviction proof is gone forever. Keep the cold ref until the
		// matching hot generation has actually disappeared. A later manager refresh can then
		// retire the superseded cold object using the newer published generation and the same
		// PITR/history-pin range proof above.
		if tx_get_value(
			tx,
			&keys::branch_shard_key(branch_id, older.shard_id, older.as_of_txid),
			isolation_level,
		)
		.await?
		.is_some()
		{
			continue;
		}
		let retired_key = keys::branch_compaction_retired_cold_object_key(
			branch_id,
			content_hash(older.object_key.as_bytes()),
		);
		if tx_get_value(tx, &retired_key, isolation_level)
			.await?
			.is_some()
		{
			continue;
		}
		candidates.push(reclaim_cold_object_ref(older));
		if candidates.len() >= CMP_RECLAIM_CONTROL_MAX_ITEMS_PER_LANE {
			break;
		}
	}
	// Keep the cursor stable while a job is pending: the worker must reproduce
	// the exact same window and fingerprint. Once a window has no actionable
	// pair, advance to its final row; include that row again next time so a
	// same-shard pair crossing the page boundary cannot be skipped.
	if candidates.is_empty() {
		if rows.len() == scan_limit {
			let next_cursor = rows.last().expect("non-empty limited page").0.clone();
			if cursor.as_deref() != Some(next_cursor.as_slice()) {
				tx.informal().set(&cursor_key, &next_cursor);
			}
		} else if cursor.is_some() {
			tx.informal().clear(&cursor_key);
		}
	}
	Ok(candidates)
}

pub(crate) async fn read_due_retired_cold_objects(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	now_ms: i64,
	isolation_level: universaldb::utils::IsolationLevel,
	limit: usize,
) -> Result<Vec<RetiredColdObject>> {
	ensure!(limit > 0, "retired cold object scan limit must be positive");
	let mut due = Vec::new();
	let prefix = keys::branch_compaction_retired_cold_object_due_prefix(branch_id);
	let mut end =
		keys::branch_compaction_retired_cold_object_due_key(branch_id, now_ms, [0xff; 32]);
	end.push(0);
	for (due_key, due_value) in
		tx_scan_range_values_limited(tx, &prefix, &end, limit, isolation_level).await?
	{
		ensure!(
			due_value.is_empty(),
			"retired cold object due-index value is corrupt"
		);
		let (delete_after_ms, object_key_hash) =
			keys::decode_branch_compaction_retired_cold_object_due_key(branch_id, &due_key)?;
		ensure!(
			delete_after_ms <= now_ms,
			"due-index scan exceeded current time"
		);
		let primary_key =
			keys::branch_compaction_retired_cold_object_key(branch_id, object_key_hash);
		let Some(primary_value) = tx_get_value(tx, &primary_key, isolation_level).await? else {
			tx.informal().clear(&due_key);
			continue;
		};
		let retired = decode_retired_cold_object(&primary_value)
			.context("decode exact due sqlite retired cold object for GC planning")?;
		ensure!(
			retired.database_branch_id == branch_id
				&& retired.delete_after_ms == delete_after_ms
				&& content_hash(retired.object_key.as_bytes()) == object_key_hash,
			"retired cold object due index does not match its primary row"
		);
		// Deleted rows are a second-stage, metadata-only GC item. The delete activity skips their
		// object key and atomically removes the primary row plus this due row.
		due.push(retired);
	}
	Ok(due)
}

pub(crate) async fn read_hot_shard_eviction_candidates(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	root: &CompactionRoot,
	branch_record: Option<&DatabaseBranchRecord>,
	shard_cache_policy: ShardCachePolicy,
	isolation_level: universaldb::utils::IsolationLevel,
	now_ms: i64,
) -> Result<(Vec<HotShardEvictionCandidate>, Option<i64>)> {
	let Some(branch_record) = branch_record.filter(|record| record.state == BranchState::Live)
	else {
		return Ok((Vec::new(), None));
	};
	let prefix = keys::branch_shard_prefix(branch_id);
	if tx_scan_range_values_limited(
		tx,
		&prefix,
		&end_of_prefix_range(&prefix),
		1,
		isolation_level,
	)
	.await?
	.is_empty()
	{
		return Ok((Vec::new(), None));
	}
	if let Some(next_eviction_at_ms) = branch_access_next_eviction_at_ms(
		tx,
		branch_id,
		shard_cache_policy,
		isolation_level,
		now_ms,
	)
	.await?
	{
		return Ok((Vec::new(), Some(next_eviction_at_ms)));
	}

	let mut candidates = Vec::new();
	let mut budget = CompactionBatchBudget::fdb();
	let cursor_key = keys::branch_hot_evict_scan_cursor_key(branch_id);
	let cursor = tx_get_value(tx, &cursor_key, isolation_level).await?;
	let start = cursor.clone().unwrap_or_else(|| prefix.clone());
	ensure!(
		start == prefix || start.starts_with(&prefix),
		"hot eviction cursor escaped branch shard prefix"
	);
	let scan_limit = CMP_FDB_BATCH_MAX_KEYS.saturating_add(1);
	let rows = tx_scan_range_values_limited(
		tx,
		&start,
		&end_of_prefix_range(&prefix),
		scan_limit,
		isolation_level,
	)
	.await?;
	for (shard_key, shard_row_value) in &rows {
		let (shard_id, as_of_txid) = keys::decode_branch_shard_key(branch_id, &shard_key)?;
		if as_of_txid > root.cold_watermark_txid {
			continue;
		}
		let exact_cold_ref_key =
			keys::branch_compaction_cold_shard_key(branch_id, shard_id, as_of_txid);
		let exact_cold_ref = tx_get_value(tx, &exact_cold_ref_key, isolation_level).await?;
		let (cold_ref_key, cold_ref_bytes) = if let Some(bytes) = exact_cold_ref {
			(exact_cold_ref_key, bytes)
		} else {
			// A PITR coverage generation can become obsolete after a later generation in the same
			// interval is published. Its exact cold ref may then be retired while a hot cache row
			// remains. Use the nearest newer published shard only when bounded PITR and history-pin
			// range proofs show that no retained historical read can select the old generation.
			let Some(next_txid) = as_of_txid.checked_add(1) else {
				continue;
			};
			let newer_start =
				keys::branch_compaction_cold_shard_key(branch_id, shard_id, next_txid);
			let newer_end = shard_id.checked_add(1).map_or_else(
				|| end_of_prefix_range(&keys::branch_compaction_cold_shard_prefix(branch_id)),
				|next_shard_id| keys::branch_compaction_cold_shard_key(branch_id, next_shard_id, 0),
			);
			let newer_rows =
				tx_scan_range_values_limited(tx, &newer_start, &newer_end, 1, isolation_level)
					.await?;
			let Some((key, bytes)) = newer_rows.into_iter().next() else {
				continue;
			};
			let (_, newer_txid) = keys::decode_branch_compaction_cold_shard_key(branch_id, &key)?;
			let ranges = [(as_of_txid, newer_txid)];
			let Some(protected_pitr_txids) =
				read_live_pitr_txids_in_ranges(tx, branch_id, &ranges, now_ms, isolation_level)
					.await?
			else {
				continue;
			};
			let pin_presence = history_pin::history_pin_presence_in_ranges(
				tx,
				branch_id,
				&ranges,
				isolation_level,
			)
			.await?;
			if pin_presence.first().copied().unwrap_or(true)
				|| protected_pitr_txids
					.range(as_of_txid..newer_txid)
					.next()
					.is_some()
			{
				continue;
			}
			(key, bytes)
		};
		let cold_ref = decode_cold_shard_ref(&cold_ref_bytes)
			.context("decode sqlite cold shard ref for hot eviction")?;
		let publish_marker = tx_get_value(
			tx,
			&keys::branch_compaction_cold_publish_key(branch_id, cold_ref.publish_generation),
			isolation_level,
		)
		.await?
		.as_deref()
		.map(decode_cold_publish_marker)
		.transpose()
		.context("decode sqlite cold publish marker for hot eviction")?;
		let shard_bytes = crate::conveyer::shard_blob::resolve_branch_shard_value(
			tx,
			branch_id,
			shard_id,
			as_of_txid,
			&shard_row_value,
			isolation_level,
		)
		.await
		.context("resolve chunked hot shard for eviction")?;
		let shard_hash = content_hash(&shard_bytes);
		if cold_ref.database_branch_id != branch_id
			|| cold_ref.lifecycle_generation != branch_record.lifecycle_generation
			|| cold_ref.shard_id != shard_id
			|| cold_ref.as_of_txid < as_of_txid
			|| cold_ref.publish_generation > root.manifest_generation
			|| (cold_ref.as_of_txid == as_of_txid
				&& (cold_ref.ltx_size_bytes != shard_bytes.len() as u64
					|| cold_ref.ltx_content_hash != shard_hash))
			|| !publish_marker
				.as_ref()
				.is_some_and(|marker| marker.matches_ref(&cold_ref))
		{
			continue;
		}
		let (physical_row_count, physical_value_bytes) =
			crate::conveyer::shard_blob::branch_shard_physical_stats(
				shard_id,
				as_of_txid,
				&shard_row_value,
			)?;
		if !budget.can_add(physical_row_count, physical_value_bytes) {
			break;
		}
		budget.add(physical_row_count, physical_value_bytes);

		candidates.push(HotShardEvictionCandidate {
			reference: HotShardEvictionRef {
				shard_id,
				as_of_txid,
				size_bytes: shard_bytes.len() as u64,
				content_hash: shard_hash,
				cold_proof_as_of_txid: (cold_ref.as_of_txid != as_of_txid)
					.then_some(cold_ref.as_of_txid),
				cold_ref_content_hash: content_hash(&cold_ref_bytes),
				cold_publish_generation: cold_ref.publish_generation,
			},
			shard_key: shard_key.clone(),
			shard_row_value: shard_row_value.clone(),
			shard_bytes,
			cold_ref_key,
			cold_ref_bytes,
			physical_row_count,
			physical_value_bytes,
		});
		if candidates.len() >= CMP_RECLAIM_CONTROL_MAX_ITEMS_PER_LANE {
			break;
		}
	}
	if candidates.is_empty() {
		if rows.len() == scan_limit {
			let next_cursor = rows.last().expect("non-empty limited page").0.clone();
			if cursor.as_deref() != Some(next_cursor.as_slice()) {
				tx.informal().set(&cursor_key, &next_cursor);
			}
		} else if cursor.is_some() {
			tx.informal().clear(&cursor_key);
		}
	}
	Ok((candidates, None))
}

pub(crate) async fn branch_access_next_eviction_at_ms(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	policy: ShardCachePolicy,
	isolation_level: universaldb::utils::IsolationLevel,
	now_ms: i64,
) -> Result<Option<i64>> {
	let Some(bytes) = tx_get_value(
		tx,
		&keys::branch_manifest_last_access_bucket_key(branch_id),
		isolation_level,
	)
	.await?
	else {
		return Ok(None);
	};
	let last_access_bucket = i64::from_le_bytes(
		bytes
			.as_slice()
			.try_into()
			.context("sqlite branch access bucket should be exactly 8 bytes")?,
	);
	Ok(next_shard_cache_eviction_at_ms(
		last_access_bucket,
		policy,
		now_ms,
	))
}

fn next_shard_cache_eviction_at_ms(
	last_access_bucket: i64,
	policy: ShardCachePolicy,
	now_ms: i64,
) -> Option<i64> {
	let current_bucket = now_ms.div_euclid(ACCESS_TOUCH_THROTTLE_MS);
	let retention_buckets = policy
		.retention_ms
		.saturating_add(ACCESS_TOUCH_THROTTLE_MS - 1)
		.div_euclid(ACCESS_TOUCH_THROTTLE_MS);
	let oldest_recent_bucket = current_bucket.saturating_sub(retention_buckets);
	if last_access_bucket < oldest_recent_bucket {
		return None;
	}
	Some(
		last_access_bucket
			.saturating_add(retention_buckets)
			.saturating_add(1)
			.saturating_mul(ACCESS_TOUCH_THROTTLE_MS),
	)
}

type PitrIntervalReclaimRows = (
	Vec<PitrIntervalSelection>,
	Vec<(i64, Vec<u8>, Vec<u8>, PitrIntervalCoverage)>,
	Vec<Vec<u8>>,
	bool,
);

pub(crate) async fn read_pitr_interval_reclaim_rows(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	now_ms: i64,
	isolation_level: universaldb::utils::IsolationLevel,
) -> Result<PitrIntervalReclaimRows> {
	let mut retained = Vec::new();
	let mut expired = Vec::new();
	let mut expired_index_keys = Vec::new();

	let due_prefix = keys::branch_pitr_interval_due_prefix(branch_id);
	let mut due_end = keys::branch_pitr_interval_due_key(branch_id, now_ms, i64::MAX);
	due_end.push(0);
	for (due_key, due_value) in tx_scan_range_values_limited(
		tx,
		&due_prefix,
		&due_end,
		CMP_COLD_DELETE_MAX_OBJECTS,
		isolation_level,
	)
	.await?
	{
		let indexed_txid = decode_txid_value(&due_value).context("decode PITR due-index txid")?;
		let (expires_at_ms, bucket_start_ms) =
			keys::decode_branch_pitr_interval_due_key(branch_id, &due_key)?;
		ensure!(
			expires_at_ms <= now_ms,
			"PITR due-index scan exceeded current time"
		);
		let primary_key = keys::branch_pitr_interval_key(branch_id, bucket_start_ms);
		let Some(primary_value) = tx_get_value(tx, &primary_key, isolation_level).await? else {
			tx.informal().clear(&due_key);
			continue;
		};
		let coverage = decode_pitr_interval_coverage(&primary_value)
			.context("decode due SQLite PITR interval coverage")?;
		if coverage.txid != indexed_txid || coverage.expires_at_ms != expires_at_ms {
			tx.informal().clear(&due_key);
			continue;
		}
		expired_index_keys.push(due_key);
		expired_index_keys.push(keys::branch_pitr_interval_by_txid_key(
			branch_id,
			coverage.txid,
			bucket_start_ms,
		));
		expired.push((bucket_start_ms, primary_key, primary_value, coverage));
	}

	let txid_prefix = keys::branch_pitr_interval_by_txid_prefix(branch_id);
	let txid_rows = tx_scan_range_values_limited(
		tx,
		&txid_prefix,
		&end_of_prefix_range(&txid_prefix),
		CMP_FDB_BATCH_MAX_KEYS.saturating_add(1),
		isolation_level,
	)
	.await?;
	let hit_limit = txid_rows.len() > CMP_FDB_BATCH_MAX_KEYS;
	let mut resolved_txid_rows =
		futures_util::stream::iter(txid_rows.into_iter().take(CMP_FDB_BATCH_MAX_KEYS))
			.map(|(index_key, index_value)| async move {
				ensure!(index_value.is_empty(), "PITR txid-index value is corrupt");
				let (txid, bucket_start_ms) =
					keys::decode_branch_pitr_interval_by_txid_key(branch_id, &index_key)?;
				let primary_value = tx_get_value(
					tx,
					&keys::branch_pitr_interval_key(branch_id, bucket_start_ms),
					Serializable,
				)
				.await?;
				Ok::<_, anyhow::Error>((txid, bucket_start_ms, index_key, primary_value))
			})
			.buffer_unordered(32)
			.try_collect::<Vec<_>>()
			.await?;
	resolved_txid_rows.sort_unstable_by_key(|(txid, bucket, _, _)| (*txid, *bucket));
	for (txid, bucket_start_ms, index_key, primary_value) in resolved_txid_rows {
		let Some(primary_value) = primary_value else {
			tx.informal().clear(&index_key);
			continue;
		};
		let coverage = decode_pitr_interval_coverage(&primary_value)
			.context("decode PITR txid-index primary coverage")?;
		if coverage.txid != txid {
			tx.informal().clear(&index_key);
			continue;
		}
		if coverage.expires_at_ms > now_ms {
			retained.push(PitrIntervalSelection {
				bucket_start_ms,
				coverage,
			});
			return Ok((retained, expired, expired_index_keys, true));
		}
	}

	Ok((retained, expired, expired_index_keys, !hit_limit))
}

pub(crate) async fn read_live_pitr_txids_in_ranges(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	ranges: &[(u64, u64)],
	now_ms: i64,
	isolation_level: universaldb::utils::IsolationLevel,
) -> Result<Option<BTreeSet<u64>>> {
	let mut merged = ranges
		.iter()
		.copied()
		.filter(|(start, end)| start < end)
		.collect::<Vec<_>>();
	merged.sort_unstable();
	let mut merged_ranges = Vec::<(u64, u64)>::new();
	for (start, end) in merged {
		if let Some((_, previous_end)) = merged_ranges.last_mut()
			&& start <= *previous_end
		{
			*previous_end = (*previous_end).max(end);
		} else {
			merged_ranges.push((start, end));
		}
	}

	let mut rows = Vec::new();
	for (min_txid, max_txid_exclusive) in merged_ranges {
		let remaining = CMP_FDB_BATCH_MAX_KEYS
			.saturating_add(1)
			.saturating_sub(rows.len());
		if remaining == 0 {
			return Ok(None);
		}
		// A txid prefix is the correct lexical lower bound. Using i64::MIN as the
		// bucket suffix would start at 0x80 and skip normal positive timestamps.
		let start = keys::branch_pitr_interval_by_txid_txid_prefix(branch_id, min_txid);
		let end = keys::branch_pitr_interval_by_txid_txid_prefix(branch_id, max_txid_exclusive);
		rows.extend(
			tx_scan_range_values_limited(tx, &start, &end, remaining, isolation_level).await?,
		);
		if rows.len() > CMP_FDB_BATCH_MAX_KEYS {
			return Ok(None);
		}
	}

	let resolved_rows = futures_util::stream::iter(rows)
		.map(|(index_key, index_value)| async move {
			ensure!(index_value.is_empty(), "PITR txid-index value is corrupt");
			let (txid, bucket_start_ms) =
				keys::decode_branch_pitr_interval_by_txid_key(branch_id, &index_key)?;
			let primary_value = tx_get_value(
				tx,
				&keys::branch_pitr_interval_key(branch_id, bucket_start_ms),
				Serializable,
			)
			.await?;
			Ok::<_, anyhow::Error>((txid, primary_value))
		})
		.buffer_unordered(32)
		.try_collect::<Vec<_>>()
		.await?;
	let mut protected = BTreeSet::new();
	for (txid, primary_value) in resolved_rows {
		let Some(primary_value) = primary_value else {
			continue;
		};
		let coverage = decode_pitr_interval_coverage(&primary_value)
			.context("decode protected PITR interval coverage")?;
		if coverage.txid == txid && coverage.expires_at_ms > now_ms {
			protected.insert(txid);
		}
	}
	Ok(Some(protected))
}

pub(crate) fn reclaim_delete_upper_bound(
	root: &CompactionRoot,
	earliest_history_pin_txid: Option<u64>,
	pitr_interval_retention: &[PitrIntervalSelection],
) -> Option<u64> {
	if root.hot_watermark_txid == 0 {
		return None;
	}

	let pinned_floor = earliest_history_pin_txid
		.filter(|txid| *txid <= root.hot_watermark_txid)
		.into_iter()
		.chain(
			pitr_interval_retention
				.iter()
				.filter(|selection| selection.coverage.txid <= root.hot_watermark_txid)
				.map(|selection| selection.coverage.txid),
		)
		.min();
	let max_reclaim_txid = pinned_floor
		.map(|txid| txid.saturating_sub(1))
		.unwrap_or(root.hot_watermark_txid);

	(max_reclaim_txid > 0).then_some(max_reclaim_txid)
}

pub(crate) fn reclaim_delta_shard_ids(
	branch_id: DatabaseBranchId,
	delta_chunks: &[(Vec<u8>, Vec<u8>)],
) -> Result<BTreeSet<u32>> {
	let deltas = decode_hot_delta_chunks(branch_id, delta_chunks)?;
	let mut shard_ids = BTreeSet::new();
	for delta in deltas.values() {
		for page in &delta.pages {
			shard_ids.insert(page.pgno / keys::SHARD_SIZE);
		}
	}
	Ok(shard_ids)
}

pub(crate) fn reclaim_coverage_is_complete(snapshot: &ReclaimInputSnapshot) -> bool {
	!snapshot.delta_chunks.is_empty()
		&& snapshot.required_coverage_shard_count > 0
		&& snapshot.coverage_shards.len() == snapshot.required_coverage_shard_count
}

pub(crate) fn selected_hot_coverage_txids(
	root: &CompactionRoot,
	selected_max_txid: u64,
	history_pin_txids: &[u64],
	pitr_interval_coverage: &[PitrIntervalSelection],
) -> Vec<u64> {
	let mut coverage_txids = BTreeSet::new();
	coverage_txids.insert(selected_max_txid);

	for txid in history_pin_txids {
		if *txid > root.hot_watermark_txid && *txid <= selected_max_txid {
			coverage_txids.insert(*txid);
		}
	}
	for selection in pitr_interval_coverage {
		let txid = selection.coverage.txid;
		if txid > root.hot_watermark_txid && txid <= selected_max_txid {
			coverage_txids.insert(txid);
		}
	}

	coverage_txids.into_iter().collect()
}

pub(crate) fn plan_hot_job(
	database_branch_id: DatabaseBranchId,
	snapshot: &ManagerFdbSnapshot,
	job_id: Id,
	now_ms: i64,
	force: bool,
) -> Option<PlannedHotCompactionJob> {
	let branch_record = snapshot.branch_record.as_ref()?;
	let head = snapshot.head.as_ref()?;
	if head.head_txid <= snapshot.root.hot_watermark_txid {
		return None;
	}
	let hot_lag = head
		.head_txid
		.saturating_sub(snapshot.root.hot_watermark_txid);
	let selected_max_txid = snapshot.hot_inputs.selected_max_txid?;
	let coverage_txids = selected_hot_coverage_txids(
		&snapshot.root,
		selected_max_txid,
		&snapshot.hot_inputs.history_pin_txids,
		&snapshot.hot_inputs.pitr_interval_coverage,
	);
	let has_uncovered_pin = coverage_txids
		.iter()
		.any(|txid| *txid != selected_max_txid && *txid > snapshot.root.hot_watermark_txid);
	if hot_lag < quota::compaction_delta_threshold(database_branch_id)
		&& !has_uncovered_pin
		&& !force
	{
		return None;
	}

	let input_range = HotJobInputRange {
		txids: TxidRange {
			min_txid: snapshot.root.hot_watermark_txid.saturating_add(1),
			max_txid: selected_max_txid,
		},
		coverage_txids: coverage_txids.clone(),
		max_pages: u32::try_from(snapshot.hot_inputs.pidx_entries.len()).unwrap_or(u32::MAX),
		max_bytes: snapshot.hot_inputs.total_value_bytes,
	};
	let input_fingerprint = fingerprint_hot_inputs(
		database_branch_id,
		&snapshot.root,
		&coverage_txids,
		&snapshot.hot_inputs,
	);

	Some(PlannedHotCompactionJob {
		database_branch_id,
		job_id,
		base_lifecycle_generation: branch_record.lifecycle_generation,
		base_manifest_generation: snapshot.root.manifest_generation,
		input_fingerprint,
		input_range,
		planned_at_ms: now_ms,
		attempt: 0,
	})
}

pub(crate) fn plan_cold_job(
	database_branch_id: DatabaseBranchId,
	snapshot: &ManagerFdbSnapshot,
	job_id: Id,
	now_ms: i64,
	force: bool,
) -> Option<PlannedColdCompactionJob> {
	let branch_record = snapshot.branch_record.as_ref()?;
	let selected_min_txid = snapshot.cold_inputs.selected_min_txid?;
	let selected_max_txid = snapshot.cold_inputs.selected_max_txid?;
	if snapshot.cold_inputs.shard_inputs.is_empty() {
		return None;
	}
	if !force && snapshot.root.hot_watermark_txid <= snapshot.root.cold_watermark_txid {
		return None;
	}

	let input_range = ColdJobInputRange {
		txids: TxidRange {
			min_txid: selected_min_txid,
			max_txid: selected_max_txid,
		},
		min_versionstamp: snapshot.cold_inputs.min_versionstamp,
		max_versionstamp: snapshot.cold_inputs.max_versionstamp,
		input_summary: summarize_cold_input_refs(&snapshot.cold_inputs.shard_inputs),
		max_bytes: snapshot.cold_inputs.total_value_bytes,
	};
	let input_fingerprint =
		fingerprint_cold_inputs(database_branch_id, &snapshot.root, &snapshot.cold_inputs);

	Some(PlannedColdCompactionJob {
		database_branch_id,
		job_id,
		base_lifecycle_generation: branch_record.lifecycle_generation,
		base_manifest_generation: snapshot.root.manifest_generation,
		input_fingerprint,
		input_range,
		planned_at_ms: now_ms,
		attempt: 0,
	})
}

pub(crate) fn plan_reclaim_job(
	database_branch_id: DatabaseBranchId,
	snapshot: &ManagerFdbSnapshot,
	job_id: Id,
	now_ms: i64,
) -> Option<PlannedReclaimCompactionJob> {
	let branch_record = snapshot.branch_record.as_ref()?;
	let has_orphan_cold_upload = snapshot.orphan_cold_upload_job_id.is_some();
	// Give exact-key orphan cleanup its own job even when ordinary reclaim is also ready. This
	// keeps an interrupted COS upload independent from commit retirement, cold-object GC, and hot
	// eviction in every watermark state. Normal reclaim is planned on the next manager refresh.
	let orphan_only = has_orphan_cold_upload;
	// Keep commit/VTX/delta rows until the matching hot generation is uploaded and atomically
	// published. COS outage therefore grows backlog and prevents eviction without affecting commits.
	if snapshot.cold_storage_enabled
		&& snapshot.root.cold_watermark_txid < snapshot.root.hot_watermark_txid
		&& !has_orphan_cold_upload
	{
		return None;
	}
	if snapshot.bucket_proof_blocked_reclaim && !has_orphan_cold_upload {
		return None;
	}
	let has_hot_reclaim = !orphan_only
		&& !snapshot.reclaim_inputs.txid_refs.is_empty()
		&& snapshot.reclaim_inputs.pidx_entries.is_empty()
		&& reclaim_coverage_is_complete(&snapshot.reclaim_inputs);
	let has_interval_cleanup = !orphan_only
		&& !snapshot
			.reclaim_inputs
			.expired_pitr_interval_rows
			.is_empty();
	let has_hot_shard_eviction =
		!orphan_only && !snapshot.reclaim_inputs.hot_shard_evictions.is_empty();
	let has_cold_retirement = !orphan_only && !snapshot.reclaim_inputs.cold_object_refs.is_empty();
	let has_cold_gc = !orphan_only && !snapshot.reclaim_inputs.retired_cold_objects.is_empty();
	if !has_hot_reclaim
		&& !has_hot_shard_eviction
		&& !has_interval_cleanup
		&& !has_cold_retirement
		&& !has_cold_gc
		&& !has_orphan_cold_upload
	{
		return None;
	}

	let min_txid = snapshot
		.reclaim_inputs
		.txid_refs
		.first()
		.map(|txid_ref| txid_ref.txid)
		.unwrap_or(snapshot.root.hot_watermark_txid);
	let max_txid = snapshot
		.reclaim_inputs
		.txid_refs
		.last()
		.map(|txid_ref| txid_ref.txid)
		.unwrap_or(snapshot.root.hot_watermark_txid);
	let input_range = ReclaimJobInputRange {
		txids: TxidRange { min_txid, max_txid },
		txid_refs: if has_hot_reclaim {
			snapshot.reclaim_inputs.txid_refs.clone()
		} else {
			Vec::new()
		},
		cold_objects: if has_cold_retirement {
			snapshot.reclaim_inputs.cold_object_refs.clone()
		} else {
			Vec::new()
		},
		retired_cold_objects: if has_cold_gc {
			snapshot.reclaim_inputs.retired_cold_objects.clone()
		} else {
			Vec::new()
		},
		hot_shard_evictions: if has_hot_shard_eviction {
			snapshot
				.reclaim_inputs
				.hot_shard_evictions
				.iter()
				.map(|candidate| candidate.reference.clone())
				.collect()
		} else {
			Vec::new()
		},
		orphan_cold_upload_job_id: snapshot.orphan_cold_upload_job_id,
		staged_hot_shards: Vec::new(),
		max_keys: CMP_RECLAIM_FDB_BATCH_MAX_KEYS as u32,
		max_bytes: CMP_FDB_BATCH_MAX_VALUE_BYTES as u64,
	};
	let input_fingerprint =
		fingerprint_reclaim_inputs(database_branch_id, &snapshot.root, &snapshot.reclaim_inputs);

	Some(PlannedReclaimCompactionJob {
		database_branch_id,
		job_id,
		base_lifecycle_generation: branch_record.lifecycle_generation,
		base_manifest_generation: snapshot.root.manifest_generation,
		input_fingerprint,
		input_range,
		planned_at_ms: now_ms,
		attempt: 0,
	})
}

pub(crate) fn reclaim_noop_reason(snapshot: &ManagerFdbSnapshot) -> &'static str {
	if snapshot.bucket_proof_blocked_reclaim {
		return "reclaim:bucket-proof-blocked";
	}

	let has_hot_inputs = !snapshot.reclaim_inputs.txid_refs.is_empty();
	let has_hot_shard_evictions = !snapshot.reclaim_inputs.hot_shard_evictions.is_empty();
	let has_cold_work = !snapshot.reclaim_inputs.cold_object_refs.is_empty()
		|| !snapshot.reclaim_inputs.retired_cold_objects.is_empty()
		|| snapshot.orphan_cold_upload_job_id.is_some();
	if !has_hot_inputs && !has_hot_shard_evictions && !has_cold_work {
		if snapshot
			.reclaim_inputs
			.expired_pitr_interval_rows
			.is_empty()
		{
			return "reclaim:no-actionable-work";
		}
		return "reclaim:expired-pitr-intervals";
	}

	if !snapshot.reclaim_inputs.pidx_entries.is_empty() {
		return "reclaim:pidx-dependencies";
	}

	if has_hot_inputs && !reclaim_coverage_is_complete(&snapshot.reclaim_inputs) {
		return "reclaim:missing-shard-coverage";
	}

	"reclaim:no-actionable-work"
}

pub(crate) fn fingerprint_hot_inputs(
	database_branch_id: DatabaseBranchId,
	root: &CompactionRoot,
	coverage_txids: &[u64],
	hot_inputs: &HotInputSnapshot,
) -> CompactionInputFingerprint {
	let mut fingerprint = Sha256::new();
	update_fingerprint(&mut fingerprint, b"hot-committed-prefix-v2");
	update_fingerprint(&mut fingerprint, database_branch_id.as_uuid().as_bytes());
	update_fingerprint(&mut fingerprint, &root.manifest_generation.to_be_bytes());
	update_fingerprint(&mut fingerprint, &root.hot_watermark_txid.to_be_bytes());
	update_fingerprint(
		&mut fingerprint,
		&hot_inputs.selected_max_txid.unwrap_or(0).to_be_bytes(),
	);
	match hot_inputs.mutable_head_fence {
		Some(txid) => {
			update_fingerprint(&mut fingerprint, &[1]);
			update_fingerprint(&mut fingerprint, &txid.to_be_bytes());
		}
		None => update_fingerprint(&mut fingerprint, &[0]),
	}
	for txid in coverage_txids {
		update_fingerprint(&mut fingerprint, &txid.to_be_bytes());
	}
	for selection in &hot_inputs.pitr_interval_coverage {
		update_fingerprint(&mut fingerprint, &selection.bucket_start_ms.to_be_bytes());
		update_fingerprint(&mut fingerprint, &selection.coverage.txid.to_be_bytes());
		update_fingerprint(&mut fingerprint, &selection.coverage.versionstamp);
		update_fingerprint(
			&mut fingerprint,
			&selection.coverage.wall_clock_ms.to_be_bytes(),
		);
		update_fingerprint(
			&mut fingerprint,
			&selection.coverage.expires_at_ms.to_be_bytes(),
		);
	}
	for (txid, commit) in &hot_inputs.commits {
		update_fingerprint(&mut fingerprint, &txid.to_be_bytes());
		update_fingerprint(&mut fingerprint, &commit.wall_clock_ms.to_be_bytes());
		update_fingerprint(&mut fingerprint, &commit.versionstamp);
		update_fingerprint(&mut fingerprint, &commit.db_size_pages.to_be_bytes());
		update_fingerprint(&mut fingerprint, &commit.post_apply_checksum.to_be_bytes());
	}
	for (key, value) in &hot_inputs.delta_chunks {
		update_fingerprint(&mut fingerprint, key);
		update_fingerprint(&mut fingerprint, value);
	}
	// PIDX is the mutable latest-owner index, not an input to prefix materialization. Installation
	// reads it again with Serializable isolation and only retires owners inside this prefix.
	finish_fingerprint(fingerprint)
}

pub(crate) fn fingerprint_reclaim_inputs(
	database_branch_id: DatabaseBranchId,
	root: &CompactionRoot,
	reclaim_inputs: &ReclaimInputSnapshot,
) -> CompactionInputFingerprint {
	let mut fingerprint = Sha256::new();
	update_fingerprint(
		&mut fingerprint,
		&[u8::from(reclaim_inputs.pitr_proof_complete)],
	);
	update_fingerprint(&mut fingerprint, database_branch_id.as_uuid().as_bytes());
	update_fingerprint(&mut fingerprint, &root.manifest_generation.to_be_bytes());
	update_fingerprint(&mut fingerprint, &root.hot_watermark_txid.to_be_bytes());
	for txid_ref in &reclaim_inputs.txid_refs {
		update_fingerprint(&mut fingerprint, &txid_ref.txid.to_be_bytes());
		update_fingerprint(&mut fingerprint, &txid_ref.versionstamp);
	}
	for cold_object in &reclaim_inputs.cold_object_refs {
		update_fingerprint(&mut fingerprint, cold_object.object_key.as_bytes());
		update_fingerprint(
			&mut fingerprint,
			&cold_object.object_generation_id.as_bytes(),
		);
		update_fingerprint(&mut fingerprint, &cold_object.content_hash);
		update_fingerprint(
			&mut fingerprint,
			&cold_object.publish_generation.to_be_bytes(),
		);
		update_fingerprint(&mut fingerprint, &cold_object.shard_id.to_be_bytes());
		update_fingerprint(&mut fingerprint, &cold_object.as_of_txid.to_be_bytes());
	}
	for retired in &reclaim_inputs.retired_cold_objects {
		update_fingerprint(&mut fingerprint, retired.object_key.as_bytes());
		update_fingerprint(&mut fingerprint, &retired.object_generation_id.as_bytes());
		update_fingerprint(&mut fingerprint, &retired.content_hash);
		update_fingerprint(&mut fingerprint, &retired.shard_id.to_be_bytes());
		update_fingerprint(&mut fingerprint, &retired.as_of_txid.to_be_bytes());
		update_fingerprint(&mut fingerprint, &retired.publish_generation.to_be_bytes());
		update_fingerprint(
			&mut fingerprint,
			&retired.retired_manifest_generation.to_be_bytes(),
		);
		update_fingerprint(&mut fingerprint, &retired.retired_at_ms.to_be_bytes());
		update_fingerprint(&mut fingerprint, &retired.retired_versionstamp);
		update_fingerprint(&mut fingerprint, &retired.delete_after_ms.to_be_bytes());
		let delete_state_tag = match retired.delete_state {
			RetiredColdObjectDeleteState::Retired => 0,
			RetiredColdObjectDeleteState::DeleteIssued => 1,
			RetiredColdObjectDeleteState::Deleted => 2,
		};
		update_fingerprint(&mut fingerprint, &[delete_state_tag]);
	}
	for candidate in &reclaim_inputs.hot_shard_evictions {
		update_fingerprint(
			&mut fingerprint,
			&candidate.reference.shard_id.to_be_bytes(),
		);
		update_fingerprint(
			&mut fingerprint,
			&candidate.reference.as_of_txid.to_be_bytes(),
		);
		update_fingerprint(
			&mut fingerprint,
			&candidate.reference.size_bytes.to_be_bytes(),
		);
		update_fingerprint(&mut fingerprint, &candidate.reference.content_hash);
		update_fingerprint(
			&mut fingerprint,
			&candidate.reference.cold_proof_as_of_txid().to_be_bytes(),
		);
		update_fingerprint(&mut fingerprint, &candidate.reference.cold_ref_content_hash);
		update_fingerprint(
			&mut fingerprint,
			&candidate.reference.cold_publish_generation.to_be_bytes(),
		);
		update_fingerprint(&mut fingerprint, &candidate.shard_key);
		update_fingerprint(&mut fingerprint, &candidate.shard_bytes);
		update_fingerprint(&mut fingerprint, &candidate.cold_ref_key);
		update_fingerprint(&mut fingerprint, &candidate.cold_ref_bytes);
	}
	for (txid, key, value, commit) in &reclaim_inputs.commits {
		update_fingerprint(&mut fingerprint, &txid.to_be_bytes());
		update_fingerprint(&mut fingerprint, key);
		update_fingerprint(&mut fingerprint, value);
		update_fingerprint(&mut fingerprint, &commit.versionstamp);
	}
	for (key, value) in &reclaim_inputs.delta_chunks {
		update_fingerprint(&mut fingerprint, key);
		update_fingerprint(&mut fingerprint, value);
	}
	for (txid, key, value) in &reclaim_inputs.page_history_entries {
		update_fingerprint(&mut fingerprint, &txid.to_be_bytes());
		update_fingerprint(&mut fingerprint, key);
		update_fingerprint(&mut fingerprint, value);
	}
	for (key, value) in &reclaim_inputs.pidx_entries {
		update_fingerprint(&mut fingerprint, key);
		update_fingerprint(&mut fingerprint, value);
	}
	for (key, value) in &reclaim_inputs.coverage_shards {
		update_fingerprint(&mut fingerprint, key);
		update_fingerprint(&mut fingerprint, value);
	}
	for (bucket_start_ms, key, value, coverage) in &reclaim_inputs.expired_pitr_interval_rows {
		update_fingerprint(&mut fingerprint, &bucket_start_ms.to_be_bytes());
		update_fingerprint(&mut fingerprint, key);
		update_fingerprint(&mut fingerprint, value);
		update_fingerprint(&mut fingerprint, &coverage.txid.to_be_bytes());
		update_fingerprint(&mut fingerprint, &coverage.versionstamp);
		update_fingerprint(&mut fingerprint, &coverage.wall_clock_ms.to_be_bytes());
		update_fingerprint(&mut fingerprint, &coverage.expires_at_ms.to_be_bytes());
	}
	for key in &reclaim_inputs.expired_pitr_interval_index_keys {
		update_fingerprint(&mut fingerprint, key);
	}
	finish_fingerprint(fingerprint)
}

pub(crate) fn fingerprint_cold_inputs(
	database_branch_id: DatabaseBranchId,
	root: &CompactionRoot,
	cold_inputs: &ColdInputSnapshot,
) -> CompactionInputFingerprint {
	let mut fingerprint = Sha256::new();
	update_fingerprint(&mut fingerprint, database_branch_id.as_uuid().as_bytes());
	update_fingerprint(&mut fingerprint, &root.manifest_generation.to_be_bytes());
	update_fingerprint(&mut fingerprint, &root.hot_watermark_txid.to_be_bytes());
	update_fingerprint(&mut fingerprint, &root.cold_watermark_txid.to_be_bytes());
	update_fingerprint(&mut fingerprint, &root.cold_watermark_versionstamp);
	update_fingerprint(&mut fingerprint, &cold_inputs.min_versionstamp);
	update_fingerprint(&mut fingerprint, &cold_inputs.max_versionstamp);
	for input in &cold_inputs.shard_inputs {
		update_fingerprint(&mut fingerprint, &input.shard_id.to_be_bytes());
		update_fingerprint(&mut fingerprint, &input.as_of_txid.to_be_bytes());
		update_fingerprint(&mut fingerprint, &input.size_bytes.to_be_bytes());
		update_fingerprint(&mut fingerprint, &input.content_hash);
	}
	finish_fingerprint(fingerprint)
}

pub(crate) fn fingerprint_repair_reclaim_range(
	database_branch_id: DatabaseBranchId,
	input_range: &ReclaimJobInputRange,
) -> CompactionInputFingerprint {
	let mut fingerprint = Sha256::new();
	update_fingerprint(&mut fingerprint, database_branch_id.as_uuid().as_bytes());
	update_fingerprint(&mut fingerprint, &input_range.txids.min_txid.to_be_bytes());
	update_fingerprint(&mut fingerprint, &input_range.txids.max_txid.to_be_bytes());
	for staged in &input_range.staged_hot_shards {
		update_fingerprint(&mut fingerprint, &staged.job_id.as_bytes());
		update_fingerprint(&mut fingerprint, &staged.output_ref.shard_id.to_be_bytes());
		update_fingerprint(
			&mut fingerprint,
			&staged.output_ref.as_of_txid.to_be_bytes(),
		);
		update_fingerprint(
			&mut fingerprint,
			&staged.output_ref.size_bytes.to_be_bytes(),
		);
		update_fingerprint(&mut fingerprint, &staged.output_ref.content_hash);
	}
	finish_fingerprint(fingerprint)
}

pub(crate) fn update_fingerprint(fingerprint: &mut Sha256, bytes: &[u8]) {
	fingerprint.update((bytes.len() as u64).to_be_bytes());
	fingerprint.update(bytes);
}

pub(crate) fn finish_fingerprint(fingerprint: Sha256) -> CompactionInputFingerprint {
	let digest = fingerprint.finalize();
	let mut output = [0_u8; 32];
	output.copy_from_slice(&digest);
	output
}

pub(crate) fn plan_staged_hot_shards(
	input: &StageHotJobInput,
	hot_inputs: &HotInputSnapshot,
) -> Result<Vec<PreparedHotShard>> {
	let deltas = decode_hot_delta_chunks(input.database_branch_id, &hot_inputs.delta_chunks)?;
	let coverage = input
		.input_range
		.coverage_txids
		.iter()
		.map(|as_of_txid| {
			let db_size_pages = hot_inputs
				.commits
				.iter()
				.find_map(|(txid, commit)| (*txid == *as_of_txid).then_some(commit.db_size_pages))
				.context("hot compaction coverage commit row is missing")?;
			Ok((*as_of_txid, db_size_pages))
		})
		.collect::<Result<Vec<_>>>()?;
	plan_hot_coverage_shards(&coverage, deltas.into_iter())
}

/// Fold each selected DELTA once across all historical outputs. Only the unavoidable output
/// snapshots copy page bytes; earlier commits are not reapplied for every PITR/history pin.
/// Sorting a local index preserves the caller's output order, including duplicate coverages.
fn plan_hot_coverage_shards(
	coverage: &[(u64, u32)],
	deltas: impl Iterator<Item = (u64, DecodedLtx)>,
) -> Result<Vec<PreparedHotShard>> {
	let mut requested = coverage.iter().copied().enumerate().collect::<Vec<_>>();
	requested.sort_by_key(|(_, (txid, _))| *txid);
	let max_db_size_pages = coverage.iter().map(|(_, size)| *size).max().unwrap_or(0);
	let mut deltas = deltas.peekable();
	let mut pages_by_number = BTreeMap::<u32, Vec<u8>>::new();
	let mut previous_db_size_pages = None;
	let mut outputs = Vec::with_capacity(coverage.len());
	let mut row_count = 0;

	for (index, (as_of_txid, db_size_pages)) in requested {
		while deltas.peek().is_some_and(|(txid, _)| *txid <= as_of_txid) {
			let (_, delta) = deltas.next().context("peeked hot delta is missing")?;
			// EOF applies at every commit, not just at output boundaries. Retaining a page
			// across a shrink and later growth would resurrect deleted historical contents.
			if previous_db_size_pages.is_some_and(|size| delta.header.commit < size) {
				pages_by_number.retain(|pgno, _| *pgno <= delta.header.commit);
			}
			previous_db_size_pages = Some(delta.header.commit);
			for page in delta.pages {
				if page.pgno <= max_db_size_pages {
					pages_by_number.insert(page.pgno, page.bytes);
				}
			}
		}
		let mut pages_by_shard = BTreeMap::<u32, Vec<(u32, Vec<u8>)>>::new();
		for (pgno, bytes) in pages_by_number.range(..=db_size_pages) {
			pages_by_shard
				.entry(pgno / keys::SHARD_SIZE)
				.or_default()
				.push((*pgno, bytes.clone()));
		}
		row_count += pages_by_shard.len();
		ensure!(
			row_count <= CMP_FDB_BATCH_MAX_KEYS,
			"planned hot job produced {row_count} staged shard rows, exceeding the {}-row FDB job limit",
			CMP_FDB_BATCH_MAX_KEYS
		);
		let mut shards = Vec::with_capacity(pages_by_shard.len());

		for (shard_id, page_updates) in pages_by_shard {
			shards.push(PreparedHotShard {
				shard_id,
				as_of_txid,
				page_updates,
			});
		}
		outputs.push((index, shards));
	}
	outputs.sort_by_key(|(index, _)| *index);
	Ok(outputs.into_iter().flat_map(|(_, shards)| shards).collect())
}

/// Expands exactly one planned shard from its immutable base. Callers run this in a dedicated
/// short transaction so a sparse generation touching many full shards cannot combine all of
/// their bodies into one FDB read version.
pub(crate) async fn materialize_prepared_hot_shard(
	tx: &universaldb::Transaction,
	input: &StageHotJobInput,
	prepared: PreparedHotShard,
	base_hot_watermark_txid: u64,
) -> Result<PreparedHotShardOutput> {
	let encoded = build_staged_hot_shard_blob(
		tx,
		input.database_branch_id,
		prepared.shard_id,
		prepared.as_of_txid,
		base_hot_watermark_txid,
		prepared.page_updates,
	)
	.await?;
	ensure!(
		encoded.len() <= crate::MAX_HOT_SHARD_BLOB_BYTES,
		"materialized hot shard exceeded the physical per-transaction byte limit"
	);
	let stage_key = keys::branch_compaction_stage_hot_shard_key(
		input.database_branch_id,
		input.job_id,
		prepared.shard_id,
		prepared.as_of_txid,
		0,
	);
	let content_hash = content_hash(&encoded);
	let size_bytes = u64::try_from(encoded.len()).unwrap_or(u64::MAX);
	let output_ref = HotShardOutputRef {
		shard_id: prepared.shard_id,
		as_of_txid: prepared.as_of_txid,
		min_txid: input.input_range.txids.min_txid,
		max_txid: prepared.as_of_txid,
		size_bytes,
		content_hash,
	};
	let stage_proof = encode_hot_shard_stage_proof(HotShardStageProof {
		database_branch_id: input.database_branch_id,
		job_id: input.job_id,
		shard_id: output_ref.shard_id,
		as_of_txid: output_ref.as_of_txid,
		min_txid: output_ref.min_txid,
		max_txid: output_ref.max_txid,
		size_bytes,
		content_hash,
	})
	.context("encode staged hot shard publication proof")?;

	Ok(PreparedHotShardOutput {
		output_ref,
		stage_key,
		stage_proof,
		blob: encoded,
	})
}

pub(crate) fn decode_hot_delta_chunks(
	branch_id: DatabaseBranchId,
	delta_chunks: &[(Vec<u8>, Vec<u8>)],
) -> Result<BTreeMap<u64, DecodedLtx>> {
	let mut chunks_by_txid = BTreeMap::<u64, BTreeMap<u32, Vec<u8>>>::new();
	for (key, value) in delta_chunks {
		let txid = keys::decode_branch_delta_chunk_txid(branch_id, key)?;
		let chunk_idx = keys::decode_branch_delta_chunk_idx(branch_id, txid, key)?;
		chunks_by_txid
			.entry(txid)
			.or_default()
			.insert(chunk_idx, value.clone());
	}

	chunks_by_txid
		.into_iter()
		.map(|(txid, chunks)| {
			let bytes = chunks.into_values().flatten().collect::<Vec<_>>();
			let decoded =
				decode_ltx_v3(&bytes).with_context(|| format!("decode hot delta {txid}"))?;

			Ok((txid, decoded))
		})
		.collect()
}

#[cfg(test)]
pub(crate) fn collect_hot_pages_by_shard(
	db_size_pages: u32,
	deltas: &BTreeMap<u64, DecodedLtx>,
	as_of_txid: u64,
) -> Result<BTreeMap<u32, Vec<(u32, Vec<u8>)>>> {
	let mut pages_by_number = BTreeMap::<u32, Vec<u8>>::new();
	let mut previous_db_size_pages = None;

	for (txid, delta) in deltas {
		if *txid > as_of_txid {
			continue;
		}
		// Apply every intervening EOF before later growth; a final-size-only filter would
		// resurrect removed pages from an earlier DELTA in the same batch.
		if previous_db_size_pages.is_some_and(|size| delta.header.commit < size) {
			pages_by_number.retain(|pgno, _| *pgno <= delta.header.commit);
		}
		previous_db_size_pages = Some(delta.header.commit);
		for page in &delta.pages {
			if page.pgno <= db_size_pages {
				pages_by_number.insert(page.pgno, page.bytes.clone());
			}
		}
	}

	let mut pages_by_shard = BTreeMap::<u32, Vec<(u32, Vec<u8>)>>::new();
	for (pgno, bytes) in pages_by_number {
		pages_by_shard
			.entry(pgno / keys::SHARD_SIZE)
			.or_default()
			.push((pgno, bytes));
	}
	Ok(pages_by_shard)
}

pub(crate) async fn build_staged_hot_shard_blob(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	shard_id: u32,
	as_of_txid: u64,
	base_hot_watermark_txid: u64,
	page_updates: Vec<(u32, Vec<u8>)>,
) -> Result<Vec<u8>> {
	ensure!(
		base_hot_watermark_txid < as_of_txid,
		"hot shard base watermark must be older than its output txid"
	);
	// Ignore prepublished outputs from this or an abandoned job. Only a shard at or below the
	// atomically published hot watermark is an authoritative merge base.
	let existing_blob =
		load_latest_branch_shard_blob(tx, branch_id, shard_id, base_hot_watermark_txid).await?;
	let mut merged_pages = BTreeMap::<u32, Vec<u8>>::new();
	let mut timestamp_ms = 0;

	if let Some(existing_blob) = existing_blob {
		let decoded = decode_ltx_v3(&existing_blob).context("decode existing branch shard blob")?;
		timestamp_ms = decoded.header.timestamp_ms;
		for page in decoded.pages {
			if page.pgno / keys::SHARD_SIZE == shard_id {
				ensure!(
					page.bytes.len() == keys::PAGE_SIZE as usize,
					"page {} had {} bytes, expected {}",
					page.pgno,
					page.bytes.len(),
					keys::PAGE_SIZE
				);
				merged_pages.insert(page.pgno, page.bytes);
			}
		}
	}

	for (pgno, bytes) in page_updates {
		ensure!(pgno > 0, "page number must be greater than zero");
		ensure!(
			pgno / keys::SHARD_SIZE == shard_id,
			"page {} does not belong to shard {}",
			pgno,
			shard_id
		);
		ensure!(
			bytes.len() == keys::PAGE_SIZE as usize,
			"page {} had {} bytes, expected {}",
			pgno,
			bytes.len(),
			keys::PAGE_SIZE
		);
		merged_pages.insert(pgno, bytes);
	}

	let pages = merged_pages
		.into_iter()
		.map(|(pgno, bytes)| DirtyPage { pgno, bytes })
		.collect::<Vec<_>>();
	let commit = pages.iter().map(|page| page.pgno).max().unwrap_or(1);
	let header = LtxHeader::delta(as_of_txid, commit, timestamp_ms);

	encode_ltx_v3(header, &pages).context("encode staged hot shard blob")
}

pub(crate) async fn load_latest_branch_shard_blob(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	shard_id: u32,
	as_of_txid: u64,
) -> Result<Option<Vec<u8>>> {
	let prefix = keys::branch_shard_version_prefix(branch_id, shard_id);
	let end = end_of_key_range(&keys::branch_shard_key(branch_id, shard_id, as_of_txid));
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Iterator,
			reverse: true,
			limit: Some(1),
			..(prefix.as_slice(), end.as_slice()).into()
		},
		Snapshot,
	);

	let mut latest = None;
	while let Some(entry) = stream.try_next().await? {
		let key = entry.key().to_vec();
		let (latest_shard_id, latest_as_of_txid) = keys::decode_branch_shard_key(branch_id, &key)?;
		ensure!(latest_shard_id == shard_id && latest_as_of_txid <= as_of_txid);
		latest = Some(
			crate::conveyer::shard_blob::resolve_branch_shard_value(
				tx,
				branch_id,
				latest_shard_id,
				latest_as_of_txid,
				entry.value(),
				Snapshot,
			)
			.await
			.context("resolve existing chunked branch shard")?,
		);
	}

	Ok(latest)
}

pub(crate) fn decode_branch_pidx_pgno(branch_id: DatabaseBranchId, key: &[u8]) -> Result<u32> {
	let prefix = keys::branch_pidx_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("branch PIDX key did not start with expected prefix")?;
	let bytes: [u8; std::mem::size_of::<u32>()] = suffix
		.try_into()
		.map_err(|_| anyhow::anyhow!("branch PIDX key suffix had invalid length"))?;

	Ok(u32::from_be_bytes(bytes))
}

pub(crate) fn content_hash(bytes: &[u8]) -> [u8; 32] {
	let digest = Sha256::digest(bytes);
	let mut hash = [0_u8; 32];
	hash.copy_from_slice(&digest);
	hash
}

pub(crate) fn hex_lower(bytes: &[u8]) -> String {
	const HEX: &[u8; 16] = b"0123456789abcdef";
	let mut out = String::with_capacity(bytes.len() * 2);
	for byte in bytes {
		out.push(HEX[(byte >> 4) as usize] as char);
		out.push(HEX[(byte & 0x0f) as usize] as char);
	}
	out
}

pub(crate) fn decode_branch_commit_txid(branch_id: DatabaseBranchId, key: &[u8]) -> Result<u64> {
	let prefix = keys::branch_commit_prefix(branch_id);
	let suffix = key
		.strip_prefix(prefix.as_slice())
		.context("branch commit key did not start with expected prefix")?;
	let bytes: [u8; std::mem::size_of::<u64>()] = suffix
		.try_into()
		.map_err(|_| anyhow::anyhow!("branch commit key suffix had invalid length"))?;

	Ok(u64::from_be_bytes(bytes))
}

pub(crate) fn decode_pidx_txid(value: &[u8]) -> Result<u64> {
	let bytes: [u8; std::mem::size_of::<u64>()] = value
		.try_into()
		.map_err(|_| anyhow::anyhow!("branch pidx value had invalid length"))?;

	Ok(u64::from_be_bytes(bytes))
}

pub(crate) async fn tx_get_value(
	tx: &universaldb::Transaction,
	key: &[u8],
	isolation_level: universaldb::utils::IsolationLevel,
) -> Result<Option<Vec<u8>>> {
	Ok(tx
		.informal()
		.get(key, isolation_level)
		.await?
		.map(Vec::<u8>::from))
}

pub(crate) async fn tx_scan_prefix_values(
	tx: &universaldb::Transaction,
	prefix: &[u8],
	isolation_level: universaldb::utils::IsolationLevel,
) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Iterator,
			limit: Some(MAX_DELTA_CHUNKS_PER_COMMIT.saturating_add(1)),
			..RangeOption::from(universaldb::utils::range_for_prefix(prefix))
		},
		isolation_level,
	);
	let mut rows = Vec::new();

	while let Some(entry) = stream.try_next().await? {
		rows.push((entry.key().to_vec(), entry.value().to_vec()));
	}
	ensure!(
		rows.len() <= MAX_DELTA_CHUNKS_PER_COMMIT,
		"sqlite DELTA exceeded the bounded per-commit chunk limit"
	);

	Ok(rows)
}

pub(crate) async fn tx_scan_prefix_values_limited(
	tx: &universaldb::Transaction,
	prefix: &[u8],
	limit: usize,
	isolation_level: universaldb::utils::IsolationLevel,
) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
	let (start, end) = universaldb::utils::range_for_prefix(prefix);
	tx_scan_range_values_limited(tx, &start, &end, limit, isolation_level).await
}

pub(crate) async fn tx_scan_range_values_limited(
	tx: &universaldb::Transaction,
	start: &[u8],
	end: &[u8],
	limit: usize,
	isolation_level: universaldb::utils::IsolationLevel,
) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			limit: Some(limit),
			mode: StreamingMode::Exact,
			..(start, end).into()
		},
		isolation_level,
	);
	let mut rows = Vec::with_capacity(limit);

	while let Some(entry) = stream.try_next().await? {
		rows.push((entry.key().to_vec(), entry.value().to_vec()));
	}

	Ok(rows)
}

#[cfg(test)]
#[path = "../../tests/inline/hot_coverage_fold.rs"]
mod hot_coverage_fold_tests;

#[cfg(test)]
mod tests {
	use super::*;
	use crate::conveyer::types::BucketBranchId;

	#[test]
	fn shard_cache_deadline_is_exact_and_becomes_due() {
		let policy = ShardCachePolicy {
			retention_ms: 90_001,
		};
		let last_access_bucket = 100;
		let deadline = (last_access_bucket + 3) * ACCESS_TOUCH_THROTTLE_MS;
		assert_eq!(
			next_shard_cache_eviction_at_ms(last_access_bucket, policy, deadline - 1),
			Some(deadline)
		);
		assert_eq!(
			next_shard_cache_eviction_at_ms(last_access_bucket, policy, deadline),
			None
		);
	}

	#[test]
	fn staged_hot_row_estimate_counts_cumulative_distinct_shards_per_coverage() {
		let touched = BTreeMap::from([
			(1, BTreeSet::from([1, 2])),
			(2, BTreeSet::from([2, 3])),
			(4, BTreeSet::from([4])),
		]);

		// txid 1 => {1,2}, txid 2 => {1,2,3}, txid 4 => {1,2,3,4}.
		assert_eq!(estimate_staged_hot_shard_rows(&[1, 2, 4], &touched), 9);
		// No coverage at txid 2 means its touched shards are still accumulated by txid 4.
		assert_eq!(estimate_staged_hot_shard_rows(&[1, 4], &touched), 6);
		assert_eq!(estimate_staged_hot_shard_rows(&[], &touched), 0);
	}

	#[test]
	fn cold_input_summary_binds_count_order_and_content() {
		let first = ColdShardInputRef {
			shard_id: 1,
			as_of_txid: 9,
			size_bytes: 4_096,
			content_hash: [1; 32],
		};
		let second = ColdShardInputRef {
			shard_id: 2,
			as_of_txid: 9,
			size_bytes: 8_192,
			content_hash: [2; 32],
		};
		let summary = summarize_cold_input_refs(&[first.clone(), second.clone()]);
		assert_eq!(summary.input_ref_count, 2);
		assert_ne!(
			summary,
			summarize_cold_input_refs(std::slice::from_ref(&first))
		);
		assert_ne!(
			summary,
			summarize_cold_input_refs(&[second.clone(), first.clone()])
		);
		let mut changed = second;
		changed.content_hash[31] ^= 1;
		assert_ne!(summary, summarize_cold_input_refs(&[first, changed]));
	}

	#[test]
	fn orphan_cold_upload_is_planned_separately_from_ready_hot_reclaim() {
		let branch_id = DatabaseBranchId::nil();
		let orphan_job_id = Id::v1(branch_id.as_uuid(), 1);
		let planner_job_id = Id::v1(branch_id.as_uuid(), 2);
		let mut snapshot = ManagerFdbSnapshot {
			cold_storage_enabled: true,
			branch_record: Some(DatabaseBranchRecord {
				branch_id,
				bucket_branch: BucketBranchId::nil(),
				parent: None,
				parent_versionstamp: None,
				root_versionstamp: [0; 16],
				fork_depth: 0,
				created_at_ms: 0,
				created_from_restore_point: None,
				state: BranchState::Live,
				lifecycle_generation: 1,
			}),
			head: None,
			root: CompactionRoot {
				schema_version: 1,
				manifest_generation: 7,
				hot_watermark_txid: 5,
				cold_watermark_txid: 5,
				cold_watermark_versionstamp: [5; 16],
			},
			dirty: None,
			db_pin_count: 0,
			hot_inputs: HotInputSnapshot::default(),
			cold_inputs: ColdInputSnapshot::default(),
			reclaim_inputs: ReclaimInputSnapshot {
				txid_refs: vec![ReclaimTxidRef {
					txid: 5,
					versionstamp: [5; 16],
				}],
				delta_chunks: vec![(b"delta".to_vec(), b"value".to_vec())],
				coverage_shards: vec![(b"coverage".to_vec(), b"value".to_vec())],
				required_coverage_shard_count: 1,
				..ReclaimInputSnapshot::default()
			},
			orphan_cold_upload_job_id: Some(orphan_job_id),
			bucket_proof_blocked_reclaim: false,
			cleared_dirty: false,
			cleared_staged_hot_job: false,
		};

		let orphan_plan = plan_reclaim_job(branch_id, &snapshot, planner_job_id, 100).unwrap();
		assert_eq!(
			orphan_plan.input_range.orphan_cold_upload_job_id,
			Some(orphan_job_id)
		);
		assert!(orphan_plan.input_range.txid_refs.is_empty());

		// Prove the fixture really does contain actionable normal reclaim work; it is merely deferred
		// one manager turn while the orphan job-local index is drained.
		snapshot.orphan_cold_upload_job_id = None;
		let normal_plan = plan_reclaim_job(branch_id, &snapshot, planner_job_id, 101).unwrap();
		assert_eq!(normal_plan.input_range.orphan_cold_upload_job_id, None);
		assert_eq!(normal_plan.input_range.txid_refs.len(), 1);
	}
}
