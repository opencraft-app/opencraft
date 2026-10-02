//! Native FDB hot-delta metadata and FDB-to-COS chunk settlement.

use std::{collections::BTreeMap, io::Read, sync::Arc};

#[cfg(feature = "foundationdb")]
use std::path::PathBuf;

use anyhow::{Result as AnyResult, anyhow, bail};
use foundationdb_tuple::Subspace;
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use universaldb::{
	Database, RangeOption,
	options::StreamingMode,
	prelude::{ACTOR, DATA, GENERATION, PEGBOARD, RIVET},
	utils::{IsolationLevel::Serializable, range_for_prefix},
};
use vbare::OwnedVersionedData;

use crate::{CHUNK_BYTES, ChunkHash, ChunkStore, ChunkStoreError};

const PAGE_BYTES: usize = 4 * 1024;
const PAGES_PER_CHUNK: u64 = (CHUNK_BYTES / PAGE_BYTES) as u64;
const MAX_PAGE_MUTATIONS: usize = 256;
const MAX_CHUNK_DISCARDS: usize = 128;
const MAX_IDENTIFIER_BYTES: usize = 128;
const FORMAT_VERSION: u16 = 1;

/// Durable initialization state of one independently fenced volume.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VolumeInitializationState {
	/// The trusted importer may publish immutable initial chunk references.
	Initializing,
	/// The guest may issue ordinary block I/O.
	Ready,
}

/// Public durable state used by admission, monitoring, and backpressure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeVolumeState {
	/// Fixed logical capacity.
	pub logical_size: u64,
	/// Current writer fence, normally the authoritative actor generation.
	pub writer_generation: u64,
	/// Immutable identity of the filesystem initializer image.
	pub template_id: String,
	/// Whether ordinary guest I/O is admitted.
	pub initialization: VolumeInitializationState,
	/// Bytes currently acknowledged in the FDB hot tier.
	pub hot_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct VolumeRecord {
	logical_size: u64,
	writer_generation: u64,
	template_id: String,
	initialization: u8,
	next_sequence: u64,
	hot_bytes: u64,
}

impl VolumeRecord {
	fn public(&self) -> Result<NativeVolumeState, FdbBlockMetaStoreError> {
		Ok(NativeVolumeState {
			logical_size: self.logical_size,
			writer_generation: self.writer_generation,
			template_id: self.template_id.clone(),
			initialization: match self.initialization {
				1 => VolumeInitializationState::Initializing,
				2 => VolumeInitializationState::Ready,
				_ => return Err(FdbBlockMetaStoreError::CorruptState),
			},
			hot_bytes: self.hot_bytes,
		})
	}
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct HotPageRecord {
	sequence: u64,
	bytes: Option<Vec<u8>>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct ChunkRefRecord {
	hash: [u8; 32],
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct OperationResultRecord {
	fingerprint: [u8; 32],
	last_sequence: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct DirtyRecord {
	chunk_no: u64,
}

macro_rules! versioned_record {
	($versioned:ident, $record:ty, $label:literal) => {
		enum $versioned {
			V1($record),
		}

		impl OwnedVersionedData for $versioned {
			type Latest = $record;

			fn wrap_latest(latest: Self::Latest) -> Self {
				Self::V1(latest)
			}

			fn unwrap_latest(self) -> AnyResult<Self::Latest> {
				match self {
					Self::V1(record) => Ok(record),
				}
			}

			fn deserialize_version(payload: &[u8], version: u16) -> AnyResult<Self> {
				match version {
					1 => Ok(Self::V1(serde_bare::from_slice(payload)?)),
					_ => bail!(concat!(
						"unsupported BlockVolume ",
						$label,
						" version {version}"
					)),
				}
			}

			fn serialize_version(self, _version: u16) -> AnyResult<Vec<u8>> {
				match self {
					Self::V1(record) => Ok(serde_bare::to_vec(&record)?),
				}
			}
		}
	};
}

versioned_record!(VersionedVolumeRecord, VolumeRecord, "volume");
versioned_record!(VersionedHotPageRecord, HotPageRecord, "hot-page");
versioned_record!(VersionedChunkRefRecord, ChunkRefRecord, "chunk-ref");
versioned_record!(
	VersionedOperationResultRecord,
	OperationResultRecord,
	"operation-result"
);
versioned_record!(VersionedDirtyRecord, DirtyRecord, "dirty-index");

/// One durable hot-page mutation. `None` represents deterministic zero/discard.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PageMutation {
	/// Zero-based 4 KiB logical page number.
	pub block_no: u64,
	/// Complete page bytes, or `None` for a payload-free zero.
	pub bytes: Option<Vec<u8>>,
}

/// One resolved FDB hot page returned above an optional cold chunk.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HotPage {
	/// Zero-based 4 KiB logical page number.
	pub block_no: u64,
	/// Monotonic volume-local sequence.
	pub sequence: u64,
	/// Complete page bytes, or `None` for deterministic zero.
	pub bytes: Option<Vec<u8>>,
}

/// Consistent read/writeback view of one 4 MiB COS object range.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChunkSnapshot {
	/// Volume identity.
	pub volume_id: String,
	/// Writer generation observed in the same transaction.
	pub writer_generation: u64,
	/// Zero-based 4 MiB COS object number.
	pub chunk_no: u64,
	/// Current immutable COS base, absent for an all-zero range.
	pub base_hash: Option<ChunkHash>,
	/// FDB pages which override the cold base.
	pub hot_pages: Vec<HotPage>,
}

/// One consistent, bulk-loaded recovery manifest for a fenced writer.
///
/// Normal guest reads consume this manifest locally and never query FDB. Only
/// writer admission or host recovery builds it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VolumeRecovery {
	/// Durable volume state observed with the manifest.
	pub state: NativeVolumeState,
	/// Only chunks with a cold base or an FDB hot override are present.
	pub chunks: BTreeMap<u64, ChunkSnapshot>,
}

/// Native metadata operation failure.
#[derive(Clone, Debug, thiserror::Error)]
pub enum FdbBlockMetaStoreError {
	/// Input violated a bounded protocol invariant.
	#[error("invalid native BlockVolume request")]
	InvalidArgument,
	/// Stored values violate the versioned schema or geometry.
	#[error("native BlockVolume metadata is corrupt")]
	CorruptState,
	/// The caller lost the writer generation fence.
	#[error("native BlockVolume writer generation is stale")]
	StaleWriter,
	/// Guest I/O arrived before the initializer committed `ready`.
	#[error("native BlockVolume is not ready")]
	NotReady,
	/// A trusted initializer attempted to mutate an already-ready volume.
	#[error("native BlockVolume is already ready")]
	AlreadyReady,
	/// FDB hot data reached its hard admission bound.
	#[error("native BlockVolume FDB hot tier is full")]
	HotTierFull,
	/// The trusted template cannot fit in one bounded initialization transaction.
	#[error("native BlockVolume template has {pages} non-zero pages; maximum is {max}")]
	TemplateTooLarge {
		/// Non-zero 4 KiB pages discovered before rejecting the template.
		pages: usize,
		/// Maximum pages admitted by one atomic initialization transaction.
		max: usize,
	},
	/// FDB or its transaction driver failed explicitly.
	#[error("native BlockVolume metadata unavailable: {0}")]
	Unavailable(Arc<str>),
}

impl FdbBlockMetaStoreError {
	fn unavailable(error: impl std::fmt::Display) -> Self {
		Self::Unavailable(Arc::from(error.to_string()))
	}
}

#[derive(Clone)]
struct NativeKeys {
	root: Subspace,
}

impl NativeKeys {
	fn state(&self, volume_id: &str) -> Vec<u8> {
		self.root.pack(&("v", volume_id, "state"))
	}

	fn hot(&self, volume_id: &str, block_no: u64) -> Vec<u8> {
		self.root.pack(&("v", volume_id, "hot", block_no))
	}

	fn hot_prefix(&self, volume_id: &str) -> Vec<u8> {
		self.root
			.subspace(&("v", volume_id, "hot"))
			.bytes()
			.to_vec()
	}

	fn chunk(&self, volume_id: &str, chunk_no: u64) -> Vec<u8> {
		self.root.pack(&("v", volume_id, "chunk", chunk_no))
	}

	fn chunk_prefix(&self, volume_id: &str) -> Vec<u8> {
		self.root
			.subspace(&("v", volume_id, "chunk"))
			.bytes()
			.to_vec()
	}

	fn dirty(&self, volume_id: &str, chunk_no: u64) -> Vec<u8> {
		self.root.pack(&("v", volume_id, "dirty", chunk_no))
	}

	fn dirty_prefix(&self, volume_id: &str) -> Vec<u8> {
		self.root
			.subspace(&("v", volume_id, "dirty"))
			.bytes()
			.to_vec()
	}

	fn operation(&self, volume_id: &str, generation: u64, op_id: &str) -> Vec<u8> {
		self.root.pack(&("v", volume_id, "op", generation, op_id))
	}

	fn operation_prefix(&self, volume_id: &str, generation: u64) -> Vec<u8> {
		self.root
			.subspace(&("v", volume_id, "op", generation))
			.bytes()
			.to_vec()
	}
}

/// Native FDB metadata/hot-page implementation used by the PVM BlockVolume path.
#[derive(Clone)]
pub struct FdbBlockMetaStore {
	database: Database,
	keys: NativeKeys,
	max_hot_bytes: u64,
}

impl FdbBlockMetaStore {
	/// Creates a store below a deployment-owned raw FDB prefix.
	///
	/// # Errors
	///
	/// Returns an error when the hot-tier budget cannot hold one 4 KiB page.
	pub fn new(
		database: Database,
		root_prefix: impl Into<Vec<u8>>,
		max_hot_bytes: u64,
	) -> Result<Self, FdbBlockMetaStoreError> {
		if max_hot_bytes < u64::try_from(PAGE_BYTES).unwrap() {
			return Err(FdbBlockMetaStoreError::InvalidArgument);
		}
		Ok(Self {
			database,
			keys: NativeKeys {
				root: Subspace::from_bytes(root_prefix),
			},
			max_hot_bytes,
		})
	}

	/// Creates or re-fences one volume in `initializing` state.
	pub async fn open_volume(
		&self,
		volume_id: &str,
		logical_size: u64,
		writer_generation: u64,
		template_id: &str,
	) -> Result<NativeVolumeState, FdbBlockMetaStoreError> {
		validate_identity(volume_id)?;
		validate_identity(template_id)?;
		if logical_size == 0
			|| !logical_size.is_multiple_of(u64::try_from(CHUNK_BYTES).unwrap())
			|| writer_generation == 0
		{
			return Err(FdbBlockMetaStoreError::InvalidArgument);
		}
		let keys = self.keys.clone();
		let volume_id = volume_id.to_owned();
		let template_id = template_id.to_owned();
		self.database
			.txn("minisandbox_block_open", move |tx| {
				let keys = keys.clone();
				let volume_id = volume_id.clone();
				let template_id = template_id.clone();
				async move {
					check_authoritative_generation(&tx, &volume_id, writer_generation).await?;
					let key = keys.state(&volume_id);
					let mut record = match tx.get(&key, Serializable).await? {
						Some(bytes) => decode_volume(&bytes)?,
						None => VolumeRecord {
							logical_size,
							writer_generation,
							template_id: template_id.clone(),
							initialization: 1,
							next_sequence: 1,
							hot_bytes: 0,
						},
					};
					if record.logical_size != logical_size || record.template_id != template_id {
						return Err(anyhow!(FdbBlockMetaStoreError::CorruptState));
					}
					if writer_generation < record.writer_generation {
						return Err(anyhow!(FdbBlockMetaStoreError::StaleWriter));
					}
					record.writer_generation = writer_generation;
					tx.set(&key, &encode_volume(record.clone())?);
					record.public().map_err(anyhow::Error::new)
				}
			})
			.await
			.map_err(map_transaction_error)
	}

	/// Atomically stages a bounded trusted template in FDB and admits guest I/O.
	pub async fn initialize_hot_pages(
		&self,
		volume_id: &str,
		writer_generation: u64,
		pages: &[PageMutation],
	) -> Result<NativeVolumeState, FdbBlockMetaStoreError> {
		validate_identity(volume_id)?;
		validate_initial_pages(pages)?;
		let keys = self.keys.clone();
		let volume_id = volume_id.to_owned();
		let pages = pages.to_vec();
		let max_hot_bytes = self.max_hot_bytes;
		self.database
			.txn("minisandbox_block_initialize_hot", move |tx| {
				let keys = keys.clone();
				let volume_id = volume_id.clone();
				let pages = pages.clone();
				async move {
					check_authoritative_generation(&tx, &volume_id, writer_generation).await?;
					let mut state = load_state(&tx, &keys, &volume_id).await?;
					check_generation(&state, writer_generation)?;
					if state.initialization == 2 {
						return state.public().map_err(anyhow::Error::new);
					}
					if state.initialization != 1 || state.hot_bytes != 0 {
						return Err(anyhow!(FdbBlockMetaStoreError::CorruptState));
					}
					let max_blocks = state.logical_size / u64::try_from(PAGE_BYTES).unwrap();
					let hot_bytes = u64::try_from(pages.len())
						.ok()
						.and_then(|pages| pages.checked_mul(u64::try_from(PAGE_BYTES).unwrap()))
						.ok_or_else(|| anyhow!(FdbBlockMetaStoreError::InvalidArgument))?;
					if hot_bytes > max_hot_bytes {
						return Err(anyhow!(FdbBlockMetaStoreError::HotTierFull));
					}
					for page in &pages {
						if page.block_no >= max_blocks {
							return Err(anyhow!(FdbBlockMetaStoreError::InvalidArgument));
						}
						let sequence = state.next_sequence;
						state.next_sequence = state
							.next_sequence
							.checked_add(1)
							.ok_or_else(|| anyhow!(FdbBlockMetaStoreError::CorruptState))?;
						tx.set(
							&keys.hot(&volume_id, page.block_no),
							&encode_hot_page(HotPageRecord {
								sequence,
								bytes: page.bytes.clone(),
							})?,
						);
						let chunk_no = page.block_no / PAGES_PER_CHUNK;
						tx.set(
							&keys.dirty(&volume_id, chunk_no),
							&encode_dirty(DirtyRecord { chunk_no })?,
						);
					}
					state.hot_bytes = hot_bytes;
					state.initialization = 2;
					tx.set(&keys.state(&volume_id), &encode_volume(state.clone())?);
					state.public().map_err(anyhow::Error::new)
				}
			})
			.await
			.map_err(map_transaction_error)
	}

	/// Commits one bounded idempotent set of complete 4 KiB hot-page mutations.
	pub async fn write_pages(
		&self,
		volume_id: &str,
		writer_generation: u64,
		op_id: &str,
		pages: Vec<PageMutation>,
	) -> Result<u64, FdbBlockMetaStoreError> {
		validate_identity(volume_id)?;
		validate_identity(op_id)?;
		validate_page_mutations(&pages)?;
		let fingerprint = page_fingerprint(volume_id, writer_generation, op_id, &pages);
		let keys = self.keys.clone();
		let volume_id = volume_id.to_owned();
		let op_id = op_id.to_owned();
		let max_hot_bytes = self.max_hot_bytes;
		self.database
			.txn("minisandbox_block_write", move |tx| {
				let keys = keys.clone();
				let volume_id = volume_id.clone();
				let op_id = op_id.clone();
				let pages = pages.clone();
				async move {
					check_authoritative_generation(&tx, &volume_id, writer_generation).await?;
					let op_key = keys.operation(&volume_id, writer_generation, &op_id);
					if let Some(bytes) = tx.get(&op_key, Serializable).await? {
						let stored = decode_operation_result(&bytes)?;
						if stored.fingerprint != fingerprint {
							return Err(anyhow!(FdbBlockMetaStoreError::CorruptState));
						}
						return Ok(stored.last_sequence);
					}
					let mut state = load_state(&tx, &keys, &volume_id).await?;
					check_generation(&state, writer_generation)?;
					if state.initialization != 2 {
						return Err(anyhow!(FdbBlockMetaStoreError::NotReady));
					}
					let max_blocks = state.logical_size / u64::try_from(PAGE_BYTES).unwrap();
					let hot_keys = pages
						.iter()
						.map(|page| keys.hot(&volume_id, page.block_no))
						.collect::<Vec<_>>();
					let existing = futures_util::future::try_join_all(
						hot_keys.iter().map(|key| tx.get(key, Serializable)),
					)
					.await?;
					let mut last_sequence = 0;
					for ((page, hot_key), previous) in
						pages.iter().zip(hot_keys.iter()).zip(existing.iter())
					{
						if page.block_no >= max_blocks {
							return Err(anyhow!(FdbBlockMetaStoreError::InvalidArgument));
						}
						if previous.is_none() {
							state.hot_bytes = state
								.hot_bytes
								.checked_add(u64::try_from(PAGE_BYTES).unwrap())
								.ok_or_else(|| anyhow!(FdbBlockMetaStoreError::CorruptState))?;
						}
						if state.hot_bytes > max_hot_bytes {
							return Err(anyhow!(FdbBlockMetaStoreError::HotTierFull));
						}
						let sequence = state.next_sequence;
						state.next_sequence = state
							.next_sequence
							.checked_add(1)
							.ok_or_else(|| anyhow!(FdbBlockMetaStoreError::CorruptState))?;
						tx.set(
							hot_key,
							&encode_hot_page(HotPageRecord {
								sequence,
								bytes: page.bytes.clone(),
							})?,
						);
						let chunk_no = page.block_no / PAGES_PER_CHUNK;
						tx.set(
							&keys.dirty(&volume_id, chunk_no),
							&encode_dirty(DirtyRecord { chunk_no })?,
						);
						last_sequence = sequence;
					}
					tx.set(&keys.state(&volume_id), &encode_volume(state)?);
					let (op_begin, op_end) =
						range_for_prefix(&keys.operation_prefix(&volume_id, writer_generation));
					tx.clear_range(&op_begin, &op_end);
					tx.set(
						&op_key,
						&encode_operation_result(OperationResultRecord {
							fingerprint,
							last_sequence,
						})?,
					);
					Ok(last_sequence)
				}
			})
			.await
			.map_err(map_transaction_error)
	}

	/// Atomically drops complete 4 MiB ranges without materializing zero pages.
	pub async fn discard_chunks(
		&self,
		volume_id: &str,
		writer_generation: u64,
		op_id: &str,
		chunk_nos: Vec<u64>,
	) -> Result<(), FdbBlockMetaStoreError> {
		validate_identity(volume_id)?;
		validate_identity(op_id)?;
		validate_chunk_discards(&chunk_nos)?;
		let fingerprint = discard_fingerprint(volume_id, writer_generation, op_id, &chunk_nos);
		let keys = self.keys.clone();
		let volume_id = volume_id.to_owned();
		let op_id = op_id.to_owned();
		self.database
			.txn("minisandbox_block_discard_chunks", move |tx| {
				let keys = keys.clone();
				let volume_id = volume_id.clone();
				let op_id = op_id.clone();
				let chunk_nos = chunk_nos.clone();
				async move {
					check_authoritative_generation(&tx, &volume_id, writer_generation).await?;
					let op_key = keys.operation(&volume_id, writer_generation, &op_id);
					if let Some(bytes) = tx.get(&op_key, Serializable).await? {
						let stored = decode_operation_result(&bytes)?;
						if stored.fingerprint != fingerprint {
							return Err(anyhow!(FdbBlockMetaStoreError::CorruptState));
						}
						return Ok(());
					}
					let mut state = load_state(&tx, &keys, &volume_id).await?;
					check_generation(&state, writer_generation)?;
					if state.initialization != 2 {
						return Err(anyhow!(FdbBlockMetaStoreError::NotReady));
					}
					let max_chunks = state.logical_size / u64::try_from(CHUNK_BYTES).unwrap();
					let first_chunk = *chunk_nos
						.first()
						.ok_or_else(|| anyhow!(FdbBlockMetaStoreError::InvalidArgument))?;
					let last_chunk = *chunk_nos
						.last()
						.ok_or_else(|| anyhow!(FdbBlockMetaStoreError::InvalidArgument))?;
					if last_chunk >= max_chunks {
						return Err(anyhow!(FdbBlockMetaStoreError::InvalidArgument));
					}
					let hot_begin =
						keys.hot(&volume_id, first_chunk.saturating_mul(PAGES_PER_CHUNK));
					let hot_end = keys.hot(
						&volume_id,
						last_chunk.saturating_add(1).saturating_mul(PAGES_PER_CHUNK),
					);
					let mut hot_rows = tx.get_ranges_keyvalues(
						RangeOption {
							mode: StreamingMode::WantAll,
							..RangeOption::from((hot_begin.clone(), hot_end.clone()))
						},
						Serializable,
					);
					let mut cleared_pages = 0_u64;
					while hot_rows.try_next().await?.is_some() {
						cleared_pages = cleared_pages.saturating_add(1);
					}
					tx.clear_range(&hot_begin, &hot_end);
					for chunk_no in &chunk_nos {
						tx.clear(&keys.chunk(&volume_id, *chunk_no));
						tx.clear(&keys.dirty(&volume_id, *chunk_no));
					}
					state.hot_bytes = state.hot_bytes.saturating_sub(
						cleared_pages.saturating_mul(u64::try_from(PAGE_BYTES).unwrap()),
					);
					tx.set(&keys.state(&volume_id), &encode_volume(state)?);
					let (op_begin, op_end) =
						range_for_prefix(&keys.operation_prefix(&volume_id, writer_generation));
					tx.clear_range(&op_begin, &op_end);
					tx.set(
						&op_key,
						&encode_operation_result(OperationResultRecord {
							fingerprint,
							last_sequence: 0,
						})?,
					);
					Ok(())
				}
			})
			.await
			.map_err(map_transaction_error)
	}

	/// Reads one consistent cold reference plus every overriding FDB hot page.
	pub async fn read_chunk_snapshot(
		&self,
		volume_id: &str,
		writer_generation: u64,
		chunk_no: u64,
	) -> Result<ChunkSnapshot, FdbBlockMetaStoreError> {
		validate_identity(volume_id)?;
		let keys = self.keys.clone();
		let volume_id = volume_id.to_owned();
		self.database
			.txn("minisandbox_block_read_chunk", move |tx| {
				let keys = keys.clone();
				let volume_id = volume_id.clone();
				async move {
					check_authoritative_generation(&tx, &volume_id, writer_generation).await?;
					let state = load_state(&tx, &keys, &volume_id).await?;
					check_generation(&state, writer_generation)?;
					if state.initialization != 2 {
						return Err(anyhow!(FdbBlockMetaStoreError::NotReady));
					}
					if chunk_no >= state.logical_size / u64::try_from(CHUNK_BYTES).unwrap() {
						return Err(anyhow!(FdbBlockMetaStoreError::InvalidArgument));
					}
					load_chunk_snapshot(&tx, &keys, &volume_id, writer_generation, chunk_no).await
				}
			})
			.await
			.map_err(map_transaction_error)
	}

	/// Bulk-loads all cold references and hot overrides for one admitted writer.
	///
	/// This is the only FDB read required to construct the normal guest read
	/// plane. The returned manifest is a transactionally consistent recovery
	/// point and may be materialized lazily from local cache or COS afterward.
	pub async fn recover_volume(
		&self,
		volume_id: &str,
		writer_generation: u64,
	) -> Result<VolumeRecovery, FdbBlockMetaStoreError> {
		validate_identity(volume_id)?;
		let keys = self.keys.clone();
		let volume_id = volume_id.to_owned();
		self.database
			.txn("minisandbox_block_recover", move |tx| {
				let keys = keys.clone();
				let volume_id = volume_id.clone();
				async move {
					check_authoritative_generation(&tx, &volume_id, writer_generation).await?;
					let state = load_state(&tx, &keys, &volume_id).await?;
					check_generation(&state, writer_generation)?;
					if state.initialization != 2 {
						return Err(anyhow!(FdbBlockMetaStoreError::NotReady));
					}
					let max_chunks = state.logical_size / u64::try_from(CHUNK_BYTES).unwrap();
					let mut chunks = BTreeMap::<u64, ChunkSnapshot>::new();

					let chunk_prefix = keys.chunk_prefix(&volume_id);
					let mut cold_rows = tx.get_ranges_keyvalues(
						RangeOption {
							mode: StreamingMode::WantAll,
							..RangeOption::from(range_for_prefix(&chunk_prefix))
						},
						Serializable,
					);
					while let Some(entry) = cold_rows.try_next().await? {
						let chunk_no = decode_indexed_key(&keys, entry.key(), &volume_id, "chunk")?;
						if chunk_no >= max_chunks {
							return Err(anyhow!(FdbBlockMetaStoreError::CorruptState));
						}
						let base_hash =
							ChunkHash::from_bytes(decode_chunk_ref(entry.value())?.hash);
						chunks.insert(
							chunk_no,
							ChunkSnapshot {
								volume_id: volume_id.clone(),
								writer_generation,
								chunk_no,
								base_hash: Some(base_hash),
								hot_pages: Vec::new(),
							},
						);
					}

					let hot_prefix = keys.hot_prefix(&volume_id);
					let mut hot_rows = tx.get_ranges_keyvalues(
						RangeOption {
							mode: StreamingMode::WantAll,
							..RangeOption::from(range_for_prefix(&hot_prefix))
						},
						Serializable,
					);
					while let Some(entry) = hot_rows.try_next().await? {
						let block_no = decode_indexed_key(&keys, entry.key(), &volume_id, "hot")?;
						let chunk_no = block_no / PAGES_PER_CHUNK;
						if chunk_no >= max_chunks {
							return Err(anyhow!(FdbBlockMetaStoreError::CorruptState));
						}
						let page = decode_hot_page(entry.value())?;
						validate_hot_page(&page)?;
						chunks
							.entry(chunk_no)
							.or_insert_with(|| ChunkSnapshot {
								volume_id: volume_id.clone(),
								writer_generation,
								chunk_no,
								base_hash: None,
								hot_pages: Vec::new(),
							})
							.hot_pages
							.push(HotPage {
								block_no,
								sequence: page.sequence,
								bytes: page.bytes,
							});
					}

					Ok(VolumeRecovery {
						state: state.public()?,
						chunks,
					})
				}
			})
			.await
			.map_err(map_transaction_error)
	}

	async fn next_dirty_chunk(
		&self,
		volume_id: &str,
		writer_generation: u64,
	) -> Result<Option<u64>, FdbBlockMetaStoreError> {
		validate_identity(volume_id)?;
		let keys = self.keys.clone();
		let volume_id = volume_id.to_owned();
		self.database
			.txn("minisandbox_block_next_dirty", move |tx| {
				let keys = keys.clone();
				let volume_id = volume_id.clone();
				async move {
					check_authoritative_generation(&tx, &volume_id, writer_generation).await?;
					let state = load_state(&tx, &keys, &volume_id).await?;
					check_generation(&state, writer_generation)?;
					let prefix = keys.dirty_prefix(&volume_id);
					let mut rows = tx.get_ranges_keyvalues(
						RangeOption {
							mode: StreamingMode::Iterator,
							limit: Some(1),
							..RangeOption::from(range_for_prefix(&prefix))
						},
						Serializable,
					);
					rows.try_next()
						.await?
						.map(|entry| decode_dirty(entry.value()).map(|record| record.chunk_no))
						.transpose()
				}
			})
			.await
			.map_err(map_transaction_error)
	}

	async fn prepare_writeback(
		&self,
		volume_id: &str,
		writer_generation: u64,
		chunk_no: u64,
	) -> Result<ChunkSnapshot, FdbBlockMetaStoreError> {
		self.read_chunk_snapshot(volume_id, writer_generation, chunk_no)
			.await
	}

	async fn commit_writeback(
		&self,
		snapshot: ChunkSnapshot,
		hash: Option<ChunkHash>,
	) -> Result<WritebackCommit, FdbBlockMetaStoreError> {
		let keys = self.keys.clone();
		self.database
			.txn("minisandbox_block_publish_chunk", move |tx| {
				let keys = keys.clone();
				let snapshot = snapshot.clone();
				async move {
					check_authoritative_generation(
						&tx,
						&snapshot.volume_id,
						snapshot.writer_generation,
					)
					.await?;
					let mut state = load_state(&tx, &keys, &snapshot.volume_id).await?;
					check_generation(&state, snapshot.writer_generation)?;
					let dirty_key = keys.dirty(&snapshot.volume_id, snapshot.chunk_no);
					if tx.get(&dirty_key, Serializable).await?.is_none() {
						// A complete discard (or another successful settlement) won the
						// race. Never resurrect its removed cold reference.
						return Ok(WritebackCommit {
							published: false,
							cleared_pages: Vec::new(),
						});
					}
					let current_pages = load_hot_pages_for_chunk(
						&tx,
						&keys,
						&snapshot.volume_id,
						snapshot.chunk_no,
					)
					.await?;
					let current_by_block = current_pages
						.into_iter()
						.map(|page| (page.block_no, page))
						.collect::<BTreeMap<_, _>>();
					let mut cleared_pages = Vec::new();
					for page in &snapshot.hot_pages {
						if current_by_block
							.get(&page.block_no)
							.is_some_and(|current| current.sequence == page.sequence)
						{
							tx.clear(&keys.hot(&snapshot.volume_id, page.block_no));
							cleared_pages.push(page.clone());
						}
					}
					let has_newer = current_by_block.len() > cleared_pages.len();
					let chunk_key = keys.chunk(&snapshot.volume_id, snapshot.chunk_no);
					if let Some(hash) = hash {
						tx.set(
							&chunk_key,
							&encode_chunk_ref(ChunkRefRecord {
								hash: *hash.as_bytes(),
							})?,
						);
					} else {
						tx.clear(&chunk_key);
					}
					if has_newer {
						tx.set(
							&dirty_key,
							&encode_dirty(DirtyRecord {
								chunk_no: snapshot.chunk_no,
							})?,
						);
					} else {
						tx.clear(&dirty_key);
					}
					state.hot_bytes = state.hot_bytes.saturating_sub(
						u64::try_from(cleared_pages.len())
							.unwrap_or(u64::MAX)
							.saturating_mul(u64::try_from(PAGE_BYTES).unwrap()),
					);
					tx.set(&keys.state(&snapshot.volume_id), &encode_volume(state)?);
					Ok(WritebackCommit {
						published: true,
						cleared_pages,
					})
				}
			})
			.await
			.map_err(map_transaction_error)
	}
}

/// Opens the live FoundationDB implementation used by sbxlet.
#[cfg(feature = "foundationdb")]
pub fn open_foundationdb_metastore(
	cluster_file: Option<PathBuf>,
	root_prefix: impl Into<Vec<u8>>,
	max_hot_bytes: u64,
) -> Result<FdbBlockMetaStore, FdbBlockMetaStoreError> {
	use universaldb::driver::{FoundationDbConfig, FoundationDbDatabaseDriver};

	let driver = FoundationDbDatabaseDriver::new(FoundationDbConfig { cluster_file })
		.map_err(FdbBlockMetaStoreError::unavailable)?;
	FdbBlockMetaStore::new(Database::new(Arc::new(driver)), root_prefix, max_hot_bytes)
}

/// Loads the bounded non-zero 4 KiB pages of one trusted sparse filesystem template.
pub fn load_sparse_template_pages<R: Read>(
	logical_size: u64,
	reader: &mut R,
) -> Result<Vec<PageMutation>, FdbBlockMetaStoreError> {
	if logical_size == 0 || !logical_size.is_multiple_of(u64::try_from(CHUNK_BYTES).unwrap()) {
		return Err(FdbBlockMetaStoreError::InvalidArgument);
	}
	let page_count = logical_size / u64::try_from(PAGE_BYTES).unwrap();
	let mut pages = Vec::new();
	let mut buffer = vec![0; PAGE_BYTES];
	for block_no in 0..page_count {
		reader
			.read_exact(&mut buffer)
			.map_err(FdbBlockMetaStoreError::unavailable)?;
		if buffer.iter().all(|byte| *byte == 0) {
			continue;
		}
		pages.push(PageMutation {
			block_no,
			bytes: Some(buffer.clone()),
		});
		if pages.len() > MAX_PAGE_MUTATIONS {
			return Err(FdbBlockMetaStoreError::TemplateTooLarge {
				pages: pages.len(),
				max: MAX_PAGE_MUTATIONS,
			});
		}
	}
	Ok(pages)
}

/// One successfully published cold base and the exact hot versions it replaced.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WritebackSettlement {
	/// Settled chunk number.
	pub chunk_no: u64,
	/// Newly published immutable base, absent when the chunk became all-zero.
	pub base_hash: Option<ChunkHash>,
	/// Exact hot-page versions removed by the publish transaction.
	pub cleared_pages: Vec<HotPage>,
}

/// Result of one bounded FDB-to-COS writeback pass.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WritebackReport {
	/// Settled chunk number, absent when the volume was already clean.
	pub chunk_no: Option<u64>,
	/// Hot pages removed after exact sequence comparison.
	pub cleared_pages: u64,
	/// Local read-plane update, absent when a discard won the publish race.
	pub settlement: Option<WritebackSettlement>,
}

/// Settles at most one dirty 4 MiB range and never blocks the guest write ACK path.
pub async fn settle_one_chunk<S: ChunkStore>(
	metadata: &FdbBlockMetaStore,
	chunks: &S,
	volume_id: &str,
	writer_generation: u64,
) -> Result<WritebackReport, FdbBlockMetaStoreError> {
	let Some(prepared) =
		prepare_one_settlement(metadata, chunks, volume_id, writer_generation).await?
	else {
		return Ok(clean_writeback_report());
	};
	let commit = metadata
		.commit_writeback(prepared.snapshot, prepared.new_hash)
		.await?;
	writeback_report(prepared.chunk_no, prepared.new_hash, commit)
}

/// Settles one chunk while serializing only its final FDB mutation with guest
/// WRITE and DISCARD commits. COS transfer remains outside the coordinator.
pub async fn settle_one_chunk_coordinated<S: ChunkStore>(
	metadata: &FdbBlockMetaStore,
	chunks: &S,
	volume_id: &str,
	writer_generation: u64,
	coordinator: &tokio::sync::Mutex<()>,
) -> Result<WritebackReport, FdbBlockMetaStoreError> {
	let Some(prepared) =
		prepare_one_settlement(metadata, chunks, volume_id, writer_generation).await?
	else {
		return Ok(clean_writeback_report());
	};
	let _mutation = coordinator.lock().await;
	let commit = metadata
		.commit_writeback(prepared.snapshot, prepared.new_hash)
		.await?;
	writeback_report(prepared.chunk_no, prepared.new_hash, commit)
}

struct PreparedSettlement {
	chunk_no: u64,
	snapshot: ChunkSnapshot,
	new_hash: Option<ChunkHash>,
}

async fn prepare_one_settlement<S: ChunkStore>(
	metadata: &FdbBlockMetaStore,
	chunks: &S,
	volume_id: &str,
	writer_generation: u64,
) -> Result<Option<PreparedSettlement>, FdbBlockMetaStoreError> {
	let Some(chunk_no) = metadata
		.next_dirty_chunk(volume_id, writer_generation)
		.await?
	else {
		return Ok(None);
	};
	let snapshot = metadata
		.prepare_writeback(volume_id, writer_generation, chunk_no)
		.await?;
	let mut bytes = match snapshot.base_hash {
		Some(hash) => chunks
			.get_chunk(hash)
			.await
			.map_err(map_chunk_error)?
			.to_vec(),
		None => vec![0; CHUNK_BYTES],
	};
	let first_block = chunk_no.saturating_mul(PAGES_PER_CHUNK);
	for page in &snapshot.hot_pages {
		let page_offset = page
			.block_no
			.checked_sub(first_block)
			.and_then(|offset| usize::try_from(offset).ok())
			.and_then(|offset| offset.checked_mul(PAGE_BYTES))
			.ok_or(FdbBlockMetaStoreError::CorruptState)?;
		let page_end = page_offset
			.checked_add(PAGE_BYTES)
			.ok_or(FdbBlockMetaStoreError::CorruptState)?;
		let destination = bytes
			.get_mut(page_offset..page_end)
			.ok_or(FdbBlockMetaStoreError::CorruptState)?;
		match &page.bytes {
			Some(source) => destination.copy_from_slice(source),
			None => destination.fill(0),
		}
	}
	let new_hash = if bytes.iter().all(|byte| *byte == 0) {
		None
	} else {
		let hash = ChunkHash::for_chunk(&bytes).map_err(FdbBlockMetaStoreError::unavailable)?;
		chunks
			.put_chunk(hash, &bytes)
			.await
			.map_err(map_chunk_error)?;
		chunks.verify_chunk(hash).await.map_err(map_chunk_error)?;
		Some(hash)
	};
	Ok(Some(PreparedSettlement {
		chunk_no,
		snapshot,
		new_hash,
	}))
}

fn clean_writeback_report() -> WritebackReport {
	WritebackReport {
		chunk_no: None,
		cleared_pages: 0,
		settlement: None,
	}
}

fn writeback_report(
	chunk_no: u64,
	new_hash: Option<ChunkHash>,
	commit: WritebackCommit,
) -> Result<WritebackReport, FdbBlockMetaStoreError> {
	let cleared_pages =
		u64::try_from(commit.cleared_pages.len()).map_err(FdbBlockMetaStoreError::unavailable)?;
	let settlement = commit.published.then_some(WritebackSettlement {
		chunk_no,
		base_hash: new_hash,
		cleared_pages: commit.cleared_pages,
	});
	Ok(WritebackReport {
		chunk_no: Some(chunk_no),
		cleared_pages,
		settlement,
	})
}

struct WritebackCommit {
	published: bool,
	cleared_pages: Vec<HotPage>,
}

async fn load_state(
	tx: &universaldb::Transaction,
	keys: &NativeKeys,
	volume_id: &str,
) -> AnyResult<VolumeRecord> {
	let bytes = tx
		.get(&keys.state(volume_id), Serializable)
		.await?
		.ok_or_else(|| anyhow!(FdbBlockMetaStoreError::InvalidArgument))?;
	decode_volume(&bytes)
}

fn authoritative_generation_key(actor_id: &str) -> AnyResult<Vec<u8>> {
	let actor_id = rivet_util_id::Id::parse(actor_id)?;
	Ok(universaldb::utils::Subspace::new(&(RIVET, PEGBOARD))
		.pack(&(ACTOR, DATA, actor_id, GENERATION)))
}

async fn check_authoritative_generation(
	tx: &universaldb::Transaction,
	actor_id: &str,
	writer_generation: u64,
) -> AnyResult<()> {
	let expected = u32::try_from(writer_generation)
		.map_err(|_| anyhow!(FdbBlockMetaStoreError::InvalidArgument))?;
	let bytes = tx
		.get(&authoritative_generation_key(actor_id)?, Serializable)
		.await?
		.ok_or_else(|| anyhow!(FdbBlockMetaStoreError::StaleWriter))?;
	let authoritative = u32::from_be_bytes(
		bytes
			.as_slice()
			.try_into()
			.map_err(|_| anyhow!(FdbBlockMetaStoreError::CorruptState))?,
	);
	if authoritative != expected {
		return Err(anyhow!(FdbBlockMetaStoreError::StaleWriter));
	}
	Ok(())
}

async fn load_chunk_snapshot(
	tx: &universaldb::Transaction,
	keys: &NativeKeys,
	volume_id: &str,
	writer_generation: u64,
	chunk_no: u64,
) -> AnyResult<ChunkSnapshot> {
	let base_hash = match tx
		.get(&keys.chunk(volume_id, chunk_no), Serializable)
		.await?
	{
		Some(bytes) => Some(ChunkHash::from_bytes(decode_chunk_ref(&bytes)?.hash)),
		None => None,
	};
	let hot_pages = load_hot_pages_for_chunk(tx, keys, volume_id, chunk_no).await?;
	Ok(ChunkSnapshot {
		volume_id: volume_id.to_owned(),
		writer_generation,
		chunk_no,
		base_hash,
		hot_pages,
	})
}

async fn load_hot_pages_for_chunk(
	tx: &universaldb::Transaction,
	keys: &NativeKeys,
	volume_id: &str,
	chunk_no: u64,
) -> AnyResult<Vec<HotPage>> {
	let first_block = chunk_no.saturating_mul(PAGES_PER_CHUNK);
	let mut hot_pages = Vec::new();
	let hot_begin = keys.hot(volume_id, first_block);
	let hot_end = keys.hot(volume_id, first_block.saturating_add(PAGES_PER_CHUNK));
	let mut rows = tx.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::WantAll,
			..RangeOption::from((hot_begin, hot_end))
		},
		Serializable,
	);
	while let Some(entry) = rows.try_next().await? {
		let block_no = decode_indexed_key(keys, entry.key(), volume_id, "hot")?;
		if block_no < first_block || block_no >= first_block.saturating_add(PAGES_PER_CHUNK) {
			return Err(anyhow!(FdbBlockMetaStoreError::CorruptState));
		}
		let page = decode_hot_page(entry.value())?;
		validate_hot_page(&page)?;
		hot_pages.push(HotPage {
			block_no,
			sequence: page.sequence,
			bytes: page.bytes,
		});
	}
	Ok(hot_pages)
}

fn decode_indexed_key(
	keys: &NativeKeys,
	key: &[u8],
	volume_id: &str,
	kind: &str,
) -> AnyResult<u64> {
	let (volume_tag, stored_volume_id, stored_kind, index): (String, String, String, u64) =
		keys.root.unpack(key)?;
	if volume_tag != "v" || stored_volume_id != volume_id || stored_kind != kind {
		return Err(anyhow!(FdbBlockMetaStoreError::CorruptState));
	}
	Ok(index)
}

fn validate_identity(value: &str) -> Result<(), FdbBlockMetaStoreError> {
	if value.is_empty()
		|| value.len() > MAX_IDENTIFIER_BYTES
		|| !value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
	{
		return Err(FdbBlockMetaStoreError::InvalidArgument);
	}
	Ok(())
}

fn validate_page_mutations(pages: &[PageMutation]) -> Result<(), FdbBlockMetaStoreError> {
	if pages.is_empty() || pages.len() > MAX_PAGE_MUTATIONS {
		return Err(FdbBlockMetaStoreError::InvalidArgument);
	}
	let mut previous = None;
	for page in pages {
		if page
			.bytes
			.as_ref()
			.is_some_and(|bytes| bytes.len() != PAGE_BYTES)
			|| previous.is_some_and(|previous| page.block_no <= previous)
		{
			return Err(FdbBlockMetaStoreError::InvalidArgument);
		}
		previous = Some(page.block_no);
	}
	Ok(())
}

fn validate_initial_pages(pages: &[PageMutation]) -> Result<(), FdbBlockMetaStoreError> {
	if pages.len() > MAX_PAGE_MUTATIONS {
		return Err(FdbBlockMetaStoreError::TemplateTooLarge {
			pages: pages.len(),
			max: MAX_PAGE_MUTATIONS,
		});
	}
	let mut previous = None;
	for page in pages {
		if page
			.bytes
			.as_ref()
			.is_none_or(|bytes| bytes.len() != PAGE_BYTES)
			|| previous.is_some_and(|previous| page.block_no <= previous)
		{
			return Err(FdbBlockMetaStoreError::InvalidArgument);
		}
		previous = Some(page.block_no);
	}
	Ok(())
}

fn validate_chunk_discards(chunk_nos: &[u64]) -> Result<(), FdbBlockMetaStoreError> {
	if chunk_nos.is_empty() || chunk_nos.len() > MAX_CHUNK_DISCARDS {
		return Err(FdbBlockMetaStoreError::InvalidArgument);
	}
	let mut previous = None;
	for chunk_no in chunk_nos {
		if previous.is_some_and(|previous| *chunk_no != previous + 1) {
			return Err(FdbBlockMetaStoreError::InvalidArgument);
		}
		previous = Some(*chunk_no);
	}
	Ok(())
}

fn validate_hot_page(page: &HotPageRecord) -> AnyResult<()> {
	if page.sequence == 0
		|| page
			.bytes
			.as_ref()
			.is_some_and(|bytes| bytes.len() != PAGE_BYTES)
	{
		return Err(anyhow!(FdbBlockMetaStoreError::CorruptState));
	}
	Ok(())
}

fn check_generation(record: &VolumeRecord, generation: u64) -> AnyResult<()> {
	if generation == 0 || record.writer_generation != generation {
		return Err(anyhow!(FdbBlockMetaStoreError::StaleWriter));
	}
	Ok(())
}

fn page_fingerprint(
	volume_id: &str,
	generation: u64,
	op_id: &str,
	pages: &[PageMutation],
) -> [u8; 32] {
	let mut hash = Sha256::new();
	hash.update(b"minisandbox/native-block/write/v1\0");
	hash.update(volume_id.as_bytes());
	hash.update(generation.to_be_bytes());
	hash.update(op_id.as_bytes());
	for page in pages {
		hash.update(page.block_no.to_be_bytes());
		match &page.bytes {
			Some(bytes) => {
				hash.update([1]);
				hash.update(bytes);
			}
			None => hash.update([0]),
		}
	}
	hash.finalize().into()
}

fn discard_fingerprint(
	volume_id: &str,
	generation: u64,
	op_id: &str,
	chunk_nos: &[u64],
) -> [u8; 32] {
	let mut hash = Sha256::new();
	hash.update(b"minisandbox/native-block/discard-chunks/v1\0");
	hash.update(volume_id.as_bytes());
	hash.update(generation.to_be_bytes());
	hash.update(op_id.as_bytes());
	for chunk_no in chunk_nos {
		hash.update(chunk_no.to_be_bytes());
	}
	hash.finalize().into()
}

fn map_transaction_error(error: anyhow::Error) -> FdbBlockMetaStoreError {
	error
		.chain()
		.find_map(|cause| cause.downcast_ref::<FdbBlockMetaStoreError>())
		.cloned()
		.unwrap_or_else(|| FdbBlockMetaStoreError::unavailable(error))
}

fn map_chunk_error(error: ChunkStoreError) -> FdbBlockMetaStoreError {
	FdbBlockMetaStoreError::unavailable(error)
}

macro_rules! codec {
	($encode:ident, $decode:ident, $versioned:ident, $record:ty) => {
		fn $encode(record: $record) -> AnyResult<Vec<u8>> {
			$versioned::wrap_latest(record).serialize_with_embedded_version(FORMAT_VERSION)
		}

		fn $decode(bytes: &[u8]) -> AnyResult<$record> {
			$versioned::deserialize_with_embedded_version(bytes)
		}
	};
}

codec!(
	encode_volume,
	decode_volume,
	VersionedVolumeRecord,
	VolumeRecord
);
codec!(
	encode_hot_page,
	decode_hot_page,
	VersionedHotPageRecord,
	HotPageRecord
);
codec!(
	encode_chunk_ref,
	decode_chunk_ref,
	VersionedChunkRefRecord,
	ChunkRefRecord
);
codec!(
	encode_operation_result,
	decode_operation_result,
	VersionedOperationResultRecord,
	OperationResultRecord
);
codec!(
	encode_dirty,
	decode_dirty,
	VersionedDirtyRecord,
	DirtyRecord
);

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicUsize, Ordering};

	use async_trait::async_trait;
	use tempfile::tempdir;
	use universaldb::driver::RocksDbDatabaseDriver;

	use super::*;

	#[derive(Default)]
	struct MemoryChunkStore {
		objects: tokio::sync::Mutex<std::collections::BTreeMap<ChunkHash, Arc<[u8]>>>,
		puts: AtomicUsize,
	}

	#[async_trait]
	impl ChunkStore for MemoryChunkStore {
		async fn put_chunk(&self, hash: ChunkHash, bytes: &[u8]) -> Result<(), ChunkStoreError> {
			self.puts.fetch_add(1, Ordering::Relaxed);
			self.objects
				.lock()
				.await
				.insert(hash, bytes.to_vec().into());
			Ok(())
		}

		async fn get_chunk(&self, hash: ChunkHash) -> Result<Arc<[u8]>, ChunkStoreError> {
			self.objects
				.lock()
				.await
				.get(&hash)
				.cloned()
				.ok_or(ChunkStoreError::NotFound)
		}

		async fn delete_chunk(&self, hash: ChunkHash) -> Result<(), ChunkStoreError> {
			self.objects.lock().await.remove(&hash);
			Ok(())
		}
	}

	async fn metadata() -> (tempfile::TempDir, FdbBlockMetaStore, String) {
		let directory = tempdir().unwrap();
		let driver = RocksDbDatabaseDriver::new(directory.path().to_path_buf())
			.await
			.unwrap();
		let database = Database::new(Arc::new(driver));
		let metadata =
			FdbBlockMetaStore::new(database, b"native-block-test/".to_vec(), 1024 * 1024).unwrap();
		let actor_id = rivet_util_id::Id::new_v1(1).to_string();
		set_generation(&metadata, &actor_id, 1).await;
		(directory, metadata, actor_id)
	}

	async fn set_generation(metadata: &FdbBlockMetaStore, actor_id: &str, generation: u32) {
		let key = authoritative_generation_key(actor_id).unwrap();
		metadata
			.database
			.txn("test_block_generation", move |tx| {
				let key = key.clone();
				async move {
					tx.set(&key, &generation.to_be_bytes());
					Ok(())
				}
			})
			.await
			.unwrap();
	}

	async fn operation_count(
		metadata: &FdbBlockMetaStore,
		actor_id: &str,
		generation: u64,
	) -> usize {
		let prefix = metadata.keys.operation_prefix(actor_id, generation);
		metadata
			.database
			.txn("test_block_operation_count", move |tx| {
				let prefix = prefix.clone();
				async move {
					let mut rows = tx.get_ranges_keyvalues(
						RangeOption {
							mode: StreamingMode::WantAll,
							..RangeOption::from(range_for_prefix(&prefix))
						},
						Serializable,
					);
					let mut count = 0;
					while rows.try_next().await?.is_some() {
						count += 1;
					}
					Ok(count)
				}
			})
			.await
			.unwrap()
	}

	async fn initialize_empty(metadata: &FdbBlockMetaStore, actor_id: &str, generation: u64) {
		metadata
			.initialize_hot_pages(actor_id, generation, &[])
			.await
			.unwrap();
	}

	#[tokio::test]
	async fn template_stages_in_fdb_without_cos_and_marks_ready_atomically() {
		let (_directory, metadata, actor_id) = metadata().await;
		let chunks = MemoryChunkStore::default();
		set_generation(&metadata, &actor_id, 7).await;
		metadata
			.open_volume(
				&actor_id,
				u64::try_from(3 * CHUNK_BYTES).unwrap(),
				7,
				"ext4-v1",
			)
			.await
			.unwrap();
		let mut image = vec![0; 3 * CHUNK_BYTES];
		let template_bytes = 128 * 1024;
		image[CHUNK_BYTES..CHUNK_BYTES + template_bytes].fill(0x5a);
		let pages =
			load_sparse_template_pages(u64::try_from(image.len()).unwrap(), &mut image.as_slice())
				.unwrap();
		assert_eq!(pages.len(), template_bytes / PAGE_BYTES);
		let initialized = metadata
			.initialize_hot_pages(&actor_id, 7, &pages)
			.await
			.unwrap();
		assert_eq!(initialized.initialization, VolumeInitializationState::Ready);
		assert_eq!(
			initialized.hot_bytes,
			u64::try_from(template_bytes).unwrap()
		);
		assert_eq!(chunks.puts.load(Ordering::Relaxed), 0);
		let replay = metadata
			.initialize_hot_pages(&actor_id, 7, &pages)
			.await
			.unwrap();
		assert_eq!(replay, initialized);
		let state = metadata
			.open_volume(
				&actor_id,
				u64::try_from(3 * CHUNK_BYTES).unwrap(),
				7,
				"ext4-v1",
			)
			.await
			.unwrap();
		assert_eq!(state.initialization, VolumeInitializationState::Ready);
		assert_eq!(state.hot_bytes, u64::try_from(template_bytes).unwrap());
		let recovery = metadata.recover_volume(&actor_id, 7).await.unwrap();
		assert_eq!(recovery.state, state);
		assert_eq!(recovery.chunks.len(), 1);
		let recovered = recovery.chunks.get(&1).unwrap();
		assert!(recovered.base_hash.is_none());
		assert_eq!(recovered.hot_pages.len(), template_bytes / PAGE_BYTES);
	}

	#[tokio::test]
	async fn acknowledged_hot_page_settles_to_one_authenticated_chunk() {
		let (_directory, metadata, actor_id) = metadata().await;
		let chunks = MemoryChunkStore::default();
		set_generation(&metadata, &actor_id, 3).await;
		metadata
			.open_volume(
				&actor_id,
				u64::try_from(2 * CHUNK_BYTES).unwrap(),
				3,
				"ext4-v1",
			)
			.await
			.unwrap();
		initialize_empty(&metadata, &actor_id, 3).await;
		metadata
			.write_pages(
				&actor_id,
				3,
				"write-1",
				vec![PageMutation {
					block_no: 5,
					bytes: Some(vec![0xa7; PAGE_BYTES]),
				}],
			)
			.await
			.unwrap();
		let before = metadata.read_chunk_snapshot(&actor_id, 3, 0).await.unwrap();
		assert_eq!(before.hot_pages.len(), 1);
		let report = settle_one_chunk(&metadata, &chunks, &actor_id, 3)
			.await
			.unwrap();
		assert_eq!(report.cleared_pages, 1);
		let settlement = report.settlement.unwrap();
		assert_eq!(settlement.chunk_no, 0);
		assert_eq!(settlement.cleared_pages, before.hot_pages);
		let after = metadata.read_chunk_snapshot(&actor_id, 3, 0).await.unwrap();
		assert!(after.hot_pages.is_empty());
		let bytes = chunks.get_chunk(after.base_hash.unwrap()).await.unwrap();
		assert_eq!(&bytes[5 * PAGE_BYTES..6 * PAGE_BYTES], &[0xa7; PAGE_BYTES]);
		let recovery = metadata.recover_volume(&actor_id, 3).await.unwrap();
		assert_eq!(recovery.chunks.get(&0).unwrap().base_hash, after.base_hash);
		assert!(recovery.chunks.get(&0).unwrap().hot_pages.is_empty());
	}

	#[tokio::test]
	async fn complete_chunk_discard_releases_hot_and_cold_without_resurrection() {
		let (_directory, metadata, actor_id) = metadata().await;
		let chunks = MemoryChunkStore::default();
		metadata
			.open_volume(&actor_id, u64::try_from(CHUNK_BYTES).unwrap(), 1, "ext4-v1")
			.await
			.unwrap();
		let initial_pages = vec![PageMutation {
			block_no: 0,
			bytes: Some(vec![0x28; PAGE_BYTES]),
		}];
		metadata
			.initialize_hot_pages(&actor_id, 1, &initial_pages)
			.await
			.unwrap();
		let mut cold_bytes = vec![0; CHUNK_BYTES];
		cold_bytes[..PAGE_BYTES].fill(0x28);
		let cold_hash = ChunkHash::for_chunk(&cold_bytes).unwrap();
		settle_one_chunk(&metadata, &chunks, &actor_id, 1)
			.await
			.unwrap();
		metadata
			.write_pages(
				&actor_id,
				1,
				"write-before-discard",
				vec![PageMutation {
					block_no: 2,
					bytes: Some(vec![0x31; PAGE_BYTES]),
				}],
			)
			.await
			.unwrap();
		let stale_snapshot = metadata.prepare_writeback(&actor_id, 1, 0).await.unwrap();

		metadata
			.discard_chunks(&actor_id, 1, "discard-1", vec![0])
			.await
			.unwrap();
		let after = metadata.read_chunk_snapshot(&actor_id, 1, 0).await.unwrap();
		assert!(after.base_hash.is_none());
		assert!(after.hot_pages.is_empty());
		assert_eq!(
			metadata
				.open_volume(&actor_id, u64::try_from(CHUNK_BYTES).unwrap(), 1, "ext4-v1",)
				.await
				.unwrap()
				.hot_bytes,
			0
		);

		let commit = metadata
			.commit_writeback(stale_snapshot, Some(cold_hash))
			.await
			.unwrap();
		assert!(!commit.published);
		assert!(commit.cleared_pages.is_empty());
		let final_snapshot = metadata.read_chunk_snapshot(&actor_id, 1, 0).await.unwrap();
		assert!(final_snapshot.base_hash.is_none());
		assert!(final_snapshot.hot_pages.is_empty());
	}

	#[test]
	fn one_mib_page_batch_matches_the_virtio_request_limit() {
		let pages = (0..MAX_PAGE_MUTATIONS)
			.map(|block_no| PageMutation {
				block_no: u64::try_from(block_no).unwrap(),
				bytes: None,
			})
			.collect::<Vec<_>>();
		assert!(validate_page_mutations(&pages).is_ok());
		let mut too_many = pages;
		too_many.push(PageMutation {
			block_no: u64::try_from(MAX_PAGE_MUTATIONS).unwrap(),
			bytes: None,
		});
		assert!(matches!(
			validate_page_mutations(&too_many),
			Err(FdbBlockMetaStoreError::InvalidArgument)
		));
	}

	#[test]
	fn template_loader_rejects_more_than_one_bounded_transaction() {
		let logical_size = 9 * CHUNK_BYTES;
		let mut image = vec![0; logical_size];
		image[..(MAX_PAGE_MUTATIONS + 1) * PAGE_BYTES].fill(0x4f);
		assert!(matches!(
			load_sparse_template_pages(
				u64::try_from(logical_size).unwrap(),
				&mut image.as_slice()
			),
			Err(FdbBlockMetaStoreError::TemplateTooLarge {
				pages,
				max: MAX_PAGE_MUTATIONS,
			}) if pages == MAX_PAGE_MUTATIONS + 1
		));
	}

	#[tokio::test]
	async fn generation_fence_rejects_stale_writer() {
		let (_directory, metadata, actor_id) = metadata().await;
		metadata
			.open_volume(&actor_id, u64::try_from(CHUNK_BYTES).unwrap(), 1, "ext4-v1")
			.await
			.unwrap();
		set_generation(&metadata, &actor_id, 5).await;
		metadata
			.open_volume(&actor_id, u64::try_from(CHUNK_BYTES).unwrap(), 5, "ext4-v1")
			.await
			.unwrap();
		assert!(matches!(
			metadata.initialize_hot_pages(&actor_id, 1, &[]).await,
			Err(FdbBlockMetaStoreError::StaleWriter)
		));
	}

	#[tokio::test]
	async fn operation_id_is_idempotent_and_payload_bound() {
		let (_directory, metadata, actor_id) = metadata().await;
		metadata
			.open_volume(&actor_id, u64::try_from(CHUNK_BYTES).unwrap(), 1, "ext4-v1")
			.await
			.unwrap();
		initialize_empty(&metadata, &actor_id, 1).await;
		let mutation = PageMutation {
			block_no: 0,
			bytes: Some(vec![0x11; PAGE_BYTES]),
		};
		let first = metadata
			.write_pages(&actor_id, 1, "op-1", vec![mutation.clone()])
			.await
			.unwrap();
		let replay = metadata
			.write_pages(&actor_id, 1, "op-1", vec![mutation])
			.await
			.unwrap();
		assert_eq!(first, replay);
		assert!(matches!(
			metadata
				.write_pages(
					&actor_id,
					1,
					"op-1",
					vec![PageMutation {
						block_no: 0,
						bytes: Some(vec![0x22; PAGE_BYTES]),
					}],
				)
				.await,
			Err(FdbBlockMetaStoreError::CorruptState)
		));
		metadata
			.write_pages(
				&actor_id,
				1,
				"op-2",
				vec![PageMutation {
					block_no: 0,
					bytes: Some(vec![0x33; PAGE_BYTES]),
				}],
			)
			.await
			.unwrap();
		assert_eq!(operation_count(&metadata, &actor_id, 1).await, 1);
	}

	#[tokio::test]
	async fn hot_tier_bound_fails_closed() {
		let directory = tempdir().unwrap();
		let driver = RocksDbDatabaseDriver::new(directory.path().to_path_buf())
			.await
			.unwrap();
		let metadata = FdbBlockMetaStore::new(
			Database::new(Arc::new(driver)),
			b"native-block-bound-test/".to_vec(),
			u64::try_from(PAGE_BYTES).unwrap(),
		)
		.unwrap();
		let actor_id = rivet_util_id::Id::new_v1(1).to_string();
		set_generation(&metadata, &actor_id, 1).await;
		metadata
			.open_volume(&actor_id, u64::try_from(CHUNK_BYTES).unwrap(), 1, "ext4-v1")
			.await
			.unwrap();
		let initial_pages = vec![
			PageMutation {
				block_no: 0,
				bytes: Some(vec![1; PAGE_BYTES]),
			},
			PageMutation {
				block_no: 1,
				bytes: Some(vec![2; PAGE_BYTES]),
			},
		];
		assert!(matches!(
			metadata
				.initialize_hot_pages(&actor_id, 1, &initial_pages)
				.await,
			Err(FdbBlockMetaStoreError::HotTierFull)
		));
		let initializing = metadata
			.open_volume(&actor_id, u64::try_from(CHUNK_BYTES).unwrap(), 1, "ext4-v1")
			.await
			.unwrap();
		assert_eq!(
			initializing.initialization,
			VolumeInitializationState::Initializing
		);
		assert_eq!(initializing.hot_bytes, 0);
		metadata
			.initialize_hot_pages(&actor_id, 1, &initial_pages[..1])
			.await
			.unwrap();
		assert!(matches!(
			metadata
				.write_pages(
					&actor_id,
					1,
					"op-2",
					vec![PageMutation {
						block_no: 1,
						bytes: Some(vec![2; PAGE_BYTES]),
					}],
				)
				.await,
			Err(FdbBlockMetaStoreError::HotTierFull)
		));
	}

	struct BlockingVerifyStore {
		inner: MemoryChunkStore,
		uploaded: tokio::sync::Notify,
		release: tokio::sync::Notify,
		verifies: AtomicUsize,
	}

	#[async_trait]
	impl ChunkStore for BlockingVerifyStore {
		async fn put_chunk(&self, hash: ChunkHash, bytes: &[u8]) -> Result<(), ChunkStoreError> {
			self.inner.put_chunk(hash, bytes).await
		}

		async fn get_chunk(&self, hash: ChunkHash) -> Result<Arc<[u8]>, ChunkStoreError> {
			self.inner.get_chunk(hash).await
		}

		async fn verify_chunk(&self, hash: ChunkHash) -> Result<Arc<[u8]>, ChunkStoreError> {
			if self.verifies.fetch_add(1, Ordering::Relaxed) == 0 {
				self.uploaded.notify_one();
				self.release.notified().await;
			}
			self.inner.get_chunk(hash).await
		}

		async fn delete_chunk(&self, hash: ChunkHash) -> Result<(), ChunkStoreError> {
			self.inner.delete_chunk(hash).await
		}
	}

	#[tokio::test]
	async fn writeback_preserves_a_newer_hot_page() {
		let (_directory, metadata, actor_id) = metadata().await;
		let chunks = Arc::new(BlockingVerifyStore {
			inner: MemoryChunkStore::default(),
			uploaded: tokio::sync::Notify::new(),
			release: tokio::sync::Notify::new(),
			verifies: AtomicUsize::new(0),
		});
		metadata
			.open_volume(&actor_id, u64::try_from(CHUNK_BYTES).unwrap(), 1, "ext4-v1")
			.await
			.unwrap();
		initialize_empty(&metadata, &actor_id, 1).await;
		metadata
			.write_pages(
				&actor_id,
				1,
				"op-old",
				vec![PageMutation {
					block_no: 3,
					bytes: Some(vec![0x31; PAGE_BYTES]),
				}],
			)
			.await
			.unwrap();
		let settlement = tokio::spawn({
			let metadata = metadata.clone();
			let chunks = chunks.clone();
			let actor_id = actor_id.clone();
			async move { settle_one_chunk(&metadata, chunks.as_ref(), &actor_id, 1).await }
		});
		chunks.uploaded.notified().await;
		metadata
			.write_pages(
				&actor_id,
				1,
				"op-new",
				vec![PageMutation {
					block_no: 4,
					bytes: Some(vec![0x42; PAGE_BYTES]),
				}],
			)
			.await
			.unwrap();
		chunks.release.notify_one();
		settlement.await.unwrap().unwrap();

		let snapshot = metadata.read_chunk_snapshot(&actor_id, 1, 0).await.unwrap();
		assert_eq!(snapshot.hot_pages.len(), 1);
		assert_eq!(
			snapshot.hot_pages[0].bytes.as_deref(),
			Some(&[0x42; PAGE_BYTES][..])
		);
		settle_one_chunk(&metadata, chunks.as_ref(), &actor_id, 1)
			.await
			.unwrap();
		let settled = metadata.read_chunk_snapshot(&actor_id, 1, 0).await.unwrap();
		assert!(settled.hot_pages.is_empty());
		let bytes = chunks.get_chunk(settled.base_hash.unwrap()).await.unwrap();
		assert_eq!(&bytes[3 * PAGE_BYTES..4 * PAGE_BYTES], &[0x31; PAGE_BYTES]);
		assert_eq!(&bytes[4 * PAGE_BYTES..5 * PAGE_BYTES], &[0x42; PAGE_BYTES]);
	}
}
