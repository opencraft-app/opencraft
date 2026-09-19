import type { HTMLAttributes, ReactNode } from "react";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export interface AgentPageLoadingStateProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
}

export function AgentPageLoadingState({ title, className, ...props }: AgentPageLoadingStateProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn(
        "flex min-h-[min(60vh,520px)] w-full flex-col items-center justify-center gap-3 text-sm text-[var(--text-secondary)]",
        className,
      )}
      {...props}
    >
      <Spinner size="lg" />
      <span>{title}</span>
    </div>
  );
}
