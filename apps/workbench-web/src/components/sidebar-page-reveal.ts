import { flushSync } from "react-dom";

interface SidebarPageAction {
  enabled: boolean;
  reveal: () => void;
  fill?: (additional: number) => void;
}

/** The retained sidebar uses its active scrollport for both fitting and paging. */
export function attachSidebarPageReveal(footer: HTMLDivElement, action: () => SidebarPageAction) {
  const panel = footer.closest<HTMLElement>(".sidebar-panel");
  const items = footer.parentElement;
  if (!panel || !items) return;
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
    return (
      touchDragged ||
      pointerScrolling ||
      current <= wheelIntentUntil ||
      current <= keyIntentUntil ||
      current <= pointerIntentUntil ||
      current <= touchMomentumUntil
    );
  };
  // Shell reparents this retained Sidebar between dock and drawer.
  const viewport = () => {
    const column = panel.closest(".shell-sidebar__column");
    return column?.getAttribute("data-navigation-layout") === "mobile"
      ? column.querySelector<HTMLElement>(".shell-sidebar__scroll")
      : panel.querySelector<HTMLElement>(column ? ".sidebar-activity-list" : ".sidebar-content-scroll");
  };
  // Measure the normal-flow tail, including any feedback below Recent. On
  // mobile the scrollport also reserves padding for the floating controls.
  let observedViewport: HTMLElement | null = null;
  let frame: number | null = null;
  let rejected: { root: HTMLElement; lastBlock: Element; width: number; free: number } | undefined;
  const measure = () => {
    frame = null;
    const root = viewport();
    if (root !== observedViewport) {
      if (observedViewport) observer.unobserve(observedViewport);
      if (root) observer.observe(root);
      observedViewport = root;
    }
    const { fill } = action();
    if (
      !fill ||
      !root?.clientHeight ||
      !root.clientWidth ||
      root.scrollTop !== 0 ||
      root.scrollHeight > root.clientHeight + 1 ||
      !footer.offsetHeight ||
      footer.closest('[inert], [aria-hidden="true"]')
    )
      return;
    const lastBlock = footer.previousElementSibling;
    const lastRow = lastBlock?.querySelector(".sidebar-activity-item");
    if (!lastBlock || !lastRow) return;
    const padding = Number.parseFloat(getComputedStyle(root).paddingBottom) || 0;
    const bottom = root.getBoundingClientRect().top + root.clientTop + root.clientHeight - padding;
    const contentBottom = root.contains(panel)
      ? panel.getBoundingClientRect().bottom
      : Math.max(...Array.from(root.children, (child) => child.getBoundingClientRect().bottom));
    const free = bottom - Math.max(contentBottom, footer.getBoundingClientRect().bottom);
    const gap = Number.parseFloat(getComputedStyle(items).rowGap) || 0;
    const rowHeight = lastRow.getBoundingClientRect().height + gap;
    if (rowHeight <= 0 || free < rowHeight) return;
    const width = root.clientWidth;
    if (
      rejected?.root === root &&
      rejected.lastBlock === lastBlock &&
      rejected.width === width &&
      free <= rejected.free
    )
      return;

    // Block heights vary with dates and descendants. Probe the estimated count,
    // then find the largest fitting prefix before the browser paints. A later
    // resize starts from the committed page and never removes those rows.
    const guess = Math.max(1, Math.floor(free / Math.max(rowHeight, lastBlock.getBoundingClientRect().height + gap)));
    let applied = 0;
    const tryFit = (additional: number) => {
      flushSync(() => fill(additional));
      applied = additional;
      return root.scrollHeight <= root.clientHeight + 1;
    };
    if (tryFit(guess)) return;
    let low = 0;
    let high = guess;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (tryFit(mid)) low = mid;
      else high = mid;
    }
    if (applied !== low) tryFit(low);
    if (low === 0) rejected = { root, lastBlock, width, free };
  };
  // A reveal changes the measured boxes; schedule it outside observer delivery.
  const observer = new ResizeObserver(() => {
    frame ??= requestAnimationFrame(measure);
  });
  observer.observe(items);
  observer.observe(panel);
  let lastViewport = viewport();
  let lastScrollTop = lastViewport?.scrollTop ?? 0;
  const atEnd = () => {
    const root = viewport();
    if (!root || !root.clientHeight || footer.closest('[inert], [aria-hidden="true"]')) return false;
    const bounds = root.getBoundingClientRect();
    const end = footer.getBoundingClientRect();
    return (
      end.height > 0 &&
      end.top < bounds.bottom &&
      end.bottom > bounds.top &&
      root.scrollHeight - root.scrollTop - root.clientHeight <= 2
    );
  };
  const tryReveal = () => {
    const { enabled, reveal } = action();
    if (!downward || consumed || !enabled || !atEnd()) return;
    consumed = true;
    downward = false;
    clearScrollIntent();
    reveal();
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
  const withinList = (event: Event) =>
    event.target instanceof Node &&
    (event.target === viewport() || panel.querySelector(".sidebar-activity-list")?.contains(event.target));
  const interactiveTarget = (event: Event) =>
    event.target instanceof Element &&
    Boolean(event.target.closest('button, a, input, textarea, select, [role="button"], [role="radio"], [contenteditable]'));
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
    if (
      event.key === "ArrowDown" ||
      event.key === "PageDown" ||
      event.key === "End" ||
      (event.key === " " && !interactiveTarget(event))
    ) {
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
    if (!touch || event.touches.length !== 1) {
      downward = false;
      return;
    }
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
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
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
}
