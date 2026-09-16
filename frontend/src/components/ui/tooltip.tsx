import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

const TooltipSelectionContext = React.createContext<React.RefObject<boolean> | null>(null);

function Tooltip(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const selectingContent = React.useRef(false);
  React.useEffect(() => {
    if (props.open === false) selectingContent.current = false;
  }, [props.open]);
  return <TooltipSelectionContext.Provider value={selectingContent}><TooltipPrimitive.Root {...props} onOpenChange={(open) => {
    // Content may disappear before pointerup (for example, Escape while dragging).
    if (!open) selectingContent.current = false;
    props.onOpenChange?.(open);
  }} /></TooltipSelectionContext.Provider>;
}

const TooltipTrigger = React.forwardRef<React.ComponentRef<typeof TooltipPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>>(
  ({ onBlur, ...props }, ref) => {
    const selectingContent = React.useContext(TooltipSelectionContext);
    return <TooltipPrimitive.Trigger ref={ref} {...props} onBlur={(event) => {
      onBlur?.(event);
      // Only suppress Radix's blur-close during native selection in this tooltip.
      // The pointer event remains uncancelled, so text selection still works.
      if (selectingContent?.current) {
        selectingContent.current = false;
        event.preventDefault();
      }
    }} />;
  },
);
TooltipTrigger.displayName = "TooltipTrigger";
const TooltipProvider = TooltipPrimitive.Provider;

type TooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
  portalClassName?: string;
};

const TooltipContent = React.forwardRef<React.ComponentRef<typeof TooltipPrimitive.Content>, TooltipContentProps>(
  ({ className, portalClassName, children, sideOffset = 6, collisionPadding = 8, onPointerDownCapture, onPointerUpCapture, onPointerCancel, ...props }, ref) => {
    const selectingContent = React.useContext(TooltipSelectionContext);
    return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        data-slot="tooltip-content"
        className={cn("pointer-events-auto z-50 max-w-[min(20rem,var(--radix-tooltip-content-available-width))] select-text break-words rounded-md border border-[var(--border-subtle)] bg-white px-3 py-1.5 text-pretty text-[11px] font-medium text-[var(--text-primary)] shadow-[0_8px_24px_rgba(15,23,42,0.12)]", portalClassName, className)}
        {...props}
        onPointerDownCapture={(event) => {
          if (selectingContent) selectingContent.current = event.button === 0;
          onPointerDownCapture?.(event);
        }}
        onPointerUpCapture={(event) => {
          if (selectingContent) selectingContent.current = false;
          onPointerUpCapture?.(event);
        }}
        onPointerCancel={(event) => {
          if (selectingContent) selectingContent.current = false;
          onPointerCancel?.(event);
        }}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-white" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
    );
  },
);
TooltipContent.displayName = "TooltipContent";

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
export type { TooltipContentProps };
