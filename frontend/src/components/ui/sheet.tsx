import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogClose, DialogDescription, DialogOverlay, DialogPortal, DialogTrigger } from "./dialog";

const Sheet = Dialog;
const SheetTrigger = DialogTrigger;
const SheetClose = DialogClose;
const SheetDescription = DialogDescription;

type SheetContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  side?: "left" | "right";
  closeLabel: string;
  portalClassName?: string;
  overlayClassName?: string;
};

const SheetContent = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, SheetContentProps>(
  ({ className, portalClassName, overlayClassName, side = "right", closeLabel, children, ...props }, ref) => (
    <DialogPortal>
      <DialogOverlay className={cn("bg-black/40 backdrop-blur-none", portalClassName, overlayClassName)} />
      <DialogPrimitive.Content
        ref={ref}
        data-slot="sheet-content"
        className={cn("fixed inset-y-0 z-50 flex h-dvh w-80 max-w-[calc(100vw-2rem)] flex-col gap-4 overflow-y-auto border-[var(--border-subtle)] bg-white px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))] text-[var(--text-primary)] shadow-xl outline-none", side === "left" ? "left-0 border-r pl-[max(1.25rem,env(safe-area-inset-left))]" : "right-0 border-l pr-[max(1.25rem,env(safe-area-inset-right))]", portalClassName, className)}
        {...props}
      >
        {children}
        <SheetClose aria-label={closeLabel} className="absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] inline-flex size-9 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
          <X className="size-4" aria-hidden="true" />
        </SheetClose>
      </DialogPrimitive.Content>
    </DialogPortal>
  ),
);
SheetContent.displayName = "SheetContent";

function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-1 space-y-2 pr-8", className)} {...props} />;
}

const SheetTitle = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Title>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>>(
  ({ className, ...props }, ref) => <DialogPrimitive.Title ref={ref} className={cn("text-balance text-lg font-semibold", className)} {...props} />,
);
SheetTitle.displayName = "SheetTitle";

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger };
export type { SheetContentProps };
