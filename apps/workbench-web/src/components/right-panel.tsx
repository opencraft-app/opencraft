import { AddIcon as Plus, TerminalIcon as TerminalSquare, CloseIcon as X, CheckIcon as Check, ChevronDownIcon as ChevronDown } from "@opencraft/design-system-web/action-icons";
import { useWorkbenchPresentationActive } from "./workbench-presentation-activity";
import { useIntl } from "@opencraft/i18n/react";
import type { IntlShape } from "@opencraft/i18n";
import { WorkbenchIcon } from "./ui/workbench-icon";
import type {
  PanelAction,
  PanelToolbarActionContext,
  PanelToolbarActionDefinition,
  PanelTabDescriptor,
  ConversationPanelState,
} from "@opencraft/workbench-panels";

import type { PanelRendererRegistration } from "@opencraft/workbench-panels-react";
import { CodeFileIcon as FileCode2, GlobeIcon as Globe2, MonitorIcon as Monitor, BranchIcon as GitBranch, ExpandIcon as Maximize2, CollapseIcon as Minimize2, MessageIcon as MessageSquare } from "@opencraft/design-system-web/action-icons";
import {
  DndContext,
  closestCenter,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { motion, useTransform } from "motion/react";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAppShellLayoutMotion } from "./app-shell";
import { useShellPresentation } from "./shell-presentation";
import { PanelPresentationContext } from "./panel-presentation";
import {
  reorderPanelTabPreview,
  resolvePanelTabCommit,
  RIGHT_PANEL_TAB_DROP_TAIL_ID,
} from "./right-panel-tab-drag";

function panelTitle(tab: PanelTabDescriptor, intl: IntlShape): string {
  if (tab.kind === "cloud-desktop") return intl.formatMessage({ id: "panel.desktopEntry", defaultMessage: "Cloud computer" });
  return tab.kind === "browser" && tab.title === "New tab"
    ? intl.formatMessage({ id: "panel.newTab", defaultMessage: "New tab" }) : tab.title;
}

interface RightPanelProps {
  /** Host supplies container geometry; this view retains the full toolbar and renderer residency. */
  readonly hostPresentationActive?: boolean;
  readonly emptyHint?: string;
  readonly state: ConversationPanelState;
  readonly presentationId: string;
  readonly renderers: readonly PanelRendererRegistration[];
  onAction(action: PanelAction): void;
  onCloseTab(tab: PanelTabDescriptor): void;
  readonly toolbarActions: readonly PanelToolbarActionDefinition[];
  readonly toolbarActionContext: PanelToolbarActionContext;
  readonly portalContainer?: HTMLElement | null;
}

function ToolbarActionIcon({ icon }: { readonly icon: string }) {
  return <WorkbenchIcon name={icon} purpose="panel" />;
}

function PanelToolbarAction({
  action,
  context,
  launcher = false,
}: {
  action: PanelToolbarActionDefinition;
  context: PanelToolbarActionContext;
  launcher?: boolean;
}) {
  const intl = useIntl();
  const [error, setError] = useState<string | null>(null);
  const run = (
    operation: (context: PanelToolbarActionContext) => void | Promise<void>,
  ) => {
    setError(null);
    void Promise.resolve()
      .then(() => operation(context))
      .catch(() => {
        setError(intl.formatMessage({ id: "panel.actionFailed", defaultMessage: "Could not open the preview. Try again." }));
        window.dispatchEvent(new CustomEvent("opencraft-panel-action-failed"));
      });
  };
  const trigger = (
    <button
      className={launcher ? "right-panel-launcher-action" : "chrome-button"}
      type="button"
      aria-label={action.label}
      title={action.label}
      onClick={() => run(action.run)}
    >
      <ToolbarActionIcon icon={action.icon} />
      {launcher ? <span>{action.creationLabel}</span> : null}
    </button>
  );
  return (
    <>
      {trigger}
      {error ? (
        <span role="alert" className="panel-toolbar-error">
          {error}
        </span>
      ) : null}
    </>
  );
}

function PanelCreationMenu({
  actions,
  context,
  tabs,
  activeTabId,
  onActivateTab,
  portalContainer,
}: {
  actions: readonly PanelToolbarActionDefinition[];
  context: PanelToolbarActionContext;
  /** Present only for the tab-bar-wide menu; + keeps its creation-only menu. */
  tabs?: readonly PanelTabDescriptor[];
  activeTabId?: string | null;
  onActivateTab?: (tabId: string) => void;
  portalContainer?: HTMLElement | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const intl = useIntl();
  const menuLabel = intl.formatMessage(tabs ? { id: "panel.tabs", defaultMessage: "Tabs" } : { id: "panel.newTab", defaultMessage: "New tab" });
  const pending = useRef<(() => void | Promise<void>) | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = null; }; }, []);
  return (
    <>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="chrome-button right-panel-new-tab"
            aria-label={menuLabel} title={menuLabel}>
            {tabs ? <ChevronDown size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={portalContainer}>
          <DropdownMenu.Content className="right-panel-creation-menu" align="start" sideOffset={6}
            aria-label={menuLabel}
            onCloseAutoFocus={(event) => {
              const operation = pending.current;
              pending.current = null;
              if (!operation || !mounted.current) return;
              event.preventDefault();
              setError(null);
              void Promise.resolve()
                .then(() => { if (mounted.current) return operation(); })
                .catch(() => {
                  if (!mounted.current) return;
                  setError(intl.formatMessage({ id: "panel.actionFailed", defaultMessage: "Could not open the preview. Try again." }));
                  window.dispatchEvent(new CustomEvent("opencraft-panel-action-failed"));
                });
            }}>
            {tabs ? <DropdownMenu.Label className="app-shell-toolbar-menu__title">{intl.formatMessage({ id: "panel.newTab", defaultMessage: "New tab" })}</DropdownMenu.Label> : null}
            {actions.length === 0 ? <DropdownMenu.Item disabled>No types available</DropdownMenu.Item> : actions.map(action => (
              <DropdownMenu.Item key={action.id} className="right-panel-creation-menu__item"
                onSelect={() => { pending.current = () => action.run(context); }}>
                <ToolbarActionIcon icon={action.icon} />
                <span>{tabs ? action.label : action.creationLabel}</span>
              </DropdownMenu.Item>
            ))}
            {tabs ? <>
              <DropdownMenu.Separator className="right-panel-tab-menu__separator" />
              <DropdownMenu.Label className="app-shell-toolbar-menu__title">{intl.formatMessage({ id: "panel.openTabs", defaultMessage: "Open tabs" })}</DropdownMenu.Label>
              <DropdownMenu.RadioGroup value={activeTabId ?? ""}>
                {tabs.length === 0 ? <DropdownMenu.Item className="right-panel-creation-menu__item" disabled>{intl.formatMessage({ id: "panel.noTabs", defaultMessage: "No open tabs" })}</DropdownMenu.Item> : tabs.map((tab, index) => (
                  <DropdownMenu.RadioItem key={tab.id} value={tab.id} textValue={panelTitle(tab, intl)}
                    className="app-shell-toolbar-menu__item" onSelect={() => {
                      if (tab.id !== activeTabId) pending.current = () => onActivateTab?.(tab.id);
                    }}>
                    <span className="app-shell-toolbar-menu__item-content"><PanelIcon tab={tab} /><span>{panelTitle(tab, intl)}</span></span>
                    {tabs.filter(other => other.title === tab.title).length > 1 ? <span className="right-panel-tab-menu__ordinal">{index + 1}</span> : null}
                    <DropdownMenu.ItemIndicator><Check size={14} aria-hidden="true" /></DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </> : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {error ? <span role="alert" className="panel-toolbar-error">{error}</span> : null}
    </>
  );
}

function PanelIcon({ tab }: { readonly tab: PanelTabDescriptor }) {
  if (tab.showTabIcon !== true || tab.icon === undefined) return null;
  if (tab.icon === "chat") return <MessageSquare size={13} />;
  if (tab.icon === "changes") return <GitBranch size={13} />;
  if (tab.icon === "terminal") return <TerminalSquare size={13} />;
  if (tab.icon === "browser") return <Globe2 size={13} />;
  if (tab.icon === "desktop") return <Monitor size={13} />;
  return <FileCode2 size={13} />;
}

interface DraggedPanelTab {
  readonly presentationId: string;
  readonly ownerId: string;
  readonly id: string;
  readonly tab: PanelTabDescriptor;
  readonly width: number | null;
  readonly initialTabIds: readonly string[];
}

const panelTabCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

function SortablePanelTab({
  tab,
  active,
  dragging,
  dragActive,
  onActivate,
  onClose,
}: {
  readonly tab: PanelTabDescriptor;
  readonly active: boolean;
  readonly dragging: boolean;
  readonly dragActive: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
}) {
  const intl = useIntl();
  const title = panelTitle(tab, intl);
  const closeLabel = intl.formatMessage({ id: "panel.closeTab", defaultMessage: "Close {title}" }, { title });
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: tab.id, data: { panelRegion: tab.region } });

  return (
    <div
      ref={setNodeRef}
      className="right-panel-tab"
      data-active={active}
      data-preview={tab.preview}
      data-dragging={dragging}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      role="presentation"
    >
      {active && !dragActive ? (
        <span className="right-panel-tab__visor" />
      ) : null}
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        className="right-panel-tab__activate"
        type="button"
        role="tab"
        aria-controls={`right-panel-view-${tab.id}`}
        aria-selected={active}
        onClick={onActivate}
        onMouseDown={(event) => {
          if (event.button === 1 && tab.closable) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <PanelIcon tab={tab} />
        <span>{title}</span>
      </button>
      {tab.closable ? (
        <button
          className="right-panel-tab__close"
          type="button"
          aria-label={closeLabel}
          title={closeLabel}
          tabIndex={active ? 0 : -1}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

function PanelTabDropTail({ region }: { region: "right" | "bottom" }) {
  const { setNodeRef } = useDroppable({ id: `${region}:${RIGHT_PANEL_TAB_DROP_TAIL_ID}`, data: { panelRegion: region, panelTail: true } });
  return <div ref={setNodeRef} className="right-panel-tab-strip__drop-tail" />;
}

function DraggedPanelTabOverlay({
  dragged,
  active,
}: {
  readonly dragged: DraggedPanelTab;
  readonly active: boolean;
}) {
  const intl = useIntl();
  return (
    <div
      className="right-panel-tab right-panel-tab--drag-overlay"
      data-active={active}
      data-preview={dragged.tab.preview}
      style={dragged.width === null ? undefined : { width: dragged.width }}
    >
      {active ? <span className="right-panel-tab__visor" /> : null}
      <div className="right-panel-tab__activate" role="presentation">
        <PanelIcon tab={dragged.tab} />
        <span>{panelTitle(dragged.tab, intl)}</span>
      </div>
      {dragged.tab.closable ? (
        <span className="right-panel-tab__close right-panel-tab__close--overlay">
          <X size={12} />
        </span>
      ) : null}
    </div>
  );
}

export function RightPanel({
  hostPresentationActive,
  emptyHint,
  state,
  presentationId,
  renderers,
  onAction,
  onCloseTab,
  toolbarActions,
  toolbarActionContext,
  portalContainer,
}: RightPanelProps) {
  const intl = useIntl();
  const region = "right" as const;
  const regionState = state[region];
  const presentation = useShellPresentation();
  const fullWidth = hostPresentationActive === undefined
    ? presentation?.rightPanelFullWidth ?? state.rightPanelFullWidth
    : state.rightPanelFullWidth;
  const autoFullWidth = fullWidth && !state.rightPanelFullWidth;
  const { headerRightWidth, rightPanelTabBarLeftInset, rightPanelPresentationActive: shellPanelActive } =
    useAppShellLayoutMotion();
  const rightPanelPresentationActive = hostPresentationActive ?? shellPanelActive;
  const headerRightWidthPx = useTransform(
    headerRightWidth,
    (width) => `${Math.max(0, width)}px`,
  );
  const tabBarLeftInsetPx = useTransform(
    rightPanelTabBarLeftInset,
    (width) => `${Math.max(0, width)}px`,
  );
  const stripRef = useRef<HTMLDivElement | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const [draggedTab, setDraggedTab] = useState<DraggedPanelTab | null>(null);
  const [previewTabIds, setPreviewTabIds] = useState<readonly string[] | null>(
    null,
  );
  const previewTabIdsRef = useRef<readonly string[] | null>(null);
  const committedTabIds = useMemo(
    () => regionState.tabs.map((tab) => tab.id),
    [regionState.tabs],
  );
  const presentedTabs = useMemo(() => {
    if (previewTabIds === null) return regionState.tabs;
    const byId = new Map(regionState.tabs.map((tab) => [tab.id, tab]));
    return previewTabIds.flatMap((id) => {
      const tab = byId.get(id);
      return tab === undefined ? [] : [tab];
    });
  }, [previewTabIds, regionState.tabs]);
  const draggedTabId = draggedTab?.id ?? null;
  const activeTab =
    regionState.tabs.find((tab) => tab.id === regionState.activeTabId) ?? null;
  const creationActions = toolbarActions.filter(
    (action) =>
      action.region === region &&
      action.creationLabel !== undefined &&
      (action.isAvailable?.(toolbarActionContext) ?? true),
  );
  const ActivePanel =
    activeTab === null
      ? null
      : (renderers.find((renderer) => renderer.kind === activeTab.kind)
          ?.Component ?? null);
  const activeRegistration = renderers.find(renderer => renderer.kind === activeTab?.kind);
  const presentationActive = useWorkbenchPresentationActive();
  const interactive = presentationActive && (hostPresentationActive ?? presentation?.rightPanelOpen ?? regionState.open);
  const residentTabs = regionState.tabs.flatMap(tab => {
    const registration = renderers.find(renderer => renderer.kind === tab.kind);
    return registration?.residency === "while-tab-open" ? [{ tab, Component: registration.Component }] : [];
  });
  const closeTab = (tab: PanelTabDescriptor) => {
    onCloseTab(tab);
  };

  useEffect(() => {
    const strip = stripRef.current;
    if (
      strip !== null &&
      Math.abs(strip.scrollLeft - regionState.scrollOffset) > 1
    ) {
      strip.scrollLeft = regionState.scrollOffset;
    }
  }, [regionState.scrollOffset, state.ownerId]);

  useEffect(() => {
    setDraggedTab(null);
    setPreviewTabIds(null);
    previewTabIdsRef.current = null;
  }, [presentationId, state.ownerId]);

  useEffect(() => {
    if (
      draggedTab === null ||
      (draggedTab.initialTabIds.length === committedTabIds.length &&
        draggedTab.initialTabIds.every(
          (id, index) => id === committedTabIds[index],
        ))
    ) {
      return;
    }
    // A tab was opened, closed, or externally reordered while this pointer
    // transaction was active. Its preview no longer describes the committed
    // collection, so cancel it instead of committing against a new identity set.
    setDraggedTab(null);
    setPreviewTabIds(null);
    previewTabIdsRef.current = null;
  }, [committedTabIds, draggedTab]);

  const resetDrag = () => {
    setDraggedTab(null);
    setPreviewTabIds(null);
    previewTabIdsRef.current = null;
  };
  const updatePreview = (event: DragOverEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over === null ? null : event.over.data.current?.panelTail ? RIGHT_PANEL_TAB_DROP_TAIL_ID : String(event.over.id);
    if (overId === null) return;
    const next = reorderPanelTabPreview(
      previewTabIdsRef.current ?? committedTabIds,
      activeId,
      overId,
    );
    previewTabIdsRef.current = next;
    setPreviewTabIds(next);
  };
  const startDrag = (event: DragStartEvent) => {
    const id = String(event.active.id);
    const tab = regionState.tabs.find((candidate) => candidate.id === id);
    if (tab === undefined) return;
    previewTabIdsRef.current = committedTabIds;
    setPreviewTabIds(committedTabIds);
    setDraggedTab({
      presentationId,
      ownerId: state.ownerId,
      id,
      tab,
      width: event.active.rect.current.initial?.width ?? null,
      initialTabIds: committedTabIds,
    });
  };
  const finishDrag = (event: DragEndEvent) => {
    if (draggedTab?.presentationId !== presentationId || draggedTab.ownerId !== state.ownerId) { resetDrag(); return; }
    const activeId = String(event.active.id);
    if (event.over !== null) {
      const finalPreview =
        previewTabIdsRef.current ??
        reorderPanelTabPreview(
          committedTabIds,
          activeId,
          event.over.data.current?.panelTail ? RIGHT_PANEL_TAB_DROP_TAIL_ID : String(event.over.id),
        );
      const commit = resolvePanelTabCommit(
        committedTabIds,
        finalPreview,
        activeId,
      );
      if (commit !== null) {
        onAction({ type: "move-tab", region, ...commit });
      }
    }
    resetDrag();
  };

  return (
    <PanelPresentationContext.Provider value={{ region, active: rightPanelPresentationActive }}>
    <DndContext
      sensors={sensors}
      collisionDetection={panelTabCollisionDetection}
      onDragStart={startDrag}
      onDragOver={updatePreview}
      onDragCancel={resetDrag}
      onDragEnd={finishDrag}
    >
      <div className="right-panel-content" data-app-shell-tabs="true" data-panel-region={region}>
        <header className="right-panel-toolbar">
          <motion.div
            aria-hidden="true"
            className="right-panel-header-start-spacer"
            style={{ width: hostPresentationActive === undefined ? tabBarLeftInsetPx : 0 }}
          />
          <div
            ref={stripRef}
            className="right-panel-tab-strip"
            role="tablist"
            aria-label={intl.formatMessage({ id: "panel.tabList", defaultMessage: "Preview tabs" })}
            onScroll={(event) =>
              onAction({
                type: "set-scroll-offset",
                region,
                offset: event.currentTarget.scrollLeft,
              })
            }
          >
            <SortableContext
              items={presentedTabs.map((tab) => tab.id)}
              strategy={horizontalListSortingStrategy}
            >
              {presentedTabs.map((tab) => {
                const active = tab.id === regionState.activeTabId;
                return (
                  <SortablePanelTab
                    key={tab.id}
                    tab={tab}
                    active={active}
                    dragging={draggedTabId === tab.id}
                    dragActive={draggedTabId !== null}
                    onActivate={() =>
                      onAction({
                        type: "activate-tab",
                        region,
                        tabId: tab.id,
                      })
                    }
                    onClose={() => closeTab(tab)}
                  />
                );
              })}
            </SortableContext>
            <PanelTabDropTail region={region} />
          </div>
          <div className="right-panel-toolbar__tab-actions">
            {regionState.tabs.length > 0 ? (
              <PanelCreationMenu
                key={state.ownerId}
                actions={creationActions}
                context={toolbarActionContext}
                portalContainer={portalContainer}
              />
            ) : null}
            <PanelCreationMenu
              key={`${state.ownerId}:tabs`}
              actions={creationActions}
              context={toolbarActionContext}
              tabs={regionState.tabs}
              activeTabId={regionState.activeTabId}
              onActivateTab={tabId => onAction({ type: "activate-tab", region, tabId })}
              portalContainer={portalContainer}
            />
          </div>
          <div className="right-panel-toolbar__actions">
            {toolbarActions
              .filter(
                (action) =>
                  action.region === region &&
                  action.creationLabel === undefined &&
                  (action.isAvailable?.(toolbarActionContext) ?? true),
              )
              .map((action) => (
                <PanelToolbarAction
                  key={`${state.ownerId}:${action.id}`}
                  action={action}
                  context={toolbarActionContext}
                />
              ))}
            {autoFullWidth ? null : <button
              className="chrome-button"
              type="button"
              title={
                intl.formatMessage(fullWidth ? { id: "panel.restore", defaultMessage: "Restore panel" } : { id: "panel.maximize", defaultMessage: "Maximize panel" })
              }
              onClick={() => onAction({ type: "toggle-right-full-width" })}
              aria-label={
                intl.formatMessage(fullWidth ? { id: "panel.restore", defaultMessage: "Restore panel" } : { id: "panel.maximize", defaultMessage: "Maximize panel" })
              }
              aria-pressed={fullWidth}
            >
              {fullWidth ? (
                <Minimize2 size={14} />
              ) : (
                <Maximize2 size={14} />
              )}
            </button>}
            <motion.div
              aria-hidden="true"
              className="right-panel-header-action-spacer"
              data-testid="right-panel-tab-bar-header-spacer"
              style={{ width: hostPresentationActive === undefined ? headerRightWidthPx : 0 }}
            />
          </div>
        </header>

        <div
          className="right-panel-view"
          data-app-shell-content-plane="preview"
          id={
            activeTab === null ? undefined : `right-panel-view-${activeTab.id}`
          }
          role="tabpanel"
        >
          {activeTab === null ? (
            <div
              className="right-panel-launcher"
              role="group"
              aria-label={intl.formatMessage({ id: "panel.open", defaultMessage: "Open preview panel" })}
            >
              {emptyHint ? <p>{emptyHint}</p> : null}
              {creationActions.length > 0 ? (
                creationActions.map((action) => (
                  <PanelToolbarAction
                    key={action.id}
                    action={action}
                    context={toolbarActionContext}
                    launcher
                  />
                ))
              ) : (
                <p>{intl.formatMessage({ id: "panel.noActions", defaultMessage: "No previews available for this connection." })}</p>
              )}
            </div>
          ) : ActivePanel === null ? (
            <div className="right-panel-empty">
              <strong>{intl.formatMessage({ id: "panel.unavailable", defaultMessage: "{title} is unavailable" }, { title: activeTab.title })}</strong>
              <p>{intl.formatMessage({ id: "panel.unavailableHint", defaultMessage: "This content cannot be previewed here." })}</p>
            </div>
          ) : activeRegistration?.residency === "while-tab-open" || !rightPanelPresentationActive ? null : (
            <ActivePanel
              key={activeTab.id}
              tab={activeTab}
              ownerId={state.ownerId}
              presentationId={presentationId}
              active={interactive}
            />
          )}
          {residentTabs.map(({ tab, Component }) => <div key={`${state.ownerId}:${tab.id}`}
            className="right-panel-resident" hidden={tab.id !== activeTab?.id}
            inert={!interactive || tab.id !== activeTab?.id || undefined}>
            <Component tab={tab} ownerId={state.ownerId} presentationId={presentationId}
              active={interactive && tab.id === activeTab?.id} />
          </div>)}
        </div>
      </div>
      {typeof document === "undefined"
        ? null
        : createPortal(
            <>
              {draggedTab === null ? null : (
                <div
                  className="right-panel-tab-drag-cursor"
                  aria-hidden="true"
                />
              )}
              <DragOverlay adjustScale={false} zIndex={2_147_483_647}>
                {draggedTab === null ? null : (
                  <DraggedPanelTabOverlay
                    dragged={draggedTab}
                    active={draggedTab.id === regionState.activeTabId}
                  />
                )}
              </DragOverlay>
            </>,
            portalContainer ?? document.body,
          )}
    </DndContext>
    </PanelPresentationContext.Provider>
  );
}
