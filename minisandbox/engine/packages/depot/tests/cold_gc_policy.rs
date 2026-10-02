mod common;

use anyhow::Result;
use depot::{
	backup_fence::{certify_cold_backup_recovery_fence, rebind_cold_backup_recovery_policy},
	cold_tier::{ColdGcPolicySpec, read_cold_gc_policy, set_cold_gc_policy},
	types::ColdBackupRecoveryFence,
};

const POLICY_A: [u8; 32] = [0x41; 32];
const POLICY_B: [u8; 32] = [0x42; 32];

async fn bind_backup_policy(db: &universaldb::Database, policy: [u8; 32]) -> Result<()> {
	certify_cold_backup_recovery_fence(
		db,
		policy,
		ColdBackupRecoveryFence {
			policy_fingerprint: policy,
			minimum_restorable_version: 10,
			verified_at_ms: 1_000,
			valid_until_ms: 10_000,
		},
	)
	.await?;
	Ok(())
}

#[tokio::test]
async fn missing_policy_is_disabled_and_enable_requires_backup_binding() -> Result<()> {
	let db = common::test_db("depot-cold-gc-policy-default-").await?;
	let policy = read_cold_gc_policy(&db).await?;
	assert_eq!(policy.revision, 0);
	assert!(!policy.spec.deletion_enabled);
	assert!(policy.spec.dry_run);
	assert_eq!(policy.backup_policy_fingerprint, None);

	let error = set_cold_gc_policy(&db, 0, enabled_spec(), 1_000)
		.await
		.expect_err("an unbound recovery contract must never authorize deletes");
	assert!(format!("{error:#}").contains("backup recovery policy is bound"));
	assert_eq!(read_cold_gc_policy(&db).await?, policy);
	Ok(())
}

#[tokio::test]
async fn policy_updates_are_cas_guarded_and_bind_the_backup_contract() -> Result<()> {
	let db = common::test_db("depot-cold-gc-policy-cas-").await?;
	bind_backup_policy(&db, POLICY_A).await?;

	let enabled = set_cold_gc_policy(&db, 0, enabled_spec(), 2_000).await?;
	assert_eq!(enabled.revision, 1);
	assert!(enabled.spec.deletion_enabled);
	assert!(!enabled.spec.dry_run);
	assert_eq!(enabled.backup_policy_fingerprint, Some(POLICY_A));

	let stale = set_cold_gc_policy(&db, 0, ColdGcPolicySpec::default(), 2_001)
		.await
		.expect_err("a stale operator must not overwrite a newer policy");
	assert!(format!("{stale:#}").contains("revision mismatch"));
	assert_eq!(read_cold_gc_policy(&db).await?, enabled);

	let disabled = set_cold_gc_policy(&db, 1, ColdGcPolicySpec::default(), 2_002).await?;
	assert_eq!(disabled.revision, 2);
	assert!(!disabled.spec.deletion_enabled);
	assert_eq!(disabled.backup_policy_fingerprint, None);
	Ok(())
}

#[tokio::test]
async fn recovery_policy_rebind_does_not_silently_reauthorize_gc() -> Result<()> {
	let db = common::test_db("depot-cold-gc-policy-rebind-").await?;
	bind_backup_policy(&db, POLICY_A).await?;
	let enabled = set_cold_gc_policy(&db, 0, enabled_spec(), 2_000).await?;

	let error = rebind_cold_backup_recovery_policy(&db, POLICY_A, POLICY_B)
		.await
		.expect_err("backup contract rebind must atomically require disabled GC");
	assert!(format!("{error:#}").contains("disable ColdGcPolicy"));
	let disabled =
		set_cold_gc_policy(&db, enabled.revision, ColdGcPolicySpec::default(), 2_001).await?;
	rebind_cold_backup_recovery_policy(&db, POLICY_A, POLICY_B).await?;
	let error = set_cold_gc_policy(&db, disabled.revision, enabled_spec(), 2_002)
		.await
		.expect_err("the replacement recovery contract must be certified before re-enable");
	assert!(format!("{error:#}").contains("fresh matching backup recovery fence"));
	Ok(())
}

#[tokio::test]
async fn dry_run_and_operating_bounds_fail_closed() -> Result<()> {
	let db = common::test_db("depot-cold-gc-policy-dry-run-").await?;
	bind_backup_policy(&db, POLICY_A).await?;
	let dry_run = ColdGcPolicySpec {
		deletion_enabled: true,
		dry_run: true,
		..Default::default()
	};
	let stored = set_cold_gc_policy(&db, 0, dry_run, 2_000).await?;
	assert!(stored.spec.deletion_enabled);
	assert!(stored.spec.dry_run);

	let mut invalid = ColdGcPolicySpec::default();
	invalid.max_objects_per_batch = 101;
	let error = set_cold_gc_policy(&db, stored.revision, invalid, 2_001)
		.await
		.expect_err("a batch above the compiled exact-delete bound must be rejected");
	assert!(format!("{error:#}").contains("max objects per batch"));
	assert_eq!(read_cold_gc_policy(&db).await?, stored);
	Ok(())
}

fn enabled_spec() -> ColdGcPolicySpec {
	ColdGcPolicySpec {
		deletion_enabled: true,
		dry_run: false,
		..Default::default()
	}
}
