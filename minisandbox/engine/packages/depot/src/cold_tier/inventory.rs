use std::str::FromStr;

use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use gas::prelude::Id;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use universaldb::utils::IsolationLevel::Serializable;
use uuid::Uuid;
use vbare::OwnedVersionedData;

use super::{ColdTierInventoryObject, cold_tier_from_config};
use crate::{
	conveyer::types::SQLITE_STORAGE_META_VERSION,
	keys,
	types::{
		BranchColdObjectAccountingState, DatabaseBranchId, RetiredColdObjectDeleteState,
		decode_branch_cold_object_tombstone, decode_cold_delete_receipt, decode_cold_shard_ref,
		decode_cold_upload_intent, decode_retired_cold_object,
	},
};

/// Inventory is an operational reconciliation scan, not part of deletion authorization. The
/// lease only bounds provider LIST/FDB read amplification across Engine replicas.
pub const COLD_INVENTORY_AUDIT_MAX_LEASE_MS: i64 = 2 * 60 * 60 * 1_000;
const INVENTORY_CLASSIFICATION_PAGE_SIZE: u64 = 50;

pub async fn try_acquire_cold_inventory_audit_lease(
	db: &universaldb::Database,
	holder_id: [u8; 16],
	now_ms: i64,
	lease_ms: i64,
) -> Result<bool> {
	ensure!(
		now_ms >= 0,
		"cold inventory audit lease time must be non-negative"
	);
	ensure!(
		lease_ms > 0 && lease_ms <= COLD_INVENTORY_AUDIT_MAX_LEASE_MS,
		"cold inventory audit lease duration is out of bounds"
	);
	let expires_at_ms = now_ms
		.checked_add(lease_ms)
		.context("cold inventory audit lease expiry overflow")?;
	db.txn(
		"depot_acquire_cold_inventory_audit_lease",
		move |tx| async move {
			let key = keys::cold_inventory_audit_lease_key();
			if let Some(existing) = tx.informal().get(&key, Serializable).await? {
				ensure!(
					existing.len() == 24,
					"cold inventory audit lease had invalid length"
				);
				let existing_holder: [u8; 16] = existing[..16]
					.try_into()
					.context("decode cold inventory audit lease holder")?;
				let existing_expiry = i64::from_be_bytes(
					existing[16..]
						.try_into()
						.context("decode cold inventory audit lease expiry")?,
				);
				if existing_holder != holder_id && existing_expiry > now_ms {
					return Ok(false);
				}
			}

			let mut encoded = Vec::with_capacity(24);
			encoded.extend_from_slice(&holder_id);
			encoded.extend_from_slice(&expires_at_ms.to_be_bytes());
			tx.informal().set(&key, &encoded);
			Ok(true)
		},
	)
	.await
}

/// Releases an audit lease only when it is still owned by `holder_id`. A stale auditor can never
/// clear a replacement auditor's lease.
pub async fn release_cold_inventory_audit_lease(
	db: &universaldb::Database,
	holder_id: [u8; 16],
) -> Result<bool> {
	db.txn(
		"depot_release_cold_inventory_audit_lease",
		move |tx| async move {
			let key = keys::cold_inventory_audit_lease_key();
			let Some(existing) = tx.informal().get(&key, Serializable).await? else {
				return Ok(false);
			};
			ensure!(
				existing.len() == 24,
				"cold inventory audit lease had invalid length"
			);
			if existing[..16] != holder_id {
				return Ok(false);
			}
			tx.informal().clear(&key);
			Ok(true)
		},
	)
	.await
}

#[derive(Debug, Clone)]
struct ParsedColdObjectKey {
	database_branch_id: DatabaseBranchId,
	object_generation_id: Id,
	shard_id: u32,
	as_of_txid: u64,
	content_hash: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ColdInventoryDisposition {
	Live,
	Retired,
	DeleteIssued,
	Orphan,
	DeletedButPresent,
	Unknown,
	InvalidKey,
	SizeMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ColdInventoryRecord {
	pub object_key: String,
	pub physical_size_bytes: u64,
	pub authoritative_size_bytes: Option<u64>,
	pub disposition: ColdInventoryDisposition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ColdInventoryPageReport {
	pub records: Vec<ColdInventoryRecord>,
	pub next_cursor: Option<String>,
	pub physical_bytes: u64,
	pub physical_objects: u64,
	pub unknown_bytes: u64,
	pub unknown_objects: u64,
	pub deleted_but_present_bytes: u64,
	pub deleted_but_present_objects: u64,
	pub mutates_storage: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColdInventoryAuditSummary {
	pub physical_bytes: u64,
	pub physical_objects: u64,
	pub unknown_objects: u64,
	pub deleted_but_present_objects: u64,
	pub size_mismatch_objects: u64,
	pub complete: bool,
}

/// Durable operational state for the latest bounded provider inventory. It is not ownership proof
/// and never participates in deletion authorization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColdInventoryAuditState {
	pub summary: ColdInventoryAuditSummary,
	pub observed_at_ms: i64,
	pub last_complete_at_ms: Option<i64>,
}

enum VersionedColdInventoryAuditState {
	V1(ColdInventoryAuditState),
}

impl OwnedVersionedData for VersionedColdInventoryAuditState {
	type Latest = ColdInventoryAuditState;

	fn wrap_latest(latest: Self::Latest) -> Self {
		Self::V1(latest)
	}

	fn unwrap_latest(self) -> Result<Self::Latest> {
		match self {
			Self::V1(state) => Ok(state),
		}
	}

	fn deserialize_version(payload: &[u8], version: u16) -> Result<Self> {
		match version {
			1 => Ok(Self::V1(rivet_util::serde::bare_from_slice!(payload)?)),
			_ => anyhow::bail!("invalid Depot cold inventory audit state version: {version}"),
		}
	}

	fn serialize_version(self, _version: u16) -> Result<Vec<u8>> {
		match self {
			Self::V1(state) => rivet_util::serde::bare_to_vec!(&state).map_err(Into::into),
		}
	}
}

fn encode_audit_state(state: ColdInventoryAuditState) -> Result<Vec<u8>> {
	VersionedColdInventoryAuditState::wrap_latest(state)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode Depot cold inventory audit state")
}

fn decode_audit_state(payload: &[u8]) -> Result<ColdInventoryAuditState> {
	VersionedColdInventoryAuditState::deserialize_with_embedded_version(payload)
		.context("decode Depot cold inventory audit state")
}

pub async fn read_cold_inventory_audit_state(
	db: &universaldb::Database,
) -> Result<Option<ColdInventoryAuditState>> {
	db.txn("depot_read_cold_inventory_audit_state", |tx| async move {
		tx.informal()
			.get(&keys::cold_inventory_audit_state_key(), Serializable)
			.await?
			.map(|payload| decode_audit_state(&payload))
			.transpose()
	})
	.await
}

/// Persists a completed audit and releases its lease in one transaction. Completion is rejected if
/// the lease expired or moved to another Engine while the provider scan was running.
pub async fn complete_cold_inventory_audit(
	db: &universaldb::Database,
	holder_id: [u8; 16],
	summary: ColdInventoryAuditSummary,
	observed_at_ms: i64,
) -> Result<ColdInventoryAuditState> {
	ensure!(
		observed_at_ms >= 0,
		"inventory audit time must be non-negative"
	);
	db.txn("depot_complete_cold_inventory_audit", move |tx| {
		let summary = summary.clone();
		async move {
			let lease_key = keys::cold_inventory_audit_lease_key();
			let lease = tx
				.informal()
				.get(&lease_key, Serializable)
				.await?
				.context("cold inventory audit completed without a lease")?;
			ensure!(
				lease.len() == 24,
				"cold inventory audit lease had invalid length"
			);
			ensure!(
				lease[..16] == holder_id,
				"cold inventory audit lease changed owner"
			);
			let lease_expiry = i64::from_be_bytes(
				lease[16..]
					.try_into()
					.context("decode cold inventory audit lease expiry")?,
			);
			ensure!(
				lease_expiry >= observed_at_ms,
				"cold inventory audit lease expired before completion"
			);

			let state_key = keys::cold_inventory_audit_state_key();
			let previous = tx
				.informal()
				.get(&state_key, Serializable)
				.await?
				.map(|payload| decode_audit_state(&payload))
				.transpose()?;
			let state = ColdInventoryAuditState {
				last_complete_at_ms: if summary.complete {
					Some(observed_at_ms)
				} else {
					previous.and_then(|state| state.last_complete_at_ms)
				},
				summary,
				observed_at_ms,
			};
			tx.informal()
				.set(&state_key, &encode_audit_state(state.clone())?);
			tx.informal().clear(&lease_key);
			Ok(state)
		}
	})
	.await
}

/// Reads a bounded whole-bucket inventory for operational accounting. This is deliberately
/// read-only and fails closed as `complete=false` when the configured bound is reached.
pub async fn audit_cold_inventory(
	config: &rivet_config::Config,
	db: &universaldb::Database,
	max_objects: u64,
) -> Result<ColdInventoryAuditSummary> {
	ensure!(max_objects > 0, "inventory audit bound must be positive");
	let mut summary = ColdInventoryAuditSummary::default();
	let mut cursor = None;
	loop {
		let remaining = max_objects.saturating_sub(summary.physical_objects);
		if remaining == 0 {
			return Ok(summary);
		}
		// Classification performs several serializable exact reads per object. Keep each FDB
		// transaction deliberately small even though provider LIST supports larger pages.
		let limit = u16::try_from(remaining.min(INVENTORY_CLASSIFICATION_PAGE_SIZE))
			.expect("bounded inventory page fits u16");
		let page = scan_cold_inventory_page(config, db, cursor.as_deref(), limit).await?;
		summary.physical_bytes = summary.physical_bytes.saturating_add(page.physical_bytes);
		summary.physical_objects = summary
			.physical_objects
			.saturating_add(page.physical_objects);
		summary.unknown_objects = summary.unknown_objects.saturating_add(
			page.records
				.iter()
				.filter(|record| {
					matches!(
						record.disposition,
						ColdInventoryDisposition::Unknown | ColdInventoryDisposition::InvalidKey
					)
				})
				.count() as u64,
		);
		summary.deleted_but_present_objects = summary
			.deleted_but_present_objects
			.saturating_add(page.deleted_but_present_objects);
		summary.size_mismatch_objects = summary.size_mismatch_objects.saturating_add(
			page.records
				.iter()
				.filter(|record| record.disposition == ColdInventoryDisposition::SizeMismatch)
				.count() as u64,
		);
		match page.next_cursor {
			Some(next) => cursor = Some(next),
			None => {
				summary.complete = true;
				return Ok(summary);
			}
		}
	}
}

pub async fn scan_cold_inventory_page(
	config: &rivet_config::Config,
	db: &universaldb::Database,
	cursor: Option<&str>,
	limit: u16,
) -> Result<ColdInventoryPageReport> {
	ensure!(
		(1..=1_000).contains(&limit),
		"inventory page limit must be 1..=1000"
	);
	let cold_tier = cold_tier_from_config(config)
		.await?
		.context("cold storage is disabled")?;
	let page = cold_tier
		.list_inventory_page(cursor, limit)
		.await
		.context("list physical cold-object inventory")?;
	let objects = page.objects;
	let records = db
		.txn("depot_classify_cold_inventory_page", move |tx| {
			let objects = objects.clone();
			async move {
				let mut records = Vec::with_capacity(objects.len());
				for object in objects {
					records.push(classify_object_tx(&tx, object).await?);
				}
				Ok(records)
			}
		})
		.await?;
	let mut report = ColdInventoryPageReport {
		next_cursor: page.next_cursor,
		physical_bytes: 0,
		physical_objects: records.len() as u64,
		unknown_bytes: 0,
		unknown_objects: 0,
		deleted_but_present_bytes: 0,
		deleted_but_present_objects: 0,
		mutates_storage: false,
		records,
	};
	for record in &report.records {
		report.physical_bytes = report
			.physical_bytes
			.saturating_add(record.physical_size_bytes);
		if matches!(
			record.disposition,
			ColdInventoryDisposition::Unknown | ColdInventoryDisposition::InvalidKey
		) {
			report.unknown_bytes = report
				.unknown_bytes
				.saturating_add(record.physical_size_bytes);
			report.unknown_objects = report.unknown_objects.saturating_add(1);
		}
		if record.disposition == ColdInventoryDisposition::DeletedButPresent {
			report.deleted_but_present_bytes = report
				.deleted_but_present_bytes
				.saturating_add(record.physical_size_bytes);
			report.deleted_but_present_objects =
				report.deleted_but_present_objects.saturating_add(1);
		}
	}
	Ok(report)
}

async fn classify_object_tx(
	tx: &universaldb::Transaction,
	object: ColdTierInventoryObject,
) -> Result<ColdInventoryRecord> {
	let Some(identity) = parse_object_key(&object.key) else {
		return Ok(record(object, None, ColdInventoryDisposition::InvalidKey));
	};
	let object_key = object.key.clone();
	let hash: [u8; 32] = Sha256::digest(object_key.as_bytes()).into();
	if let Some(encoded) = tx
		.informal()
		.get(&keys::cold_delete_receipt_key(hash), Serializable)
		.await?
	{
		let receipt = decode_cold_delete_receipt(&encoded)?;
		ensure!(
			receipt.object_key == object_key,
			"cold delete receipt hash collision"
		);
		return Ok(record(
			object,
			Some(receipt.size_bytes),
			ColdInventoryDisposition::DeletedButPresent,
		));
	}
	if let Some(encoded) = tx
		.informal()
		.get(
			&keys::branch_cold_gc_object_key(identity.database_branch_id, hash),
			Serializable,
		)
		.await?
	{
		let tombstone = decode_branch_cold_object_tombstone(&encoded)?;
		ensure!(
			tombstone.object_key == object_key,
			"branch cold tombstone hash collision"
		);
		let disposition = match tombstone.accounting_state {
			BranchColdObjectAccountingState::Retired => ColdInventoryDisposition::Retired,
			BranchColdObjectAccountingState::DeleteIssued
			| BranchColdObjectAccountingState::OrphanDeleteIssued => ColdInventoryDisposition::DeleteIssued,
			BranchColdObjectAccountingState::Orphan => ColdInventoryDisposition::Orphan,
			BranchColdObjectAccountingState::Deleted => ColdInventoryDisposition::DeletedButPresent,
		};
		return Ok(record(object, Some(tombstone.size_bytes), disposition));
	}
	if let Some(encoded) = tx
		.informal()
		.get(
			&keys::branch_compaction_retired_cold_object_key(identity.database_branch_id, hash),
			Serializable,
		)
		.await?
	{
		let retired = decode_retired_cold_object(&encoded)?;
		ensure!(
			retired.object_key == object_key,
			"retired cold object hash collision"
		);
		let disposition = match retired.delete_state {
			RetiredColdObjectDeleteState::Retired => ColdInventoryDisposition::Retired,
			RetiredColdObjectDeleteState::DeleteIssued => ColdInventoryDisposition::DeleteIssued,
			RetiredColdObjectDeleteState::Deleted => ColdInventoryDisposition::DeletedButPresent,
		};
		return Ok(record(object, Some(retired.size_bytes), disposition));
	}
	if let Some(encoded) = tx
		.informal()
		.get(
			&keys::branch_compaction_cold_upload_intent_key(
				identity.database_branch_id,
				identity.object_generation_id,
				identity.shard_id,
				identity.as_of_txid,
			),
			Serializable,
		)
		.await?
	{
		let intent = decode_cold_upload_intent(&encoded)?;
		ensure!(
			intent.reference.object_key == object_key,
			"cold upload intent identity mismatch"
		);
		let disposition = if intent.delete_authorization.is_some() {
			ColdInventoryDisposition::DeleteIssued
		} else {
			ColdInventoryDisposition::Orphan
		};
		return Ok(record(
			object,
			Some(intent.reference.size_bytes),
			disposition,
		));
	}
	if let Some(encoded) = tx
		.informal()
		.get(
			&keys::branch_compaction_cold_shard_key(
				identity.database_branch_id,
				identity.shard_id,
				identity.as_of_txid,
			),
			Serializable,
		)
		.await?
	{
		let reference = decode_cold_shard_ref(&encoded)?;
		if reference.object_key == object_key
			&& crate::compaction::shared::cold_ref_has_atomic_publish_marker(
				&tx,
				identity.database_branch_id,
				&reference,
			)
			.await?
		{
			return Ok(record(
				object,
				Some(reference.size_bytes),
				ColdInventoryDisposition::Live,
			));
		}
	}
	Ok(record(object, None, ColdInventoryDisposition::Unknown))
}

fn record(
	object: ColdTierInventoryObject,
	authoritative_size_bytes: Option<u64>,
	disposition: ColdInventoryDisposition,
) -> ColdInventoryRecord {
	let disposition =
		if authoritative_size_bytes.is_some_and(|expected| expected != object.size_bytes) {
			ColdInventoryDisposition::SizeMismatch
		} else {
			disposition
		};
	ColdInventoryRecord {
		object_key: object.key,
		physical_size_bytes: object.size_bytes,
		authoritative_size_bytes,
		disposition,
	}
}

fn parse_object_key(key: &str) -> Option<ParsedColdObjectKey> {
	let parts = key.split('/').collect::<Vec<_>>();
	if parts.len() != 8 || parts[1] != "cold" || parts[2] != "v2" {
		return None;
	}
	let database_branch_id = DatabaseBranchId::from_uuid(Uuid::parse_str(parts[3]).ok()?);
	let shard_id = u32::from_str_radix(parts[4], 16).ok()?;
	let as_of_txid = u64::from_str_radix(parts[5], 16).ok()?;
	let object_generation_id = Id::from_str(parts[6]).ok()?;
	let encoded_hash = parts[7].strip_suffix(".cold")?;
	let content_hash: [u8; 32] = URL_SAFE_NO_PAD.decode(encoded_hash).ok()?.try_into().ok()?;
	if parts[0] != format!("{:02x}{:02x}", content_hash[0], content_hash[1]) {
		return None;
	}
	let identity = ParsedColdObjectKey {
		database_branch_id,
		object_generation_id,
		shard_id,
		as_of_txid,
		content_hash,
	};
	(super::cold_shard_object_key(
		identity.database_branch_id,
		identity.object_generation_id,
		identity.shard_id,
		identity.as_of_txid,
		identity.content_hash,
	) == key)
		.then_some(identity)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn canonical_key_parser_rejects_fanout_and_suffix_forgery() {
		let branch = DatabaseBranchId::new_v4();
		let generation = Id::v1(Uuid::new_v4(), 1);
		let hash = [0x5a; 32];
		let key = super::super::cold_shard_object_key(branch, generation, 7, 11, hash);
		let parsed = parse_object_key(&key).expect("canonical key");
		assert_eq!(parsed.database_branch_id, branch);
		assert_eq!(parsed.object_generation_id, generation);
		assert_eq!(parsed.shard_id, 7);
		assert_eq!(parsed.as_of_txid, 11);
		assert_eq!(parsed.content_hash, hash);
		assert!(parse_object_key(&key.replacen("5a5a/", "0000/", 1)).is_none());
		assert!(parse_object_key(&format!("{key}.forged")).is_none());
	}
}
