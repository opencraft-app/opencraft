interface ConfirmationPlane {
  scrim: HTMLElement;
  content: HTMLElement;
  order: number;
}

const planes = new WeakMap<Node, Set<ConfirmationPlane>>();

/** Paint above native retained-view popovers without taking modality from Radix.
 * A later thumbnail/flight may re-enter the browser top layer, so confirmations
 * must reclaim their paint order before that frame is presented. */
export function leaseConfirmationTopLayer(
  scrim: HTMLElement,
  content: HTMLElement,
  order: number,
): (() => void) | undefined {
  if (typeof content.showPopover !== "function" || typeof scrim.showPopover !== "function") return undefined;
  const root = content.getRootNode();
  const active = planes.get(root) ?? new Set<ConfirmationPlane>();
  planes.set(root, active);
  const plane = { scrim, content, order };
  const raise = () => {
    const focused = root instanceof ShadowRoot ? root.activeElement : content.ownerDocument.activeElement;
    for (const entry of [...active].sort((a, b) => a.order - b.order)) {
      for (const node of [entry.scrim, entry.content]) {
        if (!node.isConnected) continue;
        if (node.matches(":popover-open")) node.hidePopover();
        node.showPopover();
      }
    }
    if (focused instanceof HTMLElement && focused.isConnected && !focused.closest("[inert]"))
      focused.focus({ preventScroll: true });
  };
  scrim.setAttribute("popover", "manual");
  content.setAttribute("popover", "manual");
  active.add(plane);
  try {
    raise();
  } catch {
    active.delete(plane);
    for (const node of [scrim, content]) {
      try {
        node.hidePopover();
      } catch {
        /* unsupported placement */
      }
      node.removeAttribute("popover");
    }
    return undefined;
  }
  let live = true,
    queued = false;
  const beforeToggle = (event: Event) => {
    if ((event as ToggleEvent).newState !== "open") return;
    if (!(event.target instanceof HTMLElement) || !event.target.hasAttribute("popover")) return;
    for (const entry of active) if (event.target === entry.scrim || event.target === entry.content) return;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (live) raise();
    });
  };
  root.addEventListener("beforetoggle", beforeToggle, true);
  return () => {
    live = false;
    root.removeEventListener("beforetoggle", beforeToggle, true);
    active.delete(plane);
    for (const node of [scrim, content]) {
      try {
        node.hidePopover();
      } catch {
        /* detached portal */
      }
      node.removeAttribute("popover");
    }
  };
}
