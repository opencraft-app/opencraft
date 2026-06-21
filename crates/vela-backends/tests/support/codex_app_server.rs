use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::Mutex;
use vela_backends::{
    AppServerInbound, BackendAdapter, BackendOutput, BackendRequestResponse, BackendSend,
    CodexAppServerBackendAdapter, CodexAppServerConnection, CodexAppServerHost,
    backend_output_channel,
};
use vela_core::{BackendKind, EventType, SessionId};

#[derive(Clone)]
pub struct ScriptedHost {
    state: Arc<Mutex<ScriptedState>>,
    connects: Arc<AtomicUsize>,
}

struct ScriptedState {
    inbound: VecDeque<AppServerInbound>,
    calls: Vec<RecordedCall>,
    responses: Vec<RecordedResponse>,
}

#[derive(Clone, Debug)]
pub struct RecordedCall {
    pub method: String,
    pub params: Value,
}

#[derive(Clone, Debug)]
pub struct RecordedResponse {
    pub id: i64,
    pub result: Value,
}

impl ScriptedHost {
    pub fn new(inbound: Vec<AppServerInbound>) -> Self {
        Self {
            state: Arc::new(Mutex::new(ScriptedState {
                inbound: VecDeque::from(inbound),
                calls: Vec::new(),
                responses: Vec::new(),
            })),
            connects: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn connect_count(&self) -> usize {
        self.connects.load(Ordering::SeqCst)
    }

    pub async fn calls(&self) -> Vec<RecordedCall> {
        self.state.lock().await.calls.clone()
    }

    pub async fn responses(&self) -> Vec<RecordedResponse> {
        self.state.lock().await.responses.clone()
    }
}

#[async_trait]
impl CodexAppServerHost for ScriptedHost {
    async fn connect(&self) -> anyhow::Result<Box<dyn CodexAppServerConnection>> {
        self.connects.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(ScriptedConnection {
            state: self.state.clone(),
        }))
    }
}

struct ScriptedConnection {
    state: Arc<Mutex<ScriptedState>>,
}

#[async_trait]
impl CodexAppServerConnection for ScriptedConnection {
    async fn request(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        let mut state = self.state.lock().await;
        state.calls.push(RecordedCall {
            method: method.to_string(),
            params,
        });
        match state.inbound.pop_front() {
            Some(AppServerInbound::Response(value)) => Ok(value),
            other => anyhow::bail!("expected response for {method}, got {other:?}"),
        }
    }

    async fn notify(&mut self, _method: &str, _params: Value) -> anyhow::Result<()> {
        Ok(())
    }

    async fn respond(&mut self, id: i64, result: Value) -> anyhow::Result<()> {
        self.state
            .lock()
            .await
            .responses
            .push(RecordedResponse { id, result });
        Ok(())
    }

    async fn next(&mut self) -> anyhow::Result<Option<AppServerInbound>> {
        loop {
            let mut state = self.state.lock().await;
            if matches!(state.inbound.front(), Some(AppServerInbound::Response(_))) {
                drop(state);
                tokio::task::yield_now().await;
                continue;
            }
            return Ok(state.inbound.pop_front());
        }
    }

    async fn close(&mut self) -> anyhow::Result<()> {
        Ok(())
    }
}

pub async fn wait_for_call_count(host: &ScriptedHost, expected: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            if host.calls().await.len() >= expected {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("wait for scripted calls");
}

pub async fn run_codex_request_round_trip(
    method: &str,
    params: Value,
    response: BackendRequestResponse,
) -> (BackendOutput, Vec<RecordedResponse>) {
    let host = ScriptedHost::new(vec![
        AppServerInbound::response(json!({ "ok": true })),
        AppServerInbound::response(json!({ "thread": { "id": "thr_request" } })),
        AppServerInbound::response(json!({ "turn": { "id": "turn_1" } })),
        AppServerInbound::request(51, method, params),
        AppServerInbound::notification(
            "turn/completed",
            json!({ "threadId": "thr_request", "turn": { "status": "completed" } }),
        ),
    ]);
    let adapter = Arc::new(CodexAppServerBackendAdapter::new(
        Arc::new(host.clone()),
        "/repo",
    ));
    let (sink, mut receiver) = backend_output_channel(16);
    let mut input = BackendSend::new("request round trip");
    input.session_id = Some(SessionId::from("ses_request"));
    input.resolved_agent_config = Some(vela_core::ResolvedAgentConfig {
        backend: BackendKind::Codex,
        config: Default::default(),
    });

    let stream_adapter = adapter.clone();
    let stream = tokio::spawn(async move { stream_adapter.stream_user_message(input, sink).await });
    let opened = receiver
        .recv()
        .await
        .expect("request.opened output")
        .expect("request.opened ok");
    adapter
        .respond_to_request(response)
        .await
        .expect("respond to codex request");
    let completed = receiver
        .recv()
        .await
        .expect("turn completed output")
        .expect("turn completed ok");
    assert_eq!(completed.event_type, EventType::TURN_COMPLETED);
    stream.await.expect("stream task").expect("stream ok");
    (opened, host.responses().await)
}
