use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot, RwLock};
use tokio::time::timeout;
use tracing::{debug, error, info, instrument, warn};

use crate::error::{Error, Result};
use crate::schema::ToolSchema;

use super::{ToolContext, ToolHandler, ToolResult};

/// Internal message for tool execution.
#[derive(Debug)]
#[allow(dead_code)]
enum ToolCommand {
    Execute {
        tool_name: String,
        tool_call_id: String,
        args: Value,
        response_tx: oneshot::Sender<ToolResult>,
    },
    Shutdown,
}

/// Sandboxed tool executor with timeout support.
#[derive(Clone)]
struct ToolExecutor {
    timeout: Duration,
}

impl ToolExecutor {
    fn new(timeout: Duration) -> Self {
        Self { timeout }
    }

    async fn execute_with_timeout(
        &self,
        tool: Arc<dyn ToolHandler>,
        tool_name: String,
        tool_call_id: String,
        args: Value,
        context: ToolContext,
    ) -> ToolResult {
        let result = timeout(self.timeout, tool.execute(args, context)).await;

        match result {
            Ok(mut result) => {
                result.tool_call_id = tool_call_id;
                result
            }
            Err(_) => {
                warn!(tool = %tool_name, timeout = ?self.timeout, "Tool execution timed out");
                ToolResult::error(
                    tool_call_id,
                    format!("Tool timed out after {:?}", self.timeout),
                )
            }
        }
    }
}

/// Registry for managing and executing tools.
#[derive(Clone)]
pub struct ToolRegistry {
    tools: Arc<RwLock<HashMap<String, Arc<dyn ToolHandler>>>>,
    executor: ToolExecutor,
    #[allow(dead_code)]
    command_tx: mpsc::Sender<ToolCommand>,
}

impl ToolRegistry {
    /// Create a new tool registry.
    pub fn new(timeout: Duration) -> Self {
        let tools = Arc::new(RwLock::new(HashMap::new()));
        let (command_tx, command_rx) = mpsc::channel(100);

        let registry = Self {
            tools,
            executor: ToolExecutor::new(timeout),
            command_tx,
        };

        let tools_clone = registry.tools.clone();
        let executor = ToolExecutor::new(timeout);
        tokio::spawn(async move {
            registry_worker(tools_clone, executor, command_rx).await;
        });

        registry
    }

    /// Register a tool.
    #[instrument(skip(self, tool), fields(tool = % tool.name()))]
    pub async fn register<T: ToolHandler + 'static>(&self, tool: T) -> Result<()> {
        let name = tool.name().to_string();
        let mut tools = self.tools.write().await;

        if tools.contains_key(&name) {
            warn!(tool = %name, "Tool already registered, replacing");
        }

        tools.insert(name.clone(), Arc::new(tool));
        info!(tool = %name, "Tool registered successfully");
        Ok(())
    }

    /// Get all registered tool schemas.
    pub async fn get_schemas(&self) -> Vec<ToolSchema> {
        let tools = self.tools.read().await;
        tools.values().map(|t| t.schema()).collect()
    }

    /// Get a tool by name.
    pub async fn get(&self, name: &str) -> Option<Arc<dyn ToolHandler>> {
        let tools = self.tools.read().await;
        tools.get(name).cloned()
    }

    /// Check if a tool is registered.
    pub async fn contains(&self, name: &str) -> bool {
        let tools = self.tools.read().await;
        tools.contains_key(name)
    }

    /// Get the number of registered tools.
    pub async fn len(&self) -> usize {
        let tools = self.tools.read().await;
        tools.len()
    }

    /// Check if no tools are registered.
    pub async fn is_empty(&self) -> bool {
        let tools = self.tools.read().await;
        tools.is_empty()
    }

    /// Execute a tool by name with arguments.
    #[instrument(skip(self, args, context), fields(tool = % tool_name))]
    pub async fn execute(
        &self,
        tool_name: &str,
        tool_call_id: &str,
        args: Value,
        context: ToolContext,
    ) -> Result<ToolResult> {
        let tool = {
            let tools = self.tools.read().await;
            tools.get(tool_name).cloned()
        };

        match tool {
            Some(tool) => {
                let name = tool_name.to_string();
                let id = tool_call_id.to_string();
                debug!(tool = %name, args = ?args, "Executing tool");
                let result = self
                    .executor
                    .execute_with_timeout(tool, name, id, args, context)
                    .await;
                Ok(result)
            }
            None => {
                error!(tool = %tool_name, "Tool not found in registry");
                Err(Error::ToolNotFound {
                    name: tool_name.to_string(),
                })
            }
        }
    }

    /// Execute multiple tools concurrently.
    #[allow(dead_code)]
    pub async fn execute_all(
        &self,
        requests: Vec<(String, String, Value, ToolContext)>,
    ) -> Vec<Result<ToolResult>> {
        let mut results = Vec::new();
        for (name, id, args, ctx) in requests {
            results.push(self.execute(&name, &id, args, ctx).await);
        }
        results
    }
}

async fn registry_worker(
    tools: Arc<RwLock<HashMap<String, Arc<dyn ToolHandler>>>>,
    executor: ToolExecutor,
    mut command_rx: mpsc::Receiver<ToolCommand>,
) {
    info!("Tool registry worker started");

    while let Some(cmd) = command_rx.recv().await {
        match cmd {
            ToolCommand::Execute {
                tool_name,
                tool_call_id,
                args,
                response_tx,
            } => {
                let tool = {
                    let tools = tools.read().await;
                    tools.get(&tool_name).cloned()
                };

                let result = match tool {
                    Some(tool) => {
                        executor
                            .execute_with_timeout(
                                tool,
                                tool_name,
                                tool_call_id.clone(),
                                args,
                                ToolContext::default(),
                            )
                            .await
                    }
                    None => {
                        ToolResult::error(&tool_call_id, format!("Tool '{}' not found", tool_name))
                    }
                };

                let _ = response_tx.send(result);
            }
            ToolCommand::Shutdown => {
                info!("Tool registry worker shutting down");
                break;
            }
        }
    }
}
