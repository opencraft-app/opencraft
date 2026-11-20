import { useEffect, useRef, useState, type PointerEvent } from "react";
import { TOUCH_PAN_DEADZONE } from "./touch-contact";

// A contact in a scrollable collection is undecided before this dwell. This
// delays paint only, never native click delivery or scrolling.
const TOUCH_ROW_PRESS_DELAY_MS = 100;

/** Visual press eligibility only. Native scrolling, click and context menus keep ownership. */
export function useTouchPress(disabled: boolean) {
  const [eligible, setEligible] = useState<boolean | undefined>(undefined);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  const retire = () => { cleanup.current?.(); cleanup.current = undefined; };
  useEffect(() => {
    if (disabled) setEligible(false);
    return retire;
  }, [disabled]);
  return {
    "data-touch-press": eligible,
    onKeyDown() { retire(); setEligible(undefined); },
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      retire();
      const touch = event.pointerType === "touch" || event.pointerType === "pen";
      setEligible(touch ? false : undefined);
      if (!touch || disabled || event.defaultPrevented || !event.isPrimary || event.button !== 0) return;
      const document = event.currentTarget.ownerDocument, window = document.defaultView;
      const { pointerId, clientX: x, clientY: y } = event;
      const timer = setTimeout(() => setEligible(true), TOUCH_ROW_PRESS_DELAY_MS);
      const cancel = () => { retire(); setEligible(false); };
      const move = (next: globalThis.PointerEvent) => {
        if (next.pointerId === pointerId && Math.hypot(next.clientX - x, next.clientY - y) >= TOUCH_PAN_DEADZONE) cancel();
      };
      const end = (next: globalThis.PointerEvent) => { if (next.pointerId === pointerId) cancel(); };
      const another = (next: globalThis.PointerEvent) => { if (next.pointerId !== pointerId) cancel(); };
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", end, true);
      document.addEventListener("pointercancel", end, true);
      document.addEventListener("pointerdown", another, true);
      document.addEventListener("scroll", cancel, true);
      document.addEventListener("contextmenu", cancel, true);
      window?.addEventListener("blur", cancel);
      cleanup.current = () => {
        clearTimeout(timer);
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", end, true);
        document.removeEventListener("pointercancel", end, true);
        document.removeEventListener("pointerdown", another, true);
        document.removeEventListener("scroll", cancel, true);
        document.removeEventListener("contextmenu", cancel, true);
        window?.removeEventListener("blur", cancel);
      };
    },
  };
}
