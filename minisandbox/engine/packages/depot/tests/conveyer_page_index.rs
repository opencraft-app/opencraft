use depot::page_index::{DeltaPageIndex, MAX_PIDX_CACHE_ENTRIES};

#[test]
fn insert_get_and_remove_round_trip() {
	let index = DeltaPageIndex::new();

	assert_eq!(index.get(7), None);

	index.insert(7, 11);
	index.insert(9, 15);

	assert_eq!(index.get(7), Some(11));
	assert_eq!(index.get(9), Some(15));
	assert_eq!(index.remove(7), Some(11));
	assert_eq!(index.get(7), None);
	assert_eq!(index.remove(99), None);
}

#[test]
fn insert_overwrites_existing_txid() {
	let index = DeltaPageIndex::new();

	index.insert(4, 20);
	index.insert(4, 21);

	assert_eq!(index.get(4), Some(21));
}

#[test]
fn range_returns_sorted_pages_within_bounds() {
	let index = DeltaPageIndex::new();
	index.insert(12, 1200);
	index.insert(3, 300);
	index.insert(7, 700);
	index.insert(15, 1500);

	assert_eq!(index.range(4, 12), vec![(7, 700), (12, 1200)]);
	assert_eq!(index.range(20, 10), Vec::<(u32, u64)>::new());
}

#[test]
fn cache_size_is_independent_of_database_page_cardinality() {
	let index = DeltaPageIndex::new();
	for pgno in 1..=u32::try_from(MAX_PIDX_CACHE_ENTRIES + 257).unwrap() {
		index.insert(pgno, u64::from(pgno));
	}

	assert_eq!(index.len(), MAX_PIDX_CACHE_ENTRIES);
	let newest = u32::try_from(MAX_PIDX_CACHE_ENTRIES + 257).unwrap();
	assert_eq!(index.get(newest), Some(u64::from(newest)));
	assert!(!index.is_empty());
	index.clear();
	assert!(index.is_empty());
}
