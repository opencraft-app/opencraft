import type { Point } from "./input-policy";

export interface DesktopTrackpadPort {
  allowed(): boolean;
  begin(): void;
  move(delta: Point): void;
  press(mask: number): void;
  release(): void;
  scroll(delta: Point): void;
}

/** Relative touch gestures share the media adapter's pointer writer and grant.
 * A stationary 300ms hold or double-tap movement starts a left drag.
 * Reset quarantines held contacts until they all lift. */
export function bindDesktopTrackpad(element: HTMLElement, port: DesktopTrackpadPort) {
  const window = element.ownerDocument.defaultView!;
  const fingers = new Map<number, Point>();
  let start: Point | null = null, last: Point | null = null;
  let pairStart: Point | null = null, pairLast: Point | null = null;
  let moved = false, paired = false, blocked = false, dragging = false, dragPending = false;
  let beganAt = 0, lastTap = -Infinity, frame: number | null = null;
  let hold: number | null = null;
  let bounds: number[] = [];
  const geometry = () => { const r = element.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
  const point = (e: PointerEvent): Point => ({ x: e.clientX, y: e.clientY });
  const center = (): Point => {
    const [a, b] = [...fingers.values()] as [Point, Point]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const cancelFrame = () => { if (frame !== null) window.cancelAnimationFrame(frame); frame = null; };
  const cancelHold = () => { if (hold !== null) window.clearTimeout(hold); hold = null; };
  const pressDrag = () => {
    // Focus/composition handoff may synchronously reset this gesture.
    dragging = true; element.dataset.pressed = "true"; port.press(1);
  };
  const reset = () => {
    cancelHold(); cancelFrame(); port.release(); dragging = dragPending = false; blocked = fingers.size > 0;
    start = last = pairStart = pairLast = null; paired = moved = false; lastTap = -Infinity;
    element.dataset.pressed = "false";
  };
  const valid = () => {
    if (!port.allowed() || bounds.some((n, i) => Math.abs(n - geometry()[i]!) > .01)) { reset(); return false; }
    return !blocked;
  };
  const sample = () => {
    frame = null;
    if (!valid() || fingers.size !== 2 || !pairStart || !pairLast) return;
    const current = center();
    if (Math.hypot(current.x - pairStart.x, current.y - pairStart.y) >= 8) moved = true;
    if (moved) port.scroll({ x: pairLast.x - current.x, y: pairLast.y - current.y });
    pairLast = current;
  };
  const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    stop(event);
    fingers.set(event.pointerId, point(event));
    try { element.setPointerCapture(event.pointerId); } catch { /* Detached pointer. */ }
    if (blocked || !port.allowed()) { blocked = true; return; }
    if (fingers.size === 1) {
      port.begin(); bounds = geometry(); start = last = point(event); beganAt = performance.now();
      moved = paired = false;
      dragPending = beganAt - lastTap < 320; dragging = false;
      lastTap = -Infinity;
      const pending = window.setTimeout(() => {
        if (hold !== pending) return;
        hold = null;
        if (valid() && fingers.size === 1 && !paired && !moved) pressDrag();
      }, 300);
      hold = pending;
    } else if (fingers.size === 2) {
      cancelHold();
      if (dragging) { reset(); return; }
      port.release(); dragging = dragPending = false; element.dataset.pressed = "false";
      paired = true; moved = false; pairStart = pairLast = center();
    } else reset();
  };
  const move = (event: PointerEvent) => {
    if (!fingers.has(event.pointerId)) return;
    stop(event); fingers.set(event.pointerId, point(event));
    if (!valid()) return;
    if (fingers.size === 2) {
      if (frame === null) frame = window.requestAnimationFrame(sample);
    } else if (fingers.size === 1 && !paired && start && last) {
      const next = point(event);
      if (Math.hypot(next.x - start.x, next.y - start.y) >= 8) { moved = true; cancelHold(); }
      // A possible second tap does not press until it actually moves. A
      // second finger can still turn it into a right-click without a stray left.
      if (moved && dragPending && !dragging) {
        pressDrag();
      }
      if (last) { port.move({ x: next.x - last.x, y: next.y - last.y }); last = next; }
    }
  };
  const end = (event: PointerEvent) => {
    if (!fingers.has(event.pointerId)) return;
    stop(event); cancelHold();
    const eligible = valid() && event.type === "pointerup";
    if (eligible && fingers.size === 2) { cancelFrame(); sample(); }
    if (eligible && !moved && performance.now() - beganAt < 500) {
      if (paired && fingers.size === 2) { port.press(4); port.release(); }
      else if (!paired && !dragging) { port.press(1); port.release(); lastTap = performance.now(); }
    }
    port.release(); dragging = dragPending = false; element.dataset.pressed = "false";
    fingers.delete(event.pointerId); cancelFrame();
    // A pair's last finger cannot become a click or pointer movement.
    if (!fingers.size) { blocked = paired = false; start = last = pairStart = pairLast = null; }
    else if (!eligible) blocked = true;
  };
  const listeners: [string, EventListener][] = [["pointerdown", down as EventListener], ["pointermove", move as EventListener],
    ["pointerup", end as EventListener], ["pointercancel", end as EventListener], ["lostpointercapture", end as EventListener]];
  for (const name of ["touchstart", "touchmove", "touchend", "touchcancel", "click", "contextmenu"]) listeners.push([name, stop]);
  for (const [name, listener] of listeners) element.addEventListener(name, listener, { passive: false });
  return { reset, dispose() { reset(); for (const [name, listener] of listeners) element.removeEventListener(name, listener); fingers.clear(); } };
}
