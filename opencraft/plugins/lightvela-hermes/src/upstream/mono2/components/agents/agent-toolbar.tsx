// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface AgentToolbarProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  actions?: ReactNode;
}

/** A labelled group of normal controls; tab order remains owned by each control. */
export function AgentToolbar({ label, actions, className, children, ...props }: AgentToolbarProps) {
  return (
    <div role="group" aria-label={label} className={cn("flex min-w-0 flex-wrap items-center gap-3", className)} {...props}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
