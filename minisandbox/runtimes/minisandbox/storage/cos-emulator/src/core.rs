use std::{
    collections::{BTreeMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::fd::AsRawFd;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const STATE_SCHEMA_VERSION: u32 = 1;
const MAX_STATE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_HISTORY_LINE_BYTES: usize = 64 * 1024;
/// Maximum object body accepted by the emulator.
pub const MAX_OBJECT_BYTES: usize = 64 * 1024 * 1024;
/// Maximum delay accepted in one scripted timeout.
pub const MAX_TIMEOUT_MILLIS: u64 = 30_000;

/// Fail-closed emulator errors.
#[derive(Debug, Error)]
pub enum EmulatorError {
    /// Persistent local state could not be read or written.
    #[error("COS emulator storage I/O failed")]
    Io(#[from] std::io::Error),
    /// JSON state or request history is malformed.
    #[error("COS emulator persistent state is corrupt")]
    CorruptState,
    /// A caller supplied an invalid bounded field or incompatible action.
    #[error("invalid COS emulator request: {0}")]
    InvalidArgument(&'static str),
    /// An immutable key was reused with different bytes.
    #[error("immutable COS object key conflicts with existing content")]
    ImmutableConflict,
    /// Another emulator already owns this local truth directory.
    #[error("COS emulator directory is already open")]
    AlreadyOpen,
}

/// Object-data operation understood by the emulator.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DataOperation {
    /// Create or idempotently confirm an immutable object.
    Put,
    /// Return object metadata without payload bytes.
    Head,
    /// Return all bytes or one validated single range.
    Get,
    /// Idempotently tombstone an object while retaining bytes for stale reads.
    Delete,
}

/// One optional HTTP byte range.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ByteRange {
    /// Inclusive start and end offsets.
    Inclusive {
        /// First byte offset.
        start: u64,
        /// Last byte offset.
        end: u64,
    },
    /// Start offset through end of object.
    From {
        /// First byte offset.
        start: u64,
    },
    /// Last `length` bytes.
    Suffix {
        /// Requested suffix length.
        length: u64,
    },
}

/// Per-access-path view of an immutable key.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    /// Current provider truth is visible on this path.
    Visible,
    /// This path currently observes no object.
    Hidden,
    /// This path may still return retained bytes after provider deletion.
    Stale,
}

/// Deterministic response action consumed from a per-path script queue.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FaultAction {
    /// Use current durable truth and access-path visibility.
    Normal,
    /// Force an exact HEAD/GET `NotFound` observation.
    NotFound,
    /// Return retained object bytes even when current truth is deleted/hidden.
    Stale,
    /// Return bytes or metadata that cannot pass content verification.
    Corrupt,
    /// Delay and fail one HEAD/GET observation without changing truth.
    Timeout {
        /// Delay before the HTTP 504 response.
        delay_ms: u64,
    },
    /// Delay and fail without applying a mutating request.
    TimeoutBeforeApply {
        /// Delay before the HTTP 504 response.
        delay_ms: u64,
    },
    /// Apply PUT/DELETE durably, then delay and return HTTP 504.
    TimeoutAfterApply {
        /// Delay before the HTTP 504 response.
        delay_ms: u64,
    },
}

/// One queued fault-script update.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScriptRequest {
    /// Access path selected by the request header.
    pub access_path: String,
    /// Operation whose next calls consume these actions.
    pub operation: DataOperation,
    /// Path-style bucket.
    pub bucket: String,
    /// Exact immutable object key.
    pub key: String,
    /// Actions consumed in order, once each.
    pub actions: Vec<FaultAction>,
}

/// One explicit access-path visibility change.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct VisibilityRequest {
    /// Access path to update.
    pub access_path: String,
    /// Path-style bucket.
    pub bucket: String,
    /// Exact object key.
    pub key: String,
    /// New path-local observation state.
    pub visibility: Visibility,
}

/// One data-plane request after HTTP parsing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DataRequest {
    /// PUT, HEAD, GET, or DELETE.
    pub operation: DataOperation,
    /// Path-style bucket.
    pub bucket: String,
    /// Exact object key.
    pub key: String,
    /// Independent visibility path selected by the caller.
    pub access_path: String,
    /// PUT body; empty for other methods.
    pub body: Vec<u8>,
    /// Optional GET byte range.
    pub range: Option<ByteRange>,
}

/// Prepared response returned to the HTTP shell.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DataResponse {
    /// HTTP status code.
    pub status: u16,
    /// Response headers excluding transport-generated framing.
    pub headers: BTreeMap<String, String>,
    /// Response body; HEAD responses are always empty.
    pub body: Vec<u8>,
    /// Scripted delay applied outside the core lock.
    pub delay_ms: u64,
}

/// One durable JSONL request-history event.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct HistoryEvent {
    /// Monotonically increasing request sequence.
    pub sequence: u64,
    /// Data-plane operation.
    pub operation: DataOperation,
    /// Bucket.
    pub bucket: String,
    /// Exact key.
    pub key: String,
    /// Access path.
    pub access_path: String,
    /// Consumed action, including implicit `Normal`.
    pub action: FaultAction,
    /// Whether PUT/DELETE changed durable truth.
    pub applied: bool,
    /// Provider truth before the request.
    pub live_before: bool,
    /// Provider truth after the request.
    pub live_after: bool,
    /// Path-local state used for this request, when one existed.
    pub visibility: Option<Visibility>,
    /// HTTP status prepared by the core.
    pub status: u16,
    /// PUT body length.
    pub request_bytes: u64,
    /// PUT request hash, including rejected immutable conflicts.
    pub request_sha256: Option<String>,
    /// Response payload length (zero for HEAD).
    pub response_bytes: u64,
    /// Optional requested range.
    pub range: Option<ByteRange>,
    /// Durable canonical content hash, when the key has ever existed.
    pub source_sha256: Option<String>,
    /// Hash of returned response bytes, when any bytes were returned.
    pub response_sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct ObjectRecord {
    bucket: String,
    key: String,
    key_digest: String,
    content_sha256: String,
    length: u64,
    live: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct ScriptQueue {
    access_path: String,
    operation: DataOperation,
    bucket: String,
    key: String,
    actions: VecDeque<FaultAction>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct PersistedState {
    schema_version: u32,
    objects: BTreeMap<String, ObjectRecord>,
    visibility: BTreeMap<String, BTreeMap<String, Visibility>>,
    scripts: Vec<ScriptQueue>,
    pending_history: Option<HistoryEvent>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            objects: BTreeMap::new(),
            visibility: BTreeMap::new(),
            scripts: Vec::new(),
            pending_history: None,
        }
    }
}

/// Single-owner deterministic emulator core with durable local truth.
#[derive(Debug)]
pub struct CosEmulator {
    root: PathBuf,
    objects_dir: PathBuf,
    _lock_file: File,
    state: PersistedState,
    history: Vec<HistoryEvent>,
    history_file: File,
    next_sequence: u64,
    temp_sequence: u64,
}

impl CosEmulator {
    /// Opens or creates an emulator directory and validates all retained bytes.
    ///
    /// # Errors
    ///
    /// Returns an I/O or corruption error if durable state cannot be trusted.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, EmulatorError> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        let lock_file = acquire_lock(&root)?;
        let objects_dir = root.join("objects");
        fs::create_dir_all(&objects_dir)?;
        let mut state = load_state(&root)?;
        validate_state(&objects_dir, &state)?;
        let history_path = root.join("history.jsonl");
        let mut history = load_history(&history_path)?;
        let mut history_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(history_path)?;
        recover_pending_history(&root, &mut state, &mut history, &mut history_file)?;
        verify_history(&history).map_err(|_| EmulatorError::CorruptState)?;
        verify_state_matches_history(&state, &history)?;
        let next_sequence = history.last().map_or(Ok(1), |event| {
            event
                .sequence
                .checked_add(1)
                .ok_or(EmulatorError::CorruptState)
        })?;
        Ok(Self {
            root,
            objects_dir,
            _lock_file: lock_file,
            state,
            history,
            history_file,
            next_sequence,
            temp_sequence: 1,
        })
    }

    /// Appends deterministic actions to one exact request queue.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid identifiers, actions, or persistence failure.
    pub fn enqueue_script(&mut self, request: ScriptRequest) -> Result<(), EmulatorError> {
        validate_script(&request)?;
        if let Some(queue) = self.state.scripts.iter_mut().find(|queue| {
            queue.access_path == request.access_path
                && queue.operation == request.operation
                && queue.bucket == request.bucket
                && queue.key == request.key
        }) {
            queue.actions.extend(request.actions);
        } else {
            self.state.scripts.push(ScriptQueue {
                access_path: request.access_path,
                operation: request.operation,
                bucket: request.bucket,
                key: request.key,
                actions: request.actions.into(),
            });
        }
        self.persist_state()
    }

    /// Sets one access path's current visibility for an existing object.
    ///
    /// # Errors
    ///
    /// Returns an error when the key has never existed or state cannot persist.
    pub fn set_visibility(&mut self, request: VisibilityRequest) -> Result<(), EmulatorError> {
        validate_access_path(&request.access_path)?;
        validate_bucket_key(&request.bucket, &request.key)?;
        let digest = key_digest(&request.bucket, &request.key);
        if !self.state.objects.contains_key(&digest) {
            return Err(EmulatorError::InvalidArgument("object has never existed"));
        }
        self.state
            .visibility
            .entry(request.access_path)
            .or_default()
            .insert(digest, request.visibility);
        self.persist_state()
    }

    /// Executes one parsed data request and durably appends its history event.
    ///
    /// # Errors
    ///
    /// Returns an error on invalid input, immutable conflict, or local I/O failure.
    pub fn execute(&mut self, request: DataRequest) -> Result<DataResponse, EmulatorError> {
        if self.state.pending_history.is_some() {
            return Err(EmulatorError::CorruptState);
        }
        validate_data_request(&request)?;
        let digest = key_digest(&request.bucket, &request.key);
        let live_before = self
            .state
            .objects
            .get(&digest)
            .is_some_and(|record| record.live);
        let visibility = self
            .state
            .visibility
            .get(&request.access_path)
            .and_then(|paths| paths.get(&digest))
            .copied();
        let action = self.take_action(&request);
        let (response, applied, _) = match request.operation {
            DataOperation::Put => self.execute_put(&request, &digest, &action)?,
            DataOperation::Head => self.execute_read(&request, &digest, &action, true)?,
            DataOperation::Get => self.execute_read(&request, &digest, &action, false)?,
            DataOperation::Delete => self.execute_delete(&request, &digest, &action)?,
        };
        let live_after = self
            .state
            .objects
            .get(&digest)
            .is_some_and(|record| record.live);
        let source_sha256 = self
            .state
            .objects
            .get(&digest)
            .map(|record| record.content_sha256.clone());
        let sequence = self.allocate_sequence()?;
        let event = HistoryEvent {
            sequence,
            operation: request.operation,
            bucket: request.bucket,
            key: request.key,
            access_path: request.access_path,
            action,
            applied,
            live_before,
            live_after,
            visibility,
            status: response.status,
            request_bytes: u64::try_from(request.body.len())
                .map_err(|_| EmulatorError::InvalidArgument("object is too large"))?,
            request_sha256: (request.operation == DataOperation::Put)
                .then(|| sha256_hex(&request.body)),
            response_bytes: u64::try_from(response.body.len())
                .map_err(|_| EmulatorError::CorruptState)?,
            range: request.range,
            source_sha256,
            response_sha256: (request.operation == DataOperation::Get
                && (200..300).contains(&response.status))
            .then(|| sha256_hex(&response.body)),
        };
        self.state.pending_history = Some(event.clone());
        self.persist_state()?;
        self.append_history(event)?;
        self.state.pending_history = None;
        self.persist_state()?;
        Ok(response)
    }

    /// Returns the durable in-process history loaded from JSONL.
    #[must_use]
    pub fn history(&self) -> &[HistoryEvent] {
        &self.history
    }

    fn execute_put(
        &mut self,
        request: &DataRequest,
        digest: &str,
        action: &FaultAction,
    ) -> Result<(DataResponse, bool, bool), EmulatorError> {
        let apply = matches!(
            action,
            FaultAction::Normal | FaultAction::TimeoutAfterApply { .. }
        );
        if !matches!(
            action,
            FaultAction::Normal
                | FaultAction::TimeoutBeforeApply { .. }
                | FaultAction::TimeoutAfterApply { .. }
        ) {
            return Err(EmulatorError::InvalidArgument("action is invalid for PUT"));
        }
        if apply {
            if let Err(error) = self.persist_object(request, digest) {
                if matches!(error, EmulatorError::ImmutableConflict) {
                    return Ok((empty_response(409), false, false));
                }
                return Err(error);
            }
            self.state
                .visibility
                .entry(request.access_path.clone())
                .or_default()
                .insert(digest.to_owned(), Visibility::Visible);
        }
        let delay_ms = action.delay_ms();
        let status = if action.is_timeout() { 504 } else { 200 };
        let mut headers = BTreeMap::new();
        if apply {
            headers.insert(
                "x-cos-emulator-sha256".to_owned(),
                sha256_hex(&request.body),
            );
        }
        Ok((
            DataResponse {
                status,
                headers,
                body: Vec::new(),
                delay_ms,
            },
            apply,
            apply,
        ))
    }

    fn execute_delete(
        &mut self,
        request: &DataRequest,
        digest: &str,
        action: &FaultAction,
    ) -> Result<(DataResponse, bool, bool), EmulatorError> {
        let apply = matches!(
            action,
            FaultAction::Normal | FaultAction::TimeoutAfterApply { .. }
        );
        if !matches!(
            action,
            FaultAction::Normal
                | FaultAction::TimeoutBeforeApply { .. }
                | FaultAction::TimeoutAfterApply { .. }
        ) {
            return Err(EmulatorError::InvalidArgument(
                "action is invalid for DELETE",
            ));
        }
        if apply {
            if let Some(record) = self.state.objects.get_mut(digest) {
                record.live = false;
            }
            self.state
                .visibility
                .entry(request.access_path.clone())
                .or_default()
                .insert(digest.to_owned(), Visibility::Hidden);
        }
        Ok((
            DataResponse {
                status: if action.is_timeout() { 504 } else { 204 },
                headers: BTreeMap::new(),
                body: Vec::new(),
                delay_ms: action.delay_ms(),
            },
            apply,
            apply,
        ))
    }

    fn execute_read(
        &self,
        request: &DataRequest,
        digest: &str,
        action: &FaultAction,
        head: bool,
    ) -> Result<(DataResponse, bool, bool), EmulatorError> {
        if matches!(
            action,
            FaultAction::Timeout { .. }
                | FaultAction::TimeoutBeforeApply { .. }
                | FaultAction::TimeoutAfterApply { .. }
        ) {
            return Ok((timeout_response(action), false, false));
        }
        let Some(record) = self.state.objects.get(digest) else {
            return Ok((empty_response(404), false, false));
        };
        if matches!(action, FaultAction::NotFound) {
            return Ok((empty_response(404), false, false));
        }
        let path_visibility = self
            .state
            .visibility
            .get(&request.access_path)
            .and_then(|paths| paths.get(digest))
            .copied()
            .unwrap_or(Visibility::Hidden);
        let observable = match action {
            FaultAction::Stale | FaultAction::Corrupt => true,
            FaultAction::Normal => {
                (record.live && path_visibility == Visibility::Visible)
                    || path_visibility == Visibility::Stale
            }
            FaultAction::NotFound
            | FaultAction::Timeout { .. }
            | FaultAction::TimeoutBeforeApply { .. }
            | FaultAction::TimeoutAfterApply { .. } => false,
        };
        if !observable {
            return Ok((empty_response(404), false, false));
        }
        let mut bytes = read_payload(&self.objects_dir, record)?;
        let source_len = bytes.len();
        if matches!(action, FaultAction::Corrupt) {
            corrupt_bytes(&mut bytes);
        }
        let range_result = if head {
            (200, Vec::new(), None)
        } else {
            match slice_range(bytes, request.range.as_ref()) {
                Ok(result) => result,
                Err(EmulatorError::InvalidArgument("range is unsatisfiable")) => {
                    return Ok((empty_response(416), false, false));
                }
                Err(error) => return Err(error),
            }
        };
        let (status, body, content_range) = range_result;
        let mut headers = BTreeMap::new();
        headers.insert("accept-ranges".to_owned(), "bytes".to_owned());
        headers.insert(
            "content-length".to_owned(),
            if head { source_len } else { body.len() }.to_string(),
        );
        headers.insert(
            "x-cos-emulator-sha256".to_owned(),
            if matches!(action, FaultAction::Corrupt) {
                "corrupt".to_owned()
            } else {
                record.content_sha256.clone()
            },
        );
        if let Some(content_range) = content_range {
            headers.insert("content-range".to_owned(), content_range);
        }
        Ok((
            DataResponse {
                status,
                headers,
                body,
                delay_ms: 0,
            },
            false,
            false,
        ))
    }

    fn persist_object(&mut self, request: &DataRequest, digest: &str) -> Result<(), EmulatorError> {
        let content_sha256 = sha256_hex(&request.body);
        if let Some(record) = self.state.objects.get_mut(digest) {
            if record.bucket != request.bucket || record.key != request.key {
                return Err(EmulatorError::CorruptState);
            }
            if record.content_sha256 != content_sha256
                || record.length
                    != u64::try_from(request.body.len()).map_err(|_| EmulatorError::CorruptState)?
            {
                return Err(EmulatorError::ImmutableConflict);
            }
            record.live = true;
            return Ok(());
        }
        self.temp_sequence = self
            .temp_sequence
            .checked_add(1)
            .ok_or(EmulatorError::CorruptState)?;
        let final_path = self.objects_dir.join(format!("{digest}.bin"));
        let temporary = self
            .objects_dir
            .join(format!(".{digest}.{}.tmp", self.temp_sequence));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&request.body)?;
        file.sync_all()?;
        fs::rename(&temporary, &final_path)?;
        sync_directory(&self.objects_dir)?;
        self.state.objects.insert(
            digest.to_owned(),
            ObjectRecord {
                bucket: request.bucket.clone(),
                key: request.key.clone(),
                key_digest: digest.to_owned(),
                content_sha256,
                length: u64::try_from(request.body.len())
                    .map_err(|_| EmulatorError::CorruptState)?,
                live: true,
            },
        );
        Ok(())
    }

    fn take_action(&mut self, request: &DataRequest) -> FaultAction {
        let Some(index) = self.state.scripts.iter().position(|queue| {
            queue.access_path == request.access_path
                && queue.operation == request.operation
                && queue.bucket == request.bucket
                && queue.key == request.key
        }) else {
            return FaultAction::Normal;
        };
        let action = self.state.scripts[index]
            .actions
            .pop_front()
            .unwrap_or(FaultAction::Normal);
        if self.state.scripts[index].actions.is_empty() {
            self.state.scripts.remove(index);
        }
        action
    }

    fn persist_state(&self) -> Result<(), EmulatorError> {
        persist_state_at(&self.root, &self.state)
    }

    fn allocate_sequence(&self) -> Result<u64, EmulatorError> {
        self.next_sequence
            .checked_add(1)
            .ok_or(EmulatorError::CorruptState)?;
        Ok(self.next_sequence)
    }

    fn append_history(&mut self, event: HistoryEvent) -> Result<(), EmulatorError> {
        let next_sequence = event
            .sequence
            .checked_add(1)
            .ok_or(EmulatorError::CorruptState)?;
        write_history_event(&mut self.history_file, &event)?;
        self.history.push(event);
        self.next_sequence = next_sequence;
        Ok(())
    }
}

fn persist_state_at(root: &Path, state: &PersistedState) -> Result<(), EmulatorError> {
    let temporary = root.join("state.json.tmp");
    let final_path = root.join("state.json");
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&temporary)?;
    serde_json::to_writer(&mut file, state).map_err(|_| EmulatorError::CorruptState)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(temporary, final_path)?;
    sync_directory(root)
}

fn write_history_event(file: &mut File, event: &HistoryEvent) -> Result<(), EmulatorError> {
    serde_json::to_writer(&mut *file, event).map_err(|_| EmulatorError::CorruptState)?;
    file.write_all(b"\n")?;
    file.sync_data()?;
    Ok(())
}

fn recover_pending_history(
    root: &Path,
    state: &mut PersistedState,
    history: &mut Vec<HistoryEvent>,
    history_file: &mut File,
) -> Result<(), EmulatorError> {
    let Some(pending) = state.pending_history.clone() else {
        return Ok(());
    };
    if history.last() != Some(&pending) {
        let expected = history.last().map_or(Ok(1), |event| {
            event
                .sequence
                .checked_add(1)
                .ok_or(EmulatorError::CorruptState)
        })?;
        if pending.sequence != expected {
            return Err(EmulatorError::CorruptState);
        }
        write_history_event(history_file, &pending)?;
        history.push(pending);
    }
    state.pending_history = None;
    persist_state_at(root, state)
}

fn verify_state_matches_history(
    state: &PersistedState,
    history: &[HistoryEvent],
) -> Result<(), EmulatorError> {
    let mut truth: BTreeMap<String, (String, String, String, bool)> = BTreeMap::new();
    for event in history {
        let digest = key_digest(&event.bucket, &event.key);
        match event.operation {
            DataOperation::Put if event.applied => {
                let hash = event
                    .request_sha256
                    .clone()
                    .ok_or(EmulatorError::CorruptState)?;
                truth.insert(
                    digest,
                    (event.bucket.clone(), event.key.clone(), hash, true),
                );
            }
            DataOperation::Delete if event.applied => {
                if let Some((_, _, _, live)) = truth.get_mut(&digest) {
                    *live = false;
                }
            }
            DataOperation::Put
            | DataOperation::Head
            | DataOperation::Get
            | DataOperation::Delete => {}
        }
    }
    if truth.len() != state.objects.len() {
        return Err(EmulatorError::CorruptState);
    }
    for (digest, record) in &state.objects {
        let Some((bucket, key, hash, live)) = truth.get(digest) else {
            return Err(EmulatorError::CorruptState);
        };
        if bucket != &record.bucket
            || key != &record.key
            || hash != &record.content_sha256
            || *live != record.live
        {
            return Err(EmulatorError::CorruptState);
        }
    }
    Ok(())
}

impl FaultAction {
    const fn delay_ms(&self) -> u64 {
        match self {
            Self::Timeout { delay_ms }
            | Self::TimeoutBeforeApply { delay_ms }
            | Self::TimeoutAfterApply { delay_ms } => *delay_ms,
            Self::Normal | Self::NotFound | Self::Stale | Self::Corrupt => 0,
        }
    }

    const fn is_timeout(&self) -> bool {
        matches!(
            self,
            Self::Timeout { .. } | Self::TimeoutBeforeApply { .. } | Self::TimeoutAfterApply { .. }
        )
    }
}

fn load_state(root: &Path) -> Result<PersistedState, EmulatorError> {
    let path = root.join("state.json");
    if !path.exists() {
        return Ok(PersistedState::default());
    }
    let file = File::open(path)?;
    if file.metadata()?.len() > MAX_STATE_BYTES {
        return Err(EmulatorError::CorruptState);
    }
    let state: PersistedState =
        serde_json::from_reader(file).map_err(|_| EmulatorError::CorruptState)?;
    if state.schema_version != STATE_SCHEMA_VERSION {
        return Err(EmulatorError::CorruptState);
    }
    Ok(state)
}

fn load_history(path: &Path) -> Result<Vec<HistoryEvent>, EmulatorError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut history = Vec::new();
    for (index, line) in BufReader::new(File::open(path)?).lines().enumerate() {
        let line = line?;
        if line.len() > MAX_HISTORY_LINE_BYTES || line.is_empty() {
            return Err(EmulatorError::CorruptState);
        }
        let event: HistoryEvent =
            serde_json::from_str(&line).map_err(|_| EmulatorError::CorruptState)?;
        let expected = u64::try_from(index).map_err(|_| EmulatorError::CorruptState)? + 1;
        if event.sequence != expected {
            return Err(EmulatorError::CorruptState);
        }
        history.push(event);
    }
    Ok(history)
}

fn validate_state(objects_dir: &Path, state: &PersistedState) -> Result<(), EmulatorError> {
    for (digest, record) in &state.objects {
        if digest != &record.key_digest || digest != &key_digest(&record.bucket, &record.key) {
            return Err(EmulatorError::CorruptState);
        }
        let bytes = read_payload(objects_dir, record)?;
        if sha256_hex(&bytes) != record.content_sha256 {
            return Err(EmulatorError::CorruptState);
        }
    }
    for paths in state.visibility.values() {
        if paths
            .keys()
            .any(|digest| !state.objects.contains_key(digest))
        {
            return Err(EmulatorError::CorruptState);
        }
    }
    for queue in &state.scripts {
        validate_script(&ScriptRequest {
            access_path: queue.access_path.clone(),
            operation: queue.operation,
            bucket: queue.bucket.clone(),
            key: queue.key.clone(),
            actions: queue.actions.iter().cloned().collect(),
        })?;
    }
    Ok(())
}

fn validate_script(request: &ScriptRequest) -> Result<(), EmulatorError> {
    validate_access_path(&request.access_path)?;
    validate_bucket_key(&request.bucket, &request.key)?;
    if request.actions.is_empty() || request.actions.len() > 1_024 {
        return Err(EmulatorError::InvalidArgument("invalid action count"));
    }
    for action in &request.actions {
        if action.delay_ms() > MAX_TIMEOUT_MILLIS {
            return Err(EmulatorError::InvalidArgument("timeout is too large"));
        }
        let valid = match request.operation {
            DataOperation::Put | DataOperation::Delete => matches!(
                action,
                FaultAction::Normal
                    | FaultAction::TimeoutBeforeApply { .. }
                    | FaultAction::TimeoutAfterApply { .. }
            ),
            DataOperation::Head | DataOperation::Get => true,
        };
        if !valid {
            return Err(EmulatorError::InvalidArgument(
                "action is invalid for operation",
            ));
        }
    }
    Ok(())
}

fn validate_data_request(request: &DataRequest) -> Result<(), EmulatorError> {
    validate_access_path(&request.access_path)?;
    validate_bucket_key(&request.bucket, &request.key)?;
    if request.body.len() > MAX_OBJECT_BYTES {
        return Err(EmulatorError::InvalidArgument("object is too large"));
    }
    match request.operation {
        DataOperation::Put if request.range.is_none() => {}
        DataOperation::Get if request.body.is_empty() => {}
        DataOperation::Head | DataOperation::Delete
            if request.body.is_empty() && request.range.is_none() => {}
        _ => {
            return Err(EmulatorError::InvalidArgument(
                "body or range is invalid for operation",
            ));
        }
    }
    Ok(())
}

fn validate_access_path(value: &str) -> Result<(), EmulatorError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(EmulatorError::InvalidArgument("invalid access path"));
    }
    Ok(())
}

fn validate_bucket_key(bucket: &str, key: &str) -> Result<(), EmulatorError> {
    if bucket.is_empty()
        || bucket.len() > 128
        || !bucket
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
        || key.is_empty()
        || key.len() > 4_096
        || bucket.as_bytes().contains(&0)
        || key.as_bytes().contains(&0)
    {
        return Err(EmulatorError::InvalidArgument("invalid bucket or key"));
    }
    Ok(())
}

fn key_digest(bucket: &str, key: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"minisandbox.cos-emulator.key.v1\0");
    hash_part(&mut hash, bucket.as_bytes());
    hash_part(&mut hash, key.as_bytes());
    hex(hash.finalize().as_slice())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(Sha256::digest(bytes).as_slice())
}

fn hash_part(hash: &mut Sha256, bytes: &[u8]) {
    hash.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
    hash.update(bytes);
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

fn read_payload(objects_dir: &Path, record: &ObjectRecord) -> Result<Vec<u8>, EmulatorError> {
    let path = objects_dir.join(format!("{}.bin", record.key_digest));
    let mut file = File::open(path)?;
    if file.metadata()?.len() != record.length || record.length > MAX_OBJECT_BYTES as u64 {
        return Err(EmulatorError::CorruptState);
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(record.length).map_err(|_| EmulatorError::CorruptState)?,
    );
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn slice_range(
    bytes: Vec<u8>,
    range: Option<&ByteRange>,
) -> Result<(u16, Vec<u8>, Option<String>), EmulatorError> {
    let Some(range) = range else {
        return Ok((200, bytes, None));
    };
    let length = u64::try_from(bytes.len()).map_err(|_| EmulatorError::CorruptState)?;
    let (start, end) = resolve_range(range, length)?;
    let start_usize = usize::try_from(start).map_err(|_| EmulatorError::CorruptState)?;
    let end_usize = usize::try_from(end).map_err(|_| EmulatorError::CorruptState)?;
    let body = bytes[start_usize..=end_usize].to_vec();
    Ok((206, body, Some(format!("bytes {start}-{end}/{length}"))))
}

fn resolve_range(range: &ByteRange, length: u64) -> Result<(u64, u64), EmulatorError> {
    if length == 0 {
        return Err(EmulatorError::InvalidArgument("range is unsatisfiable"));
    }
    let last = length - 1;
    match *range {
        ByteRange::Inclusive { start, end } if start <= end && start < length => {
            Ok((start, end.min(last)))
        }
        ByteRange::From { start } if start < length => Ok((start, last)),
        ByteRange::Suffix { length: suffix } if suffix > 0 => {
            Ok((length.saturating_sub(suffix), last))
        }
        ByteRange::Inclusive { .. } | ByteRange::From { .. } | ByteRange::Suffix { .. } => {
            Err(EmulatorError::InvalidArgument("range is unsatisfiable"))
        }
    }
}

fn corrupt_bytes(bytes: &mut Vec<u8>) {
    if let Some(first) = bytes.first_mut() {
        *first ^= 0x80;
    } else {
        bytes.push(0xff);
    }
}

fn timeout_response(action: &FaultAction) -> DataResponse {
    DataResponse {
        status: 504,
        headers: BTreeMap::new(),
        body: Vec::new(),
        delay_ms: action.delay_ms(),
    }
}

fn empty_response(status: u16) -> DataResponse {
    DataResponse {
        status,
        headers: BTreeMap::new(),
        body: Vec::new(),
        delay_ms: 0,
    }
}

fn sync_directory(path: &Path) -> Result<(), EmulatorError> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(unix)]
fn acquire_lock(root: &Path) -> Result<File, EmulatorError> {
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(root.join("LOCK"))?;
    // SAFETY: `flock` only reads the valid file descriptor and does not retain
    // a pointer. The owned `File` keeps the descriptor alive until drop.
    let status = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if status != 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::WouldBlock {
            return Err(EmulatorError::AlreadyOpen);
        }
        return Err(EmulatorError::Io(error));
    }
    Ok(file)
}

#[cfg(not(unix))]
fn acquire_lock(_root: &Path) -> Result<File, EmulatorError> {
    Err(EmulatorError::InvalidArgument(
        "directory locking requires Unix",
    ))
}

/// Independently checks durable-history invariants that do not require payload bytes.
///
/// # Errors
///
/// Returns the first invariant violation in sequence order.
pub fn verify_history(events: &[HistoryEvent]) -> Result<(), &'static str> {
    let mut expected_sequence = 1_u64;
    let mut truth: BTreeMap<(&str, &str), (bool, &str)> = BTreeMap::new();
    for event in events {
        if event.sequence != expected_sequence {
            return Err("history sequence is not contiguous");
        }
        expected_sequence = expected_sequence
            .checked_add(1)
            .ok_or("history sequence overflow")?;
        let object = (event.bucket.as_str(), event.key.as_str());
        if event.live_before != truth.get(&object).is_some_and(|(live, _)| *live) {
            return Err("pre-request provider truth disagrees with replay");
        }
        if let Some((_, hash)) = truth.get(&object)
            && event.source_sha256.as_deref() != Some(*hash)
        {
            return Err("recorded source hash disagrees with provider truth");
        }
        match event.operation {
            DataOperation::Put if event.applied => {
                let hash = event
                    .source_sha256
                    .as_deref()
                    .ok_or("applied PUT has no source hash")?;
                if event.request_sha256.as_deref() != Some(hash) {
                    return Err("applied PUT request differs from durable content");
                }
                if let Some((_, previous_hash)) = truth.get(&object)
                    && *previous_hash != hash
                {
                    return Err("immutable key changed content");
                }
                truth.insert(object, (true, hash));
            }
            DataOperation::Delete if event.applied => {
                if let Some((live, _)) = truth.get_mut(&object) {
                    *live = false;
                }
            }
            DataOperation::Put if event.status == 409 => {
                if event.request_sha256.is_none()
                    || event.source_sha256.is_none()
                    || event.request_sha256 == event.source_sha256
                {
                    return Err("immutable conflict does not contain distinct hashes");
                }
            }
            DataOperation::Head | DataOperation::Get if (200..300).contains(&event.status) => {
                if !truth.contains_key(&object) {
                    return Err("successful read has no prior durable object");
                }
                if event.action == FaultAction::Normal
                    && event.visibility != Some(Visibility::Stale)
                    && !truth.get(&object).is_some_and(|(live, _)| *live)
                {
                    return Err("normal read returned deleted provider truth");
                }
                if event.action == FaultAction::Corrupt
                    && event.response_sha256 == event.source_sha256
                {
                    return Err("corrupt read returned canonical hash");
                }
                if event.operation == DataOperation::Get && event.response_sha256.is_none() {
                    return Err("successful GET has no response hash");
                }
                if event.operation == DataOperation::Get
                    && event.range.is_none()
                    && event.action != FaultAction::Corrupt
                    && event.response_sha256 != event.source_sha256
                {
                    return Err("full GET did not return canonical bytes");
                }
            }
            DataOperation::Put
            | DataOperation::Head
            | DataOperation::Get
            | DataOperation::Delete => {}
        }
        if event.live_after != truth.get(&object).is_some_and(|(live, _)| *live) {
            return Err("post-request provider truth disagrees with replay");
        }
    }
    Ok(())
}
