//! Runtime host implementations.
//!
//! Runtime hosts provide capabilities such as files, shell, jobs, and host
//! identity. They do not own agent/session/protocol semantics.

pub mod e2b;

use async_trait::async_trait;

use crate::error::Result;
use crate::workspace::WorkspaceIdentity;

pub use e2b::*;

#[async_trait]
pub trait RuntimeHost: Send + Sync {
    async fn workspace_identity(&self) -> Result<WorkspaceIdentity>;
}
