import { useSyncExternalStore, type ComponentProps } from "react";
import { PresentationActivityProvider, usePresentationActive } from "@opencraft/react-runtime";
import { OverlayPresentationScope } from "@opencraft/design-system-web/presentation-root";
export { PresentationActivity as WorkbenchPresentationActivity } from "@opencraft/react-runtime";

function WorkbenchOverlayScope({ children }: Pick<ComponentProps<typeof PresentationActivityProvider>, "children">) {
  const active = usePresentationActive();
  return <OverlayPresentationScope active={active}>{children}</OverlayPresentationScope>;
}

export function WorkbenchPresentationActivityProvider({ children, ...props }: ComponentProps<typeof PresentationActivityProvider>) {
  return <PresentationActivityProvider {...props}><WorkbenchOverlayScope>{children}</WorkbenchOverlayScope></PresentationActivityProvider>;
}

const alwaysActive = () => true;
const visibilityListeners = new Set<() => void>();
const readVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
const notifyVisibility = () => { for (const listener of visibilityListeners) listener(); };
function subscribeVisibility(listener: () => void) {
  if (visibilityListeners.size === 0) document.addEventListener("visibilitychange", notifyVisibility);
  visibilityListeners.add(listener);
  return () => {
    visibilityListeners.delete(listener);
    if (visibilityListeners.size === 0) document.removeEventListener("visibilitychange", notifyVisibility);
  };
}

export function useWorkbenchPresentationActive(): boolean {
  const active = usePresentationActive();
  const visible = useSyncExternalStore(subscribeVisibility, readVisible, alwaysActive);
  return active && visible;
}
