import { Context } from "@deepseek-ai/cordis";
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
import { BrowserPresentationCoordinator } from "../browser/browser-presentation-coordinator";
import { BrowserWorkbenchCoordinator } from "../browser/browser-workbench-coordinator";
import { WebBrowserPageRuntime } from "../browser/web-browser-runtime";
import { WebIframeSurfaceHost, type BrowserSurfaceHost } from "../browser/web-browser-surface-host";
import { ElectronBrowserSurfaceHost } from "../browser/electron-browser-surface-host";
import { createDesktopBrowserStorage, type BrowserMetadataStorage } from "../browser/desktop-browser-storage";
import { WebBrowserDynamicToolHost } from "../browser/web-browser-tool-host";
import { WebHostProxyBroker } from "../browser/web-host-proxy-broker";
import { BuiltinWorkbenchPanelPlugin } from "../panels/builtin-panel-plugin";
import { createSideChatPanelPlugin } from "../panels/side-chat-panel-plugin";
import { BuiltinTimelineRendererPlugin } from "../components/conversation-renderers/builtin-timeline-renderer-plugin";
import {
  createWebWorkbenchApplicationSupervisor,
  type WebWorkbenchApplicationSupervisor,
  type WebWorkbenchSupervisorOptions,
} from "./appserver-runtime-context";
import {
  createWorkbenchPanelRuntime,
} from "./panel-runtime-context";
import type { WorkbenchPanelReactRuntime } from "@opencraft/workbench-panels-react";
import {
  bootstrapLightVelaOAuthCallback,
  bootstrapLightVelaWebLoginCallback,
} from "@opencraft/plugin-lightvela-platform";

export interface WebWorkbenchApplication {
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

const CONVERSATION_BINDINGS_STORAGE_KEY = "vela.conversation-bindings.v1";

function loadConversationBindings(storage: BrowserMetadataStorage = window.localStorage): readonly PersistedConversationBinding[] {
  try {
    const value = JSON.parse(storage.getItem(CONVERSATION_BINDINGS_STORAGE_KEY) ?? "[]");
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
export interface CreateWebWorkbenchApplicationOptions extends WebWorkbenchSupervisorOptions {}

export async function createWebWorkbenchApplication(
  options: CreateWebWorkbenchApplicationOptions = {},
): Promise<WebWorkbenchApplication> {
  // OAuth can return into any Workbench route. Consume its one-time fragment
  // before IndexedDB, Cordis and extension activation so authentication does
  // not depend on the latency or success of the rest of application startup.
  const desktop = (globalThis as typeof globalThis & { opencraftDesktop?: { kind?: string } }).opencraftDesktop?.kind === "electron";
  const browserStorage = desktop ? await createDesktopBrowserStorage() : null;
  if (!desktop) {
    await bootstrapLightVelaWebLoginCallback();
    bootstrapLightVelaOAuthCallback();
  }
  // Desktop account restoration is independent of local Host startup. The
  // local Host and its environment configuration must remain usable meanwhile.
  const cordis = new Context();
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
  const hostProxy = new WebHostProxyBroker(async (hostId, targetUrl, init) => {
    if (supervisor.mode !== "active") {
      throw new Error("Host proxy is unavailable without an active AppServer runtime");
    }
    const runtime = await supervisor.registry.ensureConnected(hostId);
    return runtime.resources.host.fetchLoopback(targetUrl, init);
  });
  const browserSurfaces = desktop ? new ElectronBrowserSurfaceHost(browserStorage!) : new WebIframeSurfaceHost();
  const browserPages = new WebBrowserPageRuntime(
    browserSurfaces,
    hostProxy,
    (ownerId) => conversationBindings.resolve(
      ownerId as Parameters<typeof conversationBindings.resolve>[0],
    )?.hostId ?? null,
    browserStorage,
  );
  const browserPresentations = new BrowserPresentationCoordinator(browserPages, browserSurfaces);
  const panelRuntime = await createWorkbenchPanelRuntime(cordis);
  let chatRenderRuntime: ChatRenderRuntime;
  try {
    chatRenderRuntime = await createWebChatRenderRuntime(cordis);
  } catch (error) {
    browserPresentations.dispose();
    browserPages.dispose();
    browserSurfaces.dispose();
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
    browserWorkbench = new BrowserWorkbenchCoordinator(
      browserPages,
      panelRuntime.panels,
      conversationBindings,
      browserStorage,
    );
    await panelRuntime.install(createBrowserWorkbenchPanelPlugin(
      browserPages,
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
      options,
    );
    releaseSupervisor = () => supervisor.dispose();
    if (supervisor.mode === "active") {
      const activeSupervisor = supervisor;
      resolveTerminalRuntime = (hostId) => activeSupervisor.registry.getRuntime(hostId);
      await panelRuntime.install(SideChatService, { resolveHost: (hostId: string) => activeSupervisor.registry.ensureConnected(hostId) });
      await panelRuntime.install(createSideChatPanelPlugin(panelRuntime.context.sideChats, conversationBindings));
      const desktopKind = (
        globalThis as typeof globalThis & { readonly opencraftDesktop?: { readonly kind?: string } }
      ).opencraftDesktop?.kind;
      if (desktopKind !== "electron") {
        try {
          const proxyReady = await hostProxy.start();
          if (!proxyReady) {
            console.warn("[host-proxy] Service Worker is unavailable; remote loopback previews are disabled");
          } else {
            console.info("[host-proxy] Service Worker broker ready", { brokerId: hostProxy.brokerId });
          }
        } catch (error) {
          console.warn("[host-proxy] Service Worker registration failed", error);
        }
      }
      const {
        createTerminalWorkbenchPanelPlugin,
      } = await import("@opencraft/plugin-terminal");
      await panelRuntime.install(
        createTerminalWorkbenchPanelPlugin(terminalSessions),
      );
      browserWorkbench.restorePersistedTabs();
    }
  } catch (error) {
    hostProxy.dispose();
    browserPresentations.dispose();
    browserPages.dispose();
    browserSurfaces.dispose();
    conversationBindings.dispose();
    await terminalSessions?.dispose().catch(() => undefined);
    await panelRuntime.dispose().catch(() => undefined);
    await chatRenderRuntime.dispose().catch(() => undefined);
    await releaseSupervisor?.().catch(() => undefined);
    throw error;
  }
  let disposed = false;
  return {
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
    async dispose() {
      if (disposed) return;
      disposed = true;
      const failures: unknown[] = [];
      // Retire consumers before their Host transport provider.
      hostProxy.dispose();
      try {
        await terminalSessions?.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        await panelRuntime.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        await chatRenderRuntime.dispose();
      } catch (error) {
        failures.push(error);
      }
      browserWorkbench.dispose();
      browserPresentations.dispose();
      browserPages.dispose();
      browserSurfaces.dispose();
      try {
        await supervisor.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to dispose Web Workbench application");
      }
    },
  };
}
