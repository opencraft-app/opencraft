import { readSelectionPreference, writeSelectionPreference } from "./selection-preferences";
import { serverStorageKey, serverUrl, serverEndpointNeedsRefresh } from "./server-context";
import { TurnCompletionObserver } from "@opencraft/workbench-runtime";
import { FULL_WORKBENCH_PRESENTATION, type WorkbenchPresentationPolicy } from "../workbench-presentation-policy";
import { ApplicationBrandingRegistry } from "./application-branding";
import { BrowserThreadAttention } from "./browser-thread-attention";
import { BrowserTurnNotifications } from "./browser-turn-notifications";
import { IdentityAvatarContributionRegistry } from "./identity-avatar-contributions";
import { createNewThreadGoalFlow } from "./new-thread-goal";
import { ThreadBadgeContributionRegistry } from "./thread-badge-contributions";
import { ThreadListGroupingContributionRegistry } from "./thread-list-grouping-contributions";
// @refresh reset
import type { Context as CordisContext } from "@deepseek-ai/cordis";
import {
  type CordisAppServerRegistryRuntime
} from "@opencraft/appserver-client";
import {
  type TasksRequestPort
} from "@opencraft/appserver-protocol";
import { BlobResourceService } from "@opencraft/blob-resources";
import {
  AppServerBotDirectory
} from "@opencraft/bot-conversation-appserver";
import {
  asHostId,
  createConversationKey,
} from "@opencraft/chat-core";
import {
  createClientId,
  type ComposerExecutionTarget,
  type SubmissionReceipt,
  type SubmitIntent
} from "@opencraft/composer-core";
import {
  ComposerActionRendererRegistry,
  PlatformViewRendererRegistry,
} from "@opencraft/extension-react";
import {
  ExtensionManager,
  ExtensionSettingsStore,
  ExtensionSupervisor,
  type AnnouncementCenter,
  type ExtensionContributionStore
} from "@opencraft/extension-runtime";
import { ImageProcessingService } from "@opencraft/image-processing";
import { SidebarLayoutStore } from "@opencraft/sidebar-layout";
import {
  AgentRuntimeDirectory,
  AuthenticationFlowService,
  ConnectorApprovalPresentation, ConnectorManager,
  ConnectorRuntime,
  createWorkbenchDraftLocation,
  createWorkbenchSubmissionPipeline,
  createWorkbenchThreadLocation,
  draftSubmissionOwnsNavigation,
  equalWorkbenchLocation,
  HostRuntimeRegistry,
  preflightHostConnection,
  sameWorkInMachine,
  type AgentRuntimeAccess,
  type AppServerWorkbenchRuntime,
  type ConversationActivationCoordinator,
  type ConversationBindingStore,
  type ConversationDisplayContinuity,
  type ConversationScopeLeaseRegistry,
  type ConversationScopeRegistry,
  type ConversationViewRegistry,
  type CordisHostConnectionProviderRuntime,
  type EnvironmentDirectory,
  type HostConnectionProfile,
  type HostConnectionProfileStore,
  type HostConnectionProviderDescriptor,
  type HostRuntimeDescriptor,
  type HostRuntimeRegistration,
  type ProvisionHostInput,
  type WorkbenchCoordinator,
  type WorkbenchLocation
} from "@opencraft/workbench-runtime";
import {
  QueryClient
} from "@tanstack/react-query";
import type { BrowserStorageError } from "./browser-storage-error";
import { type OptionalFeatureStartup } from "./optional-feature-startup";
import { resolveWorkInWorkspace } from "./work-in-workspace";
import { type ApplicationNavigation } from "./workbench-navigation";

import { type ManagedHostCatalogSource } from "./host-thread-catalog";
import { PlatformAccountContributionRegistry } from "./platform-account-contributions";

import { workbenchProductId } from "../workbench-product";
import {
  type WorkbenchHistoryMode,
  type WorkbenchNavigationTransaction
} from "./workbench-navigation-transaction";

// The Context object itself is part of the renderer's hot-reload state.
export interface AppServerHostCatalog {
  readonly setConversationPresentationActive?: (active: boolean) => void;
  readonly tasks: TasksRequestPort | null;
  readonly displayContinuity: BrowserDisplayContinuity;
  readonly extensionRuntime: Pick<ExtensionSupervisor, "subscribe" | "getSnapshot" | "contributions">;
  readonly connectors: ConnectorRuntime;
  readonly connectorManager: ConnectorManager;
  readonly connectorApprovals: ConnectorApprovalPresentation;
  readonly agentRuntimes: AgentRuntimeAccess;
  readonly threadManagement: {
    capabilities(hostId: string, threadId?: string): { fork: boolean; rename: boolean; archive: boolean; delete: boolean; pin?: boolean; reference?: boolean };
    setPinned(hostId: string, threadId: string, pinned: boolean): Promise<void>;
    rename(hostId: string, threadId: string, name: string): Promise<void>;
    delete(hostId: string, threadId: string): Promise<void>;
    fork(hostId: string, threadId: string, lastTurnId?: string): Promise<string>;
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
  readonly threadAttention: BrowserThreadAttention;
  readonly applicationBranding: ApplicationBrandingRegistry;
  readonly threadBadges: ThreadBadgeContributionRegistry;
  readonly threadListGrouping: ThreadListGroupingContributionRegistry;
  readonly identityAvatars: IdentityAvatarContributionRegistry;
  readonly imageEditors?: import("./image-editor-contributions").ImageEditorContributionRegistry;
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
  selectHost(hostId: string, selection?: { model: string; effort: string | null; serviceTier?: string | null }): Promise<void>;
  navigate(location: WorkbenchLocation, mode?: WorkbenchHistoryMode): Promise<boolean>;
  selectConversation(location: WorkbenchLocation): Promise<boolean>;
  promoteDraft(draftId: string, receipt: SubmissionReceipt): Promise<WorkbenchLocation>;
  navigateToHome(options: {
    readonly execution: ComposerExecutionTarget;
    readonly draftId?: string;
    readonly entrypoint?: "home" | "new-chat";
    readonly mode?: WorkbenchHistoryMode;
  }): WorkbenchLocation;
  submit(intent: Parameters<AppServerWorkbenchRuntime["submit"]>[0]): Promise<SubmissionReceipt>;
  createGoal(intent: SubmitIntent, objective: string): Promise<SubmissionReceipt>;
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
  forgetThread(hostId: string, threadId: string): void;
  selectHost(hostId: string, selection?: { model: string; effort: string | null; serviceTier?: string | null }): Promise<void>;
  navigate(location: WorkbenchLocation, mode?: WorkbenchHistoryMode): Promise<boolean>;
  selectConversation(location: WorkbenchLocation): Promise<boolean>;
  navigateToHome(options: {
    readonly execution: ComposerExecutionTarget;
    readonly draftId?: string;
    readonly entrypoint?: "home" | "new-chat";
    readonly mode?: WorkbenchHistoryMode;
  }): WorkbenchLocation;
  promoteDraft(draftId: string, receipt: SubmissionReceipt): Promise<WorkbenchLocation>;
  retargetDraft(draftId: string, execution: ComposerExecutionTarget): void;
  submit(intent: Parameters<AppServerWorkbenchRuntime["submit"]>[0]): Promise<SubmissionReceipt>;
  createGoal(intent: SubmitIntent, objective: string): Promise<SubmissionReceipt>;
  provisionHost(input: ProvisionHostInput): Promise<HostConnectionProfile>;
  addWebSocketHost(input: {
    readonly displayName: string;
    readonly url: string;
    readonly workspaceBrowseRoots?: readonly string[];
  }): Promise<HostConnectionProfile>;
  removeHost(hostId: string): Promise<boolean>;
}

export function appServerUrl(): string {
  const configured = import.meta.env.VITE_APPSERVER_WS_URL as string | undefined;
  if (configured !== undefined && configured.length > 0) return configured;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/appserver`;
}

export function currentWorkbenchPlatform(): "web" | "electron" {
  return (globalThis as typeof globalThis & { opencraftDesktop?: { readonly kind?: string } })
    .opencraftDesktop?.kind === "electron" ? "electron" : "web";
}

export interface WebHostDefinition extends HostRuntimeDescriptor {
  readonly url: string;
}

export function hostDefinitionProfile(host: WebHostDefinition): HostConnectionProfile {
  return {
    hostId: host.hostId,
    displayName: host.label,
    providerId: "opencraft.websocket",
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

export async function refreshBundledHostProfiles(
  store: HostConnectionProfileStore,
  definitions: readonly WebHostDefinition[],
): Promise<void> {
  for (const definition of definitions) {
    const current = store.getSnapshot().profiles.find((profile) => profile.hostId === definition.hostId);
    const providerUrl = current?.providerConfig !== null
      && typeof current?.providerConfig === "object"
      && !Array.isArray(current.providerConfig)
      ? (current.providerConfig as { readonly url?: unknown }).url
      : null;
    if (current === undefined || current.providerId !== "opencraft.websocket") continue;
    const refreshEndpoint = typeof providerUrl === "string" && serverEndpointNeedsRefresh(providerUrl, definition.url);
    if (providerUrl !== definition.url && !refreshEndpoint) continue;
    const refreshRoots = current.workspaceBrowseRoots.length === 0 && definition.workspaceBrowseRoots.length > 0;
    if (!refreshEndpoint && !refreshRoots) continue;
    await store.put({
      ...current,
      ...(refreshEndpoint ? { providerConfig: { ...current.providerConfig as object, url: definition.url } } : {}),
      ...(refreshRoots ? { workspaceBrowseRoots: definition.workspaceBrowseRoots } : {}),
      revision: current.revision + 1,
    });
  }
}

export function profileDescriptor(profile: HostConnectionProfile): HostRuntimeDescriptor {
  return {
    machineIdentity: profile.machineIdentity,
    hostId: profile.hostId,
    label: profile.displayName,
    kind: profile.hostKind,
    transportEndpoint: profile.transportEndpoint,
    executionLocation: profile.executionLocation,
    workspaceBrowseRoots: profile.workspaceBrowseRoots,
  };
}

export function endpointLabel(url: string): string {
  try {
    return new URL(url, window.location.href).host;
  } catch {
    return url;
  }
}

export const hostKinds = new Set<HostRuntimeDescriptor["kind"]>([
  "local",
  "remote-ssh",
  "durable",
  "remote-control",
  "wsl",
]);

export function parseWebHostDefinitions(
  raw: string | undefined,
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
    const parsedUrl = new URL(serverUrl(url), window.location.href);
    const sameOriginPath = url.startsWith("/") && !url.startsWith("//");
    if (sameOriginPath) {
      parsedUrl.protocol = parsedUrl.protocol === "https:" ? "wss:" : "ws:";
    }
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
      url: sameOriginPath ? parsedUrl.href : url,
      kind: kind as HostRuntimeDescriptor["kind"],
    };
  });
}

export function activeThreadStorageKey(hostId: string, accountScope?: string): string {
  return currentProductStorageKey(`opencraft.active-thread-id:${hostId}${accountScope === undefined ? "" : `:account:${encodeURIComponent(accountScope)}`}`);
}

export function rememberedThreadId(
  storage: Pick<Storage, "getItem">,
  hostId: string,
  hostProfileMode: "environment" | "configured" = "environment",
  accountScope?: string,
): string | null {
  const scopedThreadId = readSelectionPreference(storage, activeThreadStorageKey(hostId, accountScope), currentProductStorageKey);
  if (scopedThreadId !== null || hostProfileMode === "configured") return scopedThreadId;
  return readSelectionPreference(storage, currentProductStorageKey("opencraft.active-thread-id"), currentProductStorageKey);
}

export function selectedProjectStorageKey(hostId: string): string {
  return currentProductStorageKey(`opencraft.selected-project-id:${hostId}`);
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
  return serverStorageKey(productStorageKey(workbenchProductId, key));
}

export function currentProductDatabaseName(base: string): string {
  return serverStorageKey(productDatabaseName(workbenchProductId, base));
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

export function getHttpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.response?.status;
  return typeof status === "number" ? status : null;
}

export function retryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 3) return false;
  const status = getHttpStatus(error);
  return status === null || status === 408 || status === 429 || status >= 500;
}

export function createWorkbenchQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: retryQuery,
      },
    },
  });
}


export interface WebWorkbenchApplicationBase {
  readonly setConversationPresentationActive?: (active: boolean) => void;
  readonly connectors: ConnectorRuntime;
  readonly connectorManager: ConnectorManager;
  readonly connectorApprovals: ConnectorApprovalPresentation;
  readonly agentRuntimes: AgentRuntimeDirectory;
  readonly authenticationFlows: AuthenticationFlowService;
  readonly environmentDirectory: EnvironmentDirectory;
  readonly blobs: BlobResourceService;
  readonly images: ImageProcessingService;
  readonly cordis: CordisContext;
  readonly appServerRegistry: CordisAppServerRegistryRuntime;
  readonly turnCompletions: TurnCompletionObserver;
  readonly threadAttention: BrowserThreadAttention;
  readonly turnNotifications: BrowserTurnNotifications;
  readonly connectionProviders: CordisHostConnectionProviderRuntime;
  readonly extensions: ExtensionSupervisor;
  readonly extensionManager: ExtensionManager;
  readonly extensionSettings: ExtensionSettingsStore;
  readonly platformViewRenderers: PlatformViewRendererRegistry;
  readonly platformAccounts: PlatformAccountContributionRegistry;
  readonly applicationBranding: ApplicationBrandingRegistry;
  readonly threadBadges: ThreadBadgeContributionRegistry;
  readonly threadListGrouping: ThreadListGroupingContributionRegistry;
  readonly identityAvatars: IdentityAvatarContributionRegistry;
  readonly imageEditors?: import("./image-editor-contributions").ImageEditorContributionRegistry;
  readonly composerActionRenderers: ComposerActionRendererRegistry;
  readonly botDirectory: AppServerBotDirectory;
  readonly sidebarLayout: SidebarLayoutStore;
  readonly hostProfiles: HostConnectionProfileStore;
  readonly hostProfileStorageError?: BrowserStorageError | null;
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

export interface BrowserDisplayContinuity extends ConversationDisplayContinuity {
  getScope(): string;
  subscribe(listener: () => void): () => void;
}

export interface HostlessWebWorkbenchApplicationSupervisor extends WebWorkbenchApplicationBase {
  readonly mode: "hostless";
  readonly navigation: ApplicationNavigation<null>;
}

export interface ActiveWebWorkbenchApplicationSupervisor extends WebWorkbenchApplicationBase {
  readonly tasks: TasksRequestPort | null;
  readonly displayContinuity: BrowserDisplayContinuity;
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
  readonly pushDevice?: import("./push-device").PushDevicePort;
  /** Trusted product assembly; active only for a server-backed Web workbench. */
  readonly serverExtensions?: readonly import("./server-product-extensions").ServerWorkbenchExtension[];
  readonly isPresentationActive?: () => boolean;
  readonly presentation?: WorkbenchPresentationPolicy;
  /** Product-supplied provider; embedded credentials never enter the generic voice extension. */
  readonly speechInputProvider?: import("@opencraft/plugin-voice-input").SpeechInputProvider;
  /** Internal Application-owned lane; absent keeps full Workbench eager behavior. */
  readonly optionalFeatureStartup?: OptionalFeatureStartup;
  /** Application-owned profiles that must never enter the durable Host store. */
  readonly ephemeralHostProfiles?: readonly HostConnectionProfile[];
  /** Embedded products keep the outer page URL under their host's authority. */
  readonly navigationMode?: "browser" | "memory";
  /** Embedded products may supply one explicit Host without directory discovery. */
  readonly hostProfileMode?: "environment" | "configured";
  readonly modelSelectionPolicy?: import("@opencraft/composer-core").ModelSelectionPolicy;
  readonly readSelectableModels?: import("@opencraft/workbench-runtime").AppServerWorkbenchRuntimeConfig["readSelectableModels"];
  /** Trusted product owns account/engine assembly and its credential cache scope. */
  readonly clientProduct?: import("@opencraft/client-product").ClientWorkbenchProduct;
}

export function readLocalPreference(key: string): string | null {
  try { return readSelectionPreference(window.localStorage, key, currentProductStorageKey); }
  catch { return null; }
}

export function setLocalPreference(key: string, value: string | null): void {
  try {
    writeSelectionPreference(window.localStorage, key, value, currentProductStorageKey);
  } catch {
    // Preferences cannot make an already committed application transaction fail.
  }
}

export async function persistProvisionedHost(
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

export function provisionWebSocketHost(
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
    providerId: "opencraft.websocket",
    providerConfig: { url },
    hostKind: "remote-control",
    transportEndpoint: endpointLabel(url),
    executionLocation: parsedUrl.host,
    workspaceBrowseRoots: host.workspaceBrowseRoots,
  });
}

export function createWebWorkbenchCommands(input: {
  readonly displayContinuity: BrowserDisplayContinuity;
  readonly presentation?: WorkbenchPresentationPolicy;
  readonly threadMemoryScope?: () => string;
  readonly registry: HostRuntimeRegistry<AppServerWorkbenchRuntime>;
  readonly coordinator: WorkbenchCoordinator<AppServerWorkbenchRuntime>;
  readonly activation: ConversationActivationCoordinator<AppServerWorkbenchRuntime>;
  readonly scopes: ConversationScopeRegistry;
  readonly views: ConversationViewRegistry;
  readonly environmentDirectory?: EnvironmentDirectory;
  readonly navigation: WorkbenchNavigationTransaction<AppServerWorkbenchRuntime>;
  readonly queryClient: QueryClient;
  readonly hostProfiles: HostConnectionProfileStore;
  readonly createHostRegistration: (
    profile: HostConnectionProfile,
  ) => HostRuntimeRegistration<AppServerWorkbenchRuntime>;
  readonly connectionProviders: CordisHostConnectionProviderRuntime["providers"];
  readonly onThreadCreated?: (intent: SubmitIntent, receipt: SubmissionReceipt) => Promise<void>;
}): WebWorkbenchCommands {
  const presentation = input.presentation ?? FULL_WORKBENCH_PRESENTATION;
  const assertSelectable = () => { if (presentation.executionSelection === "fixed") throw new Error("The embedding product owns execution selection"); };
  const assertHostConfiguration = () => { if (!presentation.runtimeHostConfiguration) throw new Error("The embedding product owns Host configuration"); };
  const assertTarget = (hostId: string) => {
    if (presentation.executionSelection === "fixed" && input.hostProfiles.getSnapshot().profiles[0]?.hostId !== hostId) throw new Error("The embedding product owns the execution target");
  };
  let commands: WebWorkbenchCommands;
  let submissionPipeline: ReturnType<typeof createWorkbenchSubmissionPipeline>;
  let hostSelectionEpoch = 0;
  const navigateAndRemember = async (location: WorkbenchLocation, action: () => Promise<boolean>) => {
    assertTarget(location.kind === "thread" ? location.key.hostId : location.hostId);
    const epoch = ++hostSelectionEpoch;
    const memoryScope = input.threadMemoryScope?.();
    const activated = await action();
    if (location.kind === "thread" && memoryScope === input.threadMemoryScope?.()
      && input.registry.peekRuntime(location.key.hostId)?.resources.threads.getUnavailableReason?.(location.key.threadId)) {
      commands.forgetThread(location.key.hostId, location.key.threadId);
      return false;
    }
    if (activated && epoch === hostSelectionEpoch && memoryScope === input.threadMemoryScope?.()
      && equalWorkbenchLocation(input.navigation.getSnapshot().location, location)) {
      const hostId = location.kind === "thread" ? location.key.hostId : location.hostId;
      if (presentation.executionSelection === "selectable") setLocalPreference(currentProductStorageKey("opencraft.active-host-id"), hostId);
      setLocalPreference(activeThreadStorageKey(hostId, memoryScope), location.kind === "thread" ? location.key.threadId : null);
    }
    return activated;
  };
  const startGoal = createNewThreadGoalFlow({
    createThread: intent => {
      if (intent.target.type !== "new-thread") throw new Error("Expected a new conversation");
      return input.registry.getRuntime(intent.target.execution.hostId).createThread(intent);
    },
    goals: hostId => input.registry.getRuntime(hostId).resources.goals,
    openThread: async receipt => {
      if (!await commands.navigate(createWorkbenchThreadLocation(receipt.hostId, receipt.threadId))) {
        throw new Error("Goal created; conversation navigation was superseded");
      }
    },
    onThreadCreated: (intent, receipt) => {
      try { void input.onThreadCreated?.(intent, receipt).catch(() => {}); } catch {}
      void input.queryClient.invalidateQueries({ queryKey: ["appserver", receipt.hostId, "threads"] });
    },
  });
  commands = {
    forgetThread(hostId, threadId) {
      // Compare before clearing: a late rejection must not erase a newer choice.
      for (const key of [activeThreadStorageKey(hostId, input.threadMemoryScope?.()), currentProductStorageKey("opencraft.active-thread-id")]) {
        try { if (readLocalPreference(key) === threadId) setLocalPreference(key, null); } catch { /* Preferences are optional. */ }
      }
      const current = input.navigation.getSnapshot();
      const pending = input.coordinator.getSnapshot().pendingLocation;
      if (current.location.kind !== "thread" || current.location.key.hostId !== hostId
        || current.location.key.threadId !== threadId || (pending && !equalWorkbenchLocation(pending, current.location))) return;
      input.navigation.forgetView(current.routeScopeId);
      const surface = current.applicationRoute;
      const cwd = input.hostProfiles.getSnapshot().profiles.find(profile => profile.hostId === hostId)?.workspaceBrowseRoots[0] ?? null;
      commands.navigateToHome({ execution: { hostId: asHostId(hostId), workspace: {
        cwd, runtimeWorkspaceRoots: cwd ? [cwd] : [],
      } }, mode: "replace" });
      if (surface.kind === "settings") input.navigation.openSettings(surface.slug, "replace");
      else if (surface.kind === "extension-view") input.navigation.openExtensionView(surface.viewId, surface.resourceUri);
    },
    createGoal(intent, objective) {
      if (intent.target.type !== "new-thread") throw new Error("Expected a new conversation");
      assertTarget(intent.target.execution.hostId);
      const target = intent.target;
      const origin = input.navigation.getSnapshot().revision;
      const memoryScope = input.threadMemoryScope?.();
      return startGoal(intent, objective, () => origin === input.navigation.getSnapshot().revision
        && memoryScope === input.threadMemoryScope?.()
        && input.scopes.getActiveDraft()?.target === target);
    },
    async selectHost(hostId, selection) {
      assertSelectable();
      const epoch = ++hostSelectionEpoch;
      const origin = input.navigation.getSnapshot().revision;
      input.activation.cancelPending();
      if (!input.hostProfiles.getSnapshot().profiles.some(profile => profile.hostId === hostId && profile.enabled)) throw new Error("此环境当前不可连接，请刷新环境目录。");
      const activeDraft = input.scopes.getActiveDraft();
      if (activeDraft !== null && draftSubmissionOwnsNavigation(activeDraft.phase)) {
        throw new Error("The execution node cannot change while the first turn is being submitted");
      }
      let runtime: AppServerWorkbenchRuntime;
      try { runtime = await input.registry.ensureConnected(hostId); }
      catch (error) { if (epoch !== hostSelectionEpoch) return; throw error; }
      const profiles = input.hostProfiles.getSnapshot().profiles;
      const sameMachine = activeDraft !== null && sameWorkInMachine(
        profiles.find(profile => profile.hostId === activeDraft.target.execution.hostId),
        profiles.find(profile => profile.hostId === hostId), input.environmentDirectory?.getSnapshot().entries);
      let workspace = activeDraft?.target.execution.workspace ?? { cwd: null, runtimeWorkspaceRoots: [] };
      if (!sameMachine && workspace.cwd !== null) {
        const resolved = await resolveWorkInWorkspace(workspace, runtime.resources, () => epoch === hostSelectionEpoch
          && origin === input.navigation.getSnapshot().revision && input.scopes.getActiveDraft()?.target === activeDraft?.target);
        if (resolved === null) return;
        workspace = resolved;
      }
      if (epoch !== hostSelectionEpoch || origin !== input.navigation.getSnapshot().revision
        || input.scopes.getActiveDraft()?.id !== activeDraft?.id
        || input.scopes.getActiveDraft()?.target !== activeDraft?.target) return;
      if (activeDraft !== null && activeDraft.target.execution.hostId !== hostId) {
        const nextDraft = input.scopes.openDraft({
          activate: false,
          entrypoint: activeDraft.entrypoint,
          execution: {
            hostId: asHostId(hostId),
            workspace,
          },
        });
        const previousViewId = input.coordinator.getSnapshot().viewId;
        const previousComposer = previousViewId === null ? null : input.views.get(previousViewId)?.composer;
        try {
          const activated = await input.navigation.navigate(
            createWorkbenchDraftLocation(hostId, nextDraft.id),
            "replace",
          );
          if (!activated) { input.scopes.dismissDraft(nextDraft.id); return; }
          const nextViewId = input.coordinator.getSnapshot().viewId;
          const nextComposer = nextViewId === null ? null : input.views.get(nextViewId)?.composer;
          if (nextComposer && previousComposer) {
            const previous = previousComposer.getSnapshot().draft;
            nextComposer.dispatch({ type: "replace-content", document: previous.document,
              attachments: previous.attachments.map(attachment => {
                const interrupted = attachment.lifecycle === "pending" || attachment.lifecycle === "uploading" || attachment.lifecycle === "processing";
                const movedHostFile = !sameMachine && attachment.uri?.startsWith("file:") === true;
                return { ...attachment,
                  ...(interrupted || movedHostFile ? { lifecycle: "failed" as const, error: null } : {}),
                  metadata: { ...attachment.metadata, attachmentHostId: attachment.metadata?.attachmentHostId ?? activeDraft.target.execution.hostId,
                    ...(interrupted ? { workInAttachmentError: "interrupted" } : movedHostFile ? { workInAttachmentError: "machine-changed" } : {}) },
                };
              }), context: previous.context });
            nextComposer.dispatch({ type: "set-selections", patch: { ...previous.selections, cwd: workspace.cwd ?? undefined } });
            nextComposer.dispatch({ type: "set-options", patch: previous.options });
            if (selection) nextComposer.dispatch({ type: "set-selections", patch: { model: selection.model, effort: selection.effort ?? undefined, ...(selection.serviceTier === undefined ? {} : { serviceTier: selection.serviceTier }) } });
          }
          input.scopes.dismissDraft(activeDraft.id);
        } catch (error) {
          input.scopes.dismissDraft(nextDraft.id);
          if (epoch === hostSelectionEpoch && origin === input.navigation.getSnapshot().revision
            && input.scopes.getDraft(activeDraft.id)) input.scopes.activateDraft(activeDraft.id);
          throw error;
        }
      }
      if (epoch !== hostSelectionEpoch) return;
      if (activeDraft?.target.execution.hostId === hostId && selection) {
        const viewId = input.coordinator.getSnapshot().viewId;
        if (viewId !== null) input.views.get(viewId)?.composer.dispatch({ type: "set-selections", patch: { model: selection.model, effort: selection.effort ?? undefined, ...(selection.serviceTier === undefined ? {} : { serviceTier: selection.serviceTier }) } });
      }
      input.coordinator.setSelectedHostId(hostId);
      if (presentation.executionSelection === "selectable") setLocalPreference(currentProductStorageKey("opencraft.active-host-id"), hostId);
    },
    navigate(location, mode = "push") {
      return navigateAndRemember(location, () => input.navigation.navigate(location, mode));
    },
    selectConversation(location) {
      return navigateAndRemember(location, () => input.navigation.selectConversation(location));
    },
    navigateToHome(options) {
      assertTarget(options.execution.hostId);
      ++hostSelectionEpoch;
      const draft = input.scopes.openDraft({
        execution: options.execution,
        draftId: options.draftId,
        entrypoint: options.entrypoint,
      });
      const location = createWorkbenchDraftLocation(options.execution.hostId, draft.id);
      try {
        const activated = input.navigation.navigateToHome(location, options.mode);
        if (!activated) throw new Error(`Draft ${draft.id} activation was superseded`);
        input.coordinator.setSelectedHostId(options.execution.hostId);
        if (presentation.executionSelection === "selectable") setLocalPreference(currentProductStorageKey("opencraft.active-host-id"), options.execution.hostId);
        setLocalPreference(activeThreadStorageKey(options.execution.hostId, input.threadMemoryScope?.()), null);
        return location;
      } catch (error) {
        input.scopes.dismissDraft(draft.id);
        throw error;
      }
    },
    async promoteDraft(draftId, receipt) {
      assertTarget(receipt.hostId);
      ++hostSelectionEpoch;
      const memoryScope = input.threadMemoryScope?.();
      const location = await input.navigation.promoteDraft(draftId, receipt);
      if (memoryScope !== input.threadMemoryScope?.()) throw new Error("Conversation account scope was retired");
      setLocalPreference(activeThreadStorageKey(receipt.hostId, memoryScope), receipt.threadId);
      if (presentation.executionSelection === "selectable") setLocalPreference(currentProductStorageKey("opencraft.active-host-id"), receipt.hostId);
      return location;
    },
    retargetDraft(draftId, execution) {
      assertSelectable();
      ++hostSelectionEpoch;
      input.activation.cancelPending();
      input.activation.retargetDraft(draftId, execution);
    },
    async submit(intent) {
      assertTarget(intent.target.type === "new-thread" ? intent.target.execution.hostId : intent.target.key.hostId);
      return submissionPipeline.submit(intent);
    },
    async provisionHost(host) {
      assertHostConfiguration();
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
      assertHostConfiguration();
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
    async submitNewThread(intent) {
      if (intent.target.type !== "new-thread") throw new Error("Expected a New Thread intent");
      const displayScope = input.displayContinuity.getScope();
      const receipt = await input.registry.getRuntime(intent.target.execution.hostId).createThread(intent);
      if (displayScope === input.displayContinuity.getScope()) {
        // Presentation failure must not turn an irreversible receipt into a
        // failed submission and replay thread/start on retry.
        try { input.displayContinuity.retainSubmission(intent, receipt); }
        catch { console.warn("[conversation-display] Could not retain first submission"); }
      }
      // Link recovery must never turn an irreversible thread receipt into a
      // failed thread/start or cause the submission pipeline to replay it.
      try { void input.onThreadCreated?.(intent, receipt).catch(() => {}); } catch {}
      return receipt;
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
      if (receipt.disposition === "local-queue") return;
      await input.queryClient.invalidateQueries({
        queryKey: ["appserver", receipt.hostId, "threads"],
      });
    },
  });
  return commands;
}

export class BoundedCheckpointMap extends Map<string, unknown> {
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
