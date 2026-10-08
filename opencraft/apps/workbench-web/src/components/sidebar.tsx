// Semantically restored from the r1442 AppShell left-panel ownership model.
import { useIntl } from "@opencraft/i18n/react";
import {
  ChevronDown,
  Settings,
  SquarePen,
} from "lucide-react";
import type { ServerRouteLocality, ThreadServerOrigin, WorkbenchThread } from "@opencraft/workbench-runtime";
import type {
  SidebarEntity,
  SidebarEntityCreationCommand,
  SidebarLayoutStore,
} from "@opencraft/sidebar-layout";
import type { ReactNode } from "react";
import { SidebarBots, SidebarEntityDndCoordinator } from "./sidebar-bots";
import { ThreadRowMenu, type ThreadActionCallbacks, type ThreadActionCapabilities } from "./thread-management";
import { updateOpenSidebarThreadMenu, type OpenSidebarThreadMenu, type SidebarThreadMenuKind } from "./sidebar-thread-menu-state";
import { groupThreadsByActivityDate, sidebarActivityMetadata } from "../sidebar-activity";
import { NavigationIcon as SidebarContributionIcon, type NavigationAction as SidebarActionItem } from "./shell-navigation/navigation-action";
import { SidebarActivityItem } from "./sidebar-activity-item";
import { SidebarNavigationItem } from "./sidebar-navigation-item";
import type { HostThreadCatalogState } from "../runtime/thread-catalog-query";
export type { NavigationAction as SidebarActionItem } from "./shell-navigation/navigation-action";

interface SidebarThread extends WorkbenchThread {
  readonly connectionHostId: string;
  readonly connectionHostLabel: string;
  readonly serverOrigin: ThreadServerOrigin;
  readonly serverRouteLocality: ServerRouteLocality;
}

export interface SidebarCatalogItem {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly initiallyCollapsed?: boolean;
  readonly content: ReactNode;
}
import { useLayoutEffect, useRef, useState } from "react";

interface SidebarProps {
  threads: readonly SidebarThread[];
  activeHostId: string;
  activeThreadId: string;
  pendingHostId?: string | null;
  pendingThreadId?: string | null;
  primaryActions?: readonly SidebarActionItem[];
  footerActions?: readonly SidebarActionItem[];
  managementNavigation?: ReactNode;
  catalogs?: readonly SidebarCatalogItem[];
  bots?: readonly SidebarEntity[];
  sidebarLayout: SidebarLayoutStore;
  botCreation?: SidebarEntityCreationCommand | null;
  onSelectThread(hostId: string, id: string): void;
  onNewTask(): void;
  onOpenSettings(): void;
  showFooter?: boolean;
  threadActions?: ThreadActionCallbacks;
  threadCapabilities?(hostId: string): ThreadActionCapabilities;
  pendingTitle?(hostId: string, threadId: string): string | null;
  threadCatalogs?: readonly HostThreadCatalogState[];
  onRetryThreadCatalog?(hostId: string): void;
  threadCatalogDiscovery?: "loading" | "error" | null;
  onRetryThreadCatalogDiscovery?(): void;
}


function ExtensionCatalog({ catalog }: { readonly catalog: SidebarCatalogItem }) {
  const [collapsed, setCollapsed] = useState(catalog.initiallyCollapsed ?? false);
  return (
    <section className="sidebar-extension-catalog" aria-label={catalog.title}>
      <button
        className="sidebar-section-heading sidebar-extension-catalog__heading"
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <ChevronDown size={12} className={collapsed ? "is-collapsed" : undefined} />
        <SidebarContributionIcon name={catalog.icon} size={13} />
        <span>{catalog.title}</span>
      </button>
      {collapsed ? null : (
        <div className="sidebar-extension-catalog__content">{catalog.content}</div>
      )}
    </section>
  );
}

export function Sidebar({
  threads,
  activeHostId,
  activeThreadId,
  pendingHostId = null,
  pendingThreadId = null,
  primaryActions = [],
  footerActions = [],
  managementNavigation = null,
  catalogs = [],
  bots = [],
  sidebarLayout,
  botCreation = null,
  onSelectThread,
  onNewTask,
  onOpenSettings,
  showFooter = true,
  threadActions,
  threadCapabilities,
  pendingTitle,
  threadCatalogs = [],
  onRetryThreadCatalog,
  threadCatalogDiscovery = null,
  onRetryThreadCatalogDiscovery,
}: SidebarProps) {
  const intl = useIntl();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [openThreadMenu, setOpenThreadMenu] = useState<OpenSidebarThreadMenu | null>(null);
  const selectedThreadKey =
    pendingThreadId === null
      ? `${activeHostId}:${activeThreadId}`
      : `${pendingHostId ?? activeHostId}:${pendingThreadId}`;
  const pinnedThreads = threads.filter(thread => thread.pinned === true);
  const orderedThreads = threads.filter(thread => thread.pinned !== true).sort((left, right) => right.updatedAt - left.updatedAt);
  const visibleThreads = activityExpanded
    ? orderedThreads
    : orderedThreads.filter((thread, index) =>
      index < 10 || `${thread.connectionHostId}:${thread.id}` === selectedThreadKey);
  const activityGroups = [
    ...(pinnedThreads.length === 0 ? [] : [{ key: "pinned", label: "置顶", threads: pinnedThreads }]),
    ...groupThreadsByActivityDate(visibleThreads),
  ];
  const catalogLoading = threadCatalogDiscovery === "loading"
    || threadCatalogs.some(catalog => catalog.phase === "loading");
  const feedback = [
    ...(threadCatalogDiscovery === "error" ? [{ key: "discovery", label: null, retry: onRetryThreadCatalogDiscovery }] : []),
    ...threadCatalogs.filter(catalog => catalog.phase === "error").map(catalog => ({
      key: `host:${catalog.hostId}`, label: catalog.label,
      retry: onRetryThreadCatalog ? () => onRetryThreadCatalog(catalog.hostId) : undefined,
    })),
  ];
  const visibleKeys = new Set([...pinnedThreads, ...visibleThreads].map(thread => `${thread.connectionHostId}:${thread.id}`));
  const hiddenRemoteCount = orderedThreads.filter(thread => thread.serverRouteLocality === "remote"
    && !visibleKeys.has(`${thread.connectionHostId}:${thread.id}`)).length;

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const activeThread = container?.querySelector<HTMLElement>(
      ".sidebar-activity-item.is-selected",
    );
    if (container == null || activeThread == null) return;
    const containerRect = container.getBoundingClientRect();
    const activeRect = activeThread.getBoundingClientRect();
    if (
      activeRect.top < containerRect.top ||
      activeRect.bottom > containerRect.bottom
    ) {
      activeThread.scrollIntoView({ block: "nearest" });
    }
  }, [selectedThreadKey, threads.length]);

  return (
    <SidebarEntityDndCoordinator items={bots} layout={sidebarLayout}>
      <div className="sidebar-panel" data-app-shell-focus-area="left-panel">
      <nav className="sidebar-navigation" aria-label="Primary">
        <SidebarNavigationItem icon={<SquarePen size={15} />} title={intl.formatMessage({ id: "sidebar.start", defaultMessage: "Start" })} onInvoke={onNewTask} />
        {primaryActions.map((action) => (
          <SidebarNavigationItem
            key={action.id}
            active={action.active}
            icon={<SidebarContributionIcon name={action.icon} />}
            title={action.title}
            onInvoke={action.onInvoke}
          />
        ))}
      </nav>

      {managementNavigation}

      <div className="sidebar-content-scroll" ref={scrollContainerRef}>
        <SidebarBots
          items={bots}
          creation={botCreation}
        />

        {catalogs.map((catalog) => (
          <ExtensionCatalog key={catalog.id} catalog={catalog} />
        ))}

        <section className="sidebar-tasks" aria-label="Tasks" aria-busy={catalogLoading}>
          {feedback.map(catalog => (
            <div className="sidebar-catalog-feedback" key={catalog.key} role="status">
                <span className="sidebar-catalog-feedback__message" title={catalog.label ?? undefined}>{catalog.label === null
                  ? intl.formatMessage({ id: "sidebar.catalog.discoveryError", defaultMessage: "Couldn't load remote connections" })
                  : intl.formatMessage({ id: "sidebar.catalog.error", defaultMessage: "Couldn't load {server} conversations" }, { server: catalog.label })}</span>
                <button type="button" className="sidebar-catalog-feedback__retry" onClick={catalog.retry} disabled={!catalog.retry}>
                  {intl.formatMessage({ id: "sidebar.catalog.retry", defaultMessage: "Retry" })}
                </button>
            </div>
          ))}
          {activityGroups.length === 0 && feedback.length === 0 && !catalogLoading ? <div className="sidebar-activity-empty">{intl.formatMessage({ id: "sidebar.empty", defaultMessage: "No tasks yet" })}</div> : null}
          <div className="sidebar-activity-list">
            {activityGroups.map(group => (
              <section className="sidebar-activity-group" key={group.key} aria-label={group.label}>
                <h2 className="sidebar-activity-group__heading">{group.label}</h2>
                <div className="sidebar-activity-group__items">
                  {group.threads.map((thread) => {
                    const threadKey = `${thread.connectionHostId}:${thread.id}`;
                    const active =
                      thread.connectionHostId === activeHostId && thread.id === activeThreadId;
                    const pending =
                      thread.connectionHostId === pendingHostId && thread.id === pendingThreadId;
                    const selected = threadKey === selectedThreadKey;
                    const title = pendingTitle?.(thread.connectionHostId, thread.id) ?? thread.title;
                    const metadata = sidebarActivityMetadata(thread);
                    const button = <SidebarActivityItem
                      key={threadKey}
                      active={active}
                      serverOrigin={thread.serverOrigin}
                      serverRouteLocality={thread.serverRouteLocality}
                      onInvoke={() => { setOpenThreadMenu(null); onSelectThread(thread.connectionHostId, thread.id); }}
                      pending={pending}
                      project={metadata.project}
                      selected={selected}
                      status={thread.status}
                      title={title}
                      tooltip={`${title} · ${metadata.project} · ${thread.serverOrigin.label} · ${thread.id}`}
                      unread={thread.unread === true}
                    />;
                    if (threadActions && threadCapabilities) return (
                      <ThreadRowMenu
                        key={threadKey}
                        target={{ hostId: thread.connectionHostId, threadId: thread.id, title, pinned: thread.pinned }}
                        capabilities={threadCapabilities(thread.connectionHostId)}
                        openMenuKind={openThreadMenu?.hostId === thread.connectionHostId && openThreadMenu.threadId === thread.id
                          ? openThreadMenu.kind
                          : null}
                        onOpenMenuChange={(kind: SidebarThreadMenuKind, open) => setOpenThreadMenu(current => updateOpenSidebarThreadMenu(
                          current,
                          { hostId: thread.connectionHostId, threadId: thread.id, kind },
                          open,
                        ))}
                        {...threadActions}
                      >
                        {button}
                      </ThreadRowMenu>
                    );
                    return button;
                  })}
                </div>
              </section>
            ))}
            {orderedThreads.length > 10 ? (
              <button
                type="button"
                className="sidebar-activity-more"
                aria-expanded={activityExpanded}
                onClick={() => setActivityExpanded(value => !value)}
              >
                {activityExpanded
                  ? intl.formatMessage({ id: "sidebar.catalog.less", defaultMessage: "Show less" })
                  : hiddenRemoteCount > 0
                    ? intl.formatMessage({ id: "sidebar.catalog.moreRemote", defaultMessage: "Show more ({count} remote)" }, { count: hiddenRemoteCount })
                    : intl.formatMessage({ id: "sidebar.catalog.more", defaultMessage: "Show more" })}
              </button>
            ) : null}
          </div>
        </section>
      </div>

      {showFooter ? <div className="sidebar-panel__footer">
        {footerActions.map((action) => (
          <SidebarNavigationItem
            key={action.id}
            active={action.active}
            icon={<SidebarContributionIcon name={action.icon} />}
            title={action.title}
            onInvoke={action.onInvoke}
          />
        ))}
          <SidebarNavigationItem icon={<Settings size={15} />} title={intl.formatMessage({ id: "settings.title", defaultMessage: "Settings" })} onInvoke={onOpenSettings} />
      </div> : null}
      </div>
    </SidebarEntityDndCoordinator>
  );
}
