import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Focus modality and outside-contact isolation are independent menu policies. */
export const MenuInteraction = createContext<{ open: boolean; change(open: boolean): void } | null>(null);

/** A dismiss surface belongs to the existing menu portal, not another Dialog or
 * DismissableLayer. Keep it mounted through the native click so the whole contact
 * targets this surface, including a hold over an editor's voice-input region. */
export function MenuDismissSurface({ content }: { content: HTMLElement | null }) {
  const menu = useContext(MenuInteraction);
  const surface = useRef<HTMLDivElement>(null);
  const contact = useRef<number | null>(null);
  const [zIndex, setZIndex] = useState<string>();
  useLayoutEffect(() => {
    if (content) setZIndex(content.ownerDocument.defaultView?.getComputedStyle(content).zIndex);
  }, [content]);
  useEffect(() => {
    const node = surface.current;
    if (!node) return;
    // React's delegated wheel listener is passive. The outside surface owns the
    // wheel too; scrolling inside menu content remains entirely Radix/native.
    const preventScroll = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); };
    node.addEventListener("wheel", preventScroll, { passive: false });
    return () => node.removeEventListener("wheel", preventScroll);
  }, [menu?.open]);
  if (!menu) throw new Error("Menu content requires its shared dropdown/context-menu Root");
  if (!menu.open) return null;
  return <div ref={surface} data-menu-dismiss-surface="" aria-hidden="true"
    style={{ position: "fixed", inset: 0, zIndex, pointerEvents: "auto", touchAction: "none" }}
    onPointerDown={event => {
      contact.current = event.isPrimary && event.button === 0 ? event.pointerId : null;
      event.stopPropagation();
    }}
    onPointerCancel={event => { contact.current = null; event.stopPropagation(); }}
    onTouchCancel={event => { contact.current = null; event.stopPropagation(); }}
    onPointerUp={event => event.stopPropagation()}
    onTouchStart={event => event.stopPropagation()}
    onTouchEnd={event => event.stopPropagation()}
    onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}
    onMouseUp={event => event.stopPropagation()}
    onContextMenu={event => { contact.current = null; event.preventDefault(); event.stopPropagation(); }}
    onClick={event => {
      event.preventDefault();
      event.stopPropagation();
      // A context menu can appear while the original finger is still down.
      // Its release may target this new surface, but is not an outside gesture.
      const startedHere = contact.current !== null;
      contact.current = null;
      if (startedHere && event.button === 0) menu.change(false);
    }}
  />;
}
