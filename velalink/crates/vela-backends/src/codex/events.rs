use crate::BackendOutput;
use serde::Deserialize;
use serde_json::{Value, json};
use vela_core::EventType;

pub(crate) const CODEX_APP_SERVER_TRACE_CODE: &str = "codex_app_server_trace";

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct CodexRawNotification {
    pub method: String,
    pub params: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexRawRequest {
    pub id: i64,
    pub method: String,
    pub params: Value,
}

pub(crate) fn with_raw(
    event_type: EventType,
    payload: Value,
    method: &str,
    params: Value,
) -> BackendOutput {
    BackendOutput {
        event_type,
        payload,
        raw: Some(json!({ "method": method, "params": params })),
    }
}

pub(crate) fn warning(message: impl Into<String>, raw: Value) -> BackendOutput {
    BackendOutput {
        event_type: EventType::WARNING_RAISED,
        payload: json!({
            "code": "codex_app_server_warning",
            "message": message.into(),
        }),
        raw: Some(raw),
    }
}

pub(crate) fn trace_span(
    name: impl Into<String>,
    method: Option<&str>,
    duration_ms: f64,
    ok: bool,
    error_message: Option<String>,
    attributes: Value,
) -> BackendOutput {
    BackendOutput {
        event_type: EventType::WARNING_RAISED,
        payload: json!({
            "code": CODEX_APP_SERVER_TRACE_CODE,
            "name": name.into(),
            "method": method,
            "duration_ms": duration_ms,
            "status_code": if ok { "OK" } else { "ERROR" },
            "error_message": error_message,
            "attributes": attributes,
        }),
        raw: None,
    }
}

pub(crate) fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(str::to_string)
}

pub(crate) fn display_value(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(display_value)
            .collect::<Vec<_>>()
            .join(" "),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}
