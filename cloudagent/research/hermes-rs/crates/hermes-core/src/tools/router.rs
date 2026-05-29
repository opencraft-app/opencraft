use std::sync::Arc;

use serde_json::Value;

use crate::error::Result;
use crate::hooks::{GateHook, NoopGateHook, ToolGateInput};
use crate::schema::ToolSchema;

use super::{ToolContext, ToolProvider, ToolRegistry, ToolResult};

/// Policy-aware router in front of a registry.
///
/// This is the dispatch seam for provider/gate integration. The legacy
/// `ToolRegistry::execute` remains available for compatibility.
pub struct ToolRouter {
    registry: ToolRegistry,
    gate_hook: Arc<dyn GateHook>,
}

impl ToolRouter {
    pub fn new(registry: ToolRegistry) -> Self {
        Self {
            registry,
            gate_hook: Arc::new(NoopGateHook),
        }
    }

    pub fn with_gate_hook(mut self, gate_hook: Arc<dyn GateHook>) -> Self {
        self.gate_hook = gate_hook;
        self
    }

    pub fn registry(&self) -> &ToolRegistry {
        &self.registry
    }

    pub async fn register_provider<P: ToolProvider>(&self, provider: &P) -> Result<()> {
        provider.register_tools(&self.registry).await
    }

    pub async fn dispatch(
        &self,
        tool_name: &str,
        tool_call_id: &str,
        args: Value,
        context: ToolContext,
    ) -> ToolResult {
        let arguments = serde_json::to_string(&args).unwrap_or_default();
        if let Err(error) = self
            .gate_hook
            .before_tool(&ToolGateInput {
                name: tool_name.to_string(),
                arguments,
            })
            .await
            .into_result()
        {
            return ToolResult::error(tool_call_id, error.to_string());
        }
        match self
            .registry
            .execute(tool_name, tool_call_id, args, context)
            .await
        {
            Ok(result) => result,
            Err(error) => ToolResult::error(tool_call_id, error.to_string()),
        }
    }

    pub async fn get_schemas(&self) -> Vec<ToolSchema> {
        self.registry.get_schemas().await
    }

    pub async fn contains(&self, name: &str) -> bool {
        self.registry.contains(name).await
    }
}
