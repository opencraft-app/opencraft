//! Typed runtime events.
//!
//! Protocol layers should project these events outward instead of depending on
//! runtime internals.

use std::sync::Arc;

use tokio::sync::{mpsc, Mutex};

use crate::client::Message;
use crate::tools::ToolResult;

/// Runtime host lifecycle or capability-boundary event.
#[derive(Debug, Clone, Default)]
pub struct RuntimeHostEvent {
    pub event: String,
    pub session_id: Option<String>,
    pub sandbox_id: Option<String>,
    pub workspace_root: Option<String>,
    pub template: Option<String>,
    pub error: Option<String>,
}

/// Events emitted by the agent runtime.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    /// Runtime-scoped event wrapper for protocol adapters that need to route
    /// concurrent queued runs back to the correct transport handle.
    RunScoped {
        run_id: String,
        event: Box<AgentEvent>,
    },
    /// Thinking/reasoning step.
    Thinking { content: String },
    /// Model reasoning content.
    Reasoning { text: String },
    /// Tool execution started.
    ToolStart {
        tool_call_id: String,
        name: String,
        arguments: String,
    },
    /// Tool execution completed.
    ToolComplete {
        tool_call_id: String,
        name: String,
        result: ToolResult,
    },
    /// Tool execution failed.
    ToolError {
        tool_call_id: String,
        name: String,
        error: String,
    },
    /// Response content received.
    Content { text: String },
    /// Agent finished with final response.
    Done { message: Message },
    /// Agent iteration completed.
    IterationComplete { iteration: usize },
    /// Runtime host lifecycle or capability-boundary event.
    RuntimeHost(RuntimeHostEvent),
    /// Agent error.
    Error { error: String },
}

/// Runtime-owned event sink that can both collect events for `RunTurnResult`
/// and forward the same event stream to live protocol/UI consumers.
#[derive(Clone, Default)]
pub struct AgentEventSink {
    events: Arc<Mutex<Vec<AgentEvent>>>,
    forward: Option<mpsc::Sender<AgentEvent>>,
}

impl AgentEventSink {
    pub fn new() -> Self {
        Self::with_forward(None)
    }

    pub fn forwarding(forward: mpsc::Sender<AgentEvent>) -> Self {
        Self::with_forward(Some(forward))
    }

    pub fn with_forward(forward: Option<mpsc::Sender<AgentEvent>>) -> Self {
        Self {
            events: Arc::new(Mutex::new(Vec::new())),
            forward,
        }
    }

    pub fn forwarder(&self) -> Option<mpsc::Sender<AgentEvent>> {
        self.forward.clone()
    }

    pub async fn emit(&self, event: AgentEvent) {
        self.events.lock().await.push(event.clone());
        if let Some(tx) = &self.forward {
            let _ = tx.send(event).await;
        }
    }

    pub async fn events(&self) -> Vec<AgentEvent> {
        self.events.lock().await.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sink_collects_and_forwards_same_event() {
        let (tx, mut rx) = mpsc::channel(1);
        let sink = AgentEventSink::with_forward(Some(tx));

        sink.emit(AgentEvent::Thinking {
            content: "working".to_string(),
        })
        .await;

        let collected = sink.events().await;
        assert_eq!(collected.len(), 1);
        assert!(matches!(
            collected.first(),
            Some(AgentEvent::Thinking { content }) if content == "working"
        ));

        let forwarded = rx.recv().await.expect("forwarded event");
        assert!(matches!(
            forwarded,
            AgentEvent::Thinking { content } if content == "working"
        ));
    }
}
