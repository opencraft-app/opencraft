use serde::Deserialize;
use serde_json::Value;
use vela_core::{BackendKind, EventSource, EventType, SessionId};
use vela_store::SqliteEventStore;

#[derive(Deserialize)]
struct EventSeed {
    event_type: EventType,
    payload: Value,
}

pub fn event_seed_fixture(name: &str) -> Vec<(EventType, Value)> {
    let raw = match name {
        "basic_turn" => include_str!("../fixtures/events/basic_turn.jsonl"),
        other => panic!("unknown store event seed fixture: {other}"),
    };
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let seed: EventSeed = serde_json::from_str(line).expect("event seed fixture line");
            (seed.event_type, seed.payload)
        })
        .collect()
}

pub async fn store_with_seeded_events(fixture: &str, session_id: &SessionId) -> SqliteEventStore {
    let store = SqliteEventStore::in_memory().await.expect("store");
    store
        .create_session(session_id, BackendKind::Pi, "/tmp/vela")
        .await
        .expect("create session");
    for (event_type, payload) in event_seed_fixture(fixture) {
        store
            .append_event(
                session_id,
                event_type,
                EventSource::runtime("fixture"),
                payload,
                None,
            )
            .await
            .expect("append fixture event");
    }
    store
}
