//! Linux NBD validation frontend for the reference block engine.
//!
//! This crate is intentionally outside the PVM product path. It lets the
//! ordinary Linux block layer, ext4, fio, and storage test suites drive the
//! same typed block engine without adding NBD parsing to the hypervisor.

#[cfg(target_os = "linux")]
mod linux;
mod protocol;

#[cfg(target_os = "linux")]
pub use linux::{AttachedNbd, LinuxNbdError};
pub use minisandbox_block_backend::{
    BackendError, EmulatorObjectStore, OnlineSettlerConfig, OnlineSettlerError, OnlineSettlerStats,
    SqliteBlockBackend,
};
pub use protocol::{
    BlockDevice, NBD_LOGICAL_BLOCK_SIZE, NBD_MAX_REQUEST_BYTES, NBD_MAX_TRIM_BYTES, ProtocolError,
    SessionStats, serve_transmission,
};

impl BlockDevice for SqliteBlockBackend {
    type Error = BackendError;

    fn size(&self) -> u64 {
        SqliteBlockBackend::size(self)
    }

    fn read_at(&mut self, offset: u64, length: usize) -> Result<Vec<u8>, Self::Error> {
        SqliteBlockBackend::read_at(self, offset, length)
    }

    fn write_at(&mut self, offset: u64, bytes: &[u8], fua: bool) -> Result<(), Self::Error> {
        SqliteBlockBackend::write_at(self, offset, bytes, fua)
    }

    fn flush(&mut self) -> Result<(), Self::Error> {
        SqliteBlockBackend::flush(self)
    }

    fn trim(&mut self, offset: u64, length: usize, fua: bool) -> Result<(), Self::Error> {
        SqliteBlockBackend::trim(self, offset, length, fua)
    }
}
