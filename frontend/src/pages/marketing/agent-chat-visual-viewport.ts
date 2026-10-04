export function bindChatVisualViewportHeight(element: HTMLElement): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  const update = () => {
    // Compare positions within the same page: iOS can pan the visual viewport
    // without changing window.scrollY when it reveals the focused editor.
    const pageTop = element.getBoundingClientRect().top - document.body.getBoundingClientRect().top;
    element.style.setProperty(
      "--lv-agent-chat-viewport-height",
      `${Math.max(0, Math.round(viewport.pageTop + viewport.height - pageTop))}px`,
    );
  };

  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  window.addEventListener("scroll", update, { passive: true });
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    window.removeEventListener("scroll", update);
    element.style.removeProperty("--lv-agent-chat-viewport-height");
  };
}
