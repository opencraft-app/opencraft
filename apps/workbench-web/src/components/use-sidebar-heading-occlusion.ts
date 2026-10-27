import { useLayoutEffect, type RefObject } from "react";

/** Sticky labels share the Sidebar plane. Their rows own occlusion, rather
 * than giving every label another opaque or backdrop-filtered material. */
export function useSidebarHeadingOcclusion(listRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const doc = list.ownerDocument;
    const project = () => {
      for (const group of list.querySelectorAll<HTMLElement>(":scope > .sidebar-activity-group")) {
        const heading = group.querySelector<HTMLElement>(":scope > .sidebar-thread-group-heading");
        const items = group.querySelector<HTMLElement>(":scope > .sidebar-activity-group__items");
        if (!heading || !items) continue;
        const rows = items.getBoundingClientRect();
        const overlap = Math.max(0, Math.min(rows.height, heading.getBoundingClientRect().bottom - rows.top));
        const value = `${overlap}px`;
        if (items.style.getPropertyValue("--sidebar-heading-occlusion") !== value) {
          items.style.setProperty("--sidebar-heading-occlusion", value);
        }
      }
    };
    const resize = new ResizeObserver(project);
    const observe = () => {
      resize.disconnect();
      resize.observe(list);
      for (const element of list.querySelectorAll(".sidebar-thread-group-heading, .sidebar-activity-group__items")) {
        resize.observe(element);
      }
      project();
    };
    // The existing viewport can change when Shell moves this same Sidebar
    // between dock and mobile portal. Observe its scroll without owning it.
    const scroll = (event: Event) => {
      if (event.target === doc || event.target instanceof Node && event.target.contains(list)) project();
    };
    const mutation = new MutationObserver(observe);
    mutation.observe(list, { childList: true, subtree: true });
    doc.addEventListener("scroll", scroll, { capture: true, passive: true });
    observe();
    return () => {
      doc.removeEventListener("scroll", scroll, true);
      mutation.disconnect();
      resize.disconnect();
      for (const items of list.querySelectorAll<HTMLElement>(".sidebar-activity-group__items")) {
        items.style.removeProperty("--sidebar-heading-occlusion");
      }
    };
  }, [listRef]);
}
