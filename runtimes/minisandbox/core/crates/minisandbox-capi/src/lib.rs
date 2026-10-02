#![deny(unsafe_op_in_unsafe_fn)]

//! Stable C ABI for minisandbox.

mod abi;
mod exports;
mod registry;

pub use abi::*;
pub use exports::*;
