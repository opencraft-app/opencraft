use super::{
    events::CodexRawNotification,
    normalize_codex_app_server_notification,
    trace::{CodexTraceRecord, codex_control_plane_trace},
};
use crate::BackendOutput;
use serde::Deserialize;
use std::{fs, path::Path};

#[derive(Debug, Deserialize)]
pub struct CodexAppServerFixture {
    pub notifications: Vec<CodexRawNotification>,
    pub expect_event_types: Vec<String>,
}

#[derive(Debug)]
pub struct CodexAppServerFixtureReplay {
    pub outputs: Vec<BackendOutput>,
    pub trace: Vec<CodexTraceRecord>,
}

pub fn load_codex_app_server_fixture(name: &str) -> anyhow::Result<CodexAppServerFixture> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("codex_app_server")
        .join(name);
    let text = fs::read_to_string(&path)?;
    serde_json::from_str(&text).map_err(Into::into)
}

pub fn replay_codex_app_server_fixture(fixture: &CodexAppServerFixture) -> Vec<BackendOutput> {
    replay_codex_app_server_fixture_with_trace(fixture).outputs
}

pub fn replay_codex_app_server_fixture_with_trace(
    fixture: &CodexAppServerFixture,
) -> CodexAppServerFixtureReplay {
    let mut trace = Vec::new();
    let outputs = fixture
        .notifications
        .iter()
        .flat_map(|notification| {
            if let Some(record) =
                codex_control_plane_trace(&notification.method, notification.params.clone())
            {
                trace.push(record);
            }
            normalize_codex_app_server_notification(
                &notification.method,
                notification.params.clone(),
            )
        })
        .collect();

    CodexAppServerFixtureReplay { outputs, trace }
}
