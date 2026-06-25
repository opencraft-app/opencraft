use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};
use sqlx::sqlite::SqlitePoolOptions;
use tokio::{
    sync::{Mutex, oneshot},
    time::{Duration, sleep, timeout},
};
use vela_backends::{
    BackendAdapter, BackendOutput, BackendOutputSink, BackendSend, MockBackendAdapter,
    emit_backend_outputs,
};
use vela_core::{
    AgentConfig, BackendKind, BlobRef, CanonicalEvent, CommandAck, CommandId, EventType,
    PermissionMode, SessionId, UserMessageBlock,
};
use vela_runtime::{Runtime, SendUserMessage};
use vela_store::SqliteEventStore;

mod support;

#[tokio::test]
async fn send_user_message_accepts_once_and_replays_idempotency() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(vec![
        vela_backends::BackendOutput::event(EventType::TURN_COMPLETED, json!({})),
    ]));
    let runtime = Runtime::new(store.clone(), backend.clone());
    let session_id = SessionId::from("ses_runtime_1");
    runtime
        .create_session(session_id.clone(), BackendKind::Pi, "/tmp/vela")
        .await
        .expect("create session");

    let first = runtime
        .send_user_message(SendUserMessage {
            session_id: session_id.clone(),
            idempotency_key: "idem-1".to_string(),
            content: "hello".to_string(),
            command_id: None,
        })
        .await
        .expect("first send");
    eventually_contains_event(&store, &session_id, EventType::TURN_COMPLETED).await;
    let second = runtime
        .send_user_message(SendUserMessage {
            session_id: session_id.clone(),
            idempotency_key: "idem-1".to_string(),
            content: "hello".to_string(),
            command_id: None,
        })
        .await
        .expect("second send");

    assert_eq!(first, second);
    assert_eq!(backend.prompt_count().await, 1);
    let events = store.list_events(&session_id).await.expect("events");
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == EventType::USER_MESSAGE_ACCEPTED)
            .count(),
        1
    );
}

#[tokio::test]
async fn turn_started_freezes_current_session_agent_config() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(vec![
        vela_backends::BackendOutput::event(EventType::TURN_COMPLETED, json!({})),
    ]));
    let runtime = Runtime::new(store.clone(), backend.clone());
    let session_id = SessionId::from("ses_runtime_resolved_agent_config");
    runtime
        .create_session_with_agent_config(
            session_id.clone(),
            BackendKind::Pi,
            "/tmp/vela",
            None,
            AgentConfig {
                model: Some("minimax-m2.7".to_string()),
                reasoning_effort: Some("high".to_string()),
                permission_mode: Some(PermissionMode::FullAccess),
                feature_values: Default::default(),
            },
            None,
        )
        .await
        .expect("create session");

    runtime
        .send_user_message(SendUserMessage {
            session_id: session_id.clone(),
            idempotency_key: "idem-resolved-agent-config".to_string(),
            content: "hello".to_string(),
            command_id: None,
        })
        .await
        .expect("send");

    let events = eventually_contains_event(&store, &session_id, EventType::TURN_STARTED).await;
    let turn_started = events
        .iter()
        .find(|event| event.event_type == EventType::TURN_STARTED)
        .expect("turn.started");
    assert_eq!(
        turn_started.payload["resolved_agent_config"],
        json!({
            "backend": "pi",
            "model": "minimax-m2.7",
            "reasoning_effort": "high",
            "permission_mode": "full_access",
            "feature_values": {}
        })
    );
    assert_eq!(
        serde_json::to_value(
            backend.recorded_resolved_agent_configs().await[0]
                .clone()
                .expect("backend resolved config")
        )
        .expect("serialize backend resolved config"),
        turn_started.payload["resolved_agent_config"]
    );
}

#[tokio::test]
async fn backend_send_receives_session_context_and_events_use_resolved_backend_source() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(RecordingSendBackend::default());
    let runtime = Runtime::new(store.clone(), backend.clone());
    let session_id = SessionId::from("ses_runtime_codex_context");
    runtime
        .create_session_with_agent_config(
            session_id.clone(),
            BackendKind::Codex,
            "/tmp/codex-workspace",
            None,
            AgentConfig::default(),
            None,
        )
        .await
        .expect("create session");

    runtime
        .send_user_message(SendUserMessage {
            session_id: session_id.clone(),
            idempotency_key: "idem-codex-context".to_string(),
            content: "hello codex".to_string(),
            command_id: None,
        })
        .await
        .expect("send");

    let events = eventually_contains_event(&store, &session_id, EventType::TURN_COMPLETED).await;
    let sends = backend.recorded_inputs().await;
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].session_id.as_ref(), Some(&session_id));
    assert_eq!(
        sends[0].working_directory.as_deref(),
        Some("/tmp/codex-workspace")
    );
    assert_eq!(
        sends[0]
            .resolved_agent_config
            .as_ref()
            .map(|config| config.backend),
        Some(BackendKind::Codex)
    );
    let turn_started = events
        .iter()
        .find(|event| event.event_type == EventType::TURN_STARTED)
        .expect("turn.started");
    let send_turn_id = sends[0]
        .turn_id
        .as_ref()
        .expect("backend send turn id")
        .to_string();
    assert_eq!(turn_started.payload["turn_id"], send_turn_id);

    let turn_completed = events
        .iter()
        .find(|event| event.event_type == EventType::TURN_COMPLETED)
        .expect("turn.completed");
    assert_eq!(turn_completed.source.kind, "backend");
    assert_eq!(turn_completed.source.name, "codex");
}

#[tokio::test]
async fn send_user_message_with_blocks_preserves_base64_image_for_backend_and_event_log() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(RecordingSendBackend::default());
    let runtime = Runtime::new(store.clone(), backend.clone());
    let session_id = SessionId::from("ses_runtime_image_blocks");
    runtime
        .create_session_with_agent_config(
            session_id.clone(),
            BackendKind::Acp,
            "/tmp/acp-workspace",
            None,
            AgentConfig::default(),
            None,
        )
        .await
        .expect("create session");
    let blocks = vec![
        UserMessageBlock::Text {
            text: "look at this".to_string(),
        },
        UserMessageBlock::Image {
            blob: BlobRef::InlineBase64 {
                data: "aGVsbG8=".to_string(),
                mime_type: "image/png".to_string(),
                sha256: Some("2cf24dba5fb0a030e8".to_string()),
                size_bytes: Some(5),
            },
        },
    ];

    runtime
        .send_user_message_with_blocks(
            SendUserMessage {
                session_id: session_id.clone(),
                idempotency_key: "idem-image-blocks".to_string(),
                content: "look at this".to_string(),
                command_id: None,
            },
            blocks.clone(),
        )
        .await
        .expect("send");

    let events = eventually_contains_event(&store, &session_id, EventType::TURN_COMPLETED).await;
    let sends = backend.recorded_inputs().await;
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].blocks, blocks);
    let accepted = events
        .iter()
        .find(|event| event.event_type == EventType::USER_MESSAGE_ACCEPTED)
        .expect("user.message.accepted");
    assert_eq!(
        accepted.payload["blocks"],
        json!([
            { "type": "text", "text": "look at this" },
            {
                "type": "image",
                "blob": {
                    "kind": "inline_base64",
                    "data": "aGVsbG8=",
                    "mime_type": "image/png",
                    "sha256": "2cf24dba5fb0a030e8",
                    "size_bytes": 5
                }
            }
        ])
    );
}

#[tokio::test]
async fn send_user_message_rejects_unknown_session() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(vec![]));
    let runtime = Runtime::new(store, backend);

    let ack = runtime
        .send_user_message(SendUserMessage {
            session_id: SessionId::from("missing"),
            idempotency_key: "idem-1".to_string(),
            content: "hello".to_string(),
            command_id: None,
        })
        .await
        .expect("send");

    match ack {
        CommandAck::Rejected(rejected) => assert_eq!(rejected.code, "session_not_found"),
        other => panic!("expected rejected ack, got {other:?}"),
    }
}

#[tokio::test]
async fn send_user_message_preserves_client_command_id_in_accepted_ack() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(vec![
        vela_backends::BackendOutput::event(EventType::TURN_COMPLETED, json!({})),
    ]));
    let runtime = Runtime::new(store, backend);
    let session_id = SessionId::from("ses_runtime_command_id");
    let command_id = CommandId::from("cmd_client_1");
    runtime
        .create_session(session_id.clone(), BackendKind::Pi, "/tmp/vela")
        .await
        .expect("create session");

    let ack = runtime
        .send_user_message(SendUserMessage {
            session_id,
            idempotency_key: "idem-command-id".to_string(),
            content: "hello".to_string(),
            command_id: Some(command_id.clone()),
        })
        .await
        .expect("send");

    match ack {
        CommandAck::Accepted(accepted) => assert_eq!(accepted.command_id, command_id),
        other => panic!("expected accepted ack, got {other:?}"),
    }
}

#[tokio::test]
async fn send_user_message_rejects_idempotency_key_reuse_with_different_content() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(vec![
        vela_backends::BackendOutput::event(EventType::TURN_COMPLETED, json!({})),
    ]));
    let runtime = Runtime::new(store.clone(), backend.clone());
    let session_id = SessionId::from("ses_runtime_mismatch");
    runtime
        .create_session(session_id.clone(), BackendKind::Pi, "/tmp/vela")
        .await
        .expect("create session");

    runtime
        .send_user_message(SendUserMessage {
            session_id: session_id.clone(),
            idempotency_key: "idem-1".to_string(),
            content: "first".to_string(),
            command_id: None,
        })
        .await
        .expect("first send");
    let rejected = runtime
        .send_user_message(SendUserMessage {
            session_id: session_id.clone(),
            idempotency_key: "idem-1".to_string(),
            content: "different".to_string(),
            command_id: None,
        })
        .await
        .expect("second send");

    match rejected {
        CommandAck::Rejected(rejected) => assert_eq!(rejected.code, "duplicate_command"),
        other => panic!("expected duplicate rejection, got {other:?}"),
    }
    assert_eq!(backend.prompt_count().await, 1);
    assert_eq!(
        store
            .list_events(&session_id)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.event_type == EventType::USER_MESSAGE_ACCEPTED)
            .count(),
        1
    );
}

#[tokio::test]
async fn send_user_message_appends_turn_failed_and_allows_next_turn_after_backend_error() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(FailingOnceBackend::default());
    let runtime = Runtime::new(store.clone(), backend);
    let session_id = SessionId::from("ses_runtime_backend_failure");
    runtime
        .create_session(session_id.clone(), BackendKind::Pi, "/tmp/vela")
        .await
        .expect("create session");

    let first = runtime
        .send_user_message(SendUserMessage {
            session_id: session_id.clone(),
            idempotency_key: "idem-1".to_string(),
            content: "fail once".to_string(),
            command_id: None,
        })
        .await
        .expect("first send");
    eventually_contains_event(&store, &session_id, EventType::TURN_FAILED).await;
    let second = runtime
        .send_user_message(SendUserMessage {
            session_id: session_id.clone(),
            idempotency_key: "idem-2".to_string(),
            content: "recover".to_string(),
            command_id: None,
        })
        .await
        .expect("second send");
    eventually_contains_event(&store, &session_id, EventType::TURN_COMPLETED).await;
    let events = store.list_events(&session_id).await.expect("events");

    assert!(matches!(first, CommandAck::Accepted(_)));
    assert!(matches!(second, CommandAck::Accepted(_)));
    assert!(
        events
            .iter()
            .any(|event| event.event_type == EventType::TURN_FAILED)
    );
    assert!(
        events
            .iter()
            .any(|event| event.event_type == EventType::TURN_COMPLETED)
    );
}

#[tokio::test]
async fn send_user_message_does_not_duplicate_backend_emitted_turn_failed() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(FailingAfterTurnFailedBackend);
    let runtime = Runtime::new(store.clone(), backend);
    let session_id = SessionId::from("ses_runtime_backend_emitted_failure");
    runtime
        .create_session(session_id.clone(), BackendKind::Pi, "/tmp/vela")
        .await
        .expect("create session");

    runtime
        .send_user_message(SendUserMessage {
            session_id: session_id.clone(),
            idempotency_key: "idem-backend-emitted-failure".to_string(),
            content: "fail once".to_string(),
            command_id: None,
        })
        .await
        .expect("send");
    eventually_contains_event(&store, &session_id, EventType::TURN_FAILED).await;
    let events = store.list_events(&session_id).await.expect("events");
    let turn_failed_events = events
        .iter()
        .filter(|event| event.event_type == EventType::TURN_FAILED)
        .collect::<Vec<_>>();

    assert_eq!(turn_failed_events.len(), 1);
    assert_eq!(
        turn_failed_events[0].payload["error"].as_str(),
        Some("provider stream disconnected")
    );
}

#[tokio::test]
async fn send_user_message_queues_distinct_command_while_turn_is_running() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(BlockingBackend::default());
    let runtime = Arc::new(Runtime::new(store.clone(), backend.clone()));
    let session_id = SessionId::from("ses_runtime_2");
    runtime
        .create_session(session_id.clone(), BackendKind::Pi, "/tmp/vela")
        .await
        .expect("create session");
    let called = backend.arm().await;

    let first_runtime = runtime.clone();
    let first_session = session_id.clone();
    let first = tokio::spawn(async move {
        first_runtime
            .send_user_message(SendUserMessage {
                session_id: first_session,
                idempotency_key: "idem-1".to_string(),
                content: "hold".to_string(),
                command_id: None,
            })
            .await
    });
    called.await.expect("backend called");

    let second = runtime
        .send_user_message(SendUserMessage {
            session_id: session_id.clone(),
            idempotency_key: "idem-2".to_string(),
            content: "second".to_string(),
            command_id: None,
        })
        .await
        .expect("second send");

    let queued = match second {
        CommandAck::Queued(queued) => queued,
        other => panic!("expected queued ack, got {other:?}"),
    };
    assert_eq!(queued.session_id, session_id);
    assert_eq!(queued.command_id, CommandId::from("idem-2"));
    assert!(!queued.queued_message_id.is_empty());
    let events = eventually_contains_event(&store, &session_id, EventType::INPUT_QUEUED).await;
    let queued_event = events
        .iter()
        .find(|event| event.event_type == EventType::INPUT_QUEUED)
        .expect("input.queued");
    assert_eq!(queued_event.payload["content"], "second");
    assert_eq!(
        queued_event.payload["queued_message_id"],
        queued.queued_message_id
    );

    backend.release().await;
    first.await.expect("join").expect("first send");
}

#[tokio::test]
async fn send_user_message_returns_ack_before_backend_turn_finishes() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(BlockingBackend::default());
    let runtime = Arc::new(Runtime::new(store, backend.clone()));
    let session_id = SessionId::from("ses_runtime_immediate_ack");
    runtime
        .create_session(session_id.clone(), BackendKind::Pi, "/tmp/vela")
        .await
        .expect("create session");
    let called = backend.arm().await;

    let ack = timeout(
        Duration::from_millis(200),
        runtime.send_user_message(SendUserMessage {
            session_id,
            idempotency_key: "idem-immediate".to_string(),
            content: "stream please".to_string(),
            command_id: None,
        }),
    )
    .await
    .expect("command ack should not wait for backend turn to finish")
    .expect("send");

    assert!(matches!(ack, CommandAck::Accepted(_)));
    called.await.expect("backend should still be running");
    backend.release().await;
}

#[tokio::test]
async fn backend_outputs_are_persisted_before_backend_stream_finishes() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(StreamingBlockingBackend::default());
    let runtime = Arc::new(Runtime::new(store.clone(), backend.clone()));
    let session_id = SessionId::from("ses_runtime_streaming_outputs");
    runtime
        .create_session(session_id.clone(), BackendKind::Pi, "/tmp/vela")
        .await
        .expect("create session");
    let first_output_sent = backend.arm().await;

    let send_runtime = runtime.clone();
    let send_session_id = session_id.clone();
    let send = tokio::spawn(async move {
        send_runtime
            .send_user_message(SendUserMessage {
                session_id: send_session_id,
                idempotency_key: "idem-streaming".to_string(),
                content: "stream please".to_string(),
                command_id: None,
            })
            .await
    });

    first_output_sent
        .await
        .expect("backend should emit a first output before release");
    eventually_contains_event(&store, &session_id, EventType::ASSISTANT_MESSAGE_DELTA).await;
    backend.release().await;
    let ack = send.await.expect("join").expect("send");

    assert!(matches!(ack, CommandAck::Accepted(_)));
    eventually_contains_event(&store, &session_id, EventType::TURN_COMPLETED).await;
}

#[tokio::test]
async fn runtime_ignores_backend_turn_started_lifecycle_output() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(vec![
        BackendOutput::event(EventType::TURN_STARTED, json!({ "provider": "turn_start" })),
        BackendOutput::event(
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "delta": "hello" }),
        ),
        BackendOutput::event(EventType::TURN_COMPLETED, json!({})),
    ]));
    let runtime = Runtime::new(store.clone(), backend);
    let session_id = SessionId::from("ses_runtime_absorb_backend_lifecycle");
    runtime
        .create_session(session_id.clone(), BackendKind::Pi, "/tmp/vela")
        .await
        .expect("create session");

    let ack = runtime
        .send_user_message(SendUserMessage {
            session_id: session_id.clone(),
            idempotency_key: "idem-absorb-turn-started".to_string(),
            content: "hello".to_string(),
            command_id: None,
        })
        .await
        .expect("send");
    eventually_contains_event(&store, &session_id, EventType::TURN_COMPLETED).await;
    let events = store.list_events(&session_id).await.expect("events");

    assert!(matches!(ack, CommandAck::Accepted(_)));
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == EventType::TURN_STARTED)
            .count(),
        1,
        "runtime-owned turn.started must not be duplicated by backend lifecycle output"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == EventType::ASSISTANT_MESSAGE_DELTA)
            .count(),
        1,
        "normal backend content output should still be persisted"
    );
}

#[tokio::test]
async fn runtime_rejects_backend_owned_event_families_from_backend_output() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(vec![
        BackendOutput::event(
            EventType::SESSION_UPDATED,
            json!({ "title": "owned by runtime" }),
        ),
        BackendOutput::event(
            EventType::USER_MESSAGE_ACCEPTED,
            json!({ "content": "backend must not echo user facts" }),
        ),
        BackendOutput::event(
            EventType::INPUT_REJECTED,
            json!({ "code": "backend_must_not_reject_commands" }),
        ),
        BackendOutput::event(
            EventType::PROJECTION_INVALIDATED,
            json!({ "views": ["transcript"] }),
        ),
        BackendOutput::event(
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "delta": "allowed" }),
        ),
        BackendOutput::event(EventType::TURN_COMPLETED, json!({})),
    ]));
    let runtime = Runtime::new(store.clone(), backend);
    let session_id = SessionId::from("ses_runtime_backend_ownership_gate");
    runtime
        .create_session(session_id.clone(), BackendKind::Pi, "/tmp/vela")
        .await
        .expect("create session");

    runtime
        .send_user_message(SendUserMessage {
            session_id: session_id.clone(),
            idempotency_key: "idem-backend-ownership-gate".to_string(),
            content: "hello".to_string(),
            command_id: None,
        })
        .await
        .expect("send");
    eventually_contains_event(&store, &session_id, EventType::TURN_COMPLETED).await;
    let events = store.list_events(&session_id).await.expect("events");

    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == EventType::SESSION_UPDATED)
            .count(),
        0,
        "backend must not write session-owned facts"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == EventType::USER_MESSAGE_ACCEPTED)
            .count(),
        1,
        "only runtime command acceptance should create user.message.accepted"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == EventType::INPUT_REJECTED)
            .count(),
        0,
        "backend must not write command rejection facts"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == EventType::PROJECTION_INVALIDATED)
            .count(),
        0,
        "backend must not write projection control facts"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event.event_type == EventType::WARNING_RAISED
                    && event.payload["code"] == "backend_event_not_allowed"
            })
            .count(),
        4,
        "forbidden backend output should leave diagnostics instead of silently disappearing"
    );
    assert!(
        events
            .iter()
            .any(|event| event.event_type == EventType::ASSISTANT_MESSAGE_DELTA),
        "allowed backend output should still be persisted"
    );
}

#[tokio::test]
async fn backend_output_append_failure_marks_turn_failed() {
    let dir = tempfile::tempdir().expect("temp dir");
    let database_path = dir.path().join("runtime-append-failure.sqlite");
    let database_url = format!("sqlite://{}?mode=rwc", database_path.display());
    let store = Arc::new(
        SqliteEventStore::connect(&database_url)
            .await
            .expect("store"),
    );
    let trigger_pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("trigger pool");
    sqlx::query(
        r#"
        CREATE TRIGGER fail_backend_delta_insert
        BEFORE INSERT ON events
        WHEN NEW.event_type = 'assistant.message.delta'
        BEGIN
            SELECT RAISE(FAIL, 'forced backend append failure');
        END;
        "#,
    )
    .execute(&trigger_pool)
    .await
    .expect("create trigger");

    let backend = Arc::new(MockBackendAdapter::new(vec![
        BackendOutput::event(
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "delta": "this append will fail" }),
        ),
        BackendOutput::event(EventType::TURN_COMPLETED, json!({})),
    ]));
    let runtime = Runtime::new(store.clone(), backend);
    let session_id = SessionId::from("ses_runtime_backend_append_failure");
    runtime
        .create_session(session_id.clone(), BackendKind::Pi, "/tmp/vela")
        .await
        .expect("create session");

    let ack = runtime
        .send_user_message(SendUserMessage {
            session_id: session_id.clone(),
            idempotency_key: "idem-append-failure".to_string(),
            content: "hello".to_string(),
            command_id: None,
        })
        .await
        .expect("send");
    eventually_contains_event(&store, &session_id, EventType::TURN_FAILED).await;
    let events = store.list_events(&session_id).await.expect("events");

    assert!(matches!(ack, CommandAck::Accepted(_)));
    assert!(
        events
            .iter()
            .any(|event| event.event_type == EventType::TURN_FAILED),
        "backend output append failure should be visible as a turn failure"
    );
    assert!(
        events
            .iter()
            .all(|event| event.event_type != EventType::TURN_COMPLETED),
        "failed append should stop the turn before a later completed output wins"
    );
}

#[tokio::test]
async fn user_sequence_fixture_replays_duplicate_and_rejects_mismatch() {
    let steps = support::read_user_sequence_fixture("duplicate_replay_and_mismatch.jsonl");
    let harness = support::RuntimeHarness::new().await;
    let mut previous_ack: Option<CommandAck> = None;

    for step in &steps {
        let prompts_before = harness.backend.prompt_count().await;
        let ack = harness.send(step).await;
        match step.expect_status.as_str() {
            "accepted" => {
                assert!(
                    matches!(ack, CommandAck::Accepted(_)),
                    "expected accepted ack for fixture step {step:?}, got {ack:?}"
                );
                if step.expect_replay {
                    assert_eq!(
                        Some(&ack),
                        previous_ack.as_ref(),
                        "replay step should return the original ack"
                    );
                    assert_eq!(
                        harness.backend.prompt_count().await,
                        prompts_before,
                        "replay step must not call backend again"
                    );
                }
                previous_ack = Some(ack);
            }
            "rejected" => match ack {
                CommandAck::Rejected(rejected) => {
                    assert_eq!(Some(rejected.code.as_str()), step.expect_code.as_deref());
                    assert_eq!(
                        harness.backend.prompt_count().await,
                        prompts_before,
                        "rejected fixture step must not call backend"
                    );
                }
                other => panic!("expected rejected ack for fixture step {step:?}, got {other:?}"),
            },
            other => panic!("unknown fixture expectation: {other}"),
        }
    }

    let events = harness
        .store
        .list_events(&harness.session_id)
        .await
        .expect("events");
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == EventType::USER_MESSAGE_ACCEPTED)
            .count(),
        1,
        "duplicate replay and mismatch should append only one accepted user message"
    );
}

#[tokio::test]
async fn workbuddy_user_behavior_fixture_runs_multi_turn_sequence_in_order() {
    let steps = support::read_user_sequence_fixture("workbuddy_guardiola_multi_turn.jsonl");
    let harness = support::RuntimeHarness::new().await;

    for step in &steps {
        let ack = harness.send(step).await;
        assert!(
            matches!(ack, CommandAck::Accepted(_)),
            "expected accepted ack for WorkBuddy-adapted step {step:?}, got {ack:?}"
        );
    }

    assert_eq!(
        harness.backend.recorded_prompts().await,
        steps
            .iter()
            .map(|step| step.content.clone())
            .collect::<Vec<_>>(),
        "runtime should preserve adapted user behavior order"
    );
    let events = harness
        .store
        .list_events(&harness.session_id)
        .await
        .expect("events");
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == EventType::USER_MESSAGE_ACCEPTED)
            .count(),
        steps.len(),
        "each WorkBuddy user behavior step should append one accepted user message"
    );
}

#[tokio::test]
async fn synara_user_behavior_fixture_runs_edit_resend_sequence_in_order() {
    let steps = support::read_user_sequence_fixture("synara_edit_resend_sequence.jsonl");
    let harness = support::RuntimeHarness::new().await;

    for step in &steps {
        let ack = harness.send(step).await;
        assert!(
            matches!(ack, CommandAck::Accepted(_)),
            "expected accepted ack for Synara-adapted step {step:?}, got {ack:?}"
        );
    }

    assert_eq!(
        harness.backend.recorded_prompts().await,
        vec!["old prompt", "edited prompt", "edited queued prompt"],
        "runtime should preserve Synara edit/resend prompt order"
    );
}

#[tokio::test]
async fn omx_turns_fixture_runs_sanitized_cli_turn_sequence_in_order() {
    let steps = support::read_user_sequence_fixture("omx_turns_sanitized_sequence.jsonl");
    let harness = support::RuntimeHarness::new().await;

    for step in &steps {
        let ack = harness.send(step).await;
        assert!(
            matches!(ack, CommandAck::Accepted(_)),
            "expected accepted ack for OMX-adapted step {step:?}, got {ack:?}"
        );
    }

    assert_eq!(
        harness.backend.recorded_prompts().await,
        steps
            .iter()
            .map(|step| step.content.clone())
            .collect::<Vec<_>>(),
        "runtime should preserve sanitized CLI turn order"
    );
}

#[tokio::test]
async fn scenario_fixture_drives_scripted_agent_multi_turn_tool_flow() {
    let scenario = support::read_scenario_fixture("two_turn_tool_recovery.json");
    let harness = support::ScenarioHarness::from_fixture(&scenario).await;

    harness.run().await;

    assert_eq!(
        harness.backend.recorded_prompts().await,
        scenario.expect_prompts,
        "scenario agent should receive prompts in fixture order"
    );
    assert_eq!(
        harness.event_type_names().await,
        scenario.expect_event_types,
        "runtime event log should match the scenario golden sequence"
    );
    assert_eq!(
        strip_runtime_turn_ids(harness.persisted_backend_outputs().await),
        scenario.expected_backend_outputs(),
        "scripted backend outputs should be persisted without losing payload or raw fields"
    );
}

#[tokio::test]
async fn all_runtime_scenario_fixtures_assert_inputs_outputs_and_event_order() {
    for fixture_name in support::scenario_fixture_names() {
        let scenario = support::read_scenario_fixture(fixture_name);
        let harness = support::ScenarioHarness::from_fixture(&scenario).await;

        harness.run().await;

        assert_eq!(
            harness.backend.recorded_prompts().await,
            scenario.expect_prompts,
            "scenario {fixture_name} should preserve prompt order exactly"
        );
        assert_eq!(
            harness.event_type_names().await,
            scenario.expect_event_types,
            "scenario {fixture_name} should persist the expected canonical event order"
        );
        assert_eq!(
            strip_runtime_turn_ids(harness.persisted_backend_outputs().await),
            scenario.expected_backend_outputs(),
            "scenario {fixture_name} should persist every scripted output payload/raw losslessly"
        );
    }
}

#[derive(Default)]
struct BlockingBackend {
    state: Mutex<BlockingState>,
}

#[derive(Default)]
struct StreamingBlockingBackend {
    state: Mutex<StreamingBlockingState>,
}

#[derive(Default)]
struct FailingOnceBackend {
    calls: Mutex<usize>,
}

struct FailingAfterTurnFailedBackend;

#[derive(Default)]
struct RecordingSendBackend {
    inputs: Mutex<Vec<BackendSend>>,
}

impl RecordingSendBackend {
    async fn recorded_inputs(&self) -> Vec<BackendSend> {
        self.inputs.lock().await.clone()
    }
}

#[async_trait]
impl BackendAdapter for RecordingSendBackend {
    async fn stream_user_message(
        &self,
        input: BackendSend,
        sink: BackendOutputSink,
    ) -> anyhow::Result<()> {
        self.inputs.lock().await.push(input);
        sink.send(BackendOutput::event(EventType::TURN_COMPLETED, json!({})))
            .await?;
        Ok(())
    }
}

#[async_trait]
impl BackendAdapter for FailingOnceBackend {
    async fn stream_user_message(
        &self,
        _input: BackendSend,
        sink: BackendOutputSink,
    ) -> anyhow::Result<()> {
        let mut calls = self.calls.lock().await;
        *calls += 1;
        if *calls == 1 {
            anyhow::bail!("backend crashed");
        }
        drop(calls);
        emit_backend_outputs(
            sink,
            vec![BackendOutput::event(EventType::TURN_COMPLETED, json!({}))],
        )
        .await
    }
}

#[async_trait]
impl BackendAdapter for FailingAfterTurnFailedBackend {
    async fn stream_user_message(
        &self,
        _input: BackendSend,
        sink: BackendOutputSink,
    ) -> anyhow::Result<()> {
        sink.send(BackendOutput::event(
            EventType::TURN_FAILED,
            json!({ "error": "provider stream disconnected" }),
        ))
        .await?;
        anyhow::bail!("provider stream disconnected")
    }
}

#[derive(Default)]
struct BlockingState {
    called: Option<oneshot::Sender<()>>,
    release_rx: Option<oneshot::Receiver<()>>,
    release_tx: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct StreamingBlockingState {
    first_output_tx: Option<oneshot::Sender<()>>,
    release_rx: Option<oneshot::Receiver<()>>,
    release_tx: Option<oneshot::Sender<()>>,
}

#[async_trait]
impl BackendAdapter for BlockingBackend {
    async fn stream_user_message(
        &self,
        _input: BackendSend,
        sink: BackendOutputSink,
    ) -> anyhow::Result<()> {
        let release = {
            let mut state = self.state.lock().await;
            if let Some(called) = state.called.take() {
                let _ = called.send(());
            }
            state.release_rx.take()
        };
        if let Some(release) = release {
            let _ = release.await;
        }
        emit_backend_outputs(
            sink,
            vec![BackendOutput::event(EventType::TURN_COMPLETED, json!({}))],
        )
        .await
    }
}

impl BlockingBackend {
    async fn arm(&self) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        {
            let mut state = self.state.lock().await;
            state.called = Some(tx);
            state.release_tx = Some(release_tx);
            state.release_rx = Some(release_rx);
        }
        rx
    }

    async fn release(&self) {
        if let Some(tx) = self.state.lock().await.release_tx.take() {
            let _ = tx.send(());
        }
    }
}

#[async_trait]
impl BackendAdapter for StreamingBlockingBackend {
    async fn stream_user_message(
        &self,
        _input: BackendSend,
        sink: BackendOutputSink,
    ) -> anyhow::Result<()> {
        let release = {
            let mut state = self.state.lock().await;
            if let Some(first_output) = state.first_output_tx.take() {
                sink.send(BackendOutput::event(
                    EventType::ASSISTANT_MESSAGE_DELTA,
                    json!({ "delta": "hello" }),
                ))
                .await?;
                let _ = first_output.send(());
            }
            state.release_rx.take()
        };
        if let Some(release) = release {
            let _ = release.await;
        }
        sink.send(BackendOutput::event(EventType::TURN_COMPLETED, json!({})))
            .await?;
        Ok(())
    }
}

impl StreamingBlockingBackend {
    async fn arm(&self) -> oneshot::Receiver<()> {
        let (first_output_tx, first_output_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        {
            let mut state = self.state.lock().await;
            state.first_output_tx = Some(first_output_tx);
            state.release_tx = Some(release_tx);
            state.release_rx = Some(release_rx);
        }
        first_output_rx
    }

    async fn release(&self) {
        if let Some(tx) = self.state.lock().await.release_tx.take() {
            let _ = tx.send(());
        }
    }
}

fn strip_runtime_turn_ids(outputs: Vec<BackendOutput>) -> Vec<BackendOutput> {
    outputs
        .into_iter()
        .map(|mut output| {
            if let Value::Object(payload) = &mut output.payload {
                payload.remove("turn_id");
            }
            output
        })
        .collect()
}

async fn eventually_contains_event(
    store: &SqliteEventStore,
    session_id: &SessionId,
    event_type: EventType,
) -> Vec<CanonicalEvent> {
    timeout(Duration::from_millis(500), async {
        loop {
            let events = store.list_events(session_id).await.expect("events");
            if events.iter().any(|event| event.event_type == event_type) {
                return events;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("event {event_type:?} should be persisted"))
}
