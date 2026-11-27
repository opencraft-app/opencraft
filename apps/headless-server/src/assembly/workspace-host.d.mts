import type { SessionCapabilities } from "@opencraft/session-capabilities";
import type { HeadlessLifecycle, LateBinding } from "./lifecycle.mjs";

/** Something the shutdown order closes; a missing one resolves without effect. */
export type WorkspaceHostDisposer = () => unknown;

/** A store or service the composition root opened through a factory and the module owns from then on. */
export interface WorkspaceHostClosable {
  close(): unknown;
  readonly [member: string]: unknown;
}

/** The Assets vault owner as the module reads it (the core assets vault Worker on Node). */
export interface WorkspaceHostAssetsStorage extends WorkspaceHostClosable {
  readonly store: { adoptWorkspaceInstallation(configuration: string): Promise<unknown> } & Record<string, unknown>;
  readonly botExecution?: unknown;
  readonly workspaceExecution?: unknown;
  readonly environmentLaunch?: WorkspaceHostEnvironmentLaunch;
  readonly environmentMetadata?: unknown;
  readonly personalGitSeal?: unknown;
  readonly botBackends?: readonly string[];
}

/** The opaque ENV vault-owner port: the identity composition's or the core vault Worker's. */
export interface WorkspaceHostEnvironmentLaunch {
  readonly issuer?: string;
  readonly [member: string]: unknown;
}

/** Personal Assets with the Git execution authority of the core assets vault. */
export interface WorkspaceHostHumanAssets extends WorkspaceHostClosable {
  readonly gitHosts: readonly string[];
  readonly gitAuthority: string;
  executionGitGrant(locator: unknown): unknown;
  executionGitReservation(locator: unknown): unknown;
}

/** The one personal Git execution owner (core assets Worker or identity port). */
export interface WorkspaceHostGitOwner {
  readonly hosts: readonly string[];
  readonly authority: string;
  grant(locator: unknown): unknown;
  reservation(locator: unknown): unknown;
}

/** What the module passes the personal Git execution factory; the root adds its directories and worker. */
export interface WorkspaceHostGitExecutionInputs {
  hosts: readonly string[];
  authority: string;
  grant(locator: unknown): unknown;
  /** Live Actor checks: current, enabled, human, same generation, admitted; false once shutdown starts. */
  authorize(scope: { account: string; actorGeneration: number }): boolean;
  /** Live lease checks against the execution observation and recovery ports. */
  inspect(handoff: unknown): Promise<boolean>;
}

export interface WorkspaceHostExecutionDelivery {
  assetsStorage: WorkspaceHostAssetsStorage | undefined;
  botAdmission: WorkspaceHostClosable | undefined;
  installedBotProvider: WorkspaceHostClosable | undefined;
  ownedWorkspaceRouting: WorkspaceHostClosable | undefined;
  /** Core's own routing when it owns workspace execution, else the identity routing it received. */
  workspaceRouting: unknown;
  assetsService: WorkspaceHostHumanAssets | undefined;
  gitExecutionOwner: WorkspaceHostGitOwner | undefined | false;
  humanGitExecution: (WorkspaceHostClosable & { handoff(locator: unknown): Promise<unknown> }) | undefined;
  environmentLaunch: WorkspaceHostEnvironmentLaunch | undefined;
  environmentMetadata: unknown;
  codexEnvironmentLaunch: unknown;
}

/** The routed conversation execution the module resolves servers and Hosts through. */
export interface WorkspaceHostConversationExecution {
  readonly servers: ReadonlyArray<{ serverId: string; hostId: string; engine?: string }>;
  serverForHost(hostId: string, threadId: string): string;
  serverForThread(threadId: string): string;
  hostForServer(serverId: string): string | undefined;
}

/** An execution engine as the module drives it: the DSH agent, the Pi engine host or an independent Engine Host. */
export interface WorkspaceHostEngine extends WorkspaceHostClosable {
  readonly websocketUrl?: string;
  resolveWebsocketUrl?(): Promise<string>;
  getExecutionIdentity?(threadId: string): Promise<{
    pid: number | null;
    incarnation?: string;
    turn?: { id: string; status: unknown; inputId?: string };
  }>;
  readonly inputs?: WorkspaceHostEngineInputs;
}

/** An engine's explicit Host input port. */
export interface WorkspaceHostEngineInputs {
  receipt(...args: unknown[]): unknown;
  submit(
    threadId: string,
    inputId: string,
    text: string,
    admit: () => Promise<boolean>,
  ): Promise<{ state?: string; turnId?: string } | null | undefined>;
}

/** The DSH agent, which also reports its execution process identity. */
export interface WorkspaceHostDshAgent extends WorkspaceHostEngine {
  engineExecutionIdentity(): Promise<unknown>;
}

/** What the module passes the DSH start factory; the root adds its paths and configuration in their original order. */
export interface WorkspaceHostDshInputs {
  executionCli: WorkspaceHostClosable | undefined;
  /** Evaluated by the root at its original position in the engine options. */
  sessionCapabilities(): unknown;
  /** Present with a Hands file owner. */
  prepareArtifact: ((artifact: unknown, owner: string, signal?: AbortSignal) => Promise<unknown>) | undefined;
  taskConversationCatalog(serverId: string, search: unknown, limit: unknown, cursor: unknown): unknown;
}

/** The in-process Pi engine; the root wraps its close to release its attachment staging. */
export interface WorkspaceHostPiEngine extends WorkspaceHostClosable {
  readonly inputs?: WorkspaceHostEngineInputs;
  readonly orchestrationIncarnation: string;
  setOrchestration(port: { tools: unknown; call(...args: never[]): Promise<unknown> }): void;
}

/** The execution lease store as the module drives it. */
export interface WorkspaceHostExecutionStore {
  suspend(): void;
  unsettledThreads(): string[];
  reconcile(threadId: string, turns: unknown[], incarnation: string | undefined): void;
  capture(threadId: string, inputId: string, principal: unknown, state: string, source: string): void;
  begin(threadId: string, inputId: string, incarnation: string | undefined): void;
  started(threadId: string, turnId: string, inputId: string, incarnation: string | undefined): void;
}

/** A native execution process identity (reported by an owner or observed in this process). */
export interface WorkspaceHostNativeExecution {
  readonly pid: number;
  readonly incarnation: string;
}

/** A Hands terminal service, one per Host. */
export interface WorkspaceHostTerminalService extends WorkspaceHostClosable {
  releaseThread(hostId: string, threadId: string, active: boolean, aliases: unknown[]): Promise<unknown>;
  threadScopes(): Promise<Array<{ hostId: string }>>;
}

export interface WorkspaceHostAssembly {
  openExecutionDelivery(options: {
    identity: Record<string, unknown> | null | undefined;
    workspaceExecution: Record<string, unknown> | undefined;
    /** The identity composition's routing, before core opens its own. */
    workspaceRouting: unknown;
    coreEnvironmentLaunch: boolean;
    environmentIssuer: unknown;
    terminalOwner: unknown;
    machineIdentity: { machineId: string };
    actorStore: unknown;
    instanceAccess: unknown;
    humanAuth: unknown;
    /** The core SQL owner: Codex creation reservations commit through it. */
    serverStorage: unknown;
    codexCoreEndpoint: string | undefined;
    /** Read once the vault is open: an installed assistant sandbox configuration the vault adopts, if any. */
    readAssistantSandboxConfig: () => string | undefined;
    /** Launches a local Bot process for the installed Bot provider (Node: `spawnAssistant`). */
    spawnAssistant: (...args: never[]) => unknown;
    openAssetsStorage(options: Record<string, unknown>): Promise<WorkspaceHostAssetsStorage>;
    openWorkspaceExecution(options: Record<string, unknown>): Promise<WorkspaceHostClosable>;
    openHumanAssets(options: {
      auth: unknown;
      actors: unknown;
      access: unknown;
      openStorage(): Promise<unknown>;
    }): Promise<WorkspaceHostHumanAssets>;
    createHumanGitExecution(
      options: WorkspaceHostGitExecutionInputs,
    ): WorkspaceHostClosable & { handoff(locator: unknown): Promise<unknown> };
  }): Promise<WorkspaceHostExecutionDelivery>;
  /** Refuses engines this process cannot run, then creates the routed conversation execution. */
  openConversationExecution(options: {
    engines: readonly string[];
    engineHostDescriptor: string | undefined;
    machineIdentity: { machineId: string };
  }): WorkspaceHostConversationExecution & Record<string, unknown>;
  /** Refuses a configured vault owner without an Actor/lease handoff. */
  assertEnvironmentAdmission(): void;
  openBrowser(options: {
    createRemoteBrowser(options: { ownerConnector?: () => Promise<unknown> }): WorkspaceHostClosable;
    /** The configured browser owner; without one, core-owned workspaces refuse and others use the built-in owner. */
    ownerConnector: (() => Promise<unknown>) | undefined;
    conversationExecution: WorkspaceHostConversationExecution;
    actorStore: unknown;
    instanceAccess: unknown;
    threadAccess: unknown;
    actorCollaboration: unknown;
    anonymousDeployment: boolean;
    operator: { owns(actorId: string): boolean };
  }): { remoteBrowser: WorkspaceHostClosable; browserCapabilities: WorkspaceHostClosable };
  /** Registers (replacing and invalidating) a remote Codex Host's native execution authority. */
  remoteExecution(
    serverId: string,
    hostId: string,
  ): {
    authority: unknown;
    nativeTool(context: unknown, tool: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  };
  openCapabilityMcp(options: {
    capabilityKey: unknown;
    capabilityBindings: unknown;
    conversationExecution: WorkspaceHostConversationExecution;
    anonymousDeployment: boolean;
    actorCollaboration: unknown;
    threadOrchestration: unknown;
    /** Creates the listener (not yet listening); the root supplies its descriptor and CLI paths ahead of `handlers`. */
    createCapabilityMcp(
      registry: SessionCapabilities,
      key: unknown,
      bindings: unknown,
      handlers: Record<string, unknown>,
    ): WorkspaceHostClosable & { listen(): Promise<unknown>; readonly cliEndpoint: string };
    openExecutionCli(options: { endpoint: string; key: unknown }): Promise<WorkspaceHostClosable>;
    /** Present only when the server runs its own Codex Engine Host. */
    startCodexEngineHost:
      ((options: { cliEndpoint: string }) => Promise<WorkspaceHostClosable & { bridge: unknown }>) | undefined;
  }): Promise<{
    capabilityMcp: WorkspaceHostClosable;
    connectedExecutionCli: WorkspaceHostClosable;
    codexEngineHost: WorkspaceHostClosable | undefined;
    bridgeSessionMcp: Record<string, unknown>;
  }>;
  openEngines(options: {
    engines: readonly string[];
    machineIdentity: { machineId: string };
    actorCollaboration: { executionStarted(threadId: string, inputId: string, turnId: string): unknown };
    threadOrchestration: { invoke(...args: unknown[]): Promise<unknown> };
    readTaskConversations(appHostServer: unknown, search: unknown, limit: unknown, cursor: unknown): unknown;
    startDsh(inputs: WorkspaceHostDshInputs): Promise<WorkspaceHostDshAgent>;
    /** Present only with an independent Engine Host descriptor. */
    attachIndependentEngine: (() => Promise<WorkspaceHostEngine>) | undefined;
    /** The in-process Pi owner lock; resolves to its release. */
    acquirePiOwner(): Promise<() => unknown>;
    createPiEngine(options: {
      executionCli: WorkspaceHostClosable | undefined;
      executionGit: unknown;
      sessionCapabilities(): unknown;
    }): Promise<WorkspaceHostPiEngine>;
    startPiEngineHost(options: {
      piEngine: WorkspaceHostPiEngine;
      startDsh: () => Promise<WorkspaceHostDshAgent>;
    }): Promise<WorkspaceHostEngine>;
  }): Promise<WorkspaceHostEngine>;
  openExecutionObservation(options: {
    /** The identity's Thread metadata owner; with it the overlay owns the lease store. */
    createThreadMetadata: unknown;
    createIdentityOverlay(options: {
      resolveTarget(): Promise<string | undefined>;
      createMetadata: unknown;
      resolveExecutionNative(threadId: string): Promise<WorkspaceHostNativeExecution | null>;
    }): WorkspaceHostClosable & { readonly executions: WorkspaceHostExecutionStore };
    openExecutionLeases(): { database: WorkspaceHostClosable; store: WorkspaceHostExecutionStore };
    reportedExecutionProcess(value: { pid: number; incarnation: string | undefined }): WorkspaceHostNativeExecution;
    /** This process's own native execution identity (the in-process Pi engine). */
    observeOwnProcess(): Promise<WorkspaceHostNativeExecution>;
    createExecutionRecovery(resolveTarget: () => Promise<string | undefined>): Promise<
      WorkspaceHostClosable & {
        inspect(state: Record<string, unknown>): Promise<string>;
        readThread(threadId: string): Promise<{ thread?: { turns?: unknown[] } } | null | undefined>;
      }
    >;
  }): Promise<{
    agentIdentity: (WorkspaceHostClosable & { readonly executions: WorkspaceHostExecutionStore }) | undefined;
    executionStore: WorkspaceHostExecutionStore;
    resolveExecutionNative(threadId: string): Promise<WorkspaceHostNativeExecution | null>;
  }>;
  openUsageQueries<T extends WorkspaceHostClosable>(createUsageQueries: () => T): T;
  openConversationResources(options: {
    /** Present only with a configured Hands terminal owner; the root adds its endpoint and paths first. */
    createTerminalService:
      ((options: { environment: unknown; environmentLaunch?: unknown }) => WorkspaceHostTerminalService) | undefined;
    identity: Record<string, unknown> | null | undefined;
    actorStore: unknown;
    instanceAccess: unknown;
    /** The core SQL owner holding the conversation resource rows. */
    serverStorage: unknown;
    ownerWake: unknown;
  }): Promise<{
    conversationResources: { assertActive(hostId: string, threadId: string): void } & Record<string, unknown>;
    terminalService(hostId: string): unknown;
    resourceAuthority(context: unknown): void;
    terminalScope(hostId: string): (context: unknown, params: Record<string, unknown>) => Record<string, unknown>;
  }>;
  openFileDownloads<T extends WorkspaceHostClosable>(options: {
    createFileDownloads(resolve: (hostId: string) => unknown): T;
    remoteServers: ReadonlyMap<string, { connection: unknown }>;
    sshManagement: { store: { binding(hostId: string): { connection: unknown } | null | undefined } } | undefined;
  }): T;
  /**
   * The workspace-host layers of the local Hosts' App Host transports; the root
   * applies `scopeExecution`, then its model gateway settings layer, then
   * `scopeResources`, then its push observation.
   */
  openHostTransports(options: {
    transports: {
      executionEnvironment(transport: unknown, runtime: unknown, hostId: string): unknown;
      environmentMetadata(transport: unknown, metadata: unknown, hostId: string): unknown;
      workspaceCatalog(
        transport: unknown,
        readCatalog: (context: unknown) => unknown,
        readFileScope: ((context: unknown, threadId: string) => unknown) | undefined,
      ): unknown;
      terminals(
        transport: unknown,
        service: unknown,
        scope: (context: unknown, params: Record<string, unknown>) => Record<string, unknown>,
        hostId: string,
        select: ((scope: unknown, context: unknown, local: unknown) => unknown) | undefined,
      ): unknown;
      files(
        transport: unknown,
        files: unknown,
        authority: (context: unknown) => void,
        select: ((context: unknown, params: unknown, local: unknown) => unknown) | undefined,
      ): unknown;
      conversationResources(transport: unknown, hostId: string, resources: unknown): unknown;
    };
    /** The composition's per-request selectors, if any. */
    selectHostTerminalService: ((...args: never[]) => unknown) | undefined;
    selectHostFiles: ((...args: never[]) => unknown) | undefined;
  }): {
    scopeExecution(hostId: string, transport: unknown): unknown;
    scopeResources(hostId: string, transport: unknown): unknown;
  };
  /** Retries pending releases and starts the periodic archived-resource reconciliation. */
  startResourceReconciliation(options: { appHostServer: unknown; ownerWake: unknown }): void;
  maintainReadiness(appHostServer: unknown, externalCodex: boolean): void;
  hostReadiness(): Record<string, unknown>;
  // Shutdown step 1.
  /** Synchronous: disarms the reconciliation wake-up. */
  closeResourceReconciliation: WorkspaceHostDisposer;
  closeConversationResources: WorkspaceHostDisposer;
  // Shutdown step 3.
  closeReadiness: WorkspaceHostDisposer;
  closeUsageQueries: WorkspaceHostDisposer;
  /** Synchronous: a failure rejects the serial browser group, as before. */
  withdrawGitStatus: WorkspaceHostDisposer;
  closeBrowserCapabilities: WorkspaceHostDisposer;
  closeRemoteBrowser: WorkspaceHostDisposer;
  closeFileDownloads: WorkspaceHostDisposer;
  // Shutdown step 7.
  closeCodexEngineHost: WorkspaceHostDisposer;
  // Shutdown step 8, synchronous.
  closeTerminals: WorkspaceHostDisposer;
  closeFileSystem: WorkspaceHostDisposer;
  // Shutdown step 10.
  closeEngine: WorkspaceHostDisposer;
  closeDsh: WorkspaceHostDisposer;
  closeExecutionCli: WorkspaceHostDisposer;
  closeCapabilityMcp: WorkspaceHostDisposer;
  holdsPiOwner(): boolean;
  releasePiOwner: WorkspaceHostDisposer;
  closeExecutionRecovery: WorkspaceHostDisposer;
  closeIdentityOverlay: WorkspaceHostDisposer;
  // Shutdown step 11.
  closeExecutionDatabase: WorkspaceHostDisposer;
  closeWorkspaceRouting: WorkspaceHostDisposer;
  closeBotProvider: WorkspaceHostDisposer;
  closeBotAdmission: WorkspaceHostDisposer;
  closeHumanGitExecution: WorkspaceHostDisposer;
  closeHumanAssets: WorkspaceHostDisposer;
  closeAssetsStorage: WorkspaceHostDisposer;
}

export function assembleWorkspaceHost(options: {
  lifecycle: HeadlessLifecycle;
  /** The composition root's capability registry, shared with the installation. */
  capabilities: SessionCapabilities;
  appHost: LateBinding<unknown>;
  codexBridge: LateBinding<unknown>;
  /** The Hands file owner the root constructed (Node), or null; the module closes it at step 8. */
  fileSystem:
    | (WorkspaceHostClosable & {
        prepareArtifact(artifact: unknown, owner: string, signal?: AbortSignal): Promise<unknown>;
      })
    | null;
}): WorkspaceHostAssembly;
