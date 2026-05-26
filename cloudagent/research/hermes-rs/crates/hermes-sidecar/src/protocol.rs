use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use hermes_core::{AgentStatus, RunRecord, TranscriptEntry};

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct SessionCreateRequest {
    pub(crate) session_id: String,
    #[serde(default)]
    pub(crate) cwd: Option<String>,
    #[serde(default)]
    pub(crate) agent_version: Option<String>,
    #[serde(default)]
    pub(crate) workspace_version: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct RuntimeInputRequest {
    pub(crate) session_id: String,
    #[serde(default)]
    pub(crate) input_id: Option<String>,
    #[serde(default)]
    pub(crate) inbox_mode: Option<String>,
    #[serde(default)]
    pub(crate) blocks: Vec<RuntimeInputBlock>,
    #[serde(default)]
    pub(crate) cwd: Option<String>,
    #[serde(default)]
    pub(crate) history: Vec<RuntimeInputHistoryEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum RuntimeInputBlock {
    Text { text: String },
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub(crate) struct RuntimeInputHistoryEntry {
    pub(crate) role: String,
    pub(crate) text: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct RuntimeAbortRequest {
    pub(crate) session_id: String,
    #[serde(default)]
    pub(crate) run_id: Option<String>,
    #[serde(default)]
    pub(crate) clear_pending: bool,
    #[serde(default)]
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct RuntimeInputResponse {
    pub(crate) input_id: String,
    pub(crate) status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) output_text: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct RuntimeAbortResponse {
    pub(crate) ok: bool,
    pub(crate) dropped_pending: usize,
    pub(crate) status: AgentStatus,
}

#[derive(Debug, Serialize)]
pub(crate) struct RuntimeStatusResponse {
    pub(crate) ok: bool,
    pub(crate) session_id: String,
    pub(crate) status: AgentStatus,
    pub(crate) runtime_store_load: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) active_run_id: Option<String>,
    pub(crate) pending_run_count: usize,
    pub(crate) pending_by_mode: PendingByMode,
    pub(crate) run_count: usize,
    pub(crate) transcript_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_user_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_assistant_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_run_status: Option<String>,
    pub(crate) run_ledger_tail: Vec<RunRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) active_prompt: Option<ActivePromptHealth>,
}

#[derive(Debug, Serialize)]
pub(crate) struct PendingByMode {
    pub(crate) prompt: usize,
    pub(crate) steer: usize,
    pub(crate) follow_up: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct RuntimeTranscriptResponse {
    pub(crate) entries: Vec<TranscriptEntry>,
}

#[derive(Debug, Serialize)]
pub(crate) struct RuntimeRunLedgerResponse {
    pub(crate) runs: Vec<RunRecord>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct EnsureInnerRequest {
    #[serde(default)]
    pub(crate) force: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct WorkspaceBindRequest {
    pub(crate) workspace_id: String,
    pub(crate) workspace_runtime_id: String,
    pub(crate) sandbox_id: String,
    pub(crate) domain: String,
    pub(crate) envd_access_token: String,
    #[serde(default)]
    pub(crate) traffic_access_token: String,
    #[serde(default = "default_workspace_root")]
    pub(crate) workspace_root: String,
    #[serde(default)]
    pub(crate) command_prefix: Option<String>,
    #[serde(default)]
    pub(crate) command_shell_prefix: Option<String>,
    #[serde(default)]
    pub(crate) shutdown_command: Option<String>,
    #[serde(default)]
    pub(crate) replace_existing: bool,
}

fn default_workspace_root() -> String {
    "/workspace".to_string()
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub(crate) struct StageFilesManifest {
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    #[serde(default)]
    pub(crate) generation: Option<u64>,
    #[serde(default)]
    pub(crate) workspace_root: Option<String>,
    #[serde(default)]
    pub(crate) files: Vec<StagedFile>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub(crate) struct StagedFile {
    #[serde(default)]
    pub(crate) file_id: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) mime_type: String,
    #[serde(default)]
    pub(crate) bytes: Option<u64>,
    #[serde(default)]
    pub(crate) sha256: String,
    #[serde(default)]
    pub(crate) outer_path: String,
    #[serde(default)]
    pub(crate) workspace_path: String,
}

#[derive(Debug, Default)]
pub(crate) struct StageFilesState {
    pub(crate) generation: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub(crate) struct WorkspaceFileUploadRequest {
    pub(crate) path: String,
    pub(crate) content_b64: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub(crate) struct WorkspaceFileDownloadRequest {
    pub(crate) path: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub(crate) struct WorkspaceFileDownloadResponse {
    pub(crate) ok: bool,
    pub(crate) path: String,
    pub(crate) bytes: u64,
    pub(crate) content_b64: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct HealthJsonResponse {
    pub(crate) ok: bool,
    pub(crate) session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) generation: Option<u64>,
    pub(crate) workspace_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) inner_sandbox_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) active_prompt: Option<ActivePromptHealth>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ActivePromptHealth {
    pub(crate) job_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum PromptResponseLine {
    OutputTextDelta {
        delta: String,
    },
    ReasoningDelta {
        delta: String,
    },
    ToolCall {
        tool_call_id: String,
        name: String,
        status: String,
        raw_input: Option<Value>,
    },
    ToolCallUpdate {
        tool_call_id: String,
        name: String,
        status: String,
        error: Option<String>,
        raw_output: Option<Value>,
        content: Option<String>,
    },
    RuntimeHost {
        event: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        sandbox_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_root: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        template: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Result {
        output_text: String,
        inner_sandbox_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        inner_sandbox_domain: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        inner_envd_access_token: Option<String>,
    },
    Error {
        #[serde(default)]
        code: Option<String>,
        error: String,
    },
}

#[derive(Debug)]
pub(crate) struct PromptOutcome {
    pub(crate) output_text: String,
    pub(crate) inner_sandbox_id: Option<String>,
    pub(crate) inner_sandbox_domain: Option<String>,
    pub(crate) inner_envd_access_token: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct EnsureInnerResponse {
    pub(crate) inner_sandbox_id: String,
    pub(crate) inner_sandbox_domain: String,
    pub(crate) inner_envd_access_token: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceBindResponse {
    pub(crate) ok: bool,
    pub(crate) workspace_id: String,
    pub(crate) workspace_runtime_id: String,
    pub(crate) sandbox_id: String,
    pub(crate) workspace_root: String,
}

#[derive(Debug)]
pub(crate) struct HttpRequest {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) body: Vec<u8>,
}

#[derive(Debug)]
pub(crate) struct HttpResponse {
    pub(crate) status: u16,
    pub(crate) content_type: &'static str,
    pub(crate) body: Vec<u8>,
    pub(crate) shutdown_after_response: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct SessionPaths {
    pub(crate) workspace_root: PathBuf,
    pub(crate) memory_root: PathBuf,
}
