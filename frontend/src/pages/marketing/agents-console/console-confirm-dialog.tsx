import { useRef, type ReactNode, type RefObject } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { agentPortalClassName } from "@/components/agents";

export interface ConsoleConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  pending?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function ConsoleConfirmDialog({ open, onOpenChange, title, description, confirmLabel, cancelLabel, pending = false, confirmDisabled = false, onConfirm, children, returnFocusRef }: ConsoleConfirmDialogProps) {
  const trigger = useRef<HTMLElement | null>(null);
  return <AlertDialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
    <AlertDialogContent portalClassName={agentPortalClassName}
      onOpenAutoFocus={() => { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={(event) => {
        const target = returnFocusRef?.current ?? trigger.current;
        if (target?.isConnected) { event.preventDefault(); target.focus(); }
      }}
      onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }}>
      <AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription asChild><div>{description}</div></AlertDialogDescription></AlertDialogHeader>
      {children}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
        <AlertDialogAction disabled={pending || confirmDisabled} onClick={(event) => { event.preventDefault(); onConfirm(); }}>{confirmLabel}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
