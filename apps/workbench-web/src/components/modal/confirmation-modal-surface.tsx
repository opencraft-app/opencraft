import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useRef, type CSSProperties, type ReactNode } from "react";
import { Button } from "../ui/button";
import type { ModalRequest } from "./modal-controller";

/** Shared confirmation primitive. Features supply content/actions, not focus or keyboard rules. */
export function ConfirmationModalSurface({ label, children, confirmation, onDismiss, portalContainer, stackIndex = 0, returnFocus, size = "wide" }: {
  label: string; children: ReactNode; confirmation: NonNullable<ModalRequest["confirmation"]>;
  onDismiss: ModalRequest["onDismiss"]; portalContainer?: HTMLElement | null; stackIndex?: number; returnFocus?: () => HTMLElement | null;
  size?: "compact" | "default" | "wide";
}) {
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const style = { "--modal-stack-offset": stackIndex * 2 } as CSSProperties;
  return <AlertDialog.Root open onOpenChange={open => { if (!open) onDismiss("system"); }}>
    <AlertDialog.Portal container={portalContainer ?? undefined}>
      <AlertDialog.Overlay className="modal-surface__scrim" data-layer="confirmation" data-appearance="utility" style={style} />
      <AlertDialog.Content className="modal-surface modal-confirmation" data-size={size} data-layer="confirmation" data-appearance="utility" style={style}
        onCloseAutoFocus={event => { const target = returnFocus?.() ?? opener.current; if (target?.isConnected) { event.preventDefault(); target.focus({ preventScroll: true }); } }}>
        <AlertDialog.Title className="modal-surface__accessible-title">{label}</AlertDialog.Title>
        <AlertDialog.Description asChild><div>{children}</div></AlertDialog.Description>
        <div className="modal-confirmation__actions">
          <AlertDialog.Cancel asChild><Button variant="secondary">{confirmation.cancelLabel ?? "取消"}</Button></AlertDialog.Cancel>
          <AlertDialog.Action asChild><Button variant="primary" onClick={confirmation.onConfirm}>{confirmation.confirmLabel}</Button></AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}
