import { assertModelPolicy, ModelPolicyError } from '@opencraft/model-usage-policy/native';
import { queueProjection, type PiQueuedInput } from "./queue.js";
import { createPiTranscriptCache, readPiSnapshot } from "./read-history.js";
import { nodeObserver } from "../../../packages/observability-contract/node.mjs";
import { InterruptedTurnRecovery } from "@opencraft/host-recovery";
import { TURN_RECOVERY_EXTENSION } from "@opencraft/appserver-protocol";
import type { SessionCapabilityPort } from "@opencraft/session-capabilities";
import type { HostInputPort } from "@opencraft/appserver-protocol/host-inputs";
import { ConversationSchedules, ScheduleFault, type ScheduleExecutionPort } from "@opencraft/host-schedules";
import { OPENCRAFT_PERMISSION_MODES_EXTENSION, OPENCRAFT_PERMISSION_MODES_CAPABILITY, CONVERSATION_SCHEDULES_EXTENSION } from "@opencraft/appserver-protocol";
import { AppServerRpcError, projectedTurnsPage, projectedItemsPage, projectedHistoryHeadCursors } from "@opencraft/appserver-client";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { PiDurableSession, createPiModels, type PiSnapshot, type PiForkContext } from "./session.js";
import { assertPiFields, compareThreads, fullAccessProfile, piModel, selection, thinking, workspace } from "./contract.js";
import { compilePiInput } from "./input.js";
import { piSkillCatalog, validatePiSkillInput } from "./skills.js";
import { projectPiSnapshot, tokenUsage, textOf, type PiTurn } from "./projection.js";
import type { ExecutionEngineClient as EngineClient, AgentOrchestrationPort } from "@opencraft/appserver-client";
export { piModel } from "./contract.js";

type Value = Record<string, any>;
/** Stop and receipt acknowledgement cannot create new execution. */
export const piHandoffReconciliation = (method: string) => ["turn/interrupt", "opencraft/orchestration/ack"].includes(method);
export interface PiModelConfiguration {
  synchronize(): Promise<void>;
  defaults(): {model: string | null; effort?: string};
  writeDefaults(value: {model: string | null; effort?: string}): Promise<void>;
}
interface Session {
  format: "pi-durable-1"; id: string; cwd: string; model: string; name: string | null; preview: string;
  createdAt: number; updatedAt: number; archived: boolean; projectId?: string | null; pendingRecovery?: boolean; tools: Value[];
  threadSource?: Value | null; sessionStartSource?: Value | string | null;
  ephemeral?: boolean; forkedFromId?: string; inherited?: PiForkContext; pinned?: boolean; pinnedAt?: number;
  hostTools?: Value[];
  native?: PiDurableSession; starting?: Promise<PiDurableSession>; owner?: EngineClient; lease?: AbortController;
  active?: PiTurn; turns?: PiTurn[]; snapshot?: PiSnapshot; effort?: string; failed?: boolean;
  needsResume?: boolean;
  orchestrationOperation?: { id: string; fingerprint: string; state: "prepared" | "created" };
}
class ScheduleAdmissionDeferred extends Error {}
const seconds = () => Math.floor(Date.now() / 1000);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const identity = (tool: Value) => JSON.stringify([tool.namespace, tool.name]);
const sortedTools = (tools: Value[]) => [...tools].sort((a,b) => identity(a).localeCompare(identity(b)));
export function flattenPiTools(specs: Value[], previous: Value[] = []): Value[] {
  const tools = specs.flatMap(spec => spec.type === "namespace" ? spec.tools.map((tool: Value) => ({ ...tool, namespace: spec.name })) : [{ ...spec, namespace: null }]);
  const names = new Set<string>(), aliases = new Set(previous.map(tool => tool.piName));
  let index = 0;
  return tools.map(tool => {
    if (typeof tool.name !== "string" || !tool.inputSchema || typeof tool.inputSchema !== "object") throw new Error("Invalid platform tool declaration");
    const key = identity(tool);
    if (names.has(key)) throw new Error("Duplicate platform tool declaration"); names.add(key);
    let piName = previous.find(old => identity(old) === key)?.piName;
    if (!piName) { do { piName = `opencraft_${index++}_${tool.name.replace(/[^a-zA-Z0-9_]/gu, "_")}`; } while (aliases.has(piName)); }
    aliases.add(piName); return { ...tool, piName };
  });
}

/** Host routing metadata is separate from native durable execution and presentation state. */
export class PiEngine {
  readonly id = "pi";
  readonly label = "Pi Coding Agent";
  readonly threadPrefix = "pi_";
  readonly modelPrefix = "pi:";
  private readonly capabilities = Object.freeze({
    "opencraft/read-history": { version: 1, initialTurnsPage: true },
    "opencraft/thread-lifecycle": { version: 1, fork: false, ephemeralFork: true, ephemeral: true, injectItems: true, rename: true, archive: true, unsubscribe: true, pin: true },
    "opencraft/host-capabilities": { version: 1 },
    "opencraft/pi-shell": { version: 1, extension: "pi-interactive-shell", extensionVersion: "0.17.1", dispatch: true, monitor: true, input: true, yieldingBash: true, foregroundTui: false },
    "opencraft/scoped-model-catalog": { version: 1 },
    "opencraft/resume-history": { version: 1, mode: "paginated", initialTurnsPage: true },
    [OPENCRAFT_PERMISSION_MODES_EXTENSION]: OPENCRAFT_PERMISSION_MODES_CAPABILITY,
    [CONVERSATION_SCHEDULES_EXTENSION]: { version: 1, target: "existing-thread", repeat: "fixed-interval", summary: true, calendar: true },
    "opencraft/thread-follow-up": { version: 1, queue: true, steer: true },
    "opencraft/thread-queue": { version: 2, reorder: true, atomicSteer: true, perItemPause: false },
    [TURN_RECOVERY_EXTENSION]: { version: 1 },
  });
  get extensions() { return { ...this.capabilities, ...(this.orchestration ? {
    "opencraft/thread-orchestration": { version: 1, driver: "pi", callbackReplay: true },
  } : {}) }; }
  private orchestration?: AgentOrchestrationPort;
  readonly orchestrationIncarnation = randomUUID();
  private readonly orchestrationCreates = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  setOrchestration(port: AgentOrchestrationPort): void {
    if (this.orchestration || [...this.sessions.values()].some(session => session.native || session.starting))
      throw new Error("Pi orchestration must be configured before native execution starts");
    this.orchestration = port;
  }
  private scheduleService?: ConversationSchedules;
  private recovery?: InterruptedTurnRecovery;
  get storageOutcomes(): readonly unknown[] { return [
    ...(this.scheduleService ? [{ name: "pi-conversation-schedules", outcome: this.scheduleService.outcome }] : []),
    ...(this.recovery ? [{ name: "pi-interrupted-turn-recovery", outcome: this.recovery.outcome }] : []),
  ]; }
  private permissionProfiles() { return [{ id: fullAccessProfile, description: "Pi Full access", allowed: true, openCraftMode: "full" as const, openCraftLabel: "Full access" }]; }
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(method: string, params: Value) => void>();
  private loading?: Promise<void>;
  private closed = false;
  private catalogUnknown = false;
  private readonly admissionOpen = () => !this.closed && (this.options.admission?.open() ?? true);
  private admit<T>(operation: () => Promise<T>, reconciliation = false): Promise<T> {
    return this.options.admission ? this.options.admission.run(operation, reconciliation) : operation();
  }
  private readonly writes = new Map<string, Promise<void>>();
  private latestPinAt = 0;
  private readonly queueDrains = new Set<string>();
  private readonly queueOwners = new Map<string, EngineClient>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly historyReaders = new Map<EngineClient, Set<AbortController>>();
  private readonly modelsRuntime: ReturnType<typeof createPiModels>;
  private resolvedModels?: Awaited<ReturnType<typeof createPiModels>>;
  private readonly transcriptCache: ReturnType<typeof createPiTranscriptCache>;
  constructor(private readonly options: {
    modelPolicyPath?: string; dataDirectory?: string; directory: string; cwd: string; modelDirectory?: string; models?: Awaited<ReturnType<typeof createPiModels>>; configuration?: PiModelConfiguration; sessionCapabilities?: SessionCapabilityPort; attachmentDirectory?: string; admission?: { open(): boolean; run<T>(operation: () => Promise<T>, reconciliation?: boolean): Promise<T> } }) {
    nodeObserver("pi", { processResources: false });
    this.modelsRuntime = (options.models ? Promise.resolve(options.models) : createPiModels(options.modelDirectory ?? options.directory))
      .then(models => { this.resolvedModels = models; return models; });
    this.transcriptCache = createPiTranscriptCache({
      dataDirectory: options.dataDirectory ?? options.directory, directory: options.directory,
      readThread: async id => this.thread(await this.session(id)) as any,
      readTurns: async (id, signal) => this.readHistory(await this.session(id), signal),
    });
  }
  private compileInput(input: Value[], additionalContext: Value | null | undefined, cwd: string, model: Value) {
    return compilePiInput(input, additionalContext, cwd, model, { attachmentDirectory: this.options.attachmentDirectory });
  }
  ownsThread(id: string) { return id.startsWith("pi_"); }
  ownsModel(id: string) { return id.startsWith("pi:"); }
  subscribe(listener: (method: string, params: Value) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(method: string, params: Value) {
    if (method === "turn/started" && !this.sessions.get(params.threadId)?.ephemeral) this.recovery?.started(params.threadId, params.turn.id);
    if (method === "turn/completed") this.recovery?.finished(params.threadId, params.turn.id);
    nodeObserver("pi").execution("pi", method, params); for (const listener of this.listeners) listener(method, params);
  }
  private load() {
    return this.loading ??= (async () => {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      for (const file of await readdir(this.options.directory)) {
        if (!/^pi_[a-f0-9-]+\.json$/u.test(file)) continue;
        try {
          const record = JSON.parse(await readFile(join(this.options.directory, file), "utf8"));
          if (record.format !== "pi-durable-1" || `${record.id}.json` !== file || !Array.isArray(record.tools)) throw new Error("Invalid Pi session index");
          this.sessions.set(record.id, record);
          record.needsResume = record.pendingRecovery === true;
        } catch {
          this.catalogUnknown = true;
          // Retain corrupt metadata and its ledger for repair; one record cannot disable all Pi sessions.
          this.notify("warning", { message: `Pi session index could not be loaded: ${file}` });
        }
      }
      this.recovery = new InterruptedTurnRecovery(this.options.directory, {
        serialize: (id, operation) => this.serialize(id, operation),
        inspect: async turn => {
          const session = this.sessions.get(turn.threadId);
          if (!session || session.archived || session.ephemeral) return "handled";
          await this.refresh(session);
          const latest = session.turns?.at(-1);
          if (!latest) return "unknown";
          if (latest.id !== turn.turnId) return "handled";
          if (latest.status !== "inProgress") return "finished";
          return session.needsResume ? "lost" : "live";
        },
        continue: async (turn, current, admit) => {
          const session = this.sessions.get(turn.threadId)!;
          const native = await this.native(session);
          if (!current() || !session.active) return null;
          const turnId = session.active.id;
          await native.recordRecovery(turnId, turn.inputId!);
          if (!admit()) return null;
          session.needsResume = false;
          native.resume();
          return turnId;
        },
        stop: async turn => {
          const session = this.sessions.get(turn.threadId);
          if (session?.native) { await session.native.abort(); await this.refresh(session); }
        },
        changed: (threadId, recovery) => this.notify("opencraft/turn-recovery/updated", { threadId, recovery }),
      }, 500, this.admissionOpen);
    })();
  }
  async start() {
    await this.load(); await this.modelsRuntime; await this.options.configuration?.synchronize();
    this.schedules();
    if (!this.admissionOpen()) return;
    for (const session of this.sessions.values()) {
      if (!session.pendingRecovery || session.archived) continue;
      try { await this.refresh(session); if (!session.active) { session.needsResume = false; this.scheduleQueue(session); } }
      catch { this.fail(session, "Pi session recovery failed"); }
    }
    this.recovery?.wake();
  }
  private save(session: Session, pinState?: Pick<Session, "pinned" | "pinnedAt">): Promise<void> {
    if (session.ephemeral) return Promise.resolve();
    const { native: _native, starting: _starting, owner: _owner, lease: _lease, active: _active, turns: _turns,
      snapshot: _snapshot, effort: _effort, failed: _failed, hostTools: _hostTools, needsResume: _needsResume, ...record } = session;
    const file = join(this.options.directory, `${session.id}.json`), temporary = `${file}.${randomUUID()}.tmp`;
    const operation = (this.writes.get(session.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      // Native snapshots can queue metadata while a pin write is pending. Read
      // the committed pin fields when this write runs, not when it is queued.
      const next = { ...record, ...(pinState ?? { pinned: session.pinned, pinnedAt: session.pinnedAt }) };
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 }); await rename(temporary, file);
      } catch (error) {
        this.catalogUnknown = true;
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      if (pinState) { session.pinned = pinState.pinned; session.pinnedAt = pinState.pinnedAt; }
    });
    this.writes.set(session.id, operation);
    void operation.finally(() => { if (this.writes.get(session.id) === operation) this.writes.delete(session.id); }).catch(() => {});
    return operation;
  }
  private async session(id: string) { await this.load(); const session = this.sessions.get(id); if (!session) throw new AppServerRpcError({ code: -32004, message: "Pi thread not found", data: { code: "THREAD_NOT_FOUND", retryable: false } }); return session; }
  private attach(session: Session, owner: EngineClient) {
    if (session.owner === owner) return;
    session.lease?.abort(); session.owner = owner; session.lease = new AbortController();
  }
  private hostTools(session: Session): Value[] {
    const tools = [
      ...structuredClone(this.options.sessionCapabilities?.tools(session.id) ?? []).map(tool => ({ ...tool, namespace: null, piName: `opencraft_host_${tool.name}` })),
      ...(this.orchestration?.tools ?? []).map(tool => ({ ...tool, namespace: null, piName: `opencraft_orchestration_${tool.name}`, orchestration: true })),
    ];
    if (new Set(tools.map(identity)).size !== tools.length) throw new Error("Duplicate Host tool capability");
    if (session.tools.some(tool => tools.some(host => identity(host) === identity(tool)))) throw new Error("Capability name reserved by Host");
    session.hostTools = tools;
    return tools;
  }
  private async refreshHostTools(session: Session, inputId?: string): Promise<void> {
    await this.options.sessionCapabilities?.refresh?.(session.id, inputId ? { inputId } : undefined);
    const previous = session.hostTools, tools = this.hostTools(session);
    session.hostTools = previous;
    if (previous !== undefined && isDeepStrictEqual(previous, tools)) return;
    if (session.active) throw new Error("Wait until the Pi thread is idle before changing its tools");
    // A failed/partial installation is unknown, including when the provider rolls
    // back to the previous declaration. Confirm only after the native owner does.
    session.hostTools = undefined;
    if (session.native) session.native.tools([...session.tools, ...tools]);
    session.hostTools = tools;
  }
  private async native(session: Session): Promise<PiDurableSession> {
    if (this.closed) throw new Error("Pi engine is closed");
    if (session.native) return session.native;
    if (!this.admissionOpen()) throw new Error("Pi admission is fenced");
    if (session.ephemeral && session.failed) throw new Error("Temporary Pi session is no longer available");
    return session.starting ??= (async () => {
      const native = await PiDurableSession.open({ threadId: session.id, cwd: session.cwd, file: join(this.options.directory, `${session.id}.sqlite`),
        ephemeral: session.ephemeral, inherited: session.inherited, admissionOpen: this.admissionOpen, onPolicyDenied: error => this.notify("warning",{threadId:session.id,message:error.message}),
        modelPolicyPath: this.options.modelPolicyPath, policyCatalog: () => this.models(), admitBackground: operation => this.admit(async () => {
          assertModelPolicy(this.options.modelPolicyPath, "pi", session.model, session.effort, await this.models());
          return operation();
        }),
        agentDirectory: this.options.modelDirectory ?? this.options.directory, models: await this.modelsRuntime, tools: [...session.tools, ...this.hostTools(session)],
        prepareRecovery: async snapshot => {
          const active = [...projectPiSnapshot(session, snapshot)].reverse().find(turn => turn.status === "inProgress");
          if (!active) return undefined;
          const inputId = active.items.find((item: Value) => item.type === "userMessage" && item.__opencraftMessageKind !== "steering")?.clientId;
          // Restore from the durable native submission before any scheduler or
          // shell follow-up can resume; never use a reconnecting browser owner.
          await this.options.sessionCapabilities?.refresh?.(session.id, { turnId: active.id, ...(typeof inputId === "string" ? { inputId } : {}) });
          return [...session.tools, ...this.hostTools(session)];
        },
        onSnapshot: snapshot => this.accept(session, snapshot),
        onTool: async (request, signal) => {
          const hostTool = session.hostTools?.find(tool => tool.piName === request.name);
          if (hostTool) {
            if (!session.active || request.turnId !== session.active.id) throw new Error("No active Pi execution");
            if (hostTool.orchestration === true) {
              const inputId = session.active.items.find((item: Value) => item.type === "userMessage")?.clientId;
              return this.orchestration!.call(session.id, session.active.id, String(request.id), hostTool.name,
                request.arguments, signal, typeof inputId === "string" ? inputId : undefined);
            }
            return this.options.sessionCapabilities!.call(session.id, hostTool.name, request.arguments, signal, { turnId: request.turnId, callId: String(request.id) });
          }
          const tool = session.tools.find(tool => tool.piName === request.name), owner = session.owner, lease = session.lease;
          if (!tool || !owner || !lease || lease.signal.aborted || !session.active) throw new Error("No live platform tool owner");
          let expired!: () => void;
          const cancelled = new Promise<never>((_resolve, reject) => { expired = () => reject(new Error("Platform tool owner expired")); lease.signal.addEventListener("abort", expired, { once: true }); });
          try {
            const result = await Promise.race([owner.request("item/tool/call", { threadId: session.id, turnId: session.active.id,
              callId: request.id, namespace: tool.namespace, tool: tool.name, arguments: request.arguments }), cancelled]);
            if (lease.signal.aborted || session.lease !== lease) throw new Error("Platform tool owner expired");
            return result;
          } finally { lease.signal.removeEventListener("abort", expired); }
        },
        onExit: error => {
          const failed = session.native; session.native = undefined;
          session.needsResume = true;
          this.recovery?.lost(session.id);
          this.fail(session, error.message);
          void (failed?.close() ?? Promise.resolve()).finally(() => this.recovery?.wake());
        },
      });
      try {
        const snapshot = await native.snapshot();
        // Old indexes predate AgentDoc configuration. Bootstrap once; afterwards the native document wins.
        if (!snapshot.agent.model) await native.configure({ model: selection(session.model), cwd: session.cwd });
        if (!this.admissionOpen()) throw new Error("Pi admission is fenced");
        session.native = native; session.inherited = undefined; session.failed = false;
        this.accept(session, await native.snapshot()); return native;
      } catch (error) { await native.close(); throw error; }
      finally { session.starting = undefined; }
    })();
  }
  private async readHistory(session: Session, signal?: AbortSignal): Promise<PiTurn[]> {
    if (session.ephemeral) return session.turns ?? [];
    return projectPiSnapshot(session, await readPiSnapshot(join(this.options.directory, `${session.id}.sqlite`), join(this.options.dataDirectory ?? this.options.directory, "cache", "transcripts"), signal));
  }
  private async refresh(session: Session) { this.accept(session, await (await this.native(session)).snapshot()); return session.turns ?? []; }
  private accept(session: Session, snapshot: PiSnapshot) {
    const turns = projectPiSnapshot(session, snapshot), previous = session.turns ?? [];
    const model = snapshot.agent.model;
    const contextWindow = model ? this.resolvedModels?.getModel(model.provider, model.modelId)?.contextWindow ?? null : null;
    const oldTurns = new Map(previous.map(turn => [turn.id, turn]));
    const previousSnapshot = session.snapshot;
    if(process.env.OPENCRAFT_OBSERVE_SOCKET&&snapshot.inbox.length!==previousSnapshot?.inbox.length)nodeObserver('pi').queue('pi',session.id,snapshot.inbox.length);
    session.snapshot = snapshot;
    if (snapshot.agent.model) session.model = piModel(snapshot.agent.model.provider, snapshot.agent.model.modelId);
    if (snapshot.agent.cwd) session.cwd = snapshot.agent.cwd;
    session.effort = snapshot.agent.thinkingLevel === "off" ? "none" : snapshot.agent.thinkingLevel;
    // An optimistic admission cannot be erased by a snapshot taken before submit commits.
    const awaitingAdmission = session.active && !turns.some(turn => turn.id === session.active!.id);
    const oldActive = session.active;
    session.turns = turns;
    if (!awaitingAdmission) session.active = [...turns].reverse().find(turn => turn.status === "inProgress");
    for (const turn of turns) {
      const before = oldTurns.get(turn.id);
      if (!before && turn.status === "inProgress" && (oldActive?.id !== turn.id || oldActive?._queueAdmission)) this.notify("turn/started", { threadId: session.id, turn });
      if (!before && turn.status !== "inProgress") continue; // Hydration does not replay completed user turns.
      const common = { threadId: session.id, turnId: turn.id };
      const oldItems = new Map<string, Value>((before?.items ?? []).map((item: Value) => [item.id, item]));
      for (const item of turn.items) {
        const old = oldItems.get(item.id);
        if (same(old, item)) continue;
        if (!old) this.notify("item/started", { ...common, item });
        else if (item.type === "agentMessage" && item.text.startsWith(old.text)) this.notify("item/agentMessage/delta", { ...common, itemId: item.id, delta: item.text.slice(old.text.length) });
        else if (item.type === "reasoning") {
          for (let index = 0; index < item.content.length; index++) {
            const text = item.content[index], previousText = old.content?.[index] ?? "";
            if (text.startsWith(previousText)) this.notify("item/reasoning/textDelta", { ...common, itemId: item.id, delta: text.slice(previousText.length), contentIndex: index });
          }
        } else if (item.type === "commandExecution" && (item.aggregatedOutput ?? "").startsWith(old.aggregatedOutput ?? ""))
          this.notify("item/commandExecution/outputDelta", { ...common, itemId: item.id, delta: (item.aggregatedOutput ?? "").slice((old.aggregatedOutput ?? "").length) });
        else this.notify("item/started", { ...common, item }); // Full upsert for retained-window replacement/trimming.
        if (turn.status !== "inProgress" || item.status && item.status !== "inProgress") this.notify("item/completed", { ...common, item });
      }
    }
    const finished = oldActive && turns.find(turn => turn.id === oldActive.id && turn.status !== "inProgress");
    if (finished && previous.find(turn => turn.id === finished.id)?.status !== finished.status) {
      this.notify("thread/tokenUsage/updated", { threadId: session.id, turnId: finished.id, tokenUsage: tokenUsage(snapshot, contextWindow) });
      this.notify("turn/completed", { threadId: session.id, turn: finished });
      this.notify("thread/status/changed", { threadId: session.id, status: { type: "idle" } });
      session.updatedAt = seconds(); session.pendingRecovery = !!snapshot.queue?.items.length;
      void this.save(session).catch(() => this.notify("warning", { message: "Pi catalog metadata could not be saved" }));
    }
    if (!same(previousSnapshot?.queue, snapshot.queue) || !same(previousSnapshot?.inbox, snapshot.inbox))
      this.notify("thread/queue/changed", { threadId: session.id });
    this.scheduleQueue(session);
    if (session.active) {
      this.notify("thread/tokenUsage/updated", { threadId: session.id, turnId: session.active.id,
        tokenUsage: tokenUsage(snapshot, contextWindow) });
      if (snapshot.live.generation?.retry && !same(previousSnapshot?.live.generation?.retry, snapshot.live.generation.retry))
        this.notify("warning", { threadId: session.id, message: "Pi is retrying the model request" });
      if (snapshot.live.generation?.deferred && !same(previousSnapshot?.live.generation?.deferred, snapshot.live.generation.deferred))
        this.notify("warning", { threadId: session.id, message: "Pi is waiting for a deferred model response" });
      this.notify("thread/status/changed", { threadId: session.id, status: { type: "active", activeFlags: [] } });
    }
  }
  private scheduleQueue(session: Session) {
    if (!this.admissionOpen() || session.archived || session.needsResume || session.active || this.queueDrains.has(session.id)
      || session.snapshot?.queue?.paused || !session.snapshot?.queue?.items.length) return;
    this.queueDrains.add(session.id);
    void this.serialize(session.id, () => this.dispatchQueue(session)).catch(async error => {
      if (error instanceof ModelPolicyError) {
        await (await this.native(session)).changeQueue("pause", undefined, undefined, undefined, "model-restricted");
        await this.refresh(session);
      }
      this.notify("warning", { threadId: session.id, message: error instanceof ModelPolicyError ? error.message : "Pi queued input is paused; review it before continuing" });
    }).finally(() => { this.queueDrains.delete(session.id); this.scheduleQueue(session); });
  }
  private async dispatchQueue(session: Session, id?: string, explicit = false) {
    assertModelPolicy(this.options.modelPolicyPath, "pi", session.model, session.effort, await this.models());
    const native = await this.native(session);
    if (!this.admissionOpen()) throw new Error("Pi admission is fenced");
    const item = await native.claimQueue(id, explicit);
    if (!item) {
      if (!explicit) { await this.refresh(session); return null; }
      await this.refresh(session);
      const delivered = id && session.turns?.find(turn => turn.id === id);
      if (delivered) return delivered;
      throw new Error("Pi queue changed or the thread is still active");
    }
    try {
      await this.refreshHostTools(session, item.clientId ?? undefined);
      const owner = this.queueOwners.get(item.id);
      if (owner) this.attach(session, owner);
      session.pendingRecovery = true;
      session.preview ||= textOf(item.content).slice(0, 200); session.updatedAt = seconds();
      await this.save(session);
      // Bind platform tools before the scheduler can run. This is private
      // admission state; only a committed native snapshot announces the Turn.
      session.active = { id: item.id, status: "inProgress", items: [], _queueAdmission: true };
      if (!this.admissionOpen()) throw new Error("Pi admission is fenced");
      await native.submit(item.content, { turnId: item.id, clientId: item.clientId, input: item.input,
        additionalContext: item.additionalContext, createdAtMs: item.createdAtMs,
        ...(item.executionAdmission ? {executionAdmission:item.executionAdmission} : {}) }, item.id);
      await native.settleQueue(item.id);
      this.queueOwners.delete(item.id);
      await this.refresh(session);
      return session.turns?.find(turn => turn.id === item.id);
    } catch (error) {
      // Native receipts, not the gateway ACK, decide whether replay is safe.
      if (await native.execution(item.id)) await native.settleQueue(item.id);
      else {
        if (session.active?.id === item.id && session.active._queueAdmission) session.active = undefined;
        await native.settleQueue(item.id, true);
      }
      await this.refresh(session); throw error;
    }
  }
  private fail(session: Session, message: string) {
    const active = session.active;
    session.failed = true; session.active = undefined;
    if (active) {
      const turn = { ...active, status: "failed", error: { message, codexErrorInfo: null, additionalDetails: null }, completedAt: null, durationMs: null };
      session.turns = (session.turns ?? [active]).map(old => old.id === active.id ? turn : old);
      this.notify("turn/completed", { threadId: session.id, turn });
    }
    this.notify("thread/status/changed", { threadId: session.id, status: { type: "systemError" } });
  }
  async models(): Promise<Value[]> {
    await this.options.configuration?.synchronize();
    const available = (await this.modelsRuntime).getAvailableSnapshot(), saved = await this.defaults();
    const defaultModel = available.some((model: Value) => piModel(model.provider, model.id) === saved.model) ? saved.model : this.options.configuration ? null : available[0] && piModel(available[0].provider, available[0].id);
    return available.map((model: Value) => {
      const levels = getSupportedThinkingLevels(model as any);
      return { id: piModel(model.provider, model.id), model: piModel(model.provider, model.id), displayName: model.name ?? model.id,
        description: `${model.provider} · Pi Coding Agent`, groupKey: `pi:${model.provider}`, groupLabel: `Pi · ${model.provider}`, hidden: false, isDefault: piModel(model.provider, model.id) === defaultModel,
        supportedReasoningEfforts: levels.map(level => ({ reasoningEffort: level === "off" ? "none" : level, description: level })),
        defaultReasoningEffort: thinking(model, piModel(model.provider, model.id) === defaultModel ? saved.effort : null, false) === "off" ? "none" : thinking(model, piModel(model.provider, model.id) === defaultModel ? saved.effort : null, false),
        inputModalities: model.input?.includes("image") ? ["text", "image"] : ["text"], contextWindow: model.contextWindow, maxTokens: model.maxTokens,
        source: "builtin", additionalSpeedTiers: [], serviceTiers: [], upgrade: null };
    });
  }
  private thread(session: Session, turns: PiTurn[] = []) {
    return { id: session.id, sessionId: session.id, forkedFromId: session.forkedFromId ?? null, parentThreadId: null, name: session.name, preview: session.preview,
      ephemeral: session.ephemeral === true, projectId: session.projectId ?? null, historyMode: "paginated", modelProvider: "pi", model: session.model, reasoningEffort: session.effort ?? null,
      createdAt: session.createdAt, updatedAt: session.updatedAt, recencyAt: session.updatedAt,
      status: session.failed ? { type: "systemError" } : session.active ? { type: "active", activeFlags: [] } : { type: "idle" },
      path: session.ephemeral ? null : join(this.options.directory, `${session.id}.sqlite`), cwd: session.cwd, cliVersion: "1.3.0", source: "appServer", originator: "opencraft",
      canAcceptDirectInput: true, threadSource: session.threadSource ?? null, agentNickname: null, agentRole: null, gitInfo: null,
      daybreakEnabled: null, environments: null, extra: null, section: null, sectionEnteredAt: null, turns };
  }
  private response(session: Session, turns: PiTurn[] = []) {
    return { thread: this.thread(session, turns), model: session.model, modelProvider: "pi", serviceTier: null, cwd: session.cwd,
      runtimeWorkspaceRoots: [session.cwd], instructionSources: [], disabledPluginIds: [], initialTurnsPage: null, turnsBackwardsCursor: null, approvalPolicy: "never", approvalsReviewer: "user",
      sandbox: { type: "dangerFullAccess" }, activePermissionProfile: { id: fullAccessProfile, extends: null }, reasoningEffort: session.effort ?? null, multiAgentMode: "explicitRequestOnly" };
  }
  private async defaults(): Promise<Value> {
    if (this.options.configuration) return this.options.configuration.defaults();
    try { return JSON.parse(await readFile(join(this.options.directory, "defaults.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return {}; }
  }
  private async configure(session: Session, params: Value, initial = false, execute = false) {
    assertPiFields(params);
    const cwd = await workspace(params, session.cwd);
    const modelId = params.model ?? session.model;
    const ref = selection(modelId), model = (await this.modelsRuntime).getModel(ref.provider, ref.modelId);
    if (!model) throw new Error("Pi model is unavailable");
    if (params.modelProvider != null && !["pi", ref.provider].includes(params.modelProvider)) throw new Error("modelProvider does not match the selected Pi model");
    const explicit = params.effort ?? params.config?.model_reasoning_effort;
    const proposed=explicit ?? session.effort;
    if(execute && proposed != null) assertModelPolicy(this.options.modelPolicyPath,"pi",modelId,proposed === "off" ? "none" : proposed,await this.models());
    const effort = thinking(model, proposed, explicit != null);
    // Validate the resolved native selection, including config overrides and inherited defaults.
    if (execute) assertModelPolicy(this.options.modelPolicyPath, "pi", modelId, effort === "off" ? "none" : effort, await this.models());
    const native = await this.native(session);
    if (session.active && (cwd !== session.cwd || modelId !== session.model || (effort === "off" ? "none" : effort) !== session.effort
      || params.baseInstructions != null || params.developerInstructions != null)) throw new Error("Stop the Pi turn before changing its configuration");
    if (!session.active) {
      await native.configure({ model: ref, cwd, thinkingLevel: effort });
      await native.instructions(params.baseInstructions ?? undefined, params.developerInstructions ?? undefined);
      await this.refresh(session);
      if (!initial) await this.save(session);
    }
    return { native, model };
  }
  private pinCatalog(): Value {
    return { supported: true, data: [...this.sessions.values()]
      .filter(session => session.pinned === true && !session.ephemeral && !session.archived)
      .sort((left, right) => (left.pinnedAt ?? 0) - (right.pinnedAt ?? 0) || left.id.localeCompare(right.id))
      .map(session => this.thread(session)) };
  }
  private async setPinned(params: Value): Promise<Value> {
    if (typeof params.threadId !== "string" || params.threadId.length === 0) throw new Error("Invalid thread pin target");
    if (typeof params.pinned !== "boolean") throw new Error("Invalid thread pin state");
    const session = await this.session(params.threadId);
    if (session.ephemeral) throw new Error("Temporary Pi threads cannot be pinned");
    if (params.pinned) {
      if (session.pinned !== true) {
        const latest = [...this.sessions.values()].reduce((latest, entry) => Math.max(latest, entry.pinnedAt ?? 0), this.latestPinAt);
        this.latestPinAt = Math.max(Date.now(), latest + 1);
        await this.save(session, { pinned: true, pinnedAt: this.latestPinAt });
      }
    } else if (session.pinned === true) {
      await this.save(session, { pinned: undefined, pinnedAt: undefined });
    }
    return { pinned: params.pinned };
  }
  private serialize<T>(key: string, run: () => Promise<T>): Promise<T> {
    const operation = (this.operations.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
    this.operations.set(key, operation);
    void operation.finally(() => { if (this.operations.get(key) === operation) this.operations.delete(key); }).catch(() => {});
    return operation;
  }
  /** In-process Host admission; native submission identity is the receipt. */
  readonly inputs: HostInputPort = {
    receipt: (threadId, inputId) => this.admit(async () => {
      const session = await this.session(threadId), turnId = `${threadId}:turn:client:${inputId}`;
      const snapshot = session.native ? await session.native.snapshot() : await readPiSnapshot(join(this.options.directory, `${session.id}.sqlite`), join(this.options.directory, "handoff-cache"));
      return snapshot.submissions.some(row => row.requestId === turnId) ? { state: "delivered" as const, turnId } : null;
    }, true),
    submit: (threadId, inputId, text, canAdmit) => this.admit(() => this.serialize(threadId, async () => {
      const prior = await this.inputs.receipt(threadId, inputId); if (prior) return prior;
      const session = await this.session(threadId);
      if (session.archived || session.ephemeral) return { state: "discarded", turnId: null };
      if (!this.admissionOpen() || session.active || !await canAdmit()) return null;
      const owner: EngineClient = { notify() {}, request: async () => { throw new Error("No browser tool owner"); } };
      try {
        await this.handle("turn/start", { threadId, clientUserMessageId: inputId, input: [{ type: "text", text }] }, owner, () => this.admissionOpen() && canAdmit());
        return await this.inputs.receipt(threadId, inputId) ?? { state: "unknown", turnId: null };
      } catch (error) {
        if (error instanceof ScheduleAdmissionDeferred) return null;
        return await this.inputs.receipt(threadId, inputId) ?? { state: "unknown", turnId: null };
      }
    })),
  };
  private schedules(): ConversationSchedules {
    if (!this.scheduleService) {
      const owner: EngineClient = { notify() {}, request: async () => { throw new Error("Scheduled Pi inputs cannot use browser tool leases"); } };
      const validate = async (id: string) => {
        const session = await this.session(id);
        if (session.archived || session.ephemeral) throw new ScheduleFault(-32602, "Schedules require an existing, unarchived durable thread");
      };
      const turnId = (run: { threadId: string; id: string }) => `${run.threadId}:turn:client:${run.id}`;
      const inspect: ScheduleExecutionPort["inspect"] = async run => {
        const session = await this.session(run.threadId);
        const state = await (await this.native(session)).execution(turnId(run));
        return { state: state ?? "unknown" };
      };
      const port: ScheduleExecutionPort = { validate, inspect,
        permissionProfiles: async () => this.permissionProfiles(),
        subscribe: listener => this.subscribe((method, params) => {
          if (method === "turn/completed" && ["completed", "failed", "interrupted"].includes(params.turn?.status))
            listener({ threadId: params.threadId, turnId: params.turn.id, state: params.turn.status === "completed" && !params.turn.error ? "completed" : "failed" });
        }),
        submit: (run, prompt, canAdmit) => this.serialize(run.threadId, async () => {
          const session = await this.session(run.threadId);
          const native = await this.native(session), prior = await native.execution(turnId(run));
          if (prior) return { state: prior, turnId: turnId(run) };
          try { await validate(run.threadId); assertPiFields({ permissions: run.permissions }); }
          catch { return { state: "failed" }; }
          if (!this.admissionOpen() || session.active || !canAdmit()) return { state: "waiting" };
          try {
            const result = await this.handle("turn/start", { threadId: run.threadId, clientUserMessageId: run.id,
              permissions: run.permissions, input: [{ type: "text", text: `[Scheduled task]\n${prompt}` }] }, owner, () => this.admissionOpen() && canAdmit());
            const state = await native.execution(result.turn.id);
            return { state: state ?? "unknown", turnId: result.turn.id };
          } catch (error) {
            if (error instanceof ScheduleAdmissionDeferred) return { state: "waiting" };
            // Never resend an uncertain native acceptance, even if its projection failed.
            try { return { state: await native.execution(turnId(run)) ?? "unknown", turnId: turnId(run) }; }
            catch { return { state: "unknown" }; }
          }
        }),
      };
      this.scheduleService = new ConversationSchedules(this.options.directory, port, Date.now, undefined,
        () => this.notify("opencraft/schedules/changed", {}), this.admissionOpen);
      this.scheduleService.start();
    }
    return this.scheduleService;
  }
  private async startSession(params: Value, client: EngineClient, operation?: { id: string; fingerprint: string }) {
    assertPiFields(params);
    if (params.projectId != null && (typeof params.projectId !== "string" || !params.projectId.trim())) throw new Error("Invalid workspace project identity");
    const saved = await this.defaults(), model = params.model ?? saved.model ?? (await this.models()).find(model => model.isDefault)?.model;
    const ref = selection(model ?? "");
    const selected = (await this.modelsRuntime).getModel(ref.provider, ref.modelId);
    if (!selected) throw new Error("Pi model is unavailable");
    const explicit = params.effort ?? params.config?.model_reasoning_effort;
    thinking(selected, explicit ?? saved.effort, explicit != null);
    const session: Session = { format: "pi-durable-1", id: `pi_${randomUUID()}`, cwd: await workspace(params, this.options.cwd), model,
      projectId: params.projectId ?? null, threadSource: params.threadSource ?? null, sessionStartSource: params.sessionStartSource ?? null,
      ephemeral: params.ephemeral === true, name: null, preview: "", createdAt: seconds(), updatedAt: seconds(), archived: false,
      effort: explicit ?? saved.effort, tools: flattenPiTools(params.dynamicTools ?? []),
      ...(operation ? { orchestrationOperation: { ...operation, state: "prepared" as const } } : {}) };
    this.attach(session, client); this.sessions.set(session.id, session);
    try {
      // Persist the allocated identity before opening native storage. A gateway
      // reconnect, or a Host restart, can finish this same child allocation.
      if (operation) await this.save(session);
      await this.configure(session, params, true);
      if (session.orchestrationOperation) session.orchestrationOperation.state = "created";
      await this.save(session); return this.response(session);
    } catch (error) {
      if (!operation) { this.sessions.delete(session.id); await session.native?.close(); }
      throw error;
    }
  }
  private orchestrationError(code: number, message: string): never {
    throw new AppServerRpcError({ code, message });
  }
  private async orchestrationRequest(method: string, params: Value, client: EngineClient): Promise<unknown> {
    if (!this.orchestration) this.orchestrationError(503, "Pi orchestration is not connected");
    const operationId = params.operationId;
    if (typeof operationId !== "string" || !operationId || operationId.length > 256) this.orchestrationError(400, "Invalid orchestration operation identity");
    if (method === "opencraft/orchestration/prepare") {
      const args = params.arguments ?? {}, source = this.ownsThread(params.threadId ?? "") ? await this.session(params.threadId) : undefined;
      const inherited = source ? this.response(source) : params.sourceSettings;
      if (!inherited || typeof inherited.cwd !== "string" || !isAbsolute(inherited.cwd)) this.orchestrationError(503, "Source workspace is unavailable");
      const base = resolve(inherited.cwd), cwd = args.cwd === undefined ? base : resolve(base, args.cwd);
      if (cwd !== base && !cwd.startsWith(base.endsWith(sep) ? base : base + sep)) this.orchestrationError(403, "Child workspace exceeds the source delegation");
      // Pi cannot preserve a restricted permission profile. Reject it before
      // allocating a child rather than silently granting Full access.
      const sandbox = typeof inherited.sandbox === "string" ? inherited.sandbox : inherited.sandbox?.type;
      const permissions = inherited.permissions ?? inherited.activePermissionProfile?.id;
      if (permissions != null && permissions !== fullAccessProfile || sandbox != null && !["danger-full-access", "dangerFullAccess"].includes(sandbox)
        || inherited.approvalPolicy != null && inherited.approvalPolicy !== "never")
        this.orchestrationError(403, "Pi cannot preserve the source permission profile");
      const defaults = await this.defaults();
      const model = args.model ?? source?.model ?? defaults.model ?? (await this.models()).find(model => model.isDefault)?.model;
      const ref = selection(model ?? ""), selected = (await this.modelsRuntime).getModel(ref.provider, ref.modelId);
      if (!selected) this.orchestrationError(503, "Pi model is unavailable");
      const requestedEffort = args.reasoningEffort ?? source?.effort ?? defaults.effort;
      const level = thinking(selected, requestedEffort, args.reasoningEffort != null);
      return { driver: "pi", cwd, model,
        config: { model_reasoning_effort: level === "off" ? "none" : level },
        permissions: fullAccessProfile, approvalPolicy: "never", sandbox: "danger-full-access",
        orchestrationHostIncarnation: this.orchestrationIncarnation,
        ...(args.title === undefined ? {} : { orchestrationTitle: args.title }) };
    }
    if (method === "opencraft/orchestration/ack") {
      for (const session of this.sessions.values()) if (session.orchestrationOperation?.id === operationId) {
        delete session.orchestrationOperation; await this.save(session);
      }
      this.orchestrationCreates.delete(operationId); return { acknowledged: true };
    }
    if (method === "opencraft/orchestration/create") {
      const settings = params.settings ?? {};
      if (settings.driver !== "pi") this.orchestrationError(400, "Orchestration settings belong to another driver");
      const fingerprint = createHash("sha256").update(JSON.stringify(settings)).digest("hex"), prior = this.orchestrationCreates.get(operationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) this.orchestrationError(409, "Orchestration operation reused with different settings");
        return prior.promise;
      }
      const existing = [...this.sessions.values()].find(session => session.orchestrationOperation?.id === operationId);
      if (existing && existing.orchestrationOperation!.fingerprint !== fingerprint) this.orchestrationError(409, "Orchestration operation reused with different settings");
      if (!existing && settings.orchestrationHostIncarnation !== this.orchestrationIncarnation)
        this.orchestrationError(409, "Pi Host changed; child creation requires reconciliation");
      if (this.orchestrationCreates.size >= 1024) this.orchestrationError(503, "Unacknowledged orchestration receipt limit");
      const promise = (async () => {
        const { driver: _driver, orchestrationHostIncarnation: _incarnation, orchestrationTitle, ...start } = settings;
        let session = existing;
        if (!session) {
          const result = await this.startSession(start, client, { id: operationId, fingerprint }); session = await this.session(result.thread.id);
        } else if (session.orchestrationOperation?.state !== "created") {
          await this.configure(session, start, true); session.orchestrationOperation!.state = "created"; await this.save(session);
        }
        if (orchestrationTitle !== undefined && session.name !== orchestrationTitle) { session.name = orchestrationTitle; await this.save(session); }
        return { threadId: session.id, driverKind: "pi", generationId: this.orchestrationIncarnation, durability: "immediate" };
      })().catch(error => { this.orchestrationCreates.delete(operationId); throw error; });
      this.orchestrationCreates.set(operationId, { fingerprint, promise });
      return promise;
    }
    const session = await this.session(params.threadId), turns = await this.readHistory(session);
    if (method === "opencraft/orchestration/inspect") {
      const limit = params.limit ?? 1;
      if (!Number.isInteger(limit) || limit < 1 || limit > 5) this.orchestrationError(400, "Invalid recent Turn limit");
      const entries: Array<{ turnId: string; role: string; text: string }> = []; let bytes = 0;
      for (const turn of turns.slice(-limit).reverse()) for (const item of [...turn.items].reverse()) {
        if (item.type !== "userMessage" && item.type !== "agentMessage") continue;
        const body = item.type === "agentMessage" ? item.text : textOf(item.content);
        if (!body) continue;
        const text = Array.from(body).slice(-Math.max(0, Math.floor((23000 - bytes - 256) / 4))).join("");
        if (!text) return { entries };
        const entry = { turnId: turn.id, role: item.type === "userMessage" ? "user" : "assistant", text };
        bytes += Buffer.byteLength(JSON.stringify(entry)); entries.unshift(entry);
      }
      return { entries };
    }
    if (method !== "opencraft/orchestration/status") this.orchestrationError(400, "Unknown orchestration operation");
    const recovery = this.recovery?.snapshot(session.id), turn = turns.at(-1);
    const current = { threadId: session.id, driverKind: "pi", turnId: turn?.id ?? recovery?.turnId ?? null,
      rootTurnId: recovery?.rootTurnId ?? turn?.id ?? null };
    if (recovery && ["interrupted", "preparing", "dispatching"].includes(recovery.state)) return { ...current, state: "recovering" };
    if (recovery?.state === "exhausted" || recovery?.state === "unconfirmed") return { ...current, state: recovery.state };
    if (session.failed) return { ...current, state: "unconfirmed" };
    if (session.active || turn?.status === "inProgress") return { ...current, state: "active" };
    if (!turn) return { ...current, state: "starting" };
    return { ...current, state: turn.status === "failed" ? "failed" : turn.status === "interrupted"
      ? recovery?.state === "handled" && recovery.handledReason === "user_stop" && recovery.turnId === turn.id ? "interrupted_by_user" : "unconfirmed" : "completed",
      summary: String([...turn.items].reverse().find(item => item.type === "agentMessage")?.text ?? "").slice(-4096) };
  }
  request(method: string, params: Value, client: EngineClient): Promise<any> {
    return this.admit(() => this.acceptRequest(method, params, client), piHandoffReconciliation(method));
  }
  private acceptRequest(method: string, params: Value, client: EngineClient): Promise<any> {
    if (["thread/read", "thread/turns/list", "thread/items/list"].includes(method)) {
      // Display hydration never owns the execution mutation lane. A slow
      // SQLite snapshot must not delay Stop or another accepted input.
      const controller = new AbortController();
      let readers = this.historyReaders.get(client);
      if (!readers) { readers = new Set(); this.historyReaders.set(client, readers); }
      readers.add(controller);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      return this.handle(method, params, client, undefined, signal).finally(() => {
        readers.delete(controller);
        if (!readers.size && this.historyReaders.get(client) === readers) this.historyReaders.delete(client);
      });
    }
    if (["turn/start", "turn/interrupt", "thread/archive", "thread/delete"].includes(method) && typeof params.threadId === "string")
      this.recovery?.handled(params.threadId, method === "turn/interrupt" ? "user_stop" : "user_input");
    // Schedule mutations must not wait behind the admission they need to cancel.
    const key = method.startsWith("opencraft/schedules/") ? undefined
      : typeof params.threadId === "string" ? params.threadId : method.startsWith("config/") ? "config" : undefined;
    return key === undefined ? this.handle(method, params, client) : this.serialize(key, () => this.handle(method, params, client));
  }
  private async handle(method: string, params: Value, client: EngineClient, canAdmit?: () => boolean | Promise<boolean>, readSignal?: AbortSignal): Promise<any> {
    await this.load(); if (this.closed) throw new Error("Pi engine is closed");
    readSignal?.throwIfAborted();
    if (method.startsWith("opencraft/orchestration/")) return this.orchestrationRequest(method, params, client);
    if (method === "opencraft/turn-recovery/read") return { recovery: this.recovery?.notice(params.threadId) ?? null };
    if (method.startsWith("opencraft/schedules/")) {
      const schedules = this.schedules();
      return method === "opencraft/schedules/list" ? schedules.list() : schedules.handle(method, params, null);
    }
    if (method === "opencraft/thread-pins/list") return this.pinCatalog();
    if (method === "opencraft/thread-pins/set") return this.setPinned(params);
    if (["config/read", "config/batchWrite", "thread/start", "thread/fork", "thread/resume", "turn/start"].includes(method)) await this.options.configuration?.synchronize();
    if (method === "config/read") {
      const saved = await this.defaults();
      return { config: { model: saved.model ?? (await this.models()).find(model => model.isDefault)?.model ?? null, model_reasoning_effort: saved.effort ?? null }, origins: {}, layers: null };
    }
    if (method === "config/batchWrite") {
      const saved = await this.defaults();
      for (const edit of params.edits ?? []) {
        if (edit.keyPath === "model") { if (edit.value != null) { const ref = selection(edit.value); if (!(await this.modelsRuntime).getAvailableSnapshot().some(model => model.provider === ref.provider && model.id === ref.modelId)) throw new Error("Pi model is unavailable"); } saved.model = edit.value; }
        else if (edit.keyPath === "model_reasoning_effort") saved.effort = edit.value;
        else throw new Error("Unsupported Pi default setting");
      }
      if (saved.effort != null) {
        const ref = selection(saved.model ?? (await this.models()).find(model => model.isDefault)?.model ?? "");
        thinking((await this.modelsRuntime).getModel(ref.provider, ref.modelId)!, saved.effort, true);
      }
      if (this.options.configuration) {await this.options.configuration.writeDefaults({model: saved.model ?? null, effort: saved.effort}); return {status: "ok"};}
      const temporary = join(this.options.directory, `defaults.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 }); await rename(temporary, join(this.options.directory, "defaults.json")); return { status: "ok" };
    }
    if (method === "permissionProfile/list") return { data: this.permissionProfiles(), nextCursor: null };
    if (method === "model/list") return { data: await this.models(), nextCursor: null };
    if (method === "skills/list") {
      const cwd = params.threadId ? (await this.session(params.threadId)).cwd : this.options.cwd;
      if (params.cwds !== undefined && (!Array.isArray(params.cwds) || params.cwds.some((root: unknown) => typeof root !== 'string'))) throw new Error("Invalid Pi Skill workspace roots");
      const roots: string[] = params.cwds?.length ? [...new Set<string>(params.cwds)] : [cwd];
      return { data: roots.map(root => piSkillCatalog(root, this.options.modelDirectory ?? this.options.directory)) };
    }
    if (method === "thread/list") {
      if (params.parentThreadId && params.ancestorThreadId) throw new Error("parentThreadId and ancestorThreadId are mutually exclusive");
      const data = [...this.sessions.values()].filter(s => !s.ephemeral && s.archived === (params.archived === true))
        .filter(s => !("projectId" in params) || (s.projectId ?? null) === params.projectId)
        .filter(s => params.cwd == null || (Array.isArray(params.cwd) ? params.cwd : [params.cwd]).includes(s.cwd))
        .filter(() => !params.modelProviders?.length || params.modelProviders.includes("pi"))
        .filter(() => !params.sourceKinds?.length || params.sourceKinds.includes("appServer"))
        .filter(() => !params.originators?.length || params.originators.includes("opencraft"))
        .filter(() => params.sectionId == null && !params.parentThreadId && !params.ancestorThreadId)
        .filter(s => !params.searchTerm || `${s.name ?? ""} ${s.preview}`.toLowerCase().includes(params.searchTerm.toLowerCase()))
        .map(s => this.thread(s)).sort(compareThreads(params));
      // Engine Host performs global pagination after combining every engine's filtered rows.
      return { data, nextCursor: null };
    }
    if (method === "thread/start") {
      return this.startSession(params, client);
    }
    if (method === "thread/unsubscribe" && !this.sessions.has(params.threadId)) return { status: "notLoaded" };
    const session = await this.session(params.threadId);
    if (method === "thread/fork") {
      assertPiFields(params);
      if (params.ephemeral !== true || params.excludeTurns !== true || params.path != null || params.lastTurnId != null)
        throw new Error("Pi supports temporary forks from the latest context with excludeTurns only");
      await this.refresh(session);
      const inherited = await (await this.native(session)).forkContext();
      const child: Session = { format: "pi-durable-1", id: `pi_${randomUUID()}`, cwd: session.cwd, model: session.model,
        effort: session.effort, projectId: session.projectId, threadSource: session.threadSource, sessionStartSource: session.sessionStartSource,
        ephemeral: true, forkedFromId: session.id, inherited, tools: session.tools.map(tool => ({ ...tool })),
        name: null, preview: "", createdAt: seconds(), updatedAt: seconds(), archived: false };
      this.attach(child, client); this.sessions.set(child.id, child);
      try {
        await this.configure(child, { ...params, developerInstructions: [inherited.developer, params.developerInstructions].filter(Boolean).join("\n\n") || undefined }, true);
        return this.response(child);
      } catch (error) { this.sessions.delete(child.id); this.detach(child); await child.native?.close(); throw error; }
    }
    if (params.model && !String(params.model).startsWith("pi:")) throw new Error("This thread belongs to Pi; create a new thread to change engines");
    if (method === "thread/read") {
      if (params.initialTurnsPage) {
        if (!session.ephemeral) return this.transcriptCache.read(session.id, params.initialTurnsPage.limit ?? 10, undefined, "full", readSignal);
        const turns = await this.readHistory(session, readSignal);
        return { thread: this.thread(session), initialTurnsPage: { ...projectedTurnsPage(this.thread(session, turns), {
          threadId: session.id, limit: params.initialTurnsPage.limit ?? 10, sortDirection: "desc", itemsView: "full",
        }), itemsPaginationByTurnId: {} } };
      }
      return { thread: this.thread(session, params.includeTurns ? await this.readHistory(session, readSignal) : []) };
    }
    if (method === "thread/turns/list" || method === "thread/items/list") {
      if (method === "thread/turns/list" && !session.ephemeral
        && (params.cursor == null || typeof params.cursor === "string" && (params.cursor.startsWith("transcript:") || params.cursor.startsWith("transcript-asc:"))))
        return this.transcriptCache.page(session.id, params.cursor ?? null, params.limit ?? 10,
          undefined, params.itemsView === "notLoaded" ? "notLoaded" : "full", params.sortDirection === "asc" ? "asc" : "desc", readSignal);
      const thread = this.thread(session, await this.readHistory(session, readSignal));
      return method === "thread/turns/list" ? { ...projectedTurnsPage(thread, { ...params, threadId: session.id }), itemsPaginationByTurnId: {} }
        : projectedItemsPage(thread, { ...params, threadId: session.id });
    }
    if (method === "thread/resume") {
      if (session.archived) throw new AppServerRpcError({ code: -32071, message: "Pi thread is archived", data: { code: "THREAD_ARCHIVED", retryable: false } });
      if (params.path && params.path !== join(this.options.directory, `${session.id}.sqlite`)) throw new Error("Pi path must match this thread's native ledger");
      await this.refresh(session); const { native } = await this.configure(session, params);
      if (!session.owner || !session.active) this.attach(session, client);
      this.recovery?.wake();
      const thread = this.thread(session, session.turns);
      const initial = params.initialTurnsPage ? projectedTurnsPage(thread, { ...params.initialTurnsPage, threadId: session.id }) : null;
      const cursors = projectedHistoryHeadCursors(thread);
      return { ...this.response(session, params.excludeTurns ? [] : session.turns),
        initialTurnsPage: initial ? { ...initial, itemsPaginationByTurnId: {} } : null,
        turnsBackwardsCursor: initial ? initial.nextCursor : cursors.turnsBackwardsCursor, itemsBackwardsCursor: cursors.itemsBackwardsCursor };
    }
    if (method === "thread/inject_items") {
      if (!session.ephemeral) throw new Error("Pi history injection is limited to temporary threads");
      if (session.active) throw new Error("Stop the Pi turn before injecting history");
      if (!Array.isArray(params.items) || params.items.some((item: Value) => !item || item.type !== "message" || item.role !== "user"
        || !Array.isArray(item.content) || item.content.some((part: Value) => !part || part.type !== "input_text" || typeof part.text !== "string")))
        throw new Error("Pi history injection supports user text messages only");
      await (await this.native(session)).inject(params.items.map((item: Value) => ({ role: "user", timestamp: Date.now(),
        content: item.content.map((part: Value) => ({ type: "text", text: part.text })) })));
      return {};
    }
    if (method === "thread/name/set") { session.name = params.name; await this.save(session); this.notify("thread/name/updated", { threadId: session.id, threadName: session.name }); return {}; }
    if (method === "thread/archive" || method === "thread/unarchive") {
      if (session.ephemeral) throw new Error("Temporary Pi threads cannot be archived");
      if (session.active) throw new Error("Stop the Pi turn before archiving");
      session.archived = method === "thread/archive"; await this.save(session);
      if (session.archived) await this.transcriptCache.invalidate(session.id);
      if (session.archived) this.scheduleService?.suspend(session.id); return method === "thread/unarchive" ? { thread: this.thread(session) } : {};
    }
    if (method === "thread/unsubscribe") {
      if (session.owner === client) {
        this.detach(session);
        if (session.ephemeral) { await session.native?.close(); this.sessions.delete(session.id); }
      }
      return { status: "unsubscribed" };
    }
    if (method === "runtime/capabilities/register") {
      if (session.active && session.owner && session.owner !== client) throw new Error("Cannot replace the platform tool owner during a Pi turn");
      const tools = flattenPiTools(params.dynamicTools ?? [], session.tools);
      if (tools.some(tool => this.options.sessionCapabilities?.tools(session.id).some(host => tool.namespace === null && host.name === tool.name))) throw new Error("Capability name reserved by Host");
      if (!same(sortedTools(tools), sortedTools(session.tools))) {
        if (session.active) throw new Error("Cannot replace platform tools during a Pi turn");
        if (session.ephemeral) (await this.native(session)).tools([...tools, ...this.hostTools(session)]);
        else { await session.native?.close(); session.native = undefined; }
        session.tools = tools; await this.save(session);
      }
      this.attach(session, client); await this.native(session); return { registered: tools.length };
    }
    if (method.startsWith("thread/queue/")) {
      if (session.ephemeral) throw new Error("Temporary Pi threads cannot own a durable message queue");
      if (method === "thread/queue/list") {
        const snapshot = session.native ? await session.native.snapshot() : await readPiSnapshot(join(this.options.directory, `${session.id}.sqlite`), join(this.options.dataDirectory ?? this.options.directory, "cache", "transcripts"));
        const cursor = params.cursor == null ? 0 : Number(params.cursor), limit = params.limit ?? 50;
        if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid Pi queue page");
        const queue = snapshot.queue ?? { items: [], paused: false };
        const data = queue.items.slice(cursor, cursor + Math.min(limit, 100)).map(item => queueProjection(item, queue.paused, queue.pauseReason));
        return { data, nextCursor: cursor + data.length < queue.items.length ? String(cursor + data.length) : null,
          ...(cursor === 0 ? { steering: snapshot.inbox.filter(item => item.mode === "steer").map(item => {
            const metadata = item.entry?.data ?? {};
            return { id: metadata.turnId, input: metadata.input, clientUserMessageId: metadata.clientId,
              createdAt: metadata.createdAtMs, pausedReason: null, targetTurnId: metadata.steerTurnId };
          }) } : {}) };
      }
      if (session.archived) throw new Error("Unarchive the Pi thread before changing its queue");
      const native = await this.native(session);
      const snapshot = await native.snapshot();
      const queued = snapshot.queue?.items.find(item => item.id === params.queuedSubmissionId);
      if (method === "thread/queue/add" || method === "thread/queue/update") {
        const clientId = method === "thread/queue/update" ? queued?.clientId : params.clientUserMessageId;
        if (typeof clientId !== "string" || !clientId.length || clientId.length > 1000) throw new Error("Queued input requires a valid client message identity");
        if (method === "thread/queue/update" && !queued) throw new Error("Queued input is no longer editable");
        const ref = selection(session.model), model = (await this.modelsRuntime).getModel(ref.provider, ref.modelId);
        if (!model) throw new Error("Pi model is unavailable");
        if (Array.isArray(params.input)) validatePiSkillInput(params.input, session.cwd, this.options.modelDirectory ?? this.options.directory);
        const additionalContext = queued?.additionalContext ?? params.additionalContext ?? null;
      const content = await this.compileInput(params.input, additionalContext, session.cwd, model);
        const executionAdmission = queued ? queued.executionAdmission : (typeof params.__opencraftExecutionAdmission === "string" && params.__opencraftExecutionAdmission.length <= 128 ? params.__opencraftExecutionAdmission : undefined);
        const item: PiQueuedInput = { ...(executionAdmission ? {executionAdmission} : {}), id: queued?.id ?? `${session.id}:turn:client:${clientId}`, clientId,
          input: params.input, content, additionalContext, createdAtMs: queued?.createdAtMs ?? Date.now(), state: "queued" };
        session.pendingRecovery = true; await this.save(session);
        const result = method === "thread/queue/add" ? await native.enqueue(item) : await native.changeQueue("update", item.id, item);
        this.queueOwners.set(item.id, client);
        await this.refresh(session);
        return { queuedSubmission: queueProjection(result as PiQueuedInput) };
      }
      if (method === "thread/queue/delete") {
        const deleted = await native.changeQueue("delete", params.queuedSubmissionId);
        this.queueOwners.delete(params.queuedSubmissionId); await this.refresh(session); return { deleted };
      }
      if (method === "thread/queue/reorder") {
        await native.changeQueue("reorder", undefined, undefined, params.queuedSubmissionIds); await this.refresh(session); return {};
      }
      if (method === "thread/queue/start") {
        if (queued) this.queueOwners.set(queued.id, client);
        return { turn: await this.dispatchQueue(session, params.queuedSubmissionId, true) };
      }
      if (method === "thread/queue/steer") {
        if (typeof params.expectedTurnId !== "string" || !params.expectedTurnId) throw new Error("Pi steer requires expectedTurnId");
        const id = params.queuedSubmissionId;
        if (typeof id !== "string" || !id) throw new Error("Pi steer requires a queued input identity");
        await native.steer(queued?.content ?? [], { turnId: id, steerTurnId: params.expectedTurnId, clientId: queued?.clientId,
          input: queued?.input, additionalContext: queued?.additionalContext ?? null, createdAtMs: queued?.createdAtMs ?? Date.now() }, id, params.expectedTurnId, id);
        this.queueOwners.delete(id); await this.refresh(session); return { turnId: params.expectedTurnId };
      }
      throw new Error(`Pi does not support ${method}`);
    }
    if (method === "turn/start") {
      const clientId = typeof params.clientUserMessageId === "string" && params.clientUserMessageId.length ? params.clientUserMessageId : null;
      if (clientId && clientId.length > 1000) throw new Error("Client message identity is too long");
      const turnId = clientId ? `${session.id}:turn:client:${clientId}` : `${session.id}:turn:${randomUUID()}`;
      await this.refresh(session);
      if (session.needsResume && session.active) {
        await (await this.native(session)).abort(); await this.refresh(session); session.needsResume = false;
      }
      const existing = clientId && session.turns?.find(turn => turn.id === turnId); if (existing) return { turn: existing };
      const queued = session.snapshot?.queue?.items.find(item => item.id === turnId);
      if (queued) {
        if (!isDeepStrictEqual(queued.input, params.input) || !isDeepStrictEqual(queued.additionalContext, params.additionalContext ?? null))
          throw new Error("Client message identity already belongs to different input");
        return { turn: await this.dispatchQueue(session, turnId, true) };
      }
      if (clientId && await (await this.native(session)).execution(turnId)) throw new Error("This message identity has already been withdrawn");
      if (session.active) throw new Error("Pi thread already has an active turn");
      if (session.archived) throw new Error("Unarchive the Pi thread before executing");
      await this.refreshHostTools(session, clientId ?? undefined);
      // Validate the full submission before applying persistent overrides.
      assertPiFields(params);
      const ref = selection(params.model ?? session.model), model = (await this.modelsRuntime).getModel(ref.provider, ref.modelId);
      if (!model) throw new Error("Pi model is unavailable");
      const cwd = await workspace(params, session.cwd);
      if (Array.isArray(params.input)) validatePiSkillInput(params.input, cwd, this.options.modelDirectory ?? this.options.directory);
      const content = await this.compileInput(params.input, params.additionalContext, cwd, model);
      const { native } = await this.configure(session, params, false, true);
      const createdAtMs = Date.now();
      const turn: PiTurn = { id: turnId, items: [{ type: "userMessage", id: `${turnId}:user`, clientId, content: params.input }], itemsView: "complete", status: "inProgress", error: null,
        startedAt: Math.floor(createdAtMs / 1000), completedAt: null, durationMs: null };
      if (canAdmit && !await canAdmit()) throw new ScheduleAdmissionDeferred();
      if (!this.admissionOpen()) throw new ScheduleAdmissionDeferred();
      session.active = turn; session.pendingRecovery = true;
      const previousPreview = session.preview, previousUpdated = session.updatedAt;
      session.preview ||= textOf(content).slice(0, 200); session.updatedAt = seconds();
      try {
        await this.save(session);
        if (!this.admissionOpen() || canAdmit && !await canAdmit()) {
          session.active = undefined; session.pendingRecovery = false;
          session.preview = previousPreview; session.updatedAt = previousUpdated;
          await this.save(session); throw new ScheduleAdmissionDeferred();
        }
        // A Host input does not replace the browser's separate tool lease.
        if (!canAdmit) this.attach(session, client);
        this.notify("turn/started", { threadId: session.id, turn });
        await native.submit(content, { turnId, clientId, input: params.input, additionalContext: params.additionalContext ?? null,
          createdAtMs, turnTrigger: params.turnTrigger ?? null }, turnId);
        await native.unpauseQueue();
        await this.refresh(session);
      } catch (error) { if (!(error instanceof ScheduleAdmissionDeferred)) this.fail(session, (error as Error).message); throw error; }
      return { turn: session.turns?.find(turn => turn.id === turnId) ?? turn };
    }
    if (method === "turn/steer") {
      if (typeof params.expectedTurnId !== "string" || !params.expectedTurnId) throw new Error("Pi steer requires expectedTurnId");
      const clientId = typeof params.clientUserMessageId === "string" && params.clientUserMessageId.length ? params.clientUserMessageId : null;
      if (clientId && clientId.length > 1000) throw new Error("Client message identity is too long");
      if (session.archived) throw new Error("Unarchive the Pi thread before executing");
      assertPiFields(params);
      const native = await this.native(session);
      const ref = selection(session.model), model = (await this.modelsRuntime).getModel(ref.provider, ref.modelId);
      if (!model) throw new Error("Pi model is unavailable");
      if (Array.isArray(params.input)) validatePiSkillInput(params.input, session.cwd, this.options.modelDirectory ?? this.options.directory);
      const content = await this.compileInput(params.input, params.additionalContext, session.cwd, model);
      const requestId = clientId ? `${params.expectedTurnId}:steer:client:${clientId}` : `${params.expectedTurnId}:steer:${randomUUID()}`;
      await native.steer(content, { turnId: requestId, steerTurnId: params.expectedTurnId, clientId, input: params.input,
        additionalContext: params.additionalContext ?? null, createdAtMs: Date.now() }, requestId, params.expectedTurnId);
      await this.refresh(session);
      return { turnId: params.expectedTurnId };
    }
    if (method === "turn/interrupt") {
      this.recovery?.handled(session.id);
      if (params.turnId && session.active?.id !== params.turnId) throw new Error("Pi turn identity changed");
      const native = await this.native(session); await native.changeQueue("pause");
      await native.abort(); await this.refresh(session); return {};
    }
    throw new Error(`Pi does not support ${method}`);
  }
  /** No execution owners are opened by inspection. Every durable ledger,
   * including archived sessions, contributes to the authority result. */
  async handoffObservation() {
    await this.load();
    let activeCount = this.operations.size + this.writes.size + this.queueDrains.size;
    let unknown = this.catalogUnknown;
    const workers: number[] = [], records: unknown[] = [];
    try {
      const files = await readdir(this.options.directory);
      for (const file of files) if (/^pi_.*\.sqlite$/u.test(file) && !this.sessions.has(file.slice(0, -7))) unknown = true;
      for (const session of this.sessions.values()) {
        if (session.starting || session.failed) unknown = true;
        const snapshot = session.ephemeral ? await session.native?.snapshot()
          : await readPiSnapshot(join(this.options.directory, `${session.id}.sqlite`), join(this.options.directory, "handoff-cache"));
        if (!snapshot) { unknown = true; continue; }
        if (session.native?.idleWorkerPid) workers.push(session.native.idleWorkerPid);
        if (!snapshot.live || typeof snapshot.live !== "object" || Array.isArray(snapshot.live) || !snapshot.agent || typeof snapshot.agent !== "object" || Array.isArray(snapshot.agent)
          || !Array.isArray(snapshot.inbox) || snapshot.queue && !Array.isArray(snapshot.queue.items) || snapshot.shell && !Array.isArray(snapshot.shell.records)) throw new Error("Invalid Pi native documents");
        if (!snapshot.privateCalls || typeof snapshot.privateCalls !== "object" || !snapshot.privateCalls.calls) throw new Error("Invalid Pi private call document");
        const privateCalls = snapshot.privateCalls.calls;
        if (!privateCalls || typeof privateCalls !== "object" || Array.isArray(privateCalls)) throw new Error("Invalid Pi private call custody");
        const callStates = Object.values(privateCalls);
        if (callStates.some(row => !row || !["pending", "unknown"].includes(row.state) || row.state === "unknown") || callStates.length > 0 && !session.native) unknown = true;
        const active = callStates.length + (session.native?.backgroundWork ?? 0) + Number(!!snapshot.live.run) + Number(!!snapshot.live.generation)
          + (snapshot.live.tools?.length ?? 0) + (snapshot.live.nestedTools?.length ?? 0)
          + (snapshot.live.compactions?.length ?? 0) + snapshot.inbox.length
          + (snapshot.queue?.items.length ?? 0)
          + [...snapshot.tasks.values()].filter(task => task.state.status !== "terminal").length
          + snapshot.submissions.filter(row => ["queued", "placed"].includes(row.status)).length
          + (snapshot.shell?.records.filter(row => row.state === "running" || row.detached && !row.notified || !!row.monitorEvents?.length).length ?? 0)
          + Number(!!session.active);
        activeCount += active;
        // Summaries are bound to native state without exposing history content.
        records.push({ id: session.id, active, entries: snapshot.entries.length, submissions: snapshot.submissions.length,
          history: createHash("sha256").update(JSON.stringify(projectPiSnapshot(session, snapshot))).digest("hex") });
      }
      const schedules = this.scheduleService?.handoffObservation();
      if (!schedules) unknown = true;
      else activeCount += schedules.flights + schedules.plans + schedules.unfinished;
      const recovery = this.recovery?.handoffObservation();
      if (!recovery) unknown = true;
      else activeCount += recovery.flights + recovery.unfinished;
    } catch { unknown = true; }
    return { coverage: unknown ? "unknown" : "complete", activeCount: unknown ? null : activeCount, workers, records,
      capabilities: { goals: "unsupported-pi-1.3.0", approvals: "never", privateTools: "native-task-run-and-durable-call-custody", im: "host-input-admission" } };
  }
  async resumeBackground() {
    if (!this.admissionOpen()) throw new Error("Pi admission is fenced");
    this.schedules().start(); this.recovery?.wake();
    for (const session of this.sessions.values()) { this.scheduleQueue(session); await session.native?.resumeBackground(); }
  }
  private detach(session: Session) { session.lease?.abort(); session.lease = undefined; session.owner = undefined; }
  disconnect(client: EngineClient) {
    for (const reader of this.historyReaders.get(client) ?? []) reader.abort(new Error("Pi history reader disconnected"));
    this.historyReaders.delete(client);
    for (const [id, owner] of this.queueOwners) if (owner === client) this.queueOwners.delete(id);
    for (const session of this.sessions.values()) if (session.owner === client) this.detach(session);
  }
  async close() {
    this.closed = true;
    for (const readers of this.historyReaders.values()) for (const reader of readers) reader.abort(new Error("Pi engine is closed"));
    this.historyReaders.clear();
    await this.recovery?.close();
    await this.scheduleService?.close();
    await Promise.all(this.operations.values());
    await Promise.all([...this.sessions.values()].map(async session => {
      this.detach(session); const native = session.native ?? await session.starting?.catch(() => undefined); await native?.close(); session.active = undefined;
    }));
    await Promise.all(this.writes.values()); this.listeners.clear();
    await this.transcriptCache.close();
  }
}
