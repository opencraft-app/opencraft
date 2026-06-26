use chrono::{DateTime, Utc};
use serde::Serialize;

pub(crate) const BACKEND_USAGE_SCHEMA: &str = "velad.backend_usage.v1";

#[derive(Clone, Debug, Serialize)]
pub(crate) struct BackendUsageSnapshot {
    pub schema: &'static str,
    pub backend: String,
    pub backend_type: String,
    pub status: BackendUsageStatus,
    pub source: String,
    pub fetched_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<BackendUsageSummary>,
    pub limits: Vec<BackendUsageLimit>,
    pub usage_lines: Vec<BackendUsageLine>,
    pub profiles: Vec<BackendUsageProfile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BackendUsageStatus {
    Ok,
    NeedsAuth,
    Unsupported,
    Error,
}

impl BackendUsageStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::NeedsAuth => "needs_auth",
            Self::Unsupported => "unsupported",
            Self::Error => "error",
        }
    }

    pub(crate) fn is_error(self) -> bool {
        matches!(self, Self::Error)
    }
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct BackendUsageSummary {
    pub label: String,
    pub tone: BackendUsageTone,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BackendUsageTone {
    Ok,
    Warning,
    Critical,
    Neutral,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct BackendUsageLimit {
    pub kind: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_duration_mins: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct BackendUsageLine {
    pub label: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct BackendUsageProfile {
    pub profile_id: String,
    pub display_name: String,
    pub status: BackendUsageStatus,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<BackendUsageSummary>,
    pub limits: Vec<BackendUsageLimit>,
    pub usage_lines: Vec<BackendUsageLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl BackendUsageSnapshot {
    pub(crate) fn from_profile(
        backend: impl Into<String>,
        backend_type: impl Into<String>,
        fetched_at: DateTime<Utc>,
        profile: BackendUsageProfile,
        plan_name: Option<String>,
    ) -> Self {
        Self {
            schema: BACKEND_USAGE_SCHEMA,
            backend: backend.into(),
            backend_type: backend_type.into(),
            status: profile.status,
            source: profile.source.clone(),
            fetched_at,
            plan_name,
            summary: profile.summary.clone(),
            limits: profile.limits.clone(),
            usage_lines: profile.usage_lines.clone(),
            detail: profile.detail.clone(),
            profiles: vec![profile],
        }
    }
}

pub(crate) fn summary_from_limits(limits: &[BackendUsageLimit]) -> Option<BackendUsageSummary> {
    let remaining = limits.iter().find_map(|limit| limit.remaining_percent)?;
    let rounded = remaining.round().clamp(0.0, 100.0) as i64;
    Some(BackendUsageSummary {
        label: format!("剩余 {rounded}%"),
        tone: if remaining <= 10.0 {
            BackendUsageTone::Critical
        } else if remaining <= 25.0 {
            BackendUsageTone::Warning
        } else {
            BackendUsageTone::Ok
        },
    })
}
