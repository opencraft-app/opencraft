import { touchPanAxis } from "@opencraft/design-system-web/touch-contact";
import type { Terminal } from "@xterm/xterm";
import { hasTerminalNativeSelection } from "./selection";

/** Adapt touch reading to xterm's wheel owner (including its TUI protocols).
 * Shell sees the contact first and owns horizontal navigation; this adapter
 * only claims vertical movement. Keep the original target leased across redraws.
 */
export function attachTerminalTouchScroll(terminal: Terminal, host: HTMLElement, active: () => boolean): () => void {
  let contact: {
    id: number;
    x: number;
    y: number;
    lastY: number;
    vertical: boolean;
    buffer: Terminal["buffer"]["active"];
    mouse: string;
  } | null = null;
  let releaseTarget = () => {};
  const cancel = () => {
    contact = null;
    releaseTarget();
  };
  const previousTouchAction = host.style.touchAction;
  host.style.touchAction = "none";
  const start = (event: TouchEvent) => {
    cancel();
    if (!active() || event.touches.length !== 1 || terminal.hasSelection() || hasTerminalNativeSelection(host)) return;
    const touch = event.touches[0]!;
    contact = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      lastY: touch.clientY,
      vertical: false,
      buffer: terminal.buffer.active,
      mouse: terminal.modes.mouseTrackingMode,
    };
    const target = event.composedPath()[0];
    if (target instanceof Element) {
      const forward = (event: Event) => {
        if (event.composedPath().includes(host)) return;
        if (event.type === "touchmove") move(event as TouchEvent);
        else cancel();
      };
      for (const type of ["touchmove", "touchend", "touchcancel"])
        target.addEventListener(type, forward, { capture: true, passive: false });
      releaseTarget = () => {
        for (const type of ["touchmove", "touchend", "touchcancel"]) target.removeEventListener(type, forward, true);
        releaseTarget = () => {};
      };
    }
    // Replace xterm's touch-only viewport path; taps and long presses still bubble.
    event.stopPropagation();
  };
  const move = (event: TouchEvent) => {
    // Native viewport touch scrolling must not become a second writer.
    event.stopPropagation();
    const current = contact;
    if (!current) return;
    const touch = Array.from(event.touches).find((touch) => touch.identifier === current.id);
    if (
      !active() ||
      event.touches.length !== 1 ||
      !touch ||
      terminal.hasSelection() ||
      hasTerminalNativeSelection(host) ||
      terminal.buffer.active !== current.buffer ||
      terminal.modes.mouseTrackingMode !== current.mouse ||
      host.closest('[inert],[aria-hidden="true"]')
    ) {
      cancel();
      return;
    }
    const dx = touch.clientX - current.x,
      dy = touch.clientY - current.y;
    if (!current.vertical) {
      const axis = touchPanAxis(dx, dy);
      if (axis === "pending") return;
      if (axis === "horizontal") {
        cancel();
        return;
      }
      current.vertical = true;
    }
    event.preventDefault();
    event.stopPropagation();
    const delta = current.lastY - touch.clientY;
    current.lastY = touch.clientY;
    // An empty normal buffer must never turn a swipe into shell arrow input.
    // Mouse reporting still belongs to the application, in either buffer.
    if (current.buffer.type === "normal" && current.buffer.baseY === 0 && current.mouse === "none") return;
    const screen = terminal.element?.querySelector(".xterm-screen");
    if (!screen || delta === 0) return;
    const rowHeight = screen.getBoundingClientRect().height / terminal.rows;
    if (!(rowHeight > 0)) return;
    // xterm reports one mouse wheel action per event. Bound each step to a row
    // so quick drags preserve their distance in mouse-tracking applications.
    const steps = Math.ceil(Math.abs(delta) / rowHeight);
    for (let step = 0; step < steps; step++) {
      screen.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          deltaY: delta / steps,
          clientX: touch.clientX,
          clientY: touch.clientY,
        }),
      );
    }
  };
  host.addEventListener("touchstart", start, { capture: true, passive: true });
  host.addEventListener("touchmove", move, { capture: true, passive: false });
  host.addEventListener("touchend", cancel, true);
  host.addEventListener("touchcancel", cancel, true);
  window.addEventListener("blur", cancel);
  window.addEventListener("pagehide", cancel);
  const visibilityChanged = () => {
    if (document.visibilityState !== "visible") cancel();
  };
  document.addEventListener("visibilitychange", visibilityChanged);
  return () => {
    cancel();
    host.style.touchAction = previousTouchAction;
    host.removeEventListener("touchstart", start, true);
    host.removeEventListener("touchmove", move, true);
    host.removeEventListener("touchend", cancel, true);
    host.removeEventListener("touchcancel", cancel, true);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("pagehide", cancel);
    document.removeEventListener("visibilitychange", visibilityChanged);
  };
}
