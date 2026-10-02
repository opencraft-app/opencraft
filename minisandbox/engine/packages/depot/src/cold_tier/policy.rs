use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use universaldb::utils::IsolationLevel::Serializable;
use vbare::OwnedVersionedData;

use crate::{
	backup_fence::{
		ColdBackupRecoveryPolicyFingerprint, ColdDeleteFenceEligibility,
		cold_delete_fence_eligibility_for_policy, read_cold_backup_recovery_fence_tx,
		read_cold_backup_recovery_policy_fingerprint_tx,
	},
	conveyer::{keys, types::SQLITE_STORAGE_META_VERSION},
	types::{ColdDeleteAuthorization, ColdDeleteReason},
};

/// Cell-wide authorization for irreversible exact-key cold deletion.
///
/// This is deliberately independent from the object-store identity and Engine configuration.
/// Missing policy means disabled. When enabled, it is pinned to the durable backup recovery
/// policy so rebinding that recovery contract immediately makes every deletion fail closed.
pub const DEFAULT_COLD_GC_GRACE_PERIOD_MS: u64 = 7 * 24 * 60 * 60 * 1000;
pub const DEFAULT_COLD_GC_MAX_DELETE_CONCURRENCY: u16 = 4;
pub const DEFAULT_COLD_GC_MAX_OBJECTS_PER_BATCH: u16 = 100;
pub const DEFAULT_COLD_GC_RETRY_MAX_ATTEMPTS: u16 = 5;
pub const DEFAULT_COLD_GC_RETRY_INITIAL_BACKOFF_MS: u64 = 250;
pub const DEFAULT_COLD_GC_RETRY_MAX_BACKOFF_MS: u64 = 10_000;

/// Mutable operating parameters. The immutable object-store identity intentionally excludes these
/// values: tuning GC must not make an existing Cell refuse to start. The whole spec is nevertheless
/// CAS-persisted with the deletion authorization, so workers never combine fields from two updates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColdGcPolicySpec {
	pub deletion_enabled: bool,
	pub grace_period_ms: u64,
	pub max_delete_concurrency: u16,
	pub max_objects_per_batch: u16,
	pub retry_max_attempts: u16,
	pub retry_initial_backoff_ms: u64,
	pub retry_max_backoff_ms: u64,
	pub dry_run: bool,
}

impl Default for ColdGcPolicySpec {
	fn default() -> Self {
		Self {
			deletion_enabled: false,
			grace_period_ms: DEFAULT_COLD_GC_GRACE_PERIOD_MS,
			max_delete_concurrency: DEFAULT_COLD_GC_MAX_DELETE_CONCURRENCY,
			max_objects_per_batch: DEFAULT_COLD_GC_MAX_OBJECTS_PER_BATCH,
			retry_max_attempts: DEFAULT_COLD_GC_RETRY_MAX_ATTEMPTS,
			retry_initial_backoff_ms: DEFAULT_COLD_GC_RETRY_INITIAL_BACKOFF_MS,
			retry_max_backoff_ms: DEFAULT_COLD_GC_RETRY_MAX_BACKOFF_MS,
			dry_run: true,
		}
	}
}

impl ColdGcPolicySpec {
	pub fn validate(&self) -> Result<()> {
		ensure!(
			self.grace_period_ms > 0,
			"ColdGcPolicy grace period must be positive"
		);
		ensure!(
			self.max_delete_concurrency > 0 && self.max_delete_concurrency <= 256,
			"ColdGcPolicy max delete concurrency must be between 1 and 256"
		);
		ensure!(
			self.max_objects_per_batch > 0
				&& usize::from(self.max_objects_per_batch) <= crate::CMP_COLD_DELETE_MAX_OBJECTS,
			"ColdGcPolicy max objects per batch must be between 1 and {}",
			crate::CMP_COLD_DELETE_MAX_OBJECTS
		);
		ensure!(
			self.retry_max_attempts > 0 && self.retry_max_attempts <= 32,
			"ColdGcPolicy retry max attempts must be between 1 and 32"
		);
		ensure!(
			self.retry_initial_backoff_ms > 0
				&& self.retry_initial_backoff_ms <= self.retry_max_backoff_ms
				&& self.retry_max_backoff_ms <= 5 * 60 * 1000,
			"ColdGcPolicy retry backoff must be positive, ordered, and at most five minutes"
		);
		Ok(())
	}
}

/// Returns the earliest time at which a previously tombstoned object may be deleted under the
/// current policy. A policy update may extend an existing grace window, but it must never shorten
/// the deadline captured when the tombstone was written.
pub(crate) fn effective_delete_after_ms(
	tombstoned_at_ms: i64,
	stored_delete_after_ms: i64,
	current_grace_period_ms: u64,
) -> Result<i64> {
	ensure!(
		tombstoned_at_ms >= 0 && stored_delete_after_ms >= 0,
		"cold delete timestamps must be non-negative"
	);
	let current_grace_period_ms = i64::try_from(current_grace_period_ms)
		.context("ColdGcPolicy grace period exceeds signed timestamp range")?;
	Ok(stored_delete_after_ms.max(tombstoned_at_ms.saturating_add(current_grace_period_ms)))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColdGcPolicy {
	pub revision: u64,
	pub spec: ColdGcPolicySpec,
	pub backup_policy_fingerprint: Option<ColdBackupRecoveryPolicyFingerprint>,
	pub updated_at_ms: i64,
}

impl Default for ColdGcPolicy {
	fn default() -> Self {
		Self {
			revision: 0,
			spec: ColdGcPolicySpec::default(),
			backup_policy_fingerprint: None,
			updated_at_ms: 0,
		}
	}
}

enum VersionedColdGcPolicy {
	V1(ColdGcPolicy),
}

impl OwnedVersionedData for VersionedColdGcPolicy {
	type Latest = ColdGcPolicy;

	fn wrap_latest(latest: Self::Latest) -> Self {
		Self::V1(latest)
	}

	fn unwrap_latest(self) -> Result<Self::Latest> {
		match self {
			Self::V1(policy) => Ok(policy),
		}
	}

	fn deserialize_version(payload: &[u8], version: u16) -> Result<Self> {
		match version {
			1 => Ok(Self::V1(rivet_util::serde::bare_from_slice!(payload)?)),
			_ => bail!("invalid Depot ColdGcPolicy version: {version}"),
		}
	}

	fn serialize_version(self, _version: u16) -> Result<Vec<u8>> {
		match self {
			Self::V1(policy) => rivet_util::serde::bare_to_vec!(&policy).map_err(Into::into),
		}
	}
}

fn encode(policy: ColdGcPolicy) -> Result<Vec<u8>> {
	VersionedColdGcPolicy::wrap_latest(policy)
		.serialize_with_embedded_version(SQLITE_STORAGE_META_VERSION)
		.context("encode Depot ColdGcPolicy")
}

fn decode(payload: &[u8]) -> Result<ColdGcPolicy> {
	VersionedColdGcPolicy::deserialize_with_embedded_version(payload)
		.context("decode Depot ColdGcPolicy")
}

pub async fn read_cold_gc_policy(db: &universaldb::Database) -> Result<ColdGcPolicy> {
	db.txn("depot_read_cold_gc_policy", |tx| async move {
		read_cold_gc_policy_tx(&tx).await
	})
	.await
}

pub(crate) async fn read_cold_gc_policy_tx(tx: &universaldb::Transaction) -> Result<ColdGcPolicy> {
	tx.informal()
		.get(&keys::cold_gc_policy_key(), Serializable)
		.await?
		.map(|encoded| decode(&encoded))
		.transpose()
		.context("read Depot ColdGcPolicy")
		.map(Option::unwrap_or_default)
}

/// Returns the enabled policy only when its backup contract still matches the durable recovery
/// policy. Call this inside the same serializable transaction that marks deletion issued.
pub(crate) async fn require_cold_gc_deletion_tx(
	tx: &universaldb::Transaction,
) -> Result<std::result::Result<ColdGcPolicy, String>> {
	let policy = read_cold_gc_policy_tx(tx).await?;
	if !policy.spec.deletion_enabled {
		return Ok(Err(
			"cold object deletion is disabled by ColdGcPolicy".to_string()
		));
	}
	if policy.spec.dry_run {
		return Ok(Err(
			"cold object deletion is in ColdGcPolicy dry-run mode".to_string()
		));
	}
	let Some(bound_fingerprint) = policy.backup_policy_fingerprint else {
		return Ok(Err(
			"enabled ColdGcPolicy is not bound to a backup recovery policy".to_string(),
		));
	};
	let Some(current_fingerprint) = read_cold_backup_recovery_policy_fingerprint_tx(tx).await?
	else {
		return Ok(Err(
			"cold backup recovery policy is not durably bound".to_string()
		));
	};
	if current_fingerprint != bound_fingerprint {
		return Ok(Err(
			"ColdGcPolicy belongs to a different backup recovery policy".to_string(),
		));
	}
	Ok(Ok(policy))
}

pub(crate) async fn authorize_cold_gc_deletion_tx(
	tx: &universaldb::Transaction,
	tombstone_versionstamp: [u8; 16],
	now_ms: i64,
	reason: ColdDeleteReason,
) -> Result<std::result::Result<ColdDeleteAuthorization, String>> {
	let policy = match require_cold_gc_deletion_tx(tx).await? {
		Ok(policy) => policy,
		Err(reason) => return Ok(Err(reason)),
	};
	let fingerprint = policy
		.backup_policy_fingerprint
		.expect("enabled validated ColdGcPolicy has a backup fingerprint");
	let Some(fence) = read_cold_backup_recovery_fence_tx(tx).await? else {
		return Ok(Err("cold backup recovery fence is missing".to_string()));
	};
	let eligibility = cold_delete_fence_eligibility_for_policy(
		&fence,
		&fingerprint,
		&tombstone_versionstamp,
		now_ms,
	);
	if eligibility != ColdDeleteFenceEligibility::Eligible {
		return Ok(Err(eligibility
			.rejection_reason()
			.unwrap_or("cold backup recovery fence rejected deletion")
			.to_string()));
	}
	Ok(Ok(ColdDeleteAuthorization {
		reason,
		policy_revision: Some(policy.revision),
		backup_policy_fingerprint: Some(fingerprint),
		minimum_restorable_version: Some(fence.minimum_restorable_version),
		fence_verified_at_ms: Some(fence.verified_at_ms),
		fence_valid_until_ms: Some(fence.valid_until_ms),
		tombstone_versionstamp: Some(tombstone_versionstamp),
		issued_at_ms: now_ms,
	}))
}

/// CAS mutation used by the operator command. Enabling binds to the currently durable backup
/// recovery policy; disabling removes that binding. No configuration file can authorize deletes.
pub async fn set_cold_gc_policy(
	db: &universaldb::Database,
	expected_revision: u64,
	spec: ColdGcPolicySpec,
	updated_at_ms: i64,
) -> Result<ColdGcPolicy> {
	ensure!(
		updated_at_ms >= 0,
		"ColdGcPolicy update time must be non-negative"
	);
	spec.validate()?;
	db.txn("depot_set_cold_gc_policy", move |tx| {
		let spec = spec.clone();
		async move {
			let current = read_cold_gc_policy_tx(&tx).await?;
			ensure!(
				current.revision == expected_revision,
				"ColdGcPolicy revision mismatch: expected {expected_revision}, current {}",
				current.revision
			);
			let backup_policy_fingerprint = if spec.deletion_enabled {
				let fingerprint = read_cold_backup_recovery_policy_fingerprint_tx(&tx)
					.await?
					.context("cannot enable ColdGcPolicy before backup recovery policy is bound")?;
				let fence = read_cold_backup_recovery_fence_tx(&tx)
					.await?
					.context("cannot enable ColdGcPolicy before a recovery fence is certified")?;
				ensure!(
					fence.policy_fingerprint == fingerprint
						&& fence.verified_at_ms <= updated_at_ms
						&& fence.valid_until_ms >= updated_at_ms,
					"cannot enable ColdGcPolicy without a fresh matching backup recovery fence"
				);
				Some(fingerprint)
			} else {
				None
			};
			let replacement = ColdGcPolicy {
				revision: current
					.revision
					.checked_add(1)
					.context("ColdGcPolicy revision overflow")?,
				spec: spec.clone(),
				backup_policy_fingerprint,
				updated_at_ms,
			};
			tx.informal()
				.set(&keys::cold_gc_policy_key(), &encode(replacement.clone())?);
			Ok(replacement)
		}
	})
	.await
}

#[cfg(test)]
mod tests {
	use super::effective_delete_after_ms;

	#[test]
	fn current_grace_can_only_extend_an_existing_deadline() {
		assert_eq!(
			effective_delete_after_ms(1_000, 8_000, 30_000).unwrap(),
			31_000
		);
		assert_eq!(
			effective_delete_after_ms(1_000, 31_000, 7_000).unwrap(),
			31_000
		);
	}
}
