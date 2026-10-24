import { SearchIcon as Search } from "@opencraft/design-system-web/action-icons";
import { canHandleWorkbenchShortcut, matchesWorkbenchShortcut } from "../workbench-shortcuts";

import { NavigationIcon } from "./shell-navigation/navigation-action";
import { focusChromeAction } from "../chrome-actions/use-chrome-action-focus";
// OpenCraft services/scope policy and Viewport/Frame ownership. Geometry does not reuse animation aperture width
// as chat layout width. See design/invariants.md SHL-01 through SHL-04.
import {
  motion,
  useMotionValue,
  useReducedMotion,
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
import { createPortal } from "react-dom";
import { getAppearanceThemeShellMaterial, useAppearanceTheme } from "../appearance-theme";

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
  resolveSidebarToggleAction,
  shouldMountFloatingSidebarPresenceOwner,
} from "../sidebar-dock-model";
import {
  computeRightPanelDefaultWidth,
  interpolateRightPanelWidth,
  normalizeRightPanelWidth,
} from "@opencraft/workbench-panels";
import { FloatingLeftPanel } from "./floating-left-panel";
import { Sidecar, SidecarPane } from "./sidecar";
import { headerSurfaceGeometry, titlebarSurfaceGeometry } from "./titlebar-surface-geometry";
import { SharedSidebarContent } from "./shared-sidebar-content";
import { floatingSidebarLayout } from "./floating-sidebar-layout";
import { mobileSidebarWidth } from "./mobile-sidebar-gesture";
import { useMobileSidebarGesture } from "./use-mobile-sidebar-gesture";
import { useContextPaneGeometry } from "./use-context-pane-geometry";
import { AppShellRightPanel } from "./app-shell-right-panel";
import { ComposerOverlayAnchorContext, FloatingComposerRegistryContext, FloatingComposerScopeContext } from "./thread-composer-presentation";
import { FloatingComposerRegistry } from "./floating-composer-state";
import {
  SidebarResizeHandle,
  SIDEBAR_MAXIMUM_WIDTH,
  sidebarWidthMetrics,
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
import { ShellPresentationContext, SidebarDismissContext } from "./shell-presentation";
import { ShellNavigationDock, ShellNavigationFooter, useShellNavigation, type ShellNavigationConfig } from "./shell-navigation";

interface AppShellProps {
  navigation?: ShellNavigationConfig;
  layoutScope: string;
  mainContentLayout: AppShellMainContentLayout;
  /** Physical window chrome stays mounted while routes replace shell content. */
  header: ReactElement | null;
  floatingSidebarHeader(onDock: () => void): ReactNode;
  /** Optional application context. Chat supplies a conversation list; other apps may omit it. */
  leftPanel?: ReactNode;
  rightPanel: ReactNode;
  rightPanelKeepMounted?: boolean;
  rightPanelOpen: boolean;
  rightPanelFullWidth: boolean;
  rightPanelDefaultSize?: "standard" | "compact";
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
  "--app-shell-brand-header-width": string;
  "--shell-sidebar-icon-rail-width": string;
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
      data-opencraft-window-type={windowChrome.kind}
      data-opencraft-platform={windowChrome.platform}
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
  "--app-shell-header-leading-paint-width": MotionValue<string>;
  "--app-shell-header-trailing-paint-width": MotionValue<string>;
  "--app-shell-header-left-slot-width": MotionValue<string>;
  "--app-shell-titlebar-extension-left": MotionValue<string>;
  "--app-shell-titlebar-extension-width": MotionValue<string>;
  "--app-shell-titlebar-divider-progress": MotionValue<number>;
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
  rightPanelKeepMounted = false,
  rightPanelOpen: requestedRightPanelOpen,
  rightPanelFullWidth: requestedRightPanelFullWidth,
  rightPanelDefaultSize = "standard",
  sidebarCollapsible = true,
  sidebarTransientEnabled = true,
  sidebarResizable = true,
  sidebarOpen: sidecarOpen,
  sidebarWidth: requestedSidebarWidth,
  windowChrome,
  onSidebarCollapse,
  onSidebarExpand,
  onSidebarResizeEnd,
  onRightPanelOpenChange,
  children,
}: AppShellProps) {
  const shellRootRef = useRef<HTMLDivElement | null>(null);
  const floatingOverlayRef = useRef<HTMLDivElement | null>(null);
  const [composerOverlayAnchor, setComposerOverlayAnchor] = useState<HTMLDivElement | null>(null);
  const [floatingComposers] = useState(() => new FloatingComposerRegistry());
  const shellWidth = useMotionValue(window.innerWidth);
  const shellHeight = useMotionValue(window.innerHeight);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [drawerRequested, setDrawerRequested] = useState(false);
  const [floatingExitOwnsContent, setFloatingExitOwnsContent] = useState(false);
  const [rightPanelRevealed, setRightPanelRevealed] = useState(false);
  const previousToolIntent = useRef({ layoutScope, open: requestedRightPanelOpen });
  const unifiedNavigation = navigation?.layout === "unified";
  const sidebarMetrics = sidebarWidthMetrics(unifiedNavigation);
  const preferredSidebarWidth = unifiedNavigation
    ? Math.max(sidebarMetrics.minimumWidth, Math.min(requestedSidebarWidth, sidebarMetrics.maximumWidth))
    : requestedSidebarWidth;
  // A unified sidebar can hold only global destinations on application routes.
  // Reclaim its absent context on desktop without writing the conversation-width
  // preference or changing the small-screen drawer presentation.
  const navigationOnly = unifiedNavigation && leftPanel == null
    && viewportWidth >= preferredSidebarWidth + shellSpaceMetrics.mainMinimum;
  const sidebarWidth = navigationOnly ? sidebarMetrics.railWidth : preferredSidebarWidth;
  const contextAvailable = unifiedNavigation || leftPanel != null;
  const [dockedPrimaryHost, setDockedPrimaryHost] = useState<HTMLDivElement | null>(null);
  const [dockedContextHost, setDockedContextHost] = useState<HTMLDivElement | null>(null);
  const [dockedFooterHost, setDockedFooterHost] = useState<HTMLDivElement | null>(null);
  const [floatingPrimaryHost, setFloatingPrimaryHost] = useState<HTMLDivElement | null>(null);
  const [floatingContextHost, setFloatingContextHost] = useState<HTMLDivElement | null>(null);
  const [mobileSidebarActionHost, setMobileSidebarActionHost] = useState<HTMLDivElement | null>(null);
  const [floatingFooterHost, setFloatingFooterHost] = useState<HTMLDivElement | null>(null);
  const navigationController = useShellNavigation({
    // Dock/visibility policy is stable for the gesture. Actual pane and main
    // geometry below use live MotionValues, never this saved width.
    viewportWidth, contextWidth: sidebarWidth, contextMinimumWidth: unifiedNavigation ? navigationOnly ? sidebarMetrics.railWidth : sidebarMetrics.minimumWidth : undefined, contextAvailable, sidecarOpen,
    enabled: navigation !== undefined, allowDock: navigation?.allowDock,
    unified: unifiedNavigation,
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
  const appearance = useAppearanceTheme();
  const recessedHeader = windowChrome.kind === "browser"
    && Boolean(getAppearanceThemeShellMaterial(appearance)?.recessedHeaderBackground);
  const [threadEdgeScrollEligible, setThreadEdgeScrollEligible] =
    useState(false);
  const {
    headerEdgeScroll: isHeaderEdgeScroll,
    threadEdgeDivider,
  } = resolveAppShellMainContentChrome({
    layout: presentedMainContentLayout,
    threadEdgeScrollEligible,
    recessedHeader,
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
    size: rightPanelDefaultSize,
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
    ([total, regular, visibility, full]) => workspacePaneGeometry(
      Number(total), Number(regular), Number(visibility), Number(full), shellSpaceMetrics.mainMinimum,
    ),
  );
  const rightPanelWidth = useTransform(paneGeometry, geometry => geometry.contentWidth);
  // Maximization moves the aperture, not the tool's layout viewport. Retain
  // that mode while hidden; the next visible intent chooses its own endpoint.
  const rightPanelContentFullWidth = useRef(rightPanelFullWidth);
  if (rightPanelOpen) rightPanelContentFullWidth.current = rightPanelFullWidth;
  const rightPanelContentWidth = rightPanelContentFullWidth.current
    ? mainContentWidth : regularRightPanelWidth;
  const mainFrameWidth = useTransform(paneGeometry, geometry => geometry.frameWidth);
  // This is the width owned by surrounding chrome, not the physical aside.
  // Full-width mode replaces the main viewport and therefore reserves no
  // separate header/floating-bounds gutter in AppShell.
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
  // Paint and pane movement consume the same current frames, including drag,
  // reversal and reduced-motion snaps. No terminal-mount or extra CSS timer.
  const titlebarSurface = useTransform(
    [animatedNavigationWidth, animatedSidebarWidth, sidebarProgress],
    ([primary, context, progress]) => titlebarSurfaceGeometry(Number(primary), Number(context), Number(progress)),
  );
  const titlebarExtensionLeft = useTransform(titlebarSurface, surface => `${surface.extensionLeft}px`);
  const titlebarExtensionWidth = useTransform(titlebarSurface, surface => `${surface.extensionWidth}px`);
  const titlebarDividerProgress = useTransform(titlebarSurface, surface => surface.dividerProgress);
  const headerSurface = useTransform(() => headerSurfaceGeometry(
    shellWidth.get(), totalLeftWidth.get() + paneGeometry.get().viewportWidth,
    headerLeftFitWidth.get(), headerRightWidth.get(),
  ));
  const headerLeadingPaintWidth = useTransform(headerSurface, surface => `${surface.leadingWidth}px`);
  const headerTrailingPaintWidth = useTransform(headerSurface, surface => `${surface.trailingWidth}px`);
  const shellStyle: AppShellStyle = {
    "--app-shell-left-open-width": `${sidebarWidth}px`,
    "--app-shell-brand-header-width": `${sidebarMetrics.defaultWidth}px`,
    "--shell-sidebar-icon-rail-width": `${sidebarMetrics.railWidth}px`,
    "--shell-navigation-bottom-reserve": "calc(var(--height-navigation-row) + 2 * var(--padding-sidebar-entrances))",
  };
  const headerMotionStyle: HeaderMotionStyle = {
    "--app-shell-header-leading-paint-width": headerLeadingPaintWidth,
    "--app-shell-header-trailing-paint-width": headerTrailingPaintWidth,
    // Panel animation may widen the aperture; CSS intrinsic sizing reserves
    // the rail immediately. Header's sole measured writer only projects its
    // width to other chrome consumers, never back into this rail's layout.
    "--app-shell-header-left-slot-width": headerLeftSlotWidth,
    "--app-shell-titlebar-extension-left": titlebarExtensionLeft,
    "--app-shell-titlebar-extension-width": titlebarExtensionWidth,
    "--app-shell-titlebar-divider-progress": titlebarDividerProgress,
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
    contextAvailable, navigationAvailable: !!navigation && !unifiedNavigation, expanded: navigationController.state.lastVisibleRailDetent === "expanded" });
  const floatingPrimaryWidth = useMotionValue(floatingLayout.primaryWidth);
  useLayoutEffect(() => { floatingPrimaryWidth.set(floatingLayout.primaryWidth); }, [floatingPrimaryWidth, floatingLayout.primaryWidth]);
  // One capacity decision drives commands, mobile layout and pinning. Automatic
  // space hysteresis affects resize only; an explicit expand resets that history.
  const searchAction = navigation?.actions.find(action => action.id === "shell.search");
  const overviewAction = navigation?.actions.find(action => action.id === "shell.overview");
  const canDockSidebar = viewportWidth >= (contextAvailable ? sidebarWidth : shellSpaceMetrics.compact) + shellSpaceMetrics.mainMinimum;
  const expandSidebar = useCallback(() => {
    navigationController.requestDock();
    onSidebarExpand();
  }, [navigationController.requestDock, onSidebarExpand]);
  const mobileSidebarEnabled = windowChrome.kind === "browser" && unifiedNavigation && sidebarTransientEnabled
    && !canDockSidebar;
  const primaryNavigation = useMemo(() => navigation && mobileSidebarEnabled
    ? { ...navigation, actions: navigation.actions.filter(action => action.id !== "shell.overview") }
    : navigation, [navigation, mobileSidebarEnabled]);
  const floatingWidth = useTransform([liveSidebarWidth, floatingPrimaryWidth, shellWidth], ([context, primary, viewport]) =>
    Math.min(Math.max(0, Number(viewport) - 24), mobileSidebarEnabled
      ? mobileSidebarWidth(Number(viewport), Number(context))
      : contextAvailable ? Number(primary) + Number(context) : Math.max(260, Number(context))));
  const floatingWidthPx = useTransform(floatingWidth, width => `${width}px`);
  const floatingNavigationWidth = contextAvailable ? floatingPrimaryWidth : floatingWidth;
  const floatingContextViewportWidth = useTransform([contextViewportWidth, shellWidth, floatingPrimaryWidth], ([viewport, windowWidth, primary]) =>
    Math.min(Number(viewport), Math.max(0, Number(windowWidth) - 24 - Number(primary))));
  const floatingIntent = useSidebarDockIntent({
    docked: sidebarOpen || navigationOpen,
    enabled: !unifiedNavigation && sidebarTransientEnabled && !navigationOpen && !navigationResizing,
    getPanelWidth: () => floatingWidth.get(),
    lockOpen: floatingResizing || drawerRequested,
  });
  const mobileGesture = useMobileSidebarGesture({
    enabled: mobileSidebarEnabled && !sidebarOpen && !desktopDockMounted && !layoutResizing,
    open: floatingIntent.requested || drawerRequested, width: floatingWidth,
    root: shellRootRef, overlay: floatingOverlayRef,
    onOpenChange: open => { if (!open) floatingIntent.dismiss(); setDrawerRequested(open); },
  });
  // One progress drives foreground travel and stationary sidebar depth; translating the row leaves the root's
  // viewport coordinates (and gesture acquisition) unchanged.
  const mobilePageX = useTransform([mobileGesture.progress, floatingWidth], ([progress, width]) =>
    Math.max(0, Math.min(1, Number(progress))) * Number(width));
  const reducedMotion = useReducedMotion();
  const mobilePageWash = useTransform(mobileGesture.progress, value => reducedMotion ? 0 : 0.65 * Math.max(0, Math.min(1, value)));
  // The physical browser surface is portaled outside the moving row. Publish
  // position changes too: ResizeObserver cannot see an ancestor translation.
  useLayoutEffect(() => mobilePageX.on("change", () => {
    rightPanelLayoutTick.set(rightPanelLayoutTick.get() + 1);
  }), [mobilePageX, rightPanelLayoutTick]);
  const mobilePageBlocked = mobileSidebarEnabled && (drawerRequested || floatingIntent.requested || mobileGesture.dragging);
  const sidebarPresentation = resolveSidebarPresentation({
    docked: sidebarOpen,
    layoutMounted: desktopDockMounted,
    layoutResizing,
    floatingRequested: floatingIntent.requested || drawerRequested || mobileGesture.present,
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
  const floatingRequestedRef = useRef(showFloatingSidebar);
  floatingRequestedRef.current = showFloatingSidebar;
  // A close intent starts the exit animation; it does not move the shared
  // content or uncover the conversation until the floating surface has left.
  useLayoutEffect(() => {
    if (!mountFloatingPresenceOwner) setFloatingExitOwnsContent(false);
    else if (showFloatingSidebar) setFloatingExitOwnsContent(true);
  }, [mountFloatingPresenceOwner, showFloatingSidebar]);
  const floatingOwnsContent = mountFloatingPresenceOwner
    && (showFloatingSidebar || floatingExitOwnsContent);
  const finishFloatingExit = useCallback(() => {
    if (!floatingRequestedRef.current) setFloatingExitOwnsContent(false);
  }, []);
  const dockFloatingSidebar = useCallback(() => {
    if (!canDockSidebar) {
      setDrawerRequested(false);
      return;
    }
    sidebarProgress.stop();
    sidebarProgress.set(1);
    setDrawerRequested(false);
    expandSidebar();
  }, [canDockSidebar, expandSidebar, sidebarProgress]);
  const dismissFloatingSidebar = useCallback(() => {
    floatingIntent.dismiss();
    setDrawerRequested(false);
  }, [floatingIntent.dismiss]);

  const dismissSidebarAfterSelection = useCallback(() => {
    if (mobileSidebarEnabled) dismissFloatingSidebar();
  }, [mobileSidebarEnabled, dismissFloatingSidebar]);

  const sidebarToggleFocusPending = useRef(false);
  const toggleSidebar = useCallback(() => {
    sidebarToggleFocusPending.current = document.activeElement instanceof Element
      && document.activeElement.matches("[data-app-shell-sidebar-trigger]:not([data-sidebar-toggle-stationary])");
    switch (resolveSidebarToggleAction({ docked: sidebarOpen || navigationOpen,
      drawerOpen: drawerRequested || floatingIntent.requested, canDock: canDockSidebar })) {
      case "close-drawer": dismissFloatingSidebar(); break;
      case "collapse": onSidebarCollapse(); break;
      case "open-drawer": setDrawerRequested(true); break;
      case "expand": expandSidebar(); break;
    }
  }, [drawerRequested, floatingIntent.requested, dismissFloatingSidebar, sidebarOpen, navigationOpen, onSidebarCollapse, expandSidebar, canDockSidebar]);
  useLayoutEffect(() => {
    if (!sidebarToggleFocusPending.current) return;
    const targets = [shellRootRef.current, floatingOverlayRef.current].flatMap(root =>
      root ? Array.from(root.querySelectorAll<HTMLButtonElement>("[data-app-shell-sidebar-trigger]")) : []);
    const target = targets
      .find(button => !button.closest('[inert], [aria-hidden="true"]')
        && button.getBoundingClientRect().width > 0 && button.getBoundingClientRect().height > 0);
    if (target) {
      target.focus({ preventScroll: true });
      sidebarToggleFocusPending.current = false;
    }
  }, [sidebarOpen, navigationOpen, drawerRequested, showFloatingSidebar, floatingOwnsContent]);

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
    if (unifiedNavigation && canDockSidebar && drawerRequested) {
      // Transfer an explicitly opened small-screen drawer into its desktop dock.
      // Never leave the mobile request holding a third desktop presentation.
      expandSidebar();
      setDrawerRequested(false);
    } else if (sidebarOpen || navigationOpen) setDrawerRequested(false);
  }, [unifiedNavigation, canDockSidebar, drawerRequested, expandSidebar, sidebarOpen, navigationOpen]);
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
      if (sidebarCollapsible && canHandleWorkbenchShortcut(event) && matchesWorkbenchShortcut(event, "sidebar", navigator.platform)) {
        event.preventDefault(); event.stopImmediatePropagation(); toggleSidebar();
      }
      if (event.key === "Escape" && showFloatingSidebar && !event.defaultPrevented) {
        // Mobile releases the foreground's inert state in the next commit.
        // Wide touch chrome can restore its portalled control immediately.
        sidebarToggleFocusPending.current = mobileSidebarEnabled;
        dismissFloatingSidebar();
        if (!focusChromeAction('sidebar-toggle', 'persistent')) {
          shellRootRef.current?.querySelector<HTMLButtonElement>('[data-app-shell-sidebar-trigger]')?.focus();
        }
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => { window.removeEventListener("keydown", keydown, true); };
  }, [showFloatingSidebar, dismissFloatingSidebar, toggleSidebar, mobileSidebarEnabled, sidebarCollapsible]);

  // Subscribe every dock/overlay geometry reader before asking the owner to
  // synchronize external preferences. Earlier writes can be missed by a newly
  // installed MotionValue transform and leave it stale until another render.
  useLayoutEffect(() => {
    contextGeometry.synchronize(sidebarWidth, layoutResizing || floatingResizing);
  }, [contextGeometry.synchronize, sidebarWidth, layoutResizing, floatingResizing]);
  useWorkspacePaneAnimation(fullWidthProgress, rightPanelAnimation, rightPanelFullWidth, layoutScope, rightPanelOpen);

  return (
    <ShellPresentationContext.Provider value={{
      sidebarControlsInSidebar: unifiedNavigation,
      // Control ownership follows intent, not the retained exit/gesture surface.
      // Otherwise the collapsed entrance disappears until the spring settles.
      sidebarOpen: sidebarOpen || navigationOpen || drawerRequested || floatingIntent.requested,
      sidebarFloating: showFloatingSidebar,
      mobileSidebar: mobileSidebarEnabled,
      sidebarActionHost: mobileSidebarEnabled ? mobileSidebarActionHost : null,
      rightPanelOpen, rightPanelFullWidth, toggleSidebar, toggleRightPanel,
      dismissSidebarAfterSelection,
    }}>
    <SidebarDismissContext.Provider value={dismissSidebarAfterSelection}>
    <AppShellLayoutMotionContext.Provider value={layoutMotion}>
      <ApplicationShellRoot
        className={navigation ? `has-shell-navigation${unifiedNavigation ? ` has-unified-sidebar${navigationOnly ? " has-icon-navigation-only" : ""}` : ""}${mobileSidebarEnabled ? " has-mobile-sidebar-gestures" : ""}` : undefined}
        rootRef={shellRootRef}
        windowChrome={windowChrome}
        sidebarOpen={sidebarOpen}
        sidebarMounted={desktopDockMounted}
        sidebarPresentation={sidebarPresentation}
        sidecarPrimaryDetent={navigationController.projection.railDetent}
        style={shellStyle}
      >
        {sidebarTransientEnabled && mountFloatingPresenceOwner && typeof document !== "undefined" ? createPortal(
          <div ref={floatingOverlayRef} className="app-shell-floating-overlay-root" data-mobile-sidebar={mobileSidebarEnabled || undefined} data-sidebar-dragging={mobileGesture.dragging || undefined} style={{
            ...shellStyle,
            "--spacing-token-safe-header-left": `${windowChrome.safeArea.left}px`,
            "--spacing-token-safe-header-right": `${windowChrome.safeArea.right}px`,
          } as CSSProperties}>
          {floatingOwnsContent && !mobileSidebarEnabled ? (
            <motion.button
              type="button"
              className="app-shell-floating-sidebar-dismiss"
              aria-label="Close sidebar"
              onClick={dismissFloatingSidebar}
            />
          ) : null}
          <FloatingLeftPanel
            header={unifiedNavigation ? <div className="shell-sidebar__header">
              {floatingSidebarHeader(dockFloatingSidebar)}
              {mobileSidebarEnabled && overviewAction ? <button
                type="button" className="shell-sidebar__overview shell-sidebar__action" data-action-id="shell.overview.header"
                aria-label={overviewAction.title} onClick={() => overviewAction.onInvoke()}>
                <NavigationIcon name={overviewAction.icon} size={20} />
              </button> : null}
              {mobileSidebarEnabled && searchAction ? <button
                type="button" className="shell-sidebar__search shell-sidebar__action" data-action-id="shell.search.header"
                aria-label={searchAction.title}
                onClick={() => searchAction.onInvoke()}>
                <Search aria-hidden="true" size={20} />
              </button> : null}
            </div> : floatingSidebarHeader(dockFloatingSidebar)}
            visible={showFloatingSidebar}
            mobileProgress={mobileSidebarEnabled ? mobileGesture.progress : undefined}
            onExitComplete={finishFloatingExit}
            width={sidebarWidth}
            unified={unifiedNavigation}
            widthPx={floatingWidthPx}
            getCurrentWidth={() => contextAvailable ? floatingWidth.get() - floatingPrimaryWidth.get() : floatingWidth.get()}
            getMaximumWidth={() => Math.max(sidebarMetrics.minimumWidth, Math.min(SIDEBAR_MAXIMUM_WIDTH, shellWidth.get() - (contextAvailable ? floatingLayout.primaryWidth : 0) - 24))}
            onResize={resizeSidebar}
            onResizeEnd={finishSidebarResize}
            onResizingChange={setFloatingResizing}
            footer={navigation && !unifiedNavigation ? <div className="sidecar-content-slot" ref={setFloatingFooterHost} /> : null}
          >
            <div className="floating-sidebar-panes">
              {navigation && !unifiedNavigation ? <motion.div className="floating-sidebar-primary" style={{ width: floatingNavigationWidth }}><div className="sidecar-content-slot" ref={setFloatingPrimaryHost} /></motion.div> : null}
              {contextAvailable ? <div className="floating-sidebar-context"><motion.div className="floating-sidebar-context__viewport" style={{ width: mobileSidebarEnabled ? "100%" : floatingContextViewportWidth }}>{unifiedNavigation ? <div className="shell-sidebar__column" data-navigation-layout={mobileSidebarEnabled ? "mobile" : "rail"}>
                <div className="shell-sidebar__scroll">
                  <div className="shell-sidebar__navigation sidecar-content-slot" ref={setFloatingPrimaryHost} />
                  <div className="shell-sidebar__context sidecar-content-slot" ref={setFloatingContextHost} />
                </div>
                {mobileSidebarEnabled ? <div className="shell-sidebar__floating-action" ref={setMobileSidebarActionHost} /> : null}
                <div className="shell-sidebar__rail-footer sidecar-content-slot" ref={setFloatingFooterHost} />
              </div> : <div className="sidecar-content-slot" ref={setFloatingContextHost} />}</motion.div></div> : null}
            </div>
          </FloatingLeftPanel>
          </div>, document.body,
        ) : null}
        <SharedSidebarContent
          primary={{ target: floatingOwnsContent ? floatingPrimaryHost : dockedPrimaryHost, content: navigation ? <ShellNavigationDock
            config={primaryNavigation!} controller={floatingOwnsContent ? floatingController : navigationOpen ? navigationController : lastDockController.current}
            onInvoke={action => { if (unifiedNavigation && floatingOwnsContent) dismissFloatingSidebar(); action(); }}
            expandedWidth={floatingOwnsContent ? floatingNavigationWidth : primaryMotion.viewportWidth}
            frameWidth={floatingOwnsContent ? floatingNavigationWidth : primaryMotion.frameWidth} /> : null }}
          context={{ target: floatingOwnsContent ? floatingContextHost : dockedContextHost, content: leftPanel,
            scrollViewport: mobileSidebarEnabled && floatingOwnsContent ? {
              key: "mobile", element: floatingContextHost?.closest<HTMLElement>(".shell-sidebar__scroll") ?? null,
            } : undefined }}
          footer={{ target: floatingOwnsContent ? floatingFooterHost : dockedFooterHost, content: navigation ? <ShellNavigationFooter
            mobile={mobileSidebarEnabled}
            config={navigation} controller={floatingOwnsContent ? floatingController : navigationController}
            onInvoke={action => { if (unifiedNavigation && floatingOwnsContent) dismissFloatingSidebar(); action(); }}
            visible={floatingOwnsContent || navigationController.projection.footerVisible}
            entranceId="shared-shell-entrance"
            onTogglePrimaryNavigation={floatingOwnsContent ? toggleFloatingApplications : onSidebarCollapse} /> : null }}
        />
        <motion.div className="app-shell-row" data-mobile-sidebar-present={mobileSidebarEnabled && mobileGesture.present || undefined}
          style={mobileSidebarEnabled ? { x: mobilePageX } : undefined}>
          <Sidecar animatedWidth={totalLeftWidth} dividerProgress={titlebarDividerProgress} footer={navigation && !unifiedNavigation ? <motion.div
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
              resizeHandle={sidebarResizable && !navigationOnly ? <SidebarResizeHandle
                  unified={unifiedNavigation}
                  collapsible={sidebarCollapsible}
                  getCurrentWidth={getLiveSidebarWidth}
                  getMaximumWidth={() => Math.max(sidebarMetrics.minimumWidth, Math.min(SIDEBAR_MAXIMUM_WIDTH, shellWidth.get() - space.navigationWidth
                    - shellSpaceMetrics.mainMinimum - (rightPanelOpen && !rightPanelFullWidth ? shellSpaceMetrics.rightMinimum : 0)))}
                  width={sidebarWidth}
                  onCollapse={onSidebarCollapse}
                  onExpand={onSidebarExpand}
                  onResize={resizeSidebar}
                  onResizeEnd={finishSidebarResize}
                  onResizingChange={setLayoutResizing}
                /> : null}
            >
              {unifiedNavigation ? <div className="shell-sidebar__column">
                <div className="shell-sidebar__scroll">
                  <div className="shell-sidebar__navigation sidecar-content-slot" ref={setDockedPrimaryHost} />
                  <div className="shell-sidebar__context sidecar-content-slot" ref={setDockedContextHost} />
                </div>
                <div className="shell-sidebar__rail-footer sidecar-content-slot" ref={setDockedFooterHost} />
              </div> : <div className="sidecar-content-slot" ref={setDockedContextHost} />}
            </SidecarPane>
          ) : null}
          </Sidecar>

          {/* Paint is a sibling of the clipped content surface. Consume the
              same current width as Sidecar, not the saved CSS width at root. */}
          <motion.div
            className="app-shell-content-depth"
            aria-hidden="true"
            style={{ left: totalLeftWidth }}
          />
          <main
            className="main-content-surface"
            data-app-shell-main-surface="default"
            inert={mobilePageBlocked || undefined}
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
            <div className="main-content-body" ref={setComposerOverlayAnchor}>
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
                  data-app-shell-content-plane="main"
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
                keepMounted={rightPanelKeepMounted}
                animation={rightPanelAnimation}
                fullWidth={rightPanelFullWidth}
                mainContentWidth={mainContentWidth}
                open={rightPanelOpen}
                rightPanelWidth={rightPanelWidth}
                contentWidth={rightPanelContentWidth}
                contentFullWidth={rightPanelContentFullWidth.current}
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
          {mobileSidebarEnabled ? <motion.div aria-hidden="true" className="app-shell-mobile-page-wash"
            style={{ opacity: mobilePageWash }} /> : null}
          {mobilePageBlocked ? <button
            type="button" className="app-shell-mobile-page-dismiss"
            aria-label="Close sidebar" onClick={() => { sidebarToggleFocusPending.current = true; dismissFloatingSidebar(); }} /> : null}
        </motion.div>
      </ApplicationShellRoot>
    </AppShellLayoutMotionContext.Provider>
    </SidebarDismissContext.Provider>
    </ShellPresentationContext.Provider>
  );
}
