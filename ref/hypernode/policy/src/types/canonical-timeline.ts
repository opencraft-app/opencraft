import type { ThreadId } from "./domain.js";
import type { AppServerConnection, AppServerParams } from "./appserver.ts";

export type CanonicalEventType =
  | "turn.started"
  | "turn.completed"
  | "item.started"
  | "item.completed"
  | "item.delta"
  | "thread.status.changed"
  | "thread.name.updated"
  | "turn.plan.updated"
  | "thread.realtime"
  | "appserver.notification"
  | (string & {});

export interface CanonicalContentPart {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface CanonicalItem {
  id?: string | null;
  type?: string;
  text?: string;
  summary?: unknown;
  explanation?: unknown;
  plan?: unknown;
  content?: CanonicalContentPart[];
  aggregatedOutput?: string | null;
  command?: unknown;
  contentItems?: unknown;
  arguments?: unknown;
  result?: unknown;
  changes?: unknown;
  results?: unknown;
  query?: unknown;
  path?: unknown;
  [key: string]: unknown;
}

export interface CanonicalTurn {
  id: string;
  items: CanonicalItem[];
  status: string;
  error: unknown;
  startedAt: unknown;
  completedAt: unknown;
  durationMs: unknown;
  itemsView: string;
  [key: string]: unknown;
}

export interface CanonicalTurnSeed {
  id?: string | null;
  items?: CanonicalItem[];
  status?: string;
  error?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  durationMs?: unknown;
  itemsView?: string;
  [key: string]: unknown;
}

export interface CanonicalParams {
  threadId?: string | null;
  turnId?: string | null;
  itemId?: string | null;
  item?: CanonicalItem;
  thread?: { id?: string | null; [key: string]: unknown };
  turn?: CanonicalTurnSeed;
  delta?: string;
  contentIndex?: number;
  summaryIndex?: number;
  limit?: number;
  cursor?: string | CanonicalCursor | null;
  direction?: string;
  input?: CanonicalContentPart[];
  clientUserMessageId?: string | null;
  [key: string]: unknown;
}

export interface CanonicalEventData {
  method?: string;
  params?: CanonicalParams;
  [key: string]: unknown;
}

export interface CanonicalEventSource {
  engine?: string;
  kind?: string;
  id?: string | number | null;
  eventId?: string | null;
  time?: number;
  persistDelta?: boolean;
  [key: string]: unknown;
}

export interface StableCanonicalEventSource {
  engine: string;
  kind: string;
  id?: string;
  [key: string]: unknown;
}

export interface CanonicalEventInput {
  eventId?: string | null;
  type?: CanonicalEventType;
  time?: number;
  turnId?: string | null;
  itemId?: string | null;
  data?: CanonicalEventData;
  source?: CanonicalEventSource;
}

export interface CanonicalEvent {
  id: string;
  threadId: ThreadId;
  epoch: string;
  seq: number;
  type: CanonicalEventType;
  time: number;
  turnId: string | null;
  itemId: string | null;
  data: CanonicalEventData;
  source: StableCanonicalEventSource;
}

export interface CanonicalHead {
  threadId: ThreadId;
  epoch: string;
  nextSeq: number;
  minSeq: number;
}

export interface CanonicalMemoryHead extends CanonicalHead {
  entries: CanonicalEvent[];
  ids: Map<string, { event: CanonicalEvent; payloadHash: string }>;
}

export interface CanonicalCursor {
  epoch: string;
  seq: number;
}

export interface TimelineCursor {
  version: 2;
  epoch: string;
  position: number;
  ordinal: number;
}

export interface TimelineListParams {
  threadId?: string;
  limit?: number;
  cursor?: string | null;
}

export interface SyncParams {
  limit?: number;
  cursor?: CanonicalCursor | null;
  direction?: "after" | "before" | "tail" | string;
}

export interface ForkOptions {
  cursor?: CanonicalCursor | null;
  lastTurnId?: string | null;
}

export interface RangeOptions {
  direction?: "after" | "before" | "tail" | string;
  boundary?: number | null;
  limit?: number;
}

export interface SourceSeqRange {
  startSeq: number;
  endSeq: number;
}

export type TimelineCollapseKind = "tool_lifecycle" | "reasoning_merge" | "assistant_merge";

interface TimelineEntryBase {
  position: number;
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges: SourceSeqRange[];
  collapsed: TimelineCollapseKind[];
  turnId: string;
}

export interface TimelineTurnStarted extends TimelineEntryBase {
  type: "turnStarted";
  startedAt: unknown;
}

export interface TimelineItem extends TimelineEntryBase {
  type: "item";
  item: CanonicalItem;
}

export interface TimelineTurnCompleted extends TimelineEntryBase {
  type: "turnCompleted";
  status: string;
  error: unknown;
  startedAt: unknown;
  completedAt: unknown;
  durationMs: unknown;
}

export type TimelineEntry = TimelineTurnStarted | TimelineItem | TimelineTurnCompleted;
export type TimelineProjectionRow = TimelineEntry & { __ordinal: number };

export interface TimelinePage {
  data: TimelineEntry[];
  nextCursor: string | null;
  activeRealtimeSessionAtPageStart: null;
}

export interface CanonicalFailure {
  threadId: ThreadId;
  method: string;
  eventId: string | null;
  sourceEngine: string | null;
  errorMessage: string;
  failedAtMs: number;
}

export interface FailureInput {
  method: string;
  eventId?: string | null;
  sourceEngine?: string | null;
  error: unknown;
}

export interface AppServerRegistrationPort {
  register(
    method: string,
    handler: (params: CanonicalParams, connection: AppServerConnection) => unknown,
  ): () => boolean;
  broadcastNotification(
    method: string,
    params: AppServerParams,
    options?: { sensitive?: boolean },
  ): void;
}

export interface ThreadLookupPort {
  get(threadId: string): {
    id: string;
    cwd: string;
    status: { type: string; [key: string]: unknown };
    projectId?: string | null;
    [key: string]: unknown;
  };
}

export interface CanonicalTimelinePort {
  append(threadId: unknown, input?: CanonicalEventInput): CanonicalAppendResult;
  appendBatch(threadId: unknown, inputs: CanonicalEventInput[]): CanonicalAppendResult[];
  entries(threadId: unknown): CanonicalEvent[];
  head(threadId: unknown): CanonicalHead;
  sync(threadId: unknown, params?: SyncParams): CanonicalSyncResult;
  reset(threadId: unknown): CanonicalHead;
  compactThrough(threadId: unknown, cursor: CanonicalCursor): CanonicalHead;
  delete(threadId: unknown): boolean;
  fork(sourceThreadId: unknown, targetThreadId: unknown, options?: ForkOptions): CanonicalForkResult;
  recordAppServer(
    method: string,
    params: CanonicalParams,
    source?: CanonicalEventSource,
  ): CanonicalRecordResult;
  recordAppServerBatch(records: Array<{
    method: string;
    params: CanonicalParams;
    source?: CanonicalEventSource;
  }>): CanonicalRecordResult[];
  turns(threadOrId: string | { id?: string }): CanonicalTurn[];
}

export interface CanonicalAppendResult {
  appended: boolean;
  event: CanonicalEvent;
  head: CanonicalHead;
}

export interface CanonicalForkResult {
  head: CanonicalHead;
  count: number;
  sourceCursor: CanonicalCursor | null;
}

export interface CanonicalSyncResult {
  threadId: ThreadId;
  epoch: string;
  reset: boolean;
  staleCursor: boolean;
  gap: boolean;
  window: { minSeq: number; maxSeq: number; nextSeq: number };
  startCursor: CanonicalCursor | null;
  endCursor: CanonicalCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
  entries: CanonicalEvent[];
}

export type CanonicalRecordResult =
  | CanonicalAppendResult
  | { appended: false; persisted: false; failure: CanonicalFailure }
  | null;
