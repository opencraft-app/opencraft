// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { controlFieldClass, floatingPanelClass } from "./control-shell";
import { cn } from "../../lib/utils";

const Select = SelectPrimitive.Root;
const SelectValue = SelectPrimitive.Value;
type SelectVariant = "default" | "filter";

const SelectSeparator = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("lv-select-separator my-1 h-px bg-black/[0.08]", className)}
    {...props}
  />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

const SelectTrigger = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & { variant?: SelectVariant }
>(({ className, children, variant = "default", ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "lv-select-trigger",
      variant === "filter" && "lv-select-trigger--filter",
      controlFieldClass,
      "flex h-11 items-center justify-between px-3.5 py-2 text-sm",
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon>
      <ChevronDown className="size-4 text-[var(--text-tertiary)]" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectContent = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content> & { variant?: SelectVariant }
>(({ className, children, position, variant = "default", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position ?? (variant === "filter" ? "popper" : undefined)}
      className={cn(
        "lv-select-content",
        variant === "filter" && "lv-select-content--filter",
        "lightvela-agent-console-portal z-50 min-w-[12rem] overflow-hidden rounded-[1.25rem]",
        floatingPanelClass,
        className,
      )}
      {...props}
    >
      <SelectPrimitive.Viewport className="lv-select-viewport p-1.5">{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectItem = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & { variant?: SelectVariant }
>(({ className, children, variant = "default", ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "lv-select-item",
      variant === "filter" && "lv-select-item--filter",
      "relative flex w-full cursor-default select-none items-center rounded-[0.85rem] py-2.5 pl-8 pr-3 text-sm text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--surface-muted)]",
      className,
    )}
    {...props}
  >
    <span className="lv-select-item__indicator absolute left-2 flex size-4 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="size-3.5" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

export { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue };
