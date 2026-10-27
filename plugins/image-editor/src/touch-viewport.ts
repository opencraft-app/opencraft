import { useEffect, useRef, useState, type PointerEvent } from "react";

type Point = { x: number; y: number };
type View = Point & { zoom: number };
const fitted: View = { zoom: 1, x: 0, y: 0 };
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

// Editing intent differs from a read-only gallery: one finger draws; two fingers
// manipulate only the viewport and discard the incomplete editing operation.
export function useTouchViewport(width: number, height: number, imageWidth: number, imageHeight: number, geometry: string, cancelEdit: () => void) {
  const [view, setView] = useState<View>(fitted);
  const current = useRef(view), pointers = useRef(new Map<number, Point>()), blocked = useRef(false);
  const origin = useRef<{ center: Point; distance: number; view: View } | null>(null);
  const update = (next: View) => {
    const limitX = Math.max(0, (imageWidth * next.zoom - width) / 2);
    const limitY = Math.max(0, (imageHeight * next.zoom - height) / 2);
    current.current = { ...next, x: Math.max(-limitX, Math.min(limitX, next.x)), y: Math.max(-limitY, Math.min(limitY, next.y)) };
    setView(current.current);
  };
  const reset = () => { current.current = fitted; setView(fitted); };
  // Crop and rotate change the document geometry; ordinary strokes preserve view.
  useEffect(reset, [geometry]);
  useEffect(() => { update(current.current); }, [width, height]);
  const rebase = () => {
    const [a, b] = [...pointers.current.values()];
    origin.current = a && b ? { center: midpoint(a, b), distance: Math.max(1, distance(a, b)), view: current.current } : null;
  };
  const position = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    if (blocked.current) { event.preventDefault(); event.stopPropagation(); }
    if (event.type === "pointercancel") cancelEdit();
    rebase();
    // Keep the remaining finger from starting a stroke after a pinch.
    if (!pointers.current.size) blocked.current = false;
  };
  return { view, reset, handlers: {
    onPointerDownCapture(event: PointerEvent<HTMLDivElement>) {
      if (event.pointerType !== "touch" || (event.target as Element).closest("textarea")) return;
      pointers.current.set(event.pointerId, position(event));
      if (pointers.current.size >= 2 || blocked.current) {
        blocked.current = true; cancelEdit(); rebase();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault(); event.stopPropagation();
      }
    },
    onPointerMoveCapture(event: PointerEvent<HTMLDivElement>) {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, position(event));
      if (!blocked.current) return;
      event.preventDefault(); event.stopPropagation();
      const [a, b] = [...pointers.current.values()], start = origin.current;
      if (!a || !b || !start) return;
      const center = midpoint(a, b), zoom = Math.max(1, Math.min(5, start.view.zoom * distance(a, b) / start.distance));
      const ratio = zoom / start.view.zoom;
      update({ zoom, x: center.x - (start.center.x - start.view.x) * ratio, y: center.y - (start.center.y - start.view.y) * ratio });
    },
    onPointerUpCapture: finish,
    onPointerCancelCapture: finish,
    onLostPointerCapture(event: PointerEvent<HTMLDivElement>) {
      // Unexpected capture loss cancels, while the ordinary pointerup already
      // removed its pointer and must not invalidate another active finger.
      if (pointers.current.delete(event.pointerId)) { cancelEdit(); rebase(); if (!pointers.current.size) blocked.current = false; }
    },
  } };
}
