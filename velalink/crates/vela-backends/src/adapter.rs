use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::mpsc;
use vela_core::{
    BackendKind, BackendModel, EventDraft, EventSource, EventType, ResolvedAgentConfig, SessionId,
    TurnId, UserMessageBlock,
};

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct BackendOutput {
    pub event_type: EventType,
    pub payload: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    pub blocks: Vec<UserMessageBlock>,
    pub session_id: Option<SessionId>,
    pub turn_id: Option<TurnId>,
    pub working_directory: Option<String>,
    pub resolved_agent_config: Option<ResolvedAgentConfig>,
    pub emit_diagnostics: bool,
}

impl BackendSend {
    pub fn new(content: impl Into<String>) -> Self {
        let content = content.into();
        Self {
            blocks: text_blocks_from_content(&content),
            content,
            session_id: None,
            turn_id: None,
            working_directory: None,
            resolved_agent_config: None,
            emit_diagnostics: false,
        }
    }
}

fn text_blocks_from_content(content: &str) -> Vec<UserMessageBlock> {
    if content.is_empty() {
        Vec::new()
    } else {
        vec![UserMessageBlock::text(content)]
    }
}

#[derive(Clone, Debug)]
pub struct BackendOutputSink {
    sender: mpsc::Sender<anyhow::Result<BackendOutput>>,
}

impl BackendOutputSink {
    pub async fn send(&self, output: BackendOutput) -> anyhow::Result<()> {
        self.sender
            .send(Ok(output))
            .await
            .map_err(|_| anyhow::anyhow!("backend output receiver was dropped"))
    }
}

pub type BackendOutputReceiver = mpsc::Receiver<anyhow::Result<BackendOutput>>;

pub fn backend_output_channel(buffer: usize) -> (BackendOutputSink, BackendOutputReceiver) {
    let (sender, receiver) = mpsc::channel(buffer);
    (BackendOutputSink { sender }, receiver)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackendCapabilities {
    pub streaming: bool,
    pub cancel: bool,
    pub permission_requests: bool,
    pub structured_diff: bool,
    pub session_agent_config: bool,
}

impl BackendCapabilities {
    pub fn pi_default() -> Self {
        Self {
            streaming: true,
            cancel: true,
            permission_requests: true,
            structured_diff: true,
            session_agent_config: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackendProbe {
    pub status: BackendStatus,
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendStatus {
    Available,
    Unavailable,
    Degraded,
}

impl BackendStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Unavailable => "unavailable",
            Self::Degraded => "degraded",
        }
    }
}

#[derive(Clone, Debug)]
pub struct BackendCancel {
    pub session_id: String,
    pub backend: Option<BackendKind>,
}

#[derive(Clone, Debug)]
pub struct BackendRequestResponse {
    pub session_id: SessionId,
    pub backend: Option<BackendKind>,
    pub request_id: String,
    pub result: Option<String>,
    pub scope: Option<String>,
    pub answer: Option<String>,
    pub content: Option<Value>,
    pub options: Option<Value>,
}

#[async_trait]
pub trait BackendAdapter: Send + Sync {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities::pi_default()
    }

    fn capabilities_for_backend(&self, _backend: Option<BackendKind>) -> BackendCapabilities {
        self.capabilities()
    }

    async fn probe(&self) -> anyhow::Result<BackendProbe> {
        Ok(BackendProbe {
            status: BackendStatus::Available,
            message: None,
        })
    }

    async fn probe_backend(&self, _backend: Option<BackendKind>) -> anyhow::Result<BackendProbe> {
        self.probe().await
    }

    async fn list_models(
        &self,
        _backend: Option<BackendKind>,
    ) -> anyhow::Result<Vec<BackendModel>> {
        Ok(Vec::new())
    }

    async fn cancel(&self, _input: BackendCancel) -> anyhow::Result<()> {
        Ok(())
    }

    async fn respond_to_request(&self, _input: BackendRequestResponse) -> anyhow::Result<()> {
        Ok(())
    }

    async fn stream_user_message(
        &self,
        input: BackendSend,
        sink: BackendOutputSink,
    ) -> anyhow::Result<()>;
}

pub async fn emit_backend_outputs(
    sink: BackendOutputSink,
    outputs: Vec<BackendOutput>,
) -> anyhow::Result<()> {
    for output in outputs {
        sink.send(output).await?;
    }
    Ok(())
}
