import { projectedHistoryHeadCursors, projectedItemsPage, projectedTurnsPage } from "./hypernode/thread-history.js";
import { homedir } from "node:os";
import { historyCursor, historyBoundary, readTurnWindow } from "./dsh-history-window.js";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { DshClient, type DshEvent, type DshHistoryEntry } from "./dsh-client.js";
import { RuntimeProviderService, type RuntimeModelInfoReader } from "./runtime-provider-service.js";
import { checkSavedModel } from "./saved-model-check.js";
import { reasoningCapability, modelInputModalities, unsupportedModelInput } from "@opencraft/composer-core";
import type { RuntimeModelProbeParams, RuntimeSettingsDescribeResponse } from "@opencraft/appserver-protocol";
import { DshInteractions } from "./dsh-interactions.js";
import { DshTurnProjection } from "./dsh-turn-projection.js";
import { userContent } from "./dsh-content.js";
import { DshExecutionAuthority, type DshExecutionOwner } from "./dsh-execution-authority.js";
import { DshNativeAdmission } from "./dsh-native-admission.js";
import { projectDshPermissions, type DshPermissionPort } from "./dsh-permission-projection.js";
import { DshPresentationQueue } from "./dsh-presentation-queue.js";
import { projectDshGoal } from "./dsh-goal-projection.js";
import {
  OPENCRAFT_LOCAL_DSH_SKILLS_CAPABILITY,
  OPENCRAFT_PROFILE_SKILLS_EXTENSION,
  OPENCRAFT_THREAD_QUEUE_EXTENSION,
} from "@opencraft/appserver-protocol";
import type { RuntimeProviderApplyParams, RuntimeModelsDiscoverParams, RuntimeProviderSetEnabledParams, RuntimeModelMutationParams, RuntimeModelsListResponse } from "@opencraft/appserver-protocol";

type RecordValue = Record<string, unknown>;
export interface DshThreadEnginePort {
  describe?(params: RecordValue): Promise<any>;
  create(params: RecordValue): Promise<any>;
  resume(params: RecordValue): Promise<any>;
  fork(params: RecordValue): Promise<any>;
  inject(params: RecordValue): Promise<any>;
  release(params: RecordValue): Promise<any>;
}

interface DshSessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  agentPreset?: string;
  parentSessionId?: string;
  origin?: string;
  ephemeral?: boolean;
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

interface TurnAccumulator {
  [key: string]: unknown;
  id: string; items: RecordValue[]; itemsView: "full";
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: unknown; startedAt: number | null; completedAt: number | null; durationMs: number | null;
}

function foldEvents(sessionId: string, entries: readonly DshHistoryEntry[], cwd = homedir()): Map<number, DshTurnProjection> {
  const turns = new Map<number, DshTurnProjection>();
  let activeTurn = -1;
  for (const { event } of [...entries].sort((a, b) => a.event.seq - b.event.seq)) {
    const data = object(event.data);
    if (event.type === "turn/start") activeTurn = number(data.turn, -1);
    const index = number(data.turn, activeTurn);
    if (index < 0) continue;
    let projection = turns.get(index);
    if (!projection) {
      projection = new DshTurnProjection(sessionId, turnId(sessionId, index), cwd);
      turns.set(index, projection);
    }
    projection.project(event);
  }
  return turns;
}

function mapEvents(sessionId: string, entries: readonly DshHistoryEntry[], running = false, cwd = homedir()): TurnAccumulator[] {
  return [...foldEvents(sessionId, entries, cwd).entries()].sort(([a], [b]) => a - b).map(([, projection]) => {
    if (!running && !projection.execution.ended) {
      projection.execution.fail("DSH history has no terminal record; completion is unconfirmed",
        projection.execution.record.startedAtMs);
    }
    return projection.execution.snapshot() as TurnAccumulator;
  });
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
    forkedFromId: summary.origin !== "subagent" ? summary.parentSessionId ?? null : null,
    parentThreadId: summary.origin === "subagent" ? summary.parentSessionId ?? null : null,
    preview: title,
    ephemeral: summary.ephemeral === true,
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

const DSH_MODEL_PREFIX = "dsh-model:";

function encodeModel(provider: string, model: string): string {
  return `${DSH_MODEL_PREFIX}${encodeURIComponent(provider)}:${encodeURIComponent(model)}`;
}

export function decodeModel(value: unknown): { provider: string; model: string } | null {
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
  const defaultProvider = current?.provider;
  const defaultModel = current?.model;
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
    defaultReasoningEffort: reasoningCapability((model.reasoning?.efforts ?? []).map(e=>e.id),model.reasoning?.defaultEffort).defaultEffort,
    inputModalities: modelInputModalities(model.input),
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
  setModelInfoReader(reader: RuntimeModelInfoReader): void { this.providers.setModelInfoReader(reader); }
  private threadEngine: DshThreadEnginePort | null = null;
  private readonly activations = new Map<string, Promise<unknown>>();
  private readonly historyFlights = new Map<string, Promise<DshHistoryPage>>();
  private readHistoryPage(sessionId: string, beforeSeq?: number): Promise<DshHistoryPage> {
    const key = JSON.stringify([sessionId, beforeSeq]);
    const prior = this.historyFlights.get(key);
    if (prior) return prior;
    const operation = this.client.call<DshHistoryPage>("session.history", {
      sessionId, maxMessages: 50, ...(beforeSeq === undefined ? {} : { beforeSeq }),
    }, this.abort.signal).finally(() => {
      if (this.historyFlights.get(key) === operation) this.historyFlights.delete(key);
    });
    this.historyFlights.set(key, operation);
    return operation;
  }
  private async readTurn(sessionId: string, id: string): Promise<TurnAccumulator[]> {
    let before: number | undefined;
    const chunks: DshHistoryEntry[][] = [];
    for (;;) {
      const page = await this.readHistoryPage(sessionId, before);
      const first = page.events[0]?.event.seq;
      if (page.hasMore && (first === undefined || (before !== undefined && first >= before))) throw new Error("Native history cursor made no progress");
      chunks.unshift(page.events);
      const start = page.events.find(entry => entry.event.type === "turn/start" && turnId(sessionId, number(object(entry.event.data).turn, -1)) === id);
      if (start || !page.hasMore) {
        if (!start) return [];
        const all = chunks.flat();
        const from = all.findIndex(entry => entry.event.seq === start.event.seq);
        const next = all.findIndex((entry, i) => i > from && entry.event.type === "turn/start");
        const summary = await this.summary(sessionId);
        return mapEvents(sessionId, all.slice(from, next < 0 ? undefined : next).filter(entry => {
          const turn = object(entry.event.data).turn;
          return typeof turn !== "number" || turnId(sessionId, turn) === id;
        }).map(entry => ({ ...entry,
          event: this.authority?.projectInput(sessionId, entry.event) ?? entry.event })), summary.running, summary.cwd);
      }
      before = first;
    }
  }
  private ensureRuntime(sessionId: string): Promise<unknown> {
    if (!this.threadEngine) return Promise.resolve();
    const existing = this.activations.get(sessionId);
    if (existing) return existing;
    const operation = this.threadEngine.resume({ sessionId }).finally(() => {
      if (this.activations.get(sessionId) === operation) this.activations.delete(sessionId);
    });
    this.activations.set(sessionId, operation);
    return operation;
  }
  setThreadEngine(port: DshThreadEnginePort): void { this.threadEngine = port; }
  private readonly summaries = new Map<string, DshSessionSummary>();
  private readonly abort = new AbortController();
  private readonly sinks = new Set<NotificationSink>();
  private readonly presentation = new DshPresentationQueue((method, params) => { for (const sink of this.sinks) sink(method, params); });
  private streamsStarted = false;
  private readonly livePosition = new Map<string, { turn: number; step: number }>();
  private readonly completedLiveTurns = new Set<string>();
  private readonly liveTools = new Map<string, DshTurnProjection>();
  private readonly latestTurns = new Map<string, DshTurnProjection>();
  private engineReady = true;
  readonly interactions: DshInteractions;
  private readonly nextTurnWaiters = new Map<string, Set<(turn: number) => void>>();
  /** Read-through projection of DSH's authoritative session/queue snapshots. */
  private readonly queues = new Map<string, QueuedSubmission[]>();
  private readonly nativeQueueIds = new Map<string, string>();
  private readonly queueItemWaiters = new Map<string, Map<string, Set<(item: QueuedSubmission) => void>>>();
  private readonly queueRemovalWaiters = new Map<string, Map<string, Set<() => void>>>();
  private readonly queueConsumptionTailBySession = new Map<string, Promise<void>>();
  private streamsReady: Promise<void> | null = null;
  private streamGeneration: AbortController | null = null;
  private readonly generationWaiters = new Set<() => void>();

  private readonly providers: RuntimeProviderService;
  private readonly admission: DshNativeAdmission | undefined;
  constructor(readonly client: DshClient, readonly modelConfiguration?: import('./model-config/dsh-adapter.js').DshModelConfigurationBridge, readonly authority?: DshExecutionAuthority, readonly hostCapabilities = false, readonly permissions?: DshPermissionPort) {
    this.admission = authority ? new DshNativeAdmission(authority) : undefined;
    this.providers = new RuntimeProviderService(modelConfiguration ?? client);
    this.interactions = new DshInteractions(client, async (sessionId, callId) => {
      const position = this.livePosition.get(sessionId);
      if (position && position.turn >= 0) {
        const id = turnId(sessionId, position.turn);
        return { turnId: id, itemId: callId ? this.liveTools.get(id)?.execution.toolItemId(callId) : undefined };
      }
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
      this.streamGeneration = generation;
      const readyGeneration = () => { for (const ready of this.generationWaiters) ready(); this.generationWaiters.clear(); };
      const stopGeneration = () => generation.abort();
      this.abort.signal.addEventListener("abort", stopGeneration, { once: true });
      let opened = 0;
      let recovering = !firstGeneration;
      const buffered: RecordValue[] = [];
      const onOpen = () => {
        opened += 1;
        if (opened === 2 && firstGeneration) {
          firstGeneration = false;
          onFirstReady();
          readyGeneration();
        } else if (opened === 2 && recovering) {
          void this.recoverLiveSessions(generation.signal).then(() => {
            if (generation.signal.aborted) return;
            recovering = false;
            for (const frame of buffered) this.onMuxFrame(frame);
            readyGeneration();
          }).catch(() => generation.abort());
        }
      };
      const tasks = [
        this.client.stream("/api/events.mux", (frame) => {
          const value = { ...frame.payload, rpcId: frame.rpcId };
          if (recovering) buffered.push(value); else this.onMuxFrame(value);
        }, generation.signal, onOpen),
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

  close(): void { this.admission?.failAll(new Error("Local host closed")); this.abort.abort(); this.presentation.close(); this.interactions.close(); this.liveTools.clear(); this.latestTurns.clear(); this.sinks.clear(); }

  engineUnavailable(error: Error): void {
    this.admission?.failAll(error);
    this.engineReady = false;
    for (const [id, projection] of this.liveTools) {
      for (const event of projection.execution.fail(error.message)) this.emit(event.method, event.params);
      this.completedLiveTurns.add(id);
    }
    this.liveTools.clear();
    this.livePosition.clear();
    for (const [id, summary] of this.summaries) this.summaries.set(id, { ...summary, running: false });
  }
  engineRecovered(): void { this.engineReady = true; }
  async reconnectStreams(): Promise<void> {
    if (!this.streamsStarted) return this.startStreams();
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        this.generationWaiters.delete(ready);
        this.abort.signal.removeEventListener("abort", aborted);
      };
      const ready = () => { clean(); resolve(); };
      const aborted = () => { clean(); reject(new Error("DSH host closed during reconnect")); };
      const timer = setTimeout(() => {
        clean();
        reject(new Error("Timed out reconnecting DSH event streams"));
      }, 10_000);
      this.generationWaiters.add(ready);
      this.abort.signal.addEventListener("abort", aborted, { once: true });
      if (this.abort.signal.aborted) { aborted(); return; }
      this.streamGeneration?.abort();
    });
  }

  private async recoverLiveSessions(signal: AbortSignal): Promise<void> {
    const active = [...this.livePosition.entries()];
    const summaries = await this.summariesList();
    for (const [sessionId, position] of active) {
      const summary = summaries.find(value => value.sessionId === sessionId);
      if (!summary) throw new Error("DSH session disappeared during recovery");
      const entries: DshHistoryEntry[] = [];
      let before: number | undefined;
      for (;;) {
        const page = await this.client.call<DshHistoryPage>("session.history", {
          sessionId, maxMessages: 100, ...(before === undefined ? {} : { beforeSeq: before }),
        }, signal);
        entries.unshift(...page.events.map(entry => ({ ...entry, event: this.authority?.projectInput(sessionId, entry.event) ?? entry.event })));
        if (!page.hasMore || entries.some(({ event }) => event.type === "turn/start" && object(event.data).turn === position.turn)) break;
        const next = Math.min(...page.events.map(entry => entry.event.seq));
        if (!Number.isFinite(next) || (before !== undefined && next >= before)) throw new Error("DSH recovery history made no progress");
        before = next;
      }
      if (signal.aborted) return;
      const recovered = foldEvents(sessionId, entries, summary.cwd ?? homedir()).get(position.turn);
      if (!recovered) throw new Error("DSH recovery has no active Turn evidence");
      if (!summary.running && !recovered.execution.ended) recovered.execution.fail("DSH stopped without terminal evidence");
      const turn = recovered.execution.snapshot();
      this.latestTurns.set(sessionId, recovered);
      if (recovered.execution.ended) {
        this.livePosition.delete(sessionId);
        this.liveTools.delete(turn.id);
        this.completedLiveTurns.add(turn.id);
        this.emit("turn/completed", { threadId: sessionId, turn });
      } else {
        this.liveTools.set(turn.id, recovered);
        this.emit("turn/started", { threadId: sessionId, turn });
      }
    }
  }

  private emit(method: string, params: unknown): void {
    this.presentation.emit(method, params);
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
        const clientMessageId = this.admission?.queuedClientId(sessionId, string(source.rpcId, id)) ?? string(source.rpcId, id);
        const durable = this.authority?.queueStore.findByClientId(sessionId, clientMessageId);
        const logicalId = durable?.id ?? id;
        this.nativeQueueIds.set(logicalId, id);
        return [{
          id: logicalId,
          input: userContent(message.content),
          clientUserMessageId: clientMessageId,
          createdAt: previousById.get(logicalId)?.createdAt
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
    const events = this.admission?.manages(sessionId) ? this.admission.accept(sessionId, event) : [event];
    for (const accepted of events) this.projectNativeEvent(sessionId, accepted);
  }

  private projectNativeEvent(sessionId: string, event: DshEvent): void {
    const data = object(event.data);
    const position = this.livePosition.get(sessionId) ?? { turn: -1, step: 0 };
    if (event.type === "turn/start") position.turn = number(data.turn, -1);
    if (event.type === "step/start") position.step = number(data.step, 0);
    const turn = number(data.turn, position.turn);
    if (event.type === "goal/change" && sessionId !== "") {
      const goal = projectDshGoal(sessionId, data);
      if (goal) this.emit("thread/goal/updated", { threadId: sessionId, turnId: turn < 0 ? null : turnId(sessionId, turn), goal });
      else if (data.operation === "clear") this.emit("thread/goal/cleared", { threadId: sessionId });
      return;
    }
    if (sessionId === "" || turn < 0) return;
    const appTurn = { id: turnId(sessionId, turn), items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: appTimestamp(event.time), completedAt: null, durationMs: null };
    if (this.completedLiveTurns.has(appTurn.id)) return;
    this.livePosition.set(sessionId, { ...position, turn });
    const toolScope = appTurn.id;
    let tools = this.liveTools.get(toolScope);
    if (!tools) { tools = new DshTurnProjection(sessionId, appTurn.id, this.summaries.get(sessionId)?.cwd ?? homedir()); this.liveTools.set(toolScope, tools); }
    const projection = tools.project(event);
    this.latestTurns.set(sessionId, tools);
    if (event.type === "turn/start") {
      const summary = this.summaries.get(sessionId);
      if (summary) this.summaries.set(sessionId, { ...summary, running: true });
      this.emit("turn/started", { threadId: sessionId, turn: { ...tools.execution.snapshot(), items: [], itemsView: "notLoaded" } });
      for (const resolve of this.nextTurnWaiters.get(sessionId) ?? []) resolve(turn);
      this.nextTurnWaiters.delete(sessionId);
    }
    if (event.type === "turn/end") {
      const terminal = tools.execution.snapshot();
      this.admission?.finish(sessionId, terminal.status, "nativeTurnEnded");
      this.liveTools.delete(toolScope);
    }
    for (const notification of projection.events) this.emit(notification.method, notification.params);
    if (event.type === "turn/end") {
      this.completedLiveTurns.add(appTurn.id);
      this.livePosition.delete(sessionId);
      const summary = this.summaries.get(sessionId);
      if (summary) this.summaries.set(sessionId, { ...summary, running: false, updatedAt: event.time });
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
    const native = this.queues.get(sessionId) ?? [];
    const restored = (this.authority?.queueStore.pending(sessionId) ?? []).filter(row => !native.some(item => item.clientUserMessageId === row.clientUserMessageId));
    return [...native, ...restored.map(row => ({ id: row.id, input: row.input, clientUserMessageId: row.clientUserMessageId, createdAt: row.createdAtMs, pausedReason: "restored-after-host-restart" }))];
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
    const current = this.latestTurns.get(sessionId);
    if (current?.turnId === turnId(sessionId, turn)) return { ...current.execution.snapshot(), items: [], itemsView: "notLoaded" };
    return {
      id: turnId(sessionId, turn),
      items: [],
      itemsView: "notLoaded",
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

  private async describedModel(sessionId: string, requested: unknown,
    description: { loaded?: boolean; selection?: DshSessionModels["current"] }): Promise<Pick<DshSessionModels, "current">> {
    // Product binding/explicit override, then a live native pick, then logged
    // selection and finally the declared default for a legacy blank session.
    // Never call Agent-bound session.models merely to display a cold thread.
    const explicit = decodeModel(requested);
    const native = description.loaded === true ? (await this.sessionModels(sessionId)).current : description.selection;
    if (explicit) return { current: { ...explicit,
      ...(native?.provider === explicit.provider && native?.model === explicit.model
        ? { reasoningEffort: native.reasoningEffort } : {}) } };
    return { current: native ?? await this.defaultModel() ?? undefined };
  }

  private async defaultModel(): Promise<{ provider: string; model: string } | null> {
    const settings = await (this.modelConfiguration ?? this.client).call<RuntimeSettingsDescribeResponse>("settings.describe");
    const value = object(settings.namespaces.find(entry => entry.ns === "agent-default-model")?.value);
    return typeof value.provider === "string" && value.provider !== "" && typeof value.model === "string" && value.model !== ""
      ? { provider: value.provider, model: value.model } : null;
  }

  private async assertInput(sessionId: string, input: unknown): Promise<void> {
    if (!Array.isArray(input)) throw new Error("Input must be an array");
    const current = (await this.sessionModels(sessionId)).current;
    if (!current) throw new Error("请先选择模型");
    // RuntimeProviderService is the single capability resolver: an explicit
    // native answer wins, an unknown native answer falls back to the user's
    // model declaration, and a fully unknown model remains text-only.
    const model = (await this.providers.models(true)).groups
      .find(group => group.id === current.provider)?.models.find(entry => entry.id === current.model);
    const unsupported = unsupportedModelInput(modelInputModalities(model?.input), input);
    if (unsupported) throw new Error(`所选模型不支持 ${unsupported} 输入，请更换模型或移除附件`);
  }

  private async selectModel(sessionId: string, requested: unknown, effort?: unknown): Promise<DshSessionModels> {
    const selection = decodeModel(requested);
    if (selection !== null) {
      const selectable = await this.providers.models();
      if (!selectable.groups.some(group => group.id === selection.provider && group.models.some(model => model.id === selection.model))) {
        if (this.modelConfiguration) throw new Error("所选模型已停用或不可用，请重新选择");
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
    const items = value.items.map(summary => ({ ...summary, ephemeral: this.summaries.get(summary.sessionId)?.ephemeral ?? summary.ephemeral }));
    for (const summary of items) this.summaries.set(summary.sessionId, summary);
    return items;
  }

  private async summary(sessionId: string): Promise<DshSessionSummary> {
    const known = this.summaries.get(sessionId);
    if (known) return known;
    const found = (await this.summariesList()).find((candidate) => candidate.sessionId === sessionId);
    if (!found) throw new Error(`Unknown DSH session ${sessionId}`);
    return found;
  }

  private async fullHistory(sessionId: string): Promise<TurnAccumulator[]> {
    await this.summary(sessionId);
    const events: DshHistoryEntry[] = [];
    let before: number | undefined;
    let latestProjections: DshHistoryPage["projections"];
    for (;;) {
      const page = await this.client.call<DshHistoryPage>("session.history", {
        sessionId, maxMessages: 100, ...(before === undefined ? {} : { beforeSeq: before }),
      });
      if (before === undefined) latestProjections = page.projections;
      events.unshift(...page.events);
      if (!page.hasMore) break;
      const next = Math.min(...page.events.map(entry => entry.event.seq));
      if (!Number.isFinite(next) || (before !== undefined && next >= before)) throw new Error("DSH history cursor made no progress");
      before = next;
    }
    const history = { events, projections: latestProjections };
    if (history.projections) {
      const current = await this.summary(sessionId);
      this.summaries.set(sessionId, { ...current, projections: history.projections });
    }
    const summary = await this.summary(sessionId);
    const projectedEvents = history.events.map(entry => ({ ...entry, event: this.authority?.projectInput(sessionId, entry.event) ?? entry.event }));
    const turns = mapEvents(sessionId, projectedEvents, summary.running, summary.cwd);
    {
      let current = this.latestTurns.get(sessionId);
      if (!current && summary.running) {
        const entries = [...foldEvents(sessionId, projectedEvents, summary.cwd).entries()];
        const latest = entries.at(-1);
        if (latest && !latest[1].execution.ended) {
          current = latest[1];
          this.latestTurns.set(sessionId, current);
          this.liveTools.set(current.turnId, current);
          this.livePosition.set(sessionId, { turn: latest[0], step: 0 });
        }
      }
      if (current) {
        const index = turns.findIndex(turn => turn.id === current!.turnId);
        if (index >= 0) turns[index] = current.execution.snapshot() as TurnAccumulator;
        else turns.push(current.execution.snapshot() as TurnAccumulator);
      }
    }
    return turns;
  }

  private async history(
    sessionId: string,
    cursor: unknown,
    limit: unknown,
    sortDirection: "asc" | "desc" = "desc",
    itemsView?: "full" | "notLoaded",
  ): Promise<{
    turns: TurnAccumulator[];
    pageTurns: TurnAccumulator[];
    nextCursor: string | null;
    headCursor: string | null;
  }> {
    if (sortDirection === "desc" && (cursor == null || String(cursor).includes("dsh-turns"))) {
      const count = typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
      const before = historyBoundary(sessionId, cursor);
      const window = await readTurnWindow(boundary => this.readHistoryPage(sessionId, boundary), before, count);
      const summary = await this.summary(sessionId);
      if (window.projections) this.summaries.set(sessionId, { ...summary, projections: window.projections });
      const included = new Set(window.events.filter(entry => entry.event.type === "turn/start")
        .map(entry => turnId(sessionId, number(object(entry.event.data).turn, -1))));
      const turns = mapEvents(sessionId, window.events.filter(entry => {
        const turn = object(entry.event.data).turn;
        return typeof turn !== "number" || included.has(turnId(sessionId, turn));
      }).map(entry => ({ ...entry,
        event: this.authority?.projectInput(sessionId, entry.event) ?? entry.event })), summary.running, summary.cwd)
        .filter(turn => included.has(turn.id));
      const pageTurns = [...turns].reverse().map(turn => itemsView === "notLoaded" ? { ...turn, items: [], itemsView: "notLoaded" } as unknown as TurnAccumulator : turn);
      return { turns, pageTurns, nextCursor: window.nextBefore === undefined ? null : historyCursor(sessionId, window.nextBefore),
        headCursor: turns.length ? historyCursor(sessionId, before) : null };
    }
    const turns = await this.fullHistory(sessionId);
    const thread = { id: sessionId, turns };
    const page = projectedTurnsPage(thread, {
      threadId: sessionId,
      cursor: cursor as string | null,
      limit: limit as number | null,
      sortDirection,
      ...(itemsView === undefined ? {} : { itemsView }),
    });
    return {
      turns: (sortDirection === "desc" ? [...page.data].reverse() : page.data) as unknown as TurnAccumulator[],
      pageTurns: page.data as unknown as TurnAccumulator[],
      nextCursor: page.nextCursor,
      headCursor: projectedHistoryHeadCursors(thread).turnsBackwardsCursor,
    };
  }

  private settingsWrites: Promise<unknown> = Promise.resolve();
  private async effectivePermissions(sessionId: string) {
    if (this.permissions) return projectDshPermissions(await this.permissions.read(sessionId));
    let before: number | undefined;
    let mode: unknown, approval: unknown, preset: unknown;
    for (;;) {
      const page = await this.client.call<DshHistoryPage>("session.history", { sessionId, maxMessages: 100, ...(before === undefined ? {} : { beforeSeq: before }) });
      for (const { event } of [...page.events].sort((a, b) => b.event.seq - a.event.seq)) {
        const data = object(event.data);
        if (event.type === "sandbox/mode" && mode === undefined) mode = data.mode;
        if (event.type === "approval/policy" && approval === undefined) approval = data.policy;
        if (event.type === "permission/preset" && preset === undefined) preset = data.preset;
      }
      if ((mode !== undefined && approval !== undefined) || !page.hasMore) break;
      const next = Math.min(...page.events.map(entry => entry.event.seq));
      if (!Number.isFinite(next) || (before !== undefined && next >= before)) throw new Error("Permission history made no progress");
      before = next;
    }
    return projectDshPermissions({ sandbox: { mode, workspaceRoot: (await this.summary(sessionId)).cwd },
      approval, preset: preset ?? "custom", networkPolicy: "not-managed-by-file-sandbox" });
  }
  async dispatch(method: string, params: unknown): Promise<unknown> {
    if (!this.engineReady) throw Object.assign(new Error("DSH runtime is restarting or unavailable; retry after recovery"), { rpcCode: -32001 });
    if (/^runtime\/(settings\/mutate|providers\/(apply|setEnabled)|models\/(setEnabled|delete))$/.test(method)) {
      const next = this.settingsWrites.then(() => this.dispatchCommand(method, params));
      this.settingsWrites = next.catch(() => {});
      return next;
    }
    return this.dispatchCommand(method, params);
  }
  async dispatchOwned(method: string, params: unknown, owner: DshExecutionOwner, requestId: string | number): Promise<unknown> {
    if (!this.authority || !this.admission) return this.dispatch(method, params);
    if (!this.engineReady) throw new Error("DSH runtime is unavailable");
    const value = object(params);
    const sessionId = string(value.threadId);
    if (method === "thread/resume") {
      const result = await this.dispatch(method, params);
      this.admission.reconnect(sessionId, owner);
      return result;
    }
    if (method === "turn/start") {
      await this.ensureRuntime(sessionId);
      const pending = this.admission.begin(sessionId, owner, requestId, string(value.clientUserMessageId) || undefined);
      try {
        if (value.sandboxPolicy != null || value.approvalPolicy != null) throw new Error("Use a runtime-supported named permission profile; arbitrary policy overrides are not supported");
        if (typeof value.permissions === "string") {
          if (!this.permissions) throw new Error("Runtime permission changes are unavailable");
          await this.permissions.set(sessionId, value.permissions);
        }
        if (this.modelConfiguration) {
          await this.modelConfiguration.config.synchronize();
          if (this.modelConfiguration.config.application.state !== "applied") throw new Error("模型配置尚未应用");
        }
        const content = await promptContent(value.input);
        await this.selectModel(sessionId, value.model, value.effort);
        await this.client.call("session.prompt", {
          sessionId, mode: "queue", content, clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }, undefined, pending.rpcId);
        const turn = await pending.started;
        return { turn: this.inProgressTurn(sessionId, turn) };
      } catch (cause) {
        pending.cancel(cause instanceof Error ? cause : new Error(String(cause)));
        throw cause;
      }
    }
    if (method === "turn/interrupt" || method === "turn/steer") {
      this.authority.assertOwner(sessionId, owner, string(value.turnId ?? value.expectedTurnId) || undefined);
      const result = await this.dispatch(method, params);
      if (method === "turn/interrupt") this.admission.finish(sessionId, "interrupted", "userInterrupted");
      return result;
    }
    if (/^thread\/queue\/(add|update|delete|reorder|start|steer)$/.test(method)) {
      return this.authority.withWriteLease(sessionId, owner, async () => {
        const restored = this.authority!.queueStore.find(sessionId, string(value.queuedSubmissionId));
        if (restored?.state === "queued" && !(this.queues.get(sessionId) ?? []).some(item => item.clientUserMessageId === restored.clientUserMessageId)) {
          if (method === "thread/queue/delete") return { deleted: this.authority!.queueStore.delete(sessionId, restored.id) };
          if (method === "thread/queue/update") {
            if (!Array.isArray(value.input)) throw new Error("Queue input must be an array");
            const row = this.authority!.queueStore.update(sessionId, restored.id, value.input);
            return { queuedSubmission: { id: row.id, input: row.input, clientUserMessageId: row.clientUserMessageId } };
          }
          if (method === "thread/queue/start") {
            const result = await this.dispatchOwned("turn/start", { threadId: sessionId, input: restored.input, clientUserMessageId: restored.clientUserMessageId }, owner, requestId);
            this.authority!.queueStore.markDispatched(sessionId, restored.id);
            this.admission!.removeQueuedMessage(sessionId, restored.clientUserMessageId);
            this.emit("thread/queue/changed", { threadId: sessionId });
            return result;
          }
        }
        if (method === "thread/queue/delete") {
          const prior = this.queue(sessionId).find(item => item.id === value.queuedSubmissionId);
          const result = await this.dispatch(method, params);
          const row = prior ? this.authority!.queueStore.findByClientId(sessionId, prior.clientUserMessageId) : null;
          if (row) this.authority!.queueStore.delete(sessionId, row.id);
          if (prior) this.admission!.removeQueuedMessage(sessionId, prior.clientUserMessageId);
          return result;
        }
        if (method === "thread/queue/update") {
          const prior = this.queue(sessionId).find(item => item.id === value.queuedSubmissionId);
          const result = await this.dispatch(method, params);
          const row = prior ? this.authority!.queueStore.findByClientId(sessionId, prior.clientUserMessageId) : null;
          if (row) this.authority!.queueStore.update(sessionId, row.id, value.input as unknown[]);
          return result;
        }
        if (method === "thread/queue/start" || method === "thread/queue/steer") {
          const prior = this.queue(sessionId).find(item => item.id === value.queuedSubmissionId) ?? this.queue(sessionId)[0];
          const result = await this.dispatch(method, params);
          if (prior) {
            const row = this.authority!.queueStore.findByClientId(sessionId, prior.clientUserMessageId);
            if (row) this.authority!.queueStore.markDispatched(sessionId, row.id);
            this.admission!.removeQueuedMessage(sessionId, prior.clientUserMessageId);
          }
          return result;
        }
        if (method !== "thread/queue/add") return this.dispatch(method, params);
        const messageId = string(value.clientUserMessageId);
        if (!messageId) throw new Error("Queued submissions require clientUserMessageId");
        if (!Array.isArray(value.input)) throw new Error("Queued input must be an array");
        const durable = this.authority!.queueStore.add(sessionId, messageId, owner.identity.id, value.input);
        if (!durable.created) return { queuedSubmission: { id: durable.submission.id, input: durable.submission.input, clientUserMessageId: messageId } };
        const rpcId = this.admission!.reserveQueued(sessionId, owner, requestId, messageId);
        try { return await this.dispatchCommand(method, { ...value, nativeQueueRpcId: rpcId }); }
        catch (error) {
          // Preserve unknown dispatch outcomes. A later native echo or history
          // read retires the durable row; never retry inference implicitly.
          throw error;
        }
      });
    }
    return this.dispatch(method, params);
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
      case "runtime/diagnostics/read": return {
        presentation: this.presentation.diagnostics(),
        executions: [...this.latestTurns].map(([threadId, projection]) => ({ threadId, ...projection.execution.telemetry.snapshot() })),
      };
      case "runtime/settings/describe":
        return (this.modelConfiguration ?? this.client).call("settings.describe");
      case "runtime/settings/mutate":
        if (value.ns === "llm-pi-ai") throw new Error("Use runtime provider/model commands to change model configuration");
        if (value.ns === "agent-default-model") {
          const settings = await (this.modelConfiguration ?? this.client).call<RuntimeSettingsDescribeResponse>("settings.describe");
          const next = { ...object(settings.namespaces.find(entry => entry.ns === value.ns)?.value) };
          if (!Array.isArray(value.ops)) throw new Error("Invalid default model settings");
          for (const operation of value.ops) {
            const op = object(operation);
            if (!Array.isArray(op.path) || op.path.length !== 1 || typeof op.path[0] !== "string") throw new Error("Invalid default model path");
            if (op.op === "unset") delete next[op.path[0]];
            else next[op.path[0]] = op.value;
          }
          const cleared = this.modelConfiguration && !Object.hasOwn(next, "provider") && !Object.hasOwn(next, "model") && !Object.hasOwn(next, "reasoningEffort");
          if (!cleared) {
            const catalog = await this.providers.models();
            const model = catalog.groups.find(group => group.id === next.provider)?.models.find(model => model.id === next.model);
            if (!model) throw new Error("Default model must be enabled and available");
            if (Object.hasOwn(next, "reasoningEffort") && !model.reasoning?.efforts.some(effort => effort.id === next.reasoningEffort))
              throw new Error(`Model does not support reasoning effort ${String(next.reasoningEffort)}`);
          }
        }
        return (this.modelConfiguration ?? this.client).call("settings.mutate", value);
      case "runtime/credentials/describe":
        return (this.modelConfiguration ?? this.client).call("credentials.describe", value);
      case "runtime/credentials/set":
        return (this.modelConfiguration ?? this.client).call("credentials.set", value);
      case "runtime/credentials/unset":
        return (this.modelConfiguration ?? this.client).call("credentials.unset", value);
      case "runtime/providers/list":
        { const result=await this.providers.list();return {...result,providers:result.providers.map(p=>({...p,...(p.configuration?{configuration:{...p.configuration,canCheckSaved:!!this.modelConfiguration}}:{})})),...(this.modelConfiguration?{application:this.modelConfiguration.config.application}:{})}; }
      case "runtime/providers/reapply":
        return this.modelConfiguration ? this.modelConfiguration.config.synchronize(true) : null;
      case "runtime/providers/apply":
        return this.providers.apply(params as RuntimeProviderApplyParams);
      case "runtime/providers/setEnabled":
        return this.providers.setEnabled(params as RuntimeProviderSetEnabledParams);
      case "runtime/providers/delete":
        return this.providers.remove(params as Omit<RuntimeProviderSetEnabledParams, "enabled">);
      case "runtime/models/list":
        return this.providers.models(value.includeDisabled === true);
      case "runtime/models/setEnabled":
        if (typeof value.enabled !== "boolean") throw new Error("Invalid model enabled state");
        return this.providers.mutateModel(params as RuntimeModelMutationParams, value.enabled);
      case "runtime/models/delete":
        return this.providers.mutateModel(params as RuntimeModelMutationParams);
      case "runtime/models/discover":
        return this.providers.discover(params as RuntimeModelsDiscoverParams);
      case "runtime/models/probe":
        return this.providers.probe(params as RuntimeModelProbeParams);
      case "runtime/models/check": {
        if(!this.modelConfiguration)throw new Error("当前运行时不支持已保存连接检查");
        const config=this.modelConfiguration.config;
        return checkSavedModel(params as import('@opencraft/appserver-protocol').RuntimeSavedModelCheckParams,{
          read:()=>config.repository.read(),credential:async ref=>(await config.credentials.resolve(ref))??process.env[ref],
        });
      }
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
              "opencraft/thread-lifecycle": { version: 1, fork: this.threadEngine !== null, ephemeral: this.threadEngine !== null, injectItems: this.threadEngine !== null, rename: true, archive: true, unsubscribe: true },
              ...(this.hostCapabilities ? { "opencraft/host-capabilities": { version: 1 } } : {}),
              "opencraft/loopback-http": { version: 1 },
              [OPENCRAFT_PROFILE_SKILLS_EXTENSION]: OPENCRAFT_LOCAL_DSH_SKILLS_CAPABILITY,
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
      case "thread/list": {
        const all = (await this.summariesList()).filter((entry) => !entry.blank).map((entry) => makeThread(entry));
        const sorted = all.sort((left, right) => number(right.updatedAt) - number(left.updatedAt));
        return page(sorted, value.cursor, value.limit);
      }
      case "thread/read": {
        const sessionId = string(value.threadId);
        const summary = await this.summary(sessionId);
        const turns = value.includeTurns === true ? await this.fullHistory(sessionId) : [];
        return { thread: makeThread(summary, turns) };
      }
      case "thread/resume": {
        const sessionId = string(value.threadId);
        const description = this.threadEngine?.describe ? await this.threadEngine.describe({ sessionId }) : null;
        if (!description) {
          await this.ensureRuntime(sessionId);
          if (value.model !== undefined) await this.selectModel(sessionId, value.model);
        }
        const initialTurnsRequest = typeof value.initialTurnsPage === "object"
          && value.initialTurnsPage !== null
          && !Array.isArray(value.initialTurnsPage)
          ? value.initialTurnsPage as RecordValue
          : null;
        const sortDirection = initialTurnsRequest?.sortDirection === "asc" ? "asc" : "desc";
        const itemsView = initialTurnsRequest?.itemsView === "notLoaded" ? "notLoaded" : "full";
        const requestedLimit = typeof initialTurnsRequest?.limit === "number"
          ? initialTurnsRequest.limit
          : 5;
        const [summary, history, models] = await Promise.all([
          this.summary(sessionId),
          this.history(sessionId, null, requestedLimit, sortDirection, itemsView),
          description ? this.describedModel(sessionId, value.model, description) : this.sessionModels(sessionId),
        ]);
        const includeThreadTurns = value.excludeTurns !== true;
        const thread = makeThread(summary, includeThreadTurns ? history.turns : []);
        const permissionState = description ? projectDshPermissions(description.permissions) : await this.effectivePermissions(sessionId);
        const model = models.current ? encodeModel(models.current.provider, models.current.model) : "";
        return {
          thread, cwd: thread.cwd, model, modelProvider: "dsh", serviceTier: null,
          reasoningEffort: models.current?.reasoningEffort ?? null,
          approvalsReviewer: "user", instructionSources: [], runtimeWorkspaceRoots: [thread.cwd],
          multiAgentMode: "explicitRequestOnly",
          initialTurnsPage: initialTurnsRequest !== null
            ? { data: history.pageTurns, nextCursor: history.nextCursor, backwardsCursor: null, itemsPaginationByTurnId: {} }
            : null,
          turnsBackwardsCursor: !includeThreadTurns && initialTurnsRequest === null
            ? history.headCursor
            : history.nextCursor,
          itemsBackwardsCursor: null,
          ...permissionState,
        };
      }
      case "thread/turns/list":
      case "thread/items/list": {
        const threadId = string(value.threadId);
        if (method === "thread/turns/list" && value.sortDirection !== "asc" && (value.cursor == null || String(value.cursor).includes("dsh-turns"))) {
          const result = await this.history(threadId, value.cursor, value.limit, "desc", value.itemsView as "full" | "notLoaded");
          return { data: result.pageTurns, nextCursor: result.nextCursor, backwardsCursor: null, itemsPaginationByTurnId: {} };
        }
        if (method === "thread/items/list" && typeof value.turnId === "string") {
          const turns = await this.readTurn(threadId, value.turnId);
          return projectedItemsPage({ id: threadId, turns }, { ...value, threadId });
        }
        const turns = await this.fullHistory(threadId);
        const params = { ...value, threadId };
        return method === "thread/items/list"
          ? projectedItemsPage({ id: threadId, turns }, params)
          : { ...projectedTurnsPage({ id: threadId, turns }, params), itemsPaginationByTurnId: {} };
      }
      case "thread/queue/list":
        return page(this.queue(string(value.threadId)), value.cursor, value.limit);
      case "thread/queue/add": {
        const sessionId = string(value.threadId);
        const clientUserMessageId = string(value.clientUserMessageId);
        if (clientUserMessageId === "") throw new Error("Queued submissions require clientUserMessageId");
        await this.assertInput(sessionId, value.input);
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
            string(value.nativeQueueRpcId) || clientUserMessageId,
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
        await this.assertInput(sessionId, value.input);
        const content = await promptContent(value.input);
        const input = userContent(content);
        await this.client.call("session.updateQueue", {
          sessionId,
          itemId: this.nativeQueueIds.get(queuedSubmissionId) ?? queuedSubmissionId,
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
          itemId: this.nativeQueueIds.get(queuedSubmissionId) ?? queuedSubmissionId,
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
                itemId: this.nativeQueueIds.get(target.id) ?? target.id,
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
              itemId: this.nativeQueueIds.get(queuedSubmissionId) ?? queuedSubmissionId,
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
      case "thread/fork": {
        if (!this.threadEngine) throw new Error("This engine does not expose native thread forks");
        if (value.path) throw new Error("Use a thread identity, not a backend-owned rollout path");
        const sourceId = string(value.threadId);
        await this.ensureRuntime(sourceId);
        const source = await this.summary(sourceId);
        const sourceModel = (await this.sessionModels(sourceId)).current;
        const selection = decodeModel(value.model) ?? sourceModel;
        const boundary = (id: unknown): number | undefined => {
          if (id == null) return undefined;
          const prefix = `dsh-turn-${sourceId}-`;
          if (typeof id !== "string" || !id.startsWith(prefix) || !/^\d+$/.test(id.slice(prefix.length))) throw new Error("Fork turn belongs to another thread");
          return Number(id.slice(prefix.length));
        };
        const created = await this.threadEngine.fork({ sourceSessionId: sourceId,
          cwd: typeof value.cwd === "string" ? value.cwd : source.cwd ?? homedir(),
          ephemeral: value.ephemeral === true, developerInstructions: value.developerInstructions,
          provider: selection?.provider, model: selection?.model,
          lastTurn: boundary(value.lastTurnId), beforeTurn: boundary(value.beforeTurnId),
          permissionPreset: value.permissions,
        });
        this.summaries.set(created.sessionId, { sessionId: created.sessionId, updatedAt: Date.now(), running: false, blank: false,
          cwd: created.cwd, agentPreset: created.agentPreset, parentSessionId: sourceId, ephemeral: created.ephemeral === true });
        try {
          const effort = object(value.config).model_reasoning_effort
            ?? (selection?.provider === sourceModel?.provider && selection?.model === sourceModel?.model ? sourceModel?.reasoningEffort : undefined);
          if (selection) await this.selectModel(created.sessionId, encodeModel(selection.provider, selection.model), effort);
          return await this.dispatchCommand("thread/resume", { threadId: created.sessionId,
            ...(selection ? { model: encodeModel(selection.provider, selection.model) } : {}),
            excludeTurns: value.excludeTurns === true });
        } catch (error) {
          try { await this.threadEngine.release({ sessionId: created.sessionId }); } catch { /* Native owner still owns the failed child's teardown. */ }
          throw error;
        }
      }
      case "thread/inject_items": {
        if (!this.threadEngine) throw new Error("This engine does not expose canonical history injection");
        await this.ensureRuntime(string(value.threadId));
        if (!Array.isArray(value.items)) throw new Error("History items must be an array");
        return this.threadEngine.inject({ sessionId: string(value.threadId), items: value.items });
      }
      case "thread/start": {
        const selection = value.model == null || value.model === "" ? await this.defaultModel() : decodeModel(value.model);
        if (!selection) throw new Error("请先选择模型或在设置中指定默认模型");
        const selectedModel = encodeModel(selection.provider, selection.model);
        const catalog = await this.providers.models();
        if (!catalog.groups.some(group => group.id === selection.provider && group.models.some(model => model.id === selection.model)))
          throw new Error("所选模型已停用或不可用，请重新选择");
        const creation = {
          ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
          ...(typeof value.agentId === "string" && value.agentId !== "dsh" ? { agentPreset: value.agentId } : {}),
          ...(this.threadEngine ? { ...selection, ephemeral: value.ephemeral === true, developerInstructions: value.developerInstructions } : {}),
        };
        const created = this.threadEngine ? await this.threadEngine.create(creation)
          : await this.client.call<{ sessionId: string; agentPreset?: string }>("session.create", creation);
        const models = await this.selectModel(created.sessionId, selectedModel);
        if (!models.current) throw new Error("Engine did not acknowledge the selected model");
        const currentModel = encodeModel(models.current.provider, models.current.model);
        const summary: DshSessionSummary = { sessionId: created.sessionId, updatedAt: Date.now(), running: false, blank: true, cwd: created.cwd ?? string(value.cwd, homedir()), agentPreset: created.agentPreset, ephemeral: created.ephemeral === true };
        this.summaries.set(summary.sessionId, summary);
        const thread = makeThread(summary);
        const permissionState = await this.effectivePermissions(summary.sessionId);
        return {
          thread, model: currentModel, modelProvider: "dsh", serviceTier: null, cwd: thread.cwd, runtimeWorkspaceRoots: [thread.cwd], instructionSources: [],
          approvalsReviewer: "user",
          reasoningEffort: null, multiAgentMode: "explicitRequestOnly", ...permissionState,
        };
      }
      case "turn/start": {
        await this.ensureRuntime(string(value.threadId));
        if (this.modelConfiguration) {
          await this.modelConfiguration.config.synchronize();
          if (this.modelConfiguration.config.application.state !== "applied") throw new Error("模型配置尚未应用，请检查配置后重试");
        }
        const sessionId = string(value.threadId);
        await this.selectModel(sessionId, value.model, value.effort);
        await this.assertInput(sessionId, value.input);
        const content = await promptContent(value.input);
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
        if (liveTurn < 0) throw new Error("DSH thread has no active turn");
        if (liveTurn >= 0 && expectedTurnId !== turnId(sessionId, liveTurn)) {
          throw new Error(`Active DSH turn changed; expected ${expectedTurnId}`);
        }
        const clientUserMessageId = string(value.clientUserMessageId);
        await this.assertInput(sessionId, value.input);
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
      case "turn/interrupt": {
        const sessionId = string(value.threadId);
        const position = this.livePosition.get(sessionId);
        if (!position) throw new Error("DSH thread has no active turn");
        const id = turnId(sessionId, position.turn);
        if (value.turnId && value.turnId !== id) throw new Error("DSH active turn changed");
        const projection = this.liveTools.get(id);
        if (!projection) throw new Error("DSH active turn projection is unavailable");
        // Settle local authority before the engine cancellation round trip.
        for (const event of projection.execution.interrupt()) this.emit(event.method, event.params);
        this.completedLiveTurns.add(id);
        this.liveTools.delete(id);
        this.livePosition.delete(sessionId);
        const summary = this.summaries.get(sessionId);
        if (summary) this.summaries.set(sessionId, { ...summary, running: false });
        await this.client.call("session.cancel", { sessionId });
        return {};
      }
      case "model/list": {
        const [catalog, selection] = await Promise.all([this.providers.models(), this.defaultModel()]);
        return page(mapModels(catalog, selection ?? undefined), value.cursor, value.limit);
      }
      case "permissionProfile/list": {
        if (!this.permissions) return { data: [], nextCursor: null };
        const value = await this.permissions.read();
        return { data: value.presets.map((preset: any) => ({ id: preset.id, label: preset.name, description: preset.description ?? "", allowed: true })), nextCursor: null };
      }
      case "skills/list": throw new Error("Scoped skills require the connected host capability metadata service");
      default: throw new Error(`Method not supported by OpenCraft DSH host: ${method}`);
    }
  }
}
