import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** A single React/DOM owner; dock and overlay provide slots, not duplicate views. */
function SidebarContentPortal({ target, children, name }: { target: HTMLElement | null; children: ReactNode; name: string }) {
  const [container] = useState(() => {
    const node = document.createElement("div");
    node.className = "sidecar-shared-content";
    node.dataset.sidebarContent = name;
    return node;
  });
  const scrollPositions = useRef(new Map<HTMLElement, { top: number; left: number }>());
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
    if (target) target.appendChild(container);
    else container.remove();
    for (const [node, { top, left }] of scrollPositions.current) {
      if (!container.contains(node)) scrollPositions.current.delete(node);
      else if (target) { node.scrollTop = top; node.scrollLeft = left; }
    }
    if (target && focused && !target.closest('[inert], [aria-hidden="true"]')) focused.focus({ preventScroll: true });
  }, [container, target]);
  useLayoutEffect(() => () => { container.remove(); }, [container]);
  return createPortal(children, container);
}

export function SharedSidebarContent({ primary, context, footer }: {
  primary: { target: HTMLElement | null; content: ReactNode };
  context: { target: HTMLElement | null; content: ReactNode };
  footer: { target: HTMLElement | null; content: ReactNode };
}) {
  return <>
    <SidebarContentPortal name="applications" target={primary.target}>{primary.content}</SidebarContentPortal>
    <SidebarContentPortal name="context" target={context.target}>{context.content}</SidebarContentPortal>
    <SidebarContentPortal name="footer" target={footer.target}>{footer.content}</SidebarContentPortal>
  </>;
}
