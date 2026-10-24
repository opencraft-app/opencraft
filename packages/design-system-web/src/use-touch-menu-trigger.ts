import { useEffect, useRef, type HTMLAttributes } from "react";

/** Adapt direct touch activation; Radix still owns mouse, keyboard and the menu. */
export function useTouchMenuTrigger(enabled: boolean, onTap: () => void): HTMLAttributes<HTMLButtonElement> {
  const touch = useRef(false);
  const tap = useRef(false);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  const reset = () => {
    cleanup.current?.();
    cleanup.current = undefined;
    tap.current = false;
  };
  useEffect(() => reset, [enabled]);

  return {
    onPointerDown(event) {
      reset();
      touch.current = (event.pointerType === "touch" || event.pointerType === "pen");
      if (!touch.current || !enabled) return;
      // Stop only Radix's eager open, not the browser's native pan gesture.
      event.preventDefault();
      if (!event.isPrimary || event.button !== 0) return;
      const button = event.currentTarget;
      const document = button.ownerDocument;
      const { pointerId, clientX, clientY, timeStamp } = event;
      let moved = false;
      const update = (next: PointerEvent) => {
        if (next.pointerId === pointerId && Math.hypot(next.clientX - clientX, next.clientY - clientY) > 10) moved = true;
      };
      const cancel = () => { moved = true; tap.current = false; };
      const anotherPointer = (next: PointerEvent) => { if (next.pointerId !== pointerId) cancel(); };
      const scroll = (next: Event) => {
        if (next.target === document || (next.target instanceof Element && next.target.contains(button))) cancel();
      };
      const release = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        update(next);
        const bounds = button.getBoundingClientRect();
        tap.current = !moved && next.timeStamp - timeStamp <= 500
          && next.clientX >= bounds.left && next.clientX <= bounds.right
          && next.clientY >= bounds.top && next.clientY <= bounds.bottom;
        cleanup.current?.();
        cleanup.current = undefined;
      };
      const abort = (next: PointerEvent) => { if (next.pointerId === pointerId) reset(); };
      document.addEventListener("pointerdown", anotherPointer, true);
      document.addEventListener("pointermove", update, true);
      document.addEventListener("pointerup", release, true);
      document.addEventListener("pointercancel", abort, true);
      document.addEventListener("scroll", scroll, true);
      cleanup.current = () => {
        document.removeEventListener("pointerdown", anotherPointer, true);
        document.removeEventListener("pointermove", update, true);
        document.removeEventListener("pointerup", release, true);
        document.removeEventListener("pointercancel", abort, true);
        document.removeEventListener("scroll", scroll, true);
      };
    },
    onClick(event) {
      // Keyboard/AT clicks have no preceding touch; leave them to Radix.
      if (!touch.current || event.detail === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const activate = enabled && tap.current;
      reset();
      if (activate) onTap();
    },
    onKeyDown() { touch.current = false; reset(); },
    onContextMenu(event) { if (touch.current) event.preventDefault(); },
  };
}
