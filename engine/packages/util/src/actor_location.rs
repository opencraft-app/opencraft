use crate::Id;

/// The resolved routing location for an Actor ID.
///
/// `home_dc_label` is encoded in the stable Actor ID. `current_dc_label` is kept separate so
/// callers do not assume that an Actor must always execute in its home datacenter. The initial
/// resolver preserves the existing behavior; a future route snapshot can change the current
/// location without changing callers or the Actor ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedActorLocation {
	pub home_dc_label: u16,
	pub current_dc_label: u16,
	pub route_epoch: u64,
}

/// Process-scoped Actor location resolver.
///
/// Resolution is deliberately synchronous: request routing must use an in-memory snapshot rather
/// than add a remote lookup to the hot path. This first implementation is a no-op abstraction over
/// the V1 Actor ID label.
#[derive(Debug, Clone, Default)]
pub struct ActorLocationResolver;

impl ActorLocationResolver {
	pub fn new() -> Self {
		Self
	}

	pub fn resolve_actor_location(&self, actor_id: Id) -> ResolvedActorLocation {
		let home_dc_label = actor_id.label();

		ResolvedActorLocation {
			home_dc_label,
			current_dc_label: home_dc_label,
			route_epoch: 0,
		}
	}
}

#[cfg(test)]
mod tests {
	use uuid::Uuid;

	use super::*;

	#[test]
	fn v1_actor_resolves_to_its_home_datacenter() {
		let actor_id = Id::v1(Uuid::from_u128(0x12345678_90ab_cdef_1234_567890abcdef), 42);

		assert_eq!(
			ActorLocationResolver::new().resolve_actor_location(actor_id),
			ResolvedActorLocation {
				home_dc_label: 42,
				current_dc_label: 42,
				route_epoch: 0,
			}
		);
	}
}
