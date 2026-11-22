import { NavigationItem } from "@opencraft/design-system-web/navigation";
import { NavigationEmpty } from "@opencraft/design-system-web/navigation";
import { ShellNavigationButton } from "./shell-navigation/navigation-button";
import { createPortal } from "react-dom";
import { SidebarContentPortal } from "./shared-sidebar-content";
import { workbenchIconMetrics } from "@opencraft/design-system/tokens";
import { ConversationAppearanceIcon } from "./conversation-appearance";
import { SidebarEmptyIcon, SidebarSectionIcon } from "./sidebar-section-icons";
import { useStableEvent } from "@opencraft/react-runtime";
import { Button } from "@opencraft/design-system-web/button";
import { ChevronDownIcon as ChevronDown, LoadingRingIcon as LoaderCircle, ComposeIcon as SquarePen, SearchIcon as Search, CheckIcon as Check } from "@opencraft/design-system-web/action-icons";
import { FolderIcon, SettingsGearIcon } from "@opencraft/design-system-web/action-icons";
import { canHandleWorkbenchShortcut, matchesWorkbenchShortcut, shortcutLabel, shortcutAria } from "../workbench-shortcuts";
import * as ContextMenu from "@opencraft/design-system-web/context-menu";
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
import type { ReactNode, ComponentProps } from "react";
import { SidebarBots, SidebarEntityDndCoordinator } from "./sidebar-bots";
import { ThreadActionModals, threadActionKey, useThreadActionOwner, type ThreadActionCallbacks, type ThreadActionCapabilities, type ThreadActionOwner } from "./thread-management";
import { SidebarThreadMenuStore, type OpenSidebarThreadMenu, type SidebarThreadMenuKind } from "./sidebar-thread-menu-state";
import { SidebarThreadRowMenu, SidebarThreadBadge, SidebarFiltersMenu, SidebarListContextMenu } from "./sidebar-thread-menu";
import { sidebarRecentHeadings, sidebarActivityDateLabel, groupThreadsByTaskFlow, groupThreadsByNativeProject, sidebarThreadMetadata, summarizeSidebarActivity } from "../sidebar-activity";
import { sidebarThreadIdentity, sidebarThreadTree, type SidebarThreadTreeNode } from "../sidebar-thread-tree";
import { NavigationIcon as SidebarContributionIcon, type NavigationAction as SidebarActionItem } from "./shell-navigation/navigation-action";
import { useSidebarEndPull } from "./use-sidebar-end-pull";
import { sidebarScrollViewport, useSidebarAccordion } from "./use-sidebar-accordion";
import { SidebarBrowserResources } from "./sidebar-browser-resources";
import { SidebarActivityItem } from "./sidebar-activity-item";
import { SidebarActivitySummary } from "./sidebar-activity-summary";
import { SidebarNavigationItem } from "./sidebar-navigation-item";
import { SidebarThreadChildren } from "./sidebar-thread-children";
import { useTouchLayout } from "../runtime/use-touch-layout";
import { SidebarCalendarDayProvider, useSidebarCalendarDay } from "./use-sidebar-calendar-day";
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
  readonly presentation?: 'section' | 'entry';
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly initiallyCollapsed?: boolean;
  readonly action?: ReactNode;
  readonly content: ReactNode;
}
import { createContext, useContext, memo, useCallback, useEffect, useId, useMemo, useSyncExternalStore, useLayoutEffect, useRef, useState, useTransition } from "react";

interface SidebarProps {
  threads: readonly SidebarThread[];
  activeHostId: string;
  activeThreadId: string;
  pendingHostId?: string | null;
  pendingThreadId?: string | null;
  primaryActions?: readonly SidebarActionItem[];
  footerActions?: readonly SidebarActionItem[];
  footerAccessory?: ReactNode;
  managementNavigation?: ReactNode;
  catalogs?: readonly SidebarCatalogItem[];
  bots?: readonly SidebarEntity[];
  sidebarLayout: SidebarLayoutStore;
  botCreation?: SidebarEntityCreationCommand | null;
  /** Resolves after navigation commits; false means rejected or superseded. */
  onSelectThread(hostId: string, id: string): void | boolean | Promise<boolean>;
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

function SidebarConversationGroup({
  title, contentId, collapsed, hasRows, nativeProject, heading, children,
}: {
  title: string;
  contentId: string;
  collapsed: boolean;
  hasRows: boolean;
  nativeProject?: boolean;
  heading: ReactNode;
  children: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const occlusionRef = useRef<HTMLSpanElement>(null);
  const canOcclude = !collapsed && hasRows;

  useLayoutEffect(() => {
    const heading = headingRef.current;
    const occlusion = occlusionRef.current;
    if (!heading || !occlusion) return;
    const sizeOcclusion = () => {
      occlusion.style.setProperty("--sidebar-group-heading-block-size", `${heading.getBoundingClientRect().height}px`);
    };
    sizeOcclusion();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sizeOcclusion);
    observer.observe(heading, { box: "border-box" });
    return () => observer.disconnect();
  }, [canOcclude]);

  return <section className="sidebar-activity-group" aria-label={title} data-collapsed={collapsed}
    data-native-project={nativeProject || undefined} data-sidebar-sticky={canOcclude || undefined}>
    <h3 ref={headingRef} className="sidebar-thread-group-heading">{heading}</h3>
    <div className="sidebar-activity-group__items" id={contentId} hidden={collapsed}>{children}</div>
    {canOcclude ? <span aria-hidden="true" ref={occlusionRef} className="sidebar-activity-group__occlusion">
      <span className="sidebar-activity-group__occlusion-fill" />
    </span> : null}
  </section>;
}


function ExtensionCatalog({ catalog }: { readonly catalog: SidebarCatalogItem }) {
  const [collapsed, setCollapsed] = useState(catalog.initiallyCollapsed ?? false);
  if(catalog.presentation==='entry')return <section data-catalog-presentation="entry" className="sidebar-extension-catalog" aria-label={catalog.title}>{catalog.content}</section>;
  const heading = (
      <button
        className="sidebar-section-heading sidebar-catalog-heading"
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <ChevronDown size={12} data-group-disclosure="" className={collapsed ? "is-collapsed" : undefined} />
        <SidebarContributionIcon name={catalog.icon} size={13} />
        <span>{catalog.title}</span>
      </button>
  );
  return (
    <section className="sidebar-extension-catalog" aria-label={catalog.title}>
      {catalog.action ? <div className="sidebar-catalog-bar">{heading}{catalog.action}</div> : heading}
      {collapsed ? null : (
        <div className="sidebar-extension-catalog__content">{catalog.content}</div>
      )}
    </section>
  );
}

/** Entry contributions share one DOM owner while Shell moves their navigation slot. */
function SidebarEntryNavigation({ catalogs }: { catalogs: readonly SidebarCatalogItem[] }) {
  const shell = useShellPresentation();
  const [localHost, setLocalHost] = useState<HTMLDivElement | null>(null);
  return <><div className="sidebar-entry-navigation" ref={setLocalHost} />
    <SidebarContentPortal name="entry-navigation" target={shell?.sidebarActionHost ? shell.sidebarNavigationHost ?? null : localHost}>
      {catalogs.map(catalog => <ExtensionCatalog key={catalog.id} catalog={catalog} />)}
    </SidebarContentPortal>
  </>;
}

const defaultGrouping: ThreadListGroupingSnapshot = { revision: 0, mode: null, modes: [], hideRowBadge: false, notice: null };
const noThreadActions: ThreadActionCallbacks = { onRename: async () => {}, onFork: async () => {}, onArchive: async () => {}, onDelete: async () => {} };
const noSubscribe = () => () => {};
const getDefaultGrouping = () => defaultGrouping;

function SidebarDateHeading({ timestampMs }: { readonly timestampMs: number }) {
  const day = useSidebarCalendarDay();
  const intl = useIntl();
  return <h4 className="sidebar-activity-group__heading">{sidebarActivityDateLabel(timestampMs, day, intl.locale)}</h4>;
}

const PINNED_PAGE_SIZE = 6;
const RECENT_PAGE_SIZE = 10;

function sidebarUnread(thread: SidebarThread, grouping: ThreadListGroupingContribution | null) {
  return Boolean(thread.unread) && (grouping?.isParticipant?.({
    hostId: thread.connectionHostId, threadId: thread.id, updatedAt: thread.updatedAt, pinned: thread.pinned, createdByViewer: thread.createdByViewer,
  }) ?? true);
}

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
    </button> : pullToLoad ? <NavigationEmpty className="sidebar-activity-empty">
      {intl.formatMessage({ id: "sidebar.catalog.end", defaultMessage: "No more conversations" })}
    </NavigationEmpty> : null}
    {visibleCount > pageSize ? <button type="button" className="sidebar-activity-more" disabled={pending} onClick={() => onChange(pageSize)}>
      {intl.formatMessage({ id: "sidebar.catalog.less", defaultMessage: "Show less" })}
    </button> : null}
  </div>;
}

const SidebarThreadContent = memo(function SidebarThreadContent({ thread, attention, projectGrouped = false, render }: {
  thread: SidebarThread;
  attention: boolean;
  projectGrouped?: boolean;
  render: (thread: SidebarThread, attention: boolean, rowId: string, projectGrouped: boolean) => ReactNode;
}) {
  const rowId = useId();
  return render(thread, attention, rowId, projectGrouped);
});

interface SidebarThreadPresentationProps {
  thread: SidebarThread; attention: boolean; pending: boolean; active: boolean; selected: boolean;
  title: string; unread: boolean; activityId: string; disabled: boolean; projectGrouped: boolean;
  rename: boolean; archive: boolean; fork: boolean; delete: boolean; pin?: boolean; reference?: boolean;
  threadBadge: ThreadBadgeContribution | null; threadListGrouping: ThreadListGroupingContribution | null;
  grouping: ThreadListGroupingSnapshot; menus: SidebarThreadMenuStore; actionOwner: ThreadActionOwner;
  presentationRoot: HTMLElement | null;
  openConversation(hostId: string, threadId: string): void;
}
// A parent commit still reaches arbitrary badge components even when menu chrome
// can reuse its semantic row props. No persistent state or second data owner.
const SidebarParentRenderContext = createContext<unknown>(null);
function LiveSidebarThreadBadge(props: ComponentProps<typeof SidebarThreadBadge>) {
  useContext(SidebarParentRenderContext);
  return <SidebarThreadBadge {...props} />;
}
const SidebarThreadPresentation = memo(function SidebarThreadPresentation(props: SidebarThreadPresentationProps) {
  const { thread, attention, pending, active, selected, title, unread, activityId, disabled,
    threadBadge, threadListGrouping, grouping, menus, actionOwner, presentationRoot, openConversation } = props;
  const target = { hostId: thread.connectionHostId, threadId: thread.id, title, pinned: thread.pinned };
  const capabilities = { rename: props.rename, archive: props.archive, fork: props.fork,
    delete: props.delete, pin: props.pin, reference: props.reference };
  const changeOverlay = (kind: OpenSidebarThreadMenu["kind"], open: boolean) => {
    if (open && disabled) return;
    menus.update({ hostId: target.hostId, threadId: target.threadId, rowId: activityId, kind }, open);
  };
  const badge = threadBadge && !(grouping.mode && grouping.hideRowBadge) ? <LiveSidebarThreadBadge
    store={menus} rowId={activityId} contribution={threadBadge} hostId={thread.connectionHostId} threadId={thread.id}
    portalContainer={presentationRoot} onOpenChange={open => changeOverlay("badge", open)}
    onCloseAutoFocus={event => { if (menus.getSnapshot() !== null) event.preventDefault(); }}
  /> : null;
  const metadata = sidebarThreadMetadata(thread);
  return <SidebarThreadRowMenu key={sidebarThreadIdentity(thread)} store={menus} rowId={activityId} target={target} owner={actionOwner}
    capabilities={capabilities} disabled={disabled} activityLabelId={activityId}
    contextMenuExtra={threadListGrouping ? <ThreadListModeItems contribution={threadListGrouping} snapshot={grouping} kind="context" /> : undefined}
    onOpenMenuChange={(kind, open) => changeOverlay(kind, open)}
    onCloseAutoFocus={event => { if (menus.getSnapshot() !== null) event.preventDefault(); }}>
    <SidebarActivityItem conversationKey={sidebarThreadIdentity(thread)} activityId={activityId} active={active} selected={selected} pending={pending}
      disabled={disabled} title={title} project={props.projectGrouped ? "" : metadata}
      icon={<ConversationAppearanceIcon hostId={thread.connectionHostId} threadId={thread.id} size={workbenchIconMetrics.core.settings} />}
      tooltip={[title, metadata, thread.connectionHostLabel].filter(Boolean).join(" · ")}
      status={thread.status} unread={unread} goalActive={thread.goalActive}
      schedule={thread.schedule} twoLine={attention} resources={<SidebarBrowserResources store={menus} rowId={activityId} hostId={thread.connectionHostId} threadId={thread.id} unavailable={disabled}
        onOpenConversation={() => { openConversation(thread.connectionHostId, thread.id); }} />} badge={badge} badgePlacement={threadBadge?.placement}
      onInvoke={() => { menus.close(); openConversation(thread.connectionHostId, thread.id); }} />
  </SidebarThreadRowMenu>;
});

export const Sidebar = memo(function Sidebar(props: SidebarProps) {
  const {
    threads, activeHostId, activeThreadId, sidebarLayout, onSelectThread, onNewTask, onOpenSettings,
    pendingHostId = null, pendingThreadId = null, primaryActions = [], footerActions = [], footerAccessory,
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
  const [pinnedLimit, setPinnedLimit] = useState(PINNED_PAGE_SIZE);
  const [projectLimits, setProjectLimits] = useState<Record<string, number>>({});
  const [recentLimit, setRecentLimit] = useState(RECENT_PAGE_SIZE);
  const [scheduledLimit, setScheduledLimit] = useState(PINNED_PAGE_SIZE);
  const [mineLimit, setMineLimit] = useState(RECENT_PAGE_SIZE);
  const [menus] = useState(() => new SidebarThreadMenuStore());
  const selectionIntent = useRef<symbol | null>(null);
  const [selectionReceipt, setSelectionReceipt] = useState<{ intent: symbol; hostId: string; threadId: string } | null>(null);
  useLayoutEffect(() => () => { selectionIntent.current = null; }, [dismiss]);
  useLayoutEffect(() => {
    if (!selectionReceipt || selectionIntent.current !== selectionReceipt.intent) return;
    if (pendingHostId !== null || pendingThreadId !== null) return;
    if (activeHostId !== selectionReceipt.hostId || activeThreadId !== selectionReceipt.threadId) return;
    // Exit belongs to the committed target's render, not the click or connection.
    selectionIntent.current = null;
    dismiss?.();
  }, [selectionReceipt, activeHostId, activeThreadId, pendingHostId, pendingThreadId, dismiss]);
  const selectThread = useCallback((hostId: string, threadId: string) => {
    const intent = selectionIntent.current = Symbol('sidebar-selection');
    menus.close();
    void Promise.resolve(onSelectThread(hostId, threadId)).then(accepted => {
      if (accepted !== false && selectionIntent.current === intent) setSelectionReceipt({ intent, hostId, threadId });
    }).catch(error => console.error('Failed to select sidebar conversation', error));
  }, [menus, onSelectThread]);
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
  const contentViewport = useRef<HTMLDivElement>(null);
  const text = (id: string, defaultMessage: string) => intl.formatMessage({ id, defaultMessage });
  const label = (value: ThreadListLabel) => typeof value === "string" ? value : intl.formatMessage(value);
  const identity = sidebarThreadIdentity;
  const openRowConversation = useStableEvent((hostId: string, threadId: string) => {
    onSelectThread(hostId, threadId);
    dismiss?.();
  });
  const references = useMemo(() => threads.filter(thread => thread.visibility !== "hidden").map(thread => ({
    hostId: thread.connectionHostId, threadId: thread.id, updatedAt: thread.updatedAt, pinned: thread.pinned, createdByViewer: thread.createdByViewer,
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
  // Contributions may update their filter without replacing the contribution
  // object. Read it on every commit; only the resulting membership is memoized.
  const allowedReferences = threadListGrouping?.filterThreads?.(references) ?? references;
  const allowedKeys = JSON.stringify(allowedReferences.map(ref => [ref.hostId, ref.threadId]));
  const needle = query.trim().toLocaleLowerCase();
  const { matching, matchingById, tree, matchingReferences, taskFlow } = useMemo(() => {
    const allowed = new Set((JSON.parse(allowedKeys) as [string, string][]).map(key => JSON.stringify(key)));
    const matching = threads.filter(thread => thread.visibility !== "hidden"
      && (thread.accessMode === "private" || allowed.has(identity(thread)))
      && (!serverFilter.serverId || thread.serverOrigin.serverId === serverFilter.serverId)
      && (!needle || thread.title.toLocaleLowerCase().includes(needle)));
    const matchingById = new Map(matching.map(thread => [identity(thread), thread]));
    // Access categories have independent trees: a private child of a shared
    // conversation (or the reverse) remains in its own visible section.
    const sharedTree = sidebarThreadTree(matching.filter(thread => thread.accessMode !== "private"));
    const mineTree = sidebarThreadTree(matching.filter(thread => thread.accessMode === "private"));
    const tree = {
      nodes: new Map([...sharedTree.nodes, ...mineTree.nodes]),
      rootByIdentity: new Map([...sharedTree.rootByIdentity, ...mineTree.rootByIdentity]),
    };
    const roots = sharedTree.roots.map(node => node.thread);
    const rootIds = new Set(roots.map(identity));
    const matchingReferences = references.filter(ref => rootIds.has(JSON.stringify([ref.hostId, ref.threadId])));
    const taskFlow = { ...groupThreadsByTaskFlow(roots), scheduled: matching.filter(thread => thread.schedule && thread.schedule.status !== "deleted").sort((a, b) => b.updatedAt - a.updatedAt), mine: mineTree.roots.map(node => node.thread) };
    return { matching, matchingById, tree, matchingReferences, taskFlow };
  }, [threads, references, allowedKeys, needle, serverFilter.serverId]);
  const selection = pendingHostId !== null && pendingThreadId !== null
    ? identity({ connectionHostId: pendingHostId, id: pendingThreadId })
    : identity({ connectionHostId: activeHostId, id: activeThreadId });
  const groupedSections = grouping.mode && threadListGrouping ? threadListGrouping.project(matchingReferences) : null;
  const nativeProjects = groupThreadsByNativeProject(taskFlow.recent);
  const recentWithoutProjects = taskFlow.recent.filter(thread => !thread.nativeProject);
  const flowKey = (key: string) => `flow:${key}`;
  const groupKey = (key: string) => `group:${key}`;
  const selectedRoot = tree.rootByIdentity.get(selection) ?? selection;
  const containsSelected = (rows: readonly SidebarThread[]) => rows.some(thread => identity(thread) === selectedRoot);
  let initialSection: string | null;
  if (!preferenceState.values["sidebar.scheduledCollapsed"] && taskFlow.scheduled.some(thread => identity(thread) === selection)) initialSection = flowKey("scheduled");
  else if (containsSelected(taskFlow.mine)) initialSection = flowKey("mine");
  else if (groupedSections) {
    const group = groupedSections.find(group => !group.collapsed && group.threads.some(ref => JSON.stringify([ref.hostId, ref.threadId]) === selectedRoot))
      ?? groupedSections.find(group => !group.collapsed);
    initialSection = group ? groupKey(group.id) : null;
  } else {
    const selectedFlow = (["attention","pinned"] as const).find(key => containsSelected(taskFlow[key]));
    const selectedProject = nativeProjects.find(group=>containsSelected(group.threads));
    const fallback = recentWithoutProjects.length ? "recent" : nativeProjects[0] ? `native-project:${nativeProjects[0].key}`
      : taskFlow.pinned.length ? "pinned" : taskFlow.attention.length ? "attention" : "mine";
    initialSection=flowKey(selectedFlow ?? (selectedProject ? `native-project:${selectedProject.key}` : fallback));
  }
  const accordion = useSidebarAccordion(JSON.stringify([threadListGrouping?.id ?? null, grouping.mode]), initialSection, contentViewport, activityList);
  const sectionCollapsed = (key: string) => accordion.collapsed(flowKey(key));
  const toggleSection = (key: string, button: HTMLElement) => {
    const next = accordion.toggle(flowKey(key), button);
    if (key === "scheduled" || accordion.openKey === flowKey("scheduled")) {
      void preferences.set("sidebar.scheduledCollapsed", next !== flowKey("scheduled"));
    }
  };
  const selectedPath = useMemo(() => {
    const path = new Set<string>();
    let key = selection;
    while (!path.has(key)) {
      const node = tree.nodes.get(key);
      if (!node) break;
      path.add(key);
      if (!node.thread.parentThreadId) break;
      key = identity({ connectionHostId: node.thread.connectionHostId, id: node.thread.parentThreadId });
    }
    return path;
  }, [tree, selection]);
  const applicableCatalogs = threadCatalogs.filter(catalog => !serverFilter.serverId
    || catalog.hostId === serverFilter.serverId
    || threads.some(thread => thread.connectionHostId === catalog.hostId && thread.serverOrigin.serverId === serverFilter.serverId));
  const busyCatalog = threadCatalogDiscovery === "loading" || applicableCatalogs.some(catalog => catalog.phase === "loading");
  const catalogErrors = applicableCatalogs.filter(catalog => catalog.phase === "error"
    || catalog.phase === "ready" && catalog.cachedAt !== undefined);
  const empty = matching.length === 0 && !busyCatalog && catalogErrors.length === 0 && threadCatalogDiscovery !== "error";
  const filtersLabel = text("sidebar.filters", "Filters");
  const allServersLabel = text("sidebar.allServers", "All servers");
  const dismissAfter = (action: () => void) => { selectionIntent.current = null; menus.close(); action(); dismiss?.(); };
  const writeServerFilter = (serverId: string) => {
    menus.setFiltersOpen(false);
    const name = serverOptions.find(([id]) => id === serverId)?.[1] ?? "";
    void preferences.set("sidebar.serverFilter", { serverId, label: name });
  };
  const modeItems = (kind: "context" | "dropdown") => <ThreadListModeItems contribution={threadListGrouping} snapshot={grouping} kind={kind}
    onSelect={kind === "dropdown" ? () => menus.setFiltersOpen(false) : undefined} />;
  const renderThreadContent = useCallback((thread: SidebarThread, attention: boolean, rowId: string, projectGrouped: boolean) => {
    const pending = pendingHostId === thread.connectionHostId && pendingThreadId === thread.id;
    const active = activeHostId === thread.connectionHostId && activeThreadId === thread.id;
    const selected = pendingHostId !== null && pendingThreadId !== null ? pending : active;
    const title = pendingTitle?.(thread.connectionHostId, thread.id) ?? thread.title;
    const activityId = `${rowIdPrefix}-${rowId}`;
    const disabled = thread.interactionAvailable === false;
    const capabilities = threadCapabilities?.(thread.connectionHostId, thread.id)
      ?? { rename: !!threadActions, archive: !!threadActions, fork: !!threadActions, delete: !!threadActions, pin: !!threadActions?.onSetPinned };
    const unread = sidebarUnread(thread, threadListGrouping);
    return <SidebarParentRenderContext.Provider value={props}>
      <SidebarThreadPresentation projectGrouped={projectGrouped} thread={thread} attention={attention} pending={pending} active={active}
        selected={selected} title={title} unread={unread} activityId={activityId} disabled={disabled}
        rename={capabilities.rename} archive={capabilities.archive} fork={capabilities.fork}
        delete={capabilities.delete} pin={capabilities.pin} reference={capabilities.reference}
        threadBadge={threadBadge} threadListGrouping={threadListGrouping} grouping={grouping} menus={menus}
        actionOwner={actionOwner} presentationRoot={presentationRoot} openConversation={openRowConversation} />
    </SidebarParentRenderContext.Provider>;
  // Parent commits always reevaluate dynamic readers. Scalar row presentation
  // can reuse menu chrome while the badge still observes parent props updates.
  }, [props, actionOwner, grouping, presentationRoot, dismiss, menus, rowIdPrefix, openRowConversation]);
  const renderThread = (thread: SidebarThread, attention = false, projectGrouped = false) => <SidebarThreadContent
    key={identity(thread)} thread={thread} attention={attention} projectGrouped={projectGrouped} render={renderThreadContent} />;
  const renderTreeNode = (node: SidebarThreadTreeNode<SidebarThread>, attention: boolean, projectGrouped = false): ReactNode => (
    <li key={identity(node.thread)} className="sidebar-thread-tree__node"
      data-thread-id={node.thread.id} data-host-id={node.thread.connectionHostId}>
      {renderThread(node.thread, attention, projectGrouped)}
      {node.children.length ? <SidebarThreadChildren children={node.children} selectedPath={selectedPath}
        selection={selection} searching={Boolean(needle)} renderNode={child => renderTreeNode(child, attention, projectGrouped && child.thread.nativeProject?.id === node.thread.nativeProject?.id)} /> : null}
    </li>
  );
  const renderThreadTree = (thread: SidebarThread, attention = false, projectGrouped = false) => {
    const node = tree.nodes.get(identity(thread));
    return node ? <ul className="sidebar-thread-tree" role="list">{renderTreeNode(node, attention, projectGrouped)}</ul> : null;
  };
  const renderFlowSection = (key: string, title: string, rows: readonly SidebarThread[], limit?: number, update?: (count: number) => void, nativeProject = false) => {
    if (!rows.length && key !== "mine") return null;
    const collapsed = sectionCollapsed(key);
    const visible = limit === undefined ? rows : rows.slice(0, limit);
    const headings = key === "recent" ? sidebarRecentHeadings(visible) : null;
    const counts = key === "pinned" || key === "recent" || key === "attention" || nativeProject
      ? summarizeSidebarActivity(rows.flatMap(thread => { const node = tree.nodes.get(identity(thread)); return node ? [node] : []; }), thread => sidebarUnread(thread, threadListGrouping))
      : null;
    const summaryId = `${rowIdPrefix}-summary-${key}`;
    const hasSummary = counts !== null && (counts.unread + counts.attention + counts.running) > 0;
    const contentId = `${rowIdPrefix}-flow-${key}`;
    return <SidebarConversationGroup key={key} title={title} contentId={contentId}
      collapsed={collapsed} hasRows={visible.length > 0} nativeProject={nativeProject}
      heading={<button type="button" className="sidebar-thread-group-toggle" aria-expanded={!collapsed} aria-controls={contentId}
        aria-label={title} aria-describedby={hasSummary ? summaryId : undefined}
        onClick={event => toggleSection(key, event.currentTarget)}>
        {nativeProject ? <span className="sidebar-native-project-icon" aria-hidden="true"><FolderIcon size={16} /></span> : <SidebarSectionIcon section={key} />}<span className="sidebar-thread-group-label">{title}</span><ChevronDown size={12} data-group-disclosure="" className={collapsed ? "is-collapsed" : undefined} />
        {counts ? <SidebarActivitySummary id={summaryId} counts={counts} /> : null}
      </button>}>
        {key === "mine" && !rows.length ? <NavigationEmpty className="sidebar-activity-empty"><SidebarEmptyIcon />{text("sidebar.access.empty", "No private conversations yet")}</NavigationEmpty> : null}
        {visible.map(thread => {
          const heading = headings?.get(thread);
          return <div key={identity(thread)}>
            {heading === "running" ? <h4 className="sidebar-activity-group__heading">
              {intl.formatMessage({ id: "sidebar.activity.inProgress", defaultMessage: "In progress" })}
            </h4> : heading === "date" ? <SidebarDateHeading timestampMs={thread.updatedAt * 1_000} /> : null}
            {key === "scheduled" ? renderThread(thread) : renderThreadTree(thread, key === "attention", nativeProject)}
          </div>;
        })}
        {limit !== undefined && update ? <SidebarPagination total={rows.length} visibleCount={limit}
          pageSize={nativeProject ? 6 : key === "pinned" || key === "scheduled" ? PINNED_PAGE_SIZE : RECENT_PAGE_SIZE} onChange={update} pullToLoad={key === "recent"} /> : null}
    </SidebarConversationGroup>;
  };
  const visibleSections = [
    ...(groupedSections?.map(group => ({ ...group, collapsed: accordion.collapsed(groupKey(group.id)) })) ?? Object.entries({...taskFlow,recent:recentWithoutProjects}).filter(([id]) => id !== "mine" && id !== "scheduled").map(([id, rows]) => ({
      id, collapsed: sectionCollapsed(id),
      threads: rows.slice(0, id === "pinned" ? pinnedLimit : id === "recent" ? recentLimit : id === "scheduled" ? scheduledLimit : rows.length)
        .map(thread => ({ hostId: thread.connectionHostId, threadId: thread.id })),
    }))),
    ...(!groupedSections ? nativeProjects.map(group => ({ id: `native-project:${group.key}`, collapsed: sectionCollapsed(`native-project:${group.key}`),
      threads: group.threads.slice(0,projectLimits[group.key]??6).map(thread=>({hostId:thread.connectionHostId,threadId:thread.id})) })) : []),
    { id: "scheduled", collapsed: sectionCollapsed("scheduled"), threads: taskFlow.scheduled.slice(0, scheduledLimit).map(thread => ({ hostId: thread.connectionHostId, threadId: thread.id })) },
    { id: "mine", collapsed: sectionCollapsed("mine"),
      threads: taskFlow.mine.slice(0, mineLimit).map(thread => ({ hostId: thread.connectionHostId, threadId: thread.id })) },
  ];
  // Row menus, the badge and the list display menu are one exclusive overlay
  // owner; an owner whose row is no longer visible or no longer accepts
  // interaction must not keep the menu open.
  // A retained menu owner must not outlive its visible, interactive row.
  // Inspect only the open target on parent commits; menu-channel updates still
  // render only the affected row and never rebuild the catalog or grouping.
  useLayoutEffect(() => {
    const current = menus.getSnapshot();
    if (!current || !("hostId" in current)) return;
    const row = current.rowId ? document.getElementById(current.rowId) : null;
    if (current.rowId && (!row || row.closest("[hidden]"))) { menus.close(); return; }
    const key = JSON.stringify([current.hostId, current.threadId]);
    const target = matchingById.get(key);
    const rootKey = tree.rootByIdentity.get(key) ?? key;
    const visible = target && target.interactionAvailable !== false && visibleSections.some(group =>
      !group.collapsed && group.threads.some(ref => JSON.stringify([ref.hostId, ref.threadId]) === (group.id === "scheduled" ? key : rootKey)));
    if (!visible) menus.close();
  });
  const selectedKey = JSON.stringify(pendingHostId !== null && pendingThreadId !== null
    ? [pendingHostId, pendingThreadId] : [activeHostId, activeThreadId]);
  const onConversationShortcut = useStableEvent((event: KeyboardEvent) => {
    if (!canHandleWorkbenchShortcut(event)) return;
    const direction = matchesWorkbenchShortcut(event, "conversationPrevious", navigator.platform) ? -1
      : matchesWorkbenchShortcut(event, "conversationNext", navigator.platform) ? 1 : 0;
    const list = activityList.current;
    if (direction === 0 || !list) return;

    // The accordion and each child disclosure own what is rendered. Read the
    // shown conversation buttons so navigation uses that exact row order.
    const rows = new Map<string, HTMLButtonElement>();
    for (const button of list.querySelectorAll<HTMLButtonElement>("button[data-sidebar-conversation]:enabled")) {
      if (list.contains(button.closest("[hidden]"))) continue;
      const key = button.dataset.sidebarConversation!;
      if (!rows.has(key)) rows.set(key, button);
    }
    const keys = [...rows.keys()];
    const index = keys.indexOf(selectedKey);
    const target = index === -1 ? (direction === 1 ? keys[0] : keys.at(-1)) : keys[index + direction];
    if (keys.length === 0) return;
    event.preventDefault();
    if (target !== undefined) rows.get(target)?.click();
  });
  useEffect(() => {
    window.addEventListener("keydown", onConversationShortcut);
    return () => window.removeEventListener("keydown", onConversationShortcut);
  }, [onConversationShortcut]);
  const selectedRootKey = tree.rootByIdentity.get(selectedKey) ?? selectedKey;
  const containsSelection = (group: typeof visibleSections[number]) => group.threads.some(ref =>
    JSON.stringify([ref.hostId, ref.threadId]) === (group.id === "scheduled" ? selectedKey : selectedRootKey));
  const selectedSection = visibleSections.find(group => !group.collapsed && containsSelection(group)) ?? visibleSections.find(containsSelection);
  const selectedSectionId = selectedSection?.id;
  const selectedVisible = selectedSection !== undefined && !selectedSection.collapsed;
  const previousSelection = useRef({ key: selectedKey, pinnedLimit, recentLimit, mineLimit, projectLimits });
  useLayoutEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { key: selectedKey, pinnedLimit, recentLimit, mineLimit, projectLimits };
    // Revealing more history is a reading action, not a new navigation intent.
    if (previous.key === selectedKey && (pinnedLimit > previous.pinnedLimit || recentLimit > previous.recentLimit || mineLimit > previous.mineLimit || Object.entries(projectLimits).some(([key,limit])=>limit>(previous.projectLimits[key]??6)))) return;
    if (accordion.disclosureChanged || !selectedVisible) return;
    const content = contentViewport.current;
    const sectionId = selectedSectionId === "scheduled" || selectedSectionId === "mine" || !groupedSections
      ? `${rowIdPrefix}-flow-${selectedSectionId}` : `${rowIdPrefix}-group-${encodeURIComponent(selectedSectionId ?? "")}`;
    const row = document.getElementById(sectionId)?.querySelector<HTMLElement>(".sidebar-activity-item.is-selected");
    if (!content || !row) return;
    const viewport = sidebarScrollViewport(content, activityList.current) ?? content;
    if (!viewport.isConnected || !viewport.clientHeight || !viewport.clientWidth
      || viewport.closest('[inert], [aria-hidden="true"]')) return;
    const bounds = viewport.getBoundingClientRect();
    const padding = getComputedStyle(viewport);
    // Explicit selection reveal shares the native sticky disclosure's reading
    // boundary. This is a selection transaction, not a per-scroll projection.
    const heading = row.closest(".sidebar-activity-group")?.querySelector(".sidebar-thread-group-heading");
    const readingTop = bounds.top + (parseFloat(padding.scrollPaddingTop) || 0);
    // Reserve its height even after the section has left the viewport: revealing
    // an earlier row can make that same heading sticky again in this transaction.
    const top = readingTop + (heading?.getBoundingClientRect().height ?? 0);
    const bottom = bounds.bottom - (parseFloat(padding.scrollPaddingBottom) || 0);
    const item = row.getBoundingClientRect();
    if (item.top < top) viewport.scrollTop += item.top - top;
    else if (item.bottom > bottom) viewport.scrollTop += Math.min(item.bottom - bottom, item.top - top);
  }, [selectedKey, selectedSectionId, selectedVisible, pinnedLimit, recentLimit, mineLimit, projectLimits]);
  const navigationAction = (action: SidebarActionItem) => <SidebarNavigationItem key={action.id} title={action.title}
    active={action.active} icon={<SidebarContributionIcon name={action.icon} />} onInvoke={() => dismissAfter(action.onInvoke)} />;
  const retryLabel = text("sidebar.catalog.retry", "Retry");
  const retryFeedback = (key: string, message: string, retry?: () => void) => <div key={key} className="sidebar-catalog-feedback">
    <span className="sidebar-catalog-feedback__message">{message}</span>
    {retry ? <button type="button" className="sidebar-catalog-feedback__retry" onClick={retry}>{retryLabel}</button> : null}
  </div>;

  return <SidebarCalendarDayProvider><SidebarEntityDndCoordinator items={bots} layout={sidebarLayout}>
    <div className="sidebar-panel">
      <nav className="sidebar-navigation" aria-label="Primary">
        {showStart ? <SidebarNavigationItem icon={<SquarePen size={18} />} title={text("sidebar.start", "Start")} onInvoke={() => dismissAfter(onNewTask)} /> : null}
        {primaryActions.map(navigationAction)}
      </nav>
      {managementNavigation ? <div className="sidebar-management-navigation">{managementNavigation}</div> : null}
      {catalogs.some(catalog => catalog.presentation === "entry") ? <SidebarEntryNavigation catalogs={catalogs.filter(catalog => catalog.presentation === "entry")} /> : null}
      <div className="sidebar-content-scroll" ref={contentViewport}>
        {catalogs.filter(catalog => catalog.presentation !== "entry").map(catalog => <ExtensionCatalog key={catalog.id} catalog={catalog} />)}
        <SidebarBots items={bots} creation={botCreation} />
        {showNewChat ? <SidebarNewChatButton onNewTask={onNewTask} /> : null}
        <SidebarListContextMenu store={menus}>
        <ContextMenu.Trigger asChild><section className="sidebar-tasks" aria-label="Tasks" aria-busy={busyCatalog}>
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
          <div className="sidebar-activity-list" ref={activityList}>
            {grouping.notice ? <NavigationEmpty className="sidebar-activity-empty">{label(grouping.notice)}</NavigationEmpty> : null}
            {renderFlowSection("scheduled", text("schedules.catalog.title", "Scheduled tasks"), taskFlow.scheduled, scheduledLimit, setScheduledLimit)}
            {groupedSections ? groupedSections.map(group => {
              const key = groupKey(group.id);
              const collapsed = accordion.collapsed(key);
              const contentId = `${rowIdPrefix}-group-${encodeURIComponent(group.id)}`;
              const title = label(group.label);
              const rows = collapsed ? [] : group.threads.flatMap(ref => {
                const thread = matchingById.get(JSON.stringify([ref.hostId, ref.threadId]));
                return thread ? [thread] : [];
              });
              return <SidebarConversationGroup key={group.id} title={title} contentId={contentId}
                collapsed={collapsed} hasRows={rows.length > 0}
                heading={<button type="button" className="sidebar-thread-group-toggle" aria-expanded={!collapsed} aria-controls={contentId} onClick={event => {
                  const next = accordion.toggle(key, event.currentTarget);
                  if (accordion.openKey === flowKey("scheduled")) void preferences.set("sidebar.scheduledCollapsed", true);
                  // Product-owned preferences remain product-owned; Shell projects
                  // their initial intent into its exclusive disclosure layout.
                  if ((next !== key) !== group.collapsed) threadListGrouping?.toggleGroup(group.id);
                }}>
                  <span className="sidebar-thread-group-avatar" aria-hidden="true"><AvatarImage src={group.avatarUrl} fallback={<UserRound size={14} />} /></span>
                  <span className="sidebar-thread-group-label">{title}</span><ChevronDown size={12} data-group-disclosure="" className={collapsed ? "is-collapsed" : undefined} />
                </button>}>
                {rows.map(thread => <div key={identity(thread)}>{renderThreadTree(thread)}</div>)}
              </SidebarConversationGroup>;
            }) : <>
              {renderFlowSection("attention", text("sidebar.flow.attention", "Needs your attention"), taskFlow.attention)}
              {renderFlowSection("pinned", text("sidebar.flow.pinned", "Pinned"), taskFlow.pinned, pinnedLimit, setPinnedLimit)}
            </>}
            {renderFlowSection("mine", text("sidebar.access.mine", "Private"), taskFlow.mine, mineLimit, setMineLimit)}
            {!groupedSections && nativeProjects.length ? <div className="sidebar-native-projects">
              <h3 className="sidebar-native-projects__title">{text("sidebar.nativeProjects", "Projects")}</h3>
              {nativeProjects.map(group => renderFlowSection(`native-project:${group.key}`, group.label, group.threads, projectLimits[group.key] ?? 6,
                count => setProjectLimits(current => ({ ...current, [group.key]: count })), true))}
            </div> : null}
            {!groupedSections ? renderFlowSection("recent", text("sidebar.flow.recent", "Recent"), recentWithoutProjects, recentLimit, setRecentLimit) : null}
            {empty ? <NavigationEmpty className="sidebar-activity-empty">{text("sidebar.empty", "No tasks yet")}</NavigationEmpty> : null}
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
      {footerAccessory}
      {showFooter ? <div className="sidebar-panel__footer">
        {footerActions.map(navigationAction)}
        <SidebarNavigationItem title={text("settings.title", "Settings")} icon={<SettingsGearIcon size={18} />} onInvoke={() => dismissAfter(onOpenSettings)} />
      </div> : null}
      <ThreadActionModals owner={actionOwner} />
    </div>
  </SidebarEntityDndCoordinator></SidebarCalendarDayProvider>;
});

/** Creation occupies the same bottom action row as the other touch entrances. */
function SidebarNewChatButton({ onNewTask }: { onNewTask(): void }) {
  const intl = useIntl();
  const shell = useShellPresentation();
  const touch = useTouchLayout();
  const floating = !!shell?.mobileSidebar && touch;
  const label = intl.formatMessage({ id: "sidebar.newChat", defaultMessage: "New chat" });
  const props = {
    type: "button" as const,
    "aria-label": label,
    className: `sidebar-new-chat${floating ? " shell-sidebar-primary-action" : ""}`,
    title: `${label} (${shortcutLabel("newChat")})`,
    "aria-keyshortcuts": shortcutAria("newChat"),
    onClick: () => {
      onNewTask();
      shell?.dismissSidebarAfterSelection();
    },
    children: <><SquarePen size={16} aria-hidden="true" /><span data-navigation-label="">{label}</span></>,
  };
  const button = floating
    ? <ShellNavigationButton {...props} contentLayout="row" surface="floating" />
    : <NavigationItem {...props} inset="sidebar" />;
  return floating ? shell?.sidebarActionHost ? createPortal(button, shell.sidebarActionHost) : null : button;
}
