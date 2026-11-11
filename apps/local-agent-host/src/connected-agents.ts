import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExecutionEngineClient } from "@opencraft/appserver-client";
import { permissionModeProfileId } from "@opencraft/appserver-protocol";
import { AcpEngine } from "@opencraft/plugin-acp-engine";
import { ConnectedAgentHistory } from "./connected-agent-history.js";
import { AgentProviderUsageService } from "./agent-provider-usage.js";
import type { BridgeEngineProvider } from "./bridge-engine-provider.js";
import type { AgentConversationUsage, AgentUsageSnapshot } from "@opencraft/appserver-protocol";
import {
  AgentOnboardingService,
  resolveExecutable,
  type OnboardingAgentId,
  type OnboardingDeps,
} from "./agent-onboarding.js";

type EngineId = "codex" | "cursor" | "claude-code" | "codebuddy";
type Params = Record<string, unknown>;
interface ConnectedAgentModel {
  id: string;
  name: string;
  serviceTiers: { id: string; name: string; description: string }[];
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string | null;
}

const ENGINE_BY_AGENT: Record<OnboardingAgentId, EngineId> = {
  codex: "codex",
  cursor: "cursor",
  claude: "claude-code",
  codebuddy: "codebuddy",
};

const PLACEHOLDER = ":current";

export function connectedAgentModelId(agentId: OnboardingAgentId): string {
  return `${ENGINE_BY_AGENT[agentId]}${PLACEHOLDER}`;
}

export function connectedAgentEngineId(modelOrThread: string): EngineId | null {
  if (modelOrThread.startsWith("claude-code:") || modelOrThread.startsWith("claude_")) return "claude-code";
  if (modelOrThread.startsWith("cursor:") || modelOrThread.startsWith("cursor_")) return "cursor";
  if (modelOrThread.startsWith("codebuddy:") || modelOrThread.startsWith("codebuddy_")) return "codebuddy";
  if (modelOrThread.startsWith("codex:") || modelOrThread.startsWith("codex_")) return "codex";
  return null;
}

const LABELS: Record<EngineId, string> = {
  codex: "Codex",
  cursor: "Cursor",
  "claude-code": "Claude",
  codebuddy: "CodeBuddy",
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
    inputModalities: ["text"],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
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
  private readonly engines = new Map<EngineId, AcpEngine>();
  private readonly engineLoads = new Map<EngineId, Promise<AcpEngine>>();
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
  ) { this.providerUsage = new AgentProviderUsageService(deps); }
  async start(): Promise<void> { await this.bridge?.provider.start(); }
  ownsBridgeThread(threadId: string): boolean { return this.bridge?.provider.ownsThread(threadId) === true; }
  async usage(params: { threadId?: string; force?: boolean }): Promise<AgentUsageSnapshot> {
    const engineId = params.threadId ? connectedAgentEngineId(params.threadId) : null;
    const conversation = async (): Promise<AgentConversationUsage | null> => {
      if (!engineId || !params.threadId) return null;
      const engine = await this.engine(engineId);
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
    const engineId = method === "thread/start"
      ? connectedAgentEngineId(typeof params.model === "string" ? params.model : "")
      : connectedAgentEngineId(threadId);
    return { engineId, bridge: method === "thread/start" && engineId !== null && this.bridge?.engines.includes(engineId) === true };
  }

  async models() {
    if (Date.now() - this.probedAt > 60_000) await this.refresh();
    // Discover once per ready agent, including after Host restart. One failed
    // peer does not remove the API catalog or another healthy agent.
    await Promise.allSettled(this.ready.map(engineId => this.ensureAgentModels(engineId)));
    return this.ready.flatMap(engineId => {
      const found = this.discovered.get(engineId) ?? [];
      return found.length > 0 ? found.map(model => ({
        ...connectedAgentCatalogEntry(engineId),
        id: model.id,
        model: model.id,
        displayName: model.name,
        serviceTiers: model.serviceTiers,
        supportedReasoningEfforts: model.supportedReasoningEfforts,
        defaultReasoningEffort: model.defaultReasoningEffort,
      })) : [connectedAgentCatalogEntry(engineId)];
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
    const engines: EngineId[] = ["codex", "cursor", "claude-code", "codebuddy"];
    const results = await Promise.allSettled(engines.map(async id => {
      const engine = await this.engine(id), rows: Record<string, any>[] = [];
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
    const engine = await this.engine(engineId);
    const client: ExecutionEngineClient = {
      request: () => Promise.reject(new Error("Connected agents use their own tools")),
      notify: () => undefined,
    };
    const forwarded = { ...params };
    if (typeof forwarded.model === "string" && forwarded.model.endsWith(PLACEHOLDER)) delete forwarded.model;
    if (method === "thread/start") {
      const model = typeof forwarded.model === "string" ? forwarded.model : undefined;
      return engine.request("thread/start", {
        cwd: typeof forwarded.cwd === "string" && forwarded.cwd.startsWith("/") ? forwarded.cwd : this.cwd,
        permissions: permissionModeProfileId("full"),
        approvalPolicy: "never",
        sandbox: "danger-full-access",
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
    await Promise.allSettled(this.engineLoads.values());
    await Promise.all([...this.engines.values()].map(engine => engine.close()));
    this.engines.clear();
  }

  private async loadAgentModels(engineId: EngineId): Promise<ConnectedAgentModel[]> {
    const engine = await this.engine(engineId);
    const client: ExecutionEngineClient = {
      request: () => Promise.reject(new Error("Connected agents use their own tools")),
      notify: () => undefined,
    };
    const created = await engine.request("thread/start", {
      cwd: this.cwd,
      permissions: permissionModeProfileId("full"),
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    }, client);
    await engine.request("thread/archive", { threadId: created.thread.id }, client);
    if (engineId === "codex" || engineId === "cursor") await engine.discoverModelCapabilities(created.thread.id);
    const listed = await engine.request("model/list", {}, client) as { data?: { id?: string; displayName?: string; serviceTiers?: unknown;
      supportedReasoningEfforts?: unknown; defaultReasoningEffort?: unknown }[] };
    const models = (listed.data ?? []).flatMap(model => typeof model.id === "string" && model.id.startsWith(`${engineId}:`)
      ? [{ id: model.id, name: model.displayName || model.id.slice(engineId.length + 1),
        supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.filter(effort => effort && typeof effort.reasoningEffort === "string" && typeof effort.description === "string") : [],
        defaultReasoningEffort: typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : null,
        serviceTiers: Array.isArray(model.serviceTiers) ? model.serviceTiers.filter(tier => tier && typeof tier.id === "string" && typeof tier.name === "string" && typeof tier.description === "string") : [] }] : []);
    const resolved = models.length > 0 ? models : [{ id: `${engineId}${PLACEHOLDER}`, name: LABELS[engineId], serviceTiers: [], supportedReasoningEfforts: [], defaultReasoningEffort: null }];
    this.discovered.set(engineId, resolved);
    return resolved;
  }

  private async refresh(): Promise<void> {
    if (Date.now() - this.probedAt < 15_000) return;
    const snapshot = await this.onboarding.status();
    this.probedAt = Date.now();
    this.ready = snapshot.agents.filter(agent => agent.authenticated === true).map(agent => ENGINE_BY_AGENT[agent.id]);
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

  private async createEngine(engineId: EngineId): Promise<AcpEngine> {
    const launch = await this.launch(engineId);
    const directory = join(this.root, engineId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (this.closed) throw new Error("Connected agents are closed");
    const engine = new AcpEngine({
      id: engineId,
      label: LABELS[engineId],
      command: launch.command,
      args: launch.args,
      cwd: this.cwd,
      dataDirectory: directory,
      permission: "allow-once",
      timeoutMs: 120_000,
      ...(engineId === "codex" || engineId === "cursor" ? { history: new ConnectedAgentHistory(engineId,
        engineId === "codex" ? process.env.CODEX_HOME || join(homedir(), ".codex") : process.env.CURSOR_CONFIG_DIR || join(homedir(), ".cursor")) } : {}),
    });
    engine.subscribe((method, params) => {
      for (const listener of this.listeners) listener(method, params);
    });
    this.engines.set(engineId, engine);
    return engine;
  }

  private async launch(engineId: EngineId): Promise<Launch> {
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
