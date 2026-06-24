use crate::BackendSend;
use serde_json::{Map, Value, json};
use vela_core::{AgentConfig, PermissionMode, ReasoningEffortOption};

const CODEX_FAST_MODE_SUPPORTED_MODEL_PREFIXES: &[&str] = &["gpt-5", "gpt-4.1", "o3", "o4-mini"];
const CODEX_NON_ORIGINATING_APP_SERVER_CLIENT_NAME: &str = "codex_app_server_daemon";
const CODEX_NON_ORIGINATING_APP_SERVER_CLIENT_TITLE: &str = "Codex App Server Daemon";
const CODEX_NON_ORIGINATING_APP_SERVER_CLIENT_VERSION: &str = "0.0.0";

pub(crate) fn initialize_params() -> Value {
    json!({
        "clientInfo": {
            "name": CODEX_NON_ORIGINATING_APP_SERVER_CLIENT_NAME,
            "title": CODEX_NON_ORIGINATING_APP_SERVER_CLIENT_TITLE,
            "version": CODEX_NON_ORIGINATING_APP_SERVER_CLIENT_VERSION,
        },
        "capabilities": {
            "experimentalApi": true,
        },
    })
}

pub fn thread_start_params(input: &BackendSend, default_cwd: &str) -> Value {
    let config = input
        .resolved_agent_config
        .as_ref()
        .map(|resolved| &resolved.config);
    let mut params = Map::new();
    params.insert(
        "cwd".to_string(),
        Value::String(
            input
                .working_directory
                .clone()
                .unwrap_or_else(|| default_cwd.to_string()),
        ),
    );
    if let Some(model) = config.and_then(|config| config.model.clone()) {
        params.insert("model".to_string(), Value::String(model));
    }
    if let Some(reasoning_effort) = config.and_then(|config| config.reasoning_effort.clone()) {
        params.insert(
            "reasoningEffort".to_string(),
            Value::String(reasoning_effort),
        );
    }
    let (sandbox, approval_policy, network_access) =
        match config.and_then(|config| config.permission_mode) {
            Some(PermissionMode::ReadOnly) => ("read-only", "on-request", false),
            Some(PermissionMode::FullAccess) => ("danger-full-access", "never", true),
            Some(PermissionMode::AutoReview) => ("workspace-write", "on-request", false),
            Some(PermissionMode::Auto) | None => ("workspace-write", "on-request", false),
        };
    params.insert("sandbox".to_string(), Value::String(sandbox.to_string()));
    params.insert(
        "approvalPolicy".to_string(),
        Value::String(approval_policy.to_string()),
    );
    params.insert("networkAccess".to_string(), Value::Bool(network_access));
    if matches!(
        config.and_then(|config| config.permission_mode),
        Some(PermissionMode::AutoReview)
    ) {
        params.insert(
            "approvalsReviewer".to_string(),
            Value::String("auto_review".to_string()),
        );
    }
    Value::Object(params)
}

pub fn turn_start_params(input: &BackendSend, thread_id: &str) -> Value {
    let config = input
        .resolved_agent_config
        .as_ref()
        .map(|resolved| &resolved.config);
    let mut params = Map::new();
    params.insert("threadId".to_string(), Value::String(thread_id.to_string()));
    params.insert(
        "input".to_string(),
        json!([{
            "type": "text",
            "text": input.content,
        }]),
    );
    if let Some(model) = config.and_then(|config| config.model.clone()) {
        params.insert("model".to_string(), Value::String(model));
    }
    if let Some(reasoning_effort) = config.and_then(|config| config.reasoning_effort.clone()) {
        params.insert("effort".to_string(), Value::String(reasoning_effort));
    }
    let (sandbox, approval_policy, network_access) =
        codex_mode_params(config.and_then(|config| config.permission_mode));
    params.insert(
        "approvalPolicy".to_string(),
        Value::String(approval_policy.to_string()),
    );
    params.insert(
        "sandboxPolicy".to_string(),
        sandbox_policy_value(sandbox, network_access),
    );
    if matches!(
        config.and_then(|config| config.permission_mode),
        Some(PermissionMode::AutoReview)
    ) {
        params.insert(
            "approvalsReviewer".to_string(),
            Value::String("auto_review".to_string()),
        );
    }
    if config.is_some_and(codex_fast_mode_enabled) {
        params.insert("serviceTier".to_string(), Value::String("fast".to_string()));
    }
    Value::Object(params)
}

pub fn codex_reasoning_effort_options(default_id: Option<&str>) -> Vec<ReasoningEffortOption> {
    [
        ("off", "Off"),
        ("minimal", "Minimal"),
        ("low", "Low"),
        ("medium", "Medium"),
        ("high", "High"),
        ("xhigh", "XHigh"),
    ]
    .into_iter()
    .map(|(id, label)| ReasoningEffortOption {
        id: id.to_string(),
        label: label.to_string(),
        description: None,
        is_default: default_id.unwrap_or("medium") == id,
        metadata: Default::default(),
    })
    .collect()
}

pub fn codex_model_supports_fast_mode(model: Option<&str>) -> bool {
    let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) else {
        return false;
    };
    CODEX_FAST_MODE_SUPPORTED_MODEL_PREFIXES
        .iter()
        .any(|prefix| model == *prefix || model.starts_with(prefix))
}

fn codex_fast_mode_enabled(config: &AgentConfig) -> bool {
    config
        .feature_values
        .get("fast_mode")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && codex_model_supports_fast_mode(config.model.as_deref())
}

fn codex_mode_params(mode: Option<PermissionMode>) -> (&'static str, &'static str, bool) {
    match mode {
        Some(PermissionMode::ReadOnly) => ("read-only", "on-request", false),
        Some(PermissionMode::FullAccess) => ("danger-full-access", "never", true),
        Some(PermissionMode::AutoReview) => ("workspace-write", "on-request", false),
        Some(PermissionMode::Auto) | None => ("workspace-write", "on-request", false),
    }
}

fn sandbox_policy_value(sandbox: &str, network_access: bool) -> Value {
    match sandbox {
        "read-only" => json!({ "type": "readOnly" }),
        "danger-full-access" => json!({ "type": "dangerFullAccess" }),
        _ => json!({ "type": "workspaceWrite", "networkAccess": network_access }),
    }
}
