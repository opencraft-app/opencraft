#![deny(unsafe_op_in_unsafe_fn)]

//! Narrow bindings for the `x86_64` PVM KVM ABI.

mod abi;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod device;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod machine;
mod probe;
mod run;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod signal;

pub use abi::*;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub use device::*;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub use machine::*;
pub use probe::*;
pub use run::*;
