//! Session truth adapter for the runtime kernel.
//!
//! This v1 layer is still in-memory, but it models the runtime-owned transcript
//! shape directly: entries are linear today and keep parent ids so branch/fork
//! support does not require changing the entry contract later.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::turn::TurnState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptRole {
    User,
    Assistant,
    System,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TranscriptBlock {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
    },
    ToolCall {
        tool_call_id: String,
        name: String,
        arguments: String,
    },
    ToolResult {
        tool_call_id: String,
        name: String,
        success: bool,
        content: String,
    },
    ResetMarker {
        reason: String,
    },
    Blocked {
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptEntry {
    pub entry_id: String,
    pub parent_id: Option<String>,
    pub turn_id: String,
    pub run_id: String,
    pub role: TranscriptRole,
    pub blocks: Vec<TranscriptBlock>,
    pub created_at_ms: u128,
}

#[derive(Debug, Clone)]
pub struct AgentSession {
    pub session_id: String,
    pub cwd: PathBuf,
    pub active_turn: Option<TurnState>,
    pub last_turn: Option<TurnState>,
    pub transcript: Vec<TranscriptEntry>,
    leaf_entry_id: Option<String>,
}

impl AgentSession {
    pub fn new(session_id: impl Into<String>, cwd: impl Into<PathBuf>) -> Self {
        Self {
            session_id: session_id.into(),
            cwd: cwd.into(),
            active_turn: None,
            last_turn: None,
            transcript: Vec::new(),
            leaf_entry_id: None,
        }
    }

    pub fn begin_turn(&mut self, turn: TurnState) {
        self.append_transcript_entry(
            turn.context.turn_id.clone(),
            turn.context.run_id.clone(),
            TranscriptRole::User,
            vec![TranscriptBlock::Text {
                text: turn.context.prompt.clone(),
            }],
        );
        self.active_turn = Some(turn);
    }

    pub fn finish_turn(&mut self, status: crate::turn::TurnStatus) {
        if let Some(turn) = self.active_turn.as_mut() {
            turn.status = status;
            self.last_turn = Some(turn.clone());
        }
        self.active_turn = None;
    }

    pub fn append_assistant_message(
        &mut self,
        turn_id: impl Into<String>,
        run_id: impl Into<String>,
        content: impl Into<String>,
    ) {
        self.append_transcript_entry(
            turn_id.into(),
            run_id.into(),
            TranscriptRole::Assistant,
            vec![TranscriptBlock::Text {
                text: content.into(),
            }],
        );
    }

    pub fn append_reasoning(
        &mut self,
        turn_id: impl Into<String>,
        run_id: impl Into<String>,
        text: impl Into<String>,
    ) {
        self.append_transcript_entry(
            turn_id.into(),
            run_id.into(),
            TranscriptRole::Assistant,
            vec![TranscriptBlock::Reasoning { text: text.into() }],
        );
    }

    pub fn append_tool_call(
        &mut self,
        turn_id: impl Into<String>,
        run_id: impl Into<String>,
        tool_call_id: impl Into<String>,
        name: impl Into<String>,
        arguments: impl Into<String>,
    ) {
        self.append_transcript_entry(
            turn_id.into(),
            run_id.into(),
            TranscriptRole::Tool,
            vec![TranscriptBlock::ToolCall {
                tool_call_id: tool_call_id.into(),
                name: name.into(),
                arguments: arguments.into(),
            }],
        );
    }

    pub fn append_tool_result(
        &mut self,
        turn_id: impl Into<String>,
        run_id: impl Into<String>,
        tool_call_id: impl Into<String>,
        name: impl Into<String>,
        success: bool,
        content: impl Into<String>,
    ) {
        self.append_transcript_entry(
            turn_id.into(),
            run_id.into(),
            TranscriptRole::Tool,
            vec![TranscriptBlock::ToolResult {
                tool_call_id: tool_call_id.into(),
                name: name.into(),
                success,
                content: content.into(),
            }],
        );
    }

    pub fn append_reset_marker(&mut self, reason: impl Into<String>) {
        self.append_transcript_entry(
            next_system_turn_id(),
            next_system_run_id(),
            TranscriptRole::System,
            vec![TranscriptBlock::ResetMarker {
                reason: reason.into(),
            }],
        );
    }

    pub fn append_blocked(
        &mut self,
        turn_id: impl Into<String>,
        run_id: impl Into<String>,
        reason: impl Into<String>,
    ) {
        self.append_transcript_entry(
            turn_id.into(),
            run_id.into(),
            TranscriptRole::System,
            vec![TranscriptBlock::Blocked {
                reason: reason.into(),
            }],
        );
    }

    pub fn append_restored_message(
        &mut self,
        role: TranscriptRole,
        content: impl Into<String>,
        index: usize,
    ) {
        self.append_transcript_entry(
            format!("turn_restored_{index}"),
            format!("run_restored_{index}"),
            role,
            vec![TranscriptBlock::Text {
                text: content.into(),
            }],
        );
    }

    pub fn replace_transcript(&mut self, transcript: Vec<TranscriptEntry>) {
        self.leaf_entry_id = transcript.last().map(|entry| entry.entry_id.clone());
        self.transcript = transcript;
    }

    fn append_transcript_entry(
        &mut self,
        turn_id: String,
        run_id: String,
        role: TranscriptRole,
        blocks: Vec<TranscriptBlock>,
    ) {
        let entry_id = format!("entry_{}", self.transcript.len() + 1);
        let entry = TranscriptEntry {
            entry_id: entry_id.clone(),
            parent_id: self.leaf_entry_id.clone(),
            turn_id,
            run_id,
            role,
            blocks,
            created_at_ms: now_ms(),
        };
        self.leaf_entry_id = Some(entry_id);
        self.transcript.push(entry);
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn next_system_turn_id() -> String {
    format!("turn_system_{}", now_ms())
}

fn next_system_run_id() -> String {
    format!("run_system_{}", now_ms())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::behavior::BehaviorVersions;
    use crate::turn::{TurnContext, TurnState, TurnStatus};

    use super::*;

    #[test]
    fn finish_turn_writes_terminal_status_before_clearing_active_slot() {
        let mut session = AgentSession::new("session_1", ".");
        session.begin_turn(TurnState {
            context: TurnContext {
                turn_id: "turn_1".to_string(),
                run_id: "run_1".to_string(),
                source: "prompt".to_string(),
                prompt: "hello".to_string(),
                cwd: PathBuf::from("."),
                versions: BehaviorVersions::default(),
                skills: Default::default(),
            },
            status: TurnStatus::Running,
        });

        session.finish_turn(TurnStatus::Completed);

        assert!(session.active_turn.is_none());
        assert_eq!(
            session.last_turn.as_ref().map(|turn| &turn.status),
            Some(&TurnStatus::Completed)
        );
    }

    #[test]
    fn transcript_entries_are_linear_with_parent_ids() {
        let mut session = AgentSession::new("session_1", ".");
        session.begin_turn(TurnState {
            context: TurnContext {
                turn_id: "turn_1".to_string(),
                run_id: "run_1".to_string(),
                source: "prompt".to_string(),
                prompt: "hello".to_string(),
                cwd: PathBuf::from("."),
                versions: BehaviorVersions::default(),
                skills: Default::default(),
            },
            status: TurnStatus::Running,
        });
        session.append_assistant_message("turn_1", "run_1", "hi");

        assert_eq!(session.transcript.len(), 2);
        assert_eq!(session.transcript[0].entry_id, "entry_1");
        assert_eq!(session.transcript[0].parent_id, None);
        assert_eq!(session.transcript[1].parent_id.as_deref(), Some("entry_1"));
        assert_eq!(session.transcript[1].turn_id, "turn_1");
        assert_eq!(session.transcript[1].run_id, "run_1");
    }
}
