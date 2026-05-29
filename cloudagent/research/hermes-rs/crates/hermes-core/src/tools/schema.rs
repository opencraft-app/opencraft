use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::schema::ToolSchema;

use super::ToolContext;

/// Result of tool execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    /// Tool call ID this result is for.
    pub tool_call_id: String,
    /// Whether the execution succeeded.
    pub success: bool,
    /// Result content, serialized as JSON or error text.
    pub content: String,
    /// Optional error details.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ToolResult {
    /// Create a successful result.
    pub fn success<T: Serialize>(tool_call_id: impl Into<String>, content: T) -> Self {
        let content = serde_json::to_string(&content).unwrap_or_else(|_| "{}".to_string());
        Self {
            tool_call_id: tool_call_id.into(),
            success: true,
            content,
            error: None,
        }
    }

    /// Create an error result.
    pub fn error(tool_call_id: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            tool_call_id: tool_call_id.into(),
            success: false,
            content: String::new(),
            error: Some(error.into()),
        }
    }

    /// Create a result from a JSON value.
    pub fn from_value(tool_call_id: impl Into<String>, value: Value) -> Self {
        let content = serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string());
        Self {
            tool_call_id: tool_call_id.into(),
            success: true,
            content,
            error: None,
        }
    }

    /// Get the content as a parsed JSON value.
    pub fn parse_content<T: for<'de> Deserialize<'de>>(&self) -> Result<T> {
        serde_json::from_str(&self.content)
            .map_err(|e| Error::ParseResponse(format!("Failed to parse tool result: {}", e)))
    }
}

/// Trait for defining an executable tool handler.
///
/// Implementations provide a unique name, model-facing description, JSON
/// schema, and async execution body.
#[async_trait]
pub trait ToolHandler: Send + Sync {
    /// Get the tool's unique name.
    fn name(&self) -> &str;

    /// Get the tool's description.
    fn description(&self) -> &str;

    /// Get the JSON Schema for the tool's parameters.
    fn schema(&self) -> ToolSchema;

    /// Execute the tool with the given arguments and runtime context.
    async fn execute(&self, args: Value, context: ToolContext) -> ToolResult;
}
