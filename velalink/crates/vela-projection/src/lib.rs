use std::collections::BTreeMap;

use serde_json::{Map, Value};
use vela_core::{
    CanonicalEvent, ConversationItem, ConversationItemKind, ConversationPart, ConversationView,
    ConversationWindow, ConversationWindowView, EventCursor, EventType, PendingRequest,
    PendingRequestsView, RequestId, SessionId, SourceEventRange, TurnId,
};

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

pub fn project_conversation(events: &[CanonicalEvent]) -> ConversationView {
    let session_id = session_id_from_events(events);
    let mut items: Vec<ConversationItem> = Vec::new();

    for event in events {
        if event.event_type == EventType::USER_MESSAGE_ACCEPTED {
            items.push(ConversationItem {
                item_id: event.event_id.to_string(),
                session_id: event.session_id.clone(),
                kind: ConversationItemKind::UserMessage,
                turn_id: turn_id_from_payload(event),
                created_at: event.created_at,
                updated_at: event.created_at,
                revision: 1,
                status: "completed".to_string(),
                text: Some(text_from_payload(&event.payload)),
                parts: conversation_parts_from_payload(&event.payload, event.event_id.as_str()),
                title: None,
                summary: None,
                detail: Value::Null,
                source_event_ids: vec![event.event_id.clone()],
                source_event_ranges: vec![source_event_range(event)],
            });
            continue;
        }

        if event.event_type == EventType::TURN_STARTED {
            if let Some(turn_id) = turn_id_from_payload(event) {
                upsert_turn_meta(&mut items, event, turn_id.clone(), "running");
                attach_turn_to_latest_user_without_turn(&mut items, &turn_id, event);
            }
            continue;
        }

        if event.event_type == EventType::ASSISTANT_MESSAGE_STARTED {
            let item_id = stable_message_id(event);
            items.push(ConversationItem {
                item_id,
                session_id: event.session_id.clone(),
                kind: ConversationItemKind::AssistantMessage,
                turn_id: turn_id_from_payload(event),
                created_at: event.created_at,
                updated_at: event.created_at,
                revision: 1,
                status: "streaming".to_string(),
                text: Some(String::new()),
                parts: Vec::new(),
                title: None,
                summary: None,
                detail: Value::Null,
                source_event_ids: vec![event.event_id.clone()],
                source_event_ranges: vec![source_event_range(event)],
            });
            continue;
        }

        if event.event_type == EventType::ASSISTANT_MESSAGE_DELTA {
            upsert_assistant_delta(&mut items, event);
            continue;
        }

        if event.event_type == EventType::ASSISTANT_MESSAGE_COMPLETED {
            mark_assistant_message_completed(&mut items, event);
            continue;
        }

        if event.event_type == EventType::TURN_COMPLETED {
            mark_assistant_messages_terminal_for_turn_id(
                &mut items,
                event,
                turn_id_from_payload(event),
                "completed",
            );
            mark_turn_meta_terminal(&mut items, event, "completed");
            mark_agent_work_terminal_for_turn(&mut items, event, "completed");
            continue;
        }

        if event.event_type == EventType::TURN_FAILED {
            mark_assistant_messages_terminal_for_turn_id(
                &mut items,
                event,
                turn_id_from_payload(event),
                "failed",
            );
            mark_turn_meta_terminal(&mut items, event, "failed");
            mark_agent_work_terminal_for_turn(&mut items, event, "failed");
            push_turn_status(
                &mut items,
                event,
                "failed",
                turn_status_text(event, "Turn failed"),
            );
            continue;
        }

        if event.event_type == EventType::TURN_CANCELLED {
            mark_assistant_messages_terminal_for_turn_id(
                &mut items,
                event,
                turn_id_from_payload(event),
                "cancelled",
            );
            mark_turn_meta_terminal(&mut items, event, "cancelled");
            mark_agent_work_terminal_for_turn(&mut items, event, "cancelled");
            push_turn_status(
                &mut items,
                event,
                "cancelled",
                turn_status_text(event, "Turn cancelled"),
            );
            continue;
        }

        if event.event_type == EventType::TURN_CANCEL_ACCEPTED {
            let live_turn_id =
                turn_id_from_payload(event).or_else(|| latest_running_turn_id(&items));
            if live_turn_id.is_some() {
                mark_assistant_messages_terminal_for_turn_id(
                    &mut items,
                    event,
                    live_turn_id.clone(),
                    "cancelled",
                );
                mark_agent_work_terminal_for_turn_id(
                    &mut items,
                    live_turn_id.as_ref(),
                    event,
                    "cancelled",
                );
                mark_turn_meta_terminal(&mut items, event, "cancelled");
                push_turn_status(
                    &mut items,
                    event,
                    "cancelled",
                    turn_status_text(event, "Turn cancelled"),
                );
            }
            continue;
        }

        if let Some((work_id, title)) = agent_work_identity(event) {
            upsert_agent_work(&mut items, event, work_id, title);
        }
    }

    items.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then(item_kind_order(left.kind).cmp(&item_kind_order(right.kind)))
            .then(left.item_id.cmp(&right.item_id))
    });

    ConversationView { session_id, items }
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

fn upsert_assistant_delta(items: &mut Vec<ConversationItem>, event: &CanonicalEvent) {
    let item_id = stable_message_id(event);
    if let Some(item) = items
        .iter_mut()
        .rev()
        .find(|item| item.kind == ConversationItemKind::AssistantMessage && item.item_id == item_id)
    {
        if item.turn_id.is_none() {
            item.turn_id = turn_id_from_payload(event);
        }
        let current = item.text.get_or_insert_with(String::new);
        current.push_str(delta_from_payload(&event.payload));
        push_source_event(item, event);
        item.updated_at = event.created_at;
        item.revision += 1;
        return;
    }

    items.push(ConversationItem {
        item_id,
        session_id: event.session_id.clone(),
        kind: ConversationItemKind::AssistantMessage,
        turn_id: turn_id_from_payload(event),
        created_at: event.created_at,
        updated_at: event.created_at,
        revision: 1,
        status: "streaming".to_string(),
        text: Some(delta_from_payload(&event.payload).to_string()),
        parts: Vec::new(),
        title: None,
        summary: None,
        detail: Value::Null,
        source_event_ids: vec![event.event_id.clone()],
        source_event_ranges: vec![source_event_range(event)],
    });
}

fn mark_assistant_message_completed(items: &mut [ConversationItem], event: &CanonicalEvent) {
    let item_id = stable_message_id(event);
    if let Some(item) = items
        .iter_mut()
        .rev()
        .find(|item| item.kind == ConversationItemKind::AssistantMessage && item.item_id == item_id)
    {
        if item.turn_id.is_none() {
            item.turn_id = turn_id_from_payload(event);
        }
        item.status = "completed".to_string();
        item.updated_at = event.created_at;
        item.revision += 1;
        push_source_event(item, event);
    }
}

fn mark_assistant_messages_terminal_for_turn_id(
    items: &mut [ConversationItem],
    event: &CanonicalEvent,
    turn_id: Option<TurnId>,
    status: &str,
) {
    let mut changed = false;

    if let Some(turn_id) = turn_id.as_ref() {
        for item in items.iter_mut().filter(|item| {
            item.kind == ConversationItemKind::AssistantMessage
                && (item.status == "streaming" || item.status == "pending")
                && item.turn_id.as_ref() == Some(turn_id)
        }) {
            item.status = status.to_string();
            item.updated_at = event.created_at;
            item.revision += 1;
            push_source_event(item, event);
            changed = true;
        }
    }

    if changed {
        return;
    }

    if let Some(item) = items.iter_mut().rev().find(|item| {
        item.kind == ConversationItemKind::AssistantMessage
            && (item.status == "streaming" || item.status == "pending")
    }) {
        if item.turn_id.is_none() {
            item.turn_id = turn_id;
        }
        item.status = status.to_string();
        item.updated_at = event.created_at;
        item.revision += 1;
        push_source_event(item, event);
    }
}

fn upsert_turn_meta(
    items: &mut Vec<ConversationItem>,
    event: &CanonicalEvent,
    turn_id: TurnId,
    status: &str,
) {
    let item_id = format!("turn:{}:meta", turn_id.as_str());
    if let Some(item) = items
        .iter_mut()
        .find(|item| item.kind == ConversationItemKind::TurnMeta && item.item_id == item_id)
    {
        item.status = status.to_string();
        item.updated_at = event.created_at;
        item.revision += 1;
        push_source_event(item, event);
        return;
    }

    items.push(ConversationItem {
        item_id,
        session_id: event.session_id.clone(),
        kind: ConversationItemKind::TurnMeta,
        turn_id: Some(turn_id),
        created_at: event.created_at,
        updated_at: event.created_at,
        revision: 1,
        status: status.to_string(),
        text: None,
        parts: Vec::new(),
        title: None,
        summary: None,
        detail: Value::Null,
        source_event_ids: vec![event.event_id.clone()],
        source_event_ranges: vec![source_event_range(event)],
    });
}

fn mark_turn_meta_terminal(
    items: &mut Vec<ConversationItem>,
    event: &CanonicalEvent,
    status: &str,
) {
    let index = turn_id_from_payload(event)
        .and_then(|turn_id| {
            let item_id = format!("turn:{}:meta", turn_id.as_str());
            items.iter().position(|item| item.item_id == item_id)
        })
        .or_else(|| {
            items.iter().rposition(|item| {
                item.kind == ConversationItemKind::TurnMeta && item.status == "running"
            })
        });
    let Some(index) = index else {
        return;
    };

    let item = &mut items[index];
    item.status = status.to_string();
    item.updated_at = event.created_at;
    item.revision += 1;
    item.detail = merge_payload(&item.detail, &event.payload);
    push_source_event(item, event);
}

fn mark_agent_work_terminal_for_turn(
    items: &mut [ConversationItem],
    event: &CanonicalEvent,
    status: &str,
) {
    let turn_id = turn_id_from_payload(event);
    mark_agent_work_terminal_for_turn_id(items, turn_id.as_ref(), event, status);
}

fn mark_agent_work_terminal_for_turn_id(
    items: &mut [ConversationItem],
    turn_id: Option<&TurnId>,
    event: &CanonicalEvent,
    status: &str,
) {
    let Some(turn_id) = turn_id else {
        return;
    };
    for item in items.iter_mut().filter(|item| {
        item.kind == ConversationItemKind::AgentWork
            && item.turn_id.as_ref() == Some(turn_id)
            && is_live_status(item.status.as_str())
    }) {
        item.status = status.to_string();
        item.updated_at = event.created_at;
        item.revision += 1;
        push_source_event(item, event);
    }
}

fn latest_running_turn_id(items: &[ConversationItem]) -> Option<TurnId> {
    items
        .iter()
        .rev()
        .find(|item| item.kind == ConversationItemKind::TurnMeta && item.status == "running")
        .and_then(|item| item.turn_id.clone())
}

fn push_turn_status(
    items: &mut Vec<ConversationItem>,
    event: &CanonicalEvent,
    status: &str,
    text: String,
) {
    let item_id = format!(
        "turn:{}:status:{}",
        turn_id_from_payload(event)
            .map(|turn_id| turn_id.to_string())
            .unwrap_or_else(|| event.event_id.to_string()),
        event.event_type.0
    );
    if let Some(item) = items
        .iter_mut()
        .find(|item| item.kind == ConversationItemKind::Status && item.item_id == item_id)
    {
        item.status = status.to_string();
        item.text = Some(text);
        item.updated_at = event.created_at;
        item.revision += 1;
        item.detail = merge_payload(&item.detail, &event.payload);
        push_source_event(item, event);
        return;
    }
    items.push(ConversationItem {
        item_id,
        session_id: event.session_id.clone(),
        kind: ConversationItemKind::Status,
        turn_id: turn_id_from_payload(event),
        created_at: event.created_at,
        updated_at: event.created_at,
        revision: 1,
        status: status.to_string(),
        text: Some(text),
        parts: Vec::new(),
        title: None,
        summary: None,
        detail: merge_payload(&Value::Null, &event.payload),
        source_event_ids: vec![event.event_id.clone()],
        source_event_ranges: vec![source_event_range(event)],
    });
}

fn attach_turn_to_latest_user_without_turn(
    items: &mut [ConversationItem],
    turn_id: &TurnId,
    event: &CanonicalEvent,
) {
    if let Some(item) = items
        .iter_mut()
        .rev()
        .find(|item| item.kind == ConversationItemKind::UserMessage && item.turn_id.is_none())
    {
        item.turn_id = Some(turn_id.clone());
        item.revision += 1;
        item.updated_at = event.created_at;
        push_source_event(item, event);
    }
}

fn upsert_agent_work(
    items: &mut Vec<ConversationItem>,
    event: &CanonicalEvent,
    work_id: String,
    title: String,
) {
    if let Some(item) = items
        .iter_mut()
        .find(|item| item.kind == ConversationItemKind::AgentWork && item.item_id == work_id)
    {
        if item.turn_id.is_none() {
            item.turn_id = turn_id_from_payload(event);
        }
        item.status = merge_terminal_status(
            item.status.as_str(),
            status_from_payload(&event.payload, &event.event_type).as_deref(),
        );
        item.updated_at = event.created_at;
        item.revision += 1;
        item.summary = activity_summary_text(&event.payload).or_else(|| item.summary.clone());
        item.detail = merge_agent_work_detail(&item.detail, event);
        push_source_event(item, event);
        return;
    }

    items.push(ConversationItem {
        item_id: work_id,
        session_id: event.session_id.clone(),
        kind: ConversationItemKind::AgentWork,
        turn_id: turn_id_from_payload(event),
        created_at: event.created_at,
        updated_at: event.created_at,
        revision: 1,
        status: status_from_payload(&event.payload, &event.event_type)
            .unwrap_or_else(|| "running".to_string()),
        text: None,
        parts: Vec::new(),
        title: Some(title),
        summary: activity_summary_text(&event.payload),
        detail: merge_agent_work_detail(&Value::Null, event),
        source_event_ids: vec![event.event_id.clone()],
        source_event_ranges: vec![source_event_range(event)],
    });
}

fn default_status_for_event_type(event_type: &EventType) -> Option<&'static str> {
    if *event_type == EventType::WARNING_RAISED {
        return Some("completed");
    }
    if *event_type == EventType::ERROR_RAISED {
        return Some("failed");
    }
    None
}

fn push_source_event(item: &mut ConversationItem, event: &CanonicalEvent) {
    item.source_event_ids.push(event.event_id.clone());
    let next = source_event_range(event);
    if let Some(last) = item.source_event_ranges.last_mut() {
        if last.epoch == next.epoch && last.to_seq + 1 == next.from_seq {
            last.to_event_id = next.to_event_id;
            last.to_seq = next.to_seq;
            return;
        }
    }
    item.source_event_ranges.push(next);
}

fn source_event_range(event: &CanonicalEvent) -> SourceEventRange {
    SourceEventRange {
        epoch: event.epoch,
        from_event_id: event.event_id.clone(),
        to_event_id: event.event_id.clone(),
        from_seq: event.seq,
        to_seq: event.seq,
    }
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

fn agent_work_identity(event: &CanonicalEvent) -> Option<(String, String)> {
    if matches_event(event, "tool.") {
        let id =
            string_field(&event.payload, "tool_id").unwrap_or_else(|| event.event_id.to_string());
        return Some((
            format!("work:{id}"),
            string_field(&event.payload, "name").unwrap_or_else(|| "Tool call".into()),
        ));
    }
    if matches_event(event, "task.") {
        let id =
            string_field(&event.payload, "task_id").unwrap_or_else(|| event.event_id.to_string());
        return Some((
            format!("work:{id}"),
            string_field(&event.payload, "title").unwrap_or_else(|| "Task".into()),
        ));
    }
    if matches_event(event, "request.") {
        let id = string_field(&event.payload, "request_id")
            .unwrap_or_else(|| event.event_id.to_string());
        return Some((
            format!("work:{id}"),
            string_field(&event.payload, "title").unwrap_or_else(|| "Request".into()),
        ));
    }
    if event.event_type == EventType::DIFF_UPDATED {
        let id =
            string_field(&event.payload, "diff_id").unwrap_or_else(|| event.event_id.to_string());
        return Some((
            format!("work:{id}"),
            string_field(&event.payload, "title").unwrap_or_else(|| "Diff".into()),
        ));
    }
    if event.event_type == EventType::WARNING_RAISED {
        if is_diagnostic_only_warning(event) {
            return None;
        }
        return Some((
            format!("work:{}", event.event_id.as_str()),
            string_field(&event.payload, "message").unwrap_or_else(|| "Warning".into()),
        ));
    }
    if event.event_type == EventType::ERROR_RAISED {
        return Some((
            format!("work:{}", event.event_id.as_str()),
            string_field(&event.payload, "message").unwrap_or_else(|| "Error".into()),
        ));
    }
    None
}

fn is_diagnostic_only_warning(event: &CanonicalEvent) -> bool {
    if string_field(&event.payload, "code").as_deref() != Some("acp_warning") {
        return false;
    }

    let raw_error = event
        .raw
        .as_ref()
        .and_then(|raw| raw.get("error"))
        .and_then(Value::as_str)
        .unwrap_or_default();

    raw_error.contains("session/setModel") || raw_error.contains("session/setConfigOption")
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

fn conversation_parts_from_payload(payload: &Value, item_id: &str) -> Vec<ConversationPart> {
    let Some(blocks) = payload.get("blocks").and_then(Value::as_array) else {
        return Vec::new();
    };

    blocks
        .iter()
        .enumerate()
        .filter_map(
            |(index, block)| match block.get("type").and_then(Value::as_str) {
                Some("text") => text_part_from_block(block, item_id, index),
                Some("image") => image_part_from_block(block, item_id, index),
                _ => None,
            },
        )
        .collect()
}

fn text_part_from_block(block: &Value, item_id: &str, index: usize) -> Option<ConversationPart> {
    let text = block.get("text").and_then(Value::as_str)?;
    if text.is_empty() {
        return None;
    }
    Some(ConversationPart {
        id: format!("{item_id}:part:{index}"),
        part_type: "text".to_string(),
        text: Some(text.to_string()),
        data: Value::Null,
    })
}

fn image_part_from_block(block: &Value, item_id: &str, index: usize) -> Option<ConversationPart> {
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

    Some(ConversationPart {
        id: format!("{item_id}:part:{index}"),
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

fn matches_event(event: &CanonicalEvent, prefix: &str) -> bool {
    event.event_type.0.starts_with(prefix)
}

fn status_from_payload(payload: &Value, event_type: &EventType) -> Option<String> {
    let raw_status = string_field(payload, "status")
        .or_else(|| default_status_for_event_type(event_type).map(str::to_string))
        .or_else(|| {
            event_type
                .0
                .rsplit_once('.')
                .map(|(_, status)| status.to_string())
        })?;
    Some(normalize_conversation_item_status(
        raw_status.as_str(),
        event_type,
    ))
}

fn merge_terminal_status(current: &str, incoming: Option<&str>) -> String {
    match incoming {
        Some(incoming) if is_terminal_status(current) && !is_terminal_status(incoming) => {
            current.to_string()
        }
        Some(incoming) => incoming.to_string(),
        None => current.to_string(),
    }
}

fn is_terminal_status(status: &str) -> bool {
    matches!(
        status,
        "completed" | "failed" | "cancelled" | "canceled" | "resolved"
    )
}

fn is_live_status(status: &str) -> bool {
    matches!(
        status,
        "running" | "pending" | "streaming" | "started" | "in_progress"
    )
}

fn normalize_conversation_item_status(raw: &str, event_type: &EventType) -> String {
    match raw {
        "pending" | "queued" | "opened" => "pending",
        "running" | "started" | "in_progress" | "streaming" => "running",
        "completed" | "success" | "succeeded" | "done" | "resolved" | "updated" | "accepted" => {
            "completed"
        }
        "failed" | "error" => "failed",
        "cancelled" | "canceled" => "cancelled",
        _ if *event_type == EventType::TOOL_STARTED || *event_type == EventType::TASK_STARTED => {
            "running"
        }
        _ if *event_type == EventType::TOOL_COMPLETED => "completed",
        _ if *event_type == EventType::TOOL_FAILED => "failed",
        _ if *event_type == EventType::REQUEST_OPENED => "pending",
        _ if *event_type == EventType::REQUEST_RESOLVED => "completed",
        _ => "running",
    }
    .to_string()
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

fn turn_status_text(event: &CanonicalEvent, fallback: &str) -> String {
    activity_summary_text(&event.payload).unwrap_or_else(|| fallback.to_string())
}

fn merge_agent_work_detail(old: &Value, event: &CanonicalEvent) -> Value {
    let merged = merge_payload(old, &event.payload);
    if event.event_type != EventType::TOOL_OUTPUT_DELTA {
        return merged;
    }
    append_tool_output_delta(merged, &event.payload)
}

fn append_tool_output_delta(detail: Value, payload: &Value) -> Value {
    let delta = delta_from_payload(payload);
    if delta.is_empty() {
        return detail;
    }

    let stream_id = string_field(payload, "stream_id")
        .or_else(|| string_field(payload, "stream"))
        .unwrap_or_else(|| "stdout".to_string());
    let sequence = payload
        .get("sequence")
        .or_else(|| payload.get("seq"))
        .and_then(Value::as_i64);
    let chunk_id = string_field(payload, "chunk_id").or_else(|| string_field(payload, "chunkId"));

    let mut object = match detail {
        Value::Object(object) => object,
        Value::Null => Map::new(),
        other => {
            let mut object = Map::new();
            object.insert("value".to_string(), other);
            object
        }
    };

    append_stream_summary(
        &mut object,
        &stream_id,
        delta,
        sequence,
        chunk_id.as_deref(),
    );
    if let Some(Value::Object(shell_detail)) = object.get_mut("detail") {
        append_stream_summary(
            shell_detail,
            &stream_id,
            delta,
            sequence,
            chunk_id.as_deref(),
        );
        append_shell_output_aliases(shell_detail, &stream_id, delta);
    } else {
        append_shell_output_aliases(&mut object, &stream_id, delta);
    }

    Value::Object(object)
}

fn append_stream_summary(
    object: &mut Map<String, Value>,
    stream_id: &str,
    delta: &str,
    sequence: Option<i64>,
    chunk_id: Option<&str>,
) {
    let streams = object
        .entry("streams".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !streams.is_array() {
        *streams = Value::Array(Vec::new());
    }
    let streams = streams
        .as_array_mut()
        .expect("streams value was normalized to an array");

    let stream_index = streams.iter().position(|stream| {
        stream
            .get("stream_id")
            .or_else(|| stream.get("stream"))
            .and_then(Value::as_str)
            == Some(stream_id)
    });

    let stream = if let Some(index) = stream_index {
        if !streams[index].is_object() {
            streams[index] = Value::Object(Map::new());
        }
        streams[index]
            .as_object_mut()
            .expect("stream summary was normalized to an object")
    } else {
        streams.push(Value::Object(Map::new()));
        streams
            .last_mut()
            .and_then(Value::as_object_mut)
            .expect("pushed stream summary object")
    };

    stream.insert(
        "stream_id".to_string(),
        Value::String(stream_id.to_string()),
    );
    stream.insert("stream".to_string(), Value::String(stream_id.to_string()));
    append_string_field(stream, "text", delta);
    stream.insert("last_delta".to_string(), Value::String(delta.to_string()));
    let chunk_count = stream
        .get("chunk_count")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        + 1;
    stream.insert("chunk_count".to_string(), Value::from(chunk_count));
    if let Some(sequence) = sequence {
        stream.insert("last_sequence".to_string(), Value::from(sequence));
    }
    if let Some(chunk_id) = chunk_id {
        stream.insert(
            "last_chunk_id".to_string(),
            Value::String(chunk_id.to_string()),
        );
    }
}

fn append_shell_output_aliases(object: &mut Map<String, Value>, stream_id: &str, delta: &str) {
    match stream_id {
        "stderr" => append_string_field(object, "stderr", delta),
        "stdout" => {
            append_string_field(object, "stdout", delta);
            append_string_field(object, "output", delta);
        }
        _ => {}
    }
}

fn append_string_field(object: &mut Map<String, Value>, field: &str, delta: &str) {
    let mut text = object
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    text.push_str(delta);
    object.insert(field.to_string(), Value::String(text));
}

fn merge_payload(old: &Value, new: &Value) -> Value {
    match (old, new) {
        (Value::Object(old), Value::Object(new)) => {
            let mut merged = old.clone();
            for (key, value) in new {
                let next = match merged.get(key) {
                    Some(existing)
                        if key == "type" && is_unknown_over_known_type(existing, value) =>
                    {
                        existing.clone()
                    }
                    Some(existing) => merge_payload(existing, value),
                    None => value.clone(),
                };
                merged.insert(key.clone(), next);
            }
            Value::Object(merged)
        }
        (Value::String(old), Value::String(new)) if !old.is_empty() && new.is_empty() => {
            Value::String(old.clone())
        }
        (old, Value::Null) if !old.is_null() => old.clone(),
        (_, new) => new.clone(),
    }
}

fn is_unknown_over_known_type(existing: &Value, next: &Value) -> bool {
    matches!(
        (existing.as_str(), next.as_str()),
        (Some(existing), Some("unknown")) if existing != "unknown"
    )
}
