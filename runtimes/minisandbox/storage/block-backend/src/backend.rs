use std::{
	path::Path,
	process,
	time::{SystemTime, UNIX_EPOCH},
};

use minisandbox_block_engine::{
	AcquireWriterOutcome, AcquireWriterRequest, BLOCK_SIZE, BlockEngine, BlockEngineError,
	BlockMetaRepository, BlockRepositoryConfig, BlockRepositoryError, CommitRangeWriteRequest,
	DeleteVolumeRequest, DeleteVolumeResult, DiscardRangeRequest, FlushRequest, MAX_WRITE_BYTES,
	ObjectStore, RangeWriteOutcome, RepositoryStats,
};
use minisandbox_cos_emulator::EmulatorError;
use thiserror::Error;

use crate::{
	EmulatorObjectStore, OnlineSettlerConfig, OnlineSettlerError, OnlineSettlerStats,
	online_settler::OnlineSettler,
};

const BLOCK_SIZE_USIZE: usize = 4 * 1024;

/// Typed storage-backend failures mapped to frontend-local I/O errors.
#[derive(Debug, Error)]
pub enum BackendError {
	/// Typed block-engine failure.
	#[error(transparent)]
	Engine(#[from] BlockEngineError),
	/// Repository setup or control-plane failure.
	#[error(transparent)]
	Repository(#[from] BlockRepositoryError),
	/// Local COS emulator setup failure.
	#[error(transparent)]
	Emulator(#[from] EmulatorError),
	/// The requested persistent volume has a different geometry.
	#[error("existing volume geometry does not match the requested block device")]
	GeometryMismatch,
	/// A writer epoch changed while the frontend was active.
	#[error("block frontend writer epoch was fenced")]
	StaleWriter,
	/// A request range overflowed or exceeded the volume.
	#[error("block request is outside the volume")]
	InvalidRange,
	/// A monotonic frontend operation counter overflowed.
	#[error("block frontend operation counter exhausted")]
	OperationCounterExhausted,
	/// Bounded settling did not reach a quiescent state.
	#[error("block settle pass limit was exhausted")]
	SettleLimitExceeded,
	/// The online settler was configured more than once for one frontend.
	#[error("block online settler is already configured")]
	OnlineSettlerAlreadyConfigured,
	/// Online hot-to-cold maintenance failed.
	#[error(transparent)]
	OnlineSettler(#[from] OnlineSettlerError),
}

/// A sparse block backend over one typed metadata repository and object store.
#[derive(Debug)]
pub struct SqliteBlockBackend<S = EmulatorObjectStore> {
	engine: BlockEngine<S>,
	volume_id: String,
	logical_size: u64,
	writer_epoch: u64,
	submitted_sequence: u64,
	operation_counter: u64,
	session_id: String,
	created: bool,
	settler_engine: Option<BlockEngine<S>>,
	online_settler: Option<OnlineSettler<S>>,
}

/// Cloneable factory that keeps one single-owner repository actor per factory.
///
/// Every backend created from one factory has an independent volume and writer
/// epoch, while all `SQLite` transactions pass through the same bounded actor
/// queue. This turns local `SQLite` writer contention into process-local
/// backpressure instead of competing `busy_timeout` windows.
#[derive(Clone, Debug)]
pub struct SqliteBlockBackendFactory<S = EmulatorObjectStore> {
	repository: BlockMetaRepository,
	store: S,
}

impl SqliteBlockBackendFactory<EmulatorObjectStore> {
	/// Opens and validates one `SQLite` repository and COS adapter.
	///
	/// # Errors
	///
	/// Returns a schema, durability, or emulator setup failure.
	pub fn open(database: &Path, cos_root: &Path) -> Result<Self, BackendError> {
		Ok(Self {
			repository: BlockMetaRepository::open(BlockRepositoryConfig::new(database))?,
			store: EmulatorObjectStore::open(cos_root)?,
		})
	}
}

impl<S> SqliteBlockBackendFactory<S>
where
	S: ObjectStore + Clone + Send + 'static,
{
	/// Creates a backend factory from production or test storage components.
	#[must_use]
	pub fn from_components(repository: BlockMetaRepository, store: S) -> Self {
		Self { repository, store }
	}

	/// Opens or creates one volume and acquires its next writer epoch.
	///
	/// # Errors
	///
	/// Returns a geometry, repository, or fencing error.
	pub fn open_volume(
		&self,
		volume_id: &str,
		logical_size: u64,
	) -> Result<SqliteBlockBackend<S>, BackendError> {
		self.open_volume_with_session(volume_id, logical_size, new_session_id()?)
	}

	fn open_volume_with_session(
		&self,
		volume_id: &str,
		logical_size: u64,
		session_id: String,
	) -> Result<SqliteBlockBackend<S>, BackendError> {
		SqliteBlockBackend::open_with_components(
			self.repository.clone(),
			self.store.clone(),
			volume_id,
			logical_size,
			session_id,
		)
	}

	/// Pins a volume's exact current layer and fences its previous writer.
	///
	/// # Errors
	///
	/// Returns a repository validation or durability error.
	pub fn snapshot_volume(&self, volume_id: &str, snapshot_id: &str) -> Result<u64, BackendError> {
		Ok(self
			.repository
			.create_snapshot(volume_id, snapshot_id)?
			.logical_size)
	}

	/// Creates a fresh logical volume sharing a pinned snapshot layer.
	///
	/// # Errors
	///
	/// Returns a repository validation or durability error.
	pub fn fork_snapshot(
		&self,
		snapshot_id: &str,
		child_volume_id: &str,
	) -> Result<u64, BackendError> {
		Ok(self
			.repository
			.fork_snapshot(snapshot_id, child_volume_id)?
			.volume
			.logical_size)
	}

	/// Releases one pinned snapshot.
	///
	/// # Errors
	///
	/// Returns a repository validation or durability error.
	pub fn delete_snapshot(&self, snapshot_id: &str) -> Result<(), BackendError> {
		self.repository.delete_snapshot(snapshot_id)?;
		Ok(())
	}

	/// Terminally retires one immutable volume incarnation.
	///
	/// # Errors
	///
	/// Returns a repository validation, fencing, or durability error.
	pub fn delete_volume(
		&self,
		volume_id: &str,
		op_id: &str,
	) -> Result<DeleteVolumeResult, BackendError> {
		Ok(self.repository.delete_volume(DeleteVolumeRequest {
			volume_id: volume_id.to_owned(),
			op_id: op_id.to_owned(),
		})?)
	}
}

impl SqliteBlockBackend<EmulatorObjectStore> {
	/// Opens or creates a sparse volume and acquires a fresh fencing epoch.
	///
	/// # Errors
	///
	/// Returns an explicit repository, emulator, geometry, or fencing error.
	pub fn open(
		database: &Path,
		cos_root: &Path,
		volume_id: &str,
		logical_size: u64,
	) -> Result<Self, BackendError> {
		SqliteBlockBackendFactory::open(database, cos_root)?.open_volume(volume_id, logical_size)
	}

	/// Pins the exact current volume layer for later O(1) forks.
	///
	/// The active data-plane writer must already be quiesced. Snapshot commit
	/// advances its epoch, deliberately fencing any accidental reuse.
	///
	/// # Errors
	///
	/// Returns a repository validation, availability, or durability error.
	pub fn snapshot_volume(
		database: &Path,
		volume_id: &str,
		snapshot_id: &str,
	) -> Result<u64, BackendError> {
		let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(database))?;
		let snapshot = repository.create_snapshot(volume_id, snapshot_id)?;
		Ok(snapshot.logical_size)
	}

	/// Creates a fresh logical volume sharing one pinned snapshot layer.
	///
	/// # Errors
	///
	/// Returns a repository validation, availability, or durability error.
	pub fn fork_snapshot(
		database: &Path,
		snapshot_id: &str,
		child_volume_id: &str,
	) -> Result<u64, BackendError> {
		let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(database))?;
		let fork = repository.fork_snapshot(snapshot_id, child_volume_id)?;
		Ok(fork.volume.logical_size)
	}

	/// Releases one pinned snapshot after its template is no longer usable.
	///
	/// Existing forked volumes retain their own layer references.
	///
	/// # Errors
	///
	/// Returns a repository validation, availability, or durability error.
	pub fn delete_snapshot(database: &Path, snapshot_id: &str) -> Result<(), BackendError> {
		let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(database))?;
		repository.delete_snapshot(snapshot_id)?;
		Ok(())
	}

	/// Terminally retires one immutable logical-volume incarnation.
	///
	/// This control-plane entry point is deliberately separate from backend
	/// disconnect: persistent NBD/device users must not lose a volume merely
	/// because a frontend process exits.
	///
	/// # Errors
	///
	/// Returns a repository validation, availability, or durability error.
	pub fn delete_volume(
		database: &Path,
		volume_id: &str,
		op_id: &str,
	) -> Result<DeleteVolumeResult, BackendError> {
		let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(database))?;
		Ok(repository.delete_volume(DeleteVolumeRequest {
			volume_id: volume_id.to_owned(),
			op_id: op_id.to_owned(),
		})?)
	}

	/// Opens a backend with a deterministic session identity for fault tests.
	///
	/// This entry point exists only in fault-enabled builds so an external
	/// harness can retry the exact operation identity after a lost response.
	///
	/// # Errors
	///
	/// Returns an explicit repository, emulator, geometry, or fencing error.
	#[cfg(feature = "fault-injection")]
	#[doc(hidden)]
	pub fn open_for_fault_test(
		database: &Path,
		cos_root: &Path,
		volume_id: &str,
		logical_size: u64,
		session_id: &str,
	) -> Result<Self, BackendError> {
		SqliteBlockBackendFactory::open(database, cos_root)?.open_volume_with_session(
			volume_id,
			logical_size,
			session_id.to_owned(),
		)
	}
}

impl<S> SqliteBlockBackend<S>
where
	S: ObjectStore + Clone + Send + 'static,
{
	fn open_with_components(
		repository: BlockMetaRepository,
		store: S,
		volume_id: &str,
		logical_size: u64,
		session_id: String,
	) -> Result<Self, BackendError> {
		if logical_size == 0 || !logical_size.is_multiple_of(BLOCK_SIZE) {
			return Err(BackendError::GeometryMismatch);
		}
		let (state, created) = match repository.volume_state(volume_id) {
			Ok(state) => (state, false),
			Err(BlockRepositoryError::VolumeNotFound) => {
				(repository.create_volume(volume_id, logical_size)?, true)
			}
			Err(error) => return Err(error.into()),
		};
		if state.logical_size != logical_size {
			return Err(BackendError::GeometryMismatch);
		}
		let acquisition = repository.acquire_writer(AcquireWriterRequest {
			volume_id: volume_id.to_owned(),
			expected_epoch: state.writer_epoch,
			op_id: format!("nbd-acquire-{session_id}"),
		})?;
		let writer_epoch = match acquisition.outcome {
			AcquireWriterOutcome::Acquired { new_epoch } => new_epoch,
			AcquireWriterOutcome::StaleEpoch { .. } => return Err(BackendError::StaleWriter),
		};
		let settler_engine = BlockEngine::new(repository.clone(), store.clone());
		Ok(Self {
			engine: BlockEngine::new(repository, store),
			volume_id: volume_id.to_owned(),
			logical_size,
			writer_epoch,
			submitted_sequence: 0,
			operation_counter: 0,
			session_id,
			created,
			settler_engine: Some(settler_engine),
			online_settler: None,
		})
	}

	/// Returns the active writer fencing epoch.
	#[must_use]
	pub const fn writer_epoch(&self) -> u64 {
		self.writer_epoch
	}

	/// Returns whether this open created an all-zero logical volume.
	#[must_use]
	pub const fn was_created(&self) -> bool {
		self.created
	}

	/// Starts one background high/low-watermark settler sharing this backend's
	/// single repository actor and object adapter.
	///
	/// # Errors
	///
	/// Returns an explicit configuration or worker-startup failure.
	pub fn start_online_settler(
		&mut self,
		config: OnlineSettlerConfig,
	) -> Result<(), BackendError> {
		if self.online_settler.is_some() {
			return Err(BackendError::OnlineSettlerAlreadyConfigured);
		}
		let engine = self
			.settler_engine
			.take()
			.ok_or(BackendError::OnlineSettlerAlreadyConfigured)?;
		self.online_settler = Some(OnlineSettler::start(engine, config)?);
		Ok(())
	}

	/// Stops online settlement and optionally drains hot payload to the low
	/// watermark before returning its exact counters.
	///
	/// # Errors
	///
	/// Returns a durable protocol or worker failure.
	pub fn stop_online_settler(
		&mut self,
		drain: bool,
	) -> Result<Option<OnlineSettlerStats>, BackendError> {
		let Some(mut settler) = self.online_settler.take() else {
			return Ok(None);
		};
		Ok(Some(settler.shutdown(drain)?))
	}

	/// Returns linearizable hot/cold repository counters.
	///
	/// # Errors
	///
	/// Returns a repository actor or durable-state error.
	pub fn repository_stats(&self) -> Result<RepositoryStats, BackendError> {
		Ok(self.engine.repository().stats()?)
	}

	/// Stops background maintenance and terminally retires this open volume.
	///
	/// The session-derived operation ID makes repeated local teardown calls
	/// idempotent. This is used by ephemeral PVM clone ownership, not by the
	/// ordinary persistent backend drop path.
	///
	/// # Errors
	///
	/// Returns an online-settler, repository, or durability failure.
	pub fn retire_volume(&mut self) -> Result<DeleteVolumeResult, BackendError> {
		let _stats = self.stop_online_settler(false)?;
		Ok(self.engine.delete_volume(DeleteVolumeRequest {
			volume_id: self.volume_id.clone(),
			op_id: format!("backend-retire-{}", self.session_id),
		})?)
	}

	/// Settles every currently hot payload into the local COS emulator.
	///
	/// # Errors
	///
	/// Returns an engine error or a bounded-progress failure.
	pub fn settle_all(&mut self, max_passes: u64) -> Result<u64, BackendError> {
		let _online_stats = self.stop_online_settler(true)?;
		for pass in 1..=max_passes {
			let report = self.engine.settle_once()?;
			if report.object_key.is_none() && report.recovered_evictions == 0 {
				return Ok(pass);
			}
		}
		Err(BackendError::SettleLimitExceeded)
	}

	fn next_op_id(&mut self, kind: &str) -> Result<String, BackendError> {
		self.operation_counter = self
			.operation_counter
			.checked_add(1)
			.ok_or(BackendError::OperationCounterExhausted)?;
		Ok(format!(
			"nbd-{kind}-{}-{}",
			self.session_id, self.operation_counter
		))
	}

	fn check_range(&self, offset: u64, length: usize) -> Result<u64, BackendError> {
		let length = u64::try_from(length).map_err(|_| BackendError::InvalidRange)?;
		let end = offset
			.checked_add(length)
			.filter(|end| *end <= self.logical_size)
			.ok_or(BackendError::InvalidRange)?;
		Ok(end)
	}

	fn commit_aligned(&mut self, offset: u64, bytes: &[u8]) -> Result<(), BackendError> {
		for (chunk_index, chunk) in bytes.chunks(MAX_WRITE_BYTES).enumerate() {
			let chunk_offset = offset
				.checked_add(
					u64::try_from(chunk_index)
						.map_err(|_| BackendError::InvalidRange)?
						.checked_mul(
							u64::try_from(MAX_WRITE_BYTES)
								.map_err(|_| BackendError::InvalidRange)?,
						)
						.ok_or(BackendError::InvalidRange)?,
				)
				.ok_or(BackendError::InvalidRange)?;
			let op_id = self.next_op_id("write")?;
			let result = self.engine.write_range(CommitRangeWriteRequest {
				volume_id: self.volume_id.clone(),
				writer_epoch: self.writer_epoch,
				op_id,
				offset: chunk_offset,
				bytes: chunk.to_vec(),
			})?;
			match result.outcome {
				RangeWriteOutcome::Applied { last_version, .. } => {
					self.submitted_sequence = last_version.sequence;
				}
				RangeWriteOutcome::StaleEpoch { .. } => return Err(BackendError::StaleWriter),
			}
		}
		Ok(())
	}

	fn discard_aligned(&mut self, offset: u64, length: u64) -> Result<(), BackendError> {
		let max_bytes = u64::try_from(MAX_WRITE_BYTES).map_err(|_| BackendError::InvalidRange)?;
		let mut chunk_offset = offset;
		let end = offset
			.checked_add(length)
			.ok_or(BackendError::InvalidRange)?;
		while chunk_offset < end {
			let chunk_length = (end - chunk_offset).min(max_bytes);
			let op_id = self.next_op_id("discard")?;
			let result = self.engine.discard_range(DiscardRangeRequest {
				volume_id: self.volume_id.clone(),
				writer_epoch: self.writer_epoch,
				op_id,
				offset: chunk_offset,
				length: chunk_length,
			})?;
			match result.outcome {
				RangeWriteOutcome::Applied { last_version, .. } => {
					self.submitted_sequence = last_version.sequence;
				}
				RangeWriteOutcome::StaleEpoch { .. } => return Err(BackendError::StaleWriter),
			}
			chunk_offset = chunk_offset
				.checked_add(chunk_length)
				.ok_or(BackendError::InvalidRange)?;
		}
		Ok(())
	}

	fn flush_barrier(&mut self) -> Result<(), BackendError> {
		let op_id = self.next_op_id("flush")?;
		let result = self.engine.flush(FlushRequest {
			volume_id: self.volume_id.clone(),
			writer_epoch: self.writer_epoch,
			op_id,
			submitted_sequence: self.submitted_sequence,
		})?;
		if result.stale_current_epoch.is_some() {
			return Err(BackendError::StaleWriter);
		}
		Ok(())
	}

	fn notify_online_settler(&self) {
		if let Some(settler) = &self.online_settler {
			settler.notify();
		}
	}
}

impl<S> SqliteBlockBackend<S>
where
	S: ObjectStore + Clone + Send + 'static,
{
	/// Returns the fixed logical volume size in bytes.
	#[must_use]
	pub const fn size(&self) -> u64 {
		self.logical_size
	}

	/// Reads exactly `length` bytes from the sparse logical volume.
	///
	/// # Errors
	///
	/// Returns a range, repository, COS availability, or authentication error.
	pub fn read_at(&mut self, offset: u64, length: usize) -> Result<Vec<u8>, BackendError> {
		let end = self.check_range(offset, length)?;
		if length == 0 {
			return Ok(Vec::new());
		}
		let first_block = offset / BLOCK_SIZE;
		let last_block = (end - 1) / BLOCK_SIZE;
		let mut aligned = Vec::with_capacity(
			usize::try_from((last_block - first_block + 1) * BLOCK_SIZE)
				.map_err(|_| BackendError::InvalidRange)?,
		);
		for block_no in first_block..=last_block {
			aligned.extend_from_slice(&self.engine.read(&self.volume_id, block_no)?);
		}
		let start = usize::try_from(offset % BLOCK_SIZE).map_err(|_| BackendError::InvalidRange)?;
		let finish = start
			.checked_add(length)
			.ok_or(BackendError::InvalidRange)?;
		aligned
			.get(start..finish)
			.map(<[u8]>::to_vec)
			.ok_or(BackendError::InvalidRange)
	}

	/// Atomically commits all bytes, optionally capturing a FUA barrier.
	///
	/// # Errors
	///
	/// Returns a range, fencing, repository, or durability error.
	pub fn write_at(&mut self, offset: u64, bytes: &[u8], fua: bool) -> Result<(), BackendError> {
		let end = self.check_range(offset, bytes.len())?;
		if bytes.is_empty() {
			return Ok(());
		}
		let aligned_start = offset / BLOCK_SIZE * BLOCK_SIZE;
		let aligned_end =
			end.checked_add(BLOCK_SIZE - 1)
				.ok_or(BackendError::InvalidRange)?
				/ BLOCK_SIZE * BLOCK_SIZE;
		let mut aligned = if offset == aligned_start && end == aligned_end {
			bytes.to_vec()
		} else {
			self.read_at(
				aligned_start,
				usize::try_from(aligned_end - aligned_start)
					.map_err(|_| BackendError::InvalidRange)?,
			)?
		};
		let start =
			usize::try_from(offset - aligned_start).map_err(|_| BackendError::InvalidRange)?;
		let finish = start
			.checked_add(bytes.len())
			.ok_or(BackendError::InvalidRange)?;
		aligned
			.get_mut(start..finish)
			.ok_or(BackendError::InvalidRange)?
			.copy_from_slice(bytes);
		debug_assert!(aligned.len().is_multiple_of(BLOCK_SIZE_USIZE));
		self.commit_aligned(aligned_start, &aligned)?;
		self.notify_online_settler();
		if fua {
			self.flush_barrier()?;
		}
		Ok(())
	}

	/// Captures an ordered durable barrier through the submitted write cut.
	///
	/// # Errors
	///
	/// Returns a fencing, repository, or durability error.
	pub fn flush(&mut self) -> Result<(), BackendError> {
		self.flush_barrier()
	}

	/// Commits deterministic versioned zeroes for one discarded range.
	///
	/// # Errors
	///
	/// Returns a range, fencing, repository, or durability error.
	pub fn trim(&mut self, offset: u64, length: usize, fua: bool) -> Result<(), BackendError> {
		let end = self.check_range(offset, length)?;
		if length == 0 {
			return Ok(());
		}

		// The product contract chooses a stronger deterministic-zero meaning
		// than NBD requires. Partial edge blocks are RMW writes; complete 4 KiB
		// blocks become payload-free versioned DISCARD values.
		let mut cursor = offset;
		if !cursor.is_multiple_of(BLOCK_SIZE) {
			let partial_end = end.min(
				cursor
					.checked_add(BLOCK_SIZE - cursor % BLOCK_SIZE)
					.ok_or(BackendError::InvalidRange)?,
			);
			self.write_at(
				cursor,
				&vec![
					0;
					usize::try_from(partial_end - cursor)
						.map_err(|_| BackendError::InvalidRange)?
				],
				false,
			)?;
			cursor = partial_end;
		}

		let aligned_end = end / BLOCK_SIZE * BLOCK_SIZE;
		if cursor < aligned_end {
			self.discard_aligned(cursor, aligned_end - cursor)?;
			cursor = aligned_end;
		}
		if cursor < end {
			self.write_at(
				cursor,
				&vec![0; usize::try_from(end - cursor).map_err(|_| BackendError::InvalidRange)?],
				false,
			)?;
		}
		if fua {
			self.flush_barrier()?;
		}
		Ok(())
	}
}

fn new_session_id() -> Result<String, BackendError> {
	let nanos = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_err(|_| BackendError::OperationCounterExhausted)?
		.as_nanos();
	Ok(format!("{}-{nanos:x}", process::id()))
}

#[cfg(test)]
mod tests {
	use std::sync::{Arc, Barrier};

	use tempfile::tempdir;

	use super::*;

	#[test]
	fn shared_factory_serializes_concurrent_volume_writers() {
		const WRITERS: usize = 16;
		const WRITES_PER_VOLUME: usize = 16;

		let directory = tempdir().unwrap();
		let database = directory.path().join("blocks.db");
		let cos_root = directory.path().join("cos");
		// Capacity one maximizes pressure on callers before they enter SQLite.
		// This exercises the bounded backpressure path instead of only showing
		// that a generously sized queue can absorb the burst.
		let factory = SqliteBlockBackendFactory {
			repository: BlockMetaRepository::open(
				BlockRepositoryConfig::new(&database).with_queue_capacity(1),
			)
			.unwrap(),
			store: EmulatorObjectStore::open(&cos_root).unwrap(),
		};
		let barrier = Arc::new(Barrier::new(WRITERS));
		let backends = (0..WRITERS)
			.map(|writer| {
				factory
					.open_volume(&format!("shared-writer-{writer}"), 2 * 1024 * 1024)
					.unwrap()
			})
			.collect::<Vec<_>>();
		let workers = backends
			.into_iter()
			.enumerate()
			.map(|(writer, mut backend)| {
				let barrier = Arc::clone(&barrier);
				std::thread::spawn(move || {
					barrier.wait();
					for block in 0..WRITES_PER_VOLUME {
						let byte = u8::try_from(writer + block).unwrap();
						backend
							.write_at(
								u64::try_from(block * BLOCK_SIZE_USIZE).unwrap(),
								&[byte; 4096],
								false,
							)
							.unwrap();
					}
					backend.flush().unwrap();
				})
			})
			.collect::<Vec<_>>();
		for worker in workers {
			worker.join().unwrap();
		}

		let stats = factory.repository.stats().unwrap();
		assert_eq!(stats.volumes, WRITERS as u64);
		assert_eq!(stats.versions, (WRITERS * WRITES_PER_VOLUME) as u64);
	}

	#[test]
	fn typed_snapshot_and_fork_preserve_private_logical_volume() {
		let directory = tempdir().unwrap();
		let database = directory.path().join("blocks.db");
		let cos_root = directory.path().join("cos");
		let mut source =
			SqliteBlockBackend::open(&database, &cos_root, "source", 2 * 1024 * 1024).unwrap();
		source.write_at(0, &[0x5a; 4096], false).unwrap();
		source.flush().unwrap();

		assert_eq!(
			SqliteBlockBackend::snapshot_volume(&database, "source", "warm").unwrap(),
			2 * 1024 * 1024
		);
		drop(source);
		assert_eq!(
			SqliteBlockBackend::fork_snapshot(&database, "warm", "child").unwrap(),
			2 * 1024 * 1024
		);
		let mut child =
			SqliteBlockBackend::open(&database, &cos_root, "child", 2 * 1024 * 1024).unwrap();
		assert_eq!(child.read_at(0, 4096).unwrap(), [0x5a; 4096]);
		child.write_at(0, &[0xa5; 4096], false).unwrap();

		SqliteBlockBackend::delete_snapshot(&database, "warm").unwrap();
		assert_eq!(child.read_at(0, 4096).unwrap(), [0xa5; 4096]);
	}
}
