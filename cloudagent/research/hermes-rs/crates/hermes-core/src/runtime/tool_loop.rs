use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tracing::{debug, error, warn};

use crate::client::ToolCall;
use crate::error::{Error, Result};
use crate::events::AgentEvent;
use crate::runtime::agent::AgentExecutor;
use crate::tools::{ToolResult, ToolRouter};

impl AgentExecutor {
    pub(crate) async fn execute_tools(
        &self,
        tool_calls: Vec<ToolCall>,
        cancel: Option<Arc<AtomicBool>>,
    ) -> Result<Vec<(String, ToolResult)>> {
        let mut results = Vec::new();
        let tool_context = self.tool_context_for_tools(&tool_calls).await?;
        let router = ToolRouter::new(self.registry.clone()).with_gate_hook(self.gate_hook.clone());

        for tool_call in tool_calls {
            check_cancelled(cancel.as_ref())?;
            let name = tool_call.function.name.clone();
            let args_str = tool_call.function.arguments.clone();

            debug!(tool = %name, args = %args_str, "Executing tool");
            self.emit(AgentEvent::ToolStart {
                tool_call_id: tool_call.id.clone(),
                name: name.clone(),
                arguments: args_str.clone(),
            })
            .await;

            let args: serde_json::Value = match serde_json::from_str(&args_str) {
                Ok(a) => a,
                Err(e) => {
                    warn!(tool = %name, error = %e, "Failed to parse tool arguments");
                    results.push((
                        name,
                        ToolResult::error(&tool_call.id, format!("Invalid JSON: {}", e)),
                    ));
                    continue;
                }
            };

            if !router.contains(&name).await {
                error!(tool = %name, "Tool not found");
                results.push((
                    name.clone(),
                    ToolResult::error(&tool_call.id, format!("Tool '{}' not found", name)),
                ));
                continue;
            }

            let result = router
                .dispatch(&name, &tool_call.id, args, tool_context.clone())
                .await;
            check_cancelled(cancel.as_ref())?;
            debug!(tool = %name, success = result.success, "Tool execution completed");
            results.push((name, result));
        }

        Ok(results)
    }
}

pub(crate) fn check_cancelled(cancel: Option<&Arc<AtomicBool>>) -> Result<()> {
    if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        return Err(Error::Agent("run canceled by abort".to_string()));
    }
    Ok(())
}
