// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import * as React from "react";

import { cn } from "../../lib/utils";

export interface SkeletonProps extends React.HTMLAttributes<HTMLSpanElement> {}

export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <span
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        "block rounded-sm bg-[var(--surface-muted)] motion-safe:animate-pulse motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}
