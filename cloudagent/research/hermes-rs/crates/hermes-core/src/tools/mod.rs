//! Tool system for the agent runtime.
//!
//! This module provides the core tool infrastructure including:
//! - `ToolHandler` trait for defining tools
//! - `ToolRegistry` for managing and executing tools
//! - Built-in tools for common operations

pub mod builtin;
pub mod clarify_tool;
pub mod code_execution;
pub mod context;
pub mod datetime_tool;
pub mod file_tools;
pub mod http_tool;
pub mod memory_tools;
pub mod patch_tool;
pub mod process_tool;
pub mod provider;
pub mod registry;
pub mod router;
pub mod schema;
pub mod sub_agent_tool;
pub mod terminal_tool;
pub mod todo_tool;
pub mod web_tools;

// Re-export commonly used types
pub use builtin::{
    builtin_tool_names, register_builtin_tools, register_builtin_tools_with_sub_agent, ClarifyTool,
    CodeExecutionTool, DateTimeTool, FileListTool, FileReadTool, FileSearchTool, FileWriteTool,
    HttpRequestTool, MemoryRecallTool, MemorySearchTool, MemoryStoreTool, PatchTool, ProcessTool,
    ReadFileTool, SearchFilesTool, SubAgentTool, TerminalTool, TimestampTool, TodoTool,
    WebFetchTool, WebSearchTool, WriteFileTool,
};
pub use context::ToolContext;
pub use provider::{BuiltinToolProvider, ToolProvider};
pub use registry::ToolRegistry;
pub use router::ToolRouter;
pub use schema::{ToolHandler, ToolResult};

#[cfg(test)]
use crate::error::Error;
#[cfg(test)]
use async_trait::async_trait;
#[cfg(test)]
use serde::Deserialize;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::{GateHook, ToolGateInput};
    use crate::policy::GateDecision;
    use crate::schema::ToolSchema;
    use schemars::JsonSchema;
    use serde_json::Value;
    use std::sync::Arc;
    use std::time::Duration;

    #[derive(JsonSchema, Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[allow(dead_code)]
    struct TestArgs {
        query: String,
        limit: Option<i32>,
    }

    struct TestTool;
    struct WrongIdTool;
    struct DenyAllGate;

    #[async_trait]
    impl ToolHandler for TestTool {
        fn name(&self) -> &str {
            "test_tool"
        }

        fn description(&self) -> &str {
            "A test tool for unit testing"
        }

        fn schema(&self) -> ToolSchema {
            ToolSchema::from_type::<TestArgs>("test_tool", "A test tool")
        }

        async fn execute(&self, args: Value, _context: ToolContext) -> ToolResult {
            if let Some(query) = args.get("query").and_then(|v| v.as_str()) {
                ToolResult::success(
                    "call_1",
                    serde_json::json!({ "result": format!("Processed: {}", query) }),
                )
            } else {
                ToolResult::error("call_1", "Missing 'query' argument")
            }
        }
    }

    #[async_trait]
    impl ToolHandler for WrongIdTool {
        fn name(&self) -> &str {
            "wrong_id_tool"
        }

        fn description(&self) -> &str {
            "Returns a result with the wrong tool_call_id"
        }

        fn schema(&self) -> ToolSchema {
            ToolSchema::from_type::<TestArgs>("wrong_id_tool", "A test tool")
        }

        async fn execute(&self, _args: Value, _context: ToolContext) -> ToolResult {
            ToolResult::success("tool_name_instead_of_id", serde_json::json!({ "ok": true }))
        }
    }

    #[async_trait]
    impl GateHook for DenyAllGate {
        async fn before_tool(&self, _input: &ToolGateInput) -> GateDecision {
            GateDecision::Deny("blocked for test".to_string())
        }
    }

    #[tokio::test]
    async fn test_registry_operations() {
        let registry = ToolRegistry::new(Duration::from_secs(5));

        // Register a tool
        registry.register(TestTool).await.unwrap();

        // Check tool exists
        assert!(registry.contains("test_tool").await);
        assert_eq!(registry.len().await, 1);

        // Get schemas
        let schemas = registry.get_schemas().await;
        assert_eq!(schemas.len(), 1);
        assert_eq!(schemas[0].name, "test_tool");
    }

    #[tokio::test]
    async fn test_tool_execution() {
        let registry = ToolRegistry::new(Duration::from_secs(5));
        registry.register(TestTool).await.unwrap();

        let args = serde_json::json!({
            "query": "test query",
            "limit": 10
        });

        let result = registry
            .execute("test_tool", "call_1", args, ToolContext::default())
            .await
            .unwrap();

        assert!(result.success);
        assert!(result.content.contains("Processed:"));
    }

    #[tokio::test]
    async fn test_result_tool_call_id_is_normalized() {
        let registry = ToolRegistry::new(Duration::from_secs(5));
        registry.register(WrongIdTool).await.unwrap();

        let result = registry
            .execute(
                "wrong_id_tool",
                "call_expected",
                serde_json::json!({"query": "ignored"}),
                ToolContext::default(),
            )
            .await
            .unwrap();

        assert!(result.success);
        assert_eq!(result.tool_call_id, "call_expected");
    }

    #[tokio::test]
    async fn test_tool_not_found() {
        let registry = ToolRegistry::new(Duration::from_secs(5));

        let result = registry
            .execute(
                "nonexistent",
                "call_1",
                serde_json::json!({}),
                ToolContext::default(),
            )
            .await;

        assert!(result.is_err());
        match result.unwrap_err() {
            Error::ToolNotFound { name } => assert_eq!(name, "nonexistent"),
            _ => panic!("Expected ToolNotFound error"),
        }
    }

    #[tokio::test]
    async fn test_tool_router_gate_denial_skips_handler() {
        let registry = ToolRegistry::new(Duration::from_secs(5));
        registry.register(TestTool).await.unwrap();
        let router = ToolRouter::new(registry).with_gate_hook(Arc::new(DenyAllGate));

        let result = router
            .dispatch(
                "test_tool",
                "call_1",
                serde_json::json!({"query": "test query"}),
                ToolContext::default(),
            )
            .await;

        assert!(!result.success);
        assert!(result
            .error
            .as_deref()
            .is_some_and(|error| error.contains("blocked for test")));
    }
}
