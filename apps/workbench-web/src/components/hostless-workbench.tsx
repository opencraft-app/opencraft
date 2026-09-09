import { QueryClientProvider } from "@tanstack/react-query";
import { useSettingsPresentation } from "./use-settings-presentation";
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
import {
  AppShellHeader,
  AppShellNavigationControls,
} from "./app-shell-header";
import { Sidebar } from "./sidebar";
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
      Math.min(initialWidth, getSidebarMaximumWidth(window.innerWidth)),
    );
  });
  const [applicationRoute, setApplicationRoute] = useState<ApplicationRoute>(() =>
    parseApplicationRouteUrl(new URL(window.location.href))
  );
  const settingsSection = applicationRoute.kind === "settings" ? applicationRoute.slug : null;
  const settingsOpen = settingsSection !== null;
  const settingsPresentation = useSettingsPresentation(sidebarWidth);
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
    const clampSidebarToViewport = () => {
      setSidebarWidth((currentWidth) =>
        Math.min(currentWidth, getSidebarMaximumWidth(window.innerWidth)),
      );
    };
    window.addEventListener("resize", clampSidebarToViewport);
    return () => window.removeEventListener("resize", clampSidebarToViewport);
  }, []);

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

  const openSettings = (section = "connections") => {
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
  const extensionHost = useMemo<PlatformViewHost>(() => ({
    platform: (globalThis as typeof globalThis & { opencraftDesktop?: { readonly kind?: string } })
      .opencraftDesktop?.kind === "electron" ? "electron" : "web",
    activeHostId: "",
    profiles: profileSnapshot.profiles,
    provisionHost: supervisor.provisionHost,
    removeHost: supervisor.removeHost,
    openView: openExtensionView,
    replaceViewResource: replaceExtensionViewResource,
  }), [applicationRoute, profileSnapshot.profiles, supervisor]);
  const extensionProjection = useExtensionWorkbenchProjection({
    contributions: supervisor.extensions.contributions,
    renderers: supervisor.platformViewRenderers,
    botDirectory: supervisor.botDirectory,
    host: extensionHost,
    applicationRoute,
    openSettings,
    openView: openExtensionView,
  });
  const sharedSidebarOpen = settingsOpen ? settingsPresentation.showIndex : sidebarOpen;
  const selectSettingsSection = (section: string) => { openSettings(section); settingsPresentation.openContent(); };
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
    if (!settingsOpen) setSidebarOpen((open) => !open);
  }, [setSidebarOpen, settingsOpen]);
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
      navigationActions={settingsOpen ? [] : chromePolicy.leadingNavigationActions}
    />
  );
  const leftPanel = settingsOpen ? (
    <Suspense fallback={null}>
      <SettingsNavigation
        section={settingsSection ?? "connections"}
        onSectionChange={selectSettingsSection}
        extensionContributions={supervisor.extensions.contributions}
        profiles={profileSnapshot.profiles}
        activeHostId=""
        onBack={() => { settingsPresentation.openContent(); closeApplicationRoute(); }}
      />
    </Suspense>
  ) : (
    <Sidebar
      activeHostId=""
      activeThreadId=""
      primaryActions={extensionProjection.primaryActions}
      footerActions={extensionProjection.footerActions}
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

  return (
    <QueryClientProvider client={supervisor.queryClient}>
      <AppShell
        layoutScope="hostless"
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
        leftPanel={leftPanel}
        rightPanel={null}
        rightPanelOpen={false}
        rightPanelFullWidth={false}
        sidebarCollapsible={!settingsOpen}
        sidebarTransientEnabled={!settingsOpen}
        sidebarResizable={!settingsOpen}
        sidebarOpen={sharedSidebarOpen}
        sidebarWidth={settingsOpen ? settingsPresentation.sidebarWidth : sidebarWidth}
        windowChrome={windowChrome}
        onSidebarCollapse={settingsOpen ? () => undefined : collapseSidebar}
        onSidebarExpand={expandSidebar}
        onSidebarResizeEnd={commitSidebarWidth}
        onRightPanelOpenChange={() => undefined}
      >
        <div
          className={
            settingsOpen
              ? "hostless-workbench__main settings-page__main"
              : "hostless-workbench__main"
          }
        >
            {settingsOpen ? (
              <section className="settings-page" aria-label="Settings" inert={settingsPresentation.indexOnly || undefined} aria-hidden={settingsPresentation.indexOnly || undefined}>
                {settingsPresentation.compact ? <nav className="settings-page__compact-navigation" aria-label="Settings navigation"><button className="settings-navigation-link" type="button" onClick={settingsPresentation.openIndex}><span aria-hidden="true">‹</span>Settings</button></nav> : null}
                <Suspense
                  fallback={
                    <div className="settings-page-loading" role="status">
                      Loading settings…
                    </div>
                  }
                >
                  <SettingsContent
                    section={settingsSection ?? "connections"}
                    onSectionChange={selectSettingsSection}
                    activeHostId=""
                    extensionContributions={supervisor.extensions.contributions}
                    extensionManager={supervisor.extensionManager}
                    onAdd={supervisor.addWebSocketHost}
                    onProvisionHost={supervisor.provisionHost}
                    onOpenView={openExtensionView}
                    onReplaceViewResource={replaceExtensionViewResource}
                    onRemove={supervisor.removeHost}
                    onThemeChange={setAppearanceThemeId}
                    onThemePreferenceChange={setThemePreference}
                    platformViewRenderers={supervisor.platformViewRenderers}
                    profiles={profileSnapshot.profiles}
                    themeId={appearance.themeId}
                    themePreference={appearance.preference}
                    themes={appearance.availableThemes}
                  />
                </Suspense>
              </section>
            ) : applicationRoute.kind === "extension-view" ? (
              <section className="extension-view-route" aria-label={extensionProjection.activeView?.title}>
                {extensionProjection.activeViewNode}
              </section>
            ) : (
              <div className="hostless-workbench__empty-stage">
                {extensionProjection.emptyWorkbenchNode}
              </div>
            )}
        </div>
      </AppShell>
    </QueryClientProvider>
  );
}
