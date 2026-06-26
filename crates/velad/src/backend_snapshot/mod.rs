use chrono::Utc;
use serde::Serialize;
use serde_json::{Value, json};
use vela_backends::BackendAdapter;
use vela_core::{
    BackendFeature, BackendModel, PermissionMode, PermissionModeOption, ReasoningEffortOption,
};

use super::{ApiState, ConfiguredBackend};

const SNAPSHOT_PROTOCOL: &str = "velad.backend_snapshot.v1";

#[derive(Clone, Debug)]
pub(crate) struct BackendSnapshot {
    pub kind: &'static str,
    pub backend_type: &'static str,
    pub display_name: &'static str,
    pub status: BackendSnapshotStatus,
    pub status_message: Option<String>,
    pub location: BackendSnapshotLocation,
    pub capabilities: BackendSnapshotCapabilities,
    pub models: Vec<BackendModel>,
    pub permission_modes: Vec<PermissionModeOption>,
    pub features: Vec<BackendFeature>,
    pub diagnostics: Value,
    pub fetched_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackendSnapshotStatus {
    Available,
    Degraded,
    Error,
}

impl BackendSnapshotStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Degraded => "degraded",
            Self::Error => "error",
        }
    }

    pub(crate) fn accepts_session_creation(self) -> bool {
        matches!(self, Self::Available | Self::Degraded)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ModelSource {
    Discovered,
    Configured,
    None,
}

impl ModelSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Discovered => "discovered",
            Self::Configured => "configured",
            Self::None => "none",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct BackendSnapshotCapabilities {
    pub streaming: bool,
    pub cancel: bool,
    pub permission_requests: bool,
    pub structured_diff: bool,
    pub session_agent_config: bool,
    pub usage_snapshot: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct BackendSnapshotLocation {
    pub kind: &'static str,
    pub label: &'static str,
}

impl BackendSnapshot {
    pub(crate) fn default_model(&self) -> Option<String> {
        self.models
            .iter()
            .find(|model| model.is_default)
            .or_else(|| self.models.first())
            .map(|model| model.id.clone())
    }

    pub(crate) fn default_reasoning_for_model(&self, model: &str) -> Option<String> {
        let model = self.models.iter().find(|candidate| candidate.id == model)?;
        model
            .reasoning_efforts
            .iter()
            .find(|option| option.is_default)
            .or_else(|| model.reasoning_efforts.first())
            .map(|option| option.id.clone())
    }

    pub(crate) fn reasoning_options_for_model(&self, model: &str) -> Vec<ReasoningEffortOption> {
        self.models
            .iter()
            .find(|candidate| candidate.id == model)
            .map(|model| model.reasoning_efforts.clone())
            .unwrap_or_default()
    }

    pub(crate) fn has_model(&self, model: &str) -> bool {
        self.models.iter().any(|candidate| candidate.id == model)
    }

    pub(crate) fn has_permission_mode(&self, permission_mode: PermissionMode) -> bool {
        self.permission_modes
            .iter()
            .any(|mode| mode.id == permission_mode)
    }

    pub(crate) fn to_wire_json(&self) -> Value {
        let mut payload = json!({
            "kind": self.kind,
            "backend_type": self.backend_type,
            "status": self.status.as_str(),
            "display_name": self.display_name,
            "location": {
                "kind": self.location.kind,
                "label": self.location.label,
            },
            "capabilities": {
                "streaming": self.capabilities.streaming,
                "cancel": self.capabilities.cancel,
                "permission_requests": self.capabilities.permission_requests,
                "structured_diff": self.capabilities.structured_diff,
                "session_agent_config": self.capabilities.session_agent_config,
                "usage_snapshot": self.capabilities.usage_snapshot,
            },
            "models": self.models,
            "permission_modes": self.permission_modes,
            "features": self.features,
            "diagnostics": self.diagnostics,
            "snapshot_protocol": SNAPSHOT_PROTOCOL,
            "fetched_at": self.fetched_at,
        });
        if let Some(status_message) = &self.status_message {
            payload["status_message"] = json!(status_message);
        }
        payload
    }
}

pub(crate) async fn catalog_json<B>(state: &ApiState<B>) -> Vec<Value>
where
    B: BackendAdapter + 'static,
{
    let mut backends = Vec::new();
    for backend in &state.configured_backends {
        backends.push(snapshot(state, backend).await.to_wire_json());
    }
    backends
}

pub(crate) async fn snapshot_for_kind<B>(
    state: &ApiState<B>,
    backend: &str,
) -> Option<BackendSnapshot>
where
    B: BackendAdapter + 'static,
{
    let configured = state
        .configured_backends
        .iter()
        .find(|item| item.kind == backend)?;
    Some(snapshot(state, configured).await)
}

pub(crate) async fn snapshot<B>(state: &ApiState<B>, backend: &ConfiguredBackend) -> BackendSnapshot
where
    B: BackendAdapter + 'static,
{
    let fetched_at = Utc::now().to_rfc3339();
    let capabilities = state
        .runtime
        .backend_capabilities_for(Some(backend.engine_kind));
    let capabilities = BackendSnapshotCapabilities {
        streaming: capabilities.streaming,
        cancel: capabilities.cancel,
        permission_requests: capabilities.permission_requests,
        structured_diff: capabilities.structured_diff,
        session_agent_config: capabilities.session_agent_config,
        usage_snapshot: state.backend_usage.supports(backend),
    };
    let discovery = discover_models(state, backend).await;
    let mut diagnostics = json!({
        "snapshot_protocol": SNAPSHOT_PROTOCOL,
        "backend_family": backend_family(backend.kind),
        "model_source": discovery.model_source.as_str(),
        "fetched_at": fetched_at,
        "model_count": discovery.models.len(),
    });
    if let Some(error) = &discovery.error {
        diagnostics["error"] = error.clone();
    }
    if discovery.configured_default_missing {
        diagnostics["configured_default_missing"] = json!(backend.default_model);
    }

    BackendSnapshot {
        kind: backend.kind,
        backend_type: backend.engine_kind.as_str(),
        display_name: backend.display_name,
        status: discovery.status,
        status_message: discovery.status_message,
        capabilities,
        location: BackendSnapshotLocation {
            kind: "local",
            label: "Local",
        },
        models: discovery.models,
        permission_modes: permission_modes(backend.kind),
        features: features(backend.kind),
        diagnostics,
        fetched_at,
    }
}

struct ModelDiscovery {
    models: Vec<BackendModel>,
    model_source: ModelSource,
    status: BackendSnapshotStatus,
    status_message: Option<String>,
    error: Option<Value>,
    configured_default_missing: bool,
}

async fn discover_models<B>(state: &ApiState<B>, backend: &ConfiguredBackend) -> ModelDiscovery
where
    B: BackendAdapter + 'static,
{
    let model_result = state
        .runtime
        .list_backend_models(Some(backend.engine_kind))
        .await;
    match model_result {
        Ok(models) if !models.is_empty() => discovered_models(backend, models),
        Ok(_) if backend.kind == "vela_engine" => {
            model_unconfigured("Vela Engine endpoint, key, and model are not configured")
        }
        Ok(_) if is_codex_family_kind(backend.kind) => model_error(
            "no_models_discovered",
            "model_discovery",
            format!("no models discovered for backend {}", backend.kind),
        ),
        Ok(_) => configured_or_empty_models(backend, None),
        Err(error) if backend.kind == "vela_engine" => {
            model_unconfigured(format!("Vela Engine model discovery failed: {error}"))
        }
        Err(error) if is_codex_family_kind(backend.kind) => model_error(
            "model_discovery_failed",
            "model_discovery",
            format!("model discovery failed: {error}"),
        ),
        Err(error) => {
            configured_or_empty_models(backend, Some(format!("model discovery failed: {error}")))
        }
    }
}

fn model_unconfigured(message: impl Into<String>) -> ModelDiscovery {
    let message = message.into();
    ModelDiscovery {
        models: Vec::new(),
        model_source: ModelSource::None,
        status: BackendSnapshotStatus::Degraded,
        status_message: Some(message.clone()),
        error: Some(json!({
            "code": "backend_unconfigured",
            "stage": "backend_settings",
            "message": message,
        })),
        configured_default_missing: false,
    }
}

fn discovered_models(backend: &ConfiguredBackend, mut models: Vec<BackendModel>) -> ModelDiscovery {
    let configured_default_missing = apply_configured_default(backend, &mut models);
    let status = if configured_default_missing {
        BackendSnapshotStatus::Degraded
    } else {
        BackendSnapshotStatus::Available
    };
    let status_message = configured_default_missing.then(|| {
        format!(
            "configured default model {} was not discovered for backend {}",
            backend.default_model.as_deref().unwrap_or_default(),
            backend.kind
        )
    });
    ModelDiscovery {
        models,
        model_source: ModelSource::Discovered,
        status,
        status_message,
        error: None,
        configured_default_missing,
    }
}

fn configured_or_empty_models(
    backend: &ConfiguredBackend,
    discovery_warning: Option<String>,
) -> ModelDiscovery {
    let models = backend
        .default_model
        .as_deref()
        .map(|model| {
            vec![BackendModel {
                id: model.to_string(),
                label: model.to_string(),
                description: None,
                is_default: true,
                reasoning_efforts: if backend.kind == "acp" {
                    Vec::new()
                } else {
                    common_reasoning_effort_options()
                },
                metadata: Default::default(),
            }]
        })
        .unwrap_or_default();
    let model_source = if models.is_empty() {
        ModelSource::None
    } else {
        ModelSource::Configured
    };
    let status = if discovery_warning.is_some() && !models.is_empty() {
        BackendSnapshotStatus::Degraded
    } else {
        BackendSnapshotStatus::Available
    };
    let error = discovery_warning.as_ref().map(|message| {
        json!({
            "code": "model_discovery_failed",
            "stage": "model_discovery",
            "message": message,
        })
    });
    ModelDiscovery {
        models,
        model_source,
        status,
        status_message: discovery_warning,
        error,
        configured_default_missing: false,
    }
}

fn model_error(
    code: &'static str,
    stage: &'static str,
    message: impl Into<String>,
) -> ModelDiscovery {
    let message = message.into();
    ModelDiscovery {
        models: Vec::new(),
        model_source: ModelSource::None,
        status: BackendSnapshotStatus::Error,
        status_message: Some(message.clone()),
        error: Some(json!({
            "code": code,
            "stage": stage,
            "message": message,
        })),
        configured_default_missing: false,
    }
}

fn apply_configured_default(backend: &ConfiguredBackend, models: &mut [BackendModel]) -> bool {
    let Some(default_model) = backend.default_model.as_deref() else {
        return false;
    };
    let found = models.iter().any(|model| model.id == default_model);
    if found {
        for model in models {
            model.is_default = model.id == default_model;
        }
    }
    !found
}

pub(crate) fn permission_modes(kind: &str) -> Vec<PermissionModeOption> {
    let mut modes = if is_codex_family_kind(kind) || kind == "vela_engine" {
        vec![
            PermissionModeOption {
                id: PermissionMode::ReadOnly,
                label: "Read only".to_string(),
                description: Some("Inspect files and ask before writes or commands.".to_string()),
                is_default: false,
                metadata: Default::default(),
            },
            PermissionModeOption {
                id: PermissionMode::Auto,
                label: "Default permissions".to_string(),
                description: Some("Workspace-write with Codex's normal approval flow.".to_string()),
                is_default: true,
                metadata: Default::default(),
            },
            PermissionModeOption {
                id: PermissionMode::AutoReview,
                label: "Auto-review".to_string(),
                description: Some(
                    "Workspace-write with eligible approvals routed through auto-review."
                        .to_string(),
                ),
                is_default: false,
                metadata: Default::default(),
            },
            PermissionModeOption {
                id: PermissionMode::FullAccess,
                label: "Full access".to_string(),
                description: Some(
                    "Allow local full access without additional prompts.".to_string(),
                ),
                is_default: false,
                metadata: Default::default(),
            },
        ]
    } else {
        vec![
            PermissionModeOption {
                id: PermissionMode::Auto,
                label: "Auto".to_string(),
                description: Some("Default local coding permission flow.".to_string()),
                is_default: true,
                metadata: Default::default(),
            },
            PermissionModeOption {
                id: PermissionMode::FullAccess,
                label: "Full access".to_string(),
                description: Some(
                    "Allow elevated local access when the backend supports it.".to_string(),
                ),
                is_default: false,
                metadata: Default::default(),
            },
        ]
    };
    if !modes.iter().any(|mode| mode.is_default)
        && let Some(first) = modes.first_mut()
    {
        first.is_default = true;
    }
    modes
}

pub(crate) fn features(kind: &str) -> Vec<BackendFeature> {
    let mut features = vec![BackendFeature::Toggle {
        id: "fast_mode".to_string(),
        label: "Fast".to_string(),
        description: Some("Lower latency when supported by the backend.".to_string()),
        default_value: false,
        metadata: Default::default(),
    }];
    if !is_codex_family_kind(kind) && kind != "vela_engine" {
        features.push(BackendFeature::Toggle {
            id: "plan_mode".to_string(),
            label: "Plan".to_string(),
            description: Some(
                "Plan before implementation when supported by the backend.".to_string(),
            ),
            default_value: false,
            metadata: Default::default(),
        });
    }
    features
}

fn is_codex_family_kind(kind: &str) -> bool {
    matches!(kind, "codex" | "tcodex")
}

fn backend_family(kind: &str) -> String {
    if is_codex_family_kind(kind) {
        "codex_app_server".to_string()
    } else {
        kind.to_string()
    }
}

fn common_reasoning_effort_options() -> Vec<ReasoningEffortOption> {
    [
        ("off", "Off"),
        ("minimal", "Minimal"),
        ("low", "Low"),
        ("medium", "Medium"),
        ("high", "High"),
        ("xhigh", "XHigh"),
    ]
    .into_iter()
    .map(|(id, label)| ReasoningEffortOption {
        id: id.to_string(),
        label: label.to_string(),
        description: None,
        is_default: id == "medium",
        metadata: Default::default(),
    })
    .collect()
}
