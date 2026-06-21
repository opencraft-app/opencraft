import type {
  ChatTranscriptWireView,
  CursorWindow,
  EventCursorWire,
  StreamReadModelRefreshPlan,
  TranscriptWirePart,
  TranscriptWireRow,
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
  "command.started",
  "command.output.delta",
  "command.completed",
  "command.failed",
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

export function applyTranscriptLiveOverlay(
  transcript: ChatTranscriptWireView,
  event: VelaStreamEventWire,
): ChatTranscriptWireView {
  if (
    isDifferentKnownStreamSession(transcript.session_id, event.session_id)
  ) {
    return transcript;
  }
  if (!isStreamEventNewerThanCursor(transcript.cursor, event)) return transcript;

  if (event.type === "assistant.message.delta") {
    const delta = stringPayload(event, "delta");
    if (!delta) return updateTranscriptCursor(transcript, event);
    return appendAssistantDelta(transcript, event, delta);
  }

  return updateTranscriptCursor(transcript, event);
}

export function needsTranscriptRefreshAfterLiveOverlay(
  transcript: ChatTranscriptWireView,
  event: VelaStreamEventWire,
) {
  if (event.type !== "assistant.message.delta") return false;
  if (isDifferentKnownStreamSession(transcript.session_id, event.session_id)) {
    return false;
  }
  if (!isStreamEventNewerThanCursor(transcript.cursor, event)) return false;
  const delta = stringPayload(event, "delta");
  if (!delta) return false;
  return !hasAssistantOverlayTarget(transcript, event);
}

export function streamReadModelRefreshPlan(
  event: VelaStreamEventWire | null,
): StreamReadModelRefreshPlan {
  if (!event) return emptyRefreshPlan();
  if (event.type === "sync.reset") return resetRefreshPlan(event.views);
  if (event.type === "assistant.message.delta") return emptyRefreshPlan();
  const hintedPlan = affectedViewsRefreshPlan(event.affected_views);
  const typePlan = {
    transcript: transcriptRefreshEvents.has(event.type),
    activity: isActivityRefreshEvent(event.type),
    requests: isRequestRefreshEvent(event.type),
    diffs: event.type === "diff.updated",
    session: sessionRefreshEvents.has(event.type),
    backends: event.type.startsWith("backend."),
  };

  return {
    transcript: typePlan.transcript || hintedPlan.transcript,
    activity: typePlan.activity || hintedPlan.activity,
    requests: typePlan.requests || hintedPlan.requests,
    diffs: typePlan.diffs || hintedPlan.diffs,
    session: typePlan.session || hintedPlan.session,
    backends: typePlan.backends || event.type === "usage.updated" || hintedPlan.backends,
  };
}

export interface SessionEventStreamAfterIdInput {
  transcript?: EventCursorWire | null;
  activity?: EventCursorWire | null;
}

export function selectSessionEventStreamAfterId({
  transcript,
  activity,
}: SessionEventStreamAfterIdInput): string | null {
  const cursors = [transcript, activity].filter(
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
  transcript?: EventCursorWire | null;
  activity?: EventCursorWire | null;
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
    transcript:
      plan.transcript && isStreamEventFreshForReadModelCursor(cursors.transcript, event),
    activity: plan.activity && isStreamEventFreshForReadModelCursor(cursors.activity, event),
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

function appendAssistantDelta(
  transcript: ChatTranscriptWireView,
  event: VelaStreamEventWire,
  delta: string,
): ChatTranscriptWireView {
  const { rowId, fallbackIndex } = assistantOverlayTarget(transcript, event);
  const rows = transcript.rows.map((row, index): TranscriptWireRow => {
    if (row.kind !== "assistant_message") return row;
    if (rowId ? row.id !== rowId : index !== fallbackIndex) return row;
    if (!isLiveAssistantRow(row)) return row;
    if (event.event_id && row.source_event_ids.includes(event.event_id)) return row;
    return {
      ...row,
      updated_at: event.created_at ?? row.updated_at,
      revision: row.revision + 1,
      status: "streaming",
      text: `${assistantRowText(row)}${delta}`,
      source_event_ids: event.event_id
        ? [...row.source_event_ids, event.event_id]
        : row.source_event_ids,
    };
  });

  const changed = rows.some((row, index) => row !== transcript.rows[index]);
  if (changed) return { ...updateTranscriptCursor(transcript, event), rows };

  return updateTranscriptCursor(transcript, event);
}

function assistantRowText(row: TranscriptWireRow): string {
  return row.text || textFromTranscriptWireParts(row.parts);
}

function textFromTranscriptWireParts(parts: TranscriptWirePart[] | undefined): string {
  return (parts ?? [])
    .filter(isTextualTranscriptWirePart)
    .map((part) => part.text)
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

function isTextualTranscriptWirePart(part: TranscriptWirePart): boolean {
  return part.type === "text" || part.type === "markdown" || part.type === "code";
}

function hasAssistantOverlayTarget(
  transcript: ChatTranscriptWireView,
  event: VelaStreamEventWire,
) {
  const { rowId, fallbackIndex } = assistantOverlayTarget(transcript, event);
  if (rowId) {
    return transcript.rows.some(
      (row) => row.kind === "assistant_message" && row.id === rowId && isLiveAssistantRow(row),
    );
  }
  return fallbackIndex >= 0;
}

function assistantOverlayTarget(
  transcript: ChatTranscriptWireView,
  event: VelaStreamEventWire,
) {
  const rowId = messageRowId(event);
  const fallbackIndex = rowId
    ? -1
    : findLastIndex(
        transcript.rows,
        (row) => row.kind === "assistant_message" && row.status === "streaming",
      );
  return { rowId, fallbackIndex };
}

function isLiveAssistantRow(row: TranscriptWireRow) {
  return row.status === "streaming" || row.status === "pending";
}

function updateTranscriptCursor(
  transcript: ChatTranscriptWireView,
  event: VelaStreamEventWire,
): ChatTranscriptWireView {
  return {
    ...transcript,
    cursor: {
      ...transcript.cursor,
      ...(event.event_id ? { event_id: event.event_id } : {}),
      epoch: event.epoch ?? transcript.cursor.epoch,
      seq: event.seq ?? transcript.cursor.seq,
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

const transcriptRefreshEvents = new Set([
  "user.message.accepted",
  "input.queued",
  "turn.started",
  "assistant.message.started",
  "assistant.message.completed",
  "session.status.changed",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
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

function isActivityRefreshEvent(eventType: string) {
  return (
    eventType.startsWith("input.") ||
    eventType.startsWith("tool.") ||
    eventType.startsWith("command.") ||
    eventType.startsWith("task.") ||
    eventType.startsWith("request.") ||
    eventType === "turn.started" ||
    eventType === "turn.completed" ||
    eventType === "turn.cancel.accepted" ||
    eventType === "turn.cancelled" ||
    eventType === "assistant.reasoning.delta" ||
    eventType === "assistant.reasoning.completed" ||
    eventType === "diff.updated" ||
    eventType === "warning.raised" ||
    eventType === "error.raised" ||
    eventType === "turn.failed"
  );
}

function isRequestRefreshEvent(eventType: string) {
  return eventType.startsWith("request.");
}

function emptyRefreshPlan(): StreamReadModelRefreshPlan {
  return {
    transcript: false,
    activity: false,
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
    transcript: workbench || viewSet.has("transcript"),
    activity:
      workbench ||
      viewSet.has("activity") ||
      viewSet.has("requests") ||
      viewSet.has("diffs"),
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
    transcript: workbench || viewSet.has("transcript"),
    activity:
      workbench ||
      viewSet.has("activity") ||
      viewSet.has("requests") ||
      viewSet.has("diffs"),
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
