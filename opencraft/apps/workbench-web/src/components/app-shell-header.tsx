import {
  ArrowLeft,
  ArrowRight,
  Code2,
} from "lucide-react";
import { motion, useTransform } from "motion/react";
import { useIntl } from "@opencraft/i18n/react";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefCallback,
  type ReactNode,
} from "react";

import { SidebarToggleIcon } from "../chrome-actions/sidebar-toggle-icon";
import { NewTaskIcon } from "../chrome-actions/new-task-icon";
import { RightPanelToggleIcon } from "../chrome-actions/right-panel-toggle-icon";
import {
  transferChromeActionFocus,
  useChromeActionFocusRef,
} from "../chrome-actions/use-chrome-action-focus";
import type {
  HeaderNavigationAction,
} from "../window-chrome";
import { useAppShellLayoutMotion } from "./app-shell";
import { useShellPresentation } from "./shell-presentation";

export interface AppShellNavigationControlsProps {
  readonly hostRole: "persistent" | "transient";
  readonly sidebarOpen: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly onToggleSidebar: () => void;
  readonly onHome: () => void;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly actions: readonly HeaderNavigationAction[];
}

/**
 * The one physical owner of the Workbench's leading window controls.
 * Conversation, settings, zero-Host and extension routes all project into
 * this rail; a route must never synthesize a second copy of the controls.
 */
export function AppShellNavigationControls({
  hostRole,
  sidebarOpen: requestedSidebarOpen,
  canGoBack,
  canGoForward,
  onToggleSidebar: requestedToggleSidebar,
  onHome,
  onBack,
  onForward,
  actions,
}: AppShellNavigationControlsProps) {
  const intl = useIntl();
  const presentation = useShellPresentation();
  const sidebarOpen = hostRole === "persistent" && presentation ? presentation.sidebarOpen : requestedSidebarOpen;
  const onToggleSidebar = hostRole === "persistent" && presentation ? presentation.toggleSidebar : requestedToggleSidebar;
  const presentedActions = useMemo<readonly HeaderNavigationAction[]>(() => {
    if (hostRole !== "persistent" || sidebarOpen || actions.includes("home")) return actions;
    return actions.flatMap(action => action === "sidebar-toggle"
      ? [action, "new-task" as const]
      : [action]);
  }, [actions, hostRole, sidebarOpen]);
  const { headerLeftFitWidth } = useAppShellLayoutMotion();
  const measureRef = useRef<HTMLDivElement | null>(null);
  const sidebarToggleRef = useChromeActionFocusRef("sidebar-toggle", hostRole);
  const toggleSidebar = useCallback(() => {
    if (hostRole === "transient") {
      transferChromeActionFocus("sidebar-toggle", "transient", "persistent");
    }
    onToggleSidebar();
  }, [hostRole, onToggleSidebar]);

  const controls = {
    home: (
      <button
        key="home"
        className="chrome-button no-drag app-shell-home-button"
        type="button"
        aria-label={intl.formatMessage({ id: "navigation.home", defaultMessage: "Home" })}
        title="Vela · Home"
        data-app-shell-home-trigger="true"
        onClick={onHome}
      >
        <span className="app-shell-wordmark">Vela</span>
      </button>
    ),
    "sidebar-toggle": (
      <button
        key="sidebar-toggle"
        ref={sidebarToggleRef}
        className="chrome-button no-drag"
        type="button"
        aria-label={intl.formatMessage(sidebarOpen ? { id: "navigation.hideSidebar", defaultMessage: "Hide sidebar" } : { id: "navigation.showSidebar", defaultMessage: "Show sidebar" })}
        data-app-shell-sidebar-trigger="true"
        data-chrome-action-id="sidebar-toggle"
        data-chrome-action-host-role={hostRole}
        style={{ viewTransitionName: "sidebar-trigger" }}
        onClick={toggleSidebar}
        title="Toggle sidebar (⌘B)"
      >
        <SidebarToggleIcon sidebarOpen={sidebarOpen} />
      </button>
    ),
    "new-task": (
      <button
        key="new-task"
        className="chrome-button no-drag"
        type="button"
        aria-label={intl.formatMessage({ id: "navigation.newTask", defaultMessage: "Start new task" })}
        data-app-shell-new-task-trigger="true"
        onClick={onHome}
        title={intl.formatMessage({ id: "navigation.newTask", defaultMessage: "Start new task" })}
      >
        <NewTaskIcon />
      </button>
    ),
    back: (
      <button
        key="back"
        className="chrome-button no-drag history-button"
        type="button"
        disabled={!canGoBack}
        onClick={onBack}
        title={intl.formatMessage({ id: "navigation.back", defaultMessage: "Back" })}
      >
        <ArrowLeft size={15} />
      </button>
    ),
    forward: (
      <button
        key="forward"
        className="chrome-button no-drag history-button"
        type="button"
        disabled={!canGoForward}
        onClick={onForward}
        title={intl.formatMessage({ id: "navigation.forward", defaultMessage: "Forward" })}
      >
        <ArrowRight size={15} />
      </button>
    ),
  } satisfies Record<HeaderNavigationAction, ReactNode>;

  useLayoutEffect(() => {
    if (hostRole !== "persistent") return;
    const measure = measureRef.current;
    if (measure === null) return;
    const update = () => {
      const width = measure.getBoundingClientRect().width;
      if (width > 0 && Math.abs(headerLeftFitWidth.get() - width) > 0.5) {
        headerLeftFitWidth.set(width);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [headerLeftFitWidth, hostRole, presentedActions]);

  return (
    <>
      <div
        ref={measureRef}
        aria-hidden="true"
        className="app-shell-header__window-controls-measure"
      >
        <div className="app-shell-header__window-controls-rail">
          {presentedActions.map((action) => (
            <span
              className="app-shell-header__window-action no-drag"
              data-app-shell-window-action={action}
              key={action}
            >
              <span className={action === "home" ? "chrome-button app-shell-home-button" : "chrome-button"}>
                {action === "home" ? <span className="app-shell-wordmark">Vela</span> : null}
              </span>
            </span>
          ))}
        </div>
      </div>
      <div
        className="app-shell-header__window-controls"
        data-app-shell-header-start-slot="true"
      >
        <div className="app-shell-header__window-controls-rail">
          {presentedActions.map((action) => (
            <span
              className="app-shell-header__window-action no-drag"
              data-app-shell-window-action={action}
              key={action}
            >
              {controls[action]}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

export interface AppShellHeaderProps {
  readonly title: string | null;
  readonly project: string | null;
  readonly routeHeaderActive?: boolean;
  readonly routeHeaderHostRef?: RefCallback<HTMLDivElement>;
  readonly sidebarOpen: boolean;
  readonly rightPanelOpen: boolean;
  readonly rightPanelFullWidth: boolean;
  readonly showRightPanelAction?: boolean;
  readonly onToggleSidebar: () => void;
  readonly onToggleRightPanel: () => void;
  readonly onHome: () => void;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
  /**
   * Route-owned projection of the leading titlebar rail. Window chrome says
   * which controls are available; the active application route says whether
   * that rail exists at all.
   */
  readonly navigationActions: readonly HeaderNavigationAction[];
}

/** Shared titlebar projection for every route hosted by AppShell. */
export function AppShellHeader({
  title,
  project,
  routeHeaderActive = false,
  routeHeaderHostRef,
  sidebarOpen,
  rightPanelOpen: requestedRightPanelOpen,
  rightPanelFullWidth: requestedRightPanelFullWidth,
  showRightPanelAction = true,
  onToggleSidebar,
  onToggleRightPanel: requestedToggleRightPanel,
  onHome,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  navigationActions,
}: AppShellHeaderProps) {
  const presentation = useShellPresentation();
  const rightPanelOpen = presentation?.rightPanelOpen ?? requestedRightPanelOpen;
  const rightPanelFullWidth = presentation?.rightPanelFullWidth ?? requestedRightPanelFullWidth;
  const onToggleRightPanel = presentation?.toggleRightPanel ?? requestedToggleRightPanel;
  const { headerRightWidth, isHeaderEdgeScroll, rightPanelAnimatedWidth } =
    useAppShellLayoutMotion();
  const headerRightWidthPx = useTransform(
    headerRightWidth,
    (width) => `${Math.max(0, width)}px`,
  );
  const rightPanelAnimatedWidthPx = useTransform(
    rightPanelAnimatedWidth,
    (width) => `${Math.max(0, width)}px`,
  );
  const endActionsMeasureRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const endActionsMeasure = endActionsMeasureRef.current;
    if (endActionsMeasure === null) return;
    const updateWidth = () => {
      const width = endActionsMeasure.getBoundingClientRect().width;
      if (Math.abs(headerRightWidth.get() - width) > 0.5) {
        headerRightWidth.set(width);
      }
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(endActionsMeasure);
    return () => observer.disconnect();
  }, [headerRightWidth]);

  return (
    <header
      className="app-shell-header"
      data-app-shell-header-edge-scroll={isHeaderEdgeScroll}
      data-pip-obstacle="app-shell-header"
    >
      <AppShellNavigationControls
        hostRole="persistent"
        sidebarOpen={sidebarOpen}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onToggleSidebar={onToggleSidebar}
        onHome={onHome}
        onBack={onBack}
        onForward={onForward}
        actions={navigationActions}
      />

      <div className="app-shell-header__context">
        <div
          ref={endActionsMeasureRef}
          aria-hidden="true"
          className="app-shell-header__end-measure"
        >
          {showRightPanelAction ? (
            <div className="app-shell-header__end-actions">
              <span className="chrome-button app-shell-header__right-panel-toggle">
                <RightPanelToggleIcon panelOpen={rightPanelOpen} />
              </span>
            </div>
          ) : null}
        </div>
        <div
          className="app-shell-header__context-surface"
          aria-hidden={rightPanelFullWidth}
          data-app-shell-header-context-hidden={rightPanelFullWidth}
        >
          <div
            ref={routeHeaderHostRef}
            className="app-shell-header__route"
            data-app-shell-route-header-active={routeHeaderActive}
          />
          {!routeHeaderActive && title !== null ? (
            <div className="thread-header-title">
              <span className="thread-header-project-icon">
                <Code2 size={14} />
              </span>
              <span className="thread-header-copy">
                <strong>{title}</strong>
                {project === null ? null : <small>{project} · main</small>}
              </span>
            </div>
          ) : null}
        </div>
        <motion.div
          className="app-shell-header__end-slot"
          data-app-shell-header-end-slot="true"
          style={{
            minWidth: headerRightWidthPx,
            width: rightPanelAnimatedWidthPx,
          }}
        >
          <div className="app-shell-header__end-actions no-drag">
            {showRightPanelAction ? (
              <button
                className="chrome-button app-shell-header__right-panel-toggle"
                type="button"
                aria-label={
                  rightPanelOpen ? "Hide task details" : "Show task details"
                }
                aria-pressed={rightPanelOpen}
                onClick={onToggleRightPanel}
                title="Toggle task details"
              >
                <RightPanelToggleIcon panelOpen={rightPanelOpen} />
              </button>
            ) : null}
          </div>
        </motion.div>
      </div>
    </header>
  );
}
