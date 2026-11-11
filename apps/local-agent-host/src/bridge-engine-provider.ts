import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ExecutionEngineClient, ExecutionEngineProvider } from "@opencraft/appserver-client";
import { OPENCRAFT_STEER_EVIDENCE_EXTENSION, permissionModeProfileId } from "@opencraft/appserver-protocol";
import { BridgeGateway, type BridgeGatewayOptions } from "@opencraft/agent-bridge-host/gateway";

type Value = Record<string, any>;

/** Engine implementations whose native protocol is the P1a bridge protocol. */
export type BridgeProviderEngine = "claude-code" | "pi" | "dsh-acp";

/** Catalog entries are static because model/list itself is a Host command that
 * requires an existing Thread route; the bridge's real catalog is probed per
 * session and remains authoritative for that session. */
export interface BridgeProviderModel {
  readonly id: string;
  readonly name?: string;
  readonly hidden?: boolean;
  readonly isDefault?: boolean;
}

export interface BridgeEngineProviderOptions {
  readonly id: string;
  readonly label: string;
  readonly engine: BridgeProviderEngine;
  readonly threadPrefix: string;
  readonly modelPrefix: string;
  /** Absolute path used when a new Thread arrives without one. */
  readonly defaultCwd: string;
  /** Required for Pi; used as the cheapest configured default elsewhere. */
  readonly defaultModel?: string;
  readonly models?: readonly BridgeProviderModel[];
  readonly generation?: string;
  readonly gateway: BridgeGatewayOptions;
}

function object(value: unknown): Value {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
}

function textOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  return input.flatMap(entry => {
    const part = object(entry);
    return part.type === "text" && typeof part.text === "string" ? [part.text] : [];
  }).join("");
}

function absolutePath(value: unknown): string | undefined {
  return typeof value === "string" && isAbsolute(value) ? value : undefined;
}

/**
 * AppServer execution-engine provider over a pinned agent-bridge Host
 * generation. The bridge owns native sessions, steering evidence and stream
 * translation; this adapter only maps the existing Engine Host contract onto
 * the durable Host command surface. Old Threads are never adopted: ownership is
 * selected by thread prefix, so a legacy owner keeps its native sessions.
 */
export class BridgeEngineProvider implements ExecutionEngineProvider {
  readonly id: string;
  readonly label: string;
  readonly threadPrefix: string;
  readonly modelPrefix: string;
  readonly storageOutcomes: readonly unknown[] = [];
  private readonly gateway: BridgeGateway;
  private readonly listeners = new Set<(method: string, params: Value) => void>();
  private readonly known = new Map<string, { cwd: string; model: string | null }>();
  private capabilityExtensions: Readonly<Record<string, unknown>> = {};
  private declaration: any = null;
  private started?: Promise<void>;
  private closing = false;

  constructor(private readonly options: BridgeEngineProviderOptions) {
    if (!options.threadPrefix || !options.modelPrefix) throw new Error("Bridge provider prefixes are required");
    this.id = options.id;
    this.label = options.label;
    this.threadPrefix = options.threadPrefix;
    this.modelPrefix = options.modelPrefix;
    this.gateway = new BridgeGateway(options.gateway, (threadId, frame) => {
      const value = object(frame);
      if (typeof value.method !== "string" || !this.ownsThread(threadId)) return;
      for (const listener of this.listeners) listener(value.method, object(value.params));
    });
  }

  get extensions(): Readonly<Record<string, unknown>> { return this.capabilityExtensions; }

  async start(): Promise<void> {
    this.started ??= this.open().catch(async error => { await this.gateway.close().catch(() => undefined); throw error; });
    return this.started;
  }

  private async open(): Promise<void> {
    await this.gateway.open();
    const snapshot = await this.gateway.rpc("/snapshot");
    const current = this.options.generation ?? snapshot.current;
    const generation = snapshot.generations.find((row: any) => row.id === current && row.retired !== 1);
    if (!generation) throw new Error(`Bridge generation ${String(current)} is unavailable`);
    this.declaration = generation.config?.provider;
    const steer = object(object(this.declaration?.capabilities).steer);
    const deliveryMethods = Array.isArray(steer.deliveryMethods) ? steer.deliveryMethods.filter((entry: unknown) => typeof entry === "string") : ["native-inject"];
    const evidenceKinds = Array.isArray(steer.evidenceKinds) ? steer.evidenceKinds.filter((entry: unknown) => typeof entry === "string") : ["admission"];
    this.capabilityExtensions = {
      "opencraft/thread-follow-up": { version: 1, queue: false, steer: true },
      "opencraft/thread-lifecycle": { version: 1, fork: false, ephemeral: false, injectItems: false, rename: false, archive: false, unsubscribe: true },
      [OPENCRAFT_STEER_EVIDENCE_EXTENSION]: {
        version: 1,
        perInputEvidence: true,
        deliveryMethods,
        evidenceKinds,
        withdrawal: "none",
        query: true,
      },
    };
  }

  ownsThread(id: string): boolean { return typeof id === "string" && id.startsWith(this.threadPrefix); }
  ownsModel(id: string): boolean { return typeof id === "string" && id.startsWith(this.modelPrefix); }

  subscribe(listener: (method: string, params: Value) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  disconnect(_client: ExecutionEngineClient): void { /* Host owns sessions; Engine Host connections do not. */ }

  async request(method: string, params: Value, _client: ExecutionEngineClient): Promise<any> {
    if (method === "initialize") {
      return { userAgent: `opencraft-agent-bridge/${this.options.engine}`, capabilities: { extensions: this.capabilityExtensions } };
    }
    await this.start();
    switch (method) {
      case "thread/start": return this.create(params);
      case "thread/resume": return this.resume(params);
      case "thread/read": return this.read(params);
      case "thread/list": return this.list(params);
      case "model/list": return this.models();
      case "turn/start": return this.startTurn(params);
      case "turn/steer": return this.steer(params);
      case "turn/interrupt": return this.interrupt(params);
      case "opencraft/steer/status": return this.gateway.status(String(params.threadId ?? ""), Array.isArray(params.inputIds) ? params.inputIds : undefined);
      case "thread/queue/list": return { data: [], steering: [], nextCursor: null };
      case "thread/queue/add": throw new Error("Bridge Threads do not support a queued follow-up; use turn/steer during an active turn");
      case "thread/unsubscribe": return {};
      case "thread/name/set": return {};
      case "thread/archive":
      case "thread/unarchive":
      case "thread/delete":
      case "thread/fork":
      case "thread/inject_items":
        throw Object.assign(new Error(`Bridge Threads do not support ${method}`), { code: -32601 });
      default:
        throw Object.assign(new Error(`Bridge Thread does not support ${method}`), { code: -32601 });
    }
  }

  private async create(params: Value): Promise<Value> {
    const threadId = `${this.threadPrefix}${randomUUID()}`;
    const cwd = absolutePath(params.cwd) ?? this.options.defaultCwd;
    const model = this.model(params);
    this.gateway.reserve(threadId);
    const created = object(await this.gateway.command(threadId, this.commandId(threadId, "session/create", threadId), "session/create", this.createParams(cwd, model)));
    this.known.set(threadId, { cwd, model: model ?? null });
    return this.sessionResponse(threadId, cwd, typeof created.model === "string" ? created.model : model, "active");
  }

  private async resume(params: Value): Promise<Value> {
    const threadId = String(params.threadId ?? "");
    if (!this.ownsThread(threadId)) throw new Error("Bridge provider does not own this Thread");
    const native = await this.gateway.nativeSession(threadId);
    if (!native) throw Object.assign(new Error("Bridge Thread has no recorded native session"), { code: -32602 });
    const known = this.known.get(threadId);
    const cwd = absolutePath(params.cwd) ?? known?.cwd ?? this.options.defaultCwd;
    const model = this.model(params) ?? known?.model ?? undefined;
    const resume = this.options.engine === "claude-code"
      ? { providerThreadId: native.nativeId, cwd }
      : { providerThreadId: native.nativeId, cwd, ...(model === undefined ? {} : this.options.engine === "pi" ? { model } : { modelSelection: model }), ...(this.options.engine === "dsh-acp" ? { permissionMode: "full" } : {}) };
    await this.gateway.command(threadId, this.commandId(threadId, "session/resume", native.nativeId), "session/resume", resume);
    this.known.set(threadId, { cwd, model: model ?? null });
    return this.sessionResponse(threadId, cwd, model, "idle");
  }

  private async read(params: Value): Promise<Value> {
    const threadId = String(params.threadId ?? "");
    if (!this.ownsThread(threadId)) throw new Error("Bridge provider does not own this Thread");
    const known = this.known.get(threadId);
    return { thread: this.thread(threadId, known?.cwd ?? this.options.defaultCwd, known?.model ?? null, "idle", []) };
  }

  private async list(params: Value): Promise<Value> {
    if (params.archived === true) return { data: [], nextCursor: null };
    const routes = await this.gateway.routeRows();
    const rows = routes.filter(row => this.ownsThread(row.threadId) && (this.options.generation === undefined || row.generation === this.options.generation));
    const search = typeof params.searchTerm === "string" ? params.searchTerm.trim().toLowerCase() : "";
    const data = rows.map(row => this.thread(row.threadId, this.known.get(row.threadId)?.cwd ?? this.options.defaultCwd,
      this.known.get(row.threadId)?.model ?? null, "idle", [])).filter(row => !search || row.id.toLowerCase().includes(search));
    return { data, nextCursor: null };
  }

  private models(): Value {
    const models = (this.options.models ?? []).map(model => ({
      id: model.id,
      model: model.id,
      displayName: model.name ?? model.id,
      hidden: model.hidden === true,
      isDefault: model.isDefault === true,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      serviceTiers: [],
    }));
    return { data: models, nextCursor: null };
  }

  private async startTurn(params: Value): Promise<Value> {
    const threadId = String(params.threadId ?? "");
    if (!this.ownsThread(threadId)) throw new Error("Bridge provider does not own this Thread");
    const text = textOf(params.input);
    if (!text.trim()) throw Object.assign(new Error("Input text is required"), { code: -32602 });
    const clientRequestId = typeof params.clientUserMessageId === "string" && params.clientUserMessageId
      ? params.clientUserMessageId : randomUUID();
    const inputId = clientRequestId;
    const commandId = this.commandId(threadId, "turn/start", clientRequestId);
    const model = this.model(params);
    const turnParams: Value = this.options.engine === "claude-code"
      ? { input: { text }, inputId, clientRequestId }
      : this.options.engine === "pi"
        ? { input: [{ type: "text", text }], inputId, clientRequestId, ...(model ? { model } : {}), ...(typeof params.reasoningEffort === "string" ? { thinkingLevel: params.reasoningEffort } : {}) }
        : { input: { text }, inputId, clientRequestId, permissionMode: "full" };
    const result = object(await this.gateway.command(threadId, commandId, "turn/start", turnParams));
    let canonical = typeof result.nativeTurnId === "string" ? this.gateway.canonicalTurn(threadId, result.nativeTurnId) : undefined;
    if (canonical === undefined && typeof result.turnId === "string") canonical = this.gateway.canonicalTurn(threadId, result.turnId);
    canonical ??= await this.gateway.latestTurn(threadId) ?? undefined;
    if (canonical === undefined) throw Object.assign(new Error("Bridge turn started without an assembled turn identity"), { code: -32005 });
    return { turn: { id: canonical, items: [], itemsView: "summary", status: "inProgress", error: null,
      startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null } };
  }

  private async steer(params: Value): Promise<Value> {
    const threadId = String(params.threadId ?? "");
    if (!this.ownsThread(threadId)) throw new Error("Bridge provider does not own this Thread");
    const expected = String(params.expectedTurnId ?? "");
    if (!expected) throw Object.assign(new Error("expectedTurnId is required"), { code: -32602 });
    const text = textOf(params.input);
    if (!text.trim()) throw Object.assign(new Error("Input text is required"), { code: -32602 });
    const native = this.gateway.nativeTurn(threadId, expected);
    const clientRequestId = typeof params.clientUserMessageId === "string" && params.clientUserMessageId
      ? params.clientUserMessageId : randomUUID();
    const result = object(await this.gateway.command(threadId, this.commandId(threadId, "turn/steer", clientRequestId), "turn/steer", {
      inputId: clientRequestId,
      clientRequestId,
      expectedTurnId: native,
      delivery: "native-inject",
      input: this.options.engine === "pi" ? [{ type: "text", text }] : { text },
    }));
    return { ...result, turnId: expected, disposition: "steered" };
  }

  private async interrupt(params: Value): Promise<Value> {
    const threadId = String(params.threadId ?? "");
    if (!this.ownsThread(threadId)) throw new Error("Bridge provider does not own this Thread");
    let native: string | undefined;
    try { native = this.gateway.nativeTurn(threadId, String(params.turnId ?? "")); } catch { native = undefined; }
    await this.gateway.command(threadId, this.commandId(threadId, "turn/stop", String(params.turnId ?? "")), "turn/stop",
      native === undefined ? {} : { expectedTurnId: native });
    return {};
  }

  private model(params: Value): string | undefined {
    const raw = typeof params.model === "string" ? params.model : undefined;
    if (raw === undefined || raw === "" || raw.endsWith(":current")) return this.options.defaultModel;
    if (this.options.engine === "claude-code") return raw.replace(/^claude-code:/u, "") || this.options.defaultModel;
    if (this.options.engine === "dsh-acp") return raw.replace(/^(?:dsh-acp|dsh):/u, "") || this.options.defaultModel;
    return raw || this.options.defaultModel;
  }

  private createParams(cwd: string, model: string | undefined): Value {
    switch (this.options.engine) {
      case "claude-code": return { cwd, ...(model ? { model } : {}), permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
      case "pi": return { cwd, ...(model ? { model } : {}) };
      case "dsh-acp": return { cwd, permissionMode: "full", ...(model ? { modelSelection: model } : {}) };
    }
  }

  private commandId(threadId: string, method: string, key: string): string {
    return `bridge-provider:${createHash("sha256").update(JSON.stringify([this.options.gateway.serverId, threadId, method, key])).digest("hex")}`;
  }

  private sessionResponse(threadId: string, cwd: string, model: string | undefined, status: "active" | "idle"): Value {
    return {
      thread: this.thread(threadId, cwd, model ?? null, status, []),
      model: model ?? `${this.modelPrefix}current`,
      modelProvider: this.id,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      instructionSources: [],
      disabledPluginIds: [],
      serviceTier: null,
      reasoningEffort: null,
      multiAgentMode: "explicitRequestOnly",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "dangerFullAccess" },
      activePermissionProfile: { id: permissionModeProfileId("full"), extends: null },
    };
  }

  private thread(threadId: string, cwd: string, model: string | null, status: "active" | "idle", turns: Value[]): Value {
    const now = Math.floor(Date.now() / 1000);
    return {
      id: threadId,
      sessionId: threadId,
      extra: { agentBridge: { engine: this.options.engine, generation: this.options.generation ?? null } },
      forkedFromId: null,
      parentThreadId: null,
      preview: "",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "paginated",
      modelProvider: this.id,
      model,
      reasoningEffort: null,
      createdAt: now,
      updatedAt: now,
      recencyAt: now,
      status: status === "active" ? { type: "active", activeFlags: [] } : { type: "idle" },
      path: null,
      cwd,
      cliVersion: "agent-bridge/1",
      source: "appServer",
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns,
    };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.gateway.close();
    this.listeners.clear();
  }
}
