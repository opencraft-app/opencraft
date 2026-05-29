use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::error::Result;
use crate::schema::ToolSchema;
use crate::tools::{ToolContext, ToolHandler, ToolResult};

use super::{McpClient, McpStdioClient};
use crate::mcp::protocol::McpToolDefinition;

/// MCP transport type — either HTTP or stdio.
#[derive(Debug, Clone)]
pub enum McpTransport {
    /// HTTP-based MCP client.
    Http(McpClient),
    /// Stdio-based MCP client (child process).
    Stdio(McpStdioClient),
}

impl McpTransport {
    /// Check if the transport is connected.
    pub async fn is_connected(&self) -> bool {
        match self {
            McpTransport::Http(c) => c.is_connected().await,
            McpTransport::Stdio(c) => c.is_connected().await,
        }
    }

    /// Get all tools from this transport.
    pub async fn get_tools(&self) -> Vec<McpTool> {
        match self {
            McpTransport::Http(c) => c.get_tools().await,
            McpTransport::Stdio(c) => c.get_tools().await,
        }
    }

    /// Disconnect the transport.
    pub async fn disconnect(&self) -> Result<()> {
        match self {
            McpTransport::Http(c) => c.disconnect().await,
            McpTransport::Stdio(c) => c.disconnect().await,
        }
    }

    /// Call a tool on this transport.
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<Value> {
        match self {
            McpTransport::Http(c) => c.call_tool(name, arguments).await,
            McpTransport::Stdio(c) => c.call_tool(name, arguments).await,
        }
    }
}

/// A tool from an MCP server.
#[derive(Debug, Clone)]
pub struct McpTool {
    transport: McpTransport,
    definition: Arc<McpToolDefinition>,
}

impl McpTool {
    /// Create a new MCP tool wrapper (HTTP transport).
    pub fn new(client: McpClient, definition: McpToolDefinition) -> Self {
        Self {
            transport: McpTransport::Http(client),
            definition: Arc::new(definition),
        }
    }

    /// Create a new MCP tool wrapper (stdio transport).
    pub fn new_stdio(client: McpStdioClient, definition: McpToolDefinition) -> Self {
        Self {
            transport: McpTransport::Stdio(client),
            definition: Arc::new(definition),
        }
    }

    /// Get the tool name.
    pub fn name(&self) -> &str {
        &self.definition.name
    }

    /// Get the tool definition.
    pub fn definition(&self) -> &McpToolDefinition {
        &self.definition
    }
}

#[async_trait]
impl ToolHandler for McpTool {
    fn name(&self) -> &str {
        &self.definition.name
    }

    fn description(&self) -> &str {
        &self.definition.description
    }

    fn schema(&self) -> ToolSchema {
        let params = serde_json::to_value(&self.definition.input_schema)
            .unwrap_or_else(|_| serde_json::json!({"type": "object"}));

        ToolSchema::new(&self.definition.name, &self.definition.description, params)
    }

    async fn execute(&self, args: Value, _context: ToolContext) -> ToolResult {
        let name = self.definition.name.clone();

        match self.transport.call_tool(&name, args).await {
            Ok(result) => ToolResult::success(name, result),
            Err(e) => ToolResult::error(name, e.to_string()),
        }
    }
}

/// MCP server connection manager.
#[derive(Debug, Default)]
pub struct McpManager {
    /// Connected servers (HTTP and stdio).
    servers: HashMap<String, McpTransport>,
}

impl McpManager {
    /// Create a new MCP manager.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add and connect to an HTTP MCP server.
    pub async fn add_server(
        &mut self,
        name: impl Into<String>,
        url: String,
        auth_token: Option<String>,
    ) -> Result<()> {
        let name = name.into();
        let client = McpClient::new(url, auth_token);
        client.connect().await?;
        self.servers.insert(name, McpTransport::Http(client));
        Ok(())
    }

    /// Add and connect to a stdio MCP server (child process).
    pub async fn add_stdio_server(
        &mut self,
        name: impl Into<String>,
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
    ) -> Result<()> {
        let name = name.into();
        let client = McpStdioClient::new(command, args, env);
        client.connect().await?;
        self.servers.insert(name, McpTransport::Stdio(client));
        Ok(())
    }

    /// Remove and disconnect a server.
    pub async fn remove_server(&mut self, name: &str) -> Result<()> {
        if let Some(transport) = self.servers.remove(name) {
            transport.disconnect().await?;
        }
        Ok(())
    }

    /// Get a server transport by name.
    pub fn get(&self, name: &str) -> Option<&McpTransport> {
        self.servers.get(name)
    }

    /// Get all servers.
    pub fn servers(&self) -> &HashMap<String, McpTransport> {
        &self.servers
    }

    /// Get all tools from all servers.
    pub async fn get_all_tools(&self) -> Vec<McpTool> {
        let mut tools = Vec::new();
        for transport in self.servers.values() {
            if transport.is_connected().await {
                tools.extend(transport.get_tools().await);
            }
        }
        tools
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_mcp_tool_to_provider_schema() {
        let def = McpToolDefinition {
            name: "test_tool".to_string(),
            description: "A test tool".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string"}
                }
            }),
        };
        let tool = McpTool {
            transport: McpTransport::Http(McpClient::new("http://127.0.0.1", None)),
            definition: Arc::new(def),
        };

        let schema = tool.schema();
        assert_eq!(schema.name, "test_tool");
    }

    #[tokio::test]
    async fn manager_starts_empty() {
        let manager = McpManager::new();
        assert!(manager.servers.is_empty());
    }
}
