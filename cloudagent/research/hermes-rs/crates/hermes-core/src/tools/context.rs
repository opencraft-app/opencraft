use std::collections::HashMap;
use std::sync::Arc;

use crate::runtime_host::SessionSandbox;
use crate::workspace::WorkspaceRuntime;

/// Context passed to tool execution.
#[derive(Clone, Default)]
pub struct ToolContext {
    /// Additional metadata about the execution.
    pub metadata: HashMap<String, String>,
    /// Optional session-scoped workspace runtime.
    pub workspace: Option<Arc<dyn WorkspaceRuntime>>,
    /// Whether filesystem/process tools must use a session-scoped workspace.
    pub require_session_sandbox: bool,
}

impl ToolContext {
    /// Create a new context with metadata.
    pub fn with_metadata(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.metadata.insert(key.into(), value.into());
        self
    }

    /// Get a metadata value.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.metadata.get(key).map(|s| s.as_str())
    }

    /// Attach a session-scoped sandbox.
    pub fn with_session_sandbox(mut self, sandbox: Arc<SessionSandbox>) -> Self {
        self.workspace = Some(sandbox);
        self
    }

    /// Attach a session-scoped workspace runtime.
    pub fn with_workspace_runtime(mut self, workspace: Arc<dyn WorkspaceRuntime>) -> Self {
        self.workspace = Some(workspace);
        self
    }

    /// Require tools to fail instead of falling back to the local host.
    pub fn requiring_session_sandbox(mut self) -> Self {
        self.require_session_sandbox = true;
        self
    }

    /// Get the session-scoped workspace if present.
    pub fn workspace(&self) -> Option<Arc<dyn WorkspaceRuntime>> {
        self.workspace.clone()
    }

    /// Backwards-compatible accessor for existing tool code while it migrates
    /// from sandbox naming to workspace naming.
    pub fn sandbox(&self) -> Option<Arc<dyn WorkspaceRuntime>> {
        self.workspace()
    }

    /// Whether tools must execute through the session-scoped sandbox.
    pub fn requires_session_sandbox(&self) -> bool {
        self.require_session_sandbox
    }
}
