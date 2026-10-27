import { createEdgeGestureBridge, EDGE_GESTURE_GUTTER } from "./edge-gesture-bridge";

/** iOS reserves screen edges for native history traversal even when the
 * document already disables overscroll. Cancel the starting contact before
 * WebKit admits that recognizer; waiting for touchmove is too late.
 */
export function bindPwaEdgeNavigation(document: Document): () => void {
  const view = document.defaultView;
  // Apple's standalone flag identifies Home Screen apps, including iPadOS.
  // Ordinary Safari tabs, embedded views and desktop windows retain native input.
  if (!view || (view.navigator as Navigator & { standalone?: boolean }).standalone !== true
    || view.top !== view) return () => {};

  const bridge = createEdgeGestureBridge();
  const start = (event: TouchEvent) => {
    if (!event.cancelable || event.touches.length !== 1 || event.changedTouches.length !== 1) return;
    const x = event.touches[0]!.clientX;
    // Reserve and hand off the same gutter consumed by shared application input.
    // The original event continues to the existing gesture owner, without replay.
    const width = document.documentElement.clientWidth || view.innerWidth;
    if (!Number.isFinite(width) || width <= 0) return;
    if (x < 0 || x > width) return;
    const edge = x < EDGE_GESTURE_GUTTER ? "left" : x >= width - EDGE_GESTURE_GUTTER ? "right" : undefined;
    if (!edge) return;
    event.preventDefault();
    if (event.defaultPrevented) bridge.handoff(event, edge);
  };
  // Window capture precedes document consumers even after an adapter rebind.
  view.addEventListener("touchstart", start, { capture: true, passive: false });
  return () => {
    bridge.dispose();
    view.removeEventListener("touchstart", start, { capture: true });
  };
}
