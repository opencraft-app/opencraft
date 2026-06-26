use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::Utc;
use reqwest::StatusCode;
use serde_json::Value;

use super::types::{
    BACKEND_USAGE_SCHEMA, BackendUsageLimit, BackendUsageLine, BackendUsageProfile,
    BackendUsageSnapshot, BackendUsageStatus, BackendUsageSummary, BackendUsageTone,
    summary_from_limits,
};

const CODEX_USAGE_SOURCE: &str = "codex_wham_usage";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

#[derive(Clone)]
pub(crate) struct CodexUsageFetcher {
    client: reqwest::Client,
    env: HashMap<String, String>,
    home_dir: Option<PathBuf>,
    usage_url: String,
}

#[derive(Clone, Debug)]
enum CodexAuth {
    OAuth {
        access_token: String,
        account_id: Option<String>,
    },
    ApiKeyOnly,
}

impl Default for CodexUsageFetcher {
    fn default() -> Self {
        Self::new(
            std::env::vars().collect(),
            std::env::var_os("HOME").map(PathBuf::from),
            CODEX_USAGE_URL.to_string(),
        )
    }
}

impl CodexUsageFetcher {
    pub(crate) fn new(
        env: HashMap<String, String>,
        home_dir: Option<PathBuf>,
        usage_url: String,
    ) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            client,
            env,
            home_dir,
            usage_url,
        }
    }

    pub(crate) async fn fetch(&self, backend: &str, backend_type: &str) -> BackendUsageSnapshot {
        let fetched_at = Utc::now();
        let profile = match self.resolve_auth() {
            None => status_profile(
                BackendUsageStatus::NeedsAuth,
                "需要登录 Codex",
                "Sign in with Codex ChatGPT OAuth to show usage.",
            ),
            Some(CodexAuth::ApiKeyOnly) => status_profile(
                BackendUsageStatus::Unsupported,
                "API Key 无用量接口",
                "Codex API-key auth has no usage endpoint.",
            ),
            Some(CodexAuth::OAuth {
                access_token,
                account_id,
            }) => {
                let response = self
                    .client
                    .get(&self.usage_url)
                    .bearer_auth(access_token)
                    .header("Accept", "application/json")
                    .header("User-Agent", "VelaLink")
                    .headers(match account_id {
                        Some(account_id) => {
                            let mut headers = reqwest::header::HeaderMap::new();
                            if let Ok(value) = reqwest::header::HeaderValue::from_str(&account_id) {
                                headers.insert("ChatGPT-Account-Id", value);
                            }
                            headers
                        }
                        None => reqwest::header::HeaderMap::new(),
                    })
                    .send()
                    .await;
                match response {
                    Ok(response) if is_auth_failure(response.status()) => status_profile(
                        BackendUsageStatus::NeedsAuth,
                        "需要重新登录 Codex",
                        "Codex usage auth was rejected.",
                    ),
                    Ok(response) if !response.status().is_success() => status_profile(
                        BackendUsageStatus::Error,
                        "用量获取失败",
                        &format!(
                            "Codex usage request failed with HTTP {}.",
                            response.status()
                        ),
                    ),
                    Ok(response) => {
                        let headers = response.headers().clone();
                        match response.json::<Value>().await {
                            Ok(json) => parse_codex_usage(&json, &headers),
                            Err(_) => status_profile(
                                BackendUsageStatus::Error,
                                "用量解析失败",
                                "Codex usage response was not valid JSON.",
                            ),
                        }
                    }
                    Err(_) => status_profile(
                        BackendUsageStatus::Error,
                        "无法连接用量接口",
                        "Could not reach the Codex usage endpoint.",
                    ),
                }
            }
        };
        let plan_name = profile
            .usage_lines
            .iter()
            .find(|line| line.label == "Plan")
            .map(|line| line.value.clone());
        BackendUsageSnapshot::from_profile(
            backend.to_string(),
            backend_type.to_string(),
            fetched_at,
            profile,
            plan_name,
        )
    }

    fn resolve_auth(&self) -> Option<CodexAuth> {
        let mut saw_api_key_only = false;
        for path in self.auth_file_paths() {
            match read_auth_file(&path) {
                Some(CodexAuth::OAuth { .. }) => return read_auth_file(&path),
                Some(CodexAuth::ApiKeyOnly) => saw_api_key_only = true,
                None => {}
            }
        }
        saw_api_key_only.then_some(CodexAuth::ApiKeyOnly)
    }

    fn auth_file_paths(&self) -> Vec<PathBuf> {
        let mut paths = Vec::new();
        if let Some(codex_home) = self.env.get("CODEX_HOME").filter(|value| !value.is_empty()) {
            paths.push(PathBuf::from(codex_home).join("auth.json"));
        }
        if let Some(home_dir) = &self.home_dir {
            paths.push(home_dir.join(".config").join("codex").join("auth.json"));
            paths.push(home_dir.join(".codex").join("auth.json"));
        }
        paths
    }
}

fn read_auth_file(path: &Path) -> Option<CodexAuth> {
    let value = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&value).ok()?;
    read_auth_record(&value)
}

fn read_auth_record(value: &Value) -> Option<CodexAuth> {
    if let Some(tokens) = value.get("tokens") {
        if let Some(access_token) = tokens.get("access_token").and_then(Value::as_str) {
            if !access_token.is_empty() {
                return Some(CodexAuth::OAuth {
                    access_token: access_token.to_string(),
                    account_id: tokens
                        .get("account_id")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string),
                });
            }
        }
    }
    if value
        .get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
    {
        return Some(CodexAuth::ApiKeyOnly);
    }
    None
}

fn is_auth_failure(status: StatusCode) -> bool {
    matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
}

fn parse_codex_usage(json: &Value, headers: &reqwest::header::HeaderMap) -> BackendUsageProfile {
    let rate_limit = json.get("rate_limit").unwrap_or(&Value::Null);
    let mut limits = Vec::new();
    push_window(
        &mut limits,
        "primary",
        "5h",
        rate_limit.get("primary_window"),
        header_percent(headers, "x-codex-primary-used-percent"),
        300,
    );
    push_window(
        &mut limits,
        "secondary",
        "Weekly",
        rate_limit.get("secondary_window"),
        header_percent(headers, "x-codex-secondary-used-percent"),
        10_080,
    );

    let mut usage_lines = Vec::new();
    if let Some(plan_type) = json.get("plan_type").and_then(Value::as_str) {
        usage_lines.push(BackendUsageLine {
            label: "Plan".to_string(),
            value: title_case(plan_type),
            subtitle: None,
        });
    }
    let credits = json.get("credits").unwrap_or(&Value::Null);
    let balance = header_number(headers, "x-codex-credits-balance")
        .or_else(|| credits.get("balance").and_then(Value::as_f64));
    if let Some(balance) = balance {
        let has_credits = credits
            .get("has_credits")
            .and_then(Value::as_bool)
            .unwrap_or(balance > 0.0);
        if has_credits || balance > 0.0 {
            usage_lines.push(BackendUsageLine {
                label: "Credits".to_string(),
                value: format!("${balance:.2}"),
                subtitle: Some("remaining".to_string()),
            });
        }
    }

    BackendUsageProfile {
        profile_id: "default".to_string(),
        display_name: "Codex".to_string(),
        status: BackendUsageStatus::Ok,
        source: CODEX_USAGE_SOURCE.to_string(),
        summary: summary_from_limits(&limits).or_else(|| {
            Some(BackendUsageSummary {
                label: "用量可用".to_string(),
                tone: BackendUsageTone::Ok,
            })
        }),
        limits,
        usage_lines,
        detail: None,
    }
}

fn push_window(
    limits: &mut Vec<BackendUsageLimit>,
    kind: &str,
    label: &str,
    window: Option<&Value>,
    header_used_percent: Option<f64>,
    fallback_duration_mins: i64,
) {
    let used_percent = header_used_percent
        .or_else(|| {
            window
                .and_then(|value| value.get("used_percent"))
                .and_then(Value::as_f64)
        })
        .map(clamp_percent);
    let resets_at = window.and_then(reset_from_window);
    let window_duration_mins = window
        .and_then(|value| value.get("limit_window_seconds"))
        .and_then(Value::as_i64)
        .map(|seconds| (seconds as f64 / 60.0).round() as i64)
        .or(Some(fallback_duration_mins));
    if used_percent.is_none() && resets_at.is_none() {
        return;
    }
    limits.push(BackendUsageLimit {
        kind: kind.to_string(),
        label: label.to_string(),
        used_percent,
        remaining_percent: used_percent.map(|value| clamp_percent(100.0 - value)),
        resets_at,
        window_duration_mins,
    });
}

fn reset_from_window(window: &Value) -> Option<String> {
    if let Some(reset_at) = window.get("reset_at").and_then(Value::as_i64) {
        return chrono::DateTime::from_timestamp(reset_at, 0).map(|date| date.to_rfc3339());
    }
    let after = window
        .get("reset_after_seconds")
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0)?;
    Some((Utc::now() + chrono::Duration::milliseconds((after * 1000.0) as i64)).to_rfc3339())
}

fn header_percent(headers: &reqwest::header::HeaderMap, name: &str) -> Option<f64> {
    header_number(headers, name).map(clamp_percent)
}

fn header_number(headers: &reqwest::header::HeaderMap, name: &str) -> Option<f64> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<f64>().ok())
}

fn clamp_percent(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

fn title_case(value: &str) -> String {
    value
        .split(['_', '-', ' '])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn status_profile(status: BackendUsageStatus, label: &str, detail: &str) -> BackendUsageProfile {
    BackendUsageProfile {
        profile_id: "default".to_string(),
        display_name: "Codex".to_string(),
        status,
        source: CODEX_USAGE_SOURCE.to_string(),
        summary: Some(BackendUsageSummary {
            label: label.to_string(),
            tone: match status {
                BackendUsageStatus::NeedsAuth | BackendUsageStatus::Unsupported => {
                    BackendUsageTone::Neutral
                }
                BackendUsageStatus::Error => BackendUsageTone::Warning,
                BackendUsageStatus::Ok => BackendUsageTone::Ok,
            },
        }),
        limits: Vec::new(),
        usage_lines: Vec::new(),
        detail: Some(detail.to_string()),
    }
}

pub(crate) fn unsupported_snapshot(backend: &str, backend_type: &str) -> BackendUsageSnapshot {
    let profile = BackendUsageProfile {
        profile_id: "default".to_string(),
        display_name: backend.to_string(),
        status: BackendUsageStatus::Unsupported,
        source: "unsupported".to_string(),
        summary: Some(BackendUsageSummary {
            label: "暂无用量".to_string(),
            tone: BackendUsageTone::Neutral,
        }),
        limits: Vec::new(),
        usage_lines: Vec::new(),
        detail: Some("usage is not supported for this backend type".to_string()),
    };
    BackendUsageSnapshot {
        schema: BACKEND_USAGE_SCHEMA,
        backend: backend.to_string(),
        backend_type: backend_type.to_string(),
        status: BackendUsageStatus::Unsupported,
        source: "unsupported".to_string(),
        fetched_at: Utc::now(),
        plan_name: None,
        summary: profile.summary.clone(),
        limits: Vec::new(),
        usage_lines: Vec::new(),
        profiles: vec![profile],
        detail: Some("usage is not supported for this backend type".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_wham_usage_headers_and_windows() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-codex-primary-used-percent", "42".parse().unwrap());
        headers.insert("x-codex-secondary-used-percent", "18".parse().unwrap());
        headers.insert("x-codex-credits-balance", "12.5".parse().unwrap());
        let profile = parse_codex_usage(
            &serde_json::json!({
                "plan_type": "plus",
                "rate_limit": {
                    "primary_window": { "reset_after_seconds": 60, "limit_window_seconds": 18000 },
                    "secondary_window": { "used_percent": 20 }
                },
                "credits": { "has_credits": true }
            }),
            &headers,
        );
        assert!(matches!(profile.status, BackendUsageStatus::Ok));
        assert_eq!(profile.summary.as_ref().unwrap().label, "剩余 58%");
        assert_eq!(profile.limits[0].label, "5h");
        assert_eq!(profile.limits[0].used_percent, Some(42.0));
        assert_eq!(profile.usage_lines[0].value, "Plus");
        assert_eq!(profile.usage_lines[1].value, "$12.50");
    }

    #[test]
    fn detects_api_key_only_auth() {
        let auth = read_auth_record(&serde_json::json!({ "OPENAI_API_KEY": "sk-test" }));
        assert!(matches!(auth, Some(CodexAuth::ApiKeyOnly)));
    }
}
