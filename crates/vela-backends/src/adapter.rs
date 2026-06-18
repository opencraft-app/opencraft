use async_trait::async_trait;
use serde_json::Value;
use vela_core::{EventDraft, EventSource, EventType};

#[derive(Clone, Debug, PartialEq)]
pub struct BackendOutput {
    pub event_type: EventType,
    pub payload: Value,
    pub raw: Option<Value>,
}

impl BackendOutput {
    pub fn event(event_type: EventType, payload: Value) -> Self {
        Self {
            event_type,
            payload,
            raw: None,
        }
    }

    pub fn into_draft(self, source: EventSource) -> EventDraft {
        EventDraft {
            event_type: self.event_type,
            source,
            payload: self.payload,
            raw: self.raw,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BackendSend {
    pub content: String,
}

#[async_trait]
pub trait BackendAdapter: Send + Sync {
    async fn send_user_message(&self, input: BackendSend) -> anyhow::Result<Vec<BackendOutput>>;
}
