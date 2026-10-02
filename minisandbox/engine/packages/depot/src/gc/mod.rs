mod cold_queue;
mod queue;

pub use cold_queue::*;
pub use queue::*;

use anyhow::{Context, Result};
use futures_util::TryStreamExt;
use universaldb::{
	RangeOption,
	options::{MutationType, StreamingMode},
	utils::IsolationLevel::{Serializable, Snapshot},
};

use crate::conveyer::{
	history_pin, keys,
	types::{
		DatabaseBranchId, DatabaseBranchRecord, DbHistoryPinKind, decode_database_branch_record,
		decode_db_history_pin,
	},
};

pub const VERSIONSTAMP_INFINITY: [u8; 16] = [0xff; 16];
pub const VERSIONSTAMP_ZERO: [u8; 16] = [0; 16];
const GC_SWEEP_BATCH_KEYS: usize = 64;
const GC_BRANCH_DELETE_BATCH_KEYS: usize = 256;
const GC_PIN_RECOMPUTE_MAX_KEYS: usize = 1_025;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BranchGcPin {
	pub branch_id: DatabaseBranchId,
	pub refcount: i64,
	pub root_pin: [u8; 16],
	pub desc_pin: [u8; 16],
	pub restore_point_pin: [u8; 16],
	pub gc_pin: [u8; 16],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BranchHotGcOutcome {
	pub gc_pin: [u8; 16],
	pub txid_floor: Option<u64>,
	pub commits_deleted: usize,
	pub vtx_deleted: usize,
	pub delta_chunks_deleted: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BranchDeletionOutcome {
	pub gc_pin: [u8; 16],
	pub branch_deleted: bool,
	pub keys_deleted: usize,
}

pub async fn estimate_branch_gc_pin(
	db: &universaldb::Database,
	branch_id: DatabaseBranchId,
) -> Result<Option<BranchGcPin>> {
	db.txn("depot_gc_read_branch_pin", move |tx| async move {
		read_branch_gc_pin_tx(&tx, branch_id).await
	})
	.await
}

pub async fn sweep_branch_hot_history(
	db: &universaldb::Database,
	branch_id: DatabaseBranchId,
) -> Result<Option<BranchHotGcOutcome>> {
	db.txn("depot_gc_sweep_hot_history", move |tx| async move {
		sweep_branch_hot_history_tx(&tx, branch_id).await
	})
	.await
}

pub async fn sweep_unreferenced_branch(
	db: &universaldb::Database,
	branch_id: DatabaseBranchId,
) -> Result<Option<BranchDeletionOutcome>> {
	db.txn("depot_gc_sweep_unreferenced_branch", move |tx| async move {
		sweep_unreferenced_branch_tx(&tx, branch_id).await
	})
	.await
}

pub(crate) async fn read_branch_gc_pin_tx(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
) -> Result<Option<BranchGcPin>> {
	let Some(record_bytes) = tx
		.informal()
		.get(&keys::branches_list_key(branch_id), Serializable)
		.await?
	else {
		return Ok(None);
	};
	let record = decode_database_branch_record(&record_bytes)
		.context("decode sqlite branch record for GC")?;
	read_branch_gc_pin_from_record_tx(tx, &record)
		.await
		.map(Some)
}

pub(crate) async fn sweep_branch_hot_history_tx(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
) -> Result<Option<BranchHotGcOutcome>> {
	let Some(pin) = read_branch_gc_pin_tx(tx, branch_id).await? else {
		return Ok(None);
	};
	let Some(txid_floor) = gc_pin_txid_floor(tx, branch_id, pin.gc_pin).await? else {
		return Ok(Some(BranchHotGcOutcome {
			gc_pin: pin.gc_pin,
			txid_floor: None,
			commits_deleted: 0,
			vtx_deleted: 0,
			delta_chunks_deleted: 0,
		}));
	};

	let commit_prefix = keys::branch_commit_prefix(branch_id);
	let commit_end = if txid_floor == u64::MAX {
		universaldb::utils::end_of_prefix_range(&commit_prefix)
	} else {
		keys::branch_commit_key(branch_id, txid_floor)
	};
	let commit_rows = scan_range_limited(
		tx,
		&commit_prefix,
		&commit_end,
		GC_SWEEP_BATCH_KEYS,
		Snapshot,
	)
	.await?;
	let commits_deleted = commit_rows.len();
	for (key, _value) in commit_rows {
		decode_suffix_u64(&commit_prefix, &key)
			.context("decode sqlite branch commit txid during GC")?;
		tx.informal().clear(&key);
	}

	let vtx_prefix = keys::branch_vtx_prefix(branch_id);
	let vtx_end = if pin.gc_pin == VERSIONSTAMP_INFINITY {
		universaldb::utils::end_of_prefix_range(&vtx_prefix)
	} else {
		keys::branch_vtx_key(branch_id, pin.gc_pin)
	};
	let vtx_rows =
		scan_range_limited(tx, &vtx_prefix, &vtx_end, GC_SWEEP_BATCH_KEYS, Snapshot).await?;
	let vtx_deleted = vtx_rows.len();
	for (key, _value) in vtx_rows {
		decode_suffix_versionstamp(&vtx_prefix, &key)
			.context("decode sqlite branch VTX versionstamp during GC")?;
		tx.informal().clear(&key);
	}

	let delta_prefix = keys::branch_delta_prefix(branch_id);
	let delta_end = if txid_floor == u64::MAX {
		universaldb::utils::end_of_prefix_range(&delta_prefix)
	} else {
		keys::branch_delta_chunk_prefix(branch_id, txid_floor)
	};
	let delta_rows =
		scan_range_limited(tx, &delta_prefix, &delta_end, GC_SWEEP_BATCH_KEYS, Snapshot).await?;
	let delta_chunks_deleted = delta_rows.len();
	for (key, _value) in delta_rows {
		keys::decode_branch_delta_chunk_txid(branch_id, &key)?;
		tx.informal().clear(&key);
	}

	Ok(Some(BranchHotGcOutcome {
		gc_pin: pin.gc_pin,
		txid_floor: Some(txid_floor),
		commits_deleted,
		vtx_deleted,
		delta_chunks_deleted,
	}))
}

async fn sweep_unreferenced_branch_tx(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
) -> Result<Option<BranchDeletionOutcome>> {
	let Some(record_bytes) = tx
		.informal()
		.get(&keys::branches_list_key(branch_id), Serializable)
		.await?
	else {
		return Ok(None);
	};
	let record = decode_database_branch_record(&record_bytes)
		.context("decode sqlite branch record for unreferenced branch sweep")?;
	let pin = read_branch_gc_pin_from_record_tx(tx, &record).await?;

	if pin.refcount > 0
		|| pin.desc_pin != VERSIONSTAMP_INFINITY
		|| pin.restore_point_pin != VERSIONSTAMP_INFINITY
	{
		return Ok(Some(BranchDeletionOutcome {
			gc_pin: pin.gc_pin,
			branch_deleted: false,
			keys_deleted: 0,
		}));
	}

	let branch_prefix = keys::branch_prefix(branch_id);
	let branch_rows = scan_range_limited(
		tx,
		&branch_prefix,
		&universaldb::utils::end_of_prefix_range(&branch_prefix),
		GC_BRANCH_DELETE_BATCH_KEYS,
		Snapshot,
	)
	.await?;
	let branch_row_count = branch_rows.len();
	let deleting_key = keys::branch_gc_deleting_key(branch_id);
	let quota_key = keys::branch_meta_quota_key(branch_id);
	let mut keys_deleted = 0;
	for (key, value) in branch_rows {
		// The deletion fence must survive every bounded page. Clearing it early would allow a
		// concurrent fork or restore-point pin to race a later page or cold-object deletion.
		if key == deleting_key {
			continue;
		}
		if key == quota_key {
			let bytes: [u8; 8] = value
				.as_slice()
				.try_into()
				.context("sqlite branch quota must be exactly 8 bytes during branch GC")?;
			let authoritative_bytes = i64::from_le_bytes(bytes);
			crate::cold_tier::accounting::apply_delta_for_branch(
				tx,
				branch_id,
				crate::cold_tier::accounting::ColdStorageAccountingDelta {
					fdb_authoritative_bytes: authoritative_bytes.saturating_neg(),
					..Default::default()
				},
			);
		}
		tx.informal().clear(&key);
		keys_deleted += 1;
	}
	// Keep the branch record and parent pin until every branch-local row is
	// drained. A page exactly at the limit may already be the last page; one
	// extra bounded invocation is intentionally cheaper than an unbounded proof.
	if branch_row_count == GC_BRANCH_DELETE_BATCH_KEYS {
		return Ok(Some(BranchDeletionOutcome {
			gc_pin: pin.gc_pin,
			branch_deleted: false,
			keys_deleted,
		}));
	}
	clear_branch_gc_queue_tx(tx, branch_id).await?;
	crate::conveyer::commit::clear_dirty_reconcile_schedule_tx(tx, branch_id).await?;

	for key in [
		keys::branches_list_key(branch_id),
		keys::branches_refcount_key(branch_id),
		keys::branches_desc_pin_key(branch_id),
		keys::branches_restore_point_pin_key(branch_id),
		keys::database_policy_binding_key(branch_id),
		keys::branch_gc_deleting_key(branch_id),
		keys::sqlite_cmp_dirty_key(branch_id),
	] {
		if tx.informal().get(&key, Snapshot).await?.is_some() {
			keys_deleted += 1;
		}
		tx.informal().clear(&key);
	}

	if let Some(parent_branch_id) = record.parent {
		release_parent_database_fork(tx, parent_branch_id, branch_id).await?;
	}

	Ok(Some(BranchDeletionOutcome {
		gc_pin: pin.gc_pin,
		branch_deleted: true,
		keys_deleted,
	}))
}

async fn read_branch_gc_pin_from_record_tx(
	tx: &universaldb::Transaction,
	record: &DatabaseBranchRecord,
) -> Result<BranchGcPin> {
	let branch_id = record.branch_id;
	let refcount = read_i64_le(tx, &keys::branches_refcount_key(branch_id)).await?;
	let root_pin = if refcount > 0 {
		record.root_versionstamp
	} else {
		VERSIONSTAMP_INFINITY
	};
	let desc_pin = read_versionstamp_pin(tx, &keys::branches_desc_pin_key(branch_id)).await?;
	let restore_point_pin =
		read_versionstamp_pin(tx, &keys::branches_restore_point_pin_key(branch_id)).await?;
	let gc_pin = root_pin.min(desc_pin).min(restore_point_pin);

	Ok(BranchGcPin {
		branch_id,
		refcount,
		root_pin,
		desc_pin,
		restore_point_pin,
		gc_pin,
	})
}

async fn release_parent_database_fork(
	tx: &universaldb::Transaction,
	parent_branch_id: DatabaseBranchId,
	child_branch_id: DatabaseBranchId,
) -> Result<()> {
	let parent_fork_pin_id = history_pin::database_fork_pin_id(child_branch_id);
	history_pin::delete_db_history_pin(tx, parent_branch_id, &parent_fork_pin_id).await?;
	tx.informal().atomic_op(
		&keys::branches_refcount_key(parent_branch_id),
		&(-1_i64).to_le_bytes(),
		MutationType::Add,
	);
	expedite_branch_gc_if_queued_tx(tx, parent_branch_id, rivet_util::timestamp::now()).await?;

	recompute_parent_desc_pin(tx, parent_branch_id, &parent_fork_pin_id).await
}

async fn recompute_parent_desc_pin(
	tx: &universaldb::Transaction,
	parent_branch_id: DatabaseBranchId,
	deleted_pin_id: &[u8],
) -> Result<()> {
	let deleted_pin_key = keys::db_pin_key(parent_branch_id, deleted_pin_id);
	let mut desc_pin = VERSIONSTAMP_INFINITY;

	let pin_prefix = keys::db_pin_prefix(parent_branch_id);
	let pin_rows = scan_range_limited(
		tx,
		&pin_prefix,
		&universaldb::utils::end_of_prefix_range(&pin_prefix),
		GC_PIN_RECOMPUTE_MAX_KEYS,
		Serializable,
	)
	.await?;
	anyhow::ensure!(
		pin_rows.len() < GC_PIN_RECOMPUTE_MAX_KEYS,
		"sqlite parent fork-pin proof exceeded the bounded per-branch limit"
	);
	for (key, value) in pin_rows {
		if key == deleted_pin_key {
			continue;
		}
		let pin =
			decode_db_history_pin(&value).context("decode sqlite DB history pin for desc pin")?;
		if pin.kind == DbHistoryPinKind::DatabaseFork {
			desc_pin = desc_pin.min(pin.at_versionstamp);
		}
	}

	let desc_pin_key = keys::branches_desc_pin_key(parent_branch_id);
	if desc_pin == VERSIONSTAMP_INFINITY {
		tx.informal().clear(&desc_pin_key);
	} else {
		tx.informal().set(&desc_pin_key, &desc_pin);
	}

	Ok(())
}

async fn gc_pin_txid_floor(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	gc_pin: [u8; 16],
) -> Result<Option<u64>> {
	if gc_pin == VERSIONSTAMP_ZERO {
		return Ok(None);
	}
	if gc_pin == VERSIONSTAMP_INFINITY {
		return Ok(Some(u64::MAX));
	}

	read_u64_be(tx, &keys::branch_vtx_key(branch_id, gc_pin)).await
}

async fn read_i64_le(tx: &universaldb::Transaction, key: &[u8]) -> Result<i64> {
	let Some(bytes) = tx.informal().get(key, Serializable).await? else {
		return Ok(0);
	};
	let bytes: [u8; std::mem::size_of::<i64>()] = Vec::<u8>::from(bytes)
		.as_slice()
		.try_into()
		.context("sqlite branch refcount should be exactly 8 bytes")?;

	Ok(i64::from_le_bytes(bytes))
}

async fn read_versionstamp_pin(tx: &universaldb::Transaction, key: &[u8]) -> Result<[u8; 16]> {
	let Some(bytes) = tx.informal().get(key, Serializable).await? else {
		return Ok(VERSIONSTAMP_INFINITY);
	};
	let pin: [u8; 16] = Vec::<u8>::from(bytes)
		.as_slice()
		.try_into()
		.context("sqlite branch pin should be exactly 16 bytes")?;
	if pin == VERSIONSTAMP_ZERO {
		return Ok(VERSIONSTAMP_INFINITY);
	}

	Ok(pin)
}

async fn read_u64_be(tx: &universaldb::Transaction, key: &[u8]) -> Result<Option<u64>> {
	let Some(bytes) = tx.informal().get(key, Serializable).await? else {
		return Ok(None);
	};
	let bytes: [u8; std::mem::size_of::<u64>()] = Vec::<u8>::from(bytes)
		.as_slice()
		.try_into()
		.context("sqlite VTX entry should be exactly 8 bytes")?;

	Ok(Some(u64::from_be_bytes(bytes)))
}

async fn scan_range_limited(
	tx: &universaldb::Transaction,
	start: &[u8],
	end: &[u8],
	limit: usize,
	isolation_level: universaldb::utils::IsolationLevel,
) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
	let informal = tx.informal();
	let mut stream = informal.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Iterator,
			limit: Some(limit),
			..(start, end).into()
		},
		isolation_level,
	);
	let mut rows = Vec::new();

	while let Some(entry) = stream.try_next().await? {
		rows.push((entry.key().to_vec(), entry.value().to_vec()));
	}

	Ok(rows)
}

fn decode_suffix_u64(prefix: &[u8], key: &[u8]) -> Result<u64> {
	let suffix = key
		.strip_prefix(prefix)
		.context("key did not start with expected prefix")?;
	let bytes: [u8; std::mem::size_of::<u64>()] = suffix
		.try_into()
		.context("key suffix had invalid u64 length")?;

	Ok(u64::from_be_bytes(bytes))
}

fn decode_suffix_versionstamp(prefix: &[u8], key: &[u8]) -> Result<[u8; 16]> {
	let suffix = key
		.strip_prefix(prefix)
		.context("key did not start with expected prefix")?;
	let bytes: [u8; 16] = suffix
		.try_into()
		.context("key suffix had invalid versionstamp length")?;

	Ok(bytes)
}
