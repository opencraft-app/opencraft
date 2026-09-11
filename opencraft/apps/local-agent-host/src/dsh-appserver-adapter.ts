import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { DshClient, type DshEvent, type DshHistoryEntry } from "./dsh-client.js";
import { RuntimeProviderService } from "./runtime-provider-service.js";
import { DshInteractions } from "./dsh-interactions.js";
import { DshTurnProjection } from "./dsh-turn-projection.js";
import { projectDshGoal } from "./dsh-goal-projection.js";
import { OPENCRAFT_THREAD_QUEUE_EXTENSION } from "@opencraft/appserver-protocol";
import type { RuntimeProviderApplyParams, RuntimeModelsDiscoverParams, RuntimeProviderSetEnabledParams, RuntimeModelMutationParams, RuntimeModelsListResponse } from "@opencraft/appserver-protocol";

type RecordValue = Record<string, unknown>;

interface DshSessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  agentPreset?: string;
  parentSessionId?: string;
  projections?: { asOfSeq: number; values: Record<string, unknown> };
}

interface DshHistoryPage {
  events: DshHistoryEntry[];
  hasMore: boolean;
  projections?: { asOfSeq: number; values: Record<string, unknown> };
}

interface DshModelCatalog {
  groups: ReadonlyArray<{
    id: string;
    name: string;
    models: ReadonlyArray<{
      id: string;
      name: string;
      description?: string;
      reasoning?: {
        efforts: ReadonlyArray<{ id: string; name: string; description?: string }>;
        defaultEffort?: string;
      };
    }>;
  }>;
  failures: ReadonlyArray<{ id: string; name: string; message: string }>;
}

interface DshSessionModels extends DshModelCatalog {
  current?: { provider: string; model: string; reasoningEffort?: string };
  routable: boolean;
}

interface QueuedSubmission {
  id: string;
  input: RecordValue[];
  clientUserMessageId: string;
  createdAt: number;
  pausedReason: string | null;
}

const object = (value: unknown): RecordValue => (
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {}
);
const number = (value: unknown, fallback = 0): number => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const string = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;

function appTimestamp(value: number): number {
  if (value <= 0) return Math.floor(Date.now() / 1_000);
  return value > 10_000_000_000 ? Math.floor(value / 1_000) : Math.floor(value);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    const value = object(part);
    return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("");
}

function userContent(content: unknown): RecordValue[] {
  if (!Array.isArray(content)) return contentText(content) === "" ? [] : [{ type: "text", text: contentText(content), text_elements: [] }];
  return content.flatMap<RecordValue>((raw) => {
    const block = object(raw);
    if (block.type === "text" && typeof block.text === "string") {
      return [{ type: "text", text: block.text, text_elements: [] }];
    }
    const attachment = object(block.attachment);
    if (block.type === "image") {
      const mediaType = string(block.mediaType);
      const data = string(block.data);
      if (mediaType.startsWith("image/") && data !== "") {
        return [{ type: "image", url: `data:${mediaType};base64,${data}` }];
      }
      const path = string(attachment.path) || string(attachment.filePath);
      if (path !== "") return [{ type: "localImage", path }];
      const url = string(attachment.url);
      if (url !== "") return [{ type: "image", url }];
    }
    return [];
  });
}

const IMAGE_MEDIA_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

async function promptContent(input: unknown): Promise<RecordValue[]> {
  if (!Array.isArray(input)) return [];
  const content: RecordValue[] = [];
  for (const raw of input) {
    const part = object(raw);
    if (part.type === "text" && typeof part.text === "string") {
      content.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "localImage" && typeof part.path === "string") {
      const mediaType = IMAGE_MEDIA_TYPES.get(extname(part.path).toLowerCase());
      if (!mediaType) throw new Error(`Unsupported local image type: ${part.path}`);
      content.push({
        type: "image",
        mediaType,
        data: (await readFile(part.path)).toString("base64"),
        name: basename(part.path),
      });
      continue;
    }
    if (part.type === "image" && typeof part.url === "string") {
      const dataUrl = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/=]+)$/u.exec(part.url);
      if (dataUrl) {
        content.push({ type: "image", mediaType: dataUrl[1], data: dataUrl[2] });
        continue;
      }
      const response = await fetch(part.url);
      if (!response.ok) throw new Error(`Unable to fetch image (${response.status})`);
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (![...IMAGE_MEDIA_TYPES.values()].includes(mediaType ?? "")) throw new Error("Unsupported remote image type");
      content.push({
        type: "image",
        mediaType,
        data: Buffer.from(await response.arrayBuffer()).toString("base64"),
      });
    }
  }
  return content;
}

function turnId(sessionId: string, turn: number): string {
  return `dsh-turn-${sessionId}-${turn}`;
}

function blockId(sessionId: string, turn: number, step: number, index: number, type: string): string {
  return `dsh-${type}-${sessionId}-${turn}-${step}-${index}`;
}

function eventItems(sessionId: string, event: DshEvent, turnOverride?: number, stepOverride?: number): RecordValue[] {
  const data = object(event.data);
  const turn = number(data.turn, turnOverride ?? 0);
  const step = number(data.step, stepOverride ?? 0);
  if (event.type === "user/message") {
    const source = object(data.source);
    const sourceKind = string(source.kind);
    if (sourceKind !== "user" && sourceKind !== "human") return [];
    return [{
      type: "userMessage",
      id: string(data.id) || blockId(sessionId, turn, step, event.seq, "user"),
      clientId: typeof source.rpcId === "string" ? source.rpcId : null,
      content: userContent(data.content),
    }];
  }
  if (event.type === "assistant/message") {
    const message = object(data.message);
    const content = Array.isArray(message.content) ? message.content : [];
    return content.flatMap<RecordValue>((raw, index) => {
      const block = object(raw);
      if (block.type === "text" && typeof block.text === "string") return [{
        type: "agentMessage",
        id: blockId(sessionId, turn, step, index, "assistant"),
        text: block.text,
        phase: null,
        memoryCitation: null,
      }];
      if (block.type === "reasoning" && typeof block.text === "string") return [{
        type: "reasoning",
        id: blockId(sessionId, turn, step, index, "reasoning"),
        summary: [],
        content: [{ type: "reasoningText", text: block.text }],
      }];
      return [];
    });
  }
  return [];
}

function turnOutcome(data: RecordValue): {
  status: "completed" | "interrupted" | "failed";
  error: RecordValue | null;
} {
  const raw = data.reason;
  if (typeof raw === "string") {
    if (raw === "cancelled" || raw === "interrupted") return { status: "interrupted", error: null };
    if (raw === "failed" || raw === "error") return { status: "failed", error: { message: raw } };
    return { status: "completed", error: null };
  }
  const reason = object(raw);
  const kind = string(reason.kind);
  if (kind === "cancelled" || kind === "interrupted") return { status: "interrupted", error: null };
  if (kind === "error" || kind === "failed") {
    const failure = object(reason.error ?? reason.failure);
    return {
      status: "failed",
      error: {
        message: string(failure.message, "DeepSeek Harness turn failed"),
        ...(typeof failure.code === "string" ? { code: failure.code } : {}),
      },
    };
  }
  return { status: "completed", error: null };
}

interface TurnAccumulator {
  id: string;
  items: RecordValue[];
  itemsView: "full";
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: unknown;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

function mapEvents(sessionId: string, entries: readonly DshHistoryEntry[], running = false, cwd = homedir()): TurnAccumulator[] {
  const turns = new Map<number, TurnAccumulator>();
  const toolProjections = new Map<number, DshTurnProjection>();
  const ordered = [...entries].sort((a, b) => a.event.seq - b.event.seq);
  let activeTurn = -1;
  let activeStep = 0;
  for (const { event } of ordered) {
    const data = object(event.data);
    if (event.type === "turn/start") activeTurn = number(data.turn, -1);
    if (event.type === "step/start") activeStep = number(data.step, 0);
    const index = number(data.turn, activeTurn);
    if (index < 0) continue;
    let turn = turns.get(index);
    if (turn === undefined) {
      turn = {
        id: turnId(sessionId, index), items: [], itemsView: "full", status: "inProgress", error: null,
        startedAt: null, completedAt: null, durationMs: null,
      };
      turns.set(index, turn);
    }
    if (event.type === "turn/start") turn.startedAt = appTimestamp(event.time);
    if (event.type === "turn/end") {
      const outcome = turnOutcome(data);
      turn.status = outcome.status;
      turn.error = outcome.error;
      turn.completedAt = appTimestamp(event.time);
      if (turn.startedAt !== null) turn.durationMs = Math.max(0, (turn.completedAt - turn.startedAt) * 1_000);
    }
    let tools = toolProjections.get(index);
    if (!tools) { tools = new DshTurnProjection(sessionId, turn.id, cwd); toolProjections.set(index, tools); }
    const projection = tools.project(event, eventItems(sessionId, event, index, activeStep));
    const projected = [...projection.completed, ...projection.started];
    for (const item of projected) {
      const existing = turn.items.findIndex((candidate) => candidate.id === item.id);
      if (existing >= 0) turn.items[existing] = item;
      else turn.items.push(item);
    }
  }
  for (const [index, projection] of toolProjections) {
    const turn = turns.get(index)!;
    for (const item of projection.snapshotPending()) {
      const existing = turn.items.findIndex(candidate => candidate.id === item.id);
      if (existing >= 0) turn.items[existing] = item; else turn.items.push(item);
    }
  }
  const result = [...turns.entries()].sort(([left], [right]) => left - right).map(([, turn]) => turn);
  if (!running) {
    for (const turn of result) if (turn.status === "inProgress") turn.status = "completed";
  }
  return result;
}

function titleFor(summary: DshSessionSummary): string {
  const projected = summary.projections?.values.title;
  return typeof projected === "string" && projected.trim() !== "" ? projected.trim() : "New chat";
}

function makeThread(summary: DshSessionSummary, turns: TurnAccumulator[] = []): RecordValue {
  const title = titleFor(summary);
  const timestamp = appTimestamp(summary.updatedAt);
  const cwd = summary.cwd ?? homedir();
  return {
    id: summary.sessionId,
    sessionId: summary.sessionId,
    extra: { dsh: { agentPreset: summary.agentPreset ?? null, blank: summary.blank } },
    forkedFromId: summary.parentSessionId ?? null,
    parentThreadId: summary.parentSessionId ?? null,
    preview: title,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "dsh",
    createdAt: timestamp,
    updatedAt: timestamp,
    recencyAt: timestamp,
    status: summary.running ? { type: "active", activeFlags: [] } : { type: "idle" },
    path: null,
    cwd,
    cliVersion: "dsh/0.1.1",
    source: { custom: "dsh" },
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: title,
    turns,
  };
}

function page<T>(items: readonly T[], cursor: unknown, limit: unknown): { data: T[]; nextCursor: string | null } {
  const offset = typeof cursor === "string" && /^dsh-list:\d+$/u.test(cursor) ? Number(cursor.slice(9)) : 0;
  const size = typeof limit === "number" ? Math.min(200, Math.max(1, Math.floor(limit))) : 50;
  return { data: items.slice(offset, offset + size), nextCursor: offset + size < items.length ? `dsh-list:${offset + size}` : null };
}

function beforeSeq(cursor: unknown): number | undefined {
  if (cursor === null || cursor === undefined) return undefined;
  if (typeof cursor !== "string" || !/^dsh-seq:\d+$/u.test(cursor)) throw new Error("Invalid DSH history cursor");
  return Number(cursor.slice(8));
}

const DSH_MODEL_PREFIX = "dsh-model:";

function encodeModel(provider: string, model: string): string {
  return `${DSH_MODEL_PREFIX}${encodeURIComponent(provider)}:${encodeURIComponent(model)}`;
}

function decodeModel(value: unknown): { provider: string; model: string } | null {
  if (typeof value !== "string" || !value.startsWith(DSH_MODEL_PREFIX)) return null;
  const encoded = value.slice(DSH_MODEL_PREFIX.length);
  const separator = encoded.indexOf(":");
  if (separator <= 0 || separator === encoded.length - 1) throw new Error("Invalid DSH model selection");
  const provider = decodeURIComponent(encoded.slice(0, separator)).trim();
  const model = decodeURIComponent(encoded.slice(separator + 1)).trim();
  if (provider === "" || model === "") throw new Error("Invalid DSH model selection");
  return { provider, model };
}

function mapModels(catalog: RuntimeModelsListResponse, current?: { provider: string; model: string }): RecordValue[] {
  const first = catalog.groups[0]?.models[0];
  const defaultProvider = current?.provider ?? catalog.groups[0]?.id;
  const defaultModel = current?.model ?? first?.id;
  return catalog.groups.flatMap((group) => group.models.map((model) => ({
    id: encodeModel(group.id, model.id),
    model: encodeModel(group.id, model.id),
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: model.name,
    description: model.description ?? `DeepSeek Harness via ${group.name}`,
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: (model.reasoning?.efforts ?? []).map((effort) => ({
      reasoningEffort: effort.id,
      description: effort.description ?? effort.name,
    })),
    defaultReasoningEffort: model.reasoning?.defaultEffort ?? "none",
    inputModalities: ["text", "image"],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: group.id === defaultProvider && model.id === defaultModel,
  })));
}

export type NotificationSink = (method: string, params: unknown) => void;

export class DshAppServerAdapter {
  private readonly summaries = new Map<string, DshSessionSummary>();
  private readonly abort = new AbortController();
  private readonly sinks = new Set<NotificationSink>();
  private streamsStarted = false;
  private readonly livePosition = new Map<string, { turn: number; step: number }>();
  private readonly liveItemIds = new Set<string>();
  private readonly liveTools = new Map<string, DshTurnProjection>();
  readonly interactions: DshInteractions;
  private readonly nextTurnWaiters = new Map<string, Set<(turn: number) => void>>();
  /** Read-through projection of DSH's authoritative session/queue snapshots. */
  private readonly queues = new Map<string, QueuedSubmission[]>();
  private readonly queueItemWaiters = new Map<string, Map<string, Set<(item: QueuedSubmission) => void>>>();
  private readonly queueRemovalWaiters = new Map<string, Map<string, Set<() => void>>>();
  private readonly queueConsumptionTailBySession = new Map<string, Promise<void>>();
  private streamsReady: Promise<void> | null = null;

  private readonly providers: RuntimeProviderService;
  constructor(readonly client: DshClient) {
    this.providers = new RuntimeProviderService(client);
    this.interactions = new DshInteractions(client, async sessionId => {
      const position = this.livePosition.get(sessionId);
      if (position && position.turn >= 0) return { turnId: turnId(sessionId, position.turn) };
      const page = await this.history(sessionId, null, 100);
      const last = page.turns.at(-1);
      if (!last) throw new Error(`Cannot correlate DSH interaction to a turn: ${sessionId}`);
      return { turnId: last.id };
    }, params => this.emit("serverRequest/resolved", params));
  }

  subscribe(sink: NotificationSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  async startStreams(): Promise<void> {
    if (this.streamsReady !== null) return this.streamsReady;
    this.streamsStarted = true;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    let ready = false;
    this.streamsReady = new Promise<void>((resolve, reject) => {
      resolveReady = () => { ready = true; resolve(); };
      rejectReady = reject;
    });
    void this.runStreamLoop(resolveReady).catch((error) => {
      if (!ready) rejectReady(error);
      else if (!this.abort.signal.aborted) console.error("[opencraft local host] DSH streams", error);
    });
    return this.streamsReady;
  }

  private async runStreamLoop(onFirstReady: () => void): Promise<void> {
    let backoffMs = 100;
    let firstGeneration = true;
    while (!this.abort.signal.aborted) {
      const generation = new AbortController();
      const stopGeneration = () => generation.abort();
      this.abort.signal.addEventListener("abort", stopGeneration, { once: true });
      let opened = 0;
      const onOpen = () => {
        opened += 1;
        if (opened === 2 && firstGeneration) {
          firstGeneration = false;
          onFirstReady();
        }
      };
      const tasks = [
        this.client.stream("/api/events.mux", (frame) => this.onMuxFrame({ ...frame.payload, rpcId: frame.rpcId }), generation.signal, onOpen),
        this.client.stream("/api/events.host", (frame) => this.onHostFrame(frame.payload), generation.signal, onOpen),
      ];
      try {
        await Promise.race(tasks);
      } catch (error) {
        if (!this.abort.signal.aborted) console.warn("[opencraft local host] restarting DSH stream generation", error);
      } finally {
        generation.abort();
        await Promise.allSettled(tasks);
        this.abort.signal.removeEventListener("abort", stopGeneration);
        // DSH omits empty queues from a reconnect baseline. Invalidate the
        // old generation immediately so absence cannot leave stale rows.
        const projectedSessions = [...this.queues.keys()];
        this.queues.clear();
        for (const threadId of projectedSessions) {
          this.emit("thread/queue/changed", { threadId });
        }
      }
      if (this.abort.signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 2_000);
    }
  }

  close(): void { this.abort.abort(); this.interactions.close(); this.liveTools.clear(); this.sinks.clear(); }

  private emit(method: string, params: unknown): void {
    for (const sink of this.sinks) sink(method, params);
  }

  private onHostFrame(frame: RecordValue): void {
    const sessionId = string(frame.sessionId);
    if (sessionId === "") return;
    if (frame.type === "host/session-status") {
      const summary = this.summaries.get(sessionId);
      if (summary) this.summaries.set(sessionId, { ...summary, running: frame.running === true, blank: summary.blank && frame.running !== true });
      this.emit("thread/status/changed", { threadId: sessionId, status: frame.running === true ? { type: "active", activeFlags: [] } : { type: "idle" } });
    }
    if (frame.type === "host/session-added") this.emit("thread/started", { thread: makeThread({
      sessionId,
      updatedAt: Date.now(),
      running: false,
      blank: frame.blank !== false,
      cwd: string(frame.cwd, homedir()),
      parentSessionId: typeof frame.parentSessionId === "string" ? frame.parentSessionId : undefined,
    }) });
  }

  private onMuxFrame(frame: RecordValue): void {
    if (typeof frame.type === "string" && (frame.type.startsWith("question/") || frame.type.startsWith("approval/"))) {
      void this.interactions.receive(frame).catch(error => console.error("[opencraft local host] interaction projection", error));
      return;
    }
    if (frame.type === "session/queue") {
      const sessionId = string(frame.sessionId);
      if (sessionId === "") return;
      const previousById = new Map(this.queue(sessionId).map((submission) => [submission.id, submission]));
      const submissions = (Array.isArray(frame.items) ? frame.items : []).flatMap<QueuedSubmission>((raw) => {
        const item = object(raw);
        if (item.placement !== "queued") return [];
        const message = object(item.message);
        const id = string(item.id) || string(message.id);
        if (id === "") return [];
        const source = object(message.source);
        return [{
          id,
          input: userContent(message.content),
          clientUserMessageId: string(source.rpcId, id),
          createdAt: previousById.get(id)?.createdAt
            ?? number(item.createdAt, number(message.createdAt, Date.now())),
          pausedReason: null,
        }];
      });
      this.queues.set(sessionId, submissions);
      const waiters = this.queueItemWaiters.get(sessionId);
      if (waiters !== undefined) {
        for (const submission of submissions) {
          const matching = waiters.get(submission.clientUserMessageId);
          if (matching === undefined) continue;
          for (const resolve of matching) resolve(submission);
          waiters.delete(submission.clientUserMessageId);
        }
        if (waiters.size === 0) this.queueItemWaiters.delete(sessionId);
      }
      const removalWaiters = this.queueRemovalWaiters.get(sessionId);
      if (removalWaiters !== undefined) {
        const presentIds = new Set(submissions.map((submission) => submission.id));
        for (const [itemId, matching] of removalWaiters) {
          if (presentIds.has(itemId)) continue;
          for (const resolve of matching) resolve();
          removalWaiters.delete(itemId);
        }
        if (removalWaiters.size === 0) this.queueRemovalWaiters.delete(sessionId);
      }
      this.emit("thread/queue/changed", { threadId: sessionId });
      return;
    }
    if (frame.type !== "session/event") return;
    const sessionId = string(frame.sessionId);
    const event = object(frame.event) as unknown as DshEvent;
    const data = object(event.data);
    const position = this.livePosition.get(sessionId) ?? { turn: -1, step: 0 };
    if (event.type === "turn/start") position.turn = number(data.turn, -1);
    if (event.type === "step/start") position.step = number(data.step, 0);
    this.livePosition.set(sessionId, position);
    const turn = number(data.turn, position.turn);
    if (event.type === "goal/change" && sessionId !== "") {
      const goal = projectDshGoal(sessionId, data);
      if (goal) this.emit("thread/goal/updated", { threadId: sessionId, turnId: turn < 0 ? null : turnId(sessionId, turn), goal });
      else if (data.operation === "clear") this.emit("thread/goal/cleared", { threadId: sessionId });
      return;
    }
    if (sessionId === "" || turn < 0) return;
    const appTurn = { id: turnId(sessionId, turn), items: [], itemsView: "full", status: "inProgress", error: null, startedAt: appTimestamp(event.time), completedAt: null, durationMs: null };
    if (event.type === "turn/start") {
      this.emit("turn/started", { threadId: sessionId, turn: appTurn });
      for (const resolve of this.nextTurnWaiters.get(sessionId) ?? []) resolve(turn);
      this.nextTurnWaiters.delete(sessionId);
    }
    const toolScope = appTurn.id;
    let tools = this.liveTools.get(toolScope);
    if (!tools) { tools = new DshTurnProjection(sessionId, appTurn.id, this.summaries.get(sessionId)?.cwd ?? homedir()); this.liveTools.set(toolScope, tools); }
    const projection = tools.project(event, eventItems(sessionId, event, turn, position.step));
    if (event.type === "turn/end") {
      this.liveTools.delete(toolScope);
    }
    for (const notification of projection.notifications) this.emit(notification.method, notification.params);
    for (const [method, items] of [["item/completed", projection.completed], ["item/started", projection.started]] as const) for (const item of items) {
      this.emit(method, {
        threadId: sessionId,
        turnId: appTurn.id,
        item,
      });
    }
    if (event.type === "assistant/chunk") {
      const chunk = object(data.chunk);
      const index = number(chunk.index);
      const delta = string(chunk.text);
      const step = number(data.step, position.step);
      const type = chunk.type === "reasoning-delta" ? "reasoning" : "assistant";
      const itemId = blockId(sessionId, turn, step, index, type);
      if ((chunk.type === "text-delta" || chunk.type === "reasoning-delta") && !this.liveItemIds.has(itemId)) {
        this.liveItemIds.add(itemId);
        this.emit("item/started", {
          threadId: sessionId,
          turnId: appTurn.id,
          item: type === "assistant"
            ? { type: "agentMessage", id: itemId, text: "", phase: null, memoryCitation: null }
            : { type: "reasoning", id: itemId, summary: [], content: [] },
        });
      }
      if (chunk.type === "text-delta" && delta !== "") this.emit("item/agentMessage/delta", { threadId: sessionId, turnId: appTurn.id, itemId, delta });
      if (chunk.type === "reasoning-delta" && delta !== "") this.emit("item/reasoning/textDelta", { threadId: sessionId, turnId: appTurn.id, itemId, delta });
    }
    if (event.type === "turn/end") {
      const outcome = turnOutcome(data);
      this.emit("turn/completed", {
        threadId: sessionId,
        turn: {
          ...appTurn,
          status: outcome.status,
          error: outcome.error,
          completedAt: appTimestamp(event.time),
        },
      });
    }
  }

  private waitForNextTurn(sessionId: string, timeoutMs = 10_000): { promise: Promise<number>; cancel: () => void } {
    let cancel = () => {};
    const promise = new Promise<number>((resolve, reject) => {
      const waiters = this.nextTurnWaiters.get(sessionId) ?? new Set<(turn: number) => void>();
      let settled = false;
      const finish = (turn: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(finish);
        resolve(turn);
      };
      waiters.add(finish);
      this.nextTurnWaiters.set(sessionId, waiters);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        waiters.delete(finish);
        if (waiters.size === 0) this.nextTurnWaiters.delete(sessionId);
        reject(new Error("DSH accepted the prompt but did not publish turn/start"));
      }, timeoutMs);
      cancel = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0) this.nextTurnWaiters.delete(sessionId);
      };
    });
    return { promise, cancel };
  }

  private waitForQueueItem(
    sessionId: string,
    clientUserMessageId: string,
    timeoutMs = 10_000,
  ): { promise: Promise<QueuedSubmission>; cancel: () => void } {
    const present = this.queues.get(sessionId)?.find(
      (item) => item.clientUserMessageId === clientUserMessageId,
    );
    if (present !== undefined) return { promise: Promise.resolve(present), cancel: () => {} };
    let cancel = () => {};
    const promise = new Promise<QueuedSubmission>((resolve, reject) => {
      const byClientId = this.queueItemWaiters.get(sessionId) ?? new Map();
      const waiters = byClientId.get(clientUserMessageId) ?? new Set();
      let settled = false;
      const finish = (item: QueuedSubmission) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(finish);
        resolve(item);
      };
      waiters.add(finish);
      byClientId.set(clientUserMessageId, waiters);
      this.queueItemWaiters.set(sessionId, byClientId);
      const cleanup = () => {
        waiters.delete(finish);
        if (waiters.size === 0) byClientId.delete(clientUserMessageId);
        if (byClientId.size === 0) this.queueItemWaiters.delete(sessionId);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("DSH accepted the follow-up but did not publish it in session/queue"));
      }, timeoutMs);
      cancel = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
      };
    });
    return { promise, cancel };
  }

  private queue(sessionId: string): QueuedSubmission[] {
    return this.queues.get(sessionId) ?? [];
  }

  private waitForQueueRemoval(
    sessionId: string,
    itemId: string,
    timeoutMs = 5_000,
  ): { promise: Promise<void>; cancel(): void } {
    if (!this.queue(sessionId).some((submission) => submission.id === itemId)) {
      return { promise: Promise.resolve(), cancel() {} };
    }
    let cancel = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      const byItem = this.queueRemovalWaiters.get(sessionId) ?? new Map();
      const waiters = byItem.get(itemId) ?? new Set();
      let settled = false;
      const cleanup = () => {
        waiters.delete(finish);
        if (waiters.size === 0) byItem.delete(itemId);
        if (byItem.size === 0) this.queueRemovalWaiters.delete(sessionId);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve();
      };
      waiters.add(finish);
      byItem.set(itemId, waiters);
      this.queueRemovalWaiters.set(sessionId, byItem);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`DSH accepted queue consumption but did not remove ${itemId} from session/queue`));
      }, timeoutMs);
      cancel = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
      };
    });
    return { promise, cancel };
  }

  private async consumeQueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queueConsumptionTailBySession.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.queueConsumptionTailBySession.set(sessionId, tail);
    try {
      return await result;
    } finally {
      if (this.queueConsumptionTailBySession.get(sessionId) === tail) {
        this.queueConsumptionTailBySession.delete(sessionId);
      }
    }
  }

  private inProgressTurn(sessionId: string, turn: number): RecordValue {
    return {
      id: turnId(sessionId, turn),
      items: [],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: appTimestamp(Date.now()),
      completedAt: null,
      durationMs: null,
    };
  }

  private async sessionModels(sessionId: string): Promise<DshSessionModels> {
    return this.client.call<DshSessionModels>("session.models", { sessionId });
  }

  private async selectModel(sessionId: string, requested: unknown, effort?: unknown): Promise<DshSessionModels> {
    const selection = decodeModel(requested);
    if (selection !== null) {
      const selectable = await this.providers.models();
      if (!selectable.groups.some(group => group.id === selection.provider && group.models.some(model => model.id === selection.model))) {
        const current = await this.sessionModels(sessionId);
        if (current.current?.provider !== selection.provider || current.current.model !== selection.model) throw new Error("Selected model is disabled or unavailable");
        // A selection preference must not interrupt an already-bound conversation.
        if (effort === undefined || effort === current.current.reasoningEffort) return current;
      }
      await this.client.call("session.selectModel", {
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(typeof effort === "string" && effort !== "" ? { reasoningEffort: effort } : {}),
      });
    }
    return this.sessionModels(sessionId);
  }

  private async summariesList(): Promise<DshSessionSummary[]> {
    const value = await this.client.call<{ items: DshSessionSummary[] }>("session.list");
    for (const summary of value.items) this.summaries.set(summary.sessionId, summary);
    return value.items;
  }

  private async summary(sessionId: string): Promise<DshSessionSummary> {
    const known = this.summaries.get(sessionId);
    if (known) return known;
    const found = (await this.summariesList()).find((candidate) => candidate.sessionId === sessionId);
    if (!found) throw new Error(`Unknown DSH session ${sessionId}`);
    return found;
  }

  private async history(sessionId: string, cursor: unknown, limit: unknown): Promise<{ turns: TurnAccumulator[]; nextCursor: string | null }> {
    const before = beforeSeq(cursor);
    const history = await this.client.call<DshHistoryPage>("session.history", {
      sessionId,
      ...(before === undefined ? {} : { beforeSeq: before }),
      maxMessages: typeof limit === "number" ? Math.max(1, Math.min(100, Math.floor(limit))) : 20,
    });
    if (history.projections) {
      const current = await this.summary(sessionId);
      this.summaries.set(sessionId, { ...current, projections: history.projections });
    }
    const firstSeq = history.events.reduce((minimum, entry) => Math.min(minimum, entry.event.seq), Number.POSITIVE_INFINITY);
    return {
      turns: mapEvents(sessionId, history.events, (await this.summary(sessionId)).running, (await this.summary(sessionId)).cwd),
      nextCursor: history.hasMore && Number.isFinite(firstSeq) ? `dsh-seq:${firstSeq}` : null,
    };
  }

  private settingsWrites: Promise<unknown> = Promise.resolve();
  async dispatch(method: string, params: unknown): Promise<unknown> {
    if (/^runtime\/(settings\/mutate|providers\/(apply|setEnabled)|models\/(setEnabled|delete))$/.test(method)) {
      const next = this.settingsWrites.then(() => this.dispatchCommand(method, params));
      this.settingsWrites = next.catch(() => {});
      return next;
    }
    return this.dispatchCommand(method, params);
  }

  private async dispatchCommand(method: string, params: unknown): Promise<unknown> {
    const value = object(params);
    switch (method) {
      case "thread/goal/get": {
        const threadId = string(value.threadId);
        const history = await this.client.call<DshHistoryPage>("session.history", { sessionId: threadId, maxMessages: 1 });
        return { goal: projectDshGoal(threadId, history.projections?.values.goal) };
      }
      case "runtime/status/read": {
        const host = await this.client.call<RecordValue>("host.describe");
        return {
          engineId: "dsh",
          displayName: "DeepSeek Harness",
          version: string(host.version, "unknown"),
          cwd: string(host.cwd, homedir()),
          provider: typeof host.provider === "string" ? host.provider : null,
          model: typeof host.model === "string" ? host.model : null,
        };
      }
      case "runtime/settings/describe":
        return this.client.call("settings.describe");
      case "runtime/settings/mutate":
        if (value.ns === "llm-pi-ai") throw new Error("Use runtime provider/model commands to change model configuration");
        if (value.ns === "agent-default-model") {
          const settings = await this.client.call<{ namespaces: Array<{ ns: string; value: unknown }> }>("settings.describe");
          const next = { ...object(settings.namespaces.find(entry => entry.ns === value.ns)?.value) };
          if (!Array.isArray(value.ops)) throw new Error("Invalid default model settings");
          for (const operation of value.ops) {
            const op = object(operation);
            if (!Array.isArray(op.path) || op.path.length !== 1 || typeof op.path[0] !== "string") throw new Error("Invalid default model path");
            if (op.op === "unset") delete next[op.path[0]];
            else next[op.path[0]] = op.value;
          }
          const catalog = await this.providers.models();
          if (!catalog.groups.some(group => group.id === next.provider && group.models.some(model => model.id === next.model))) throw new Error("Default model must be enabled and available");
        }
        return this.client.call("settings.mutate", value);
      case "runtime/credentials/describe":
        return this.client.call("credentials.describe", value);
      case "runtime/credentials/set":
        return this.client.call("credentials.set", value);
      case "runtime/credentials/unset":
        return this.client.call("credentials.unset", value);
      case "runtime/providers/list":
        return this.providers.list();
      case "runtime/providers/apply":
        return this.providers.apply(params as RuntimeProviderApplyParams);
      case "runtime/providers/setEnabled":
        return this.providers.setEnabled(params as RuntimeProviderSetEnabledParams);
      case "runtime/models/list":
        return this.providers.models(value.includeDisabled === true);
      case "runtime/models/setEnabled":
        if (typeof value.enabled !== "boolean") throw new Error("Invalid model enabled state");
        return this.providers.mutateModel(params as RuntimeModelMutationParams, value.enabled);
      case "runtime/models/delete":
        return this.providers.mutateModel(params as RuntimeModelMutationParams);
      case "runtime/models/discover":
        return this.providers.discover(params as RuntimeModelsDiscoverParams);
      case "initialize": {
        const host = await this.client.call<RecordValue>("host.describe");
        await this.startStreams();
        return {
          codexHome: string(host.home, homedir()),
          platformFamily: "unix",
          platformOs: process.platform,
          userAgent: "opencraft-daemon/0.1.0",
          capabilities: {
            extensions: {
              [OPENCRAFT_THREAD_QUEUE_EXTENSION]: {
                version: 2,
                reorder: false,
                atomicSteer: true,
                perItemPause: false,
              },
            },
          },
        };
      }
      case "agent/list": {
        const catalog = await this.providers.models();
        const modelIds = catalog.groups.flatMap(group => group.models.map(model => encodeModel(group.id, model.id)));
        return page([{ id: "dsh", displayName: "DeepSeek Harness", description: "OpenCraft built-in coding agent", engineKind: "dsh", isDefault: true, defaultModel: null, modelIds, available: true }], value.cursor, value.limit);
      }
      case "thread/list": {
        const all = (await this.summariesList()).filter((entry) => !entry.blank).map((entry) => makeThread(entry));
        const sorted = all.sort((left, right) => number(right.updatedAt) - number(left.updatedAt));
        return page(sorted, value.cursor, value.limit);
      }
      case "thread/read": {
        const sessionId = string(value.threadId);
        const summary = await this.summary(sessionId);
        const history = value.includeTurns === true ? await this.history(sessionId, null, 50) : null;
        return { thread: makeThread(summary, history?.turns ?? []) };
      }
      case "thread/resume": {
        const sessionId = string(value.threadId);
        const [summary, history, models] = await Promise.all([
          this.summary(sessionId),
          this.history(sessionId, null, 20),
          this.sessionModels(sessionId),
        ]);
        const thread = makeThread(summary, value.excludeTurns === true ? [] : history.turns);
        const model = models.current ? encodeModel(models.current.provider, models.current.model) : "dsh";
        return {
          thread, cwd: thread.cwd, model, modelProvider: "dsh", serviceTier: null,
          reasoningEffort: models.current?.reasoningEffort ?? null,
          approvalPolicy: "on-request", approvalsReviewer: "user", instructionSources: [], runtimeWorkspaceRoots: [thread.cwd],
          sandbox: { type: "workspaceWrite", writableRoots: [thread.cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
          activePermissionProfile: null,
          multiAgentMode: "explicitRequestOnly",
          initialTurnsPage: value.initialTurnsPage === true
            ? { data: [...history.turns].reverse(), nextCursor: history.nextCursor, backwardsCursor: null, itemsPaginationByTurnId: {} }
            : null,
          turnsBackwardsCursor: history.nextCursor,
          itemsBackwardsCursor: null,
        };
      }
      case "thread/turns/list": {
        const history = await this.history(string(value.threadId), value.cursor, value.limit);
        const data = value.sortDirection === "asc" ? history.turns : [...history.turns].reverse();
        return { data, nextCursor: history.nextCursor, backwardsCursor: null, itemsPaginationByTurnId: {} };
      }
      case "thread/items/list": return { data: [], nextCursor: null };
      case "thread/queue/list":
        return page(this.queue(string(value.threadId)), value.cursor, value.limit);
      case "thread/queue/add": {
        const sessionId = string(value.threadId);
        const clientUserMessageId = string(value.clientUserMessageId);
        if (clientUserMessageId === "") throw new Error("Queued submissions require clientUserMessageId");
        const pending = this.waitForQueueItem(sessionId, clientUserMessageId);
        try {
          await this.client.call(
            "session.prompt",
            {
              sessionId,
              mode: "queue",
              content: await promptContent(value.input),
              clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            undefined,
            clientUserMessageId,
          );
        } catch (error) {
          pending.cancel();
          throw error;
        }
        return { queuedSubmission: await pending.promise };
      }
      case "thread/queue/update": {
        const sessionId = string(value.threadId);
        const queuedSubmissionId = string(value.queuedSubmissionId);
        const previous = this.queue(sessionId).find((item) => item.id === queuedSubmissionId);
        if (previous === undefined) return Promise.reject(new Error(`Queued submission ${queuedSubmissionId} is no longer pending`));
        const content = await promptContent(value.input);
        const input = userContent(content);
        await this.client.call("session.updateQueue", {
          sessionId,
          itemId: queuedSubmissionId,
          action: { kind: "edit", content },
        });
        return { queuedSubmission: { ...previous, input } };
      }
      case "thread/queue/delete": {
        const sessionId = string(value.threadId);
        const queuedSubmissionId = string(value.queuedSubmissionId);
        if (!this.queue(sessionId).some((item) => item.id === queuedSubmissionId)) return { deleted: false };
        await this.client.call("session.updateQueue", {
          sessionId,
          itemId: queuedSubmissionId,
          action: { kind: "remove" },
        });
        return { deleted: true };
      }
      case "thread/queue/reorder": {
        const sessionId = string(value.threadId);
        const requested = Array.isArray(value.queuedSubmissionIds)
          ? value.queuedSubmissionIds.map((id) => string(id))
          : [];
        const authoritative = this.queue(sessionId).map((item) => item.id);
        if (requested.length === authoritative.length && requested.every((id, index) => id === authoritative[index])) return {};
        throw new Error("DeepSeek Harness owns a strict FIFO queue and does not support reordering");
      }
      case "thread/queue/start": {
        const sessionId = string(value.threadId);
        return await this.consumeQueue(sessionId, async () => {
          const queue = this.queue(sessionId);
          const target = typeof value.queuedSubmissionId === "string"
            ? queue.find((item) => item.id === value.queuedSubmissionId)
            : queue[0];
          if (target === undefined) throw new Error("Queued submission is no longer pending");
          const liveTurn = this.livePosition.get(sessionId)?.turn ?? -1;
          if (liveTurn >= 0) {
            const removed = this.waitForQueueRemoval(sessionId, target.id);
            try {
              await this.client.call("session.updateQueue", {
                sessionId,
                itemId: target.id,
                action: { kind: "steer" },
              });
              await removed.promise;
            } catch (error) {
              removed.cancel();
              throw error;
            }
            return { turn: this.inProgressTurn(sessionId, liveTurn) };
          }
          if (target !== queue[0]) throw new Error("DeepSeek Harness resumes queued work in FIFO order");
          const nextTurn = this.waitForNextTurn(sessionId);
          return { turn: this.inProgressTurn(sessionId, await nextTurn.promise) };
        });
      }
      case "thread/queue/steer": {
        const sessionId = string(value.threadId);
        return await this.consumeQueue(sessionId, async () => {
          const queuedSubmissionId = string(value.queuedSubmissionId);
          const expectedTurnId = string(value.expectedTurnId);
          const liveTurn = this.livePosition.get(sessionId)?.turn ?? -1;
          if (liveTurn < 0) {
            throw Object.assign(new Error(`DSH thread has no active turn: ${sessionId}`), {
              rpcCode: -32009,
              domainData: { code: "TURN_INACTIVE", retryable: false },
            });
          }
          const actualTurnId = turnId(sessionId, liveTurn);
          if (expectedTurnId !== actualTurnId) {
            throw Object.assign(new Error(`Active DSH turn changed; expected ${expectedTurnId}, got ${actualTurnId}`), {
              rpcCode: -32009,
              domainData: {
                code: "EXPECTED_TURN_MISMATCH",
                retryable: true,
                actualTurnId,
              },
            });
          }
          if (!this.queue(sessionId).some((item) => item.id === queuedSubmissionId)) {
            throw new Error(`Queued submission ${queuedSubmissionId} is no longer pending`);
          }
          const removed = this.waitForQueueRemoval(sessionId, queuedSubmissionId);
          try {
            await this.client.call("session.updateQueue", {
              sessionId,
              itemId: queuedSubmissionId,
              action: { kind: "steer" },
            });
            await removed.promise;
          } catch (error) {
            removed.cancel();
            throw error;
          }
          return { turnId: actualTurnId };
        });
      }
      case "thread/start": {
        const created = await this.client.call<{ sessionId: string; agentPreset?: string }>("session.create", {
          ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
          ...(typeof value.agentId === "string" && value.agentId !== "dsh" ? { agentPreset: value.agentId } : {}),
        });
        const models = await this.selectModel(created.sessionId, value.model);
        const currentModel = models.current ? encodeModel(models.current.provider, models.current.model) : "dsh";
        const summary: DshSessionSummary = { sessionId: created.sessionId, updatedAt: Date.now(), running: false, blank: true, cwd: string(value.cwd, homedir()), agentPreset: created.agentPreset };
        this.summaries.set(summary.sessionId, summary);
        const thread = makeThread(summary);
        return {
          thread, model: currentModel, modelProvider: "dsh", serviceTier: null, cwd: thread.cwd, runtimeWorkspaceRoots: [thread.cwd], instructionSources: [],
          approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", writableRoots: [thread.cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
          activePermissionProfile: null, reasoningEffort: null, multiAgentMode: "explicitRequestOnly",
        };
      }
      case "turn/start": {
        const sessionId = string(value.threadId);
        const content = await promptContent(value.input);
        await this.selectModel(sessionId, value.model, value.effort);
        const nextTurn = this.waitForNextTurn(sessionId);
        try {
          await this.client.call(
            "session.prompt",
            { sessionId, mode: "queue", content, clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
            undefined,
            string(value.clientUserMessageId) || undefined,
          );
        } catch (error) {
          nextTurn.cancel();
          throw error;
        }
        const turnNumber = await nextTurn.promise;
        return { turn: this.inProgressTurn(sessionId, turnNumber) };
      }
      case "turn/steer": {
        const sessionId = string(value.threadId);
        const expectedTurnId = string(value.expectedTurnId);
        const liveTurn = this.livePosition.get(sessionId)?.turn ?? -1;
        if (liveTurn >= 0 && expectedTurnId !== turnId(sessionId, liveTurn)) {
          throw new Error(`Active DSH turn changed; expected ${expectedTurnId}`);
        }
        const clientUserMessageId = string(value.clientUserMessageId);
        await this.client.call(
          "session.prompt",
          {
            sessionId,
            mode: "steer",
            content: await promptContent(value.input),
            clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          undefined,
          clientUserMessageId || undefined,
        );
        return { turnId: expectedTurnId || (liveTurn >= 0 ? turnId(sessionId, liveTurn) : "") };
      }
      case "turn/interrupt": await this.client.call("session.cancel", { sessionId: string(value.threadId) }); return {};
      case "model/list": {
        const catalog = await this.providers.models();
        return page(mapModels(catalog), value.cursor, value.limit);
      }
      case "permissionProfile/list": return { data: [{ id: "default", label: "Default permissions", description: "Use the built-in DSH policy", allowed: true }], nextCursor: null };
      case "skills/list": return { data: [], nextCursor: null };
      case "project/list": {
        const result = await this.client.call<{ items: Array<{ workspaceId: string; path: string }> }>("workspace.list");
        return { data: result.items.map((entry) => ({ id: entry.workspaceId, name: basename(entry.path), roots: [{ path: entry.path }], metadata: { engine: "dsh" } })), nextCursor: null };
      }
      default: throw new Error(`Method not supported by OpenCraft DSH host: ${method}`);
    }
  }
}
