import * as React from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { cn } from "@/lib/utils";
import { Button } from "./button";

const AlertDialog = AlertDialogPrimitive.Root;
const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

type AlertDialogContentProps = React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content> & {
  portalClassName?: string;
  overlayClassName?: string;
};

const AlertDialogContent = React.forwardRef<React.ComponentRef<typeof AlertDialogPrimitive.Content>, AlertDialogContentProps>(
  ({ className, portalClassName, overlayClassName, ...props }, ref) => (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className={cn("fixed inset-0 z-50 bg-black/40", portalClassName, overlayClassName)} />
      <AlertDialogPrimitive.Content
        ref={ref}
        data-slot="alert-dialog-content"
        className={cn("fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-[calc(100%-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto break-words rounded-md border border-[var(--border-subtle)] bg-white p-6 text-[var(--text-primary)] shadow-xl outline-none", portalClassName, className)}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  ),
);
AlertDialogContent.displayName = "AlertDialogContent";

function AlertDialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-5 space-y-2", className)} {...props} />;
}

function AlertDialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

const AlertDialogTitle = React.forwardRef<React.ComponentRef<typeof AlertDialogPrimitive.Title>, React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>>(
  ({ className, ...props }, ref) => <AlertDialogPrimitive.Title ref={ref} className={cn("text-balance text-lg font-semibold", className)} {...props} />,
);
AlertDialogTitle.displayName = "AlertDialogTitle";

const AlertDialogDescription = React.forwardRef<React.ComponentRef<typeof AlertDialogPrimitive.Description>, React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>>(
  ({ className, ...props }, ref) => <AlertDialogPrimitive.Description ref={ref} className={cn("text-pretty text-sm leading-6 text-[var(--text-secondary)]", className)} {...props} />,
);
AlertDialogDescription.displayName = "AlertDialogDescription";

// Keep Radix's action semantics: async callers preventDefault and control open themselves.
const AlertDialogAction = React.forwardRef<React.ComponentRef<typeof AlertDialogPrimitive.Action>, React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action> & { variant?: React.ComponentProps<typeof Button>["variant"] }>(
  ({ className, asChild, variant = "destructive", ...props }, ref) => (
    <AlertDialogPrimitive.Action asChild>
      <Button ref={ref} asChild={asChild} variant={variant} className={cn("rounded-md transition-none", className)} {...props} />
    </AlertDialogPrimitive.Action>
  ),
);
AlertDialogAction.displayName = "AlertDialogAction";

const AlertDialogCancel = React.forwardRef<React.ComponentRef<typeof AlertDialogPrimitive.Cancel>, React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>>(
  ({ className, asChild, ...props }, ref) => (
    <AlertDialogPrimitive.Cancel asChild>
      <Button ref={ref} asChild={asChild} variant="outline" className={cn("rounded-md transition-none", className)} {...props} />
    </AlertDialogPrimitive.Cancel>
  ),
);
AlertDialogCancel.displayName = "AlertDialogCancel";

export { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger };
export type { AlertDialogContentProps };
