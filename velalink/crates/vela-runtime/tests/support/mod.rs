use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::time::{Duration, sleep, timeout};
use vela_backends::{BackendOutput, ScriptedAgentClient};
use vela_core::{BackendKind, CommandAck, EventType, SessionId};
use vela_runtime::{Runtime, SendUserMessage};
use vela_store::SqliteEventStore;

#[derive(Clone, Debug, Deserialize)]
pub struct UserSequenceStep {
    pub idempotency_key: String,
    pub content: String,
    pub expect_status: String,
    #[serde(default)]
    pub expect_replay: bool,
    pub expect_code: Option<String>,
}

pub fn read_user_sequence_fixture(path: &str) -> Vec<UserSequenceStep> {
    let raw = match path {
        "duplicate_replay_and_mismatch.jsonl" => {
            include_str!("../fixtures/user_sequences/duplicate_replay_and_mismatch.jsonl")
        }
        "workbuddy_guardiola_multi_turn.jsonl" => {
            include_str!("../fixtures/user_sequences/workbuddy_guardiola_multi_turn.jsonl")
        }
        "synara_edit_resend_sequence.jsonl" => {
            include_str!("../fixtures/user_sequences/synara_edit_resend_sequence.jsonl")
        }
        "omx_turns_sanitized_sequence.jsonl" => {
            include_str!("../fixtures/user_sequences/omx_turns_sanitized_sequence.jsonl")
        }
        other => panic!("unknown runtime user sequence fixture: {other}"),
    };
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("user sequence step fixture"))
        .collect()
}

#[derive(Clone, Debug, Deserialize)]
pub struct RuntimeScenario {
    pub name: String,
    pub session_id: SessionId,
    pub steps: Vec<RuntimeScenarioStep>,
    pub expect_prompts: Vec<String>,
    pub expect_event_types: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RuntimeScenarioStep {
    pub idempotency_key: String,
    pub content: String,
    pub expect_status: String,
    pub backend_outputs: Vec<BackendOutputFixture>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BackendOutputFixture {
    pub event_type: EventType,
    pub payload: serde_json::Value,
    #[serde(default)]
    pub raw: Option<serde_json::Value>,
}

impl From<BackendOutputFixture> for BackendOutput {
    fn from(fixture: BackendOutputFixture) -> Self {
        Self {
            event_type: fixture.event_type,
            payload: fixture.payload,
            raw: fixture.raw,
        }
    }
}

pub fn read_scenario_fixture(path: &str) -> RuntimeScenario {
    let raw = match path {
        "two_turn_tool_recovery.json" => {
            include_str!("../fixtures/scenarios/two_turn_tool_recovery.json")
        }
        "three_turn_edit_tool_summary.json" => {
            include_str!("../fixtures/scenarios/three_turn_edit_tool_summary.json")
        }
        "request_warning_success_flow.json" => {
            include_str!("../fixtures/scenarios/request_warning_success_flow.json")
        }
        other => panic!("unknown runtime scenario fixture: {other}"),
    };
    serde_json::from_str(raw).expect("runtime scenario fixture")
}

pub fn scenario_fixture_names() -> Vec<&'static str> {
    vec![
        "two_turn_tool_recovery.json",
        "three_turn_edit_tool_summary.json",
        "request_warning_success_flow.json",
    ]
}

pub struct RuntimeHarness {
    pub store: Arc<SqliteEventStore>,
    pub backend: Arc<ScriptedAgentClient>,
    pub runtime: Runtime<ScriptedAgentClient>,
    pub session_id: SessionId,
}

impl RuntimeHarness {
    pub async fn new() -> Self {
        let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
        let backend = Arc::new(ScriptedAgentClient::repeat(vec![BackendOutput::event(
            EventType::TURN_COMPLETED,
            json!({}),
        )]));
        let runtime = Runtime::new(store.clone(), backend.clone());
        let session_id = SessionId::from("ses_runtime_fixture");
        runtime
            .create_session(session_id.clone(), BackendKind::Pi, "/tmp/vela")
            .await
            .expect("create session");
        Self {
            store,
            backend,
            runtime,
            session_id,
        }
    }

    pub async fn send(&self, step: &UserSequenceStep) -> CommandAck {
        let ack = self
            .runtime
            .send_user_message(SendUserMessage {
                session_id: self.session_id.clone(),
                idempotency_key: step.idempotency_key.clone(),
                content: step.content.clone(),
                command_id: None,
            })
            .await
            .expect("send user sequence step");
        if matches!(ack, CommandAck::Accepted(_)) && !step.expect_replay {
            let target = accepted_user_message_count(&self.store, &self.session_id).await;
            wait_for_terminal_turns(&self.store, &self.session_id, target).await;
        }
        ack
    }
}

pub struct ScenarioHarness {
    pub store: Arc<SqliteEventStore>,
    pub backend: Arc<ScriptedAgentClient>,
    pub runtime: Runtime<ScriptedAgentClient>,
    pub scenario: RuntimeScenario,
}

impl ScenarioHarness {
    pub async fn from_fixture(scenario: &RuntimeScenario) -> Self {
        let store = Arc::new(SqliteEventStore::in_memory().await.expect("store"));
        let turn_outputs = scenario
            .steps
            .iter()
            .map(|step| {
                step.backend_outputs
                    .clone()
                    .into_iter()
                    .map(BackendOutput::from)
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        let backend = Arc::new(ScriptedAgentClient::from_turns(turn_outputs));
        let runtime = Runtime::new(store.clone(), backend.clone());
        runtime
            .create_session(scenario.session_id.clone(), BackendKind::Pi, "/tmp/vela")
            .await
            .expect("create scenario session");
        Self {
            store,
            backend,
            runtime,
            scenario: scenario.clone(),
        }
    }

    pub async fn run(&self) {
        for step in &self.scenario.steps {
            let ack = self
                .runtime
                .send_user_message(SendUserMessage {
                    session_id: self.scenario.session_id.clone(),
                    idempotency_key: step.idempotency_key.clone(),
                    content: step.content.clone(),
                    command_id: None,
                })
                .await
                .expect("send scenario step");
            match step.expect_status.as_str() {
                "accepted" => {
                    assert!(
                        matches!(ack, CommandAck::Accepted(_)),
                        "expected accepted ack for scenario {} step {step:?}, got {ack:?}",
                        self.scenario.name
                    );
                    let target =
                        accepted_user_message_count(&self.store, &self.scenario.session_id).await;
                    wait_for_terminal_turns(&self.store, &self.scenario.session_id, target).await;
                }
                "rejected" => assert!(
                    matches!(ack, CommandAck::Rejected(_)),
                    "expected rejected ack for scenario {} step {step:?}, got {ack:?}",
                    self.scenario.name
                ),
                other => panic!("unknown scenario ack expectation: {other}"),
            }
        }
    }

    pub async fn event_type_names(&self) -> Vec<String> {
        self.store
            .list_events(&self.scenario.session_id)
            .await
            .expect("scenario events")
            .iter()
            .map(|event| event.event_type.0.to_string())
            .collect()
    }

    pub async fn persisted_backend_outputs(&self) -> Vec<BackendOutput> {
        self.store
            .list_events(&self.scenario.session_id)
            .await
            .expect("scenario events")
            .into_iter()
            .filter(|event| event.source.kind == "backend")
            .map(|event| BackendOutput {
                event_type: event.event_type,
                payload: event.payload,
                raw: event.raw,
            })
            .collect()
    }
}

async fn accepted_user_message_count(store: &SqliteEventStore, session_id: &SessionId) -> usize {
    store
        .list_events(session_id)
        .await
        .expect("events")
        .iter()
        .filter(|event| event.event_type == EventType::USER_MESSAGE_ACCEPTED)
        .count()
}

async fn wait_for_terminal_turns(store: &SqliteEventStore, session_id: &SessionId, target: usize) {
    timeout(Duration::from_secs(2), async {
        loop {
            let terminal_count = store
                .list_events(session_id)
                .await
                .expect("events")
                .iter()
                .filter(|event| {
                    event.event_type == EventType::TURN_COMPLETED
                        || event.event_type == EventType::TURN_FAILED
                })
                .count();
            if terminal_count >= target {
                return;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("runtime turn should reach a terminal event");
}

impl RuntimeScenario {
    pub fn expected_backend_outputs(&self) -> Vec<BackendOutput> {
        self.steps
            .iter()
            .flat_map(|step| step.backend_outputs.clone())
            .map(BackendOutput::from)
            .collect()
    }
}
