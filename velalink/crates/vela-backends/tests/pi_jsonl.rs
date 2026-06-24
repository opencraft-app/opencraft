use serde_json::json;
use std::{fs, time::Duration};
use tempfile::tempdir;
use tokio::time::timeout;
use vela_backends::{
    BackendSend, PiBackendAdapter, PiEventNormalizer, PiJsonlCodec, PiRuntimeMessage,
};
use vela_core::EventType;

mod support;

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

#[tokio::test]
async fn pi_send_user_message_collects_more_outputs_than_channel_capacity() {
    let dir = tempdir().expect("temp dir");
    let script_path = dir.path().join("fake-pi");
    fs::write(
        &script_path,
        r#"#!/bin/sh
IFS= read -r _
printf '%s\n' '{"type":"response","id":"req_1","command":"prompt","success":true}'
i=0
while [ "$i" -lt 40 ]; do
  printf '{"type":"message_update","message":{"role":"assistant","responseId":"resp_big"},"assistantMessageEvent":{"type":"text_delta","delta":"%s"}}\n' "$i"
  i=$((i + 1))
done
printf '%s\n' '{"type":"agent_end","messages":[]}'
"#,
    )
    .expect("write fake pi");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&script_path).expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script_path, permissions).expect("chmod fake pi");
    }

    let mut adapter = PiBackendAdapter::new(dir.path().to_string_lossy());
    adapter.command = script_path.to_string_lossy().into_owned();

    let outputs = timeout(
        Duration::from_secs(2),
        support::collect_backend_outputs(&adapter, BackendSend::new("hello".to_string())),
    )
    .await
    .expect("collecting outputs should not deadlock")
    .expect("fake pi should complete");

    assert_eq!(outputs.len(), 41);
    assert_eq!(
        outputs
            .iter()
            .filter(|output| output.event_type == EventType::ASSISTANT_MESSAGE_DELTA)
            .count(),
        40
    );
    assert_eq!(
        outputs.last().unwrap().event_type,
        EventType::TURN_COMPLETED
    );
}

#[test]
fn pi_events_normalize_text_delta_and_agent_end() {
    let text = vela_backends::normalize_pi_event(json!({
        "type": "message_update",
        "message": { "role": "assistant", "content": [], "responseId": "resp_1" },
        "assistantMessageEvent": { "type": "text_delta", "delta": "hello" }
    }));
    let done = vela_backends::normalize_pi_event(json!({ "type": "agent_end", "messages": [] }));

    assert_eq!(text.len(), 1);
    assert_eq!(
        text[0].event_type,
        vela_core::EventType::ASSISTANT_MESSAGE_DELTA
    );
    assert_eq!(text[0].payload["delta"], "hello");
    assert_eq!(text[0].payload["message_id"], "resp_1");
    assert_eq!(done[0].event_type, vela_core::EventType::TURN_COMPLETED);
}

#[test]
fn pi_normal_lifecycle_events_do_not_degrade_to_warnings() {
    let outputs = [
        json!({ "type": "agent_start" }),
        json!({ "type": "turn_start" }),
        json!({
            "type": "message_start",
            "message": { "role": "user", "content": [{ "type": "text", "text": "hello" }] }
        }),
        json!({
            "type": "message_end",
            "message": { "role": "user", "content": [{ "type": "text", "text": "hello" }] }
        }),
        json!({
            "type": "message_start",
            "message": { "role": "assistant", "content": [], "model": "minimax-m2.7" }
        }),
        json!({
            "type": "turn_end",
            "message": { "role": "assistant", "responseId": "resp_lifecycle" }
        }),
    ]
    .into_iter()
    .flat_map(vela_backends::normalize_pi_event)
    .collect::<Vec<_>>();

    assert!(
        outputs
            .iter()
            .all(|output| output.event_type != EventType::WARNING_RAISED),
        "normal Pi lifecycle should not appear as warnings: {outputs:#?}"
    );
    assert!(outputs.is_empty());
}

#[test]
fn pi_assistant_message_end_maps_to_message_completed_when_id_is_available() {
    let outputs = vela_backends::normalize_pi_event(json!({
        "type": "message_end",
        "message": {
            "role": "assistant",
            "responseId": "resp_done",
            "stopReason": "stop",
            "content": [{ "type": "text", "text": "done" }]
        }
    }));

    assert_eq!(outputs.len(), 1);
    assert_eq!(
        outputs[0].event_type,
        EventType::ASSISTANT_MESSAGE_COMPLETED
    );
    assert_eq!(outputs[0].payload["message_id"], "resp_done");
    assert_eq!(outputs[0].payload["stop_reason"], "stop");
}

#[test]
fn pi_assistant_message_start_maps_to_message_started_when_id_is_available() {
    let outputs = vela_backends::normalize_pi_event(json!({
        "type": "message_start",
        "message": {
            "role": "assistant",
            "messageId": "msg_start",
            "content": []
        }
    }));

    assert_eq!(outputs.len(), 1);
    assert_eq!(outputs[0].event_type, EventType::ASSISTANT_MESSAGE_STARTED);
    assert_eq!(outputs[0].payload, json!({ "message_id": "msg_start" }));
    assert_eq!(outputs[0].raw.as_ref().unwrap()["type"], "message_start");
}

#[test]
fn pi_assistant_message_lifecycle_without_stable_id_is_absorbed() {
    let outputs = [
        json!({
            "type": "message_start",
            "message": {
                "role": "assistant",
                "content": []
            }
        }),
        json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "done" }]
            }
        }),
    ]
    .into_iter()
    .flat_map(vela_backends::normalize_pi_event)
    .collect::<Vec<_>>();

    assert!(
        outputs.is_empty(),
        "assistant lifecycle without stable id should be absorbed, not rendered as unstable rows"
    );
}

#[test]
fn pi_unknown_assistant_message_update_subtype_is_absorbed_without_warning() {
    let outputs = vela_backends::normalize_pi_event(json!({
        "type": "message_update",
        "message": { "role": "assistant", "responseId": "resp_custom", "content": [] },
        "assistantMessageEvent": { "type": "metadata_delta", "delta": "ignored" }
    }));

    assert!(
        outputs.is_empty(),
        "known message_update envelope with unsupported assistant subtype should be absorbed until mapped"
    );
}

#[test]
fn pi_events_preserve_cloudagents_partial_response_id_as_message_id() {
    let outputs = vela_backends::normalize_pi_event(json!({
        "type": "message_update",
        "message": {
            "role": "assistant",
            "responseId": "f74e07dd-446a-4e53-bec7-23224d48f93b",
            "content": [{ "type": "text", "text": "hello" }]
        },
        "assistantMessageEvent": {
            "type": "text_delta",
            "delta": "hello",
            "partial": {
                "role": "assistant",
                "responseId": "f74e07dd-446a-4e53-bec7-23224d48f93b",
                "provider": "cloudagents",
                "model": "minimax-m2.7"
            }
        }
    }));

    assert_eq!(outputs.len(), 1);
    assert_eq!(
        outputs[0].event_type,
        vela_core::EventType::ASSISTANT_MESSAGE_DELTA
    );
    assert_eq!(
        outputs[0].payload["message_id"],
        "f74e07dd-446a-4e53-bec7-23224d48f93b"
    );
}

#[test]
fn pi_events_with_same_response_id_emit_same_canonical_message_id() {
    let events = [
        json!({
            "type": "message_update",
            "message": { "role": "assistant", "responseId": "resp_same", "content": [] },
            "assistantMessageEvent": { "type": "text_delta", "delta": "Hel" }
        }),
        json!({
            "type": "message_update",
            "message": { "role": "assistant", "responseId": "resp_same", "content": [] },
            "assistantMessageEvent": { "type": "text_delta", "delta": "lo" }
        }),
    ];
    let outputs = events
        .into_iter()
        .flat_map(vela_backends::normalize_pi_event)
        .collect::<Vec<_>>();

    assert_eq!(outputs.len(), 2);
    assert_eq!(outputs[0].payload["message_id"], "resp_same");
    assert_eq!(outputs[1].payload["message_id"], "resp_same");
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
    assert_eq!(
        outputs[0].event_type,
        vela_core::EventType::ASSISTANT_REASONING_DELTA
    );
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

    assert_eq!(started[0].event_type, vela_core::EventType::TOOL_STARTED);
    assert_eq!(
        started[0].payload,
        json!({
            "tool_id": "tool-1",
            "name": "bash",
            "status": "running",
            "detail": { "type": "shell", "command": "echo hi" },
            "error": null
        })
    );
    assert_eq!(
        completed[0].payload,
        json!({
            "tool_id": "tool-1",
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
fn pi_event_normalizer_preserves_tool_args_when_end_omits_args() {
    let mut normalizer = PiEventNormalizer::default();
    let started = normalizer.normalize(json!({
        "type": "tool_execution_start",
        "toolCallId": "tool-no-end-args",
        "toolName": "bash",
        "args": { "command": "date" }
    }));
    let completed = normalizer.normalize(json!({
        "type": "tool_execution_end",
        "toolCallId": "tool-no-end-args",
        "toolName": "bash",
        "result": { "output": "Mon Jun 22\n", "exitCode": 0 },
        "isError": false
    }));

    assert_eq!(started[0].payload["detail"]["command"], "date");
    assert_eq!(completed[0].event_type, EventType::TOOL_COMPLETED);
    assert_eq!(completed[0].payload["detail"]["type"], "shell");
    assert_eq!(completed[0].payload["detail"]["command"], "date");
    assert_eq!(completed[0].payload["detail"]["output"], "Mon Jun 22\n");
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

    assert_eq!(outputs[0].event_type, vela_core::EventType::TOOL_FAILED);
    assert_eq!(
        outputs[0].payload,
        json!({
            "tool_id": "tool-3",
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

#[test]
fn pi_fixture_assistant_text_turn_normalizes_to_turn_and_delta_events() {
    let outputs = support::normalize_pi_fixture("pi/assistant_text_turn.jsonl");

    support::assert_event_types(
        &outputs,
        &[
            EventType::ASSISTANT_MESSAGE_DELTA,
            EventType::ASSISTANT_MESSAGE_DELTA,
            EventType::TURN_COMPLETED,
        ],
    );
    assert_eq!(outputs[0].payload["delta"], "I will make a small update.\n");
    assert_eq!(outputs[1].payload["delta"], "Done.\n");
    assert!(
        outputs
            .iter()
            .all(|output| output.event_type != EventType::WARNING_RAISED)
    );
    assert_eq!(
        support::raw_types(&outputs),
        vec![
            Some("message_update".to_string()),
            Some("message_update".to_string()),
            Some("agent_end".to_string()),
        ]
    );
}

#[test]
fn pi_fixture_tool_lifecycle_normalizes_tool_events_without_losing_raw() {
    let outputs = support::normalize_pi_fixture("pi/tool_lifecycle_bash.jsonl");

    support::assert_event_types(
        &outputs,
        &[
            EventType::TOOL_STARTED,
            EventType::TOOL_UPDATED,
            EventType::TOOL_COMPLETED,
            EventType::ASSISTANT_MESSAGE_DELTA,
            EventType::TURN_COMPLETED,
        ],
    );
    assert_eq!(outputs[0].payload["name"], "bash");
    assert_eq!(outputs[2].payload["detail"]["output"], "integration\n");
    assert!(
        outputs
            .iter()
            .all(|output| output.event_type != EventType::WARNING_RAISED)
    );
    assert!(outputs.iter().all(|output| output.raw.is_some()));
}

#[test]
fn pi_fixture_unknown_event_degrades_to_warning() {
    let outputs = support::normalize_pi_fixture("pi/unknown_event.jsonl");

    support::assert_event_types(&outputs, &[EventType::WARNING_RAISED]);
    assert_eq!(
        outputs[0].payload["message"],
        "Unhandled Pi event type: workspace_signal"
    );
    assert_eq!(
        support::raw_types(&outputs),
        vec![Some("workspace_signal".to_string())]
    );
}
