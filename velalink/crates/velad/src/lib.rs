use std::{
    collections::HashMap,
    convert::Infallible,
    env, fs,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::rejection::JsonRejection,
    extract::rejection::QueryRejection,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use chrono::{DateTime, Utc};
use futures::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use vela_backends::BackendAdapter;
use vela_core::{
    AcceptedCommandAck, AgentConfig, AgentConfigPatch, BackendKind, BlobRef, CanonicalEvent,
    CommandAck, CommandId, ConversationItemKind, EventCursor, EventId, EventSource, EventType,
    PermissionMode, RejectedCommandAck, SessionId, SourceEventRange, UserMessageBlock,
};
use vela_observability::{
    ManualLog, ManualSpan, ObservabilityStore, TraceContext, parse_traceparent,
};
use vela_projection::{
    ConversationWindowDirection, ConversationWindowError, ConversationWindowQuery,
    project_conversation, project_conversation_window, project_pending_requests,
};
use vela_runtime::{Runtime, SendUserMessage};
use vela_store::{SqliteEventStore, StoredSession};

mod backend_snapshot;
mod backend_usage;
pub mod local_runtime;
pub mod runtime_targets;

pub struct ApiState<B> {
    store: Arc<SqliteEventStore>,
    runtime: Runtime<B>,
    events: broadcast::Sender<CanonicalEvent>,
    default_session_model: Option<String>,
    configured_backends: Vec<ConfiguredBackend>,
    backend_usage: backend_usage::BackendUsageService,
    backend_settings_updater: Option<Arc<dyn BackendSettingsUpdater>>,
    node_secret_store: Arc<dyn runtime_targets::NodeSecretStore>,
    runtime_target_manager: Arc<runtime_targets::RuntimeTargetManager>,
    local_runtime: Option<local_runtime::LocalRuntimeState>,
    shutdown_tx: Option<tokio::sync::watch::Sender<bool>>,
    observability: Option<ObservabilityStore>,
}

pub trait BackendSettingsUpdater: Send + Sync {
    fn update_vela_engine(&self, settings: VelaEngineBackendSettings);
}

impl<B> Clone for ApiState<B> {
    fn clone(&self) -> Self {
        Self {
            store: self.store.clone(),
            runtime: self.runtime.clone(),
            events: self.events.clone(),
            default_session_model: self.default_session_model.clone(),
            configured_backends: self.configured_backends.clone(),
            backend_usage: self.backend_usage.clone(),
            backend_settings_updater: self.backend_settings_updater.clone(),
            node_secret_store: self.node_secret_store.clone(),
            runtime_target_manager: self.runtime_target_manager.clone(),
            local_runtime: self.local_runtime.clone(),
            shutdown_tx: self.shutdown_tx.clone(),
            observability: self.observability.clone(),
        }
    }
}

#[derive(Clone)]
struct ConfiguredBackend {
    kind: &'static str,
    engine_kind: BackendKind,
    display_name: &'static str,
    default_model: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct VelaEngineBackendSettings {
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
}

impl ConfiguredBackend {
    fn default_model(&self) -> Option<String> {
        self.default_model.clone()
    }
}

impl<B> ApiState<B>
where
    B: BackendAdapter + 'static,
{
    pub fn new(store: Arc<SqliteEventStore>, runtime: Runtime<B>) -> Self {
        let (events, _) = broadcast::channel(1024);
        let runtime = runtime.with_event_observer(Arc::new({
            let events = events.clone();
            move |event| {
                let _ = events.send(event);
            }
        }));
        Self {
            store,
            runtime,
            events,
            default_session_model: None,
            configured_backends: vec![ConfiguredBackend {
                kind: "pi",
                engine_kind: BackendKind::Pi,
                display_name: "PiCoding Agent",
                default_model: None,
            }],
            backend_usage: backend_usage::BackendUsageService::default(),
            backend_settings_updater: None,
            node_secret_store: Arc::new(runtime_targets::KeyringNodeSecretStore::default()),
            runtime_target_manager: Arc::new(runtime_targets::RuntimeTargetManager::default()),
            local_runtime: None,
            shutdown_tx: None,
            observability: None,
        }
    }

    pub fn with_default_session_model(mut self, model: Option<String>) -> Self {
        self.default_session_model = model;
        let default_session_model = self.default_session_model.clone();
        if let Some(backend) = self
            .configured_backends
            .iter_mut()
            .find(|backend| backend.kind == "pi")
        {
            backend.default_model = default_session_model;
        }
        self
    }

    pub fn with_codex_backend(mut self, default_model: Option<String>) -> Self {
        if let Some(backend) = self
            .configured_backends
            .iter_mut()
            .find(|backend| backend.kind == "codex")
        {
            backend.default_model = default_model;
            return self;
        }
        self.configured_backends.push(ConfiguredBackend {
            kind: "codex",
            engine_kind: BackendKind::Codex,
            display_name: "Codex",
            default_model,
        });
        self
    }

    pub fn with_tcodex_backend(mut self, default_model: Option<String>) -> Self {
        if let Some(backend) = self
            .configured_backends
            .iter_mut()
            .find(|backend| backend.kind == "tcodex")
        {
            backend.default_model = default_model;
            return self;
        }
        self.configured_backends.push(ConfiguredBackend {
            kind: "tcodex",
            engine_kind: BackendKind::Tcodex,
            display_name: "TCodex",
            default_model,
        });
        self
    }

    pub fn with_vela_engine_backend(mut self, default_model: Option<String>) -> Self {
        if let Some(backend) = self
            .configured_backends
            .iter_mut()
            .find(|backend| backend.kind == "vela_engine")
        {
            backend.default_model = default_model;
            return self;
        }
        self.configured_backends.push(ConfiguredBackend {
            kind: "vela_engine",
            engine_kind: BackendKind::VelaEngine,
            display_name: "Vela 内置引擎",
            default_model,
        });
        self
    }

    pub fn with_acp_backend(mut self, default_model: Option<String>) -> Self {
        if let Some(backend) = self
            .configured_backends
            .iter_mut()
            .find(|backend| backend.kind == "acp")
        {
            backend.default_model = default_model;
            return self;
        }
        self.configured_backends.push(ConfiguredBackend {
            kind: "acp",
            engine_kind: BackendKind::Acp,
            display_name: "Hermes ACP",
            default_model,
        });
        self
    }

    pub fn with_backend_settings_updater(
        mut self,
        updater: Arc<dyn BackendSettingsUpdater>,
    ) -> Self {
        self.backend_settings_updater = Some(updater);
        self
    }

    pub fn with_node_secret_store(
        mut self,
        secret_store: Arc<dyn runtime_targets::NodeSecretStore>,
    ) -> Self {
        self.node_secret_store = secret_store;
        self
    }

    pub fn with_runtime_target_manager(
        mut self,
        manager: Arc<runtime_targets::RuntimeTargetManager>,
    ) -> Self {
        self.runtime_target_manager = manager;
        self
    }

    pub fn with_local_runtime(
        mut self,
        local_runtime: local_runtime::LocalRuntimeState,
        shutdown_tx: tokio::sync::watch::Sender<bool>,
    ) -> Self {
        self.local_runtime = Some(local_runtime);
        self.shutdown_tx = Some(shutdown_tx);
        self
    }

    pub fn with_observability(mut self, observability: ObservabilityStore) -> Self {
        self.observability = Some(observability);
        self
    }

    #[doc(hidden)]
    pub fn with_backend_usage_test_context(
        mut self,
        env: HashMap<String, String>,
        home_dir: Option<PathBuf>,
    ) -> Self {
        self.backend_usage = backend_usage::BackendUsageService::with_codex_context(env, home_dir);
        self
    }

    fn configured_engine_kind(&self, backend: BackendKindWire) -> Option<BackendKind> {
        let kind = backend.as_str();
        self.configured_backends
            .iter()
            .find(|entry| entry.kind == kind)
            .map(|entry| entry.engine_kind)
    }

    fn configured_backend(&self, backend: BackendKindWire) -> Option<&ConfiguredBackend> {
        let kind = backend.as_str();
        self.configured_backends
            .iter()
            .find(|entry| entry.kind == kind)
    }

    fn configured_backend_for_engine(
        &self,
        engine_kind: BackendKind,
    ) -> Option<&ConfiguredBackend> {
        self.configured_backends
            .iter()
            .find(|entry| entry.engine_kind == engine_kind)
    }
}

pub fn build_app<B>(state: ApiState<B>) -> Router
where
    B: BackendAdapter + 'static,
{
    Router::new()
        .route(
            "/api/v1/sessions",
            get(list_sessions::<B>).post(create_session::<B>),
        )
        .route("/api/v1/sessions/{session_id}", get(get_session::<B>))
        .route(
            "/api/v1/sessions/{session_id}/agent-config",
            patch(update_session_agent_config::<B>),
        )
        .route(
            "/api/v1/sessions/{session_id}/cancel",
            post(cancel_session::<B>),
        )
        .route(
            "/api/v1/sessions/{session_id}/close",
            post(close_session::<B>),
        )
        .route(
            "/api/v1/sessions/{session_id}/archive",
            post(archive_session::<B>),
        )
        .route(
            "/api/v1/sessions/{session_id}/events",
            get(list_session_events::<B>).post(send_session_events::<B>),
        )
        .route(
            "/api/v1/sessions/{session_id}/events/stream",
            get(stream_session_events::<B>),
        )
        .route("/api/v1/events/stream", get(stream_workbench_events::<B>))
        .route(
            "/api/v1/sessions/{session_id}/views/session",
            get(get_session_view::<B>),
        )
        .route(
            "/api/v1/sessions/{session_id}/views/conversation",
            get(get_conversation_view::<B>),
        )
        .route(
            "/api/v1/sessions/{session_id}/views/requests",
            get(get_requests_view::<B>),
        )
        .route(
            "/api/v1/sessions/{session_id}/views/diffs",
            get(get_diffs_view::<B>),
        )
        .route(
            "/api/v1/sessions/{session_id}/diagnostics/timeline",
            get(get_timeline::<B>),
        )
        .route(
            "/api/v1/sessions/{session_id}/diagnostics/timeline/{item_id}",
            get(get_timeline_item::<B>),
        )
        .route(
            "/api/v1/sessions/{session_id}/diagnostics/trace",
            get(get_trace::<B>),
        )
        .route("/api/v1/views/sessions", get(get_session_list_view::<B>))
        .route("/api/v1/requests/{request_id}", get(get_request::<B>))
        .route("/api/v1/backends", get(list_backends::<B>))
        .route("/api/v1/backends/{backend}", get(get_backend::<B>))
        .route(
            "/api/v1/backends/{backend}/usage",
            get(get_backend_usage::<B>),
        )
        .route("/api/v1/backends/{backend}/probe", post(probe_backend::<B>))
        .route(
            "/api/v1/backends/{backend}/settings",
            get(get_backend_settings::<B>).patch(patch_backend_settings::<B>),
        )
        .route(
            "/api/v1/backends/{backend}/skills",
            get(list_backend_skills::<B>),
        )
        .route("/api/v1/node-providers", get(list_node_providers::<B>))
        .route("/api/v1/nodes", get(list_nodes::<B>).post(create_node::<B>))
        .route("/api/v1/runtime-targets", get(list_runtime_targets::<B>))
        .route(
            "/api/v1/runtime-targets/{target_id}/connect",
            post(connect_runtime_target::<B>),
        )
        .route(
            "/api/v1/runtime-targets/{target_id}/disconnect",
            post(disconnect_runtime_target::<B>),
        )
        .route("/api/v1/runtime-info", get(get_runtime_info::<B>))
        .route("/api/v1/runtime/shutdown", post(shutdown_runtime::<B>))
        .route("/v1/traces", post(post_otlp_traces::<B>))
        .route("/v1/logs", post(post_otlp_logs::<B>))
        .route(
            "/api/v1/observability/status",
            get(get_observability_status::<B>),
        )
        .route(
            "/api/v1/observability/recent-errors",
            get(get_observability_recent_errors::<B>),
        )
        .route(
            "/api/v1/observability/traces/{trace_id}",
            get(get_observability_trace::<B>),
        )
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct CreateSessionRequest {
    backend: BackendKindWire,
    working_directory: String,
    #[serde(default)]
    agent_config: Option<AgentConfig>,
    title: Option<String>,
    model: Option<String>,
    metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct SendSessionEventsRequest {
    events: Vec<ClientInputEvent>,
    #[serde(default)]
    options: Option<Value>,
}

async fn get_runtime_info<B>(State(state): State<ApiState<B>>) -> Response
where
    B: BackendAdapter + 'static,
{
    match state.local_runtime {
        Some(runtime) => Json(runtime.info).into_response(),
        None => error(
            StatusCode::NOT_FOUND,
            "runtime_info_unavailable",
            "local runtime information is not configured",
        ),
    }
}

async fn shutdown_runtime<B>(State(state): State<ApiState<B>>, headers: HeaderMap) -> Response
where
    B: BackendAdapter + 'static,
{
    let Some(runtime) = state.local_runtime else {
        return error(
            StatusCode::FORBIDDEN,
            "runtime_shutdown_unavailable",
            "runtime shutdown requires a management token",
        );
    };
    let Some(expected_token) = runtime.management_token.as_deref() else {
        return error(
            StatusCode::FORBIDDEN,
            "runtime_shutdown_unavailable",
            "runtime shutdown requires a management token",
        );
    };
    if bearer_token(&headers) != Some(expected_token) {
        return error(
            StatusCode::FORBIDDEN,
            "runtime_shutdown_forbidden",
            "invalid runtime management token",
        );
    }
    let Some(shutdown_tx) = state.shutdown_tx else {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "runtime_shutdown_unavailable",
            "runtime shutdown trigger is not configured",
        );
    };
    let _ = shutdown_tx.send(true);
    Json(json!({ "accepted": true })).into_response()
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

fn trace_context_from_headers(headers: &HeaderMap) -> Option<TraceContext> {
    headers
        .get("traceparent")?
        .to_str()
        .ok()
        .and_then(parse_traceparent)
}

async fn record_velad_span<B>(
    state: &ApiState<B>,
    trace_context: Option<&TraceContext>,
    name: &str,
    start_time: chrono::DateTime<Utc>,
    ok: bool,
    session_id: Option<&str>,
    backend: Option<&str>,
    error_message: Option<String>,
    attributes: Value,
) where
    B: BackendAdapter + 'static,
{
    let (Some(observability), Some(trace)) = (state.observability.as_ref(), trace_context) else {
        return;
    };
    let _ = observability
        .record_span(ManualSpan {
            trace: trace.clone(),
            parent_span_id: None,
            name: name.to_string(),
            start_time,
            end_time: Utc::now(),
            status_code: Some(if ok { "OK" } else { "ERROR" }.to_string()),
            status_message: error_message.clone(),
            session_id: session_id.map(str::to_string),
            backend: backend.map(str::to_string),
            error_message,
            attributes,
        })
        .await;
}

fn command_ack_error_message(ack: &CommandAck) -> String {
    match ack {
        CommandAck::Rejected(rejected) => rejected.message.clone(),
        CommandAck::Accepted(_) | CommandAck::Queued(_) => "command did not succeed".to_string(),
    }
}

async fn post_otlp_traces<B>(
    State(state): State<ApiState<B>>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let Some(observability) = state.observability else {
        return observability_unavailable();
    };
    let payload = match body {
        Ok(Json(payload)) => payload,
        Err(err) => return invalid_request(format!("invalid OTLP JSON traces payload: {err}")),
    };
    match observability.ingest_traces(payload).await {
        Ok(summary) => Json(summary).into_response(),
        Err(err) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "observability_ingest_failed",
            err.to_string(),
        ),
    }
}

async fn post_otlp_logs<B>(
    State(state): State<ApiState<B>>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let Some(observability) = state.observability else {
        return observability_unavailable();
    };
    let payload = match body {
        Ok(Json(payload)) => payload,
        Err(err) => return invalid_request(format!("invalid OTLP JSON logs payload: {err}")),
    };
    match observability.ingest_logs(payload).await {
        Ok(summary) => Json(summary).into_response(),
        Err(err) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "observability_ingest_failed",
            err.to_string(),
        ),
    }
}

async fn get_observability_status<B>(State(state): State<ApiState<B>>) -> Response
where
    B: BackendAdapter + 'static,
{
    let Some(observability) = state.observability else {
        return observability_unavailable();
    };
    match observability.status().await {
        Ok(status) => Json(status).into_response(),
        Err(err) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "observability_query_failed",
            err.to_string(),
        ),
    }
}

async fn get_observability_recent_errors<B>(
    State(state): State<ApiState<B>>,
    query: Result<Query<ObservabilityErrorsQuery>, QueryRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let Some(observability) = state.observability else {
        return observability_unavailable();
    };
    let query = match parsed_query(query) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let limit = match validated_limit(query.limit) {
        Ok(limit) => limit.unwrap_or(50),
        Err(response) => return response,
    };
    match observability.recent_errors(limit).await {
        Ok(errors) => Json(json!({ "errors": errors })).into_response(),
        Err(err) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "observability_query_failed",
            err.to_string(),
        ),
    }
}

async fn get_observability_trace<B>(
    State(state): State<ApiState<B>>,
    Path(trace_id): Path<String>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let Some(observability) = state.observability else {
        return observability_unavailable();
    };
    match observability.trace_detail(&trace_id).await {
        Ok(Some(trace)) => Json(trace).into_response(),
        Ok(None) => error(
            StatusCode::NOT_FOUND,
            "observability_trace_not_found",
            "trace does not exist",
        ),
        Err(err) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "observability_query_failed",
            err.to_string(),
        ),
    }
}

fn observability_unavailable() -> Response {
    error(
        StatusCode::NOT_FOUND,
        "observability_unavailable",
        "local observability store is not configured",
    )
}

#[derive(Debug, Deserialize, Serialize)]
struct ClientInputEvent {
    #[serde(rename = "type")]
    event_type: String,
    content: Option<Vec<InputPart>>,
    request_id: Option<String>,
    result: Option<String>,
    scope: Option<String>,
    answer: Option<String>,
    options: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize)]
struct InputPart {
    #[serde(rename = "type")]
    part_type: String,
    text: Option<String>,
    uri: Option<String>,
    data: Option<String>,
    name: Option<String>,
    path: Option<String>,
    protocol: Option<String>,
    backend: Option<BackendKindWire>,
    #[serde(alias = "mimeType")]
    mime_type: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionListQuery {
    after_id: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct EventWindowQuery {
    after_id: Option<String>,
    before_id: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct EventStreamQuery {
    after_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConversationViewQuery {
    direction: Option<ViewWindowDirection>,
    anchor_item_id: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestsViewQuery {
    status: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct TimelineQuery {
    before_id: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct TraceQuery {
    after_id: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ObservabilityErrorsQuery {
    limit: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct BackendSkillsQuery {
    cwd: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ViewWindowDirection {
    Tail,
    Before,
    After,
    Around,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum BackendKindWire {
    VelaEngine,
    Codex,
    Tcodex,
    Cloudagent,
    ClaudeCode,
    Pi,
    Opencode,
    Acp,
    Qoder,
}

impl BackendKindWire {
    fn from_str(value: &str) -> Option<Self> {
        match value {
            "vela_engine" => Some(Self::VelaEngine),
            "codex" => Some(Self::Codex),
            "tcodex" => Some(Self::Tcodex),
            "cloudagent" => Some(Self::Cloudagent),
            "claude_code" => Some(Self::ClaudeCode),
            "pi" => Some(Self::Pi),
            "opencode" => Some(Self::Opencode),
            "acp" => Some(Self::Acp),
            "qoder" => Some(Self::Qoder),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::VelaEngine => "vela_engine",
            Self::Codex => "codex",
            Self::Tcodex => "tcodex",
            Self::Cloudagent => "cloudagent",
            Self::ClaudeCode => "claude_code",
            Self::Pi => "pi",
            Self::Opencode => "opencode",
            Self::Acp => "acp",
            Self::Qoder => "qoder",
        }
    }

    fn engine_kind(self) -> Option<BackendKind> {
        match self {
            Self::Pi => Some(BackendKind::Pi),
            Self::VelaEngine => Some(BackendKind::VelaEngine),
            Self::Codex => Some(BackendKind::Codex),
            Self::Tcodex => Some(BackendKind::Tcodex),
            Self::Acp => Some(BackendKind::Acp),
            Self::Cloudagent | Self::ClaudeCode | Self::Opencode | Self::Qoder => None,
        }
    }
}

async fn create_session<B>(
    State(state): State<ApiState<B>>,
    headers: HeaderMap,
    request: Result<Json<CreateSessionRequest>, JsonRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let Some(idempotency_key) = idempotency_key(&headers) else {
        return error(
            StatusCode::BAD_REQUEST,
            "missing_idempotency_key",
            "Idempotency-Key header is required",
        );
    };
    let mut request = match request {
        Ok(Json(request)) => request,
        Err(rejection) => return invalid_request(rejection.to_string()),
    };
    let trace_context = trace_context_from_headers(&headers);
    let span_start = Utc::now();
    let Some(engine_backend) = state.configured_engine_kind(request.backend) else {
        return error(
            StatusCode::CONFLICT,
            "backend_unavailable",
            format!("backend {} is not configured", request.backend.as_str()),
        );
    };
    let agent_config = match create_session_agent_config(&state, &request).await {
        Ok(agent_config) => agent_config,
        Err(response) => return response,
    };
    request.model = agent_config.model.clone();
    request.agent_config = Some(agent_config.clone());
    let session_id = SessionId::from(idempotency_key);
    match state
        .runtime
        .create_session_with_agent_config(
            session_id.clone(),
            engine_backend,
            &request.working_directory,
            request.title.as_deref(),
            agent_config.clone(),
            request.metadata.clone(),
        )
        .await
    {
        Ok(append) => {
            let _ = state.events.send(append.event.clone());
            record_velad_span(
                &state,
                trace_context.as_ref(),
                "velad.session.create",
                span_start,
                true,
                Some(session_id.as_str()),
                Some(request.backend.as_str()),
                None,
                json!({
                    "velad.session_id": session_id.as_str(),
                    "velad.backend": request.backend.as_str(),
                    "velad.working_directory": &request.working_directory,
                }),
            )
            .await;
            let session = match state.store.get_session(&session_id).await {
                Ok(Some(stored)) => stored_session_json(&stored, &[], Some(&append.event)),
                _ => session_json(
                    &session_id,
                    request.backend.as_str(),
                    "idle",
                    &request.working_directory,
                    request.title.as_deref(),
                    &agent_config,
                    request.metadata,
                    append.event.created_at,
                    append.event.created_at,
                    0,
                    Some(&append.event),
                ),
            };
            (
                StatusCode::CREATED,
                Json(json!({
                    "session": session,
                    "cursor": event_cursor_json(&append.event),
                })),
            )
                .into_response()
        }
        Err(err) => match state.store.get_session(&session_id).await {
            Ok(Some(existing)) => {
                if same_create_request(&existing, request.backend, &request) {
                    let events = state
                        .store
                        .list_events(&session_id)
                        .await
                        .unwrap_or_default();
                    let last = events.last();
                    (
                        StatusCode::CREATED,
                        Json(json!({
                            "session": stored_session_json(&existing, &events, last),
                            "cursor": last.map(event_cursor_json).unwrap_or_else(empty_cursor_json),
                        })),
                    )
                        .into_response()
                } else {
                    error(
                        StatusCode::CONFLICT,
                        "duplicate_command",
                        "idempotency key was already used for a different create session command",
                    )
                }
            }
            _ => error(StatusCode::CONFLICT, "session_conflict", err.to_string()),
        },
    }
}

async fn update_session_agent_config<B>(
    State(state): State<ApiState<B>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<AgentConfigPatch>, JsonRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    if idempotency_key(&headers).is_none() {
        return error(
            StatusCode::BAD_REQUEST,
            "missing_idempotency_key",
            "Idempotency-Key header is required",
        );
    }
    let patch = match request {
        Ok(Json(patch)) => patch,
        Err(rejection) => return invalid_request(rejection.to_string()),
    };
    if patch.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "empty_agent_config",
            "agent config patch must not be empty",
        );
    }
    let session_id = SessionId::from(session_id);
    let session = match state.store.get_session(&session_id).await {
        Ok(Some(session)) => session,
        Ok(None) => {
            return error(
                StatusCode::NOT_FOUND,
                "session_not_found",
                "session does not exist",
            );
        }
        Err(err) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "store_error",
                err.to_string(),
            );
        }
    };
    let next_config = session.agent_config.merge_patch(patch);
    if let Err(response) =
        validate_session_agent_config(&state, session.backend, &next_config).await
    {
        return response;
    }
    if let Err(err) = state
        .store
        .update_session_agent_config(&session_id, &next_config)
        .await
    {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "store_error",
            err.to_string(),
        );
    }
    let append = match state
        .store
        .append_event(
            &session_id,
            EventType::SESSION_CONFIG_UPDATED,
            EventSource::runtime("velad"),
            json!({ "agent_config": next_config }),
            None,
        )
        .await
    {
        Ok(append) => append,
        Err(err) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "store_error",
                err.to_string(),
            );
        }
    };
    let _ = state.events.send(append.event.clone());
    let updated = match state.store.get_session(&session_id).await {
        Ok(Some(session)) => session,
        _ => session,
    };
    let effective_after = if state.runtime.is_session_running(&session_id).await {
        "next_turn"
    } else {
        "current_session"
    };
    let events = state
        .store
        .list_events(&session_id)
        .await
        .unwrap_or_default();
    Json(json!({
        "session": stored_session_json(&updated, &events, Some(&append.event)),
        "effective_after": effective_after,
        "cursor": event_cursor_json(&append.event),
    }))
    .into_response()
}

async fn archive_session<B>(
    State(state): State<ApiState<B>>,
    Path(session_id): Path<String>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let session_id = SessionId::from(session_id);
    if let Err(err) = state.store.archive_session(&session_id).await {
        return match err {
            vela_store::StoreError::SessionNotFound(_) => error(
                StatusCode::NOT_FOUND,
                "session_not_found",
                "session does not exist",
            ),
            _ => error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "store_error",
                err.to_string(),
            ),
        };
    }
    session_response(&state, &session_id, false).await
}

async fn list_sessions<B>(
    State(state): State<ApiState<B>>,
    query: Result<Query<SessionListQuery>, QueryRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let query = match parsed_query(query) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let limit = match validated_limit(query.limit) {
        Ok(limit) => limit,
        Err(response) => return response,
    };
    match state.store.list_sessions().await {
        Ok(sessions) => {
            let values = sessions
                .iter()
                .map(session_summary_json)
                .collect::<Vec<_>>();
            let page = page_values(values, query.after_id.as_deref(), None, limit);
            Json(json!({
                "sessions": page.items,
                "cursor": page.cursor,
            }))
            .into_response()
        }
        Err(err) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "store_error",
            err.to_string(),
        ),
    }
}

async fn get_session<B>(
    State(state): State<ApiState<B>>,
    Path(session_id): Path<String>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    session_response(&state, &SessionId::from(session_id), false).await
}

async fn get_session_view<B>(
    State(state): State<ApiState<B>>,
    Path(session_id): Path<String>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    session_response(&state, &SessionId::from(session_id), true).await
}

async fn session_response<B>(
    state: &ApiState<B>,
    session_id: &SessionId,
    include_cursor: bool,
) -> Response
where
    B: BackendAdapter + 'static,
{
    match state.store.get_session(session_id).await {
        Ok(Some(session)) => {
            let events = state
                .store
                .list_events(session_id)
                .await
                .unwrap_or_default();
            let last = events.last();
            let value = stored_session_json(&session, &events, last);
            if include_cursor {
                Json(json!({
                    "session": value,
                    "cursor": last.map(event_cursor_json).unwrap_or_else(empty_cursor_json),
                }))
                .into_response()
            } else {
                Json(json!({ "session": value })).into_response()
            }
        }
        Ok(None) => error(
            StatusCode::NOT_FOUND,
            "session_not_found",
            "session does not exist",
        ),
        Err(err) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "store_error",
            err.to_string(),
        ),
    }
}

async fn send_session_events<B>(
    State(state): State<ApiState<B>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<SendSessionEventsRequest>, JsonRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let Some(idempotency_key) = idempotency_key(&headers) else {
        return error(
            StatusCode::BAD_REQUEST,
            "missing_idempotency_key",
            "Idempotency-Key header is required",
        );
    };
    let request = match request {
        Ok(Json(request)) => request,
        Err(rejection) => return invalid_request(rejection.to_string()),
    };
    let trace_context = trace_context_from_headers(&headers);
    let span_start = Utc::now();
    if request.events.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "empty_events",
            "events must not be empty",
        );
    };
    let session_id = SessionId::from(session_id);
    match state.store.get_session(&session_id).await {
        Ok(Some(session)) if session.status == "closed" => {
            let events = state
                .store
                .list_events(&session_id)
                .await
                .unwrap_or_default();
            let ack = rejected_command_ack(
                "session_closed",
                "session is closed",
                Some(CommandId::from(idempotency_key)),
                Some(session_id.clone()),
                events.last().map(CanonicalEvent::cursor),
            );
            return (StatusCode::ACCEPTED, Json(command_ack_json(&ack, &events))).into_response();
        }
        Ok(Some(_)) => {}
        Ok(None) => {
            return error(
                StatusCode::NOT_FOUND,
                "session_not_found",
                "session does not exist",
            );
        }
        Err(err) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "store_error",
                err.to_string(),
            );
        }
    }
    let before_len = state
        .store
        .list_events(&session_id)
        .await
        .map(|events| events.len())
        .unwrap_or(0);
    let mut ack_result = Ok(rejected_command_ack(
        "invalid_input_event",
        "events must not be empty",
        Some(CommandId::from(idempotency_key)),
        Some(session_id.clone()),
        None,
    ));
    let batch_len = request.events.len();
    let request_options = request.options.clone();
    for (index, input) in request.events.iter().enumerate() {
        let event_idempotency_key = scoped_idempotency_key(idempotency_key, index, batch_len);
        ack_result = if input.event_type == "user.message" {
            let content = input_content(input);
            match input_message_blocks(input) {
                Ok(blocks) if contains_structured_block(&blocks) => {
                    state
                        .runtime
                        .send_user_message_with_blocks_and_trace(
                            SendUserMessage {
                                session_id: session_id.clone(),
                                idempotency_key: event_idempotency_key,
                                content,
                                command_id: None,
                            },
                            blocks,
                            trace_context.clone(),
                        )
                        .await
                }
                Ok(_) => {
                    state
                        .runtime
                        .send_user_message_with_trace(
                            SendUserMessage {
                                session_id: session_id.clone(),
                                idempotency_key: event_idempotency_key,
                                content,
                                command_id: None,
                            },
                            trace_context.clone(),
                        )
                        .await
                }
                Err(error) => Ok(rejected_command_ack(
                    "invalid_input_part",
                    error.to_string(),
                    Some(CommandId::from(event_idempotency_key)),
                    Some(session_id.clone()),
                    None,
                )),
            }
        } else {
            accept_non_message_input(
                &state,
                &session_id,
                &event_idempotency_key,
                input,
                request_options.clone(),
            )
            .await
        };
        if matches!(ack_result, Ok(CommandAck::Rejected(_)) | Err(_)) {
            break;
        }
    }

    match ack_result {
        Ok(ack) => {
            let events = state
                .store
                .list_events(&session_id)
                .await
                .unwrap_or_default();
            publish_new_events(&state, &events, before_len);
            let is_ok = !matches!(ack, CommandAck::Rejected(_));
            record_velad_span(
                &state,
                trace_context.as_ref(),
                "velad.session.send_events",
                span_start,
                is_ok,
                Some(session_id.as_str()),
                None,
                if is_ok {
                    None
                } else {
                    Some(command_ack_error_message(&ack))
                },
                json!({
                    "velad.session_id": session_id.as_str(),
                    "velad.input_events": batch_len,
                }),
            )
            .await;
            (StatusCode::ACCEPTED, Json(command_ack_json(&ack, &events))).into_response()
        }
        Err(err) => {
            let message = err.to_string();
            record_velad_span(
                &state,
                trace_context.as_ref(),
                "velad.session.send_events",
                span_start,
                false,
                Some(session_id.as_str()),
                None,
                Some(message.clone()),
                json!({
                    "velad.session_id": session_id.as_str(),
                    "velad.input_events": batch_len,
                }),
            )
            .await;
            error(StatusCode::INTERNAL_SERVER_ERROR, "runtime_error", message)
        }
    }
}

async fn cancel_session<B>(
    State(state): State<ApiState<B>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Response
where
    B: BackendAdapter + 'static,
{
    control_command(
        &state,
        &SessionId::from(session_id),
        &headers,
        EventType::TURN_CANCEL_ACCEPTED,
        json!({}),
    )
    .await
}

async fn close_session<B>(
    State(state): State<ApiState<B>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Response
where
    B: BackendAdapter + 'static,
{
    control_command(
        &state,
        &SessionId::from(session_id),
        &headers,
        EventType::SESSION_CLOSED,
        json!({ "status": "closed" }),
    )
    .await
}

async fn control_command<B>(
    state: &ApiState<B>,
    session_id: &SessionId,
    headers: &HeaderMap,
    event_type: EventType,
    payload: Value,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let Some(idempotency_key) = idempotency_key(headers) else {
        return error(
            StatusCode::BAD_REQUEST,
            "missing_idempotency_key",
            "Idempotency-Key header is required",
        );
    };
    match state.store.get_session(session_id).await {
        Ok(None) => {
            return error(
                StatusCode::NOT_FOUND,
                "session_not_found",
                "session does not exist",
            );
        }
        Ok(Some(session))
            if session.status == "closed" && event_type != EventType::SESSION_CLOSED =>
        {
            let events = state
                .store
                .list_events(session_id)
                .await
                .unwrap_or_default();
            let ack = rejected_command_ack(
                "session_closed",
                "session is closed",
                Some(CommandId::from(idempotency_key)),
                Some(session_id.clone()),
                events.last().map(CanonicalEvent::cursor),
            );
            return (StatusCode::ACCEPTED, Json(command_ack_json(&ack, &events))).into_response();
        }
        Ok(Some(_)) => {}
        Err(err) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "store_error",
                err.to_string(),
            );
        }
    }

    match state
        .store
        .record_idempotency_acceptance(
            session_id,
            idempotency_key,
            &hash_value(&json!({
                "session_id": session_id.as_str(),
                "event_type": event_type.0,
                "payload": payload.clone(),
            })),
            Some(CommandId::from(idempotency_key)),
            event_type,
            EventSource::runtime("velad"),
            payload,
        )
        .await
    {
        Ok(acceptance) => {
            if acceptance.is_fresh() {
                if event_type == EventType::TURN_CANCEL_ACCEPTED {
                    if let Err(err) = state.runtime.cancel_backend(session_id).await {
                        return error(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "backend_cancel_failed",
                            err.to_string(),
                        );
                    }
                }
                if event_type == EventType::SESSION_CLOSED {
                    if let Err(err) = state
                        .store
                        .update_session_status(session_id, "closed")
                        .await
                    {
                        return error(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "store_error",
                            err.to_string(),
                        );
                    }
                }
            }
            let events = state
                .store
                .list_events(session_id)
                .await
                .unwrap_or_default();
            if acceptance.is_fresh() {
                publish_new_events(&state, &events, events.len().saturating_sub(1));
            }
            (
                StatusCode::ACCEPTED,
                Json(command_ack_json(&acceptance.ack(), &events)),
            )
                .into_response()
        }
        Err(err) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "store_error",
            err.to_string(),
        ),
    }
}

async fn list_session_events<B>(
    State(state): State<ApiState<B>>,
    Path(session_id): Path<String>,
    query: Result<Query<EventWindowQuery>, QueryRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let query = match parsed_query(query) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let session_id = SessionId::from(session_id);
    let limit = match validated_limit(query.limit) {
        Ok(limit) => limit,
        Err(response) => return response,
    };
    match state.store.list_events(&session_id).await {
        Ok(events) => {
            if cursor_is_stale(
                &events,
                query.after_id.as_deref(),
                query.before_id.as_deref(),
            ) {
                return (StatusCode::CONFLICT, Json(sync_reset_json(&events))).into_response();
            }
            let page = page_events(
                &events,
                query.after_id.as_deref(),
                query.before_id.as_deref(),
                limit,
            );
            Json(json!({
                "events": page.events.iter().map(event_json).collect::<Vec<_>>(),
                "cursor": page.cursor,
            }))
            .into_response()
        }
        Err(err) => error(StatusCode::NOT_FOUND, "session_not_found", err.to_string()),
    }
}

async fn stream_session_events<B>(
    State(state): State<ApiState<B>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    query: Result<Query<EventStreamQuery>, QueryRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let query = match parsed_query(query) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let session_id = SessionId::from(session_id);
    let after_id = query
        .after_id
        .as_deref()
        .or_else(|| last_event_id(&headers));
    let events = match events_or_404(&state, &session_id).await {
        Ok(events) => events,
        Err(response) => return response,
    };
    if cursor_is_stale(&events, after_id, None) {
        return sse_reset_response(&events, state.events.subscribe(), Some(session_id));
    }
    let page = page_events(&events, after_id, None, None);
    sse_live_response(page.events, state.events.subscribe(), Some(session_id))
}

async fn stream_workbench_events<B>(
    State(state): State<ApiState<B>>,
    headers: HeaderMap,
    query: Result<Query<EventStreamQuery>, QueryRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let query = match parsed_query(query) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let after_id = query
        .after_id
        .as_deref()
        .or_else(|| last_event_id(&headers));
    let mut events = Vec::new();
    for session in state.store.list_sessions().await.unwrap_or_default() {
        events.extend(
            state
                .store
                .list_events(&session.session_id)
                .await
                .unwrap_or_default(),
        );
    }
    events.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then(left.session_id.as_str().cmp(right.session_id.as_str()))
            .then(left.seq.cmp(&right.seq))
    });
    if cursor_is_stale(&events, after_id, None) {
        return sse_reset_response(&events, state.events.subscribe(), None);
    }
    let page = page_events(&events, after_id, None, None);
    sse_live_response(page.events, state.events.subscribe(), None)
}

async fn get_conversation_view<B>(
    State(state): State<ApiState<B>>,
    Path(session_id): Path<String>,
    query: Result<Query<ConversationViewQuery>, QueryRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let query = match parsed_query(query) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let limit = match validated_limit(query.limit) {
        Ok(limit) => limit,
        Err(response) => return response,
    };
    let window_query = match conversation_window_query(&query, limit.unwrap_or(80)) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let session_id = SessionId::from(session_id);
    let events = match events_or_404(&state, &session_id).await {
        Ok(events) => events,
        Err(response) => return response,
    };
    let session = state.store.get_session(&session_id).await.ok().flatten();
    observe_conversation_projection_invariants(
        state.observability.as_ref(),
        session.as_ref(),
        &events,
    )
    .await;
    let view = match project_conversation_window(&events, window_query) {
        Ok(view) => view,
        Err(ConversationWindowError::UnknownItemId(_)) => {
            return (StatusCode::CONFLICT, Json(sync_reset_json(&events))).into_response();
        }
    };
    Json(json!({
        "session_id": view.session_id.as_str(),
        "items": view.items.iter().map(|item| {
            let mut item_json = json!({
                "id": item.item_id,
                "kind": item.kind.as_str(),
                "created_at": item.created_at.to_rfc3339(),
                "updated_at": item.updated_at.to_rfc3339(),
                "revision": item.revision,
                "status": item.status,
                "source_event_ids": item.source_event_ids.iter().map(|id| id.as_str()).collect::<Vec<_>>(),
                "source_event_ranges": item.source_event_ranges.iter().map(source_event_range_json).collect::<Vec<_>>(),
            });
            if let Value::Object(object) = &mut item_json {
                if let Some(turn_id) = item.turn_id.as_ref() {
                    object.insert("turn_id".to_string(), json!(turn_id.as_str()));
                }
                if let Some(text) = item.text.as_ref() {
                    object.insert("text".to_string(), json!(text));
                }
                if !item.parts.is_empty() {
                    object.insert("parts".to_string(), json!(item.parts));
                }
                if let Some(title) = item.title.as_ref() {
                    object.insert("title".to_string(), json!(title));
                }
                if let Some(summary) = item.summary.as_ref() {
                    object.insert("summary".to_string(), json!(summary));
                }
                if item.kind.as_str() == "agent_work" {
                    object.insert(
                        "status".to_string(),
                        json!(activity_status_wire(item.status.as_str())),
                    );
                    object.insert(
                        "detail".to_string(),
                        activity_detail_json("tool", &item.detail).unwrap_or(Value::Null),
                    );
                    object.insert(
                        "event_range".to_string(),
                        event_range_json(&item.source_event_ids),
                    );
                }
            }
            item_json
        }).collect::<Vec<_>>(),
        "window": {
            "first_item_id": view.window.first_item_id,
            "last_item_id": view.window.last_item_id,
            "anchor_item_id": view.window.anchor_item_id,
            "has_older": view.window.has_older,
            "has_newer": view.window.has_newer,
        },
        "cursor": view.cursor.as_ref().map(event_cursor_value).unwrap_or_else(empty_cursor_json),
    }))
    .into_response()
}

async fn observe_conversation_projection_invariants(
    observability: Option<&ObservabilityStore>,
    session: Option<&StoredSession>,
    events: &[CanonicalEvent],
) {
    let (Some(observability), Some(session)) = (observability, session) else {
        return;
    };
    let pending_request_count = project_pending_requests(events).requests.len();
    if session_is_running(&session.status) || pending_request_count > 0 {
        return;
    }
    let conversation = project_conversation(events);
    let live_items = conversation
        .items
        .iter()
        .filter(|item| conversation_item_is_live(item.kind, item.status.as_str()))
        .collect::<Vec<_>>();
    let Some(first_live_item) = live_items.first() else {
        return;
    };
    let message = "conversation projection has live work while session is idle";
    let _ = observability
        .record_log(ManualLog {
            trace_id: None,
            span_id: None,
            severity: Some("ERROR".to_string()),
            body: Some(message.to_string()),
            session_id: Some(session.session_id.as_str().to_string()),
            backend: Some(session.backend.as_str().to_string()),
            error_message: Some(message.to_string()),
            attributes: json!({
                "vela.operation": "vela.conversation.projection_invariant",
                "vela.session_id": session.session_id.as_str(),
                "vela.session.status": session.status,
                "vela.session.pending_request_count": pending_request_count,
                "vela.conversation.live_item_count": live_items.len(),
                "vela.conversation.first_live_item_id": first_live_item.item_id,
                "vela.conversation.first_live_item_kind": first_live_item.kind.as_str(),
                "vela.conversation.first_live_item_status": first_live_item.status,
                "vela.turn_id": first_live_item.turn_id.as_ref().map(|turn_id| turn_id.as_str()),
            }),
            raw: json!({
                "source": "velad",
                "event": "conversation_projection_invariant",
            }),
        })
        .await;
}

fn conversation_item_is_live(kind: ConversationItemKind, status: &str) -> bool {
    match kind {
        ConversationItemKind::TurnMeta => status == "running",
        ConversationItemKind::AgentWork => status == "running" || status == "pending",
        ConversationItemKind::AssistantMessage => status == "streaming",
        ConversationItemKind::Status => status == "pending" || status == "streaming",
        ConversationItemKind::UserMessage => false,
    }
}

async fn get_requests_view<B>(
    State(state): State<ApiState<B>>,
    Path(session_id): Path<String>,
    query: Result<Query<RequestsViewQuery>, QueryRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let query = match parsed_query(query) {
        Ok(query) => query,
        Err(response) => return response,
    };
    if let Err(response) = validate_request_status(query.status.as_deref()) {
        return response;
    }
    let events = match events_or_404(&state, &SessionId::from(session_id)).await {
        Ok(events) => events,
        Err(response) => return response,
    };
    let requests = requests_from_events(&events, query.status.as_deref());
    Json(json!({
        "requests": requests,
        "cursor": cursor_window_json(&events),
    }))
    .into_response()
}

async fn get_diffs_view<B>(
    State(state): State<ApiState<B>>,
    Path(session_id): Path<String>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let events = match events_or_404(&state, &SessionId::from(session_id)).await {
        Ok(events) => events,
        Err(response) => return response,
    };
    Json(json!({
        "diffs": diffs_from_events(&events),
        "cursor": cursor_window_json(&events),
    }))
    .into_response()
}

async fn get_session_list_view<B>(
    State(state): State<ApiState<B>>,
    query: Result<Query<SessionListQuery>, QueryRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let query = match parsed_query(query) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let limit = match validated_limit(query.limit) {
        Ok(limit) => limit,
        Err(response) => return response,
    };
    let sessions = match state.store.list_sessions().await {
        Ok(sessions) => sessions,
        Err(err) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "store_error",
                err.to_string(),
            );
        }
    };

    let mut values = Vec::with_capacity(sessions.len());
    for session in &sessions {
        let events = match state.store.list_events(&session.session_id).await {
            Ok(events) => events,
            Err(err) => {
                return error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "store_error",
                    err.to_string(),
                );
            }
        };
        values.push(session_list_item_json(session, &events));
    }

    let page = page_values(values, query.after_id.as_deref(), None, limit);
    Json(json!({
        "sessions": page.items,
        "cursor": page.cursor,
    }))
    .into_response()
}

async fn get_timeline<B>(
    State(state): State<ApiState<B>>,
    Path(session_id): Path<String>,
    query: Result<Query<TimelineQuery>, QueryRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let query = match parsed_query(query) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let limit = match validated_limit(query.limit) {
        Ok(limit) => limit,
        Err(response) => return response,
    };
    let events = match events_or_404(&state, &SessionId::from(session_id)).await {
        Ok(events) => events,
        Err(response) => return response,
    };
    let page = page_events(&events, None, query.before_id.as_deref(), limit);
    Json(json!({
        "items": coalesced_timeline_items(&page.events),
        "cursor": page.cursor,
    }))
    .into_response()
}

async fn get_timeline_item<B>(
    State(state): State<ApiState<B>>,
    Path((session_id, item_id)): Path<(String, String)>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let events = match events_or_404(&state, &SessionId::from(session_id)).await {
        Ok(events) => events,
        Err(response) => return response,
    };
    match events
        .iter()
        .find(|event| event.event_id.as_str() == item_id)
    {
        Some(event) => Json(json!({ "item": timeline_item_json(event) })).into_response(),
        None => error(
            StatusCode::NOT_FOUND,
            "timeline_item_not_found",
            "timeline item does not exist",
        ),
    }
}

async fn get_trace<B>(
    State(state): State<ApiState<B>>,
    Path(session_id): Path<String>,
    query: Result<Query<TraceQuery>, QueryRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let query = match parsed_query(query) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let limit = match validated_limit(query.limit) {
        Ok(limit) => limit,
        Err(response) => return response,
    };
    let session_id = SessionId::from(session_id);
    let events = match events_or_404(&state, &session_id).await {
        Ok(events) => events,
        Err(response) => return response,
    };
    let page = page_events(&events, query.after_id.as_deref(), None, limit);
    Json(json!({
        "session_id": session_id.as_str(),
        "spans": trace_spans_from_events(&page.events),
        "cursor": page.cursor,
    }))
    .into_response()
}

async fn get_request<B>(
    State(state): State<ApiState<B>>,
    Path(request_id): Path<String>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    for session in state.store.list_sessions().await.unwrap_or_default() {
        let events = state
            .store
            .list_events(&session.session_id)
            .await
            .unwrap_or_default();
        if let Some(request) = requests_from_events(&events, None)
            .into_iter()
            .find(|request| request["id"] == request_id)
        {
            return Json(json!({ "request": request })).into_response();
        }
    }
    error(
        StatusCode::NOT_FOUND,
        "request_not_found",
        "request does not exist",
    )
}

async fn list_backends<B>(State(state): State<ApiState<B>>) -> Response
where
    B: BackendAdapter + 'static,
{
    Json(json!({ "backends": backend_snapshot::catalog_json(&state).await })).into_response()
}

async fn get_backend<B>(State(state): State<ApiState<B>>, Path(backend): Path<String>) -> Response
where
    B: BackendAdapter + 'static,
{
    match backend_snapshot::snapshot_for_kind(&state, &backend).await {
        Some(backend) => Json(json!({ "backend": backend.to_wire_json() })).into_response(),
        None => error(
            StatusCode::NOT_FOUND,
            "backend_not_found",
            "backend is not configured",
        ),
    }
}

async fn get_backend_usage<B>(
    State(state): State<ApiState<B>>,
    headers: HeaderMap,
    Path(backend): Path<String>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let start_time = Utc::now();
    let trace_context = trace_context_from_headers(&headers);
    let Some(configured) = state
        .configured_backends
        .iter()
        .find(|item| item.kind == backend)
    else {
        return error(
            StatusCode::NOT_FOUND,
            "backend_not_found",
            "backend is not configured",
        );
    };
    let snapshot = state.backend_usage.fetch(configured).await;
    let status = snapshot.status;
    let backend_type = snapshot.backend_type.clone();
    let source = snapshot.source.clone();
    let detail = snapshot.detail.clone();
    record_velad_span(
        &state,
        trace_context.as_ref(),
        "velad.backend_usage.fetch",
        start_time,
        !status.is_error(),
        None,
        Some(&backend),
        status.is_error().then(|| {
            detail
                .clone()
                .unwrap_or_else(|| "backend usage fetch failed".to_string())
        }),
        json!({
            "velad.backend": backend,
            "velad.backend_type": backend_type,
            "velad.backend_usage.status": status.as_str(),
            "velad.backend_usage.source": source,
        }),
    )
    .await;
    Json(snapshot).into_response()
}

async fn probe_backend<B>(State(state): State<ApiState<B>>, Path(backend): Path<String>) -> Response
where
    B: BackendAdapter + 'static,
{
    if !state
        .configured_backends
        .iter()
        .any(|item| item.kind == backend)
    {
        return Json(json!({
            "backend": backend,
            "status": "unavailable",
            "message": "backend is not configured",
        }))
        .into_response();
    }
    let backend_kind = BackendKindWire::from_str(&backend)
        .and_then(|backend| state.configured_engine_kind(backend));
    match state.runtime.probe_backend(backend_kind).await {
        Ok(probe) => Json(json!({
            "backend": backend,
            "status": probe.status.as_str(),
            "message": probe.message,
        }))
        .into_response(),
        Err(err) => Json(json!({
            "backend": backend,
            "status": "unavailable",
            "message": err.to_string(),
        }))
        .into_response(),
    }
}

#[derive(Debug, Serialize)]
struct BackendSkillsResponse {
    schema: &'static str,
    backend: BackendKindWire,
    cwd: Option<String>,
    skill_protocol: &'static str,
    capabilities: BackendSkillsCapabilities,
    skills: Vec<BackendSkillDescriptor>,
}

#[derive(Debug, Serialize)]
struct BackendSkillsCapabilities {
    discovery: bool,
    invocation: &'static str,
    requires_text_token: bool,
    preferred_token_prefix: &'static str,
    accepted_token_prefixes: Vec<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
struct BackendSkillDescriptor {
    name: String,
    display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    path: String,
    origin: &'static str,
    scope: &'static str,
    protocol: &'static str,
}

async fn list_backend_skills<B>(
    State(state): State<ApiState<B>>,
    Path(backend): Path<String>,
    query: Result<Query<BackendSkillsQuery>, QueryRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let query = match parsed_query(query) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let Some(backend_kind) = BackendKindWire::from_str(&backend) else {
        return error(
            StatusCode::NOT_FOUND,
            "backend_not_found",
            "backend is not configured",
        );
    };
    if state.configured_engine_kind(backend_kind).is_none() {
        return error(
            StatusCode::NOT_FOUND,
            "backend_not_found",
            "backend is not configured",
        );
    }

    let supports_codex_skills = matches!(
        backend_kind,
        BackendKindWire::Codex | BackendKindWire::VelaEngine
    );
    let skills = if supports_codex_skills {
        discover_codex_skills(query.cwd.as_deref())
    } else {
        Vec::new()
    };
    Json(BackendSkillsResponse {
        schema: "velad.backend_skills.v1",
        backend: backend_kind,
        cwd: query.cwd,
        skill_protocol: "codex.skills.v1",
        capabilities: BackendSkillsCapabilities {
            discovery: supports_codex_skills,
            invocation: if supports_codex_skills { "native" } else { "none" },
            requires_text_token: true,
            preferred_token_prefix: "$",
            accepted_token_prefixes: vec!["$", "/"],
        },
        skills,
    })
    .into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VelaEngineBackendSettingsPatch {
    endpoint: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateNodeRequest {
    provider: String,
    display_name: Option<String>,
    ssh: Option<SshNodeRequest>,
    auth: Option<NodeAuthRequest>,
    target: Option<NodeTargetRequest>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SshNodeRequest {
    host: String,
    port: Option<u16>,
    username: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeAuthRequest {
    method: String,
    password: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeTargetRequest {
    os: Option<String>,
    arch: Option<String>,
}

struct NormalizedNodeCreate {
    display_name: String,
    config: Value,
    password: String,
}

async fn list_node_providers<B>() -> Response
where
    B: BackendAdapter + 'static,
{
    Json(runtime_targets::node_providers_json()).into_response()
}

async fn list_nodes<B>(State(state): State<ApiState<B>>) -> Response
where
    B: BackendAdapter + 'static,
{
    match state.store.list_nodes().await {
        Ok(nodes) => Json(runtime_targets::nodes_json(&nodes)).into_response(),
        Err(err) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "nodes_read_failed",
            err.to_string(),
        ),
    }
}

async fn create_node<B>(
    State(state): State<ApiState<B>>,
    request: Result<Json<CreateNodeRequest>, JsonRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let request = match request {
        Ok(Json(request)) => request,
        Err(rejection) => return invalid_request(rejection.to_string()),
    };
    let normalized = match normalize_create_node_request(request) {
        Ok(normalized) => normalized,
        Err(response) => return response,
    };
    let node_id = format!("node_{}", uuid::Uuid::new_v4().simple());
    let secret_ref = runtime_targets::ssh_password_secret_ref(&node_id);

    if let Err(err) = state
        .node_secret_store
        .put_password(&secret_ref, &normalized.password)
        .await
    {
        return error(StatusCode::SERVICE_UNAVAILABLE, err.code, err.message);
    }

    match state
        .store
        .create_node(
            &node_id,
            runtime_targets::SSH_PROVIDER_ID,
            &normalized.display_name,
            normalized.config,
            Some(&secret_ref),
        )
        .await
    {
        Ok(node) => (
            StatusCode::CREATED,
            Json(runtime_targets::node_response_json(&node)),
        )
            .into_response(),
        Err(err) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "node_write_failed",
            err.to_string(),
        ),
    }
}

async fn list_runtime_targets<B>(State(state): State<ApiState<B>>) -> Response
where
    B: BackendAdapter + 'static,
{
    let local_api_base_url = state
        .local_runtime
        .as_ref()
        .map(|runtime| runtime.info.api_base_url.as_str());
    match state.store.list_nodes().await {
        Ok(nodes) => Json(runtime_targets::runtime_targets_json(
            &nodes,
            local_api_base_url,
            &state.runtime_target_manager.snapshots().await,
        ))
        .into_response(),
        Err(err) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "runtime_targets_read_failed",
            err.to_string(),
        ),
    }
}

async fn connect_runtime_target<B>(
    State(state): State<ApiState<B>>,
    Path(target_id): Path<String>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let Some(node_id) = node_id_from_target_id(&target_id) else {
        return error(
            StatusCode::BAD_REQUEST,
            "unsupported_runtime_target",
            "only remote node runtime targets can be connected",
        );
    };
    let node = match state.store.get_node(node_id).await {
        Ok(Some(node)) => node,
        Ok(None) => {
            return error(
                StatusCode::NOT_FOUND,
                "node_not_found",
                format!("node not found: {node_id}"),
            );
        }
        Err(err) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "node_read_failed",
                err.to_string(),
            );
        }
    };
    let Some(secret_ref) = node.secret_ref.as_deref() else {
        return error(
            StatusCode::BAD_REQUEST,
            "node_auth_missing",
            "node password is not configured",
        );
    };
    let password = match state.node_secret_store.get_password(secret_ref).await {
        Ok(password) => password,
        Err(err) => return error(StatusCode::SERVICE_UNAVAILABLE, err.code, err.message),
    };
    match state
        .runtime_target_manager
        .connect_node(node, password)
        .await
    {
        Ok(snapshot) => {
            Json(runtime_targets::runtime_target_response_json(&snapshot)).into_response()
        }
        Err(err) => error(StatusCode::BAD_GATEWAY, err.code, err.message),
    }
}

async fn disconnect_runtime_target<B>(
    State(state): State<ApiState<B>>,
    Path(target_id): Path<String>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    let Some(node_id) = node_id_from_target_id(&target_id) else {
        return error(
            StatusCode::BAD_REQUEST,
            "unsupported_runtime_target",
            "only remote node runtime targets can be disconnected",
        );
    };
    match state
        .runtime_target_manager
        .disconnect_target(&target_id)
        .await
    {
        Ok(Some(snapshot)) => {
            Json(runtime_targets::runtime_target_response_json(&snapshot)).into_response()
        }
        Ok(None) => match state.store.get_node(node_id).await {
            Ok(Some(node)) => Json(runtime_targets::disconnected_runtime_target_response_json(
                &node,
            ))
            .into_response(),
            Ok(None) => error(
                StatusCode::NOT_FOUND,
                "node_not_found",
                format!("node not found: {node_id}"),
            ),
            Err(err) => error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "node_read_failed",
                err.to_string(),
            ),
        },
        Err(err) => error(StatusCode::BAD_GATEWAY, err.code, err.message),
    }
}

fn node_id_from_target_id(target_id: &str) -> Option<&str> {
    target_id.strip_prefix("target:")
}

fn normalize_create_node_request(
    request: CreateNodeRequest,
) -> Result<NormalizedNodeCreate, Response> {
    if request.provider != runtime_targets::SSH_PROVIDER_ID {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "unsupported_node_provider",
            "node provider must be ssh",
        ));
    }
    let ssh = request.ssh.ok_or_else(|| {
        error(
            StatusCode::BAD_REQUEST,
            "missing_ssh_config",
            "ssh config is required for ssh nodes",
        )
    })?;
    let host = ssh.host.trim();
    if host.is_empty() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_node_host",
            "ssh host must not be empty",
        ));
    }
    let username = ssh.username.trim();
    if username.is_empty() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_node_username",
            "ssh username must not be empty",
        ));
    }
    let port = ssh.port.unwrap_or(22);
    if port == 0 {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_node_port",
            "ssh port must be greater than zero",
        ));
    }

    let auth = request.auth.ok_or_else(|| {
        error(
            StatusCode::BAD_REQUEST,
            "missing_node_auth",
            "ssh nodes require password auth in v1",
        )
    })?;
    if auth.method != "password" {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "unsupported_node_auth",
            "ssh nodes support password auth only in v1",
        ));
    }
    let password = auth.password.unwrap_or_default().trim().to_string();
    if password.is_empty() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "missing_node_password",
            "ssh password must not be empty",
        ));
    }

    let target = request.target.unwrap_or_default();
    let os = target
        .os
        .unwrap_or_else(|| "linux".to_string())
        .trim()
        .to_string();
    if os != "linux" && os != "darwin" {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "unsupported_node_os",
            "ssh target os must be linux or darwin",
        ));
    }
    let arch = target
        .arch
        .unwrap_or_else(|| "x86_64".to_string())
        .trim()
        .to_string();
    let arch = match arch.as_str() {
        "x86_64" | "amd64" => "x86_64",
        _ => {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "unsupported_node_arch",
                "ssh target arch must be x86_64 or amd64",
            ));
        }
    };

    let display_name = request
        .display_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("{username}@{host}"));

    Ok(NormalizedNodeCreate {
        display_name,
        password,
        config: json!({
            "ssh": {
                "host": host,
                "port": port,
                "username": username,
            },
            "target": {
                "os": os,
                "arch": arch,
            }
        }),
    })
}

async fn get_backend_settings<B>(
    State(state): State<ApiState<B>>,
    Path(backend): Path<String>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    if let Err(response) = ensure_backend_settings_supported(&state, &backend) {
        return response;
    }
    let (settings, updated_at) = match state.store.get_backend_settings("vela_engine").await {
        Ok(Some(stored)) => (
            vela_engine_backend_settings_from_json(stored.settings),
            Some(stored.updated_at.to_rfc3339()),
        ),
        Ok(None) => (VelaEngineBackendSettings::default(), None),
        Err(err) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "backend_settings_read_failed",
                err.to_string(),
            );
        }
    };
    Json(vela_engine_backend_settings_json(
        &backend, &settings, updated_at,
    ))
    .into_response()
}

async fn patch_backend_settings<B>(
    State(state): State<ApiState<B>>,
    Path(backend): Path<String>,
    request: Result<Json<VelaEngineBackendSettingsPatch>, JsonRejection>,
) -> Response
where
    B: BackendAdapter + 'static,
{
    if let Err(response) = ensure_backend_settings_supported(&state, &backend) {
        return response;
    }
    let patch = match request {
        Ok(Json(patch)) => patch,
        Err(rejection) => return invalid_request(rejection.to_string()),
    };
    let mut settings = match load_vela_engine_backend_settings(&state).await {
        Ok(settings) => settings,
        Err(response) => return response,
    };
    if let Some(endpoint) = patch.endpoint {
        settings.endpoint = endpoint.trim().to_string();
    }
    if let Some(api_key) = patch.api_key {
        settings.api_key = api_key.trim().to_string();
    }
    if let Some(model) = patch.model {
        settings.model = model.trim().to_string();
    }

    if let Some(updater) = &state.backend_settings_updater {
        updater.update_vela_engine(settings.clone());
    }
    let stored = match state
        .store
        .upsert_backend_settings(
            &backend,
            vela_engine_backend_settings_storage_json(&settings),
        )
        .await
    {
        Ok(stored) => stored,
        Err(err) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "backend_settings_write_failed",
                err.to_string(),
            );
        }
    };
    Json(vela_engine_backend_settings_json(
        &backend,
        &settings,
        Some(stored.updated_at.to_rfc3339()),
    ))
    .into_response()
}

fn ensure_backend_settings_supported<B>(state: &ApiState<B>, backend: &str) -> Result<(), Response>
where
    B: BackendAdapter + 'static,
{
    let Some(configured) = state
        .configured_backends
        .iter()
        .find(|item| item.kind == backend)
    else {
        return Err(error(
            StatusCode::NOT_FOUND,
            "backend_not_found",
            "backend is not configured",
        ));
    };
    if configured.kind != "vela_engine" {
        return Err(error(
            StatusCode::NOT_FOUND,
            "backend_settings_not_supported",
            "backend settings are not supported for this backend",
        ));
    }
    Ok(())
}

async fn load_vela_engine_backend_settings<B>(
    state: &ApiState<B>,
) -> Result<VelaEngineBackendSettings, Response>
where
    B: BackendAdapter + 'static,
{
    match state.store.get_backend_settings("vela_engine").await {
        Ok(Some(stored)) => Ok(vela_engine_backend_settings_from_json(stored.settings)),
        Ok(None) => Ok(VelaEngineBackendSettings::default()),
        Err(err) => Err(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "backend_settings_read_failed",
            err.to_string(),
        )),
    }
}

fn vela_engine_backend_settings_from_json(value: Value) -> VelaEngineBackendSettings {
    let object = value.as_object();
    VelaEngineBackendSettings {
        endpoint: object
            .and_then(|object| object.get("endpoint"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        api_key: object
            .and_then(|object| object.get("api_key"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        model: object
            .and_then(|object| object.get("model"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }
}

fn vela_engine_backend_settings_storage_json(settings: &VelaEngineBackendSettings) -> Value {
    json!({
        "endpoint": settings.endpoint,
        "api_key": settings.api_key,
        "model": settings.model,
    })
}

fn vela_engine_backend_settings_json(
    backend: &str,
    settings: &VelaEngineBackendSettings,
    updated_at: Option<String>,
) -> Value {
    let missing_fields = vela_engine_missing_settings(settings);
    json!({
        "schema": "velad.backend_settings.v1",
        "backend": backend,
        "settings": {
            "endpoint": settings.endpoint,
            "api_key_set": !settings.api_key.is_empty(),
            "model": settings.model,
        },
        "status": if missing_fields.is_empty() { "configured" } else { "unconfigured" },
        "missing_fields": missing_fields,
        "updated_at": updated_at,
    })
}

fn vela_engine_missing_settings(settings: &VelaEngineBackendSettings) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if settings.endpoint.trim().is_empty() {
        missing.push("endpoint");
    }
    if settings.api_key.trim().is_empty() {
        missing.push("api_key");
    }
    if settings.model.trim().is_empty() {
        missing.push("model");
    }
    missing
}

async fn events_or_404<B>(
    state: &ApiState<B>,
    session_id: &SessionId,
) -> Result<Vec<CanonicalEvent>, Response>
where
    B: BackendAdapter + 'static,
{
    match state.store.session_exists(session_id).await {
        Ok(true) => state.store.list_events(session_id).await.map_err(|err| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "store_error",
                err.to_string(),
            )
        }),
        Ok(false) => Err(error(
            StatusCode::NOT_FOUND,
            "session_not_found",
            "session does not exist",
        )),
        Err(err) => Err(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "store_error",
            err.to_string(),
        )),
    }
}

fn idempotency_key(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("Idempotency-Key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
}

fn last_event_id(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("Last-Event-ID")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
}

fn parsed_query<T>(query: Result<Query<T>, QueryRejection>) -> Result<T, Response> {
    query
        .map(|Query(query)| query)
        .map_err(|err| invalid_parameter("query", err.to_string()))
}

fn scoped_idempotency_key(base: &str, index: usize, batch_len: usize) -> String {
    if batch_len == 1 {
        base.to_string()
    } else {
        format!("{base}#{index}")
    }
}

fn validated_limit(limit: Option<usize>) -> Result<Option<usize>, Response> {
    match limit {
        Some(0) => Err(invalid_parameter("limit", "limit must be at least 1")),
        Some(value) if value > 500 => Err(invalid_parameter("limit", "limit must be at most 500")),
        value => Ok(value),
    }
}

fn conversation_window_query(
    query: &ConversationViewQuery,
    limit: usize,
) -> Result<ConversationWindowQuery, Response> {
    let direction = query.direction.unwrap_or(ViewWindowDirection::Tail);
    let direction = match direction {
        ViewWindowDirection::Tail => ConversationWindowDirection::Tail,
        ViewWindowDirection::Before => ConversationWindowDirection::Before,
        ViewWindowDirection::After => ConversationWindowDirection::After,
        ViewWindowDirection::Around => ConversationWindowDirection::Around,
    };
    match direction {
        ConversationWindowDirection::Tail => {
            if query.anchor_item_id.is_some() {
                Err(invalid_parameter(
                    "anchor_item_id",
                    "direction=tail cannot include anchor_item_id",
                ))
            } else {
                Ok(ConversationWindowQuery {
                    anchor_item_id: None,
                    direction,
                    limit,
                })
            }
        }
        ConversationWindowDirection::Before
        | ConversationWindowDirection::After
        | ConversationWindowDirection::Around => match query.anchor_item_id.clone() {
            Some(anchor) => Ok(ConversationWindowQuery {
                anchor_item_id: Some(anchor),
                direction,
                limit,
            }),
            None => Err(invalid_parameter(
                "anchor_item_id",
                "anchor_item_id is required for anchored conversation windows",
            )),
        },
    }
}

fn validate_request_status(status: Option<&str>) -> Result<(), Response> {
    match status {
        None | Some("pending") | Some("approved") | Some("denied") | Some("answered")
        | Some("expired") | Some("cancelled") => Ok(()),
        Some(_) => Err(invalid_parameter(
            "status",
            "status must be one of pending, approved, denied, answered, expired, cancelled",
        )),
    }
}

async fn accept_non_message_input<B>(
    state: &ApiState<B>,
    session_id: &SessionId,
    idempotency_key: &str,
    input: &ClientInputEvent,
    request_options: Option<Value>,
) -> anyhow::Result<CommandAck>
where
    B: BackendAdapter + 'static,
{
    if !matches!(
        input.event_type.as_str(),
        "user.tool_confirmation" | "user.custom_tool_result" | "user.request_answer"
    ) {
        return Ok(rejected_command_ack(
            "invalid_input_event",
            format!("unsupported input event type: {}", input.event_type),
            Some(CommandId::from(idempotency_key)),
            Some(session_id.clone()),
            state
                .store
                .list_events(session_id)
                .await
                .ok()
                .and_then(|events| events.last().map(CanonicalEvent::cursor)),
        ));
    }
    let request_id = input.request_id.clone().unwrap_or_default();
    let accepted = state
        .store
        .record_idempotency_acceptance(
            session_id,
            idempotency_key,
            &hash_value(&json!({
                "session_id": session_id.as_str(),
                "input": input,
            })),
            Some(CommandId::from(idempotency_key)),
            EventType::REQUEST_RESPONSE_ACCEPTED,
            EventSource::runtime("velad"),
            json!({
                "request_id": request_id,
                "input_type": input.event_type,
                "result": input.result,
                "scope": input.scope,
                "answer": input.answer,
                "content": input.content,
                "options": input.options,
                "request_options": request_options,
            }),
        )
        .await?;
    if accepted.is_hash_mismatch() || accepted.is_replay() {
        return Ok(accepted.ack());
    }

    let cursor = match accepted.ack() {
        CommandAck::Accepted(ack) => ack.cursor.clone(),
        CommandAck::Queued(ack) => ack.cursor.clone(),
        CommandAck::Rejected(_) => unreachable!("fresh idempotency acceptance cannot reject"),
    };

    match input.event_type.as_str() {
        "user.tool_confirmation" => {
            state
                .store
                .append_event(
                    session_id,
                    EventType::REQUEST_RESOLVED,
                    EventSource::runtime("velad"),
                    json!({
                        "request_id": request_id,
                        "status": if input.result.as_deref() == Some("deny") { "denied" } else { "approved" },
                        "result": input.result,
                        "scope": input.scope,
                    }),
                    None,
                )
                .await?;
        }
        "user.custom_tool_result" => {
            state
                .store
                .append_event(
                    session_id,
                    EventType::TOOL_COMPLETED,
                    EventSource::runtime("velad"),
                    json!({
                        "tool_id": request_id,
                        "name": "custom_tool_result",
                        "status": "completed",
                        "detail": { "content": input.content },
                    }),
                    None,
                )
                .await?;
        }
        "user.request_answer" => {
            state
                .store
                .append_event(
                    session_id,
                    EventType::REQUEST_RESOLVED,
                    EventSource::runtime("velad"),
                    json!({
                        "request_id": request_id,
                        "status": "answered",
                        "answer": input.answer,
                    }),
                    None,
                )
                .await?;
        }
        _ => anyhow::bail!("unsupported input event type: {}", input.event_type),
    }

    if matches!(
        input.event_type.as_str(),
        "user.tool_confirmation" | "user.custom_tool_result" | "user.request_answer"
    ) {
        state
            .runtime
            .respond_to_request(
                session_id,
                request_id.clone(),
                input.result.clone(),
                input.scope.clone(),
                input.answer.clone(),
                input.content.as_ref().map(|content| json!(content)),
                input.options.clone(),
            )
            .await?;
    }

    Ok(CommandAck::Accepted(AcceptedCommandAck {
        command_id: CommandId::from(idempotency_key),
        session_id: session_id.clone(),
        cursor,
        turn_id: None,
    }))
}

fn discover_codex_skills(cwd: Option<&str>) -> Vec<BackendSkillDescriptor> {
    let mut roots = Vec::new();
    if let Some(value) = env::var_os("VELAD_SKILLS_DIR") {
        for root in env::split_paths(&value) {
            roots.push(SkillRoot {
                path: root,
                origin: "env",
                scope: "runtime",
            });
        }
    }
    if let Some(home) = home_dir() {
        roots.push(SkillRoot {
            path: home.join(".codex/skills"),
            origin: "codex_home",
            scope: "user",
        });
        roots.push(SkillRoot {
            path: home.join(".agents/skills"),
            origin: "agents_home",
            scope: "user",
        });
    }
    if let Some(cwd) = cwd.and_then(normalized_cwd_path) {
        roots.push(SkillRoot {
            path: cwd.join(".codex/skills"),
            origin: "workspace",
            scope: "project",
        });
        roots.push(SkillRoot {
            path: cwd.join(".agents/skills"),
            origin: "workspace",
            scope: "project",
        });
    }

    let mut skills = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for root in roots {
        for skill in discover_skills_in_root(&root) {
            if seen.insert(skill.name.clone()) {
                skills.push(skill);
            }
        }
    }
    skills.sort_by(|left, right| left.name.cmp(&right.name));
    skills
}

struct SkillRoot {
    path: PathBuf,
    origin: &'static str,
    scope: &'static str,
}

fn discover_skills_in_root(root: &SkillRoot) -> Vec<BackendSkillDescriptor> {
    let entries = match fs::read_dir(&root.path) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() || !path.join("SKILL.md").is_file() {
                return None;
            }
            let name = path.file_name()?.to_str()?.to_string();
            if !is_valid_skill_name(&name) {
                return None;
            }
            Some(BackendSkillDescriptor {
                display_name: display_name_from_skill_name(&name),
                description: read_skill_description(&path.join("SKILL.md")),
                path: path.to_string_lossy().to_string(),
                name,
                origin: root.origin,
                scope: root.scope,
                protocol: "codex.skills.v1",
            })
        })
        .collect()
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("USERPROFILE")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
}

fn normalized_cwd_path(cwd: &str) -> Option<PathBuf> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

fn is_valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn display_name_from_skill_name(name: &str) -> String {
    name.replace(['-', '_'], " ")
}

fn read_skill_description(path: &FsPath) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines().take(24) {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(description) = line.strip_prefix("description:") {
            let description = description.trim().trim_matches('"').trim_matches('\'');
            if !description.is_empty() {
                return Some(description.to_string());
            }
        }
        if line.len() >= 8 {
            return Some(line.chars().take(180).collect());
        }
    }
    None
}

fn input_content(input: &ClientInputEvent) -> String {
    input
        .content
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|part| match part.part_type.as_str() {
            "text" => part.text.clone().unwrap_or_default(),
            "file_ref" | "image_ref" => part.uri.clone().unwrap_or_default(),
            _ => String::new(),
        })
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn input_message_blocks(input: &ClientInputEvent) -> anyhow::Result<Vec<UserMessageBlock>> {
    input
        .content
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter_map(|part| match part.part_type.as_str() {
            "text" => part
                .text
                .as_ref()
                .filter(|text| !text.is_empty())
                .map(|text| Ok(UserMessageBlock::text(text.clone()))),
            "skill_ref" => Some(skill_block_from_part(part)),
            "image" => Some(image_block_from_part(part)),
            _ => None,
        })
        .collect()
}

fn skill_block_from_part(part: &InputPart) -> anyhow::Result<UserMessageBlock> {
    let name = part
        .name
        .clone()
        .ok_or_else(|| anyhow::anyhow!("skill_ref input part requires name"))?;
    if !is_valid_skill_name(&name) {
        anyhow::bail!("skill_ref input part name is invalid");
    }
    let protocol = part
        .protocol
        .clone()
        .unwrap_or_else(|| "codex.skills.v1".to_string());
    if protocol != "codex.skills.v1" {
        anyhow::bail!("skill_ref input part protocol is unsupported");
    }
    Ok(UserMessageBlock::skill_ref(
        name,
        protocol,
        part.backend.and_then(BackendKindWire::engine_kind),
        part.path.clone(),
    ))
}

fn image_block_from_part(part: &InputPart) -> anyhow::Result<UserMessageBlock> {
    let data = part
        .data
        .clone()
        .ok_or_else(|| anyhow::anyhow!("image input part requires data"))?;
    let mime_type = part
        .mime_type
        .clone()
        .ok_or_else(|| anyhow::anyhow!("image input part requires mime_type"))?;
    let bytes = BASE64_STANDARD
        .decode(&data)
        .map_err(|error| anyhow::anyhow!("image input part data is not valid base64: {error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(UserMessageBlock::Image {
        blob: BlobRef::InlineBase64 {
            data,
            mime_type,
            sha256: Some(format!("{:x}", hasher.finalize())),
            size_bytes: Some(bytes.len() as u64),
        },
    })
}

fn contains_structured_block(blocks: &[UserMessageBlock]) -> bool {
    blocks
        .iter()
        .any(|block| !matches!(block, UserMessageBlock::Text { .. }))
}

fn hash_value(value: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.to_string().as_bytes());
    format!("{:x}", hasher.finalize())
}

fn same_create_request(
    existing: &StoredSession,
    backend: BackendKindWire,
    request: &CreateSessionRequest,
) -> bool {
    existing.backend == backend.engine_kind().unwrap_or(BackendKind::Pi)
        && existing.working_directory == request.working_directory
        && existing.title
            == request
                .title
                .clone()
                .unwrap_or_else(|| existing.session_id.to_string())
        && existing.agent_config
            == request
                .agent_config
                .clone()
                .unwrap_or_else(|| AgentConfig::with_model(request.model.as_deref()))
        && existing.metadata == request.metadata.clone().unwrap_or_else(|| json!({}))
}

async fn create_session_agent_config<B>(
    state: &ApiState<B>,
    request: &CreateSessionRequest,
) -> Result<AgentConfig, Response>
where
    B: BackendAdapter + 'static,
{
    let Some(configured_backend) = state.configured_backend(request.backend) else {
        return Err(error(
            StatusCode::CONFLICT,
            "backend_unavailable",
            format!("backend {} is not configured", request.backend.as_str()),
        ));
    };
    let mut agent_config = request.agent_config.clone().unwrap_or_default();
    if agent_config.model.is_none() {
        agent_config.model = request.model.clone();
    }
    let snapshot = backend_snapshot::snapshot(state, configured_backend).await;
    ensure_snapshot_accepts_session(configured_backend, &snapshot)?;
    apply_backend_agent_config_defaults(configured_backend, &snapshot, &mut agent_config);
    validate_agent_config_for_backend(configured_backend, &snapshot, &agent_config)?;
    Ok(agent_config)
}

async fn validate_session_agent_config<B>(
    state: &ApiState<B>,
    backend: BackendKind,
    agent_config: &AgentConfig,
) -> Result<(), Response>
where
    B: BackendAdapter + 'static,
{
    let Some(configured_backend) = state.configured_backend_for_engine(backend) else {
        return Err(error(
            StatusCode::CONFLICT,
            "backend_unavailable",
            format!("backend {} is not configured", backend.as_str()),
        ));
    };
    let snapshot = backend_snapshot::snapshot(state, configured_backend).await;
    ensure_snapshot_accepts_session(configured_backend, &snapshot)?;
    validate_agent_config_for_backend(configured_backend, &snapshot, agent_config)
}

fn ensure_snapshot_accepts_session(
    backend: &ConfiguredBackend,
    snapshot: &backend_snapshot::BackendSnapshot,
) -> Result<(), Response> {
    if snapshot.status.accepts_session_creation() {
        return Ok(());
    }
    Err(error(
        StatusCode::CONFLICT,
        "backend_unavailable",
        snapshot
            .status_message
            .clone()
            .unwrap_or_else(|| format!("backend {} is not available", backend.kind)),
    ))
}

fn apply_backend_agent_config_defaults(
    backend: &ConfiguredBackend,
    snapshot: &backend_snapshot::BackendSnapshot,
    agent_config: &mut AgentConfig,
) {
    if agent_config.model.is_none() {
        agent_config.model = snapshot.default_model().or_else(|| backend.default_model());
    }
    if agent_config.permission_mode.is_none() && is_codex_family_backend(backend.kind) {
        agent_config.permission_mode = Some(PermissionMode::Auto);
    }
    if agent_config.reasoning_effort.is_none()
        && let Some(model) = agent_config.model.as_deref()
        && let Some(default_reasoning) = snapshot.default_reasoning_for_model(model)
    {
        agent_config.reasoning_effort = Some(default_reasoning);
    }
}

fn validate_agent_config_for_backend(
    backend: &ConfiguredBackend,
    snapshot: &backend_snapshot::BackendSnapshot,
    agent_config: &AgentConfig,
) -> Result<(), Response> {
    let validates_against_snapshot =
        is_codex_family_backend(backend.kind) || backend.kind == "vela_engine";
    if validates_against_snapshot {
        if let Some(model) = agent_config.model.as_deref()
            && !snapshot.has_model(model)
        {
            return Err(invalid_agent_config(format!(
                "model {model} is not available for backend {}",
                backend.kind
            )));
        }
        if let Some(reasoning_effort) = agent_config.reasoning_effort.as_deref() {
            let Some(model) = agent_config.model.as_deref() else {
                return Err(invalid_agent_config(
                    "reasoning_effort requires a selected model",
                ));
            };
            let reasoning_options = snapshot.reasoning_options_for_model(model);
            if !reasoning_options.is_empty()
                && !reasoning_options
                    .iter()
                    .any(|option| option.id == reasoning_effort)
            {
                return Err(invalid_agent_config(format!(
                    "reasoning_effort {reasoning_effort} is not available for model {model}"
                )));
            }
        }
        if let Some(permission_mode) = agent_config.permission_mode
            && !snapshot.has_permission_mode(permission_mode)
        {
            return Err(invalid_agent_config(format!(
                "permission_mode is not available for backend {}",
                backend.kind
            )));
        }
    }
    if is_codex_family_backend(backend.kind) {
        validate_codex_feature_values(backend.kind, agent_config)?;
    }
    Ok(())
}

fn is_codex_family_backend(kind: &str) -> bool {
    matches!(kind, "codex" | "tcodex")
}

fn validate_codex_feature_values(
    backend_kind: &str,
    agent_config: &AgentConfig,
) -> Result<(), Response> {
    for (feature_id, value) in &agent_config.feature_values {
        match feature_id.as_str() {
            "fast_mode" => {
                let Some(enabled) = value.as_bool() else {
                    return Err(invalid_agent_config("fast_mode must be a boolean"));
                };
                if enabled
                    && !vela_backends::codex::capabilities::codex_model_supports_fast_mode(
                        agent_config.model.as_deref(),
                    )
                {
                    return Err(invalid_agent_config(
                        "fast_mode is not available for the selected Codex model",
                    ));
                }
            }
            _ => {
                return Err(invalid_agent_config(format!(
                    "feature {feature_id} is not available for backend {backend_kind}"
                )));
            }
        }
    }
    Ok(())
}

fn invalid_agent_config(message: impl Into<String>) -> Response {
    error(StatusCode::BAD_REQUEST, "invalid_agent_config", message)
}

fn command_ack_json(ack: &CommandAck, events: &[CanonicalEvent]) -> Value {
    let mut value = serde_json::to_value(ack).unwrap_or_else(|_| json!({ "status": "rejected", "code": "serialization_error", "message": "failed to serialize ack" }));
    if let Some(cursor) = ack_cursor(ack) {
        if let Some(event) = events
            .iter()
            .find(|event| event.epoch == cursor.epoch && event.seq == cursor.seq)
        {
            value["cursor"] = event_cursor_json(event);
        }
    }
    value
}

fn ack_cursor(ack: &CommandAck) -> Option<EventCursor> {
    match ack {
        CommandAck::Accepted(ack) => Some(ack.cursor.clone()),
        CommandAck::Queued(ack) => Some(ack.cursor.clone()),
        CommandAck::Rejected(ack) => ack.cursor.clone(),
    }
}

fn rejected_command_ack(
    code: impl Into<String>,
    message: impl Into<String>,
    command_id: Option<CommandId>,
    session_id: Option<SessionId>,
    cursor: Option<EventCursor>,
) -> CommandAck {
    CommandAck::Rejected(RejectedCommandAck {
        code: code.into(),
        message: message.into(),
        cursor,
        command_id,
        session_id,
    })
}

fn event_json(event: &CanonicalEvent) -> Value {
    json!({
        "event_id": event.event_id.as_str(),
        "epoch": event.epoch,
        "seq": event.seq,
        "session_id": event.session_id.as_str(),
        "thread_id": event.thread_id.as_str(),
        "type": event.event_type.0,
        "created_at": event.created_at.to_rfc3339(),
        "affected_views": event.affected_views,
        "source": event.source,
        "payload": event.payload,
        "raw": event.raw,
    })
}

struct EventPage {
    events: Vec<CanonicalEvent>,
    cursor: Value,
}

struct ValuePage {
    items: Vec<Value>,
    cursor: Value,
}

fn page_events(
    events: &[CanonicalEvent],
    after_id: Option<&str>,
    before_id: Option<&str>,
    limit: Option<usize>,
) -> EventPage {
    let mut start = 0;
    let mut end = events.len();
    if let Some(after_id) = after_id {
        if let Some(index) = events
            .iter()
            .position(|event| event.event_id.as_str() == after_id)
        {
            start = index + 1;
        }
    }
    if let Some(before_id) = before_id {
        if let Some(index) = events
            .iter()
            .position(|event| event.event_id.as_str() == before_id)
        {
            end = index;
        }
    }
    let requested_end = end;
    let limit = limit.unwrap_or(100).clamp(1, 500);
    end = end.min(start.saturating_add(limit));
    let page = events[start..end].to_vec();
    EventPage {
        cursor: cursor_window_json_with_flags(&page, start > 0, end < requested_end),
        events: page,
    }
}

fn cursor_is_stale(
    events: &[CanonicalEvent],
    after_id: Option<&str>,
    before_id: Option<&str>,
) -> bool {
    after_id
        .filter(|id| !id.is_empty())
        .map(|id| !events.iter().any(|event| event.event_id.as_str() == id))
        .unwrap_or(false)
        || before_id
            .filter(|id| !id.is_empty())
            .map(|id| !events.iter().any(|event| event.event_id.as_str() == id))
            .unwrap_or(false)
}

fn sync_reset_json(events: &[CanonicalEvent]) -> Value {
    json!({
        "reason": "stale_cursor",
        "views": ["session", "conversation", "requests", "diffs", "timeline", "workbench"],
        "latest_event_id": events.last().map(|event| event.event_id.as_str()).unwrap_or(""),
    })
}

fn page_values(
    values: Vec<Value>,
    after_id: Option<&str>,
    before_id: Option<&str>,
    limit: Option<usize>,
) -> ValuePage {
    let mut start = 0;
    let mut end = values.len();
    if let Some(after_id) = after_id {
        if let Some(index) = values
            .iter()
            .position(|value| value.get("id").and_then(Value::as_str) == Some(after_id))
        {
            start = index + 1;
        }
    }
    if let Some(before_id) = before_id {
        if let Some(index) = values
            .iter()
            .position(|value| value.get("id").and_then(Value::as_str) == Some(before_id))
        {
            end = index;
        }
    }
    let requested_end = end;
    let limit = limit.unwrap_or(100).clamp(1, 500);
    end = end.min(start.saturating_add(limit));
    let items = values[start..end].to_vec();
    ValuePage {
        items,
        cursor: json!({
            "epoch": 0,
            "has_older": start > 0,
            "has_newer": end < requested_end,
        }),
    }
}

fn diffs_from_events(events: &[CanonicalEvent]) -> Vec<Value> {
    events
        .iter()
        .filter(|event| event.event_type == EventType::DIFF_UPDATED)
        .map(|event| {
            json!({
                "file_path": event.payload.get("file_path").and_then(Value::as_str).unwrap_or(""),
                "status": event.payload.get("status").and_then(Value::as_str).unwrap_or("modified"),
                "additions": event.payload.get("additions").and_then(Value::as_i64).unwrap_or(0),
                "deletions": event.payload.get("deletions").and_then(Value::as_i64).unwrap_or(0),
            })
        })
        .collect()
}

fn requests_from_events(events: &[CanonicalEvent], status_filter: Option<&str>) -> Vec<Value> {
    let mut requests: Map<String, Value> = Map::new();
    for event in events {
        match event.event_type {
            EventType::REQUEST_OPENED | EventType::REQUEST_UPDATED => {
                let request_id = event
                    .payload
                    .get("request_id")
                    .and_then(Value::as_str)
                    .unwrap_or(event.event_id.as_str());
                let status = event
                    .payload
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("pending");
                requests.insert(
                    request_id.to_string(),
                    json!({
                        "id": request_id,
                        "session_id": event.session_id.as_str(),
                        "type": request_type_wire(event.payload.get("request_type").and_then(Value::as_str).unwrap_or("custom_input")),
                        "status": status,
                        "title": event.payload.get("title").and_then(Value::as_str).unwrap_or("Request"),
                        "description": event.payload.get("description").and_then(Value::as_str).unwrap_or(""),
                        "payload": event.payload,
                        "backend_ref": {},
                        "created_at": event.created_at.to_rfc3339(),
                    }),
                );
            }
            EventType::REQUEST_RESOLVED => {
                if let Some(request_id) = event.payload.get("request_id").and_then(Value::as_str) {
                    let status = event
                        .payload
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("answered");
                    let entry = requests.entry(request_id.to_string()).or_insert_with(|| {
                        json!({
                            "id": request_id,
                            "session_id": event.session_id.as_str(),
                            "type": "custom_input",
                            "status": status,
                            "title": "Request",
                            "description": "",
                            "payload": {},
                            "backend_ref": {},
                            "created_at": event.created_at.to_rfc3339(),
                        })
                    });
                    entry["status"] = json!(status);
                    entry["resolved_at"] = json!(event.created_at.to_rfc3339());
                }
            }
            _ => {}
        }
    }
    requests
        .into_values()
        .filter(|request| {
            status_filter
                .map(|status| request.get("status").and_then(Value::as_str) == Some(status))
                .unwrap_or(true)
        })
        .collect()
}

fn request_type_wire(value: &str) -> &str {
    match value {
        "permission" => "permission",
        "tool_confirmation" => "tool_confirmation",
        _ => "custom_input",
    }
}

fn trace_spans_from_events(events: &[CanonicalEvent]) -> Vec<Value> {
    let mut spans = Vec::new();
    for event in events {
        spans.push(json!({
            "id": event.event_id.as_str(),
            "kind": if event.raw.is_some() { "backend_raw" } else if event.event_type == EventType::WARNING_RAISED { "warning" } else if event.event_type == EventType::ERROR_RAISED { "error" } else { "command" },
            "created_at": event.created_at.to_rfc3339(),
            "event_id": event.event_id.as_str(),
            "title": event.event_type.0,
            "summary": payload_summary_text(&event.payload).unwrap_or(event.event_type.0),
            "data": { "payload": event.payload, "raw": event.raw },
        }));
        spans.push(json!({
            "id": format!("projection:{}", event.event_id.as_str()),
            "kind": "projection",
            "created_at": event.created_at.to_rfc3339(),
            "event_id": event.event_id.as_str(),
            "title": "projection",
            "summary": "projected canonical event into affected read models",
            "data": { "affected_views": event.affected_views },
        }));
    }
    spans
}

fn coalesced_timeline_items(events: &[CanonicalEvent]) -> Vec<Value> {
    let mut items: Vec<Value> = Vec::new();
    let mut assistant_index: Option<usize> = None;
    let mut keyed: Map<String, Value> = Map::new();

    for event in events {
        match event.event_type {
            EventType::USER_MESSAGE_ACCEPTED => items.push(timeline_message_item(event, "user")),
            EventType::ASSISTANT_MESSAGE_STARTED
            | EventType::ASSISTANT_MESSAGE_DELTA
            | EventType::ASSISTANT_MESSAGE_COMPLETED => {
                let text = event
                    .payload
                    .get("delta")
                    .or_else(|| event.payload.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if let Some(index) = assistant_index {
                    append_timeline_text(&mut items[index], text, event);
                } else {
                    let mut item = timeline_message_item(event, "assistant");
                    item["parts"][0]["text"] = json!(text);
                    assistant_index = Some(items.len());
                    items.push(item);
                }
            }
            EventType::REQUEST_OPENED
            | EventType::REQUEST_UPDATED
            | EventType::REQUEST_RESOLVED => {
                let key = format!(
                    "request:{}",
                    event
                        .payload
                        .get("request_id")
                        .and_then(Value::as_str)
                        .unwrap_or(event.event_id.as_str())
                );
                upsert_keyed_timeline(&mut keyed, key, event, "request");
            }
            EventType::DIFF_UPDATED => {
                let key = format!(
                    "diff:{}",
                    event
                        .payload
                        .get("file_path")
                        .and_then(Value::as_str)
                        .unwrap_or(event.event_id.as_str())
                );
                upsert_keyed_timeline(&mut keyed, key, event, "diff");
            }
            EventType::TOOL_STARTED
            | EventType::TOOL_UPDATED
            | EventType::TOOL_OUTPUT_DELTA
            | EventType::TOOL_COMPLETED
            | EventType::TOOL_FAILED => {
                let key = format!(
                    "tool:{}",
                    event
                        .payload
                        .get("tool_id")
                        .and_then(Value::as_str)
                        .unwrap_or(event.event_id.as_str())
                );
                upsert_keyed_timeline(&mut keyed, key, event, "tool");
            }
            EventType::TURN_FAILED
            | EventType::TURN_CANCELLED
            | EventType::WARNING_RAISED
            | EventType::ERROR_RAISED => {
                items.push(timeline_item_json(event));
            }
            _ => {}
        }
    }

    items.extend(keyed.into_values());
    items
}

fn timeline_message_item(event: &CanonicalEvent, role: &str) -> Value {
    let text = event
        .payload
        .get("content")
        .or_else(|| event.payload.get("delta"))
        .and_then(Value::as_str)
        .unwrap_or("");
    json!({
        "id": event.event_id.as_str(),
        "kind": "message",
        "role": role,
        "status": "completed",
        "parts": [{
            "id": event.event_id.as_str(),
            "type": "text",
            "text": text,
        }],
        "event_range": {
            "from_event_id": event.event_id.as_str(),
            "to_event_id": event.event_id.as_str(),
        }
    })
}

fn append_timeline_text(item: &mut Value, text: &str, event: &CanonicalEvent) {
    let existing = item["parts"][0]["text"].as_str().unwrap_or("").to_string();
    item["parts"][0]["text"] = json!(format!("{existing}{text}"));
    item["event_range"]["to_event_id"] = json!(event.event_id.as_str());
}

fn upsert_keyed_timeline(
    keyed: &mut Map<String, Value>,
    key: String,
    event: &CanonicalEvent,
    kind: &str,
) {
    keyed
        .entry(key)
        .and_modify(|item| {
            item["status"] = json!(timeline_status(event));
            item["event_range"]["to_event_id"] = json!(event.event_id.as_str());
            item["parts"][0]["text"] = json!(timeline_text(event));
        })
        .or_insert_with(|| {
            let mut item = timeline_item_json(event);
            item["kind"] = json!(kind);
            item
        });
}

fn timeline_status(event: &CanonicalEvent) -> &'static str {
    match event.event_type {
        EventType::REQUEST_OPENED | EventType::TOOL_STARTED => "pending",
        EventType::TOOL_FAILED | EventType::TURN_FAILED | EventType::ERROR_RAISED => "failed",
        EventType::TURN_CANCELLED => "cancelled",
        _ => "completed",
    }
}

fn timeline_text(event: &CanonicalEvent) -> &str {
    payload_summary_text(&event.payload).unwrap_or(event.event_type.0)
}

fn payload_summary_text(payload: &Value) -> Option<&str> {
    payload
        .get("content")
        .or_else(|| payload.get("delta"))
        .or_else(|| payload.get("title"))
        .or_else(|| payload.get("file_path"))
        .or_else(|| payload.get("message"))
        .or_else(|| payload.get("error"))
        .and_then(Value::as_str)
}

fn event_range_json(event_ids: &[EventId]) -> Value {
    json!({
        "from_event_id": event_ids.first().map(EventId::as_str).unwrap_or(""),
        "to_event_id": event_ids.last().map(EventId::as_str).unwrap_or(""),
    })
}

fn source_event_range_json(range: &SourceEventRange) -> Value {
    json!({
        "epoch": range.epoch,
        "from_event_id": range.from_event_id.as_str(),
        "to_event_id": range.to_event_id.as_str(),
        "from_seq": range.from_seq,
        "to_seq": range.to_seq,
    })
}

fn activity_status_wire(status: &str) -> &str {
    match status {
        "pending" => "pending",
        "running" => "running",
        "completed" | "resolved" | "updated" | "accepted" => "completed",
        "failed" => "failed",
        "cancelled" | "canceled" => "cancelled",
        _ => "running",
    }
}

fn activity_detail_json(kind: &str, payload: &Value) -> Option<Value> {
    if let Some(detail) = payload.get("detail").and_then(Value::as_object) {
        if let Some(detail_type) = detail.get("type").and_then(Value::as_str) {
            return Some(normalized_detail_json(
                detail_type,
                &Value::Object(detail.clone()),
            ));
        }
    }

    match kind {
        "tool" => Some(activity_tool_detail_json(payload)),
        _ => None,
    }
}

fn activity_tool_detail_json(payload: &Value) -> Value {
    match inferred_activity_tool_detail_type(payload) {
        "shell" => activity_shell_detail_json(payload),
        "read" | "edit" | "write" => {
            activity_file_detail_json(inferred_activity_tool_detail_type(payload), payload)
        }
        "search" => activity_search_detail_json(payload),
        "fetch" => activity_fetch_detail_json(payload),
        _ => activity_generic_tool_detail_json(payload),
    }
}

fn inferred_activity_tool_detail_type(payload: &Value) -> &'static str {
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();

    if payload.get("command").is_some() {
        return "shell";
    }
    if payload.get("query").is_some() {
        return "search";
    }
    if payload.get("url").is_some() {
        return "fetch";
    }
    if name.contains("edit") || name.contains("patch") || payload.get("unified_diff").is_some() {
        return "edit";
    }
    if name.contains("write") {
        return "write";
    }
    if name.contains("read") || name == "cat" || payload.get("file_path").is_some() {
        return "read";
    }

    "tool"
}

fn activity_shell_detail_json(payload: &Value) -> Value {
    normalized_detail_json("shell", payload)
}

fn activity_file_detail_json(detail_type: &str, payload: &Value) -> Value {
    let mut detail = normalized_detail_json(detail_type, payload);
    let Some(object) = detail.as_object_mut() else {
        return detail;
    };
    if let Some(path) = payload
        .get("file_path")
        .or_else(|| payload.get("path"))
        .and_then(detail_string_value)
    {
        object.insert("file_path".to_string(), Value::String(path));
    }
    detail
}

fn activity_search_detail_json(payload: &Value) -> Value {
    normalized_detail_json("search", payload)
}

fn activity_fetch_detail_json(payload: &Value) -> Value {
    normalized_detail_json("fetch", payload)
}

fn activity_generic_tool_detail_json(payload: &Value) -> Value {
    generic_detail_json("tool", payload)
}

fn normalized_detail_json(detail_type: &str, payload: &Value) -> Value {
    match detail_type {
        "shell" => typed_detail_json(
            "shell",
            payload,
            &["command", "cwd", "output", "stdout", "stderr", "error"],
            &["exit_code"],
            &[],
            &["streams"],
        ),
        "read" | "edit" | "write" => typed_detail_json(
            detail_type,
            payload,
            &[
                "file_path",
                "path",
                "content",
                "old_string",
                "new_string",
                "unified_diff",
            ],
            &[],
            &[],
            &[],
        ),
        "search" => typed_detail_json(
            "search",
            payload,
            &["query", "mode", "content"],
            &["num_files", "num_matches", "duration_ms"],
            &["truncated"],
            &[],
        ),
        "fetch" => typed_detail_json(
            "fetch",
            payload,
            &["url", "prompt", "result", "code_text"],
            &["code", "bytes", "duration_ms"],
            &[],
            &[],
        ),
        _ => generic_detail_json(detail_type, payload),
    }
}

fn typed_detail_json(
    detail_type: &str,
    payload: &Value,
    string_fields: &[&str],
    integer_fields: &[&str],
    boolean_fields: &[&str],
    passthrough_fields: &[&str],
) -> Value {
    let mut detail = Map::new();
    detail.insert("type".to_string(), Value::String(detail_type.to_string()));
    for field in string_fields {
        let Some(raw_value) = payload.get(field) else {
            continue;
        };
        if matches!(*field, "content" | "result") {
            insert_content_projection(&mut detail, field, raw_value);
        } else if let Some(value) = detail_string_value(raw_value) {
            detail.insert((*field).to_string(), Value::String(value));
        }
    }
    for field in integer_fields {
        if let Some(value) = payload.get(field).and_then(Value::as_i64) {
            detail.insert((*field).to_string(), json!(value));
        }
    }
    for field in boolean_fields {
        if let Some(value) = payload.get(field).and_then(Value::as_bool) {
            detail.insert((*field).to_string(), json!(value));
        }
    }
    for field in passthrough_fields {
        if let Some(value) = payload.get(field) {
            detail.insert((*field).to_string(), value.clone());
        }
    }
    Value::Object(detail)
}

fn generic_detail_json(detail_type: &str, payload: &Value) -> Value {
    let mut detail = Map::new();
    detail.insert(
        "type".to_string(),
        Value::String(generic_detail_type(detail_type).to_string()),
    );
    for field in [
        "tool_id",
        "call_id",
        "name",
        "label",
        "summary",
        "description",
        "text",
        "command",
        "cwd",
        "query",
        "file_path",
        "path",
        "url",
        "stdout",
        "stderr",
        "error",
        "delta",
        "status",
    ] {
        if let Some(value) = payload.get(field).and_then(detail_string_value) {
            detail.insert(field.to_string(), Value::String(value));
        }
    }
    for field in ["content", "output"] {
        if let Some(value) = payload.get(field) {
            insert_content_projection(&mut detail, field, value);
        }
    }
    if let Some(exit_code) = payload.get("exit_code").and_then(Value::as_i64) {
        detail.insert("exit_code".to_string(), json!(exit_code));
    }
    Value::Object(detail)
}

fn generic_detail_type(detail_type: &str) -> &str {
    match detail_type {
        "browser" | "mcp_tool" | "dynamic_tool" | "sub_agent" | "image_generation"
        | "image_view" | "plan" | "plain_text" | "unknown" | "tool" => detail_type,
        _ => "unknown",
    }
}

fn insert_content_projection(detail: &mut Map<String, Value>, field: &str, value: &Value) {
    if let Some(preview) = detail_content_preview(value) {
        detail.insert(field.to_string(), Value::String(preview));
    }
    if !detail.contains_key("content_parts") {
        let parts = detail_content_parts(value);
        if !parts.is_empty() {
            detail.insert("content_parts".to_string(), Value::Array(parts));
        }
    }
}

fn detail_content_preview(value: &Value) -> Option<String> {
    let parts = detail_content_parts(value);
    let preview = parts
        .iter()
        .filter_map(content_part_preview)
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if preview.trim().is_empty() {
        None
    } else {
        Some(truncate_preview(&preview, 500))
    }
}

fn content_part_preview(part: &Value) -> Option<String> {
    match part.get("type").and_then(Value::as_str) {
        Some("text") => part.get("text").and_then(Value::as_str).map(str::to_string),
        Some("json") => part.get("value").map(Value::to_string),
        Some("resource_link") => part
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| part.get("uri").and_then(Value::as_str))
            .map(str::to_string),
        _ => None,
    }
}

fn detail_content_parts(value: &Value) -> Vec<Value> {
    match value {
        Value::Null => Vec::new(),
        Value::String(value) => vec![json!({ "type": "text", "text": value })],
        Value::Bool(value) => vec![json!({ "type": "text", "text": value.to_string() })],
        Value::Number(value) => vec![json!({ "type": "text", "text": value.to_string() })],
        Value::Array(values) => values
            .iter()
            .flat_map(detail_content_parts)
            .collect::<Vec<_>>(),
        Value::Object(object) => {
            if let Some(part) = known_content_part(object) {
                return vec![part];
            }
            for field in ["content", "text", "output"] {
                if let Some(value) = object.get(field) {
                    let parts = detail_content_parts(value);
                    if !parts.is_empty() {
                        return parts;
                    }
                }
            }
            vec![json!({ "type": "json", "value": Value::Object(object.clone()) })]
        }
    }
}

fn known_content_part(object: &Map<String, Value>) -> Option<Value> {
    match object.get("type").and_then(Value::as_str) {
        Some("text") => object
            .get("text")
            .and_then(Value::as_str)
            .map(|text| json!({ "type": "text", "text": text })),
        Some("json") => object
            .get("value")
            .map(|value| json!({ "type": "json", "value": value })),
        Some("resource_link") => {
            let uri = object.get("uri").and_then(Value::as_str)?;
            let mut part = Map::new();
            part.insert(
                "type".to_string(),
                Value::String("resource_link".to_string()),
            );
            part.insert("uri".to_string(), Value::String(uri.to_string()));
            if let Some(name) = object.get("name").and_then(Value::as_str) {
                part.insert("name".to_string(), Value::String(name.to_string()));
            }
            if let Some(mime_type) = object.get("mime_type").and_then(Value::as_str) {
                part.insert(
                    "mime_type".to_string(),
                    Value::String(mime_type.to_string()),
                );
            }
            Some(Value::Object(part))
        }
        _ => None,
    }
}

fn detail_string_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
        Value::Array(_) | Value::Object(_) => None,
    }
}

fn publish_new_events<B>(state: &ApiState<B>, events: &[CanonicalEvent], before_len: usize) {
    for event in events.iter().skip(before_len) {
        let _ = state.events.send(event.clone());
    }
}

fn sse_live_response(
    backlog: Vec<CanonicalEvent>,
    rx: broadcast::Receiver<CanonicalEvent>,
    session_id: Option<SessionId>,
) -> Response {
    let initial = stream::iter(
        backlog
            .into_iter()
            .map(|event| Ok::<Bytes, Infallible>(Bytes::from(sse_event_text(&event)))),
    );
    let live = stream::unfold((rx, session_id), |(mut rx, session_id)| async move {
        loop {
            match rx.recv().await {
                Ok(event)
                    if session_id
                        .as_ref()
                        .map(|session_id| &event.session_id == session_id)
                        .unwrap_or(true) =>
                {
                    return Some((
                        Ok::<Bytes, Infallible>(Bytes::from(sse_event_text(&event))),
                        (rx, session_id),
                    ));
                }
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    return Some((
                        Ok::<Bytes, Infallible>(Bytes::from(
                            "event: sync.reset\ndata: {\"reason\":\"stale_cursor\",\"views\":[\"workbench\"],\"latest_event_id\":\"\"}\n\n",
                        )),
                        (rx, session_id),
                    ));
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    (
        [("content-type", "text/event-stream")],
        axum::body::Body::from_stream(initial.chain(live)),
    )
        .into_response()
}

fn sse_reset_response(
    events: &[CanonicalEvent],
    rx: broadcast::Receiver<CanonicalEvent>,
    session_id: Option<SessionId>,
) -> Response {
    let reset = format!("event: sync.reset\ndata: {}\n\n", sync_reset_json(events));
    let initial = stream::iter(vec![Ok::<Bytes, Infallible>(Bytes::from(reset))]);
    let live = stream::unfold((rx, session_id), |(mut rx, session_id)| async move {
        loop {
            match rx.recv().await {
                Ok(event)
                    if session_id
                        .as_ref()
                        .map(|session_id| &event.session_id == session_id)
                        .unwrap_or(true) =>
                {
                    return Some((
                        Ok::<Bytes, Infallible>(Bytes::from(sse_event_text(&event))),
                        (rx, session_id),
                    ));
                }
                Ok(_) => continue,
                Err(_) => return None,
            }
        }
    });
    (
        [("content-type", "text/event-stream")],
        axum::body::Body::from_stream(initial.chain(live)),
    )
        .into_response()
}

fn sse_event_text(event: &CanonicalEvent) -> String {
    format!(
        "id: {}\nevent: {}\ndata: {}\n\n",
        event.event_id.as_str(),
        event.event_type.0,
        event_json(event)
    )
}

fn event_cursor_json(event: &CanonicalEvent) -> Value {
    event_cursor_value(&event.cursor())
}

fn event_cursor_value(cursor: &EventCursor) -> Value {
    json!({
        "event_id": cursor.event_id.as_str(),
        "epoch": cursor.epoch,
        "seq": cursor.seq,
    })
}

fn empty_cursor_json() -> Value {
    json!({ "event_id": "", "epoch": 0, "seq": 0 })
}

fn cursor_window_json(events: &[CanonicalEvent]) -> Value {
    cursor_window_json_with_flags(events, false, false)
}

fn cursor_window_json_with_flags(
    events: &[CanonicalEvent],
    has_older: bool,
    has_newer: bool,
) -> Value {
    match (events.first(), events.last()) {
        (Some(first), Some(last)) => json!({
            "epoch": last.epoch,
            "from_seq": first.seq,
            "to_seq": last.seq,
            "next_event_id": last.event_id.as_str(),
            "has_older": has_older,
            "has_newer": has_newer,
        }),
        _ => json!({
            "epoch": 0,
            "has_older": has_older,
            "has_newer": has_newer,
        }),
    }
}

fn session_json(
    session_id: &SessionId,
    backend: &str,
    status: &str,
    working_directory: &str,
    title: Option<&str>,
    agent_config: &AgentConfig,
    metadata: Option<Value>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    pending_request_count: usize,
    last_event: Option<&CanonicalEvent>,
) -> Value {
    json!({
        "id": session_id.as_str(),
        "backend": backend,
        "status": status,
        "title": title.unwrap_or(session_id.as_str()),
        "updated_at": updated_at.to_rfc3339(),
        "working_directory": working_directory,
        "model": agent_config.model,
        "agent_config": agent_config,
        "created_at": created_at.to_rfc3339(),
        "metadata": metadata.unwrap_or_else(|| json!({})),
        "runtime_info": session_runtime_info_json(backend, agent_config),
        "activity": session_activity_json(status, pending_request_count),
        "operations": session_operations_json(status, pending_request_count),
        "last_event_id": last_event.map(|event| event.event_id.as_str()).unwrap_or(""),
    })
}

fn session_runtime_info_json(backend: &str, agent_config: &AgentConfig) -> Value {
    json!({
        "provider": backend,
        "native_session_id": Value::Null,
        "model": agent_config.model,
        "reasoning_effort": agent_config.reasoning_effort,
        "permission_mode": agent_config.permission_mode,
        "feature_values": agent_config.feature_values,
    })
}

fn session_activity_json(status: &str, pending_request_count: usize) -> Value {
    let phase = session_activity_phase(status);
    let attention = session_activity_attention(status, pending_request_count);
    json!({
        "phase": phase,
        "attention": attention,
        "pending_request_count": pending_request_count,
    })
}

fn session_activity_phase(status: &str) -> &str {
    match status {
        "starting" => "starting",
        "running" => "running",
        "canceling" => "canceling",
        _ => "idle",
    }
}

fn session_activity_attention(status: &str, pending_request_count: usize) -> &str {
    if status == "failed" {
        "error"
    } else if status == "waiting_for_input" || pending_request_count > 0 {
        "waiting_for_user"
    } else {
        "none"
    }
}

fn session_operations_json(status: &str, pending_request_count: usize) -> Value {
    let closed = status == "closed";
    let running = session_is_running(status);
    let waiting_for_user =
        session_activity_attention(status, pending_request_count) == "waiting_for_user";
    let has_pending_request = pending_request_count > 0;
    json!({
        "send_message": {
            "available": !closed,
            "reason": if closed {
                Value::String("session_closed".to_string())
            } else {
                Value::Null
            },
        },
        "cancel": {
            "available": running,
            "reason": if closed {
                Value::String("session_closed".to_string())
            } else if waiting_for_user {
                Value::String("waiting_for_user".to_string())
            } else if running {
                Value::Null
            } else {
                Value::String("no_running_turn".to_string())
            },
        },
        "update_agent_config": {
            "available": !closed,
            "effective_after": "next_turn",
            "reason": if closed { Value::String("session_closed".to_string()) } else { Value::Null },
        },
        "respond_to_request": {
            "available": !closed && has_pending_request,
            "reason": if closed {
                Value::String("session_closed".to_string())
            } else if has_pending_request {
                Value::Null
            } else {
                Value::String("no_pending_request".to_string())
            },
        },
        "rewind_conversation": {
            "available": false,
            "reason": "unsupported_by_backend",
        },
        "rewind_files": {
            "available": false,
            "reason": "unsupported_by_backend",
        },
    })
}

fn stored_session_json(
    session: &StoredSession,
    events: &[CanonicalEvent],
    last_event: Option<&CanonicalEvent>,
) -> Value {
    session_json(
        &session.session_id,
        session.backend.as_str(),
        &session.status,
        &session.working_directory,
        Some(&session.title),
        &session.agent_config,
        Some(session.metadata.clone()),
        session.created_at,
        session.updated_at,
        project_pending_requests(events).requests.len(),
        last_event,
    )
}

fn session_summary_json(session: &StoredSession) -> Value {
    json!({
        "id": session.session_id.as_str(),
        "backend": session.backend.as_str(),
        "status": session.status,
        "title": session.title,
        "agent_config": session.agent_config,
        "updated_at": session.updated_at.to_rfc3339(),
    })
}

fn session_list_item_json(session: &StoredSession, events: &[CanonicalEvent]) -> Value {
    let last_activity_at = events
        .last()
        .map(|event| event.created_at)
        .unwrap_or(session.updated_at);
    let pending_request_count = project_pending_requests(events).requests.len();
    json!({
        "id": session.session_id.as_str(),
        "backend": session.backend.as_str(),
        "status": session.status,
        "title": session.title,
        "agent_config": session.agent_config,
        "updated_at": session.updated_at.to_rfc3339(),
        "working_directory": session.working_directory,
        "created_at": session.created_at.to_rfc3339(),
        "last_activity_at": last_activity_at.to_rfc3339(),
        "preview": session_preview(events),
        "pending_request_count": pending_request_count,
        "activity": session_activity_json(&session.status, pending_request_count),
        "running": session_is_running(&session.status),
        "model": session.agent_config.model.as_ref().or(session.model.as_ref()),
    })
}

fn session_preview(events: &[CanonicalEvent]) -> String {
    let conversation = project_conversation(events);
    let preview = conversation
        .items
        .iter()
        .rev()
        .find_map(|item| match item.kind {
            ConversationItemKind::UserMessage | ConversationItemKind::AssistantMessage => item
                .text
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string),
            _ => None,
        })
        .unwrap_or_default();
    truncate_preview(&preview, 180)
}

fn truncate_preview(value: &str, max_chars: usize) -> String {
    let mut iter = value.chars();
    let preview = iter.by_ref().take(max_chars).collect::<String>();
    if iter.next().is_some() {
        format!("{preview}...")
    } else {
        preview
    }
}

fn session_is_running(status: &str) -> bool {
    matches!(status, "starting" | "running" | "canceling")
}

fn timeline_item_json(event: &CanonicalEvent) -> Value {
    let kind = match event.event_type {
        EventType::USER_MESSAGE_ACCEPTED
        | EventType::ASSISTANT_MESSAGE_STARTED
        | EventType::ASSISTANT_MESSAGE_DELTA
        | EventType::ASSISTANT_MESSAGE_COMPLETED => "message",
        EventType::TOOL_STARTED
        | EventType::TOOL_UPDATED
        | EventType::TOOL_OUTPUT_DELTA
        | EventType::TOOL_COMPLETED
        | EventType::TOOL_FAILED => "tool",
        EventType::REQUEST_OPENED | EventType::REQUEST_UPDATED | EventType::REQUEST_RESOLVED => {
            "request"
        }
        EventType::DIFF_UPDATED => "diff",
        EventType::TURN_FAILED | EventType::ERROR_RAISED => "error",
        EventType::WARNING_RAISED | EventType::TURN_CANCELLED => "warning",
        _ => "task",
    };
    json!({
        "id": event.event_id.as_str(),
        "kind": kind,
        "status": if event.event_type == EventType::TURN_FAILED || event.event_type == EventType::TOOL_FAILED { "failed" } else { "completed" },
        "parts": [{
            "id": event.event_id.as_str(),
            "type": "text",
            "text": timeline_text(event),
        }],
        "event_range": {
            "from_event_id": event.event_id.as_str(),
            "to_event_id": event.event_id.as_str(),
        }
    })
}

fn error(status: StatusCode, code: impl Into<String>, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({
            "error": {
                "code": code.into(),
                "message": message.into(),
            }
        })),
    )
        .into_response()
}

fn invalid_request(message: impl Into<String>) -> Response {
    error(StatusCode::BAD_REQUEST, "invalid_request", message)
}

fn invalid_parameter(name: &str, message: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "error": {
                "code": "invalid_parameter",
                "message": message.into(),
                "details": {
                    "parameter": name,
                },
            }
        })),
    )
        .into_response()
}
