use crate::{BackendAdapter, BackendOutput, BackendSend};
use async_trait::async_trait;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone, Debug)]
pub struct MockBackendAdapter {
    outputs: Vec<BackendOutput>,
    prompts: Arc<Mutex<Vec<String>>>,
}

impl MockBackendAdapter {
    pub fn new(outputs: Vec<BackendOutput>) -> Self {
        Self {
            outputs,
            prompts: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub async fn prompt_count(&self) -> usize {
        self.prompts.lock().await.len()
    }
}

#[async_trait]
impl BackendAdapter for MockBackendAdapter {
    async fn send_user_message(&self, input: BackendSend) -> anyhow::Result<Vec<BackendOutput>> {
        self.prompts.lock().await.push(input.content);
        Ok(self.outputs.clone())
    }
}
