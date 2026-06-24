use serde_json::json;
use vela_backends::BackendOutput;
use vela_core::EventType;

pub fn default_backend_outputs() -> Vec<BackendOutput> {
    vec![
        BackendOutput::event(
            EventType::REQUEST_OPENED,
            json!({
                "request_id": "req_1",
                "request_type": "tool_confirmation",
                "title": "Allow shell command?",
                "description": "Run ls",
                "status": "pending"
            }),
        ),
        BackendOutput::event(
            EventType::DIFF_UPDATED,
            json!({
                "file_path": "src/main.rs",
                "status": "modified",
                "additions": 2,
                "deletions": 1
            }),
        ),
        BackendOutput {
            event_type: EventType::WARNING_RAISED,
            payload: json!({ "message": "kept raw provider event" }),
            raw: Some(json!({ "provider": "mock", "type": "warning" })),
        },
        BackendOutput::event(
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "delta": "pong" }),
        ),
        BackendOutput::event(EventType::TURN_COMPLETED, json!({})),
    ]
}
