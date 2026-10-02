//! Typed SQLite/COS reference block backend shared by direct frontends.
//!
//! This crate contains no NBD, virtio, KVM, file-image, or transport parser.
//! Frontends translate their already-bounded requests into these methods.

mod backend;
mod cos;
mod online_settler;

pub use backend::{BackendError, SqliteBlockBackend, SqliteBlockBackendFactory};
/// Largest range committed by one Block Engine repository transaction.
pub const MAX_ATOMIC_WRITE_BYTES: usize = minisandbox_block_engine::MAX_WRITE_BYTES;
pub use cos::EmulatorObjectStore;
pub use online_settler::{OnlineSettlerConfig, OnlineSettlerError, OnlineSettlerStats};
