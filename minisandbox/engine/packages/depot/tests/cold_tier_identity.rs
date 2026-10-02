mod common;

use anyhow::Result;
use depot::{cold_tier::ensure_cold_tier_identity, conveyer::keys::cold_tier_identity_key};
use rivet_config::{
	Config,
	config::{
		Root, Sqlite, SqliteWorkflowColdStorage, SqliteWorkflowColdStorageS3,
		SqliteWorkflowColdStorageS3AddressingStyle,
	},
};

fn disabled_config() -> Config {
	Config::from_root(Root::default())
}

fn s3_config(bucket: &str, endpoint: Option<&str>, max_concurrent_requests: usize) -> Config {
	s3_config_with_recovery(
		bucket,
		endpoint,
		max_concurrent_requests,
		7 * 24 * 60 * 60 * 1000,
	)
}

fn s3_config_with_recovery(
	bucket: &str,
	endpoint: Option<&str>,
	max_concurrent_requests: usize,
	recovery_window_ms: u64,
) -> Config {
	let mut root = Root::default();
	root.sqlite = Some(Sqlite {
		unstable_disable_compaction: Some(false),
		workflow_cold_storage: Some(SqliteWorkflowColdStorage::S3(SqliteWorkflowColdStorageS3 {
			bucket: bucket.to_string(),
			endpoint: endpoint.map(str::to_string),
			region: "ap-beijing".to_string(),
			addressing_style: SqliteWorkflowColdStorageS3AddressingStyle::Path,
			recovery_window_ms,
			max_object_size_bytes: 4 * 1024 * 1024,
			max_concurrent_requests,
			max_queued_requests: 64,
			queue_timeout_ms: 15_000,
		})),
		workflow_write_debt: Default::default(),
		backup_recovery_fence_controller: None,
	});
	Config::from_root(root)
}

#[tokio::test]
async fn unversioned_legacy_identity_is_rejected_without_overwrite() -> Result<()> {
	let db = common::test_db("depot-cold-identity-reject-legacy-").await?;
	let key = cold_tier_identity_key();
	let legacy_payload = br#"{"bucket":"legacy-cold"}"#.to_vec();
	let write_key = key.clone();
	let write_payload = legacy_payload.clone();
	db.txn("test_depotcoldidentity_seed_legacy", move |tx| {
		let key = write_key.clone();
		let payload = write_payload.clone();
		async move {
			tx.informal().set(&key, &payload);
			Ok(())
		}
	})
	.await?;

	let error = ensure_cold_tier_identity(&s3_config("production-cold", None, 16), &db)
		.await
		.expect_err("unversioned legacy identity must fail closed");
	assert!(
		format!("{error:#}").contains("decode persisted Depot cold-tier identity"),
		"unexpected error: {error:#}"
	);
	assert_eq!(common::read_value(&db, key).await?, Some(legacy_payload));
	Ok(())
}

#[tokio::test]
async fn first_enabled_identity_is_idempotent_and_ignores_local_tuning() -> Result<()> {
	let db = common::test_db("depot-cold-identity-idempotent-").await?;
	let first = s3_config(
		"production-cold",
		Some("https://cos.ap-beijing.myqcloud.com/"),
		4,
	);
	let equivalent = s3_config(
		"production-cold",
		Some("https://cos.ap-beijing.myqcloud.com"),
		128,
	);

	ensure_cold_tier_identity(&first, &db).await?;
	ensure_cold_tier_identity(&first, &db).await?;
	ensure_cold_tier_identity(&equivalent, &db).await?;
	Ok(())
}

#[tokio::test]
async fn correctness_relevant_mismatch_fails_closed() -> Result<()> {
	let db = common::test_db("depot-cold-identity-mismatch-").await?;
	let first = s3_config("production-cold", None, 16);
	let wrong_bucket = s3_config("wrong-cold", None, 16);

	ensure_cold_tier_identity(&first, &db).await?;
	let error = ensure_cold_tier_identity(&wrong_bucket, &db)
		.await
		.expect_err("different object-store identity must not start");
	assert!(
		format!("{error:#}").contains("cold-tier identity mismatch"),
		"unexpected error: {error:#}"
	);
	Ok(())
}

#[tokio::test]
async fn recovery_window_cannot_differ_between_workers() -> Result<()> {
	let db = common::test_db("depot-cold-identity-recovery-window-").await?;
	let seven_days = s3_config_with_recovery("production-cold", None, 16, 7 * 24 * 60 * 60 * 1000);
	let thirty_days =
		s3_config_with_recovery("production-cold", None, 16, 30 * 24 * 60 * 60 * 1000);

	ensure_cold_tier_identity(&seven_days, &db).await?;
	let error = ensure_cold_tier_identity(&thirty_days, &db)
		.await
		.expect_err("mixed recovery windows could delete objects too early");
	assert!(
		format!("{error:#}").contains("cold-tier identity mismatch"),
		"unexpected error: {error:#}"
	);
	Ok(())
}

#[tokio::test]
async fn installed_cold_tier_cannot_be_silently_disabled() -> Result<()> {
	let db = common::test_db("depot-cold-identity-disable-").await?;
	let configured = s3_config("production-cold", None, 16);

	ensure_cold_tier_identity(&configured, &db).await?;
	let error = ensure_cold_tier_identity(&disabled_config(), &db)
		.await
		.expect_err("disabled worker must reject existing cold refs");
	assert!(
		format!("{error:#}").contains("cannot be disabled"),
		"unexpected error: {error:#}"
	);
	Ok(())
}

#[tokio::test]
async fn disabled_cluster_does_not_bind_future_cold_tier() -> Result<()> {
	let db = common::test_db("depot-cold-identity-late-enable-").await?;

	ensure_cold_tier_identity(&disabled_config(), &db).await?;
	ensure_cold_tier_identity(&s3_config("production-cold", None, 16), &db).await?;
	Ok(())
}

#[tokio::test]
async fn concurrent_first_writers_cannot_install_two_identities() -> Result<()> {
	let db = common::test_db_arc("depot-cold-identity-race-").await?;
	let a = s3_config("cold-a", None, 16);
	let b = s3_config("cold-b", None, 16);

	let (a_result, b_result) = tokio::join!(
		ensure_cold_tier_identity(&a, &db),
		ensure_cold_tier_identity(&b, &db),
	);
	assert_eq!(
		usize::from(a_result.is_ok()) + usize::from(b_result.is_ok()),
		1
	);
	let error = a_result.err().or_else(|| b_result.err()).unwrap();
	assert!(
		format!("{error:#}").contains("cold-tier identity mismatch"),
		"unexpected error: {error:#}"
	);
	Ok(())
}
