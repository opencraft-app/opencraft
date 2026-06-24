use super::{
    capabilities::{
        codex_reasoning_effort_options, initialize_params, thread_start_params, turn_start_params,
    },
    events::warning,
    normalizer::normalize_codex_app_server_notification,
    permissions::{
        CodexPermissionResponse, codex_cancel_response_payload, codex_permission_request_output,
        codex_permission_response_payload,
    },
    transport::{
        AppServerInbound, CodexAppServerConnection, CodexAppServerHost, CodexStdioAppServerHost,
    },
};
use crate::{
    BackendAdapter, BackendCancel, BackendOutput, BackendOutputSink, BackendRequestResponse,
    BackendSend,
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{Mutex, oneshot};
use vela_core::{BackendModel, EventType};

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
    async fn list_models(
        &self,
        _backend: Option<vela_core::BackendKind>,
    ) -> anyhow::Result<Vec<BackendModel>> {
        let mut connection = self.host.connect().await?;
        initialize_connection(connection.as_mut()).await?;
        let response = connection.request("model/list", json!({})).await?;
        connection.close().await?;
        Ok(parse_model_list_response(&response))
    }

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
        let turn_params = turn_start_params(&input, &session.thread_id);
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
                        AppServerInbound::Request(request) => {
                            let outcome = self.handle_request(
                                session.connection.as_mut(),
                                request.id,
                                &request.method,
                                request.params,
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
        .request("initialize", initialize_params())
        .await?;
    connection.notify("initialized", json!({})).await
}

fn parse_model_list_response(response: &Value) -> Vec<BackendModel> {
    response
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(parse_model_entry)
        .collect()
}

fn parse_model_entry(entry: &Value) -> Option<BackendModel> {
    let id = entry.get("id").and_then(Value::as_str)?.trim();
    if id.is_empty() {
        return None;
    }
    let default_reasoning_effort = entry
        .get("defaultReasoningEffort")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let reasoning_efforts = parse_supported_reasoning_efforts(entry, default_reasoning_effort);
    let label = entry
        .get("displayName")
        .or_else(|| entry.get("label"))
        .or_else(|| entry.get("name"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(id)
        .to_string();
    let description = entry
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_string);
    let is_default = entry
        .get("isDefault")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(BackendModel {
        id: id.to_string(),
        label,
        description,
        is_default,
        reasoning_efforts,
        metadata: serde_json::from_value(entry.clone()).unwrap_or_default(),
    })
}

fn parse_supported_reasoning_efforts(
    entry: &Value,
    default_id: Option<&str>,
) -> Vec<vela_core::ReasoningEffortOption> {
    let Some(values) = entry
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
    else {
        return codex_reasoning_effort_options(default_id);
    };
    let parsed = values
        .iter()
        .filter_map(|value| {
            let id = value
                .get("reasoningEffort")
                .or_else(|| value.get("id"))
                .and_then(Value::as_str)?
                .trim();
            if id.is_empty() {
                return None;
            }
            let label = value
                .get("label")
                .and_then(Value::as_str)
                .filter(|label| !label.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| id.to_string());
            let description = value
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string);
            Some(vela_core::ReasoningEffortOption {
                id: id.to_string(),
                label,
                description,
                is_default: default_id == Some(id),
                metadata: serde_json::from_value(value.clone()).unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    if parsed.is_empty() {
        codex_reasoning_effort_options(default_id)
    } else {
        parsed
    }
}

fn read_thread_id(response: &Value) -> anyhow::Result<String> {
    response
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("Codex app-server thread/start did not return thread.id"))
}
