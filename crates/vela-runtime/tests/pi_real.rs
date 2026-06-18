use std::sync::Arc;
use std::{env, fs};

use tempfile::tempdir;
use vela_backends::PiBackendAdapter;
use vela_core::{BackendKind, CommandAck, EventType, SessionId};
use vela_runtime::{Runtime, SendUserMessage};
use vela_store::SqliteEventStore;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pi_rpc_real_send_turn_completes_with_temp_session_dir() {
    let workspace = tempdir().expect("temp workspace");
    let session_dir = tempdir().expect("temp pi session dir");
    let agent_dir = tempdir().expect("temp pi agent dir");
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let mut adapter = PiBackendAdapter::new(workspace.path().to_string_lossy());
    adapter.session_dir = Some(session_dir.path().to_string_lossy().to_string());
    adapter.no_tools = true;

    if env::var("VELA_PI_REAL_API_KEY").is_ok() {
        fs::write(
            agent_dir.path().join("models.json"),
            r#"{
              "providers": {
                "cloudagents": {
                  "baseUrl": "https://tokenhub.tencentmaas.com/v1",
                  "api": "openai-completions",
                  "apiKey": "$VELA_PI_REAL_API_KEY",
                  "authHeader": true,
                  "compat": {
                    "supportsDeveloperRole": false,
                    "supportsReasoningEffort": false,
                    "supportsUsageInStreaming": false,
                    "maxTokensField": "max_tokens"
                  },
                  "models": [
                    {
                      "id": "minimax-m2.7",
                      "name": "MiniMax M2.7 via CloudAgents",
                      "reasoning": false,
                      "input": ["text"],
                      "contextWindow": 128000,
                      "maxTokens": 4096
                    }
                  ]
                }
              }
            }"#,
        )
        .expect("write temporary Pi models.json");
        adapter.env.insert(
            "PI_CODING_AGENT_DIR".to_string(),
            agent_dir.path().to_string_lossy().to_string(),
        );
        adapter.provider = Some("cloudagents".to_string());
        adapter.model = Some("minimax-m2.7".to_string());
    }
    let runtime = Runtime::new(store.clone(), Arc::new(adapter));
    let session_id = SessionId::from("ses_pi_real_1");

    runtime
        .create_session(
            session_id.clone(),
            BackendKind::Pi,
            workspace.path().to_string_lossy().as_ref(),
        )
        .await
        .expect("create session");
    let ack = runtime
        .send_user_message(SendUserMessage {
            session_id: session_id.clone(),
            idempotency_key: "pi-real-1".to_string(),
            content: "Reply with exactly: vela-ok".to_string(),
            command_id: None,
        })
        .await
        .expect("send real Pi message");

    assert!(matches!(ack, CommandAck::Accepted(_)));
    let events = store.list_events(&session_id).await.expect("events");
    if events.iter().any(|event| {
        event.event_type == EventType::TURN_FAILED
            && event
                .payload
                .get("error")
                .and_then(|value| value.as_str())
                .is_some_and(|message| message.contains("No API key found"))
    }) {
        eprintln!("skipping Pi completion assertion because local Pi has no configured API key");
        return;
    }

    assert!(
        events
            .iter()
            .any(|event| event.event_type == EventType::TURN_COMPLETED),
        "expected turn.completed in event log, got: {events:#?}"
    );
}
