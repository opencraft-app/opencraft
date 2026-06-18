use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;
use tokio::sync::{Mutex, oneshot};
use vela_backends::{BackendAdapter, BackendOutput, BackendSend, MockBackendAdapter};
use vela_core::{BackendKind, CommandAck, CommandId, EventType, SessionId};
use vela_runtime::{Runtime, SendUserMessage};
use vela_store::SqliteEventStore;

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
    let second = runtime
        .send_user_message(SendUserMessage {
            session_id: session_id.clone(),
            idempotency_key: "idem-2".to_string(),
            content: "recover".to_string(),
            command_id: None,
        })
        .await
        .expect("second send");
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
async fn send_user_message_rejects_distinct_command_while_turn_is_running() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(BlockingBackend::default());
    let runtime = Arc::new(Runtime::new(store, backend.clone()));
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
            session_id,
            idempotency_key: "idem-2".to_string(),
            content: "second".to_string(),
            command_id: None,
        })
        .await
        .expect("second send");

    match second {
        CommandAck::Rejected(rejected) => assert_eq!(rejected.code, "turn_running"),
        other => panic!("expected running rejection, got {other:?}"),
    }

    backend.release().await;
    first.await.expect("join").expect("first send");
}

#[derive(Default)]
struct BlockingBackend {
    state: Mutex<BlockingState>,
}

#[derive(Default)]
struct FailingOnceBackend {
    calls: Mutex<usize>,
}

#[async_trait]
impl BackendAdapter for FailingOnceBackend {
    async fn send_user_message(&self, _input: BackendSend) -> anyhow::Result<Vec<BackendOutput>> {
        let mut calls = self.calls.lock().await;
        *calls += 1;
        if *calls == 1 {
            anyhow::bail!("backend crashed");
        }
        Ok(vec![BackendOutput::event(
            EventType::TURN_COMPLETED,
            json!({}),
        )])
    }
}

#[derive(Default)]
struct BlockingState {
    called: Option<oneshot::Sender<()>>,
    release_rx: Option<oneshot::Receiver<()>>,
    release_tx: Option<oneshot::Sender<()>>,
}

#[async_trait]
impl BackendAdapter for BlockingBackend {
    async fn send_user_message(&self, _input: BackendSend) -> anyhow::Result<Vec<BackendOutput>> {
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
        Ok(vec![BackendOutput::event(
            EventType::TURN_COMPLETED,
            json!({}),
        )])
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
