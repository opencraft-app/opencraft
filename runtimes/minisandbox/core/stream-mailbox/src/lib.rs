#![no_std]
#![forbid(unsafe_code)]

//! A small, bounded stream-mailbox protocol core.
//!
//! The crate deliberately contains no socket, mapping, hypervisor, or atomic
//! code.  It is the reference ownership state machine that those adapters must
//! drive.  The untrusted side is represented only by copied [`wire`] commands.

pub mod cursor;
pub mod protocol;
pub mod wire;

#[cfg(kani)]
mod proofs;

pub use protocol::{
    Capability, CloseResult, Limits, MailboxError, MailboxPhase, MailboxState, RxCompletion,
    RxWork, TxProgress, TxWork,
};
