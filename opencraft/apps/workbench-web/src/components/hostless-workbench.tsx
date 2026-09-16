import { QueryClientProvider } from "@tanstack/react-query";
import type { PlatformViewHost } from "@opencraft/extension-react";
import {
  useCallback,
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  setAppearanceThemeId,
  setThemePreference,
  useAppearanceTheme,
} from "../appearance-theme";
import type { HostlessWebWorkbenchApplicationSupervisor } from "../runtime/appserver-runtime-context";
import { useExtensionWorkbenchProjection } from "../runtime/extension-workbench-projection";
import { parseApplicationRouteUrl, type ApplicationRoute } from "../runtime/workbench-navigation";
import { getWindowChromePolicy, useWindowChrome } from "../window-chrome";
import { AppShell } from "./app-shell";
import { InternalDeveloperModeGate } from "./internal-developer-mode-gate";
import { isLightVelaStandaloneManagementSection } from "./lightvela-management-route";
import { LightVelaWorkNavigation } from "./lightvela-work-navigation";
import {
  ManagementSettingsContent,
  ModalHost,
  showAnnouncementLab,
  type ModalRequest,
  useAnnouncementModalRequests,
} from "./modal";
import {
  AppShellHeader,
  AppShellNavigationControls,
} from "./app-shell-header";
import { Sidebar } from "./sidebar";
import { Button } from "./ui/button";
import {
  getSidebarMaximumWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MINIMUM_WIDTH,
} from "./sidebar-resize-handle";
import { useResponsiveSidebarDock } from "./use-responsive-sidebar-dock";

const HOSTLESS_APPLICATION_RETURN_KEY = "vela.hostless.application.return.v2";

function hasHostlessApplicationReturn(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[HOSTLESS_APPLICATION_RETURN_KEY] === true
  );
}

function hostlessApplicationHistoryState(value: unknown): Record<string, unknown> {
  return {
    ...(typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {}),
    [HOSTLESS_APPLICATION_RETURN_KEY]: true,
  };
}
const SettingsContent = lazy(async () => {
  const module = await import("./settings-page");
  return { default: module.SettingsContent };
});
const SettingsNavigation = lazy(async () => {
  const module = await import("./settings-page");
  return { default: module.SettingsNavigation };
});

/** Valid zero-Host projection: no fake Composer and no built-in connection prompt. */
export function HostlessWorkbench({
  supervisor,
}: {
  readonly supervisor: HostlessWebWorkbenchApplicationSupervisor;
}) {
  const [accountOpen, setAccountOpen] = useState(false);
  const appearance = useAppearanceTheme();
  const windowChrome = useWindowChrome();
  const chromePolicy = getWindowChromePolicy(windowChrome);
  const { sidebarOpen, setSidebarOpen } = useResponsiveSidebarDock();
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const storedWidth = Number.parseFloat(
      window.localStorage.getItem("sidebar-width") ?? "",
    );
    const initialWidth = Number.isFinite(storedWidth)
      ? storedWidth
      : SIDEBAR_DEFAULT_WIDTH;
    return Math.max(
      SIDEBAR_MINIMUM_WIDTH,
      Math.min(initialWidth, getSidebarMaximumWidth(Number.POSITIVE_INFINITY)),
    );
  });
  const [applicationRoute, setApplicationRoute] = useState<ApplicationRoute>(() =>
    parseApplicationRouteUrl(new URL(window.location.href))
  );
  const settingsSection = applicationRoute.kind === "settings" ? applicationRoute.slug : null;
  const settingsOpen = settingsSection !== null;
  const settingsContributionSnapshot = useSyncExternalStore(
    supervisor.extensions.contributions.subscribe,
    supervisor.extensions.contributions.getSnapshot,
    supervisor.extensions.contributions.getSnapshot,
  );
  const selectedSettingsContribution = settingsContributionSnapshot.settingsPages.find(
    ({ contribution }) => contribution.id === settingsSection,
  )?.contribution ?? null;
  const managementSettingsOpen = settingsOpen
    && selectedSettingsContribution?.management !== undefined;
  const standaloneManagementOpen = managementSettingsOpen
    && settingsSection !== null
    && isLightVelaStandaloneManagementSection(settingsSection);
  const routeSettingsOpen = settingsOpen && !managementSettingsOpen;
  const applicationReturnsToPreviousEntry = useRef(
    applicationRoute.kind !== "conversation" && hasHostlessApplicationReturn(window.history.state),
  );
  const profileSnapshot = useSyncExternalStore(
    supervisor.hostProfiles.subscribe,
    supervisor.hostProfiles.getSnapshot,
    supervisor.hostProfiles.getSnapshot,
  );
  useEffect(() => {
    if (profileSnapshot.profiles.some((profile) => profile.enabled)) window.location.reload();
  }, [profileSnapshot]);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty(
      "--codex-sidebar-preferred-width",
      `${sidebarWidth}px`,
    );
    return () => {
      document.documentElement.style.removeProperty(
        "--codex-sidebar-preferred-width",
      );
    };
  }, [sidebarWidth]);

  useEffect(() => {
    const restoreRoute = () => {
      const route = parseApplicationRouteUrl(new URL(window.location.href));
      applicationReturnsToPreviousEntry.current =
        route.kind !== "conversation" &&
        hasHostlessApplicationReturn(window.history.state);
      setApplicationRoute(route);
    };
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, []);

  const openSettings = (section = "appearance") => {
    if (applicationRoute.kind === "settings" && applicationRoute.slug === section) return;
    const url = `/settings/${encodeURIComponent(section)}`;
    if (applicationRoute.kind === "conversation") {
      applicationReturnsToPreviousEntry.current = true;
      window.history.pushState(
        hostlessApplicationHistoryState(window.history.state),
        "",
        url,
      );
    } else {
      window.history.replaceState(window.history.state, "", url);
    }
    setApplicationRoute({ kind: "settings", slug: section });
  };
  const closeApplicationRoute = () => {
    if (applicationReturnsToPreviousEntry.current) {
      window.history.back();
      return;
    }
    window.history.replaceState(window.history.state, "", "/");
    setApplicationRoute({ kind: "conversation" });
  };
  const openExtensionView = (viewId: string, resourceUri: string | null = null) => {
    if (
      applicationRoute.kind === "extension-view" &&
      applicationRoute.viewId === viewId &&
      applicationRoute.resourceUri === resourceUri
    ) return;
    const parameters = resourceUri === null
      ? ""
      : `?${new URLSearchParams({ resource: resourceUri })}`;
    const url = `/views/${encodeURIComponent(viewId)}${parameters}`;
    if (applicationRoute.kind === "conversation") {
      applicationReturnsToPreviousEntry.current = true;
      window.history.pushState(hostlessApplicationHistoryState(window.history.state), "", url);
    } else {
      window.history.replaceState(window.history.state, "", url);
    }
    setApplicationRoute({ kind: "extension-view", viewId, resourceUri });
  };
  const replaceExtensionViewResource = (viewId: string, resourceUri: string) => {
    if (
      applicationRoute.kind !== "extension-view" ||
      applicationRoute.viewId !== viewId ||
      applicationRoute.resourceUri === resourceUri
    ) return;
    const parameters = new URLSearchParams({ resource: resourceUri });
    window.history.replaceState(
      window.history.state,
      "",
      `/views/${encodeURIComponent(viewId)}?${parameters}`,
    );
    setApplicationRoute({ kind: "extension-view", viewId, resourceUri });
  };
  const pushExtensionViewResource = (viewId: string, resourceUri: string) => {
    if (
      applicationRoute.kind !== "extension-view" ||
      applicationRoute.viewId !== viewId ||
      applicationRoute.resourceUri === resourceUri
    ) return;
    const parameters = new URLSearchParams({ resource: resourceUri });
    window.history.pushState(
      hostlessApplicationHistoryState(window.history.state),
      "",
      `/views/${encodeURIComponent(viewId)}?${parameters}`,
    );
    setApplicationRoute({ kind: "extension-view", viewId, resourceUri });
  };
  const extensionHost = useMemo<PlatformViewHost>(() => ({
    platform: (globalThis as typeof globalThis & { opencraftDesktop?: { readonly kind?: string } })
      .opencraftDesktop?.kind === "electron" ? "electron" : "web",
    activeHostId: "",
    profiles: profileSnapshot.profiles,
    authentication: supervisor.authenticationFlows,
    provisionHost: supervisor.provisionHost,
    removeHost: supervisor.removeHost,
    openView: openExtensionView,
    openSettings: (section: string) => { setAccountOpen(false); openSettings(section); },
    pushViewResource: pushExtensionViewResource,
    replaceViewResource: replaceExtensionViewResource,
    prepareImageUpload: async (blob) => (await supervisor.images.compress(blob)).blob,
  }), [applicationRoute, profileSnapshot.profiles, supervisor]);
  const extensionProjection = useExtensionWorkbenchProjection({
    contributions: supervisor.extensions.contributions,
    renderers: supervisor.platformViewRenderers,
    accounts: supervisor.platformAccounts,
    botDirectory: supervisor.botDirectory,
    host: extensionHost,
    applicationRoute,
    openSettings,
    openView: openExtensionView,
  });
  useEffect(() => {
    if (extensionProjection.account?.snapshot.phase === "anonymous") setAccountOpen(false);
  }, [extensionProjection.account?.snapshot.phase]);
  const authenticationPresentation = useAuthenticationPresentation(supervisor.authenticationFlows, extensionProjection.account, JSON.stringify(applicationRoute));
  const sharedSidebarOpen = sidebarOpen;
  const selectSettingsSection = (section: string) => openSettings(section);
  const collapseSidebar = useCallback(() => setSidebarOpen(false), [setSidebarOpen]);
  const expandSidebar = useCallback(() => setSidebarOpen(true), [setSidebarOpen]);
  const commitSidebarWidth = useCallback((width: number, persist: boolean) => {
    setSidebarWidth(width);
    if (persist) window.localStorage.setItem("sidebar-width", String(width));
  }, []);
  const canGoBack =
    applicationRoute.kind !== "conversation" &&
    applicationReturnsToPreviousEntry.current;
  const canGoForward = false;
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => !open);
  }, [setSidebarOpen]);
  const navigateBack = useCallback(() => window.history.back(), []);
  const navigateForward = useCallback(() => window.history.forward(), []);
  const header = (
    <AppShellHeader
      title={
        applicationRoute.kind === "extension-view"
          ? (extensionProjection.activeView?.title ?? null)
          : null
      }
      project={null}
      sidebarOpen={sharedSidebarOpen}
      rightPanelOpen={false}
      rightPanelFullWidth={false}
      showRightPanelAction={false}
      onToggleSidebar={toggleSidebar}
      onToggleRightPanel={() => undefined}
      onHome={closeApplicationRoute}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      onBack={navigateBack}
      onForward={navigateForward}
      navigationActions={chromePolicy.leadingNavigationActions}
    />
  );
  const settingsNavigation = settingsOpen ? (
    <Suspense fallback={null}>
      <SettingsNavigation
        section={settingsSection ?? "appearance"}
        onSectionChange={selectSettingsSection}
        extensionContributions={supervisor.extensions.contributions}
        profiles={profileSnapshot.profiles}
        activeHostId=""
        onBack={closeApplicationRoute}
        presentation={managementSettingsOpen ? "dialog" : "sidebar"}
      />
    </Suspense>
  ) : null;
  const leftPanel = routeSettingsOpen ? settingsNavigation : (
    <Sidebar
      activeHostId=""
      activeThreadId=""
      managementNavigation={applicationRoute.kind === "conversation" || standaloneManagementOpen ? (
        <LightVelaWorkNavigation
          section={standaloneManagementOpen ? settingsSection : null}
          extensionContributions={supervisor.extensions.contributions}
          onSectionChange={selectSettingsSection}
        />
      ) : null}
      showFooter={false}
      catalogs={extensionProjection.catalogs}
      bots={extensionProjection.bots}
      sidebarLayout={supervisor.sidebarLayout}
      botCreation={extensionProjection.botCreation}
      onNewTask={() => undefined}
      onOpenSettings={() => openSettings()}
      onSelectThread={() => undefined}
      threads={[]}
    />
  );
  const settingsContent = settingsOpen ? (
    <Suspense
      fallback={
        <div className="settings-page-loading" role="status">
          Loading settings…
        </div>
      }
    >
      <SettingsContent
        section={settingsSection ?? "appearance"}
        onSectionChange={selectSettingsSection}
        activeHostId=""
        extensionContributions={supervisor.extensions.contributions}
        extensionManager={supervisor.extensionManager}
        onProvisionHost={supervisor.provisionHost}
        onOpenView={openExtensionView}
        onPushViewResource={pushExtensionViewResource}
        onReplaceViewResource={replaceExtensionViewResource}
        onRemove={supervisor.removeHost}
        onThemeChange={setAppearanceThemeId}
        onThemePreferenceChange={setThemePreference}
        onOpenAnnouncementLab={() => {
          void showAnnouncementLab(supervisor.extensions.announcements);
        }}
        platformViewRenderers={supervisor.platformViewRenderers}
        profiles={profileSnapshot.profiles}
        themeId={appearance.themeId}
        themePreference={appearance.preference}
        themes={appearance.availableThemes}
      />
    </Suspense>
  ) : null;
  const modalRequests: ModalRequest[] = [];
  const announcementModalRequests = useAnnouncementModalRequests(supervisor.extensions.announcements);
  if (managementSettingsOpen && !standaloneManagementOpen) {
    modalRequests.push({
      id: "management-settings",
      label: "Hermes settings",
      size: "workspace",
      className: "management-settings-dialog",
      dismissOnOutsidePress: false,
      content: (
        <ManagementSettingsContent navigation={settingsNavigation}>
          {settingsContent}
        </ManagementSettingsContent>
      ),
      onDismiss: () => {
        closeApplicationRoute();
      },
    });
  }
  if (accountOpen && extensionProjection.account !== null) {
    modalRequests.push({
      id: "account",
      label: "Account Settings",
      appearance: "utility",
      returnFocus: () => [...document.querySelectorAll<HTMLButtonElement>('.shell-navigation__entrance[data-surface="account"]')].find(button => button.getClientRects().length > 0) ?? null,
      size: "wide",
      dismissOnOutsidePress: false,
      content: extensionProjection.account.content,
      onDismiss: () => setAccountOpen(false),
    });
  }
  if (authenticationPresentation.modal) modalRequests.push(authenticationPresentation.modal);
  modalRequests.push(...announcementModalRequests);

  return (
    <QueryClientProvider client={supervisor.queryClient}>
      <InternalDeveloperModeGate />
      <AppShell
        navigation={{
          settingsActive: routeSettingsOpen,
          actions: [
            { id: "shell.chat", title: "Chat", icon: "chat", active: applicationRoute.kind === "conversation", onInvoke: closeApplicationRoute },
            ...extensionProjection.primaryActions, ...extensionProjection.footerActions,
          ],
          account: extensionProjection.account === null ? null : {
            snapshot: extensionProjection.account.snapshot,
            signIn: authenticationPresentation.signIn,
            onOpen: () => extensionProjection.account?.snapshot.phase === "anonymous" ? authenticationPresentation.open() : setAccountOpen(true),
            onRefresh: extensionProjection.account.provider.refresh,
            onSignOut: extensionProjection.account.provider.signOut,
          },
          onOpenSettings: () => openSettings(),
        }}
        layoutScope="hostless"
        mainContentLayout={
          applicationRoute.kind === "conversation"
          || (managementSettingsOpen && !standaloneManagementOpen)
            ? "thread-edge-scroll"
            : "default"
        }
        header={standaloneManagementOpen ? null : header}
        floatingSidebarHeader={(onDock) => (
          <AppShellNavigationControls
            hostRole="transient"
            sidebarOpen={false}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            onToggleSidebar={onDock}
            onHome={closeApplicationRoute}
            onBack={navigateBack}
            onForward={navigateForward}
            actions={chromePolicy.leadingNavigationActions}
          />
        )}
        leftPanel={routeSettingsOpen || applicationRoute.kind === "conversation" || managementSettingsOpen ? leftPanel : null}
        rightPanel={null}
        rightPanelOpen={false}
        rightPanelFullWidth={false}
        sidebarOpen={sharedSidebarOpen}
        sidebarWidth={sidebarWidth}
        windowChrome={windowChrome}
        onSidebarCollapse={collapseSidebar}
        onSidebarExpand={expandSidebar}
        onSidebarResizeEnd={commitSidebarWidth}
        onRightPanelOpenChange={() => undefined}
      >
        <div
          className={
            routeSettingsOpen
              ? "hostless-workbench__main settings-page__main"
              : "hostless-workbench__main"
          }
        >
            {routeSettingsOpen ? (
              <section className="settings-page" aria-label="Settings">
                {settingsContent}
              </section>
            ) : standaloneManagementOpen ? (
              <section className="lightvela-management-route" aria-label="LightVela management">
                {settingsContent}
              </section>
            ) : applicationRoute.kind === "extension-view" ? (
              <section className="extension-view-route" aria-label={extensionProjection.activeView?.title}>
                {extensionProjection.activeViewNode}
              </section>
            ) : (
              <div className="hostless-workbench__empty-stage">
                {extensionProjection.emptyWorkbenchNode ?? <section className="hostless-empty-view">
                  <h1>暂无可用 Agent</h1>
                  <p>你仍可以调整 OpenCraft 的设备设置。</p>
                  <Button variant="secondary" onClick={() => openSettings()}>打开设置</Button>
                </section>}
              </div>
            )}
        </div>
      </AppShell>
      <ModalHost requests={modalRequests} />
    </QueryClientProvider>
  );
}
import { useAuthenticationPresentation } from "../runtime/use-authentication-presentation";
