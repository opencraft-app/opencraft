import { AssistantThreadCommands } from '@opencraft/access-control/assistant-thread-commands';
import { ThreadAccessStore } from '@opencraft/access-control/thread-access';
import { createThreadOrchestrationExecution } from '@opencraft/access-control/thread-orchestration-execution';
import { createAssistantModelSource } from '@opencraft/local-agent-host/model-config/assistant';
import { loadAssistantEnvironments } from './assistant-environments.js';
import { createPersonalAssistantHost } from '@opencraft/personal-assistant/host';
import { Collaboration } from '@opencraft/access-control/collaboration';
import { ImChannelsAppServer } from '@opencraft/access-control/im-channels-appserver';
import { createRoutedConversationExecution } from '@opencraft/access-control/conversation-execution';
import { CHANNELS_HOST_ID } from '@opencraft/appserver-protocol';
import { join } from "node:path";
import { nodeObserver } from "@opencraft/observability-contract/node";
import { unlink } from "node:fs/promises";
import { connect } from "node:net";

import { AppHostServer } from "@opencraft/app-host-server";
import { WebSocketTransport, type AppServerWebSocket } from "@opencraft/appserver-transport-websocket";
import { acquireLocalAgentStorageOwner, openLocalAgentStorageWithWorker, startLocalAgentHost } from "@opencraft/local-agent-host";
import WebSocket from "ws";

import { readDaemonMachineIdentity } from "./machine-identity.js";
import { MachineIdentityTransport } from "./machine-transport.js";

import { CodexProviderBridge } from "./codex-provider-bridge.js";
import { codexAdmissionPaused } from "./codex-maintenance.js";
import { CodexHostServices, codexAccountsService, codexModelsService, codexPinsService, codexTasksService } from "./codex-host-services.js";
import { CodexNativeReader } from "./codex-native-reader.js";
import { CodexCoreControlClient } from "@opencraft/account-pool-host";
import type { DuplexTransport } from "@opencraft/appserver-client/transport";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import type { BridgeGatewayOptions } from "@opencraft/agent-bridge-host/gateway";
import { CodexEngineAdapter } from "./codex-engine-adapter.js";
import { startOpenCraftDaemonServer } from "./server.js";
import { createDesktopAccountHost } from '@opencraft/plugin-local-account/desktop';
import { humanLoginPage } from '@opencraft/plugin-local-account/login-page';
import { desktopAccountEndpoint, startDesktopAccountServer, type DesktopAccountServer } from './desktop-account-endpoint.js';

function isNamedPipe(endpoint: string): boolean {
  return endpoint.startsWith("\\\\.\\pipe\\");
}

async function removeStaleSocket(endpoint: string): Promise<void> {
  if (isNamedPipe(endpoint)) return;
  const active = await new Promise<boolean>((resolveActive) => {
    const socket = connect(endpoint);
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      resolveActive(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    timeout = setTimeout(() => done(false), 250);
    timeout.unref();
  });
  if (active) throw new Error(`OpenCraft Daemon is already listening at ${endpoint}`);
  await unlink(endpoint).catch(() => undefined);
}

/** How the daemon's local Codex Host reaches Core: pass-through, or with its own overlays. */
export function codexCoreOptions(options: { codexCoreEndpoint?: string; codexCoreHostOverlays?: boolean; authToken: string }) {
  if (options.codexCoreHostOverlays && !options.codexCoreEndpoint) throw new Error("Codex Host overlays require a Codex Core endpoint");
  return { coreEndpoint: options.codexCoreEndpoint, coreAuthToken: options.authToken,
    ...(options.codexCoreEndpoint && options.codexCoreHostOverlays ? { coreHostOverlays: true } : {}) };
}

export async function startOpenCraftDaemon(options: {
  readonly endpoint: string;
  readonly runtimeDirectory: string;
  readonly authToken: string;
  readonly dshExecutable: string;
  readonly dshCapabilityPlugin?: string;
  readonly dataDirectory: string;
  readonly humanAccountDirectory?: string;
  readonly modelStorageDirectory?: string;
  readonly skillsDirectory?: string;
  readonly codexExecutable: string;
  readonly codexExecutableSource?: "explicit" | "builtin" | "user-installed" | "unresolved";
  readonly codexDataDirectory: string;
  readonly nativeCodexHomeDirectory: string;
  readonly codexCoreEndpoint?: string;
  /**
   * With a Core endpoint, keep the local Host overlays (queue, tasks, schedules,
   * attachments, titles, recovery) instead of passing everything through to Core.
   * Only one overlay owner may use a Codex data directory: a deployment whose
   * gateway already runs overlays on it must leave this off.
   */
  readonly codexCoreHostOverlays?: boolean;
  readonly codexAgentBridge?: BridgeGatewayOptions;
  /** Move existing local Codex Threads to the bridge on their next turn. */
  readonly codexAgentBridgeAdoptExisting?: boolean;
  readonly codexWriterOwnership?: boolean;
  /** Trusted composition may replace only native startup while preserving the
   * daemon's identity, storage reporting and AppHost/IPC assembly. */
  readonly createCodexTransport?: (options: ConstructorParameters<typeof CodexEngineAdapter>[0]) => CodexEngineAdapter;
  /** Deployment display name; defaults to the OS computer name. */
  readonly machineName?: string;
}) {
  codexCoreOptions(options); // Reject an invalid Core composition before owning any storage.
  nodeObserver("gateway");
  const machineIdentity = await readDaemonMachineIdentity(options.dataDirectory, options.machineName);
  process.chdir(options.runtimeDirectory);
  const releaseStorageOwner = await acquireLocalAgentStorageOwner(options.dataDirectory);
  let storage: Awaited<ReturnType<typeof openLocalAgentStorageWithWorker>>;
  try {
    await removeStaleSocket(options.endpoint);
    storage = await openLocalAgentStorageWithWorker({ dataDirectory: options.dataDirectory });
  } catch (error) { await releaseStorageOwner(); throw error; }
  const storageSummary: import("@opencraft/daemon-ipc").DaemonStorageSummary[] = [...storage.summaries];
  const reportStorage = () => {
    for (const { name, outcome } of storage.outcomes) {
      if (outcome.status === "fresh" || outcome.status === "up-to-date") continue;
      console.error(`[opencraft-storage] ${JSON.stringify({ name, status: outcome.status, backupPath: outcome.backupPath, movedAsidePaths: outcome.movedAsidePaths })}`);
    }
  };
  reportStorage();
  let humanAccounts: Awaited<ReturnType<typeof createDesktopAccountHost>> | null = null;
  let accountServer: DesktopAccountServer | null = null;
  // The native Main currently attached; it opens remote windows for the account service.
  let openRemoteWindow: ((origin: string) => Promise<void>) | null = null;
  try {
    // The daemon is the desktop installation's server role: it owns, migrates and fences the
    // Server database and serves the account routes. Electron Main only forwards those routes.
    humanAccounts = options.humanAccountDirectory ? await createDesktopAccountHost(options.humanAccountDirectory, humanLoginPage, {
      storageRole: 'owner',
      openRemote: origin => openRemoteWindow ? openRemoteWindow(origin) : Promise.reject(new Error('No native window host is attached')),
    }) : null;
    if (humanAccounts) accountServer = await startDesktopAccountServer(desktopAccountEndpoint(options.endpoint), (request, response) => humanAccounts!.handle(request, response));
  } catch (error) {
    await accountServer?.close();
    try { await humanAccounts?.close(); } catch { /* keep the original failure */ }
    try { await storage.close(); } finally { await releaseStorageOwner(); }
    throw error;
  }
  let localAgent: Awaited<ReturnType<typeof startLocalAgentHost>> | null = null;
  let localAgentStarting: Promise<Awaited<ReturnType<typeof startLocalAgentHost>>> | null = null;
  const codexAgents = new Set<CodexEngineAdapter>();
  let closing: Promise<void> | null = null;
  let collaboration: Collaboration | null = null;
  let assistantThreads: AssistantThreadCommands | undefined;
  const threadAccess=humanAccounts?new ThreadAccessStore(humanAccounts.storage,humanAccounts.actors):undefined;
  let personalAssistantHost: Awaited<ReturnType<typeof createPersonalAssistantHost>> | undefined;
  const appHost = new AppHostServer({
    logicalClientRouting: true,
    physicalHostLifetime: "server",
    createTransport(hostId) {
      if(hostId===CHANNELS_HOST_ID && collaboration) return new ImChannelsAppServer(()=>collaboration);
      if (hostId !== "local" && hostId !== "local-codex") throw new Error(`OpenCraft Daemon does not own Host ${hostId}`);
      return new MachineIdentityTransport(machineIdentity, hostId === "local" ? "OpenCraft" : "Codex", async () => {
      if (hostId === "local") {
        localAgentStarting ??= startLocalAgentHost({
          storage,
          dshExecutable: options.dshExecutable,
          dshCapabilityPlugin: options.dshCapabilityPlugin,
          runtimeDirectory: options.runtimeDirectory,
          dataDirectory: options.dataDirectory,
          artifactDirectory: join(options.dataDirectory,"artifacts"),
          modelStorageDirectory: options.modelStorageDirectory,
          skillsDirectory: options.skillsDirectory,
          machineIdentity,
        }).catch(async error => {
          // Host failure closes all supplied handles. Reopen under the same daemon owner
          // before allowing another attempt or advertising ready again.
          try {
            storage = await openLocalAgentStorageWithWorker({ dataDirectory: options.dataDirectory });
            storageSummary.splice(0, storageSummary.length, ...storage.summaries, ...storageSummary.filter(row => row.hostId !== undefined));
            reportStorage();
            localAgentStarting = null;
          } catch {
            void close().catch(() => undefined);
          }
          throw error;
        });
        localAgent = await localAgentStarting;
        return new WebSocketTransport({
          url: localAgent.websocketUrl,
          createSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as AppServerWebSocket,
        });
      }
      if (hostId === "local-codex") {
        // The Host services front owns Host-wide stores exactly where the local Codex Host
        // would have (no Core, or Core with overlays); a pass-through to Core owns none.
        const ownsHostState = !options.codexCoreEndpoint || options.codexCoreHostOverlays === true;
        let hostServices: CodexHostServices | undefined;
        let adapterOutcomes: readonly { name: string; outcome: DatabaseOutcome }[] = [];
        const reportCodexStorage = () => {
          const retained = storageSummary.filter(row => row.hostId !== "local-codex");
          storageSummary.splice(0, storageSummary.length, ...retained, ...[...adapterOutcomes, ...(hostServices?.storage() ?? [])].map(({ name, outcome }) => ({
            hostId: "local-codex", name, status: outcome.status, appliedVersion: outcome.appliedVersion,
            backupPath: outcome.backupPath, movedAside: outcome.movedAsidePaths.length > 0,
          })));
        };
        const codexAgent = (options.createCodexTransport ?? (configuration => new CodexEngineAdapter(configuration)))({
          historyImageResources: process.env.OPENCRAFT_HISTORY_IMAGE_RESOURCES === "1",
          onStorageOpened: outcomes => { adapterOutcomes = outcomes; reportCodexStorage(); },
          ...(ownsHostState ? { externalTasks: true } : {}),
          executable: options.codexExecutable,
          ...(options.codexExecutableSource ? { executableSource: options.codexExecutableSource } : {}),
          runtimeDirectory: options.runtimeDirectory,
          dataDirectory: options.codexDataDirectory,
          artifactDirectory: join(options.dataDirectory,"artifacts"),
          nativeCodexHomeDirectory: options.nativeCodexHomeDirectory,
          ...codexCoreOptions(options),
          writerOwnership: options.codexWriterOwnership,
        });
        codexAgents.add(codexAgent);
        if (options.codexAgentBridge && !options.codexCoreEndpoint) throw Error("Bridge requires existing Core endpoint");
        const routing: DuplexTransport = options.codexAgentBridge ? new CodexProviderBridge(codexAgent, options.codexAgentBridge, {
          admissionPaused: () => codexAdmissionPaused(options.codexDataDirectory),
          adoptExisting: options.codexAgentBridgeAdoptExisting === true,
          ...(codexAgent instanceof CodexEngineAdapter ? {
            prepareInput: (threadId, clientId, input, context) => codexAgent.prepareExternalInput(threadId, clientId, input, context),
            projectHistory: (method, params, result) => codexAgent.projectExternalHistory(method, params, result),
            observeTitle: (method, params, result) => codexAgent.observeExternalTitle(method, params, result),
            releaseForAdoption: threadId => codexAgent.releaseForAdoption(threadId),
          } : {}),
        }) : codexAgent;
        if (!ownsHostState) return routing;
        // With Core, Host services read native Codex over their own connection to Core's AppServer.
        const reader = options.codexCoreEndpoint ? new CodexNativeReader(options.codexCoreEndpoint, options.authToken) : undefined;
        hostServices = new CodexHostServices(routing, clients => [
          codexTasksService(join(options.codexDataDirectory, "tasks.sqlite"), clients, reportCodexStorage),
          ...(options.codexCoreEndpoint ? [codexAccountsService(new CodexCoreControlClient(options.codexCoreEndpoint, options.authToken))] : []),
          ...(reader ? [codexModelsService(reader), codexPinsService(reader, clients, routing instanceof CodexProviderBridge ? routing.threadIdentities() : undefined),
            { handles: () => false, request: () => null, close: () => reader.close() }] : []),
        ]);
        return hostServices;
      }
      throw new Error(`OpenCraft Daemon does not own Host ${hostId}`);
      });
    },
  });
  if(humanAccounts) collaboration=new Collaboration(humanAccounts.storage,humanAccounts.actors,
    createRoutedConversationExecution(()=>appHost,{machineId:machineIdentity.machineId,engines:['dsh'],agentHostId:'local'}),Date.now,humanAccounts.admittedActor,undefined,(c,r)=>threadAccess!.allows(r.serverId,r.threadId,c));
  if(collaboration)assistantThreads=new AssistantThreadCommands(collaboration,createThreadOrchestrationExecution(()=>appHost),threadAccess!);
  let daemonServer: Awaited<ReturnType<typeof startOpenCraftDaemonServer>>;
  const close = (): Promise<void> => {
    if (closing !== null) return closing;
    let operation!: Promise<void>;
    operation = Promise.resolve().then(async () => {
      await daemonServer.close();
      await personalAssistantHost?.close();
      await assistantThreads?.close();
      try { await appHost.close(); } catch (error) {
        // Keep dependent handles owned and allow a later explicit shutdown to
        // retry the AppHost's retained physical cleanup. Server close is idempotent.
        if (closing === operation) closing = null;
        throw error;
      }
      const agent = localAgent ?? await localAgentStarting?.catch(() => null);
      localAgent = null;
      try { await agent?.close(); } finally {
        try { await storage.close(); } finally { await releaseStorageOwner(); }
      }
      await Promise.allSettled([...codexAgents].map(adapter => adapter.close()));
      codexAgents.clear();
      await collaboration?.close();
      threadAccess?.close();
      await accountServer?.close();
      await humanAccounts?.close();
    });
    closing = operation;
    return operation;
  };
  try {
    await assistantThreads?.initialize();
    collaboration?.start();
    let environmentProviders={};
    if(collaboration&&process.env.OPENCRAFT_ASSISTANT_SANDBOX_CONFIG){
      try{environmentProviders=await loadAssistantEnvironments(process.env.OPENCRAFT_ASSISTANT_SANDBOX_CONFIG);}
      catch{console.warn('assistant_environment_configuration_unavailable');}
    }
    if(collaboration && options.humanAccountDirectory)personalAssistantHost=await createPersonalAssistantHost({directory:options.humanAccountDirectory,service:collaboration,environmentProviders,
      ...(options.modelStorageDirectory?{modelSource:createAssistantModelSource(options.modelStorageDirectory)}:{}),codexBinary:options.codexExecutable});
    daemonServer = await startOpenCraftDaemonServer({
    storage: storageSummary,
    endpoint: options.endpoint,
    authToken: options.authToken,
    appHost,
    ...(humanAccounts ? { authenticateHumanSession: proof => humanAccounts!.authenticateSession(proof) } : {}),
    ...(humanAccounts && accountServer ? { attachAccount: (origin: string, openRemote: (origin: string) => Promise<void>) => {
      humanAccounts!.setOrigin(origin);
      openRemoteWindow = openRemote;
      return { browserProof: humanAccounts!.browserProof, sessionToken: humanAccounts!.createNativeSession(), endpoint: accountServer!.endpoint };
    } } : {}),
    onShutdownRequested: () => void close().then(() => process.exit(0), () => process.exit(1)),
  });
  } catch (error) {
    await personalAssistantHost?.close();
    await assistantThreads?.close();
    await collaboration?.close();
    threadAccess?.close();
    await accountServer?.close();
    await humanAccounts?.close();
    await appHost.close();
    try { await storage.close(); } finally { await releaseStorageOwner(); }
    throw error;
  }
  return { endpoint: daemonServer.endpoint, close };
}
