import { nodeObserver } from "../../../packages/observability-contract/node.mjs";
import type { SessionCapabilityPort } from "@opencraft/session-capabilities";
import type { HostInputPort } from "@opencraft/appserver-protocol/host-inputs";
import { ConversationSchedules, ScheduleFault, type ScheduleExecutionPort } from "@opencraft/host-schedules";
import { OPENCRAFT_PERMISSION_MODES_EXTENSION, OPENCRAFT_PERMISSION_MODES_CAPABILITY, CONVERSATION_SCHEDULES_EXTENSION } from "@opencraft/appserver-protocol";
import { AppServerRpcError, projectedTurnsPage, projectedItemsPage, projectedHistoryHeadCursors } from "@opencraft/appserver-client";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { PiDurableSession, createPiModels, type PiSnapshot, type PiForkContext } from "./session.js";
import { assertPiFields, compareThreads, fullAccessProfile, piModel, selection, thinking, workspace } from "./contract.js";
import { compilePiInput } from "./input.js";
import { piSkillCatalog, validatePiSkillInput } from "./skills.js";
import { projectPiSnapshot, tokenUsage, textOf, type PiTurn } from "./projection.js";
import type { ExecutionEngineClient as EngineClient } from "@opencraft/appserver-client";
export { piModel } from "./contract.js";

type Value = Record<string, any>;
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
  readonly extensions = Object.freeze({
    "opencraft/thread-lifecycle": { version: 1, fork: false, ephemeralFork: true, ephemeral: true, injectItems: true, rename: true, archive: true, unsubscribe: true, pin: true },
    "opencraft/host-capabilities": { version: 1 },
    "opencraft/scoped-model-catalog": { version: 1 },
    "opencraft/resume-history": { version: 1, mode: "paginated", initialTurnsPage: true },
    [OPENCRAFT_PERMISSION_MODES_EXTENSION]: OPENCRAFT_PERMISSION_MODES_CAPABILITY,
    [CONVERSATION_SCHEDULES_EXTENSION]: { version: 1, target: "existing-thread", repeat: "fixed-interval", summary: true, calendar: true },
    "opencraft/thread-follow-up": { version: 1, queue: false, steer: false },
  });
  private scheduleService?: ConversationSchedules;
  get storageOutcomes(): readonly unknown[] { return this.scheduleService ? [{ name: "pi-conversation-schedules", outcome: this.scheduleService.outcome }] : []; }
  private permissionProfiles() { return [{ id: fullAccessProfile, description: "Pi Full access", allowed: true, openCraftMode: "full" as const, openCraftLabel: "Full access" }]; }
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(method: string, params: Value) => void>();
  private loading?: Promise<void>;
  private closed = false;
  private readonly writes = new Map<string, Promise<void>>();
  private latestPinAt = 0;
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly modelsRuntime: ReturnType<typeof createPiModels>;
  private resolvedModels?: Awaited<ReturnType<typeof createPiModels>>;
  constructor(private readonly options: { directory: string; cwd: string; modelDirectory?: string; models?: Awaited<ReturnType<typeof createPiModels>>; configuration?: PiModelConfiguration; sessionCapabilities?: SessionCapabilityPort }) {
    nodeObserver("pi", { processResources: false });
    this.modelsRuntime = (options.models ? Promise.resolve(options.models) : createPiModels(options.modelDirectory ?? options.directory))
      .then(models => { this.resolvedModels = models; return models; });
  }
  ownsThread(id: string) { return id.startsWith("pi_"); }
  ownsModel(id: string) { return id.startsWith("pi:"); }
  subscribe(listener: (method: string, params: Value) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(method: string, params: Value) { nodeObserver("pi").execution("pi", method, params); for (const listener of this.listeners) listener(method, params); }
  private load() {
    return this.loading ??= (async () => {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      for (const file of await readdir(this.options.directory)) {
        if (!/^pi_[a-f0-9-]+\.json$/u.test(file)) continue;
        try {
          const record = JSON.parse(await readFile(join(this.options.directory, file), "utf8"));
          if (record.format !== "pi-durable-1" || `${record.id}.json` !== file || !Array.isArray(record.tools)) throw new Error("Invalid Pi session index");
          this.sessions.set(record.id, record);
        } catch {
          // Retain corrupt metadata and its ledger for repair; one record cannot disable all Pi sessions.
          this.notify("warning", { message: `Pi session index could not be loaded: ${file}` });
        }
      }
    })();
  }
  async start() {
    await this.load(); await this.modelsRuntime; await this.options.configuration?.synchronize();
    this.schedules();
    for (const session of this.sessions.values()) {
      if (!session.pendingRecovery || session.archived) continue;
      try { const native = await this.native(session); await this.refresh(session); if (session.active) native.resume(); }
      catch { this.fail(session, "Pi session recovery failed"); }
    }
  }
  private save(session: Session, pinState?: Pick<Session, "pinned" | "pinnedAt">): Promise<void> {
    if (session.ephemeral) return Promise.resolve();
    const { native: _native, starting: _starting, owner: _owner, lease: _lease, active: _active, turns: _turns,
      snapshot: _snapshot, effort: _effort, failed: _failed, hostTools: _hostTools, ...record } = session;
    const file = join(this.options.directory, `${session.id}.json`), temporary = `${file}.${randomUUID()}.tmp`;
    const operation = (this.writes.get(session.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      // Native snapshots can queue metadata while a pin write is pending. Read
      // the committed pin fields when this write runs, not when it is queued.
      const next = { ...record, ...(pinState ?? { pinned: session.pinned, pinnedAt: session.pinnedAt }) };
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 }); await rename(temporary, file);
      } catch (error) {
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
    const tools = structuredClone(this.options.sessionCapabilities?.tools(session.id) ?? []).map(tool => ({ ...tool, namespace: null, piName: `opencraft_host_${tool.name}` }));
    if (session.tools.some(tool => tools.some(host => identity(host) === identity(tool)))) throw new Error("Capability name reserved by Host");
    session.hostTools = tools;
    return tools;
  }
  private async refreshHostTools(session: Session): Promise<void> {
    await this.options.sessionCapabilities?.refresh?.(session.id);
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
    if (session.ephemeral && session.failed) throw new Error("Temporary Pi session is no longer available");
    return session.starting ??= (async () => {
      const native = await PiDurableSession.open({ cwd: session.cwd, file: join(this.options.directory, `${session.id}.sqlite`),
        ephemeral: session.ephemeral, inherited: session.inherited,
        agentDirectory: this.options.modelDirectory ?? this.options.directory, models: await this.modelsRuntime, tools: [...session.tools, ...this.hostTools(session)],
        onSnapshot: snapshot => this.accept(session, snapshot),
        onTool: async (request, signal) => {
          const hostTool = session.hostTools?.find(tool => tool.piName === request.name);
          if (hostTool) {
            if (!session.active) throw new Error("No active Pi execution");
            return this.options.sessionCapabilities!.call(session.id, hostTool.name, request.arguments, signal);
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
          this.fail(session, error.message); void failed?.close();
        },
      });
      try {
        const snapshot = await native.snapshot();
        // Old indexes predate AgentDoc configuration. Bootstrap once; afterwards the native document wins.
        if (!snapshot.agent.model) await native.configure({ model: selection(session.model), cwd: session.cwd });
        if (this.closed) throw new Error("Pi engine is closed");
        session.native = native; session.inherited = undefined; session.failed = false;
        this.accept(session, await native.snapshot()); return native;
      } catch (error) { await native.close(); throw error; }
      finally { session.starting = undefined; }
    })();
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
      if (!before && turn.status === "inProgress" && oldActive?.id !== turn.id) this.notify("turn/started", { threadId: session.id, turn });
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
      session.updatedAt = seconds(); session.pendingRecovery = false;
      void this.save(session).catch(() => this.notify("warning", { message: "Pi catalog metadata could not be saved" }));
    }
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
  private async configure(session: Session, params: Value, initial = false) {
    assertPiFields(params);
    const cwd = await workspace(params, session.cwd);
    const modelId = params.model ?? session.model;
    const ref = selection(modelId), model = (await this.modelsRuntime).getModel(ref.provider, ref.modelId);
    if (!model) throw new Error("Pi model is unavailable");
    if (params.modelProvider != null && !["pi", ref.provider].includes(params.modelProvider)) throw new Error("modelProvider does not match the selected Pi model");
    const explicit = params.effort ?? params.config?.model_reasoning_effort;
    const effort = thinking(model, explicit ?? session.effort, explicit != null);
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
    receipt: async (threadId, inputId) => {
      const session = await this.session(threadId), turnId = `${threadId}:turn:client:${inputId}`;
      return await (await this.native(session)).execution(turnId) ? { state: "delivered", turnId } : null;
    },
    submit: (threadId, inputId, text, canAdmit) => this.serialize(threadId, async () => {
      const prior = await this.inputs.receipt(threadId, inputId); if (prior) return prior;
      const session = await this.session(threadId);
      if (session.archived || session.ephemeral) return { state: "discarded", turnId: null };
      if (session.active || !await canAdmit()) return null;
      const owner: EngineClient = { notify() {}, request: async () => { throw new Error("No browser tool owner"); } };
      try {
        await this.handle("turn/start", { threadId, clientUserMessageId: inputId, input: [{ type: "text", text }] }, owner, canAdmit);
        return await this.inputs.receipt(threadId, inputId) ?? { state: "unknown", turnId: null };
      } catch (error) {
        if (error instanceof ScheduleAdmissionDeferred) return null;
        return await this.inputs.receipt(threadId, inputId) ?? { state: "unknown", turnId: null };
      }
    }),
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
          if (session.active || !canAdmit()) return { state: "waiting" };
          try {
            const result = await this.handle("turn/start", { threadId: run.threadId, clientUserMessageId: run.id,
              permissions: run.permissions, input: [{ type: "text", text: `[Scheduled task]\n${prompt}` }] }, owner, canAdmit);
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
        () => this.notify("opencraft/schedules/changed", {}));
      this.scheduleService.start();
    }
    return this.scheduleService;
  }
  request(method: string, params: Value, client: EngineClient): Promise<any> {
    // Schedule mutations must not wait behind the admission they need to cancel.
    const key = method.startsWith("opencraft/schedules/") ? undefined
      : typeof params.threadId === "string" ? params.threadId : method.startsWith("config/") ? "config" : undefined;
    return key === undefined ? this.handle(method, params, client) : this.serialize(key, () => this.handle(method, params, client));
  }
  private async handle(method: string, params: Value, client: EngineClient, canAdmit?: () => boolean | Promise<boolean>): Promise<any> {
    await this.load(); if (this.closed) throw new Error("Pi engine is closed");
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
      assertPiFields(params);
      if (params.projectId != null && (typeof params.projectId !== "string" || !params.projectId.trim())) throw new Error("Invalid workspace project identity");
      const saved = await this.defaults(), model = params.model ?? saved.model ?? (await this.models()).find(model => model.isDefault)?.model;
      selection(model ?? "");
      const session: Session = { format: "pi-durable-1", id: `pi_${randomUUID()}`, cwd: await workspace(params, this.options.cwd), model,
        projectId: params.projectId ?? null, threadSource: params.threadSource ?? null, sessionStartSource: params.sessionStartSource ?? null,
        ephemeral: params.ephemeral === true, name: null, preview: "", createdAt: seconds(), updatedAt: seconds(), archived: false, effort: saved.effort, tools: flattenPiTools(params.dynamicTools ?? []) };
      this.attach(session, client); this.sessions.set(session.id, session);
      try {
        await this.configure(session, params, true);
        await this.save(session); return this.response(session);
      } catch (error) { this.sessions.delete(session.id); await session.native?.close(); throw error; }
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
    if (method === "thread/read") { if (params.includeTurns) await this.refresh(session); return { thread: this.thread(session, params.includeTurns ? session.turns : []) }; }
    if (method === "thread/turns/list" || method === "thread/items/list") {
      await this.refresh(session);
      const thread = this.thread(session, session.turns);
      return method === "thread/turns/list" ? { ...projectedTurnsPage(thread, { ...params, threadId: session.id }), itemsPaginationByTurnId: {} }
        : projectedItemsPage(thread, { ...params, threadId: session.id });
    }
    if (method === "thread/resume") {
      if (session.archived) throw new AppServerRpcError({ code: -32071, message: "Pi thread is archived", data: { code: "THREAD_ARCHIVED", retryable: false } });
      if (params.path && params.path !== join(this.options.directory, `${session.id}.sqlite`)) throw new Error("Pi path must match this thread's native ledger");
      await this.refresh(session); const { native } = await this.configure(session, params);
      if (!session.owner || !session.active) this.attach(session, client);
      native.resume();
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
    if (method === "turn/start") {
      const clientId = typeof params.clientUserMessageId === "string" && params.clientUserMessageId.length ? params.clientUserMessageId : null;
      if (clientId && clientId.length > 1000) throw new Error("Client message identity is too long");
      const turnId = clientId ? `${session.id}:turn:client:${clientId}` : `${session.id}:turn:${randomUUID()}`;
      await this.refresh(session);
      const existing = clientId && session.turns?.find(turn => turn.id === turnId); if (existing) return { turn: existing };
      if (session.active) throw new Error("Pi thread already has an active turn");
      if (session.archived) throw new Error("Unarchive the Pi thread before executing");
      await this.refreshHostTools(session);
      // Validate the full submission before applying persistent overrides.
      assertPiFields(params);
      const ref = selection(params.model ?? session.model), model = (await this.modelsRuntime).getModel(ref.provider, ref.modelId);
      if (!model) throw new Error("Pi model is unavailable");
      const cwd = await workspace(params, session.cwd);
      if (Array.isArray(params.input)) validatePiSkillInput(params.input, cwd, this.options.modelDirectory ?? this.options.directory);
      const content = await compilePiInput(params.input, params.additionalContext, cwd, model);
      const { native } = await this.configure(session, params);
      const createdAtMs = Date.now();
      const turn: PiTurn = { id: turnId, items: [{ type: "userMessage", id: `${turnId}:user`, clientId, content: params.input }], itemsView: "complete", status: "inProgress", error: null,
        startedAt: Math.floor(createdAtMs / 1000), completedAt: null, durationMs: null };
      if (canAdmit && !await canAdmit()) throw new ScheduleAdmissionDeferred();
      session.active = turn; session.pendingRecovery = true;
      const previousPreview = session.preview, previousUpdated = session.updatedAt;
      session.preview ||= textOf(content).slice(0, 200); session.updatedAt = seconds();
      try {
        await this.save(session);
        if (canAdmit && !await canAdmit()) {
          session.active = undefined; session.pendingRecovery = false;
          session.preview = previousPreview; session.updatedAt = previousUpdated;
          await this.save(session); throw new ScheduleAdmissionDeferred();
        }
        // A Host input does not replace the browser's separate tool lease.
        if (!canAdmit) this.attach(session, client);
        this.notify("turn/started", { threadId: session.id, turn });
        await native.submit(content, { turnId, clientId, input: params.input, additionalContext: params.additionalContext ?? null,
          createdAtMs, turnTrigger: params.turnTrigger ?? null }, turnId);
        await this.refresh(session);
      } catch (error) { if (!(error instanceof ScheduleAdmissionDeferred)) this.fail(session, (error as Error).message); throw error; }
      return { turn: session.turns?.find(turn => turn.id === turnId) ?? turn };
    }
    if (method === "turn/interrupt") {
      if (params.turnId && session.active?.id !== params.turnId) throw new Error("Pi turn identity changed");
      if (!session.active) return {};
      await (await this.native(session)).abort(); await this.refresh(session); return {};
    }
    throw new Error(`Pi does not support ${method}`);
  }
  private detach(session: Session) { session.lease?.abort(); session.lease = undefined; session.owner = undefined; }
  disconnect(client: EngineClient) { for (const session of this.sessions.values()) if (session.owner === client) this.detach(session); }
  async close() {
    this.closed = true;
    await this.scheduleService?.close();
    await Promise.allSettled(this.operations.values());
    await Promise.allSettled([...this.sessions.values()].map(async session => {
      this.detach(session); const native = session.native ?? await session.starting?.catch(() => undefined); await native?.close(); session.active = undefined;
    }));
    await Promise.allSettled(this.writes.values()); this.listeners.clear();
  }
}
