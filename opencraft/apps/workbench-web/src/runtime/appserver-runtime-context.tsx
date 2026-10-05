// @refresh reset
import {
  preflightHostConnection,
  type ConversationTerminalToolHost,
} from "@opencraft/workbench-runtime";
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQueries,
  useQueryClient,
  useQuery,
} from "@tanstack/react-query";
import { composerCapabilitiesOptions, invalidateComposerCapabilities, changesComposerCapabilities } from "./composer-capabilities-query";
import { requiresEmbeddedLightVelaAccountPreflight } from "./lightvela-web-bootstrap";
import { changesThreadCatalog, sidebarThreadCatalogQueryKey, threadCatalogPhase, managedCatalogDiscoveryPhase, type HostThreadCatalogState } from "./thread-catalog-query";
import { webSshDiscoveryLifecycle } from "./web-ssh-discovery";
import {
  AppServerRpcError,
  createCordisAppServerRegistry,
  type CordisAppServerRegistryRuntime,
} from "@opencraft/appserver-client";
import {
  AppServerBotDirectory,
  AppServerBotConversationResolver,
  AppServerBotConversationSource,
  createCordisBotConversationRuntime,
} from "@opencraft/bot-conversation-appserver";
import { createCordisProfileSkillsRuntime } from "@opencraft/profile-skills-appserver";
import type { Context as CordisContext } from "@deepseek-ai/cordis";
import { AUTHENTICATION_PROVIDER_CHANNEL, AuthenticationService, AuthenticationFlowService } from "@opencraft/workbench-runtime";
import { CONNECTOR_PROVIDER_CHANNEL, ConnectorRuntime } from "@opencraft/workbench-runtime";
import { ConnectorApprovalQueue, ConnectorManager } from "@opencraft/workbench-runtime";
import { openHostDocumentPersistence } from "@opencraft/workbench-runtime";
import { openConnectorConfigurationStore } from "./connector-configuration-store";
import { connectorProviderAdapter } from "./connector-contributions";
import { authenticationProviderAdapter } from "./authentication-contributions";
import { BlobResourceService } from "@opencraft/blob-resources";
import { ImageProcessingService } from "@opencraft/image-processing";
import { processBrowserImage } from "@opencraft/image-processing/browser";
import { IndexedDbBlobStorage } from "@opencraft/blob-resources/browser";
import {
  OPENCRAFT_BROWSER_CAPABILITY,
  OPENCRAFT_BROWSER_EXTENSION,
  type BrowserDynamicToolHost,
} from "@opencraft/browser-appserver";
import {
  installWorkbenchDynamicToolHandlers,
  OPENCRAFT_WORKBENCH_DYNAMIC_TOOLS,
} from "./workbench-dynamic-tools";
import {
  searchAppServerSkills,
  assertSkillDiscoveryAvailable,
  type FuzzyFileSearchSession,
} from "@opencraft/composer-appserver";
import {
  createClientId,
  shouldSearchComposerCatalog,
  type ComposerCatalog,
  type ComposerController,
  type ComposerTarget,
  type SubmissionReceipt,
  type ComposerExecutionTarget,
} from "@opencraft/composer-core";
import type {
  PermissionProfileSummary,
  Project,
  Thread,
} from "@opencraft/appserver-protocol/generated/v2";
import {
  OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION,
  type CatalogModel as Model,
} from "@opencraft/appserver-protocol";
import {
  type AnnouncementCenter,
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
  asRouteScopeId,
  createCordisHostConnectionProviderRuntime,
  EnvironmentDirectoryService,
  EnvironmentProfileStore,
  ENVIRONMENT_SOURCE_CHANNEL,
  connectEnvironmentRuntimeRegistry,
  type EnvironmentDirectory,
  createAppServerWorkbenchRuntime,
  createConversationActivationCoordinator,
  createConversationScopeLeaseRegistry,
  createConversationScopeRegistry,
  createConversationViewRegistry,
  createWorkbenchSubmissionPipeline,
  draftSubmissionOwnsNavigation,
  equalWorkbenchLocation,
  createWorkbenchCoordinator,
  createWorkbenchDraftLocation,
  createWorkbenchThreadLocation,
  AgentRuntimeDirectory,
  HostRuntimeRegistry,
  type AgentRuntimeAccess,
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
  legacyDirectServerProjectionFromHost,
  type ServerRouteLocality,
  type ThreadServerOrigin,
  type ConversationScopeRegistry,
  type WorkbenchCoordinator,
  type WorkbenchLocation,
  type WorkbenchThread,
} from "@opencraft/workbench-runtime";
import {
  createContext,
  type Context,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { readWorkbenchBootstrapLocation, createRouteScopeId, createApplicationNavigation, type ApplicationNavigation } from "./workbench-navigation";
import { createWorkbenchEntryResolver, resolveRetainedWorkbenchLocation } from "./workbench-location-restoration";
import { IndexedDbHostConnectionProfileStore } from "./indexeddb-host-profile-store";
import { ServerManagedProfileStore } from "./server-managed-profile-store";
import { environmentSourceAdapter } from "./environment-directory/contribution-adapter";
import { openClientExtensionPersistence } from "./client-extension-persistence";
import { IndexedDbSidebarLayoutStorage } from "./indexeddb-sidebar-layout-storage";
import { BrowserModuleUrlExtensionLoader } from "./module-url-extension-loader";
import { loadOptionalFeatureModule, type OptionalFeatureStartup } from "./optional-feature-startup";
import { connectElectronAppHost } from "./electron-app-host";
import { connectWebSocketAppHost } from "./websocket-app-host";
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
import { canReadHostThreadCatalog, readHostThreadCatalog, type ManagedHostCatalogSource } from "./host-thread-catalog";

import { bindHostQueryRecovery } from "./host-query-recovery";
import { connectAppearanceThemeContributions } from "../appearance-theme";
import { workbenchProductId } from "../workbench-product";
import {
  createWorkbenchNavigationTransaction,
  type WorkbenchHistoryMode,
  type WorkbenchNavigationTransaction,
} from "./workbench-navigation-transaction";

const subscribeNoManagedCatalog = () => () => {};
const readNoManagedCatalog = () => null;

// The Context object itself is part of the renderer's hot-reload state.
export interface AppServerHostCatalog {
  readonly extensionRuntime: Pick<ExtensionSupervisor, "subscribe" | "getSnapshot" | "contributions">;
  readonly connectors: ConnectorRuntime;
  readonly connectorManager: ConnectorManager;
  readonly connectorApprovals: ConnectorApprovalQueue;
  readonly agentRuntimes: AgentRuntimeAccess;
  readonly threadManagement: {
    capabilities(hostId: string): { fork: boolean; rename: boolean; archive: boolean; delete: boolean };
    rename(hostId: string, threadId: string, name: string): Promise<void>;
    delete(hostId: string, threadId: string): Promise<void>;
    fork(hostId: string, threadId: string): Promise<string>;
    archive(hostId: string, threadId: string): Promise<void>;
    unarchive(hostId: string, threadId: string): Promise<void>;
    listArchived(hostId: string): Promise<Array<{ id: string; name?: string | null; preview?: string }>>;
  };
  readonly authenticationFlows: AuthenticationFlowService;
  readonly environmentDirectory: EnvironmentDirectory;
  readonly selectedHostId: string;
  readonly hosts: readonly HostRuntimeDescriptor[];
  readonly profiles: readonly HostConnectionProfile[];
  /** Provider-owned navigation metadata projected for Host-scoped chrome. */
  readonly connectionProviders: readonly HostConnectionProviderDescriptor[];
  readonly extensionContributions: ExtensionContributionStore;
  readonly announcements: AnnouncementCenter;
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
  selectConversation(location: WorkbenchLocation): Promise<boolean>;
  promoteDraft(draftId: string, receipt: SubmissionReceipt): Promise<WorkbenchLocation>;
  navigateToHome(options: {
    readonly execution: ComposerExecutionTarget;
    readonly entrypoint?: "home" | "new-chat";
    readonly mode?: WorkbenchHistoryMode;
  }): WorkbenchLocation;
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
  selectConversation(location: WorkbenchLocation): Promise<boolean>;
  navigateToHome(options: {
    readonly execution: ComposerExecutionTarget;
    readonly entrypoint?: "home" | "new-chat";
    readonly mode?: WorkbenchHistoryMode;
  }): WorkbenchLocation;
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
  readonly managedHostCatalog: ManagedHostCatalogSource | null;
  readonly hostProfiles: HostConnectionProfileStore;
  readonly blobs: BlobResourceService;
  readonly images: ImageProcessingService;
  readonly registry: HostRuntimeRegistry<AppServerWorkbenchRuntime>;
  readonly conversationScopes: ConversationScopeRegistry;
  readonly conversationBindings: ConversationBindingStore;
  readonly extensionSettings: ExtensionSettingsStore;
  readonly extensionContributions: ExtensionContributionStore;
  readonly announcements: AnnouncementCenter;
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

export async function refreshBundledHostBrowseRoots(
  store: HostConnectionProfileStore,
  definitions: readonly WebHostDefinition[],
): Promise<void> {
  for (const definition of definitions) {
    if (definition.workspaceBrowseRoots.length === 0) continue;
    const current = store.getSnapshot().profiles.find((profile) => profile.hostId === definition.hostId);
    const providerUrl = current?.providerConfig !== null
      && typeof current?.providerConfig === "object"
      && !Array.isArray(current.providerConfig)
      ? (current.providerConfig as { readonly url?: unknown }).url
      : null;
    if (current === undefined || current.workspaceBrowseRoots.length > 0
      || current.providerId !== "vela.websocket"
      || providerUrl !== definition.url) continue;
    await store.put({
      ...current,
      workspaceBrowseRoots: definition.workspaceBrowseRoots,
      revision: current.revision + 1,
    });
  }
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
    const parsedUrl = new URL(url, fallbackUrl);
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
      url: url.startsWith("/") ? parsedUrl.href : url,
      kind: kind as HostRuntimeDescriptor["kind"],
    };
  });
}

export function activeThreadStorageKey(hostId: string): string {
  return currentProductStorageKey(`vela.active-thread-id:${hostId}`);
}

export function rememberedThreadId(
  storage: Pick<Storage, "getItem">,
  hostId: string,
  hostProfileMode: "environment" | "configured" = "environment",
): string | null {
  const scopedThreadId = storage.getItem(activeThreadStorageKey(hostId));
  if (scopedThreadId !== null || hostProfileMode === "configured") return scopedThreadId;
  return storage.getItem(currentProductStorageKey("vela.active-thread-id"));
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
export function productStorageKey(productId: string, key: string): string {
  return productId === "opencraft" ? key : `${productId}:${key}`;
}

export function productDatabaseName(productId: string, base: string): string {
  return productId === "opencraft" ? base : `${base}-${productId}`;
}

export function currentProductStorageKey(key: string): string {
  return productStorageKey(workbenchProductId, key);
}

function currentProductDatabaseName(base: string): string {
  return productDatabaseName(workbenchProductId, base);
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
  readonly connectors: ConnectorRuntime;
  readonly connectorManager: ConnectorManager;
  readonly connectorApprovals: ConnectorApprovalQueue;
  readonly agentRuntimes: AgentRuntimeDirectory;
  readonly authenticationFlows: AuthenticationFlowService;
  readonly environmentDirectory: EnvironmentDirectory;
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
  readonly navigation: ApplicationNavigation<null>;
}

export interface ActiveWebWorkbenchApplicationSupervisor extends WebWorkbenchApplicationBase {
  readonly mode: "active";
  readonly managedHostCatalog: ManagedHostCatalogSource | null;
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

export interface WebWorkbenchSupervisorOptions {
  /** Internal Application-owned lane; absent keeps full Workbench eager behavior. */
  readonly optionalFeatureStartup?: OptionalFeatureStartup;
  /** Application-owned profiles that must never enter the durable Host store. */
  readonly ephemeralHostProfiles?: readonly HostConnectionProfile[];
  /** Embedded products keep the outer page URL under their host's authority. */
  readonly navigationMode?: "browser" | "memory";
  /** Embedded products may supply one explicit Host without directory discovery. */
  readonly hostProfileMode?: "environment" | "configured";
  readonly modelSelectionPolicy?: "user" | "host-default";
  readonly lightVelaRegion?: "cn" | "intl";
  readonly lightVelaApiBase?: string;
  /** Embedded session storage is supplied by the containing application. */
  readonly lightVelaAccountStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly lightVelaPhysicalConnection?: import("@opencraft/plugin-lightvela-hermes").HermesPhysicalConnectionPreparation;
}

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
  let hostSelectionEpoch = 0;
  const navigateAndRemember = async (location: WorkbenchLocation, action: () => Promise<boolean>) => {
    const epoch = ++hostSelectionEpoch;
    const activated = await action();
    if (activated && epoch === hostSelectionEpoch
      && equalWorkbenchLocation(input.navigation.getSnapshot().location, location)) {
      const hostId = location.kind === "thread" ? location.key.hostId : location.hostId;
      setLocalPreference(currentProductStorageKey("vela.active-host-id"), hostId);
      setLocalPreference(activeThreadStorageKey(hostId), location.kind === "thread" ? location.key.threadId : null);
    }
    return activated;
  };
  commands = {
    async selectHost(hostId) {
      const epoch = ++hostSelectionEpoch;
      const origin = input.navigation.getSnapshot().revision;
      if (!input.hostProfiles.getSnapshot().profiles.some(profile => profile.hostId === hostId && profile.enabled)) throw new Error("此环境当前不可连接，请刷新环境目录。");
      const activeDraft = input.scopes.getActiveDraft();
      if (activeDraft !== null && draftSubmissionOwnsNavigation(activeDraft.phase)) {
        throw new Error("The execution node cannot change while the first turn is being submitted");
      }
      await input.registry.ensureConnected(hostId);
      if (epoch !== hostSelectionEpoch || origin !== input.navigation.getSnapshot().revision
        || input.scopes.getActiveDraft()?.id !== activeDraft?.id) return;
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
          if (epoch === hostSelectionEpoch && origin === input.navigation.getSnapshot().revision
            && input.scopes.getDraft(activeDraft.id)) input.scopes.activateDraft(activeDraft.id);
          throw error;
        }
      }
      input.coordinator.setSelectedHostId(hostId);
      setLocalPreference(currentProductStorageKey("vela.active-host-id"), hostId);
    },
    navigate(location, mode = "push") {
      return navigateAndRemember(location, () => input.navigation.navigate(location, mode));
    },
    selectConversation(location) {
      return navigateAndRemember(location, () => input.navigation.selectConversation(location));
    },
    navigateToHome(options) {
      ++hostSelectionEpoch;
      const draft = input.scopes.openDraft({
        execution: options.execution,
        entrypoint: options.entrypoint,
      });
      const location = createWorkbenchDraftLocation(options.execution.hostId, draft.id);
      try {
        const activated = input.navigation.navigateToHome(location, options.mode);
        if (!activated) throw new Error(`Draft ${draft.id} activation was superseded`);
        input.coordinator.setSelectedHostId(options.execution.hostId);
        setLocalPreference(
          currentProductStorageKey("vela.active-host-id"),
          options.execution.hostId,
        );
        setLocalPreference(activeThreadStorageKey(options.execution.hostId), null);
        return location;
      } catch (error) {
        input.scopes.dismissDraft(draft.id);
        throw error;
      }
    },
    async promoteDraft(draftId, receipt) {
      ++hostSelectionEpoch;
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
        if (!input.registry.has(profile.hostId)) input.registry.register(input.createHostRegistration(profile));
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
  terminalToolHost: ConversationTerminalToolHost,
  conversationBindings: ConversationBindingStore,
  cordis: CordisContext,
  disposeScopeResources: (scopeId: string) => void = () => undefined,
  disposeViewResources: (viewId: string) => void = () => undefined,
  options: WebWorkbenchSupervisorOptions = {},
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
    const agentRuntimes = new AgentRuntimeDirectory();
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
    const environmentFiber = cordis.plugin(EnvironmentDirectoryService);
    await environmentFiber;
    startupRollback.push(() => environmentFiber.dispose());
    const environmentDirectory = cordis.environmentDirectory.directory;
    const platformViewRenderers = new PlatformViewRendererRegistry();
    const platformAccounts = new PlatformAccountContributionRegistry();
    const authenticationFiber = cordis.plugin(AuthenticationService);
    startupRollback.push(() => authenticationFiber.dispose());
    await authenticationFiber;
    const connectorApprovals = new ConnectorApprovalQueue();
    startupRollback.push(() => connectorApprovals.dispose());
    const connectors = new ConnectorRuntime(cordis.authentication, 30000, { approvals: connectorApprovals });
    startupRollback.push(() => connectors.dispose());
    const connectorStore = await openConnectorConfigurationStore().catch(() => ({
      async load(): Promise<never> { throw new Error("Connector storage unavailable"); },
      async compareAndSet(): Promise<never> { throw new Error("Connector storage unavailable"); },
    }));
    const connectorManager = await ConnectorManager.open(connectors, cordis.authentication, conversationBindings, connectorStore, async hostId => {
      await agentRuntimes.ensureReady(hostId);
      const client = appServerRegistry.clients.get(hostId);
      if (!client) throw new Error("Connector Host unavailable");
      return client;
    });
    startupRollback.push(() => connectorManager.dispose());
    const authenticationFlowFiber = cordis.plugin(AuthenticationFlowService);
    startupRollback.push(() => authenticationFlowFiber.dispose());
    await authenticationFlowFiber;
    const authenticationFlows = cordis.authenticationFlows;
    const composerActionRenderers = new ComposerActionRendererRegistry();
    const platform = currentWorkbenchPlatform();
    const bootstrapDefinitions = parseWebHostDefinitions(
      import.meta.env.VITE_APPSERVER_HOSTS_JSON as string | undefined,
      appServerUrl(),
    );
    const electronAppHost = platform === "electron" ? connectElectronAppHost() : null;
    if (electronAppHost !== null) startupRollback.push(() => electronAppHost.close());
    const headlessAppHost = platform === "web" && import.meta.env.VITE_INCLUDE_HEADLESS_CODEX === "true"
      ? connectWebSocketAppHost() : null;
    if (headlessAppHost !== null) startupRollback.push(() => headlessAppHost.close());
    const remoteAppHost = headlessAppHost ? connectWebSocketAppHost(undefined, { path: "/ssh-apphost" }) : null;
    if (remoteAppHost) startupRollback.push(() => remoteAppHost.close());
    const sshManagement = headlessAppHost ? new (await import("@opencraft/plugin-builtin-agents")).SshConnectionsController() : null;
    if (sshManagement) { startupRollback.push(() => sshManagement.dispose()); await sshManagement.startDiscovery(webSshDiscoveryLifecycle); }
    const [lightVelaPlatform, lightVela, createLightVelaHermesExtension] = await Promise.all([
      import("@opencraft/plugin-lightvela-platform"),
      import("@opencraft/plugin-lightvela-hermes"),
      import("@opencraft/plugin-lightvela-hermes/runtime-entry").then((module) => module.default),
    ]);
    const lightVelaAccount = new lightVelaPlatform.LightVelaAccountService({
      apiBase: options.lightVelaApiBase,
      storage: options.lightVelaAccountStorage,
      sessionManagedByHost: options.lightVelaAccountStorage !== undefined,
      initialRegion: options.lightVelaRegion,
      runtimeCommands: new lightVela.AppServerLightVelaRuntimeCommandPort(
        appServerRegistry.clients,
      ),
    });
    startupRollback.push(() => lightVelaAccount.dispose());
    const extensionPersistence = await openClientExtensionPersistence(currentProductDatabaseName);
    startupRollback.push(() => extensionPersistence.backend.close());
    const extensions = new ExtensionSupervisor({
      persistence: extensionPersistence.backend,
      resolveHostPersistence: async (hostId, signal) => {
        const client = appServerRegistry.clients.get(hostId);
        if (!client) throw new Error("Host document storage requires a connected Host");
        return openHostDocumentPersistence(client, {
          signal,
          isCurrent: () => appServerRegistry.clients.get(hostId) === client,
        });
      },
      context: cordis,
      platform,
      internalContributions: {
        [CONNECTOR_PROVIDER_CHANNEL]: connectorProviderAdapter(connectors),
        hostConnectionProvider: hostConnectionProviderAdapter,
        [HOST_PROFILE_CONTRIBUTION_CHANNEL]: hostProfileContributions.createAdapter(),
        [ENVIRONMENT_SOURCE_CHANNEL]: environmentSourceAdapter(environmentDirectory),
        platformViewRenderer: createPlatformViewRendererContributionAdapter(platformViewRenderers),
        platformAccount: platformAccounts.createAdapter(),
        [AUTHENTICATION_PROVIDER_CHANNEL]: authenticationProviderAdapter(cordis.authentication),
        composerActionRenderer: createComposerActionRendererContributionAdapter(composerActionRenderers),
      },
    });
    startupRollback.push(() => extensions.dispose());
    const extensionSettings = await ExtensionSettingsStore.open(
      extensions.contributions,
      extensionPersistence.settings,
    );
    startupRollback.push(() => extensionSettings.close());
    const sidebarLayoutStorage = await IndexedDbSidebarLayoutStorage.open({
      databaseName: currentProductDatabaseName("vela-sidebar-layout-v2"),
    });
    const sidebarLayout = await SidebarLayoutStore.open(sidebarLayoutStorage);
    startupRollback.push(() => sidebarLayout.close());
    await extensions.activate(BuiltinWebSocketHostConnectionExtension);
    await extensions.activateOptional(BuiltinThemePackExtension);
    const loadPresentationExtension = async (
      id: string,
      load: (signal?: AbortSignal) => ReturnType<Parameters<ExtensionSupervisor["loadOptional"]>[1]>,
    ): Promise<void> => {
      const activate = async (signal?: AbortSignal) => {
        const moduleScope = new AbortController();
        const abortModule = () => moduleScope.abort(signal?.reason);
        if (signal?.aborted) abortModule();
        else signal?.addEventListener("abort", abortModule, { once: true });
        try {
          return await extensions.loadOptional(id, () => loadOptionalFeatureModule(
            moduleSignal => Promise.resolve().then(() => load(moduleSignal)), moduleScope.signal,
          ));
        } finally {
          // The Supervisor's own deadline may finish before the module timer.
          // Revoke that factory scope before accepting any late import result.
          moduleScope.abort();
          signal?.removeEventListener("abort", abortModule);
        }
      };
      if (options.optionalFeatureStartup !== undefined) {
        options.optionalFeatureStartup.add(id, activate);
      } else {
        await activate();
      }
    };
    await loadPresentationExtension("vela.voice-input", async signal => {
      const createVoiceInputExtension = (
        await import("@opencraft/plugin-voice-input/runtime-entry")
      ).default;
      signal?.throwIfAborted();
      return createVoiceInputExtension();
    });
    if (import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN === "true") {
      await extensions.loadOptional("vela.builtin-agents", async () => {
        const { createBuiltinAgentsExtension } = await import("@opencraft/plugin-builtin-agents");
        return createBuiltinAgentsExtension({
          requestHost: async (hostId, method, params) => {
            const result = await agentRuntimes.request(hostId, method, params);
            if (changesComposerCapabilities(method)) {
              // UI requests start after application construction. Invalidate the
              // existing host-scoped catalog owner, never a session's selection.
              void invalidateComposerCapabilities(queryClient, hostId).catch(() => undefined);
            }
            return result;
          },
          createTransport: (hostId) => {
            if (electronAppHost === null) throw new Error("Electron App Host is unavailable");
            return electronAppHost.createTransport(hostId);
          },
        });
      });
    }
    if (import.meta.env.VITE_INCLUDE_HEADLESS_MODEL_SERVICES === "true") {
      await extensions.loadOptional("vela.headless-model-services", async () => {
        const { createHeadlessModelServicesExtension } = await import("@opencraft/plugin-builtin-agents");
        return createHeadlessModelServicesExtension({
          hostId: "opencraft-server",
          requestHost: (hostId, method, params) => agentRuntimes.request(hostId, method, params),
        });
      });
    }
    if (headlessAppHost !== null) {
      await extensions.loadOptional("vela.headless-codex", async () => {
        const { readSshServerCatalog } = await import("./ssh-server-catalog");
        // Only this headless product queries its backend catalog. Credentials,
        // host-key trust and remote commands never enter a Renderer profile.
        const sshServers = await readSshServerCatalog();
        const { createHeadlessCodexExtension } = await import("@opencraft/plugin-builtin-agents");
        return createHeadlessCodexExtension({
          requestHost: (hostId, method, params) => agentRuntimes.request(hostId, method, params),
          createTransport: hostId => (hostId.startsWith("ssh:") && sshManagement && sshManagement.getSnapshot().available !== false ? remoteAppHost! : headlessAppHost).createTransport(hostId),
          workspaceBrowseRoots: bootstrapDefinitions.find((host) => host.hostId === "opencraft-server")?.workspaceBrowseRoots ?? [],
          sshServers: sshManagement!.getSnapshot().available !== false ? [] : sshServers,
          sshManagement: sshManagement!,
        });
      });
    }
    // Keep this expression direct: Vite can erase the entire dynamic-import
    // edge from product builds instead of merely disabling it at runtime.
    if (import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN !== "false") {
      await extensions.loadOptional("vela.hypernode", async () => {
        const { createHyperNodeExtension } = await import("@opencraft/plugin-hypernode");
        return createHyperNodeExtension({ url: appServerUrl() });
      });
    }
    await extensions.activateOptional(lightVelaPlatform.createLightVelaPlatformExtension({
      account: lightVelaAccount,
    }));
    await extensions.activateOptional(createLightVelaHermesExtension({
      account: lightVelaAccount,
      physicalConnection: options.lightVelaPhysicalConnection,
      apiBase: options.lightVelaApiBase,
      profileSkills: profileSkills.service,
      profileDirectory: botDirectory,
    }));
    if (requiresEmbeddedLightVelaAccountPreflight(options)) {
      // An explicit embedded Host binds both physical instance and account.
      // Do not race provider preflight against the platform extension's
      // fire-and-forget account restoration.
      await Promise.all([
        lightVelaAccount.refreshBots(),
        lightVelaAccount.refreshAccountDetails(),
      ]);
    }
    if (platform === "web") {
      await loadPresentationExtension("lightvela.collaboration", async signal => {
        const createLightVelaCollaborationExtension = (
          await import("@opencraft/plugin-lightvela-collaboration/runtime-entry")
        ).default;
        signal?.throwIfAborted();
        return createLightVelaCollaborationExtension({ account: lightVelaAccount });
      });
    }
    const botSource = new AppServerBotConversationSource(botConversations.service);
    startupRollback.push(() => botSource.dispose());
    await loadPresentationExtension("vela.bot-chat", async signal => {
      const createBotChatExtension = (
        await import("@opencraft/plugin-bot-chat/runtime-entry")
      ).default;
      signal?.throwIfAborted();
      return createBotChatExtension({
        source: botSource,
        resolver: new AppServerBotConversationResolver(botConversations.service),
        showNavigation: false,
      });
    });
    let connectBotHost: (hostId: string) => Promise<void> = async () => { throw new Error("暂无可连接的实例。"); };
    await loadPresentationExtension("vela.bot-management", async signal => {
      const { createBotManagementExtension } = await import("./bot-management-extension");
      signal?.throwIfAborted();
      return createBotManagementExtension(botDirectory, botConversations.service, hostId => connectBotHost(hostId));
    });
    const extensionInstallationFiber = cordis.plugin(
      provideExtensionInstallationRepository(extensionPersistence.installations),
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
    const requestedBootstrapLocation = readWorkbenchBootstrapLocation(
      new URL(window.location.href), window.history.state, options.navigationMode,
    );
    const routerOptions = {
      mode: options.navigationMode,
      // The containing page owns its URL. Embedded Workbench starts at Home.
      ...(options.navigationMode === "memory" ? { initialEntries: ["/"] } : {}),
    };
  const storedHostProfiles = await IndexedDbHostConnectionProfileStore.open({
    databaseName: currentProductDatabaseName("vela-host-connections"),
    seed: bootstrapDefinitions.map(hostDefinitionProfile),
    ephemeral: [
      ...hostProfileContributions.list(),
      ...(options.ephemeralHostProfiles ?? []),
    ],
  });
  const configuredHostProfiles = sshManagement && sshManagement.getSnapshot().available !== false
    ? new ServerManagedProfileStore(storedHostProfiles, sshManagement, () => [
      ...sshManagement!.getSnapshot().items,
      ...sshManagement!.getSnapshot().legacyServers.map(server => ({ ...server, enabled: true, revision: 1 })),
    ].map(server => ({
        hostId: server.serverId, displayName: server.displayName, providerId: "vela.headless-codex", providerConfig: {}, providerConfigVersion: 1,
        hostKind: "remote-ssh", enabled: server.enabled, autoConnect: false, includeInSidebar: true, credentialRef: null,
        transportEndpoint: null, executionLocation: server.displayName, workspaceBrowseRoots: server.workspaceBrowseRoots, revision: server.revision,
      })))
    : storedHostProfiles;
  await refreshBundledHostBrowseRoots(configuredHostProfiles, bootstrapDefinitions);
  const hostProfiles: HostConnectionProfileStore = options.hostProfileMode === "configured"
    ? configuredHostProfiles
    : new EnvironmentProfileStore(configuredHostProfiles, environmentDirectory);
  startupRollback.push(() => hostProfiles.close());
  if (!configuredHostProfiles.getSnapshot().profiles.some(profile => profile.enabled)) {
    await environmentDirectory.refresh().catch(() => undefined);
  }
  const profiles = hostProfiles.getSnapshot().profiles.filter((profile) => profile.enabled);
  if (profiles.length === 0) {
    const navigation = createApplicationNavigation(null, routerOptions);
    startupRollback.push(() => navigation.dispose());
    agentRuntimes.markUnavailable(new Error("No Agent Runtime is configured"));
    const provisionHost = (input: ProvisionHostInput) => persistProvisionedHost(
      input,
      hostProfiles,
      connectionProviders.providers,
    );
    const hostless: HostlessWebWorkbenchApplicationSupervisor = {
      connectors,
      connectorManager,
      connectorApprovals,
      environmentDirectory,
      authenticationFlows,
      blobs,
      images,
      mode: "hostless",
      navigation,
      agentRuntimes,
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
          () => navigation.dispose(),
          () => conversationBindings.dispose(),
          () => hostProfiles.close(),
          () => queryClient.clear(),
          () => extensionManager.dispose(),
          () => extensionSettings.close(),
          () => sidebarLayout.close(),
          () => extensionInstallationFiber.dispose(),
          () => authenticationFlowFiber.dispose(),
          () => extensions.dispose(),
          () => connectorManager.dispose(),
          () => connectors.dispose(),
          () => connectorApprovals.dispose(),
          () => authenticationFiber.dispose(),
          () => environmentFiber.dispose(),
          () => lightVelaAccount.dispose(),
          disconnectAppearanceThemes,
          () => botDirectory.dispose(),
          () => profileSkills.dispose(),
          () => botSource.dispose(),
          () => botConversations.dispose(),
          () => appServerRegistry.dispose(),
          () => electronAppHost?.close(),
          () => headlessAppHost?.close(),
          () => remoteAppHost?.close(),
          () => sshManagement?.dispose(),
          () => connectionProviders.dispose(),
          () => blobFiber.dispose(),
          () => imageFiber.dispose(),
        ], "Failed to dispose hostless Web Workbench supervisor");
      },
    };
    startupRollback.length = 0;
    return hostless;
  }
  const bootstrapLocation = requestedBootstrapLocation === null ? null : resolveRetainedWorkbenchLocation(
    requestedBootstrapLocation,
    { hasHost: hostId => profiles.some(profile => profile.hostId === hostId), bindings: conversationBindings, scopes: null },
  );
  const persistedHostId = window.localStorage.getItem(currentProductStorageKey("vela.active-host-id"));
  const requestedHostId = bootstrapLocation?.kind === "thread"
    ? bootstrapLocation.key.hostId
    : bootstrapLocation?.hostId;
  const initialHostId = requestedHostId !== undefined
    && profiles.some((host) => host.hostId === requestedHostId)
    ? requestedHostId
    : profiles.some((host) => host.hostId === persistedHostId)
      ? persistedHostId!
      : profiles.find((host) => host.hostId === "local")?.hostId ?? profiles[0]!.hostId;
  const initialWorkspaceRoot = profiles.find((host) => host.hostId === initialHostId)
    ?.workspaceBrowseRoots[0] ?? null;
  const createHostRegistration = (
    profile: HostConnectionProfile,
  ): HostRuntimeRegistration<AppServerWorkbenchRuntime> => ({
    descriptor: profileDescriptor(profile),
    createRuntime: () => {
      if (!hostProfiles.getSnapshot().profiles.some(current => current.hostId === profile.hostId && current.enabled)) throw new Error("此环境当前不可连接，请刷新环境目录。");
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
        runtime = createAppServerWorkbenchRuntime({
        modelSelectionPolicy: options.modelSelectionPolicy,
        hostId: profile.hostId,
        hostKind: profile.hostKind,
        // A provider transport is one physical Client generation. Initial
        // connection cleanup permanently closes it, so retries must acquire a
        // fresh generation from the still-leased provider.
        createTransport: () => providerLease.provider.createTransport(
          normalizedConfig,
          providerContext,
        ),
        autoReconnect: true,
        initialize: {
          clientInfo: { name: "opencraft-workbench", version: "0.1.0" },
          capabilities: {
            experimentalApi: true,
            extensions: {
              [OPENCRAFT_BROWSER_EXTENSION]: OPENCRAFT_BROWSER_CAPABILITY,
            },
          },
        },
        dynamicTools: OPENCRAFT_WORKBENCH_DYNAMIC_TOOLS,
        clientRegistry: appServerRegistry.clients,
        installClientHandlers: (client) => {
          const tools = installWorkbenchDynamicToolHandlers(
            client,
            { browser: browserToolHost, terminal: terminalToolHost, connectors },
            { hostId: profile.hostId },
          );
          const catalog = client.subscribeNotification(notification => {
            if (changesThreadCatalog(notification.method)) void queryClient.invalidateQueries({ queryKey: ["appserver", profile.hostId, "threads"] });
          });
          return () => { catalog(); tools(); };
        },
        });
      } catch (error) {
        providerLease.release();
        throw error;
      }
      const stopQueryRecovery = bindHostQueryRecovery(runtime, profile.hostId, queryClient);
      let disposed = false;
      return {
        ...runtime,
        async connect() {
          if (!hostProfiles.getSnapshot().profiles.some(current => current.hostId === profile.hostId && current.enabled)) throw new Error("此环境当前不可连接，请刷新环境目录。");
          return runtime.connect();
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          stopQueryRecovery();
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
  agentRuntimes.bindRegistry(registry);
  connectBotHost = async hostId => { await registry.ensureConnected(hostId); };
  startupRollback.push(() => registry.dispose());
  const stopEnvironmentRegistry = connectEnvironmentRuntimeRegistry(hostProfiles, registry, createHostRegistration);
  startupRollback.push(stopEnvironmentRegistry);
  const active = registry.getRuntime(initialHostId).getSnapshot();
  const persistedThreadId = rememberedThreadId(
    window.localStorage,
    initialHostId,
    options.hostProfileMode,
  );
  const initialThreadLocation = bootstrapLocation?.kind === "thread"
    ? bootstrapLocation
    : bootstrapLocation === null && persistedThreadId !== null
      ? createWorkbenchThreadLocation(initialHostId, persistedThreadId)
      : null;
  const conversationScopes = createConversationScopeRegistry({
    // A process-local Draft cannot be resurrected from a history ID. Only a
    // durable promotion alias can recover its canonical Thread on bootstrap.
    initialDraft: initialThreadLocation === null
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
  const initialLocation = initialThreadLocation !== null
    ? initialThreadLocation
    : draft !== null
      ? createWorkbenchDraftLocation(active.hostId, draft.id)
      : null;
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
  const navigation = createWorkbenchNavigationTransaction(
    initialLocation,
    conversationActivation,
    conversationScopes,
    {
      ...routerOptions,
      resolveRestoredEntry: createWorkbenchEntryResolver({
        hasHost: hostId => hostProfiles.getSnapshot().profiles.some(profile => profile.enabled && profile.hostId === hostId),
        bindings: conversationBindings,
        scopes: conversationScopes,
        views: conversationViews,
        fallback: () => {
          const current = coordinator.getSnapshot();
          return { location: current.location, routeScopeId: current.viewId === null ? createRouteScopeId() : asRouteScopeId(current.viewId) };
        },
      }),
    },
  );
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
    environmentDirectory,
    authenticationFlows,
    connectors,
    connectorManager,
    connectorApprovals,
    blobs,
    images,
    mode: "active",
    managedHostCatalog: sshManagement,
    cordis,
    appServerRegistry,
    agentRuntimes,
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
        stopEnvironmentRegistry,
        () => navigation.dispose(),
        () => conversationActivation.dispose(),
        () => conversationViews.dispose(),
        () => conversationLeases.dispose(),
        () => conversationScopes.dispose(),
        () => conversationBindings.dispose(),
        () => coordinator.dispose(),
        () => registry.dispose(),
        () => electronAppHost?.close(),
        () => headlessAppHost?.close(),
        () => remoteAppHost?.close(),
        () => sshManagement?.dispose(),
        () => hostProfiles.close(),
        () => queryClient.clear(),
        () => extensionManager.dispose(),
        () => extensionSettings.close(),
        () => sidebarLayout.close(),
        () => extensionInstallationFiber.dispose(),
        () => authenticationFlowFiber.dispose(),
        () => extensions.dispose(),
        () => extensionPersistence.backend.close(),
        () => connectorManager.dispose(),
        () => connectors.dispose(),
        () => connectorApprovals.dispose(),
        () => authenticationFiber.dispose(),
        () => environmentFiber.dispose(),
        () => lightVelaAccount.dispose(),
        disconnectAppearanceThemes,
        () => botDirectory.dispose(),
        () => profileSkills.dispose(),
        () => botSource.dispose(),
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
  const threadManagement = useMemo<AppServerHostCatalog["threadManagement"]>(() => {
    const manager = async (hostId: string, operation: "rename" | "archive" | "delete" | "fork") => {
      const host = await registry.ensureConnected(hostId);
      if (!host.resources.threads.capabilities?.()[operation]) throw new Error("此宿主未接通该会话操作");
      return host.resources.threads;
    };
    return {
      capabilities: hostId => registry.peekRuntime(hostId)?.resources.threads.capabilities?.() ?? { rename: false, archive: false, delete: false, fork: false },
      rename: async (hostId, id, name) => { const port = await manager(hostId, "rename"); await port.rename!(id, name); },
      delete: async (hostId, id) => { const port = await manager(hostId, "delete"); await port.delete!(id); },
      archive: async (hostId, id) => { const port = await manager(hostId, "archive"); await port.archive!(id); },
      unarchive: async (hostId, id) => { const port = await manager(hostId, "archive"); await port.unarchive!(id); },
      fork: async (hostId, id) => { const port = await manager(hostId, "fork"); return (await port.fork!({ threadId: id })).id; },
      listArchived: async hostId => {
        const port = await manager(hostId, "archive");
        const all: Array<{ id: string; name?: string | null; preview?: string }> = [];
        let cursor: string | null = null;
        do { const page = await port.list({ archived: true, cursor, limit: 100 });
          for (const value of page.data) {
            const thread = value as { id?: unknown; name?: string | null; preview?: string };
            if (typeof thread.id !== "string") throw new Error("Invalid archived thread identity");
            all.push({ id: thread.id, name: thread.name, preview: thread.preview });
          }
          cursor = page.nextCursor;
        } while (cursor !== null);
        return all;
      },
    };
  }, [registry]);
  const applicationContextValue = useMemo<AppServerApplicationContextValue>(() => ({
    managedHostCatalog: supervisor.managedHostCatalog,
    hostProfiles,
    agentRuntimes: supervisor.agentRuntimes,
    threadManagement,
    environmentDirectory: supervisor.environmentDirectory,
    authenticationFlows: supervisor.authenticationFlows,
    connectors: supervisor.connectors,
    connectorManager: supervisor.connectorManager,
    connectorApprovals: supervisor.connectorApprovals,
    blobs: supervisor.blobs,
    images: supervisor.images,
    conversationScopes,
    conversationBindings,
    extensionSettings,
    extensionManager,
    extensionContributions: extensions.contributions,
    extensionRuntime: extensions,
    announcements: extensions.announcements,
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
    selectConversation: commands.selectConversation,
    navigateToHome: commands.navigateToHome,
    promoteDraft: commands.promoteDraft,
    submit: commands.submit,
    provisionHost: commands.provisionHost,
    addWebSocketHost: commands.addWebSocketHost,
    removeHost: commands.removeHost,
  }), [
    supervisor.managedHostCatalog,
    hostProfiles,
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
    threadManagement,
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
  /** Current transport route. Not the stable Server identity. */
  readonly connectionHostId: string;
  readonly connectionHostLabel: string;
  readonly serverOrigin: ThreadServerOrigin;
  readonly serverRouteLocality: ServerRouteLocality;
}

/**
 * Application-level sidebar projection. Each Host owns its query and failure;
 * merging happens only after host provenance has been attached.
 */
export function useMultiHostThreadCatalog(): {
  readonly threads: readonly MultiHostWorkbenchThread[];
  readonly isFetching: boolean;
  readonly catalogs: readonly HostThreadCatalogState[];
  readonly retry: (hostId: string) => Promise<void>;
  readonly discovery: "loading" | "error" | null;
  readonly retryDiscovery: () => Promise<void>;
} {
  const application = useContext(ApplicationRuntimeContext);
  const [, setReadinessRevision] = useState(0);
  if (application === null) throw new Error("AppServerRuntimeProvider is missing");
  const management = useSyncExternalStore(
    application.managedHostCatalog?.subscribe ?? subscribeNoManagedCatalog,
    application.managedHostCatalog?.getSnapshot ?? readNoManagedCatalog,
    application.managedHostCatalog?.getSnapshot ?? readNoManagedCatalog,
  );
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
    () => {
      setReadinessRevision(value => value + 1);
    },
  ), [application.registry, hostIds, queryClient]);
  const admitted = hosts.map(host => canReadHostThreadCatalog(
    application.profiles.find(profile => profile.hostId === host.hostId)!,
    application.registry.peekRuntime(host.hostId)?.getSnapshot().phase,
    management,
  ));
  const queries = useQueries({
    queries: hosts.map((host, index) => ({
      // Discovery may attach a reader to an explicitly connected managed
      // Server, but cannot dial an idle remote merely to paint Chat.
      enabled: admitted[index],
      queryKey: sidebarThreadCatalogQueryKey(host.hostId, {
        revision: application.profiles.find(profile => profile.hostId === host.hostId)!.revision,
        authorizationEpoch: host.kind === "remote-ssh" ? application.managedHostCatalog?.getAuthorizationEpoch() ?? null : null,
      }),
      queryFn: async () => {
        return readHostThreadCatalog({
          profile: application.profiles.find(profile => profile.hostId === host.hostId)!,
          currentProfile: () => application.hostProfiles.getSnapshot().profiles.find(profile => profile.hostId === host.hostId),
          management: application.managedHostCatalog,
          registry: application.registry,
        });
      },
      staleTime: 30_000,
      retry: retryQuery,
    })),
  });
  const querySignature = queries.map((query, index) => `${admitted[index]}:${query.dataUpdatedAt}:${query.fetchStatus}`).join("|");
  const threads = useMemo(() => hosts.flatMap((host, index) =>
    (admitted[index] ? queries[index]?.data?.data ?? [] : []).map((thread) => {
      const server = legacyDirectServerProjectionFromHost({
        hostId: host.hostId,
        hostKind: host.kind,
        label: host.label,
      });
      return {
        ...projectAppServerThread(thread),
        connectionHostId: host.hostId,
        connectionHostLabel: host.label,
        ...server,
      };
    })).sort((left, right) => right.updatedAt - left.updatedAt), [hosts, querySignature]);
  return {
    threads,
    discovery: managedCatalogDiscoveryPhase(management),
    retryDiscovery: () => application.managedHostCatalog?.refresh() ?? Promise.resolve(),
    isFetching: queries.some((query) => query.isFetching),
    catalogs: hosts.map((host, index) => ({
      hostId: host.hostId,
      label: host.label,
      phase: threadCatalogPhase({ admitted: admitted[index]!, status: queries[index]!.status, isFetching: queries[index]!.isFetching }),
    })),
    retry: async hostId => {
      // A view may retry its reader, never establish an idle SSH connection
      // or change the selected execution target. Recheck live admission.
      const profile = application.hostProfiles.getSnapshot().profiles.find(profile => profile.hostId === hostId);
      const currentManagement = application.managedHostCatalog?.getSnapshot() ?? management;
      if (!profile || !canReadHostThreadCatalog(profile, application.registry.peekRuntime(hostId)?.getSnapshot().phase, currentManagement)) return;
      await queryClient.refetchQueries({ queryKey: sidebarThreadCatalogQueryKey(hostId, {
        revision: profile.revision,
        authorizationEpoch: profile.hostKind === "remote-ssh" ? application.managedHostCatalog?.getAuthorizationEpoch() ?? null : null,
      }), exact: true, type: "active" }, { cancelRefetch: false });
    },
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
  readonly models: readonly Model[];
  readonly permissionProfiles: readonly PermissionProfileSummary[];
  readonly isFetching: boolean;
  readonly modelError: Error | null;
  readonly permissionProfileError: Error | null;
  readonly newThreadDefaults: {
    readonly model: string | null;
    readonly effort: string | null;
  } | null;
  readonly rememberModelDefaults: ((defaults: {
    readonly model: string;
    readonly effort: string | null;
  }) => void) | undefined;
  readonly onModelMenuOpen: () => void;
  readonly retryModels: () => void;
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
  const enabled = snapshot.phase === "ready";
  const supportsScopedModelCatalog =
    runtime.resources.host.getInitializeResult()?.capabilities?.extensions?.[
      OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION
    ] !== undefined;
  const modelCatalogOwner = supportsScopedModelCatalog ? threadId : null;
  const queryClient = useQueryClient();
  const options = useMemo(() => composerCapabilitiesOptions(snapshot.hostId, modelCatalogOwner, runtime.resources.composerCatalog), [snapshot.hostId, modelCatalogOwner, runtime]);
  const capabilities = useQuery({ ...options, enabled });
  const defaultsWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const defaultsWriteRevision = useRef(0);
  const connectionGeneration = runtime.resources.host.getConnectionGeneration?.() ?? 0;
  const defaultsKey = useMemo(
    () => ["appserver", snapshot.hostId, "composer-new-thread-defaults", connectionGeneration, cwd] as const,
    [connectionGeneration, cwd, snapshot.hostId],
  );
  const defaults = useQuery({
    queryKey: defaultsKey,
    enabled,
    retry: false,
    queryFn: async () => {
      try {
        return {
          supported: true as const,
          ...(await runtime.resources.composerCatalog.readNewThreadDefaults(cwd)),
        };
      } catch (cause) {
        if (cause instanceof AppServerRpcError && cause.code === -32601) {
          return { supported: false as const, model: null, effort: null };
        }
        throw cause;
      }
    },
    staleTime: 60_000,
  });
  const rememberModelDefaults = useCallback((next: {
    readonly model: string;
    readonly effort: string | null;
  }) => {
    if (defaults.data?.supported !== true || runtime.resources.host.canRequest?.("config/batchWrite") === false) return;
    const revision = ++defaultsWriteRevision.current;
    queryClient.setQueryData(defaultsKey, { supported: true as const, ...next });
    defaultsWriteQueue.current = defaultsWriteQueue.current
      .catch(() => undefined)
      .then(() => runtime.resources.composerCatalog.writeNewThreadDefaults(next))
      .then(() => {
        if (defaultsWriteRevision.current === revision) {
          return queryClient.invalidateQueries({ queryKey: defaultsKey });
        }
      })
      .catch(() => {
        if (defaultsWriteRevision.current === revision) {
          void queryClient.invalidateQueries({ queryKey: defaultsKey });
        }
      });
  }, [defaults.data?.supported, defaultsKey, queryClient, runtime]);
  const catalogActions = useMemo(() => ({
    onModelMenuOpen: () => {
      if (!enabled) return;
      const failed = queryClient.getQueryState(options.queryKey)?.error != null;
      void queryClient.fetchQuery({ ...options, ...(failed ? { staleTime: 0 } : {}) }).catch(() => undefined);
    },
    retryModels: () => { if (enabled) void invalidateComposerCapabilities(queryClient, snapshot.hostId).catch(() => undefined); },
  }), [enabled, options, queryClient, snapshot.hostId]);
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
    if (permissionProfiles.hasNextPage && !permissionProfiles.isFetchingNextPage) {
      void permissionProfiles.fetchNextPage();
    }
  }, [
    permissionProfiles.fetchNextPage,
    permissionProfiles.hasNextPage,
    permissionProfiles.isFetchingNextPage,
  ]);

  const permissionProfileData = useMemo(
    () => permissionProfiles.data?.pages.flatMap((page) => page.data) ?? [],
    [permissionProfiles.data],
  );

  return {
    models: capabilities.data?.models ?? [],
    permissionProfiles: permissionProfileData,
    isFetching: capabilities.isFetching || permissionProfiles.isFetching,
    modelError: capabilities.error ? new Error(`${capabilities.data ? "能力目录刷新失败，当前显示上次结果" : "能力目录加载失败"}：${errorOrNull(capabilities.error)!.message}`) : null,
    permissionProfileError: errorOrNull(permissionProfiles.error),
    newThreadDefaults: defaults.data?.supported === true
      ? { model: defaults.data.model, effort: defaults.data.effort }
      : null,
    rememberModelDefaults: defaults.data?.supported === true && runtime.resources.host.canRequest?.("config/batchWrite") !== false
      ? rememberModelDefaults
      : undefined,
    ...catalogActions,
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
 * catalog delays `skills/list` until the user opens `$` (including an empty
 * query); file search still requires text. It shares Host/root-scoped results
 * through TanStack Query and invalidates every cached
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
  const skillRevision = useRef(0);
  const skillListeners = useRef(new Set<() => void>());
  const enabled = snapshot.phase === "ready" || snapshot.phase === "reconnecting";
  const searchStateRef = useRef<{
    key: string;
    session: Promise<FuzzyFileSearchSession> | null;
    pending: PendingMentionSearch | null;
  }>({ key: "", session: null, pending: null });

  useEffect(() => {
    if (!enabled) return;
    return runtime.resources.composerCatalog.subscribeSkillsChanged(() => {
      // A new key prevents an in-flight pre-change response from becoming the
      // current catalog even when the underlying RPC cannot be cancelled.
      skillRevision.current++;
      void queryClient.invalidateQueries({
        queryKey: ["appserver", snapshot.hostId, "skills"],
      });
      for (const listener of [...skillListeners.current]) listener();
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
      if (runtime.resources.host.canRequest?.("fuzzyFileSearch/sessionStart") === false) return Promise.reject(new Error("此连接暂不支持文件搜索"));
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
      subscribeSkillsChanged(listener) {
        skillListeners.current.add(listener);
        return () => { skillListeners.current.delete(listener); };
      },
      async search(query, signal) {
        const text = query.query.trim();
        if (!shouldSearchComposerCatalog(query.kind, text)) return [];
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
          queryKey: ["appserver", snapshot.hostId, "skills", ...roots, skillRevision.current] as const,
          queryFn: async () => {
            const result = await runtime.resources.composerCatalog.listSkills({ cwds: roots, forceReload: false });
            assertSkillDiscoveryAvailable(result);
            return result;
          },
          staleTime: 5 * 60_000,
          gcTime: 5 * 60_000,
        });
        if (signal?.aborted) throw abortError();
        return searchAppServerSkills(response, text, query.limit);
      },
    };
  }, [queryClient, rootKey, runtime, snapshot.hostId]);
}
