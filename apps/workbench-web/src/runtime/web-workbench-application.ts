import { ThreadSummaryPlugin } from "@opencraft/plugin-thread-summary";
import { browserMetadataKeys, readBrowserMetadataValue } from "@opencraft/workbench-runtime/browser-metadata-identity";
import { declaredBrowserBackend, waitForRemoteBrowser } from '../browser/remote-browser-capabilities';
import { supportsH264MediaSource } from '../browser/browser-media-capabilities';
import { subscribeBrowserMetadata } from '../browser/browser-metadata-sync';
import { RemoteBrowserSurfaceHost } from '../browser/remote-browser-surface-host';
import type { ConversationPresentationProvider } from "./conversation-presentation";
import { serverFetch, serverStorageKey, serverUrl } from "./server-context";
import { createWebWorkbenchApplicationSupervisor } from "./web-workbench-supervisor";
import { createApplicationDisposer } from "./application-disposal";
import { Context, type Plugin } from "@deepseek-ai/cordis";
import { createCloudDesktopWorkbenchPanelPlugin, type CloudDesktopPluginAdapter } from "@opencraft/plugin-cloud-desktop";
import {
  createWebChatRenderRuntime,
  type ChatRenderRuntime,
} from "@opencraft/chat-render-web";
import { TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import {
  ConversationTerminalSessionRegistry,
  RegistryConversationTerminalToolHost,
  createConversationBindingStore,
  SideChatService,
  type AppServerWorkbenchRuntime,
  type PersistedConversationBinding,
} from "@opencraft/workbench-runtime";
import { asHostId, createConversationKey } from "@opencraft/chat-core";

import { createBrowserWorkbenchPanelPlugin } from "../browser/browser-panel-plugin";
import { HostDesktopBackend } from "./host-desktop-backend";
import { BrowserPresentationCoordinator } from "../browser/browser-presentation-coordinator";
import { BrowserWorkbenchCoordinator } from "../browser/browser-workbench-coordinator";
import { WebBrowserPageRuntime, type BrowserNavigationPolicy } from "../browser/web-browser-runtime";
import { WebIframeSurfaceHost, type BrowserSurfaceHost } from "../browser/web-browser-surface-host";
import { createDesktopBrowserStorage, type BrowserMetadataStorage } from "../browser/desktop-browser-storage";
import { WebBrowserDynamicToolHost } from "../browser/web-browser-tool-host";
import { WebHostProxyBroker } from "../browser/web-host-proxy-broker";
import { BuiltinWorkbenchPanelPlugin } from "../panels/builtin-panel-plugin";
import { WorkbenchResourceSync } from "./workbench-resource-sync";
import { createSideChatPersistence, createSynchronizedSideChatPersistence } from "./side-chat-persistence";
import { createSideChatPanelPlugin } from "../panels/side-chat-panel-plugin";
import { BuiltinTimelineRendererPlugin } from "../components/conversation-renderers/builtin-timeline-renderer-plugin";
import {
  type WebWorkbenchApplicationSupervisor,
  type WebWorkbenchSupervisorOptions,
} from "./appserver-runtime-context";
import {
  createWorkbenchPanelRuntime,
} from "./panel-runtime-context";
import type { WorkbenchPanelReactRuntime } from "@opencraft/workbench-panels-react";
import { OptionalFeatureStartup, loadOptionalFeatureModule } from "./optional-feature-startup";

export interface WebWorkbenchApplication {
  readonly conversationPresentation?: ConversationPresentationProvider;
  /** Idempotent; never creates another Application or Host. */
  startOptionalFeatures(): Promise<void>;
  readonly cordis: Context;
  readonly browserPages: WebBrowserPageRuntime;
  readonly browserSurfaces: BrowserSurfaceHost;
  readonly browserPresentations: BrowserPresentationCoordinator;
  readonly browserWorkbench: BrowserWorkbenchCoordinator;
  readonly chatRenderRuntime: ChatRenderRuntime;
  readonly panelRuntime: WorkbenchPanelReactRuntime;
  readonly timelineRenderers: TimelineBlockRendererRegistryService;
  readonly supervisor: WebWorkbenchApplicationSupervisor;
  readonly terminalSessions: ConversationTerminalSessionRegistry | null;
  dispose(): Promise<void>;
}

const CONVERSATION_BINDINGS_STORAGE_KEY = serverStorageKey(browserMetadataKeys.bindings);

function loadConversationBindings(storage: BrowserMetadataStorage = window.localStorage): readonly PersistedConversationBinding[] {
  try {
    const value = JSON.parse(readBrowserMetadataValue(storage, browserMetadataKeys.bindings, serverStorageKey) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((row): PersistedConversationBinding[] => {
      if (typeof row !== "object" || row === null) return [];
      const candidate = row as Record<string, unknown>;
      if (
        typeof candidate.scopeId !== "string"
        || typeof candidate.hostId !== "string"
        || !(candidate.threadId === null || typeof candidate.threadId === "string")
      ) return [];
      return [{
        scopeId: candidate.scopeId,
        hostId: candidate.hostId,
        threadId: candidate.threadId,
      }];
    });
  } catch {
    return [];
  }
}

/** Single application owner for every long-lived renderer service. */
export interface CreateWebWorkbenchApplicationOptions extends Omit<WebWorkbenchSupervisorOptions, "optionalFeatureStartup"> {
  /** Trusted local renderer plugins; owned and released with this Application. */
  readonly chatRenderExtensions?: readonly Plugin[];
  readonly deferOptionalFeatures?: boolean;
  /** Optional trusted information module; the conversation owns its data. */
  readonly threadSummary?: boolean;
  readonly conversationPresentation?: ConversationPresentationProvider;
  readonly browserMetadataStorage?: BrowserMetadataStorage;
  readonly browserNavigationPolicy?: BrowserNavigationPolicy;
  /** Product override; null disables desktop panels and actions, undefined uses the local Host adapter. */
  readonly cloudDesktop?: CloudDesktopPluginAdapter | null;
}

export async function createWebWorkbenchApplication(
  options: CreateWebWorkbenchApplicationOptions = {},
  startupSignal?: AbortSignal,
): Promise<WebWorkbenchApplication> {
  startupSignal?.throwIfAborted();
  // OAuth can return into any Workbench route. Consume its one-time fragment
  // before IndexedDB, Cordis and extension activation so authentication does
  // not depend on the latency or success of the rest of application startup.
  const desktop = (globalThis as typeof globalThis & { opencraftDesktop?: { kind?: string } }).opencraftDesktop?.kind === "electron";
  await options.clientProduct?.bootstrap?.({
    platform: desktop ? "electron" : "web",
    hostProfileMode: options.hostProfileMode,
  });
  // Electron-only guest machinery (including annotation injection) is not
  // a Web startup dependency. Load before allocating application owners.
  const ElectronBrowserSurfaceHost = desktop
    ? (await import("../browser/electron-browser-surface-host")).ElectronBrowserSurfaceHost : null;
  startupSignal?.throwIfAborted();
  const remoteMetadata = !desktop && import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST === "true" && declaredBrowserBackend() !== false;
  const remoteBrowser = remoteMetadata && import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST === 'true'
    && (typeof VideoDecoder !== 'undefined' || supportsH264MediaSource())
    && declaredBrowserBackend() !== false;
  const browserAdmission = new AbortController();
  const abortBrowserAdmission = () => browserAdmission.abort(startupSignal?.reason);
  if (remoteMetadata) startupSignal?.addEventListener("abort", abortBrowserAdmission, { once: true });
  const releaseBrowserAdmission = () => { browserAdmission.abort(); startupSignal?.removeEventListener("abort", abortBrowserAdmission); };
  const remoteStorage = remoteMetadata && !options.browserMetadataStorage ? await (await import('../browser/remote-browser-storage')).RemoteBrowserStorage.create(startupSignal, async () => { browserAdmission.signal.throwIfAborted(); }) : null;
  const browserStorage = options.browserMetadataStorage ?? (remoteBrowser ? remoteStorage : null) ?? (desktop ? await createDesktopBrowserStorage() : null);
  // Desktop account restoration is independent of local Host startup. The
  // local Host and its environment configuration must remain usable meanwhile.
  const cordis = new Context();
  const optionalFeatures = options.deferOptionalFeatures ? new OptionalFeatureStartup() : null;
  // Conversation aliases and resource metadata do not depend on video decoding.
  const bindingStorage = remoteStorage ?? browserStorage ?? window.localStorage;
  const conversationBindings = createConversationBindingStore({
    persistence: {
      load: () => loadConversationBindings(bindingStorage),
      save(bindings) {
        try {
          bindingStorage.setItem(CONVERSATION_BINDINGS_STORAGE_KEY, JSON.stringify(bindings));
        } catch {
          // Client aliases are a startup optimization, not authoritative data.
        }
      },
    },
  });
  const releaseBindingMetadata = (bindingStorage as BrowserMetadataStorage).onMetadataChanged?.(field => {
    if (field === "bindings" || field === "*") conversationBindings.restore();
  });
  let supervisor: WebWorkbenchApplicationSupervisor;
  let resolveTerminalRuntime: ((hostId: string) => AppServerWorkbenchRuntime) | null = null;
  let releaseSupervisor: (() => Promise<void>) | undefined;
  let hostDesktop: HostDesktopBackend | undefined;
  const hostProxy = new WebHostProxyBroker(async (hostId, targetUrl, init) => {
    if (supervisor.mode !== "active") {
      throw new Error("Host proxy is unavailable without an active AppServer runtime");
    }
    const runtime = await supervisor.registry.ensureConnected(hostId);
    return runtime.resources.host.fetchLoopback(targetUrl, init);
  });
  const browserSurfaces = ElectronBrowserSurfaceHost ? new ElectronBrowserSurfaceHost(browserStorage!)
    : remoteBrowser ? new RemoteBrowserSurfaceHost(browserStorage ?? undefined, remoteStorage ? 'opencraft.remote-browser-storage.v1' : undefined, () => !remoteStorage || remoteStorage.isReady, () => Promise.all([remoteStorage?.whenReady(), waitForRemoteBrowser(browserAdmission.signal)]).then(() => {})) : new WebIframeSurfaceHost();
  const resourceSync = remoteStorage ? new WorkbenchResourceSync(remoteStorage) : null;
  const releaseResourceSync = () => resourceSync?.dispose();
  const releaseStorageErrors = remoteStorage?.onError(error => { if (!remoteStorage.isReady && browserSurfaces instanceof RemoteBrowserSurfaceHost) browserSurfaces.fail(error); });
  const browserPages = new WebBrowserPageRuntime(
    browserSurfaces,
    remoteBrowser || desktop ? null : hostProxy,
    (ownerId) => conversationBindings.resolve(
      ownerId as Parameters<typeof conversationBindings.resolve>[0],
    )?.hostId ?? null,
    browserStorage,
    options.browserNavigationPolicy,
  );
  const browserPresentations = new BrowserPresentationCoordinator(browserPages, browserSurfaces);
  const panelRuntime = await createWorkbenchPanelRuntime(cordis);
  let chatRenderRuntime: ChatRenderRuntime;
  try {
    chatRenderRuntime = await createWebChatRenderRuntime(cordis, options.chatRenderExtensions);
  } catch (error) {
    releaseBindingMetadata?.();
    releaseBrowserAdmission(); releaseResourceSync();
    browserPresentations.dispose();
    browserPages.dispose();
    browserSurfaces.dispose(); releaseStorageErrors?.(); remoteStorage?.dispose();
    conversationBindings.dispose();
    await panelRuntime.dispose().catch(() => undefined);
    throw error;
  }
  let browserWorkbench: BrowserWorkbenchCoordinator;
  let releaseBrowserMetadata: (() => void) | undefined;
  let terminalSessions: ConversationTerminalSessionRegistry | null = null;
  const terminalHostObservers = new Map<string, () => void>();
  const releaseTerminalRecovery = () => { for (const remove of terminalHostObservers.values()) remove(); terminalHostObservers.clear(); };
  try {
    await panelRuntime.install(TimelineBlockRendererRegistryService);
    await panelRuntime.install(BuiltinTimelineRendererPlugin);
    await panelRuntime.install(BuiltinWorkbenchPanelPlugin);
    if (options.threadSummary !== false) await panelRuntime.install(ThreadSummaryPlugin);
    if (options.cloudDesktop) await panelRuntime.install(createCloudDesktopWorkbenchPanelPlugin(options.cloudDesktop));
    browserWorkbench = new BrowserWorkbenchCoordinator(
      browserPages,
      panelRuntime.panels,
      conversationBindings,
      browserStorage,
      (tabId, views) => browserPresentations.isTabVisible(tabId, views),
    );
    if (remoteStorage && browserSurfaces instanceof RemoteBrowserSurfaceHost)
      releaseBrowserMetadata = subscribeBrowserMetadata(remoteStorage, conversationBindings, browserSurfaces, browserPages, browserWorkbench);
    await panelRuntime.install(createBrowserWorkbenchPanelPlugin(
      browserWorkbench,
      (context) => browserWorkbench.open(context.resourceOwnerId, {
        panelOwnerId: context.ownerId,
      }),
    ));
    const browserToolHost = new WebBrowserDynamicToolHost(
      browserPages,
      browserWorkbench,
      browserStorage && 'effectReceipts' in browserStorage ? browserStorage.effectReceipts : undefined,
    );
    terminalSessions = new ConversationTerminalSessionRegistry((hostId) => {
      if (resolveTerminalRuntime === null) {
        throw new Error("Terminal Host is unavailable without an active AppServer runtime");
      }
      return resolveTerminalRuntime(hostId);
    }, undefined, hostId => { void resourceSync?.notify("terminal", hostId).catch(() => console.warn("Terminal directory notification pending; authoritative refresh remains available")); });
    resourceSync?.register("terminal", () => terminalSessions?.refreshDirectories() ?? Promise.resolve());
    const terminalToolHost = new RegistryConversationTerminalToolHost(
      terminalSessions,
      ({ hostId, threadId }) => conversationBindings.findScope(
        createConversationKey(asHostId(hostId), threadId),
      ),
    );
    supervisor = await createWebWorkbenchApplicationSupervisor(
      browserToolHost,
      terminalToolHost,
      conversationBindings,
      cordis,
      (scopeId) => {
        panelRuntime.panels.releaseOwner(scopeId);
        const binding = conversationBindings.resolve(
          scopeId as Parameters<typeof conversationBindings.resolve>[0],
        );
        // A bound Thread outlives its evictable UI cache. An unbound Draft has
        // been dismissed, so its application resources have no reconstruction key.
        if (binding?.conversationKey === null) {
          browserWorkbench.disposeOwner(scopeId);
          terminalSessions?.releaseOwner(scopeId);
          conversationBindings.remove(binding.scopeId);
        }
      },
      (viewId) => browserWorkbench.releaseView(viewId),
      { ...options, optionalFeatureStartup: optionalFeatures ?? undefined },
    );
    releaseSupervisor = () => supervisor.dispose();
    if (supervisor.mode === "active") {
      const activeSupervisor = supervisor;
      if (options.cloudDesktop === undefined) {
        hostDesktop = new HostDesktopBackend({ bindings: conversationBindings, registry: activeSupervisor.registry,
          origin: window.location.origin, openSocket: endpoint => { const url = new URL(endpoint); url.pathname = serverUrl(url.pathname); return new WebSocket(url); } });
        await panelRuntime.install(createCloudDesktopWorkbenchPanelPlugin({ backend: hostDesktop, surfaces: hostDesktop.surfaces }));
      }
      const observeTerminalHost = (hostId: string) => {
        if (terminalHostObservers.has(hostId)) return;
        const runtime = activeSupervisor.registry.getRuntime(hostId);
        let readyGeneration: number | null = null;
        const changed = () => {
          if (browserAdmission.signal.aborted) return;
          const snapshot = runtime.getSnapshot();
          if (snapshot.phase !== "ready") { readyGeneration = null; return; }
          if (readyGeneration === snapshot.connectionGeneration) return;
          readyGeneration = snapshot.connectionGeneration;
          for (const binding of conversationBindings.getSnapshot().bindings)
            if (binding.hostId === hostId) panelRuntime.panels.refreshOwnerResources(binding.scopeId);
        };
        terminalHostObservers.set(hostId, runtime.subscribe(changed));
        changed();
      };
      resolveTerminalRuntime = (hostId) => activeSupervisor.registry.getRuntime(hostId);
      await panelRuntime.install(SideChatService, { persistence: remoteStorage ? createSynchronizedSideChatPersistence(remoteStorage, window.localStorage) : createSideChatPersistence(window.localStorage), resolveHost: (hostId: string) => activeSupervisor.registry.ensureConnected(hostId) });
      await panelRuntime.install(createSideChatPanelPlugin(panelRuntime.context.sideChats, conversationBindings, hostId => activeSupervisor.registry.getRuntime(hostId)));
      const desktopKind = (
        globalThis as typeof globalThis & { readonly opencraftDesktop?: { readonly kind?: string } }
      ).opencraftDesktop?.kind;
      if (desktopKind !== "electron") {
        // Preview owns proxy readiness; optional SW activation never gates chat.
        void hostProxy.start().then((proxyReady) => {
          if (!proxyReady) {
            console.warn("[host-proxy] Service Worker is unavailable; remote loopback previews are disabled");
          } else {
            console.info("[host-proxy] Service Worker broker ready", { brokerId: hostProxy.brokerId });
          }
        }).catch((error) => {
          console.warn("[host-proxy] Service Worker registration failed", error);
        });
      }
      const sessions = terminalSessions;
      const installTerminal = async (signal?: AbortSignal) => {
        const { createTerminalWorkbenchPanelPlugin } = await loadOptionalFeatureModule(
          () => import("@opencraft/plugin-terminal"), signal,
        );
        signal?.throwIfAborted();
        await panelRuntime.install(createTerminalWorkbenchPanelPlugin(sessions,
          ownerId => ({ threadId: conversationBindings.resolve(ownerId as Parameters<typeof conversationBindings.resolve>[0])?.conversationKey?.threadId ?? null }),
          async ownerId => {
            // Terminal recovery must not wait for the independent browser
            // backend. Late aliases trigger another resource refresh below.
            if (remoteStorage?.isReady) conversationBindings.restore();
            const binding = conversationBindings.resolve(ownerId as Parameters<typeof conversationBindings.resolve>[0]);
            if (!binding) return;
            observeTerminalHost(binding.hostId);
            await activeSupervisor.registry.ensureConnected(binding.hostId);
            if (conversationBindings.resolve(binding.scopeId) !== binding) return;
            const aliases = binding.conversationKey === null ? [] : conversationBindings.getSnapshot().bindings
              .filter(candidate => candidate.hostId === binding.hostId && candidate.conversationKey?.threadId === binding.conversationKey?.threadId)
              .map(candidate => candidate.scopeId);
            await sessions.restore(binding.hostId, ownerId, { threadId: binding.conversationKey?.threadId ?? null }, aliases);
          }));
      };
      if (optionalFeatures === null) await installTerminal();
      else optionalFeatures.add("terminal-presentation", installTerminal);
      browserWorkbench.restorePersistedTabs();
      if (remoteStorage) void remoteStorage.whenReady().then(() => {
        if (browserAdmission.signal.aborted) return;
        conversationBindings.restore();
        for (const binding of conversationBindings.getSnapshot().bindings)
          panelRuntime.panels.refreshOwnerResources(binding.scopeId);
        if (!remoteBrowser) return;
        browserPages.restore();
        if (browserSurfaces instanceof RemoteBrowserSurfaceHost) browserSurfaces.restoreStorage();
        browserWorkbench.restoreTabs(); browserWorkbench.restorePersistedTabs();
      }).catch(error => {
        if (!browserAdmission.signal.aborted && browserSurfaces instanceof RemoteBrowserSurfaceHost) browserSurfaces.fail(error as Error);
      });
    }
  } catch (error) {
    releaseBrowserAdmission(); releaseResourceSync();
    releaseBrowserMetadata?.(); releaseBindingMetadata?.();
    await optionalFeatures?.dispose();
    hostDesktop?.dispose();
    hostProxy.dispose();
    browserPresentations.dispose();
    browserPages.dispose();
    browserSurfaces.dispose(); releaseStorageErrors?.(); remoteStorage?.dispose();
    conversationBindings.dispose();
    releaseTerminalRecovery();
    await terminalSessions?.dispose().catch(() => undefined);
    await panelRuntime.dispose().catch(() => undefined);
    await chatRenderRuntime.dispose().catch(() => undefined);
    await releaseSupervisor?.().catch(() => undefined);
    throw error;
  }
  return {
    conversationPresentation: options.conversationPresentation,
    startOptionalFeatures: () => optionalFeatures?.start() ?? Promise.resolve(),
    cordis,
    browserPages,
    browserSurfaces,
    browserPresentations,
    browserWorkbench,
    chatRenderRuntime,
    panelRuntime,
    timelineRenderers: cordis.timelineBlockRenderers,
    supervisor,
    terminalSessions,
    dispose: createApplicationDisposer([
      releaseResourceSync,
      releaseBrowserAdmission,
      () => releaseBrowserMetadata?.(),
      () => optionalFeatures?.dispose(),
      // Retire consumers before their Host transport provider.
      () => hostProxy.dispose(),
      releaseTerminalRecovery,
      () => terminalSessions?.dispose(),
      () => panelRuntime.dispose(),
      () => hostDesktop?.dispose(),
      () => chatRenderRuntime.dispose(),
      () => releaseBindingMetadata?.(),
      () => browserWorkbench.dispose(),
      () => browserPresentations.dispose(),
      () => browserPages.dispose(),
      () => browserSurfaces.dispose(),
      async () => { releaseStorageErrors?.(); await remoteStorage?.flushAndDispose(); },
      () => supervisor.dispose(),
    ], "Failed to dispose Web Workbench application"),
  };
}
