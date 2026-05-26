//! Turn-scoped runtime metadata.

use std::path::PathBuf;

use crate::behavior::BehaviorVersions;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnStatus {
    Queued,
    Running,
    Aborting,
    Completed,
    Failed,
    Cancelled,
    Blocked,
}

#[derive(Debug, Clone)]
pub struct TurnContext {
    pub turn_id: String,
    pub run_id: String,
    pub source: String,
    pub prompt: String,
    pub cwd: PathBuf,
    pub versions: BehaviorVersions,
}

#[derive(Debug, Clone)]
pub struct TurnState {
    pub context: TurnContext,
    pub status: TurnStatus,
}

impl TurnState {
    pub fn queued(context: TurnContext) -> Self {
        Self {
            context,
            status: TurnStatus::Queued,
        }
    }
}
