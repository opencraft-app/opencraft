//! Deterministic Tencent COS consistency emulator for storage protocol tests.
//!
//! This crate is not a general object store and is deliberately not a `MinIO`
//! replacement. It keeps immutable payload truth on local disk while allowing
//! each named access path to observe independent visibility and scripted
//! failures.

mod core;
pub mod http;

pub use core::{
    ByteRange, CosEmulator, DataOperation, DataRequest, DataResponse, EmulatorError, FaultAction,
    HistoryEvent, ScriptRequest, Visibility, VisibilityRequest, verify_history,
};
