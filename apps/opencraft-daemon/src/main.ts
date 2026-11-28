import { startCodexBridgeStack, startCodexEngineHost, type CodexBridgeStack } from "./codex-bridge-stack.js";
import { bridgeOwnerPolicy, bridgeOwnersOf } from "./codex-bridge-owners.js";
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
import { TurnActivityKeepAwake, type SleepInhibitor } from "./keep-awake.js";

import { CodexProviderBridge } from "./codex-provider-bridge.js";
import { codexAdmissionPaused } from "./codex-maintenance.js";
import { CodexHostServices, codexAccountsService, codexModelsService, codexPinsService, codexTasksService } from "./codex-host-services.js";
import { CodexNativeReader } from "./codex-native-reader.js";
import { createCodexBridgeHost } from "./codex-bridge-host.js";
import { CodexCoreControlClient } from "@opencraft/account-pool-host";
import type { DuplexTransport } from "@opencraft/appserver-client/transport";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import type { BridgeGatewayOptions } from "@opencraft/agent-bridge-host/gateway";
import { CodexEngineAdapter } from "./codex-engine-adapter.js";
import { defaultWorkspace } from "./workspace-host.js";
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
  /**
   * Launch the Codex bridge stack (Core, AppServer, Engine Host) from this
   * program directory as the daemon's children and route Codex through it.
   * Excludes an explicit Core endpoint or bridge configuration.
   */
  readonly codexBridgeStack?: { readonly programs: string };
  /**
   * Start a Codex Engine Host from this program directory against the existing Core
   * (`codexCoreEndpoint`), as a server's managed execution unit does: new Threads are
   * created on the bridge and existing ones move to it on their next turn when the
   * local Host can vouch they are idle; the rest stay on the local Host. Excludes an
   * explicit bridge configuration and the bridge stack.
   */
  readonly codexEngineHost?: { readonly programs: string };
  readonly codexWriterOwnership?: boolean;
  /** Trusted composition may replace only native startup while preserving the
   * daemon's identity, storage reporting and AppHost/IPC assembly. */
  readonly createCodexTransport?: (options: ConstructorParameters<typeof CodexEngineAdapter>[0]) => CodexEngineAdapter;
  /** Deployment display name; defaults to the OS computer name. */
  readonly machineName?: string;
  readonly sleepInhibitor?: SleepInhibitor;
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
  // Started only while this daemon owns storage, so it never stops another daemon's children.
  // The bridge stack is the Codex Host's runtime, not a daemon prerequisite: it starts in the
  // background so Main, the account service and the other Hosts never wait on native Codex, and
  // a failed start leaves only Codex unavailable. The next Codex connection retries.
  let codexStack: CodexBridgeStack | undefined;
  let codexStackStarting: Promise<CodexBridgeStack> | null = null;
  let codexStackClosed = false;
  const bridgeStack = options.codexBridgeStack;
  if (bridgeStack && (options.codexCoreEndpoint || options.codexAgentBridge)) {
    await accountServer?.close();
    try { await humanAccounts?.close(); } catch { /* keep the original failure */ }
    try { await storage.close(); } finally { await releaseStorageOwner(); }
    throw new Error("The Codex bridge stack owns its Core and bridge");
  }
  const startBridgeStack = (stack: { readonly programs: string }) => codexStackStarting ??= startCodexBridgeStack({
    programs: stack.programs,
    node: process.execPath,
    codexExecutable: options.codexExecutable,
    codexDataDirectory: options.codexDataDirectory,
    nativeCodexHomeDirectory: options.nativeCodexHomeDirectory,
    runtimeDirectory: options.runtimeDirectory,
    stateDirectory: join(options.dataDirectory, "codex-bridge"),
    authToken: options.authToken,
    ...(options.modelStorageDirectory ? { modelStorageDirectory: options.modelStorageDirectory } : {}),
  }).then(async started => {
    if (codexStackClosed) { await started.close(); throw new Error("OpenCraft Daemon is shutting down"); }
    codexStack = started;
    return started;
  }, (error: unknown) => {
    codexStackStarting = null;
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[opencraft-daemon] Codex is unavailable: the bridge stack did not start: ${reason}`);
    throw new Error(`Codex is unavailable: ${reason}`, { cause: error });
  });
  const closeBridgeStack = async () => {
    codexStackClosed = true;
    await codexStackStarting?.catch(() => undefined);
    await codexStack?.close();
  };
  if (bridgeStack) void startBridgeStack(bridgeStack).catch(() => undefined);
  let codexEngineHost: { close(): Promise<void> } | undefined;
  if (options.codexEngineHost) {
    try {
      if (!options.codexCoreEndpoint || options.codexAgentBridge || options.codexBridgeStack) throw new Error("The Codex Engine Host needs an existing Core and owns the bridge");
      const engineHost = await startCodexEngineHost({
        programs: options.codexEngineHost.programs,
        node: process.execPath,
        coreEndpoint: options.codexCoreEndpoint,
        coreToken: options.authToken,
        runtimeDirectory: options.runtimeDirectory,
        stateDirectory: join(options.dataDirectory, "codex-bridge"),
      });
      codexEngineHost = engineHost;
      options = { ...options, codexAgentBridge: engineHost.bridge, codexAgentBridgeAdoptExisting: true };
    } catch (error) {
      await accountServer?.close();
      try { await humanAccounts?.close(); } catch { /* keep the original failure */ }
      try { await storage.close(); } finally { await releaseStorageOwner(); }
      throw error;
    }
  }
  let localAgent: Awaited<ReturnType<typeof startLocalAgentHost>> | null = null;
  let localAgentStarting: Promise<Awaited<ReturnType<typeof startLocalAgentHost>>> | null = null;
  const codexAgents = new Set<CodexEngineAdapter>();
  const keepAwake = new TurnActivityKeepAwake(options.sleepInhibitor ? { inhibitor: options.sleepInhibitor } : {});
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
      const transport = new MachineIdentityTransport(machineIdentity, hostId === "local" ? "OpenCraft" : "Codex", async () => {
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
        // With the daemon's own bridge stack, Codex is reachable once the stack is.
        const stack = bridgeStack ? await startBridgeStack(bridgeStack) : undefined;
        const codex = stack ? { ...options, codexCoreEndpoint: stack.coreEndpoint, codexCoreHostOverlays: true,
          codexAgentBridge: stack.bridge, codexAgentBridgeAdoptExisting: true } : options;
        // The Host services front owns Host-wide stores exactly where the local Codex Host
        // would have (no Core, or Core with overlays); a pass-through to Core owns none.
        const ownsHostState = !codex.codexCoreEndpoint || codex.codexCoreHostOverlays === true;
        let hostServices: CodexHostServices | undefined;
        let adapterOutcomes: readonly { name: string; outcome: DatabaseOutcome }[] = [];
        const reportCodexStorage = () => {
          const retained = storageSummary.filter(row => row.hostId !== "local-codex");
          storageSummary.splice(0, storageSummary.length, ...retained, ...[...adapterOutcomes, ...(hostServices?.storage() ?? [])].map(({ name, outcome }) => ({
            hostId: "local-codex", name, status: outcome.status, appliedVersion: outcome.appliedVersion,
            backupPath: outcome.backupPath, movedAside: outcome.movedAsidePaths.length > 0,
          })));
        };
        // With the daemon's own bridge stack or managed Engine Host, every Thread runs on the bridge and no legacy Host is composed.
        if (
          (options.codexBridgeStack || options.codexEngineHost || codex.codexAgentBridgeAdoptExisting) &&
          codex.codexAgentBridge &&
          codex.codexCoreEndpoint &&
          !options.createCodexTransport
        ) {
          hostServices = createCodexBridgeHost({
            coreEndpoint: codex.codexCoreEndpoint, coreAuthToken: options.authToken, bridge: codex.codexAgentBridge,
            codexDataDirectory: options.codexDataDirectory, artifactDirectory: join(options.dataDirectory, "artifacts"),
            storageOpened: reportCodexStorage,
          });
          reportCodexStorage();
          return hostServices;
        }
        const codexAgent = (options.createCodexTransport ?? (configuration => new CodexEngineAdapter(configuration)))({
          historyImageResources: process.env.OPENCRAFT_HISTORY_IMAGE_RESOURCES === "1",
          onStorageOpened: outcomes => { adapterOutcomes = outcomes; reportCodexStorage(); },
          ...(ownsHostState ? { externalTasks: true } : {}),
          executable: options.codexExecutable,
          ...(options.codexExecutableSource ? { executableSource: options.codexExecutableSource } : {}),
          runtimeDirectory: options.runtimeDirectory,
          dataDirectory: options.codexDataDirectory,
          // The desktop daemon assembles exactly one WorkspaceHost: `default`, at today's Codex data root.
          workspace: defaultWorkspace(options.codexDataDirectory),
          artifactDirectory: join(options.dataDirectory,"artifacts"),
          nativeCodexHomeDirectory: options.nativeCodexHomeDirectory,
          ...codexCoreOptions(codex),
          writerOwnership: options.codexWriterOwnership,
        });
        codexAgents.add(codexAgent);
        if (codex.codexAgentBridge && !codex.codexCoreEndpoint) throw Error("Bridge requires existing Core endpoint");
        // The local Host holds the records bridge Threads share with its own (attachments, senders, titles, usage).
        const owners = codex.codexAgentBridge ? bridgeOwnersOf(codexAgent) : undefined;
        const routing: DuplexTransport = codex.codexAgentBridge ? new CodexProviderBridge(codexAgent, codex.codexAgentBridge, {
          admissionPaused: () => codexAdmissionPaused(options.codexDataDirectory),
          adoptExisting: codex.codexAgentBridgeAdoptExisting === true,
          // With the daemon's own bridge stack, Codex runs only through the bridge.
          newThreads: options.codexBridgeStack !== undefined || options.codexEngineHost !== undefined,
          ...(owners ? bridgeOwnerPolicy(owners) : {}),
        }) : codexAgent;
        if (owners && routing instanceof CodexProviderBridge) owners.bindThreadIdentities(routing.threadIdentities());
        if (!ownsHostState) return routing;
        // With Core, Host services read native Codex over their own connection to Core's AppServer.
        const reader = codex.codexCoreEndpoint ? new CodexNativeReader(codex.codexCoreEndpoint, options.authToken) : undefined;
        hostServices = new CodexHostServices(routing, clients => [
          codexTasksService(join(options.codexDataDirectory, "tasks.sqlite"), clients, reportCodexStorage),
          ...(codex.codexCoreEndpoint ? [codexAccountsService(new CodexCoreControlClient(codex.codexCoreEndpoint, options.authToken))] : []),
          ...(reader ? [codexModelsService(reader), codexPinsService(reader, clients, routing instanceof CodexProviderBridge ? routing.threadIdentities() : undefined),
            { handles: () => false, request: () => null, close: () => reader.close() }] : []),
        ]);
        return hostServices;
      }
      throw new Error(`OpenCraft Daemon does not own Host ${hostId}`);
      });
      transport.subscribeMessage((frame) => keepAwake.observeFrame(hostId, frame));
      transport.subscribeStatus((status) => {
        if (status.state === "closed" || status.state === "failed") keepAwake.releaseHost(hostId);
      });
      return transport;
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
      keepAwake.close();
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
      await codexEngineHost?.close();
      await closeBridgeStack();
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
    keepAwake.close();
    await personalAssistantHost?.close();
    await assistantThreads?.close();
    await collaboration?.close();
    threadAccess?.close();
    await accountServer?.close();
    await humanAccounts?.close();
    await appHost.close();
    await codexEngineHost?.close();
    await closeBridgeStack();
    try { await storage.close(); } finally { await releaseStorageOwner(); }
    throw error;
  }
  return { endpoint: daemonServer.endpoint, close };
}
