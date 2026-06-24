use serde_json::json;
use std::sync::Arc;

use vela_backends::{
    BackendOutput, BackendSend, MockBackendAdapter, RecordingAgentClient, ScriptedAgentCassette,
    ScriptedAgentClient,
};
use vela_core::EventType;

mod support;

#[tokio::test]
async fn scripted_agent_client_consumes_outputs_per_prompt_turn() {
    let client = ScriptedAgentClient::from_turns(vec![
        vec![BackendOutput::event(
            EventType::ASSISTANT_REASONING_DELTA,
            json!({ "text": "inspect" }),
        )],
        vec![BackendOutput::event(
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "text": "done" }),
        )],
    ]);

    let first =
        support::collect_backend_outputs(&client, BackendSend::new("first prompt".to_string()))
            .await
            .expect("first scripted turn");
    let second =
        support::collect_backend_outputs(&client, BackendSend::new("second prompt".to_string()))
            .await
            .expect("second scripted turn");

    assert_eq!(
        first[0].event_type,
        EventType::ASSISTANT_REASONING_DELTA,
        "first prompt should receive first scripted output set"
    );
    assert_eq!(
        second[0].event_type,
        EventType::ASSISTANT_MESSAGE_DELTA,
        "second prompt should receive second scripted output set"
    );
    assert_eq!(
        client.recorded_prompts().await,
        vec!["first prompt", "second prompt"]
    );
    assert_eq!(client.remaining_turns().await, 0);
}

#[tokio::test]
async fn scripted_agent_client_replays_recorded_cassette_without_provider_token() {
    let cassette = cassette_fixture("cloudagents_minimax_two_turn.json");
    let client = ScriptedAgentClient::from_cassette(cassette);

    let first = support::collect_backend_outputs(
        &client,
        BackendSend::new("fixture prompt one".to_string()),
    )
    .await
    .expect("first replay");
    let second = support::collect_backend_outputs(
        &client,
        BackendSend::new("fixture prompt two".to_string()),
    )
    .await
    .expect("second replay");

    assert_eq!(first[0].event_type, EventType::ASSISTANT_MESSAGE_DELTA);
    assert_eq!(second[0].payload["text"], "fixture response two");
    assert_eq!(client.recorded_prompts().await.len(), 2);
}

#[tokio::test]
async fn all_cassettes_replay_prompts_outputs_payloads_and_raw_losslessly() {
    for cassette_name in cassette_fixture_names() {
        let cassette = cassette_fixture(cassette_name);
        let client = ScriptedAgentClient::from_cassette(cassette.clone());

        for turn in &cassette.turns {
            let outputs =
                support::collect_backend_outputs(&client, BackendSend::new(turn.prompt.clone()))
                    .await
                    .expect("cassette replay turn");
            assert_eq!(
                outputs, turn.outputs,
                "cassette {cassette_name} should replay output event types, payload, and raw exactly"
            );
        }

        assert_eq!(
            client.recorded_prompts().await,
            cassette
                .turns
                .iter()
                .map(|turn| turn.prompt.clone())
                .collect::<Vec<_>>(),
            "cassette {cassette_name} should preserve prompt input order"
        );
        assert_eq!(
            client.remaining_turns().await,
            0,
            "cassette {cassette_name} should consume every scripted turn"
        );
    }
}

#[tokio::test]
async fn recording_agent_client_captures_prompts_and_outputs_as_cassette() {
    let inner = Arc::new(MockBackendAdapter::new(vec![BackendOutput::event(
        EventType::TURN_COMPLETED,
        json!({ "reason": "stop" }),
    )]));
    let recorder = RecordingAgentClient::new(inner, "cloudagents", Some("minimax-m2.7"));

    support::collect_backend_outputs(&recorder, BackendSend::new("record me".to_string()))
        .await
        .expect("recorded send");
    let cassette = recorder.to_cassette().await;

    assert_eq!(cassette.provider, "cloudagents");
    assert_eq!(cassette.model.as_deref(), Some("minimax-m2.7"));
    assert_eq!(cassette.turns.len(), 1);
    assert_eq!(cassette.turns[0].prompt, "record me");
    assert_eq!(
        cassette.turns[0].outputs[0].event_type,
        EventType::TURN_COMPLETED
    );
}

fn cassette_fixture_names() -> Vec<&'static str> {
    vec![
        "cloudagents_minimax_two_turn.json",
        "scripted_tool_lifecycle_success.json",
        "scripted_request_warning_success.json",
    ]
}

fn cassette_fixture(name: &str) -> ScriptedAgentCassette {
    let raw = match name {
        "cloudagents_minimax_two_turn.json" => {
            include_str!("fixtures/cassettes/cloudagents_minimax_two_turn.json")
        }
        "scripted_tool_lifecycle_success.json" => {
            include_str!("fixtures/cassettes/scripted_tool_lifecycle_success.json")
        }
        "scripted_request_warning_success.json" => {
            include_str!("fixtures/cassettes/scripted_request_warning_success.json")
        }
        other => panic!("unknown cassette fixture: {other}"),
    };
    serde_json::from_str(raw).expect("cassette fixture")
}
