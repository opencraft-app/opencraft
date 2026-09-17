import * as React from "react";
import { Check } from "lucide-react";
import { RadioGroup, RadioGroupIndicator, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

export type AgentChoiceGroupProps = React.ComponentPropsWithoutRef<typeof RadioGroup>;

export const AgentChoiceGroup = React.forwardRef<React.ComponentRef<typeof RadioGroup>, AgentChoiceGroupProps>(
  ({ className, ...props }, ref) => <RadioGroup ref={ref} className={cn("grid grid-cols-1 gap-2", className)} {...props} />,
);
AgentChoiceGroup.displayName = "AgentChoiceGroup";

export type AgentChoiceGroupItemProps = React.ComponentPropsWithoutRef<typeof RadioGroupItem>;

export const AgentChoiceGroupItem = React.forwardRef<React.ComponentRef<typeof RadioGroupItem>, AgentChoiceGroupItemProps>(
  ({ className, children, ...props }, ref) => (
    <RadioGroupItem
      ref={ref}
      className={cn(
        "group/agent-choice relative flex h-auto w-full flex-col items-start justify-start gap-1 whitespace-normal rounded-md border border-[var(--agent-tabs-choice-border,var(--border-subtle))] bg-[var(--surface-base,#fff)] p-3 pr-10 text-left text-[var(--text-secondary)] shadow-none data-[state=checked]:border-[var(--agent-tabs-choice-selected-border,var(--text-primary))] data-[state=checked]:bg-[var(--agent-tabs-choice-selected,#f2f2ef)] data-[state=checked]:text-[var(--text-primary)]",
        className,
      )}
      {...props}
    >
      {children}
      <span className="pointer-events-none absolute right-3 top-3 inline-flex size-5 items-center justify-center rounded-full border border-current opacity-0 group-data-[state=checked]/agent-choice:opacity-100" aria-hidden="true">
        <RadioGroupIndicator><Check className="size-3" /></RadioGroupIndicator>
      </span>
    </RadioGroupItem>
  ),
);
AgentChoiceGroupItem.displayName = "AgentChoiceGroupItem";
