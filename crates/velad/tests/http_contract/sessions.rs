use super::*;

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
async fn archives_session_and_hides_it_from_default_lists() {
    let app = test_app().await;
    let (_, archived) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/archive-me" }),
        Some("archive-me"),
    )
    .await;
    let (_, active) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({ "backend": "pi", "working_directory": "/tmp/keep-me" }),
        Some("keep-me"),
    )
    .await;
    let archived_id = archived["session"]["id"].as_str().unwrap();
    let active_id = active["session"]["id"].as_str().unwrap();

    let (status, body) = json_request(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{archived_id}/archive"),
        json!({}),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["session"]["id"], archived_id);
    assert_eq!(body["session"]["status"], "archived");

    let (status, sessions) = get_json(app.clone(), "/api/v1/sessions?limit=20").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(sessions["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(sessions["sessions"][0]["id"], active_id);

    let (status, view) = get_json(app, "/api/v1/views/sessions?limit=20").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(view["sessions"][0]["id"], active_id);
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
