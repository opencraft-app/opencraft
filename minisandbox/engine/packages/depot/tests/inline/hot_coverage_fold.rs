//! Source-owned fold equivalence and work-bound tests. Storage publication/fencing is separately
//! exercised by the real RocksDB-backed forced-compaction and head-advance suites.
use std::cell::Cell;

use super::*;

type CoverageOutput = (u64, u32, Vec<(u32, Vec<u8>)>);

fn delta(txid: u64, size: u32, pages: &[(u32, u8)]) -> DecodedLtx {
	let bytes = encode_ltx_v3(
		LtxHeader::delta(txid, size, txid as i64),
		&pages
			.iter()
			.map(|(pgno, fill)| DirtyPage {
				pgno: *pgno,
				bytes: vec![*fill; keys::PAGE_SIZE as usize],
			})
			.collect::<Vec<_>>(),
	)
	.unwrap();
	decode_ltx_v3(&bytes).unwrap()
}

fn oracle(coverage: &[(u64, u32)], deltas: &BTreeMap<u64, DecodedLtx>) -> Vec<CoverageOutput> {
	coverage
		.iter()
		.flat_map(|(txid, size)| {
			collect_hot_pages_by_shard(*size, deltas, *txid)
				.unwrap()
				.into_iter()
				.map(|(shard, pages)| (*txid, shard, pages))
		})
		.collect()
}

fn actual(coverage: &[(u64, u32)], deltas: &BTreeMap<u64, DecodedLtx>) -> Vec<CoverageOutput> {
	plan_hot_coverage_shards(coverage, deltas.clone().into_iter())
		.unwrap()
		.into_iter()
		.map(|s| (s.as_of_txid, s.shard_id, s.page_updates))
		.collect()
}

#[test]
fn hot_coverage_fold_preserves_order_duplicates_and_intervening_eof() {
	let shard = keys::SHARD_SIZE;
	let deltas = BTreeMap::from([
		(1, delta(1, shard + 2, &[(1, 11), (shard + 1, 12)])),
		(2, delta(2, 1, &[(1, 21)])),
		(3, delta(3, shard + 2, &[(2, 31)])),
		(4, delta(4, shard + 2, &[(shard + 1, 41)])),
	]);
	// No output at the shrink: that intervening EOF must still erase the old page.
	let coverage = [
		(4, shard + 2),
		(1, shard + 2),
		(3, shard + 2),
		(1, shard + 2),
	];
	let result = actual(&coverage, &deltas);
	assert_eq!(result, oracle(&coverage, &deltas));
	assert!(!result.iter().any(|(txid, _, pages)| {
		*txid == 3 && pages.iter().any(|(pgno, _)| *pgno == shard + 1)
	}));
	assert!(result.iter().any(|(txid, _, pages)| {
		*txid == 1
			&& pages
				.iter()
				.any(|(pgno, bytes)| *pgno == shard + 1 && bytes[0] == 12)
	}));
}

#[test]
fn hot_coverage_fold_matches_prefix_oracle_across_growth_and_shrink_histories() {
	for seed in 0..24_u64 {
		let mut deltas = BTreeMap::new();
		let mut coverage = Vec::new();
		for txid in 1..=24_u64 {
			let size = 1 + ((seed * 17 + txid * 13) % 8) as u32;
			let pgno = 1 + ((seed + txid * 3) % size as u64) as u32;
			deltas.insert(txid, delta(txid, size, &[(pgno, txid as u8)]));
			if txid % 3 == 0 {
				coverage.push((txid, size));
			}
		}
		coverage.reverse();
		coverage.push(coverage[2]);
		assert_eq!(actual(&coverage, &deltas), oracle(&coverage, &deltas));
	}
}

#[test]
fn hot_coverage_fold_visits_each_delta_once_not_once_per_pin() {
	const COMMITS: u64 = 128;
	let deltas = (1..=COMMITS)
		.map(|txid| (txid, delta(txid, 1, &[(1, txid as u8)])))
		.collect::<BTreeMap<_, _>>();
	let coverage = (1..=COMMITS).map(|txid| (txid, 1)).collect::<Vec<_>>();
	let visits = Cell::new(0);
	let result = plan_hot_coverage_shards(
		&coverage,
		deltas
			.clone()
			.into_iter()
			.inspect(|_| visits.set(visits.get() + 1)),
	)
	.unwrap();
	assert_eq!(visits.get(), COMMITS);
	assert_eq!(result.len(), COMMITS as usize);
	assert_eq!(actual(&coverage, &deltas), oracle(&coverage, &deltas));
	// The old per-coverage fold reapplies 1 + 2 + ... + 128 = 8,256 DELTAs.
	assert_eq!(coverage.iter().map(|(txid, _)| txid).sum::<u64>(), 8_256);
}

#[test]
fn hot_coverage_fold_excludes_future_deltas_and_empty_coverage_does_no_work() {
	let deltas = BTreeMap::from([(1, delta(1, 1, &[(1, 11)])), (3, delta(3, 1, &[(1, 33)]))]);
	assert_eq!(actual(&[(1, 1)], &deltas), oracle(&[(1, 1)], &deltas));
	let visits = Cell::new(0);
	let result = plan_hot_coverage_shards(
		&[],
		deltas.into_iter().inspect(|_| visits.set(visits.get() + 1)),
	)
	.unwrap();
	assert!(result.is_empty());
	assert_eq!(visits.get(), 0);
}

#[test]
fn hot_coverage_fold_keeps_the_existing_fdb_output_row_bound() {
	let deltas = BTreeMap::from([(1, delta(1, 1, &[(1, 1)]))]);
	let coverage = vec![(1, 1); CMP_FDB_BATCH_MAX_KEYS + 1];
	let err = plan_hot_coverage_shards(&coverage, deltas.into_iter()).unwrap_err();
	assert!(err.to_string().contains("FDB job limit"));
}
