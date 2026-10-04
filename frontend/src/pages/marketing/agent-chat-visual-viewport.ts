export function bindChatVisualViewportHeight(element: HTMLElement): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  const update = () => {
    // iOS may pan the visual viewport when the keyboard opens without resizing 100dvh.
    element.style.setProperty(
      "--lv-agent-chat-viewport-height",
      `${Math.round(viewport.height + viewport.offsetTop)}px`,
    );
  };

  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    element.style.removeProperty("--lv-agent-chat-viewport-height");
  };
}
