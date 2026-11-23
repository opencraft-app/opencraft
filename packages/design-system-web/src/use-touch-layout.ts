import { useSyncExternalStore } from "react";
import { isTouchPresentation, subscribeTouchPresentation } from "./input-presentation";

const subscribe = (onChange: () => void) => subscribeTouchPresentation(document, onChange);

/** Consume the installation preference, rather than guessing from viewport width. */
export function useTouchLayout(): boolean {
  return useSyncExternalStore(subscribe, () => isTouchPresentation(document), () => false);
}
