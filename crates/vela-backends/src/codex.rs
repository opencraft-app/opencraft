use crate::{
    BackendAdapter, BackendCancel, BackendOutput, BackendOutputSink, BackendRequestResponse,
    BackendSend,
};
use async_trait::async_trait;
use serde_json::{Map, Value, json};
use std::{collections::HashMap, collections::VecDeque, process::Stdio, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, oneshot},
};
use vela_core::{EventType, PermissionMode};

#[derive(Clone, Debug, PartialEq)]
pub enum AppServerInbound {
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

impl AppServerInbound {
    pub fn response(value: Value) -> Self {
        Self::Response(value)
    }

    pub fn notification(method: impl Into<String>, params: Value) -> Self {
        Self::Notification {
            method: method.into(),
            params,
        }
    }

    pub fn request(id: i64, method: impl Into<String>, params: Value) -> Self {
        Self::Request {
            id,
            method: method.into(),
            params,
        }
    }
}

#[async_trait]
pub trait CodexAppServerHost: Send + Sync {
    async fn connect(&self) -> anyhow::Result<Box<dyn CodexAppServerConnection>>;
}

#[async_trait]
pub trait CodexAppServerConnection: Send {
    async fn request(&mut self, method: &str, params: Value) -> anyhow::Result<Value>;
    async fn notify(&mut self, method: &str, params: Value) -> anyhow::Result<()>;
    async fn respond(&mut self, id: i64, result: Value) -> anyhow::Result<()>;
    async fn next(&mut self) -> anyhow::Result<Option<AppServerInbound>>;
    async fn close(&mut self) -> anyhow::Result<()>;
}

#[derive(Clone, Debug)]
pub struct CodexStdioAppServerHost {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
}

impl CodexStdioAppServerHost {
    pub fn new(cwd: impl Into<String>) -> Self {
        Self {
            command: "codex".to_string(),
            args: vec!["app-server".to_string(), "--stdio".to_string()],
            cwd: cwd.into(),
        }
    }
}

#[async_trait]
impl CodexAppServerHost for CodexStdioAppServerHost {
    async fn connect(&self) -> anyhow::Result<Box<dyn CodexAppServerConnection>> {
        let mut child = Command::new(&self.command)
            .args(&self.args)
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("Codex app-server stdin was not available"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("Codex app-server stdout was not available"))?;
        Ok(Box::new(StdioAppServerConnection {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            next_id: 1,
            buffered: VecDeque::new(),
        }))
    }
}

struct StdioAppServerConnection {
    child: Child,
    stdin: ChildStdin,
    lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    next_id: i64,
    buffered: VecDeque<AppServerInbound>,
}

#[async_trait]
impl CodexAppServerConnection for StdioAppServerConnection {
    async fn request(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({ "id": id, "method": method, "params": params }))
            .await?;
        loop {
            let inbound = self.read_one().await?.ok_or_else(|| {
                anyhow::anyhow!("Codex app-server closed while waiting for {method}")
            })?;
            match inbound {
                AppServerInbound::Response(value)
                    if value.get("id").and_then(Value::as_i64) == Some(id) =>
                {
                    if let Some(error) = value.get("error") {
                        anyhow::bail!("Codex app-server {method} failed: {error}");
                    }
                    return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                }
                other => self.buffered.push_back(other),
            }
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> anyhow::Result<()> {
        self.write(json!({ "method": method, "params": params }))
            .await
    }

    async fn respond(&mut self, id: i64, result: Value) -> anyhow::Result<()> {
        self.write(json!({ "id": id, "result": result })).await
    }

    async fn next(&mut self) -> anyhow::Result<Option<AppServerInbound>> {
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

impl StdioAppServerConnection {
    async fn write(&mut self, value: Value) -> anyhow::Result<()> {
        self.stdin
            .write_all(format!("{}\n", serde_json::to_string(&value)?).as_bytes())
            .await?;
        self.stdin.flush().await?;
        Ok(())
    }

    async fn read_one(&mut self) -> anyhow::Result<Option<AppServerInbound>> {
        let Some(line) = self.lines.next_line().await? else {
            return Ok(None);
        };
        let value: Value = serde_json::from_str(&line)?;
        if let Some(id) = value.get("id").and_then(Value::as_i64) {
            if let Some(method) = value.get("method").and_then(Value::as_str) {
                return Ok(Some(AppServerInbound::request(
                    id,
                    method,
                    value.get("params").cloned().unwrap_or(Value::Null),
                )));
            }
            return Ok(Some(AppServerInbound::Response(value)));
        }
        let method = value
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Codex app-server message missing method: {value}"))?;
        Ok(Some(AppServerInbound::notification(
            method,
            value.get("params").cloned().unwrap_or(Value::Null),
        )))
    }
}

#[derive(Clone)]
pub struct CodexAppServerBackendAdapter {
    host: Arc<dyn CodexAppServerHost>,
    default_cwd: String,
    sessions: Arc<Mutex<HashMap<String, CodexAppServerSession>>>,
    active_turns: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<CodexPermissionResponse>>>>,
}

struct CodexAppServerSession {
    thread_id: String,
    connection: Box<dyn CodexAppServerConnection>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CodexRequestOutcome {
    Continue,
    Cancelled,
}

#[derive(Clone, Debug)]
struct CodexPermissionResponse {
    result: Option<String>,
    scope: Option<String>,
    answer: Option<String>,
    content: Option<Value>,
    options: Option<Value>,
}

impl CodexAppServerBackendAdapter {
    pub fn new(host: Arc<dyn CodexAppServerHost>, default_cwd: impl Into<String>) -> Self {
        Self {
            host,
            default_cwd: default_cwd.into(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            active_turns: Arc::new(Mutex::new(HashMap::new())),
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn stdio(default_cwd: impl Into<String>) -> Self {
        let default_cwd = default_cwd.into();
        Self::new(
            Arc::new(CodexStdioAppServerHost::new(&default_cwd)),
            default_cwd,
        )
    }
}

#[async_trait]
impl BackendAdapter for CodexAppServerBackendAdapter {
    async fn cancel(&self, input: BackendCancel) -> anyhow::Result<()> {
        if let Some(cancel) = self.active_turns.lock().await.remove(&input.session_id) {
            let _ = cancel.send(());
        }
        Ok(())
    }

    async fn respond_to_request(&self, input: BackendRequestResponse) -> anyhow::Result<()> {
        let responder = self
            .pending_permissions
            .lock()
            .await
            .remove(&input.request_id)
            .ok_or_else(|| anyhow::anyhow!("Codex request {} is not pending", input.request_id))?;
        responder
            .send(CodexPermissionResponse {
                result: input.result,
                scope: input.scope,
                answer: input.answer,
                content: input.content,
                options: input.options,
            })
            .map_err(|_| anyhow::anyhow!("Codex request receiver was dropped"))
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
            initialize_connection(connection.as_mut()).await?;
            let thread = connection
                .request(
                    "thread/start",
                    thread_start_params(&input, &self.default_cwd),
                )
                .await?;
            let thread_id = read_thread_id(&thread)?;
            session = Some(CodexAppServerSession {
                thread_id,
                connection,
            });
        }

        let mut session = session.expect("session initialized");
        let turn_params = json!({
            "threadId": session.thread_id,
            "input": [{
                "type": "text",
                "text": input.content,
            }],
        });
        session
            .connection
            .request("turn/start", turn_params)
            .await?;

        let (cancel_tx, mut cancel_rx) = oneshot::channel();
        if session_key != "__ephemeral__" {
            self.active_turns
                .lock()
                .await
                .insert(session_key.clone(), cancel_tx);
        }

        let mut completed = false;
        let mut cancelled = false;
        loop {
            tokio::select! {
                _ = &mut cancel_rx => {
                    session
                        .connection
                        .request("turn/interrupt", json!({ "threadId": session.thread_id.clone() }))
                        .await?;
                    sink.send(BackendOutput::event(
                        EventType::TURN_CANCELLED,
                        json!({ "reason": "user_cancelled" }),
                    ))
                    .await?;
                    cancelled = true;
                    break;
                }
                inbound = session.connection.next() => {
                    let Some(inbound) = inbound? else {
                        break;
                    };
                    match inbound {
                        AppServerInbound::Notification { method, params } => {
                            let outputs = normalize_codex_app_server_notification(&method, params);
                            completed = outputs.iter().any(|output| {
                                output.event_type == EventType::TURN_COMPLETED
                                    || output.event_type == EventType::TURN_FAILED
                            });
                            for output in outputs {
                                sink.send(output).await?;
                            }
                            if completed {
                                break;
                            }
                        }
                        AppServerInbound::Request { id, method, params } => {
                            let outcome = self.handle_request(
                                &session_key,
                                session.connection.as_mut(),
                                id,
                                &method,
                                params,
                                &sink,
                                &mut cancel_rx,
                                session.thread_id.clone(),
                            )
                            .await?;
                            if outcome == CodexRequestOutcome::Cancelled {
                                cancelled = true;
                                break;
                            }
                        }
                        AppServerInbound::Response(value) => {
                            sink.send(warning("unexpected Codex app-server response", value))
                                .await?;
                        }
                    }
                }
            }
        }
        self.active_turns.lock().await.remove(&session_key);

        if completed && !cancelled && session_key != "__ephemeral__" {
            self.sessions.lock().await.insert(session_key, session);
        } else {
            let _ = session.connection.close().await;
        }
        Ok(())
    }
}

impl CodexAppServerBackendAdapter {
    async fn handle_request(
        &self,
        _session_key: &str,
        connection: &mut dyn CodexAppServerConnection,
        id: i64,
        method: &str,
        params: Value,
        sink: &BackendOutputSink,
        cancel_rx: &mut oneshot::Receiver<()>,
        thread_id: String,
    ) -> anyhow::Result<CodexRequestOutcome> {
        let Some(output) = codex_permission_request_output(id, method, params.clone()) else {
            connection
                .respond(id, json!({ "decision": "decline" }))
                .await?;
            sink.send(warning(
                format!("unsupported Codex app-server request {method}"),
                json!({ "id": id, "method": method, "params": params }),
            ))
            .await?;
            return Ok(CodexRequestOutcome::Continue);
        };

        let request_id = output
            .payload
            .get("request_id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Codex permission request missing request_id"))?
            .to_string();
        let (response_tx, response_rx) = oneshot::channel();
        self.pending_permissions
            .lock()
            .await
            .insert(request_id.clone(), response_tx);
        sink.send(output).await?;

        let response = tokio::select! {
            response = response_rx => {
                match response {
                    Ok(response) => response,
                    Err(_) => CodexPermissionResponse {
                        result: Some("cancel".to_string()),
                        scope: None,
                        answer: None,
                        content: None,
                        options: None,
                    },
                }
            }
            _ = cancel_rx => {
                self.pending_permissions.lock().await.remove(&request_id);
                connection
                    .respond(id, codex_cancel_response_payload(method))
                    .await?;
                connection
                    .request("turn/interrupt", json!({ "threadId": thread_id }))
                    .await?;
                sink.send(BackendOutput::event(
                    EventType::TURN_CANCELLED,
                    json!({ "reason": "user_cancelled" }),
                ))
                .await?;
                return Ok(CodexRequestOutcome::Cancelled);
            }
        };
        self.pending_permissions.lock().await.remove(&request_id);
        connection
            .respond(
                id,
                codex_permission_response_payload(method, &params, response),
            )
            .await?;
        Ok(CodexRequestOutcome::Continue)
    }
}

async fn initialize_connection(
    connection: &mut dyn CodexAppServerConnection,
) -> anyhow::Result<()> {
    connection
        .request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "velachat",
                    "title": "VelaChat",
                    "version": "0.1.0",
                },
                "capabilities": {
                    "experimentalApi": true,
                },
            }),
        )
        .await?;
    connection.notify("initialized", json!({})).await
}

fn thread_start_params(input: &BackendSend, default_cwd: &str) -> Value {
    let config = input
        .resolved_agent_config
        .as_ref()
        .map(|resolved| &resolved.config);
    let mut params = Map::new();
    params.insert(
        "cwd".to_string(),
        Value::String(
            input
                .working_directory
                .clone()
                .unwrap_or_else(|| default_cwd.to_string()),
        ),
    );
    if let Some(model) = config.and_then(|config| config.model.clone()) {
        params.insert("model".to_string(), Value::String(model));
    }
    if let Some(reasoning_effort) = config.and_then(|config| config.reasoning_effort.clone()) {
        params.insert(
            "reasoningEffort".to_string(),
            Value::String(reasoning_effort),
        );
    }
    let (sandbox, approval_policy, network_access) =
        match config.and_then(|config| config.permission_mode) {
            Some(PermissionMode::ReadOnly) => ("read-only", "on-request", false),
            Some(PermissionMode::FullAccess) => ("danger-full-access", "never", true),
            Some(PermissionMode::AutoReview) => ("workspace-write", "on-request", false),
            Some(PermissionMode::Auto) | None => ("workspace-write", "on-request", false),
        };
    params.insert("sandbox".to_string(), Value::String(sandbox.to_string()));
    params.insert(
        "approvalPolicy".to_string(),
        Value::String(approval_policy.to_string()),
    );
    params.insert("networkAccess".to_string(), Value::Bool(network_access));
    if matches!(
        config.and_then(|config| config.permission_mode),
        Some(PermissionMode::AutoReview)
    ) {
        params.insert(
            "approvalsReviewer".to_string(),
            Value::String("auto_review".to_string()),
        );
    }
    Value::Object(params)
}

fn read_thread_id(response: &Value) -> anyhow::Result<String> {
    response
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("Codex app-server thread/start did not return thread.id"))
}

fn codex_permission_request_output(id: i64, method: &str, params: Value) -> Option<BackendOutput> {
    let request_id = format!("codex_request_{id}");
    let backend_ref = json!({
        "id": id,
        "method": method,
    });
    match method {
        "item/commandExecution/requestApproval" => Some(with_raw(
            EventType::REQUEST_OPENED,
            json!({
                "request_id": request_id,
                "kind": "permission",
                "request_type": "tool_confirmation",
                "title": "Approve command",
                "command": string_at(&params, &["command"])
                    .unwrap_or_else(|| display_value(params.get("command").unwrap_or(&Value::Null))),
                "cwd": params.get("cwd").cloned().unwrap_or(Value::Null),
                "scope_options": ["once", "session"],
                "backend_ref": backend_ref,
            }),
            method,
            params,
        )),
        "execCommandApproval" => Some(with_raw(
            EventType::REQUEST_OPENED,
            json!({
                "request_id": request_id,
                "kind": "permission",
                "request_type": "tool_confirmation",
                "title": "Approve command",
                "command": display_value(params.get("command").unwrap_or(&Value::Null)),
                "cwd": params.get("cwd").cloned().unwrap_or(Value::Null),
                "scope_options": ["once", "session"],
                "backend_ref": backend_ref,
            }),
            method,
            params,
        )),
        "item/fileChange/requestApproval" | "applyPatchApproval" => Some(with_raw(
            EventType::REQUEST_OPENED,
            json!({
                "request_id": request_id,
                "kind": "permission",
                "request_type": "tool_confirmation",
                "title": "Approve file changes",
                "files": params.get("files")
                    .or_else(|| params.get("fileChanges"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "grant_root": params.get("grantRoot").cloned().unwrap_or(Value::Null),
                "scope_options": ["once", "session"],
                "backend_ref": backend_ref,
            }),
            method,
            params,
        )),
        "item/permissions/requestApproval" => Some(with_raw(
            EventType::REQUEST_OPENED,
            json!({
                "request_id": request_id,
                "kind": "permission",
                "request_type": "tool_confirmation",
                "title": "Approve permissions",
                "description": string_at(&params, &["reason"]),
                "cwd": params.get("cwd").cloned().unwrap_or(Value::Null),
                "permissions": params.get("permissions").cloned().unwrap_or(Value::Null),
                "scope_options": ["once", "session"],
                "backend_ref": backend_ref,
            }),
            method,
            params,
        )),
        "item/tool/requestUserInput" | "tool/requestUserInput" => Some(with_raw(
            EventType::REQUEST_OPENED,
            json!({
                "request_id": request_id,
                "kind": "question",
                "request_type": "request_answer",
                "title": "Answer agent request",
                "prompt": string_at(&params, &["prompt"])
                    .or_else(|| string_at(&params, &["message"]))
                    .unwrap_or_default(),
                "backend_ref": backend_ref,
            }),
            method,
            params,
        )),
        "mcpServer/elicitation/request" => Some(with_raw(
            EventType::REQUEST_OPENED,
            json!({
                "request_id": request_id,
                "kind": "question",
                "request_type": "request_answer",
                "title": "MCP server request",
                "server_name": string_at(&params, &["serverName"]),
                "prompt": string_at(&params, &["message"]).unwrap_or_default(),
                "schema": params.get("requestedSchema").cloned().unwrap_or(Value::Null),
                "mode": params.get("mode").cloned().unwrap_or(Value::Null),
                "url": params.get("url").cloned().unwrap_or(Value::Null),
                "backend_ref": backend_ref,
            }),
            method,
            params,
        )),
        "item/tool/call" => Some(with_raw(
            EventType::REQUEST_OPENED,
            json!({
                "request_id": request_id,
                "kind": "tool_call",
                "request_type": "custom_tool_result",
                "title": "Run client tool",
                "tool": string_at(&params, &["tool"]).unwrap_or_else(|| "tool".to_string()),
                "namespace": params.get("namespace").cloned().unwrap_or(Value::Null),
                "arguments": params.get("arguments").cloned().unwrap_or(Value::Null),
                "backend_ref": backend_ref,
            }),
            method,
            params,
        )),
        _ => None,
    }
}

fn codex_cancel_response_payload(method: &str) -> Value {
    match method {
        "mcpServer/elicitation/request" => json!({ "action": "cancel" }),
        "item/permissions/requestApproval" => json!({
            "permissions": {},
            "scope": "turn",
        }),
        "item/tool/call" => json!({
            "success": false,
            "contentItems": [],
        }),
        _ => json!({ "decision": "cancel" }),
    }
}

fn codex_permission_response_payload(
    method: &str,
    params: &Value,
    response: CodexPermissionResponse,
) -> Value {
    let decision = match response.result.as_deref() {
        Some("allow") | Some("approve") | Some("approved") | Some("yes") => "accept",
        Some("deny") | Some("denied") | Some("no") => "decline",
        Some("cancel") | Some("cancelled") | Some("interrupt") => "cancel",
        _ if response.answer.is_some() => "accept",
        _ => "decline",
    };
    match method {
        "mcpServer/elicitation/request" => json!({
            "action": decision,
            "content": response_content_json(&response),
        }),
        "item/permissions/requestApproval" => json!({
            "permissions": response.options
                .as_ref()
                .and_then(|options| options.get("permissions"))
                .cloned()
                .or_else(|| params.get("permissions").cloned())
                .unwrap_or_else(|| json!({})),
            "scope": response.scope.unwrap_or_else(|| "turn".to_string()),
            "strictAutoReview": response.options
                .as_ref()
                .and_then(|options| options.get("strict_auto_review"))
                .cloned()
                .unwrap_or(Value::Null),
        }),
        "item/tool/call" => json!({
            "success": decision == "accept",
            "contentItems": dynamic_tool_content_items(response.content.as_ref()),
        }),
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => json!({
            "decision": scoped_decision(decision, response.scope.as_deref()),
        }),
        "execCommandApproval" | "applyPatchApproval" => json!({
            "decision": decision,
        }),
        _ => json!({
            "decision": scoped_decision(decision, response.scope.as_deref()),
        }),
    }
}

fn scoped_decision(decision: &str, scope: Option<&str>) -> Value {
    if decision == "accept" && scope == Some("session") {
        Value::String("acceptForSession".to_string())
    } else {
        Value::String(decision.to_string())
    }
}

fn response_content_json(response: &CodexPermissionResponse) -> Value {
    if let Some(content) = &response.content {
        return content.clone();
    }
    let Some(answer) = &response.answer else {
        return Value::Null;
    };
    serde_json::from_str(answer).unwrap_or_else(|_| Value::String(answer.clone()))
}

fn dynamic_tool_content_items(content: Option<&Value>) -> Value {
    let Some(Value::Array(parts)) = content else {
        return json!([]);
    };
    Value::Array(
        parts
            .iter()
            .filter_map(|part| {
                let part_type = string_at(part, &["type"])?;
                match part_type.as_str() {
                    "text" => Some(json!({
                        "type": "inputText",
                        "text": string_at(part, &["text"]).unwrap_or_default(),
                    })),
                    "image_ref" => Some(json!({
                        "type": "inputImage",
                        "imageUrl": string_at(part, &["uri"]).unwrap_or_default(),
                    })),
                    _ => None,
                }
            })
            .collect(),
    )
}

pub fn normalize_codex_app_server_notification(method: &str, params: Value) -> Vec<BackendOutput> {
    if is_codex_control_plane_notification(method) {
        tracing::trace!(
            target: "vela_backends::codex",
            method,
            params = %params,
            "absorbed Codex app-server control-plane notification"
        );
        return Vec::new();
    }

    match method {
        "thread/started"
        | "turn/started"
        | "item/started"
        | "item/completed"
        | "codex/event/item_started"
        | "codex/event/item_completed" => Vec::new(),
        "turn/plan/updated" => vec![with_raw(
            EventType::TASK_UPDATED,
            json!({
                "task_type": "plan",
                "status": "updated",
                "steps": params.get("plan").cloned().unwrap_or_else(|| json!([])),
            }),
            method,
            params,
        )],
        "thread/compacted" => vec![with_raw(
            EventType::TASK_UPDATED,
            json!({
                "task_type": "context_compaction",
                "status": "completed",
                "thread_id": params.get("threadId").cloned().unwrap_or(Value::Null),
                "turn_id": params.get("turnId").cloned().unwrap_or(Value::Null),
            }),
            method,
            params,
        )],
        "item/agentMessage/delta" => {
            let delta = string_at(&params, &["delta"]).unwrap_or_default();
            vec![with_raw(
                EventType::ASSISTANT_MESSAGE_DELTA,
                json!({
                    "message_id": string_at(&params, &["itemId"]).unwrap_or_else(|| "codex_message".to_string()),
                    "delta": delta,
                }),
                method,
                params,
            )]
        }
        "item/reasoning/summaryTextDelta" => vec![with_raw(
            EventType::ASSISTANT_REASONING_DELTA,
            json!({
                "reasoning_id": string_at(&params, &["itemId"]).unwrap_or_else(|| "codex_reasoning".to_string()),
                "delta": string_at(&params, &["delta"]).unwrap_or_default(),
            }),
            method,
            params,
        )],
        "codex/event/exec_command_begin" => {
            let msg = params.get("msg").cloned().unwrap_or(Value::Null);
            vec![with_raw(
                EventType::COMMAND_STARTED,
                json!({
                    "command_id": string_at(&msg, &["call_id"]).unwrap_or_else(|| "codex_command".to_string()),
                    "command": display_value(msg.get("command").unwrap_or(&Value::Null)),
                    "cwd": msg.get("cwd").cloned().unwrap_or(Value::Null),
                    "status": "running",
                }),
                method,
                params,
            )]
        }
        "codex/event/exec_command_output_delta" => {
            let msg = params.get("msg").cloned().unwrap_or(Value::Null);
            vec![with_raw(
                EventType::COMMAND_OUTPUT_DELTA,
                json!({
                    "command_id": string_at(&msg, &["call_id"]).unwrap_or_else(|| "codex_command".to_string()),
                    "stream": string_at(&msg, &["stream"]).unwrap_or_else(|| "stdout".to_string()),
                    "delta": string_at(&msg, &["chunk"]).or_else(|| string_at(&msg, &["delta"])).unwrap_or_default(),
                }),
                method,
                params,
            )]
        }
        "codex/event/exec_command_end" => {
            let msg = params.get("msg").cloned().unwrap_or(Value::Null);
            let success = msg.get("success").and_then(Value::as_bool).unwrap_or(true);
            vec![with_raw(
                if success {
                    EventType::COMMAND_COMPLETED
                } else {
                    EventType::COMMAND_FAILED
                },
                json!({
                    "command_id": string_at(&msg, &["call_id"]).unwrap_or_else(|| "codex_command".to_string()),
                    "command": display_value(msg.get("command").unwrap_or(&Value::Null)),
                    "output": string_at(&msg, &["aggregated_output"])
                        .or_else(|| string_at(&msg, &["aggregatedOutput"]))
                        .or_else(|| string_at(&msg, &["formatted_output"]))
                        .or_else(|| string_at(&msg, &["stdout"]))
                        .unwrap_or_default(),
                    "stderr": string_at(&msg, &["stderr"]),
                    "exit_code": msg.get("exit_code").or_else(|| msg.get("exitCode")).cloned().unwrap_or(Value::Null),
                    "status": if success { "completed" } else { "failed" },
                }),
                method,
                params,
            )]
        }
        "turn/diff/updated" => vec![with_raw(
            EventType::DIFF_UPDATED,
            json!({ "diff": string_at(&params, &["diff"]).unwrap_or_default() }),
            method,
            params,
        )],
        "thread/tokenUsage/updated" => vec![with_raw(
            EventType::USAGE_UPDATED,
            json!({ "usage": params.get("tokenUsage").cloned().unwrap_or(Value::Null) }),
            method,
            params,
        )],
        "turn/completed" => {
            let turn = params.get("turn").cloned().unwrap_or(Value::Null);
            let status = string_at(&turn, &["status"]).unwrap_or_else(|| "completed".to_string());
            let success = matches!(
                status.as_str(),
                "completed" | "success" | "succeeded" | "ok"
            );
            vec![with_raw(
                if success {
                    EventType::TURN_COMPLETED
                } else {
                    EventType::TURN_FAILED
                },
                if success {
                    json!({ "status": status })
                } else {
                    json!({
                        "status": status,
                        "error": turn
                            .get("error")
                            .and_then(|error| error.get("message"))
                            .and_then(Value::as_str)
                            .unwrap_or("Codex turn failed"),
                    })
                },
                method,
                params,
            )]
        }
        _ => vec![warning(
            format!("unknown Codex app-server notification {method}"),
            json!({ "method": method, "params": params }),
        )],
    }
}

fn is_codex_control_plane_notification(method: &str) -> bool {
    matches!(
        method,
        "remoteControl/status/changed"
            | "mcpServer/startupStatus/updated"
            | "thread/status/changed"
            | "account/rateLimits/updated"
            | "warning"
            | "error"
    )
}

fn with_raw(event_type: EventType, payload: Value, method: &str, params: Value) -> BackendOutput {
    BackendOutput {
        event_type,
        payload,
        raw: Some(json!({ "method": method, "params": params })),
    }
}

fn warning(message: impl Into<String>, raw: Value) -> BackendOutput {
    BackendOutput {
        event_type: EventType::WARNING_RAISED,
        payload: json!({
            "code": "codex_app_server_warning",
            "message": message.into(),
        }),
        raw: Some(raw),
    }
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(str::to_string)
}

fn display_value(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(display_value)
            .collect::<Vec<_>>()
            .join(" "),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}
