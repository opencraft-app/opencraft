import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

/** A presentation owner can park its UI without disposing execution or drafts. */
export class PresentationActivity {
  private active: boolean;
  private readonly listeners = new Set<() => void>();
  constructor(active = true) { this.active = active; }
  getSnapshot = () => this.active;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    for (const listener of this.listeners) listener();
  }
}
const ActivityContext = createContext(true);
const alwaysActive = () => true;
const subscribeNothing = (_listener: () => void) => () => {};
export function PresentationActivityProvider({ active = true, source, children }: {
  readonly active?: boolean;
  readonly source?: PresentationActivity;
  readonly children: ReactNode;
}) {
  const parent = useContext(ActivityContext);
  const owned = useSyncExternalStore(source?.subscribe ?? subscribeNothing, source?.getSnapshot ?? alwaysActive, alwaysActive);
  return <ActivityContext.Provider value={parent && active && owned}>{children}</ActivityContext.Provider>;
}


export function usePresentationActive(): boolean { return useContext(ActivityContext); }
