// @refresh reset
import { preflightHostConnection } from "@opencraft/workbench-runtime";
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createCordisAppServerRegistry,
  type CordisAppServerRegistryRuntime,
} from "@opencraft/appserver-client";
import {
  AppServerBotDirectory,
  createCordisBotConversationRuntime,
} from "@opencraft/bot-conversation-appserver";
import { createCordisProfileSkillsRuntime } from "@opencraft/profile-skills-appserver";
import type { Context as CordisContext } from "@deepseek-ai/cordis";
import { BlobResourceService } from "@opencraft/blob-resources";
import { ImageProcessingService } from "@opencraft/image-processing";
import { processBrowserImage } from "@opencraft/image-processing/browser";
import { IndexedDbBlobStorage } from "@opencraft/blob-resources/browser";
import {
  installBrowserDynamicToolHandler,
  OPENCRAFT_BROWSER_CAPABILITY,
  OPENCRAFT_BROWSER_DYNAMIC_TOOLS,
  OPENCRAFT_BROWSER_EXTENSION,
  type BrowserDynamicToolHost,
} from "@opencraft/browser-appserver";
import {
  searchAppServerSkills,
  type FuzzyFileSearchSession,
} from "@opencraft/composer-appserver";
import {
  createClientId,
  type ComposerCatalog,
  type ComposerController,
  type ComposerTarget,
  type SubmissionReceipt,
  type ComposerExecutionTarget,
} from "@opencraft/composer-core";
import type {
  Model,
  PermissionProfileSummary,
  Project,
  Thread,
} from "@opencraft/appserver-protocol/generated/v2";
import {
  OPENCRAFT_AGENT_CATALOG_CAPABILITY,
  OPENCRAFT_AGENT_CATALOG_EXTENSION,
  OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION,
  type AgentCatalogEntry,
} from "@opencraft/appserver-protocol";
import {
  type ExtensionContributionStore,
  ExtensionManager,
  ExtensionSettingsStore,
  ExtensionSupervisor,
  provideExtensionInstallationRepository,
} from "@opencraft/extension-runtime";
import {
  ComposerActionRendererRegistry,
  PlatformViewRendererRegistry,
} from "@opencraft/extension-react";
import { SidebarLayoutStore } from "@opencraft/sidebar-layout";
import {
  asHostId,
  createConversationKey,
} from "@opencraft/chat-core";
import {
  createCordisHostConnectionProviderRuntime,
  createAppServerWorkbenchRuntime,
  createConversationActivationCoordinator,
  createConversationScopeLeaseRegistry,
  createConversationScopeRegistry,
  createConversationViewRegistry,
  createWorkbenchSubmissionPipeline,
  draftSubmissionOwnsNavigation,
  createWorkbenchCoordinator,
  createWorkbenchDraftLocation,
  createWorkbenchThreadLocation,
  HostRuntimeRegistry,
  type CordisHostConnectionProviderRuntime,
  type HostConnectionJson,
  type HostConnectionProfile,
  type HostConnectionProviderDescriptor,
  type HostConnectionProfileStore,
  HOST_PROFILE_CONTRIBUTION_CHANNEL,
  type ProvisionHostInput,
  projectAppServerThread,
  type AppServerWorkbenchRuntime,
  type AppServerWorkbenchViewSnapshot,
  type AppServerThreadRuntimeLease,
  type ConversationBindingStore,
  type ConversationActivationCoordinator,
  type ConversationScopeLeaseRegistry,
  type ConversationScopeId,
  type ConversationViewRegistry,
  type ConversationScopeRegistrySnapshot,
  type HostRuntimeDescriptor,
  type HostRuntimeRegistration,
  type ConversationScopeRegistry,
  type WorkbenchCoordinator,
  type WorkbenchLocation,
  type WorkbenchThread,
} from "@opencraft/workbench-runtime";
import {
  createContext,
  type Context,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { parseWorkbenchLocationUrl } from "./workbench-navigation";
import { IndexedDbHostConnectionProfileStore } from "./indexeddb-host-profile-store";
import { IndexedDbExtensionSettingsStorage } from "./indexeddb-extension-settings-storage";
import { IndexedDbExtensionInstallationPersistence } from "./indexeddb-extension-installation-persistence";
import { IndexedDbSidebarLayoutStorage } from "./indexeddb-sidebar-layout-storage";
import { BrowserModuleUrlExtensionLoader } from "./module-url-extension-loader";
import { connectElectronAppHost } from "./electron-app-host";
import {
  BuiltinWebSocketHostConnectionExtension,
  createHostConnectionProviderContributionAdapter,
} from "./websocket-host-connection-provider";

import { BuiltinThemePackExtension } from "./builtin-theme-extension";
import { createPlatformViewRendererContributionAdapter } from "./platform-view-renderers";
import { createComposerActionRendererContributionAdapter } from "./composer-action-renderers";
import { HostProfileContributionRegistry } from "./host-profile-contributions";
import { PlatformAccountContributionRegistry } from "./platform-account-contributions";
import { subscribeHostCatalogReadiness } from "./host-catalog-readiness";
import { connectAppearanceThemeContributions } from "../appearance-theme";
import {
  createWorkbenchNavigationTransaction,
  type WorkbenchHistoryMode,
  type WorkbenchNavigationTransaction,
} from "./workbench-navigation-transaction";

// The Context object itself is part of the renderer's hot-reload state.
export interface AppServerHostCatalog {
  readonly selectedHostId: string;
  readonly hosts: readonly HostRuntimeDescriptor[];
  readonly profiles: readonly HostConnectionProfile[];
  /** Provider-owned navigation metadata projected for Host-scoped chrome. */
  readonly connectionProviders: readonly HostConnectionProviderDescriptor[];
  readonly extensionContributions: ExtensionContributionStore;
  readonly extensionManager: ExtensionManager;
  readonly platformViewRenderers: PlatformViewRendererRegistry;
  readonly platformAccounts: PlatformAccountContributionRegistry;
  readonly composerActionRenderers: ComposerActionRendererRegistry;
  readonly botDirectory: AppServerBotDirectory;
  readonly sidebarLayout: SidebarLayoutStore;
  /**
   * Navigation intent being hydrated. The presented Conversation remains the
   * last committed View until this location is ready, but chrome may reflect
   * the intent immediately.
   */
  readonly pendingLocation: WorkbenchLocation | null;
  readonly currentLocation: WorkbenchLocation;
  selectHost(hostId: string): Promise<void>;
  navigate(location: WorkbenchLocation, mode?: WorkbenchHistoryMode): Promise<boolean>;
  promoteDraft(draftId: string, receipt: SubmissionReceipt): Promise<WorkbenchLocation>;
  openDraft(options: {
    readonly execution: ComposerExecutionTarget;
    readonly entrypoint?: "home" | "new-chat";
    readonly mode?: WorkbenchHistoryMode;
  }): Promise<WorkbenchLocation>;
  submit(intent: Parameters<AppServerWorkbenchRuntime["submit"]>[0]): Promise<SubmissionReceipt>;
  readonly navigation: WorkbenchNavigationTransaction<AppServerWorkbenchRuntime>;
  readonly routeCheckpoints: Map<string, unknown>;
  retargetDraft(draftId: string, execution: ComposerExecutionTarget): void;
  provisionHost(input: ProvisionHostInput): Promise<HostConnectionProfile>;
  addWebSocketHost(input: {
    readonly displayName: string;
    readonly url: string;
    readonly workspaceBrowseRoots?: readonly string[];
  }): Promise<HostConnectionProfile>;
  removeHost(hostId: string): Promise<boolean>;
}

export interface WebWorkbenchCommands {
  selectHost(hostId: string): Promise<void>;
  navigate(location: WorkbenchLocation, mode?: WorkbenchHistoryMode): Promise<boolean>;
  openDraft(options: {
    readonly execution: ComposerExecutionTarget;
    readonly entrypoint?: "home" | "new-chat";
    readonly mode?: WorkbenchHistoryMode;
  }): Promise<WorkbenchLocation>;
  promoteDraft(draftId: string, receipt: SubmissionReceipt): Promise<WorkbenchLocation>;
  retargetDraft(draftId: string, execution: ComposerExecutionTarget): void;
  submit(intent: Parameters<AppServerWorkbenchRuntime["submit"]>[0]): Promise<SubmissionReceipt>;
  provisionHost(input: ProvisionHostInput): Promise<HostConnectionProfile>;
  addWebSocketHost(input: {
    readonly displayName: string;
    readonly url: string;
    readonly workspaceBrowseRoots?: readonly string[];
  }): Promise<HostConnectionProfile>;
  removeHost(hostId: string): Promise<boolean>;
}

interface AppServerApplicationContextValue extends AppServerHostCatalog {
  readonly blobs: BlobResourceService;
  readonly images: ImageProcessingService;
  readonly registry: HostRuntimeRegistry<AppServerWorkbenchRuntime>;
  readonly conversationScopes: ConversationScopeRegistry;
  readonly conversationBindings: ConversationBindingStore;
  readonly extensionSettings: ExtensionSettingsStore;
  readonly extensionContributions: ExtensionContributionStore;
  readonly platformViewRenderers: PlatformViewRendererRegistry;
  readonly platformAccounts: PlatformAccountContributionRegistry;
}

interface ConversationViewRuntimeContextValue {
  readonly runtime: AppServerWorkbenchRuntime;
  readonly activeThreadLease: AppServerThreadRuntimeLease | null;
  readonly composerController: ComposerController;
  readonly scopeId: ConversationScopeId;
  readonly viewId: string;
  readonly activationPhase: "idle" | "resolving" | "ready" | "error";
  readonly activationError: Error | null;
}

const hotApplicationContext = import.meta.hot?.data.applicationRuntimeContext as
  | Context<AppServerApplicationContextValue | null>
  | undefined;
const ApplicationRuntimeContext = hotApplicationContext
  ?? createContext<AppServerApplicationContextValue | null>(null);
const hotConversationViewContext = import.meta.hot?.data.conversationViewRuntimeContext as
  | Context<ConversationViewRuntimeContextValue | null>
  | undefined;
const ConversationViewRuntimeContext = hotConversationViewContext
  ?? createContext<ConversationViewRuntimeContextValue | null>(null);
if (import.meta.hot !== undefined) {
  import.meta.hot.data.applicationRuntimeContext = ApplicationRuntimeContext;
  import.meta.hot.data.conversationViewRuntimeContext = ConversationViewRuntimeContext;
}

function appServerUrl(): string {
  const configured = import.meta.env.VITE_APPSERVER_WS_URL as string | undefined;
  if (configured !== undefined && configured.length > 0) return configured;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/appserver`;
}

function currentWorkbenchPlatform(): "web" | "electron" {
  return (globalThis as typeof globalThis & { opencraftDesktop?: { readonly kind?: string } })
    .opencraftDesktop?.kind === "electron" ? "electron" : "web";
}

interface WebHostDefinition extends HostRuntimeDescriptor {
  readonly url: string;
}

function hostDefinitionProfile(host: WebHostDefinition): HostConnectionProfile {
  return {
    hostId: host.hostId,
    displayName: host.label,
    providerId: "vela.websocket",
    providerConfig: { url: host.url },
    providerConfigVersion: 1,
    hostKind: host.kind,
    enabled: true,
    autoConnect: false,
    includeInSidebar: true,
    credentialRef: null,
    transportEndpoint: host.transportEndpoint,
    executionLocation: host.executionLocation,
    workspaceBrowseRoots: host.workspaceBrowseRoots,
    revision: 0,
  };
}

function profileDescriptor(profile: HostConnectionProfile): HostRuntimeDescriptor {
  return {
    hostId: profile.hostId,
    label: profile.displayName,
    kind: profile.hostKind,
    transportEndpoint: profile.transportEndpoint,
    executionLocation: profile.executionLocation,
    workspaceBrowseRoots: profile.workspaceBrowseRoots,
  };
}

function endpointLabel(url: string): string {
  try {
    return new URL(url, window.location.href).host;
  } catch {
    return url;
  }
}

const hostKinds = new Set<HostRuntimeDescriptor["kind"]>([
  "local",
  "remote-ssh",
  "durable",
  "remote-control",
  "wsl",
]);

export function parseWebHostDefinitions(
  raw: string | undefined,
  fallbackUrl: string,
): readonly WebHostDefinition[] {
  void fallbackUrl;
  if (raw === undefined || raw.trim().length === 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("VITE_APPSERVER_HOSTS_JSON must be valid JSON");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("VITE_APPSERVER_HOSTS_JSON must contain at least one Host");
  }
  const ids = new Set<string>();
  return value.map((candidate, index): WebHostDefinition => {
    if (typeof candidate !== "object" || candidate === null) {
      throw new Error(`Host definition ${index} must be an object`);
    }
    const record = candidate as Record<string, unknown>;
    const hostId = typeof record.hostId === "string" ? record.hostId.trim() : "";
    const label = typeof record.label === "string" ? record.label.trim() : "";
    const url = typeof record.url === "string" ? record.url.trim() : "";
    const kind = record.kind;
    const transportEndpoint = typeof record.transportEndpoint === "string"
      && record.transportEndpoint.trim().length > 0
      ? record.transportEndpoint.trim()
      : endpointLabel(url);
    const executionLocation = typeof record.executionLocation === "string"
      && record.executionLocation.trim().length > 0
      ? record.executionLocation.trim()
      : null;
    const workspaceBrowseRoots = Array.isArray(record.workspaceBrowseRoots)
      ? record.workspaceBrowseRoots.flatMap((root) =>
          typeof root === "string" && root.trim().length > 0 ? [root.trim()] : [])
      : [];
    if (hostId.length === 0 || label.length === 0 || url.length === 0) {
      throw new Error(`Host definition ${index} requires hostId, label and url`);
    }
    const parsedUrl = new URL(url, window.location.href);
    if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
      throw new Error(`Host definition ${hostId} must use ws: or wss:`);
    }
    if (parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
      throw new Error(`Host definition ${hostId} must not embed credentials in its URL`);
    }
    if (ids.has(hostId)) throw new Error(`Duplicate Host definition ${hostId}`);
    ids.add(hostId);
    if (typeof kind !== "string" || !hostKinds.has(kind as HostRuntimeDescriptor["kind"])) {
      throw new Error(`Host definition ${hostId} has an unsupported kind`);
    }
    return {
      hostId,
      label,
      transportEndpoint,
      executionLocation,
      workspaceBrowseRoots,
      url,
      kind: kind as HostRuntimeDescriptor["kind"],
    };
  });
}

export function activeThreadStorageKey(hostId: string): string {
  return currentProductStorageKey(`vela.active-thread-id:${hostId}`);
}

export function selectedProjectStorageKey(hostId: string): string {
  return currentProductStorageKey(`vela.selected-project-id:${hostId}`);
}

/**
 * A browser origin can host more than one OpenCraft product. Product-owned state
 * must not leak Host identities or Replica cursors between those products.
 * Keep the original keys for the generic OpenCraft product; named products get an
 * explicit namespace and intentionally do not migrate legacy state.
 */
const workbenchBuildEnvironment = import.meta.env as ImportMetaEnv | undefined;
const WORKBENCH_PRODUCT_ID = workbenchBuildEnvironment?.VITE_OPENCRAFT_PRODUCT_ID?.trim() || "opencraft";

export function productStorageKey(productId: string, key: string): string {
  return productId === "opencraft" ? key : `${productId}:${key}`;
}

export function productDatabaseName(productId: string, base: string): string {
  return productId === "opencraft" ? base : `${base}-${productId}`;
}

function currentProductStorageKey(key: string): string {
  return productStorageKey(WORKBENCH_PRODUCT_ID, key);
}

function currentProductDatabaseName(base: string): string {
  return productDatabaseName(WORKBENCH_PRODUCT_ID, base);
}

/**
 * Host identity is application-generated and must also work on plain HTTP
 * origins where browsers do not expose Crypto.randomUUID.
 */
export function createWebHostId(createId: () => string = createClientId): string {
  const value = createId().trim();
  if (value.length === 0) throw new Error("Host ID factory returned an empty identity");
  return `host:${value}`;
}

function getHttpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.response?.status;
  return typeof status === "number" ? status : null;
}

function retryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 3) return false;
  const status = getHttpStatus(error);
  return status === null || status === 408 || status === 429 || status >= 500;
}

function createWorkbenchQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: retryQuery,
      },
    },
  });
}

async function disposeOwnedSteps(
  steps: readonly (() => void | Promise<void>)[],
  message: string,
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, message);
}

interface WebWorkbenchApplicationBase {
  readonly blobs: BlobResourceService;
  readonly images: ImageProcessingService;
  readonly cordis: CordisContext;
  readonly appServerRegistry: CordisAppServerRegistryRuntime;
  readonly connectionProviders: CordisHostConnectionProviderRuntime;
  readonly extensions: ExtensionSupervisor;
  readonly extensionManager: ExtensionManager;
  readonly extensionSettings: ExtensionSettingsStore;
  readonly platformViewRenderers: PlatformViewRendererRegistry;
  readonly platformAccounts: PlatformAccountContributionRegistry;
  readonly composerActionRenderers: ComposerActionRendererRegistry;
  readonly botDirectory: AppServerBotDirectory;
  readonly sidebarLayout: SidebarLayoutStore;
  readonly hostProfiles: HostConnectionProfileStore;
  readonly queryClient: QueryClient;
  provisionHost(input: ProvisionHostInput): Promise<HostConnectionProfile>;
  addWebSocketHost(input: {
    readonly displayName: string;
    readonly url: string;
    readonly workspaceBrowseRoots?: readonly string[];
  }): Promise<HostConnectionProfile>;
  removeHost(hostId: string): Promise<boolean>;
  dispose(): Promise<void>;
}

export interface HostlessWebWorkbenchApplicationSupervisor extends WebWorkbenchApplicationBase {
  readonly mode: "hostless";
}

export interface ActiveWebWorkbenchApplicationSupervisor extends WebWorkbenchApplicationBase {
  readonly mode: "active";
  readonly registry: HostRuntimeRegistry<AppServerWorkbenchRuntime>;
  readonly coordinator: WorkbenchCoordinator<AppServerWorkbenchRuntime>;
  readonly conversationActivation: ConversationActivationCoordinator<AppServerWorkbenchRuntime>;
  readonly conversationLeases: ConversationScopeLeaseRegistry;
  readonly conversationViews: ConversationViewRegistry;
  readonly navigation: WorkbenchNavigationTransaction<AppServerWorkbenchRuntime>;
  readonly conversationBindings: ConversationBindingStore;
  readonly conversationScopes: ConversationScopeRegistry;
  readonly initialLocation: WorkbenchLocation;
  /** Remote Host/Thread hydration started after the initial local View commit. */
  readonly initialActivation: Promise<boolean>;
  readonly routeCheckpoints: Map<string, unknown>;
  readonly commands: WebWorkbenchCommands;
}

export type WebWorkbenchApplicationSupervisor =
  | HostlessWebWorkbenchApplicationSupervisor
  | ActiveWebWorkbenchApplicationSupervisor;

function setLocalPreference(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Preferences cannot make an already committed application transaction fail.
  }
}

async function persistProvisionedHost(
  host: ProvisionHostInput,
  hostProfiles: HostConnectionProfileStore,
  connectionProviders: CordisHostConnectionProviderRuntime["providers"],
  reservedHostIds: readonly string[] = [],
): Promise<HostConnectionProfile> {
  const displayName = host.displayName.trim();
  if (displayName.length === 0) throw new RangeError("Host display name must not be empty");
  const hostId = host.hostId?.trim() || createWebHostId();
  if (reservedHostIds.includes(hostId)
    || hostProfiles.getSnapshot().profiles.some((profile) => profile.hostId === hostId)) {
    throw new Error(`Host ${hostId} is already provisioned`);
  }
  const roots = [...new Set((host.workspaceBrowseRoots ?? [])
    .map((root) => root.trim()).filter(Boolean))];
  const providerId = host.providerId.trim();
  if (providerId.length === 0) throw new RangeError("Host provider ID must not be empty");
  const platform = currentWorkbenchPlatform();
  const providerLease = connectionProviders.acquire(providerId, platform);
  let providerConfig: HostConnectionProfile["providerConfig"];
  let providerConfigVersion: number;
  try {
    providerConfigVersion = providerLease.provider.configVersion;
    providerConfig = providerLease.provider.validate(host.providerConfig, {
      platform,
      hostId,
      profileRevision: 0,
    });
    await preflightHostConnection(providerLease.provider, providerConfig, {
      platform, hostId, profileRevision: 0,
    });
  } finally {
    providerLease.release();
  }
  const profile: HostConnectionProfile = {
    hostId,
    displayName,
    providerId,
    providerConfig,
    providerConfigVersion,
    hostKind: host.hostKind ?? "remote-control",
    enabled: true,
    autoConnect: host.autoConnect ?? false,
    includeInSidebar: host.includeInSidebar ?? true,
    credentialRef: host.credentialRef ?? null,
    transportEndpoint: host.transportEndpoint ?? null,
    executionLocation: host.executionLocation ?? null,
    workspaceBrowseRoots: roots,
    revision: 0,
  };
  await hostProfiles.put(profile);
  return profile;
}

function provisionWebSocketHost(
  host: {
    readonly displayName: string;
    readonly url: string;
    readonly workspaceBrowseRoots?: readonly string[];
  },
  provisionHost: (input: ProvisionHostInput) => Promise<HostConnectionProfile>,
): Promise<HostConnectionProfile> {
  const url = host.url.trim();
  const parsedUrl = new URL(url);
  return provisionHost({
    displayName: host.displayName,
    providerId: "vela.websocket",
    providerConfig: { url },
    hostKind: "remote-control",
    transportEndpoint: endpointLabel(url),
    executionLocation: parsedUrl.host,
    workspaceBrowseRoots: host.workspaceBrowseRoots,
  });
}

function createWebWorkbenchCommands(input: {
  readonly registry: HostRuntimeRegistry<AppServerWorkbenchRuntime>;
  readonly coordinator: WorkbenchCoordinator<AppServerWorkbenchRuntime>;
  readonly activation: ConversationActivationCoordinator<AppServerWorkbenchRuntime>;
  readonly scopes: ConversationScopeRegistry;
  readonly navigation: WorkbenchNavigationTransaction<AppServerWorkbenchRuntime>;
  readonly queryClient: QueryClient;
  readonly hostProfiles: HostConnectionProfileStore;
  readonly createHostRegistration: (
    profile: HostConnectionProfile,
  ) => HostRuntimeRegistration<AppServerWorkbenchRuntime>;
  readonly connectionProviders: CordisHostConnectionProviderRuntime["providers"];
}): WebWorkbenchCommands {
  let commands: WebWorkbenchCommands;
  let submissionPipeline: ReturnType<typeof createWorkbenchSubmissionPipeline>;
  commands = {
    async selectHost(hostId) {
      const activeDraft = input.scopes.getActiveDraft();
      if (activeDraft !== null && draftSubmissionOwnsNavigation(activeDraft.phase)) {
        throw new Error("The execution node cannot change while the first turn is being submitted");
      }
      await input.registry.ensureConnected(hostId);
      if (activeDraft !== null && activeDraft.target.execution.hostId !== hostId) {
        const nextDraft = input.scopes.openDraft({
          entrypoint: activeDraft.entrypoint,
          execution: {
            hostId: asHostId(hostId),
            workspace: (() => {
              const root = input.registry.getSnapshot().hosts
                .find((host) => host.hostId === hostId)?.workspaceBrowseRoots[0] ?? null;
              return { cwd: root, runtimeWorkspaceRoots: root === null ? [] : [root] };
            })(),
          },
        });
        try {
          const activated = await input.navigation.navigate(
            createWorkbenchDraftLocation(hostId, nextDraft.id),
            "replace",
          );
          if (!activated) throw new Error(`Host ${hostId} Draft activation was superseded`);
          input.scopes.dismissDraft(activeDraft.id);
        } catch (error) {
          input.scopes.dismissDraft(nextDraft.id);
          input.scopes.activateDraft(activeDraft.id);
          throw error;
        }
      }
      input.coordinator.setSelectedHostId(hostId);
      setLocalPreference(currentProductStorageKey("vela.active-host-id"), hostId);
    },
    async navigate(location, mode = "push") {
      const hostId = location.kind === "thread" ? location.key.hostId : location.hostId;
      const activated = await input.navigation.navigate(location, mode);
      if (!activated) return false;
      setLocalPreference(currentProductStorageKey("vela.active-host-id"), hostId);
      setLocalPreference(
        activeThreadStorageKey(hostId),
        location.kind === "thread" ? location.key.threadId : null,
      );
      return true;
    },
    async openDraft(options) {
      const draft = input.scopes.openDraft({
        execution: options.execution,
        entrypoint: options.entrypoint,
      });
      const location = createWorkbenchDraftLocation(options.execution.hostId, draft.id);
      try {
        const activated = await commands.navigate(location, options.mode);
        if (!activated) throw new Error(`Draft ${draft.id} activation was superseded`);
        return location;
      } catch (error) {
        input.scopes.dismissDraft(draft.id);
        throw error;
      }
    },
    async promoteDraft(draftId, receipt) {
      const location = await input.navigation.promoteDraft(draftId, receipt);
      setLocalPreference(activeThreadStorageKey(receipt.hostId), receipt.threadId);
      setLocalPreference(currentProductStorageKey("vela.active-host-id"), receipt.hostId);
      return location;
    },
    retargetDraft(draftId, execution) {
      input.activation.retargetDraft(draftId, execution);
    },
    async submit(intent) {
      return submissionPipeline.submit(intent);
    },
    async provisionHost(host) {
      const profile = await persistProvisionedHost(
        host,
        input.hostProfiles,
        input.connectionProviders,
        input.registry.getSnapshot().hosts.map(({ hostId }) => hostId),
      );
      try {
        input.registry.register(input.createHostRegistration(profile));
      } catch (error) {
        await input.hostProfiles.remove(profile.hostId).catch(() => undefined);
        throw error;
      }
      return profile;
    },
    async addWebSocketHost(host) {
      return provisionWebSocketHost(host, commands.provisionHost);
    },
    async removeHost(hostId) {
      const coordinator = input.coordinator.getSnapshot();
      const location = coordinator.location;
      const activeHostId = location.kind === "thread" ? location.key.hostId : location.hostId;
      if (activeHostId === hostId) {
        throw new Error("The active Host cannot be removed");
      }
      const pendingHostId = coordinator.pendingLocation === null
        ? null
        : coordinator.pendingLocation.kind === "thread"
          ? coordinator.pendingLocation.key.hostId
          : coordinator.pendingLocation.hostId;
      if (pendingHostId === hostId) {
        throw new Error("A Host cannot be removed while navigation is activating it");
      }
      if (input.registry.getSnapshot().hosts.length <= 1) {
        throw new Error("The last Host cannot be removed");
      }
      const existingRuntime = input.registry.peekRuntime(hostId);
      const busyThread = existingRuntime?.getSnapshot().residentThreads.find((thread) =>
        thread.viewLeaseCount > 0
        || thread.subscriberCount > 0
        || thread.pendingCommandCount > 0
        || thread.activeStreamCount > 0
        || thread.pendingInteractionCount > 0
        || thread.hydrating
        || thread.phase === "preparing"
        || thread.phase === "hydrating"
        || thread.phase === "reconnecting"
        || thread.phase === "disposing");
      if (busyThread !== undefined) {
        throw new Error(
          `Host ${hostId} still owns active Thread work (${busyThread.threadId}); `
          + "close its Views or stop the work before removing it",
        );
      }
      // Detach and dispose the runtime before deleting its durable profile. A
      // profile is recoverable configuration; a live orphan connection is not.
      // Once detached, durable removal still proceeds if transport disposal
      // reports an error, otherwise refresh would resurrect a half-removed Host.
      if (!input.registry.has(hostId)) return false;
      let disposalFailure: unknown = null;
      try {
        await input.registry.remove(hostId);
      } catch (error) {
        disposalFailure = error;
      }
      let persistenceFailure: unknown = null;
      try {
        await input.hostProfiles.remove(hostId);
      } catch (error) {
        persistenceFailure = error;
      }
      input.queryClient.removeQueries({ queryKey: ["appserver", hostId] });
      if (disposalFailure !== null || persistenceFailure !== null) {
        throw new AggregateError(
          [disposalFailure, persistenceFailure].filter((error) => error !== null),
          `Host ${hostId} was detached but cleanup did not complete cleanly`,
        );
      }
      return true;
    },
  };
  submissionPipeline = createWorkbenchSubmissionPipeline({
    scopes: input.scopes,
    submitNewThread(intent) {
      if (intent.target.type !== "new-thread") throw new Error("Expected a New Thread intent");
      return input.registry.getRuntime(intent.target.execution.hostId).createThread(intent);
    },
    submitExistingThread(intent) {
      const lease = input.coordinator.getActiveThreadLease();
      if (lease === null) return Promise.reject(new Error("No active Thread View is available"));
      return lease.submit(intent);
    },
    submitFirstTurn(intent, threadReceipt) {
      const lease = input.coordinator.getActiveThreadLease();
      if (lease === null || lease.threadId !== threadReceipt.threadId) {
        return Promise.reject(new Error("Promoted Thread View does not own its first Turn"));
      }
      return lease.submit({
        ...intent,
        target: {
          type: "existing-thread",
          key: createConversationKey(threadReceipt.hostId, threadReceipt.threadId),
        },
      });
    },
    async promoteDraft(draftId, receipt) {
      await commands.promoteDraft(draftId, receipt);
    },
    async afterAccepted(receipt) {
      await input.queryClient.invalidateQueries({
        queryKey: ["appserver", receipt.hostId, "threads"],
      });
    },
  });
  return commands;
}

class BoundedCheckpointMap extends Map<string, unknown> {
  constructor(private readonly capacity: number) {
    super();
  }

  override set(key: string, value: unknown): this {
    super.delete(key);
    super.set(key, value);
    while (this.size > this.capacity) {
      const oldest = this.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      super.delete(oldest);
    }
    return this;
  }
}

/**
 * Renderer application graph constructed before React. React consumes its
 * external stores; it does not own AppServer links or Host lifetimes.
 */
export async function createWebWorkbenchApplicationSupervisor(
  browserToolHost: BrowserDynamicToolHost,
  conversationBindings: ConversationBindingStore,
  cordis: CordisContext,
  disposeScopeResources: (scopeId: string) => void = () => undefined,
  disposeViewResources: (viewId: string) => void = () => undefined,
): Promise<WebWorkbenchApplicationSupervisor> {
  const startupRollback: Array<() => void | Promise<void>> = [];
  try {
    const blobFiber = cordis.plugin(BlobResourceService, { storage: new IndexedDbBlobStorage() });
    startupRollback.push(() => blobFiber.dispose());
    await blobFiber;
    const blobs = cordis.blobResources;
    const imageFiber = cordis.plugin(ImageProcessingService, { process: processBrowserImage });
    startupRollback.push(() => imageFiber.dispose());
    await imageFiber;
    const images = cordis.imageProcessing;
    const appServerRegistry = await createCordisAppServerRegistry(cordis);
    startupRollback.push(() => appServerRegistry.dispose());
    const botConversations = await createCordisBotConversationRuntime(cordis);
    startupRollback.push(() => botConversations.dispose());
    const profileSkills = await createCordisProfileSkillsRuntime(cordis);
    startupRollback.push(() => profileSkills.dispose());
    const botDirectory = new AppServerBotDirectory(
      botConversations.service,
      appServerRegistry.clients,
    );
    startupRollback.push(() => botDirectory.dispose());
    const connectionProviders = await createCordisHostConnectionProviderRuntime(cordis);
    startupRollback.push(() => connectionProviders.dispose());
    const hostConnectionProviderAdapter = createHostConnectionProviderContributionAdapter(
      connectionProviders.providers,
    );
    const hostProfileContributions = new HostProfileContributionRegistry();
    const platformViewRenderers = new PlatformViewRendererRegistry();
    const platformAccounts = new PlatformAccountContributionRegistry();
    const composerActionRenderers = new ComposerActionRendererRegistry();
    const platform = currentWorkbenchPlatform();
    const electronAppHost = platform === "electron" ? connectElectronAppHost() : null;
    if (electronAppHost !== null) startupRollback.push(() => electronAppHost.close());
    const extensions = new ExtensionSupervisor({
      context: cordis,
      platform,
      internalContributions: {
        hostConnectionProvider: hostConnectionProviderAdapter,
        [HOST_PROFILE_CONTRIBUTION_CHANNEL]: hostProfileContributions.createAdapter(),
        platformViewRenderer: createPlatformViewRendererContributionAdapter(platformViewRenderers),
        platformAccount: platformAccounts.createAdapter(),
        composerActionRenderer: createComposerActionRendererContributionAdapter(composerActionRenderers),
      },
    });
    startupRollback.push(() => extensions.dispose());
    const extensionSettingsStorage = await IndexedDbExtensionSettingsStorage.open({
      databaseName: currentProductDatabaseName("vela-extension-settings"),
    });
    const extensionSettings = await ExtensionSettingsStore.open(
      extensions.contributions,
      extensionSettingsStorage,
    );
    startupRollback.push(() => extensionSettings.close());
    const sidebarLayoutStorage = await IndexedDbSidebarLayoutStorage.open({
      databaseName: currentProductDatabaseName("vela-sidebar-layout-v2"),
    });
    const sidebarLayout = await SidebarLayoutStore.open(sidebarLayoutStorage);
    startupRollback.push(() => sidebarLayout.close());
    await extensions.activate(BuiltinWebSocketHostConnectionExtension);
    await extensions.activate(BuiltinThemePackExtension);
    const createVoiceInputExtension = (
      await import("@opencraft/plugin-voice-input/runtime-entry")
    ).default;
    await extensions.activate(createVoiceInputExtension());
    if (import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN === "true") {
      const { createBuiltinAgentsExtension } = await import("@opencraft/plugin-builtin-agents");
      await extensions.activate(createBuiltinAgentsExtension({
        createTransport: (hostId) => {
          if (electronAppHost === null) throw new Error("Electron App Host is unavailable");
          return electronAppHost.createTransport(hostId);
        },
        requestHost: (hostId, method, params) => appServerRegistry.clients
          .getOrThrow(hostId)
          .request(method, params),
      }));
    }
    // Keep this expression direct: Vite can erase the entire dynamic-import
    // edge from product builds instead of merely disabling it at runtime.
    if (import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN !== "false") {
      const { createHyperNodeExtension } = await import("@opencraft/plugin-hypernode");
      await extensions.activate(createHyperNodeExtension({ url: appServerUrl() }));
    }
    const createLightVelaHermesExtension = (
      await import("@opencraft/plugin-lightvela-hermes/runtime-entry")
    ).default;
    await extensions.activate(createLightVelaHermesExtension({
      profileSkills: profileSkills.service,
      appServerClients: appServerRegistry.clients,
    }));
    const extensionInstallationPersistence = await IndexedDbExtensionInstallationPersistence.open({
      databaseName: currentProductDatabaseName("vela-extension-installations"),
    });
    const extensionInstallationFiber = cordis.plugin(
      provideExtensionInstallationRepository(extensionInstallationPersistence),
    );
    await extensionInstallationFiber;
    startupRollback.push(() => extensionInstallationFiber.dispose());
    const extensionManager = new ExtensionManager({
      installations: cordis.extensionInstallations,
      loader: new BrowserModuleUrlExtensionLoader(),
      supervisor: extensions,
    });
    await extensionManager.restore();
    startupRollback.push(() => extensionManager.dispose());
    const disconnectAppearanceThemes = connectAppearanceThemeContributions(
      extensions.contributions,
    );
    startupRollback.push(disconnectAppearanceThemes);
    const queryClient = createWorkbenchQueryClient();
    startupRollback.push(() => queryClient.clear());
    const routeCheckpoints = new BoundedCheckpointMap(32);
    const requestedBootstrapLocation = parseWorkbenchLocationUrl(new URL(window.location.href));
    const bootstrapDefinitions = parseWebHostDefinitions(
    import.meta.env.VITE_APPSERVER_HOSTS_JSON as string | undefined,
    appServerUrl(),
  );
  const hostProfiles = await IndexedDbHostConnectionProfileStore.open({
    databaseName: currentProductDatabaseName("vela-host-connections"),
    seed: bootstrapDefinitions.map(hostDefinitionProfile),
    ephemeral: hostProfileContributions.list(),
  });
  startupRollback.push(() => hostProfiles.close());
  const profiles = hostProfiles.getSnapshot().profiles.filter((profile) => profile.enabled);
  if (profiles.length === 0) {
    const provisionHost = (input: ProvisionHostInput) => persistProvisionedHost(
      input,
      hostProfiles,
      connectionProviders.providers,
    );
    const hostless: HostlessWebWorkbenchApplicationSupervisor = {
      blobs,
      images,
      mode: "hostless",
      cordis,
      appServerRegistry,
      connectionProviders,
      extensions,
      extensionManager,
      extensionSettings,
      platformViewRenderers,
      platformAccounts,
      composerActionRenderers,
      botDirectory,
      sidebarLayout,
      hostProfiles,
      queryClient,
      provisionHost,
      addWebSocketHost: (input) => provisionWebSocketHost(input, provisionHost),
      removeHost: (hostId) => hostProfiles.remove(hostId),
      async dispose() {
        await disposeOwnedSteps([
          () => conversationBindings.dispose(),
          () => hostProfiles.close(),
          () => queryClient.clear(),
          () => extensionManager.dispose(),
          () => extensionSettings.close(),
          () => sidebarLayout.close(),
          () => extensionInstallationFiber.dispose(),
          () => extensions.dispose(),
          disconnectAppearanceThemes,
          () => botDirectory.dispose(),
          () => profileSkills.dispose(),
          () => botConversations.dispose(),
          () => appServerRegistry.dispose(),
          () => electronAppHost?.close(),
          () => connectionProviders.dispose(),
          () => blobFiber.dispose(),
          () => imageFiber.dispose(),
        ], "Failed to dispose hostless Web Workbench supervisor");
      },
    };
    startupRollback.length = 0;
    return hostless;
  }
  const bootstrapLocation = requestedBootstrapLocation !== null
    && profiles.some((profile) => profile.hostId === (
      requestedBootstrapLocation.kind === "thread"
        ? requestedBootstrapLocation.key.hostId
        : requestedBootstrapLocation.hostId
    ))
    ? requestedBootstrapLocation
    : null;
  const persistedHostId = window.localStorage.getItem(currentProductStorageKey("vela.active-host-id"));
  const requestedHostId = bootstrapLocation?.kind === "thread"
    ? bootstrapLocation.key.hostId
    : bootstrapLocation?.hostId;
  const initialHostId = requestedHostId !== undefined
    && profiles.some((host) => host.hostId === requestedHostId)
    ? requestedHostId
    : profiles.some((host) => host.hostId === persistedHostId)
      ? persistedHostId!
      : profiles[0]!.hostId;
  const initialWorkspaceRoot = profiles.find((host) => host.hostId === initialHostId)
    ?.workspaceBrowseRoots[0] ?? null;
  const createHostRegistration = (
    profile: HostConnectionProfile,
  ): HostRuntimeRegistration<AppServerWorkbenchRuntime> => ({
    descriptor: profileDescriptor(profile),
    createRuntime: () => {
      const providerLease = connectionProviders.providers.acquire(profile.providerId, platform);
      let runtime: AppServerWorkbenchRuntime;
      try {
        if (providerLease.provider.configVersion !== profile.providerConfigVersion) {
          throw new Error(
            `Host ${profile.hostId} requires ${profile.providerId} config v${profile.providerConfigVersion}, `
            + `but v${providerLease.provider.configVersion} is installed`,
          );
        }
        const providerContext = {
          platform,
          hostId: profile.hostId,
          profileRevision: profile.revision,
        };
        const normalizedConfig = providerLease.provider.validate(profile.providerConfig, providerContext);
        const transport = providerLease.provider.createTransport(normalizedConfig, providerContext);
        runtime = createAppServerWorkbenchRuntime({
        hostId: profile.hostId,
        hostKind: profile.hostKind,
        transport,
        autoReconnect: true,
        initialize: {
          clientInfo: { name: "opencraft-workbench", version: "0.1.0" },
          capabilities: {
            experimentalApi: true,
            extensions: {
              [OPENCRAFT_BROWSER_EXTENSION]: OPENCRAFT_BROWSER_CAPABILITY,
              [OPENCRAFT_AGENT_CATALOG_EXTENSION]: OPENCRAFT_AGENT_CATALOG_CAPABILITY,
            },
          },
        },
        dynamicTools: OPENCRAFT_BROWSER_DYNAMIC_TOOLS,
        clientRegistry: appServerRegistry.clients,
        installClientHandlers: (client) =>
          installBrowserDynamicToolHandler(client, browserToolHost, { hostId: profile.hostId }),
        });
      } catch (error) {
        providerLease.release();
        throw error;
      }
      let disposed = false;
      return {
        ...runtime,
        async dispose() {
          if (disposed) return;
          disposed = true;
          try {
            await runtime.dispose();
          } finally {
            providerLease.release();
          }
        },
      };
    },
  });
  const registrations = profiles.map(createHostRegistration);
  const registry = new HostRuntimeRegistry(registrations);
  startupRollback.push(() => registry.dispose());
  const active = registry.getRuntime(initialHostId).getSnapshot();
  const persistedThreadId = window.localStorage.getItem(activeThreadStorageKey(initialHostId))
    ?? window.localStorage.getItem(currentProductStorageKey("vela.active-thread-id"));
  const initialThreadLocation = bootstrapLocation?.kind === "thread"
    ? bootstrapLocation
    : bootstrapLocation === null && persistedThreadId !== null
      ? createWorkbenchThreadLocation(initialHostId, persistedThreadId)
      : null;
  const conversationScopes = createConversationScopeRegistry({
    initialDraft: bootstrapLocation?.kind === "draft"
      && bootstrapLocation.hostId === active.hostId
      ? {
          draftId: bootstrapLocation.draftId,
          entrypoint: "home",
          execution: {
            hostId: active.hostId,
            workspace: {
              cwd: initialWorkspaceRoot,
              runtimeWorkspaceRoots: initialWorkspaceRoot === null ? [] : [initialWorkspaceRoot],
            },
          },
        }
      : initialThreadLocation === null
        ? {
            entrypoint: "home",
            execution: {
              hostId: active.hostId,
              workspace: {
                cwd: initialWorkspaceRoot,
                runtimeWorkspaceRoots: initialWorkspaceRoot === null ? [] : [initialWorkspaceRoot],
              },
            },
          }
        : null,
  });
  startupRollback.push(() => conversationScopes.dispose());
  const draft = conversationScopes.getActiveDraft();
  const initialLocation = bootstrapLocation
    ?? (initialThreadLocation !== null
      ? initialThreadLocation
      : draft !== null
        ? createWorkbenchDraftLocation(active.hostId, draft.id)
        : null);
  if (initialLocation === null) throw new Error("Workbench has no initial Conversation identity");
  const coordinator = createWorkbenchCoordinator(registry, initialLocation, initialHostId);
  startupRollback.push(() => coordinator.dispose());
  const conversationLeases = createConversationScopeLeaseRegistry({
    onDisposeScope(scopeId) {
      disposeScopeResources(scopeId);
    },
  });
  startupRollback.push(() => conversationLeases.dispose());
  const conversationViews = createConversationViewRegistry({
    scopeLeases: conversationLeases,
    composerServices: { now: Date.now, createId: createClientId },
    onDisposeView(viewId) {
      disposeViewResources(viewId);
      routeCheckpoints.delete(viewId);
    },
  });
  startupRollback.push(() => conversationViews.dispose());
  const conversationActivation = createConversationActivationCoordinator(
    coordinator,
    conversationBindings,
    conversationScopes,
    conversationLeases,
    conversationViews,
  );
  startupRollback.push(() => conversationActivation.dispose());
  const navigation = createWorkbenchNavigationTransaction(initialLocation, conversationActivation, conversationScopes);
  startupRollback.push(() => navigation.dispose());
  // Browser startup owns only local identity construction. Physical Host
  // connection and Thread hydration continue after the shell can render.
  const initialActivation = conversationActivation.presentInitial(
    initialLocation,
    navigation.getSnapshot().routeScopeId,
  );
  const commands = createWebWorkbenchCommands({
    registry,
    coordinator,
    activation: conversationActivation,
    scopes: conversationScopes,
    navigation,
    queryClient,
    hostProfiles,
    createHostRegistration,
    connectionProviders: connectionProviders.providers,
  });
  const supervisor: WebWorkbenchApplicationSupervisor = {
    blobs,
    images,
    mode: "active",
    cordis,
    appServerRegistry,
    connectionProviders,
    extensions,
    extensionManager,
    extensionSettings,
    platformViewRenderers,
    platformAccounts,
    composerActionRenderers,
    botDirectory,
    sidebarLayout,
    hostProfiles,
    registry,
    coordinator,
    conversationActivation,
    conversationLeases,
    conversationViews,
    navigation,
    conversationBindings,
    conversationScopes,
    initialLocation,
    initialActivation,
    queryClient,
    routeCheckpoints,
    commands,
    provisionHost: commands.provisionHost,
    addWebSocketHost: commands.addWebSocketHost,
    removeHost: commands.removeHost,
    async dispose() {
      await disposeOwnedSteps([
        () => navigation.dispose(),
        () => conversationActivation.dispose(),
        () => conversationViews.dispose(),
        () => conversationLeases.dispose(),
        () => conversationScopes.dispose(),
        () => conversationBindings.dispose(),
        () => coordinator.dispose(),
        () => registry.dispose(),
        () => electronAppHost?.close(),
        () => hostProfiles.close(),
        () => queryClient.clear(),
        () => extensionManager.dispose(),
        () => extensionSettings.close(),
        () => sidebarLayout.close(),
        () => extensionInstallationFiber.dispose(),
        () => extensions.dispose(),
        disconnectAppearanceThemes,
        () => botDirectory.dispose(),
        () => profileSkills.dispose(),
        () => botConversations.dispose(),
        () => appServerRegistry.dispose(),
        () => connectionProviders.dispose(),
        () => blobFiber.dispose(),
        () => imageFiber.dispose(),
      ], "Failed to dispose Web Workbench supervisor");
    },
  };
  // Ownership transfers atomically only after the complete graph exists.
  // Before this point the rollback stack remains the sole owner.
  startupRollback.length = 0;
  return supervisor;
  } catch (error) {
    try {
      await disposeOwnedSteps(
        [...startupRollback].reverse(),
        "Failed to roll back Web Workbench startup",
      );
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Web Workbench startup failed and rollback was incomplete",
      );
    }
    throw error;
  }
}

export function AppServerRuntimeProvider({
  supervisor,
  children,
}: {
  readonly supervisor: ActiveWebWorkbenchApplicationSupervisor;
  readonly children: ReactNode;
}) {
  const {
    registry,
    coordinator,
    conversationBindings,
    conversationScopes,
    conversationActivation,
    conversationLeases,
    conversationViews,
    navigation,
    queryClient,
    routeCheckpoints,
    commands,
    hostProfiles,
    extensionSettings,
    extensionManager,
    extensions,
    platformViewRenderers,
    platformAccounts,
    composerActionRenderers,
    botDirectory,
    sidebarLayout,
  } = supervisor;
  const registrySnapshot = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  );
  const coordinatorSnapshot = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getSnapshot,
    coordinator.getSnapshot,
  );
  const hostProfileSnapshot = useSyncExternalStore(
    hostProfiles.subscribe,
    hostProfiles.getSnapshot,
    hostProfiles.getSnapshot,
  );
  const connectionProviderSnapshot = useSyncExternalStore(
    supervisor.connectionProviders.providers.subscribe,
    supervisor.connectionProviders.providers.getSnapshot,
    supervisor.connectionProviders.providers.getSnapshot,
  );
  const runtime = coordinator.getRuntime();
  const activeThreadLease = coordinator.getActiveThreadLease();
  const activeConversationScopeId = conversationActivation.scopeIdFor(coordinatorSnapshot.location);
  const activeConversationViewId = coordinatorSnapshot.viewId;
  if (activeConversationViewId === null) throw new Error("Active Conversation View has no identity");
  const conversationView = conversationViews.get(activeConversationViewId);
  if (conversationView === null || conversationView.scopeId !== activeConversationScopeId) {
    throw new Error(`Conversation View ${activeConversationViewId} is unavailable`);
  }
  const composerController = conversationView.composer;
  const applicationContextValue = useMemo<AppServerApplicationContextValue>(() => ({
    blobs: supervisor.blobs,
    images: supervisor.images,
    conversationScopes,
    conversationBindings,
    extensionSettings,
    extensionManager,
    extensionContributions: extensions.contributions,
    platformViewRenderers,
    platformAccounts,
    composerActionRenderers,
    botDirectory,
    sidebarLayout,
    registry,
    navigation,
    routeCheckpoints,
    retargetDraft: commands.retargetDraft,
    selectedHostId: coordinatorSnapshot.selectedHostId,
    pendingLocation: coordinatorSnapshot.pendingLocation,
    currentLocation: coordinatorSnapshot.location,
    hosts: registrySnapshot.hosts,
    profiles: hostProfileSnapshot.profiles,
    connectionProviders: connectionProviderSnapshot.providers,
    selectHost: commands.selectHost,
    navigate: commands.navigate,
    openDraft: commands.openDraft,
    promoteDraft: commands.promoteDraft,
    submit: commands.submit,
    provisionHost: commands.provisionHost,
    addWebSocketHost: commands.addWebSocketHost,
    removeHost: commands.removeHost,
  }), [
    supervisor.blobs,
    supervisor.images,
    conversationBindings,
    extensionSettings,
    extensionManager,
    registry,
    coordinatorSnapshot.pendingLocation,
    coordinatorSnapshot.location,
    coordinatorSnapshot.selectedHostId,
    conversationScopes,
    commands,
    registrySnapshot.hosts,
    hostProfileSnapshot.profiles,
    connectionProviderSnapshot.providers,
    navigation,
  ]);
  const viewContextValue = useMemo<ConversationViewRuntimeContextValue>(() => ({
    runtime,
    activeThreadLease,
    composerController,
    scopeId: activeConversationScopeId,
    viewId: activeConversationViewId,
    activationPhase: coordinatorSnapshot.phase,
    activationError: coordinatorSnapshot.error,
  }), [
    coordinatorSnapshot.error,
    coordinatorSnapshot.phase,
    activeConversationScopeId,
    activeConversationViewId,
    activeThreadLease,
    composerController,
    runtime,
  ]);

  return (
    <QueryClientProvider client={queryClient}>
      <ApplicationRuntimeContext.Provider value={applicationContextValue}>
        <ConversationViewRuntimeContext.Provider value={viewContextValue}>
          {children}
        </ConversationViewRuntimeContext.Provider>
      </ApplicationRuntimeContext.Provider>
    </QueryClientProvider>
  );
}

export function useBlobResources(): BlobResourceService {
  const context = useContext(ApplicationRuntimeContext);
  if (!context) throw new Error("Blob resources require the application provider");
  return context.blobs;
}

export function useImageProcessing(): ImageProcessingService {
  const context = useContext(ApplicationRuntimeContext);
  if (context === null) throw new Error("AppServer runtime is unavailable");
  return context.images;
}

export function useAppServerRuntime(): AppServerWorkbenchRuntime {
  const value = useContext(ConversationViewRuntimeContext);
  if (value === null) throw new Error("ConversationViewRuntimeProvider is missing");
  return value.runtime;
}

export function useActiveAppServerThread(): AppServerThreadRuntimeLease | null {
  const value = useContext(ConversationViewRuntimeContext);
  if (value === null) throw new Error("ConversationViewRuntimeProvider is missing");
  return value.activeThreadLease;
}

export function useAppServerHosts(): AppServerHostCatalog {
  const value = useContext(ApplicationRuntimeContext);
  if (value === null) throw new Error("AppServerRuntimeProvider is missing");
  return value;
}

/** Observe one Host, independently of the currently presented conversation. */
export function useHostConnectionPhase(hostId: string) {
  const application = useContext(ApplicationRuntimeContext);
  if (application === null) throw new Error("AppServerRuntimeProvider is missing");
  const registry = application.registry;
  return useSyncExternalStore(
    (listener) => {
      let runtime = registry.peekRuntime(hostId);
      let unsubscribe = runtime?.subscribe(listener);
      const removeRegistry = registry.subscribe(() => {
        const next = registry.peekRuntime(hostId);
        if (next !== runtime) {
          unsubscribe?.();
          runtime = next;
          unsubscribe = runtime?.subscribe(listener);
        }
        listener();
      });
      return () => { removeRegistry(); unsubscribe?.(); };
    },
    () => registry.peekRuntime(hostId)?.getSnapshot().phase ?? "idle",
    () => "idle",
  );
}

export function useConversationScopeRegistry(): ConversationScopeRegistry {
  const value = useContext(ApplicationRuntimeContext);
  if (value === null) throw new Error("AppServerRuntimeProvider is missing");
  return value.conversationScopes;
}

export function useConversationBindingStore(): ConversationBindingStore {
  const value = useContext(ApplicationRuntimeContext);
  if (value === null) throw new Error("AppServerRuntimeProvider is missing");
  return value.conversationBindings;
}

export function useExtensionSettingsStore(): ExtensionSettingsStore {
  const value = useContext(ApplicationRuntimeContext);
  if (value === null) throw new Error("AppServerRuntimeProvider is missing");
  return value.extensionSettings;
}

export function useConversationScopeRegistrySnapshot(): ConversationScopeRegistrySnapshot {
  const session = useConversationScopeRegistry();
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}

export function useRootComposerController(): ComposerController {
  const value = useContext(ConversationViewRuntimeContext);
  if (value === null) throw new Error("ConversationViewRuntimeProvider is missing");
  return value.composerController;
}

export function useConversationViewIdentity(): {
  readonly scopeId: ConversationScopeId;
  readonly viewId: string;
} {
  const value = useContext(ConversationViewRuntimeContext);
  if (value === null) throw new Error("ConversationViewRuntimeProvider is missing");
  return useMemo(() => ({ scopeId: value.scopeId, viewId: value.viewId }), [
    value.scopeId,
    value.viewId,
  ]);
}

export function useConversationViewActivation(): {
  readonly phase: "idle" | "resolving" | "ready" | "error";
  readonly error: Error | null;
} {
  const value = useContext(ConversationViewRuntimeContext);
  if (value === null) throw new Error("ConversationViewRuntimeProvider is missing");
  return useMemo(() => ({
    phase: value.activationPhase,
    error: value.activationError,
  }), [value.activationError, value.activationPhase]);
}

export function useAppServerSnapshot(): AppServerWorkbenchViewSnapshot {
  const runtime = useAppServerRuntime();
  const activeThreadLease = useActiveAppServerThread();
  const hostSnapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const getConversationSnapshot = activeThreadLease === null
    ? () => null
    : activeThreadLease.getSnapshot;
  const subscribeConversation = activeThreadLease === null
    ? (_listener: () => void) => () => undefined
    : activeThreadLease.subscribe;
  const conversation = useSyncExternalStore(
    subscribeConversation,
    getConversationSnapshot,
    getConversationSnapshot,
  );
  return useMemo(() => ({
    ...hostSnapshot,
    activeThreadId: activeThreadLease?.threadId ?? null,
    conversation,
  }), [activeThreadLease?.threadId, conversation, hostSnapshot]);
}

export function useThreadCatalog(): {
  readonly protocolThreads: readonly Thread[];
  readonly threads: readonly WorkbenchThread[];
  readonly hasNextPage: boolean;
  readonly fetchNextPage: () => Promise<unknown>;
  readonly isFetching: boolean;
} {
  const runtime = useAppServerRuntime();
  const snapshot = useAppServerSnapshot();
  const query = useInfiniteQuery({
    queryKey: ["appserver", snapshot.hostId, "threads", "updated_at", "desc", false] as const,
    enabled: snapshot.phase === "ready" || snapshot.phase === "reconnecting",
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => runtime.resources.threads.list({ cursor: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
  });
  const protocolThreads = useMemo(
    () => query.data?.pages.flatMap((page) => page.data) ?? [],
    [query.data],
  );
  const threads = useMemo(() => protocolThreads.map((thread) => projectAppServerThread(thread)), [protocolThreads]);
  return {
    protocolThreads,
    threads,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetching: query.isFetching,
  };
}

export interface MultiHostWorkbenchThread extends WorkbenchThread {
  readonly hostId: string;
  readonly hostLabel: string;
  readonly updatedAt: number;
}

/**
 * Application-level sidebar projection. Each Host owns its query and failure;
 * merging happens only after host provenance has been attached.
 */
export function useMultiHostThreadCatalog(): {
  readonly threads: readonly MultiHostWorkbenchThread[];
  readonly isFetching: boolean;
} {
  const application = useContext(ApplicationRuntimeContext);
  if (application === null) throw new Error("AppServerRuntimeProvider is missing");
  const visibleHostIds = useMemo(() => new Set(
    application.profiles
      .filter((profile) => profile.enabled && profile.includeInSidebar)
      .map((profile) => profile.hostId),
  ), [application.profiles]);
  const hosts = useMemo(
    () => application.hosts.filter((host) => visibleHostIds.has(host.hostId)),
    [application.hosts, visibleHostIds],
  );
  const queryClient = useQueryClient();
  const hostIds = useMemo(() => hosts.map((host) => host.hostId), [hosts]);
  useEffect(() => subscribeHostCatalogReadiness(
    application.registry,
    hostIds,
    (hostId) => {
      void queryClient.invalidateQueries({
        queryKey: ["appserver", hostId, "threads"],
      });
    },
  ), [application.registry, hostIds, queryClient]);
  const queries = useQueries({
    queries: hosts.map((host) => ({
      queryKey: ["appserver", host.hostId, "threads", "sidebar", "updated_at", "desc", false] as const,
      queryFn: async () => {
        const runtime = await application.registry.ensureConnected(host.hostId);
        return runtime.resources.threads.list({ cursor: null, limit: 50 });
      },
      staleTime: 30_000,
      retry: retryQuery,
    })),
  });
  const querySignature = queries.map((query) => `${query.dataUpdatedAt}:${query.fetchStatus}`).join("|");
  const threads = useMemo(() => hosts.flatMap((host, index) =>
    (queries[index]?.data?.data ?? []).map((thread) => ({
      ...projectAppServerThread(thread),
      hostId: host.hostId,
      hostLabel: host.label,
      updatedAt: thread.updatedAt,
    }))).sort((left, right) => right.updatedAt - left.updatedAt), [hosts, querySignature]);
  return {
    threads,
    isFetching: queries.some((query) => query.isFetching),
  };
}

export interface ProjectCatalogSnapshot {
  readonly projects: readonly Project[];
  readonly isFetching: boolean;
  readonly error: Error | null;
}

/**
 * Projects are an AppServer-owned catalog. A Draft may choose one of their
 * roots, but the client never invents a host path or an execution binding.
 */
export function useProjectCatalog(): ProjectCatalogSnapshot {
  const runtime = useAppServerRuntime();
  const snapshot = useAppServerSnapshot();
  const query = useInfiniteQuery({
    queryKey: ["appserver", snapshot.hostId, "projects"] as const,
    enabled: snapshot.phase === "ready" || snapshot.phase === "reconnecting",
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => runtime.resources.projects.list({
      cursor: pageParam,
      limit: 100,
    }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query.fetchNextPage, query.hasNextPage, query.isFetchingNextPage]);

  return {
    projects: query.data?.pages.flatMap((page) => page.data) ?? [],
    isFetching: query.isFetching,
    error: errorOrNull(query.error),
  };
}

export interface ComposerCatalogSnapshot {
  readonly agents: readonly AgentCatalogEntry[];
  readonly models: readonly Model[];
  readonly permissionProfiles: readonly PermissionProfileSummary[];
  readonly isFetching: boolean;
  readonly modelError: Error | null;
  readonly permissionProfileError: Error | null;
  readonly agentError: Error | null;
}

function errorOrNull(error: unknown): Error | null {
  if (error == null) return null;
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Host-scoped AppServer catalogs consumed by Composer. These are query data,
 * not Replica entities: the server owns availability and cwd requirements,
 * while the immutable SubmitIntent records the user's concrete selection.
 */
export function useComposerCatalog(
  cwd: string | null,
  threadId: string | null = null,
): ComposerCatalogSnapshot {
  const runtime = useAppServerRuntime();
  const snapshot = useAppServerSnapshot();
  const enabled = snapshot.phase === "ready" || snapshot.phase === "reconnecting";
  const supportsScopedModelCatalog =
    runtime.resources.host.getInitializeResult()?.capabilities?.extensions?.[
      OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION
    ] !== undefined;
  const modelCatalogOwner = supportsScopedModelCatalog ? threadId : null;
  const agents = useInfiniteQuery({
    queryKey: ["appserver", snapshot.hostId, "agents"] as const,
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => runtime.resources.composerCatalog.listAgents({
      cursor: pageParam,
      limit: 100,
    }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 60_000,
    retry: false,
  });
  const models = useInfiniteQuery({
    queryKey: [
      "appserver",
      snapshot.hostId,
      "composer-models",
      modelCatalogOwner ?? "host",
    ] as const,
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => runtime.resources.composerCatalog.listModels({
      cursor: pageParam,
      limit: 100,
      includeHidden: false,
      ...(modelCatalogOwner === null ? {} : { threadId: modelCatalogOwner }),
    }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 60_000,
  });
  const permissionProfiles = useInfiniteQuery({
    queryKey: ["appserver", snapshot.hostId, "permission-profiles", cwd] as const,
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => runtime.resources.composerCatalog.listPermissionProfiles({
      cursor: pageParam,
      limit: 100,
      cwd,
    }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (agents.hasNextPage && !agents.isFetchingNextPage) void agents.fetchNextPage();
  }, [agents.fetchNextPage, agents.hasNextPage, agents.isFetchingNextPage]);
  useEffect(() => runtime.resources.composerCatalog.subscribeAgentsChanged(() => {
    void agents.refetch();
  }), [agents.refetch, runtime]);
  useEffect(() => {
    if (models.hasNextPage && !models.isFetchingNextPage) {
      void models.fetchNextPage();
    }
  }, [models.fetchNextPage, models.hasNextPage, models.isFetchingNextPage]);
  useEffect(() => {
    if (permissionProfiles.hasNextPage && !permissionProfiles.isFetchingNextPage) {
      void permissionProfiles.fetchNextPage();
    }
  }, [
    permissionProfiles.fetchNextPage,
    permissionProfiles.hasNextPage,
    permissionProfiles.isFetchingNextPage,
  ]);

  const modelData = useMemo(
    () => models.data?.pages.flatMap((page) => page.data) ?? [],
    [models.data],
  );
  const permissionProfileData = useMemo(
    () => permissionProfiles.data?.pages.flatMap((page) => page.data) ?? [],
    [permissionProfiles.data],
  );

  return {
    agents: agents.data?.pages.flatMap((page) => page.data) ?? [],
    models: modelData,
    permissionProfiles: permissionProfileData,
    isFetching: agents.isFetching || models.isFetching || permissionProfiles.isFetching,
    agentError: errorOrNull(agents.error),
    modelError: errorOrNull(models.error),
    permissionProfileError: errorOrNull(permissionProfiles.error),
  };
}

function targetHostId(target: ComposerTarget): string {
  return target.type === "new-thread" ? target.execution.hostId : target.key.hostId;
}

function normalizeRoots(roots: readonly string[]): readonly string[] {
  return [...new Set(roots.map((root) => root.trim()).filter(Boolean))];
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("The request was aborted", "AbortError");
  const error = new Error("The request was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Codex skills are host/cwd query data, not Replica state. The returned
 * catalog delays `skills/list` until the user has typed a non-empty `$`
 * query, shares results through TanStack Query, and invalidates every cached
 * root-set for this host when AppServer emits `skills/changed`.
 */
interface PendingMentionSearch {
  readonly query: string;
  readonly limit: number;
  readonly reject: (error: Error) => void;
  readonly resolve: (entries: readonly import("@opencraft/composer-core").ComposerCatalogEntry[]) => void;
  readonly removeAbortListener: () => void;
}

function fileSearchEntries(
  files: readonly import("@opencraft/appserver-protocol/generated").FuzzyFileSearchResult[],
  limit: number,
): readonly import("@opencraft/composer-core").ComposerCatalogEntry[] {
  return files.slice(0, limit).map((file) => ({
    id: `file:${file.root}:${file.path}`,
    kind: "mention" as const,
    label: file.file_name,
    detail: file.path,
    uri: file.path.startsWith("/")
      ? file.path
      : `${file.root.replace(/[\\/]+$/u, "")}/${file.path.replace(/^[\\/]+/u, "")}`,
    metadata: {
      root: file.root,
      matchType: file.match_type,
      score: file.score,
      indices: file.indices,
    },
  }));
}

/**
 * One host-scoped Composer catalog. Skills are cached query data while file
 * mentions use Codex's long-lived fuzzy-search session and therefore avoid a
 * request/session waterfall for every keystroke.
 */
export function useAppServerComposerCatalog(workspaceRoots: readonly string[]): ComposerCatalog {
  const runtime = useAppServerRuntime();
  const snapshot = useAppServerSnapshot();
  const queryClient = useQueryClient();
  const rootKey = JSON.stringify(normalizeRoots(workspaceRoots));
  const enabled = snapshot.phase === "ready" || snapshot.phase === "reconnecting";
  const searchStateRef = useRef<{
    key: string;
    session: Promise<FuzzyFileSearchSession> | null;
    pending: PendingMentionSearch | null;
  }>({ key: "", session: null, pending: null });

  useEffect(() => {
    if (!enabled) return;
    return runtime.resources.composerCatalog.subscribeSkillsChanged(() => {
      void queryClient.invalidateQueries({
        queryKey: ["appserver", snapshot.hostId, "skills"],
      });
    });
  }, [enabled, queryClient, runtime, snapshot.hostId]);

  useEffect(() => {
    const state = searchStateRef.current;
    if (state.key === `${snapshot.hostId}:${rootKey}`) return;
    state.pending?.removeAbortListener();
    state.pending?.reject(abortError());
    state.pending = null;
    const previousSession = state.session;
    state.key = `${snapshot.hostId}:${rootKey}`;
    state.session = null;
    if (previousSession !== null) {
      void previousSession.then((session) => session.stop()).catch(() => undefined);
    }
  }, [rootKey, snapshot.hostId]);

  useEffect(() => () => {
    const state = searchStateRef.current;
    state.pending?.removeAbortListener();
    state.pending?.reject(abortError());
    state.pending = null;
    if (state.session !== null) {
      void state.session.then((session) => session.stop()).catch(() => undefined);
      state.session = null;
    }
  }, []);

  return useMemo<ComposerCatalog>(() => {
    const roots = JSON.parse(rootKey) as string[];
    const state = searchStateRef.current;
    const ensureFileSearchSession = (): Promise<FuzzyFileSearchSession> => {
      if (state.session !== null) return state.session;
      state.session = runtime.resources.composerCatalog.createFuzzyFileSearchSession({
        roots,
        onUpdated(update) {
          const pending = state.pending;
          if (pending === null || pending.query !== update.query) return;
          state.pending = null;
          pending.removeAbortListener();
          pending.resolve(fileSearchEntries(update.files, pending.limit));
        },
      }).catch((error) => {
        state.session = null;
        throw error;
      });
      return state.session;
    };
    return {
      async search(query, signal) {
        const text = query.query.trim();
        if (text.length === 0) return [];
        if (targetHostId(query.target) !== snapshot.hostId) return [];
        if (signal?.aborted) throw abortError();
        if (query.kind === "mention") {
          if (roots.length === 0) return [];
          state.pending?.removeAbortListener();
          state.pending?.reject(abortError());
          state.pending = null;
          return new Promise((resolve, reject) => {
            const abort = () => {
              if (state.pending?.reject !== reject) return;
              state.pending = null;
              reject(abortError());
            };
            signal?.addEventListener("abort", abort, { once: true });
            state.pending = {
              query: text,
              limit: query.limit,
              resolve,
              reject,
              removeAbortListener: () => signal?.removeEventListener("abort", abort),
            };
            void ensureFileSearchSession().then((session) => session.update(text)).catch((error: unknown) => {
              if (state.pending?.reject !== reject) return;
              state.pending.removeAbortListener();
              state.pending = null;
              reject(error instanceof Error ? error : new Error(String(error)));
            });
          });
        }
        if (query.kind !== "skill") return [];
        const response = await queryClient.fetchQuery({
          queryKey: ["appserver", snapshot.hostId, "skills", ...roots] as const,
          queryFn: () => runtime.resources.composerCatalog.listSkills({
            cwds: roots,
            forceReload: false,
          }),
          staleTime: 5 * 60_000,
          gcTime: 5 * 60_000,
        });
        if (signal?.aborted) throw abortError();
        return searchAppServerSkills(response, text, query.limit);
      },
    };
  }, [queryClient, rootKey, runtime, snapshot.hostId]);
}
