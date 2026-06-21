use chrono::{TimeZone, Utc};
use serde_json::json;
use vela_core::{CanonicalEvent, EventSource, EventType, SessionId};
use vela_projection::{
    TranscriptWindowQuery, project_activity, project_pending_requests, project_transcript,
    project_transcript_window,
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
fn transcript_only_uses_accepted_user_and_assistant_message_events() {
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

    let transcript = project_transcript(&events);

    assert_eq!(transcript.rows.len(), 2);
    assert_eq!(transcript.rows[0].role.as_str(), "user");
    assert_eq!(transcript.rows[0].text, "hello");
    assert_eq!(transcript.rows[1].role.as_str(), "assistant");
    assert_eq!(transcript.rows[1].text, "hi there");
}

#[test]
fn transcript_projects_user_image_blocks_as_parts() {
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

    let transcript = project_transcript(&events);

    assert_eq!(transcript.rows.len(), 1);
    let row = &transcript.rows[0];
    assert_eq!(row.text, "look at this");
    assert_eq!(row.parts.len(), 2);
    assert_eq!(row.parts[0].part_type, "text");
    assert_eq!(row.parts[0].text.as_deref(), Some("look at this"));
    assert_eq!(row.parts[1].part_type, "image");
    assert_eq!(row.parts[1].data["mime_type"], "image/png");
    assert_eq!(row.parts[1].data["data"], "aGVsbG8=");
    assert_eq!(row.parts[1].data["size_bytes"], 5);
}

#[test]
fn activity_tracks_tool_request_and_warnings() {
    let events = vec![
        event(
            1,
            EventType::TOOL_STARTED,
            json!({ "tool_id": "tool_1", "name": "bash", "status": "running" }),
        ),
        event(
            2,
            EventType::TOOL_COMPLETED,
            json!({ "tool_id": "tool_1", "name": "bash", "status": "completed" }),
        ),
        event(
            3,
            EventType::WARNING_RAISED,
            json!({ "message": "provider emitted unknown event" }),
        ),
    ];

    let activity = project_activity(&events);

    assert_eq!(activity.items.len(), 2);
    assert_eq!(activity.items[0].kind.as_str(), "tool");
    assert_eq!(activity.items[0].status.as_deref(), Some("completed"));
    assert_eq!(activity.items[1].kind.as_str(), "warning");
}

#[test]
fn activity_coalesces_tool_lifecycle_with_time_boundaries() {
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

    let activity = project_activity(&events);

    assert_eq!(activity.items.len(), 1);
    assert_eq!(activity.items[0].kind.as_str(), "tool");
    assert_eq!(activity.items[0].title, "Search");
    assert_eq!(activity.items[0].status.as_deref(), Some("completed"));
    assert_eq!(
        activity.items[0].created_at,
        Utc.with_ymd_and_hms(2026, 6, 18, 10, 0, 1).unwrap()
    );
    assert_eq!(
        activity.items[0].updated_at,
        Utc.with_ymd_and_hms(2026, 6, 18, 10, 0, 4).unwrap()
    );
    assert_eq!(activity.items[0].payload["query"], "import");
    assert_eq!(activity.items[0].payload["delta"], "12 matches");
    assert_eq!(activity.items[0].payload["exit_code"], 0);
}

#[test]
fn activity_non_terminal_updates_do_not_resurrect_completed_tool_items() {
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

    let activity = project_activity(&events);

    assert_eq!(activity.items.len(), 1);
    assert_eq!(activity.items[0].status.as_deref(), Some("completed"));
    assert_eq!(activity.items[0].payload["delta"], "late output");
}

#[test]
fn activity_preserves_turn_failure_error_payload() {
    let events = vec![
        event(1, EventType::TURN_STARTED, json!({})),
        event(
            2,
            EventType::TURN_FAILED,
            json!({ "error": "No API key found for the selected model." }),
        ),
    ];

    let activity = project_activity(&events);

    assert_eq!(activity.items.len(), 1);
    assert_eq!(activity.items[0].kind.as_str(), "turn");
    assert_eq!(activity.items[0].status.as_deref(), Some("failed"));
    assert_eq!(
        activity.items[0].payload["error"],
        "No API key found for the selected model."
    );
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
fn transcript_fixture_ignores_tool_noise_and_coalesces_assistant_deltas() {
    let events = support::canonical_fixture("transcript_with_tool_noise");

    let transcript = project_transcript(&events);

    assert_eq!(transcript.rows.len(), 2);
    assert_eq!(transcript.rows[0].text, "hello");
    assert_eq!(transcript.rows[1].text, "hi there");
}

#[test]
fn transcript_window_returns_tail_rows_by_default() {
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

    let window = project_transcript_window(
        &events,
        TranscriptWindowQuery {
            limit: 2,
            ..Default::default()
        },
    )
    .expect("window");

    assert_eq!(window.rows.len(), 2);
    assert_eq!(window.rows[0].text, "two");
    assert_eq!(window.rows[1].text, "three");
    assert_eq!(
        window.window.first_row_id.as_deref(),
        Some(window.rows[0].row_id.as_str())
    );
    assert_eq!(
        window.window.last_row_id.as_deref(),
        Some(window.rows[1].row_id.as_str())
    );
    assert_eq!(window.window.has_older, true);
    assert_eq!(window.window.has_newer, false);
    assert_eq!(window.cursor.as_ref().map(|cursor| cursor.seq), Some(3));
}

#[test]
fn transcript_window_pages_before_after_and_around_row_ids() {
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
    let all = project_transcript(&events);
    let second = all.rows[1].row_id.clone();
    let third = all.rows[2].row_id.clone();

    let before = project_transcript_window(
        &events,
        TranscriptWindowQuery {
            before_row_id: Some(third.clone()),
            limit: 2,
            ..Default::default()
        },
    )
    .expect("before window");
    assert_eq!(
        before
            .rows
            .iter()
            .map(|row| row.text.as_str())
            .collect::<Vec<_>>(),
        vec!["one", "two"]
    );
    assert_eq!(before.window.has_newer, true);

    let after = project_transcript_window(
        &events,
        TranscriptWindowQuery {
            after_row_id: Some(second.clone()),
            limit: 2,
            ..Default::default()
        },
    )
    .expect("after window");
    assert_eq!(
        after
            .rows
            .iter()
            .map(|row| row.text.as_str())
            .collect::<Vec<_>>(),
        vec!["three", "four"]
    );
    assert_eq!(after.window.has_older, true);

    let around = project_transcript_window(
        &events,
        TranscriptWindowQuery {
            around_row_id: Some(third.clone()),
            limit: 3,
            ..Default::default()
        },
    )
    .expect("around window");
    assert_eq!(
        around
            .rows
            .iter()
            .map(|row| row.text.as_str())
            .collect::<Vec<_>>(),
        vec!["two", "three", "four"]
    );
    assert_eq!(around.window.anchor_row_id.as_deref(), Some(third.as_str()));
}

#[test]
fn transcript_window_rejects_unknown_row_cursor() {
    let events = vec![event(
        1,
        EventType::USER_MESSAGE_ACCEPTED,
        json!({ "content": "one" }),
    )];

    let result = project_transcript_window(
        &events,
        TranscriptWindowQuery {
            before_row_id: Some("missing-row".to_string()),
            limit: 2,
            ..Default::default()
        },
    );

    assert!(result.is_err());
}

#[test]
fn transcript_projection_marks_latest_assistant_row_completed_on_turn_completed() {
    let events = vec![
        event(
            1,
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "message_id": "msg_1", "delta": "done" }),
        ),
        event(2, EventType::TURN_COMPLETED, json!({})),
    ];

    let transcript = project_transcript(&events);

    assert_eq!(transcript.rows[0].status, "completed");
    assert_eq!(transcript.rows[0].revision, 2);
}

#[test]
fn transcript_projects_turn_summaries_from_runtime_lifecycle() {
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
    ];

    let transcript = project_transcript(&events);

    assert_eq!(transcript.turns.len(), 1);
    assert_eq!(transcript.turns[0].turn_id.as_str(), "turn_1");
    assert_eq!(transcript.turns[0].status, "running");
    assert_eq!(
        transcript.turns[0].started_at,
        Utc.with_ymd_and_hms(2026, 6, 18, 10, 0, 3).unwrap()
    );
    assert_eq!(transcript.turns[0].completed_at, None);
    assert_eq!(
        transcript.turns[0].first_row_id.as_deref(),
        Some(transcript.rows[0].row_id.as_str())
    );
    assert_eq!(
        transcript.turns[0].last_row_id.as_deref(),
        Some(transcript.rows[0].row_id.as_str())
    );
}

#[test]
fn transcript_window_includes_summaries_for_visible_turn_rows() {
    let events = vec![
        event_at(
            1,
            1,
            EventType::USER_MESSAGE_ACCEPTED,
            json!({ "content": "one" }),
        ),
        event_at(
            2,
            2,
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

    let window = project_transcript_window(
        &events,
        TranscriptWindowQuery {
            limit: 1,
            ..Default::default()
        },
    )
    .expect("window");

    assert_eq!(window.rows.len(), 1);
    assert_eq!(window.rows[0].role.as_str(), "assistant");
    assert_eq!(window.turns.len(), 1);
    assert_eq!(window.turns[0].turn_id.as_str(), "turn_1");
    assert_eq!(window.turns[0].status, "completed");
    assert_eq!(
        window.turns[0].completed_at,
        Some(Utc.with_ymd_and_hms(2026, 6, 18, 10, 0, 6).unwrap())
    );
}

#[test]
fn transcript_window_can_exclude_live_rows() {
    let events = vec![
        event(
            1,
            EventType::USER_MESSAGE_ACCEPTED,
            json!({ "content": "stable" }),
        ),
        event(
            2,
            EventType::ASSISTANT_MESSAGE_DELTA,
            json!({ "message_id": "msg_live", "delta": "streaming" }),
        ),
    ];

    let window = project_transcript_window(
        &events,
        TranscriptWindowQuery {
            include_live: false,
            limit: 10,
            ..Default::default()
        },
    )
    .expect("window");

    assert_eq!(window.rows.len(), 1);
    assert_eq!(window.rows[0].text, "stable");
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
