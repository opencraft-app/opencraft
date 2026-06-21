use super::super::events::{display_value, string_at, with_raw};
use super::shell::{extract_codex_shell_output, normalize_command_value};
use crate::BackendOutput;
use serde_json::{Map, Value, json};
use vela_core::EventType;

pub(super) fn map_legacy_exec_command_begin(method: &str, params: Value) -> BackendOutput {
    let msg = params.get("msg").cloned().unwrap_or(Value::Null);
    with_raw(
        EventType::COMMAND_STARTED,
        json!({
            "command_id": string_at(&msg, &["call_id"]).unwrap_or_else(|| "codex_command".to_string()),
            "command": normalize_command_value(msg.get("command").unwrap_or(&Value::Null))
                .unwrap_or_else(|| display_value(msg.get("command").unwrap_or(&Value::Null))),
            "cwd": msg.get("cwd").cloned().unwrap_or(Value::Null),
            "status": "running",
        }),
        method,
        params,
    )
}

pub(super) fn map_legacy_exec_command_output_delta(method: &str, params: Value) -> BackendOutput {
    let msg = params.get("msg").cloned().unwrap_or(Value::Null);
    with_raw(
        EventType::COMMAND_OUTPUT_DELTA,
        json!({
            "command_id": string_at(&msg, &["call_id"]).unwrap_or_else(|| "codex_command".to_string()),
            "stream": string_at(&msg, &["stream"]).unwrap_or_else(|| "stdout".to_string()),
            "delta": string_at(&msg, &["chunk"]).or_else(|| string_at(&msg, &["delta"])).unwrap_or_default(),
        }),
        method,
        params,
    )
}

pub(super) fn map_legacy_exec_command_end(method: &str, params: Value) -> BackendOutput {
    let msg = params.get("msg").cloned().unwrap_or(Value::Null);
    let success = msg.get("success").and_then(Value::as_bool).unwrap_or(true);
    with_raw(
        if success {
            EventType::COMMAND_COMPLETED
        } else {
            EventType::COMMAND_FAILED
        },
        json!({
            "command_id": string_at(&msg, &["call_id"]).unwrap_or_else(|| "codex_command".to_string()),
            "command": normalize_command_value(msg.get("command").unwrap_or(&Value::Null))
                .unwrap_or_else(|| display_value(msg.get("command").unwrap_or(&Value::Null))),
            "output": string_at(&msg, &["aggregated_output"])
                .or_else(|| string_at(&msg, &["aggregatedOutput"]))
                .or_else(|| string_at(&msg, &["formatted_output"]))
                .or_else(|| string_at(&msg, &["stdout"]))
                .map(|output| extract_codex_shell_output(&output))
                .unwrap_or_default(),
            "stderr": string_at(&msg, &["stderr"]),
            "exit_code": msg.get("exit_code").or_else(|| msg.get("exitCode")).cloned().unwrap_or(Value::Null),
            "status": if success { "completed" } else { "failed" },
        }),
        method,
        params,
    )
}

pub(super) fn map_command_execution_item(
    method: &str,
    params: Value,
    item: Value,
    status: &str,
) -> BackendOutput {
    let command = normalize_command_value(item.get("command").unwrap_or(&Value::Null))
        .unwrap_or_else(|| display_value(item.get("command").unwrap_or(&Value::Null)));
    let mut payload = Map::new();
    payload.insert(
        "command_id".to_string(),
        Value::String(string_at(&item, &["id"]).unwrap_or_else(|| "codex_command".to_string())),
    );
    payload.insert("command".to_string(), Value::String(command));
    payload.insert(
        "cwd".to_string(),
        item.get("cwd").cloned().unwrap_or(Value::Null),
    );
    payload.insert("status".to_string(), Value::String(status.to_string()));
    if let Some(output) = string_at(&item, &["aggregatedOutput"])
        .or_else(|| string_at(&item, &["aggregated_output"]))
        .or_else(|| string_at(&item, &["stdout"]))
    {
        payload.insert(
            "output".to_string(),
            Value::String(extract_codex_shell_output(&output)),
        );
    }
    if let Some(stderr) = string_at(&item, &["stderr"]) {
        payload.insert("stderr".to_string(), Value::String(stderr));
    }
    if let Some(exit_code) = item.get("exitCode").or_else(|| item.get("exit_code")) {
        payload.insert("exit_code".to_string(), exit_code.clone());
    }

    with_raw(
        command_event_type(status),
        Value::Object(payload),
        method,
        params,
    )
}

fn command_event_type(status: &str) -> EventType {
    match status {
        "running" => EventType::COMMAND_STARTED,
        "failed" | "cancelled" => EventType::COMMAND_FAILED,
        _ => EventType::COMMAND_COMPLETED,
    }
}
