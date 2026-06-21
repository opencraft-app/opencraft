use std::collections::BTreeMap;

use serde_json::Value;
use vela_core::{
    ActivityItem, ActivityKind, ActivityShelfView, CanonicalEvent, ChatTranscriptView,
    ChatTranscriptWindow, ConversationItem, ConversationItemKind, ConversationView,
    ConversationWindow, ConversationWindowView, EventCursor, EventType, PendingRequest,
    PendingRequestsView, RequestId, SessionId, TranscriptPart, TranscriptRole, TranscriptRow,
    TranscriptTurnSummary, TranscriptWindow, TurnId,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TranscriptWindowQuery {
    pub before_row_id: Option<String>,
    pub after_row_id: Option<String>,
    pub around_row_id: Option<String>,
    pub include_live: bool,
    pub limit: usize,
}

impl Default for TranscriptWindowQuery {
    fn default() -> Self {
        Self {
            before_row_id: None,
            after_row_id: None,
            around_row_id: None,
            include_live: true,
            limit: 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TranscriptWindowError {
    UnknownRowId(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationWindowQuery {
    pub anchor_item_id: Option<String>,
    pub direction: ConversationWindowDirection,
    pub limit: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConversationWindowDirection {
    Tail,
    Before,
    After,
    Around,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConversationWindowError {
    UnknownItemId(String),
}

impl Default for ConversationWindowQuery {
    fn default() -> Self {
        Self {
            anchor_item_id: None,
            direction: ConversationWindowDirection::Tail,
            limit: 0,
        }
    }
}

pub fn project_transcript(events: &[CanonicalEvent]) -> ChatTranscriptView {
    let session_id = session_id_from_events(events);
    let mut rows = Vec::new();
    let mut turns = Vec::new();

    for event in events {
        if event.event_type == EventType::USER_MESSAGE_ACCEPTED {
            rows.push(TranscriptRow {
                row_id: event.event_id.to_string(),
                session_id: event.session_id.clone(),
                turn_id: turn_id_from_payload(event),
                role: TranscriptRole::User,
                created_at: event.created_at,
                updated_at: event.created_at,
                revision: 1,
                status: "completed".to_string(),
                text: text_from_payload(&event.payload),
                parts: transcript_parts_from_payload(&event.payload, event.event_id.as_str()),
                source_event_ids: vec![event.event_id.clone()],
            });
            continue;
        }

        if event.event_type == EventType::TURN_STARTED {
            if let Some(turn_id) = turn_id_from_payload(event) {
                upsert_turn_started(&mut turns, event, turn_id.clone());
                if let Some(row) = rows
                    .iter_mut()
                    .rev()
                    .find(|row| row.role == TranscriptRole::User && row.turn_id.is_none())
                {
                    row.turn_id = Some(turn_id);
                    row.source_event_ids.push(event.event_id.clone());
                }
            }
            continue;
        }

        if event.event_type == EventType::ASSISTANT_MESSAGE_STARTED {
            let row_id = stable_message_id(event);
            rows.push(TranscriptRow {
                row_id,
                session_id: event.session_id.clone(),
                turn_id: turn_id_from_payload(event),
                role: TranscriptRole::Assistant,
                created_at: event.created_at,
                updated_at: event.created_at,
                revision: 1,
                status: "streaming".to_string(),
                text: String::new(),
                parts: Vec::new(),
                source_event_ids: vec![event.event_id.clone()],
            });
            continue;
        }

        if event.event_type == EventType::ASSISTANT_MESSAGE_DELTA {
            let row_id = stable_message_id(event);
            match rows
                .iter_mut()
                .rev()
                .find(|row| row.role == TranscriptRole::Assistant && row.row_id == row_id)
            {
                Some(row) => {
                    if row.turn_id.is_none() {
                        row.turn_id = turn_id_from_payload(event);
                    }
                    row.text.push_str(delta_from_payload(&event.payload));
                    row.source_event_ids.push(event.event_id.clone());
                    row.updated_at = event.created_at;
                    row.revision += 1;
                }
                None => rows.push(TranscriptRow {
                    row_id,
                    session_id: event.session_id.clone(),
                    turn_id: turn_id_from_payload(event),
                    role: TranscriptRole::Assistant,
                    created_at: event.created_at,
                    updated_at: event.created_at,
                    revision: 1,
                    status: "streaming".to_string(),
                    text: delta_from_payload(&event.payload).to_string(),
                    parts: Vec::new(),
                    source_event_ids: vec![event.event_id.clone()],
                }),
            }
            continue;
        }

        if event.event_type == EventType::ASSISTANT_MESSAGE_COMPLETED {
            let row_id = stable_message_id(event);
            if let Some(row) = rows
                .iter_mut()
                .rev()
                .find(|row| row.role == TranscriptRole::Assistant && row.row_id == row_id)
            {
                if row.turn_id.is_none() {
                    row.turn_id = turn_id_from_payload(event);
                }
                row.status = "completed".to_string();
                row.updated_at = event.created_at;
                row.revision += 1;
                row.source_event_ids.push(event.event_id.clone());
            }
            continue;
        }

        if event.event_type == EventType::TURN_COMPLETED {
            if let Some(row) = rows
                .iter_mut()
                .rev()
                .find(|row| row.role == TranscriptRole::Assistant && row.status == "streaming")
            {
                if row.turn_id.is_none() {
                    row.turn_id = turn_id_from_payload(event);
                }
                row.status = "completed".to_string();
                row.updated_at = event.created_at;
                row.revision += 1;
                row.source_event_ids.push(event.event_id.clone());
            }
            mark_turn_terminal(&mut turns, event, "completed");
            continue;
        }

        if event.event_type == EventType::TURN_FAILED {
            mark_turn_terminal(&mut turns, event, "failed");
            continue;
        }

        if event.event_type == EventType::TURN_CANCELLED {
            mark_turn_terminal(&mut turns, event, "cancelled");
            continue;
        }
    }

    attach_row_bounds_to_turns(&mut turns, &rows);

    ChatTranscriptView {
        session_id,
        rows,
        turns,
    }
}

pub fn project_conversation(events: &[CanonicalEvent]) -> ConversationView {
    let transcript = project_transcript(events);
    let activity = project_activity(events);
    let mut items = Vec::new();

    for row in transcript.rows {
        let kind = match row.role {
            TranscriptRole::User => ConversationItemKind::UserMessage,
            TranscriptRole::Assistant => ConversationItemKind::AssistantMessage,
            TranscriptRole::System => ConversationItemKind::Status,
        };
        items.push(ConversationItem {
            item_id: row.row_id,
            session_id: row.session_id,
            kind,
            turn_id: row.turn_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
            revision: row.revision,
            status: row.status,
            text: Some(row.text),
            parts: row.parts,
            title: None,
            summary: None,
            detail: Value::Null,
            source_event_ids: row.source_event_ids,
        });
    }

    for turn in transcript.turns {
        items.push(ConversationItem {
            item_id: format!("turn:{}:meta", turn.turn_id.as_str()),
            session_id: transcript.session_id.clone(),
            kind: ConversationItemKind::TurnMeta,
            turn_id: Some(turn.turn_id),
            created_at: turn.started_at,
            updated_at: turn.completed_at.unwrap_or(turn.started_at),
            revision: turn.source_event_ids.len() as u64,
            status: turn.status,
            text: None,
            parts: Vec::new(),
            title: None,
            summary: None,
            detail: Value::Null,
            source_event_ids: turn.source_event_ids,
        });
    }

    for activity_item in activity.items {
        if activity_item.kind == ActivityKind::Turn {
            continue;
        }
        items.push(ConversationItem {
            item_id: format!("work:{}", activity_item.item_id),
            session_id: activity_item.session_id,
            kind: ConversationItemKind::AgentWork,
            turn_id: activity_item.turn_id,
            created_at: activity_item.created_at,
            updated_at: activity_item.updated_at,
            revision: activity_item.source_event_ids.len() as u64,
            status: activity_item
                .status
                .clone()
                .unwrap_or_else(|| "running".to_string()),
            text: None,
            parts: Vec::new(),
            title: Some(activity_item.title),
            summary: activity_summary_text(&activity_item.payload),
            detail: activity_item.payload,
            source_event_ids: activity_item.source_event_ids,
        });
    }

    items.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then(item_kind_order(left.kind).cmp(&item_kind_order(right.kind)))
            .then(left.item_id.cmp(&right.item_id))
    });

    ConversationView {
        session_id: transcript.session_id,
        items,
    }
}

pub fn project_conversation_window(
    events: &[CanonicalEvent],
    query: ConversationWindowQuery,
) -> Result<ConversationWindowView, ConversationWindowError> {
    let conversation = project_conversation(events);
    let total = conversation.items.len();
    let limit = normalize_limit(query.limit);
    let (start, end, anchor_item_id) = conversation_window_bounds(
        &conversation.items,
        limit,
        query.direction,
        query.anchor_item_id.clone(),
    )?;
    let selected = conversation.items[start..end].to_vec();

    Ok(ConversationWindowView {
        session_id: conversation.session_id,
        items: selected.clone(),
        window: ConversationWindow {
            first_item_id: selected.first().map(|item| item.item_id.clone()),
            last_item_id: selected.last().map(|item| item.item_id.clone()),
            anchor_item_id,
            has_older: start > 0,
            has_newer: end < total,
        },
        cursor: latest_cursor(events),
    })
}

fn conversation_window_bounds(
    items: &[ConversationItem],
    limit: usize,
    direction: ConversationWindowDirection,
    anchor_item_id: Option<String>,
) -> Result<(usize, usize, Option<String>), ConversationWindowError> {
    let total = items.len();
    if total == 0 {
        if let Some(item_id) = anchor_item_id {
            return Err(ConversationWindowError::UnknownItemId(item_id));
        }
        return Ok((0, 0, None));
    }

    match direction {
        ConversationWindowDirection::Tail => Ok((total.saturating_sub(limit), total, None)),
        ConversationWindowDirection::Before => {
            let anchor = anchor_item_id.unwrap_or_default();
            let end = conversation_item_index(items, &anchor)?;
            Ok((end.saturating_sub(limit), end, Some(anchor)))
        }
        ConversationWindowDirection::After => {
            let anchor = anchor_item_id.unwrap_or_default();
            let start = conversation_item_index(items, &anchor)?.saturating_add(1);
            Ok((start, (start + limit).min(total), Some(anchor)))
        }
        ConversationWindowDirection::Around => {
            let anchor = anchor_item_id.unwrap_or_default();
            let anchor_index = conversation_item_index(items, &anchor)?;
            let before = limit / 2;
            let mut start = anchor_index.saturating_sub(before);
            let mut end = (start + limit).min(total);
            start = start.saturating_sub(limit.saturating_sub(end - start));
            end = (start + limit).min(total);
            Ok((start, end, Some(anchor)))
        }
    }
}

fn conversation_item_index(
    items: &[ConversationItem],
    item_id: &str,
) -> Result<usize, ConversationWindowError> {
    items
        .iter()
        .position(|item| item.item_id == item_id)
        .ok_or_else(|| ConversationWindowError::UnknownItemId(item_id.to_string()))
}

fn item_kind_order(kind: ConversationItemKind) -> u8 {
    match kind {
        ConversationItemKind::UserMessage => 0,
        ConversationItemKind::TurnMeta => 1,
        ConversationItemKind::AgentWork => 2,
        ConversationItemKind::AssistantMessage => 3,
        ConversationItemKind::Status => 4,
    }
}

fn activity_summary_text(payload: &Value) -> Option<String> {
    payload
        .get("message")
        .or_else(|| payload.get("error"))
        .or_else(|| payload.get("summary"))
        .or_else(|| payload.get("description"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub fn project_transcript_window(
    events: &[CanonicalEvent],
    query: TranscriptWindowQuery,
) -> Result<ChatTranscriptWindow, TranscriptWindowError> {
    let transcript = project_transcript(events);
    let mut rows = transcript.rows;
    if !query.include_live {
        rows.retain(|row| row.status != "streaming" && row.status != "pending");
    }
    let total = rows.len();
    let limit = normalize_limit(query.limit);
    let (start, end) = transcript_window_bounds(
        &rows,
        limit,
        query.before_row_id.as_deref(),
        query.after_row_id.as_deref(),
        query.around_row_id.as_deref(),
    )?;
    let selected = rows[start..end].to_vec();
    let turns = select_turn_summaries(&transcript.turns, &selected, query.include_live);
    let first_row_id = selected.first().map(|row| row.row_id.clone());
    let last_row_id = selected.last().map(|row| row.row_id.clone());

    Ok(ChatTranscriptWindow {
        session_id: transcript.session_id,
        rows: selected,
        turns,
        window: TranscriptWindow {
            first_row_id,
            last_row_id,
            anchor_row_id: query.around_row_id,
            has_older: start > 0,
            has_newer: end < total,
        },
        cursor: latest_cursor(events),
    })
}

fn upsert_turn_started(
    turns: &mut Vec<TranscriptTurnSummary>,
    event: &CanonicalEvent,
    turn_id: TurnId,
) {
    if let Some(turn) = turns.iter_mut().find(|turn| turn.turn_id == turn_id) {
        turn.status = "running".to_string();
        turn.started_at = event.created_at;
        turn.completed_at = None;
        turn.source_event_ids.push(event.event_id.clone());
        return;
    }

    turns.push(TranscriptTurnSummary {
        turn_id,
        status: "running".to_string(),
        started_at: event.created_at,
        completed_at: None,
        first_row_id: None,
        last_row_id: None,
        source_event_ids: vec![event.event_id.clone()],
    });
}

fn mark_turn_terminal(
    turns: &mut Vec<TranscriptTurnSummary>,
    event: &CanonicalEvent,
    status: &str,
) {
    let index = turn_id_from_payload(event)
        .and_then(|turn_id| turns.iter().position(|turn| turn.turn_id == turn_id))
        .or_else(|| turns.iter().rposition(|turn| turn.status == "running"));
    let Some(index) = index else {
        return;
    };

    let turn = &mut turns[index];
    turn.status = status.to_string();
    turn.completed_at = Some(event.created_at);
    turn.source_event_ids.push(event.event_id.clone());
}

fn attach_row_bounds_to_turns(turns: &mut [TranscriptTurnSummary], rows: &[TranscriptRow]) {
    for turn in turns {
        turn.first_row_id = None;
        turn.last_row_id = None;
        for row in rows
            .iter()
            .filter(|row| row.turn_id.as_ref() == Some(&turn.turn_id))
        {
            if turn.first_row_id.is_none() {
                turn.first_row_id = Some(row.row_id.clone());
            }
            turn.last_row_id = Some(row.row_id.clone());
        }
    }
}

fn select_turn_summaries(
    turns: &[TranscriptTurnSummary],
    selected_rows: &[TranscriptRow],
    include_live: bool,
) -> Vec<TranscriptTurnSummary> {
    turns
        .iter()
        .filter(|turn| include_live || turn.status != "running")
        .filter(|turn| {
            selected_rows
                .iter()
                .any(|row| row.turn_id.as_ref() == Some(&turn.turn_id))
        })
        .cloned()
        .collect()
}

pub fn project_activity(events: &[CanonicalEvent]) -> ActivityShelfView {
    let session_id = session_id_from_events(events);
    let mut items: Vec<ActivityItem> = Vec::new();

    for event in events {
        let Some((kind, item_id, title)) = activity_identity(event) else {
            continue;
        };
        let status = status_from_payload(&event.payload, &event.event_type);
        if let Some(item) = items.iter_mut().find(|item| item.item_id == item_id) {
            if item.turn_id.is_none() {
                item.turn_id = turn_id_from_payload(event);
            }
            item.kind = kind;
            item.status = merge_activity_status(item.status.as_deref(), status.as_deref());
            item.updated_at = event.created_at;
            item.payload = merge_payload(&item.payload, &event.payload);
            item.source_event_ids.push(event.event_id.clone());
        } else {
            items.push(ActivityItem {
                item_id,
                session_id: event.session_id.clone(),
                turn_id: turn_id_from_payload(event),
                kind,
                title,
                created_at: event.created_at,
                updated_at: event.created_at,
                status,
                payload: event.payload.clone(),
                source_event_ids: vec![event.event_id.clone()],
            });
        }
    }

    ActivityShelfView { session_id, items }
}

pub fn project_pending_requests(events: &[CanonicalEvent]) -> PendingRequestsView {
    let session_id = session_id_from_events(events);
    let mut requests: BTreeMap<String, PendingRequest> = BTreeMap::new();

    for event in events {
        if event.event_type == EventType::REQUEST_OPENED
            || event.event_type == EventType::REQUEST_UPDATED
        {
            let request_id = string_field(&event.payload, "request_id")
                .unwrap_or_else(|| event.event_id.to_string());
            let title = string_field(&event.payload, "title").unwrap_or_else(|| "Request".into());
            requests
                .entry(request_id.clone())
                .and_modify(|request| {
                    request.title = title.clone();
                    request.payload = merge_payload(&request.payload, &event.payload);
                    request.source_event_ids.push(event.event_id.clone());
                })
                .or_insert_with(|| PendingRequest {
                    request_id: RequestId::from(request_id),
                    session_id: event.session_id.clone(),
                    title,
                    status: "pending".to_string(),
                    payload: event.payload.clone(),
                    source_event_ids: vec![event.event_id.clone()],
                });
            continue;
        }

        if event.event_type == EventType::REQUEST_RESOLVED {
            if let Some(request_id) = string_field(&event.payload, "request_id") {
                requests.remove(&request_id);
            }
        }
    }

    PendingRequestsView {
        session_id,
        requests: requests.into_values().collect(),
    }
}

fn session_id_from_events(events: &[CanonicalEvent]) -> SessionId {
    events
        .first()
        .map(|event| event.session_id.clone())
        .unwrap_or_else(|| SessionId::from(""))
}

fn normalize_limit(limit: usize) -> usize {
    match limit {
        0 => 100,
        value => value.min(500),
    }
}

fn transcript_window_bounds(
    rows: &[TranscriptRow],
    limit: usize,
    before_row_id: Option<&str>,
    after_row_id: Option<&str>,
    around_row_id: Option<&str>,
) -> Result<(usize, usize), TranscriptWindowError> {
    let total = rows.len();
    if total == 0 {
        if let Some(row_id) = before_row_id.or(after_row_id).or(around_row_id) {
            return Err(TranscriptWindowError::UnknownRowId(row_id.to_string()));
        }
        return Ok((0, 0));
    }

    if let Some(before_row_id) = before_row_id {
        let end = rows
            .iter()
            .position(|row| row.row_id == before_row_id)
            .ok_or_else(|| TranscriptWindowError::UnknownRowId(before_row_id.to_string()))?;
        return Ok((end.saturating_sub(limit), end));
    }

    if let Some(after_row_id) = after_row_id {
        let start = rows
            .iter()
            .position(|row| row.row_id == after_row_id)
            .map(|index| index + 1)
            .ok_or_else(|| TranscriptWindowError::UnknownRowId(after_row_id.to_string()))?;
        return Ok((start, (start + limit).min(total)));
    }

    if let Some(around_row_id) = around_row_id {
        let anchor = rows
            .iter()
            .position(|row| row.row_id == around_row_id)
            .ok_or_else(|| TranscriptWindowError::UnknownRowId(around_row_id.to_string()))?;
        let before = limit / 2;
        let mut start = anchor.saturating_sub(before);
        let mut end = (start + limit).min(total);
        start = start.saturating_sub(limit.saturating_sub(end - start));
        end = (start + limit).min(total);
        return Ok((start, end));
    }

    Ok((total.saturating_sub(limit), total))
}

fn latest_cursor(events: &[CanonicalEvent]) -> Option<EventCursor> {
    events.last().map(CanonicalEvent::cursor)
}

fn text_from_payload(payload: &Value) -> String {
    string_field(payload, "content")
        .or_else(|| string_field(payload, "text"))
        .or_else(|| text_from_blocks(payload))
        .unwrap_or_default()
}

fn text_from_blocks(payload: &Value) -> Option<String> {
    let text = payload
        .get("blocks")?
        .as_array()?
        .iter()
        .filter_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn transcript_parts_from_payload(payload: &Value, row_id: &str) -> Vec<TranscriptPart> {
    let Some(blocks) = payload.get("blocks").and_then(Value::as_array) else {
        return Vec::new();
    };

    blocks
        .iter()
        .enumerate()
        .filter_map(
            |(index, block)| match block.get("type").and_then(Value::as_str) {
                Some("text") => text_part_from_block(block, row_id, index),
                Some("image") => image_part_from_block(block, row_id, index),
                _ => None,
            },
        )
        .collect()
}

fn text_part_from_block(block: &Value, row_id: &str, index: usize) -> Option<TranscriptPart> {
    let text = block.get("text").and_then(Value::as_str)?;
    if text.is_empty() {
        return None;
    }
    Some(TranscriptPart {
        id: format!("{row_id}:part:{index}"),
        part_type: "text".to_string(),
        text: Some(text.to_string()),
        data: Value::Null,
    })
}

fn image_part_from_block(block: &Value, row_id: &str, index: usize) -> Option<TranscriptPart> {
    let blob = block.get("blob")?;
    let mime_type = string_field(blob, "mime_type")?;
    let mut data = serde_json::Map::new();
    data.insert("mime_type".to_string(), Value::String(mime_type));
    if let Some(kind) = string_field(blob, "kind") {
        data.insert("kind".to_string(), Value::String(kind));
    }
    if let Some(encoded) = string_field(blob, "data") {
        data.insert("data".to_string(), Value::String(encoded));
    }
    if let Some(blob_id) = string_field(blob, "blob_id") {
        data.insert("blob_id".to_string(), Value::String(blob_id));
    }
    if let Some(sha256) = string_field(blob, "sha256") {
        data.insert("sha256".to_string(), Value::String(sha256));
    }
    if let Some(size_bytes) = blob.get("size_bytes").and_then(Value::as_u64) {
        data.insert("size_bytes".to_string(), Value::from(size_bytes));
    }

    Some(TranscriptPart {
        id: format!("{row_id}:part:{index}"),
        part_type: "image".to_string(),
        text: None,
        data: Value::Object(data),
    })
}

fn delta_from_payload(payload: &Value) -> &str {
    payload.get("delta").and_then(Value::as_str).unwrap_or("")
}

fn stable_message_id(event: &CanonicalEvent) -> String {
    string_field(&event.payload, "message_id").unwrap_or_else(|| event.event_id.to_string())
}

fn turn_id_from_payload(event: &CanonicalEvent) -> Option<TurnId> {
    string_field(&event.payload, "turn_id").map(TurnId::from)
}

fn string_field(payload: &Value, field: &str) -> Option<String> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn activity_identity(event: &CanonicalEvent) -> Option<(ActivityKind, String, String)> {
    if matches_event(event, "tool.") {
        return Some((
            ActivityKind::Tool,
            string_field(&event.payload, "tool_id").unwrap_or_else(|| event.event_id.to_string()),
            string_field(&event.payload, "name").unwrap_or_else(|| "Tool".into()),
        ));
    }
    if matches_event(event, "command.") {
        return Some((
            ActivityKind::Command,
            string_field(&event.payload, "command_id")
                .unwrap_or_else(|| event.event_id.to_string()),
            string_field(&event.payload, "command").unwrap_or_else(|| "Command".into()),
        ));
    }
    if matches_event(event, "task.") {
        return Some((
            ActivityKind::Task,
            string_field(&event.payload, "task_id").unwrap_or_else(|| event.event_id.to_string()),
            string_field(&event.payload, "title").unwrap_or_else(|| "Task".into()),
        ));
    }
    if matches_event(event, "request.") {
        return Some((
            ActivityKind::Request,
            string_field(&event.payload, "request_id")
                .unwrap_or_else(|| event.event_id.to_string()),
            string_field(&event.payload, "title").unwrap_or_else(|| "Request".into()),
        ));
    }
    if event.event_type == EventType::DIFF_UPDATED {
        return Some((
            ActivityKind::Diff,
            string_field(&event.payload, "diff_id").unwrap_or_else(|| event.event_id.to_string()),
            string_field(&event.payload, "title").unwrap_or_else(|| "Diff".into()),
        ));
    }
    if event.event_type == EventType::WARNING_RAISED {
        return Some((
            ActivityKind::Warning,
            event.event_id.to_string(),
            string_field(&event.payload, "message").unwrap_or_else(|| "Warning".into()),
        ));
    }
    if event.event_type == EventType::ERROR_RAISED {
        return Some((
            ActivityKind::Error,
            event.event_id.to_string(),
            string_field(&event.payload, "message").unwrap_or_else(|| "Error".into()),
        ));
    }
    if matches_event(event, "turn.") {
        return Some((
            ActivityKind::Turn,
            string_field(&event.payload, "turn_id").unwrap_or_else(|| "current_turn".into()),
            event.event_type.0.to_string(),
        ));
    }
    None
}

fn matches_event(event: &CanonicalEvent, prefix: &str) -> bool {
    event.event_type.0.starts_with(prefix)
}

fn status_from_payload(payload: &Value, event_type: &EventType) -> Option<String> {
    string_field(payload, "status").or_else(|| {
        event_type
            .0
            .rsplit_once('.')
            .map(|(_, status)| status.to_string())
    })
}

fn merge_activity_status(current: Option<&str>, incoming: Option<&str>) -> Option<String> {
    match (current, incoming) {
        (Some(current), Some(incoming))
            if is_terminal_activity_status(current) && !is_terminal_activity_status(incoming) =>
        {
            Some(current.to_string())
        }
        (_, Some(incoming)) => Some(incoming.to_string()),
        (Some(current), None) => Some(current.to_string()),
        (None, None) => None,
    }
}

fn is_terminal_activity_status(status: &str) -> bool {
    matches!(
        status,
        "completed" | "failed" | "cancelled" | "canceled" | "resolved"
    )
}

fn merge_payload(old: &Value, new: &Value) -> Value {
    match (old, new) {
        (Value::Object(old), Value::Object(new)) => {
            let mut merged = old.clone();
            for (key, value) in new {
                merged.insert(key.clone(), value.clone());
            }
            Value::Object(merged)
        }
        (_, new) => new.clone(),
    }
}
