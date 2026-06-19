use serde::{Deserialize, Serialize};
use serde_json::Value;
use vela_core::{CommandId, EventCursor, SessionId, TurnId};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RestCommandResponse {
    Accepted(AcceptedCommandResponse),
    Queued(QueuedCommandResponse),
    Rejected(RejectedCommandResponse),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcceptedCommandResponse {
    pub command_id: CommandId,
    pub session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub cursor: WireEventCursor,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueuedCommandResponse {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub queued_message_id: String,
    pub cursor: WireEventCursor,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RejectedCommandResponse {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<CommandId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<WireEventCursor>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireEventCursor {
    pub event_id: String,
    pub epoch: i64,
    pub seq: i64,
}

impl WireEventCursor {
    pub fn new(event_id: impl Into<String>, cursor: EventCursor) -> Self {
        let event_id = event_id.into();
        debug_assert_eq!(event_id, cursor.event_id.as_str());
        Self {
            event_id,
            epoch: cursor.epoch,
            seq: cursor.seq,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ErrorEnvelope {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EventStreamMessage {
    pub event_id: String,
    pub event_type: String,
    pub session_id: String,
    pub cursor: EventCursor,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SyncResetMessage {
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_cursor: Option<EventCursor>,
}
