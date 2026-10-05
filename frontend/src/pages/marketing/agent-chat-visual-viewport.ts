export function agentChatPageMinHeightClass(usesEmbeddedViewport: boolean): string {
  // A full layout-viewport minimum would override the smaller visual viewport
  // when the keyboard opens; both choices must live in Tailwind's utility layer.
  return usesEmbeddedViewport ? "min-h-0" : "min-h-dvh";
}

export function bindChatVisualViewportHeight(element: HTMLElement): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  const update = () => {
    // Pinch zoom clips the existing layout; it is not a software-keyboard resize.
    if ((viewport.scale ?? 1) !== 1) {
      element.style.removeProperty("--lv-agent-chat-viewport-height");
      return;
    }

    // The embedded page owns a fixed root allocation. Compare page positions,
    // not offsetTop: Safari can reveal a Shadow DOM editor by moving the page
    // before visualViewport.pageTop catches up, or pan without changing scrollY.
    const pageTop = element.getBoundingClientRect().top - document.body.getBoundingClientRect().top;
    const rootHeight = document.documentElement.getBoundingClientRect().height || window.innerHeight;
    const visiblePageBottom = Math.max(viewport.pageTop, window.scrollY) + viewport.height;
    // On keyboard close, a stale pageTop/scrollY must not grow the fixed page
    // beyond its allocated layout viewport. Do not cache a pre-rotation height.
    const pageBottom = Math.min(rootHeight, visiblePageBottom);
    element.style.setProperty(
      "--lv-agent-chat-viewport-height",
      `${Math.max(0, Math.round(pageBottom - pageTop))}px`,
    );
  };

  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    window.removeEventListener("scroll", update);
    window.removeEventListener("resize", update);
    element.style.removeProperty("--lv-agent-chat-viewport-height");
  };
}
