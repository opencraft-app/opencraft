use std::collections::BTreeMap;

use serde_json::json;
use vela_core::{
    AcceptedCommandAck, AgentConfig, BackendFeature, BackendKind, BackendModel, CanonicalEvent,
    CommandAck, CommandId, EventCursor, EventSource, EventType, PermissionMode,
    PermissionModeOption, ResolvedAgentConfig, SessionId,
};

mod support;

#[test]
fn command_ack_serializes_as_snake_case_status_union() {
    let ack = CommandAck::Accepted(AcceptedCommandAck {
        command_id: CommandId::from("cmd_1"),
        session_id: SessionId::from("ses_1"),
        cursor: EventCursor {
            event_id: "evt_7".into(),
            epoch: 1,
            seq: 7,
        },
        turn_id: None,
    });

    let value = serde_json::to_value(&ack).expect("serialize ack");

    assert_eq!(value, support::command_ack_fixture("accepted"));
}

#[test]
fn canonical_event_keeps_wire_names_snake_case() {
    let event = CanonicalEvent::new(
        SessionId::from("ses_1"),
        EventType::USER_MESSAGE_ACCEPTED,
        EventSource::runtime("vela-runtime"),
        json!({ "content": "hello" }),
    )
    .with_cursor(1, 2);

    let value = serde_json::to_value(event).expect("serialize event");

    assert_eq!(value["event_type"], "user.message.accepted");
    assert_eq!(value["session_id"], "ses_1");
    assert_eq!(
        value["affected_views"],
        json!(["session", "transcript", "timeline", "workbench"])
    );
    assert_eq!(value["source"]["kind"], "runtime");
}

#[test]
fn backend_kind_serializes_as_openapi_wire_literals() {
    assert_eq!(serde_json::to_value(BackendKind::Pi).unwrap(), json!("pi"));
    assert_eq!(
        serde_json::to_value(BackendKind::Codex).unwrap(),
        json!("codex")
    );
    assert_eq!(
        serde_json::to_value(BackendKind::Acp).unwrap(),
        json!("acp")
    );
}

#[test]
fn agent_config_serializes_wire_fields_and_feature_values() {
    let config = AgentConfig {
        model: Some("minimax-m2.7".to_string()),
        reasoning_effort: Some("high".to_string()),
        permission_mode: Some(PermissionMode::FullAccess),
        feature_values: BTreeMap::from([
            ("fast_mode".to_string(), json!(true)),
            ("plan_mode".to_string(), json!(false)),
        ]),
    };

    let value = serde_json::to_value(config).expect("serialize agent config");

    assert_eq!(
        value,
        json!({
            "model": "minimax-m2.7",
            "reasoning_effort": "high",
            "permission_mode": "full_access",
            "feature_values": {
                "fast_mode": true,
                "plan_mode": false
            }
        })
    );
}

#[test]
fn resolved_agent_config_includes_backend_and_agent_config() {
    let resolved = ResolvedAgentConfig {
        backend: BackendKind::Pi,
        config: AgentConfig {
            model: Some("minimax-m2.7".to_string()),
            reasoning_effort: Some("medium".to_string()),
            permission_mode: Some(PermissionMode::Auto),
            feature_values: Default::default(),
        },
    };

    let value = serde_json::to_value(resolved).expect("serialize resolved config");

    assert_eq!(
        value,
        json!({
            "backend": "pi",
            "model": "minimax-m2.7",
            "reasoning_effort": "medium",
            "permission_mode": "auto",
            "feature_values": {}
        })
    );
}

#[test]
fn backend_discovery_types_have_stable_wire_shape() {
    let model = BackendModel {
        id: "gpt-5".to_string(),
        label: "GPT-5".to_string(),
        description: None,
        is_default: true,
        reasoning_efforts: vec![],
        metadata: Default::default(),
    };
    let permission = PermissionModeOption {
        id: PermissionMode::Auto,
        label: "Auto".to_string(),
        description: None,
        is_default: true,
        metadata: Default::default(),
    };
    let feature = BackendFeature::Toggle {
        id: "fast_mode".to_string(),
        label: "Fast".to_string(),
        description: None,
        default_value: false,
        metadata: Default::default(),
    };

    assert_eq!(serde_json::to_value(model).unwrap()["is_default"], true);
    assert_eq!(serde_json::to_value(permission).unwrap()["id"], "auto");
    assert_eq!(serde_json::to_value(feature).unwrap()["type"], "toggle");
}

#[test]
fn accepted_command_ack_requires_cursor_and_identity_fields() {
    let missing_cursor = json!({
        "status": "accepted",
        "command_id": "cmd_1",
        "session_id": "ses_1"
    });

    assert!(serde_json::from_value::<CommandAck>(missing_cursor).is_err());
}

#[test]
fn queued_command_ack_requires_queued_message_id() {
    let missing_queue_id = json!({
        "status": "queued",
        "command_id": "cmd_1",
        "session_id": "ses_1",
        "cursor": { "event_id": "evt_1", "epoch": 1, "seq": 1 }
    });

    assert!(serde_json::from_value::<CommandAck>(missing_queue_id).is_err());
}

#[test]
fn rejected_command_ack_only_requires_code_and_message() {
    let ack =
        serde_json::from_value::<CommandAck>(support::command_ack_fixture("rejected_minimal"))
            .expect("rejected ack");

    match ack {
        CommandAck::Rejected(rejected) => {
            assert_eq!(rejected.code, "turn_running");
            assert!(rejected.cursor.is_none());
            assert!(rejected.command_id.is_none());
            assert!(rejected.session_id.is_none());
        }
        other => panic!("expected rejected ack, got {other:?}"),
    }
}
