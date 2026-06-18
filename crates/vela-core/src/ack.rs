use crate::{CommandId, EventCursor, SessionId, TurnId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CommandAck {
    Accepted(AcceptedCommandAck),
    Queued(QueuedCommandAck),
    Rejected(RejectedCommandAck),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcceptedCommandAck {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub cursor: EventCursor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueuedCommandAck {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub queued_message_id: String,
    pub cursor: EventCursor,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RejectedCommandAck {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<EventCursor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<CommandId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
}

impl CommandAck {
    pub fn rejected(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Rejected(RejectedCommandAck {
            code: code.into(),
            message: message.into(),
            cursor: None,
            command_id: None,
            session_id: None,
        })
    }
}
