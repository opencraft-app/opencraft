use chrono::{TimeZone, Utc};
use serde_json::json;
use vela_core::{CanonicalEvent, ConversationItemKind, EventSource, EventType, SessionId};
use vela_projection::{
    ConversationWindowDirection, ConversationWindowQuery, project_conversation,
    project_conversation_window, project_pending_requests,
};

mod support;

fn event(seq: i64, event_type: EventType, payload: serde_json::Value) -> CanonicalEvent {
    CanonicalEvent::new(
        SessionId::from("ses_1"),
        event_type,
        EventSource::runtime("test"),
        payload,
    )
    .with_cursor(1, seq)
}

fn event_at(
    seq: i64,
    seconds: u32,
    event_type: EventType,
    payload: serde_json::Value,
) -> CanonicalEvent {
    let mut event = event(seq, event_type, payload);
    event.created_at = Utc.with_ymd_and_hms(2026, 6, 18, 10, 0, seconds).unwrap();
    event
}

#[test]
fn conversation_separates_messages_agent_work_and_requests() {
    let events = vec![
        event(
            1,
            EventType::USER_MESSAGE_ACCEPTED,
            json!({ "content": "hello" }),
        ),
        event(
            2,
            EventType::TOOL_OUTPUT_DELTA,
            json!({ "tool_id": "tool_1", "delta": "stdout should stay out" }),
        ),
        event(
            3,
            EventType::REQUEST_OPENED,
            json!({ "request_id": "req_1", "title": "Allow shell?", "content": "secret" }),
        ),
        event(
            4,
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "message_id": "msg_1", "delta": "hi" }),
        ),
        event(
            5,
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "message_id": "msg_1", "delta": " there" }),
        ),
    ];

    let conversation = project_conversation(&events);

    assert_eq!(
        conversation
            .items
            .iter()
            .map(|item| item.kind)
            .collect::<Vec<_>>(),
        vec![
            ConversationItemKind::UserMessage,
            ConversationItemKind::AgentWork,
            ConversationItemKind::AgentWork,
            ConversationItemKind::AssistantMessage,
        ]
    );
    assert_eq!(conversation.items[0].text.as_deref(), Some("hello"));
    assert_eq!(
        conversation.items[1].detail["delta"],
        "stdout should stay out"
    );
    assert_eq!(conversation.items[2].title.as_deref(), Some("Allow shell?"));
    assert_eq!(conversation.items[3].text.as_deref(), Some("hi there"));
}

#[test]
fn conversation_projects_user_image_blocks_as_parts() {
    let events = vec![event(
        1,
        EventType::USER_MESSAGE_ACCEPTED,
        json!({
            "content": "look at this",
            "blocks": [
                { "type": "text", "text": "look at this" },
                {
                    "type": "image",
                    "blob": {
                        "kind": "inline_base64",
                        "data": "aGVsbG8=",
                        "mime_type": "image/png",
                        "sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                        "size_bytes": 5
                    }
                }
            ]
        }),
    )];

    let conversation = project_conversation(&events);

    assert_eq!(conversation.items.len(), 1);
    let item = &conversation.items[0];
    assert_eq!(item.text.as_deref(), Some("look at this"));
    assert_eq!(item.parts.len(), 2);
    assert_eq!(item.parts[0].part_type, "text");
    assert_eq!(item.parts[0].text.as_deref(), Some("look at this"));
    assert_eq!(item.parts[1].part_type, "image");
    assert_eq!(item.parts[1].data["mime_type"], "image/png");
    assert_eq!(item.parts[1].data["data"], "aGVsbG8=");
    assert_eq!(item.parts[1].data["size_bytes"], 5);
}

#[test]
fn conversation_coalesces_tool_lifecycle_as_agent_work() {
    let events = vec![
        event_at(
            1,
            1,
            EventType::TOOL_STARTED,
            json!({ "tool_id": "tool_1", "name": "Search", "status": "running", "query": "import" }),
        ),
        event_at(
            2,
            2,
            EventType::TOOL_OUTPUT_DELTA,
            json!({ "tool_id": "tool_1", "delta": "12 matches" }),
        ),
        event_at(
            3,
            4,
            EventType::TOOL_COMPLETED,
            json!({ "tool_id": "tool_1", "name": "Search", "status": "completed", "exit_code": 0 }),
        ),
    ];

    let conversation = project_conversation(&events);

    assert_eq!(conversation.items.len(), 1);
    let work = &conversation.items[0];
    assert_eq!(work.kind, ConversationItemKind::AgentWork);
    assert_eq!(work.item_id, "work:tool_1");
    assert_eq!(work.title.as_deref(), Some("Search"));
    assert_eq!(work.status, "completed");
    assert_eq!(
        work.created_at,
        Utc.with_ymd_and_hms(2026, 6, 18, 10, 0, 1).unwrap()
    );
    assert_eq!(
        work.updated_at,
        Utc.with_ymd_and_hms(2026, 6, 18, 10, 0, 4).unwrap()
    );
    assert_eq!(work.detail["query"], "import");
    assert_eq!(work.detail["delta"], "12 matches");
    assert_eq!(work.detail["exit_code"], 0);
}

#[test]
fn conversation_deep_merges_tool_detail_without_erasing_start_args() {
    let events = vec![
        event_at(
            1,
            1,
            EventType::TOOL_STARTED,
            json!({
                "tool_id": "tool_1",
                "name": "bash",
                "status": "running",
                "detail": {
                    "type": "shell",
                    "command": "cargo test"
                }
            }),
        ),
        event_at(
            2,
            4,
            EventType::TOOL_COMPLETED,
            json!({
                "tool_id": "tool_1",
                "name": "bash",
                "status": "completed",
                "detail": {
                    "type": "shell",
                    "command": "",
                    "output": "ok\n",
                    "exit_code": 0
                }
            }),
        ),
    ];

    let conversation = project_conversation(&events);

    assert_eq!(conversation.items.len(), 1);
    let detail = &conversation.items[0].detail["detail"];
    assert_eq!(detail["type"], "shell");
    assert_eq!(detail["command"], "cargo test");
    assert_eq!(detail["output"], "ok\n");
    assert_eq!(detail["exit_code"], 0);
}

#[test]
fn conversation_unknown_tool_detail_does_not_downgrade_known_detail_type() {
    let events = vec![
        event_at(
            1,
            1,
            EventType::TOOL_STARTED,
            json!({
                "tool_id": "tool_1",
                "name": "bash",
                "status": "running",
                "detail": {
                    "type": "shell",
                    "command": "cargo test"
                }
            }),
        ),
        event_at(
            2,
            2,
            EventType::TOOL_OUTPUT_DELTA,
            json!({
                "tool_id": "tool_1",
                "name": "bash",
                "status": "running",
                "detail": {
                    "type": "unknown",
                    "input": { "raw": true }
                }
            }),
        ),
    ];

    let conversation = project_conversation(&events);

    assert_eq!(conversation.items.len(), 1);
    let detail = &conversation.items[0].detail["detail"];
    assert_eq!(detail["type"], "shell");
    assert_eq!(detail["command"], "cargo test");
    assert_eq!(detail["input"]["raw"], true);
}

#[test]
fn conversation_absorbs_acp_config_negotiation_warnings_as_diagnostics() {
    let events = vec![
        event_at(
            1,
            1,
            EventType::WARNING_RAISED,
            json!({
                "code": "acp_warning",
                "message": "ACP backend did not accept session model update",
                "turn_id": "turn_1"
            }),
        )
        .with_raw(json!({
            "error": "ACP response failed: {\"code\":-32601,\"data\":{\"method\":\"session/setModel\"},\"message\":\"Method not found\"}",
            "model": "minimax-m2.7"
        })),
        event_at(
            2,
            2,
            EventType::WARNING_RAISED,
            json!({
                "code": "acp_warning",
                "message": "ACP backend did not accept reasoning effort update",
                "turn_id": "turn_1"
            }),
        )
        .with_raw(json!({
            "error": "ACP response failed: {\"code\":-32601,\"data\":{\"method\":\"session/setConfigOption\"},\"message\":\"Method not found\"}",
            "reasoning_effort": "medium"
        })),
        event_at(
            3,
            3,
            EventType::WARNING_RAISED,
            json!({ "code": "provider_warning", "message": "real provider warning" }),
        ),
    ];

    let conversation = project_conversation(&events);

    assert_eq!(conversation.items.len(), 1);
    assert_eq!(conversation.items[0].kind, ConversationItemKind::AgentWork);
    assert_eq!(
        conversation.items[0].title.as_deref(),
        Some("real provider warning")
    );
    assert_eq!(conversation.items[0].status, "completed");
}

#[test]
fn conversation_treats_warning_and_error_as_terminal_work() {
    let events = vec![
        event_at(
            1,
            1,
            EventType::WARNING_RAISED,
            json!({ "message": "metadata is missing", "turn_id": "turn_1" }),
        ),
        event_at(
            2,
            2,
            EventType::ERROR_RAISED,
            json!({ "message": "provider failed", "turn_id": "turn_1" }),
        ),
    ];

    let conversation = project_conversation(&events);

    assert_eq!(conversation.items.len(), 2);
    assert_eq!(conversation.items[0].kind, ConversationItemKind::AgentWork);
    assert_eq!(conversation.items[0].status, "completed");
    assert_eq!(conversation.items[1].kind, ConversationItemKind::AgentWork);
    assert_eq!(conversation.items[1].status, "failed");
}

#[test]
fn conversation_terminal_turn_closes_live_agent_work() {
    let events = vec![
        event_at(
            1,
            1,
            EventType::TURN_STARTED,
            json!({ "turn_id": "turn_1" }),
        ),
        event_at(
            2,
            2,
            EventType::TOOL_STARTED,
            json!({ "tool_id": "tool_1", "name": "Search", "status": "running", "turn_id": "turn_1" }),
        ),
        event_at(
            3,
            6,
            EventType::TURN_COMPLETED,
            json!({ "turn_id": "turn_1" }),
        ),
    ];

    let conversation = project_conversation(&events);
    let work = conversation
        .items
        .iter()
        .find(|item| item.kind == ConversationItemKind::AgentWork)
        .expect("agent work");

    assert_eq!(work.status, "completed");
    assert_eq!(
        work.updated_at,
        Utc.with_ymd_and_hms(2026, 6, 18, 10, 0, 6).unwrap()
    );
}

#[test]
fn conversation_terminal_turn_closes_started_agent_work_without_tool_completed() {
    let events = vec![
        event_at(
            1,
            1,
            EventType::TURN_STARTED,
            json!({ "turn_id": "turn_1" }),
        ),
        event_at(
            2,
            2,
            EventType::TOOL_STARTED,
            json!({ "tool_id": "tool_1", "name": "Read file", "status": "started", "turn_id": "turn_1" }),
        ),
        event_at(
            3,
            6,
            EventType::TURN_COMPLETED,
            json!({ "turn_id": "turn_1" }),
        ),
    ];

    let conversation = project_conversation(&events);
    let work = conversation
        .items
        .iter()
        .find(|item| item.kind == ConversationItemKind::AgentWork)
        .expect("agent work");

    assert_eq!(work.status, "completed");
    assert_eq!(
        work.updated_at,
        Utc.with_ymd_and_hms(2026, 6, 18, 10, 0, 6).unwrap()
    );
    assert_eq!(work.source_event_ids.len(), 2);
}

#[test]
fn conversation_non_terminal_updates_do_not_resurrect_completed_work() {
    let events = vec![
        event_at(
            1,
            1,
            EventType::TOOL_STARTED,
            json!({ "tool_id": "tool_1", "name": "Search", "status": "running" }),
        ),
        event_at(
            2,
            4,
            EventType::TOOL_COMPLETED,
            json!({ "tool_id": "tool_1", "name": "Search", "status": "completed" }),
        ),
        event_at(
            3,
            5,
            EventType::TOOL_OUTPUT_DELTA,
            json!({ "tool_id": "tool_1", "delta": "late output" }),
        ),
    ];

    let conversation = project_conversation(&events);

    assert_eq!(conversation.items.len(), 1);
    assert_eq!(conversation.items[0].status, "completed");
    assert_eq!(conversation.items[0].detail["delta"], "late output");
}

#[test]
fn conversation_accumulates_tool_output_delta_streams() {
    let events = vec![
        event_at(
            1,
            1,
            EventType::TOOL_STARTED,
            json!({
                "tool_id": "tool_1",
                "name": "shell",
                "status": "running",
                "detail": {
                    "type": "shell",
                    "command": "cargo test"
                }
            }),
        ),
        event_at(
            2,
            2,
            EventType::TOOL_OUTPUT_DELTA,
            json!({
                "tool_id": "tool_1",
                "stream_id": "stdout",
                "delta": "running ",
                "sequence": 1
            }),
        ),
        event_at(
            3,
            3,
            EventType::TOOL_OUTPUT_DELTA,
            json!({
                "tool_id": "tool_1",
                "stream_id": "stdout",
                "delta": "tests\n",
                "sequence": 2
            }),
        ),
    ];

    let conversation = project_conversation(&events);

    assert_eq!(conversation.items.len(), 1);
    let detail = &conversation.items[0].detail["detail"];
    assert_eq!(detail["type"], "shell");
    assert_eq!(detail["stdout"], "running tests\n");
    assert_eq!(detail["output"], "running tests\n");
    assert_eq!(detail["streams"][0]["stream_id"], "stdout");
    assert_eq!(detail["streams"][0]["text"], "running tests\n");
    assert_eq!(detail["streams"][0]["chunk_count"], 2);
    assert_eq!(detail["streams"][0]["last_sequence"], 2);
    assert_eq!(conversation.items[0].detail["delta"], "tests\n");
}

#[test]
fn conversation_tracks_turn_meta_from_runtime_lifecycle() {
    let events = vec![
        event_at(
            1,
            1,
            EventType::USER_MESSAGE_ACCEPTED,
            json!({ "content": "hello" }),
        ),
        event_at(
            2,
            3,
            EventType::TURN_STARTED,
            json!({ "turn_id": "turn_1" }),
        ),
        event_at(
            3,
            4,
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "turn_id": "turn_1", "message_id": "msg_1", "delta": "done" }),
        ),
        event_at(
            4,
            6,
            EventType::TURN_COMPLETED,
            json!({ "turn_id": "turn_1" }),
        ),
    ];

    let conversation = project_conversation(&events);

    assert_eq!(
        conversation
            .items
            .iter()
            .map(|item| item.kind)
            .collect::<Vec<_>>(),
        vec![
            ConversationItemKind::UserMessage,
            ConversationItemKind::TurnMeta,
            ConversationItemKind::AssistantMessage,
        ]
    );
    assert_eq!(
        conversation.items[0]
            .turn_id
            .as_ref()
            .map(|turn| turn.as_str()),
        Some("turn_1")
    );
    assert_eq!(conversation.items[1].item_id, "turn:turn_1:meta");
    assert_eq!(conversation.items[1].status, "completed");
    assert_eq!(
        conversation.items[1].updated_at,
        Utc.with_ymd_and_hms(2026, 6, 18, 10, 0, 6).unwrap()
    );
}

#[test]
fn conversation_terminal_turn_closes_all_live_assistant_messages_for_that_turn() {
    let events = vec![
        event_at(
            1,
            1,
            EventType::TURN_STARTED,
            json!({ "turn_id": "turn_1" }),
        ),
        event_at(
            2,
            2,
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "turn_id": "turn_1", "message_id": "msg_a", "delta": "hello" }),
        ),
        event_at(
            3,
            3,
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "turn_id": "turn_1", "message_id": "msg_b", "delta": "hello" }),
        ),
        event_at(
            4,
            4,
            EventType::TURN_COMPLETED,
            json!({ "turn_id": "turn_1" }),
        ),
    ];

    let conversation = project_conversation(&events);
    let assistant_items = conversation
        .items
        .iter()
        .filter(|item| item.kind == ConversationItemKind::AssistantMessage)
        .collect::<Vec<_>>();

    assert_eq!(assistant_items.len(), 2);
    assert!(
        assistant_items
            .iter()
            .all(|item| item.status == "completed"),
        "terminal turns must not leave duplicate assistant identities streaming"
    );
    assert_eq!(
        assistant_items
            .iter()
            .map(|item| item.updated_at)
            .collect::<Vec<_>>(),
        vec![
            Utc.with_ymd_and_hms(2026, 6, 18, 10, 0, 4).unwrap(),
            Utc.with_ymd_and_hms(2026, 6, 18, 10, 0, 4).unwrap(),
        ]
    );
}

#[test]
fn conversation_preserves_turn_failure_error_payload() {
    let events = vec![
        event_at(
            1,
            1,
            EventType::TURN_STARTED,
            json!({ "turn_id": "turn_1" }),
        ),
        event_at(
            2,
            2,
            EventType::TURN_FAILED,
            json!({ "turn_id": "turn_1", "error": "No API key found for the selected model." }),
        ),
    ];

    let conversation = project_conversation(&events);

    assert_eq!(conversation.items.len(), 2);
    assert_eq!(conversation.items[0].kind, ConversationItemKind::TurnMeta);
    assert_eq!(conversation.items[0].status, "failed");
    assert_eq!(
        conversation.items[0].detail["error"],
        "No API key found for the selected model."
    );
    assert_eq!(conversation.items[1].kind, ConversationItemKind::Status);
    assert_eq!(conversation.items[1].status, "failed");
    assert_eq!(
        conversation.items[1].text.as_deref(),
        Some("No API key found for the selected model.")
    );
}

#[test]
fn conversation_treats_cancel_acceptance_as_cancelled_turn_terminalization() {
    let events = vec![
        event_at(
            1,
            1,
            EventType::TURN_STARTED,
            json!({ "turn_id": "turn_1" }),
        ),
        event_at(2, 2, EventType::TURN_CANCEL_ACCEPTED, json!({})),
    ];

    let conversation = project_conversation(&events);

    assert_eq!(conversation.items.len(), 2);
    assert_eq!(conversation.items[0].kind, ConversationItemKind::TurnMeta);
    assert_eq!(conversation.items[0].status, "cancelled");
    assert_eq!(
        conversation.items[0].updated_at,
        Utc.with_ymd_and_hms(2026, 6, 18, 10, 0, 2).unwrap()
    );
    assert_eq!(conversation.items[1].kind, ConversationItemKind::Status);
    assert_eq!(conversation.items[1].status, "cancelled");
    assert_eq!(
        conversation.items[1].text.as_deref(),
        Some("Turn cancelled")
    );
}

#[test]
fn conversation_coalesces_duplicate_turn_failure_status_items() {
    let events = vec![
        event_at(
            1,
            1,
            EventType::TURN_STARTED,
            json!({ "turn_id": "turn_1" }),
        ),
        event_at(
            2,
            2,
            EventType::TURN_FAILED,
            json!({ "turn_id": "turn_1", "error": "provider stream disconnected" }),
        ),
        event_at(
            3,
            3,
            EventType::TURN_FAILED,
            json!({ "turn_id": "turn_1", "error": "provider stream disconnected" }),
        ),
    ];

    let conversation = project_conversation(&events);
    let status_items = conversation
        .items
        .iter()
        .filter(|item| item.kind == ConversationItemKind::Status)
        .collect::<Vec<_>>();

    assert_eq!(conversation.items.len(), 2);
    assert_eq!(status_items.len(), 1);
    assert_eq!(status_items[0].status, "failed");
    assert_eq!(
        status_items[0].text.as_deref(),
        Some("provider stream disconnected")
    );
    assert_eq!(status_items[0].source_event_ids.len(), 2);
    assert_eq!(status_items[0].source_event_ranges[0].from_seq, 2);
    assert_eq!(status_items[0].source_event_ranges[0].to_seq, 3);
}

#[test]
fn pending_requests_remove_resolved_requests() {
    let events = vec![
        event(
            1,
            EventType::REQUEST_OPENED,
            json!({ "request_id": "req_1", "title": "Approve command" }),
        ),
        event(
            2,
            EventType::REQUEST_OPENED,
            json!({ "request_id": "req_2", "title": "Answer question" }),
        ),
        event(
            3,
            EventType::REQUEST_RESOLVED,
            json!({ "request_id": "req_1", "result": "allow" }),
        ),
    ];

    let requests = project_pending_requests(&events);

    assert_eq!(requests.requests.len(), 1);
    assert_eq!(requests.requests[0].request_id.as_str(), "req_2");
}

#[test]
fn conversation_fixture_keeps_work_out_of_assistant_text() {
    let events = support::canonical_fixture("conversation_with_tool_noise");

    let conversation = project_conversation(&events);

    assert_eq!(
        conversation
            .items
            .iter()
            .map(|item| item.kind)
            .collect::<Vec<_>>(),
        vec![
            ConversationItemKind::UserMessage,
            ConversationItemKind::AgentWork,
            ConversationItemKind::AssistantMessage,
        ]
    );
    assert_eq!(conversation.items[0].text.as_deref(), Some("hello"));
    assert_eq!(conversation.items[2].text.as_deref(), Some("hi there"));
}

#[test]
fn conversation_window_returns_tail_items_by_default() {
    let events = vec![
        event(
            1,
            EventType::USER_MESSAGE_ACCEPTED,
            json!({ "content": "one" }),
        ),
        event(
            2,
            EventType::USER_MESSAGE_ACCEPTED,
            json!({ "content": "two" }),
        ),
        event(
            3,
            EventType::USER_MESSAGE_ACCEPTED,
            json!({ "content": "three" }),
        ),
    ];

    let window = project_conversation_window(
        &events,
        ConversationWindowQuery {
            limit: 2,
            ..Default::default()
        },
    )
    .expect("window");

    assert_eq!(window.items.len(), 2);
    assert_eq!(window.items[0].text.as_deref(), Some("two"));
    assert_eq!(window.items[1].text.as_deref(), Some("three"));
    assert_eq!(
        window.window.first_item_id.as_deref(),
        Some(window.items[0].item_id.as_str())
    );
    assert_eq!(
        window.window.last_item_id.as_deref(),
        Some(window.items[1].item_id.as_str())
    );
    assert_eq!(window.window.has_older, true);
    assert_eq!(window.window.has_newer, false);
    assert_eq!(window.cursor.as_ref().map(|cursor| cursor.seq), Some(3));
}

#[test]
fn conversation_window_pages_before_after_and_around_item_ids() {
    let events = vec![
        event(
            1,
            EventType::USER_MESSAGE_ACCEPTED,
            json!({ "content": "one" }),
        ),
        event(
            2,
            EventType::USER_MESSAGE_ACCEPTED,
            json!({ "content": "two" }),
        ),
        event(
            3,
            EventType::USER_MESSAGE_ACCEPTED,
            json!({ "content": "three" }),
        ),
        event(
            4,
            EventType::USER_MESSAGE_ACCEPTED,
            json!({ "content": "four" }),
        ),
    ];
    let all = project_conversation(&events);
    let second = all.items[1].item_id.clone();
    let third = all.items[2].item_id.clone();

    let before = project_conversation_window(
        &events,
        ConversationWindowQuery {
            anchor_item_id: Some(third.clone()),
            direction: ConversationWindowDirection::Before,
            limit: 2,
        },
    )
    .expect("before window");
    assert_eq!(
        before
            .items
            .iter()
            .map(|item| item.text.as_deref().unwrap_or(""))
            .collect::<Vec<_>>(),
        vec!["one", "two"]
    );
    assert_eq!(before.window.has_newer, true);

    let after = project_conversation_window(
        &events,
        ConversationWindowQuery {
            anchor_item_id: Some(second.clone()),
            direction: ConversationWindowDirection::After,
            limit: 2,
        },
    )
    .expect("after window");
    assert_eq!(
        after
            .items
            .iter()
            .map(|item| item.text.as_deref().unwrap_or(""))
            .collect::<Vec<_>>(),
        vec!["three", "four"]
    );
    assert_eq!(after.window.has_older, true);

    let around = project_conversation_window(
        &events,
        ConversationWindowQuery {
            anchor_item_id: Some(third.clone()),
            direction: ConversationWindowDirection::Around,
            limit: 3,
        },
    )
    .expect("around window");
    assert_eq!(
        around
            .items
            .iter()
            .map(|item| item.text.as_deref().unwrap_or(""))
            .collect::<Vec<_>>(),
        vec!["two", "three", "four"]
    );
    assert_eq!(
        around.window.anchor_item_id.as_deref(),
        Some(third.as_str())
    );
}

#[test]
fn conversation_window_rejects_unknown_item_cursor() {
    let events = vec![event(
        1,
        EventType::USER_MESSAGE_ACCEPTED,
        json!({ "content": "one" }),
    )];

    let result = project_conversation_window(
        &events,
        ConversationWindowQuery {
            anchor_item_id: Some("missing-item".to_string()),
            direction: ConversationWindowDirection::Before,
            limit: 2,
        },
    );

    assert!(result.is_err());
}

#[test]
fn workbuddy_external_replay_window_preserves_thought_first_tool_lifecycle_shape() {
    let events = support::external_eventlog_fixture("workbuddy_replay_window");

    assert_eq!(events.len(), 7);
    assert!(
        events
            .iter()
            .all(|event| event.source.contains("WorkBuddyApp"))
    );
    assert!(events.iter().all(|event| event.mode == "stream"));
    assert!(events.iter().all(|event| event.schema_version == 1));
    assert!(
        events
            .iter()
            .all(|event| event.conversation_id == "fixture-conversation")
    );
    assert_eq!(
        events
            .iter()
            .map(|event| event.server_offset)
            .collect::<Vec<_>>(),
        vec![0, 2, 3, 4, 5, 43, 44],
        "fixture should keep sparse server offsets from production replay"
    );
    assert_eq!(
        events
            .iter()
            .map(|event| event.r#type.as_str())
            .collect::<Vec<_>>(),
        vec![
            "user_message_chunk",
            "agent_thought_chunk",
            "agent_message_chunk",
            "tool_call",
            "tool_call_update",
            "user_message_chunk",
            "agent_message_chunk",
        ],
        "WorkBuddy replay window should preserve the production thought-first ordering"
    );
    assert_eq!(events[3].payload["status"], "in_progress");
    assert_eq!(events[4].payload["status"], "completed");
}
