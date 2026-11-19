import React, { forwardRef, type HTMLAttributes } from "react";
import type { ControlSurface as ControlSurfaceKind } from "@opencraft/design-system/button";
import { LiquidGlassBackdrop } from "./liquid-glass";

/** One backdrop per action group; descendants keep their own interaction owner.
 * A `panel` shape is a rounded-rectangle lens whose corners follow the layout
 * owner's `--radius-control-surface-panel`, so joined panes share one material. */
export const ControlSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & {
  surface: ControlSurfaceKind;
  shape?: "capsule" | "panel";
}>(function ControlSurface({ surface, shape = "capsule", className, children, ...props }, ref) {
  return <div {...props} ref={ref} className={["ui-control-surface", className].filter(Boolean).join(" ")}
    data-control-surface={surface} data-surface-shape={shape === "panel" ? shape : undefined}>
    <LiquidGlassBackdrop active={surface === "floating"} shape={shape === "panel" ? "rounded-rectangle" : "capsule"} />{children}
  </div>;
});
