mod support;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::Mutex;
use vela_backends::{
    AppServerInbound, BackendAdapter, BackendCancel, BackendOutput, BackendRequestResponse,
    BackendRouter, BackendSend, CodexAppServerBackendAdapter, CodexAppServerConnection,
    CodexAppServerHost, MockBackendAdapter, backend_output_channel,
    normalize_codex_app_server_notification,
};
use vela_core::{BackendKind, EventType, ResolvedAgentConfig, SessionId};

#[test]
fn codex_app_server_notifications_normalize_to_canonical_backend_outputs() {
    let outputs = normalize_codex_app_server_notification(
        "item/agentMessage/delta",
        json!({ "threadId": "thr_1", "itemId": "msg_1", "delta": "hello" }),
    );
    assert_eq!(outputs.len(), 1);
    assert_eq!(outputs[0].event_type, EventType::ASSISTANT_MESSAGE_DELTA);
    assert_eq!(outputs[0].payload["message_id"], "msg_1");
    assert_eq!(outputs[0].payload["delta"], "hello");
    assert_eq!(
        outputs[0].raw.as_ref().unwrap()["method"],
        "item/agentMessage/delta"
    );

    let outputs = normalize_codex_app_server_notification(
        "item/reasoning/summaryTextDelta",
        json!({ "itemId": "rsn_1", "delta": "thinking" }),
    );
    assert_eq!(outputs[0].event_type, EventType::ASSISTANT_REASONING_DELTA);
    assert_eq!(outputs[0].payload["reasoning_id"], "rsn_1");

    let outputs = normalize_codex_app_server_notification(
        "codex/event/exec_command_begin",
        json!({ "msg": { "call_id": "cmd_1", "command": "cargo test", "cwd": "/repo" } }),
    );
    assert_eq!(outputs[0].event_type, EventType::COMMAND_STARTED);
    assert_eq!(outputs[0].payload["command_id"], "cmd_1");
    assert_eq!(outputs[0].payload["command"], "cargo test");

    let outputs = normalize_codex_app_server_notification(
        "turn/completed",
        json!({ "threadId": "thr_1", "turn": { "status": "completed" } }),
    );
    assert_eq!(outputs[0].event_type, EventType::TURN_COMPLETED);
}

#[test]
fn codex_app_server_normalizer_absorbs_normal_item_lifecycle_without_warning() {
    assert!(
        normalize_codex_app_server_notification(
            "item/started",
            json!({ "threadId": "thr_1", "item": { "id": "item_1", "type": "agentMessage" } }),
        )
        .is_empty()
    );
    assert!(
        normalize_codex_app_server_notification(
            "item/completed",
            json!({ "threadId": "thr_1", "item": { "id": "item_1", "type": "agentMessage" } }),
        )
        .is_empty()
    );
}

#[test]
fn codex_app_server_normalizer_absorbs_control_plane_notifications_without_warning() {
    let notifications = [
        (
            "remoteControl/status/changed",
            json!({ "serverName": "Mac", "status": "disabled" }),
        ),
        (
            "mcpServer/startupStatus/updated",
            json!({ "name": "node_repl", "status": "ready", "error": null }),
        ),
        (
            "thread/status/changed",
            json!({ "threadId": "thr_1", "status": { "type": "active" } }),
        ),
        (
            "account/rateLimits/updated",
            json!({ "rateLimits": { "limitId": "codex", "planType": "pro" } }),
        ),
        (
            "warning",
            json!({ "message": "Skill descriptions were shortened to fit the context budget." }),
        ),
        (
            "error",
            json!({
                "threadId": "thr_1",
                "turnId": "turn_1",
                "error": {
                    "codexErrorInfo": "contextWindowExceeded",
                    "message": "Codex ran out of room in the model's context window."
                }
            }),
        ),
    ];

    for (method, params) in notifications {
        let outputs = normalize_codex_app_server_notification(method, params);
        assert!(
            outputs.is_empty(),
            "{method} should be logged as provider control-plane diagnostics, not projected as canonical events: {outputs:#?}"
        );
    }
}

#[test]
fn codex_app_server_normalizer_maps_plan_diff_usage_compaction_and_failed_turn() {
    let outputs = normalize_codex_app_server_notification(
        "turn/plan/updated",
        json!({
            "plan": [
                { "step": "Inspect repo", "status": "completed" },
                { "step": "Patch code", "status": "in_progress" }
            ]
        }),
    );
    assert_eq!(outputs[0].event_type, EventType::TASK_UPDATED);
    assert_eq!(outputs[0].payload["task_type"], "plan");
    assert_eq!(outputs[0].payload["steps"][1]["step"], "Patch code");

    let outputs = normalize_codex_app_server_notification(
        "turn/diff/updated",
        json!({ "diff": "diff --git a/a b/a" }),
    );
    assert_eq!(outputs[0].event_type, EventType::DIFF_UPDATED);

    let outputs = normalize_codex_app_server_notification(
        "thread/tokenUsage/updated",
        json!({ "tokenUsage": { "last": { "inputTokens": 12 } } }),
    );
    assert_eq!(outputs[0].event_type, EventType::USAGE_UPDATED);

    let outputs = normalize_codex_app_server_notification(
        "thread/compacted",
        json!({ "threadId": "thr_1", "turnId": "turn_1" }),
    );
    assert_eq!(outputs[0].event_type, EventType::TASK_UPDATED);
    assert_eq!(outputs[0].payload["task_type"], "context_compaction");

    let outputs = normalize_codex_app_server_notification(
        "turn/completed",
        json!({
            "threadId": "thr_1",
            "turn": { "status": "failed", "error": { "message": "boom" } }
        }),
    );
    assert_eq!(outputs[0].event_type, EventType::TURN_FAILED);
    assert_eq!(outputs[0].payload["error"], "boom");
}

#[test]
fn codex_app_server_normalizer_maps_command_output_and_unknown_method_safely() {
    let outputs = normalize_codex_app_server_notification(
        "codex/event/exec_command_output_delta",
        json!({ "msg": { "call_id": "cmd_1", "stream": "stderr", "chunk": "warn" } }),
    );
    assert_eq!(outputs[0].event_type, EventType::COMMAND_OUTPUT_DELTA);
    assert_eq!(outputs[0].payload["stream"], "stderr");
    assert_eq!(outputs[0].payload["delta"], "warn");

    let outputs = normalize_codex_app_server_notification(
        "codex/event/exec_command_end",
        json!({
            "msg": {
                "call_id": "cmd_1",
                "command": ["cargo", "test"],
                "success": false,
                "exit_code": 101,
                "stderr": "failed"
            }
        }),
    );
    assert_eq!(outputs[0].event_type, EventType::COMMAND_FAILED);
    assert_eq!(outputs[0].payload["command"], "cargo test");
    assert_eq!(outputs[0].payload["exit_code"], 101);

    let outputs =
        normalize_codex_app_server_notification("codex/brand_new_event", json!({ "x": 1 }));
    assert_eq!(outputs[0].event_type, EventType::WARNING_RAISED);
    assert_eq!(outputs[0].payload["code"], "codex_app_server_warning");
}

#[test]
fn codex_app_server_fixture_replays_notification_sequence_to_canonical_outputs() {
    let fixture = read_codex_fixture("basic_stream.json");
    let outputs = fixture
        .notifications
        .into_iter()
        .flat_map(|notification| {
            normalize_codex_app_server_notification(&notification.method, notification.params)
        })
        .collect::<Vec<_>>();

    assert_eq!(
        outputs
            .iter()
            .map(|output| output.event_type.0)
            .collect::<Vec<_>>(),
        fixture.expect_event_types
    );
    assert_eq!(outputs[0].payload["delta"], "Hello");
    assert_eq!(outputs[2].payload["command"], "cargo test");
    assert_eq!(outputs[3].payload["stream"], "stdout");
    assert_eq!(outputs[4].payload["status"], "completed");
    assert_eq!(
        outputs[5].payload["diff"],
        "diff --git a/src/lib.rs b/src/lib.rs"
    );
    assert_eq!(outputs[6].payload["task_type"], "plan");
    assert_eq!(outputs[7].payload["task_type"], "context_compaction");
    assert_eq!(outputs[8].payload["status"], "completed");
}

#[tokio::test]
async fn backend_router_dispatches_by_resolved_backend_kind() {
    let pi = Arc::new(MockBackendAdapter::new(vec![BackendOutput::event(
        EventType::TURN_COMPLETED,
        json!({ "backend": "pi" }),
    )]));
    let codex = Arc::new(MockBackendAdapter::new(vec![BackendOutput::event(
        EventType::TURN_COMPLETED,
        json!({ "backend": "codex" }),
    )]));
    let router = BackendRouter::new()
        .with_backend(BackendKind::Pi, pi.clone())
        .with_backend(BackendKind::Codex, codex.clone());

    let mut input = BackendSend::new("hello pi");
    input.resolved_agent_config = Some(ResolvedAgentConfig {
        backend: BackendKind::Pi,
        config: Default::default(),
    });
    let outputs = support::collect_backend_outputs(&router, input)
        .await
        .unwrap();
    assert_eq!(outputs[0].payload["backend"], "pi");

    let mut input = BackendSend::new("hello codex");
    input.resolved_agent_config = Some(ResolvedAgentConfig {
        backend: BackendKind::Codex,
        config: Default::default(),
    });
    let outputs = support::collect_backend_outputs(&router, input)
        .await
        .unwrap();
    assert_eq!(outputs[0].payload["backend"], "codex");

    assert_eq!(pi.prompt_count().await, 1);
    assert_eq!(codex.prompt_count().await, 1);
}

#[tokio::test]
async fn backend_router_dispatches_probe_and_cancel_by_backend_kind() {
    let pi = Arc::new(MockBackendAdapter::new(vec![]));
    let codex = Arc::new(MockBackendAdapter::new(vec![]));
    let router = BackendRouter::new()
        .with_backend(BackendKind::Pi, pi.clone())
        .with_backend(BackendKind::Codex, codex.clone());

    router
        .probe_backend(Some(BackendKind::Codex))
        .await
        .expect("probe codex");
    router
        .cancel(BackendCancel {
            session_id: "ses_codex".to_string(),
            backend: Some(BackendKind::Codex),
        })
        .await
        .expect("cancel codex");

    assert_eq!(pi.probe_count().await, 0);
    assert_eq!(pi.cancel_count().await, 0);
    assert_eq!(codex.probe_count().await, 1);
    assert_eq!(codex.cancel_count().await, 1);
}

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
        config: Default::default(),
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
    assert_eq!(calls[3].params["threadId"], "thr_1");
    assert_eq!(calls[3].params["input"][0]["text"], "again");
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

#[tokio::test]
async fn codex_app_server_adapter_opens_permission_request_and_resumes_after_response() {
    let host = ScriptedHost::new(vec![
        AppServerInbound::response(json!({ "ok": true })),
        AppServerInbound::response(json!({ "thread": { "id": "thr_permission" } })),
        AppServerInbound::response(json!({ "turn": { "id": "turn_1" } })),
        AppServerInbound::request(
            41,
            "item/commandExecution/requestApproval",
            json!({ "itemId": "cmd_approval", "command": "cargo test", "cwd": "/repo" }),
        ),
        AppServerInbound::notification(
            "turn/completed",
            json!({ "threadId": "thr_permission", "turn": { "status": "completed" } }),
        ),
    ]);
    let adapter = Arc::new(CodexAppServerBackendAdapter::new(
        Arc::new(host.clone()),
        "/repo",
    ));
    let (sink, mut receiver) = backend_output_channel(16);
    let mut input = BackendSend::new("needs approval");
    input.session_id = Some(SessionId::from("ses_permission"));
    input.resolved_agent_config = Some(ResolvedAgentConfig {
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
    assert_eq!(opened.event_type, EventType::REQUEST_OPENED);
    assert_eq!(opened.payload["request_id"], "codex_request_41");
    assert_eq!(opened.payload["kind"], "permission");
    assert_eq!(opened.payload["title"], "Approve command");
    assert_eq!(opened.payload["command"], "cargo test");

    adapter
        .respond_to_request(BackendRequestResponse {
            session_id: SessionId::from("ses_permission"),
            backend: Some(BackendKind::Codex),
            request_id: "codex_request_41".to_string(),
            result: Some("allow".to_string()),
            scope: Some("once".to_string()),
            answer: None,
            content: None,
            options: None,
        })
        .await
        .expect("respond to codex request");

    let completed = receiver
        .recv()
        .await
        .expect("turn completed output")
        .expect("turn completed ok");
    assert_eq!(completed.event_type, EventType::TURN_COMPLETED);
    stream.await.expect("stream task").expect("stream ok");

    let responses = host.responses().await;
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0].id, 41);
    assert_eq!(responses[0].result["decision"], "accept");
}

#[tokio::test]
async fn codex_app_server_adapter_interrupts_while_permission_request_is_pending() {
    let host = ScriptedHost::new(vec![
        AppServerInbound::response(json!({ "ok": true })),
        AppServerInbound::response(json!({ "thread": { "id": "thr_permission_cancel" } })),
        AppServerInbound::response(json!({ "turn": { "id": "turn_1" } })),
        AppServerInbound::request(
            42,
            "item/commandExecution/requestApproval",
            json!({ "itemId": "cmd_approval", "command": "rm -rf target", "cwd": "/repo" }),
        ),
        AppServerInbound::response(json!({ "interrupted": true })),
    ]);
    let adapter = Arc::new(CodexAppServerBackendAdapter::new(
        Arc::new(host.clone()),
        "/repo",
    ));
    let (sink, mut receiver) = backend_output_channel(16);
    let mut input = BackendSend::new("needs approval then cancel");
    input.session_id = Some(SessionId::from("ses_permission_cancel"));
    input.resolved_agent_config = Some(ResolvedAgentConfig {
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
    assert_eq!(opened.event_type, EventType::REQUEST_OPENED);

    adapter
        .cancel(BackendCancel {
            session_id: "ses_permission_cancel".to_string(),
            backend: Some(BackendKind::Codex),
        })
        .await
        .expect("cancel codex turn while pending permission");

    let cancelled = receiver
        .recv()
        .await
        .expect("turn cancelled output")
        .expect("turn cancelled ok");
    assert_eq!(cancelled.event_type, EventType::TURN_CANCELLED);
    stream.await.expect("stream task").expect("stream ok");

    let responses = host.responses().await;
    assert_eq!(responses[0].id, 42);
    assert_eq!(responses[0].result["decision"], "cancel");
    let calls = host.calls().await;
    assert_eq!(calls[3].method, "turn/interrupt");
    assert_eq!(calls[3].params["threadId"], "thr_permission_cancel");
}

#[tokio::test]
async fn codex_app_server_adapter_absorbs_current_permission_and_elicitation_requests() {
    let cases = [
        (
            "item/permissions/requestApproval",
            json!({
                "itemId": "perm_1",
                "threadId": "thr_request",
                "turnId": "turn_1",
                "cwd": "/repo",
                "permissions": { "filesystem": { "read": ["/repo"], "write": ["/repo/tmp"] } },
                "reason": "Need write access"
            }),
            "Approve permissions",
            "permission",
            "tool_confirmation",
        ),
        (
            "mcpServer/elicitation/request",
            json!({
                "serverName": "linear",
                "threadId": "thr_request",
                "turnId": "turn_1",
                "mode": "form",
                "message": "Pick an issue",
                "requestedSchema": {
                    "type": "object",
                    "properties": { "issue": { "type": "string" } }
                }
            }),
            "MCP server request",
            "question",
            "request_answer",
        ),
    ];

    for (method, params, title, kind, request_type) in cases {
        let (opened, responses) = run_codex_request_round_trip(
            method,
            params,
            BackendRequestResponse {
                session_id: SessionId::from("ses_request"),
                backend: Some(BackendKind::Codex),
                request_id: "codex_request_51".to_string(),
                result: Some("allow".to_string()),
                scope: Some("session".to_string()),
                answer: Some("{\"issue\":\"ENG-1\"}".to_string()),
                content: None,
                options: None,
            },
        )
        .await;

        assert_eq!(opened.event_type, EventType::REQUEST_OPENED);
        assert_eq!(opened.payload["title"], title);
        assert_eq!(opened.payload["kind"], kind);
        assert_eq!(opened.payload["request_type"], request_type);
        assert_eq!(responses[0].id, 51);
        assert_ne!(responses[0].result["decision"], "decline");
    }
}

#[tokio::test]
async fn codex_app_server_adapter_absorbs_legacy_exec_and_patch_approval_requests() {
    let (opened, responses) = run_codex_request_round_trip(
        "execCommandApproval",
        json!({
            "callId": "cmd_legacy",
            "conversationId": "thr_legacy",
            "command": ["cargo", "test"],
            "cwd": "/repo",
            "parsedCmd": [],
            "reason": "legacy command"
        }),
        BackendRequestResponse {
            session_id: SessionId::from("ses_request"),
            backend: Some(BackendKind::Codex),
            request_id: "codex_request_51".to_string(),
            result: Some("allow".to_string()),
            scope: Some("once".to_string()),
            answer: None,
            content: None,
            options: None,
        },
    )
    .await;
    assert_eq!(opened.payload["title"], "Approve command");
    assert_eq!(opened.payload["command"], "cargo test");
    assert_eq!(responses[0].result["decision"], "accept");

    let (opened, responses) = run_codex_request_round_trip(
        "applyPatchApproval",
        json!({
            "callId": "patch_legacy",
            "conversationId": "thr_legacy",
            "fileChanges": { "src/lib.rs": { "type": "modify" } },
            "grantRoot": "/repo",
            "reason": "legacy patch"
        }),
        BackendRequestResponse {
            session_id: SessionId::from("ses_request"),
            backend: Some(BackendKind::Codex),
            request_id: "codex_request_51".to_string(),
            result: Some("deny".to_string()),
            scope: Some("once".to_string()),
            answer: None,
            content: None,
            options: None,
        },
    )
    .await;
    assert_eq!(opened.payload["title"], "Approve file changes");
    assert_eq!(opened.payload["files"]["src/lib.rs"]["type"], "modify");
    assert_eq!(responses[0].result["decision"], "decline");
}

#[tokio::test]
async fn codex_app_server_adapter_round_trips_dynamic_tool_call_result() {
    let (opened, responses) = run_codex_request_round_trip(
        "item/tool/call",
        json!({
            "callId": "tool_1",
            "threadId": "thr_tool",
            "turnId": "turn_1",
            "tool": "pick_issue",
            "namespace": "mcp.linear",
            "arguments": { "query": "bug" }
        }),
        BackendRequestResponse {
            session_id: SessionId::from("ses_request"),
            backend: Some(BackendKind::Codex),
            request_id: "codex_request_51".to_string(),
            result: Some("allow".to_string()),
            scope: None,
            answer: None,
            content: Some(json!([
                { "type": "text", "text": "ENG-1" }
            ])),
            options: None,
        },
    )
    .await;

    assert_eq!(opened.event_type, EventType::REQUEST_OPENED);
    assert_eq!(opened.payload["kind"], "tool_call");
    assert_eq!(opened.payload["request_type"], "custom_tool_result");
    assert_eq!(opened.payload["tool"], "pick_issue");
    assert_eq!(responses[0].result["success"], true);
    assert_eq!(responses[0].result["contentItems"][0]["type"], "inputText");
    assert_eq!(responses[0].result["contentItems"][0]["text"], "ENG-1");
}

#[derive(Deserialize)]
struct CodexFixture {
    notifications: Vec<CodexFixtureNotification>,
    expect_event_types: Vec<String>,
}

#[derive(Deserialize)]
struct CodexFixtureNotification {
    method: String,
    params: Value,
}

fn read_codex_fixture(name: &str) -> CodexFixture {
    let path = format!("tests/fixtures/codex_app_server/{name}");
    let text = fs::read_to_string(&path).expect("read codex fixture");
    serde_json::from_str(&text).expect("parse codex fixture")
}

#[derive(Clone)]
struct ScriptedHost {
    state: Arc<Mutex<ScriptedState>>,
    connects: Arc<AtomicUsize>,
}

struct ScriptedState {
    inbound: VecDeque<AppServerInbound>,
    calls: Vec<RecordedCall>,
    responses: Vec<RecordedResponse>,
}

#[derive(Clone, Debug)]
struct RecordedCall {
    method: String,
    params: Value,
}

#[derive(Clone, Debug)]
struct RecordedResponse {
    id: i64,
    result: Value,
}

impl ScriptedHost {
    fn new(inbound: Vec<AppServerInbound>) -> Self {
        Self {
            state: Arc::new(Mutex::new(ScriptedState {
                inbound: VecDeque::from(inbound),
                calls: Vec::new(),
                responses: Vec::new(),
            })),
            connects: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn connect_count(&self) -> usize {
        self.connects.load(Ordering::SeqCst)
    }

    async fn calls(&self) -> Vec<RecordedCall> {
        self.state.lock().await.calls.clone()
    }

    async fn responses(&self) -> Vec<RecordedResponse> {
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

async fn wait_for_call_count(host: &ScriptedHost, expected: usize) {
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

async fn run_codex_request_round_trip(
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
    input.resolved_agent_config = Some(ResolvedAgentConfig {
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
