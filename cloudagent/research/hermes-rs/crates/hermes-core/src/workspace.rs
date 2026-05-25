//! Workspace capability abstractions.

use async_trait::async_trait;

use crate::error::Result;

#[derive(Debug, Clone, Default)]
pub struct WorkspaceIdentity {
    pub workspace_id: Option<String>,
    pub sandbox_id: Option<String>,
    pub template_id: Option<String>,
}

#[async_trait]
pub trait WorkspaceRuntime: Send + Sync {
    async fn identity(&self) -> Result<WorkspaceIdentity>;
}
