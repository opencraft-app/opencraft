use super::*;

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
    assert_eq!(tail["session_id"], session_id);
    assert_eq!(tail["items"].as_array().unwrap().len(), 2);
    assert_eq!(tail["window"]["has_older"], true);
    assert_eq!(tail["window"]["has_newer"], false);
    let (_, events) = get_json(
        app.clone(),
        &format!("/api/v1/sessions/{session_id}/events"),
    )
    .await;
    let turn_id = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["type"] == "turn.started")
        .and_then(|event| event["payload"]["turn_id"].as_str())
        .expect("turn.started should expose turn_id");
    assert!(
        tail["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["turn_id"] == turn_id),
        "activity items from the same turn should carry turn_id: {tail:#?}"
    );

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
    assert_eq!(activity["session_id"], session_id);
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
    assert_eq!(activity["session_id"], session_id);
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
