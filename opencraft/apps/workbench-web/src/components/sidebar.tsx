// Semantically restored from the r1442 AppShell left-panel ownership model.
import { useIntl } from "@opencraft/i18n/react";
import {
  ChevronDown,
  Settings,
  SquarePen,
} from "lucide-react";
import type { WorkbenchThread } from "@opencraft/workbench-runtime";
import type {
  SidebarEntity,
  SidebarEntityCreationCommand,
  SidebarLayoutStore,
} from "@opencraft/sidebar-layout";
import type { ReactNode } from "react";
import { SidebarBots, SidebarEntityDndCoordinator } from "./sidebar-bots";
import { ThreadRowMenu, type ThreadActionCallbacks, type ThreadActionCapabilities } from "./thread-management";
import { groupThreadsByActivityDate, sidebarActivityMetadata } from "../sidebar-activity";
import { NavigationIcon as SidebarContributionIcon, type NavigationAction as SidebarActionItem } from "./shell-navigation/navigation-action";
import { SidebarActivityItem } from "./sidebar-activity-item";
import { SidebarNavigationItem } from "./sidebar-navigation-item";
export type { NavigationAction as SidebarActionItem } from "./shell-navigation/navigation-action";

interface SidebarThread extends WorkbenchThread {
  readonly hostId: string;
  readonly hostLabel: string;
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
  onNewTaskForTarget?(hostId: string): Promise<unknown>;
  onOpenTargetSettings?(hostId: string): void;
  onOpenSettings(): void;
  showFooter?: boolean;
  threadActions?: ThreadActionCallbacks;
  threadCapabilities?(hostId: string): ThreadActionCapabilities;
  pendingTitle?(hostId: string, threadId: string): string | null;
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
  onNewTaskForTarget,
  onOpenTargetSettings,
  onOpenSettings,
  showFooter = true,
  threadActions,
  threadCapabilities,
  pendingTitle,
}: SidebarProps) {
  const intl = useIntl();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const selectedThreadKey =
    pendingThreadId === null
      ? `${activeHostId}:${activeThreadId}`
      : `${pendingHostId ?? activeHostId}:${pendingThreadId}`;
  const orderedThreads = [...threads].sort((left, right) => right.updatedAt - left.updatedAt);
  const visibleThreads = activityExpanded
    ? orderedThreads
    : orderedThreads.filter((thread, index) =>
      index < 10 || `${thread.hostId}:${thread.id}` === selectedThreadKey);
  const activityGroups = groupThreadsByActivityDate(visibleThreads);

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

        <section className="sidebar-tasks" aria-label="Tasks">
          {activityGroups.length === 0 ? <div className="sidebar-activity-empty">{intl.formatMessage({ id: "sidebar.empty", defaultMessage: "No tasks yet" })}</div> : null}
          <div className="sidebar-activity-list">
            {activityGroups.map(group => (
              <section className="sidebar-activity-group" key={group.key} aria-label={group.label}>
                <h2 className="sidebar-activity-group__heading">{group.label}</h2>
                <div className="sidebar-activity-group__items">
                  {group.threads.map((thread) => {
                    const threadKey = `${thread.hostId}:${thread.id}`;
                    const active =
                      thread.hostId === activeHostId && thread.id === activeThreadId;
                    const pending =
                      thread.hostId === pendingHostId && thread.id === pendingThreadId;
                    const selected = threadKey === selectedThreadKey;
                    const title = pendingTitle?.(thread.hostId, thread.id) ?? thread.title;
                    const metadata = sidebarActivityMetadata(thread);
                    const button = <SidebarActivityItem
                      key={threadKey}
                      active={active}
                      host={metadata.host}
                      onInvoke={() => onSelectThread(thread.hostId, thread.id)}
                      pending={pending}
                      project={metadata.project}
                      selected={selected}
                      status={thread.status}
                      title={title}
                      tooltip={`${title} · ${metadata.project}${metadata.host === null ? "" : ` · ${metadata.host}`} · ${thread.id}`}
                      unread={thread.unread === true}
                    />;
                    if (threadActions && threadCapabilities) return (
                      <ThreadRowMenu
                        key={threadKey}
                        target={{ hostId: thread.hostId, threadId: thread.id, title }}
                        capabilities={threadCapabilities(thread.hostId)}
                        hostActions={{
                          label: thread.hostLabel,
                          onNewTask: onNewTaskForTarget,
                          onOpenSettings: onOpenTargetSettings,
                        }}
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
            {threads.length > 10 ? (
              <button
                type="button"
                className="sidebar-activity-more"
                onClick={() => setActivityExpanded(value => !value)}
              >
                {activityExpanded ? "Show less" : "Show more"}
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
