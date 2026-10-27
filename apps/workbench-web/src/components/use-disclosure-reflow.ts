import { createContext, useCallback, useContext, useLayoutEffect, useRef } from "react";
import type { TimelineReflowLease } from "@opencraft/timeline-host-web";

/** The View reports interaction lifetime; only the viewport owns DOM scroll writes. */
export const DisclosureReflowContext = createContext<
  (anchor: HTMLElement) => TimelineReflowLease | null
>(() => null);

export function useDisclosureReflow() {
  const acquire = useContext(DisclosureReflowContext);
  const pending = useRef<TimelineReflowLease | null>(null);
  const cancel = useCallback(() => {
    pending.current?.cancel();
    pending.current = null;
  }, []);
  useLayoutEffect(() => cancel, [acquire, cancel]);
  const begin = useCallback((anchor: HTMLButtonElement) => {
    cancel();
    pending.current = acquire(anchor);
  }, [acquire, cancel]);
  // Capture this render's lease: a superseded animation callback cannot finish
  // the next interaction, even when the same heading remains mounted.
  const lease = pending.current;
  const complete = useCallback(() => {
    if (pending.current !== lease) return;
    lease?.complete();
  }, [lease]);
  return { begin, complete, cancel };
}
