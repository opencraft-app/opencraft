import { useRef, type ReactNode, type RefObject } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { agentPortalClassName } from "@/components/agents";

export interface ConsoleEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  closeLabel: string;
  pending?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
}

export function ConsoleEditDialog({ open, onOpenChange, title, description, closeLabel, pending = false, returnFocusRef, children, className }: ConsoleEditDialogProps) {
  const trigger = useRef<HTMLElement | null>(null);
  return <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
    <DialogContent portalClassName={agentPortalClassName} showCloseButton={!pending} closeLabel={closeLabel} className={className} {...(!description ? { "aria-describedby": undefined } : {})}
      onOpenAutoFocus={() => { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={(event) => { const target = returnFocusRef?.current ?? trigger.current; if (target?.isConnected) { event.preventDefault(); target.focus(); } }}
      onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }}
      onPointerDownOutside={(event) => { if (pending) event.preventDefault(); }}>
      <DialogHeader className="mb-5 pr-8"><DialogTitle className="text-balance text-lg tracking-normal">{title}</DialogTitle>{description && <DialogDescription>{description}</DialogDescription>}</DialogHeader>
      {children}
    </DialogContent>
  </Dialog>;
}
