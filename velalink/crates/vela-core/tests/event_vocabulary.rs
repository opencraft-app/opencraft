use vela_core::EventType;

#[test]
fn event_type_constants_match_documented_vocabulary() {
    let documented = [
        EventType::SESSION_CREATED,
        EventType::SESSION_UPDATED,
        EventType::SESSION_STATUS_CHANGED,
        EventType::SESSION_CLOSED,
        EventType::BACKEND_STATUS_CHANGED,
        EventType::USER_MESSAGE_ACCEPTED,
        EventType::INPUT_QUEUED,
        EventType::INPUT_REJECTED,
        EventType::TURN_CANCEL_ACCEPTED,
        EventType::REQUEST_RESPONSE_ACCEPTED,
        EventType::TURN_STARTED,
        EventType::TURN_COMPLETED,
        EventType::TURN_FAILED,
        EventType::TURN_CANCELLED,
        EventType::ASSISTANT_MESSAGE_STARTED,
        EventType::ASSISTANT_MESSAGE_DELTA,
        EventType::ASSISTANT_MESSAGE_COMPLETED,
        EventType::ASSISTANT_REASONING_DELTA,
        EventType::ASSISTANT_REASONING_COMPLETED,
        EventType::TOOL_STARTED,
        EventType::TOOL_UPDATED,
        EventType::TOOL_OUTPUT_DELTA,
        EventType::TOOL_COMPLETED,
        EventType::TOOL_FAILED,
        EventType::TASK_STARTED,
        EventType::TASK_UPDATED,
        EventType::TASK_COMPLETED,
        EventType::REQUEST_OPENED,
        EventType::REQUEST_UPDATED,
        EventType::REQUEST_RESOLVED,
        EventType::DIFF_UPDATED,
        EventType::USAGE_UPDATED,
        EventType::WARNING_RAISED,
        EventType::ERROR_RAISED,
        EventType::PROJECTION_INVALIDATED,
    ];

    assert!(
        documented
            .iter()
            .all(|event_type| event_type.0.contains('.'))
    );
    assert!(
        !documented
            .iter()
            .any(|event_type| event_type.0.starts_with("tool_call"))
    );
}
