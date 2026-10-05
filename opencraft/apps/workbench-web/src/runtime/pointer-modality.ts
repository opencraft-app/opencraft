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
  const onKeyDown = (event: KeyboardEvent) => {
    // A hardware Tab transfers focus ownership back to keyboard navigation.
    // Ordinary text entry from an on-screen keyboard must not restore rings.
    if (event.key === "Tab") delete root.dataset.touchInteraction;
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("keydown", onKeyDown, true);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("keydown", onKeyDown, true);
    delete root.dataset.touchInteraction;
  };
}
