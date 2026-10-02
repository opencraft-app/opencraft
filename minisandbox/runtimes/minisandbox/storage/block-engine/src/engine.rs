//! Transport-neutral block I/O and asynchronous cold-settling protocol.

use sha2::{Digest, Sha256};
use thiserror::Error;

#[cfg(feature = "fault-injection")]
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use crate::repository::{
    BLOCK_SIZE, BlockData, BlockMetaRepository, BlockRepositoryError, CommitRangeWriteRequest,
    CommitRangeWriteResult, CommitWriteRequest, CommitWriteResult, DeleteVolumeRequest,
    DeleteVolumeResult, DiscardRangeRequest, DiscardRangeResult, DiscardRequest, DiscardResult,
    FlushRequest, FlushResult, ForkResult, GcTask, PackIntent, PackIntentState,
    SnapshotDeleteResult, SnapshotState,
};

const BLOCK_SIZE_USIZE: usize = 4 * 1024;

/// Object-store observation failures visible to the reference engine.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ObjectStoreError {
    /// This access path currently does not observe the exact key.
    #[error("immutable object is not currently visible")]
    NotFound,
    /// The request outcome or observation timed out.
    #[error("object-store request timed out")]
    Timeout,
    /// Returned bytes or metadata failed transport-level validation.
    #[error("object-store response is corrupt")]
    Corrupt,
    /// The adapter or provider is unavailable.
    #[error("object store unavailable")]
    Unavailable,
    /// The immutable key already denotes different content.
    #[error("immutable object key conflicts with existing content")]
    ImmutableConflict,
}

/// Outcome of an immutable PUT from the caller's observation point.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PutStatus {
    /// The adapter authenticated a successful PUT response.
    Stored,
    /// The request may have stored bytes but its response was lost or failed.
    Indeterminate,
}

/// Outcome of deleting one exact immutable object key.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeleteStatus {
    /// The provider authenticated deletion of the exact key.
    Deleted,
    /// The exact key was absent; deletion is already idempotently satisfied.
    NotFound,
    /// The request may or may not have applied and must remain in the outbox.
    Indeterminate,
}

/// Durable settler boundaries exercised by the hidden SIGKILL harness.
#[cfg(feature = "fault-injection")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PackCrashPoint {
    /// Exact immutable membership is durable, before object creation.
    AfterIntentPrepared,
    /// Object bytes are durable, before verification is persisted.
    AfterObjectPut,
    /// Verification is durable, before cold-location publication.
    AfterIntentVerified,
    /// Cold locations are durable, before any hot eviction.
    AfterIntentPublished,
    /// One hot member was evicted, before workflow completion.
    AfterFirstHotEviction,
}

#[cfg(feature = "fault-injection")]
impl PackCrashPoint {
    /// Parses the hidden crash-probe command-line value.
    ///
    /// # Errors
    ///
    /// Returns an invalid-argument error for an unknown value.
    pub fn parse(value: &str) -> Result<Self, BlockRepositoryError> {
        match value {
            "after-pack-prepared" => Ok(Self::AfterIntentPrepared),
            "after-pack-put" => Ok(Self::AfterObjectPut),
            "after-pack-verified" => Ok(Self::AfterIntentVerified),
            "after-pack-published" => Ok(Self::AfterIntentPublished),
            "after-pack-first-eviction" => Ok(Self::AfterFirstHotEviction),
            _ => Err(BlockRepositoryError::InvalidArgument(
                "unknown pack crash point",
            )),
        }
    }
}

/// Durable exact-key GC boundaries exercised by the hidden SIGKILL harness.
#[cfg(feature = "fault-injection")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GcCrashPoint {
    /// A durable outbox task was selected, before object deletion.
    BeforeObjectDelete,
    /// The exact immutable object was durably deleted, before metadata completion.
    AfterObjectDelete,
    /// Metadata completion committed and removed the outbox task.
    AfterMetadataComplete,
}

#[cfg(feature = "fault-injection")]
impl GcCrashPoint {
    /// Parses the hidden crash-probe command-line value.
    ///
    /// # Errors
    ///
    /// Returns an invalid-argument error for an unknown value.
    pub fn parse(value: &str) -> Result<Self, BlockRepositoryError> {
        match value {
            "before-gc-delete" => Ok(Self::BeforeObjectDelete),
            "after-gc-delete" => Ok(Self::AfterObjectDelete),
            "after-gc-complete" => Ok(Self::AfterMetadataComplete),
            _ => Err(BlockRepositoryError::InvalidArgument(
                "unknown GC crash point",
            )),
        }
    }
}

/// Minimal immutable object interface required by the engine.
///
/// Production Tencent COS and the deterministic emulator implement this
/// boundary independently. `LIST` is intentionally absent.
pub trait ObjectStore {
    /// Creates or confirms an immutable exact key.
    ///
    /// # Errors
    ///
    /// Returns a known or indeterminate provider failure.
    fn put_immutable(
        &mut self,
        object_key: &str,
        bytes: &[u8],
    ) -> Result<PutStatus, ObjectStoreError>;

    /// Reads one exact byte range from an immutable key.
    ///
    /// # Errors
    ///
    /// Returns an explicit weak observation; absence is never zero-filled.
    fn get_range(
        &mut self,
        object_key: &str,
        offset: u64,
        length: u64,
    ) -> Result<Vec<u8>, ObjectStoreError>;

    /// Deletes one exact immutable key without consulting LIST or a prefix.
    ///
    /// # Errors
    ///
    /// Returns an explicit provider/transport failure. Unknown outcomes may
    /// instead be represented by [`DeleteStatus::Indeterminate`].
    fn delete_exact(&mut self, object_key: &str) -> Result<DeleteStatus, ObjectStoreError>;
}

/// Reference engine failures.
#[derive(Debug, Error)]
pub enum BlockEngineError {
    /// Strong hot-tier or metadata operation failed.
    #[error(transparent)]
    Repository(#[from] BlockRepositoryError),
    /// Immutable object operation failed explicitly.
    #[error(transparent)]
    ObjectStore(#[from] ObjectStoreError),
    /// Bytes returned for a published cold location failed SHA-256 validation.
    #[error("cold object bytes failed content authentication")]
    AuthenticationFailed,
    /// A bounded pack could not be represented safely.
    #[error("canonical pack encoding overflowed")]
    PackOverflow,
}

/// Observable progress from one bounded settler pass.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettleReport {
    /// Hot payloads evicted from a previously published pack after restart.
    pub recovered_evictions: u64,
    /// New hot versions published in this pass.
    pub published_blocks: u64,
    /// Hot payloads evicted after publication.
    pub evicted_blocks: u64,
    /// Immutable pack key, absent when there was no unpublished work.
    pub object_key: Option<String>,
}

/// Observable progress from one exact-key garbage-collection pass.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GcReport {
    /// Exact durable task selected, absent when the outbox was empty.
    pub task: Option<GcTask>,
    /// Whether provider deletion was terminal and metadata completion committed.
    pub completed: bool,
}

/// Single-process reference block engine over one repository and object adapter.
#[derive(Debug)]
pub struct BlockEngine<S> {
    repository: BlockMetaRepository,
    object_store: S,
    max_pack_bytes: u64,
    settler_generation: Option<u64>,
}

impl<S: ObjectStore> BlockEngine<S> {
    /// Creates an engine with a 1 MiB bounded settler pack.
    #[must_use]
    pub const fn new(repository: BlockMetaRepository, object_store: S) -> Self {
        Self {
            repository,
            object_store,
            max_pack_bytes: 1024 * 1024,
            settler_generation: None,
        }
    }

    /// Sets a canonical pack limit in the range 4 KiB through 8 MiB.
    ///
    /// # Errors
    ///
    /// Returns an error for an unaligned or out-of-range bound.
    pub fn set_max_pack_bytes(&mut self, max_pack_bytes: u64) -> Result<(), BlockEngineError> {
        if !(BLOCK_SIZE..=8 * 1024 * 1024).contains(&max_pack_bytes)
            || !max_pack_bytes.is_multiple_of(BLOCK_SIZE)
        {
            return Err(BlockRepositoryError::InvalidArgument(
                "pack size must be 4 KiB aligned and at most 8 MiB",
            )
            .into());
        }
        self.max_pack_bytes = max_pack_bytes;
        Ok(())
    }

    /// Returns the typed repository for control-plane operations and stats.
    #[must_use]
    pub const fn repository(&self) -> &BlockMetaRepository {
        &self.repository
    }

    /// Returns a mutable object adapter for deterministic fault scripting.
    #[must_use]
    pub const fn object_store_mut(&mut self) -> &mut S {
        &mut self.object_store
    }

    /// Consumes the engine and returns its repository and object adapter.
    #[must_use]
    pub fn into_parts(self) -> (BlockMetaRepository, S) {
        (self.repository, self.object_store)
    }

    /// Commits one synchronous 4 KiB hot write.
    ///
    /// COS is deliberately not touched by this method.
    ///
    /// # Errors
    ///
    /// Returns a repository validation, fencing, or durability failure.
    pub fn write(
        &self,
        request: CommitWriteRequest,
    ) -> Result<CommitWriteResult, BlockEngineError> {
        Ok(self.repository.commit_write(request)?)
    }

    /// Commits one synchronous, aligned 4 KiB--512 KiB hot write.
    ///
    /// COS is deliberately not touched by this method. All internal 4 KiB
    /// versions and heads become visible in one `SQLite` transaction.
    ///
    /// # Errors
    ///
    /// Returns a repository validation, fencing, or durability failure.
    pub fn write_range(
        &self,
        request: CommitRangeWriteRequest,
    ) -> Result<CommitRangeWriteResult, BlockEngineError> {
        Ok(self.repository.commit_range_write(request)?)
    }

    /// Commits one payload-free versioned zero/discard mutation.
    ///
    /// Every acknowledged discard is already durable in the strong metadata
    /// tier, so no separate FUA path or COS operation is required.
    ///
    /// # Errors
    ///
    /// Returns a repository validation, fencing, or durability failure.
    pub fn discard(&self, request: DiscardRequest) -> Result<DiscardResult, BlockEngineError> {
        Ok(self.repository.commit_discard(request)?)
    }

    /// Commits one payload-free aligned 4 KiB--512 KiB versioned discard.
    ///
    /// # Errors
    ///
    /// Returns a repository validation, fencing, or durability failure.
    pub fn discard_range(
        &self,
        request: DiscardRangeRequest,
    ) -> Result<DiscardRangeResult, BlockEngineError> {
        Ok(self.repository.commit_range_discard(request)?)
    }

    /// Captures a durable FLUSH ordering point in `SQLite` only.
    ///
    /// # Errors
    ///
    /// Returns a repository validation, fencing, or durability failure.
    pub fn flush(&self, request: FlushRequest) -> Result<FlushResult, BlockEngineError> {
        Ok(self.repository.capture_flush(request)?)
    }

    /// Reads an authenticated block from hot `SQLite` or immutable cold storage.
    ///
    /// # Errors
    ///
    /// Returns explicit I/O/authentication errors; it never converts failures
    /// or missing objects into zero blocks.
    pub fn read(&mut self, volume_id: &str, block_no: u64) -> Result<Vec<u8>, BlockEngineError> {
        match self.repository.read_block_head(volume_id, block_no)? {
            BlockData::Zero | BlockData::Discarded { .. } => Ok(vec![0; BLOCK_SIZE_USIZE]),
            BlockData::Version {
                content_sha256,
                hot_bytes: Some(bytes),
                ..
            } => authenticate_block(bytes, &content_sha256),
            BlockData::Version {
                content_sha256,
                hot_bytes: None,
                cold: Some(cold),
                ..
            } => {
                let bytes =
                    self.object_store
                        .get_range(&cold.object_key, cold.offset, cold.length)?;
                authenticate_block(bytes, &content_sha256)
            }
            BlockData::Version {
                hot_bytes: None,
                cold: None,
                ..
            } => Err(BlockRepositoryError::CorruptState.into()),
        }
    }

    /// Seals and pins a volume's exact current delta layer in O(1).
    ///
    /// # Errors
    ///
    /// Returns a repository validation or durability failure.
    pub fn snapshot(
        &self,
        volume_id: &str,
        snapshot_id: &str,
    ) -> Result<SnapshotState, BlockEngineError> {
        Ok(self.repository.create_snapshot(volume_id, snapshot_id)?)
    }

    /// Creates a fresh writable volume that shares a pinned layer in O(1).
    ///
    /// # Errors
    ///
    /// Returns a repository validation or durability failure.
    pub fn fork(
        &self,
        snapshot_id: &str,
        child_volume_id: &str,
    ) -> Result<ForkResult, BlockEngineError> {
        Ok(self
            .repository
            .fork_snapshot(snapshot_id, child_volume_id)?)
    }

    /// Idempotently releases a snapshot and derives newly unreachable packs.
    ///
    /// # Errors
    ///
    /// Returns a repository validation or durability failure.
    pub fn delete_snapshot(
        &self,
        snapshot_id: &str,
    ) -> Result<SnapshotDeleteResult, BlockEngineError> {
        Ok(self.repository.delete_snapshot(snapshot_id)?)
    }

    /// Terminally removes a volume root and fences every prior writer epoch.
    ///
    /// # Errors
    ///
    /// Returns a repository validation or durability failure.
    pub fn delete_volume(
        &self,
        request: DeleteVolumeRequest,
    ) -> Result<DeleteVolumeResult, BlockEngineError> {
        Ok(self.repository.delete_volume(request)?)
    }

    /// Executes one durable exact-key GC outbox task.
    ///
    /// An indeterminate DELETE stays pending. A success or exact `NotFound`
    /// completes metadata removal. Object keys are incarnation-unique, so a
    /// delayed DELETE can never target a later re-upload of the same content.
    ///
    /// # Errors
    ///
    /// Returns an explicit repository or object-store failure.
    pub fn gc_once(&mut self) -> Result<GcReport, BlockEngineError> {
        let Some(task) = self.repository.next_gc_task()? else {
            return Ok(GcReport {
                task: None,
                completed: false,
            });
        };
        let status = self.object_store.delete_exact(&task.object_key)?;
        let completed = matches!(status, DeleteStatus::Deleted | DeleteStatus::NotFound);
        if completed {
            self.repository.complete_gc_task(task.clone())?;
        }
        Ok(GcReport {
            task: Some(task),
            completed,
        })
    }

    /// Performs one bounded settle pass.
    ///
    /// Publication order is durable intent, PUT, authenticated exact GET,
    /// durable verification, one `SQLite` publish transaction, then hot
    /// eviction and durable completion. A failed step is resumed from its last
    /// durable phase and leaves either the hot copy or a published cold copy.
    ///
    /// # Errors
    ///
    /// Returns an explicit repository, object-store, or authentication error.
    pub fn settle_once(&mut self) -> Result<SettleReport, BlockEngineError> {
        self.settle_once_to_low(0)
    }

    /// Performs one bounded pass in a durable round targeting a fixed low
    /// watermark.
    ///
    /// The first pass captures a commit-version cutoff and byte budget. Calls
    /// after a crash resume that round without admitting newer writes. Pack
    /// size only bounds one COS operation; it does not redefine the round.
    ///
    /// # Errors
    ///
    /// Returns an explicit repository, object-store, or authentication error.
    pub fn settle_once_to_low(
        &mut self,
        low_watermark_bytes: u64,
    ) -> Result<SettleReport, BlockEngineError> {
        let mut recovered_evictions = 0_u64;
        for block in self.repository.select_evictable_hot_blocks(2_048)? {
            if self.repository.evict_hot_if_published(block)? {
                recovered_evictions = recovered_evictions
                    .checked_add(1)
                    .ok_or(BlockEngineError::PackOverflow)?;
            }
        }

        let generation = if let Some(generation) = self.settler_generation {
            generation
        } else {
            let generation = self.repository.acquire_settler()?;
            self.settler_generation = Some(generation);
            generation
        };
        let Some(mut intent) = self.repository.resume_or_prepare_pack_to_low(
            generation,
            self.max_pack_bytes,
            low_watermark_bytes,
        )?
        else {
            return Ok(SettleReport {
                recovered_evictions,
                published_blocks: 0,
                evicted_blocks: 0,
                object_key: None,
            });
        };
        let resumed_after_publication = intent.state == PackIntentState::Published;

        if intent.state == PackIntentState::Prepared {
            let pack = intent_pack_bytes(&intent)?;
            let _put_status = self.object_store.put_immutable(&intent.object_key, &pack)?;

            // A successful PUT response is insufficient with weakly consistent
            // COS access paths. Persist verification only after an independent
            // exact GET returns the byte-for-byte intended immutable object.
            let observed = self.object_store.get_range(
                &intent.object_key,
                0,
                u64::try_from(pack.len()).map_err(|_| BlockEngineError::PackOverflow)?,
            )?;
            if observed.len() != pack.len()
                || Sha256::digest(&observed).as_slice() != intent.pack_sha256
                || observed != pack
            {
                return Err(BlockEngineError::AuthenticationFailed);
            }
            self.repository
                .verify_pack_intent(generation, intent.intent_id)?;
            intent.state = PackIntentState::Verified;
        }

        let mut published_blocks = 0;
        if intent.state == PackIntentState::Verified {
            self.repository
                .publish_pack_intent(generation, intent.intent_id)?;
            intent.state = PackIntentState::Published;
            published_blocks =
                u64::try_from(intent.members.len()).map_err(|_| BlockEngineError::PackOverflow)?;
        }

        let changed = self.repository.evict_pack_intent_members(
            generation,
            intent.intent_id,
            intent.members.clone(),
        )?;
        let mut evicted_blocks = 0_u64;
        if resumed_after_publication {
            recovered_evictions = recovered_evictions
                .checked_add(changed)
                .ok_or(BlockEngineError::PackOverflow)?;
        } else {
            evicted_blocks = changed;
        }
        self.repository
            .complete_pack_intent(generation, intent.intent_id)?;
        Ok(SettleReport {
            recovered_evictions,
            published_blocks,
            evicted_blocks,
            object_key: Some(intent.object_key),
        })
    }
}

fn intent_pack_bytes(intent: &PackIntent) -> Result<Vec<u8>, BlockEngineError> {
    let capacity = intent
        .members
        .len()
        .checked_mul(BLOCK_SIZE_USIZE)
        .ok_or(BlockEngineError::PackOverflow)?;
    let mut bytes = Vec::with_capacity(capacity);
    for member in &intent.members {
        let hot_bytes = member
            .hot_bytes
            .as_ref()
            .ok_or(BlockRepositoryError::CorruptState)?;
        if member.offset
            != u64::try_from(bytes.len()).map_err(|_| BlockEngineError::PackOverflow)?
        {
            return Err(BlockRepositoryError::CorruptState.into());
        }
        bytes.extend_from_slice(hot_bytes);
    }
    if u64::try_from(bytes.len()).map_err(|_| BlockEngineError::PackOverflow)? != intent.pack_length
        || Sha256::digest(&bytes).as_slice() != intent.pack_sha256
    {
        return Err(BlockRepositoryError::CorruptState.into());
    }
    Ok(bytes)
}

fn authenticate_block(bytes: Vec<u8>, expected: &[u8; 32]) -> Result<Vec<u8>, BlockEngineError> {
    if bytes.len() != BLOCK_SIZE_USIZE || Sha256::digest(&bytes).as_slice() != expected {
        return Err(BlockEngineError::AuthenticationFailed);
    }
    Ok(bytes)
}

/// Runs one hidden durable-pack phase probe for the SIGKILL integration test.
///
/// The object directory is deliberately a tiny exact-key durable adapter, not
/// a production storage backend. It lets the crash harness distinguish
/// repository recovery from provider emulation without adding a runtime
/// dependency to the reference engine.
///
/// # Errors
///
/// Returns an explicit repository, object-file, or authentication failure if
/// the process reaches an error before the selected stop point.
#[cfg(feature = "fault-injection")]
#[doc(hidden)]
pub fn run_pack_crash_probe(
    database: &Path,
    object_root: &Path,
    marker: &Path,
    point: PackCrashPoint,
) -> Result<(), BlockEngineError> {
    let repository = BlockMetaRepository::open(crate::BlockRepositoryConfig::new(database))?;
    let generation = repository.acquire_settler()?;
    let Some(mut intent) = repository.resume_or_prepare_pack(generation, 8 * BLOCK_SIZE)? else {
        return Err(BlockRepositoryError::InvalidArgument("pack probe has no hot work").into());
    };
    stop_at_pack_point(marker, point, PackCrashPoint::AfterIntentPrepared);

    let bytes = intent_pack_bytes(&intent)?;
    durable_put_exact(object_root, &intent.object_key, &bytes)?;
    stop_at_pack_point(marker, point, PackCrashPoint::AfterObjectPut);

    let observed = read_exact_object(object_root, &intent.object_key)?;
    if observed != bytes || Sha256::digest(&observed).as_slice() != intent.pack_sha256 {
        return Err(BlockEngineError::AuthenticationFailed);
    }
    repository.verify_pack_intent(generation, intent.intent_id)?;
    intent.state = PackIntentState::Verified;
    stop_at_pack_point(marker, point, PackCrashPoint::AfterIntentVerified);

    repository.publish_pack_intent(generation, intent.intent_id)?;
    stop_at_pack_point(marker, point, PackCrashPoint::AfterIntentPublished);

    let first = intent
        .members
        .first()
        .cloned()
        .ok_or(BlockRepositoryError::CorruptState)?;
    let _changed = repository.evict_pack_intent_member(generation, intent.intent_id, first)?;
    stop_at_pack_point(marker, point, PackCrashPoint::AfterFirstHotEviction);
    for member in intent.members.iter().skip(1).cloned() {
        let _changed = repository.evict_pack_intent_member(generation, intent.intent_id, member)?;
    }
    repository.complete_pack_intent(generation, intent.intent_id)?;
    Ok(())
}

/// Runs one hidden exact-key GC phase probe for the SIGKILL integration test.
///
/// The selected task is always loaded from the durable outbox. Object removal
/// fsyncs the adapter directory before the probe can stop, so a restart after
/// that point must complete metadata from an exact `NotFound` retry.
///
/// # Errors
///
/// Returns an explicit repository or object-file failure if the process
/// reaches an error before the selected stop point.
#[cfg(feature = "fault-injection")]
#[doc(hidden)]
pub fn run_gc_crash_probe(
    database: &Path,
    object_root: &Path,
    marker: &Path,
    point: GcCrashPoint,
) -> Result<(), BlockEngineError> {
    let repository = BlockMetaRepository::open(crate::BlockRepositoryConfig::new(database))?;
    let task = repository
        .next_gc_task()?
        .ok_or(BlockRepositoryError::InvalidArgument(
            "GC probe has no pending task",
        ))?;
    stop_at_gc_point(marker, point, GcCrashPoint::BeforeObjectDelete);
    durable_delete_exact(object_root, &task.object_key)?;
    stop_at_gc_point(marker, point, GcCrashPoint::AfterObjectDelete);
    repository.complete_gc_task(task)?;
    stop_at_gc_point(marker, point, GcCrashPoint::AfterMetadataComplete);
    Ok(())
}

#[cfg(feature = "fault-injection")]
fn stop_at_pack_point(marker: &Path, selected: PackCrashPoint, current: PackCrashPoint) {
    if selected != current {
        return;
    }
    let mut file = File::create(marker).expect("create pack crash marker");
    writeln!(file, "{current:?}").expect("write pack crash marker");
    file.sync_all().expect("sync pack crash marker");
    #[cfg(unix)]
    {
        // SAFETY: raising SIGSTOP for the current process has no memory-safety
        // preconditions. The owning test harness follows it with SIGKILL.
        let status = unsafe { libc::raise(libc::SIGSTOP) };
        assert_eq!(status, 0, "raise SIGSTOP");
    }
    panic!("pack crash probe resumed unexpectedly");
}

#[cfg(feature = "fault-injection")]
fn stop_at_gc_point(marker: &Path, selected: GcCrashPoint, current: GcCrashPoint) {
    if selected != current {
        return;
    }
    let mut file = File::create(marker).expect("create GC crash marker");
    writeln!(file, "{current:?}").expect("write GC crash marker");
    file.sync_all().expect("sync GC crash marker");
    #[cfg(unix)]
    {
        // SAFETY: raising SIGSTOP for the current process has no memory-safety
        // preconditions. The owning test harness follows it with SIGKILL.
        let status = unsafe { libc::raise(libc::SIGSTOP) };
        assert_eq!(status, 0, "raise SIGSTOP");
    }
    panic!("GC crash probe resumed unexpectedly");
}

#[cfg(feature = "fault-injection")]
fn durable_put_exact(root: &Path, object_key: &str, bytes: &[u8]) -> Result<(), BlockEngineError> {
    fs::create_dir_all(root).map_err(|_| ObjectStoreError::Unavailable)?;
    let path = exact_object_path(root, object_key)?;
    if path.exists() {
        return if read_exact_object(root, object_key)? == bytes {
            Ok(())
        } else {
            Err(ObjectStoreError::ImmutableConflict.into())
        };
    }
    let temporary = root.join(format!(".pack-{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| ObjectStoreError::Unavailable)?;
    file.write_all(bytes)
        .map_err(|_| ObjectStoreError::Unavailable)?;
    file.sync_all().map_err(|_| ObjectStoreError::Unavailable)?;
    fs::rename(&temporary, &path).map_err(|_| ObjectStoreError::Unavailable)?;
    File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ObjectStoreError::Unavailable)?;
    Ok(())
}

#[cfg(feature = "fault-injection")]
fn read_exact_object(root: &Path, object_key: &str) -> Result<Vec<u8>, BlockEngineError> {
    fs::read(exact_object_path(root, object_key)?).map_err(|_| ObjectStoreError::NotFound.into())
}

#[cfg(feature = "fault-injection")]
fn durable_delete_exact(root: &Path, object_key: &str) -> Result<(), BlockEngineError> {
    fs::remove_file(exact_object_path(root, object_key)?)
        .map_err(|_| ObjectStoreError::Unavailable)?;
    File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ObjectStoreError::Unavailable)?;
    Ok(())
}

#[cfg(feature = "fault-injection")]
fn exact_object_path(root: &Path, object_key: &str) -> Result<PathBuf, BlockEngineError> {
    if !object_key.starts_with("extent/sha256/")
        || object_key.len() > 4_096
        || !object_key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.'))
    {
        return Err(ObjectStoreError::Corrupt.into());
    }
    Ok(root.join(hex_bytes(&Sha256::digest(object_key.as_bytes()))))
}

#[cfg(feature = "fault-injection")]
fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}
