use crate::{EventCursor, EventId, SessionId, ThreadId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct EventType(pub &'static str);

impl EventType {
    pub const SESSION_CREATED: Self = Self("session.created");
    pub const USER_MESSAGE_ACCEPTED: Self = Self("user.message.accepted");
    pub const TURN_STARTED: Self = Self("turn.started");
    pub const ASSISTANT_MESSAGE_DELTA: Self = Self("assistant.message.delta");
    pub const REASONING_DELTA: Self = Self("reasoning.delta");
    pub const TOOL_CALL_STARTED: Self = Self("tool_call.started");
    pub const TOOL_CALL_UPDATED: Self = Self("tool_call.updated");
    pub const TOOL_CALL_COMPLETED: Self = Self("tool_call.completed");
    pub const TOOL_CALL_FAILED: Self = Self("tool_call.failed");
    pub const TURN_COMPLETED: Self = Self("turn.completed");
    pub const TURN_FAILED: Self = Self("turn.failed");
    pub const WARNING_RAISED: Self = Self("warning.raised");
}

impl Serialize for EventType {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.0)
    }
}

impl<'de> Deserialize<'de> for EventType {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(Self(Box::leak(value.into_boxed_str())))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EventSource {
    pub kind: String,
    pub name: String,
}

impl EventSource {
    pub fn runtime(name: impl Into<String>) -> Self {
        Self {
            kind: "runtime".to_string(),
            name: name.into(),
        }
    }

    pub fn backend(name: impl Into<String>) -> Self {
        Self {
            kind: "backend".to_string(),
            name: name.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CanonicalEvent {
    pub event_id: EventId,
    pub epoch: i64,
    pub seq: i64,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub event_type: EventType,
    pub created_at: DateTime<Utc>,
    pub affected_views: Vec<String>,
    pub source: EventSource,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
}

impl CanonicalEvent {
    pub fn new(
        session_id: SessionId,
        event_type: EventType,
        source: EventSource,
        payload: Value,
    ) -> Self {
        Self {
            event_id: EventId::new(),
            epoch: 0,
            seq: 0,
            thread_id: ThreadId::from(session_id.as_str()),
            session_id,
            event_type,
            created_at: Utc::now(),
            affected_views: Vec::new(),
            source,
            payload,
            raw: None,
        }
    }

    pub fn with_cursor(mut self, epoch: i64, seq: i64) -> Self {
        self.epoch = epoch;
        self.seq = seq;
        self
    }

    pub fn cursor(&self) -> EventCursor {
        EventCursor {
            epoch: self.epoch,
            seq: self.seq,
        }
    }

    pub fn with_raw(mut self, raw: Value) -> Self {
        self.raw = Some(raw);
        self
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct EventDraft {
    pub event_type: EventType,
    pub source: EventSource,
    pub payload: Value,
    pub raw: Option<Value>,
}

impl EventDraft {
    pub fn warning(message: impl Into<String>, raw: Value) -> Self {
        Self {
            event_type: EventType::WARNING_RAISED,
            source: EventSource::backend("pi"),
            payload: json!({ "message": message.into() }),
            raw: Some(raw),
        }
    }
}
