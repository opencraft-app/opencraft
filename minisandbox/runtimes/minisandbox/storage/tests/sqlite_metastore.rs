//! Integration, process-crash, transport-disconnect, and history tests for the
//! `SQLite` `MetaStore` refinement.

use std::{
    io::{Read, Write},
    sync::{
        Arc, Barrier, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

#[cfg(all(unix, feature = "fault-injection"))]
use std::{
    path::Path,
    process::{Command, Stdio},
    time::Instant,
};

use minisandbox_storage_service::sqlite_metastore::{
    MetaStoreClient, MetaStoreError, MutationOutcome, OperationKind, PutRequest, ReadResult,
    RotateEpochRequest, SqliteMetaStore, SqliteMetaStoreConfig,
};
use rusqlite::{Connection, params};
use tempfile::TempDir;

const NAMESPACE: &str = "integration";
const KEY: &[u8] = b"key";

fn open_store(directory: &TempDir) -> SqliteMetaStore {
    SqliteMetaStore::open(SqliteMetaStoreConfig::new(directory.path().join("meta.db")))
        .expect("open SQLite MetaStore")
}

fn request(epoch: u64, op_id: &str, value: &[u8]) -> PutRequest {
    PutRequest {
        namespace: NAMESPACE.to_owned(),
        writer_epoch: epoch,
        op_id: op_id.to_owned(),
        key: KEY.to_vec(),
        value: value.to_vec(),
        expected_version: None,
    }
}

#[test]
fn schema_and_strong_typed_semantics() {
    let directory = TempDir::new().expect("temporary directory");
    let database = directory.path().join("meta.db");
    let store = open_store(&directory);
    let namespace = store.ensure_namespace(NAMESPACE).expect("create namespace");
    assert_eq!(namespace.writer_epoch, 1);
    assert_eq!(namespace.observed_commit_version, 1);

    let first_request = PutRequest {
        expected_version: Some(0),
        ..request(1, "put-1", b"first")
    };
    let first = store.put(first_request.clone()).expect("first put");
    assert_eq!(first.commit_version, 2);
    assert!(!first.replayed);
    assert_eq!(first.outcome, MutationOutcome::Applied { key_version: 2 });

    let replay = store.put(first_request.clone()).expect("replay first put");
    assert!(replay.replayed);
    assert_eq!(replay.commit_version, first.commit_version);
    assert_eq!(replay.outcome, first.outcome);

    let mut conflicting_identity = first_request;
    conflicting_identity.value = b"different".to_vec();
    assert_eq!(
        store.put(conflicting_identity),
        Err(MetaStoreError::OperationIdMismatch)
    );

    let read = store
        .read(NAMESPACE, KEY.to_vec())
        .expect("read first value");
    assert_eq!(read.observed_commit_version, 2);
    assert_eq!(
        read.value.expect("value"),
        minisandbox_storage_service::sqlite_metastore::VersionedValue {
            value: b"first".to_vec(),
            key_version: 2,
        }
    );

    let condition = store
        .put(PutRequest {
            expected_version: Some(0),
            ..request(1, "put-condition", b"must-not-apply")
        })
        .expect("durable condition result");
    assert_eq!(condition.commit_version, 3);
    assert_eq!(
        condition.outcome,
        MutationOutcome::ConditionFailed { current_version: 2 }
    );
    let condition_replay = store
        .put(PutRequest {
            expected_version: Some(0),
            ..request(1, "put-condition", b"must-not-apply")
        })
        .expect("condition replay");
    assert!(condition_replay.replayed);
    assert_eq!(condition_replay.commit_version, 3);

    let rotation = store
        .rotate_epoch(RotateEpochRequest {
            namespace: NAMESPACE.to_owned(),
            writer_epoch: 1,
            op_id: "rotate-1".to_owned(),
        })
        .expect("rotate epoch");
    assert_eq!(rotation.commit_version, 4);
    assert_eq!(
        rotation.outcome,
        MutationOutcome::EpochRotated { new_epoch: 2 }
    );

    let stale = store
        .put(request(1, "stale-put", b"must-not-apply"))
        .expect("durable stale result");
    assert_eq!(stale.commit_version, 5);
    assert_eq!(
        stale.outcome,
        MutationOutcome::StaleEpoch { current_epoch: 2 }
    );

    let current = store
        .put(request(2, "put-2", b"second"))
        .expect("current epoch put");
    assert_eq!(current.commit_version, 6);
    assert_eq!(
        store
            .lookup_operation(NAMESPACE, 2, "put-2")
            .expect("lookup")
            .expect("stored result")
            .operation_kind,
        OperationKind::Put
    );
    drop(store);

    assert_schema_constraints(&database);
}

fn assert_schema_constraints(database: &std::path::Path) {
    let connection = Connection::open(database).expect("inspect schema");
    let schema_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("schema version");
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("integrity check");
    let operation_count: i64 = connection
        .query_row("SELECT count(*) FROM op_results", [], |row| row.get(0))
        .expect("operation count");
    let invalid_kind_outcome = connection.execute(
        "INSERT INTO op_results(
             namespace, writer_epoch, op_id, request_fingerprint,
             operation_kind, commit_version, outcome_kind,
             key_version, observed_version, result_epoch
         ) VALUES (?1, 2, 'invalid-kind', ?2, 1, 7, 4, 0, 0, 3)",
        params![NAMESPACE, vec![0_u8; 32]],
    );
    let duplicate_commit_version = connection.execute(
        "INSERT INTO op_results(
             namespace, writer_epoch, op_id, request_fingerprint,
             operation_kind, commit_version, outcome_kind,
             key_version, observed_version, result_epoch
         ) VALUES (?1, 2, 'duplicate-version', ?2, 1, 6, 1, 6, 0, 0)",
        params![NAMESPACE, vec![0_u8; 32]],
    );
    assert_eq!(schema_version, 1);
    assert_eq!(integrity, "ok");
    assert_eq!(operation_count, 5);
    assert!(invalid_kind_outcome.is_err());
    assert!(duplicate_commit_version.is_err());
}

#[test]
fn concurrent_duplicate_requests_apply_once() {
    let directory = TempDir::new().expect("temporary directory");
    let store = open_store(&directory);
    let epoch = store
        .ensure_namespace(NAMESPACE)
        .expect("namespace")
        .writer_epoch;
    let client = store.client();
    let barrier = Arc::new(Barrier::new(17));
    let mut workers = Vec::new();
    for _ in 0..16 {
        let worker_client = client.clone();
        let worker_barrier = Arc::clone(&barrier);
        workers.push(thread::spawn(move || {
            worker_barrier.wait();
            worker_client.put(request(epoch, "duplicate", b"one-value"))
        }));
    }
    barrier.wait();

    let results = workers
        .into_iter()
        .map(|worker| worker.join().expect("worker").expect("put result"))
        .collect::<Vec<_>>();
    let commit_version = results[0].commit_version;
    assert!(
        results
            .iter()
            .all(|result| result.commit_version == commit_version)
    );
    assert_eq!(results.iter().filter(|result| !result.replayed).count(), 1);
    assert_eq!(
        store
            .read(NAMESPACE, KEY.to_vec())
            .expect("read")
            .value
            .expect("value")
            .value,
        b"one-value"
    );
}

#[cfg(unix)]
#[test]
fn unix_rpc_disconnect_does_not_cancel_queued_commit() {
    use std::os::unix::net::{UnixListener, UnixStream};

    let directory = TempDir::new().expect("temporary directory");
    let socket = directory.path().join("metastore.sock");
    let store = open_store(&directory);
    let epoch = store
        .ensure_namespace(NAMESPACE)
        .expect("namespace")
        .writer_epoch;
    let listener = UnixListener::bind(&socket).expect("bind socket");
    let server_client = store.client();
    let (observed_send, observed_receive) = mpsc::channel();

    let server = thread::spawn(move || {
        for index in 0..2 {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut trigger = [0_u8; 1];
            stream.read_exact(&mut trigger).expect("read trigger");
            let result = server_client
                .put(request(epoch, "socket-duplicate", b"socket-value"))
                .expect("socket put");
            observed_send.send(result.clone()).expect("record result");
            if index == 1 {
                stream
                    .write_all(&result.commit_version.to_be_bytes())
                    .expect("write second response");
            }
        }
    });

    let mut first = UnixStream::connect(&socket).expect("first connect");
    first.write_all(b"x").expect("first request");
    first
        .shutdown(std::net::Shutdown::Both)
        .expect("disconnect");
    drop(first);
    let first_result = observed_receive
        .recv_timeout(Duration::from_secs(5))
        .expect("first commit completed after disconnect");

    let mut second = UnixStream::connect(&socket).expect("second connect");
    second.write_all(b"x").expect("second request");
    let mut version = [0_u8; 8];
    second.read_exact(&mut version).expect("second response");
    let second_result = observed_receive
        .recv_timeout(Duration::from_secs(5))
        .expect("second result");
    server.join().expect("server");

    assert!(!first_result.replayed);
    assert!(second_result.replayed);
    assert_eq!(first_result.commit_version, second_result.commit_version);
    assert_eq!(u64::from_be_bytes(version), first_result.commit_version);
}

#[cfg(all(unix, feature = "fault-injection"))]
#[test]
fn sigkill_before_during_and_after_commit_recovers_atomically() {
    for (point, committed_before_kill) in [("before", false), ("during", false), ("after", true)] {
        run_crash_case(point, committed_before_kill);
    }
}

#[cfg(all(unix, feature = "fault-injection"))]
fn run_crash_case(point: &str, committed_before_kill: bool) {
    use std::os::unix::process::ExitStatusExt;

    let directory = TempDir::new().expect("temporary directory");
    let database = directory.path().join("meta.db");
    let marker = directory.path().join("stopped");
    let binary = env!("CARGO_BIN_EXE_minisandbox-storage-service");
    let mut child = Command::new(binary)
        .arg("__sqlite-crash-probe")
        .arg(&database)
        .arg(&marker)
        .arg(point)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn crash probe");
    wait_for_marker(&marker, &mut child);

    let pid = i32::try_from(child.id()).expect("PID fits i32");
    // SAFETY: the PID belongs to the child spawned immediately above.
    assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
    let status = child.wait().expect("wait for killed child");
    assert_eq!(status.signal(), Some(libc::SIGKILL), "crash point {point}");

    let store = SqliteMetaStore::open(SqliteMetaStoreConfig::new(&database))
        .expect("recover killed database");
    let namespace = store
        .ensure_namespace("crash-test")
        .expect("crash namespace survived");
    let before_retry = store
        .lookup_operation("crash-test", namespace.writer_epoch, "crash-op")
        .expect("lookup after crash");
    assert_eq!(before_retry.is_some(), committed_before_kill, "{point}");

    let retry = store
        .put(PutRequest {
            namespace: "crash-test".to_owned(),
            writer_epoch: namespace.writer_epoch,
            op_id: "crash-op".to_owned(),
            key: b"key".to_vec(),
            value: b"value".to_vec(),
            expected_version: Some(0),
        })
        .expect("retry after crash");
    assert_eq!(retry.replayed, committed_before_kill, "{point}");
    assert_eq!(
        store
            .read("crash-test", b"key".to_vec())
            .expect("read recovered value")
            .value
            .expect("recovered value")
            .value,
        b"value",
        "{point}"
    );
    drop(store);

    let connection = Connection::open(database).expect("inspect recovered database");
    let count: i64 = connection
        .query_row(
            "SELECT count(*) FROM op_results WHERE op_id = 'crash-op'",
            [],
            |row| row.get(0),
        )
        .expect("count crash op");
    assert_eq!(count, 1, "{point}");
}

#[cfg(all(unix, feature = "fault-injection"))]
fn wait_for_marker(marker: &Path, child: &mut std::process::Child) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if marker.exists() {
            return;
        }
        if let Some(status) = child.try_wait().expect("poll child") {
            let stderr = child
                .stderr
                .take()
                .map(|mut stderr| {
                    let mut text = String::new();
                    let _ = stderr.read_to_string(&mut text);
                    text
                })
                .unwrap_or_default();
            panic!("crash probe exited before marker: {status}; {stderr}");
        }
        assert!(Instant::now() < deadline, "timed out waiting for marker");
        thread::sleep(Duration::from_millis(10));
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum HistoryInput {
    Put(Vec<u8>),
    Read,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum HistoryOutput {
    Put,
    Read(Option<Vec<u8>>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct HistoryEntry {
    start: u64,
    end: u64,
    input: HistoryInput,
    output: HistoryOutput,
}

#[test]
fn concurrent_history_is_linearizable_by_an_independent_checker() {
    let directory = TempDir::new().expect("temporary directory");
    let store = open_store(&directory);
    let epoch = store
        .ensure_namespace(NAMESPACE)
        .expect("namespace")
        .writer_epoch;
    let clock = Arc::new(AtomicU64::new(1));
    let history = Arc::new(Mutex::new(Vec::new()));
    let client = store.client();

    run_history_wave(
        &client,
        epoch,
        0,
        vec![
            HistoryInput::Put(b"a".to_vec()),
            HistoryInput::Read,
            HistoryInput::Put(b"b".to_vec()),
            HistoryInput::Read,
        ],
        &clock,
        &history,
    );
    run_history_wave(
        &client,
        epoch,
        4,
        vec![
            HistoryInput::Read,
            HistoryInput::Put(b"c".to_vec()),
            HistoryInput::Read,
            HistoryInput::Put(b"d".to_vec()),
        ],
        &clock,
        &history,
    );

    let history = history.lock().expect("history lock").clone();
    assert_eq!(history.len(), 8);
    assert!(is_linearizable(&history), "non-linearizable: {history:#?}");
}

fn run_history_wave(
    client: &MetaStoreClient,
    epoch: u64,
    op_offset: usize,
    inputs: Vec<HistoryInput>,
    clock: &Arc<AtomicU64>,
    history: &Arc<Mutex<Vec<HistoryEntry>>>,
) {
    let barrier = Arc::new(Barrier::new(inputs.len()));
    let workers = inputs
        .into_iter()
        .enumerate()
        .map(|(index, input)| {
            let worker_client = client.clone();
            let worker_clock = Arc::clone(clock);
            let worker_history = Arc::clone(history);
            let worker_barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                let start = worker_clock.fetch_add(1, Ordering::SeqCst);
                worker_barrier.wait();
                let output = match &input {
                    HistoryInput::Put(value) => {
                        let result = worker_client
                            .put(request(
                                epoch,
                                &format!("history-{}", op_offset + index),
                                value,
                            ))
                            .expect("history put");
                        assert!(matches!(result.outcome, MutationOutcome::Applied { .. }));
                        HistoryOutput::Put
                    }
                    HistoryInput::Read => HistoryOutput::Read(read_value(
                        worker_client.read(NAMESPACE, KEY.to_vec()).expect("read"),
                    )),
                };
                let end = worker_clock.fetch_add(1, Ordering::SeqCst);
                worker_history
                    .lock()
                    .expect("history lock")
                    .push(HistoryEntry {
                        start,
                        end,
                        input,
                        output,
                    });
            })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        worker.join().expect("history worker");
    }
}

fn read_value(result: ReadResult) -> Option<Vec<u8>> {
    result.value.map(|value| value.value)
}

fn is_linearizable(history: &[HistoryEntry]) -> bool {
    assert!(history.len() <= 63, "bitmask checker bound");
    let mut predecessors = vec![0_u64; history.len()];
    for (before_index, before) in history.iter().enumerate() {
        for (after_index, after) in history.iter().enumerate() {
            if before.end < after.start {
                predecessors[after_index] |= 1_u64 << before_index;
            }
        }
    }
    search_linearization(history, &predecessors, 0, None)
}

fn search_linearization(
    history: &[HistoryEntry],
    predecessors: &[u64],
    placed: u64,
    register: Option<&[u8]>,
) -> bool {
    let all = (1_u64 << history.len()) - 1;
    if placed == all {
        return true;
    }
    for (index, entry) in history.iter().enumerate() {
        let bit = 1_u64 << index;
        if placed & bit != 0 || predecessors[index] & !placed != 0 {
            continue;
        }
        let next_register = match (&entry.input, &entry.output) {
            (HistoryInput::Put(value), HistoryOutput::Put) => Some(value.as_slice()),
            (HistoryInput::Read, HistoryOutput::Read(observed))
                if observed.as_deref() == register =>
            {
                register
            }
            _ => continue,
        };
        if search_linearization(history, predecessors, placed | bit, next_register) {
            return true;
        }
    }
    false
}
