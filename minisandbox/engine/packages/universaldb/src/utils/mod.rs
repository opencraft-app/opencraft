#[cfg(any(feature = "foundationdb", test))]
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
#[cfg(any(feature = "foundationdb", test))]
use sha2::{Digest, Sha256};

use crate::tuple::{PackError, PackResult};

mod cherry_pick;
pub mod codes;
mod ext;
mod formal_key;
pub mod keys;
mod subspace;

pub use cherry_pick::*;
pub use ext::*;
pub use formal_key::*;
pub use subspace::Subspace;

pub const CHUNK_SIZE: usize = 10_000; // 10 KB, not KiB, see https://apple.github.io/foundationdb/blob.html

#[derive(Debug, Clone, Copy)]
pub enum IsolationLevel {
	Serializable,
	Snapshot,
}

/// Indicates the transaction might have committed
#[derive(Debug, Clone, Copy)]
pub struct MaybeCommitted(pub bool);

/// FDB limits auto-throttle tags to 16 bytes and tracks them cluster-wide. UniversalDB callers
/// often append a workflow, worker, or namespace ID after `:`. Strip that high-cardinality suffix
/// before applying the byte limit, then hash only an overlong operation family. Transaction tags
/// are observability/throttling metadata, never correctness identifiers.
#[cfg(any(feature = "foundationdb", test))]
pub(crate) fn bounded_transaction_tag(tag: &str) -> String {
	let family = tag.split_once(':').map_or(tag, |(family, _)| family);
	if family.len() <= 16 {
		return family.to_owned();
	}

	let digest = Sha256::digest(family.as_bytes());
	URL_SAFE_NO_PAD.encode(&digest[..12])
}

impl std::ops::Deref for MaybeCommitted {
	type Target = bool;

	fn deref(&self) -> &Self::Target {
		&self.0
	}
}

pub fn error_is_transaction_too_large(err: &anyhow::Error) -> bool {
	if err.chain().any(|source| {
		matches!(
			source.downcast_ref::<crate::error::DatabaseError>(),
			Some(crate::error::DatabaseError::TransactionTooLarge { .. })
		)
	}) {
		return true;
	}

	#[cfg(feature = "foundationdb")]
	{
		const TRANSACTION_TOO_LARGE: i32 = 2101;
		return err
			.chain()
			.find_map(|source| source.downcast_ref::<foundationdb::FdbError>())
			.is_some_and(|error| error.code() == TRANSACTION_TOO_LARGE);
	}

	#[cfg(not(feature = "foundationdb"))]
	{
		let _ = err;
		false
	}
}

#[cfg(test)]
mod transaction_tag_tests {
	use super::bounded_transaction_tag;

	#[test]
	fn preserves_compatible_transaction_tags() {
		assert_eq!(bounded_transaction_tag("depot_commit"), "depot_commit");
		assert_eq!(bounded_transaction_tag("数据库"), "数据库");
		assert_eq!(bounded_transaction_tag("actor-bj-a01"), "actor-bj-a01");
	}

	#[test]
	fn collapses_high_cardinality_suffixes_to_one_operation_family() {
		assert_eq!(
			bounded_transaction_tag("pull_workflows:worker-a"),
			"pull_workflows"
		);
		assert_eq!(
			bounded_transaction_tag("pull_workflows:worker-b"),
			"pull_workflows"
		);
		assert_eq!(
			bounded_transaction_tag("dispatch_workflow:counter"),
			bounded_transaction_tag("dispatch_workflow:chat")
		);
	}

	#[test]
	fn hashes_long_operation_families_stably_to_fdb_limit() {
		let first = bounded_transaction_tag("gasoline_lease_workflows");
		let second = bounded_transaction_tag("gasoline_lease_workflows");
		let different = bounded_transaction_tag("gasoline_pull_workflows");

		assert_eq!(first.len(), 16);
		assert_eq!(first, second);
		assert_ne!(first, different);
	}
}

/// Calculate exponential backoff based on attempt.
///
/// Ours:
///   0 -> 10ms + 0-1ms jitter
///   1 -> 20ms + 0-2ms jitter
///   2 -> 40ms + 0-4ms jitter
///   ...
///   7 (max) -> 1280ms + 0-128ms jitter
/// FDB (see https://github.com/apple/foundationdb/blob/b1fbbd87a794b7c6c2f456925c45d8af339a8ae0/fdbclient/NativeAPI.actor.cpp#L4333 and https://github.com/apple/foundationdb/blob/b1fbbd87a794b7c6c2f456925c45d8af339a8ae0/fdbclient/ClientKnobs.cpp#L74-L76):
///   0 -> 10ms
///   1 -> 20ms
///   2 -> 40ms
///   ...
///   X -> max 1s
pub fn calculate_tx_retry_backoff(attempt: usize) -> u64 {
	let base = 2_u64.pow((attempt as u32).min(7));
	let base_backoff_ms = base * 10;

	// Jitter is 0-10% of backoff ms
	let jitter_ms = rand::random::<u64>() % base;

	base_backoff_ms + jitter_ms
}

/// When using `add_conflict_range` to add a conflict for a single key, you cannot set both the start and end
/// keys to the same key. Instead, the end key must be the start key + a 0 byte.
/// See Python bindings: https://github.com/apple/foundationdb/blob/ec714791df4a6e4dafb5a926130d5789ce0c497a/bindings/python/fdb/impl.py#L633-L635
pub fn end_of_key_range(key: &[u8]) -> Vec<u8> {
	let mut end_key = Vec::with_capacity(key.len() + 1);
	end_key.extend_from_slice(key);
	end_key.push(0);
	end_key
}

/// Returns the smallest key strictly greater than every key beginning with `prefix`.
///
/// This is intentionally different from [`end_of_key_range`], which only covers one exact key.
/// The prefix must contain at least one byte other than `0xff`, as is true for all application
/// subspaces built by UniversalDB.
pub fn end_of_prefix_range(prefix: &[u8]) -> Vec<u8> {
	assert!(!prefix.is_empty(), "a key prefix cannot be empty");
	let mut end = prefix.to_vec();
	while end.last() == Some(&0xff) {
		end.pop();
	}
	assert!(
		!end.is_empty(),
		"an all-0xff key prefix has no finite lexicographic successor"
	);
	let last = end
		.last_mut()
		.expect("prefix successor must have a last byte");
	*last = last.saturating_add(1);
	end
}

/// Returns the half-open range containing every key that begins with `prefix`.
///
/// Do not use `tuple::Subspace::from_bytes(prefix).range()` for raw byte prefixes. Tuple
/// subspaces deliberately use `prefix + 0x00` and `prefix + 0xff` as sentinels, which excludes
/// both the exact prefix and children whose first suffix byte is `0xff`.
pub fn range_for_prefix(prefix: &[u8]) -> (Vec<u8>, Vec<u8>) {
	(prefix.to_vec(), end_of_prefix_range(prefix))
}

#[cfg(test)]
mod tests {
	use super::{end_of_key_range, end_of_prefix_range, range_for_prefix};

	#[test]
	fn exact_key_and_prefix_ranges_have_different_upper_bounds() {
		let prefix = b"/PIDX/";
		let child = [prefix.as_slice(), &[0, 0, 0, 1]].concat();
		assert!(child.as_slice() >= prefix.as_slice());
		assert!(child >= end_of_key_range(prefix));
		assert!(child < end_of_prefix_range(prefix));
	}

	#[test]
	fn prefix_successor_carries_over_trailing_ff_bytes() {
		assert_eq!(end_of_prefix_range(b"ab\xff\xff"), b"ac");
	}

	#[test]
	fn raw_prefix_range_includes_exact_key_and_ff_child() {
		let prefix = b"/CMP/DIRTY/";
		let exact = prefix.to_vec();
		let ff_child = [prefix.as_slice(), &[0xff, 0, 1]].concat();
		let neighbor = b"/CMP/DIRTY0".to_vec();
		let (begin, end) = range_for_prefix(prefix);

		assert!(exact >= begin && exact < end);
		assert!(ff_child >= begin && ff_child < end);
		assert!(neighbor >= end);
	}
}

// Copied from foundationdb crate
#[inline]
pub fn parse_bytes(input: &[u8], num: usize) -> PackResult<(&[u8], &[u8])> {
	if input.len() < num {
		Err(PackError::MissingBytes)
	} else {
		Ok((&input[num..], &input[..num]))
	}
}

// Copied from foundationdb crate
#[inline]
pub fn parse_byte(input: &[u8]) -> PackResult<(&[u8], u8)> {
	if input.is_empty() {
		Err(PackError::MissingBytes)
	} else {
		Ok((&input[1..], input[0]))
	}
}

// Copied from foundationdb crate
pub fn parse_code(input: &[u8], expected: u8) -> PackResult<&[u8]> {
	let (input, found) = parse_byte(input)?;
	if found == expected {
		Ok(input)
	} else {
		Err(PackError::BadCode {
			found,
			expected: Some(expected),
		})
	}
}
