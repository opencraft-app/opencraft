use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::time::{Duration, sleep, timeout};
use tower::ServiceExt;
use vela_backends::{
    AcpBackendAdapter, AcpStdioHost, BackendOutput, BackendRouter, MockBackendAdapter,
};
use vela_core::{BlobRef, EventType, UserMessageBlock};
use vela_runtime::Runtime;
use vela_store::SqliteEventStore;

mod support;

async fn test_app() -> axum::Router {
    test_app_with_backend().await.0
}

async fn test_app_with_backend() -> (axum::Router, Arc<MockBackendAdapter>) {
    test_app_with_backend_outputs(support::default_backend_outputs()).await
}

async fn test_app_with_backend_outputs(
    outputs: Vec<BackendOutput>,
) -> (axum::Router, Arc<MockBackendAdapter>) {
    test_app_with_backend_outputs_and_default_model(outputs, None).await
}

async fn test_app_with_backend_outputs_and_default_model(
    outputs: Vec<BackendOutput>,
    default_session_model: Option<String>,
) -> (axum::Router, Arc<MockBackendAdapter>) {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(outputs));
    let runtime = Runtime::new(store.clone(), backend.clone());
    (
        velad::build_app(
            velad::ApiState::new(store, runtime).with_default_session_model(default_session_model),
        ),
        backend,
    )
}

async fn json_request(
    app: axum::Router,
    method: Method,
    uri: &str,
    body: Value,
    idempotency_key: Option<&str>,
) -> (StatusCode, Value) {
    json_request_with_headers(app, method, uri, body, idempotency_key, &[]).await
}

async fn json_request_with_headers(
    app: axum::Router,
    method: Method,
    uri: &str,
    body: Value,
    idempotency_key: Option<&str>,
    headers: &[(&str, &str)],
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(key) = idempotency_key {
        builder = builder.header("Idempotency-Key", key);
    }
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let response = app
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .expect("response");
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(null));
    (status, value)
}

async fn get_json(app: axum::Router, uri: &str) -> (StatusCode, Value) {
    let response = app
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .expect("response");
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(null));
    (status, value)
}

async fn get_response(app: axum::Router, uri: &str) -> axum::response::Response {
    app.oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .expect("response")
}

async fn get_response_with_header(
    app: axum::Router,
    uri: &str,
    name: &str,
    value: &str,
) -> axum::response::Response {
    app.oneshot(
        Request::get(uri)
            .header(name, value)
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .expect("response")
}

async fn wait_for_session_event(app: axum::Router, session_id: &str, event_type: &str) -> Value {
    wait_for_session_event_count(app, session_id, event_type, 1).await
}

async fn wait_for_session_event_count(
    app: axum::Router,
    session_id: &str,
    event_type: &str,
    count: usize,
) -> Value {
    timeout(Duration::from_secs(2), async {
        loop {
            let (status, events) = get_json(
                app.clone(),
                &format!("/api/v1/sessions/{session_id}/events"),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            if events["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|event| event["type"] == event_type)
                .count()
                >= count
            {
                return events;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!("event {event_type} should be visible {count} times for session {session_id}")
    })
}

async fn eventually_backend_called(backend: &MockBackendAdapter) {
    timeout(Duration::from_secs(2), async {
        loop {
            if backend.prompt_count().await > 0 {
                return;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("backend call");
}

async fn wait_for_conversation_items(app: axum::Router, session_id: &str, items: usize) -> Value {
    timeout(Duration::from_secs(2), async {
        loop {
            let (status, conversation) = get_json(
                app.clone(),
                &format!("/api/v1/sessions/{session_id}/views/conversation"),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            if conversation["items"].as_array().unwrap().len() >= items {
                return conversation;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("conversation should reach at least {items} items"))
}

#[path = "http_contract/sessions.rs"]
mod sessions;

#[path = "http_contract/commands.rs"]
mod commands;

#[path = "http_contract/views.rs"]
mod views;

#[path = "http_contract/diagnostics.rs"]
mod diagnostics;

#[path = "http_contract/backends.rs"]
mod backends;

#[path = "http_contract/runtime.rs"]
mod runtime;
