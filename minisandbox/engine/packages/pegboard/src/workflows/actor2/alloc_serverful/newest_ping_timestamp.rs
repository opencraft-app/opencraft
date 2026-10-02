use futures_util::TryStreamExt;
use gas::prelude::*;
use universaldb::prelude::*;

use super::{protocol_eligible, read_isolation};
use crate::{envoy_expire_scheduler, keys};

pub(super) async fn allocate(
	namespace_id: Id,
	pool_name: &str,
	tx: &universaldb::Transaction,
	pools: &rivet_pools::PoolsHandle,
	now: i64,
	envoy_eligible_threshold: i64,
	use_snapshot_read: bool,
	minimum_protocol_version: Option<u16>,
) -> Result<Option<String>> {
	let ping_threshold_ts = now - envoy_eligible_threshold;
	let read_isolation = read_isolation(use_snapshot_read);

	let head_subspace = keys::subspace().subspace(&keys::ns::EnvoyLoadBalancerIdxKey::subspace(
		namespace_id,
		pool_name.to_string(),
	));
	let mut head_stream = tx.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Iterator,
			..(&head_subspace).into()
		},
		read_isolation,
	);

	let Some(entry) = head_stream.try_next().await? else {
		return Ok(None);
	};
	let (head_key, _) = tx.read_entry::<keys::ns::EnvoyLoadBalancerIdxKey>(&entry)?;

	let version_subspace =
		keys::subspace().subspace(&keys::ns::EnvoyLoadBalancerIdxKey::subspace_with_version(
			namespace_id,
			pool_name.to_string(),
			head_key.version,
		));
	let mut newest_stream = tx.get_ranges_keyvalues(
		(RangeOption {
			mode: StreamingMode::Iterator,
			..(&version_subspace).into()
		})
		.rev(),
		read_isolation,
	);

	while let Some(entry) = newest_stream.try_next().await? {
		let (lb_key, _) = tx.read_entry::<keys::ns::EnvoyLoadBalancerIdxKey>(&entry)?;
		if lb_key.last_ping_ts < ping_threshold_ts {
			envoy_expire_scheduler::get(pools).try_enqueue(namespace_id, lb_key.envoy_key.clone());
			continue;
		}
		if protocol_eligible(
			tx,
			namespace_id,
			&lb_key.envoy_key,
			minimum_protocol_version,
			read_isolation,
		)
		.await?
		{
			return Ok(Some(lb_key.envoy_key));
		}
	}
	Ok(None)
}
