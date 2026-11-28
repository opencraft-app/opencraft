import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** Reveal one page when scrolling reaches the end, without owning pagination.
 * Scroll movement, rather than visibility, avoids draining short lists on mount/resize.
 * Passive listeners leave native vertical scrolling and horizontal Shell gestures intact.
 */
export function useSidebarEndPull(footerRef: RefObject<HTMLDivElement | null>, enabled: boolean, reveal: () => void) {
  const action = useRef({ enabled, reveal });
  useLayoutEffect(() => { action.current = { enabled, reveal }; });
  useEffect(() => {
    const footer = footerRef.current;
    const panel = footer?.closest<HTMLElement>(".sidebar-panel");
    if (!footer || !panel) return;
    const doc = panel.ownerDocument;
    let touch: { x: number; y: number } | null = null;
    let touchDragged = false;
    let downward = false;
    let consumed = false;
    let pointerScrolling = false;
    let wheelIntentUntil = 0;
    let keyIntentUntil = 0;
    let pointerIntentUntil = 0;
    let touchMomentumUntil = 0;
    const now = () => panel.ownerDocument.defaultView?.performance.now() ?? Date.now();
    const clearScrollIntent = () => {
      pointerScrolling = false;
      wheelIntentUntil = 0;
      keyIntentUntil = 0;
      pointerIntentUntil = 0;
      touchMomentumUntil = 0;
    };
    const hasScrollIntent = () => {
      const current = now();
      return touchDragged || pointerScrolling
        || current <= wheelIntentUntil
        || current <= keyIntentUntil
        || current <= pointerIntentUntil
        || current <= touchMomentumUntil;
    };
    // Shell reparents this retained Sidebar between dock and drawer.
    const viewport = () => {
      const column = panel.closest(".shell-sidebar__column");
      return column?.getAttribute("data-navigation-layout") === "mobile"
        ? column.querySelector<HTMLElement>(".shell-sidebar__scroll")
        : panel.querySelector<HTMLElement>(column ? ".sidebar-activity-list" : ".sidebar-content-scroll");
    };
    let lastViewport = viewport();
    let lastScrollTop = lastViewport?.scrollTop ?? 0;
    const atEnd = () => {
      const root = viewport();
      if (!root || !root.clientHeight || footer.closest('[inert], [aria-hidden="true"]')) return false;
      const bounds = root.getBoundingClientRect();
      const end = footer.getBoundingClientRect();
      return end.height > 0 && end.top < bounds.bottom && end.bottom > bounds.top
        && root.scrollHeight - root.scrollTop - root.clientHeight <= 2;
    };
    const tryReveal = () => {
      if (!downward || consumed || !action.current.enabled || !atEnd()) return;
      consumed = true;
      downward = false;
      clearScrollIntent();
      action.current.reveal();
    };
    const scroll = (event: Event) => {
      const root = viewport();
      if (!root || event.target !== root) return;
      const previous = root === lastViewport ? lastScrollTop : 0;
      lastViewport = root;
      lastScrollTop = root.scrollTop;
      if (root.scrollTop <= 0 || root.scrollTop < previous) {
        if (!atEnd()) consumed = false;
        return;
      }
      if (!touch && !atEnd()) consumed = false;
      if (!hasScrollIntent()) return;
      // Scrollbar drags, keyboard navigation, wheel and touch momentum arrive here.
      // A held touch still consumes at most one page, including its final scroll.
      downward = true;
      tryReveal();
    };
    const withinList = (event: Event) => event.target instanceof Node
      && (event.target === viewport() || panel.querySelector(".sidebar-activity-list")?.contains(event.target));
    const interactiveTarget = (event: Event) => event.target instanceof Element
      && Boolean(event.target.closest('button, a, input, textarea, select, [role="button"], [role="radio"], [contenteditable]'));
    const wheel = (event: WheelEvent) => {
      if (!withinList(event)) return;
      downward = event.deltaY > 0 && Math.abs(event.deltaY) > Math.abs(event.deltaX);
      wheelIntentUntil = downward ? now() + 250 : 0;
      // New rows move the end away. Continued scrolling can then arm the next page.
      if (!atEnd()) consumed = false;
      tryReveal();
    };
    const pointerDown = (event: PointerEvent) => {
      const root = viewport();
      if (root && event.target === root) {
        pointerScrolling = true;
        pointerIntentUntil = now() + 250;
        if (!atEnd()) consumed = false;
      } else {
        clearScrollIntent();
      }
    };
    const pointerMove = (event: PointerEvent) => {
      if (pointerScrolling && event.buttons === 0) pointerScrolling = false;
    };
    const pointerEnd = () => {
      if (!pointerScrolling) return;
      pointerScrolling = false;
      pointerIntentUntil = now() + 100;
    };
    const click = () => {
      clearScrollIntent();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (!withinList(event)) return;
      if (event.key === "ArrowDown" || event.key === "PageDown" || event.key === "End"
        || (event.key === " " && !interactiveTarget(event))) {
        keyIntentUntil = now() + 250;
        if (!atEnd()) consumed = false;
      } else {
        clearScrollIntent();
      }
    };
    const start = (event: TouchEvent) => {
      clearScrollIntent();
      const point = event.touches.length === 1 && withinList(event) ? event.touches[0] : null;
      touch = point ? { x: point.clientX, y: point.clientY } : null;
      touchDragged = false;
      downward = false;
      consumed = false;
    };
    const move = (event: TouchEvent) => {
      if (!touch || event.touches.length !== 1) { downward = false; return; }
      const point = event.touches[0]!;
      const dy = touch.y - point.clientY;
      downward = dy > 8 && dy > Math.abs(touch.x - point.clientX);
      if (downward) touchDragged = true;
      tryReveal();
    };
    const end = (event: TouchEvent) => {
      const momentum = event.type === "touchend" && touchDragged && !consumed;
      touch = null;
      touchDragged = false;
      downward = false;
      touchMomentumUntil = momentum ? now() + 500 : 0;
    };
    doc.addEventListener("scroll", scroll, { capture: true, passive: true });
    doc.addEventListener("wheel", wheel, { capture: true, passive: true });
    doc.addEventListener("pointerdown", pointerDown, { capture: true, passive: true });
    doc.addEventListener("pointermove", pointerMove, { capture: true, passive: true });
    doc.addEventListener("pointerup", pointerEnd, { capture: true, passive: true });
    doc.addEventListener("pointercancel", clearScrollIntent, { capture: true, passive: true });
    doc.addEventListener("click", click, { capture: true, passive: true });
    doc.addEventListener("keydown", keyDown, { capture: true, passive: true });
    doc.addEventListener("touchstart", start, { capture: true, passive: true });
    doc.addEventListener("touchmove", move, { capture: true, passive: true });
    doc.addEventListener("touchend", end, { capture: true, passive: true });
    doc.addEventListener("touchcancel", end, { capture: true, passive: true });
    return () => {
      doc.removeEventListener("scroll", scroll, true);
      doc.removeEventListener("wheel", wheel, true);
      doc.removeEventListener("pointerdown", pointerDown, true);
      doc.removeEventListener("pointermove", pointerMove, true);
      doc.removeEventListener("pointerup", pointerEnd, true);
      doc.removeEventListener("pointercancel", clearScrollIntent, true);
      doc.removeEventListener("click", click, true);
      doc.removeEventListener("keydown", keyDown, true);
      doc.removeEventListener("touchstart", start, true);
      doc.removeEventListener("touchmove", move, true);
      doc.removeEventListener("touchend", end, true);
      doc.removeEventListener("touchcancel", end, true);
    };
  }, [footerRef]);
}
