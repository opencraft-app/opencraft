use chrono::Utc;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, sync::Arc};
use tokio::sync::Mutex;
use vela_backends::{
    BackendAdapter, BackendCancel, BackendCapabilities, BackendProbe, BackendRequestResponse,
    BackendSend, backend_output_channel,
};
use vela_core::{
    AgentConfig, BackendKind, CanonicalEvent, CommandAck, CommandId, EventId, EventSource,
    EventType, ResolvedAgentConfig, SessionId, TurnId, UserMessageBlock,
};
use vela_observability::{ManualSpan, ObservabilityStore, TraceContext};
use vela_store::{AppendResult, SqliteEventStore};

type EventObserver = Arc<dyn Fn(CanonicalEvent) + Send + Sync>;

pub struct Runtime<B> {
    store: Arc<SqliteEventStore>,
    backend: Arc<B>,
    running: Arc<Mutex<HashSet<SessionId>>>,
    event_observer: Option<EventObserver>,
    observability: Option<ObservabilityStore>,
}

impl<B> Clone for Runtime<B> {
    fn clone(&self) -> Self {
        Self {
            store: self.store.clone(),
            backend: self.backend.clone(),
            running: self.running.clone(),
            event_observer: self.event_observer.clone(),
            observability: self.observability.clone(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SendUserMessage {
    pub session_id: SessionId,
    pub idempotency_key: String,
    pub content: String,
    pub command_id: Option<vela_core::CommandId>,
}

impl<B> Runtime<B>
where
    B: BackendAdapter + 'static,
{
    pub fn new(store: Arc<SqliteEventStore>, backend: Arc<B>) -> Self {
        Self {
            store,
            backend,
            running: Arc::new(Mutex::new(HashSet::new())),
            event_observer: None,
            observability: None,
        }
    }

    pub fn with_event_observer(mut self, observer: EventObserver) -> Self {
        self.event_observer = Some(observer);
        self
    }

    pub fn with_observability(mut self, observability: ObservabilityStore) -> Self {
        self.observability = Some(observability);
        self
    }

    pub async fn create_session(
        &self,
        session_id: SessionId,
        backend: BackendKind,
        working_directory: &str,
    ) -> anyhow::Result<AppendResult> {
        self.create_session_with_details(session_id, backend, working_directory, None, None, None)
            .await
    }

    pub async fn create_session_with_details(
        &self,
        session_id: SessionId,
        backend: BackendKind,
        working_directory: &str,
        title: Option<&str>,
        model: Option<&str>,
        metadata: Option<serde_json::Value>,
    ) -> anyhow::Result<AppendResult> {
        self.create_session_with_agent_config(
            session_id,
            backend,
            working_directory,
            title,
            AgentConfig::with_model(model),
            metadata,
        )
        .await
    }

    pub async fn create_session_with_agent_config(
        &self,
        session_id: SessionId,
        backend: BackendKind,
        working_directory: &str,
        title: Option<&str>,
        agent_config: AgentConfig,
        metadata: Option<serde_json::Value>,
    ) -> anyhow::Result<AppendResult> {
        self.store
            .create_session_with_agent_config(
                &session_id,
                backend,
                working_directory,
                title,
                agent_config.clone(),
                metadata.clone(),
            )
            .await?;
        let append = self
            .store
            .append_event(
                &session_id,
                EventType::SESSION_CREATED,
                EventSource::runtime("vela-runtime"),
                json!({
                    "backend": backend.as_str(),
                    "working_directory": working_directory,
                    "title": title,
                    "model": agent_config.model,
                    "agent_config": agent_config,
                    "metadata": metadata.unwrap_or_else(|| json!({})),
                }),
                None,
            )
            .await?;
        Ok(append)
    }

    pub async fn send_user_message(&self, input: SendUserMessage) -> anyhow::Result<CommandAck> {
        self.send_user_message_internal(input, Vec::new(), None)
            .await
    }

    pub async fn send_user_message_with_blocks(
        &self,
        input: SendUserMessage,
        blocks: Vec<UserMessageBlock>,
    ) -> anyhow::Result<CommandAck> {
        self.send_user_message_internal(input, blocks, None).await
    }

    pub async fn send_user_message_with_trace(
        &self,
        input: SendUserMessage,
        trace_context: Option<TraceContext>,
    ) -> anyhow::Result<CommandAck> {
        self.send_user_message_internal(input, Vec::new(), trace_context)
            .await
    }

    pub async fn send_user_message_with_blocks_and_trace(
        &self,
        input: SendUserMessage,
        blocks: Vec<UserMessageBlock>,
        trace_context: Option<TraceContext>,
    ) -> anyhow::Result<CommandAck> {
        self.send_user_message_internal(input, blocks, trace_context)
            .await
    }

    async fn send_user_message_internal(
        &self,
        input: SendUserMessage,
        blocks: Vec<UserMessageBlock>,
        trace_context: Option<TraceContext>,
    ) -> anyhow::Result<CommandAck> {
        let session = match self.store.get_session(&input.session_id).await? {
            Some(session) if session.status == "closed" => {
                let cursor = self
                    .store
                    .list_events(&input.session_id)
                    .await?
                    .last()
                    .map(vela_core::CanonicalEvent::cursor);
                return Ok(CommandAck::Rejected(vela_core::RejectedCommandAck {
                    code: "session_closed".to_string(),
                    message: "session is closed".to_string(),
                    cursor,
                    command_id: input.command_id,
                    session_id: Some(input.session_id),
                }));
            }
            Some(session) => session,
            None => {
                return Ok(CommandAck::Rejected(vela_core::RejectedCommandAck {
                    code: "session_not_found".to_string(),
                    message: "session does not exist".to_string(),
                    cursor: None,
                    command_id: input.command_id,
                    session_id: Some(input.session_id),
                }));
            }
        };

        let command_hash = hash_command(&input, &blocks)?;
        if let Some(acceptance) = self
            .store
            .resolve_idempotency(&input.session_id, &input.idempotency_key, &command_hash)
            .await?
        {
            return Ok(acceptance.ack());
        }
        let command_id = input
            .command_id
            .clone()
            .unwrap_or_else(|| CommandId::from(input.idempotency_key.clone()));
        if self.running.lock().await.contains(&input.session_id) {
            let queued_message_id = EventId::new().to_string();
            let acceptance = self
                .store
                .record_idempotency_acceptance(
                    &input.session_id,
                    &input.idempotency_key,
                    &command_hash,
                    Some(command_id),
                    EventType::INPUT_QUEUED,
                    EventSource::runtime("vela-runtime"),
                    json!({
                        "queued_message_id": queued_message_id,
                        "content": input.content,
                        "blocks": blocks,
                    }),
                )
                .await?;
            return Ok(acceptance.ack());
        }
        let acceptance = self
            .store
            .record_idempotency_acceptance(
                &input.session_id,
                &input.idempotency_key,
                &command_hash,
                Some(command_id),
                EventType::USER_MESSAGE_ACCEPTED,
                EventSource::runtime("vela-runtime"),
                user_message_accepted_payload(&input, &blocks)?,
            )
            .await?;
        if acceptance.is_hash_mismatch() {
            return Ok(acceptance.ack());
        }
        if acceptance.is_replay() {
            return Ok(acceptance.ack());
        }

        self.running.lock().await.insert(input.session_id.clone());
        let resolved_agent_config = ResolvedAgentConfig {
            backend: session.backend,
            config: session.agent_config.clone(),
        };
        let turn_id = TurnId::new();
        self.store
            .append_event(
                &input.session_id,
                EventType::TURN_STARTED,
                EventSource::runtime("vela-runtime"),
                json!({
                    "turn_id": turn_id,
                    "resolved_agent_config": resolved_agent_config,
                }),
                None,
            )
            .await?;
        self.spawn_turn_task(
            input.session_id.clone(),
            input.content.clone(),
            backend_blocks(&input.content, &blocks),
            turn_id,
            session.working_directory.clone(),
            resolved_agent_config,
            trace_context,
        );

        Ok(acceptance.ack())
    }

    fn spawn_turn_task(
        &self,
        session_id: SessionId,
        content: String,
        blocks: Vec<UserMessageBlock>,
        turn_id: TurnId,
        working_directory: String,
        resolved_agent_config: ResolvedAgentConfig,
        trace_context: Option<TraceContext>,
    ) {
        let store = self.store.clone();
        let backend = self.backend.clone();
        let running = self.running.clone();
        let event_observer = self.event_observer.clone();
        let observability = self.observability.clone();
        tokio::spawn(async move {
            let backend_source_name = resolved_agent_config.backend.as_str().to_string();
            let backend_session_id = session_id.clone();
            let backend_turn_id = turn_id.clone();
            let backend_kind = resolved_agent_config.backend;
            let (sink, mut receiver) = backend_output_channel(32);
            let backend_span_start = Utc::now();
            let emit_backend_diagnostics = trace_context.is_some();
            let backend_task = tokio::spawn(async move {
                backend
                    .stream_user_message(
                        BackendSend {
                            content,
                            blocks,
                            session_id: Some(backend_session_id),
                            turn_id: Some(backend_turn_id),
                            working_directory: Some(working_directory),
                            resolved_agent_config: Some(resolved_agent_config),
                            emit_diagnostics: emit_backend_diagnostics,
                        },
                        sink,
                    )
                    .await
            });
            let mut turn_failed = false;
            let mut turn_terminal = false;
            let mut turn_failure_message: Option<String> = None;

            while let Some(output) = receiver.recv().await {
                match output {
                    Ok(output) => {
                        if consume_backend_diagnostic_output(
                            observability.as_ref(),
                            trace_context.as_ref(),
                            &session_id,
                            &backend_source_name,
                            &turn_id,
                            &output,
                        )
                        .await
                        {
                            continue;
                        }
                        if let Some(output) = normalize_backend_output(output) {
                            let output_event_type = output.event_type;
                            let output_failure_message = backend_output_failure_message(&output);
                            if is_backend_terminal_output(output_event_type) {
                                turn_terminal = true;
                            }
                            if let Err(error) = persist_backend_output(
                                &store,
                                &event_observer,
                                &session_id,
                                &backend_source_name,
                                with_turn_id(output, &turn_id),
                            )
                            .await
                            {
                                let error = format!("failed to append backend output: {error}");
                                append_turn_failed(
                                    &store,
                                    &event_observer,
                                    &session_id,
                                    &turn_id,
                                    error.clone(),
                                )
                                .await;
                                turn_failed = true;
                                turn_failure_message = Some(error);
                                break;
                            }
                            if output_event_type == EventType::TURN_FAILED {
                                turn_failed = true;
                                turn_failure_message = output_failure_message;
                            }
                        }
                    }
                    Err(error) => {
                        let error = error.to_string();
                        append_turn_failed(
                            &store,
                            &event_observer,
                            &session_id,
                            &turn_id,
                            error.clone(),
                        )
                        .await;
                        turn_failed = true;
                        turn_failure_message = Some(error);
                        break;
                    }
                }
            }
            drop(receiver);

            match backend_task.await {
                Ok(Ok(())) if !turn_failed && !turn_terminal => {
                    let error = "backend completed without a terminal turn event".to_string();
                    append_turn_failed(
                        &store,
                        &event_observer,
                        &session_id,
                        &turn_id,
                        error.clone(),
                    )
                    .await;
                    record_backend_span(
                        observability.as_ref(),
                        trace_context.as_ref(),
                        &session_id,
                        backend_kind.as_str(),
                        &turn_id,
                        backend_span_start,
                        false,
                        Some(error),
                    )
                    .await;
                }
                Ok(Ok(())) => {
                    record_backend_span(
                        observability.as_ref(),
                        trace_context.as_ref(),
                        &session_id,
                        backend_kind.as_str(),
                        &turn_id,
                        backend_span_start,
                        !turn_failed,
                        turn_failure_message.clone(),
                    )
                    .await;
                }
                Ok(Err(error)) => {
                    let error = error.to_string();
                    record_backend_span(
                        observability.as_ref(),
                        trace_context.as_ref(),
                        &session_id,
                        backend_kind.as_str(),
                        &turn_id,
                        backend_span_start,
                        false,
                        Some(error.clone()),
                    )
                    .await;
                    if !turn_failed {
                        append_turn_failed(&store, &event_observer, &session_id, &turn_id, error)
                            .await;
                    }
                }
                Err(error) => {
                    let error = error.to_string();
                    record_backend_span(
                        observability.as_ref(),
                        trace_context.as_ref(),
                        &session_id,
                        backend_kind.as_str(),
                        &turn_id,
                        backend_span_start,
                        false,
                        Some(error.clone()),
                    )
                    .await;
                    if !turn_failed {
                        append_turn_failed(&store, &event_observer, &session_id, &turn_id, error)
                            .await;
                    }
                }
            }
            running.lock().await.remove(&session_id);
        });
    }

    pub fn backend_capabilities(&self) -> BackendCapabilities {
        self.backend.capabilities()
    }

    pub fn backend_capabilities_for(&self, backend: Option<BackendKind>) -> BackendCapabilities {
        self.backend.capabilities_for_backend(backend)
    }

    pub async fn is_session_running(&self, session_id: &SessionId) -> bool {
        self.running.lock().await.contains(session_id)
    }

    pub async fn probe_backend(
        &self,
        backend: Option<BackendKind>,
    ) -> anyhow::Result<BackendProbe> {
        self.backend.probe_backend(backend).await
    }

    pub async fn list_backend_models(
        &self,
        backend: Option<BackendKind>,
    ) -> anyhow::Result<Vec<vela_core::BackendModel>> {
        self.backend.list_models(backend).await
    }

    pub async fn cancel_backend(&self, session_id: &SessionId) -> anyhow::Result<()> {
        let backend = self
            .store
            .get_session(session_id)
            .await?
            .map(|session| session.backend);
        self.backend
            .cancel(BackendCancel {
                session_id: session_id.to_string(),
                backend,
            })
            .await
    }

    pub async fn respond_to_request(
        &self,
        session_id: &SessionId,
        request_id: String,
        result: Option<String>,
        scope: Option<String>,
        answer: Option<String>,
        content: Option<serde_json::Value>,
        options: Option<serde_json::Value>,
    ) -> anyhow::Result<()> {
        let backend = self
            .store
            .get_session(session_id)
            .await?
            .map(|session| session.backend);
        self.backend
            .respond_to_request(BackendRequestResponse {
                session_id: session_id.clone(),
                backend,
                request_id,
                result,
                scope,
                answer,
                content,
                options,
            })
            .await
    }
}

fn normalize_backend_output(
    output: vela_backends::BackendOutput,
) -> Option<vela_backends::BackendOutput> {
    if is_backend_lifecycle_noise(output.event_type) {
        return None;
    }
    if is_backend_output_allowed(output.event_type) {
        return Some(output);
    }
    Some(vela_backends::BackendOutput {
        event_type: EventType::WARNING_RAISED,
        payload: json!({
            "code": "backend_event_not_allowed",
            "message": format!("backend output event is not allowed to write {}", output.event_type.0),
            "event_type": output.event_type.0,
        }),
        raw: Some(json!({
            "event_type": output.event_type.0,
            "payload": output.payload,
            "raw": output.raw,
        })),
    })
}

fn with_turn_id(
    mut output: vela_backends::BackendOutput,
    turn_id: &TurnId,
) -> vela_backends::BackendOutput {
    match &mut output.payload {
        Value::Object(payload) => {
            payload
                .entry("turn_id")
                .or_insert_with(|| Value::String(turn_id.to_string()));
        }
        _ => {
            output.payload = json!({
                "turn_id": turn_id,
                "value": output.payload,
            });
        }
    }
    output
}

async fn persist_backend_output(
    store: &SqliteEventStore,
    event_observer: &Option<EventObserver>,
    session_id: &SessionId,
    backend_source_name: &str,
    output: vela_backends::BackendOutput,
) -> Result<(), vela_store::StoreError> {
    let append = store
        .append_event(
            session_id,
            output.event_type,
            EventSource::backend(backend_source_name),
            output.payload,
            output.raw,
        )
        .await?;
    publish_event(event_observer, append.event);
    Ok(())
}

fn is_backend_lifecycle_noise(event_type: EventType) -> bool {
    event_type == EventType::TURN_STARTED
}

fn is_backend_terminal_output(event_type: EventType) -> bool {
    matches!(
        event_type,
        EventType::TURN_COMPLETED | EventType::TURN_FAILED | EventType::TURN_CANCELLED
    )
}

fn backend_output_failure_message(output: &vela_backends::BackendOutput) -> Option<String> {
    if output.event_type != EventType::TURN_FAILED {
        return None;
    }
    output
        .payload
        .get("error")
        .and_then(Value::as_str)
        .or_else(|| output.payload.get("message").and_then(Value::as_str))
        .map(str::to_string)
}

fn is_backend_output_allowed(event_type: EventType) -> bool {
    matches!(
        event_type,
        EventType::TURN_COMPLETED
            | EventType::TURN_FAILED
            | EventType::TURN_CANCELLED
            | EventType::ASSISTANT_MESSAGE_STARTED
            | EventType::ASSISTANT_MESSAGE_DELTA
            | EventType::ASSISTANT_MESSAGE_COMPLETED
            | EventType::ASSISTANT_REASONING_DELTA
            | EventType::ASSISTANT_REASONING_COMPLETED
            | EventType::TOOL_STARTED
            | EventType::TOOL_UPDATED
            | EventType::TOOL_OUTPUT_DELTA
            | EventType::TOOL_COMPLETED
            | EventType::TOOL_FAILED
            | EventType::TASK_STARTED
            | EventType::TASK_UPDATED
            | EventType::TASK_COMPLETED
            | EventType::REQUEST_OPENED
            | EventType::REQUEST_UPDATED
            | EventType::REQUEST_RESOLVED
            | EventType::DIFF_UPDATED
            | EventType::USAGE_UPDATED
            | EventType::WARNING_RAISED
            | EventType::ERROR_RAISED
    )
}

async fn append_turn_failed(
    store: &SqliteEventStore,
    event_observer: &Option<EventObserver>,
    session_id: &SessionId,
    turn_id: &TurnId,
    error: String,
) {
    if let Ok(append) = store
        .append_event(
            session_id,
            EventType::TURN_FAILED,
            EventSource::runtime("vela-runtime"),
            json!({ "turn_id": turn_id, "error": error }),
            None,
        )
        .await
    {
        publish_event(event_observer, append.event);
    }
}

async fn record_backend_span(
    observability: Option<&ObservabilityStore>,
    trace_context: Option<&TraceContext>,
    session_id: &SessionId,
    backend: &str,
    turn_id: &TurnId,
    start_time: chrono::DateTime<Utc>,
    ok: bool,
    error_message: Option<String>,
) {
    let (Some(observability), Some(trace)) = (observability, trace_context) else {
        return;
    };
    let _ = observability
        .record_span(ManualSpan {
            trace: trace.clone(),
            parent_span_id: None,
            name: "velad.backend.send".to_string(),
            start_time,
            end_time: Utc::now(),
            status_code: Some(if ok { "OK" } else { "ERROR" }.to_string()),
            status_message: error_message.clone(),
            session_id: Some(session_id.as_str().to_string()),
            backend: Some(backend.to_string()),
            error_message,
            attributes: json!({
                "velad.session_id": session_id.as_str(),
                "velad.backend": backend,
                "velad.turn_id": turn_id,
            }),
        })
        .await;
}

async fn consume_backend_diagnostic_output(
    observability: Option<&ObservabilityStore>,
    trace_context: Option<&TraceContext>,
    session_id: &SessionId,
    backend: &str,
    turn_id: &TurnId,
    output: &vela_backends::BackendOutput,
) -> bool {
    if output.event_type != EventType::WARNING_RAISED
        || output.payload.get("code").and_then(Value::as_str) != Some("codex_app_server_trace")
    {
        return false;
    }

    let (Some(observability), Some(trace)) = (observability, trace_context) else {
        return true;
    };
    let name = output
        .payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("codex.app_server");
    let duration_ms = output
        .payload
        .get("duration_ms")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .max(0.0);
    let end_time = Utc::now();
    let start_time =
        end_time - chrono::Duration::microseconds((duration_ms * 1_000.0).round() as i64);
    let status_code = output
        .payload
        .get("status_code")
        .and_then(Value::as_str)
        .unwrap_or("UNSET")
        .to_string();
    let error_message = output
        .payload
        .get("error_message")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut attributes = output
        .payload
        .get("attributes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    attributes.insert(
        "velad.session_id".to_string(),
        Value::String(session_id.as_str().to_string()),
    );
    attributes.insert(
        "velad.backend".to_string(),
        Value::String(backend.to_string()),
    );
    attributes.insert(
        "velad.turn_id".to_string(),
        Value::String(turn_id.to_string()),
    );
    if let Some(method) = output.payload.get("method").and_then(Value::as_str) {
        attributes.insert(
            "codex.method".to_string(),
            Value::String(method.to_string()),
        );
    }

    let _ = observability
        .record_span(ManualSpan {
            trace: trace.clone(),
            parent_span_id: None,
            name: name.to_string(),
            start_time,
            end_time,
            status_code: Some(status_code.clone()),
            status_message: error_message.clone(),
            session_id: Some(session_id.as_str().to_string()),
            backend: Some(backend.to_string()),
            error_message: error_message.filter(|_| status_code == "ERROR"),
            attributes: Value::Object(attributes),
        })
        .await;
    true
}

fn publish_event(event_observer: &Option<EventObserver>, event: CanonicalEvent) {
    if let Some(observer) = event_observer {
        observer(event);
    }
}

fn hash_command(input: &SendUserMessage, blocks: &[UserMessageBlock]) -> anyhow::Result<String> {
    let mut hasher = Sha256::new();
    hasher.update(input.session_id.as_str().as_bytes());
    hasher.update(b"\0");
    hasher.update(input.content.as_bytes());
    if !blocks.is_empty() {
        hasher.update(b"\0blocks\0");
        hasher.update(serde_json::to_vec(blocks)?);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn user_message_accepted_payload(
    input: &SendUserMessage,
    blocks: &[UserMessageBlock],
) -> anyhow::Result<Value> {
    let mut payload = json!({ "content": input.content, "command_id": input.command_id });
    if !blocks.is_empty() {
        payload["blocks"] = serde_json::to_value(blocks)?;
    }
    Ok(payload)
}

fn backend_blocks(content: &str, blocks: &[UserMessageBlock]) -> Vec<UserMessageBlock> {
    if !blocks.is_empty() {
        blocks.to_vec()
    } else if content.is_empty() {
        Vec::new()
    } else {
        vec![UserMessageBlock::text(content)]
    }
}
