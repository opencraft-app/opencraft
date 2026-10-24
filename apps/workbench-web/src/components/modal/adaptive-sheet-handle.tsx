import { useRef, type PointerEvent } from "react";
import "./adaptive-sheet.scss";

/** Optional Web modal gesture; loaded with sheet content, never ordinary dialogs. */
export function AdaptiveSheetHandle({ onDismiss }: { readonly onDismiss: () => void }) {
  const surface = useRef<HTMLElement | null>(null);
  const drag = useRef<{ pointerId: number; startY: number; offset: number } | null>(null);
  const resetDrag = () => {
    drag.current = null;
    surface.current?.style.removeProperty("--modal-sheet-offset");
    surface.current?.removeAttribute("data-dragging");
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dismiss = !cancelled && matchMedia("(max-width: 640px)").matches
      && current.offset >= Math.min(80, (surface.current?.offsetHeight ?? 240) * .3);
    resetDrag();
    if (dismiss) onDismiss();
  };
  return <div className="modal-surface__sheet-handle" aria-hidden="true"
    ref={element => { surface.current = element?.parentElement ?? null; }}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0 || !matchMedia("(max-width: 640px)").matches) return;
      drag.current = { pointerId: event.pointerId, startY: event.clientY, offset: 0 };
      surface.current?.setAttribute("data-dragging", "true");
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      current.offset = Math.max(0, event.clientY - current.startY);
      surface.current?.style.setProperty("--modal-sheet-offset", `${current.offset}px`);
    }}
    onPointerUp={event => endDrag(event)} onPointerCancel={event => endDrag(event, true)}
    onLostPointerCapture={resetDrag}><span /></div>;
}
