//! Bounded, non-authoritative cache for immutable BlockVolume chunks.

use std::{
	collections::BTreeMap,
	fs::{self, OpenOptions},
	io::Write,
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
};

use moka::sync::Cache;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Immutable COS object size used by the production BlockVolume path.
pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;
const HASH_BYTES: usize = 32;

/// SHA-256 identity of one immutable 4 MiB chunk.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ChunkHash([u8; HASH_BYTES]);

impl ChunkHash {
	/// Builds an identity from an already authenticated SHA-256 digest.
	pub const fn from_bytes(bytes: [u8; HASH_BYTES]) -> Self {
		Self(bytes)
	}

	/// Hashes and identifies one complete chunk.
	///
	/// # Errors
	///
	/// Returns an error unless `bytes` contains exactly 4 MiB.
	pub fn for_chunk(bytes: &[u8]) -> Result<Self, ChunkCacheError> {
		validate_chunk(bytes)?;
		Ok(Self(Sha256::digest(bytes).into()))
	}

	/// Returns the canonical raw digest.
	#[must_use]
	pub const fn as_bytes(&self) -> &[u8; HASH_BYTES] {
		&self.0
	}

	fn from_hex(value: &str) -> Option<Self> {
		let mut bytes = [0; HASH_BYTES];
		hex::decode_to_slice(value, &mut bytes).ok()?;
		Some(Self(bytes))
	}

	/// Returns the lowercase hexadecimal object identity.
	#[must_use]
	pub fn to_hex(self) -> String {
		hex::encode(self.0)
	}
}

/// Cache construction, validation, or local-I/O failure.
#[derive(Debug, Error)]
pub enum ChunkCacheError {
	/// Chunk size did not match the immutable object contract.
	#[error("BlockVolume chunk must contain exactly {CHUNK_BYTES} bytes")]
	InvalidSize,
	/// Bytes did not authenticate against their content-addressed key.
	#[error("BlockVolume chunk failed SHA-256 authentication")]
	AuthenticationFailed,
	/// Cache bounds cannot hold one complete chunk.
	#[error("BlockVolume cache capacity must hold at least one complete chunk")]
	InvalidCapacity,
	/// The disposable cache directory was unavailable.
	#[error("BlockVolume cache I/O failed")]
	Io(#[from] std::io::Error),
}

#[derive(Clone, Copy, Debug)]
struct DiskEntry {
	bytes: u64,
	access_sequence: u64,
}

#[derive(Debug, Default)]
struct DiskIndex {
	entries: BTreeMap<ChunkHash, DiskEntry>,
	total_bytes: u64,
	access_sequence: u64,
}

impl DiskIndex {
	fn touch(&mut self, hash: ChunkHash) -> bool {
		let Some(entry) = self.entries.get_mut(&hash) else {
			return false;
		};
		self.access_sequence = self.access_sequence.saturating_add(1);
		entry.access_sequence = self.access_sequence;
		true
	}

	fn insert(&mut self, hash: ChunkHash, bytes: u64) {
		if let Some(previous) = self.entries.remove(&hash) {
			self.total_bytes = self.total_bytes.saturating_sub(previous.bytes);
		}
		self.access_sequence = self.access_sequence.saturating_add(1);
		self.entries.insert(
			hash,
			DiskEntry {
				bytes,
				access_sequence: self.access_sequence,
			},
		);
		self.total_bytes = self.total_bytes.saturating_add(bytes);
	}

	fn remove(&mut self, hash: ChunkHash) {
		if let Some(entry) = self.entries.remove(&hash) {
			self.total_bytes = self.total_bytes.saturating_sub(entry.bytes);
		}
	}

	fn oldest(&self) -> Option<ChunkHash> {
		self.entries
			.iter()
			.min_by_key(|(_, entry)| entry.access_sequence)
			.map(|(hash, _)| *hash)
	}
}

/// Shared RAM plus disposable local-NVMe cache keyed only by authenticated content.
///
/// Neither tier is authoritative. Removing the complete directory can only
/// cause future COS reads; durability remains entirely in FDB and COS.
pub struct ChunkCache {
	root: PathBuf,
	memory: Cache<ChunkHash, Arc<[u8]>>,
	max_disk_bytes: u64,
	disk: Mutex<DiskIndex>,
	temporary_sequence: AtomicU64,
}

impl ChunkCache {
	/// Opens a cache and trims pre-existing files to the requested hard bounds.
	///
	/// # Errors
	///
	/// Returns an error for invalid capacities or an unavailable cache directory.
	pub fn open(
		root: impl Into<PathBuf>,
		max_memory_bytes: u64,
		max_disk_bytes: u64,
	) -> Result<Self, ChunkCacheError> {
		let chunk_bytes = u64::try_from(CHUNK_BYTES).unwrap();
		if max_memory_bytes < chunk_bytes || max_disk_bytes < chunk_bytes {
			return Err(ChunkCacheError::InvalidCapacity);
		}
		let root = root.into();
		fs::create_dir_all(&root)?;
		let memory = Cache::builder()
			.max_capacity(max_memory_bytes)
			.weigher(|_hash: &ChunkHash, bytes: &Arc<[u8]>| {
				u32::try_from(bytes.len()).unwrap_or(u32::MAX)
			})
			.build();
		let cache = Self {
			root,
			memory,
			max_disk_bytes,
			disk: Mutex::new(DiskIndex::default()),
			temporary_sequence: AtomicU64::new(0),
		};
		cache.rebuild_disk_index()?;
		cache.trim_disk()?;
		Ok(cache)
	}

	/// Reads and authenticates one cached chunk.
	///
	/// Corrupt disposable files are removed and treated as cache misses.
	#[must_use]
	pub fn get(&self, hash: ChunkHash) -> Option<Arc<[u8]>> {
		if let Some(bytes) = self.memory.get(&hash) {
			return Some(bytes);
		}
		if !self.disk.lock().touch(hash) {
			return None;
		}
		let path = self.chunk_path(hash);
		let bytes = fs::read(&path).ok()?;
		if authenticate(hash, &bytes).is_err() {
			let _ = fs::remove_file(path);
			self.disk.lock().remove(hash);
			return None;
		}
		let bytes: Arc<[u8]> = bytes.into();
		self.memory.insert(hash, bytes.clone());
		Some(bytes)
	}

	/// Authenticates and inserts one immutable chunk into both cache tiers.
	///
	/// # Errors
	///
	/// Returns an error for an invalid key/value pair or local cache I/O failure.
	pub fn insert(&self, hash: ChunkHash, bytes: &[u8]) -> Result<(), ChunkCacheError> {
		authenticate(hash, bytes)?;
		let path = self.chunk_path(hash);
		let parent = path.parent().expect("chunk path has a shard parent");
		fs::create_dir_all(parent)?;
		let temporary = parent.join(format!(
			".{}.{}.{}.tmp",
			hash.to_hex(),
			std::process::id(),
			self.temporary_sequence.fetch_add(1, Ordering::Relaxed)
		));
		let mut file = OpenOptions::new()
			.create_new(true)
			.write(true)
			.open(&temporary)?;
		file.write_all(bytes)?;
		file.sync_data()?;
		drop(file);
		fs::rename(&temporary, &path)?;

		let bytes: Arc<[u8]> = bytes.to_vec().into();
		self.memory.insert(hash, bytes);
		self.disk
			.lock()
			.insert(hash, u64::try_from(CHUNK_BYTES).unwrap());
		self.trim_disk()
	}

	/// Removes one disposable cache entry from both tiers.
	///
	/// # Errors
	///
	/// Returns an error only when a present disk entry cannot be removed.
	pub fn invalidate(&self, hash: ChunkHash) -> Result<(), ChunkCacheError> {
		self.memory.invalidate(&hash);
		self.disk.lock().remove(hash);
		match fs::remove_file(self.chunk_path(hash)) {
			Ok(()) => Ok(()),
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
			Err(error) => Err(error.into()),
		}
	}

	fn chunk_path(&self, hash: ChunkHash) -> PathBuf {
		let hex = hash.to_hex();
		self.root.join(&hex[..2]).join(hex)
	}

	fn rebuild_disk_index(&self) -> Result<(), ChunkCacheError> {
		let mut index = self.disk.lock();
		for shard in fs::read_dir(&self.root)? {
			let shard = shard?;
			if !shard.file_type()?.is_dir() {
				continue;
			}
			for entry in fs::read_dir(shard.path())? {
				let entry = entry?;
				if !entry.file_type()?.is_file() {
					continue;
				}
				let name = entry.file_name();
				let Some(name) = name.to_str() else {
					continue;
				};
				let Some(hash) = ChunkHash::from_hex(name) else {
					continue;
				};
				let bytes = entry.metadata()?.len();
				if bytes == u64::try_from(CHUNK_BYTES).unwrap() {
					index.insert(hash, bytes);
				}
			}
		}
		Ok(())
	}

	fn trim_disk(&self) -> Result<(), ChunkCacheError> {
		loop {
			let victim = {
				let mut index = self.disk.lock();
				if index.total_bytes <= self.max_disk_bytes {
					return Ok(());
				}
				let victim = index.oldest().ok_or(ChunkCacheError::InvalidCapacity)?;
				index.remove(victim);
				victim
			};
			match fs::remove_file(self.chunk_path(victim)) {
				Ok(()) => {}
				Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
				Err(error) => return Err(error.into()),
			}
		}
	}
}

fn validate_chunk(bytes: &[u8]) -> Result<(), ChunkCacheError> {
	if bytes.len() != CHUNK_BYTES {
		return Err(ChunkCacheError::InvalidSize);
	}
	Ok(())
}

fn authenticate(hash: ChunkHash, bytes: &[u8]) -> Result<(), ChunkCacheError> {
	if ChunkHash::for_chunk(bytes)? != hash {
		return Err(ChunkCacheError::AuthenticationFailed);
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::fs::File;

	use super::*;

	#[test]
	fn cos_object_geometry_is_exactly_four_mib() {
		assert_eq!(CHUNK_BYTES, 4 * 1024 * 1024);
		assert!(ChunkHash::for_chunk(&vec![0; CHUNK_BYTES]).is_ok());
		assert!(matches!(
			ChunkHash::for_chunk(&vec![0; CHUNK_BYTES - 1]),
			Err(ChunkCacheError::InvalidSize)
		));
	}

	#[test]
	fn memory_and_disk_hits_authenticate_content() {
		let directory = tempfile::tempdir().unwrap();
		let bytes = vec![0x5a; CHUNK_BYTES];
		let hash = ChunkHash::for_chunk(&bytes).unwrap();
		let cache = ChunkCache::open(
			directory.path(),
			u64::try_from(CHUNK_BYTES).unwrap(),
			u64::try_from(2 * CHUNK_BYTES).unwrap(),
		)
		.unwrap();
		cache.insert(hash, &bytes).unwrap();
		assert_eq!(cache.get(hash).unwrap().as_ref(), bytes);
		drop(cache);

		let reopened = ChunkCache::open(
			directory.path(),
			u64::try_from(CHUNK_BYTES).unwrap(),
			u64::try_from(2 * CHUNK_BYTES).unwrap(),
		)
		.unwrap();
		assert_eq!(reopened.get(hash).unwrap().as_ref(), bytes);
	}

	#[test]
	fn disk_bound_evicts_the_oldest_chunk() {
		let directory = tempfile::tempdir().unwrap();
		let cache = ChunkCache::open(
			directory.path(),
			u64::try_from(CHUNK_BYTES).unwrap(),
			u64::try_from(CHUNK_BYTES).unwrap(),
		)
		.unwrap();
		let first = vec![0x11; CHUNK_BYTES];
		let second = vec![0x22; CHUNK_BYTES];
		let first_hash = ChunkHash::for_chunk(&first).unwrap();
		let second_hash = ChunkHash::for_chunk(&second).unwrap();
		cache.insert(first_hash, &first).unwrap();
		cache.insert(second_hash, &second).unwrap();
		drop(cache);

		let reopened = ChunkCache::open(
			directory.path(),
			u64::try_from(CHUNK_BYTES).unwrap(),
			u64::try_from(CHUNK_BYTES).unwrap(),
		)
		.unwrap();
		assert!(reopened.get(first_hash).is_none());
		assert_eq!(reopened.get(second_hash).unwrap().as_ref(), second);
	}

	#[test]
	fn corrupt_disk_entry_becomes_a_miss() {
		let directory = tempfile::tempdir().unwrap();
		let bytes = vec![0x44; CHUNK_BYTES];
		let hash = ChunkHash::for_chunk(&bytes).unwrap();
		let cache = ChunkCache::open(
			directory.path(),
			u64::try_from(CHUNK_BYTES).unwrap(),
			u64::try_from(CHUNK_BYTES).unwrap(),
		)
		.unwrap();
		cache.insert(hash, &bytes).unwrap();
		let path = cache.chunk_path(hash);
		drop(cache);
		let mut file = File::options()
			.write(true)
			.truncate(true)
			.open(path)
			.unwrap();
		file.write_all(&vec![0x99; CHUNK_BYTES]).unwrap();
		drop(file);

		let reopened = ChunkCache::open(
			directory.path(),
			u64::try_from(CHUNK_BYTES).unwrap(),
			u64::try_from(CHUNK_BYTES).unwrap(),
		)
		.unwrap();
		assert!(reopened.get(hash).is_none());
	}
}
