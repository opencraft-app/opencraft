use crate::support::codex_app_server::{ScriptedHost, run_codex_request_round_trip};
use serde_json::json;
use std::sync::Arc;
use vela_backends::{
    AppServerInbound, BackendAdapter, BackendCancel, BackendRequestResponse, BackendSend,
    CodexAppServerBackendAdapter, backend_output_channel,
};
use vela_core::{BackendKind, EventType, SessionId};

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
    assert_eq!(calls[3].params["turnId"], "turn_1");
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
