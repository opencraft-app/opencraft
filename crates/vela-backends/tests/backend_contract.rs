mod support;

use serde_json::json;
use vela_backends::{
    BackendOutput, normalize_acp_session_update, normalize_codex_app_server_notification,
};
use vela_core::EventType;

const CONTRACTED_VELAD_BACKENDS: &[&str] = &["Pi", "Codex", "Acp"];

#[test]
fn velad_registered_backends_are_covered_by_backend_contract_cases() {
    let registered = registered_velad_backends();
    assert!(
        !registered.is_empty(),
        "expected velad to register at least one backend"
    );

    let missing = registered
        .iter()
        .filter(|backend| !CONTRACTED_VELAD_BACKENDS.contains(&backend.as_str()))
        .cloned()
        .collect::<Vec<_>>();

    assert!(
        missing.is_empty(),
        "velad registers backend(s) without backend contract coverage: {missing:?}"
    );
}

#[test]
fn backend_contract_rejects_streaming_assistant_deltas_without_stable_message_id() {
    let outputs = vec![
        BackendOutput::event(
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "delta": "hel" }),
        ),
        BackendOutput::event(EventType::ASSISTANT_MESSAGE_DELTA, json!({ "delta": "lo" })),
    ];

    let error = support::validate_backend_output_contract("broken-backend", &outputs)
        .expect_err("streaming assistant deltas without message_id must fail contract");

    assert!(error.contains("stable message_id"));
}

#[test]
fn backend_contract_rejects_streaming_assistant_deltas_with_changing_message_id() {
    let outputs = vec![
        BackendOutput::event(
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "message_id": "msg_1", "delta": "hel" }),
        ),
        BackendOutput::event(
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "message_id": "msg_2", "delta": "lo" }),
        ),
    ];

    let error = support::validate_backend_output_contract("broken-backend", &outputs)
        .expect_err("streaming assistant deltas with changing message_id must fail contract");

    assert!(error.contains("different message_id"));
}

#[test]
fn backend_contract_accepts_single_complete_assistant_delta_without_message_id() {
    let outputs = vec![
        BackendOutput::event(
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "delta": "complete" }),
        ),
        BackendOutput::event(EventType::TURN_COMPLETED, json!({})),
    ];

    support::assert_backend_output_contract("single-shot-backend", &outputs);
}

#[test]
fn codex_app_server_outputs_satisfy_backend_contract() {
    let outputs = [
        normalize_codex_app_server_notification(
            "item/agentMessage/delta",
            json!({ "itemId": "codex_msg_1", "delta": "hel" }),
        ),
        normalize_codex_app_server_notification(
            "item/agentMessage/delta",
            json!({ "itemId": "codex_msg_1", "delta": "lo" }),
        ),
        normalize_codex_app_server_notification(
            "turn/completed",
            json!({ "turn": { "status": "completed" } }),
        ),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();

    support::assert_backend_output_contract("codex-app-server", &outputs);
}

#[test]
fn acp_outputs_satisfy_backend_contract() {
    let outputs = [
        normalize_acp_session_update(json!({
            "sessionUpdate": "agent_message_chunk",
            "messageId": "acp_msg_1",
            "content": { "type": "text", "text": "hel" }
        })),
        normalize_acp_session_update(json!({
            "sessionUpdate": "agent_message_chunk",
            "messageId": "acp_msg_1",
            "content": { "type": "text", "text": "lo" }
        })),
        vec![BackendOutput::event(EventType::TURN_COMPLETED, json!({}))],
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();

    support::assert_backend_output_contract("acp", &outputs);
}

#[test]
fn pi_outputs_satisfy_backend_contract() {
    let outputs = [
        vela_backends::normalize_pi_event(json!({
            "type": "message_update",
            "message": { "role": "assistant", "responseId": "pi_resp_1", "content": [] },
            "assistantMessageEvent": { "type": "text_delta", "delta": "hel" }
        })),
        vela_backends::normalize_pi_event(json!({
            "type": "message_update",
            "message": { "role": "assistant", "responseId": "pi_resp_1", "content": [] },
            "assistantMessageEvent": { "type": "text_delta", "delta": "lo" }
        })),
        vela_backends::normalize_pi_event(json!({ "type": "agent_end", "messages": [] })),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();

    support::assert_backend_output_contract("pi", &outputs);
}

#[test]
fn openai_compatible_single_shot_outputs_satisfy_backend_contract() {
    let outputs = vec![
        BackendOutput::event(
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "delta": "single-shot" }),
        ),
        BackendOutput::event(EventType::TURN_COMPLETED, json!({})),
    ];

    support::assert_backend_output_contract("openai-compatible", &outputs);
}

fn registered_velad_backends() -> Vec<String> {
    let source = include_str!("../../velad/src/main.rs");
    let needle = ".with_backend(BackendKind::";
    let mut registered = Vec::new();
    let mut rest = source;

    while let Some(index) = rest.find(needle) {
        rest = &rest[index + needle.len()..];
        let backend = rest
            .chars()
            .take_while(|character| character.is_ascii_alphanumeric() || *character == '_')
            .collect::<String>();
        if !backend.is_empty() {
            registered.push(backend);
        }
    }

    registered
}
