use async_trait::async_trait;

use crate::error::Result;

use super::{register_builtin_tools, ToolRegistry};

/// Provider that contributes tool definitions to a registry.
#[async_trait]
pub trait ToolProvider: Send + Sync {
    async fn register_tools(&self, registry: &ToolRegistry) -> Result<()>;
}

/// Built-in agent tools as a provider.
#[derive(Debug, Default, Clone)]
pub struct BuiltinToolProvider;

#[async_trait]
impl ToolProvider for BuiltinToolProvider {
    async fn register_tools(&self, registry: &ToolRegistry) -> Result<()> {
        register_builtin_tools(registry).await
    }
}
