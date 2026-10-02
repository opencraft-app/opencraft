//! Independent linearizability history checks for concurrent block callers.

use std::fs::File;
use std::io::BufWriter;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;

use minisandbox_block_engine::{
    BLOCK_SIZE, BlockData, BlockMetaRepository, BlockRepositoryConfig, CommitRangeWriteRequest,
    DiscardRequest, FlushRequest, RangeWriteOutcome, WriteOutcome,
};
use serde::Serialize;
use stateright::semantics::{ConsistencyTester, LinearizabilityTester, SequentialSpec};
use tempfile::TempDir;

const TWO_GIB: u64 = 2 * 1024 * 1024 * 1024;
const CALLERS: usize = 6;
const WAVES: usize = 12;
const RANGE_BLOCKS: usize = 16;

#[derive(Clone, Debug, Eq, PartialEq)]
enum RegisterOperation {
    Write(u64),
    Discard,
    Read,
    Flush,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RegisterReturn {
    MutationOk,
    Read(u64),
    FlushOk,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct BlockRegister(u64);

impl SequentialSpec for BlockRegister {
    type Op = RegisterOperation;
    type Ret = RegisterReturn;

    fn invoke(&mut self, operation: &Self::Op) -> Self::Ret {
        match operation {
            RegisterOperation::Write(value) => {
                self.0 = *value;
                RegisterReturn::MutationOk
            }
            RegisterOperation::Discard => {
                self.0 = 0;
                RegisterReturn::MutationOk
            }
            RegisterOperation::Read => RegisterReturn::Read(self.0),
            RegisterOperation::Flush => RegisterReturn::FlushOk,
        }
    }
}

type History = Arc<Mutex<LinearizabilityTester<usize, BlockRegister>>>;
type CommitVersions = Arc<Mutex<Vec<u64>>>;

#[derive(Clone, Debug, Serialize)]
struct ObservedOperation {
    client_id: usize,
    kind: &'static str,
    value: u64,
    output: u64,
    call: u64,
    r#return: u64,
}

#[derive(Debug, Default)]
struct ExternalHistory {
    clock: AtomicU64,
    operations: Mutex<Vec<ObservedOperation>>,
}

#[derive(Clone, Copy, Debug)]
struct PendingObservation {
    client_id: usize,
    kind: &'static str,
    value: u64,
    call: u64,
}

#[derive(Clone, Copy, Debug)]
enum WorkerOperation {
    Write(u64),
    Discard,
    Read,
}

#[test]
#[allow(clippy::too_many_lines)]
fn concurrent_block_history_is_linearizable_and_durable() {
    let directory = TempDir::new().expect("block history tempdir");
    let database = directory.path().join("blocks.db");
    let repository = Arc::new(
        BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
            .expect("open block history repository"),
    );
    repository
        .create_volume("history", TWO_GIB)
        .expect("create block history volume");

    let commit_versions = CommitVersions::default();
    let external_history = Arc::new(ExternalHistory::default());
    let mut range_write_count = 0_u64;
    let mut discard_count = 0_u64;
    let mut checked_operations = 0_usize;

    for wave in 0..WAVES {
        let initial = read_register(&repository);
        let history = Arc::new(Mutex::new(LinearizabilityTester::new(BlockRegister(
            initial,
        ))));
        let barrier = Arc::new(Barrier::new(CALLERS));
        let mixed_wave = wave % 2 == 1;
        let mut workers = Vec::with_capacity(CALLERS);

        for caller in 0..CALLERS {
            let operation = if !mixed_wave || caller < 3 {
                range_write_count += 1;
                WorkerOperation::Write(
                    u64::try_from(wave * CALLERS + caller + 1).expect("value ID fits u64"),
                )
            } else if caller == 3 {
                discard_count += 1;
                WorkerOperation::Discard
            } else {
                WorkerOperation::Read
            };
            let worker_repository = Arc::clone(&repository);
            let worker_history = Arc::clone(&history);
            let worker_barrier = Arc::clone(&barrier);
            let worker_versions = Arc::clone(&commit_versions);
            let worker_external_history = Arc::clone(&external_history);
            workers.push(thread::spawn(move || {
                worker_barrier.wait();
                let covered = match operation {
                    WorkerOperation::Write(value) => Some(run_write(
                        &worker_repository,
                        &worker_history,
                        &worker_external_history,
                        &worker_versions,
                        wave,
                        caller,
                        value,
                    )),
                    WorkerOperation::Discard => Some(run_discard(
                        &worker_repository,
                        &worker_history,
                        &worker_external_history,
                        &worker_versions,
                        wave,
                        caller,
                    )),
                    WorkerOperation::Read => {
                        run_read(
                            &worker_repository,
                            &worker_history,
                            &worker_external_history,
                            caller,
                        );
                        None
                    }
                };
                if mixed_wave && matches!(caller, 0 | 3) {
                    run_flush(
                        &worker_repository,
                        &worker_history,
                        &worker_external_history,
                        &worker_versions,
                        wave,
                        caller,
                        covered.expect("flush caller performed a mutation"),
                    );
                }
            }));
        }
        for worker in workers {
            worker.join().expect("join block history caller");
        }

        // This read starts after every wave operation returned, so it fixes
        // the final abstract state and prevents the checker from accepting a
        // serialization that only explains intermediate observations.
        run_read(&repository, &history, &external_history, CALLERS);
        let serialized = history
            .lock()
            .expect("history lock")
            .serialized_history()
            .unwrap_or_else(|| panic!("wave {wave} was not linearizable"));
        assert!(serialized.len() > CALLERS);
        checked_operations += serialized.len();
    }
    assert_eq!(checked_operations, 96);

    let runtime = repository.runtime_stats();
    assert_eq!(runtime.range_operations, range_write_count);
    assert_eq!(
        runtime.range_blocks,
        range_write_count * RANGE_BLOCKS as u64
    );
    assert!(runtime.range_transactions <= runtime.range_operations);
    assert!(runtime.max_range_blocks >= RANGE_BLOCKS as u64);
    assert!(
        runtime.max_range_operations > 1,
        "concurrent callers never exercised zero-wait group commit"
    );

    let stats = repository.stats().expect("block history stats");
    assert_eq!(
        stats.versions,
        range_write_count * RANGE_BLOCKS as u64 + discard_count
    );
    assert_eq!(stats.delta_heads, RANGE_BLOCKS as u64);

    let mut versions = commit_versions.lock().expect("commit version lock").clone();
    let observation_count = versions.len();
    versions.sort_unstable();
    versions.dedup();
    assert_eq!(
        versions.len(),
        observation_count,
        "mutations and FLUSH barriers reused a commit version"
    );

    eprintln!(
        "MINISANDBOX_BLOCK_LINEARIZABILITY_OK callers={CALLERS} waves={WAVES} \
         operations={checked_operations} range_writes={range_write_count} \
         discards={discard_count} commit_observations={observation_count} \
         range_transactions={} max_group_operations={} max_group_blocks={}",
        runtime.range_transactions, runtime.max_range_operations, runtime.max_range_blocks
    );

    let expected_after_restart = read_register(&repository);
    write_external_history_if_requested(&external_history);
    drop(repository);
    let reopened = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
        .expect("reopen concurrent history repository");
    assert_eq!(read_register(&reopened), expected_after_restart);
}

fn run_write(
    repository: &BlockMetaRepository,
    history: &History,
    external_history: &ExternalHistory,
    commit_versions: &CommitVersions,
    wave: usize,
    caller: usize,
    value: u64,
) -> u64 {
    let observation = external_history.invoke(caller, "write", value);
    history_invoke(history, caller, RegisterOperation::Write(value));
    let expected_block = value_block(value);
    let mut bytes = Vec::with_capacity(RANGE_BLOCKS * expected_block.len());
    for _ in 0..RANGE_BLOCKS {
        bytes.extend_from_slice(&expected_block);
    }
    let result = repository
        .commit_range_write(CommitRangeWriteRequest {
            volume_id: "history".to_owned(),
            writer_epoch: 1,
            op_id: format!("write-{wave}-{caller}"),
            offset: 0,
            bytes,
        })
        .expect("concurrent range write");
    let (first_sequence, last_sequence, block_count) = match result.outcome {
        RangeWriteOutcome::Applied {
            first_version,
            last_version,
            block_count,
            ..
        } => (first_version.sequence, last_version.sequence, block_count),
        RangeWriteOutcome::StaleEpoch { .. } => panic!("history writer became stale"),
    };
    assert!(!result.replayed);
    assert_eq!(block_count, RANGE_BLOCKS as u64);
    assert_eq!(result.commit_version, last_sequence);
    assert_eq!(last_sequence - first_sequence + 1, RANGE_BLOCKS as u64);
    record_commit(commit_versions, result.commit_version);
    history_return(history, caller, RegisterReturn::MutationOk);
    external_history.complete(observation, 0);
    last_sequence
}

fn run_discard(
    repository: &BlockMetaRepository,
    history: &History,
    external_history: &ExternalHistory,
    commit_versions: &CommitVersions,
    wave: usize,
    caller: usize,
) -> u64 {
    let observation = external_history.invoke(caller, "discard", 0);
    history_invoke(history, caller, RegisterOperation::Discard);
    let result = repository
        .commit_discard(DiscardRequest {
            volume_id: "history".to_owned(),
            writer_epoch: 1,
            op_id: format!("discard-{wave}-{caller}"),
            block_no: 0,
        })
        .expect("concurrent discard");
    let sequence = match result.outcome {
        WriteOutcome::Applied { version, .. } => version.sequence,
        WriteOutcome::StaleEpoch { .. } => panic!("history discard became stale"),
    };
    assert!(!result.replayed);
    assert_eq!(result.commit_version, sequence);
    record_commit(commit_versions, result.commit_version);
    history_return(history, caller, RegisterReturn::MutationOk);
    external_history.complete(observation, 0);
    sequence
}

fn run_read(
    repository: &BlockMetaRepository,
    history: &History,
    external_history: &ExternalHistory,
    caller: usize,
) {
    let observation = external_history.invoke(caller, "read", 0);
    history_invoke(history, caller, RegisterOperation::Read);
    let value = read_register(repository);
    history_return(history, caller, RegisterReturn::Read(value));
    external_history.complete(observation, value);
}

fn run_flush(
    repository: &BlockMetaRepository,
    history: &History,
    external_history: &ExternalHistory,
    commit_versions: &CommitVersions,
    wave: usize,
    caller: usize,
    covered_sequence: u64,
) {
    let observation = external_history.invoke(caller, "flush", 0);
    history_invoke(history, caller, RegisterOperation::Flush);
    let result = repository
        .capture_flush(FlushRequest {
            volume_id: "history".to_owned(),
            writer_epoch: 1,
            op_id: format!("flush-{wave}-{caller}"),
            submitted_sequence: covered_sequence,
        })
        .expect("concurrent flush");
    assert!(!result.replayed);
    assert_eq!(result.captured_sequence, covered_sequence);
    assert_eq!(result.stale_current_epoch, None);
    assert!(result.commit_version > covered_sequence);
    record_commit(commit_versions, result.commit_version);
    history_return(history, caller, RegisterReturn::FlushOk);
    external_history.complete(observation, 0);
}

impl ExternalHistory {
    fn invoke(&self, client_id: usize, kind: &'static str, value: u64) -> PendingObservation {
        PendingObservation {
            client_id,
            kind,
            value,
            call: self.tick(),
        }
    }

    fn complete(&self, pending: PendingObservation, output: u64) {
        let operation = ObservedOperation {
            client_id: pending.client_id,
            kind: pending.kind,
            value: pending.value,
            output,
            call: pending.call,
            r#return: self.tick(),
        };
        self.operations
            .lock()
            .expect("external history lock")
            .push(operation);
    }

    fn tick(&self) -> u64 {
        self.clock.fetch_add(1, Ordering::SeqCst) + 1
    }
}

fn write_external_history_if_requested(history: &ExternalHistory) {
    let Ok(path) = std::env::var("MINISANDBOX_PORCUPINE_HISTORY") else {
        return;
    };
    assert!(!path.is_empty(), "Porcupine history path must not be empty");
    let mut operations = history
        .operations
        .lock()
        .expect("external history lock")
        .clone();
    operations.sort_unstable_by_key(|operation| operation.call);
    assert_eq!(operations.len(), 96);
    let output = BufWriter::new(File::create(&path).expect("create Porcupine history"));
    serde_json::to_writer_pretty(output, &operations).expect("write Porcupine history");
    eprintln!(
        "MINISANDBOX_PORCUPINE_HISTORY_WRITTEN path={path} operations={}",
        operations.len()
    );
}

fn read_register(repository: &BlockMetaRepository) -> u64 {
    match repository
        .read_block_head("history", 0)
        .expect("read block register")
    {
        BlockData::Zero | BlockData::Discarded { .. } => 0,
        BlockData::Version {
            version,
            block_no,
            hot_bytes: Some(bytes),
            cold: None,
            ..
        } => {
            assert_eq!(version.epoch, 1);
            assert_eq!(block_no, 0);
            let encoded: [u8; 8] = bytes[..8].try_into().expect("encoded value ID");
            let value = u64::from_le_bytes(encoded);
            assert_ne!(value, 0);
            assert_eq!(bytes, value_block(value));
            value
        }
        BlockData::Version { .. } => panic!("history value left the hot tier unexpectedly"),
    }
}

fn value_block(value: u64) -> Vec<u8> {
    let block_size = usize::try_from(BLOCK_SIZE).expect("block size fits usize");
    let mut bytes = vec![value.to_le_bytes()[0].wrapping_mul(37); block_size];
    bytes[..8].copy_from_slice(&value.to_le_bytes());
    bytes
}

fn history_invoke(history: &History, caller: usize, operation: RegisterOperation) {
    history
        .lock()
        .expect("history lock")
        .on_invoke(caller, operation)
        .expect("record history invocation");
}

fn history_return(history: &History, caller: usize, result: RegisterReturn) {
    history
        .lock()
        .expect("history lock")
        .on_return(caller, result)
        .expect("record history return");
}

fn record_commit(commit_versions: &CommitVersions, version: u64) {
    commit_versions
        .lock()
        .expect("commit version lock")
        .push(version);
}
