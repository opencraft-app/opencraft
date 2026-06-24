use super::*;

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
    assert_eq!(
        acp["models"][0]["reasoning_efforts"]
            .as_array()
            .expect("acp reasoning efforts"),
        &Vec::<serde_json::Value>::new()
    );
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
async fn codex_backend_model_discovery_failure_is_an_error_snapshot() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(
        MockBackendAdapter::new(support::default_backend_outputs())
            .with_model_discovery_error("codex config invalid: service_tier default unsupported"),
    );
    let runtime = Runtime::new(store.clone(), backend);
    let app = velad::build_app(
        velad::ApiState::new(store, runtime).with_codex_backend(Some("gpt-5.4".to_string())),
    );

    let (status, body) = get_json(app.clone(), "/api/v1/backends/codex").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["backend"]["kind"], "codex");
    assert_eq!(body["backend"]["status"], "error");
    assert!(body["backend"]["models"].as_array().unwrap().is_empty());
    assert!(
        body["backend"]["status_message"]
            .as_str()
            .unwrap()
            .contains("service_tier default unsupported")
    );
    assert!(
        body["backend"]["diagnostics"]["model_discovery_error"]
            .as_str()
            .unwrap()
            .contains("service_tier default unsupported")
    );

    let (status, body) = json_request(
        app,
        Method::POST,
        "/api/v1/sessions",
        json!({
            "backend": "codex",
            "working_directory": "/tmp/codex-project",
            "agent_config": {
                "model": "gpt-5.4"
            }
        }),
        Some("ses-codex-model-discovery-failed"),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "backend_unavailable");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("service_tier default unsupported")
    );
}

#[tokio::test]
async fn codex_create_session_rejects_unknown_model() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(support::default_backend_outputs()));
    let runtime = Runtime::new(store.clone(), backend);
    let app = velad::build_app(
        velad::ApiState::new(store, runtime).with_codex_backend(Some("gpt-5.4".to_string())),
    );

    let (status, body) = json_request(
        app,
        Method::POST,
        "/api/v1/sessions",
        json!({
            "backend": "codex",
            "working_directory": "/tmp/codex-project",
            "agent_config": {
                "model": "not-a-codex-model"
            }
        }),
        Some("ses-codex-bad-model"),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid_agent_config");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not-a-codex-model")
    );
}

#[tokio::test]
async fn codex_create_session_rejects_unsupported_feature_values() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(support::default_backend_outputs()));
    let runtime = Runtime::new(store.clone(), backend);
    let app = velad::build_app(
        velad::ApiState::new(store, runtime).with_codex_backend(Some("legacy-model".to_string())),
    );

    let (status, body) = json_request(
        app,
        Method::POST,
        "/api/v1/sessions",
        json!({
            "backend": "codex",
            "working_directory": "/tmp/codex-project",
            "agent_config": {
                "model": "legacy-model",
                "feature_values": {
                    "fast_mode": true
                }
            }
        }),
        Some("ses-codex-bad-feature"),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid_agent_config");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("fast_mode")
    );
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
