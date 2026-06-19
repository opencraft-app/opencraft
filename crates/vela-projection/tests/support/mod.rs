use serde::Deserialize;
use serde_json::Value;
use vela_core::{CanonicalEvent, EventSource, EventType, SessionId};

#[derive(Deserialize)]
struct CanonicalEventFixture {
    event_type: EventType,
    payload: serde_json::Value,
}

pub fn canonical_fixture(name: &str) -> Vec<CanonicalEvent> {
    let raw = match name {
        "transcript_with_tool_noise" => {
            include_str!("../fixtures/canonical_events/transcript_with_tool_noise.jsonl")
        }
        other => panic!("unknown projection canonical fixture: {other}"),
    };
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
        .map(|(index, line)| {
            let fixture: CanonicalEventFixture =
                serde_json::from_str(line).expect("canonical event fixture line");
            CanonicalEvent::new(
                SessionId::from("ses_projection_fixture"),
                fixture.event_type,
                EventSource::runtime("fixture"),
                fixture.payload,
            )
            .with_cursor(1, index as i64 + 1)
        })
        .collect()
}

#[derive(Debug, Deserialize)]
pub struct ExternalEventLogLine {
    pub source: String,
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "serverOffset")]
    pub server_offset: i64,
    pub r#type: String,
    pub payload: Value,
    pub mode: String,
}

pub fn external_eventlog_fixture(name: &str) -> Vec<ExternalEventLogLine> {
    let raw = match name {
        "workbuddy_replay_window" => {
            include_str!("../fixtures/external_eventlogs/workbuddy_replay_window.jsonl")
        }
        other => panic!("unknown external eventlog fixture: {other}"),
    };
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("external eventlog fixture line"))
        .collect()
}
