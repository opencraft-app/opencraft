// Structure and motion restored from Codex r1532:
// shared/finalize-floating-panel-size-06083.ts.
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
  type MotionValue,
} from "motion/react";
import type { ReactNode } from "react";

import { PANEL_SPRING_TRANSITION } from "./use-panel-animation";
import { SidebarResizeHandle } from "./sidebar-resize-handle";

interface FloatingLeftPanelProps {
  readonly children: ReactNode;
  readonly header: ReactNode;
  readonly footer?: ReactNode;
  readonly visible: boolean;
  readonly onExitComplete?: () => void;
  readonly width: number;
  readonly widthPx: MotionValue<string>;
  getCurrentWidth(): number;
  getMaximumWidth?(): number;
  onResize(width: number): void;
  onResizeEnd(width: number | null): void;
  onResizingChange(resizing: boolean): void;
}

export function FloatingLeftPanel({
  children,
  header,
  footer,
  visible,
  onExitComplete,
  width,
  widthPx,
  getCurrentWidth,
  getMaximumWidth,
  onResize,
  onResizeEnd,
  onResizingChange,
}: FloatingLeftPanelProps) {
  return (
    <AnimatePresence initial={false} onExitComplete={onExitComplete}>
      {visible ? <FloatingLeftPanelContent
        key="floating-sidebar"
        children={children}
        header={header}
        footer={footer}
        width={width}
        widthPx={widthPx}
        getCurrentWidth={getCurrentWidth}
        getMaximumWidth={getMaximumWidth}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
        onResizingChange={onResizingChange}
      /> : null}
    </AnimatePresence>
  );
}

function FloatingLeftPanelContent({
  children,
  header,
  footer,
  width,
  widthPx,
  getCurrentWidth,
  getMaximumWidth,
  onResize,
  onResizeEnd,
  onResizingChange,
}: Omit<FloatingLeftPanelProps, "visible" | "onExitComplete">) {
  const shouldReduceMotion = useReducedMotion() === true;
  const isPresent = useIsPresent();
  const transition = shouldReduceMotion ? { duration: 0 } : PANEL_SPRING_TRANSITION;

  return (
    <motion.div
          className="app-shell-floating-left-panel"
          data-pip-obstacle="app-shell-floating-left-panel"
          inert={!isPresent || undefined}
          aria-hidden={!isPresent || undefined}
          initial={shouldReduceMotion ? false : { opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: shouldReduceMotion ? 0 : -8 }}
          style={{ width: widthPx, pointerEvents: isPresent ? "auto" : "none" }}
          transition={transition}
        >
          <aside
            className="app-shell-floating-left-panel__surface"
            data-testid="app-shell-floating-left-panel"
          >
            <motion.div
              className="app-shell-floating-left-panel__header"
              initial={shouldReduceMotion ? false : { x: 8 }}
              animate={{ x: 0 }}
              exit={{ x: shouldReduceMotion ? 0 : 8 }}
              transition={transition}
            >
              {header}
            </motion.div>
            <div className="app-shell-floating-left-panel__body">{children}</div>
            {footer ? <div className="app-shell-sidecar__footer">{footer}</div> : null}
          </aside>
          <SidebarResizeHandle
            collapsible={false}
            getCurrentWidth={getCurrentWidth}
            getMaximumWidth={getMaximumWidth}
            width={width}
            onCollapse={() => undefined}
            onExpand={() => undefined}
            onResize={onResize}
            onResizeEnd={onResizeEnd}
            onResizingChange={onResizingChange}
          />
    </motion.div>
  );
}
