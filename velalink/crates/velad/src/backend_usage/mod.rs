mod codex;
pub(crate) mod types;

use std::{collections::HashMap, path::PathBuf};

use vela_core::BackendKind;

use crate::ConfiguredBackend;

pub(crate) use types::BackendUsageSnapshot;

#[derive(Clone, Default)]
pub(crate) struct BackendUsageService {
    codex: codex::CodexUsageFetcher,
}

impl BackendUsageService {
    pub(crate) fn with_codex_context(
        env: HashMap<String, String>,
        home_dir: Option<PathBuf>,
    ) -> Self {
        Self {
            codex: codex::CodexUsageFetcher::new(
                env,
                home_dir,
                "https://chatgpt.com/backend-api/wham/usage".to_string(),
            ),
        }
    }

    pub(crate) fn supports(&self, backend: &ConfiguredBackend) -> bool {
        matches!(backend.engine_kind, BackendKind::Codex)
    }

    pub(crate) async fn fetch(&self, backend: &ConfiguredBackend) -> BackendUsageSnapshot {
        let backend_type = backend.engine_kind.as_str();
        match backend.engine_kind {
            BackendKind::Codex => self.codex.fetch(backend.kind, backend_type).await,
            _ => codex::unsupported_snapshot(backend.kind, backend_type),
        }
    }
}
