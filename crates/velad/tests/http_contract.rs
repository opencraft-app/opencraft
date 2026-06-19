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
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(key) = idempotency_key {
        builder = builder.header("Idempotency-Key", key);
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

async fn wait_for_transcript_rows(app: axum::Router, session_id: &str, rows: usize) -> Value {
    timeout(Duration::from_secs(2), async {
        loop {
            let (status, transcript) = get_json(
                app.clone(),
                &format!("/api/v1/sessions/{session_id}/views/transcript"),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            if transcript["rows"].as_array().unwrap().len() >= rows {
                return transcript;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("transcript should reach at least {rows} rows"))
}

#[tokio::test]
async fn creates_session_and_exposes_session_view() {
    let app = test_app().await;

    let (status, body) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({
            "backend": "pi",
            "working_directory": "/tmp/project",
            "title": "Demo"
        }),
        Some("create-1"),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["session"]["id"], "create-1");
    assert_eq!(body["session"]["working_directory"], "/tmp/project");
    assert_eq!(body["cursor"]["event_id"], body["session"]["last_event_id"]);

    let session_id = body["session"]["id"].as_str().unwrap();
    let (status, view) = get_json(app, &format!("/api/v1/sessions/{session_id}")).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["session"]["id"], session_id);
}

#[tokio::test]
async fn session_view_exposes_generic_capability_surface_without_provider_methods() {
    let app = test_app().await;

    let (status, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({
            "backend": "pi",
            "working_directory": "/tmp/project",
            "agent_config": {
                "model": "minimax-m2.7",
                "reasoning_effort": "high",
                "permission_mode": "auto",
                "feature_values": { "fast_mode": true }
            }
        }),
        Some("session-capabilities"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, view) =
        get_json(app, &format!("/api/v1/sessions/{session_id}/views/session")).await;
    assert_eq!(status, StatusCode::OK);
    let session = &view["session"];

    assert_eq!(session["runtime_info"]["provider"], "pi");
    assert_eq!(session["runtime_info"]["model"], "minimax-m2.7");
    assert_eq!(session["runtime_info"]["reasoning_effort"], "high");
    assert_eq!(session["runtime_info"]["permission_mode"], "auto");
    assert_eq!(session["operations"]["send_message"]["available"], true);
    assert_eq!(session["operations"]["cancel"]["available"], false);
    assert_eq!(
        session["operations"]["update_agent_config"]["effective_after"],
        "next_turn"
    );
    assert_eq!(
        session["operations"]["respond_to_request"]["available"],
        true
    );

    let session_text = session.to_string();
    assert!(!session_text.contains("setMode"));
    assert!(!session_text.contains("respondToPermission"));
    assert!(!session_text.contains("getPendingPermissions"));
    assert!(!session_text.contains("turn/interrupt"));
}

#[tokio::test]
async fn create_session_uses_configured_default_model_when_request_omits_model() {
    let (app, _) = test_app_with_backend_outputs_and_default_model(
        support::default_backend_outputs(),
        Some("minimax-m2.7".to_string()),
    )
    .await;

    let (status, body) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({
            "backend": "pi",
            "working_directory": "/tmp/project",
            "title": "Demo"
        }),
        Some("create-default-model"),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["session"]["model"], "minimax-m2.7");

    let (status, view) = get_json(app, "/api/v1/sessions/create-default-model").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["session"]["model"], "minimax-m2.7");
}

#[tokio::test]
async fn backend_catalog_exposes_generic_reasoning_effort_options_for_model_picker() {
    let (app, _) = test_app_with_backend_outputs_and_default_model(
        support::default_backend_outputs(),
        Some("minimax-m2.7".to_string()),
    )
    .await;

    let (status, body) = get_json(app, "/api/v1/backends").await;

    assert_eq!(status, StatusCode::OK);
    let pi = body["backends"]
        .as_array()
        .unwrap()
        .iter()
        .find(|backend| backend["kind"] == "pi")
        .expect("pi backend");
    assert_eq!(pi["models"][0]["id"], "minimax-m2.7");
    assert_eq!(pi["models"][0]["reasoning_efforts"][0]["id"], "off");
    assert_eq!(pi["models"][0]["reasoning_efforts"][4]["id"], "high");
}

#[tokio::test]
async fn create_session_accepts_agent_config_as_session_default() {
    let app = test_app().await;

    let (status, body) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({
            "backend": "pi",
            "working_directory": "/tmp/project",
            "agent_config": {
                "model": "minimax-m2.7",
                "reasoning_effort": "high",
                "permission_mode": "full_access",
                "feature_values": {
                    "fast_mode": true
                }
            }
        }),
        Some("create-agent-config"),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["session"]["agent_config"]["model"], "minimax-m2.7");
    assert_eq!(body["session"]["agent_config"]["reasoning_effort"], "high");
    assert_eq!(
        body["session"]["agent_config"]["permission_mode"],
        "full_access"
    );
    assert_eq!(
        body["session"]["agent_config"]["feature_values"]["fast_mode"],
        true
    );
    assert_eq!(body["session"]["model"], "minimax-m2.7");

    let (status, view) = get_json(app, "/api/v1/sessions/create-agent-config/views/session").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        view["session"]["agent_config"],
        body["session"]["agent_config"]
    );
}

#[tokio::test]
async fn update_agent_config_changes_session_default_and_emits_config_event() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({
            "backend": "pi",
            "working_directory": "/tmp/project",
            "agent_config": {
                "model": "minimax-m2.7",
                "reasoning_effort": "medium",
                "permission_mode": "auto"
            }
        }),
        Some("patch-agent-config"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, body) = json_request(
        app.clone(),
        Method::PATCH,
        &format!("/api/v1/sessions/{session_id}/agent-config"),
        json!({
            "reasoning_effort": "high",
            "feature_values": {
                "plan_mode": true
            }
        }),
        Some("patch-agent-config-key"),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["effective_after"], "current_session");
    assert_eq!(body["session"]["agent_config"]["model"], "minimax-m2.7");
    assert_eq!(body["session"]["agent_config"]["reasoning_effort"], "high");
    assert_eq!(body["session"]["agent_config"]["permission_mode"], "auto");
    assert_eq!(
        body["session"]["agent_config"]["feature_values"]["plan_mode"],
        true
    );

    let events = wait_for_session_event(app, session_id, "session.config.updated").await;
    assert!(events["events"].as_array().unwrap().iter().any(|event| {
        event["type"] == "session.config.updated"
            && event["payload"]["agent_config"]["reasoning_effort"] == "high"
    }));
}

#[tokio::test]
async fn sends_user_message_through_runtime_and_projects_transcript() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-msg"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, ack) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({
            "events": [{
                "type": "user.message",
                "content": [{ "type": "text", "text": "ping" }]
            }]
        }),
        Some("cmd-1"),
    )
    .await;

    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(ack["status"], "accepted");
    assert!(!ack["cursor"]["event_id"].as_str().unwrap().is_empty());
    assert_eq!(ack["cursor"]["seq"], 2);

    let (status, events) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/events"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(events["events"][0]["type"], "session.created");
    assert_eq!(events["events"][1]["type"], "user.message.accepted");

    let transcript = wait_for_transcript_rows(app, session_id, 2).await;
    assert_eq!(transcript["rows"][0]["kind"], "user_message");
    assert_eq!(transcript["rows"][0]["text"], "ping");
    assert_eq!(transcript["rows"][1]["kind"], "assistant_message");
    assert_eq!(transcript["rows"][1]["text"], "pong");
    assert_eq!(transcript["session_id"], session_id);
    assert_eq!(transcript["window"]["has_older"], false);
    assert_eq!(transcript["window"]["has_newer"], false);
    assert_eq!(
        transcript["window"]["first_row_id"],
        transcript["rows"][0]["id"]
    );
    assert_eq!(
        transcript["window"]["last_row_id"],
        transcript["rows"][1]["id"]
    );
    assert!(transcript["cursor"]["event_id"].as_str().unwrap().len() > 0);
    assert!(transcript["cursor"]["seq"].as_i64().unwrap() >= 4);
}

#[tokio::test]
async fn transcript_view_supports_row_window_paging() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-transcript-window"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    for index in 1..=3 {
        let (_, _) = json_request(
            app.clone(),
            Method::POST,
            &format!("/api/v1/sessions/{session_id}/events"),
            json!({ "events": [{ "type": "user.message", "content": [{ "type": "text", "text": format!("message-{index}") }] }] }),
            Some(&format!("cmd-transcript-window-{index}")),
        )
        .await;
        wait_for_session_event_count(app.clone(), session_id, "turn.completed", index).await;
    }

    let (status, tail) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/views/transcript?limit=2"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tail["rows"].as_array().unwrap().len(), 2);
    assert_eq!(tail["window"]["has_older"], true);
    assert_eq!(tail["window"]["has_newer"], false);

    let first_tail_row_id = tail["window"]["first_row_id"].as_str().unwrap();
    let (status, previous) = get_json(
        app,
        &format!("/api/v1/sessions/{session_id}/views/transcript?direction=before&anchor_row_id={first_tail_row_id}&limit=2"),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(previous["rows"].as_array().unwrap().len(), 2);
    assert_eq!(previous["window"]["has_older"], true);
    assert_eq!(previous["window"]["has_newer"], true);
    assert_ne!(
        previous["window"]["last_row_id"],
        tail["window"]["first_row_id"]
    );
}

#[tokio::test]
async fn transcript_view_supports_direction_anchor_paging() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-transcript-direction-window"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    for index in 1..=3 {
        let (_, _) = json_request(
            app.clone(),
            Method::POST,
            &format!("/api/v1/sessions/{session_id}/events"),
            json!({ "events": [{ "type": "user.message", "content": [{ "type": "text", "text": format!("message-{index}") }] }] }),
            Some(&format!("cmd-transcript-direction-window-{index}")),
        )
        .await;
        wait_for_session_event_count(app.clone(), session_id, "turn.completed", index).await;
    }

    let (status, tail) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/views/transcript?direction=tail&limit=2"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tail["rows"].as_array().unwrap().len(), 2);
    assert_eq!(tail["window"]["has_older"], true);

    let first_tail_row_id = tail["window"]["first_row_id"].as_str().unwrap();
    let (status, previous) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/views/transcript?direction=before&anchor_row_id={first_tail_row_id}&limit=2"),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(previous["rows"].as_array().unwrap().len(), 2);
    assert_eq!(previous["window"]["has_newer"], true);
    assert_ne!(
        previous["window"]["last_row_id"],
        tail["window"]["first_row_id"]
    );

    let (status, full_window) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/views/transcript?direction=tail&limit=6"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let full_rows = full_window["rows"].as_array().unwrap();
    assert_eq!(full_rows.len(), 6);

    let after_anchor = full_rows[1]["id"].as_str().unwrap();
    let (status, after) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/views/transcript?direction=after&anchor_row_id={after_anchor}&limit=2"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(after["rows"].as_array().unwrap().len(), 2);
    assert_eq!(after["rows"][0]["id"], full_rows[2]["id"]);
    assert_eq!(after["window"]["has_older"], true);
    assert_eq!(after["window"]["has_newer"], true);

    let around_anchor = full_rows[3]["id"].as_str().unwrap();
    let (status, around) = get_json(
        app,
        &format!("/api/v1/sessions/{session_id}/views/transcript?direction=around&anchor_row_id={around_anchor}&limit=3"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(around["rows"].as_array().unwrap().len(), 3);
    assert_eq!(around["window"]["anchor_row_id"], around_anchor);
    assert!(
        around["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == around_anchor)
    );
}

#[tokio::test]
async fn transcript_view_rejects_invalid_direction_anchor_combinations() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-transcript-direction-invalid"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    for uri in [
        format!("/api/v1/sessions/{session_id}/views/transcript?direction=before"),
        format!(
            "/api/v1/sessions/{session_id}/views/transcript?direction=tail&anchor_row_id=row_1"
        ),
        format!("/api/v1/sessions/{session_id}/views/transcript?before_row_id=row_1"),
        format!("/api/v1/sessions/{session_id}/views/transcript?after_row_id=row_1"),
        format!("/api/v1/sessions/{session_id}/views/transcript?around_row_id=row_1"),
    ] {
        let (status, body) = get_json(app.clone(), &uri).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "invalid_parameter");
    }
}

#[tokio::test]
async fn transcript_view_rejects_stale_row_cursor_with_sync_reset() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-transcript-stale-row"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, body) = get_json(
        app,
        &format!("/api/v1/sessions/{session_id}/views/transcript?direction=before&anchor_row_id=missing-row"),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["reason"], "stale_cursor");
    assert!(
        body["views"]
            .as_array()
            .unwrap()
            .contains(&json!("transcript"))
    );
}

#[tokio::test]
async fn activity_view_supports_direction_anchor_paging() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-activity-direction-window"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, _) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({
            "events": [{
                "type": "user.message",
                "content": [{ "type": "text", "text": "activity paging" }]
            }]
        }),
        Some("cmd-activity-direction-window"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    wait_for_session_event(app.clone(), session_id, "turn.completed").await;

    let (status, tail) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/views/activity?direction=tail&limit=2"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tail["items"].as_array().unwrap().len(), 2);
    assert_eq!(tail["window"]["has_older"], true);
    assert_eq!(tail["window"]["has_newer"], false);

    let first_tail_item_id = tail["window"]["first_item_id"].as_str().unwrap();
    let (status, previous) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/views/activity?direction=before&anchor_item_id={first_tail_item_id}&limit=2"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(previous["items"].as_array().unwrap().len(), 2);
    assert_eq!(previous["window"]["has_newer"], true);
    assert_ne!(
        previous["window"]["last_item_id"],
        tail["window"]["first_item_id"]
    );

    let (status, full_window) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/views/activity?direction=tail&limit=10"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let full_items = full_window["items"].as_array().unwrap();
    assert!(
        full_items.len() >= 4,
        "expected enough activity items for after/around checks: {full_items:?}"
    );

    let after_anchor = full_items[1]["id"].as_str().unwrap();
    let (status, after) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/views/activity?direction=after&anchor_item_id={after_anchor}&limit=2"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(after["items"].as_array().unwrap().len(), 2);
    assert_eq!(after["items"][0]["id"], full_items[2]["id"]);
    assert_eq!(after["window"]["has_older"], true);

    let around_anchor = full_items[2]["id"].as_str().unwrap();
    let (status, around) = get_json(
        app,
        &format!("/api/v1/sessions/{session_id}/views/activity?direction=around&anchor_item_id={around_anchor}&limit=3"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(around["items"].as_array().unwrap().len(), 3);
    assert_eq!(around["window"]["anchor_item_id"], around_anchor);
    assert!(
        around["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == around_anchor)
    );
}

#[tokio::test]
async fn activity_view_rejects_invalid_direction_anchor_combinations() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-activity-direction-invalid"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    for uri in [
        format!("/api/v1/sessions/{session_id}/views/activity?direction=before"),
        format!("/api/v1/sessions/{session_id}/views/activity?direction=tail&anchor_item_id=act_1"),
        format!("/api/v1/sessions/{session_id}/views/activity?anchor_item_id=act_1"),
        format!(
            "/api/v1/sessions/{session_id}/views/activity?direction=before&anchor_row_id=row_1"
        ),
        format!("/api/v1/sessions/{session_id}/views/activity?after_id=evt_1"),
    ] {
        let (status, body) = get_json(app.clone(), &uri).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "uri: {uri}");
        assert_eq!(body["error"]["code"], "invalid_parameter", "uri: {uri}");
    }
}

#[tokio::test]
async fn activity_view_rejects_stale_item_anchor_with_sync_reset() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-activity-stale-item"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, body) = get_json(
        app,
        &format!("/api/v1/sessions/{session_id}/views/activity?direction=before&anchor_item_id=missing-item"),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["reason"], "stale_cursor");
    assert!(
        body["views"]
            .as_array()
            .unwrap()
            .contains(&json!("activity"))
    );
}

#[tokio::test]
async fn activity_view_exposes_turn_failure_error_summary() {
    let (app, _) = test_app_with_backend_outputs(vec![BackendOutput::event(
        EventType::TURN_FAILED,
        json!({ "error": "No API key found for the selected model." }),
    )])
    .await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-activity-failed"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, _) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({
            "events": [{
                "type": "user.message",
                "content": [{ "type": "text", "text": "ping" }]
            }]
        }),
        Some("cmd-activity-failed"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let (status, activity) = get_json(
        app,
        &format!("/api/v1/sessions/{session_id}/views/activity"),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(activity["items"][0]["status"], "failed");
    assert_eq!(
        activity["items"][0]["summary"],
        "No API key found for the selected model."
    );
}

#[tokio::test]
async fn activity_view_exposes_tool_detail_without_trace_payloads() {
    let (app, _) = test_app_with_backend_outputs(vec![
        BackendOutput::event(
            EventType::TOOL_STARTED,
            json!({
                "tool_id": "tool_search",
                "name": "Tool",
                "status": "running",
                "detail": {
                    "type": "search",
                    "query": "import",
                    "mode": "code"
                }
            }),
        ),
        BackendOutput::event(
            EventType::TOOL_OUTPUT_DELTA,
            json!({
                "tool_id": "tool_search",
                "delta": "12 matches"
            }),
        ),
        BackendOutput::event(
            EventType::TOOL_COMPLETED,
            json!({
                "tool_id": "tool_search",
                "name": "Tool",
                "status": "completed",
                "detail": {
                    "type": "search",
                    "query": "import",
                    "mode": "code",
                    "num_matches": 12,
                    "duration_ms": 17
                }
            }),
        ),
        BackendOutput::event(
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "delta": "done" }),
        ),
        BackendOutput::event(EventType::TURN_COMPLETED, json!({})),
    ])
    .await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-activity-tool"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, _) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({
            "events": [{
                "type": "user.message",
                "content": [{ "type": "text", "text": "search" }]
            }]
        }),
        Some("cmd-activity-tool"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    wait_for_session_event(app.clone(), session_id, "tool.completed").await;

    let (status, activity) = get_json(
        app,
        &format!("/api/v1/sessions/{session_id}/views/activity"),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let tool = activity["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "tool_search")
        .expect("tool activity item");
    assert_eq!(tool["kind"], "tool");
    assert_eq!(tool["status"], "completed");
    assert_eq!(tool["title"], "Tool");
    assert_eq!(tool["detail"]["type"], "search");
    assert_eq!(tool["detail"]["query"], "import");
    assert_eq!(tool["detail"]["mode"], "code");
    assert_eq!(tool["detail"]["num_matches"], 12);
    assert_eq!(tool["detail"]["duration_ms"], 17);
    assert!(tool["created_at"].as_str().is_some());
    assert!(tool["updated_at"].as_str().is_some());
    assert!(tool["event_range"]["from_event_id"].as_str().is_some());
    assert!(tool["event_range"]["to_event_id"].as_str().is_some());
    assert!(tool.get("raw").is_none());
}

#[tokio::test]
async fn mutating_routes_require_idempotency_key() {
    let app = test_app().await;

    let (status, body) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "missing_idempotency_key");

    let (status, body) = json_request(
        app,
        Method::PATCH,
        "/api/v1/sessions/missing/agent-config",
        json!({ "reasoning_effort": "high" }),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "missing_idempotency_key");
}

#[tokio::test]
async fn lists_backends_without_calling_runtime_business_logic() {
    let app = test_app().await;

    let (status, body) = get_json(app.clone(), "/api/v1/backends").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["backends"].as_array().unwrap().iter().any(|backend| {
        backend["kind"] == "pi" && backend["capabilities"]["streaming"] == true
    }));

    let (status, body) = get_json(app, "/api/v1/backends/pi").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["backend"]["kind"], "pi");
}

#[tokio::test]
async fn backend_catalog_reports_capabilities_per_backend() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let pi = Arc::new(MockBackendAdapter::new(support::default_backend_outputs()));
    let acp = Arc::new(AcpBackendAdapter::hermes(
        "/tmp/project",
        AcpStdioHost::hermes("/tmp/project"),
    ));
    let router = Arc::new(
        BackendRouter::new()
            .with_backend(vela_core::BackendKind::Pi, pi)
            .with_backend(vela_core::BackendKind::Acp, acp),
    );
    let runtime = Runtime::new(store.clone(), router);
    let app = velad::build_app(
        velad::ApiState::new(store, runtime).with_acp_backend(Some("minimax-m2.7".to_string())),
    );

    let (status, body) = get_json(app, "/api/v1/backends").await;
    assert_eq!(status, StatusCode::OK);
    let backends = body["backends"].as_array().expect("backends");
    let pi = backends
        .iter()
        .find(|backend| backend["kind"] == "pi")
        .expect("pi backend");
    let acp = backends
        .iter()
        .find(|backend| backend["kind"] == "acp")
        .expect("acp backend");

    assert_eq!(pi["capabilities"]["cancel"], true);
    assert_eq!(acp["capabilities"]["cancel"], false);
    assert_eq!(acp["capabilities"]["permission_requests"], true);
}

#[tokio::test]
async fn backends_expose_configured_default_model() {
    let (app, _) = test_app_with_backend_outputs_and_default_model(
        support::default_backend_outputs(),
        Some("minimax-m2.7".to_string()),
    )
    .await;

    let (status, body) = get_json(app, "/api/v1/backends/pi").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["backend"]["models"][0]["id"], "minimax-m2.7");
    assert_eq!(body["backend"]["models"][0]["is_default"], true);
    assert_eq!(body["backend"]["permission_modes"][0]["id"], "auto");
    assert_eq!(body["backend"]["features"][0]["id"], "fast_mode");
}

#[tokio::test]
async fn codex_backend_can_be_configured_and_used_for_sessions() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(support::default_backend_outputs()));
    let runtime = Runtime::new(store.clone(), backend.clone());
    let app = velad::build_app(
        velad::ApiState::new(store, runtime).with_codex_backend(Some("gpt-5.4".to_string())),
    );

    let (status, body) = get_json(app.clone(), "/api/v1/backends/codex").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["backend"]["kind"], "codex");
    assert_eq!(body["backend"]["models"][0]["id"], "gpt-5.4");

    let (status, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({
            "backend": "codex",
            "working_directory": "/tmp/codex-project",
            "agent_config": {
                "model": "gpt-5.4",
                "permission_mode": "full_access"
            }
        }),
        Some("ses-codex-http"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["session"]["backend"], "codex");

    let session_id = created["session"]["id"].as_str().expect("session id");
    let (status, _) = json_request(
        app,
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({
            "events": [{
                "type": "user.message",
                "content": [{ "type": "text", "text": "hello codex" }]
            }]
        }),
        Some("codex-http-send"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    eventually_backend_called(&backend).await;
    assert_eq!(
        backend.recorded_resolved_agent_configs().await[0]
            .as_ref()
            .map(|config| config.backend),
        Some(vela_core::BackendKind::Codex)
    );
}

#[tokio::test]
async fn codex_backend_exposes_default_model_when_env_model_is_absent() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(support::default_backend_outputs()));
    let runtime = Runtime::new(store.clone(), backend);
    let app = velad::build_app(velad::ApiState::new(store, runtime).with_codex_backend(None));

    let (status, body) = get_json(app, "/api/v1/backends/codex").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["backend"]["kind"], "codex");
    assert_eq!(body["backend"]["models"][0]["id"], "gpt-5.3-codex-spark");
    assert_eq!(body["backend"]["models"][0]["is_default"], true);
}

#[tokio::test]
async fn acp_backend_can_be_configured_and_used_for_sessions() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(support::default_backend_outputs()));
    let runtime = Runtime::new(store.clone(), backend.clone());
    let app = velad::build_app(
        velad::ApiState::new(store, runtime).with_acp_backend(Some("minimax-m2.7".to_string())),
    );

    let (status, body) = get_json(app.clone(), "/api/v1/backends/acp").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["backend"]["kind"], "acp");
    assert_eq!(body["backend"]["display_name"], "Hermes ACP");
    assert_eq!(body["backend"]["models"][0]["id"], "minimax-m2.7");

    let (status, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({
            "backend": "acp",
            "working_directory": "/tmp/acp-project",
            "agent_config": {
                "model": "minimax-m2.7",
                "reasoning_effort": "medium",
                "permission_mode": "auto"
            }
        }),
        Some("ses-acp-http"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["session"]["backend"], "acp");

    let session_id = created["session"]["id"].as_str().expect("session id");
    let (status, _) = json_request(
        app,
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({
            "events": [{
                "type": "user.message",
                "content": [{ "type": "text", "text": "hello acp" }]
            }]
        }),
        Some("acp-http-send"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    eventually_backend_called(&backend).await;
    assert_eq!(
        backend.recorded_resolved_agent_configs().await[0]
            .as_ref()
            .map(|config| config.backend),
        Some(vela_core::BackendKind::Acp)
    );
}

#[tokio::test]
async fn acp_session_events_accept_base64_image_input_parts() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(support::default_backend_outputs()));
    let runtime = Runtime::new(store.clone(), backend.clone());
    let app = velad::build_app(
        velad::ApiState::new(store, runtime).with_acp_backend(Some("minimax-m2.7".to_string())),
    );
    let (status, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "acp", "working_directory": "/tmp/acp-project" }),
        Some("ses-acp-image-http"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let session_id = created["session"]["id"].as_str().expect("session id");

    let (status, ack) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({
            "events": [{
                "type": "user.message",
                "content": [
                    { "type": "text", "text": "look at this" },
                    { "type": "image", "data": "aGVsbG8=", "mime_type": "image/png" }
                ]
            }]
        }),
        Some("acp-http-image-send"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(ack["status"], "accepted");

    eventually_backend_called(&backend).await;
    let inputs = backend.recorded_inputs().await;
    assert_eq!(
        inputs[0].blocks,
        vec![
            UserMessageBlock::text("look at this"),
            UserMessageBlock::Image {
                blob: BlobRef::InlineBase64 {
                    data: "aGVsbG8=".to_string(),
                    mime_type: "image/png".to_string(),
                    sha256: Some(
                        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
                            .to_string()
                    ),
                    size_bytes: Some(5),
                }
            }
        ]
    );

    let transcript = wait_for_transcript_rows(app.clone(), session_id, 1).await;
    assert_eq!(
        transcript["rows"][0]["parts"],
        json!([
            {
                "id": format!("{}:part:0", transcript["rows"][0]["id"].as_str().unwrap()),
                "type": "text",
                "text": "look at this"
            },
            {
                "id": format!("{}:part:1", transcript["rows"][0]["id"].as_str().unwrap()),
                "type": "image",
                "data": {
                    "kind": "inline_base64",
                    "data": "aGVsbG8=",
                    "mime_type": "image/png",
                    "sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                    "size_bytes": 5
                }
            }
        ])
    );

    let events = wait_for_session_event(app, session_id, "user.message.accepted").await;
    let accepted = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["type"] == "user.message.accepted")
        .expect("user.message.accepted");
    assert_eq!(
        accepted["payload"]["blocks"],
        json!([
            { "type": "text", "text": "look at this" },
            {
                "type": "image",
                "blob": {
                    "kind": "inline_base64",
                    "data": "aGVsbG8=",
                    "mime_type": "image/png",
                    "sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                    "size_bytes": 5
                }
            }
        ])
    );
}

#[tokio::test]
async fn unsupported_backends_are_not_silently_mapped_to_pi() {
    let app = test_app().await;

    let (status, body) = get_json(app.clone(), "/api/v1/backends/cloudagent").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "backend_not_found");

    let (status, body) = json_request(
        app,
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "cloudagent", "working_directory": "/tmp/project" }),
        Some("create-cloudagent"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "backend_unavailable");
}

#[tokio::test]
async fn exposes_remaining_openapi_shell_routes() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-shell"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();
    let (_, _) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({
            "events": [{
                "type": "user.message",
                "content": [{ "type": "text", "text": "ping" }]
            }]
        }),
        Some("cmd-shell"),
    )
    .await;

    let (status, timeline) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/timeline"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let item_id = timeline["items"][0]["id"].as_str().unwrap();
    let (status, item) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/timeline/{item_id}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(item["item"]["id"], item_id);

    let (status, trace) =
        get_json(app.clone(), &format!("/api/v1/sessions/{session_id}/trace")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(trace["session_id"], session_id);

    let (status, diffs) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/views/diffs"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!diffs["diffs"].as_array().unwrap().is_empty());

    let (status, cancel) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/cancel"),
        json!({}),
        Some("cancel-shell"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(cancel["status"], "accepted");

    let (status, close) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/close"),
        json!({}),
        Some("close-shell"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(close["status"], "accepted");

    let (status, probe) = json_request(
        app,
        Method::POST,
        "/api/v1/backends/pi/probe",
        json!({}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(probe["backend"], "pi");
}

#[tokio::test]
async fn openapi_and_router_keep_timeline_and_trace_on_main_session_api() {
    let openapi = include_str!("../../../public/openapi/velachat.v1.yaml");
    assert!(openapi.contains("  /sessions/{session_id}/timeline:"));
    assert!(openapi.contains("  /sessions/{session_id}/trace:"));
    assert!(!openapi.contains("/sessions/{session_id}/diagnostics/timeline"));
    assert!(!openapi.contains("/sessions/{session_id}/diagnostics/trace"));

    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-main-timeline-trace"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, timeline) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/timeline"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(timeline["items"].is_array());

    let (status, trace) = get_json(app, &format!("/api/v1/sessions/{session_id}/trace")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(trace["session_id"], session_id);
}

#[tokio::test]
async fn stream_routes_are_available_for_inprocess_consumers() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-stream"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    let response = get_response(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/events/stream"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"].to_str().unwrap(),
        "text/event-stream"
    );

    let response = get_response(app, "/api/v1/events/stream").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"].to_str().unwrap(),
        "text/event-stream"
    );
}

#[tokio::test]
async fn create_session_is_idempotent_and_conflicts_on_different_body() {
    let app = test_app().await;
    let body = json!({
        "backend": "pi",
        "working_directory": "/tmp/project",
        "title": "Stable",
        "model": "m1",
        "metadata": { "team": "runtime" }
    });

    let (first_status, first) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        body.clone(),
        Some("create-stable"),
    )
    .await;
    let (second_status, second) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        body,
        Some("create-stable"),
    )
    .await;
    let (conflict_status, conflict) = json_request(
        app,
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/other" }),
        Some("create-stable"),
    )
    .await;

    assert_eq!(first_status, StatusCode::CREATED);
    assert_eq!(second_status, StatusCode::CREATED);
    assert_eq!(first["session"]["id"], second["session"]["id"]);
    assert_eq!(second["session"]["title"], "Stable");
    assert_eq!(second["session"]["model"], "m1");
    assert_eq!(second["session"]["metadata"], json!({ "team": "runtime" }));
    assert_eq!(conflict_status, StatusCode::CONFLICT);
    assert_eq!(conflict["error"]["code"], "duplicate_command");
}

#[tokio::test]
async fn event_history_supports_after_id_and_limit() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-history"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();
    let (_, _) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({ "events": [{ "type": "user.message", "content": [{ "type": "text", "text": "one" }] }] }),
        Some("cmd-history-1"),
    )
    .await;
    let (_, all) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/events"),
    )
    .await;
    let first_event_id = all["events"][0]["event_id"].as_str().unwrap();

    let (status, page) = get_json(
        app,
        &format!("/api/v1/sessions/{session_id}/events?after_id={first_event_id}&limit=2"),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["events"].as_array().unwrap().len(), 2);
    assert_ne!(page["events"][0]["event_id"], first_event_id);
    assert_eq!(page["cursor"]["has_older"], true);
    assert_eq!(page["cursor"]["has_newer"], true);
}

#[tokio::test]
async fn openapi_exposes_direction_based_view_window_contracts() {
    let openapi = include_str!("../../../public/openapi/velachat.v1.yaml");
    let transcript_start = openapi
        .find("  /sessions/{session_id}/views/transcript:")
        .expect("transcript path");
    let activity_start = openapi
        .find("  /sessions/{session_id}/views/activity:")
        .expect("activity path");
    let requests_start = openapi
        .find("  /sessions/{session_id}/views/requests:")
        .expect("requests path");
    let transcript_path = &openapi[transcript_start..activity_start];
    let activity_path = &openapi[activity_start..requests_start];
    let activity_schema_start = openapi
        .find("    ActivityShelfView:")
        .expect("activity schema");
    let activity_window_start = openapi
        .find("    ActivityWindow:")
        .expect("activity window schema");
    let activity_schema = &openapi[activity_schema_start..activity_window_start];

    assert!(openapi.contains("    ViewWindowDirection:"));
    assert!(openapi.contains("      enum: [tail, before, after, around]"));
    assert!(transcript_path.contains("        - name: direction"));
    assert!(transcript_path.contains("        - name: anchor_row_id"));
    assert!(!transcript_path.contains("before_row_id"));
    assert!(!transcript_path.contains("after_row_id"));
    assert!(!transcript_path.contains("around_row_id"));
    assert!(!transcript_path.contains("before_id"));
    assert!(activity_path.contains("        - name: direction"));
    assert!(activity_path.contains("        - name: anchor_item_id"));
    assert!(activity_path.contains("        '409':"));
    assert!(activity_schema.contains("$ref: '#/components/schemas/EventCursor'"));
    assert!(!activity_schema.contains("$ref: '#/components/schemas/CursorWindow'"));
    assert!(openapi.contains("    ActivityWindow:"));
    assert!(openapi.contains("      required: [session_id, items, window, cursor]"));
}

#[tokio::test]
async fn openapi_query_limits_are_validated_instead_of_clamped() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-limit-validation"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    for uri in [
        "/api/v1/sessions?limit=0".to_string(),
        "/api/v1/views/sessions?limit=501".to_string(),
        format!("/api/v1/sessions/{session_id}/events?limit=0"),
        format!("/api/v1/sessions/{session_id}/views/transcript?limit=501"),
        format!("/api/v1/sessions/{session_id}/views/activity?limit=0"),
        format!("/api/v1/sessions/{session_id}/timeline?limit=501"),
        format!("/api/v1/sessions/{session_id}/trace?limit=0"),
    ] {
        let (status, body) = get_json(app.clone(), &uri).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "uri: {uri}");
        assert_eq!(body["error"]["code"], "invalid_parameter", "uri: {uri}");
    }
}

#[tokio::test]
async fn malformed_query_parameters_return_error_envelope() {
    let app = test_app().await;
    let (status, body) = get_json(app, "/api/v1/sessions?limit=not-a-number").await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid_parameter");
    assert_eq!(body["error"]["details"]["parameter"], "query");
}

#[tokio::test]
async fn request_status_query_is_validated_against_openapi_enum() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-status-validation"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, body) = get_json(
        app,
        &format!("/api/v1/sessions/{session_id}/views/requests?status=banana"),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid_parameter");
}

#[tokio::test]
async fn send_session_events_processes_every_input_event_in_order() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-batch-input"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, ack) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({
            "events": [
                { "type": "user.message", "content": [{ "type": "text", "text": "first" }] }
            ]
        }),
        Some("cmd-batch-input"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(ack["status"], "accepted");
    wait_for_session_event_count(app.clone(), session_id, "turn.completed", 1).await;

    let (status, ack) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({
            "events": [
                { "type": "user.message", "content": [{ "type": "text", "text": "second" }] }
            ]
        }),
        Some("cmd-batch-input-2"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(ack["status"], "accepted");
    wait_for_session_event_count(app.clone(), session_id, "turn.completed", 2).await;

    let (status, events) = get_json(app, &format!("/api/v1/sessions/{session_id}/events")).await;
    assert_eq!(status, StatusCode::OK);
    let user_messages = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == "user.message.accepted")
        .map(|event| event["payload"]["content"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(user_messages, vec!["first", "second"]);
}

#[tokio::test]
async fn supports_all_client_input_event_types_and_request_lookup() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-inputs"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();
    let (_, _) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({ "events": [{ "type": "user.message", "content": [{ "type": "text", "text": "open request" }] }] }),
        Some("cmd-open-request"),
    )
    .await;

    let (status, request) = get_json(app.clone(), "/api/v1/requests/req_1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(request["request"]["status"], "pending");

    for (key, event) in [
        (
            "confirm-1",
            json!({ "type": "user.tool_confirmation", "request_id": "req_1", "result": "allow", "scope": "once" }),
        ),
        (
            "custom-result-1",
            json!({ "type": "user.custom_tool_result", "request_id": "req_1", "content": [{ "type": "text", "text": "done" }] }),
        ),
        (
            "answer-1",
            json!({ "type": "user.request_answer", "request_id": "req_1", "answer": "yes" }),
        ),
    ] {
        let (status, ack) = json_request(
            app.clone(),
            Method::POST,
            &format!("/api/v1/sessions/{session_id}/events"),
            json!({ "events": [event] }),
            Some(key),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(ack["status"], "accepted");
    }

    let (status, request) = get_json(app.clone(), "/api/v1/requests/req_1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(request["request"]["status"], "answered");

    let (status, requests) = get_json(
        app,
        &format!("/api/v1/sessions/{session_id}/views/requests?status=answered"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(requests["requests"][0]["id"], "req_1");
}

#[tokio::test]
async fn projections_timeline_and_trace_are_coalesced_and_schema_complete() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-projection"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();
    let (_, _) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({ "events": [{ "type": "user.message", "content": [{ "type": "text", "text": "diff please" }] }] }),
        Some("cmd-projection"),
    )
    .await;

    let (status, diffs) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/views/diffs"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(diffs["diffs"][0]["file_path"], "src/main.rs");
    assert_eq!(diffs["diffs"][0]["additions"], 2);

    let (status, timeline) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/timeline"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        timeline["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "diff")
    );
    assert!(
        timeline["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "request")
    );

    let (status, trace) = get_json(app, &format!("/api/v1/sessions/{session_id}/trace")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        trace["spans"]
            .as_array()
            .unwrap()
            .iter()
            .any(|span| span["kind"] == "backend_raw")
    );
    assert!(
        trace["spans"]
            .as_array()
            .unwrap()
            .iter()
            .any(|span| span["kind"] == "projection")
    );
}

#[tokio::test]
async fn control_and_non_message_inputs_are_idempotent_and_update_state_once() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-idem-controls"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();
    let (_, _) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({ "events": [{ "type": "user.message", "content": [{ "type": "text", "text": "open request" }] }] }),
        Some("cmd-open-idem"),
    )
    .await;

    for _ in 0..2 {
        let (status, ack) = json_request(
            app.clone(),
            Method::POST,
            &format!("/api/v1/sessions/{session_id}/events"),
            json!({ "events": [{ "type": "user.tool_confirmation", "request_id": "req_1", "result": "allow" }] }),
            Some("confirm-idem"),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(ack["status"], "accepted");
    }

    for _ in 0..2 {
        let (status, ack) = json_request(
            app.clone(),
            Method::POST,
            &format!("/api/v1/sessions/{session_id}/close"),
            json!({}),
            Some("close-idem"),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(ack["status"], "accepted");
    }

    let (status, session) = get_json(app.clone(), &format!("/api/v1/sessions/{session_id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session["session"]["status"], "closed");

    let (status, events) = get_json(app, &format!("/api/v1/sessions/{session_id}/events")).await;
    assert_eq!(status, StatusCode::OK);
    let resolved_count = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == "request.resolved")
        .count();
    let closed_count = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == "session.closed")
        .count();
    assert_eq!(resolved_count, 1);
    assert_eq!(closed_count, 1);
}

#[tokio::test]
async fn closed_sessions_reject_new_input_and_cancel_without_appending_events() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-closed-reject"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    let (_, _) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/close"),
        json!({}),
        Some("close-closed-reject"),
    )
    .await;
    let (_, before) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/events"),
    )
    .await;
    let before_count = before["events"].as_array().unwrap().len();

    let (status, message_ack) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({ "events": [{ "type": "user.message", "content": [{ "type": "text", "text": "too late" }] }] }),
        Some("cmd-after-close"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(message_ack["status"], "rejected");
    assert_eq!(message_ack["code"], "session_closed");

    let (status, cancel_ack) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/cancel"),
        json!({}),
        Some("cancel-after-close"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(cancel_ack["status"], "rejected");
    assert_eq!(cancel_ack["code"], "session_closed");

    let (_, after) = get_json(app, &format!("/api/v1/sessions/{session_id}/events")).await;
    assert_eq!(after["events"].as_array().unwrap().len(), before_count);
}

#[tokio::test]
async fn unsupported_client_input_type_is_command_rejection_not_server_error() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-unsupported-input"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, ack) = json_request(
        app,
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({ "events": [{ "type": "user.unknown" }] }),
        Some("cmd-unsupported-input"),
    )
    .await;

    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(ack["status"], "rejected");
    assert_eq!(ack["code"], "invalid_input_event");
}

#[tokio::test]
async fn malformed_http_inputs_return_error_envelope() {
    let app = test_app().await;

    let (status, body) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi" }),
        Some("bad-create"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid_request");

    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/sessions")
                .header("content-type", "application/json")
                .header("Idempotency-Key", "bad-json")
                .body(Body::from("{not-json"))
                .unwrap(),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).expect("error json");
    assert_eq!(body["error"]["code"], "invalid_request");
}

#[tokio::test]
async fn session_event_stream_is_live_and_reconnects_after_cursor() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-live"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap().to_string();
    let create_event_id = created["cursor"]["event_id"].as_str().unwrap().to_string();

    let mut response = get_response(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/events/stream?after_id={create_event_id}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let (_, _) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({ "events": [{ "type": "user.message", "content": [{ "type": "text", "text": "live" }] }] }),
        Some("cmd-live"),
    )
    .await;

    let frame = timeout(Duration::from_secs(2), response.body_mut().frame())
        .await
        .expect("live sse frame")
        .expect("some frame")
        .expect("frame ok");
    let data = String::from_utf8(frame.into_data().expect("data").to_vec()).expect("utf8");
    assert!(data.contains("event: user.message.accepted"), "{data}");

    let (_, events) = get_json(
        app,
        &format!("/api/v1/sessions/{session_id}/events?after_id={create_event_id}&limit=1"),
    )
    .await;
    assert_eq!(events["events"][0]["type"], "user.message.accepted");
}

#[tokio::test]
async fn session_event_stream_accepts_last_event_id_header_as_after_cursor() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-last-event-id"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap().to_string();
    let create_event_id = created["cursor"]["event_id"].as_str().unwrap().to_string();

    let mut response = get_response_with_header(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/events/stream"),
        "Last-Event-ID",
        &create_event_id,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let (_, _) = json_request(
        app,
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({ "events": [{ "type": "user.message", "content": [{ "type": "text", "text": "after header" }] }] }),
        Some("cmd-last-event-id"),
    )
    .await;

    let frame = timeout(Duration::from_secs(2), response.body_mut().frame())
        .await
        .expect("live sse frame")
        .expect("some frame")
        .expect("frame ok");
    let data = String::from_utf8(frame.into_data().expect("data").to_vec()).expect("utf8");
    assert!(data.contains("event: user.message.accepted"), "{data}");
    assert!(!data.contains("event: session.created"), "{data}");
}

#[tokio::test]
async fn backend_probe_and_cancel_delegate_to_adapter() {
    let (app, backend) = test_app_with_backend().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-backend-delegate"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, probe) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/backends/pi/probe",
        json!({}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(probe["status"], "available");
    assert_eq!(backend.probe_count().await, 1);

    let (status, ack) = json_request(
        app,
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/cancel"),
        json!({}),
        Some("cancel-delegated"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(ack["status"], "accepted");
    assert_eq!(backend.cancel_count().await, 1);
}

#[tokio::test]
async fn timeline_coalesces_related_event_lifecycles() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-timeline-coalesce"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();
    let (_, _) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({ "events": [{ "type": "user.message", "content": [{ "type": "text", "text": "coalesce" }] }] }),
        Some("cmd-timeline-coalesce"),
    )
    .await;
    wait_for_session_event(app.clone(), session_id, "turn.completed").await;

    let (status, timeline) =
        get_json(app, &format!("/api/v1/sessions/{session_id}/timeline")).await;
    assert_eq!(status, StatusCode::OK);
    let items = timeline["items"].as_array().unwrap();
    let assistant_items = items
        .iter()
        .filter(|item| item["kind"] == "message" && item["role"] == "assistant")
        .count();
    let request_items = items
        .iter()
        .filter(|item| item["kind"] == "request")
        .count();
    let diff_items = items.iter().filter(|item| item["kind"] == "diff").count();
    assert_eq!(assistant_items, 1);
    assert_eq!(request_items, 1);
    assert_eq!(diff_items, 1);
}

#[tokio::test]
async fn stale_cursor_returns_reset_for_history_and_sse() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-stale"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, reset) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/events?after_id=evt_missing"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(reset["reason"], "stale_cursor");
    assert!(
        reset["views"]
            .as_array()
            .unwrap()
            .contains(&json!("timeline"))
    );

    let mut response = get_response(
        app,
        &format!("/api/v1/sessions/{session_id}/events/stream?after_id=evt_missing"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let frame = timeout(Duration::from_secs(2), response.body_mut().frame())
        .await
        .expect("reset frame")
        .expect("some frame")
        .expect("frame ok");
    let data = String::from_utf8(frame.into_data().expect("data").to_vec()).expect("utf8");
    assert!(data.contains("event: sync.reset"), "{data}");
}
