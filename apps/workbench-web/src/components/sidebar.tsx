import { useAsyncNotices } from "./async-notices";
import { SidebarRecentRow, recentRowLabels, type RecentRowAction } from "./sidebar-recent-row";
import type { RecentConversationPreference } from "@opencraft/ui-preferences";
import { SidebarInstanceHeading } from "./sidebar-instance-heading";
import { useStableEvent } from "@opencraft/react-runtime";
import { Button, IconButton } from "@opencraft/design-system-web/button";
import { ChevronDownIcon as ChevronDown, LoadingRingIcon as LoaderCircle, ComposeIcon as SquarePen, SearchIcon as Search, CheckIcon as Check } from "@opencraft/design-system-web/action-icons";
import { FolderIcon, SettingsGearIcon, AddIcon } from "@opencraft/design-system-web/action-icons";
import { shortcutLabel, shortcutAria } from "../workbench-shortcuts";
import { createPortal } from "react-dom";
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
import { sidebarActivityDateHeadings, recentSidebarThreads, recentConversationKey, groupSidebarProjectsByInstance, groupThreadsByNativeProject, groupThreadsByTaskFlow, sidebarActivityMetadata } from "../sidebar-activity";
import { sidebarThreadIdentity, sidebarThreadTree, type SidebarThreadTreeNode } from "../sidebar-thread-tree";
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
  readonly directoryGroup?: import("../sidebar-activity").SidebarActivityThread["directoryGroup"];
  readonly instanceGroup?: import("../sidebar-activity").SidebarActivityThread["instanceGroup"];
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
import { createContext, useContext, lazy, Suspense, memo, useCallback, useEffect, useId, useMemo, useSyncExternalStore, useLayoutEffect, useRef, useState, useTransition } from "react";
import { collectExistingConversationTags, matchesConversationTagFilters, normalizeConversationTags, toggleConversationTag, type ConversationTagId } from "./conversation-tags";

const ConversationTagPalette = lazy(async () => ({ default: (await import("./conversation-tags-menu")).ConversationTagPalette }));
const SidebarRecentTagFilterBar = lazy(async () => ({ default: (await import("./conversation-tags-menu")).SidebarRecentTagFilterBar }));

export interface SidebarFolderTarget {
  readonly hostId: string;
  readonly cwd: string;
}

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
  onSelectThread(hostId: string, id: string): void;
  onNewTask(): void;
  onNewTaskInFolder?(target: SidebarFolderTarget): void;
  onOpenSettings(): void;
  showFooter?: boolean;
  showStart?: boolean;
  searchInDialog?: boolean;
  instanceNameScope?: string;
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
const sidebarRowId = (prefix: string, scope: string, key: string) => `${prefix}-${encodeURIComponent(JSON.stringify([scope, key]))}`;

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

const SidebarThreadContent = memo(function SidebarThreadContent({ thread, attention, projectGrouped = false, rowScope, render }: {
  thread: SidebarThread;
  attention: boolean;
  projectGrouped?: boolean;
  rowScope: string;
  render: (thread: SidebarThread, attention: boolean, projectGrouped: boolean, rowScope: string) => ReactNode;
}) {
  return render(thread, attention, projectGrouped, rowScope);
});

interface SidebarThreadPresentationProps {
  thread: SidebarThread; attention: boolean; pending: boolean; active: boolean; selected: boolean;
  title: string; unread: boolean; activityId: string; disabled: boolean; projectGrouped: boolean;
  tags: readonly ConversationTagId[];
  onToggleTag(thread: SidebarThread, tag: ConversationTagId): void;
  onClearTags(thread: SidebarThread): void;
  contextDevice?: string; contextFolder?: string; recentScope: string; recent?: boolean; recentPinned?: boolean; recentBusy?: boolean;
  onRecentAction(thread: SidebarThread, action: RecentRowAction): void;
  rename: boolean; archive: boolean; fork: boolean; delete: boolean; pin?: boolean; reference?: boolean;
  threadBadge: ThreadBadgeContribution | null; threadListGrouping: ThreadListGroupingContribution | null;
  grouping: ThreadListGroupingSnapshot; menus: SidebarThreadMenuStore; actionOwner: ThreadActionOwner;
  presentationRoot: HTMLElement | null;
  rowScope: string;
  openConversation(hostId: string, threadId: string, rowScope: string): void;
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
  const labels = recentRowLabels(useIntl(), props.recentPinned ?? false);
  const target = { hostId: thread.connectionHostId, threadId: thread.id, title, pinned: thread.pinned };
  const capabilities = { rename: props.rename, archive: props.archive, fork: props.fork,
    delete: props.delete, pin: props.recent ? false : props.pin, reference: props.reference };
  const changeOverlay = (kind: OpenSidebarThreadMenu["kind"], open: boolean) => {
    if (open && disabled && !(kind === "dropdown" || kind === "context")) return;
    menus.update({ hostId: target.hostId, threadId: target.threadId, rowId: activityId, kind }, open);
  };
  const badge = threadBadge && !(grouping.mode && grouping.hideRowBadge) ? <LiveSidebarThreadBadge
    store={menus} rowId={activityId} contribution={threadBadge} hostId={thread.connectionHostId} threadId={thread.id}
    portalContainer={presentationRoot} onOpenChange={open => changeOverlay("badge", open)}
    onCloseAutoFocus={event => { if (menus.getSnapshot() !== null) event.preventDefault(); }}
  /> : null;
  const metadata = sidebarActivityMetadata(thread);
  const row = <SidebarThreadRowMenu key={sidebarThreadIdentity(thread)} store={menus} rowId={activityId} target={target} owner={actionOwner}
    capabilities={capabilities} disabled={disabled} activityLabelId={activityId}
    tagMenuContent={<Suspense fallback={null}><ConversationTagPalette values={props.tags} onToggle={tag => props.onToggleTag(thread, tag)} onClear={() => { props.onClearTags(thread); menus.close(); }} /></Suspense>}
    additionalActions={props.recent ? [
      { id: "recent-pin", label: labels.pin, disabled: props.recentBusy, onSelect: () => props.onRecentAction(thread, props.recentPinned ? "unpin" : "pin") },
      { id: "recent-dismiss", label: labels.dismiss, disabled: props.recentBusy, onSelect: () => props.onRecentAction(thread, "dismiss") },
    ] : undefined}
    contextMenuExtra={threadListGrouping ? <ThreadListModeItems contribution={threadListGrouping} snapshot={grouping} kind="context" /> : undefined}
    onOpenMenuChange={(kind, open) => changeOverlay(kind, open)}
    onCloseAutoFocus={event => { if (menus.getSnapshot() !== null) event.preventDefault(); }}>
    <SidebarActivityItem tags={props.tags} pinnedInRecent={props.recentPinned} activityId={activityId} agent={thread.agent} active={active} selected={selected} pending={pending}
      disabled={disabled} title={title} context={props.contextDevice ? { device: props.contextDevice, folder: props.contextFolder, agent: thread.agent?.label } : undefined} project={props.projectGrouped || props.contextDevice ? "" : metadata.project}
      tooltip={[title, metadata.project, thread.connectionHostLabel, thread.id].join(" · ")}
      status={thread.status} unread={unread} goalActive={thread.goalActive}
      schedule={thread.schedule} twoLine={attention} resources={<SidebarBrowserResources store={menus} rowId={activityId} hostId={thread.connectionHostId} threadId={thread.id} unavailable={disabled}
        onOpenConversation={() => { openConversation(thread.connectionHostId, thread.id, props.rowScope); }} />} badge={badge} badgePlacement={threadBadge?.placement}
      onInvoke={() => { menus.close(); openConversation(thread.connectionHostId, thread.id, props.rowScope); }} />
  </SidebarThreadRowMenu>;
  return props.recent ? <SidebarRecentRow key={props.recentScope} store={menus} hostId={target.hostId} threadId={target.threadId} rowId={activityId}
    pinned={props.recentPinned ?? false} pending={props.recentBusy ?? false} onAction={action => props.onRecentAction(thread, action)}>{row}</SidebarRecentRow> : row;
});

export const Sidebar = memo(function Sidebar(props: SidebarProps) {
  const {
    threads, activeHostId, activeThreadId, sidebarLayout, onSelectThread, onNewTask, onNewTaskInFolder, onOpenSettings,
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
  const recentPreferences = preferenceState.values["sidebar.recentConversations"];
  const conversationTags = preferenceState.values["sidebar.conversationTags"];
  const recentScope = props.instanceNameScope ?? "local";
  const [recentTagFilters, setRecentTagFilters] = useState<readonly ConversationTagId[]>([]);
  const notices = useAsyncNotices();
  const scopeRef = useRef(recentScope), scopeEpoch = useRef(0);
  if (scopeRef.current !== recentScope) { scopeRef.current = recentScope; scopeEpoch.current += 1; }
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const restoreRecentFocus = useRef(false);
  const busyRecentRef = useRef(new Set<string>());
  const [busyRecent, setBusyRecent] = useState<ReadonlySet<string>>(new Set());
  const [recentUndo, setRecentUndo] = useState<{ scope: string; key: string; dismissedAt: number; previous?: RecentConversationPreference } | null>(null);
  const recentKey = (thread: SidebarThread) => recentConversationKey(recentScope, thread.connectionHostId, thread.id);
  const isRecentPinned = (thread: SidebarThread) => recentPreferences[recentKey(thread)]?.pinnedAt !== undefined;
  const grouping = useSyncExternalStore(
    threadListGrouping ? (listener) => threadListGrouping.subscribe(listener) : noSubscribe,
    threadListGrouping ? () => threadListGrouping.getSnapshot() : getDefaultGrouping,
    threadListGrouping ? () => threadListGrouping.getSnapshot() : getDefaultGrouping,
  );
  const [query, setQuery] = useState("");
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [pinnedLimit, setPinnedLimit] = useState(PINNED_PAGE_SIZE);
  const [projectLimits, setProjectLimits] = useState<Record<string, number>>({});
  const [recentLimit, setRecentLimit] = useState(RECENT_PAGE_SIZE);
  const [mineLimit, setMineLimit] = useState(RECENT_PAGE_SIZE);
  const [menus] = useState(() => new SidebarThreadMenuStore());
  useLayoutEffect(() => { menus.close(); setRecentUndo(null); setRecentTagFilters([]); restoreRecentFocus.current = false; }, [menus, recentScope]);
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
  const identity = sidebarThreadIdentity;
  const preferredSectionRef = useRef<{ key: string; sectionId: string } | null>(null);
  const openRowConversation = useStableEvent((hostId: string, threadId: string, rowScope: string) => {
    preferredSectionRef.current = { key: JSON.stringify([hostId, threadId]), sectionId: rowScope };
    onSelectThread(hostId, threadId);
    dismiss?.();
  });
  const references = useMemo(() => threads.filter(thread => thread.visibility !== "hidden").map(thread => ({
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
    const taskFlow = { ...groupThreadsByTaskFlow(roots), mine: mineTree.roots.map(node => node.thread) };
    return { matching, matchingById, tree, matchingReferences, taskFlow };
  }, [threads, references, allowedKeys, needle, serverFilter.serverId]);
  const recentUnfiltered = useMemo(() => recentSidebarThreads(matching, recentPreferences, recentScope), [matching, recentPreferences, recentScope]);
  const existingRecentTags = useMemo(
    () => collectExistingConversationTags(recentUnfiltered, conversationTags, recentKey),
    [recentUnfiltered, conversationTags, recentScope],
  );
  const recent = useMemo(
    () => recentTagFilters.length === 0
      ? recentUnfiltered
      : recentUnfiltered.filter(thread => matchesConversationTagFilters(conversationTags[recentKey(thread)], recentTagFilters)),
    [recentUnfiltered, conversationTags, recentTagFilters, recentScope],
  );
  const toggleThreadTag = useStableEvent((thread: SidebarThread, tag: ConversationTagId) => {
    const scope = recentScope, epoch = scopeEpoch.current, key = recentKey(thread);
    void preferences.update("sidebar.conversationTags", current => {
      if (!alive.current || scopeRef.current !== scope || scopeEpoch.current !== epoch) return current;
      const next = toggleConversationTag(current[key], tag);
      const { [key]: _removed, ...rest } = current;
      return next.length === 0 ? rest : { ...rest, [key]: next };
    }).catch(() => {
      if (alive.current && scopeRef.current === scope && scopeEpoch.current === epoch) {
        notices.error({ key: "conversation-tag-update", message: text("conversation.tag.saveFailed", "Could not update tag. Try again.") });
      }
    });
  });
  const clearThreadTags = useStableEvent((thread: SidebarThread) => {
    const scope = recentScope, epoch = scopeEpoch.current, key = recentKey(thread);
    void preferences.update("sidebar.conversationTags", current => {
      if (!alive.current || scopeRef.current !== scope || scopeEpoch.current !== epoch) return current;
      const { [key]: _removed, ...rest } = current;
      return rest;
    }).catch(() => {
      if (alive.current && scopeRef.current === scope && scopeEpoch.current === epoch) {
        notices.error({ key: "conversation-tag-update", message: text("conversation.tag.saveFailed", "Could not update tag. Try again.") });
      }
    });
  });
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
  const onRecentAction = useStableEvent((thread: SidebarThread, action: RecentRowAction) => {
    const scope = recentScope, epoch = scopeEpoch.current, key = recentKey(thread);
    if (busyRecentRef.current.has(key)) return;
    busyRecentRef.current.add(key); setBusyRecent(new Set(busyRecentRef.current));
    if (action === "dismiss") restoreRecentFocus.current = document.activeElement instanceof Element
      && !!document.activeElement.closest('.sidebar-recent-row,[role="menu"]');
    menus.close();
    let previous: RecentConversationPreference | undefined;
    const pinnedAt = Date.now();
    void preferences.update("sidebar.recentConversations", current => {
      if (!alive.current || scopeRef.current !== scope || scopeEpoch.current !== epoch) return current;
      previous = current[key];
      const { [key]: removed, ...rest } = current;
      return action === "unpin" ? rest : { ...rest, [key]: action === "pin" ? { pinnedAt } : { dismissedAt: thread.updatedAt } };
    }).then(() => {
      if (alive.current && scopeRef.current === scope && scopeEpoch.current === epoch && action === "dismiss") setRecentUndo({ scope, key, dismissedAt: thread.updatedAt, previous });
    }).catch(() => {
      if (alive.current && scopeRef.current === scope && scopeEpoch.current === epoch) notices.error({ key: "recent-update", message: text("sidebar.recent.failed", "Could not update Recent. Try again.") });
    }).finally(() => {
      busyRecentRef.current.delete(key); if (alive.current) setBusyRecent(new Set(busyRecentRef.current));
    });
  });
  const undoRecent = () => {
    const undo = recentUndo;
    if (!undo || undo.scope !== recentScope || busyRecentRef.current.has(undo.key)) return;
    const epoch = scopeEpoch.current;
    busyRecentRef.current.add(undo.key); setBusyRecent(new Set(busyRecentRef.current));
    void preferences.update("sidebar.recentConversations", current => {
      if (!alive.current || scopeRef.current !== undo.scope || scopeEpoch.current !== epoch || current[undo.key]?.dismissedAt !== undo.dismissedAt) return current;
      const { [undo.key]: removed, ...rest } = current;
      return undo.previous ? { ...rest, [undo.key]: undo.previous } : rest;
    }).then(() => { if (alive.current && scopeRef.current === undo.scope && scopeEpoch.current === epoch) setRecentUndo(null); })
      .catch(() => { if (alive.current && scopeRef.current === undo.scope && scopeEpoch.current === epoch) notices.error({ key: "recent-update", message: text("sidebar.recent.failed", "Could not update Recent. Try again.") }); })
      .finally(() => { busyRecentRef.current.delete(undo.key); if (alive.current) setBusyRecent(new Set(busyRecentRef.current)); });
  };
  useLayoutEffect(() => {
    if (!restoreRecentFocus.current || recentUndo?.scope !== recentScope) return;
    restoreRecentFocus.current = false;
    if (document.activeElement === document.body || contentViewport.current?.contains(document.activeElement))
      contentViewport.current?.querySelector<HTMLButtonElement>(".sidebar-recent-feedback button")?.focus({ preventScroll: true });
  }, [recentUndo, recentScope]);
  const renderThreadContent = useCallback((thread: SidebarThread, attention: boolean, projectGrouped: boolean, rowScope: string) => {
    const pending = pendingHostId === thread.connectionHostId && pendingThreadId === thread.id;
    const active = activeHostId === thread.connectionHostId && activeThreadId === thread.id;
    const selected = pendingHostId !== null && pendingThreadId !== null ? pending : active;
    const title = pendingTitle?.(thread.connectionHostId, thread.id) ?? thread.title;
    const activityId = sidebarRowId(rowIdPrefix, rowScope, identity(thread));
    const instanceKey = thread.instanceGroup?.id ?? thread.connectionHostId;
    const context = rowScope === "recent" ? {
      device: preferenceState.values["sidebar.instanceNames"][JSON.stringify([props.instanceNameScope ?? "local", instanceKey])]
        ?? thread.instanceGroup?.name ?? thread.connectionHostLabel,
      folder: thread.nativeProject?.name ?? thread.directoryGroup?.name ?? thread.project,
      agent: thread.agent?.label,
    } : undefined;
    const disabled = thread.interactionAvailable === false;
    const capabilities = threadCapabilities?.(thread.connectionHostId, thread.id)
      ?? { rename: !!threadActions, archive: !!threadActions, fork: !!threadActions, delete: !!threadActions, pin: !!threadActions?.onSetPinned };
    const unread = Boolean(thread.unread) && (threadListGrouping?.isParticipant?.({
      hostId: thread.connectionHostId, threadId: thread.id, updatedAt: thread.updatedAt, pinned: thread.pinned,
    }) ?? true);
    return <SidebarParentRenderContext.Provider value={props}>
      <SidebarThreadPresentation tags={normalizeConversationTags(conversationTags[recentKey(thread)])} onToggleTag={toggleThreadTag} onClearTags={clearThreadTags} recentScope={recentScope} recent={rowScope === "recent"} recentPinned={rowScope === "recent" && isRecentPinned(thread)} recentBusy={busyRecent.has(recentKey(thread))} onRecentAction={onRecentAction} contextDevice={context?.device} contextFolder={context?.folder} projectGrouped={projectGrouped} thread={thread} attention={attention} pending={pending} active={active}
        selected={selected} title={title} unread={unread} activityId={activityId} disabled={disabled}
        rename={capabilities.rename} archive={capabilities.archive} fork={capabilities.fork}
        delete={capabilities.delete} pin={capabilities.pin} reference={capabilities.reference}
        threadBadge={threadBadge} threadListGrouping={threadListGrouping} grouping={grouping} menus={menus}
        actionOwner={actionOwner} presentationRoot={presentationRoot} rowScope={rowScope} openConversation={openRowConversation} />
    </SidebarParentRenderContext.Provider>;
  // Parent commits always reevaluate dynamic readers. Scalar row presentation
  // can reuse menu chrome while the badge still observes parent props updates.
  }, [props, actionOwner, grouping, presentationRoot, dismiss, menus, rowIdPrefix, openRowConversation, preferenceState, conversationTags, toggleThreadTag, clearThreadTags, busyRecent, onRecentAction, recentScope]);
  const renderThread = (thread: SidebarThread, attention: boolean, projectGrouped: boolean, rowScope: string) => <SidebarThreadContent
    key={identity(thread)} thread={thread} attention={attention} projectGrouped={projectGrouped} rowScope={rowScope} render={renderThreadContent} />;
  const renderTreeNode = (node: SidebarThreadTreeNode<SidebarThread>, attention: boolean, projectGrouped: boolean, rowScope: string): ReactNode => (
    <li key={identity(node.thread)} className="sidebar-thread-tree__node"
      data-row-scope={rowScope} data-thread-id={node.thread.id} data-host-id={node.thread.connectionHostId}>
      {renderThread(node.thread, attention, projectGrouped, rowScope)}
      {rowScope !== "recent" && node.children.length ? <ul className="sidebar-thread-tree__children" role="list">
        {node.children.map(child => renderTreeNode(child, attention, projectGrouped && (node.thread.nativeProject ? child.thread.nativeProject?.id === node.thread.nativeProject.id : child.thread.directoryGroup?.id === node.thread.directoryGroup?.id), rowScope))}
      </ul> : null}
    </li>
  );
  const renderThreadTree = (thread: SidebarThread, attention: boolean, projectGrouped: boolean, rowScope: string) => {
    if (rowScope === "recent") return <ul className="sidebar-thread-tree" role="list"><li className="sidebar-thread-tree__node"
      data-row-scope={rowScope} data-thread-id={thread.id} data-host-id={thread.connectionHostId}>
      {renderThread(thread, attention, projectGrouped, rowScope)}
    </li></ul>;
    const node = tree.nodes.get(identity(thread));
    return node ? <ul className="sidebar-thread-tree" role="list">{renderTreeNode(node, attention, projectGrouped, rowScope)}</ul> : null;
  };
  const renderFlowSection = (key: string, title: string, rows: readonly SidebarThread[], limit?: number, update?: (count: number) => void, nativeProject = false) => {
    if (!rows.length && key !== "mine" && (key !== "recent" || (matching.length === 0 && recentUndo?.scope !== recentScope && recentTagFilters.length === 0))) return null;
    const collapsed = folded[key] ?? false;
    const visible = limit === undefined ? rows : rows.slice(0, limit);
    const folderThread = nativeProject ? rows.find(thread => !!thread.cwd && thread.interactionAvailable !== false) ?? rows.find(thread => !!thread.cwd) : undefined;
    const newFolderChatLabel = intl.formatMessage({ id: "sidebar.folder.newChat", defaultMessage: "New chat in {folder}" }, { folder: title });
    const dates = key === "recent" ? sidebarActivityDateHeadings(visible.filter(thread => !isRecentPinned(thread)), Date.now(), intl.locale) : new Map<SidebarThread, string>();
    const hasRecentTagBar = key === "recent" && (existingRecentTags.length > 0 || recentTagFilters.length > 0);
    return <section key={key} className="sidebar-activity-group" aria-label={title} data-collapsed={collapsed} data-native-project={nativeProject || undefined}>
      {nativeProject ? <div className="sidebar-folder-heading">
        <h3 className="sidebar-thread-group-heading"><Button variant="ghost" size="navigation" contentLayout="row" className="sidebar-folder-toggle"
          aria-expanded={!collapsed} aria-controls={`${rowIdPrefix}-flow-${key}`}
          onClick={() => setFolded(current => ({ ...current, [key]: !collapsed }))}>
          <FolderIcon size={16} aria-hidden="true" /><span className="sidebar-thread-group-label">{title}</span>
          <ChevronDown size={12} className={collapsed ? "is-collapsed" : undefined} aria-hidden="true" />
        </Button></h3>
        {onNewTaskInFolder ? <IconButton variant="ghost" size="accessory" className="sidebar-folder-new-chat" aria-label={newFolderChatLabel} title={newFolderChatLabel}
          disabled={!folderThread || folderThread.interactionAvailable === false}
          onClick={() => {
            if (!folderThread?.cwd || folderThread.interactionAvailable === false) return;
            dismissAfter(() => onNewTaskInFolder({ hostId: folderThread.connectionHostId, cwd: folderThread.cwd! }));
          }}><AddIcon size={16} aria-hidden="true" /></IconButton> : null}
      </div> : hasRecentTagBar ? <div className="sidebar-recent-heading">
        <h3 className="sidebar-thread-group-heading"><button type="button" className="sidebar-thread-group-toggle" aria-expanded={!collapsed} aria-controls={`${rowIdPrefix}-flow-${key}`}
          onClick={() => setFolded(current => ({ ...current, [key]: !collapsed }))}>
          <span className="sidebar-thread-group-label">{title}</span><ChevronDown size={12} className={collapsed ? "is-collapsed" : undefined} />
        </button></h3>
        <Suspense fallback={null}>
          <SidebarRecentTagFilterBar
            tags={existingRecentTags}
            selectedTags={recentTagFilters}
            onToggleTag={tag => {
              setRecentTagFilters(current => {
                const next = toggleConversationTag(current, tag);
                if (next.length > 0 && collapsed) setFolded(prev => ({ ...prev, recent: false }));
                return next;
              });
            }}
            onClearAll={() => setRecentTagFilters([])}
          />
        </Suspense>
      </div> : <h3 className="sidebar-thread-group-heading"><button type="button" className="sidebar-thread-group-toggle" aria-expanded={!collapsed} aria-controls={`${rowIdPrefix}-flow-${key}`}
        onClick={() => setFolded(current => ({ ...current, [key]: !collapsed }))}>
        <span className="sidebar-thread-group-label">{title}</span><ChevronDown size={12} className={collapsed ? "is-collapsed" : undefined} />
      </button></h3>}
      <div className="sidebar-activity-group__items" id={`${rowIdPrefix}-flow-${key}`} hidden={collapsed}>
        {key === "recent" && recentUndo?.scope === recentScope ? <div className="sidebar-recent-feedback" role="status">
          <span>{text("sidebar.recent.removed", "Removed from Recent")}</span><Button size="sm" variant="ghost" disabled={busyRecent.has(recentUndo.key)} onClick={undoRecent}>{text("sidebar.recent.undo", "Undo")}</Button>
        </div> : null}
        {key === "recent" && !rows.length ? (
          recentTagFilters.length > 0 ? (
            <div className="sidebar-recent-feedback" role="status">
              <span>{text("sidebar.recent.noTaggedMatches", "No conversations with this tag")}</span>
              <Button size="sm" variant="ghost" onClick={() => setRecentTagFilters([])}>{text("sidebar.recent.showAll", "Show all")}</Button>
            </div>
          ) : <div className="sidebar-activity-empty">{text("sidebar.recent.empty", "No recent conversations")}</div>
        ) : null}
        {key === "mine" && !rows.length ? <div className="sidebar-activity-empty">{text("sidebar.access.empty", "No private conversations yet")}</div> : null}
        {visible.map(thread => <div key={identity(thread)}>
          {key === "recent" && thread === visible[0] && isRecentPinned(thread) ? <h4 className="sidebar-activity-group__heading">{text("sidebar.recent.pinned", "Pinned to top")}</h4> : null}
          {dates.has(thread) ? <h4 className="sidebar-activity-group__heading">{dates.get(thread)}</h4> : null}
          {renderThreadTree(thread, key === "attention", nativeProject, key)}
        </div>)}
        {limit !== undefined && update ? <SidebarPagination total={rows.length} visibleCount={limit}
          pageSize={nativeProject ? 6 : key === "pinned" ? PINNED_PAGE_SIZE : RECENT_PAGE_SIZE} onChange={update} pullToLoad={key === "recent"} /> : null}
      </div>
    </section>;
  };
  const nativeProjects = groupThreadsByNativeProject(taskFlow.recent);
  const instances = groupSidebarProjectsByInstance(nativeProjects);
  const multipleInstances = new Set(matching.map(thread=>thread.instanceGroup?.id ?? thread.connectionHostId ?? thread.serverOrigin.serverId)).size > 1;
  const instanceForProject = new Map(instances.flatMap(instance=>instance.projects.map(project=>[project.key,instance.key] as const)));
  const groupedSections = grouping.mode && threadListGrouping ? threadListGrouping.project(matchingReferences) : null;
  const visibleSections = [
    { id: "recent", collapsed: folded.recent ?? false,
      threads: recent.slice(0, recentLimit).map(thread => ({ hostId: thread.connectionHostId, threadId: thread.id })) },
    ...(groupedSections?.map(group => ({ ...group, id: `contribution:${group.id}` })) ?? Object.entries(taskFlow).filter(([id]) => id !== "mine" && id !== "recent").map(([id, rows]) => ({
      id, collapsed: folded[id] ?? false,
      threads: rows.slice(0, id === "pinned" ? pinnedLimit : id === "recent" ? recentLimit : rows.length)
        .map(thread => ({ hostId: thread.connectionHostId, threadId: thread.id })),
    }))),
    ...(!groupedSections ? nativeProjects.map(group => ({ id: `native-project:${group.key}`, collapsed: (folded[`native-project:${group.key}`] ?? false) || (multipleInstances && !!folded[`instance:${instanceForProject.get(group.key)}`]),
      threads: group.threads.slice(0, projectLimits[group.key] ?? 6).map(thread => ({ hostId: thread.connectionHostId, threadId: thread.id })) })) : []),
    { id: "mine", collapsed: folded.mine ?? false,
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
    const key = JSON.stringify([current.hostId, current.threadId]);
    const target = matchingById.get(key);
    const rootKey = tree.rootByIdentity.get(key) ?? key;
    const visible = target && visibleSections.some(group =>
      (group.id === "recent" || target.interactionAvailable !== false) && !group.collapsed && current.rowId === sidebarRowId(rowIdPrefix, group.id, key)
      && group.threads.some(ref => JSON.stringify([ref.hostId, ref.threadId]) === (group.id === "recent" ? key : rootKey)));
    if (!visible) menus.close();
  });
  const selectedKey = JSON.stringify(pendingHostId !== null && pendingThreadId !== null
    ? [pendingHostId, pendingThreadId] : [activeHostId, activeThreadId]);
  const selectedRootKey = tree.rootByIdentity.get(selectedKey) ?? selectedKey;
  const matchesSelectedGroup = (group: { id: string; collapsed: boolean; threads: readonly { hostId: string; threadId: string }[] }) =>
    !group.collapsed && group.threads.some(ref =>
      JSON.stringify([ref.hostId, ref.threadId]) === (group.id === "recent" ? selectedKey : selectedRootKey));
  const preferredSectionId = preferredSectionRef.current?.key === selectedKey ? preferredSectionRef.current.sectionId : null;
  const selectedSection = (preferredSectionId ? visibleSections.find(group => group.id === preferredSectionId && matchesSelectedGroup(group)) : undefined)
    ?? visibleSections.find(matchesSelectedGroup);
  const selectedSectionId = selectedSection?.id;
  const selectedVisible = selectedSection !== undefined && !selectedSection.collapsed;
  const previousSelection = useRef({
    key: selectedKey,
    pinnedLimit,
    recentLimit,
    mineLimit,
    recentPreferences,
    recentTagFilters,
    conversationTags,
  });
  useLayoutEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = {
      key: selectedKey,
      pinnedLimit,
      recentLimit,
      mineLimit,
      recentPreferences,
      recentTagFilters,
      conversationTags,
    };
    if (
      previous.key === selectedKey
      && (previous.recentPreferences !== recentPreferences
        || previous.recentTagFilters !== recentTagFilters
        || previous.conversationTags !== conversationTags)
    ) return;
    // Revealing more history is a reading action, not a new navigation intent.
    if (previous.key === selectedKey && (pinnedLimit > previous.pinnedLimit || recentLimit > previous.recentLimit || mineLimit > previous.mineLimit)) return;
    if (!selectedVisible) return;
    const content = contentViewport.current;
    const row = selectedSectionId ? document.getElementById(sidebarRowId(rowIdPrefix, selectedSectionId, selectedKey))?.closest<HTMLElement>(".sidebar-activity-item") : null;
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
    // A conversation can appear in both Recent and its Device/Project directory.
    // Never scroll away when an already-rendered selected row is in view.
    const alreadyInView = Array.from(content.querySelectorAll<HTMLElement>(".sidebar-activity-item.is-selected, .sidebar-activity-item.is-pending")).some(candidate => {
      const rect = candidate.getBoundingClientRect();
      return rect.height > 0 && rect.top >= top - 1 && rect.bottom <= bottom + 1;
    });
    if (alreadyInView) return;
    const item = row.getBoundingClientRect();
    if (item.top < top) viewport.scrollTop += item.top - top;
    else if (item.bottom > bottom) viewport.scrollTop += Math.min(item.bottom - bottom, item.top - top);
  }, [selectedKey, selectedSectionId, selectedVisible, pinnedLimit, recentLimit, mineLimit, recentPreferences, recentTagFilters, conversationTags]);
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
          {showNewChat ? <SidebarNewChatButton onNewTask={onNewTask} /> : null}
          <div className="sidebar-activity-list" ref={activityList}>
            {grouping.notice ? <div className="sidebar-activity-empty">{label(grouping.notice)}</div> : null}
            {groupedSections ? groupedSections.map(group => <section key={group.id} className="sidebar-activity-group" aria-label={label(group.label)} data-collapsed={group.collapsed}>
              <h3 className="sidebar-thread-group-heading"><button type="button" className="sidebar-thread-group-toggle" aria-expanded={!group.collapsed} aria-controls={`${rowIdPrefix}-group-${encodeURIComponent(group.id)}`} onClick={() => threadListGrouping?.toggleGroup(group.id)}>
                <span className="sidebar-thread-group-avatar" aria-hidden="true"><AvatarImage src={group.avatarUrl} fallback={<UserRound size={14} />} /></span>
                <span className="sidebar-thread-group-label">{label(group.label)}</span><ChevronDown size={12} className={group.collapsed ? "is-collapsed" : undefined} />
              </button></h3>
              <div className="sidebar-activity-group__items" id={`${rowIdPrefix}-group-${encodeURIComponent(group.id)}`} hidden={group.collapsed}>
                {!group.collapsed && group.threads.map(ref => { const thread = matchingById.get(JSON.stringify([ref.hostId, ref.threadId])); return thread ? <div key={identity(thread)}>{renderThreadTree(thread, false, false, `contribution:${group.id}`)}</div> : null; })}
              </div>
            </section>) : <>
              {renderFlowSection("attention", text("sidebar.flow.attention", "Needs your attention"), taskFlow.attention)}
              {renderFlowSection("pinned", text("sidebar.flow.pinned", "Pinned"), taskFlow.pinned, pinnedLimit, setPinnedLimit)}
            </>}
            {renderFlowSection("mine", text("sidebar.access.mine", "Mine"), taskFlow.mine, mineLimit, setMineLimit)}
            {renderFlowSection("recent", text("sidebar.flow.recent", "Recent"), recent, recentLimit, setRecentLimit)}
            {!groupedSections && nativeProjects.length ? <div className="sidebar-native-projects">
              <h3 className="sidebar-native-projects__title">{multipleInstances ? text("sidebar.instances", "Devices") : text("sidebar.nativeProjects", "Projects")}</h3>
              {instances.map(instance => {
                const projects=instance.projects.map(group => renderFlowSection(`native-project:${group.key}`, group.label, group.threads, projectLimits[group.key] ?? 6,
                  count => setProjectLimits(current => ({ ...current, [group.key]: count })), true));
                if(!multipleInstances)return <div key={instance.key}>{projects}</div>;
                const key=`instance:${instance.key}`,collapsed=folded[key] ?? false;
                return <section key={key} className="sidebar-instance-group" data-instance-id={instance.key}>
                  <SidebarInstanceHeading key={JSON.stringify([props.instanceNameScope ?? "local",instance.key])}
                    name={preferenceState.values["sidebar.instanceNames"][JSON.stringify([props.instanceNameScope ?? "local",instance.key])] ?? instance.label}
                    collapsed={collapsed} controls={`${rowIdPrefix}-${encodeURIComponent(key)}`}
                    onToggle={()=>setFolded(current=>({...current,[key]:!collapsed}))}
                    onRename={name=>preferences.update("sidebar.instanceNames",current=>({...current,[JSON.stringify([props.instanceNameScope ?? "local",instance.key])]:name}))}/>

                  <div className="sidebar-instance-group__projects" id={`${rowIdPrefix}-${encodeURIComponent(key)}`} hidden={collapsed}>{projects}</div>
                </section>;
              })}
            </div> : null}
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
      {footerAccessory}
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
  const button = <Button type="button" size="navigation" variant="ghost" contentLayout="row"
    surface={shell?.mobileSidebar ? "floating" : "integrated"}
    className="sidebar-new-chat shell-sidebar-primary-action" title={`${intl.formatMessage({ id: "sidebar.newChat", defaultMessage: "New chat" })} (${shortcutLabel("newChat")})`} aria-keyshortcuts={shortcutAria("newChat")} onClick={() => {
    onNewTask();
    shell?.dismissSidebarAfterSelection();
  }}><SquarePen size={16} aria-hidden="true" /><span>{intl.formatMessage({ id: "sidebar.newChat", defaultMessage: "New chat" })}</span></Button>;

  return shell?.mobileSidebar
    ? shell.sidebarActionHost ? createPortal(button, shell.sidebarActionHost) : null
    : button;
}
