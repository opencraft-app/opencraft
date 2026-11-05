import { useLayoutEffect, type RefObject } from "react";

/** Project sticky-label overlap from the existing Sidebar scrollport. */
export function useSidebarHeadingOcclusion(listRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const doc = list.ownerDocument;
    let groups: { heading: HTMLElement; items: HTMLElement }[] = [];
    let observed = new Set<Element>();
    let frame: number | null = null;
    let disposed = false;
    const project = () => {
      if (disposed) return;
      // Finish geometry reads before changing any group's clipping style.
      const updates = groups.map(({ heading, items }) => {
        const rows = items.getBoundingClientRect();
        const overlap = Math.max(0, Math.min(rows.height, heading.getBoundingClientRect().bottom - rows.top));
        return { items, value: `${overlap}px` };
      });
      for (const { items, value } of updates) {
        if (items.style.getPropertyValue("--sidebar-heading-occlusion") !== value) {
          items.style.setProperty("--sidebar-heading-occlusion", value);
        }
      }
    };
    const schedule = () => {
      if (disposed || frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; project(); });
    };
    // Resize notifications already batch layout changes and run before paint.
    const resize = new ResizeObserver(project);
    const reconcile = () => {
      groups = [];
      const next = new Set<Element>([list]);
      for (const group of list.querySelectorAll<HTMLElement>(":scope > .sidebar-activity-group")) {
        const heading = group.querySelector<HTMLElement>(":scope > .sidebar-thread-group-heading");
        const items = group.querySelector<HTMLElement>(":scope > .sidebar-activity-group__items");
        if (!heading || !items) continue;
        groups.push({ heading, items }); next.add(heading); next.add(items);
      }
      for (const element of observed) if (!next.has(element)) resize.unobserve(element);
      for (const element of next) if (!observed.has(element)) resize.observe(element);
      observed = next;
      project();
    };
    const scroll = (event: Event) => {
      if (event.target === doc || event.target instanceof Node && event.target.contains(list)) schedule();
    };
    const mutation = new MutationObserver(records => {
      // Row text/badges do not replace the geometry owners. Their size changes
      // are already observed; keep those subscriptions across ordinary updates.
      if (records.some(record => record.target === list
        || record.target instanceof Element && record.target.parentElement === list
          && record.target.matches(".sidebar-activity-group"))) reconcile();
    });
    mutation.observe(list, { childList: true, subtree: true });
    doc.addEventListener("scroll", scroll, { capture: true, passive: true });
    reconcile();
    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      doc.removeEventListener("scroll", scroll, true);
      mutation.disconnect(); resize.disconnect();
      for (const { items } of groups) items.style.removeProperty("--sidebar-heading-occlusion");
    };
  }, [listRef]);
}
