use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub struct CodexTraceRecord {
    pub kind: String,
    pub method: String,
    pub params: Value,
}

pub(crate) fn codex_control_plane_trace(method: &str, params: Value) -> Option<CodexTraceRecord> {
    if !is_codex_control_plane_notification(method) {
        return None;
    }
    Some(CodexTraceRecord {
        kind: "control_plane".to_string(),
        method: method.to_string(),
        params,
    })
}

pub(crate) fn is_codex_control_plane_notification(method: &str) -> bool {
    matches!(
        method,
        "remoteControl/status/changed"
            | "mcpServer/startupStatus/updated"
            | "thread/status/changed"
            | "account/rateLimits/updated"
            | "warning"
            | "error"
    )
}
