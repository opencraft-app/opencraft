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
  openUsageQueries<T extends WorkspaceHostClosable>(createUsageQueries: () => T): T;
  openFileDownloads<T extends WorkspaceHostClosable>(options: {
    createFileDownloads(resolve: (hostId: string) => unknown): T;
    fileSystem: unknown;
    remoteServers: ReadonlyMap<string, { connection: unknown }>;
    sshManagement: { store: { binding(hostId: string): { connection: unknown } | null | undefined } } | undefined;
  }): T;
  maintainReadiness(appHostServer: unknown): void;
  hostReadiness(): Record<string, unknown>;
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
  // Shutdown step 10.
  closeExecutionCli: WorkspaceHostDisposer;
  closeCapabilityMcp: WorkspaceHostDisposer;
  // Shutdown step 11.
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
  conversationResources: LateBinding<{ assertActive(hostId: string, threadId: string): void }>;
  executionObservation: LateBinding<{ resolveNative(threadId: string): Promise<{ incarnation: string } | null> }>;
  executionRecovery: LateBinding<{ inspect(state: Record<string, unknown>): Promise<string> }>;
}): WorkspaceHostAssembly;
