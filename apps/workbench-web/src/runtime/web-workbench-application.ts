import { ThreadSummaryPlugin } from "@opencraft/plugin-thread-summary";
import { browserMetadataKeys, readBrowserMetadataValue } from "@opencraft/workbench-runtime/browser-metadata-identity";
import { RemoteBrowserStorage } from '../browser/remote-browser-storage';
import { discoverRemoteBrowser, discoverRemoteBrowserForStartup, isOfflineShellStartup } from '../browser/remote-browser-capabilities';
import { supportsH264MediaSource } from '../browser/h264-media-source';
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
import { ElectronBrowserSurfaceHost } from "../browser/electron-browser-surface-host";
import { createDesktopBrowserStorage, type BrowserMetadataStorage } from "../browser/desktop-browser-storage";
import { WebBrowserDynamicToolHost } from "../browser/web-browser-tool-host";
import { WebHostProxyBroker } from "../browser/web-host-proxy-broker";
import { BuiltinWorkbenchPanelPlugin } from "../panels/builtin-panel-plugin";
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
  const remoteBrowser = !desktop && import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST === 'true'
    && (typeof VideoDecoder !== 'undefined' || supportsH264MediaSource())
    && await discoverRemoteBrowserForStartup(startupSignal);
  const deferredBrowser = remoteBrowser && isOfflineShellStartup();
  const browserAdmission = new AbortController();
  const abortBrowserAdmission = () => browserAdmission.abort(startupSignal?.reason);
  if (deferredBrowser) startupSignal?.addEventListener("abort", abortBrowserAdmission, { once: true });
  const releaseBrowserAdmission = () => { browserAdmission.abort(); startupSignal?.removeEventListener("abort", abortBrowserAdmission); };
  const remoteStorage = remoteBrowser && !options.browserMetadataStorage ? await RemoteBrowserStorage.create(startupSignal, deferredBrowser ? async () => {
    if (!await discoverRemoteBrowser(browserAdmission.signal)) throw new Error('Browser backend changed; reload OpenCraft');
  } : undefined) : null;
  const browserStorage = options.browserMetadataStorage ?? remoteStorage ?? (desktop ? await createDesktopBrowserStorage() : null);
  // Desktop account restoration is independent of local Host startup. The
  // local Host and its environment configuration must remain usable meanwhile.
  const cordis = new Context();
  const optionalFeatures = options.deferOptionalFeatures ? new OptionalFeatureStartup() : null;
  const conversationBindings = createConversationBindingStore({
    persistence: {
      load: () => loadConversationBindings(browserStorage ?? window.localStorage),
      save(bindings) {
        try {
          (browserStorage ?? window.localStorage).setItem(CONVERSATION_BINDINGS_STORAGE_KEY, JSON.stringify(bindings));
        } catch {
          // Client aliases are a startup optimization, not authoritative data.
        }
      },
    },
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
  const browserSurfaces = desktop ? new ElectronBrowserSurfaceHost(browserStorage!)
    : remoteBrowser ? new RemoteBrowserSurfaceHost(browserStorage ?? undefined, remoteStorage ? 'opencraft.remote-browser-storage.v1' : undefined, () => !remoteStorage || remoteStorage.isReady) : new WebIframeSurfaceHost();
  const releaseStorageErrors = remoteStorage?.onError(error => { if (browserSurfaces instanceof RemoteBrowserSurfaceHost) browserSurfaces.fail(error); });
  const browserPages = new WebBrowserPageRuntime(
    browserSurfaces,
    remoteBrowser ? null : hostProxy,
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
    releaseBrowserAdmission();
    browserPresentations.dispose();
    browserPages.dispose();
    browserSurfaces.dispose(); releaseStorageErrors?.(); remoteStorage?.dispose();
    conversationBindings.dispose();
    await panelRuntime.dispose().catch(() => undefined);
    throw error;
  }
  let browserWorkbench: BrowserWorkbenchCoordinator;
  let terminalSessions: ConversationTerminalSessionRegistry | null = null;
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
    );
    await panelRuntime.install(createBrowserWorkbenchPanelPlugin(
      browserWorkbench,
      (context) => browserWorkbench.open(context.resourceOwnerId, {
        panelOwnerId: context.ownerId,
      }),
    ));
    const browserToolHost = new WebBrowserDynamicToolHost(
      browserPages,
      browserWorkbench,
    );
    terminalSessions = new ConversationTerminalSessionRegistry((hostId) => {
      if (resolveTerminalRuntime === null) {
        throw new Error("Terminal Host is unavailable without an active AppServer runtime");
      }
      return resolveTerminalRuntime(hostId);
    });
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
      resolveTerminalRuntime = (hostId) => activeSupervisor.registry.getRuntime(hostId);
      await panelRuntime.install(SideChatService, { resolveHost: (hostId: string) => activeSupervisor.registry.ensureConnected(hostId) });
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
        await panelRuntime.install(createTerminalWorkbenchPanelPlugin(sessions, ownerId => ({ threadId: conversationBindings.resolve(ownerId as Parameters<typeof conversationBindings.resolve>[0])?.conversationKey?.threadId ?? null })));
      };
      if (optionalFeatures === null) await installTerminal();
      else optionalFeatures.add("terminal-presentation", installTerminal);
      browserWorkbench.restorePersistedTabs();
      if (deferredBrowser && remoteStorage) void remoteStorage.whenReady().then(() => {
        if (browserAdmission.signal.aborted) return;
        conversationBindings.restore(); browserPages.restore();
        if (browserSurfaces instanceof RemoteBrowserSurfaceHost) browserSurfaces.restoreStorage();
        browserWorkbench.restoreTabs(); browserWorkbench.restorePersistedTabs();
      }).catch(error => {
        if (!browserAdmission.signal.aborted && browserSurfaces instanceof RemoteBrowserSurfaceHost) browserSurfaces.fail(error as Error);
      });
    }
  } catch (error) {
    releaseBrowserAdmission();
    await optionalFeatures?.dispose();
    hostDesktop?.dispose();
    hostProxy.dispose();
    browserPresentations.dispose();
    browserPages.dispose();
    browserSurfaces.dispose(); releaseStorageErrors?.(); remoteStorage?.dispose();
    conversationBindings.dispose();
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
      releaseBrowserAdmission,
      () => optionalFeatures?.dispose(),
      // Retire consumers before their Host transport provider.
      () => hostProxy.dispose(),
      () => terminalSessions?.dispose(),
      () => panelRuntime.dispose(),
      () => hostDesktop?.dispose(),
      () => chatRenderRuntime.dispose(),
      () => browserWorkbench.dispose(),
      () => browserPresentations.dispose(),
      () => browserPages.dispose(),
      () => browserSurfaces.dispose(),
      async () => { releaseStorageErrors?.(); try { await remoteStorage?.flush(); } finally { remoteStorage?.dispose(); } },
      () => supervisor.dispose(),
    ], "Failed to dispose Web Workbench application"),
  };
}
