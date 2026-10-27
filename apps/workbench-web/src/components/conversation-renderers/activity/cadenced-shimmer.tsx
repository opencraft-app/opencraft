import type { CSSProperties, ReactNode } from "react";
import { workingShimmerMotion } from "@opencraft/design-system/tokens";

/** Readable base text plus a 1s sweep every 1.5s. */
export function CadencedShimmer({
  active,
  children,
  className,
  id,
}: {
  readonly active: boolean;
  readonly children: ReactNode;
  readonly className?: string;
  readonly id?: string;
}) {
  const classes = [className, active ? "is-shimmering" : null].filter(Boolean).join(" ");
  return (
    <span
      className={classes || undefined}
      id={id}
      style={active ? {
        "--working-shimmer-cycle-duration": `${workingShimmerMotion.cycleMs}ms`,
        "--working-shimmer-first-delay": `${workingShimmerMotion.firstSweepDelayMs}ms`,
      } as CSSProperties : undefined}
    >
      {children}
      {active ? <span aria-hidden="true" className="is-shimmering__sweep"><span className="is-shimmering__highlight">{children}</span></span> : null}
    </span>
  );
}
