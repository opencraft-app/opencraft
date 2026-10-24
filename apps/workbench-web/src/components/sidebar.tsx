import { ChevronDownIcon as ChevronDown, LoadingRingIcon as LoaderCircle, ComposeIcon as SquarePen, SearchIcon as Search, CheckIcon as Check } from "@opencraft/design-system-web/action-icons";
import { SettingsGearIcon } from "@opencraft/design-system-web/action-icons";
import { shortcutLabel, shortcutAria } from "../workbench-shortcuts";
import { createPortal } from "react-dom";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { ThreadListModeItems } from "./thread-list-mode-menu";
import { AvatarImage, type ThreadBadgeContribution, type ThreadListGroupingContribution, type ThreadListGroupingSnapshot, type ThreadListLabel } from "@opencraft/extension-react";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";

import { useIntl } from "@opencraft/i18n/react";
import { FilterIcon as ListFilter, PersonIcon as UserRound } from "@opencraft/design-system-web/action-icons";
import type { ServerRouteLocality, ThreadServerOrigin, WorkbenchThread } from "@opencraft/workbench-runtime";
import type {
  SidebarEntity,
  SidebarEntityCreationCommand,
  SidebarLayoutStore,
} from "@opencraft/sidebar-layout";
import type { ReactNode } from "react";
import { SidebarBots, SidebarEntityDndCoordinator } from "./sidebar-bots";
import { ThreadActionModals, threadActionKey, useThreadActionOwner, type ThreadActionCallbacks, type ThreadActionCapabilities } from "./thread-management";
import { SidebarThreadMenuStore, type OpenSidebarThreadMenu, type SidebarThreadMenuKind } from "./sidebar-thread-menu-state";
import { SidebarThreadRowMenu, SidebarThreadBadge, SidebarFiltersMenu, SidebarListContextMenu } from "./sidebar-thread-menu";
import { sidebarActivityDateHeadings, groupThreadsByTaskFlow, sidebarActivityMetadata } from "../sidebar-activity";
import { NavigationIcon as SidebarContributionIcon, type NavigationAction as SidebarActionItem } from "./shell-navigation/navigation-action";
import { useSidebarEndPull } from "./use-sidebar-end-pull";
import { useSidebarHeadingOcclusion } from "./use-sidebar-heading-occlusion";
import { SidebarBrowserResources } from "./sidebar-browser-resources";
import { SidebarActivityItem } from "./sidebar-activity-item";
import { SidebarNavigationItem } from "./sidebar-navigation-item";
import { useShellPresentation, useDismissSidebarAfterSelection } from "./shell-presentation";
import type { HostThreadCatalogState } from "../runtime/thread-catalog-query";
import { useUiPreferencesRuntime } from "../runtime/ui-preferences-runtime";
export type { NavigationAction as SidebarActionItem } from "./shell-navigation/navigation-action";

export interface SidebarThread extends WorkbenchThread {
  readonly schedule?: import("@opencraft/appserver-protocol").ConversationScheduleSummary;
  readonly goalActive?: boolean;
  readonly interactionAvailable?: boolean;
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
import { memo, useCallback, useEffect, useId, useMemo, useSyncExternalStore, useLayoutEffect, useRef, useState, useTransition } from "react";

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
  showStart?: boolean;
  searchInDialog?: boolean;
  showNewChat?: boolean;
  threadActions?: ThreadActionCallbacks;
  threadBadge?: ThreadBadgeContribution | null;
  threadListGrouping?: ThreadListGroupingContribution | null;
  threadCapabilities?(hostId: string, threadId?: string): ThreadActionCapabilities;
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

const defaultGrouping: ThreadListGroupingSnapshot = { revision: 0, mode: null, modes: [], hideRowBadge: false, notice: null };
const noThreadActions: ThreadActionCallbacks = { onRename: async () => {}, onFork: async () => {}, onArchive: async () => {}, onDelete: async () => {} };
const noSubscribe = () => () => {};
const getDefaultGrouping = () => defaultGrouping;

const PINNED_PAGE_SIZE = 6;
const RECENT_PAGE_SIZE = 10;

function SidebarPagination({ total, visibleCount, pageSize, onChange, pullToLoad = false }: {
  total: number; visibleCount: number; pageSize: number; onChange: (count: number) => void; pullToLoad?: boolean;
}) {
  const intl = useIntl();
  const [pending, startTransition] = useTransition();
  const footerRef = useRef<HTMLDivElement>(null);
  // All inputs reveal one page of the existing catalog. The transition owns
  // pending presentation; it does not introduce a second data/request owner.
  const reveal = () => {
    if (!pending && visibleCount < total) startTransition(() => onChange(visibleCount + pageSize));
  };
  useSidebarEndPull(footerRef, pullToLoad && !pending && visibleCount < total, reveal);
  const moreLabel = intl.formatMessage({ id: "sidebar.catalog.showMore", defaultMessage: "Show more" });
  return <div className="sidebar-activity-pagination" ref={footerRef} aria-busy={pending} hidden={total <= pageSize}>
    {visibleCount < total ? <button type="button" className="sidebar-activity-more" onClick={reveal} disabled={pending} aria-label={moreLabel}>
      {pending ? <LoaderCircle size={14} className="is-spinning" aria-hidden="true" /> : <span>{moreLabel}</span>}
    </button> : pullToLoad ? <span className="sidebar-activity-empty" role="status">
      {intl.formatMessage({ id: "sidebar.catalog.end", defaultMessage: "No more conversations" })}
    </span> : null}
    {visibleCount > pageSize ? <button type="button" className="sidebar-activity-more" disabled={pending} onClick={() => onChange(pageSize)}>
      {intl.formatMessage({ id: "sidebar.catalog.less", defaultMessage: "Show less" })}
    </button> : null}
  </div>;
}

const SidebarThreadContent = memo(function SidebarThreadContent({ thread, attention, render }: {
  thread: SidebarThread;
  attention: boolean;
  render: (thread: SidebarThread, attention: boolean) => ReactNode;
}) {
  return render(thread, attention);
});

export const Sidebar = memo(function Sidebar(props: SidebarProps) {
  const {
    threads, activeHostId, activeThreadId, sidebarLayout, onSelectThread, onNewTask, onOpenSettings,
    pendingHostId = null, pendingThreadId = null, primaryActions = [], footerActions = [],
    managementNavigation = null, catalogs = [], bots = [], botCreation = null,
    showFooter = true, showStart = true, showNewChat = false, searchInDialog = false,
    threadActions, threadBadge = null, threadListGrouping = null, threadCapabilities, pendingTitle,
    threadCatalogs = [], threadCatalogDiscovery = null, onRetryThreadCatalog, onRetryThreadCatalogDiscovery,
  } = props;
  const intl = useIntl();
  const presentationRoot = useWorkbenchPresentationRoot();
  const dismiss = useDismissSidebarAfterSelection();
  const preferences = useUiPreferencesRuntime();
  const preferenceState = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
  const serverFilter = preferenceState.values["sidebar.serverFilter"];
  const grouping = useSyncExternalStore(
    threadListGrouping ? (listener) => threadListGrouping.subscribe(listener) : noSubscribe,
    threadListGrouping ? () => threadListGrouping.getSnapshot() : getDefaultGrouping,
    threadListGrouping ? () => threadListGrouping.getSnapshot() : getDefaultGrouping,
  );
  const [query, setQuery] = useState("");
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [pinnedLimit, setPinnedLimit] = useState(PINNED_PAGE_SIZE);
  const [recentLimit, setRecentLimit] = useState(RECENT_PAGE_SIZE);
  const [menus] = useState(() => new SidebarThreadMenuStore());
  const actionOwner = useThreadActionOwner(threadActions ?? noThreadActions);
  useEffect(() => {
    const target = actionOwner.modal?.target;
    // Regrouping/filtering may hide a row without removing its Thread. Only
    // authoritative membership of the exact Host/Thread ends the modal lease.
    if (target && !threads.some(thread => thread.connectionHostId === target.hostId && thread.id === target.threadId)) {
      actionOwner.dismiss();
    }
  }, [threads, actionOwner]);
  const rowIdPrefix = useId();
  const activityList = useRef<HTMLDivElement>(null);
  useSidebarHeadingOcclusion(activityList);
  const contentViewport = useRef<HTMLDivElement>(null);
  const text = (id: string, defaultMessage: string) => intl.formatMessage({ id, defaultMessage });
  const label = (value: ThreadListLabel) => typeof value === "string" ? value : intl.formatMessage(value);
  const identity = (thread: SidebarThread) => JSON.stringify([thread.connectionHostId, thread.id]);
  const references = useMemo(() => threads.map(thread => ({
    hostId: thread.connectionHostId, threadId: thread.id, updatedAt: thread.updatedAt, pinned: thread.pinned,
  })), [threads]);
  const groupingWatch = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    // A contribution can become ready without changing identity. Acquire its
    // current watch before releasing the previous lease so metadata updates do
    // not briefly drop the last subscriber or cancel an in-flight read.
    const next = threadListGrouping?.watch(references);
    const previous = groupingWatch.current;
    groupingWatch.current = next;
    previous?.();
  }, [threadListGrouping, references, grouping.revision]);
  useEffect(() => () => {
    groupingWatch.current?.();
    groupingWatch.current = undefined;
  }, []);
  useEffect(() => () => menus.close(), [menus]);
  useLayoutEffect(() => { menus.close(); }, [menus, activeHostId, activeThreadId, pendingHostId, pendingThreadId, grouping.mode, grouping.hideRowBadge]);

  const serverOptions = useMemo(() => {
    const names = new Map<string, string>();
    for (const thread of threads) names.set(thread.serverOrigin.serverId, thread.serverOrigin.label);
    if (serverFilter.serverId && !names.has(serverFilter.serverId)) names.set(serverFilter.serverId, serverFilter.label);
    return [...names].sort((a, b) => a[1].localeCompare(b[1]));
  }, [threads, serverFilter]);
  const allowedReferences = threadListGrouping?.filterThreads?.(references) ?? references;
  const allowed = new Set(allowedReferences.map(ref => JSON.stringify([ref.hostId, ref.threadId])));
  const needle = query.trim().toLocaleLowerCase();
  const matching = threads.filter(thread => allowed.has(identity(thread))
    && (!serverFilter.serverId || thread.serverOrigin.serverId === serverFilter.serverId)
    && (!needle || thread.title.toLocaleLowerCase().includes(needle)));
  const matchingById = new Map(matching.map(thread => [identity(thread), thread]));
  const matchingReferences = references.filter(ref => matchingById.has(JSON.stringify([ref.hostId, ref.threadId])));
  const taskFlow = groupThreadsByTaskFlow(matching);
  const applicableCatalogs = threadCatalogs.filter(catalog => !serverFilter.serverId
    || catalog.hostId === serverFilter.serverId
    || threads.some(thread => thread.connectionHostId === catalog.hostId && thread.serverOrigin.serverId === serverFilter.serverId));
  const busyCatalog = threadCatalogDiscovery === "loading" || applicableCatalogs.some(catalog => catalog.phase === "loading");
  const catalogErrors = applicableCatalogs.filter(catalog => catalog.phase === "error"
    || catalog.phase === "ready" && catalog.cachedAt !== undefined);
  const empty = matching.length === 0 && !busyCatalog && catalogErrors.length === 0 && threadCatalogDiscovery !== "error";
  const filtersLabel = text("sidebar.filters", "Filters");
  const allServersLabel = text("sidebar.allServers", "All servers");
  const dismissAfter = (action: () => void) => { menus.close(); action(); dismiss?.(); };
  const writeServerFilter = (serverId: string) => {
    menus.setFiltersOpen(false);
    const name = serverOptions.find(([id]) => id === serverId)?.[1] ?? "";
    void preferences.set("sidebar.serverFilter", { serverId, label: name });
  };
  const modeItems = (kind: "context" | "dropdown") => <ThreadListModeItems contribution={threadListGrouping} snapshot={grouping} kind={kind}
    onSelect={kind === "dropdown" ? () => menus.setFiltersOpen(false) : undefined} />;
  const renderThreadContent = useCallback((thread: SidebarThread, attention: boolean) => {
    const pending = pendingHostId === thread.connectionHostId && pendingThreadId === thread.id;
    const active = activeHostId === thread.connectionHostId && activeThreadId === thread.id;
    const selected = pendingHostId !== null && pendingThreadId !== null ? pending : active;
    const title = pendingTitle?.(thread.connectionHostId, thread.id) ?? thread.title;
    const target = { hostId: thread.connectionHostId, threadId: thread.id, title, pinned: thread.pinned };
    const activityId = `${rowIdPrefix}-${encodeURIComponent(identity(thread))}`;
    const disabled = thread.interactionAvailable === false;
    const capabilities = threadCapabilities?.(thread.connectionHostId, thread.id)
      ?? { rename: !!threadActions, archive: !!threadActions, fork: !!threadActions, delete: !!threadActions, pin: !!threadActions?.onSetPinned };
    const changeOverlay = (kind: OpenSidebarThreadMenu["kind"], open: boolean) => {
      if (open && disabled) return;
      menus.update({ hostId: target.hostId, threadId: target.threadId, kind }, open);
    };
    const badge = threadBadge && !(grouping.mode && grouping.hideRowBadge) ? <SidebarThreadBadge
      store={menus} contribution={threadBadge} hostId={thread.connectionHostId} threadId={thread.id}
      portalContainer={presentationRoot} onOpenChange={open => changeOverlay("badge", open)}
      onCloseAutoFocus={event => { if (menus.getSnapshot() !== null) event.preventDefault(); }}
    /> : null;
    const metadata = sidebarActivityMetadata(thread);
    return <SidebarThreadRowMenu key={identity(thread)} store={menus} target={target} owner={actionOwner}
      capabilities={capabilities} disabled={disabled} activityLabelId={activityId}
      contextMenuExtra={threadListGrouping ? <ThreadListModeItems contribution={threadListGrouping} snapshot={grouping} kind="context" /> : undefined}
      onOpenMenuChange={(kind, open) => changeOverlay(kind, open)}
      onCloseAutoFocus={event => { if (menus.getSnapshot() !== null) event.preventDefault(); }}>
      <SidebarActivityItem activityId={activityId} active={active} selected={selected} pending={pending}
        disabled={disabled} title={title} project={metadata.project}
        tooltip={[title, metadata.project, thread.connectionHostLabel, thread.id].join(" · ")}
        status={thread.status} unread={Boolean(thread.unread) && (threadListGrouping?.isParticipant?.({
          hostId: thread.connectionHostId, threadId: thread.id, updatedAt: thread.updatedAt, pinned: thread.pinned,
        }) ?? true)} goalActive={thread.goalActive}
        schedule={thread.schedule} twoLine={attention} resources={<SidebarBrowserResources store={menus} hostId={thread.connectionHostId} threadId={thread.id} unavailable={disabled}
          onOpenConversation={() => { onSelectThread(thread.connectionHostId, thread.id); dismiss?.(); }} />} badge={badge} badgePlacement={threadBadge?.placement}
        onInvoke={() => { menus.close(); onSelectThread(thread.connectionHostId, thread.id); dismiss?.(); }} />
    </SidebarThreadRowMenu>;
  // Parent props invalidate render-time readers even when their function identity
  // is stable. Only local search/folding/page changes can reuse an unchanged row.
  }, [props, actionOwner, grouping, presentationRoot, dismiss, menus, rowIdPrefix]);
  const renderThread = (thread: SidebarThread, attention = false) => <SidebarThreadContent
    key={identity(thread)} thread={thread} attention={attention} render={renderThreadContent} />;
  const renderFlowSection = (key: string, title: string, rows: readonly SidebarThread[], limit?: number, update?: (count: number) => void) => {
    if (!rows.length) return null;
    const collapsed = folded[key] ?? false;
    const visible = limit === undefined ? rows : rows.slice(0, limit);
    const dates = key === "recent" ? sidebarActivityDateHeadings(visible, Date.now(), intl.locale) : new Map<SidebarThread, string>();
    return <section key={key} className="sidebar-activity-group" aria-label={title} data-collapsed={collapsed}>
      <h3 className="sidebar-thread-group-heading"><button type="button" className="sidebar-thread-group-toggle" aria-expanded={!collapsed} aria-controls={`${rowIdPrefix}-flow-${key}`}
        onClick={() => setFolded(current => ({ ...current, [key]: !collapsed }))}>
        <span className="sidebar-thread-group-label">{title}</span><ChevronDown size={12} className={collapsed ? "is-collapsed" : undefined} />
      </button></h3>
      <div className="sidebar-activity-group__items" id={`${rowIdPrefix}-flow-${key}`} hidden={collapsed}>
        {visible.map(thread => <div key={identity(thread)}>
          {dates.has(thread) ? <h4 className="sidebar-activity-group__heading">{dates.get(thread)}</h4> : null}
          {renderThread(thread, key === "attention")}
        </div>)}
        {limit !== undefined && update ? <SidebarPagination total={rows.length} visibleCount={limit}
          pageSize={key === "pinned" ? PINNED_PAGE_SIZE : RECENT_PAGE_SIZE} onChange={update} pullToLoad={key === "recent"} /> : null}
      </div>
    </section>;
  };
  const groupedSections = grouping.mode && threadListGrouping ? threadListGrouping.project(matchingReferences) : null;
  // Row menus, the badge and the list display menu are one exclusive overlay
  // owner; an owner whose row is no longer visible or no longer accepts
  // interaction must not keep the menu open.
  // A retained menu owner must not outlive its visible, interactive row.
  // Inspect only the open target on parent commits; menu-channel updates still
  // render only the affected row and never rebuild the catalog or grouping.
  useLayoutEffect(() => {
    const current = menus.getSnapshot();
    if (!current || !("hostId" in current)) return;
    const key = JSON.stringify([current.hostId, current.threadId]);
    const target = matchingById.get(key);
    const visible = target && target.interactionAvailable !== false && (groupedSections
      ? groupedSections.some(group => !group.collapsed && group.threads.some(ref =>
          ref.hostId === current.hostId && ref.threadId === current.threadId))
      : Object.entries(taskFlow).some(([id, rows]) => !(folded[id] ?? false)
          && rows.slice(0, id === "pinned" ? pinnedLimit : id === "recent" ? recentLimit : rows.length)
            .some(row => row.connectionHostId === current.hostId && row.id === current.threadId)));
    if (!visible) menus.close();
  });
  const selectedKey = JSON.stringify(pendingHostId !== null && pendingThreadId !== null
    ? [pendingHostId, pendingThreadId] : [activeHostId, activeThreadId]);
  const selectedSection = groupedSections
    ? groupedSections.find(group => group.threads.some(ref => JSON.stringify([ref.hostId, ref.threadId]) === selectedKey))
    : Object.entries(taskFlow).map(([id, rows]) => ({ id, collapsed: folded[id] ?? false,
        threads: rows.slice(0, id === "pinned" ? pinnedLimit : id === "recent" ? recentLimit : rows.length)
          .map(thread => ({ hostId: thread.connectionHostId, threadId: thread.id })) }))
      .find(group => group.threads.some(ref => JSON.stringify([ref.hostId, ref.threadId]) === selectedKey));
  const selectedSectionId = selectedSection?.id;
  const selectedVisible = selectedSection !== undefined && !selectedSection.collapsed;
  const previousSelection = useRef({ key: selectedKey, pinnedLimit, recentLimit });
  useLayoutEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { key: selectedKey, pinnedLimit, recentLimit };
    // Revealing more history is a reading action, not a new navigation intent.
    if (previous.key === selectedKey && (pinnedLimit > previous.pinnedLimit || recentLimit > previous.recentLimit)) return;
    if (!selectedVisible) return;
    const content = contentViewport.current;
    const row = content?.querySelector<HTMLElement>(".sidebar-activity-item.is-selected");
    if (!content || !row) return;
    const column = content.closest(".shell-sidebar__column");
    const mobile = column?.getAttribute("data-navigation-layout") === "mobile";
    const viewport = (mobile ? column?.querySelector<HTMLElement>(".shell-sidebar__scroll")
      : content.querySelector<HTMLElement>(".sidebar-activity-list")) ?? content;
    if (!viewport.isConnected || !viewport.clientHeight || !viewport.clientWidth
      || viewport.closest('[inert], [aria-hidden="true"]')) return;
    const bounds = viewport.getBoundingClientRect();
    const sticky = mobile ? column?.querySelector<HTMLElement>('[data-action-id="shell.home"]') : null;
    const padding = getComputedStyle(viewport);
    const top = Math.max(bounds.top + (parseFloat(padding.scrollPaddingTop) || 0), sticky?.getBoundingClientRect().bottom ?? bounds.top);
    const bottom = bounds.bottom - (parseFloat(padding.scrollPaddingBottom) || 0);
    const item = row.getBoundingClientRect();
    if (item.top < top) viewport.scrollTop += item.top - top;
    else if (item.bottom > bottom) viewport.scrollTop += Math.min(item.bottom - bottom, item.top - top);
  }, [selectedKey, selectedSectionId, selectedVisible, pinnedLimit, recentLimit]);
  const navigationAction = (action: SidebarActionItem) => <SidebarNavigationItem key={action.id} title={action.title}
    active={action.active} icon={<SidebarContributionIcon name={action.icon} />} onInvoke={() => dismissAfter(action.onInvoke)} />;
  const retryLabel = text("sidebar.catalog.retry", "Retry");
  const retryFeedback = (key: string, message: string, retry?: () => void) => <div key={key} className="sidebar-catalog-feedback">
    <span className="sidebar-catalog-feedback__message">{message}</span>
    {retry ? <button type="button" className="sidebar-catalog-feedback__retry" onClick={retry}>{retryLabel}</button> : null}
  </div>;

  return <SidebarEntityDndCoordinator items={bots} layout={sidebarLayout}>
    <div className="sidebar-panel">
      <nav className="sidebar-navigation" aria-label="Primary">
        {showStart ? <SidebarNavigationItem icon={<SquarePen size={18} />} title={text("sidebar.start", "Start")} onInvoke={() => dismissAfter(onNewTask)} /> : null}
        {primaryActions.map(navigationAction)}
      </nav>
      <div className="sidebar-content-scroll" ref={contentViewport}>
        {managementNavigation}
        {catalogs.map(catalog => <ExtensionCatalog key={catalog.id} catalog={catalog} />)}
        <SidebarBots items={bots} creation={botCreation} />
        <SidebarListContextMenu store={menus}>
        <ContextMenu.Trigger asChild onClickCapture={event => {
          if (menus.getListContextOpen() && "pointerType" in event.nativeEvent && event.nativeEvent.pointerType === "touch") {
            event.preventDefault(); event.stopPropagation();
          }
        }}><section className="sidebar-tasks" aria-label="Tasks" aria-busy={busyCatalog}>
          <div className="sidebar-list-toolbar"><span>{text("sidebar.conversations", "Conversations")}</span>
            <SidebarFiltersMenu store={menus}>
              <DropdownMenu.Trigger asChild><button type="button" className="sidebar-list-mode-trigger"
                aria-label={filtersLabel} title={[filtersLabel, ...(grouping.filter?.enabled ? [label(grouping.filter.label)] : []), serverFilter.serverId ? serverFilter.label : allServersLabel].join(" · ")}
                data-filter-active={serverFilter.serverId !== "" || grouping.filter?.enabled || undefined}><ListFilter size={16} /></button></DropdownMenu.Trigger>
              <DropdownMenu.Portal container={presentationRoot}><DropdownMenu.Content className="workbench-context-menu" align="end" sideOffset={4}
                onCloseAutoFocus={event => { if (menus.getSnapshot() !== null) event.preventDefault(); }}>
                {modeItems("dropdown")}
                <DropdownMenu.Separator />
                <DropdownMenu.Label className="sidebar-display-mode-label">{text("sidebar.serverFilter", "Filter by server")}</DropdownMenu.Label>
                <DropdownMenu.RadioGroup value={serverFilter.serverId} onValueChange={writeServerFilter}>
                  {[["", allServersLabel], ...serverOptions].map(([id, name]) => <DropdownMenu.RadioItem className="sidebar-list-mode-item" key={id} value={id!}>
                    <DropdownMenu.ItemIndicator className="sidebar-list-mode-indicator"><Check size={13} aria-hidden="true" /></DropdownMenu.ItemIndicator><span className="sidebar-list-mode-text">{name}</span>
                  </DropdownMenu.RadioItem>)}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content></DropdownMenu.Portal>
            </SidebarFiltersMenu>
          </div>
          {!searchInDialog ? <label className="sidebar-list-search"><Search size={14} aria-hidden="true" /><input type="search"
            aria-label={text("sidebar.search", "Search conversations")} placeholder={text("sidebar.search", "Search conversations")}
            value={query} onChange={event => setQuery(event.currentTarget.value)} /></label> : null}
          {showNewChat ? <SidebarNewChatButton onNewTask={onNewTask} /> : null}
          <div className="sidebar-activity-list" ref={activityList}>
            {grouping.notice ? <div className="sidebar-activity-empty">{label(grouping.notice)}</div> : null}
            {groupedSections ? groupedSections.map(group => <section key={group.id} className="sidebar-activity-group" aria-label={label(group.label)} data-collapsed={group.collapsed}>
              <h3 className="sidebar-thread-group-heading"><button type="button" className="sidebar-thread-group-toggle" aria-expanded={!group.collapsed} aria-controls={`${rowIdPrefix}-group-${encodeURIComponent(group.id)}`} onClick={() => threadListGrouping?.toggleGroup(group.id)}>
                <span className="sidebar-thread-group-avatar" aria-hidden="true"><AvatarImage src={group.avatarUrl} fallback={<UserRound size={14} />} /></span>
                <span className="sidebar-thread-group-label">{label(group.label)}</span><ChevronDown size={12} className={group.collapsed ? "is-collapsed" : undefined} />
              </button></h3>
              <div className="sidebar-activity-group__items" id={`${rowIdPrefix}-group-${encodeURIComponent(group.id)}`} hidden={group.collapsed}>
                {!group.collapsed && group.threads.map(ref => { const thread = matchingById.get(JSON.stringify([ref.hostId, ref.threadId])); return thread ? renderThread(thread) : null; })}
              </div>
            </section>) : <>
              {renderFlowSection("attention", text("sidebar.flow.attention", "Needs your attention"), taskFlow.attention)}
              {renderFlowSection("pinned", text("sidebar.flow.pinned", "Pinned"), taskFlow.pinned, pinnedLimit, setPinnedLimit)}
              {renderFlowSection("recent", text("sidebar.flow.recent", "Recent"), taskFlow.recent, recentLimit, setRecentLimit)}
            </>}
            {empty ? <div className="sidebar-activity-empty">{text("sidebar.empty", "No tasks yet")}</div> : null}
            {catalogErrors.map(catalog => retryFeedback(catalog.hostId, intl.formatMessage(catalog.cachedAt !== undefined
              ? { id: "sidebar.catalog.cached", defaultMessage: "Showing saved {server} conversations; refresh failed" }
              : { id: "sidebar.catalog.error", defaultMessage: "Couldn't load {server} conversations" }, { server: catalog.label }), onRetryThreadCatalog ? () => onRetryThreadCatalog(catalog.hostId) : undefined))}
            {threadCatalogDiscovery === "error" ? retryFeedback("discovery", text("sidebar.catalog.discoveryError", "Couldn't load remote connections"), onRetryThreadCatalogDiscovery) : null}
          </div>
        </section></ContextMenu.Trigger>
        <ContextMenu.Portal container={presentationRoot}><ContextMenu.Content className="workbench-context-menu"
          onCloseAutoFocus={event => { if (menus.getSnapshot() !== null) event.preventDefault(); }}>
          {modeItems("context")}
        </ContextMenu.Content></ContextMenu.Portal>
        </SidebarListContextMenu>
      </div>
      {showFooter ? <div className="sidebar-panel__footer">
        {footerActions.map(navigationAction)}
        <SidebarNavigationItem title={text("settings.title", "Settings")} icon={<SettingsGearIcon size={18} />} onInvoke={() => dismissAfter(onOpenSettings)} />
      </div> : null}
      <ThreadActionModals owner={actionOwner} />
    </div>
  </SidebarEntityDndCoordinator>;
});

/** Only this small control follows the Shell's transient action host. */
function SidebarNewChatButton({ onNewTask }: { onNewTask(): void }) {
  const intl = useIntl();
  const shell = useShellPresentation();
  const button = <button type="button" className="sidebar-new-chat" title={`${intl.formatMessage({ id: "sidebar.newChat", defaultMessage: "New chat" })} (${shortcutLabel("newChat")})`} aria-keyshortcuts={shortcutAria("newChat")} onClick={() => {
    onNewTask();
    shell?.dismissSidebarAfterSelection();
  }}><SquarePen size={16} aria-hidden="true" /><span>{intl.formatMessage({ id: "sidebar.newChat", defaultMessage: "New chat" })}</span></button>;

  return shell?.mobileSidebar
    ? shell.sidebarActionHost ? createPortal(button, shell.sidebarActionHost) : null
    : button;
}
