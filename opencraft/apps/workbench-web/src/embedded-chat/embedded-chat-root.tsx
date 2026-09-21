import { WebChatRenderRuntimeProvider } from "@opencraft/chat-render-web";
import { TimelineBlockRendererProvider } from "@opencraft/timeline-render-react";
import { useMemo } from "react";

import {
  App,
  type EmbeddedWorkbenchAppActions,
  type EmbeddedWorkbenchAppPresentation,
  type EmbeddedWorkbenchAppSession,
} from "../app";
import {
  BrowserEnvironmentProvider,
  BrowserPresentationRoot,
} from "../browser/browser-runtime-context";
import { AppServerRuntimeProvider } from "../runtime/appserver-runtime-context";
import {
  WorkbenchPanelRuntimeProvider,
} from "../runtime/panel-runtime-context";
import type { WebWorkbenchApplication } from "../runtime/web-workbench-application";
import { WorkbenchPresentationRootProvider } from "../components/workbench-presentation-root";
import { EMBEDDED_CORE_CHAT_PRESENTATION } from "../workbench-presentation-policy";

export interface EmbeddedChatRootProps {
  readonly application: WebWorkbenchApplication;
  readonly bindActions: (actions: EmbeddedWorkbenchAppActions) => (() => void);
  readonly hostId: string;
  readonly onError: (error: Error) => void;
  readonly onReady: (threadId: string | null) => void;
  readonly onSessionsChange: (detail: {
    readonly sessions: readonly EmbeddedWorkbenchAppSession[];
    readonly loading: boolean;
    readonly selectedChatId: string | null;
  }) => void;
  readonly portalContainer: HTMLElement;
}

/**
 * The embedded product is the regular Workbench conversation route with only
 * its presentation chrome narrowed. Thread/Draft, Composer, steer, Browser and
 * Terminal continue to use the same application owners as the full Workbench.
 */
export function EmbeddedChatRoot({
  application,
  bindActions,
  hostId,
  onError,
  onReady,
  onSessionsChange,
  portalContainer,
}: EmbeddedChatRootProps) {
  if (application.supervisor.mode !== "active") {
    throw new Error("Embedded Chat requires an active OpenCraft Host");
  }
  const supervisor = application.supervisor;
  const embedded = useMemo<EmbeddedWorkbenchAppPresentation>(() => ({
    hostId,
    bindActions,
    onError,
    onReady,
    onSessionsChange,
  }), [bindActions, hostId, onError, onReady, onSessionsChange]);
  return (
    <BrowserEnvironmentProvider
      pages={application.browserPages}
      surfaces={application.browserSurfaces}
      presentations={application.browserPresentations}
      workbench={application.browserWorkbench}
    >
      <BrowserPresentationRoot />
      <WorkbenchPanelRuntimeProvider runtime={application.panelRuntime}>
        <WebChatRenderRuntimeProvider runtime={application.chatRenderRuntime}>
          <TimelineBlockRendererProvider registry={application.timelineRenderers}>
            <AppServerRuntimeProvider supervisor={supervisor}>
              <WorkbenchPresentationRootProvider target={portalContainer}>
                <App
                  embedded={embedded}
                  presentation={EMBEDDED_CORE_CHAT_PRESENTATION}
                />
              </WorkbenchPresentationRootProvider>
            </AppServerRuntimeProvider>
          </TimelineBlockRendererProvider>
        </WebChatRenderRuntimeProvider>
      </WorkbenchPanelRuntimeProvider>
    </BrowserEnvironmentProvider>
  );
}
