import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  canHoverRevealSidebar,
  resolveSidebarFloatingIntent,
  SIDEBAR_TRIGGER_PEEK_DELAY_MS,
} from "../sidebar-dock-model";

interface SidebarDockIntentOptions {
  readonly docked: boolean;
  readonly enabled: boolean;
  readonly getPanelWidth: () => number;
  readonly lockOpen: boolean;
}

interface SidebarDockIntent {
  readonly requested: boolean;
  dismiss(): void;
}

function isSidebarTrigger(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest("[data-app-shell-sidebar-trigger]") !== null;
}

/**
 * Pointer intent is an app-shell concern, not a Sidebar component concern.
 * The delegated listener also keeps the 4px edge target alive when no sidebar
 * DOM is mounted.
 */
export function useSidebarDockIntent({
  docked,
  enabled,
  getPanelWidth,
  lockOpen,
}: SidebarDockIntentOptions): SidebarDockIntent {
  const [requested, setRequested] = useState(false);
  const requestedRef = useRef(false);
  const dockedRef = useRef(docked);
  const enabledRef = useRef(enabled);
  const getPanelWidthRef = useRef(getPanelWidth);
  const lockOpenRef = useRef(lockOpen);
  const pointerXRef = useRef<number | null>(null);
  const pointerOverTriggerRef = useRef(false);
  const triggerPeekedRef = useRef(false);
  const triggerSuppressedRef = useRef(false);
  const peekTimerRef = useRef<number | null>(null);

  dockedRef.current = docked;
  enabledRef.current = enabled;
  getPanelWidthRef.current = getPanelWidth;
  lockOpenRef.current = lockOpen;

  const publish = (next: boolean) => {
    if (requestedRef.current === next) return;
    requestedRef.current = next;
    setRequested(next);
  };

  const clearPeekTimer = () => {
    if (peekTimerRef.current === null) return;
    window.clearTimeout(peekTimerRef.current);
    peekTimerRef.current = null;
  };

  const resolveFromPointer = () => {
    if (!enabledRef.current) {
      publish(false);
      return;
    }
    if (lockOpenRef.current && !dockedRef.current) {
      publish(true);
      return;
    }
    publish(resolveSidebarFloatingIntent({
      docked: dockedRef.current,
      currentlyRequested: requestedRef.current,
      pointerX: pointerXRef.current,
      panelWidth: getPanelWidthRef.current(),
      triggerPeeked: triggerPeekedRef.current,
      triggerSuppressed: triggerSuppressedRef.current,
    }));
  };

  useLayoutEffect(() => {
    if (docked) {
      clearPeekTimer();
      triggerPeekedRef.current = false;
      triggerSuppressedRef.current = false;
      publish(false);
      return;
    }

    // Clicking Hide while the pointer is still over the trigger must not
    // reopen the floating panel after the docked exit animation completes.
    if (pointerOverTriggerRef.current) {
      clearPeekTimer();
      triggerPeekedRef.current = false;
      triggerSuppressedRef.current = true;
      publish(false);
    }
  }, [docked]);

  useEffect(() => {
    const scheduleTriggerPeek = () => {
      if (
        peekTimerRef.current !== null
        || dockedRef.current
        || triggerSuppressedRef.current
        || !enabledRef.current
      ) return;
      peekTimerRef.current = window.setTimeout(() => {
        peekTimerRef.current = null;
        if (!pointerOverTriggerRef.current || dockedRef.current) return;
        triggerPeekedRef.current = true;
        resolveFromPointer();
      }, SIDEBAR_TRIGGER_PEEK_DELAY_MS);
    };

    const handlePointerMove = (event: PointerEvent) => {
      // Touch movement is a gesture, not hover intent. In particular, a drag
      // across the sidebar edge must not reopen a dismissed floating panel.
      if (!canHoverRevealSidebar(event.pointerType)) return;
      const overTrigger = isSidebarTrigger(event.target);
      const wasOverTrigger = pointerOverTriggerRef.current;
      pointerXRef.current = event.clientX;
      pointerOverTriggerRef.current = overTrigger;
      if (triggerSuppressedRef.current && !overTrigger && event.clientX > getPanelWidthRef.current()) {
        triggerSuppressedRef.current = false;
      }

      if (overTrigger && !wasOverTrigger) scheduleTriggerPeek();
      if (!overTrigger && wasOverTrigger) {
        clearPeekTimer();
        triggerPeekedRef.current = false;
        triggerSuppressedRef.current = false;
      }
      resolveFromPointer();
    };

    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget !== null) return;
      clearPeekTimer();
      pointerXRef.current = null;
      pointerOverTriggerRef.current = false;
      triggerPeekedRef.current = false;
      triggerSuppressedRef.current = false;
      if (!lockOpenRef.current) publish(false);
    };

    const handleWindowBlur = () => {
      clearPeekTimer();
      pointerXRef.current = null;
      pointerOverTriggerRef.current = false;
      triggerPeekedRef.current = false;
      triggerSuppressedRef.current = false;
      if (!lockOpenRef.current) publish(false);
    };

    window.addEventListener("pointermove", handlePointerMove, { capture: true, passive: true });
    window.addEventListener("pointerout", handlePointerOut, { capture: true, passive: true });
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      clearPeekTimer();
      window.removeEventListener("pointermove", handlePointerMove, { capture: true });
      window.removeEventListener("pointerout", handlePointerOut, { capture: true });
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  useEffect(() => {
    resolveFromPointer();
  }, [enabled, lockOpen]);

  const dismiss = useCallback(() => {
    if (peekTimerRef.current !== null) window.clearTimeout(peekTimerRef.current);
    peekTimerRef.current = null;
    triggerPeekedRef.current = false;
    triggerSuppressedRef.current = true;
    requestedRef.current = false;
    setRequested(false);
  }, []);
  return { requested, dismiss };
}
