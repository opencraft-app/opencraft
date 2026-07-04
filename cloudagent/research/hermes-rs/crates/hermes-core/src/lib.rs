//! # Agent Runtime Core Library
//!
//! A high-performance Rust implementation of an agent orchestration loop.
//! Supports asynchronous tool execution, streaming-first architecture, and
//! dynamic JSON-schema generation.
//!
//! ## Key Features
//!
//! - **Streaming-First**: Detect and execute tool calls incrementally from partial LLM outputs
//! - **Tool System**: 17+ built-in tools for file ops, terminal, web, code execution, memory, and more
//! - **Self-Healing**: Re-prompt LLM with error context on tool execution failures
//! - **Context Compression**: Automatic compression of long conversations to fit context window
//! - **Memory System**: Persistent file-backed memory with MEMORY.md/USER.md storage
//! - **Trajectory Saving**: Export conversation trajectories for RL training
//! - **Multi-Platform Gateway**: Support for Telegram, Discord, Slack, and more
//! - **MCP Client**: Model Context Protocol client (HTTP + stdio) for extended capabilities
//! - **Skills System**: Skill discovery, loading, and management from SKILL.md directories
//! - **Cross-Platform**: Windows (PowerShell/cmd), macOS, Linux with automatic shell detection
//! - **Structured Logging**: Comprehensive observability via the `tracing` crate
//!
//! ## Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────┐
//! │ AgentExecutor │
//! │ ┌─────────────┐ ┌──────────────┐ ┌────────────────────┐ │
//! │ │ OpenAI │ │ XMLParser │ │ ToolRegistry │ │
//! │ │ Client │ │ (Tolerant) │ │ & 17+ Tools │ │
//! │ └─────────────┘ └──────────────┘ └────────────────────┘ │
//! │ ┌─────────────────────────────────────────────────────────┐│
//! │ │ Orchestration Loop (ReAct) ││
//! │ │ Think → Plan → Execute Tools → Observe → Respond ││
//! │ └─────────────────────────────────────────────────────────┘│
//! │ ┌───────────────┐ ┌──────────────┐ ┌────────────────────┐│
//! │ │ Context Mgr │ │ Memory Mgr │ │ Trajectory Mgr ││
//! │ └───────────────┘ └──────────────┘ └────────────────────┘│
//! └─────────────────────────────────────────────────────────────┘
//! │                     Gateway & MCP Support                  │
//! └─────────────────────────────────────────────────────────────┘
//! ```

pub mod behavior;
pub mod client;
pub mod config;
pub mod context;
pub mod context_files;
pub mod distillation;
pub mod error;
pub mod events;
pub mod fork;
pub mod gateway;
pub mod hooks;
pub mod mcp;
pub mod memory;
pub mod parser;
pub mod platform;
pub mod policy;
pub mod runtime;
pub mod runtime_host;
pub mod schema;
pub mod session;
pub mod skills;
pub mod tools;
pub mod trajectory;
pub mod turn;
pub mod workspace;

pub use behavior::{BehaviorRegistry, BehaviorVersions, ResolvedBehavior, BUILTIN_V1};
pub use client::{Message, OpenAIClient};
pub use config::{
    install_runtime_config, load_app_config, runtime_config, AppConfig, AutonomousSettings,
    BehaviorSettings, ClientSettings, CodeExecutionSettings, E2BToolSettings, GatewaySettings,
    HttpToolSettings, LoadedConfig, LoggingSettings, McpServerConfig, McpSettings, SkillsSettings,
    TerminalSettings, ToolSettings, TuiSettings, WebToolSettings,
};
pub use context::{
    estimate_tokens, is_compressed_summary, ContextConfig, ContextManager,
    COMPRESSED_SUMMARY_METADATA_KEY,
};
pub use context_files::{
    load_context_dir, load_default_context_files, load_workspace_context, scan_context_content,
};
pub use distillation::distill_session_to_memory;
pub use error::{Error, Result};
pub use events::{AgentEvent, AgentEventSink, RuntimeHostEvent};
pub use fork::{ForkCommunication, ForkSpec, ForkedSession};
pub use gateway::{Gateway, GatewayConfig, PlatformAdapter};
pub use mcp::{McpClient, McpStdioClient, McpTool, McpTransport};
pub use memory::{MemoryBlock, MemoryManager, Session, UserProfile};
pub use parser::ToolCallParser;
pub use platform::PlatformInfo;
pub use policy::{GateDecision, ToolNameGateHook};
pub use runtime::{
    agent::{AgentConfig, AgentExecutor, AgentExecutorBuilder},
    store::{RuntimeStore, RuntimeStoreLoad, RuntimeStoreSnapshot},
    AgentActor, AgentRuntime, AgentStatus, InboxMode, QueuedRun, RunRecord, RunRecordStatus,
    RunTurnRequest, RunTurnResult,
};
pub use session::{AgentSession, TranscriptBlock, TranscriptEntry, TranscriptRole};
pub use skills::{
    Skill, SkillActivation, SkillActivationReason, SkillCatalog, SkillInjectionPlan,
    SkillInjectionPoint, SkillManager, SkillResolver, SkillSelection,
};
pub use tools::{
    register_builtin_tools, register_builtin_tools_with_sub_agent, BuiltinToolProvider,
    ToolHandler, ToolProvider, ToolRegistry, ToolResult, ToolRouter,
};
pub use trajectory::{Trajectory, TrajectoryBuilder, TrajectoryExporter};
