import { assertModelPolicy, ModelPolicyError } from '@opencraft/model-usage-policy/native';
import { EXECUTION_ENVIRONMENT_FIELD, type ExecutionEnvironmentRuntime, type ExecutionEnvironmentSnapshot, type EnvironmentExecutionScope } from "../../../scripts/execution-environment.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentOrchestrationPort, ExecutionEngineClient, ExecutionEngineProvider } from "@opencraft/appserver-client";
import { AppServerRpcError } from "@opencraft/appserver-client";
import { MODEL_CATALOG_REFRESH_EXTENSION, MODEL_CATALOG_REFRESH_METHOD, OPENCRAFT_PERMISSION_MODES_EXTENSION, OPENCRAFT_PERMISSION_MODES_CAPABILITY, parsePermissionModeProfileId, permissionModeProfileId, type NativeConversationProject } from "@opencraft/appserver-protocol";
import type { HostInputPort, HostInputReceipt } from "@opencraft/appserver-protocol/host-inputs";
import type { ToolRequestUserInputParams } from "@opencraft/appserver-protocol/generated/v2";
import { AcpStdioTransport, AcpProtocolError, type AcpObject as Value } from "./transport.js";
import { codexBaseModelId, splitModelVariant } from "./model-variant.js";
import { acpPromptContent } from "./prompt-content.js";
import { emptyAcpQueue, validateAcpQueue, acpQueueFingerprint, acpQueueProjection, type AcpQueue } from "./queue.js";

import { readCodexPermissionConfig, acpPermissionProfiles, codexAcpPermissionSettings, type AcpPermissionConfig } from "./permissions.js";
import { parseCodexQuestionForm } from "./codex-questions.js";

export interface AcpEngineOptions {
  executionEnvironment?: ExecutionEnvironmentRuntime;
  id?: "acp" | "dsh-acp" | "claude-code" | "cursor" | "gemini" | "codebuddy" | "codebuddy-ide" | "codex" | "pi-cli";
  protocol?: "acp" | "pi-rpc";
  /** Stable storage namespace for separate native data homes of the same provider. */
  threadNamespace?: string;
  timeoutMs?: number;
  label?: string;
  command: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd: string;
  modelPolicyPath?: string;
  dataDirectory: string;
  requestUserInput?(params: ToolRequestUserInputParams, signal: AbortSignal,
    project: (result: Record<string, unknown>) => unknown): Promise<unknown>;
  /** An engine-native reader; opening history must never issue session/resume. */
  history?: {
    read(nativeSessionId: string, params: Value): Promise<{ data: any[]; nextCursor: string | null }>;
    items?(nativeSessionId: string, params: Value): Promise<Value>;
    snapshot?(nativeSessionId: string, params: Value): Promise<any[]>;
    validateResume?(nativeSessionId: string, cwd: string): Promise<void>;
    sessionPath?(nativeSessionId: string, nativeHistoryEmpty?: boolean): Promise<string | null>;
    usage?(nativeSessionId: string): Promise<Value | null>;
    directory?(cursor?: string, archived?: boolean): Promise<{available:boolean;sessions:{sessionId:string;cwd:string;title:string|null;updatedAt:string|null;createdAt?:string}[];nextCursor:string|null}>;
    projects?(threads: readonly { id: string; cwd: string }[]): Promise<{ available: boolean; groups: Record<string, NativeConversationProject | null> }>;
    export?(nativeSessionId: string, params: Value): Promise<import("@opencraft/appserver-protocol").AgentConversationContinuation>;
    close?(): Promise<void>;
  };
  permission?: "allow-once" | "reject";
  reconnectWindowMs?: number;
}
interface Session {
  schemaVersion: 1; id: string; nativeId: string; cwd: string; model: string | null; name: string | null;
  createdAt: number; updatedAt: number; tools: Value[]; archived: boolean;
  preview?: string;
  nativeImport?: true;
  nativeHistoryEmpty?: true;
  catalogProbe?: true;
  forkedFromId?: string;
  nativeProject?: NativeConversationProject;
  nameOrigin?: "input" | "agent" | "manual";
  contextUsage?: { usedTokens: number; limitTokens: number; observedAt: number };
  permissionConfig?: AcpPermissionConfig;
  permissionSelection?: string;
  modelConfigId?: string;
  modelConfigValues?: string[];
  legacyModelCatalog?: boolean;
  reasoningConfig?: { id: string; currentValue: string; values: string[] };
  reasoningModels?: Record<string, { supportedReasoningEfforts: { reasoningEffort: string; description: string }[]; defaultReasoningEffort: string | null }>;
  parameterConfigs?: { id: string; currentValue: string; values: string[] }[];
  fastConfig?: { id: string; type: "boolean" | "select"; currentValue: string | boolean; onValue: string | boolean; offValue: string | boolean };
  fastModels?: Record<string, boolean>;
  modelCatalog?: {id:string;name:string;inputModalities?: ("text" | "image")[]}[];
  inputModalities?: ("text" | "image")[];
  inputModalitiesObservedAt?: number;
  receipts: Record<string, HostInputReceipt>;
  lastTurn?: { id: string; status: string; clientUserMessageId?: string };
  queue?: AcpQueue;
}
export type AcpOrchestrationPort = AgentOrchestrationPort;
interface Runtime {
  questionLifetime?: AbortController;
  owner?: ExecutionEngineClient; loaded: boolean; permissionConfirmed?: boolean; active?: { id: string; delegationId: string | null; inputId?: string; items: Value[]; status: string; startedAtMs?: number; planSignature?: string; error?: Value };
}
interface Creation {
  fingerprint: string; state: "pending" | "created"; threadId?: string;
  preparation?: { fingerprint: string; settings: Value };
}
const value = (input: unknown): Value => input && typeof input === "object" && !Array.isArray(input) ? input as Value : {};
const fault = (message: string, code = -32602): never => { throw new AppServerRpcError({ code, message }); };
const safeId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(id);

/** A long-lived ACP owner shared by standard ACP peers, DSH ACP and Claude ACP.
 * A provider is enabled only with an explicit installed command; no CLI is
 * downloaded, and no engine is started inside the execution gateway.
 */
export class AcpEngine implements ExecutionEngineProvider {
  readonly id: "acp" | "dsh-acp" | "claude-code" | "cursor" | "gemini" | "codebuddy" | "codebuddy-ide" | "codex" | "pi-cli";
  readonly label: string;
  readonly threadPrefix: string;
  readonly modelPrefix: string;
  readonly incarnation = randomUUID();
  private readonly baseExtensions: Readonly<Record<string, unknown>>;
  get extensions(): Readonly<Record<string, unknown>> { return { ...this.baseExtensions, ...(this.orchestration ? {
    "opencraft/thread-orchestration": { version: 1, driver: this.id === "dsh-acp" ? "dsh" : this.id, callbackReplay: true },
  } : {}) }; }
  readonly inputs: HostInputPort;
  private transport: AcpStdioTransport;
  private readonly sessionTransports = new Map<string, AcpStdioTransport>();
  private readonly sessionEnvironments = new Map<string, ExecutionEnvironmentSnapshot>();
  private native(session: Session): AcpStdioTransport { return this.sessionTransports.get(session.id) ?? this.transport; }
  get processIds(): number[] { return [this.transport, ...this.sessionTransports.values()].flatMap(transport => transport.pid ? [transport.pid] : []); }
  private readonly sessions = new Map<string, Session>();
  private readonly pendingMcp = new Map<string, Session>();
  private readonly runtime = new Map<string, Runtime>();
  private readonly creations = new Map<string, Creation>();
  private readonly preparations = new Map<string, { fingerprint: string; settings: Value }>();
  private readonly creating = new Map<string, Promise<any>>();
  private readonly inputCalls = new Map<string, Promise<HostInputReceipt | null>>();
  private readonly threadAdmissions = new Map<string, Promise<unknown>>();
  private readonly queueDrains = new Map<string, Promise<void>>();
  private readonly queueOwners = new Map<string, ExecutionEngineClient>();
  private readonly listeners = new Set<(method: string, params: Value) => void>();
  private loaded: Promise<void> | null = null;
  private persistence: Promise<void> = Promise.resolve();
  private persistenceFailed = false;
  private nativeOutcomeUnknown = false;
  private started: Promise<void> | null = null;
  private capabilities: Value = {};
  private catalogSessionId: string | null = null;
  private catalogRefresh: Promise<Value> | null = null;
  private inputModalities: ("text" | "image")[] | null = null;
  private toolServer?: Server;
  private toolUrl = "";
  private readonly toolToken = randomUUID();
  private readonly callbacks = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  private closed = false;
  private orchestration?: AcpOrchestrationPort;
  private activeCallbacks = 0;
  private activeAdmissions = 0;
  private suspending = false;
  private readonly callbackAbort = new AbortController();
  setOrchestration(port: AcpOrchestrationPort): void { this.orchestration = port; }
  get driverKind(): "acp" | "claude-code" { return this.id === "claude-code" ? "claude-code" : "acp"; }
  get occupancy() {
    return { nativeOutcomeUnknown: this.nativeOutcomeUnknown ? 1 : 0, storageUnknown: this.persistenceFailed ? 1 : 0, unconfirmedTurns: [...this.sessions.values()].filter(session => { const active = this.runtime.get(session.id)?.active; return active ? active.status === "unconfirmed" : session.lastTurn?.status === "inProgress"; }).length, ...Object.fromEntries(Object.keys(this.transport.occupancy).map(key => [key, [this.transport, ...this.sessionTransports.values()].reduce((count, transport) => count + (transport.occupancy as Record<string, number>)[key], 0)])), activeTurns: [...this.runtime.values()].filter(state => state.active?.status === "inProgress").length,
      pendingCallbacks: this.activeCallbacks, pendingCreations: this.creations.size, preparedTickets: this.preparations.size, activeAdmissions: this.activeAdmissions,
      queuedInputs: [...this.sessions.values()].reduce((sum, session) => sum + (session.queue?.items.length ?? 0), 0),
      unconfirmedInputs: [...this.sessions.values()].reduce((sum, session) => sum + Object.values(session.receipts).filter(receipt => receipt.state === "unknown").length, 0) };
  }
  constructor(private readonly options: AcpEngineOptions) {
    if (!isAbsolute(options.cwd) || !isAbsolute(options.dataDirectory) || !options.command.trim()) throw new Error("ACP requires explicit absolute workspace and data paths and an installed command");
    this.id = options.id ?? "acp";
    this.label = options.label ?? (this.id === "claude-code" ? "Claude Code" : this.id === "gemini" ? "Gemini" : this.id === "dsh-acp" ? "DSH" : this.id === "cursor" ? "Cursor" : this.id === "codebuddy-ide" ? "CodeBuddy IDE" : this.id === "codebuddy" ? "CodeBuddy CLI" : this.id === "codex" ? "Codex" : "Agent");
    if (options.threadNamespace && !/^[a-z0-9_]+$/u.test(options.threadNamespace)) throw new Error("Invalid thread namespace");
    this.threadPrefix = options.threadNamespace ?? (this.id === "claude-code" ? "claude_" : this.id.replaceAll("-", "_") + "_");
    this.modelPrefix = this.id + ":";
    this.baseExtensions = Object.freeze({
      ...(["codex", "cursor", "gemini"].includes(this.id) ? { [MODEL_CATALOG_REFRESH_EXTENSION]: { version: 1 } } : {}),
      ...(this.id === "codex" ? { [OPENCRAFT_PERMISSION_MODES_EXTENSION]: OPENCRAFT_PERMISSION_MODES_CAPABILITY } : {}),
      "opencraft/thread-lifecycle": { version: 1, rename: true, archive: true, unsubscribe: true },
      "opencraft/thread-follow-up": { version: 1, queue: true, steer: false },
      "opencraft/thread-queue": { version: 2, reorder: true, atomicSteer: false, perItemPause: false },
      ...(options.history ? { "opencraft/read-history": { version: 1, initialTurnsPage: true } } : {}),
      "opencraft/agent-driver": { version: 1, kind: this.id === "claude-code" ? "claude-code" : "acp", incarnation: this.incarnation, callbackReplay: true },
    });
    this.transport = this.createTransport();
    this.inputs = {
      receipt: async (id, inputId) => { await this.load(); return this.session(id).receipts[inputId] ?? null; },
      submit: (id, inputId, text, canAdmit) => this.submitInput(id, inputId, text, canAdmit),
    };
  }
  private async serializeThread<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.threadAdmissions.get(id), pending = (previous ?? Promise.resolve()).catch(() => {}).then(operation);
    this.threadAdmissions.set(id, pending);
    try { return await pending; } finally { if (this.threadAdmissions.get(id) === pending) this.threadAdmissions.delete(id); }
  }
  private submitInput(id: string, inputId: string, text: string, canAdmit: () => boolean | Promise<boolean>): Promise<HostInputReceipt | null> {
    const key = JSON.stringify([id, inputId]), existing = this.inputCalls.get(key);
    if (existing) return existing;
    const pending = this.admit(() => this.serializeThread(id, async () => {
        await this.load(); const session = this.session(id), known = session.receipts[inputId];
        if (known) return known;
        if (!await canAdmit()) return null;
        const reconciled = session.receipts[inputId]; if (reconciled) return reconciled;
        const runtime = this.state(id);
        if (runtime.active?.status === "inProgress") return null;
        // Persist uncertainty before a native mutation, so Host death never
        // turns an accepted input into a blind second prompt.
        session.receipts[inputId] = { state: "unknown", turnId: null }; await this.save(session);
        if (!await canAdmit() || runtime.active?.status === "inProgress") { delete session.receipts[inputId]; await this.save(session); return null; }
        let result;
        try { result = await this.prompt(session, [{ type: "text", text }], null, inputId); }
        catch(error) {
          if (error instanceof ModelPolicyError) { delete session.receipts[inputId]; await this.save(session); }
          throw error;
        }
        const receipt: HostInputReceipt = { state: "delivered", turnId: result.turn.id };
        session.receipts[inputId] = receipt; await this.save(session); return receipt;
    }));
    this.inputCalls.set(key, pending);
    void pending.finally(() => { if (this.inputCalls.get(key) === pending) this.inputCalls.delete(key); }).catch(() => {});
    return pending;
  }
  private createTransport(environment?: ExecutionEnvironmentSnapshot, threadId?: string, cwd?: string, nativeId?: string, nativePath?: string): AcpStdioTransport {
    return new AcpStdioTransport({ ...this.options,
      ...(["pi-cli", "codebuddy"].includes(this.id) ? { cwd: cwd ?? this.options.cwd } : {}),
      ...(this.id === "pi-cli" ? { args: [...(this.options.args ?? []), ...(nativePath ? ["--session", nativePath] : nativeId ? ["--session-id", nativeId] : [])] } : {}),
      parameterizedModelPicker: this.id === "cursor",
      formElicitation: this.id === "codex" && this.options.requestUserInput !== undefined,
      ...(this.id === "codebuddy" ? { sandboxOwner: "codebuddy" } : {}),
      env: environment?.apply({ ...process.env, ...this.options.env }) ?? this.options.env,
      redactError: environment ? message => environment.redact(message) : undefined,
      onNotification: (method, params) => this.update(method, params, threadId),
      onRequest: async (method, params, signal) => {
        if (method === "elicitation/create" && this.id === "codex" && this.options.requestUserInput) {
          const form = parseCodexQuestionForm(params);
          const session = [...this.sessions.values()].find(entry => entry.nativeId === params.sessionId && (!threadId || entry.id === threadId));
          const runtime = session && this.state(session.id);
          const active = runtime?.active;
          if (!form || !session || !runtime || active?.status !== "inProgress") return { action: "cancel" };
          const lifetime = runtime.questionLifetime ??= new AbortController();
          const questionSignal = AbortSignal.any([signal, lifetime.signal]);
          try {
            return await this.options.requestUserInput({
              threadId: session.id, turnId: active.id, itemId: `acp-question-${randomUUID()}`,
              questions: form.questions, isBlocking: form.isBlocking, autoResolutionMs: null,
            }, questionSignal, form.reply);
          } catch (error) {
            if (questionSignal.aborted) return { action: "cancel" };
            throw error;
          }
        }
        if (method !== "session/request_permission") return fault("Unsupported ACP client request", -32601);
        const choices = Array.isArray(params.options) ? params.options : [];
        const session = [...this.sessions.values()].find(session => session.nativeId === params.sessionId && (!threadId || session.id === threadId));
        const mayAllow = this.id !== "codex" || session && this.state(session.id).permissionConfirmed
          && session.permissionConfig?.currentValue === "agent-full-access";
        const choice = mayAllow && this.options.permission === "allow-once" && choices.find((entry: Value) => entry.kind === "allow_once");
        return { outcome: choice ? { outcome: "selected", optionId: choice.optionId } : { outcome: "cancelled" } };
      },
      onUnconfirmed: () => {
        this.nativeOutcomeUnknown = true;
        void this.persistJson(join(this.options.dataDirectory, "native-uncertainty.json"), { unknown: true }).catch(() => {});
      },
      onExit: () => {
        for (const [id, state] of this.runtime) if (!threadId || threadId === id) { state.permissionConfirmed = false; state.loaded = false; }
        for (const [id, state] of this.runtime) if ((!threadId || threadId === id) && state.active?.status === "inProgress") {
          void this.failPrompt(this.session(id), state, "acpPromptUnconfirmed").catch(() => { this.persistenceFailed = true; });
          state.loaded = false;
        }
      },
    });
  }
  async ownsOperation(operationId: string): Promise<boolean> { await this.load(); return this.preparations.has(operationId) || this.creations.has(operationId); }
  async catalogThreadIds(): Promise<readonly string[]> { await this.load(); return [...this.sessions.keys()]; }
  get processId(): number | null { return this.transport.pid; }
  /** Private owner observation. Does not attach a client, resume or wake native. */
  executionObservation(threadId: string) {
    this.session(threadId);
    const active = this.state(threadId).active;
    return {pid:this.native(this.session(threadId)).pid, turn:active ? {id:active.id,status:active.status,inputId:active.inputId ?? null} : null};
  }
  ownsThread(id: string): boolean { return id.startsWith(this.threadPrefix); }
  ownsModel(id: string): boolean { return id.startsWith(this.modelPrefix); }
  subscribe(listener: (method: string, params: Value) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(method: string, params: Value): void { for (const listener of this.listeners) listener(method, params); }
  private state(id: string): Runtime { let state = this.runtime.get(id); if (!state) { const previous = this.sessions.get(id)?.lastTurn; state = { loaded: false, ...(previous ? { active: { id: previous.id, status: previous.status === "inProgress" ? "unconfirmed" : previous.status, items: [], delegationId: null } } : {}) }; this.runtime.set(id, state); } return state; }
  private session(id: string): Session { const session = this.sessions.get(id) ?? this.pendingMcp.get(id); return session ?? fault("Unknown ACP thread"); }
  private persistJson(path: string, payload: unknown): Promise<void> {
    const serialized = JSON.stringify(payload);
    const operation = this.persistence.catch(() => {}).then(async () => {
      if (this.persistenceFailed) throw new Error("ACP storage persistence is unavailable");
      const temporary = `${path}.${randomUUID()}.tmp`;
      const { open, unlink } = await import("node:fs/promises");
      let file;
      try {
        file = await open(temporary, "wx", 0o600); await file.writeFile(serialized); await file.sync(); await file.close(); file = undefined;
        await rename(temporary, path);
        const directory = await open(this.options.dataDirectory, "r"); try { await directory.sync(); } finally { await directory.close(); }
      } finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    });
    this.persistence = operation.catch(error => { this.persistenceFailed = true; throw error; }); return this.persistence;
  }
  private save(session: Session): Promise<void> { return this.persistJson(join(this.options.dataDirectory, `${session.id}.json`), session); }
  private savePreparations(): Promise<void> { return this.persistJson(join(this.options.dataDirectory, "preparations.json"), [...this.preparations]); }
  private saveCreations(): Promise<void> { return this.persistJson(join(this.options.dataDirectory, "creations.json"), [...this.creations]); }
  private load(): Promise<void> {
    return this.loaded ??= (async () => {
      await mkdir(this.options.dataDirectory, { recursive: true, mode: 0o700 });
      for (const file of await readdir(this.options.dataDirectory)) {
        if (!file.startsWith(this.threadPrefix) || !/^[a-zA-Z0-9_-]+\.json$/u.test(file)) continue;
        const record = JSON.parse(await readFile(join(this.options.dataDirectory, file), "utf8")) as Session;
        if (record.schemaVersion !== 1 || !safeId(record.id) || file !== `${record.id}.json` || !isAbsolute(record.cwd) || typeof record.nativeId !== "string" || !Array.isArray(record.tools)) throw new Error("Invalid ACP routing metadata");
        if (this.id === "codebuddy-ide" && !record.nativeImport && !record.lastTurn) record.nativeHistoryEmpty = true;
        if (record.queue) {
          validateAcpQueue(record.queue);
          for (const item of [...record.queue.items]) if (item.state === "dispatching") {
            if (record.lastTurn?.clientUserMessageId === item.clientUserMessageId) {
              record.receipts[item.clientUserMessageId] = { state: "delivered", turnId: record.lastTurn.id };
              record.queue.items.splice(record.queue.items.indexOf(item), 1);
            } else {
              // prompt() commits its stable input identity before sending any
              // native bytes. No such commit means this claim never sent input.
              item.state = "queued"; delete record.receipts[item.clientUserMessageId];
            }
          }
          // Reading history never wakes an execution owner. Recovery requires
          // explicit Resume queue; an attempted input remains non-replayable.
          if (record.queue.items.length) record.queue.pausedReason ??= "user-stopped";
        }
        this.sessions.set(record.id, record);
      }
      try {
        const catalog = value(JSON.parse(await readFile(join(this.options.dataDirectory, "model-catalog.json"), "utf8")));
        if (catalog.version !== 1 || !safeId(catalog.sessionId) || !this.sessions.has(catalog.sessionId)) throw new Error("Invalid ACP model catalog owner");
        this.catalogSessionId = catalog.sessionId;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try { this.nativeOutcomeUnknown = JSON.parse(await readFile(join(this.options.dataDirectory, "native-uncertainty.json"), "utf8")).unknown === true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try {
        for (const [key, creation] of JSON.parse(await readFile(join(this.options.dataDirectory, "creations.json"), "utf8"))) this.creations.set(key, creation);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try {
        for (const [key, preparation] of JSON.parse(await readFile(join(this.options.dataDirectory, "preparations.json"), "utf8"))) this.preparations.set(key, preparation);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    })();
  }
  start(): Promise<void> {
    return this.started ??= (async () => {
      await this.load(); await this.startTools();
      const initialized = await this.transport.start();
      if (initialized.protocolVersion !== 1) throw new Error("Unsupported ACP protocol version");
      this.capabilities = value(initialized.agentCapabilities);
      this.inputModalities = value(this.capabilities.promptCapabilities).image === true ? ["text", "image"] : ["text"];
      this.notify("opencraft/agents/models/changed", { agentId: this.id });
    })().catch(async error => { await this.transport.close(); await this.closeTools(); throw error; });
  }
  /** A cold declaration is advisory; native initialization never resumes a conversation. */
  get hasInputCapabilities(): boolean { return this.inputModalities !== null || [...this.sessions.values()].some(session => session.inputModalities !== undefined); }
  refreshInputCapabilities(): Promise<void> { return this.admit(() => this.start()); }
  /** Native discovery starts no sessions and never replays messages. */
  async discoverNativeSessions(cursor?: string, archived = false): Promise<{ sessions: { id: string; title: string | null; cwd: string; updatedAt: string | null; createdAt?: string; imported: boolean; importedThreadId: string | null; nativeProject?: NativeConversationProject }[]; nextCursor: string | null; supportsArchived?: boolean }> {
    if (this.closed) throw new Error("ACP engine is closed");
    await this.load();
    const native = await this.options.history?.directory?.(cursor, archived);
    if (!native?.available && archived) throw new Error("Archived discovery is unavailable for this agent version");
    if (!native?.available) await this.start();
    if (!native?.available && (!value(this.capabilities.sessionCapabilities).list || !(value(this.capabilities.sessionCapabilities).resume || this.capabilities.loadSession))) {
      return fault("This agent cannot list and resume saved conversations", -32601);
    }
    const result = native?.available ? native : await this.transport.request("session/list", cursor ? { cursor } : {});
    if (!Array.isArray(result.sessions) || result.sessions.length > 2000) throw new Error("Invalid native conversation directory");
    const groups = await this.options.history?.projects?.(result.sessions.map((entry: Value) => ({ id: entry.sessionId, cwd: entry.cwd }))).catch(() => null);
    const sessions = result.sessions.map((entry: Value) => {
      if (typeof entry.sessionId !== "string" || !/^[a-f0-9-]{32,64}$/u.test(entry.sessionId) || typeof entry.cwd !== "string" || !isAbsolute(entry.cwd)) throw new Error("Invalid native conversation identity");
      const imported = [...this.sessions.values()].find(session => session.nativeId === entry.sessionId);
      const project = groups?.available ? groups.groups[entry.sessionId] : imported?.nativeProject;
      return { id: entry.sessionId, ...(project ? { nativeProject: project } : {}), cwd: entry.cwd, title: typeof entry.title === "string" ? entry.title.slice(0, 256) : null,
        ...(typeof entry.createdAt === "string" && Number.isFinite(Date.parse(entry.createdAt)) ? { createdAt: entry.createdAt } : {}),
        updatedAt: typeof entry.updatedAt === "string" && Number.isFinite(Date.parse(entry.updatedAt)) ? entry.updatedAt : null,
        imported: !!imported, importedThreadId: imported?.id ?? null };
    });
    return { sessions, nextCursor: typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null, ...(native?.available && this.id === "codex" ? { supportsArchived: true } : {}) };
  }

  /** Backfill older imports from native project authority without creating new sessions. */
  async refreshNativeProjects(): Promise<void> {
    await this.load();
    const imports = [...this.sessions.values()].filter(s => s.nativeImport || s.id === this.threadPrefix + s.nativeId);
    if (!imports.length || !this.options.history?.projects) return;
    const snapshot = await this.options.history.projects(imports.map(s => ({ id: s.nativeId, cwd: s.cwd }))).catch(() => null);
    if (!snapshot?.available || this.closed) return;
    for (const old of imports) await this.serializeThread(old.id, async () => {
      const current = this.sessions.get(old.id);
      if (!current || this.closed) return;
      const nativeProject = snapshot.groups[current.nativeId] ?? undefined;
      if (current.nativeImport && isDeepStrictEqual(current.nativeProject, nativeProject)) return;
      // Running Turns retain this Session object; changing display metadata
      // must not replace the execution owner's mutable identity.
      const previous = { nativeImport: current.nativeImport, nativeProject: current.nativeProject };
      current.nativeImport = true;
      if (nativeProject) current.nativeProject = nativeProject; else delete current.nativeProject;
      try { await this.save(current); }
      catch (error) {
        if (previous.nativeImport) current.nativeImport = previous.nativeImport; else delete current.nativeImport;
        if (previous.nativeProject) current.nativeProject = previous.nativeProject; else delete current.nativeProject;
        throw error;
      }
    });
  }

  /** Only trusted, freshly discovered native metadata can enter the routing ledger. */
  async importNativeSession(entry: { id: string; cwd: string; title: string | null; updatedAt: string | null }): Promise<Value> {
    await this.load();
    if (!/^[a-f0-9-]{32,64}$/u.test(entry.id) || !isAbsolute(entry.cwd)) throw new Error("Invalid native conversation identity");
    return this.serializeThread(`import:${entry.id}`, async () => {
      if (this.closed) throw new Error("ACP engine is closed");
      const existing = [...this.sessions.values()].find(session => session.nativeId === entry.id);
      if (existing) return this.metadata(existing);
      const now = Math.floor(Date.now() / 1000), updatedAt = entry.updatedAt ? Math.floor(Date.parse(entry.updatedAt) / 1000) : now;
      const projects = await this.options.history?.projects?.([{ id: entry.id, cwd: entry.cwd }]).catch(() => null);
      const session: Session = { nativeImport: true, ...(projects?.available && projects.groups[entry.id] ? { nativeProject: projects.groups[entry.id]! } : {}), schemaVersion: 1, id: this.threadPrefix + entry.id, nativeId: entry.id, cwd: entry.cwd,
        model: null, name: entry.title, nameOrigin: "agent", createdAt: updatedAt, updatedAt, tools: [], archived: false, receipts: {} };
      if (!this.options.history) throw new Error("This agent has no saved history reader");
      await this.options.history.read(entry.id, { threadId: session.id, cwd: session.cwd, limit: 1 });
      if (this.closed) throw new Error("ACP engine is closed");
      await this.save(session);
      this.sessions.set(session.id, session);
      return this.metadata(session);
    });
  }

  private metadata(session: Session): Value {
    const state = this.state(session.id);
    return { id: session.id, ...(session.forkedFromId ? { forkedFromId: session.forkedFromId } : {}), ...(session.nativeProject ? { nativeProject: session.nativeProject } : {}), cwd: session.cwd, name: session.name, model: session.model, modelProvider: this.id,
      reasoningEffort: session.reasoningConfig?.currentValue ?? null, createdAt: session.createdAt, updatedAt: session.updatedAt,
      ...(session.fastConfig ? { serviceTier: session.fastConfig.currentValue === session.fastConfig.onValue ? "fast" : null } : {}),
      preview: session.preview ?? "", turns: [], status: { type: state.active?.status === "inProgress" ? "active" : "idle" },
      source: "appServer", engineKind: this.id, path: null, ephemeral: false,
      ...(this.options.history ? { historyMode: "paginated" } : {}),
      ...(this.id === "codex" ? this.permissionSettings(session) : this.options.permission === "allow-once" ? { permissions: permissionModeProfileId("full"), approvalPolicy: "never", sandbox: "danger-full-access" } : {}) };
  }
  get hasPermissionCatalog(): boolean { return [...this.sessions.values()].some(session => !!session.permissionConfig); }
  private permissionSettings(session: Session, response = false): Value {
    if (!this.state(session.id).permissionConfirmed || !session.permissionConfig) return { activePermissionProfile: null };
    const settings = codexAcpPermissionSettings(session.permissionConfig.currentValue);
    return response ? { ...settings, ...(settings.sandbox ? { sandbox: { type: settings.sandbox === "danger-full-access" ? "dangerFullAccess" : settings.sandbox === "read-only" ? "readOnly" : "workspaceWrite" } } : {}) } : settings;
  }
  private validatePermissionPolicy(params: Value, selection: unknown): void {
    if (this.id !== "codex") return;
    const policy = params.sandboxPolicy ?? params.sandbox;
    if (policy == null && params.approvalPolicy == null && params.approvalsReviewer == null) return;
    const mode = typeof selection === "string" ? parsePermissionModeProfileId(selection) : null;
    const native = mode && ({ "read-only": "read-only", "accept-edits": "workspace-write", auto: "agent", full: "agent-full-access" } as const)[mode];
    const expected = native ? codexAcpPermissionSettings(native) : null;
    const sandbox = typeof policy === "string" ? policy : policy?.type;
    const expectedSandbox = expected?.sandbox === "danger-full-access" ? "dangerFullAccess" : expected?.sandbox === "read-only" ? "readOnly" : "workspaceWrite";
    if (!expected || policy != null && ![expected.sandbox, expectedSandbox].includes(sandbox)
      || typeof policy === "object" && policy !== null && Object.keys(policy).some(key => key !== "type")
      || params.approvalPolicy != null && params.approvalPolicy !== expected.approvalPolicy
      || params.approvalsReviewer != null && params.approvalsReviewer !== expected.approvalsReviewer) return fault("Inconsistent or unsupported permission settings", 403);
  }
  private async setPermission(session: Session, selection: unknown): Promise<void> {
    if (typeof selection !== "string" || !selection) return fault("Invalid permission profile");
    if (this.id !== "codex") {
      // Legacy drivers expose only their Host callback policy. Preserve that
      // existing contract without treating it as a native Codex mode switch.
      if (selection === permissionModeProfileId("full") && this.options.permission === "allow-once") return;
      return fault("This Agent does not support execution mode selection", -32601);
    }
    const config = session.permissionConfig;
    const profile = acpPermissionProfiles(config).find(profile => profile.id === selection);
    if (!config || !profile) return fault("This Agent does not offer the requested permission profile", 403);
    const nativeId = profile.openCraftNativeProfileId ?? profile.id;
    // Remember intent before a request that may fail. Failed/empty replies never
    // authorize a prompt, including after restart or queued input dispatch.
    const intentChanged = session.permissionSelection !== selection;
    session.permissionSelection = selection;
    if (this.state(session.id).permissionConfirmed && config.currentValue === nativeId) {
      if (intentChanged) await this.save(session);
      return;
    }
    this.state(session.id).permissionConfirmed = false;
    await this.save(session);
    try {
      const result = await this.native(session).request("session/set_config_option", { sessionId: session.nativeId, configId: config.id, value: nativeId });
      const confirmed = readCodexPermissionConfig(result);
      if (!confirmed || confirmed.id !== config.id || confirmed.currentValue !== nativeId) return fault("The Agent did not confirm the requested permission mode", 403);
      session.permissionConfig = confirmed; this.state(session.id).permissionConfirmed = true;
      await this.save(session);
      const { sandbox, ...settings } = this.permissionSettings(session, true);
      this.notify("thread/settings/updated", { threadId: session.id, threadSettings: { ...settings, sandboxPolicy: sandbox } });
    } catch (error) {
      this.state(session.id).permissionConfirmed = false;
      this.notify("thread/settings/updated", { threadId: session.id, threadSettings: { activePermissionProfile: null } });
      throw error;
    }
  }
  private sessionResponse(session: Session): Value {
    return { thread: this.metadata(session), model: session.model ?? `${this.modelPrefix}current`, modelProvider: this.id,
      cwd: session.cwd, runtimeWorkspaceRoots: [session.cwd], instructionSources: [], disabledPluginIds: [],
      serviceTier: session.fastConfig?.currentValue === session.fastConfig?.onValue && session.fastConfig ? "fast" : null,
      reasoningEffort: session.reasoningConfig?.currentValue ?? null, multiAgentMode: "explicitRequestOnly",
      initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null, collaborationMode: null,
      ...(this.id === "codex" ? this.permissionSettings(session, true) : this.options.permission === "allow-once" ? { approvalPolicy: "never", approvalsReviewer: "user",
        sandbox: { type: "dangerFullAccess" }, activePermissionProfile: { id: permissionModeProfileId("full"), extends: null } } : {}),
    };
  }
  private turn(runtime: Runtime): Value { return runtime.active ? { id: runtime.active.id, status: runtime.active.status, items: runtime.active.items, ...(runtime.active.error ? { error: runtime.active.error } : {}) } : {}; }
  private async admit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.suspending || this.persistenceFailed) throw new Error("ACP generation is closing or suspending");
    this.activeAdmissions++;
    try { return await operation(); } finally { this.activeAdmissions--; }
  }
  request(method: string, params: Value, client: ExecutionEngineClient): Promise<any> {
    if (method === "thread/queue/list") return this.serializeThread(String(params.threadId ?? ""), () => this.handle(method, params, client));
    return method.startsWith("thread/queue/") && method !== "thread/queue/list" || [MODEL_CATALOG_REFRESH_METHOD, "thread/start", "thread/fork", "opencraft/agent-session/release", "thread/resume", "turn/start", "turn/interrupt", "thread/archive", "thread/unarchive", "opencraft/orchestration/prepare", "opencraft/orchestration/create"].includes(method)
      ? this.admit(() => typeof params.threadId === "string" && method !== MODEL_CATALOG_REFRESH_METHOD
        ? this.serializeThread(params.threadId, () => this.handle(method, params, client)) : this.handle(method, params, client))
      : this.handle(method, params, client);
  }
  private async handle(method: string, params: Value, client: ExecutionEngineClient): Promise<any> {
    await this.load();
    if (method === "opencraft/orchestration/prepare") {
      if (this.options.permission !== "allow-once") return fault("ACP Full access is not configured for this Host", 403);
      const args = value(params.arguments), source = params.sourceSettings === undefined && this.ownsThread(String(params.threadId ?? "")) ? this.metadata(this.session(params.threadId)) : value(params.sourceSettings);
      if (this.id === "codex" && source.permissions == null && source.activePermissionProfile?.id == null) return fault("Source permission mode is unconfirmed", 403);
      if (typeof source.cwd !== "string" || !isAbsolute(source.cwd)) return fault("Source workspace is unavailable", 503);
      const base = resolve(source.cwd), cwd = args.cwd === undefined ? base : resolve(base, args.cwd);
      if (cwd !== base && !cwd.startsWith(base.endsWith(sep) ? base : base + sep)) return fault("Child workspace exceeds the source delegation", 403);
      const sandbox = typeof source.sandbox === "string" ? source.sandbox : source.sandbox?.type;
      const permissions = source.permissions ?? source.activePermissionProfile?.id;
      if (permissions != null && permissions !== permissionModeProfileId("full")) return fault("ACP cannot preserve the source permission profile", 403);
      if (source.approvalPolicy != null && source.approvalPolicy !== "never" || sandbox != null && !["danger-full-access", "dangerFullAccess"].includes(sandbox)) return fault("ACP cannot preserve the source permission profile", 403);
      if (args.reasoningEffort !== undefined) return fault("This ACP driver does not advertise reasoning selection");
      if (args.model !== undefined && (typeof args.model !== "string" || !this.ownsModel(args.model))) return fault("Model belongs to another driver");
      const settings = { driver: this.id, driverKind: this.driverKind, cwd, permissions: permissionModeProfileId("full"),
        sandbox: "danger-full-access", approvalPolicy: "never", orchestrationHostIncarnation: this.incarnation,
        ...(args.model === undefined ? {} : { model: args.model }), ...(args.title === undefined ? {} : { orchestrationTitle: args.title }) };
      if (params.sourceOnly === true) return structuredClone(settings);
      const operationId = String(params.operationId ?? "");
      if (!operationId || operationId.length > 256) return fault("ACP preparation operation required");
      const fingerprint = JSON.stringify([params.threadId ?? null, args, params.callbackIncarnation ?? null, source.cwd, permissions, sandbox, source.approvalPolicy]);
      const previous = this.preparations.get(operationId) ?? this.creations.get(operationId)?.preparation;
      if (previous) {
        if (previous.fingerprint !== fingerprint) return fault("ACP preparation operation reused", 409);
        return structuredClone(previous.settings);
      }
      this.preparations.set(operationId, { fingerprint, settings }); await this.savePreparations();
      return structuredClone(settings);
    }
    if (method === "opencraft/orchestration/create") {
      const settings = value(params.settings), operationId = String(params.operationId ?? "");
      if (!operationId) return fault("ACP creation operation required");
      const preparation = this.preparations.get(operationId) ?? this.creations.get(operationId)?.preparation;
      const { orchestrationGenerationId: _generation, orchestrationDriver: _routingDriver, ...frozen } = settings;
      if (preparation && !isDeepStrictEqual(frozen, preparation.settings)) return fault("ACP prepared settings changed", 409);
      if (settings.orchestrationHostIncarnation !== this.incarnation && !this.creations.has(operationId) && !preparation) return fault("ACP target Host incarnation changed; creation outcome is unconfirmed", -32000);
      const { driver: _driver, driverKind: _kind, orchestrationTitle, orchestrationHostIncarnation: _incarnation, ...start } = frozen;
      const created = await this.request("thread/start", { ...start, __opencraftOrchestrationOperation: operationId }, client);
      if (this.preparations.delete(operationId)) await this.savePreparations();
      if (orchestrationTitle && this.session(created.thread.id).name === null) { const session = this.session(created.thread.id); session.name = String(orchestrationTitle); await this.save(session); }
      return { threadId: created.thread.id, driverKind: this.driverKind, durability: "immediate" };
    }
    if (method === "opencraft/orchestration/status") return this.snapshot(String(params.threadId));
    if (method === "opencraft/orchestration/inspect") {
      const session = this.session(String(params.threadId));
      if (!this.options.history) return { entries: [] };
      const page = await this.options.history.read(session.nativeId, { limit: Math.min(5, Number(params.limit ?? 1)) });
      return { entries: page.data.flatMap((turn: Value) => (turn.items ?? []).filter((item: Value) => ["agentMessage", "userMessage"].includes(item.type)).map((item: Value) => ({ turnId: turn.id, role: item.type === "userMessage" ? "user" : "assistant", text: item.text ?? "" }))) };
    }
    if (method === "thread/start") {
      const sandbox = typeof params.sandbox === "string" ? params.sandbox : params.sandbox?.type;
      if (this.id !== "codex" && (params.permissions != null && params.permissions !== permissionModeProfileId("full")
        || sandbox != null && !["danger-full-access", "dangerFullAccess"].includes(sandbox)
        || params.approvalPolicy != null && params.approvalPolicy !== "never")) return fault("ACP cannot preserve the requested permission profile", 403);
      if (this.id !== "codex" && (params.permissions != null || sandbox != null || params.approvalPolicy != null) && this.options.permission !== "allow-once") return fault("ACP Full access is not configured for this Host", 403);
      this.validatePermissionPolicy(params, params.permissions);
      await this.start();
      const operation = params.__opencraftOrchestrationOperation;
      if (operation !== undefined && (typeof operation !== "string" || !operation || operation.length > 256)) return fault("Invalid ACP creation operation");
      const fingerprint = JSON.stringify(params);
      if (operation) {
        const previous = this.creations.get(operation);
        if (previous && previous.fingerprint !== fingerprint) return fault("ACP creation operation reused", -32600);
        if (previous?.state === "created") return { thread: this.metadata(this.session(previous.threadId!)) };
        const running = this.creating.get(operation); if (running) return running;
        if (previous) return fault("ACP creation outcome is unconfirmed after Host replacement", -32000);
      }
      const create = async () => {
        if (operation) { this.creations.set(operation, { fingerprint, state: "pending", preparation: this.preparations.get(operation) }); await this.saveCreations(); }
        const cwd = params.cwd ?? this.options.cwd;
        if (!isAbsolute(cwd)) return fault("ACP cwd must be absolute");
        const tools = this.validateTools([...(params.dynamicTools ?? []), ...(this.orchestration?.tools ?? []).filter(tool => !(params.dynamicTools ?? []).some((entry: Value) => entry.name === tool.name))]);
        const id = this.threadPrefix + randomUUID();
        this.pendingMcp.set(id, { id, tools } as Session);
        let transport = this.transport;
        let executionScope: EnvironmentExecutionScope | undefined;
        if (this.options.executionEnvironment) {
          const envelope = params[EXECUTION_ENVIRONMENT_FIELD];
          const scope = executionScope = envelope === undefined ? { account: null, hostId: 'opencraft-server', projectId: params.projectId ?? null, threadId: null }
            : this.options.executionEnvironment.open(envelope, 'opencraft-server', 'thread/start', params);
          const environment = this.options.executionEnvironment.snapshot(scope);
          transport = this.createTransport(environment, id, cwd);
          this.sessionEnvironments.set(id, environment); this.sessionTransports.set(id, transport);
          try { await transport.start(); } catch { this.sessionTransports.delete(id); this.sessionEnvironments.delete(id); await transport.close(); throw new Error("ACP environment process unavailable"); }
        } else if (this.id === "cursor" || this.id === "pi-cli" || this.id === "codebuddy") {
          // Cursor's model manager is process-global. Each conversation owns
          // its transport so another conversation cannot change its parameters.
          transport = this.createTransport(undefined, id, cwd); this.sessionTransports.set(id, transport);
          try { await transport.start(); } catch { this.sessionTransports.delete(id); await transport.close(); throw new Error("ACP process unavailable"); }
        }
        let result: Value;
        try {
          result = await transport.request("session/new", { cwd, mcpServers: tools.length ? [this.mcp(id)] : [] });
          if (typeof result.sessionId !== "string" || !result.sessionId) throw new Error("ACP returned an invalid session id");
          if (executionScope) this.options.executionEnvironment!.rememberCreation(executionScope, id);
        } catch (error) {
          if (transport !== this.transport) {
            await transport.close(); this.sessionTransports.delete(id); this.sessionEnvironments.delete(id);
          }
          throw error;
        } finally { this.pendingMcp.delete(id); }
        const now = Math.floor(Date.now() / 1000);
        const session: Session = { schemaVersion: 1, id, nativeId: result.sessionId, cwd, model: null, name: null, createdAt: now, updatedAt: now, tools, archived: false, receipts: {},
          ...(params.__opencraftCatalogProbe === true ? { catalogProbe: true as const } : {}),
          ...(["codex", "cursor", "pi-cli", "claude-code", "codebuddy", "codebuddy-ide"].includes(this.id) ? { nativeHistoryEmpty: true as const } : {}) };
        this.captureModels(session, result);
        this.sessions.set(id, session); Object.assign(this.state(id), { loaded: true, owner: client });
        await this.save(session);
        if (params.permissions != null && this.id === "codex") await this.setPermission(session, params.permissions);
        if (params.model) await this.setModel(session, params.model);
        if (params.reasoningEffort != null || params.effort != null) await this.setReasoning(session, params.reasoningEffort ?? params.effort);
        if (Object.hasOwn(params, "serviceTier")) await this.setServiceTier(session, params.serviceTier);
        if (operation) { this.creations.set(operation, { fingerprint, state: "created", threadId: id, preparation: this.preparations.get(operation) }); await this.saveCreations(); }
        return this.sessionResponse(session);
      };
      const pending = create(); if (operation) this.creating.set(operation, pending);
      try { return await pending; } finally { if (operation) this.creating.delete(operation); }
    }
    if (method === "thread/list") {
      const limit = Number(params.limit ?? 100), offset = Number(params.cursor ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) return fault("Invalid ACP catalog page");
      const sessions = [...this.sessions.values()].filter(session => session.archived === (params.archived === true)).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      return { data: sessions.slice(offset, offset + limit).map(session => this.metadata(session)), nextCursor: offset + limit < sessions.length ? String(offset + limit) : null };
    }
    if (method === MODEL_CATALOG_REFRESH_METHOD) {
      if (!["codex", "cursor"].includes(this.id)) return fault("This Agent cannot refresh its model catalog", -32601);
      if (this.catalogRefresh) return this.catalogRefresh;
      const pending = (async () => {
        const cwd = typeof params.threadId === "string" ? this.session(params.threadId).cwd : this.options.cwd;
        const created = await this.handle("thread/start", { cwd, __opencraftCatalogProbe: true }, client);
        const probe = this.session(created.thread.id);
        try {
          await this.handle("thread/archive", { threadId: probe.id }, client);
          if (!probe.modelCatalog?.length) return fault("The Agent returned no model catalog", 503);
          await this.discoverModelCapabilities(probe.id);
          await this.save(probe);
        } finally {
          if (this.id === "cursor") {
            // Cursor's model manager belongs to its process. Discovery owns a
            // separate transport, which must be reaped even when discovery fails.
            const transport = this.sessionTransports.get(probe.id);
            if (!transport) throw new Error("Cursor discovery transport is unavailable");
            await transport.close();
            this.sessionTransports.delete(probe.id); this.sessionEnvironments.delete(probe.id);
            this.state(probe.id).loaded = false;
          }
        }
        // Publish the fresh snapshot only after both metadata and its owner are
        // durable. Saved sessions cannot reintroduce removed catalog entries.
        if (this.id === "codex" && value(this.capabilities.sessionCapabilities).close) await this.handle("opencraft/agent-session/release", { threadId: probe.id }, client);
        await this.persistJson(join(this.options.dataDirectory, "model-catalog.json"), { version: 1, sessionId: probe.id });
        this.catalogSessionId = probe.id;
        this.notify("opencraft/agents/models/changed", { agentId: this.id });
        return {};
      })();
      this.catalogRefresh = pending;
      try { return await pending; } finally { if (this.catalogRefresh === pending) this.catalogRefresh = null; }
    }
    if (method === "permissionProfile/list") {
      if (this.id !== "codex") return { data: [], nextCursor: null };
      const session = params.threadId ? this.session(params.threadId) : [...this.sessions.values()].filter(session => session.permissionConfig).at(-1);
      const catalog = acpPermissionProfiles(session?.permissionConfig ?? [...this.sessions.values()].find(session => session.permissionConfig)?.permissionConfig);
      const offset = params.cursor == null ? 0 : Number(params.cursor), limit = params.limit ?? 100;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) return fault("Invalid permission catalog page");
      return { data: catalog.slice(offset, offset + Math.min(limit, 100)), nextCursor: offset + limit < catalog.length ? String(offset + limit) : null };
    }
    if (method === "model/list") {
      // A live parameterized Cursor catalog supersedes catalogs persisted by
      // the previous variant picker. Old session records remain resumable.
      const sessions = this.catalogSessionId ? [this.session(this.catalogSessionId)] : this.id === "pi-cli" && typeof params.threadId === "string" ? [this.session(params.threadId)] : [...this.sessions.values()].filter(session => !session.catalogProbe);
      const catalogSessions = this.id === "cursor" && sessions.some(session => session.parameterConfigs)
        ? sessions.filter(session => session.parameterConfigs) : sessions;
      // Prompt capabilities belong to this Agent source, not whichever saved
      // session happens to overwrite a duplicate model ID last. An undeclared
      // older record cannot erase a declaration; current negotiation wins.
      const inputModalities = this.inputModalities ?? sessions.filter(session => session.inputModalities)
        .sort((a, b) => (b.inputModalitiesObservedAt ?? b.updatedAt * 1000) - (a.inputModalitiesObservedAt ?? a.updatedAt * 1000))[0]?.inputModalities ?? ["text"];
      const fastModels = Object.assign({}, ...catalogSessions.map(session => session.fastModels ?? {})) as Record<string, boolean>;
      const reasoningModels = Object.assign({}, ...catalogSessions.map(session => session.reasoningModels ?? {})) as NonNullable<Session["reasoningModels"]>;
      return { data: [...new Map(catalogSessions.flatMap(session => (session.modelCatalog ?? []).map(model => [model.id, {
        id: model.id, model: model.id, displayName: model.name, hidden: false, isDefault: session.model === model.id,
        inputModalities: model.inputModalities ?? inputModalities,
        supportedReasoningEfforts: (reasoningModels[model.id]?.supportedReasoningEfforts ?? []).map(effort => this.id === "pi-cli" && effort.reasoningEffort === "off" ? { ...effort, reasoningEffort: "none" } : effort),
        defaultReasoningEffort: this.id === "pi-cli" && reasoningModels[model.id]?.defaultReasoningEffort === "off" ? "none" : reasoningModels[model.id]?.defaultReasoningEffort ?? null,
        serviceTiers: fastModels[this.baseModelId(model.id)] ? [{ id: "fast", name: "Fast", description: "" }] : [],
      }]))).values()], nextCursor: null };
    }
    if (method === "opencraft/orchestration/ack") {
      const operation = String(params.operationId ?? ""); const creation = this.creations.get(operation);
      if (creation?.state === "created") { this.creations.delete(operation); await this.saveCreations(); }
      if ((!creation || creation.state === "created") && this.preparations.delete(operation)) await this.savePreparations();
      return { acknowledged: !creation || creation.state === "created" };
    }
    const session = this.session(String(params.threadId ?? "")), runtime = this.state(session.id);
    if (method.startsWith("thread/queue/")) return this.handleQueue(method, params, session, client);
    if (method === "opencraft/thread-usage/read") {
      const source = await this.options.history?.usage?.(session.nativeId).catch(() => null);
      const live = session.contextUsage;
      if (!source && !live) return null;
      return { threadId: session.id, providerId: this.id, observedAt: Math.max(source?.observedAt ?? 0, live?.observedAt ?? 0),
        context: live && live.observedAt >= (source?.observedAt ?? 0) ? { usedTokens: live.usedTokens, limitTokens: live.limitTokens } : source?.context ?? null,
        total: source?.total ?? null, last: source?.last ?? null };
    }
    if (method === "thread/read") {
      const initialTurnsPage = params.initialTurnsPage && this.options.history ? await this.options.history.read(session.nativeId, this.historyParams(session, params.initialTurnsPage)) : undefined;
      const turns = params.includeTurns === true && this.options.history?.snapshot ? await this.options.history.snapshot(session.nativeId, this.historyParams(session, params)) : [];
      return { thread: { ...this.metadata(session), turns }, ...(initialTurnsPage ? { initialTurnsPage } : {}) };
    }
    if (method === "thread/turns/list") {
      if (!this.options.history) return fault("This ACP peer has no native transcript reader", -32601);
      return this.options.history.read(session.nativeId, this.historyParams(session, params));
    }
    if (method === "thread/items/list") {
      if (!this.options.history?.items) return fault("This ACP peer has no native item reader", -32601);
      return this.options.history.items(session.nativeId, this.historyParams(session, params));
    }
    if (method === "opencraft/agent-session/export-context") {
      if (!this.options.history?.export) return fault("Conversation context export is unavailable", -32601);
      if (runtime.active?.status === "inProgress" || runtime.active?.status === "unconfirmed") return fault("Finish the current response before continuing with another Agent", 409);
      return this.options.history.export(session.nativeId, { threadId: session.id, cwd: session.cwd, title: session.name });
    }
    if (method === "opencraft/agent-session/status") {
      await this.start();
      const capabilities = value(this.capabilities.sessionCapabilities);
      return { fork: !!capabilities.fork && !this.options.executionEnvironment && this.id === "codex",
        release: !!capabilities.close && this.id === "codex", loaded: runtime.loaded };
    }
    if (method === "opencraft/agent-session/release") {
      await this.start();
      if (this.id !== "codex" || !value(this.capabilities.sessionCapabilities).close) return fault("Native session release is unavailable", -32601);
      if (this.nativeOutcomeUnknown || session.queue?.items.length || runtime.active?.status === "inProgress" || runtime.active?.status === "unconfirmed") return fault("The session must finish its current work before release", -32000);
      if (runtime.loaded) await this.native(session).request("session/close", { sessionId: session.nativeId });
      runtime.loaded = false; runtime.permissionConfirmed = false; runtime.owner = undefined;
      return { released: true };
    }
    if (method === "thread/fork") {
      await this.start();
      if (this.id !== "codex" || !value(this.capabilities.sessionCapabilities).fork || this.options.executionEnvironment) return fault("Native session branching is unavailable", -32601);
      if (this.nativeOutcomeUnknown) return fault("The previous native operation has an unknown outcome", -32000);
      if (params.lastTurnId != null || params.ephemeral === true || params.cwd != null && params.cwd !== session.cwd
        || params.dynamicTools != null || params.model != null && (typeof params.model !== "string" || !this.ownsModel(params.model))) return fault("This Agent supports branching the full conversation with its existing settings only");
      const id = this.threadPrefix + randomUUID();
      this.pendingMcp.set(id, { id, tools: session.tools } as Session);
      try {
        // Fork directly from native storage. Resuming the source first would
        // reacquire the other client's writer lock and defeat this operation.
        const result = await this.transport.request("session/fork", { sessionId: session.nativeId, cwd: session.cwd,
          mcpServers: session.tools.length ? [this.mcp(id)] : [] });
        if (typeof result.sessionId !== "string" || !safeId(result.sessionId) || result.sessionId === session.nativeId) {
          this.nativeOutcomeUnknown = true;
          throw new Error("The new native session could not be confirmed");
        }
        const now = Math.floor(Date.now() / 1000);
        const child: Session = { schemaVersion: 1, id, nativeId: result.sessionId, forkedFromId: session.id,
          cwd: session.cwd, model: null, name: session.name, nameOrigin: session.nameOrigin, permissionSelection: session.permissionSelection,
          ...(session.nativeProject ? { nativeProject: session.nativeProject } : {}),
          createdAt: now, updatedAt: now, tools: session.tools, archived: false, receipts: {} };
        this.captureModels(child, result);
        this.sessions.set(id, child); Object.assign(this.state(id), { loaded: true, owner: client });
        await this.save(child);
        if (child.permissionSelection) await this.setPermission(child, child.permissionSelection);
        if (params.model) await this.setModel(child, params.model);
        return this.sessionResponse(child);
      } finally { this.pendingMcp.delete(id); }
    }
    if (method === "thread/resume") {
      await this.resume(session); runtime.owner = client;
      const initialTurnsPage = params.initialTurnsPage && this.options.history ? await this.options.history.read(session.nativeId, this.historyParams(session, params.initialTurnsPage)) : undefined;
      const reply = this.sessionResponse(session);
      if (params.excludeTurns === false && !initialTurnsPage && this.options.history?.snapshot) reply.thread.turns = await this.options.history.snapshot(session.nativeId, this.historyParams(session, params));
      return { ...reply, ...(initialTurnsPage ? { initialTurnsPage } : {}) };
    }
    if (method === "thread/name/set") { if (typeof params.name !== "string" || params.name.length > 256) return fault("Invalid ACP thread name"); await this.setTitle(session, params.name, "manual"); return {}; }
    if (method === "thread/archive" || method === "thread/unarchive") { session.archived = method === "thread/archive"; if (session.archived && session.queue?.items.length) session.queue.pausedReason = "user-stopped"; await this.save(session); return {}; }
    if (method === "thread/unsubscribe") { if (runtime.owner === client) runtime.owner = undefined; return {}; }
    if (method === "turn/start") {
      if (runtime.active?.status === "inProgress") return fault("ACP thread is already running", -32000);
      if (params.clientUserMessageId !== undefined && (typeof params.clientUserMessageId !== "string" || !params.clientUserMessageId || params.clientUserMessageId.length > 512)) return fault("Invalid ACP input identity");
      const continuing = Array.isArray(params.input) && params.input.length === 0;
      if (continuing && (this.nativeOutcomeUnknown || !["failed", "interrupted"].includes(runtime.active?.status ?? session.lastTurn?.status ?? ""))) return fault("This ACP conversation cannot be continued in its current state");
      await this.resume(session, params.clientUserMessageId);
      this.validatePermissionPolicy(params, params.permissions ?? session.permissionSelection);
      if (params.permissions != null) await this.setPermission(session, params.permissions);
      if (params.model) await this.setModel(session, params.model);
      if (params.effort != null || params.reasoningEffort != null) await this.setReasoning(session, params.effort ?? params.reasoningEffort);
      if (Object.hasOwn(params, "serviceTier")) await this.setServiceTier(session, params.serviceTier);
      runtime.owner = client;
      const initialized = await this.native(session).start();
      const userPrompt = continuing ? [{ type: "text", text: "Continue." }] : await acpPromptContent(params.input,
        value(initialized.agentCapabilities?.promptCapabilities).image === true);
      if (this.id === "pi-cli" && userPrompt.some(part => part.type === "image")
        && !session.modelCatalog?.find(model => model.id === session.model)?.inputModalities?.includes("image")) return fault("This Pi model does not support image input");
      const result = await this.prompt(session, this.promptWithContext(userPrompt, params.additionalContext), typeof params.__opencraftDelegationId === "string" ? params.__opencraftDelegationId : null, params.clientUserMessageId, userPrompt);
      if (session.queue?.pausedReason) { session.queue.pausedReason = null; await this.save(session); this.notify("thread/queue/changed", { threadId: session.id }); }
      return result;
    }
    if (method === "turn/interrupt") {
      if(this.id === "codebuddy-ide")return fault("Stop this task in CodeBuddy IDE; interruption was not sent",-32601);
      if (runtime.active && params.turnId && params.turnId !== runtime.active.id) return fault("ACP turn changed", -32000);
      if (session.queue) { session.queue.pausedReason = "user-stopped"; await this.save(session); this.notify("thread/queue/changed", { threadId: session.id }); }
      if (runtime.active?.status === "inProgress") this.native(session).notify("session/cancel", { sessionId: session.nativeId });
      return {};
    }
    if (method === "opencraft/driver/status") return this.snapshot(session.id);
    return fault("Unsupported ACP operation", -32601);
  }
  private async handleQueue(method: string, params: Value, session: Session, client: ExecutionEngineClient): Promise<any> {
    if (this.persistenceFailed) return fault("Queue storage is unavailable; reconnect after recovery", 503);
    const queue = session.queue ?? emptyAcpQueue();
    if (method === "thread/queue/list") {
      const cursor = params.cursor == null ? 0 : Number(params.cursor), limit = params.limit ?? 50;
      if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1) return fault("Invalid queue page");
      const data = queue.items.slice(cursor, cursor + Math.min(limit, 100)).map(item => acpQueueProjection(item, queue));
      return { data, steering: [], nextCursor: cursor + data.length < queue.items.length ? String(cursor + data.length) : null };
    }
    if (session.archived) return fault("Unarchive the conversation before changing its queue");
    session.queue = queue;
    const item = queue.items.find(entry => entry.id === params.queuedSubmissionId);
    if (method === "thread/queue/add" || method === "thread/queue/update") {
      const updating = method === "thread/queue/update", clientId = updating ? item?.clientUserMessageId : params.clientUserMessageId;
      if (typeof clientId !== "string" || !clientId || clientId.length > 512 || ["__proto__", "constructor", "prototype"].includes(clientId)) return fault("Invalid queued input identity");
      if (updating && (!item || item.state !== "queued")) return fault("Queued input is no longer editable");
      const content = await acpPromptContent(params.input, (this.inputModalities ?? session.inputModalities ?? []).includes("image"));
      const additionalContext = updating ? item!.additionalContext : params.additionalContext ?? null;
      this.promptWithContext(content, additionalContext);
      const input = content.map(part => part.type === "image" ? { type: "image", url: `data:${part.mimeType};base64,${part.data}` } : { type: "text", text: part.text, text_elements: [] });
      const fingerprint = acpQueueFingerprint(input, additionalContext), known = queue.admissions[clientId];
      if (!updating && known) {
        if (known.fingerprint !== fingerprint) return fault("Queued input identity already has different content", 409);
        if (session.receipts[clientId]?.state === "discarded") return fault("This queued input was removed", 409);
        const existing = queue.items.find(entry => entry.id === known.id);
        return { queuedSubmission: acpQueueProjection(existing ?? { ...known, clientUserMessageId: clientId, input, additionalContext, state: "queued" }, queue) };
      }
      if (!updating && session.receipts[clientId]) return fault("This input identity is already in use", 409);
      const accepted = { id: item?.id ?? `acp-queue-${randomUUID()}`, clientUserMessageId: clientId,
        input, additionalContext, createdAt: item?.createdAt ?? Date.now(), state: "queued" as const };
      if (updating) queue.items[queue.items.indexOf(item!)] = accepted; else queue.items.push(accepted);
      queue.admissions[clientId] = { id: accepted.id, createdAt: accepted.createdAt, fingerprint };
      await this.save(session);
      this.notify("thread/queue/changed", { threadId: session.id });
      this.queueOwners.set(session.id, client);
      this.scheduleQueue(session, client);
      return { queuedSubmission: acpQueueProjection(accepted, queue) };
    }
    if (method === "thread/queue/delete") {
      if (!item) return { deleted: false };
      if (item.state !== "queued") return fault("Delivery of this input needs review before it can be removed", 409);
      queue.items.splice(queue.items.indexOf(item), 1);
      session.receipts[item.clientUserMessageId] = { state: "discarded", turnId: null };
    } else if (method === "thread/queue/reorder") {
      const ids = params.queuedSubmissionIds;
      if (!Array.isArray(ids) || ids.length !== queue.items.length || new Set(ids).size !== ids.length
        || ids.some(id => typeof id !== "string" || !queue.items.some(entry => entry.id === id))
        || queue.items.some(entry => entry.state !== "queued")) return fault("Queue changed before reordering", 409);
      queue.items = ids.map(id => queue.items.find(entry => entry.id === id)!);
    } else if (method === "thread/queue/start") {
      if (params.queuedSubmissionId != null && !item) return fault("Queued input is no longer available", 409);
      this.queueOwners.set(session.id, client);
      return this.dispatchQueue(session, client, true, params.queuedSubmissionId);
    } else return fault("Unsupported queue operation", -32601);
    await this.save(session);
    if (!queue.items.length) this.queueOwners.delete(session.id);
    this.notify("thread/queue/changed", { threadId: session.id });
    return method === "thread/queue/delete" ? { deleted: true } : {};
  }
  private scheduleQueue(session: Session, client = this.queueOwners.get(session.id) ?? this.state(session.id).owner): void {
    if (this.closed || this.suspending || this.persistenceFailed || this.nativeOutcomeUnknown || this.queueDrains.has(session.id) || !client
      || session.archived || session.queue?.pausedReason || !session.queue?.items.length
      || session.queue.items[0].state !== "queued" || session.receipts[session.queue.items[0].clientUserMessageId]
      || ["inProgress", "unconfirmed"].includes(this.state(session.id).active?.status ?? "")) return;
    const pending = this.admit(() => this.serializeThread(session.id, () => this.dispatchQueue(session, client))).then(() => {}, () => {
      // dispatchQueue retains custody and commits a pause before surfacing failure.
    }).finally(() => { this.queueDrains.delete(session.id); this.scheduleQueue(session, client); });
    this.queueDrains.set(session.id, pending);
  }
  private async dispatchQueue(session: Session, client: ExecutionEngineClient, explicit = false, id?: string): Promise<any> {
    const queue = session.queue, active = this.state(session.id).active;
    if (this.closed || this.suspending || this.persistenceFailed || session.archived || !queue?.items.length
      || ["inProgress", "unconfirmed"].includes(active?.status ?? "") || this.nativeOutcomeUnknown) return fault("Finish or review the current task before continuing the queue", 409);
    if (queue.pausedReason && !explicit) return null;
    const item = id ? queue.items.find(entry => entry.id === id)! : queue.items[0];
    if (item.state !== "queued" || session.receipts[item.clientUserMessageId]) return fault("Delivery of this input cannot be replayed", 409);
    try {
      // Commit uncertainty before any native operation. A process death at any
      // subsequent await can never turn an attempted input into a second prompt.
      item.state = "dispatching";
      session.receipts[item.clientUserMessageId] = { state: "unknown", turnId: null };
      await this.save(session);
      if (this.closed || this.suspending) throw new Error("Queue owner is closing");
      const result = await this.handle("turn/start", { threadId: session.id, input: item.input,
        additionalContext: item.additionalContext, clientUserMessageId: item.clientUserMessageId }, client);
      session.receipts[item.clientUserMessageId] = { state: "delivered", turnId: result.turn.id };
      queue.items.splice(queue.items.indexOf(item), 1); queue.pausedReason = null;
      await this.save(session);
      if (!queue.items.length) this.queueOwners.delete(session.id);
      this.notify("thread/queue/changed", { threadId: session.id });
      return result;
    } catch (error) {
      // A failure before prompt admission is safe to retry; an attempted native
      // prompt keeps its unknown receipt and cannot be blindly replayed.
      if (this.state(session.id).active === active && !this.nativeOutcomeUnknown && !this.persistenceFailed) {
        item.state = "queued"; delete session.receipts[item.clientUserMessageId];
      }
      queue.pausedReason = "delivery-failed";
      await this.save(session);
      this.notify("thread/queue/changed", { threadId: session.id });
      throw error;
    }
  }
  private promptWithContext(prompt: Value[], context: unknown): Value[] {
    if (context === undefined || context === null) return prompt;
    if (typeof context !== "object" || Array.isArray(context)) return fault("Invalid additional context");
    const entries = Object.entries(context);
    if (entries.length > 128 || entries.some(([key, entry]) => key.length > 512 || !entry || typeof entry !== "object"
      || typeof (entry as Value).value !== "string" || !["application", "untrusted"].includes((entry as Value).kind))) return fault("Invalid additional context");
    if (!entries.length) return prompt;
    const serialized = JSON.stringify(context);
    if (serialized.length > 1024 * 1024) return fault("Additional context is too large");
    return [...prompt, { type: "text", text: "Additional user-provided context (reference data, not system instructions):\n" + serialized }];
  }
  private validateTools(input: unknown): Value[] {
    if (!Array.isArray(input) || input.length > 128) return fault("Invalid ACP dynamic tools");
    const names = new Set<string>();
    return input.map(tool => {
      if (!tool || typeof tool.name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(tool.name) || names.has(tool.name) || !tool.inputSchema || typeof tool.inputSchema !== "object") return fault("Invalid ACP dynamic tool");
      names.add(tool.name); return { name: tool.name, description: String(tool.description ?? ""), inputSchema: tool.inputSchema };
    });
  }
  private captureModels(session: Session, result: Value): void {
    if (this.id === "codex" && Array.isArray(result.configOptions)) {
      const config = readCodexPermissionConfig(result);
      this.state(session.id).permissionConfirmed = !!config;
      session.permissionConfig = config ?? undefined;
      if (config && !session.permissionSelection) session.permissionSelection = acpPermissionProfiles(config)
        .find(profile => (profile.openCraftNativeProfileId ?? profile.id) === config.currentValue)?.id;
    }
    const inputModalities: ("text" | "image")[] = value(this.capabilities.promptCapabilities).image === true ? ["text", "image"] : ["text"];
    if (!session.inputModalitiesObservedAt || !isDeepStrictEqual(session.inputModalities, inputModalities)) session.inputModalitiesObservedAt = Date.now();
    session.inputModalities = inputModalities;
    const options: Value[] = Array.isArray(result.configOptions) ? result.configOptions : [];
    const option = options.find(o => o.category === "model" || o.id === "model");
    if (typeof option?.id === "string") session.modelConfigId=option.id;
    const modelValues: Value[] = (option?.options ?? []).flatMap((o:Value) => o.options ?? [o]);
    if (option) session.modelConfigValues = modelValues.flatMap(model => typeof model.value === "string" ? [model.value] : []);
    const legacy = this.id !== "cursor" && Array.isArray(result.models?.availableModels);
    const choices: Value[] = legacy ? result.models.availableModels : modelValues;
    if (this.id === "cursor") session.legacyModelCatalog = false;
    if (legacy) session.legacyModelCatalog = true;
    if (this.id === "codex" && session.modelCatalog?.some(model => /\[[^\]]+\]$/u.test(model.id))) session.legacyModelCatalog = true;
    if (choices.length && (legacy || !session.legacyModelCatalog)) session.modelCatalog = choices.flatMap(m => {
      const id = m.modelId ?? m.value;
      return typeof id === "string" ? [{ id: this.modelPrefix + id, name: typeof m.name === "string" ? m.name : id,
        ...(this.id === "pi-cli" && Array.isArray(m.inputModalities) ? { inputModalities: m.inputModalities.includes("image") ? ["text", "image"] as ("text" | "image")[] : ["text"] as ("text" | "image")[] } : {}) }] : [];
    });
    const reasoning = options.find(o => o.category === "thought_level" || o.id === "reasoning_effort");
    if (reasoning && typeof reasoning.id === "string" && typeof reasoning.currentValue === "string") session.reasoningConfig = {
      id: reasoning.id, currentValue: reasoning.currentValue,
      values: (reasoning.options ?? []).flatMap((o:Value) => o.options ?? [o]).flatMap((o:Value) => typeof o.value === "string" ? [o.value] : []),
    };
    else if (Array.isArray(result.configOptions)) session.reasoningConfig = undefined;
    let current = this.id === "cursor" ? option?.currentValue : result.models?.currentModelId ?? option?.currentValue;
    if (this.id !== "cursor" && typeof current === "string" && !result.models?.currentModelId && session.reasoningConfig) {
      const combined = `${current}[${session.reasoningConfig.currentValue}]`;
      if (session.modelCatalog?.some(model => model.id === this.modelPrefix + combined)) current = combined;
    }
    if (typeof current === "string" && current) session.model=this.modelPrefix+current;
    if (Array.isArray(result.configOptions)) {
      const fast = options.find(o => o.id === (this.id === "cursor" ? "fast" : "fast-mode"));
      const values = (fast?.options ?? []).map((o:Value) => o.value);
      const [on, off] = this.id === "cursor" ? ["true", "false"] : ["on", "off"];
      session.fastConfig = fast?.type === "boolean" && typeof fast.currentValue === "boolean"
        ? { id: fast.id, type: "boolean", currentValue: fast.currentValue, onValue: true, offValue: false }
        : fast?.type === "select" && [on, off].every(value => values.includes(value)) && values.includes(fast.currentValue)
          ? { id: fast.id, type: "select", currentValue: fast.currentValue, onValue: on!, offValue: off! } : undefined;
      if (session.model) (session.fastModels ??= {})[this.baseModelId(session.model)] = !!session.fastConfig;
      if (this.id === "cursor" || this.id === "pi-cli") {
        session.parameterConfigs = options.filter(o => o.category !== "model" && o.category !== "mode" && o.type === "select"
          && typeof o.id === "string" && typeof o.currentValue === "string").map(o => ({
          id: o.id, currentValue: o.currentValue, values: (o.options ?? []).flatMap((choice: Value) => choice.options ?? [choice])
            .flatMap((choice: Value) => typeof choice.value === "string" ? [choice.value] : []),
        }));
        if (session.model) (session.reasoningModels ??= {})[session.model] = {
          supportedReasoningEfforts: session.reasoningConfig?.values.map(reasoningEffort => ({ reasoningEffort, description: "" })) ?? [],
          defaultReasoningEffort: session.reasoningModels?.[session.model]?.defaultReasoningEffort ?? session.reasoningConfig?.currentValue ?? null,
        };
      }
    }
  }
  private baseModelId(model: string): string { return this.id === "codex" ? codexBaseModelId(model) : model; }
  private async setModel(session: Session, model: string): Promise<void> {
    if (!this.ownsModel(model)) return fault("Model belongs to another ACP provider");
    if (session.model === model && this.id !== "pi-cli") return;
    const requested = model.slice(this.modelPrefix.length);
    const refreshed = this.catalogSessionId ? this.session(this.catalogSessionId) : null;
    if (this.id === "codex" && refreshed?.modelCatalog?.some(choice => choice.id === model)
      && !session.modelCatalog?.some(choice => choice.id === model)) {
      const previousCatalog = session.modelCatalog;
      session.modelCatalog = refreshed.modelCatalog;
      try {
        const result = await this.native(session).request("session/set_model", { sessionId: session.nativeId, modelId: requested });
        this.captureModels(session, result);
        if (session.model !== model) return fault("The requested model was not selected. Choose another model.");
        await this.save(session); return;
      } catch (error) { session.modelCatalog = previousCatalog; throw error; }
    }
    if (this.id === "cursor") {
      // Previous catalogs stored native parameterized variants as model IDs.
      // Restore only parameters the current peer actually declares.
      const variant = splitModelVariant(requested);
      const base = variant?.base ?? requested;
      const freshlyAdvertised = refreshed?.modelCatalog?.some(choice => choice.id === this.modelPrefix + base) === true;
      if (!session.modelConfigValues?.includes(base) && !freshlyAdvertised) return fault("This model option is unavailable");
      this.captureModels(session, await this.native(session).request("session/set_config_option", {
        sessionId: session.nativeId, configId: session.modelConfigId ?? "model", value: base,
      }));
      const parameters = variant?.parameters ? variant.parameters.split(",").map(part => part.split("=")) : [];
      for (const [id, selected, extra] of parameters) {
        if (extra !== undefined || !session.parameterConfigs?.some(config => config.id === id && config.values.includes(selected!))) return fault("This model parameter is unavailable");
      }
      for (const [id, selected] of parameters) this.captureModels(session, await this.native(session).request("session/set_config_option", {
        sessionId: session.nativeId, configId: id, value: selected,
      }));
      await this.save(session);
      if (session.model !== this.modelPrefix + base) return fault("The requested model was not selected. Choose another model.");
      return;
    }
    const variant = this.id === "codex" && session.modelConfigValues && !session.modelConfigValues.includes(requested) ? splitModelVariant(requested) : null;
    const combined = variant?.parameters ? variant : null;
    if (combined && (!session.modelConfigValues!.includes(combined.base) || !session.modelCatalog?.some(choice => choice.id === model))) return fault("This model option is unavailable");
    const result = await this.native(session).request("session/set_config_option", { sessionId: session.nativeId, configId: session.modelConfigId ?? "model", value: combined?.base ?? requested });
    this.captureModels(session, result);
    if (combined) {
      const config = session.reasoningConfig;
      if (!config?.values.includes(combined.parameters)) return fault("This reasoning level is unavailable for the selected model");
      this.captureModels(session, await this.native(session).request("session/set_config_option", { sessionId: session.nativeId, configId: config.id, value: combined.parameters }));
    }
    if ((!result.models?.currentModelId && !Array.isArray(result.configOptions)) || (Array.isArray(result.configOptions) && result.configOptions.length === 0)) session.model = model;
    await this.save(session);
    // A declared Codex base selection leaves native reasoning unchanged; its
    // observed model may therefore still carry that reasoning suffix. Explicit
    // variants continue to require an exact match, including their effort.
    const selected = this.id === "codex" && !combined && session.modelConfigValues?.includes(requested)
      ? this.baseModelId(session.model ?? "") : session.model;
    if (selected !== model) return fault("The requested model was not selected. Choose another model.");
  }
  private async setReasoning(session: Session, effort: unknown): Promise<void> {
    const config = session.reasoningConfig;
    if (this.id === "pi-cli" && effort === "none") effort = "off";
    if (!["cursor", "pi-cli"].includes(this.id) || typeof effort !== "string" || !config?.values.includes(effort)) return fault("This reasoning level is unavailable for the selected model");
    if (config.currentValue === effort) return;
    this.captureModels(session, await this.native(session).request("session/set_config_option", {
      sessionId: session.nativeId, configId: config.id, value: effort,
    }));
    await this.save(session);
    if (session.reasoningConfig?.currentValue !== effort) return fault("The requested reasoning level was not selected");
  }
  private async setServiceTier(session: Session, tier: unknown): Promise<void> {
    if (tier !== null && tier !== "fast") return fault("This ACP agent does not support that speed option");
    const config = session.fastConfig;
    if (!config) { if (tier === null) return; return fault("Fast mode is unavailable for the selected model"); }
    const requested = tier === "fast" ? config.onValue : config.offValue;
    if (requested === config.currentValue) return;
    const result = await this.native(session).request("session/set_config_option", { sessionId: session.nativeId, configId: config.id,
      ...(config.type === "boolean" ? { type: "boolean" } : {}), value: requested });
    this.captureModels(session, result);
    await this.save(session);
    if (session.fastConfig?.currentValue !== requested) return fault("The requested speed option was not selected");
  }
  /** Only the Host's dedicated discovery session may be used for this probe. */
  async discoverModelCapabilities(threadId: string): Promise<void> {
    return this.admit(() => this.serializeThread(threadId, async () => {
      const session = this.session(threadId), original = session.model;
      if (this.id === "cursor") {
        try {
          const result = await this.native(session).request("_cursor/list_available_models", {});
          const entries: Value[] = Array.isArray(result.models) ? result.models : [];
          const known = session.modelConfigValues ?? [];
          if (entries.length === known.length && new Set(entries.map(entry => entry.value)).size === known.length
            && entries.every(entry => known.includes(entry.value) && Array.isArray(entry.configOptions))) {
            for (const entry of entries) {
              // The extension declares default parameter schemas for every
              // base model. Project them without changing the live selection.
              const projection: Session = { ...session, model: this.modelPrefix + entry.value, reasoningModels: {}, fastModels: {} };
              this.captureModels(projection, { configOptions: entry.configOptions });
              Object.assign(session.reasoningModels ??= {}, projection.reasoningModels);
              Object.assign(session.fastModels ??= {}, projection.fastModels);
            }
            await this.save(session); return;
          }
        } catch (error) {
          // Older Cursor versions can still declare options through standard
          // ACP configuration. Transport failures must retain their uncertainty.
          if (!(error instanceof AcpProtocolError) || error.code !== -32601) throw error;
        }
      }
      try {
        for (const base of session.modelConfigValues ?? []) {
          const choice = session.modelCatalog?.find(model => this.baseModelId(model.id) === this.modelPrefix + base);
          if (choice) await this.setModel(session, choice.id);
        }
      } finally { if (original && session.model !== original) await this.setModel(session, original); }
    }));
  }
  private async resume(session: Session, inputId?: string): Promise<void> {
    if (session.nativeImport && ["pi-cli", "claude-code", "codebuddy", "codebuddy-ide"].includes(this.id)) {
      if (!this.options.history?.validateResume) throw new Error("Native resume validation is unavailable");
      await this.options.history.validateResume(session.nativeId, session.cwd);
    }
    await this.start(); const runtime = this.state(session.id);
    if (this.options.executionEnvironment && !this.sessionTransports.has(session.id)) {
      const scope = this.options.executionEnvironment.creation('opencraft-server', session.id)
        ?? (inputId ? this.options.executionEnvironment.execution('opencraft-server', session.id, inputId) : null);
      if (!scope) return; // Legacy catalog reads remain cold until an attested input.
      const environment = this.options.executionEnvironment.snapshot(scope);
      const transport = this.createTransport(environment, session.id, session.cwd, session.nativeId);
      try { await transport.start(); } catch { await transport.close(); throw new Error("ACP environment process unavailable"); }
      this.sessionTransports.set(session.id, transport); this.sessionEnvironments.set(session.id, environment); runtime.loaded = false;
    } else if ((this.id === "cursor" || this.id === "pi-cli" || this.id === "codebuddy") && !this.sessionTransports.has(session.id)) {
      const nativePath = this.id === "pi-cli" ? await this.options.history?.sessionPath?.(session.nativeId, session.nativeHistoryEmpty === true) : undefined;
      const transport = this.createTransport(undefined, session.id, session.cwd, session.nativeId, nativePath ?? undefined);
      try { await transport.start(); } catch { await transport.close(); throw new Error("ACP process unavailable"); }
      this.sessionTransports.set(session.id, transport); runtime.loaded = false;
    }
    if (runtime.loaded) return;
    const sessions = value(this.capabilities.sessionCapabilities);
    const method = sessions.resume ? "session/resume" : this.capabilities.loadSession ? "session/load" : null;
    if (!method) return fault("ACP peer cannot resume persisted sessions", -32601);
    const selection = this.id === "cursor" ? { model: session.model, parameters: session.parameterConfigs?.map(config => ({ ...config })) } : null;
    let result: Value;
    try { result = await this.native(session).request(method, { sessionId: session.nativeId, cwd: session.cwd, mcpServers: session.tools.length ? [this.mcp(session.id)] : [],
      ...(this.id === "codebuddy-ide" ? { _meta: { ...(session.nativeImport ? { "opencraft/nativeHistoryVerified": true } : {}),
        ...(session.nativeHistoryEmpty && !session.lastTurn ? { "opencraft/nativeHistoryEmpty": true } : {}) } } : {}) }); }
    catch (error) {
      if (this.id === "codex" && error instanceof AcpProtocolError && /This Codex session is in use by another Codex client/u.test(error.message))
        throw Object.assign(new Error(error.message), { rpcCode: 409, domainData: { code: "CODEX_SESSION_BUSY", inputNotSent: true } });
      throw error;
    }
    this.state(session.id).permissionConfirmed = false;
    this.captureModels(session, result);
    if (selection?.model) {
      await this.setModel(session, selection.model);
      for (const parameter of selection.parameters ?? []) {
        const current = session.parameterConfigs?.find(config => config.id === parameter.id);
        if (current?.values.includes(parameter.currentValue) && current.currentValue !== parameter.currentValue) {
          this.captureModels(session, await this.native(session).request("session/set_config_option", {
            sessionId: session.nativeId, configId: parameter.id, value: parameter.currentValue,
          }));
          if (session.parameterConfigs?.find(config => config.id === parameter.id)?.currentValue !== parameter.currentValue) return fault("The saved model parameter was not restored");
        }
      }
    }
    if (this.id === "codex" && session.permissionSelection) await this.setPermission(session, session.permissionSelection);
    await this.save(session);
    runtime.loaded = true;
    if (!session.name || session.nameOrigin === "input") void this.refreshTitle(session).catch(() => {});
  }
  private async refreshTitle(session: Session): Promise<void> {
    if (!value(this.capabilities.sessionCapabilities).list) return;
    const observed = { name: session.name, origin: session.nameOrigin }, cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.native(session).request("session/list", { cwd: session.cwd, ...(cursor ? { cursor } : {}) });
      if (session.name !== observed.name || session.nameOrigin !== observed.origin) return;
      const entry = Array.isArray(result.sessions) ? result.sessions.find((entry: Value) => entry?.sessionId === session.nativeId) : undefined;
      if (typeof entry?.title === "string" && entry.title.trim()) {
        await this.setTitle(session, Array.from(entry.title.trim()).slice(0, 256).join(""), "agent"); return;
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) return;
      if (cursor) cursors.add(cursor);
    } while (cursor && !this.closed);
  }
  private async prompt(session: Session, prompt: Value[], delegationId: string | null, inputId?: string, userPrompt: Value[] = prompt): Promise<any> {
    await this.resume(session, inputId); const runtime = this.state(session.id);
    assertModelPolicy(this.options.modelPolicyPath, this.id, session.model, ["cursor", "pi-cli"].includes(this.id) ? session.reasoningConfig?.currentValue ?? null : null,
      (session.modelCatalog ?? []).map(m=>({model:m.id})));
    if (this.options.executionEnvironment) {
      const current = this.options.executionEnvironment.snapshot(this.options.executionEnvironment.execution('opencraft-server', session.id, inputId));
      if (current.owner !== this.sessionEnvironments.get(session.id)?.owner) throw new Error("ACP session belongs to another account or project; start a new session");
    }
    if (runtime.active?.status === "inProgress") return fault("ACP thread is already running", -32000);
    if (this.id === "codex") {
      if (!session.permissionSelection) return fault("The Agent execution mode is unavailable", 403);
      await this.setPermission(session, session.permissionSelection);
    }
    runtime.active = { id: `acp-turn-${randomUUID()}`, delegationId, ...(inputId ? { inputId } : {}), items: [], status: "inProgress", startedAtMs: Date.now() };
    const active = runtime.active;
    active.items.push({ id: `${active.id}:user`, type: "userMessage", clientId: inputId ?? null,
      content: userPrompt.map(item => item.type === "image"
        ? { type: "image", url: `data:${item.mimeType};base64,${item.data}` }
        : { type: "text", text: item.text, text_elements: [] }) });
    session.lastTurn = { id: active.id, status: active.status, ...(inputId ? { clientUserMessageId: inputId } : {}) };
    delete session.nativeHistoryEmpty;
    const firstText = userPrompt.map(item => item.text).join(" ").replace(/\s+/gu, " ").trim();
    if (!session.preview && firstText) session.preview = Array.from(firstText).slice(0, 160).join("");
    const initialTitle = !session.name && session.nameOrigin !== "manual" && firstText
      ? Array.from(firstText).slice(0, 80).join("") : null;
    if (initialTitle) { session.name = initialTitle; session.nameOrigin = "input"; }
    session.updatedAt = Math.floor(Date.now() / 1000); await this.save(session);
    if (initialTitle && session.name === initialTitle && session.nameOrigin === "input") this.notify("thread/name/updated", { threadId: session.id, threadName: initialTitle });
    this.notify("turn/started", { threadId: session.id, turn: this.turn(runtime), ...(inputId ? { clientMessageId: inputId } : {}) });
    void this.native(session).request("session/prompt", { sessionId: session.nativeId, prompt }, 0).then(result => this.serializeThread(session.id, async () => {
      if (runtime.active !== active || active.status !== "inProgress") return;
      active.status = result.stopReason === "cancelled" ? "interrupted" : "completed";
      runtime.questionLifetime?.abort();
      runtime.questionLifetime = undefined;
      session.lastTurn = { id: active.id, status: active.status, ...(active.inputId ? { clientUserMessageId: active.inputId } : {}) };
      if (active.status === "interrupted" && session.queue) session.queue.pausedReason = "user-stopped";
      await this.save(session);
      for (const item of active.items) if (item.type === "agentMessage" || item.type === "reasoning") this.notify("item/completed", { threadId: session.id, turnId: active.id, item });
      this.notify("turn/completed", { threadId: session.id, turn: this.turn(runtime) });
      for (const key of this.callbacks.keys()) if (key.startsWith(`${this.incarnation}:${session.id}:${active.id}:`)) this.callbacks.delete(key);
      this.scheduleQueue(session);
    }), () => {
      if (runtime.active !== active || active.status !== "inProgress") return;
      const code = this.nativeOutcomeUnknown ? "acpPromptUnconfirmed" : "acpPromptFailed";
      void this.failPrompt(session, runtime, code).catch(() => { this.persistenceFailed = true; });
    }).catch(() => { this.persistenceFailed = true; });
    return { turn: this.turn(runtime) };
  }
  private async failPrompt(session: Session, runtime: Runtime, code: "acpPromptFailed" | "acpPromptUnconfirmed"): Promise<void> {
    const active = runtime.active; if (!active || active.status !== "inProgress") return;
    active.status = "failed";
    runtime.questionLifetime?.abort();
    runtime.questionLifetime = undefined;
    if (session.queue) session.queue.pausedReason = "delivery-failed";
    active.error = { message: code, codexErrorInfo: "other", additionalDetails: null };
    const item = { id: `${active.id}:error`, type: "error", code, message: code };
    active.items.push(item);
    session.lastTurn = { id: active.id, status: active.status, ...(active.inputId ? { clientUserMessageId: active.inputId } : {}) };
    const turn = this.turn(runtime);
    await this.save(session);
    this.notify("item/completed", { threadId: session.id, turnId: active.id, item });
    this.notify("turn/completed", { threadId: session.id, turn });
    if (session.queue?.items.length) this.notify("thread/queue/changed", { threadId: session.id });
  }
  private historyParams(session: Session, params: Value): Value {
    const active = this.state(session.id).active;
    const { nativeHistoryEmpty: _callerEmptyHistory, ...readParams } = params;
    return { ...readParams, threadId: session.id, ...(session.nativeHistoryEmpty === true && !session.lastTurn ? { nativeHistoryEmpty: true } : {}),
      activeTurn: active?.status === "inProgress" ? { ...active, items: active.items.map(item => ({ ...item })) } : undefined };
  }
  private update(method: string, params: Value, threadId?: string): void {
    if (method !== "session/update") return;
    const session = [...this.sessions.values()].find(entry => entry.nativeId === params.sessionId && (!threadId || entry.id === threadId)); if (!session) return;
    const update = value(params.update);
    if (update.sessionUpdate === "usage_update") {
      if (Number.isSafeInteger(update.used) && update.used >= 0 && Number.isSafeInteger(update.size) && update.size > 0
        && (session.contextUsage?.usedTokens !== update.used || session.contextUsage?.limitTokens !== update.size)) {
        session.contextUsage = { usedTokens: update.used, limitTokens: update.size, observedAt: Date.now() };
        void this.save(session).then(() => this.notify("opencraft/usage/changed", { threadId: session.id })).catch(() => { this.persistenceFailed = true; });
      }
      return;
    }
    if (update.sessionUpdate === "session_info_update") {
      if (typeof update.title === "string" && update.title.trim()) {
        void this.setTitle(session, Array.from(update.title.trim()).slice(0, 256).join(""), "agent").catch(() => { this.persistenceFailed = true; });
      }
      return;
    }
    if(update.sessionUpdate === "config_option_update") {
      this.captureModels(session,update);
      void this.save(session).catch(()=>{this.persistenceFailed=true;});
      return;
    }
    const runtime = this.state(session.id), active = runtime.active; if (!active || active.status !== "inProgress") return;
    if (update.sessionUpdate === "plan" && Array.isArray(update.entries)) {
      const plan = update.entries.flatMap((raw: unknown) => {
        const entry = value(raw);
        return typeof entry.content === "string" && ["pending", "in_progress", "completed"].includes(entry.status)
          ? [{ step: entry.content, status: entry.status === "in_progress" ? "inProgress" : entry.status }] : [];
      });
      const signature = JSON.stringify(plan);
      if (plan.length && signature !== active.planSignature) { active.planSignature = signature; this.notify("turn/plan/updated", { threadId: session.id, turnId: active.id, explanation: null, plan }); }
      return;
    }
    const content = value(update.content);
    if (["agent_message_chunk", "agent_thought_chunk"].includes(update.sessionUpdate) && content.type === "text" && typeof content.text === "string") {
      const type = update.sessionUpdate === "agent_message_chunk" ? "agentMessage" : "reasoning";
      let item = active.items.at(-1); if (item?.type !== type) { item = { id: randomUUID(), type, text: "" }; active.items.push(item); this.notify("item/started", { threadId: session.id, turnId: active.id, item }); }
      item.text += content.text;
      this.notify(type === "agentMessage" ? "item/agentMessage/delta" : "item/reasoning/textDelta", { threadId: session.id, turnId: active.id, itemId: item.id, delta: content.text });
    } else if (["tool_call", "tool_call_update"].includes(update.sessionUpdate) && typeof update.toolCallId === "string") {
      const id = `acp-tool-${update.toolCallId}`;
      let item = active.items.find(item => item.id === id);
      if (!item) {
        item = { id, type: "dynamicToolCall", namespace: "acp", tool: String(update.title ?? update.toolCallId), arguments: update.rawInput ?? {}, status: "inProgress", contentItems: [], success: null };
        active.items.push(item); this.notify("item/started", { threadId: session.id, turnId: active.id, item });
      }
      if (update.rawInput !== undefined) item.arguments = update.rawInput;
      if (Array.isArray(update.content)) item.contentItems = update.content.flatMap((entry: Value) => entry.type === "content" && entry.content?.type === "text" ? [{ type: "inputText", text: String(entry.content.text ?? "") }] : []);
      if (!item.contentItems.length && update.rawOutput !== undefined) item.contentItems = [{ type: "inputText", text: typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput) }];
      if (["completed", "failed"].includes(update.status)) {
        item.status = update.status; item.success = update.status === "completed";
        this.notify("item/completed", { threadId: session.id, turnId: active.id, item });
      }
    }
  }
  private async setTitle(session: Session, title: string, origin: NonNullable<Session["nameOrigin"]>): Promise<void> {
    // Older records could only receive a name through manual rename.
    if (origin === "agent" && (session.nameOrigin === "manual" || session.name && session.nameOrigin === undefined)) return;
    if (session.name === title && session.nameOrigin === origin) return;
    const previous = { name: session.name, origin: session.nameOrigin };
    session.name = title; session.nameOrigin = origin;
    try { await this.save(session); }
    catch (error) {
      if (session.name === title && session.nameOrigin === origin) { session.name = previous.name; session.nameOrigin = previous.origin; }
      throw error;
    }
    // A newer rename may have committed while this write was queued.
    if (session.name === title && session.nameOrigin === origin) this.notify("thread/name/updated", { threadId: session.id, threadName: title });
  }
  snapshot(threadId: string): Value {
    const runtime = this.state(threadId), active = runtime.active;
    return { threadId, driverKind: this.driverKind, rootTurnId: active?.id ?? null, turnId: active?.id ?? null,
      state: !active ? "starting" : active.status === "inProgress" ? "active" : ["failed", "unconfirmed"].includes(active.status) ? "unconfirmed" : active.status === "interrupted" ? "interrupted_by_user" : "completed",
      summary: active?.items.filter(item => item.type === "agentMessage").map(item => item.text).join("\n").slice(-2000) ?? "", hasDirectUserInput: false };
  }
  disconnect(client: ExecutionEngineClient): void {
    for (const state of this.runtime.values()) if (state.owner === client) state.owner = undefined;
  }
  /** Reattach only the callback lane, without resuming or replaying a native input. */
  attach(threadId: string, client: ExecutionEngineClient): void { this.session(threadId); this.state(threadId).owner = client; }
  private mcp(threadId: string): Value { return { type: "http", name: "opencraft", url: `${this.toolUrl}/${threadId}`, headers: [{ name: "Authorization", value: `Bearer ${this.toolToken}` }] }; }
  private async startTools(): Promise<void> {
    if (this.toolServer) return;
    this.toolServer = createServer((request, response) => {
      void (async () => {
        const supplied = Buffer.from(request.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${this.toolToken}`);
        if (request.headers.origin !== undefined || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(403); response.end(); return; }
        const id = request.url?.slice(1) ?? "", session = this.sessions.get(id) ?? this.pendingMcp.get(id);
        if (request.method !== "POST" || !session) { response.writeHead(404); response.end(); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) { response.writeHead(413); response.end(); return; } chunks.push(chunk); }
        const frame = value(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (frame.id === undefined) { response.writeHead(202); response.end(); return; }
        let result: unknown;
        if (frame.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "opencraft-host-tools", version: "1" } };
        else if (frame.method === "tools/list") result = { tools: session.tools };
        else if (frame.method === "tools/call") result = await this.callTool(session, String(frame.id), value(frame.params));
        else { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Method not found" } })); return; }
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
      })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
    });
    await new Promise<void>((resolve, reject) => { this.toolServer!.once("error", reject); this.toolServer!.listen(0, "127.0.0.1", resolve); });
    this.toolUrl = `http://127.0.0.1:${(this.toolServer.address() as { port: number }).port}`;
  }
  private callTool(session: Session, callId: string, params: Value): Promise<unknown> {
    const active = this.state(session.id).active;
    if (!active || active.status !== "inProgress" || !session.tools.some(tool => tool.name === params.name)) return Promise.reject(new Error("No admitted ACP tool call"));
    const key = `${this.incarnation}:${session.id}:${active.id}:${callId}`, fingerprint = JSON.stringify(params);
    const known = this.callbacks.get(key);
    if (known) return known.fingerprint === fingerprint ? known.promise : Promise.reject(new Error("ACP tool call changed"));
    if (this.callbacks.size >= 1024) return Promise.reject(new Error("ACP callback receipt limit"));
    const promise = (async () => {
      this.activeCallbacks++;
      try {
      if (this.orchestration && this.orchestration.tools.some(tool => tool.name === params.name)) {
        const reply = await this.orchestration.call(session.id, active.id, callId, params.name, value(params.arguments), this.callbackAbort.signal, active.inputId);
        return { content: [{ type: "text", text: JSON.stringify(reply) }], isError: false };
      }
      const expires = Date.now() + (this.options.reconnectWindowMs ?? 15_000); let backoff = 25;
      do {
        const runtime = this.state(session.id), owner = runtime.owner;
        if (this.closed || runtime.active !== active || active.status !== "inProgress") throw new Error("ACP tool owner expired");
        if (owner) {
          try {
            const reply = await owner.request("item/tool/call", { threadId: session.id, turnId: active.id, callId, tool: params.name, arguments: value(params.arguments),
              __opencraftToolCallKey: key, __opencraftCallbackIncarnation: this.incarnation, __opencraftDelegationId: active.delegationId });
            return { content: Array.isArray(reply?.contentItems) ? reply.contentItems.map((item: Value) => ({ type: "text", text: String(item.text ?? "") })) : [{ type: "text", text: JSON.stringify(reply) }], isError: reply?.success === false };
          } catch { if (runtime.owner === owner) runtime.owner = undefined; }
        }
        await delay(Math.min(backoff, Math.max(1, expires - Date.now()))); backoff = Math.min(500, backoff * 2);
      } while (Date.now() < expires);
      throw new Error("ACP gateway reconnect window exhausted; inspect the original operation");
      } finally { this.activeCallbacks--; }
    })();
    this.callbacks.set(key, { fingerprint, promise });
    return promise;
  }
  get supportsResume(): boolean { return !!value(this.capabilities.sessionCapabilities).resume || this.capabilities.loadSession === true; }
  async suspend(): Promise<void> {
    if (this.closed || this.suspending || this.persistenceFailed) throw new Error("ACP generation is closing or suspending");
    this.suspending = true;
    try {
      await this.load();
      if (Object.values(this.occupancy).some(count => count > 0)) throw new Error("ACP generation has active work, callbacks, preparations or unacknowledged receipts");
      if (!this.processId) return;
      if (!this.supportsResume) throw new Error("ACP peer cannot resume persisted sessions; suspension is unavailable");
      await this.persistence;
      await Promise.all([this.transport.close(), ...[...this.sessionTransports.values()].map(transport => transport.close())]); this.sessionTransports.clear(); this.sessionEnvironments.clear();
      for (const state of this.runtime.values()) state.loaded = false;
      this.transport = this.createTransport(); this.started = null;
    } finally { this.suspending = false; }
  }
  private async closeTools(): Promise<void> {
    if (!this.toolServer) return;
    this.toolServer.closeAllConnections(); await new Promise<void>(resolve => this.toolServer!.close(() => resolve())); this.toolServer = undefined;
  }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; this.callbackAbort.abort(); await Promise.all([this.transport.close(), ...[...this.sessionTransports.values()].map(transport => transport.close())]); await Promise.allSettled([...this.queueDrains.values()]); this.queueOwners.clear(); await this.closeTools(); await this.persistence; await this.options.history?.close?.(); }
}

/** Explicit DSH ACP launch. The previous web generation remains a separate owner. */
export const dshAcpCommand = (entry: string, patches: readonly string[] = []) => ({ command: process.execPath,
  args: ["--expose-internals", entry, "--profile", "acp", ...patches.flatMap(patch => ["--patch", patch])] });
