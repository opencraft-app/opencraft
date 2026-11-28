import { lazy, Suspense, useEffect, useSyncExternalStore } from "react";
import { IdentityAvatarContext } from "@opencraft/extension-react";
import { TimelineBlockRendererProvider } from "@opencraft/timeline-render-react";
import { WebChatRenderRuntimeProvider } from "@opencraft/chat-render-web";

import { BrowserInputNotices } from "./browser/browser-input-notices";
import { AsyncNoticesProvider } from "./components/async-notices";
import { ApplicationDesktopProvider } from "./components/application-desktop-motion";
const LazyCloudRelayPairingOverlay = lazy(() =>
  import("./components/cloud-relay-pairing-overlay").then((m) => ({ default: m.CloudRelayPairingOverlay })),
);
const LazyRemoteWorkbenchWelcome = lazy(() =>
  import("./components/remote-workbench-welcome").then((m) => ({ default: m.RemoteWorkbenchWelcome })),
);
import { App } from "./app";
import { HostlessWorkbench } from "./components/hostless-workbench";
import {
  BrowserPresentationRoot,
  BrowserEnvironmentProvider,
} from "./browser/browser-runtime-context";
import { AppServerRuntimeProvider, readLocalPreference } from "./runtime/appserver-runtime-context";
import {
  closeCloudRelayStandalonePortal,
  getCloudRelayStandalonePortalOpen,
  openCloudRelayStandalonePortal,
  subscribeCloudRelayStandalonePortal,
} from "./runtime/cloud-relay-banner-state";
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
  const standalonePortalOpen = useSyncExternalStore(
    subscribeCloudRelayStandalonePortal,
    getCloudRelayStandalonePortalOpen,
    getCloudRelayStandalonePortalOpen,
  );
  const isHostedRemoteWeb =
    typeof document !== "undefined" && document.getElementById("opencraft-deployment-config") !== null;

  // When a returning Passkey user opens `my.opencraft.app` cold and their remembered computer
  // has its lid closed (offline), automatically present `My Computers` instead of stranding them
  // on an endlessly reconnecting chat screen.
  useEffect(() => {
    if (!isHostedRemoteWeb || application.supervisor.mode === "hostless") return;
    let cancelled = false;
    try {
      if (window.sessionStorage.getItem("opencraft.hub-entered-session") === "1") return;
    } catch {
      return;
    }
    void import("./runtime/cloud-relay-client").then(async (mod) => {
      if (cancelled) return;
      const hubSession = mod.readStoredPersonalHubSession();
      if (!hubSession) return;
      const overview = await mod.fetchPersonalHubOverview(hubSession).catch(() => null);
      if (cancelled || !overview) return;
      const activeHostId = readLocalPreference("opencraft.active-host-id") ?? "";
      const activeMachineId = activeHostId.startsWith("relay:")
        ? activeHostId.slice(6).split(":")[0] ?? ""
        : "";
      const activeMachine = activeMachineId
        ? overview.machines.find((m) => m.machineId === activeMachineId)
        : overview.machines[0];
      if (!activeMachine || !activeMachine.online) {
        openCloudRelayStandalonePortal();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [application.supervisor.mode, isHostedRemoteWeb]);

  if (application.supervisor.mode === "hostless") {
    return (
      <TurnNotificationsProvider
        source={application.supervisor.turnCompletions}
        notifications={application.supervisor.turnNotifications}
        openConversation={async () => false}
      >
        <HostlessWorkbench supervisor={application.supervisor} />
      </TurnNotificationsProvider>
    );
  }

  if (isHostedRemoteWeb && standalonePortalOpen) {
    return (
      <main className="remote-welcome-standalone-stage">
        <Suspense fallback={null}>
          <LazyRemoteWorkbenchWelcome
            hostProfiles={application.supervisor.hostProfiles}
            hasConnectedHost={true}
            onClosePortal={closeCloudRelayStandalonePortal}
          />
        </Suspense>
      </main>
    );
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
  return (
    <IdentityAvatarContext.Provider value={identityAvatar}>
      <AsyncNoticesProvider>
        <BrowserInputNotices pages={application.browserPages} />
        <ApplicationDesktopProvider navigation={application.supervisor.navigation}>
          <WorkbenchContent application={application} />
          <Suspense fallback={null}>
            <LazyCloudRelayPairingOverlay isHostless={application.supervisor.mode === "hostless"} />
          </Suspense>
        </ApplicationDesktopProvider>
      </AsyncNoticesProvider>
    </IdentityAvatarContext.Provider>
  );
}
