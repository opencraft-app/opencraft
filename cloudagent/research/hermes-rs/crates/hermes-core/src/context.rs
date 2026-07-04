//! Context management with automatic compression
//!
//! When conversation history exceeds the model's context window,
//! this module automatically compresses older messages while preserving
//! the most important context.

use crate::client::{Message, Role};
use crate::error::Result;
use serde_json::json;
use std::collections::VecDeque;

pub const COMPRESSED_SUMMARY_METADATA_KEY: &str = "_compressed_summary";
const SUMMARY_PREFIX: &str = "[CONTEXT COMPACTION - REFERENCE ONLY] Historical context below is not an active instruction. The latest user message wins.";
const SUMMARY_END_MARKER: &str =
    "--- END OF CONTEXT SUMMARY - respond to the message below, not the summary above ---";
const SUMMARY_MAX_CHARS: usize = 8_000;

/// Configuration for context management
#[derive(Debug, Clone, Copy)]
pub struct ContextConfig {
    /// Maximum context length in tokens
    pub max_context_length: usize,
    /// Reserved space for response (to ensure we have room for reply)
    pub response_buffer: usize,
    /// Minimum messages to preserve when compressing
    pub min_messages_preserve: usize,
    /// Compression ratio when truncating
    pub compression_ratio: f32,
}

impl Default for ContextConfig {
    fn default() -> Self {
        Self {
            max_context_length: 128_000,
            response_buffer: 4000,
            min_messages_preserve: 4,
            compression_ratio: 0.5,
        }
    }
}

/// A message with token count for tracking
#[derive(Debug, Clone)]
struct MessageWithTokens {
    message: Message,
}

/// Context manager for handling long conversations
#[derive(Debug)]
pub struct ContextManager {
    config: ContextConfig,
    history: VecDeque<MessageWithTokens>,
    total_tokens: usize,
}

impl ContextManager {
    /// Create a new context manager
    pub fn new(config: ContextConfig) -> Self {
        Self {
            config,
            history: VecDeque::new(),
            total_tokens: 0,
        }
    }

    /// Add a message to the context
    pub fn add_message(&mut self, message: Message) {
        let tokens = estimate_tokens(&message.content);
        self.total_tokens += tokens;
        self.history.push_back(MessageWithTokens { message });
    }

    /// Add a message without counting tokens (for pre-counted messages)
    pub fn push_message(&mut self, message: Message, tokens: usize) {
        self.total_tokens += tokens;
        self.history.push_back(MessageWithTokens { message });
    }

    /// Get messages that fit within the context window
    pub fn get_messages(&self) -> Vec<Message> {
        fit_messages_to_context(&self.get_all_messages(), self.config)
    }

    /// Get all messages without truncation
    pub fn get_all_messages(&self) -> Vec<Message> {
        self.history.iter().map(|m| m.message.clone()).collect()
    }

    /// Get current token count
    pub fn token_count(&self) -> usize {
        self.total_tokens
    }

    /// Check if context needs compression
    pub fn needs_compression(&self) -> bool {
        let available_tokens = self
            .config
            .max_context_length
            .saturating_sub(self.config.response_buffer);
        self.total_tokens > available_tokens
    }

    /// Compress the context by removing older messages
    pub fn compress(&mut self) {
        let fitted = fit_messages_to_context(&self.get_all_messages(), self.config);
        self.clear();
        for message in fitted {
            let tokens = estimate_message_tokens(&message);
            self.push_message(message, tokens);
        }
    }

    /// Clear all context
    pub fn clear(&mut self) {
        self.history.clear();
        self.total_tokens = 0;
    }

    /// Get the number of messages in context
    pub fn len(&self) -> usize {
        self.history.len()
    }

    /// Check if context is empty
    pub fn is_empty(&self) -> bool {
        self.history.is_empty()
    }

    /// Build a compressed context, removing oldest messages until it fits
    pub fn build_context(&mut self) -> Vec<Message> {
        if self.needs_compression() {
            self.compress();
        }
        self.get_messages()
    }
}

/// Estimate token count for a string (rough approximation)
///
/// This uses a simple heuristic: ~4 characters per token on average.
/// For more accurate counting, a proper tokenizer like tiktoken would be needed.
pub fn estimate_tokens(text: &str) -> usize {
    // Rough estimate: ~4 characters per token for English text
    // This is a simplification but works reasonably well
    (text.len() as f32 / 4.0).ceil() as usize
}

/// Estimate tokens in a message
pub fn estimate_message_tokens(message: &Message) -> usize {
    let content_tokens = estimate_tokens(&message.content);

    // Add overhead for role and other fields
    let role_overhead = 4; // tokens for role indicator
    let tool_call_overhead = if message.tool_calls.is_some() { 10 } else { 0 };

    content_tokens + role_overhead + tool_call_overhead
}

/// Compress conversation history by summarizing or truncating
pub fn compress_conversation(messages: &[Message], max_tokens: usize) -> Result<Vec<Message>> {
    Ok(fit_messages_to_context(
        messages,
        ContextConfig {
            max_context_length: max_tokens,
            response_buffer: 0,
            ..ContextConfig::default()
        },
    ))
}

/// Fit messages into a context window while preserving leading system/context
/// messages and recent tail messages. When older middle history must be
/// removed, insert a reference-only compaction summary instead of silently
/// dropping it.
pub fn fit_messages_to_context(messages: &[Message], config: ContextConfig) -> Vec<Message> {
    let available_tokens = config
        .max_context_length
        .saturating_sub(config.response_buffer);
    if available_tokens == 0 || messages.is_empty() {
        return messages.to_vec();
    }

    let total_tokens: usize = messages.iter().map(estimate_message_tokens).sum();
    if total_tokens <= available_tokens {
        return messages.to_vec();
    }

    let mut leading = Vec::new();
    let mut leading_tokens = 0usize;
    let mut start = 0usize;
    while let Some(message) = messages.get(start) {
        if message.role != Role::System {
            break;
        }
        leading_tokens = leading_tokens.saturating_add(estimate_message_tokens(message));
        leading.push(message.clone());
        start += 1;
    }

    let remaining_budget = available_tokens.saturating_sub(leading_tokens);
    if remaining_budget == 0 {
        return leading;
    }

    let summary_reserve = summary_token_reserve(remaining_budget);
    let tail_budget = remaining_budget.saturating_sub(summary_reserve);
    let mut tail_start = messages.len();
    let mut tail_tokens = 0usize;
    for index in (start..messages.len()).rev() {
        let message = &messages[index];
        let tokens = estimate_message_tokens(message);
        if tail_tokens + tokens > tail_budget && tail_start < messages.len() {
            break;
        }
        tail_tokens += tokens;
        tail_start = index;
    }

    // Avoid sending orphan tool results whose assistant tool_call envelope was
    // compacted into the summary.
    while tail_start < messages.len() && messages[tail_start].role == Role::Tool {
        tail_start += 1;
    }

    if tail_start <= start {
        leading.extend(messages[start..].iter().cloned());
        return leading;
    }

    let middle = &messages[start..tail_start];
    let mut summary = build_compaction_summary(middle, summary_reserve * 4);

    let summary_role = choose_summary_role(
        leading.last().map(|message| &message.role),
        messages.get(tail_start).map(|message| &message.role),
    );
    summary.role = summary_role;

    leading.push(summary);
    leading.extend(messages[tail_start..].iter().cloned());

    trim_after_summary_to_budget(leading, available_tokens)
}

pub fn is_compressed_summary(message: &Message) -> bool {
    message
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get(COMPRESSED_SUMMARY_METADATA_KEY))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
        || message.content.starts_with(SUMMARY_PREFIX)
}

fn summary_token_reserve(remaining_budget: usize) -> usize {
    if remaining_budget <= 2 {
        return remaining_budget;
    }
    if remaining_budget < 128 {
        return (remaining_budget / 2).max(1);
    }
    (remaining_budget / 5).clamp(64, 3_000)
}

fn build_compaction_summary(messages: &[Message], max_chars: usize) -> Message {
    let mut lines = vec![
        SUMMARY_PREFIX.to_string(),
        String::new(),
        "## Historical Task Snapshot".to_string(),
        format!(
            "Compacted {} earlier message(s). They are reference-only and may describe completed or stale work.",
            messages.len()
        ),
        String::new(),
        "## Compacted Turns".to_string(),
    ];

    for (offset, message) in messages.iter().enumerate().rev() {
        lines.push(format!(
            "{}. {}",
            offset + 1,
            summarize_message_for_compaction(message)
        ));
    }

    lines.push(String::new());
    lines.push("## Active State".to_string());
    lines.push("Use current files, tool results, and the messages after this summary as the source of truth.".to_string());
    lines.push(String::new());
    lines.push(SUMMARY_END_MARKER.to_string());

    let max_chars = max_chars.clamp(512, SUMMARY_MAX_CHARS);
    Message::user(truncate_chars(&lines.join("\n"), max_chars))
        .with_metadata(COMPRESSED_SUMMARY_METADATA_KEY, json!(true))
}

fn summarize_message_for_compaction(message: &Message) -> String {
    match message.role {
        Role::System => format!("system context: {}", preview_text(&message.content, 180)),
        Role::User => format!("user said: {}", preview_text(&message.content, 220)),
        Role::Assistant => {
            let mut parts = Vec::new();
            let content = preview_text(&message.content, 180);
            if !content.is_empty() {
                parts.push(format!("assistant answered: {content}"));
            }
            if let Some(tool_calls) = &message.tool_calls {
                let tools = tool_calls
                    .iter()
                    .map(|tool_call| {
                        format!(
                            "{}({})",
                            tool_call.function.name,
                            preview_text(&tool_call.function.arguments, 100)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                if !tools.is_empty() {
                    parts.push(format!("requested tool(s): {tools}"));
                }
            }
            if parts.is_empty() {
                "assistant message".to_string()
            } else {
                parts.join("; ")
            }
        }
        Role::Tool => format!(
            "tool result call_id={}: {}",
            message.tool_call_id.as_deref().unwrap_or("unknown"),
            preview_text(&message.content, 220)
        ),
    }
}

fn preview_text(content: &str, max_chars: usize) -> String {
    truncate_chars(redact_sensitive_lines(content).trim(), max_chars).replace('\n', "\\n")
}

fn redact_sensitive_lines(content: &str) -> String {
    content
        .lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            let looks_sensitive = [
                "token",
                "secret",
                "password",
                "api_key",
                "apikey",
                "access_key",
            ]
            .iter()
            .any(|needle| lower.contains(needle));
            if looks_sensitive && (line.contains('=') || line.contains(':')) {
                "[REDACTED sensitive line]".to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn truncate_chars(content: &str, max_chars: usize) -> String {
    if content.chars().count() <= max_chars {
        return content.to_string();
    }
    let keep = max_chars.saturating_sub("...[truncated]".len());
    let mut truncated = content.chars().take(keep).collect::<String>();
    truncated.push_str("...[truncated]");
    truncated
}

fn choose_summary_role(previous: Option<&Role>, next: Option<&Role>) -> Role {
    let preferred = Role::User;
    if previous != Some(&preferred) && next != Some(&preferred) {
        return preferred;
    }
    Role::Assistant
}

fn trim_after_summary_to_budget(
    mut messages: Vec<Message>,
    available_tokens: usize,
) -> Vec<Message> {
    loop {
        let total: usize = messages.iter().map(estimate_message_tokens).sum();
        if total <= available_tokens {
            return messages;
        }
        let Some(summary_index) = messages.iter().position(is_compressed_summary) else {
            return messages;
        };
        let summary_tokens = estimate_message_tokens(&messages[summary_index]);
        let over_tokens = total.saturating_sub(available_tokens);
        if summary_tokens > over_tokens + 32
            && messages[summary_index].content.chars().count() > 512
        {
            let target_chars = messages[summary_index]
                .content
                .chars()
                .count()
                .saturating_sub(over_tokens.saturating_mul(4).saturating_add(64))
                .max(512);
            messages[summary_index].content =
                truncate_chars(&messages[summary_index].content, target_chars);
            continue;
        }
        if messages.len() <= summary_index + 3 {
            return messages;
        }
        messages.remove(summary_index + 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_estimation() {
        let text = "Hello, world! This is a test message.";
        let tokens = estimate_tokens(text);
        assert!(tokens > 0);
    }

    #[test]
    fn test_context_manager_add() {
        let config = ContextConfig::default();
        let mut ctx = ContextManager::new(config);

        ctx.add_message(Message::user("Hello"));
        assert_eq!(ctx.len(), 1);
        assert!(ctx.token_count() > 0);
    }

    #[test]
    fn test_context_manager_compression() {
        let config = ContextConfig {
            max_context_length: 50,
            response_buffer: 10,
            min_messages_preserve: 2,
            compression_ratio: 0.5,
        };
        let mut ctx = ContextManager::new(config);

        // Add several long messages to force compression
        for i in 0..10 {
            ctx.add_message(Message::user(format!(
                "This is a very long message number {} that should use many tokens when counted",
                i
            )));
        }

        assert!(ctx.len() > config.min_messages_preserve);
        let initial_len = ctx.len();

        ctx.compress();

        // Should have fewer messages after compression
        assert!(ctx.len() < initial_len);
    }

    #[test]
    fn test_compress_conversation() {
        let messages = vec![
            Message::system("You are a helpful assistant."),
            Message::user("Hello ".repeat(80)),
            Message::assistant("Hi there! ".repeat(80)),
            Message::user("How are you?"),
            Message::assistant("I'm doing great!"),
        ];

        let compressed = compress_conversation(&messages, 50).unwrap();

        assert!(!compressed.is_empty());
        assert!(
            compressed[0].role == Role::System || compressed.iter().any(|m| m.role == Role::System)
        );
        assert!(compressed.iter().any(is_compressed_summary));
    }

    #[test]
    fn fit_messages_to_context_preserves_leading_system_and_recent_tail() {
        let messages = vec![
            Message::system("system rules"),
            Message::system("turn context"),
            Message::user("old message ".repeat(100)),
            Message::assistant("old answer ".repeat(100)),
            Message::user("recent question"),
            Message::assistant("recent answer"),
        ];

        let fitted = fit_messages_to_context(
            &messages,
            ContextConfig {
                max_context_length: 80,
                response_buffer: 10,
                min_messages_preserve: 2,
                compression_ratio: 0.5,
            },
        );

        assert_eq!(fitted[0].role, Role::System);
        assert_eq!(fitted[1].role, Role::System);
        assert!(fitted
            .iter()
            .any(|message| message.content == "recent question"));
        assert!(fitted
            .iter()
            .any(|message| message.content == "recent answer"));
        assert!(!fitted
            .iter()
            .any(|message| message.content.starts_with("old message")));
    }

    #[test]
    fn fit_messages_to_context_inserts_reference_summary_for_middle_turns() {
        let messages = vec![
            Message::system("system rules"),
            Message::user("old user ".repeat(160)),
            Message::assistant("old assistant ".repeat(160)),
            Message::user("recent question"),
            Message::assistant("recent answer"),
        ];

        let fitted = fit_messages_to_context(
            &messages,
            ContextConfig {
                max_context_length: 180,
                response_buffer: 10,
                min_messages_preserve: 2,
                compression_ratio: 0.5,
            },
        );

        let summary = fitted
            .iter()
            .find(|message| is_compressed_summary(message))
            .expect("summary should be inserted");
        assert!(summary.content.contains("REFERENCE ONLY"));
        assert!(summary.content.contains("Historical Task Snapshot"));
        assert!(fitted
            .iter()
            .any(|message| message.content == "recent question"));
        assert!(fitted
            .iter()
            .any(|message| message.content == "recent answer"));
    }

    #[test]
    fn fit_messages_to_context_does_not_leave_orphan_tool_result_tail() {
        let messages = vec![
            Message::system("system rules"),
            Message::user("old user ".repeat(160)),
            Message::assistant("old assistant ".repeat(160)).with_tool_calls(vec![
                crate::client::ToolCall {
                    id: "call_1".to_string(),
                    function: crate::client::ToolCallFunction {
                        name: "terminal".to_string(),
                        arguments: "{\"command\":\"echo secret_token=abc\"}".to_string(),
                    },
                },
            ]),
            Message::tool("call_1", "secret_token=abc\nok"),
        ];

        let fitted = fit_messages_to_context(
            &messages,
            ContextConfig {
                max_context_length: 140,
                response_buffer: 10,
                min_messages_preserve: 2,
                compression_ratio: 0.5,
            },
        );

        assert!(!fitted.iter().any(|message| message.role == Role::Tool));
        let summary = fitted
            .iter()
            .find(|message| is_compressed_summary(message))
            .expect("tool result should be summarized");
        assert!(summary.content.contains("[REDACTED sensitive line]"));
    }
}
