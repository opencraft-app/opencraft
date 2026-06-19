use crate::{EventCursor, EventId, SessionId, ThreadId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct EventType(pub &'static str);

impl EventType {
    pub const SESSION_CREATED: Self = Self("session.created");
    pub const SESSION_UPDATED: Self = Self("session.updated");
    pub const SESSION_CONFIG_UPDATED: Self = Self("session.config.updated");
    pub const SESSION_STATUS_CHANGED: Self = Self("session.status.changed");
    pub const SESSION_CLOSED: Self = Self("session.closed");
    pub const BACKEND_STATUS_CHANGED: Self = Self("backend.status.changed");
    pub const USER_MESSAGE_ACCEPTED: Self = Self("user.message.accepted");
    pub const INPUT_QUEUED: Self = Self("input.queued");
    pub const INPUT_REJECTED: Self = Self("input.rejected");
    pub const TURN_CANCEL_ACCEPTED: Self = Self("turn.cancel.accepted");
    pub const REQUEST_RESPONSE_ACCEPTED: Self = Self("request.response.accepted");
    pub const TURN_STARTED: Self = Self("turn.started");
    pub const TURN_COMPLETED: Self = Self("turn.completed");
    pub const TURN_FAILED: Self = Self("turn.failed");
    pub const TURN_CANCELLED: Self = Self("turn.cancelled");
    pub const ASSISTANT_MESSAGE_STARTED: Self = Self("assistant.message.started");
    pub const ASSISTANT_MESSAGE_DELTA: Self = Self("assistant.message.delta");
    pub const ASSISTANT_MESSAGE_COMPLETED: Self = Self("assistant.message.completed");
    pub const ASSISTANT_REASONING_DELTA: Self = Self("assistant.reasoning.delta");
    pub const ASSISTANT_REASONING_COMPLETED: Self = Self("assistant.reasoning.completed");
    pub const TOOL_STARTED: Self = Self("tool.started");
    pub const TOOL_UPDATED: Self = Self("tool.updated");
    pub const TOOL_OUTPUT_DELTA: Self = Self("tool.output.delta");
    pub const TOOL_COMPLETED: Self = Self("tool.completed");
    pub const TOOL_FAILED: Self = Self("tool.failed");
    pub const COMMAND_STARTED: Self = Self("command.started");
    pub const COMMAND_OUTPUT_DELTA: Self = Self("command.output.delta");
    pub const COMMAND_COMPLETED: Self = Self("command.completed");
    pub const COMMAND_FAILED: Self = Self("command.failed");
    pub const TASK_STARTED: Self = Self("task.started");
    pub const TASK_UPDATED: Self = Self("task.updated");
    pub const TASK_COMPLETED: Self = Self("task.completed");
    pub const REQUEST_OPENED: Self = Self("request.opened");
    pub const REQUEST_UPDATED: Self = Self("request.updated");
    pub const REQUEST_RESOLVED: Self = Self("request.resolved");
    pub const DIFF_UPDATED: Self = Self("diff.updated");
    pub const USAGE_UPDATED: Self = Self("usage.updated");
    pub const WARNING_RAISED: Self = Self("warning.raised");
    pub const ERROR_RAISED: Self = Self("error.raised");
    pub const PROJECTION_INVALIDATED: Self = Self("projection.invalidated");
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
        let affected_views = affected_views_for(event_type)
            .into_iter()
            .map(str::to_string)
            .collect();
        Self {
            event_id: EventId::new(),
            epoch: 0,
            seq: 0,
            thread_id: ThreadId::from(session_id.as_str()),
            session_id,
            event_type,
            created_at: Utc::now(),
            affected_views,
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
            event_id: self.event_id.clone(),
            epoch: self.epoch,
            seq: self.seq,
        }
    }

    pub fn with_raw(mut self, raw: Value) -> Self {
        self.raw = Some(raw);
        self
    }
}

fn affected_views_for(event_type: EventType) -> Vec<&'static str> {
    match event_type {
        EventType::SESSION_CREATED
        | EventType::SESSION_UPDATED
        | EventType::SESSION_CONFIG_UPDATED
        | EventType::SESSION_STATUS_CHANGED
        | EventType::SESSION_CLOSED => {
            vec!["sessions", "session", "timeline", "workbench"]
        }
        EventType::BACKEND_STATUS_CHANGED => vec!["backends", "workbench"],
        EventType::USER_MESSAGE_ACCEPTED => {
            vec!["session", "transcript", "timeline", "workbench"]
        }
        EventType::INPUT_QUEUED
        | EventType::INPUT_REJECTED
        | EventType::TURN_CANCEL_ACCEPTED
        | EventType::TURN_STARTED
        | EventType::TURN_COMPLETED
        | EventType::TURN_FAILED
        | EventType::TURN_CANCELLED => {
            vec!["session", "activity", "timeline", "workbench"]
        }
        EventType::ASSISTANT_MESSAGE_STARTED
        | EventType::ASSISTANT_MESSAGE_DELTA
        | EventType::ASSISTANT_MESSAGE_COMPLETED => {
            vec!["session", "transcript", "timeline", "workbench"]
        }
        EventType::ASSISTANT_REASONING_DELTA
        | EventType::ASSISTANT_REASONING_COMPLETED
        | EventType::TOOL_STARTED
        | EventType::TOOL_UPDATED
        | EventType::TOOL_OUTPUT_DELTA
        | EventType::TOOL_COMPLETED
        | EventType::TOOL_FAILED
        | EventType::COMMAND_STARTED
        | EventType::COMMAND_OUTPUT_DELTA
        | EventType::COMMAND_COMPLETED
        | EventType::COMMAND_FAILED
        | EventType::TASK_STARTED
        | EventType::TASK_UPDATED
        | EventType::TASK_COMPLETED
        | EventType::WARNING_RAISED
        | EventType::ERROR_RAISED => vec!["activity", "timeline", "workbench"],
        EventType::REQUEST_RESPONSE_ACCEPTED
        | EventType::REQUEST_OPENED
        | EventType::REQUEST_UPDATED
        | EventType::REQUEST_RESOLVED => {
            vec!["requests", "activity", "timeline", "workbench"]
        }
        EventType::DIFF_UPDATED => vec!["diffs", "activity", "timeline", "workbench"],
        EventType::USAGE_UPDATED => vec!["session", "workbench"],
        EventType::PROJECTION_INVALIDATED => vec![
            "sessions",
            "session",
            "transcript",
            "activity",
            "requests",
            "diffs",
            "timeline",
            "workbench",
        ],
        _ => vec!["timeline", "workbench"],
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
