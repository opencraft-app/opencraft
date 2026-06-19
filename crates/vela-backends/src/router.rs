use crate::{
    BackendAdapter, BackendCancel, BackendCapabilities, BackendOutputSink, BackendProbe,
    BackendRequestResponse, BackendSend, BackendStatus,
};
use async_trait::async_trait;
use std::{collections::HashMap, sync::Arc};
use vela_core::BackendKind;

#[derive(Clone, Default)]
pub struct BackendRouter {
    backends: HashMap<BackendKind, Arc<dyn BackendAdapter>>,
    default_backend: Option<BackendKind>,
}

impl BackendRouter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_backend(mut self, kind: BackendKind, backend: Arc<dyn BackendAdapter>) -> Self {
        if self.default_backend.is_none() {
            self.default_backend = Some(kind);
        }
        self.backends.insert(kind, backend);
        self
    }

    fn backend_for_send(&self, input: &BackendSend) -> anyhow::Result<Arc<dyn BackendAdapter>> {
        let kind = input
            .resolved_agent_config
            .as_ref()
            .map(|config| config.backend)
            .or(self.default_backend)
            .ok_or_else(|| anyhow::anyhow!("no backend configured"))?;
        self.backends
            .get(&kind)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("backend {} is not configured", kind.as_str()))
    }

    fn adapter_for_kind(
        &self,
        kind: Option<BackendKind>,
    ) -> anyhow::Result<Arc<dyn BackendAdapter>> {
        let kind = kind
            .or(self.default_backend)
            .ok_or_else(|| anyhow::anyhow!("no backend configured"))?;
        self.backends
            .get(&kind)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("backend {} is not configured", kind.as_str()))
    }
}

#[async_trait]
impl BackendAdapter for BackendRouter {
    fn capabilities(&self) -> BackendCapabilities {
        self.adapter_for_kind(None)
            .map(|backend| backend.capabilities())
            .unwrap_or_else(|_| BackendCapabilities {
                streaming: false,
                cancel: false,
                permission_requests: false,
                structured_diff: false,
            })
    }

    fn capabilities_for_backend(&self, kind: Option<BackendKind>) -> BackendCapabilities {
        self.adapter_for_kind(kind)
            .map(|backend| backend.capabilities())
            .unwrap_or_else(|_| BackendCapabilities {
                streaming: false,
                cancel: false,
                permission_requests: false,
                structured_diff: false,
            })
    }

    async fn probe(&self) -> anyhow::Result<BackendProbe> {
        self.probe_backend(None).await
    }

    async fn probe_backend(&self, kind: Option<BackendKind>) -> anyhow::Result<BackendProbe> {
        match self.adapter_for_kind(kind) {
            Ok(backend) => backend.probe().await,
            Err(error) => Ok(BackendProbe {
                status: BackendStatus::Unavailable,
                message: Some(error.to_string()),
            }),
        }
    }

    async fn cancel(&self, input: BackendCancel) -> anyhow::Result<()> {
        self.adapter_for_kind(input.backend)?.cancel(input).await
    }

    async fn respond_to_request(&self, input: BackendRequestResponse) -> anyhow::Result<()> {
        self.adapter_for_kind(input.backend)?
            .respond_to_request(input)
            .await
    }

    async fn stream_user_message(
        &self,
        input: BackendSend,
        sink: BackendOutputSink,
    ) -> anyhow::Result<()> {
        self.backend_for_send(&input)?
            .stream_user_message(input, sink)
            .await
    }
}
