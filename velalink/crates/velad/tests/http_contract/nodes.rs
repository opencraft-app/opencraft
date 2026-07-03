use super::*;
use chrono::Utc;
use std::sync::Mutex;

#[tokio::test]
async fn node_providers_expose_ssh_as_a_connector_not_an_agent_backend() {
    let app = test_app().await;

    let (status, body) = get_json(app, "/api/v1/node-providers").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["schema"], "velad.node_providers.v1");
    assert_eq!(body["providers"][0]["id"], "ssh");
    assert_eq!(body["providers"][0]["auth_methods"][0], "password");
    assert_eq!(body["providers"][0]["secret_storage"], "local_os_keyring");
    assert_eq!(
        body["providers"][0]["capabilities"]["managed_remote_runtime"],
        true
    );
    assert_eq!(
        body["providers"][0]["target_constraints"]["arch"][0],
        "x86_64"
    );
}

#[tokio::test]
async fn ssh_node_password_is_write_only_and_stored_outside_sqlite() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let secrets = Arc::new(velad::runtime_targets::MemoryNodeSecretStore::default());
    let backend = Arc::new(MockBackendAdapter::new(support::default_backend_outputs()));
    let runtime = Runtime::new(store.clone(), backend);
    let app = velad::build_app(
        velad::ApiState::new(store.clone(), runtime).with_node_secret_store(secrets.clone()),
    );

    let (status, body) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/nodes",
        json!({
            "provider": "ssh",
            "display_name": "Dev Box",
            "ssh": {
                "host": " 192.0.2.10 ",
                "port": 22,
                "username": " skip "
            },
            "auth": {
                "method": "password",
                "password": " top-secret "
            },
            "target": {
                "os": "linux",
                "arch": "amd64"
            }
        }),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["schema"], "velad.nodes.v1");
    assert_eq!(body["node"]["display_name"], "Dev Box");
    assert_eq!(body["node"]["ssh"]["host"], "192.0.2.10");
    assert_eq!(body["node"]["ssh"]["username"], "skip");
    assert_eq!(body["node"]["target"]["arch"], "x86_64");
    assert_eq!(body["node"]["auth"]["password_configured"], true);
    assert!(body["node"]["auth"].get("password").is_none());

    let secret_ref = body["node"]["auth"]["secret_ref"]
        .as_str()
        .expect("secret ref");
    assert_eq!(secrets.password(secret_ref).as_deref(), Some("top-secret"));

    let nodes = store.list_nodes().await.expect("stored nodes");
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0].config["ssh"]["host"], "192.0.2.10");
    assert_eq!(nodes[0].config["target"]["arch"], "x86_64");
    assert!(!nodes[0].config.to_string().contains("top-secret"));

    let (status, listed) = get_json(app, "/api/v1/nodes").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["nodes"][0]["auth"]["password_configured"], true);
    assert!(listed["nodes"][0]["auth"].get("password").is_none());
}

#[tokio::test]
async fn runtime_targets_include_local_and_configured_remote_nodes() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let secrets = Arc::new(velad::runtime_targets::MemoryNodeSecretStore::default());
    let backend = Arc::new(MockBackendAdapter::new(support::default_backend_outputs()));
    let runtime = Runtime::new(store.clone(), backend);
    let app = velad::build_app(
        velad::ApiState::new(store, runtime).with_node_secret_store(secrets.clone()),
    );

    let (status, _) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/nodes",
        json!({
            "provider": "ssh",
            "ssh": {
                "host": "dev.example.test",
                "username": "skip"
            },
            "auth": {
                "method": "password",
                "password": "secret"
            }
        }),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, body) = get_json(app, "/api/v1/runtime-targets").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["schema"], "velad.runtime_targets.v1");
    assert_eq!(body["targets"][0]["id"], "local");
    assert_eq!(body["targets"][0]["status"], "connected");
    assert_eq!(body["targets"][1]["kind"], "remote");
    assert_eq!(body["targets"][1]["provider"], "ssh");
    assert_eq!(body["targets"][1]["status"], "disconnected");
    assert_eq!(
        body["targets"][1]["compatibility"]["version_policy"],
        "exact"
    );
}

#[tokio::test]
async fn runtime_target_connect_uses_stored_secret_and_projects_ready_state() {
    let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
    let secrets = Arc::new(velad::runtime_targets::MemoryNodeSecretStore::default());
    let connector = Arc::new(RecordingRuntimeTargetConnector::default());
    let manager = Arc::new(velad::runtime_targets::RuntimeTargetManager::new(
        connector.clone(),
    ));
    let backend = Arc::new(MockBackendAdapter::new(support::default_backend_outputs()));
    let runtime = Runtime::new(store.clone(), backend);
    let app = velad::build_app(
        velad::ApiState::new(store, runtime)
            .with_node_secret_store(secrets.clone())
            .with_runtime_target_manager(manager),
    );

    let (status, created) = json_request(
        app.clone(),
        Method::POST,
        "/api/v1/nodes",
        json!({
            "provider": "ssh",
            "display_name": "Remote Dev",
            "ssh": {
                "host": "dev.example.test",
                "username": "skip"
            },
            "auth": {
                "method": "password",
                "password": "secret"
            }
        }),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let node_id = created["node"]["id"].as_str().expect("node id");
    let target_path = format!("/api/v1/runtime-targets/target:{node_id}/connect");

    let (status, connected) =
        json_request(app.clone(), Method::POST, &target_path, json!({}), None).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(connected["target"]["status"], "ready");
    assert_eq!(
        connected["target"]["transport"]["api_base_url"],
        "http://127.0.0.1:49152/api/v1"
    );
    assert_eq!(
        connector.passwords.lock().expect("passwords").as_slice(),
        ["secret"]
    );

    let (status, targets) = get_json(app.clone(), "/api/v1/runtime-targets").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(targets["targets"][1]["status"], "ready");

    let disconnect_path = format!("/api/v1/runtime-targets/target:{node_id}/disconnect");
    let (status, disconnected) =
        json_request(app, Method::POST, &disconnect_path, json!({}), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(disconnected["target"]["status"], "disconnected");
}

#[tokio::test]
async fn ssh_nodes_reject_unsupported_remote_arch() {
    let app = test_app().await;

    let (status, body) = json_request(
        app,
        Method::POST,
        "/api/v1/nodes",
        json!({
            "provider": "ssh",
            "ssh": {
                "host": "dev.example.test",
                "username": "skip"
            },
            "auth": {
                "method": "password",
                "password": "secret"
            },
            "target": {
                "os": "linux",
                "arch": "aarch64"
            }
        }),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "unsupported_node_arch");
}

#[derive(Default)]
struct RecordingRuntimeTargetConnector {
    passwords: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl velad::runtime_targets::RuntimeTargetConnector for RecordingRuntimeTargetConnector {
    async fn connect(
        &self,
        node: vela_store::StoredNode,
        password: String,
    ) -> Result<
        velad::runtime_targets::ConnectedRuntimeTarget,
        velad::runtime_targets::RuntimeTargetError,
    > {
        self.passwords.lock().expect("passwords").push(password);
        Ok(velad::runtime_targets::ConnectedRuntimeTarget {
            snapshot: velad::runtime_targets::RuntimeTargetSnapshot {
                id: velad::runtime_targets::target_id_for_node(&node.node_id),
                kind: "remote",
                provider: node.provider,
                node_id: Some(node.node_id),
                display_name: node.display_name,
                status: "ready".to_string(),
                generation: 1,
                local_api_base_url: Some("http://127.0.0.1:49152/api/v1".to_string()),
                remote_listen_addr: Some("127.0.0.1:49321".to_string()),
                last_seen_at: Some(Utc::now()),
                last_error: None,
                runtime_protocol: Some("velad.local.v1".to_string()),
                api_protocol: Some("velachat.v1".to_string()),
                version: Some(env!("CARGO_PKG_VERSION").to_string()),
            },
            handle: Arc::new(velad::runtime_targets::NoopRuntimeTargetHandle),
        })
    }
}
