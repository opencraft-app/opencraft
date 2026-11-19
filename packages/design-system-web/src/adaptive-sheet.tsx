import { useCallback, useEffect, useRef, type PointerEvent } from "react";
import { useTouchLayout } from "./use-touch-layout";
import "./adaptive-sheet.scss";

/** Optional touch gesture; capacity alone never turns a pointer dialog into a sheet. */
export function AdaptiveSheetHandle({ onDismiss }: { readonly onDismiss: () => void }) {
  const touch = useTouchLayout();
  const surface = useRef<HTMLElement | null>(null);
  const handle = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number; startY: number; offset: number } | null>(null);
  const resetDrag = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    surface.current?.style.removeProperty("--modal-sheet-offset");
    surface.current?.removeAttribute("data-dragging");
    if (current && handle.current?.hasPointerCapture(current.pointerId))
      handle.current.releasePointerCapture(current.pointerId);
  }, []);
  const canDrag = () =>
    touch && surface.current?.ownerDocument.defaultView?.matchMedia("(max-width: 640px)").matches === true;
  useEffect(() => {
    resetDrag();
    const view = surface.current?.ownerDocument.defaultView;
    view?.addEventListener("resize", resetDrag);
    return () => {
      view?.removeEventListener("resize", resetDrag);
      resetDrag();
    };
  }, [touch, resetDrag]);
  const endDrag = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dismiss =
      !cancelled && canDrag() && current.offset >= Math.min(80, (surface.current?.offsetHeight ?? 240) * 0.3);
    if (dismiss) {
      // Keep the release position while Presence owns the exit.
      drag.current = null;
      surface.current?.removeAttribute("data-dragging");
      onDismiss();
    } else resetDrag();
  };
  return (
    <div
      className="modal-surface__sheet-handle"
      aria-hidden="true"
      ref={(element) => {
        handle.current = element;
        surface.current = element?.parentElement ?? null;
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0 || event.pointerType === "mouse" || !canDrag()) return;
        drag.current = { pointerId: event.pointerId, startY: event.clientY, offset: 0 };
        surface.current?.setAttribute("data-dragging", "true");
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        current.offset = Math.max(0, event.clientY - current.startY);
        surface.current?.style.setProperty("--modal-sheet-offset", `${current.offset}px`);
      }}
      onPointerUp={(event) => endDrag(event)}
      onPointerCancel={(event) => endDrag(event, true)}
      onLostPointerCapture={() => {
        if (drag.current) resetDrag();
      }}
    >
      <span />
    </div>
  );
}
