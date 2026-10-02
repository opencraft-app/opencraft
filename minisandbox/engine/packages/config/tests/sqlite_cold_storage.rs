use rivet_config::config::{
	Root, SqliteWorkflowColdStorage, SqliteWorkflowColdStorageS3AddressingStyle,
};

#[test]
fn parses_cos_compatible_s3_config() {
	let mut root: Root = serde_json::from_value(serde_json::json!({
		"sqlite": {
			"unstable_disable_compaction": false,
			"workflow_write_debt": {
				"target_bytes": 262144,
				"limit_bytes": 2359296
			},
			"workflow_cold_storage": {
				"s3": {
					"bucket": "rivet-1250000000",
					"endpoint": "https://cos.ap-beijing.myqcloud.com",
					"region": "ap-beijing",
					"addressing_style": "virtual_hosted",
					"max_object_size_bytes": 8388608,
					"max_concurrent_requests": 32,
					"max_queued_requests": 96,
					"queue_timeout_ms": 20000
				}
			}
		}
	}))
	.expect("COS-compatible config should parse");
	root.validate_and_set_defaults()
		.expect("COS-compatible config should validate");

	let Some(SqliteWorkflowColdStorage::S3(config)) = root.sqlite().workflow_cold_storage() else {
		panic!("expected S3 cold storage config");
	};
	assert_eq!(config.region, "ap-beijing");
	assert_eq!(
		config.addressing_style,
		SqliteWorkflowColdStorageS3AddressingStyle::VirtualHosted
	);
	assert_eq!(config.max_object_size_bytes, 8 * 1024 * 1024);
	assert_eq!(config.max_concurrent_requests, 32);
	assert_eq!(config.max_queued_requests, 96);
	assert_eq!(config.queue_timeout_ms, 20_000);
	assert_eq!(root.sqlite().workflow_write_debt().target_bytes, 256 * 1024);
	assert_eq!(
		root.sqlite().workflow_write_debt().limit_bytes,
		256 * 1024 + 2 * 1024 * 1024
	);
	assert_eq!(config.recovery_window_ms, 7 * 24 * 60 * 60 * 1000);
}

#[test]
fn s3_root_prefix_is_rejected_so_hash_fanout_stays_first() {
	let error = serde_json::from_value::<Root>(serde_json::json!({
		"sqlite": {
			"workflow_cold_storage": {
				"s3": {
					"bucket": "actor-depot-cold-prod-bj-a01-1250000000",
					"prefix": "actors/cold"
				}
			}
		}
	}))
	.expect_err("a common root prefix would defeat hash-first COS distribution");
	assert!(error.to_string().contains("unknown field `prefix`"));
}

#[test]
fn applies_bounded_cold_storage_defaults() {
	let root: Root = serde_json::from_value(serde_json::json!({
		"sqlite": {
			"unstable_disable_compaction": false,
			"workflow_cold_storage": {
				"s3": { "bucket": "minio", "addressing_style": "path" }
			}
		}
	}))
	.expect("cold storage config should parse");

	let Some(SqliteWorkflowColdStorage::S3(config)) = root.sqlite().workflow_cold_storage() else {
		panic!("expected S3 cold storage config");
	};
	assert_eq!(config.region, "us-east-1");
	assert_eq!(
		config.addressing_style,
		SqliteWorkflowColdStorageS3AddressingStyle::Path
	);
	assert_eq!(config.max_object_size_bytes, 4 * 1024 * 1024);
	assert_eq!(config.max_concurrent_requests, 16);
	assert_eq!(config.max_queued_requests, 64);
	assert_eq!(config.queue_timeout_ms, 15_000);
	assert_eq!(
		root.sqlite().workflow_write_debt().target_bytes,
		10 * 1024 * 1024
	);
	assert_eq!(
		root.sqlite().workflow_write_debt().limit_bytes,
		12 * 1024 * 1024
	);
}

#[test]
fn write_debt_e2e_override_retains_commit_headroom() {
	for (target_bytes, limit_bytes, expected) in [
		(32 * 1024, 3 * 1024 * 1024, "target_bytes must be at least"),
		(256 * 1024, 2 * 1024 * 1024, "must leave at least"),
	] {
		let mut root: Root = serde_json::from_value(serde_json::json!({
			"sqlite": {
				"unstable_disable_compaction": false,
				"workflow_write_debt": {
					"target_bytes": target_bytes,
					"limit_bytes": limit_bytes
				},
				"workflow_cold_storage": {
					"file_system": { "root": "/cold" }
				}
			}
		}))
		.expect("write-debt policy should parse before semantic validation");
		assert!(
			root.validate_and_set_defaults()
				.expect_err("unsafe write-debt policy must fail")
				.to_string()
				.contains(expected)
		);
	}
}

#[test]
fn destructive_cold_object_deletion_is_not_a_process_config_option() {
	let error = serde_json::from_value::<Root>(serde_json::json!({
		"sqlite": {
			"unstable_disable_compaction": false,
			"workflow_cold_storage": {
				"s3": {
					"bucket": "production-cold",
					"retired_object_deletion_enabled": true
				}
			}
		}
	}))
	.expect_err("destructive deletion must only be authorized by FDB ColdGcPolicy");
	assert!(
		error
			.to_string()
			.contains("unknown field `retired_object_deletion_enabled`")
	);
}

#[test]
fn backup_fence_controller_requires_fdb_and_validates_destructive_bounds() {
	let mut root: Root = serde_json::from_value(serde_json::json!({
		"runtime": { "gasoline_cell_namespace": "test-a01" },
		"foundation_db": { "cluster_file": "/etc/foundationdb/fdb.cluster" },
		"sqlite": {
			"unstable_disable_compaction": false,
			"workflow_cold_storage": {
				"s3": {
					"bucket": "production-cold"
				}
			},
			"backup_recovery_fence_controller": {
				"backup_base_urls": ["blobstore://@actor-fdb-backup.cos.ap-beijing.myqcloud.com?bucket=actor-fdb-backup&region=ap-beijing"],
				"retention_days": 7,
				"blob_credentials": ["/run/secrets/fdb-blob-credentials.json"],
				"tls_ca_file": "/run/secrets/backup-ca.pem"
			}
		}
	}))
	.expect("automatic backup controller config should parse");
	root.validate_and_set_defaults()
		.expect("bounded automatic backup controller config should validate");

	let controller = root
		.sqlite()
		.backup_recovery_fence_controller()
		.expect("controller config");
	assert_eq!(controller.required_fdbbackup_version, "7.3.79");
	assert_eq!(controller.lease_validity_ms, 10 * 60 * 1_000);
	assert_eq!(controller.leadership_lease_ms, 5 * 60 * 1_000);
	assert_eq!(
		controller.tls_ca_file.as_deref(),
		Some("/run/secrets/backup-ca.pem")
	);
}

#[test]
fn backup_fence_controller_can_run_before_cold_storage_is_enabled() {
	let mut root: Root = serde_json::from_value(serde_json::json!({
		"runtime": { "gasoline_cell_namespace": "test-a01" },
		"foundation_db": { "cluster_file": "/etc/foundationdb/fdb.cluster" },
		"sqlite": {
			"backup_recovery_fence_controller": {
				"backup_base_urls": ["file:///backup/prod"],
				"retention_days": 7
			}
		}
	}))
	.expect("standalone backup controller config should parse");
	root.validate_and_set_defaults()
		.expect("backup retention and fence certification can precede cold-tier activation");
}

#[test]
fn backup_fence_controller_rejects_empty_tls_ca_path() {
	let mut root: Root = serde_json::from_value(serde_json::json!({
		"runtime": { "gasoline_cell_namespace": "test-a01" },
		"foundation_db": {},
		"sqlite": {
			"unstable_disable_compaction": false,
			"workflow_cold_storage": {
				"file_system": { "root": "/cold" }
			},
			"backup_recovery_fence_controller": {
				"backup_base_urls": ["file:///backup/prod"],
				"retention_days": 7,
				"tls_ca_file": "   "
			}
		}
	}))
	.expect("controller config should parse before semantic validation");
	assert!(
		root.validate_and_set_defaults()
			.expect_err("empty CA path must fail validation")
			.to_string()
			.contains("tls_ca_file must not be empty")
	);
}

#[test]
fn backup_fence_controller_rejects_embedded_secret_and_unsafe_lease() {
	for (url, lease_validity_ms, expected) in [
		(
			"blobstore://key:secret@cos.ap-beijing.myqcloud.com/prod?bucket=backup",
			600_000,
			"must not embed secrets",
		),
		(
			"file:///backup/prod",
			60_000,
			"must cover at least two poll plus command-timeout intervals",
		),
		(
			"blobstore://@backup.cos.ap-beijing.myqcloud.com/actor/prod?bucket=backup",
			600_000,
			"must not contain a backup generation path",
		),
	] {
		let mut root: Root = serde_json::from_value(serde_json::json!({
			"runtime": { "gasoline_cell_namespace": "test-a01" },
			"foundation_db": {},
			"sqlite": {
				"unstable_disable_compaction": false,
				"workflow_cold_storage": {
					"file_system": { "root": "/cold" }
				},
				"backup_recovery_fence_controller": {
					"backup_base_urls": [url],
					"retention_days": 7,
					"lease_validity_ms": lease_validity_ms
				}
			}
		}))
		.expect("controller config should parse before semantic validation");
		assert!(
			root.validate_and_set_defaults()
				.expect_err("unsafe controller config must fail closed")
				.to_string()
				.contains(expected)
		);
	}
}

#[test]
fn cold_storage_requires_enabled_compaction_and_positive_bounds() {
	let mut disabled: Root = serde_json::from_value(serde_json::json!({
		"sqlite": {
			"workflow_cold_storage": {
				"file_system": { "root": "/tmp/rivet-cold" }
			}
		}
	}))
	.expect("config should parse before validation");
	assert!(
		disabled
			.validate_and_set_defaults()
			.expect_err("cold storage with disabled compaction must fail")
			.to_string()
			.contains("unstable_disable_compaction=false")
	);

	let mut unbounded: Root = serde_json::from_value(serde_json::json!({
		"sqlite": {
			"unstable_disable_compaction": false,
			"workflow_cold_storage": {
				"s3": {
					"bucket": "test",
					"max_object_size_bytes": 0
				}
			}
		}
	}))
	.expect("config should parse before validation");
	assert!(
		unbounded
			.validate_and_set_defaults()
			.expect_err("zero object bound must fail")
			.to_string()
			.contains("max_object_size_bytes must be positive")
	);
}

#[test]
fn cold_storage_rejects_a_recovery_window_too_short_for_safe_exact_delete() {
	let mut root: Root = serde_json::from_value(serde_json::json!({
		"sqlite": {
			"unstable_disable_compaction": false,
			"workflow_cold_storage": {
				"s3": {
					"bucket": "production-cold",
					"recovery_window_ms": 23 * 60 * 60 * 1000
				}
			}
		}
	}))
	.expect("bounded recovery config should parse before validation");
	assert!(
		root.validate_and_set_defaults()
			.expect_err("a sub-day recovery window must fail closed")
			.to_string()
			.contains("recovery_window_ms must be between")
	);
}

#[test]
fn removed_large_commit_bypass_is_rejected() {
	let error = serde_json::from_value::<Root>(serde_json::json!({
		"sqlite": { "unstable_disable_commit_size_cap": true }
	}))
	.expect_err("removed large-commit bypass must be rejected while parsing");
	assert!(
		error
			.to_string()
			.contains("unknown field `unstable_disable_commit_size_cap`")
	);
}
