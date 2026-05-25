//! Agent executor loop with self-healing
//!
//! Implements the ReAct (Reason + Act) pattern for LLM-driven tool execution.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, RwLock};
use tracing::{debug, error, info, instrument, warn};

use crate::client::{Message, OpenAIClient};
use crate::config::{runtime_config, BehaviorSettings};
use crate::error::{Error, Result};
use crate::events::{AgentEvent, AgentEventSink};
use crate::hooks::{GateHook, NoopGateHook, PromptTransformHook};
use crate::memory::MemoryManager;
use crate::runtime::tool_loop::check_cancelled;
use crate::runtime_host::{session_id, SessionSandbox};
use crate::tools::ToolRegistry;
use crate::turn::TurnContext;

/// Configuration for the agent executor.
#[derive(Debug, Clone)]
pub struct AgentConfig {
    /// Model to use (e.g., "gpt-4", "gpt-3.5-turbo")
    pub model: String,
    /// Maximum iterations before giving up
    pub max_iterations: usize,
    /// Timeout for tool execution
    pub tool_timeout: Duration,
    /// Timeout for LLM requests
    pub request_timeout: Duration,
    /// System prompt for the agent
    pub system_prompt: Option<String>,
    /// Whether to stream responses
    pub stream: bool,
    /// Context window size for truncation
    pub context_window: usize,
    /// Max self-healing attempts on tool errors
    pub max_healing_attempts: usize,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self::from(&runtime_config().agent)
    }
}

impl From<&BehaviorSettings> for AgentConfig {
    fn from(settings: &BehaviorSettings) -> Self {
        Self {
            model: settings.model.clone(),
            max_iterations: settings.max_iterations,
            tool_timeout: Duration::from_secs(settings.tool_timeout_secs),
            request_timeout: Duration::from_secs(settings.request_timeout_secs),
            system_prompt: settings.system_prompt.clone(),
            stream: settings.stream,
            context_window: settings.context_window,
            max_healing_attempts: settings.max_healing_attempts,
        }
    }
}

/// Agent executor for tool orchestration.
pub struct AgentExecutor {
    pub(super) config: AgentConfig,
    pub(super) client: OpenAIClient,
    pub(super) registry: ToolRegistry,
    pub(super) conversation: Arc<RwLock<Vec<Message>>>,
    pub(super) event_sink: Arc<RwLock<Option<AgentEventSink>>>,
    pub(super) memory_manager: Option<MemoryManager>,
    pub(super) session_sandbox: Arc<RwLock<Option<Arc<SessionSandbox>>>>,
    pub(super) session_id: String,
    pub(super) gate_hook: Arc<dyn GateHook>,
    pub(super) prompt_transform_hooks: Vec<Arc<dyn PromptTransformHook>>,
}

impl AgentExecutor {
    /// Create a new agent executor.
    pub fn new(config: AgentConfig, client: OpenAIClient, registry: ToolRegistry) -> Self {
        Self {
            config,
            client,
            registry,
            conversation: Arc::new(RwLock::new(Vec::new())),
            event_sink: Arc::new(RwLock::new(None)),
            memory_manager: None,
            session_sandbox: Arc::new(RwLock::new(None)),
            session_id: session_id(),
            gate_hook: Arc::new(NoopGateHook),
            prompt_transform_hooks: Vec::new(),
        }
    }

    /// Create with event channel for streaming events
    pub fn with_events(
        config: AgentConfig,
        client: OpenAIClient,
        registry: ToolRegistry,
        event_tx: mpsc::Sender<AgentEvent>,
    ) -> Self {
        Self {
            config,
            client,
            registry,
            conversation: Arc::new(RwLock::new(Vec::new())),
            event_sink: Arc::new(RwLock::new(Some(AgentEventSink::forwarding(event_tx)))),
            memory_manager: None,
            session_sandbox: Arc::new(RwLock::new(None)),
            session_id: session_id(),
            gate_hook: Arc::new(NoopGateHook),
            prompt_transform_hooks: Vec::new(),
        }
    }

    /// Attach a memory manager for long-term memory injection and session distillation.
    pub fn with_memory_manager(mut self, memory_manager: MemoryManager) -> Self {
        self.memory_manager = Some(memory_manager);
        self
    }

    pub fn with_gate_hook(mut self, gate_hook: Arc<dyn GateHook>) -> Self {
        self.gate_hook = gate_hook;
        self
    }

    pub fn with_prompt_transform_hook(mut self, hook: Arc<dyn PromptTransformHook>) -> Self {
        self.prompt_transform_hooks.push(hook);
        self
    }

    /// Send an event to the channel
    pub(super) async fn emit(&self, event: AgentEvent) {
        let sink = self.event_sink.read().await.clone();
        if let Some(sink) = sink {
            sink.emit(event).await;
        }
    }

    pub async fn event_forwarder(&self) -> Option<mpsc::Sender<AgentEvent>> {
        self.event_sink
            .read()
            .await
            .as_ref()
            .and_then(AgentEventSink::forwarder)
    }

    pub async fn run_with_event_sink(
        &self,
        user_query: String,
        sink: AgentEventSink,
        cancel: Option<Arc<AtomicBool>>,
        turn: Option<TurnContext>,
    ) -> Result<Message> {
        let previous = {
            let mut current = self.event_sink.write().await;
            current.replace(sink)
        };
        let result = self.run_cancelable(user_query, cancel, turn).await;
        {
            let mut current = self.event_sink.write().await;
            *current = previous;
        }
        result
    }

    /// Add a message to the conversation history
    pub async fn add_message(&self, message: Message) {
        let mut conv = self.conversation.write().await;
        conv.push(message);
    }

    /// Add a user message
    pub async fn user_message(&self, content: impl Into<String>) {
        self.add_message(Message::user(content)).await;
    }

    /// Get current conversation
    pub async fn conversation(&self) -> Vec<Message> {
        self.conversation.read().await.clone()
    }

    /// Clear conversation history
    pub async fn clear_history(&self) {
        let mut conv = self.conversation.write().await;
        conv.clear();
        drop(conv);
        self.shutdown().await;
    }

    /// Replace conversation history without changing the live session sandbox.
    pub async fn replace_history(&self, messages: Vec<Message>) {
        let mut conv = self.conversation.write().await;
        *conv = messages;
    }

    pub async fn shutdown(&self) {
        self.shutdown_session_sandbox().await;
    }

    pub async fn shutdown_with_event_sink(&self, sink: AgentEventSink) {
        let previous = {
            let mut current = self.event_sink.write().await;
            current.replace(sink)
        };
        self.shutdown().await;
        {
            let mut current = self.event_sink.write().await;
            *current = previous;
        }
    }

    /// Run the agent with a user query
    #[instrument(skip(self), fields(model = % self.config.model))]
    pub async fn run(&self, user_query: String) -> Result<Message> {
        self.run_cancelable(user_query, None, None).await
    }

    async fn run_cancelable(
        &self,
        user_query: String,
        cancel: Option<Arc<AtomicBool>>,
        turn: Option<TurnContext>,
    ) -> Result<Message> {
        info!("Starting agent run");
        let turn = turn.unwrap_or_else(|| self.synthetic_turn_context(&user_query));
        let user_query = self.apply_prompt_transforms(user_query, &turn).await?;

        // Add user message
        self.add_message(Message::user(&user_query)).await;

        // Build initial messages including system prompt
        let mut messages = self.build_messages().await?;
        let mut iteration = 0;

        loop {
            check_cancelled(cancel.as_ref())?;
            iteration += 1;
            debug!(iteration, "Agent iteration");

            if iteration > self.config.max_iterations {
                error!(max = self.config.max_iterations, "Max iterations exceeded");
                return Err(Error::MaxIterationsExceeded {
                    max: self.config.max_iterations,
                });
            }

            // Emit thinking event
            self.emit(AgentEvent::Thinking {
                content: format!(
                    "Iteration {}/{}: Requesting LLM response...",
                    iteration, self.config.max_iterations
                ),
            })
            .await;

            // Get tool schemas
            let tools = self.registry.get_schemas().await;

            let response = if self.config.stream {
                let stream = self
                    .client
                    .chat_streaming(&self.config.model, &messages, Some(&tools))
                    .await?;
                self.process_stream(stream, cancel.clone()).await
            } else {
                check_cancelled(cancel.as_ref())?;
                let response = self
                    .client
                    .chat(&self.config.model, &messages, Some(&tools))
                    .await?;
                check_cancelled(cancel.as_ref())?;
                self.process_response(response).await
            };

            match response {
                Ok((response_text, reasoning_text, tool_calls)) => {
                    // Add assistant message to conversation
                    let mut assistant_msg = Message::assistant(&response_text);
                    if !reasoning_text.is_empty() {
                        assistant_msg = assistant_msg.with_reasoning(reasoning_text);
                    }
                    if !tool_calls.is_empty() {
                        assistant_msg = assistant_msg.with_tool_calls(tool_calls.clone());
                    }

                    messages.push(assistant_msg.clone());
                    self.add_message(assistant_msg.clone()).await;

                    // If no tool calls, we're done
                    if tool_calls.is_empty() {
                        let result = assistant_msg.clone();
                        self.spawn_session_distillation(messages.clone());
                        self.emit(AgentEvent::Done {
                            message: assistant_msg,
                        })
                        .await;
                        return Ok(result);
                    }

                    // Execute tools and add results
                    check_cancelled(cancel.as_ref())?;
                    let tool_results = self.execute_tools(tool_calls, cancel.clone()).await?;
                    check_cancelled(cancel.as_ref())?;

                    for (name, result) in &tool_results {
                        if result.success {
                            self.emit(AgentEvent::ToolComplete {
                                tool_call_id: result.tool_call_id.clone(),
                                name: name.clone(),
                                result: result.clone(),
                            })
                            .await;
                        } else {
                            self.emit(AgentEvent::ToolError {
                                tool_call_id: result.tool_call_id.clone(),
                                name: name.clone(),
                                error: result.error.clone().unwrap_or_default(),
                            })
                            .await;
                        }
                    }

                    // Add tool results to messages
                    for (_, result) in tool_results {
                        let tool_message = Message::tool(
                            &result.tool_call_id,
                            if result.success {
                                &result.content
                            } else {
                                result.error.as_deref().unwrap_or("Error")
                            },
                        );
                        messages.push(tool_message.clone());
                        self.add_message(tool_message).await;
                    }
                }
                Err(e) => {
                    error!(error = %e, "Error processing stream");
                    self.emit(AgentEvent::Error {
                        error: e.to_string(),
                    })
                    .await;
                    return Err(e);
                }
            }

            self.emit(AgentEvent::IterationComplete { iteration }).await;
        }
    }

    /// Run agent and handle self-healing on tool errors
    pub async fn run_with_healing(&self, user_query: String) -> Result<Message> {
        let mut iteration = 0;
        let max_healing_attempts = self.config.max_healing_attempts;

        loop {
            iteration += 1;

            match self.run(user_query.clone()).await {
                Ok(response) => return Ok(response),
                Err(e) if e.is_self_healing() && iteration <= max_healing_attempts => {
                    warn!(iteration, error = %e, "Self-healing: re-prompting LLM");

                    // Add error context as a system message
                    let error_msg = format!(
                        "Note: The previous attempt encountered an error: {}. \
                        Please correct your approach and try again.",
                        e.user_message()
                    );

                    self.add_message(Message::system(&error_msg)).await;
                }
                Err(e) => {
                    error!(error = %e, "Agent run failed");
                    return Err(e);
                }
            }
        }
    }
}

/// Builder for creating an AgentExecutor.
pub struct AgentExecutorBuilder {
    config: AgentConfig,
    client: Option<OpenAIClient>,
    registry: Option<ToolRegistry>,
    memory_manager: Option<MemoryManager>,
    gate_hook: Option<Arc<dyn GateHook>>,
    prompt_transform_hooks: Vec<Arc<dyn PromptTransformHook>>,
}

impl AgentExecutorBuilder {
    pub fn new() -> Self {
        Self {
            config: AgentConfig::default(),
            client: None,
            registry: None,
            memory_manager: None,
            gate_hook: None,
            prompt_transform_hooks: Vec::new(),
        }
    }

    /// Set the model
    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.config.model = model.into();
        self
    }

    /// Set maximum iterations
    pub fn max_iterations(mut self, max: usize) -> Self {
        self.config.max_iterations = max;
        self
    }

    /// Set tool timeout
    pub fn tool_timeout(mut self, timeout: Duration) -> Self {
        self.config.tool_timeout = timeout;
        self
    }

    /// Set request timeout
    pub fn request_timeout(mut self, timeout: Duration) -> Self {
        self.config.request_timeout = timeout;
        self
    }

    /// Set system prompt
    pub fn system_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.config.system_prompt = Some(prompt.into());
        self
    }

    /// Enable/disable streaming
    pub fn streaming(mut self, enabled: bool) -> Self {
        self.config.stream = enabled;
        self
    }

    /// Set the OpenAI client
    pub fn client(mut self, client: OpenAIClient) -> Self {
        self.client = Some(client);
        self
    }

    /// Set the tool registry
    pub fn registry(mut self, registry: ToolRegistry) -> Self {
        self.registry = Some(registry);
        self
    }

    /// Set the long-term memory manager.
    pub fn memory_manager(mut self, memory_manager: MemoryManager) -> Self {
        self.memory_manager = Some(memory_manager);
        self
    }

    pub fn gate_hook(mut self, gate_hook: Arc<dyn GateHook>) -> Self {
        self.gate_hook = Some(gate_hook);
        self
    }

    pub fn prompt_transform_hook(mut self, hook: Arc<dyn PromptTransformHook>) -> Self {
        self.prompt_transform_hooks.push(hook);
        self
    }

    /// Build the agent
    pub fn build(self) -> Result<AgentExecutor> {
        let client = self.client.unwrap_or_else(|| {
            OpenAIClient::from_env()
                .unwrap_or_else(|_| OpenAIClient::new(crate::client::ClientConfig::default()))
        });

        let registry = self
            .registry
            .unwrap_or_else(|| ToolRegistry::new(self.config.tool_timeout));

        let mut agent = AgentExecutor::new(self.config, client, registry);
        if let Some(memory_manager) = self.memory_manager {
            agent = agent.with_memory_manager(memory_manager);
        }
        if let Some(gate_hook) = self.gate_hook {
            agent = agent.with_gate_hook(gate_hook);
        }
        for hook in self.prompt_transform_hooks {
            agent = agent.with_prompt_transform_hook(hook);
        }

        Ok(agent)
    }
}

impl Default for AgentExecutorBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use crate::client::ToolCall;
    use crate::tools::{ToolContext, ToolResult};

    use super::*;

    #[test]
    fn test_default_config() {
        let config = AgentConfig::default();
        assert_eq!(config.model, "gpt-4");
        assert_eq!(config.max_iterations, 20);
    }

    #[tokio::test]
    async fn test_agent_builder() {
        let _agent = AgentExecutorBuilder::new()
            .model("gpt-3.5-turbo")
            .max_iterations(10)
            .build()
            .unwrap();

        // If we reach here, the agent was created successfully
    }

    #[tokio::test]
    async fn build_messages_injects_long_term_memory() {
        let memory_manager = MemoryManager::new();
        memory_manager
            .store(
                crate::memory::MemoryBlock::new("fact1", "fact", "User prefers concise answers")
                    .importance(80),
            )
            .await;

        let agent = AgentExecutor::new(
            AgentConfig::default(),
            OpenAIClient::new(crate::client::ClientConfig::default()),
            ToolRegistry::new(Duration::from_secs(1)),
        )
        .with_memory_manager(memory_manager);

        let messages = agent.build_messages().await.unwrap();
        let system = messages
            .first()
            .map(|message| message.content.as_str())
            .unwrap_or_default();

        assert!(system.contains("<long_term_memory>"));
        assert!(system.contains("[fact] User prefers concise answers"));
        assert!(system.contains("</long_term_memory>"));
    }

    #[tokio::test]
    async fn build_messages_preserves_tool_call_result_adjacency() {
        let agent = AgentExecutor::new(
            AgentConfig::default(),
            OpenAIClient::new(crate::client::ClientConfig::default()),
            ToolRegistry::new(Duration::from_secs(1)),
        );

        agent.add_message(Message::user("what day is it?")).await;
        agent
            .add_message(Message::assistant("").with_tool_calls(vec![ToolCall {
                id: "call_datetime_1".to_string(),
                function: crate::client::ToolCallFunction {
                    name: "datetime".to_string(),
                    arguments: "{}".to_string(),
                },
            }]))
            .await;
        agent
            .add_message(Message::tool(
                "call_datetime_1",
                "{\"date\":\"2026-05-18\"}",
            ))
            .await;
        agent
            .add_message(Message::assistant("Today is Monday."))
            .await;

        let messages = agent.build_messages().await.unwrap();
        let tool_call_index = messages
            .iter()
            .position(|message| message.tool_calls.is_some())
            .expect("missing assistant tool call");
        let tool_result = messages
            .get(tool_call_index + 1)
            .expect("missing tool result after assistant tool call");

        assert_eq!(tool_result.role, crate::client::Role::Tool);
        assert_eq!(tool_result.tool_call_id.as_deref(), Some("call_datetime_1"));
    }

    struct AppendPromptHook;

    #[async_trait::async_trait]
    impl crate::hooks::PromptTransformHook for AppendPromptHook {
        async fn transform_prompt(
            &self,
            prompt: String,
            _turn: &crate::turn::TurnContext,
        ) -> crate::Result<String> {
            Ok(format!("{prompt}\n\nhooked"))
        }
    }

    #[tokio::test]
    async fn prompt_transform_hook_is_applied_before_user_message() {
        let agent = AgentExecutor::new(
            AgentConfig::default(),
            OpenAIClient::new(crate::client::ClientConfig::default()),
            ToolRegistry::new(Duration::from_secs(1)),
        )
        .with_prompt_transform_hook(Arc::new(AppendPromptHook));

        let turn = agent.synthetic_turn_context("hello");
        let prompt = agent
            .apply_prompt_transforms("hello".to_string(), &turn)
            .await
            .unwrap();

        assert_eq!(prompt, "hello\n\nhooked");
    }

    struct CountingTool {
        count: Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl crate::tools::ToolHandler for CountingTool {
        fn name(&self) -> &str {
            "counting"
        }

        fn description(&self) -> &str {
            "counts executions"
        }

        fn schema(&self) -> crate::schema::ToolSchema {
            crate::schema::ToolSchema::new(
                "counting",
                "counts executions",
                serde_json::json!({ "type": "object", "properties": {} }),
            )
        }

        async fn execute(&self, _args: serde_json::Value, _context: ToolContext) -> ToolResult {
            self.count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            ToolResult::success("", serde_json::json!({ "ok": true }))
        }
    }

    #[tokio::test]
    async fn executor_tool_gate_denies_before_handler_execution() {
        let registry = ToolRegistry::new(Duration::from_secs(1));
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        registry
            .register(CountingTool {
                count: count.clone(),
            })
            .await
            .unwrap();
        let agent = AgentExecutor::new(
            AgentConfig::default(),
            OpenAIClient::new(crate::client::ClientConfig::default()),
            registry,
        )
        .with_gate_hook(Arc::new(crate::policy::ToolNameGateHook::deny_tools([
            "counting",
        ])));

        let results = agent
            .execute_tools(
                vec![ToolCall {
                    id: "call_counting_1".to_string(),
                    function: crate::client::ToolCallFunction {
                        name: "counting".to_string(),
                        arguments: "{}".to_string(),
                    },
                }],
                None,
            )
            .await
            .unwrap();

        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(results.len(), 1);
        assert!(!results[0].1.success);
        assert!(results[0]
            .1
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("denied by policy"));
    }
}
