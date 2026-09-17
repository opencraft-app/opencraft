import * as React from "react";
import { cn } from "@/lib/utils";

export type ProgressProps = Omit<React.ComponentPropsWithoutRef<"div">, "children"> & {
  /** Percentage from 0 to 100; null means the value is not yet known. */
  value: number | null;
};

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(({ value, className, ...props }, ref) => {
  const percentage = value !== null && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined;
  return <div {...props} ref={ref} role="progressbar" data-slot="progress"
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}
    className={cn("relative h-2 w-full overflow-hidden rounded-full bg-black/10", className)}>
    <div data-slot="progress-indicator" aria-hidden="true"
      className="h-full w-full rounded-full bg-[var(--text-primary)]"
      style={{ transform: `translateX(-${100 - (percentage ?? 0)}%)` }} />
  </div>;
});
Progress.displayName = "Progress";

export { Progress };
