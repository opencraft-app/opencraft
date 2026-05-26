use super::*;

fn test_client() -> E2BClient {
    E2BClient {
        config: E2BClientConfig {
            domain: "example.com".to_string(),
            api_url: "https://api.example.com".to_string(),
            api_key: "key".to_string(),
            envd_port: DEFAULT_ENVD_PORT,
            envd_user: "user".to_string(),
            request_timeout: Duration::from_secs(30),
        },
        http_client: Client::builder().build().unwrap(),
    }
}

#[test]
fn connect_stream_decodes_stdout_and_end() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&connect_envelope(
        serde_json::to_vec(&serde_json::json!({
            "event": {"data": {"stdout": STANDARD.encode("hello\n")}}
        }))
        .unwrap()
        .as_slice(),
        0,
    ));
    bytes.extend_from_slice(&connect_envelope(
        serde_json::to_vec(&serde_json::json!({
            "event": {"end": {"exitCode": 0, "exited": true, "status": "done"}}
        }))
        .unwrap()
        .as_slice(),
        0,
    ));

    let result = read_connect_command_stream(&bytes).unwrap();
    assert_eq!(result.stdout, "hello\n");
    assert_eq!(result.exit_code, 0);
    assert!(result.exited);
}

#[test]
fn workspace_file_upload_command_writes_base64_payload_to_target_path() {
    let command = workspace_file_upload_command(
        "/workspace/inputs/docs",
        "/workspace/inputs/docs/upload-check.txt",
        b"hello\n",
    );

    assert!(command.contains("mkdir -p"));
    assert!(command.contains("/workspace/inputs/docs"));
    assert!(command.contains("printf %s"));
    assert!(command.contains("| base64 -d >"));
    assert!(command.contains("/workspace/inputs/docs/upload-check.txt"));
    assert!(command.contains("aGVsbG8K"));
    assert!(command.contains("test -f"));
}

#[test]
fn connect_stream_handles_start_and_end_without_exit_code() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&connect_envelope(
        serde_json::to_vec(&serde_json::json!({
            "event": {"start": {"pid": 123}}
        }))
        .unwrap()
        .as_slice(),
        0,
    ));
    bytes.extend_from_slice(&connect_envelope(
        serde_json::to_vec(&serde_json::json!({
            "event": {"data": {"stdout": STANDARD.encode("hello\n")}}
        }))
        .unwrap()
        .as_slice(),
        0,
    ));
    bytes.extend_from_slice(&connect_envelope(
        serde_json::to_vec(&serde_json::json!({
            "event": {"end": {"exited": true, "status": "exit status 0"}}
        }))
        .unwrap()
        .as_slice(),
        0,
    ));
    bytes.extend_from_slice(&connect_envelope(b"{}", 0b0000_0010));

    let result = read_connect_command_stream(&bytes).unwrap();
    assert_eq!(result.stdout, "hello\n");
    assert_eq!(result.exit_code, 0);
    assert_eq!(result.status, "exit status 0");
    assert!(result.exited);
}

#[test]
fn connect_stream_returns_non_zero_exit_as_result() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&connect_envelope(
        serde_json::to_vec(&serde_json::json!({
            "event": {"data": {"stderr": STANDARD.encode("boom\n")}}
        }))
        .unwrap()
        .as_slice(),
        0,
    ));
    bytes.extend_from_slice(&connect_envelope(
        serde_json::to_vec(&serde_json::json!({
            "event": {"end": {"exited": true, "status": "exit status 1", "error": "exit status 1"}}
        }))
        .unwrap()
        .as_slice(),
        0,
    ));

    let result = read_connect_command_stream(&bytes).unwrap();
    assert_eq!(result.stderr, "boom\n");
    assert_eq!(result.exit_code, 1);
    assert_eq!(result.status, "exit status 1");
    assert!(result.exited);
}

#[test]
fn session_ids_are_prefixed() {
    assert!(session_id().starts_with("session_"));
}

#[test]
fn sandbox_host_port_parser_accepts_common_addr_forms() {
    assert_eq!(parse_host_port("127.0.0.1:19091"), Some(19091));
    assert_eq!(parse_host_port("0.0.0.0:19091"), Some(19091));
    assert_eq!(parse_host_port("[::1]:19091"), Some(19091));
    assert_eq!(parse_host_port("bad"), None);
}

#[test]
fn sandbox_host_probe_addr_maps_unspecified_bind_addr_to_loopback() {
    assert_eq!(sandbox_host_probe_addr("0.0.0.0:19091"), "127.0.0.1:19091");
    assert_eq!(sandbox_host_probe_addr("[::]:19091"), "127.0.0.1:19091");
    assert_eq!(
        sandbox_host_probe_addr("127.0.0.1:19091"),
        "127.0.0.1:19091"
    );
}

#[test]
fn sandbox_port_url_uses_requested_port() {
    let client = test_client();
    let sandbox = E2BSandbox {
        sandbox_id: "sbx_1".to_string(),
        envd_access_token: "token".to_string(),
        traffic_access_token: "traffic-token".to_string(),
        domain: "example.com".to_string(),
    };
    assert_eq!(
        client.sandbox_port_url(&sandbox, 19091),
        "https://19091-sbx_1.example.com"
    );
}

#[test]
fn sandbox_http_url_includes_access_token_for_proxy_auth() {
    let client = test_client();
    let sandbox = E2BSandbox {
        sandbox_id: "sbx_1".to_string(),
        envd_access_token: "token".to_string(),
        traffic_access_token: "traffic-token".to_string(),
        domain: "example.com".to_string(),
    };
    assert_eq!(
        client
            .sandbox_http_url(&sandbox, 19091, "/v1/native")
            .unwrap(),
        "https://19091-sbx_1.example.com/v1/native?access_token=traffic-token"
    );
}

#[test]
fn resolve_path_maps_workspace_absolute_paths() {
    let sandbox = SessionSandbox {
        workspace_root: "/workspace/session_1".to_string(),
        local_workspace_root: PathBuf::from("/Users/demo/repo"),
        command_prefix: None,
        shutdown_command: None,
        native_host_ready: Mutex::new(false),
        inner: Mutex::new(SessionSandboxInner {
            client: E2BClient {
                config: E2BClientConfig {
                    domain: "example.com".to_string(),
                    api_url: "https://api.example.com".to_string(),
                    api_key: "key".to_string(),
                    envd_port: DEFAULT_ENVD_PORT,
                    envd_user: "user".to_string(),
                    request_timeout: Duration::from_secs(30),
                },
                http_client: Client::builder().build().unwrap(),
            },
            sandbox: E2BSandbox {
                sandbox_id: "sandbox".to_string(),
                envd_access_token: "token".to_string(),
                traffic_access_token: "traffic-token".to_string(),
                domain: "example.com".to_string(),
            },
        }),
    };

    assert_eq!(
        sandbox
            .resolve_path("/Users/demo/repo/src/main.rs")
            .unwrap(),
        "/workspace/session_1/src/main.rs"
    );
    assert_eq!(
        sandbox.resolve_path("src/main.rs").unwrap(),
        "/workspace/session_1/src/main.rs"
    );
    assert_eq!(
        sandbox.resolve_path("/tmp/data.txt").unwrap(),
        "/tmp/data.txt"
    );
}

#[tokio::test]
async fn sync_active_session_sandbox_files_reports_no_active_sandbox() {
    let synced = sync_active_session_sandbox_files(Path::new("/tmp/no-active-sandbox"), &[]).await;
    assert!(!synced.unwrap());
}
