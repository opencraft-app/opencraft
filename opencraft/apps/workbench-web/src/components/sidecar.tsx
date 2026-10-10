import {
  motion,
  type MotionStyle,
  type MotionValue,
} from "motion/react";
import type { ReactNode } from "react";

type SidecarSize = number | MotionValue<number>;

export function Sidecar({
  animatedWidth,
  dividerProgress,
  children,
  footer,
}: {
  readonly animatedWidth: MotionValue<number>;
  readonly dividerProgress?: MotionValue<number>;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  return (
    <motion.aside
      aria-label="Sidecar"
      className="app-shell-sidecar"
      data-sidecar="true"
      style={{ width: animatedWidth, "--app-shell-titlebar-divider-progress": dividerProgress } as MotionStyle}
    >
      <div className="app-shell-sidecar__panes">{children}</div>
      {footer}
    </motion.aside>
  );
}
/**
 * Layout width follows resize gestures. The visible Frame may differ only for
 * an explicit visibility/detent transition, whose Clip never owns layout width.
 */
export function SidecarPane({
  animatedSize,
  children,
  className,
  contentOpacity,
  label,
  open,
  resizeHandle,
  viewportClassName,
  viewportSize,
}: {
  readonly animatedSize: MotionValue<number>;
  readonly children: ReactNode;
  readonly className?: string;
  readonly contentOpacity: MotionValue<number>;
  readonly label?: string;
  readonly open: boolean;
  readonly resizeHandle?: ReactNode;
  readonly viewportClassName?: string;
  readonly viewportSize: SidecarSize;
}) {
  const frameStyle: MotionStyle = { flex: "0 0 auto", width: animatedSize };
  // Do not subscribe one MotionValue through both minWidth and width. React
  // motion can retain the initial minimum while the width shrinks.
  const viewportStyle: MotionStyle = {
    minWidth: 0,
    flexShrink: 0,
    opacity: contentOpacity,
    width: viewportSize,
  };
  return (
    <motion.section
      aria-hidden={!open || undefined}
      aria-label={label}
      className={["sidecar-pane", className].filter(Boolean).join(" ")}
      data-sidecar-pane="true"
      data-sidecar-pane-open={open}
      inert={!open || undefined}
      style={frameStyle}
    >
      <div className="sidecar-pane__clip" data-sidecar-pane-clip="true">
        <motion.div
          className={["sidecar-pane__viewport", viewportClassName].filter(Boolean).join(" ")}
          data-sidecar-pane-viewport="true"
          style={viewportStyle}
        >
          {children}
        </motion.div>
      </div>
      {resizeHandle}
    </motion.section>
  );
}
