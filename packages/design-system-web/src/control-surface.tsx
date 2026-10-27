import React, { forwardRef, type HTMLAttributes } from "react";
import type { ControlSurface as ControlSurfaceKind } from "@opencraft/design-system/button";
import { LiquidGlassBackdrop } from "./liquid-glass";

/** One backdrop per action group; descendants keep their own interaction owner. */
export const ControlSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & {
  surface: ControlSurfaceKind;
}>(function ControlSurface({ surface, className, children, ...props }, ref) {
  return <div {...props} ref={ref} className={["ui-control-surface", className].filter(Boolean).join(" ")}
    data-control-surface={surface}>
    <LiquidGlassBackdrop active={surface === "floating"} />{children}
  </div>;
});
