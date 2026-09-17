// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "../../lib/utils";

const RadioGroup = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root ref={ref} className={cn("lv-radio-group grid gap-2", className)} {...props} />
));
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName;

const RadioGroupItem = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item ref={ref} className={cn("lv-radio-group__item focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]", className)} {...props} />
));
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName;

const RadioGroupIndicator = RadioGroupPrimitive.Indicator;

export { RadioGroup, RadioGroupIndicator, RadioGroupItem };
