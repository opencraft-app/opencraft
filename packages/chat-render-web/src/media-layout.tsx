import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";

export interface ChatMediaLayout {
  readonly width: number;
  readonly height: number;
}

/** Presentation metadata belongs to the retained View, never to the file authority. */
export const ChatMediaLayoutContext = createContext<Map<string, ChatMediaLayout> | null>(null);

/** Keep a previously measured resource's space while its new consumer lease resolves. */
export function ChatMediaLayoutBoundary({ resourceKey, settled, children }: {
  readonly resourceKey: string;
  readonly settled: boolean;
  readonly children: ReactNode;
}) {
  const layouts = useContext(ChatMediaLayoutContext);
  const root = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (element === null || layouts === null) return;
    const update = () => {
      const width = element.offsetWidth;
      if (width <= 0) return;
      const saved = layouts.get(resourceKey);
      // Width is layout width, unaffected by overview transforms. A breakpoint
      // change invalidates the old geometry rather than freezing the new layout.
      const reserve = !settled && saved !== undefined && Math.abs(saved.width - width) <= 1;
      element.style.height = reserve ? `${saved.height}px` : "";
      element.style.overflow = reserve ? "hidden" : "";
      if (settled && element.offsetHeight > 0) {
        layouts.delete(resourceKey);
        layouts.set(resourceKey, { width, height: element.offsetHeight });
        while (layouts.size > 256) layouts.delete(layouts.keys().next().value!);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [layouts, resourceKey, settled]);
  return <span ref={root} style={{ display: "flow-root" }}>{children}</span>;
}
