use serde::{Deserialize, Serialize};
use serde_json::Value;

/// MCP protocol version.
pub(super) const MCP_VERSION: &str = "2024-11-05";

/// Server capabilities.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpCapabilities {
    /// Supports tools.
    pub tools: bool,
    /// Supports resources.
    pub resources: bool,
    /// Supports prompts.
    pub prompts: bool,
}

/// Tool definition from MCP server.
#[derive(Debug, Clone, Deserialize)]
pub struct McpToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Initialize request.
#[derive(Debug, Serialize)]
pub(super) struct InitializeRequest {
    protocol_version: String,
    capabilities: ClientCapabilities,
    client_info: ClientInfo,
}

/// Client capabilities.
#[derive(Debug, Serialize)]
struct ClientCapabilities {
    #[serde(rename = "roots")]
    roots: Option<Roots>,
    #[serde(rename = "sampling")]
    sampling: Option<Sampling>,
}

/// Roots capability.
#[derive(Debug, Serialize)]
struct Roots {
    #[serde(rename = "listChanged")]
    list_changed: bool,
}

/// Sampling capability.
#[derive(Debug, Serialize)]
struct Sampling {}

/// Client info.
#[derive(Debug, Serialize)]
struct ClientInfo {
    name: String,
    version: String,
}

/// Initialize response.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(super) struct InitializeResponse {
    pub(super) protocol_version: String,
    pub(super) capabilities: ServerCapabilities,
    pub(super) server_info: ServerInfo,
}

/// Server capabilities.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(super) struct ServerCapabilities {
    #[serde(rename = "tools")]
    pub(super) tools: Option<ToolsCapability>,
    #[serde(rename = "resources")]
    pub(super) resources: Option<ResourcesCapability>,
    #[serde(rename = "prompts")]
    pub(super) prompts: Option<PromptsCapability>,
}

/// Tools capability.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(super) struct ToolsCapability {
    #[serde(rename = "listChanged")]
    list_changed: Option<bool>,
}

/// Resources capability.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(super) struct ResourcesCapability {
    #[serde(rename = "subscribe")]
    subscribe: Option<bool>,
    #[serde(rename = "listChanged")]
    list_changed: Option<bool>,
}

/// Prompts capability.
#[derive(Debug, Deserialize)]
pub(super) struct PromptsCapability {}

/// Server info.
#[derive(Debug, Deserialize)]
pub(super) struct ServerInfo {
    pub(super) name: String,
    pub(super) version: String,
}

/// JSON-RPC request.
#[derive(Debug, Serialize)]
pub(super) struct JsonRpcRequest {
    pub(super) jsonrpc: String,
    pub(super) method: String,
    pub(super) params: Option<Value>,
    pub(super) id: u64,
}

/// JSON-RPC response.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(super) struct JsonRpcResponse {
    pub(super) jsonrpc: String,
    pub(super) id: u64,
    pub(super) result: Option<Value>,
    pub(super) error: Option<JsonRpcError>,
}

/// JSON-RPC error.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(super) struct JsonRpcError {
    pub(super) code: i32,
    pub(super) message: String,
    data: Option<Value>,
}

/// Tool listing.
#[derive(Debug, Deserialize)]
pub(super) struct ToolListResult {
    pub(super) tools: Vec<McpToolDefinition>,
}

pub(super) fn initialize_request() -> InitializeRequest {
    InitializeRequest {
        protocol_version: MCP_VERSION.to_string(),
        capabilities: ClientCapabilities {
            roots: Some(Roots { list_changed: true }),
            sampling: Some(Sampling {}),
        },
        client_info: ClientInfo {
            name: "hermes-rs".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        },
    }
}

pub(super) fn rpc_request(method: &str, params: Option<Value>, id: u64) -> JsonRpcRequest {
    JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        method: method.to_string(),
        params,
        id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_initialize_and_tool_list_payloads() {
        let initialize = serde_json::to_value(initialize_request()).unwrap();
        assert_eq!(initialize["protocol_version"], MCP_VERSION);
        assert_eq!(initialize["client_info"]["name"], "hermes-rs");

        let list: ToolListResult = serde_json::from_value(serde_json::json!({
            "tools": [{
                "name": "search",
                "description": "Search",
                "input_schema": {"type": "object"}
            }]
        }))
        .unwrap();
        assert_eq!(list.tools[0].name, "search");
    }
}
