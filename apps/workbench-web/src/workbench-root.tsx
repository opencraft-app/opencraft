import { lazy, Suspense, useSyncExternalStore } from 'react';
import { IdentityAvatarContext } from '@opencraft/extension-react';
import { TimelineBlockRendererProvider } from "@opencraft/timeline-render-react";
import { WebChatRenderRuntimeProvider } from "@opencraft/chat-render-web";

import { BrowserInputNotices } from './browser/browser-input-notices';
import { AsyncNoticesProvider } from "./components/async-notices";
import { ApplicationDesktopProvider } from "./components/application-desktop-motion";
const LazyCloudRelayPairingOverlay = lazy(() =>
  import("./components/cloud-relay-pairing-overlay").then((m) => ({ default: m.CloudRelayPairingOverlay })),
);
import { App } from "./app";
import { HostlessWorkbench } from "./components/hostless-workbench";
import {
  BrowserPresentationRoot,
  BrowserEnvironmentProvider,
} from "./browser/browser-runtime-context";
import { AppServerRuntimeProvider } from "./runtime/appserver-runtime-context";
import { TurnNotificationsProvider } from "./runtime/turn-notifications-context";
import { WorkbenchPanelRuntimeProvider } from "./runtime/panel-runtime-context";
import {
  createWebWorkbenchApplication,
  type WebWorkbenchApplication,
} from "./runtime/web-workbench-application";

export { createWebWorkbenchApplication };

function WorkbenchContent({
  application,
}: {
  readonly application: WebWorkbenchApplication;
}) {
  if (application.supervisor.mode === "hostless") {
    return <TurnNotificationsProvider source={application.supervisor.turnCompletions}
      notifications={application.supervisor.turnNotifications} openConversation={async () => false}>
      <HostlessWorkbench supervisor={application.supervisor} />
    </TurnNotificationsProvider>;
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
              <App conversationPresentation={application.conversationPresentation} />
            </AppServerRuntimeProvider>
          </TimelineBlockRendererProvider>
        </WebChatRenderRuntimeProvider>
      </WorkbenchPanelRuntimeProvider>
    </BrowserEnvironmentProvider>
  );
}

export function WorkbenchRoot({ application }: { readonly application: WebWorkbenchApplication }) {
  const avatars = application.supervisor.identityAvatars;
  const identityAvatar = useSyncExternalStore(avatars.subscribe, avatars.getSnapshot).contribution;
  return <IdentityAvatarContext.Provider value={identityAvatar}><AsyncNoticesProvider><BrowserInputNotices pages={application.browserPages} /><ApplicationDesktopProvider navigation={application.supervisor.navigation}>
    <WorkbenchContent application={application} />
    <Suspense fallback={null}><LazyCloudRelayPairingOverlay /></Suspense>
  </ApplicationDesktopProvider></AsyncNoticesProvider></IdentityAvatarContext.Provider>;
}
