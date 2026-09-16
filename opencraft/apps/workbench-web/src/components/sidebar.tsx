// Semantically restored from the r1442 AppShell left-panel ownership model.
import {
  ChevronDown,
  Monitor,
  Plus,
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
import { groupThreadsByTarget } from "../sidebar-target-groups";
import { NavigationIcon as SidebarContributionIcon, type NavigationAction as SidebarActionItem } from "./shell-navigation/navigation-action";
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
  catalogs?: readonly SidebarCatalogItem[];
  bots?: readonly SidebarEntity[];
  sidebarLayout: SidebarLayoutStore;
  botCreation?: SidebarEntityCreationCommand | null;
  onSelectThread(hostId: string, id: string): void;
  onNewTask(): void;
  onNewTaskForTarget?(hostId: string): Promise<unknown>;
  onOpenTargetSettings?(hostId: string): void;
  renderTargetStatus?(hostId: string): ReactNode;
  onOpenSettings(): void;
  showFooter?: boolean;
  threadActions?: ThreadActionCallbacks;
  threadCapabilities?(hostId: string): ThreadActionCapabilities;
  pendingTitle?(hostId: string, threadId: string): string | null;
  onManageArchived?(): void;
  archiveUndo?: { title: string; restore(): void } | null;
}


function SidebarActionIcon({ children }: { readonly children: ReactNode }) {
  return <span className="sidebar-action__icon" aria-hidden="true">{children}</span>;
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

function ThreadActivity({ status }: { status: WorkbenchThread["status"] }) {
  if (status === "running")
    return (
      <span
        className="sidebar-thread__activity is-running"
        aria-label="Running"
      />
    );
  if (status === "review")
    return (
      <span
        className="sidebar-thread__activity is-review"
        aria-label="Ready for review"
      />
    );
  return <span className="sidebar-thread__activity" aria-hidden="true" />;
}

export function Sidebar({
  threads,
  activeHostId,
  activeThreadId,
  pendingHostId = null,
  pendingThreadId = null,
  primaryActions = [],
  footerActions = [],
  catalogs = [],
  bots = [],
  sidebarLayout,
  botCreation = null,
  onSelectThread,
  onNewTask,
  onNewTaskForTarget,
  onOpenTargetSettings,
  renderTargetStatus,
  onOpenSettings,
  showFooter = true,
  threadActions,
  threadCapabilities,
  pendingTitle,
  onManageArchived,
  archiveUndo,
}: SidebarProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [collapsedTargets, setCollapsedTargets] = useState<ReadonlySet<string>>(new Set());
  const [expandedTargets, setExpandedTargets] = useState<ReadonlySet<string>>(new Set());
  const groups = groupThreadsByTarget(threads);
  const [creatingTarget, setCreatingTarget] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const [creationError, setCreationError] = useState<{ hostId: string; message: string } | null>(null);
  const selectedThreadKey =
    pendingThreadId === null
      ? `${activeHostId}:${activeThreadId}`
      : `${pendingHostId ?? activeHostId}:${pendingThreadId}`;

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const activeThread = container?.querySelector<HTMLElement>(
      ".sidebar-thread.is-selected",
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
        <button className="sidebar-action" type="button" onClick={onNewTask}>
          <SidebarActionIcon><SquarePen size={15} /></SidebarActionIcon>
          <span>New chat</span>
        </button>
        {primaryActions.map((action) => (
          <button
            className="sidebar-action"
            type="button"
            key={action.id}
            aria-current={action.active ? "page" : undefined}
            onClick={action.onInvoke}
          >
            <SidebarActionIcon><SidebarContributionIcon name={action.icon} /></SidebarActionIcon>
            <span>{action.title}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-content-scroll" ref={scrollContainerRef}>
        <SidebarBots
          items={bots}
          creation={botCreation}
        />

        {catalogs.map((catalog) => (
          <ExtensionCatalog key={catalog.id} catalog={catalog} />
        ))}

        <section className="sidebar-tasks" aria-label="Tasks">
          {groups.length === 0 ? <div className="sidebar-target-empty">No tasks yet</div> : null}
          {groups.map(group => {
            const collapsed = collapsedTargets.has(group.id);
            const expanded = expandedTargets.has(group.id);
            const selectedId = pendingThreadId ?? activeThreadId;
            const selectedHost = pendingThreadId === null ? activeHostId : pendingHostId ?? activeHostId;
            const visible = expanded ? group.threads : group.threads.filter((thread, index) =>
              index < 6 || (thread.hostId === selectedHost && thread.id === selectedId));
            return <section className="sidebar-target-group" key={group.id} aria-label={group.label}>
              <div className="sidebar-target-heading-row">
              <button type="button" className="sidebar-target-heading" aria-expanded={!collapsed}
                title={group.id} onClick={() => setCollapsedTargets(previous => {
                  const next = new Set(previous);
                  if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                  return next;
                })}>
                <ChevronDown size={12} className={collapsed ? "is-collapsed" : undefined} />
                <Monitor size={15} />
                <span>{group.label}</span>
                {renderTargetStatus?.(group.id)}
              </button>
              {onOpenTargetSettings ? <button type="button" className="sidebar-target-action"
                aria-label={`Settings for ${group.label}`} title={`Settings for ${group.label}`}
                onClick={() => onOpenTargetSettings(group.id)}><Settings size={14} /></button> : null}
              {onNewTaskForTarget ? <button type="button" className="sidebar-target-new"
                aria-label={`New task on ${group.label}`} title={`New task on ${group.label}`}
                disabled={creatingTarget !== null} aria-busy={creatingTarget === group.id}
                onClick={() => {
                  if (creatingRef.current) return;
                  creatingRef.current = true;
                  setCreatingTarget(group.id);
                  setCreationError(null);
                  void Promise.resolve().then(() => onNewTaskForTarget(group.id)).catch(error => {
                    setCreationError({ hostId: group.id, message: error instanceof Error ? error.message : String(error) });
                  }).finally(() => { creatingRef.current = false; setCreatingTarget(null); });
                }}><Plus size={14} /></button> : null}
              </div>
              {creationError?.hostId === group.id ? <div role="alert" className="sidebar-target-empty">{creationError.message}</div> : null}
          {!collapsed ? <div className="sidebar-thread-list">
            {visible.map((thread) => {
            const threadKey = `${thread.hostId}:${thread.id}`;
            const active =
              thread.hostId === activeHostId && thread.id === activeThreadId;
            const pending =
              thread.hostId === pendingHostId && thread.id === pendingThreadId;
            const selected = threadKey === selectedThreadKey;
            const title = pendingTitle?.(thread.hostId, thread.id) ?? thread.title;
            const button = (
              <button
                type="button"
                className={["sidebar-thread", selected ? "is-selected" : "", active ? "is-active" : "", pending ? "is-pending" : ""].filter(Boolean).join(" ")}
                onClick={() => onSelectThread(thread.hostId, thread.id)} aria-current={selected ? "page" : undefined} aria-busy={pending || undefined}
                title={`${title} · ${thread.hostLabel} · ${thread.id}`}>
                <ThreadActivity status={thread.status} />
                <span className="sidebar-thread__copy"><span className="sidebar-thread__label">{title}</span></span>
                {thread.unread ? <span className="sidebar-thread__unread" /> : null}
              </button>
            );
            if (threadActions && threadCapabilities) return <ThreadRowMenu key={threadKey} target={{ hostId: thread.hostId, threadId: thread.id, title }}
              capabilities={threadCapabilities(thread.hostId)} {...threadActions}>{button}</ThreadRowMenu>;
            return (
              <button
                type="button"
                key={threadKey}
                className={[
                  "sidebar-thread",
                  selected ? "is-selected" : "",
                  active ? "is-active" : "",
                  pending ? "is-pending" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => onSelectThread(thread.hostId, thread.id)}
                aria-current={selected ? "page" : undefined}
                aria-busy={pending || undefined}
                title={`${thread.title} · ${thread.hostLabel} · ${thread.id}`}
              >
                <ThreadActivity status={thread.status} />
                <span className="sidebar-thread__copy">
                  <span className="sidebar-thread__label">{thread.title}</span>
                </span>
                {thread.unread ? (
                  <span className="sidebar-thread__unread" />
                ) : null}
              </button>
            );
            })}
            {group.threads.length > 6 ? <button type="button" className="sidebar-target-more"
              onClick={() => setExpandedTargets(previous => {
                const next = new Set(previous);
                if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                return next;
              })}>{expanded ? "Show less" : "Show more"}</button> : null}
          </div> : null}
          </section>;
          })}
        </section>
        {onManageArchived ? <button type="button" className="sidebar-action" onClick={onManageArchived}>已归档会话</button> : null}
        {archiveUndo ? <div className="sidebar-target-empty" role="status">已归档 {archiveUndo.title} <button type="button" onClick={archiveUndo.restore}>撤销</button></div> : null}
      </div>

      {showFooter ? <div className="sidebar-panel__footer">
        {footerActions.map((action) => (
          <button
            className="sidebar-action"
            type="button"
            key={action.id}
            aria-current={action.active ? "page" : undefined}
            onClick={action.onInvoke}
          >
            <SidebarActionIcon><SidebarContributionIcon name={action.icon} /></SidebarActionIcon>
            <span>{action.title}</span>
          </button>
        ))}
          <button className="sidebar-action" type="button" onClick={onOpenSettings}>
            <SidebarActionIcon><Settings size={15} /></SidebarActionIcon>
            <span>Settings</span>
          </button>
      </div> : null}
      </div>
    </SidebarEntityDndCoordinator>
  );
}
