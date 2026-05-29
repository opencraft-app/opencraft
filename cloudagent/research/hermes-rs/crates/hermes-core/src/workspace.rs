//! Workspace capability abstractions.

use std::collections::HashMap;

use async_trait::async_trait;
use serde_json::Value;

use crate::error::Result;
use crate::runtime_host::CommandResult;

#[derive(Debug, Clone, Default)]
pub struct WorkspaceIdentity {
    pub workspace_id: Option<String>,
    pub sandbox_id: Option<String>,
    pub template_id: Option<String>,
}

#[async_trait]
pub trait WorkspaceRuntime: Send + Sync {
    async fn identity(&self) -> Result<WorkspaceIdentity>;
    async fn runtime_id(&self) -> Result<String>;
    fn workspace_root(&self) -> &str;
    fn resolve_path(&self, path: &str) -> Result<String>;
    fn resolve_working_dir(&self, path: Option<&str>) -> Result<String>;
    fn display_path(&self, remote_path: &str) -> String;
    fn native_host_configured(&self) -> bool;
    async fn run_command(
        &self,
        command: &str,
        envs: &HashMap<String, String>,
    ) -> Result<CommandResult>;
    async fn native_call(&self, method: &str, params: Value) -> Result<Value>;
}
