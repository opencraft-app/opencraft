#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Candidate {
	pub envoy_key: String,
	pub slots: i64,
	pub capacity: Option<i64>,
	pub jitter: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Mode {
	/// Legacy behavior: spread actors by selecting the least-loaded candidate.
	Spread,
	/// Capacity contract: pack actors onto the fullest candidate below its ceiling.
	Binpack,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Preference {
	/// Preserve the configured spread/bin-pack policy on an uncontended attempt.
	LoadAware,
	/// After a real FDB conflict, stop herding contenders back to the same
	/// best-fit key. Capacity eligibility is unchanged; the caller randomly
	/// chooses one of all eligible sampled Envoys.
	UniformEligible,
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct Finalists {
	pub mode: Mode,
	pub candidates: Vec<(String, i64)>,
}

/// Reduces sampled Envoys to the equally best placement candidates.
///
/// Sampling, persistence, and random tie-breaking intentionally stay outside
/// this function. The placement contract is therefore runtime-agnostic and
/// can be exhaustively verified without FDB.
#[cfg(test)]
pub(super) fn finalists(candidates: Vec<Candidate>) -> Finalists {
	finalists_with_preference(candidates, Preference::LoadAware)
}

pub(super) fn finalists_with_preference(
	candidates: Vec<Candidate>,
	preference: Preference,
) -> Finalists {
	let mode = if candidates
		.iter()
		.any(|candidate| candidate.capacity.is_some())
	{
		Mode::Binpack
	} else {
		Mode::Spread
	};

	let eligible = candidates
		.into_iter()
		.filter(|candidate| match mode {
			Mode::Spread => true,
			// A mixed sample is capacity-aware. Excluding legacy candidates
			// prevents a rolling upgrade from routing around a hard ceiling.
			Mode::Binpack => candidate
				.capacity
				.is_some_and(|capacity| candidate.slots < capacity),
		})
		.collect::<Vec<_>>();

	if preference == Preference::UniformEligible {
		return Finalists {
			mode,
			candidates: eligible
				.into_iter()
				.map(|candidate| (candidate.envoy_key, candidate.slots))
				.collect(),
		};
	}

	let scored = eligible
		.into_iter()
		.map(|candidate| {
			let score = match mode {
				Mode::Spread => candidate.slots.saturating_add(candidate.jitter),
				// Best fit minimizes remaining capacity. This stays correct when
				// sampled runtimes advertise different ceilings.
				Mode::Binpack => candidate
					.capacity
					.unwrap_or_default()
					.saturating_sub(candidate.slots)
					.saturating_add(candidate.jitter),
			};
			(candidate.envoy_key, candidate.slots, score)
		})
		.collect::<Vec<_>>();

	let target = scored.iter().map(|(_, _, score)| *score).min();
	let candidates = target.map_or_else(Vec::new, |target| {
		scored
			.into_iter()
			.filter(|(_, _, score)| *score == target)
			.map(|(envoy_key, slots, _)| (envoy_key, slots))
			.collect()
	});

	Finalists { mode, candidates }
}

#[cfg(test)]
mod tests {
	use super::{Candidate, Mode, Preference, finalists, finalists_with_preference};

	fn candidate(key: &str, slots: i64, capacity: Option<i64>, jitter: i64) -> Candidate {
		Candidate {
			envoy_key: key.to_string(),
			slots,
			capacity,
			jitter,
		}
	}

	#[test]
	fn legacy_candidates_spread_to_the_least_loaded() {
		let result = finalists(vec![
			candidate("busy", 7, None, 0),
			candidate("quiet", 2, None, 0),
		]);
		assert_eq!(result.mode, Mode::Spread);
		assert_eq!(result.candidates, vec![("quiet".into(), 2)]);
	}

	#[test]
	fn capacity_candidates_pack_to_the_fullest_safe_host() {
		let result = finalists(vec![
			candidate("busy", 7, Some(8), 0),
			candidate("quiet", 2, Some(8), 0),
		]);
		assert_eq!(result.mode, Mode::Binpack);
		assert_eq!(result.candidates, vec![("busy".into(), 7)]);
	}

	#[test]
	fn capacity_candidates_use_remaining_space_across_different_ceilings() {
		let result = finalists(vec![
			candidate("small", 7, Some(8), 0),
			candidate("large", 50, Some(64), 0),
		]);
		assert_eq!(result.mode, Mode::Binpack);
		assert_eq!(result.candidates, vec![("small".into(), 7)]);
	}

	#[test]
	fn full_and_legacy_candidates_are_never_selected_in_capacity_mode() {
		let result = finalists(vec![
			candidate("draining", 0, Some(0), 0),
			candidate("full", 8, Some(8), 0),
			candidate("safe", 3, Some(8), 0),
			candidate("legacy", 0, None, 100),
		]);
		assert_eq!(result.mode, Mode::Binpack);
		assert_eq!(result.candidates, vec![("safe".into(), 3)]);
	}

	#[test]
	fn conflict_fallback_returns_every_eligible_capacity_candidate() {
		let result = finalists_with_preference(
			vec![
				candidate("almost-full", 7, Some(8), 0),
				candidate("quiet", 1, Some(8), 0),
				candidate("full", 8, Some(8), 0),
				candidate("legacy", 0, None, 0),
			],
			Preference::UniformEligible,
		);
		assert_eq!(result.mode, Mode::Binpack);
		assert_eq!(
			result.candidates,
			vec![("almost-full".into(), 7), ("quiet".into(), 1)]
		);
	}

	#[test]
	fn exhaustive_small_capacity_space_never_returns_a_full_host() {
		for left_capacity in 1..=4 {
			for right_capacity in 1..=4 {
				for left_slots in 0..=5 {
					for right_slots in 0..=5 {
						let result = finalists(vec![
							candidate("left", left_slots, Some(left_capacity), 0),
							candidate("right", right_slots, Some(right_capacity), 0),
						]);
						assert_eq!(result.mode, Mode::Binpack);
						for (key, slots) in result.candidates {
							let capacity = if key == "left" {
								left_capacity
							} else {
								right_capacity
							};
							assert!(slots < capacity);
						}
					}
				}
			}
		}
	}
}
