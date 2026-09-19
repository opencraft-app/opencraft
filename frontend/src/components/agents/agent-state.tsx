import type { HTMLAttributes, ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface AgentStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  kind: "loading" | "empty" | "error" | "success";
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function AgentState({ kind, title, description, action, className, ...props }: AgentStateProps) {
  return (
    <div role={kind === "error" ? "alert" : "status"} aria-busy={kind === "loading"} className={cn("rounded-md border border-[var(--border-subtle)] bg-white p-5", kind === "error" && "border-red-200 bg-red-50", className)} {...props}>
      <p className={cn("text-pretty text-sm font-medium text-[var(--text-primary)]", kind === "error" && "text-red-800")}>{title}</p>
      {description && <div className="mt-1 text-pretty text-sm leading-6 text-[var(--text-secondary)]">{description}</div>}
      {kind === "loading" && <div aria-hidden="true" className="mt-4 space-y-2"><Skeleton className="h-3 w-2/3" /><Skeleton className="h-3 w-1/2" /></div>}
      {action && <div className="mt-4 flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}
