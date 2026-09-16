import { type ComponentProps } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

export function PersonaOverwriteConfirmView({ open, pending, title, description, backLabel, confirmLabel, onBack, onClose, onConfirm, onCloseAutoFocus }: {
  open: boolean;
  pending: boolean;
  title: string;
  description: string;
  backLabel: string;
  confirmLabel: string;
  onBack: () => void;
  onClose: () => void;
  onConfirm: () => void;
  onCloseAutoFocus: ComponentProps<typeof AlertDialogContent>["onCloseAutoFocus"];
}) {
  if (!open) return null;
  return <AlertDialog open={open} onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
    <AlertDialogContent portalClassName="agents-ui" onCloseAutoFocus={onCloseAutoFocus}
      onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }}>
      <AlertDialogHeader className="mb-5">
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter className="justify-end">
        <AlertDialogCancel disabled={pending} className="h-9 rounded-md shadow-none transition-none hover:translate-y-0"
          onClick={(event) => { event.preventDefault(); onBack(); }}>{backLabel}</AlertDialogCancel>
        <AlertDialogAction disabled={pending} className="h-9 rounded-md shadow-none transition-none hover:translate-y-0"
          onClick={(event) => { event.preventDefault(); onConfirm(); }}>{confirmLabel}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
