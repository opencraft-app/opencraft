use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatCompletionsBridgeConfig {
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
}

#[cfg(feature = "codex-core-local")]
mod local {
    use std::{
        io::{Read, Write},
        net::{Shutdown, TcpListener, TcpStream},
        path::Path,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        thread,
        time::Duration,
    };

    use serde_json::{Value, json};
    use tempfile::TempDir;

    use super::ChatCompletionsBridgeConfig;

    pub struct ChatCompletionsBridge {
        codex_home: TempDir,
        provider_id: String,
        provider_name: String,
        model: String,
        server: Arc<BridgeServer>,
    }

    impl ChatCompletionsBridge {
        pub fn start(config: ChatCompletionsBridgeConfig) -> anyhow::Result<Self> {
            let listener = TcpListener::bind("127.0.0.1:0")?;
            let addr = listener.local_addr()?;
            let server = BridgeServer::spawn(listener, config.clone());
            let codex_home = tempfile::Builder::new()
                .prefix("vela-engine-codex-home-")
                .tempdir()?;
            let provider_id = "vela_chat_completions_bridge".to_string();
            let provider_name = "Vela Chat Completions Bridge".to_string();
            std::fs::write(
                codex_home.path().join("config.toml"),
                bridge_config_toml(&provider_id, &provider_name, addr, &config.model),
            )?;
            Ok(Self {
                codex_home,
                provider_id,
                provider_name,
                model: config.model,
                server,
            })
        }

        pub fn codex_home(&self) -> &Path {
            self.codex_home.path()
        }

        pub fn provider_id(&self) -> &str {
            &self.provider_id
        }

        pub fn provider_name(&self) -> &str {
            &self.provider_name
        }

        pub fn model(&self) -> &str {
            &self.model
        }
    }

    impl Drop for ChatCompletionsBridge {
        fn drop(&mut self) {
            self.server.shutdown.store(true, Ordering::Relaxed);
            let _ = TcpStream::connect(self.server.addr)
                .and_then(|stream| stream.shutdown(Shutdown::Both));
            if let Some(handle) = self
                .server
                .handle
                .lock()
                .ok()
                .and_then(|mut handle| handle.take())
            {
                let _ = handle.join();
            }
        }
    }

    struct BridgeServer {
        addr: std::net::SocketAddr,
        shutdown: AtomicBool,
        handle: std::sync::Mutex<Option<thread::JoinHandle<()>>>,
    }

    impl BridgeServer {
        fn spawn(listener: TcpListener, config: ChatCompletionsBridgeConfig) -> Arc<Self> {
            let server = Arc::new(Self {
                addr: listener
                    .local_addr()
                    .expect("listener should have an address"),
                shutdown: AtomicBool::new(false),
                handle: std::sync::Mutex::new(None),
            });
            let server_for_thread = Arc::clone(&server);
            let handle = thread::spawn(move || {
                for accepted in listener.incoming() {
                    if server_for_thread.shutdown.load(Ordering::Relaxed) {
                        break;
                    }
                    let Ok(stream) = accepted else {
                        break;
                    };
                    let _ = handle_connection(stream, &config);
                }
            });
            if let Ok(mut slot) = server.handle.lock() {
                *slot = Some(handle);
            }
            server
        }
    }

    struct HttpRequest {
        path: String,
        body: Vec<u8>,
    }

    fn handle_connection(
        mut stream: TcpStream,
        config: &ChatCompletionsBridgeConfig,
    ) -> std::io::Result<()> {
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        let request = read_http_request(&mut stream)?;
        if !request.path.ends_with("/responses") {
            write_http_response(
                &mut stream,
                404,
                "application/json",
                br#"{"error":"not_found"}"#,
            )?;
            return Ok(());
        }

        match forward_responses_request(&request.body, config) {
            Ok(answer) => write_http_response(
                &mut stream,
                200,
                "text/event-stream",
                responses_sse(&answer).as_bytes(),
            )?,
            Err(error) => write_http_response(
                &mut stream,
                200,
                "text/event-stream",
                response_failed_sse(&error).as_bytes(),
            )?,
        }
        Ok(())
    }

    fn read_http_request(stream: &mut TcpStream) -> std::io::Result<HttpRequest> {
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 4096];
        loop {
            let n = stream.read(&mut tmp)?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            if buf.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let header_end = buf
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|pos| pos + 4)
            .unwrap_or(buf.len());
        let headers = String::from_utf8_lossy(&buf[..header_end]);
        let request_line = headers.lines().next().unwrap_or_default();
        let path = request_line
            .split_whitespace()
            .nth(1)
            .unwrap_or("/")
            .to_string();
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        let mut body = buf[header_end..].to_vec();
        while body.len() < content_length {
            let n = stream.read(&mut tmp)?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&tmp[..n]);
        }
        body.truncate(content_length);
        Ok(HttpRequest { path, body })
    }

    fn write_http_response(
        stream: &mut TcpStream,
        status: u16,
        content_type: &str,
        body: &[u8],
    ) -> std::io::Result<()> {
        let reason = match status {
            200 => "OK",
            404 => "Not Found",
            _ => "Error",
        };
        write!(
            stream,
            "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        )?;
        stream.write_all(body)?;
        stream.flush()
    }

    fn forward_responses_request(
        body: &[u8],
        config: &ChatCompletionsBridgeConfig,
    ) -> Result<String, String> {
        let request: Value = serde_json::from_slice(body)
            .map_err(|err| format!("parse responses request: {err}"))?;
        let messages = responses_to_chat_messages(&request);
        if messages.is_empty() {
            return Err("responses request did not contain chat-compatible input".to_string());
        }
        let model = request
            .get("model")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&config.model);
        let upstream_url = format!("{}/chat/completions", config.endpoint.trim_end_matches('/'));
        let payload = json!({
            "model": model,
            "messages": messages,
            "stream": false,
        });
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|err| format!("build chat completions client: {err}"))?;
        let response = client
            .post(upstream_url)
            .bearer_auth(&config.api_key)
            .json(&payload)
            .send()
            .map_err(|err| format!("call chat completions provider: {err}"))?;
        let status = response.status();
        let response_body = response
            .text()
            .map_err(|err| format!("read chat completions response: {err}"))?;
        if !status.is_success() {
            return Err(format!(
                "chat completions provider returned HTTP {}: {}",
                status.as_u16(),
                response_body
            ));
        }
        let response_json: Value = serde_json::from_str(&response_body)
            .map_err(|err| format!("parse chat completions response: {err}"))?;
        response_json
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                "chat completions response did not contain assistant content".to_string()
            })
    }

    fn responses_to_chat_messages(request: &Value) -> Vec<Value> {
        let mut messages = Vec::new();
        if let Some(instructions) = request.get("instructions").and_then(Value::as_str)
            && !instructions.trim().is_empty()
        {
            messages.push(json!({"role": "system", "content": instructions}));
        }
        match request.get("input") {
            Some(Value::Array(items)) => {
                for item in items {
                    if let Some(message) = response_item_to_chat_message(item) {
                        messages.push(message);
                    }
                }
            }
            Some(Value::String(text)) if !text.trim().is_empty() => {
                messages.push(json!({"role": "user", "content": text}));
            }
            _ => {}
        }
        messages
    }

    fn response_item_to_chat_message(item: &Value) -> Option<Value> {
        let role = item
            .get("role")
            .and_then(Value::as_str)
            .filter(|value| *value == "assistant" || *value == "system")
            .unwrap_or("user");
        let text = collect_text(item);
        (!text.trim().is_empty()).then(|| json!({"role": role, "content": text}))
    }

    fn collect_text(value: &Value) -> String {
        match value {
            Value::String(text) => text.clone(),
            Value::Array(items) => items
                .iter()
                .map(collect_text)
                .filter(|text| !text.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
            Value::Object(map) => {
                if let Some(text) = map.get("text").and_then(Value::as_str) {
                    return text.to_string();
                }
                if let Some(text) = map.get("content").map(collect_text) {
                    return text;
                }
                String::new()
            }
            _ => String::new(),
        }
    }

    fn responses_sse(answer: &str) -> String {
        let response_id = "vela-chat-compat-response";
        let item_id = "vela-chat-compat-message";
        sse(vec![
            json!({"type": "response.created", "response": {"id": response_id}}),
            json!({
                "type": "response.output_item.done",
                "item": {
                    "type": "message",
                    "role": "assistant",
                    "id": item_id,
                    "content": [{"type": "output_text", "text": answer}],
                },
            }),
            json!({
                "type": "response.completed",
                "response": {
                    "id": response_id,
                    "usage": {
                        "input_tokens": 0,
                        "input_tokens_details": null,
                        "output_tokens": 0,
                        "output_tokens_details": null,
                        "total_tokens": 0,
                    },
                },
            }),
        ])
    }

    fn response_failed_sse(message: &str) -> String {
        sse(vec![json!({
            "type": "response.failed",
            "response": {
                "id": "vela-chat-compat-response",
                "error": {
                    "type": "server_error",
                    "code": "vela_chat_compat_failed",
                    "message": message,
                },
            },
        })])
    }

    fn sse(events: Vec<Value>) -> String {
        let mut out = String::new();
        for event in events {
            let kind = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("message");
            out.push_str("event: ");
            out.push_str(kind);
            out.push('\n');
            out.push_str("data: ");
            out.push_str(&event.to_string());
            out.push_str("\n\n");
        }
        out
    }

    fn bridge_config_toml(
        provider_id: &str,
        provider_name: &str,
        addr: std::net::SocketAddr,
        model: &str,
    ) -> String {
        format!(
            r#"
model = "{}"
model_provider = "{}"
approval_policy = "never"
sandbox_policy = "workspace-write"

[model_providers.{}]
name = "{}"
base_url = "http://{}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 300000
"#,
            toml_escape(model),
            toml_escape(provider_id),
            toml_escape(provider_id),
            toml_escape(provider_name),
            addr,
        )
    }

    fn toml_escape(value: &str) -> String {
        value.replace('\\', "\\\\").replace('"', "\\\"")
    }
}

#[cfg(feature = "codex-core-local")]
pub use local::ChatCompletionsBridge;
