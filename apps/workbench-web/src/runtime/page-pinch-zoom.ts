/** Reserve document pinch for content viewports instead of native page zoom.
 * Keep propagation intact: image/diagram/browser surfaces still own their input.
 */
export function preventPagePinchZoom(document: Document): () => void {
  const prevent = (event: Event) => { if (event.cancelable) event.preventDefault(); };
  const wheel = (event: WheelEvent) => { if (event.ctrlKey) prevent(event); };
  const options = { capture: true, passive: false };
  document.addEventListener("wheel", wheel, options);
  document.addEventListener("gesturestart", prevent, options);
  document.addEventListener("gesturechange", prevent, options);
  return () => {
    document.removeEventListener("wheel", wheel, true);
    document.removeEventListener("gesturestart", prevent, true);
    document.removeEventListener("gesturechange", prevent, true);
  };
}
