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
      const { pointerId } = event;
      let cancelled = false;
      const cancel = () => { cancelled = true; tap.current = false; };
      const anotherPointer = (next: PointerEvent) => { if (next.pointerId !== pointerId) cancel(); };
      const scroll = (next: Event) => {
        if (next.target === document || (next.target instanceof Element && next.target.contains(button))) cancel();
      };
      const release = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        const bounds = button.getBoundingClientRect();
        // The browser classifies movement and duration before emitting click.
        // A second pixel/time threshold silently rejects native accepted taps.
        tap.current = !cancelled && button.isConnected && !button.disabled
          && next.clientX >= bounds.left && next.clientX <= bounds.right
          && next.clientY >= bounds.top && next.clientY <= bounds.bottom;
        cleanup.current?.();
        cleanup.current = undefined;
      };
      const abort = (next: PointerEvent) => { if (next.pointerId === pointerId) reset(); };
      document.addEventListener("pointerdown", anotherPointer, true);
      document.addEventListener("pointerup", release, true);
      document.addEventListener("pointercancel", abort, true);
      document.addEventListener("scroll", scroll, true);
      cleanup.current = () => {
        document.removeEventListener("pointerdown", anotherPointer, true);
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
    onContextMenu(event) {
      if (!touch.current) return;
      event.preventDefault();
      // A browser-recognized long press owns this contact. Its release must
      // not open the dropdown, including a later compatibility click.
      reset();
    },
  };
}
