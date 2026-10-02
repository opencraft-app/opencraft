mod common;

use anyhow::Result;
use gas::prelude::*;

#[tokio::test]
async fn capacity_aware_hash_allocator_packs_the_fullest_safe_envoy() -> Result<()> {
	let test_deps = common::setup_deps().await?;
	let namespace_id = Id::new_v1(test_deps.config().dc_label());
	let pool_name = common::unique_pool_name("hash-k2-binpack");

	for (envoy_key, position, slots) in [("busy-envoy", 0x10, 5), ("quiet-envoy", 0x20, 2)] {
		common::write_hash_envoy(
			&test_deps,
			namespace_id,
			&pool_name,
			envoy_key,
			common::fresh_ping_ts(),
			vec![common::hash_pos(position)],
			Some(slots),
		)
		.await?;
		common::write_actor_capacity(&test_deps, namespace_id, envoy_key, 8).await?;
	}

	let (allocation, read_stats) = common::allocate_hash(
		&test_deps,
		namespace_id,
		&pool_name,
		2,
		8,
		vec![common::hash_pos(0x10), common::hash_pos(0x20)],
		0,
	)
	.await?;

	assert_eq!(allocation.as_deref(), Some("busy-envoy"));
	assert_eq!(read_stats.slots_reads, 2);
	assert_eq!(read_stats.capacity_reads, 2);
	Ok(())
}

#[tokio::test]
async fn capacity_aware_hash_allocator_excludes_full_envoys() -> Result<()> {
	let test_deps = common::setup_deps().await?;
	let namespace_id = Id::new_v1(test_deps.config().dc_label());
	let pool_name = common::unique_pool_name("hash-k2-capacity");

	for (envoy_key, position, slots, capacity) in
		[("full-envoy", 0x10, 5, 5), ("available-envoy", 0x20, 2, 5)]
	{
		common::write_hash_envoy(
			&test_deps,
			namespace_id,
			&pool_name,
			envoy_key,
			common::fresh_ping_ts(),
			vec![common::hash_pos(position)],
			Some(slots),
		)
		.await?;
		common::write_actor_capacity(&test_deps, namespace_id, envoy_key, capacity).await?;
	}

	let (allocation, _) = common::allocate_hash(
		&test_deps,
		namespace_id,
		&pool_name,
		2,
		8,
		vec![common::hash_pos(0x10), common::hash_pos(0x20)],
		0,
	)
	.await?;

	assert_eq!(allocation.as_deref(), Some("available-envoy"));
	Ok(())
}

#[tokio::test]
async fn capacity_aware_hash_allocator_reports_no_capacity_when_sample_is_full() -> Result<()> {
	let test_deps = common::setup_deps().await?;
	let namespace_id = Id::new_v1(test_deps.config().dc_label());
	let pool_name = common::unique_pool_name("hash-k2-full");

	for (envoy_key, position) in [("full-a", 0x10), ("full-b", 0x20)] {
		common::write_hash_envoy(
			&test_deps,
			namespace_id,
			&pool_name,
			envoy_key,
			common::fresh_ping_ts(),
			vec![common::hash_pos(position)],
			Some(3),
		)
		.await?;
		common::write_actor_capacity(&test_deps, namespace_id, envoy_key, 3).await?;
	}

	let (allocation, _) = common::allocate_hash(
		&test_deps,
		namespace_id,
		&pool_name,
		2,
		8,
		vec![common::hash_pos(0x10), common::hash_pos(0x20)],
		0,
	)
	.await?;

	assert_eq!(allocation, None);
	Ok(())
}
