use serde_json::json;
use std::fs;
use vela_backends::{CodexAppServerHost, CodexStdioAppServerHost};

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
