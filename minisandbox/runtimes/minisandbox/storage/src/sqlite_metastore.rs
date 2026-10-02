//! `SQLite` refinement of the strongly consistent `MetaStore` contract.
//!
//! One actor owns one `SQLite` connection. Every public operation, including
//! reads, crosses the bounded actor queue. Mutations use `BEGIN IMMEDIATE` and
//! persist their operation result in the same transaction as their domain
//! changes, so transport retries cannot apply an operation twice.

use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, SyncSender},
    thread::{self, JoinHandle},
    time::Duration,
};

use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use sha2::{Digest, Sha256};
use thiserror::Error;

const SCHEMA_VERSION: i64 = 1;
const OPERATION_PUT: i64 = 1;
const OPERATION_ROTATE_EPOCH: i64 = 2;
const OUTCOME_APPLIED: i64 = 1;
const OUTCOME_CONDITION_FAILED: i64 = 2;
const OUTCOME_STALE_EPOCH: i64 = 3;
const OUTCOME_EPOCH_ROTATED: i64 = 4;

/// Maximum UTF-8 bytes accepted for a namespace identifier.
pub const MAX_NAMESPACE_BYTES: usize = 128;
/// Maximum UTF-8 bytes accepted for an operation identifier.
pub const MAX_OPERATION_ID_BYTES: usize = 128;
/// Maximum bytes accepted for one typed metadata key.
pub const MAX_KEY_BYTES: usize = 4 * 1024;
/// Maximum bytes accepted for one hot metadata value.
pub const MAX_VALUE_BYTES: usize = 128 * 1024;

/// Backend-neutral failures exposed by the `SQLite` `MetaStore` adapter.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum MetaStoreError {
    /// The actor or durable backend is unavailable.
    #[error("metastore unavailable")]
    Unavailable,
    /// The caller supplied an invalid or oversized field.
    #[error("invalid metastore request: {0}")]
    InvalidArgument(&'static str),
    /// The requested namespace has not been provisioned.
    #[error("metastore namespace does not exist")]
    NamespaceNotFound,
    /// One operation ID was reused for different request bytes.
    #[error("operation ID was reused for a different request")]
    OperationIdMismatch,
    /// Durable rows violate the schema-level protocol contract.
    #[error("metastore durable state is corrupt")]
    CorruptState,
    /// The actor thread terminated before completing the request.
    #[error("metastore actor stopped")]
    ActorStopped,
    /// A monotonically increasing counter cannot be represented safely.
    #[error("metastore version space exhausted")]
    VersionExhausted,
}

/// Configuration for one `SQLite`-backed `MetaStore` actor.
#[derive(Clone, Debug)]
pub struct SqliteMetaStoreConfig {
    path: PathBuf,
    queue_capacity: usize,
    busy_timeout: Duration,
    crash_probe: Option<CrashProbe>,
}

impl SqliteMetaStoreConfig {
    /// Creates a production configuration for a database file.
    #[must_use]
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            queue_capacity: 256,
            busy_timeout: Duration::from_secs(5),
            crash_probe: None,
        }
    }

    /// Sets the bounded actor queue capacity.
    #[must_use]
    pub const fn with_queue_capacity(mut self, queue_capacity: usize) -> Self {
        self.queue_capacity = queue_capacity;
        self
    }

    /// Sets `SQLite`'s lock wait timeout.
    #[must_use]
    pub const fn with_busy_timeout(mut self, busy_timeout: Duration) -> Self {
        self.busy_timeout = busy_timeout;
        self
    }

    /// Installs a deterministic process-stop probe for crash tests.
    ///
    /// This API is absent from default and release-oriented builds.
    #[cfg(feature = "fault-injection")]
    #[doc(hidden)]
    #[must_use]
    pub fn with_crash_probe(mut self, point: CrashPoint, marker: impl Into<PathBuf>) -> Self {
        self.crash_probe = Some(CrashProbe {
            point,
            marker: marker.into(),
        });
        self
    }
}

/// Deterministic locations used by the subprocess crash harness.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CrashPoint {
    /// Stop immediately before calling `SQLite` `COMMIT`.
    BeforeCommit,
    /// Stop from `SQLite`'s commit hook while `COMMIT` is executing.
    DuringCommit,
    /// Stop after durable `COMMIT` and before the actor sends its reply.
    AfterCommit,
}

impl CrashPoint {
    /// Parses the hidden crash-harness command-line value.
    ///
    /// # Errors
    ///
    /// Returns [`MetaStoreError::InvalidArgument`] for an unknown probe name.
    pub fn parse(value: &str) -> Result<Self, MetaStoreError> {
        match value {
            "before" => Ok(Self::BeforeCommit),
            "during" => Ok(Self::DuringCommit),
            "after" => Ok(Self::AfterCommit),
            _ => Err(MetaStoreError::InvalidArgument("unknown crash point")),
        }
    }

    const fn marker_name(self) -> &'static str {
        match self {
            Self::BeforeCommit => "before",
            Self::DuringCommit => "during",
            Self::AfterCommit => "after",
        }
    }
}

#[derive(Clone, Debug)]
struct CrashProbe {
    point: CrashPoint,
    marker: PathBuf,
}

/// One provisioned namespace and its current fencing epoch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NamespaceState {
    /// Current writer epoch.
    pub writer_epoch: u64,
    /// Latest global `MetaStore` commit visible with this response.
    pub observed_commit_version: u64,
}

/// One versioned value returned by a linearizable read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VersionedValue {
    /// Opaque typed metadata bytes.
    pub value: Vec<u8>,
    /// Commit version that last changed this key.
    pub key_version: u64,
}

/// Result of one linearizable read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadResult {
    /// Current namespace writer epoch.
    pub writer_epoch: u64,
    /// Global commit version of the read transaction.
    pub observed_commit_version: u64,
    /// Current value, or `None` when the key is absent.
    pub value: Option<VersionedValue>,
}

/// One idempotent put request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PutRequest {
    /// Typed metadata namespace.
    pub namespace: String,
    /// Writer fencing epoch carried by this request.
    pub writer_epoch: u64,
    /// Stable retry identity, scoped by namespace and writer epoch.
    pub op_id: String,
    /// Typed metadata key.
    pub key: Vec<u8>,
    /// New opaque value.
    pub value: Vec<u8>,
    /// Optional current key version; zero means the key must be absent.
    pub expected_version: Option<u64>,
}

/// One idempotent epoch-rotation request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RotateEpochRequest {
    /// Namespace whose writer is being replaced.
    pub namespace: String,
    /// Epoch the control plane believes is current.
    pub writer_epoch: u64,
    /// Stable retry identity.
    pub op_id: String,
}

/// Durable result of a mutating operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MutationOutcome {
    /// Domain mutation committed at this key version.
    Applied {
        /// Global commit version and new key version.
        key_version: u64,
    },
    /// Conditional mutation had no domain effect.
    ConditionFailed {
        /// Current key version observed by the transaction.
        current_version: u64,
    },
    /// Request carried a superseded writer epoch.
    StaleEpoch {
        /// Current durable namespace epoch.
        current_epoch: u64,
    },
    /// Writer epoch was advanced atomically.
    EpochRotated {
        /// Newly installed writer epoch.
        new_epoch: u64,
    },
}

/// Stable operation result returned to an original attempt or any retry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationResult {
    /// Commit that persisted the operation result and optional domain change.
    pub commit_version: u64,
    /// Whether this reply came from a pre-existing durable operation result.
    pub replayed: bool,
    /// Typed durable outcome.
    pub outcome: MutationOutcome,
}

/// Stored result returned by explicit unknown-outcome reconciliation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredOperationResult {
    /// Whether the operation was a put or epoch rotation.
    pub operation_kind: OperationKind,
    /// Durable result, marked as a replay.
    pub result: OperationResult,
}

/// Public operation classes stored in the durable result table.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationKind {
    /// Versioned key put.
    Put,
    /// Writer epoch rotation.
    RotateEpoch,
}

/// Cloneable client handle for the bounded `SQLite` actor.
#[derive(Clone, Debug)]
pub struct MetaStoreClient {
    sender: SyncSender<Command>,
}

impl MetaStoreClient {
    /// Creates the namespace if absent and returns its current epoch.
    ///
    /// # Errors
    ///
    /// Returns a validation, durability, or actor-lifecycle error.
    pub fn ensure_namespace(
        &self,
        namespace: impl Into<String>,
    ) -> Result<NamespaceState, MetaStoreError> {
        let (reply, receive) = mpsc::sync_channel(1);
        self.send(Command::EnsureNamespace {
            namespace: namespace.into(),
            reply,
        })?;
        receive_reply(&receive)
    }

    /// Applies or replays one idempotent versioned put.
    ///
    /// # Errors
    ///
    /// Returns a validation, fencing, durability, or actor-lifecycle error.
    pub fn put(&self, request: PutRequest) -> Result<OperationResult, MetaStoreError> {
        let receive = self.submit_put(request)?;
        receive_reply(&receive)
    }

    /// Submits a put without requiring the caller to retain the response.
    ///
    /// Dropping the returned receiver models an RPC disconnect. It does not
    /// cancel work already queued in the actor.
    ///
    /// # Errors
    ///
    /// Returns [`MetaStoreError::ActorStopped`] if the actor is gone.
    pub fn submit_put(
        &self,
        request: PutRequest,
    ) -> Result<Receiver<Result<OperationResult, MetaStoreError>>, MetaStoreError> {
        let (reply, receive) = mpsc::sync_channel(1);
        self.send(Command::Put { request, reply })?;
        Ok(receive)
    }

    /// Reads one key through a fresh actor-ordered `SQLite` read transaction.
    ///
    /// # Errors
    ///
    /// Returns a validation, durability, or actor-lifecycle error.
    pub fn read(
        &self,
        namespace: impl Into<String>,
        key: Vec<u8>,
    ) -> Result<ReadResult, MetaStoreError> {
        let (reply, receive) = mpsc::sync_channel(1);
        self.send(Command::Read {
            namespace: namespace.into(),
            key,
            reply,
        })?;
        receive_reply(&receive)
    }

    /// Atomically replaces a writer epoch or replays its durable result.
    ///
    /// # Errors
    ///
    /// Returns a validation, fencing, durability, or actor-lifecycle error.
    pub fn rotate_epoch(
        &self,
        request: RotateEpochRequest,
    ) -> Result<OperationResult, MetaStoreError> {
        let (reply, receive) = mpsc::sync_channel(1);
        self.send(Command::RotateEpoch { request, reply })?;
        receive_reply(&receive)
    }

    /// Reconciles a request whose transport-level result was unknown.
    ///
    /// # Errors
    ///
    /// Returns a validation, durability, or actor-lifecycle error.
    pub fn lookup_operation(
        &self,
        namespace: impl Into<String>,
        writer_epoch: u64,
        op_id: impl Into<String>,
    ) -> Result<Option<StoredOperationResult>, MetaStoreError> {
        let (reply, receive) = mpsc::sync_channel(1);
        self.send(Command::LookupOperation {
            namespace: namespace.into(),
            writer_epoch,
            op_id: op_id.into(),
            reply,
        })?;
        receive_reply(&receive)
    }

    fn send(&self, command: Command) -> Result<(), MetaStoreError> {
        self.sender
            .send(command)
            .map_err(|_| MetaStoreError::ActorStopped)
    }
}

/// Owned `SQLite` actor. Dropping it drains earlier commands and joins the thread.
#[derive(Debug)]
pub struct SqliteMetaStore {
    client: MetaStoreClient,
    actor: Option<JoinHandle<()>>,
}

impl SqliteMetaStore {
    /// Opens, migrates, and validates one `SQLite` `MetaStore` database.
    ///
    /// # Errors
    ///
    /// Returns an error if configuration, schema migration, or backend
    /// validation fails.
    pub fn open(config: SqliteMetaStoreConfig) -> Result<Self, MetaStoreError> {
        if config.queue_capacity == 0 {
            return Err(MetaStoreError::InvalidArgument(
                "queue capacity must be non-zero",
            ));
        }
        let (sender, receiver) = mpsc::sync_channel(config.queue_capacity);
        let (ready, initialized) = mpsc::sync_channel(1);
        let actor = thread::Builder::new()
            .name("minisandbox-sqlite-metastore".to_owned())
            .spawn(move || run_actor(&config, &receiver, &ready))
            .map_err(|_| MetaStoreError::Unavailable)?;

        match initialized.recv() {
            Ok(Ok(())) => Ok(Self {
                client: MetaStoreClient { sender },
                actor: Some(actor),
            }),
            Ok(Err(error)) => {
                let _ = actor.join();
                Err(error)
            }
            Err(_) => {
                let _ = actor.join();
                Err(MetaStoreError::Unavailable)
            }
        }
    }

    /// Returns a cloneable client handle.
    #[must_use]
    pub fn client(&self) -> MetaStoreClient {
        self.client.clone()
    }

    /// Creates the namespace if absent and returns its current epoch.
    ///
    /// # Errors
    ///
    /// Returns a validation, durability, or actor-lifecycle error.
    pub fn ensure_namespace(
        &self,
        namespace: impl Into<String>,
    ) -> Result<NamespaceState, MetaStoreError> {
        self.client.ensure_namespace(namespace)
    }

    /// Applies or replays one idempotent put.
    ///
    /// # Errors
    ///
    /// Returns a validation, fencing, durability, or actor-lifecycle error.
    pub fn put(&self, request: PutRequest) -> Result<OperationResult, MetaStoreError> {
        self.client.put(request)
    }

    /// Reads one key linearly ordered by the actor.
    ///
    /// # Errors
    ///
    /// Returns a validation, durability, or actor-lifecycle error.
    pub fn read(
        &self,
        namespace: impl Into<String>,
        key: Vec<u8>,
    ) -> Result<ReadResult, MetaStoreError> {
        self.client.read(namespace, key)
    }

    /// Rotates a writer epoch atomically.
    ///
    /// # Errors
    ///
    /// Returns a validation, fencing, durability, or actor-lifecycle error.
    pub fn rotate_epoch(
        &self,
        request: RotateEpochRequest,
    ) -> Result<OperationResult, MetaStoreError> {
        self.client.rotate_epoch(request)
    }

    /// Looks up a durable operation result.
    ///
    /// # Errors
    ///
    /// Returns a validation, durability, or actor-lifecycle error.
    pub fn lookup_operation(
        &self,
        namespace: impl Into<String>,
        writer_epoch: u64,
        op_id: impl Into<String>,
    ) -> Result<Option<StoredOperationResult>, MetaStoreError> {
        self.client.lookup_operation(namespace, writer_epoch, op_id)
    }
}

impl Drop for SqliteMetaStore {
    fn drop(&mut self) {
        let _ = self.client.sender.send(Command::Shutdown);
        if let Some(actor) = self.actor.take() {
            let _ = actor.join();
        }
    }
}

#[derive(Debug)]
enum Command {
    EnsureNamespace {
        namespace: String,
        reply: SyncSender<Result<NamespaceState, MetaStoreError>>,
    },
    Put {
        request: PutRequest,
        reply: SyncSender<Result<OperationResult, MetaStoreError>>,
    },
    Read {
        namespace: String,
        key: Vec<u8>,
        reply: SyncSender<Result<ReadResult, MetaStoreError>>,
    },
    RotateEpoch {
        request: RotateEpochRequest,
        reply: SyncSender<Result<OperationResult, MetaStoreError>>,
    },
    LookupOperation {
        namespace: String,
        writer_epoch: u64,
        op_id: String,
        reply: SyncSender<Result<Option<StoredOperationResult>, MetaStoreError>>,
    },
    Shutdown,
}

fn receive_reply<T>(receive: &Receiver<Result<T, MetaStoreError>>) -> Result<T, MetaStoreError> {
    receive.recv().map_err(|_| MetaStoreError::ActorStopped)?
}

fn run_actor(
    config: &SqliteMetaStoreConfig,
    receiver: &Receiver<Command>,
    ready: &SyncSender<Result<(), MetaStoreError>>,
) {
    let mut connection = match open_connection(config) {
        Ok(connection) => {
            let _ = ready.send(Ok(()));
            connection
        }
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };

    while let Ok(command) = receiver.recv() {
        match command {
            Command::EnsureNamespace { namespace, reply } => {
                let _ = reply.send(ensure_namespace(&mut connection, &namespace));
            }
            Command::Put { request, reply } => {
                let result = put(&mut connection, &request, config.crash_probe.as_ref());
                let _ = reply.send(result);
            }
            Command::Read {
                namespace,
                key,
                reply,
            } => {
                let _ = reply.send(read(&mut connection, &namespace, &key));
            }
            Command::RotateEpoch { request, reply } => {
                let _ = reply.send(rotate_epoch(&mut connection, &request));
            }
            Command::LookupOperation {
                namespace,
                writer_epoch,
                op_id,
                reply,
            } => {
                let _ = reply.send(lookup_operation(
                    &mut connection,
                    &namespace,
                    writer_epoch,
                    &op_id,
                ));
            }
            Command::Shutdown => break,
        }
    }
}

fn open_connection(config: &SqliteMetaStoreConfig) -> Result<Connection, MetaStoreError> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let mut connection = db(Connection::open_with_flags(&config.path, flags))?;
    db(connection.busy_timeout(config.busy_timeout))?;
    db(connection.pragma_update(None, "foreign_keys", "ON"))?;
    db(connection.pragma_update(None, "trusted_schema", "OFF"))?;
    let journal_mode: String =
        db(connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0)))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(MetaStoreError::Unavailable);
    }
    db(connection.pragma_update(None, "synchronous", "FULL"))?;
    db(connection.pragma_update(None, "temp_store", "MEMORY"))?;
    migrate(&mut connection)?;
    validate_connection(&connection)?;
    Ok(connection)
}

fn migrate(connection: &mut Connection) -> Result<(), MetaStoreError> {
    let version: i64 = db(connection.query_row("PRAGMA user_version", [], |row| row.get(0)))?;
    match version {
        0 => db(connection.execute_batch(
            "BEGIN EXCLUSIVE;
             CREATE TABLE store_state (
                 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                 commit_version INTEGER NOT NULL CHECK (commit_version >= 0)
             ) STRICT;
             INSERT INTO store_state(singleton, commit_version) VALUES (1, 0);

             CREATE TABLE namespaces (
                 namespace TEXT PRIMARY KEY,
                 writer_epoch INTEGER NOT NULL CHECK (writer_epoch > 0),
                 updated_commit_version INTEGER NOT NULL
                     CHECK (updated_commit_version > 0)
             ) STRICT;

             CREATE TABLE kv (
                 namespace TEXT NOT NULL
                     REFERENCES namespaces(namespace) ON DELETE CASCADE,
                 key BLOB NOT NULL,
                 value BLOB NOT NULL,
                 key_version INTEGER NOT NULL CHECK (key_version > 0),
                 PRIMARY KEY(namespace, key)
             ) WITHOUT ROWID, STRICT;

             CREATE TABLE op_results (
                 namespace TEXT NOT NULL
                     REFERENCES namespaces(namespace) ON DELETE CASCADE,
                 writer_epoch INTEGER NOT NULL CHECK (writer_epoch > 0),
                 op_id TEXT NOT NULL,
                 request_fingerprint BLOB NOT NULL
                     CHECK (length(request_fingerprint) = 32),
                 operation_kind INTEGER NOT NULL
                     CHECK (operation_kind IN (1, 2)),
                 commit_version INTEGER NOT NULL CHECK (commit_version > 0),
                 outcome_kind INTEGER NOT NULL
                     CHECK (outcome_kind IN (1, 2, 3, 4)),
                 key_version INTEGER NOT NULL CHECK (key_version >= 0),
                 observed_version INTEGER NOT NULL CHECK (observed_version >= 0),
                 result_epoch INTEGER NOT NULL CHECK (result_epoch >= 0),
                 PRIMARY KEY(namespace, writer_epoch, op_id),
                 UNIQUE(commit_version),
                 CHECK (
                     (operation_kind = 1 AND outcome_kind IN (1, 2, 3)) OR
                     (operation_kind = 2 AND outcome_kind IN (3, 4))
                 ),
                 CHECK (
                     (outcome_kind = 1 AND key_version > 0 AND
                         observed_version = 0 AND result_epoch = 0) OR
                     (outcome_kind = 2 AND key_version = 0 AND
                         result_epoch = 0) OR
                     (outcome_kind = 3 AND key_version = 0 AND
                         observed_version = 0 AND result_epoch > 0) OR
                     (outcome_kind = 4 AND key_version = 0 AND
                         observed_version = 0 AND result_epoch > 0)
                 )
             ) WITHOUT ROWID, STRICT;

             PRAGMA user_version = 1;
             COMMIT;",
        )),
        SCHEMA_VERSION => Ok(()),
        _ => Err(MetaStoreError::CorruptState),
    }
}

fn validate_connection(connection: &Connection) -> Result<(), MetaStoreError> {
    let foreign_keys: i64 = db(connection.query_row("PRAGMA foreign_keys", [], |row| row.get(0)))?;
    let synchronous: i64 = db(connection.query_row("PRAGMA synchronous", [], |row| row.get(0)))?;
    let singleton_count: i64 = db(connection.query_row(
        "SELECT count(*) FROM store_state WHERE singleton = 1",
        [],
        |row| row.get(0),
    ))?;
    if foreign_keys != 1 || synchronous != 2 || singleton_count != 1 {
        return Err(MetaStoreError::CorruptState);
    }
    Ok(())
}

fn ensure_namespace(
    connection: &mut Connection,
    namespace: &str,
) -> Result<NamespaceState, MetaStoreError> {
    validate_identifier(namespace, MAX_NAMESPACE_BYTES, "invalid namespace")?;
    let transaction = immediate(connection)?;
    let existing = db(transaction
        .query_row(
            "SELECT writer_epoch FROM namespaces WHERE namespace = ?1",
            [namespace],
            |row| row.get::<_, i64>(0),
        )
        .optional())?;
    if let Some(writer_epoch) = existing {
        let observed_commit_version = current_commit_version(&transaction)?;
        commit(transaction)?;
        return Ok(NamespaceState {
            writer_epoch: positive_u64(writer_epoch)?,
            observed_commit_version,
        });
    }

    let commit_version = allocate_commit_version(&transaction)?;
    db(transaction.execute(
        "INSERT INTO namespaces(namespace, writer_epoch, updated_commit_version)
         VALUES (?1, 1, ?2)",
        params![namespace, sql_u64(commit_version)?],
    ))?;
    commit(transaction)?;
    Ok(NamespaceState {
        writer_epoch: 1,
        observed_commit_version: commit_version,
    })
}

fn put(
    connection: &mut Connection,
    request: &PutRequest,
    crash_probe: Option<&CrashProbe>,
) -> Result<OperationResult, MetaStoreError> {
    validate_put(request)?;
    let fingerprint = put_fingerprint(request);
    let during_probe = crash_probe.filter(|probe| probe.point == CrashPoint::DuringCommit);
    if let Some(probe) = during_probe {
        let marker = probe.marker.clone();
        connection.commit_hook(Some(move || {
            stop_for_crash_probe(&marker, CrashPoint::DuringCommit);
            false
        }));
    }

    let result = put_transaction(connection, request, &fingerprint, crash_probe);
    if during_probe.is_some() {
        connection.commit_hook(None::<fn() -> bool>);
    }
    result
}

fn put_transaction(
    connection: &mut Connection,
    request: &PutRequest,
    fingerprint: &[u8; 32],
    crash_probe: Option<&CrashProbe>,
) -> Result<OperationResult, MetaStoreError> {
    let transaction = immediate(connection)?;
    if let Some(stored) = load_operation(
        &transaction,
        &request.namespace,
        request.writer_epoch,
        &request.op_id,
    )? {
        verify_replay(&stored, OperationKind::Put, fingerprint)?;
        commit(transaction)?;
        return Ok(stored.result);
    }

    let current_epoch = namespace_epoch(&transaction, &request.namespace)?;
    let current_key_version = key_version(&transaction, &request.namespace, &request.key)?;
    let commit_version = allocate_commit_version(&transaction)?;
    let outcome = if request.writer_epoch != current_epoch {
        MutationOutcome::StaleEpoch { current_epoch }
    } else if request
        .expected_version
        .is_some_and(|expected| expected != current_key_version)
    {
        MutationOutcome::ConditionFailed {
            current_version: current_key_version,
        }
    } else {
        db(transaction.execute(
            "INSERT INTO kv(namespace, key, value, key_version)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(namespace, key) DO UPDATE SET
                 value = excluded.value,
                 key_version = excluded.key_version",
            params![
                request.namespace,
                request.key,
                request.value,
                sql_u64(commit_version)?
            ],
        ))?;
        MutationOutcome::Applied {
            key_version: commit_version,
        }
    };

    insert_operation(
        &transaction,
        &request.namespace,
        request.writer_epoch,
        &request.op_id,
        fingerprint,
        OperationKind::Put,
        commit_version,
        &outcome,
    )?;

    if crash_probe.is_some_and(|probe| probe.point == CrashPoint::BeforeCommit) {
        let probe = crash_probe.expect("probe checked above");
        stop_for_crash_probe(&probe.marker, CrashPoint::BeforeCommit);
    }
    commit(transaction)?;
    if crash_probe.is_some_and(|probe| probe.point == CrashPoint::AfterCommit) {
        let probe = crash_probe.expect("probe checked above");
        stop_for_crash_probe(&probe.marker, CrashPoint::AfterCommit);
    }

    Ok(OperationResult {
        commit_version,
        replayed: false,
        outcome,
    })
}

fn read(
    connection: &mut Connection,
    namespace: &str,
    key: &[u8],
) -> Result<ReadResult, MetaStoreError> {
    validate_identifier(namespace, MAX_NAMESPACE_BYTES, "invalid namespace")?;
    validate_bytes(key, MAX_KEY_BYTES, false, "invalid key")?;
    let transaction = db(connection.transaction_with_behavior(TransactionBehavior::Deferred))?;
    let observed_commit_version = current_commit_version(&transaction)?;
    let writer_epoch = namespace_epoch(&transaction, namespace)?;
    let value = db(transaction
        .query_row(
            "SELECT value, key_version FROM kv
             WHERE namespace = ?1 AND key = ?2",
            params![namespace, key],
            |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional())?
    .map(|(value, key_version)| {
        Ok(VersionedValue {
            value,
            key_version: positive_u64(key_version)?,
        })
    })
    .transpose()?;
    commit(transaction)?;
    Ok(ReadResult {
        writer_epoch,
        observed_commit_version,
        value,
    })
}

fn rotate_epoch(
    connection: &mut Connection,
    request: &RotateEpochRequest,
) -> Result<OperationResult, MetaStoreError> {
    validate_identifier(&request.namespace, MAX_NAMESPACE_BYTES, "invalid namespace")?;
    validate_identifier(
        &request.op_id,
        MAX_OPERATION_ID_BYTES,
        "invalid operation ID",
    )?;
    if request.writer_epoch == 0 {
        return Err(MetaStoreError::InvalidArgument(
            "writer epoch must be non-zero",
        ));
    }
    let fingerprint = rotate_fingerprint(request);
    let transaction = immediate(connection)?;
    if let Some(stored) = load_operation(
        &transaction,
        &request.namespace,
        request.writer_epoch,
        &request.op_id,
    )? {
        verify_replay(&stored, OperationKind::RotateEpoch, &fingerprint)?;
        commit(transaction)?;
        return Ok(stored.result);
    }

    let current_epoch = namespace_epoch(&transaction, &request.namespace)?;
    let commit_version = allocate_commit_version(&transaction)?;
    let outcome = if request.writer_epoch == current_epoch {
        let new_epoch = current_epoch
            .checked_add(1)
            .ok_or(MetaStoreError::VersionExhausted)?;
        db(transaction.execute(
            "UPDATE namespaces
             SET writer_epoch = ?2, updated_commit_version = ?3
             WHERE namespace = ?1",
            params![
                request.namespace,
                sql_u64(new_epoch)?,
                sql_u64(commit_version)?
            ],
        ))?;
        MutationOutcome::EpochRotated { new_epoch }
    } else {
        MutationOutcome::StaleEpoch { current_epoch }
    };
    insert_operation(
        &transaction,
        &request.namespace,
        request.writer_epoch,
        &request.op_id,
        &fingerprint,
        OperationKind::RotateEpoch,
        commit_version,
        &outcome,
    )?;
    commit(transaction)?;
    Ok(OperationResult {
        commit_version,
        replayed: false,
        outcome,
    })
}

fn lookup_operation(
    connection: &mut Connection,
    namespace: &str,
    writer_epoch: u64,
    op_id: &str,
) -> Result<Option<StoredOperationResult>, MetaStoreError> {
    validate_identifier(namespace, MAX_NAMESPACE_BYTES, "invalid namespace")?;
    validate_identifier(op_id, MAX_OPERATION_ID_BYTES, "invalid operation ID")?;
    if writer_epoch == 0 {
        return Err(MetaStoreError::InvalidArgument(
            "writer epoch must be non-zero",
        ));
    }
    let transaction = db(connection.transaction_with_behavior(TransactionBehavior::Deferred))?;
    let result = load_operation(&transaction, namespace, writer_epoch, op_id)?.map(|stored| {
        StoredOperationResult {
            operation_kind: stored.operation_kind,
            result: stored.result,
        }
    });
    commit(transaction)?;
    Ok(result)
}

fn immediate(connection: &mut Connection) -> Result<Transaction<'_>, MetaStoreError> {
    db(connection.transaction_with_behavior(TransactionBehavior::Immediate))
}

fn commit(transaction: Transaction<'_>) -> Result<(), MetaStoreError> {
    db(transaction.commit())
}

fn current_commit_version(transaction: &Transaction<'_>) -> Result<u64, MetaStoreError> {
    let value: i64 = db(transaction.query_row(
        "SELECT commit_version FROM store_state WHERE singleton = 1",
        [],
        |row| row.get(0),
    ))?;
    nonnegative_u64(value)
}

fn allocate_commit_version(transaction: &Transaction<'_>) -> Result<u64, MetaStoreError> {
    let next = current_commit_version(transaction)?
        .checked_add(1)
        .ok_or(MetaStoreError::VersionExhausted)?;
    db(transaction.execute(
        "UPDATE store_state SET commit_version = ?1 WHERE singleton = 1",
        [sql_u64(next)?],
    ))?;
    Ok(next)
}

fn namespace_epoch(transaction: &Transaction<'_>, namespace: &str) -> Result<u64, MetaStoreError> {
    let epoch = db(transaction
        .query_row(
            "SELECT writer_epoch FROM namespaces WHERE namespace = ?1",
            [namespace],
            |row| row.get::<_, i64>(0),
        )
        .optional())?
    .ok_or(MetaStoreError::NamespaceNotFound)?;
    positive_u64(epoch)
}

fn key_version(
    transaction: &Transaction<'_>,
    namespace: &str,
    key: &[u8],
) -> Result<u64, MetaStoreError> {
    let version = db(transaction
        .query_row(
            "SELECT key_version FROM kv WHERE namespace = ?1 AND key = ?2",
            params![namespace, key],
            |row| row.get::<_, i64>(0),
        )
        .optional())?;
    version.map_or(Ok(0), positive_u64)
}

#[derive(Debug)]
struct LoadedOperation {
    fingerprint: Vec<u8>,
    operation_kind: OperationKind,
    result: OperationResult,
}

fn load_operation(
    transaction: &Transaction<'_>,
    namespace: &str,
    writer_epoch: u64,
    op_id: &str,
) -> Result<Option<LoadedOperation>, MetaStoreError> {
    let row = db(transaction
        .query_row(
            "SELECT request_fingerprint, operation_kind, commit_version,
                    outcome_kind, key_version, observed_version, result_epoch
             FROM op_results
             WHERE namespace = ?1 AND writer_epoch = ?2 AND op_id = ?3",
            params![namespace, sql_u64(writer_epoch)?, op_id],
            |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            },
        )
        .optional())?;
    row.map(decode_operation).transpose()
}

fn decode_operation(
    row: (Vec<u8>, i64, i64, i64, i64, i64, i64),
) -> Result<LoadedOperation, MetaStoreError> {
    let (fingerprint, operation_kind, commit_version, outcome, key, observed, epoch) = row;
    if fingerprint.len() != 32 {
        return Err(MetaStoreError::CorruptState);
    }
    let operation_kind = match operation_kind {
        OPERATION_PUT => OperationKind::Put,
        OPERATION_ROTATE_EPOCH => OperationKind::RotateEpoch,
        _ => return Err(MetaStoreError::CorruptState),
    };
    let outcome = match outcome {
        OUTCOME_APPLIED => MutationOutcome::Applied {
            key_version: positive_u64(key)?,
        },
        OUTCOME_CONDITION_FAILED => MutationOutcome::ConditionFailed {
            current_version: nonnegative_u64(observed)?,
        },
        OUTCOME_STALE_EPOCH => MutationOutcome::StaleEpoch {
            current_epoch: positive_u64(epoch)?,
        },
        OUTCOME_EPOCH_ROTATED => MutationOutcome::EpochRotated {
            new_epoch: positive_u64(epoch)?,
        },
        _ => return Err(MetaStoreError::CorruptState),
    };
    Ok(LoadedOperation {
        fingerprint,
        operation_kind,
        result: OperationResult {
            commit_version: positive_u64(commit_version)?,
            replayed: true,
            outcome,
        },
    })
}

fn verify_replay(
    stored: &LoadedOperation,
    expected_kind: OperationKind,
    fingerprint: &[u8; 32],
) -> Result<(), MetaStoreError> {
    if stored.operation_kind != expected_kind || stored.fingerprint.as_slice() != fingerprint {
        return Err(MetaStoreError::OperationIdMismatch);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_operation(
    transaction: &Transaction<'_>,
    namespace: &str,
    writer_epoch: u64,
    op_id: &str,
    fingerprint: &[u8; 32],
    operation_kind: OperationKind,
    commit_version: u64,
    outcome: &MutationOutcome,
) -> Result<(), MetaStoreError> {
    let (outcome_kind, key_version, observed_version, result_epoch) = match outcome {
        MutationOutcome::Applied { key_version } => (OUTCOME_APPLIED, *key_version, 0, 0),
        MutationOutcome::ConditionFailed { current_version } => {
            (OUTCOME_CONDITION_FAILED, 0, *current_version, 0)
        }
        MutationOutcome::StaleEpoch { current_epoch } => {
            (OUTCOME_STALE_EPOCH, 0, 0, *current_epoch)
        }
        MutationOutcome::EpochRotated { new_epoch } => (OUTCOME_EPOCH_ROTATED, 0, 0, *new_epoch),
    };
    db(transaction.execute(
        "INSERT INTO op_results(
             namespace, writer_epoch, op_id, request_fingerprint,
             operation_kind, commit_version, outcome_kind,
             key_version, observed_version, result_epoch
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            namespace,
            sql_u64(writer_epoch)?,
            op_id,
            fingerprint.as_slice(),
            match operation_kind {
                OperationKind::Put => OPERATION_PUT,
                OperationKind::RotateEpoch => OPERATION_ROTATE_EPOCH,
            },
            sql_u64(commit_version)?,
            outcome_kind,
            sql_u64(key_version)?,
            sql_u64(observed_version)?,
            sql_u64(result_epoch)?,
        ],
    ))?;
    Ok(())
}

fn validate_put(request: &PutRequest) -> Result<(), MetaStoreError> {
    validate_identifier(&request.namespace, MAX_NAMESPACE_BYTES, "invalid namespace")?;
    validate_identifier(
        &request.op_id,
        MAX_OPERATION_ID_BYTES,
        "invalid operation ID",
    )?;
    validate_bytes(&request.key, MAX_KEY_BYTES, false, "invalid key")?;
    validate_bytes(&request.value, MAX_VALUE_BYTES, true, "invalid value")?;
    if request.writer_epoch == 0 {
        return Err(MetaStoreError::InvalidArgument(
            "writer epoch must be non-zero",
        ));
    }
    if request
        .expected_version
        .is_some_and(|version| version > i64::MAX as u64)
    {
        return Err(MetaStoreError::InvalidArgument(
            "expected version is too large",
        ));
    }
    Ok(())
}

fn validate_identifier(
    value: &str,
    max_bytes: usize,
    message: &'static str,
) -> Result<(), MetaStoreError> {
    if value.is_empty() || value.len() > max_bytes || value.as_bytes().contains(&0) {
        return Err(MetaStoreError::InvalidArgument(message));
    }
    Ok(())
}

fn validate_bytes(
    value: &[u8],
    max_bytes: usize,
    empty_allowed: bool,
    message: &'static str,
) -> Result<(), MetaStoreError> {
    if (!empty_allowed && value.is_empty()) || value.len() > max_bytes {
        return Err(MetaStoreError::InvalidArgument(message));
    }
    Ok(())
}

fn put_fingerprint(request: &PutRequest) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"minisandbox.metastore.put.v1\0");
    hash_part(&mut hash, request.namespace.as_bytes());
    hash.update(request.writer_epoch.to_be_bytes());
    hash_part(&mut hash, request.op_id.as_bytes());
    hash_part(&mut hash, &request.key);
    match request.expected_version {
        Some(version) => {
            hash.update([1]);
            hash.update(version.to_be_bytes());
        }
        None => hash.update([0]),
    }
    hash_part(&mut hash, &request.value);
    hash.finalize().into()
}

fn rotate_fingerprint(request: &RotateEpochRequest) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"minisandbox.metastore.rotate-epoch.v1\0");
    hash_part(&mut hash, request.namespace.as_bytes());
    hash.update(request.writer_epoch.to_be_bytes());
    hash_part(&mut hash, request.op_id.as_bytes());
    hash.finalize().into()
}

fn hash_part(hash: &mut Sha256, value: &[u8]) {
    let length = u64::try_from(value.len()).expect("usize fits into u64");
    hash.update(length.to_be_bytes());
    hash.update(value);
}

fn sql_u64(value: u64) -> Result<i64, MetaStoreError> {
    i64::try_from(value).map_err(|_| MetaStoreError::VersionExhausted)
}

fn positive_u64(value: i64) -> Result<u64, MetaStoreError> {
    if value <= 0 {
        return Err(MetaStoreError::CorruptState);
    }
    u64::try_from(value).map_err(|_| MetaStoreError::CorruptState)
}

fn nonnegative_u64(value: i64) -> Result<u64, MetaStoreError> {
    u64::try_from(value).map_err(|_| MetaStoreError::CorruptState)
}

fn db<T>(result: rusqlite::Result<T>) -> Result<T, MetaStoreError> {
    result.map_err(|_| MetaStoreError::Unavailable)
}

fn stop_for_crash_probe(marker: &Path, point: CrashPoint) {
    let result = (|| -> std::io::Result<()> {
        let mut file = File::create(marker)?;
        file.write_all(point.marker_name().as_bytes())?;
        file.sync_all()
    })();
    if result.is_err() {
        std::process::abort();
    }

    #[cfg(unix)]
    {
        // SAFETY: raising SIGSTOP for the current process has no memory-safety
        // preconditions. The external crash harness follows with SIGKILL.
        let status = unsafe { libc::raise(libc::SIGSTOP) };
        if status != 0 {
            std::process::abort();
        }
    }
    #[cfg(not(unix))]
    std::process::abort();
}

/// Runs the hidden subprocess crash probe used by integration tests.
///
/// This function is compiled only for explicit fault-injection builds.
///
/// # Errors
///
/// Returns an actor or backend error if the probe cannot reach its stop point.
#[cfg(feature = "fault-injection")]
#[doc(hidden)]
pub fn run_crash_probe(
    database: &Path,
    marker: &Path,
    point: CrashPoint,
) -> Result<(), MetaStoreError> {
    let store = SqliteMetaStore::open(
        SqliteMetaStoreConfig::new(database).with_crash_probe(point, marker),
    )?;
    let namespace = store.ensure_namespace("crash-test")?;
    let _ = store.put(PutRequest {
        namespace: "crash-test".to_owned(),
        writer_epoch: namespace.writer_epoch,
        op_id: "crash-op".to_owned(),
        key: b"key".to_vec(),
        value: b"value".to_vec(),
        expected_version: Some(0),
    })?;
    Ok(())
}
