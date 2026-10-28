import { useEffect, useRef, type HTMLAttributes } from "react";
import { useTouchContactScope } from "./touch-contact";

/** Adapt direct touch activation; Radix still owns mouse, keyboard and the menu. */
export function useTouchMenuTrigger(enabled: boolean, onTap: () => void): HTMLAttributes<HTMLButtonElement> {
  const touch = useRef(false);
  const tap = useRef(false);
  const scope = useTouchContactScope();
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
      // The shared trigger withholds Radix's eager open without cancelling
      // the native pointerdown, so touch scrolling and native clicks survive.
      if (!event.isPrimary || event.button !== 0) return;
      const button = event.currentTarget;
      const document = button.ownerDocument;
      const { pointerId } = event;
      if (scope !== null && !scope.claim(pointerId, "menu")) return;
      tap.current = true;
      const cancel = () => { tap.current = false; scope?.cancel(pointerId); };
      const anotherPointer = (next: PointerEvent) => { if (next.pointerId !== pointerId) cancel(); };
      const release = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        // Release only retires listeners. The browser owns hit testing and
        // click classification; missing a derived release is not cancellation.
        cleanup.current?.();
        cleanup.current = undefined;
        scope?.release(pointerId);
      };
      const abort = (next: PointerEvent) => { if (next.pointerId === pointerId) reset(); };
      document.addEventListener("pointerdown", anotherPointer, true);
      document.addEventListener("pointerup", release, true);
      document.addEventListener("pointercancel", abort, true);
      cleanup.current = () => {
        document.removeEventListener("pointerdown", anotherPointer, true);
        document.removeEventListener("pointerup", release, true);
        document.removeEventListener("pointercancel", abort, true);
      };
    },
    onClick(event) {
      // Keyboard/AT clicks have no preceding touch; leave them to Radix.
      if (!touch.current || event.detail === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const activate = enabled && tap.current && event.currentTarget.isConnected && !event.currentTarget.disabled;
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
