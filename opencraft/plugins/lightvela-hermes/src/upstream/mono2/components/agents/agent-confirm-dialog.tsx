// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
"use client";
import { type ComponentProps, type ReactNode, type RefObject, useRef } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../ui/alert-dialog";
import { agentButtonClassName, agentPortalClassName } from "./styles";

export interface AgentConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  confirmDisabled?: boolean;
  confirmVariant?: "default" | "destructive";
  /** The host decides whether pending work blocks cancellation. */
  cancelDisabled?: boolean;
  onConfirm: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onCloseAutoFocus?: ComponentProps<typeof AlertDialogContent>["onCloseAutoFocus"];
  children?: ReactNode;
}
export function AgentConfirmDialog({ open, onOpenChange, title, description, confirmLabel, cancelLabel, confirmDisabled, confirmVariant = "destructive", cancelDisabled, onConfirm, returnFocusRef, onCloseAutoFocus, children }: AgentConfirmDialogProps) {
  const trigger = useRef<HTMLElement | null>(null);
  return <AlertDialog open={open} onOpenChange={(next) => { if (!cancelDisabled || next) onOpenChange(next); }}>
    <AlertDialogContent portalClassName={agentPortalClassName}
      onOpenAutoFocus={() => { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event);
        if (event.defaultPrevented) return;
        const target = returnFocusRef?.current ?? trigger.current;
        if (target?.isConnected) { event.preventDefault(); target.focus(); }
      }}
      onEscapeKeyDown={(event) => { if (cancelDisabled) event.preventDefault(); }}>
      <AlertDialogHeader className="mb-5">
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription asChild><div>{description}</div></AlertDialogDescription>
      </AlertDialogHeader>
      {children}
      <AlertDialogFooter>
        <AlertDialogCancel className={agentButtonClassName} disabled={cancelDisabled}>{cancelLabel}</AlertDialogCancel>
        <AlertDialogAction variant={confirmVariant} className={agentButtonClassName} disabled={confirmDisabled} onClick={(event) => {
          // Preserve each host's existing close/commit ordering.
          event.preventDefault();
          onConfirm();
        }}>{confirmLabel}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
