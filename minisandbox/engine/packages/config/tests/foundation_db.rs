use std::path::PathBuf;

use rivet_config::config::{Database, Root};

#[test]
fn parses_flattened_foundation_db_config() {
	let root: Root = serde_json::from_value(serde_json::json!({
		"runtime": { "gasoline_cell_namespace": "actor-bj-a01" },
		"foundation_db": {
			"cluster_file": "/etc/foundationdb/rivet.cluster",
			"transaction_retry_limit": 23,
			"allow_shared_cluster": true
		}
	}))
	.expect("config should parse");
	assert_eq!(root.gasoline_cell_namespace(), "actor-bj-a01");

	let Some(Database::FoundationDb(config)) = root.database else {
		panic!("expected FoundationDB database config");
	};
	assert_eq!(
		config.cluster_file,
		Some(PathBuf::from("/etc/foundationdb/rivet.cluster"))
	);
	assert_eq!(config.transaction_retry_limit, 23);
	assert!(config.allow_shared_cluster);
}

#[test]
fn applies_foundation_db_defaults() {
	let root: Root = serde_json::from_value(serde_json::json!({
		"runtime": { "gasoline_cell_namespace": "test-a01" },
		"foundation_db": {}
	}))
	.expect("config should parse");
	assert_eq!(root.gasoline_cell_namespace(), "test-a01");

	let Some(Database::FoundationDb(config)) = root.database else {
		panic!("expected FoundationDB database config");
	};
	assert_eq!(config.cluster_file, None);
	assert_eq!(config.transaction_retry_limit, 10);
	assert!(!config.allow_shared_cluster);
}

#[test]
fn rejects_non_positive_retry_limit() {
	let mut root: Root = serde_json::from_value(serde_json::json!({
		"runtime": { "gasoline_cell_namespace": "test-a01" },
		"foundation_db": {
			"transaction_retry_limit": 0
		}
	}))
	.expect("config should parse before validation");

	let error = root
		.validate_and_set_defaults()
		.expect_err("zero retries must be rejected");
	assert!(
		error
			.to_string()
			.contains("foundation_db.transaction_retry_limit must be positive")
	);
}

#[test]
fn requires_explicit_foundation_db_cell_namespace() {
	let mut root = serde_json::from_value::<Root>(serde_json::json!({
		"runtime": {},
		"foundation_db": {}
	}))
	.expect("config should parse before semantic validation");
	let error = root
		.validate_and_set_defaults()
		.expect_err("shared FDB deployments must declare their Gasoline Cell boundary");
	assert!(error.to_string().contains("cell_namespace"));
}

#[test]
fn rejects_unsafe_foundation_db_cell_namespace() {
	let mut root: Root = serde_json::from_value(serde_json::json!({
		"runtime": { "gasoline_cell_namespace": "Beijing.bad" },
		"foundation_db": {}
	}))
	.expect("config should parse before validation");
	let error = root
		.validate_and_set_defaults()
		.expect_err("unsafe namespace must be rejected");
	assert!(
		error
			.to_string()
			.contains("runtime.gasoline_cell_namespace")
	);
}

#[test]
fn rejects_cell_namespace_that_cannot_be_an_exact_fdb_tag() {
	let mut root: Root = serde_json::from_value(serde_json::json!({
		"runtime": { "gasoline_cell_namespace": "actor-beijing-a01" },
		"foundation_db": {}
	}))
	.expect("config should parse before validation");
	let error = root
		.validate_and_set_defaults()
		.expect_err("Cell namespace must fit FDB's transaction-tag limit without hashing");
	assert!(error.to_string().contains("1-16"));
}
