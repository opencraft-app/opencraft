use crate::{BackendAdapter, BackendOutput, BackendOutputSink, BackendSend};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::process::Stdio;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    time::{Duration, timeout},
};
use vela_core::EventType;

#[derive(Clone, Debug)]
pub struct PiBackendAdapter {
    pub command: String,
    pub cwd: String,
    pub session_dir: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub session: Option<String>,
    pub provider: Option<String>,
    pub api_key: Option<String>,
    pub env: HashMap<String, String>,
    pub no_tools: bool,
}

impl PiBackendAdapter {
    pub fn new(cwd: impl Into<String>) -> Self {
        Self {
            command: "pi".to_string(),
            cwd: cwd.into(),
            session_dir: None,
            model: None,
            thinking: None,
            session: None,
            provider: None,
            api_key: None,
            env: HashMap::new(),
            no_tools: false,
        }
    }

    pub fn launch_args(&self) -> Vec<String> {
        let mut args = vec!["--mode".to_string(), "rpc".to_string()];
        if let Some(model) = &self.model {
            args.extend(["--model".to_string(), model.clone()]);
        }
        if let Some(thinking) = &self.thinking {
            args.extend(["--thinking".to_string(), thinking.clone()]);
        }
        if let Some(session) = &self.session {
            args.extend(["--session".to_string(), session.clone()]);
        }
        if let Some(provider) = &self.provider {
            args.extend(["--provider".to_string(), provider.clone()]);
        }
        if let Some(api_key) = &self.api_key {
            args.extend(["--api-key".to_string(), api_key.clone()]);
        }
        if let Some(session_dir) = &self.session_dir {
            args.extend(["--session-dir".to_string(), session_dir.clone()]);
        }
        if self.no_tools {
            args.push("--no-tools".to_string());
        }
        args
    }
}

#[async_trait]
impl BackendAdapter for PiBackendAdapter {
    async fn stream_user_message(
        &self,
        input: BackendSend,
        sink: BackendOutputSink,
    ) -> anyhow::Result<()> {
        let mut child = Command::new(&self.command)
            .args(self.launch_args())
            .current_dir(&self.cwd)
            .envs(&self.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let mut stdin = child.stdin.take().expect("pi stdin");
        let stdout = child.stdout.take().expect("pi stdout");
        let mut lines = BufReader::new(stdout).lines();
        let request = json!({
            "id": "req_1",
            "type": "prompt",
            "message": input.content,
        });
        stdin
            .write_all(format!("{}\n", serde_json::to_string(&request)?).as_bytes())
            .await?;
        stdin.flush().await?;

        loop {
            let line = timeout(Duration::from_secs(120), lines.next_line()).await??;
            let Some(line) = line else {
                break;
            };
            let value: Value = serde_json::from_str(&line)?;
            match classify_pi_message(value)? {
                PiRuntimeMessage::Response(response) => {
                    if response.id.as_deref() == Some("req_1") && !response.success {
                        anyhow::bail!(
                            "{}",
                            response
                                .error
                                .unwrap_or_else(|| "Pi prompt failed".to_string())
                        );
                    }
                }
                PiRuntimeMessage::Event(event) => {
                    let normalized = normalize_pi_event(event.clone());
                    let done = normalized
                        .iter()
                        .any(|output| output.event_type == EventType::TURN_COMPLETED);
                    for output in normalized {
                        sink.send(output).await?;
                    }
                    if done {
                        break;
                    }
                }
            }
        }

        let _ = child.kill().await;
        Ok(())
    }
}

#[derive(Default)]
pub struct PiJsonlCodec {
    buffer: String,
}

impl PiJsonlCodec {
    pub fn push_chunk(&mut self, chunk: &str) -> anyhow::Result<Vec<PiRuntimeMessage>> {
        self.buffer.push_str(chunk);
        let mut messages = Vec::new();
        while let Some(index) = self.buffer.find('\n') {
            let line = self.buffer[..index].trim_end_matches('\r').to_string();
            self.buffer = self.buffer[index + 1..].to_string();
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str(&line) {
                messages.push(classify_pi_message(value)?);
            }
        }
        Ok(messages)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum PiRuntimeMessage {
    Response(PiRpcResponse),
    Event(Value),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PiRpcResponse {
    pub id: Option<String>,
    pub command: String,
    pub success: bool,
    pub error: Option<String>,
    pub data: Option<Value>,
}

fn classify_pi_message(value: Value) -> anyhow::Result<PiRuntimeMessage> {
    if value.get("type").and_then(Value::as_str) == Some("response") {
        Ok(PiRuntimeMessage::Response(serde_json::from_value(value)?))
    } else {
        Ok(PiRuntimeMessage::Event(value))
    }
}

pub fn normalize_pi_event(event: Value) -> Vec<BackendOutput> {
    let Some(event_type) = event.get("type").and_then(Value::as_str) else {
        return vec![warning("Pi event did not include a type", event)];
    };

    match event_type {
        "agent_start" | "turn_start" | "turn_end" => Vec::new(),
        "message_start" => normalize_message_lifecycle(event, EventType::ASSISTANT_MESSAGE_STARTED),
        "message_end" => normalize_message_lifecycle(event, EventType::ASSISTANT_MESSAGE_COMPLETED),
        "message_update" => normalize_message_update(event),
        "tool_execution_start" => vec![with_raw(
            EventType::TOOL_STARTED,
            tool_payload(&event, "running", false),
            event,
        )],
        "tool_execution_update" => vec![with_raw(
            EventType::TOOL_UPDATED,
            json!({
                "tool_id": event.get("toolCallId").or_else(|| event.get("tool_call_id")),
                "partial_result": event.get("partialResult").or_else(|| event.get("partial_result")),
            }),
            event,
        )],
        "tool_execution_end" => {
            let is_error = event
                .get("isError")
                .or_else(|| event.get("is_error"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            vec![with_raw(
                if is_error {
                    EventType::TOOL_FAILED
                } else {
                    EventType::TOOL_COMPLETED
                },
                tool_payload(
                    &event,
                    if is_error { "failed" } else { "completed" },
                    is_error,
                ),
                event,
            )]
        }
        "agent_end" => vec![with_raw(EventType::TURN_COMPLETED, json!({}), event)],
        "process_exit" => vec![with_raw(
            EventType::TURN_FAILED,
            json!({ "error": event.get("error").cloned().unwrap_or(Value::Null) }),
            event,
        )],
        "extension_ui_request" => {
            vec![warning("Pi extension UI request is not handled yet", event)]
        }
        _ => vec![warning(
            format!("Unhandled Pi event type: {event_type}"),
            event,
        )],
    }
}

fn tool_payload(event: &Value, status: &str, is_error: bool) -> Value {
    let tool_id = get_string(event, "toolCallId")
        .or_else(|| get_string(event, "tool_call_id"))
        .unwrap_or_default();
    let tool_name = get_string(event, "toolName")
        .or_else(|| get_string(event, "tool_name"))
        .unwrap_or_default();
    let args = event.get("args").cloned().unwrap_or(Value::Null);
    let result = event.get("result").cloned().unwrap_or(Value::Null);
    let name = normalize_tool_name(&tool_name, &args, &result);
    let detail = tool_detail(&tool_name, &args, &result);
    let error = if is_error {
        result.clone()
    } else {
        Value::Null
    };

    json!({
        "tool_id": tool_id,
        "name": name,
        "status": status,
        "detail": detail,
        "error": error,
    })
}

fn tool_detail(tool_name: &str, args: &Value, result: &Value) -> Value {
    match tool_name {
        "bash" => shell_detail(args, result),
        "edit" => json!({
            "type": "edit",
            "file_path": args.get("path").and_then(Value::as_str).unwrap_or(""),
            "old_string": args.get("old_string").and_then(Value::as_str).unwrap_or(""),
            "new_string": args.get("new_string").and_then(Value::as_str).unwrap_or(""),
            "unified_diff": result
                .get("details")
                .and_then(|details| details.get("diff"))
                .and_then(Value::as_str)
                .unwrap_or(""),
        }),
        _ => json!({
            "type": "unknown",
            "input": args,
            "output": result,
        }),
    }
}

fn shell_detail(args: &Value, result: &Value) -> Value {
    let mut detail = Map::new();
    detail.insert("type".to_string(), Value::String("shell".to_string()));
    detail.insert(
        "command".to_string(),
        Value::String(
            args.get("command")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ),
    );
    if let Some(output) = result.get("output").and_then(Value::as_str) {
        detail.insert("output".to_string(), Value::String(output.to_string()));
    }
    if let Some(exit_code) = result.get("exitCode").or_else(|| result.get("exit_code")) {
        detail.insert("exit_code".to_string(), exit_code.clone());
    }
    Value::Object(detail)
}

fn normalize_tool_name(tool_name: &str, args: &Value, result: &Value) -> String {
    if tool_name == "mcp" {
        if let Some(tool) = result
            .get("details")
            .and_then(|details| details.get("tool"))
            .and_then(Value::as_str)
        {
            let server = result
                .get("details")
                .and_then(|details| details.get("server"))
                .and_then(Value::as_str)
                .unwrap_or("mcp");
            return format!("{server}.{tool}");
        }
        if let Some(tool) = args.get("tool").and_then(Value::as_str) {
            if let Some(rest) = tool.strip_prefix("paseo_") {
                return format!("paseo.{rest}");
            }
            return tool.to_string();
        }
    }
    tool_name.to_string()
}

fn get_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn normalize_message_lifecycle(event: Value, event_type: EventType) -> Vec<BackendOutput> {
    if event
        .get("message")
        .and_then(|message| message.get("role"))
        .and_then(Value::as_str)
        != Some("assistant")
    {
        return Vec::new();
    }
    let Some(message_id) = pi_message_id(&event, None) else {
        return Vec::new();
    };
    let mut payload = json!({ "message_id": message_id });
    if let Some(stop_reason) = event
        .get("message")
        .and_then(|message| {
            message
                .get("stopReason")
                .or_else(|| message.get("stop_reason"))
        })
        .and_then(Value::as_str)
    {
        payload["stop_reason"] = json!(stop_reason);
    }
    vec![with_raw(event_type, payload, event)]
}

fn normalize_message_update(event: Value) -> Vec<BackendOutput> {
    if event
        .get("message")
        .and_then(|message| message.get("role"))
        .and_then(Value::as_str)
        != Some("assistant")
    {
        return Vec::new();
    }
    let assistant_event = event.get("assistantMessageEvent");
    let Some(kind) = assistant_event
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
    else {
        return vec![warning(
            "Pi message_update did not include assistantMessageEvent",
            event,
        )];
    };
    let delta = assistant_event
        .and_then(|value| value.get("delta"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let message_id = pi_message_id(&event, assistant_event);
    match kind {
        "text_delta" => vec![with_raw(
            EventType::ASSISTANT_MESSAGE_DELTA,
            message_delta_payload(delta, message_id.as_deref()),
            event,
        )],
        "thinking_delta" => vec![with_raw(
            EventType::ASSISTANT_REASONING_DELTA,
            message_delta_payload(delta, message_id.as_deref()),
            event,
        )],
        _ => Vec::new(),
    }
}

fn pi_message_id(event: &Value, assistant_event: Option<&Value>) -> Option<String> {
    event
        .get("message")
        .and_then(|message| {
            get_string(message, "id")
                .or_else(|| get_string(message, "messageId"))
                .or_else(|| get_string(message, "responseId"))
        })
        .or_else(|| {
            assistant_event
                .and_then(|value| value.get("partial"))
                .and_then(|partial| {
                    get_string(partial, "id")
                        .or_else(|| get_string(partial, "messageId"))
                        .or_else(|| get_string(partial, "responseId"))
                })
        })
}

fn message_delta_payload(delta: &str, message_id: Option<&str>) -> Value {
    let mut payload = json!({ "delta": delta });
    if let Some(message_id) = message_id {
        payload["message_id"] = json!(message_id);
    }
    payload
}

fn with_raw(event_type: EventType, payload: Value, raw: Value) -> BackendOutput {
    BackendOutput {
        event_type,
        payload,
        raw: Some(raw),
    }
}

fn warning(message: impl Into<String>, raw: Value) -> BackendOutput {
    with_raw(
        EventType::WARNING_RAISED,
        json!({ "message": message.into() }),
        raw,
    )
}
