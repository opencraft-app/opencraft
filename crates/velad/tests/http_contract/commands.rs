use super::*;

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
    let turn_id = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["type"] == "turn.started")
        .and_then(|event| event["payload"]["turn_id"].as_str())
        .expect("turn.started should expose turn_id");
    assert_eq!(transcript["rows"][0]["turn_id"], turn_id);
    assert_eq!(transcript["rows"][1]["turn_id"], turn_id);
    assert_eq!(transcript["turns"].as_array().unwrap().len(), 1);
    assert_eq!(transcript["turns"][0]["turn_id"], turn_id);
    assert_eq!(transcript["turns"][0]["status"], "completed");
    assert_eq!(
        transcript["turns"][0]["first_row_id"],
        transcript["rows"][0]["id"]
    );
    assert_eq!(
        transcript["turns"][0]["last_row_id"],
        transcript["rows"][1]["id"]
    );
    assert!(
        transcript["turns"][0]["started_at"]
            .as_str()
            .unwrap()
            .contains('T')
    );
    assert!(
        transcript["turns"][0]["completed_at"]
            .as_str()
            .unwrap()
            .contains('T')
    );
    assert!(
        transcript["turns"][0]["source_event_ids"]
            .as_array()
            .unwrap()
            .len()
            >= 2
    );
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
