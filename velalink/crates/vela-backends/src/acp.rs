use crate::{
    BackendAdapter, BackendCapabilities, BackendOutput, BackendOutputSink, BackendRequestResponse,
    BackendSend, BackendStatus,
};
use async_trait::async_trait;
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    collections::VecDeque,
    fs,
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, oneshot},
};
use vela_core::{BlobRef, EventType, PermissionMode, UserMessageBlock};

const ACP_PROTOCOL_VERSION: i64 = 1;
const CLOUDAGENTS_BASE_URL: &str = "https://tokenhub.tencentmaas.com/v1";

static ACP_TEMP_HOME_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq)]
pub enum AcpInbound {
    Response(Value),
    Request {
        id: i64,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
}

impl AcpInbound {
    pub fn response(value: Value) -> Self {
        Self::Response(value)
    }

    pub fn request(id: i64, method: impl Into<String>, params: Value) -> Self {
        Self::Request {
            id,
            method: method.into(),
            params,
        }
    }

    pub fn notification(method: impl Into<String>, params: Value) -> Self {
        Self::Notification {
            method: method.into(),
            params,
        }
    }
}

#[async_trait]
pub trait AcpHost: Send + Sync {
    async fn connect(&self) -> anyhow::Result<Box<dyn AcpConnection>>;
}

#[async_trait]
pub trait AcpConnection: Send {
    async fn request(&mut self, method: &str, params: Value) -> anyhow::Result<Value>;
    async fn start_request(&mut self, method: &str, params: Value) -> anyhow::Result<i64>;
    async fn respond(&mut self, id: i64, result: Value) -> anyhow::Result<()>;
    async fn next(&mut self) -> anyhow::Result<Option<AcpInbound>>;
    async fn close(&mut self) -> anyhow::Result<()>;
}

#[derive(Clone, Debug)]
pub struct AcpStdioHost {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: HashMap<String, String>,
    ephemeral_home: Option<Arc<AcpEphemeralHome>>,
}

#[derive(Debug)]
struct AcpEphemeralHome {
    path: PathBuf,
}

impl Drop for AcpEphemeralHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

impl AcpStdioHost {
    pub fn new(command: impl Into<String>, args: Vec<String>, cwd: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            args,
            cwd: cwd.into(),
            env: HashMap::new(),
            ephemeral_home: None,
        }
    }

    pub fn hermes(cwd: impl Into<String>) -> Self {
        Self::new("hermes", vec!["acp".to_string()], cwd)
    }

    pub fn with_cloudagents_defaults(
        mut self,
        api_key: Option<String>,
        model: Option<String>,
    ) -> anyhow::Result<Self> {
        if let Some(api_key) = api_key.as_deref().filter(|value| !value.is_empty()) {
            let model = model.as_deref().unwrap_or("minimax-m2.7");
            let home = create_cloudagents_hermes_home(api_key, model)?;
            self.env.insert(
                "HERMES_HOME".to_string(),
                home.to_string_lossy().to_string(),
            );
            self.env
                .insert("OPENAI_API_KEY".to_string(), api_key.to_string());
            self.ephemeral_home = Some(Arc::new(AcpEphemeralHome { path: home }));
        }
        self.env.insert(
            "OPENAI_BASE_URL".to_string(),
            CLOUDAGENTS_BASE_URL.to_string(),
        );
        self.env.insert(
            "OPENAI_API_BASE".to_string(),
            CLOUDAGENTS_BASE_URL.to_string(),
        );
        self.env.insert(
            "HERMES_INFERENCE_PROVIDER".to_string(),
            "custom".to_string(),
        );
        if let Some(model) = model {
            self.env
                .insert("HERMES_INFERENCE_MODEL".to_string(), model.clone());
            self.env.insert("OPENAI_MODEL".to_string(), model);
        }
        Ok(self)
    }

    pub fn ephemeral_home_path(&self) -> Option<&std::path::Path> {
        self.ephemeral_home.as_ref().map(|home| home.path.as_path())
    }
}

fn create_cloudagents_hermes_home(api_key: &str, model: &str) -> anyhow::Result<PathBuf> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let counter = ACP_TEMP_HOME_COUNTER.fetch_add(1, Ordering::Relaxed);
    let home = std::env::temp_dir().join(format!(
        "vela-hermes-acp-{}-{nonce}-{counter}",
        std::process::id()
    ));
    fs::create_dir_all(home.join("providers"))?;
    set_owner_only_dir_permissions(&home)?;

    fs::write(
        home.join("config.yaml"),
        format!(
            r#"model:
  default: {model}
  provider: custom
  base_url: {CLOUDAGENTS_BASE_URL}
  api_key: {api_key}
  api_mode: chat_completions
providers:
  custom:
    base_url: {CLOUDAGENTS_BASE_URL}
    api_key: {api_key}
    api_mode: chat_completions
    model: {model}
fallback_providers: []
toolsets: []
agent:
  max_turns: 60
  reasoning_effort: medium
display:
  streaming: true
"#
        ),
    )?;
    fs::write(
        home.join("providers").join("custom.json"),
        serde_json::to_string_pretty(&json!({
            "name": "custom",
            "base_url": CLOUDAGENTS_BASE_URL,
            "api_mode": "chat_completions",
            "context_length": "",
            "models": [
                {
                    "id": model,
                    "name": model
                }
            ]
        }))?,
    )?;
    Ok(home)
}

#[cfg(unix)]
fn set_owner_only_dir_permissions(path: &std::path::Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_owner_only_dir_permissions(_path: &std::path::Path) -> anyhow::Result<()> {
    Ok(())
}

#[async_trait]
impl AcpHost for AcpStdioHost {
    async fn connect(&self) -> anyhow::Result<Box<dyn AcpConnection>> {
        let mut command = Command::new(&self.command);
        command
            .args(&self.args)
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &self.env {
            command.env(key, value);
        }
        let ephemeral_home = self.ephemeral_home.clone();
        let mut child = command.spawn().map_err(|err| {
            anyhow::anyhow!(
                "failed to spawn ACP command `{}` with args {:?}: {}",
                self.command,
                self.args,
                err
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("ACP stdin was not available"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("ACP stdout was not available"))?;
        Ok(Box::new(AcpStdioConnection {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            next_id: 1,
            buffered: VecDeque::new(),
            _ephemeral_home: ephemeral_home,
        }))
    }
}

struct AcpStdioConnection {
    child: Child,
    stdin: ChildStdin,
    lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    next_id: i64,
    buffered: VecDeque<AcpInbound>,
    _ephemeral_home: Option<Arc<AcpEphemeralHome>>,
}

#[async_trait]
impl AcpConnection for AcpStdioConnection {
    async fn request(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        let _id = self.start_request(method, params).await?;
        loop {
            let inbound = self
                .read_one()
                .await?
                .ok_or_else(|| anyhow::anyhow!("ACP process closed while waiting for {method}"))?;
            match inbound {
                AcpInbound::Response(value) => return Ok(value),
                other => self.buffered.push_back(other),
            }
        }
    }

    async fn start_request(&mut self, method: &str, params: Value) -> anyhow::Result<i64> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await?;
        Ok(id)
    }

    async fn respond(&mut self, id: i64, result: Value) -> anyhow::Result<()> {
        self.write(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        }))
        .await
    }

    async fn next(&mut self) -> anyhow::Result<Option<AcpInbound>> {
        if let Some(inbound) = self.buffered.pop_front() {
            return Ok(Some(inbound));
        }
        self.read_one().await
    }

    async fn close(&mut self) -> anyhow::Result<()> {
        let _ = self.stdin.shutdown().await;
        let _ = self.child.kill().await;
        Ok(())
    }
}

impl AcpStdioConnection {
    async fn write(&mut self, value: Value) -> anyhow::Result<()> {
        self.stdin
            .write_all(format!("{}\n", serde_json::to_string(&value)?).as_bytes())
            .await?;
        self.stdin.flush().await?;
        Ok(())
    }

    async fn read_one(&mut self) -> anyhow::Result<Option<AcpInbound>> {
        let Some(line) = self.lines.next_line().await? else {
            return Ok(None);
        };
        let value: Value = serde_json::from_str(&line)?;
        if value.get("id").is_some() && value.get("method").is_none() {
            if let Some(error) = value.get("error") {
                anyhow::bail!("ACP response failed: {error}");
            }
            return Ok(Some(AcpInbound::Response(
                value.get("result").cloned().unwrap_or(Value::Null),
            )));
        }
        if let Some(id) = value.get("id").and_then(Value::as_i64) {
            let method = value
                .get("method")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("ACP request missing method: {value}"))?;
            return Ok(Some(AcpInbound::request(
                id,
                method,
                value.get("params").cloned().unwrap_or(Value::Null),
            )));
        }
        let method = value
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("ACP message missing method: {value}"))?;
        Ok(Some(AcpInbound::notification(
            method,
            value.get("params").cloned().unwrap_or(Value::Null),
        )))
    }
}

#[derive(Clone)]
pub struct AcpBackendAdapter {
    host: Arc<dyn AcpHost>,
    default_cwd: String,
    sessions: Arc<Mutex<HashMap<String, AcpBackendSession>>>,
    pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<AcpPermissionResponse>>>>,
}

struct AcpBackendSession {
    session_id: String,
    connection: Box<dyn AcpConnection>,
}

struct AcpPromptScope {
    fallback_assistant_message_id: String,
    fallback_reasoning_id: String,
}

impl AcpPromptScope {
    fn new(input: &BackendSend, prompt_id: i64) -> Self {
        let scope_id = input
            .turn_id
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("acp_prompt_{prompt_id}"));
        Self {
            fallback_assistant_message_id: format!("assistant:{scope_id}"),
            fallback_reasoning_id: format!("reasoning:{scope_id}"),
        }
    }
}

#[derive(Clone, Debug)]
struct AcpPermissionResponse {
    result: Option<String>,
    options: Option<Value>,
}

impl AcpBackendAdapter {
    pub fn new(host: Arc<dyn AcpHost>, default_cwd: impl Into<String>) -> Self {
        Self {
            host,
            default_cwd: default_cwd.into(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn hermes(default_cwd: impl Into<String>, host: AcpStdioHost) -> Self {
        let default_cwd = default_cwd.into();
        Self::new(Arc::new(host), default_cwd)
    }
}

#[async_trait]
impl BackendAdapter for AcpBackendAdapter {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            streaming: true,
            cancel: false,
            permission_requests: true,
            structured_diff: true,
            session_agent_config: false,
        }
    }

    async fn probe(&self) -> anyhow::Result<crate::BackendProbe> {
        match self.host.connect().await {
            Ok(mut connection) => {
                let result = initialize_acp_connection(connection.as_mut()).await;
                let _ = connection.close().await;
                result.map(|_| crate::BackendProbe {
                    status: BackendStatus::Available,
                    message: None,
                })
            }
            Err(error) => Ok(crate::BackendProbe {
                status: BackendStatus::Unavailable,
                message: Some(error.to_string()),
            }),
        }
    }

    async fn respond_to_request(&self, input: BackendRequestResponse) -> anyhow::Result<()> {
        let responder = self
            .pending_permissions
            .lock()
            .await
            .remove(&input.request_id)
            .ok_or_else(|| anyhow::anyhow!("ACP request {} is not pending", input.request_id))?;
        responder
            .send(AcpPermissionResponse {
                result: input.result,
                options: input.options,
            })
            .map_err(|_| anyhow::anyhow!("ACP request receiver was dropped"))
    }

    async fn stream_user_message(
        &self,
        input: BackendSend,
        sink: BackendOutputSink,
    ) -> anyhow::Result<()> {
        let session_key = input
            .session_id
            .as_ref()
            .map(|id| id.as_str().to_string())
            .unwrap_or_else(|| "__ephemeral__".to_string());
        let mut session = {
            let mut sessions = self.sessions.lock().await;
            sessions.remove(&session_key)
        };

        if session.is_none() {
            let mut connection = self.host.connect().await?;
            initialize_acp_connection(connection.as_mut()).await?;
            let session_response = connection
                .request(
                    "session/new",
                    acp_session_new_params(&input, &self.default_cwd),
                )
                .await?;
            let acp_session_id = read_acp_session_id(&session_response)?;
            session = Some(AcpBackendSession {
                session_id: acp_session_id,
                connection,
            });
        }

        let mut session = session.expect("session initialized");
        let prompt_id = session
            .connection
            .start_request(
                "session/prompt",
                json!({
                    "sessionId": session.session_id,
                    "messageId": acp_prompt_message_id(&input),
                    "prompt": acp_prompt_blocks(&input),
                }),
            )
            .await?;
        let prompt_scope = AcpPromptScope::new(&input, prompt_id);

        loop {
            let Some(inbound) = session.connection.next().await? else {
                break;
            };
            match inbound {
                AcpInbound::Notification { method, params } => {
                    if method == "session/update" {
                        for output in
                            outputs_from_acp_session_update_notification(params, &prompt_scope)
                        {
                            sink.send(output).await?;
                        }
                    } else {
                        sink.send(warning(
                            "unsupported ACP notification",
                            json!({ "method": method, "params": params }),
                        ))
                        .await?;
                    }
                }
                AcpInbound::Request { id, method, params } => {
                    self.handle_acp_request(
                        session.connection.as_mut(),
                        id,
                        &method,
                        params,
                        &sink,
                    )
                    .await?;
                }
                AcpInbound::Response(value) => {
                    let stop_reason = value
                        .get("stopReason")
                        .or_else(|| value.get("stop_reason"))
                        .and_then(Value::as_str)
                        .unwrap_or("completed");
                    match stop_reason {
                        "end_turn" | "completed" => {
                            sink.send(with_raw(
                                EventType::TURN_COMPLETED,
                                json!({ "stop_reason": stop_reason }),
                                value,
                            ))
                            .await?;
                        }
                        "cancelled" | "canceled" => {
                            sink.send(with_raw(
                                EventType::TURN_CANCELLED,
                                json!({ "reason": stop_reason }),
                                value,
                            ))
                            .await?;
                        }
                        _ => {
                            sink.send(warning(
                                "ACP prompt ended with non-completed stop reason",
                                value.clone(),
                            ))
                            .await?;
                            sink.send(with_raw(
                                EventType::TURN_FAILED,
                                json!({
                                    "error": format!("ACP prompt stopped with {stop_reason}"),
                                    "stop_reason": stop_reason,
                                }),
                                value,
                            ))
                            .await?;
                        }
                    }
                    break;
                }
            }
        }

        if session_key != "__ephemeral__" {
            self.sessions.lock().await.insert(session_key, session);
        } else {
            let _ = session.connection.close().await;
        }
        Ok(())
    }
}

async fn initialize_acp_connection(connection: &mut dyn AcpConnection) -> anyhow::Result<()> {
    connection
        .request(
            "initialize",
            json!({
                "protocolVersion": ACP_PROTOCOL_VERSION,
                "clientCapabilities": {
                    "fs": {
                        "readTextFile": true,
                        "writeTextFile": true
                    },
                    "terminal": true
                },
                "clientInfo": {
                    "name": "velachat",
                    "version": "0.1.0"
                }
            }),
        )
        .await?;
    Ok(())
}

fn acp_session_new_params(input: &BackendSend, default_cwd: &str) -> Value {
    json!({
        "cwd": input
            .working_directory
            .clone()
            .unwrap_or_else(|| default_cwd.to_string()),
        "mcpServers": [],
    })
}

fn acp_prompt_message_id(input: &BackendSend) -> String {
    input
        .turn_id
        .as_ref()
        .map(|turn_id| format!("user:{turn_id}"))
        .or_else(|| {
            input
                .session_id
                .as_ref()
                .map(|session_id| format!("user:{}", session_id.as_str()))
        })
        .unwrap_or_else(|| "user:ephemeral".to_string())
}

fn acp_prompt_blocks(input: &BackendSend) -> Vec<Value> {
    let blocks = if input.blocks.is_empty() {
        if input.content.is_empty() {
            Vec::new()
        } else {
            vec![UserMessageBlock::text(input.content.clone())]
        }
    } else {
        input.blocks.clone()
    };

    blocks
        .into_iter()
        .filter_map(|block| match block {
            UserMessageBlock::Text { text } => Some(json!({ "type": "text", "text": text })),
            UserMessageBlock::Image {
                blob:
                    BlobRef::InlineBase64 {
                        data, mime_type, ..
                    },
            } => Some(json!({ "type": "image", "data": data, "mimeType": mime_type })),
            UserMessageBlock::Image {
                blob: BlobRef::Stored { .. },
            } => None,
        })
        .collect()
}

fn read_acp_session_id(response: &Value) -> anyhow::Result<String> {
    response
        .get("sessionId")
        .or_else(|| response.get("session_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("ACP session/new did not return sessionId"))
}

fn outputs_from_acp_session_update_notification(
    params: Value,
    scope: &AcpPromptScope,
) -> Vec<BackendOutput> {
    params
        .get("update")
        .cloned()
        .map(|update| normalize_acp_session_update_with_scope(update, scope))
        .unwrap_or_default()
}

pub fn normalize_acp_session_update(update: Value) -> Vec<BackendOutput> {
    let scope = AcpPromptScope {
        fallback_assistant_message_id: "acp_assistant_message".to_string(),
        fallback_reasoning_id: "acp_reasoning".to_string(),
    };
    normalize_acp_session_update_with_scope(update, &scope)
}

fn normalize_acp_session_update_with_scope(
    update: Value,
    scope: &AcpPromptScope,
) -> Vec<BackendOutput> {
    let update_type = update
        .get("sessionUpdate")
        .or_else(|| update.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    match update_type {
        "agent_message_chunk" => vec![with_raw(
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({
                "message_id": string_at(&update, &["messageId"])
                    .or_else(|| string_at(&update, &["message_id"]))
                    .unwrap_or_else(|| scope.fallback_assistant_message_id.clone()),
                "delta": content_text(update.get("content")),
            }),
            update,
        )],
        "agent_thought_chunk" => vec![with_raw(
            EventType::ASSISTANT_REASONING_DELTA,
            json!({
                "reasoning_id": string_at(&update, &["messageId"])
                    .or_else(|| string_at(&update, &["message_id"]))
                    .unwrap_or_else(|| scope.fallback_reasoning_id.clone()),
                "delta": content_text(update.get("content")),
            }),
            update,
        )],
        "tool_call" => vec![with_raw(
            EventType::TOOL_STARTED,
            json!({
                "tool_id": string_at(&update, &["toolCallId"])
                    .or_else(|| string_at(&update, &["tool_call_id"]))
                    .unwrap_or_else(|| "acp_tool".to_string()),
                "name": string_at(&update, &["title"]).unwrap_or_else(|| "tool".to_string()),
                "kind": update.get("kind").cloned().unwrap_or(Value::Null),
                "status": string_at(&update, &["status"]).unwrap_or_else(|| "started".to_string()),
                "input": update.get("rawInput")
                    .or_else(|| update.get("raw_input"))
                    .cloned()
                    .unwrap_or(Value::Null),
            }),
            update,
        )],
        "tool_call_update" => {
            let event_type = match string_at(&update, &["status"]).as_deref() {
                Some("completed") | Some("success") => EventType::TOOL_COMPLETED,
                Some("failed") | Some("error") => EventType::TOOL_FAILED,
                _ => EventType::TOOL_UPDATED,
            };
            vec![with_raw(
                event_type,
                json!({
                    "tool_id": string_at(&update, &["toolCallId"])
                        .or_else(|| string_at(&update, &["tool_call_id"]))
                        .unwrap_or_else(|| "acp_tool".to_string()),
                    "status": string_at(&update, &["status"]).unwrap_or_else(|| "updated".to_string()),
                    "content": update.get("content").cloned().unwrap_or(Value::Null),
                    "output": update.get("rawOutput")
                        .or_else(|| update.get("raw_output"))
                        .cloned()
                        .unwrap_or(Value::Null),
                }),
                update,
            )]
        }
        "plan" => vec![with_raw(
            EventType::TASK_UPDATED,
            json!({
                "task_type": "plan",
                "steps": update.get("entries")
                    .or_else(|| update.get("plan"))
                    .cloned()
                    .unwrap_or(Value::Null),
            }),
            update,
        )],
        "usage_update" => vec![with_raw(
            EventType::USAGE_UPDATED,
            json!({
                "usage": update.get("usage").cloned().unwrap_or(Value::Null),
            }),
            update,
        )],
        "user_message_chunk"
        | "current_mode_update"
        | "config_option_update"
        | "session_info_update"
        | "available_commands_update" => Vec::new(),
        _ => vec![warning("unsupported ACP session update", update)],
    }
}

impl AcpBackendAdapter {
    async fn handle_acp_request(
        &self,
        connection: &mut dyn AcpConnection,
        id: i64,
        method: &str,
        params: Value,
        sink: &BackendOutputSink,
    ) -> anyhow::Result<()> {
        match method {
            "session/request_permission" | "requestPermission" => {
                let request_id = format!("acp_request_{id}");
                let (response_tx, response_rx) = oneshot::channel();
                self.pending_permissions
                    .lock()
                    .await
                    .insert(request_id.clone(), response_tx);
                sink.send(with_raw(
                    EventType::REQUEST_OPENED,
                    json!({
                        "request_id": request_id,
                        "kind": "permission",
                        "request_type": "tool_confirmation",
                        "title": "Approve agent action",
                        "options": params.get("options").cloned().unwrap_or(Value::Null),
                        "tool_call": params.get("toolCall")
                            .or_else(|| params.get("tool_call"))
                            .cloned()
                            .unwrap_or(Value::Null),
                        "backend_ref": {
                            "id": id,
                            "method": method,
                        },
                    }),
                    json!({ "method": method, "params": params.clone() }),
                ))
                .await?;

                let response = response_rx.await.unwrap_or(AcpPermissionResponse {
                    result: Some("cancel".to_string()),
                    options: None,
                });
                self.pending_permissions.lock().await.remove(&request_id);
                connection
                    .respond(id, acp_permission_response_payload(&params, response))
                    .await
            }
            "readTextFile" => connection.respond(id, json!({ "content": "" })).await,
            "writeTextFile"
            | "createTerminal"
            | "terminalOutput"
            | "waitForTerminalExit"
            | "killTerminal" => {
                connection
                    .respond(
                        id,
                        json!({ "error": "unsupported_by_velachat_acp_adapter" }),
                    )
                    .await
            }
            _ => {
                sink.send(warning(
                    "unsupported ACP request",
                    json!({ "id": id, "method": method, "params": params }),
                ))
                .await?;
                connection
                    .respond(id, json!({ "outcome": { "outcome": "cancelled" } }))
                    .await
            }
        }
    }
}

fn with_raw(event_type: EventType, payload: Value, raw: Value) -> BackendOutput {
    BackendOutput {
        event_type,
        payload,
        raw: Some(raw),
    }
}

fn warning(message: impl Into<String>, raw: Value) -> BackendOutput {
    BackendOutput {
        event_type: EventType::WARNING_RAISED,
        payload: json!({
            "code": "acp_warning",
            "message": message.into(),
        }),
        raw: Some(raw),
    }
}

fn acp_permission_response_payload(params: &Value, response: AcpPermissionResponse) -> Value {
    let decision = match response.result.as_deref() {
        Some("allow") | Some("approve") | Some("approved") | Some("yes") => "selected",
        _ => "cancelled",
    };
    if decision == "selected" {
        let option_id = response
            .options
            .as_ref()
            .and_then(|options| options.get("option_id").or_else(|| options.get("optionId")))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                params
                    .get("options")
                    .and_then(Value::as_array)
                    .and_then(|options| options.first())
                    .and_then(|option| option.get("optionId").or_else(|| option.get("option_id")))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "allow".to_string());
        json!({ "outcome": { "outcome": "selected", "optionId": option_id } })
    } else {
        json!({ "outcome": { "outcome": "cancelled" } })
    }
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(str::to_string)
}

fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Object(object)) => content_block_text(object),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|part| content_text(Some(part)))
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn content_block_text(object: &Map<String, Value>) -> String {
    object
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| object.get("content").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

#[allow(dead_code)]
fn permission_mode_label(mode: Option<PermissionMode>) -> &'static str {
    match mode {
        Some(PermissionMode::ReadOnly) => "read_only",
        Some(PermissionMode::Auto) | None => "auto",
        Some(PermissionMode::AutoReview) => "auto_review",
        Some(PermissionMode::FullAccess) => "full_access",
    }
}
