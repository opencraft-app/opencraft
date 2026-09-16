// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
"use client";
import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { agentPortalClassName } from "./styles";

export interface AgentTooltipProps {
  children: ReactElement;
  content?: string;
  /** Use control only for an enabled, already focusable element. */
  triggerMode?: "control" | "explanation";
  side?: "top" | "bottom" | "left" | "right";
}
export function AgentTooltip({ children, content, triggerMode = "explanation", side = "top" }: AgentTooltipProps) {
  if (!content) return children;
  return <TooltipProvider delayDuration={200}>
    <Tooltip>
      <TooltipTrigger asChild>
        {triggerMode === "control" ? children : (
          <span role="group" aria-label={content} tabIndex={0}
            className="inline-flex min-w-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
            {children}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side={side} portalClassName={agentPortalClassName}>{content}</TooltipContent>
    </Tooltip>
  </TooltipProvider>;
}
