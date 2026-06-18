use serde_json::json;
use vela_core::{
    AcceptedCommandAck, BackendKind, CanonicalEvent, CommandAck, CommandId, EventCursor,
    EventSource, EventType, SessionId,
};

#[test]
fn command_ack_serializes_as_snake_case_status_union() {
    let ack = CommandAck::Accepted(AcceptedCommandAck {
        command_id: CommandId::from("cmd_1"),
        session_id: SessionId::from("ses_1"),
        cursor: EventCursor { epoch: 1, seq: 7 },
        turn_id: None,
    });

    let value = serde_json::to_value(&ack).expect("serialize ack");

    assert_eq!(
        value,
        json!({
            "status": "accepted",
            "command_id": "cmd_1",
            "session_id": "ses_1",
            "cursor": { "epoch": 1, "seq": 7 }
        })
    );
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
    assert_eq!(value["affected_views"], json!([]));
    assert_eq!(value["source"]["kind"], "runtime");
}

#[test]
fn backend_kind_serializes_pi_as_snake_case_literal() {
    assert_eq!(serde_json::to_value(BackendKind::Pi).unwrap(), json!("pi"));
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
        "cursor": { "epoch": 1, "seq": 1 }
    });

    assert!(serde_json::from_value::<CommandAck>(missing_queue_id).is_err());
}

#[test]
fn rejected_command_ack_only_requires_code_and_message() {
    let ack = serde_json::from_value::<CommandAck>(json!({
        "status": "rejected",
        "code": "turn_running",
        "message": "session already has a running turn"
    }))
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
