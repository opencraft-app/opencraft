// OpenCraft services/scope policy with Codex 26.908.40834 Wba/Xba
// Viewport/Frame ownership. Geometry does not reuse animation aperture width
// as chat layout width. See design/invariants.md SHL-01 through SHL-04.
import {
  motion,
  useMotionValue,
  useTransform,
  type MotionStyle,
  type MotionValue,
} from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type Ref,
  type ReactNode,
} from "react";

import {
  getHeaderStartMinimumWidth,
  type WindowChromeSnapshot,
} from "../window-chrome";
import {
  readRootFontSizePx,
  resolveAppShellMainContentChrome,
  resolveThreadEdgeScroll,
  type AppShellMainContentLayout,
} from "../app-shell-edge-scroll-model";
import {
  resolveSidebarPresentation,
  shouldMountFloatingSidebarPresenceOwner,
} from "../sidebar-dock-model";
import {
  computeRightPanelDefaultWidth,
  interpolateRightPanelWidth,
  normalizeRightPanelWidth,
} from "@opencraft/workbench-panels";
import { FloatingLeftPanel } from "./floating-left-panel";
import { Sidecar, SidecarPane } from "./sidecar";
import { SharedSidebarContent } from "./shared-sidebar-content";
import { floatingSidebarLayout } from "./floating-sidebar-layout";
import { useContextPaneGeometry } from "./use-context-pane-geometry";
import { AppShellRightPanel } from "./app-shell-right-panel";
import { ComposerOverlayAnchorContext, FloatingComposerRegistryContext, FloatingComposerScopeContext } from "./thread-composer-presentation";
import { FloatingComposerRegistry } from "./floating-composer-state";
import {
  SidebarResizeHandle,
  SIDEBAR_MAXIMUM_WIDTH,
} from "./sidebar-resize-handle";
import { SidecarPrimaryResizeHandle } from "./sidecar-primary-resize-handle";
import type { SidecarPrimaryResizeCommit } from "./sidecar-primary-resize";
import { useSidecarPrimaryMotion } from "./use-sidecar-primary-motion";
import {
  usePanelAnimation,
  useWorkspacePaneAnimation,
  usePanelVisibilityAnimation,
} from "./use-panel-animation";
import { workspacePaneGeometry } from "./workspace-pane-geometry";
import { useSidebarDockIntent } from "./use-sidebar-dock-intent";
import { shellNavigationMetrics, shellSpaceMetrics } from "@opencraft/workbench-runtime";
import { ShellPresentationContext } from "./shell-presentation";
import { ShellNavigationDock, ShellNavigationFooter, useShellNavigation, type ShellNavigationConfig } from "./shell-navigation";

interface AppShellProps {
  navigation?: ShellNavigationConfig;
  layoutScope: string;
  mainContentLayout: AppShellMainContentLayout;
  /** Physical window chrome stays mounted while routes replace shell content. */
  header: ReactElement;
  floatingSidebarHeader(onDock: () => void): ReactNode;
  /** Optional application context. Chat supplies a conversation list; other apps may omit it. */
  leftPanel?: ReactNode;
  rightPanel: ReactNode;
  rightPanelOpen: boolean;
  rightPanelFullWidth: boolean;
  sidebarCollapsible?: boolean;
  sidebarTransientEnabled?: boolean;
  sidebarResizable?: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  windowChrome: WindowChromeSnapshot;
  onSidebarCollapse(): void;
  onSidebarExpand(): void;
  onSidebarResizeEnd(width: number, persist: boolean): void;
  onRightPanelOpenChange(open: boolean): void;
  children: ReactNode;
}

interface AppShellStyle extends CSSProperties {
  "--app-shell-left-open-width": string;
  "--shell-navigation-bottom-reserve": string;
}

interface ApplicationShellRootProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly rootRef?: Ref<HTMLDivElement>;
  readonly sidebarMounted: boolean;
  readonly sidebarOpen: boolean;
  readonly sidebarPresentation: string;
  readonly sidecarPrimaryDetent?: "expanded" | "compact" | "hidden";
  readonly style?: CSSProperties;
  readonly windowChrome: WindowChromeSnapshot;
}

/** Physical viewport and window material shared by every top-level route. */
export function ApplicationShellRoot({
  children,
  className,
  rootRef,
  sidebarMounted,
  sidebarOpen,
  sidebarPresentation,
  sidecarPrimaryDetent,
  style,
  windowChrome,
}: ApplicationShellRootProps) {
  return (
    <div
      ref={rootRef}
      className={["app-shell-root", className].filter(Boolean).join(" ")}
      data-selection="chrome"
      data-codex-window-type={windowChrome.kind}
      data-codex-os={windowChrome.platform}
      data-sidebar-open={sidebarOpen}
      data-sidebar-mounted={sidebarMounted}
      data-sidebar-presentation={sidebarPresentation}
      data-sidecar-primary-detent={sidecarPrimaryDetent}
      style={
        {
          "--spacing-token-safe-header-left": `${windowChrome.safeArea.left}px`,
          "--spacing-token-safe-header-right": `${windowChrome.safeArea.right}px`,
          ...style,
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}

interface HeaderMotionStyle extends MotionStyle {
  "--app-shell-header-left-slot-width": MotionValue<string>;
  "--app-shell-header-left-fit-width": MotionValue<string>;
}

interface AppShellLayoutMotion {
  /**
   * Intrinsic width of the leading titlebar rail, including the native window
   * controls safe inset. The HeaderSlot is its sole writer; panel animation is
   * only allowed to widen this aperture, never to shrink it.
   */
  readonly headerLeftFitWidth: MotionValue<number>;
  /**
   * Physical width owned by the global header's end slot. Panel chrome uses
   * the same live signal to reserve that space instead of guessing margins.
   */
  readonly headerRightWidth: MotionValue<number>;
  /**
   * Fixed leading aperture for a full-width right-panel tab strip. It is the
   * part of the global start HeaderSlot not already covered by the physical
   * left panel, and therefore grows continuously while that panel collapses.
   */
  readonly rightPanelTabBarLeftInset: MotionValue<number>;
  /**
   * Width of the global header region geometrically owned by the right panel.
   * In regular mode this follows the panel visibility/resize animation; in
   * full-width mode it is zero so the compact header actions retain ownership.
   */
  readonly rightPanelAnimatedWidth: MotionValue<number>;
  /**
   * Monotonic geometry clock for portalled surfaces. It advances for every
   * physical right-panel animation frame, after semantic visibility changes.
   */
  readonly rightPanelLayoutTick: MotionValue<number>;
  /**
   * Whether a portalled surface is physically owned by the right-panel
   * presentation. This outlives semantic `open` during the exit animation,
   * then becomes false independently of whether the React subtree has
   * unmounted. Sessions must not use component presence as this signal.
   */
  readonly rightPanelPresentationActive: boolean;
  /** Destination width used by stable content-placement calculations. */
  readonly mainContentTargetWidth: MotionValue<number>;
  /** Whether the timeline safely extends beneath the transparent title bar. */
  readonly isHeaderEdgeScroll: boolean;
}

const AppShellLayoutMotionContext = createContext<AppShellLayoutMotion | null>(
  null,
);

export function useAppShellLayoutMotion(): AppShellLayoutMotion {
  const value = useContext(AppShellLayoutMotionContext);
  if (value === null) throw new Error("AppShellLayoutMotionContext is missing");
  return value;
}

export function AppShell({
  navigation,
  layoutScope,
  mainContentLayout,
  header,
  floatingSidebarHeader,
  leftPanel,
  rightPanel,
  rightPanelOpen: requestedRightPanelOpen,
  rightPanelFullWidth: requestedRightPanelFullWidth,
  sidebarCollapsible = true,
  sidebarTransientEnabled = true,
  sidebarResizable = true,
  sidebarOpen: sidecarOpen,
  sidebarWidth,
  windowChrome,
  onSidebarCollapse,
  onSidebarExpand,
  onSidebarResizeEnd,
  onRightPanelOpenChange,
  children,
}: AppShellProps) {
  const shellRootRef = useRef<HTMLDivElement | null>(null);
  const composerOverlayAnchor = useRef<HTMLDivElement | null>(null);
  const [floatingComposers] = useState(() => new FloatingComposerRegistry());
  const shellWidth = useMotionValue(window.innerWidth);
  const shellHeight = useMotionValue(window.innerHeight);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const [rightPanelRevealed, setRightPanelRevealed] = useState(false);
  const previousToolIntent = useRef({ layoutScope, open: requestedRightPanelOpen });
  const contextAvailable = leftPanel != null;
  const [dockedPrimaryHost, setDockedPrimaryHost] = useState<HTMLDivElement | null>(null);
  const [dockedContextHost, setDockedContextHost] = useState<HTMLDivElement | null>(null);
  const [dockedFooterHost, setDockedFooterHost] = useState<HTMLDivElement | null>(null);
  const [floatingPrimaryHost, setFloatingPrimaryHost] = useState<HTMLDivElement | null>(null);
  const [floatingContextHost, setFloatingContextHost] = useState<HTMLDivElement | null>(null);
  const [floatingFooterHost, setFloatingFooterHost] = useState<HTMLDivElement | null>(null);
  const navigationController = useShellNavigation({
    // Dock/visibility policy is stable for the gesture. Actual pane and main
    // geometry below use live MotionValues, never this saved width.
    viewportWidth, contextWidth: sidebarWidth, contextAvailable, sidecarOpen,
    enabled: navigation !== undefined, allowDock: navigation?.allowDock,
    rightPanelOpen: requestedRightPanelOpen,
    rightPanelFullWidth: requestedRightPanelFullWidth,
    accountAvailable: navigation?.account != null && navigation.account.snapshot.phase !== "anonymous",
  });
  const space = navigationController.space!;
  const sidebarOpen = space.contextOpen;
  const rightPanelOpen = space.rightOpen || rightPanelRevealed;
  const rightPanelFullWidth = rightPanelOpen && (requestedRightPanelFullWidth || (rightPanelRevealed && !space.rightAvailable));
  const navigationOpen = navigationController.projection.dockOpen;
  const visibleNavigationDetent = navigationController.projection.railDetent === "hidden"
    ? navigationController.projection.lastVisibleRailDetent
    : navigationController.projection.railDetent;
  const navigationAnimation = useMotionValue(navigationOpen ? 1 : 0);
  const [navigationResizing, setNavigationResizing] = useState(false);
  const getNavigationMaximumWidth = useCallback(
    () => Math.max(
      shellNavigationMetrics.expandedMinimumWidth,
      Math.min(
        shellNavigationMetrics.expandedMaximumWidth,
        shellWidth.get()
          - (sidebarOpen ? sidebarWidth : 0)
          - shellSpaceMetrics.mainMinimum
          - (rightPanelOpen && !rightPanelFullWidth ? shellSpaceMetrics.rightMinimum : 0),
      ),
    ),
    [shellWidth, sidebarOpen, sidebarWidth, rightPanelOpen, rightPanelFullWidth],
  );
  const primaryMotion = useSidecarPrimaryMotion({
    isVisible: navigationOpen,
    committedExpandedWidth: navigationController.width,
    committedFrameWidth: navigationController.projection.railWidth,
    compactWidth: shellNavigationMetrics.compactWidth,
    expandedMinimumWidth: shellNavigationMetrics.expandedMinimumWidth,
    getMaximumWidth: getNavigationMaximumWidth,
  });
  const finishNavigationResize = useCallback((result: SidecarPrimaryResizeCommit) => {
    primaryMotion.settleResize(result, settled => {
      if (settled.detent === "hidden" && !contextAvailable) {
        // An application without a Context Pane closes the one remaining
        // Sidecar only after its physical Primary frame reaches zero.
        onSidebarCollapse();
        return;
      }
      if (settled.detent === "expanded" && settled.expandedWidth !== null) {
        navigationController.commitWidth(settled.expandedWidth);
      }
      navigationController.commitRailDetent(settled.detent);
    });
  }, [contextAvailable, navigationController, onSidebarCollapse, primaryMotion]);
  const { animatedSize: animatedNavigationWidth, isMounted: navigationMounted } = usePanelAnimation({
    animation: navigationAnimation, isVisible: navigationOpen, size: primaryMotion.frameWidth,
  });
  usePanelVisibilityAnimation(navigationOpen, navigationAnimation);
  const lastDockController = useRef(navigationController);
  if (navigationOpen) lastDockController.current = navigationController;
  const [layoutResizing, setLayoutResizing] = useState(false);
  const [floatingResizing, setFloatingResizing] = useState(false);
  const contextGeometry = useContextPaneGeometry(sidebarWidth);
  const liveSidebarWidth = contextGeometry.frameWidth;
  const contextViewportWidth = contextGeometry.viewportWidth;
  const headerRightWidth = useMotionValue(0);
  const headerLeftFitWidth = useMotionValue(
    getHeaderStartMinimumWidth(windowChrome, sidebarOpen),
  );
  const sidebarAnimation = useMotionValue(sidebarOpen ? 1 : 0);
  const rightPanelAnimation = useMotionValue(rightPanelOpen ? 1 : 0);
  const fullWidthProgress = useMotionValue(rightPanelFullWidth ? 1 : 0);
  const mainLayoutSnapshot=useRef({scope:layoutScope,layout:mainContentLayout});
  const isMainPaneExiting=rightPanelFullWidth && fullWidthProgress.get()!==1
    && mainLayoutSnapshot.current.scope===layoutScope;
  if(!isMainPaneExiting)mainLayoutSnapshot.current={scope:layoutScope,layout:mainContentLayout};
  const presentedMainContentLayout=isMainPaneExiting?mainLayoutSnapshot.current.layout:mainContentLayout;
  const zeroWidth = useMotionValue(0);
  const rightPanelLayoutTick = useMotionValue(0);
  const [rightPanelPresentationActive, setRightPanelPresentationActive] =
    useState(rightPanelOpen || rightPanelAnimation.get() > 0.001);
  const mainContentViewportRef = useRef<HTMLDivElement | null>(null);
  const [threadEdgeScrollEligible, setThreadEdgeScrollEligible] =
    useState(false);
  const {
    headerEdgeScroll: isHeaderEdgeScroll,
    threadEdgeDivider,
  } = resolveAppShellMainContentChrome({
    layout: presentedMainContentLayout,
    threadEdgeScrollEligible,
  });
  const {
    animatedSize: animatedSidebarWidth,
    isMounted: desktopDockMounted,
    progress: sidebarProgress,
  } = usePanelAnimation({
    animation: sidebarAnimation,
    isVisible: sidebarOpen,
    size: liveSidebarWidth,
  });
  // Subscribe the reader before the writer so a reduced-motion snap to zero
  // still produces the terminal unmount render in this component.
  usePanelVisibilityAnimation(sidebarOpen, sidebarAnimation);
  useLayoutEffect(() => {
    // Seed synchronously for the first paint. Once mounted, the physical
    // HeaderSlot measures its own max-content rail and becomes authoritative.
    headerLeftFitWidth.set(getHeaderStartMinimumWidth(windowChrome, sidebarOpen));
  }, [headerLeftFitWidth, sidebarOpen, windowChrome]);
  useLayoutEffect(() => {
    if (rightPanelOpen) {
      setRightPanelPresentationActive(true);
      return;
    }

    const settleIfClosed = (progress = rightPanelAnimation.get()) => {
      if (progress <= 0.001) setRightPanelPresentationActive(false);
    };
    settleIfClosed();
    const unsubscribeChange = rightPanelAnimation.on("change", settleIfClosed);
    const unsubscribeComplete = rightPanelAnimation.on(
      "animationComplete",
      () => setRightPanelPresentationActive(false),
    );
    return () => {
      unsubscribeChange();
      unsubscribeComplete();
    };
  }, [rightPanelAnimation, rightPanelOpen]);
  const totalLeftWidth = useTransform(
    [animatedNavigationWidth, animatedSidebarWidth],
    ([navigation, conversation]) => Number(navigation) + Number(conversation),
  );
  const sidecarOpacity = useTransform(
    [navigationAnimation, sidebarProgress],
    ([navigation, conversation]) => Math.max(0, Math.min(1, Math.max(Number(navigation), Number(conversation)))),
  );
  const mainContentWidth = useTransform(
    [shellWidth, totalLeftWidth],
    ([width, leftWidth]) => Math.max(0, Number(width) - Number(leftWidth)),
  );
  const initialMainContentWidth = mainContentWidth.get();
  const initialRightPanelWidth = computeRightPanelDefaultWidth({
    mainContentWidth: initialMainContentWidth,
    shellHeight: shellHeight.get(),
    mainContentReserve: shellSpaceMetrics.mainMinimum,
  });
  const rightPanelWidthRatio = useMotionValue(
    normalizeRightPanelWidth(initialRightPanelWidth, initialMainContentWidth, shellSpaceMetrics.mainMinimum),
  );
  const regularRightPanelWidth = useTransform(
    [mainContentWidth, rightPanelWidthRatio],
    ([contentWidth, ratio]) =>
      interpolateRightPanelWidth(Number(ratio), Number(contentWidth), shellSpaceMetrics.mainMinimum),
  );
  // One geometry projection feeds the panel, main Frame and chrome readers.
  // Visibility and full-width are separate inputs, not competing width writers.
  const paneGeometry = useTransform(
    [mainContentWidth, regularRightPanelWidth, rightPanelAnimation, fullWidthProgress],
    ([total, regular, visibility, full]) => workspacePaneGeometry(Number(total),Number(regular),Number(visibility),Number(full)),
  );
  const rightPanelWidth = useTransform(paneGeometry, geometry => geometry.contentWidth);
  const mainFrameWidth = useTransform(paneGeometry, geometry => geometry.frameWidth);
  // This is the width owned by surrounding chrome, not the physical aside.
  // Full-width mode replaces the main viewport and therefore reserves no
  // separate header/floating-bounds gutter in the original AppShell.
  const regularRightPanelAnimatedWidth = useTransform(paneGeometry, geometry => geometry.occupiedWidth);
  const rightPanelAnimatedWidth = rightPanelFullWidth
    ? zeroWidth
    : regularRightPanelAnimatedWidth;
  const regularMainContentTargetWidth = useTransform(
    [mainContentWidth, regularRightPanelWidth],
    ([contentWidth, panelWidth]) =>
      Math.max(0, Number(contentWidth) - Number(panelWidth)),
  );
  const mainContentTargetWidth = !rightPanelOpen
    ? mainContentWidth
    : rightPanelFullWidth
      ? zeroWidth
      : regularMainContentTargetWidth;
  const fullWidthTabBarLeftInset = useTransform(
    [totalLeftWidth, headerLeftFitWidth],
    ([leftWidth, startMinimumWidth]) =>
      Math.max(0, Number(startMinimumWidth) - Number(leftWidth)),
  );
  const rightPanelTabBarLeftInset = rightPanelFullWidth
    ? fullWidthTabBarLeftInset
    : zeroWidth;
  const layoutMotion = useMemo<AppShellLayoutMotion>(
    () => ({
      headerLeftFitWidth,
      headerRightWidth,
      isHeaderEdgeScroll,
      mainContentTargetWidth,
      rightPanelAnimatedWidth,
      rightPanelLayoutTick,
      rightPanelPresentationActive,
      rightPanelTabBarLeftInset,
    }),
    [
      headerLeftFitWidth,
      headerRightWidth,
      isHeaderEdgeScroll,
      mainContentTargetWidth,
      rightPanelAnimatedWidth,
      rightPanelLayoutTick,
      rightPanelPresentationActive,
      rightPanelTabBarLeftInset,
    ],
  );
  const headerLeftSlotWidth = useTransform(
    totalLeftWidth,
    (width) => `${Math.max(0, Number(width))}px`,
  );
  const headerLeftFitWidthPx = useTransform(
    headerLeftFitWidth,
    (width) => `${Math.max(0, Number(width))}px`,
  );
  const shellStyle: AppShellStyle = {
    "--app-shell-left-open-width": `${sidebarWidth}px`,
    "--shell-navigation-bottom-reserve": "calc(var(--height-navigation-row) + 2 * var(--padding-sidebar-entrances))",
  };
  const headerMotionStyle: HeaderMotionStyle = {
    // These must remain two independent geometry signals. The animated panel
    // owns slotWidth; HeaderSlot's off-layout replica owns fitWidth.
    "--app-shell-header-left-slot-width": headerLeftSlotWidth,
    "--app-shell-header-left-fit-width": headerLeftFitWidthPx,
  };
  const getLiveSidebarWidth = useCallback(
    () => liveSidebarWidth.get(),
    [liveSidebarWidth],
  );
  const resizeSidebar = contextGeometry.preview;
  const finishSidebarResize = useCallback(
    (width: number | null) => {
      if (width !== null) {
        contextGeometry.settle(width);
      }
      onSidebarResizeEnd(liveSidebarWidth.get(), width !== null);
    },
    [contextGeometry.settle, liveSidebarWidth, onSidebarResizeEnd],
  );

  useLayoutEffect(() => {
    const shell = shellRootRef.current;
    if (shell === null) return;
    const update = () => {
      const bounds = shell.getBoundingClientRect();
      shellWidth.set(bounds.width);
      shellHeight.set(bounds.height);
      setViewportWidth(bounds.width);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [shellHeight, shellWidth]);

  useLayoutEffect(() => {
    if (mainContentLayout !== "thread-edge-scroll") {
      setThreadEdgeScrollEligible(false);
      return;
    }
    const update = () => {
      setThreadEdgeScrollEligible(
        resolveThreadEdgeScroll({
          shellWidthPx: shellWidth.get(),
          rightChromeWidthPx: regularRightPanelAnimatedWidth.get(),
          rightPanelFullWidth,
          rootFontSizePx: readRootFontSizePx(),
        }),
      );
    };
    update();
    const stopShell = shellWidth.on("change", update);
    const stopRight = regularRightPanelAnimatedWidth.on("change", update);
    return () => { stopShell(); stopRight(); };
  }, [shellWidth, regularRightPanelAnimatedWidth, mainContentLayout, rightPanelFullWidth]);

  const floatingLayout = floatingSidebarLayout({ viewportWidth, contextWidth: sidebarWidth, primaryWidth: navigationController.width,
    contextAvailable, navigationAvailable: !!navigation, expanded: navigationController.state.lastVisibleRailDetent === "expanded" });
  const floatingPrimaryWidth = useMotionValue(floatingLayout.primaryWidth);
  useLayoutEffect(() => { floatingPrimaryWidth.set(floatingLayout.primaryWidth); }, [floatingPrimaryWidth, floatingLayout.primaryWidth]);
  const floatingWidth = useTransform([liveSidebarWidth, floatingPrimaryWidth, shellWidth], ([context, primary, viewport]) =>
    Math.min(Math.max(0, Number(viewport) - 24), contextAvailable ? Number(primary) + Number(context) : Math.max(260, Number(context))));
  const floatingWidthPx = useTransform(floatingWidth, width => `${width}px`);
  const floatingNavigationWidth = contextAvailable ? floatingPrimaryWidth : floatingWidth;
  const floatingContextViewportWidth = useTransform([contextViewportWidth, shellWidth, floatingPrimaryWidth], ([viewport, windowWidth, primary]) =>
    Math.min(Number(viewport), Math.max(0, Number(windowWidth) - 24 - Number(primary))));
  const floatingIntent = useSidebarDockIntent({
    docked: sidebarOpen || navigationOpen,
    enabled: sidebarTransientEnabled && !navigationOpen && !navigationResizing,
    getPanelWidth: () => floatingWidth.get(),
    lockOpen: floatingResizing || sidebarPeek,
  });
  const sidebarPresentation = resolveSidebarPresentation({
    docked: sidebarOpen,
    layoutMounted: desktopDockMounted,
    layoutResizing,
    floatingRequested: floatingIntent.requested || sidebarPeek,
    floatingResizing,
  });
  const showDockedSidebar = sidebarOpen || desktopDockMounted || layoutResizing;
  const showFloatingSidebar = sidebarPresentation === "floating";
  const floatingController = { ...navigationController, projection: { ...navigationController.projection,
    railDetent: floatingLayout.detent, railWidth: floatingLayout.primaryWidth, railVisible: true,
    dockOpen: true, dockAvailable: false, footerVisible: true, primaryNavigation: true,
    docked: { applications: true, account: navigationController.state.pinned.account },
    peek: navigationController.state.peek,
  } };
  const toggleFloatingApplications = () => {
    if (!floatingLayout.canExpand) navigationController.dispatch({ type: "toggle", surface: "applications", dockAvailable: false });
    else navigationController.commitRailDetent(floatingLayout.detent === "compact" ? "expanded" : "compact");
  };
  const mountFloatingPresenceOwner = shouldMountFloatingSidebarPresenceOwner({
    docked: sidebarOpen,
    layoutMounted: desktopDockMounted,
    layoutResizing,
  });
  const dockFloatingSidebar = useCallback(() => {
    if (viewportWidth < (contextAvailable ? sidebarWidth : shellSpaceMetrics.compact) + shellSpaceMetrics.mainMinimum) {
      setSidebarPeek(false);
      return;
    }
    // Codex pins the floating panel without replaying the layout entrance.
    sidebarProgress.stop();
    sidebarProgress.set(1);
    setSidebarPeek(false);
    onSidebarExpand();
  }, [contextAvailable, onSidebarExpand, sidebarProgress, sidebarWidth, viewportWidth]);

  const toggleSidebar = useCallback(() => {
    if (sidebarPeek || showFloatingSidebar) { floatingIntent.dismiss(); setSidebarPeek(false); return; }
    if (sidebarOpen || navigationOpen) { onSidebarCollapse(); return; }
    if (viewportWidth < (contextAvailable ? sidebarWidth : shellSpaceMetrics.compact) + shellSpaceMetrics.mainMinimum) {
      setSidebarPeek(true);
    } else onSidebarExpand();
  }, [sidebarPeek, showFloatingSidebar, floatingIntent.dismiss, sidebarOpen, navigationOpen, onSidebarCollapse, onSidebarExpand, viewportWidth, contextAvailable, sidebarWidth]);
  const toggleRightPanel = useCallback(() => {
    if (rightPanelRevealed) { setRightPanelRevealed(false); onRightPanelOpenChange(false); return; }
    if (rightPanelOpen) onRightPanelOpenChange(false);
    else if (!space.rightOpen) {
      setRightPanelRevealed(true);
      if (!requestedRightPanelOpen) onRightPanelOpenChange(true);
    }
  }, [rightPanelRevealed, rightPanelOpen, space.rightOpen, requestedRightPanelOpen, onRightPanelOpenChange]);

  useLayoutEffect(() => {
    const previous = previousToolIntent.current;
    previousToolIntent.current = { layoutScope, open: requestedRightPanelOpen };
    if (previous.layoutScope !== layoutScope || space.rightOpen || !requestedRightPanelOpen) setRightPanelRevealed(false);
    else if (!previous.open && requestedRightPanelOpen) setRightPanelRevealed(true);
  }, [layoutScope, space.rightOpen, requestedRightPanelOpen]);
  useLayoutEffect(() => {
    if (sidebarOpen || navigationOpen) setSidebarPeek(false);
  }, [sidebarOpen, navigationOpen]);
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && shellRootRef.current?.contains(focused)
      && focused.closest('[inert], [aria-hidden="true"]')) {
      const destination = !rightPanelFullWidth ? mainContentViewportRef.current
        : shellRootRef.current.querySelector<HTMLButtonElement>('.app-shell-header__right-panel-toggle');
      destination?.focus({ preventScroll: true });
    }
  }, [sidebarOpen, navigationOpen, rightPanelOpen, rightPanelFullWidth]);
  useLayoutEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      if (sidebarCollapsible && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b" && !event.shiftKey && !event.altKey) {
        event.preventDefault(); event.stopImmediatePropagation(); toggleSidebar();
      }
      if (event.key === "Escape" && showFloatingSidebar && !event.defaultPrevented) {
        floatingIntent.dismiss();
        setSidebarPeek(false);
        shellRootRef.current?.querySelector<HTMLButtonElement>('[data-app-shell-sidebar-trigger]')?.focus();
      }
    };
    const pointerdown = (event: PointerEvent) => {
      if (showFloatingSidebar && event.target instanceof Element
        && !event.target.closest('.app-shell-floating-left-panel, [data-app-shell-sidebar-trigger]')) {
        floatingIntent.dismiss(); setSidebarPeek(false);
      }
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("pointerdown", pointerdown);
    return () => { window.removeEventListener("keydown", keydown, true); window.removeEventListener("pointerdown", pointerdown); };
  }, [showFloatingSidebar, floatingIntent.dismiss, toggleSidebar]);

  // Subscribe every dock/overlay geometry reader before asking the owner to
  // synchronize external preferences. Earlier writes can be missed by a newly
  // installed MotionValue transform and leave it stale until another render.
  useLayoutEffect(() => {
    contextGeometry.synchronize(sidebarWidth, layoutResizing || floatingResizing);
  }, [contextGeometry.synchronize, sidebarWidth, layoutResizing, floatingResizing]);
  useWorkspacePaneAnimation(fullWidthProgress, rightPanelAnimation, rightPanelFullWidth, layoutScope, rightPanelOpen);

  return (
    <ShellPresentationContext.Provider value={{
      sidebarOpen: sidebarOpen || navigationOpen || sidebarPeek,
      rightPanelOpen, rightPanelFullWidth, toggleSidebar, toggleRightPanel,
    }}>
    <AppShellLayoutMotionContext.Provider value={layoutMotion}>
      <ApplicationShellRoot
        className={navigation ? "has-shell-navigation" : undefined}
        rootRef={shellRootRef}
        windowChrome={windowChrome}
        sidebarOpen={sidebarOpen}
        sidebarMounted={desktopDockMounted}
        sidebarPresentation={sidebarPresentation}
        sidecarPrimaryDetent={navigationController.projection.railDetent}
        style={shellStyle}
      >
        {sidebarTransientEnabled && mountFloatingPresenceOwner ? (
          <FloatingLeftPanel
            header={floatingSidebarHeader(dockFloatingSidebar)}
            visible={showFloatingSidebar}
            width={sidebarWidth}
            widthPx={floatingWidthPx}
            getCurrentWidth={() => contextAvailable ? floatingWidth.get() - floatingPrimaryWidth.get() : floatingWidth.get()}
            getMaximumWidth={() => Math.max(240, Math.min(SIDEBAR_MAXIMUM_WIDTH, shellWidth.get() - (contextAvailable ? floatingLayout.primaryWidth : 0) - 24))}
            onResize={resizeSidebar}
            onResizeEnd={finishSidebarResize}
            onResizingChange={setFloatingResizing}
            footer={navigation ? <div className="sidecar-content-slot" ref={setFloatingFooterHost} /> : null}
          >
            <div className="floating-sidebar-panes">
              {navigation ? <motion.div className="floating-sidebar-primary" style={{ width: floatingNavigationWidth }}><div className="sidecar-content-slot" ref={setFloatingPrimaryHost} /></motion.div> : null}
              {contextAvailable ? <div className="floating-sidebar-context"><motion.div className="floating-sidebar-context__viewport" style={{ width: floatingContextViewportWidth }}><div className="sidecar-content-slot" ref={setFloatingContextHost} /></motion.div></div> : null}
            </div>
          </FloatingLeftPanel>
        ) : null}
        <SharedSidebarContent
          primary={{ target: showFloatingSidebar ? floatingPrimaryHost : dockedPrimaryHost, content: navigation ? <ShellNavigationDock
            config={navigation} controller={showFloatingSidebar ? floatingController : navigationOpen ? navigationController : lastDockController.current}
            expandedWidth={showFloatingSidebar ? floatingNavigationWidth : primaryMotion.viewportWidth}
            frameWidth={showFloatingSidebar ? floatingNavigationWidth : primaryMotion.frameWidth} /> : null }}
          context={{ target: showFloatingSidebar ? floatingContextHost : dockedContextHost, content: leftPanel }}
          footer={{ target: showFloatingSidebar ? floatingFooterHost : dockedFooterHost, content: navigation ? <ShellNavigationFooter
            config={navigation} controller={showFloatingSidebar ? floatingController : navigationController}
            visible={showFloatingSidebar || navigationController.projection.footerVisible}
            entranceId="shared-shell-entrance"
            onTogglePrimaryNavigation={showFloatingSidebar ? toggleFloatingApplications : onSidebarCollapse} /> : null }}
        />
        <div className="app-shell-row">
          <Sidecar animatedWidth={totalLeftWidth} footer={navigation ? <motion.div
            className="app-shell-sidecar__footer"
            data-compact-only={space.navigationDetent === "compact" && !sidebarOpen}
            style={{ opacity: sidecarOpacity }}
            hidden={!navigationOpen && !showDockedSidebar}
            inert={!navigationController.projection.footerVisible || undefined}
            aria-hidden={!navigationController.projection.footerVisible || undefined}>
            <div className="sidecar-content-slot" ref={setDockedFooterHost} />
          </motion.div> : null}>
          {navigation && (navigationOpen || navigationMounted) ? <SidecarPane
            animatedSize={animatedNavigationWidth}
            className="shell-navigation__dock"
            label="Pinned navigation"
            open={navigationOpen}
            contentOpacity={navigationAnimation}
            viewportSize={primaryMotion.viewportWidth}
            viewportClassName="shell-navigation__viewport"
            resizeHandle={navigationOpen ? <SidecarPrimaryResizeHandle label="Resize applications"
              compactWidth={shellNavigationMetrics.compactWidth}
              defaultWidth={shellNavigationMetrics.columnWidth}
              detent={visibleNavigationDetent}
              expandedWidth={navigationController.width}
              getMaximumWidth={getNavigationMaximumWidth}
              getCurrentWidth={() => primaryMotion.frameWidth.get()}
              onCancel={primaryMotion.cancelResize}
              onCommit={finishNavigationResize}
              onPreview={primaryMotion.previewResize}
              onResizingChange={resizing => {
                if (resizing) primaryMotion.beginResize();
                setNavigationResizing(resizing);
              }} /> : null}>
            <div className="sidecar-content-slot" ref={setDockedPrimaryHost} />
          </SidecarPane> : null}
          {showDockedSidebar ? (
            <SidecarPane
              animatedSize={animatedSidebarWidth}
              className="app-shell-left-panel"
              open={sidebarOpen}
              contentOpacity={sidebarProgress}
              viewportSize={contextViewportWidth}
              viewportClassName="app-shell-left-panel__viewport"
              resizeHandle={sidebarResizable ? <SidebarResizeHandle
                  collapsible={sidebarCollapsible}
                  getCurrentWidth={getLiveSidebarWidth}
                  getMaximumWidth={() => Math.max(240, Math.min(SIDEBAR_MAXIMUM_WIDTH, shellWidth.get() - space.navigationWidth
                    - shellSpaceMetrics.mainMinimum - (rightPanelOpen && !rightPanelFullWidth ? shellSpaceMetrics.rightMinimum : 0)))}
                  width={sidebarWidth}
                  onCollapse={onSidebarCollapse}
                  onExpand={onSidebarExpand}
                  onResize={resizeSidebar}
                  onResizeEnd={finishSidebarResize}
                  onResizingChange={setLayoutResizing}
                /> : null}
            >
              <div className="sidecar-content-slot" ref={setDockedContextHost} />
            </SidecarPane>
          ) : null}
          </Sidecar>

          <main
            className="main-content-surface"
            data-app-shell-main-surface="default"
          >
            <motion.div
              className="app-shell-header-motion-host"
              style={headerMotionStyle}
            >
              {header}
            </motion.div>
            <ComposerOverlayAnchorContext.Provider value={composerOverlayAnchor}>
            <FloatingComposerRegistryContext.Provider value={floatingComposers}>
            <FloatingComposerScopeContext.Provider value={layoutScope}>
            <div className="main-content-body" ref={composerOverlayAnchor}>
              <div
                ref={mainContentViewportRef}
                tabIndex={-1}
                className="main-content-viewport"
                inert={rightPanelFullWidth || undefined}
                aria-hidden={rightPanelFullWidth || undefined}
                data-app-shell-main-content-layout={presentedMainContentLayout}
                data-app-shell-main-pane-exiting={isMainPaneExiting}
                data-app-shell-thread-edge-scroll={isHeaderEdgeScroll}
                data-app-shell-right-panel-full-width={rightPanelFullWidth}
              >
                <motion.div
                  className="main-content-frame"
                  style={{ width: mainFrameWidth }}
                  data-app-shell-thread-edge-divider={threadEdgeDivider}
                >
                  <div className="main-content-frame__inner">
                    <div
                      className="main-content-top-fade"
                      data-app-shell-main-content-top-fade="full-bleed"
                      aria-hidden="true"
                    />
                    <div className="main-content-slot">{children}</div>
                  </div>
                </motion.div>
              </div>
              <AppShellRightPanel
                animation={rightPanelAnimation}
                fullWidth={rightPanelFullWidth}
                mainContentWidth={mainContentWidth}
                open={rightPanelOpen}
                rightPanelWidth={rightPanelWidth}
                rightPanelWidthRatio={rightPanelWidthRatio}
                rightPanelLayoutTick={rightPanelLayoutTick}
                shellHeight={shellHeight}
                onOpenChange={onRightPanelOpenChange}
              >
                {rightPanel}
              </AppShellRightPanel>
            </div>
            </FloatingComposerScopeContext.Provider>
            </FloatingComposerRegistryContext.Provider>
            </ComposerOverlayAnchorContext.Provider>
          </main>
        </div>
      </ApplicationShellRoot>
    </AppShellLayoutMotionContext.Provider>
    </ShellPresentationContext.Provider>
  );
}
