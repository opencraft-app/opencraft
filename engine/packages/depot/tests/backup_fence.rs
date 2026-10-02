mod common;

use anyhow::Result;
use depot::{
	backup_fence::{
		ColdDeleteFenceEligibility, certify_cold_backup_recovery_fence,
		cold_delete_fence_eligibility, cold_delete_fence_eligibility_for_policy,
		fdb_commit_version, read_cold_backup_recovery_fence,
		read_cold_backup_recovery_policy_fingerprint, rebind_cold_backup_recovery_policy,
		try_acquire_cold_backup_controller_lease,
	},
	types::ColdBackupRecoveryFence,
};

const TEST_BACKUP_POLICY: [u8; 32] = [0x42; 32];

#[test]
fn cold_delete_fence_requires_fresh_proof_strictly_beyond_tombstone() {
	let tombstone_versionstamp = versionstamp(1_000);
	assert_eq!(
		cold_delete_fence_eligibility(
			&ColdBackupRecoveryFence {
				policy_fingerprint: TEST_BACKUP_POLICY,
				minimum_restorable_version: 1_000,
				verified_at_ms: 2_000,
				valid_until_ms: 3_000,
			},
			&tombstone_versionstamp,
			2_500,
		),
		ColdDeleteFenceEligibility::RestoreFloorTooOld
	);
	assert_eq!(
		cold_delete_fence_eligibility(
			&ColdBackupRecoveryFence {
				policy_fingerprint: TEST_BACKUP_POLICY,
				minimum_restorable_version: 1_001,
				verified_at_ms: 2_000,
				valid_until_ms: 2_499,
			},
			&tombstone_versionstamp,
			2_500,
		),
		ColdDeleteFenceEligibility::Stale
	);
	assert_eq!(
		cold_delete_fence_eligibility(
			&ColdBackupRecoveryFence {
				policy_fingerprint: TEST_BACKUP_POLICY,
				minimum_restorable_version: 1_001,
				verified_at_ms: 2_501,
				valid_until_ms: 3_000,
			},
			&tombstone_versionstamp,
			2_500,
		),
		ColdDeleteFenceEligibility::NotYetVerified
	);
	assert_eq!(
		cold_delete_fence_eligibility(
			&ColdBackupRecoveryFence {
				policy_fingerprint: TEST_BACKUP_POLICY,
				minimum_restorable_version: 1_001,
				verified_at_ms: 2_000,
				valid_until_ms: 3_000,
			},
			&tombstone_versionstamp,
			2_500,
		),
		ColdDeleteFenceEligibility::Eligible
	);
}

#[tokio::test]
async fn backup_restore_floor_is_durable_and_cannot_move_backwards() -> Result<()> {
	let db = common::test_db("depot-backup-fence-").await?;
	let first = ColdBackupRecoveryFence {
		policy_fingerprint: TEST_BACKUP_POLICY,
		minimum_restorable_version: 1_000,
		verified_at_ms: 2_000,
		valid_until_ms: 3_000,
	};
	certify_cold_backup_recovery_fence(&db, TEST_BACKUP_POLICY, first.clone()).await?;
	assert_eq!(read_cold_backup_recovery_fence(&db).await?, Some(first));
	assert_eq!(
		read_cold_backup_recovery_policy_fingerprint(&db).await?,
		Some(TEST_BACKUP_POLICY)
	);

	let policy_switch = ColdBackupRecoveryFence {
		policy_fingerprint: [0x24; 32],
		minimum_restorable_version: 1_500,
		verified_at_ms: 2_500,
		valid_until_ms: 3_500,
	};
	let error = certify_cold_backup_recovery_fence(&db, [0x24; 32], policy_switch)
		.await
		.expect_err("switching repositories must not hide older supported backups");
	assert!(format!("{error:#}").contains("policy fingerprint"));

	let backwards = ColdBackupRecoveryFence {
		policy_fingerprint: TEST_BACKUP_POLICY,
		minimum_restorable_version: 999,
		verified_at_ms: 2_500,
		valid_until_ms: 3_500,
	};
	let error = certify_cold_backup_recovery_fence(&db, TEST_BACKUP_POLICY, backwards)
		.await
		.expect_err("restore floor regression must fail closed");
	assert!(format!("{error:#}").contains("cannot move backwards"));

	let renewed = ColdBackupRecoveryFence {
		policy_fingerprint: TEST_BACKUP_POLICY,
		minimum_restorable_version: 1_500,
		verified_at_ms: 2_500,
		valid_until_ms: 3_500,
	};
	certify_cold_backup_recovery_fence(&db, TEST_BACKUP_POLICY, renewed.clone()).await?;
	assert_eq!(read_cold_backup_recovery_fence(&db).await?, Some(renewed));

	let overly_long = ColdBackupRecoveryFence {
		policy_fingerprint: TEST_BACKUP_POLICY,
		minimum_restorable_version: 2_000,
		verified_at_ms: 3_000,
		valid_until_ms: 3_000 + depot::backup_fence::COLD_BACKUP_FENCE_MAX_VALIDITY_MS + 1,
	};
	let error = certify_cold_backup_recovery_fence(&db, TEST_BACKUP_POLICY, overly_long)
		.await
		.expect_err("a stale catalog observation must not authorize long-lived deletion");
	assert!(format!("{error:#}").contains("maximum lease"));
	Ok(())
}

#[tokio::test]
async fn backup_controller_leader_lease_bounds_replica_work_and_allows_takeover() -> Result<()> {
	let db = common::test_db("depot-backup-controller-lease-").await?;
	let first = [1; 16];
	let second = [2; 16];
	assert!(try_acquire_cold_backup_controller_lease(&db, first, 1_000, 500).await?);
	assert!(try_acquire_cold_backup_controller_lease(&db, first, 1_100, 500).await?);
	assert!(!try_acquire_cold_backup_controller_lease(&db, second, 1_599, 500).await?);
	assert!(try_acquire_cold_backup_controller_lease(&db, second, 1_600, 500).await?);
	assert!(!try_acquire_cold_backup_controller_lease(&db, first, 1_700, 500).await?);
	Ok(())
}

#[tokio::test]
async fn policy_rebind_invalidates_fence_without_lowering_restore_floor() -> Result<()> {
	let db = common::test_db("depot-backup-policy-rebind-").await?;
	let replacement = [0x24; 32];
	let first = ColdBackupRecoveryFence {
		policy_fingerprint: TEST_BACKUP_POLICY,
		minimum_restorable_version: 1_000,
		verified_at_ms: 2_000,
		valid_until_ms: 3_000,
	};
	certify_cold_backup_recovery_fence(&db, TEST_BACKUP_POLICY, first.clone()).await?;

	let error = rebind_cold_backup_recovery_policy(&db, [0x11; 32], replacement)
		.await
		.expect_err("rebind must compare the current policy identity");
	assert!(format!("{error:#}").contains("expected fingerprint"));

	rebind_cold_backup_recovery_policy(&db, TEST_BACKUP_POLICY, replacement).await?;
	assert_eq!(
		read_cold_backup_recovery_fence(&db).await?,
		Some(first.clone())
	);
	assert_eq!(
		cold_delete_fence_eligibility_for_policy(&first, &replacement, &versionstamp(999), 2_500,),
		ColdDeleteFenceEligibility::PolicyMismatch
	);
	let backwards = ColdBackupRecoveryFence {
		policy_fingerprint: replacement,
		minimum_restorable_version: 999,
		verified_at_ms: 2_500,
		valid_until_ms: 3_500,
	};
	let error = certify_cold_backup_recovery_fence(&db, replacement, backwards)
		.await
		.expect_err("policy migration must preserve the historic restore-floor high-water mark");
	assert!(format!("{error:#}").contains("cannot move backwards"));
	assert_eq!(
		read_cold_backup_recovery_policy_fingerprint(&db).await?,
		Some(replacement)
	);
	Ok(())
}

fn versionstamp(commit_version: u64) -> [u8; 16] {
	let mut versionstamp = [0_u8; 16];
	versionstamp[..8].copy_from_slice(&commit_version.to_be_bytes());
	assert_eq!(fdb_commit_version(&versionstamp), commit_version);
	versionstamp
}
