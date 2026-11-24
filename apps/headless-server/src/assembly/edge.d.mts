import type { LateBinding } from "./lifecycle.mjs";

/** Something the shutdown order closes; a missing one resolves without effect. */
export type EdgeDisposer = () => unknown;

/** The runtime plugin host as the edge reads it (Node: `startHeadlessRuntimePlugins`). */
export interface EdgeRuntimePlugins {
  health(): unknown;
  close(): unknown;
  readonly [member: string]: unknown;
}

/** The Web server the composition root's factory creates (Node: `createWorkbenchWebServer`). */
export interface EdgeWebServer {
  listen(options: { host: string; port: number }): Promise<{ port: number }>;
  close(update: unknown, retireIngress: () => unknown): unknown;
  readonly [member: string]: unknown;
}

/** A store's migration outcome as the health report reads it. */
interface EdgeStoreOutcome {
  readonly status: unknown;
  readonly appliedVersion: unknown;
  readonly backupPath?: unknown;
  readonly movedAsidePaths: readonly unknown[];
}

export interface EdgeAssembly {
  /** Starts the runtime plugins; `start` is undefined when none are configured. */
  startRuntimePlugins(start: (() => Promise<EdgeRuntimePlugins>) | undefined): Promise<EdgeRuntimePlugins | undefined>;
  /** Creates the Web server with the options of every module, in their original key order. */
  openWeb(options: {
    createWebServer(options: Record<string, unknown>): Promise<EdgeWebServer>;
    webRoot: string;
    userPluginDirectory: string | null;
    productPluginAssets: unknown;
    workbenchAssetsPlugin?: import("../web-deployment/workbench-assets-plugin.mjs").WorkbenchAssetsPlugin;
    webRelease: { readonly buildId: string };
    isolateBrowserStorage: boolean | undefined;
    machineIdentity: { readonly machineId: string };
    observability: unknown;
    ownerWake: unknown;
    getExecutionHealth: unknown;
    hostReadiness(): Record<string, unknown>;
    /** The client-session module's Web sessions, spread at their original keys. */
    sessions: Record<string, unknown>;
    agent: {
      readonly websocketUrl?: string;
      readonly resolveWebsocketUrl?: unknown;
      readonly storageOutcomes?: readonly unknown[];
    };
    agentIdentity: { readonly store: { readonly outcome: EdgeStoreOutcome } } | null | undefined;
    mcpApps: { readonly outcome: EdgeStoreOutcome };
    imPlugins: LateBinding<
      | {
          states(): unknown;
          readonly outcome: EdgeStoreOutcome;
          readonly postOutcome: EdgeStoreOutcome;
        }
      | undefined
    >;
    connectorService: { outcomes(): readonly unknown[] } | null | undefined;
    loopbackOnly: boolean;
    localAccess: unknown;
    appHostServer: unknown;
    sshServers: ReadonlyArray<{ readonly descriptor: unknown }>;
    sshManagement: { readonly store: { readonly outcome: EdgeStoreOutcome } } | null | undefined;
    fileDownloads: unknown;
    turnPush: { readonly health: unknown; readonly store: { readonly outcome: EdgeStoreOutcome } } | null | undefined;
    serverStorage: {
      readonly outcome: { readonly status: unknown; readonly appliedVersion: unknown };
      readonly contract: { readonly productVersion: unknown; readonly hash: unknown };
    };
    remoteBrowser: { storageOutcomes(): readonly unknown[] } | null | undefined;
    identity:
      | {
          readonly service?: unknown;
          getStorageOutcomes?: () => readonly unknown[];
          readonly [member: string]: unknown;
        }
      | null
      | undefined;
    loginAdmission: { readonly outcome: EdgeStoreOutcome } | null | undefined;
    /** Codex adapter storage outcomes by Host, written by the root's adapters. */
    codexStorageOutcomes: ReadonlyMap<string, readonly unknown[]>;
    desktop: unknown;
    desktopAccess: "loopback" | "trusted-internal";
    /** The account module: its HTTP and speech services are created at their original keys. */
    account: {
      createHttpService(options: { actorAccess: unknown; actorStore: unknown; instanceAccess: unknown }): unknown;
      createSpeechService(): unknown;
    };
    actorAccess: unknown;
    actorStore: unknown;
    instanceAccess: unknown;
    assetsService: unknown;
    actorCollaborationApi: unknown;
    serverInformationService: unknown;
    accountModelDefaultsService: unknown;
    threadReadReceiptsService: unknown;
    actorSshKeysService: unknown;
    humanAuth: unknown;
    accountApplication: unknown;
    hubController: unknown;
  }): Promise<EdgeWebServer>;
  /**
   * Opens the listener on `host`:`port`, or with `sshIngress` on a private
   * loopback port behind the ingress; resolves the public address.
   */
  listen(options: {
    host: string;
    port: number;
    sshIngress: ((httpPort: number) => Promise<{ port: number }>) | undefined;
  }): Promise<{ port: number }>;
  /** Shutdown step 2: Web stops accepting and calls `closeEntry` (step 3) in its carrier phase. */
  closeWeb(update: unknown, closeEntry: () => unknown): unknown;
  /** Shutdown step 4. */
  closeRuntimePlugins: EdgeDisposer;
}

export function assembleEdge(): EdgeAssembly;
