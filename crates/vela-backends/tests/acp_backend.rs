mod support;

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
    AcpBackendAdapter, AcpConnection, AcpHost, AcpInbound, AcpStdioHost, BackendAdapter,
    BackendRequestResponse, BackendSend, backend_output_channel, normalize_acp_session_update,
};
use vela_core::{
    BackendKind, BlobRef, EventType, ResolvedAgentConfig, SessionId, TurnId, UserMessageBlock,
};

#[test]
fn acp_session_updates_normalize_to_canonical_backend_outputs() {
    let outputs = normalize_acp_session_update(json!({
        "sessionUpdate": "agent_message_chunk",
        "messageId": "msg_1",
        "content": { "type": "text", "text": "hello" }
    }));
    assert_eq!(outputs.len(), 1);
    assert_eq!(outputs[0].event_type, EventType::ASSISTANT_MESSAGE_DELTA);
    assert_eq!(outputs[0].payload["message_id"], "msg_1");
    assert_eq!(outputs[0].payload["delta"], "hello");

    let outputs = normalize_acp_session_update(json!({
        "type": "agent_thought_chunk",
        "content": { "type": "text", "text": "thinking" }
    }));
    assert_eq!(outputs[0].event_type, EventType::ASSISTANT_REASONING_DELTA);
    assert_eq!(outputs[0].payload["delta"], "thinking");

    let outputs = normalize_acp_session_update(json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "tool_1",
        "title": "Read file",
        "kind": "read",
        "status": "pending",
        "rawInput": { "path": "README.md" }
    }));
    assert_eq!(outputs[0].event_type, EventType::TOOL_STARTED);
    assert_eq!(outputs[0].payload["tool_id"], "tool_1");
    assert_eq!(outputs[0].payload["name"], "Read file");

    let outputs = normalize_acp_session_update(json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "tool_1",
        "status": "completed",
        "content": [{ "type": "content", "text": "done" }]
    }));
    assert_eq!(outputs[0].event_type, EventType::TOOL_COMPLETED);
}

#[tokio::test]
async fn acp_adapter_initializes_session_and_streams_prompt_updates() {
    let host = ScriptedAcpHost::new(vec![
        AcpInbound::response(json!({
            "protocolVersion": 1,
            "agentCapabilities": {}
        })),
        AcpInbound::response(json!({ "sessionId": "acp_ses_1" })),
        AcpInbound::response(json!({ "modelId": "minimax-m2.7" })),
        AcpInbound::response(json!({ "optionId": "reasoning_effort", "value": "medium" })),
        AcpInbound::notification(
            "session/update",
            json!({
                "sessionId": "acp_ses_1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "msg_1",
                    "content": { "type": "text", "text": "hello" }
                }
            }),
        ),
        AcpInbound::response(json!({ "stopReason": "end_turn" })),
    ]);
    let adapter = AcpBackendAdapter::new(Arc::new(host.clone()), "/repo");

    let mut input = BackendSend::new("hello acp");
    input.session_id = Some(SessionId::from("ses_acp"));
    input.resolved_agent_config = Some(ResolvedAgentConfig {
        backend: BackendKind::Acp,
        config: vela_core::AgentConfig {
            model: Some("minimax-m2.7".to_string()),
            reasoning_effort: Some("medium".to_string()),
            permission_mode: Some(vela_core::PermissionMode::Auto),
            feature_values: Default::default(),
        },
    });

    let outputs = support::collect_backend_outputs(&adapter, input)
        .await
        .expect("outputs");

    assert_eq!(outputs.len(), 2);
    assert_eq!(outputs[0].event_type, EventType::ASSISTANT_MESSAGE_DELTA);
    assert_eq!(outputs[0].payload["delta"], "hello");
    assert_eq!(outputs[1].event_type, EventType::TURN_COMPLETED);

    let calls = host.calls().await;
    assert_eq!(
        calls
            .iter()
            .map(|call| call.method.as_str())
            .collect::<Vec<_>>(),
        vec![
            "initialize",
            "session/new",
            "session/setModel",
            "session/setConfigOption",
            "session/prompt"
        ]
    );
    assert_eq!(calls[1].params["cwd"], "/repo");
    assert_eq!(calls[2].params["modelId"], "minimax-m2.7");
    assert_eq!(calls[3].params["optionId"], "reasoning_effort");
    assert_eq!(calls[3].params["value"], "medium");
    assert_eq!(calls[4].params["prompt"][0]["text"], "hello acp");
}

#[tokio::test]
async fn acp_adapter_sends_base64_image_blocks_in_prompt() {
    let host = ScriptedAcpHost::new(vec![
        AcpInbound::response(json!({ "protocolVersion": 1, "agentCapabilities": {} })),
        AcpInbound::response(json!({ "sessionId": "acp_ses_image" })),
        AcpInbound::response(json!({ "stopReason": "end_turn" })),
    ]);
    let adapter = AcpBackendAdapter::new(Arc::new(host.clone()), "/repo");

    let mut input = BackendSend::new("look at this image");
    input.session_id = Some(SessionId::from("ses_acp_image"));
    input.blocks = vec![
        UserMessageBlock::Text {
            text: "look at this image".to_string(),
        },
        UserMessageBlock::Image {
            blob: BlobRef::InlineBase64 {
                data: "aGVsbG8=".to_string(),
                mime_type: "image/png".to_string(),
                sha256: None,
                size_bytes: None,
            },
        },
    ];

    let outputs = support::collect_backend_outputs(&adapter, input)
        .await
        .expect("outputs");

    assert!(
        outputs
            .iter()
            .any(|output| output.event_type == EventType::TURN_COMPLETED)
    );
    let calls = host.calls().await;
    let prompt_call = calls
        .iter()
        .find(|call| call.method == "session/prompt")
        .expect("session/prompt call");
    assert_eq!(
        prompt_call.params["prompt"],
        json!([
            { "type": "text", "text": "look at this image" },
            { "type": "image", "data": "aGVsbG8=", "mimeType": "image/png" }
        ])
    );
}

#[tokio::test]
async fn acp_missing_message_id_is_scoped_to_the_vela_turn_and_completes_each_prompt() {
    let host = ScriptedAcpHost::new(vec![
        AcpInbound::response(json!({ "protocolVersion": 1, "agentCapabilities": {} })),
        AcpInbound::response(json!({ "sessionId": "acp_ses_turn_scoped" })),
        AcpInbound::notification(
            "session/update",
            json!({
                "sessionId": "acp_ses_turn_scoped",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "first" }
                }
            }),
        ),
        AcpInbound::response(json!({ "stopReason": "end_turn" })),
        AcpInbound::notification(
            "session/update",
            json!({
                "sessionId": "acp_ses_turn_scoped",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "second" }
                }
            }),
        ),
        AcpInbound::response(json!({ "stopReason": "end_turn" })),
    ]);
    let adapter = AcpBackendAdapter::new(Arc::new(host), "/repo");

    let mut first = BackendSend::new("first prompt");
    first.session_id = Some(SessionId::from("ses_acp_turn_scoped"));
    first.turn_id = Some(TurnId::from("turn_first"));
    first.resolved_agent_config = Some(ResolvedAgentConfig {
        backend: BackendKind::Acp,
        config: Default::default(),
    });
    let first_outputs = support::collect_backend_outputs(&adapter, first)
        .await
        .expect("first outputs");

    let mut second = BackendSend::new("second prompt");
    second.session_id = Some(SessionId::from("ses_acp_turn_scoped"));
    second.turn_id = Some(TurnId::from("turn_second"));
    second.resolved_agent_config = Some(ResolvedAgentConfig {
        backend: BackendKind::Acp,
        config: Default::default(),
    });
    let second_outputs = support::collect_backend_outputs(&adapter, second)
        .await
        .expect("second outputs");

    let first_delta = first_outputs
        .iter()
        .find(|output| output.event_type == EventType::ASSISTANT_MESSAGE_DELTA)
        .expect("first assistant delta");
    let second_delta = second_outputs
        .iter()
        .find(|output| output.event_type == EventType::ASSISTANT_MESSAGE_DELTA)
        .expect("second assistant delta");
    assert_eq!(first_delta.payload["message_id"], "assistant:turn_first");
    assert_eq!(second_delta.payload["message_id"], "assistant:turn_second");
    assert_ne!(
        first_delta.payload["message_id"],
        second_delta.payload["message_id"]
    );
    assert!(
        first_outputs
            .iter()
            .any(|output| output.event_type == EventType::TURN_COMPLETED),
        "first ACP prompt response should emit a terminal output"
    );
    assert!(
        second_outputs
            .iter()
            .any(|output| output.event_type == EventType::TURN_COMPLETED),
        "second ACP prompt response should emit a terminal output"
    );
}

#[tokio::test]
async fn acp_adapter_opens_permission_request_and_resumes_after_response() {
    let host = ScriptedAcpHost::new(vec![
        AcpInbound::response(json!({ "protocolVersion": 1, "agentCapabilities": {} })),
        AcpInbound::response(json!({ "sessionId": "acp_ses_permission" })),
        AcpInbound::request(
            7,
            "session/request_permission",
            json!({
                "sessionId": "acp_ses_permission",
                "options": [
                    { "optionId": "allow_once", "name": "Allow once", "kind": "allow" },
                    { "optionId": "deny", "name": "Deny", "kind": "deny" }
                ],
                "toolCall": { "toolCallId": "tool_1", "rawInput": { "cmd": "pwd" } }
            }),
        ),
        AcpInbound::notification(
            "session/update",
            json!({
                "sessionId": "acp_ses_permission",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "msg_after_permission",
                    "content": { "type": "text", "text": "approved" }
                }
            }),
        ),
        AcpInbound::response(json!({ "stopReason": "end_turn" })),
    ]);
    let adapter = Arc::new(AcpBackendAdapter::new(Arc::new(host.clone()), "/repo"));
    let (sink, mut receiver) = backend_output_channel(16);
    let mut input = BackendSend::new("needs permission");
    input.session_id = Some(SessionId::from("ses_acp_permission"));
    input.resolved_agent_config = Some(ResolvedAgentConfig {
        backend: BackendKind::Acp,
        config: Default::default(),
    });

    let stream_adapter = adapter.clone();
    let stream = tokio::spawn(async move { stream_adapter.stream_user_message(input, sink).await });

    let opened = receiver
        .recv()
        .await
        .expect("request.opened output")
        .expect("request.opened ok");
    assert_eq!(opened.event_type, EventType::REQUEST_OPENED);
    assert_eq!(opened.payload["request_id"], "acp_request_7");
    assert_eq!(opened.payload["request_type"], "tool_confirmation");

    adapter
        .respond_to_request(BackendRequestResponse {
            session_id: SessionId::from("ses_acp_permission"),
            backend: Some(BackendKind::Acp),
            request_id: "acp_request_7".to_string(),
            result: Some("allow".to_string()),
            scope: None,
            answer: None,
            content: None,
            options: None,
        })
        .await
        .expect("respond to acp request");

    let delta = receiver
        .recv()
        .await
        .expect("assistant delta output")
        .expect("assistant delta ok");
    assert_eq!(delta.event_type, EventType::ASSISTANT_MESSAGE_DELTA);
    assert_eq!(delta.payload["delta"], "approved");
    stream.await.expect("stream task").expect("stream ok");

    let responses = host.responses().await;
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0].id, 7);
    assert_eq!(responses[0].result["outcome"]["outcome"], "selected");
    assert_eq!(responses[0].result["outcome"]["optionId"], "allow_once");
}

#[test]
fn acp_stdio_host_defaults_to_hermes_command_with_cloudagents_env() {
    let host = AcpStdioHost::hermes("/repo")
        .with_cloudagents_defaults(Some("secret".to_string()), Some("minimax-m2.7".to_string()));

    assert_eq!(host.command, "hermes");
    assert_eq!(host.args, vec!["acp"]);
    assert_eq!(host.cwd, "/repo");
    assert_eq!(
        host.env.get("OPENAI_BASE_URL").map(String::as_str),
        Some("https://tokenhub.tencentmaas.com/v1")
    );
    assert_eq!(
        host.env.get("OPENAI_API_KEY").map(String::as_str),
        Some("secret")
    );
    assert_eq!(
        host.env.get("HERMES_INFERENCE_MODEL").map(String::as_str),
        Some("minimax-m2.7")
    );
}

#[derive(Clone)]
struct ScriptedAcpHost {
    state: Arc<Mutex<ScriptedAcpState>>,
    connects: Arc<AtomicUsize>,
}

struct ScriptedAcpState {
    inbound: VecDeque<AcpInbound>,
    calls: Vec<RecordedAcpCall>,
    responses: Vec<RecordedAcpResponse>,
}

#[derive(Clone, Debug)]
struct RecordedAcpCall {
    method: String,
    params: Value,
}

#[derive(Clone, Debug)]
struct RecordedAcpResponse {
    id: i64,
    result: Value,
}

impl ScriptedAcpHost {
    fn new(inbound: Vec<AcpInbound>) -> Self {
        Self {
            state: Arc::new(Mutex::new(ScriptedAcpState {
                inbound: inbound.into(),
                calls: Vec::new(),
                responses: Vec::new(),
            })),
            connects: Arc::new(AtomicUsize::new(0)),
        }
    }

    async fn calls(&self) -> Vec<RecordedAcpCall> {
        self.state.lock().await.calls.clone()
    }

    async fn responses(&self) -> Vec<RecordedAcpResponse> {
        self.state.lock().await.responses.clone()
    }
}

#[async_trait]
impl AcpHost for ScriptedAcpHost {
    async fn connect(&self) -> anyhow::Result<Box<dyn AcpConnection>> {
        self.connects.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(ScriptedAcpConnection {
            state: self.state.clone(),
        }))
    }
}

struct ScriptedAcpConnection {
    state: Arc<Mutex<ScriptedAcpState>>,
}

#[async_trait]
impl AcpConnection for ScriptedAcpConnection {
    async fn request(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        self.state.lock().await.calls.push(RecordedAcpCall {
            method: method.to_string(),
            params,
        });
        loop {
            let inbound = self
                .state
                .lock()
                .await
                .inbound
                .pop_front()
                .ok_or_else(|| anyhow::anyhow!("script exhausted"))?;
            match inbound {
                AcpInbound::Response(value) => return Ok(value),
                other => self.state.lock().await.inbound.push_front(other),
            }
        }
    }

    async fn start_request(&mut self, method: &str, params: Value) -> anyhow::Result<i64> {
        self.state.lock().await.calls.push(RecordedAcpCall {
            method: method.to_string(),
            params,
        });
        Ok(99)
    }

    async fn respond(&mut self, id: i64, result: Value) -> anyhow::Result<()> {
        self.state
            .lock()
            .await
            .responses
            .push(RecordedAcpResponse { id, result });
        Ok(())
    }

    async fn next(&mut self) -> anyhow::Result<Option<AcpInbound>> {
        Ok(self.state.lock().await.inbound.pop_front())
    }

    async fn close(&mut self) -> anyhow::Result<()> {
        Ok(())
    }
}
