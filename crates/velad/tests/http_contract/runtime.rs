use super::*;

#[tokio::test]
async fn runtime_info_exposes_local_runtime_contract() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(support::default_backend_outputs()));
    let runtime = Runtime::new(store.clone(), backend);
    let app = velad::build_app(
        velad::ApiState::new(store, runtime)
            .with_runtime_info(velad::LocalRuntimeInfo::new("127.0.0.1:49321")),
    );

    let (status, body) = get_json(app, "/api/v1/runtime-info").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["type"], "velad.ready");
    assert_eq!(body["runtime_protocol"], "velad.local.v1");
    assert_eq!(body["api_protocol"], "velachat.v1");
    assert_eq!(body["listen_addr"], "127.0.0.1:49321");
    assert_eq!(body["api_base_url"], "http://127.0.0.1:49321/api/v1");
    assert!(body["pid"].as_u64().is_some());
    assert!(body["version"].as_str().is_some());
}

#[tokio::test]
async fn runtime_shutdown_requires_management_token_and_signals_acceptance() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(support::default_backend_outputs()));
    let runtime = Runtime::new(store.clone(), backend);
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::broadcast::channel::<()>(1);
    let app = velad::build_app(
        velad::ApiState::new(store, runtime)
            .with_management_token(Some("secret-token".to_string()))
            .with_shutdown_signal(shutdown_tx),
    );

    let (status, _) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/runtime/shutdown",
        json!({}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, _) = json_request_with_headers(
        app.clone(),
        Method::POST,
        "/api/v1/runtime/shutdown",
        json!({}),
        None,
        &[("authorization", "Bearer wrong-token")],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, body) = json_request_with_headers(
        app,
        Method::POST,
        "/api/v1/runtime/shutdown",
        json!({}),
        None,
        &[("authorization", "Bearer secret-token")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["accepted"], true);
    timeout(Duration::from_secs(1), shutdown_rx.recv())
        .await
        .expect("shutdown signal")
        .expect("shutdown broadcast");
}

#[tokio::test]
async fn runtime_shutdown_is_forbidden_without_management_token() {
    let app = test_app().await;

    let (status, body) = json_request(
        app,
        Method::POST,
        "/api/v1/runtime/shutdown",
        json!({}),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "management_token_required");
}
