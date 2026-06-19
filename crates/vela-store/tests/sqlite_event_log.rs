use serde_json::json;
use vela_core::{BackendKind, EventSource, EventType, SessionId};
use vela_store::{SqliteEventStore, StoreError};

mod support;

#[tokio::test]
async fn appends_events_with_monotonic_session_cursor() {
    let store = SqliteEventStore::in_memory().await.expect("store");
    let session_id = SessionId::from("ses_store_1");
    store
        .create_session(&session_id, BackendKind::Pi, "/tmp/vela")
        .await
        .expect("create session");

    let first = store
        .append_event(
            &session_id,
            EventType::SESSION_CREATED,
            EventSource::runtime("test"),
            json!({}),
            None,
        )
        .await
        .expect("first append");
    let second = store
        .append_event(
            &session_id,
            EventType::USER_MESSAGE_ACCEPTED,
            EventSource::runtime("test"),
            json!({ "content": "hello" }),
            None,
        )
        .await
        .expect("second append");

    assert_eq!(first.cursor.seq, 1);
    assert_eq!(second.cursor.seq, 2);
    assert_eq!(first.event.seq, 1);
    assert_eq!(second.event.seq, 2);
}

#[tokio::test]
async fn session_backend_kind_round_trips_acp() {
    let store = SqliteEventStore::in_memory().await.expect("store");
    let session_id = SessionId::from("ses_store_acp");
    store
        .create_session(&session_id, BackendKind::Acp, "/tmp/vela")
        .await
        .expect("create acp session");

    let session = store
        .get_session(&session_id)
        .await
        .expect("get session")
        .expect("session exists");

    assert_eq!(session.backend, BackendKind::Acp);
}

#[tokio::test]
async fn idempotency_replays_same_ack_and_rejects_hash_mismatch() {
    let store = SqliteEventStore::in_memory().await.expect("store");
    let session_id = SessionId::from("ses_store_2");
    store
        .create_session(&session_id, BackendKind::Pi, "/tmp/vela")
        .await
        .expect("create session");

    let accepted = store
        .record_idempotency_acceptance(
            &session_id,
            "idem-1",
            "hash-a",
            None,
            EventType::USER_MESSAGE_ACCEPTED,
            EventSource::runtime("test"),
            json!({ "content": "hello" }),
        )
        .await
        .expect("record acceptance");
    let replay = store
        .record_idempotency_acceptance(
            &session_id,
            "idem-1",
            "hash-a",
            None,
            EventType::USER_MESSAGE_ACCEPTED,
            EventSource::runtime("test"),
            json!({ "content": "hello again" }),
        )
        .await
        .expect("replay acceptance");
    let mismatch = store
        .record_idempotency_acceptance(
            &session_id,
            "idem-1",
            "hash-b",
            None,
            EventType::USER_MESSAGE_ACCEPTED,
            EventSource::runtime("test"),
            json!({ "content": "different" }),
        )
        .await
        .expect("mismatch rejection");

    assert!(accepted.is_fresh());
    assert!(replay.is_replay());
    assert_eq!(accepted.ack(), replay.ack());
    assert!(mismatch.is_hash_mismatch());
    assert_eq!(store.list_events(&session_id).await.unwrap().len(), 1);
}

#[tokio::test]
async fn append_event_preserves_raw_backend_payload() {
    let store = SqliteEventStore::in_memory().await.expect("store");
    let session_id = SessionId::from("ses_store_raw");
    store
        .create_session(&session_id, BackendKind::Pi, "/tmp/vela")
        .await
        .expect("create session");

    store
        .append_event(
            &session_id,
            EventType::WARNING_RAISED,
            EventSource::backend("test-backend"),
            json!({ "message": "unknown event" }),
            Some(json!({ "type": "weird_backend_event", "value": 42 })),
        )
        .await
        .expect("append raw event");

    let events = store.list_events(&session_id).await.expect("events");
    assert_eq!(
        events[0].raw,
        Some(json!({ "type": "weird_backend_event", "value": 42 }))
    );
}

#[tokio::test]
async fn append_event_rejects_missing_session() {
    let store = SqliteEventStore::in_memory().await.expect("store");
    let error = store
        .append_event(
            &SessionId::from("missing"),
            EventType::WARNING_RAISED,
            EventSource::runtime("test"),
            json!({}),
            None,
        )
        .await
        .expect_err("missing session should fail");

    assert!(matches!(error, StoreError::SessionNotFound(_)));
}

#[tokio::test]
async fn fixture_seeded_event_log_preserves_order_and_cursor_sequence() {
    let session_id = SessionId::from("ses_store_fixture");
    let store = support::store_with_seeded_events("basic_turn", &session_id).await;

    let events = store.list_events(&session_id).await.expect("events");

    assert_eq!(events.len(), 5);
    assert_eq!(events[0].event_type, EventType::SESSION_CREATED);
    assert_eq!(events[4].event_type, EventType::TURN_COMPLETED);
    assert_eq!(
        events.iter().map(|event| event.seq).collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5]
    );
}
