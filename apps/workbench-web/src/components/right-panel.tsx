import type {
  PanelAction,
  PanelToolbarActionContext,
  PanelToolbarActionDefinition,
  PanelTabDescriptor,
  ConversationPanelState,
} from "@opencraft/workbench-panels";
import type { PanelRendererRegistration } from "@opencraft/workbench-panels-react";
import {
  FileCode2,
  Globe2,
  GitBranch,
  Maximize2,
  Minimize2,
  Plus,
  TerminalSquare,
  X,
} from "lucide-react";
import { motion, useTransform } from "motion/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useRef, useState } from "react";

import { useAppShellLayoutMotion } from "./app-shell";

interface RightPanelProps {
  readonly state: ConversationPanelState;
  readonly presentationId: string;
  readonly renderers: readonly PanelRendererRegistration[];
  onAction(action: PanelAction): void;
  onCloseTab(tab: PanelTabDescriptor): void;
  readonly toolbarActions: readonly PanelToolbarActionDefinition[];
  readonly toolbarActionContext: PanelToolbarActionContext;
}

function ToolbarActionIcon({ icon }: { readonly icon: string }) {
  if (icon === "terminal") return <TerminalSquare size={14} />;
  if (icon === "browser") return <Globe2 size={14} />;
  return <Plus size={14} />;
}

function PanelToolbarAction({ action, context, launcher = false }: {
  action: PanelToolbarActionDefinition;
  context: PanelToolbarActionContext;
  launcher?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const run = (operation: (context: PanelToolbarActionContext) => void | Promise<void>) => {
    setError(null);
    void Promise.resolve().then(() => operation(context)).catch(cause => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  const trigger = <button className={launcher ? "right-panel-launcher-action" : "chrome-button"} type="button" aria-label={action.label}
    title={action.label} onClick={() => run(action.run)}>
    <ToolbarActionIcon icon={action.icon} />
    {launcher ? <span>{action.creationLabel}</span> : null}
  </button>;
  return <>
    {trigger}
    {error ? <span role="alert" className="panel-toolbar-error">{error}</span> : null}
  </>;
}

function PanelCreationMenu({ actions, context }: {
  actions: readonly PanelToolbarActionDefinition[];
  context: PanelToolbarActionContext;
}) {
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<PanelToolbarActionDefinition | null>(null);
  return <>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="chrome-button right-panel-new-tab"
          aria-label="New tab" title="New tab"><Plus size={14} /></button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="right-panel-creation-menu" align="start" sideOffset={6}
          onCloseAutoFocus={event => {
            const action = pending.current;
            pending.current = null;
            if (!action) return;
            // Close the picker before handing focus to the newly opened panel.
            event.preventDefault();
            setError(null);
            void Promise.resolve().then(() => action.run(context)).catch(cause => {
              setError(cause instanceof Error ? cause.message : String(cause));
            });
          }}>
          {actions.length === 0 ? <DropdownMenu.Item disabled>No types available</DropdownMenu.Item> :
            actions.map(action => <DropdownMenu.Item key={action.id}
              className="right-panel-creation-menu__item" onSelect={() => { pending.current = action; }}>
              <ToolbarActionIcon icon={action.icon} /><span>{action.creationLabel}</span>
            </DropdownMenu.Item>)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    {error ? <span role="alert" className="panel-toolbar-error">{error}</span> : null}
  </>;
}

function PanelIcon({ tab }: { readonly tab: PanelTabDescriptor }) {
  if (tab.icon === "changes") return <GitBranch size={13} />;
  if (tab.icon === "terminal") return <TerminalSquare size={13} />;
  if (tab.icon === "browser") return <Globe2 size={13} />;
  return <FileCode2 size={13} />;
}

export function RightPanel({
  state,
  presentationId,
  renderers,
  onAction,
  onCloseTab,
  toolbarActions,
  toolbarActionContext,
}: RightPanelProps) {
  const { headerRightWidth, rightPanelTabBarLeftInset } =
    useAppShellLayoutMotion();
  const headerRightWidthPx = useTransform(
    headerRightWidth,
    (width) => `${Math.max(0, width)}px`,
  );
  const tabBarLeftInsetPx = useTransform(
    rightPanelTabBarLeftInset,
    (width) => `${Math.max(0, width)}px`,
  );
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const activeTab =
    state.right.tabs.find((tab) => tab.id === state.right.activeTabId) ?? null;
  const creationActions = toolbarActions.filter(action =>
    action.region === "right" && action.creationLabel !== undefined &&
    (action.isAvailable?.(toolbarActionContext) ?? true));
  const ActivePanel =
    activeTab === null
      ? null
      : (renderers.find((renderer) => renderer.kind === activeTab.kind)
          ?.Component ?? null);
  const closeTab = (tab: PanelTabDescriptor) => {
    onCloseTab(tab);
  };

  useEffect(() => {
    const strip = stripRef.current;
    if (
      strip !== null &&
      Math.abs(strip.scrollLeft - state.right.scrollOffset) > 1
    ) {
      strip.scrollLeft = state.right.scrollOffset;
    }
  }, [state.right.scrollOffset, state.ownerId]);

  return (
    <div className="right-panel-content" data-app-shell-tabs="true">
      <header className="right-panel-toolbar">
        <motion.div
          aria-hidden="true"
          className="right-panel-header-start-spacer"
          style={{ width: tabBarLeftInsetPx }}
        />
        <div
          ref={stripRef}
          className="right-panel-tab-strip"
          role="tablist"
          aria-label="Task panels"
          onScroll={(event) =>
            onAction({
              type: "set-scroll-offset",
              region: "right",
              offset: event.currentTarget.scrollLeft,
            })
          }
        >
          {state.right.tabs.map((tab) => {
            const active = tab.id === state.right.activeTabId;
            return (
              <motion.div
                className="right-panel-tab"
                data-active={active}
                data-preview={tab.preview}
                data-dragging={draggedTabId === tab.id}
                draggable
                key={tab.id}
                layout="position"
                transition={{
                  layout: { duration: 0.1, ease: [0.23, 1, 0.32, 1] },
                }}
                role="presentation"
                onDragEndCapture={() => setDraggedTabId(null)}
                onDragOver={(event) => {
                  if (draggedTabId !== null && draggedTabId !== tab.id)
                    event.preventDefault();
                }}
                onDragEnter={() => {
                  if (draggedTabId !== null && draggedTabId !== tab.id) {
                    onAction({
                      type: "move-tab",
                      region: "right",
                      tabId: draggedTabId,
                      beforeTabId: tab.id,
                    });
                  }
                }}
                onDragStartCapture={(event) => {
                  event.stopPropagation();
                  setDraggedTabId(tab.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", tab.id);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const tabId =
                    draggedTabId ?? event.dataTransfer.getData("text/plain");
                  if (tabId !== "" && tabId !== tab.id) {
                    onAction({
                      type: "move-tab",
                      region: "right",
                      tabId,
                      beforeTabId: tab.id,
                    });
                  }
                  setDraggedTabId(null);
                }}
              >
                {active ? (
                  <motion.span
                    className="right-panel-tab__visor"
                    layoutId={`right-panel-active-tab:${state.ownerId}`}
                    transition={{ duration: 0.1, ease: [0.23, 1, 0.32, 1] }}
                  />
                ) : null}
                <button
                  className="right-panel-tab__activate"
                  type="button"
                  role="tab"
                  aria-controls={`right-panel-view-${tab.id}`}
                  aria-selected={active}
                  onClick={() =>
                    onAction({
                      type: "activate-tab",
                      region: "right",
                      tabId: tab.id,
                    })
                  }
                  onMouseDown={(event) => {
                    if (event.button === 1 && tab.closable) {
                      event.preventDefault();
                      closeTab(tab);
                    }
                  }}
                >
                  <PanelIcon tab={tab} />
                  <span>{tab.title}</span>
                </button>
                {tab.closable ? (
                  <button
                    className="right-panel-tab__close"
                    type="button"
                    aria-label={`Close ${tab.title}`}
                    tabIndex={active ? 0 : -1}
                    onClick={() => closeTab(tab)}
                  >
                    <X size={12} />
                  </button>
                ) : null}
              </motion.div>
            );
          })}
          {state.right.tabs.length > 0 ? <PanelCreationMenu key={state.ownerId}
            actions={creationActions} context={toolbarActionContext} /> : null}
          <div
            className="right-panel-tab-strip__drop-tail"
            onDragOver={(event) => {
              if (draggedTabId !== null) event.preventDefault();
            }}
            onDragEnter={() => {
              if (draggedTabId !== null) {
                onAction({
                  type: "move-tab",
                  region: "right",
                  tabId: draggedTabId,
                  beforeTabId: null,
                });
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const tabId =
                draggedTabId ?? event.dataTransfer.getData("text/plain");
              if (tabId !== "")
                onAction({
                  type: "move-tab",
                  region: "right",
                  tabId,
                  beforeTabId: null,
                });
              setDraggedTabId(null);
            }}
          />
        </div>
        <div className="right-panel-toolbar__actions">
          {toolbarActions
            .filter((action) =>
              action.region === "right"
              && (action.isAvailable?.(toolbarActionContext) ?? true))
            .map((action) => (
              <PanelToolbarAction key={action.id} action={action} context={toolbarActionContext} />
            ))}
          <button
            className="chrome-button"
            type="button"
            title={
              state.rightPanelFullWidth ? "Restore panel" : "Maximize panel"
            }
            onClick={() => onAction({ type: "toggle-right-full-width" })}
            aria-label={state.rightPanelFullWidth ? "Restore panel" : "Maximize panel"}
            aria-pressed={state.rightPanelFullWidth}
          >
            {state.rightPanelFullWidth ? (
              <Minimize2 size={14} />
            ) : (
              <Maximize2 size={14} />
            )}
          </button>
          <motion.div
            aria-hidden="true"
            className="right-panel-header-action-spacer"
            data-testid="right-panel-tab-bar-header-spacer"
            style={{ width: headerRightWidthPx }}
          />
        </div>
      </header>

      <div
        className="right-panel-view"
        id={activeTab === null ? undefined : `right-panel-view-${activeTab.id}`}
        role="tabpanel"
      >
        {activeTab === null ? (
          <div className="right-panel-launcher" role="group" aria-label="Open a panel">
            {creationActions.length > 0 ? creationActions.map(action => (
              <PanelToolbarAction key={action.id} action={action} context={toolbarActionContext} launcher />
            )) : <p>No panel actions available for this host.</p>}
          </div>
        ) : ActivePanel === null ? (
          <div className="right-panel-empty">
            <strong>{activeTab.title} is unavailable</strong>
            <p>The renderer plugin for this tab is not installed.</p>
          </div>
        ) : (
          <ActivePanel
            tab={activeTab}
            ownerId={state.ownerId}
            presentationId={presentationId}
          />
        )}
      </div>
    </div>
  );
}
