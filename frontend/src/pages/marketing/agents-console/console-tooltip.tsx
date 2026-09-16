import { isValidElement, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { agentPortalClassName } from "@/components/agents";
import { cn } from "@/lib/utils";

export function ConsoleTooltip({ children, content, label, side = "top", className }: { children: ReactNode; content?: ReactNode; label?: string; side?: "top" | "bottom"; className?: string }) {
  if (!content) return <>{children}</>;
  const enabledControl = isValidElement<{ disabled?: boolean }>(children) && !children.props.disabled;
  return <Tooltip>
    <TooltipTrigger asChild>{enabledControl ? children : <span tabIndex={0} aria-label={label} className={cn("inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]", className)}>{children}</span>}</TooltipTrigger>
    <TooltipContent side={side} portalClassName={agentPortalClassName}>{content}</TooltipContent>
  </Tooltip>;
}
