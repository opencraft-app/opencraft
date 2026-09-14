import { TimelineBlockRendererProvider } from "@opencraft/timeline-render-react";
import { WebChatRenderRuntimeProvider } from "@opencraft/chat-render-web";

import { App } from "./app";
import { HostlessWorkbench } from "./components/hostless-workbench";
import {
  BrowserPresentationRoot,
  BrowserEnvironmentProvider,
} from "./browser/browser-runtime-context";
import { AppServerRuntimeProvider } from "./runtime/appserver-runtime-context";
import { WorkbenchPanelRuntimeProvider } from "./runtime/panel-runtime-context";
import {
  createWebWorkbenchApplication,
  type WebWorkbenchApplication,
} from "./runtime/web-workbench-application";

export { createWebWorkbenchApplication };

export function WorkbenchRoot({
  application,
}: {
  readonly application: WebWorkbenchApplication;
}) {
  if (application.supervisor.mode === "hostless") {
    return <HostlessWorkbench supervisor={application.supervisor} />;
  }

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
            <AppServerRuntimeProvider supervisor={application.supervisor}>
              <App />
            </AppServerRuntimeProvider>
          </TimelineBlockRendererProvider>
        </WebChatRenderRuntimeProvider>
      </WorkbenchPanelRuntimeProvider>
    </BrowserEnvironmentProvider>
  );
}
