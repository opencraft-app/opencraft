import { createImplementation as turnManagerImplementation } from "./hypernode/turn-manager.js";
import { createImplementation as toolImplementation } from "./hypernode/tool-projection.js";
import { createImplementation as engineImplementation } from "./hypernode/engine-core.js";
import { classifyDshCommand } from "./dsh-command-actions.js";
import type { DshEvent } from "./dsh-client.js";
import { userContent } from "./dsh-content.js";
import { DshExecutionTelemetry } from "./dsh-execution-telemetry.js";
type Value = Record<string, any>;
class LocalService { constructor(readonly ctx: Value) {} }

function hasCompletedAssistantActivity(record: Value): boolean {
  return record.itemLedger.some((item: Value) => {
    if (item.type === "agentMessage") {
      return item.phase === "commentary"
        && typeof item.text === "string"
        && item.text.trim().length > 0;
    }
    if (item.type === "dynamicToolCall" || item.type === "commandExecution") {
      return item.status === "completed" || item.status === "failed";
    }
    return false;
  });
}

/** Local ports for the imported HyperNode engine/TurnManager/tool projection.
 * Native ledger sequence supplies repeatable identity and time during replay.
 * There is no remote tenancy, SSH worker or asynchronous delta queue here.
 */
export class DshExecutionRecord {
  private now = 0;
  private seq = 0;
  private allocation = 0;
  private seen = new Set<number>();
  private readonly ctx: Value;
  private readonly core: Value;
  private readonly worker: Value;
  readonly record: Value;
  readonly telemetry = new DshExecutionTelemetry();
  private output: Array<{ method: string; params: Value }> = [];
  constructor(readonly sessionId: string, readonly turnId: string, cwd: string) {
    const clock = { now: () => this.now };
    const TurnManager = turnManagerImplementation(LocalService, () => `${turnId}:item:${this.seq}:${this.allocation++}`, clock);
    const Tools = toolImplementation(LocalService, undefined, clock);
    const ImportedCore = engineImplementation(clock, (_span: unknown, name: string) => this.telemetry.milestone(name), (_span: unknown, status: string) => this.telemetry.end(status));
    class Core extends ImportedCore {
      processSessionEvent(worker: Value, active: Value, message: Value) {
        const event = message.event;
        const activityOnlyCompletion = event?.type === "turn/end"
          && event.data?.reason?.kind === "completed"
          && active.assistantStream == null
          && active.pendingAssistantCompletion == null
          && hasCompletedAssistantActivity(active.record);
        if (!activityOnlyCompletion) {
          return super.processSessionEvent(worker, active, message);
        }

        // Codex models final_answer as an optional Item. A Turn whose visible
        // commentary/tool activity is already settled may complete without
        // manufacturing an answer. Truly empty completions continue through
        // the imported fail-closed invariant.
        this.ctx.dshAppServerProjection?.settle(worker, active);
        this.completeWorkerTurn(worker);
      }
    }
    const thread: Value = { id: sessionId };
    this.ctx = {
      threadManager: { get: () => thread, changed: () => {}, persistThread: () => {} },
      threadExecution: { complete: () => {}, abortRequest: () => {} },
      stopWorker: () => {},
      shellCommandClassifier: { classify: (command: string, options: Value) => classifyDshCommand(command, options.cwd) },
      appServer: { broadcastNotification: (method: string, params: Value) => this.notify(method, params) },
      appServerProjection: { broadcast: (method: string, params: Value) => this.notify(method, params) },
      textDeltaPacer: {
        enqueue: (metadata: Value, delta: string) => this.notify("item/agentMessage/delta", { ...metadata, delta }),
        afterDrained: (_metadata: Value, continuation: () => void) => continuation(),
        flush: () => {},
      },
    };
    this.ctx.turnManager = new TurnManager(this.ctx);
    this.ctx.dshAppServerProjection = new Tools(this.ctx);
    const items: Value[] = [];
    this.record = { threadId: sessionId, startedAtMs: 0, userItem: null, itemLedger: items,
      turn: { id: turnId, items, itemsView: "full", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } };
    const active: Value = { record: this.record, connection: {}, requestId: turnId,
      pendingUserInputs: [], deferredMessages: [], completed: false,
      telemetry: { span: { handle: turnId }, eventCount: 0, reasoningDeltaCount: 0, textDeltaCount: 0 } };
    this.worker = { threadId: sessionId, active, lifecycle: "running", stderr: [] };
    this.ctx.dshAppServerProjection.begin(active, { cwd });
    this.core = new Core(this.ctx);
    this.core.workers.set(sessionId, this.worker);
  }
  private notify(method: string, params: Value) {
    const manager = this.ctx.turnManager;
    if (params.item) {
      const existing = this.record.itemLedger.find((item: Value) => item.id === params.item.id);
      if (existing) Object.assign(existing, params.item);
      else manager.appendItem(this.record, params.item);
    }
    const item = this.record.itemLedger.find((entry: Value) => entry.id === params.itemId);
    if (item && method === "item/agentMessage/delta") item.text = (item.text ?? "") + params.delta;
    if (item && method === "item/reasoning/textDelta") {
      const index = params.contentIndex ?? 0;
      item.content[index] = (item.content[index] ?? "") + params.delta;
    }
    if (method === "turn/plan/updated") manager.appendItem(this.record, {
      id: `${this.turnId}:plan:${this.seq}`, type: "todo-list", explanation: params.explanation, plan: params.plan,
    });
    this.output.push({ method, params: structuredClone(params) });
  }
  get ended() { return this.worker.active === null; }
  toolItemId(callId: string): string | undefined { return this.worker.active?.dshProjection?.calls.get(callId)?.item.id; }
  project(event: DshEvent) {
    this.output = [];
    if (this.ended || this.seen.has(event.seq)) return this.output;
    this.seen.add(event.seq);
    this.seq = event.seq;
    this.allocation = 0;
    this.now = event.time;
    if (this.record.turn.startedAt === null || event.type === "turn/start") {
      this.record.startedAtMs = this.now;
      this.record.turn.startedAt = Math.floor(this.now / 1000);
    }
    const data = (event.data ?? {}) as Value;
    this.telemetry.observe(event.type, event.seq, data.chunk?.type);
    const telemetry = this.worker.active.telemetry;
    telemetry.eventCount++;
    if (data.chunk?.type === "text-delta") telemetry.textDeltaCount++;
    if (data.chunk?.type === "reasoning-delta") telemetry.reasoningDeltaCount++;
    if (event.type === "user/message") {
      if (!["user", "human"].includes(data.source?.kind)) return this.output;
      this.worker.active.pendingUserInputs.push({ input: userContent(data.content), clientId: data.source?.rpcId ?? null, projected: false });
    }
    this.core.processSessionEvent(this.worker, this.worker.active, { event });
    return this.output;
  }
  interrupt(time = Date.now()) {
    this.output = [];
    this.now = time;
    this.core.interruptWorkerTurn(this.worker);
    return this.output;
  }
  fail(message: string, time = Date.now()) {
    this.output = [];
    this.now = time;
    this.core.failWorker(this.worker, message);
    return this.output;
  }
  snapshot() { return structuredClone(this.record.turn); }
}
