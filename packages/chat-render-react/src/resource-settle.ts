import { useEffect, useState } from "react";

/** Wait for a streaming external URL to stop changing before making it actionable. */
export const SAFE_URL_SETTLE_MS = 500;

export function useSettledResourceTarget(target: string | null, streaming: boolean): string | null {
  const [settled, setSettled] = useState<string | null>(() => streaming ? null : target);
  useEffect(() => {
    if (!streaming) {
      setSettled(target);
      return;
    }
    const timer = setTimeout(() => setSettled(target), SAFE_URL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [streaming, target]);
  return streaming ? settled === target ? target : null : target;
}
