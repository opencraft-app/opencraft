use std::sync::Arc;

use crate::client::ToolCall;
use crate::error::{Error, Result};
use crate::events::{AgentEvent, RuntimeHostEvent};
use crate::runtime::agent::AgentExecutor;
use crate::runtime_host::{
    bind_session_sandbox, create_session_sandbox, e2b_enabled, SessionSandbox,
    SessionSandboxBinding, SessionSandboxEnvdIdentity,
};
use crate::tools::ToolContext;

impl AgentExecutor {
    pub async fn has_session_sandbox(&self) -> bool {
        self.session_sandbox.read().await.is_some()
    }

    pub async fn session_sandbox_id(&self) -> Option<String> {
        let sandbox = self.session_sandbox.read().await.clone()?;
        Some(sandbox.sandbox_id().await)
    }

    pub async fn upload_session_sandbox_file(
        &self,
        workspace_path: &str,
        content: Vec<u8>,
    ) -> Result<bool> {
        let Some(sandbox) = self.session_sandbox.read().await.clone() else {
            return Ok(false);
        };
        let remote_path = sandbox.resolve_path(workspace_path)?;
        sandbox.upload_bytes_at_path(&remote_path, content).await?;
        Ok(true)
    }

    pub async fn download_session_sandbox_file(
        &self,
        workspace_path: &str,
    ) -> Result<Option<Vec<u8>>> {
        let Some(sandbox) = self.session_sandbox.read().await.clone() else {
            return Ok(None);
        };
        let remote_path = sandbox.resolve_path(workspace_path)?;
        sandbox.download_bytes_at_path(&remote_path).await.map(Some)
    }

    pub async fn test_tool_context(&self) -> Result<ToolContext> {
        self.tool_context().await
    }

    pub(crate) async fn tool_context(&self) -> Result<ToolContext> {
        self.tool_context_requiring_session_sandbox(e2b_enabled())
            .await
    }

    pub(crate) async fn tool_context_for_tools(
        &self,
        tool_calls: &[ToolCall],
    ) -> Result<ToolContext> {
        let requires_session_sandbox = tool_calls
            .iter()
            .any(|tool_call| tool_requires_session_sandbox(&tool_call.function.name));
        self.tool_context_requiring_session_sandbox(requires_session_sandbox)
            .await
    }

    async fn tool_context_requiring_session_sandbox(
        &self,
        requires_session_sandbox: bool,
    ) -> Result<ToolContext> {
        let mut context = ToolContext::default().with_metadata("session_id", &self.session_id);
        if requires_session_sandbox {
            context = context.requiring_session_sandbox();
        }
        if requires_session_sandbox && e2b_enabled() {
            let sandbox = self.ensure_session_sandbox().await?;
            context = context.with_session_sandbox(sandbox);
        }
        Ok(context)
    }

    pub(crate) async fn ensure_session_sandbox(&self) -> Result<Arc<SessionSandbox>> {
        if let Some(existing) = self.session_sandbox.read().await.clone() {
            return Ok(existing);
        }

        let cwd = std::env::current_dir().map_err(|error| {
            Error::Agent(format!("Failed to determine current directory: {}", error))
        })?;
        self.emit(AgentEvent::RuntimeHost(RuntimeHostEvent {
            event: "inner_create_start".to_string(),
            session_id: Some(self.session_id.clone()),
            ..RuntimeHostEvent::default()
        }))
        .await;
        let sandbox = create_session_sandbox(&self.session_id, &cwd).await?;
        self.emit(AgentEvent::RuntimeHost(RuntimeHostEvent {
            event: "inner_ready".to_string(),
            session_id: Some(self.session_id.clone()),
            sandbox_id: Some(sandbox.sandbox_id().await),
            workspace_root: Some(sandbox.workspace_root().to_string()),
            ..RuntimeHostEvent::default()
        }))
        .await;
        let mut slot = self.session_sandbox.write().await;
        if let Some(existing) = slot.clone() {
            return Ok(existing);
        }
        *slot = Some(sandbox.clone());
        Ok(sandbox)
    }

    pub async fn bind_session_sandbox(
        &self,
        binding: SessionSandboxBinding,
        replace_existing: bool,
    ) -> Result<SessionSandboxEnvdIdentity> {
        if replace_existing {
            self.shutdown_session_sandbox().await;
        }
        let sandbox = bind_session_sandbox(binding).await?;
        let identity = sandbox.envd_identity().await;
        {
            let mut slot = self.session_sandbox.write().await;
            *slot = Some(sandbox);
        }
        self.emit(AgentEvent::RuntimeHost(RuntimeHostEvent {
            event: "workspace_bind_done".to_string(),
            session_id: Some(self.session_id.clone()),
            sandbox_id: Some(identity.sandbox_id.clone()),
            workspace_root: Some("/workspace".to_string()),
            ..RuntimeHostEvent::default()
        }))
        .await;
        Ok(identity)
    }

    pub(crate) async fn shutdown_session_sandbox(&self) {
        let sandbox = self.session_sandbox.write().await.take();
        if let Some(sandbox) = sandbox {
            let sandbox_id = sandbox.sandbox_id().await;
            let workspace_root = sandbox.workspace_root().to_string();
            self.emit(AgentEvent::RuntimeHost(RuntimeHostEvent {
                event: "inner_shutdown_start".to_string(),
                session_id: Some(self.session_id.clone()),
                sandbox_id: Some(sandbox_id.clone()),
                workspace_root: Some(workspace_root.clone()),
                ..RuntimeHostEvent::default()
            }))
            .await;
            match sandbox.shutdown().await {
                Ok(_) => {
                    self.emit(AgentEvent::RuntimeHost(RuntimeHostEvent {
                        event: "inner_shutdown_done".to_string(),
                        session_id: Some(self.session_id.clone()),
                        sandbox_id: Some(sandbox_id),
                        workspace_root: Some(workspace_root),
                        ..RuntimeHostEvent::default()
                    }))
                    .await;
                }
                Err(error) => {
                    self.emit(AgentEvent::RuntimeHost(RuntimeHostEvent {
                        event: "inner_shutdown_failed".to_string(),
                        session_id: Some(self.session_id.clone()),
                        sandbox_id: Some(sandbox_id),
                        workspace_root: Some(workspace_root),
                        error: Some(error.to_string()),
                        ..RuntimeHostEvent::default()
                    }))
                    .await;
                }
            }
        }
    }

    pub async fn ensure_session_sandbox_envd_identity(
        &self,
        force: bool,
    ) -> Result<SessionSandboxEnvdIdentity> {
        if force {
            self.shutdown_session_sandbox().await;
        }
        let sandbox = self.ensure_session_sandbox().await?;
        Ok(sandbox.envd_identity().await)
    }
}

pub(crate) fn tool_requires_session_sandbox(name: &str) -> bool {
    matches!(
        name,
        "terminal"
            | "process"
            | "code_execution"
            | "file_list"
            | "file_read"
            | "read_file"
            | "file_write"
            | "write_file"
            | "file_search"
            | "search_files"
            | "patch"
    )
}

#[cfg(test)]
mod tests {
    use super::tool_requires_session_sandbox;

    #[test]
    fn classifies_inner_sandbox_required_tools() {
        for name in [
            "terminal",
            "process",
            "code_execution",
            "file_list",
            "file_read",
            "read_file",
            "file_write",
            "write_file",
            "file_search",
            "search_files",
            "patch",
        ] {
            assert!(tool_requires_session_sandbox(name), "{name}");
        }
    }

    #[test]
    fn does_not_create_inner_sandbox_for_pure_model_or_remote_tools() {
        for name in ["web_search", "web_fetch", "date_time", "todo", "clarify"] {
            assert!(!tool_requires_session_sandbox(name), "{name}");
        }
    }
}
