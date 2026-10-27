import { useEffect } from "react";
import { usePresentationActive } from "@opencraft/react-runtime";
import type { AppServerThreadRuntimeLease } from "@opencraft/workbench-runtime";

const REFRESH_MS = 5_000;

/** One visible conversation, one request at a time; never reload the page. */
export function startConversationHistoryRefresh(
  refresh: (signal: AbortSignal) => Promise<boolean>,
  onChanged: () => Promise<unknown>,
): () => void {
  const controller = new AbortController();
  let timer: number | undefined;
  let running = false;
  let delay = REFRESH_MS;
  const schedule = () => {
    if (!controller.signal.aborted && document.visibilityState === "visible") {
      timer = window.setTimeout(() => { void poll(); }, delay);
    }
  };
  async function poll() {
    if (running || controller.signal.aborted || document.visibilityState !== "visible") return;
    window.clearTimeout(timer);
    running = true;
    try {
      const changed = await refresh(controller.signal);
      if (!controller.signal.aborted && changed) await onChanged();
      delay = REFRESH_MS;
    } catch {
      // A transient failure retains the visible transcript and backs off.
      delay = Math.min(delay * 2, 60_000);
    } finally {
      running = false;
      schedule();
    }
  }
  const visibility = () => {
    window.clearTimeout(timer);
    if (document.visibilityState === "visible") void poll();
  };
  document.addEventListener("visibilitychange", visibility);
  schedule();
  return () => {
    controller.abort();
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", visibility);
  };
}

export function useConversationHistoryRefresh(
  lease: AppServerThreadRuntimeLease | null,
  enabled: boolean,
  onChanged: () => Promise<unknown>,
): void {
  const active = usePresentationActive();
  useEffect(() => {
    if (!enabled || !active || lease === null) return;
    return startConversationHistoryRefresh(signal => lease.refreshHistory(signal), onChanged);
  }, [lease, enabled, active, onChanged]);
}
