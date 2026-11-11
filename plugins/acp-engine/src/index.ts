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
import { permissionModeProfileId } from "@opencraft/appserver-protocol";
import type { HostInputPort, HostInputReceipt } from "@opencraft/appserver-protocol/host-inputs";
import { AcpStdioTransport, AcpProtocolError, type AcpObject as Value } from "./transport.js";
import { codexBaseModelId, splitModelVariant } from "./model-variant.js";

export interface AcpEngineOptions {
  executionEnvironment?: ExecutionEnvironmentRuntime;
  id?: "acp" | "dsh-acp" | "claude-code" | "cursor" | "codebuddy" | "codex";
  timeoutMs?: number;
  label?: string;
  command: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd: string;
  modelPolicyPath?: string;
  dataDirectory: string;
  /** An engine-native reader; opening history must never issue session/resume. */
  history?: {
    read(nativeSessionId: string, params: Value): Promise<{ data: any[]; nextCursor: string | null }>;
    items?(nativeSessionId: string, params: Value): Promise<Value>;
    snapshot?(nativeSessionId: string, params: Value): Promise<any[]>;
    usage?(nativeSessionId: string): Promise<Value | null>;
    close?(): Promise<void>;
  };
  permission?: "allow-once" | "reject";
  reconnectWindowMs?: number;
}
interface Session {
  schemaVersion: 1; id: string; nativeId: string; cwd: string; model: string | null; name: string | null;
  createdAt: number; updatedAt: number; tools: Value[]; archived: boolean;
  preview?: string;
  nameOrigin?: "input" | "agent" | "manual";
  contextUsage?: { usedTokens: number; limitTokens: number; observedAt: number };
  modelConfigId?: string;
  modelConfigValues?: string[];
  legacyModelCatalog?: boolean;
  reasoningConfig?: { id: string; currentValue: string; values: string[] };
  reasoningModels?: Record<string, { supportedReasoningEfforts: { reasoningEffort: string; description: string }[]; defaultReasoningEffort: string | null }>;
  parameterConfigs?: { id: string; currentValue: string; values: string[] }[];
  fastConfig?: { id: string; type: "boolean" | "select"; currentValue: string | boolean; onValue: string | boolean; offValue: string | boolean };
  fastModels?: Record<string, boolean>;
  modelCatalog?: {id:string;name:string}[];
  receipts: Record<string, HostInputReceipt>;
  lastTurn?: { id: string; status: string };
}
export type AcpOrchestrationPort = AgentOrchestrationPort;
interface Runtime {
  owner?: ExecutionEngineClient; loaded: boolean; active?: { id: string; delegationId: string | null; inputId?: string; items: Value[]; status: string; startedAtMs?: number; planSignature?: string; error?: Value };
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
  readonly id: "acp" | "dsh-acp" | "claude-code" | "cursor" | "codebuddy" | "codex";
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
  private readonly listeners = new Set<(method: string, params: Value) => void>();
  private loaded: Promise<void> | null = null;
  private persistence: Promise<void> = Promise.resolve();
  private persistenceFailed = false;
  private nativeOutcomeUnknown = false;
  private started: Promise<void> | null = null;
  private capabilities: Value = {};
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
      unconfirmedInputs: [...this.sessions.values()].reduce((sum, session) => sum + Object.values(session.receipts).filter(receipt => receipt.state === "unknown").length, 0) };
  }
  constructor(private readonly options: AcpEngineOptions) {
    if (!isAbsolute(options.cwd) || !isAbsolute(options.dataDirectory) || !options.command.trim()) throw new Error("ACP requires explicit absolute workspace and data paths and an installed command");
    this.id = options.id ?? "acp";
    this.label = options.label ?? (this.id === "claude-code" ? "Claude" : this.id === "dsh-acp" ? "DeepSeek Harness (ACP)" : this.id === "cursor" ? "Cursor" : this.id === "codebuddy" ? "CodeBuddy" : this.id === "codex" ? "Codex" : "ACP Agent");
    this.threadPrefix = this.id === "claude-code" ? "claude_" : this.id.replaceAll("-", "_") + "_";
    this.modelPrefix = this.id + ":";
    this.baseExtensions = Object.freeze({
      "opencraft/thread-lifecycle": { version: 1, rename: true, archive: true, unsubscribe: true },
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
  private createTransport(environment?: ExecutionEnvironmentSnapshot, threadId?: string): AcpStdioTransport {
    return new AcpStdioTransport({ ...this.options,
      parameterizedModelPicker: this.id === "cursor",
      env: environment?.apply({ ...process.env, ...this.options.env }) ?? this.options.env,
      redactError: environment ? message => environment.redact(message) : undefined,
      onNotification: (method, params) => this.update(method, params, threadId),
      onRequest: async (method, params) => {
        if (method !== "session/request_permission") return fault("Unsupported ACP client request", -32601);
        const choices = Array.isArray(params.options) ? params.options : [];
        const choice = this.options.permission === "allow-once" && choices.find((entry: Value) => entry.kind === "allow_once");
        return { outcome: choice ? { outcome: "selected", optionId: choice.optionId } : { outcome: "cancelled" } };
      },
      onUnconfirmed: () => {
        this.nativeOutcomeUnknown = true;
        void this.persistJson(join(this.options.dataDirectory, "native-uncertainty.json"), { unknown: true }).catch(() => {});
      },
      onExit: () => {
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
        this.sessions.set(record.id, record);
      }
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
    })().catch(async error => { await this.transport.close(); await this.closeTools(); throw error; });
  }
  private metadata(session: Session): Value {
    const state = this.state(session.id);
    return { id: session.id, cwd: session.cwd, name: session.name, model: session.model, modelProvider: this.id,
      reasoningEffort: session.reasoningConfig?.currentValue ?? null, createdAt: session.createdAt, updatedAt: session.updatedAt,
      ...(session.fastConfig ? { serviceTier: session.fastConfig.currentValue === session.fastConfig.onValue ? "fast" : null } : {}),
      preview: session.preview ?? "", turns: [], status: { type: state.active?.status === "inProgress" ? "active" : "idle" },
      source: "appServer", engineKind: this.id, path: null, ephemeral: false,
      ...(this.options.history ? { historyMode: "paginated" } : {}),
      ...(this.options.permission === "allow-once" ? { permissions: permissionModeProfileId("full"), approvalPolicy: "never", sandbox: "danger-full-access" } : {}) };
  }
  private sessionResponse(session: Session): Value {
    return { thread: this.metadata(session), model: session.model ?? `${this.modelPrefix}current`, modelProvider: this.id,
      cwd: session.cwd, runtimeWorkspaceRoots: [session.cwd], instructionSources: [], disabledPluginIds: [],
      serviceTier: session.fastConfig?.currentValue === session.fastConfig?.onValue && session.fastConfig ? "fast" : null,
      reasoningEffort: session.reasoningConfig?.currentValue ?? null, multiAgentMode: "explicitRequestOnly",
      initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null, collaborationMode: null,
      ...(this.options.permission === "allow-once" ? { approvalPolicy: "never", approvalsReviewer: "user",
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
    return ["thread/start", "thread/resume", "turn/start", "turn/interrupt", "opencraft/orchestration/prepare", "opencraft/orchestration/create"].includes(method)
      ? this.admit(() => method === "turn/start" && typeof params.threadId === "string"
        ? this.serializeThread(params.threadId, () => this.handle(method, params, client)) : this.handle(method, params, client))
      : this.handle(method, params, client);
  }
  private async handle(method: string, params: Value, client: ExecutionEngineClient): Promise<any> {
    await this.load();
    if (method === "opencraft/orchestration/prepare") {
      if (this.options.permission !== "allow-once") return fault("ACP Full access is not configured for this Host", 403);
      const args = value(params.arguments), source = params.sourceSettings === undefined && this.ownsThread(String(params.threadId ?? "")) ? this.metadata(this.session(params.threadId)) : value(params.sourceSettings);
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
      if (params.permissions != null && params.permissions !== permissionModeProfileId("full")
        || sandbox != null && !["danger-full-access", "dangerFullAccess"].includes(sandbox)
        || params.approvalPolicy != null && params.approvalPolicy !== "never") return fault("ACP cannot preserve the requested permission profile", 403);
      if ((params.permissions != null || sandbox != null || params.approvalPolicy != null) && this.options.permission !== "allow-once") return fault("ACP Full access is not configured for this Host", 403);
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
          transport = this.createTransport(environment, id);
          this.sessionEnvironments.set(id, environment); this.sessionTransports.set(id, transport);
          try { await transport.start(); } catch { this.sessionTransports.delete(id); this.sessionEnvironments.delete(id); await transport.close(); throw new Error("ACP environment process unavailable"); }
        } else if (this.id === "cursor") {
          // Cursor's model manager is process-global. Each conversation owns
          // its transport so another conversation cannot change its parameters.
          transport = this.createTransport(undefined, id); this.sessionTransports.set(id, transport);
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
        const session: Session = { schemaVersion: 1, id, nativeId: result.sessionId, cwd, model: null, name: null, createdAt: now, updatedAt: now, tools, archived: false, receipts: {} };
        this.captureModels(session, result);
        this.sessions.set(id, session); this.runtime.set(id, { loaded: true, owner: client });
        await this.save(session);
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
    if (method === "model/list") {
      // A live parameterized Cursor catalog supersedes catalogs persisted by
      // the previous variant picker. Old session records remain resumable.
      const sessions = [...this.sessions.values()];
      const catalogSessions = this.id === "cursor" && sessions.some(session => session.parameterConfigs)
        ? sessions.filter(session => session.parameterConfigs) : sessions;
      const fastModels = Object.assign({}, ...catalogSessions.map(session => session.fastModels ?? {})) as Record<string, boolean>;
      const reasoningModels = Object.assign({}, ...catalogSessions.map(session => session.reasoningModels ?? {})) as NonNullable<Session["reasoningModels"]>;
      return { data: [...new Map(catalogSessions.flatMap(session => (session.modelCatalog ?? []).map(model => [model.id, {
        id: model.id, model: model.id, displayName: model.name, hidden: false, isDefault: session.model === model.id,
        supportedReasoningEfforts: reasoningModels[model.id]?.supportedReasoningEfforts ?? [],
        defaultReasoningEffort: reasoningModels[model.id]?.defaultReasoningEffort ?? null,
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
    if (method === "thread/resume") {
      await this.resume(session); runtime.owner = client;
      const initialTurnsPage = params.initialTurnsPage && this.options.history ? await this.options.history.read(session.nativeId, this.historyParams(session, params.initialTurnsPage)) : undefined;
      const reply = this.sessionResponse(session);
      if (params.excludeTurns === false && !initialTurnsPage && this.options.history?.snapshot) reply.thread.turns = await this.options.history.snapshot(session.nativeId, this.historyParams(session, params));
      return { ...reply, ...(initialTurnsPage ? { initialTurnsPage } : {}) };
    }
    if (method === "thread/name/set") { if (typeof params.name !== "string" || params.name.length > 256) return fault("Invalid ACP thread name"); await this.setTitle(session, params.name, "manual"); return {}; }
    if (method === "thread/archive" || method === "thread/unarchive") { session.archived = method === "thread/archive"; await this.save(session); return {}; }
    if (method === "thread/unsubscribe") { if (runtime.owner === client) runtime.owner = undefined; return {}; }
    if (method === "turn/start") {
      if (runtime.active?.status === "inProgress") return fault("ACP thread is already running", -32000);
      if (params.clientUserMessageId !== undefined && (typeof params.clientUserMessageId !== "string" || !params.clientUserMessageId || params.clientUserMessageId.length > 512)) return fault("Invalid ACP input identity");
      const continuing = Array.isArray(params.input) && params.input.length === 0;
      if (continuing && (this.nativeOutcomeUnknown || !["failed", "interrupted"].includes(runtime.active?.status ?? session.lastTurn?.status ?? ""))) return fault("This ACP conversation cannot be continued in its current state");
      await this.resume(session, params.clientUserMessageId);
      if (params.model) await this.setModel(session, params.model);
      if (params.effort != null || params.reasoningEffort != null) await this.setReasoning(session, params.effort ?? params.reasoningEffort);
      if (Object.hasOwn(params, "serviceTier")) await this.setServiceTier(session, params.serviceTier);
      runtime.owner = client;
      return this.prompt(session, continuing ? [{ type: "text", text: "Continue." }] : this.promptContent(params.input), typeof params.__opencraftDelegationId === "string" ? params.__opencraftDelegationId : null, params.clientUserMessageId);
    }
    if (method === "turn/interrupt") {
      if (runtime.active && params.turnId && params.turnId !== runtime.active.id) return fault("ACP turn changed", -32000);
      if (runtime.active?.status === "inProgress") this.native(session).notify("session/cancel", { sessionId: session.nativeId });
      return {};
    }
    if (method === "opencraft/driver/status") return this.snapshot(session.id);
    return fault("Unsupported ACP operation", -32601);
  }
  private validateTools(input: unknown): Value[] {
    if (!Array.isArray(input) || input.length > 128) return fault("Invalid ACP dynamic tools");
    const names = new Set<string>();
    return input.map(tool => {
      if (!tool || typeof tool.name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(tool.name) || names.has(tool.name) || !tool.inputSchema || typeof tool.inputSchema !== "object") return fault("Invalid ACP dynamic tool");
      names.add(tool.name); return { name: tool.name, description: String(tool.description ?? ""), inputSchema: tool.inputSchema };
    });
  }
  private promptContent(input: unknown): Value[] {
    if (!Array.isArray(input) || !input.length) return fault("ACP input must contain text");
    return input.map(item => { if (!item || item.type !== "text" || typeof item.text !== "string") return fault("This ACP adapter supports text input only"); return { type: "text", text: item.text }; });
  }
  private captureModels(session: Session, result: Value): void {
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
      return typeof id === "string" ? [{ id: this.modelPrefix + id, name: typeof m.name === "string" ? m.name : id }] : [];
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
      if (this.id === "cursor") {
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
    if (session.model === model) return;
    const requested = model.slice(this.modelPrefix.length);
    if (this.id === "cursor") {
      // Previous catalogs stored native parameterized variants as model IDs.
      // Restore only parameters the current peer actually declares.
      const variant = splitModelVariant(requested);
      const base = variant?.base ?? requested;
      if (!session.modelConfigValues?.includes(base)) return fault("This model option is unavailable");
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
    if(session.model!==model) return fault("The requested model was not selected. Choose another model.");
  }
  private async setReasoning(session: Session, effort: unknown): Promise<void> {
    const config = session.reasoningConfig;
    if (this.id !== "cursor" || typeof effort !== "string" || !config?.values.includes(effort)) return fault("This reasoning level is unavailable for the selected model");
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
    await this.start(); const runtime = this.state(session.id);
    if (this.options.executionEnvironment && !this.sessionTransports.has(session.id)) {
      const scope = this.options.executionEnvironment.creation('opencraft-server', session.id)
        ?? (inputId ? this.options.executionEnvironment.execution('opencraft-server', session.id, inputId) : null);
      if (!scope) return; // Legacy catalog reads remain cold until an attested input.
      const environment = this.options.executionEnvironment.snapshot(scope);
      const transport = this.createTransport(environment, session.id);
      try { await transport.start(); } catch { await transport.close(); throw new Error("ACP environment process unavailable"); }
      this.sessionTransports.set(session.id, transport); this.sessionEnvironments.set(session.id, environment); runtime.loaded = false;
    } else if (this.id === "cursor" && !this.sessionTransports.has(session.id)) {
      const transport = this.createTransport(undefined, session.id);
      try { await transport.start(); } catch { await transport.close(); throw new Error("ACP process unavailable"); }
      this.sessionTransports.set(session.id, transport); runtime.loaded = false;
    }
    if (runtime.loaded) return;
    const sessions = value(this.capabilities.sessionCapabilities);
    const method = sessions.resume ? "session/resume" : this.capabilities.loadSession ? "session/load" : null;
    if (!method) return fault("ACP peer cannot resume persisted sessions", -32601);
    const selection = this.id === "cursor" ? { model: session.model, parameters: session.parameterConfigs?.map(config => ({ ...config })) } : null;
    const result = await this.native(session).request(method, { sessionId: session.nativeId, cwd: session.cwd, mcpServers: session.tools.length ? [this.mcp(session.id)] : [] });
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
  private async prompt(session: Session, prompt: Value[], delegationId: string | null, inputId?: string): Promise<any> {
    await this.resume(session, inputId); const runtime = this.state(session.id);
    assertModelPolicy(this.options.modelPolicyPath, this.id, session.model, this.id === "cursor" ? session.reasoningConfig?.currentValue ?? null : null,
      (session.modelCatalog ?? []).map(m=>({model:m.id})));
    if (this.options.executionEnvironment) {
      const current = this.options.executionEnvironment.snapshot(this.options.executionEnvironment.execution('opencraft-server', session.id, inputId));
      if (current.owner !== this.sessionEnvironments.get(session.id)?.owner) throw new Error("ACP session belongs to another account or project; start a new session");
    }
    if (runtime.active?.status === "inProgress") return fault("ACP thread is already running", -32000);
    runtime.active = { id: `acp-turn-${randomUUID()}`, delegationId, ...(inputId ? { inputId } : {}), items: [], status: "inProgress", startedAtMs: Date.now() };
    const active = runtime.active;
    active.items.push({ id: `${active.id}:user`, type: "userMessage", clientId: inputId ?? null,
      content: prompt.map(item => ({ type: "text", text: item.text, text_elements: [] })) });
    session.lastTurn = { id: active.id, status: active.status };
    const firstText = prompt.map(item => item.text).join(" ").replace(/\s+/gu, " ").trim();
    if (!session.preview && firstText) session.preview = Array.from(firstText).slice(0, 160).join("");
    const initialTitle = !session.name && session.nameOrigin !== "manual" && firstText
      ? Array.from(firstText).slice(0, 80).join("") : null;
    if (initialTitle) { session.name = initialTitle; session.nameOrigin = "input"; }
    session.updatedAt = Math.floor(Date.now() / 1000); await this.save(session);
    if (initialTitle && session.name === initialTitle && session.nameOrigin === "input") this.notify("thread/name/updated", { threadId: session.id, threadName: initialTitle });
    this.notify("turn/started", { threadId: session.id, turn: this.turn(runtime), ...(inputId ? { clientMessageId: inputId } : {}) });
    void this.native(session).request("session/prompt", { sessionId: session.nativeId, prompt }, 0).then(result => {
      if (runtime.active !== active || active.status !== "inProgress") return;
      active.status = result.stopReason === "cancelled" ? "interrupted" : "completed";
      session.lastTurn = { id: active.id, status: active.status }; void this.save(session).catch(() => {});
      for (const item of active.items) if (item.type === "agentMessage" || item.type === "reasoning") this.notify("item/completed", { threadId: session.id, turnId: active.id, item });
      this.notify("turn/completed", { threadId: session.id, turn: this.turn(runtime) });
      for (const key of this.callbacks.keys()) if (key.startsWith(`${this.incarnation}:${session.id}:${active.id}:`)) this.callbacks.delete(key);
    }, () => {
      if (runtime.active !== active || active.status !== "inProgress") return;
      const code = this.nativeOutcomeUnknown ? "acpPromptUnconfirmed" : "acpPromptFailed";
      void this.failPrompt(session, runtime, code).catch(() => { this.persistenceFailed = true; });
    });
    return { turn: this.turn(runtime) };
  }
  private async failPrompt(session: Session, runtime: Runtime, code: "acpPromptFailed" | "acpPromptUnconfirmed"): Promise<void> {
    const active = runtime.active; if (!active || active.status !== "inProgress") return;
    active.status = "failed";
    active.error = { message: code, codexErrorInfo: "other", additionalDetails: null };
    const item = { id: `${active.id}:error`, type: "error", code, message: code };
    active.items.push(item);
    session.lastTurn = { id: active.id, status: active.status };
    const turn = this.turn(runtime);
    await this.save(session);
    this.notify("item/completed", { threadId: session.id, turnId: active.id, item });
    this.notify("turn/completed", { threadId: session.id, turn });
  }
  private historyParams(session: Session, params: Value): Value {
    const active = this.state(session.id).active;
    return { ...params, threadId: session.id, activeTurn: active?.status === "inProgress" ? { ...active, items: active.items.map(item => ({ ...item })) } : undefined };
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
  async close(): Promise<void> { if (this.closed) return; this.closed = true; this.callbackAbort.abort(); await Promise.all([this.transport.close(), ...[...this.sessionTransports.values()].map(transport => transport.close())]); await this.closeTools(); await this.persistence; await this.options.history?.close?.(); }
}

/** Explicit DSH ACP launch. The previous web generation remains a separate owner. */
export const dshAcpCommand = (entry: string, patches: readonly string[] = []) => ({ command: process.execPath,
  args: ["--expose-internals", entry, "--profile", "acp", ...patches.flatMap(patch => ["--patch", patch])] });
