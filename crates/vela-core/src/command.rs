use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendKind {
    Pi,
    VelaEngine,
    Codex,
    Tcodex,
    Claude,
    Acp,
}

impl BackendKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pi => "pi",
            Self::VelaEngine => "vela_engine",
            Self::Codex => "codex",
            Self::Tcodex => "tcodex",
            Self::Claude => "claude",
            Self::Acp => "acp",
        }
    }
}
