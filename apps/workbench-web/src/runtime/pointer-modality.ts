/** Document-level pointer origin for transient hover and restored focus. */
export function bindTouchInteractionMode(document: Document): () => void {
  const root = document.documentElement;
  const onPointerDown = (event: PointerEvent) => {
    // Menus/dialogs restore real focus. Native :focus-visible may retain the
    // preceding Escape/typing heuristic, even after a new pointer interaction.
    root.dataset.pointerFocus = "true";
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
    // Escape only dismisses the current surface; it does not turn a mouse-
    // opened menu into a keyboard navigation session. Text entry likewise
    // retains the current mode. Moving the mouse alone must not hide Tab focus.
    const editing = (event.target as Element | null)?.closest?.('input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
    if (event.key === "Tab" || (!editing && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Enter", " "].includes(event.key))) {
      delete root.dataset.pointerFocus;
    }
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("keydown", onKeyDown, true);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("keydown", onKeyDown, true);
    delete root.dataset.touchInteraction;
    delete root.dataset.pointerFocus;
  };
}
