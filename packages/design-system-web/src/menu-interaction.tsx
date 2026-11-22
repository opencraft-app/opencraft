import { createContext, useEffectEvent, useLayoutEffect, useState } from "react";
import { useOverlayPresentationActive, useOverlayPresentationScope } from "./presentation-root";

/** Shared open state for native menu activation and its opening contact. */
export const MenuInteraction = createContext<{ active: boolean; open: boolean; change(open: boolean): void } | null>(null);

export function useScopedMenu(controlled: boolean | undefined, defaultOpen: boolean, onOpenChange: ((open: boolean) => void) | undefined) {
  const active = useOverlayPresentationActive();
  const [local, setLocal] = useState(defaultOpen);
  const [retired, setRetired] = useState(false);
  const requested = controlled ?? local;
  const update = (next: boolean) => {
    if (controlled === undefined) setLocal(next);
    onOpenChange?.(next);
  };
  const dismiss = useEffectEvent(() => update(false));
  useLayoutEffect(() => {
    if (!active && requested) {
      setRetired(true);
      dismiss();
    } else if (!requested) setRetired(false);
  }, [active, requested]);

  return {
    active,
    open: active && requested && !retired,
    change(next: boolean) {
      if (!active) return;
      if (next) setRetired(false);
      update(next);
    },
  };
}

export function useScopedMenuContent(onCloseAutoFocus: ((event: Event) => void) | undefined) {
  const scope = useOverlayPresentationScope();
  // Radix may deliver focus cleanup after a hidden scope has already returned.
  // The callback still belongs to the presentation that was removed.
  return { active: scope.active, onCloseAutoFocus(event: Event) {
    if (!scope.current) event.preventDefault();
    else onCloseAutoFocus?.(event);
  } };
}
