import { IconButton, ButtonPlaceholder } from "@opencraft/design-system-web/button";
import { ChevronLeftIcon, ArrowLeftIcon as ArrowLeft, ArrowRightIcon as ArrowRight, HomeIcon } from "@opencraft/design-system-web/action-icons";
import { ControlSurface } from "@opencraft/design-system-web/control-surface";
import { useTouchLayout } from "../runtime/use-touch-layout";
import { useTouchBrowserLayout } from "./use-touch-browser-layout";
import { cancelFrame, frame, motion, useTransform } from "motion/react";
import { useIntl } from "@opencraft/i18n/react";
import { createPortal } from "react-dom";
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
import { NavigationIcon } from "./shell-navigation/navigation-action";
import { ToolbarDockCapacityContext } from "./toolbar-dock-state";
import { toolbarDockCapacity } from "./toolbar-dock-model";

const HEADER_BRAND_MINIMUM_MAIN_WIDTH = 640;

export interface AppShellNavigationControlsProps {
  readonly brand?: ReactNode;
  readonly conversationHeader?: boolean;
  readonly hostRole: "persistent" | "transient";
  readonly sidebarOpen: boolean;
  readonly canGoBack: boolean;
  readonly canReturn?: boolean;
  readonly canGoForward: boolean;
  readonly onToggleSidebar: () => void;
  readonly onHome: () => void;
  readonly onBack: () => void;
  /** Explicit surface exit, independent of browser history availability. */
  readonly onForward: () => void;
  readonly actions: readonly HeaderNavigationAction[];
  /** Page return controls do not reserve native chrome or publish Shell width. */
  readonly scope?: "shell" | "page";
  readonly shellOwned?: boolean;
  /** Keep the single intrinsic measurement mounted while visible controls
   * change physical placement at the compact/desktop boundary. */
  readonly renderPart?: "all" | "measurement" | "controls";
}

/**
 * Shared navigation rendering and its single intrinsic measurement. Shell owns
 * persistent controls; a page's semantic return is a separate local slot.
 */
export function AppShellNavigationControls({
  brand,
  conversationHeader = false,
  hostRole,
  sidebarOpen: requestedSidebarOpen,
  canGoBack,
  canReturn = false,
  canGoForward,
  onToggleSidebar: requestedToggleSidebar,
  onHome,
  onBack,
  onForward,
  actions,
  scope = "shell",
  shellOwned = false,
  renderPart = "all",
}: AppShellNavigationControlsProps) {
  const intl = useIntl();
  const presentation = useShellPresentation();
  const touch = useTouchLayout();
  const sidebarOpen = hostRole === "persistent" && presentation ? presentation.sidebarOpen : requestedSidebarOpen;
  const onToggleSidebar = hostRole === "persistent" && presentation ? presentation.toggleSidebar : requestedToggleSidebar;
  // A floating sidebar covers the persistent header; it does not replace its
  // collapsed navigation rail. Only a docked sidebar owns the expanded rail.
  const sidebarDocked = sidebarOpen && !presentation?.sidebarFloating;
  const presentedActions = useMemo<readonly HeaderNavigationAction[]>(() => {
    const routeActions = canReturn ? actions.map(action => action === "sidebar-toggle" ? "back" as const : action) : actions;
    if (presentation?.sidebarControlsInSidebar) {
      return routeActions.filter(action => action !== "sidebar-toggle" || hostRole === "persistent");
    }
    if (hostRole !== "persistent" || sidebarDocked) return routeActions;
    return routeActions.flatMap(action => action === "sidebar-toggle"
      ? [action, "new-task" as const]
      : [action]);
  }, [actions, canReturn, hostRole, sidebarDocked, presentation?.sidebarControlsInSidebar]);
  const { headerLeftFitWidth, mainContentTargetWidth } = useAppShellLayoutMotion();
  // Use the primary pane, not the window: a wide window may host a narrow chat.
  // This width is independent of the rail's intrinsic measurement, so releasing
  // the brand cannot make it immediately reappear at the same pane width.
  const [brandFits, setBrandFits] = useState(() => mainContentTargetWidth.get() > HEADER_BRAND_MINIMUM_MAIN_WIDTH);
  useLayoutEffect(() => {
    const update = () => setBrandFits(mainContentTargetWidth.get() > HEADER_BRAND_MINIMUM_MAIN_WIDTH);
    update();
    const unsubscribe = mainContentTargetWidth.on("change", () => frame.read(update));
    return () => { unsubscribe(); cancelFrame(update); };
  }, [mainContentTargetWidth]);
  // A sidebar owns its brand independently of the primary pane capacity.
  // Input density changes control treatment, not the brand ownership boundary.
  const sidebarOwnsBrand = hostRole === "transient" || sidebarDocked;
  const visibleBrand = sidebarOwnsBrand || brandFits ? brand : null;
  const applicationsAction = hostRole === "persistent" && scope === "shell" ? presentation?.applicationsAction : undefined;
  const hasNavigationContent = Boolean(visibleBrand) || presentedActions.length > 0 || Boolean(applicationsAction);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const toggleSidebar = useCallback(() => {
    if (hostRole === "transient") {
      transferChromeActionFocus("sidebar-toggle", "transient", "persistent");
    }
    onToggleSidebar();
  }, [hostRole, onToggleSidebar]);

  const labels = {
    home: { id: "navigation.home", defaultMessage: "Home" },
    "new-task": { id: "navigation.newTask", defaultMessage: "Start new task" },
    back: { id: "navigation.back", defaultMessage: "Back" },
    forward: { id: "navigation.forward", defaultMessage: "Forward" },
  };
  const renderControl = (action: HeaderNavigationAction) => {
    if (action === "sidebar-toggle") return <SidebarToggleButton key={action}
      className={conversationHeader ? "chrome-button no-drag app-shell-conversation-sidebar-toggle" : undefined}
      open={sidebarOpen} hostRole={hostRole} onToggle={toggleSidebar} />;
    const label = intl.formatMessage(labels[action]);
    const history = action === "back" || action === "forward";
    return <IconButton surface={touch ? "floating" : "integrated"}
      className={"chrome-button no-drag" + (history ? " history-button" : "")}
      type="button" aria-label={label} title={label}
      disabled={action === "back" ? !canGoBack : action === "forward" ? !canGoForward : undefined}
      data-chrome-action-id={action === "home" ? "home" : undefined}
      data-app-shell-new-task-trigger={action === "new-task" || undefined}
      onClick={action === "home" || action === "new-task" ? onHome : action === "back" ? onBack : onForward}>
      {action === "home" ? <HomeIcon size={15} /> : action === "new-task" ? <NewTaskIcon />
        : action === "forward" ? <ArrowRight size={15} />
        : canReturn ? <ChevronLeftIcon size={touch ? 20 : 16} /> : <ArrowLeft size={15} />}
    </IconButton>;
  };

  useLayoutEffect(() => {
    if (hostRole !== "persistent" || scope !== "shell" || renderPart === "controls") return;
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
  }, [headerLeftFitWidth, hostRole, hasNavigationContent, scope, renderPart]);

  // Measurement and visible placement use the same rail composition. This is
  // one rendering contract, not two separately maintained action layouts.
  const rail = (measurement: boolean) => <div className="app-shell-header__window-controls-rail"
    data-navigation-empty={!hasNavigationContent || undefined}
    data-navigation-brand={visibleBrand ? true : undefined}
    data-sidebar-brand={sidebarOwnsBrand || undefined}
    data-sidebar-collapsed={presentation?.sidebarControlsInSidebar && !sidebarOpen || undefined}>
    {visibleBrand}
    {presentedActions.map(action => <span className="app-shell-header__window-action no-drag"
      data-app-shell-window-action={action} data-navigation-return={canReturn && action === "back" || undefined} key={action}>
      {measurement ? <ButtonPlaceholder className="chrome-button" /> : renderControl(action)}
    </span>)}
    {applicationsAction ? measurement ? <ButtonPlaceholder className="chrome-button" /> : (
      <span className="app-shell-header__window-action no-drag">
        <IconButton surface={touch ? "floating" : "integrated"}
          className="chrome-button app-shell-header__applications" type="button"
          data-action-id="shell.applications.header" aria-label={applicationsAction.title}
          aria-current={applicationsAction.active ? "page" : undefined} title={applicationsAction.title}
          onClick={() => { presentation?.dismissSidebarAfterSelection(); applicationsAction.onInvoke(); }}>
          <NavigationIcon name={applicationsAction.icon} selected={applicationsAction.active} />
        </IconButton>
      </span>
    ) : null}
  </div>;
  return <>
    {renderPart !== "controls" ? <div ref={measureRef} inert aria-hidden="true"
      className="app-shell-header__window-controls-measure" data-navigation-scope={scope} data-route-snapshot="exclude">
      {rail(true)}
    </div> : null}
    {renderPart !== "measurement" ? <div
      className={"app-shell-header__window-controls" + (shellOwned ? " shell-chrome" : "")}
      data-app-shell-chrome={shellOwned ? "shell" : undefined}
      data-pip-obstacle={shellOwned ? "app-shell-navigation" : undefined}
      data-app-shell-conversation-header={shellOwned && conversationHeader || undefined}
      data-navigation-scope={scope} data-app-shell-header-start-slot="true">
      {rail(false)}
    </div> : null}
  </>;
}

export interface AppShellHeaderProps {
  readonly navigationBrand?: ReactNode;
  /** Opts draft and conversation routes into the touch Newera header presentation. */
  readonly conversationHeader?: boolean;
  /** Actions owned by the primary route, beside its title and before the tool aperture. */
  readonly primaryAction?: ReactNode;
  /** Fixed buttons outside the optional dock, including its More entrance. */
  readonly primaryActionFixedSlots?: number;
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
  readonly rightPanelActionInComposer?: boolean;
  readonly onToggleSidebar: () => void;
  readonly onToggleRightPanel: () => void;
  readonly onHome: () => void;
  readonly canGoBack: boolean;
  readonly canReturn?: boolean;
  readonly canGoForward: boolean;
  readonly onBack: () => void;
  /** Explicit surface exit, independent of browser history availability. */
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
  primaryAction,
  primaryActionFixedSlots = 1,
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
  showRightPanelAction: requestedShowRightPanelAction = true,
  rightPanelActionInComposer = false,
  onToggleSidebar,
  onToggleRightPanel: requestedToggleRightPanel,
  onHome,
  canGoBack,
  canReturn = false,
  canGoForward,
  onBack,
  onForward,
  navigationActions,
}: AppShellHeaderProps) {
  const intl = useIntl();
  const touch = useTouchLayout();
  const presentation = useShellPresentation();
  const detachedNavigation = !presentation?.mobileSidebar;
  const rightPanelOpen = presentation?.rightPanelOpen ?? requestedRightPanelOpen;
  const rightPanelFullWidth = presentation?.rightPanelFullWidth ?? requestedRightPanelFullWidth;
  const mobileComposerAction = useTouchBrowserLayout() && rightPanelActionInComposer;
  // Keep the panel's close action reachable while it covers the composer.
  const showRightPanelAction = requestedShowRightPanelAction && (!mobileComposerAction || rightPanelOpen);
  const onToggleRightPanel = presentation?.toggleRightPanel ?? requestedToggleRightPanel;
  const primaryHidden = rightPanelFullWidth || presentation?.contentPresentation === "tools";
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
  const primaryRef = useRef<HTMLDivElement | null>(null);
  const [dockMetrics, setDockMetrics] = useState({ available: 0, reserve: 0, step: 1, maximum: 0 });
  const dockCapacity = presentation?.mobileSidebar ? 0 : toolbarDockCapacity(
    dockMetrics.available, dockMetrics.reserve, dockMetrics.step,
    primaryActionFixedSlots, dockMetrics.maximum,
  );
  useLayoutEffect(() => {
    if (presentation?.mobileSidebar) return;
    const context = primaryRef.current;
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
      const step = size + gap;
      setDockMetrics(previous => previous.available === available && previous.reserve === reserve
        && previous.step === step && previous.maximum === maximum
        ? previous : { available, reserve, step, maximum });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(context);
    observer.observe(measure);
    const probe = context.querySelector(".toolbar-dock__capacity-probe");
    if (probe) observer.observe(probe);
    return () => observer.disconnect();
  }, [presentation?.mobileSidebar]);

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

  const navigationProps = {
    conversationHeader, hostRole: "persistent" as const, sidebarOpen,
    canGoBack: canGoBack || canReturn, canGoForward,
    onToggleSidebar, onHome, onBack, onForward,
  };
  const navigation = <AppShellNavigationControls {...navigationProps}
    renderPart="controls" shellOwned={detachedNavigation} brand={navigationBrand} canReturn={!detachedNavigation && canReturn} actions={navigationActions} />;

  return <>
    {detachedNavigation && presentation?.navigationChromeHost
      ? createPortal(navigation, presentation.navigationChromeHost) : null}
    <header
      className="app-shell-header"
      data-app-shell-chrome="page"
      data-navigation-detached={detachedNavigation || undefined}
      data-app-shell-conversation-header={conversationHeader || undefined}
      data-app-shell-header-edge-scroll={isHeaderEdgeScroll}
      data-pip-obstacle="app-shell-header"
    >
      <span className="app-shell-header__content-edge" aria-hidden="true" />
      <AppShellNavigationControls {...navigationProps} renderPart="measurement"
        brand={navigationBrand} canReturn={!detachedNavigation && canReturn} actions={navigationActions} />
      {detachedNavigation ? <>
        {canReturn ? <AppShellNavigationControls {...navigationProps} renderPart="controls" scope="page" canReturn actions={["back"]} /> : null}
      </> : navigation}

      <div className="app-shell-header__context">
        <div ref={endActionsMeasureRef} aria-hidden="true" inert className="app-shell-header__end-measure">
          {showRightPanelAction ? <div className="app-shell-header__end-actions"><ControlSurface surface={touch ? "floating" : "integrated"} className="app-shell-header__action-group">
            <ButtonPlaceholder className="chrome-button app-shell-header__right-panel-toggle"><RightPanelToggleIcon panelOpen={rightPanelOpen} /></ButtonPlaceholder>
          </ControlSurface></div> : null}
        </div>
        <div
          ref={primaryRef}
          className="app-shell-header__context-surface"
          data-app-shell-primary-header="true"
          aria-hidden={primaryHidden}
          inert={primaryHidden || undefined}
          data-app-shell-header-context-hidden={primaryHidden}
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
          <ToolbarDockCapacityContext.Provider value={dockCapacity}>
            <span className="toolbar-dock__capacity-probe" aria-hidden="true" />
            {primaryAction ? <div className="app-shell-header__primary-actions no-drag">
              <ControlSurface surface={touch ? "floating" : "integrated"} className="app-shell-header__action-group">{primaryAction}</ControlSurface>
            </div> : null}
          </ToolbarDockCapacityContext.Provider>
        </div>
        <motion.div
          className="app-shell-header__end-slot"
          data-app-shell-header-end-slot="true"
          style={{
            minWidth: headerRightWidthPx,
            width: rightPanelAnimatedWidthPx,
          }}
        >
          {showRightPanelAction ? <div className="app-shell-header__end-actions no-drag">
            <ControlSurface surface={touch ? "floating" : "integrated"} className="app-shell-header__action-group">

              <IconButton
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
              </IconButton>
            </ControlSurface>
          </div> : null}
        </motion.div>
      </div>
    </header>
  </>;
}
