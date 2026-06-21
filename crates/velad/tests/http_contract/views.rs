use super::*;

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
async fn openapi_exposes_direction_based_view_window_contracts() {
    let openapi = include_str!("../../../../public/openapi/velachat.v1.yaml");
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
async fn openapi_exposes_transcript_turn_summaries_as_required_window_metadata() {
    let openapi = include_str!("../../../../public/openapi/velachat.v1.yaml");
    let transcript_start = openapi
        .find("    ChatTranscriptView:")
        .expect("transcript schema");
    let window_start = openapi
        .find("    TranscriptWindow:")
        .expect("transcript window schema");
    let transcript_schema = &openapi[transcript_start..window_start];

    assert!(
        transcript_schema.contains("      required: [session_id, rows, turns, window, cursor]")
    );
    assert!(transcript_schema.contains("        turns:"));
    assert!(transcript_schema.contains("$ref: '#/components/schemas/ChatTurnSummary'"));
    assert!(openapi.contains("    ChatTurnSummary:"));
    assert!(openapi.contains("      required: [turn_id, status, started_at, source_event_ids]"));
    assert!(openapi.contains("      enum: [running, completed, failed, cancelled]"));
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
