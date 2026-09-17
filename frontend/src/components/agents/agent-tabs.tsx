import * as React from "react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type AgentTabsVariant = "segmented" | "underline";

const listClasses: Record<AgentTabsVariant, string> = {
  segmented: "rounded-md border-[var(--agent-tabs-border,#deded9)] bg-[var(--agent-tabs-track,#f3f3f1)] shadow-none",
  underline: "h-auto justify-start gap-4 rounded-none border-0 border-b border-[var(--agent-tabs-divider,var(--border-subtle))] bg-transparent p-0 shadow-none",
};

const triggerClasses: Record<AgentTabsVariant, string> = {
  segmented: "rounded-sm border border-transparent shadow-none data-[state=active]:border-[var(--agent-tabs-border,#deded9)] data-[state=active]:bg-[var(--agent-tabs-selected,#fff)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:shadow-none",
  underline: "relative h-auto min-w-0 rounded-none border-0 bg-transparent px-0 py-3 text-[var(--text-secondary)] shadow-none after:absolute after:inset-x-0 after:bottom-[-1px] after:h-0.5 after:bg-transparent after:content-[''] hover:text-[var(--text-primary)] data-[state=active]:bg-transparent data-[state=active]:text-[var(--text-primary)] data-[state=active]:shadow-none data-[state=active]:after:bg-[var(--text-primary)]",
};

export interface AgentTabsListProps extends React.ComponentPropsWithoutRef<typeof TabsList> {
  variant: AgentTabsVariant;
}

export const AgentTabsList = React.forwardRef<React.ComponentRef<typeof TabsList>, AgentTabsListProps>(
  ({ variant, className, ...props }, ref) => <TabsList ref={ref} data-agent-tabs-variant={variant} className={cn(listClasses[variant], className)} {...props} />,
);
AgentTabsList.displayName = "AgentTabsList";

export interface AgentTabsTriggerProps extends React.ComponentPropsWithoutRef<typeof TabsTrigger> {
  variant: AgentTabsVariant;
}

export const AgentTabsTrigger = React.forwardRef<React.ComponentRef<typeof TabsTrigger>, AgentTabsTriggerProps>(
  ({ variant, className, ...props }, ref) => <TabsTrigger ref={ref} data-agent-tabs-variant={variant} className={cn(triggerClasses[variant], className)} {...props} />,
);
AgentTabsTrigger.displayName = "AgentTabsTrigger";
