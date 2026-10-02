//! In-memory page index support for delta lookups.

use scc::HashMap;

/// PIDX is only a read-through optimization. Keep its resident memory independent of total
/// SQLite page cardinality; an evicted entry falls back to an exact FDB point read.
pub const MAX_PIDX_CACHE_ENTRIES: usize = 4_096;

#[derive(Debug, Default)]
pub struct DeltaPageIndex {
	entries: HashMap<u32, u64>,
}

impl DeltaPageIndex {
	pub fn new() -> Self {
		Self {
			entries: HashMap::default(),
		}
	}

	pub fn get(&self, pgno: u32) -> Option<u64> {
		self.entries.read_sync(&pgno, |_, txid| *txid)
	}

	pub fn insert(&self, pgno: u32, txid: u64) {
		if self.entries.read_sync(&pgno, |_, _| ()).is_none()
			&& self.entries.len() >= MAX_PIDX_CACHE_ENTRIES
		{
			let mut victim = None;
			self.entries.iter_sync(|cached_pgno, _| {
				victim = Some(*cached_pgno);
				false
			});
			if let Some(victim) = victim {
				self.entries.remove_sync(&victim);
			}
		}
		let _ = self.entries.upsert_sync(pgno, txid);
	}

	pub fn remove(&self, pgno: u32) -> Option<u64> {
		self.entries.remove_sync(&pgno).map(|(_, txid)| txid)
	}

	pub fn clear(&self) {
		self.entries.clear_sync();
	}

	pub fn is_empty(&self) -> bool {
		self.entries.is_empty()
	}

	pub fn len(&self) -> usize {
		self.entries.len()
	}

	pub fn range(&self, start: u32, end: u32) -> Vec<(u32, u64)> {
		if start > end {
			return Vec::new();
		}

		let mut pages = Vec::new();
		self.entries.iter_sync(|pgno, txid| {
			if *pgno >= start && *pgno <= end {
				pages.push((*pgno, *txid));
			}
			true
		});
		pages.sort_unstable_by_key(|(pgno, _)| *pgno);
		pages
	}
}
