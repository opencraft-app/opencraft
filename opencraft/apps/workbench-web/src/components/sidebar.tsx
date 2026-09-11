// Semantically restored from the r1442 AppShell left-panel ownership model.
import {
  Blocks,
  Bot,
  ChevronDown,
  Cloud,
  Database,
  Folder,
  HardDrive,
  Monitor,
  Plus,
  Server,
  Settings,
  SquarePen,
  Gauge,
  LogOut,
  User,
} from "lucide-react";
import type { PlatformAccountSnapshot } from "@opencraft/extension-react";
import type { WorkbenchThread } from "@opencraft/workbench-runtime";
import type {
  SidebarEntity,
  SidebarEntityCreationCommand,
  SidebarLayoutStore,
} from "@opencraft/sidebar-layout";
import type { ReactNode } from "react";
import { SidebarBots, SidebarEntityDndCoordinator } from "./sidebar-bots";
import { groupThreadsByTarget } from "../sidebar-target-groups";

interface SidebarThread extends WorkbenchThread {
  readonly hostId: string;
  readonly hostLabel: string;
}

export interface SidebarActionItem {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly active?: boolean;
  readonly onInvoke: () => void;
}

export interface SidebarCatalogItem {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly initiallyCollapsed?: boolean;
  readonly content: ReactNode;
}
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface SidebarAccountItem {
  readonly snapshot: PlatformAccountSnapshot;
  readonly onOpen: () => void;
  readonly onRefresh: () => Promise<unknown>;
  readonly onSignOut: () => Promise<void>;
}

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
  account?: SidebarAccountItem | null;
}

function SidebarAccount({ account, onOpenSettings }: {
  readonly account: SidebarAccountItem;
  readonly onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const { snapshot } = account;
  const name = snapshot.name || "LightVela";
  const initial = (name.trim()[0] || "L").toLocaleUpperCase();

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    void account.onRefresh().catch(() => undefined);
    return () => document.removeEventListener("pointerdown", close);
  }, [account.onRefresh, open]);

  return (
    <div className="sidebar-account" ref={root}>
      {open ? (
        <div className="sidebar-account-menu" role="menu" aria-label="Account menu">
          <button className="sidebar-account-menu__identity" type="button" role="menuitem" onClick={() => { setOpen(false); account.onOpen(); }}>
            <span className="sidebar-account__avatar">
              {snapshot.avatarUrl ? <img src={snapshot.avatarUrl} alt="" /> : initial}
            </span>
            <span className="sidebar-account-menu__copy">
              <strong>{name}</strong>
              <small>{snapshot.planLabel || (snapshot.phase === "loading" ? "Loading account…" : "Account Settings")}</small>
            </span>
          </button>
          <div className="sidebar-account-menu__separator" />
          {snapshot.usageRemainingPercent === null ? null : (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); account.onOpen(); }}>
              <Gauge size={16} /><span>Usage</span><small>{snapshot.usageRemainingPercent}% left</small>
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => { setOpen(false); account.onOpen(); }}>
            <User size={16} /><span>Account</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenSettings(); }}>
            <Settings size={16} /><span>Settings</span>
          </button>
          <div className="sidebar-account-menu__separator" />
          <button
            type="button"
            role="menuitem"
            disabled={signingOut}
            onClick={() => {
              if (signingOut) return;
              setSigningOut(true);
              void account.onSignOut()
                .catch(() => undefined)
                .finally(() => { setSigningOut(false); setOpen(false); });
            }}
          >
            <LogOut size={16} /><span>{signingOut ? "Signing out…" : "Sign out"}</span>
          </button>
        </div>
      ) : null}
      <button
        className="sidebar-account__trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="sidebar-account__avatar">
          {snapshot.avatarUrl ? <img src={snapshot.avatarUrl} alt="" /> : initial}
        </span>
        <span className="sidebar-account__name">{name}</span>
        <ChevronDown size={14} className={open ? "is-open" : undefined} />
      </button>
    </div>
  );
}

function SidebarContributionIcon({ name, size = 15 }: { name?: string; size?: number }) {
  switch (name) {
    case "cloud": return <Cloud size={size} />;
    case "database": return <Database size={size} />;
    case "folder": return <Folder size={size} />;
    case "hard-drive": return <HardDrive size={size} />;
    case "server": return <Server size={size} />;
    case "bot": return <Bot size={size} />;
    default: return <Blocks size={size} />;
  }
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
  account = null,
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
      </div>

      <div className="sidebar-panel__footer">
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
        {account === null ? (
          <button className="sidebar-action" type="button" onClick={onOpenSettings}>
            <SidebarActionIcon><Settings size={15} /></SidebarActionIcon>
            <span>Settings</span>
          </button>
        ) : <SidebarAccount account={account} onOpenSettings={onOpenSettings} />}
      </div>
      </div>
    </SidebarEntityDndCoordinator>
  );
}
