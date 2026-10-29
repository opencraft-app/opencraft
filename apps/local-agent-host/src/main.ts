import { SHARED_INTERACTIONS_EXTENSION, SHARED_INTERACTIONS_CHANGED, SHARED_INTERACTIONS_READ, SHARED_INTERACTIONS_RESPOND } from "@opencraft/appserver-protocol";
import { nodeObserver } from "../../../packages/observability-contract/node.mjs";
import { dshHostInputs } from "./dsh-host-inputs.js";
import { handleHostInput } from "./host-input-http.js";
import type { DshExecutionOwner } from "./dsh-execution-authority.js";
import { serializeHistoryReply } from "@opencraft/appserver-client";
import { observeNativeTranscriptFiles } from "@opencraft/native-history-node";
import { fileRequest } from "./host-resources.js";
import { ConversationSchedules, ScheduleFault } from "@opencraft/host-schedules";
import { CONVERSATION_SCHEDULES_EXTENSION } from "@opencraft/appserver-protocol";
import { dshScheduleExecutionPort } from "./dsh-schedules.js";
import { dshInterruptedTurns } from "./dsh-interrupted-turns.js";
import { TURN_RECOVERY_EXTENSION } from "@opencraft/appserver-protocol";
import type { RuntimeMachineIdentity } from "@opencraft/appserver-protocol";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir, stat, lstat, writeFile, mkdtemp, rm, access } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { WebSocket, WebSocketServer } from "ws";

import { DshAppServerAdapter, decodeModel } from "./dsh-appserver-adapter.js";
import { DshClient, DshClientError } from "./dsh-client.js";
import { DshSupervisor } from "./dsh-supervisor.js";
import { DshRestartBudget } from "./dsh-restart-budget.js";
import { openLocalAgentStorage, type LocalAgentStorage } from "./storage/local-agent-storage.js";
import { DshCapabilityBroker, normalizeCapabilities } from "./dsh-capability-broker.js";
import { HostDocumentService, HostDocumentFault } from "./storage/host-document-service.js";
import { startTasksAgent } from "@opencraft/plugin-tasks/agent";
import { TasksService, TasksFault } from "@opencraft/plugin-tasks/server";
import { HOST_STORAGE } from "@opencraft/appserver-protocol/host-storage";
import {
  DshCapabilityLink,
  verifyDshCapabilityRegistration,
  prepareDshExecutionCapabilities,
} from "./dsh-capability-link.js";
import { requestLoopback } from "./loopback-http.js";
import { DshRoutedClient } from "./dsh-routed-client.js";
import { HostProcessService } from "./process-service.js";
import { ProjectRepository } from "./project-repository.js";
import { ThreadCatalogPublisher } from "@opencraft/app-host-server/thread-catalog";
import { ThreadLifecycle } from "./thread-lifecycle.js";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ProfileSkillsMethod } from "@opencraft/appserver-protocol";
import { DshProfileSkillsHandler } from "./dsh-profile-skills.js";
import { SkillCatalogRefresh } from "./skills/catalog-refresh.js";
import { OPENCRAFT_ATTACHMENT_STAGING_EXTENSION } from "@opencraft/appserver-protocol";
import { LocalAttachmentStagingService } from "./attachments/local-attachment-staging.js";
import { LocalWorkspaceResolver } from "./projectless-workspace.js";

export { acquireLocalAgentStorageOwner } from "./storage/daemon-storage-owner.js";
export { openLocalAgentStorage } from "./storage/local-agent-storage.js";

type JsonRpcMessage = Record<string, unknown>;
const PROFILE_SKILLS_METHODS = new Set<ProfileSkillsMethod>([
  "skills/installed/list",
  "skills/installed/content/read",
  "skills/enabled/set",
  "skills/catalog/sources/list",
  "skills/catalog/official/list",
  "skills/catalog/search",
  "skills/catalog/preview",
  "skills/catalog/scan",
  "skills/install",
  "skills/uninstall",
  "skills/update",
  "skills/action/read",
]);
const replyClient = new AsyncLocalStorage<string>();
const ownerReply = new AsyncLocalStorage<(packet:Record<string,unknown>) => {id:string;receipt:string}>();
interface LogicalClient {
  readonly key: string;
  readonly clientId: string;
  readonly owner: import("./dsh-execution-authority.js").DshExecutionOwner;
  readonly offered: Set<string>;
  readonly openedThreads: Set<string>;
  initialized?: boolean;
  sharedInteractions?: boolean;
  unsubscribeInteractions?: () => void;
}

function rpcError(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof HostDocumentFault) return { code: error.code, message: error.message };
  if (error instanceof ScheduleFault) return { code: error.code, message: error.message };
  if (error instanceof TasksFault) return { code: error.code, message: error.message };
  if (error instanceof DshClientError) return { code: -32001, message: error.message, data: { code: error.code, retryable: error.retryable } };
  if (typeof error === "object" && error !== null) {
    const candidate = error as { rpcCode?: unknown; domainData?: unknown; message?: unknown };
    if (typeof candidate.rpcCode === "number") {
      return {
        code: candidate.rpcCode,
        message: typeof candidate.message === "string" ? candidate.message : "AppServer request failed",
        ...(candidate.domainData === undefined ? {} : { data: candidate.domainData }),
      };
    }
  }
  return { code: -32603, message: error instanceof Error ? error.message : String(error) };
}

function send(socket: WebSocket, value: unknown, method = ""): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  let packet = value as Record<string, unknown>;
  const client = replyClient.getStore(), finish = ownerReply.getStore();
  if (packet && "id" in packet && !("method" in packet) && finish) packet = {...packet,opencraftDshReceipt:finish(packet)};
  socket.send(serializeHistoryReply(client && packet && "id" in packet && !(LOGICAL_CLIENT_FIELD in packet)
    ? { ...packet, [LOGICAL_CLIENT_FIELD]: client } : packet, method));
}
function sendClient(socket: WebSocket, clientId: string, packet: Record<string, unknown>): void {
  send(socket, { ...packet, [LOGICAL_CLIENT_FIELD]: clientId || undefined });
}


export async function startLocalAgentHost(options: {
  readonly ownerHandoff?: {
    open(): boolean;
    nativeLost(): Promise<void>;
    recoverNative(restart: () => Promise<void>): Promise<void>;
    beginReceipt(request:unknown): (packet:Record<string,unknown>) => {id:string;receipt:string};
    acknowledgeReceipt(input:unknown): void;
    run<T>(operation: () => Promise<T>, reconciliation?: boolean): Promise<T>;
    control(action: string, input: any): Promise<unknown>;
  };
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  readonly dshUrl?: string;
  readonly sessionCapabilities?: import("@opencraft/session-capabilities").SessionCapabilityPort;
  readonly authorizeHostInput?: (threadId: string, inputId: string) => boolean | Promise<boolean>;
  readonly dshExecutable?: string;
  readonly dshRepository?: string;
  /** Stable operational cwd for packaged Daemon/DSH processes; never a Thread workspace. */
  readonly runtimeDirectory?: string;
  /** Explicit development/package path; the Agent Host never infers Electron's cwd. */
  readonly dshCapabilityPlugin?: string;
  readonly modelPolicyPath?: string;
  readonly dataDirectory?: string;
  readonly environmentDataDirectory?: string;
  readonly storage?: LocalAgentStorage;
  readonly machineIdentity?: RuntimeMachineIdentity;
  readonly modelStorageDirectory?: string;
  /** Application speech service is installed by Headless; not inferred for desktop/remote engines. */
  readonly speechModelManagement?: boolean;
  readonly projectStorageDirectory?: string;
  /** Host-owned root for Projectless Threads; defaults to ~/OpenCraft. */
  readonly projectlessWorkspaceDirectory?: string;
  /** Test/embedding override; desktop defaults to ~/.opencraft/skills. */
  readonly skillsDirectory?: string;
  readonly taskSkillDirectories?: readonly string[];
  readonly taskServerId?: string;
  readonly taskConversationCatalog?: (serverId: string, search: string, limit: number, cursor?: string | null) => Promise<unknown>;
} = {}) {
  nodeObserver("dsh");
  const storage = options.storage ?? openLocalAgentStorage({ dataDirectory: options.dataDirectory });
  const cleanup: (() => void | Promise<void>)[] = [() => storage.close()];
  let stopAccepting: (() => Promise<void>) | undefined;
  let drainThreads: (() => Promise<void>) | undefined;
  const dispose = async () => {
    let failure: unknown;
    const releaseAll = [stopAccepting, drainThreads, ...[...cleanup].reverse()];
    for (const release of releaseAll) {
      try { await release?.(); } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  };
  try {
  let closing = false;
  let onEngineExit: ((error: Error) => void) | undefined;
  let engineStatus: "ready" | "restarting" | "failed" = "ready";
  const bridgeToken = randomBytes(32).toString("hex");
  const persistentSkillsRoot = resolve(options.skillsDirectory ?? join(homedir(), ".opencraft", "skills"));
  const productDataRoot = resolve(options.dataDirectory ?? join(homedir(), ".opencraft"));
  const attachmentStaging = new LocalAttachmentStagingService(
    join(productDataRoot, "attachments"),
  );
  cleanup.push(() => attachmentStaging.close());
  let bridgeUrl: string | undefined;
  let capabilityLink: DshCapabilityLink | undefined;
  const managedConnectors = storage.connectors;
  const connectorListeners = new Set<(id: string) => void>();
  managedConnectors.subscribe(id => { for (const listener of connectorListeners) listener(id); });
  const connectors = () => managedConnectors;
  let bridgeDirectory: string | undefined;
  cleanup.push(async () => { if (bridgeDirectory) await rm(bridgeDirectory, { recursive: true, force: true }); });
  const patches: string[] = [];
  if (!options.dshUrl && !process.env.OPENCRAFT_DSH_URL?.trim()) {
    const executable = resolve(options.dshExecutable ?? process.env.OPENCRAFT_DSH_EXECUTABLE ?? "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");
    const bundled = resolve(dirname(executable), "../../../../opencraft-capability-plugin.mjs");
    let plugin = resolve(options.dshCapabilityPlugin ?? bundled);
    try { await access(plugin); } catch {
      if (options.dshCapabilityPlugin !== undefined) throw new Error(`DSH capability plugin is unavailable at ${plugin}`);
      plugin = resolve("apps/local-agent-host/src/dsh-capability-plugin.mjs");
      await access(plugin);
    }
    bridgeDirectory = await mkdtemp(join(tmpdir(), "opencraft-engine-plugin-"));
    const patch = join(bridgeDirectory, "patch.json");
    let nativePlugin = plugin;
    // Source previews run DSH without the parent's TS loader. Packaged plugins
    // are already bundled; only source composition needs this build step.
    try {
      await access(resolve(dirname(plugin), '../../../scripts/execution-environment.ts'));
      const { build } = await import('esbuild');
      nativePlugin = join(bridgeDirectory, 'dsh-capability-plugin.mjs');
      await build({ entryPoints: [plugin], outfile: nativePlugin, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent' });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const engineModule = (name: string) => pathToFileURL(resolve(dirname(executable), `../../${name}/lib/index.js`)).href;
    await writeFile(patch, JSON.stringify([
      { id: "session-persistence-jsonl", name: resolve(dirname(plugin), "dsh-thread-persistence-plugin.mjs"), config: { moduleUrl: engineModule("dsh-session-persistence-jsonl") } },
      { id: "session-projection-cache", name: resolve(dirname(plugin), "dsh-thread-projection-plugin.mjs"), config: { moduleUrl: engineModule("dsh-session-projection-cache") } },
      { insert: [{ id: "opencraft-capability", name: nativePlugin, config: {
      modelPolicyPath: options.modelPolicyPath, environmentDataDirectory: options.environmentDataDirectory, token: bridgeToken, ownerRequired: !!options.ownerHandoff,
      skillsRoot: join(bridgeDirectory, "skills"),
      persistentSkillsRoot,
      taskSkillsRoot: join(productDataRoot, "task-agent"),
      checkpointRoot: resolve(options.dataDirectory ?? bridgeDirectory, "surface-checkpoints"),
      toolsModuleUrl: pathToFileURL(resolve(dirname(executable), "../../dsh-tools/lib/index.js")).href,
    } }] }]), { mode: 0o600 });
    patches.push(patch);
  }
  // Only the owned, patched engine has a refresh port. An external engine's
  // absence of support is permanent, not a failed refresh to retry on send.
  const skillRefresh = new SkillCatalogRefresh(patches.length ? async () => {
    if (!capabilityLink) throw new Error("The engine Skill catalog refresh bridge is not ready");
    await capabilityLink.invalidateSkills();
  } : null);
  const profileSkills = new DshProfileSkillsHandler(persistentSkillsRoot, () => skillRefresh.changed());
  const supervisor = new DshSupervisor({
    ownerRequired: !!options.ownerHandoff,
    executable: options.dshExecutable,
    repository: options.dshRepository,
    runtimeDirectory: options.runtimeDirectory,
    dataDirectory: options.dataDirectory,
    onUnexpectedExit: error => onEngineExit?.(error),
    patches,
    onCapabilityBridge: url => { bridgeUrl = url; capabilityLink?.attach(url); },
  });
  cleanup.push(() => supervisor.stop());
  const dshUrl = options.dshUrl ?? await supervisor.start();
  const routing = storage.routing;
  const client = new DshRoutedClient(dshUrl, routing, options.ownerHandoff ? bridgeToken : undefined);
  const socketClients = new Map<WebSocket, Map<string, LogicalClient>>();
  const catalogChanges = new ThreadCatalogPublisher((method, params) => {
    for (const [socket, clients] of socketClients) for (const state of clients.values()) {
      if (state.initialized) sendClient(socket, state.clientId, { jsonrpc: "2.0", method, params });
    }
  });
  cleanup.push(() => catalogChanges.clear());
  const lifecycle = new ThreadLifecycle(storage.threads,
    async id => {
      if (!capabilityLink) return { released: false };
      const result = await capabilityLink.thread("release", { sessionId: routing.native(id) });
      if (result.released && lifecycle.catalog.get(id)?.ephemeral) client.forgetVolatile(id);
      return result;
    }, (method, params) => {
      catalogChanges.observeNotification(method, params);
      for (const [socket, clients] of socketClients) for (const state of clients.values()) {
        const id = params.threadId ?? params.thread?.id;
        const global = ["thread/name/updated", "thread/archived", "thread/unarchived", "thread/closed"].includes(method);
        if (global || !id || lifecycle.attachments.has(state.key, id)) sendClient(socket, state.clientId, { jsonrpc: "2.0", method, params });
      }
    });
  drainThreads = () => lifecycle.close();
  let modelConfiguration: import('./model-config/dsh-adapter.js').DshModelConfigurationBridge | undefined;
  if(options.modelStorageDirectory){
    const {ModelConfigurationRepository,ModelCredentialRepository}=await import('./model-config/repository.js');
    const {ModelConfigurationService}=await import('./model-config/service.js');
    const {DshModelEngineAdapter,DshModelConfigurationBridge}=await import('./model-config/dsh-adapter.js');
    const {migrateDshModels}=await import('./model-config/migrate-dsh.js');
    const repository=new ModelConfigurationRepository(options.modelStorageDirectory),credentials=new ModelCredentialRepository(options.modelStorageDirectory);
    if(options.dataDirectory)await migrateDshModels(repository,credentials,options.dataDirectory,await client.call('settings.describe'));
    modelConfiguration=new DshModelConfigurationBridge(client,new ModelConfigurationService(repository,credentials,new DshModelEngineAdapter(client)));
    await modelConfiguration.initialize();
  }
  const authority = storage.executions;
  const adapter = new DshAppServerAdapter(client,modelConfiguration,authority,patches.length > 0, patches.length ? {
    read: async threadId => {
      if (!capabilityLink) throw new Error("DSH permission service is not ready");
      return capabilityLink.permissions(threadId);
    },
    set: async (threadId, preset) => {
      if (!capabilityLink) throw new Error("DSH permission service is not ready");
      return capabilityLink.permissions(threadId, preset);
    },
  } : undefined, options.speechModelManagement === true);
  const projectlessWorkspaceRoot = (
    options.projectlessWorkspaceDirectory
    ?? process.env.OPENCRAFT_PROJECTLESS_WORKSPACE_DIRECTORY
  )?.trim() || undefined;
  adapter.setWorkspaceResolver(new LocalWorkspaceResolver({
    projectlessRoot: projectlessWorkspaceRoot,
  }));
  cleanup.push(() => adapter.close());
  cleanup.push(adapter.subscribe((method, params) => {
    const value = params as { threadId?: string };
    // Creation belongs to the committed lifecycle transaction, including ephemeral policy.
    if (method !== "thread/started" && value.threadId && lifecycle.catalog.get(value.threadId)?.ephemeral === false)
      catalogChanges.observeNotification(method, params);
  }));
  const capabilities = new DshCapabilityBroker(undefined, options.sessionCapabilities);
  cleanup.push(() => capabilities.close());
  cleanup.push(() => capabilityLink?.close());
  if (patches.length) {
    capabilityLink = new DshCapabilityLink(bridgeToken, capabilities, authority, routing, () => {
      for (const [socket, clients] of socketClients) for (const state of clients.values()) {
        sendClient(socket, state.clientId, { jsonrpc: "2.0", method: "skills/changed", params: {} });
      }
    });
    if (bridgeUrl) capabilityLink.attach(bridgeUrl);
    for (const pending of routing.pending()) routing.reconcile(pending.logicalId, await capabilityLink.resolveGeneration(pending.logicalId));
  }
  if (capabilityLink) adapter.setBackgroundProofReader((threadId, messageId) => capabilityLink!.backgroundProof(threadId, messageId));
  if (capabilityLink) adapter.setModelInfoReader((provider, model) => capabilityLink!.modelInfo(provider, model));
  if (capabilityLink) adapter.setSkillInvocationValidator((threadId, skills) => capabilityLink!.validateSkillInvocations(threadId, skills));
  if (capabilityLink && options.dataDirectory) {
    const nativeHome = resolve(options.dataDirectory);
    const locations = new Map<string, { generation: number; path: string | null }>();
    adapter.setTranscriptCache(nativeHome, async threadId => {
      const generation = capabilityLink!.sourceGeneration, routes = routing.generations(threadId);
      const key = JSON.stringify(["dsh", generation, routes]);
      const paths: string[] = [];
      for (const route of routes) {
        let binding = locations.get(route.nativeId);
        if (!binding || binding.generation !== generation) {
          const source = await capabilityLink!.thread("historySource", { sessionId: route.nativeId });
          if (source.sessionId !== route.nativeId || generation !== capabilityLink!.sourceGeneration) throw new Error("DSH history source generation changed");
          const path = source.location?.path;
          if (path != null && typeof path !== "string") throw new Error("Invalid DSH history source location");
          binding = { generation, path: path ?? null }; locations.set(route.nativeId, binding);
        }
        // Non-file/volatile backends retain their native read-only projection.
        if (binding.path === null) return null;
        await access(binding.path);
        paths.push(binding.path);
      }
      const source = await observeNativeTranscriptFiles(nativeHome, paths, key);
      return { ...source, async validate() {
        if (generation !== capabilityLink!.sourceGeneration || JSON.stringify(["dsh", generation, routing.generations(threadId)]) !== key)
          throw new Error("DSH history source generation changed");
        for (const path of paths) await access(path);
        await source.validate();
      } };
    });
  }
  if (capabilityLink) adapter.setThreadEngine({
    goal: params => capabilityLink!.thread("goal", { ...params, sessionId: routing.native(String(params.sessionId)) }),
    describe: async params => {
      const generation = routing.current(String(params.sessionId));
      const description = await capabilityLink!.thread("describe", { ...params, sessionId: generation.nativeId });
      return { ...description, historyHead: routing.resolveHistoryHead(generation, description.historyHead) };
    },
    create: async params => {
      const { dynamicTools, ...creation } = params;
      const sessionId = randomUUID();
      let created;
      try { created = await capabilityLink!.thread("create", {
        ...creation,
        sessionId,
        ...(dynamicTools === undefined ? {} : { capabilities: normalizeCapabilities(dynamicTools) }),
      }); } catch (error) {
        await capabilityLink!.thread("release", { sessionId }).catch(() => undefined);
        throw error;
      }
      if (created.ephemeral) client.markVolatile(created.sessionId);
      return created;
    },
    resume: async params => {
      const id = String(params.sessionId);
      const configuration = lifecycle.catalog.configuration(id);
      const { developerInstructions: legacyDeveloperInstructions, baseInstructions: legacyBaseInstructions, ...runtimeConfiguration } = configuration;
      const agentPreset = lifecycle.catalog.get(id)?.extra?.dsh?.agentPreset;
      const selection = decodeModel(configuration.model);
      const resumed = await capabilityLink!.thread("resume", { ...runtimeConfiguration, ...params, ...selection, agentPreset,
        legacyInstructions: { baseInstructions: legacyBaseInstructions, developerInstructions: legacyDeveloperInstructions },
        sessionId: routing.native(id) });
      // The native Web API's picker is process-local for a never-run session.
      // Restore its product-owned binding before resume/fork reads that picker.
      if (selection) {
        const models = await client.call<{ current?: { provider: string; model: string } }>("session.models", { sessionId: id });
        if (models.current?.provider !== selection.provider || models.current?.model !== selection.model)
          await client.call("session.selectModel", { sessionId: id, ...selection });
      }
      if (capabilities.list(id).length) await capabilityLink!.register(id);
      return resumed;
    },
    fork: async params => {
      const source = String(params.sourceSessionId);
      const coordinates = routing.forkCoordinates(source, params.lastTurn as number | undefined, params.beforeTurn as number | undefined);
      const { dynamicTools, ...forkParams } = params;
      const sessionId = randomUUID();
      let created;
      try { created = await capabilityLink!.thread("fork", { ...forkParams, sessionId,
        ...(dynamicTools === undefined ? {} : { capabilities: normalizeCapabilities(dynamicTools) }),
        sourceSessionId: coordinates.nativeId, lastTurn: coordinates.lastTurn, beforeTurn: coordinates.beforeTurn });
      } catch (error) {
        await capabilityLink!.thread("release", { sessionId }).catch(() => undefined);
        throw error;
      }
      if (created.ephemeral) client.markVolatile(created.sessionId);
      return created;
    },
    inject: params => capabilityLink!.thread("inject", { ...params, sessionId: routing.native(String(params.sessionId)) }),
    release: params => capabilityLink!.thread("release", { ...params, sessionId: routing.native(String(params.sessionId)) }),
  });
  const prepareThreadExecution = async (threadId: string, inputId?: string) => {
    await adapter.activateThread(threadId);
    await skillRefresh.ensureFresh();
    const current = authority.table.get(threadId);
    // Goal edits do not replace the running submission's employee. New inputs
    // still take precedence; source-less idle continuations get no authority.
    await prepareDshExecutionCapabilities(threadId, inputId, options.sessionCapabilities, capabilities, capabilityLink,
      current?.state === "running" ? current.turnId : undefined);
  };
  const hostInputOwner: DshExecutionOwner = { connectionId: "opencraft-host-input", identity: { id: "opencraft-host-input", username: "Host input" } };
  capabilities.allowHostExecution(hostInputOwner);
  const rawInputs = dshHostInputs(adapter, authority, lifecycle, prepareThreadExecution, hostInputOwner);
  const inputs: typeof rawInputs = options.ownerHandoff ? {
    receipt: (threadId,inputId) => options.ownerHandoff!.run(() => rawInputs.receipt(threadId,inputId),true),
    submit: (threadId,inputId,text,canAdmit) => options.ownerHandoff!.run(() => rawInputs.submit(threadId,inputId,text,
      async () => options.ownerHandoff!.open() && await canAdmit())),
  } : rawInputs;
  const scheduleDirectory = options.dataDirectory ?? await mkdtemp(join(tmpdir(), "opencraft-schedules-"));
  if (!options.dataDirectory) cleanup.push(() => rm(scheduleDirectory, { recursive: true, force: true }));
  const schedules = new ConversationSchedules(scheduleDirectory,
    dshScheduleExecutionPort(adapter, authority, lifecycle, prepareThreadExecution), Date.now, event => console.warn("[opencraft local host]", event.event), () => {
      for (const [socket, clients] of socketClients) for (const state of clients.values())
        sendClient(socket, state.clientId, { jsonrpc: "2.0", method: "opencraft/schedules/changed", params: {} });
    }, () => options.ownerHandoff?.open() ?? true);
  const recoveryOwner: DshExecutionOwner = { connectionId: "opencraft-recovery", identity: { id: "opencraft-recovery", username: "System recovery" } };
  capabilities.allowHostExecution(recoveryOwner);
  const interrupted = dshInterruptedTurns(scheduleDirectory, adapter, authority, lifecycle, prepareThreadExecution, recoveryOwner, () => options.ownerHandoff?.open() ?? true);
  cleanup.push(() => interrupted.close());
  cleanup.push(() => schedules.close());
  const storageSummaries = [...storage.summaries, { name: "interrupted-turn-recovery", status: interrupted.recovery.outcome.status,
    appliedVersion: interrupted.recovery.outcome.appliedVersion, movedAside: interrupted.recovery.outcome.movedAsidePaths.length > 0 }, { name: "conversation-schedules", status: schedules.outcome.status,
    appliedVersion: schedules.outcome.appliedVersion, movedAside: schedules.outcome.movedAsidePaths.length > 0 }];
  // Stop scheduling before draining native runtimes during Host shutdown.
  const drainLifecycle = drainThreads;
  drainThreads = async () => { await interrupted.close(); await schedules.close(); await drainLifecycle?.(); };
  const restartBudget = new DshRestartBudget();
  restartBudget.ready();
  let restartOperation: Promise<void> | null = null;
  const restartEngine = (automatic = false, recoveringOwner = false): Promise<void> => {
    if (options.ownerHandoff && !recoveringOwner) return Promise.reject(new Error("Protocol-owned DSH requires fenced process handoff"));
    if (closing) return Promise.reject(new Error("Local host is closing"));
    if (options.dshUrl || process.env.OPENCRAFT_DSH_URL?.trim()) return Promise.reject(new Error("Externally managed DSH must be restarted by its owner"));
    if (restartOperation) return restartOperation;
    if (automatic) restartBudget.begin(); else restartBudget.reset();
    engineStatus = "restarting";
    for (const id of lifecycle.catalog.temporaryIds()) client.forgetVolatile(id);
    lifecycle.expireTemporaryThreads();
    adapter.engineUnavailable(new Error("DSH runtime stopped"));
    restartOperation = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (automatic && !restartBudget.take()) throw new Error("DSH automatic restart budget exhausted");
          await supervisor.stop();
          if (closing) throw new Error("Local host is closing");
          client.baseUrl = await supervisor.start();
          if (closing) { await supervisor.stop(); throw new Error("Local host is closing"); }
          await client.call("host.describe");
          if (options.ownerHandoff) {
            await capabilityLink!.nativeOwner("seal-bootstrap");
            await capabilityLink!.nativeOwner("resume");
          }
          if (modelConfiguration) {
            await modelConfiguration.initialize();
            await modelConfiguration.config.synchronize(true);
          }
          if (capabilityLink) {
            const catalog = await client.call<{items: Array<{sessionId:string;cwd?:string}>}>("session.list");
            for (const session of catalog.items) {
              let current = routing.current(session.sessionId);
              const resolved = await capabilityLink.resolveGeneration(session.sessionId);
              if (routing.reconcile(session.sessionId, resolved)) current = routing.current(session.sessionId);
              if (resolved.sessionId !== current.nativeId) throw new Error("Checkpoint and logical routing disagree; recovery requires reconciliation");
              const models = await client.call<{current?:{provider:string;model:string}}>("session.models", { sessionId: session.sessionId });
              if (!models.current) continue;
              const history = await client.call<{events:Array<{event:{seq:number;data?:{turn?:number}}}>}>("session.history", { sessionId: session.sessionId, maxMessages: Number.MAX_SAFE_INTEGER });
              // A first interrupted request may not yet have a terminal checkpoint.
              // Capture the already-persisted native log before surface recovery.
              await capabilityLink.checkpoint(current.nativeId);
              routing.stage(session.sessionId, session.sessionId + ".g" + (current.generation + 1), {
                expectedNativeId: current.nativeId, generation: current.generation + 1,
                previousLastSeq: Math.max(-1, ...history.events.map(entry => entry.event.seq)),
                previousLastTurn: Math.max(0, ...history.events.map(entry => entry.event.data?.turn ?? 0)),
              });
              const next = await capabilityLink.createGeneration({
                logicalSessionId: session.sessionId, sourceSessionId: current.nativeId,
                cwd: session.cwd ?? homedir(), provider: models.current.provider, model: models.current.model,
                legacyInstructions: lifecycle.catalog.configuration(session.sessionId),
              });
              routing.publish(current.nativeId, { logicalId: session.sessionId, nativeId: next.sessionId, generation: next.generation,
                seedThroughSeq: next.seedThroughSeq, seedThroughTurn: next.seedThroughTurn,
                previousLastSeq: Math.max(-1, ...history.events.map(entry => entry.event.seq)),
                previousLastTurn: Math.max(0, ...history.events.map(entry => entry.event.data?.turn ?? 0)),
              });
            }
          }
          await adapter.reconnectStreams();
          if (capabilityLink) for (const threadId of capabilities.threads()) {
            // Register only already-loaded generations. Idle display bindings stay
            // cold; their declarations will mount at the next execution activation.
            await capabilityLink.register(threadId);
          }
          engineStatus = "ready";
          restartBudget.ready();
          adapter.engineRecovered();
          return;
        } catch (error) {
          if (closing || attempt === 2) {
            // Recovery may fail after native admission was resumed. Do not leave
            // that writer running when the owner records recovery-required.
            if (recoveringOwner) await supervisor.stop();
            engineStatus = "failed"; throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
    })().finally(() => { restartOperation = null; });
    return restartOperation;
  };
  onEngineExit = error => {
    if (closing) return;
    adapter.engineUnavailable(error);
    if (options.ownerHandoff) {
      engineStatus = "restarting";
      void options.ownerHandoff.recoverNative(() => restartEngine(true, true))
        .catch(() => { engineStatus = "failed"; });
      return;
    }
    void restartEngine(true).catch(() => { engineStatus = "failed"; });
  };
  const processes = new HostProcessService();
  cleanup.push(() => processes.close());
  const hostDocuments = new HostDocumentService(options.dataDirectory ? join(options.dataDirectory, "opencraft-host-documents.sqlite") : null, storage.documents);
  cleanup.push(() => hostDocuments.close());
  const tasks = new TasksService(options.dataDirectory ? join(options.dataDirectory, "tasks.sqlite") : null, () => {
    for (const client of websocketServer.clients) send(client, { jsonrpc: "2.0", method: "opencraft/tasks/changed", params: {} });
  }, storage.tasks);
  cleanup.push(() => tasks.close());
  const projects = new ProjectRepository(options.projectStorageDirectory ?? options.modelStorageDirectory ?? options.dataDirectory);
  const token = options.token ?? randomBytes(24).toString("base64url");
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (url.pathname === "/host-inputs") {
      void handleHostInput(request, response, token, options.ownerHandoff ? rawInputs : inputs, options.authorizeHostInput, options.ownerHandoff); return;
    }
    if (url.pathname === "/health") {
      response.statusCode = engineStatus === "ready" ? 200 : 503;
      response.end(`${JSON.stringify({ ok: engineStatus === "ready", engine: "dsh", pid: process.pid, enginePid: supervisor.processId, status: engineStatus, hostInputs: 1, storage: storageSummaries })}\n`);
      return;
    }
    response.statusCode = 404;
    response.end(`${JSON.stringify({ ok: false, error: "Not found" })}\n`);
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  stopAccepting = async () => {
    closing = true;
    for (const client of websocketServer.clients) client.close(1001, "OpenCraft is quitting");
    websocketServer.close();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  };
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/rpc" || url.searchParams.get("token") !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => websocketServer.emit("connection", client, request));
  });
  websocketServer.on("connection", (socket) => {
    const httpRequests = new Map<string, AbortController>();
    const physicalId = randomUUID(), clients = new Map<string, LogicalClient>();
    socketClients.set(socket, clients);
    const logicalClient = (clientId: string) => {
      let state = clients.get(clientId);
      if (!state) {
        const key = physicalId + ":" + clientId + ":" + randomUUID();
        state = { key, clientId, owner: { connectionId: key, identity: { id: "local-user", username: "local" } }, offered: new Set(), openedThreads: new Set() };
        clients.set(clientId, state);
      }
      return state;
    };
    const disconnectClient = async (state: LogicalClient) => {
      if (clients.get(state.clientId) === state) clients.delete(state.clientId);
      const ownedThreads = capabilities.threads(state.owner);
      lifecycle.revokeClient(state.key);
      capabilities.disconnect(state.owner); authority.disconnect(state.owner);
      state.unsubscribeInteractions?.(); state.offered.clear(); state.openedThreads.clear();
      await Promise.allSettled(ownedThreads.map(threadId => lifecycle.enqueue(threadId, async () => {
        // A successor may already have established its own capability lease.
        if (capabilities.list(threadId).length === 0) await capabilityLink?.unregister(threadId);
      })));
      await lifecycle.disconnect(state.key);
    };
    const unsubscribe = adapter.subscribe((method, params) => {
      const value = params as { threadId?: string; thread?: { id: string }; requestId?: unknown };
      const id = value?.threadId ?? value?.thread?.id;
      if (id) lifecycle.touch(id);
      for (const state of clients.values()) {
        if (method === "serverRequest/resolved") state.offered.delete(String(value.requestId));
        if (!id || lifecycle.receivesNotifications(state.key, id)) sendClient(socket, state.clientId, { jsonrpc: "2.0", method, params });
      }
    });
    const publishShared = (threadId: string, state: LogicalClient) => {
      if (!state.sharedInteractions || !state.initialized || !(state.openedThreads.has(threadId) || lifecycle.receivesNotifications(state.key, threadId))) return;
      sendClient(socket, state.clientId, { jsonrpc: "2.0", method: SHARED_INTERACTIONS_CHANGED,
        params: adapter.interactions.shared.snapshot(threadId, true) });
    };
    const unsubscribeShared = adapter.interactions.shared.subscribe(threadId => {
      for (const state of clients.values()) publishShared(threadId, state);
    });
    const unsubscribeProcesses = processes.subscribe((method, params) => send(socket, { jsonrpc: "2.0", method, params }));
    const connectorChanged = (id: string) => { for (const state of clients.values()) sendClient(socket, state.clientId, { jsonrpc: "2.0", method: "connectors/managed/changed", params: { id } }); };
    connectorListeners.add(connectorChanged);
    const unsubscribeDocuments = hostDocuments.subscribe(params => {
      for (const state of clients.values()) sendClient(socket, state.clientId, { jsonrpc: "2.0", method: HOST_STORAGE.changed, params });
    });
    socket.on("message", async (data, isBinary) => {
      if (isBinary) { socket.close(1003, "Text frames only"); return; }
      let request: JsonRpcMessage;
      try { request = JSON.parse(data.toString("utf8")) as JsonRpcMessage; }
      catch { send(socket, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); return; }
      const clientId = typeof request?.[LOGICAL_CLIENT_FIELD] === "string" ? request[LOGICAL_CLIENT_FIELD] as string : "";
      if (clientId.length > 4096) { socket.close(1008, "Invalid logical client"); return; }
      const state = logicalClient(clientId), { owner, offered, openedThreads } = state;
      if (request.method === "opencraft/owner/receipt" && options.ownerHandoff) {
        try { options.ownerHandoff.acknowledgeReceipt(request.params); } catch { socket.close(1008,"DSH receipt rejected"); }
        return;
      }
      const dispatchRequest = async () => {
      if (request.method === "runtime/client/disconnect" && !("id" in request)) { await disconnectClient(state); return; }
      if (request && typeof request === "object" && typeof request.id === "string" && !("method" in request) && ("result" in request || "error" in request)) {
        if (capabilities.respond(owner, request.id, request.result, request.error)) return;
        if (!offered.has(request.id)) return;
        try { await adapter.interactions.respond(request.id, request); }
        catch (error) {
          console.error("[opencraft local host] interaction response failed", error);
          socket.close(1011, "Interaction response failed; reconnect to recover pending requests");
        }
        return;
      }
      if (request && typeof request === "object" && "id" in request && (request.method === SHARED_INTERACTIONS_READ || request.method === SHARED_INTERACTIONS_RESPOND)) {
        const p = (request.params ?? {}) as Record<string, unknown>, threadId = typeof p.threadId === "string" ? p.threadId : "";
        if (!state.initialized || !(openedThreads.has(threadId) || lifecycle.receivesNotifications(state.key, threadId))) {
          send(socket, { id: request.id, error: { code: 403, message: "Conversation subscription required" } }); return;
        }
        try {
          if (request.method === SHARED_INTERACTIONS_READ) { send(socket, { id: request.id, result: adapter.interactions.shared.snapshot(threadId, true) }); return; }
          if (typeof p.interactionId !== "string" || !p.interactionId || typeof p.submissionId !== "string" || !p.submissionId
            || typeof p.result !== "object" || p.result === null || Array.isArray(p.result)) throw new Error("Invalid interaction response");
          const disposition = await adapter.interactions.respondShared(threadId, p.interactionId, p.submissionId, p.result);
          if (clients.get(clientId) === state) send(socket, { id: request.id, result: { disposition, snapshot: adapter.interactions.shared.snapshot(threadId, true) } });
        } catch (error) { if (clients.get(clientId) === state) send(socket, { id: request.id, error: rpcError(error) }); }
        return;
      }
      // JSON-RPC notifications (including initialized) have no response.
      if (request && typeof request === "object" && !("id" in request) && typeof request.method === "string") return;
      if (!request || typeof request !== "object" || (typeof request.id !== "string" && typeof request.id !== "number") || typeof request.method !== "string") {
        send(socket, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
        return;
      }
      try {
        if (request.method === "opencraft/turn-recovery/read") {
          send(socket, { jsonrpc: "2.0", id: request.id, result: { recovery: interrupted.recovery.notice(String((request.params as any)?.threadId ?? "")) } }); return;
        }
        if (["turn/start", "turn/steer", "turn/interrupt", "thread/archive", "thread/delete", "thread/goal/set", "thread/goal/clear", "thread/queue/add", "thread/queue/start"].includes(request.method)) interrupted.recovery.handled(String((request.params as any)?.threadId ?? ""));
        if (request.method.startsWith("opencraft/schedules/")) {
          const result = request.method === "opencraft/schedules/list" ? schedules.list()
            : await schedules.handle(request.method, request.params, owner.identity.id);
          send(socket, { jsonrpc: "2.0", id: request.id, result }); return;
        }
        if (request.method.startsWith("opencraft/tasks/")) {
          const result = tasks.handle(request.method, request.params);
          send(socket, { jsonrpc: "2.0", id: request.id, result }); return;
        }
        if (request.method === "runtime/machine/read" && options.machineIdentity) {
          send(socket, { jsonrpc: "2.0", id: request.id, result: { machine: options.machineIdentity, agent: "OpenCraft" } }); return;
        }
        if (request.method.startsWith("storage/documents/")) {
          const result = hostDocuments.handle(request.method, request.params);
          send(socket, { jsonrpc: "2.0", id: request.id, result }); return;
        }
        if (request.method.startsWith("connectors/managed/")) {
          const result = await connectors().handle(request.method, request.params);
          send(socket, { jsonrpc: "2.0", id: request.id, result }); return;
        }
        if (request.method.startsWith("attachment/")) {
          const result = await attachmentStaging.handle(request.method, request.params);
          send(socket, { jsonrpc: "2.0", id: request.id, result }); return;
        }
        const targetThread = (request.params as { threadId?: string } | null)?.threadId;
        if (request.method.startsWith("turn/") && typeof targetThread === "string") lifecycle.assertOpen(targetThread);
        const prepareExecution = async () => {
          const parameters = request.params as { clientUserMessageId?: unknown; queuedSubmissionId?: string } | undefined;
          const queued = request.method === "thread/queue/start" && typeof targetThread === "string"
            ? parameters?.queuedSubmissionId ? authority.queueStore.find(targetThread, parameters.queuedSubmissionId) : authority.queueStore.pending(targetThread)[0] : null;
          if (["turn/start", "thread/queue/start", "thread/goal/set"].includes(request.method as string) && typeof targetThread === "string") await prepareThreadExecution(targetThread, queued?.clientUserMessageId ?? (typeof parameters?.clientUserMessageId === "string" ? parameters.clientUserMessageId : undefined));
        };
        if (request.method === "runtime/http/cancel") {
          const id = (request.params as { requestId: string }).requestId;
          const active = httpRequests.get(id);
          active?.abort();
          send(socket, { jsonrpc: "2.0", id: request.id, result: { cancelled: !!active } }); return;
        }
        if (request.method === "runtime/http/request") {
          const params = request.params as Parameters<typeof requestLoopback>[0] & { requestId: string };
          if (typeof params?.requestId !== "string" || httpRequests.has(params.requestId)) throw new Error("Invalid or duplicate HTTP request identity");
          const abort = new AbortController(); httpRequests.set(params.requestId, abort);
          try {
            const address = server.address();
            const ports = [Number(new URL(client.baseUrl).port), ...(bridgeUrl ? [Number(new URL(bridgeUrl).port)] : []),
              ...(address && typeof address !== "string" ? [address.port] : [])];
            const result = await requestLoopback(params, abort.signal, ports);
            send(socket, { jsonrpc: "2.0", id: request.id, result });
          } finally { httpRequests.delete(params.requestId); }
          return;
        }
        if (request.method === "runtime/capabilities/register") {
          const params = request.params as { threadId: string; dynamicTools: unknown };
          await lifecycle.enqueue(params.threadId, async () => {
          lifecycle.assertClient(state.key);
          if (!openedThreads.has(params?.threadId)) throw new Error("Open the thread before registering its capabilities");
          if (!capabilityLink) throw new Error("This host cannot register engine capabilities");
          const sameOwner = capabilities.threads(owner).includes(params.threadId);
          const unchanged = sameOwner && capabilities.matches(params.threadId, owner, params.dynamicTools);
          if (authority.table.get(params.threadId) && !unchanged) throw new Error("Cannot replace capabilities of an active execution");
          if (unchanged) {
            const expected = capabilities.list(params.threadId).length;
            const engineRegistration = await capabilityLink.register(params.threadId);
            verifyDshCapabilityRegistration(expected, engineRegistration, { allowDeferred: true });
            send(socket, { jsonrpc: "2.0", id: request.id, result: engineRegistration });
            return;
          }
          await capabilityLink.validate(normalizeCapabilities(params.dynamicTools));
          lifecycle.assertClient(state.key);
          const registered = capabilities.register(params.threadId, owner, params.dynamicTools, frame => sendClient(socket, clientId, { jsonrpc: "2.0", ...frame }));
          await capabilityLink.unregister(params.threadId);
          const engineRegistration = await capabilityLink.register(params.threadId);
          verifyDshCapabilityRegistration(registered.length, engineRegistration, { allowDeferred: true });
          send(socket, { jsonrpc: "2.0", id: request.id, result: engineRegistration });
          });
          return;
        }
        const readSkills = async () => {
          if (!capabilityLink) throw new Error("This DSH host does not expose complete Skill metadata");
          await skillRefresh.ensureFresh();
          const threadId = [...openedThreads].at(-1);
          const cwd = threadId
            ? (await adapter.dispatch("thread/read", { threadId, includeTurns: false }) as { thread: { cwd: string } }).thread.cwd
            : (await client.call<{cwd:string}>("host.describe")).cwd;
          const params = request.params as { cwds?: string[]; forceReload?: boolean } | undefined;
          const cwds = params?.cwds?.length ? params.cwds : [cwd];
          return { data: await Promise.all(cwds.map(cwd => capabilityLink!.skills(threadId, cwd, params?.forceReload === true))) };
        };
        // Validate and snapshot before creating a native child/catalog entry. A malformed
        // declaration must not leave a successfully created but unacknowledged thread.
        const bindsCapabilities = ["thread/start", "thread/resume", "thread/fork"].includes(request.method);
        const toolSpecs = bindsCapabilities ? structuredClone(
          (request.params as { dynamicTools?: unknown } | undefined)?.dynamicTools
          ?? (request.method === "thread/fork" ? capabilities.specs(String((request.params as { threadId: string }).threadId), owner) : undefined),
        ) : undefined;
        if (toolSpecs !== undefined) {
          const normalized = normalizeCapabilities(toolSpecs);
          if (capabilityLink) await capabilityLink.validate(normalized);
        }
        const dispatchThread = async (method: string, params: Record<string, unknown>) => {
          lifecycle.assertClient(state.key);
          await prepareExecution();
          lifecycle.assertClient(state.key);
          const reply = await adapter.dispatchOwned(method,
            toolSpecs === undefined ? params : { ...params, dynamicTools: toolSpecs }, owner, request.id as string | number);
          const id = (reply as { thread?: { id?: string } } | null)?.thread?.id;
          try {
          lifecycle.assertClient(state.key);
          if (bindsCapabilities && id && toolSpecs !== undefined) {
            const registered = capabilities.register(id, owner, toolSpecs, frame => sendClient(socket, clientId, { jsonrpc: "2.0", ...frame }));
            if (capabilityLink) {
              if (method === "thread/resume") await capabilityLink.unregister(id);
              lifecycle.assertClient(state.key);
              const mounted = await capabilityLink.register(id);
              lifecycle.assertClient(state.key);
              verifyDshCapabilityRegistration(registered.length, mounted, { allowDeferred: method === "thread/resume" });
            }
          }
          return reply;
          } catch (error) {
            if (id && (method === "thread/start" || method === "thread/fork")) {
              capabilities.release(id, owner);
              // Reclaim only this newly-created idle runtime. Durable history
              // is never deleted as compensation for a failed attachment.
              await capabilityLink?.thread("release", { sessionId: routing.native(id) }).catch(() => undefined);
            }
            throw error;
          }
        };
        let result = request.method === "project/list"
          ? await projects.list(request.params as import("@opencraft/appserver-protocol/generated/v2").ProjectListParams)
          : request.method === "project/create"
          ? await projects.create(request.params as import("@opencraft/appserver-protocol/generated/v2").ProjectCreateParams)
          : request.method === "skills/list"
          ? await readSkills()
          : PROFILE_SKILLS_METHODS.has(request.method as ProfileSkillsMethod)
          ? await profileSkills.handle(request.method as ProfileSkillsMethod, request.params)
          : request.method.startsWith("process/")
          ? processes.dispatch(request.method, request.params)
          : request.method.startsWith("fs/")
          ? await fileRequest(request.method, request.params)
          : request.method.startsWith("thread/") || request.method === "turn/start"
          ? await lifecycle.dispatch(request.method, (request.params ?? {}) as Record<string, unknown>, state.key,
            dispatchThread)
          : await adapter.dispatchOwned(request.method, request.params, owner, request.id as string | number);
        if (request.method === "thread/delete" || request.method === "thread/list") catalogChanges.observeResult(request.method, request.params, result);
        if (request.method === "initialize") {
          state.initialized = true;
          state.sharedInteractions = !!(request.params as { capabilities?: { extensions?: Record<string, unknown> } } | undefined)?.capabilities?.extensions?.[SHARED_INTERACTIONS_EXTENSION];
          const initialized = result as import("@opencraft/appserver-protocol").AppServerInitializeResponse;
          result = {
            ...initialized,
            capabilities: {
              ...initialized.capabilities,
              extensions: {
                ...initialized.capabilities?.extensions,
                [SHARED_INTERACTIONS_EXTENSION]: { version: 1 },
                [OPENCRAFT_ATTACHMENT_STAGING_EXTENSION]: attachmentStaging.capability,
                [CONVERSATION_SCHEDULES_EXTENSION]: { version: 1, target: "existing-thread", repeat: "fixed-interval", summary: true, calendar: true },
                [TURN_RECOVERY_EXTENSION]: { version: 1 },
              },
            },
          };
        }
        if (request.method === "thread/archive" && typeof targetThread === "string") {
          schedules.suspend(targetThread); await adapter.invalidateTranscriptCache(targetThread);
        }
        if (request.method === "thread/delete" && typeof targetThread === "string") await adapter.invalidateTranscriptCache(targetThread);
        const capabilityThreadId = (result as { thread?: { id?: string } } | null)?.thread?.id
          ?? (request.params as { threadId?: string } | undefined)?.threadId;
        if (typeof capabilityThreadId === "string" && ["thread/start", "thread/resume", "thread/fork", "thread/read", "turn/start"].includes(request.method)) publishShared(capabilityThreadId, state);
        if (request.method === "turn/start" && typeof capabilityThreadId === "string") lifecycle.acceptedTurn(capabilityThreadId, request.params as Record<string, unknown>);
        send(socket, { jsonrpc: "2.0", id: request.id, result }, request.method);
        // Initialization (including preflight) must not claim another client's
        // user interactions. Only a connection opening a thread may answer it.
        if (["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(request.method) && socket.readyState === WebSocket.OPEN) {
          const reply = result as { thread?: { id?: string } } | null;
          const params = request.params as { threadId?: string } | undefined;
          const threadId = reply?.thread?.id ?? params?.threadId;
          if (typeof threadId === "string") openedThreads.add(threadId);
          state.unsubscribeInteractions?.();
          state.unsubscribeInteractions = adapter.interactions.subscribe(interaction => {
            if (state.sharedInteractions || !openedThreads.has(interaction.params.threadId) || offered.has(interaction.id)) return;
            offered.add(interaction.id);
            sendClient(socket, clientId, { jsonrpc: "2.0", ...interaction });
          });
        }
      } catch (error) {
        send(socket, { jsonrpc: "2.0", id: request.id, error: rpcError(error) });
      }
      };
      try {
        await replyClient.run(clientId, () => options.ownerHandoff
          ? options.ownerHandoff.run(() => {
            if (!("id" in request) || !("method" in request)) return dispatchRequest();
            return ownerReply.run(options.ownerHandoff!.beginReceipt(request), dispatchRequest);
          }, dshHandoffReconciliation(request)) : dispatchRequest());
      } catch { sendClient(socket, clientId, {jsonrpc:"2.0",id:request.id,error:{code:-32001,message:"DSH admission fenced"}}); }
    });
    socket.once("close", () => {
      unsubscribeShared();
      for (const pending of httpRequests.values()) pending.abort();
      socketClients.delete(socket);
      for (const state of [...clients.values()]) void disconnectClient(state).catch(() => undefined);
      unsubscribe(); unsubscribeProcesses(); connectorListeners.delete(connectorChanged); unsubscribeDocuments();
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Local Agent Host did not bind a TCP port");
  if (options.dataDirectory) {
    const taskAgent = await startTasksAgent({
      admission: options.ownerHandoff,
      directory: join(options.dataDirectory, "task-agent"),
      skillRoots: options.taskSkillDirectories ?? [],
      service: tasks,
      catalog: options.taskServerId ? async (search, limit, serverId = options.taskServerId, cursor) => {
        if (serverId !== options.taskServerId) {
          if (!serverId || !options.taskConversationCatalog) throw new Error("Task conversation server is unavailable");
          return options.taskConversationCatalog(serverId, search, limit, cursor);
        }
        const result = await adapter.dispatch("thread/list", { limit, searchTerm: search || null, archived: false, cursor: cursor ?? null }) as { data: { id: string; name?: string; preview?: string }[]; nextCursor?: string | null };
        return { conversations: result.data.map(thread => ({ serverId: options.taskServerId, threadId: thread.id, title: thread.name || thread.preview || thread.id })), nextCursor: result.nextCursor ?? null };
      } : undefined,
    });
    cleanup.push(() => taskAgent.close());
    // A patched engine can announce its bridge after Host startup. Keep the
    // dirty revision so skills/list and the next send retry when it is ready.
    await skillRefresh.changed().catch(() => undefined);
  }
  client.sealBootstrap();
  if (options.ownerHandoff) await capabilityLink!.nativeOwner("seal-bootstrap");
  if (options.ownerHandoff?.open()) await capabilityLink!.nativeOwner("resume");
  schedules.start();
  interrupted.recovery.wake();
  const websocketUrl = `ws://127.0.0.1:${address.port}/rpc?token=${encodeURIComponent(token)}`;
  return {
    websocketUrl,
    inputs,
    nativeOwner: (action: "inspect" | "fence" | "resume" | "seal-release" | "abort-release") => capabilityLink!.nativeOwner(action),
    async handoffObservation(native: {id:string;turns:[string,string][];rpcInputs:[string,string][]}[] = []) {
      const schedulesState = schedules.handoffObservation(), recovery = interrupted.recovery.handoffObservation();
      const executions = authority.handoffObservation(native.flatMap(record => {
        const logical = routing.logical(record.id);return [{...record,threadId:logical ?? record.id}];
      }));
      const coverage = storageSummaries.some(row=>row.movedAside) || modelConfiguration && !await modelConfiguration.config.appliedStateCurrent() ? "unknown" : "complete";
      return {coverage,activeCount:executions.activeCount + schedulesState.flights + schedulesState.plans + schedulesState.unfinished + recovery.flights + recovery.unfinished,
        executions,schedules:schedulesState,recovery};
    },
    resumeBackground() { schedules.start(); interrupted.recovery.wake(); },
    get storageOutcomes() { return storageSummaries; },
    get dshUrl() { return client.baseUrl; },
    get engineProcessId() { return supervisor.processId; },
    get engineState() { return engineStatus; },
    restartEngine: (automatic = false) => restartEngine(automatic),
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      await restartOperation?.catch(() => undefined);
      await dispose();
    },
  };
  } catch (error) {
    try { await dispose(); } catch { /* Preserve the startup failure after releasing every resource. */ }
    throw error;
  }
}

function dshHandoffReconciliation(request: JsonRpcMessage): boolean {
  if (!("method" in request)) return true;
  return ["runtime/client/disconnect", "turn/interrupt", "thread/queue/remove", "thread/goal/clear", "thread/goal/pause", "opencraft/turn-recovery/read", "opencraft/interactions/read", "opencraft/interactions/respond"].includes(String(request.method));
}
