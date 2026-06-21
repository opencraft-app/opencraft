use crate::BackendSend;
use serde_json::{Map, Value, json};
use vela_core::PermissionMode;

pub(crate) fn initialize_params() -> Value {
    json!({
        "clientInfo": {
            "name": "velachat",
            "title": "VelaChat",
            "version": "0.1.0",
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
