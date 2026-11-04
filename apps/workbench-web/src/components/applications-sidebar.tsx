import { useSyncExternalStore, type ReactNode } from "react";
import { NavigationList, NavigationItem } from "@opencraft/design-system-web/navigation";
import { useIntl } from "@opencraft/i18n/react";
import type { ExtensionContributionStore } from "@opencraft/extension-runtime";
import type { PlatformViewHost, PlatformViewRendererRegistry } from "@opencraft/extension-react";
import type { ApplicationRoute } from "../runtime/workbench-navigation";
import { projectMiniApps } from "../runtime/mini-apps";
import { useInternalDeveloperMode } from "../internal-developer-mode";
import { SidebarReturnToApp } from "./sidebar-return-to-app";
import { ShellPresentationContext, useShellPresentation } from "./shell-presentation";
import { type NavigationAction, NavigationIcon } from "./shell-navigation/navigation-action";
import "./applications-sidebar.scss";

/** A list projection of the same installed applications used by the desktop. */
export function ApplicationsSidebar({ contributions, renderers, host, route, actions = [] }: {
  readonly contributions: ExtensionContributionStore;
  readonly renderers: PlatformViewRendererRegistry;
  readonly host: PlatformViewHost;
  readonly route: ApplicationRoute;
  readonly actions?: readonly NavigationAction[];
}) {
  const intl = useIntl();
  const internal = useInternalDeveloperMode();
  const shell = useShellPresentation();
  const snapshot = useSyncExternalStore(contributions.subscribe, contributions.getSnapshot);
  useSyncExternalStore(renderers.subscribe, renderers.getSnapshot);
  const apps = projectMiniApps(snapshot, host.platform, internal, type => renderers.resolve(type) !== null);
  const title = intl.formatMessage({ id: "navigation.applications", defaultMessage: "Applications" });
  return <div className="applications-sidebar">
    <NavigationList inset="sidebar" label={title} className="applications-sidebar__list">
      {apps.map(app => {
        const label = app.titleMessage ? intl.formatMessage(app.titleMessage) : app.title;
        const target = app.target;
        const active = target.kind === "view" ? route.kind === "extension-view" && route.viewId === target.viewId
          : route.kind === "settings" && route.slug === target.pageId;
        return <NavigationItem key={app.id} type="button" data-sidebar-miniapp-id={app.id}
          aria-label={label} aria-current={active ? "page" : undefined} onClick={() => {
            shell?.dismissSidebarAfterSelection();
            if (target.kind === "settings") host.openSettings?.(target.pageId);
            else host.openView(target.viewId);
          }}>
          <NavigationIcon name={app.icon} selected={active} />
          <span className="applications-sidebar__label">{label}</span>
        </NavigationItem>;
      })}
      {actions.map(action => <NavigationItem key={action.id} type="button" data-action-id={action.id}
        aria-label={action.title} aria-current={action.active ? "page" : undefined} onClick={() => {
          shell?.dismissSidebarAfterSelection();
          action.onInvoke();
        }}>
        <NavigationIcon name={action.icon} selected={action.active} />
        <span className="applications-sidebar__label">{action.title}</span>
      </NavigationItem>)}
    </NavigationList>
    {apps.length === 0 && actions.length === 0 ? <p className="applications-sidebar__empty" role="status">{intl.formatMessage({
      id: "overhome.empty", defaultMessage: "Your apps will appear here." })}</p> : null}
  </div>;
}

/** Applications and route context occupy the same sidebar slot exclusively. */
export function ApplicationsSidebarFrame({ children, selected, settingsContent, onReturnToChat, ...props }: Parameters<typeof ApplicationsSidebar>[0] & {
  readonly children?: ReactNode;
  readonly selected: boolean;
  readonly settingsContent?: ReactNode;
  readonly onReturnToChat: () => void;
}) {
  const shell = useShellPresentation();
  return <div className="applications-sidebar-frame" data-sidebar-destination={selected ? "applications" : settingsContent ? "settings" : "context"}>
    <div className="applications-sidebar-frame__catalog" hidden={!selected}>
      <ApplicationsSidebar {...props} />
      {selected ? <SidebarReturnToApp onReturn={onReturnToChat} /> : null}
    </div>
    {settingsContent ? <div className="applications-sidebar-frame__context">{settingsContent}</div> : null}
    {children ? <div className="applications-sidebar-frame__context" hidden={selected || Boolean(settingsContent)}>
      <ShellPresentationContext.Provider value={(selected || settingsContent) && shell ? { ...shell, sidebarActionHost: null } : shell}>
        {children}
      </ShellPresentationContext.Provider>
    </div> : null}
  </div>;
}
