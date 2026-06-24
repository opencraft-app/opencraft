use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::BackendKind;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    ReadOnly,
    Auto,
    AutoReview,
    FullAccess,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default)]
    pub feature_values: BTreeMap<String, Value>,
}

impl AgentConfig {
    pub fn with_model(model: Option<&str>) -> Self {
        Self {
            model: model.map(str::to_string),
            ..Self::default()
        }
    }

    pub fn merge_patch(&self, patch: AgentConfigPatch) -> Self {
        let mut next = self.clone();
        if let Some(model) = patch.model {
            next.model = model;
        }
        if let Some(reasoning_effort) = patch.reasoning_effort {
            next.reasoning_effort = reasoning_effort;
        }
        if let Some(permission_mode) = patch.permission_mode {
            next.permission_mode = permission_mode;
        }
        if let Some(feature_values) = patch.feature_values {
            next.feature_values = feature_values;
        }
        next
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentConfigPatch {
    #[serde(default)]
    pub model: Option<Option<String>>,
    #[serde(default)]
    pub reasoning_effort: Option<Option<String>>,
    #[serde(default)]
    pub permission_mode: Option<Option<PermissionMode>>,
    #[serde(default)]
    pub feature_values: Option<BTreeMap<String, Value>>,
}

impl AgentConfigPatch {
    pub fn is_empty(&self) -> bool {
        self.model.is_none()
            && self.reasoning_effort.is_none()
            && self.permission_mode.is_none()
            && self.feature_values.is_none()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ResolvedAgentConfig {
    pub backend: BackendKind,
    #[serde(flatten)]
    pub config: AgentConfig,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReasoningEffortOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BackendModel {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub reasoning_efforts: Vec<ReasoningEffortOption>,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PermissionModeOption {
    pub id: PermissionMode,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BackendFeature {
    Toggle {
        id: String,
        label: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        default_value: bool,
        #[serde(default)]
        metadata: BTreeMap<String, Value>,
    },
    Select {
        id: String,
        label: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        default_value: Option<String>,
        options: Vec<ReasoningEffortOption>,
        #[serde(default)]
        metadata: BTreeMap<String, Value>,
    },
}
