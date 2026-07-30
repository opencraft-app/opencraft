use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::RwLock;

use crate::client::{Message, Role};
use crate::context::{
    estimate_message_tokens, estimate_tokens, fit_messages_to_context, is_compressed_summary,
    ContextConfig,
};
use crate::schema::ToolSchema;
use crate::tools::{ToolContext, ToolHandler, ToolResult};

#[derive(Debug, Clone)]
pub struct ContextEngineTool {
    conversation: Arc<RwLock<Vec<Message>>>,
    config: ContextConfig,
}

impl ContextEngineTool {
    pub fn new(conversation: Arc<RwLock<Vec<Message>>>, config: ContextConfig) -> Self {
        Self {
            conversation,
            config,
        }
    }
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
struct ContextEngineArgs {
    action: ContextEngineAction,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum ContextEngineAction {
    Status,
    Preview,
    Compress,
    Explain,
}

#[derive(Debug, Serialize)]
struct MessagePreview {
    index: usize,
    role: String,
    chars: usize,
    estimated_tokens: usize,
    compressed_summary: bool,
    preview: String,
}

#[async_trait]
impl ToolHandler for ContextEngineTool {
    fn name(&self) -> &str {
        "context_engine"
    }

    fn description(&self) -> &str {
        "Inspect, preview, compress, or explain the agent's current model context state."
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema::from_type::<ContextEngineArgs>(
            "context_engine",
            "Inspect, preview, compress, or explain current model context. \
             Actions: status, preview, compress, explain.",
        )
    }

    async fn execute(&self, args: serde_json::Value, _context: ToolContext) -> ToolResult {
        let args = match serde_json::from_value::<ContextEngineArgs>(args) {
            Ok(args) => args,
            Err(error) => {
                return ToolResult::error(
                    "context_engine",
                    format!("Invalid context_engine arguments: {error}"),
                )
            }
        };

        match args.action {
            ContextEngineAction::Status => {
                let conversation = self.conversation.read().await;
                ToolResult::success("context_engine", self.status_payload(&conversation))
            }
            ContextEngineAction::Preview => {
                let conversation = self.conversation.read().await;
                let limit = args.limit.unwrap_or(8).clamp(1, 32);
                ToolResult::success(
                    "context_engine",
                    json!({
                        "messages": preview_messages(&conversation, limit),
                    }),
                )
            }
            ContextEngineAction::Compress => {
                let mut conversation = self.conversation.write().await;
                let before = context_stats(&conversation, self.config);
                let compressed = fit_messages_to_context(&conversation, self.config);
                *conversation = compressed;
                let after = context_stats(&conversation, self.config);
                ToolResult::success(
                    "context_engine",
                    json!({
                        "action": "compress",
                        "before": before,
                        "after": after,
                    }),
                )
            }
            ContextEngineAction::Explain => ToolResult::success(
                "context_engine",
                json!({
                    "tool": "context_engine",
                    "model": "Hermes keeps durable conversation history in the runtime, then projects a bounded model context each turn.",
                    "layers": {
                        "stable": "base identity and tool-use rules",
                        "context": "workspace context files plus selected skills and skill bundles",
                        "volatile": "long-term memory projection and runtime notes such as current time"
                    },
                    "compression": "When projected history exceeds the context budget, Hermes preserves leading system context and recent tail messages, then inserts a reference-only summary for older middle history.",
                    "actions": ["status", "preview", "compress", "explain"]
                }),
            ),
        }
    }
}

impl ContextEngineTool {
    fn status_payload(&self, conversation: &[Message]) -> serde_json::Value {
        context_stats(conversation, self.config)
    }
}

fn context_stats(conversation: &[Message], config: ContextConfig) -> serde_json::Value {
    let estimated_tokens: usize = conversation.iter().map(estimate_message_tokens).sum();
    let available_tokens = config
        .max_context_length
        .saturating_sub(config.response_buffer);
    let compressed_summaries = conversation
        .iter()
        .filter(|message| is_compressed_summary(message))
        .count();
    json!({
        "message_count": conversation.len(),
        "estimated_tokens": estimated_tokens,
        "context_window": config.max_context_length,
        "response_buffer": config.response_buffer,
        "available_tokens": available_tokens,
        "needs_compression": estimated_tokens > available_tokens,
        "compressed_summary_count": compressed_summaries,
        "role_counts": role_counts(conversation),
    })
}

fn role_counts(conversation: &[Message]) -> serde_json::Value {
    let mut system = 0usize;
    let mut user = 0usize;
    let mut assistant = 0usize;
    let mut tool = 0usize;
    for message in conversation {
        match message.role {
            Role::System => system += 1,
            Role::User => user += 1,
            Role::Assistant => assistant += 1,
            Role::Tool => tool += 1,
        }
    }
    json!({
        "system": system,
        "user": user,
        "assistant": assistant,
        "tool": tool,
    })
}

fn preview_messages(conversation: &[Message], limit: usize) -> Vec<MessagePreview> {
    let start = conversation.len().saturating_sub(limit);
    conversation
        .iter()
        .enumerate()
        .skip(start)
        .map(|(index, message)| MessagePreview {
            index,
            role: role_name(&message.role).to_string(),
            chars: message.content.chars().count(),
            estimated_tokens: estimate_tokens(&message.content),
            compressed_summary: is_compressed_summary(message),
            preview: truncate_preview(&message.content),
        })
        .collect()
}

fn role_name(role: &Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

fn truncate_preview(content: &str) -> String {
    const MAX_CHARS: usize = 240;
    let count = content.chars().count();
    if count <= MAX_CHARS {
        return content.to_string();
    }
    let prefix = content.chars().take(MAX_CHARS).collect::<String>();
    format!("{prefix}...[truncated {count} chars]")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn context_engine_status_reports_conversation_budget() {
        let conversation = Arc::new(RwLock::new(vec![
            Message::user("hello"),
            Message::assistant("world"),
        ]));
        let tool = ContextEngineTool::new(
            conversation,
            ContextConfig {
                max_context_length: 100,
                response_buffer: 10,
                ..ContextConfig::default()
            },
        );

        let result = tool
            .execute(json!({ "action": "status" }), ToolContext::default())
            .await;
        assert!(result.success);
        let payload: serde_json::Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(payload["message_count"], 2);
        assert_eq!(payload["available_tokens"], 90);
    }

    #[tokio::test]
    async fn context_engine_compress_mutates_history_to_fit() {
        let conversation = Arc::new(RwLock::new(vec![
            Message::system("system"),
            Message::user("u".repeat(800)),
            Message::assistant("a".repeat(800)),
            Message::user("latest"),
        ]));
        let tool = ContextEngineTool::new(
            conversation.clone(),
            ContextConfig {
                max_context_length: 80,
                response_buffer: 0,
                ..ContextConfig::default()
            },
        );

        let result = tool
            .execute(json!({ "action": "compress" }), ToolContext::default())
            .await;
        assert!(result.success);
        let conversation = conversation.read().await;
        assert!(conversation.len() < 4);
        assert!(conversation.iter().any(is_compressed_summary));
    }
}
