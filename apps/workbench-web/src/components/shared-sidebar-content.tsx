import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Shell may own the physical viewport outside the shared content (mobile drawer).
 * Its receipt belongs to this logical content, not to an ephemeral DOM node.
 * Different layouts use different keys because their scroll coordinates differ. */
export interface SidebarScrollViewport {
  key: string;
  element: HTMLElement | null;
}

/** A single React/DOM owner; dock and overlay provide slots, not duplicate views. */
function SidebarContentPortal({ target, children, name, scrollViewport }: {
  target: HTMLElement | null; children: ReactNode; name: string; scrollViewport?: SidebarScrollViewport;
}) {
  const [container] = useState(() => {
    const node = document.createElement("div");
    node.className = "sidecar-shared-content";
    node.dataset.sidebarContent = name;
    return node;
  });
  const scrollPositions = useRef(new Map<HTMLElement, { top: number; left: number }>());
  const viewportPositions = useRef(new Map<string, { top: number; left: number }>());
  const previousViewport = useRef<SidebarScrollViewport | undefined>(undefined);
  const viewportElement = scrollViewport?.element;
  const viewportKey = scrollViewport?.key;
  const lastFocused = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const rememberScroll = (event: Event) => {
      const node = event.target;
      if (node instanceof HTMLElement && container.isConnected && node.getClientRects().length) {
        scrollPositions.current.set(node, { top: node.scrollTop, left: node.scrollLeft });
      }
    };
    const rememberFocus = (event: FocusEvent) => {
      lastFocused.current = event.target instanceof HTMLElement && container.contains(event.target) ? event.target : null;
    };
    container.addEventListener("scroll", rememberScroll, true);
    document.addEventListener("focusin", rememberFocus);
    return () => { container.removeEventListener("scroll", rememberScroll, true); document.removeEventListener("focusin", rememberFocus); };
  }, [container]);
  useLayoutEffect(() => {
    const focused = document.activeElement instanceof HTMLElement && container.contains(document.activeElement) ? document.activeElement
      : document.activeElement === document.body ? lastFocused.current : null;
    // The old slot may already have unmounted in React's mutation phase. Keep
    // scroll receipts from the connected tree instead of reading detached zeros.
    if (container.isConnected) for (const node of [container, ...container.querySelectorAll<HTMLElement>("*")]) {
      if (node.scrollTop || node.scrollLeft) scrollPositions.current.set(node, { top: node.scrollTop, left: node.scrollLeft });
    }
    const rememberViewport = ({ key, element }: SidebarScrollViewport) => {
      // Removal, emptying the old slot, and hidden layouts can clamp scrollTop
      // to zero. Only the live viewport containing our content may write a receipt.
      if (element?.isConnected && element.contains(container) && element.clientHeight > 0
        && element.clientWidth > 0 && !element.closest('[inert], [aria-hidden="true"]')) {
        viewportPositions.current.set(key, { top: element.scrollTop, left: element.scrollLeft });
      }
    };
    if (previousViewport.current) rememberViewport(previousViewport.current);
    if (target) target.appendChild(container);
    else container.remove();
    for (const [node, { top, left }] of scrollPositions.current) {
      if (!container.contains(node)) scrollPositions.current.delete(node);
      else if (target) { node.scrollTop = top; node.scrollLeft = left; }
    }
    const viewport = viewportKey !== undefined ? { key: viewportKey, element: viewportElement ?? null } : undefined;
    previousViewport.current = viewport;
    if (target && viewportElement?.contains(container) && viewportKey !== undefined) {
      const receipt = viewportPositions.current.get(viewportKey);
      if (receipt) { viewportElement.scrollTop = receipt.top; viewportElement.scrollLeft = receipt.left; }
    }
    if (target && focused && !target.closest('[inert], [aria-hidden="true"]')) focused.focus({ preventScroll: true });
    const onScroll = () => { if (viewport) rememberViewport(viewport); };
    viewportElement?.addEventListener("scroll", onScroll, { passive: true });
    // Do not read during cleanup: React may already have detached the old slot.
    return () => { viewportElement?.removeEventListener("scroll", onScroll); };
  }, [container, target, viewportElement, viewportKey]);
  useLayoutEffect(() => () => { container.remove(); }, [container]);
  return createPortal(children, container);
}

export function SharedSidebarContent({ primary, context, footer }: {
  primary: { target: HTMLElement | null; content: ReactNode };
  context: { target: HTMLElement | null; content: ReactNode; scrollViewport?: SidebarScrollViewport };
  footer: { target: HTMLElement | null; content: ReactNode };
}) {
  return <>
    <SidebarContentPortal name="applications" target={primary.target}>{primary.content}</SidebarContentPortal>
    <SidebarContentPortal name="context" target={context.target} scrollViewport={context.scrollViewport}>{context.content}</SidebarContentPortal>
    <SidebarContentPortal name="footer" target={footer.target}>{footer.content}</SidebarContentPortal>
  </>;
}
