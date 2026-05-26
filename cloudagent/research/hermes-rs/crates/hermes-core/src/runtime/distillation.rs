use tracing::warn;

use crate::client::Message;
use crate::distillation::distill_session_to_memory;
use crate::runtime::agent::AgentExecutor;

impl AgentExecutor {
    pub(crate) fn spawn_session_distillation(&self, history: Vec<Message>) {
        let Some(memory_manager) = self.memory_manager.clone() else {
            return;
        };

        let client = self.client.clone();
        let model = self.config.model.clone();
        tokio::spawn(async move {
            if let Err(error) =
                distill_session_to_memory(client, model, memory_manager, history).await
            {
                warn!(error = %error, "Session distillation failed");
            }
        });
    }
}
