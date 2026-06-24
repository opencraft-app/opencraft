mod command;
mod file_change;
mod patch;
mod shell;
mod tool_detail;
mod util;

use super::events::{string_at, with_raw};
use crate::BackendOutput;
use serde_json::{Value, json};
use vela_core::EventType;

pub fn map_codex_work_notification(method: &str, params: Value) -> Option<Vec<BackendOutput>> {
    if method == "item/started" || method == "item/completed" {
        return map_thread_item_notification(method, params);
    }

    match method {
        "codex/event/exec_command_begin" => {
            Some(vec![command::map_legacy_exec_command_begin(method, params)])
        }
        "codex/event/exec_command_output_delta" => {
            Some(vec![command::map_legacy_exec_command_output_delta(
                method, params,
            )])
        }
        "codex/event/exec_command_end" => {
            Some(vec![command::map_legacy_exec_command_end(method, params)])
        }
        _ => None,
    }
}

fn map_thread_item_notification(method: &str, params: Value) -> Option<Vec<BackendOutput>> {
    let item = params.get("item").cloned()?;
    let item_type = string_at(&item, &["type"])?;
    let cwd = string_at(&params, &["cwd"]).or_else(|| string_at(&item, &["cwd"]));
    let status = normalized_status(method, &item);

    match item_type.as_str() {
        "commandExecution" => Some(vec![command::map_command_execution_item(
            method, params, item, &status,
        )]),
        "mcpToolCall" => Some(vec![map_mcp_tool_call_item(method, params, item, cwd)]),
        "fileChange" => Some(vec![map_file_change_item(method, params, item, cwd)]),
        "webSearch" => Some(vec![map_web_search_item(method, params, item)]),
        "collabAgentToolCall" => Some(vec![map_collab_agent_item(method, params, item)]),
        _ => None,
    }
}

fn map_mcp_tool_call_item(
    method: &str,
    params: Value,
    item: Value,
    cwd: Option<String>,
) -> BackendOutput {
    let status = normalized_status(method, &item);
    let tool = string_at(&item, &["tool"]).unwrap_or_else(|| "tool".to_string());
    let name = match string_at(&item, &["server"]) {
        Some(server) if !server.is_empty() => format!("{server}.{tool}"),
        _ => tool.clone(),
    };
    let arguments = item.get("arguments").cloned().unwrap_or(Value::Null);
    let result = item.get("result").cloned().unwrap_or(Value::Null);
    let detail = tool_detail::mcp_tool_detail(&tool, &arguments, &result, cwd.as_deref());
    with_raw(
        tool_event_type(&status),
        json!({
            "tool_id": string_at(&item, &["id"]).unwrap_or_else(|| "codex_tool".to_string()),
            "name": name,
            "status": status,
            "detail": detail,
            "error": item.get("error").cloned().unwrap_or(Value::Null),
        }),
        method,
        params,
    )
}

fn map_file_change_item(
    method: &str,
    params: Value,
    item: Value,
    cwd: Option<String>,
) -> BackendOutput {
    let status = normalized_status(method, &item);
    let changes = item.get("changes").cloned().unwrap_or(Value::Null);
    let detail = file_change::file_change_detail(&changes, cwd.as_deref());
    with_raw(
        tool_event_type(&status),
        json!({
            "tool_id": string_at(&item, &["id"]).unwrap_or_else(|| "codex_file_change".to_string()),
            "name": "file_change",
            "status": status,
            "detail": detail,
            "error": item.get("error").cloned().unwrap_or(Value::Null),
        }),
        method,
        params,
    )
}

fn map_web_search_item(method: &str, params: Value, item: Value) -> BackendOutput {
    let status = normalized_status(method, &item);
    with_raw(
        tool_event_type(&status),
        json!({
            "tool_id": string_at(&item, &["id"]).unwrap_or_else(|| "codex_web_search".to_string()),
            "name": "web_search",
            "status": status,
            "detail": {
                "type": "search",
                "query": string_at(&item, &["query"]).unwrap_or_default(),
                "mode": "web",
            },
            "error": item.get("error").cloned().unwrap_or(Value::Null),
        }),
        method,
        params,
    )
}

fn map_collab_agent_item(method: &str, params: Value, item: Value) -> BackendOutput {
    let status = normalized_status(method, &item);
    with_raw(
        tool_event_type(&status),
        json!({
            "tool_id": string_at(&item, &["id"]).unwrap_or_else(|| "codex_sub_agent".to_string()),
            "name": "Sub-agent",
            "status": status,
            "detail": {
                "type": "unknown",
                "label": "Sub-agent",
                "input": string_at(&item, &["prompt"]).unwrap_or_default(),
                "output": item.get("agentsStates").cloned().unwrap_or(Value::Null),
            },
            "error": item.get("error").cloned().unwrap_or(Value::Null),
        }),
        method,
        params,
    )
}

fn normalized_status(method: &str, item: &Value) -> String {
    let raw = string_at(item, &["status"]).unwrap_or_else(|| {
        if method == "item/started" {
            "running".to_string()
        } else {
            "completed".to_string()
        }
    });
    match raw.as_str() {
        "running" | "in_progress" | "started" => "running",
        "failed" | "error" => "failed",
        "cancelled" | "canceled" => "cancelled",
        "completed" | "success" | "succeeded" | "done" => "completed",
        _ if method == "item/started" => "running",
        _ => "completed",
    }
    .to_string()
}

fn tool_event_type(status: &str) -> EventType {
    match status {
        "running" => EventType::TOOL_STARTED,
        "failed" | "cancelled" => EventType::TOOL_FAILED,
        _ => EventType::TOOL_COMPLETED,
    }
}
