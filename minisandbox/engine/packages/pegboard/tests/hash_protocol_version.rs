mod common;

use anyhow::Result;
use gas::prelude::*;

#[tokio::test]
async fn worker_actor_skips_legacy_and_missing_protocol_envoys() -> Result<()> {
	let test_deps = common::setup_deps().await?;
	let namespace_id = Id::new_v1(test_deps.config().dc_label());
	let pool_name = common::unique_pool_name("hash-protocol-version");

	for (key, position) in [
		("envoy-v6", 0x10),
		("envoy-missing", 0x20),
		("envoy-v7", 0x30),
	] {
		common::write_hash_envoy(
			&test_deps,
			namespace_id,
			&pool_name,
			key,
			common::fresh_ping_ts(),
			vec![common::hash_pos(position)],
			Some(0),
		)
		.await?;
	}
	common::write_envoy_protocol_version(&test_deps, namespace_id, "envoy-v6", 6).await?;
	common::write_envoy_protocol_version(&test_deps, namespace_id, "envoy-v7", 7).await?;

	let allocation = common::allocate_hash_with_min_protocol(
		&test_deps,
		namespace_id,
		&pool_name,
		7,
		common::hash_pos(0x10),
	)
	.await?;
	assert_eq!(allocation.as_deref(), Some("envoy-v7"));

	Ok(())
}
