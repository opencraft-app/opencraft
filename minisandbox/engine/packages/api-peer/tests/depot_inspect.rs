use anyhow::Result;
use axum_test::TestServer;
use base64::{Engine, prelude::BASE64_URL_SAFE_NO_PAD};
use depot::{
	keys::{branch_meta_head_key, database_pointer_cur_key},
	types::{
		BucketBranchId, DBHead, DatabaseBranchId, DatabasePointer, encode_database_pointer,
		encode_db_head,
	},
};
use rivet_config::config::{
	Database, Root,
	db::FileSystem,
	sqlite::{Sqlite, SqliteWorkflowColdStorage, SqliteWorkflowColdStorageFileSystem},
};

#[tokio::test]
async fn depot_inspect_routes_are_registered_on_api_peer() -> Result<()> {
	let tempdir = tempfile::tempdir()?;
	let mut root = Root::default();
	root.database = Some(Database::FileSystem(FileSystem {
		path: tempdir.path().join("udb"),
	}));
	root.sqlite = Some(Sqlite {
		unstable_disable_compaction: Some(false),
		workflow_cold_storage: Some(SqliteWorkflowColdStorage::FileSystem(
			SqliteWorkflowColdStorageFileSystem {
				root: tempdir.path().join("cold").display().to_string(),
				recovery_window_ms: 24 * 60 * 60 * 1_000,
				max_object_size_bytes: 4 * 1024 * 1024,
				max_concurrent_requests: 16,
				max_queued_requests: 64,
				queue_timeout_ms: 15_000,
			},
		)),
		workflow_write_debt: Default::default(),
		backup_recovery_fence_controller: None,
	});
	let config = rivet_config::Config::from_root(root);
	let pools = rivet_pools::Pools::test(config.clone()).await?;
	let checkpoint_branch_id = DatabaseBranchId::from_uuid(uuid::Uuid::from_u128(1));
	pools
		.udb()?
		.txn("seed_depot_checkpoint_route", move |tx| async move {
			tx.informal().set(
				&database_pointer_cur_key(BucketBranchId::nil(), "bottomless-test"),
				&encode_database_pointer(DatabasePointer {
					current_branch: checkpoint_branch_id,
					last_swapped_at_ms: 1,
				})?,
			);
			tx.informal().set(
				&branch_meta_head_key(checkpoint_branch_id),
				&encode_db_head(DBHead {
					head_txid: 7,
					db_size_pages: 11,
					post_apply_checksum: 13,
					branch_id: checkpoint_branch_id,
				})?,
			);
			Ok(())
		})
		.await?;
	let app = rivet_api_peer::create_router(config, pools).await?;
	let server = TestServer::new(app)?;

	let res = server.get("/depot/inspect/summary").await;
	res.assert_status_ok();

	let key = BASE64_URL_SAFE_NO_PAD.encode([depot::keys::SQLITE_SUBSPACE_PREFIX]);
	let res = server
		.get(&format!("/depot/inspect/raw/decode-key/{key}"))
		.await;
	res.assert_status_ok();

	let branch_id = uuid::Uuid::nil();
	let bucket_id = uuid::Uuid::nil();
	let database_id = "missing-bottomless-test";
	let res = server
		.get(&format!(
			"/depot/inspect/buckets/{bucket_id}/databases/{database_id}/bottomless-state"
		))
		.await;
	res.assert_status_ok();
	let body: serde_json::Value = res.json();
	assert_eq!(body["found"], false);

	let policy_path = format!(
		"/depot/qualification/buckets/{bucket_id}/databases/{database_id}/shard-cache-policy"
	);
	let res = server
		.put(&policy_path)
		.json(&serde_json::json!({ "retention_ms": 1 }))
		.await;
	res.assert_status_ok();
	let res = server.delete(&policy_path).await;
	res.assert_status_ok();

	// Actor SQLite uses the namespace Gas ID as its Depot bucket. Qualification
	// and inspection routes must accept that public ID in addition to raw UUIDs.
	let gas_bucket_id = rivet_util::Id::new_v1(0).to_string();
	let gas_policy_path = format!(
		"/depot/qualification/buckets/{gas_bucket_id}/databases/{database_id}/shard-cache-policy"
	);
	let res = server
		.put(&gas_policy_path)
		.json(&serde_json::json!({ "retention_ms": 1 }))
		.await;
	res.assert_status_ok();
	let res = server.delete(&gas_policy_path).await;
	res.assert_status_ok();

	#[cfg(feature = "test-faults")]
	{
		let grace_path = format!(
			"/depot/qualification/branches/{}/cold-delete-grace",
			checkpoint_branch_id.as_uuid()
		);
		let res = server
			.put(&grace_path)
			.json(&serde_json::json!({ "grace_ms": 0 }))
			.await;
		res.assert_status_ok();
		let body: serde_json::Value = res.json();
		assert_eq!(body["grace_ms"], 0);

		let res = server
			.put(&grace_path)
			.json(&serde_json::json!({ "grace_ms": 60001 }))
			.await;
		res.assert_status_internal_server_error();

		let res = server.delete(&grace_path).await;
		res.assert_status_ok();
	}

	let checkpoint_path =
		format!("/depot/checkpoints/buckets/{bucket_id}/databases/bottomless-test");
	let res = server
		.post(&checkpoint_path)
		.json(&serde_json::json!({ "force_reclaim": true }))
		.await;
	res.assert_status_ok();
	let checkpoint: serde_json::Value = res.json();
	assert_eq!(checkpoint["checkpoint_contract_version"], 2);
	assert_eq!(
		checkpoint["branch_id"],
		checkpoint_branch_id.as_uuid().to_string()
	);
	assert_eq!(checkpoint["target_head_txid"], 7);
	assert_eq!(checkpoint["target_db_size_pages"], 11);
	assert_eq!(checkpoint["target_post_apply_checksum"], 13);
	assert_eq!(checkpoint["service_interrupted"], false);
	assert_eq!(checkpoint["force_reclaim_accepted"], true);
	assert!(checkpoint["request_id"].as_str().is_some());

	let res = server
		.get(&format!("/depot/inspect/branches/{branch_id}/rows/commits"))
		.add_query_param("limit", "1")
		.await;
	res.assert_status_ok();

	for scope in ["application", "depot", "gasoline"] {
		let res = server
			.get("/depot/inspect/footprint")
			.add_query_param("scope", scope)
			.add_query_param("limit", "1")
			.await;
		res.assert_status_ok();
		let body: serde_json::Value = res.json();
		assert_eq!(body["scope"], scope);
		assert!(body["page_sha256"].as_str().is_some());
	}

	for scope in [
		"depot-dirty",
		"depot-compaction",
		"depot-hot-jobs",
		"depot-cold-publish",
		"depot-branch-gc",
		"depot-cold-gc",
	] {
		let res = server
			.get("/depot/inspect/footprint")
			.add_query_param("scope", scope)
			.add_query_param("limit", "1")
			.await;
		res.assert_status_ok();
	}

	for scope in ["branch-gc", "cold-gc"] {
		let res = server
			.get("/depot/inspect/due-queue")
			.add_query_param("scope", scope)
			.add_query_param("limit", "1")
			.await;
		res.assert_status_ok();
	}

	let res = server
		.get("/depot/inspect/footprint")
		.add_query_param("scope", "not-a-keyspace")
		.await;
	res.assert_status_internal_server_error();

	Ok(())
}
