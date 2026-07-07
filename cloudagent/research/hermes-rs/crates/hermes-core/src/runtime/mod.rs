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
mod system_prompt;
mod tool_calls;
mod tool_loop;
mod transcript;

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::behavior::{BehaviorRegistry, BehaviorVersions, ResolvedBehavior};
use crate::client::{Message, Role};
use crate::error::Result;
use crate::events::{AgentEvent, AgentEventSink};
use crate::runtime::agent::AgentExecutor;
use crate::runtime::store::RuntimeStore;
use crate::session::{AgentSession, TranscriptRole};
use crate::skills::SkillSelection;
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
    #[serde(default)]
    pub skills: SkillSelection,
}

impl RunTurnRequest {
    pub fn new(session_id: impl Into<String>, prompt: impl Into<String>) -> Self {
        Self {
            run_id: None,
            session_id: session_id.into(),
            prompt: prompt.into(),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            versions: BehaviorVersions::default(),
            skills: SkillSelection::default(),
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

    pub async fn seed_history_if_empty(&self, messages: Vec<Message>) -> Result<usize> {
        let restored_messages: Vec<Message> = messages
            .into_iter()
            .filter(|message| {
                matches!(message.role, Role::System | Role::User | Role::Assistant)
                    && !message.content.trim().is_empty()
            })
            .collect();
        if restored_messages.is_empty() {
            return Ok(0);
        }

        let existing = self.agent.conversation().await;
        if existing.iter().any(|message| {
            matches!(message.role, Role::User | Role::Assistant)
                && !message.content.trim().is_empty()
        }) {
            return Ok(0);
        }

        {
            let mut session = self.session.lock().await;
            let has_visible_transcript = session.transcript.iter().any(|entry| {
                matches!(entry.role, TranscriptRole::User | TranscriptRole::Assistant)
                    && entry.blocks.iter().any(|block| match block {
                        crate::session::TranscriptBlock::Text { text }
                        | crate::session::TranscriptBlock::Reasoning { text } => {
                            !text.trim().is_empty()
                        }
                        _ => false,
                    })
            });
            if has_visible_transcript {
                self.agent
                    .replace_history(crate::runtime::transcript::transcript_to_messages(
                        &session.transcript,
                    ))
                    .await;
                return Ok(0);
            }
            for (index, message) in restored_messages.iter().enumerate() {
                let role = match message.role {
                    Role::System => TranscriptRole::System,
                    Role::User => TranscriptRole::User,
                    Role::Assistant => TranscriptRole::Assistant,
                    Role::Tool => continue,
                };
                session.append_restored_message(role, message.content.clone(), index + 1);
            }
        }
        self.agent.replace_history(restored_messages.clone()).await;
        self.persist_state().await?;
        Ok(restored_messages.len())
    }

    pub async fn shutdown(&self) {
        self.agent.shutdown().await;
    }

    pub async fn shutdown_inner_runtime(&self) {
        self.agent.shutdown_inner_runtime().await;
    }

    pub async fn shutdown_inner_runtime_with_event_sink(
        &self,
        sink: AgentEventSink,
    ) -> Vec<AgentEvent> {
        self.agent
            .shutdown_inner_runtime_with_event_sink(sink.clone())
            .await;
        sink.events().await
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

    pub async fn upload_session_sandbox_file(
        &self,
        workspace_path: &str,
        content: Vec<u8>,
    ) -> Result<bool> {
        self.agent
            .upload_session_sandbox_file(workspace_path, content)
            .await
    }

    pub async fn download_session_sandbox_file(
        &self,
        workspace_path: &str,
    ) -> Result<Option<Vec<u8>>> {
        self.agent
            .download_session_sandbox_file(workspace_path)
            .await
    }

    pub async fn ensure_session_sandbox_envd_identity(
        &self,
        force: bool,
    ) -> Result<crate::runtime_host::SessionSandboxEnvdIdentity> {
        self.agent.ensure_session_sandbox_envd_identity(force).await
    }

    pub async fn bind_session_sandbox(
        &self,
        binding: crate::runtime_host::SessionSandboxBinding,
        replace_existing: bool,
    ) -> Result<crate::runtime_host::SessionSandboxEnvdIdentity> {
        self.agent
            .bind_session_sandbox(binding, replace_existing)
            .await
    }

    pub async fn test_tool_context(&self) -> Result<crate::tools::ToolContext> {
        self.agent.test_tool_context().await
    }
}
