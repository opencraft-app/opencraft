use super::{
    events::{string_at, warning, with_raw},
    trace::codex_control_plane_trace,
    work_mapper::map_codex_work_notification,
};
use crate::BackendOutput;
use serde_json::{Value, json};
use vela_core::EventType;

pub fn normalize_codex_app_server_notification(method: &str, params: Value) -> Vec<BackendOutput> {
    if codex_control_plane_trace(method, params.clone()).is_some() {
        tracing::trace!(
            target: "vela_backends::codex",
            method,
            params = %params,
            "absorbed Codex app-server control-plane notification"
        );
        return Vec::new();
    }

    if let Some(outputs) = map_codex_work_notification(method, params.clone()) {
        return outputs;
    }

    match method {
        "thread/started"
        | "turn/started"
        | "item/started"
        | "item/completed"
        | "codex/event/item_started"
        | "codex/event/item_completed" => Vec::new(),
        "turn/plan/updated" => vec![with_raw(
            EventType::TASK_UPDATED,
            json!({
                "task_type": "plan",
                "status": "updated",
                "steps": params.get("plan").cloned().unwrap_or_else(|| json!([])),
            }),
            method,
            params,
        )],
        "thread/compacted" => vec![with_raw(
            EventType::TASK_UPDATED,
            json!({
                "task_type": "context_compaction",
                "status": "completed",
                "thread_id": params.get("threadId").cloned().unwrap_or(Value::Null),
                "turn_id": params.get("turnId").cloned().unwrap_or(Value::Null),
            }),
            method,
            params,
        )],
        "item/agentMessage/delta" => {
            let delta = string_at(&params, &["delta"]).unwrap_or_default();
            vec![with_raw(
                EventType::ASSISTANT_MESSAGE_DELTA,
                json!({
                    "message_id": string_at(&params, &["itemId"]).unwrap_or_else(|| "codex_message".to_string()),
                    "delta": delta,
                }),
                method,
                params,
            )]
        }
        "item/reasoning/summaryTextDelta" => vec![with_raw(
            EventType::ASSISTANT_REASONING_DELTA,
            json!({
                "reasoning_id": string_at(&params, &["itemId"]).unwrap_or_else(|| "codex_reasoning".to_string()),
                "delta": string_at(&params, &["delta"]).unwrap_or_default(),
            }),
            method,
            params,
        )],
        "turn/diff/updated" => vec![with_raw(
            EventType::DIFF_UPDATED,
            json!({ "diff": string_at(&params, &["diff"]).unwrap_or_default() }),
            method,
            params,
        )],
        "thread/tokenUsage/updated" => vec![with_raw(
            EventType::USAGE_UPDATED,
            json!({ "usage": params.get("tokenUsage").cloned().unwrap_or(Value::Null) }),
            method,
            params,
        )],
        "turn/completed" => {
            let turn = params.get("turn").cloned().unwrap_or(Value::Null);
            let status = string_at(&turn, &["status"]).unwrap_or_else(|| "completed".to_string());
            let success = matches!(
                status.as_str(),
                "completed" | "success" | "succeeded" | "ok"
            );
            vec![with_raw(
                if success {
                    EventType::TURN_COMPLETED
                } else {
                    EventType::TURN_FAILED
                },
                if success {
                    json!({ "status": status })
                } else {
                    json!({
                        "status": status,
                        "error": turn
                            .get("error")
                            .and_then(|error| error.get("message"))
                            .and_then(Value::as_str)
                            .unwrap_or("Codex turn failed"),
                    })
                },
                method,
                params,
            )]
        }
        _ => vec![warning(
            format!("unknown Codex app-server notification {method}"),
            json!({ "method": method, "params": params }),
        )],
    }
}
