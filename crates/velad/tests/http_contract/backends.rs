use super::*;

fn codex_model(id: &str, default_reasoning: Option<&str>) -> vela_core::BackendModel {
    vela_core::BackendModel {
        id: id.to_string(),
        label: id.to_string(),
        description: None,
        is_default: true,
        reasoning_efforts: vela_backends::codex::capabilities::codex_reasoning_effort_options(
            default_reasoning,
        ),
        metadata: Default::default(),
    }
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
async fn lists_backends_without_calling_runtime_business_logic() {
    let app = test_app().await;

    let (status, body) = get_json(app.clone(), "/api/v1/backends").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["backends"].as_array().unwrap().iter().any(|backend| {
        backend["kind"] == "pi" && backend["capabilities"]["streaming"] == true
    }));
    assert!(body["backends"].as_array().unwrap().iter().all(|backend| {
        backend["location"]["kind"] == "local" && backend["location"]["label"] == "Local"
    }));

    let (status, body) = get_json(app, "/api/v1/backends/pi").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["backend"]["kind"], "pi");
    assert_eq!(body["backend"]["backend_type"], "pi");
    assert_eq!(body["backend"]["location"]["kind"], "local");
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
    assert_eq!(pi["capabilities"]["session_agent_config"], true);
    assert_eq!(acp["capabilities"]["cancel"], true);
    assert_eq!(acp["capabilities"]["permission_requests"], true);
    assert_eq!(acp["capabilities"]["session_agent_config"], false);
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
    let backend = Arc::new(
        MockBackendAdapter::new(support::default_backend_outputs())
            .with_models(vec![codex_model("gpt-5.4", Some("high"))]),
    );
    let runtime = Runtime::new(store.clone(), backend.clone());
    let app = velad::build_app(
        velad::ApiState::new(store, runtime).with_codex_backend(Some("gpt-5.4".to_string())),
    );

    let (status, body) = get_json(app.clone(), "/api/v1/backends/codex").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["backend"]["kind"], "codex");
    assert_eq!(body["backend"]["backend_type"], "codex");
    assert_eq!(body["backend"]["capabilities"]["usage_snapshot"], true);
    assert_eq!(body["backend"]["models"][0]["id"], "gpt-5.4");
    assert_eq!(body["backend"]["diagnostics"]["model_source"], "discovered");

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
async fn codex_backend_without_discovered_models_is_an_error_snapshot() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(support::default_backend_outputs()));
    let runtime = Runtime::new(store.clone(), backend);
    let app = velad::build_app(velad::ApiState::new(store, runtime).with_codex_backend(None));

    let (status, body) = get_json(app, "/api/v1/backends/codex").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["backend"]["kind"], "codex");
    assert_eq!(body["backend"]["status"], "error");
    assert!(body["backend"]["models"].as_array().unwrap().is_empty());
    assert_eq!(body["backend"]["diagnostics"]["model_source"], "none");
    assert!(
        body["backend"]["status_message"]
            .as_str()
            .unwrap()
            .contains("no models discovered")
    );
}

#[tokio::test]
async fn vela_engine_backend_settings_are_stored_without_echoing_secret() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(
        MockBackendAdapter::new(support::default_backend_outputs())
            .with_models(vec![codex_model("gpt-local", Some("medium"))]),
    );
    let runtime = Runtime::new(store.clone(), backend);
    let app = velad::build_app(velad::ApiState::new(store, runtime).with_vela_engine_backend(None));

    let (status, body) = json_request(
        app.clone(),
        Method::PATCH,
        "/api/v1/backends/vela_engine/settings",
        json!({
            "endpoint": " https://example.test/v1 ",
            "api_key": " secret ",
            "model": " gpt-local "
        }),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["backend"], "vela_engine");
    assert_eq!(body["settings"]["endpoint"], "https://example.test/v1");
    assert_eq!(body["settings"]["model"], "gpt-local");
    assert_eq!(body["settings"]["api_key_set"], true);
    assert!(body["settings"].get("api_key").is_none());
    assert_eq!(body["status"], "configured");

    let (status, body) = get_json(app.clone(), "/api/v1/backends/vela_engine/settings").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["settings"]["api_key_set"], true);
    assert!(body["settings"].get("api_key").is_none());

    let (status, body) = get_json(app, "/api/v1/backends/vela_engine").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["backend"]["kind"], "vela_engine");
    assert_eq!(body["backend"]["status"], "available");
    assert_eq!(body["backend"]["models"][0]["id"], "gpt-local");
}

#[tokio::test]
async fn codex_backend_usage_reports_needs_auth_without_auth_file() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(
        MockBackendAdapter::new(support::default_backend_outputs())
            .with_models(vec![codex_model("gpt-5.4", Some("high"))]),
    );
    let runtime = Runtime::new(store.clone(), backend);
    let home = tempfile::tempdir().expect("home");
    let app = velad::build_app(
        velad::ApiState::new(store, runtime)
            .with_codex_backend(Some("gpt-5.4".to_string()))
            .with_backend_usage_test_context(
                std::collections::HashMap::new(),
                Some(home.path().to_path_buf()),
            ),
    );

    let (status, body) = get_json(app, "/api/v1/backends/codex/usage").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["schema"], "velad.backend_usage.v1");
    assert_eq!(body["backend"], "codex");
    assert_eq!(body["backend_type"], "codex");
    assert_eq!(body["status"], "needs_auth");
    assert_eq!(body["summary"]["label"], "需要登录 Codex");
    assert_eq!(body["profiles"][0]["profile_id"], "default");
}

#[tokio::test]
async fn backend_usage_is_unsupported_for_non_usage_backends() {
    let app = test_app().await;

    let (status, body) = get_json(app, "/api/v1/backends/pi/usage").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["schema"], "velad.backend_usage.v1");
    assert_eq!(body["backend"], "pi");
    assert_eq!(body["backend_type"], "pi");
    assert_eq!(body["status"], "unsupported");
}

#[tokio::test]
async fn codex_backend_snapshot_uses_discovered_models_and_reasoning_options() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(
        MockBackendAdapter::new(support::default_backend_outputs())
            .with_models(vec![codex_model("gpt-5.4", Some("high"))]),
    );
    let runtime = Runtime::new(store.clone(), backend);
    let app = velad::build_app(velad::ApiState::new(store, runtime).with_codex_backend(None));

    let (status, body) = get_json(app.clone(), "/api/v1/backends/codex").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["backend"]["kind"], "codex");
    assert_eq!(body["backend"]["status"], "available");
    assert_eq!(body["backend"]["models"][0]["id"], "gpt-5.4");
    assert!(
        body["backend"]["models"][0]["reasoning_efforts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|option| option["id"] == "high" && option["is_default"] == true)
    );
    assert_eq!(body["backend"]["diagnostics"]["model_source"], "discovered");

    let (status, created) = json_request(
        app,
        Method::POST,
        "/api/v1/sessions",
        json!({
            "backend": "codex",
            "working_directory": "/tmp/codex-project",
            "agent_config": {
                "permission_mode": "auto"
            }
        }),
        Some("ses-codex-discovered-default"),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["session"]["agent_config"]["model"], "gpt-5.4");
    assert_eq!(
        created["session"]["agent_config"]["reasoning_effort"],
        "high"
    );
}

#[tokio::test]
async fn codex_configured_default_only_marks_one_discovered_model_as_default() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(
        MockBackendAdapter::new(support::default_backend_outputs()).with_models(vec![
            codex_model("gpt-5.4-mini", Some("medium")),
            codex_model("gpt-5.4", Some("high")),
        ]),
    );
    let runtime = Runtime::new(store.clone(), backend);
    let app = velad::build_app(
        velad::ApiState::new(store, runtime).with_codex_backend(Some("gpt-5.4".to_string())),
    );

    let (status, body) = get_json(app, "/api/v1/backends/codex").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["backend"]["status"], "available");
    let defaults = body["backend"]["models"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|model| model["is_default"] == true)
        .map(|model| model["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(defaults, vec!["gpt-5.4"]);
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
    assert_eq!(
        body["backend"]["diagnostics"]["error"]["code"],
        "model_discovery_failed"
    );
    assert!(
        body["backend"]["diagnostics"]["error"]["message"]
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
    let backend = Arc::new(
        MockBackendAdapter::new(support::default_backend_outputs())
            .with_models(vec![codex_model("gpt-5.4", Some("high"))]),
    );
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
    let backend = Arc::new(
        MockBackendAdapter::new(support::default_backend_outputs())
            .with_models(vec![codex_model("legacy-model", Some("medium"))]),
    );
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
