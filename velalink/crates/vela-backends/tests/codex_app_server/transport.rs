use serde_json::json;
use std::fs;
use vela_backends::{CodexAppServerHost, CodexStdioAppServerHost};

#[test]
fn codex_stdio_host_uses_plain_app_server_launch_without_service_tier_override() {
    let host = CodexStdioAppServerHost::new("/tmp");

    assert_eq!(host.command, "codex");
    assert_eq!(host.args, vec!["app-server"]);
}

#[tokio::test]
async fn codex_stdio_transport_ignores_non_json_stdout_lines_without_dropping_pending_request() {
    let temp = tempfile::tempdir().expect("temp codex app-server dir");
    let script = temp.path().join("fake_codex_stdio.py");
    fs::write(
        &script,
        r#"
import json
import sys

print("Codex app-server booting", flush=True)

for line in sys.stdin:
    message = json.loads(line)
    print(json.dumps({
        "id": message.get("id"),
        "result": {
            "ok": True,
            "method": message.get("method")
        }
    }), flush=True)
"#,
    )
    .expect("write fake codex app-server");

    let host = CodexStdioAppServerHost {
        command: "python3".to_string(),
        args: vec!["-u".to_string(), script.to_string_lossy().to_string()],
        cwd: temp.path().to_string_lossy().to_string(),
    };
    let mut connection = host.connect().await.expect("connect fake codex app-server");

    let result = connection
        .request("initialize", json!({ "client": "vela" }))
        .await
        .expect("request should survive non-json stdout noise");

    assert_eq!(result["ok"], true);
    assert_eq!(result["method"], "initialize");
    connection
        .close()
        .await
        .expect("close fake codex app-server");
}

#[tokio::test]
async fn codex_stdio_transport_includes_stderr_when_app_server_exits_early() {
    let temp = tempfile::tempdir().expect("temp codex app-server dir");
    let script = temp.path().join("fake_codex_exit.py");
    fs::write(
        &script,
        r#"
import sys

print("error: unexpected argument '--stdio' found", file=sys.stderr, flush=True)
sys.exit(2)
"#,
    )
    .expect("write fake exiting codex app-server");

    let host = CodexStdioAppServerHost {
        command: "python3".to_string(),
        args: vec!["-u".to_string(), script.to_string_lossy().to_string()],
        cwd: temp.path().to_string_lossy().to_string(),
    };
    let mut connection = host.connect().await.expect("connect fake codex app-server");

    let error = connection
        .request("initialize", json!({ "client": "vela" }))
        .await
        .expect_err("early exit should fail the pending initialize request");
    let message = error.to_string();

    assert!(message.contains("Codex app-server closed while waiting for initialize"));
    assert!(message.contains("error: unexpected argument '--stdio' found"));
}
