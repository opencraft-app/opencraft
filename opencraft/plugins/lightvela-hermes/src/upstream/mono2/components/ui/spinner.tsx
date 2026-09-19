// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import * as React from "react";
import { Loader2 } from "lucide-react";

import { cn } from "../../lib/utils";

const spinnerSizeClasses = {
  xs: "size-3",
  sm: "size-3.5",
  md: "size-4",
  lg: "size-5",
} as const;

export interface SpinnerProps extends React.SVGProps<SVGSVGElement> {
  size?: keyof typeof spinnerSizeClasses;
}

export function Spinner({
  size = "md",
  className,
  "aria-label": ariaLabel,
  ...props
}: SpinnerProps) {
  return (
    <Loader2
      data-slot="spinner"
      data-size={size}
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      className={cn(spinnerSizeClasses[size], "shrink-0 motion-safe:animate-spin motion-reduce:animate-none", className)}
      {...props}
    />
  );
}
