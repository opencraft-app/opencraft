use super::*;

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
        &format!("/api/v1/sessions/{session_id}/diagnostics/timeline"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let item_id = timeline["items"][0]["id"].as_str().unwrap();
    let (status, item) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/diagnostics/timeline/{item_id}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(item["item"]["id"], item_id);

    let (status, trace) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/diagnostics/trace"),
    )
    .await;
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
async fn openapi_and_router_keep_timeline_and_trace_on_diagnostics_api_only() {
    let openapi = include_str!("../../../../public/openapi/velachat.v1.yaml");
    assert!(openapi.contains("  /sessions/{session_id}/diagnostics/timeline:"));
    assert!(openapi.contains("  /sessions/{session_id}/diagnostics/trace:"));
    assert!(!openapi.contains("  /sessions/{session_id}/timeline:"));
    assert!(!openapi.contains("  /sessions/{session_id}/trace:"));
    assert!(!openapi.contains("name: Session Timeline"));

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
        &format!("/api/v1/sessions/{session_id}/diagnostics/timeline"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(timeline["items"].is_array());

    let (status, trace) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/diagnostics/trace"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(trace["session_id"], session_id);

    let response = get_response(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/timeline"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let response = get_response(app, &format!("/api/v1/sessions/{session_id}/trace")).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
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
        &format!("/api/v1/sessions/{session_id}/diagnostics/timeline"),
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

    let (status, trace) = get_json(
        app,
        &format!("/api/v1/sessions/{session_id}/diagnostics/trace"),
    )
    .await;
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

    let (status, timeline) = get_json(
        app,
        &format!("/api/v1/sessions/{session_id}/diagnostics/timeline"),
    )
    .await;
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
