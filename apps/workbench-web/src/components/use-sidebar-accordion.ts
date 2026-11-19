import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** The existing scroll owner, not a second scrollport inside an expanded group. */
export function sidebarScrollViewport(content: HTMLElement | null, list: HTMLElement | null): HTMLElement | null {
  const column = content?.closest(".shell-sidebar__column");
  return (
    (column?.getAttribute("data-navigation-layout") === "mobile"
      ? column.querySelector<HTMLElement>(".shell-sidebar__scroll")
      : list) ?? content
  );
}

export function sidebarAnchoredScrollTop(input: {
  scrollTop: number;
  maxScrollTop: number;
  headingTop: number;
  headingHeight: number;
  anchorTop: number;
  viewportTop: number;
  viewportBottom: number;
  readingRoom: number;
}): number {
  const latestTop = Math.max(input.viewportTop, input.viewportBottom - input.headingHeight - input.readingRoom);
  const preferredTop = Math.max(input.viewportTop, Math.min(input.anchorTop, latestTop));
  return Math.max(0, Math.min(input.maxScrollTop, input.scrollTop + input.headingTop - preferredTop));
}

/** One Shell-local disclosure intent across fixed and contributed groups. */
export function useSidebarAccordion(
  scope: string,
  initialKey: string | null,
  content: RefObject<HTMLDivElement | null>,
  list: RefObject<HTMLDivElement | null>,
) {
  const [intent, setIntent] = useState<{ scope: string; key: string | null } | null>(null);
  const openKey = intent?.scope === scope ? intent.key : initialKey;
  const live = useRef({ scope, key: openKey });
  live.current = { scope, key: openKey };
  const pending = useRef<{
    scope: string;
    key: string | null;
    heading: HTMLElement;
    viewport: HTMLElement;
    top: number;
  } | null>(null);
  const animation = useRef<Animation | null>(null);
  const disclosureChanged = pending.current?.scope === scope && pending.current?.key === openKey;
  const toggle = (key: string, button: HTMLElement): string | null => {
    const heading = button.closest<HTMLElement>(".sidebar-thread-group-heading") ?? button;
    const top = heading.getBoundingClientRect().top;
    animation.current?.cancel();
    animation.current = null;
    const next = live.current.scope === scope && live.current.key === key ? null : key;
    const viewport = sidebarScrollViewport(content.current, list.current);
    pending.current = viewport ? { scope, key: next, heading, viewport, top } : null;
    // Consecutive native activations before React commits still toggle the same owner.
    live.current = { scope, key: next };
    setIntent(live.current);
    return next;
  };
  useLayoutEffect(() => {
    const receipt = pending.current;
    if (!receipt) return;
    pending.current = null;
    if (receipt.scope !== scope || receipt.key !== openKey) return;
    const { heading, viewport } = receipt;
    if (
      !heading.isConnected ||
      !viewport.contains(heading) ||
      !viewport.clientHeight ||
      viewport.closest('[inert], [aria-hidden="true"]')
    )
      return;
    const bounds = viewport.getBoundingClientRect();
    const padding = heading.ownerDocument.defaultView?.getComputedStyle(viewport);
    const viewportTop = bounds.top + (Number.parseFloat(padding?.scrollPaddingTop ?? "") || 0);
    const viewportBottom = bounds.bottom - (Number.parseFloat(padding?.scrollPaddingBottom ?? "") || 0);
    const rect = heading.getBoundingClientRect();
    // A newly opened heading may already be sticky at the old scroll offset.
    // Anchor its normal-flow section origin, not the sticky visual projection.
    const naturalTop = heading.closest<HTMLElement>(".sidebar-activity-group")?.getBoundingClientRect().top ?? rect.top;
    const expanded = heading.querySelector('[aria-expanded="true"]') !== null;
    const firstRow = expanded ? heading.nextElementSibling?.querySelector<HTMLElement>(".sidebar-activity-item") : null;
    viewport.scrollTop = sidebarAnchoredScrollTop({
      scrollTop: viewport.scrollTop,
      maxScrollTop: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
      headingTop: naturalTop,
      headingHeight: rect.height,
      anchorTop: receipt.top,
      viewportTop,
      viewportBottom,
      readingRoom: expanded ? Math.min(firstRow?.offsetHeight ?? rect.height, viewport.clientHeight / 2) : 0,
    });
    // At a scroll boundary exact anchoring can be impossible. A closing label
    // moves to its real position; never create whitespace or animate row content.
    const moved = receipt.top - heading.getBoundingClientRect().top;
    const win = heading.ownerDocument.defaultView;
    if (
      !expanded &&
      Math.abs(moved) > 1 &&
      Math.abs(moved) < viewport.clientHeight &&
      win &&
      !win.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      const styles = win.getComputedStyle(heading);
      const token = styles.getPropertyValue("--transition-duration-basic").trim();
      const duration = Number.parseFloat(token) * (token.endsWith("ms") ? 1 : 1000);
      if (Number.isFinite(duration) && duration > 0)
        animation.current = heading.animate([{ transform: `translateY(${moved}px)` }, { transform: "translateY(0)" }], {
          duration,
          easing: styles.getPropertyValue("--ease-standard").trim() || "ease-out",
        });
    }
  });
  useLayoutEffect(
    () => () => {
      pending.current = null;
      animation.current?.cancel();
    },
    [],
  );
  return { openKey, disclosureChanged, collapsed: (key: string) => key !== openKey, toggle };
}
