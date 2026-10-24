import { ArrowLeftIcon as ArrowLeft, ArrowRightIcon as ArrowRight } from "@opencraft/design-system-web/action-icons";
import { LiquidGlassBackdrop } from "@opencraft/design-system-web/liquid-glass";
import { motion, useTransform } from "motion/react";
import { useIntl } from "@opencraft/i18n/react";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefCallback,
  type ReactNode,
} from "react";

import { SidebarToggleButton } from "../chrome-actions/sidebar-toggle-button";
import { NewTaskIcon } from "../chrome-actions/new-task-icon";
import { RightPanelToggleIcon } from "../chrome-actions/right-panel-toggle-icon";
import {
  transferChromeActionFocus,
} from "../chrome-actions/use-chrome-action-focus";
import type {
  HeaderNavigationAction,
} from "../window-chrome";
import { useAppShellLayoutMotion } from "./app-shell";
import { useShellPresentation } from "./shell-presentation";
import { ToolbarDockCapacityContext } from "./toolbar-dock-state";
import { toolbarDockCapacity } from "./toolbar-dock-model";

export interface AppShellNavigationControlsProps {
  readonly brand?: ReactNode;
  readonly conversationHeader?: boolean;
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
 * Unified navigation keeps its shared toggle beside the brand in the persistent
 * header in every sidebar state. Routes never supply another copy of the control.
 */
export function AppShellNavigationControls({
  brand,
  conversationHeader = false,
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
  // A floating sidebar covers the persistent header; it does not replace its
  // collapsed navigation rail. Only a docked sidebar owns the expanded rail.
  const sidebarDocked = sidebarOpen && !presentation?.sidebarFloating;
  const presentedActions = useMemo<readonly HeaderNavigationAction[]>(() => {
    if (presentation?.sidebarControlsInSidebar) {
      return actions.filter(action => action !== "sidebar-toggle" || hostRole === "persistent");
    }
    if (hostRole !== "persistent" || sidebarDocked) return actions;
    return actions.flatMap(action => action === "sidebar-toggle"
      ? [action, "new-task" as const]
      : [action]);
  }, [actions, hostRole, sidebarDocked, presentation?.sidebarControlsInSidebar]);
  const { headerLeftFitWidth } = useAppShellLayoutMotion();
  const visibleBrand = brand;
  const hasNavigationContent = Boolean(visibleBrand) || presentedActions.length > 0;
  const measureRef = useRef<HTMLDivElement | null>(null);
  const toggleSidebar = useCallback(() => {
    if (hostRole === "transient") {
      transferChromeActionFocus("sidebar-toggle", "transient", "persistent");
    }
    onToggleSidebar();
  }, [hostRole, onToggleSidebar]);

  const controls = {
    "sidebar-toggle": (
      <SidebarToggleButton key="sidebar-toggle" className={conversationHeader ? "chrome-button no-drag app-shell-conversation-sidebar-toggle" : undefined} stationary={hostRole === "persistent" && presentation?.sidebarControlsInSidebar && !presentation.mobileSidebar} open={sidebarOpen} hostRole={hostRole} onToggle={toggleSidebar} />
    ),
    "new-task": (
      <button
        key="new-task"
        data-liquid-action=""
        className="chrome-button no-drag"
        type="button"
        aria-label={intl.formatMessage({ id: "navigation.newTask", defaultMessage: "Start new task" })}
        data-app-shell-new-task-trigger="true"
        onClick={onHome}
        title={intl.formatMessage({ id: "navigation.newTask", defaultMessage: "Start new task" })}
      >
        <LiquidGlassBackdrop /><NewTaskIcon />
      </button>
    ),
    back: (
      <button
        key="back"
        data-liquid-action=""
        className="chrome-button no-drag history-button"
        type="button"
        disabled={!canGoBack}
        onClick={onBack}
        title={intl.formatMessage({ id: "navigation.back", defaultMessage: "Back" })}
      >
        <LiquidGlassBackdrop /><ArrowLeft size={15} />
      </button>
    ),
    forward: (
      <button
        key="forward"
        data-liquid-action=""
        className="chrome-button no-drag history-button"
        type="button"
        disabled={!canGoForward}
        onClick={onForward}
        title={intl.formatMessage({ id: "navigation.forward", defaultMessage: "Forward" })}
      >
        <LiquidGlassBackdrop /><ArrowRight size={15} />
      </button>
    ),
  } satisfies Record<HeaderNavigationAction, ReactNode>;

  useLayoutEffect(() => {
    if (hostRole !== "persistent") return;
    const measure = measureRef.current;
    if (measure === null) return;
    const updateWidth = (width: number) => {
      if ((width > 0 || !hasNavigationContent) && Math.abs(headerLeftFitWidth.get() - width) > 0.5) {
        headerLeftFitWidth.set(width);
      }
    };
    updateWidth(measure.getBoundingClientRect().width);
    // Track physical size, not React identities for equivalent actions/brands.
    // Border-box observation also catches padding and border changes.
    const observer = new ResizeObserver(([entry]) => {
      updateWidth(entry?.borderBoxSize?.[0]?.inlineSize ?? measure.getBoundingClientRect().width);
    });
    observer.observe(measure, { box: "border-box" });
    return () => observer.disconnect();
  }, [headerLeftFitWidth, hostRole, hasNavigationContent]);

  return (
    <>
      <div
        ref={measureRef}
        inert
        aria-hidden="true"
        className="app-shell-header__window-controls-measure"
      >
        <div className="app-shell-header__window-controls-rail" data-navigation-empty={!hasNavigationContent || undefined} data-navigation-brand={visibleBrand ? true : undefined} data-sidebar-collapsed={presentation?.sidebarControlsInSidebar && !sidebarOpen || undefined}>
          {visibleBrand}
          {presentedActions.map((action) => (
            <span
              className="app-shell-header__window-action no-drag"
              data-app-shell-window-action={action}
              key={action}
            >
              <span className="chrome-button" />
            </span>
          ))}
        </div>
      </div>
      <div
        className="app-shell-header__window-controls"
        data-app-shell-header-start-slot="true"
      >
        <div className="app-shell-header__window-controls-rail" data-navigation-empty={!hasNavigationContent || undefined} data-navigation-brand={visibleBrand ? true : undefined} data-sidebar-collapsed={presentation?.sidebarControlsInSidebar && !sidebarOpen || undefined}>
          {visibleBrand}
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
  readonly navigationBrand?: ReactNode;
  /** Opts draft and conversation routes into the touch Newera header presentation. */
  readonly conversationHeader?: boolean;
  /** Route-owned actions immediately before the right-panel toggle. */
  readonly headerAction?: ReactNode;
  /** Number of chrome-button slots to reserve during panel animation. */
  readonly headerActionCount?: number;
  /** Inert sizing projection for route actions with intrinsic text width. */
  readonly headerActionSizing?: ReactNode;
  readonly title: string | null;
  readonly project: string | null;
  readonly titleContent?: ReactNode;
  readonly subtitle?: ReactNode;
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
  navigationBrand,
  headerAction,
  headerActionCount = 1,
  headerActionSizing,
  conversationHeader = false,
  title,
  project,
  titleContent,
  subtitle,
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
  const intl = useIntl();
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
  const contextRef = useRef<HTMLDivElement | null>(null);
  const [dockCapacity, setDockCapacity] = useState(0);
  useLayoutEffect(() => {
    const context = contextRef.current;
    const measure = endActionsMeasureRef.current;
    if (!context || !measure) return;
    const update = () => {
      const style = getComputedStyle(context);
      const sizeProbe = context.querySelector<HTMLElement>(".toolbar-dock__capacity-probe");
      const size = sizeProbe?.getBoundingClientRect().width ?? 28;
      const gap = parseFloat(style.getPropertyValue("--gap-toolbar-dock")) || 0;
      const reserve = parseFloat(style.getPropertyValue("--width-toolbar-dock-title-budget")) || 220;
      const maximum = parseFloat(style.getPropertyValue("--count-toolbar-dock-maximum")) || 4;
      const available = context.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setDockCapacity(presentation?.mobileSidebar ? 0 : toolbarDockCapacity(available, reserve, size + gap, showRightPanelAction ? 2 : 1, maximum));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(context);
    observer.observe(measure);
    const probe = context.querySelector(".toolbar-dock__capacity-probe");
    if (probe) observer.observe(probe);
    return () => observer.disconnect();
  }, [presentation?.mobileSidebar, showRightPanelAction]);

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
      data-app-shell-conversation-header={conversationHeader || undefined}
      data-app-shell-header-edge-scroll={isHeaderEdgeScroll}
      data-pip-obstacle="app-shell-header"
    >
      <span className="app-shell-header__content-edge" aria-hidden="true" />
      <AppShellNavigationControls
        brand={navigationBrand}
        conversationHeader={conversationHeader}
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

      <div ref={contextRef} className="app-shell-header__context">
        <ToolbarDockCapacityContext.Provider value={dockCapacity}>
        <span className="toolbar-dock__capacity-probe" aria-hidden="true" />
        <div
          ref={endActionsMeasureRef}
          aria-hidden="true"
          className="app-shell-header__end-measure"
        >
          {showRightPanelAction || headerAction ? (
            <div className="app-shell-header__end-actions"><div className="app-shell-header__action-group">
              {headerAction ? headerActionSizing ?? Array.from({ length: headerActionCount }, (_, index) => <span key={index} className="chrome-button" />) : null}
              {showRightPanelAction ? <span className="chrome-button app-shell-header__right-panel-toggle">
                <RightPanelToggleIcon panelOpen={rightPanelOpen} />
              </span> : null}
            </div></div>
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
              <div className="thread-header-heading">
                <div className="thread-header-heading__main">
                  {titleContent ?? <span className="thread-header-copy">
                    <strong>{title}</strong>
                    {project === null ? null : <small>{project} · main</small>}
                  </span>}
                </div>
                {subtitle == null ? null : <small className="thread-header-heading__subtitle">{subtitle}</small>}
              </div>
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
            <div className="app-shell-header__action-group">
            <LiquidGlassBackdrop />
            {headerAction}
            {showRightPanelAction ? (
              <button
                className="chrome-button app-shell-header__right-panel-toggle"
                type="button"
                aria-label={
                  intl.formatMessage(rightPanelOpen ? { id: "panel.close", defaultMessage: "Close preview panel" } : { id: "panel.open", defaultMessage: "Open preview panel" })
                }
                aria-pressed={rightPanelOpen}
                onClick={onToggleRightPanel}
                title={intl.formatMessage(rightPanelOpen ? { id: "panel.close", defaultMessage: "Close preview panel" } : { id: "panel.open", defaultMessage: "Open preview panel" })}
              >
                <RightPanelToggleIcon panelOpen={rightPanelOpen} />
              </button>
            ) : null}
            </div>
          </div>
        </motion.div>
        </ToolbarDockCapacityContext.Provider>
      </div>
    </header>
  );
}
