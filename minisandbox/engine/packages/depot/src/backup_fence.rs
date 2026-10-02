use anyhow::{Context, Result, ensure};
use universaldb::utils::IsolationLevel::Serializable;

use crate::{
	keys,
	types::{
		ColdBackupRecoveryFence, decode_cold_backup_recovery_fence,
		encode_cold_backup_recovery_fence,
	},
};

/// Controllers should renew well inside this interval. A short hard ceiling prevents one stale
/// catalog observation from authorizing irreversible deletion indefinitely.
pub const COLD_BACKUP_FENCE_MAX_VALIDITY_MS: i64 = 15 * 60 * 1_000;
pub const COLD_BACKUP_CONTROLLER_MAX_LEASE_MS: i64 = 15 * 60 * 1_000;
pub type ColdBackupRecoveryPolicyFingerprint = [u8; 32];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ColdDeleteFenceEligibility {
	Eligible,
	Missing,
	PolicyMismatch,
	NotYetVerified,
	Stale,
	RestoreFloorTooOld,
}

impl ColdDeleteFenceEligibility {
	pub fn rejection_reason(&self) -> Option<&'static str> {
		match self {
			Self::Eligible => None,
			Self::Missing => Some("cold backup recovery fence is missing"),
			Self::PolicyMismatch => {
				Some("cold backup recovery fence was issued for a different recovery policy")
			}
			Self::NotYetVerified => Some("cold backup recovery fence is from the future"),
			Self::Stale => Some("cold backup recovery fence is stale"),
			Self::RestoreFloorTooOld => {
				Some("cold backup restore floor still includes the object tombstone")
			}
		}
	}
}

/// Certifies the backup contract used by irreversible object deletion. The restore floor can only
/// move forward. This function does not inspect backup storage: callers must be the controller that
/// has already verified the FDB backup catalog and expired every supported restore older than the
/// supplied floor.
pub async fn certify_cold_backup_recovery_fence(
	db: &universaldb::Database,
	policy_fingerprint: ColdBackupRecoveryPolicyFingerprint,
	fence: ColdBackupRecoveryFence,
) -> Result<ColdBackupRecoveryFence> {
	validate_fence_shape(&fence)?;
	ensure!(
		fence.policy_fingerprint == policy_fingerprint,
		"cold backup recovery fence policy fingerprint does not match the certifier"
	);
	db.txn("depot_certify_cold_backup_recovery_fence", move |tx| {
		let fence = fence.clone();
		async move {
			let policy_key = keys::cold_backup_recovery_policy_key();
			if let Some(existing) = tx.informal().get(&policy_key, Serializable).await? {
				ensure!(
					existing.as_slice() == policy_fingerprint,
					"cold backup recovery policy fingerprint does not match the durable binding"
				);
			} else {
				tx.informal().set(&policy_key, &policy_fingerprint);
			}
			let key = keys::cold_backup_recovery_fence_key();
			if let Some(encoded) = tx.informal().get(&key, Serializable).await? {
				let existing = decode_cold_backup_recovery_fence(&encoded)
					.context("decode existing cold backup recovery fence")?;
				ensure!(
					fence.minimum_restorable_version >= existing.minimum_restorable_version,
					"cold backup restore floor cannot move backwards"
				);
				ensure!(
					fence.verified_at_ms >= existing.verified_at_ms,
					"cold backup verification time cannot move backwards"
				);
			}
			tx.informal()
				.set(&key, &encode_cold_backup_recovery_fence(fence.clone())?);
			Ok(fence)
		}
	})
	.await
}

pub async fn read_cold_backup_recovery_policy_fingerprint(
	db: &universaldb::Database,
) -> Result<Option<ColdBackupRecoveryPolicyFingerprint>> {
	db.txn("depot_read_cold_backup_recovery_policy", |tx| async move {
		let Some(encoded) = tx
			.informal()
			.get(&keys::cold_backup_recovery_policy_key(), Serializable)
			.await?
		else {
			return Ok(None);
		};
		Ok(Some(encoded.as_slice().try_into().context(
			"cold backup recovery policy fingerprint had invalid length",
		)?))
	})
	.await
}

pub(crate) async fn read_cold_backup_recovery_policy_fingerprint_tx(
	tx: &universaldb::Transaction,
) -> Result<Option<ColdBackupRecoveryPolicyFingerprint>> {
	let Some(encoded) = tx
		.informal()
		.get(&keys::cold_backup_recovery_policy_key(), Serializable)
		.await?
	else {
		return Ok(None);
	};
	Ok(Some(encoded.as_slice().try_into().context(
		"cold backup recovery policy fingerprint had invalid length",
	)?))
}

/// Best-effort, UDB-backed leader lease that bounds catalog inspection to one Engine replica.
/// This lease controls work amplification only. A skewed clock can delay takeover or admit a
/// duplicate observer, but it cannot authorize deletion; only the separately verified recovery
/// fence can do that.
pub async fn try_acquire_cold_backup_controller_lease(
	db: &universaldb::Database,
	holder_id: [u8; 16],
	now_ms: i64,
	lease_ms: i64,
) -> Result<bool> {
	ensure!(
		now_ms >= 0,
		"cold backup controller lease time must be non-negative"
	);
	ensure!(
		lease_ms > 0 && lease_ms <= COLD_BACKUP_CONTROLLER_MAX_LEASE_MS,
		"cold backup controller lease duration is out of bounds"
	);
	let expires_at_ms = now_ms
		.checked_add(lease_ms)
		.context("cold backup controller lease expiry overflow")?;
	db.txn(
		"depot_acquire_cold_backup_controller_lease",
		move |tx| async move {
			let key = keys::cold_backup_recovery_controller_lease_key();
			if let Some(existing) = tx.informal().get(&key, Serializable).await? {
				ensure!(
					existing.len() == 24,
					"cold backup controller lease had invalid length"
				);
				let existing_holder: [u8; 16] = existing[..16]
					.try_into()
					.context("decode cold backup controller holder")?;
				let existing_expiry = i64::from_be_bytes(
					existing[16..]
						.try_into()
						.context("decode cold backup controller expiry")?,
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

/// Explicit recovery-policy migration. Callers must first disable physical deletion and retire
/// the old recovery contract operationally. The old fence remains as a monotonic restore-floor
/// high-water mark but its policy mismatch makes deletion fail closed until the new repository has
/// been fully observed and certified.
pub async fn rebind_cold_backup_recovery_policy(
	db: &universaldb::Database,
	expected: ColdBackupRecoveryPolicyFingerprint,
	replacement: ColdBackupRecoveryPolicyFingerprint,
) -> Result<()> {
	ensure!(
		expected != replacement,
		"cold backup recovery policy replacement must differ from the current fingerprint"
	);
	db.txn(
		"depot_rebind_cold_backup_recovery_policy",
		move |tx| async move {
			ensure!(
				!crate::cold_tier::policy::read_cold_gc_policy_tx(&tx)
					.await?
					.spec
					.deletion_enabled,
				"disable ColdGcPolicy before rebinding the backup recovery policy"
			);
			let policy_key = keys::cold_backup_recovery_policy_key();
			let existing = tx
				.informal()
				.get(&policy_key, Serializable)
				.await?
				.context("cold backup recovery policy is not bound")?;
			ensure!(
				existing.as_slice() == expected,
				"cold backup recovery policy did not match the expected fingerprint"
			);
			tx.informal().set(&policy_key, &replacement);
			tx.informal()
				.clear(&keys::cold_backup_recovery_controller_lease_key());
			Ok(())
		},
	)
	.await
}

pub async fn read_cold_backup_recovery_fence(
	db: &universaldb::Database,
) -> Result<Option<ColdBackupRecoveryFence>> {
	db.txn("depot_read_cold_backup_recovery_fence", |tx| async move {
		read_cold_backup_recovery_fence_tx(&tx).await
	})
	.await
}

pub(crate) async fn read_cold_backup_recovery_fence_tx(
	tx: &universaldb::Transaction,
) -> Result<Option<ColdBackupRecoveryFence>> {
	tx.informal()
		.get(&keys::cold_backup_recovery_fence_key(), Serializable)
		.await?
		.map(|encoded| decode_cold_backup_recovery_fence(&encoded))
		.transpose()
		.context("decode cold backup recovery fence")
}

pub(crate) async fn cold_delete_fence_eligibility_tx(
	tx: &universaldb::Transaction,
	tombstone_versionstamp: &[u8; 16],
	now_ms: i64,
) -> Result<ColdDeleteFenceEligibility> {
	let Some(fence) = read_cold_backup_recovery_fence_tx(tx).await? else {
		return Ok(ColdDeleteFenceEligibility::Missing);
	};
	let Some(policy_fingerprint) = read_cold_backup_recovery_policy_fingerprint_tx(tx).await?
	else {
		return Ok(ColdDeleteFenceEligibility::PolicyMismatch);
	};
	Ok(cold_delete_fence_eligibility_for_policy(
		&fence,
		&policy_fingerprint,
		tombstone_versionstamp,
		now_ms,
	))
}

pub fn cold_delete_fence_eligibility_for_policy(
	fence: &ColdBackupRecoveryFence,
	policy_fingerprint: &ColdBackupRecoveryPolicyFingerprint,
	tombstone_versionstamp: &[u8; 16],
	now_ms: i64,
) -> ColdDeleteFenceEligibility {
	if &fence.policy_fingerprint != policy_fingerprint {
		return ColdDeleteFenceEligibility::PolicyMismatch;
	}
	cold_delete_fence_eligibility(fence, tombstone_versionstamp, now_ms)
}

pub fn cold_delete_fence_eligibility(
	fence: &ColdBackupRecoveryFence,
	tombstone_versionstamp: &[u8; 16],
	now_ms: i64,
) -> ColdDeleteFenceEligibility {
	if fence.verified_at_ms > now_ms {
		return ColdDeleteFenceEligibility::NotYetVerified;
	}
	if fence.valid_until_ms < now_ms {
		return ColdDeleteFenceEligibility::Stale;
	}
	// Equality is deliberately insufficient: that restore can still observe the pre-tombstone
	// state. FDB commit versions, unlike wall clocks, authoritatively order the two transactions.
	if fence.minimum_restorable_version <= fdb_commit_version(tombstone_versionstamp) {
		return ColdDeleteFenceEligibility::RestoreFloorTooOld;
	}
	ColdDeleteFenceEligibility::Eligible
}

fn validate_fence_shape(fence: &ColdBackupRecoveryFence) -> Result<()> {
	ensure!(
		fence.verified_at_ms >= 0,
		"cold backup verification time must be non-negative"
	);
	ensure!(
		fence.valid_until_ms > fence.verified_at_ms,
		"cold backup recovery fence must expire after verification"
	);
	ensure!(
		fence
			.valid_until_ms
			.checked_sub(fence.verified_at_ms)
			.is_some_and(|validity_ms| validity_ms <= COLD_BACKUP_FENCE_MAX_VALIDITY_MS),
		"cold backup recovery fence validity exceeds the maximum lease"
	);
	Ok(())
}

/// Extracts FoundationDB's 64-bit commit version from Depot's 16-byte versionstamp field. The
/// following two FDB batch bytes and Depot's six reserved bytes do not affect backup read versions.
pub fn fdb_commit_version(versionstamp: &[u8; 16]) -> u64 {
	u64::from_be_bytes(
		versionstamp[..8]
			.try_into()
			.expect("FDB commit version is exactly eight bytes"),
	)
}
