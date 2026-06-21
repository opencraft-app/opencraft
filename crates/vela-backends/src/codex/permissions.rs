use super::events::{display_value, string_at, with_raw};
use crate::BackendOutput;
use serde_json::{Value, json};
use vela_core::EventType;

#[derive(Clone, Debug)]
pub(crate) struct CodexPermissionResponse {
    pub(crate) result: Option<String>,
    pub(crate) scope: Option<String>,
    pub(crate) answer: Option<String>,
    pub(crate) content: Option<Value>,
    pub(crate) options: Option<Value>,
}

pub(crate) fn codex_permission_request_output(
    id: i64,
    method: &str,
    params: Value,
) -> Option<BackendOutput> {
    let request_id = format!("codex_request_{id}");
    let backend_ref = json!({
        "id": id,
        "method": method,
    });
    match method {
        "item/commandExecution/requestApproval" => Some(with_raw(
            EventType::REQUEST_OPENED,
            json!({
                "request_id": request_id,
                "kind": "permission",
                "request_type": "tool_confirmation",
                "title": "Approve command",
                "command": string_at(&params, &["command"])
                    .unwrap_or_else(|| display_value(params.get("command").unwrap_or(&Value::Null))),
                "cwd": params.get("cwd").cloned().unwrap_or(Value::Null),
                "scope_options": ["once", "session"],
                "backend_ref": backend_ref,
            }),
            method,
            params,
        )),
        "execCommandApproval" => Some(with_raw(
            EventType::REQUEST_OPENED,
            json!({
                "request_id": request_id,
                "kind": "permission",
                "request_type": "tool_confirmation",
                "title": "Approve command",
                "command": display_value(params.get("command").unwrap_or(&Value::Null)),
                "cwd": params.get("cwd").cloned().unwrap_or(Value::Null),
                "scope_options": ["once", "session"],
                "backend_ref": backend_ref,
            }),
            method,
            params,
        )),
        "item/fileChange/requestApproval" | "applyPatchApproval" => Some(with_raw(
            EventType::REQUEST_OPENED,
            json!({
                "request_id": request_id,
                "kind": "permission",
                "request_type": "tool_confirmation",
                "title": "Approve file changes",
                "files": params.get("files")
                    .or_else(|| params.get("fileChanges"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "grant_root": params.get("grantRoot").cloned().unwrap_or(Value::Null),
                "scope_options": ["once", "session"],
                "backend_ref": backend_ref,
            }),
            method,
            params,
        )),
        "item/permissions/requestApproval" => Some(with_raw(
            EventType::REQUEST_OPENED,
            json!({
                "request_id": request_id,
                "kind": "permission",
                "request_type": "tool_confirmation",
                "title": "Approve permissions",
                "description": string_at(&params, &["reason"]),
                "cwd": params.get("cwd").cloned().unwrap_or(Value::Null),
                "permissions": params.get("permissions").cloned().unwrap_or(Value::Null),
                "scope_options": ["once", "session"],
                "backend_ref": backend_ref,
            }),
            method,
            params,
        )),
        "item/tool/requestUserInput" | "tool/requestUserInput" => Some(with_raw(
            EventType::REQUEST_OPENED,
            json!({
                "request_id": request_id,
                "kind": "question",
                "request_type": "request_answer",
                "title": "Answer agent request",
                "prompt": string_at(&params, &["prompt"])
                    .or_else(|| string_at(&params, &["message"]))
                    .unwrap_or_default(),
                "backend_ref": backend_ref,
            }),
            method,
            params,
        )),
        "mcpServer/elicitation/request" => Some(with_raw(
            EventType::REQUEST_OPENED,
            json!({
                "request_id": request_id,
                "kind": "question",
                "request_type": "request_answer",
                "title": "MCP server request",
                "server_name": string_at(&params, &["serverName"]),
                "prompt": string_at(&params, &["message"]).unwrap_or_default(),
                "schema": params.get("requestedSchema").cloned().unwrap_or(Value::Null),
                "mode": params.get("mode").cloned().unwrap_or(Value::Null),
                "url": params.get("url").cloned().unwrap_or(Value::Null),
                "backend_ref": backend_ref,
            }),
            method,
            params,
        )),
        "item/tool/call" => Some(with_raw(
            EventType::REQUEST_OPENED,
            json!({
                "request_id": request_id,
                "kind": "tool_call",
                "request_type": "custom_tool_result",
                "title": "Run client tool",
                "tool": string_at(&params, &["tool"]).unwrap_or_else(|| "tool".to_string()),
                "namespace": params.get("namespace").cloned().unwrap_or(Value::Null),
                "arguments": params.get("arguments").cloned().unwrap_or(Value::Null),
                "backend_ref": backend_ref,
            }),
            method,
            params,
        )),
        _ => None,
    }
}

pub(crate) fn codex_cancel_response_payload(method: &str) -> Value {
    match method {
        "mcpServer/elicitation/request" => json!({ "action": "cancel" }),
        "item/permissions/requestApproval" => json!({
            "permissions": {},
            "scope": "turn",
        }),
        "item/tool/call" => json!({
            "success": false,
            "contentItems": [],
        }),
        _ => json!({ "decision": "cancel" }),
    }
}

pub(crate) fn codex_permission_response_payload(
    method: &str,
    params: &Value,
    response: CodexPermissionResponse,
) -> Value {
    let decision = match response.result.as_deref() {
        Some("allow") | Some("approve") | Some("approved") | Some("yes") => "accept",
        Some("deny") | Some("denied") | Some("no") => "decline",
        Some("cancel") | Some("cancelled") | Some("interrupt") => "cancel",
        _ if response.answer.is_some() => "accept",
        _ => "decline",
    };
    match method {
        "mcpServer/elicitation/request" => json!({
            "action": decision,
            "content": response_content_json(&response),
        }),
        "item/permissions/requestApproval" => json!({
            "permissions": response.options
                .as_ref()
                .and_then(|options| options.get("permissions"))
                .cloned()
                .or_else(|| params.get("permissions").cloned())
                .unwrap_or_else(|| json!({})),
            "scope": response.scope.unwrap_or_else(|| "turn".to_string()),
            "strictAutoReview": response.options
                .as_ref()
                .and_then(|options| options.get("strict_auto_review"))
                .cloned()
                .unwrap_or(Value::Null),
        }),
        "item/tool/call" => json!({
            "success": decision == "accept",
            "contentItems": dynamic_tool_content_items(response.content.as_ref()),
        }),
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => json!({
            "decision": scoped_decision(decision, response.scope.as_deref()),
        }),
        "execCommandApproval" | "applyPatchApproval" => json!({
            "decision": decision,
        }),
        _ => json!({
            "decision": scoped_decision(decision, response.scope.as_deref()),
        }),
    }
}

fn scoped_decision(decision: &str, scope: Option<&str>) -> Value {
    if decision == "accept" && scope == Some("session") {
        Value::String("acceptForSession".to_string())
    } else {
        Value::String(decision.to_string())
    }
}

fn response_content_json(response: &CodexPermissionResponse) -> Value {
    if let Some(content) = &response.content {
        return content.clone();
    }
    let Some(answer) = &response.answer else {
        return Value::Null;
    };
    serde_json::from_str(answer).unwrap_or_else(|_| Value::String(answer.clone()))
}

fn dynamic_tool_content_items(content: Option<&Value>) -> Value {
    let Some(Value::Array(parts)) = content else {
        return json!([]);
    };
    Value::Array(
        parts
            .iter()
            .filter_map(|part| {
                let part_type = string_at(part, &["type"])?;
                match part_type.as_str() {
                    "text" => Some(json!({
                        "type": "inputText",
                        "text": string_at(part, &["text"]).unwrap_or_default(),
                    })),
                    "image_ref" => Some(json!({
                        "type": "inputImage",
                        "imageUrl": string_at(part, &["uri"]).unwrap_or_default(),
                    })),
                    _ => None,
                }
            })
            .collect(),
    )
}
