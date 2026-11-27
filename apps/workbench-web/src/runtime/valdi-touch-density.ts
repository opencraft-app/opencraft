import { useCallback, useSyncExternalStore } from "react";
import { isTouchPresentation, subscribeTouchPresentation } from "@opencraft/design-system-web/input-presentation";

const EMPTY_TOUCH_SUBSCRIBE = () => () => {};
const FALSE_SNAPSHOT = () => false;

/** Subscribes to the shared touch-presentation state for Valdi surfaces. */
export function useValdiTouchDensity(): boolean {
  const subscribe = useCallback(
    (onChange: () => void) =>
      typeof document === "undefined" ? EMPTY_TOUCH_SUBSCRIBE() : subscribeTouchPresentation(document, onChange),
    [],
  );
  const getSnapshot = useCallback(() => (typeof document === "undefined" ? false : isTouchPresentation(document)), []);
  return useSyncExternalStore(subscribe, getSnapshot, FALSE_SNAPSHOT);
}
