import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export function useSidebarEndPull(
  footerRef: RefObject<HTMLDivElement | null>, enabled: boolean, reveal: () => void,
  fill?: (additional: number) => void,
) {
  const action = useRef({ enabled, reveal, fill });
  useLayoutEffect(() => { action.current = { enabled, reveal, fill }; });
  useEffect(() => {
    const footer = footerRef.current;
    if (!footer) return;
    let disposed = false;
    let detach: (() => void) | undefined;
    // The button can render immediately; scroll gestures and layout observation
    // are only needed for Recent after its footer mounts.
    void import("./sidebar-page-reveal").then(({ attachSidebarPageReveal }) => {
      if (!disposed) detach = attachSidebarPageReveal(footer, () => action.current);
    }).catch(error => {
      if (!disposed) console.error("Failed to initialize sidebar page reveal", error);
    });
    return () => {
      disposed = true;
      detach?.();
    };
  }, [footerRef]);
}
