use rivet_config::config::Root;

fn runtime_config(batch_size: Option<usize>, secondary_grace_ms: Option<u64>) -> Root {
	let mut runtime = serde_json::Map::new();
	if let Some(batch_size) = batch_size {
		runtime.insert("gasoline_worker_pull_batch_size".into(), batch_size.into());
	}
	if let Some(secondary_grace_ms) = secondary_grace_ms {
		runtime.insert(
			"gasoline_worker_secondary_grace_ms".into(),
			secondary_grace_ms.into(),
		);
	}
	serde_json::from_value(serde_json::json!({ "runtime": runtime }))
		.expect("runtime config should deserialize")
}

#[test]
fn gasoline_pull_batch_defaults_to_bounded_value() {
	let root = runtime_config(None, None);
	assert_eq!(root.runtime.gasoline_worker_pull_batch_size(), 256);
	assert_eq!(root.runtime.gasoline_worker_max_active_workflows(), 256);
	assert_eq!(root.runtime.depot_manager_refresh_max_concurrency(), 16);
	assert_eq!(root.runtime.depot_compaction_max_concurrency(), 8);
	assert_eq!(
		root.runtime.gasoline_worker_secondary_grace().as_millis(),
		1_000
	);
}

#[test]
fn depot_activity_admission_is_independently_bounded() {
	let mut root: Root = serde_json::from_value(serde_json::json!({
		"runtime": {
			"depot_manager_refresh_max_concurrency": 384,
			"depot_compaction_max_concurrency": 48
		}
	}))
	.expect("Depot admission config should deserialize");
	root.validate_and_set_defaults()
		.expect("Depot admission config should validate");
	assert_eq!(root.runtime.depot_manager_refresh_max_concurrency(), 384);
	assert_eq!(root.runtime.depot_compaction_max_concurrency(), 48);

	for key in [
		"depot_manager_refresh_max_concurrency",
		"depot_compaction_max_concurrency",
	] {
		for invalid in [0, 4097] {
			let mut root: Root = serde_json::from_value(serde_json::json!({
				"runtime": { key: invalid }
			}))
			.expect("invalid Depot admission config should deserialize");
			let error = root
				.validate_and_set_defaults()
				.expect_err("invalid limit must fail");
			assert!(error.to_string().contains(key));
		}
	}
}

#[test]
fn gasoline_max_active_workflows_is_independent_and_validated() {
	let mut root: Root = serde_json::from_value(serde_json::json!({
		"runtime": {
			"gasoline_worker_pull_batch_size": 256,
			"gasoline_worker_max_active_workflows": 64
		}
	}))
	.expect("runtime config should deserialize");
	root.validate_and_set_defaults()
		.expect("bounded workflow concurrency should validate");
	assert_eq!(root.runtime.gasoline_worker_pull_batch_size(), 256);
	assert_eq!(root.runtime.gasoline_worker_max_active_workflows(), 64);

	for invalid in [0, 10_001] {
		let mut root: Root = serde_json::from_value(serde_json::json!({
			"runtime": { "gasoline_worker_max_active_workflows": invalid }
		}))
		.expect("runtime config should deserialize");
		let error = root
			.validate_and_set_defaults()
			.expect_err("invalid active workflow limit must fail validation");
		assert!(
			error
				.to_string()
				.contains("gasoline_worker_max_active_workflows")
		);
	}
}

#[test]
fn gasoline_reserved_lane_requires_a_bounded_sorted_name_set() {
	let mut root: Root = serde_json::from_value(serde_json::json!({
		"runtime": {
			"gasoline_worker_max_active_workflows": 64,
			"gasoline_worker_reserved_workflow_slots": 1,
			"gasoline_worker_reserved_workflow_names": ["gasoline_pruner"]
		}
	}))
	.expect("reserved workflow config should deserialize");
	root.validate_and_set_defaults()
		.expect("bounded reserved workflow lane should validate");
	assert_eq!(root.runtime.gasoline_worker_reserved_workflow_slots(), 1);
	assert_eq!(
		root.runtime.gasoline_worker_reserved_workflow_names(),
		["gasoline_pruner"]
	);

	for runtime in [
		serde_json::json!({
			"gasoline_worker_reserved_workflow_slots": 1,
			"gasoline_worker_reserved_workflow_names": []
		}),
		serde_json::json!({
			"gasoline_worker_reserved_workflow_slots": 0,
			"gasoline_worker_reserved_workflow_names": ["gasoline_pruner"]
		}),
		serde_json::json!({
			"gasoline_worker_reserved_workflow_slots": 65,
			"gasoline_worker_reserved_workflow_names": ["gasoline_pruner"]
		}),
		serde_json::json!({
			"gasoline_worker_reserved_workflow_slots": 1,
			"gasoline_worker_reserved_workflow_names": ["gasoline_pruner", "gasoline_pruner"]
		}),
	] {
		let mut root: Root = serde_json::from_value(serde_json::json!({ "runtime": runtime }))
			.expect("invalid reserved lane should still deserialize");
		root.validate_and_set_defaults()
			.expect_err("invalid reserved workflow lane must fail validation");
	}
}

#[test]
fn gasoline_pull_batch_accepts_explicit_value() {
	let root = runtime_config(Some(128), Some(750));
	assert_eq!(root.runtime.gasoline_worker_pull_batch_size(), 128);
	assert_eq!(
		root.runtime.gasoline_worker_secondary_grace().as_millis(),
		750
	);
}

#[test]
fn gasoline_pull_batch_rejects_zero_and_oversized_values() {
	for batch_size in [0, 1001] {
		let mut root = runtime_config(Some(batch_size), None);
		let error = root
			.validate_and_set_defaults()
			.expect_err("invalid pull batch must fail validation");
		assert!(
			error
				.to_string()
				.contains("gasoline_worker_pull_batch_size")
		);
	}
}

#[test]
fn gasoline_secondary_grace_rejects_oversized_value() {
	let mut root = runtime_config(None, Some(60_001));
	let error = root
		.validate_and_set_defaults()
		.expect_err("oversized secondary grace must fail validation");
	assert!(
		error
			.to_string()
			.contains("gasoline_worker_secondary_grace_ms")
	);
}

#[test]
fn gasoline_history_and_terminal_retention_have_safe_defaults() {
	let root = runtime_config(None, None);
	assert_eq!(
		root.runtime
			.gasoline_history_prune_eligibility_duration()
			.expect("history pruning should default on")
			.as_secs(),
		15 * 60
	);
	assert_eq!(
		root.runtime
			.gasoline_prune_eligibility_duration()
			.expect("terminal pruning should default on")
			.as_secs(),
		7 * 24 * 60 * 60
	);
}

#[test]
fn gasoline_history_retention_cannot_exceed_terminal_retention() {
	let mut root: Root = serde_json::from_value(serde_json::json!({
		"runtime": {
			"gasoline_history_prune_eligibility_duration": 61,
			"gasoline_prune_eligibility_duration": 60
		}
	}))
	.expect("runtime config should deserialize");
	let error = root
		.validate_and_set_defaults()
		.expect_err("history retention beyond terminal retention must fail");
	assert!(
		error
			.to_string()
			.contains("gasoline_history_prune_eligibility_duration")
	);
}

#[test]
fn gasoline_history_retention_can_be_disabled_independently() {
	let mut root: Root = serde_json::from_value(serde_json::json!({
		"runtime": {
			"gasoline_history_prune_eligibility_duration": 0,
			"gasoline_prune_eligibility_duration": 60
		}
	}))
	.expect("runtime config should deserialize");
	root.validate_and_set_defaults()
		.expect("disabled history pruning should be valid");
	assert!(
		root.runtime
			.gasoline_history_prune_eligibility_duration()
			.is_none()
	);
}
