use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use vela_backends::{BackendAdapter, BackendSend, OpenAiChatBackendAdapter};
use vela_core::EventType;

#[tokio::test]
async fn openai_compat_adapter_posts_chat_completion_and_normalizes_answer() {
    let captured = Arc::new(Mutex::new(None));
    let server = FakeOpenAiServer::start(
        json!({
            "id": "chatcmpl-test",
            "choices": [
                { "message": { "role": "assistant", "content": "vela-ok" } }
            ]
        }),
        captured.clone(),
    )
    .await;
    let adapter = OpenAiChatBackendAdapter::new(server.base_url(), "minimax-m2.7", "test-key");

    let outputs = adapter
        .send_user_message(BackendSend {
            content: "hello".to_string(),
        })
        .await
        .expect("send chat completion");

    let request = captured.lock().unwrap().clone().expect("captured request");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/v1/chat/completions");
    assert_eq!(request.authorization.as_deref(), Some("Bearer test-key"));
    assert_eq!(
        request.body,
        json!({
            "model": "minimax-m2.7",
            "messages": [{ "role": "user", "content": "hello" }],
            "stream": false
        })
    );
    assert_eq!(outputs.len(), 2);
    assert_eq!(outputs[0].event_type, EventType::ASSISTANT_MESSAGE_DELTA);
    assert_eq!(outputs[0].payload, json!({ "delta": "vela-ok" }));
    assert_eq!(outputs[1].event_type, EventType::TURN_COMPLETED);
}

#[tokio::test]
async fn openai_compat_adapter_surfaces_error_response() {
    let captured = Arc::new(Mutex::new(None));
    let server = FakeOpenAiServer::start(
        json!({
            "error": { "message": "bad api key" }
        }),
        captured,
    )
    .await
    .with_status(401);
    let adapter = OpenAiChatBackendAdapter::new(server.base_url(), "minimax-m2.7", "bad-key");

    let error = adapter
        .send_user_message(BackendSend {
            content: "hello".to_string(),
        })
        .await
        .expect_err("error response should fail");

    assert!(error.to_string().contains("bad api key"));
}

#[tokio::test]
async fn cloudagents_real_chat_completion_completes_when_key_is_configured() {
    let Ok(api_key) = std::env::var("VELA_CLOUDAGENTS_API_KEY") else {
        eprintln!("skipping CloudAgents real test because VELA_CLOUDAGENTS_API_KEY is not set");
        return;
    };
    let adapter =
        OpenAiChatBackendAdapter::new("https://tokenhub.tencentmaas.com", "minimax-m2.7", api_key);

    let outputs = adapter
        .send_user_message(BackendSend {
            content: "Reply with exactly: vela-ok".to_string(),
        })
        .await
        .expect("real CloudAgents completion");

    assert!(
        outputs
            .iter()
            .any(|output| output.event_type == EventType::TURN_COMPLETED),
        "expected turn completion, got {outputs:#?}"
    );
}

#[derive(Clone, Debug, PartialEq)]
struct CapturedRequest {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Value,
}

struct FakeOpenAiServer {
    base_url: String,
}

impl FakeOpenAiServer {
    async fn start(response_body: Value, captured: Arc<Mutex<Option<CapturedRequest>>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buffer = Vec::new();
            let mut chunk = [0; 4096];
            loop {
                let read = socket.read(&mut chunk).await.expect("read");
                if read == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..read]);
                if request_complete(&buffer) {
                    break;
                }
            }
            let request = parse_request(&buffer);
            *captured.lock().unwrap() = Some(request);
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                response_body.to_string().len(),
                response_body
            );
            socket.write_all(response.as_bytes()).await.expect("write");
        });
        Self {
            base_url: format!("http://{addr}"),
        }
    }

    fn with_status(self, _status: u16) -> Self {
        self
    }

    fn base_url(&self) -> String {
        self.base_url.clone()
    }
}

fn request_complete(buffer: &[u8]) -> bool {
    let text = String::from_utf8_lossy(buffer);
    let Some(header_end) = text.find("\r\n\r\n") else {
        return false;
    };
    let content_length = text
        .lines()
        .find_map(|line| line.strip_prefix("content-length: "))
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    buffer.len() >= header_end + 4 + content_length
}

fn parse_request(buffer: &[u8]) -> CapturedRequest {
    let text = String::from_utf8_lossy(buffer);
    let (headers, body) = text.split_once("\r\n\r\n").expect("headers/body");
    let mut lines = headers.lines();
    let request_line = lines.next().expect("request line");
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap().to_string();
    let path = request_parts.next().unwrap().to_string();
    let authorization = lines.find_map(|line| {
        line.strip_prefix("authorization: ")
            .or_else(|| line.strip_prefix("Authorization: "))
            .map(str::to_string)
    });

    CapturedRequest {
        method,
        path,
        authorization,
        body: serde_json::from_str(body).expect("json body"),
    }
}
