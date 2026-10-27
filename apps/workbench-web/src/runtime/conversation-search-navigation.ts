import type { ConversationNavigationAnchor, ConversationNavigationSource } from "@opencraft/chat-navigation";

/** Activation can finish before resume; navigation owns history readiness. */
export async function waitForSearchNavigationAnchor(
  source: ConversationNavigationSource,
  target: { readonly turnId: string; readonly itemId: string },
  signal: AbortSignal,
): Promise<ConversationNavigationAnchor> {
  signal.throwIfAborted();
  await source.prepare();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let release = () => {};
    let settled = false;
    const finish = (anchor?: ConversationNavigationAnchor, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      release();
      signal.removeEventListener("abort", aborted);
      if (anchor) resolve(anchor);
      else reject(error);
    };
    const aborted = () => finish(undefined, signal.reason);
    const timer = setTimeout(() => finish(undefined, new Error("Navigation did not become ready")), 30_000);
    const check = () => {
      if (signal.aborted) { aborted(); return; }
      const snapshot = source.getSnapshot();
      if (snapshot.phase === "empty" || snapshot.phase === "loading") return;
      const anchors = snapshot.anchors.filter(anchor => anchor.turnKey === target.turnId);
      const anchor = anchors.find(anchor => anchor.itemId === target.itemId) ?? anchors[0];
      if (anchor && (snapshot.phase === "ready" || snapshot.phase === "degraded")) finish(anchor);
      else finish(undefined, new Error("Matching turn unavailable"));
    };
    release = source.subscribe(check);
    if (settled) { release(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    check();
  });
}
