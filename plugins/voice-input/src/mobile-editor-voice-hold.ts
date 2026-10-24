import { useEffect, useRef, type RefObject } from "react";

/** A trusted action owns voice; its local Composer surface owns touch intent. */
export function useMobileEditorVoiceHold(action: RefObject<HTMLButtonElement | null>, callbacks: {
  enabled: boolean; start(): void; finish(): void; cancel(): void;
}) {
  const latest = useRef(callbacks); latest.current = callbacks;
  useEffect(() => {
    const surface = action.current?.closest<HTMLElement>(".opencraft-composer-stack");
    if (!surface) return;
    let held: { id: number; x: number; y: number; active: boolean; editor: HTMLElement } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let suppressUntil = 0;
    const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    const cancel = () => {
      clear(); const previous = held; held = null;
      if (previous?.active) { suppressUntil = performance.now() + 500; latest.current.cancel(); }
    };
    const down = (event: PointerEvent) => {
      if (held) { cancel(); return; }
      suppressUntil = 0;
      if (event.pointerType !== "touch" || !event.isPrimary || !latest.current.enabled
        || (document.documentElement.dataset.uiDensity === "compact"
          || (document.documentElement.dataset.uiDensity !== "touch" && !matchMedia("(any-pointer: coarse)").matches))
        || window.getSelection()?.toString()) return;
      const editor = event.target instanceof Element ? event.target.closest<HTMLElement>(".opencraft-composer-editor") : null;
      if (!editor || !surface.contains(editor)) return;
      held = { id: event.pointerId, x: event.clientX, y: event.clientY, active: false, editor };
      timer = setTimeout(() => {
        timer = null;
        if (!held || !latest.current.enabled || window.getSelection()?.toString()) { cancel(); return; }
        held.active = true;
        editor.blur();
        latest.current.start();
      }, 450);
    };
    const move = (event: PointerEvent) => {
      if (!held || held.id !== event.pointerId) return;
      if (held.active) {
        if (event.clientY < held.y - 64) cancel();
        if (event.cancelable) event.preventDefault();
      } else if (Math.hypot(event.clientX - held.x, event.clientY - held.y) > 12) cancel();
    };
    const up = (event: PointerEvent) => {
      if (!held || held.id !== event.pointerId) return;
      clear(); const previous = held; held = null;
      if (previous.active) {
        suppressUntil = performance.now() + 500;
        if (event.cancelable) event.preventDefault();
        latest.current.finish();
      }
    };
    const context = (event: Event) => { if (held?.active || performance.now() < suppressUntil) event.preventDefault(); };
    const click = (event: Event) => { if (performance.now() < suppressUntil) { event.preventDefault(); event.stopImmediatePropagation(); } };
    const visibility = () => { if (document.visibilityState === "hidden") cancel(); };
    surface.addEventListener("pointerdown", down, true);
    surface.addEventListener("contextmenu", context, true);
    surface.addEventListener("click", click, true);
    window.addEventListener("pointermove", move, { capture: true, passive: false });
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancel(); surface.removeEventListener("pointerdown", down, true);
      surface.removeEventListener("contextmenu", context, true); surface.removeEventListener("click", click, true);
      window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true); window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [action]);
}
