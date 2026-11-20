import React, { useCallback, useLayoutEffect, useState, useRef, type ReactNode } from "react";
import { motion, useTransform, type MotionStyle, type MotionValue } from "motion/react";
import {
  computeRightPanelDefaultWidth,
  getRightPanelWidthBounds,
  normalizeRightPanelWidth,
  RIGHT_PANEL_COLLAPSE_SHELF,
} from "@opencraft/workbench-panels";
import { shellSpaceMetrics } from "@opencraft/workbench-runtime";
import { usePanelAnimation } from "./use-panel-animation";
import { RightPanelResizeHandle } from "./right-panel-resize-handle";

interface AppShellRightPanelProps {
  /** Visibility is a Shell-owned input, separate from content width. */
  readonly animation: MotionValue<number>;
  readonly children: ReactNode;
  readonly fullWidth: boolean;
  readonly mainContentWidth: MotionValue<number>;
  readonly open: boolean;
  readonly keepMounted?: boolean;
  readonly rightPanelWidth: MotionValue<number>;
  readonly rightPanelWidthRatio: MotionValue<number | null>;
  readonly defaultSize: "standard" | "compact";
  onWidthCommit(ratio: number | null): void;
  readonly rightPanelLayoutTick: MotionValue<number>;
  readonly shellHeight: MotionValue<number>;
  onOpenChange(open: boolean): void;
}


export function AppShellRightPanel({
  animation, children, fullWidth, mainContentWidth, open, keepMounted = false,
  rightPanelWidth,
  rightPanelWidthRatio, rightPanelLayoutTick, shellHeight, onOpenChange, defaultSize: defaultSizeMode, onWidthCommit,
}: AppShellRightPanelProps) {
  const [dragging, setDragging] = useState(false);
  const { animatedSize, isMounted, progress } = usePanelAnimation({
    animation, isVisible: open, size: rightPanelWidth,
  });
  // Content follows the live pane width; visibility alone clips this layout.
  const rightPanelTargetWidthPx = useTransform(rightPanelWidth, value => `${value}px`);

  useLayoutEffect(() => {
    const invalidate = () => rightPanelLayoutTick.set(rightPanelLayoutTick.get() + 1);
    const removeProgress = progress.on("change", invalidate);
    const removeWidth = rightPanelWidth.on("change", invalidate);
    return () => { removeWidth(); removeProgress(); };
  }, [progress, rightPanelWidth, rightPanelLayoutTick]);

  const bounds = useCallback(() => getRightPanelWidthBounds(
    mainContentWidth.get(), "regular", shellSpaceMetrics.mainMinimum,
  ), [mainContentWidth]);
  const defaultSize = useCallback(() => computeRightPanelDefaultWidth({
    mainContentWidth: mainContentWidth.get(), shellHeight: shellHeight.get(), size: defaultSizeMode,
    mainContentReserve: shellSpaceMetrics.mainMinimum,
  }), [mainContentWidth, shellHeight, defaultSizeMode]);

  const resize = useCallback((size: number) => {
    const visible = size >= RIGHT_PANEL_COLLAPSE_SHELF;
    if (visible) {
      rightPanelWidthRatio.set(normalizeRightPanelWidth(
        size, mainContentWidth.get(), shellSpaceMetrics.mainMinimum,
      ));
    }
    // A magnetic close preserves the last preferred width; a live drag can
    // cross the shelf again before it relinquishes the resize handle.
    if (visible !== open) onOpenChange(visible);
  }, [mainContentWidth, onOpenChange, open, rightPanelWidthRatio]);

  const gesture = useRef<{ ratio: number | null; committed: boolean } | null>(null);
  const resizingChange = useCallback((active: boolean) => {
    if (active) gesture.current = { ratio: rightPanelWidthRatio.get(), committed: false };
    else {
      if (gesture.current && !gesture.current.committed) rightPanelWidthRatio.set(gesture.current.ratio);
      gesture.current = null;
    }
    setDragging(active);
  }, [rightPanelWidthRatio]);
  const commitResize = useCallback((size: number) => {
    if (size < RIGHT_PANEL_COLLAPSE_SHELF) {
      if (gesture.current) rightPanelWidthRatio.set(gesture.current.ratio);
      return;
    }
    if (gesture.current) gesture.current.committed = true;
    onWidthCommit(rightPanelWidthRatio.get());
  }, [onWidthCommit, rightPanelWidthRatio]);

  if (!isMounted && !keepMounted && !dragging) return <></>;
  const surfaceStyle = {
    "--app-shell-right-panel-target-width": rightPanelTargetWidthPx,
  } as MotionStyle;
  return (
    <motion.aside className="app-shell-right-panel" data-app-shell-focus-area="right-panel"
      data-full-width={fullWidth} data-content-full-width={fullWidth} aria-hidden={!open} inert={!open}
      style={{ opacity: progress, width: animatedSize }}>
      {!fullWidth ? <>
        <div className="right-panel-divider" aria-hidden="true" />
        <RightPanelResizeHandle
          getCurrentSize={() => rightPanelWidth.get()} getDefaultSize={defaultSize}
          getMinimumSize={() => bounds().minimum} getMaximumSize={() => bounds().maximum}
          onResize={resize} onResizeEnd={commitResize} onResizingChange={resizingChange}
          onResetSize={() => onWidthCommit(null)}
        />
      </> : null}
      <div className="app-shell-right-panel__clip">
        <motion.div className="app-shell-right-panel__surface" style={surfaceStyle}>
          {children}
        </motion.div>
      </div>
    </motion.aside>
  );
}
