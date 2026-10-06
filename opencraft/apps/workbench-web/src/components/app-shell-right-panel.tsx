// Typed semantic restoration of Codex's AppShellRightPanel layout contract.
// Source: terminal/app-shell-right-panel-06052 and
// shared/toggle-maximize-side-panel-button-01708 in the latest recovery tree.
import {
  motion,
  useTransform,
  type MotionStyle,
  type MotionValue,
} from "motion/react";
import { useCallback, useLayoutEffect, useState, type ReactNode } from "react";

import {
  RIGHT_PANEL_COLLAPSE_SHELF,
  computeRightPanelDefaultWidth,
  getRightPanelWidthBounds,
  normalizeRightPanelWidth,
} from "@opencraft/workbench-panels";
import { usePanelAnimation } from "./use-panel-animation";
import { RightPanelResizeHandle } from "./right-panel-resize-handle";
import { shellSpaceMetrics } from "@opencraft/workbench-runtime";

interface AppShellRightPanelProps {
  /** Route/AppShell-scoped visibility progress; the panel never owns it. */
  readonly animation: MotionValue<number>;
  readonly children: ReactNode;
  readonly fullWidth: boolean;
  readonly mainContentWidth: MotionValue<number>;
  readonly open: boolean;
  readonly keepMounted?: boolean;
  readonly rightPanelWidth: MotionValue<number>;
  readonly rightPanelWidthRatio: MotionValue<number>;
  readonly rightPanelLayoutTick: MotionValue<number>;
  readonly shellHeight: MotionValue<number>;
  onOpenChange(open: boolean): void;
}

interface RightPanelMotionStyle extends MotionStyle {
  opacity: MotionValue<number>;
  width: MotionValue<number>;
}

interface RightPanelSurfaceMotionStyle extends MotionStyle {
  "--app-shell-right-panel-target-width": MotionValue<string>;
}

export function AppShellRightPanel({
  animation,
  children,
  fullWidth,
  mainContentWidth,
  open,
  keepMounted = false,
  rightPanelWidth,
  rightPanelWidthRatio,
  rightPanelLayoutTick,
  shellHeight,
  onOpenChange,
}: AppShellRightPanelProps) {
  const [resizing, setResizing] = useState(false);
  const { animatedSize, isMounted, progress } = usePanelAnimation({
    animation,
    isVisible: open,
    size: rightPanelWidth,
  });

  // This is the same ownership rule as Codex AppShellRightPanel: semantic
  // visibility owns the animation, and the physical panel publishes a layout
  // epoch that portalled browser surfaces consume on the following frame.
  useLayoutEffect(
    () =>
      progress.on("change", () => {
        rightPanelLayoutTick.set(rightPanelLayoutTick.get() + 1);
      }),
    [progress, rightPanelLayoutTick],
  );
  // Full-width transitions change the surface while visibility stays at one.
  // Portalled browser surfaces must observe those geometry frames as well.
  useLayoutEffect(() => rightPanelWidth.on("change", () => {
    rightPanelLayoutTick.set(rightPanelLayoutTick.get() + 1);
  }), [rightPanelWidth, rightPanelLayoutTick]);

  const motionStyle: RightPanelMotionStyle = {
    opacity: progress,
    width: animatedSize,
  };
  const rightPanelTargetWidthPx = useTransform(
    rightPanelWidth,
    (width) => `${Math.max(0, width)}px`,
  );
  // One animated CSS property feeds both physical constraints. Reusing one
  // MotionValue as two React style properties can leave min-width subscribed
  // to its initial value while width advances, breaking Codex's stable-surface
  // invariant and carrying the tab-bar actions with the moving aperture.
  const surfaceStyle: RightPanelSurfaceMotionStyle = {
    "--app-shell-right-panel-target-width": rightPanelTargetWidthPx,
  };

  const getDefaultSize = useCallback(
    () =>
      computeRightPanelDefaultWidth({
        mainContentWidth: mainContentWidth.get(),
        shellHeight: shellHeight.get(),
        mainContentReserve: shellSpaceMetrics.mainMinimum,
      }),
    [mainContentWidth, shellHeight],
  );
  const getWidthBounds = useCallback(
    () => getRightPanelWidthBounds(mainContentWidth.get(), "regular", shellSpaceMetrics.mainMinimum),
    [mainContentWidth],
  );
  const getCurrentSize = useCallback(
    () => rightPanelWidth.get(),
    [rightPanelWidth],
  );
  const getMinimumSize = useCallback(
    () => getWidthBounds().minimum,
    [getWidthBounds],
  );
  const getMaximumSize = useCallback(
    () => getWidthBounds().maximum,
    [getWidthBounds],
  );

  const resizePanel = useCallback(
    (size: number) => {
      const shouldOpen = size >= RIGHT_PANEL_COLLAPSE_SHELF;
      if (shouldOpen !== open) onOpenChange(shouldOpen);
      if (shouldOpen) {
        rightPanelWidthRatio.set(
          normalizeRightPanelWidth(size, mainContentWidth.get(), shellSpaceMetrics.mainMinimum),
        );
      }
    },
    [mainContentWidth, onOpenChange, open, rightPanelWidthRatio],
  );

  const finishResize = useCallback(
    (size: number) => {
      if (size >= RIGHT_PANEL_COLLAPSE_SHELF) {
        rightPanelWidthRatio.set(
          normalizeRightPanelWidth(size, mainContentWidth.get(), shellSpaceMetrics.mainMinimum),
        );
      }
    },
    [mainContentWidth, rightPanelWidthRatio],
  );

  if (!isMounted && !open && !resizing && !keepMounted) return null;

  return (
    <motion.aside
      className="app-shell-right-panel"
      data-app-shell-focus-area="right-panel"
      data-full-width={fullWidth}
      aria-hidden={!open}
      inert={!open || undefined}
      style={motionStyle}
    >
      {!fullWidth ? (
        <div className="right-panel-divider" aria-hidden="true" />
      ) : null}
      {!fullWidth ? (
        <RightPanelResizeHandle
          getCurrentSize={getCurrentSize}
          getDefaultSize={getDefaultSize}
          getMinimumSize={getMinimumSize}
          getMaximumSize={getMaximumSize}
          onResize={resizePanel}
          onResizeEnd={finishResize}
          onResizingChange={setResizing}
        />
      ) : null}
      <div className="app-shell-right-panel__clip">
        <motion.div
          className="app-shell-right-panel__surface"
          style={surfaceStyle}
        >
          {children}
        </motion.div>
      </div>
    </motion.aside>
  );
}
