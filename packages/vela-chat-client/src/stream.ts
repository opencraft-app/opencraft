import type {
  ConversationWireItem,
  ConversationWireView,
  CursorWindow,
  EventCursorWire,
  StreamReadModelRefreshPlan,
  VelaStreamEventWire,
} from "./wire";
import { findLastIndex, isRecord } from "./guards";

export interface VelaEventSourceHandlers {
  onEvent: (event: MessageEvent | Event) => void;
  onOpen?: (event: Event) => void;
  onError?: (event: Event) => void;
}

export interface StreamRefreshScheduler {
  notifyStreamEvent: () => void;
  dispose: () => void;
}

export interface StreamRefreshSchedulerOptions {
  refresh: () => void | Promise<void>;
  minIntervalMs?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

export const VELA_SESSION_STREAM_EVENT_TYPES = [
  "session.created",
  "session.updated",
  "session.config.updated",
  "session.status.changed",
  "session.closed",
  "user.message.accepted",
  "input.queued",
  "input.rejected",
  "turn.cancel.accepted",
  "request.response.accepted",
  "turn.started",
  "assistant.message.started",
  "assistant.message.delta",
  "assistant.message.completed",
  "assistant.reasoning.delta",
  "assistant.reasoning.completed",
  "tool.started",
  "tool.updated",
  "tool.output.delta",
  "tool.completed",
  "tool.failed",
  "task.started",
  "task.updated",
  "task.completed",
  "request.opened",
  "request.updated",
  "request.resolved",
  "diff.updated",
  "projection.invalidated",
  "warning.raised",
  "error.raised",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "backend.status.changed",
  "usage.updated",
  "sync.reset",
] as const;

export function subscribeVelaEventSource(
  source: EventSource,
  handlers: VelaEventSourceHandlers,
) {
  source.onopen = handlers.onOpen ?? null;
  source.onerror = handlers.onError ?? null;
  source.onmessage = handlers.onEvent;
  for (const eventType of VELA_SESSION_STREAM_EVENT_TYPES) {
    source.addEventListener(eventType, handlers.onEvent);
  }

  return () => {
    source.onopen = null;
    source.onerror = null;
    source.onmessage = null;
    for (const eventType of VELA_SESSION_STREAM_EVENT_TYPES) {
      source.removeEventListener(eventType, handlers.onEvent);
    }
  };
}

export function readVelaStreamEvent(event: MessageEvent | Event): VelaStreamEventWire | null {
  const data = "data" in event ? event.data : undefined;
  if (typeof data !== "string" || data.length === 0) return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed)) return null;
    const eventType =
      typeof parsed.type === "string"
        ? parsed.type
        : event.type && event.type !== "message"
          ? event.type
          : "";
    if (!eventType) return null;
    return {
      event_id: typeof parsed.event_id === "string" ? parsed.event_id : undefined,
      epoch: typeof parsed.epoch === "number" ? parsed.epoch : undefined,
      seq: typeof parsed.seq === "number" ? parsed.seq : undefined,
      session_id: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
      type: eventType,
      created_at: typeof parsed.created_at === "string" ? parsed.created_at : undefined,
      payload: isRecord(parsed.payload) ? parsed.payload : undefined,
      affected_views: Array.isArray(parsed.affected_views)
        ? parsed.affected_views.filter((view): view is string => typeof view === "string")
        : undefined,
      views: Array.isArray(parsed.views)
        ? parsed.views.filter((view): view is string => typeof view === "string")
        : undefined,
    };
  } catch {
    return null;
  }
}

export function isVelaStreamEventForSession(
  sessionId: string | undefined,
  event: VelaStreamEventWire,
) {
  return !isDifferentKnownStreamSession(sessionId, event.session_id);
}

export function isVelaStreamEventFreshForCursor(
  cursor: EventCursorWire | CursorWindow | undefined,
  event: VelaStreamEventWire,
) {
  return cursor ? isStreamEventNewerThanCursor(cursor, event) : true;
}

export function applyConversationLiveOverlay(
  conversation: ConversationWireView,
  event: VelaStreamEventWire,
): ConversationWireView {
  if (isDifferentKnownStreamSession(conversation.session_id, event.session_id)) {
    return conversation;
  }
  if (!isStreamEventNewerThanCursor(conversation.cursor, event)) return conversation;

  if (event.type === "assistant.message.delta") {
    const delta = stringPayload(event, "delta");
    if (!delta) return updateConversationCursor(conversation, event);
    return appendConversationAssistantDelta(conversation, event, delta);
  }

  return updateConversationCursor(conversation, event);
}

export function mergeConversationSnapshot(
  current: ConversationWireView | null,
  snapshot: ConversationWireView,
): ConversationWireView {
  if (!current) return snapshot;
  if (current.session_id !== snapshot.session_id) return snapshot;
  if (compareCursorOrder(snapshot.cursor, current.cursor) < 0) return current;
  return mergeFreshConversationSnapshot(current, snapshot);
}

export function needsConversationRefreshAfterLiveOverlay(
  conversation: ConversationWireView,
  event: VelaStreamEventWire,
) {
  if (event.type !== "assistant.message.delta") return false;
  if (isDifferentKnownStreamSession(conversation.session_id, event.session_id)) {
    return false;
  }
  if (!isStreamEventNewerThanCursor(conversation.cursor, event)) return false;
  const delta = stringPayload(event, "delta");
  if (!delta) return false;
  return !hasConversationAssistantOverlayTarget(conversation, event);
}

export function streamReadModelRefreshPlan(
  event: VelaStreamEventWire | null,
): StreamReadModelRefreshPlan {
  if (!event) return emptyRefreshPlan();
  if (event.type === "sync.reset") return resetRefreshPlan(event.views);
  if (event.type === "assistant.message.delta") return emptyRefreshPlan();
  const hintedPlan = affectedViewsRefreshPlan(event.affected_views);
  const typePlan = {
    conversation: isConversationRefreshEvent(event.type),
    requests: isRequestRefreshEvent(event.type),
    diffs: event.type === "diff.updated",
    session: sessionRefreshEvents.has(event.type),
    backends: event.type.startsWith("backend."),
  };

  return {
    conversation: typePlan.conversation || hintedPlan.conversation,
    requests: typePlan.requests || hintedPlan.requests,
    diffs: typePlan.diffs || hintedPlan.diffs,
    session: typePlan.session || hintedPlan.session,
    backends: typePlan.backends || event.type === "usage.updated" || hintedPlan.backends,
  };
}

export interface SessionEventStreamAfterIdInput {
  conversation?: EventCursorWire | null;
}

export function selectSessionEventStreamAfterId({
  conversation,
}: SessionEventStreamAfterIdInput): string | null {
  const cursors = [conversation].filter(
    (cursor): cursor is EventCursorWire => Boolean(cursor?.event_id),
  );
  if (cursors.length === 0) return null;
  let oldest = cursors[0];
  for (const cursor of cursors.slice(1)) {
    if (compareCursorOrder(cursor, oldest) < 0) {
      oldest = cursor;
    }
  }
  return oldest.event_id;
}

export interface StreamReadModelRefreshCursors {
  conversation?: EventCursorWire | null;
  requests?: CursorWindow | null;
  diffs?: CursorWindow | null;
}

export function streamReadModelRefreshPlanForCursors(
  event: VelaStreamEventWire | null,
  cursors: StreamReadModelRefreshCursors,
): StreamReadModelRefreshPlan {
  const plan = streamReadModelRefreshPlan(event);
  if (!event || event.type === "sync.reset") return plan;
  return {
    ...plan,
    conversation:
      plan.conversation && isStreamEventFreshForReadModelCursor(cursors.conversation, event),
    requests: plan.requests && isStreamEventFreshForReadModelCursor(cursors.requests, event),
    diffs: plan.diffs && isStreamEventFreshForReadModelCursor(cursors.diffs, event),
  };
}

export function createStreamRefreshScheduler({
  refresh,
  minIntervalMs = 120,
  now = () => Date.now(),
  setTimeout = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout = (timer) =>
    globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>),
}: StreamRefreshSchedulerOptions): StreamRefreshScheduler {
  let disposed = false;
  let dirty = false;
  let inFlight = false;
  let timer: unknown | null = null;
  let lastRefreshAt = Number.NEGATIVE_INFINITY;

  const schedule = (delay: number) => {
    if (timer !== null || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      void runRefresh();
    }, Math.max(0, delay));
  };

  const finishRefresh = () => {
    inFlight = false;
    if (!disposed && dirty) {
      const elapsed = now() - lastRefreshAt;
      if (elapsed >= minIntervalMs) {
        runRefresh();
      } else {
        schedule(minIntervalMs - elapsed);
      }
    }
  };

  const runRefresh = () => {
    if (disposed) return;
    if (inFlight) {
      dirty = true;
      return;
    }

    inFlight = true;
    dirty = false;
    lastRefreshAt = now();
    try {
      const result = refresh();
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined).finally(finishRefresh);
      } else {
        finishRefresh();
      }
    } catch {
      finishRefresh();
    }
  };

  return {
    notifyStreamEvent() {
      if (disposed) return;
      dirty = true;
      if (inFlight || timer !== null) return;

      const elapsed = now() - lastRefreshAt;
      if (elapsed >= minIntervalMs) {
        runRefresh();
      } else {
        schedule(minIntervalMs - elapsed);
      }
    },
    dispose() {
      disposed = true;
      dirty = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function isPromiseLike(value: void | Promise<void>): value is Promise<void> {
  return typeof value === "object" && value !== null && "then" in value;
}

function mergeFreshConversationSnapshot(
  current: ConversationWireView,
  snapshot: ConversationWireView,
): ConversationWireView {
  const items = mergeConversationItemsAtOverlap(current.items, snapshot.items);
  if (items === snapshot.items) return snapshot;

  const firstItemId =
    items[0]?.id ?? snapshot.window.first_item_id ?? current.window.first_item_id ?? null;
  const lastItemId =
    items[items.length - 1]?.id ??
    snapshot.window.last_item_id ??
    current.window.last_item_id ??
    null;
  const keptCurrentPrefix =
    Boolean(current.window.first_item_id) &&
    current.window.first_item_id === firstItemId &&
    current.window.first_item_id !== snapshot.window.first_item_id;

  return {
    ...snapshot,
    items,
    window: {
      ...snapshot.window,
      first_item_id: firstItemId,
      last_item_id: lastItemId,
      anchor_item_id: snapshot.window.anchor_item_id ?? current.window.anchor_item_id ?? null,
      has_older: keptCurrentPrefix ? current.window.has_older : snapshot.window.has_older,
    },
  };
}

function mergeConversationItemsAtOverlap(
  currentItems: ConversationWireItem[],
  snapshotItems: ConversationWireItem[],
): ConversationWireItem[] {
  if (currentItems.length === 0 || snapshotItems.length === 0) return snapshotItems;

  const currentIndexById = new Map(currentItems.map((item, index) => [item.id, index]));
  const firstSnapshotOverlapIndex = snapshotItems.findIndex((item) =>
    currentIndexById.has(item.id),
  );
  if (firstSnapshotOverlapIndex < 0) return snapshotItems;

  const firstCurrentOverlapIndex = currentIndexById.get(
    snapshotItems[firstSnapshotOverlapIndex]?.id ?? "",
  );
  if (firstCurrentOverlapIndex === undefined) return snapshotItems;

  const prefix = currentItems.slice(0, firstCurrentOverlapIndex);
  if (prefix.length === 0) return snapshotItems;
  return [...prefix, ...snapshotItems.slice(firstSnapshotOverlapIndex)];
}

function appendConversationAssistantDelta(
  conversation: ConversationWireView,
  event: VelaStreamEventWire,
  delta: string,
): ConversationWireView {
  const { itemId, fallbackIndex } = conversationAssistantOverlayTarget(conversation, event);
  const items = conversation.items.map((item, index): ConversationWireItem => {
    if (item.kind !== "assistant_message") return item;
    if (itemId ? item.id !== itemId : index !== fallbackIndex) return item;
    if (!isLiveConversationAssistantItem(item)) return item;
    if (event.event_id && item.source_event_ids.includes(event.event_id)) return item;
    return {
      ...item,
      updated_at: event.created_at ?? item.updated_at,
      revision: item.revision + 1,
      status: "streaming",
      text: `${item.text ?? ""}${delta}`,
      source_event_ids: event.event_id
        ? [...item.source_event_ids, event.event_id]
        : item.source_event_ids,
      source_event_ranges: appendSourceEventRange(item.source_event_ranges, event),
    };
  });

  const changed = items.some((item, index) => item !== conversation.items[index]);
  if (changed) return { ...updateConversationCursor(conversation, event), items };

  return updateConversationCursor(conversation, event);
}

function hasConversationAssistantOverlayTarget(
  conversation: ConversationWireView,
  event: VelaStreamEventWire,
) {
  const { itemId, fallbackIndex } = conversationAssistantOverlayTarget(conversation, event);
  if (itemId) {
    return conversation.items.some(
      (item) =>
        item.kind === "assistant_message" &&
        item.id === itemId &&
        isLiveConversationAssistantItem(item),
    );
  }
  return fallbackIndex >= 0;
}

function conversationAssistantOverlayTarget(
  conversation: ConversationWireView,
  event: VelaStreamEventWire,
) {
  const itemId = messageRowId(event);
  const fallbackIndex = itemId
    ? -1
    : findLastIndex(
        conversation.items,
        (item) => item.kind === "assistant_message" && item.status === "streaming",
      );
  return { itemId, fallbackIndex };
}

function appendSourceEventRange(
  ranges: ConversationWireItem["source_event_ranges"],
  event: VelaStreamEventWire,
) {
  if (
    !event.event_id ||
    typeof event.seq !== "number" ||
    !Number.isFinite(event.seq)
  ) {
    return ranges;
  }
  const epoch = typeof event.epoch === "number" && Number.isFinite(event.epoch) ? event.epoch : 0;
  const next = {
    epoch,
    from_event_id: event.event_id,
    to_event_id: event.event_id,
    from_seq: event.seq,
    to_seq: event.seq,
  };
  const previous = ranges.at(-1);
  if (previous && previous.epoch === epoch && previous.to_seq + 1 === event.seq) {
    return [
      ...ranges.slice(0, -1),
      {
        ...previous,
        to_event_id: event.event_id,
        to_seq: event.seq,
      },
    ];
  }
  return [...ranges, next];
}

function isLiveConversationAssistantItem(item: ConversationWireItem) {
  return item.kind === "assistant_message" && (item.status === "streaming" || item.status === "pending");
}

function updateConversationCursor(
  conversation: ConversationWireView,
  event: VelaStreamEventWire,
): ConversationWireView {
  return {
    ...conversation,
    cursor: {
      ...conversation.cursor,
      ...(event.event_id ? { event_id: event.event_id } : {}),
      epoch: event.epoch ?? conversation.cursor.epoch,
      seq: event.seq ?? conversation.cursor.seq,
    },
  };
}

function isStreamEventNewerThanCursor(
  cursor: EventCursorWire | CursorWindow,
  event: VelaStreamEventWire,
) {
  if (isKnownCursorEvent(cursor, event.event_id)) return false;
  const cursorOrder = eventCursorOrder(cursor);
  const eventOrder = streamEventOrder(event);
  if (!cursorOrder || !eventOrder) return true;
  if (eventOrder.epoch > cursorOrder.epoch) return true;
  if (eventOrder.epoch < cursorOrder.epoch) return false;
  return eventOrder.seq > cursorOrder.seq;
}

function isStreamEventFreshForReadModelCursor(
  cursor: EventCursorWire | CursorWindow | null | undefined,
  event: VelaStreamEventWire,
) {
  return cursor ? isStreamEventNewerThanCursor(cursor, event) : true;
}

function compareCursorOrder(
  left: EventCursorWire | CursorWindow,
  right: EventCursorWire | CursorWindow,
) {
  const leftOrder = eventCursorOrder(left);
  const rightOrder = eventCursorOrder(right);
  if (!leftOrder && !rightOrder) return 0;
  if (!leftOrder) return 1;
  if (!rightOrder) return -1;
  if (leftOrder.epoch !== rightOrder.epoch) return leftOrder.epoch - rightOrder.epoch;
  return leftOrder.seq - rightOrder.seq;
}

function isKnownCursorEvent(
  cursor: EventCursorWire | CursorWindow,
  eventId: string | undefined,
) {
  const latestEventId = "latest_event_id" in cursor ? cursor.latest_event_id : undefined;
  const nextEventId = "next_event_id" in cursor ? cursor.next_event_id : undefined;
  return Boolean(
    eventId &&
      (cursor.event_id === eventId || latestEventId === eventId || nextEventId === eventId),
  );
}

function isDifferentKnownStreamSession(
  transcriptSessionId: string | undefined,
  eventSessionId: string | undefined,
) {
  return Boolean(transcriptSessionId && eventSessionId && transcriptSessionId !== eventSessionId);
}

function eventCursorOrder(cursor: EventCursorWire | CursorWindow) {
  const seq =
    typeof cursor.seq === "number"
      ? cursor.seq
      : "to_seq" in cursor
        ? cursor.to_seq
        : undefined;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return null;
  return {
    epoch:
      typeof cursor.epoch === "number" && Number.isFinite(cursor.epoch)
        ? cursor.epoch
        : 0,
    seq,
  };
}

function streamEventOrder(event: VelaStreamEventWire) {
  if (typeof event.seq !== "number" || !Number.isFinite(event.seq)) return null;
  return {
    epoch:
      typeof event.epoch === "number" && Number.isFinite(event.epoch)
        ? event.epoch
        : 0,
    seq: event.seq,
  };
}

const conversationRefreshEvents = new Set([
  "user.message.accepted",
  "input.queued",
  "input.rejected",
  "request.response.accepted",
  "turn.started",
  "assistant.message.started",
  "assistant.message.completed",
  "session.status.changed",
  "turn.cancel.accepted",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "diff.updated",
  "warning.raised",
  "error.raised",
]);

const sessionRefreshEvents = new Set([
  "session.created",
  "session.updated",
  "session.config.updated",
  "session.status.changed",
  "session.closed",
  "backend.status.changed",
  "user.message.accepted",
  "turn.started",
  "turn.cancel.accepted",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "usage.updated",
]);

function isConversationRefreshEvent(eventType: string) {
  return (
    conversationRefreshEvents.has(eventType) ||
    eventType.startsWith("tool.") ||
    eventType.startsWith("command.") ||
    eventType.startsWith("task.") ||
    eventType.startsWith("request.") ||
    eventType.startsWith("assistant.reasoning.")
  );
}

function isRequestRefreshEvent(eventType: string) {
  return eventType.startsWith("request.");
}

function emptyRefreshPlan(): StreamReadModelRefreshPlan {
  return {
    conversation: false,
    requests: false,
    diffs: false,
    session: false,
    backends: false,
  };
}

function resetRefreshPlan(views: string[] | undefined): StreamReadModelRefreshPlan {
  const viewSet = new Set(views?.length ? views : ["workbench"]);
  const workbench = viewSet.has("workbench");
  return {
    conversation: workbench || viewSet.has("conversation"),
    requests: workbench || viewSet.has("requests"),
    diffs: workbench || viewSet.has("diffs"),
    session: workbench || viewSet.has("session") || viewSet.has("sessions"),
    backends: workbench || viewSet.has("backends"),
  };
}

function affectedViewsRefreshPlan(views: string[] | undefined): StreamReadModelRefreshPlan {
  if (!views?.length) return emptyRefreshPlan();
  const viewSet = new Set(views);
  const workbench = viewSet.has("workbench");
  return {
    conversation: workbench || viewSet.has("conversation"),
    requests: workbench || viewSet.has("requests"),
    diffs: workbench || viewSet.has("diffs"),
    session: workbench || viewSet.has("session") || viewSet.has("sessions"),
    backends: workbench || viewSet.has("backends"),
  };
}

function messageRowId(event: VelaStreamEventWire) {
  return stringPayload(event, "message_id");
}

function stringPayload(event: VelaStreamEventWire, field: string) {
  const value = event.payload?.[field];
  return typeof value === "string" ? value : undefined;
}
