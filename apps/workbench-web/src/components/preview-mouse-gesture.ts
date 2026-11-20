import type { RefObject } from "react";

/** Preview-only mouse contacts feed the Shell's existing gesture owner. */
export function bindPreviewMouseGesture({root, gesture, start, move, end, cancel}: {
  root: RefObject<HTMLElement | null>;
  gesture: {current: {owner: string} | null};
  start(event: PointerEvent): void;
  move(event: PointerEvent): void;
  end(event: PointerEvent): void;
  cancel(immediate?: boolean): void;
}) {
  let pointer: number | null = null;
  let capture: HTMLElement | null = null;
  const release = () => {
    const element = capture, id = pointer;
    capture = null; pointer = null;
    if (element && id !== null && element.hasPointerCapture(id)) element.releasePointerCapture(id);
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    start(event);
    if (gesture.current) pointer = event.pointerId;
  };
  const preventSelection = (event: MouseEvent) => {
    if (pointer !== null && gesture.current) event.preventDefault();
  };
  const drag = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    if (event.buttons !== 1) { cancel(); release(); return; }
    move(event);
    if (!gesture.current) { release(); return; }
    if (gesture.current.owner !== "pending" && !capture && root.current) {
      capture = root.current;
      capture.setPointerCapture(event.pointerId);
    }
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    end(event); release();
  };
  const interrupt = (event: Event) => {
    if (event instanceof PointerEvent && event.pointerId !== pointer) return;
    if (pointer !== null) { cancel(true); release(); }
  };
  document.addEventListener("pointerdown", down, true);
  document.addEventListener("mousedown", preventSelection, true);
  document.addEventListener("pointermove", drag, true);
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", interrupt, true);
  document.addEventListener("lostpointercapture", interrupt, true);
  window.addEventListener("blur", interrupt);
  return () => {
    document.removeEventListener("pointerdown", down, true);
    document.removeEventListener("mousedown", preventSelection, true);
    document.removeEventListener("pointermove", drag, true);
    document.removeEventListener("pointerup", up, true);
    document.removeEventListener("pointercancel", interrupt, true);
    document.removeEventListener("lostpointercapture", interrupt, true);
    window.removeEventListener("blur", interrupt);
    release();
  };
}
