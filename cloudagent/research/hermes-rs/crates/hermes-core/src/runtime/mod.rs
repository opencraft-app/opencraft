//! Agent runtime kernel.
//!
//! The runtime owns the agent actor/inbox/pump lifecycle and drives the
//! ReAct executor through queued inbox items.

mod actor;
pub mod agent;
mod distillation;
mod ids;
mod prompt_context;
mod pump;
mod reasoning;
mod restore;
mod sandbox_context;
pub mod store;
mod stream;
mod tool_calls;
mod tool_loop;
mod transcript;

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::behavior::{BehaviorRegistry, BehaviorVersions, ResolvedBehavior};
use crate::client::Message;
use crate::error::Result;
use crate::events::{AgentEvent, AgentEventSink};
use crate::runtime::agent::AgentExecutor;
use crate::runtime::store::RuntimeStore;
use crate::session::AgentSession;
use serde::{Deserialize, Serialize};

pub use actor::{
    AgentActor, AgentStatus, InboxMode, QueuedRun, RunRecord, RunRecordStatus, RuntimeInbox,
    StoredQueuedRun,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunTurnRequest {
    pub run_id: Option<String>,
    pub session_id: String,
    pub prompt: String,
    pub cwd: PathBuf,
    pub versions: BehaviorVersions,
}

impl RunTurnRequest {
    pub fn new(session_id: impl Into<String>, prompt: impl Into<String>) -> Self {
        Self {
            run_id: None,
            session_id: session_id.into(),
            prompt: prompt.into(),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            versions: BehaviorVersions::default(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RunTurnResult {
    pub final_message: Message,
    pub events: Vec<AgentEvent>,
    pub resolved_behavior: ResolvedBehavior,
}

pub struct AgentRuntime {
    agent: AgentExecutor,
    actor: Mutex<AgentActor>,
    session: Mutex<AgentSession>,
    behavior_registry: BehaviorRegistry,
    pump_lock: Mutex<()>,
    active_cancel: Mutex<Option<ActiveRunCancel>>,
    store: Option<RuntimeStore>,
}

#[derive(Clone)]
pub(crate) struct ActiveRunCancel {
    run_id: String,
    flag: Arc<AtomicBool>,
}

impl AgentRuntime {
    pub fn new(agent: AgentExecutor, session: AgentSession) -> Self {
        Self {
            agent,
            actor: Mutex::new(AgentActor::default()),
            session: Mutex::new(session),
            behavior_registry: BehaviorRegistry,
            pump_lock: Mutex::new(()),
            active_cancel: Mutex::new(None),
            store: None,
        }
    }

    pub fn from_agent(agent: AgentExecutor) -> Self {
        Self::new(
            agent,
            AgentSession::new(
                crate::runtime_host::session_id(),
                std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            ),
        )
    }

    pub fn with_store(mut self, store: RuntimeStore) -> Self {
        self.store = Some(store);
        self
    }

    pub async fn actor_status(&self) -> AgentStatus {
        self.actor.lock().await.status()
    }

    pub async fn active_run_id(&self) -> Option<String> {
        self.actor.lock().await.active_run_id()
    }

    pub async fn run_ledger_snapshot(&self) -> Vec<RunRecord> {
        self.actor.lock().await.run_ledger()
    }

    pub async fn inbox_depths(&self) -> (usize, usize, usize) {
        self.actor.lock().await.inbox_depths()
    }

    pub async fn session_snapshot(&self) -> AgentSession {
        self.session.lock().await.clone()
    }

    pub async fn add_message(&self, message: Message) {
        self.agent.add_message(message).await;
    }

    pub async fn user_message(&self, content: impl Into<String>) {
        self.agent.user_message(content).await;
    }

    pub async fn conversation(&self) -> Vec<Message> {
        self.agent.conversation().await
    }

    pub async fn clear_history(&self) {
        self.agent.clear_history().await;
    }

    pub async fn replace_history(&self, messages: Vec<Message>) {
        self.agent.replace_history(messages).await;
    }

    pub async fn shutdown(&self) {
        self.agent.shutdown().await;
    }

    pub async fn shutdown_with_event_sink(&self, sink: AgentEventSink) -> Vec<AgentEvent> {
        self.agent.shutdown_with_event_sink(sink.clone()).await;
        sink.events().await
    }

    pub async fn has_session_sandbox(&self) -> bool {
        self.agent.has_session_sandbox().await
    }

    pub async fn session_sandbox_id(&self) -> Option<String> {
        self.agent.session_sandbox_id().await
    }

    pub async fn ensure_session_sandbox_envd_identity(
        &self,
        force: bool,
    ) -> Result<crate::runtime_host::SessionSandboxEnvdIdentity> {
        self.agent.ensure_session_sandbox_envd_identity(force).await
    }

    pub async fn test_tool_context(&self) -> Result<crate::tools::ToolContext> {
        self.agent.test_tool_context().await
    }
}
