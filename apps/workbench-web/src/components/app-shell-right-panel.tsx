import React, { useCallback, useLayoutEffect, useState, type ReactNode } from "react";
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
  /** Layout endpoint; physical width may still be animating toward it. */
  readonly contentWidth?: MotionValue<number>;
  readonly contentFullWidth?: boolean;
  readonly rightPanelWidthRatio: MotionValue<number>;
  readonly rightPanelLayoutTick: MotionValue<number>;
  readonly shellHeight: MotionValue<number>;
  onOpenChange(open: boolean): void;
}


export function AppShellRightPanel({
  animation, children, fullWidth, mainContentWidth, open, keepMounted = false,
  rightPanelWidth, contentWidth = rightPanelWidth, contentFullWidth = fullWidth,
  rightPanelWidthRatio, rightPanelLayoutTick, shellHeight, onOpenChange,
}: AppShellRightPanelProps) {
  const [dragging, setDragging] = useState(false);
  const { animatedSize, isMounted, progress } = usePanelAnimation({
    animation, isVisible: open, size: rightPanelWidth,
  });
  const rightPanelTargetWidthPx = useTransform(contentWidth, value => `${value}px`);

  useLayoutEffect(() => {
    const invalidate = () => rightPanelLayoutTick.set(rightPanelLayoutTick.get() + 1);
    const removeProgress = progress.on("change", invalidate);
    const removeWidth = rightPanelWidth.on("change", invalidate);
    const removeContentWidth = contentWidth.on("change", invalidate);
    return () => { removeContentWidth(); removeWidth(); removeProgress(); };
  }, [progress, rightPanelWidth, contentWidth, rightPanelLayoutTick]);

  const bounds = useCallback(() => getRightPanelWidthBounds(
    mainContentWidth.get(), "regular", shellSpaceMetrics.mainMinimum,
  ), [mainContentWidth]);
  const defaultSize = useCallback(() => computeRightPanelDefaultWidth({
    mainContentWidth: mainContentWidth.get(), shellHeight: shellHeight.get(),
    mainContentReserve: shellSpaceMetrics.mainMinimum,
  }), [mainContentWidth, shellHeight]);

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

  if (!isMounted && !keepMounted && !dragging) return <></>;
  const surfaceStyle = {
    "--app-shell-right-panel-target-width": rightPanelTargetWidthPx,
  } as MotionStyle;
  return (
    <motion.aside className="app-shell-right-panel" data-app-shell-focus-area="right-panel"
      data-full-width={fullWidth} data-content-full-width={contentFullWidth} aria-hidden={!open} inert={!open}
      style={{ opacity: progress, width: animatedSize }}>
      {!fullWidth ? <>
        <div className="right-panel-divider" aria-hidden="true" />
        <RightPanelResizeHandle
          getCurrentSize={() => rightPanelWidth.get()} getDefaultSize={defaultSize}
          getMinimumSize={() => bounds().minimum} getMaximumSize={() => bounds().maximum}
          onResize={resize} onResizeEnd={resize} onResizingChange={setDragging}
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
