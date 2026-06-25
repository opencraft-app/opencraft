use crate::support;
use crate::support::codex_app_server::{ScriptedHost, wait_for_call_count};
use serde_json::json;
use std::sync::Arc;
use vela_backends::{
    AppServerInbound, BackendAdapter, BackendCancel, BackendSend, CodexAppServerBackendAdapter,
    backend_output_channel,
};
use vela_core::{BackendKind, EventType, ResolvedAgentConfig, SessionId};

#[tokio::test]
async fn codex_app_server_adapter_maps_permission_modes_and_working_directory_override() {
    let host = ScriptedHost::new(vec![
        AppServerInbound::response(json!({ "ok": true })),
        AppServerInbound::response(json!({ "thread": { "id": "thr_readonly" } })),
        AppServerInbound::response(json!({ "turn": { "id": "turn_1" } })),
        AppServerInbound::notification(
            "turn/completed",
            json!({ "threadId": "thr_readonly", "turn": { "status": "completed" } }),
        ),
    ]);
    let adapter = CodexAppServerBackendAdapter::new(Arc::new(host.clone()), "/default-cwd");

    let mut input = BackendSend::new("inspect only");
    input.session_id = Some(SessionId::from("ses_readonly"));
    input.working_directory = Some("/override-cwd".to_string());
    input.resolved_agent_config = Some(ResolvedAgentConfig {
        backend: BackendKind::Codex,
        config: vela_core::AgentConfig {
            model: Some("gpt-5.4".to_string()),
            reasoning_effort: Some("minimal".to_string()),
            permission_mode: Some(vela_core::PermissionMode::ReadOnly),
            feature_values: Default::default(),
        },
    });

    support::collect_backend_outputs(&adapter, input)
        .await
        .unwrap();

    let calls = host.calls().await;
    assert_eq!(calls[1].method, "thread/start");
    assert_eq!(calls[1].params["cwd"], "/override-cwd");
    assert_eq!(calls[1].params["sandbox"], "read-only");
    assert_eq!(calls[1].params["approvalPolicy"], "on-request");
    assert_eq!(calls[1].params["networkAccess"], false);
    assert_eq!(calls[1].params["reasoningEffort"], "minimal");
}

#[tokio::test]
async fn codex_app_server_adapter_maps_auto_review_permission_mode() {
    let host = ScriptedHost::new(vec![
        AppServerInbound::response(json!({ "ok": true })),
        AppServerInbound::response(json!({ "thread": { "id": "thr_review" } })),
        AppServerInbound::response(json!({ "turn": { "id": "turn_1" } })),
        AppServerInbound::notification(
            "turn/completed",
            json!({ "threadId": "thr_review", "turn": { "status": "completed" } }),
        ),
    ]);
    let adapter = CodexAppServerBackendAdapter::new(Arc::new(host.clone()), "/repo");

    let mut input = BackendSend::new("review mode");
    input.session_id = Some(SessionId::from("ses_review"));
    input.resolved_agent_config = Some(ResolvedAgentConfig {
        backend: BackendKind::Codex,
        config: vela_core::AgentConfig {
            permission_mode: Some(vela_core::PermissionMode::AutoReview),
            ..Default::default()
        },
    });

    support::collect_backend_outputs(&adapter, input)
        .await
        .unwrap();

    let calls = host.calls().await;
    assert_eq!(calls[1].params["sandbox"], "workspace-write");
    assert_eq!(calls[1].params["approvalPolicy"], "on-request");
    assert_eq!(calls[1].params["approvalsReviewer"], "auto_review");
}

#[tokio::test]
async fn codex_app_server_adapter_starts_thread_once_and_reuses_it_for_session_turns() {
    let host = ScriptedHost::new(vec![
        AppServerInbound::response(json!({ "ok": true })),
        AppServerInbound::response(json!({ "thread": { "id": "thr_1" } })),
        AppServerInbound::response(json!({ "turn": { "id": "turn_1" } })),
        AppServerInbound::notification(
            "item/agentMessage/delta",
            json!({ "threadId": "thr_1", "itemId": "msg_1", "delta": "first" }),
        ),
        AppServerInbound::notification(
            "turn/completed",
            json!({ "threadId": "thr_1", "turn": { "status": "completed" } }),
        ),
        AppServerInbound::response(json!({ "turn": { "id": "turn_2" } })),
        AppServerInbound::notification(
            "item/agentMessage/delta",
            json!({ "threadId": "thr_1", "itemId": "msg_2", "delta": "second" }),
        ),
        AppServerInbound::notification(
            "turn/completed",
            json!({ "threadId": "thr_1", "turn": { "status": "completed" } }),
        ),
    ]);
    let adapter = CodexAppServerBackendAdapter::new(Arc::new(host.clone()), "/repo");

    let mut first = BackendSend::new("hello");
    first.session_id = Some(SessionId::from("ses_codex"));
    first.resolved_agent_config = Some(ResolvedAgentConfig {
        backend: BackendKind::Codex,
        config: vela_core::AgentConfig {
            model: Some("gpt-5.4".to_string()),
            reasoning_effort: Some("high".to_string()),
            permission_mode: Some(vela_core::PermissionMode::FullAccess),
            feature_values: Default::default(),
        },
    });
    let outputs = support::collect_backend_outputs(&adapter, first)
        .await
        .unwrap();
    assert_eq!(outputs[0].event_type, EventType::ASSISTANT_MESSAGE_DELTA);
    assert_eq!(outputs[0].payload["delta"], "first");

    let mut second = BackendSend::new("again");
    second.session_id = Some(SessionId::from("ses_codex"));
    second.resolved_agent_config = Some(ResolvedAgentConfig {
        backend: BackendKind::Codex,
        config: vela_core::AgentConfig {
            model: Some("gpt-5.3-codex-spark".to_string()),
            reasoning_effort: Some("low".to_string()),
            permission_mode: Some(vela_core::PermissionMode::AutoReview),
            feature_values: std::collections::BTreeMap::from([(
                "fast_mode".to_string(),
                serde_json::Value::Bool(true),
            )]),
        },
    });
    let outputs = support::collect_backend_outputs(&adapter, second)
        .await
        .unwrap();
    assert_eq!(outputs[0].payload["delta"], "second");

    assert_eq!(host.connect_count(), 1);
    let calls = host.calls().await;
    assert_eq!(
        calls
            .iter()
            .map(|call| call.method.as_str())
            .collect::<Vec<_>>(),
        vec!["initialize", "thread/start", "turn/start", "turn/start",],
    );
    assert_eq!(calls[1].params["model"], "gpt-5.4");
    assert_eq!(calls[1].params["cwd"], "/repo");
    assert_eq!(calls[1].params["sandbox"], "danger-full-access");
    assert_eq!(calls[1].params["reasoningEffort"], "high");
    assert_eq!(calls[2].params["threadId"], "thr_1");
    assert_eq!(calls[2].params["input"][0]["text"], "hello");
    assert_eq!(calls[2].params["model"], "gpt-5.4");
    assert_eq!(calls[2].params["effort"], "high");
    assert_eq!(calls[2].params["approvalPolicy"], "never");
    assert_eq!(calls[2].params["sandboxPolicy"]["type"], "dangerFullAccess");
    assert_eq!(calls[3].params["threadId"], "thr_1");
    assert_eq!(calls[3].params["input"][0]["text"], "again");
    assert_eq!(calls[3].params["model"], "gpt-5.3-codex-spark");
    assert_eq!(calls[3].params["effort"], "low");
    assert_eq!(calls[3].params["approvalPolicy"], "on-request");
    assert_eq!(calls[3].params["sandboxPolicy"]["type"], "workspaceWrite");
    assert_eq!(calls[3].params["approvalsReviewer"], "auto_review");
    assert_eq!(calls[3].params["serviceTier"], "fast");
}

#[tokio::test]
async fn codex_app_server_adapter_emits_diagnostics_only_when_requested() {
    let host = ScriptedHost::new(vec![
        AppServerInbound::response(json!({ "ok": true })),
        AppServerInbound::response(json!({ "thread": { "id": "thr_diag" } })),
        AppServerInbound::response(json!({ "turn": { "id": "turn_1" } })),
        AppServerInbound::notification(
            "turn/completed",
            json!({ "threadId": "thr_diag", "turn": { "status": "completed" } }),
        ),
    ]);
    let adapter = CodexAppServerBackendAdapter::new(Arc::new(host), "/repo");
    let mut input = BackendSend::new("hello");
    input.session_id = Some(SessionId::from("ses_diag"));
    input.emit_diagnostics = true;

    let outputs = support::collect_backend_outputs(&adapter, input)
        .await
        .unwrap();
    let diagnostics = outputs
        .iter()
        .filter(|output| output.payload["code"] == "codex_app_server_trace")
        .collect::<Vec<_>>();

    assert!(
        diagnostics
            .iter()
            .any(|output| output.payload["name"] == "codex.app_server.thread_start")
    );
    assert!(
        diagnostics
            .iter()
            .any(|output| output.payload["name"] == "codex.app_server.turn_start")
    );
    assert!(
        outputs
            .iter()
            .any(|output| output.event_type == EventType::TURN_COMPLETED)
    );

    let host = ScriptedHost::new(vec![
        AppServerInbound::response(json!({ "ok": true })),
        AppServerInbound::response(json!({ "thread": { "id": "thr_no_diag" } })),
        AppServerInbound::response(json!({ "turn": { "id": "turn_1" } })),
        AppServerInbound::notification(
            "turn/completed",
            json!({ "threadId": "thr_no_diag", "turn": { "status": "completed" } }),
        ),
    ]);
    let adapter = CodexAppServerBackendAdapter::new(Arc::new(host), "/repo");
    let mut input = BackendSend::new("hello");
    input.session_id = Some(SessionId::from("ses_no_diag"));

    let outputs = support::collect_backend_outputs(&adapter, input)
        .await
        .unwrap();
    assert!(
        outputs
            .iter()
            .all(|output| output.payload["code"] != "codex_app_server_trace")
    );
}

#[tokio::test]
async fn codex_app_server_adapter_interrupts_active_turn_by_session() {
    let host = ScriptedHost::new(vec![
        AppServerInbound::response(json!({ "ok": true })),
        AppServerInbound::response(json!({ "thread": { "id": "thr_interrupt" } })),
        AppServerInbound::response(json!({ "turn": { "id": "turn_1" } })),
        AppServerInbound::response(json!({ "interrupted": true })),
    ]);
    let adapter = Arc::new(CodexAppServerBackendAdapter::new(
        Arc::new(host.clone()),
        "/repo",
    ));
    let (sink, mut receiver) = backend_output_channel(16);
    let mut input = BackendSend::new("long task");
    input.session_id = Some(SessionId::from("ses_interrupt"));
    input.resolved_agent_config = Some(ResolvedAgentConfig {
        backend: BackendKind::Codex,
        config: Default::default(),
    });

    let stream_adapter = adapter.clone();
    let stream = tokio::spawn(async move { stream_adapter.stream_user_message(input, sink).await });
    wait_for_call_count(&host, 3).await;

    adapter
        .cancel(BackendCancel {
            session_id: "ses_interrupt".to_string(),
            backend: Some(BackendKind::Codex),
        })
        .await
        .expect("cancel codex turn");

    let cancelled = receiver
        .recv()
        .await
        .expect("cancel output")
        .expect("cancel output ok");
    assert_eq!(cancelled.event_type, EventType::TURN_CANCELLED);
    assert_eq!(cancelled.payload["reason"], "user_cancelled");
    stream.await.expect("stream task").expect("stream ok");

    let calls = host.calls().await;
    assert_eq!(calls[3].method, "turn/interrupt");
    assert_eq!(calls[3].params["threadId"], "thr_interrupt");
}
