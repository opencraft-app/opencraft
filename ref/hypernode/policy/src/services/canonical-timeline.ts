import { Service, type Inject } from "@deepseek-ai/cordis";
import { sha256 } from "@noble/hashes/sha256";
import { utf8Encode } from "../runtime/bytes.ts";
import { asThreadId, type JsonValue, type ThreadId } from "../types/domain.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.js";
import type { DurableSql, DurableStoragePort, SqlBinding, SqlRow } from "../types/storage.js";
import type {
  CanonicalAppendResult,
  CanonicalCursor,
  CanonicalEvent,
  CanonicalEventData,
  CanonicalEventInput,
  CanonicalEventSource,
  CanonicalFailure,
  CanonicalForkResult,
  CanonicalHead,
  CanonicalItem,
  CanonicalMemoryHead,
  CanonicalParams,
  CanonicalRecordResult,
  CanonicalSyncResult,
  CanonicalTurn,
  CanonicalTurnSeed,
  FailureInput,
  ForkOptions,
  RangeOptions,
  SourceSeqRange,
  StableCanonicalEventSource,
  SyncParams,
  TimelineCollapseKind,
  TimelineEntry,
  TimelineListParams,
  TimelinePage,
  TimelineProjectionRow,
  TimelineCursor,
} from "../types/canonical-timeline.js";

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
export const CANONICAL_SCHEMA_VERSION = 2;
const LARGE_INLINE_STRING_BYTES = 64 * 1024;
const MAX_SEARCH_TEXT_BYTES = 64 * 1024;
const BLOB_REF_MARKER = "hypernode.timeline.blob.v1";
const TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "interrupted"]);

function clone<Value>(value: Value): Value {
  return value == null ? value : JSON.parse(JSON.stringify(value)) as Value;
}

function stableJsonValue(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return String(value);
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = stableJsonValue(Reflect.get(value, key));
  }
  return result;
}

function hashText(value: string): string {
  return Array.from(sha256(utf8Encode(value)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function utf8ByteLength(value: string): number {
  return utf8Encode(value).byteLength;
}

function canonicalPayloadHash(input: CanonicalEventInput | CanonicalEvent): string {
  return hashText(JSON.stringify(stableJsonValue({
    type: String(input.type ?? "unknown"),
    turnId: input.turnId ?? null,
    itemId: input.itemId ?? null,
    data: input.data ?? {},
    source: stableEventSource(input.source),
  })));
}

interface SearchProjection {
  itemType: string | null;
  searchRole: string | null;
  searchText: string | null;
}

function itemSearchProjection(event: CanonicalEvent): SearchProjection {
  if (event.type !== "item.completed") return { itemType: null, searchRole: null, searchText: null };
  const item = event.data.params?.item;
  if (!item) return { itemType: null, searchRole: null, searchText: null };
  const itemType = typeof item.type === "string" ? item.type : null;
  let searchRole: string | null = null;
  let content: unknown = null;
  if (itemType === "userMessage") {
    searchRole = "user";
    content = (Array.isArray(item.content) ? item.content : [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  } else if (itemType && ["agentMessage", "reasoning", "plan"].includes(itemType)) {
    searchRole = "assistant";
    if (itemType === "agentMessage") content = item.text;
    else if (itemType === "reasoning") content = item.summary ?? item.text;
    else content = item.explanation ?? item.plan;
  } else if (itemType) {
    searchRole = "tool";
    if (itemType === "commandExecution") content = item.aggregatedOutput ?? item.command;
    else if (itemType === "dynamicToolCall") content = item.contentItems ?? item.arguments;
    else if (itemType === "mcpToolCall") content = item.result ?? item.arguments;
    else if (itemType === "fileChange") content = item.changes;
    else if (itemType === "webSearch") content = item.results ?? item.query;
    else if (itemType === "imageView") content = item.path;
    else if (itemType === "imageGeneration") content = item.result;
    else content = item;
  }
  let searchText = typeof content === "string"
    ? content
    : content == null ? null : JSON.stringify(content);
  if (typeof searchText !== "string" || !searchText.trim()) searchText = null;
  if (searchText != null && utf8ByteLength(searchText) > MAX_SEARCH_TEXT_BYTES) {
    let low = 0;
    let high = searchText.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (utf8ByteLength(searchText.slice(0, middle)) <= MAX_SEARCH_TEXT_BYTES) low = middle;
      else high = middle - 1;
    }
    searchText = searchText.slice(0, low);
  }
  return { itemType, searchRole, searchText };
}

function mediaTypeForLargeString(value: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(value);
  return match?.[1] ?? "text/plain; charset=utf-8";
}

interface TimelineBlobReference {
  $hypernodeBlob: {
    marker: typeof BLOB_REF_MARKER;
    hash: string;
    bytes: number;
    encoding: "utf8";
    mediaType: string;
  };
}

type BlobWriter = (hash: string, content: string, bytes: number, mediaType: string) => void;
type BlobReader = (hash: string) => string | null;

function blobReference(hash: string, bytes: number, mediaType: string): TimelineBlobReference {
  return {
    $hypernodeBlob: {
      marker: BLOB_REF_MARKER,
      hash: `sha256:${hash}`,
      bytes,
      encoding: "utf8",
      mediaType,
    },
  };
}

function isBlobReference(value: unknown): value is TimelineBlobReference {
  if (value === null || typeof value !== "object" || Object.keys(value).length !== 1) return false;
  const reference = Reflect.get(value, "$hypernodeBlob");
  if (reference === null || typeof reference !== "object") return false;
  return Reflect.get(reference, "marker") === BLOB_REF_MARKER &&
    typeof Reflect.get(reference, "hash") === "string";
}

function externalizeLargeValues(value: unknown, putBlob: BlobWriter, hashes: Set<string>): unknown {
  if (typeof value === "string") {
    const bytes = utf8ByteLength(value);
    if (bytes <= LARGE_INLINE_STRING_BYTES) return value;
    const hash = hashText(value);
    putBlob(hash, value, bytes, mediaTypeForLargeString(value));
    hashes.add(hash);
    return blobReference(hash, bytes, mediaTypeForLargeString(value));
  }
  if (Array.isArray(value)) return value.map((item) => externalizeLargeValues(item, putBlob, hashes));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = externalizeLargeValues(item, putBlob, hashes);
  }
  return result;
}

function hydrateLargeValues(value: unknown, readBlob: BlobReader): unknown {
  if (isBlobReference(value)) {
    const hash = value.$hypernodeBlob.hash.replace(/^sha256:/, "");
    const content = readBlob(hash);
    if (typeof content !== "string") throw new Error(`canonical timeline blob is missing: sha256:${hash}`);
    return content;
  }
  if (Array.isArray(value)) return value.map((item) => hydrateLargeValues(item, readBlob));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = hydrateLargeValues(item, readBlob);
  return result;
}

interface PreparedCanonicalEvent {
  storedEvent: CanonicalEvent;
  blobHashes: string[];
  payloadHash: string;
  normalized: {
    schemaVersion: number;
    eventType: string;
    occurredAtMs: number;
    turnId: string | null;
    itemId: string | null;
    sourceEngine: string;
    sourceKind: string;
    itemType: string | null;
    searchRole: string | null;
    searchText: string | null;
  };
}

export function prepareCanonicalTimelineEventForStorage(
  event: CanonicalEvent,
  putBlob: BlobWriter = () => undefined,
): PreparedCanonicalEvent {
  const blobHashes = new Set<string>();
  const search = itemSearchProjection(event);
  const storedEvent: CanonicalEvent = {
    ...event,
    data: externalizeLargeValues(event.data, putBlob, blobHashes) as CanonicalEventData,
  };
  return {
    storedEvent,
    blobHashes: [...blobHashes],
    payloadHash: canonicalPayloadHash(event),
    normalized: {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      eventType: event.type,
      occurredAtMs: event.time,
      turnId: event.turnId,
      itemId: event.itemId,
      sourceEngine: event.source?.engine ?? "hypernode",
      sourceKind: event.source?.kind ?? "execution",
      ...search,
    },
  };
}

function assertThreadId(value: unknown): ThreadId {
  try {
    return asThreadId(value);
  } catch {
    throw new Error("canonical timeline threadId is required");
  }
}

function randomEpoch(): string {
  const runtimeCrypto = crypto;
  if (typeof runtimeCrypto?.randomUUID === "function") return runtimeCrypto.randomUUID();
  const random = typeof runtimeCrypto?.randomBytes === "function"
    ? String(runtimeCrypto.randomBytes(12))
    : Math.random().toString(36).slice(2);
  return `epoch-${Date.now().toString(36)}-${random}`;
}

function eventTypeForMethod(method: string): CanonicalEvent["type"] {
  if (method === "turn/started") return "turn.started";
  if (method === "turn/completed") return "turn.completed";
  if (method === "item/started") return "item.started";
  if (method === "item/completed") return "item.completed";
  if (method.startsWith("item/") && method.endsWith("/delta")) return "item.delta";
  if (method.startsWith("item/") && method.endsWith("Delta")) return "item.delta";
  if (method === "thread/status/changed") return "thread.status.changed";
  if (method === "thread/name/updated") return "thread.name.updated";
  if (method === "turn/plan/updated") return "turn.plan.updated";
  if (method.startsWith("thread/realtime/")) return "thread.realtime";
  return "appserver.notification";
}

function itemIdFromParams(params?: CanonicalParams): string | null {
  return params?.item?.id ?? params?.itemId ?? null;
}

function lifecycleEventId(method: string, params: CanonicalParams): string | null {
  const turnId = params?.turnId ?? params?.turn?.id ?? null;
  if ((method === "turn/started" || method === "turn/completed") && turnId) {
    return `${method}:${turnId}`;
  }
  const itemId = itemIdFromParams(params);
  if ((method === "item/started" || method === "item/completed") && turnId && itemId) {
    return `${method}:${turnId}:${itemId}`;
  }
  return null;
}

function stableEventSource(source: CanonicalEventSource = {}): StableCanonicalEventSource {
  return {
    engine: source.engine ?? "hypernode",
    kind: source.kind ?? "execution",
    ...(source.id == null ? {} : { id: String(source.id) }),
  };
}

function eventTurnId(event: CanonicalEvent): string | null {
  return event?.turnId ?? event?.data?.params?.turnId ?? event?.data?.params?.turn?.id ?? null;
}

function retargetEventData(
  data: CanonicalEventData,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
): CanonicalEventData {
  const result = clone(data ?? {});
  const params = result?.params;
  if (!params || typeof params !== "object") return result;
  if (params.threadId === sourceThreadId) params.threadId = targetThreadId;
  if (params.thread?.id === sourceThreadId) params.thread.id = targetThreadId;
  return result;
}

function mergeItem(current?: CanonicalItem | null, incoming?: CanonicalItem | null): CanonicalItem {
  if (!current) return clone(incoming ?? {});
  if (!incoming) return current;
  return { ...current, ...clone(incoming) };
}

function appendItemDelta(item: CanonicalItem, method: string, params: CanonicalParams): CanonicalItem {
  const delta = typeof params?.delta === "string" ? params.delta : "";
  if (!delta) return item;
  if (method === "item/agentMessage/delta") {
    item.type ??= "agentMessage";
    item.text = `${item.text ?? ""}${delta}`;
  } else if (method === "item/reasoning/textDelta") {
    item.type ??= "reasoning";
    const contentIndex = Number.isSafeInteger(params.contentIndex) ? Number(params.contentIndex) : 0;
    item.content ??= [];
    while (item.content.length <= contentIndex) item.content.push({ type: "reasoning_text", text: "" });
    const content = item.content[contentIndex];
    if (!content) return item;
    content.text = `${content.text ?? ""}${delta}`;
  } else if (method === "item/reasoning/summaryTextDelta") {
    item.type ??= "reasoning";
    const summaryIndex = Number.isSafeInteger(params.summaryIndex) ? Number(params.summaryIndex) : 0;
    const summaries: unknown[] = Array.isArray(item.summary) ? item.summary : [];
    item.summary = summaries;
    while (summaries.length <= summaryIndex) summaries.push({ type: "summary_text", text: "" });
    const summary = summaries[summaryIndex];
    if (summary === null || typeof summary !== "object") return item;
    const previous = Reflect.get(summary, "text");
    Reflect.set(summary, "text", `${typeof previous === "string" ? previous : ""}${delta}`);
  } else if (method === "item/commandExecution/outputDelta") {
    item.type ??= "commandExecution";
    item.aggregatedOutput = `${item.aggregatedOutput ?? ""}${delta}`;
  }
  return item;
}

interface TimelineReducerState {
  turns: CanonicalTurn[];
  byTurnId: Map<string, CanonicalTurn>;
}

function normalizeTurnSeed(turnId: string, seed?: CanonicalTurnSeed): CanonicalTurn {
  const cloned = clone(seed ?? {});
  return {
    ...cloned,
    id: typeof cloned.id === "string" && cloned.id ? cloned.id : turnId,
    items: Array.isArray(cloned.items) ? cloned.items : [],
    status: typeof cloned.status === "string" ? cloned.status : "inProgress",
    error: cloned.error ?? null,
    startedAt: cloned.startedAt ?? null,
    completedAt: cloned.completedAt ?? null,
    durationMs: cloned.durationMs ?? null,
    itemsView: typeof cloned.itemsView === "string" ? cloned.itemsView : "full",
  };
}

function ensureTurn(
  state: TimelineReducerState,
  turnId: string | null | undefined,
  seed?: CanonicalTurnSeed,
): CanonicalTurn | null {
  if (!turnId) return null;
  let turn = state.byTurnId.get(turnId);
  if (!turn) {
    turn = normalizeTurnSeed(turnId, seed);
    state.byTurnId.set(turnId, turn);
    state.turns.push(turn);
  } else if (seed) {
    const items = turn.items;
    Object.assign(turn, clone(seed));
    turn.items = items;
  }
  return turn;
}

function upsertTurnItem(
  turn: CanonicalTurn | null,
  incoming?: CanonicalItem | null,
  itemId = incoming?.id,
): CanonicalItem | null {
  if (!turn || !itemId) return null;
  const index = turn.items.findIndex((item) => item?.id === itemId);
  if (index < 0) {
    const item = mergeItem({ id: itemId }, incoming);
    turn.items.push(item);
    return item;
  }
  turn.items[index] = mergeItem(turn.items[index], incoming);
  return turn.items[index];
}

export function reduceCanonicalTimeline(events: readonly CanonicalEvent[]): CanonicalTurn[] {
  const state: TimelineReducerState = { turns: [], byTurnId: new Map<string, CanonicalTurn>() };
  for (const event of [...(events ?? [])].sort((left, right) => left.seq - right.seq)) {
    const params = event?.data?.params ?? {};
    const method = event?.data?.method ?? "";
    if (event.type === "turn.started") {
      const incoming: CanonicalTurnSeed = params.turn ?? { id: event.turnId };
      const turn = ensureTurn(state, incoming.id ?? event.turnId, incoming);
      if (Array.isArray(incoming.items)) {
        for (const item of incoming.items) upsertTurnItem(turn, item);
      }
      continue;
    }
    if (event.type === "item.started" || event.type === "item.completed") {
      const turn = ensureTurn(state, event.turnId ?? params.turnId);
      upsertTurnItem(turn, params.item, event.itemId ?? itemIdFromParams(params));
      continue;
    }
    if (event.type === "item.delta") {
      const turn = ensureTurn(state, event.turnId ?? params.turnId);
      const itemId = event.itemId ?? itemIdFromParams(params);
      const item = upsertTurnItem(turn, { id: itemId }, itemId);
      if (item) appendItemDelta(item, method, params);
      continue;
    }
    if (event.type === "turn.completed") {
      const incoming: CanonicalTurnSeed = params.turn ?? { id: event.turnId };
      const turn = ensureTurn(state, incoming.id ?? event.turnId);
      if (!turn) continue;
      const currentItems = turn.items;
      Object.assign(turn, clone(incoming));
      turn.items = currentItems;
      for (const item of Array.isArray(incoming.items) ? incoming.items : []) {
        upsertTurnItem(turn, item);
      }
      if (!TERMINAL_TURN_STATUSES.has(turn.status)) turn.status = "completed";
    }
  }
  return state.turns.map((turn) => ({ ...turn, items: turn.items.map(clone), itemsView: turn.itemsView ?? "full" }));
}

function timelineCursor(epoch: string, position: number, ordinal: number): string {
  return encodeURIComponent(JSON.stringify({ version: 2, epoch, position, ordinal }));
}

function decodeTimelineCursor(value: unknown): TimelineCursor | null {
  if (value == null) return null;
  if (typeof value !== "string" || !value) throw new Error("invalid thread/timeline/list cursor");
  try {
    const cursor: unknown = JSON.parse(decodeURIComponent(value));
    if (cursor === null || typeof cursor !== "object" ||
        Reflect.get(cursor, "version") !== 2 || typeof Reflect.get(cursor, "epoch") !== "string" ||
        !Number.isSafeInteger(Reflect.get(cursor, "position")) ||
        !Number.isSafeInteger(Reflect.get(cursor, "ordinal"))) {
      throw new Error("shape");
    }
    return {
      version: 2,
      epoch: String(Reflect.get(cursor, "epoch")),
      position: Number(Reflect.get(cursor, "position")),
      ordinal: Number(Reflect.get(cursor, "ordinal")),
    };
  } catch {
    throw new Error("invalid thread/timeline/list cursor");
  }
}

function entryKey(entry: TimelineProjectionRow): readonly [number, number] {
  return [entry.position, entry.__ordinal];
}

function keyIsOlder(left: readonly [number, number], right: readonly [number, number]): boolean {
  const [leftPosition, leftOrdinal] = left;
  const [rightPosition, rightOrdinal] = right;
  return leftPosition < rightPosition ||
    (leftPosition === rightPosition && leftOrdinal < rightOrdinal);
}

function sourceSeqRanges(sequences: readonly number[]): SourceSeqRange[] {
  const ranges: SourceSeqRange[] = [];
  for (const seq of [...new Set(sequences)].sort((left, right) => left - right)) {
    const previous = ranges.at(-1);
    if (previous && seq <= previous.endSeq + 1) previous.endSeq = Math.max(previous.endSeq, seq);
    else ranges.push({ startSeq: seq, endSeq: seq });
  }
  return ranges;
}

function itemCollapseKinds(item: CanonicalItem, sequences: readonly number[]): TimelineCollapseKind[] {
  if (sequences.length <= 1) return [];
  if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall"]
    .includes(item.type ?? "")) return ["tool_lifecycle"];
  if (item?.type === "reasoning") return ["reasoning_merge"];
  if (item?.type === "agentMessage") return ["assistant_merge"];
  return [];
}

function timelineProjectionRows(events: readonly CanonicalEvent[]): TimelineProjectionRow[] {
  const turns = reduceCanonicalTimeline(events);
  const positions = new Map<string, number>();
  const itemSequences = new Map<string, number[]>();
  for (const event of events ?? []) {
    const turnId = event.turnId ?? event.data?.params?.turnId ?? event.data?.params?.turn?.id;
    const itemId = event.itemId ?? itemIdFromParams(event.data?.params);
    if (event.type === "turn.started") positions.set(`turn:start:${turnId}`, event.seq);
    if (event.type === "turn.completed") positions.set(`turn:complete:${turnId}`, event.seq);
    if (itemId != null && event.type.startsWith("item.")) {
      const key = `item:${turnId}:${itemId}`;
      const sequences = itemSequences.get(key) ?? [];
      sequences.push(event.seq);
      itemSequences.set(key, sequences);
      if (!positions.has(key)) positions.set(key, event.seq);
    }
  }
  const rows: TimelineProjectionRow[] = [];
  let ordinal = 0;
  for (const turn of turns) {
    const startedPosition = positions.get(`turn:start:${turn.id}`);
    if (startedPosition != null) rows.push({
      type: "turnStarted",
      position: startedPosition,
      seqStart: startedPosition,
      seqEnd: startedPosition,
      sourceSeqRanges: [{ startSeq: startedPosition, endSeq: startedPosition }],
      collapsed: [],
      turnId: turn.id,
      startedAt: turn.startedAt ?? null,
      __ordinal: ordinal++,
    });
    for (const item of turn.items ?? []) {
      const position = positions.get(`item:${turn.id}:${item.id}`);
      if (position == null) continue;
      const sequences = itemSequences.get(`item:${turn.id}:${item.id}`) ?? [position];
      const seqStart = Math.min(...sequences);
      const seqEnd = Math.max(...sequences);
      rows.push({
        type: "item",
        position: seqStart,
        seqStart,
        seqEnd,
        sourceSeqRanges: sourceSeqRanges(sequences),
        collapsed: itemCollapseKinds(item, sequences),
        turnId: turn.id,
        item: clone(item),
        __ordinal: ordinal++,
      });
    }
    if (TERMINAL_TURN_STATUSES.has(turn.status)) {
      const position = positions.get(`turn:complete:${turn.id}`);
      if (position != null) rows.push({
        type: "turnCompleted",
        position,
        seqStart: position,
        seqEnd: position,
        sourceSeqRanges: [{ startSeq: position, endSeq: position }],
        collapsed: [],
        turnId: turn.id,
        status: turn.status,
        error: turn.error ?? null,
        startedAt: turn.startedAt ?? null,
        completedAt: turn.completedAt ?? null,
        durationMs: turn.durationMs ?? null,
        __ordinal: ordinal++,
      });
    }
  }
  return rows.sort((left, right) => (
    right.position - left.position || right.__ordinal - left.__ordinal
  ));
}

export function projectAppServerTimeline(
  events: readonly CanonicalEvent[],
  epoch: string,
  params: TimelineListParams = {},
): TimelinePage {
  const requestedLimit = Number(params.limit);
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, MAX_PAGE_LIMIT))
    : DEFAULT_PAGE_LIMIT;
  const cursor = decodeTimelineCursor(params.cursor);
  if (cursor && cursor.epoch !== epoch) throw new Error("thread/timeline/list cursor is stale");
  let rows = timelineProjectionRows(events);
  if (cursor) rows = rows.filter((row) => keyIsOlder(entryKey(row), [cursor.position, cursor.ordinal]));
  const page = rows.slice(0, limit);
  const more = rows.length > page.length;
  const last = page.at(-1);
  return {
    data: page.map(({ __ordinal, ...entry }) => entry),
    nextCursor: more && last
      ? timelineCursor(epoch, last.position, last.__ordinal)
      : null,
    activeRealtimeSessionAtPageStart: null,
  };
}

interface TimelineTableOptions {
  epochFactory?: () => string;
}

interface TimelineStorage {
  available: boolean;
  sql: DurableSql;
  transactionSync<Result>(callback: () => Result): Result;
}

interface TimelineHeadRow extends SqlRow {
  epoch: string;
  next_seq: number;
  min_seq: number;
}

interface TimelineEventRow extends SqlRow {
  event_json: string;
  payload_hash: string | null;
}

interface TimelineColumnRow extends SqlRow {
  name: string;
}

interface TimelineVersionRow extends SqlRow {
  schema_version: number;
}

interface TimelineBlobRow extends SqlRow {
  content: string;
}

interface TimelineFailureRow extends SqlRow {
  thread_id: string;
  method: string;
  event_id: string | null;
  source_engine: string | null;
  error_message: string;
  failed_at_ms: number;
}

interface TimelineCandidateRow extends SqlRow {
  kind: string;
  position: number;
  turn_id: string;
  item_id: string | null;
}

interface TimelineLifecycleRow extends SqlRow {
  seq: number;
  event_type: string;
  event_json: string;
}

function unavailableStorage(): TimelineStorage {
  const fail = (): never => {
    throw new Error("canonical timeline durable storage is unavailable");
  };
  return {
    available: false,
    sql: { exec: fail },
    transactionSync: fail,
  };
}

export class CanonicalTimelineTable {
  private readonly storage: TimelineStorage;
  private readonly available: boolean;
  private readonly epochFactory: () => string;
  private readonly memory = new Map<ThreadId, CanonicalMemoryHead>();
  private readonly memoryFailures: CanonicalFailure[] = [];

  constructor(
    storage?: Pick<DurableStoragePort, "available" | "sql" | "transactionSync"> | null,
    { epochFactory = randomEpoch }: TimelineTableOptions = {},
  ) {
    this.available = storage?.available === true && storage.sql != null;
    this.storage = this.available && storage?.sql
      ? { available: true, sql: storage.sql, transactionSync: storage.transactionSync.bind(storage) }
      : unavailableStorage();
    this.epochFactory = epochFactory;
    if (this.available) this.initializeSchema();
  }

  initializeSchema(): void {
    const existingEntries = Boolean(this.storage.sql.exec(`
      SELECT 1 AS value FROM sqlite_master
      WHERE type = 'table' AND name = 'hypernode_canonical_timeline_entries'
    `).toArray()[0]);
    const existingMeta = Boolean(this.storage.sql.exec(`
      SELECT 1 AS value FROM sqlite_master
      WHERE type = 'table' AND name = 'hypernode_canonical_timeline_meta'
    `).toArray()[0]);
    if (existingEntries) {
      const metaColumns = existingMeta ? new Set(this.storage.sql.exec<TimelineColumnRow>(`
        PRAGMA table_info(hypernode_canonical_timeline_meta)
      `).toArray().map((column) => column.name)) : new Set();
      const version = metaColumns.has("singleton") ? Number(this.storage.sql.exec<TimelineVersionRow>(`
        SELECT schema_version FROM hypernode_canonical_timeline_meta WHERE singleton = 1
      `).toArray()[0]?.schema_version) : 0;
      if (version !== CANONICAL_SCHEMA_VERSION) {
        throw new Error(
          `canonical timeline schema ${version || "legacy"} requires one-time migration to v${CANONICAL_SCHEMA_VERSION}`,
        );
      }
    }
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_canonical_timeline_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        schema_version INTEGER NOT NULL,
        migrated_at_ms INTEGER NOT NULL
      )
    `);
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_canonical_timeline_heads (
        thread_id TEXT PRIMARY KEY,
        epoch TEXT NOT NULL,
        next_seq INTEGER NOT NULL,
        min_seq INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_canonical_timeline_entries (
        thread_id TEXT NOT NULL,
        epoch TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT ${CANONICAL_SCHEMA_VERSION},
        event_type TEXT,
        occurred_at_ms INTEGER,
        turn_id TEXT,
        item_id TEXT,
        source_engine TEXT,
        source_kind TEXT,
        payload_hash TEXT,
        item_type TEXT,
        search_role TEXT,
        search_text TEXT,
        event_json TEXT NOT NULL,
        PRIMARY KEY(thread_id, epoch, seq),
        UNIQUE(thread_id, epoch, event_id)
      )
    `);
    this.storage.sql.exec(`
      INSERT OR IGNORE INTO hypernode_canonical_timeline_meta(singleton, schema_version, migrated_at_ms)
      VALUES(1, ?, ?)
    `, CANONICAL_SCHEMA_VERSION, Date.now());
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_canonical_timeline_blobs (
        blob_hash TEXT PRIMARY KEY,
        encoding TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      )
    `);
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_canonical_timeline_blob_refs (
        thread_id TEXT NOT NULL,
        epoch TEXT NOT NULL,
        seq INTEGER NOT NULL,
        blob_hash TEXT NOT NULL,
        PRIMARY KEY(thread_id, epoch, seq, blob_hash)
      )
    `);
    this.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS hypernode_canonical_timeline_turn_seq
      ON hypernode_canonical_timeline_entries(thread_id, epoch, turn_id, seq)
    `);
    this.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS hypernode_canonical_timeline_item_seq
      ON hypernode_canonical_timeline_entries(thread_id, epoch, item_id, seq)
    `);
    this.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS hypernode_canonical_timeline_type_seq
      ON hypernode_canonical_timeline_entries(thread_id, epoch, event_type, seq)
    `);
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_canonical_timeline_failures (
        failure_id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        method TEXT NOT NULL,
        event_id TEXT,
        source_engine TEXT,
        error_message TEXT NOT NULL,
        failed_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER
      )
    `);
  }

  createHead(threadId: unknown): CanonicalMemoryHead {
    const canonicalThreadId = assertThreadId(threadId);
    if (!this.available) {
      let head = this.memory.get(canonicalThreadId);
      if (!head) {
        head = {
          threadId: canonicalThreadId,
          epoch: this.epochFactory(),
          nextSeq: 0,
          minSeq: 0,
          entries: [],
          ids: new Map(),
        };
        this.memory.set(canonicalThreadId, head);
      }
      return head;
    }
    let row = this.storage.sql.exec<TimelineHeadRow>(`
      SELECT epoch, next_seq, min_seq FROM hypernode_canonical_timeline_heads WHERE thread_id = ?
    `, canonicalThreadId).toArray()[0];
    if (!row) {
      const epoch = this.epochFactory();
      this.storage.sql.exec(`
        INSERT OR IGNORE INTO hypernode_canonical_timeline_heads(
          thread_id, epoch, next_seq, min_seq, updated_at_ms
        ) VALUES(?, ?, 0, 0, ?)
      `, canonicalThreadId, epoch, Date.now());
      row = this.storage.sql.exec<TimelineHeadRow>(`
        SELECT epoch, next_seq, min_seq FROM hypernode_canonical_timeline_heads WHERE thread_id = ?
      `, canonicalThreadId).toArray()[0];
    }
    if (!row) throw new Error(`canonical timeline head was not created for ${canonicalThreadId}`);
    return {
      threadId: canonicalThreadId,
      epoch: row.epoch,
      nextSeq: Number(row.next_seq),
      minSeq: Number(row.min_seq),
      entries: [],
      ids: new Map(),
    };
  }

  append(threadId: unknown, input: CanonicalEventInput = {}): CanonicalAppendResult {
    const canonicalThreadId = assertThreadId(threadId);
    if (!this.available) {
      return this.appendMemory(canonicalThreadId, input);
    }
    const result = this.storage.transactionSync(() =>
      this.appendAvailable(canonicalThreadId, this.createHead(canonicalThreadId), input));
    if (!result) throw new Error("canonical timeline transaction did not produce an append result");
    return result;
  }

  appendBatch(threadId: unknown, inputs: CanonicalEventInput[]): CanonicalAppendResult[] {
    const canonicalThreadId = assertThreadId(threadId);
    if (!Array.isArray(inputs) || inputs.length === 0) return [];
    if (!this.available) return inputs.map((input) => this.appendMemory(canonicalThreadId, input));
    return this.storage.transactionSync(() => {
      const head = this.createHead(canonicalThreadId);
      return inputs.map((input) => this.appendAvailable(canonicalThreadId, head, input));
    });
  }

  private appendForkBatchAvailable(
    canonicalThreadId: ThreadId,
    inputs: CanonicalEventInput[],
  ): void {
    this.storage.transactionSync(() => {
      const head = this.createHead(canonicalThreadId);
      const blobs = new Map<string, [string, number, string, number]>();
      const entryRows: SqlBinding[][] = [];
      const blobRefRows: SqlBinding[][] = [];
      const createdAtMs = Date.now();
      for (const input of inputs) {
        const seq = head.nextSeq++;
        const eventId = input.eventId == null
          ? `event-${head.epoch}-${seq}`
          : String(input.eventId);
        const event = this.makeEvent(canonicalThreadId, head.epoch, seq, eventId, input);
        const prepared = prepareCanonicalTimelineEventForStorage(
          event,
          (hash, content, bytes, mediaType) => {
            if (!blobs.has(hash)) blobs.set(hash, [mediaType, bytes, content, createdAtMs]);
          },
        );
        const normalized = prepared.normalized;
        entryRows.push([
          canonicalThreadId,
          head.epoch,
          seq,
          eventId,
          normalized.schemaVersion,
          normalized.eventType,
          normalized.occurredAtMs,
          normalized.turnId,
          normalized.itemId,
          normalized.sourceEngine,
          normalized.sourceKind,
          prepared.payloadHash,
          normalized.itemType,
          normalized.searchRole,
          normalized.searchText,
          JSON.stringify(prepared.storedEvent),
        ]);
        for (const hash of prepared.blobHashes) {
          blobRefRows.push([canonicalThreadId, head.epoch, seq, hash]);
        }
      }

      this.insertRows(
        `INSERT OR IGNORE INTO hypernode_canonical_timeline_blobs(
          blob_hash, media_type, byte_length, content, created_at_ms, encoding
        )`,
        [...blobs].map(([hash, [mediaType, bytes, content, storedAtMs]]) =>
          [hash, mediaType, bytes, content, storedAtMs, "utf8"]),
      );
      this.insertRows(
        `INSERT INTO hypernode_canonical_timeline_entries(
          thread_id, epoch, seq, event_id, schema_version, event_type, occurred_at_ms,
          turn_id, item_id, source_engine, source_kind, payload_hash,
          item_type, search_role, search_text, event_json
        )`,
        entryRows,
      );
      this.insertRows(
        `INSERT OR IGNORE INTO hypernode_canonical_timeline_blob_refs(
          thread_id, epoch, seq, blob_hash
        )`,
        blobRefRows,
      );
      this.storage.sql.exec(`
        UPDATE hypernode_canonical_timeline_heads
        SET next_seq = ?, updated_at_ms = ? WHERE thread_id = ?
      `, head.nextSeq, Date.now(), canonicalThreadId);
    });
  }

  private insertRows(prefix: string, rows: SqlBinding[][]): void {
    if (rows.length === 0) return;
    const columnCount = rows[0]!.length;
    // Stay below SQLite's conservative 999-variable limit. Production builds
    // allow more, but this bound keeps the policy portable across runtimes.
    const batchSize = Math.max(1, Math.floor(900 / columnCount));
    const tuple = `(${Array.from({ length: columnCount }, () => "?").join(",")})`;
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      this.storage.sql.exec(
        `${prefix} VALUES ${batch.map(() => tuple).join(",")}`,
        ...batch.flat(),
      );
    }
  }

  private appendMemory(
    canonicalThreadId: ThreadId,
    input: CanonicalEventInput,
  ): CanonicalAppendResult {
    const requestedId = input.eventId == null ? null : String(input.eventId);
    const payloadHash = canonicalPayloadHash(input);
    const head = this.createHead(canonicalThreadId);
    if (requestedId && head.ids.has(requestedId)) {
      const existing = head.ids.get(requestedId);
      if (!existing) throw new Error(`canonical event id index is inconsistent: ${requestedId}`);
      if (existing.payloadHash !== payloadHash) {
        throw new Error(`canonical event id conflict: ${requestedId}`);
      }
      return { appended: false, event: clone(existing.event), head: this.describeHead(head) };
    }
    const seq = head.nextSeq++;
    const eventId = requestedId ?? `event-${head.epoch}-${seq}`;
    const event = this.makeEvent(canonicalThreadId, head.epoch, seq, eventId, input);
    head.entries.push(event);
    head.ids.set(eventId, { event, payloadHash });
    return { appended: true, event: clone(event), head: this.describeHead(head) };
  }

  private appendAvailable(
    canonicalThreadId: ThreadId,
    head: CanonicalHead,
    input: CanonicalEventInput,
  ): CanonicalAppendResult {
    const requestedId = input.eventId == null ? null : String(input.eventId);
    const payloadHash = canonicalPayloadHash(input);
    if (requestedId) {
      const existing = this.storage.sql.exec<TimelineEventRow>(`
        SELECT event_json, payload_hash FROM hypernode_canonical_timeline_entries
        WHERE thread_id = ? AND epoch = ? AND event_id = ?
      `, canonicalThreadId, head.epoch, requestedId).toArray()[0];
      if (existing) {
        const existingEvent = this.hydrateEvent(JSON.parse(existing.event_json));
        const existingHash = existing.payload_hash || canonicalPayloadHash(existingEvent);
        if (existingHash !== payloadHash) {
          throw new Error(`canonical event id conflict: ${requestedId}`);
        }
        return { appended: false, event: existingEvent, head: { ...head } };
      }
    }
    const seq = head.nextSeq;
    const eventId = requestedId ?? `event-${head.epoch}-${seq}`;
    const event = this.makeEvent(canonicalThreadId, head.epoch, seq, eventId, input);
    const prepared = prepareCanonicalTimelineEventForStorage(
      event,
      (hash, content, bytes, mediaType) => {
        this.storage.sql.exec(`
          INSERT OR IGNORE INTO hypernode_canonical_timeline_blobs(
            blob_hash, encoding, media_type, byte_length, content, created_at_ms
          ) VALUES(?, 'utf8', ?, ?, ?, ?)
        `, hash, mediaType, bytes, content, Date.now());
      },
    );
    const normalized = prepared.normalized;
    this.storage.sql.exec(`
      INSERT INTO hypernode_canonical_timeline_entries(
        thread_id, epoch, seq, event_id, schema_version, event_type, occurred_at_ms,
        turn_id, item_id, source_engine, source_kind, payload_hash,
        item_type, search_role, search_text, event_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, canonicalThreadId, head.epoch, seq, eventId, normalized.schemaVersion,
    normalized.eventType, normalized.occurredAtMs, normalized.turnId, normalized.itemId,
    normalized.sourceEngine, normalized.sourceKind, prepared.payloadHash,
    normalized.itemType, normalized.searchRole, normalized.searchText,
    JSON.stringify(prepared.storedEvent));
    for (const hash of prepared.blobHashes) this.storage.sql.exec(`
      INSERT OR IGNORE INTO hypernode_canonical_timeline_blob_refs(
        thread_id, epoch, seq, blob_hash
      ) VALUES(?, ?, ?, ?)
    `, canonicalThreadId, head.epoch, seq, hash);
    head.nextSeq = seq + 1;
    this.storage.sql.exec(`
      UPDATE hypernode_canonical_timeline_heads
      SET next_seq = ?, updated_at_ms = ? WHERE thread_id = ?
    `, head.nextSeq, Date.now(), canonicalThreadId);
    return { appended: true, event, head: { ...head } };
  }

  makeEvent(
    threadId: ThreadId,
    epoch: string,
    seq: number,
    eventId: string,
    input: CanonicalEventInput,
  ): CanonicalEvent {
    return {
      id: eventId,
      threadId,
      epoch,
      seq,
      type: input.type ?? "unknown",
      time: Number.isFinite(input.time) ? Number(input.time) : Date.now(),
      turnId: input.turnId ?? null,
      itemId: input.itemId ?? null,
      data: clone(input.data ?? {}),
      source: stableEventSource(input.source),
    };
  }

  hydrateEvent(event: CanonicalEvent): CanonicalEvent {
    if (!this.available) return clone(event);
    return hydrateLargeValues(event, (hash) => this.storage.sql.exec<TimelineBlobRow>(`
      SELECT content FROM hypernode_canonical_timeline_blobs WHERE blob_hash = ?
    `, hash).toArray()[0]?.content ?? null) as CanonicalEvent;
  }

  describeHead(head: CanonicalHead): CanonicalHead {
    return {
      threadId: head.threadId,
      epoch: head.epoch,
      nextSeq: head.nextSeq,
      minSeq: head.minSeq,
    };
  }

  head(threadId: unknown): CanonicalHead {
    const head = this.createHead(threadId);
    return this.available ? head : this.describeHead(head);
  }

  entries(threadId: unknown): CanonicalEvent[] {
    const head = this.createHead(threadId);
    if (!this.available) return head.entries.map(clone);
    return this.storage.sql.exec<TimelineEventRow>(`
      SELECT event_json FROM hypernode_canonical_timeline_entries
      WHERE thread_id = ? AND epoch = ? ORDER BY seq
    `, head.threadId, head.epoch).toArray().map((row) => this.hydrateEvent(JSON.parse(row.event_json)));
  }

  rangeEntries(
    threadId: unknown,
    { direction = "after", boundary = null, limit = DEFAULT_PAGE_LIMIT }: RangeOptions = {},
  ): CanonicalEvent[] {
    const head = this.createHead(threadId);
    limit = Math.max(1, Math.min(Number(limit) || DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT));
    if (!this.available) {
      let rows = head.entries;
      if (direction === "tail") rows = rows.slice(-limit);
      else if (direction === "before") rows = rows.filter((event) => event.seq < (boundary ?? head.nextSeq)).slice(-limit);
      else rows = rows.filter((event) => event.seq > (boundary ?? head.minSeq - 1)).slice(0, limit);
      return rows.map(clone);
    }
    let rows: TimelineEventRow[];
    if (direction === "tail") {
      rows = this.storage.sql.exec<TimelineEventRow>(`
        SELECT event_json FROM hypernode_canonical_timeline_entries
        WHERE thread_id = ? AND epoch = ? ORDER BY seq DESC LIMIT ?
      `, head.threadId, head.epoch, limit).toArray().reverse();
    } else if (direction === "before") {
      rows = this.storage.sql.exec<TimelineEventRow>(`
        SELECT event_json FROM hypernode_canonical_timeline_entries
        WHERE thread_id = ? AND epoch = ? AND seq < ? ORDER BY seq DESC LIMIT ?
      `, head.threadId, head.epoch, boundary, limit).toArray().reverse();
    } else {
      rows = this.storage.sql.exec<TimelineEventRow>(`
        SELECT event_json FROM hypernode_canonical_timeline_entries
        WHERE thread_id = ? AND epoch = ? AND seq > ? ORDER BY seq LIMIT ?
      `, head.threadId, head.epoch, boundary, limit).toArray();
    }
    return rows.map((row) => this.hydrateEvent(JSON.parse(row.event_json)));
  }

  eventAt(threadId: unknown, seq: unknown): CanonicalEvent | null {
    const head = this.createHead(threadId);
    if (!Number.isSafeInteger(seq)) return null;
    const canonicalSeq = Number(seq);
    if (!this.available) return clone(head.entries.find((event) => event.seq === canonicalSeq) ?? null);
    const row = this.storage.sql.exec<TimelineEventRow>(`
      SELECT event_json FROM hypernode_canonical_timeline_entries
      WHERE thread_id = ? AND epoch = ? AND seq = ?
    `, head.threadId, head.epoch, canonicalSeq).toArray()[0];
    return row ? this.hydrateEvent(JSON.parse(row.event_json)) : null;
  }

  entriesThrough(threadId: unknown, seq: number): CanonicalEvent[] {
    const head = this.createHead(threadId);
    if (!Number.isSafeInteger(seq) || seq < head.minSeq) return [];
    if (!this.available) return head.entries.filter((event) => event.seq <= seq).map(clone);
    return this.storage.sql.exec<TimelineEventRow>(`
      SELECT event_json FROM hypernode_canonical_timeline_entries
      WHERE thread_id = ? AND epoch = ? AND seq <= ? ORDER BY seq
    `, head.threadId, head.epoch, seq).toArray()
      .map((row) => this.hydrateEvent(JSON.parse(row.event_json)));
  }

  terminalBoundaryForTurn(threadId: unknown, turnId: unknown): CanonicalEvent | null {
    const canonicalTurnId = String(turnId ?? "");
    if (!canonicalTurnId) return null;
    const head = this.createHead(threadId);
    if (!this.available) return clone([...head.entries].reverse().find((event) => (
      event.type === "turn.completed" && eventTurnId(event) === canonicalTurnId
    )) ?? null);
    const row = this.storage.sql.exec<TimelineEventRow>(`
      SELECT event_json FROM hypernode_canonical_timeline_entries
      WHERE thread_id = ? AND epoch = ? AND event_type = 'turn.completed' AND turn_id = ?
      ORDER BY seq DESC LIMIT 1
    `, head.threadId, head.epoch, canonicalTurnId).toArray()[0];
    return row ? this.hydrateEvent(JSON.parse(row.event_json)) : null;
  }

  reset(threadId: unknown): CanonicalHead {
    const canonicalThreadId = assertThreadId(threadId);
    const epoch = this.epochFactory();
    if (!this.available) {
      const head: CanonicalMemoryHead = {
        threadId: canonicalThreadId, epoch, nextSeq: 0, minSeq: 0, entries: [],
        ids: new Map<string, { event: CanonicalEvent; payloadHash: string }>(),
      };
      this.memory.set(canonicalThreadId, head);
      return this.describeHead(head);
    }
    const previous = this.createHead(canonicalThreadId);
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`
        DELETE FROM hypernode_canonical_timeline_blob_refs WHERE thread_id = ? AND epoch = ?
      `, canonicalThreadId, previous.epoch);
      this.storage.sql.exec(`
        DELETE FROM hypernode_canonical_timeline_entries WHERE thread_id = ? AND epoch = ?
      `, canonicalThreadId, previous.epoch);
      this.storage.sql.exec(`
        INSERT INTO hypernode_canonical_timeline_heads(thread_id, epoch, next_seq, min_seq, updated_at_ms)
        VALUES(?, ?, 0, 0, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          epoch = excluded.epoch, next_seq = 0, min_seq = 0, updated_at_ms = excluded.updated_at_ms
      `, canonicalThreadId, epoch, Date.now());
      this.deleteOrphanBlobs();
    });
    return { threadId: canonicalThreadId, epoch, nextSeq: 0, minSeq: 0 };
  }

  compactThrough(threadId: unknown, cursor: CanonicalCursor): CanonicalHead {
    const head = this.createHead(threadId);
    if (cursor?.epoch !== head.epoch) throw new Error("stale canonical compaction cursor");
    const boundary = this.eventAt(head.threadId, cursor.seq);
    if (!boundary || boundary.type !== "turn.completed") {
      throw new Error("canonical compaction requires a committed turn boundary");
    }
    const minSeq = boundary.seq + 1;
    if (!this.available) {
      head.entries = head.entries.filter((event) => event.seq >= minSeq);
      head.ids = new Map(head.entries.map((event) => [
        event.id, { event, payloadHash: canonicalPayloadHash(event) },
      ]));
      head.minSeq = minSeq;
      return this.describeHead(head);
    }
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`
        DELETE FROM hypernode_canonical_timeline_blob_refs
        WHERE thread_id = ? AND epoch = ? AND seq < ?
      `, head.threadId, head.epoch, minSeq);
      this.storage.sql.exec(`
        DELETE FROM hypernode_canonical_timeline_entries
        WHERE thread_id = ? AND epoch = ? AND seq < ?
      `, head.threadId, head.epoch, minSeq);
      this.storage.sql.exec(`
        UPDATE hypernode_canonical_timeline_heads
        SET min_seq = ?, updated_at_ms = ? WHERE thread_id = ?
      `, minSeq, Date.now(), head.threadId);
      this.deleteOrphanBlobs();
    });
    return { ...head, minSeq };
  }

  deleteOrphanBlobs(): void {
    if (!this.available) return;
    this.storage.sql.exec(`
      DELETE FROM hypernode_canonical_timeline_blobs
      WHERE NOT EXISTS (
        SELECT 1 FROM hypernode_canonical_timeline_blob_refs AS ref
        WHERE ref.blob_hash = hypernode_canonical_timeline_blobs.blob_hash
      )
    `);
  }

  delete(threadId: unknown): boolean {
    const canonicalThreadId = assertThreadId(threadId);
    if (!this.available) return this.memory.delete(canonicalThreadId);
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`
        DELETE FROM hypernode_canonical_timeline_blob_refs WHERE thread_id = ?
      `, canonicalThreadId);
      this.storage.sql.exec(`
        DELETE FROM hypernode_canonical_timeline_entries WHERE thread_id = ?
      `, canonicalThreadId);
      this.storage.sql.exec(`
        DELETE FROM hypernode_canonical_timeline_heads WHERE thread_id = ?
      `, canonicalThreadId);
      this.deleteOrphanBlobs();
    });
    return true;
  }

  recordFailure(
    threadId: unknown,
    { method, eventId = null, sourceEngine = null, error }: FailureInput,
  ): CanonicalFailure {
    const row: CanonicalFailure = {
      threadId: assertThreadId(threadId),
      method: String(method ?? "unknown"),
      eventId: eventId == null ? null : String(eventId),
      sourceEngine: sourceEngine == null ? null : String(sourceEngine),
      errorMessage: error instanceof Error ? error.message : String(error ?? "unknown canonical persistence error"),
      failedAtMs: Date.now(),
    };
    if (!this.available) {
      this.memoryFailures.push(row);
      return row;
    }
    this.storage.sql.exec(`
      INSERT INTO hypernode_canonical_timeline_failures(
        thread_id, method, event_id, source_engine, error_message, failed_at_ms
      ) VALUES(?, ?, ?, ?, ?, ?)
    `, row.threadId, row.method, row.eventId, row.sourceEngine, row.errorMessage, row.failedAtMs);
    return row;
  }

  failures(threadId: string | null = null): CanonicalFailure[] {
    if (!this.available) return this.memoryFailures
      .filter((row) => threadId == null || row.threadId === threadId)
      .map(clone);
    const rows = threadId == null
      ? this.storage.sql.exec<TimelineFailureRow>(`
          SELECT thread_id, method, event_id, source_engine, error_message, failed_at_ms
          FROM hypernode_canonical_timeline_failures ORDER BY failure_id
        `).toArray()
      : this.storage.sql.exec<TimelineFailureRow>(`
          SELECT thread_id, method, event_id, source_engine, error_message, failed_at_ms
          FROM hypernode_canonical_timeline_failures WHERE thread_id = ? ORDER BY failure_id
        `, threadId).toArray();
    return rows.map((row) => ({
      threadId: asThreadId(row.thread_id),
      method: row.method,
      eventId: row.event_id,
      sourceEngine: row.source_engine,
      errorMessage: row.error_message,
      failedAtMs: Number(row.failed_at_ms),
    }));
  }

  timeline(threadId: unknown, params: TimelineListParams = {}): TimelinePage {
    const head = this.head(threadId);
    if (!this.available) return projectAppServerTimeline(this.entries(head.threadId), head.epoch, params);
    const requestedLimit = Number(params.limit);
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, MAX_PAGE_LIMIT))
      : DEFAULT_PAGE_LIMIT;
    const cursor = decodeTimelineCursor(params.cursor);
    if (cursor && cursor.epoch !== head.epoch) throw new Error("thread/timeline/list cursor is stale");
    // The canonical row position is a source fact seq. Every turn boundary has
    // its own seq and an item is anchored at MIN(item lifecycle seq), so the
    // positions are unique. The ordinal remains in the opaque cursor for wire
    // compatibility, but normalized storage never needs it to break a tie.
    const cursorPosition = cursor?.position ?? null;
    const candidates = this.storage.sql.exec<TimelineCandidateRow>(`
      WITH candidates(kind, position, turn_id, item_id) AS (
        SELECT 'turnStarted', seq, turn_id, NULL
        FROM hypernode_canonical_timeline_entries
        WHERE thread_id = ? AND epoch = ? AND event_type = 'turn.started'
        UNION ALL
        SELECT 'turnCompleted', seq, turn_id, NULL
        FROM hypernode_canonical_timeline_entries
        WHERE thread_id = ? AND epoch = ? AND event_type = 'turn.completed'
        UNION ALL
        SELECT 'item', MIN(seq), turn_id, item_id
        FROM hypernode_canonical_timeline_entries
        WHERE thread_id = ? AND epoch = ? AND event_type LIKE 'item.%'
          AND turn_id IS NOT NULL AND item_id IS NOT NULL
        GROUP BY turn_id, item_id
      )
      SELECT kind, position, turn_id, item_id
      FROM candidates
      WHERE ? IS NULL OR position < ?
      ORDER BY position DESC
      LIMIT ?
    `,
    head.threadId, head.epoch,
    head.threadId, head.epoch,
    head.threadId, head.epoch,
    cursorPosition, cursorPosition, limit + 1).toArray();
    const more = candidates.length > limit;
    const selected = candidates.slice(0, limit);
    const data: TimelineEntry[] = [];
    for (const candidate of selected) {
      const position = Number(candidate.position);
      if (candidate.kind === "item") {
        const lifecycleRows = this.storage.sql.exec<TimelineLifecycleRow>(`
          SELECT seq, event_type, event_json
          FROM hypernode_canonical_timeline_entries
          WHERE thread_id = ? AND epoch = ? AND turn_id = ? AND item_id = ?
            AND event_type LIKE 'item.%'
          ORDER BY seq
        `, head.threadId, head.epoch, candidate.turn_id, candidate.item_id).toArray();
        const lifecycle = lifecycleRows.map((row) => ({
          seq: Number(row.seq),
          eventType: row.event_type,
          event: this.hydrateEvent(JSON.parse(row.event_json)),
        }));
        const authoritative = [...lifecycle].reverse().find((row) => row.eventType === "item.completed") ??
          lifecycle.find((row) => row.eventType === "item.started");
        const item = authoritative?.event?.data?.params?.item;
        if (!item) continue;
        const sequences = lifecycle.map((row) => row.seq);
        data.push({
          type: "item",
          position,
          seqStart: Math.min(...sequences),
          seqEnd: Math.max(...sequences),
          sourceSeqRanges: sourceSeqRanges(sequences),
          collapsed: itemCollapseKinds(item, sequences),
          turnId: candidate.turn_id,
          item: clone(item),
        });
        continue;
      }
      const event = this.eventAt(head.threadId, position);
      const turn = event?.data?.params?.turn;
      if (!turn) continue;
      if (candidate.kind === "turnStarted") {
        data.push({
          type: "turnStarted",
          position,
          seqStart: position,
          seqEnd: position,
          sourceSeqRanges: [{ startSeq: position, endSeq: position }],
          collapsed: [],
          turnId: candidate.turn_id,
          startedAt: turn.startedAt ?? null,
        });
      } else {
        data.push({
          type: "turnCompleted",
          position,
          seqStart: position,
          seqEnd: position,
          sourceSeqRanges: [{ startSeq: position, endSeq: position }],
          collapsed: [],
          turnId: candidate.turn_id,
          status: typeof turn.status === "string" ? turn.status : "completed",
          error: turn.error ?? null,
          startedAt: turn.startedAt ?? null,
          completedAt: turn.completedAt ?? null,
          durationMs: turn.durationMs ?? null,
        });
      }
    }
    const last = selected.at(-1);
    return {
      data,
      nextCursor: more && last
        ? timelineCursor(head.epoch, Number(last.position), 0)
        : null,
      activeRealtimeSessionAtPageStart: null,
    };
  }

  fork(
    sourceThreadId: unknown,
    targetThreadId: unknown,
    { cursor = null, lastTurnId = null }: ForkOptions = {},
  ): CanonicalForkResult {
    const canonicalSourceThreadId = assertThreadId(sourceThreadId);
    const canonicalTargetThreadId = assertThreadId(targetThreadId);
    if (canonicalSourceThreadId === canonicalTargetThreadId) {
      throw new Error("canonical timeline cannot fork onto itself");
    }
    const sourceHead = this.head(canonicalSourceThreadId);
    let boundary = sourceHead.nextSeq - 1;
    if (cursor != null) {
      if (cursor?.epoch !== sourceHead.epoch) throw new Error("stale fork cursor epoch");
      const anchor = this.eventAt(canonicalSourceThreadId, cursor.seq);
      if (!anchor) {
        throw new Error("fork cursor does not identify a canonical source event");
      }
      if (anchor.type !== "turn.completed") {
        throw new Error("fork cursor must identify a committed turn boundary");
      }
      boundary = cursor.seq;
    } else if (lastTurnId != null) {
      const completed = this.terminalBoundaryForTurn(canonicalSourceThreadId, lastTurnId);
      if (!completed) throw new Error(`turn does not have a terminal boundary: ${lastTurnId}`);
      boundary = completed.seq;
    } else if (boundary >= 0 && this.eventAt(canonicalSourceThreadId, boundary)?.type !== "turn.completed") {
      throw new Error("canonical timeline cannot fork an uncommitted tail");
    }
    const selected = boundary < sourceHead.minSeq
      ? []
      : this.entriesThrough(canonicalSourceThreadId, boundary);
    if (this.entries(canonicalTargetThreadId).length > 0) {
      throw new Error(`canonical timeline already exists for target thread ${canonicalTargetThreadId}`);
    }
    const inputs = selected.map((event) => ({
          eventId: event.id,
          type: event.type,
          time: event.time,
          turnId: event.turnId,
          itemId: event.itemId,
          data: retargetEventData(event.data, canonicalSourceThreadId, canonicalTargetThreadId),
          source: event.source,
    }));
    try {
      if (this.available) this.appendForkBatchAvailable(canonicalTargetThreadId, inputs);
      else this.appendBatch(canonicalTargetThreadId, inputs);
    } catch (error) {
      this.delete(canonicalTargetThreadId);
      throw error;
    }
    return {
      head: this.head(canonicalTargetThreadId),
      count: selected.length,
      sourceCursor: boundary < 0 ? null : { epoch: sourceHead.epoch, seq: boundary },
    };
  }

  sync(threadId: unknown, params: SyncParams = {}): CanonicalSyncResult {
    const head = this.head(threadId);
    const requestedLimit = Number(params.limit);
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, MAX_PAGE_LIMIT))
      : DEFAULT_PAGE_LIMIT;
    const requestedCursor = params.cursor && typeof params.cursor === "object" ? params.cursor : null;
    const staleCursor = Boolean(requestedCursor && requestedCursor.epoch !== head.epoch);
    const cursor = staleCursor ? null : requestedCursor;
    const direction: "after" | "before" | "tail" = params.direction === "before" || params.direction === "tail"
      ? params.direction
      : "after";
    const boundary = direction === "before"
      ? (cursor && Number.isSafeInteger(cursor.seq) ? cursor.seq : head.nextSeq)
      : (cursor && Number.isSafeInteger(cursor.seq) ? cursor.seq : head.minSeq - 1);
    const selected = this.rangeEntries(head.threadId, { direction, boundary, limit });
    const first = selected[0] ?? null;
    const last = selected.at(-1) ?? null;
    const gap = Boolean(cursor && cursor.seq < head.minSeq - 1);
    return {
      threadId: head.threadId,
      epoch: head.epoch,
      reset: staleCursor,
      staleCursor,
      gap,
      window: { minSeq: head.minSeq, maxSeq: head.nextSeq - 1, nextSeq: head.nextSeq },
      startCursor: first ? { epoch: head.epoch, seq: first.seq } : null,
      endCursor: last ? { epoch: head.epoch, seq: last.seq } : null,
      hasOlder: Boolean(first && first.seq > head.minSeq),
      hasNewer: Boolean(last && last.seq < head.nextSeq - 1),
      entries: selected.map(clone),
    };
  }
}

function requiredThreadId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("threadId must be a non-empty string");
  }
  return value;
}

export class CanonicalTimelineService extends Service {
  static inject = ["appServer", "storage", "threadManager"] satisfies Inject<
    Pick<HypernodeServices, "appServer" | "storage" | "threadManager">
  >;

  readonly table: CanonicalTimelineTable;

  constructor(ctx: HypernodeContext<"appServer" | "storage" | "threadManager">) {
    super(ctx, "canonicalTimeline");
    this.table = new CanonicalTimelineTable(ctx.storage);
    ctx.effect(() => ctx.appServer.register("thread/timeline/list", (params, connection) => {
      if (connection?.initializeParams?.capabilities?.experimentalApi !== true) {
        throw new Error("thread/timeline/list requires experimentalApi capability");
      }
      const thread = ctx.threadManager.get(requiredThreadId(params.threadId));
      const timelineParams: TimelineListParams = {};
      if (Number.isSafeInteger(params.limit)) timelineParams.limit = Number(params.limit);
      if (typeof params.cursor === "string" || params.cursor === null) timelineParams.cursor = params.cursor;
      return this.table.timeline(thread.id, timelineParams);
    }));
    ctx.effect(() => ctx.appServer.register("hypernode/sync/v1/read", (params, connection) => {
      if (connection?.initializeParams?.capabilities?.["hypernode.sync.v1"] !== true) {
        throw new Error("hypernode/sync/v1/read requires hypernode.sync.v1 capability");
      }
      const thread = ctx.threadManager.get(requiredThreadId(params.threadId));
      const syncParams: SyncParams = {};
      if (Number.isSafeInteger(params.limit)) syncParams.limit = Number(params.limit);
      if (params.cursor === null || (params.cursor && typeof params.cursor === "object")) {
        syncParams.cursor = params.cursor;
      }
      if (typeof params.direction === "string") syncParams.direction = params.direction;
      return this.table.sync(thread.id, syncParams);
    }));
  }

  append(threadId: unknown, input: CanonicalEventInput = {}): CanonicalAppendResult {
    return this.table.append(threadId, input);
  }
  entries(threadId: unknown): CanonicalEvent[] { return this.table.entries(threadId); }
  head(threadId: unknown): CanonicalHead { return this.table.head(threadId); }
  sync(threadId: unknown, params: SyncParams = {}): CanonicalSyncResult {
    return this.table.sync(threadId, params);
  }
  reset(threadId: unknown): CanonicalHead { return this.table.reset(threadId); }
  compactThrough(threadId: unknown, cursor: CanonicalCursor): CanonicalHead {
    return this.table.compactThrough(threadId, cursor);
  }
  delete(threadId: unknown): boolean { return this.table.delete(threadId); }
  fork(sourceThreadId: unknown, targetThreadId: unknown, options: ForkOptions = {}): CanonicalForkResult {
    return this.table.fork(sourceThreadId, targetThreadId, options);
  }

  private appServerEvent(
    method: string,
    params: CanonicalParams,
    source: CanonicalEventSource,
  ): { threadId: string; eventId: string | null; input: CanonicalEventInput } | null {
    const threadId = params?.threadId ?? params?.thread?.id ?? null;
    if (!threadId || typeof method !== "string") return null;
    if (eventTypeForMethod(method) === "item.delta" && source.persistDelta !== true) return null;
    const eventId = source.eventId ?? lifecycleEventId(method, params);
    const input: CanonicalEventInput = {
      eventId,
      type: eventTypeForMethod(method),
      turnId: params?.turnId ?? params?.turn?.id ?? null,
      itemId: itemIdFromParams(params),
      data: { method, params: clone(params) },
      source,
    };
    if (typeof source.time === "number") input.time = source.time;
    return { threadId, eventId, input };
  }

  recordAppServer(
    method: string,
    params: CanonicalParams,
    source: CanonicalEventSource = {},
  ): CanonicalRecordResult {
    // Deltas are a live presentation transport. The authoritative durable
    // state is the completed item, which contains the accumulated text or
    // output. Persisting every paced slice would duplicate provider chunks,
    // inflate SQLite, and make presentation cadence part of execution truth.
    const prepared = this.appServerEvent(method, params, source);
    if (prepared === null) return null;
    try {
      return this.append(prepared.threadId, prepared.input);
    } catch (error) {
      // A durable projection failure is serious and must be observable, but it
      // must not prevent the already-produced terminal notification from
      // reaching Desktop. Callers broadcast immediately after this method.
      const failure = this.table.recordFailure(prepared.threadId, {
        method, eventId: prepared.eventId, sourceEngine: source.engine ?? null, error,
      });
      console.error(
        `[canonical-timeline] persistence failed thread=${prepared.threadId} method=${method}: ${failure.errorMessage}`,
      );
      return { appended: false, persisted: false, failure };
    }
  }

  recordAppServerBatch(records: Array<{
    method: string;
    params: CanonicalParams;
    source?: CanonicalEventSource;
  }>): CanonicalRecordResult[] {
    const results: CanonicalRecordResult[] = records.map(() => null);
    const prepared = records.flatMap((record, index) => {
      const source = record.source ?? {};
      const event = this.appServerEvent(record.method, record.params, source);
      return event === null ? [] : [{ index, method: record.method, source, event }];
    });
    const first = prepared[0];
    if (!first) return results;
    const threadId = first.event.threadId;
    if (prepared.some((record) => record.event.threadId !== threadId)) {
      return records.map((record) =>
        this.recordAppServer(record.method, record.params, record.source ?? {}));
    }
    try {
      const appended = this.table.appendBatch(
        threadId,
        prepared.map((record) => record.event.input),
      );
      prepared.forEach((record, index) => {
        const result = appended[index];
        if (!result) throw new Error("canonical timeline batch result is incomplete");
        results[record.index] = result;
      });
      return results;
    } catch (error) {
      for (const record of prepared) {
        const failure = this.table.recordFailure(threadId, {
          method: record.method,
          eventId: record.event.eventId,
          sourceEngine: record.source.engine ?? null,
          error,
        });
        results[record.index] = { appended: false, persisted: false, failure };
      }
      console.error(
        `[canonical-timeline] batch persistence failed thread=${threadId} events=${prepared.length}: ${String(error)}`,
      );
      return results;
    }
  }

  turns(threadOrId: string | { id?: string }): CanonicalTurn[] {
    const threadId = typeof threadOrId === "string" ? threadOrId : threadOrId?.id;
    return reduceCanonicalTimeline(this.entries(assertThreadId(threadId)));
  }
}
