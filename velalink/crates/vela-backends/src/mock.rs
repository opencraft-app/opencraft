use crate::{
    BackendAdapter, BackendCancel, BackendOutput, BackendOutputSink, BackendProbe, BackendSend,
    BackendStatus, emit_backend_outputs,
};
use async_trait::async_trait;
use std::sync::Arc;
use tokio::sync::Mutex;
use vela_core::ResolvedAgentConfig;

#[derive(Clone, Debug)]
pub struct MockBackendAdapter {
    outputs: Vec<BackendOutput>,
    prompts: Arc<Mutex<Vec<String>>>,
    inputs: Arc<Mutex<Vec<BackendSend>>>,
    resolved_agent_configs: Arc<Mutex<Vec<Option<ResolvedAgentConfig>>>>,
    cancels: Arc<Mutex<Vec<String>>>,
    probes: Arc<Mutex<usize>>,
}

impl MockBackendAdapter {
    pub fn new(outputs: Vec<BackendOutput>) -> Self {
        Self {
            outputs,
            prompts: Arc::new(Mutex::new(Vec::new())),
            inputs: Arc::new(Mutex::new(Vec::new())),
            resolved_agent_configs: Arc::new(Mutex::new(Vec::new())),
            cancels: Arc::new(Mutex::new(Vec::new())),
            probes: Arc::new(Mutex::new(0)),
        }
    }

    pub async fn prompt_count(&self) -> usize {
        self.prompts.lock().await.len()
    }

    pub async fn recorded_inputs(&self) -> Vec<BackendSend> {
        self.inputs.lock().await.clone()
    }

    pub async fn recorded_resolved_agent_configs(&self) -> Vec<Option<ResolvedAgentConfig>> {
        self.resolved_agent_configs.lock().await.clone()
    }

    pub async fn cancel_count(&self) -> usize {
        self.cancels.lock().await.len()
    }

    pub async fn probe_count(&self) -> usize {
        *self.probes.lock().await
    }
}

#[async_trait]
impl BackendAdapter for MockBackendAdapter {
    async fn probe(&self) -> anyhow::Result<BackendProbe> {
        *self.probes.lock().await += 1;
        Ok(BackendProbe {
            status: BackendStatus::Available,
            message: Some("mock backend available".to_string()),
        })
    }

    async fn cancel(&self, input: BackendCancel) -> anyhow::Result<()> {
        self.cancels.lock().await.push(input.session_id);
        Ok(())
    }

    async fn stream_user_message(
        &self,
        input: BackendSend,
        sink: BackendOutputSink,
    ) -> anyhow::Result<()> {
        self.inputs.lock().await.push(input.clone());
        self.prompts.lock().await.push(input.content);
        self.resolved_agent_configs
            .lock()
            .await
            .push(input.resolved_agent_config);
        emit_backend_outputs(sink, self.outputs.clone()).await
    }
}
