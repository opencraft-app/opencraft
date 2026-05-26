use crate::client::Message;
use crate::events::AgentEvent;
use crate::runtime::ids::now_ms;
use crate::session::{AgentSession, TranscriptBlock, TranscriptRole};

pub(crate) fn transcript_to_messages(
    transcript: &[crate::session::TranscriptEntry],
) -> Vec<Message> {
    transcript
        .iter()
        .filter_map(|entry| {
            let text = transcript_text(entry);
            match entry.role {
                TranscriptRole::User => Some(Message::user(text)),
                TranscriptRole::Assistant => Some(Message::assistant(text)),
                TranscriptRole::System => Some(Message::system(text)),
                TranscriptRole::Tool => None,
            }
        })
        .collect()
}

pub(crate) fn append_events_to_transcript(
    session: &mut AgentSession,
    turn_id: &str,
    run_id: &str,
    events: &[AgentEvent],
) {
    for event in events {
        match event {
            AgentEvent::Reasoning { text } => {
                if !text.trim().is_empty() {
                    session.append_reasoning(turn_id, run_id, text.clone());
                }
            }
            AgentEvent::ToolStart {
                tool_call_id,
                name,
                arguments,
            } => session.append_tool_call(
                turn_id,
                run_id,
                tool_call_id.clone(),
                name.clone(),
                arguments.clone(),
            ),
            AgentEvent::ToolComplete {
                tool_call_id,
                name,
                result,
            } => session.append_tool_result(
                turn_id,
                run_id,
                tool_call_id.clone(),
                name.clone(),
                true,
                result.content.clone(),
            ),
            AgentEvent::ToolError {
                tool_call_id,
                name,
                error,
            } => session.append_tool_result(
                turn_id,
                run_id,
                tool_call_id.clone(),
                name.clone(),
                false,
                error.clone(),
            ),
            AgentEvent::Error { error } => {
                session.append_blocked(turn_id, run_id, error.clone());
            }
            AgentEvent::RunScoped { event, .. } => {
                append_events_to_transcript(session, turn_id, run_id, &[event.as_ref().clone()]);
            }
            AgentEvent::RuntimeHost(_) => {}
            AgentEvent::Content { .. }
            | AgentEvent::Thinking { .. }
            | AgentEvent::IterationComplete { .. }
            | AgentEvent::Done { .. } => {}
        }
    }
}

pub(crate) fn reset_marker_entry(
    transcript_len: usize,
    parent_id: Option<String>,
    reason: String,
) -> crate::session::TranscriptEntry {
    crate::session::TranscriptEntry {
        entry_id: format!("entry_{}", transcript_len + 1),
        parent_id,
        turn_id: "turn_system_restore".to_string(),
        run_id: "run_system_restore".to_string(),
        role: crate::session::TranscriptRole::System,
        blocks: vec![TranscriptBlock::ResetMarker { reason }],
        created_at_ms: now_ms(),
    }
}

fn transcript_text(entry: &crate::session::TranscriptEntry) -> String {
    entry
        .blocks
        .iter()
        .map(|block| match block {
            TranscriptBlock::Text { text } | TranscriptBlock::Reasoning { text } => text.clone(),
            TranscriptBlock::ToolCall {
                tool_call_id,
                name,
                arguments,
            } => format!("tool_call {name} {tool_call_id}: {arguments}"),
            TranscriptBlock::ToolResult {
                tool_call_id,
                name,
                success,
                content,
            } => format!("tool_result {name} {tool_call_id} success={success}: {content}"),
            TranscriptBlock::ResetMarker { reason } => format!("runtime reset: {reason}"),
            TranscriptBlock::Blocked { reason } => format!("blocked: {reason}"),
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use crate::events::AgentEvent;
    use crate::session::{AgentSession, TranscriptBlock};

    use super::*;

    #[test]
    fn append_events_preserves_parent_and_turn_ids() {
        let mut session = AgentSession::new("session_1", ".");
        append_events_to_transcript(
            &mut session,
            "turn_1",
            "run_1",
            &[
                AgentEvent::Reasoning {
                    text: "thinking".to_string(),
                },
                AgentEvent::ToolStart {
                    tool_call_id: "call_1".to_string(),
                    name: "terminal".to_string(),
                    arguments: "{\"command\":\"pwd\"}".to_string(),
                },
                AgentEvent::ToolError {
                    tool_call_id: "call_1".to_string(),
                    name: "terminal".to_string(),
                    error: "denied".to_string(),
                },
            ],
        );

        assert_eq!(session.transcript.len(), 3);
        assert!(session
            .transcript
            .iter()
            .all(|entry| entry.turn_id == "turn_1" && entry.run_id == "run_1"));
        assert!(session.transcript[1].parent_id.is_some());
        assert!(matches!(
            session.transcript[0].blocks[0],
            TranscriptBlock::Reasoning { .. }
        ));
        assert!(matches!(
            session.transcript[1].blocks[0],
            TranscriptBlock::ToolCall { .. }
        ));
        assert!(matches!(
            session.transcript[2].blocks[0],
            TranscriptBlock::ToolResult { success: false, .. }
        ));
    }
}
