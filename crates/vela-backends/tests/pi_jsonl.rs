use serde_json::json;
use vela_backends::{PiBackendAdapter, PiJsonlCodec, PiRuntimeMessage};

#[test]
fn pi_jsonl_codec_buffers_partial_lines_and_splits_messages() {
    let mut codec = PiJsonlCodec::default();

    assert!(
        codec
            .push_chunk("{\"type\":\"turn_start\"")
            .unwrap()
            .is_empty()
    );
    let messages = codec
        .push_chunk(
            "}\n{\"type\":\"response\",\"id\":\"req_1\",\"command\":\"prompt\",\"success\":true}\n",
        )
        .unwrap();

    assert_eq!(messages.len(), 2);
    assert!(matches!(messages[0], PiRuntimeMessage::Event(_)));
    assert!(matches!(messages[1], PiRuntimeMessage::Response(_)));
}

#[test]
fn pi_jsonl_codec_ignores_blank_and_non_json_stdout_lines() {
    let mut codec = PiJsonlCodec::default();

    let messages = codec
        .push_chunk("\nnot json\n{\"type\":\"turn_start\"}\n")
        .expect("codec should tolerate noisy stdout");

    assert_eq!(
        messages,
        vec![PiRuntimeMessage::Event(json!({"type": "turn_start"}))]
    );
}

#[test]
fn pi_jsonl_codec_keeps_unicode_line_separators_inside_record() {
    let mut codec = PiJsonlCodec::default();

    let messages = codec
        .push_chunk(&format!(
            "{}\n",
            json!({ "type": "message", "text": "a\u{2028}b\u{2029}c" })
        ))
        .expect("unicode separators are not jsonl separators");

    assert_eq!(
        messages,
        vec![PiRuntimeMessage::Event(json!({
            "type": "message",
            "text": "a\u{2028}b\u{2029}c"
        }))]
    );
}

#[test]
fn pi_backend_launch_args_include_rpc_mode_and_configuration_once() {
    let mut adapter = PiBackendAdapter::new("/workspace/project");
    adapter.provider = Some("cloudagents".to_string());
    adapter.model = Some("minimax-m2.7".to_string());
    adapter.thinking = Some("off".to_string());
    adapter.session = Some("/tmp/pi-session.jsonl".to_string());
    adapter.session_dir = Some("/tmp/pi-sessions".to_string());
    adapter.no_tools = true;

    assert_eq!(
        adapter.launch_args(),
        vec![
            "--mode",
            "rpc",
            "--model",
            "minimax-m2.7",
            "--thinking",
            "off",
            "--session",
            "/tmp/pi-session.jsonl",
            "--provider",
            "cloudagents",
            "--session-dir",
            "/tmp/pi-sessions",
            "--no-tools",
        ]
    );
}

#[test]
fn pi_events_normalize_text_delta_and_agent_end() {
    let text = vela_backends::normalize_pi_event(json!({
        "type": "message_update",
        "message": { "role": "assistant", "content": [] },
        "assistantMessageEvent": { "type": "text_delta", "delta": "hello" }
    }));
    let done = vela_backends::normalize_pi_event(json!({ "type": "agent_end", "messages": [] }));

    assert_eq!(text.len(), 1);
    assert_eq!(
        text[0].event_type,
        vela_core::EventType::ASSISTANT_MESSAGE_DELTA
    );
    assert_eq!(text[0].payload["delta"], "hello");
    assert_eq!(done[0].event_type, vela_core::EventType::TURN_COMPLETED);
}

#[test]
fn pi_events_ignore_non_assistant_message_updates() {
    let outputs = vela_backends::normalize_pi_event(json!({
        "type": "message_update",
        "message": { "role": "user", "content": "hello" },
        "assistantMessageEvent": { "type": "text_delta", "delta": "should-not-render" }
    }));

    assert!(outputs.is_empty());
}

#[test]
fn pi_events_normalize_reasoning_delta() {
    let outputs = vela_backends::normalize_pi_event(json!({
        "type": "message_update",
        "message": { "role": "assistant", "content": [] },
        "assistantMessageEvent": { "type": "thinking_delta", "delta": "thinking" }
    }));

    assert_eq!(outputs.len(), 1);
    assert_eq!(outputs[0].event_type, vela_core::EventType::REASONING_DELTA);
    assert_eq!(outputs[0].payload, json!({ "delta": "thinking" }));
}

#[test]
fn pi_events_normalize_bash_tool_lifecycle_with_detail() {
    let started = vela_backends::normalize_pi_event(json!({
        "type": "tool_execution_start",
        "toolCallId": "tool-1",
        "toolName": "bash",
        "args": { "command": "echo hi" }
    }));
    let completed = vela_backends::normalize_pi_event(json!({
        "type": "tool_execution_end",
        "toolCallId": "tool-1",
        "toolName": "bash",
        "args": { "command": "echo hi" },
        "result": { "output": "hi\n", "exitCode": 0 },
        "isError": false
    }));

    assert_eq!(
        started[0].event_type,
        vela_core::EventType::TOOL_CALL_STARTED
    );
    assert_eq!(
        started[0].payload,
        json!({
            "tool_call_id": "tool-1",
            "name": "bash",
            "status": "running",
            "detail": { "type": "shell", "command": "echo hi" },
            "error": null
        })
    );
    assert_eq!(
        completed[0].payload,
        json!({
            "tool_call_id": "tool-1",
            "name": "bash",
            "status": "completed",
            "detail": {
                "type": "shell",
                "command": "echo hi",
                "output": "hi\n",
                "exit_code": 0
            },
            "error": null
        })
    );
}

#[test]
fn pi_events_normalize_legacy_edit_tool_with_diff() {
    let outputs = vela_backends::normalize_pi_event(json!({
        "type": "tool_execution_end",
        "toolCallId": "tool-2",
        "toolName": "edit",
        "args": {
            "path": "app.ts",
            "old_string": "before",
            "new_string": "after"
        },
        "result": { "details": { "diff": "-before\n+after" } },
        "isError": false
    }));

    assert_eq!(
        outputs[0].payload["detail"],
        json!({
            "type": "edit",
            "file_path": "app.ts",
            "old_string": "before",
            "new_string": "after",
            "unified_diff": "-before\n+after"
        })
    );
}

#[test]
fn pi_events_preserve_unknown_tool_input_and_result() {
    let outputs = vela_backends::normalize_pi_event(json!({
        "type": "tool_execution_end",
        "toolCallId": "tool-3",
        "toolName": "custom_tool",
        "args": { "value": 42 },
        "result": { "text": "custom result" },
        "isError": true
    }));

    assert_eq!(
        outputs[0].event_type,
        vela_core::EventType::TOOL_CALL_FAILED
    );
    assert_eq!(
        outputs[0].payload,
        json!({
            "tool_call_id": "tool-3",
            "name": "custom_tool",
            "status": "failed",
            "detail": {
                "type": "unknown",
                "input": { "value": 42 },
                "output": { "text": "custom result" }
            },
            "error": { "text": "custom result" }
        })
    );
}

#[test]
fn pi_events_normalize_mcp_proxy_tool_names() {
    let outputs = vela_backends::normalize_pi_event(json!({
        "type": "tool_execution_start",
        "toolCallId": "tool-4",
        "toolName": "mcp",
        "args": {
            "tool": "paseo_list_models",
            "args": "{\"provider\":\"pi\"}"
        }
    }));

    assert_eq!(outputs[0].payload["name"], "paseo.list_models");
}
