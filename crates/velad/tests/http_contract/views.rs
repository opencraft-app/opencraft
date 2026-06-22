use super::*;

#[tokio::test]
async fn conversation_view_supports_direction_anchor_paging() {
    let (app, _) = test_app_with_backend_outputs(vec![
        BackendOutput::event(
            EventType::TOOL_STARTED,
            json!({
                "tool_id": "tool_readme",
                "name": "read",
                "status": "running",
                "detail": {
                    "type": "read",
                    "file_path": "README.md"
                }
            }),
        ),
        BackendOutput::event(
            EventType::TOOL_COMPLETED,
            json!({
                "tool_id": "tool_readme",
                "name": "read",
                "status": "completed",
                "detail": {
                    "type": "read",
                    "file_path": "README.md"
                }
            }),
        ),
        BackendOutput::event(
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "message_id": "msg_answer", "delta": "pong" }),
        ),
        BackendOutput::event(
            EventType::ASSISTANT_MESSAGE_COMPLETED,
            json!({ "message_id": "msg_answer" }),
        ),
        BackendOutput::event(EventType::TURN_COMPLETED, json!({})),
    ])
    .await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-conversation-window"),
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
                "content": [{ "type": "text", "text": "conversation paging" }]
            }]
        }),
        Some("cmd-conversation-window"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    wait_for_session_event(app.clone(), session_id, "turn.completed").await;

    let (status, tail) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/views/conversation?direction=tail&limit=3"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tail["session_id"], session_id);
    assert_eq!(tail["items"].as_array().unwrap().len(), 3);
    assert_eq!(tail["window"]["has_older"], true);
    assert_eq!(tail["window"]["has_newer"], false);
    assert!(
        tail["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "agent_work" && item["detail"]["type"] == "read"),
        "conversation view should include normalized agent work items: {tail:#?}"
    );
    assert!(
        tail["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "assistant_message" && item["text"] == "pong"),
        "conversation view should include assistant message items: {tail:#?}"
    );
    for item in tail["items"].as_array().unwrap() {
        let ranges = item["source_event_ranges"]
            .as_array()
            .unwrap_or_else(|| panic!("conversation item must expose source_event_ranges: {item:#?}"));
        assert!(
            !ranges.is_empty(),
            "conversation item source_event_ranges must not be empty: {item:#?}"
        );
        for range in ranges {
            assert!(
                range["from_seq"].as_i64().is_some()
                    && range["to_seq"].as_i64().is_some()
                    && range["from_event_id"].as_str().is_some()
                    && range["to_event_id"].as_str().is_some(),
                "source_event_ranges must include event ids and seq bounds: {range:#?}"
            );
        }
    }

    let first_tail_item_id = tail["window"]["first_item_id"].as_str().unwrap();
    let (status, previous) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/views/conversation?direction=before&anchor_item_id={first_tail_item_id}&limit=3"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(previous["items"].as_array().unwrap().len(), 1);
    assert_eq!(previous["window"]["has_older"], false);
    assert_eq!(previous["window"]["has_newer"], true);
    assert_eq!(previous["items"][0]["kind"], "user_message");

    let (status, full_window) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/views/conversation?direction=tail&limit=10"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let full_items = full_window["items"].as_array().unwrap();
    assert_eq!(full_items.len(), 4);
    let kinds = full_items
        .iter()
        .map(|item| item["kind"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        kinds,
        vec![
            "user_message",
            "turn_meta",
            "agent_work",
            "assistant_message"
        ]
    );

    let after_anchor = full_items[1]["id"].as_str().unwrap();
    let (status, after) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/views/conversation?direction=after&anchor_item_id={after_anchor}&limit=2"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(after["items"].as_array().unwrap().len(), 2);
    assert_eq!(after["items"][0]["id"], full_items[2]["id"]);
    assert_eq!(after["window"]["has_older"], true);
    assert_eq!(after["window"]["has_newer"], false);

    let around_anchor = full_items[2]["id"].as_str().unwrap();
    let (status, around) = get_json(
        app,
        &format!("/api/v1/sessions/{session_id}/views/conversation?direction=around&anchor_item_id={around_anchor}&limit=3"),
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
async fn conversation_view_rejects_invalid_direction_anchor_combinations() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-conversation-direction-invalid"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    for uri in [
        format!("/api/v1/sessions/{session_id}/views/conversation?direction=before"),
        format!(
            "/api/v1/sessions/{session_id}/views/conversation?direction=tail&anchor_item_id=item_1"
        ),
        format!("/api/v1/sessions/{session_id}/views/conversation?anchor_item_id=item_1"),
        format!(
            "/api/v1/sessions/{session_id}/views/conversation?direction=before&row_id=row_1"
        ),
        format!("/api/v1/sessions/{session_id}/views/conversation?after_id=evt_1"),
    ] {
        let (status, body) = get_json(app.clone(), &uri).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "uri: {uri}");
        assert_eq!(body["error"]["code"], "invalid_parameter", "uri: {uri}");
    }
}

#[tokio::test]
async fn conversation_view_rejects_stale_item_anchor_with_sync_reset() {
    let app = test_app().await;
    let (_, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/project" }),
        Some("ses-conversation-stale-item"),
    )
    .await;
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, body) = get_json(
        app,
        &format!("/api/v1/sessions/{session_id}/views/conversation?direction=before&anchor_item_id=missing-item"),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["reason"], "stale_cursor");
    assert!(
        body["views"]
            .as_array()
            .unwrap()
            .contains(&json!("conversation"))
    );
}

#[tokio::test]
async fn openapi_exposes_conversation_view_as_primary_chat_contract() {
    let openapi = include_str!("../../../../public/openapi/velachat.v1.yaml");

    assert!(openapi.contains("  /sessions/{session_id}/views/conversation:"));
    assert!(openapi.contains("      operationId: getConversationView"));
    assert!(openapi.contains("    ConversationView:"));
    assert!(openapi.contains("    ConversationItem:"));
    assert!(openapi.contains("    ConversationWindow:"));
    assert!(openapi.contains("    AgentWorkItem:"));
    assert!(openapi.contains("        source_event_ranges:"));
    assert!(openapi.contains("        - conversation"));
    assert!(!openapi.contains("ChatTranscriptView"));
    assert!(!openapi.contains("ActivityShelfView"));
    assert!(!openapi.contains("/views/transcript"));
    assert!(!openapi.contains("/views/activity"));
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
        format!("/api/v1/sessions/{session_id}/views/conversation?limit=501"),
        format!("/api/v1/sessions/{session_id}/timeline?limit=501"),
        format!("/api/v1/sessions/{session_id}/trace?limit=0"),
    ] {
        let (status, body) = get_json(app.clone(), &uri).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "uri: {uri}");
        assert_eq!(body["error"]["code"], "invalid_parameter", "uri: {uri}");
    }
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
async fn malformed_query_parameters_return_error_envelope() {
    let app = test_app().await;
    let (status, body) = get_json(app, "/api/v1/sessions?limit=not-a-number").await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid_parameter");
    assert_eq!(body["error"]["details"]["parameter"], "query");
}
