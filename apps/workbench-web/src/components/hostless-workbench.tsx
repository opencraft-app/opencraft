import { useIntl } from "@opencraft/i18n/react";
import { groupWorkInMachines } from "../runtime/work-in-presentation";
import { QueryClientProvider } from "@tanstack/react-query";
import type { PlatformViewHost } from "@opencraft/extension-react";
import {
  useCallback,
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
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
import { getWindowChromePolicy, useWindowChrome } from "../window-chrome";
import { AppShell } from "./app-shell";
import { InternalDeveloperModeGate } from "./internal-developer-mode-gate";
import { useInternalDeveloperMode } from "../internal-developer-mode";
import { isWorkbenchToolPage } from "../runtime/workbench-tool-pages";
import { WorkbenchToolNavigation } from "./workbench-tool-navigation";
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
import {
  AppShellRouteRegionsProvider,
  appShellPlatformViewRegions,
  useAppShellRouteHeader,
} from "./app-shell-route-regions";
import { Sidebar } from "./sidebar";
import { Button } from "./ui/button";
import { useResponsiveSidebarDock } from "./use-responsive-sidebar-dock";
import { usePersistedSidebarWidth } from "./use-persisted-sidebar-width";

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
  const intl = useIntl();
  const internalDeveloperMode = useInternalDeveloperMode();
  const [accountOpen, setAccountOpen] = useState(false);
  const appearance = useAppearanceTheme();
  const windowChrome = useWindowChrome();
  const chromePolicy = getWindowChromePolicy(windowChrome);
  const { sidebarOpen, setSidebarOpen } = useResponsiveSidebarDock();
  const { width: sidebarWidth, commit: commitSidebarWidth } = usePersistedSidebarWidth();
  const navigation = supervisor.navigation;
  const navigationSnapshot = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  const applicationRoute = navigationSnapshot.applicationRoute;
  const routeHeader = useAppShellRouteHeader(JSON.stringify(applicationRoute));
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
    && isWorkbenchToolPage(selectedSettingsContribution);
  const routeSettingsOpen = settingsOpen && !managementSettingsOpen;
  const profileSnapshot = useSyncExternalStore(
    supervisor.hostProfiles.subscribe,
    supervisor.hostProfiles.getSnapshot,
    supervisor.hostProfiles.getSnapshot,
  );
  const environmentSnapshot = useSyncExternalStore(supervisor.environmentDirectory.subscribe, supervisor.environmentDirectory.getSnapshot, supervisor.environmentDirectory.getSnapshot);
  const machines = useMemo(() => groupWorkInMachines(profileSnapshot.profiles, environmentSnapshot.entries), [profileSnapshot.profiles, environmentSnapshot.entries]);
  useEffect(() => {
    if (profileSnapshot.profiles.some((profile) => profile.enabled)) window.location.reload();
  }, [profileSnapshot]);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty(
      "--opencraft-sidebar-preferred-width",
      `${sidebarWidth}px`,
    );
    return () => {
      document.documentElement.style.removeProperty(
        "--opencraft-sidebar-preferred-width",
      );
    };
  }, [sidebarWidth]);

  const openSettings = navigation.openSettings;
  const closeApplicationRoute = navigation.openChat;
  const openExtensionView = navigation.openExtensionView;
  const replaceExtensionViewResource = navigation.replaceExtensionViewResource;
  const pushExtensionViewResource = navigation.pushExtensionViewResource;
  const extensionHost = useMemo<PlatformViewHost>(() => ({
    platform: (globalThis as typeof globalThis & { opencraftDesktop?: { readonly kind?: string } })
      .opencraftDesktop?.kind === "electron" ? "electron" : "web",
    activeHostId: "",
    profiles: profileSnapshot.profiles,
    ensureRuntimeReady: async (hostId) => { await supervisor.agentRuntimes.ensureReady(hostId); },
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
    internalDeveloperMode,
    openSettings,
    openView: openExtensionView,
  });
  useEffect(() => {
    if (applicationRoute.kind === "extension-view" && extensionProjection.activeView === null) {
      closeApplicationRoute();
    }
  }, [applicationRoute.kind, extensionProjection.activeView]);
  useEffect(() => {
    if (extensionProjection.account?.snapshot.phase === "anonymous" && extensionProjection.account.provider.signInViewId) setAccountOpen(false);
  }, [extensionProjection.account?.snapshot.phase, extensionProjection.account?.provider]);
  const authenticationPresentation = useAuthenticationPresentation(supervisor.authenticationFlows, extensionProjection.account, JSON.stringify(applicationRoute));
  const sharedSidebarOpen = sidebarOpen;
  const selectSettingsSection = (section: string, mode?: "push" | "replace") => openSettings(section, mode);
  const collapseSidebar = useCallback(() => setSidebarOpen(false), [setSidebarOpen]);
  const expandSidebar = useCallback(() => setSidebarOpen(true), [setSidebarOpen]);
  const { canGoBack, canGoForward } = navigationSnapshot;
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => !open);
  }, [setSidebarOpen]);
  const navigateBack = navigation.back;
  const navigateForward = navigation.forward;
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
      routeHeaderActive={routeHeader.active}
      routeHeaderHostRef={routeHeader.hostRef}
    />
  );
  const settingsNavigation = settingsOpen ? (
    <Suspense fallback={null}>
      <SettingsNavigation
        section={settingsSection ?? "appearance"}
        onSectionChange={selectSettingsSection}
        extensionContributions={supervisor.extensions.contributions}
        profiles={profileSnapshot.profiles}
        machines={machines}
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
        <WorkbenchToolNavigation
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
      onNewTask={closeApplicationRoute}
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
        observeMachineConnections={false}
        onSectionChange={selectSettingsSection}
        activeHostId=""
        extensionContributions={supervisor.extensions.contributions}
        extensionRuntime={supervisor.extensions}
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
        regions={appShellPlatformViewRegions}
        profiles={profileSnapshot.profiles}
        machines={machines}
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
      <AppShellRouteRegionsProvider
        controller={routeHeader.controller}
        target={routeHeader.target}
      >
      <AppShell
        navigation={{
          settingsActive: routeSettingsOpen,
          updatesActive: routeSettingsOpen && applicationRoute.kind === 'settings' && applicationRoute.slug === 'updates',
          actions: [
            { id: "shell.chat", title: intl.formatMessage({ id: "navigation.chat", defaultMessage: "Chat" }), icon: "chat", active: applicationRoute.kind === "conversation", onInvoke: closeApplicationRoute },
            ...extensionProjection.primaryActions, ...extensionProjection.footerActions,
          ],
          account: extensionProjection.account === null ? null : {
            snapshot: extensionProjection.account.snapshot,
            signIn: authenticationPresentation.signIn,
            onOpen: () => extensionProjection.account?.snapshot.phase === "anonymous" && extensionProjection.account.provider.signInViewId ? authenticationPresentation.open() : setAccountOpen(true),
            onRefresh: extensionProjection.account.provider.refresh,
            onSignOut: extensionProjection.account.provider.signOut,
          },
          onOpenSettings: () => openSettings(),
          onOpenUpdates: () => openSettings('updates'),
        }}
        layoutScope="hostless"
        mainContentLayout={
          applicationRoute.kind === "conversation"
          || (managementSettingsOpen && !standaloneManagementOpen)
            ? "thread-edge-scroll"
            : "default"
        }
        header={header}
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
              <section className="workbench-tool-route" aria-label="Account management">
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
      </AppShellRouteRegionsProvider>
      <ModalHost requests={modalRequests} />
    </QueryClientProvider>
  );
}
import { useAuthenticationPresentation } from "../runtime/use-authentication-presentation";
