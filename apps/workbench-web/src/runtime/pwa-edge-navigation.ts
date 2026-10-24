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

  const start = (event: TouchEvent) => {
    if (!event.cancelable || event.touches.length !== 1 || event.changedTouches.length !== 1) return;
    const x = event.touches[0]!.clientX;
    // Keep the interception inside the sidebar's reserved screen-edge gutter.
    // The rest of the viewport retains scrolling, selection and local gestures.
    const width = document.documentElement.clientWidth || view.innerWidth;
    if (!Number.isFinite(width) || width <= 0) return;
    if (x >= 0 && x <= width && (x < 20 || x >= width - 20)) event.preventDefault();
  };
  document.addEventListener("touchstart", start, { capture: true, passive: false });
  return () => document.removeEventListener("touchstart", start, { capture: true });
}
