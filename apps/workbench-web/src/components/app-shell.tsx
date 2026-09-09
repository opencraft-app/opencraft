// Restored and typed from the latest recovered Codex AppShell lineage:
// terminal/use-app-shell-layout-motion-04358.ts and
// terminal/app-shell-right-panel-06052.ts.
import {
  AnimatePresence,
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
  type Ref,
  type ReactNode,
} from "react";

import {
  getHeaderStartMinimumWidth,
  type WindowChromeSnapshot,
} from "../window-chrome";
import {
  readRootFontSizePx,
  resolveThreadEdgeScroll,
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
import { AppShellRightPanel } from "./app-shell-right-panel";
import { SidebarResizeHandle } from "./sidebar-resize-handle";
import {
  usePanelAnimation,
  usePanelFullWidthAnimation,
  usePanelVisibilityAnimation,
} from "./use-panel-animation";
import { useSidebarDockIntent } from "./use-sidebar-dock-intent";

interface AppShellProps {
  layoutScope: string;
  header: ReactNode;
  floatingSidebarHeader(onDock: () => void): ReactNode;
  leftPanel: ReactNode;
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
}

interface ApplicationShellRootProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly rootRef?: Ref<HTMLDivElement>;
  readonly sidebarMounted: boolean;
  readonly sidebarOpen: boolean;
  readonly sidebarPresentation: string;
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

interface SidebarMotionStyle extends MotionStyle {
  "--app-shell-left-open-width": MotionValue<string>;
  "--app-shell-left-width": MotionValue<string>;
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
  layoutScope,
  header,
  floatingSidebarHeader,
  leftPanel,
  rightPanel,
  rightPanelOpen,
  rightPanelFullWidth,
  sidebarCollapsible = true,
  sidebarTransientEnabled = true,
  sidebarResizable = true,
  sidebarOpen,
  sidebarWidth,
  windowChrome,
  onSidebarCollapse,
  onSidebarExpand,
  onSidebarResizeEnd,
  onRightPanelOpenChange,
  children,
}: AppShellProps) {
  const shellRootRef = useRef<HTMLDivElement | null>(null);
  const shellWidth = useMotionValue(window.innerWidth);
  const shellHeight = useMotionValue(window.innerHeight);
  const liveSidebarWidth = useMotionValue(sidebarWidth);
  const headerRightWidth = useMotionValue(0);
  const headerLeftFitWidth = useMotionValue(
    getHeaderStartMinimumWidth(windowChrome),
  );
  const sidebarAnimation = useMotionValue(sidebarOpen ? 1 : 0);
  const rightPanelAnimation = useMotionValue(rightPanelOpen ? 1 : 0);
  const fullWidthProgress = usePanelFullWidthAnimation(rightPanelFullWidth, layoutScope, rightPanelOpen);
  const zeroWidth = useMotionValue(0);
  const rightPanelLayoutTick = useMotionValue(0);
  const [rightPanelPresentationActive, setRightPanelPresentationActive] =
    useState(rightPanelOpen || rightPanelAnimation.get() > 0.001);
  const mainContentViewportRef = useRef<HTMLDivElement | null>(null);
  const [conversationSupportsEdgeScroll, setConversationSupportsEdgeScroll] =
    useState(false);
  const isHeaderEdgeScroll = conversationSupportsEdgeScroll;
  const [layoutResizing, setLayoutResizing] = useState(false);
  const [floatingResizing, setFloatingResizing] = useState(false);
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
  usePanelVisibilityAnimation(rightPanelOpen, rightPanelAnimation);
  useLayoutEffect(() => {
    // Seed synchronously for the first paint. Once mounted, the physical
    // HeaderSlot measures its own max-content rail and becomes authoritative.
    headerLeftFitWidth.set(getHeaderStartMinimumWidth(windowChrome));
  }, [headerLeftFitWidth, windowChrome]);
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
  const animatedSidebarWidthPx = useTransform(
    animatedSidebarWidth,
    (width) => `${width}px`,
  );
  const mainContentWidth = useTransform(
    [shellWidth, animatedSidebarWidth],
    ([width, leftWidth]) => Math.max(0, Number(width) - Number(leftWidth)),
  );
  const initialMainContentWidth = mainContentWidth.get();
  const initialRightPanelWidth = computeRightPanelDefaultWidth({
    mainContentWidth: initialMainContentWidth,
    shellHeight: shellHeight.get(),
  });
  const rightPanelWidthRatio = useMotionValue(
    normalizeRightPanelWidth(initialRightPanelWidth, initialMainContentWidth),
  );
  const regularRightPanelWidth = useTransform(
    [mainContentWidth, rightPanelWidthRatio],
    ([contentWidth, ratio]) =>
      interpolateRightPanelWidth(Number(ratio), Number(contentWidth)),
  );
  // Semantic mode changes immediately; physical geometry follows one progress
  // value. Reversing the gesture retargets that value rather than resetting it.
  const rightPanelWidth = useTransform(
    [mainContentWidth, regularRightPanelWidth, fullWidthProgress],
    ([total, regular, progress]) => Number(regular) + (Number(total) - Number(regular)) * Math.max(0, Math.min(1, Number(progress))),
  );
  const mainViewportWidth = useTransform(
    [mainContentWidth, rightPanelWidth, rightPanelAnimation],
    ([total, panel, visibility]) => Math.max(0, Number(total) - Number(panel) * Math.max(0, Math.min(1, Number(visibility)))),
  );
  // This is the width owned by surrounding chrome, not the physical aside.
  // Full-width mode replaces the main viewport and therefore reserves no
  // separate header/floating-bounds gutter in the original AppShell.
  const regularRightPanelAnimatedWidth = useTransform(
    [rightPanelAnimation, rightPanelWidth],
    ([progress, width]) =>
      Math.max(0, Math.min(1, Number(progress))) * Number(width),
  );
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
    [animatedSidebarWidth, headerLeftFitWidth],
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
  const liveSidebarWidthPx = useTransform(
    liveSidebarWidth,
    (width) => `${width}px`,
  );
  const headerLeftSlotWidth = useTransform(
    animatedSidebarWidth,
    (width) => `${Math.max(0, Number(width))}px`,
  );
  const headerLeftFitWidthPx = useTransform(
    headerLeftFitWidth,
    (width) => `${Math.max(0, Number(width))}px`,
  );
  const shellStyle: AppShellStyle = {
    "--app-shell-left-open-width": `${sidebarWidth}px`,
  };
  const sidebarMotionStyle: SidebarMotionStyle = {
    "--app-shell-left-open-width": liveSidebarWidthPx,
    "--app-shell-left-width": animatedSidebarWidthPx,
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
  const resizeSidebar = useCallback(
    (width: number) => {
      liveSidebarWidth.set(width);
    },
    [liveSidebarWidth],
  );
  const finishSidebarResize = useCallback(
    (width: number | null) => {
      if (width !== null) liveSidebarWidth.set(width);
      onSidebarResizeEnd(liveSidebarWidth.get(), width !== null);
    },
    [liveSidebarWidth, onSidebarResizeEnd],
  );

  useLayoutEffect(() => {
    if (!layoutResizing && !floatingResizing)
      liveSidebarWidth.set(sidebarWidth);
  }, [floatingResizing, layoutResizing, liveSidebarWidth, sidebarWidth]);

  useLayoutEffect(() => {
    const shell = shellRootRef.current;
    if (shell === null) return;
    const update = () => {
      const bounds = shell.getBoundingClientRect();
      shellWidth.set(bounds.width);
      shellHeight.set(bounds.height);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [shellHeight, shellWidth]);

  useLayoutEffect(() => {
    const viewport = mainContentViewportRef.current;
    if (viewport === null) return;
    const update = () => {
      const width = viewport.getBoundingClientRect().width;
      setConversationSupportsEdgeScroll(
        resolveThreadEdgeScroll({
          mainContentWidthPx: width,
          leftChromeWidthPx: animatedSidebarWidth.get(),
          rightPanelFullWidth,
          rootFontSizePx: readRootFontSizePx(),
        }),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [animatedSidebarWidth, rightPanelFullWidth]);

  const floatingIntent = useSidebarDockIntent({
    docked: sidebarOpen,
    enabled: sidebarTransientEnabled,
    getPanelWidth: getLiveSidebarWidth,
    lockOpen: floatingResizing,
  });
  const sidebarPresentation = resolveSidebarPresentation({
    docked: sidebarOpen,
    layoutMounted: desktopDockMounted,
    layoutResizing,
    floatingRequested: floatingIntent.requested,
    floatingResizing,
  });
  const showDockedSidebar = sidebarOpen || desktopDockMounted || layoutResizing;
  const showFloatingSidebar = sidebarPresentation === "floating";
  const mountFloatingPresenceOwner = shouldMountFloatingSidebarPresenceOwner({
    docked: sidebarOpen,
    layoutMounted: desktopDockMounted,
    layoutResizing,
  });
  const dockFloatingSidebar = useCallback(() => {
    // Codex pins the floating panel without replaying the layout entrance.
    sidebarProgress.stop();
    sidebarProgress.set(1);
    onSidebarExpand();
  }, [onSidebarExpand, sidebarProgress]);

  return (
    <AppShellLayoutMotionContext.Provider value={layoutMotion}>
      <ApplicationShellRoot
        rootRef={shellRootRef}
        windowChrome={windowChrome}
        sidebarOpen={sidebarOpen}
        sidebarMounted={desktopDockMounted}
        sidebarPresentation={sidebarPresentation}
        style={shellStyle}
      >
        {sidebarTransientEnabled && mountFloatingPresenceOwner ? (
          <FloatingLeftPanel
            header={floatingSidebarHeader(dockFloatingSidebar)}
            visible={showFloatingSidebar}
            width={sidebarWidth}
            widthPx={liveSidebarWidthPx}
            getCurrentWidth={getLiveSidebarWidth}
            onResize={resizeSidebar}
            onResizeEnd={finishSidebarResize}
            onResizingChange={setFloatingResizing}
          >
            {leftPanel}
          </FloatingLeftPanel>
        ) : null}
        <div className="app-shell-row">
          <AnimatePresence initial={false}>
            {showDockedSidebar ? (
              <motion.aside
                key="app-shell-left-panel"
                className="app-shell-left-panel"
                aria-hidden={!sidebarOpen}
                style={sidebarMotionStyle}
              >
                <motion.div
                  className="app-shell-left-panel__viewport"
                  style={{ opacity: sidebarProgress }}
                >
                  {leftPanel}
                </motion.div>
                {sidebarResizable ? <SidebarResizeHandle
                  collapsible={sidebarCollapsible}
                  getCurrentWidth={getLiveSidebarWidth}
                  width={sidebarWidth}
                  onCollapse={onSidebarCollapse}
                  onExpand={onSidebarExpand}
                  onResize={resizeSidebar}
                  onResizeEnd={finishSidebarResize}
                  onResizingChange={setLayoutResizing}
                /> : null}
              </motion.aside>
            ) : null}
          </AnimatePresence>

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
            <div className="main-content-body">
              <motion.div
                ref={mainContentViewportRef}
                className="main-content-viewport"
                style={{ width: mainViewportWidth, flex: "0 0 auto", overflow: "hidden" }}
                inert={rightPanelFullWidth || undefined}
                aria-hidden={rightPanelFullWidth || undefined}
                data-app-shell-main-content-layout="thread-edge-scroll"
                data-app-shell-thread-edge-scroll={isHeaderEdgeScroll}
                data-app-shell-right-panel-full-width={rightPanelFullWidth}
              >
                <div
                  className="main-content-frame"
                  data-app-shell-thread-edge-divider={!isHeaderEdgeScroll}
                >
                  <div className="main-content-frame__inner">
                    <div
                      className="main-content-top-fade"
                      data-app-shell-main-content-top-fade="full-bleed"
                      aria-hidden="true"
                    />
                    <div className="main-content-slot">{children}</div>
                  </div>
                </div>
              </motion.div>
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
          </main>
        </div>
      </ApplicationShellRoot>
    </AppShellLayoutMotionContext.Provider>
  );
}
