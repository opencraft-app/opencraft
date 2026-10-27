import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { hasNativeHorizontalOverflow } from "./horizontal-scroll-policy";

export interface NativeChatHorizontalScrollOwner {
  readonly beginTouch: () => void;
  readonly endTouch: () => void;
}

const NativeChatHorizontalScrollContext = createContext<NativeChatHorizontalScrollOwner | null>(null);

/** Optional host seam: a containing drawer can yield to local code/table scrolling. */
export function NativeChatHorizontalScrollProvider({ children, owner }: {
  readonly children: ReactNode;
  readonly owner: NativeChatHorizontalScrollOwner;
}) {
  return <NativeChatHorizontalScrollContext.Provider value={owner}>{children}</NativeChatHorizontalScrollContext.Provider>;
}

export function useNativeChatHorizontalScrollOwner(): NativeChatHorizontalScrollOwner | null {
  return useContext(NativeChatHorizontalScrollContext);
}

/** Keep the drawer available on short content while wide content retains its own drag. */
export function useNativeHorizontalOverflowTouchOwner(contentKey: string) {
  const owner = useNativeChatHorizontalScrollOwner();
  const [overflow, setOverflow] = useState<{ key: string; enabled: boolean }>({ key: contentKey, enabled: true });
  const measured = useRef<{ key: string; viewport: number | null; content: number | null }>({
    key: contentKey, viewport: null, content: null,
  });
  const active = useRef(false);
  if (measured.current.key !== contentKey) {
    measured.current = { key: contentKey, viewport: measured.current.viewport, content: null };
  }
  const publishOverflow = useCallback(() => {
    const next = { key: measured.current.key, enabled: hasNativeHorizontalOverflow(measured.current.viewport, measured.current.content) };
    setOverflow(current => current.key === next.key && current.enabled === next.enabled ? current : next);
  }, []);
  const setViewportWidth = useCallback((width: number) => {
    measured.current.viewport = width;
    publishOverflow();
  }, [publishOverflow]);
  const setContentWidth = useCallback((width: number) => {
    measured.current.content = width;
    publishOverflow();
  }, [publishOverflow]);
  const beginTouch = useCallback(() => {
    if (active.current || !hasNativeHorizontalOverflow(measured.current.viewport, measured.current.content)) return;
    active.current = true;
    owner?.beginTouch();
  }, [owner]);
  const endTouch = useCallback(() => {
    if (!active.current) return;
    active.current = false;
    owner?.endTouch();
  }, [owner]);
  useEffect(() => endTouch, [contentKey, endTouch]);
  return { scrollEnabled: overflow.key === contentKey ? overflow.enabled : true, setViewportWidth, setContentWidth, beginTouch, endTouch };
}
