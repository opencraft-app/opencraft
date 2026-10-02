//! Vertical integration tests across the block engine, `SQLite`, and COS emulator.

use std::sync::{Arc, Barrier};

#[cfg(all(unix, feature = "fault-injection"))]
use std::{
	fs,
	os::unix::process::ExitStatusExt,
	path::PathBuf,
	process::{Command, Stdio},
	time::{Duration, Instant},
};

use minisandbox_block_engine::{
	AcquireWriterOutcome, AcquireWriterRequest, BLOCK_SIZE, BlockData, BlockEngine,
	BlockEngineError, BlockMetaRepository, BlockRepositoryConfig, BlockRepositoryError,
	CommitRangeWriteRequest, CommitWriteRequest, DeleteStatus, DeleteVolumeRequest,
	DiscardRangeRequest, DiscardRequest, FlushRequest, MAX_WRITE_BYTES, ObjectStore,
	ObjectStoreError, PutStatus, RangeWriteOutcome, WriteOutcome,
};
use minisandbox_cos_emulator::{
	ByteRange, CosEmulator, DataOperation, DataRequest, EmulatorError, FaultAction, ScriptRequest,
	Visibility, VisibilityRequest,
};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

const TWO_GIB: u64 = 2 * 1024 * 1024 * 1024;
const BUCKET: &str = "block-test";

#[derive(Debug)]
struct EmulatorStore {
	emulator: CosEmulator,
	access_path: String,
}

#[cfg(all(unix, feature = "fault-injection"))]
#[derive(Debug)]
struct CrashFileStore {
	root: PathBuf,
}

#[cfg(all(unix, feature = "fault-injection"))]
impl CrashFileStore {
	fn object_path(&self, object_key: &str) -> Result<PathBuf, ObjectStoreError> {
		if !object_key.starts_with("extent/sha256/")
			|| object_key.len() > 4_096
			|| !object_key.bytes().all(|byte| {
				byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.')
			}) {
			return Err(ObjectStoreError::Corrupt);
		}
		Ok(self.root.join(hex(&Sha256::digest(object_key.as_bytes()))))
	}
}

#[cfg(all(unix, feature = "fault-injection"))]
impl ObjectStore for CrashFileStore {
	fn put_immutable(
		&mut self,
		object_key: &str,
		bytes: &[u8],
	) -> Result<PutStatus, ObjectStoreError> {
		fs::create_dir_all(&self.root).map_err(|_| ObjectStoreError::Unavailable)?;
		let path = self.object_path(object_key)?;
		if path.exists() {
			return if fs::read(path).map_err(|_| ObjectStoreError::Unavailable)? == bytes {
				Ok(PutStatus::Stored)
			} else {
				Err(ObjectStoreError::ImmutableConflict)
			};
		}
		fs::write(path, bytes).map_err(|_| ObjectStoreError::Unavailable)?;
		Ok(PutStatus::Stored)
	}

	fn get_range(
		&mut self,
		object_key: &str,
		offset: u64,
		length: u64,
	) -> Result<Vec<u8>, ObjectStoreError> {
		let bytes =
			fs::read(self.object_path(object_key)?).map_err(|_| ObjectStoreError::NotFound)?;
		let start = usize::try_from(offset).map_err(|_| ObjectStoreError::Corrupt)?;
		let end = offset
			.checked_add(length)
			.and_then(|value| usize::try_from(value).ok())
			.ok_or(ObjectStoreError::Corrupt)?;
		bytes
			.get(start..end)
			.map(<[u8]>::to_vec)
			.ok_or(ObjectStoreError::Corrupt)
	}

	fn delete_exact(&mut self, object_key: &str) -> Result<DeleteStatus, ObjectStoreError> {
		match fs::remove_file(self.object_path(object_key)?) {
			Ok(()) => Ok(DeleteStatus::Deleted),
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
				Ok(DeleteStatus::NotFound)
			}
			Err(_) => Err(ObjectStoreError::Unavailable),
		}
	}
}

impl EmulatorStore {
	fn open(root: &std::path::Path, access_path: &str) -> Self {
		Self {
			emulator: CosEmulator::open(root).expect("open COS emulator"),
			access_path: access_path.to_owned(),
		}
	}

	fn set_access_path(&mut self, access_path: &str) {
		access_path.clone_into(&mut self.access_path);
	}

	fn script(&mut self, operation: DataOperation, key: &str, actions: Vec<FaultAction>) {
		self.emulator
			.enqueue_script(ScriptRequest {
				access_path: self.access_path.clone(),
				operation,
				bucket: BUCKET.to_owned(),
				key: key.to_owned(),
				actions,
			})
			.expect("script emulator");
	}

	fn visibility(&mut self, access_path: &str, key: &str, visibility: Visibility) {
		self.emulator
			.set_visibility(VisibilityRequest {
				access_path: access_path.to_owned(),
				bucket: BUCKET.to_owned(),
				key: key.to_owned(),
				visibility,
			})
			.expect("set visibility");
	}
}

impl ObjectStore for EmulatorStore {
	fn put_immutable(
		&mut self,
		object_key: &str,
		bytes: &[u8],
	) -> Result<PutStatus, ObjectStoreError> {
		let response = self
			.emulator
			.execute(DataRequest {
				operation: DataOperation::Put,
				bucket: BUCKET.to_owned(),
				key: object_key.to_owned(),
				access_path: self.access_path.clone(),
				body: bytes.to_vec(),
				range: None,
			})
			.map_err(|error| map_emulator_error(&error))?;
		match response.status {
			200..=299 => Ok(PutStatus::Stored),
			504 => Ok(PutStatus::Indeterminate),
			409 => Err(ObjectStoreError::ImmutableConflict),
			_ => Err(ObjectStoreError::Unavailable),
		}
	}

	fn get_range(
		&mut self,
		object_key: &str,
		offset: u64,
		length: u64,
	) -> Result<Vec<u8>, ObjectStoreError> {
		let end = offset
			.checked_add(length)
			.and_then(|exclusive| exclusive.checked_sub(1))
			.ok_or(ObjectStoreError::Corrupt)?;
		let response = self
			.emulator
			.execute(DataRequest {
				operation: DataOperation::Get,
				bucket: BUCKET.to_owned(),
				key: object_key.to_owned(),
				access_path: self.access_path.clone(),
				body: Vec::new(),
				range: Some(ByteRange::Inclusive { start: offset, end }),
			})
			.map_err(|error| map_emulator_error(&error))?;
		match response.status {
			200 | 206 => Ok(response.body),
			404 => Err(ObjectStoreError::NotFound),
			504 => Err(ObjectStoreError::Timeout),
			416 => Err(ObjectStoreError::Corrupt),
			_ => Err(ObjectStoreError::Unavailable),
		}
	}

	fn delete_exact(&mut self, object_key: &str) -> Result<DeleteStatus, ObjectStoreError> {
		let response = self
			.emulator
			.execute(DataRequest {
				operation: DataOperation::Delete,
				bucket: BUCKET.to_owned(),
				key: object_key.to_owned(),
				access_path: self.access_path.clone(),
				body: Vec::new(),
				range: None,
			})
			.map_err(|error| map_emulator_error(&error))?;
		match response.status {
			200..=299 => Ok(DeleteStatus::Deleted),
			404 => Ok(DeleteStatus::NotFound),
			504 => Ok(DeleteStatus::Indeterminate),
			_ => Err(ObjectStoreError::Unavailable),
		}
	}
}

fn map_emulator_error(error: &EmulatorError) -> ObjectStoreError {
	match error {
		EmulatorError::ImmutableConflict => ObjectStoreError::ImmutableConflict,
		EmulatorError::Io(_) | EmulatorError::AlreadyOpen => ObjectStoreError::Unavailable,
		EmulatorError::CorruptState | EmulatorError::InvalidArgument(_) => {
			ObjectStoreError::Corrupt
		}
	}
}

fn open_repository(directory: &TempDir) -> BlockMetaRepository {
	BlockMetaRepository::open(BlockRepositoryConfig::new(
		directory.path().join("blocks.db"),
	))
	.expect("open block repository")
}

fn block(byte: u8) -> Vec<u8> {
	vec![byte; 4 * 1024]
}

fn write(volume: &str, op: &str, block_no: u64, byte: u8) -> CommitWriteRequest {
	write_epoch(volume, 1, op, block_no, byte)
}

fn write_epoch(volume: &str, epoch: u64, op: &str, block_no: u64, byte: u8) -> CommitWriteRequest {
	CommitWriteRequest {
		volume_id: volume.to_owned(),
		writer_epoch: epoch,
		op_id: op.to_owned(),
		block_no,
		bytes: block(byte),
	}
}

fn range_write(
	volume: &str,
	epoch: u64,
	op: &str,
	first_block: u64,
	blocks: usize,
	byte: u8,
) -> CommitRangeWriteRequest {
	CommitRangeWriteRequest {
		volume_id: volume.to_owned(),
		writer_epoch: epoch,
		op_id: op.to_owned(),
		offset: first_block * BLOCK_SIZE,
		bytes: vec![byte; blocks * usize::try_from(BLOCK_SIZE).expect("block size fits usize")],
	}
}

fn object_key(blocks: &[Vec<u8>]) -> String {
	let bytes: Vec<u8> = blocks.iter().flatten().copied().collect();
	format!("extent/sha256/{}", hex(&Sha256::digest(bytes)))
}

fn hex(bytes: &[u8]) -> String {
	const HEX: &[u8; 16] = b"0123456789abcdef";
	let mut output = String::with_capacity(bytes.len() * 2);
	for byte in bytes {
		output.push(char::from(HEX[usize::from(byte >> 4)]));
		output.push(char::from(HEX[usize::from(byte & 0x0f)]));
	}
	output
}

#[test]
#[allow(clippy::too_many_lines)]
fn typed_write_transaction_is_atomic_idempotent_and_concurrent() {
	let directory = TempDir::new().expect("tempdir");
	let repository = Arc::new(open_repository(&directory));
	repository
		.create_volume("volume", TWO_GIB)
		.expect("create sparse volume");
	let barrier = Arc::new(Barrier::new(16));
	let mut threads = Vec::new();
	for _ in 0..16 {
		let repository = Arc::clone(&repository);
		let barrier = Arc::clone(&barrier);
		threads.push(std::thread::spawn(move || {
			barrier.wait();
			repository
				.commit_write(write("volume", "same-op", 524_287, 0xa5))
				.expect("duplicate write")
		}));
	}
	let results: Vec<_> = threads
		.into_iter()
		.map(|thread| thread.join().expect("join duplicate writer"))
		.collect();
	assert_eq!(results.iter().filter(|result| !result.replayed).count(), 1);
	let first_sequence = match results[0].outcome {
		WriteOutcome::Applied { version, .. } => version.sequence,
		WriteOutcome::StaleEpoch { .. } => panic!("initial writer unexpectedly stale"),
	};
	assert!(first_sequence > 0);
	assert!(results.iter().all(|result| {
		matches!(
			result.outcome,
			WriteOutcome::Applied {
				version: minisandbox_block_engine::BlockVersion {
					epoch: 1,
					sequence
				},
				..
			} if sequence == first_sequence
		)
	}));
	assert_eq!(
		repository.commit_write(write("volume", "same-op", 524_287, 0x5a)),
		Err(BlockRepositoryError::OperationIdMismatch)
	);
	let data = repository
		.read_block_head("volume", 524_287)
		.expect("read high sparse block");
	assert!(matches!(
		data,
		minisandbox_block_engine::BlockData::Version {
			hot_bytes: Some(bytes),
			..
		} if bytes == block(0xa5)
	));
	assert_eq!(
		repository
			.read_block_head("volume", 0)
			.expect("read sparse zero"),
		minisandbox_block_engine::BlockData::Zero
	);

	let first_flush = repository
		.capture_flush(FlushRequest {
			volume_id: "volume".to_owned(),
			writer_epoch: 1,
			op_id: "flush-1".to_owned(),
			submitted_sequence: first_sequence,
		})
		.expect("capture flush");
	let replay = repository
		.capture_flush(FlushRequest {
			volume_id: "volume".to_owned(),
			writer_epoch: 1,
			op_id: "flush-1".to_owned(),
			submitted_sequence: first_sequence,
		})
		.expect("replay flush");
	assert!(!first_flush.replayed);
	assert!(replay.replayed);
	assert_eq!(first_flush.commit_version, replay.commit_version);

	let acquired = repository
		.acquire_writer(AcquireWriterRequest {
			volume_id: "volume".to_owned(),
			expected_epoch: 1,
			op_id: "recover-owner".to_owned(),
		})
		.expect("acquire recovery epoch");
	assert_eq!(
		acquired.outcome,
		AcquireWriterOutcome::Acquired { new_epoch: 2 }
	);
	let acquisition_replay = repository
		.acquire_writer(AcquireWriterRequest {
			volume_id: "volume".to_owned(),
			expected_epoch: 1,
			op_id: "recover-owner".to_owned(),
		})
		.expect("replay acquisition");
	assert!(acquisition_replay.replayed);
	assert_eq!(acquired.commit_version, acquisition_replay.commit_version);
	assert!(matches!(
		repository
			.commit_write(write("volume", "old-writer", 0, 0x10))
			.expect("persist stale outcome")
			.outcome,
		WriteOutcome::StaleEpoch { current_epoch: 2 }
	));
	assert!(matches!(
		repository
			.commit_write(write_epoch("volume", 2, "new-writer", 0, 0x20))
			.expect("fresh writer")
			.outcome,
		WriteOutcome::Applied {
			version: minisandbox_block_engine::BlockVersion { epoch: 2, .. },
			..
		}
	));
}

#[test]
fn aligned_multi_block_write_is_atomic_replayable_and_four_kib_cow() {
	let directory = TempDir::new().expect("tempdir");
	let repository = open_repository(&directory);
	repository
		.create_volume("range", TWO_GIB)
		.expect("create sparse volume");

	let request = range_write("range", 1, "range-32", 7, 32, 0x6d);
	let result = repository
		.commit_range_write(request.clone())
		.expect("commit range");
	let (first, last, layer_id) = match result.outcome {
		RangeWriteOutcome::Applied {
			first_version,
			last_version,
			block_count,
			layer_id,
		} => {
			assert_eq!(block_count, 32);
			assert_eq!(last_version.sequence - first_version.sequence, 31);
			(first_version, last_version, layer_id)
		}
		RangeWriteOutcome::StaleEpoch { .. } => panic!("initial range unexpectedly stale"),
	};
	assert_eq!(result.commit_version, last.sequence);
	assert_eq!(first.epoch, 1);

	let replay = repository
		.commit_range_write(request.clone())
		.expect("replay range");
	assert!(replay.replayed);
	assert_eq!(replay.commit_version, result.commit_version);
	assert_eq!(replay.outcome, result.outcome);

	let mut mismatched = request;
	mismatched.bytes[0] ^= 1;
	assert_eq!(
		repository.commit_range_write(mismatched),
		Err(BlockRepositoryError::OperationIdMismatch)
	);
	for block_no in 7..39 {
		assert!(matches!(
			repository
				.read_block_head("range", block_no)
				.expect("read range block"),
			BlockData::Version {
				hot_bytes: Some(bytes),
				..
			} if bytes == block(0x6d)
		));
	}
	assert_eq!(
		repository
			.read_block_head("range", 39)
			.expect("read adjacent zero"),
		BlockData::Zero
	);
	let stats = repository.stats().expect("range stats");
	assert_eq!(stats.versions, 32);
	assert_eq!(stats.delta_heads, 32);
	assert_eq!(stats.delta_layers, 1);
	assert_eq!(stats.hot_payload_bytes, 32 * BLOCK_SIZE);

	let snapshot = repository
		.create_snapshot("range", "range-snapshot")
		.expect("snapshot range");
	assert_eq!(snapshot.layer_id, layer_id);
	let after = repository
		.commit_range_write(range_write(
			"range",
			snapshot.source_writer_epoch,
			"range-after-snapshot",
			7,
			1,
			0x7e,
		))
		.expect("write child layer");
	assert!(matches!(
		after.outcome,
		RangeWriteOutcome::Applied { layer_id: child, .. } if child != layer_id
	));
}

#[test]
fn aligned_multi_block_write_enforces_bounds_before_mutation() {
	let directory = TempDir::new().expect("tempdir");
	let repository = open_repository(&directory);
	repository
		.create_volume("bounds", TWO_GIB)
		.expect("create sparse volume");

	let max_blocks = MAX_WRITE_BYTES / usize::try_from(BLOCK_SIZE).expect("block size fits usize");
	repository
		.commit_range_write(range_write(
			"bounds",
			1,
			"max-range",
			TWO_GIB / BLOCK_SIZE - max_blocks as u64,
			max_blocks,
			0x42,
		))
		.expect("maximum bounded write");

	let mut unaligned = range_write("bounds", 1, "unaligned", 0, 1, 0x11);
	unaligned.offset = 1;
	assert!(matches!(
		repository.commit_range_write(unaligned),
		Err(BlockRepositoryError::InvalidArgument(_))
	));
	let oversized = range_write("bounds", 1, "oversized", 0, max_blocks + 1, 0x22);
	assert!(matches!(
		repository.commit_range_write(oversized),
		Err(BlockRepositoryError::InvalidArgument(_))
	));
	let outside = range_write("bounds", 1, "outside", TWO_GIB / BLOCK_SIZE - 1, 2, 0x33);
	assert!(matches!(
		repository.commit_range_write(outside),
		Err(BlockRepositoryError::InvalidArgument(_))
	));
	let stats = repository.stats().expect("bounded stats");
	assert_eq!(stats.versions, max_blocks as u64);
	assert_eq!(stats.delta_heads, max_blocks as u64);
}

#[test]
#[allow(clippy::too_many_lines)]
fn two_gib_volume_settles_restarts_and_forks_without_copying() {
	let database = TempDir::new().expect("database tempdir");
	let cos = TempDir::new().expect("COS tempdir");
	let repository = open_repository(&database);
	repository
		.create_volume("parent", TWO_GIB)
		.expect("create parent");
	let store = EmulatorStore::open(cos.path(), "access-a");
	let mut engine = BlockEngine::new(repository, store);
	engine
		.set_max_pack_bytes(2 * BLOCK_SIZE)
		.expect("pack size");

	let first_write = engine
		.write(write("parent", "write-1", 7, 0x11))
		.expect("write block 7");
	let second_write = engine
		.write(write("parent", "write-2", 524_287, 0x22))
		.expect("write final block");
	let flush_sequence = match (first_write.outcome, second_write.outcome) {
		(
			WriteOutcome::Applied { version: first, .. },
			WriteOutcome::Applied {
				version: second, ..
			},
		) => first.sequence.max(second.sequence),
		_ => panic!("initial writes unexpectedly stale"),
	};
	engine
		.flush(FlushRequest {
			volume_id: "parent".to_owned(),
			writer_epoch: 1,
			op_id: "flush-parent".to_owned(),
			submitted_sequence: flush_sequence,
		})
		.expect("flush hot SQLite");
	let snapshot = engine.snapshot("parent", "base").expect("snapshot root");
	let child = engine.fork("base", "child").expect("fork root");
	assert_eq!(snapshot.layer_id, child.inherited_layer_id);
	assert_eq!(engine.repository().stats().expect("stats").versions, 2);

	let report = engine.settle_once().expect("settle first pack");
	assert_eq!(report.published_blocks, 2);
	assert_eq!(
		engine
			.repository()
			.stats()
			.expect("stats")
			.hot_payload_bytes,
		0
	);
	assert_eq!(
		engine.read("child", 7).expect("inherited cold block"),
		block(0x11)
	);

	let (repository, store) = engine.into_parts();
	drop(repository);
	drop(store);

	let repository = open_repository(&database);
	let store = EmulatorStore::open(cos.path(), "access-a");
	let mut engine = BlockEngine::new(repository, store);
	assert_eq!(
		engine.read("parent", 524_287).expect("restart read"),
		block(0x22)
	);
	assert_eq!(
		engine.read("child", 7).expect("restart fork read"),
		block(0x11)
	);

	assert_eq!(
		engine
			.repository()
			.acquire_writer(AcquireWriterRequest {
				volume_id: "parent".to_owned(),
				expected_epoch: snapshot.source_writer_epoch,
				op_id: "recover-parent".to_owned(),
			})
			.expect("fence parent")
			.outcome,
		AcquireWriterOutcome::Acquired { new_epoch: 3 }
	);
	assert_eq!(
		engine
			.repository()
			.acquire_writer(AcquireWriterRequest {
				volume_id: "child".to_owned(),
				expected_epoch: 1,
				op_id: "recover-child".to_owned(),
			})
			.expect("fence child")
			.outcome,
		AcquireWriterOutcome::Acquired { new_epoch: 2 }
	);
	engine
		.write(write_epoch("parent", 3, "parent-diverge", 7, 0x33))
		.expect("parent divergent write");
	engine
		.write(write_epoch("child", 2, "child-diverge", 7, 0x44))
		.expect("child divergent write");
	assert_eq!(
		engine.read("parent", 7).expect("parent divergence"),
		block(0x33)
	);
	assert_eq!(
		engine.read("child", 7).expect("child divergence"),
		block(0x44)
	);
	engine.settle_once().expect("settle divergent writes");
	assert_eq!(
		engine
			.repository()
			.stats()
			.expect("stats")
			.hot_payload_bytes,
		0
	);
	assert_eq!(
		engine.read("parent", 7).expect("cold parent divergence"),
		block(0x33)
	);
	assert_eq!(
		engine.read("child", 7).expect("cold child divergence"),
		block(0x44)
	);
}

#[test]
fn concurrent_parent_and_clone_writes_remain_isolated_after_restart() {
	const LANES_PER_VOLUME: usize = 4;
	const BLOCKS_PER_LANE: usize = 16;

	let directory = TempDir::new().expect("concurrent clone tempdir");
	let database = directory.path().join("blocks.db");
	let repository = Arc::new(
		BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
			.expect("open concurrent clone repository"),
	);
	repository
		.create_volume("concurrent-parent", TWO_GIB)
		.expect("create concurrent parent");
	repository
		.commit_write(write("concurrent-parent", "concurrent-base", 0, 0x21))
		.expect("write concurrent base");
	let snapshot = repository
		.create_snapshot("concurrent-parent", "concurrent-root")
		.expect("snapshot concurrent root");
	repository
		.fork_snapshot("concurrent-root", "concurrent-child")
		.expect("fork concurrent child");
	let parent_epoch = snapshot.source_writer_epoch;

	let callers = 2 * LANES_PER_VOLUME;
	let barrier = Arc::new(Barrier::new(callers));
	let mut workers = Vec::with_capacity(callers);
	for child_side in [false, true] {
		for lane in 0..LANES_PER_VOLUME {
			let worker_repository = Arc::clone(&repository);
			let worker_barrier = Arc::clone(&barrier);
			workers.push(std::thread::spawn(move || {
				let volume_id = if child_side {
					"concurrent-child"
				} else {
					"concurrent-parent"
				};
				let writer_epoch = if child_side { 1 } else { parent_epoch };
				let byte = if child_side {
					0x80 + u8::try_from(lane).expect("lane fits u8")
				} else {
					0x40 + u8::try_from(lane).expect("lane fits u8")
				};
				worker_barrier.wait();
				for index in 0..BLOCKS_PER_LANE {
					let block_no = u64::try_from(1 + lane * BLOCKS_PER_LANE + index)
						.expect("block number fits u64");
					worker_repository
						.commit_write(write_epoch(
							volume_id,
							writer_epoch,
							&format!("{volume_id}-{lane}-{index}"),
							block_no,
							byte,
						))
						.expect("concurrent clone write");
				}
			}));
		}
	}
	for worker in workers {
		worker.join().expect("join concurrent clone writer");
	}

	assert_clone_contents(&repository);
	let repository = Arc::try_unwrap(repository).expect("all clone workers released repository");
	drop(repository);

	let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
		.expect("reopen concurrent clone repository");
	assert_clone_contents(&repository);
}

fn assert_clone_contents(repository: &BlockMetaRepository) {
	assert!(matches!(
		repository
			.read_block_head("concurrent-parent", 0)
			.expect("read parent base"),
		BlockData::Version {
			hot_bytes: Some(bytes),
			..
		} if bytes == block(0x21)
	));
	assert!(matches!(
		repository
			.read_block_head("concurrent-child", 0)
			.expect("read child base"),
		BlockData::Version {
			hot_bytes: Some(bytes),
			..
		} if bytes == block(0x21)
	));
	for lane in 0..4 {
		let parent_byte = 0x40 + u8::try_from(lane).expect("lane fits u8");
		let child_byte = 0x80 + u8::try_from(lane).expect("lane fits u8");
		for index in 0..16 {
			let block_no = u64::try_from(1 + lane * 16 + index).expect("block number fits u64");
			for (volume_id, expected) in [
				("concurrent-parent", parent_byte),
				("concurrent-child", child_byte),
			] {
				assert!(
					matches!(
						repository
							.read_block_head(volume_id, block_no)
							.expect("read concurrent clone block"),
						BlockData::Version {
							hot_bytes: Some(bytes),
							..
						} if bytes == block(expected)
					),
					"wrong isolated value for {volume_id} block {block_no}"
				);
			}
		}
	}
}

#[test]
fn identical_pack_bytes_are_shared_across_distinct_versions() {
	let database = TempDir::new().expect("database tempdir");
	let cos = TempDir::new().expect("COS tempdir");
	let repository = open_repository(&database);
	repository
		.create_volume("dedupe", TWO_GIB)
		.expect("create volume");
	let store = EmulatorStore::open(cos.path(), "access-a");
	let mut engine = BlockEngine::new(repository, store);
	engine
		.set_max_pack_bytes(BLOCK_SIZE)
		.expect("single block pack");
	engine
		.write(write("dedupe", "first", 1, 0x31))
		.expect("first version");
	let first = engine.settle_once().expect("first settle");
	engine
		.write(write("dedupe", "second", 2, 0x31))
		.expect("same-content version");
	let second = engine.settle_once().expect("second settle");
	assert_eq!(first.object_key, second.object_key);
	let stats = engine.repository().stats().expect("stats");
	assert_eq!(stats.packs, 1);
	assert_eq!(stats.cold_locations, 2);
	assert_eq!(stats.hot_payload_bytes, 0);
	assert_eq!(engine.read("dedupe", 1).expect("first alias"), block(0x31));
	assert_eq!(engine.read("dedupe", 2).expect("second alias"), block(0x31));
}

#[test]
fn settler_reclaims_overwritten_hot_versions_before_building_a_pack() {
	let database = TempDir::new().expect("database tempdir");
	let cos = TempDir::new().expect("COS tempdir");
	let repository = open_repository(&database);
	repository
		.create_volume("overwrite-cold", TWO_GIB)
		.expect("create overwrite volume");
	let store = EmulatorStore::open(cos.path(), "access-a");
	let mut engine = BlockEngine::new(repository, store);

	for version in 0_u8..64 {
		engine
			.write(write(
				"overwrite-cold",
				&format!("overwrite-{version}"),
				9,
				version,
			))
			.expect("overwrite one logical block");
	}
	assert_eq!(
		engine
			.repository()
			.stats()
			.expect("hot stats")
			.hot_payload_bytes,
		64 * BLOCK_SIZE
	);

	let report = engine.settle_once().expect("settle only reachable version");
	assert_eq!(report.published_blocks, 1);
	assert_eq!(report.evicted_blocks, 1);
	let stats = engine.repository().stats().expect("cold stats");
	assert_eq!(stats.hot_payload_bytes, 0);
	assert_eq!(stats.cold_locations, 1);
	assert_eq!(stats.packs, 1);
	assert_eq!(stats.pending_gc_tasks, 0);
	assert_eq!(
		engine
			.read("overwrite-cold", 9)
			.expect("read newest cold version"),
		block(63)
	);
}

#[test]
fn steady_writes_update_exact_sharded_delta_keys_without_rewriting_the_layer() {
	let directory = TempDir::new().expect("tempdir");
	let repository = open_repository(&directory);
	repository
		.create_volume("delta", TWO_GIB)
		.expect("create delta volume");

	let first = repository
		.commit_write(write("delta", "first", 1, 0x11))
		.expect("first delta write");
	let first_layer = match first.outcome {
		WriteOutcome::Applied { layer_id, .. } => layer_id,
		WriteOutcome::StaleEpoch { .. } => panic!("initial writer unexpectedly stale"),
	};
	let second = repository
		.commit_write(write("delta", "second-shard", 1_025, 0x22))
		.expect("second shard write");
	let overwrite = repository
		.commit_write(write("delta", "overwrite", 1, 0x33))
		.expect("overwrite exact delta key");
	assert!(matches!(
		second.outcome,
		WriteOutcome::Applied { layer_id, .. } if layer_id == first_layer
	));
	assert!(matches!(
		overwrite.outcome,
		WriteOutcome::Applied { layer_id, .. } if layer_id == first_layer
	));
	let steady = repository.stats().expect("steady delta stats");
	assert_eq!(steady.delta_layers, 1);
	assert_eq!(steady.mutable_delta_layers, 1);
	assert_eq!(steady.delta_heads, 2);
	assert_eq!(steady.versions, 3);

	let snapshot = repository
		.create_snapshot("delta", "sealed")
		.expect("seal mutable layer");
	assert_eq!(snapshot.layer_id, first_layer);
	let sealed = repository.stats().expect("sealed delta stats");
	assert_eq!(sealed.delta_layers, 1);
	assert_eq!(sealed.mutable_delta_layers, 0);

	let divergent = repository
		.commit_write(write_epoch(
			"delta",
			snapshot.source_writer_epoch,
			"divergent",
			1,
			0x44,
		))
		.expect("create mutable child layer");
	assert!(matches!(
		divergent.outcome,
		WriteOutcome::Applied { layer_id, .. } if layer_id != first_layer
	));
	let rotated = repository.stats().expect("rotated delta stats");
	assert_eq!(rotated.delta_layers, 2);
	assert_eq!(rotated.mutable_delta_layers, 1);
	assert_eq!(rotated.delta_heads, 3);
}

#[test]
fn discard_is_a_durable_versioned_zero_and_preserves_snapshot_data() {
	let database = TempDir::new().expect("database tempdir");
	let cos = TempDir::new().expect("COS tempdir");
	let repository = open_repository(&database);
	repository
		.create_volume("discard", TWO_GIB)
		.expect("create discard volume");
	let store = EmulatorStore::open(cos.path(), "access-a");
	let mut engine = BlockEngine::new(repository, store);
	engine
		.write(write("discard", "data", 17, 0x5c))
		.expect("write pre-discard data");
	let snapshot = engine
		.snapshot("discard", "before-discard")
		.expect("pin pre-discard root");
	let request = DiscardRequest {
		volume_id: "discard".to_owned(),
		writer_epoch: snapshot.source_writer_epoch,
		op_id: "discard-17".to_owned(),
		block_no: 17,
	};
	let applied = engine.discard(request.clone()).expect("commit discard");
	let discard_sequence = match applied.outcome {
		WriteOutcome::Applied { version, .. } => {
			assert_eq!(version.epoch, snapshot.source_writer_epoch);
			version.sequence
		}
		WriteOutcome::StaleEpoch { .. } => panic!("fresh discard unexpectedly stale"),
	};
	assert!(engine.discard(request).expect("replay discard").replayed);
	assert!(matches!(
		engine.discard(DiscardRequest {
			volume_id: "discard".to_owned(),
			writer_epoch: snapshot.source_writer_epoch,
			op_id: "discard-17".to_owned(),
			block_no: 18,
		}),
		Err(BlockEngineError::Repository(
			BlockRepositoryError::OperationIdMismatch
		))
	));
	assert!(matches!(
		engine
			.repository()
			.read_block_head("discard", 17)
			.expect("resolve discard"),
		BlockData::Discarded {
			version: minisandbox_block_engine::BlockVersion { epoch, sequence },
			..
		} if epoch == snapshot.source_writer_epoch && sequence == discard_sequence
	));
	assert_eq!(engine.read("discard", 17).expect("read zero"), block(0));
	engine
		.flush(FlushRequest {
			volume_id: "discard".to_owned(),
			writer_epoch: snapshot.source_writer_epoch,
			op_id: "flush-discard".to_owned(),
			submitted_sequence: discard_sequence,
		})
		.expect("flush discard version");
	engine
		.fork("before-discard", "before-child")
		.expect("fork pre-discard root");
	assert_eq!(
		engine
			.read("before-child", 17)
			.expect("snapshot retains data"),
		block(0x5c)
	);

	engine.settle_once().expect("settle only data payload");
	let stats = engine.repository().stats().expect("discard stats");
	assert_eq!(stats.versions, 2);
	assert_eq!(stats.cold_locations, 1);
	assert_eq!(stats.hot_payload_bytes, 0);
	assert_eq!(engine.read("discard", 17).expect("cold zero"), block(0));
	assert_eq!(
		engine.read("before-child", 17).expect("cold snapshot data"),
		block(0x5c)
	);
}

#[test]
fn range_discard_is_atomic_replayable_and_preserves_snapshot_data() {
	let database = TempDir::new().expect("database tempdir");
	let cos = TempDir::new().expect("COS tempdir");
	let repository = open_repository(&database);
	repository
		.create_volume("range-discard", TWO_GIB)
		.expect("create range-discard volume");
	let store = EmulatorStore::open(cos.path(), "access-a");
	let mut engine = BlockEngine::new(repository, store);
	engine
		.write_range(CommitRangeWriteRequest {
			volume_id: "range-discard".to_owned(),
			writer_epoch: 1,
			op_id: "seed-range".to_owned(),
			offset: 16 * BLOCK_SIZE,
			bytes: vec![0x6a; 3 * usize::try_from(BLOCK_SIZE).expect("block size fits")],
		})
		.expect("seed range");
	let snapshot = engine
		.snapshot("range-discard", "before-range-discard")
		.expect("pin pre-discard range");
	let request = DiscardRangeRequest {
		volume_id: "range-discard".to_owned(),
		writer_epoch: snapshot.source_writer_epoch,
		op_id: "discard-range-16-18".to_owned(),
		offset: 16 * BLOCK_SIZE,
		length: 3 * BLOCK_SIZE,
	};
	let applied = engine
		.discard_range(request.clone())
		.expect("commit range discard");
	let last_sequence = match applied.outcome {
		RangeWriteOutcome::Applied {
			first_version,
			last_version,
			block_count,
			..
		} => {
			assert_eq!(block_count, 3);
			assert_eq!(last_version.sequence - first_version.sequence, 2);
			last_version.sequence
		}
		RangeWriteOutcome::StaleEpoch { .. } => panic!("fresh range discard became stale"),
	};
	assert!(
		engine
			.discard_range(request.clone())
			.expect("replay range discard")
			.replayed
	);
	let mut mismatched = request;
	mismatched.length = 2 * BLOCK_SIZE;
	assert!(matches!(
		engine.discard_range(mismatched),
		Err(BlockEngineError::Repository(
			BlockRepositoryError::OperationIdMismatch
		))
	));
	for block_no in 16..19 {
		assert_eq!(
			engine
				.read("range-discard", block_no)
				.expect("read discarded range"),
			block(0)
		);
	}
	engine
		.flush(FlushRequest {
			volume_id: "range-discard".to_owned(),
			writer_epoch: snapshot.source_writer_epoch,
			op_id: "flush-range-discard".to_owned(),
			submitted_sequence: last_sequence,
		})
		.expect("flush range discard");
	engine
		.fork("before-range-discard", "before-range-child")
		.expect("fork pre-discard range");
	for block_no in 16..19 {
		assert_eq!(
			engine
				.read("before-range-child", block_no)
				.expect("snapshot retains range data"),
			block(0x6a)
		);
	}
}

#[test]
fn range_discard_does_not_materialize_sparse_zeroes() {
	let database = TempDir::new().expect("database tempdir");
	let repository = open_repository(&database);
	repository
		.create_volume("sparse-discard", TWO_GIB)
		.expect("create sparse volume");
	let store = EmulatorStore::open(database.path(), "access-a");
	let mut engine = BlockEngine::new(repository, store);
	let request = DiscardRangeRequest {
		volume_id: "sparse-discard".to_owned(),
		writer_epoch: 1,
		op_id: "discard-sparse-zeroes".to_owned(),
		offset: 128 * BLOCK_SIZE,
		length: 128 * BLOCK_SIZE,
	};
	let applied = engine
		.discard_range(request.clone())
		.expect("discard sparse zeroes");
	assert!(!applied.replayed);
	assert!(
		engine
			.discard_range(request)
			.expect("replay discard")
			.replayed
	);

	let stats = engine.repository().stats().expect("sparse discard stats");
	assert_eq!(stats.versions, 0);
	assert_eq!(stats.delta_heads, 0);
	assert_eq!(
		engine
			.read("sparse-discard", 128)
			.expect("read sparse zero"),
		block(0)
	);
}

#[test]
#[allow(clippy::too_many_lines)]
fn snapshot_delete_drives_exact_key_gc_and_content_reuse_gets_new_incarnation() {
	let database = TempDir::new().expect("database tempdir");
	let cos = TempDir::new().expect("COS tempdir");
	let repository = open_repository(&database);
	repository
		.create_volume("gc", TWO_GIB)
		.expect("create GC volume");
	let store = EmulatorStore::open(cos.path(), "access-a");
	let mut engine = BlockEngine::new(repository, store);
	engine
		.set_max_pack_bytes(BLOCK_SIZE)
		.expect("single-block GC packs");

	engine
		.write(write("gc", "old-data", 1, 0x41))
		.expect("write old data");
	let snapshot = engine.snapshot("gc", "old-root").expect("pin old root");
	let old_pack = engine
		.settle_once()
		.expect("settle old pack")
		.object_key
		.expect("old object key");
	engine
		.write(write_epoch(
			"gc",
			snapshot.source_writer_epoch,
			"new-data",
			1,
			0x42,
		))
		.expect("overwrite current head");
	engine.settle_once().expect("settle replacement pack");
	assert_eq!(
		engine.repository().stats().expect("pre-delete stats").packs,
		2
	);

	let deleted = engine.delete_snapshot("old-root").expect("delete snapshot");
	assert!(!deleted.replayed);
	assert!(
		engine
			.delete_snapshot("old-root")
			.expect("replay snapshot deletion")
			.replayed
	);
	let pending = engine.repository().stats().expect("pending GC stats");
	assert_eq!(pending.snapshots, 0);
	assert_eq!(pending.pending_gc_tasks, 1);
	assert_eq!(pending.completed_gc_tasks, 0);

	let (repository, store) = engine.into_parts();
	drop(repository);
	drop(store);
	let repository = open_repository(&database);
	let store = EmulatorStore::open(cos.path(), "access-a");
	let mut engine = BlockEngine::new(repository, store);

	engine.object_store_mut().script(
		DataOperation::Delete,
		&old_pack,
		vec![FaultAction::TimeoutBeforeApply { delay_ms: 0 }],
	);
	let unknown = engine.gc_once().expect("unknown exact DELETE");
	assert!(!unknown.completed);
	assert_eq!(
		unknown.task.as_ref().map(|task| task.object_key.as_str()),
		Some(old_pack.as_str())
	);
	assert_eq!(
		engine
			.repository()
			.stats()
			.expect("still pending stats")
			.pending_gc_tasks,
		1
	);

	let completed = engine.gc_once().expect("retry exact DELETE");
	assert!(completed.completed);
	let after_gc = engine.repository().stats().expect("completed GC stats");
	assert_eq!(after_gc.pending_gc_tasks, 0);
	assert_eq!(after_gc.completed_gc_tasks, 1);
	assert_eq!(after_gc.packs, 1);
	assert_eq!(
		engine.read("gc", 1).expect("replacement remains"),
		block(0x42)
	);

	engine
		.write(write_epoch(
			"gc",
			snapshot.source_writer_epoch,
			"reuse-old-content",
			2,
			0x41,
		))
		.expect("reuse deleted content");
	let reincarnated = engine
		.settle_once()
		.expect("settle reincarnated content")
		.object_key
		.expect("reincarnated object key");
	assert_ne!(reincarnated, old_pack);
	assert!(reincarnated.starts_with(&format!("{old_pack}/r")));
	assert_eq!(
		engine.read("gc", 2).expect("read reincarnation"),
		block(0x41)
	);
}

#[test]
fn snapshot_release_during_prepared_pack_is_reconciled_after_completion() {
	let database = TempDir::new().expect("database tempdir");
	let cos = TempDir::new().expect("COS tempdir");
	let repository = open_repository(&database);
	repository
		.create_volume("intent-gc", TWO_GIB)
		.expect("create intent GC volume");
	repository
		.commit_write(write("intent-gc", "old", 1, 0x61))
		.expect("write snapshot-only value");
	let snapshot = repository
		.create_snapshot("intent-gc", "intent-pin")
		.expect("pin old value");
	repository
		.commit_write(write_epoch(
			"intent-gc",
			snapshot.source_writer_epoch,
			"new",
			1,
			0x62,
		))
		.expect("overwrite current value");
	let generation = repository.acquire_settler().expect("acquire test settler");
	let intent = repository
		.resume_or_prepare_pack(generation, BLOCK_SIZE)
		.expect("prepare old pack")
		.expect("prepared intent");
	assert_eq!(intent.members[0].hot_bytes, Some(block(0x61)));

	repository
		.delete_snapshot("intent-pin")
		.expect("release while intent active");
	assert_eq!(
		repository
			.stats()
			.expect("active intent stats")
			.hot_payload_bytes,
		2 * BLOCK_SIZE
	);

	let store = EmulatorStore::open(cos.path(), "access-a");
	let mut engine = BlockEngine::new(repository, store);
	engine
		.set_max_pack_bytes(BLOCK_SIZE)
		.expect("single-block packs");
	engine
		.settle_once()
		.expect("claim and finish dead prepared member");
	let after_intent = engine.repository().stats().expect("post-intent stats");
	// Per-pack publication no longer re-runs a recursive whole-image liveness
	// scan. The dead pack may remain an orphan until this durable round ends.
	assert_eq!(after_intent.pending_gc_tasks, 0);
	assert_eq!(after_intent.active_settlement_rounds, 1);
	assert_eq!(after_intent.hot_payload_bytes, BLOCK_SIZE);
	engine.settle_once().expect("settle still-live replacement");
	let after_round = engine.repository().stats().expect("post-round stats");
	assert_eq!(after_round.pending_gc_tasks, 1);
	assert_eq!(after_round.active_settlement_rounds, 0);
	assert_eq!(after_round.completed_settlement_rounds, 1);
	assert_eq!(
		engine.read("intent-gc", 1).expect("read live value"),
		block(0x62)
	);
}

#[test]
fn deleting_snapshot_does_not_collect_pack_still_referenced_by_fork() {
	let database = TempDir::new().expect("database tempdir");
	let cos = TempDir::new().expect("COS tempdir");
	let repository = open_repository(&database);
	repository
		.create_volume("fork-gc", TWO_GIB)
		.expect("create fork GC volume");
	let store = EmulatorStore::open(cos.path(), "access-a");
	let mut engine = BlockEngine::new(repository, store);
	engine
		.set_max_pack_bytes(BLOCK_SIZE)
		.expect("single-block fork GC packs");
	engine
		.write(write("fork-gc", "base", 5, 0x71))
		.expect("write fork base");
	let snapshot = engine
		.snapshot("fork-gc", "fork-pin")
		.expect("pin fork root");
	engine
		.fork("fork-pin", "fork-child")
		.expect("create child reference");
	engine.settle_once().expect("settle shared base");
	engine
		.write(write_epoch(
			"fork-gc",
			snapshot.source_writer_epoch,
			"parent-new",
			5,
			0x72,
		))
		.expect("overwrite parent");
	engine.settle_once().expect("settle parent replacement");
	engine
		.delete_snapshot("fork-pin")
		.expect("drop redundant snapshot ref");
	assert_eq!(
		engine
			.repository()
			.stats()
			.expect("fork reference stats")
			.pending_gc_tasks,
		0
	);
	assert_eq!(
		engine.read("fork-child", 5).expect("child remains"),
		block(0x71)
	);
	assert_eq!(
		engine.read("fork-gc", 5).expect("parent remains"),
		block(0x72)
	);
}

#[test]
fn volume_retirement_is_terminal_idempotent_and_preserves_shared_roots() {
	let database = TempDir::new().expect("database tempdir");
	let repository = open_repository(&database);
	repository
		.create_volume("retire-parent", TWO_GIB)
		.expect("create retirement parent");
	repository
		.commit_write(write("retire-parent", "base", 5, 0x71))
		.expect("write retirement base");
	let snapshot = repository
		.create_snapshot("retire-parent", "retire-pin")
		.expect("pin retirement root");
	repository
		.fork_snapshot("retire-pin", "retire-child")
		.expect("fork retirement child");
	repository
		.commit_write(write_epoch(
			"retire-parent",
			snapshot.source_writer_epoch,
			"parent-private",
			6,
			0x72,
		))
		.expect("write parent-private block");

	let request = DeleteVolumeRequest {
		volume_id: "retire-parent".to_owned(),
		op_id: "destroy-sandbox-17".to_owned(),
	};
	let deleted = repository
		.delete_volume(request.clone())
		.expect("retire parent");
	assert!(!deleted.replayed);
	assert_eq!(deleted.retired_writer_epoch, snapshot.source_writer_epoch);
	assert_eq!(
		deleted.fenced_writer_epoch,
		snapshot.source_writer_epoch + 1
	);
	assert_ne!(deleted.layer_id, 0);
	let replay = repository
		.delete_volume(request)
		.expect("replay parent retirement");
	assert!(replay.replayed);
	assert_eq!(replay.commit_version, deleted.commit_version);
	assert_eq!(replay.layer_id, deleted.layer_id);

	assert_eq!(
		repository.volume_state("retire-parent"),
		Err(BlockRepositoryError::VolumeRetired)
	);
	assert_eq!(
		repository.read_block_head("retire-parent", 5),
		Err(BlockRepositoryError::VolumeRetired)
	);
	assert_eq!(
		repository.commit_write(write_epoch(
			"retire-parent",
			snapshot.source_writer_epoch,
			"late-write",
			7,
			0x73,
		)),
		Err(BlockRepositoryError::VolumeRetired)
	);
	assert_eq!(
		repository.delete_volume(DeleteVolumeRequest {
			volume_id: "retire-parent".to_owned(),
			op_id: "different-destroy".to_owned(),
		}),
		Err(BlockRepositoryError::VolumeRetired)
	);
	assert_eq!(
		repository.create_volume("retire-parent", TWO_GIB),
		Err(BlockRepositoryError::AlreadyExists)
	);
	assert!(matches!(
		repository
			.read_block_head("retire-child", 5)
			.expect("child still resolves shared root"),
		BlockData::Version {
			hot_bytes: Some(bytes),
			..
		} if bytes == block(0x71)
	));
	let stats = repository.stats().expect("retirement stats");
	assert_eq!(stats.volumes, 1);
	assert_eq!(stats.retired_volumes, 1);
	assert_eq!(stats.snapshots, 1);
}

#[test]
fn deleting_last_volume_root_enqueues_exact_pack_gc() {
	let database = TempDir::new().expect("database tempdir");
	let cos = TempDir::new().expect("COS tempdir");
	let repository = open_repository(&database);
	repository
		.create_volume("last-root", TWO_GIB)
		.expect("create last-root volume");
	let store = EmulatorStore::open(cos.path(), "access-a");
	let mut engine = BlockEngine::new(repository, store);
	engine
		.set_max_pack_bytes(BLOCK_SIZE)
		.expect("single-block last-root pack");
	engine
		.write(write("last-root", "only-write", 3, 0x44))
		.expect("write last root");
	let object_key = engine
		.settle_once()
		.expect("settle last root")
		.object_key
		.expect("last-root object key");

	engine
		.delete_volume(DeleteVolumeRequest {
			volume_id: "last-root".to_owned(),
			op_id: "destroy-last-root".to_owned(),
		})
		.expect("delete last volume root");
	let pending = engine
		.repository()
		.stats()
		.expect("pending volume GC stats");
	assert_eq!(pending.volumes, 0);
	assert_eq!(pending.retired_volumes, 1);
	assert_eq!(pending.cold_locations, 0);
	assert_eq!(pending.pending_gc_tasks, 1);
	let gc = engine.gc_once().expect("delete exact retired pack");
	assert!(gc.completed);
	assert_eq!(
		gc.task.as_ref().map(|task| task.object_key.as_str()),
		Some(object_key.as_str())
	);
	let completed = engine
		.repository()
		.stats()
		.expect("completed volume GC stats");
	assert_eq!(completed.pending_gc_tasks, 0);
	assert_eq!(completed.completed_gc_tasks, 1);
	assert_eq!(completed.packs, 0);
}

#[test]
fn weak_cos_observations_never_become_zero_or_unverified_publication() {
	let database = TempDir::new().expect("database tempdir");
	let cos = TempDir::new().expect("COS tempdir");
	let repository = open_repository(&database);
	repository
		.create_volume("faults", TWO_GIB)
		.expect("create volume");
	let store = EmulatorStore::open(cos.path(), "access-a");
	let mut engine = BlockEngine::new(repository, store);
	engine
		.set_max_pack_bytes(BLOCK_SIZE)
		.expect("single block pack");
	engine
		.write(write("faults", "write", 9, 0x66))
		.expect("write hot block");
	let key = object_key(&[block(0x66)]);

	engine.object_store_mut().script(
		DataOperation::Put,
		&key,
		vec![FaultAction::TimeoutBeforeApply { delay_ms: 0 }],
	);
	assert!(matches!(
		engine.settle_once(),
		Err(BlockEngineError::ObjectStore(ObjectStoreError::NotFound))
	));
	assert_eq!(
		engine
			.repository()
			.stats()
			.expect("stats")
			.hot_payload_bytes,
		BLOCK_SIZE
	);
	assert_eq!(engine.read("faults", 9).expect("hot fallback"), block(0x66));

	engine.object_store_mut().script(
		DataOperation::Put,
		&key,
		vec![FaultAction::TimeoutAfterApply { delay_ms: 0 }],
	);
	engine
		.object_store_mut()
		.script(DataOperation::Get, &key, vec![FaultAction::Corrupt]);
	assert!(matches!(
		engine.settle_once(),
		Err(BlockEngineError::AuthenticationFailed)
	));
	assert_eq!(
		engine.repository().stats().expect("stats").cold_locations,
		0
	);
	assert_eq!(
		engine
			.repository()
			.stats()
			.expect("stats")
			.hot_payload_bytes,
		BLOCK_SIZE
	);

	engine.settle_once().expect("retry immutable settle");
	assert_eq!(
		engine
			.repository()
			.stats()
			.expect("stats")
			.hot_payload_bytes,
		0
	);
	engine
		.object_store_mut()
		.visibility("access-b", &key, Visibility::Hidden);
	engine.object_store_mut().set_access_path("access-b");
	assert!(matches!(
		engine.read("faults", 9),
		Err(BlockEngineError::ObjectStore(ObjectStoreError::NotFound))
	));
	engine
		.object_store_mut()
		.visibility("access-b", &key, Visibility::Visible);
	assert_eq!(
		engine.read("faults", 9).expect("later visible"),
		block(0x66)
	);
}

#[test]
fn restart_finishes_eviction_after_cold_publication() {
	let database = TempDir::new().expect("database tempdir");
	let cos = TempDir::new().expect("COS tempdir");
	let repository = open_repository(&database);
	repository
		.create_volume("recovery", TWO_GIB)
		.expect("create volume");
	repository
		.commit_write(write("recovery", "write", 1, 0x77))
		.expect("write block");
	let hot = repository
		.select_hot_blocks(BLOCK_SIZE)
		.expect("select hot");
	let bytes = hot[0].bytes.clone();
	let digest: [u8; 32] = Sha256::digest(&bytes).into();
	let key = format!("extent/sha256/{}", hex(&digest));
	let mut store = EmulatorStore::open(cos.path(), "access-a");
	assert_eq!(
		store.put_immutable(&key, &bytes).expect("put pack"),
		PutStatus::Stored
	);
	assert_eq!(
		store.get_range(&key, 0, BLOCK_SIZE).expect("verify pack"),
		bytes
	);
	repository
		.publish_cold_location(key, digest, BLOCK_SIZE, vec![(hot[0].clone(), 0)])
		.expect("publish cold location");
	assert_eq!(
		repository.stats().expect("stats").hot_payload_bytes,
		BLOCK_SIZE
	);
	drop(repository);

	let repository = open_repository(&database);
	let mut engine = BlockEngine::new(repository, store);
	let report = engine.settle_once().expect("recover eviction");
	assert_eq!(report.recovered_evictions, 1);
	assert_eq!(
		engine
			.repository()
			.stats()
			.expect("stats")
			.hot_payload_bytes,
		0
	);
	assert_eq!(
		engine.read("recovery", 1).expect("read recovered cold"),
		block(0x77)
	);
}

#[cfg(all(unix, feature = "fault-injection"))]
#[test]
fn sigkill_write_boundaries_recover_to_exactly_one_version() {
	for (point, committed_before_kill) in [
		("before-write-commit", false),
		("during-write-commit", false),
		("after-write-commit", true),
	] {
		run_write_crash_case(point, committed_before_kill);
	}
}

#[cfg(all(unix, feature = "fault-injection"))]
#[test]
fn sigkill_range_write_boundaries_recover_atomically() {
	for (point, committed_before_kill) in [
		("before-range-commit", false),
		("during-range-commit", false),
		("after-range-commit", true),
	] {
		run_range_write_crash_case(point, committed_before_kill);
	}
}

#[cfg(all(unix, feature = "fault-injection"))]
#[test]
fn sigkill_flush_boundaries_recover_one_idempotent_barrier() {
	for (point, committed_before_kill) in [
		("before-flush-commit", false),
		("during-flush-commit", false),
		("after-flush-commit", true),
	] {
		run_flush_crash_case(point, committed_before_kill);
	}
}

#[cfg(all(unix, feature = "fault-injection"))]
#[test]
fn sigkill_snapshot_boundaries_recover_one_idempotent_root_switch() {
	for (point, committed_before_kill) in [
		("before-snapshot-commit", false),
		("during-snapshot-commit", false),
		("after-snapshot-commit", true),
	] {
		run_snapshot_crash_case(point, committed_before_kill);
	}
}

#[cfg(all(unix, feature = "fault-injection"))]
#[test]
fn sigkill_volume_delete_boundaries_recover_one_terminal_tombstone() {
	for (point, committed_before_kill) in [
		("before-delete-volume-commit", false),
		("during-delete-volume-commit", false),
		("after-delete-volume-commit", true),
	] {
		run_delete_volume_crash_case(point, committed_before_kill);
	}
}

#[cfg(all(unix, feature = "fault-injection"))]
#[test]
fn sigkill_pack_boundaries_resume_exact_members_without_data_loss() {
	for point in [
		"after-pack-prepared",
		"after-pack-put",
		"after-pack-verified",
		"after-pack-published",
		"after-pack-first-eviction",
	] {
		run_pack_crash_case(point);
	}
}

#[cfg(all(unix, feature = "fault-injection"))]
#[test]
fn sigkill_gc_boundaries_replay_exact_delete_without_live_data_loss() {
	for point in ["before-gc-delete", "after-gc-delete", "after-gc-complete"] {
		run_gc_crash_case(point);
	}
}

#[cfg(all(unix, feature = "fault-injection"))]
fn run_pack_crash_case(point: &str) {
	let directory = TempDir::new().expect("pack crash tempdir");
	let database = directory.path().join("blocks.db");
	let object_root = directory.path().join("objects");
	let marker = directory.path().join("stopped.marker");
	let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
		.expect("open pack crash database");
	repository
		.create_volume("pack-crash", TWO_GIB)
		.expect("create pack crash volume");
	repository
		.commit_write(write("pack-crash", "pack-write-1", 3, 0xa3))
		.expect("first pack crash write");
	repository
		.commit_write(write("pack-crash", "pack-write-2", 4, 0xb4))
		.expect("second pack crash write");
	drop(repository);

	let mut child = Command::new(env!("CARGO_BIN_EXE_minisandbox-block-crash-probe"))
		.arg(&database)
		.arg(&marker)
		.arg(point)
		.arg(&object_root)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::piped())
		.spawn()
		.expect("spawn pack crash probe");
	wait_for_marker(&mut child, &marker, point);
	kill_stopped_child(&mut child, point);

	let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
		.expect("reopen pack crash database");
	let store = CrashFileStore { root: object_root };
	let mut engine = BlockEngine::new(repository, store);
	engine
		.set_max_pack_bytes(8 * BLOCK_SIZE)
		.expect("pack crash size");
	engine.settle_once().expect("resume durable pack workflow");
	let stats = engine.repository().stats().expect("pack crash stats");
	assert_eq!(stats.hot_payload_bytes, 0, "crash point {point}");
	assert_eq!(stats.cold_locations, 2, "crash point {point}");
	assert_eq!(stats.active_pack_intents, 0, "crash point {point}");
	assert_eq!(stats.completed_pack_intents, 1, "crash point {point}");
	assert_eq!(stats.active_settlement_rounds, 0, "crash point {point}");
	assert_eq!(stats.completed_settlement_rounds, 1, "crash point {point}");
	assert_eq!(
		engine
			.read("pack-crash", 3)
			.expect("read first recovered block"),
		block(0xa3),
		"crash point {point}"
	);
	assert_eq!(
		engine
			.read("pack-crash", 4)
			.expect("read second recovered block"),
		block(0xb4),
		"crash point {point}"
	);
}

#[cfg(all(unix, feature = "fault-injection"))]
#[allow(clippy::too_many_lines)]
fn run_gc_crash_case(point: &str) {
	let directory = TempDir::new().expect("GC crash tempdir");
	let database = directory.path().join("blocks.db");
	let object_root = directory.path().join("objects");
	let marker = directory.path().join("stopped.marker");
	let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
		.expect("open GC crash database");
	repository
		.create_volume("gc-crash", TWO_GIB)
		.expect("create GC crash volume");
	let store = CrashFileStore {
		root: object_root.clone(),
	};
	let mut engine = BlockEngine::new(repository, store);
	engine
		.set_max_pack_bytes(BLOCK_SIZE)
		.expect("single-block GC crash pack");
	engine
		.write(write("gc-crash", "old", 1, 0x41))
		.expect("write old GC crash value");
	let snapshot = engine
		.snapshot("gc-crash", "gc-crash-snapshot")
		.expect("pin old GC crash value");
	let old_pack = engine
		.settle_once()
		.expect("settle old GC crash pack")
		.object_key
		.expect("old GC crash object key");
	let old_object_path = engine
		.object_store_mut()
		.object_path(&old_pack)
		.expect("old GC crash object path");
	engine
		.write(write_epoch(
			"gc-crash",
			snapshot.source_writer_epoch,
			"replacement",
			1,
			0x42,
		))
		.expect("write live GC crash replacement");
	engine
		.settle_once()
		.expect("settle live GC crash replacement");
	engine
		.delete_snapshot("gc-crash-snapshot")
		.expect("create durable GC crash task");
	assert!(old_object_path.exists());
	assert_eq!(
		engine
			.repository()
			.stats()
			.expect("pre-crash GC stats")
			.pending_gc_tasks,
		1
	);
	let (repository, store) = engine.into_parts();
	drop(repository);
	drop(store);

	let mut child = Command::new(env!("CARGO_BIN_EXE_minisandbox-block-crash-probe"))
		.arg(&database)
		.arg(&marker)
		.arg(point)
		.arg(&object_root)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::piped())
		.spawn()
		.expect("spawn GC crash probe");
	wait_for_marker(&mut child, &marker, point);
	kill_stopped_child(&mut child, point);

	let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
		.expect("reopen GC crash database");
	let store = CrashFileStore { root: object_root };
	let mut engine = BlockEngine::new(repository, store);
	let before_retry = engine.repository().stats().expect("crashed GC stats");
	if point == "before-gc-delete" {
		assert!(old_object_path.exists(), "crash point {point}");
		assert_eq!(before_retry.pending_gc_tasks, 1, "crash point {point}");
		assert_eq!(before_retry.completed_gc_tasks, 0, "crash point {point}");
	} else {
		assert!(!old_object_path.exists(), "crash point {point}");
	}

	let retry = engine.gc_once().expect("resume exact GC task");
	if point == "after-gc-complete" {
		assert_eq!(retry.task, None, "crash point {point}");
		assert!(!retry.completed, "crash point {point}");
	} else {
		assert_eq!(
			retry.task.as_ref().map(|task| task.object_key.as_str()),
			Some(old_pack.as_str()),
			"crash point {point}"
		);
		assert!(retry.completed, "crash point {point}");
	}
	let recovered = engine.repository().stats().expect("recovered GC stats");
	assert_eq!(recovered.pending_gc_tasks, 0, "crash point {point}");
	assert_eq!(recovered.completed_gc_tasks, 1, "crash point {point}");
	assert_eq!(recovered.packs, 1, "crash point {point}");
	assert!(!old_object_path.exists(), "crash point {point}");
	assert_eq!(
		engine
			.read("gc-crash", 1)
			.expect("read live replacement after GC crash"),
		block(0x42),
		"crash point {point}"
	);
}

#[cfg(all(unix, feature = "fault-injection"))]
fn kill_stopped_child(child: &mut std::process::Child, point: &str) {
	let pid = i32::try_from(child.id()).expect("child PID fits i32");
	// SAFETY: pid identifies the owned child process and SIGKILL has no memory
	// safety preconditions in this parent process.
	assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
	let status = child.wait().expect("wait for killed crash probe");
	assert_eq!(status.signal(), Some(libc::SIGKILL), "crash point {point}");
}

#[cfg(all(unix, feature = "fault-injection"))]
fn run_write_crash_case(point: &str, committed_before_kill: bool) {
	let directory = TempDir::new().expect("crash tempdir");
	let database = directory.path().join("blocks.db");
	let marker = directory.path().join("stopped.marker");
	let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
		.expect("open crash database");
	repository
		.create_volume("crash-volume", TWO_GIB)
		.expect("create crash volume");
	drop(repository);

	let mut child = Command::new(env!("CARGO_BIN_EXE_minisandbox-block-crash-probe"))
		.arg(&database)
		.arg(&marker)
		.arg(point)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::piped())
		.spawn()
		.expect("spawn block crash probe");
	wait_for_marker(&mut child, &marker, point);
	kill_stopped_child(&mut child, point);

	let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
		.expect("reopen crash database");
	let retry = repository
		.commit_write(write("crash-volume", "crash-write", 13, 0x9a))
		.expect("retry uncertain crash write");
	assert_eq!(
		retry.replayed, committed_before_kill,
		"unexpected durable outcome at {point}"
	);
	assert_eq!(repository.stats().expect("stats").versions, 1);
	assert!(matches!(
		repository
			.read_block_head("crash-volume", 13)
			.expect("read crash block"),
		minisandbox_block_engine::BlockData::Version {
			hot_bytes: Some(bytes),
			..
		} if bytes == block(0x9a)
	));
}

#[cfg(all(unix, feature = "fault-injection"))]
fn run_range_write_crash_case(point: &str, committed_before_kill: bool) {
	let directory = TempDir::new().expect("range crash tempdir");
	let database = directory.path().join("blocks.db");
	let marker = directory.path().join("stopped.marker");
	let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
		.expect("open range crash database");
	repository
		.create_volume("crash-volume", TWO_GIB)
		.expect("create range crash volume");
	drop(repository);

	let mut child = Command::new(env!("CARGO_BIN_EXE_minisandbox-block-crash-probe"))
		.arg(&database)
		.arg(&marker)
		.arg(point)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::piped())
		.spawn()
		.expect("spawn range crash probe");
	wait_for_marker(&mut child, &marker, point);
	kill_stopped_child(&mut child, point);

	let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
		.expect("reopen range crash database");
	let retry = repository
		.commit_range_write(range_write(
			"crash-volume",
			1,
			"crash-range-write",
			13,
			32,
			0x9a,
		))
		.expect("retry uncertain range crash write");
	assert_eq!(
		retry.replayed, committed_before_kill,
		"unexpected durable range outcome at {point}"
	);
	assert_eq!(
		repository.stats().expect("range crash stats").versions,
		32,
		"partial range became visible at {point}"
	);
	for block_no in 13..45 {
		assert!(
			matches!(
				repository
					.read_block_head("crash-volume", block_no)
					.expect("read range crash block"),
				BlockData::Version {
					hot_bytes: Some(bytes),
					..
				} if bytes == block(0x9a)
			),
			"wrong block {block_no} at {point}"
		);
	}
}

#[cfg(all(unix, feature = "fault-injection"))]
fn run_flush_crash_case(point: &str, committed_before_kill: bool) {
	let directory = TempDir::new().expect("flush crash tempdir");
	let database = directory.path().join("blocks.db");
	let marker = directory.path().join("stopped.marker");
	let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
		.expect("open flush crash database");
	repository
		.create_volume("crash-volume", TWO_GIB)
		.expect("create flush crash volume");
	drop(repository);

	let mut child = Command::new(env!("CARGO_BIN_EXE_minisandbox-block-crash-probe"))
		.arg(&database)
		.arg(&marker)
		.arg(point)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::piped())
		.spawn()
		.expect("spawn flush crash probe");
	wait_for_marker(&mut child, &marker, point);
	kill_stopped_child(&mut child, point);

	let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
		.expect("reopen flush crash database");
	let retry = repository
		.capture_flush(FlushRequest {
			volume_id: "crash-volume".to_owned(),
			writer_epoch: 1,
			op_id: "crash-flush".to_owned(),
			submitted_sequence: 0,
		})
		.expect("retry uncertain flush");
	assert_eq!(
		retry.replayed, committed_before_kill,
		"unexpected durable flush outcome at {point}"
	);
	assert_eq!(retry.captured_sequence, 0, "crash point {point}");
	assert_eq!(retry.stale_current_epoch, None, "crash point {point}");
	let replay = repository
		.capture_flush(FlushRequest {
			volume_id: "crash-volume".to_owned(),
			writer_epoch: 1,
			op_id: "crash-flush".to_owned(),
			submitted_sequence: 0,
		})
		.expect("replay recovered flush");
	assert!(replay.replayed, "crash point {point}");
	assert_eq!(
		replay.commit_version, retry.commit_version,
		"crash point {point}"
	);
}

#[cfg(all(unix, feature = "fault-injection"))]
fn run_snapshot_crash_case(point: &str, committed_before_kill: bool) {
	let directory = TempDir::new().expect("snapshot crash tempdir");
	let database = directory.path().join("blocks.db");
	let marker = directory.path().join("stopped.marker");
	let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
		.expect("open snapshot crash database");
	repository
		.create_volume("crash-volume", TWO_GIB)
		.expect("create snapshot crash volume");
	repository
		.commit_write(write("crash-volume", "snapshot-source", 13, 0x9a))
		.expect("write snapshot crash source");
	drop(repository);

	let mut child = Command::new(env!("CARGO_BIN_EXE_minisandbox-block-crash-probe"))
		.arg(&database)
		.arg(&marker)
		.arg(point)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::piped())
		.spawn()
		.expect("spawn snapshot crash probe");
	wait_for_marker(&mut child, &marker, point);
	kill_stopped_child(&mut child, point);

	let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
		.expect("reopen snapshot crash database");
	assert_eq!(
		repository
			.volume_state("crash-volume")
			.expect("post-crash source state")
			.writer_epoch,
		if committed_before_kill { 2 } else { 1 },
		"unexpected snapshot root outcome at {point}"
	);
	let snapshot = repository
		.create_snapshot("crash-volume", "crash-snapshot")
		.expect("retry uncertain snapshot");
	assert_eq!(snapshot.source_writer_epoch, 2, "crash point {point}");
	assert_ne!(snapshot.layer_id, 0, "crash point {point}");
	assert_eq!(
		repository
			.create_snapshot("crash-volume", "crash-snapshot")
			.expect("replay recovered snapshot"),
		snapshot,
		"crash point {point}"
	);
	assert_eq!(
		repository.stats().expect("snapshot crash stats").snapshots,
		1,
		"crash point {point}"
	);
	let child = repository
		.fork_snapshot("crash-snapshot", "crash-child")
		.expect("fork recovered snapshot");
	assert_eq!(
		child.inherited_layer_id, snapshot.layer_id,
		"crash point {point}"
	);
	for volume_id in ["crash-volume", "crash-child"] {
		assert!(
			matches!(
				repository
					.read_block_head(volume_id, 13)
					.expect("read recovered snapshot root"),
				BlockData::Version {
					hot_bytes: Some(bytes),
					..
				} if bytes == block(0x9a)
			),
			"wrong root data for {volume_id} at {point}"
		);
	}
}

#[cfg(all(unix, feature = "fault-injection"))]
fn run_delete_volume_crash_case(point: &str, committed_before_kill: bool) {
	let directory = TempDir::new().expect("delete-volume crash tempdir");
	let database = directory.path().join("blocks.db");
	let marker = directory.path().join("stopped.marker");
	let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
		.expect("open delete-volume crash database");
	repository
		.create_volume("crash-volume", TWO_GIB)
		.expect("create delete-volume crash volume");
	repository
		.commit_write(write("crash-volume", "delete-source", 13, 0x9a))
		.expect("write delete-volume crash source");
	drop(repository);

	let mut child = Command::new(env!("CARGO_BIN_EXE_minisandbox-block-crash-probe"))
		.arg(&database)
		.arg(&marker)
		.arg(point)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::piped())
		.spawn()
		.expect("spawn delete-volume crash probe");
	wait_for_marker(&mut child, &marker, point);
	kill_stopped_child(&mut child, point);

	let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
		.expect("reopen delete-volume crash database");
	assert_eq!(
		repository.volume_state("crash-volume"),
		if committed_before_kill {
			Err(BlockRepositoryError::VolumeRetired)
		} else {
			Ok(minisandbox_block_engine::VolumeState {
				volume_id: "crash-volume".to_owned(),
				logical_size: TWO_GIB,
				writer_epoch: 1,
				committed_sequence: 2,
				layer_id: 1,
			})
		},
		"unexpected delete outcome at {point}"
	);
	let retry = repository
		.delete_volume(DeleteVolumeRequest {
			volume_id: "crash-volume".to_owned(),
			op_id: "crash-delete-volume".to_owned(),
		})
		.expect("retry uncertain volume delete");
	assert_eq!(retry.replayed, committed_before_kill, "crash point {point}");
	assert_eq!(retry.retired_writer_epoch, 1, "crash point {point}");
	assert_eq!(retry.fenced_writer_epoch, 2, "crash point {point}");
	assert_eq!(
		repository.commit_write(write("crash-volume", "post-delete-write", 14, 0x9b)),
		Err(BlockRepositoryError::VolumeRetired),
		"late write survived at {point}"
	);
	let stats = repository.stats().expect("delete-volume crash stats");
	assert_eq!(stats.volumes, 0, "crash point {point}");
	assert_eq!(stats.retired_volumes, 1, "crash point {point}");
}

#[cfg(all(unix, feature = "fault-injection"))]
fn wait_for_marker(child: &mut std::process::Child, marker: &std::path::Path, point: &str) {
	let deadline = Instant::now() + Duration::from_secs(10);
	loop {
		if marker.exists() {
			return;
		}
		if let Some(status) = child.try_wait().expect("poll crash probe") {
			let mut stderr = String::new();
			if let Some(mut pipe) = child.stderr.take() {
				use std::io::Read;
				pipe.read_to_string(&mut stderr).expect("read crash stderr");
			}
			panic!("crash probe exited before marker at {point}: {status}; {stderr}");
		}
		assert!(Instant::now() < deadline, "crash marker timeout at {point}");
		std::thread::sleep(Duration::from_millis(5));
	}
}
