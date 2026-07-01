use super::super::events::{display_value, string_at, with_raw};
use super::shell::{extract_codex_shell_output, normalize_command_value};
use crate::BackendOutput;
use serde_json::{Map, Value, json};
use vela_core::EventType;

pub(super) fn map_legacy_exec_command_begin(method: &str, params: Value) -> BackendOutput {
    let msg = params.get("msg").cloned().unwrap_or(Value::Null);
    let command = normalize_command_value(msg.get("command").unwrap_or(&Value::Null))
        .unwrap_or_else(|| display_value(msg.get("command").unwrap_or(&Value::Null)));
    with_raw(
        EventType::TOOL_STARTED,
        shell_tool_payload(
            string_at(&msg, &["call_id"]).unwrap_or_else(|| "codex_command".to_string()),
            command,
            msg.get("cwd").cloned().unwrap_or(Value::Null),
            "running",
            Value::Null,
            None,
            None,
            Value::Null,
        ),
        method,
        params,
    )
}

pub(super) fn map_legacy_exec_command_output_delta(method: &str, params: Value) -> BackendOutput {
    let msg = params.get("msg").cloned().unwrap_or(Value::Null);
    with_raw(
        EventType::TOOL_OUTPUT_DELTA,
        shell_output_delta_payload(
            string_at(&msg, &["call_id"]).unwrap_or_else(|| "codex_command".to_string()),
            string_at(&msg, &["stream"]).unwrap_or_else(|| "stdout".to_string()),
            string_at(&msg, &["chunk"])
                .or_else(|| string_at(&msg, &["delta"]))
                .unwrap_or_default(),
            msg.get("sequence").or_else(|| msg.get("seq")).cloned(),
            string_at(&msg, &["chunk_id"]).or_else(|| string_at(&msg, &["chunkId"])),
        ),
        method,
        params,
    )
}

pub(super) fn map_command_execution_output_delta(method: &str, params: Value) -> BackendOutput {
    let delta = string_at(&params, &["delta"])
        .or_else(|| string_at(&params, &["chunk"]))
        .or_else(|| string_at(&params, &["textDelta"]))
        .or_else(|| string_at(&params, &["text"]))
        .or_else(|| string_at(&params, &["content", "text"]))
        .unwrap_or_default();
    let tool_id = string_at(&params, &["itemId"])
        .or_else(|| string_at(&params, &["callId"]))
        .or_else(|| string_at(&params, &["id"]))
        .unwrap_or_else(|| "codex_command".to_string());
    let stream = string_at(&params, &["stream"])
        .or_else(|| string_at(&params, &["streamId"]))
        .or_else(|| string_at(&params, &["stream_id"]))
        .unwrap_or_else(|| "stdout".to_string());

    with_raw(
        EventType::TOOL_OUTPUT_DELTA,
        shell_output_delta_payload(
            tool_id,
            stream,
            delta,
            params
                .get("sequence")
                .or_else(|| params.get("seq"))
                .cloned(),
            string_at(&params, &["chunkId"]).or_else(|| string_at(&params, &["chunk_id"])),
        ),
        method,
        params,
    )
}

pub(super) fn map_legacy_exec_command_end(method: &str, params: Value) -> BackendOutput {
    let msg = params.get("msg").cloned().unwrap_or(Value::Null);
    let success = msg.get("success").and_then(Value::as_bool).unwrap_or(true);
    let output = string_at(&msg, &["aggregated_output"])
        .or_else(|| string_at(&msg, &["aggregatedOutput"]))
        .or_else(|| string_at(&msg, &["formatted_output"]))
        .or_else(|| string_at(&msg, &["stdout"]))
        .map(|output| extract_codex_shell_output(&output));
    let stderr = string_at(&msg, &["stderr"]);
    let exit_code = msg
        .get("exit_code")
        .or_else(|| msg.get("exitCode"))
        .cloned()
        .unwrap_or(Value::Null);
    let error = shell_error(success, stderr.as_deref(), msg.get("error"));
    let command = normalize_command_value(msg.get("command").unwrap_or(&Value::Null))
        .unwrap_or_else(|| display_value(msg.get("command").unwrap_or(&Value::Null)));
    with_raw(
        if success {
            EventType::TOOL_COMPLETED
        } else {
            EventType::TOOL_FAILED
        },
        shell_tool_payload(
            string_at(&msg, &["call_id"]).unwrap_or_else(|| "codex_command".to_string()),
            command,
            msg.get("cwd").cloned().unwrap_or(Value::Null),
            if success { "completed" } else { "failed" },
            exit_code,
            output,
            stderr,
            error,
        ),
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
    let output = string_at(&item, &["aggregatedOutput"])
        .or_else(|| string_at(&item, &["aggregated_output"]))
        .or_else(|| string_at(&item, &["stdout"]))
        .map(|output| extract_codex_shell_output(&output));
    let stderr = string_at(&item, &["stderr"]);
    let exit_code = item
        .get("exitCode")
        .or_else(|| item.get("exit_code"))
        .cloned()
        .unwrap_or(Value::Null);
    let error = shell_error(
        !matches!(status, "failed" | "cancelled"),
        stderr.as_deref(),
        item.get("error"),
    );

    with_raw(
        tool_event_type(status),
        shell_tool_payload(
            string_at(&item, &["id"]).unwrap_or_else(|| "codex_command".to_string()),
            command,
            item.get("cwd").cloned().unwrap_or(Value::Null),
            status,
            exit_code,
            output,
            stderr,
            error,
        ),
        method,
        params,
    )
}

fn tool_event_type(status: &str) -> EventType {
    match status {
        "running" => EventType::TOOL_STARTED,
        "failed" | "cancelled" => EventType::TOOL_FAILED,
        _ => EventType::TOOL_COMPLETED,
    }
}

fn shell_error(success: bool, stderr: Option<&str>, provider_error: Option<&Value>) -> Value {
    if success {
        return Value::Null;
    }
    if let Some(stderr) = stderr.filter(|value| !value.trim().is_empty()) {
        return Value::String(stderr.to_string());
    }
    provider_error
        .cloned()
        .unwrap_or_else(|| Value::String("Codex command failed".to_string()))
}

fn shell_tool_payload(
    tool_id: String,
    command: String,
    cwd: Value,
    status: &str,
    exit_code: Value,
    output: Option<String>,
    stderr: Option<String>,
    error: Value,
) -> Value {
    let mut detail = Map::new();
    detail.insert("type".to_string(), Value::String("shell".to_string()));
    detail.insert("command".to_string(), Value::String(command));
    if !cwd.is_null() {
        detail.insert("cwd".to_string(), cwd);
    }
    if !exit_code.is_null() {
        detail.insert("exit_code".to_string(), exit_code);
    }
    if let Some(output) = output {
        detail.insert("output".to_string(), Value::String(output));
    }
    if let Some(stderr) = stderr {
        detail.insert("stderr".to_string(), Value::String(stderr));
    }

    json!({
        "tool_id": tool_id,
        "name": "shell",
        "status": status,
        "detail": Value::Object(detail),
        "error": error,
    })
}

fn shell_output_delta_payload(
    tool_id: String,
    stream: String,
    delta: String,
    sequence: Option<Value>,
    chunk_id: Option<String>,
) -> Value {
    let mut payload = Map::new();
    payload.insert("tool_id".to_string(), Value::String(tool_id));
    payload.insert("stream_id".to_string(), Value::String(stream.clone()));
    payload.insert("stream".to_string(), Value::String(stream));
    payload.insert("delta".to_string(), Value::String(delta));
    payload.insert("encoding".to_string(), Value::String("utf8".to_string()));
    if let Some(sequence) = sequence {
        payload.insert("sequence".to_string(), sequence);
    }
    if let Some(chunk_id) = chunk_id {
        payload.insert("chunk_id".to_string(), Value::String(chunk_id));
    }
    Value::Object(payload)
}
