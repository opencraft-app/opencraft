/** Hover capability is not the same as the pointer that last touched the UI. */
export function bindTouchInteractionMode(document: Document): () => void {
  const root = document.documentElement;
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch" || event.pointerType === "pen") {
      root.dataset.touchInteraction = "true";
    }
  };
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "mouse") delete root.dataset.touchInteraction;
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    delete root.dataset.touchInteraction;
  };
}
