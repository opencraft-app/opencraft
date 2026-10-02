//! Transport-independent reference block engine.
//!
//! The crate refines the checked MetaStore/COS protocol into a concrete
//! single-process implementation. It deliberately contains no NBD,
//! `virtio-blk`, PVM, or Tencent SDK code; those are frontends and object-store
//! adapters over this core.

mod engine;
mod repository;

pub use engine::{
    BlockEngine, BlockEngineError, DeleteStatus, GcReport, ObjectStore, ObjectStoreError,
    PutStatus, SettleReport,
};
pub use repository::{
    AcquireWriterOutcome, AcquireWriterRequest, AcquireWriterResult,
    AtomicVfsBlockRepositoryConnection, BLOCK_SIZE, BlockData, BlockMetaRepository,
    BlockRepositoryConfig, BlockRepositoryError, BlockVersion, ColdLocation,
    CommitRangeWriteRequest, CommitRangeWriteResult, CommitWriteRequest, CommitWriteResult,
    DeleteVolumeRequest, DeleteVolumeResult, DiscardRangeRequest, DiscardRangeResult,
    DiscardRequest, DiscardResult, FlushRequest, FlushResult, ForkResult, GcTask, HotBlock,
    MAX_BATCH_OPERATIONS, MAX_COMPACTION_ROWS, MAX_WRITE_BYTES, PackIntent, PackIntentMember,
    PackIntentState, RangeWriteOutcome, RepositoryRuntimeStats, RepositoryStats,
    RetentionCompactionResult, SnapshotDeleteResult, SnapshotState, VolumeState, WriteOutcome,
};

#[cfg(feature = "fault-injection")]
#[doc(hidden)]
pub use engine::{GcCrashPoint, PackCrashPoint, run_gc_crash_probe, run_pack_crash_probe};
#[cfg(feature = "fault-injection")]
#[doc(hidden)]
pub use repository::{CrashPoint, run_write_crash_probe};
