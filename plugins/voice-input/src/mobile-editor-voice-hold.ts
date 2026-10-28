import { useEffect, useRef, type RefObject } from "react";
import { useTouchContactScope } from "@opencraft/design-system-web/touch-contact";

/** A trusted action owns voice; the editor's native contact owns its hold. */
export function useMobileEditorVoiceHold(action: RefObject<HTMLButtonElement | null>, callbacks: {
  enabled: boolean; start(): void; finish(): void; cancel(): void;
}) {
  const latest = useRef(callbacks); latest.current = callbacks;
  const scope = useTouchContactScope();
  useEffect(() => {
    const surface = action.current?.closest<HTMLElement>(".opencraft-composer-stack");
    if (!surface) return;
    let held: { id: number; x: number; y: number; active: boolean; editor: HTMLElement } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let suppressUntil = 0;
    const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    const cancel = () => {
      clear(); const previous = held; held = null;
      if (previous) scope?.cancel(previous.id);
      if (previous?.active) { suppressUntil = performance.now() + 500; latest.current.cancel(); }
    };
    const down = (event: TouchEvent) => {
      if (held) { cancel(); return; }
      suppressUntil = 0;
      if (event.touches.length !== 1 || !latest.current.enabled
        || (document.documentElement.dataset.uiDensity === "compact"
          || (document.documentElement.dataset.uiDensity !== "touch" && !matchMedia("(any-pointer: coarse)").matches))
        || window.getSelection()?.toString()) return;
      const editor = event.target instanceof Element ? event.target.closest<HTMLElement>(".opencraft-composer-editor") : null;
      if (!editor || !surface.contains(editor)) return;
      // The first contact establishes editor focus. A voice hold starts only
      // from an already focused editor, so tapping an empty input cannot be
      // promoted to recording while Safari is opening the keyboard.
      if (editor.ownerDocument.activeElement !== editor) return;
      const touch = event.touches[0]!;
      if (scope !== null && !scope.claim(touch.identifier, "editor")) return;
      held = { id: touch.identifier, x: touch.clientX, y: touch.clientY, active: false, editor };
      timer = setTimeout(() => {
        timer = null;
        if (!held || !latest.current.enabled || window.getSelection()?.toString()) { cancel(); return; }
        held.active = true;
        editor.blur();
        latest.current.start();
      }, 450);
    };
    const move = (event: TouchEvent) => {
      if (!held) return;
      const touch = Array.from(event.touches).find(touch => touch.identifier === held!.id);
      if (!touch || event.touches.length !== 1) { cancel(); return; }
      if (held.active) {
        if (touch.clientY < held.y - 64) cancel();
        if (event.cancelable) event.preventDefault();
      } else if (Math.hypot(touch.clientX - held.x, touch.clientY - held.y) > 12) cancel();
    };
    const up = (event: TouchEvent) => {
      if (!held || !Array.from(event.changedTouches).some(touch => touch.identifier === held!.id)) return;
      clear(); const previous = held; held = null;
      scope?.release(previous.id);
      if (previous.active) {
        suppressUntil = performance.now() + 500;
        if (event.cancelable) event.preventDefault();
        latest.current.finish();
      }
    };
    const context = (event: Event) => { if (held?.active || performance.now() < suppressUntil) event.preventDefault(); };
    const click = (event: Event) => { if (performance.now() < suppressUntil) { event.preventDefault(); event.stopImmediatePropagation(); } };
    const anotherContact = (event: TouchEvent) => { if (held && event.touches.length !== 1) cancel(); };
    const visibility = () => { if (document.visibilityState === "hidden") cancel(); };
    const focus = () => { if (held?.active !== true) cancel(); };
    surface.addEventListener("touchstart", down, { capture: true, passive: true });
    surface.addEventListener("contextmenu", context, true);
    surface.addEventListener("click", click, true);
    // Native touchend/cancel retires the contact independently of the derived
    // pointer release, including across focus and presentation changes.
    window.addEventListener("touchstart", anotherContact, { capture: true, passive: true });
    window.addEventListener("touchmove", move, { capture: true, passive: false });
    window.addEventListener("touchend", up, { capture: true, passive: false });
    window.addEventListener("touchcancel", cancel, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    surface.addEventListener("focusin", focus, true);
    return () => {
      cancel(); surface.removeEventListener("touchstart", down, true);
      surface.removeEventListener("contextmenu", context, true); surface.removeEventListener("click", click, true);
      window.removeEventListener("touchstart", anotherContact, true);
      window.removeEventListener("touchmove", move, true); window.removeEventListener("touchend", up, true);
      window.removeEventListener("touchcancel", cancel, true); window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility); surface.removeEventListener("focusin", focus, true);
    };
  }, [action]);
}
