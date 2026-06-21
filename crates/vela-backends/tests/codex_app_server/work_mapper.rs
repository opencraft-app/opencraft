use serde_json::json;
use vela_backends::{codex, normalize_codex_app_server_notification};
use vela_core::EventType;

#[test]
fn codex_capabilities_build_thread_start_params_without_session_adapter() {
    let mut input = vela_backends::BackendSend::new("inspect");
    input.working_directory = Some("/repo".to_string());
    input.resolved_agent_config = Some(vela_core::ResolvedAgentConfig {
        backend: vela_core::BackendKind::Codex,
        config: vela_core::AgentConfig {
            model: Some("gpt-5.4".to_string()),
            reasoning_effort: Some("high".to_string()),
            permission_mode: Some(vela_core::PermissionMode::FullAccess),
            feature_values: Default::default(),
        },
    });

    let params = codex::capabilities::thread_start_params(&input, "/fallback");

    assert_eq!(params["cwd"], "/repo");
    assert_eq!(params["model"], "gpt-5.4");
    assert_eq!(params["reasoningEffort"], "high");
    assert_eq!(params["sandbox"], "danger-full-access");
    assert_eq!(params["approvalPolicy"], "never");
    assert_eq!(params["networkAccess"], true);
}

#[test]
fn codex_work_mapper_normalizes_command_lifecycle_without_ui_hack() {
    let outputs = codex::work_mapper::map_codex_work_notification(
        "codex/event/exec_command_begin",
        json!({ "msg": { "call_id": "cmd_1", "command": ["cargo", "test"], "cwd": "/repo" } }),
    )
    .expect("command begin should map to agent work output");

    assert_eq!(outputs[0].event_type, EventType::COMMAND_STARTED);
    assert_eq!(outputs[0].payload["command_id"], "cmd_1");
    assert_eq!(outputs[0].payload["command"], "cargo test");
    assert_eq!(outputs[0].payload["status"], "running");

    let outputs = codex::work_mapper::map_codex_work_notification(
        "codex/event/exec_command_end",
        json!({
            "msg": {
                "call_id": "cmd_1",
                "command": ["cargo", "test"],
                "success": false,
                "exitCode": 101,
                "stderr": "failed"
            }
        }),
    )
    .expect("command end should map to agent work output");

    assert_eq!(outputs[0].event_type, EventType::COMMAND_FAILED);
    assert_eq!(outputs[0].payload["exit_code"], 101);
    assert_eq!(outputs[0].payload["stderr"], "failed");
}

#[test]
fn codex_paseo_thread_item_fixture_maps_real_tool_shapes() {
    let fixture = codex::fixtures::load_codex_app_server_fixture("paseo_thread_items.json")
        .expect("load migrated paseo codex fixture");
    let outputs = codex::fixtures::replay_codex_app_server_fixture(&fixture);

    assert_eq!(
        outputs
            .iter()
            .map(|output| output.event_type.0)
            .collect::<Vec<_>>(),
        fixture.expect_event_types
    );

    assert_eq!(outputs[0].payload["command_id"], "cmd_wrapper_array");
    assert_eq!(outputs[0].payload["command"], "echo hello");
    assert_eq!(outputs[0].payload["cwd"], "/tmp/repo");

    assert_eq!(outputs[1].payload["command_id"], "cmd_envelope_output");
    assert_eq!(outputs[1].payload["output"], "hello");
    assert_eq!(outputs[1].payload["exit_code"], 0);

    assert_eq!(outputs[2].payload["tool_id"], "read_array");
    assert_eq!(outputs[2].payload["name"], "read_file");
    assert_eq!(outputs[2].payload["detail"]["type"], "read");
    assert_eq!(outputs[2].payload["detail"]["file_path"], "README.md");
    assert_eq!(
        outputs[2].payload["detail"]["content"],
        "line one\nline two"
    );

    assert_eq!(outputs[3].payload["detail"]["type"], "edit");
    assert_eq!(
        outputs[3].payload["detail"]["file_path"],
        "src/object-map.ts"
    );
    assert_eq!(
        outputs[3].payload["detail"]["unified_diff"],
        "@@\n-old\n+new\n"
    );

    assert_eq!(outputs[4].payload["detail"]["type"], "unknown");
    assert_eq!(
        outputs[4].payload["detail"]["input"]["files"][0]["path"],
        "src/path-only.ts"
    );

    assert_eq!(outputs[5].payload["name"], "web_search");
    assert_eq!(outputs[5].payload["detail"]["type"], "search");
    assert_eq!(outputs[5].payload["detail"]["query"], "codex timeline");
    assert_eq!(outputs[5].payload["detail"]["mode"], "web");
}

#[test]
fn codex_paseo_mapper_edge_fixture_preserves_file_change_semantics() {
    let fixture = codex::fixtures::load_codex_app_server_fixture("paseo_mapper_edges.json")
        .expect("load migrated paseo mapper edge fixture");
    let outputs = codex::fixtures::replay_codex_app_server_fixture(&fixture);

    assert_eq!(
        outputs
            .iter()
            .map(|output| output.event_type.0)
            .collect::<Vec<_>>(),
        fixture.expect_event_types
    );

    assert_eq!(outputs[0].payload["command"], "echo hello");
    assert_eq!(outputs[0].payload["cwd"], "C:\\repo");

    assert_eq!(outputs[1].payload["detail"]["type"], "edit");
    assert_eq!(
        outputs[1].payload["detail"]["file_path"],
        "src/dead-module.ts"
    );
    assert_eq!(
        outputs[1].payload["detail"]["unified_diff"],
        "diff --git a/src/dead-module.ts b/src/dead-module.ts\n--- a/src/dead-module.ts\n+++ /dev/null"
    );

    assert_eq!(outputs[2].payload["detail"]["type"], "edit");
    assert_eq!(outputs[2].payload["detail"]["file_path"], "src/old.ts");
    assert_eq!(
        outputs[2].payload["detail"]["unified_diff"],
        "diff --git a/src/old.ts b/src/old.ts\n--- a/src/old.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-export const old = true;\n-export function gone() {}"
    );

    assert_eq!(outputs[3].payload["detail"]["type"], "edit");
    assert_eq!(
        outputs[3].payload["detail"]["file_path"],
        "src/from-file-change.ts"
    );
    assert_eq!(
        outputs[3].payload["detail"]["unified_diff"],
        "diff --git a/src/from-file-change.ts b/src/from-file-change.ts\n--- a/src/from-file-change.ts\n+++ b/src/from-file-change.ts\n@@\n-alpha\n+beta"
    );
}

#[test]
fn codex_work_mapper_still_flows_through_public_normalizer() {
    let outputs = normalize_codex_app_server_notification(
        "codex/event/exec_command_end",
        json!({
            "msg": {
                "call_id": "cmd_public",
                "command": ["cargo", "test"],
                "success": true,
                "stdout": "ok"
            }
        }),
    );

    assert_eq!(outputs[0].event_type, EventType::COMMAND_COMPLETED);
    assert_eq!(outputs[0].payload["command"], "cargo test");
    assert_eq!(outputs[0].payload["output"], "ok");
}
