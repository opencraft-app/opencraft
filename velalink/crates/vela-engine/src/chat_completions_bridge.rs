use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(not(feature = "codex-core-local"), allow(dead_code))]
pub struct ChatCompletionsBridgeConfig {
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
}

#[cfg(feature = "codex-core-local")]
mod local {
    use std::{
        collections::BTreeMap,
        hash::{Hash, Hasher},
        io::{Read, Write},
        net::{Shutdown, TcpListener, TcpStream},
        path::Path,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicU64, Ordering},
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

    static RESPONSE_COUNTER: AtomicU64 = AtomicU64::new(1);

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

        write_sse_response_headers(&mut stream)?;
        if let Err(error) = forward_responses_request_stream(&request.body, config, &mut stream) {
            let response_id = next_bridge_id("resp_failed");
            let _ = write_sse_event(&mut stream, response_failed_event(&response_id, &error));
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

    fn write_sse_response_headers(stream: &mut TcpStream) -> std::io::Result<()> {
        write!(
            stream,
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n"
        )?;
        stream.flush()
    }

    fn forward_responses_request_stream(
        body: &[u8],
        config: &ChatCompletionsBridgeConfig,
        downstream: &mut TcpStream,
    ) -> Result<(), String> {
        let request: Value = serde_json::from_slice(body)
            .map_err(|err| format!("parse responses request: {err}"))?;
        let response_id = next_bridge_id("resp");
        write_sse_event(downstream, response_created_event(&response_id))
            .map_err(|err| format!("write responses created event: {err}"))?;

        let catalog = ChatToolCatalog::from_responses_tools(array_field(&request, "tools")?)?;
        let messages = responses_to_chat_messages(&request, &catalog)?;
        if messages.is_empty() {
            return Err("responses request did not contain chat-compatible input".to_string());
        }
        let model = request
            .get("model")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&config.model);
        let upstream_url = format!("{}/chat/completions", config.endpoint.trim_end_matches('/'));
        let payload = chat_completions_payload(model, messages, &catalog, &request)?;
        let client = reqwest::blocking::Client::builder()
            .timeout(None::<Duration>)
            .connect_timeout(Duration::from_secs(30))
            .build()
            .map_err(|err| format!("build chat completions client: {err}"))?;
        let mut response = client
            .post(upstream_url)
            .bearer_auth(&config.api_key)
            .json(&payload)
            .send()
            .map_err(chat_completions_request_error)?;
        let status = response.status();
        if !status.is_success() {
            let response_body = response
                .text()
                .map_err(|err| format!("read chat completions error response: {err}"))?;
            return Err(format!(
                "chat completions provider returned HTTP {}: {}",
                status.as_u16(),
                response_body
            ));
        }

        let item_id = next_bridge_id("msg");
        let reasoning_id = next_bridge_id("reasoning");
        let mut text_started = false;
        let mut full_text = String::new();
        let mut reasoning_started = false;
        let mut full_reasoning = String::new();
        let mut tool_calls = BTreeMap::<u64, PendingToolCall>::new();
        let mut terminal_finish_reason = None::<String>;
        let mut upstream_done = false;
        let mut usage = None::<ChatUsage>;
        let mut buffer = String::new();
        let mut chunk = [0_u8; 8192];
        loop {
            let read = response
                .read(&mut chunk)
                .map_err(|err| format!("read chat completions stream: {err}"))?;
            if read == 0 {
                break;
            }
            buffer.push_str(&String::from_utf8_lossy(&chunk[..read]));
            while let Some(frame) = next_sse_frame(&mut buffer) {
                let Some(data) = sse_frame_data(&frame) else {
                    continue;
                };
                match chat_completions_stream_frame(&data)? {
                    ChatCompletionsStreamFrame::Delta(delta) => {
                        if let Some(frame_usage) = delta.usage {
                            usage = Some(frame_usage);
                        }
                        if !delta.reasoning.is_empty() {
                            if !reasoning_started {
                                write_sse_event(
                                    downstream,
                                    response_reasoning_item_added_event(&reasoning_id),
                                )
                                .map_err(|err| {
                                    format!(
                                        "write responses reasoning output_item.added event: {err}"
                                    )
                                })?;
                                reasoning_started = true;
                            }
                            full_reasoning.push_str(&delta.reasoning);
                            write_sse_event(
                                downstream,
                                response_reasoning_text_delta_event(
                                    &reasoning_id,
                                    &delta.reasoning,
                                ),
                            )
                            .map_err(|err| {
                                format!("write responses reasoning_text.delta event: {err}")
                            })?;
                        }
                        if !delta.content.is_empty() {
                            if !text_started {
                                write_sse_event(
                                    downstream,
                                    response_output_item_added_event(&item_id),
                                )
                                .map_err(|err| {
                                    format!("write responses output_item.added event: {err}")
                                })?;
                                write_sse_event(
                                    downstream,
                                    response_content_part_added_event(&item_id),
                                )
                                .map_err(|err| {
                                    format!("write responses content_part.added event: {err}")
                                })?;
                                text_started = true;
                            }
                            full_text.push_str(&delta.content);
                            write_sse_event(
                                downstream,
                                response_output_text_delta_event(&item_id, &delta.content),
                            )
                            .map_err(|err| {
                                format!("write responses output_text.delta event: {err}")
                            })?;
                        }
                        for tool_delta in delta.tool_calls {
                            tool_calls
                                .entry(tool_delta.index)
                                .or_insert_with(|| PendingToolCall::new(tool_delta.index))
                                .apply(tool_delta);
                        }
                        if let Some(finish_reason) = delta.finish_reason {
                            terminal_finish_reason = Some(finish_reason);
                        }
                    }
                    ChatCompletionsStreamFrame::Done => {
                        upstream_done = true;
                        break;
                    }
                    ChatCompletionsStreamFrame::Error(message) => {
                        return Err(format!("chat completions provider stream error: {message}"));
                    }
                    ChatCompletionsStreamFrame::Ignore => {}
                }
            }
            if upstream_done {
                break;
            }
        }

        if !upstream_done && terminal_finish_reason.is_none() {
            return Err("chat completions stream closed before [DONE]".to_string());
        }
        let finish_reason = terminal_finish_reason.as_deref().unwrap_or_else(|| {
            if tool_calls.is_empty() {
                "stop"
            } else {
                "tool_calls"
            }
        });
        if let Some(incomplete) = incomplete_event_for_finish_reason(&response_id, finish_reason) {
            write_sse_event(downstream, incomplete)
                .map_err(|err| format!("write responses incomplete event: {err}"))?;
            return Ok(());
        }
        if let Some(error) = failed_message_for_finish_reason(finish_reason) {
            return Err(error);
        }
        if full_text.trim().is_empty() && tool_calls.is_empty() && full_reasoning.trim().is_empty()
        {
            return Err(
                "chat completions stream did not contain assistant content or tool calls"
                    .to_string(),
            );
        }

        if reasoning_started {
            write_sse_event(
                downstream,
                response_reasoning_item_done_event(&reasoning_id, &full_reasoning),
            )
            .map_err(|err| format!("write responses reasoning output_item.done event: {err}"))?;
        }

        if text_started {
            write_sse_event(
                downstream,
                response_output_text_done_event(&item_id, &full_text),
            )
            .map_err(|err| format!("write responses output_text.done event: {err}"))?;
            write_sse_event(
                downstream,
                response_content_part_done_event(&item_id, &full_text),
            )
            .map_err(|err| format!("write responses content_part.done event: {err}"))?;
            write_sse_event(
                downstream,
                response_output_item_done_event(&item_id, &full_text),
            )
            .map_err(|err| format!("write responses output_item.done event: {err}"))?;
        }

        let mut emitted_tool_calls = false;
        for pending in tool_calls.into_values() {
            let event = response_tool_call_done_event(&catalog, pending)?;
            write_sse_event(downstream, event)
                .map_err(|err| format!("write responses tool output_item.done event: {err}"))?;
            emitted_tool_calls = true;
        }

        write_sse_event(
            downstream,
            response_completed_event(&response_id, !emitted_tool_calls, usage.as_ref()),
        )
        .map_err(|err| format!("write responses completed event: {err}"))?;
        Ok(())
    }

    fn chat_completions_request_error(err: reqwest::Error) -> String {
        let kind = if err.is_timeout() {
            "timed out".to_string()
        } else if err.is_connect() {
            "connection failed".to_string()
        } else if err.is_request() {
            "request failed before response".to_string()
        } else if err.is_body() {
            "request body failed".to_string()
        } else if err.is_decode() {
            "response decode failed".to_string()
        } else {
            "request failed".to_string()
        };
        format!("call chat completions provider {kind}: {err}")
    }

    #[derive(Debug, Default)]
    struct ChatStreamDelta {
        content: String,
        reasoning: String,
        tool_calls: Vec<ChatToolCallDelta>,
        finish_reason: Option<String>,
        usage: Option<ChatUsage>,
    }

    #[derive(Debug)]
    struct ChatToolCallDelta {
        index: u64,
        id: Option<String>,
        name: Option<String>,
        arguments: Option<String>,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct ChatUsage {
        input_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
    }

    #[derive(Debug)]
    enum ChatCompletionsStreamFrame {
        Delta(ChatStreamDelta),
        Done,
        Error(String),
        Ignore,
    }

    fn chat_completions_stream_frame(data: &str) -> Result<ChatCompletionsStreamFrame, String> {
        let data = data.trim();
        if data == "[DONE]" {
            return Ok(ChatCompletionsStreamFrame::Done);
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|err| format!("parse chat completions stream frame: {err}"))?;
        if let Some(error) = value.get("error") {
            return Ok(ChatCompletionsStreamFrame::Error(provider_error_message(
                error,
            )));
        }
        let usage = value.get("usage").and_then(chat_usage);
        let Some(choices) = value.get("choices").and_then(Value::as_array) else {
            if let Some(usage) = usage {
                return Ok(ChatCompletionsStreamFrame::Delta(ChatStreamDelta {
                    usage: Some(usage),
                    ..Default::default()
                }));
            }
            return Ok(ChatCompletionsStreamFrame::Ignore);
        };
        let mut delta = ChatStreamDelta {
            usage,
            ..Default::default()
        };
        for (choice_index, choice) in choices.iter().enumerate() {
            if let Some(finish_reason) = choice.get("finish_reason").and_then(Value::as_str) {
                delta.finish_reason = Some(finish_reason.to_string());
            }
            for source_key in ["delta", "message"] {
                let Some(source) = choice.get(source_key) else {
                    continue;
                };
                if let Some(content) = source.get("content") {
                    delta.content.push_str(&chat_content_text(content)?);
                }
                for reasoning_key in ["reasoning_content", "reasoning_text"] {
                    if let Some(reasoning) = source.get(reasoning_key).and_then(Value::as_str) {
                        delta.reasoning.push_str(reasoning);
                    }
                }
                if let Some(tool_calls) = source.get("tool_calls").and_then(Value::as_array) {
                    for (index, tool_call) in tool_calls.iter().enumerate() {
                        delta.tool_calls.push(chat_tool_call_delta(
                            tool_call,
                            u64::try_from(index).unwrap_or(u64::MAX),
                        )?);
                    }
                }
                if let Some(function_call) = source.get("function_call") {
                    delta.tool_calls.push(chat_function_call_delta(
                        function_call,
                        u64::try_from(choice_index).unwrap_or(u64::MAX),
                    )?);
                }
            }
        }
        if delta.content.is_empty()
            && delta.reasoning.is_empty()
            && delta.tool_calls.is_empty()
            && delta.finish_reason.is_none()
            && delta.usage.is_none()
        {
            Ok(ChatCompletionsStreamFrame::Ignore)
        } else {
            Ok(ChatCompletionsStreamFrame::Delta(delta))
        }
    }

    fn chat_usage(value: &Value) -> Option<ChatUsage> {
        Some(ChatUsage {
            input_tokens: value.get("prompt_tokens")?.as_u64()?,
            output_tokens: value.get("completion_tokens")?.as_u64()?,
            total_tokens: value.get("total_tokens")?.as_u64()?,
        })
    }

    fn provider_error_message(error: &Value) -> String {
        error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                error
                    .get("error")
                    .and_then(|nested| nested.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| error.to_string())
    }

    fn chat_tool_call_delta(
        value: &Value,
        fallback_index: u64,
    ) -> Result<ChatToolCallDelta, String> {
        let function = value.get("function").unwrap_or(value);
        Ok(ChatToolCallDelta {
            index: value
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(fallback_index),
            id: value.get("id").and_then(Value::as_str).map(str::to_string),
            name: function
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string),
            arguments: function
                .get("arguments")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }

    fn chat_function_call_delta(
        value: &Value,
        fallback_index: u64,
    ) -> Result<ChatToolCallDelta, String> {
        Ok(ChatToolCallDelta {
            index: fallback_index,
            id: None,
            name: value
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string),
            arguments: value
                .get("arguments")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }

    fn chat_content_text(value: &Value) -> Result<String, String> {
        match value {
            Value::Null => Ok(String::new()),
            Value::String(text) => Ok(text.clone()),
            Value::Array(items) => {
                let mut text = Vec::new();
                for item in items {
                    let Some(kind) = item.get("type").and_then(Value::as_str) else {
                        return Err("chat content array item missing type".to_string());
                    };
                    match kind {
                        "text" | "input_text" | "output_text" => {
                            if let Some(value) = item.get("text").and_then(Value::as_str) {
                                text.push(value.to_string());
                            }
                        }
                        _ => {
                            return Err(format!(
                                "chat content array item type {kind} cannot be represented as Responses text"
                            ));
                        }
                    }
                }
                Ok(text.join("\n"))
            }
            _ => Err("chat content must be a string or typed content array".to_string()),
        }
    }

    #[derive(Debug)]
    struct PendingToolCall {
        index: u64,
        id: Option<String>,
        name: Option<String>,
        arguments: String,
    }

    impl PendingToolCall {
        fn new(index: u64) -> Self {
            Self {
                index,
                id: None,
                name: None,
                arguments: String::new(),
            }
        }

        fn apply(&mut self, delta: ChatToolCallDelta) {
            if let Some(id) = delta.id {
                self.id = Some(id);
            }
            if let Some(name) = delta.name {
                self.name = Some(name);
            }
            if let Some(arguments) = delta.arguments {
                self.arguments.push_str(&arguments);
            }
        }
    }

    fn next_sse_frame(buffer: &mut String) -> Option<String> {
        let mut delimiter = None;
        for candidate in ["\r\n\r\n", "\n\n"] {
            if let Some(index) = buffer.find(candidate) {
                match delimiter {
                    Some((existing, _)) if existing <= index => {}
                    _ => delimiter = Some((index, candidate.len())),
                }
            }
        }
        let (index, delimiter_len) = delimiter?;
        let frame = buffer[..index].to_string();
        buffer.drain(..index + delimiter_len);
        Some(frame)
    }

    fn sse_frame_data(frame: &str) -> Option<String> {
        let data = frame
            .lines()
            .filter_map(|line| {
                let line = line.strip_suffix('\r').unwrap_or(line);
                line.strip_prefix("data:")
                    .map(|value| value.trim_start().to_string())
            })
            .collect::<Vec<_>>();
        (!data.is_empty()).then(|| data.join("\n"))
    }

    fn next_bridge_id(prefix: &str) -> String {
        let id = RESPONSE_COUNTER.fetch_add(1, Ordering::Relaxed);
        format!("vela_{prefix}_{id}")
    }

    fn array_field<'a>(value: &'a Value, key: &str) -> Result<&'a [Value], String> {
        match value.get(key) {
            Some(Value::Array(items)) => Ok(items.as_slice()),
            Some(_) => Err(format!("responses request field {key} must be an array")),
            None => Ok(&[]),
        }
    }

    fn chat_completions_payload(
        model: &str,
        messages: Vec<Value>,
        catalog: &ChatToolCatalog,
        request: &Value,
    ) -> Result<Value, String> {
        let mut payload = serde_json::Map::new();
        payload.insert("model".to_string(), Value::String(model.to_string()));
        payload.insert("messages".to_string(), Value::Array(messages));
        payload.insert("stream".to_string(), Value::Bool(true));
        if !catalog.tools.is_empty() {
            payload.insert("tools".to_string(), Value::Array(catalog.tools.clone()));
            if let Some(tool_choice) = chat_tool_choice(request.get("tool_choice"), catalog)? {
                payload.insert("tool_choice".to_string(), tool_choice);
            }
        }
        if request
            .get("parallel_tool_calls")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            payload.insert("parallel_tool_calls".to_string(), Value::Bool(true));
        }
        if let Some(effort) = request
            .get("reasoning")
            .and_then(|reasoning| reasoning.get("effort"))
            .and_then(Value::as_str)
        {
            payload.insert(
                "reasoning_effort".to_string(),
                Value::String(effort.to_string()),
            );
        }
        if let Some(response_format) = chat_response_format(request.get("text"))? {
            payload.insert("response_format".to_string(), response_format);
        }
        Ok(Value::Object(payload))
    }

    fn chat_tool_choice(
        tool_choice: Option<&Value>,
        catalog: &ChatToolCatalog,
    ) -> Result<Option<Value>, String> {
        let Some(tool_choice) = tool_choice else {
            return Ok(Some(Value::String("auto".to_string())));
        };
        match tool_choice {
            Value::Null => Ok(Some(Value::String("auto".to_string()))),
            Value::String(value) if value == "auto" || value == "none" || value == "required" => {
                Ok(Some(Value::String(value.clone())))
            }
            Value::Object(map) => {
                let Some(kind) = map.get("type").and_then(Value::as_str) else {
                    return Err("responses tool_choice object missing type".to_string());
                };
                if kind != "function" {
                    return Err(format!(
                        "responses tool_choice type {kind} is not supported"
                    ));
                }
                let Some(name) = map.get("name").and_then(Value::as_str) else {
                    return Err("responses function tool_choice missing name".to_string());
                };
                let namespace = map.get("namespace").and_then(Value::as_str);
                let Some(chat_name) = catalog.chat_name_for(namespace, name) else {
                    return Err(format!(
                        "responses tool_choice references unknown tool {name}"
                    ));
                };
                Ok(Some(json!({
                    "type": "function",
                    "function": {"name": chat_name},
                })))
            }
            _ => Err("responses tool_choice must be a string or function object".to_string()),
        }
    }

    fn chat_response_format(text: Option<&Value>) -> Result<Option<Value>, String> {
        let Some(text) = text else {
            return Ok(None);
        };
        let Some(format) = text.get("format") else {
            return Ok(None);
        };
        let format_type = format
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("json_schema");
        if format_type == "text" {
            return Ok(None);
        }
        if format_type != "json_schema" {
            return Err(format!(
                "responses text.format type {format_type} cannot be represented by Chat Completions"
            ));
        }
        let schema = format
            .get("schema")
            .cloned()
            .ok_or_else(|| "responses text.format missing schema".to_string())?;
        let name = format
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("vela_response");
        let strict = format
            .get("strict")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(Some(json!({
            "type": "json_schema",
            "json_schema": {
                "name": name,
                "strict": strict,
                "schema": schema,
            },
        })))
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum ResponsesToolKind {
        Function,
        Custom,
        ToolSearch,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct ToolMapping {
        name: String,
        namespace: Option<String>,
        kind: ResponsesToolKind,
    }

    #[derive(Debug, Default)]
    struct ChatToolCatalog {
        tools: Vec<Value>,
        by_chat_name: BTreeMap<String, ToolMapping>,
        by_response_name: BTreeMap<String, String>,
    }

    impl ChatToolCatalog {
        fn from_responses_tools(tools: &[Value]) -> Result<Self, String> {
            let mut catalog = Self::default();
            for tool in tools {
                let Some(kind) = tool.get("type").and_then(Value::as_str) else {
                    return Err("responses tool missing type".to_string());
                };
                match kind {
                    "function" => catalog.add_function(None, None, tool)?,
                    "namespace" => {
                        let namespace = required_string(tool, "name", "responses namespace tool")?;
                        let namespace_description =
                            optional_string(tool, "description").map(str::to_string);
                        let tools = required_array(tool, "tools", "responses namespace tool")?;
                        for nested in tools {
                            let nested_kind =
                                required_string(nested, "type", "responses namespace function")?;
                            if nested_kind != "function" {
                                return Err(format!(
                                    "responses namespace tool {namespace} contains unsupported nested tool type {nested_kind}"
                                ));
                            }
                            catalog.add_function(
                                Some(namespace),
                                namespace_description.as_deref(),
                                nested,
                            )?;
                        }
                    }
                    "custom" => catalog.add_custom(tool)?,
                    "tool_search" => catalog.add_tool_search(tool)?,
                    "web_search" | "image_generation" => {}
                    _ => return Err(format!("unsupported responses tool type {kind}")),
                }
            }
            Ok(catalog)
        }

        fn add_function(
            &mut self,
            namespace: Option<&str>,
            namespace_description: Option<&str>,
            tool: &Value,
        ) -> Result<(), String> {
            let name = required_string(tool, "name", "responses function tool")?;
            let chat_name = encode_chat_tool_name(namespace, name);
            let description =
                tool_description(namespace_description, optional_string(tool, "description"));
            let mut function = serde_json::Map::new();
            function.insert("name".to_string(), Value::String(chat_name.clone()));
            function.insert("description".to_string(), Value::String(description));
            function.insert(
                "parameters".to_string(),
                tool.get("parameters")
                    .cloned()
                    .unwrap_or_else(|| json!({"type": "object", "properties": {}})),
            );
            if tool.get("strict").and_then(Value::as_bool).unwrap_or(false) {
                function.insert("strict".to_string(), Value::Bool(true));
            }
            let mut outer = serde_json::Map::new();
            outer.insert("type".to_string(), Value::String("function".to_string()));
            outer.insert("function".to_string(), Value::Object(function));
            self.add_mapping(
                chat_name,
                name.to_string(),
                namespace.map(str::to_string),
                ResponsesToolKind::Function,
                Value::Object(outer),
            )
        }

        fn add_custom(&mut self, tool: &Value) -> Result<(), String> {
            let name = required_string(tool, "name", "responses custom tool")?;
            let chat_name = encode_chat_tool_name(None, name);
            let description = optional_string(tool, "description")
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("Freeform tool input.");
            self.add_mapping(
                chat_name.clone(),
                name.to_string(),
                None,
                ResponsesToolKind::Custom,
                json!({
                    "type": "function",
                    "function": {
                        "name": chat_name,
                        "description": description,
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "input": {"type": "string"}
                            },
                            "required": ["input"],
                            "additionalProperties": false
                        }
                    }
                }),
            )
        }

        fn add_tool_search(&mut self, tool: &Value) -> Result<(), String> {
            let chat_name = encode_chat_tool_name(None, "tool_search");
            self.add_mapping(
                chat_name.clone(),
                "tool_search".to_string(),
                None,
                ResponsesToolKind::ToolSearch,
                json!({
                    "type": "function",
                    "function": {
                        "name": chat_name,
                        "description": optional_string(tool, "description").unwrap_or("Search available tools."),
                        "parameters": tool.get("parameters").cloned().unwrap_or_else(|| {
                            json!({
                                "type": "object",
                                "properties": {
                                    "query": {"type": "string"},
                                    "limit": {"type": "integer"}
                                },
                                "required": ["query"]
                            })
                        })
                    }
                }),
            )
        }

        fn add_mapping(
            &mut self,
            chat_name: String,
            name: String,
            namespace: Option<String>,
            kind: ResponsesToolKind,
            chat_tool: Value,
        ) -> Result<(), String> {
            if self.by_chat_name.contains_key(&chat_name) {
                return Err(format!(
                    "duplicate chat tool name {chat_name} after Responses tool mapping"
                ));
            }
            let response_key = response_tool_key(namespace.as_deref(), &name);
            if self.by_response_name.contains_key(&response_key) {
                return Err(format!("duplicate responses tool {response_key}"));
            }
            self.tools.push(chat_tool);
            self.by_response_name
                .insert(response_key, chat_name.clone());
            self.by_chat_name.insert(
                chat_name,
                ToolMapping {
                    name,
                    namespace,
                    kind,
                },
            );
            Ok(())
        }

        fn chat_name_for(&self, namespace: Option<&str>, name: &str) -> Option<&str> {
            self.by_response_name
                .get(&response_tool_key(namespace, name))
                .map(String::as_str)
        }

        fn mapping_for_chat_name(&self, chat_name: &str) -> Option<&ToolMapping> {
            self.by_chat_name.get(chat_name)
        }
    }

    fn tool_description(namespace_description: Option<&str>, description: Option<&str>) -> String {
        match (
            namespace_description.filter(|value| !value.trim().is_empty()),
            description.filter(|value| !value.trim().is_empty()),
        ) {
            (Some(namespace_description), Some(description)) => {
                format!("{namespace_description}\n\n{description}")
            }
            (Some(namespace_description), None) => namespace_description.to_string(),
            (None, Some(description)) => description.to_string(),
            (None, None) => "Callable tool.".to_string(),
        }
    }

    fn response_tool_key(namespace: Option<&str>, name: &str) -> String {
        match namespace {
            Some(namespace) => format!("{namespace}\u{1f}{name}"),
            None => name.to_string(),
        }
    }

    fn encode_chat_tool_name(namespace: Option<&str>, name: &str) -> String {
        let raw = match namespace {
            Some(namespace) => format!("{namespace}__{name}"),
            None => name.to_string(),
        };
        let sanitized = raw
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                    ch
                } else {
                    '_'
                }
            })
            .collect::<String>();
        if !sanitized.is_empty() && sanitized.len() <= 64 {
            return sanitized;
        }
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        raw.hash(&mut hasher);
        format!("vela_tool_{:016x}", hasher.finish())
    }

    fn responses_to_chat_messages(
        request: &Value,
        catalog: &ChatToolCatalog,
    ) -> Result<Vec<Value>, String> {
        let mut messages = Vec::new();
        if let Some(instructions) = request.get("instructions").and_then(Value::as_str)
            && !instructions.trim().is_empty()
        {
            messages.push(json!({"role": "system", "content": instructions}));
        }
        match request.get("input") {
            Some(Value::Array(items)) => {
                for item in items {
                    if let Some(message) = response_item_to_chat_message(item, catalog)? {
                        messages.push(message);
                    }
                }
            }
            Some(Value::String(text)) if !text.trim().is_empty() => {
                messages.push(json!({"role": "user", "content": text}));
            }
            Some(Value::String(_)) | None => {}
            Some(_) => return Err("responses request input must be an array or string".to_string()),
        }
        Ok(messages)
    }

    fn response_item_to_chat_message(
        item: &Value,
        catalog: &ChatToolCatalog,
    ) -> Result<Option<Value>, String> {
        let Some(kind) = item.get("type").and_then(Value::as_str) else {
            return Err("responses input item missing type".to_string());
        };
        match kind {
            "message" => responses_message_to_chat_message(item).map(Some),
            "function_call" => response_function_call_to_chat_message(item, catalog).map(Some),
            "custom_tool_call" => {
                response_custom_tool_call_to_chat_message(item, catalog).map(Some)
            }
            "tool_search_call" => {
                response_tool_search_call_to_chat_message(item, catalog).map(Some)
            }
            "function_call_output" | "custom_tool_call_output" | "tool_search_output" => {
                response_tool_output_to_chat_message(item).map(Some)
            }
            "reasoning" => Ok(None),
            _ => Err(format!(
                "responses input item type {kind} cannot be represented by Chat Completions"
            )),
        }
    }

    fn responses_message_to_chat_message(item: &Value) -> Result<Value, String> {
        let responses_role = required_string(item, "role", "responses message")?;
        let role = match responses_role {
            "assistant" => "assistant",
            "user" => "user",
            "system" | "developer" => "system",
            _ => {
                return Err(format!(
                    "responses message role {responses_role} is not supported"
                ));
            }
        };
        let content = responses_content_to_chat_content(
            role,
            required_array(item, "content", "responses message")?,
        )?;
        Ok(json!({"role": role, "content": content}))
    }

    fn response_function_call_to_chat_message(
        item: &Value,
        catalog: &ChatToolCatalog,
    ) -> Result<Value, String> {
        let name = required_string(item, "name", "responses function_call")?;
        let namespace = optional_string(item, "namespace");
        let chat_name = catalog.chat_name_for(namespace, name).ok_or_else(|| {
            format!(
                "responses function_call references unknown tool {}",
                response_tool_key(namespace, name)
            )
        })?;
        let call_id = required_string(item, "call_id", "responses function_call")?;
        let arguments = required_string(item, "arguments", "responses function_call")?;
        Ok(json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": call_id,
                "type": "function",
                "function": {"name": chat_name, "arguments": arguments}
            }]
        }))
    }

    fn response_custom_tool_call_to_chat_message(
        item: &Value,
        catalog: &ChatToolCatalog,
    ) -> Result<Value, String> {
        let name = required_string(item, "name", "responses custom_tool_call")?;
        let chat_name = catalog
            .chat_name_for(None, name)
            .ok_or_else(|| format!("responses custom_tool_call references unknown tool {name}"))?;
        let call_id = required_string(item, "call_id", "responses custom_tool_call")?;
        let input = required_string(item, "input", "responses custom_tool_call")?;
        Ok(json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": call_id,
                "type": "function",
                "function": {"name": chat_name, "arguments": json!({"input": input}).to_string()}
            }]
        }))
    }

    fn response_tool_search_call_to_chat_message(
        item: &Value,
        catalog: &ChatToolCatalog,
    ) -> Result<Value, String> {
        let chat_name = catalog.chat_name_for(None, "tool_search").ok_or_else(|| {
            "responses tool_search_call references unavailable tool_search".to_string()
        })?;
        let call_id = required_string(item, "call_id", "responses tool_search_call")?;
        let arguments = item
            .get("arguments")
            .cloned()
            .ok_or_else(|| "responses tool_search_call missing arguments".to_string())?;
        Ok(json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": call_id,
                "type": "function",
                "function": {"name": chat_name, "arguments": arguments.to_string()}
            }]
        }))
    }

    fn response_tool_output_to_chat_message(item: &Value) -> Result<Value, String> {
        let call_id = required_string(item, "call_id", "responses tool output")?;
        let output = item
            .get("output")
            .ok_or_else(|| "responses tool output missing output".to_string())?;
        Ok(json!({
            "role": "tool",
            "tool_call_id": call_id,
            "content": response_tool_output_text(output)?,
        }))
    }

    fn responses_content_to_chat_content(role: &str, items: &[Value]) -> Result<Value, String> {
        let mut text_parts = Vec::new();
        let mut mixed_parts = Vec::new();
        let mut has_non_text = false;
        for item in items {
            let kind = required_string(item, "type", "responses content item")?;
            match kind {
                "input_text" | "output_text" => {
                    let text = required_string(item, "text", "responses text content item")?;
                    text_parts.push(text.to_string());
                    mixed_parts.push(json!({"type": "text", "text": text}));
                }
                "input_image" if role == "user" => {
                    let image_url =
                        required_string(item, "image_url", "responses image content item")?;
                    let mut image = json!({"url": image_url});
                    if let Some(detail) = optional_string(item, "detail") {
                        image["detail"] = Value::String(detail.to_string());
                    }
                    mixed_parts.push(json!({"type": "image_url", "image_url": image}));
                    has_non_text = true;
                }
                "input_image" => {
                    return Err(
                        "responses input_image content is only supported on user messages"
                            .to_string(),
                    );
                }
                _ => {
                    return Err(format!(
                        "responses content item type {kind} cannot be represented by Chat Completions"
                    ));
                }
            }
        }
        if has_non_text {
            Ok(Value::Array(mixed_parts))
        } else {
            Ok(Value::String(text_parts.join("\n")))
        }
    }

    fn response_tool_output_text(output: &Value) -> Result<String, String> {
        match output {
            Value::String(text) => Ok(text.clone()),
            Value::Array(items) => {
                let mut text = Vec::new();
                for item in items {
                    let kind = required_string(item, "type", "responses tool output content item")?;
                    match kind {
                        "input_text" => {
                            text.push(
                                required_string(item, "text", "responses tool output text item")?
                                    .to_string(),
                            );
                        }
                        _ => {
                            return Err(format!(
                                "responses tool output content item type {kind} cannot be represented by Chat Completions"
                            ));
                        }
                    }
                }
                Ok(text.join("\n"))
            }
            _ => Err("responses tool output must be a string or content item array".to_string()),
        }
    }

    fn required_string<'a>(value: &'a Value, key: &str, context: &str) -> Result<&'a str, String> {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("{context} missing string field {key}"))
    }

    fn optional_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
        value.get(key).and_then(Value::as_str)
    }

    fn required_array<'a>(
        value: &'a Value,
        key: &str,
        context: &str,
    ) -> Result<&'a [Value], String> {
        value
            .get(key)
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .ok_or_else(|| format!("{context} missing array field {key}"))
    }

    fn response_created_event(response_id: &str) -> Value {
        json!({"type": "response.created", "response": {"id": response_id}})
    }

    fn response_output_item_added_event(item_id: &str) -> Value {
        json!({
            "type": "response.output_item.added",
            "item": {
                "type": "message",
                "role": "assistant",
                "id": item_id,
                "content": [],
            },
        })
    }

    fn response_content_part_added_event(item_id: &str) -> Value {
        json!({
            "type": "response.content_part.added",
            "item_id": item_id,
            "output_index": 0,
            "content_index": 0,
            "part": {"type": "output_text", "text": "", "annotations": []},
        })
    }

    fn response_output_text_delta_event(item_id: &str, delta: &str) -> Value {
        json!({
            "type": "response.output_text.delta",
            "item_id": item_id,
            "output_index": 0,
            "content_index": 0,
            "delta": delta,
        })
    }

    fn response_output_text_done_event(item_id: &str, answer: &str) -> Value {
        json!({
            "type": "response.output_text.done",
            "item_id": item_id,
            "output_index": 0,
            "content_index": 0,
            "text": answer,
        })
    }

    fn response_content_part_done_event(item_id: &str, answer: &str) -> Value {
        json!({
            "type": "response.content_part.done",
            "item_id": item_id,
            "output_index": 0,
            "content_index": 0,
            "part": {"type": "output_text", "text": answer, "annotations": []},
        })
    }

    fn response_output_item_done_event(item_id: &str, answer: &str) -> Value {
        json!({
            "type": "response.output_item.done",
            "item": {
                "type": "message",
                "role": "assistant",
                "id": item_id,
                "content": [{"type": "output_text", "text": answer}],
            },
        })
    }

    fn response_reasoning_item_added_event(item_id: &str) -> Value {
        json!({
            "type": "response.output_item.added",
            "item": {
                "type": "reasoning",
                "id": item_id,
                "summary": [],
                "content": [],
                "encrypted_content": null,
            },
        })
    }

    fn response_reasoning_text_delta_event(item_id: &str, delta: &str) -> Value {
        json!({
            "type": "response.reasoning_text.delta",
            "item_id": item_id,
            "output_index": 0,
            "content_index": 0,
            "delta": delta,
        })
    }

    fn response_reasoning_item_done_event(item_id: &str, reasoning: &str) -> Value {
        json!({
            "type": "response.output_item.done",
            "item": {
                "type": "reasoning",
                "id": item_id,
                "summary": [],
                "content": [{"type": "reasoning_text", "text": reasoning}],
                "encrypted_content": null,
            },
        })
    }

    fn response_tool_call_done_event(
        catalog: &ChatToolCatalog,
        pending: PendingToolCall,
    ) -> Result<Value, String> {
        let chat_name = pending.name.ok_or_else(|| {
            format!(
                "chat completions tool call {} missing function name",
                pending.index
            )
        })?;
        let call_id = pending
            .id
            .unwrap_or_else(|| format!("call_{}", pending.index));
        let mapping = catalog
            .mapping_for_chat_name(&chat_name)
            .ok_or_else(|| format!("chat completions returned unknown tool call {chat_name}"))?;
        let item = match mapping.kind {
            ResponsesToolKind::Function => {
                let mut item = json!({
                    "type": "function_call",
                    "id": format!("fc_{call_id}"),
                    "name": mapping.name,
                    "arguments": pending.arguments,
                    "call_id": call_id,
                });
                if let Some(namespace) = mapping.namespace.as_deref() {
                    item["namespace"] = Value::String(namespace.to_string());
                }
                item
            }
            ResponsesToolKind::Custom => {
                let input = custom_tool_input(&pending.arguments)?;
                json!({
                    "type": "custom_tool_call",
                    "id": format!("ctc_{call_id}"),
                    "call_id": call_id,
                    "name": mapping.name,
                    "input": input,
                })
            }
            ResponsesToolKind::ToolSearch => {
                let arguments: Value = serde_json::from_str(&pending.arguments).map_err(|err| {
                    format!("parse tool_search arguments from chat completions: {err}")
                })?;
                json!({
                    "type": "tool_search_call",
                    "id": format!("ts_{call_id}"),
                    "call_id": call_id,
                    "execution": "client",
                    "arguments": arguments,
                })
            }
        };
        Ok(json!({"type": "response.output_item.done", "item": item}))
    }

    fn custom_tool_input(arguments: &str) -> Result<String, String> {
        let value: Value = serde_json::from_str(arguments)
            .map_err(|err| format!("parse custom tool arguments from chat completions: {err}"))?;
        value
            .get("input")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "custom tool arguments missing string input".to_string())
    }

    fn response_completed_event(
        response_id: &str,
        end_turn: bool,
        usage: Option<&ChatUsage>,
    ) -> Value {
        let mut response = json!({
            "id": response_id,
            "end_turn": end_turn,
        });
        if let Some(usage) = usage {
            response["usage"] = json!({
                "input_tokens": usage.input_tokens,
                "input_tokens_details": null,
                "output_tokens": usage.output_tokens,
                "output_tokens_details": null,
                "total_tokens": usage.total_tokens,
            });
        }
        json!({
            "type": "response.completed",
            "response": response,
        })
    }

    fn incomplete_event_for_finish_reason(response_id: &str, finish_reason: &str) -> Option<Value> {
        let reason = match finish_reason {
            "length" => "max_output_tokens",
            _ => return None,
        };
        Some(json!({
            "type": "response.incomplete",
            "response": {
                "id": response_id,
                "incomplete_details": {"reason": reason},
            },
        }))
    }

    fn failed_message_for_finish_reason(finish_reason: &str) -> Option<String> {
        match finish_reason {
            "stop" | "tool_calls" | "function_call" => None,
            "content_filter" => {
                Some("chat completions provider stopped with content_filter".to_string())
            }
            other => Some(format!(
                "chat completions provider stopped with unsupported finish_reason {other}"
            )),
        }
    }

    fn response_failed_event(response_id: &str, message: &str) -> Value {
        json!({
            "type": "response.failed",
            "response": {
                "id": response_id,
                "error": {
                    "type": "server_error",
                    "code": "vela_chat_compat_failed",
                    "message": message,
                },
            },
        })
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

    fn write_sse_event(stream: &mut TcpStream, event: Value) -> std::io::Result<()> {
        stream.write_all(sse(vec![event]).as_bytes())?;
        stream.flush()
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

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::{Arc, Mutex};

        struct FakeUpstream {
            addr: std::net::SocketAddr,
            received: Arc<Mutex<Option<Value>>>,
        }

        impl FakeUpstream {
            fn received_json(&self) -> Value {
                self.received
                    .lock()
                    .expect("capture lock")
                    .clone()
                    .expect("captured upstream request")
            }
        }

        fn spawn_upstream(status: u16, chunks: Vec<String>) -> FakeUpstream {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind upstream");
            let addr = listener.local_addr().expect("upstream addr");
            let received = Arc::new(Mutex::new(None));
            let received_for_thread = Arc::clone(&received);
            std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept upstream request");
                let request = read_http_request(&mut stream).expect("read upstream request");
                let body: Value =
                    serde_json::from_slice(&request.body).expect("parse upstream body");
                *received_for_thread.lock().expect("capture lock") = Some(body);
                let reason = match status {
                    200 => "OK",
                    400 => "Bad Request",
                    500 => "Internal Server Error",
                    _ => "Error",
                };
                let content_type = if status == 200 {
                    "text/event-stream"
                } else {
                    "application/json"
                };
                write!(
                    stream,
                    "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\nconnection: close\r\n\r\n"
                )
                .expect("write upstream headers");
                for chunk in chunks {
                    stream
                        .write_all(chunk.as_bytes())
                        .expect("write upstream chunk");
                    stream.flush().expect("flush upstream chunk");
                }
            });
            FakeUpstream { addr, received }
        }

        fn post_responses(addr: std::net::SocketAddr, request: Value) -> String {
            let mut stream = TcpStream::connect(addr).expect("connect bridge");
            let body = request.to_string();
            write!(
                stream,
                "POST /v1/responses HTTP/1.1\r\nhost: {addr}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("write bridge request");
            stream.shutdown(Shutdown::Write).expect("finish request");
            let mut response = String::new();
            stream
                .read_to_string(&mut response)
                .expect("read bridge response");
            response
        }

        fn split_response(response: &str) -> (&str, &str) {
            response
                .split_once("\r\n\r\n")
                .expect("http response delimiter")
        }

        fn chat_delta_frame(delta: &str) -> String {
            format!(
                "data: {}\n\n",
                json!({
                    "id": "chatcmpl-test",
                    "object": "chat.completion.chunk",
                    "choices": [{
                        "index": 0,
                        "delta": {"content": delta},
                        "finish_reason": null,
                    }],
                })
            )
        }

        fn chat_finished_frame() -> String {
            format!(
                "data: {}\n\n",
                json!({
                    "id": "chatcmpl-test",
                    "object": "chat.completion.chunk",
                    "choices": [{
                        "index": 0,
                        "delta": {},
                        "finish_reason": "stop",
                    }],
                })
            )
        }

        fn chat_delta_finished_frame(delta: &str) -> String {
            format!(
                "data: {}\n\n",
                json!({
                    "id": "chatcmpl-test",
                    "object": "chat.completion.chunk",
                    "choices": [{
                        "index": 0,
                        "delta": {"content": delta},
                        "finish_reason": "stop",
                    }],
                })
            )
        }

        fn chat_tool_call_frame(
            index: u64,
            id: Option<&str>,
            name: Option<&str>,
            arguments: Option<&str>,
            finish_reason: Option<&str>,
        ) -> String {
            let mut tool_call = json!({
                "index": index,
                "type": "function",
                "function": {},
            });
            if let Some(id) = id {
                tool_call["id"] = Value::String(id.to_string());
            }
            if let Some(name) = name {
                tool_call["function"]["name"] = Value::String(name.to_string());
            }
            if let Some(arguments) = arguments {
                tool_call["function"]["arguments"] = Value::String(arguments.to_string());
            }
            format!(
                "data: {}\n\n",
                json!({
                    "id": "chatcmpl-test",
                    "object": "chat.completion.chunk",
                    "choices": [{
                        "index": 0,
                        "delta": {"tool_calls": [tool_call]},
                        "finish_reason": finish_reason,
                    }],
                })
            )
        }

        fn chat_reasoning_frame(reasoning: &str) -> String {
            format!(
                "data: {}\n\n",
                json!({
                    "id": "chatcmpl-test",
                    "object": "chat.completion.chunk",
                    "choices": [{
                        "index": 0,
                        "delta": {"reasoning_content": reasoning},
                        "finish_reason": null,
                    }],
                })
            )
        }

        fn chat_usage_frame(prompt: u64, completion: u64, total: u64) -> String {
            format!(
                "data: {}\n\n",
                json!({
                    "id": "chatcmpl-test",
                    "object": "chat.completion.chunk",
                    "choices": [],
                    "usage": {
                        "prompt_tokens": prompt,
                        "completion_tokens": completion,
                        "total_tokens": total,
                    },
                })
            )
        }

        fn chat_error_frame(message: &str) -> String {
            format!(
                "data: {}\n\n",
                json!({
                    "error": {"message": message},
                })
            )
        }

        fn chat_finish_reason_frame(reason: &str) -> String {
            format!(
                "data: {}\n\n",
                json!({
                    "id": "chatcmpl-test",
                    "object": "chat.completion.chunk",
                    "choices": [{
                        "index": 0,
                        "delta": {},
                        "finish_reason": reason,
                    }],
                })
            )
        }

        fn function_tool(name: &str) -> Value {
            json!({
                "type": "function",
                "name": name,
                "description": "Run a test function.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "cmd": {"type": "string"}
                    },
                    "required": ["cmd"],
                    "additionalProperties": false,
                },
            })
        }

        fn custom_tool(name: &str) -> Value {
            json!({
                "type": "custom",
                "name": name,
                "description": "Freeform test tool.",
                "format": {
                    "type": "grammar",
                    "syntax": "lark",
                    "definition": "start: /.+/",
                },
            })
        }

        fn web_search_tool() -> Value {
            json!({
                "type": "web_search",
                "external_web_access": false,
                "search_context_size": "low",
            })
        }

        fn sse_values(body: &str) -> Vec<Value> {
            body.split("\n\n")
                .filter_map(|frame| {
                    let data = frame.lines().find_map(|line| {
                        line.strip_prefix("data: ")
                            .or_else(|| line.strip_prefix("data:"))
                            .map(str::trim)
                    })?;
                    serde_json::from_str(data).ok()
                })
                .collect()
        }

        fn events_of_type<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
            events
                .iter()
                .filter(|event| event.get("type").and_then(Value::as_str) == Some(kind))
                .collect()
        }

        fn assert_ordered(haystack: &str, needles: &[&str]) {
            let mut offset = 0;
            for needle in needles {
                let Some(index) = haystack[offset..].find(needle) else {
                    panic!("missing ordered fragment {needle:?} in {haystack}");
                };
                offset += index + needle.len();
            }
        }

        #[test]
        fn bridge_requests_chat_stream_and_emits_real_responses_sse() {
            let upstream = spawn_upstream(
                200,
                vec![
                    chat_delta_frame("Hel"),
                    chat_delta_frame("lo"),
                    "data: [DONE]\n\n".to_string(),
                ],
            );
            let bridge = ChatCompletionsBridge::start(ChatCompletionsBridgeConfig {
                endpoint: format!("http://{}", upstream.addr),
                api_key: "test-key".to_string(),
                model: "default-model".to_string(),
            })
            .expect("start bridge");

            let response = post_responses(
                bridge.server.addr,
                json!({
                    "model": "requested-model",
                    "instructions": "Be concise.",
                    "input": "Say hello",
                }),
            );
            let upstream_body = upstream.received_json();
            assert_eq!(upstream_body["stream"], true);
            assert_eq!(upstream_body["model"], "requested-model");
            assert_eq!(upstream_body["messages"][0]["role"], "system");
            assert_eq!(upstream_body["messages"][0]["content"], "Be concise.");
            assert_eq!(upstream_body["messages"][1]["role"], "user");
            assert_eq!(upstream_body["messages"][1]["content"], "Say hello");

            let (headers, body) = split_response(&response);
            let headers = headers.to_ascii_lowercase();
            assert!(headers.starts_with("http/1.1 200 ok"));
            assert!(headers.contains("content-type: text/event-stream"));
            assert!(!headers.contains("content-length:"));
            assert_ordered(
                body,
                &[
                    "event: response.created",
                    "event: response.output_item.added",
                    "event: response.content_part.added",
                    "event: response.output_text.delta",
                    "\"delta\":\"Hel\"",
                    "event: response.output_text.delta",
                    "\"delta\":\"lo\"",
                    "event: response.output_text.done",
                    "\"text\":\"Hello\"",
                    "event: response.content_part.done",
                    "\"text\":\"Hello\"",
                    "event: response.output_item.done",
                    "\"text\":\"Hello\"",
                    "event: response.completed",
                ],
            );
        }

        #[test]
        fn bridge_handles_fragmented_crlf_chat_sse_frames() {
            let frame = chat_delta_frame("chunked").replace('\n', "\r\n");
            let split = frame.len() / 2;
            let upstream = spawn_upstream(
                200,
                vec![
                    frame[..split].to_string(),
                    frame[split..].to_string(),
                    "data: [DONE]\r\n\r\n".to_string(),
                ],
            );
            let bridge = ChatCompletionsBridge::start(ChatCompletionsBridgeConfig {
                endpoint: format!("http://{}", upstream.addr),
                api_key: "test-key".to_string(),
                model: "default-model".to_string(),
            })
            .expect("start bridge");

            let response = post_responses(
                bridge.server.addr,
                json!({
                    "model": "requested-model",
                    "input": "stream",
                }),
            );
            let (_, body) = split_response(&response);
            assert!(body.contains("event: response.output_text.delta"));
            assert!(body.contains("\"delta\":\"chunked\""));
            assert!(body.contains("event: response.completed"));
            assert!(!body.contains("event: response.failed"));
        }

        #[test]
        fn bridge_maps_upstream_http_error_to_responses_failed_sse() {
            let upstream = spawn_upstream(
                400,
                vec![r#"{"error":{"message":"bad upstream request"}}"#.to_string()],
            );
            let bridge = ChatCompletionsBridge::start(ChatCompletionsBridgeConfig {
                endpoint: format!("http://{}", upstream.addr),
                api_key: "test-key".to_string(),
                model: "default-model".to_string(),
            })
            .expect("start bridge");

            let response = post_responses(
                bridge.server.addr,
                json!({
                    "model": "requested-model",
                    "input": "fail",
                }),
            );
            let (headers, body) = split_response(&response);
            assert!(headers.to_ascii_lowercase().contains("text/event-stream"));
            assert!(body.contains("event: response.failed"));
            assert!(body.contains("chat completions provider returned HTTP 400"));
            assert!(!body.contains("event: response.completed"));
        }

        #[test]
        fn bridge_fails_responses_stream_when_upstream_closes_before_done() {
            let upstream = spawn_upstream(200, vec![chat_delta_frame("partial")]);
            let bridge = ChatCompletionsBridge::start(ChatCompletionsBridgeConfig {
                endpoint: format!("http://{}", upstream.addr),
                api_key: "test-key".to_string(),
                model: "default-model".to_string(),
            })
            .expect("start bridge");

            let response = post_responses(
                bridge.server.addr,
                json!({
                    "model": "requested-model",
                    "input": "fail mid-stream",
                }),
            );
            let (_, body) = split_response(&response);
            assert_ordered(
                body,
                &[
                    "event: response.output_text.delta",
                    "\"delta\":\"partial\"",
                    "event: response.failed",
                    "chat completions stream closed before [DONE]",
                ],
            );
            assert!(!body.contains("event: response.completed"));
        }

        #[test]
        fn bridge_completes_when_final_delta_carries_finish_reason() {
            let upstream = spawn_upstream(200, vec![chat_delta_finished_frame("done")]);
            let bridge = ChatCompletionsBridge::start(ChatCompletionsBridgeConfig {
                endpoint: format!("http://{}", upstream.addr),
                api_key: "test-key".to_string(),
                model: "default-model".to_string(),
            })
            .expect("start bridge");

            let response = post_responses(
                bridge.server.addr,
                json!({
                    "model": "requested-model",
                    "input": "finish with content",
                }),
            );
            let (_, body) = split_response(&response);
            assert_ordered(
                body,
                &[
                    "event: response.output_text.delta",
                    "\"delta\":\"done\"",
                    "event: response.output_text.done",
                    "\"text\":\"done\"",
                    "event: response.content_part.done",
                    "\"text\":\"done\"",
                    "event: response.output_item.done",
                    "\"text\":\"done\"",
                    "event: response.completed",
                ],
            );
            assert!(!body.contains("event: response.failed"));
        }

        #[test]
        fn bridge_omits_optional_web_search_tool_for_chat_completions() {
            let upstream = spawn_upstream(200, vec![chat_delta_finished_frame("done")]);
            let bridge = ChatCompletionsBridge::start(ChatCompletionsBridgeConfig {
                endpoint: format!("http://{}", upstream.addr),
                api_key: "test-key".to_string(),
                model: "default-model".to_string(),
            })
            .expect("start bridge");

            let response = post_responses(
                bridge.server.addr,
                json!({
                    "model": "requested-model",
                    "input": "can you answer without browsing?",
                    "tools": [web_search_tool()],
                }),
            );
            let (_, body) = split_response(&response);
            assert!(
                !body.contains("event: response.failed"),
                "optional web_search must not fail the bridge before the provider sees the request: {body}"
            );
            assert!(body.contains("event: response.completed"));

            let upstream_body = upstream.received_json();
            assert!(
                upstream_body.get("tools").is_none(),
                "web_search is a Responses built-in without a Chat Completions tool equivalent"
            );
        }

        #[test]
        fn bridge_maps_responses_tools_and_round_trips_chat_tool_calls() {
            let upstream = spawn_upstream(
                200,
                vec![
                    chat_tool_call_frame(
                        0,
                        Some("call_1"),
                        Some("shell_command"),
                        Some("{\"cmd\""),
                        None,
                    ),
                    chat_tool_call_frame(0, None, None, Some(":\"pwd\"}"), Some("tool_calls")),
                ],
            );
            let bridge = ChatCompletionsBridge::start(ChatCompletionsBridgeConfig {
                endpoint: format!("http://{}", upstream.addr),
                api_key: "test-key".to_string(),
                model: "default-model".to_string(),
            })
            .expect("start bridge");

            let response = post_responses(
                bridge.server.addr,
                json!({
                    "model": "requested-model",
                    "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "run pwd"}]}],
                    "tools": [function_tool("shell_command")],
                    "tool_choice": {"type": "function", "name": "shell_command"},
                    "parallel_tool_calls": true,
                    "reasoning": {"effort": "medium"},
                    "service_tier": "flex",
                    "text": {"format": {"type": "text"}},
                }),
            );
            let upstream_body = upstream.received_json();
            assert_eq!(upstream_body["stream"], true);
            assert_eq!(upstream_body["tools"][0]["type"], "function");
            assert_eq!(
                upstream_body["tools"][0]["function"]["name"],
                "shell_command"
            );
            assert_eq!(
                upstream_body["tool_choice"]["function"]["name"],
                "shell_command"
            );
            assert_eq!(upstream_body["parallel_tool_calls"], true);
            assert_eq!(upstream_body["reasoning_effort"], "medium");
            assert!(
                upstream_body.get("service_tier").is_none(),
                "service_tier is a Responses field and must not leak into Chat Completions"
            );
            assert!(upstream_body.get("response_format").is_none());

            let (_, body) = split_response(&response);
            let events = sse_values(body);
            let tool_call = events_of_type(&events, "response.output_item.done")
                .into_iter()
                .find(|event| {
                    event.pointer("/item/type").and_then(Value::as_str) == Some("function_call")
                })
                .expect("function_call output item");
            assert_eq!(
                tool_call.pointer("/item/call_id").and_then(Value::as_str),
                Some("call_1")
            );
            assert_eq!(
                tool_call.pointer("/item/name").and_then(Value::as_str),
                Some("shell_command")
            );
            assert_eq!(
                tool_call.pointer("/item/arguments").and_then(Value::as_str),
                Some("{\"cmd\":\"pwd\"}")
            );
            let completed = events_of_type(&events, "response.completed")
                .pop()
                .expect("completed event");
            assert_eq!(
                completed
                    .pointer("/response/end_turn")
                    .and_then(Value::as_bool),
                Some(false)
            );
        }

        #[test]
        fn bridge_maps_custom_tools_as_freeform_responses_calls() {
            let patch = "*** Begin Patch\n*** End Patch";
            let upstream = spawn_upstream(
                200,
                vec![chat_tool_call_frame(
                    0,
                    Some("call_custom"),
                    Some("apply_patch"),
                    Some(&json!({"input": patch}).to_string()),
                    Some("tool_calls"),
                )],
            );
            let bridge = ChatCompletionsBridge::start(ChatCompletionsBridgeConfig {
                endpoint: format!("http://{}", upstream.addr),
                api_key: "test-key".to_string(),
                model: "default-model".to_string(),
            })
            .expect("start bridge");

            let response = post_responses(
                bridge.server.addr,
                json!({
                    "model": "requested-model",
                    "input": "apply this patch",
                    "tools": [custom_tool("apply_patch")],
                }),
            );
            let upstream_body = upstream.received_json();
            assert_eq!(upstream_body["tools"][0]["function"]["name"], "apply_patch");
            assert_eq!(
                upstream_body["tools"][0]["function"]["parameters"]["required"][0],
                "input"
            );

            let (_, body) = split_response(&response);
            let events = sse_values(body);
            let custom_call = events_of_type(&events, "response.output_item.done")
                .into_iter()
                .find(|event| {
                    event.pointer("/item/type").and_then(Value::as_str) == Some("custom_tool_call")
                })
                .expect("custom_tool_call output item");
            assert_eq!(
                custom_call.pointer("/item/call_id").and_then(Value::as_str),
                Some("call_custom")
            );
            assert_eq!(
                custom_call.pointer("/item/name").and_then(Value::as_str),
                Some("apply_patch")
            );
            assert_eq!(
                custom_call.pointer("/item/input").and_then(Value::as_str),
                Some(patch)
            );
            let completed = events_of_type(&events, "response.completed")
                .pop()
                .expect("completed event");
            assert_eq!(
                completed
                    .pointer("/response/end_turn")
                    .and_then(Value::as_bool),
                Some(false)
            );
        }

        #[test]
        fn bridge_replays_responses_tool_history_to_chat_messages() {
            let upstream = spawn_upstream(200, vec![chat_delta_finished_frame("done")]);
            let bridge = ChatCompletionsBridge::start(ChatCompletionsBridgeConfig {
                endpoint: format!("http://{}", upstream.addr),
                api_key: "test-key".to_string(),
                model: "default-model".to_string(),
            })
            .expect("start bridge");

            let _ = post_responses(
                bridge.server.addr,
                json!({
                    "model": "requested-model",
                    "tools": [function_tool("shell_command")],
                    "input": [
                        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "where am I"}]},
                        {"type": "function_call", "call_id": "call_1", "name": "shell_command", "arguments": "{\"cmd\":\"pwd\"}"},
                        {"type": "function_call_output", "call_id": "call_1", "output": "/tmp/project"}
                    ],
                }),
            );
            let upstream_body = upstream.received_json();
            let messages = upstream_body["messages"].as_array().expect("messages");
            assert_eq!(messages[0]["role"], "user");
            assert_eq!(messages[0]["content"], "where am I");
            assert_eq!(messages[1]["role"], "assistant");
            assert_eq!(messages[1]["content"], Value::Null);
            assert_eq!(messages[1]["tool_calls"][0]["id"], "call_1");
            assert_eq!(
                messages[1]["tool_calls"][0]["function"]["name"],
                "shell_command"
            );
            assert_eq!(
                messages[1]["tool_calls"][0]["function"]["arguments"],
                "{\"cmd\":\"pwd\"}"
            );
            assert_eq!(messages[2]["role"], "tool");
            assert_eq!(messages[2]["tool_call_id"], "call_1");
            assert_eq!(messages[2]["content"], "/tmp/project");
        }

        #[test]
        fn bridge_maps_reasoning_and_real_usage_to_responses_events() {
            let upstream = spawn_upstream(
                200,
                vec![
                    chat_reasoning_frame("thinking"),
                    chat_delta_finished_frame("answer"),
                    chat_usage_frame(10, 3, 13),
                    "data: [DONE]\n\n".to_string(),
                ],
            );
            let bridge = ChatCompletionsBridge::start(ChatCompletionsBridgeConfig {
                endpoint: format!("http://{}", upstream.addr),
                api_key: "test-key".to_string(),
                model: "default-model".to_string(),
            })
            .expect("start bridge");

            let response = post_responses(
                bridge.server.addr,
                json!({
                    "model": "requested-model",
                    "input": "think then answer",
                }),
            );
            let (_, body) = split_response(&response);
            let events = sse_values(body);
            let reasoning_delta = events_of_type(&events, "response.reasoning_text.delta")
                .pop()
                .expect("reasoning delta");
            assert_eq!(
                reasoning_delta.get("delta").and_then(Value::as_str),
                Some("thinking")
            );
            let reasoning_done = events_of_type(&events, "response.output_item.done")
                .into_iter()
                .find(|event| {
                    event.pointer("/item/type").and_then(Value::as_str) == Some("reasoning")
                })
                .expect("reasoning done item");
            assert_eq!(
                reasoning_done
                    .pointer("/item/content/0/text")
                    .and_then(Value::as_str),
                Some("thinking")
            );
            assert!(body.contains("\"text\":\"answer\""));
            let completed = events_of_type(&events, "response.completed")
                .pop()
                .expect("completed event");
            assert_eq!(
                completed
                    .pointer("/response/usage/total_tokens")
                    .and_then(Value::as_u64),
                Some(13)
            );
        }

        #[test]
        fn bridge_maps_stream_error_frame_to_responses_failed() {
            let upstream = spawn_upstream(200, vec![chat_error_frame("rate limited")]);
            let bridge = ChatCompletionsBridge::start(ChatCompletionsBridgeConfig {
                endpoint: format!("http://{}", upstream.addr),
                api_key: "test-key".to_string(),
                model: "default-model".to_string(),
            })
            .expect("start bridge");

            let response = post_responses(
                bridge.server.addr,
                json!({
                    "model": "requested-model",
                    "input": "fail",
                }),
            );
            let (_, body) = split_response(&response);
            assert!(body.contains("event: response.failed"));
            assert!(body.contains("chat completions provider stream error: rate limited"));
            assert!(!body.contains("event: response.completed"));
        }

        #[test]
        fn bridge_maps_length_finish_reason_to_responses_incomplete() {
            let upstream = spawn_upstream(
                200,
                vec![
                    chat_delta_frame("partial"),
                    chat_finish_reason_frame("length"),
                ],
            );
            let bridge = ChatCompletionsBridge::start(ChatCompletionsBridgeConfig {
                endpoint: format!("http://{}", upstream.addr),
                api_key: "test-key".to_string(),
                model: "default-model".to_string(),
            })
            .expect("start bridge");

            let response = post_responses(
                bridge.server.addr,
                json!({
                    "model": "requested-model",
                    "input": "limit",
                }),
            );
            let (_, body) = split_response(&response);
            assert_ordered(
                body,
                &[
                    "event: response.output_text.delta",
                    "\"delta\":\"partial\"",
                    "event: response.incomplete",
                    "\"reason\":\"max_output_tokens\"",
                ],
            );
            assert!(!body.contains("event: response.completed"));
            assert!(!body.contains("event: response.failed"));
        }

        #[test]
        fn bridge_rejects_unknown_responses_tool_types() {
            let bridge = ChatCompletionsBridge::start(ChatCompletionsBridgeConfig {
                endpoint: "http://127.0.0.1:9".to_string(),
                api_key: "test-key".to_string(),
                model: "default-model".to_string(),
            })
            .expect("start bridge");

            let response = post_responses(
                bridge.server.addr,
                json!({
                    "model": "requested-model",
                    "input": "search",
                    "tools": [{"type": "unsupported_test_tool"}],
                }),
            );
            let (_, body) = split_response(&response);
            assert!(body.contains("event: response.failed"));
            assert!(body.contains("unsupported responses tool type unsupported_test_tool"));
        }

        #[test]
        fn chat_stream_parser_ignores_role_frames_and_accepts_finish_reason() {
            let role_frame = json!({
                "choices": [{
                    "index": 0,
                    "delta": {"role": "assistant"},
                    "finish_reason": null,
                }],
            })
            .to_string();
            assert!(matches!(
                chat_completions_stream_frame(&role_frame).expect("role frame"),
                ChatCompletionsStreamFrame::Ignore
            ));

            let finish = chat_finished_frame()
                .trim_start_matches("data: ")
                .trim()
                .to_string();
            match chat_completions_stream_frame(&finish).expect("finish frame") {
                ChatCompletionsStreamFrame::Delta(delta) => {
                    assert_eq!(delta.finish_reason.as_deref(), Some("stop"));
                }
                frame => panic!("expected finish delta, got {frame:?}"),
            }
        }
    }
}

#[cfg(feature = "codex-core-local")]
pub use local::ChatCompletionsBridge;
