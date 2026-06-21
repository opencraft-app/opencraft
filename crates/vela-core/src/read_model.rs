use crate::{EventCursor, EventId, RequestId, SessionId, TurnId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadModelKind {
    SessionList,
    Session,
    Conversation,
    AgentWork,
    PendingRequests,
    DiffReview,
    BackendStatus,
}

impl ReadModelKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionList => "session_list",
            Self::Session => "session",
            Self::Conversation => "conversation",
            Self::AgentWork => "agent_work",
            Self::PendingRequests => "pending_requests",
            Self::DiffReview => "diff_review",
            Self::BackendStatus => "backend_status",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptRole {
    User,
    Assistant,
    System,
}

impl TranscriptRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConversationView {
    pub session_id: SessionId,
    pub items: Vec<ConversationItem>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConversationWindowView {
    pub session_id: SessionId,
    pub items: Vec<ConversationItem>,
    pub window: ConversationWindow,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<EventCursor>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConversationWindow {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_item_id: Option<String>,
    pub has_older: bool,
    pub has_newer: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConversationItem {
    pub item_id: String,
    pub session_id: SessionId,
    pub kind: ConversationItemKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub revision: u64,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<TranscriptPart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub detail: Value,
    pub source_event_ids: Vec<EventId>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationItemKind {
    UserMessage,
    AssistantMessage,
    TurnMeta,
    AgentWork,
    Status,
}

impl ConversationItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserMessage => "user_message",
            Self::AssistantMessage => "assistant_message",
            Self::TurnMeta => "turn_meta",
            Self::AgentWork => "agent_work",
            Self::Status => "status",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChatTranscriptView {
    pub session_id: SessionId,
    pub rows: Vec<TranscriptRow>,
    pub turns: Vec<TranscriptTurnSummary>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChatTranscriptWindow {
    pub session_id: SessionId,
    pub rows: Vec<TranscriptRow>,
    pub turns: Vec<TranscriptTurnSummary>,
    pub window: TranscriptWindow,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<EventCursor>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TranscriptWindow {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_row_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_row_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_row_id: Option<String>,
    pub has_older: bool,
    pub has_newer: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TranscriptRow {
    pub row_id: String,
    pub session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub role: TranscriptRole,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub revision: u64,
    pub status: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<TranscriptPart>,
    pub source_event_ids: Vec<EventId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TranscriptTurnSummary {
    pub turn_id: TurnId,
    pub status: String,
    pub started_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_row_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_row_id: Option<String>,
    pub source_event_ids: Vec<EventId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TranscriptPart {
    pub id: String,
    #[serde(rename = "type")]
    pub part_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub data: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActivityShelfView {
    pub session_id: SessionId,
    pub items: Vec<ActivityItem>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActivityItem {
    pub item_id: String,
    pub session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub kind: ActivityKind,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub payload: Value,
    pub source_event_ids: Vec<EventId>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityKind {
    Turn,
    Tool,
    Command,
    Task,
    Request,
    Diff,
    Warning,
    Error,
}

impl ActivityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Turn => "turn",
            Self::Tool => "tool",
            Self::Command => "command",
            Self::Task => "task",
            Self::Request => "request",
            Self::Diff => "diff",
            Self::Warning => "warning",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PendingRequestsView {
    pub session_id: SessionId,
    pub requests: Vec<PendingRequest>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PendingRequest {
    pub request_id: RequestId,
    pub session_id: SessionId,
    pub title: String,
    pub status: String,
    pub payload: Value,
    pub source_event_ids: Vec<EventId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionListView {
    pub sessions: Vec<SessionListItem>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionListItem {
    pub session_id: SessionId,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    pub source_event_ids: Vec<EventId>,
}
