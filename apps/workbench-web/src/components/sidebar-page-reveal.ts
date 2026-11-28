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
  let downward = false;
  let consumed = false;
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
      root.scrollHeight > root.clientHeight ||
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
    // A date heading or expanded descendants can make a row taller. Use the
    // last block as an estimate and remeasure once the added rows have laid out.
    const blockHeight = lastBlock.getBoundingClientRect().height + gap;
    fill(Math.max(1, Math.floor(free / Math.max(rowHeight, blockHeight))));
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
    reveal();
  };
  const scroll = (event: Event) => {
    const root = viewport();
    if (!root || event.target !== root) return;
    const previous = root === lastViewport ? lastScrollTop : 0;
    lastViewport = root;
    lastScrollTop = root.scrollTop;
    if (root.scrollTop <= 0 || root.scrollTop < previous) return;
    // Scrollbar drags, keyboard navigation and touch momentum all arrive here.
    // A held touch still consumes at most one page, including its final scroll.
    if (!touch) consumed = false;
    downward = true;
    tryReveal();
  };
  const withinList = (event: Event) =>
    event.target instanceof Node &&
    (event.target === viewport() || panel.querySelector(".sidebar-activity-list")?.contains(event.target));
  const wheel = (event: WheelEvent) => {
    if (!withinList(event)) return;
    downward = event.deltaY > 0 && Math.abs(event.deltaY) > Math.abs(event.deltaX);
    // New rows move the end away. Continued scrolling can then arm the next page.
    if (!atEnd()) consumed = false;
    tryReveal();
  };
  const start = (event: TouchEvent) => {
    const point = event.touches.length === 1 && withinList(event) ? event.touches[0] : null;
    touch = point ? { x: point.clientX, y: point.clientY } : null;
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
    tryReveal();
  };
  const end = () => {
    touch = null;
    downward = false;
  };
  doc.addEventListener("scroll", scroll, { capture: true, passive: true });
  doc.addEventListener("wheel", wheel, { capture: true, passive: true });
  doc.addEventListener("touchstart", start, { capture: true, passive: true });
  doc.addEventListener("touchmove", move, { capture: true, passive: true });
  doc.addEventListener("touchend", end, { capture: true, passive: true });
  doc.addEventListener("touchcancel", end, { capture: true, passive: true });
  return () => {
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    doc.removeEventListener("scroll", scroll, true);
    doc.removeEventListener("wheel", wheel, true);
    doc.removeEventListener("touchstart", start, true);
    doc.removeEventListener("touchmove", move, true);
    doc.removeEventListener("touchend", end, true);
    doc.removeEventListener("touchcancel", end, true);
  };
}
