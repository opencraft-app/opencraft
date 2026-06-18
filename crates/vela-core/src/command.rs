use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendKind {
    Pi,
    Codex,
    Claude,
}

impl BackendKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pi => "pi",
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
}
