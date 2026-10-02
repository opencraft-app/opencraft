use anyhow::{Context, Result, ensure};
use futures_util::TryStreamExt;
use serde::Serialize;
use universaldb::{
	RangeOption,
	options::{MutationType, StreamingMode},
	utils::{IsolationLevel::Snapshot, end_of_prefix_range},
};

use crate::conveyer::keys;

pub fn checked_bytes(bytes: u64) -> Result<i64> {
	i64::try_from(bytes).context("cold object byte count exceeded the accounting range")
}

pub fn checked_objects(objects: usize) -> Result<i64> {
	i64::try_from(objects).context("cold object count exceeded the accounting range")
}

/// A Cell-wide, durable logical ledger of physical cold objects.
///
/// `live`, `retired`, and `delete_issued` are mutually exclusive lifecycle classes. `orphan` is an
/// orthogonal subset marker that remains set while an unpublished exact key is pending deletion;
/// operators must not sum it with the lifecycle classes. `deleted_*_total` is cumulative. FDB
/// byte fields are logical payload counters rather than FoundationDB disk or billing bytes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct ColdStorageAccounting {
	pub live_bytes: i64,
	pub live_objects: i64,
	pub retired_bytes: i64,
	pub retired_objects: i64,
	pub delete_issued_bytes: i64,
	pub delete_issued_objects: i64,
	pub orphan_bytes: i64,
	pub orphan_objects: i64,
	pub deleted_bytes_total: i64,
	pub deleted_objects_total: i64,
	pub fdb_authoritative_bytes: i64,
	pub fdb_cache_bytes: i64,
	pub fdb_metadata_bytes: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ColdStorageAccountingDelta {
	pub live_bytes: i64,
	pub live_objects: i64,
	pub retired_bytes: i64,
	pub retired_objects: i64,
	pub delete_issued_bytes: i64,
	pub delete_issued_objects: i64,
	pub orphan_bytes: i64,
	pub orphan_objects: i64,
	pub deleted_bytes_total: i64,
	pub deleted_objects_total: i64,
	pub fdb_authoritative_bytes: i64,
	pub fdb_cache_bytes: i64,
	pub fdb_metadata_bytes: i64,
}

#[repr(u8)]
#[derive(Clone, Copy)]
enum Field {
	LiveBytes = 1,
	LiveObjects = 2,
	RetiredBytes = 3,
	RetiredObjects = 4,
	DeleteIssuedBytes = 5,
	DeleteIssuedObjects = 6,
	OrphanBytes = 7,
	OrphanObjects = 8,
	DeletedBytesTotal = 9,
	DeletedObjectsTotal = 10,
	FdbAuthoritativeBytes = 11,
	FdbCacheBytes = 12,
	FdbMetadataBytes = 13,
}

const ACCOUNTING_SHARDS: u8 = 64;

const FIELDS: [(Field, fn(&mut ColdStorageAccounting) -> &mut i64); 13] = [
	(Field::LiveBytes, |v| &mut v.live_bytes),
	(Field::LiveObjects, |v| &mut v.live_objects),
	(Field::RetiredBytes, |v| &mut v.retired_bytes),
	(Field::RetiredObjects, |v| &mut v.retired_objects),
	(Field::DeleteIssuedBytes, |v| &mut v.delete_issued_bytes),
	(Field::DeleteIssuedObjects, |v| &mut v.delete_issued_objects),
	(Field::OrphanBytes, |v| &mut v.orphan_bytes),
	(Field::OrphanObjects, |v| &mut v.orphan_objects),
	(Field::DeletedBytesTotal, |v| &mut v.deleted_bytes_total),
	(Field::DeletedObjectsTotal, |v| &mut v.deleted_objects_total),
	(Field::FdbAuthoritativeBytes, |v| {
		&mut v.fdb_authoritative_bytes
	}),
	(Field::FdbCacheBytes, |v| &mut v.fdb_cache_bytes),
	(Field::FdbMetadataBytes, |v| &mut v.fdb_metadata_bytes),
];

/// Applies accounting deltas in the caller's transaction. Atomic adds avoid one hot
/// read/modify/write conflict while preserving atomicity with the authoritative metadata change.
pub fn apply_delta(tx: &universaldb::Transaction, shard: u8, delta: ColdStorageAccountingDelta) {
	assert!(shard < ACCOUNTING_SHARDS);
	for (field, value) in [
		(Field::LiveBytes, delta.live_bytes),
		(Field::LiveObjects, delta.live_objects),
		(Field::RetiredBytes, delta.retired_bytes),
		(Field::RetiredObjects, delta.retired_objects),
		(Field::DeleteIssuedBytes, delta.delete_issued_bytes),
		(Field::DeleteIssuedObjects, delta.delete_issued_objects),
		(Field::OrphanBytes, delta.orphan_bytes),
		(Field::OrphanObjects, delta.orphan_objects),
		(Field::DeletedBytesTotal, delta.deleted_bytes_total),
		(Field::DeletedObjectsTotal, delta.deleted_objects_total),
		(Field::FdbAuthoritativeBytes, delta.fdb_authoritative_bytes),
		(Field::FdbCacheBytes, delta.fdb_cache_bytes),
		(Field::FdbMetadataBytes, delta.fdb_metadata_bytes),
	] {
		if value != 0 {
			tx.informal().atomic_op(
				&keys::cold_storage_accounting_counter_key(field as u8, shard),
				&value.to_le_bytes(),
				MutationType::Add,
			);
		}
	}
}

pub fn apply_delta_for_branch(
	tx: &universaldb::Transaction,
	branch_id: crate::types::DatabaseBranchId,
	delta: ColdStorageAccountingDelta,
) {
	apply_delta(tx, keys::branch_gc_queue_shard(branch_id), delta);
}

pub async fn read(db: &universaldb::Database) -> Result<ColdStorageAccounting> {
	db.txn("depot_read_cold_storage_accounting", |tx| async move {
		let mut accounting = ColdStorageAccounting::default();
		let prefix = keys::cold_storage_accounting_prefix();
		let end = end_of_prefix_range(&prefix);
		let informal = tx.informal();
		let mut rows = informal.get_ranges_keyvalues(
			RangeOption {
				mode: StreamingMode::WantAll,
				..(prefix.as_slice(), end.as_slice()).into()
			},
			Snapshot,
		);
		while let Some(row) = rows.try_next().await? {
			let (field_id, shard) = keys::decode_cold_storage_accounting_counter_key(row.key())?;
			ensure!(
				shard < ACCOUNTING_SHARDS,
				"invalid cold accounting shard {shard}"
			);
			let (_, target) = FIELDS
				.iter()
				.find(|(field, _)| *field as u8 == field_id)
				.context("unknown cold storage accounting field")?;
			let value = decode_counter(row.value())?;
			let destination = target(&mut accounting);
			*destination = destination
				.checked_add(value)
				.context("cold storage accounting aggregate overflowed")?;
		}
		validate(accounting)?;
		Ok(accounting)
	})
	.await
}

fn decode_counter(payload: &[u8]) -> Result<i64> {
	let bytes: [u8; 8] = payload
		.try_into()
		.context("cold storage accounting counter must be exactly 8 bytes")?;
	Ok(i64::from_le_bytes(bytes))
}

fn validate(accounting: ColdStorageAccounting) -> Result<()> {
	for (name, value) in [
		("live_bytes", accounting.live_bytes),
		("live_objects", accounting.live_objects),
		("retired_bytes", accounting.retired_bytes),
		("retired_objects", accounting.retired_objects),
		("delete_issued_bytes", accounting.delete_issued_bytes),
		("delete_issued_objects", accounting.delete_issued_objects),
		("orphan_bytes", accounting.orphan_bytes),
		("orphan_objects", accounting.orphan_objects),
		("deleted_bytes_total", accounting.deleted_bytes_total),
		("deleted_objects_total", accounting.deleted_objects_total),
		(
			"fdb_authoritative_bytes",
			accounting.fdb_authoritative_bytes,
		),
		("fdb_cache_bytes", accounting.fdb_cache_bytes),
		("fdb_metadata_bytes", accounting.fdb_metadata_bytes),
	] {
		ensure!(
			value >= 0,
			"cold storage accounting {name} became negative: {value}"
		);
	}
	Ok(())
}
