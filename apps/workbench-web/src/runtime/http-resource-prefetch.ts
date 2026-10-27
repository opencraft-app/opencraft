/** One document owns a bounded transfer-only warmup. No module is evaluated. */
export function bindHttpResourcePrefetch(document: Document): () => void {
  const view = document.defaultView;
  const source = document.getElementById("opencraft-resource-hints")?.textContent;
  if (!view || !source) return () => {};
  let settings: string[];
  try {
    const data = JSON.parse(source);
    if (data.schemaVersion !== 1 || !Array.isArray(data.intents?.settings) || data.intents.settings.length > 12) return () => {};
    settings = data.intents.settings.map((file: unknown) => {
      if (typeof file !== "string") throw new Error("Invalid resource hint");
      const url = new URL(file, document.baseURI);
      if (url.origin !== view.location.origin || url.search || url.hash || url.username || url.password
        || !/\/assets\/[^/]+\.(?:js|css)$/.test(url.pathname)) throw new Error("Invalid resource URL");
      return url.href;
    });
  } catch { return () => {}; }
  const connection = (view.navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  const permitted = () => document.visibilityState !== "hidden" && !connection?.saveData && !/^(?:slow-2g|2g)$/.test(connection?.effectiveType ?? "");
  const completed = new Set<string>();
  const active = new Map<string, AbortController>();
  let disposed = false, requested = false, timer: number | undefined;
  const pump = () => {
    if (disposed || !requested || !permitted()) return;
    for (const url of settings) {
      if (active.size >= 2) break;
      if (completed.has(url) || active.has(url)) continue;
      const controller = new AbortController(); active.set(url, controller);
      // Failed/redirected warmup is best effort and never affects navigation.
      const timeout = view.setTimeout(() => controller.abort(), 8000);
      void view.fetch(url, { signal: controller.signal, credentials: "same-origin", redirect: "error", cache: "default", priority: "low" } as RequestInit)
        .then(async response => { if (response.ok) await response.arrayBuffer(); })
        .catch(() => {})
        .finally(() => { view.clearTimeout(timeout); active.delete(url); completed.add(url); pump(); });
    }
  };
  const intent = (event: Event) => {
    const target = event.target;
    if (!(target instanceof view.Element) || !target.closest('[data-resource-intent="settings"]') || disposed || !permitted()) return;
    if (timer !== undefined || requested) return;
    timer = view.setTimeout(() => { timer = undefined; requested = true; pump(); }, event.type === "pointerover" ? 100 : 0);
  };
  const visibility = () => {
    if (!permitted()) {
      if (timer !== undefined) { view.clearTimeout(timer); timer = undefined; }
      for (const controller of active.values()) controller.abort();
    } else pump();
  };
  for (const type of ["pointerover", "pointerdown", "focusin"]) document.addEventListener(type, intent, { passive: true });
  document.addEventListener("visibilitychange", visibility);
  return () => {
    disposed = true;
    if (timer !== undefined) view.clearTimeout(timer);
    for (const controller of active.values()) controller.abort();
    for (const type of ["pointerover", "pointerdown", "focusin"]) document.removeEventListener(type, intent);
    document.removeEventListener("visibilitychange", visibility);
  };
}
