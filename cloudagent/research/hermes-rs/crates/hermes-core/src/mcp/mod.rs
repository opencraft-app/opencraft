//! MCP (Model Context Protocol) client for the agent runtime.
//!
//! Provides integration with MCP servers to extend the agent's capabilities
//! with tools and resources from external sources.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use crate::error::Result;

mod protocol;
mod tool_provider;

use protocol::{
    initialize_request, rpc_request, InitializeResponse, JsonRpcResponse, ToolListResult,
};
pub use protocol::{McpCapabilities, McpToolDefinition};
pub use tool_provider::{McpManager, McpTool, McpTransport};

/// MCP client for connecting to MCP servers
#[derive(Debug, Clone)]
pub struct McpClient {
    /// Server URL
    url: String,
    /// Authentication token
    auth_token: Option<String>,
    /// HTTP client
    client: reqwest::Client,
    /// Connected tools from this server
    tools: Arc<RwLock<Vec<McpTool>>>,
    /// Server capabilities
    capabilities: Arc<RwLock<McpCapabilities>>,
    /// Whether connected
    connected: Arc<RwLock<bool>>,
}

impl McpClient {
    /// Create a new MCP client
    pub fn new(url: impl Into<String>, auth_token: Option<String>) -> Self {
        Self {
            url: url.into(),
            auth_token,
            client: reqwest::Client::new(),
            tools: Arc::new(RwLock::new(Vec::new())),
            capabilities: Arc::new(RwLock::new(McpCapabilities::default())),
            connected: Arc::new(RwLock::new(false)),
        }
    }

    /// Connect to the MCP server and initialize
    pub async fn connect(&self) -> Result<()> {
        info!(url = %self.url, "Connecting to MCP server");

        let request = initialize_request();

        let response = self
            .send_request("initialize", Some(serde_json::to_value(request)?))
            .await?;

        let init_response: InitializeResponse = serde_json::from_value(response).map_err(|e| {
            crate::error::Error::ParseResponse(format!(
                "Failed to parse initialize response: {}",
                e
            ))
        })?;

        debug!(
            server = %init_response.server_info.name,
            version = %init_response.server_info.version,
            "MCP server initialized"
        );

        // Update capabilities
        {
            let mut caps = self.capabilities.write().await;
            caps.tools = init_response.capabilities.tools.is_some();
            caps.resources = init_response.capabilities.resources.is_some();
            caps.prompts = init_response.capabilities.prompts.is_some();
        }

        // Send initialized notification
        self.send_notification("initialized", Value::Null).await?;

        // List available tools
        self.list_tools().await?;

        *self.connected.write().await = true;
        info!(url = %self.url, "Connected to MCP server");

        Ok(())
    }

    /// Disconnect from the MCP server
    pub async fn disconnect(&self) -> Result<()> {
        *self.connected.write().await = false;
        self.tools.write().await.clear();
        info!(url = %self.url, "Disconnected from MCP server");
        Ok(())
    }

    /// Check if connected
    pub async fn is_connected(&self) -> bool {
        *self.connected.read().await
    }

    /// List tools from the server
    pub async fn list_tools(&self) -> Result<Vec<McpToolDefinition>> {
        let response = self.send_request("tools/list", None).await?;
        let tool_list: ToolListResult = serde_json::from_value(response).map_err(|e| {
            crate::error::Error::ParseResponse(format!("Failed to parse tool list: {}", e))
        })?;

        let tools: Vec<McpTool> = tool_list
            .tools
            .into_iter()
            .map(|def| McpTool::new(self.clone(), def))
            .collect();

        *self.tools.write().await = tools;

        debug!(count = self.tools.read().await.len(), "Listed MCP tools");
        Ok(self
            .tools
            .read()
            .await
            .iter()
            .map(|t| t.definition().clone())
            .collect())
    }

    /// Call a tool on the MCP server
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<Value> {
        let params = serde_json::json!({
            "name": name,
            "arguments": arguments
        });

        let response = self.send_request("tools/call", Some(params)).await?;
        Ok(response)
    }

    /// Get all tools
    pub async fn get_tools(&self) -> Vec<McpTool> {
        self.tools.read().await.clone()
    }

    /// Get server capabilities
    pub async fn get_capabilities(&self) -> McpCapabilities {
        self.capabilities.read().await.clone()
    }

    /// Send a JSON-RPC request
    async fn send_request(&self, method: &str, params: Option<Value>) -> Result<Value> {
        let request_id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);

        let request = rpc_request(method, params, request_id);

        let mut req_builder = self
            .client
            .post(&self.url)
            .header("Content-Type", "application/json");

        if let Some(ref token) = self.auth_token {
            req_builder = req_builder.header("Authorization", format!("Bearer {}", token));
        }

        let response = req_builder.json(&request).send().await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await?;
            error!(status = %status, body = %body, "MCP request failed");
            return Err(crate::error::Error::Agent(format!(
                "MCP request failed: {} - {}",
                status, body
            )));
        }

        let rpc_response: JsonRpcResponse = response.json().await?;

        if let Some(error) = rpc_response.error {
            return Err(crate::error::Error::Agent(format!(
                "MCP error {}: {}",
                error.code, error.message
            )));
        }

        rpc_response
            .result
            .ok_or_else(|| crate::error::Error::Agent("No result in MCP response".to_string()))
    }

    /// Send a notification (no response expected)
    async fn send_notification(&self, method: &str, params: Value) -> Result<()> {
        let request = rpc_request(method, Some(params), 0);

        let mut req_builder = self
            .client
            .post(&self.url)
            .header("Content-Type", "application/json");

        if let Some(ref token) = self.auth_token {
            req_builder = req_builder.header("Authorization", format!("Bearer {}", token));
        }

        let _ = req_builder.json(&request).send().await;
        Ok(())
    }
}

/// Bundled stdin/stdout for a stdio MCP transport
#[derive(Debug)]
struct StdioIo {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

/// MCP client that communicates over stdin/stdout of a child process
#[derive(Debug, Clone)]
pub struct McpStdioClient {
    /// Command to spawn
    command: String,
    /// Arguments for the command
    args: Vec<String>,
    /// Environment variables for the child process
    env: HashMap<String, String>,
    /// Child process handle
    child: Arc<RwLock<Option<Child>>>,
    /// Stdin/stdout IO pair (locked together for request-response atomicity)
    io: Arc<tokio::sync::Mutex<Option<StdioIo>>>,
    /// Connected tools from this server
    tools: Arc<RwLock<Vec<McpTool>>>,
    /// Server capabilities
    capabilities: Arc<RwLock<McpCapabilities>>,
    /// Whether connected
    connected: Arc<RwLock<bool>>,
    /// Atomic request ID counter
    request_id: Arc<AtomicU64>,
}

impl McpStdioClient {
    /// Create a new stdio MCP client
    pub fn new(
        command: impl Into<String>,
        args: Vec<String>,
        env: HashMap<String, String>,
    ) -> Self {
        Self {
            command: command.into(),
            args,
            env,
            child: Arc::new(RwLock::new(None)),
            io: Arc::new(tokio::sync::Mutex::new(None)),
            tools: Arc::new(RwLock::new(Vec::new())),
            capabilities: Arc::new(RwLock::new(McpCapabilities::default())),
            connected: Arc::new(RwLock::new(false)),
            request_id: Arc::new(AtomicU64::new(1)),
        }
    }

    /// Connect to the MCP server by spawning the child process and initializing
    pub async fn connect(&self) -> Result<()> {
        info!(command = %self.command, "Spawning MCP stdio server");

        let mut cmd = tokio::process::Command::new(&self.command);
        cmd.args(&self.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        for (key, value) in &self.env {
            cmd.env(key, value);
        }

        let mut child = cmd.spawn().map_err(|e| {
            crate::error::Error::Agent(format!(
                "Failed to spawn MCP server '{}': {}",
                self.command, e
            ))
        })?;

        let stdin = child.stdin.take().ok_or_else(|| {
            crate::error::Error::Agent("Failed to capture child stdin".to_string())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            crate::error::Error::Agent("Failed to capture child stdout".to_string())
        })?;

        *self.child.write().await = Some(child);
        *self.io.lock().await = Some(StdioIo {
            stdin,
            stdout: BufReader::new(stdout),
        });

        // Send initialize request
        let request = initialize_request();

        let response = self
            .send_request("initialize", Some(serde_json::to_value(request)?))
            .await?;

        let init_response: InitializeResponse = serde_json::from_value(response).map_err(|e| {
            crate::error::Error::ParseResponse(format!(
                "Failed to parse initialize response: {}",
                e
            ))
        })?;

        debug!(
            server = %init_response.server_info.name,
            version = %init_response.server_info.version,
            "MCP stdio server initialized"
        );

        // Update capabilities
        {
            let mut caps = self.capabilities.write().await;
            caps.tools = init_response.capabilities.tools.is_some();
            caps.resources = init_response.capabilities.resources.is_some();
            caps.prompts = init_response.capabilities.prompts.is_some();
        }

        // Send initialized notification
        self.send_notification("initialized", Value::Null).await?;

        // List available tools
        self.list_tools().await?;

        *self.connected.write().await = true;
        info!(command = %self.command, "Connected to MCP stdio server");

        Ok(())
    }

    /// Disconnect from the MCP server by killing the child process
    pub async fn disconnect(&self) -> Result<()> {
        *self.connected.write().await = false;
        self.tools.write().await.clear();

        // Drop IO handles to close stdin (signals EOF to child)
        *self.io.lock().await = None;

        // Kill child process if still running
        if let Some(mut child) = self.child.write().await.take() {
            if let Err(e) = child.kill().await {
                warn!(error = %e, "Failed to kill MCP stdio server process");
            } else {
                debug!("MCP stdio server process killed");
            }
        }

        info!(command = %self.command, "Disconnected from MCP stdio server");
        Ok(())
    }

    /// Check if connected
    pub async fn is_connected(&self) -> bool {
        *self.connected.read().await
    }

    /// List tools from the server
    pub async fn list_tools(&self) -> Result<Vec<McpToolDefinition>> {
        let response = self.send_request("tools/list", None).await?;
        let tool_list: ToolListResult = serde_json::from_value(response).map_err(|e| {
            crate::error::Error::ParseResponse(format!("Failed to parse tool list: {}", e))
        })?;

        let tools: Vec<McpTool> = tool_list
            .tools
            .into_iter()
            .map(|def| McpTool::new_stdio(self.clone(), def))
            .collect();

        *self.tools.write().await = tools;

        debug!(
            count = self.tools.read().await.len(),
            "Listed MCP stdio tools"
        );
        Ok(self
            .tools
            .read()
            .await
            .iter()
            .map(|t| t.definition().clone())
            .collect())
    }

    /// Call a tool on the MCP server
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<Value> {
        let params = serde_json::json!({
            "name": name,
            "arguments": arguments
        });

        let response = self.send_request("tools/call", Some(params)).await?;
        Ok(response)
    }

    /// Get all tools
    pub async fn get_tools(&self) -> Vec<McpTool> {
        self.tools.read().await.clone()
    }

    /// Get server capabilities
    pub async fn get_capabilities(&self) -> McpCapabilities {
        self.capabilities.read().await.clone()
    }

    /// Send a JSON-RPC request over stdin and read response from stdout
    async fn send_request(&self, method: &str, params: Option<Value>) -> Result<Value> {
        let request_id = self.request_id.fetch_add(1, Ordering::SeqCst);

        let request = rpc_request(method, params, request_id);

        let mut request_line = serde_json::to_string(&request).map_err(|e| {
            crate::error::Error::Agent(format!("Failed to serialize request: {}", e))
        })?;
        request_line.push('\n');

        let mut io_guard = self.io.lock().await;
        let io = io_guard.as_mut().ok_or_else(|| {
            crate::error::Error::Agent("MCP stdio transport not connected".to_string())
        })?;

        // Write request to stdin
        io.stdin
            .write_all(request_line.as_bytes())
            .await
            .map_err(|e| {
                crate::error::Error::Agent(format!("Failed to write to MCP stdin: {}", e))
            })?;
        io.stdin
            .flush()
            .await
            .map_err(|e| crate::error::Error::Agent(format!("Failed to flush MCP stdin: {}", e)))?;

        // Read response from stdout
        let mut response_line = String::new();
        io.stdout.read_line(&mut response_line).await.map_err(|e| {
            crate::error::Error::Agent(format!("Failed to read from MCP stdout: {}", e))
        })?;

        if response_line.is_empty() {
            return Err(crate::error::Error::Agent(
                "MCP server closed stdout unexpectedly".to_string(),
            ));
        }

        let rpc_response: JsonRpcResponse =
            serde_json::from_str(response_line.trim()).map_err(|e| {
                crate::error::Error::ParseResponse(format!(
                    "Failed to parse MCP stdio response: {}",
                    e
                ))
            })?;

        if let Some(error) = rpc_response.error {
            return Err(crate::error::Error::Agent(format!(
                "MCP error {}: {}",
                error.code, error.message
            )));
        }

        rpc_response
            .result
            .ok_or_else(|| crate::error::Error::Agent("No result in MCP response".to_string()))
    }

    /// Send a notification (no response expected)
    async fn send_notification(&self, method: &str, params: Value) -> Result<()> {
        let request = rpc_request(method, Some(params), 0);

        let mut request_line = serde_json::to_string(&request).map_err(|e| {
            crate::error::Error::Agent(format!("Failed to serialize notification: {}", e))
        })?;
        request_line.push('\n');

        let mut io_guard = self.io.lock().await;
        if let Some(io) = io_guard.as_mut() {
            let _ = io.stdin.write_all(request_line.as_bytes()).await;
            let _ = io.stdin.flush().await;
        }

        Ok(())
    }
}
