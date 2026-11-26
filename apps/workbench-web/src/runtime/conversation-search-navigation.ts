import type { ConversationNavigationAnchor, ConversationNavigationSource } from "@opencraft/chat-navigation";

/** Wait for history preparation and marker publication under one cancellation deadline. */
export async function waitForSearchNavigationAnchor(
  source: ConversationNavigationSource,
  target: { readonly turnId: string; readonly itemId: string },
  signal: AbortSignal,
): Promise<ConversationNavigationAnchor> {
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
    signal.addEventListener("abort", aborted, { once: true });
    void Promise.resolve().then(() => {
      if (!settled) return source.prepare();
    }).then(() => {
      if (settled) return;
      release = source.subscribe(check);
      if (settled) release();
      else check();
    }).catch(error => finish(undefined, error));
  });
}

async function waitForReadableView(source: ConversationNavigationSource, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (source.getSnapshot().generation !== null) return;
  await new Promise<void>((resolve, reject) => {
    let release = () => {};
    const finish = () => {
      release();
      signal.removeEventListener("abort", finish);
      if (signal.aborted) reject(signal.reason);
      else resolve();
    };
    const check = () => {
      if (source.getSnapshot().generation !== null) finish();
    };
    signal.addEventListener("abort", finish, { once: true });
    release = source.subscribe(check);
    check();
  });
}

export async function prepareSearchNavigationTarget(
  source: ConversationNavigationSource,
  target: { readonly turnId: string; readonly itemId: string; readonly turnCursor?: string },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => lifetime.abort(new Error("Navigation did not become ready")), 30_000);
  const options = { signal: lifetime.signal, itemId: target.itemId };
  try {
    const cursor = target.turnCursor;
    if (source.prepareLocatedTarget && typeof cursor === "string" && cursor.length > 0) {
      await waitForReadableView(source, options.signal);
      const generation = source.getSnapshot().generation;
      const prepared = await source.prepareLocatedTarget({ ...target, turnCursor: cursor }, options.signal);
      options.signal.throwIfAborted();
      if (source.getSnapshot().generation !== generation) throw new Error("Matching turn changed");
      if (prepared) return prepared;
    }
    const anchor = await waitForSearchNavigationAnchor(source, target, options.signal);
    options.signal.throwIfAborted();
    return await source.prepareTarget(anchor.id, options);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
