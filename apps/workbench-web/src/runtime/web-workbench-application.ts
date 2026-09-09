import { Context } from "@deepseek-ai/cordis";
import {
  createWebChatRenderRuntime,
  type ChatRenderRuntime,
} from "@opencraft/chat-render-web";
import { TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import {
  createConversationBindingStore,
  type PersistedConversationBinding,
} from "@opencraft/workbench-runtime";

import { createBrowserWorkbenchPanelPlugin } from "../browser/browser-panel-plugin";
import { BrowserPresentationCoordinator } from "../browser/browser-presentation-coordinator";
import { BrowserWorkbenchCoordinator } from "../browser/browser-workbench-coordinator";
import { WebBrowserPageRuntime } from "../browser/web-browser-runtime";
import { WebIframeSurfaceHost } from "../browser/web-browser-surface-host";
import { WebBrowserDynamicToolHost } from "../browser/web-browser-tool-host";
import { BuiltinWorkbenchPanelPlugin } from "../panels/builtin-panel-plugin";
import { BuiltinTimelineRendererPlugin } from "../components/conversation-renderers/builtin-timeline-renderer-plugin";
import {
  createWebWorkbenchApplicationSupervisor,
  type WebWorkbenchApplicationSupervisor,
} from "./appserver-runtime-context";
import {
  createWorkbenchPanelRuntime,
} from "./panel-runtime-context";
import type { WorkbenchPanelReactRuntime } from "@opencraft/workbench-panels-react";
import type { WorkbenchTerminalSessionRegistry } from "@opencraft/plugin-terminal";

export interface WebWorkbenchApplication {
  readonly cordis: Context;
  readonly browserPages: WebBrowserPageRuntime;
  readonly browserSurfaces: WebIframeSurfaceHost;
  readonly browserPresentations: BrowserPresentationCoordinator;
  readonly browserWorkbench: BrowserWorkbenchCoordinator;
  readonly chatRenderRuntime: ChatRenderRuntime;
  readonly panelRuntime: WorkbenchPanelReactRuntime;
  readonly timelineRenderers: TimelineBlockRendererRegistryService;
  readonly supervisor: WebWorkbenchApplicationSupervisor;
  readonly terminalSessions: WorkbenchTerminalSessionRegistry | null;
  dispose(): Promise<void>;
}

const CONVERSATION_BINDINGS_STORAGE_KEY = "vela.conversation-bindings.v1";

function loadConversationBindings(): readonly PersistedConversationBinding[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(CONVERSATION_BINDINGS_STORAGE_KEY) ?? "[]");
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
export async function createWebWorkbenchApplication(): Promise<WebWorkbenchApplication> {
  const cordis = new Context();
  const browserSurfaces = new WebIframeSurfaceHost();
  const browserPages = new WebBrowserPageRuntime(browserSurfaces);
  const browserPresentations = new BrowserPresentationCoordinator(browserPages, browserSurfaces);
  const conversationBindings = createConversationBindingStore({
    persistence: {
      load: loadConversationBindings,
      save(bindings) {
        try {
          window.localStorage.setItem(CONVERSATION_BINDINGS_STORAGE_KEY, JSON.stringify(bindings));
        } catch {
          // Client aliases are a startup optimization, not authoritative data.
        }
      },
    },
  });
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
  let supervisor: WebWorkbenchApplicationSupervisor;
  let terminalSessions: WorkbenchTerminalSessionRegistry | null = null;
  try {
    await panelRuntime.install(TimelineBlockRendererRegistryService);
    await panelRuntime.install(BuiltinTimelineRendererPlugin);
    await panelRuntime.install(BuiltinWorkbenchPanelPlugin);
    browserWorkbench = new BrowserWorkbenchCoordinator(
      browserPages,
      panelRuntime.panels,
      conversationBindings,
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
    supervisor = await createWebWorkbenchApplicationSupervisor(
      browserToolHost,
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
    );
    if (supervisor.mode === "active") {
      const activeSupervisor = supervisor;
      const {
        WorkbenchTerminalSessionRegistry,
        createTerminalWorkbenchPanelPlugin,
      } = await import("@opencraft/plugin-terminal");
      terminalSessions = new WorkbenchTerminalSessionRegistry(
        (hostId) => activeSupervisor.registry.getRuntime(hostId),
      );
      await panelRuntime.install(
        createTerminalWorkbenchPanelPlugin(terminalSessions),
      );
      browserWorkbench.restorePersistedTabs();
    }
  } catch (error) {
    browserPresentations.dispose();
    browserPages.dispose();
    browserSurfaces.dispose();
    conversationBindings.dispose();
    await terminalSessions?.dispose().catch(() => undefined);
    await panelRuntime.dispose().catch(() => undefined);
    await chatRenderRuntime.dispose().catch(() => undefined);
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
      try {
        await terminalSessions?.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        await supervisor.dispose();
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
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to dispose Web Workbench application");
      }
    },
  };
}
