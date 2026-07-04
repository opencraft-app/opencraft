use std::collections::VecDeque;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::behavior::ResolvedBehavior;
use crate::error::{Error, Result};

use super::{ids::now_ms, RunTurnRequest, RunTurnResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Idle,
    Queued,
    Running,
    Aborting,
    Stopping,
    Errored,
}

#[cfg(test)]
mod tests {
    use crate::behavior::{ResolvedBehavior, BUILTIN_V1};
    use crate::runtime::{InboxMode, RunTurnRequest};

    use super::*;

    fn queued_run(mode: InboxMode, prompt: &str) -> QueuedRun {
        QueuedRun {
            run_id: format!("run_{prompt}"),
            turn_id: format!("turn_{prompt}"),
            mode,
            request: RunTurnRequest {
                run_id: None,
                session_id: "session_1".to_string(),
                prompt: prompt.to_string(),
                cwd: std::path::PathBuf::from("."),
                versions: crate::behavior::BehaviorVersions::default(),
                skills: Default::default(),
            },
            resolved_behavior: ResolvedBehavior {
                agent_version: BUILTIN_V1.to_string(),
                workspace_version: BUILTIN_V1.to_string(),
                agent_template_id: None,
                workspace_template_id: None,
            },
            completion: None,
        }
    }

    #[test]
    fn inbox_pops_steer_before_prompt_before_follow_up() {
        let mut inbox = RuntimeInbox::default();
        inbox.push_run(queued_run(InboxMode::FollowUp, "later"));
        inbox.push_run(queued_run(InboxMode::Prompt, "normal"));
        inbox.push_run(queued_run(InboxMode::Steer, "now"));

        assert_eq!(
            inbox.pop_run().map(|run| run.request.prompt),
            Some("now".to_string())
        );
        assert_eq!(
            inbox.pop_run().map(|run| run.request.prompt),
            Some("normal".to_string())
        );
        assert_eq!(
            inbox.pop_run().map(|run| run.request.prompt),
            Some("later".to_string())
        );
        assert!(inbox.pop_run().is_none());
    }

    #[test]
    fn steer_marks_active_run_aborting_and_queues_next() {
        let mut actor = AgentActor::default();
        actor.enqueue_run(queued_run(InboxMode::Prompt, "active"));
        let active = actor.begin_next_run().expect("active run");
        assert_eq!(actor.status(), AgentStatus::Running);

        actor.enqueue_run(queued_run(InboxMode::Steer, "change_course"));

        assert_eq!(actor.status(), AgentStatus::Aborting);
        let ledger = actor.run_ledger();
        assert_eq!(
            ledger
                .iter()
                .find(|record| record.run_id == active.run_id)
                .map(|record| &record.status),
            Some(&RunRecordStatus::Aborting)
        );
        assert_eq!(actor.inbox_depths(), (1, 0, 0));
    }

    #[test]
    fn abort_can_clear_pending_inputs() {
        let mut actor = AgentActor::default();
        actor.enqueue_run(queued_run(InboxMode::Prompt, "active"));
        let active = actor.begin_next_run().expect("active run");
        actor.enqueue_run(queued_run(InboxMode::Prompt, "normal"));
        actor.enqueue_run(queued_run(InboxMode::FollowUp, "later"));

        let dropped = actor.abort_active(true);

        assert_eq!(dropped.len(), 2);
        assert_eq!(actor.inbox_depths(), (0, 0, 0));
        assert_eq!(
            actor
                .run_ledger()
                .iter()
                .find(|record| record.run_id == active.run_id)
                .map(|record| &record.status),
            Some(&RunRecordStatus::Aborting)
        );
        let ledger = actor.run_ledger();
        assert_eq!(
            ledger
                .iter()
                .filter(|record| record.status == RunRecordStatus::Canceled)
                .count(),
            2
        );
    }

    #[test]
    fn run_ledger_records_timing_transitions() {
        let mut actor = AgentActor::default();
        actor.enqueue_run(queued_run(InboxMode::Prompt, "one"));

        let queued = actor.run_ledger();
        assert!(queued[0].created_at_ms > 0);
        assert!(queued[0].started_at_ms.is_none());
        assert!(queued[0].completed_at_ms.is_none());

        let run = actor.begin_next_run().expect("run starts");
        actor.complete_run(&run.run_id);
        let completed = actor.run_ledger();
        assert_eq!(completed[0].status, RunRecordStatus::Succeeded);
        assert!(completed[0].started_at_ms.is_some());
        assert!(completed[0].completed_at_ms.is_some());
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxMode {
    Prompt,
    Steer,
    FollowUp,
}

impl InboxMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Steer => "steer",
            Self::FollowUp => "follow_up",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunRecordStatus {
    Queued,
    Running,
    Aborting,
    Succeeded,
    Failed,
    Canceled,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub run_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub source: String,
    pub inbox_mode: InboxMode,
    pub status: RunRecordStatus,
    #[serde(default)]
    pub created_at_ms: u128,
    #[serde(default)]
    pub started_at_ms: Option<u128>,
    #[serde(default)]
    pub completed_at_ms: Option<u128>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub blocked_reason: Option<String>,
    #[serde(default)]
    pub reconciled_reason: Option<String>,
}

pub struct QueuedRun {
    pub run_id: String,
    pub turn_id: String,
    pub mode: InboxMode,
    pub request: RunTurnRequest,
    pub resolved_behavior: ResolvedBehavior,
    pub(super) completion: Option<oneshot::Sender<Result<RunTurnResult>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredQueuedRun {
    pub run_id: String,
    pub turn_id: String,
    pub mode: InboxMode,
    pub request: RunTurnRequest,
}

#[derive(Default)]
pub struct RuntimeInbox {
    normal: VecDeque<QueuedRun>,
    steer: VecDeque<QueuedRun>,
    follow_up: VecDeque<QueuedRun>,
}

impl RuntimeInbox {
    pub fn push_run(&mut self, run: QueuedRun) {
        match run.mode {
            InboxMode::Prompt => self.normal.push_back(run),
            InboxMode::Steer => self.steer.push_front(run),
            InboxMode::FollowUp => self.follow_up.push_back(run),
        }
    }

    pub fn pop_run(&mut self) -> Option<QueuedRun> {
        self.steer
            .pop_front()
            .or_else(|| self.normal.pop_front())
            .or_else(|| self.follow_up.pop_front())
    }

    pub fn is_empty(&self) -> bool {
        self.normal.is_empty() && self.steer.is_empty() && self.follow_up.is_empty()
    }

    pub fn drain_all(&mut self) -> Vec<QueuedRun> {
        let mut dropped =
            Vec::with_capacity(self.normal.len() + self.steer.len() + self.follow_up.len());
        dropped.extend(self.steer.drain(..));
        dropped.extend(self.normal.drain(..));
        dropped.extend(self.follow_up.drain(..));
        dropped
    }

    pub fn len_by_mode(&self) -> (usize, usize, usize) {
        (self.steer.len(), self.normal.len(), self.follow_up.len())
    }

    pub fn stored_runs(&self) -> Vec<StoredQueuedRun> {
        self.steer
            .iter()
            .chain(self.normal.iter())
            .chain(self.follow_up.iter())
            .map(|run| StoredQueuedRun {
                run_id: run.run_id.clone(),
                turn_id: run.turn_id.clone(),
                mode: run.mode,
                request: run.request.clone(),
            })
            .collect()
    }
}

pub struct AgentActor {
    status: AgentStatus,
    inbox: RuntimeInbox,
    active_run_id: Option<String>,
    run_ledger: Vec<RunRecord>,
}

impl Default for AgentActor {
    fn default() -> Self {
        Self {
            status: AgentStatus::Idle,
            inbox: RuntimeInbox::default(),
            active_run_id: None,
            run_ledger: Vec::new(),
        }
    }
}

impl AgentActor {
    pub fn enqueue_run(&mut self, run: QueuedRun) {
        let record = RunRecord {
            run_id: run.run_id.clone(),
            session_id: run.request.session_id.clone(),
            turn_id: run.turn_id.clone(),
            source: run.mode.as_str().to_string(),
            inbox_mode: run.mode,
            status: RunRecordStatus::Queued,
            created_at_ms: now_ms(),
            started_at_ms: None,
            completed_at_ms: None,
            error_code: None,
            error_message: None,
            blocked_reason: None,
            reconciled_reason: None,
        };
        if matches!(run.mode, InboxMode::Steer) && self.is_active() {
            self.status = AgentStatus::Aborting;
            self.mark_active_aborting();
        }
        self.run_ledger.push(record);
        self.inbox.push_run(run);
        if matches!(self.status, AgentStatus::Idle) {
            self.status = AgentStatus::Queued;
        }
    }

    pub fn status(&self) -> AgentStatus {
        self.status.clone()
    }

    pub fn active_run_id(&self) -> Option<String> {
        self.active_run_id.clone()
    }

    pub fn run_ledger(&self) -> Vec<RunRecord> {
        self.run_ledger.clone()
    }

    pub fn replace_run_ledger(&mut self, run_ledger: Vec<RunRecord>) {
        self.run_ledger = run_ledger;
    }

    pub fn inbox_depths(&self) -> (usize, usize, usize) {
        self.inbox.len_by_mode()
    }

    pub fn pending_runs_snapshot(&self) -> Vec<StoredQueuedRun> {
        self.inbox.stored_runs()
    }

    fn is_active(&self) -> bool {
        matches!(self.status, AgentStatus::Running | AgentStatus::Aborting)
    }

    pub(super) fn begin_next_run(&mut self) -> Option<QueuedRun> {
        let run = self.inbox.pop_run();
        if let Some(run) = &run {
            self.status = AgentStatus::Running;
            self.active_run_id = Some(run.run_id.clone());
            self.update_record(&run.run_id, RunRecordStatus::Running, None);
        } else if !matches!(self.status, AgentStatus::Errored) {
            self.status = AgentStatus::Idle;
            self.active_run_id = None;
        }
        run
    }

    pub(super) fn complete_run(&mut self, run_id: &str) {
        self.update_record(run_id, RunRecordStatus::Succeeded, None);
        self.active_run_id = None;
        self.status = if self.inbox.is_empty() {
            AgentStatus::Idle
        } else {
            AgentStatus::Queued
        };
    }

    pub(super) fn fail_run(&mut self, run_id: &str, error: &Error) {
        let status = if error.to_string().contains("canceled by abort") {
            RunRecordStatus::Canceled
        } else {
            RunRecordStatus::Failed
        };
        let canceled = matches!(status, RunRecordStatus::Canceled);
        self.update_record(run_id, status, Some(error.to_string()));
        self.active_run_id = None;
        self.status = if canceled {
            if self.inbox.is_empty() {
                AgentStatus::Idle
            } else {
                AgentStatus::Queued
            }
        } else {
            AgentStatus::Errored
        };
    }

    pub(super) fn abort_active(&mut self, clear_pending: bool) -> Vec<QueuedRun> {
        if self.is_active() {
            self.status = AgentStatus::Aborting;
            self.mark_active_aborting();
        }
        if clear_pending {
            let dropped = self.inbox.drain_all();
            for run in &dropped {
                self.update_record(
                    &run.run_id,
                    RunRecordStatus::Canceled,
                    Some("pending run dropped by abort".to_string()),
                );
            }
            if dropped.is_empty() && !self.is_active() {
                self.status = AgentStatus::Idle;
            }
            dropped
        } else {
            Vec::new()
        }
    }

    fn mark_active_aborting(&mut self) {
        if let Some(run_id) = self.active_run_id.clone() {
            self.update_record(&run_id, RunRecordStatus::Aborting, None);
        }
    }

    fn update_record(
        &mut self,
        run_id: &str,
        status: RunRecordStatus,
        error_message: Option<String>,
    ) {
        if let Some(record) = self
            .run_ledger
            .iter_mut()
            .find(|record| record.run_id == run_id)
        {
            record.status = status;
            match record.status {
                RunRecordStatus::Running => {
                    if record.started_at_ms.is_none() {
                        record.started_at_ms = Some(now_ms());
                    }
                }
                RunRecordStatus::Succeeded
                | RunRecordStatus::Failed
                | RunRecordStatus::Canceled
                | RunRecordStatus::Blocked => {
                    if record.completed_at_ms.is_none() {
                        record.completed_at_ms = Some(now_ms());
                    }
                }
                RunRecordStatus::Queued | RunRecordStatus::Aborting => {}
            }
            record.error_message = error_message;
        }
    }
}
