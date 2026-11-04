import type { AppServerThreadRuntimeLease, ConversationReturnProbe } from "@opencraft/workbench-runtime";

/** Browser hints request read-only history validation; Runtime owns the work. */
export function startConversationReturnRecovery(input: {
  probe: ConversationReturnProbe;
  ready(): boolean;
  lease(): Pick<AppServerThreadRuntimeLease, "retryRestore" | "setRecoveryVisibility"> | null;
  now?: () => number;
}): () => void {
  const now = input.now ?? Date.now;
  const visible = () => document.visibilityState !== "hidden";
  const eligible = () => visible() && input.ready() && input.lease() !== null;
  const revalidate = () => { const lease = input.lease(); if (lease) void lease.retryRestore().catch(() => undefined); };
  const visibility = () => {
    input.lease()?.setRecoveryVisibility(visible());
    if (!visible()) input.probe.background(now());
    else if (eligible() && input.probe.foreground(now())) revalidate();
  };
  const offline = () => input.probe.offline();
  // Hidden/unready hints must not consume the foreground validation cooldown.
  const online = () => { if (eligible() && input.probe.online(now())) revalidate(); };
  const pageshow = () => { if (eligible() && input.probe.pageshow(now())) revalidate(); };
  input.lease()?.setRecoveryVisibility(visible());
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("offline", offline);
  window.addEventListener("online", online);
  window.addEventListener("pageshow", pageshow);
  return () => {
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("offline", offline);
    window.removeEventListener("online", online);
    window.removeEventListener("pageshow", pageshow);
  };
}
