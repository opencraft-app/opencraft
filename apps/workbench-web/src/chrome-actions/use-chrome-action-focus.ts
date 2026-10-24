import { useCallback, useRef, type RefCallback } from "react";

import {
  ChromeActionFocusRegistry,
  type ChromeActionHostRole,
} from "./focus-registry";

const chromeActionFocusRegistry = new ChromeActionFocusRegistry();

export function useChromeActionFocusRef(
  actionId: string,
  role: ChromeActionHostRole,
): RefCallback<HTMLButtonElement> {
  const unregisterRef = useRef<(() => void) | null>(null);

  return useCallback((element) => {
    unregisterRef.current?.();
    unregisterRef.current = null;
    if (element === null) return;

    unregisterRef.current = chromeActionFocusRegistry.register(actionId, {
      role,
      get connected() {
        return element.isConnected;
      },
      ownsFocus: () => {
        const activeElement = element.ownerDocument.activeElement;
        return activeElement === element || element.contains(activeElement);
      },
      focus: (options) => element.focus(options),
    });
  }, [actionId, role]);
}

export function transferChromeActionFocus(
  actionId: string,
  fromRole: ChromeActionHostRole,
  toRole: ChromeActionHostRole,
): boolean {
  return chromeActionFocusRegistry.transferFocus(actionId, fromRole, toRole);
}

/** Resolve logical chrome focus even when its physical button is portalled. */
export function focusChromeAction(actionId: string, role: ChromeActionHostRole): boolean {
  return chromeActionFocusRegistry.focus(actionId, role);
}
