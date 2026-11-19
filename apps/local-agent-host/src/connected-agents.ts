import { MODEL_CATALOG_REFRESH_METHOD } from "@opencraft/appserver-protocol";
import {CodeBuddyIdeBridge} from "./codebuddy-ide-bridge.js";
import {fileURLToPath} from "node:url";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { ExecutionEngineClient } from "@opencraft/appserver-client";
import { AcpEngine, type AcpEngineOptions } from "@opencraft/plugin-acp-engine";
import { ConnectedAgentHistory } from "./connected-agent-history.js";
import { AgentProviderUsageService } from "./agent-provider-usage.js";
import type { BridgeEngineProvider } from "./bridge-engine-provider.js";
import type { AgentConversationUsage, AgentUsageSnapshot } from "@opencraft/appserver-protocol";
import {
  AgentOnboardingService,
  ONBOARDING_AGENT_ENGINES as ENGINE_BY_AGENT,
  resolveExecutable,
  type OnboardingAgentId,
  type OnboardingDeps,
} from "./agent-onboarding.js";

type HistoryAgent = OnboardingAgentId;
const historyEngineId = (id: HistoryAgent): EngineId => ENGINE_BY_AGENT[id];
type EngineId = "codex" | "cursor" | "claude-code" | "codebuddy" | "codebuddy-ide" | "pi-cli";
const ENGINE_IDS = Object.values(ENGINE_BY_AGENT);
type Params = Record<string, unknown>;
interface ConnectedAgentModel {
  id: string;
  name: string;
  inputModalities: ("text" | "image")[];
  serviceTiers: { id: string; name: string; description: string }[];
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string | null;
}

const PLACEHOLDER = ":current";

export function connectedAgentModelId(agentId: OnboardingAgentId): string {
  return `${ENGINE_BY_AGENT[agentId]}${PLACEHOLDER}`;
}

export function connectedAgentEngineId(modelOrThread: string): EngineId | null {
  if (modelOrThread.startsWith("pi-cli:") || modelOrThread.startsWith("picli_")) return "pi-cli";
  if (modelOrThread.startsWith("claude-code:") || modelOrThread.startsWith("claude_")) return "claude-code";
  if (modelOrThread.startsWith("cursor:") || modelOrThread.startsWith("cursor_")) return "cursor";
  if (modelOrThread.startsWith("codebuddy-ide:") || modelOrThread.startsWith("codebuddy_ide_")) return "codebuddy-ide";
  if (modelOrThread.startsWith("codebuddy:") || modelOrThread.startsWith("codebuddy_")) return "codebuddy";
  if (modelOrThread.startsWith("codex:") || modelOrThread.startsWith("codex_")) return "codex";
  return null;
}

const LABELS: Record<EngineId, string> = {
  codex: "Codex",
  cursor: "Cursor",
  "claude-code": "Claude Code",
  codebuddy: "CodeBuddy CLI",
  "codebuddy-ide": "CodeBuddy IDE",
  "pi-cli": "Pi",
};

export function connectedAgentCatalogEntry(engineId: EngineId) {
  const id = `${engineId}${PLACEHOLDER}`;
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: LABELS[engineId],
    description: "Signed-in agent on this computer",
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ["text"] as ("text" | "image")[],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
    agentId: engineId,
    agentLabel: LABELS[engineId],
    groupKey: `connected-agent:${engineId}`,
    groupLabel: LABELS[engineId],
    source: "custom" as const,
  };
}

interface Launch {
  readonly engineId: EngineId;
  readonly command: string;
  readonly args: readonly string[];
}

/** New-thread routing to a pinned Agent Bridge generation. Legacy Threads keep
 * their ACP owner; the bridge only serves identities with its own prefix. */
export interface ConnectedAgentBridge {
  readonly provider: BridgeEngineProvider;
  readonly engines: readonly EngineId[];
}

/** Owns ACP sessions for agents that were signed in on this computer. */
export class ConnectedAgentHost {
  private readonly ideBridge:CodeBuddyIdeBridge;
  private readonly engines = new Map<string, AcpEngine>();
  private readonly sourceHomes = new Map<string,string>();
  private sourceBindingsLoad?: Promise<void>;
  private sourceBindingsWrite: Promise<void> = Promise.resolve();
  private readonly sourceReader = new ConnectedAgentHistory("codex", process.env.CODEX_HOME || join(homedir(), ".codex"));
  private readSourceBindings(): Promise<void> {
    return this.sourceBindingsLoad ??= (async () => {
      const raw = await readFile(join(this.root,"codex-sources.json"),"utf8").catch(error => {if(error.code === "ENOENT") return "[]";throw error;});
      const rows: unknown = JSON.parse(raw);
      if (!Array.isArray(rows) || rows.length > 100) throw new Error("Invalid saved Codex sources");
      const {createHash} = await import("node:crypto");
      for (const row of rows) {
        if (!row || typeof row.id !== "string" || typeof row.path !== "string" || !isAbsolute(row.path) || createHash("sha256").update(row.path).digest("hex").slice(0,24) !== row.id) throw new Error("Invalid saved Codex source binding");
        this.sourceHomes.set(row.id,row.path);
      }
    })();
  }
  async historySources(agentId:HistoryAgent) { return agentId === "codex" ? this.sourceReader.sources() : {sources:[]}; }
  private async historyEngine(agentId:HistoryAgent,sourceId?:string,commit=false):Promise<AcpEngine> {
    if (!sourceId || sourceId === "default") return this.engine(historyEngineId(agentId));
    if(agentId !== "codex") throw new Error("Unsupported native data source");
    await this.readSourceBindings();
    const source = (await this.historySources(agentId)).sources.find(source => source.id === sourceId);
    if(!source) throw new Error("Native data source is no longer available");
    if(commit) {
      this.sourceBindingsWrite = this.sourceBindingsWrite.catch(() => undefined).then(async () => {
        if(this.sourceHomes.get(sourceId) === source.path)return;
        const next = new Map(this.sourceHomes);next.set(sourceId,source.path);
        if(next.size > 100)throw new Error("Too many saved native data sources");
        await mkdir(this.root,{recursive:true,mode:0o700});
        const path=join(this.root,"codex-sources.json");
        await writeFile(path+".tmp",JSON.stringify([...next].map(([id,path])=>({id,path}))),{mode:0o600});
        await rename(path+".tmp",path);
        this.sourceHomes.set(sourceId,source.path);
      });
      await this.sourceBindingsWrite;
    }
    return this.sourceEngine(sourceId,source.path);
  }
  private async sourceEngine(id:string,home:string):Promise<AcpEngine> {
    const key=`source:${id}`;
    const existing=this.engines.get(key);if(existing)return existing;
    const loading=this.engineLoads.get(key);if(loading)return loading;
    if(this.closed)throw new Error("Connected agents are closed");
    const pending=this.createEngine("codex",{id,home});this.engineLoads.set(key,pending);
    try{return await pending;}finally{this.engineLoads.delete(key);}
  }
  private async threadEngine(engineId:EngineId,threadId?:unknown):Promise<AcpEngine> {
    const source=typeof threadId === "string" ? /^codex_source_([a-f0-9]{24})_/u.exec(threadId) : null;
    if(!source)return this.engine(engineId);
    await this.readSourceBindings();
    const home=this.sourceHomes.get(source[1]!);
    if(!home)throw new Error("Native conversation source binding missing");
    return this.sourceEngine(source[1]!,home);
  }
  private readonly engineLoads = new Map<string, Promise<AcpEngine>>();
  private readonly listeners = new Set<(method: string, params: Params) => void>();
  private ready: EngineId[] = [];
  private probedAt = 0;
  private closed = false;
  private readonly discovered = new Map<EngineId, ConnectedAgentModel[]>();
  private readonly modelLoads = new Map<EngineId, Promise<ConnectedAgentModel[]>>();
  private readonly providerUsage: AgentProviderUsageService;

  constructor(
    private readonly onboarding: AgentOnboardingService,
    private readonly root: string,
    private readonly cwd: string,
    private readonly deps: OnboardingDeps,
    private readonly bridge?: ConnectedAgentBridge,
    private readonly assets?: {readonly proxy:string;readonly extension:string},
    private readonly requestUserInput?: AcpEngineOptions["requestUserInput"],
  ) { this.providerUsage = new AgentProviderUsageService(deps);
    this.ideBridge=new CodeBuddyIdeBridge(join(root,"codebuddy-ide"),deps,assets?.extension);
    onboarding.registerNative?.("codebuddy-ide",{probe:()=>this.ideBridge.snapshot(),historyProbe:()=>this.ideBridge.snapshot(true),act:action=>this.ideBridge.act(action)});
  }
  async start(): Promise<void> { await this.ideBridge.start(); await this.bridge?.provider.start(); }
  ownsBridgeThread(threadId: string): boolean { return this.bridge?.provider.ownsThread(threadId) === true; }
  async usage(params: { threadId?: string; force?: boolean }): Promise<AgentUsageSnapshot> {
    const engineId = params.threadId ? connectedAgentEngineId(params.threadId) : null;
    const conversation = async (): Promise<AgentConversationUsage | null> => {
      if (!engineId || !params.threadId) return null;
      const engine = await this.threadEngine(engineId, params.threadId);
      return engine.request("opencraft/thread-usage/read", { threadId: params.threadId }, { notify() {}, async request() {} });
    };
    const [codex, cursor, current] = await Promise.all([this.providerUsage.read("codex", params.force), this.providerUsage.read("cursor", params.force), this.bridge?.provider.ownsThread(String(params.threadId ?? "")) ? null : conversation().catch(() => null)]);
    return { providers: [codex, cursor], conversation: current, readAt: Date.now() };
  }

  subscribe(listener: (method: string, params: Params) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  owns(method: string, params: Params): boolean {
    const owner = this.engineFor(method, params);
    if (method === "thread/start") return owner.bridge || owner.engineId !== null;
    return owner.bridge || owner.engineId !== null;
  }
  private engineFor(method: string, params: Params): { engineId: EngineId | null; bridge: boolean } {
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    if (this.bridge?.provider.ownsThread(threadId)) return { engineId: null, bridge: true };
    const engineId = method === "thread/start" || (method === "permissionProfile/list" || method === MODEL_CATALOG_REFRESH_METHOD) && !threadId
      ? connectedAgentEngineId(typeof params.model === "string" ? params.model : "")
      : connectedAgentEngineId(threadId);
    return { engineId, bridge: method === "thread/start" && engineId !== null && this.bridge?.engines.includes(engineId) === true };
  }

  private savedModels: Promise<void> | null = null;
  private catalogRefresh: Promise<void> | null = null;
  private readonly capabilityProbes = new Map<AcpEngine, Promise<void>>();
  private refreshInputCapabilities(engine: AcpEngine): void {
    if (!["codex", "cursor"].includes(engine.id) || engine.hasInputCapabilities !== false || this.capabilityProbes.has(engine) || this.closed) return;
    // Separate background negotiation from the saved-catalog read. It sends no
    // session/new, session/resume or prompt, including for imported sources.
    const pending = engine.refreshInputCapabilities().catch(() => undefined);
    this.capabilityProbes.set(engine, pending);
  }
  private async readSavedModels(): Promise<void> {
    await (this.savedModels ??= Promise.allSettled(ENGINE_IDS.map(async id => {
      const engine = await this.engine(id);
      const page = await engine.request("model/list", {}, { notify() {}, async request() {} });
      const models = this.projectModels(id, page.data ?? []);
      if (models.length && !this.discovered.has(id)) this.discovered.set(id, models);
    })).then(() => undefined));
  }
  async executionProviders() {
    await this.readSavedModels();
    return ENGINE_IDS.flatMap(id => {
      const engine = this.engines.get(id);
      return engine ? [{ id, label: LABELS[id], threadPrefix: engine.threadPrefix, modelPrefix: engine.modelPrefix, extensions: engine.extensions }] : [];
    });
  }
  async models(threadId?: string) {
    // Saved Agent declarations are metadata, never authorization to execute.
    // Do not launch peers or wait on login commands on this read path.
    await this.readSavedModels();
    if (!this.catalogRefresh && Date.now() - this.probedAt > 60_000) {
      this.catalogRefresh = this.refresh().then(async () => {
        await Promise.allSettled(this.ready.map(async id => {
          const before = JSON.stringify(this.discovered.get(id));
          await this.ensureAgentModels(id);
          if (!this.closed && JSON.stringify(this.discovered.get(id)) !== before)
            for (const listener of this.listeners) listener("opencraft/agents/models/changed", { agentId: id });
        }));
      }).catch(() => undefined).finally(() => { this.catalogRefresh = null; });
    }
    const engineId = threadId ? connectedAgentEngineId(threadId) : null;
    let catalogs: [EngineId, ConnectedAgentModel[]][];
    if (threadId && engineId) {
      const engine = await this.threadEngine(engineId, threadId);
      const page = await engine.request("model/list", { threadId }, { notify() {}, async request() {} });
      this.refreshInputCapabilities(engine);
      catalogs = [[engineId, this.projectModels(engineId, page.data ?? [])]];
    } else {
      catalogs = await Promise.all([...this.discovered.keys()].map(async id => {
        const page = await (await this.engine(id)).request("model/list", {}, { notify() {}, async request() {} });
        this.refreshInputCapabilities(await this.engine(id));
        const current = this.projectModels(id, page.data ?? []);
        return [id, current.length ? current : this.discovered.get(id) ?? []] as [EngineId, ConnectedAgentModel[]];
      }));
    }
    return catalogs.flatMap(([engineId, found]) => {
      if (threadId && connectedAgentEngineId(threadId) !== engineId) return [];
      return found.length > 0 ? found.map(model => ({
        ...connectedAgentCatalogEntry(engineId),
        id: model.id,
        model: model.id,
        displayName: model.name,
        inputModalities: model.inputModalities,
        serviceTiers: model.serviceTiers,
        supportedReasoningEfforts: model.supportedReasoningEfforts,
        defaultReasoningEffort: model.defaultReasoningEffort,
      })) : threadId ? [] : [connectedAgentCatalogEntry(engineId)];
    });
  }

  async listAgentModels(agentId: string): Promise<ConnectedAgentModel[]> {
    if (!Object.hasOwn(ENGINE_BY_AGENT, agentId)) throw new Error("Unknown agent");
    const engineId = ENGINE_BY_AGENT[agentId as OnboardingAgentId];
    if (!engineId) throw new Error("Unknown agent");
    return this.ensureAgentModels(engineId);
  }

  /** Catalog reads load saved metadata without starting or resuming native sessions. */
  async threads(): Promise<Record<string, any>[]> {
    // Reading a saved conversation does not need a CLI authentication probe.
    // Installed readers remain cold; an absent CLI leaves the Host's saved row.
    const engines: EngineId[] = ENGINE_IDS;
    await this.readSourceBindings();
    const readers = [...engines.map(id => this.engine(id)), ...[...this.sourceHomes].map(([id,home])=>this.sourceEngine(id,home))];
    const results = await Promise.allSettled(readers.map(async pending => {
      const engine = await pending;
      await engine.refreshNativeProjects();
      const rows: Record<string, any>[] = [];
      const client: ExecutionEngineClient = { request: () => Promise.reject(new Error("Catalog read has no tool owner")), notify: () => undefined };
      let cursor: string | null = null;
      do {
        const page = await engine.request("thread/list", { cursor, limit: 200 }, client);
        rows.push(...page.data); cursor = page.nextCursor ?? null;
      } while (cursor !== null);
      return rows;
    }));
    const bridgeThreads = this.bridge ? await this.bridge.provider.request("thread/list", { archived: false }, { request: () => Promise.reject(new Error("Catalog read has no tool owner")), notify: () => undefined })
      .then(page => Array.isArray(page?.data) ? page.data as Record<string, any>[] : []).catch(() => []) : [];
    return [...results.flatMap(result => result.status === "fulfilled" ? result.value : []), ...bridgeThreads];
  }

  private readonly historyCandidates = new Map<string, { id: string; title: string | null; cwd: string; updatedAt: string | null; seenAt: number }>();

  async localConversations(agentId: HistoryAgent, cursor?: string, isCommitted?: (threadId: string) => boolean, archived = false, sourceId?:string) {
    if (!Object.hasOwn(ENGINE_BY_AGENT, agentId)) throw new Error("Unsupported history source");
    const engine = await this.historyEngine(agentId,sourceId);
    const page = await engine.discoverNativeSessions(cursor, archived);
    for (const entry of page.sessions) this.historyCandidates.set(`${agentId}:${sourceId ?? "default"}:${entry.id}`, { ...entry, seenAt: Date.now() });
    while (this.historyCandidates.size > 5000) this.historyCandidates.delete(this.historyCandidates.keys().next().value!);
    return { conversations: page.sessions.map(({ importedThreadId, ...entry }) => ({ ...entry,
      imported: entry.imported && (!isCommitted || (!!importedThreadId && isCommitted(importedThreadId))) })), nextCursor: page.nextCursor, ...(page.supportsArchived ? { supportsArchived: true } : {}) };
  }

  async importLocalConversation(agentId: HistoryAgent, id: string, sourceId?:string): Promise<Record<string, any>> {
    const entry = this.historyCandidates.get(`${agentId}:${sourceId ?? "default"}:${id}`);
    if (!entry || Date.now() - entry.seenAt > 30 * 60_000) throw new Error("Refresh the local conversation directory before importing");
    return (await this.historyEngine(agentId,sourceId,true)).importNativeSession(entry);
  }

  private async ensureAgentModels(engineId: EngineId): Promise<ConnectedAgentModel[]> {
    const cached = this.discovered.get(engineId);
    if (cached) return cached;
    const existing = this.modelLoads.get(engineId);
    if (existing) return existing;
    const pending = this.loadAgentModels(engineId);
    this.modelLoads.set(engineId, pending);
    try { return await pending; }
    catch (error) { this.modelLoads.delete(engineId); throw error; }
  }

  async dispatch(method: string, params: Params): Promise<unknown> {
    const owner = this.engineFor(method, params);
    if (owner.bridge) {
      const client: ExecutionEngineClient = { request: () => Promise.reject(new Error("Connected agents use their own tools")), notify: () => undefined };
      return this.bridge!.provider.request(method, { ...params, cwd: typeof params.cwd === "string" && params.cwd.startsWith("/") ? params.cwd : this.cwd }, client);
    }
    const engineId = owner.engineId;
    if (!engineId) throw new Error("This conversation is not owned by a connected agent");
    if (method === "thread/goal/get") return { goal: null };
    if (method === MODEL_CATALOG_REFRESH_METHOD) {
      const engine = await this.threadEngine(engineId, params.threadId);
      const client: ExecutionEngineClient = { notify() {}, async request() { throw new Error("Discovery has no browser tool owner"); } };
      await engine.request(method, params, client);
      if (!(typeof params.threadId === "string" && params.threadId.startsWith("codex_source_"))) {
        const catalog = await engine.request("model/list", {}, client);
        this.discovered.set(engineId, this.projectModels(engineId, catalog.data ?? []));
        this.modelLoads.delete(engineId);
      }
      return {};
    }
    const engine = await this.threadEngine(engineId,params.threadId);
    if (method === "permissionProfile/list" && engineId === "codex" && !engine.hasPermissionCatalog) {
      // Explicit permission-menu discovery needs the peer's offered policies.
      // A fresh probe creates no turn and never resumes a user's conversation.
      const pending = this.modelLoads.get(engineId) ?? this.loadAgentModels(engineId);
      this.modelLoads.set(engineId, pending);
      try { await pending; } finally { if (this.modelLoads.get(engineId) === pending) this.modelLoads.delete(engineId); }
    }
    const client: ExecutionEngineClient = {
      request: () => Promise.reject(new Error("Connected agents use their own tools")),
      notify: () => undefined,
    };
    const forwarded = { ...params };
    if (typeof forwarded.model === "string" && forwarded.model.endsWith(PLACEHOLDER)) delete forwarded.model;
    if ((method === "turn/start" || method === "thread/fork") && typeof forwarded.model === "string" && !engine.ownsModel(forwarded.model)) {
      const catalog = await engine.request("model/list", {}, client);
      const nativeModel = `${engineId}:${forwarded.model}`;
      if ((catalog.data ?? []).some((model: { id: string }) => model.id === nativeModel)) forwarded.model = nativeModel;
    }
    if (method === "thread/start") {
      const model = typeof forwarded.model === "string" ? forwarded.model : undefined;
      return engine.request("thread/start", {
        cwd: engineId === "codebuddy-ide" && (forwarded.cwd === undefined || forwarded.cwd === this.cwd) ? await this.ideBridge.workspace() : typeof forwarded.cwd === "string" && forwarded.cwd.startsWith("/") ? forwarded.cwd : this.cwd,
        ...(forwarded.permissions != null ? { permissions: forwarded.permissions } : {}),
        ...(forwarded.approvalPolicy != null ? { approvalPolicy: forwarded.approvalPolicy } : {}),
        ...(forwarded.sandbox != null ? { sandbox: forwarded.sandbox } : {}),
        ...(model ? { model } : {}),
        ...(forwarded.reasoningEffort != null ? { reasoningEffort: forwarded.reasoningEffort } : {}),
        ...(forwarded.effort != null ? { effort: forwarded.effort } : {}),
        ...(Object.hasOwn(forwarded, "serviceTier") ? { serviceTier: forwarded.serviceTier } : {}),
      }, client);
    }
    return engine.request(method, forwarded, client);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.bridge?.provider.close().catch(() => undefined);
    this.providerUsage.close();
    await this.sourceReader.close();
    await Promise.allSettled(this.engineLoads.values());
    await Promise.all([...this.engines.values()].map(engine => engine.close()));
    await Promise.all(this.capabilityProbes.values());
    this.capabilityProbes.clear();
    this.engines.clear();
    await this.ideBridge.close();
  }

  private async loadAgentModels(engineId: EngineId): Promise<ConnectedAgentModel[]> {
    const engine = await this.engine(engineId);
    const client: ExecutionEngineClient = {
      request: () => Promise.reject(new Error("Connected agents use their own tools")),
      notify: () => undefined,
    };
    const created = await engine.request("thread/start", {
      cwd: engineId === "codebuddy-ide" ? await this.ideBridge.workspace() : this.cwd,
    }, client);
    await engine.request("thread/archive", { threadId: created.thread.id }, client);
    if (engineId === "codex" || engineId === "cursor") await engine.discoverModelCapabilities(created.thread.id);
    const listed = await engine.request("model/list", {}, client) as { data?: { id?: string; displayName?: string; serviceTiers?: unknown;
      supportedReasoningEfforts?: unknown; defaultReasoningEffort?: unknown }[] };
    const models = this.projectModels(engineId, listed.data ?? []);
    const resolved = models.length > 0 ? models : [{ id: `${engineId}${PLACEHOLDER}`, name: LABELS[engineId], inputModalities: ["text"] as ("text" | "image")[], serviceTiers: [], supportedReasoningEfforts: [], defaultReasoningEffort: null }];
    this.discovered.set(engineId, resolved);
    return resolved;
  }

  private projectModels(engineId: EngineId, rows: readonly { id?: string; displayName?: string; inputModalities?: unknown; serviceTiers?: unknown; supportedReasoningEfforts?: unknown; defaultReasoningEffort?: unknown }[]): ConnectedAgentModel[] {
    return rows.flatMap(model => typeof model.id === "string" && model.id.startsWith(`${engineId}:`)
      ? [{ id: model.id, name: model.displayName || model.id.slice(engineId.length + 1),
        inputModalities: Array.isArray(model.inputModalities) && model.inputModalities.includes("image") ? ["text", "image"] : ["text"],
        supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.filter(effort => effort && typeof effort.reasoningEffort === "string" && typeof effort.description === "string") : [],
        defaultReasoningEffort: typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : null,
        serviceTiers: Array.isArray(model.serviceTiers) ? model.serviceTiers.filter(tier => tier && typeof tier.id === "string" && typeof tier.name === "string" && typeof tier.description === "string") : [] }] : []);
  }

  private async refresh(): Promise<void> {
    if (Date.now() - this.probedAt < 15_000) return;
    const snapshot = await this.onboarding.status();
    this.probedAt = Date.now();
    this.ready = snapshot.agents.filter(agent => agent.authenticated === true && agent.connectionRequired !== true && agent.workspaceTrusted !== false).map(agent => ENGINE_BY_AGENT[agent.id]);
  }

  private async engine(engineId: EngineId): Promise<AcpEngine> {
    const existing = this.engines.get(engineId);
    if (existing) return existing;
    if (this.closed) throw new Error("Connected agents are closed");
    const existingLoad = this.engineLoads.get(engineId);
    if (existingLoad) return existingLoad;
    const pending = this.createEngine(engineId);
    this.engineLoads.set(engineId, pending);
    try { return await pending; } finally { this.engineLoads.delete(engineId); }
  }

  private async createEngine(engineId: EngineId, source?:{id:string;home:string}): Promise<AcpEngine> {
    const launch = await this.launch(engineId);
    const directory = source ? join(this.root,"codex-sources",source.id) : join(this.root, engineId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (this.closed) throw new Error("Connected agents are closed");
    const engine = new AcpEngine({
      id: engineId,
      ...(engineId === "pi-cli" ? { protocol: "pi-rpc" as const, threadNamespace: "picli_" } : {}),
      ...(source ? {threadNamespace:`codex_source_${source.id}_`,env:{...process.env,CODEX_HOME:source.home}} : {}),
      label: LABELS[engineId],
      command: launch.command,
      args: launch.args,
      cwd: this.cwd,
      dataDirectory: directory,
      ...(engineId === "codebuddy-ide" ? {env:{...process.env,OPENCRAFT_CODEBUDDY_IDE_DESCRIPTOR:this.ideBridge.descriptor}} : {}),
      permission: "allow-once",
      ...(engineId === "codex" && this.requestUserInput ? { requestUserInput: this.requestUserInput } : {}),
      timeoutMs: engineId === "codebuddy-ide" ? 330_000 : 120_000,
      ...(engineId === "pi-cli" ? { history: new ConnectedAgentHistory("pi-cli", join(directory, "native-sessions"), join(this.root, "continuations"), [join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions")]) } : {}),
      ...(engineId === "codebuddy-ide" ? { history: new ConnectedAgentHistory("codebuddy-ide", join(homedir(), process.platform === "darwin" ? "Library/Application Support" : process.platform === "win32" ? "AppData/Local" : ".local/share", "CodeBuddyExtension", "Data"), join(this.root, "continuations"), [], () => this.ideBridge.historyScope()) } : {}),
      ...(engineId === "claude-code" || engineId === "codebuddy" ? { history: new ConnectedAgentHistory(engineId,
        engineId === "claude-code" ? process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude") : join(process.env.CODEBUDDY_CONFIG_DIR || join(homedir(), ".codebuddy"), "projects"), join(this.root, "continuations")) } : {}),
      ...(engineId === "codex" || engineId === "cursor" ? { history: new ConnectedAgentHistory(engineId,
        engineId === "codex" ? source?.home || process.env.CODEX_HOME || join(homedir(), ".codex") : process.env.CURSOR_CONFIG_DIR || join(homedir(), ".cursor"), join(this.root, "continuations")) } : {}),
    });
    engine.subscribe((method, params) => {
      for (const listener of this.listeners) listener(method, params);
    });
    this.engines.set(source ? `source:${source.id}` : engineId, engine);
    return engine;
  }

  private async launch(engineId: EngineId): Promise<Launch> {
    if (engineId === "pi-cli") {
      const command = await resolveExecutable(["pi"], this.deps);
      if (!command) throw new Error("Pi is not installed");
      return { engineId, command, args: ["--mode", "rpc", "--offline", "--approve", "--session-dir", join(this.root, "pi-cli", "native-sessions")] };
    }
    if(engineId === "codebuddy-ide")return {engineId,command:process.execPath,args:[this.assets?.proxy??fileURLToPath(new URL("../../../scripts/codebuddy-ide/acp-proxy.mjs",import.meta.url))]};
    if (engineId === "cursor") {
      const command = await resolveExecutable(["cursor-agent"], this.deps);
      if (!command) throw new Error("Cursor is not installed");
      return { engineId, command, args: ["acp"] };
    }
    if (engineId === "codebuddy") {
      const command = await resolveExecutable(["codebuddy", "cbc"], this.deps);
      if (!command) throw new Error("CodeBuddy is not installed");
      return { engineId, command, args: ["--acp"] };
    }
    const npx = await resolveExecutable([process.platform === "win32" ? "npx.cmd" : "npx"], this.deps);
    if (!npx) throw new Error("npx is not available");
    const pkg = engineId === "codex" ? "@agentclientprotocol/codex-acp" : "@agentclientprotocol/claude-agent-acp";
    return { engineId, command: npx, args: ["-y", pkg] };
  }
}
