use serde_json::json;
use vela_backends::{codex, normalize_codex_app_server_notification};
use vela_core::EventType;

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
    let fixture = codex::fixtures::load_codex_app_server_fixture("basic_stream.json")
        .expect("load codex fixture");
    let outputs = codex::fixtures::replay_codex_app_server_fixture(&fixture);

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

#[test]
fn codex_raw_fixture_harness_absorbs_control_plane_and_keeps_business_events() {
    let fixture = codex::fixtures::load_codex_app_server_fixture("control_plane_and_business.json")
        .expect("load codex fixture");
    let replay = codex::fixtures::replay_codex_app_server_fixture_with_trace(&fixture);
    let outputs = replay.outputs;

    assert_eq!(
        outputs
            .iter()
            .map(|output| output.event_type.0)
            .collect::<Vec<_>>(),
        fixture.expect_event_types
    );
    assert_eq!(outputs.len(), 2);
    assert_eq!(outputs[0].payload["delta"], "kept");
    assert_eq!(outputs[1].payload["status"], "completed");
    assert!(
        outputs
            .iter()
            .all(|output| output.event_type != EventType::WARNING_RAISED),
        "control-plane notifications must be absorbed, not downgraded into user-visible warnings"
    );
    assert_eq!(
        replay
            .trace
            .iter()
            .map(|record| record.method.as_str())
            .collect::<Vec<_>>(),
        vec![
            "remoteControl/status/changed",
            "mcpServer/startupStatus/updated",
            "thread/status/changed",
            "account/rateLimits/updated",
        ]
    );
    assert!(
        replay
            .trace
            .iter()
            .all(|record| record.kind == "control_plane"),
        "fixture replay should preserve absorbed control-plane telemetry for adapter diagnostics"
    );
}
