use serde_json::json;
use vela_core::{CommandId, EventCursor, SessionId};
use vela_protocol::{
    AcceptedCommandResponse, EventStreamMessage, RestCommandResponse, WireEventCursor,
};

mod support;

#[test]
fn rest_command_response_preserves_openapi_command_ack_shape() {
    let response = RestCommandResponse::Accepted(AcceptedCommandResponse {
        command_id: CommandId::from("cmd_1"),
        session_id: SessionId::from("ses_1"),
        turn_id: None,
        cursor: WireEventCursor::new(
            "evt_1",
            EventCursor {
                event_id: "evt_1".into(),
                epoch: 1,
                seq: 2,
            },
        ),
    });

    let wire = serde_json::to_value(response).expect("serialize response");

    assert_eq!(
        wire,
        support::openapi_example_fixture("accepted_command_ack")
    );
}

#[test]
fn sse_envelope_uses_snake_case_wire_names() {
    let message = EventStreamMessage {
        event_id: "evt_1".to_string(),
        event_type: "assistant.message.delta".to_string(),
        session_id: "ses_1".to_string(),
        cursor: EventCursor {
            event_id: "evt_1".into(),
            epoch: 1,
            seq: 9,
        },
        payload: json!({ "delta": "hello" }),
    };

    let wire = serde_json::to_value(message).expect("serialize message");

    assert_eq!(wire["event_id"], "evt_1");
    assert_eq!(wire["event_type"], "assistant.message.delta");
    assert_eq!(wire["session_id"], "ses_1");
}

#[test]
fn codex_diagnostic_trace_fixture_keeps_shape_without_private_content() {
    let trace = support::diagnostic_trace_fixture("codex_trace_shape");

    assert_eq!(
        trace
            .iter()
            .map(|line| line["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "session_meta",
            "turn_context",
            "event_msg",
            "response_item",
            "response_item",
        ]
    );
    assert!(trace.iter().all(|line| {
        line["source"]
            .as_str()
            .is_some_and(|source| source.contains(".codex"))
    }));
    assert_eq!(trace[0]["payload"]["cwd"], "<redacted>");
    assert_eq!(trace[2]["payload"]["content_shape"], "text");
    assert_eq!(trace[4]["payload"]["tool_name"], "shell");
}
