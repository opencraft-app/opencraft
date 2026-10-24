import { SERVER_CONNECTIONS_ID, migrateServerConnectionProfiles } from "@opencraft/plugin-builtin-agents/server-connection-identity";
import { migrateBuiltinConnectionProfiles, resolveBuiltinConnectionRoute } from "./builtin-connection-compatibility";
import { BrowserHeadlessConnectors, connectorApprovals as createConnectorApprovals } from "./headless-connectors";
import { installClientObservation } from "./observability";
import { tokenUsageBuiltin } from "./token-usage-builtin";
import { createHostComposerCommandPort } from "@opencraft/workbench-runtime";
import { ThreadParticipationContributionRegistry } from "./thread-participation-contributions";
import { createBrowserConversationOutbox } from "./browser-conversation-outbox";
import { bindSidebarLayoutPersistReporting } from "../runtime-error-reporting";
import { serverAdmissionOrigin, serverFetch, serverStorageKey } from "./server-context";
import { displayTimingCounts } from "./display-timing-diagnostics";
import { reportDisplayEvent, reportRecoveryEvent } from "./recovery-diagnostics";
import { TurnCompletionObserver, WORKBENCH_RESOURCE_POLICIES } from "@opencraft/workbench-runtime";
import { ApplicationBrandingRegistry } from "./application-branding";
import { createApplicationDisposer, disposeOwnedSteps } from "./application-disposal";
import { BrowserThreadAttention } from "./browser-thread-attention";
import { BrowserTurnNotifications } from "./browser-turn-notifications";
import { FixedHostProfileStore } from "./fixed-host-profile-store";
import { ImageEditorContributionRegistry } from "./image-editor-contributions";
import { IdentityAvatarContributionRegistry } from "./identity-avatar-contributions";
import { LocalAccountPreferences } from "./local-account-preferences";
import { ThreadBadgeContributionRegistry } from "./thread-badge-contributions";
import { bindThreadCatalogNotifications } from "./thread-catalog-notifications";
import { ThreadListGroupingContributionRegistry } from "./thread-list-grouping-contributions";
// @refresh reset
import type { Context as CordisContext } from "@deepseek-ai/cordis";
import { createCordisAppServerRegistry, JsonRpcAppServerClient } from "@opencraft/appserver-client";
import {
  TASKS,
  type TasksRequestPort
} from "@opencraft/appserver-protocol";
import { BlobResourceService } from "@opencraft/blob-resources";
import { IndexedDbBlobStorage } from "@opencraft/blob-resources/browser";
import {
  AppServerBotConversationResolver,
  AppServerBotConversationSource,
  AppServerBotDirectory,
  createCordisBotConversationRuntime,
} from "@opencraft/bot-conversation-appserver";
import {
  OPENCRAFT_BROWSER_CAPABILITY,
  OPENCRAFT_BROWSER_EXTENSION,
  type BrowserDynamicToolHost,
} from "@opencraft/browser-appserver";
import {
  asHostId
} from "@opencraft/chat-core";
import {
  createClientId
} from "@opencraft/composer-core";
import {
  ComposerActionRendererRegistry,
  PlatformViewRendererRegistry,
} from "@opencraft/extension-react";
import {
  ExtensionManager,
  ExtensionSettingsStore,
  ExtensionSupervisor,
  provideExtensionInstallationRepository
} from "@opencraft/extension-runtime";
import { ImageProcessingService } from "@opencraft/image-processing";
import { processBrowserImage } from "@opencraft/image-processing/browser";
import { createCordisProfileSkillsRuntime } from "@opencraft/profile-skills-appserver";
import { SidebarLayoutStore } from "@opencraft/sidebar-layout";
import {
  AgentRuntimeDirectory,
  asRouteScopeId,
  AUTHENTICATION_PROVIDER_CHANNEL,
  AuthenticationFlowService,
  AuthenticationService,
  connectEnvironmentRuntimeRegistry,
  CONNECTOR_PROVIDER_CHANNEL,
  ConnectorApprovalQueue, ConnectorManager,
  ConnectorRuntime,
  createAppServerWorkbenchRuntime,
  createConversationActivationCoordinator,
  createConversationDisplayContinuity,
  createConversationDraftContinuity,
  createConversationScopeLeaseRegistry,
  createConversationScopeRegistry,
  createConversationViewRegistry,
  createCordisHostConnectionProviderRuntime,
  createThreadViewFrameScheduler,
  createWorkbenchCoordinator,
  createWorkbenchDraftLocation,
  createWorkbenchThreadLocation,
  ENVIRONMENT_SOURCE_CHANNEL,
  EnvironmentDirectoryService,
  EnvironmentProfileStore,
  HOST_PROFILE_CONTRIBUTION_CHANNEL,
  HostRuntimeRegistry,
  legacyDirectServerProjectionFromHost,
  openHostDocumentPersistence,
  type AppServerWorkbenchRuntime,
  type ConversationBindingStore,
  type ConversationTerminalToolHost,
  type HostConnectionProfile,
  type HostConnectionProfileStore,
  type HostRuntimeRegistration,
  type ProvisionHostInput,
  type WorkbenchLocation
} from "@opencraft/workbench-runtime";
import { installAppServerDiagnostics } from "./appserver-diagnostics";
import { authenticationProviderAdapter } from "./authentication-contributions";
import { BrowserComposerDrafts } from "./browser-composer-drafts";
import { openClientExtensionPersistence } from "./client-extension-persistence";
import { changesComposerCapabilities, invalidateComposerCapabilities } from "./composer-capabilities-query";
import { openConnectorConfigurationStore } from "./connector-configuration-store";
import { connectorProviderAdapter } from "./connector-contributions";
import { connectElectronAppHost } from "./electron-app-host";
import { environmentSourceAdapter } from "./environment-directory/contribution-adapter";
import { HostMachineIdentityObserver } from "./host-machine-identity";
import { openHostProfiles } from "./host-profile-bootstrap";
import { IndexedDbSidebarLayoutStorage } from "./indexeddb-sidebar-layout-storage";
import { LocalClientPersistenceScope } from "./local-client-persistence-scope";
import { BrowserModuleUrlExtensionLoader } from "./module-url-extension-loader";
import { loadOptionalFeatureModule } from "./optional-feature-startup";
import { ServerManagedProfileStore } from "./server-managed-profile-store";
import { TaskConversationFlow, taskConversationContext } from "./task-conversation-flow";
import { useVoiceInputPreference } from "./use-voice-input-preference";
import { parseWebDeploymentConfig, resolveLegacyWebsiteLocation, resolveWebDeploymentConfig, restoreLegacyWebsiteSelection } from "./web-deployment-config";
import { webSshDiscoveryLifecycle } from "./web-ssh-discovery";
import { connectWebSocketAppHost } from "./websocket-app-host";
import {
  BuiltinWebSocketHostConnectionExtension,
  createHostConnectionProviderContributionAdapter,
} from "./websocket-host-connection-provider";
import {
  installWorkbenchDynamicToolHandlers,
  OPENCRAFT_WORKBENCH_DYNAMIC_TOOLS,
} from "./workbench-dynamic-tools";
import { createWorkbenchEntryResolver, resolveRetainedWorkbenchLocation } from "./workbench-location-restoration";
import { type ApplicationRoute, createApplicationNavigation, createRouteScopeId, parseApplicationRouteUrl, readWorkbenchBootstrapLocation } from "./workbench-navigation";

import { BuiltinThemePackExtension } from "./builtin-theme-extension";
import { createComposerActionRendererContributionAdapter } from "./composer-action-renderers";
import { HostProfileContributionRegistry } from "./host-profile-contributions";
import { PlatformAccountContributionRegistry } from "./platform-account-contributions";
import { createPlatformViewRendererContributionAdapter } from "./platform-view-renderers";

import { connectAppearanceThemeContributions } from "../appearance-theme";
import { workbenchProductId } from "../workbench-product";
import { createBrowserConversationDraftStorage } from "./browser-conversation-drafts";
import { bindHostQueryRecovery } from "./host-query-recovery";
import {
  createWorkbenchNavigationTransaction
} from "./workbench-navigation-transaction";

import { appServerUrl, BoundedCheckpointMap, BrowserDisplayContinuity, createWebWorkbenchCommands, createWorkbenchQueryClient, currentProductDatabaseName, currentProductStorageKey, readLocalPreference, currentWorkbenchPlatform, hostDefinitionProfile, HostlessWebWorkbenchApplicationSupervisor, parseWebHostDefinitions, persistProvisionedHost, profileDescriptor, provisionWebSocketHost, refreshBundledHostProfiles, rememberedThreadId, WebWorkbenchApplicationSupervisor, WebWorkbenchSupervisorOptions } from './workbench-application-services';
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
  let taskConversationFlow: TaskConversationFlow | undefined;
  let prepareTaskConversation: ((taskId: string, hostId: string) => Promise<void>) | undefined;
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
    const turnCompletions = new TurnCompletionObserver(appServerRegistry.clients);
    startupRollback.push(() => turnCompletions.dispose());
    const turnNotifications = new BrowserTurnNotifications(undefined, options.pushDevice);
    startupRollback.push(() => turnNotifications.dispose());
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
    const threadAttention = new BrowserThreadAttention(appServerRegistry.clients, turnCompletions,
      platformAccounts, window.localStorage, currentProductStorageKey("opencraft.thread-read.v1"),
      Number(import.meta.env.VITE_THREAD_UNREAD_RESET_BEFORE) || 0);
    startupRollback.push(() => threadAttention.dispose());
    const applicationBranding = new ApplicationBrandingRegistry();
    const threadBadges = new ThreadBadgeContributionRegistry();
    const threadParticipation = new ThreadParticipationContributionRegistry();
    const threadListGrouping = new ThreadListGroupingContributionRegistry();
    const identityAvatars = new IdentityAvatarContributionRegistry();
    const authenticationFiber = cordis.plugin(AuthenticationService);
    startupRollback.push(() => authenticationFiber.dispose());
    await authenticationFiber;
    const headlessConnectors = await BrowserHeadlessConnectors.open();
    startupRollback.push(() => headlessConnectors.dispose());
    const connectorApprovals = createConnectorApprovals(headlessConnectors);
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
    }, headlessConnectors);
    startupRollback.push(() => connectorManager.dispose());
    const authenticationFlowFiber = cordis.plugin(AuthenticationFlowService);
    startupRollback.push(() => authenticationFlowFiber.dispose());
    await authenticationFlowFiber;
    const authenticationFlows = cordis.authenticationFlows;
    const composerActionRenderers = new ComposerActionRendererRegistry();
    const imageEditors = new ImageEditorContributionRegistry();
    const platform = currentWorkbenchPlatform();
    const websiteConfig = platform === "web" ? parseWebDeploymentConfig(
        document.getElementById("opencraft-deployment-config")?.textContent ?? null,
      ) : null;
    const deployment = resolveWebDeploymentConfig(
      websiteConfig,
      {
        hosts: import.meta.env.VITE_APPSERVER_HOSTS_JSON,
        builtinAgents: import.meta.env.VITE_WEB_BUILTIN_AGENTS,
        hypernode: import.meta.env.VITE_HYPERNODE_PLUGIN,
        extensions: import.meta.env.VITE_WEB_EXTENSIONS,
      },
    );
    const bootstrapDefinitions = parseWebHostDefinitions(
      platform === "web" ? deployment.hosts : import.meta.env.VITE_APPSERVER_HOSTS_JSON as string | undefined,
    );
    const electronAppHost = platform === "electron" ? connectElectronAppHost() : null;
    if (electronAppHost !== null) startupRollback.push(() => electronAppHost.close());
    const headlessAppHost = platform === "web" && import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST === "true"
      ? connectWebSocketAppHost() : null;
    if (headlessAppHost !== null) startupRollback.push(() => headlessAppHost.close());
    const sshManagement = headlessAppHost ? new (await import("@opencraft/plugin-builtin-agents")).SshConnectionsController(serverFetch, serverAdmissionOrigin()) : null;
    if (sshManagement) { startupRollback.push(() => sshManagement.dispose()); await sshManagement.startDiscovery(webSshDiscoveryLifecycle); }
    const remoteAppHost = headlessAppHost ? connectWebSocketAppHost(undefined, {
      path: "/ssh-apphost",
      beforeConnect: () => sshManagement!.prepareConnection(),
    }) : null;
    if (remoteAppHost) startupRollback.push(() => remoteAppHost.close());
    const clientProduct = await options.clientProduct?.create({ platform, hostProfileMode: options.hostProfileMode, defaultExtensions: deployment.extensions });
    if (clientProduct) startupRollback.push(() => clientProduct.dispose());
    const localClientScope = clientProduct?.persistenceScope ? null : new LocalClientPersistenceScope(platformAccounts, serverStorageKey("local"));
    if (localClientScope) startupRollback.push(() => localClientScope.dispose());
    const clientPersistenceScope = clientProduct?.persistenceScope ?? localClientScope!;
    // Existing task View continuity remains its sole persistence owner. Bot
    // content uses a separate account-bound adapter; an old account cannot
    // read or write through it after its credential scope is revoked.
    const botDraftScope = clientPersistenceScope.getSnapshot().namespace;
    const botDrafts = new BrowserComposerDrafts(window.localStorage,
      currentProductStorageKey(`opencraft.composer-drafts.v1.bot.${botDraftScope}`));
    const stopBotDraftScope = clientPersistenceScope.subscribe(() => {
      if (clientPersistenceScope.getSnapshot().namespace !== botDraftScope) botDrafts.revokeAndClear();
    });
    startupRollback.push(stopBotDraftScope);
    const extensionPersistence = await openClientExtensionPersistence(currentProductDatabaseName);
    startupRollback.push(() => extensionPersistence.backend.close());
    const extensions = new ExtensionSupervisor({
      persistence: extensionPersistence.backend,
      localPreferences: new LocalAccountPreferences(currentProductStorageKey("extensions"), () => window.localStorage, window).open,
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
        applicationBranding: applicationBranding.createAdapter(),
        threadBadge: threadBadges.createAdapter(),
        threadParticipation: threadParticipation.createAdapter(),
        threadListGrouping: threadListGrouping.createAdapter(),
        identityAvatar: identityAvatars.createAdapter(),
        imageEditor: imageEditors.createAdapter(),
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
      databaseName: currentProductDatabaseName("opencraft-sidebar-layout-v2"),
      formerDatabaseName: currentProductDatabaseName("vela-sidebar-layout-v2"),
    });
    const sidebarLayout = await SidebarLayoutStore.open(sidebarLayoutStorage);
    const stopSidebarLayoutPersistReporting = bindSidebarLayoutPersistReporting(sidebarLayout);
    startupRollback.push(() => sidebarLayout.close());
    startupRollback.push(stopSidebarLayoutPersistReporting);
    await extensions.activate(BuiltinWebSocketHostConnectionExtension);
    await extensions.activateOptional(BuiltinThemePackExtension);
    const loadPresentationExtension = async (
      id: string,
      load: (signal?: AbortSignal) => ReturnType<Parameters<ExtensionSupervisor["loadOptional"]>[1]>,
      initialViewIds: readonly string[] = [],
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
      const route = parseApplicationRouteUrl(new URL(window.location.href));
      const ownsInitialRoute = route.kind === "extension-view" && initialViewIds.includes(route.viewId);
      // A deep-linked surface is required for its first paint. Deferring its
      // registration lets the Shell mistake it for an unavailable extension.
      if (options.optionalFeatureStartup !== undefined && !ownsInitialRoute) {
        options.optionalFeatureStartup.add(id, activate);
      } else {
        await activate();
      }
    };
    await extensions.loadOptional("opencraft.overhome", async () => {
      const { createOverhomeExtension } = await import("./overhome-extension");
      return createOverhomeExtension(extensions.contributions, platformViewRenderers);
    });
    await extensions.loadOptional("opencraft.schedules", async () => {
      const { conversationSchedulesExtension } = await import("./conversation-schedules-extension");
      return conversationSchedulesExtension;
    });
    if (import.meta.env.VITE_INCLUDE_TASKS_PLUGIN === "true") {
      await loadPresentationExtension("opencraft.tasks", async signal => {
        const { createTasksExtension } = await import("@opencraft/plugin-tasks");
        signal?.throwIfAborted();
        return createTasksExtension({
          followUpDwellSince: Number(import.meta.env.VITE_TASKS_DWELL_SINCE ?? 0),
          conversationOverview: {
            async read(...args) {
              const { createConversationOverviewPort } = await import("./conversation-overview");
              args[1].throwIfAborted();
              return createConversationOverviewPort({
                getClient: id => appServerRegistry.clients.get(id),
                participation: () => threadParticipation.getSnapshot().contribution,
              }).read(...args);
            },
          },
          storageHostId: platform === "electron" ? "local-codex" : headlessAppHost ? "opencraft-server" : bootstrapDefinitions[0]?.hostId ?? null,
          request: (hostId, method, params) => agentRuntimes.request(hostId, method, params),
          prepareConversation: (taskId, hostId) => {
            if (!prepareTaskConversation) return Promise.reject(new Error("Workbench not ready"));
            return prepareTaskConversation(taskId, hostId);
          },
          pendingConversationLinks: () => taskConversationFlow?.pending() ?? [],
          retryConversationLinks: async taskId => { await taskConversationFlow?.retry(taskId); },
          listThreads: async (hostId, search) => {
            const page = await agentRuntimes.request(hostId, "thread/list", { limit: 100, searchTerm: search || null, archived: false });
            return page.data.map(thread => ({ id: thread.id, title: thread.name?.trim() || thread.preview?.trim() || thread.id }));
          },
          listProjects: async hostId => {
            const result = await agentRuntimes.request(hostId, "project/list", {});
            return result.data.map(project => ({ id: project.id, title: project.name }));
          },
          readConversation: async (hostId, threadId) => {
            const { thread } = await agentRuntimes.request(hostId, "thread/read", { threadId, includeTurns: false });
            const status = thread.status;
            const type = status && typeof status === "object" && "type" in status ? status.type : null;
            const flags = status && typeof status === "object" && "activeFlags" in status ? status.activeFlags : null;
            const waiting = Array.isArray(flags) && flags.some(flag => flag === "waitingOnApproval" || flag === "waitingOnUserInput");
            return {
              title: typeof thread.name === "string" && thread.name.trim() ? thread.name.trim() : (typeof thread.preview === "string" ? thread.preview.trim() : "") || thread.id,
              state: type === "active" ? waiting ? "waiting" : "running"
                : type === "idle" ? "idle" : type === "systemError" ? "failed" : "unknown",
            };
          },
          subscribe: listener => {
            const flowStop = taskConversationFlow?.subscribe(() => listener("tasks"));
            const subscriptions = new Map<string, () => void>();
            const bind = (client: ReturnType<typeof appServerRegistry.clients.getOrThrow>) => {
              subscriptions.get(client.hostId)?.();
              const notifications = client.subscribeNotification(notification => {
                if (notification.method === "opencraft/tasks/changed") listener("tasks");
                else if (notification.method.startsWith("thread/") || notification.method.startsWith("turn/")) listener("activity");
              });
              const status = client.subscribeStatus(() => { listener("activity"); listener("tasks"); });
              subscriptions.set(client.hostId, () => { notifications(); status(); });
            };
            for (const client of appServerRegistry.clients.getAll()) bind(client);
            const stop = appServerRegistry.clients.subscribeEvent(event => {
              if (event.type === "added") bind(event.client);
              else { subscriptions.get(event.hostId)?.(); subscriptions.delete(event.hostId); }
              listener("activity"); listener("tasks");
            });
            return () => { flowStop?.(); stop(); for (const dispose of subscriptions.values()) dispose(); subscriptions.clear(); };
          },
        });
      }, ["opencraft.tasks.board"]);
    }
    await loadPresentationExtension("opencraft.image-editor", async signal => {
      const { createImageEditorExtension } = await import("@opencraft/plugin-image-editor");
      signal?.throwIfAborted();
      return createImageEditorExtension();
    });
    await loadPresentationExtension("opencraft.voice-input", async signal => {
      const createVoiceInputExtension = (
        await import("@opencraft/plugin-voice-input/runtime-entry")
      ).default;
      signal?.throwIfAborted();
      return createVoiceInputExtension(options.speechInputProvider, options.speechInputProvider
        ? {} : platform === "web" ? { webSpeech: { usePreferences: useVoiceInputPreference, fetcher: serverFetch } } : {});
    });
    if (import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN === "true"
      && (platform === "electron" || deployment.builtinAgents)) {
      await extensions.loadOptional("opencraft.builtin-agents", async () => {
        const { createBuiltinAgentsExtension } = await import("@opencraft/plugin-builtin-agents");
        const requestHost: Parameters<typeof createBuiltinAgentsExtension>[0]["requestHost"] = async (hostId, method, params) => {
          const result = await agentRuntimes.request(hostId, method, params);
          if (changesComposerCapabilities(method)) {
            // UI requests start after application construction. Invalidate the
            // existing host-scoped catalog owner, never a session's selection.
            void invalidateComposerCapabilities(queryClient, hostId).catch(() => undefined);
          }
          return result;
        };
        return platform === "web"
          ? createBuiltinAgentsExtension({ platform: "web", requestHost, includeCodexAccounts: headlessAppHost === null })
          : createBuiltinAgentsExtension({
            requestHost,
            createTransport: (hostId) => {
              if (electronAppHost === null) throw new Error("Electron App Host is unavailable");
              return electronAppHost.createTransport(hostId);
            },
          });
      });
    }
    if (import.meta.env.VITE_INCLUDE_HEADLESS_MODEL_SERVICES === "true") {
      await extensions.loadOptional("opencraft.headless-model-services", async () => {
        const { createHeadlessModelServicesExtension } = await import("@opencraft/plugin-builtin-agents");
        return createHeadlessModelServicesExtension({
          hostId: "opencraft-server",
          requestHost: (hostId, method, params) => agentRuntimes.request(hostId, method, params),
        });
      });
    }
    if (headlessAppHost !== null) {
      await extensions.loadOptional("opencraft.im", async () => {
        const { createImExtension } = await import("@opencraft/plugin-im");
        return createImExtension(serverFetch);
      });
      for (const extension of options.serverExtensions ?? []) {
        await extensions.loadOptional(extension.id, () => extension.load({
          fetcher: serverFetch,
          getClient: hostId => appServerRegistry.clients.get(hostId) ?? undefined,
        }));
      }
      await extensions.loadOptional(SERVER_CONNECTIONS_ID, async () => {
        const { readSshServerCatalog } = await import("./ssh-server-catalog");
        // Only this headless product queries its backend catalog. Credentials,
        // host-key trust and remote commands never enter a Renderer profile.
        const sshServers = await readSshServerCatalog();
        const { createHeadlessServerExtension } = await import("@opencraft/plugin-builtin-agents");
        return createHeadlessServerExtension({
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
    if (import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN !== "false" && deployment.hypernode) {
      await extensions.loadOptional("opencraft.hypernode", async () => {
        const { createHyperNodeExtension } = await import("@opencraft/plugin-hypernode");
        return createHyperNodeExtension({ url: appServerUrl() });
      });
    }
    for (const definition of clientProduct?.extensions({
      appServerClients: appServerRegistry.clients,
      profileSkills: profileSkills.service,
      profileDirectory: botDirectory,
    }) ?? []) await extensions.activateOptional(definition);
    await clientProduct?.preflight?.();
    const botSource = new AppServerBotConversationSource(botConversations.service);
    startupRollback.push(() => botSource.dispose());
    await loadPresentationExtension("opencraft.bot-chat", async signal => {
      const createBotChatExtension = (
        await import("@opencraft/plugin-bot-chat/runtime-entry")
      ).default;
      signal?.throwIfAborted();
      return createBotChatExtension({
        source: botSource,
        resolver: new AppServerBotConversationResolver(botConversations.service),
        showNavigation: false,
        drafts: botDrafts,
      });
    });
    let connectBotHost: (hostId: string) => Promise<void> = async () => { throw new Error("暂无可连接的实例。"); };
    await loadPresentationExtension("opencraft.bot-management", async signal => {
      const { createBotManagementExtension } = await import("./bot-management-extension");
      signal?.throwIfAborted();
      return createBotManagementExtension(botDirectory, botConversations.service, hostId => connectBotHost(hostId), clientProduct?.botManagement);
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
      builtins: [tokenUsageBuiltin, ...(platform === "web" ? clientProduct?.builtins ?? [] : [])],
    });
    startupRollback.push(() => extensionManager.dispose());
    if (options.optionalFeatureStartup !== undefined) {
      options.optionalFeatureStartup.add("extensions.restore", async signal => {
        signal?.throwIfAborted();
        await extensionManager.restore();
      });
    } else {
      await extensionManager.restore();
    }
    const disconnectAppearanceThemes = connectAppearanceThemeContributions(
      extensions.contributions,
    );
    startupRollback.push(disconnectAppearanceThemes);
    const queryClient = createWorkbenchQueryClient();
    startupRollback.push(() => queryClient.clear());
    const routeCheckpoints = new BoundedCheckpointMap(32);
    const routerOptions = {
      presentation: options.presentation,
      mode: options.navigationMode,
      resolveApplicationRoute: (route: ApplicationRoute) => resolveBuiltinConnectionRoute(route, headlessAppHost !== null),
      // The containing page owns its URL. Embedded Workbench starts at Home.
      ...(options.navigationMode === "memory" ? { initialEntries: ["/"] } : {}),
    };
  const resourcePolicy = WORKBENCH_RESOURCE_POLICIES[
    typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? "mobile" : "desktop"
  ];
  let conversationPresentationActive = true;
  const setConversationPresentationActive = (active: boolean) => { conversationPresentationActive = active; };
  const presentationActive = () => conversationPresentationActive && document.visibilityState !== "hidden" && (options.isPresentationActive?.() ?? true);
  const fixedPresentation = options.presentation?.executionSelection === "fixed";
  const hostProfileBootstrap = fixedPresentation
    ? { store: new FixedHostProfileStore(options.ephemeralHostProfiles ?? []), storageError: null }
    : await openHostProfiles({
    allowDeploymentRecovery: platform === "web" && sshManagement?.getSnapshot().available === true,
    databaseName: currentProductDatabaseName("opencraft-host-connections"),
    formerDatabaseName: currentProductDatabaseName("vela-host-connections"),
    seed: bootstrapDefinitions.map(hostDefinitionProfile),
    ephemeral: [
      ...hostProfileContributions.list(),
      ...(options.ephemeralHostProfiles ?? []),
    ],
  });
  const storedHostProfiles = hostProfileBootstrap.store;
  if (headlessAppHost !== null) try {
    await migrateServerConnectionProfiles(storedHostProfiles);
  } catch (error) {
    storedHostProfiles.close();
    throw error;
  }
  if (!fixedPresentation) try {
    await migrateBuiltinConnectionProfiles(storedHostProfiles, connectionProviders.providers.getSnapshot().providers.map(provider => provider.id));
  } catch (error) {
    storedHostProfiles.close();
    throw error;
  }
  const configuredHostProfiles = sshManagement && sshManagement.getSnapshot().available !== false
    ? new ServerManagedProfileStore(storedHostProfiles, sshManagement, () => [
      ...sshManagement!.getSnapshot().items,
      ...sshManagement!.getSnapshot().legacyServers.map(server => ({ ...server, enabled: true, revision: 1 })),
    ].map(server => ({
        hostId: server.serverId, displayName: server.displayName, providerId: SERVER_CONNECTIONS_ID, providerConfig: {}, providerConfigVersion: 1,
        hostKind: "remote-ssh", enabled: server.enabled, autoConnect: false, includeInSidebar: true, credentialRef: null,
        transportEndpoint: null, executionLocation: server.displayName, workspaceBrowseRoots: server.workspaceBrowseRoots, revision: server.revision,
      })))
    : storedHostProfiles;
  if (!fixedPresentation) await refreshBundledHostProfiles(configuredHostProfiles, bootstrapDefinitions);
  const hostProfiles: HostConnectionProfileStore = options.hostProfileMode === "configured"
    ? configuredHostProfiles
    : new EnvironmentProfileStore(configuredHostProfiles, environmentDirectory);
  startupRollback.push(() => hostProfiles.close());
  const restoreLegacyWebsite = platform === "web" && workbenchProductId === "opencraft"
    && websiteConfig !== null && !import.meta.env.VITE_APPSERVER_HOSTS_JSON?.trim()
    && !import.meta.env.VITE_APPSERVER_WS_URL?.trim()
    && !deployment.hypernode
    && configuredHostProfiles.getSnapshot().profiles.some(profile => profile.hostId === "local" && profile.enabled
      && profile.providerId === "opencraft.websocket" && profile.providerConfig !== null
      && typeof profile.providerConfig === "object" && !Array.isArray(profile.providerConfig)
      && "url" in profile.providerConfig
      && profile.providerConfig.url === bootstrapDefinitions.find(host => host.hostId === "local")?.url)
    && !configuredHostProfiles.getSnapshot().profiles.some(profile => profile.hostId === "hypernode");
  const resolveWebsiteLocation = restoreLegacyWebsite ? resolveLegacyWebsiteLocation : undefined;
  if (restoreLegacyWebsite) try { restoreLegacyWebsiteSelection(window.localStorage); } catch { /* unavailable legacy selection storage */ }
  const rawBootstrapLocation = readWorkbenchBootstrapLocation(
    new URL(window.location.href), window.history.state, options.navigationMode,
  );
  const requestedBootstrapLocation = resolveWebsiteLocation?.(rawBootstrapLocation) ?? rawBootstrapLocation;
  if (!configuredHostProfiles.getSnapshot().profiles.some(profile => profile.enabled)) {
    await environmentDirectory.refresh().catch(() => undefined);
  }
  const sharedDisposalSteps: readonly (() => void | Promise<void>)[] = [
    () => hostProfiles.close(),
    () => queryClient.clear(),
    () => extensionManager.dispose(),
    () => extensionSettings.close(),
    stopSidebarLayoutPersistReporting,
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
    stopBotDraftScope,
    () => clientProduct?.dispose(),
    () => localClientScope?.dispose(),
    disconnectAppearanceThemes,
    () => botDirectory.dispose(),
    () => profileSkills.dispose(),
    () => botSource.dispose(),
    () => botConversations.dispose(),
    () => turnNotifications.dispose(),
    () => turnCompletions.dispose(),
    () => threadAttention.dispose(),
    () => appServerRegistry.dispose(),
    () => electronAppHost?.close(),
    () => headlessAppHost?.close(),
    () => remoteAppHost?.close(),
    () => sshManagement?.dispose(),
    () => connectionProviders.dispose(),
    () => blobFiber.dispose(),
    () => imageFiber.dispose(),
  ];
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
      setConversationPresentationActive,
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
      turnCompletions,
      threadAttention,
      turnNotifications,
      connectionProviders,
      extensions,
      extensionManager,
      extensionSettings,
      platformViewRenderers,
      platformAccounts,
      applicationBranding,
      threadBadges,
      threadListGrouping,
      identityAvatars,
      composerActionRenderers,
      imageEditors,
      botDirectory,
      sidebarLayout,
      hostProfiles,
      hostProfileStorageError: hostProfileBootstrap.storageError,
      queryClient,
      provisionHost,
      addWebSocketHost: (input) => provisionWebSocketHost(input, provisionHost),
      removeHost: (hostId) => hostProfiles.remove(hostId),
      dispose: createApplicationDisposer([
        () => navigation.dispose(),
        () => conversationBindings.dispose(),
        ...sharedDisposalSteps,
      ], "Failed to dispose hostless Web Workbench supervisor"),
    };
    startupRollback.length = 0;
    return hostless;
  }
  let draftCredentialScope = clientPersistenceScope.getSnapshot().namespace;
  const browserOutbox = createBrowserConversationOutbox({
    get storage() { return window.sessionStorage; },
    scope: () => {
      const account = platformAccounts.getSnapshot().contribution?.getSnapshot();
      const identity = account?.readStateScope !== undefined ? account.readStateScope
        : account?.identity?.id ?? clientPersistenceScope.getSnapshot().namespace;
      return identity ? JSON.stringify([serverStorageKey(workbenchProductId), identity, clientPersistenceScope.getSnapshot().namespace]) : null;
    },
  });
  let stopOutboxAccount: (() => void) | undefined;
  const bindOutboxAccount = () => {
    stopOutboxAccount?.();
    stopOutboxAccount = platformAccounts.getSnapshot().contribution?.subscribe(() => browserOutbox.refreshScope());
    browserOutbox.refreshScope();
  };
  const stopOutboxRegistry = platformAccounts.subscribe(bindOutboxAccount);
  bindOutboxAccount();
  startupRollback.push(() => { stopOutboxRegistry(); stopOutboxAccount?.(); });
  let browserDraftStore = createBrowserConversationDraftStorage(`${serverStorageKey(workbenchProductId)}.${draftCredentialScope}`);
  const normalizedBootstrapLocation = requestedBootstrapLocation === null ? null : resolveRetainedWorkbenchLocation(
    requestedBootstrapLocation,
    { hasHost: hostId => profiles.some(profile => profile.hostId === hostId), bindings: conversationBindings, scopes: null },
  );
  const savedNewTarget = normalizedBootstrapLocation?.kind !== "thread" && requestedBootstrapLocation?.kind === "draft"
    ? await browserDraftStore.loadNewTarget(requestedBootstrapLocation.draftId) : null;
  const restoredNewTarget = savedNewTarget && requestedBootstrapLocation?.kind === "draft"
    && savedNewTarget.execution.hostId === requestedBootstrapLocation.hostId
    && profiles.some(profile => profile.hostId === savedNewTarget.execution.hostId && profile.enabled)
    ? savedNewTarget : null;
  const bootstrapLocation = restoredNewTarget
    ? createWorkbenchDraftLocation(restoredNewTarget.execution.hostId, restoredNewTarget.draftId)
    : normalizedBootstrapLocation;
  const persistedHostId = readLocalPreference(currentProductStorageKey("opencraft.active-host-id"));
  const requestedHostId = bootstrapLocation?.kind === "thread"
    ? bootstrapLocation.key.hostId
    : bootstrapLocation?.hostId;
  const initialHostId = requestedHostId !== undefined
    && profiles.some((host) => host.hostId === requestedHostId)
    ? requestedHostId
    : profiles.some((host) => host.hostId === persistedHostId)
      ? persistedHostId!
      : profiles.find((host) => host.hostId === "local")?.hostId
        ?? profiles.find((host) => host.hostKind === "local" || host.hostKind === "durable")?.hostId
        ?? profiles[0]!.hostId;
  const initialWorkspaceRoot = profiles.find((host) => host.hostId === initialHostId)
    ?.workspaceBrowseRoots[0] ?? null;
  let forgetUnavailableThread: ((hostId: string, threadId: string) => void) | undefined;
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
        outbox: browserOutbox.forProfile(profile.revision),
        onRecoveryEvent: reportRecoveryEvent,
        ...resourcePolicy,
        getSubmissionSender: () => platformAccounts.getSnapshot().contribution?.getSnapshot().submissionSender ?? null,
        frameScheduler: createThreadViewFrameScheduler((flush) => {
          if (!presentationActive()) return undefined;
          const frame = requestAnimationFrame(flush);
          return () => cancelAnimationFrame(frame);
        }, () => presentationActive() ? 32 : 250),
        modelSelectionPolicy: options.modelSelectionPolicy,
        readSelectableModels: options.readSelectableModels,
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
          const stopDiagnostics = installAppServerDiagnostics(client, "runtime");
          const stopObservation = installClientObservation(client);
          const tools = installWorkbenchDynamicToolHandlers(
            client,
            { browser: browserToolHost, terminal: terminalToolHost, connectors },
            { hostId: profile.hostId },
          );
          const catalog = bindThreadCatalogNotifications(client, profile.hostId, queryClient);
          return () => { stopObservation(); stopDiagnostics(); catalog(); tools(); };
        },
        });
      } catch (error) {
        providerLease.release();
        throw error;
      }
      const stopQueryRecovery = bindHostQueryRecovery(runtime, profile.hostId, queryClient);
      const stopUnavailable = runtime.resources.threads.subscribeUnavailable?.(threadId => {
        const memoryScope = threadMemoryScope?.();
        queueMicrotask(() => {
          if (!disposed && memoryScope === threadMemoryScope?.()) forgetUnavailableThread?.(profile.hostId, threadId);
        });
      });
      let disposed = false;
      const composerCommands = createHostComposerCommandPort({
        provider: providerLease.provider,
        context: { platform, hostId: profile.hostId, profileRevision: profile.revision },
        protocol: runtime.resources.protocol,
        isCurrent: () => !disposed && runtime.getSnapshot().phase === "ready"
          && hostProfiles.getSnapshot().profiles.some(current => current.hostId === profile.hostId
            && current.enabled && current.revision === profile.revision && current.providerId === profile.providerId),
        acquire: () => connectionProviders.providers.acquire(profile.providerId, platform),
      });
      let identityGeneration = -1;
      let identityRead: Promise<void> = Promise.resolve();
      const observeIdentity = () => {
        if (disposed) return;
        if (runtime.getSnapshot().phase !== "ready") { identityGeneration = -1; return; }
        const generation = runtime.resources.host.getConnectionGeneration?.() ?? 0;
        if (identityGeneration === generation) return;
        identityGeneration = generation;
        identityRead = machineIdentityObserver.read(profile, () => runtime.resources.protocol.request("runtime/machine/read", {})).catch(() => undefined);
      };
      const stopIdentity = runtime.subscribe(observeIdentity);
      return {
        ...runtime,
        resources: { ...runtime.resources, ...(composerCommands === undefined ? {} : { composerCommands }) },
        async connect() {
          if (!hostProfiles.getSnapshot().profiles.some(current => current.hostId === profile.hostId && current.enabled)) throw new Error("此环境当前不可连接，请刷新环境目录。");
          await runtime.connect();
          observeIdentity();
          await identityRead;
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          stopUnavailable?.();
          stopQueryRecovery();
          stopIdentity();
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
  const machineIdentityObserver = new HostMachineIdentityObserver(registry, hostProfiles,
    hostId => environmentDirectory.getSnapshot().entries.some(entry => entry.profile.hostId === hostId && entry.resource !== null));
  startupRollback.push(() => machineIdentityObserver.dispose());
  // Identity probes deliberately skip initialize and all catalog queries.
  const identityProbes = new Set<JsonRpcAppServerClient>();
  let probesDisposed = false;
  for (const profile of profiles) {
    if (environmentDirectory.getSnapshot().entries.some(entry => entry.profile.hostId === profile.hostId && entry.resource !== null)) continue;
    void (async () => {
      const lease = connectionProviders.providers.acquire(profile.providerId, platform);
      let client: JsonRpcAppServerClient | null = null;
      let stopDiagnostics: (() => void) | null = null;
      try {
        const context = { platform, hostId: profile.hostId, profileRevision: profile.revision };
        const config = lease.provider.validate(profile.providerConfig, context);
        const transport = lease.provider.createTransport(config, context);
        client = new JsonRpcAppServerClient({ hostId: profile.hostId, transport, requestTimeoutMs: 3000 });
        stopDiagnostics = installAppServerDiagnostics(client, "identity-probe");
        identityProbes.add(client);
        if (!probesDisposed) await machineIdentityObserver.read(profile, async () => {
          await transport.connect();
          return client!.request("runtime/machine/read", {});
        });
      } catch { /* Identity discovery never blocks the normal connection path. */ }
      finally { stopDiagnostics?.(); if (client) { identityProbes.delete(client); await client.close(); } lease.release(); }
    })();
  }
  const stopIdentityProbes = async () => { probesDisposed = true; await Promise.allSettled([...identityProbes].map(client => client.close())); };
  startupRollback.push(stopIdentityProbes);
  agentRuntimes.bindRegistry(registry);
  connectBotHost = async hostId => { await registry.ensureConnected(hostId); };
  startupRollback.push(() => registry.dispose());
  const stopEnvironmentRegistry = connectEnvironmentRuntimeRegistry(hostProfiles, registry, createHostRegistration);
  startupRollback.push(stopEnvironmentRegistry);
  const active = registry.getRuntime(initialHostId).getSnapshot();
  const threadMemoryScope = fixedPresentation ? () => clientPersistenceScope.getSnapshot().threadMemoryScope : undefined;
  const persistedThreadId = rememberedThreadId(
    window.localStorage,
    initialHostId,
    options.hostProfileMode,
    threadMemoryScope?.(),
  );
  const initialThreadLocation = bootstrapLocation?.kind === "thread"
    ? bootstrapLocation
    : bootstrapLocation === null && persistedThreadId !== null
      ? createWorkbenchThreadLocation(initialHostId, persistedThreadId)
      : null;
  const conversationScopes = createConversationScopeRegistry({
    isInputRetained: (scopeId) => conversationViews.hasRetainedInput(scopeId),
    // Local persisted input may restore its client identity and placement.
    // A canonical promotion alias still wins; execution locks never restore.
    initialDraft: initialThreadLocation === null
      ? {
          entrypoint: "home",
          ...(restoredNewTarget ? { draftId: restoredNewTarget.draftId } : {}),
          execution: restoredNewTarget?.execution ?? {
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
    maxInactiveScopes: resourcePolicy.maxInactiveScopes,
    onDisposeScope(scopeId) {
      disposeScopeResources(scopeId);
    },
  });
  startupRollback.push(() => conversationLeases.dispose());
  let currentDisplayContinuity = createConversationDisplayContinuity({
    namespace: `${serverStorageKey(workbenchProductId)}.${draftCredentialScope}`,
    storage: browserDraftStore.displayStorage,
  });
  const displayListeners = new Set<() => void>();
  let displayWritesSuspended = false;
  let displayResumeAfterGeneration = -1;
  const displayContinuity: BrowserDisplayContinuity = {
    retainSubmission: (intent, receipt) => currentDisplayContinuity.retainSubmission(intent, receipt),
    peekSubmission: (hostId, threadId) => currentDisplayContinuity.peekSubmission(hostId, threadId),
    peek: (hostId, threadId) => currentDisplayContinuity.peek(hostId, threadId),
    async load(hostId, threadId) {
      const timeline = await currentDisplayContinuity.load(hostId, threadId);
      reportDisplayEvent("display-load", { ...displayTimingCounts(timeline), cacheHit: Number(timeline !== null) });
      return timeline;
    },
    observe(snapshot) {
      if (displayWritesSuspended) {
        if (coordinator.getRuntime().getSnapshot().connectionGeneration <= displayResumeAfterGeneration) {
          return Promise.resolve();
        }
        displayWritesSuspended = false;
      }
      return currentDisplayContinuity.observe(snapshot);
    },
    getScope: () => draftCredentialScope,
    subscribe(listener) { displayListeners.add(listener); return () => displayListeners.delete(listener); },
  };
  const conversationViews = createConversationViewRegistry({
    maxInactiveViews: resourcePolicy.maxInactiveViews,
    scopeLeases: conversationLeases,
    composerServices: { now: Date.now, createId: createClientId },
    draftContinuity: createConversationDraftContinuity({
      namespace: `${serverStorageKey(workbenchProductId)}.${draftCredentialScope}`,
      storage: browserDraftStore.storage,
      delayMs: 0,
    }),
    onDisposeView(viewId) {
      disposeViewResources(viewId);
      routeCheckpoints.delete(viewId);
    },
    onEvictDraft(viewId) {
      navigation.forgetView(viewId);
    },
  });
  startupRollback.push(() => conversationViews.dispose());
  const stopDraftScope = clientPersistenceScope.subscribe(() => {
    const nextScope = clientPersistenceScope.getSnapshot().namespace;
    if (nextScope === draftCredentialScope) return;
    browserOutbox.refreshScope();
    taskConversationFlow?.revoke();
    browserDraftStore.revokeAndClear();
    // The old Thread lease may remain readable briefly while authentication
    // changes. Never seed a new account's cache from that old lease.
    displayWritesSuspended = true;
    displayResumeAfterGeneration = coordinator.getRuntime().getSnapshot().connectionGeneration;
    draftCredentialScope = nextScope;
    browserDraftStore = createBrowserConversationDraftStorage(`${serverStorageKey(workbenchProductId)}.${nextScope}`);
    currentDisplayContinuity = createConversationDisplayContinuity({
      namespace: `${serverStorageKey(workbenchProductId)}.${nextScope}`,
      storage: browserDraftStore.displayStorage,
    });
    for (const listener of displayListeners) listener();
    navigation.clearPreferredViews();
    conversationViews.replaceDraftContinuity(createConversationDraftContinuity({
      namespace: `${serverStorageKey(workbenchProductId)}.${nextScope}`,
      storage: browserDraftStore.storage,
      delayMs: 0,
    }));
  });
  startupRollback.push(stopDraftScope);
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
      resolveLocation: resolveWebsiteLocation,
      resolveCanonicalLocation(location) {
        return resolveRetainedWorkbenchLocation(location, {
          hasHost: () => true,
          bindings: conversationBindings,
          scopes: conversationScopes,
        }) ?? location;
      },
      isRetainedView(location, viewId) {
        const owner = conversationViews.getDraftOwner(viewId);
        if (owner === null) return false;
        const target = owner.composer.getSnapshot().draft.target;
        return location.kind === "draft"
          ? target.type === "new-thread" && target.execution.hostId === location.hostId && target.draftId === location.draftId
          : target.type === "existing-thread" && target.key.hostId === location.key.hostId && target.key.threadId === location.key.threadId;
      },
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
    displayContinuity,
    presentation: options.presentation,
    threadMemoryScope,
    registry,
    coordinator,
    activation: conversationActivation,
    scopes: conversationScopes,
    views: conversationViews,
    environmentDirectory,
    navigation,
    queryClient,
    hostProfiles,
    createHostRegistration,
    connectionProviders: connectionProviders.providers,
    onThreadCreated: (intent, receipt) => taskConversationFlow?.created(intent, receipt) ?? Promise.resolve(),
  });
  forgetUnavailableThread = commands.forgetThread;
  const tasksStorageHostId = platform === "electron" ? "local-codex" : headlessAppHost ? "opencraft-server" : bootstrapDefinitions[0]?.hostId;
  const tasks: TasksRequestPort | null = import.meta.env.VITE_INCLUDE_TASKS_PLUGIN === "true" ? {
    request: (method, params) => {
      if (!tasksStorageHostId) return Promise.reject(new Error("Tasks storage unavailable"));
      return agentRuntimes.request(tasksStorageHostId, method, params);
    },
  } : null;
  if (tasks) {
    const storageHostId = tasksStorageHostId;
    const serverId = (hostId: string) => {
      const profile = hostProfiles.getSnapshot().profiles.find(profile => profile.hostId === hostId && profile.enabled);
      if (!profile) throw new Error("Task conversation connection unavailable");
      return legacyDirectServerProjectionFromHost({ hostId, hostKind: profile.hostKind, label: profile.displayName }).serverOrigin.serverId;
    };
    const flow = taskConversationFlow = new TaskConversationFlow({
      storage: window.localStorage,
      storageKey: () => `opencraft.task-conversations.v1.${serverStorageKey(workbenchProductId)}.${draftCredentialScope}`,
      serverId,
      request: (method, params) => {
        if (!storageHostId) return Promise.reject(new Error("Tasks storage unavailable"));
        return agentRuntimes.request(storageHostId, method, params);
      },
    });
    startupRollback.push(() => flow.dispose());
    prepareTaskConversation = async (taskId, hostId) => {
      const scope = draftCredentialScope;
      const revision = navigation.getSnapshot().revision;
      if (!storageHostId) throw new Error("Tasks storage unavailable");
      await agentRuntimes.ensureReady(hostId);
      const task = await agentRuntimes.request(storageHostId, TASKS.read, { id: taskId });
      let progress = task.latestProgress ? [task.latestProgress] : [];
      try {
        const capabilities = await agentRuntimes.request(storageHostId, TASKS.capabilities, {});
        if (capabilities.activity) {
          const page = await agentRuntimes.request(storageHostId, TASKS.events, { taskId, limit: 20 });
          const recent = page.events.filter(event => event.type === "progress").slice(0, 3).map(event => ({ eventId: event.eventId, text: String(event.payload.text ?? ""), createdAt: event.createdAt }));
          progress = [...new Map([...recent, ...progress].map(event => [event.eventId, event])).values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);
        }
      } catch { /* The current task snapshot still contains the latest known progress. */ }
      const project = task.projectServerId === serverId(hostId) && task.projectId
        ? (await agentRuntimes.request(hostId, "project/list", {})).data.find(project => project.id === task.projectId)
        : null;
      if (task.projectServerId === serverId(hostId) && task.projectId && !project) throw new Error("Task project unavailable");
      if (scope !== draftCredentialScope || revision !== navigation.getSnapshot().revision) throw new Error("Task navigation superseded");
      const cwd = project?.roots[0]?.path ?? registry.getSnapshot().hosts.find(host => host.hostId === hostId)?.workspaceBrowseRoots[0] ?? null;
      const draftId = `client-new-thread:${crypto.randomUUID()}`;
      flow.register(draftId, task.id);
      let location: WorkbenchLocation;
      try { location = commands.navigateToHome({ draftId, execution: { hostId: asHostId(hostId), workspace: {
        cwd, runtimeWorkspaceRoots: project?.roots.map(root => root.path) ?? (cwd ? [cwd] : []),
        ...(project ? { projectId: project.id } : {}),
      } }, entrypoint: "new-chat" }); } catch (error) { flow.cancel(draftId); throw error; }
      if (location.kind !== "draft") throw new Error("Expected task draft");
      const view = conversationViews.get(navigation.getSnapshot().routeScopeId);
      if (!view) throw new Error("Task composer unavailable");
      view.composer.dispatch({ type: "replace-content", document: { version: 1, blocks: [{ type: "paragraph", children: [
        { type: "text", text: taskConversationContext(task, progress) },
      ] }] }, attachments: [], context: [] });
    };
  }
  const supervisor: WebWorkbenchApplicationSupervisor = {
    setConversationPresentationActive,
    tasks,
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
    turnCompletions,
    threadAttention,
    turnNotifications,
    agentRuntimes,
    connectionProviders,
    extensions,
    extensionManager,
    extensionSettings,
    platformViewRenderers,
    platformAccounts,
    applicationBranding,
    threadBadges,
    threadListGrouping,
    identityAvatars,
    composerActionRenderers,
    imageEditors,
    botDirectory,
    sidebarLayout,
    displayContinuity,
    hostProfiles,
    hostProfileStorageError: hostProfileBootstrap.storageError,
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
    dispose: createApplicationDisposer([
      () => taskConversationFlow?.dispose(),
      stopIdentityProbes,
      () => machineIdentityObserver.dispose(),
      stopEnvironmentRegistry,
      stopDraftScope,
      () => { stopOutboxRegistry(); stopOutboxAccount?.(); },
      () => displayListeners.clear(),
      () => navigation.dispose(),
      () => conversationActivation.dispose(),
      () => conversationViews.dispose(),
      () => conversationLeases.dispose(),
      () => conversationScopes.dispose(),
      () => conversationBindings.dispose(),
      () => coordinator.dispose(),
      () => registry.dispose(),
      ...sharedDisposalSteps,
    ], "Failed to dispose Web Workbench supervisor"),
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
