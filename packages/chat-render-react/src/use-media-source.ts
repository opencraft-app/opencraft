import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ChatMediaSourceLoader, ChatMediaSourceRequest, ChatMediaSourceSnapshot } from "./contracts";

const loading: ChatMediaSourceSnapshot = Object.freeze({ status: "loading", value: null });
const unavailable: ChatMediaSourceSnapshot = Object.freeze({ status: "unavailable", value: null });
const readLoading = () => loading;

/** Shared snapshots are read during render; legacy async providers retain consumer leases. */
export function useChatMediaSource(loader: ChatMediaSourceLoader | undefined, request: ChatMediaSourceRequest | null): ChatMediaSourceSnapshot {
  const shared = loader?.getSnapshot !== undefined && loader.subscribe !== undefined;
  const subscribe = useCallback((notify: () => void) => shared && request
    ? loader!.subscribe!(request, notify) : () => {}, [loader, request, shared]);
  const read = useCallback(() => shared && request ? loader!.getSnapshot!(request) : loading, [loader, request, shared]);
  const snapshot = useSyncExternalStore(subscribe, read, readLoading);
  const [local, setLocal] = useState<{ request: ChatMediaSourceRequest; loader: ChatMediaSourceLoader; snapshot: ChatMediaSourceSnapshot } | null>(null);
  useEffect(() => {
    if (shared || !loader || !request) return;
    let active = true;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void loader({ ...request, signal: controller.signal }).then(result => {
      if (!active) { result?.release?.(); return; }
      release = result?.release;
      setLocal({ request, loader, snapshot: result ? { status: "ready", value: result } : unavailable });
    }, error => { if (active) setLocal({ request, loader, snapshot: { ...unavailable, error } }); });
    return () => { active = false; controller.abort(); release?.(); };
  }, [loader, request, shared]);
  if (!request || !loader) return unavailable;
  if (shared) return snapshot;
  return local?.request === request && local.loader === loader ? local.snapshot : loading;
}
