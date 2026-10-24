
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "motion/react";
import type { ReactNode } from "react";

import { PANEL_SPRING_TRANSITION } from "./use-panel-animation";
import { SidebarResizeHandle } from "./sidebar-resize-handle";

interface FloatingLeftPanelProps {
  readonly unified?: boolean;
  readonly children: ReactNode;
  readonly header: ReactNode;
  readonly footer?: ReactNode;
  readonly visible: boolean;
  readonly onExitComplete?: () => void;
  readonly width: number;
  readonly widthPx: MotionValue<string>;
  readonly mobileProgress?: MotionValue<number>;
  getCurrentWidth(): number;
  getMaximumWidth?(): number;
  onResize(width: number): void;
  onResizeEnd(width: number | null): void;
  onResizingChange(resizing: boolean): void;
}

export function FloatingLeftPanel({
  visible,
  onExitComplete,
  ...contentProps
}: FloatingLeftPanelProps) {
  return (
    <AnimatePresence onExitComplete={onExitComplete}>
      {visible ? <FloatingLeftPanelContent {...contentProps} /> : null}
    </AnimatePresence>
  );
}

function FloatingLeftPanelContent({
  children,
  header,
  footer,
  unified,
  width,
  widthPx,
  mobileProgress,
  getCurrentWidth,
  getMaximumWidth,
  onResize,
  onResizeEnd,
  onResizingChange,
}: Omit<FloatingLeftPanelProps, "visible" | "onExitComplete">) {
  const isPresent = useIsPresent();
  const reducedMotion = useReducedMotion();
  const horizontalOffset = useMotionValue(
    mobileProgress === undefined && !reducedMotion ? -8 : 0,
  );
  const headerOffset = useTransform(horizontalOffset, (offset) => -offset);
  const fullyOpen = useMotionValue(1);
  const depthProgress = mobileProgress ?? fullyOpen;
  const depthScale = useTransform(depthProgress, [0, 1], [0.9, 1]);
  const depthOpacity = useTransform(depthProgress, [0, 1], [0.45, 1]);
  const washOpacity = useTransform(depthProgress, [0, 1], [0.65, 0]);
  const mobile = mobileProgress !== undefined;

  // Shell owns mobile progress. Only desktop presence has its own entrance.
  const transition = reducedMotion || mobile
    ? { duration: 0 }
    : PANEL_SPRING_TRANSITION;

  return (
    <>
      <motion.div
        className="app-shell-floating-left-panel"
        data-pip-obstacle="app-shell-floating-left-panel"
        inert={!isPresent || undefined}
        aria-hidden={!isPresent || undefined}
        initial={mobile || reducedMotion ? false : { x: -8, opacity: 0 }}
        animate={mobile ? { x: 0 } : { x: 0, opacity: 1 }}
        exit={{ x: mobile || reducedMotion ? 0 : -8 }}
        transition={transition}
        style={{
          pointerEvents: isPresent ? "auto" : "none",
          width: widthPx,
          x: horizontalOffset,
          ...(mobile ? {
            scale: reducedMotion ? 1 : depthScale,
            opacity: reducedMotion ? 1 : depthOpacity,
            transformOrigin: "0% 50%",
          } : {}),
        }}
      >
        <aside
          className="app-shell-floating-left-panel__surface"
          data-testid="app-shell-floating-left-panel"
        >
          <motion.div
            className="app-shell-floating-left-panel__header"
            style={{ x: headerOffset }}
          >
            {header}
          </motion.div>
          <div className="app-shell-floating-left-panel__body">{children}</div>
          {footer ? <div className="app-shell-sidecar__footer">{footer}</div> : null}
        </aside>
        {mobile ? null : (
          <SidebarResizeHandle
            unified={unified}
            collapsible={false}
            width={width}
            getCurrentWidth={getCurrentWidth}
            getMaximumWidth={getMaximumWidth}
            onResize={onResize}
            onResizeEnd={onResizeEnd}
            onResizingChange={onResizingChange}
          />
        )}
      </motion.div>
      {mobile ? (
        <motion.div
          aria-hidden="true"
          className="app-shell-mobile-sidebar-wash"
          style={{ opacity: reducedMotion ? 0 : washOpacity }}
        />
      ) : null}
    </>
  );
}
