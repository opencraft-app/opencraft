import React, { forwardRef, type HTMLAttributes } from "react";
import { LiquidGlassBackdrop } from "./liquid-glass";

/** Passive content panel, not an action group. The design system owns its
 * optical backing; callers retain section semantics, layout and corner shape. */
export const MaterialSurface = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(
  function MaterialSurface({ className, children, ...props }, ref) {
    return <section {...props} ref={ref} className={["ui-material-surface", className].filter(Boolean).join(" ")}>
      <LiquidGlassBackdrop shape="rounded-rectangle" />{children}
    </section>;
  },
);
