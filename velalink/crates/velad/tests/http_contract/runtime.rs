use super::*;

#[tokio::test]
async fn openapi_documents_local_runtime_contract() {
    let openapi = include_str!("../../../../public/openapi/velachat.v1.yaml");

    assert!(openapi.contains("  /runtime-info:"));
    assert!(openapi.contains("  /runtime/shutdown:"));
    assert!(openapi.contains("operationId: getRuntimeInfo"));
    assert!(openapi.contains("operationId: shutdownRuntime"));
    assert!(openapi.contains("enum: [velad.local.v1]"));
    assert!(openapi.contains("enum: [velachat.v1]"));
}

#[tokio::test]
async fn runtime_info_exposes_local_and_business_protocols() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(support::default_backend_outputs()));
    let runtime = Runtime::new(store.clone(), backend);
    let (shutdown_tx, _shutdown_rx) = tokio::sync::watch::channel(false);
    let info = velad::local_runtime::ReadyEvent::new("127.0.0.1:49321".parse().unwrap());
    let app = velad::build_app(velad::ApiState::new(store, runtime).with_local_runtime(
        velad::local_runtime::LocalRuntimeState::new(info, Some("secret".to_string())),
        shutdown_tx,
    ));

    let (status, body) = get_json(app, "/api/v1/runtime-info").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["type"], "velad.ready");
    assert_eq!(body["runtime_protocol"], "velad.local.v1");
    assert_eq!(body["api_protocol"], "velachat.v1");
    assert_eq!(body["otel_protocol"], "otlp.http.json");
    assert_eq!(body["pid"], std::process::id());
    assert_eq!(body["listen_addr"], "127.0.0.1:49321");
    assert_eq!(body["api_base_url"], "http://127.0.0.1:49321/api/v1");
    assert_eq!(body["otel_base_url"], "http://127.0.0.1:49321");
    assert_eq!(
        body["observability_base_url"],
        "http://127.0.0.1:49321/api/v1/observability"
    );
    assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
}

#[tokio::test]
async fn runtime_shutdown_requires_configured_management_token() {
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
    assert_eq!(body["error"]["code"], "runtime_shutdown_unavailable");
}

#[tokio::test]
async fn runtime_shutdown_authorizes_token_and_triggers_shutdown() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let backend = Arc::new(MockBackendAdapter::new(support::default_backend_outputs()));
    let runtime = Runtime::new(store.clone(), backend);
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    let info = velad::local_runtime::ReadyEvent::new("127.0.0.1:49322".parse().unwrap());
    let app = velad::build_app(velad::ApiState::new(store, runtime).with_local_runtime(
        velad::local_runtime::LocalRuntimeState::new(info, Some("secret".to_string())),
        shutdown_tx,
    ));

    let (status, body) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/runtime/shutdown",
        json!({}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "runtime_shutdown_forbidden");

    let (status, body) = json_request_with_authorization(
        app.clone(),
        Method::POST,
        "/api/v1/runtime/shutdown",
        json!({}),
        "Bearer wrong",
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "runtime_shutdown_forbidden");

    let (status, body) = json_request_with_authorization(
        app,
        Method::POST,
        "/api/v1/runtime/shutdown",
        json!({}),
        "Bearer secret",
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["accepted"], true);
    shutdown_rx.changed().await.expect("shutdown signal");
    assert_eq!(*shutdown_rx.borrow(), true);
}
